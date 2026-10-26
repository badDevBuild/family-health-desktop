import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceStore } from './index.js';

const fixtures: Array<{ directory: string; close: () => void }> = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

// 仅使用临时合成库、公有存储入口和假回执；不运行应用、原件识别或模型。
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'family-health-request-limits-'));
  let now = new Date('2026-10-15T00:00:00Z').getTime();
  let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date(now) });
  fixtures.push({ directory, close: () => store.close() });
  const person = store.createPerson({ displayName: '合成限流成员', relation: '本人' });
  const documentIds = [0, 1].map((index) => {
    const source = store.putSourceObject({ bytes: Buffer.from(`合成项目 1.0，合成原件${index}`),
      mediaType: 'text/plain', displayName: `合成限流原件${index}.txt` });
    const documentId = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id }).documentId;
    if (index === 0) {
      const sourceSpanId = `synthetic-limit-span-${documentId}`;
      const quote = '合成项目 1.0';
      store.saveSourceManifest({ id: `synthetic-limit-manifest-${documentId}`, sourceObjectId: source.id,
        sha256: source.sha256, mediaType: 'text/plain', originalDisplayName: '合成已保存原件.txt',
        totalUnits: 1, coveredUnitIndexes: [0], normalizerVersion: 'synthetic-request-limit-v1',
        conversionWarnings: [], createdAt: new Date(now).toISOString(),
        spans: [{ id: sourceSpanId, documentId, spanKind: 'line', page: null, blockId: null,
          lineStart: 1, lineEnd: 1, quote, readability: 'clear' }] });
      const acceptanceId = store.saveAcceptanceDecision({ method: 'auto', actor: 'policy',
        rulesVersion: 'synthetic-request-limit-v1', inputSignature: 'synthetic-limit-fact-input',
        outputHash: 'synthetic-limit-fact-output', reviewRef: null, decision: 'accept' });
      store.publishFacts({ personId: person.id, documentId, documentCommitKey: 'synthetic-limit-commit',
        expectedRevision: store.getFactRevision(person.id), changeSetHash: 'synthetic-limit-change',
        summary: '合成已完成结果', observations: [{ documentId, sourceSpanId, acceptanceId,
          conceptKey: '合成项目', originalName: '合成项目', rawText: '1.0', valueKind: 'numeric', decimalValue: '1.0',
          qualifier: 'eq', unit: null, referenceRange: null, abnormalFlag: 'normal', specimen: null,
          method: null, bodySite: null, clinicalDate: null, evidence: [{ sourceSpanId, quote }] }] });
    }
    return documentId;
  });
  const accountFingerprint = 'synthetic-request-limit-account';
  const consentId = store.createManualProcessingConsent({ documentIds, personIds: [person.id], accountFingerprint, version: 1 });
  const jobId = store.createWaitingAuthBatch({ cutoff: new Date(now).toISOString(), initialStatus: 'queued', consentId,
    groups: [{ personId: person.id, documentIds, inputSignature: 'synthetic-request-limit-job' }] }).jobIds[0]!;
  const claim = () => {
    const job = store.claimNextQueuedJob('synthetic-request-limit-runner', accountFingerprint);
    if (!job) return null;
    const attemptId = store.startJobAttempt(jobId, 'synthetic-runtime', 'gpt-6.1-sol', 'medium');
    return { job, guard: { jobId, attemptId, consentId, accountFingerprint } };
  };
  const firstAttempt = claim()!;
  store.markJobDocumentProcessed(jobId, documentIds[0]!, 'published', firstAttempt.guard);
  store.saveExtractionChunkCheckpoint({ guard: firstAttempt.guard, documentId: documentIds[1]!,
    signature: 'synthetic-P01-signature', chunkIndex: 0, output: { synthetic: 'cached-P01', repairAttempted: true },
    threadId: 'synthetic-thread', turnId: 'synthetic-turn', extractionTurnId: 'synthetic-P01-turn' });
  const finish = (attemptId: string, errorCode: string | null = 'CODEX_QUOTA_EXHAUSTED',
    status: 'waiting_quota' | 'waiting_auth' = 'waiting_quota') => {
    store.finishJobAttempt({ attemptId, status, errorCode });
    store.finishJob(jobId, status);
  };
  return { get store() { return store; }, jobId, personId: person.id, documentIds, consentId, accountFingerprint,
    firstAttempt, claim, finish,
    advance(milliseconds: number) { now += milliseconds; },
    reopen() { store.close(); store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date(now) }); }
  };
}

function persistedJob(store: WorkspaceStore, jobId: string) {
  const database = new Database(store.databasePath, { readonly: true });
  try {
    const row = database.prepare('SELECT stage,status,checkpoint_json FROM jobs WHERE id=?').get(jobId) as {
      stage: string; status: string; checkpoint_json: string;
    };
    return { ...row, checkpoint: JSON.parse(row.checkpoint_json) as Record<string, unknown> };
  } finally { database.close(); }
}

describe('明确额度回执与通用自动恢复分离', () => {
  it('明确用量上限不被重复通用可用通知复活，跨重启仍保留进度、缓存和事实', () => {
    const f = fixture();
    f.finish(f.firstAttempt.guard.attemptId);
    const before = persistedJob(f.store, f.jobId);
    const factsBefore = f.store.listAcceptedObservations(f.personId);
    for (let iteration = 0; iteration < 3; iteration += 1) {
      f.advance(60_000);
      expect(f.store.requeueWaitingJobs('waiting_quota')).toBe(0);
      expect(f.claim()).toBeNull();
      expect(persistedJob(f.store, f.jobId)).toEqual(before);
    }
    f.reopen();
    expect(f.store.recoverInterruptedJobs()).toBe(0);
    expect(f.store.requeueWaitingJobs('waiting_quota')).toBe(0);
    expect(f.claim()).toBeNull();
    expect(persistedJob(f.store, f.jobId)).toEqual(before);
    expect(f.store.getJobProcessedDocumentIds(f.jobId)).toEqual(new Set([f.documentIds[0]]));
    expect(f.store.listAcceptedObservations(f.personId)).toEqual(factsBefore);
  });

  it.each([null, 'CODEX_REQUEST_LIMITED_UNKNOWN', 'CODEX_RATE_LIMITED', 'CODEX_TURN_FAILED'] as const)('没有最新明确用量上限回执的旧waiting_quota仍可自动恢复：%s', (code) => {
    const f = fixture(); f.finish(f.firstAttempt.guard.attemptId, code);
    const checkpoint = persistedJob(f.store, f.jobId).checkpoint;
    expect(f.store.requeueWaitingJobs('waiting_quota')).toBe(1);
    expect(persistedJob(f.store, f.jobId).checkpoint).toEqual(checkpoint);
    expect(f.claim()?.job.id).toBe(f.jobId);
  });

  it.each([
    { first: 'CODEX_QUOTA_EXHAUSTED', latest: 'CODEX_RATE_LIMITED', automatic: 1 },
    { first: 'CODEX_RATE_LIMITED', latest: 'CODEX_QUOTA_EXHAUSTED', automatic: 0 },
    { first: 'CODEX_QUOTA_EXHAUSTED', latest: null, automatic: 1 }
  ] as const)('同started_at按rowid取最新attempt，不让旧$first覆盖最新$latest', ({ first, latest, automatic }) => {
    const f = fixture(); f.finish(f.firstAttempt.guard.attemptId, first);
    f.store.retryFailedJob(f.jobId);
    const second = f.claim()!;
    f.finish(second.guard.attemptId, latest);
    const database = new Database(f.store.databasePath, { readonly: true });
    const attempts = database.prepare('SELECT started_at,error_code FROM job_attempts WHERE job_id=? ORDER BY rowid')
      .all(f.jobId) as Array<{ started_at: string; error_code: string | null }>;
    database.close();
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.started_at).toBe(attempts[1]!.started_at);
    expect(f.store.requeueWaitingJobs('waiting_quota')).toBe(automatic);
    expect(f.store.listStoredJobs()[0]!.status).toBe(automatic === 1 ? 'queued' : 'waiting_quota');
  });

  it('waiting_auth的正常恢复不受额度回执过滤影响', () => {
    const f = fixture(); f.finish(f.firstAttempt.guard.attemptId, 'CODEX_QUOTA_EXHAUSTED', 'waiting_auth');
    expect(f.store.requeueWaitingJobs('waiting_auth')).toBe(1);
    expect(f.claim()?.job.id).toBe(f.jobId);
  });

  it.each(['extract', 'analyze'] as const)('本人继续waiting_quota只清忙碌预算，保留%s阶段、逐份完成、P01缓存和正式事实', (stage) => {
    const f = fixture();
    f.store.updateJobStage(f.jobId, stage);
    f.store.finishModelBusyAttempt({ guard: f.firstAttempt.guard,
      analysisAiPreferences: { modelId: 'gpt-6.1-sol', reasoningEffort: 'medium' } });
    f.advance(30_000);
    const limited = f.claim()!; f.finish(limited.guard.attemptId);
    const before = persistedJob(f.store, f.jobId);
    const factsBefore = f.store.listAcceptedObservations(f.personId);
    expect(before.checkpoint.modelBusyRetry).toBeDefined();
    f.store.retryFailedJob(f.jobId);
    const after = persistedJob(f.store, f.jobId);
    const { modelBusyRetry: _busy, ...expectedCheckpoint } = before.checkpoint;
    expect(after).toMatchObject({ status: 'queued', stage, checkpoint: expectedCheckpoint });
    expect(after.checkpoint).toEqual(expectedCheckpoint);
    const resumed = f.claim()!;
    expect(resumed.job).toMatchObject({ id: f.jobId, stage, attemptCount: 3 });
    expect(resumed.job.modelBusyRetry).toBeUndefined();
    expect(f.store.getJobProcessedDocumentIds(f.jobId)).toEqual(new Set([f.documentIds[0]]));
    expect(f.store.getExtractionChunkCheckpoint(resumed.guard, f.documentIds[1]!, 'synthetic-P01-signature'))
      .toMatchObject({ output: { synthetic: 'cached-P01', repairAttempted: true }, extractionTurnId: 'synthetic-P01-turn' });
    expect(f.store.listAcceptedObservations(f.personId)).toEqual(factsBefore);
  });

  it.each(['pause', 'consent', 'account'] as const)('本人继续仍必须通过%s门禁，排队不等于获准发送', (gate) => {
    const f = fixture(); f.finish(f.firstAttempt.guard.attemptId);
    const factsBefore = f.store.listAcceptedObservations(f.personId);
    if (gate === 'pause') f.store.setQueuePaused(true);
    if (gate === 'consent') f.store.revokeConsent(f.consentId);
    f.store.retryFailedJob(f.jobId);
    expect(f.store.claimNextQueuedJob('synthetic-manual-continue', gate === 'account' ? 'other-account' : f.accountFingerprint)).toBeNull();
    expect(f.store.listStoredJobs()[0]!.status).toBe(gate === 'pause' ? 'queued' : gate === 'consent' ? 'waiting_user' : 'waiting_auth');
    expect(f.store.getJobProcessedDocumentIds(f.jobId)).toEqual(new Set([f.documentIds[0]]));
    expect(f.store.listAcceptedObservations(f.personId)).toEqual(factsBefore);
    if (gate === 'pause') {
      f.store.setQueuePaused(false);
      expect(f.claim()?.job.id).toBe(f.jobId);
    }
  });

  it('已取消的额度等待任务不能被本人继续入口复活', () => {
    const f = fixture(); f.finish(f.firstAttempt.guard.attemptId);
    expect(f.store.requestJobCancellation(f.jobId)).toEqual({ running: false, alreadyTerminal: false });
    expect(() => f.store.retryFailedJob(f.jobId)).toThrow('JOB_NOT_RETRYABLE');
    expect(f.store.requeueWaitingJobs('waiting_quota')).toBe(0);
    expect(f.claim()).toBeNull();
    expect(f.store.listStoredJobs()[0]!.status).toBe('cancelled');
  });
});
