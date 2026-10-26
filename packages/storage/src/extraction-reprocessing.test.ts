import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { ObservationCandidate, ReportMetadataCandidate, SourceManifest } from '@contracts';
import { WorkspaceStore, WORKSPACE_SCHEMA_VERSION, type AppendCommittedFactsInput } from './index.js';

const stores = new Set<WorkspaceStore>();
const roots: string[] = [];
const accountFingerprint = 'synthetic-reprocessing-account';

function makeStore() {
  const rootDirectory = mkdtempSync(join(tmpdir(), 'family-health-reprocessing-'));
  roots.push(rootDirectory);
  const store = new WorkspaceStore({ rootDirectory, now: () => new Date('2026-10-13T00:00:00Z') });
  stores.add(store);
  return store;
}

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function documentFixture(store: WorkspaceStore, personId: string, marker: string) {
  const quote = `2026-01-10 合成项目${marker} 5 mmol/L`;
  const source = store.putSourceObject({ bytes: Buffer.from(`合成原件${marker}`), mediaType: 'image/png', displayName: `合成${marker}.png` });
  const { documentId } = store.registerImportedDocument({ sourceObjectId: source.id, personId });
  const manifest: SourceManifest = {
    id: randomUUID(), sourceObjectId: source.id, sha256: source.sha256, mediaType: 'image/png',
    originalDisplayName: `合成${marker}.png`, totalUnits: 1, coveredUnitIndexes: [0],
    normalizerVersion: 'local-visual-evidence-v1', conversionWarnings: [], createdAt: '2026-10-13T00:00:00Z',
    spans: [{ id: randomUUID(), documentId, spanKind: 'image', page: 1, blockId: null,
      lineStart: null, lineEnd: null, quote, readability: 'clear' }]
  };
  store.saveSourceManifest(manifest);
  return { documentId, manifest };
}

function commitFixture(store: WorkspaceStore, personId: string, fixture: ReturnType<typeof documentFixture>) {
  const acceptanceId = store.saveAcceptanceDecision({ method: 'auto', actor: 'policy', rulesVersion: 'synthetic',
    inputSignature: randomUUID(), outputHash: randomUUID(), reviewRef: null, decision: 'accept' });
  const span = fixture.manifest.spans[0]!;
  store.publishFacts({ personId, documentId: fixture.documentId, documentCommitKey: randomUUID(),
    expectedRevision: store.getFactRevision(personId), changeSetHash: randomUUID(), summary: '合成事实',
    observations: [{ conceptKey: '合成项目', originalName: '合成项目', modelStandardNameCandidate: null,
      rawText: '5', valueKind: 'numeric', decimalValue: '5', qualifier: 'eq', unit: 'mmol/L',
      referenceRange: null, clinicalDate: '2026-01-10', abnormalFlag: 'unknown',
      documentId: fixture.documentId, sourceSpanId: span.id, acceptanceId, specimen: null, method: null, bodySite: null,
      evidence: [{ sourceSpanId: span.id, quote: span.quote }] }] });
}

function finishedReviewBatch(store: WorkspaceStore) {
  const person = store.createPerson({ displayName: '合成成员' });
  const documents = ['甲', '乙', '丙'].map((marker) => documentFixture(store, person.id, marker));
  const consentId = store.createManualProcessingConsent({ documentIds: documents.map((doc) => doc.documentId),
    personIds: [person.id], accountFingerprint, version: 1 });
  const batch = store.createWaitingAuthBatch({ cutoff: '2026-10-13T00:00:00Z', initialStatus: 'queued', consentId,
    groups: [{ personId: person.id, documentIds: documents.map((doc) => doc.documentId), inputSignature: 'synthetic-original-batch' }] });
  const job = store.claimNextQueuedJob('synthetic-runner', accountFingerprint)!;
  const attemptId = store.startJobAttempt(job.id, 'synthetic-runtime');
  commitFixture(store, person.id, documents[0]!);
  const issues = documents.map((doc, index) => store.saveExtractionReviewIssue({ documentId: doc.documentId,
    jobId: job.id, attemptId, stage: 'extract', kind: index === 0 ? 'field_conflict' : 'coverage_gap',
    severity: index === 0 ? 'warning' : 'blocking', preserveDocumentStatus: index === 0,
    evidenceRefs: [doc.manifest.spans[0]!.id], reasonCodes: ['numeric_value_not_in_evidence'] }));
  store.updateJobProgress(job.id, documents.length);
  store.finishJobAttempt({ attemptId, status: 'waiting_user' });
  store.finishJob(job.id, 'waiting_user');
  return { person, documents, issues, batch, job, attemptId };
}

function repairInput(store: WorkspaceStore, fixture: ReturnType<typeof finishedReviewBatch>, ids = fixture.documents.slice(0, 2).map((doc) => doc.documentId)) {
  const consentId = store.createManualProcessingConsent({ documentIds: ids, personIds: [fixture.person.id], accountFingerprint, version: 2 });
  return { cutoff: '2026-10-13T00:00:00Z', initialStatus: 'queued' as const, consentId, repairDocumentIds: ids,
    groups: [{ personId: fixture.person.id, documentIds: ids, inputSignature: 'synthetic-new-prompt-batch' }] };
}

function finishedIdentityBatch(store: WorkspaceStore) {
  const person = store.createPerson({ displayName: '合成上传成员' });
  const documents = ['异名甲', '异名乙', '缺名丙'].map((marker) => documentFixture(store, person.id, marker));
  const consentId = store.createManualProcessingConsent({ documentIds: documents.map((doc) => doc.documentId),
    personIds: [person.id], accountFingerprint, version: 1 });
  const batch = store.createWaitingAuthBatch({ cutoff: '2026-10-13T00:00:00Z', initialStatus: 'queued', consentId,
    groups: [{ personId: person.id, documentIds: documents.map((doc) => doc.documentId), inputSignature: 'synthetic-old-identity-batch' }] });
  const job = store.claimNextQueuedJob('synthetic-identity-runner', accountFingerprint)!;
  const attemptId = store.startJobAttempt(job.id, 'synthetic-runtime');
  const issues = documents.map((doc, index) => store.saveExtractionReviewIssue({ documentId: doc.documentId,
    jobId: job.id, attemptId, stage: 'extract', kind: index === 2 ? 'coverage_gap' : 'person_conflict', severity: 'blocking',
    evidenceRefs: [], ...(index < 2 ? { reportedName: '合成不同姓名' } : {}),
    reasonCodes: [index === 2 ? 'DIRECT_ORIGINAL_IDENTITY_UNPROVEN' : 'PERSON_IDENTITY_NOT_CONFIRMED'] }));
  store.updateJobProgress(job.id, documents.length);
  store.finishJobAttempt({ attemptId, status: 'waiting_user' });
  store.finishJob(job.id, 'waiting_user');
  return { person, documents, issues, batch, job, attemptId };
}

describe('明确用户归属对旧姓名门禁的正常局部恢复', () => {
  it.each(['user_selected', 'identity_confirmed'])('%s 只替代选中资料的旧身份门禁，不确认姓名或修改原件与已有事实', (assignmentBasis) => {
    const store = makeStore();
    const fixture = finishedIdentityBatch(store);
    const completed = documentFixture(store, fixture.person.id, '已完成');
    commitFixture(store, fixture.person.id, completed);
    const beforeFacts = store.listAcceptedObservations(fixture.person.id);
    const beforeRevision = store.getFactRevision(fixture.person.id);
    const sourceBytes = fixture.documents.map((document) => readFileSync(store.getDocumentExtractionBundle(document.documentId).sourcePath));
    const database = new Database(store.databasePath);
    database.prepare('UPDATE documents SET person_assignment_basis=? WHERE person_id=?').run(assignmentBasis, fixture.person.id);
    const rawFacts = database.prepare('SELECT * FROM observations ORDER BY id').all();
    const selectedIds = [fixture.documents[0]!.documentId, fixture.documents[2]!.documentId];
    expect(store.listRepairableExtractionDocumentIds()).toEqual(new Set(fixture.documents.map((document) => document.documentId)));
    expect(store.listOpenExtractionReviewIssues()).toHaveLength(3);
    const input = repairInput(store, fixture, selectedIds);
    const created = store.createWaitingAuthBatch(input);
    expect(created.idempotent).toBe(false);
    expect(store.listStoredJobs().find((job) => job.id === fixture.job.id)?.status).toBe('completed_with_issues');
    expect(store.listOpenExtractionReviewIssues()).toEqual([expect.objectContaining({ id: fixture.issues[1] })]);
    expect(database.prepare('SELECT id,resolution_status FROM review_issues ORDER BY id').all()).toEqual(expect.arrayContaining([
      { id: fixture.issues[0], resolution_status: 'deferred' },
      { id: fixture.issues[1], resolution_status: 'open' },
      { id: fixture.issues[2], resolution_status: 'deferred' }
    ]));
    expect(database.prepare('SELECT COUNT(*) AS n FROM audit_events WHERE event_type=?')
      .get('document.user_assignment_review_superseded')).toEqual({ n: 2 });
    expect(database.prepare('SELECT COUNT(*) AS n FROM person_name_aliases').get()).toEqual({ n: 0 });
    expect(database.prepare('SELECT * FROM observations ORDER BY id').all()).toEqual(rawFacts);
    expect(store.listAcceptedObservations(fixture.person.id)).toEqual(beforeFacts);
    expect(store.getFactRevision(fixture.person.id)).toBe(beforeRevision);
    fixture.documents.forEach((document, index) => {
      expect(store.getDocumentExtractionBundle(document.documentId)).toMatchObject({
        personId: fixture.person.id, personAssignmentBasis: assignmentBasis, confirmedReportedName: null, confirmedPersonAliases: []
      });
      expect(readFileSync(store.getDocumentExtractionBundle(document.documentId).sourcePath)).toEqual(sourceBytes[index]);
    });
    expect(store.listImportedDocuments().filter((document) => selectedIds.includes(document.id)))
      .toEqual(expect.arrayContaining(selectedIds.map((id) => expect.objectContaining({ id, status: 'queued', personAssignmentBasis: assignmentBasis }))));
    expect(store.createWaitingAuthBatch(input)).toEqual({ ...created, idempotent: true });
    expect(database.prepare('SELECT COUNT(*) AS n FROM audit_events WHERE event_type=?')
      .get('document.user_assignment_review_superseded')).toEqual({ n: 2 });
    database.close();
  });

  it.each(['folder_binding', 'legacy', 'excluded', 'archived', 'candidate_diff', 'mixed_reason', 'unknown_identity',
    'medical_blocking', 'medical_diff', 'unknown_identity_warning', 'committed_identity_only', 'other_member_job', 'unclosed_attempt', 'incomplete_job'] as const)(
    '%s 不会借旧身份恢复关闭事项或改动资料', (change) => {
      const store = makeStore();
      const fixture = finishedIdentityBatch(store);
      const id = fixture.documents[0]!.documentId;
      const input = repairInput(store, fixture, [id]);
      const database = new Database(store.databasePath);
      if (change === 'folder_binding' || change === 'legacy') database.prepare('UPDATE documents SET person_assignment_basis=? WHERE id=?').run(change, id);
      if (change === 'excluded') database.prepare('UPDATE documents SET excluded_from_analysis=1 WHERE id=?').run(id);
      if (change === 'archived') database.prepare('UPDATE persons SET archived_at=? WHERE id=?').run('2026-10-13T00:00:00Z', fixture.person.id);
      if (change === 'candidate_diff' || change === 'mixed_reason' || change === 'unknown_identity') {
        const reasonCodes = change === 'mixed_reason' ? ['PERSON_IDENTITY_NOT_CONFIRMED', 'numeric_value_not_in_evidence']
          : change === 'unknown_identity' ? ['PERSON_OTHER_IDENTITY_REASON'] : ['PERSON_IDENTITY_NOT_CONFIRMED'];
        database.prepare('UPDATE review_issues SET payload_json=? WHERE id=?').run(JSON.stringify({ stage: 'extract', reasonCodes,
          ...(change === 'candidate_diff' ? { candidateDiffs: [{ localKey: 'synthetic', itemName: '合成项目', fields: ['value'] }] } : {}) }), fixture.issues[0]);
      }
      if (change === 'medical_blocking' || change === 'medical_diff') store.saveExtractionReviewIssue({ documentId: id,
        stage: 'extract', kind: 'field_conflict', severity: change === 'medical_diff' ? 'warning' : 'blocking', preserveDocumentStatus: true,
        evidenceRefs: [], reasonCodes: ['numeric_value_not_in_evidence'],
        ...(change === 'medical_diff' ? { candidateDiffs: [{ localKey: 'synthetic', itemName: '合成项目', fields: ['value'] }] } : {}) });
      if (change === 'unknown_identity_warning') store.saveExtractionReviewIssue({ documentId: id,
        stage: 'extract', kind: 'coverage_gap', severity: 'warning', preserveDocumentStatus: true,
        evidenceRefs: [], reasonCodes: ['PERSON_NEW_UNKNOWN'] });
      if (change === 'committed_identity_only') commitFixture(store, fixture.person.id, fixture.documents[0]!);
      if (change === 'other_member_job') {
        const other = store.createPerson({ displayName: '合成其他成员' });
        database.prepare('UPDATE jobs SET person_id=? WHERE id=?').run(other.id, fixture.job.id);
      }
      if (change === 'unclosed_attempt') database.prepare('UPDATE job_attempts SET finished_at=NULL WHERE id=?').run(fixture.attemptId);
      if (change === 'incomplete_job') store.updateJobProgress(fixture.job.id, 1);
      const before = database.prepare('SELECT * FROM review_issues ORDER BY id').all();
      expect(store.listRepairableExtractionDocumentIds().has(id)).toBe(false);
      expect(() => store.createWaitingAuthBatch(input)).toThrow('PROCESSING_REPAIR_STATE_CHANGED');
      expect(database.prepare('SELECT * FROM review_issues ORDER BY id').all()).toEqual(before);
      expect(store.listImportedDocuments().find((document) => document.id === id)?.status)
        .toBe(change === 'committed_identity_only' ? 'completed' : 'needs_review');
      expect(database.prepare('SELECT COUNT(*) AS n FROM person_name_aliases').get()).toEqual({ n: 0 });
      database.close();
    });

  it('排队提交失败会原子回滚旧事项和资料状态，不能只解除门禁而没有重读任务', () => {
    const store = makeStore();
    const fixture = finishedIdentityBatch(store);
    const id = fixture.documents[2]!.documentId;
    const input = repairInput(store, fixture, [id]);
    const database = new Database(store.databasePath);
    database.exec(`CREATE TRIGGER synthetic_repair_enqueue_failure BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT,'SYNTHETIC_ENQUEUE_FAILURE'); END;`);
    expect(() => store.createWaitingAuthBatch(input)).toThrow('SYNTHETIC_ENQUEUE_FAILURE');
    expect(store.listOpenExtractionReviewIssues().map((issue) => issue.id).sort()).toEqual([...fixture.issues].sort());
    expect(store.listImportedDocuments().find((document) => document.id === id)?.status).toBe('needs_review');
    expect(store.listStoredJobs().find((job) => job.id === fixture.job.id)?.status).toBe('waiting_user');
    expect(database.prepare('SELECT COUNT(*) AS n FROM audit_events WHERE event_type=?')
      .get('document.user_assignment_review_superseded')).toEqual({ n: 0 });
    database.close();
  });
});

describe('来源校验问题的明确局部重跑', () => {
  it('结束的 waiting_user 父任务不再恢复，明确选中资料建立新任务且保留旧事实和未选问题', () => {
    const store = makeStore();
    const fixture = finishedReviewBatch(store);
    expect(store.listRepairableExtractionDocumentIds()).toEqual(new Set(fixture.documents.map((doc) => doc.documentId)));
    const beforeFacts = store.listAcceptedObservations(fixture.person.id);
    const input = repairInput(store, fixture);
    const created = store.createWaitingAuthBatch(input);
    expect(created.idempotent).toBe(false);
    expect(created.jobIds).not.toContain(fixture.job.id);
    expect(store.listStoredJobs().find((job) => job.id === fixture.job.id)?.status).toBe('completed_with_issues');
    expect(store.listAcceptedObservations(fixture.person.id)).toEqual(beforeFacts);
    expect(store.listOpenExtractionReviewIssues().map((issue) => issue.id).sort())
      .toEqual([fixture.issues[0], fixture.issues[2]].sort());
    expect(store.listImportedDocuments().find((doc) => doc.id === fixture.documents[1]!.documentId)?.status).toBe('queued');
    expect(store.listImportedDocuments().find((doc) => doc.id === fixture.documents[2]!.documentId)?.status).toBe('needs_review');
    const database = new Database(store.databasePath, { readonly: true });
    try {
      expect(database.prepare(`SELECT resolution_status FROM review_issues WHERE id=?`).get(fixture.issues[1]))
        .toEqual({ resolution_status: 'deferred' });
      const row = database.prepare(`SELECT checkpoint_json FROM jobs WHERE id=?`).get(created.jobIds[0]) as { checkpoint_json: string };
      expect(JSON.parse(row.checkpoint_json)).toMatchObject({ documentIds: input.repairDocumentIds, completedUnits: 0, repairDocumentIds: input.repairDocumentIds });
    } finally { database.close(); }
    expect(store.createWaitingAuthBatch(input)).toEqual({ ...created, idempotent: true });
  });

  it.each(['queued', 'running', 'waiting_auth', 'waiting_quota', 'retry_wait'])('%s 活跃任务阻止修复选择，事务不会改旧状态', (status) => {
    const store = makeStore();
    const fixture = finishedReviewBatch(store);
    const input = repairInput(store, fixture);
    const database = new Database(store.databasePath);
    database.prepare(`UPDATE jobs SET status=? WHERE id=?`).run(status, fixture.job.id);
    database.close();
    expect(store.listRepairableExtractionDocumentIds().size).toBe(0);
    expect(() => store.createWaitingAuthBatch(input)).toThrow('PROCESSING_REPAIR_STATE_CHANGED');
    expect(store.listOpenExtractionReviewIssues()).toHaveLength(3);
  });

  it('任务状态已改但 attempt 尚未结束，或旧任务未走完全部资料时仍禁止重跑', () => {
    const store = makeStore();
    const fixture = finishedReviewBatch(store);
    const input = repairInput(store, fixture);
    const database = new Database(store.databasePath);
    database.prepare(`UPDATE job_attempts SET finished_at=NULL WHERE id=?`).run(fixture.attemptId);
    expect(store.listRepairableExtractionDocumentIds().size).toBe(0);
    expect(() => store.createWaitingAuthBatch(input)).toThrow('PROCESSING_REPAIR_STATE_CHANGED');
    database.prepare(`UPDATE job_attempts SET finished_at='2026-10-13T00:01:00Z' WHERE id=?`).run(fixture.attemptId);
    database.close();
    store.updateJobProgress(fixture.job.id, 2);
    expect(store.listRepairableExtractionDocumentIds().size).toBe(0);
  });

  it.each(['person_conflict', 'overwrite_protected'] as const)('%s 不会被来源修复入口绕过', (kind) => {
    const store = makeStore();
    const fixture = finishedReviewBatch(store);
    const input = repairInput(store, fixture);
    store.saveExtractionReviewIssue({ documentId: fixture.documents[1]!.documentId, kind, severity: 'blocking',
      evidenceRefs: [], stage: 'extract', preserveDocumentStatus: true });
    expect(store.listRepairableExtractionDocumentIds().has(fixture.documents[1]!.documentId)).toBe(false);
    expect(() => store.createWaitingAuthBatch(input)).toThrow('PROCESSING_REPAIR_STATE_CHANGED');
    expect(store.listStoredJobs().find((job) => job.id === fixture.job.id)?.status).toBe('waiting_user');
  });

  it('撤销或超范围授权不改变旧任务、资料与核对项', () => {
    const store = makeStore();
    const fixture = finishedReviewBatch(store);
    const input = repairInput(store, fixture);
    store.revokeConsent(input.consentId);
    expect(() => store.createWaitingAuthBatch(input)).toThrow('PROCESSING_REPAIR_CONSENT_INVALID');
    const authorized = repairInput(store, fixture);
    expect(() => store.createWaitingAuthBatch({ ...authorized, groups: [{ ...authorized.groups[0]!, documentIds: fixture.documents.map((doc) => doc.documentId) }] }))
      .toThrow('PROCESSING_REPAIR_CONSENT_INVALID');
    expect(store.listStoredJobs().find((job) => job.id === fixture.job.id)?.status).toBe('waiting_user');
    expect(store.listOpenExtractionReviewIssues()).toHaveLength(3);
  });
});

describe('重新规范化的不可变历史证据', () => {
  it('新 OCR 成员只包含新引用，同版本再次升级也不混入旧原文，历史事实与证据仍可查看', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '合成成员' });
    const fixture = documentFixture(store, person.id, '甲');
    commitFixture(store, person.id, fixture);
    const before = store.listAcceptedObservations(person.id);
    const oldId = fixture.manifest.spans[0]!.id;
    const updated = { ...fixture.manifest, id: randomUUID(), normalizerVersion: 'local-visual-layout-v2',
      spans: [{ ...fixture.manifest.spans[0]!, id: randomUUID(), quote: '2026-01-10 合成项目甲 5 mmol/L 新版版面位置已校验' }] };
    store.replaceSourceManifestForReprocessing(updated);
    const current = store.getDocumentExtractionBundle(fixture.documentId).manifest;
    expect(current.spans).toHaveLength(1);
    expect(current.spans[0]!.id).not.toBe(oldId);
    expect(current.spans[0]!.quote).toBe(updated.spans[0]!.quote);
    expect(store.getEvidenceAccess({ sourceSpanId: oldId }).quote).toBe(fixture.manifest.spans[0]!.quote);
    expect(store.listAcceptedObservations(person.id)).toEqual(before);
    expect(store.isSameSourceLocationInDocument(oldId, current.spans[0]!.id)).toBe(true);
    store.replaceSourceManifestForReprocessing({ ...updated, id: randomUUID(), spans: [{ ...updated.spans[0]!, id: randomUUID() }] });
    expect(store.getDocumentExtractionBundle(fixture.documentId).manifest.spans[0]!.id).toBe(current.spans[0]!.id);
    store.replaceSourceManifestForReprocessing({ ...updated, id: randomUUID(), spans: [{ ...updated.spans[0]!, quote: '同版本再次改进的合成 OCR 原文' }] });
    expect(store.getDocumentExtractionBundle(fixture.documentId).manifest.spans).toHaveLength(1);
    expect(store.getEvidenceAccess({ sourceSpanId: current.spans[0]!.id }).quote).toBe(updated.spans[0]!.quote);
    expect(store.listAcceptedObservations(person.id)).toEqual(before);
  });

  it('原件哈希、页范围、重复定位或失效授权不符合时拒绝替换', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '合成成员' });
    const fixture = documentFixture(store, person.id, '甲');
    expect(() => store.replaceSourceManifestForReprocessing({ ...fixture.manifest, sha256: '0'.repeat(64) }))
      .toThrow('SOURCE_MANIFEST_REPROCESSING_SOURCE_MISMATCH');
    expect(() => store.replaceSourceManifestForReprocessing({ ...fixture.manifest, totalUnits: 2 }))
      .toThrow('SOURCE_MANIFEST_REPROCESSING_COVERAGE_MISMATCH');
    expect(() => store.replaceSourceManifestForReprocessing({ ...fixture.manifest,
      spans: [{ ...fixture.manifest.spans[0]!, page: 2 }] })).toThrow('SOURCE_MANIFEST_REPROCESSING_COVERAGE_MISMATCH');
    expect(() => store.replaceSourceManifestForReprocessing(fixture.manifest, { executionGuard: {
      jobId: randomUUID(), attemptId: randomUUID(), consentId: randomUUID(), accountFingerprint
    } })).toThrow();
    expect(store.getDocumentExtractionBundle(fixture.documentId).manifest).toEqual(fixture.manifest);
    const other = documentFixture(store, person.id, '乙');
    expect(store.isSameSourceLocationInDocument(fixture.manifest.spans[0]!.id, other.manifest.spans[0]!.id)).toBe(false);
  });

  it('38 到 39 迁移完整回填多页成员并保留已有原文', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '合成迁移成员' });
    const fixture = documentFixture(store, person.id, '甲');
    const database = new Database(store.databasePath);
    const secondId = randomUUID();
    database.prepare(`INSERT INTO source_spans (id,document_id,span_kind,page_number,quote,readability,normalizer_version)
      VALUES (?,?,'image',2,'合成第二页','clear','local-visual-evidence-v1')`).run(secondId, fixture.documentId);
    database.prepare(`UPDATE source_manifests SET total_units=2,covered_unit_indexes_json='[0,1]' WHERE document_id=?`).run(fixture.documentId);
    database.exec(`DROP TABLE source_manifest_spans; UPDATE workspaces SET schema_version=38; PRAGMA user_version=38;`);
    database.close();
    stores.delete(store);
    store.close();
    const reopened = new WorkspaceStore({ rootDirectory: store.rootDirectory });
    stores.add(reopened);
    expect(reopened.getDocumentExtractionBundle(fixture.documentId).manifest.spans.map((span) => span.id))
      .toEqual([fixture.manifest.spans[0]!.id, secondId]);
    const read = new Database(reopened.databasePath, { readonly: true });
    expect(Number(read.pragma('user_version', { simple: true }))).toBe(WORKSPACE_SCHEMA_VERSION);
    read.close();
  });
});

function metadataReprocessingFixture(store: WorkspaceStore,
  quote = '合成报告 合成科 检查时间：20240229104838 报告时间：20240301105249 合成项目 5 mmol/L') {
  const person = store.createPerson({ displayName: '合成日期成员' });
  const source = store.putSourceObject({ bytes: Buffer.from(quote), mediaType: 'image/png', displayName: '合成日期.png' });
  const { documentId } = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
  const oldSpan = { id: randomUUID(), documentId, spanKind: 'image' as const, page: 1, blockId: null,
    lineStart: null, lineEnd: null, quote: '合成报告 合成科 合成项目 5 mmol/L', readability: 'clear' as const };
  const oldManifest: SourceManifest = { id: randomUUID(), sourceObjectId: source.id, sha256: source.sha256, mediaType: 'image/png',
    originalDisplayName: '合成日期.png', totalUnits: 1, coveredUnitIndexes: [0], normalizerVersion: 'local-visual-evidence-v1',
    conversionWarnings: [], createdAt: '2026-10-13T00:00:00Z', spans: [oldSpan] };
  store.saveSourceManifest(oldManifest);
  const acceptanceId = store.saveAcceptanceDecision({ method: 'auto', actor: 'policy', rulesVersion: 'synthetic',
    inputSignature: randomUUID(), outputHash: randomUUID(), reviewRef: null, decision: 'accept' });
  const originalMetadata: ReportMetadataCandidate = { reportKind: null,
    title: { value: '合成报告', evidence: [{ sourceSpanId: oldSpan.id, quote: '合成报告' }] }, organization: null,
    campus: null, department: { value: '合成科', evidence: [{ sourceSpanId: oldSpan.id, quote: '合成科' }] },
    reportNumber: null, examItems: [], times: [] };
  const observation = { conceptKey: '合成项目', originalName: '合成项目', modelStandardNameCandidate: null,
    rawText: '5', valueKind: 'numeric' as const, decimalValue: '5', qualifier: 'eq', unit: 'mmol/L',
    referenceRange: null, clinicalDate: null, abnormalFlag: 'unknown' as const, documentId,
    sourceSpanId: oldSpan.id, acceptanceId, specimen: null, method: null, bodySite: null,
    evidence: [{ sourceSpanId: oldSpan.id, quote: oldSpan.quote }] };
  store.publishFacts({ personId: person.id, documentId, documentCommitKey: randomUUID(), expectedRevision: 0,
    changeSetHash: randomUUID(), summary: '合成日期未知的事实', reportMetadata: originalMetadata, observations: [observation] });
  const issueId = store.saveExtractionReviewIssue({ documentId, kind: 'field_conflict', severity: 'warning',
    stage: 'extract', preserveDocumentStatus: true, evidenceRefs: [oldSpan.id], reasonCodes: ['metadata_date_not_in_evidence'] });
  store.replaceSourceManifestForReprocessing({ ...oldManifest, id: randomUUID(), normalizerVersion: 'local-visual-layout-v2',
    spans: [{ ...oldSpan, id: randomUUID(), quote }] });
  const currentSpan = store.getDocumentExtractionBundle(documentId).manifest.spans[0]!;
  const metadata: ReportMetadataCandidate = { ...originalMetadata, times: [
    { value: '2024-02-29', precision: 'day', role: 'examined', evidence: [{ sourceSpanId: currentSpan.id, quote }] },
    { value: '2024-03-01', precision: 'day', role: 'report_issued', evidence: [{ sourceSpanId: currentSpan.id, quote }] }
  ] };
  const input: AppendCommittedFactsInput = { personId: person.id, documentId, expectedRevision: store.getFactRevision(person.id),
    summary: '合成日期流程补强', reportMetadata: metadata, observations: [],
    reviewUpdate: { issueId, remainingCandidates: [], remainingReasonCodes: [], remainingEvidenceRefs: [] } };
  return { person, documentId, oldSpan, currentSpan, metadata, originalMetadata, observation, input };
}

describe('已接纳报告的版本化日期补强', () => {
  it('旧版空日期补强逐条核验本次来源，不被同日历史转述误拦', () => {
    const store = makeStore();
    const fixture = metadataReprocessingFixture(store, '历史检查日期：2024-02-29\n本次检查日期：2024-02-29\n报告时间：2024-03-01');
    const current = { sourceSpanId: fixture.currentSpan.id, quote: '本次检查日期：2024-02-29' };
    const history = { sourceSpanId: fixture.currentSpan.id, quote: '历史检查日期：2024-02-29' };
    const metadata = { ...fixture.metadata, times: [
      { ...fixture.metadata.times[0]!, evidence: [current] },
      { ...fixture.metadata.times[0]!, role: 'history_quoted' as const, evidence: [history] }, fixture.metadata.times[1]!
    ] };
    const before = store.listAcceptedObservations(fixture.person.id);
    expect(store.appendCommittedFacts({ ...fixture.input, reportMetadata: metadata }))
      .toMatchObject({ appendedCount: 0, updatedCount: 0, heldReasonCodes: [], reviewResolved: true });
    expect(store.listReportMetadata(fixture.person.id)[0]).toMatchObject({ reportDate: '2024-03-01',
      clinicalTime: { value: '2024-02-29', precision: 'day' } });
    expect(store.listAcceptedObservations(fixture.person.id)).toEqual(before);
  });

  it('当前原文中的 14 位检查时间和签发时间分别填补未知日期，旧事实及原提取字段不变', () => {
    const store = makeStore();
    const fixture = metadataReprocessingFixture(store);
    const beforeFacts = store.listAcceptedObservations(fixture.person.id);
    const receipt = store.appendCommittedFacts(fixture.input);
    expect(receipt).toMatchObject({ revision: 2, appendedCount: 0, reviewResolved: true, idempotent: false });
    expect(receipt.publicationId).not.toBeNull();
    expect(store.listAcceptedObservations(fixture.person.id)).toEqual(beforeFacts);
    const report = store.listReportMetadata(fixture.person.id)[0]!;
    expect(report).toMatchObject({ title: '合成报告', department: '合成科', metadataRevision: 2,
      reportDate: '2024-03-01', clinicalTime: { value: '2024-02-29', precision: 'day' }, canUndo: false });
    expect(report.extracted?.title).toEqual(fixture.originalMetadata.title);
    const database = new Database(store.databasePath, { readonly: true });
    try {
      const revision = database.prepare(`SELECT actor,payload_json,evidence_refs_json FROM report_metadata_revisions WHERE report_id=? AND revision=2`)
        .get(report.reportId) as { actor: string; payload_json: string; evidence_refs_json: string };
      expect(revision.actor).toBe('policy');
      expect(JSON.parse(revision.payload_json)).toMatchObject({ action: 'policy_enrich',
        previous: { clinicalDate: null, reportDate: null, extracted: fixture.originalMetadata } });
      expect(JSON.parse(revision.evidence_refs_json)).toEqual(expect.arrayContaining([
        { sourceSpanId: fixture.oldSpan.id, quote: '合成报告' }, { sourceSpanId: fixture.currentSpan.id, quote: fixture.currentSpan.quote }
      ]));
    } finally { database.close(); }
    expect(store.appendCommittedFacts({ ...fixture.input, expectedRevision: receipt.revision })).toMatchObject({ idempotent: true, revision: 2 });
  });

  it('只有签发日期时不会把签发时间借作检查日期', () => {
    const store = makeStore();
    const fixture = metadataReprocessingFixture(store);
    store.appendCommittedFacts({ ...fixture.input, reportMetadata: { ...fixture.metadata, times: [fixture.metadata.times[1]!] } });
    expect(store.listReportMetadata(fixture.person.id)[0]).toMatchObject({
      reportDate: '2024-03-01', clinicalTime: { value: null, precision: 'unknown' }, metadataRevision: 2
    });
  });

  it('人工修订的日期不会被重跑覆盖，撤销入口仍保留', () => {
    const store = makeStore();
    const fixture = metadataReprocessingFixture(store);
    const report = store.listReportMetadata(fixture.person.id)[0]!;
    store.updateReportMetadata({ personId: fixture.person.id, reportId: report.reportId, expectedRevision: 1,
      title: '人工合成报告名', organization: null, department: '人工合成科',
      clinicalTime: { value: '2024-02-28', precision: 'day' }, reason: '合成手工修订' });
    const before = store.listReportMetadata(fixture.person.id)[0]!;
    store.appendCommittedFacts({ ...fixture.input, expectedRevision: store.getFactRevision(fixture.person.id) });
    expect(store.listReportMetadata(fixture.person.id)[0]).toEqual(before);
    expect(before).toMatchObject({ metadataStatus: 'corrected', canUndo: true });
  });

  it('已有明确日期矛盾时保留原记录，不静默覆盖为新候选', () => {
    const store = makeStore();
    const fixture = metadataReprocessingFixture(store);
    const database = new Database(store.databasePath);
    database.prepare(`UPDATE health_events_v2 SET clinical_date='2024-02-28',date_precision='day',date_source='explicit',metadata_status='confirmed'
      WHERE person_id=?`).run(fixture.person.id);
    database.close();
    const before = store.listReportMetadata(fixture.person.id)[0]!;
    store.appendCommittedFacts(fixture.input);
    expect(store.listReportMetadata(fixture.person.id)[0]).toEqual(before);
  });

  it.each(['old_source', 'wrong_role', 'wrong_document', 'missing_label'] as const)('%s 不是当前同文件且角色明示的日期依据，整个事务保留旧事实与核对项', (failure) => {
    const store = makeStore();
    const fixture = metadataReprocessingFixture(store);
    const other = documentFixture(store, fixture.person.id, '别页');
    const time = fixture.metadata.times[0]!;
    const badTime = failure === 'old_source'
      ? { ...time, evidence: [{ sourceSpanId: fixture.oldSpan.id, quote: fixture.oldSpan.quote }] }
      : failure === 'wrong_document'
        ? { ...time, evidence: [{ sourceSpanId: other.manifest.spans[0]!.id, quote: other.manifest.spans[0]!.quote }] }
        : failure === 'wrong_role'
          ? { ...fixture.metadata.times[1]!, role: 'examined' as const }
          : { ...time, evidence: [{ sourceSpanId: fixture.currentSpan.id, quote: '20240229104838' }] };
    const beforeFacts = store.listAcceptedObservations(fixture.person.id);
    const beforeMetadata = store.listReportMetadata(fixture.person.id);
    const append = () => store.appendCommittedFacts({ ...fixture.input, reportMetadata: { ...fixture.metadata, times: [badTime] } });
    if (failure === 'wrong_document') expect(append).toThrow('COMMITTED_REPORT_METADATA_DOCUMENT_SCOPE_MISMATCH');
    else expect(append()).toMatchObject({ appendedCount: 0, updatedCount: 0, reviewResolved: false,
      heldReasonCodes: [failure === 'old_source' ? 'report_metadata_date_evidence_unverified' : 'report_metadata_date_role_unverified'] });
    expect(store.listAcceptedObservations(fixture.person.id)).toEqual(beforeFacts);
    expect(store.listReportMetadata(fixture.person.id)).toEqual(beforeMetadata);
    expect(store.listOpenExtractionReviewIssues().some((issue) => issue.id === fixture.input.reviewUpdate.issueId)).toBe(true);
  });

  it('CAS、授权失效或后续发布失败时，不留下半次日期补强', () => {
    const store = makeStore();
    const fixture = metadataReprocessingFixture(store);
    const beforeFacts = store.listAcceptedObservations(fixture.person.id);
    const beforeMetadata = store.listReportMetadata(fixture.person.id);
    expect(() => store.appendCommittedFacts({ ...fixture.input, expectedRevision: 0 })).toThrow();
    expect(() => store.appendCommittedFacts({ ...fixture.input, executionGuard: {
      jobId: randomUUID(), attemptId: randomUUID(), consentId: randomUUID(), accountFingerprint
    } })).toThrow();
    const database = new Database(store.databasePath);
    database.exec(`CREATE TRIGGER synthetic_publication_failure BEFORE INSERT ON publication_events
      BEGIN SELECT RAISE(ABORT,'synthetic_publication_failed'); END;`);
    database.close();
    expect(() => store.appendCommittedFacts(fixture.input)).toThrow('synthetic_publication_failed');
    expect(store.listAcceptedObservations(fixture.person.id)).toEqual(beforeFacts);
    expect(store.listReportMetadata(fixture.person.id)).toEqual(beforeMetadata);
    expect(store.getFactRevision(fixture.person.id)).toBe(1);
    expect(store.listOpenExtractionReviewIssues().some((issue) => issue.id === fixture.input.reviewUpdate.issueId)).toBe(true);
  });

  it('模型不能靠删除数字间空白拼出原文里没有的完整时间', () => {
    const store = makeStore();
    const fixture = metadataReprocessingFixture(store);
    const manifest = store.getDocumentExtractionBundle(fixture.documentId).manifest;
    store.replaceSourceManifestForReprocessing({ ...manifest, id: randomUUID(),
      spans: [{ ...manifest.spans[0]!, id: randomUUID(), quote: '检查时间：2024 02 29 104838 合成项目 5 mmol/L' }] });
    const span = store.getDocumentExtractionBundle(fixture.documentId).manifest.spans[0]!;
    expect(store.appendCommittedFacts({ ...fixture.input, reportMetadata: { ...fixture.metadata,
      times: [{ ...fixture.metadata.times[0]!, evidence: [{ sourceSpanId: span.id, quote: '检查时间：20240229104838' }] }] } }))
      .toMatchObject({ appendedCount: 0, updatedCount: 0, reviewResolved: false, heldReasonCodes: ['report_metadata_date_role_unverified'] });
    expect(store.listReportMetadata(fixture.person.id)[0]?.metadataRevision).toBe(1);
  });

  it.each(['历史', '上次', '既往', '历年', '前次'])('%s检查时间不能补为当前事件日期，即使模型角色写为 examined', (modifier) => {
    const store = makeStore();
    const fixture = metadataReprocessingFixture(store);
    const manifest = store.getDocumentExtractionBundle(fixture.documentId).manifest;
    const quote = `${modifier}检查时间：20240229104838 合成项目 5 mmol/L`;
    store.replaceSourceManifestForReprocessing({ ...manifest, id: randomUUID(),
      spans: [{ ...manifest.spans[0]!, id: randomUUID(), quote }] });
    const span = store.getDocumentExtractionBundle(fixture.documentId).manifest.spans[0]!;
    expect(store.appendCommittedFacts({ ...fixture.input, reportMetadata: { ...fixture.metadata,
      times: [{ ...fixture.metadata.times[0]!, evidence: [{ sourceSpanId: span.id, quote }] }] } }))
      .toMatchObject({ appendedCount: 0, updatedCount: 0, reviewResolved: false, heldReasonCodes: ['report_metadata_date_role_unverified'] });
    expect(store.listReportMetadata(fixture.person.id)[0]?.clinicalTime.value).toBeNull();
    expect(store.listReportMetadata(fixture.person.id)[0]?.metadataRevision).toBe(1);
  });

  it('新版 OCR 改了片段 ID，也不能给同原件位置的旧无日期事实追加一个有日期副本', () => {
    const store = makeStore();
    const fixture = metadataReprocessingFixture(store);
    const before = store.listAcceptedObservations(fixture.person.id);
    const receipt = store.appendCommittedFacts({ ...fixture.input, observations: [{ ...fixture.observation,
      clinicalDate: '2024-02-29', sourceSpanId: fixture.currentSpan.id,
      evidence: [{ sourceSpanId: fixture.currentSpan.id, quote: fixture.currentSpan.quote }] }] });
    expect(receipt).toMatchObject({ appendedCount: 0, updatedCount: 0, heldCount: 1, reviewResolved: false });
    expect(receipt.heldReasonCodes).toContain('source_binding_requires_unique_mapping');
    expect(store.listAcceptedObservations(fixture.person.id)).toEqual(before);
    expect(store.listReportMetadata(fixture.person.id)[0]?.metadataRevision).toBe(2);
  });
});

function reconciliationFixture(store: WorkspaceStore, quote: string) {
  const person = store.createPerson({ displayName: '合成来源对账成员' });
  const source = store.putSourceObject({ bytes: Buffer.from(quote), mediaType: 'image/png', displayName: '合成来源对账.png' });
  const { documentId } = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
  const span = { id: randomUUID(), documentId, spanKind: 'image' as const, page: 1, blockId: null,
    lineStart: null, lineEnd: null, quote, readability: 'clear' as const };
  const manifest: SourceManifest = { id: randomUUID(), sourceObjectId: source.id, sha256: source.sha256,
    mediaType: 'image/png', originalDisplayName: '合成来源对账.png', totalUnits: 1, coveredUnitIndexes: [0],
    normalizerVersion: 'synthetic-source-view-v1', conversionWarnings: [], createdAt: '2026-01-01T00:00:00Z', spans: [span] };
  store.saveSourceManifest(manifest);
  const acceptanceId = store.saveAcceptanceDecision({ method: 'auto', actor: 'policy', rulesVersion: 'synthetic',
    inputSignature: randomUUID(), outputHash: randomUUID(), reviewRef: null, decision: 'accept' });
  const observation = (result: string, name = '检查所见'): AppendCommittedFactsInput['observations'][number] => {
    const evidence = [{ sourceSpanId: span.id, quote: result }];
    const candidate: ObservationCandidate = { localKey: randomUUID(), originalName: name, standardNameCandidate: null,
      value: { kind: 'text', rawText: result }, unitRaw: null, referenceRangeRaw: null, reportedAbnormalFlag: null,
      specimen: null, method: null, bodySite: null, clinicalDate: null, evidence, issues: [],
      sourceBinding: { headingEvidence: [], findingEvidence: evidence } };
    return { conceptKey: name, originalName: name, modelStandardNameCandidate: null, rawText: result,
      valueKind: 'text', decimalValue: null, qualifier: null, unit: null, referenceRange: null, clinicalDate: null,
      abnormalFlag: 'unknown', documentId, sourceSpanId: span.id, acceptanceId, specimen: null, method: null,
      bodySite: null, evidence, candidate, sourceBinding: candidate.sourceBinding };
  };
  const publish = (observations: AppendCommittedFactsInput['observations']) => store.publishFacts({ personId: person.id,
    documentId, documentCommitKey: randomUUID(), expectedRevision: store.getFactRevision(person.id),
    changeSetHash: randomUUID(), summary: '合成首次来源对账', observations });
  const append = (observations: AppendCommittedFactsInput['observations'], reportMetadata?: ReportMetadataCandidate) => {
    const open = store.listOpenExtractionReviewIssues().find((issue) => issue.documentId === documentId);
    const issueId = open?.id ?? store.saveExtractionReviewIssue({ documentId, stage: 'extract', kind: 'field_conflict',
      severity: 'warning', preserveDocumentStatus: true, evidenceRefs: [span.id], reasonCodes: ['synthetic_gap'] });
    return store.appendCommittedFacts({ personId: person.id, documentId, expectedRevision: store.getFactRevision(person.id),
      summary: '合成增量来源对账', observations, ...(reportMetadata ? { reportMetadata } : {}),
      reviewUpdate: { issueId, remainingCandidates: [], remainingReasonCodes: [], remainingEvidenceRefs: [] } });
  };
  return { person, documentId, span, manifest, observation, publish, append };
}

describe('来源绑定的通用增量对账', () => {
  it('同一栏目下两个无日期子项来自不同原文段，第一次和增量保存都不会互相冲突', () => {
    const store = makeStore();
    const fixture = reconciliationFixture(store, '检查所见\n合成甲部轮廓清楚。\n合成乙部血流丰富。');
    fixture.publish([fixture.observation('合成甲部轮廓清楚')]);
    const first = store.listAcceptedObservations(fixture.person.id)[0]!;
    expect(fixture.append([fixture.observation('合成甲部轮廓清楚'), fixture.observation('合成乙部血流丰富')]))
      .toMatchObject({ appendedCount: 1, duplicateCount: 1, heldCount: 0, updatedCount: 0, reviewResolved: true });
    expect(store.listAcceptedObservations(fixture.person.id)).toHaveLength(2);
    expect(store.listAcceptedObservations(fixture.person.id).find((item) => item.id === first.id)).toEqual(first);
  });

  it('展示名称和候选顺序变化不影响同一来源事实判重', () => {
    const store = makeStore();
    const fixture = reconciliationFixture(store, '检查所见\n合成甲部轮廓清楚。\n合成乙部血流丰富。');
    expect(fixture.publish([fixture.observation('合成甲部轮廓清楚'), fixture.observation('合成乙部血流丰富')]))
      .toMatchObject({ heldCount: 0 });
    expect(fixture.append([fixture.observation('合成乙部血流丰富', '合成血流'), fixture.observation('合成甲部轮廓清楚', '合成形态')]))
      .toMatchObject({ appendedCount: 0, duplicateCount: 2, heldCount: 0 });
    expect(store.listAcceptedObservations(fixture.person.id)).toHaveLength(2);
  });

  it('真正语义冲突局部保留，另一项继续保存且原值完全不动', () => {
    const store = makeStore();
    const fixture = reconciliationFixture(store, '检查所见\n合成甲部轮廓清楚。\n合成乙部血流丰富。');
    fixture.publish([fixture.observation('合成甲部轮廓清楚')]);
    const before = store.listAcceptedObservations(fixture.person.id)[0]!;
    const disputed = { ...fixture.observation('合成甲部轮廓清楚'), bodySite: '合成部位乙' };
    expect(fixture.append([disputed, fixture.observation('合成乙部血流丰富')]))
      .toMatchObject({ appendedCount: 1, heldCount: 1, reviewResolved: false });
    expect(store.listAcceptedObservations(fixture.person.id).find((item) => item.id === before.id)).toEqual(before);
    expect(store.listOpenExtractionReviewIssues().find((issue) => issue.documentId === fixture.documentId)?.reasonCodes)
      .toContain('same_source_finding_semantic_conflict');
  });

  it('首次同源候选矛盾不能按先后顺序选赢家，可靠独立项仍保存', () => {
    const store = makeStore();
    const fixture = reconciliationFixture(store, '检查所见\n合成甲部轮廓清楚。\n合成乙部血流丰富。');
    const first = fixture.observation('合成甲部轮廓清楚');
    const receipt = fixture.publish([first, { ...first, bodySite: '合成部位乙' }, fixture.observation('合成乙部血流丰富')]);
    expect(receipt).toMatchObject({ heldCount: 2 });
    expect(receipt.reviewIssueId).not.toBeNull();
    expect(store.listAcceptedObservations(fixture.person.id).map((item) => item.rawText)).toEqual(['合成乙部血流丰富']);
  });

  it('唯一同源事实未知日期可按明确检查标签建立新修订，不复制记录、不改旧值和旧修订', () => {
    const store = makeStore();
    const fixture = reconciliationFixture(store, '检查日期：2026-01-10\n检查所见\n合成甲部轮廓清楚。');
    const original = fixture.observation('合成甲部轮廓清楚');
    fixture.publish([original]);
    const previous = store.listAcceptedObservations(fixture.person.id)[0]!;
    const dated = { ...original, clinicalDate: '2026-01-10',
      candidate: { ...original.candidate!, clinicalDate: '2026-01-10' } };
    const metadata: ReportMetadataCandidate = { reportKind: null, title: null, organization: null,
      campus: null, department: null, reportNumber: null, examItems: [], times: [{ value: '2026-01-10',
        precision: 'day', role: 'examined', evidence: [{ sourceSpanId: fixture.span.id, quote: '检查日期：2026-01-10' }] }] };
    expect(fixture.append([dated], metadata)).toMatchObject({ appendedCount: 0, updatedCount: 1, heldCount: 0 });
    const current = store.listAcceptedObservations(fixture.person.id);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ id: previous.id, rawText: previous.rawText, clinicalDate: '2026-01-10' });
    const database = new Database(store.databasePath, { readonly: true });
    try {
      expect(database.prepare(`SELECT revision,raw_text,clinical_date,supersedes FROM observation_revisions
        WHERE observation_id=? ORDER BY revision`).all(previous.id)).toEqual([
          { revision: 1, raw_text: previous.rawText, clinical_date: null, supersedes: null },
          { revision: 2, raw_text: previous.rawText, clinical_date: '2026-01-10', supersedes: 1 }
        ]);
      expect(database.prepare(`SELECT event_type FROM audit_events WHERE entity_id=? AND event_type='observation.clinical_date_enriched'`)
        .get(previous.id)).toBeTruthy();
    } finally { database.close(); }
    expect(fixture.append([dated], metadata)).toMatchObject({ appendedCount: 0, updatedCount: 0, duplicateCount: 1 });
  });

  it('同来源只有签发日期或已有不同确认日期，不会自动覆盖检查日期', () => {
    const store = makeStore();
    const fixture = reconciliationFixture(store, '报告日期：2026-01-10\n检查所见\n合成甲部轮廓清楚。');
    const original = fixture.observation('合成甲部轮廓清楚');
    fixture.publish([original]);
    const dated = { ...original, clinicalDate: '2026-01-10', candidate: { ...original.candidate!, clinicalDate: '2026-01-10' } };
    expect(fixture.append([dated])).toMatchObject({ appendedCount: 0, updatedCount: 0, heldCount: 1 });
    expect(store.listAcceptedObservations(fixture.person.id)[0]?.clinicalDate).toBeNull();
  });

  it.each([
    ['15', '15', '16', '16'],
    ['1,000', '1000', '2,000', '2000'],
    ['1.0E+03', '1000', '2.0E+03', '2000']
  ])('跨OCR交换原行，任何数值书写%s/%s/%s/%s都不能仅凭唯一值映射成另一项目', (firstRaw, firstDecimal, secondRaw, secondDecimal) => {
    const store = makeStore();
    const fixture = reconciliationFixture(store, `合成甲 ${firstRaw} U/L\n合成乙 ${secondRaw} U/L`);
    const numeric = (name: string, rawText: string, decimal: string, sourceSpanId: string, quote: string) => {
      const result = fixture.observation(rawText, name);
      const candidate: ObservationCandidate = { ...result.candidate!, value: { kind: 'numeric', rawText,
        decimal, comparator: 'eq' }, unitRaw: 'U/L', evidence: [{ sourceSpanId, quote }],
        sourceBinding: { headingEvidence: [], findingEvidence: [{ sourceSpanId, quote }] } };
      return { ...result, valueKind: 'numeric' as const, decimalValue: decimal, qualifier: 'eq', unit: 'U/L',
        sourceSpanId, evidence: candidate.evidence, candidate, sourceBinding: candidate.sourceBinding };
    };
    expect(fixture.publish([numeric('合成乙', secondRaw, secondDecimal, fixture.span.id, fixture.span.quote)]))
      .toMatchObject({ heldCount: 0 });
    const before = store.listAcceptedObservations(fixture.person.id);
    expect(before).toHaveLength(1);
    store.replaceSourceManifestForReprocessing({ ...fixture.manifest, normalizerVersion: 'synthetic-source-view-v2',
      spans: [{ ...fixture.span, quote: `合成甲 ${secondRaw} U/L\n合成乙 ${firstRaw} U/L` }] });
    const current = store.getDocumentExtractionBundle(fixture.documentId).manifest;
    expect(current.id).not.toBe(fixture.manifest.id);
    expect(fixture.append([numeric('合成甲', secondRaw, secondDecimal, current.spans[0]!.id, current.spans[0]!.quote!)]))
      .toMatchObject({ appendedCount: 0, duplicateCount: 0, updatedCount: 0, heldCount: 1, reviewResolved: false });
    expect(store.listAcceptedObservations(fixture.person.id)).toEqual(before);
  });

  it('跨OCR文字结果换行后被交换栏目，唯一相同文字也不能直接合并旧事实', () => {
    const store = makeStore();
    const fixture = reconciliationFixture(store, '合成甲\n状态良好。\n合成乙\n需要留意。');
    expect(fixture.publish([fixture.observation('需要留意', '合成乙')])).toMatchObject({ heldCount: 0 });
    const before = store.listAcceptedObservations(fixture.person.id);
    expect(before).toHaveLength(1);
    store.replaceSourceManifestForReprocessing({ ...fixture.manifest, normalizerVersion: 'synthetic-source-view-v2',
      spans: [{ ...fixture.span, quote: '合成甲\n需要留意。\n合成乙\n状态良好。' }] });
    const current = store.getDocumentExtractionBundle(fixture.documentId).manifest.spans[0]!;
    const observation = fixture.observation('需要留意', '合成甲');
    const evidence = [{ sourceSpanId: current.id, quote: '需要留意' }];
    const candidate = { ...observation.candidate!, evidence, sourceBinding: { headingEvidence: [], findingEvidence: evidence } };
    expect(fixture.append([{ ...observation, sourceSpanId: current.id, evidence, candidate, sourceBinding: candidate.sourceBinding }]))
      .toMatchObject({ appendedCount: 0, duplicateCount: 0, updatedCount: 0, heldCount: 1 });
    expect(store.listAcceptedObservations(fixture.person.id)).toEqual(before);
  });

  it('39到40只增加历史日期快照及来源绑定列，旧记录编号、值、来源和确认日期不变', () => {
    const store = makeStore();
    const fixture = reconciliationFixture(store, '检查日期：2026-01-10\n合成甲部轮廓清楚。');
    const observation = fixture.observation('合成甲部轮廓清楚');
    fixture.publish([{ ...observation, clinicalDate: '2026-01-10', candidate: { ...observation.candidate!, clinicalDate: '2026-01-10' } }]);
    const before = store.listAcceptedObservations(fixture.person.id);
    const old = new Database(store.databasePath);
    old.exec(`ALTER TABLE observation_revisions DROP COLUMN source_binding_json;
      ALTER TABLE observation_revisions DROP COLUMN clinical_date;
      ALTER TABLE observation_revisions DROP COLUMN date_evidence_json;
      UPDATE workspaces SET schema_version=39; PRAGMA user_version=39;`);
    old.close();
    stores.delete(store); store.close();
    const reopened = new WorkspaceStore({ rootDirectory: store.rootDirectory });
    stores.add(reopened);
    expect(reopened.listAcceptedObservations(fixture.person.id)).toEqual(before);
    const database = new Database(reopened.databasePath, { readonly: true });
    try {
      expect(Number(database.pragma('user_version', { simple: true }))).toBe(WORKSPACE_SCHEMA_VERSION);
      expect(database.prepare(`SELECT clinical_date,source_binding_json,date_evidence_json FROM observation_revisions
        WHERE observation_id=?`).get(before[0]!.id))
        .toEqual({ clinical_date: '2026-01-10', source_binding_json: null, date_evidence_json: '[]' });
    } finally { database.close(); }
  });

  it.each([
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]
  ])('同来源日期补充候选被另一条部位矛盾污染后，排列%s/%s/%s都整组保留而不复活补充', (first, second, third) => {
    const store = makeStore();
    const fixture = reconciliationFixture(store, '检查日期：2026-01-10\n检查所见\n合成观察结果。');
    const original = fixture.observation('合成观察结果');
    fixture.publish([original]);
    const before = store.listAcceptedObservations(fixture.person.id);
    const dated = { ...original, clinicalDate: '2026-01-10', candidate: { ...original.candidate!, clinicalDate: '2026-01-10' } };
    const candidates = [
      { ...dated, candidate: { ...dated.candidate, localKey: 'synthetic-date-one' } },
      { ...dated, bodySite: '合成其他部位', candidate: { ...dated.candidate, localKey: 'synthetic-conflicting-site', bodySite: '合成其他部位' } },
      { ...dated, candidate: { ...dated.candidate, localKey: 'synthetic-date-one-repeat' } }
    ];
    const metadata: ReportMetadataCandidate = { reportKind: null, title: null, organization: null,
      campus: null, department: null, reportNumber: null, examItems: [], times: [{ value: '2026-01-10',
        precision: 'day', role: 'examined', evidence: [{ sourceSpanId: fixture.span.id, quote: '检查日期：2026-01-10' }] }] };
    const receipt = fixture.append([candidates[first]!, candidates[second]!, candidates[third]!], metadata);
    expect(receipt).toMatchObject({ appendedCount: 0, updatedCount: 0, duplicateCount: 0, heldCount: 3, reviewResolved: false });
    expect(receipt.heldReasonCodes).toContain('same_source_finding_batch_conflict');
    expect(store.listAcceptedObservations(fixture.person.id)).toEqual(before);
    const database = new Database(store.databasePath, { readonly: true });
    try {
      expect(database.prepare(`SELECT current_revision FROM observations WHERE id=?`).get(before[0]!.id)).toEqual({ current_revision: 1 });
      expect(database.prepare(`SELECT COUNT(*) AS count FROM observation_revisions WHERE observation_id=?`).get(before[0]!.id)).toEqual({ count: 1 });
      expect(database.prepare(`SELECT 1 FROM audit_events WHERE entity_id=? AND event_type='observation.clinical_date_enriched'`)
        .get(before[0]!.id)).toBeUndefined();
    } finally { database.close(); }
  });

  it('两个明确候选日期矛盾且第三条重复第一个日期，也不能按多数或输入顺序自动补旧空日期', () => {
    const store = makeStore();
    const fixture = reconciliationFixture(store, '检查日期：2026-01-10\n检查所见\n合成观察结果。');
    const original = fixture.observation('合成观察结果');
    fixture.publish([original]);
    const before = store.listAcceptedObservations(fixture.person.id);
    const candidates = ['2026-01-10', '2026-01-11', '2026-01-10'].map((clinicalDate, index) => ({
      ...original, clinicalDate, candidate: { ...original.candidate!, localKey: `synthetic-date-${index}`, clinicalDate }
    }));
    expect(fixture.append(candidates)).toMatchObject({ appendedCount: 0, updatedCount: 0, heldCount: 3 });
    expect(store.listAcceptedObservations(fixture.person.id)).toEqual(before);
  });

  it.each([true, false])('历史日期的截短引文不会补给当前旧空日期（提供历史role：%s）', (includeMetadata) => {
    const store = makeStore();
    const fixture = reconciliationFixture(store, '本次检查\n合成观察结果。\n历史对比\n检查日期：2024-01-10');
    const original = fixture.observation('合成观察结果');
    fixture.publish([original]);
    const before = store.listAcceptedObservations(fixture.person.id);
    const evidence = [...original.evidence, { sourceSpanId: fixture.span.id, quote: '检查日期：2024-01-10' }];
    const dated = { ...original, clinicalDate: '2024-01-10', evidence,
      candidate: { ...original.candidate!, clinicalDate: '2024-01-10', evidence } };
    const metadata: ReportMetadataCandidate = { reportKind: null, title: null, organization: null, campus: null,
      department: null, reportNumber: null, examItems: [], times: [{ value: '2024-01-10', precision: 'day',
        role: 'history_quoted', evidence: [{ sourceSpanId: fixture.span.id, quote: '检查日期：2024-01-10' }] }] };
    expect(fixture.append([dated], includeMetadata ? metadata : undefined))
      .toMatchObject({ appendedCount: 0, updatedCount: 0, heldCount: 1, reviewResolved: false });
    expect(store.listAcceptedObservations(fixture.person.id)).toEqual(before);
  });

  it('本次事实的明确日期不被另一个同日历史条目否定，历史引文也不会成为补强依据', () => {
    const store = makeStore();
    const fixture = reconciliationFixture(store, '历史检查日期：2026-01-10\n本次检查日期：2026-01-10\n检查所见\n合成观察结果。');
    const original = fixture.observation('合成观察结果');
    fixture.publish([original]);
    const current = { sourceSpanId: fixture.span.id, quote: '本次检查日期：2026-01-10' };
    const history = { sourceSpanId: fixture.span.id, quote: '历史检查日期：2026-01-10' };
    const evidence = [...original.evidence, current];
    const dated = { ...original, clinicalDate: '2026-01-10', evidence,
      candidate: { ...original.candidate!, clinicalDate: '2026-01-10', evidence } };
    const metadata: ReportMetadataCandidate = { reportKind: null, title: null, organization: null, campus: null,
      department: null, reportNumber: null, examItems: [], times: [
        { value: '2026-01-10', precision: 'day', role: 'examined', evidence: [current] },
        { value: '2026-01-10', precision: 'day', role: 'history_quoted', evidence: [history] }
      ] };
    expect(fixture.append([dated], metadata)).toMatchObject({ appendedCount: 0, updatedCount: 1,
      heldCount: 0, heldReasonCodes: [], reviewResolved: true });
    const saved = store.listAcceptedObservations(fixture.person.id)[0]!;
    expect(saved.clinicalDate).toBe('2026-01-10');
    const database = new Database(store.databasePath, { readonly: true });
    try {
      const row = database.prepare(`SELECT date_evidence_json FROM observation_revisions
        WHERE observation_id=? ORDER BY revision DESC LIMIT 1`).get(saved.id) as { date_evidence_json: string };
      expect(JSON.parse(row.date_evidence_json)).toEqual([current]);
    } finally { database.close(); }
  });

  it('模型把历史栏目日期错标examined，元数据只局部保留疑点且不阻止另一个可靠结果保存', () => {
    const store = makeStore();
    const fixture = reconciliationFixture(store, '本次检查\n合成已保存结果。\n合成可靠新结果。\n历史对比\n检查日期：2024-01-10');
    fixture.publish([fixture.observation('合成已保存结果')]);
    const before = store.listAcceptedObservations(fixture.person.id)[0]!;
    const metadata: ReportMetadataCandidate = { reportKind: null, title: null, organization: null, campus: null,
      department: null, reportNumber: null, examItems: [], times: [{ value: '2024-01-10', precision: 'day',
        role: 'examined', evidence: [{ sourceSpanId: fixture.span.id, quote: '检查日期：2024-01-10' }] }] };
    expect(fixture.append([fixture.observation('合成可靠新结果')], metadata)).toMatchObject({
      appendedCount: 1, updatedCount: 0, reviewResolved: false, heldReasonCodes: ['report_metadata_date_role_unverified']
    });
    expect(store.listAcceptedObservations(fixture.person.id).find((item) => item.id === before.id)).toEqual(before);
    expect(store.listAcceptedObservations(fixture.person.id)).toHaveLength(2);
    expect(store.listReportMetadata(fixture.person.id)[0]).toMatchObject({ metadataRevision: 1,
      clinicalTime: { value: null, precision: 'unknown' }, reportDate: null });
    expect(store.listOpenExtractionReviewIssues().find((issue) => issue.documentId === fixture.documentId)?.reasonCodes)
      .toContain('report_metadata_date_role_unverified');
  });

  it('历史标题在前一个来源片段时，完整有序上下文同时阻止元数据和事实空日期补强', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '合成相邻片段成员' });
    const texts = ['本次检查', '合成观察结果', '历史对比', '检查日期：2024-01-10'];
    const source = store.putSourceObject({ bytes: Buffer.from(texts.join('\n')), mediaType: 'text/plain', displayName: '合成相邻.txt' });
    const { documentId } = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const spans: SourceManifest['spans'] = texts.map((quote, index) => ({ id: randomUUID(), documentId,
      spanKind: 'line', page: null, blockId: null, lineStart: index + 1, lineEnd: index + 1, quote, readability: 'clear' }));
    store.saveSourceManifest({ id: randomUUID(), sourceObjectId: source.id, sha256: source.sha256, mediaType: 'text/plain',
      originalDisplayName: '合成相邻.txt', totalUnits: 4, coveredUnitIndexes: [0, 1, 2, 3], normalizerVersion: 'synthetic',
      conversionWarnings: [], createdAt: '2026-01-01T00:00:00Z', spans });
    const acceptanceId = store.saveAcceptanceDecision({ method: 'auto', actor: 'policy', rulesVersion: 'synthetic',
      inputSignature: randomUUID(), outputHash: randomUUID(), reviewRef: null, decision: 'accept' });
    const evidence = [{ sourceSpanId: spans[1]!.id, quote: texts[1]! }];
    const candidate: ObservationCandidate = { localKey: 'synthetic-neighbor', originalName: '合成检查所见', standardNameCandidate: null,
      value: { kind: 'text', rawText: texts[1]! }, unitRaw: null, referenceRangeRaw: null, reportedAbnormalFlag: null,
      clinicalDate: null, specimen: null, method: null, bodySite: null, evidence, issues: [],
      sourceBinding: { headingEvidence: [], findingEvidence: evidence } };
    const observation: AppendCommittedFactsInput['observations'][number] = { conceptKey: candidate.originalName,
      originalName: candidate.originalName, rawText: texts[1]!, valueKind: 'text', decimalValue: null, qualifier: null,
      unit: null, referenceRange: null, clinicalDate: null, abnormalFlag: 'unknown', documentId, sourceSpanId: spans[1]!.id,
      acceptanceId, specimen: null, method: null, bodySite: null, evidence, candidate, sourceBinding: candidate.sourceBinding };
    store.publishFacts({ personId: person.id, documentId, documentCommitKey: randomUUID(), expectedRevision: 0,
      changeSetHash: randomUUID(), summary: '合成当前结果', observations: [observation] });
    const before = store.listAcceptedObservations(person.id);
    const issueId = store.saveExtractionReviewIssue({ documentId, stage: 'extract', kind: 'field_conflict',
      severity: 'warning', preserveDocumentStatus: true, evidenceRefs: [spans[3]!.id], reasonCodes: ['synthetic_date_gap'] });
    const metadata: ReportMetadataCandidate = { reportKind: null, title: null, organization: null, campus: null,
      department: null, reportNumber: null, examItems: [], times: [{ value: '2024-01-10', precision: 'day', role: 'examined',
        evidence: [{ sourceSpanId: spans[3]!.id, quote: texts[3]! }] }] };
    const dateEvidence = [...evidence, { sourceSpanId: spans[3]!.id, quote: texts[3]! }];
    const receipt = store.appendCommittedFacts({ personId: person.id, documentId, expectedRevision: 1,
      summary: '合成相邻角色校验', reportMetadata: metadata, observations: [{ ...observation, clinicalDate: '2024-01-10',
        evidence: dateEvidence, candidate: { ...candidate, clinicalDate: '2024-01-10', evidence: dateEvidence } }],
      reviewUpdate: { issueId, remainingCandidates: [], remainingReasonCodes: [], remainingEvidenceRefs: [] } });
    expect(receipt).toMatchObject({ appendedCount: 0, updatedCount: 0, heldCount: 1, reviewResolved: false });
    expect(receipt.heldReasonCodes).toContain('report_metadata_date_role_unverified');
    expect(store.listAcceptedObservations(person.id)).toEqual(before);
    expect(store.listReportMetadata(person.id)[0]).toMatchObject({ metadataRevision: 1,
      clinicalTime: { value: null, precision: 'unknown' } });
  });
});
