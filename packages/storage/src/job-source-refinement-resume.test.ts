import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceStore } from './index.js';

describe('来源证明断点的恢复调度提示', () => {
  it('仅当前有效执行可读取当前授权的提示，初读断点不被误认成待提交证明', () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-proof-resume-'));
    const store = new WorkspaceStore({ rootDirectory: root, now: () => new Date('2026-10-18T00:00:00Z') });
    try {
      const person = store.createPerson({ displayName: '合成成员', relation: '本人' });
      const ids = [1, 2].map((index) => {
        const source = store.putSourceObject({ bytes: Buffer.from(`合成来源 ${index}`), mediaType: 'text/plain', displayName: `合成${index}.txt` });
        return store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id }).documentId;
      });
      const consentId = store.createManualProcessingConsent({ documentIds: ids, personIds: [person.id],
        accountFingerprint: 'synthetic-account', version: 1 });
      const jobId = store.createWaitingAuthBatch({ cutoff: '2026-10-18T00:00:00Z', initialStatus: 'queued', consentId,
        groups: [{ personId: person.id, documentIds: ids, inputSignature: 'synthetic-proof-resume' }] }).jobIds[0]!;
      store.claimNextQueuedJob('synthetic-runner', 'synthetic-account');
      const attemptId = store.startJobAttempt(jobId, 'synthetic-runtime', 'gpt-6.1-sol', 'medium');
      const guard = { jobId, attemptId, consentId, accountFingerprint: 'synthetic-account' };
      for (const [index, documentId] of ids.entries()) store.saveExtractionChunkCheckpoint({ guard, documentId,
        signature: `synthetic-signature-${index}`, chunkIndex: 0, threadId: 'synthetic-thread', turnId: 'synthetic-turn',
        extractionTurnId: 'synthetic-extraction', output: { checkpointKind: 'direct_original_reading',
          ...(index === 1 ? { sourceRefinementReview: { schedulingHintOnly: true } } : {}) } });
      expect(store.getJobSourceRefinementResumeDocumentIds(guard)).toEqual([ids[1]]);
      // 任意提示本身都不能接纳医疗数据，正式处理仍须验证完整原件与证明。
      expect(store.listAcceptedObservations(person.id)).toHaveLength(0);
      expect(() => store.getJobSourceRefinementResumeDocumentIds({ ...guard, accountFingerprint: 'other-account' })).toThrow();
      store.revokeConsent(consentId);
      expect(() => store.getJobSourceRefinementResumeDocumentIds(guard)).toThrow();
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
