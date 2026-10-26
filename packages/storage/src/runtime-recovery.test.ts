import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeTurnRecovery } from '@contracts';
import { WorkspaceStore } from './index.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root,{ recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(),'runtime-recovery-ledger-')); roots.push(root);
  let store = new WorkspaceStore({ rootDirectory: root });
  const person = store.createPerson({ displayName: '合成恢复成员', relation: '本人' });
  const source = store.putSourceObject({ bytes: Buffer.from('合成原件'), mediaType: 'text/plain', displayName: 'synthetic.txt' });
  const documentId = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id }).documentId;
  const consentId = store.createManualProcessingConsent({ documentIds: [documentId], personIds: [person.id],
    accountFingerprint: 'synthetic-account', version: 1 });
  const jobId = store.createWaitingAuthBatch({ cutoff: new Date().toISOString(), initialStatus: 'queued', consentId,
    groups: [{ personId: person.id, documentIds: [documentId], inputSignature: 'synthetic-input' }] }).jobIds[0]!;
  const claim = () => {
    store.claimNextQueuedJob('synthetic-runner','synthetic-account');
    const attemptId = store.startJobAttempt(jobId,'synthetic-runtime','gpt-6.1-sol','medium');
    return { jobId, attemptId, consentId, accountFingerprint: 'synthetic-account' };
  };
  const guard = claim(); const signature = 'c'.repeat(64);
  const initial: RuntimeTurnRecovery = { version: 1, phase: 'thread_starting', threadStarts: 1, turnStarts: 0,
    threadId: null, turnId: null, turnStartedAt: null, terminalStatus: null,
    connectionErrorCount: 0, connectionRecoveryStartedAt: null };
  return { get store() { return store; }, guard, signature, initial, jobId,
    resume() {
      store.finishJob(jobId,'failed'); store.finishJobAttempt({ attemptId: guard.attemptId, status: 'failed', errorCode: 'CODEX_RPC_TIMEOUT:turn/start' });
      store.close(); store = new WorkspaceStore({ rootDirectory: root });
      store.retryFailedJob(jobId); return claim();
    } };
}
describe('启动恢复的持久范围与预算', () => {
  it('失败重开保留请求状态和次数，不能把未知已发送变成新请求', () => {
    const f = setup();
    try {
      f.store.saveRuntimeTurnRecovery(f.guard,f.signature,f.initial);
      const ready = { ...f.initial, phase: 'thread_ready' as const, threadId: 'owned-thread' };
      f.store.saveRuntimeTurnRecovery(f.guard,f.signature,ready);
      const sent = { ...ready, phase: 'turn_starting' as const, turnStarts: 1, turnStartedAt: new Date().toISOString() };
      f.store.saveRuntimeTurnRecovery(f.guard,f.signature,sent);
      const resumed = f.resume();
      expect(f.store.getRuntimeTurnRecovery(resumed,f.signature)).toEqual(sent);
      expect(() => f.store.saveRuntimeTurnRecovery(resumed,f.signature,{ ...f.initial, threadStarts: 2 }))
        .toThrow('RUNTIME_RECOVERY_UNSAFE_RESEND');
      expect(() => f.store.saveRuntimeTurnRecovery(resumed,f.signature,f.initial)).toThrow('RUNTIME_RECOVERY_BUDGET_RESET');
      expect(f.store.getRuntimeTurnRecovery(resumed,'d'.repeat(64))).toBeNull();
    } finally { f.store.close(); }
  });
  it('旧attempt或错误账户不能取回或改写状态，连接次数不会因内容恢复而归零', () => {
    const f = setup();
    try {
      f.store.saveRuntimeTurnRecovery(f.guard,f.signature,f.initial);
      const ready = { ...f.initial, phase: 'thread_ready' as const, threadId: 'owned-thread' };
      f.store.saveRuntimeTurnRecovery(f.guard,f.signature,ready);
      const sent = { ...ready, phase: 'turn_starting' as const, turnStarts: 1, turnStartedAt: new Date().toISOString() };
      f.store.saveRuntimeTurnRecovery(f.guard,f.signature,sent);
      const running = { ...sent, phase: 'turn_running' as const, turnId: 'owned-turn', connectionErrorCount: 3 };
      f.store.saveRuntimeTurnRecovery(f.guard,f.signature,running);
      expect(() => f.store.saveRuntimeTurnRecovery(f.guard,f.signature,{ ...running, connectionErrorCount: 0 })).toThrow('RUNTIME_RECOVERY_BUDGET_RESET');
      expect(() => f.store.getRuntimeTurnRecovery({ ...f.guard, accountFingerprint: 'wrong-account' },f.signature)).toThrow();
      const resumed = f.resume();
      expect(() => f.store.getRuntimeTurnRecovery(f.guard,f.signature)).toThrow();
      expect(f.store.getRuntimeTurnRecovery(resumed,f.signature)?.connectionErrorCount).toBe(3);
    } finally { f.store.close(); }
  });
  it('固定诊断可追溯请求及阶段，但不能存自由错误、模型输出或路径', () => {
    const f = setup();
    try {
      const event = { kind: 'startup_waiting_late_reply' as const, method: 'turn/start' as const, requestId: 5,
        elapsedMs: 20_000, count: 0, threadId: 'owned-thread', turnId: null, failureCode: null };
      f.store.recordRuntimeRecoveryDiagnostic(f.guard,f.signature,event);
      f.store.recordRuntimeRecoveryDiagnostic(f.guard,f.signature,event);
      expect(() => f.store.recordRuntimeRecoveryDiagnostic(f.guard,f.signature,{ ...event, message: '不应保存正文' } as typeof event)).toThrow();
      const db = new Database(f.store.databasePath,{ readonly: true });
      try {
        const rows = db.prepare("SELECT summary FROM audit_events WHERE event_type='runtime_recovery'").all() as Array<{summary:string}>;
        expect(rows).toHaveLength(1); expect(JSON.parse(rows[0]!.summary)).toMatchObject(event);
        expect(JSON.stringify(rows)).not.toContain('不应保存正文');
      } finally { db.close(); }
    } finally { f.store.close(); }
  });
  it('同一操作回执未知时，改提示词或版本不能绕过绑定再次发送', () => {
    const f = setup();
    try {
      f.store.saveRuntimeTurnRecovery(f.guard, f.signature, f.initial, 'operation-hash');
      expect(() => f.store.getRuntimeTurnRecovery(f.guard, 'e'.repeat(64), 'operation-hash')).toThrow('RUNTIME_RECOVERY_INPUT_CHANGED');
      expect(f.store.getRuntimeTurnRecovery(f.guard, 'e'.repeat(64), 'different-operation')).toBeNull();
      const resumed = f.resume();
      expect(() => f.store.saveRuntimeTurnRecovery(resumed, 'e'.repeat(64), f.initial, 'operation-hash')).toThrow('RUNTIME_RECOVERY_INPUT_CHANGED');
    } finally { f.store.close(); }
  });
  it('失败后迟到启动回执仅补齐所属轮次ID，撤权后不能写入', () => {
    const f = setup();
    try {
      f.store.saveRuntimeTurnRecovery(f.guard, f.signature, f.initial);
      const ready = { ...f.initial, phase: 'thread_ready' as const, threadId: 'owned-thread' };
      f.store.saveRuntimeTurnRecovery(f.guard, f.signature, ready);
      const starting = { ...ready, phase: 'turn_starting' as const, turnStarts: 1, turnStartedAt: new Date().toISOString() };
      f.store.saveRuntimeTurnRecovery(f.guard, f.signature, starting);
      f.store.finishJob(f.jobId, 'failed');
      f.store.finishJobAttempt({ attemptId: f.guard.attemptId, status: 'failed', errorCode: 'CODEX_RPC_TIMEOUT:turn/start' });
      expect(f.store.saveRuntimeLateStartReceipt(f.guard, f.signature, 'foreign-thread', 'owned-turn')).toBe(false);
      expect(f.store.saveRuntimeLateStartReceipt(f.guard, f.signature, 'owned-thread', 'owned-turn')).toBe(true);
      expect(f.store.saveRuntimeLateStartReceipt(f.guard, f.signature, 'owned-thread', 'another-turn')).toBe(false);
      f.store.revokeConsent(f.guard.consentId);
      expect(f.store.saveRuntimeLateStartReceipt(f.guard, f.signature, 'owned-thread', 'owned-turn')).toBe(false);
    } finally { f.store.close(); }
  });
  it('新attempt接管后，旧attempt的迟到回执不能修改新恢复状态', () => {
    const f = setup();
    try {
      f.store.saveRuntimeTurnRecovery(f.guard, f.signature, f.initial);
      const ready = { ...f.initial, phase: 'thread_ready' as const, threadId: 'owned-thread' };
      f.store.saveRuntimeTurnRecovery(f.guard, f.signature, ready);
      const starting = { ...ready, phase: 'turn_starting' as const, turnStarts: 1, turnStartedAt: new Date().toISOString() };
      f.store.saveRuntimeTurnRecovery(f.guard, f.signature, starting);
      const resumed = f.resume();
      expect(f.store.saveRuntimeLateStartReceipt(f.guard, f.signature, 'owned-thread', 'late-turn')).toBe(false);
      expect(f.store.getRuntimeTurnRecovery(resumed, f.signature)).toEqual(starting);
    } finally { f.store.close(); }
  });
});
