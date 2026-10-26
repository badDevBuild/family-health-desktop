import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceStore } from './index.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'family-health-assessment-outcome-'));
  directories.push(directory);
  let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-10-15T00:00:00Z') });
  const personId = store.createPerson({ displayName: '合成成员', relation: '本人' }).id;
  const source = store.putSourceObject({ bytes: Buffer.from('合成报告'), mediaType: 'text/plain', displayName: '合成.txt' });
  const documentId = store.registerImportedDocument({ sourceObjectId: source.id, personId }).documentId;
  const consentId = store.createManualProcessingConsent({ documentIds: [documentId], personIds: [personId],
    accountFingerprint: 'synthetic-account', version: 1 });
  const jobId = store.createWaitingAuthBatch({ cutoff: '2026-10-15T00:00:00Z', initialStatus: 'queued', consentId,
    groups: [{ personId, documentIds: [documentId], inputSignature: 'synthetic-assessment-job' }] }).jobIds[0]!;
  const claim = () => {
    expect(store.claimNextQueuedJob('synthetic-runner', 'synthetic-account')?.id).toBe(jobId);
    const attemptId = store.startJobAttempt(jobId, 'synthetic-runtime');
    return { jobId, attemptId, consentId, accountFingerprint: 'synthetic-account' };
  };
  const guard = claim();
  const metadata = () => ({ inputSignature: 'a'.repeat(64), factRevision: store.getFactRevision(personId),
    contextRevision: store.getClinicalContextRevision(personId), reviewScopeSignature: store.getOpenReviewScopeSignature(personId) });
  const publish = () => store.publishMemberAssessmentSnapshot({ snapshot: {
    schemaVersion: 3, personId, ...metadata(), mode: 'full', requestedSystemIds: [],
    promptVersion: 'synthetic-prompt', rulesVersion: 'synthetic-rules', modelId: 'synthetic-model', reasoningEffort: 'medium',
    validationMode: 'local_only', reviewedTargetIds: [], heldTargetIds: [], limitations: [], evidenceCatalog: [],
    processingPlan: { strategy: 'full', trigger: 'none', partitionCount: 0 }, knowledgeVerifications: [],
    overview: { id: 'overview', headline: '合成标题', summary: '合成范围说明。', claimIds: [], actionIds: [], limitations: [] },
    systems: [], claims: [], actions: [], questions: [], knowledgeSources: []
  }, executionGuard: guard }).snapshotId;
  const finish = (status: 'succeeded' | 'completed_with_issues' | 'failed' | 'cancelled') => {
    store.finishJob(jobId, status);
    store.finishJobAttempt({ attemptId: guard.attemptId, status });
  };
  return { get store() { return store; }, personId, documentId, jobId, guard, claim, metadata, publish, finish,
    reopen() { store.close(); store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-10-15T00:00:00Z') }); } };
}

describe('成员综合终态持久化', () => {
  it.each(['published', 'reused_current'] as const)('%s 绑定真实快照，重启后与报告进度分开读取', (status) => {
    const f = fixture();
    try {
      const snapshotId = f.publish();
      f.store.markJobDocumentProcessed(f.jobId, f.documentId, 'partial', f.guard);
      const outcome = f.store.updateJobAssessmentOutcome(f.guard, { ...f.metadata(), status, snapshotId, reasonCode: null });
      expect(f.store.listStoredJobs()[0]!.assessmentOutcome).toBeNull();
      f.finish('completed_with_issues');
      f.reopen();
      expect(f.store.listStoredJobs()[0]).toMatchObject({ completedUnits: 1, assessmentOutcome: outcome });
      expect(f.store.getJobProcessedDocumentIds(f.jobId)).toEqual(new Set([f.documentId]));
    } finally { f.store.close(); }
  });

  it.each(['rejected', 'skipped_no_data'] as const)('%s 不写网络错误，不携带旧快照', (status) => {
    const f = fixture();
    try {
      const reasonCode = status === 'rejected' ? 'validation_failed' : 'no_accepted_facts';
      const outcome = f.store.updateJobAssessmentOutcome(f.guard, { ...f.metadata(), status, snapshotId: null, reasonCode });
      f.finish('completed_with_issues');
      f.reopen();
      expect(f.store.listStoredJobs()[0]!.assessmentOutcome).toEqual(outcome);
      const database = new Database(f.store.databasePath, { readonly: true });
      expect(database.prepare('SELECT error_code FROM job_attempts WHERE id=?').get(f.guard.attemptId)).toEqual({ error_code: null });
      database.close();
    } finally { f.store.close(); }
  });

  it('不存在、其他成员、过期或版本不匹配的快照都不能记成发布', () => {
    const f = fixture();
    try {
      const input = { ...f.metadata(), status: 'published' as const, snapshotId: 'missing', reasonCode: null };
      expect(() => f.store.updateJobAssessmentOutcome(f.guard, input)).toThrow('JOB_ASSESSMENT_SNAPSHOT_MISMATCH');
      const snapshotId = f.publish();
      expect(() => f.store.updateJobAssessmentOutcome(f.guard, { ...input, snapshotId, inputSignature: 'b'.repeat(64) }))
        .toThrow('JOB_ASSESSMENT_SNAPSHOT_MISMATCH');
      expect(() => f.store.updateJobAssessmentOutcome(f.guard, { ...input, snapshotId, factRevision: 12 }))
        .toThrow('JOB_ASSESSMENT_INPUT_REVISION_MISMATCH');
      const database = new Database(f.store.databasePath);
      database.prepare("UPDATE member_assessment_snapshots_v3 SET status='stale' WHERE id=?").run(snapshotId);
      expect(() => f.store.updateJobAssessmentOutcome(f.guard, { ...input, snapshotId })).toThrow('JOB_ASSESSMENT_SNAPSHOT_MISMATCH');
      const other = f.store.createPerson({ displayName: '另一合成成员', relation: '家人' });
      database.prepare("UPDATE member_assessment_snapshots_v3 SET status='current',person_id=? WHERE id=?").run(other.id, snapshotId);
      expect(() => f.store.updateJobAssessmentOutcome(f.guard, { ...input, snapshotId })).toThrow('JOB_ASSESSMENT_SNAPSHOT_MISMATCH');
      database.close();
    } finally { f.store.close(); }
  });

  it.each(['cancel', 'consent', 'old_attempt'] as const)('%s guard 不允许写终态', (gate) => {
    const f = fixture();
    try {
      const input = { ...f.metadata(), status: 'rejected' as const, snapshotId: null, reasonCode: 'validation_failed' as const };
      expect(() => f.store.updateJobAssessmentOutcome({ ...f.guard, attemptId: 'unknown-attempt' }, input)).toThrow('JOB_EXECUTION_INACTIVE');
      if (gate === 'cancel') f.store.requestJobCancellation(f.jobId);
      if (gate === 'consent') f.store.revokeConsent(f.guard.consentId);
      if (gate === 'old_attempt') f.store.startJobAttempt(f.jobId, 'synthetic-next-runtime');
      expect(() => f.store.updateJobAssessmentOutcome(f.guard, input)).toThrow(gate === 'cancel' ? 'JOB_CANCELLED'
        : gate === 'consent' ? 'CONSENT_REVOKED' : 'JOB_EXECUTION_INACTIVE');
      expect(f.store.listStoredJobs()[0]!.assessmentOutcome).toBeNull();
    } finally { f.store.close(); }
  });

  it('重试清旧综合结局、保留逐份终态，新尝试失败也不能回显旧成功', () => {
    const f = fixture();
    try {
      const snapshotId = f.publish();
      f.store.markJobDocumentProcessed(f.jobId, f.documentId, 'published', f.guard);
      f.store.updateJobAssessmentOutcome(f.guard, { ...f.metadata(), status: 'published', snapshotId, reasonCode: null });
      f.finish('completed_with_issues');
      expect(f.store.listStoredJobs()[0]!.assessmentOutcome?.status).toBe('published');
      f.store.retryFailedJob(f.jobId);
      expect(f.store.listStoredJobs()[0]!.assessmentOutcome).toBeNull();
      const next = f.claim();
      expect(f.store.getJobProcessedDocumentIds(f.jobId)).toEqual(new Set([f.documentId]));
      f.store.finishJob(f.jobId, 'failed');
      f.store.finishJobAttempt({ attemptId: next.attemptId, status: 'failed', errorCode: 'SYNTHETIC_FAILURE' });
      expect(f.store.listStoredJobs()[0]!.assessmentOutcome).toBeNull();
    } finally { f.store.close(); }
  });

  it.each(['failed', 'cancelled'] as const)('保存后 %s 仍不能宣称本轮已发布', (status) => {
    const f = fixture();
    try {
      f.store.updateJobAssessmentOutcome(f.guard, { ...f.metadata(), status: 'published', snapshotId: f.publish(), reasonCode: null });
      f.finish(status);
      expect(f.store.listStoredJobs()[0]!.assessmentOutcome).toBeNull();
      f.reopen();
      expect(f.store.listStoredJobs()[0]!.assessmentOutcome).toBeNull();
    } finally { f.store.close(); }
  });

  it('旧记录、坏结构、伪造最新尝试和损坏快照读取时安全回 null', () => {
    const f = fixture();
    try {
      expect(f.store.listStoredJobs()[0]!.assessmentOutcome).toBeNull();
      const snapshotId = f.publish();
      const good = f.store.updateJobAssessmentOutcome(f.guard, { ...f.metadata(), status: 'published', snapshotId, reasonCode: null });
      f.finish('succeeded');
      const database = new Database(f.store.databasePath);
      const original = database.prepare('SELECT checkpoint_json FROM jobs WHERE id=?').get(f.jobId) as { checkpoint_json: string };
      const checkpoint = JSON.parse(original.checkpoint_json);
      for (const invalid of [{ ...good, detail: '不能写模型正文' }, { ...good, attemptId: 'older-attempt' }]) {
        database.prepare('UPDATE jobs SET checkpoint_json=? WHERE id=?').run(JSON.stringify({ ...checkpoint, assessmentOutcome: invalid }), f.jobId);
        expect(f.store.listStoredJobs()[0]!.assessmentOutcome).toBeNull();
      }
      database.prepare('UPDATE jobs SET checkpoint_json=? WHERE id=?').run(original.checkpoint_json, f.jobId);
      database.prepare("UPDATE member_assessment_snapshots_v3 SET payload_json='broken-json' WHERE id=?").run(snapshotId);
      expect(f.store.listStoredJobs()[0]!.assessmentOutcome).toBeNull();
      database.close();
    } finally { f.store.close(); }
  });

  it('有个人补充时不能伪记无资料跳过', () => {
    const f = fixture();
    try {
      f.store.createManualNote({ personId: f.personId, kind: 'free_text', immutableText: '合成补充', effectiveDate: null,
        structuredFields: {}, expectedContextRevision: 0 });
      expect(() => f.store.updateJobAssessmentOutcome(f.guard, { ...f.metadata(), status: 'skipped_no_data',
        snapshotId: null, reasonCode: 'no_accepted_facts' })).toThrow('JOB_ASSESSMENT_DATA_PRESENT');
    } finally { f.store.close(); }
  });

  it.each(['published', 'rejected', 'reused_current', 'skipped_no_data'] as const)('%s 清理过期调用后重启仍保留准确终态，但不留完整会话和用量', (status) => {
    const f = fixture();
    try {
      const snapshotId = status === 'published' || status === 'reused_current' ? f.publish() : null;
      const reasonCode = status === 'rejected' ? 'validation_failed' : status === 'skipped_no_data' ? 'no_accepted_facts' : null;
      const outcome = f.store.updateJobAssessmentOutcome(f.guard, { ...f.metadata(), status, snapshotId, reasonCode });
      f.store.markJobDocumentProcessed(f.jobId, f.documentId, 'partial', f.guard);
      f.finish('completed_with_issues');
      const database = new Database(f.store.databasePath);
      database.prepare(`UPDATE job_attempts SET runtime_version='synthetic-runtime',model='synthetic-model',reasoning_effort='medium',
        thread_id='synthetic-private-thread',turn_id='synthetic-private-turn',usage_json=?,error_code='synthetic-safe-code' WHERE id=?`)
        .run(JSON.stringify({ originalOutput: '不能无限保存的合成调用正文' }), f.guard.attemptId);
      database.prepare(`INSERT INTO job_attempts(id,job_id,status,started_at,finished_at,thread_id,usage_json)
        VALUES('synthetic-older-attempt',?,'failed','2026-10-14T00:00:00Z','2026-10-14T00:01:00Z','synthetic-old-thread','{}')`).run(f.jobId);
      database.close();
      expect(f.store.cleanupTerminalTaskAttempts('2026-11-15T00:00:00Z')).toBe(1);
      f.reopen();
      expect(f.store.listStoredJobs()[0]).toMatchObject({ completedUnits: 1, assessmentOutcome: outcome });
      expect(f.store.getJobProcessedDocumentIds(f.jobId)).toEqual(new Set([f.documentId]));
      const cleaned = new Database(f.store.databasePath, { readonly: true });
      expect(cleaned.prepare('SELECT * FROM job_attempts WHERE job_id=?').all(f.jobId)).toEqual([{
        id: f.guard.attemptId, job_id: f.jobId, status: 'completed_with_issues',
        started_at: '2026-10-15T00:00:00.000Z', finished_at: '2026-10-15T00:00:00.000Z',
        runtime_version: null, model: null, reasoning_effort: null, thread_id: null, turn_id: null, error_code: null, usage_json: null
      }]);
      cleaned.close();
      expect(f.store.cleanupTerminalTaskAttempts('2026-11-15T00:00:00Z')).toBe(0);
      expect(f.store.listStoredJobs()[0]!.assessmentOutcome).toEqual(outcome);
    } finally { f.store.close(); }
  });

  it.each(['legacy', 'invalid', 'orphan', 'older_attempt', 'missing_snapshot'] as const)('%s 回执不能凭空保住尝试或在清理后变成已发布', (kind) => {
    const f = fixture();
    try {
      const outcome = f.store.updateJobAssessmentOutcome(f.guard, { ...f.metadata(), status: 'published', snapshotId: f.publish(), reasonCode: null });
      f.finish('succeeded');
      const database = new Database(f.store.databasePath);
      const saved = database.prepare('SELECT checkpoint_json FROM jobs WHERE id=?').get(f.jobId) as { checkpoint_json: string };
      const checkpoint = JSON.parse(saved.checkpoint_json) as Record<string, unknown>;
      if (kind === 'legacy') delete checkpoint.assessmentOutcome;
      if (kind === 'invalid') checkpoint.assessmentOutcome = { ...outcome, arbitraryText: '合成自由正文' };
      if (kind === 'orphan') checkpoint.assessmentOutcome = { ...outcome, attemptId: 'nonexistent-attempt' };
      if (kind === 'older_attempt') database.prepare(`INSERT INTO job_attempts(id,job_id,status,started_at,finished_at)
        VALUES('synthetic-newer-attempt',?,'failed','2026-10-16T00:00:00Z','2026-10-16T00:01:00Z')`).run(f.jobId);
      if (kind === 'missing_snapshot') database.prepare('DELETE FROM member_assessment_snapshots_v3 WHERE id=?').run(outcome.snapshotId);
      database.prepare('UPDATE jobs SET checkpoint_json=? WHERE id=?').run(JSON.stringify(checkpoint), f.jobId);
      database.close();
      expect(f.store.listStoredJobs()[0]!.assessmentOutcome).toBeNull();
      expect(f.store.cleanupTerminalTaskAttempts('2026-11-15T00:00:00Z')).toBe(kind === 'older_attempt' ? 2 : 1);
      f.reopen();
      expect(f.store.listStoredJobs()[0]!.assessmentOutcome).toBeNull();
      const cleaned = new Database(f.store.databasePath, { readonly: true });
      expect(cleaned.prepare('SELECT COUNT(*) AS count FROM job_attempts WHERE job_id=?').get(f.jobId)).toEqual({ count: 0 });
      cleaned.close();
    } finally { f.store.close(); }
  });
});
