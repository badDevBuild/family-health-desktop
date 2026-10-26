import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceStore } from './index.js';

const fixtures: Array<{ directory: string; stores: WorkspaceStore[] }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) {
    for (const store of fixture.stores) store.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'family-health-member-lease-'));
  let clock = new Date('2026-09-22T00:00:00Z').getTime();
  const store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date(clock) });
  const registration = { directory, stores: [store] }; fixtures.push(registration);
  const first = store.createPerson({ displayName: '合成甲' });
  const second = store.createPerson({ displayName: '合成乙' });
  const groups = [first, first, second].map((person, index) => {
    const source = store.putSourceObject({ bytes: Buffer.from(`合成并行资料${index}`),
      mediaType: 'text/plain', displayName: `合成资料${index}.txt` });
    const documentId = store.registerImportedDocument({ personId: person.id, sourceObjectId: source.id }).documentId;
    return { personId: person.id, documentIds: [documentId], inputSignature: `synthetic-member-lease-${index}` };
  });
  const consentId = store.createManualProcessingConsent({ documentIds: groups.flatMap((group) => group.documentIds),
    personIds: [first.id, second.id], accountFingerprint: 'synthetic-account', version: 1 });
  for (const group of groups) {
    clock += 1;
    store.createWaitingAuthBatch({ cutoff: new Date(clock).toISOString(), initialStatus: 'queued', consentId, groups: [group] });
  }
  const other = new WorkspaceStore({ rootDirectory: directory, now: () => new Date(clock) }); registration.stores.push(other);
  return { store, other, consentId };
}

describe('同成员跨任务的原子执行门', () => {
  it('不同连接可领取另一位成员，但不能在同成员运行时另领第二个任务', () => {
    const { store, other } = fixture();
    const first = store.claimNextQueuedJob('worker-a', 'synthetic-account')!;
    const second = other.claimNextQueuedJob('worker-b', 'synthetic-account')!;
    expect(first).not.toBeNull(); expect(second).not.toBeNull();
    expect(first.personId).not.toBe(second.personId);
    expect(other.claimNextQueuedJob('worker-c', 'synthetic-account')).toBeNull();
    store.finishJob(first.id, 'succeeded');
    other.finishJob(second.id, 'succeeded');
    expect(other.claimNextQueuedJob('worker-c', 'synthetic-account')).not.toBeNull();
  });

  it('任务状态已结束但 attempt 尚未落定时仍不允许同成员并发', () => {
    const { store, other } = fixture();
    const first = store.claimNextQueuedJob('worker-a', 'synthetic-account')!;
    const attemptId = store.startJobAttempt(first.id, 'synthetic-runtime');
    store.finishJob(first.id, 'succeeded');
    const second = other.claimNextQueuedJob('worker-b', 'synthetic-account')!;
    expect(second.personId).not.toBe(first.personId);
    expect(other.claimNextQueuedJob('worker-c', 'synthetic-account')).toBeNull();
    store.finishJobAttempt({ attemptId, status: 'succeeded' });
    const resumed = other.claimNextQueuedJob('worker-c', 'synthetic-account')!;
    expect(resumed.personId).toBe(first.personId);
  });

  it('提取阶段交接原子保存完成记录和模型，优先领取仍待提取的资料而不新建任务', () => {
    const { store, other, consentId } = fixture();
    const job = store.claimNextQueuedJob('worker-a', 'synthetic-account')!;
    const attemptId = store.startJobAttempt(job.id, 'synthetic-runtime');
    const guard = { jobId: job.id, attemptId, consentId, accountFingerprint: 'synthetic-account' };
    const preferences = { modelId: 'gpt-6.1-sol', reasoningEffort: 'medium' as const };
    expect(store.shouldYieldMemberAssessment(guard)).toBe(true);
    expect(() => store.yieldMemberAssessment({ guard, analysisAiPreferences: preferences })).toThrow('JOB_EXTRACTION_PHASE_INCOMPLETE');
    expect(store.listStoredJobs().find((item) => item.id === job.id)?.status).toBe('running');
    store.markJobDocumentProcessed(job.id, job.documentIds[0]!, 'published', guard);
    store.updateJobProgress(job.id, 1);
    expect(store.yieldMemberAssessment({ guard, analysisAiPreferences: preferences })).toBe(true);
    expect(store.listStoredJobs().find((item) => item.id === job.id)).toMatchObject({ status: 'queued', stage: 'analyze', completedUnits: 1 });
    expect(store.getJobProcessedDocumentIds(job.id)).toEqual(new Set(job.documentIds));
    expect(store.listStoredJobs()).toHaveLength(3);
    const pendingOne = other.claimNextQueuedJob('worker-b', 'synthetic-account')!;
    expect(pendingOne.stage).toBe('extract'); expect(pendingOne.id).not.toBe(job.id); other.finishJob(pendingOne.id, 'succeeded');
    const pendingTwo = other.claimNextQueuedJob('worker-b', 'synthetic-account')!;
    expect(pendingTwo.stage).toBe('extract'); other.finishJob(pendingTwo.id, 'succeeded');
    const resumed = other.claimNextQueuedJob('worker-b', 'synthetic-account')!;
    expect(resumed).toMatchObject({ id: job.id, stage: 'analyze', phaseAnalysisAiPreferences: preferences, attemptCount: 2 });
    const resumedAttempt = other.startJobAttempt(job.id, 'synthetic-runtime');
    expect(other.shouldYieldMemberAssessment({ ...guard, attemptId: resumedAttempt })).toBe(false);
  });

  it.each(['pause', 'revoke', 'account', 'cancel'] as const)('交接不借 %s 状态下的旧排队资料延后当前综合', (mode) => {
    const { store, consentId } = fixture();
    const job = store.claimNextQueuedJob('worker-a', 'synthetic-account')!;
    const attemptId = store.startJobAttempt(job.id, 'synthetic-runtime');
    const guard = { jobId: job.id, attemptId, consentId, accountFingerprint: 'synthetic-account' };
    if (mode === 'pause') store.setQueuePaused(true);
    if (mode === 'revoke') store.revokeConsent(consentId);
    if (mode === 'cancel') for (const queued of store.listStoredJobs().filter((item) => item.status === 'queued')) store.requestJobCancellation(queued.id);
    if (mode === 'revoke') expect(() => store.shouldYieldMemberAssessment(guard)).toThrow();
    else if (mode === 'account') expect(() => store.shouldYieldMemberAssessment({ ...guard, accountFingerprint: 'other-account' })).toThrow();
    else expect(store.shouldYieldMemberAssessment(guard)).toBe(false);
  });

  it('阶段回执写满时事务回滚，不留下 queued 加未结束 attempt 的半交接', () => {
    const { store, consentId } = fixture();
    const job = store.claimNextQueuedJob('worker-a', 'synthetic-account')!;
    const attemptId = store.startJobAttempt(job.id, 'synthetic-runtime');
    const guard = { jobId: job.id, attemptId, consentId, accountFingerprint: 'synthetic-account' };
    store.markJobDocumentProcessed(job.id, job.documentIds[0]!, 'published', guard); store.updateJobProgress(job.id, 1);
    const write = vi.spyOn(store, 'finishJobAttempt').mockImplementationOnce(() => { throw new Error('LOCAL_STORAGE_FULL'); });
    const input = { guard, analysisAiPreferences: { modelId: 'gpt-6.1-sol', reasoningEffort: 'medium' as const } };
    expect(() => store.yieldMemberAssessment(input)).toThrow('LOCAL_STORAGE_FULL');
    expect(store.listStoredJobs().find((item) => item.id === job.id)).toMatchObject({ status: 'running', stage: 'extract', completedUnits: 1 });
    expect(store.shouldYieldMemberAssessment(guard)).toBe(true);
    write.mockRestore(); expect(store.yieldMemberAssessment(input)).toBe(true);
  });
});
