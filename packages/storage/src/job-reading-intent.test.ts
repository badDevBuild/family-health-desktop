import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceStore } from './index.js';

const fixtures: { root: string; store: WorkspaceStore }[] = [];
afterEach(() => {
  for (const { root, store } of fixtures.splice(0)) {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(stage: 'extract' | 'analyze' = 'extract', repair = false) {
  const root = mkdtempSync(join(tmpdir(), 'family-health-reading-intent-'));
  const store = new WorkspaceStore({ rootDirectory: root });
  fixtures.push({ root, store });
  const person = store.createPerson({ displayName: '合成成员' });
  const documentIds = ['合成原件甲', '合成原件乙'].map((text) => {
    const source = store.putSourceObject({ bytes: Buffer.from(text), mediaType: 'text/plain', displayName: `${text}.txt` });
    return store.registerImportedDocument({ personId: person.id, sourceObjectId: source.id }).documentId;
  });
  const accountFingerprint = 'synthetic-reading-intent-account';
  const consentId = store.createManualProcessingConsent({ documentIds, personIds: [person.id], accountFingerprint, version: 1 });
  if (repair) {
    const previous = store.createWaitingAuthBatch({ cutoff: '2026-01-03T00:00:00Z', initialStatus: 'queued', consentId,
      groups: [{ personId: person.id, documentIds, inputSignature: 'synthetic-original-reading' }] }).jobIds[0]!;
    store.claimNextQueuedJob('synthetic-original-runner', accountFingerprint);
    const previousAttempt = store.startJobAttempt(previous, 'synthetic-runtime');
    for (const documentId of documentIds) store.saveExtractionReviewIssue({ documentId, jobId: previous,
      attemptId: previousAttempt, stage: 'extract', kind: 'coverage_gap', severity: 'blocking',
      evidenceRefs: [], reasonCodes: ['coverage_incomplete'] });
    store.finishJobAttempt({ attemptId: previousAttempt, status: 'failed' });
    store.finishJob(previous, 'failed');
  }
  const jobId = store.createWaitingAuthBatch({ cutoff: '2026-01-03T00:00:00Z', initialStatus: 'queued', consentId,
    ...(repair ? { repairDocumentIds: documentIds } : {}),
    groups: [{ personId: person.id, documentIds, inputSignature: 'synthetic-reading-intent', stage }] }).jobIds[0]!;
  store.claimNextQueuedJob('synthetic-reading-intent-runner', accountFingerprint);
  const attemptId = store.startJobAttempt(jobId, 'synthetic-runtime');
  return { store, jobId, documentIds, guard: { jobId, attemptId, consentId, accountFingerprint } };
}

describe('只读读取意图与逐份终态分离', () => {
  it('当前提取或独立核对的明确整轮范围，不依赖既有提交或完成数', () => {
    const f = fixture();
    f.store.updateJobProgress(f.jobId, 2);
    expect(f.store.getJobReadingDocumentIds(f.jobId)).toEqual(new Set(f.documentIds));
    expect(f.store.getJobProcessedDocumentIds(f.jobId)).toEqual(new Set());
    f.store.updateJobStage(f.jobId, 'review_facts');
    expect(f.store.getJobReadingDocumentIds(f.jobId)).toEqual(new Set(f.documentIds));
  });

  it('纯综合即使给旧事实写published收据，也不冒充原件重新读取', () => {
    const f = fixture('analyze');
    f.store.markJobDocumentProcessed(f.jobId, f.documentIds[0]!, 'published', f.guard);
    expect(f.store.getJobProcessedDocumentIds(f.jobId)).toEqual(new Set([f.documentIds[0]]));
    expect(f.store.getJobReadingDocumentIds(f.jobId)).toEqual(new Set());
  });

  it('明示重新核对的范围推进到综合后仍保留读取意图', () => {
    const f = fixture('extract', true);
    f.store.updateJobStage(f.jobId, 'analyze');
    expect(f.store.getJobReadingDocumentIds(f.jobId)).toEqual(new Set(f.documentIds));
  });

  it.each(['extract', 'review_facts', 'repair_extraction'])('本任务真实完成%s传输，在推进后仅证明对应原件范围', (stage) => {
    const f = fixture();
    const transmissionId = f.store.beginAiTransmission({ guard: f.guard, documentId: f.documentIds[0]!, stage });
    f.store.finishAiTransmission(transmissionId, 'completed');
    f.store.updateJobStage(f.jobId, 'analyze');
    expect(f.store.getJobReadingDocumentIds(f.jobId)).toEqual(new Set([f.documentIds[0]]));
    expect(f.store.getJobProcessedDocumentIds(f.jobId)).toEqual(new Set());
  });

  it.each(['sending', 'acknowledged', 'unknown'])('只有%s传输不冒充完整原件读取完成', (status) => {
    const f = fixture();
    const transmissionId = f.store.beginAiTransmission({ guard: f.guard, documentId: f.documentIds[0]!, stage: 'extract' });
    if (status !== 'sending') f.store.finishAiTransmission(transmissionId, status as 'acknowledged' | 'unknown');
    f.store.updateJobStage(f.jobId, 'analyze');
    expect(f.store.getJobReadingDocumentIds(f.jobId)).toEqual(new Set());
  });

  it('综合传输与另一任务的读取完成不能证明本任务重读，查询不改任务进度', () => {
    const f = fixture('analyze');
    const other = fixture();
    const own = f.store.beginAiTransmission({ guard: f.guard, documentId: f.documentIds[0]!, stage: 'analyze' });
    f.store.finishAiTransmission(own, 'completed');
    const foreign = other.store.beginAiTransmission({ guard: other.guard, documentId: other.documentIds[0]!, stage: 'extract' });
    other.store.finishAiTransmission(foreign, 'completed');
    const before = f.store.listStoredJobs();
    expect(f.store.getJobReadingDocumentIds(f.jobId)).toEqual(new Set());
    expect(f.store.getJobReadingDocumentIds(f.jobId)).toEqual(new Set());
    expect(f.store.listStoredJobs()).toEqual(before);
  });

  it('未知任务明确拒绝，不能返回泛化范围', () => {
    const f = fixture();
    expect(() => f.store.getJobReadingDocumentIds('synthetic-unknown-job')).toThrow('JOB_NOT_FOUND');
  });

  it('本地容量失败提示保留范围，不误称网络中断或已经生成识别断点', () => {
    const f = fixture();
    f.store.finishJobAttempt({ attemptId: f.guard.attemptId, status: 'failed', errorCode: 'DIRECT_ORIGINAL_CONTEXT_LIMIT_EXCEEDED' });
    f.store.finishJob(f.jobId, 'failed');
    const statusText = f.store.listStoredJobs().find((job) => job.id === f.jobId)!.statusText;
    expect(statusText).toBe('完整请求超过本次容量；原件和已有结果已保留，未拆分或删减');
    expect(statusText).not.toContain('网络');
    expect(statusText).not.toContain('已识别');
    expect(f.store.getJobProcessedDocumentIds(f.jobId)).toEqual(new Set());
  });
});
