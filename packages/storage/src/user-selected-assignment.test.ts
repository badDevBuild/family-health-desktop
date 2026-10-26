import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceStore } from './index.js';

const roots: string[] = [];
const stores: WorkspaceStore[] = [];
const now = '2026-10-19T00:00:00Z';

function fixture() {
  const rootDirectory = mkdtempSync(join(tmpdir(), 'family-health-selected-assignment-'));
  roots.push(rootDirectory);
  const store = new WorkspaceStore({ rootDirectory, now: () => new Date(now) });
  stores.push(store);
  const first = store.createPerson({ displayName: '合成成员甲' });
  const second = store.createPerson({ displayName: '合成成员乙' });
  const source = store.putSourceObject({ bytes: Buffer.from('纯合成上传原件'), mediaType: 'text/plain', displayName: '合成报告.txt' });
  return { store, first, second, source };
}

function databaseRead<T>(store: WorkspaceStore, read: (database: Database.Database) => T): T {
  const database = new Database(store.databasePath, { readonly: true });
  try { return read(database); } finally { database.close(); }
}

function setBasis(store: WorkspaceStore, documentId: string, basis: 'legacy' | 'identity_confirmed') {
  const database = new Database(store.databasePath);
  try {
    database.prepare('UPDATE documents SET person_assignment_basis = ?, confirmed_reported_name = ? WHERE id = ?')
      .run(basis, basis === 'identity_confirmed' ? '合成别名' : null, documentId);
  } finally { database.close(); }
}

function publishSyntheticFact(store: WorkspaceStore, source: ReturnType<WorkspaceStore['putSourceObject']>, personId: string, documentId: string) {
  const sourceSpanId = randomUUID();
  const quote = '合成项目甲 5 mmol/L';
  store.saveSourceManifest({ id: randomUUID(), sourceObjectId: source.id, sha256: source.sha256, mediaType: 'text/plain',
    originalDisplayName: '合成报告.txt', totalUnits: 1, coveredUnitIndexes: [0], normalizerVersion: 'synthetic',
    conversionWarnings: [], createdAt: now, spans: [{ id: sourceSpanId, documentId, spanKind: 'line', page: null,
      blockId: null, lineStart: 1, lineEnd: 1, quote, readability: 'clear' }] });
  const acceptanceId = store.saveAcceptanceDecision({ method: 'auto', actor: 'policy', rulesVersion: 'synthetic',
    inputSignature: randomUUID(), outputHash: randomUUID(), reviewRef: null, decision: 'accept' });
  store.publishFacts({ personId, documentId, expectedRevision: store.getFactRevision(personId), documentCommitKey: randomUUID(),
    changeSetHash: randomUUID(), summary: '纯合成事实', observations: [{ conceptKey: '合成项目甲', originalName: '合成项目甲',
      modelStandardNameCandidate: null, rawText: '5', valueKind: 'numeric', decimalValue: '5', qualifier: 'eq', unit: 'mmol/L',
      referenceRange: null, clinicalDate: null, abnormalFlag: 'unknown', documentId, sourceSpanId, acceptanceId,
      specimen: null, method: null, bodySite: null, evidence: [{ sourceSpanId, quote }] }] });
}

function createJob(store: WorkspaceStore, personId: string, documentIds: string[]) {
  const consentId = store.createManualProcessingConsent({ personIds: [personId], documentIds, accountFingerprint: 'synthetic-account', version: 1 });
  return store.createWaitingAuthBatch({ cutoff: now, consentId, initialStatus: 'queued',
    groups: [{ personId, documentIds, inputSignature: randomUUID() }] }).jobIds[0]!;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('上传时明确选择的成员归属', () => {
  it('同源跨成员显式上传创建独立文档，不借用旧身份确认，不迁移或改写已有事实', () => {
    const { store, first, second, source } = fixture();
    const original = store.registerImportedDocument({ sourceObjectId: source.id, personId: first.id, assignmentBasis: 'user_selected' });
    setBasis(store, original.documentId, 'identity_confirmed');
    publishSyntheticFact(store, source, first.id, original.documentId);
    const before = store.listAcceptedObservations(first.id);
    const revision = store.getFactRevision(first.id);
    const selected = store.registerImportedDocument({ sourceObjectId: source.id, personId: second.id, assignmentBasis: 'user_selected' });
    expect(selected).toMatchObject({ status: 'queued', duplicate: false });
    expect(selected.documentId).not.toBe(original.documentId);
    const rows = databaseRead(store, (database) => database.prepare(`SELECT id, person_id, person_assignment_basis, confirmed_reported_name, status
      FROM documents ORDER BY person_id`).all());
    expect(rows).toEqual(expect.arrayContaining([
      { id: original.documentId, person_id: first.id, person_assignment_basis: 'identity_confirmed', confirmed_reported_name: '合成别名', status: 'completed' },
      { id: selected.documentId, person_id: second.id, person_assignment_basis: 'user_selected', confirmed_reported_name: null, status: 'queued' }
    ]));
    expect(store.listAcceptedObservations(first.id)).toEqual(before);
    expect(store.getFactRevision(first.id)).toBe(revision);
    expect(store.listAcceptedObservations(second.id)).toEqual([]);
    expect(store.listOpenExtractionReviewIssues()).toEqual([]);
    expect(store.registerImportedDocument({ sourceObjectId: source.id, personId: second.id, assignmentBasis: 'user_selected' }))
      .toEqual({ documentId: selected.documentId, status: 'duplicate', duplicate: true });
  });

  it.each(['folder_binding', 'legacy'] as const)('同成员再次显式上传将 %s 升级为用户归属，仅留一次审计而不重跑', (basis) => {
    const { store, first, source } = fixture();
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: first.id, assignmentBasis: 'folder_binding' });
    if (basis === 'legacy') setBasis(store, document.documentId, basis);
    publishSyntheticFact(store, source, first.id, document.documentId);
    const before = store.listAcceptedObservations(first.id);
    const revision = store.getFactRevision(first.id);
    for (let count = 0; count < 2; count += 1) expect(store.registerImportedDocument({
      sourceObjectId: source.id, personId: first.id, assignmentBasis: 'user_selected'
    })).toEqual({ documentId: document.documentId, status: 'duplicate', duplicate: true });
    expect(databaseRead(store, (database) => database.prepare(`SELECT person_assignment_basis, status FROM documents WHERE id = ?`)
      .get(document.documentId))).toEqual({ person_assignment_basis: 'user_selected', status: 'completed' });
    expect(databaseRead(store, (database) => database.prepare(`SELECT COUNT(*) AS n FROM audit_events
      WHERE event_type = 'document.user_assignment_selected' AND entity_id = ?`).get(document.documentId))).toEqual({ n: 1 });
    expect(store.listAcceptedObservations(first.id)).toEqual(before);
    expect(store.getFactRevision(first.id)).toBe(revision);
  });

  it('目录扫描继续尊重已有身份确认，未经显式选择的跨成员来源仍不自动归属', () => {
    const { store, first, second, source } = fixture();
    const original = store.registerImportedDocument({ sourceObjectId: source.id, personId: first.id, assignmentBasis: 'folder_binding' });
    const unassigned = store.registerImportedDocument({ sourceObjectId: source.id, personId: second.id, assignmentBasis: 'folder_binding' });
    expect(unassigned).toMatchObject({ status: 'needs_review', duplicate: false });
    expect(databaseRead(store, (database) => database.prepare('SELECT person_id FROM documents WHERE id = ?')
      .get(unassigned.documentId))).toEqual({ person_id: null });
    setBasis(store, original.documentId, 'identity_confirmed');
    expect(store.registerImportedDocument({ sourceObjectId: source.id, personId: second.id, assignmentBasis: 'folder_binding' }))
      .toEqual({ documentId: original.documentId, status: 'duplicate', duplicate: true });
    expect(store.registerImportedDocument({ sourceObjectId: source.id, personId: null }))
      .toEqual({ documentId: original.documentId, status: 'duplicate', duplicate: true });
  });

  it('同源已有多位成员的显式归属后，目录重扫按目标成员精确去重', () => {
    const { store, first, second, source } = fixture();
    const firstDocument = store.registerImportedDocument({ sourceObjectId: source.id, personId: first.id, assignmentBasis: 'user_selected' });
    setBasis(store, firstDocument.documentId, 'identity_confirmed');
    const secondDocument = store.registerImportedDocument({ sourceObjectId: source.id, personId: second.id, assignmentBasis: 'user_selected' });
    expect(store.registerImportedDocument({ sourceObjectId: source.id, personId: second.id, assignmentBasis: 'folder_binding' }))
      .toEqual({ documentId: secondDocument.documentId, status: 'duplicate', duplicate: true });
    expect(store.registerImportedDocument({ sourceObjectId: source.id, personId: first.id, assignmentBasis: 'folder_binding' }))
      .toEqual({ documentId: firstDocument.documentId, status: 'duplicate', duplicate: true });
    expect(store.listImportedDocuments()).toHaveLength(2);
    expect(store.listOpenExtractionReviewIssues()).toEqual([]);
  });

  it('移出分析的原件不会因显式重传而被唤醒，删除抑制仍在导入前生效', () => {
    const { store, first, second, source } = fixture();
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: first.id, assignmentBasis: 'user_selected' });
    store.setDocumentIncluded({ documentId: document.documentId, included: false });
    expect(store.registerImportedDocument({ sourceObjectId: source.id, personId: second.id, assignmentBasis: 'user_selected' }))
      .toEqual({ documentId: document.documentId, status: 'duplicate', duplicate: true });
    expect(store.listImportedDocuments()).toHaveLength(1);
    store.deleteDocument({ documentId: document.documentId, retainedByRecoveryPoint: false });
    expect(store.isSourceImportSuppressed(source.sha256)).toBe(true);
    expect(store.listImportedDocuments()).toEqual([]);
  });

  it('其他成员已有身份确认时也不能绕过同源的移出分析抑制', () => {
    const { store, first, second, source } = fixture();
    const original = store.registerImportedDocument({ sourceObjectId: source.id, personId: first.id, assignmentBasis: 'user_selected' });
    setBasis(store, original.documentId, 'identity_confirmed');
    const removed = store.registerImportedDocument({ sourceObjectId: source.id, personId: second.id, assignmentBasis: 'user_selected' });
    store.setDocumentIncluded({ documentId: removed.documentId, included: false });
    const third = store.createPerson({ displayName: '合成成员丙' });
    expect(store.registerImportedDocument({ sourceObjectId: source.id, personId: third.id, assignmentBasis: 'user_selected' }))
      .toEqual({ documentId: removed.documentId, status: 'duplicate', duplicate: true });
    expect(store.listImportedDocuments()).toHaveLength(2);
  });
});

describe('用户选择归属后的非阻断姓名说明', () => {
  it('同一任务同一原因幂等，不创建核对事项或改动报告、事实及版本', () => {
    const { store, first, source } = fixture();
    const { documentId } = store.registerImportedDocument({ sourceObjectId: source.id, personId: first.id, assignmentBasis: 'user_selected' });
    publishSyntheticFact(store, source, first.id, documentId);
    const jobId = createJob(store, first.id, [documentId]);
    const observations = store.listAcceptedObservations(first.id);
    const revision = store.getFactRevision(first.id);
    const documentBefore = databaseRead(store, (database) => database.prepare('SELECT * FROM documents WHERE id = ?').get(documentId));
    for (let count = 0; count < 2; count += 1) store.recordUserAssignedSubjectNotice({ documentId, jobId, reason: 'name_mismatch' });
    store.recordUserAssignedSubjectNotice({ documentId, jobId, reason: 'subject_unproven' });
    const nextJobId = createJob(store, first.id, [documentId]);
    store.recordUserAssignedSubjectNotice({ documentId, jobId: nextJobId, reason: 'name_mismatch' });
    const events = databaseRead(store, (database) => database.prepare(`SELECT event_type, entity_id, summary FROM audit_events
      WHERE event_type = 'document.user_assigned_subject_notice' ORDER BY summary`).all());
    expect(events).toHaveLength(3);
    expect(events.every((event) => (event as { entity_id: string }).entity_id === documentId)).toBe(true);
    expect(JSON.stringify(events)).not.toContain('合成成员甲');
    expect(store.listOpenExtractionReviewIssues()).toEqual([]);
    expect(databaseRead(store, (database) => database.prepare('SELECT * FROM documents WHERE id = ?').get(documentId))).toEqual(documentBefore);
    expect(store.listAcceptedObservations(first.id)).toEqual(observations);
    expect(store.getFactRevision(first.id)).toBe(revision);
  });

  it('允许既有身份确认，但拒绝非用户归属、其他成员任务和不在任务范围内的文档', () => {
    const { store, first, second, source } = fixture();
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: first.id, assignmentBasis: 'folder_binding' });
    const jobId = createJob(store, first.id, [document.documentId]);
    expect(() => store.recordUserAssignedSubjectNotice({ documentId: document.documentId, jobId, reason: 'name_mismatch' }))
      .toThrow('DOCUMENT_USER_ASSIGNMENT_REQUIRED');
    setBasis(store, document.documentId, 'identity_confirmed');
    expect(() => store.recordUserAssignedSubjectNotice({ documentId: document.documentId, jobId, reason: 'subject_unproven' })).not.toThrow();
    const otherSource = store.putSourceObject({ bytes: Buffer.from('其他纯合成来源'), mediaType: 'text/plain', displayName: '其他.txt' });
    const otherDocument = store.registerImportedDocument({ sourceObjectId: otherSource.id, personId: first.id, assignmentBasis: 'user_selected' });
    expect(() => store.recordUserAssignedSubjectNotice({ documentId: otherDocument.documentId, jobId, reason: 'name_mismatch' }))
      .toThrow('DOCUMENT_OUTSIDE_JOB_SCOPE');
    const secondDocument = store.registerImportedDocument({ sourceObjectId: source.id, personId: second.id, assignmentBasis: 'user_selected' });
    const otherJobId = createJob(store, second.id, [secondDocument.documentId]);
    expect(() => store.recordUserAssignedSubjectNotice({ documentId: document.documentId, jobId: otherJobId, reason: 'name_mismatch' }))
      .toThrow('DOCUMENT_OUTSIDE_JOB_SCOPE');
    expect(databaseRead(store, (database) => database.prepare(`SELECT COUNT(*) AS n FROM audit_events
      WHERE event_type = 'document.user_assigned_subject_notice'`).get())).toEqual({ n: 1 });
    expect(store.listOpenExtractionReviewIssues()).toEqual([]);
  });
});
