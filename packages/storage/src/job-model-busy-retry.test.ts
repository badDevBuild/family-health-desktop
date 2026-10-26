import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceStore } from './index.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'family-health-busy-retry-'));
  directories.push(directory);
  let time = new Date('2026-10-13T00:00:00Z').getTime();
  let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date(time) });
  const person = store.createPerson({ displayName: '合成重试成员', relation: '本人' });
  const source = store.putSourceObject({ bytes: Buffer.from('合成重试资料'), mediaType: 'text/plain', displayName: '合成报告.txt' });
  const documentId = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id }).documentId;
  const consentId = store.createManualProcessingConsent({ documentIds: [documentId], personIds: [person.id],
    accountFingerprint: 'synthetic-account', version: 1 });
  const jobId = store.createWaitingAuthBatch({ cutoff: new Date(time).toISOString(), initialStatus: 'queued', consentId,
    groups: [{ personId: person.id, documentIds: [documentId], inputSignature: 'synthetic-busy-signature' }] }).jobIds[0]!;
  const claim = () => {
    const job = store.claimNextQueuedJob('synthetic-runner', 'synthetic-account');
    if (!job) return null;
    const attemptId = store.startJobAttempt(jobId, 'synthetic-runtime', 'gpt-6.1-sol', 'medium');
    return { job, guard: { jobId, attemptId, consentId, accountFingerprint: 'synthetic-account' } };
  };
  return { get store() { return store; }, jobId, documentId, consentId, claim,
    advance(ms: number) { time += ms; },
    reopen() { store.close(); store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date(time) }); } };
}

describe('持久模型繁忙续跑', () => {
  it('明确短期限流与繁忙交替共用预算，保留真实原因和完成断点，重启不重置', () => {
    const f = fixture();
    try {
      const preferences = { modelId: 'gpt-6.1-sol', reasoningEffort: 'medium' as const };
      let attempt = f.claim()!;
      f.store.markJobDocumentProcessed(f.jobId, f.documentId, 'published', attempt.guard);
      expect(f.store.finishModelBusyAttempt({ guard: attempt.guard, analysisAiPreferences: preferences,
        reasonCode: 'CODEX_RATE_LIMITED' })).toMatchObject({ status: 'retry_wait', retryCount: 1 });
      expect(f.store.listStoredJobs()[0]?.statusText).toContain('请求暂时受到限流');
      expect(f.store.listStoredJobs()[0]?.statusText).not.toContain('模型暂时繁忙');
      f.reopen(); f.advance(30_000); attempt = f.claim()!;
      expect(f.store.getJobProcessedDocumentIds(f.jobId)).toEqual(new Set([f.documentId]));
      expect(f.store.finishModelBusyAttempt({ guard: attempt.guard, analysisAiPreferences: preferences }))
        .toMatchObject({ status: 'retry_wait', retryCount: 2 });
      f.reopen(); f.advance(120_000); attempt = f.claim()!;
      expect(f.store.finishModelBusyAttempt({ guard: attempt.guard, analysisAiPreferences: preferences,
        reasonCode: 'CODEX_RATE_LIMITED' })).toMatchObject({ status: 'failed', retryCount: 2, nextRetryAt: null });
      const db = new Database(f.store.databasePath, { readonly: true });
      try {
        expect(db.prepare('SELECT error_code FROM job_attempts ORDER BY rowid').all()).toEqual([
          { error_code: 'CODEX_RATE_LIMITED' }, { error_code: 'CODEX_MODEL_BUSY' }, { error_code: 'CODEX_RATE_LIMITED' }
        ]);
      } finally { db.close(); }
      f.advance(1_000_000); expect(f.claim()).toBeNull();
    } finally { f.store.close(); }
  });
  it.each(['LOCAL_STORAGE_FULL', 'ENOSPC: synthetic write failed', 'SQLITE_FULL: database or disk is full'])(
    '存储失败 %s 显示可保留进度的本机原因，不显示模型繁忙', (code) => {
      const f = fixture();
      try {
        const attempt = f.claim()!;
        f.store.markJobDocumentProcessed(f.jobId, f.documentId, 'published', attempt.guard);
        f.store.updateJobProgress(f.jobId, 1);
        f.store.finishJob(f.jobId, 'failed');
        f.store.finishJobAttempt({ attemptId: attempt.guard.attemptId, status: 'failed', errorCode: code });
        const job = f.store.listStoredJobs()[0]!;
        expect(job.statusText).toBe('本机磁盘空间不足；原件和已完成结果保留。请释放空间后重试，将从保存的进度继续');
        expect(job).toMatchObject({ status: 'failed', completedUnits: 1 });
        expect(f.store.hasDueModelBusyRetry()).toBe(false);
        expect(f.claim()).toBeNull();
        f.store.retryFailedJob(f.jobId);
        const resumed = f.claim()!;
        expect(resumed.job.stage).toBe(attempt.job.stage);
        expect(f.store.getJobProcessedDocumentIds(f.jobId)).toEqual(new Set([f.documentId]));
      } finally { f.store.close(); }
    });

  it('30秒与120秒预算跨重启保留，第三次停止；手动重试只清预算不清阶段与完成记录', () => {
    const f = fixture();
    try {
      let attempt = f.claim()!;
      f.store.updateJobStage(f.jobId, 'analyze');
      f.store.markJobDocumentProcessed(f.jobId, f.documentId, 'published', attempt.guard);
      const preferences = { modelId: 'gpt-6.1-sol', reasoningEffort: 'medium' as const };
      expect(f.store.finishModelBusyAttempt({ guard: attempt.guard, analysisAiPreferences: preferences,
        threadId: 'synthetic-thread', turnId: 'synthetic-turn' })).toEqual({
        status: 'retry_wait', retryCount: 1, nextRetryAt: '2026-10-13T00:00:30.000Z' });
      expect(() => f.store.assertJobExecutionActive(attempt.guard)).toThrow('JOB_EXECUTION_INACTIVE');
      expect(f.store.listStoredJobs()[0]).toMatchObject({ status: 'retry_wait', stage: 'analyze', completedUnits: 1 });
      expect(f.store.listStoredJobs()[0]!.statusText).toContain('第 1/2 次');
      expect(f.claim()).toBeNull();
      f.reopen();
      expect(f.store.recoverInterruptedJobs()).toBe(0);
      f.advance(29_999);
      expect(f.store.hasDueModelBusyRetry()).toBe(false);
      expect(f.claim()).toBeNull();
      f.advance(1);
      expect(f.store.hasDueModelBusyRetry()).toBe(true);
      attempt = f.claim()!;
      expect(attempt.job.modelBusyRetry?.analysisAiPreferences).toEqual(preferences);
      expect(f.store.finishModelBusyAttempt({ guard: attempt.guard,
        analysisAiPreferences: { modelId: 'different-model', reasoningEffort: 'high' } })).toEqual({
        status: 'retry_wait', retryCount: 2, nextRetryAt: '2026-10-13T00:02:30.000Z' });
      f.reopen();
      f.advance(119_999);
      expect(f.claim()).toBeNull();
      f.advance(1);
      attempt = f.claim()!;
      expect(attempt.job.modelBusyRetry?.analysisAiPreferences).toEqual(preferences);
      expect(f.store.finishModelBusyAttempt({ guard: attempt.guard, analysisAiPreferences: preferences }))
        .toEqual({ status: 'failed', retryCount: 2, nextRetryAt: null });
      expect(f.store.listStoredJobs()[0]!.statusText).toContain('已停止自动重试');
      f.advance(1_000_000);
      expect(f.store.hasDueModelBusyRetry()).toBe(false);
      expect(f.claim()).toBeNull();
      const db = new Database(f.store.databasePath, { readonly: true });
      const attempts = db.prepare('SELECT status,error_code,thread_id,turn_id,finished_at FROM job_attempts ORDER BY rowid').all();
      expect(attempts).toHaveLength(3);
      expect(attempts[0]).toMatchObject({ status: 'retry_wait', error_code: 'CODEX_MODEL_BUSY',
        thread_id: 'synthetic-thread', turn_id: 'synthetic-turn' });
      expect(attempts.every((row) => (row as { finished_at: string | null }).finished_at !== null)).toBe(true);
      db.close();
      f.store.retryFailedJob(f.jobId);
      attempt = f.claim()!;
      expect(attempt.job).toMatchObject({ stage: 'analyze', attemptCount: 4 });
      expect(attempt.job.modelBusyRetry).toBeUndefined();
      expect(f.store.getJobProcessedDocumentIds(f.jobId)).toEqual(new Set([f.documentId]));
      f.store.finishJobAttempt({ attemptId: attempt.guard.attemptId, status: 'cancelled' });
      f.store.finishJob(f.jobId, 'cancelled');
    } finally { f.store.close(); }
  });

  it.each(['cancel', 'pause', 'consent', 'account'] as const)('到期仍遵守 %s 门禁，不自动复活', (gate) => {
    const f = fixture();
    try {
      const attempt = f.claim()!;
      f.store.finishModelBusyAttempt({ guard: attempt.guard,
        analysisAiPreferences: { modelId: 'gpt-6.1-sol', reasoningEffort: 'medium' } });
      if (gate === 'cancel') expect(f.store.requestJobCancellation(f.jobId)).toEqual({ running: false, alreadyTerminal: false });
      if (gate === 'pause') f.store.setQueuePaused(true);
      if (gate === 'consent') f.store.revokeConsent(f.consentId);
      f.advance(30_000);
      const claimed = f.store.claimNextQueuedJob('synthetic-resume', gate === 'account' ? 'other-account' : 'synthetic-account');
      expect(claimed).toBeNull();
      expect(f.store.listStoredJobs()[0]!.status).toBe(gate === 'cancel' ? 'cancelled'
        : gate === 'consent' ? 'waiting_user' : gate === 'account' ? 'waiting_auth' : 'retry_wait');
      if (gate === 'pause') {
        f.store.setQueuePaused(false);
        expect(f.store.claimNextQueuedJob('synthetic-resume', 'synthetic-account')?.id).toBe(f.jobId);
      }
    } finally { f.store.close(); }
  });
});
