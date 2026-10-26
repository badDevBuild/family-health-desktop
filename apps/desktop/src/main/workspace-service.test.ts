import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stableHash } from '@core';
import { memberAssessmentSnapshotV3Schema, type ActionItem, type ExtractionResult, type HealthClaim, type ManualNote, type MemberAssessmentSnapshotV3, type SystemAnalysisSnapshot } from '@contracts';
import { PersonalWorkspaceService } from './workspace-service.js';
import { DocumentExtractionPipeline } from './processing-pipeline.js';
import { ensureLocalRecoveryPoints } from './recovery-point-service.js';
import { buildTextManifest, type LegacyDocConverter } from '@ingestion';
import { WorkspaceStore, type PublishFactsInput } from '@storage';
import { MEMBER_ASSESSMENT_PROMPT_VERSION, MEMBER_ASSESSMENT_RULES_VERSION } from './prompts/index.js';
import { renderMemberSummaryHtml, renderMemberSummaryJson } from './export-service.js';
import * as sourceNormalization from './source-normalization.js';
import * as ingestion from '@ingestion';

const directories: string[] = [];

function makeService(): PersonalWorkspaceService {
  const root = mkdtempSync(join(tmpdir(), 'family-health-service-'));
  directories.push(root);
  return new PersonalWorkspaceService(root, '我的家庭健康', () => new Date('2026-09-18T01:00:00Z'));
}

function rebuildPreviewSources(service: PersonalWorkspaceService, personIds?: string[]) {
  return service.store.listProcessingRebuildSources(personIds)
    .map(({ documentId, personId, sourceObjectId, sha256 }) => ({ documentId, personId, sourceObjectId, sha256 }));
}

/** 仅为旧人工核对/旧流水线兼容测试生成明确的历史文字证据；生产导入仍只准备原件骨架。 */
function installSyntheticLegacyTextEvidence(service: PersonalWorkspaceService, documentId: string): void {
  const source = service.store.listProcessingRebuildSources().find((item) => item.documentId === documentId)!;
  if (source.mediaType !== 'text/plain' || service.store.isDocumentCommitted(documentId)) throw new Error('SYNTHETIC_LEGACY_FIXTURE_SCOPE');
  const manifest = buildTextManifest({ sourceObjectId: source.sourceObjectId, documentId, sha256: source.sha256,
    displayName: source.displayName, text: readFileSync(source.sourcePath, 'utf8'), createdAt: '2026-09-18T01:00:00Z' });
  const fixtureDatabase = new Database(service.store.databasePath);
  fixtureDatabase.transaction(() => {
    fixtureDatabase.prepare('DELETE FROM source_manifest_spans WHERE document_id=?').run(documentId);
    fixtureDatabase.prepare('DELETE FROM source_manifests WHERE document_id=?').run(documentId);
    fixtureDatabase.prepare('DELETE FROM source_spans WHERE document_id=?').run(documentId);
  })();
  fixtureDatabase.close();
  service.store.saveSourceManifest(manifest);
}

// 仅将合成已发布结果写入临时测试库，不调用模型；验证后续真正的服务读取和展示投影。
function saveSyntheticAssessment(service: PersonalWorkspaceService, personId: string, overrides: Partial<MemberAssessmentSnapshotV3> = {}) {
  const snapshot = memberAssessmentSnapshotV3Schema.parse({
    schemaVersion: 3, personId, inputSignature: 'a'.repeat(64), mode: 'full', requestedSystemIds: [],
    id: 'synthetic-assessment', status: 'current', generatedAt: '2026-09-18T00:00:00Z',
    factRevision: service.store.getFactRevision(personId), contextRevision: service.store.getClinicalContextRevision(personId),
    reviewScopeSignature: service.store.getOpenReviewScopeSignature(personId),
    promptVersion: MEMBER_ASSESSMENT_PROMPT_VERSION, rulesVersion: MEMBER_ASSESSMENT_RULES_VERSION,
    modelId: 'synthetic', reasoningEffort: 'medium', validationMode: 'local_only', reviewedTargetIds: [], heldTargetIds: [],
    limitations: [], evidenceCatalog: [], processingPlan: { strategy: 'full', trigger: 'none', partitionCount: 0 }, knowledgeVerifications: [],
    overview: { id: 'overview', headline: '合成健康概况', summary: '请结合报告的检查条件理解。', claimIds: [], actionIds: [], limitations: [] },
    systems: [], claims: [], actions: [], questions: [], knowledgeSources: [], ...overrides
  });
  const database = new Database(service.store.databasePath);
  database.prepare(`INSERT INTO member_assessment_snapshots_v3 (
    id,person_id,input_signature,fact_revision,context_revision,prompt_version,rules_version,model_id,reasoning_effort,validation_mode,payload_json,status,created_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'current',?)`).run(snapshot.id, personId, snapshot.inputSignature,
    snapshot.factRevision, snapshot.contextRevision, snapshot.promptVersion, snapshot.rulesVersion, snapshot.modelId,
    snapshot.reasoningEffort, snapshot.validationMode, JSON.stringify(snapshot), snapshot.generatedAt);
  database.close();
  return snapshot;
}

function createMinimalPdf(text: string): Buffer {
  const escaped = text.replace(/[()\\]/g, (character) => `\\${character}`);
  const content = `BT /F1 12 Tf 10 70 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(body, 'latin1');
}

// 完全合成的检查记录，仅写临时库；不经过模型，也不借用真实成员资料。
function publishExportFixture(
  service: PersonalWorkspaceService,
  personId: string,
  label: string,
  facts: Array<Partial<PublishFactsInput['observations'][number]>>
) {
  const quote = `合成导出回归：${label}。检查时未散瞳。`;
  const source = service.store.putSourceObject({ bytes: Buffer.from(quote), mediaType: 'text/plain', displayName: label });
  const { documentId } = service.store.registerImportedDocument({ sourceObjectId: source.id, personId });
  const sourceSpanId = `export-span-${documentId}`;
  service.store.saveSourceManifest({
    id: `export-manifest-${documentId}`, sourceObjectId: source.id, sha256: source.sha256,
    mediaType: 'text/plain', originalDisplayName: label, totalUnits: 1, coveredUnitIndexes: [0],
    normalizerVersion: 'synthetic-export-test', conversionWarnings: [], createdAt: '2026-09-18T00:00:00Z',
    spans: [{ id: sourceSpanId, documentId, spanKind: 'line', page: null, blockId: null,
      lineStart: 1, lineEnd: 1, quote, readability: 'clear' }]
  });
  const acceptanceId = service.store.saveAcceptanceDecision({
    method: 'auto', actor: 'policy', rulesVersion: 'synthetic-export-test', inputSignature: stableHash({ label }),
    outputHash: stableHash({ label, facts }), reviewRef: null, decision: 'accept'
  });
  service.store.publishFacts({
    personId, documentId, documentCommitKey: stableHash({ documentId, label }),
    expectedRevision: service.store.getFactRevision(personId), changeSetHash: stableHash({ documentId, facts }),
    summary: '合成导出记录', observations: facts.map((fact, index) => ({
      conceptKey: `合成项目${index}`, originalName: `合成项目${index}`, rawText: '1.0', valueKind: 'numeric',
      decimalValue: '1.0', qualifier: 'eq', unit: 'mmol/L', referenceRange: '0-2',
      clinicalDate: '2026-09-10', abnormalFlag: 'normal', specimen: '血清', method: null, bodySite: null,
      ...fact, documentId, sourceSpanId, acceptanceId, evidence: [{ sourceSpanId, quote }]
    }))
  });
  return { documentId, sourceSpanId };
}

// 仅在临时合成库产生任务范围和终态收据，不调用模型；用于检查只读快照的呈现。
function beginSyntheticSnapshotJob(
  service: PersonalWorkspaceService,
  personId: string,
  documentIds: string[],
  stage: 'extract' | 'analyze' = 'extract'
) {
  const accountFingerprint = 'synthetic-snapshot-job-account';
  const consentId = service.store.createManualProcessingConsent({ documentIds, personIds: [personId], accountFingerprint, version: 1 });
  const jobId = service.store.createWaitingAuthBatch({ cutoff: '2026-09-18T01:00:00Z', initialStatus: 'queued', consentId,
    groups: [{ personId, documentIds, stage,
      inputSignature: stableHash({ documentIds, stage, fixtureNumber: service.store.listStoredJobs().length }) }] }).jobIds[0]!;
  const job = service.store.claimNextQueuedJob('synthetic-snapshot-runner', accountFingerprint)!;
  expect(job.id).toBe(jobId);
  const attemptId = service.store.startJobAttempt(jobId, 'synthetic-runtime');
  const guard = { jobId, attemptId, consentId, accountFingerprint };
  return { jobId, guard,
    complete: (documentId: string, outcome: 'published' | 'partial' | 'needs_review' | 'excluded' = 'published') => {
      service.store.markJobDocumentProcessed(jobId, documentId, outcome, guard);
    },
    finish: (status: 'failed' | 'completed_with_issues' | 'succeeded' | 'cancelled' = 'failed') => {
      service.store.finishJobAttempt({ attemptId, status, ...(status === 'failed' ? { errorCode: 'SYNTHETIC_FAILURE' } : {}) });
      service.store.finishJob(jobId, status);
    }
  };
}

function publishedSnapshotDocuments(service: PersonalWorkspaceService, personId: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => publishExportFixture(service, personId,
    `合成任务进度原件${index}.txt`, [{}]).documentId);
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('正常工作区启动投影升级', () => {
  it('仅启动时执行一次自动日期缓存升级，纯读取快照不重复修订结果', () => {
    const upgrade = vi.spyOn(WorkspaceStore.prototype, 'upgradeDirectOriginalReportDateProjection');
    const service = makeService();
    try {
      expect(upgrade).toHaveBeenCalledTimes(1);
      service.getSnapshot(null);
      service.getSnapshot(null);
      expect(upgrade).toHaveBeenCalledTimes(1);
    } finally {
      service.close();
      upgrade.mockRestore();
    }
  });
});

describe('已完成报告的显式日期补核入口', () => {
  const accountState = { status: 'connected' as const, displayLabel: 'synthetic-date-gap@example.test',
    quota: { status: 'available' as const, primaryUsedPercent: 0, secondaryUsedPercent: null, resetsAt: null },
    runtimeVersion: 'synthetic', lastCheckedAt: '2026-09-18T01:00:00Z' };
  function setup() {
    const service = makeService();
    const personId = service.store.createPerson({ displayName: '合成日期成员' }).id;
    const documents = ['合成旧图甲', '合成旧图乙'].map(label => publishExportFixture(service, personId, label, [{}]));
    const db = new Database(service.store.databasePath);
    // 模拟旧版本只保存了报告检查日期、单项日期被隔离的合法历史状态。
    db.prepare('UPDATE observation_revisions SET clinical_date=NULL WHERE source_span_id IN (?,?)')
      .run(...documents.map(document => document.sourceSpanId));
    return { service, personId, documents, db };
  }
  it('无开放事项也可选择日期补核；只排所选原件，原事实及修订不变', () => {
    const { service, documents, db } = setup();
    try {
      const before = db.prepare('SELECT * FROM observation_revisions ORDER BY observation_id,revision').all();
      expect(service.store.listOpenExtractionReviewIssues()).toHaveLength(0);
      expect(service.store.listDateBindingReviewDocumentCounts()).toEqual(new Map(documents.map(document => [document.documentId, 1])));
      const snapshot = service.getSnapshot(accountState);
      expect(snapshot.inbox.filter(item => item.dateBindingReviewCount === 1)).toHaveLength(2);
      expect(snapshot.inbox.every(item => item.status === 'completed')).toBe(true);
      service.processNow({ accountState, consentVersion: 1, documentIds: [documents[0]!.documentId] });
      const jobs = service.store.listStoredJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ stage: 'extract', documentIds: [documents[0]!.documentId] });
      const checkpoint = JSON.parse((db.prepare('SELECT checkpoint_json FROM jobs WHERE id=?').get(jobs[0]!.id) as { checkpoint_json: string }).checkpoint_json);
      expect(checkpoint.repairDocumentIds).toEqual([documents[0]!.documentId]);
      expect(db.prepare('SELECT * FROM observation_revisions ORDER BY observation_id,revision').all()).toEqual(before);
      expect(service.store.listOpenExtractionReviewIssues()).toHaveLength(0);
    } finally { db.close(); service.close(); }
  });
  it('没有显式选择旧报告时不把日期线索当新资料自动重提', () => {
    const { service, db } = setup();
    try {
      service.processNow({ accountState, consentVersion: 1 });
      expect(service.store.listStoredJobs().every(job => job.stage === 'analyze')).toBe(true);
    } finally { db.close(); service.close(); }
  });
  it.each(['date_filled', 'report_date_unknown', 'excluded', 'archived', 'blocking', 'unclosed_attempt'] as const)(
    '%s 时存储事务拒绝旧的补核选择', change => {
      const { service, personId, documents, db } = setup();
      try {
        const id = documents[0]!.documentId;
        expect(service.store.listRepairableExtractionDocumentIds().has(id)).toBe(true);
        if (change === 'date_filled') db.prepare('UPDATE observation_revisions SET clinical_date=? WHERE source_span_id=?').run('2026-09-10', documents[0]!.sourceSpanId);
        if (change === 'report_date_unknown') db.prepare('UPDATE health_events_v2 SET clinical_date=NULL WHERE person_id=?').run(personId);
        if (change === 'excluded') db.prepare('UPDATE documents SET excluded_from_analysis=1 WHERE id=?').run(id);
        if (change === 'archived') db.prepare('UPDATE persons SET archived_at=? WHERE id=?').run('2026-09-18T00:00:00Z', personId);
        if (change === 'blocking') service.store.saveExtractionReviewIssue({ documentId: id, kind: 'overwrite_protected', severity: 'blocking',
          preserveDocumentStatus: true, reasonCodes: ['synthetic_protected'], evidenceRefs: [] });
        if (change === 'unclosed_attempt') beginSyntheticSnapshotJob(service, personId, [documents[1]!.documentId]);
        expect(service.store.listRepairableExtractionDocumentIds().has(id)).toBe(false);
        expect(() => service.processNow({ accountState, consentVersion: 1, documentIds: [id] })).toThrow();
      } finally { db.close(); service.close(); }
    });
});

describe('单报告正式日期纠错入口', () => {
  const accountState = { status: 'connected' as const, displayLabel: 'synthetic-date@example.test',
    quota: { status: 'available' as const, primaryUsedPercent: 0, secondaryUsedPercent: null, resetsAt: null },
    runtimeVersion: 'synthetic', lastCheckedAt: '2026-09-18T01:00:00Z' };
  it('仅授权选中已提交原件，冻结确认版本，不借普通重核扩大范围', () => {
    const service = makeService();
    try {
      const personId = service.store.createPerson({ displayName: '合成纠错成员' }).id;
      const [documentId] = publishedSnapshotDocuments(service, personId, 1);
      const dataRevision = service.getSnapshot(accountState).persons.find((person) => person.id === personId)!.dataRevision;
      const request = { accountState, consentVersion: 1, purpose: 'date_correction' as const,
        dateCorrectionDocumentId: documentId!, expectedDateCorrectionDataRevision: dataRevision };
      expect(() => service.processNow({ ...request, expectedDateCorrectionDataRevision: '0'.repeat(64) })).toThrow('DATE_CORRECTION_SCOPE_CHANGED');
      expect(() => service.processNow({ ...request, documentIds: [documentId!] })).toThrow();
      expect(service.store.listStoredJobs()).toHaveLength(0);
      service.processNow(request);
      const job = service.store.listStoredJobs()[0]!;
      expect(job.documentIds).toEqual([documentId]); expect(job.stage).toBe('extract');
      expect(service.store.isDateCorrectionJob(job.id)).toBe(true);
      expect(() => service.processNow(request)).toThrow();
    } finally { service.close(); }
  });
});

describe('仅指定成员综合的任务隔离', () => {
  const accountState = {
    status: 'connected' as const, displayLabel: 'synthetic-assessment@example.test',
    quota: { status: 'available' as const, primaryUsedPercent: 0, secondaryUsedPercent: null, resetsAt: null },
    runtimeVersion: 'synthetic', lastCheckedAt: '2026-09-18T01:00:00Z'
  };
  const assessmentOptions = (service: PersonalWorkspaceService, personId: string) => ({
    accountState, consentVersion: 1, assessmentPersonId: personId,
    expectedAssessmentDataRevision: service.getSnapshot(accountState).persons.find((person) => person.id === personId)?.dataRevision ?? 'a'.repeat(64)
  });

  it('同成员待处理报告和另一成员待刷新同时存在时，只排一个 analyze 并授权该成员全部既有事实', async () => {
    const service = makeService();
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成综合甲', relation: '本人' });
      const otherPersonId = service.createMember({ displayName: '合成综合乙', relation: '家人', birthYear: null });
      const accepted = [publishExportFixture(service, personId, '合成甲历史一.txt', [{}]),
        publishExportFixture(service, personId, '合成甲历史二.txt', [{}])];
      publishExportFixture(service, otherPersonId, '合成乙历史.txt', [{}]);
      await service.importFiles([{ path: '/tmp/合成甲待处理.txt', bytes: Buffer.from('只属于待处理报告的合成内容') }], personId);
      const before = service.store.listAcceptedObservations();
      const ready = vi.spyOn(service.store, 'listReadyDocuments');
      const consent = vi.spyOn(service.store, 'createManualProcessingConsent');
      const confirmed = assessmentOptions(service, personId);
      const receipt = service.processNow(confirmed);
      expect(receipt.idempotent).toBe(false);
      expect(ready).not.toHaveBeenCalled();
      expect(service.store.listStoredJobs()).toEqual([expect.objectContaining({
        personLabel: '合成综合甲', stage: 'analyze', status: 'queued', documentIds: [expect.any(String)]
      })]);
      const job = service.store.listStoredJobs()[0]!;
      expect(accepted.map((document) => document.documentId)).toContain(job.documentIds[0]);
      expect(service.store.isAssessmentOnlyJob(job.id)).toBe(true);
      expect(consent).toHaveBeenCalledWith(expect.objectContaining({
        assessmentOnly: true, documentIds: job.documentIds, personIds: [personId],
        historicalObservationIds: expect.arrayContaining(before.filter((fact) => fact.personId === personId).map((fact) => fact.id))
      }));
      expect(consent.mock.calls[0]![0].historicalObservationIds).toHaveLength(2);
      const database = new Database(service.store.databasePath, { readonly: true });
      try {
        const scope = JSON.parse((database.prepare('SELECT scope_json FROM consents ORDER BY rowid DESC LIMIT 1').get() as { scope_json: string }).scope_json);
        expect(scope.stages).toEqual(['analyze', 'review_derived', 'publish']);
        expect(scope.stages).not.toContain('extract');
      } finally { database.close(); }
      expect(service.store.listAcceptedObservations()).toEqual(before);
      expect(service.processNow(confirmed))
        .toMatchObject({ batchId: receipt.batchId, idempotent: true });
      expect(service.store.listStoredJobs()).toHaveLength(1);
    } finally { service.close(); }
  });

  it('正常仅更新入口在旧综合失败后可重建同资料综合，连续点击只保留一个新任务', () => {
    const service = makeService();
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成恢复成员', relation: '本人' });
      publishExportFixture(service, personId, '合成恢复历史.txt', [{}]);
      const facts = service.store.listAcceptedObservations();
      const confirmed = assessmentOptions(service, personId);
      service.processNow(confirmed);
      const firstJob = service.store.listStoredJobs()[0]!;
      const database = new Database(service.store.databasePath);
      try {
        database.prepare("UPDATE jobs SET status='failed',stage='review_derived' WHERE id=?").run(firstJob.id);
        const oldJob = database.prepare('SELECT * FROM jobs WHERE id=?').get(firstJob.id);
        const updated = service.processNow(confirmed);
        expect(updated.idempotent).toBe(false);
        expect(service.processNow(confirmed)).toMatchObject({ batchId: updated.batchId, idempotent: true });
        expect(service.store.listStoredJobs()).toHaveLength(2);
        const newJob = service.store.listStoredJobs().find(job => job.id !== firstJob.id)!;
        expect(newJob).toMatchObject({ stage: 'analyze', status: 'queued' });
        expect(service.store.isAssessmentOnlyJob(newJob.id)).toBe(true);
        expect(database.prepare('SELECT * FROM jobs WHERE id=?').get(firstJob.id)).toEqual(oldJob);
        expect(service.store.listAcceptedObservations()).toEqual(facts);
      } finally { database.close(); }
    } finally { service.close(); }
  });

  it('混合范围、非法或未知成员、归档成员、没有已接纳事实时均不建立任务或授权', () => {
    const service = makeService();
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成空成员', relation: '本人' });
      const archivedId = service.createMember({ displayName: '合成归档成员', relation: '家人', birthYear: null });
      publishExportFixture(service, archivedId, '合成归档历史.txt', [{}]);
      service.archiveMember({ personId: archivedId, expectedDisplayRevision: 1, confirmedArchive: true });
      const consent = vi.spyOn(service.store, 'createManualProcessingConsent');
      expect(() => service.processNow({ ...assessmentOptions(service, personId),
        documentIds: ['synthetic-document'] })).toThrow();
      expect(() => service.processNow(assessmentOptions(service, ' '))).toThrow();
      expect(() => service.processNow(assessmentOptions(service, 'unknown-synthetic-person')))
        .toThrow('PERSON_NOT_FOUND');
      expect(() => service.processNow(assessmentOptions(service, archivedId)))
        .toThrow('PERSON_ARCHIVED');
      expect(() => service.processNow(assessmentOptions(service, personId)))
        .toThrow('NO_ACCEPTED_FACTS');
      expect(service.store.listStoredJobs()).toEqual([]);
      expect(consent).not.toHaveBeenCalled();
    } finally { service.close(); }
  });

  it('指定成员综合的用途签名不复用已有通用 analyze 任务', () => {
    const service = makeService();
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成用途成员', relation: '本人' });
      publishExportFixture(service, personId, '合成用途历史.txt', [{}]);
      const general = service.processNow({ accountState, consentVersion: 1 });
      const assessment = service.processNow(assessmentOptions(service, personId));
      expect(assessment.batchId).not.toBe(general.batchId);
      expect(service.store.listStoredJobs()).toHaveLength(2);
      expect(service.store.listStoredJobs().filter((job) => service.store.isAssessmentOnlyJob(job.id))).toHaveLength(1);
    } finally { service.close(); }
  });

  it.each(['facts', 'context'] as const)('确认后 %s 发生变化时拒绝过期版本，且不建立授权或任务', (change) => {
    const service = makeService();
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成冻结成员', relation: '本人' });
      publishExportFixture(service, personId, '合成冻结历史.txt', [{}]);
      const confirmed = assessmentOptions(service, personId);
      if (change === 'facts') publishExportFixture(service, personId, '合成确认后新增.txt', [{}]);
      else service.createManualNote({ personId, kind: 'free_text', immutableText: '合成确认后本人补充',
        effectiveDate: null, structuredFields: {}, expectedContextRevision: 0 });
      const consent = vi.spyOn(service.store, 'createManualProcessingConsent');
      expect(() => service.processNow(confirmed)).toThrow('ASSESSMENT_SCOPE_CHANGED');
      expect(consent).not.toHaveBeenCalled();
      expect(service.store.listStoredJobs()).toEqual([]);
      expect(service.processNow(assessmentOptions(service, personId))).toMatchObject({ idempotent: false });
      expect(consent).toHaveBeenCalledTimes(1);
    } finally { service.close(); }
  });

  it('缺少确认版本或仅带版本时拒绝，不能落入通用处理路径', () => {
    const service = makeService();
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成缺省版本成员', relation: '本人' });
      publishExportFixture(service, personId, '合成缺省版本历史.txt', [{}]);
      const consent = vi.spyOn(service.store, 'createManualProcessingConsent');
      expect(() => service.processNow({ accountState, consentVersion: 1, assessmentPersonId: personId })).toThrow();
      expect(() => service.processNow({ accountState, consentVersion: 1, expectedAssessmentDataRevision: 'a'.repeat(64) })).toThrow();
      expect(consent).not.toHaveBeenCalled();
      expect(service.store.listStoredJobs()).toEqual([]);
    } finally { service.close(); }
  });
});

describe('从原始资料重新验收处理流程', () => {
  const accountState = {
    status: 'connected' as const, displayLabel: 'synthetic-account@example.test',
    quota: { status: 'available' as const, primaryUsedPercent: 0, secondaryUsedPercent: null, resetsAt: null },
    runtimeVersion: 'synthetic', lastCheckedAt: '2026-09-18T01:00:00Z'
  };

  it('通过正常入口保存独立恢复点、更新证据并建立全新授权批次，不要求再次上传', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '合成重建成员', relation: '本人' });
    const { documentId } = publishExportFixture(service, personId, '合成重建报告.txt', [{
      originalName: '合成检查项目', conceptKey: '合成检查项目', rawText: '5.2', decimalValue: '5.2'
    }]);
    service.store.confirmPersonNameAlias({ personId, reportedName: '合成重建别名' });
    const note = service.store.createManualNote({ personId, kind: 'free_text', immutableText: '本人补充不能清空',
      effectiveDate: null, structuredFields: {}, expectedContextRevision: 0 });
    const source = service.store.listProcessingRebuildSources()[0]!;
    const original = readFileSync(source.sourcePath);
    expect(service.store.listAcceptedObservations(personId)).toHaveLength(1);
    expect(service.getSnapshot(accountState).processingRebuildSources).toEqual(rebuildPreviewSources(service));
    const receipt = await service.rebuildProcessingFromSources({ accountState, consentVersion: 1,
      expectedSources: rebuildPreviewSources(service),
      confirmedRebuildReportResults: true,
      confirmedPersonAliases: [{ personId, reportedName: '本次新确认的合成别名' }] });
    expect(receipt).toMatchObject({ documentCount: 1, personCount: 1, recoveryPointCreated: true });
    expect(service.store.listAcceptedObservations(personId)).toEqual([]);
    expect(service.store.listReadyDocuments()).toEqual([{ id: documentId, personId }]);
    expect(service.store.listManualNotes(personId)).toEqual([note]);
    expect(service.store.isConfirmedPersonName(personId, '合成重建别名')).toBe(true);
    expect(service.store.isConfirmedPersonName(personId, '本次新确认的合成别名')).toBe(true);
    expect(readFileSync(source.sourcePath)).toEqual(original);
    expect(service.store.getDocumentExtractionBundle(documentId).manifest.normalizerVersion).not.toBe('synthetic-export-test');
    expect(readdirSync(service.store.schemaBackupDirectory)).toEqual(expect.arrayContaining([
      `processing-rebuild-${receipt.rebuildId}.db`, `processing-rebuild-${receipt.rebuildId}.json`
    ]));
    const fingerprint = stableHash({ provider: 'codex-chatgpt', displayLabel: accountState.displayLabel });
    const job = service.store.claimNextQueuedJob('synthetic-rebuild', fingerprint)!;
    expect(job.documentIds).toEqual([documentId]);
    expect(job.stage).toBe('extract');
    service.close();
  });

  it('准备失败、未明确确认或账号未连接都不会清理旧事实', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '合成失败成员', relation: '本人' });
    publishExportFixture(service, personId, '合成原报告.txt', [{}]);
    const options = { accountState, consentVersion: 1, confirmedRebuildReportResults: true as const,
      expectedSources: rebuildPreviewSources(service) };
    await expect(service.rebuildProcessingFromSources({ ...options,
      confirmedRebuildReportResults: false as unknown as true })).rejects.toThrow('PROCESSING_REBUILD_AUTH_REQUIRED');
    await expect(service.rebuildProcessingFromSources({ ...options,
      accountState: { ...accountState, displayLabel: null } })).rejects.toThrow('AUTH_REQUIRED');
    expect(service.store.listAcceptedObservations(personId)).toHaveLength(1);
    const source = service.store.listProcessingRebuildSources()[0]!;
    rmSync(source.sourcePath);
    await expect(service.rebuildProcessingFromSources(options)).rejects.toThrow();
    expect(service.store.listAcceptedObservations(personId)).toHaveLength(1);
    expect(service.store.isDocumentCommitted(source.documentId)).toBe(true);
    expect(existsSync(service.store.schemaBackupDirectory)).toBe(false);
    service.close();
  });

  it('重建前逐份真实生成完整模型输入并立即释放，全部成功后才备份和清理', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '合成渲染验收成员', relation: '本人' });
    publishExportFixture(service, personId, '合成旧结果.txt', [{}]);
    await service.importFiles([{ path: '合成完整原页.pdf', bytes: createMinimalPdf('Synthetic complete original') }], personId);
    const realPrepare = ingestion.prepareDirectOriginalReport;
    const preparedRoots: string[] = [];
    const preparation = vi.spyOn(ingestion, 'prepareDirectOriginalReport').mockImplementation(async (input) => {
      expect(preparedRoots.every((root) => !existsSync(root))).toBe(true);
      expect(service.store.listAcceptedObservations(personId)).toHaveLength(1);
      expect(existsSync(service.store.schemaBackupDirectory)).toBe(false);
      const prepared = await realPrepare(input);
      preparedRoots.push(prepared.tempRoot);
      if (input.displayName.endsWith('.pdf')) {
        expect(prepared.imagePaths).toHaveLength(1);
        expect(prepared.imagePaths.every(existsSync)).toBe(true);
        expect(prepared.manifest.spans.every((span) => span.quote === null && !span.visualEvidence && !span.modelEvidence)).toBe(true);
      }
      return prepared;
    });
    try {
      const receipt = await service.rebuildProcessingFromSources({ accountState, consentVersion: 1,
        expectedSources: rebuildPreviewSources(service), confirmedRebuildReportResults: true });
      expect(receipt.documentCount).toBe(2);
      expect(preparation).toHaveBeenCalledTimes(2);
      expect(preparedRoots.every((root) => !existsSync(root))).toBe(true);
      expect(service.store.listAcceptedObservations(personId)).toEqual([]);
    } finally { preparation.mockRestore(); service.close(); }
  });

  it('第二份原件渲染遇到磁盘写满时不清理旧结果、背景或计划，不产生授权任务', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '合成空间保护成员', relation: '本人' });
    const reports = ['合成空间甲.txt', '合成空间乙.txt'].map((label) => publishExportFixture(service, personId, label, [{}]));
    service.store.createManualNote({ personId, kind: 'goal', immutableText: '合成仍应保留的背景',
      effectiveDate: null, structuredFields: {}, expectedContextRevision: 0 });
    service.store.createUserAction({ personId, title: '合成仍应保留的计划', detail: '合成计划正文', dueDate: null, dueText: null });
    const before = { facts: service.store.listAcceptedObservations(personId), notes: service.store.listManualNotes(personId),
      plans: service.store.listActionItems(personId), manifests: reports.map(({ documentId }) => service.store.getDocumentExtractionBundle(documentId).manifest) };
    const realPrepare = ingestion.prepareDirectOriginalReport;
    const preparedRoots: string[] = [];
    const full = Object.assign(new Error('synthetic write failure'), { code: 'ENOSPC' });
    const preparation = vi.spyOn(ingestion, 'prepareDirectOriginalReport')
      .mockImplementationOnce(async (input) => {
        const prepared = await realPrepare(input); preparedRoots.push(prepared.tempRoot); return prepared;
      }).mockImplementationOnce(async () => {
        expect(preparedRoots.every((root) => !existsSync(root))).toBe(true);
        throw full;
      });
    const consent = vi.spyOn(service.store, 'createManualProcessingConsent');
    try {
      await expect(service.rebuildProcessingFromSources({ accountState, consentVersion: 1,
        expectedSources: rebuildPreviewSources(service), personIds: [personId], confirmedRebuildReportResults: true,
        clearPersonalData: true, confirmedClearPersonalData: true })).rejects.toBe(full);
      expect(preparation).toHaveBeenCalledTimes(2);
      expect(service.store.listAcceptedObservations(personId)).toEqual(before.facts);
      expect(service.store.listManualNotes(personId)).toEqual(before.notes);
      expect(service.store.listActionItems(personId)).toEqual(before.plans);
      expect(reports.map(({ documentId }) => service.store.getDocumentExtractionBundle(documentId).manifest)).toEqual(before.manifests);
      expect(consent).not.toHaveBeenCalled();
      expect(service.store.listStoredJobs()).toEqual([]);
      expect(existsSync(service.store.schemaBackupDirectory)).toBe(false);
    } finally { preparation.mockRestore(); consent.mockRestore(); service.close(); }
  });

  it('真实模型输入缺少已确认页映射时仍拒绝清理，并释放该份临时目录', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '合成输入覆盖成员', relation: '本人' });
    const { documentId } = publishExportFixture(service, personId, '合成输入覆盖.txt', [{}]);
    const realPrepare = ingestion.prepareDirectOriginalReport;
    let preparedRoot: string | undefined;
    const preparation = vi.spyOn(ingestion, 'prepareDirectOriginalReport').mockImplementationOnce(async (input) => {
      const prepared = await realPrepare(input); preparedRoot = prepared.tempRoot;
      return { ...prepared, unitMappings: [] };
    });
    try {
      await expect(service.rebuildProcessingFromSources({ accountState, consentVersion: 1,
        expectedSources: rebuildPreviewSources(service), confirmedRebuildReportResults: true }))
        .rejects.toThrow('PROCESSING_REBUILD_ORIGINAL_PREPARATION_INCOMPLETE');
      expect(preparedRoot).toBeDefined(); expect(existsSync(preparedRoot!)).toBe(false);
      expect(service.store.listAcceptedObservations(personId)).toHaveLength(1);
      expect(service.store.isDocumentCommitted(documentId)).toBe(true);
      expect(service.store.listStoredJobs()).toEqual([]);
      expect(existsSync(service.store.schemaBackupDirectory)).toBe(false);
    } finally { preparation.mockRestore(); service.close(); }
  });

  it.each(['new_report', 'excluded_report', 'document_identity', 'person_identity', 'object_identity', 'source_hash'] as const)(
    '用户确认到请求入口间的范围变化在读原件前拒绝，不创建恢复点或授权：%s', async (change) => {
      const service = makeService();
      const selected = service.ensurePrimaryMember({ displayName: '合成预览成员', relation: '本人' });
      const other = service.createMember({ displayName: '合成预览旁人', relation: '家人', birthYear: null });
      const report = publishExportFixture(service, selected, '合成已确认报告.txt', [{}]);
      const expectedSources = service.getSnapshot(accountState).processingRebuildSources!;
      if (change === 'new_report') publishExportFixture(service, selected, '合成确认后新增.txt', [{}]);
      if (change === 'excluded_report') service.setDocumentIncluded({ documentId: report.documentId,
        included: false, confirmedExclusion: true });
      if (change === 'document_identity') expectedSources[0]!.documentId = '20000000-0000-4000-8000-000000000099';
      if (change === 'person_identity') expectedSources[0]!.personId = other;
      if (change === 'object_identity') expectedSources[0]!.sourceObjectId = '30000000-0000-4000-8000-000000000099';
      if (change === 'source_hash') expectedSources[0]!.sha256 = 'b'.repeat(64);
      const before = {
        facts: service.store.listAcceptedObservations(), notes: service.store.listManualNotes(),
        manifest: service.store.getDocumentExtractionBundle(report.documentId).manifest
      };
      const preparation = vi.spyOn(sourceNormalization, 'normalizeStoredSource');
      const consent = vi.spyOn(service.store, 'createManualProcessingConsent');
      try {
        await expect(service.rebuildProcessingFromSources({ accountState, consentVersion: 1, personIds: [selected],
          expectedSources, confirmedRebuildReportResults: true, clearPersonalData: true,
          confirmedClearPersonalData: true })).rejects.toThrow(
            change === 'excluded_report' ? 'PROCESSING_REBUILD_PERSON_SCOPE_INVALID' : 'PROCESSING_REBUILD_SOURCE_SCOPE_CHANGED');
        expect(preparation).not.toHaveBeenCalled(); expect(consent).not.toHaveBeenCalled();
        expect(existsSync(service.store.schemaBackupDirectory)).toBe(false);
        expect(service.store.listStoredJobs()).toEqual([]);
        expect(service.store.listAcceptedObservations()).toEqual(before.facts);
        expect(service.store.listManualNotes()).toEqual(before.notes);
        expect(service.store.getDocumentExtractionBundle(report.documentId).manifest).toEqual(before.manifest);
      } finally { preparation.mockRestore(); consent.mockRestore(); service.close(); }
    }
  );

  it('所选成员之外新增报告不扩大确认范围，也不妨碍原确认集合按任意顺序重建', async () => {
    const service = makeService();
    const selected = service.ensurePrimaryMember({ displayName: '合成预览范围', relation: '本人' });
    const other = service.createMember({ displayName: '合成预览范围外', relation: '家人', birthYear: null });
    publishExportFixture(service, selected, '合成预览范围甲.txt', [{}]);
    publishExportFixture(service, selected, '合成预览范围乙.txt', [{}]);
    const expectedSources = service.getSnapshot(accountState).processingRebuildSources!
      .filter((source) => source.personId === selected).reverse();
    const unselected = publishExportFixture(service, other, '合成预览范围外新增.txt', [{}]);
    const before = service.store.listAcceptedObservations(other);
    try {
      const receipt = await service.rebuildProcessingFromSources({ accountState, consentVersion: 1,
        personIds: [selected], expectedSources, confirmedRebuildReportResults: true,
        clearPersonalData: true, confirmedClearPersonalData: true });
      expect(receipt).toMatchObject({ documentCount: 2, personCount: 1 });
      expect(service.store.listStoredJobs()[0]!.documentIds.sort()).toEqual(expectedSources.map((source) => source.documentId).sort());
      expect(service.store.listAcceptedObservations(other)).toEqual(before);
      expect(service.store.isDocumentCommitted(unselected.documentId)).toBe(true);
    } finally { service.close(); }
  });

  it('显式全清通过正常入口保留两位成员与原件，清除所有本人背景和计划，并使用新稳定原件页骨架', async () => {
    const service = makeService();
    const first = service.ensurePrimaryMember({ displayName: '合成重建甲', relation: '本人' });
    const second = service.createMember({ displayName: '合成重建乙', relation: '家人', birthYear: null });
    const ids = [first, second];
    for (const personId of ids) {
      publishExportFixture(service, personId, `合成清空-${personId}.txt`, [{}]);
      service.store.createManualNote({ personId, kind: 'goal', immutableText: '合成旧本人背景', effectiveDate: null,
        structuredFields: {}, expectedContextRevision: 0 });
      service.store.createUserAction({ personId, title: '合成旧计划', detail: '合成旧目标', dueDate: null, dueText: null });
    }
    service.store.confirmPersonNameAlias({ personId: first, reportedName: '合成确认昵称' });
    const sources = service.store.listProcessingRebuildSources();
    const receipt = await service.rebuildProcessingFromSources({ accountState, consentVersion: 1,
      expectedSources: rebuildPreviewSources(service),
      confirmedRebuildReportResults: true, clearPersonalData: true, confirmedClearPersonalData: true });
    expect(receipt).toMatchObject({ documentCount: 2, personCount: 2, recoveryPointCreated: true });
    expect(service.store.listManualNotes()).toEqual([]); expect(service.store.listActionItems()).toEqual([]);
    expect(service.store.isConfirmedPersonName(first, '合成确认昵称')).toBe(true);
    for (const personId of ids) {
      expect(service.store.listAcceptedObservations(personId)).toEqual([]);
      expect(service.store.getClinicalContextRevision(personId)).toBe(0);
    }
    for (const source of sources) {
      const prepared = await sourceNormalization.normalizeStoredSource({ store: service.store, documentId: source.documentId,
        sourceObjectId: source.sourceObjectId, sha256: source.sha256, displayName: source.displayName,
        bytes: readFileSync(source.sourcePath), createdAt: '2026-09-18T01:00:00Z' });
      const stored = service.store.getDocumentExtractionBundle(source.documentId).manifest;
      expect(stored.spans).toEqual(prepared.spans);
      expect(stored.spans.every((span) => span.quote === null && !span.visualEvidence && !span.modelEvidence)).toBe(true);
    }
    service.close();
  });

  it('按成员全清只准备和排队选中原件，另一成员的事实、背景、快照、计划和共享授权原样保留', async () => {
    const service = makeService();
    const selected = service.ensurePrimaryMember({ displayName: '合成选中成员', relation: '本人' });
    const preserved = service.createMember({ displayName: '合成保留成员', relation: '家人', birthYear: null });
    const selectedDocuments = ['合成选中甲.txt', '合成选中乙.txt'].map((label) =>
      publishExportFixture(service, selected, label, [{}]).documentId);
    const preservedDocument = publishExportFixture(service, preserved, '合成未选中.txt', [{}]).documentId;
    for (const personId of [selected, preserved]) {
      service.store.createManualNote({ personId, kind: 'goal', immutableText: `合成本人目标-${personId}`,
        effectiveDate: null, structuredFields: {}, expectedContextRevision: 0 });
      service.store.createUserAction({ personId, title: '合成已存在计划', detail: `合成计划-${personId}`,
        dueDate: null, dueText: null });
      service.store.confirmPersonNameAlias({ personId, reportedName: `合成昵称-${personId}` });
      saveSyntheticAssessment(service, personId, { id: `synthetic-scoped-assessment-${personId}` });
    }
    const accountFingerprint = stableHash({ provider: 'codex-chatgpt', displayLabel: accountState.displayLabel });
    const sharedConsentId = service.store.createManualProcessingConsent({
      documentIds: [...selectedDocuments, preservedDocument], personIds: [selected, preserved], accountFingerprint, version: 1
    });
    const previousBatch = service.store.createWaitingAuthBatch({ cutoff: '2026-09-18T00:00:00Z',
      initialStatus: 'waiting_auth', consentId: sharedConsentId,
      groups: [selected, preserved].map((personId) => ({ personId,
        documentIds: personId === selected ? selectedDocuments : [preservedDocument], stage: 'extract' as const,
        inputSignature: stableHash({ personId, fixture: 'scoped-rebuild-old-batch' }) })) });
    const readFixtureRow = (table: 'consents' | 'jobs' | 'documents', id: string) => {
      const database = new Database(service.store.databasePath, { readonly: true });
      try { return database.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id); }
      finally { database.close(); }
    };
    const before = {
      facts: service.store.listAcceptedObservations(preserved), notes: service.store.listManualNotes(preserved),
      plans: service.store.listActionItems(preserved), snapshots: service.store.listMemberAssessmentSnapshots(preserved, true),
      factRevision: service.store.getFactRevision(preserved), contextRevision: service.store.getClinicalContextRevision(preserved),
      manifest: service.store.getDocumentExtractionBundle(preservedDocument).manifest,
      document: readFixtureRow('documents', preservedDocument),
      consent: readFixtureRow('consents', sharedConsentId), job: readFixtureRow('jobs', previousBatch.jobIds[1]!)
    };
    const sources = service.store.listProcessingRebuildSources();
    const originals = sources.map((source) => ({ ...source, bytes: readFileSync(source.sourcePath) }));
    const preparation = vi.spyOn(sourceNormalization, 'normalizeStoredSource');
    const consent = vi.spyOn(service.store, 'createManualProcessingConsent');
    try {
      const receipt = await service.rebuildProcessingFromSources({ accountState, consentVersion: 2,
        expectedSources: rebuildPreviewSources(service, [selected]),
        personIds: [selected], confirmedRebuildReportResults: true,
        clearPersonalData: true, confirmedClearPersonalData: true });
      expect(receipt).toMatchObject({ documentCount: 2, personCount: 1, recoveryPointCreated: true });
      expect(preparation.mock.calls.map(([input]) => input.documentId).sort()).toEqual([...selectedDocuments].sort());
      expect(consent).toHaveBeenCalledExactlyOnceWith({ documentIds: expect.arrayContaining(selectedDocuments),
        personIds: [selected], accountFingerprint, version: 2 });
      expect(consent.mock.calls[0]![0].documentIds).toHaveLength(2);
      expect(service.store.listAcceptedObservations(selected)).toEqual([]);
      expect(service.store.listManualNotes(selected)).toEqual([]);
      expect(service.store.listActionItems(selected)).toEqual([]);
      expect(service.store.listMemberAssessmentSnapshots(selected, true)).toEqual([]);
      expect(service.store.getClinicalContextRevision(selected)).toBe(0);
      expect(readFixtureRow('jobs', previousBatch.jobIds[0]!)).toBeUndefined();
      expect(service.store.listAcceptedObservations(preserved)).toEqual(before.facts);
      expect(service.store.listManualNotes(preserved)).toEqual(before.notes);
      expect(service.store.listActionItems(preserved)).toEqual(before.plans);
      expect(service.store.listMemberAssessmentSnapshots(preserved, true)).toEqual(before.snapshots);
      expect(service.store.getFactRevision(preserved)).toBe(before.factRevision);
      expect(service.store.getClinicalContextRevision(preserved)).toBe(before.contextRevision);
      expect(service.store.getDocumentExtractionBundle(preservedDocument).manifest).toEqual(before.manifest);
      expect(readFixtureRow('documents', preservedDocument)).toEqual(before.document);
      expect(readFixtureRow('consents', sharedConsentId)).toEqual(before.consent);
      expect(readFixtureRow('jobs', previousBatch.jobIds[1]!)).toEqual(before.job);
      for (const source of originals) {
        expect(readFileSync(source.sourcePath)).toEqual(source.bytes);
        expect(service.store.getDocumentOriginalSource(source.documentId).sourceObjectId).toBe(source.sourceObjectId);
        expect(service.store.isConfirmedPersonName(source.personId, `合成昵称-${source.personId}`)).toBe(true);
      }
      for (const documentId of selectedDocuments) {
        expect(service.store.isDocumentCommitted(documentId)).toBe(false);
        expect(service.store.getDocumentExtractionBundle(documentId).manifest.normalizerVersion)
          .toBe('direct-original-preparation-v1');
      }
      const queued = service.store.listStoredJobs().filter((job) => job.status === 'queued');
      expect(queued).toHaveLength(1);
      expect([...queued[0]!.documentIds].sort()).toEqual([...selectedDocuments].sort());
      const execution = service.store.claimNextQueuedJob('synthetic-scoped-rebuild', accountFingerprint)!;
      expect(execution.personId).toBe(selected);
      expect([...execution.documentIds].sort()).toEqual([...selectedDocuments].sort());
      expect(execution.stage).toBe('extract');
    } finally { preparation.mockRestore(); consent.mockRestore(); service.close(); }
  });

  it('按成员清空仍必须分别确认报告重建及本人资料清空，拒绝时不准备、不清理或排队', async () => {
    const service = makeService();
    const selected = service.ensurePrimaryMember({ displayName: '合成确认成员', relation: '本人' });
    const preserved = service.createMember({ displayName: '合成确认旁人', relation: '家人', birthYear: null });
    publishExportFixture(service, selected, '合成确认范围.txt', [{}]);
    publishExportFixture(service, preserved, '合成确认保留.txt', [{}]);
    service.store.createManualNote({ personId: selected, kind: 'goal', immutableText: '合成应保留目标',
      effectiveDate: null, structuredFields: {}, expectedContextRevision: 0 });
    const facts = service.store.listAcceptedObservations();
    const notes = service.store.listManualNotes();
    const preparation = vi.spyOn(sourceNormalization, 'normalizeStoredSource');
    try {
      const base = { accountState, consentVersion: 1, personIds: [selected],
        expectedSources: rebuildPreviewSources(service, [selected]),
        confirmedRebuildReportResults: true as const };
      await expect(service.rebuildProcessingFromSources({ ...base,
        confirmedRebuildReportResults: false as unknown as true, clearPersonalData: true,
        confirmedClearPersonalData: true })).rejects.toThrow('PROCESSING_REBUILD_AUTH_REQUIRED');
      await expect(service.rebuildProcessingFromSources({ ...base,
        clearPersonalData: true })).rejects.toThrow('PROCESSING_REBUILD_AUTH_REQUIRED');
      await expect(service.rebuildProcessingFromSources({ ...base,
        confirmedClearPersonalData: true })).rejects.toThrow('PROCESSING_REBUILD_AUTH_REQUIRED');
      expect(preparation).not.toHaveBeenCalled();
      expect(service.store.listAcceptedObservations()).toEqual(facts);
      expect(service.store.listManualNotes()).toEqual(notes);
      expect(service.store.listStoredJobs()).toEqual([]);
      expect(existsSync(service.store.schemaBackupDirectory)).toBe(false);
    } finally { preparation.mockRestore(); service.close(); }
  });

  it('选中范围在原件准备期间变化时整轮拒绝，保留两人的已有结果且不生成新授权任务', async () => {
    const service = makeService();
    const selected = service.ensurePrimaryMember({ displayName: '合成准备成员', relation: '本人' });
    const preserved = service.createMember({ displayName: '合成准备旁人', relation: '家人', birthYear: null });
    const document = publishExportFixture(service, selected, '合成准备范围.txt', [{}]);
    publishExportFixture(service, preserved, '合成准备保留.txt', [{}]);
    const facts = service.store.listAcceptedObservations();
    const real = sourceNormalization.normalizeStoredSource;
    const preparation = vi.spyOn(sourceNormalization, 'normalizeStoredSource').mockImplementationOnce(async (input) => {
      const manifest = await real(input);
      // 仅改变临时测试库模拟准备期间新导入；正常入口必须重新确认扩大的范围。
      const source = service.store.putSourceObject({ bytes: Buffer.from('合成准备期间新增原件'),
        mediaType: 'text/plain', displayName: '合成准备新增.txt' });
      service.store.registerImportedDocument({ sourceObjectId: source.id, personId: selected });
      return manifest;
    });
    const consent = vi.spyOn(service.store, 'createManualProcessingConsent');
    try {
      await expect(service.rebuildProcessingFromSources({ accountState, consentVersion: 1, personIds: [selected],
        expectedSources: rebuildPreviewSources(service, [selected]),
        confirmedRebuildReportResults: true, clearPersonalData: true, confirmedClearPersonalData: true }))
        .rejects.toThrow('PROCESSING_REBUILD_SOURCE_SCOPE_CHANGED');
      expect(service.store.listAcceptedObservations()).toEqual(facts);
      expect(service.store.isDocumentCommitted(document.documentId)).toBe(true);
      expect(service.store.getDocumentExtractionBundle(document.documentId).manifest.normalizerVersion).toBe('synthetic-export-test');
      expect(service.store.listStoredJobs()).toEqual([]);
      expect(consent).not.toHaveBeenCalled();
      expect(existsSync(service.store.schemaBackupDirectory)).toBe(false);
    } finally { preparation.mockRestore(); consent.mockRestore(); service.close(); }
  });

  it('全清时排除的原件重新纳入先准备缺失骨架，保持原文件且不沿用旧事实', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '合成重新纳入成员', relation: '本人' });
    publishExportFixture(service, personId, '合成保留纳入.txt', [{ rawText: '11', decimalValue: '11' }]);
    const excluded = publishExportFixture(service, personId, '合成暂时排除.txt', [{ rawText: '22', decimalValue: '22' }]);
    const before = service.store.getDocumentOriginalSource(excluded.documentId);
    const bytes = readFileSync(before.sourcePath);
    service.setDocumentIncluded({ documentId: excluded.documentId, included: false, confirmedExclusion: true });
    const receipt = await service.rebuildProcessingFromSources({ accountState, consentVersion: 1,
      expectedSources: rebuildPreviewSources(service),
      confirmedRebuildReportResults: true, clearPersonalData: true, confirmedClearPersonalData: true });
    expect(receipt.documentCount).toBe(1);
    expect(service.store.countSourceSpans(excluded.documentId)).toBe(0);
    expect(service.store.listAcceptedObservations(personId)).toEqual([]);
    const input = { documentId: excluded.documentId, included: true as const };
    expect(service.store.getDocumentOriginalSource(excluded.documentId).displayName).toBe(before.displayName);
    expect(await service.prepareDocumentForReinclusion(input)).toEqual({ prepared: true });
    expect(service.store.getDocumentOriginalSource(excluded.documentId).excludedFromAnalysis).toBe(true);
    expect(service.setDocumentIncluded(input)).toEqual({ included: true, personId });
    const current = service.store.getDocumentExtractionBundle(excluded.documentId).manifest;
    expect(current.normalizerVersion).toBe('direct-original-preparation-v1');
    expect(current.spans.every((span) => span.quote === null && !span.modelEvidence && !span.visualEvidence)).toBe(true);
    const prepared = await sourceNormalization.normalizeStoredSource({ store: service.store, documentId: excluded.documentId,
      sourceObjectId: before.sourceObjectId, sha256: before.sha256, displayName: before.displayName,
      bytes, createdAt: '2026-09-18T01:00:00Z' });
    expect(current.spans).toEqual(prepared.spans);
    expect(readFileSync(before.sourcePath)).toEqual(bytes);
    expect(service.store.listAcceptedObservations(personId)).toEqual([]);
    expect(await service.prepareDocumentForReinclusion(input)).toEqual({ prepared: false });
    expect(service.store.getDocumentExtractionBundle(excluded.documentId).manifest).toEqual(current);
    service.close();
  });

  it('重新纳入已准备或已提交资料不重新读原件、不覆盖来源或已接纳事实', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '合成保留成员', relation: '本人' });
    const published = publishExportFixture(service, personId, '合成已提交.txt', [{ rawText: '33', decimalValue: '33' }]);
    const before = service.store.getDocumentExtractionBundle(published.documentId).manifest;
    const facts = service.store.listAcceptedObservations(personId);
    service.setDocumentIncluded({ documentId: published.documentId, included: false, confirmedExclusion: true });
    const spy = vi.spyOn(sourceNormalization, 'normalizeStoredSource');
    try {
      const input = { documentId: published.documentId, included: true as const };
      expect(await service.prepareDocumentForReinclusion(input)).toEqual({ prepared: false });
      expect(spy).not.toHaveBeenCalled();
      service.setDocumentIncluded(input);
      expect(service.store.getDocumentExtractionBundle(published.documentId).manifest).toEqual(before);
      expect(service.store.listAcceptedObservations(personId)).toEqual(facts);
      expect(service.store.listImportedDocuments().find((item) => item.id === published.documentId)?.status).toBe('completed');
    } finally { spy.mockRestore(); service.close(); }
  });

  it('重新纳入准备期间成员范围变化时不保存骨架，也不擅自改变排除状态', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '合成范围保护成员', relation: '本人' });
    const doc = publishExportFixture(service, personId, '合成范围保护.txt', [{}]);
    service.setDocumentIncluded({ documentId: doc.documentId, included: false, confirmedExclusion: true });
    const beforeOriginal = service.store.getDocumentOriginalSource(doc.documentId);
    service.store.registerSourceOccurrence({ sourceObjectId: beforeOriginal.sourceObjectId, bindingId: null,
      originalPath: beforeOriginal.sourcePath, displayName: beforeOriginal.displayName });
    const isolated = new Database(service.store.databasePath);
    isolated.prepare('DELETE FROM source_manifest_spans WHERE document_id=?').run(doc.documentId);
    isolated.prepare('DELETE FROM source_manifests WHERE document_id=?').run(doc.documentId);
    isolated.prepare('DELETE FROM source_spans WHERE document_id=?').run(doc.documentId);
    isolated.close();
    const real = sourceNormalization.normalizeStoredSource;
    const spy = vi.spyOn(sourceNormalization, 'normalizeStoredSource').mockImplementation(async (input) => {
      const manifest = await real(input);
      const fixtureDatabase = new Database(service.store.databasePath);
      fixtureDatabase.prepare('UPDATE documents SET excluded_from_analysis=0 WHERE id=?').run(doc.documentId);
      fixtureDatabase.close();
      return manifest;
    });
    try {
      await expect(service.prepareDocumentForReinclusion({ documentId: doc.documentId, included: true }))
        .rejects.toThrow('DOCUMENT_REINCLUSION_SOURCE_SCOPE_CHANGED');
      expect(service.store.countSourceSpans(doc.documentId)).toBe(0);
      expect(service.store.getDocumentOriginalSource(doc.documentId).status).toBe('ignored');
    } finally { spy.mockRestore(); service.close(); }
  });

  it('准备期间账号变化时，最终同步授权检查阻止清理和重新发送', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '合成账号保护成员', relation: '本人' });
    const { documentId } = publishExportFixture(service, personId, '合成账号保护.txt', [{}]);
    let checked = false;
    await expect(service.rebuildProcessingFromSources({ accountState, consentVersion: 1,
      expectedSources: rebuildPreviewSources(service),
      confirmedRebuildReportResults: true, validateBeforeCommit: () => {
        checked = true;
        expect(readdirSync(service.store.schemaBackupDirectory).some((file) => file.startsWith('processing-rebuild-'))).toBe(true);
        throw new Error('AUTH_CHANGED');
      } })).rejects.toThrow('AUTH_CHANGED');
    expect(checked).toBe(true);
    expect(service.store.listAcceptedObservations(personId)).toHaveLength(1);
    expect(service.store.isDocumentCommitted(documentId)).toBe(true);
    expect(service.store.listStoredJobs()).toEqual([]);
    service.close();
  });

  it.each(['empty_spans', 'missing_unit'] as const)(
    '原件技术准备不完整时保留旧结果且不清库：%s', async (problem) => {
      const service = makeService();
      const personId = service.ensurePrimaryMember({ displayName: '合成图像保护成员', relation: '本人' });
      const { documentId } = publishExportFixture(service, personId, '合成图像保护.txt', [{}]);
      const manifest = service.store.getDocumentExtractionBundle(documentId).manifest;
      const spy = vi.spyOn(sourceNormalization, 'normalizeStoredSource').mockResolvedValueOnce({
        ...manifest, ...(problem === 'empty_spans' ? { spans: [] } : { totalUnits: manifest.totalUnits + 1 })
      });
      try {
        await expect(service.rebuildProcessingFromSources({ accountState, consentVersion: 1,
          expectedSources: rebuildPreviewSources(service),
          confirmedRebuildReportResults: true })).rejects.toThrow('PROCESSING_REBUILD_ORIGINAL_PREPARATION_INCOMPLETE');
        expect(service.store.listAcceptedObservations(personId)).toHaveLength(1);
        expect(service.store.isDocumentCommitted(documentId)).toBe(true);
        expect(existsSync(service.store.schemaBackupDirectory)).toBe(false);
      } finally {
        spy.mockRestore();
        service.close();
      }
    }
  );
});

describe('成员完整摘要导出', () => {
  it('导出超过 500 条完整记录且保留文字、无日期和检查条件，不扩大日常快照', () => {
    const service = makeService();
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成成员甲', relation: '本人' });
      const otherId = service.createMember({ displayName: '合成成员乙', relation: '家人', birthYear: null });
      publishExportFixture(service, personId, '合成完整历史.txt', [
        ...Array.from({ length: 520 }, (_, index) => ({
          originalName: `合成历史项目${index}`, conceptKey: `合成历史项目${index}`,
          clinicalDate: index < 15 ? '2023-01-11' : '2026-09-10'
        })),
        { conceptKey: '合成影像小结', originalName: '合成影像小结', valueKind: 'text', decimalValue: null,
          rawText: '未见明显异常，需结合此次检查范围理解。', qualifier: null, unit: null },
        { conceptKey: '合成无日期结果', originalName: '合成无日期结果', valueKind: 'qualitative', decimalValue: null,
          rawText: '阴性', qualifier: null, unit: null, clinicalDate: null, abnormalFlag: 'negative' }
      ]);
      const vision = publishExportFixture(service, personId, '合成检查条件.txt', [{
        conceptKey: '合成视力检查', originalName: '合成视力检查', rawText: '4.7', decimalValue: '4.7',
        unit: null, referenceRange: '仅本次检查', specimen: null, method: '视力表', bodySite: '左眼'
      }]);
      // 临时测试库补入合成解释条件，导出不能只保留数值而遗失其含义。
      const observationId = service.store.listAcceptedObservations(personId).find((item) => item.documentId === vision.documentId)!.id;
      const database = new Database(service.store.databasePath);
      database.prepare(`UPDATE observation_revisions SET clinical_context_json = ? WHERE observation_id = ?`)
        .run(JSON.stringify({ version: 1, status: 'complete', conditions: [{ sourceSpanId: vision.sourceSpanId, quote: '检查时未散瞳。' }] }), observationId);
      database.close();
      publishExportFixture(service, otherId, '乙成员专属来源.txt', [{ originalName: '乙成员专属结果', rawText: '9.9', decimalValue: '9.9' }]);

      const snapshot = service.getSnapshot();
      const visiblePoints = snapshot.trends.filter((series) => series.personId === personId).flatMap((series) => series.points);
      expect(visiblePoints.length).toBeLessThanOrEqual(500);
      expect(visiblePoints.some((point) => point.date === '2023-01-11')).toBe(false);
      const summary = service.getMemberSummaryExport({ personId, dateFrom: null, dateTo: null });
      expect(summary.observations).toHaveLength(523);
      expect(summary.observations.filter((item) => item.date === '2023-01-11')).toHaveLength(15);
      expect(summary.observations).toContainEqual(expect.objectContaining({ name: '合成影像小结', valueKind: 'text',
        value: '未见明显异常，需结合此次检查范围理解。' }));
      expect(summary.observations.at(-1)).toMatchObject({ name: '合成无日期结果', date: '检查日期未记录', clinicalDate: null,
        value: '阴性', valueKind: 'qualitative', abnormalFlag: 'negative' });
      expect(summary.observations.find((item) => item.name === '合成视力检查')).toMatchObject({
        referenceRange: '仅本次检查', method: '视力表', bodySite: '左眼', clinicalConditions: ['检查时未散瞳。']
      });
      expect(summary.exportedAt).toBe('2026-09-18T01:00:00.000Z');
      const html = renderMemberSummaryHtml(summary);
      const json = renderMemberSummaryJson(summary);
      expect(JSON.parse(json).observations).toHaveLength(523);
      expect(html.match(/<tr>/g)).toHaveLength(524);
      for (const output of [html, json]) {
        expect(output).not.toContain('乙成员专属');
        expect(output).toContain('检查时未散瞳。');
        expect(output).toContain('未见明显异常，需结合此次检查范围理解。');
        expect(output).not.toContain(vision.sourceSpanId);
      }

      const dated = service.getMemberSummaryExport({ personId, dateFrom: '2023-01-11', dateTo: '2023-01-11' });
      expect(dated.observations).toHaveLength(15);
      expect(dated.observations.every((item) => item.date === '2023-01-11')).toBe(true);
      expect(dated.warnings).toContain('有 1 条检查日期未记录的报告结果未纳入所选日期范围。');
      expect(dated.assessment.summary).toBeNull();
    } finally { service.close(); }
  });

  it('排除删除、移出分析和成员归属存疑资料，旧综合不能把它们带回导出', () => {
    const service = makeService();
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
      publishExportFixture(service, personId, '保留来源.txt', [{ originalName: '保留结果' }]);
      const ignored = publishExportFixture(service, personId, '移出来源.txt', [{ originalName: '移出结果' }]);
      const deleted = publishExportFixture(service, personId, '删除来源.txt', [{ originalName: '删除结果' }]);
      const conflicted = publishExportFixture(service, personId, '归属存疑来源.txt', [{ originalName: '归属存疑结果' }]);
      const saved = saveSyntheticAssessment(service, personId, {
        overview: { id: 'overview', headline: '旧综合标题', summary: '旧综合包含待移出结果。', claimIds: [], actionIds: [], limitations: [] }
      });
      expect(service.getMemberSummaryExport({ personId, dateFrom: null, dateTo: null }).assessment.summary).toBe(saved.overview.summary);
      service.setDocumentIncluded({ documentId: ignored.documentId, included: false, confirmedExclusion: true });
      service.store.deleteDocument({ documentId: deleted.documentId, retainedByRecoveryPoint: false });
      service.store.saveExtractionReviewIssue({ documentId: conflicted.documentId, kind: 'person_conflict',
        severity: 'blocking', evidenceRefs: [conflicted.sourceSpanId], reportedName: '合成另一人' });

      const summary = service.getMemberSummaryExport({ personId, dateFrom: null, dateTo: null });
      expect(summary.observations.map((item) => item.name)).toEqual(['保留结果']);
      expect(summary.sourceDocuments.some((item) => item.displayName === '移出来源.txt' || item.displayName === '删除来源.txt')).toBe(false);
      expect(summary.assessment.summary).toBeNull();
      expect(summary.assessment.findings).toEqual([]);
      expect(summary.suggestedActions).toEqual([]);
      expect(JSON.stringify(summary)).not.toContain('旧综合包含待移出结果');
      expect(summary.lifestyleGuidance).toEqual([]);
    } finally { service.close(); }
  });

  it('未找到或已归档成员不能借导出读取资料', () => {
    const service = makeService();
    try {
      service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
      const personId = service.createMember({ displayName: '合成已归档成员', relation: '家人', birthYear: null });
      publishExportFixture(service, personId, '合成已归档来源.txt', [{ originalName: '归档结果' }]);
      service.archiveMember({ personId, expectedDisplayRevision: 1, confirmedArchive: true });
      for (const id of [personId, 'missing-person']) {
        expect(() => service.getMemberSummaryExport({ personId: id, dateFrom: null, dateTo: null })).toThrow('PERSON_NOT_FOUND');
      }
    } finally { service.close(); }
  });

  it('只因综合规则更新而过期时仍导出全部事实，但不附旧综合或暗示健康资料改变', () => {
    const service = makeService();
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成规则升级成员', relation: '本人' });
      publishExportFixture(service, personId, '合成规则升级来源.txt', [{ originalName: '保留原检查结果' }]);
      saveSyntheticAssessment(service, personId, {
        promptVersion: 'member-assessment-v15', rulesVersion: 'lean-health-v3.16+assessment-validation-v15',
        overview: { id: 'overview', headline: '旧规则标题', summary: '旧规则专属正文。', claimIds: [], actionIds: [], limitations: [] }
      });
      expect(service.getMemberAssessment(personId)?.status).toBe('stale');
      const summary = service.getMemberSummaryExport({ personId, dateFrom: null, dateTo: null });
      expect(summary.observations.map((item) => item.name)).toEqual(['保留原检查结果']);
      expect(summary.assessment.status).toBe('stale');
      expect(summary.assessment.summary).toBeNull();
      expect(summary.warnings).toContain('健康解读待更新，本摘要未使用此前的健康解读。');
      expect(renderMemberSummaryJson(summary)).not.toContain('旧规则专属正文');
      expect(renderMemberSummaryJson(summary)).not.toContain('健康资料已有变化');
    } finally { service.close(); }
  });
});

describe('只读历史行动展示投影', () => {
  const personId = 'presentation-person';
  const updatedAt = '2026-09-18T01:00:00.000Z';
  type PresentationStoreState = {
    legacySnapshots?: unknown[];
    actions?: ActionItem[];
    adoptions?: ReturnType<PersonalWorkspaceService['store']['listActionAdoptions']>;
    assessmentAdoptions?: ReturnType<PersonalWorkspaceService['store']['listAdoptedMemberAssessmentActions']>;
    notes?: ManualNote[];
  };

  // 绕过数据库构造器，只验证合成保存记录的只读页面投影。
  function presentationService(state: PresentationStoreState = {}): PersonalWorkspaceService {
    return Object.assign(Object.create(PersonalWorkspaceService.prototype), {
      workspaceName: '合成家庭健康',
      now: () => new Date(updatedAt),
      getSchedule: () => ({ enabled: false, nextRunUtc: null, localTime: '20:00', timeZone: 'Asia/Shanghai', revision: 1 }),
      store: {
        listPersons: () => [{
          id: personId, displayName: '合成成员', relation: '本人', birthYear: null,
          archivedAt: null, displayRevision: 1, clinicalContextRevision: 0
        }],
        listOpenExtractionReviewIssues: () => [],
        listAcceptedObservations: () => [],
        listMemberAssessmentSnapshots: () => [],
        listCurrentDerivedSnapshots: () => [],
        listLatestDerivedSnapshots: () => state.legacySnapshots ?? [],
        listLifestyleProposals: () => [],
        listActionAdoptions: () => state.adoptions ?? [],
        listAdoptedMemberAssessmentActions: () => state.assessmentAdoptions ?? [],
        listActionItems: () => state.actions ?? [],
        listManualNotes: () => state.notes ?? [],
        listPersonDocumentCounts: () => new Map(),
        listPersonObservationStats: () => new Map(),
        listImportedDocuments: () => [],
        listProcessingRebuildSources: () => [],
        listProcessingDocumentIds: () => new Set(),
        hasMemberAssessmentHistory: () => false,
        listSystemAnalysisSnapshots: () => [],
        getFactRevision: () => 0,
        listDocumentAiTransmissionStatuses: () => new Map(),
        listDocumentAcceptedFactCounts: () => new Map(),
        listDateBindingReviewDocumentCounts: () => new Map(),
        listExtractionRepairDiagnostics: () => [],
        listStoredJobs: () => [],
        isQueuePaused: () => false
      }
    }) as PersonalWorkspaceService;
  }

  function action(id: string, origin: ActionItem['origin'], overrides: Partial<ActionItem> = {}): ActionItem {
    return {
      id, personId, title: '经模型核对，继续记录血压。',
      detail: '采用输入的体重指数趋势事实。先按已确定的时间记录。未散瞳时不能据此判断近视。',
      origin, status: 'planned', dueDate: null, dueText: '经模型核对，今晚开始记录。',
      evidenceLabel: null, userRevision: 1, updatedAt, ...overrides
    };
  }

  const mixedProcessCases = [
    ['临床条件与处理阶段', '未散瞳且P03确认仍执行。'],
    ['临床条件与对象编号', '未散瞳且记录123e4567-e89b-12d3-a456-426614174000后仍执行。'],
    ['临床条件与外置盘路径', '未散瞳且查看/Volumes/检查/眼科记录后仍执行。'],
    ['临床条件与Windows路径', '未散瞳且查看C:/reports/眼科记录后仍执行。']
  ] as const;

  it.each(mixedProcessCases)('%s残留于AI行动任一字段时整项暂停执行文本，不删除保存记录', (_label, text) => {
    const actions = ['legacy', 'assessment'].flatMap((source) => (['title', 'detail', 'dueText'] as const)
      .map((field) => action(`${source}-${field}`, 'ai_proposed', {
        title: '继续记录血压。', detail: '先按已经确认的方式记录。', dueText: '今晚记录。',
        status: 'in_progress', [field]: text
      })));
    const state: PresentationStoreState = {
      actions,
      assessmentAdoptions: actions.filter((item) => item.id.startsWith('assessment-')).map((item) => ({
        action: item, dedupeKey: `dedupe-${item.id}`, sourceAssessmentId: 'assessment-one',
        sourceActionId: `source-${item.id}`, evidenceRefs: [], sourceDate: null
      }))
    };
    const original = structuredClone(state);
    const service = presentationService(state);
    const plan = service.getLifestylePlan(personId);
    expect(plan.adoptedActions).toHaveLength(actions.length);
    for (const item of plan.adoptedActions) {
      expect(item).toMatchObject({
        title: '已有行动记录，安排前需确认依据', userGoal: '已有行动记录，安排前需确认依据',
        selectedStartingOption: '这项行动记录仍保留。安排前请回看原始依据及适用限制，不宜直接按这段文字执行。',
        plannedTime: null, status: 'in_progress'
      });
    }
    const snapshotActions = service.getSnapshot(null).actions;
    expect(snapshotActions).toHaveLength(actions.length);
    for (const item of snapshotActions) {
      expect(item).toMatchObject({
        title: '已有行动记录，安排前需确认依据',
        detail: '这项行动记录仍保留。安排前请回看原始依据及适用限制，不宜直接按这段文字执行。',
        dueText: null, status: 'in_progress'
      });
    }
    expect(state).toEqual(original);
  });

  it.each(mixedProcessCases)('%s用于本人字段或医嘱时原样保留，不按工程标识批量清理', (_label, text) => {
    const userActions = ['user_created', 'clinician_document'].map((origin) => action(origin, origin as ActionItem['origin'], {
      title: text, detail: text, dueText: text, userScheduleText: origin === 'user_created' ? text : null
    }));
    const sourceState: PresentationStoreState = { actions: userActions };
    const sourceOriginal = structuredClone(sourceState);
    const sourceService = presentationService(sourceState);
    for (const item of sourceService.getLifestylePlan(personId).adoptedActions) {
      expect(item).toMatchObject({ title: text, userGoal: text, selectedStartingOption: text,
        ...(item.id === 'user_created' ? { plannedTime: text, reportTiming: null } : { plannedTime: null, reportTiming: text }) });
    }
    expect(sourceService.getSnapshot(null).actions).toEqual(userActions);
    expect(sourceState).toEqual(sourceOriginal);

    const adoption = {
      id: 'materialized-mixed-adoption', personId, proposalId: 'proposal-one', title: text,
      userGoal: text, selectedStartingOption: text, plannedTime: text, owner: text, progressNote: text,
      status: 'planned' as const, dueDate: null, userRevision: 2, updatedAt
    };
    const note: ManualNote = {
      id: 'mixed-user-note', personId, kind: 'free_text', immutableText: text,
      effectiveDate: null, sourceKind: 'user_reported', structuredFields: {}, revision: 1, recordedAt: updatedAt
    };
    const materializedState: PresentationStoreState = {
      adoptions: [adoption], notes: [note],
      actions: [action(adoption.id, 'ai_proposed', { title: text, detail: text, dueText: text })]
    };
    const materializedOriginal = structuredClone(materializedState);
    const materializedService = presentationService(materializedState);
    expect(materializedService.getLifestylePlan(personId).adoptedActions[0]).toMatchObject({
      title: '已有行动记录，安排前需确认依据',
      userGoal: text, selectedStartingOption: text, plannedTime: text, owner: text, progressNote: text
    });
    const snapshot = materializedService.getSnapshot(null);
    expect(snapshot.actions[0]).toMatchObject({
      title: '已有行动记录，安排前需确认依据', detail: text, dueText: text, status: 'planned'
    });
    expect(snapshot.notes).toEqual([note]);
    expect(snapshot.timeline.find((item) => item.id === `event-note-${note.id}`)?.summary).toBe(text);
    expect(materializedState).toEqual(materializedOriginal);
  });

  it('旧生活建议的兼容限制只说明当前适用条件，不加入软件复核过程', () => {
    const state: PresentationStoreState = {
      legacySnapshots: [{
        personId, createdAt: updatedAt,
        payload: {
          schemaVersion: 1, dataQuality: 'partial', claims: [],
          lifestyleGuidance: [{
            id: 'legacy-guidance', category: 'monitoring', title: '记录血压',
            detail: '每周记录3天，若出现胸痛及时就医。', evidenceObservationIds: [], consultProfessional: false
          }]
        }
      }]
    };
    const original = structuredClone(state);
    const plan = presentationService(state).getLifestylePlan(personId);
    expect(plan).toMatchObject({ status: 'stale', proposals: [{
      id: 'legacy-guidance', title: '记录血压', detail: '每周记录3天，若出现胸痛及时就医。',
      steps: ['每周记录3天，若出现胸痛及时就医。'], status: 'proposed', sourceKind: 'ai_proposed'
    }] });
    const proposal = plan.proposals[0]!;
    expect(JSON.stringify([proposal.startingOptions, proposal.trackingSuggestion, proposal.constraints, proposal.uncertainties]))
      .not.toMatch(/版本|提示词|安全规则|复核|自动创建|新版|旧版/);
    expect([...proposal.constraints, ...proposal.uncertainties].join('')).toMatch(/当前|现在|最新/);
    expect(state).toEqual(original);
  });

  it('旧AI行动保留具体行动和临床限制，纯过程记录不消失，本人行动原样', () => {
    const state: PresentationStoreState = { actions: [
      action('legacy-ai', 'ai_proposed'),
      action('legacy-process-only', 'ai_proposed', { title: '经模型核对。', detail: 'P03 已通过。' }),
      action('user-action', 'user_created')
    ] };
    const original = structuredClone(state);
    const service = presentationService(state);
    const plan = service.getLifestylePlan(personId);
    expect(plan.adoptedActions).toHaveLength(3);
    expect(plan.adoptedActions.find((item) => item.id === 'legacy-ai')).toMatchObject({
      title: '继续记录血压。', userGoal: '继续记录血压。',
      selectedStartingOption: '先按已确定的时间记录。未散瞳时不能据此判断近视。',
      plannedTime: null, reportTiming: '今晚开始记录。'
    });
    const processOnly = plan.adoptedActions.find((item) => item.id === 'legacy-process-only')!;
    expect(processOnly.title.trim()).not.toBe('');
    expect(processOnly.selectedStartingOption.trim()).not.toBe('');
    expect(`${processOnly.title}${processOnly.selectedStartingOption}`).not.toMatch(/模型核对|P03/);
    expect(plan.adoptedActions.find((item) => item.id === 'user-action')).toMatchObject({
      title: state.actions![2]!.title, selectedStartingOption: state.actions![2]!.detail,
      plannedTime: null
    });
    const snapshotActions = service.getSnapshot(null).actions;
    expect(snapshotActions.find((item) => item.id === 'legacy-ai')).toMatchObject({
      title: '继续记录血压。', detail: '先按已确定的时间记录。未散瞳时不能据此判断近视。', dueText: '今晚开始记录。'
    });
    expect(snapshotActions.find((item) => item.id === 'user-action')).toEqual(state.actions![2]);
    expect(state).toEqual(original);
  });

  it('物化采纳只清理建议标题，所有本人字段及其拼接行动正文保持原样', () => {
    const adoption = {
      id: 'materialized-adoption', personId, proposalId: 'proposal-one',
      title: '经模型核对，继续记录血压。',
      userGoal: '经模型核对是我的笔记原话，先记录1周。',
      selectedStartingOption: '采用输入是我的自填提醒：早晚记录。',
      plannedTime: '等待新版复核后，我决定周末做', owner: '负责复核的家属',
      progressNote: '经模型核对四字是我的备注原话。', status: 'planned' as const,
      dueDate: null, userRevision: 2, updatedAt
    };
    const userDetail = [adoption.userGoal, `起始方式：${adoption.selectedStartingOption}`,
      `计划时间：${adoption.plannedTime}`, `负责人：${adoption.owner}`, `起始备注：${adoption.progressNote}`].join('\n');
    const note: ManualNote = {
      id: 'user-note', personId, kind: 'free_text', immutableText: '采用输入是本人备注的原话，暂未散瞳。',
      effectiveDate: null, sourceKind: 'user_reported', structuredFields: {}, revision: 1, recordedAt: updatedAt
    };
    const state: PresentationStoreState = {
      adoptions: [adoption], notes: [note],
      actions: [action(adoption.id, 'ai_proposed', { detail: userDetail, dueText: '由我决定开始时间' })]
    };
    const original = structuredClone(state);
    const service = presentationService(state);
    expect(service.getLifestylePlan(personId).adoptedActions).toEqual([{
      id: adoption.id, proposalId: adoption.proposalId, assessmentDedupeKey: null,
      title: '继续记录血压。', userGoal: adoption.userGoal,
      selectedStartingOption: adoption.selectedStartingOption, plannedTime: adoption.plannedTime,
      owner: adoption.owner, progressNote: adoption.progressNote,
      status: adoption.status, dueDate: adoption.dueDate, updatedAt
    }]);
    const snapshot = service.getSnapshot(null);
    expect(snapshot.actions[0]).toMatchObject({ title: '继续记录血压。', detail: userDetail });
    expect(snapshot.notes).toEqual([note]);
    expect(snapshot.timeline.find((item) => item.id === `event-note-${note.id}`)?.summary).toBe(note.immutableText);
    expect(state).toEqual(original);
  });

  it('成员综合采纳行动按来源清理，只读保留医嘱原文与保存记录', () => {
    const aiAction = action('assessment-ai', 'ai_proposed');
    const clinicianAction = action('assessment-clinician', 'clinician_document');
    const state: PresentationStoreState = {
      actions: [aiAction, clinicianAction],
      assessmentAdoptions: [aiAction, clinicianAction].map((item) => ({
        action: item, dedupeKey: `dedupe-${item.id}`, sourceAssessmentId: 'assessment-one',
        sourceActionId: `source-${item.id}`, evidenceRefs: [], sourceDate: null
      }))
    };
    const original = structuredClone(state);
    const service = presentationService(state);
    const plan = service.getLifestylePlan(personId);
    expect(plan.adoptedActions).toHaveLength(2);
    expect(plan.adoptedActions.find((item) => item.id === aiAction.id)).toMatchObject({
      assessmentDedupeKey: `dedupe-${aiAction.id}`, title: '继续记录血压。', userGoal: '继续记录血压。',
      selectedStartingOption: '先按已确定的时间记录。未散瞳时不能据此判断近视。', plannedTime: null, reportTiming: '今晚开始记录。'
    });
    expect(plan.adoptedActions.find((item) => item.id === clinicianAction.id)).toMatchObject({
      title: clinicianAction.title, selectedStartingOption: clinicianAction.detail, plannedTime: null, reportTiming: clinicianAction.dueText
    });
    expect(service.getSnapshot(null).actions.find((item) => item.id === clinicianAction.id)).toEqual(clinicianAction);
    expect(state).toEqual(original);
  });
});

describe('身体系统旧状态只读投影', () => {
  function legacyAnalysis(overrides: Partial<SystemAnalysisSnapshot> = {}): SystemAnalysisSnapshot {
    return {
      schemaVersion: 2, id: 'synthetic-system-analysis', personId: 'synthetic-person', systemId: 'cardiovascular',
      inputSignature: 'a'.repeat(64), scope: { from: null, to: null, clinicalAsOf: null }, factRevision: 1,
      promptVersion: 'synthetic-legacy', status: 'current', dataQuality: 'partial',
      headline: '合成心血管说明', overview: '这次结果需结合检查条件理解。', assessmentStatus: 'monitor',
      keyPoints: [], topicSections: [], conflicts: [], dataGaps: [], discussionPoints: [], recommendations: [],
      clinicallyImportantUnknowns: [], coverage: { inputCount: 1, linkedEventCount: 1, excludedCount: 0, incompleteReasons: [] },
      review: { status: 'passed', reviewerRunId: null, rulesVersion: 'synthetic-legacy' },
      generatedAt: '2026-09-18T00:00:00Z', ...overrides
    };
  }

  function projectionFixture(analysis: SystemAnalysisSnapshot | null, options: {
    directFact?: boolean; abnormalFlag?: 'normal' | 'high' | 'low' | 'positive'
  } = {}) {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '合成状态成员', relation: '本人' });
    if (options.directFact !== false) publishExportFixture(service, personId, '合成状态报告.txt', [{
      conceptKey: '低密度脂蛋白胆固醇', originalName: '低密度脂蛋白胆固醇',
      abnormalFlag: options.abnormalFlag ?? 'normal'
    }]);
    // 仅隔离状态映射的输入边界；不改变生产代码对旧快照降为历史说明的限制。
    Object.assign(service, { currentSystemAnalysis: () => analysis });
    return { service, personId, summary: () => service.listBodySystems(personId)
      .find((system) => system.id === 'cardiovascular')! };
  }

  it.each(['monitor', 'no_signal_in_scope'] as const)('旧版 %s 不投影成 stable，也不改保存的事实', (assessmentStatus) => {
    const { service, personId, summary } = projectionFixture(legacyAnalysis({ assessmentStatus }));
    try {
      const before = service.store.listAcceptedObservations(personId);
      expect(summary()).toMatchObject({ status: assessmentStatus, factCount: 1, attentionCount: 0, analysisStatus: 'current' });
      expect(service.store.listAcceptedObservations(personId)).toEqual(before);
    } finally { service.close(); }
  });

  it.each(['monitor', 'no_signal_in_scope'] as const)('旧版 %s 不盖过直接检查的异常提示', (assessmentStatus) => {
    for (const abnormalFlag of ['high', 'low', 'positive'] as const) {
      const { service, summary } = projectionFixture(legacyAnalysis({ assessmentStatus }), { abnormalFlag });
      try { expect(summary()).toMatchObject({ status: 'attention', attentionCount: 1 }); }
      finally { service.close(); }
    }
  });

  it.each([
    ['没有当前解读', null],
    ['旧解读已过期', legacyAnalysis({ status: 'stale' })],
    ['解读尚未复核', legacyAnalysis({ review: { status: 'pending', reviewerRunId: null, rulesVersion: 'synthetic' } })],
    ['解读复核未通过', legacyAnalysis({ review: { status: 'failed', reviewerRunId: null, rulesVersion: 'synthetic' } })],
    ['解读无法判断', legacyAnalysis({ assessmentStatus: 'undetermined' })]
  ] as const)('%s 时仍显示准备中，不升级为健康状态', (_label, analysis) => {
    const { service, summary } = projectionFixture(analysis);
    try { expect(summary()).toMatchObject({ status: 'building', factCount: 1, attentionCount: 0 }); }
    finally { service.close(); }
  });

  it('旧版 attention 优先，缺少直接检查时仍不宣称已有本系统结论', () => {
    for (const directFact of [true, false]) {
      const { service, summary } = projectionFixture(legacyAnalysis({ assessmentStatus: 'attention' }), { directFact });
      try { expect(summary()).toMatchObject({ status: directFact ? 'attention' : 'insufficient', factCount: directFact ? 1 : 0 }); }
      finally { service.close(); }
    }
  });

  it.each(['monitor', 'no_signal_in_scope'] as const)('V3 的 %s 优先于旧解读；重建节点仍保留不可用边界', (status) => {
    const { service, personId, summary } = projectionFixture(legacyAnalysis({ assessmentStatus: 'attention' }));
    try {
      const snapshot = saveSyntheticAssessment(service, personId, {
        systems: [{ id: 'system:cardiovascular', systemId: 'cardiovascular', status, headline: '合成新版系统说明',
          summary: '保留新版解读范围。', claimIds: [], actionIds: [], limitations: [] }]
      });
      const assessment = vi.spyOn(service, 'getMemberAssessment').mockReturnValue(snapshot);
      expect(summary()).toMatchObject({ status, summary: '合成新版系统说明', interpretationState: 'complete' });
      assessment.mockReturnValue({ ...snapshot,
        presentation: { version: 'result-summary-v12', rebuiltNodeIds: ['system:cardiovascular'] } });
      expect(summary()).toMatchObject({ status: 'building', interpretationState: 'unavailable' });
    } finally { service.close(); }
  });

  it.each(['attention', 'monitor'] as const)('有真实存活支持且已重点复核的重建%s保留健康状态和partial范围', (status) => {
    const { service, personId, summary } = projectionFixture(null);
    try {
      const observation = service.store.listAcceptedObservations(personId)[0]!;
      const snapshot = saveSyntheticAssessment(service, personId, {
        validationMode: 'local_and_focused_review', reviewedTargetIds: ['system:cardiovascular'],
        systems: [{ id: 'system:cardiovascular', systemId: 'cardiovascular', status, headline: '合成关注信息',
          summary: '这次结果需结合条件理解。', claimIds: ['claim:retained'], actionIds: [], limitations: [] }],
        claims: [{ id: 'claim:retained', topicKey: 'lipids', systemIds: ['cardiovascular'], kind: 'source_fact',
          text: '保留合成报告的结果。', diseaseName: null, diagnosticStatus: null, temporalStatus: 'historical',
          evidenceIds: ['source:retained'], counterEvidenceIds: [], trendIds: [], knowledgeBasis: 'not_applicable',
          knowledgeSourceIds: [], criteriaBasis: null, rationale: '这份报告有记录。', materialUncertainty: null,
          consequenceLevel: 'routine' }],
        evidenceCatalog: [{ id: 'source:retained', kind: 'observation', documentId: observation.documentId,
          sourceSpanId: 'synthetic-span', observationId: observation.id, eventId: null, knowledgeId: null,
          label: '合成来源', locator: '第1页', quote: '合成报告的结果。' }],
        presentation: { version: 'result-summary-v12', rebuiltNodeIds: ['system:cardiovascular'] }
      });
      const assessment = vi.spyOn(service, 'getMemberAssessment').mockReturnValue(snapshot);
      expect(summary()).toMatchObject({ status, interpretationState: 'partial' });
      assessment.mockReturnValue({ ...snapshot, claims: [],
        systems: [{ ...snapshot.systems[0]!, claimIds: [], actionIds: ['action:retained'] }],
        actions: [{ id: 'action:retained', dedupeKey: 'retained-habit', systemIds: ['cardiovascular'],
          claimIds: [], evidenceIds: ['source:retained'], knowledgeSourceIds: [], kind: 'habit',
          title: '合成日常安排', why: '结合已有个人记录。', firstStep: '记录当前日常习惯。',
          timing: null, timingBasis: 'none', reviewPlan: null, caution: null, urgency: 'routine' }] });
      expect(summary()).toMatchObject({ status, interpretationState: 'partial' });
      for (const missing of ['receipt', 'support', 'source'] as const) {
        assessment.mockReturnValue({ ...snapshot,
          ...(missing === 'receipt' ? { reviewedTargetIds: [] } : {}),
          ...(missing === 'support' ? { claims: [] } : {}),
          ...(missing === 'source' ? { evidenceCatalog: [] } : {}) });
        expect(summary().status).toBe('building');
      }
      for (const normalStatus of ['no_signal_in_scope', 'insufficient'] as const) {
        assessment.mockReturnValue({ ...snapshot, systems: [{ ...snapshot.systems[0]!, status: normalStatus }] });
        expect(summary()).toMatchObject({ status: 'building', interpretationState: 'partial' });
      }
    } finally { service.close(); }
  });
});

describe('PersonalWorkspaceService', () => {
  it('用户日程独立于原建议，服务拒绝跨成员或过期版本且生活卡保留双方时间', () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
    const other = service.store.createPerson({ displayName: '另一成员' });
    const action = service.createAction({ personId, title: '复诊', detail: '带原报告。', dueDate: null, dueText: '原安排时间' });
    expect(action.userScheduleText).toBe('原安排时间');
    const input = { personId, actionId: action.id, dueDate: '2026-10-20', userScheduleText: '上午预约', expectedRevision: 1 };
    expect(() => service.updateActionSchedule({ ...input, personId: other.id })).toThrow('ACTION_NOT_FOUND');
    const updated = service.updateActionSchedule(input);
    expect(updated).toMatchObject({ dueDate: input.dueDate, userScheduleText: input.userScheduleText, dueText: '原安排时间', userRevision: 2 });
    expect(service.getLifestylePlan(personId).adoptedActions).toEqual([expect.objectContaining({
      id: action.id, dueDate: input.dueDate, plannedTime: input.userScheduleText, reportTiming: null
    })]);
    expect(() => service.updateActionSchedule(input)).toThrow(/REVISION_CONFLICT/);
    const cleared = service.updateActionSchedule({ ...input, dueDate: null, userScheduleText: null, expectedRevision: 2 });
    expect(cleared).toMatchObject({ userScheduleText: null, dueText: '原安排时间' });
    expect(service.getLifestylePlan(personId).adoptedActions).toEqual([expect.objectContaining({
      id: action.id, dueDate: null, plannedTime: null, reportTiming: null
    })]);
    service.close();
  });

  it('健康总览同一主题只占一条重点，标题不替代完整结论和检查条件', () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
    const claim = (id: string, topicKey: string, overrides: Partial<HealthClaim> = {}): HealthClaim => ({
      id, topicKey, systemIds: ['sensory_oral'], kind: 'interpretation', title: '视力检查的范围',
      text: '本次视力检查未散瞳，只反映当时检查表现，不能据此确认屈光状态。',
      diseaseName: null, diagnosticStatus: null, temporalStatus: 'current', evidenceIds: [], counterEvidenceIds: [],
      trendIds: [], knowledgeBasis: 'not_applicable', knowledgeSourceIds: [], criteriaBasis: null,
      rationale: '应结合检查时的条件理解。', materialUncertainty: '目前缺少散瞳验光结果。', consequenceLevel: 'important',
      ...overrides
    });
    const saved = saveSyntheticAssessment(service, personId, { claims: [
      claim('eye-interpretation', 'eye-refraction'),
      claim('eye-fact', 'eye-refraction', { kind: 'source_fact', title: '同一次视力检查', text: '原报告记录了当时的视力结果。' }),
      claim('blood-pressure', 'blood-pressure', { title: '家庭血压记录', systemIds: ['cardiovascular'],
        text: '单次血压记录不能代表日常血压水平。', materialUncertainty: '尚无连续家庭测量。' }),
      claim('activity', 'activity', { title: '活动记录', systemIds: ['musculoskeletal'],
        text: '现有活动记录只覆盖一周。', materialUncertainty: '不能据此判断长期变化。' })
    ] });
    const result = service.getMemberOverview(personId);
    expect(result.priorityIssues).toHaveLength(3);
    expect(result.priorityIssues.map((issue) => issue.id)).toEqual(['eye-interpretation', 'blood-pressure', 'activity']);
    expect(result.priorityIssues[0]).toMatchObject({ title: '视力检查的范围',
      explanation: '本次视力检查未散瞳，只反映当时检查表现，不能据此确认屈光状态。 目前缺少散瞳验光结果。',
      relatedExplanations: [{ id: 'eye-fact', title: '同一次视力检查',
        explanation: '原报告记录了当时的视力结果。 目前缺少散瞳验光结果。' }] });
    expect(result.priorityIssues[1]).toMatchObject({ title: '家庭血压记录',
      explanation: '单次血压记录不能代表日常血压水平。 尚无连续家庭测量。' });
    expect(service.store.listMemberAssessmentSnapshots(personId)[0]!.claims).toEqual(saved.claims);
    expect(service.getMemberAssessment(personId)!.claims).toHaveLength(4);
    service.close();
  });

  it('成员与家庭总览均覆盖多个系统的完整健康信息，不用首条肝胆标题充当总体结论', () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
    const claim = (id: string, systemIds: HealthClaim['systemIds'], text: string, uncertainty: string | null = null): HealthClaim => ({
      id, topicKey: id, systemIds, kind: 'source_fact', text,
      diseaseName: null, diagnosticStatus: null, temporalStatus: 'current', evidenceIds: [], counterEvidenceIds: [],
      trendIds: [], knowledgeBasis: 'not_applicable', knowledgeSourceIds: [], criteriaBasis: null,
      rationale: '只反映该次报告项目。', materialUncertainty: uncertainty, consequenceLevel: 'routine'
    });
    const claims = [
      claim('liver', ['hepatobiliary'], '该次肝胆检查未提示该项目异常。'),
      claim('blood-pressure', ['cardiovascular'], '该次血压结果有变化，需要结合测量条件理解。', '单次结果不能说明日常血压。'),
      claim('thyroid', ['endocrine_metabolic'], '促甲状腺激素在历次检查中有波动。', '不同实验室的参考范围不同，不能直接套用。')
    ];
    const saved = saveSyntheticAssessment(service, personId, {
      overview: { id: 'overview', headline: '肝胆检查结果', summary: claims[0]!.text,
        claimIds: ['liver'], actionIds: [], limitations: [] }, claims,
      systems: claims.map((item) => ({ id: `system:${item.systemIds[0]}`, systemId: item.systemIds[0]!,
        status: 'monitor', headline: item.text, summary: item.text, claimIds: [item.id], actionIds: [], limitations: [] }))
    });
    const member = service.getMemberOverview(personId);
    const family = service.getSnapshot(null).persons.find((item) => item.id === personId)!;
    expect(member.headline).toMatch(/^整体情况：/u);
    expect(family.changeSummary).toBe(member.headline);
    for (const item of claims) {
      expect(member.overview).toContain(item.text);
      expect(family.assessmentSummary).toContain(item.text);
      if (item.materialUncertainty) {
        expect(member.overview).toContain(item.materialUncertainty);
        expect(family.assessmentSummary).toContain(item.materialUncertainty);
      }
    }
    expect(family.assessmentSummary).toBe(member.overview);
    expect(service.getMemberAssessment(personId)!.systems.find((system) => system.systemId === 'hepatobiliary')!.summary)
      .not.toContain(claims[1]!.text);
    expect(service.store.listMemberAssessmentSnapshots(personId)[0]!.overview).toEqual(saved.overview);
    expect(service.store.listMemberAssessmentSnapshots(personId)[0]!.claims).toEqual(saved.claims);
    service.close();
  });

  it('家庭与成员从同一重点序列展开完整概况，不为长度换成无关正常指标也不改写存储', () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
    const claim = (id: string, systemId: HealthClaim['systemIds'][number], title: string,
      text: string, important = false): HealthClaim => ({
      id, topicKey: id, title, systemIds: [systemId], kind: 'source_fact', text,
      diseaseName: null, diagnosticStatus: null, temporalStatus: 'current', evidenceIds: [], counterEvidenceIds: [],
      trendIds: [], knowledgeBasis: 'not_applicable', knowledgeSourceIds: [], criteriaBasis: null,
      rationale: `合成来源与${title}对应。`, materialUncertainty: `理解${title}需保留的检查条件。`,
      consequenceLevel: important ? 'important' : 'routine'
    });
    const claims = [
      claim('ecg', 'cardiovascular', '合成心电图记录', '这是另一个心血管检查项目，不代表血脂情况。'),
      claim('thyroid', 'endocrine_metabolic', '合成甲状腺重点', '甲状腺完整解释。'.repeat(80), true),
      claim('psa', 'renal_urinary', '合成前列腺结果', '该项目在该次范围内，不替代当前优先主题。'),
      claim('liver', 'hepatobiliary', '合成肝酶重点', '肝酶完整解释。'.repeat(90), true),
      claim('lipids', 'cardiovascular', '合成血脂重点', '血脂完整解释。'.repeat(80), true)
    ];
    const saved = saveSyntheticAssessment(service, personId, { claims,
      promptVersion: 'member-assessment-v23', rulesVersion: 'lean-health-v3.25+assessment-validation-v25',
      presentation: { version: 'result-summary-v12', rebuiltNodeIds: ['overview'] },
      overview: { id: 'overview', headline: '旧总览不可恢复', summary: '旧总览没有通过发布边界。',
        claimIds: ['liver', 'thyroid', 'lipids', 'ecg', 'psa'], actionIds: [], limitations: ['合成资料不覆盖全部身体情况。'] },
      heldTargetIds: ['overview'],
      actions: [{ id: 'liver-followup', dedupeKey: 'liver-followup', systemIds: ['hepatobiliary'], claimIds: ['liver'],
        kind: 'test_followup', title: '讨论合成肝酶检查', why: '合成资料需关注。', firstStep: '携带合成检查结果与医生讨论。',
        timing: null, timingBasis: 'none', reviewPlan: null, caution: null, urgency: 'soon', evidenceIds: [], knowledgeSourceIds: [] }],
      systems: [
        { id: 'system:cardiovascular', systemId: 'cardiovascular', status: 'monitor', headline: '合成血脂重点',
          summary: claims[4]!.text, claimIds: ['lipids', 'ecg'], actionIds: [], limitations: [] },
        { id: 'system:endocrine_metabolic', systemId: 'endocrine_metabolic', status: 'monitor', headline: '合成甲状腺重点',
          summary: claims[1]!.text, claimIds: ['thyroid'], actionIds: [], limitations: [] },
        { id: 'system:hepatobiliary', systemId: 'hepatobiliary', status: 'attention', headline: '合成肝酶重点',
          summary: claims[3]!.text, claimIds: ['liver'], actionIds: ['liver-followup'], limitations: [] },
        { id: 'system:renal_urinary', systemId: 'renal_urinary', status: 'no_signal_in_scope', headline: '合成前列腺结果',
          summary: claims[2]!.text, claimIds: ['psa'], actionIds: [], limitations: [] }
      ]
    });
    const member = service.getMemberOverview(personId);
    const family = service.getSnapshot(null).persons.find((item) => item.id === personId)!;
    expect(service.getMemberAssessment(personId)).toMatchObject({ status: 'stale',
      promptVersion: 'member-assessment-v23', presentation: { version: 'result-summary-v14' } });
    expect(member.headline).toBe(family.changeSummary);
    expect(member.overview).toBe(family.assessmentSummary);
    expect(member.overview.length).toBeGreaterThan(2000);
    expect(member.headline).toBe('整体情况：3项重点，涉及3个身体系统');
    for (const item of [claims[3]!, claims[1]!, claims[4]!]) {
      expect(member.overview).toContain(item.title);
      expect(member.overview).toContain(item.text);
      expect(member.overview).toContain(item.rationale);
      expect(member.overview).toContain(item.materialUncertainty);
    }
    expect(member.overview.indexOf('合成肝酶重点')).toBeLessThan(member.overview.indexOf('合成甲状腺重点'));
    expect(member.overview).not.toContain(claims[0]!.text);
    expect(member.overview).not.toContain(claims[2]!.text);
    expect(member.overview).not.toContain(saved.overview.summary);
    expect(service.store.listMemberAssessmentSnapshots(personId)[0]!.claims).toEqual(saved.claims);
    expect(service.store.listMemberAssessmentSnapshots(personId)[0]!.overview).toEqual(saved.overview);
    service.close();
  });

  it('总览读模型保留全部重要主题，把晚出现的紧急发现放在主入口并保留其他行动', () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
    const claims: HealthClaim[] = ['first', 'second', 'third', 'fourth', 'urgent'].map((id) => ({
      id, topicKey: id === 'urgent' ? 'first' : id, systemIds: ['cardiovascular'], kind: 'interpretation',
      title: `合成健康主题${id}`, text: `合成检查发现${id}，请结合检查当时情况理解。`,
      diseaseName: null, diagnosticStatus: null, temporalStatus: 'current', evidenceIds: [], counterEvidenceIds: [],
      trendIds: [], knowledgeBasis: 'not_applicable', knowledgeSourceIds: [], criteriaBasis: null,
      rationale: '检查记录有明确来源。', materialUncertainty: null, consequenceLevel: id === 'urgent' ? 'routine' : 'important'
    }));
    const saved = saveSyntheticAssessment(service, personId, { claims, actions: [
      { id: 'ordinary-action', dedupeKey: 'ordinary-action', systemIds: ['cardiovascular'], claimIds: ['first'],
        kind: 'self_monitor', title: '记录日常情况', why: '观察日常表现。', firstStep: '记录下一次检查前的日常情况。',
        timing: null, timingBasis: 'none', reviewPlan: null, caution: null, urgency: 'routine', evidenceIds: [], knowledgeSourceIds: [] },
      { id: 'urgent-action', dedupeKey: 'urgent-action', systemIds: ['cardiovascular'], claimIds: ['urgent'],
        kind: 'seek_care', title: '及时联系医生', why: '存在需及时处理的线索。', firstStep: '如果目前仍有相同表现，立即联系医生。',
        timing: null, timingBasis: 'none', reviewPlan: null, caution: null, urgency: 'urgent', evidenceIds: [], knowledgeSourceIds: [] }
    ] });
    const overview = service.getMemberOverview(personId);
    expect(overview.priorityIssues.map((issue) => issue.id)).toEqual(['urgent', 'second', 'third', 'fourth']);
    expect(overview.priorityIssues[0]).toMatchObject({ isHighPriority: true, nextStep: saved.actions[1]!.firstStep,
      additionalNextSteps: [saved.actions[0]!.firstStep], relatedExplanations: [{ id: 'first', explanation: claims[0]!.text }] });
    expect(service.store.listMemberAssessmentSnapshots(personId)[0]!.claims).toEqual(saved.claims);
    expect(service.store.listMemberAssessmentSnapshots(personId)[0]!.actions).toEqual(saved.actions);
    service.close();
  });

  it('旧健康结论没有短标题时使用中性主题标题，正文的结论和限制不截断', () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
    saveSyntheticAssessment(service, personId, { claims: [{
      id: 'legacy-claim', topicKey: 'eye-scope', systemIds: ['sensory_oral'], kind: 'source_fact',
      text: '这次检查是在未散瞳条件下进行，不能据此确认屈光状态；仍需结合正式验光结果。',
      diseaseName: null, diagnosticStatus: null, temporalStatus: 'current', evidenceIds: [], counterEvidenceIds: [],
      trendIds: [], knowledgeBasis: 'not_applicable', knowledgeSourceIds: [], criteriaBasis: null,
      rationale: '检查条件影响结果的适用范围。', materialUncertainty: '目前没有正式验光结果。', consequenceLevel: 'important'
    }] });
    expect(service.getMemberOverview(personId).priorityIssues).toEqual([expect.objectContaining({
      title: '眼耳鼻喉 / 口腔检查结果',
      explanation: '这次检查是在未散瞳条件下进行，不能据此确认屈光状态；仍需结合正式验光结果。 目前没有正式验光结果。'
    })]);
    service.close();
  });

  it.each([
    ['member-assessment-v11', 'lean-health-v3.9+assessment-validation-v10'],
    ['member-assessment-v12', 'lean-health-v3.10+assessment-validation-v11'],
    ['member-assessment-v12', 'lean-health-v3.11+assessment-validation-v12'],
    ['member-assessment-v12', 'lean-health-v3.12+assessment-validation-v13'],
    ['member-assessment-v13', 'lean-health-v3.12+assessment-validation-v13'],
    ['member-assessment-v14', 'lean-health-v3.13+assessment-validation-v13'],
    ['member-assessment-v14', 'lean-health-v3.13+assessment-validation-v14'],
    ['member-assessment-v14', 'lean-health-v3.15+assessment-validation-v15'],
    ['member-assessment-v15', 'lean-health-v3.16+assessment-validation-v15'],
    ['member-assessment-v16', 'lean-health-v3.16+assessment-validation-v16'],
    ['member-assessment-v16', 'lean-health-v3.17+assessment-validation-v17'],
    ['member-assessment-v17', 'lean-health-v3.17+assessment-validation-v17'],
    ['member-assessment-v18', 'lean-health-v3.18+assessment-validation-v18'],
    ['member-assessment-v19', 'lean-health-v3.18+assessment-validation-v18'],
    ['member-assessment-v23', 'lean-health-v3.25+assessment-validation-v25'],
    ['member-assessment-v24', 'lean-health-v3.26+assessment-validation-v25'],
    ['member-assessment-v25', 'lean-health-v3.27+assessment-validation-v26'],
    ['member-assessment-v26', 'lean-health-v3.28+assessment-validation-v26'],
    ['member-assessment-v27', 'lean-health-v3.30+assessment-validation-v26'],
    ['member-assessment-v27', 'lean-health-v3.31+assessment-validation-v26'],
    ['member-assessment-v28', 'lean-health-v3.32+assessment-validation-v26'],
    ['member-assessment-v29', 'lean-health-v3.33+assessment-validation-v26'],
    ['member-assessment-v30', 'lean-health-v3.34+assessment-validation-v27'],
    ['member-assessment-v31', 'lean-health-v3.35+assessment-validation-v27'],
    ['member-assessment-v32', 'lean-health-v3.36+assessment-validation-v27'],
    ['member-assessment-v33', 'lean-health-v3.37+assessment-validation-v28'],
    ['member-assessment-v34', 'lean-health-v3.38+assessment-validation-v29']
  ])('%s 已验证综合只读兼容，数据变化或未知版本仍关闭，旧版不能直接采纳新行动', (promptVersion, rulesVersion) => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
    const snapshot = memberAssessmentSnapshotV3Schema.parse({
      schemaVersion: 3, personId, inputSignature: 'a'.repeat(64), mode: 'full', requestedSystemIds: [],
      id: 'previous-assessment', status: 'current', generatedAt: '2026-09-18T00:00:00Z',
      factRevision: service.store.getFactRevision(personId), contextRevision: service.store.getClinicalContextRevision(personId),
      reviewScopeSignature: service.store.getOpenReviewScopeSignature(personId),
      promptVersion, rulesVersion,
      modelId: 'synthetic', reasoningEffort: 'medium', validationMode: 'local_only', reviewedTargetIds: [], heldTargetIds: [],
      limitations: [], evidenceCatalog: [], processingPlan: { strategy: 'full', trigger: 'none', partitionCount: 0 }, knowledgeVerifications: [],
      overview: { id: 'overview', headline: '检查范围有限', summary: '目前只有单次检查，不能判断长期变化。', claimIds: [], actionIds: [], limitations: [] },
      systems: [], claims: [], actions: [], questions: [], knowledgeSources: []
    });
    const database = new Database(service.store.databasePath);
    database.prepare(`INSERT INTO member_assessment_snapshots_v3 (
      id,person_id,input_signature,fact_revision,context_revision,prompt_version,rules_version,model_id,reasoning_effort,validation_mode,payload_json,status,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'current',?)`).run(snapshot.id, personId, snapshot.inputSignature,
      snapshot.factRevision, snapshot.contextRevision, snapshot.promptVersion, snapshot.rulesVersion, snapshot.modelId,
      snapshot.reasoningEffort, snapshot.validationMode, JSON.stringify(snapshot), snapshot.generatedAt);
    expect(service.getMemberAssessment(personId)).toMatchObject({ status: 'stale', overview: { headline: '检查范围有限' } });
    expect(() => service.adoptMemberAssessmentAction({ personId, snapshotId: snapshot.id, actionId: 'absent' }))
      .toThrow('MEMBER_ASSESSMENT_ACTION_STALE');
    database.prepare('UPDATE member_assessment_snapshots_v3 SET payload_json=? WHERE id=?')
      .run(JSON.stringify({ ...snapshot, promptVersion: 'unknown-version' }), snapshot.id);
    expect(service.getMemberAssessment(personId)).toBeNull();
    database.prepare('UPDATE member_assessment_snapshots_v3 SET payload_json=? WHERE id=?').run(JSON.stringify(snapshot), snapshot.id);
    service.store.createManualNote({ personId, kind: 'free_text', immutableText: '我补充了新的检查背景。', effectiveDate: null,
      structuredFields: {}, expectedContextRevision: snapshot.contextRevision });
    expect(service.getMemberAssessment(personId)).toBeNull();
    database.close();
    service.close();
  });

  it.each([
    ['member-assessment-v33', 'lean-health-v3.37+assessment-validation-v28'],
    ['member-assessment-v34', 'lean-health-v3.38+assessment-validation-v29'],
    ['member-assessment-v35', 'lean-health-v3.39+assessment-validation-v30'],
    ['member-assessment-v35', 'lean-health-v3.40+assessment-validation-v30'],
    ['member-assessment-v36', 'lean-health-v3.41+assessment-validation-v31'],
    ['member-assessment-v36', 'lean-health-v3.42+assessment-validation-v32'],
    ['member-assessment-v37', 'lean-health-v3.43+assessment-validation-v33'],
    ['member-assessment-v38', 'lean-health-v3.44+assessment-validation-v33'],
    ['member-assessment-v39', 'lean-health-v3.45+assessment-validation-v33'],
    ['member-assessment-v40', 'lean-health-v3.46+assessment-validation-v33']
  ])('%s 已发布结果仅只读呈现为此前解读，家庭与成员保留正文且不改写缓存', (promptVersion, rulesVersion) => {
    const service = makeService();
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成前版成员', relation: '本人' });
      publishExportFixture(service, personId, '合成前版报告.txt', [{}]);
      const saved = saveSyntheticAssessment(service, personId, {
        promptVersion, rulesVersion,
        overview: { id: 'overview', headline: '合成已有健康重点', summary: '合成此前已发布的完整健康说明，需结合检查条件理解。',
          claimIds: [], actionIds: [], limitations: [] },
        systems: [{ id: 'system:cardiovascular', systemId: 'cardiovascular', status: 'monitor',
          headline: '合成已有心血管说明', summary: '合成此前已发布的身体系统说明。', claimIds: [], actionIds: [], limitations: [] }]
      });
      const before = JSON.stringify(service.store.listMemberAssessmentSnapshots(personId));
      expect(service.getMemberAssessment(personId)).toMatchObject({ id: saved.id, status: 'stale',
        promptVersion, rulesVersion });
      expect(service.getMemberOverview(personId)).toMatchObject({ headline: saved.overview.headline, overview: saved.overview.summary });
      expect(service.listBodySystems(personId).find((system) => system.id === 'cardiovascular')?.summary)
        .toBe(saved.systems[0]!.headline);
      expect(service.getSnapshot().persons[0]).toMatchObject({ derivedStatus: 'stale', assessmentRefreshStatus: 'optional_rules',
        changeSummary: saved.overview.headline, assessmentSummary: saved.overview.summary });
      expect(() => service.adoptMemberAssessmentAction({ personId, snapshotId: saved.id, actionId: 'absent' }))
        .toThrow('MEMBER_ASSESSMENT_ACTION_STALE');
      expect(JSON.stringify(service.store.listMemberAssessmentSnapshots(personId))).toBe(before);
      expect(service.store.listStoredJobs()).toEqual([]);
    } finally { service.close(); }
  });

  it.each((['member-assessment-v33', 'member-assessment-v35', 'member-assessment-v40'] as const).flatMap((promptVersion) =>
    (['facts', 'context', 'review_scope', 'stored_stale', 'unknown_rules'] as const).map((change) => [promptVersion, change] as const)))(
    '%s 精确兼容不放宽现有输入和发布门禁：%s', (promptVersion, change) => {
      const service = makeService();
      try {
        const personId = service.ensurePrimaryMember({ displayName: '合成前版门禁成员', relation: '本人' });
        const { documentId, sourceSpanId } = publishExportFixture(service, personId, '合成前版门禁报告.txt', [{}]);
        const saved = saveSyntheticAssessment(service, personId, {
          promptVersion, rulesVersion: change === 'unknown_rules' ? 'unregistered-rules' : {
            'member-assessment-v33': 'lean-health-v3.37+assessment-validation-v28',
            'member-assessment-v35': 'lean-health-v3.40+assessment-validation-v30',
            'member-assessment-v40': 'lean-health-v3.46+assessment-validation-v33'
          }[promptVersion]
        });
        if (change === 'facts') publishExportFixture(service, personId, '合成前版门禁新增.txt', [{}]);
        if (change === 'context') service.store.createManualNote({ personId, kind: 'free_text', immutableText: '合成新的背景资料',
          effectiveDate: null, structuredFields: {}, expectedContextRevision: 0 });
        if (change === 'review_scope') service.store.saveExtractionReviewIssue({ documentId, kind: 'coverage_gap', severity: 'warning',
          preserveDocumentStatus: true, evidenceRefs: [sourceSpanId], reasonCodes: ['SYNTHETIC_V33_SCOPE_CHANGE'] });
        if (change === 'stored_stale') {
          const database = new Database(service.store.databasePath);
          database.prepare("UPDATE member_assessment_snapshots_v3 SET status='stale' WHERE id=?").run(saved.id);
          database.close();
        }
        expect(service.getMemberAssessment(personId)).toBeNull();
        expect(service.getSnapshot().persons[0]).toMatchObject({ derivedStatus: 'stale', assessmentRefreshStatus: 'required' });
        expect(() => service.adoptMemberAssessmentAction({ personId, snapshotId: saved.id, actionId: 'absent' }))
          .toThrow('MEMBER_ASSESSMENT_ACTION_STALE');
        expect(service.store.listStoredJobs()).toEqual([]);
      } finally { service.close(); }
    }
  );

  it.each([
    ['member-assessment-v31', 'lean-health-v3.35+assessment-validation-v27'],
    ['member-assessment-v34', 'lean-health-v3.38+assessment-validation-v29'],
    ['member-assessment-v35', 'lean-health-v3.40+assessment-validation-v30'],
    ['member-assessment-v40', 'lean-health-v3.46+assessment-validation-v33']
  ])('%s 规则升级仅为可选更新，不隐式加入默认处理，指定成员仍可独立更新且旧版不可采纳', (promptVersion, rulesVersion) => {
    const service = makeService();
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成兼容成员', relation: '本人' });
      publishExportFixture(service, personId, '合成可选更新报告.txt', [{}]);
      const saved = saveSyntheticAssessment(service, personId, {
        promptVersion, rulesVersion
      });
      expect(service.getSnapshot().persons[0]).toMatchObject({
        derivedStatus: 'stale', assessmentRefreshStatus: 'optional_rules', assessmentSummary: expect.any(String)
      });
      expect(() => service.processNow()).toThrow('NO_READY_DOCUMENTS');
      expect(service.store.listStoredJobs()).toEqual([]);
      expect(() => service.adoptMemberAssessmentAction({ personId, snapshotId: saved.id, actionId: 'absent' }))
        .toThrow('MEMBER_ASSESSMENT_ACTION_STALE');
      const accountState = { status: 'connected' as const, displayLabel: 'synthetic@example.invalid',
        quota: { status: 'available' as const, primaryUsedPercent: 0, secondaryUsedPercent: null, resetsAt: null },
        runtimeVersion: 'synthetic-runtime', lastCheckedAt: '2026-09-18T01:00:00Z' };
      expect(service.processNow({ accountState, consentVersion: 1, assessmentPersonId: personId,
        expectedAssessmentDataRevision: service.getSnapshot(accountState).persons[0]!.dataRevision }))
        .toMatchObject({ idempotent: false });
      expect(service.store.listStoredJobs()).toEqual([expect.objectContaining({ personLabel: '合成兼容成员', stage: 'analyze' })]);
    } finally { service.close(); }
  });

  it('默认处理其他成员新报告时不会夹带仅规则升级的旧成员综合', async () => {
    const service = makeService();
    try {
      const existingPersonId = service.ensurePrimaryMember({ displayName: '合成旧解读成员', relation: '本人' });
      publishExportFixture(service, existingPersonId, '合成旧成员报告.txt', [{}]);
      saveSyntheticAssessment(service, existingPersonId, { promptVersion: 'member-assessment-v31',
        rulesVersion: 'lean-health-v3.35+assessment-validation-v27' });
      const nextPersonId = service.createMember({ displayName: '合成新资料成员', relation: '家人', birthYear: null });
      await service.importFiles([{ path: '/tmp/合成新成员待处理.txt', bytes: Buffer.from('合成新成员原始资料') }], nextPersonId);
      const newDocumentId = service.getSnapshot().inbox.find((item) => item.personId === nextPersonId)!.id;
      service.processNow();
      expect(service.store.listStoredJobs()).toEqual([expect.objectContaining({
        personLabel: '合成新资料成员', stage: 'extract', documentIds: [newDocumentId]
      })]);
    } finally { service.close(); }
  });

  it.each(['facts', 'context', 'review_scope', 'unknown_rules'] as const)('综合的%s不再匹配时必须更新，不能被旧版只读兼容隐藏', (change) => {
    const service = makeService();
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成变更成员', relation: '本人' });
      const { documentId, sourceSpanId } = publishExportFixture(service, personId, '合成范围报告.txt', [{}]);
      saveSyntheticAssessment(service, personId, { promptVersion: change === 'unknown_rules' ? 'unknown-rules' : 'member-assessment-v31',
        rulesVersion: 'lean-health-v3.35+assessment-validation-v27' });
      if (change === 'facts') publishExportFixture(service, personId, '合成新增报告.txt', [{}]);
      if (change === 'context') service.store.createManualNote({ personId, kind: 'free_text', immutableText: '合成新的个人背景',
        effectiveDate: null, structuredFields: {}, expectedContextRevision: 0 });
      if (change === 'review_scope') service.store.saveExtractionReviewIssue({ documentId, kind: 'coverage_gap', severity: 'warning',
        preserveDocumentStatus: true, evidenceRefs: [sourceSpanId], reasonCodes: ['SYNTHETIC_SCOPE_CHANGE'] });
      expect(service.getMemberAssessment(personId)).toBeNull();
      expect(service.getSnapshot().persons[0]).toMatchObject({ derivedStatus: 'stale', assessmentRefreshStatus: 'required' });
    } finally { service.close(); }
  });

  it('当前匹配的综合及尚无事实的新成员都不会要求更新；有事实但从未生成时才要求更新', () => {
    const service = makeService();
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成当前成员', relation: '本人' });
      expect(service.getSnapshot().persons[0]).toMatchObject({ assessmentRefreshStatus: 'none' });
      publishExportFixture(service, personId, '合成当前报告.txt', [{}]);
      expect(service.getSnapshot().persons[0]).toMatchObject({ assessmentRefreshStatus: 'required' });
      saveSyntheticAssessment(service, personId);
      expect(service.getSnapshot().persons[0]).toMatchObject({ derivedStatus: 'current', assessmentRefreshStatus: 'none' });
    } finally { service.close(); }
  });

  it('私有核查正文不透传普通健康界面和摘要导出，读取也不改本机审计', () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '合成核查成员', relation: '本人' });
    publishExportFixture(service, personId, '合成核查报告.txt', [{ rawText: '1.5', decimalValue: '1.5' }]);
    const original = { nodeType: 'question' as const, value: { id: 'held-private-question',
      question: 'PRIVATE_WITHHELD_AUDIT_TEXT', whyItMatters: '合成未发布的问题理由。', relatedClaimIds: [], evidenceIds: [] } };
    const body = { targetId: original.value.id, phase: 'p04' as const, original, replacement: null,
      modelDecision: { verdict: 'hold' as const, reason: 'PRIVATE_MODEL_REVIEW_REASON' },
      receipt: { stage: 'p04' as const, threadId: 'synthetic-private-thread', turnId: 'synthetic-private-turn', outputHash: 'b'.repeat(64) },
      origin: 'model' as const, outcome: 'held' as const, localReasonCodes: ['reviewer_hold'],
      boundEvidenceIds: [], unboundEvidenceIds: [], boundObservationIds: [], unboundObservationIds: [] };
    const saved = saveSyntheticAssessment(service, personId, {
      heldTargetIds: [original.value.id], reviewAuditRecords: { version: 1, personId, inputSignature: 'a'.repeat(64),
        records: [{ ...body, recordHash: stableHash(body) }] }
    });
    const before = JSON.stringify(service.store.listMemberAssessmentSnapshots(personId, true)[0]);
    const visible = service.getMemberAssessment(personId)!;
    expect(visible).toMatchObject({ id: saved.id, overview: { headline: '合成健康概况' } });
    expect(visible).not.toHaveProperty('reviewAuditRecords');
    const exported = service.getMemberSummaryExport({ personId, dateFrom: null, dateTo: null });
    for (const output of [JSON.stringify(visible), JSON.stringify(service.getSnapshot()),
      renderMemberSummaryHtml(exported), renderMemberSummaryJson(exported)]) {
      expect(output).not.toContain('reviewAuditRecords');
      expect(output).not.toContain('PRIVATE_WITHHELD_AUDIT_TEXT');
      expect(output).not.toContain('PRIVATE_MODEL_REVIEW_REASON');
      expect(output).not.toContain('synthetic-private-thread');
    }
    expect(JSON.stringify(service.store.listMemberAssessmentSnapshots(personId, true)[0])).toBe(before);
    expect(before).toContain('PRIVATE_WITHHELD_AUDIT_TEXT');
    service.close();
  });

  it('v27/3.31 升级后只读呈现为stale，不改原综合、事实、签名或创建模型任务', () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '合成旧规则成员', relation: '本人' });
    const document = publishExportFixture(service, personId, '合成旧规则只读报告.txt', [{ rawText: '1.5', decimalValue: '1.5' }]);
    const saved = saveSyntheticAssessment(service, personId, {
      promptVersion: 'member-assessment-v27', rulesVersion: 'lean-health-v3.31+assessment-validation-v26'
    });
    const publish = vi.spyOn(service.store, 'publishMemberAssessmentSnapshot');
    const database = new Database(service.store.databasePath, { readonly: true });
    try {
      const before = {
        dataVersion: database.pragma('data_version', { simple: true }),
        snapshot: database.prepare('SELECT * FROM member_assessment_snapshots_v3 WHERE id=?').get(saved.id),
        facts: service.store.listAcceptedObservations(personId),
        factRevision: service.store.getFactRevision(personId),
        jobs: service.store.listStoredJobs(),
        transmissions: database.prepare('SELECT * FROM ai_transmissions ORDER BY rowid').all(),
        source: service.store.getDocumentOriginalSource(document.documentId)
      };
      const projected = service.getMemberAssessment(personId);
      expect(projected).toMatchObject({ id: saved.id, status: 'stale', promptVersion: saved.promptVersion,
        rulesVersion: saved.rulesVersion, inputSignature: saved.inputSignature });
      expect(projected?.status).not.toBe('current');
      expect(service.getMemberAssessment(personId)).toEqual(projected);
      expect(() => service.adoptMemberAssessmentAction({ personId, snapshotId: saved.id, actionId: 'absent' }))
        .toThrow('MEMBER_ASSESSMENT_ACTION_STALE');
      expect(publish).not.toHaveBeenCalled();
      expect(database.prepare('SELECT * FROM member_assessment_snapshots_v3 WHERE id=?').get(saved.id)).toEqual(before.snapshot);
      expect(service.store.listMemberAssessmentSnapshots(personId)[0]).toEqual(saved);
      expect(service.store.listAcceptedObservations(personId)).toEqual(before.facts);
      expect(service.store.getFactRevision(personId)).toBe(before.factRevision);
      expect(service.store.listStoredJobs()).toEqual(before.jobs);
      expect(database.prepare('SELECT * FROM ai_transmissions ORDER BY rowid').all()).toEqual(before.transmissions);
      expect(service.store.getDocumentOriginalSource(document.documentId)).toEqual(before.source);
      expect(database.pragma('data_version', { simple: true })).toBe(before.dataVersion);
    } finally { database.close(); service.close(); }
  });

  it.each([
    ['member-assessment-v27', 'lean-health-v3.31+assessment-validation-v26'],
    ['member-assessment-v34', 'lean-health-v3.38+assessment-validation-v29']
  ].flatMap(([promptVersion, rulesVersion]) => (
    ['fact_revision', 'context_revision', 'review_scope', 'document_scope', 'person_conflict', 'deleted_source'] as const
  ).map((change) => [promptVersion!, rulesVersion!, change] as const)))(
    '%s只读兼容仍拒绝%s的%s变化，不重写旧综合或修改已有事实', (promptVersion, rulesVersion, change) => {
      const service = makeService();
      const personId = service.ensurePrimaryMember({ displayName: '合成旧规则成员', relation: '本人' });
      const document = publishExportFixture(service, personId, '合成旧规则范围报告.txt', [{}]);
      const saved = saveSyntheticAssessment(service, personId, {
        promptVersion, rulesVersion
      });
      expect(service.getMemberAssessment(personId)?.status).toBe('stale');
      if (change === 'fact_revision') {
        publishExportFixture(service, personId, '合成后续报告.txt', [{}]);
      } else if (change === 'context_revision') {
        service.store.createManualNote({ personId, kind: 'free_text', immutableText: '合成适用条件已经变化。', effectiveDate: null,
          structuredFields: {}, expectedContextRevision: saved.contextRevision });
      } else if (change === 'review_scope' || change === 'person_conflict') {
        service.store.saveExtractionReviewIssue({ documentId: document.documentId,
          kind: change === 'person_conflict' ? 'person_conflict' : 'field_conflict', severity: 'blocking', stage: 'extract',
          preserveDocumentStatus: true, evidenceRefs: [document.sourceSpanId], reasonCodes: ['SYNTHETIC_SCOPE_CHANGE'] });
      } else if (change === 'document_scope') {
        service.setDocumentIncluded({ documentId: document.documentId, included: false, confirmedExclusion: true });
      } else {
        service.store.deleteDocument({ documentId: document.documentId, retainedByRecoveryPoint: false });
      }
      const database = new Database(service.store.databasePath, { readonly: true });
      try {
        const beforeDataVersion = database.pragma('data_version', { simple: true });
        const beforeSnapshot = database.prepare('SELECT * FROM member_assessment_snapshots_v3 WHERE id=?').get(saved.id);
        const beforeFacts = service.store.listAcceptedObservations(personId);
        expect(service.getMemberAssessment(personId)).toBeNull();
        expect(database.prepare('SELECT * FROM member_assessment_snapshots_v3 WHERE id=?').get(saved.id)).toEqual(beforeSnapshot);
        // 正常删除来源会先清理其派生快照；后续只读兼容不能重建或复活已删除内容。
        if (change === 'deleted_source') expect(beforeSnapshot).toBeUndefined();
        else expect(JSON.parse((beforeSnapshot as { payload_json: string }).payload_json)).toEqual(saved);
        expect(service.store.listAcceptedObservations(personId)).toEqual(beforeFacts);
        expect(database.pragma('data_version', { simple: true })).toBe(beforeDataVersion);
      } finally { database.close(); service.close(); }
    }
  );

  it.each([
    ['unknown-version', 'lean-health-v3.31+assessment-validation-v26'],
    ['member-assessment-v27', 'lean-health-v3.31+assessment-validation-v999'],
    ['member-assessment-v27', 'lean-health-v3.32+assessment-validation-v26'],
    ['member-assessment-v28', 'lean-health-v3.31+assessment-validation-v26'],
    ['member-assessment-v34', 'lean-health-v3.38+assessment-validation-v28'],
    ['member-assessment-v34', 'lean-health-v3.39+assessment-validation-v30'],
    ['member-assessment-v36', 'lean-health-v3.41+assessment-validation-v33'],
    ['member-assessment-v35', 'lean-health-v3.38+assessment-validation-v29']
  ])('只读兼容不猜测未知版本组合 %s / %s', (promptVersion, rulesVersion) => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '合成未知规则成员', relation: '本人' });
    const saved = saveSyntheticAssessment(service, personId, { promptVersion, rulesVersion });
    const database = new Database(service.store.databasePath, { readonly: true });
    try {
      const beforeDataVersion = database.pragma('data_version', { simple: true });
      expect(service.getMemberAssessment(personId)).toBeNull();
      expect(service.store.listMemberAssessmentSnapshots(personId)[0]).toEqual(saved);
      expect(database.pragma('data_version', { simple: true })).toBe(beforeDataVersion);
    } finally { database.close(); service.close(); }
  });

  it('当天本人自述持续胸痛伴冷汗时先显示条件式提醒，旧资料仍可阅读且无需 P02', () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
    service.store.createManualNote({
      personId, kind: 'free_text', immutableText: '我现在持续胸痛并伴冷汗。',
      effectiveDate: '2026-09-18', structuredFields: {}, expectedContextRevision: 0
    });
    const overview = service.getMemberOverview(personId);
    expect(overview.currentSymptomNotices).toMatchObject([{
      sourceLabel: '本人今天补充', sourceExcerpt: '我现在持续胸痛并伴冷汗'
    }]);
    expect(overview.sourceUrgentNotices).toEqual([]);
    expect(service.getMemberAssessment(personId)).toBeNull();
    service.close();
  });

  it.each(['fact_revision', 'review_scope', 'document_scope'] as const)('旧25只读兼容不绕过%s变化，也不改旧综合存储', (change) => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
    const document = publishExportFixture(service, personId, '合成范围报告.txt', [{}]);
    const saved = saveSyntheticAssessment(service, personId, {
      promptVersion: 'member-assessment-v25', rulesVersion: 'lean-health-v3.27+assessment-validation-v26'
    });
    expect(service.getMemberAssessment(personId)?.status).toBe('stale');
    if (change === 'fact_revision') {
      publishExportFixture(service, personId, '合成新增报告.txt', [{}]);
    } else if (change === 'review_scope') {
      service.store.saveExtractionReviewIssue({ documentId: document.documentId, kind: 'field_conflict',
        severity: 'warning', stage: 'extract', preserveDocumentStatus: true, evidenceRefs: [document.sourceSpanId],
        reasonCodes: ['numeric_value_not_in_evidence'] });
    } else {
      service.setDocumentIncluded({ documentId: document.documentId, included: false, confirmedExclusion: true });
    }
    expect(service.getMemberAssessment(personId)).toBeNull();
    const database = new Database(service.store.databasePath, { readonly: true });
    try {
      const row = database.prepare('SELECT payload_json FROM member_assessment_snapshots_v3 WHERE id=?').get(saved.id) as { payload_json: string };
      expect(JSON.parse(row.payload_json)).toEqual(saved);
    } finally { database.close(); service.close(); }
  });

  it('每份资料的准确接纳数区分合法零结果与绿色完成，工作区投影不改任务或原件', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
    await service.importFiles([{ path: '/tmp/合成空白记录.txt', bytes: Buffer.from('合成结果栏目：留空。') }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    const bytesBefore = readFileSync(service.store.getDocumentExtractionBundle(documentId).sourcePath);
    service.store.setDocumentStatus(documentId, 'completed');
    const snapshot = service.getSnapshot(null);
    expect(snapshot.inbox[0]).toMatchObject({ status: 'completed', acceptedFactCount: 0,
      issue: '已读完，尚无可纳入分析的检查结果；原件已保留。' });
    expect(snapshot.inbox[0]!.issue).not.toContain('识别姓名');
    expect(snapshot.inbox[0]!.issue).not.toContain('处理失败');
    expect(readFileSync(service.store.getDocumentExtractionBundle(documentId).sourcePath)).toEqual(bytesBefore);
    expect(service.store.listImportedDocuments()[0]!.status).toBe('completed');
    service.close();
  });

  it.each([
    ['LOCAL_VISUAL_TIMEOUT', null, '本机识别未成功不等于原件不可读'],
    ['numeric_value_not_in_evidence', null, '模型读取的结果与本机来源'],
    ['numeric_value_not_in_evidence', 'schema_invalid', '自动修复的内容或格式没有通过检查']
  ] as const)('未纳入原因%s/%s区分来源、本机校验与未采用的模型修复，不泛化成身份问题', async (code, outcome, detail) => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
    await service.importFiles([{ path: '/tmp/合成来源疑点.txt', bytes: Buffer.from('合成项目甲：未填写。') }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    service.store.saveExtractionReviewIssue({ documentId, kind: 'coverage_gap', severity: 'blocking', stage: 'extract',
      evidenceRefs: [], reasonCodes: [code] });
    if (outcome) service.store.saveExtractionRepairDiagnostic({ documentId, chunkIndex: 0,
      triggerCodes: [code], targetCandidateCount: 1, missingSourceCount: 0, metadataTimeTargetCount: 0,
      outcome, remainingFailureCount: 1, acceptedCount: 0 });
    const review = service.getSnapshot(null).reviews[0]!;
    expect(review.title).toBe('已读完，尚无可纳入分析的检查结果');
    expect(review.description).toContain(detail);
    expect(review.description).not.toContain('姓名');
    expect(review.description).toContain('不用凭猜测确认');
    service.close();
  });

  it('明确的近期报告急诊提示在 P01 接纳后、P02 完成前即可读取', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
    await service.importFiles([{ path: '/tmp/合成及时处理提示.txt',
      bytes: Buffer.from('2026-09-18 项目甲 1.0，报告要求立即急诊。') }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    installSyntheticLegacyTextEvidence(service, documentId);
    const spans = service.store.getDocumentExtractionBundle(documentId).manifest.spans;
    const span = spans[0]!;
    const extraction: ExtractionResult = {
      schemaVersion: 1, documentId, coveredSourceSpanIds: spans.map((item) => item.id),
      subject: { reportedName: null, evidence: [], confidence: 'absent' },
      candidates: [{
        localKey: 'item-a', originalName: '项目甲', standardNameCandidate: '项目甲',
        value: { kind: 'numeric', rawText: '1.0', decimal: '1.0', comparator: 'eq' },
        unitRaw: null, referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: null, bodySite: null, clinicalDate: '2026-09-18',
        evidence: [{ sourceSpanId: span.id, quote: span.quote }], issues: []
      }]
    };
    const result = await new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async () => ({ threadId: 'synthetic-p01', turnId: 'synthetic-p01', output: extraction })
    }).process(documentId);
    expect(result.status).toBe('published');
    expect(service.getMemberAssessment(personId)).toBeNull();
    expect(service.getMemberOverview(personId).sourceUrgentNotices).toMatchObject([{
      documentId, clinicalDate: '2026-09-18', instructionLevel: 'immediate_care'
    }]);
    service.close();
  });

  it('初始化成员并生成不含虚构健康结论的个人快照', () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    const snapshot = service.getSnapshot({
      status: 'disconnected', displayLabel: null,
      quota: { status: 'unknown', primaryUsedPercent: null, secondaryUsedPercent: null, resetsAt: null },
      runtimeVersion: 'test-runtime', lastCheckedAt: null
    });
    expect(snapshot.workspaceMode).toBe('personal');
    expect(snapshot.persons).toHaveLength(1);
    expect(snapshot.persons[0]).toMatchObject({ id: personId, documentCount: 0, dataQuality: 'insufficient' });
    expect(snapshot.organs.every((organ) => organ.status === 'insufficient')).toBe(true);
    expect(snapshot.trends).toEqual([]);
    service.close();
  });

  it('离线新增家庭成员不会生成健康数据', () => {
    const service = makeService();
    service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    const personId = service.createMember({ displayName: '家人甲', relation: '母亲', birthYear: 1962 });
    const snapshot = service.getSnapshot(null);
    expect(snapshot.persons).toHaveLength(2);
    expect(snapshot.persons.find((person) => person.id === personId)).toMatchObject({
      displayName: '家人甲',
      documentCount: 0,
      dataQuality: 'insufficient'
    });
    expect(snapshot.trends).toEqual([]);
    service.close();
  });

  it('归档成员会从日常快照隐藏，恢复后重新显示且不自动恢复授权', () => {
    const service = makeService();
    const primaryId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    const archivedId = service.createMember({ displayName: '家人乙', relation: '父亲', birthYear: 1960 });
    service.archiveMember({ personId: archivedId, expectedDisplayRevision: 1, confirmedArchive: true });
    expect(service.getSnapshot(null).persons.map((person) => person.id)).toEqual([primaryId]);
    expect(service.listArchivedMembers()).toEqual([expect.objectContaining({ id: archivedId, archivedAt: expect.any(String) })]);
    const archived = service.listArchivedMembers()[0]!;
    service.restoreMember({ personId: archived.id, expectedDisplayRevision: archived.displayRevision });
    expect(new Set(service.getSnapshot(null).persons.map((person) => person.id))).toEqual(new Set([primaryId, archivedId]));
    service.close();
  });

  it('导入本地文本并按内容哈希去重', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    const bytes = Buffer.from('纯虚构报告\nLDL 3.8 mmol/L');
    const first = await service.importFiles([{ path: '/tmp/虚构报告.txt', bytes }], personId);
    const second = await service.importFiles([{ path: '/tmp/虚构报告副本.txt', bytes }], personId);
    expect(first).toMatchObject({ importedCount: 1, duplicateCount: 0 });
    expect(second).toMatchObject({ importedCount: 0, duplicateCount: 1 });
    const snapshot = service.getSnapshot(null);
    expect(snapshot.inbox).toHaveLength(1);
    expect(snapshot.inbox[0]).toMatchObject({ status: 'queued', sentToAi: false });
    expect(service.store.countSourceSpans(snapshot.inbox[0]!.id)).toBe(1);
    const firstSpanId = service.store.getDocumentExtractionBundle(snapshot.inbox[0]!.id).manifest.spans[0]!.id;
    expect(service.store.getEvidenceAccess({ sourceSpanId: firstSpanId })).toMatchObject({
      documentId: snapshot.inbox[0]!.id,
      quote: null
    });
    expect(service.store.getEvidenceAccess({ documentId: snapshot.inbox[0]!.id }).sourceSpanId).toBe(firstSpanId);
    expect(() => service.store.getEvidenceAccess({ sourceSpanId: 'missing' })).toThrow('EVIDENCE_NOT_FOUND');
    const batch = service.processNow();
    const repeated = service.processNow();
    expect(batch.idempotent).toBe(false);
    expect(repeated).toMatchObject({ batchId: batch.batchId, idempotent: true });
    expect(service.getSnapshot(null)).toMatchObject({
      pendingInboxCount: 0,
      inbox: [expect.objectContaining({ inProcessingCenter: true })],
      jobs: [expect.objectContaining({ status: 'waiting_auth', stage: 'extract' })]
    });
    service.close();
  });

  it('混合差异中可排除证据不清的单项，不阻断其余已核实事实入库', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    await service.importFiles([{
      path: '/tmp/混合差异报告.txt',
      bytes: Buffer.from('肌钙蛋白 <0.01 ng/mL\n葡萄糖 5.2 mmol/L')
    }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    installSyntheticLegacyTextEvidence(service, documentId);
    const bundle = service.store.getDocumentExtractionBundle(documentId);
    const [troponinSpan, glucoseSpan] = bundle.manifest.spans;
    const troponin = {
      localKey: 'troponin', originalName: '肌钙蛋白', standardNameCandidate: 'cTnI',
      value: { kind: 'numeric' as const, rawText: '<0.01', decimal: '0.01', comparator: 'lt' as const },
      unitRaw: 'ng/mL', referenceRangeRaw: null, reportedAbnormalFlag: null,
      specimen: null, method: null, bodySite: null, clinicalDate: null,
      evidence: [{ sourceSpanId: troponinSpan!.id, quote: troponinSpan!.quote }], issues: []
    };
    const glucose = {
      localKey: 'glucose', originalName: '葡萄糖', standardNameCandidate: '空腹血糖',
      value: { kind: 'numeric' as const, rawText: '5.2', decimal: '5.2', comparator: 'eq' as const },
      unitRaw: 'mmol/L', referenceRangeRaw: null, reportedAbnormalFlag: null,
      specimen: null, method: null, bodySite: null, clinicalDate: null,
      evidence: [{ sourceSpanId: glucoseSpan!.id, quote: glucoseSpan!.quote }], issues: []
    };
    const issueId = service.store.saveExtractionReviewIssue({
      documentId, kind: 'field_conflict', severity: 'blocking',
      evidenceRefs: bundle.manifest.spans.map((span) => span.id),
      candidateOptions: [troponin, glucose],
      candidateDiffs: [
        { localKey: troponin.localKey, itemName: troponin.originalName, fields: ['value'] },
        { localKey: glucose.localKey, itemName: glucose.originalName, fields: ['issues'] }
      ],
      reasonCodes: ['FACT_ADJUDICATION_UNRESOLVED'],
      documentRun: {
        coverageComplete: true,
        coveredSourceSpanIds: bundle.manifest.spans.map((span) => span.id),
        manifestSpanIds: bundle.manifest.spans.map((span) => span.id),
        chunkCount: 1
      }
    });

    service.acceptCorrectedFacts({ issueId, documentId, candidates: [troponin] });
    expect(service.store.listAcceptedObservations(personId)).toEqual([
      expect.objectContaining({
        conceptKey: '肌钙蛋白',
        originalName: '肌钙蛋白',
        modelStandardNameCandidate: 'cTnI',
        rawText: '<0.01',
        qualifier: 'lt'
      })
    ]);
    expect(service.store.listOpenExtractionReviewIssues()).toEqual([]);
    service.close();
  });

  it('成员档案 v2 以身体系统读取事实，并把多年度别名组成可审查趋势', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    await service.importFiles([{
      path: '/tmp/虚构纵向血脂.txt',
      bytes: Buffer.from('2022-02-10 LDL-C 3.1 mmol/L\n2024-08-18 低密度脂蛋白 3.6 mmol/L ↑\n2026-09-12 低密度脂蛋白胆固醇 4.2 mmol/L ↑')
    }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    installSyntheticLegacyTextEvidence(service, documentId);
    const bundle = service.store.getDocumentExtractionBundle(documentId);
    const names = ['LDL-C', '低密度脂蛋白', '低密度脂蛋白胆固醇'];
    const dates = ['2022-02-10', '2024-08-18', '2026-09-12'];
    const values = ['3.1', '3.6', '4.2'];
    const candidates = bundle.manifest.spans.map((span, index) => ({
      localKey: `ldl-${index}`,
      originalName: names[index]!,
      standardNameCandidate: '低密度脂蛋白胆固醇',
      value: { kind: 'numeric' as const, rawText: values[index]!, decimal: values[index]!, comparator: 'eq' as const },
      unitRaw: 'mmol/L',
      referenceRangeRaw: '0-3.4',
      reportedAbnormalFlag: index === 0 ? '正常' : '↑',
      specimen: '血清', method: '酶法', bodySite: null,
      clinicalDate: dates[index]!,
      evidence: [{ sourceSpanId: span.id, quote: span.quote }],
      issues: []
    }));
    const issueId = service.store.saveExtractionReviewIssue({
      documentId,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: bundle.manifest.spans.map((span) => span.id),
      candidateOptions: candidates,
      candidateDiffs: candidates.map((candidate) => ({ localKey: candidate.localKey, itemName: candidate.originalName, fields: ['value'] })),
      reasonCodes: ['TEST_FIXTURE'],
      documentRun: {
        coverageComplete: true,
        coveredSourceSpanIds: bundle.manifest.spans.map((span) => span.id),
        manifestSpanIds: bundle.manifest.spans.map((span) => span.id),
        chunkCount: 1
      }
    });
    service.acceptCorrectedFacts({ issueId, documentId, candidates });

    const overview = service.getMemberOverview(personId);
    expect(overview).toMatchObject({ acceptedFactCount: 3, eventCount: 1, attentionSystemIds: ['cardiovascular'] });
    const systems = service.listBodySystems(personId);
    expect(systems.find((system) => system.id === 'cardiovascular')).toMatchObject({ factCount: 3, metricCount: 1, status: 'attention' });
    const detail = service.getBodySystemDetail(personId, 'cardiovascular');
    expect(detail.metrics[0]).toMatchObject({
      conceptId: 'loinc-like-ldl-c',
      trendFacts: { direction: 'increasing', usablePointCount: 3 }
    });
    const metric = service.getMetricSeries(personId, detail.metrics[0]!.id);
    expect(metric.aliasesSeen).toEqual(['LDL-C', '低密度脂蛋白', '低密度脂蛋白胆固醇']);
    expect(metric.tableRows).toHaveLength(3);
    expect(service.listHealthEvents(personId)[0]).toMatchObject({ metadataStatus: 'unknown', factCount: 3 });
    const evidenceId = metric.tableRows[0]!.evidence.id;
    expect(service.getMemberEvidenceBundle(personId, [evidenceId])).toMatchObject({ items: [{ id: evidenceId }], missingIds: [] });
    service.store.createManualNote({
      personId,
      kind: 'medication',
      immutableText: '纯合成自述：正在记录一种用药，尚未核对剂量。',
      effectiveDate: '2026-09-01',
      structuredFields: {},
      expectedContextRevision: 0
    });
    const bundleForAnalysis = service.buildSystemEvidenceBundle(personId, 'cardiovascular');
    expect(bundleForAnalysis).toMatchObject({
      identity: { personId, systemId: 'cardiovascular' },
      scope: { factRevision: 1, contextRevision: 1, clinicalFrom: '2022-02-10', clinicalAsOf: '2026-09-12' },
      coverage: { selectedObservationIds: expect.arrayContaining(metric.tableRows.map((row) => row.observationId)) }
    });
    expect(bundleForAnalysis.directFacts).toHaveLength(3);
    expect(bundleForAnalysis.contextFacts).toHaveLength(0);
    expect(bundleForAnalysis.personalContext).toEqual([expect.objectContaining({ source: 'user_reported', kind: 'medication' })]);
    expect(bundleForAnalysis.trends[0]).toMatchObject({ trendFacts: { direction: 'increasing' } });
    expect(bundleForAnalysis.scope.inputSignature).toMatch(/^[a-f0-9]{64}$/);
    const modelASignature = service.buildSystemEvidenceBundle(personId, 'cardiovascular', 'model-a').scope.inputSignature;
    expect(service.buildSystemEvidenceBundle(personId, 'cardiovascular', 'model-b').scope.inputSignature).not.toBe(modelASignature);
    const report = service.store.listReportMetadata(personId)[0]!;
    service.updateReportMetadata({
      personId,
      reportId: report.reportId,
      expectedRevision: report.metadataRevision,
      title: '本人核对后的血脂检查',
      organization: '合成医院',
      department: '检验科',
      clinicalTime: { value: '2026-09', precision: 'month' },
      reason: '合成测试：核对报告事件依赖'
    });
    const afterMetadataCorrection = service.buildSystemEvidenceBundle(personId, 'cardiovascular', 'model-a');
    expect(afterMetadataCorrection.scope.inputSignature).not.toBe(modelASignature);
    expect(afterMetadataCorrection.events).toEqual([
      expect.objectContaining({ title: '本人核对后的血脂检查', time: expect.objectContaining({ value: '2026-09', precision: 'month' }) })
    ]);
    const afterMetadataDefaultSignature = service.buildSystemEvidenceBundle(personId, 'cardiovascular').scope.inputSignature;
    const unrelatedGoal = service.store.createManualNote({
      personId,
      kind: 'goal',
      immutableText: '希望把日常作息安排得更规律',
      effectiveDate: null,
      structuredFields: {},
      expectedContextRevision: 1
    });
    const afterUnrelatedGoal = service.buildSystemEvidenceBundle(personId, 'cardiovascular');
    expect(afterUnrelatedGoal.scope.contextRevision).toBe(2);
    expect(afterUnrelatedGoal.scope.inputSignature).toBe(afterMetadataDefaultSignature);
    expect(afterUnrelatedGoal.coverage.excludedContextIds).toContain(unrelatedGoal.id);
    service.updateMemberDisplay({
      personId,
      displayName: '测试用户',
      relation: '本人',
      birthYear: 1990,
      expectedDisplayRevision: 1
    });
    const afterBirthYear = service.buildSystemEvidenceBundle(personId, 'cardiovascular');
    expect(afterBirthYear.identity).toMatchObject({
      birthYear: 1990,
      genderContext: null,
      contextSource: 'user_profile'
    });
    expect(afterBirthYear.scope.inputSignature).not.toBe(afterUnrelatedGoal.scope.inputSignature);
    service.close();
  });

  it('系统分析版本升级后可复用已接纳事实刷新，不要求重新上传报告', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    await service.importFiles([{
      path: '/tmp/合成刷新报告.txt',
      bytes: Buffer.from('2026-09-12 LDL-C 4.2 mmol/L')
    }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    installSyntheticLegacyTextEvidence(service, documentId);
    const span = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!;
    const candidate = {
      localKey: 'ldl-refresh', originalName: 'LDL-C', standardNameCandidate: '低密度脂蛋白胆固醇',
      value: { kind: 'numeric' as const, rawText: '4.2', decimal: '4.2', comparator: 'eq' as const },
      unitRaw: 'mmol/L', referenceRangeRaw: '0-3.4', reportedAbnormalFlag: '↑',
      specimen: '血清', method: null, bodySite: null, clinicalDate: '2026-09-12',
      evidence: [{ sourceSpanId: span.id, quote: span.quote }], issues: []
    };
    const issueId = service.store.saveExtractionReviewIssue({
      documentId, kind: 'field_conflict', severity: 'blocking', evidenceRefs: [span.id],
      candidateOptions: [candidate],
      candidateDiffs: [{ localKey: candidate.localKey, itemName: candidate.originalName, fields: ['value'] }],
      reasonCodes: ['TEST_FIXTURE'],
      documentRun: {
        coverageComplete: true, coveredSourceSpanIds: [span.id], manifestSpanIds: [span.id], chunkCount: 1
      }
    });
    service.acceptCorrectedFacts({ issueId, documentId, candidates: [candidate] });
    service.store.publishDerivedSnapshot({
      candidate: {
        schemaVersion: 1,
        personId,
        factRevision: service.store.getFactRevision(personId),
        dataQuality: 'partial',
        claims: [],
        lifestyleGuidance: []
      },
      expectedFactRevision: service.store.getFactRevision(personId),
      expectedContextRevision: service.store.getClinicalContextRevision(personId),
      promptVersion: 'derived-v3',
      rulesVersion: 'derived-safety-v2',
      modelId: 'test-model'
    });
    expect(service.store.listDerivedRefreshTargets()).toEqual([]);
    expect(service.store.listCurrentDerivedSnapshots()[0]?.promptVersion).toBe('derived-v3');

    const batch = service.processNow();
    expect(service.getSnapshot(null).jobs).toEqual([
      expect.objectContaining({ stage: 'analyze', status: 'waiting_auth' })
    ]);
    expect(service.processNow()).toMatchObject({ batchId: batch.batchId, idempotent: true });
    service.close();
  });

  it('手动授权刷新旧报告时只建立综合任务，不重新提取或改写已接纳事实', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
    await service.importFiles([{
      path: '/tmp/合成综合刷新报告.txt',
      bytes: Buffer.from('2026-09-12 LDL-C 4.2 mmol/L')
    }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    installSyntheticLegacyTextEvidence(service, documentId);
    const span = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!;
    const candidate = {
      localKey: 'ldl-refresh-authorized', originalName: 'LDL-C', standardNameCandidate: '低密度脂蛋白胆固醇',
      value: { kind: 'numeric' as const, rawText: '4.2', decimal: '4.2', comparator: 'eq' as const },
      unitRaw: 'mmol/L', referenceRangeRaw: '0-3.4', reportedAbnormalFlag: '↑',
      specimen: '血清', method: null, bodySite: null, clinicalDate: '2026-09-12',
      evidence: [{ sourceSpanId: span.id, quote: span.quote }], issues: []
    };
    const issueId = service.store.saveExtractionReviewIssue({
      documentId, kind: 'field_conflict', severity: 'blocking', evidenceRefs: [span.id],
      candidateOptions: [candidate],
      candidateDiffs: [{ localKey: candidate.localKey, itemName: candidate.originalName, fields: ['value'] }],
      reasonCodes: ['TEST_FIXTURE'],
      documentRun: { coverageComplete: true, coveredSourceSpanIds: [span.id], manifestSpanIds: [span.id], chunkCount: 1 }
    });
    service.acceptCorrectedFacts({ issueId, documentId, candidates: [candidate] });
    const acceptedBefore = service.store.listAcceptedObservations(personId);
    const factRevisionBefore = service.store.getFactRevision(personId);
    const accountState = {
      status: 'connected' as const,
      displayLabel: 'masked@example.com',
      quota: { status: 'available' as const, primaryUsedPercent: 1, secondaryUsedPercent: null, resetsAt: null },
      runtimeVersion: 'test-runtime',
      lastCheckedAt: '2026-09-18T01:00:00Z'
    };

    service.processNow({ accountState, consentVersion: 1 });

    expect(service.getSnapshot(null).jobs).toEqual([
      expect.objectContaining({ stage: 'analyze', status: 'queued' })
    ]);
    expect(service.store.listAcceptedObservations(personId)).toEqual(acceptedBefore);
    expect(service.store.getFactRevision(personId)).toBe(factRevisionBefore);
    expect(service.getSnapshot(null).inbox).toEqual([
      expect.objectContaining({ id: documentId, status: 'completed' })
    ]);
    service.close();
  });

  it('旧记录缺少原项目名时恢复可查看的系统归类，但不把候选名当成已验证事实', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    await service.importFiles([{
      path: '/tmp/合成旧版血脂.txt',
      bytes: Buffer.from('2026-09-10 低密度脂蛋白胆固醇 3.8 mmol/L')
    }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    const span = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!;
    const acceptanceId = service.store.saveAcceptanceDecision({
      method: 'auto', actor: 'policy', rulesVersion: 'test', inputSignature: 'legacy-name-input',
      outputHash: 'legacy-name-output', reviewRef: null, decision: 'accept'
    });
    service.store.publishFacts({
      personId,
      documentId,
      documentCommitKey: 'e'.repeat(64),
      expectedRevision: 0,
      changeSetHash: 'f'.repeat(64),
      summary: '合成旧版项目名兼容测试',
      observations: [{
        conceptKey: '低密度脂蛋白胆固醇',
        originalName: '低密度脂蛋白胆固醇',
        modelStandardNameCandidate: '低密度脂蛋白胆固醇',
        rawText: '3.8', valueKind: 'numeric', decimalValue: '3.8', qualifier: 'eq', unit: 'mmol/L',
        referenceRange: '0-3.4', clinicalDate: '2026-09-10', abnormalFlag: 'high', documentId,
        sourceSpanId: span.id, acceptanceId, specimen: '血清', method: null, bodySite: null,
        evidence: [{ sourceSpanId: span.id, quote: span.quote }]
      }]
    });
    const database = new Database(service.store.databasePath);
    database.prepare('UPDATE observations SET original_name = NULL WHERE person_id = ?').run(personId);
    database.close();

    expect(service.store.listAcceptedObservations(personId)[0]).toMatchObject({
      originalNameStatus: 'legacy_missing',
      mapping: { status: 'proposed' }
    });
    expect(service.listBodySystems(personId).find((system) => system.id === 'cardiovascular')).toMatchObject({
      status: 'building', factCount: 1, metricCount: 1, attentionCount: 0
    });
    const detail = service.getBodySystemDetail(personId, 'cardiovascular');
    expect(detail.metrics[0]).toMatchObject({ name: '低密度脂蛋白胆固醇', conceptId: null, mappingStatus: 'unmapped' });
    expect(detail.findings).toEqual([]);
    expect(service.buildSystemEvidenceBundle(personId, 'cardiovascular')).toMatchObject({
      directFacts: [],
      contextFacts: [{ name: '低密度脂蛋白胆固醇（旧记录候选名）', relation: 'context' }]
    });
    service.close();
  });

  it('事件详情把当前检查与报告引用的历史结果分开，不把当前机构套给历史结果', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    await service.importFiles([{
      path: '/tmp/虚构年度对比.txt',
      bytes: Buffer.from('合成医院 检查日期 2026-09-10\nLDL-C 2024-09-01 3.1 2026-09-10 3.8')
    }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    installSyntheticLegacyTextEvidence(service, documentId);
    const span = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!;
    const acceptanceId = service.store.saveAcceptanceDecision({
      method: 'auto', actor: 'policy', rulesVersion: 'test', inputSignature: 'history-event-input',
      outputHash: 'history-event-output', reviewRef: null, decision: 'accept'
    });
    const observation = (clinicalDate: string, rawText: string) => ({
      conceptKey: 'LDL-C', rawText, valueKind: 'numeric' as const, decimalValue: rawText, qualifier: 'eq',
      unit: 'mmol/L', referenceRange: '0-3.4', clinicalDate, abnormalFlag: 'unknown' as const,
      documentId, sourceSpanId: span.id, acceptanceId, specimen: '血清', method: null, bodySite: null,
      evidence: [{ sourceSpanId: span.id, quote: `LDL-C ${clinicalDate} ${rawText}` }]
    });
    service.store.publishFacts({
      personId, documentId, documentCommitKey: '1'.repeat(64), expectedRevision: 0,
      changeSetHash: '2'.repeat(64), summary: '合成历史列事件',
      reportMetadata: {
        reportKind: { value: '年度体检报告', evidence: [{ sourceSpanId: span.id, quote: '合成医院' }] },
        title: { value: '2026 年度体检', evidence: [{ sourceSpanId: span.id, quote: '合成医院' }] },
        organization: { value: '合成医院', evidence: [{ sourceSpanId: span.id, quote: '合成医院' }] },
        campus: null, department: null, reportNumber: null, encounterIdentifier: null, sampleIdentifiers: [], examItems: [],
        times: [
          { value: '2026-09-10', precision: 'day', role: 'examined', evidence: [{ sourceSpanId: span.id, quote: '检查日期 2026-09-10' }] },
          { value: '2024-09-01', precision: 'day', role: 'history_quoted', evidence: [{ sourceSpanId: span.id, quote: '2024-09-01 3.1' }] }
        ]
      },
      observations: [observation('2024-09-01', '3.1'), observation('2026-09-10', '3.8')]
    });

    const event = service.listHealthEvents(personId)[0]!;
    expect(event.time).toMatchObject({ value: '2026-09-10', endValue: null });
    expect(event.summary).toContain('报告中另有历史对比结果，已与本次检查分开');
    const detail = service.getHealthEventDetail(personId, event.id);
    expect(detail.findings).toEqual([expect.objectContaining({ value: '3.8 mmol/L', time: expect.objectContaining({ value: '2026-09-10' }) })]);
    expect(detail.historicalReferences).toEqual([expect.objectContaining({
      time: expect.objectContaining({ value: '2024-09-01', role: 'measurement' }),
      sourceReportTitle: '2026 年度体检',
      findings: [expect.objectContaining({ value: '3.1 mmol/L' })]
    })]);
    service.close();
  });

  it.each([
    ['2026-07-20', '2026-09-15'],
    ['2026-03-12', '2026-06-18', '2026-09-10']
  ])('非direct旧文字入口的多次独立检查保留日期范围和逐项原日期：%j', async (...dates) => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
    const text = `${dates.map((date, index) => `检查日期 ${date} 收缩压 ${140 + index} mmHg`).join('\n')}\n2020-01-01 历史引用 收缩压 130 mmHg\n年龄 75岁`;
    await service.importFiles([{ path: '/tmp/纯合成多次检查.txt', bytes: Buffer.from(text) }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    installSyntheticLegacyTextEvidence(service, documentId);
    const span = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!;
    const evidence = [{ sourceSpanId: span.id, quote: span.quote }];
    const acceptanceId = service.store.saveAcceptanceDecision({
      method: 'auto', actor: 'policy', rulesVersion: 'test', inputSignature: 'multi-date-input',
      outputHash: 'multi-date-output', reviewRef: null, decision: 'accept'
    });
    const observation = (clinicalDate: string | null, rawText: string, decimalValue: string, conceptKey = '收缩压', unit = 'mmHg') => ({
      conceptKey, originalName: conceptKey, rawText, valueKind: 'numeric' as const, decimalValue, qualifier: 'eq',
      unit, referenceRange: null, clinicalDate, abnormalFlag: 'unknown' as const,
      documentId, sourceSpanId: span.id, acceptanceId, specimen: null, method: null, bodySite: null, evidence
    });
    service.store.publishFacts({
      personId, documentId, documentCommitKey: '3'.repeat(64), expectedRevision: 0,
      changeSetHash: '4'.repeat(64), summary: '合成多日期资料',
      reportMetadata: {
        reportKind: { value: '检验记录', evidence }, title: { value: '多次检查汇总', evidence },
        organization: null, campus: null, department: null, reportNumber: null, encounterIdentifier: null, sampleIdentifiers: [], examItems: [],
        times: [
          ...dates.map((value) => ({ value, precision: 'day' as const, role: 'examined' as const, evidence })),
          { value: '2020-01-01', precision: 'day', role: 'history_quoted', evidence },
          { value: '2026-10-01', precision: 'day', role: 'report_issued', evidence }
        ]
      },
      observations: [
        ...dates.map((date, index) => observation(date, `${140 + index} mmHg`, String(140 + index))),
        observation('2020-01-01', '130 mmHg', '130'),
        observation(null, '75岁', '75', '年龄', '岁')
      ]
    });
    const before = service.store.listAcceptedObservations(personId);
    const event = service.listHealthEvents(personId)[0]!;
    expect(event.time).toMatchObject({ value: dates[0], endValue: dates.at(-1), precision: 'day', source: 'explicit',
      displayLabel: `${dates[0]} 至 ${dates.at(-1)}` });
    expect(event.summary).not.toContain('本次检查日期仍待确认');
    const detail = service.getHealthEventDetail(personId, event.id);
    expect(detail.findings.filter((finding) => finding.label === '收缩压').map((finding) => ({ value: finding.value, date: finding.time.value })))
      .toEqual(dates.map((date, index) => ({ value: `${140 + index} mmHg`, date })));
    expect(detail.findings.find((finding) => finding.label === '年龄')).toMatchObject({ value: '75岁',
      time: { value: '2026-10-01', precision: 'day', source: 'inherited', basis: 'report',
        displayLabel: '2026-10-01 · 按报告日期记录' } });
    expect(detail.historicalReferences).toHaveLength(1);
    expect(detail.historicalReferences[0]).toMatchObject({ time: { value: '2020-01-01' }, findings: [{ value: '130 mmHg' }] });
    expect(service.store.listAcceptedObservations(personId)).toEqual(before);
    service.close();
  });

  it('仅修改文件名不会改变检查事件类别', async () => {
    const eventTypeFor = async (fileName: string) => {
      const service = makeService();
      const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
      await service.importFiles([{
        path: `/tmp/${fileName}`,
        bytes: Buffer.from('2026-09-17 LDL-C 4.2 mmol/L')
      }], personId);
      const documentId = service.getSnapshot(null).inbox[0]!.id;
      installSyntheticLegacyTextEvidence(service, documentId);
      const span = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!;
      const candidate = {
        localKey: 'ldl-file-name', originalName: 'LDL-C', standardNameCandidate: 'LDL-C',
        value: { kind: 'numeric' as const, rawText: '4.2', decimal: '4.2', comparator: 'eq' as const },
        unitRaw: 'mmol/L', referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: null, bodySite: null, clinicalDate: '2026-09-17',
        evidence: [{ sourceSpanId: span.id, quote: '2026-09-17 LDL-C 4.2 mmol/L' }], issues: []
      };
      const issueId = service.store.saveExtractionReviewIssue({
        documentId, kind: 'field_conflict', severity: 'blocking',
        evidenceRefs: [span.id], candidateOptions: [candidate],
        candidateDiffs: [{ localKey: candidate.localKey, itemName: candidate.originalName, fields: ['value'] }],
        reasonCodes: ['TEST_FIXTURE'],
        documentRun: {
          coverageComplete: true,
          coveredSourceSpanIds: [span.id],
          manifestSpanIds: [span.id],
          chunkCount: 1
        }
      });
      service.acceptCorrectedFacts({ issueId, documentId, candidates: [candidate] });
      const type = service.listHealthEvents(personId)[0]!.type;
      service.close();
      return type;
    };

    // 这份片段只有 LDL 数值，没有报告类别；文件名和单项名称都不能替它证明整次是检验。
    await expect(eventTypeFor('年度体检_胸部影像.txt')).resolves.toBe('other');
    await expect(eventTypeFor('普通记录.txt')).resolves.toBe('other');
  });

  it.each([
    ['儿童眼科检查报告', '右眼裸眼远视力', '0.6', null, 'other', 'sensory_oral'],
    ['检验报告', 'LDL-C', '3.2', 'mmol/L', 'laboratory', 'cardiovascular'],
    ['甲状腺超声报告', '甲状腺右叶前后径', '18', 'mm', 'imaging', 'endocrine_metabolic'],
    ['年度体检（含检验及甲状腺超声）', '甲状腺右叶前后径', '18', 'mm', 'checkup', 'endocrine_metabolic'],
    ['普通检查报告', '心率', '70', 'bpm', 'other', 'cardiovascular']
  ] as const)('两条事件投影按已验证报告元数据分类，不把%s一律当成检验', async (title, name, rawText, unit, type, systemId) => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '分类测试用户', relation: '本人' });
    const source = `${title}\n检查日期 2026-09-12\n${name} ${rawText} ${unit ?? ''}`;
    await service.importFiles([{ path: '/tmp/文件名不能决定检验或影像.txt', bytes: Buffer.from(source) }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    installSyntheticLegacyTextEvidence(service, documentId);
    const spans = service.store.getDocumentExtractionBundle(documentId).manifest.spans;
    const titleSpan = spans.find((item) => item.quote?.includes(title))!;
    const dateSpan = spans.find((item) => item.quote?.includes('检查日期 2026-09-12'))!;
    const span = spans.find((item) => item.quote?.includes(`${name} ${rawText}`))!;
    const titleEvidence = [{ sourceSpanId: titleSpan.id, quote: title }];
    const dateEvidence = [{ sourceSpanId: dateSpan.id, quote: '检查日期 2026-09-12' }];
    const evidence = [{ sourceSpanId: span.id, quote: `${name} ${rawText} ${unit ?? ''}`.trim() }, ...dateEvidence];
    const acceptanceId = service.store.saveAcceptanceDecision({ method: 'auto', actor: 'policy', rulesVersion: 'test',
      inputSignature: 'event-classification', outputHash: 'event-classification-result', reviewRef: null, decision: 'accept' });
    service.store.publishFacts({ personId, documentId, documentCommitKey: '8'.repeat(64), expectedRevision: 0,
      changeSetHash: '9'.repeat(64), summary: '纯合成事件类型测试',
      reportMetadata: { reportKind: { value: title, evidence: titleEvidence }, title: { value: title, evidence: titleEvidence },
        organization: null, campus: null, department: null, reportNumber: null, encounterIdentifier: null,
        sampleIdentifiers: [], examItems: [], times: [{ value: '2026-09-12', precision: 'day', role: 'examined', evidence: dateEvidence }] },
      observations: [{ conceptKey: name, originalName: name, rawText, valueKind: 'numeric', decimalValue: rawText,
        qualifier: 'eq', unit, referenceRange: null, clinicalDate: '2026-09-12', abnormalFlag: 'unknown',
        documentId, sourceSpanId: span.id, acceptanceId, specimen: null, method: null, bodySite: null, evidence }]
    });
    const factsBefore = service.store.listAcceptedObservations(personId);
    expect(service.listHealthEvents(personId)[0]).toMatchObject({ type, title, time: { value: '2026-09-12' } });
    expect(service.buildSystemEvidenceBundle(personId, systemId).events).toEqual([
      expect.objectContaining({ type, title, time: expect.objectContaining({ value: '2026-09-12' }) })
    ]);
    expect(service.store.listAcceptedObservations(personId)).toEqual(factsBefore);
    service.close();
  });

  it('旧版生活建议缺少新版安全字段时保留可读内容但禁止直接采纳', () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-legacy-lifestyle-'));
    directories.push(root);
    const service = new PersonalWorkspaceService(root, '我的家庭健康', () => new Date('2026-09-18T01:00:00Z'));
    const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    const database = new Database(service.store.databasePath);
    database.prepare(`
      INSERT INTO derived_snapshots (
        id, person_id, fact_revision, context_revision, prompt_version,
        rules_version, model_id, coverage_json, payload_json, status, created_at
      ) VALUES (?, ?, 0, 0, 'derived-v1', 'derived-safety-v1', 'legacy-model', '[]', ?, 'current', ?)
    `).run('legacy-derived-snapshot', personId, JSON.stringify({
      schemaVersion: 1,
      personId,
      factRevision: 0,
      dataQuality: 'partial',
      claims: [],
      lifestyleGuidance: [{
        id: 'legacy-guidance',
        category: 'nutrition',
        title: '旧版建议',
        detail: '旧版记录没有新版所需的目标、步骤、来源和适用边界。',
        evidenceObservationIds: [],
        consultProfessional: false
      }]
    }), '2026-09-18T01:00:00.000Z');
    database.close();

    expect(service.getLifestylePlan(personId)).toMatchObject({
      personId,
      status: 'stale',
      dataQuality: 'partial',
      priorities: [],
      proposals: [{
        id: 'legacy-guidance',
        category: 'diet',
        title: '旧版建议',
        goal: '旧版建议',
        detail: '旧版记录没有新版所需的目标、步骤、来源和适用边界。',
        status: 'proposed',
        sourceKind: 'ai_proposed'
      }],
      adoptedActions: []
    });
    service.close();
  });

  it.each([
    { name: '旧版报告需要重读', kind: 'field_conflict' as const, field: null, code: 'INDEPENDENT_REVIEW_MISMATCH',
      title: '已读完，尚无可纳入分析的检查结果', detail: '尚无检查结果纳入健康分析' },
    { name: '数值差异', kind: 'field_conflict' as const, field: 'value' as const, code: 'VALUE_CONFLICT',
      title: '请确认 1 项检查结果', detail: '检查结果、单位或日期' },
    { name: '原始内容不清楚', kind: 'field_conflict' as const, field: 'issues' as const, code: 'EVIDENCE_BINDING_UNCLEAR',
      title: '1 项原始依据还不够清楚', detail: '原文、检查日期或异常提示还没有读清' },
    { name: '健康解读缺少依据', kind: 'derived_safety' as const, field: null, code: 'evidence_mismatch:synthetic',
      title: '这次健康解读暂不可用', detail: '无法从报告得到支持' },
    { name: '健康解读有用药风险', kind: 'derived_safety' as const, field: null, code: 'dosage_boundary:synthetic',
      title: '这次健康解读暂不可用', detail: '不能据此采取行动' }
  ])('$name 提供具体下一步，不让用户理解内部核对流程', async ({ kind, field, code, title, detail }) => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
    await service.importFiles([{ path: '/tmp/合成核对资料.txt', bytes: Buffer.from('项目甲 1.0') }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    const span = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!;
    const candidate: ExtractionResult['candidates'][number] = {
      localKey: 'item-a', originalName: '项目甲', standardNameCandidate: null,
      value: { kind: 'numeric', rawText: '1.0', decimal: '1.0', comparator: 'eq' },
      unitRaw: null, referenceRangeRaw: null, reportedAbnormalFlag: null, specimen: null, method: null,
      bodySite: null, clinicalDate: null, evidence: [{ sourceSpanId: span.id, quote: span.quote }], issues: []
    };
    const issueId = service.store.saveExtractionReviewIssue({
      documentId, kind, severity: 'blocking', candidateOptions: [candidate], evidenceRefs: [span.id], reasonCodes: [code],
      candidateDiffs: field ? [{ localKey: candidate.localKey, itemName: candidate.originalName, fields: [field] }] : []
    });
    const review = service.getSnapshot(null).reviews.find((issue) => issue.id === issueId)!;
    expect(review.title).toBe(title);
    expect(review.description).toContain(detail);
    expect(`${review.title} ${review.description}`).not.toMatch(/旧版逐字段|新规则|两轮|候选|安全入库|已通过|已确认正常/);
    expect(review).toMatchObject({ severity: 'blocking', resolutionStatus: 'open', reasonCodes: [code], candidateOptions: [candidate] });
    expect(service.store.listOpenExtractionReviewIssues().find((issue) => issue.id === issueId)?.reasonCodes).toEqual([code]);
    service.close();
  });

  it('已进入处理中心的失败资料不再建立新批次', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    await service.importFiles([{ path: '/tmp/虚构长报告.txt', bytes: Buffer.from('纯虚构报告') }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    const accountState = {
      status: 'connected' as const,
      displayLabel: 'masked@example.com',
      quota: { status: 'available' as const, primaryUsedPercent: 1, secondaryUsedPercent: null, resetsAt: null },
      runtimeVersion: 'test-runtime',
      lastCheckedAt: '2026-09-18T01:00:00Z'
    };
    service.processNow({ accountState, consentVersion: 1, documentIds: [documentId] });
    const fingerprint = stableHash({ provider: 'codex-chatgpt', displayLabel: accountState.displayLabel });
    const job = service.store.claimNextQueuedJob('test-runner', fingerprint)!;
    const attemptId = service.store.startJobAttempt(job.id, 'test-runtime');
    service.store.finishJobAttempt({ attemptId, status: 'failed', errorCode: 'CODEX_TURN_TIMEOUT' });
    service.store.finishJob(job.id, 'failed');

    expect(() => service.processNow({ accountState, consentVersion: 1, documentIds: [documentId] }))
      .toThrow('DOCUMENT_ALREADY_IN_PROCESSING');
    service.store.createWaitingAuthBatch({
      cutoff: '2026-09-18T01:00:00Z', initialStatus: 'queued', consentId: job.consentId,
      groups: [{ personId, documentIds: [documentId], inputSignature: 'newer-timeout-task' }]
    });
    const newerJob = service.store.claimNextQueuedJob('test-runner-2', fingerprint)!;
    const newerAttemptId = service.store.startJobAttempt(newerJob.id, 'test-runtime');
    service.store.finishJobAttempt({ attemptId: newerAttemptId, status: 'failed', errorCode: 'CODEX_TURN_TIMEOUT' });
    service.store.finishJob(newerJob.id, 'failed');

    const snapshot = service.getSnapshot(accountState);
    expect(snapshot).toMatchObject({
      pendingInboxCount: 0,
      inbox: [expect.objectContaining({ id: documentId, inProcessingCenter: true })],
      jobs: [
        expect.objectContaining({ status: 'failed', statusText: expect.stringContaining('等待超时'), canCancel: false, canRetry: true }),
        expect.objectContaining({ status: 'failed', statusText: expect.stringContaining('较新的处理任务'), canCancel: false, canRetry: false })
      ]
    });
    service.close();
  });

  it('新任务已取消时不能接管旧失败任务的资料恢复入口', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
    await service.importFiles([{ path: '/tmp/合成未完成报告.txt', bytes: Buffer.from('项目甲 1.0') }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    const accountState = {
      status: 'connected' as const, displayLabel: 'fixture@example.test',
      quota: { status: 'available' as const, primaryUsedPercent: 1, secondaryUsedPercent: null, resetsAt: null },
      runtimeVersion: 'fixture-runtime', lastCheckedAt: '2026-09-18T01:00:00Z'
    };
    service.processNow({ accountState, consentVersion: 1 });
    const fingerprint = stableHash({ provider: 'codex-chatgpt', displayLabel: accountState.displayLabel });
    const oldJob = service.store.claimNextQueuedJob('synthetic-runner', fingerprint)!;
    service.store.finishJob(oldJob.id, 'failed');
    const newBatch = service.store.createWaitingAuthBatch({ cutoff: '2026-09-18T01:00:00Z', initialStatus: 'queued',
      groups: [{ personId, documentIds: [documentId], inputSignature: 'new-cancelled-synthetic-task' }] });
    service.store.requestJobCancellation(newBatch.jobIds[0]!);
    expect(service.getSnapshot(null).jobs.find((job) => job.id === oldJob.id))
      .toMatchObject({ status: 'failed', canRetry: true, statusText: expect.stringContaining('还有 1 份资料未完成整理') });
    expect(service.getSnapshot(null).jobs.find((job) => job.id === newBatch.jobIds[0]))
      .toMatchObject({ status: 'cancelled', canRetry: false });
    service.close();
  });

  it.each(['held_report', 'zero_result'] as const)('综合未发布不被 %s 的报告结果文案覆盖', async (reportState) => {
    const service = makeService();
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
      let documentId: string;
      if (reportState === 'held_report') {
        documentId = publishedSnapshotDocuments(service, personId, 1)[0]!;
        service.store.saveExtractionReviewIssue({ documentId, stage: 'extract', kind: 'coverage_gap', severity: 'warning',
          evidenceRefs: [], preserveDocumentStatus: true, reasonCodes: ['SYNTHETIC_CONTENT_GAP'] });
      } else {
        await service.importFiles([{ path: '/tmp/合成零结果报告.txt', bytes: Buffer.from('合成栏目留空。') }], personId);
        documentId = service.store.listImportedDocuments()[0]!.id;
        service.store.setDocumentStatus(documentId, 'completed');
      }
      const task = beginSyntheticSnapshotJob(service, personId, [documentId]);
      task.complete(documentId, 'partial');
      service.store.updateJobAssessmentOutcome(task.guard, { status: 'rejected', reasonCode: 'validation_failed', snapshotId: null,
        inputSignature: 'a'.repeat(64), factRevision: service.store.getFactRevision(personId),
        contextRevision: service.store.getClinicalContextRevision(personId),
        reviewScopeSignature: service.store.getOpenReviewScopeSignature(personId) });
      task.finish('completed_with_issues');
      const shown = service.getSnapshot(null).jobs.find((job) => job.id === task.jobId)!;
      expect(shown).toMatchObject({ completedUnits: 1, status: 'completed_with_issues',
        assessmentOutcome: { status: 'rejected' }, canRetry: true });
      expect(shown.statusText).toContain('报告处理已完成，综合解读未更新');
      expect(shown.statusText).not.toContain('部分项目未纳入');
    } finally { service.close(); }
  });

  it.each(['extract', 'review_facts'] as const)('九份旧结果的%s重核完成四份时仍显示剩余五份，不按旧提交或完成数前缀推断', (stage) => {
    const service = makeService();
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
      const documentIds = publishedSnapshotDocuments(service, personId, 9);
      const job = beginSyntheticSnapshotJob(service, personId, documentIds);
      // 非连续的四份，证明不能用completedUnits当作已处理ID前缀。
      for (const index of [0, 2, 5, 8]) job.complete(documentIds[index]!);
      if (stage === 'review_facts') service.store.updateJobStage(job.jobId, stage);
      job.finish();
      const jobsBefore = service.store.listStoredJobs();
      const factsBefore = service.store.listAcceptedObservations(personId);
      const shown = service.getSnapshot(null).jobs.find((item) => item.id === job.jobId)!;
      expect(shown).toMatchObject({ status: 'failed', completedUnits: 4, totalUnits: 9, canRetry: true,
        statusText: expect.stringContaining('还有 5 份资料未完成整理') });
      expect(service.store.listStoredJobs()).toEqual(jobsBefore);
      expect(service.store.listAcceptedObservations(personId)).toEqual(factsBefore);
    } finally { service.close(); }
  });

  it.each(['queued', 'failed', 'succeeded'] as const)('更新的纯综合%s不接管未完成重核，完成的新综合也不能隐去恢复入口', (status) => {
    const service = makeService();
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
      const documentIds = publishedSnapshotDocuments(service, personId, 9);
      const oldJob = beginSyntheticSnapshotJob(service, personId, documentIds);
      for (const id of documentIds.slice(0, 4)) oldJob.complete(id);
      oldJob.finish();
      let newerJobId: string;
      if (status === 'queued') {
        newerJobId = service.store.createWaitingAuthBatch({ cutoff: '2026-09-18T01:00:00Z', initialStatus: 'queued',
          groups: [{ personId, documentIds, stage: 'analyze', inputSignature: 'synthetic-new-pure-analysis' }] }).jobIds[0]!;
      } else {
        const newer = beginSyntheticSnapshotJob(service, personId, documentIds, 'analyze');
        // 纯综合的旧事实published收据不能变成原件重读证据。
        for (const id of documentIds) newer.complete(id);
        newer.finish(status); newerJobId = newer.jobId;
        if (status === 'succeeded') saveSyntheticAssessment(service, personId,
          { id: 'synthetic-new-pure-analysis-assessment', generatedAt: '2026-09-18T02:00:00Z' });
      }
      const shown = service.getSnapshot(null).jobs.find((item) => item.id === oldJob.jobId)!;
      expect(shown).toMatchObject({ status: 'failed', canRetry: true,
        statusText: expect.stringContaining('还有 5 份资料未完成整理') });
      expect(shown.statusText).not.toContain('较新的处理任务');
      expect(service.store.getJobReadingDocumentIds(newerJobId)).toEqual(new Set());
    } finally { service.close(); }
  });

  it('新读取只接管自己范围，取消后恢复旧读取任务的剩余范围', () => {
    const service = makeService();
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
      const documentIds = publishedSnapshotDocuments(service, personId, 9);
      const oldJob = beginSyntheticSnapshotJob(service, personId, documentIds);
      for (const id of documentIds.slice(0, 4)) oldJob.complete(id);
      oldJob.finish();
      const replacementIds = documentIds.slice(4, 6);
      const newerJobId = service.store.createWaitingAuthBatch({ cutoff: '2026-09-18T01:00:00Z', initialStatus: 'queued',
        groups: [{ personId, documentIds: replacementIds, inputSignature: 'synthetic-partial-reading-handoff', stage: 'extract' }] }).jobIds[0]!;
      expect(service.getSnapshot(null).jobs.find((item) => item.id === oldJob.jobId))
        .toMatchObject({ canRetry: true, statusText: expect.stringContaining('还有 3 份资料未完成整理') });
      service.store.requestJobCancellation(newerJobId);
      expect(service.getSnapshot(null).jobs.find((item) => item.id === oldJob.jobId))
        .toMatchObject({ canRetry: true, statusText: expect.stringContaining('还有 5 份资料未完成整理') });
      expect(service.getSnapshot(null).jobs.find((item) => item.id === newerJobId))
        .toMatchObject({ status: 'cancelled', canRetry: false });
    } finally { service.close(); }
  });

  it('新读取已凭逐份收据推进到综合后仍能接替旧读取，不因阶段变化退回未读', () => {
    const service = makeService();
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
      const documentIds = publishedSnapshotDocuments(service, personId, 2);
      const oldJob = beginSyntheticSnapshotJob(service, personId, documentIds); oldJob.finish();
      const newer = beginSyntheticSnapshotJob(service, personId, documentIds);
      for (const documentId of documentIds) {
        const transmissionId = service.store.beginAiTransmission({ guard: newer.guard, documentId, stage: 'extract' });
        service.store.finishAiTransmission(transmissionId, 'completed');
        newer.complete(documentId);
      }
      service.store.updateJobStage(newer.jobId, 'analyze');
      const snapshot = service.getSnapshot(null);
      expect(snapshot.jobs.find((item) => item.id === oldJob.jobId))
        .toMatchObject({ canRetry: false, statusText: expect.stringContaining('较新的处理任务') });
      expect(snapshot.jobs.find((item) => item.id === newer.jobId))
        .toMatchObject({ stage: 'analyze', status: 'running', completedUnits: 2, totalUnits: 2 });
      expect(snapshot.jobs.find((item) => item.id === newer.jobId)?.statusText).not.toContain('未完成整理');
      newer.finish();
      expect(service.getSnapshot(null).jobs.find((item) => item.id === newer.jobId)?.statusText).not.toContain('未完成整理');
    } finally { service.close(); }
  });

  it.each(['partial', 'needs_review', 'excluded'] as const)('无接纳结果的%s逐份终态收据仍表示本轮已处理，不当成没有跑', async (outcome) => {
    const service = makeService();
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
      await service.importFiles([{ path: '/tmp/合成终态收据.txt', bytes: Buffer.from('合成未接纳原件') }], personId);
      const documentId = service.getSnapshot(null).inbox[0]!.id;
      const job = beginSyntheticSnapshotJob(service, personId, [documentId]);
      job.complete(documentId, outcome); job.finish();
      expect(service.store.isDocumentCommitted(documentId)).toBe(false);
      const shown = service.getSnapshot(null).jobs.find((item) => item.id === job.jobId)!;
      expect(shown).toMatchObject({ completedUnits: 1, totalUnits: 1, canRetry: true });
      expect(shown.statusText).not.toContain('未完成整理');
    } finally { service.close(); }
  });

  it('失败后正常移出分析的未处理原件不再列入本轮待续跑数量', () => {
    const service = makeService();
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
      const documentIds = publishedSnapshotDocuments(service, personId, 9);
      const job = beginSyntheticSnapshotJob(service, personId, documentIds);
      for (const id of documentIds.slice(0, 4)) job.complete(id);
      job.finish();
      service.setDocumentIncluded({ documentId: documentIds[4]!, included: false, confirmedExclusion: true });
      expect(service.getSnapshot(null).jobs.find((item) => item.id === job.jobId))
        .toMatchObject({ canRetry: true, statusText: expect.stringContaining('还有 4 份资料未完成整理') });
    } finally { service.close(); }
  });

  it.each(['failed', 'completed_with_issues'] as const)('新综合只接管部分旧资料时，旧 %s 任务独有的未保存报告仍可重试', async (oldStatus) => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
    await service.importFiles([
      { path: '/tmp/合成已保存报告.txt', bytes: Buffer.from('2026-09-17 LDL-C 4.2 mmol/L') },
      { path: '/tmp/合成待处理报告.txt', bytes: Buffer.from('2026-09-17 LDL-C 4.3 mmol/L') }
    ], personId);
    const [savedDocument, pendingDocument] = service.getSnapshot(null).inbox;
    const accountState = {
      status: 'connected' as const, displayLabel: 'fixture@example.test',
      quota: { status: 'available' as const, primaryUsedPercent: 1, secondaryUsedPercent: null, resetsAt: null },
      runtimeVersion: 'fixture-runtime', lastCheckedAt: '2026-09-18T01:00:00Z'
    };
    service.processNow({ accountState, consentVersion: 1 });
    const fingerprint = stableHash({ provider: 'codex-chatgpt', displayLabel: accountState.displayLabel });
    const oldJob = service.store.claimNextQueuedJob('synthetic-runner', fingerprint)!;
    const saveReport = async (documentId: string) => {
      installSyntheticLegacyTextEvidence(service, documentId);
      const spans = service.store.getDocumentExtractionBundle(documentId).manifest.spans;
      const span = spans[0]!;
      const value = span.quote!.match(/LDL-C ([\d.]+)/)![1]!;
      const result: ExtractionResult = {
        schemaVersion: 1, documentId, coveredSourceSpanIds: spans.map((item) => item.id),
        subject: { reportedName: null, evidence: [], confidence: 'absent' },
        candidates: [{ localKey: 'ldl', originalName: 'LDL-C', standardNameCandidate: 'LDL-C',
          value: { kind: 'numeric', rawText: value, decimal: value, comparator: 'eq' },
          unitRaw: 'mmol/L', referenceRangeRaw: null, reportedAbnormalFlag: null,
          specimen: null, method: null, bodySite: null, clinicalDate: '2026-09-17',
          evidence: [{ sourceSpanId: span.id, quote: span.quote }], issues: [] }]
      };
      await new DocumentExtractionPipeline(service.store, {
        runStructuredTurn: async () => ({ threadId: 'synthetic', turnId: 'synthetic', output: result })
      }).process(documentId);
    };
    await saveReport(savedDocument!.id);
    service.store.updateJobStage(oldJob.id, 'analyze');
    service.store.updateJobProgress(oldJob.id, 2);
    service.store.finishJob(oldJob.id, oldStatus);
    service.store.createWaitingAuthBatch({
      cutoff: accountState.lastCheckedAt, initialStatus: 'queued', consentId: oldJob.consentId,
      groups: [{ personId, documentIds: [savedDocument!.id], inputSignature: 'synthetic-new-analysis', stage: 'analyze' }]
    });
    expect(service.getSnapshot(accountState).jobs.find((job) => job.id === oldJob.id))
      .toMatchObject({ status: oldStatus, canRetry: true, completedUnits: 2, totalUnits: 2,
        statusText: expect.stringContaining('还有 1 份资料未完成整理，可重试继续处理') });
    expect(service.getSnapshot(accountState).jobs.find((job) => job.id === oldJob.id)?.statusText)
      .not.toContain('较新的处理任务');
    expect(service.getSnapshot(accountState).inbox.find((item) => item.id === pendingDocument!.id))
      .toMatchObject({ status: 'queued', inProcessingCenter: oldStatus === 'failed' });

    const oldUpdatedAt = service.store.listStoredJobs().find((job) => job.id === oldJob.id)!.updatedAt;
    const newerDate = new Date(Date.parse(oldUpdatedAt) + 60_000).toISOString();
    saveSyntheticAssessment(service, personId, { id: 'saved-only-assessment', generatedAt: newerDate });
    expect(service.getSnapshot(accountState).jobs.find((job) => job.id === oldJob.id))
      .toMatchObject({ canRetry: true, statusText: expect.stringContaining('还有 1 份资料未完成整理') });

    await saveReport(pendingDocument!.id);
    // 报告刚保存不代表已参与新综合；此时原先的综合已因资料变化而过期。
    expect(service.getSnapshot(accountState).jobs.find((job) => job.id === oldJob.id))
      .toMatchObject({ canRetry: true });
    saveSyntheticAssessment(service, personId, { id: 'one-system-assessment', requestedSystemIds: ['cardiovascular'],
      generatedAt: new Date(Date.parse(newerDate) + 60_000).toISOString() });
    expect(service.getSnapshot(accountState).jobs.find((job) => job.id === oldJob.id))
      .toMatchObject({ canRetry: true });
    saveSyntheticAssessment(service, personId, { id: 'all-reports-assessment',
      generatedAt: new Date(Date.parse(newerDate) + 120_000).toISOString() });
    expect(service.getSnapshot(accountState).jobs.find((job) => job.id === oldJob.id))
      .toMatchObject({ canRetry: false, statusText: expect.stringContaining('较新的处理任务') });
    service.close();
  });

  it('旧版 DOC 在完整转换组件缺失时保留原件并失败关闭', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    const bytes = Buffer.alloc(512);
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(bytes);

    const receipt = await service.importFiles([{ path: '/tmp/旧版虚构报告.doc', bytes }], personId);
    expect(receipt).toMatchObject({
      selectedCount: 1,
      importedCount: 0,
      rejected: [{ displayName: '旧版虚构报告.doc', code: 'LEGACY_DOC_CONVERSION_REQUIRED' }]
    });
    const snapshot = service.getSnapshot(null);
    expect(snapshot.inbox).toEqual([expect.objectContaining({
      displayName: '旧版虚构报告.doc',
      status: 'blocked',
      sentToAi: false
    })]);
    expect(service.store.countSourceSpans(snapshot.inbox[0]!.id)).toBe(0);
    const sourceHash = createHash('sha256').update(bytes).digest('hex');
    expect(service.store.getDocumentSourceHash(snapshot.inbox[0]!.id)).toBe(sourceHash);
    expect(existsSync(join(service.store.vaultDirectory, sourceHash.slice(0, 2), sourceHash.slice(2, 4), sourceHash))).toBe(true);
    service.close();
  });

  it('经校验的旧版 DOC 转换器保留原件并登记可追溯 PDF 转换视图', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-service-'));
    directories.push(root);
    const pdf = createMinimalPdf('Synthetic LDL 3.8 mmol/L');
    const converter: LegacyDocConverter = {
      async convert() {
        return {
          bytes: pdf,
          mediaType: 'application/pdf',
          sha256: createHash('sha256').update(pdf).digest('hex'),
          converterId: 'libreoffice-headless',
          converterVersion: '25.8.7.2',
          executableSha256: 'a'.repeat(64)
        };
      }
    };
    const service = new PersonalWorkspaceService(
      root,
      '我的家庭健康',
      () => new Date('2026-09-18T01:00:00Z'),
      () => 'Asia/Shanghai',
      converter
    );
    const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    const bytes = Buffer.alloc(512);
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(bytes);

    const receipt = await service.importFiles([{ path: '/tmp/旧版虚构报告.doc', bytes }], personId);
    expect(receipt).toMatchObject({ selectedCount: 1, importedCount: 1, rejected: [] });
    const item = service.getSnapshot(null).inbox[0]!;
    const bundle = service.store.getDocumentExtractionBundle(item.id);
    expect(bundle.manifest.mediaType).toBe('application/msword');
    expect(bundle.manifest.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(bundle.manifest.conversionWarnings).toEqual(expect.arrayContaining(['word_layout_may_differ_from_original']));
    expect(service.store.getDocumentConvertedView(item.id)).toMatchObject({ mediaType: 'application/pdf', converterId: 'libreoffice-headless', converterVersion: '25.8.7.2' });
    const originalSource = service.store.getDocumentOriginalSource(item.id);
    expect(originalSource.mediaType).toBe('application/msword');
    expect(originalSource.sourcePath).not.toBe(bundle.sourcePath);
    expect(readFileSync(originalSource.sourcePath)).toEqual(bytes);
    expect(readFileSync(bundle.sourcePath).subarray(0, 5).toString()).toBe('%PDF-');
    const evidence = service.store.getEvidenceAccess({ documentId: item.id });
    expect(evidence).toMatchObject({ mediaType: 'application/pdf', conversionView: true, displayName: '旧版虚构报告.doc' });
    const originalHash = createHash('sha256').update(bytes).digest('hex');
    const originalPath = join(service.store.vaultDirectory, originalHash.slice(0, 2), originalHash.slice(2, 4), originalHash);
    expect(existsSync(originalPath)).toBe(true);
    expect(existsSync(bundle.sourcePath)).toBe(true);
    await service.deleteDocument({ documentId: item.id, confirmedDelete: true, acknowledgedRecoveryCopies: true });
    expect(existsSync(originalPath)).toBe(false);
    expect(existsSync(bundle.sourcePath)).toBe(false);
    service.close();
  });

  it('手动处理可只冻结选中的就绪资料', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    await service.importFiles([
      { path: '/tmp/选中资料.txt', bytes: Buffer.from('纯虚构选中资料') },
      { path: '/tmp/留待下次.txt', bytes: Buffer.from('纯虚构留待下次') }
    ], personId);
    const [selected, deferred] = service.getSnapshot(null).inbox;
    const account = {
      status: 'connected' as const,
      displayLabel: 'selection@example.invalid',
      quota: { status: 'available' as const, primaryUsedPercent: 10, secondaryUsedPercent: null, resetsAt: null },
      runtimeVersion: 'test-runtime',
      lastCheckedAt: '2026-09-18T01:00:00Z'
    };
    service.processNow({ accountState: account, consentVersion: 1, documentIds: [selected!.id] });
    const job = service.store.claimNextQueuedJob('selection-test', stableHash({ provider: 'codex-chatgpt', displayLabel: account.displayLabel }));
    expect(job?.documentIds).toEqual([selected!.id]);
    expect(job?.documentIds).not.toContain(deferred!.id);
    service.close();
  });

  it('正常局部处理入口可恢复两份异名和一份缺名的旧明确上传资料，未选择原件不入范围', async () => {
    const service = makeService();
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成上传成员', relation: '本人' });
      await service.importFiles(['异名甲', '异名乙', '缺名丙', '未选资料'].map((marker) => ({
        path: `/tmp/合成归属恢复${marker}.txt`, bytes: Buffer.from(`合成归属恢复原件${marker}`)
      })), personId);
      const imported = service.getSnapshot().inbox;
      expect(imported).toHaveLength(4);
      expect(imported.every((document) => document.personAssignmentBasis === 'user_selected')).toBe(true);
      const selected = imported.filter((document) => !document.displayName.includes('未选资料')).map((document) => document.id);
      const accountState = { status: 'connected' as const, displayLabel: 'assignment-repair@example.invalid',
        quota: { status: 'available' as const, primaryUsedPercent: 1, secondaryUsedPercent: null, resetsAt: null },
        runtimeVersion: 'synthetic-runtime', lastCheckedAt: '2026-09-18T01:00:00Z' };
      const fingerprint = stableHash({ provider: 'codex-chatgpt', displayLabel: accountState.displayLabel });
      const consentId = service.store.createManualProcessingConsent({ documentIds: selected, personIds: [personId],
        accountFingerprint: fingerprint, version: 1 });
      service.store.createWaitingAuthBatch({ cutoff: '2026-09-18T01:00:00Z', consentId, initialStatus: 'queued',
        groups: [{ personId, documentIds: selected, inputSignature: 'synthetic-old-assignment-policy' }] });
      const oldJob = service.store.claimNextQueuedJob('synthetic-assignment-runner', fingerprint)!;
      const attemptId = service.store.startJobAttempt(oldJob.id, 'synthetic-runtime');
      selected.forEach((documentId, index) => service.store.saveExtractionReviewIssue({ documentId,
        jobId: oldJob.id, attemptId, stage: 'extract', kind: index === 2 ? 'coverage_gap' : 'person_conflict',
        severity: 'blocking', evidenceRefs: [], ...(index < 2 ? { reportedName: '合成其他姓名' } : {}),
        reasonCodes: [index === 2 ? 'DIRECT_ORIGINAL_IDENTITY_UNPROVEN' : 'PERSON_IDENTITY_NOT_CONFIRMED'] }));
      service.store.updateJobProgress(oldJob.id, selected.length);
      service.store.finishJobAttempt({ attemptId, status: 'waiting_user' });
      service.store.finishJob(oldJob.id, 'waiting_user');
      expect(service.processNow({ accountState, consentVersion: 2, documentIds: selected })).toMatchObject({ idempotent: false });
      const next = service.store.claimNextQueuedJob('synthetic-new-assignment-runner', fingerprint)!;
      expect(next.id).not.toBe(oldJob.id);
      expect([...next.documentIds].sort()).toEqual([...selected].sort());
      expect(service.store.listOpenExtractionReviewIssues()).toEqual([]);
      expect(service.store.getFactRevision(personId)).toBe(0);
      expect(service.store.listAcceptedObservations(personId)).toEqual([]);
      expect(service.getSnapshot().inbox).toEqual(expect.arrayContaining(imported.map((document) => expect.objectContaining({
        id: document.id, personId, personAssignmentBasis: 'user_selected', status: 'queued'
      }))));
      selected.forEach((documentId) => expect(service.store.getDocumentExtractionBundle(documentId))
        .toMatchObject({ personId, confirmedReportedName: null, confirmedPersonAliases: [] }));
      const database = new Database(service.store.databasePath, { readonly: true });
      try {
        const row = database.prepare('SELECT checkpoint_json FROM jobs WHERE id=?').get(next.id) as { checkpoint_json: string };
        expect(JSON.parse(row.checkpoint_json)).toMatchObject({ documentIds: next.documentIds, repairDocumentIds: next.documentIds });
      } finally { database.close(); }
    } finally { service.close(); }
  });

  it('已删除资料不会从收件箱自动回灌，解除抑制后才可重新导入', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    const bytes = Buffer.from('纯虚构删除与回灌测试');
    const first = await service.importFiles([{ path: '/tmp/待删除报告.txt', bytes }], personId);
    expect(first).toMatchObject({ importedCount: 1, suppressedCount: 0 });
    const documentId = service.getSnapshot(null).inbox[0]!.id;

    service.processNow();
    await expect(service.deleteDocument({ documentId, confirmedDelete: true, acknowledgedRecoveryCopies: true }))
      .rejects.toThrow('DOCUMENT_HAS_ACTIVE_JOB');
    const waitingJob = service.getSnapshot(null).jobs[0]!;
    service.store.requestJobCancellation(waitingJob.id);

    const deleted = await service.deleteDocument({ documentId, confirmedDelete: true, acknowledgedRecoveryCopies: true });
    expect(deleted).toMatchObject({ currentWorkspaceRemoved: true, rawObjectDeleted: true, retainedByRecoveryPoint: false });
    expect(service.getSnapshot(null).inbox).toEqual([]);
    expect(service.listDeletedDocuments()).toEqual([expect.objectContaining({ displayName: '待删除报告.txt' })]);

    const suppressed = await service.importFiles([{ path: '/tmp/待删除报告.txt', bytes }], personId);
    expect(suppressed).toMatchObject({ importedCount: 0, duplicateCount: 0, suppressedCount: 1 });
    expect(service.getSnapshot(null).inbox).toEqual([]);

    service.releaseDeletedDocument(deleted.sourceHash);
    const reimported = await service.importFiles([{ path: '/tmp/待删除报告.txt', bytes }], personId);
    expect(reimported).toMatchObject({ importedCount: 1, suppressedCount: 0 });
    service.close();
  });

  it('恢复点引用报告时删除当前档案但保留共享原始对象并明确回执', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    await service.importFiles([{ path: '/tmp/恢复点报告.txt', bytes: Buffer.from('纯虚构恢复点保留测试') }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    const bundle = service.store.getDocumentExtractionBundle(documentId);
    const sourcePath = bundle.sourcePath;
    await ensureLocalRecoveryPoints({ store: service.store, now: new Date('2026-09-18T02:00:00Z') });

    const deleted = await service.deleteDocument({ documentId, confirmedDelete: true, acknowledgedRecoveryCopies: true });
    expect(deleted).toMatchObject({ currentWorkspaceRemoved: true, rawObjectDeleted: false, retainedByRecoveryPoint: true });
    expect(existsSync(sourcePath)).toBe(true);
    expect(service.listDeletedDocuments()).toEqual([expect.objectContaining({ rawObjectRetained: true })]);
    service.close();
  });

  it('未指定成员的资料保持待归属且不会发送', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    await service.importFiles([{ path: '/tmp/公共资料.txt', bytes: Buffer.from('纯虚构公共资料') }], null);
    let snapshot = service.getSnapshot(null);
    expect(snapshot.inbox[0]).toMatchObject({ personId: null, status: 'needs_review', sentToAi: false });
    expect(snapshot.reviews).toHaveLength(1);
    service.store.assignDocumentPerson(snapshot.inbox[0]!.id, personId);
    snapshot = service.getSnapshot(null);
    expect(snapshot.inbox[0]).toMatchObject({ personId, status: 'queued' });
    expect(snapshot.reviews).toEqual([]);
    service.close();
  });

  it.each(['completed', 'sending', 'acknowledged', 'unknown', 'not_sent'] as const)(
    'AI读取状态%s只在已完成时把核查事项归入处理中心，不清除核查或虚增待处理数', async (transmissionStatus) => {
      const service = makeService();
      try {
        const personId = service.ensurePrimaryMember({ displayName: '合成来源成员', relation: '本人' });
        await service.importFiles([{ path: '/tmp/合成已读待查.txt', bytes: Buffer.from('合成来源未核实') }], personId);
        const documentId = service.getSnapshot().inbox[0]!.id;
        const issueId = service.store.saveExtractionReviewIssue({ documentId, kind: 'coverage_gap', severity: 'blocking',
          evidenceRefs: [], reasonCodes: ['SYNTHETIC_SOURCE_UNCLEAR'] });
        // 模拟保留来源回执但历史任务不在当前处理投影中的旧记录；不调用模型。
        vi.spyOn(service.store, 'listProcessingDocumentIds').mockReturnValue(new Set());
        vi.spyOn(service.store, 'listDocumentAiTransmissionStatuses').mockReturnValue(new Map([[documentId, transmissionStatus]]));
        const snapshot = service.getSnapshot();
        expect(snapshot.inbox[0]).toMatchObject({ id: documentId, status: 'needs_review',
          aiTransmissionStatus: transmissionStatus, inProcessingCenter: transmissionStatus === 'completed' });
        expect(snapshot.pendingInboxCount).toBe(transmissionStatus === 'completed' ? 0 : 1);
        expect(snapshot.reviews).toContainEqual(expect.objectContaining({ id: issueId, resolutionStatus: 'open' }));
        expect(service.store.listOpenExtractionReviewIssues()).toContainEqual(expect.objectContaining({ id: issueId }));
        expect(snapshot.inbox[0]!.issue).not.toContain('尚未可靠确认所属成员');
      } finally { service.close(); }
    }
  );

  it.each(['unassigned', 'person_conflict', 'person_reason', 'value_conflict', 'non_source_issue', 'source_plus_value', 'source_plus_non_source'] as const)(
    '已完成AI传输但存在%s时仍保留收件箱核查，不能借来源迁移隐藏身份或结果选择', async (mode) => {
      const service = makeService();
      try {
        const personId = service.ensurePrimaryMember({ displayName: '合成身份保护成员', relation: '本人' });
        await service.importFiles([{ path: '/tmp/合成身份待查.txt', bytes: Buffer.from('合成身份或结果尚未确定') }],
          mode === 'unassigned' ? null : personId);
        const documentId = service.getSnapshot().inbox[0]!.id;
        const issueId = service.store.saveExtractionReviewIssue({ documentId,
          kind: mode === 'non_source_issue' ? 'overwrite_protected' : 'coverage_gap', severity: 'blocking',
          evidenceRefs: [], reasonCodes: ['SYNTHETIC_SOURCE_UNCLEAR'],
          ...(mode === 'value_conflict' ? { candidateDiffs: [{ localKey: 'synthetic-choice', itemName: '合成项目', fields: ['value'] }] } : {}) });
        if (mode === 'person_conflict') service.store.saveExtractionReviewIssue({ documentId, kind: 'person_conflict',
          severity: 'blocking', evidenceRefs: [], reasonCodes: ['SYNTHETIC_SUBJECT_UNCERTAIN'] });
        if (mode === 'person_reason') service.store.saveExtractionReviewIssue({ documentId, kind: 'field_conflict',
          severity: 'blocking', evidenceRefs: [], reasonCodes: ['PERSON_IDENTITY_NOT_CONFIRMED'] });
        if (mode === 'source_plus_value') service.store.saveExtractionReviewIssue({ documentId, kind: 'field_conflict',
          severity: 'blocking', evidenceRefs: [], candidateDiffs: [{ localKey: 'synthetic-mixed-choice',
            itemName: '合成结果选择', fields: ['value'] }] });
        if (mode === 'source_plus_non_source') service.store.saveExtractionReviewIssue({ documentId, kind: 'overwrite_protected',
          severity: 'blocking', evidenceRefs: [], reasonCodes: ['SYNTHETIC_PROTECTED_RESULT'] });
        vi.spyOn(service.store, 'listProcessingDocumentIds').mockReturnValue(new Set());
        vi.spyOn(service.store, 'listDocumentAiTransmissionStatuses').mockReturnValue(new Map([[documentId, 'completed']]));
        const snapshot = service.getSnapshot();
        expect(snapshot.inbox[0]).toMatchObject({ id: documentId, status: 'needs_review',
          personId: mode === 'unassigned' ? null : personId, inProcessingCenter: false });
        expect(snapshot.pendingInboxCount).toBe(1);
        expect(snapshot.reviews).toContainEqual(expect.objectContaining({ id: issueId, resolutionStatus: 'open' }));
        expect(service.store.listOpenExtractionReviewIssues()).toContainEqual(expect.objectContaining({ id: issueId }));
        // 真正进入过处理任务的旧投影仍按原规则展示；本次只收紧新增的来源迁移。
        vi.mocked(service.store.listProcessingDocumentIds).mockReturnValue(new Set([documentId]));
        expect(service.getSnapshot().inbox[0]).toMatchObject({ id: documentId, inProcessingCenter: true });
      } finally { service.close(); }
    }
  );

  it('部分发布的 warning 只说明未纳入范围，不冒充需要用户确认的旧版核对', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    await service.importFiles([{
      path: '/tmp/部分发布资料.txt',
      bytes: Buffer.from('项目甲 1.0 mmol/L')
    }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    installSyntheticLegacyTextEvidence(service, documentId);
    const span = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!;
    const candidate = {
      localKey: 'item-a', originalName: '项目甲', standardNameCandidate: null,
      value: { kind: 'numeric' as const, rawText: '1.0', decimal: '1.0', comparator: 'eq' as const },
      unitRaw: 'mmol/L', referenceRangeRaw: null, reportedAbnormalFlag: null,
      specimen: null, method: null, bodySite: null, clinicalDate: null,
      evidence: [{ sourceSpanId: span.id, quote: span.quote }], issues: []
    };
    const initialReviewId = service.store.saveExtractionReviewIssue({
      documentId, kind: 'field_conflict', severity: 'blocking', evidenceRefs: [span.id],
      candidateOptions: [candidate],
      candidateDiffs: [{ localKey: candidate.localKey, itemName: candidate.originalName, fields: ['value'] }],
      reasonCodes: ['TEST_FIXTURE'],
      documentRun: {
        coverageComplete: true, coveredSourceSpanIds: [span.id], manifestSpanIds: [span.id], chunkCount: 1
      }
    });
    service.acceptCorrectedFacts({ issueId: initialReviewId, documentId, candidates: [candidate] });
    expect(service.store.isDocumentCommitted(documentId)).toBe(true);

    const warningId = service.store.saveExtractionReviewIssue({
      documentId, stage: 'extract', kind: 'field_conflict', severity: 'warning',
      preserveDocumentStatus: true, evidenceRefs: [span.id], candidateOptions: [candidate],
      reasonCodes: ['numeric_value_not_in_evidence']
    });
    let snapshot = service.getSnapshot(null);
    expect(snapshot.inbox).toContainEqual(expect.objectContaining({ id: documentId, status: 'completed' }));
    expect(snapshot.openReviewCount).toBe(0);
    expect(snapshot.reviews.find((review) => review.id === warningId)).toMatchObject({
      severity: 'warning',
      title: '这份报告有读取内容待核实',
      description: expect.stringContaining('没有用于健康分析，不代表结果正常')
    });
    expect(snapshot.reviews.find((review) => review.id === warningId)?.title).not.toContain('按新规则重新核对');

    for (const reasonCode of ['direct_original_clinical_date_unverified', 'direct_original_clinical_date_binding_missing']) {
      const fieldOnlyId = service.store.saveExtractionReviewIssue({
        documentId, stage: 'extract', kind: 'coverage_gap', severity: 'warning',
        preserveDocumentStatus: true, evidenceRefs: [span.id], candidateOptions: [],
        reasonCodes: [reasonCode]
      });
      const fieldOnly = service.getSnapshot(null).reviews.find((review) => review.id === fieldOnlyId);
      expect(fieldOnly).toMatchObject({ title: '结果已保存，部分日期或辅助信息待确认',
        description: expect.stringContaining('检查结果已保存；部分检查日期暂不能确认') });
      expect(fieldOnly?.description).not.toContain('没有用于健康分析');
    }
    expect(service.getSnapshot(null).openReviewCount).toBe(0);

    const blockingId = service.store.saveExtractionReviewIssue({
      documentId, kind: 'field_conflict', severity: 'blocking', preserveDocumentStatus: true,
      evidenceRefs: [span.id], candidateOptions: [candidate]
    });
    snapshot = service.getSnapshot(null);
    expect(snapshot.openReviewCount).toBe(1);
    expect(snapshot.reviews.find((review) => review.id === blockingId)?.title).toBe('请重新读取这份报告');
    service.close();
  });

  it('显式选择已有信息性缺口的已完成报告时建立整份重核任务', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    await service.importFiles([{ path: '/tmp/旧报告.txt', bytes: Buffer.from('项目甲 1.0 mmol/L') }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    installSyntheticLegacyTextEvidence(service, documentId);
    const span = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!;
    const candidate = {
      localKey: 'item-a', originalName: '项目甲', standardNameCandidate: null,
      value: { kind: 'numeric' as const, rawText: '1.0', decimal: '1.0', comparator: 'eq' as const },
      unitRaw: 'mmol/L', referenceRangeRaw: null, reportedAbnormalFlag: null,
      specimen: null, method: null, bodySite: null, clinicalDate: null,
      evidence: [{ sourceSpanId: span.id, quote: span.quote }], issues: []
    };
    const blockingId = service.store.saveExtractionReviewIssue({
      documentId, kind: 'field_conflict', severity: 'blocking', evidenceRefs: [span.id],
      candidateOptions: [candidate], reasonCodes: ['TEST_FIXTURE'],
      documentRun: {
        coverageComplete: true, coveredSourceSpanIds: [span.id], manifestSpanIds: [span.id], chunkCount: 1
      }
    });
    service.acceptCorrectedFacts({ issueId: blockingId, documentId, candidates: [candidate] });
    service.store.saveExtractionReviewIssue({
      documentId, stage: 'extract', kind: 'field_conflict', severity: 'warning',
      preserveDocumentStatus: true, evidenceRefs: [span.id], candidateOptions: [candidate],
      reasonCodes: ['TEST_FIXTURE']
    });
    const accountState = {
      status: 'connected' as const, displayLabel: 'masked@example.com',
      quota: { status: 'available' as const, primaryUsedPercent: 1, secondaryUsedPercent: null, resetsAt: null },
      runtimeVersion: 'test-runtime', lastCheckedAt: '2026-09-24T01:00:00Z'
    };
    const oldBatch = service.store.createWaitingAuthBatch({
      cutoff: '2026-09-23T01:00:00Z', initialStatus: 'queued',
      groups: [{ personId, documentIds: [documentId], inputSignature: 'historical-failed-repair' }]
    });
    // 构造历史失败记录；本测试只关心重试调度，不依赖任务执行状态机。
    const db = new Database(service.store.databasePath);
    db.prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").run(oldBatch.jobIds[0]!);
    db.close();
    expect(service.processNow({ accountState, consentVersion: 1, documentIds: [documentId] }))
      .toMatchObject({ idempotent: false });
    expect(service.store.listStoredJobs()).toContainEqual(expect.objectContaining({
      stage: 'extract', status: 'queued', documentIds: [documentId]
    }));
    service.close();
  });

  it('事实冲突可选择仅归档，派生安全问题可只放弃说明', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    await service.importFiles([{ path: '/tmp/冲突资料.txt', bytes: Buffer.from('纯虚构冲突资料') }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    const spanId = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!.id;
    const fieldIssueId = service.store.saveExtractionReviewIssue({
      documentId, kind: 'field_conflict', severity: 'blocking', evidenceRefs: [spanId]
    });
    service.store.resolveReviewIssue({ issueId: fieldIssueId, documentId, action: 'archive_only' });
    expect(service.getSnapshot(null)).toMatchObject({ inbox: [expect.objectContaining({ id: documentId, status: 'completed' })], reviews: [] });

    const derivedIssueId = service.store.saveExtractionReviewIssue({
      documentId, kind: 'derived_safety', severity: 'blocking', evidenceRefs: [spanId], preserveDocumentStatus: true
    });
    service.store.resolveReviewIssue({ issueId: derivedIssueId, documentId, action: 'dismiss_derived' });
    expect(service.getSnapshot(null)).toMatchObject({ inbox: [expect.objectContaining({ id: documentId, status: 'completed' })], reviews: [] });
    service.close();
  });

  it('按授权目录和本地时区建立每日幂等任务', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-schedule-service-'));
    const inbox = mkdtempSync(join(tmpdir(), 'family-health-schedule-inbox-'));
    directories.push(root, inbox);
    const service = new PersonalWorkspaceService(
      root,
      '我的家庭健康',
      () => new Date('2026-09-18T01:00:00Z'),
      () => 'Asia/Shanghai'
    );
    const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    const account = {
      status: 'connected' as const,
      displayLabel: 'schedule@example.invalid',
      quota: { status: 'available' as const, primaryUsedPercent: 10, secondaryUsedPercent: null, resetsAt: null },
      runtimeVersion: 'test-runtime',
      lastCheckedAt: '2026-09-18T01:00:00Z'
    };
    const binding = service.createInboxBinding({
      canonicalPath: inbox,
      personId,
      recursive: true,
      allowScheduledAiProcessing: true,
      consentVersion: 1,
      accountState: account
    });
    await service.importFiles([{ path: join(inbox, '虚构日程资料.txt'), bytes: Buffer.from('纯虚构日程资料') }], personId, binding.id);
    const current = service.getSnapshot(account);
    const updated = service.updateSchedule({ enabled: true, localTime: '08:00', expectedRevision: current.scheduleRevision });
    expect(updated).toMatchObject({ enabled: true, timeZone: 'Asia/Shanghai', localTime: '08:00' });
    expect(service.runScheduleCheck(account)).toMatchObject({ created: true, queued: true, idempotent: false });
    expect(service.runScheduleCheck(account)).toMatchObject({ created: false, queued: false });
    expect(service.getSnapshot(account)).toMatchObject({
      scheduleEnabled: true,
      scheduleLocalTime: '08:00',
      scheduleTimeZone: 'Asia/Shanghai',
      jobs: [expect.objectContaining({ status: 'queued', stage: 'extract' })]
    });
    service.close();
  });

  it('连续 30 天无新增且周期性重复重启，不创建空任务或膨胀日程记录', () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-30-day-schedule-'));
    directories.push(root);
    let now = new Date('2026-09-01T13:05:00Z');
    let service = new PersonalWorkspaceService(root, '我的家庭健康', () => now, () => 'Asia/Shanghai');
    service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    service.updateSchedule({ enabled: true, localTime: '20:00', expectedRevision: service.getSchedule().revision });
    service.close();

    const account = {
      status: 'disconnected' as const,
      displayLabel: null,
      quota: { status: 'unknown' as const, primaryUsedPercent: null, secondaryUsedPercent: null, resetsAt: null },
      runtimeVersion: 'test-runtime',
      lastCheckedAt: null
    };
    for (let day = 0; day < 30; day += 1) {
      now = new Date(Date.UTC(2026, 8, 1 + day, 13, 5));
      // 每天至少启动一次、每隔七天同日再启动一次：覆盖跨日无增长和同日幂等，
      // 同时避免在较慢的 Intel CI 上用 90 次完整数据库启动消耗单测超时预算。
      for (let restart = 0; restart < (day % 7 === 0 ? 2 : 1); restart += 1) {
        service = new PersonalWorkspaceService(root, '我的家庭健康', () => now, () => 'Asia/Shanghai');
        expect(service.runScheduleCheck(account)).toEqual({ created: false, queued: false, idempotent: false });
        expect(service.store.listStoredJobs()).toEqual([]);
        service.close();
      }
    }

    const database = new Database(join(root, 'health.db'), { readonly: true });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM schedules`).get()).toEqual({ count: 1 });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM batches`).get()).toEqual({ count: 0 });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM jobs`).get()).toEqual({ count: 0 });
    database.close();
  }, 60_000);
});
