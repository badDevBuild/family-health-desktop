import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceStore } from './index.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const rootDirectory = mkdtempSync(join(tmpdir(), 'fhd-knowledge-diagnostic-'));
  directories.push(rootDirectory);
  const store = new WorkspaceStore({ rootDirectory });
  const personId = store.createPerson({ displayName: '合成成员', relation: '本人' }).id;
  const source = store.putSourceObject({ bytes: Buffer.from('合成内容'), mediaType: 'text/plain', displayName: 'synthetic.txt' });
  const documentId = store.registerImportedDocument({ sourceObjectId: source.id, personId }).documentId;
  const consentId = store.createManualProcessingConsent({ documentIds: [documentId], personIds: [personId],
    accountFingerprint: 'synthetic-account', version: 1 });
  const jobId = store.createWaitingAuthBatch({ cutoff: new Date().toISOString(), initialStatus: 'queued', consentId,
    groups: [{ personId, documentIds: [documentId], inputSignature: 'synthetic-job' }] }).jobIds[0]!;
  expect(store.claimNextQueuedJob('synthetic-runner', 'synthetic-account')?.id).toBe(jobId);
  const attemptId = store.startJobAttempt(jobId, 'synthetic-runtime');
  const input = { guard: { jobId, attemptId, consentId, accountFingerprint: 'synthetic-account' }, documentId,
    inputSignature: 'a'.repeat(64), retrievalVersion: 'official-https-content-v1' as const,
    outcomes: [{ sourceKey: 'b'.repeat(64), status: 'failed' as const, code: 'timed_out' as const,
      checkedAt: '2026-09-22T00:00:00.000Z' }] };
  const rows = () => {
    const db = new Database(store.databasePath, { readonly: true });
    try { return db.prepare("SELECT summary FROM audit_events WHERE event_type='assessment_knowledge_retrieval'").all() as { summary: string }[]; }
    finally { db.close(); }
  };
  return { store, input, rows };
}

describe('知识读取诊断持久化', () => {
  it('代理兼容读取保留固定技术原因，旧诊断版本继续可读', () => {
    const f = fixture();
    try {
      f.store.saveAssessmentKnowledgeRetrievalDiagnostic({ ...f.input, retrievalVersion: 'official-https-content-v2',
        outcomes: [{ ...f.input.outcomes[0]!, code: 'proxy_unsupported' }] });
      expect(JSON.parse(f.rows()[0]!.summary)).toMatchObject({ retrievalVersion: 'official-https-content-v2',
        outcomes: [expect.objectContaining({ code: 'proxy_unsupported' })] });
    } finally { f.store.close(); }
  });

  it('终态清理回包后仍保留技术原因，同次重复回执不增殖', () => {
    const f = fixture();
    try {
      f.store.saveAssessmentKnowledgeRetrievalDiagnostic(f.input);
      f.store.saveAssessmentKnowledgeRetrievalDiagnostic({ ...f.input,
        outcomes: [{ ...f.input.outcomes[0]!, checkedAt: '2026-09-22T00:01:00.000Z' }] });
      f.store.saveAssessmentTurnCheckpoint({ ...f.input, signature: 'synthetic-turn', output: { synthetic: true } });
      f.store.finishJob(f.input.guard.jobId, 'completed_with_issues');
      f.store.finishJobAttempt({ attemptId: f.input.guard.attemptId, status: 'completed_with_issues' });
      expect(f.rows()).toHaveLength(1);
      expect(JSON.parse(f.rows()[0]!.summary)).toEqual({ inputSignature: f.input.inputSignature,
        retrievalVersion: f.input.retrievalVersion, outcomes: f.input.outcomes, attemptId: f.input.guard.attemptId });
    } finally { f.store.close(); }
  });

  it.each(['cancelled', 'revoked', 'foreign_document', 'stale_attempt'] as const)('%s不能写入诊断', (caseName) => {
    const f = fixture();
    try {
      if (caseName === 'cancelled') f.store.requestJobCancellation(f.input.guard.jobId);
      if (caseName === 'revoked') f.store.revokeConsent(f.input.guard.consentId);
      if (caseName === 'foreign_document') f.input.documentId = 'another-document';
      if (caseName === 'stale_attempt') f.input.guard.attemptId = 'old-attempt';
      expect(() => f.store.saveAssessmentKnowledgeRetrievalDiagnostic(f.input)).toThrow();
      expect(f.rows()).toEqual([]);
    } finally { f.store.close(); }
  });

  it('任意URL、正文、错误信息和状态伪装不能写进固定诊断结构', () => {
    const f = fixture();
    try {
      for (const extra of [{ detail: 'private text' }, { url: 'https://example.test/private' },
        { code: 'network error: private' }, { sourceKey: 'private name' }, { status: 'retrieved' }]) {
        const malformed = { ...f.input, outcomes: [{ ...f.input.outcomes[0]!, ...extra }] };
        expect(() => f.store.saveAssessmentKnowledgeRetrievalDiagnostic(malformed as typeof f.input)).toThrow();
      }
      expect(f.rows()).toEqual([]);
    } finally { f.store.close(); }
  });
});
