import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceStore } from './index.js';
import { normalizeAssessmentRejectionCodes } from './assessment-rejection-diagnostic.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const rootDirectory = mkdtempSync(join(tmpdir(), 'fhd-rejection-diagnostic-'));
  directories.push(rootDirectory);
  const store = new WorkspaceStore({ rootDirectory });
  const personId = store.createPerson({ displayName: '合成成员', relation: '本人' }).id;
  const source = store.putSourceObject({ bytes: Buffer.from('合成内容'), mediaType: 'text/plain', displayName: 'synthetic.txt' });
  const documentId = store.registerImportedDocument({ sourceObjectId: source.id, personId }).documentId;
  const consentId = store.createManualProcessingConsent({ documentIds: [documentId], personIds: [personId],
    accountFingerprint: 'synthetic-account', version: 1 });
  const jobId = store.createWaitingAuthBatch({ cutoff: new Date().toISOString(), initialStatus: 'queued', consentId,
    groups: [{ personId, documentIds: [documentId], inputSignature: 'synthetic-job' }] }).jobIds[0]!;
  store.claimNextQueuedJob('synthetic-runner', 'synthetic-account');
  const attemptId = store.startJobAttempt(jobId, 'synthetic-runtime');
  const input = { guard: { jobId, attemptId, consentId, accountFingerprint: 'synthetic-account' }, documentId,
    inputSignature: 'a'.repeat(64), version: 1 as const, reasonCodes: ['unknown_claim' as const],
    actualModelCalls: 2, repairAttemptCount: 1, focusedTargetCount: 4 };
  const rows = () => {
    const db = new Database(store.databasePath, { readonly: true });
    try { return db.prepare("SELECT summary FROM audit_events WHERE event_type='assessment_rejected'").all() as { summary: string }[]; }
    finally { db.close(); }
  };
  return { store, input, rows };
}

describe('综合未发布的固定原因持久审计', () => {
  it('原因码去除目标及自由内容，未知错误不进入审计', () => {
    expect(normalizeAssessmentRejectionCodes(['unknown_claim:private-id:private-detail',
      'unknown_claim:another-id,FOCUSED_REVIEW_COVERAGE_MISMATCH', 'private error at https://private.test']))
      .toEqual(['unknown_claim', 'FOCUSED_REVIEW_COVERAGE_MISMATCH', 'unknown_validation_issue']);
  });
  it.each(['MEMBER_ASSESSMENT_SCHEMA_INVALID', 'MEMBER_ASSESSMENT_REVIEW_AUDIT_INVALID',
    'MEMBER_ASSESSMENT_HELD_OR_DUPLICATE_NODE', 'MEMBER_ASSESSMENT_REFERENCE_INVALID',
    'MEMBER_ASSESSMENT_REVIEW_AUDIT_EVIDENCE_MISMATCH'])('%s保留固定分类，不降成未知错误且终态后可追溯', (code) => {
    const f = fixture();
    try {
      const reasonCodes = normalizeAssessmentRejectionCodes([code]);
      expect(reasonCodes).toEqual([code]);
      f.store.saveAssessmentRejectionDiagnostic({ ...f.input, reasonCodes });
      f.store.finishJob(f.input.guard.jobId, 'completed_with_issues');
      f.store.finishJobAttempt({ attemptId: f.input.guard.attemptId, status: 'completed_with_issues' });
      expect(JSON.parse(f.rows()[0]!.summary).reasonCodes).toEqual([code]);
    } finally { f.store.close(); }
  });
  it('终态清理检查点后仍保留固定原因，同次重复调用只写一次', () => {
    const f = fixture();
    try {
      f.store.saveAssessmentRejectionDiagnostic(f.input);
      f.store.saveAssessmentRejectionDiagnostic(f.input);
      f.store.finishJob(f.input.guard.jobId, 'completed_with_issues');
      f.store.finishJobAttempt({ attemptId: f.input.guard.attemptId, status: 'completed_with_issues' });
      expect(f.rows()).toHaveLength(1);
      const { guard, documentId: _documentId, ...diagnostic } = f.input;
      expect(JSON.parse(f.rows()[0]!.summary)).toEqual({ ...diagnostic, attemptId: guard.attemptId });
    } finally { f.store.close(); }
  });
  it.each(['revoked', 'cancelled', 'other_attempt', 'other_document'] as const)('%s不得写审计', (mutation) => {
    const f = fixture();
    try {
      if (mutation === 'revoked') f.store.revokeConsent(f.input.guard.consentId);
      if (mutation === 'cancelled') f.store.requestJobCancellation(f.input.guard.jobId);
      if (mutation === 'other_attempt') f.input.guard.attemptId = 'not-this-attempt';
      if (mutation === 'other_document') f.input.documentId = 'not-this-document';
      expect(() => f.store.saveAssessmentRejectionDiagnostic(f.input)).toThrow();
      expect(f.rows()).toEqual([]);
    } finally { f.store.close(); }
  });
  it('自由正文、未知码和超范围计数不能写入', () => {
    const f = fixture();
    try {
      for (const extra of [{ detail: 'private text' }, { url: 'https://private.test' },
        { reasonCodes: ['unknown_claim:private-id'] }, { actualModelCalls: -1 }, { focusedTargetCount: 10001 }]) {
        expect(() => f.store.saveAssessmentRejectionDiagnostic({ ...f.input, ...extra } as typeof f.input)).toThrow();
      }
      expect(f.rows()).toEqual([]);
    } finally { f.store.close(); }
  });
});
