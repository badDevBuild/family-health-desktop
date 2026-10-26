import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { MemberAssessmentSnapshotV3, SourceManifest } from '@contracts';
import { RevisionConflictError, WorkspaceStore, WORKSPACE_SCHEMA_VERSION } from './index.js';
import { stableHash } from '@core';

const directories: string[] = [];
function makeStore(options: {
  busyTimeoutMs?: number;
  failureInjector?: (point: 'after_source_object_insert' | 'during_schema_migration') => void;
} = {}): WorkspaceStore {
  const directory = mkdtempSync(join(tmpdir(), 'family-health-store-'));
  directories.push(directory);
  return new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:00:00Z'), ...options });
}

function createSchemaV2Database(directory: string): void {
  const database = new Database(join(directory, 'health.db'));
  database.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, created_at TEXT NOT NULL,
      settings_revision INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    INSERT INTO workspaces (id, schema_version, created_at, settings_revision)
    VALUES ('workspace-v2', 2, '2026-09-17T00:00:00Z', 4);
    PRAGMA user_version = 2;
  `);
  database.close();
}

function syntheticAssessmentSnapshot(
  store: WorkspaceStore,
  personId: string,
  marker: string
): Omit<MemberAssessmentSnapshotV3, 'id' | 'status' | 'generatedAt'> {
  return {
    schemaVersion: 3,
    personId,
    inputSignature: createHash('sha256').update(marker).digest('hex'),
    mode: 'full',
    requestedSystemIds: [],
    overview: {
      id: 'overview', headline: `合成综合 ${marker}`, summary: `合成内容 ${marker}`,
      claimIds: [], actionIds: ['action-followup'], limitations: []
    },
    systems: [], claims: [],
    actions: [{
      id: 'action-followup', dedupeKey: `followup-${marker}`, systemIds: [], claimIds: [],
      kind: 'test_followup', title: `合成行动 ${marker}`, why: `合成原因 ${marker}`,
      firstStep: '核对原始资料', timing: null, timingBasis: 'none', reviewPlan: null,
      caution: null, urgency: 'routine', evidenceIds: [], knowledgeSourceIds: []
    }],
    questions: [], knowledgeSources: [],
    factRevision: store.getFactRevision(personId),
    contextRevision: store.getClinicalContextRevision(personId),
    reviewScopeSignature: store.getOpenReviewScopeSignature(personId),
    promptVersion: 'test-p02', rulesVersion: 'test-rules', modelId: 'test-model',
    reasoningEffort: 'medium', validationMode: 'local_only',
    reviewedTargetIds: [], heldTargetIds: [], limitations: [], evidenceCatalog: [],
    processingPlan: { strategy: 'full', trigger: 'none', partitionCount: 0, partitionHeldTargetCount: 0 },
    knowledgeVerifications: []
  };
}

function documentedPlanFixture(store: WorkspaceStore, options: {
  quote?: string;
  rawText?: string;
  evidenceQuote?: string;
  clinicalDate?: string | null;
  metadataDate?: string;
  metadataPrecision?: 'year' | 'month' | 'day';
  mediaType?: string;
  sourceLocator?: Partial<Pick<SourceManifest['spans'][number], 'spanKind' | 'page' | 'blockId' | 'lineStart' | 'lineEnd'>>;
} = {}) {
  const person = store.createPerson({ displayName: '合成医嘱成员', relation: '本人' });
  const quote = options.quote ?? '2026-08-28 医生建议：3个月后复查甲状腺功能。';
  const mediaType = options.mediaType ?? 'text/plain';
  const source = store.putSourceObject({ bytes: Buffer.from(quote), mediaType, displayName: '合成门诊医嘱.txt' });
  const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
  const sourceSpanId = `plan-span-${document.documentId}`;
  store.saveSourceManifest({
    id: `plan-manifest-${document.documentId}`, sourceObjectId: source.id, sha256: source.sha256,
    mediaType, originalDisplayName: '合成门诊医嘱.txt', totalUnits: 1,
    coveredUnitIndexes: [0], normalizerVersion: 'test', conversionWarnings: [], createdAt: '2026-09-18T00:00:00Z',
    spans: [{ id: sourceSpanId, documentId: document.documentId, spanKind: 'line', page: null,
      blockId: null, lineStart: 1, lineEnd: 1, quote, readability: 'clear', ...options.sourceLocator }]
  });
  const acceptanceId = store.saveAcceptanceDecision({ method: 'auto', actor: 'policy', rulesVersion: 'test',
    inputSignature: 'plan-input', outputHash: 'plan-output', reviewRef: null, decision: 'accept' });
  store.publishFacts({
    personId: person.id, documentId: document.documentId, documentCommitKey: 'p'.repeat(64),
    expectedRevision: 0, changeSetHash: 'q'.repeat(64), summary: '合成报告安排',
    observations: [{ conceptKey: '随访建议', originalName: '随访建议', modelStandardNameCandidate: null,
      rawText: options.rawText ?? '3个月后复查甲状腺功能', valueKind: 'text', decimalValue: null, qualifier: null, unit: null,
      referenceRange: null, clinicalDate: options.clinicalDate === undefined ? '2026-08-28' : options.clinicalDate,
      abnormalFlag: 'unknown', documentId: document.documentId, sourceSpanId, acceptanceId,
      specimen: null, method: null, bodySite: null, evidence: [{ sourceSpanId, quote }] }],
    ...(options.metadataDate ? { reportMetadata: { reportKind: null, title: null, organization: null,
      campus: null, department: null, reportNumber: null, encounterIdentifier: null,
      sampleIdentifiers: [], examItems: [], times: [{ value: options.metadataDate,
        precision: options.metadataPrecision ?? 'month', role: 'encounter' as const, evidence: [{ sourceSpanId, quote }] }] } } : {})
  });
  const fact = store.listAcceptedObservations(person.id)[0]!;
  const snapshot = syntheticAssessmentSnapshot(store, person.id, document.documentId);
  snapshot.actions[0] = { ...snapshot.actions[0]!, kind: 'documented_plan',
    title: '复查甲状腺功能', why: '报告记录了医生的复查安排。', firstStep: '按报告建议复查甲状腺功能。',
    timing: '3个月后', timingBasis: 'documented', evidenceIds: ['plan-evidence'] };
  snapshot.evidenceCatalog = [{ id: 'plan-evidence', kind: 'observation', observationId: fact.id,
    documentId: document.documentId, eventId: fact.eventId, sourceSpanId, knowledgeId: null,
    label: '合成门诊医嘱.txt', locator: '第 1 行', quote: options.evidenceQuote ?? quote }];
  return { person, document, snapshot };
}

function legacyAdoptionFixture(store: WorkspaceStore, plannedTime = '每周一晚饭后') {
  const person = store.createPerson({ displayName: '合成旧计划成员' });
  const proposalId = `legacy-proposal-${person.id}`;
  const database = new Database(store.databasePath);
  database.prepare(`INSERT INTO lifestyle_proposals_v2
    (id, person_id, category, title, detail, consult_professional, evidence_refs_json,
      status, version, created_at, updated_at)
    VALUES (?, ?, 'exercise', '饭后散步', '循序渐进地活动', 0, '[]', 'proposed', 1, ?, ?)`)
    .run(proposalId, person.id, '2026-10-10T00:00:00Z', '2026-10-10T00:00:00Z');
  database.close();
  const input = { personId: person.id, proposalId, userGoal: '保留本人目标：计划时间不能替换正文',
    selectedStartingOption: '先从楼下走一圈开始', plannedTime, owner: '本人和家人',
    progressNote: '已和家人商量，觉得不适就休息', dueDate: '2026-10-12' };
  const adoption = store.adoptLifestyleProposal(input);
  return { person, input, adoption, action: store.listActionItems(person.id)[0]! };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('WorkspaceStore', () => {
  function assessmentOnlyFixture() {
    const store = makeStore();
    const { person, document } = documentedPlanFixture(store);
    const observations = store.listAcceptedObservations(person.id);
    const accountFingerprint = 'synthetic-assessment-only-account';
    const consentId = store.createManualProcessingConsent({ assessmentOnly: true,
      documentIds: [document.documentId], personIds: [person.id],
      historicalObservationIds: observations.map((item) => item.id), accountFingerprint, version: 1 });
    return { store, person, document, observations, accountFingerprint, consentId };
  }

  it.each(['failed', 'succeeded', 'completed_with_issues', 'cancelled'] as const)(
    '同一资料综合在%s后允许新的更新意图，旧任务及同次请求的幂等性保持', (status) => {
      const { store, person, document, observations, accountFingerprint, consentId } = assessmentOnlyFixture();
      const groups = [{ personId: person.id, documentIds: [document.documentId],
        stage: 'analyze' as const, inputSignature: 'synthetic-repeat-assessment' }];
      const options = { cutoff: '2026-09-18T00:00:00Z', initialStatus: 'queued' as const, consentId, groups };
      const first = store.createWaitingAuthBatch(options);
      const database = new Database(store.databasePath);
      // 模拟已安装旧版本留下的终态任务，包含不可随新意图清空的恢复证据。
      database.prepare('UPDATE jobs SET idempotency_key=?,checkpoint_json=json_set(checkpoint_json,\'$.syntheticRecovery\',?) WHERE id=?')
        .run(`manual:${groups[0]!.inputSignature}`, 'preserve-unknown-receipt', first.jobIds[0]);
      expect(store.claimNextQueuedJob('synthetic-first-lease', accountFingerprint)?.id).toBe(first.jobIds[0]);
      store.finishJob(first.jobIds[0]!, status);
      const oldJob = database.prepare('SELECT * FROM jobs WHERE id=?').get(first.jobIds[0]);
      const newConsentId = store.createManualProcessingConsent({ assessmentOnly: true,
        documentIds: [document.documentId], personIds: [person.id],
        historicalObservationIds: observations.map(item => item.id), accountFingerprint, version: 1 });
      const second = store.createWaitingAuthBatch({ ...options, consentId: newConsentId });
      expect(second.idempotent).toBe(false);
      expect(second.jobIds[0]).not.toBe(first.jobIds[0]);
      expect(database.prepare('SELECT * FROM jobs WHERE id=?').get(first.jobIds[0])).toEqual(oldJob);
      expect(store.isAssessmentOnlyJob(second.jobIds[0]!)).toBe(true);
      expect(store.createWaitingAuthBatch({ ...options, consentId: newConsentId }))
        .toEqual({ ...second, idempotent: true });
      expect(store.claimNextQueuedJob('synthetic-next-lease', accountFingerprint)?.id).toBe(second.jobIds[0]);
      store.finishJob(second.jobIds[0]!, 'failed');
      // 重放同一请求即使已结束也不能另建任务，更不能重置未知回执或预算。
      expect(store.createWaitingAuthBatch({ ...options, consentId: newConsentId }))
        .toEqual({ ...second, idempotent: true });
      expect(database.prepare('SELECT COUNT(*) AS n FROM jobs').get()).toEqual({ n: 2 });
      expect(store.listAcceptedObservations(person.id)).toEqual(observations);
      database.close(); store.close();
    });

  it('仅成员综合的授权、阶段和每次发送都硬禁止原件提取，已接纳事实保持不变', () => {
    const { store, person, document, observations, accountFingerprint, consentId } = assessmentOnlyFixture();
    const queued = store.createWaitingAuthBatch({ cutoff: '2026-09-18T00:00:00Z', initialStatus: 'queued', consentId,
      groups: [{ personId: person.id, documentIds: [document.documentId], stage: 'analyze', inputSignature: 'assessment-only-scope' }] });
    expect(store.isAssessmentOnlyJob(queued.jobIds[0]!)).toBe(true);
    const database = new Database(store.databasePath);
    const consent = database.prepare('SELECT scope_json FROM consents WHERE id=?').get(consentId) as { scope_json: string };
    expect(JSON.parse(consent.scope_json)).toMatchObject({ assessmentOnly: true, personIds: [person.id],
      stages: ['analyze', 'review_derived', 'publish'], historicalObservationIds: observations.map((item) => item.id) });
    const job = store.claimNextQueuedJob('synthetic-assessment-lease', accountFingerprint)!;
    expect(job.stage).toBe('analyze');
    const attemptId = store.startJobAttempt(job.id, 'synthetic-runtime', 'gpt-6.1-sol', 'medium');
    const guard = { jobId: job.id, attemptId, consentId, accountFingerprint };
    expect(() => store.assertJobExecutionActive(guard, document.documentId)).not.toThrow();
    expect(() => store.assertObservationScopeActive(guard, person.id, observations)).not.toThrow();
    expect(() => store.assertObservationScopeActive(guard, person.id,
      [{ id: 'not-in-confirmed-facts', documentId: document.documentId }])).toThrow('HISTORICAL_FACTS_OUTSIDE_CONSENT_SCOPE');
    for (const stage of ['extract', 'review_facts', 'direct_original_read', 'other']) {
      expect(() => store.beginAiTransmission({ guard, documentId: document.documentId, stage }))
        .toThrow('ASSESSMENT_ONLY_STAGE_OUTSIDE_SCOPE');
    }
    for (const stage of ['prepare_clinical_context', 'member_assessment', 'assessment_repair', 'focused_review']) {
      const transmission = store.beginAiTransmission({ guard, documentId: document.documentId, stage });
      store.finishAiTransmission(transmission, 'completed');
    }
    expect(database.prepare('SELECT COUNT(*) AS n FROM ai_transmissions').get()).toEqual({ n: 4 });
    expect(() => store.updateJobStage(job.id, 'extract')).toThrow('ASSESSMENT_ONLY_STAGE_OUTSIDE_SCOPE');
    expect(() => store.publishFacts({ personId: person.id, documentId: document.documentId,
      documentCommitKey: 'p'.repeat(64), expectedRevision: store.getFactRevision(person.id), changeSetHash: 'q'.repeat(64),
      summary: '不应写入', observations: [], executionGuard: guard })).toThrow('ASSESSMENT_ONLY_FACT_WRITE_FORBIDDEN');
    database.prepare("UPDATE jobs SET stage='extract' WHERE id=?").run(job.id);
    expect(() => store.assertJobExecutionActive(guard)).toThrow('ASSESSMENT_ONLY_STAGE_OUTSIDE_SCOPE');
    expect(store.listAcceptedObservations(person.id)).toEqual(observations);
    database.close();
    store.close();
  });

  it.each(['extract', 'other_person', 'repair'] as const)('仅综合授权不能创建%s范围的任务', (mode) => {
    const { store, person, document, consentId } = assessmentOnlyFixture();
    expect(() => store.createWaitingAuthBatch({ cutoff: '2026-09-18T00:00:00Z', initialStatus: 'queued', consentId,
      groups: [{ personId: mode === 'other_person' ? 'not-this-person' : person.id,
        documentIds: [document.documentId], stage: mode === 'extract' ? 'extract' : 'analyze', inputSignature: 'assessment-only-invalid' }],
      ...(mode === 'repair' ? { repairDocumentIds: [document.documentId] } : {})
    })).toThrow('ASSESSMENT_ONLY_SCOPE_INVALID');
    expect(store.listStoredJobs()).toEqual([]);
    store.close();
  });

  it.each(['uncommitted', 'other_person', 'other_fact', 'no_facts'] as const)('仅综合授权%s无效时不写入新授权', (mode) => {
    const { store, person, document, observations, accountFingerprint } = assessmentOnlyFixture();
    const otherPerson = store.createPerson({ displayName: '合成另一成员' });
    const otherSource = store.putSourceObject({ bytes: Buffer.from('合成另一成员资料'), mediaType: 'text/plain', displayName: '合成另一成员.txt' });
    const otherDocument = store.registerImportedDocument({ sourceObjectId: otherSource.id, personId: otherPerson.id });
    const source = store.putSourceObject({ bytes: Buffer.from('合成新报告未处理'), mediaType: 'text/plain', displayName: '合成待处理.txt' });
    const pending = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const database = new Database(store.databasePath);
    const before = database.prepare('SELECT COUNT(*) AS n FROM consents').get();
    expect(() => store.createManualProcessingConsent({ assessmentOnly: true,
      documentIds: [mode === 'uncommitted' ? pending.documentId : mode === 'other_person' ? otherDocument.documentId : document.documentId],
      personIds: [person.id], historicalObservationIds: mode === 'no_facts' ? []
        : mode === 'other_fact' ? ['fact-not-accepted-for-this-person'] : observations.map((item) => item.id),
      accountFingerprint, version: 1 })).toThrow('ASSESSMENT_ONLY_SCOPE_INVALID');
    expect(database.prepare('SELECT COUNT(*) AS n FROM consents').get()).toEqual(before);
    database.close();
    store.close();
  });

  it('仅综合任务部分完成后重试仍为综合阶段，不扩大原授权', () => {
    const { store, person, document, accountFingerprint, consentId } = assessmentOnlyFixture();
    const queued = store.createWaitingAuthBatch({ cutoff: '2026-09-18T00:00:00Z', initialStatus: 'queued', consentId,
      groups: [{ personId: person.id, documentIds: [document.documentId], stage: 'analyze', inputSignature: 'assessment-only-retry' }] });
    const database = new Database(store.databasePath);
    database.prepare("UPDATE jobs SET status='completed_with_issues', stage='publish' WHERE id=?").run(queued.jobIds[0]!);
    const before = database.prepare('SELECT scope_json FROM consents WHERE id=?').get(consentId);
    store.retryFailedJob(queued.jobIds[0]!);
    expect(store.claimNextQueuedJob('synthetic-retry-lease', accountFingerprint)).toMatchObject({
      id: queued.jobIds[0], stage: 'analyze'
    });
    expect(store.listStoredJobs()[0]!.status).toBe('running');
    expect(database.prepare('SELECT scope_json FROM consents WHERE id=?').get(consentId)).toEqual(before);
    expect(store.isAssessmentOnlyJob(queued.jobIds[0]!)).toBe(true);
    database.close();
    store.close();
  });

  it('仅综合任务被篡改为提取阶段时不能领取，且不创建尝试', () => {
    const { store, person, document, accountFingerprint, consentId } = assessmentOnlyFixture();
    const queued = store.createWaitingAuthBatch({ cutoff: '2026-09-18T00:00:00Z', initialStatus: 'queued', consentId,
      groups: [{ personId: person.id, documentIds: [document.documentId], stage: 'analyze', inputSignature: 'assessment-only-tamper' }] });
    const database = new Database(store.databasePath);
    database.prepare("UPDATE jobs SET stage='extract' WHERE id=?").run(queued.jobIds[0]!);
    expect(store.claimNextQueuedJob('synthetic-invalid-lease', accountFingerprint)).toBeNull();
    expect(store.listStoredJobs()[0]!.status).toBe('waiting_user');
    expect(database.prepare('SELECT COUNT(*) AS n FROM job_attempts').get()).toEqual({ n: 0 });
    database.close();
    store.close();
  });

  it('姓名确认跨报告持久化复用，但不同成员、撤销、归档和近似姓名不自动通过', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '合成成员甲' });
    const other = store.createPerson({ displayName: '合成成员乙' });
    store.confirmPersonNameAlias({ personId: person.id, reportedName: '合成昵称Ａ' });
    expect(store.isConfirmedPersonName(person.id, ' 合成昵称A ')).toBe(true);
    expect(store.isConfirmedPersonName(person.id, '合成昵称B')).toBe(false);
    expect(store.isConfirmedPersonName(other.id, '合成昵称A')).toBe(false);
    expect(() => store.confirmPersonNameAlias({ personId: other.id, reportedName: '合成昵称A' }))
      .toThrow('PERSON_NAME_ALIAS_CONFLICT');
    expect(() => store.confirmPersonNameAlias({ personId: person.id, reportedName: other.displayName }))
      .toThrow('PERSON_NAME_ALIAS_CONFLICT');
    const rootDirectory = store.rootDirectory;
    store.close();
    const reopened = new WorkspaceStore({ rootDirectory });
    expect(reopened.listConfirmedPersonNameAliases(person.id)).toEqual(['合成昵称Ａ']);
    reopened.revokePersonNameAlias({ personId: person.id, reportedName: '合成昵称A' });
    expect(reopened.isConfirmedPersonName(person.id, '合成昵称A')).toBe(false);
    reopened.confirmPersonNameAlias({ personId: person.id, reportedName: '合成昵称A' });
    reopened.archivePerson({ personId: person.id, expectedDisplayRevision: 1 });
    expect(reopened.isConfirmedPersonName(person.id, '合成昵称A')).toBe(false);
    reopened.close();
  });

  it('单份身份确认同时保存成员别名，下一份资料仍保留原始报告姓名', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '合成成员本名' });
    const source = store.putSourceObject({ bytes: Buffer.from('姓名：合成昵称'), mediaType: 'text/plain', displayName: '合成身份.txt' });
    const { documentId } = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.saveSourceManifest({ id: 'identity-alias-manifest', sourceObjectId: source.id, sha256: source.sha256,
      mediaType: 'text/plain', originalDisplayName: '合成身份.txt', totalUnits: 1, coveredUnitIndexes: [0],
      normalizerVersion: 'test', conversionWarnings: [], createdAt: '2026-09-18T00:00:00Z',
      spans: [{ id: 'identity-alias-span', documentId, spanKind: 'line', page: null,
        blockId: null, lineStart: 1, lineEnd: 1, quote: '姓名：合成昵称', readability: 'clear' }] });
    const issueId = store.saveExtractionReviewIssue({ documentId, kind: 'person_conflict', severity: 'blocking',
      evidenceRefs: ['identity-alias-span'], reportedName: '合成昵称', reasonCodes: ['PERSON_IDENTITY_NOT_CONFIRMED'] });
    store.confirmDocumentIdentity({ issueId, documentId, personId: person.id });
    expect(store.getDocumentExtractionBundle(documentId)).toMatchObject({
      personDisplayName: '合成成员本名', confirmedReportedName: '合成昵称', confirmedPersonAliases: ['合成昵称']
    });
    const nextSource = store.putSourceObject({ bytes: Buffer.from('姓名：合成昵称；下一份报告'), mediaType: 'text/plain', displayName: '合成后续.txt' });
    const next = store.registerImportedDocument({ sourceObjectId: nextSource.id, personId: person.id });
    store.saveSourceManifest({ id: 'identity-next-manifest', sourceObjectId: nextSource.id, sha256: nextSource.sha256,
      mediaType: 'text/plain', originalDisplayName: '合成后续.txt', totalUnits: 1, coveredUnitIndexes: [0],
      normalizerVersion: 'test', conversionWarnings: [], createdAt: '2026-09-18T00:00:00Z',
      spans: [{ id: 'identity-next-span', documentId: next.documentId, spanKind: 'line', page: null,
        blockId: null, lineStart: 1, lineEnd: 1, quote: '姓名：合成昵称；下一份报告', readability: 'clear' }] });
    expect(store.getDocumentExtractionBundle(next.documentId)).toMatchObject({
      confirmedReportedName: null, confirmedPersonAliases: ['合成昵称']
    });
    store.close();
  });

  it('有独立恢复点和明确授权才全量重建，保留原文件、本人记录与已采纳行动', async () => {
    const store = makeStore();
    const { person, document, snapshot } = documentedPlanFixture(store);
    const published = store.publishMemberAssessmentSnapshot({ snapshot });
    const adopted = store.adoptMemberAssessmentAction({ personId: person.id, snapshotId: published.snapshotId,
      actionId: snapshot.actions[0]!.id });
    const userAction = store.createUserAction({ personId: person.id, title: '本人安排', detail: '本人独立填写的计划', dueDate: null, dueText: '周末' });
    const note = store.createManualNote({ personId: person.id, kind: 'free_text', immutableText: '本人提供的补充情况',
      effectiveDate: null, structuredFields: {}, expectedContextRevision: 0 });
    store.confirmPersonNameAlias({ personId: person.id, reportedName: '合成别名' });
    const sources = store.listProcessingRebuildSources();
    const oldBundle = store.getDocumentExtractionBundle(document.documentId);
    const originalBytes = readFileSync(sources[0]!.sourcePath);
    const originalActions = store.listActionItems(person.id);
    const oldConsent = store.createManualProcessingConsent({ documentIds: [document.documentId], personIds: [person.id],
      accountFingerprint: 'old-account', version: 1 });
    const oldBatch = store.createWaitingAuthBatch({ cutoff: '2026-09-18T00:00:00Z', consentId: oldConsent, initialStatus: 'queued',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: 'old-rebuild-task' }] });
    expect(store.claimNextQueuedJob('old-synthetic-runner', 'old-account')?.id).toBe(oldBatch.jobIds[0]!);
    store.finishJob(oldBatch.jobIds[0]!, 'waiting_user');
    store.saveExtractionReviewIssue({ documentId: document.documentId, jobId: oldBatch.jobIds[0]!, kind: 'coverage_gap',
      severity: 'warning', preserveDocumentStatus: true, evidenceRefs: ['plan-span-' + document.documentId],
      reasonCodes: ['old-warning'] });
    // 从零验收时旧人工接纳的报告事实也要归档，不能遮盖新流程识别错误。
    const edit = new Database(store.databasePath);
    edit.exec(`UPDATE acceptance_decisions SET actor = 'user', method = 'user_resolution'`);
    edit.prepare(`INSERT INTO clinical_statements
      (id,person_id,document_id,statement_kind,text,reported_status,source_span_id,source_kind,created_at)
      VALUES ('synthetic-user-statement', ?, NULL, 'context', '本人独立补充', NULL, NULL, 'user_reported', ?)`)
      .run(person.id, '2026-09-18T00:00:00Z');
    edit.close();
    const backup = await store.createProcessingRebuildBackup();
    const receipt = store.rebuildProcessingResults({ backup, manifests: [{ ...oldBundle.manifest,
      id: 'rebuild-manifest', normalizerVersion: 'rebuild-normalizer',
      spans: oldBundle.manifest.spans.map((span) => ({ ...span, id: `new-${span.id}` })) }],
      accountFingerprint: 'new-account', consentVersion: 1, confirmedRebuildReportResults: true,
      confirmedPersonAliases: [{ personId: person.id, reportedName: '本次明确确认的合成别名' }],
      promptVersion: 'test-extract-new', rulesVersion: 'test-rules-new' });
    expect(receipt).toMatchObject({ rebuildId: backup.id, documentCount: 1, personCount: 1, recoveryPointCreated: true });
    expect(store.listAcceptedObservations(person.id)).toEqual([]);
    expect(store.listMemberAssessmentSnapshots(person.id)).toEqual([]);
    expect(store.isDocumentCommitted(document.documentId)).toBe(false);
    expect(store.listOpenExtractionReviewIssues()).toEqual([]);
    expect(store.listManualNotes(person.id)).toEqual([note]);
    expect(store.listActionItems(person.id)).toEqual(originalActions);
    expect(store.listActionItems(person.id).map((item) => item.id)).toEqual(expect.arrayContaining([adopted.id, userAction.id]));
    expect(store.isConfirmedPersonName(person.id, '合成别名')).toBe(true);
    expect(store.isConfirmedPersonName(person.id, '本次明确确认的合成别名')).toBe(true);
    expect(readFileSync(sources[0]!.sourcePath)).toEqual(originalBytes);
    expect(store.getDocumentExtractionBundle(document.documentId).manifest.normalizerVersion).toBe('rebuild-normalizer');
    const old = new Database(backup.databasePath, { readonly: true });
    expect((old.prepare('SELECT COUNT(*) AS count FROM observations').get() as { count: number }).count).toBe(1);
    expect((old.prepare('SELECT COUNT(*) AS count FROM member_assessment_snapshots_v3').get() as { count: number }).count).toBe(1);
    expect(old.prepare(`SELECT id FROM person_name_aliases WHERE reported_name = '本次明确确认的合成别名'`).get()).toBeUndefined();
    old.close();
    const current = new Database(store.databasePath, { readonly: true });
    expect(current.prepare(`SELECT text,source_kind FROM clinical_statements WHERE id = 'synthetic-user-statement'`).get())
      .toEqual({ text: '本人独立补充', source_kind: 'user_reported' });
    expect(current.prepare('SELECT revoked_at FROM consents WHERE id = ?').get(oldConsent)).toEqual({ revoked_at: '2026-09-18T00:00:00.000Z' });
    expect(current.prepare('SELECT status FROM jobs WHERE id = ?').get(oldBatch.jobIds[0]!)).toEqual({ status: 'cancelled' });
    const newJob = current.prepare('SELECT id,checkpoint_json FROM jobs WHERE batch_id = ?').get(receipt.batchId) as { id: string; checkpoint_json: string };
    const newConsent = (JSON.parse(newJob.checkpoint_json) as { consentId: string }).consentId;
    expect(newConsent).not.toBe(oldConsent);
    current.close();
    store.revokeConsent(newConsent);
    expect(store.claimNextQueuedJob('synthetic-runner', 'new-account')).toBeNull();
    store.close();
  });

  it('重建尊重已排除报告，并清理旧接纳标识而不重新发送其原件', async () => {
    const store = makeStore();
    const { person, document } = documentedPlanFixture(store);
    const manifest = store.getDocumentExtractionBundle(document.documentId).manifest;
    const source = store.putSourceObject({ bytes: Buffer.from('合成排除报告'), mediaType: 'text/plain', displayName: '合成排除.txt' });
    const excluded = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const edit = new Database(store.databasePath);
    edit.prepare(`UPDATE documents SET excluded_from_analysis = 1, status = 'accepted',
      acceptance_id = (SELECT acceptance_id FROM documents WHERE id = ?) WHERE id = ?`)
      .run(document.documentId, excluded.documentId);
    edit.prepare(`INSERT INTO document_commits (document_id,commit_key,publication_id,revision,committed_at)
      SELECT ?, 'synthetic-excluded-commit', publication_id,revision,committed_at
      FROM document_commits WHERE document_id = ?`).run(excluded.documentId, document.documentId);
    edit.close();
    const excludedPath = join(store.vaultDirectory, source.vaultRelativePath);
    const excludedBytes = readFileSync(excludedPath);
    expect(store.listProcessingRebuildSources().map((item) => item.documentId)).toEqual([document.documentId]);
    const backup = await store.createProcessingRebuildBackup();
    const receipt = store.rebuildProcessingResults({ backup, manifests: [manifest], accountFingerprint: 'account',
      consentVersion: 1, confirmedRebuildReportResults: true, promptVersion: 'new', rulesVersion: 'new' });
    expect(receipt.documentCount).toBe(1);
    const current = new Database(store.databasePath, { readonly: true });
    expect(current.prepare(`SELECT status,excluded_from_analysis,acceptance_id FROM documents WHERE id = ?`).get(excluded.documentId))
      .toEqual({ status: 'ignored', excluded_from_analysis: 1, acceptance_id: null });
    expect(current.prepare(`SELECT id FROM jobs WHERE batch_id = ? AND checkpoint_json LIKE ?`).get(receipt.batchId,
      `%${excluded.documentId}%`)).toBeUndefined();
    current.close();
    expect(store.isDocumentCommitted(excluded.documentId)).toBe(false);
    expect(readFileSync(excludedPath)).toEqual(excludedBytes);
    store.close();
  });

  it.each([
    { mediaType: 'application/pdf', locator: { spanKind: 'page' as const, page: 1, lineStart: null, lineEnd: null }, newKind: 'image' as const },
    { mediaType: 'image/png', locator: { spanKind: 'image' as const, page: 1, lineStart: null, lineEnd: null }, newKind: 'image' as const },
    { mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      locator: { spanKind: 'block' as const, blockId: 'block-1' }, newKind: 'block' as const },
    { mediaType: 'text/plain', locator: { spanKind: 'line' as const, lineStart: 1, lineEnd: 1 }, newKind: 'line' as const }
  ])('重建只复用相同原件唯一定位，已采纳行动继续打开新来源而旧事实不回流：$mediaType', async ({ mediaType, locator, newKind }) => {
    const store = makeStore();
    const { person, document, snapshot } = documentedPlanFixture(store, { mediaType, sourceLocator: locator });
    const published = store.publishMemberAssessmentSnapshot({ snapshot });
    store.adoptMemberAssessmentAction({ personId: person.id, snapshotId: published.snapshotId, actionId: snapshot.actions[0]!.id });
    const originalActions = store.listActionItems(person.id);
    const oldManifest = store.getDocumentExtractionBundle(document.documentId).manifest;
    const oldSpanId = oldManifest.spans[0]!.id;
    const source = store.listProcessingRebuildSources()[0]!;
    const originalBytes = readFileSync(source.sourcePath);
    const newQuote = '新流程独立规范化的合成来源文字，不是旧核对或旧事实。';
    const freshManifest = { ...oldManifest, id: 'fresh-locator-manifest', normalizerVersion: 'fresh-locator-normalizer',
      spans: oldManifest.spans.map((span) => ({ ...span, id: `fresh-${span.id}`, spanKind: newKind, quote: newQuote,
        readability: 'partial' as const })) };
    const backup = await store.createProcessingRebuildBackup();
    store.rebuildProcessingResults({ backup, manifests: [freshManifest], accountFingerprint: 'account', consentVersion: 1,
      confirmedRebuildReportResults: true, promptVersion: 'new', rulesVersion: 'new' });
    const preservedEvidence = store.listActionItems(person.id)[0]!.evidenceRefs![0]!;
    expect(preservedEvidence.sourceSpanId).toBe(oldSpanId);
    expect(store.listActionItems(person.id)).toEqual(originalActions);
    expect(store.getEvidenceAccess({ sourceSpanId: oldSpanId })).toMatchObject({ documentId: document.documentId,
      sourcePath: source.sourcePath, sourcePage: locator.page ?? null, quote: newQuote, readability: 'partial' });
    expect(store.getDocumentExtractionBundle(document.documentId).manifest).toMatchObject({ id: 'fresh-locator-manifest',
      normalizerVersion: 'fresh-locator-normalizer', spans: [{ id: oldSpanId, quote: newQuote, readability: 'partial' }] });
    expect(store.listAcceptedObservations(person.id)).toEqual([]);
    expect(store.listMemberAssessmentSnapshots(person.id)).toEqual([]);
    expect(readFileSync(source.sourcePath)).toEqual(originalBytes);
    store.close();
  });

  it.each(['old-duplicate', 'new-duplicate', 'changed-page', 'converted-doc', 'old-manifest-hash', 'old-manifest-object'] as const)(
    '原件定位或旧源标识无法严格对应时不猜测复用：%s', async (condition) => {
      const store = makeStore();
      const { document } = documentedPlanFixture(store, {
        mediaType: condition === 'converted-doc' ? 'application/msword' : 'application/pdf',
        sourceLocator: { spanKind: 'page', page: 1, lineStart: null, lineEnd: null }
      });
      const oldManifest = store.getDocumentExtractionBundle(document.documentId).manifest;
      const oldSpan = oldManifest.spans[0]!;
      if (condition === 'old-duplicate') {
        // 合成旧库存在同页多个定位的状态，不能借重建猜测哪一个历史编号正确。
        const edit = new Database(store.databasePath);
        edit.prepare(`INSERT INTO source_spans
          (id,document_id,span_kind,page_number,block_id,line_start,line_end,quote,readability,normalizer_version)
          SELECT 'another-old-page-one',document_id,span_kind,page_number,block_id,line_start,line_end,
            quote,readability,normalizer_version FROM source_spans WHERE id = ?`).run(oldSpan.id);
        edit.close();
      }
      if (condition === 'old-manifest-hash' || condition === 'old-manifest-object') {
        const otherSource = condition === 'old-manifest-object'
          ? store.putSourceObject({ bytes: Buffer.from('另一份合成原件'), mediaType: 'application/pdf', displayName: '另一原件.pdf' }) : null;
        const edit = new Database(store.databasePath);
        if (otherSource) edit.prepare(`UPDATE source_manifests SET source_object_id = ? WHERE document_id = ?`)
          .run(otherSource.id, document.documentId);
        else edit.prepare(`UPDATE source_manifests SET sha256 = ? WHERE document_id = ?`)
          .run('0'.repeat(64), document.documentId);
        edit.close();
      }
      const newSpan = { ...oldSpan, id: 'new-unique-page-id', page: condition === 'changed-page' ? 2 : 1,
        quote: '本轮重新读取的来源' };
      const spans = condition === 'new-duplicate' ? [newSpan, { ...newSpan, id: 'another-new-page-one' }] : [newSpan];
      const freshManifest = { ...oldManifest, id: 'fresh-no-guessed-locator', spans,
        totalUnits: spans.length, coveredUnitIndexes: spans.map((_, index) => index) };
      const backup = await store.createProcessingRebuildBackup();
      store.rebuildProcessingResults({ backup, manifests: [freshManifest], accountFingerprint: 'account', consentVersion: 1,
        confirmedRebuildReportResults: true, promptVersion: 'new', rulesVersion: 'new' });
      expect(store.getDocumentExtractionBundle(document.documentId).manifest.spans.map((span) => span.id))
        .toEqual(expect.arrayContaining(spans.map((span) => span.id)));
      expect(() => store.getEvidenceAccess({ sourceSpanId: oldSpan.id })).toThrow('EVIDENCE_NOT_FOUND');
      store.close();
    }
  );

  it('本次新增别名必须属于重建范围，别名冲突会连同清理一起回滚', async () => {
    const store = makeStore();
    const { person, document } = documentedPlanFixture(store);
    const other = store.createPerson({ displayName: '合成范围外成员' });
    const manifest = store.getDocumentExtractionBundle(document.documentId).manifest;
    const backup = await store.createProcessingRebuildBackup();
    const input = { backup, manifests: [manifest], accountFingerprint: 'account', consentVersion: 1,
      confirmedRebuildReportResults: true as const, promptVersion: 'new', rulesVersion: 'new' };
    expect(() => store.rebuildProcessingResults({ ...input,
      confirmedPersonAliases: [{ personId: other.id, reportedName: '合成越界别名' }] }))
      .toThrow('PROCESSING_REBUILD_ALIAS_SCOPE_INVALID');
    expect(() => store.rebuildProcessingResults({ ...input, confirmedPersonAliases: [
      { personId: person.id, reportedName: '合成事务暂存别名' },
      { personId: person.id, reportedName: other.displayName }
    ] })).toThrow('PERSON_NAME_ALIAS_CONFLICT');
    expect(store.isConfirmedPersonName(person.id, '合成事务暂存别名')).toBe(false);
    expect(store.listAcceptedObservations(person.id)).toHaveLength(1);
    expect(store.isDocumentCommitted(document.documentId)).toBe(true);
    expect(store.listStoredJobs()).toEqual([]);
    store.close();
  });

  it('活动任务、过期恢复点或未明确授权都不能清理旧处理结果', async () => {
    const store = makeStore();
    const { person, document } = documentedPlanFixture(store);
    const manifest = store.getDocumentExtractionBundle(document.documentId).manifest;
    store.createWaitingAuthBatch({ cutoff: '2026-09-18T00:00:00Z', initialStatus: 'queued',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: 'rebuild-active' }] });
    await expect(store.createProcessingRebuildBackup()).rejects.toThrow('PROCESSING_REBUILD_HAS_ACTIVE_JOB');
    expect(store.claimNextQueuedJob('synthetic-runner', 'account')).toBeNull();
    const backup = await store.createProcessingRebuildBackup();
    const input = { backup, manifests: [manifest], accountFingerprint: 'account', consentVersion: 1,
      confirmedRebuildReportResults: true as const, promptVersion: 'new', rulesVersion: 'new' };
    expect(() => store.rebuildProcessingResults({ ...input, accountFingerprint: '' })).toThrow('PROCESSING_REBUILD_AUTH_REQUIRED');
    expect(store.listAcceptedObservations(person.id)).toHaveLength(1);
    store.updateClinicalContext(person.id, { synthetic: '新补充' }, 0);
    expect(() => store.rebuildProcessingResults(input)).toThrow('PROCESSING_REBUILD_BACKUP_CHANGED');
    expect(store.listAcceptedObservations(person.id)).toHaveLength(1);
    expect(store.isDocumentCommitted(document.documentId)).toBe(true);
    store.close();
  });

  it('v36升级独立保存用户时间说明，保留原医嘱和可恢复的升级前数据库', () => {
    const store = makeStore();
    const { person, snapshot } = documentedPlanFixture(store);
    const published = store.publishMemberAssessmentSnapshot({ snapshot });
    const action = store.adoptMemberAssessmentAction({ personId: person.id, snapshotId: published.snapshotId, actionId: snapshot.actions[0]!.id });
    const originalFacts = store.listAcceptedObservations(person.id);
    const originalAssessments = store.listMemberAssessmentSnapshots(person.id);
    const rootDirectory = store.rootDirectory;
    const databasePath = store.databasePath;
    store.close();
    const old = new Database(databasePath);
    old.exec('ALTER TABLE action_items DROP COLUMN user_schedule_text; UPDATE workspaces SET schema_version = 36; PRAGMA user_version = 36;');
    old.close();
    const upgraded = new WorkspaceStore({ rootDirectory });
    expect(upgraded.listActionItems(person.id)[0]).toMatchObject({ id: action.id, dueText: '3个月后', userScheduleText: null });
    expect(upgraded.listActionItems(person.id)).toEqual([action]);
    expect(upgraded.listAcceptedObservations(person.id)).toEqual(originalFacts);
    expect(upgraded.listMemberAssessmentSnapshots(person.id)).toEqual(originalAssessments);
    const backups = readdirSync(upgraded.schemaBackupDirectory).filter((name) => name.endsWith('.db'));
    expect(backups).toHaveLength(1);
    const backup = new Database(join(upgraded.schemaBackupDirectory, backups[0]!), { readonly: true });
    expect(backup.pragma('user_version', { simple: true })).toBe(36);
    expect(backup.prepare('SELECT due_text FROM action_items WHERE id = ?').get(action.id)).toEqual({ due_text: '3个月后' });
    backup.close();
    expect(upgraded.integrityCheck()).toBe('ok');
    upgraded.close();
  });

  it('用户安排独立修改、清空，原医嘱时间和可打开的来源始终保留', () => {
    const store = makeStore();
    const { person, snapshot } = documentedPlanFixture(store);
    const published = store.publishMemberAssessmentSnapshot({ snapshot });
    const action = store.adoptMemberAssessmentAction({ personId: person.id, snapshotId: published.snapshotId, actionId: snapshot.actions[0]!.id });
    const scheduled = store.updateActionSchedule({ personId: person.id, actionId: action.id, dueDate: '2026-11-28', userScheduleText: '  上午已预约  ', expectedRevision: action.userRevision });
    expect(scheduled).toMatchObject({ dueDate: '2026-11-28', userScheduleText: '上午已预约', dueText: '3个月后', userRevision: 2, title: action.title, detail: action.detail, evidenceRefs: snapshot.evidenceCatalog });
    expect(() => store.updateActionSchedule({ personId: person.id, actionId: action.id, dueDate: null, userScheduleText: null, expectedRevision: 1 })).toThrow(RevisionConflictError);
    const cleared = store.updateActionSchedule({ personId: person.id, actionId: action.id, dueDate: null, userScheduleText: '', expectedRevision: 2 });
    expect(cleared).toMatchObject({ dueDate: null, userScheduleText: null, dueText: '3个月后', userRevision: 3 });
    expect(store.listMemberAssessmentSnapshots(person.id)[0]!.actions[0]!.timing).toBe('3个月后');
    store.close();
  });

  it('v36旧本人时间和旧采纳时间迁入独立字段，清空后重开不会复活', () => {
    const store = makeStore();
    const legacy = legacyAdoptionFixture(store);
    const userAction = store.createUserAction({ personId: legacy.person.id, title: '本人安排',
      detail: '保留本人正文', dueDate: null, dueText: '下周二上午' });
    const rootDirectory = store.rootDirectory;
    const databasePath = store.databasePath;
    const before = new Database(databasePath, { readonly: true });
    const originals = before.prepare('SELECT id, detail, due_text, due_date FROM action_items ORDER BY id').all();
    const adoptionOriginal = before.prepare('SELECT * FROM action_adoptions_v2').all();
    before.close();
    store.close();
    const old = new Database(databasePath);
    old.exec('ALTER TABLE action_items DROP COLUMN user_schedule_text; UPDATE workspaces SET schema_version = 36; PRAGMA user_version = 36;');
    old.close();
    const upgraded = new WorkspaceStore({ rootDirectory });
    expect(upgraded.listActionItems(legacy.person.id).find((action) => action.id === userAction.id)?.userScheduleText).toBe('下周二上午');
    expect(upgraded.listActionItems(legacy.person.id).find((action) => action.id === legacy.action.id)?.userScheduleText).toBe('每周一晚饭后');
    const after = new Database(databasePath, { readonly: true });
    expect(after.prepare('SELECT id, detail, due_text, due_date FROM action_items ORDER BY id').all()).toEqual(originals);
    expect(after.prepare('SELECT * FROM action_adoptions_v2').all()).toEqual(adoptionOriginal);
    after.close();
    for (const action of upgraded.listActionItems(legacy.person.id)) {
      upgraded.updateActionSchedule({ personId: legacy.person.id, actionId: action.id,
        dueDate: null, userScheduleText: null, expectedRevision: action.userRevision });
    }
    upgraded.close();
    const reopened = new WorkspaceStore({ rootDirectory });
    expect(reopened.listActionItems(legacy.person.id).every((action) => action.userScheduleText === null)).toBe(true);
    expect(reopened.listActionAdoptions(legacy.person.id)[0]!.plannedTime).toBeNull();
    reopened.close();
  });

  it.each([
    { label: '只改日期', dueDate: '2026-10-19', userScheduleText: '每周一晚饭后' },
    { label: '只改文字', dueDate: '2026-10-12', userScheduleText: '周末上午回顾记录' },
    { label: '清空安排', dueDate: null, userScheduleText: null }
  ])('旧采纳事项$label不丢失其他本人字段，不再混入旧计划时间', ({ dueDate, userScheduleText }) => {
    const store = makeStore();
    const { person, action, input } = legacyAdoptionFixture(store);
    expect(action.userScheduleText).toBe(input.plannedTime);
    expect(action.evidenceLabel).toBe('本人已采纳的生活建议');
    expect(action.evidenceLabel).not.toContain('proposal:');
    const database = new Database(store.databasePath, { readonly: true });
    const original = database.prepare('SELECT detail, due_text FROM action_items WHERE id = ?').get(action.id);
    const updated = store.updateActionSchedule({ personId: person.id, actionId: action.id,
      dueDate, userScheduleText, expectedRevision: action.userRevision });
    expect(updated).toMatchObject({ dueDate, userScheduleText, dueText: '由我决定开始时间' });
    expect(updated.detail).toBe([input.userGoal, `起始方式：${input.selectedStartingOption}`,
      `负责人：${input.owner}`, `起始备注：${input.progressNote}`].join('\n'));
    expect(updated.detail).not.toContain(`计划时间：${input.plannedTime}`);
    expect(store.listActionAdoptions(person.id)[0]).toMatchObject({ userGoal: input.userGoal,
      selectedStartingOption: input.selectedStartingOption, owner: input.owner, progressNote: input.progressNote,
      plannedTime: userScheduleText, dueDate });
    expect(database.prepare('SELECT detail, due_text FROM action_items WHERE id = ?').get(action.id)).toEqual(original);
    database.close();
    store.close();
  });

  it('日程拒绝无效日期、额外医嘱字段、越权成员及已归档成员，不留下部分修改', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '合成成员' });
    const other = store.createPerson({ displayName: '另一成员' });
    const action = store.createUserAction({ personId: person.id, title: '复诊', detail: '原安排', dueDate: null, dueText: '原时间' });
    const input = { personId: person.id, actionId: action.id, dueDate: null, userScheduleText: null, expectedRevision: 1 };
    expect(() => store.updateActionSchedule({ ...input, dueDate: '2026-02-30' })).toThrow();
    expect(() => store.updateActionSchedule({ ...input, userScheduleText: '长'.repeat(201) })).toThrow();
    expect(() => store.updateActionSchedule({ ...input, dueText: '覆盖医嘱' } as typeof input)).toThrow();
    expect(() => store.updateActionSchedule({ ...input, personId: other.id })).toThrow('ACTION_NOT_FOUND');
    expect(store.listActionItems(person.id)).toEqual([action]);
    const database = new Database(store.databasePath);
    database.prepare('UPDATE persons SET archived_at = ? WHERE id = ?').run('2026-10-10T00:00:00Z', person.id);
    database.close();
    expect(() => store.updateActionSchedule(input)).toThrow('ACTION_NOT_FOUND');
    expect(store.listActionItems(person.id)).toEqual([action]);
    store.close();
  });

  it('旧采纳的180字时间说明只改日期时完整保存，201字仍严格拒绝', () => {
    const store = makeStore();
    const plannedTime = '安排'.repeat(90);
    const { person, action } = legacyAdoptionFixture(store, plannedTime);
    const input = { personId: person.id, actionId: action.id, dueDate: '2026-10-19',
      userScheduleText: action.userScheduleText!, expectedRevision: action.userRevision };
    expect(input.userScheduleText).toHaveLength(180);
    const updated = store.updateActionSchedule(input);
    expect(updated).toMatchObject({ dueDate: '2026-10-19', userScheduleText: plannedTime });
    expect(store.listActionAdoptions(person.id)[0]).toMatchObject({ dueDate: '2026-10-19', plannedTime });
    expect(() => store.updateActionSchedule({ ...input, expectedRevision: updated.userRevision,
      userScheduleText: '长'.repeat(201) })).toThrow();
    expect(store.listActionItems(person.id)[0]).toEqual(updated);
    store.close();
  });

  it('完成日期仅取真实完成状态事件，修改日程不会冒充新的完成时间', () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-completed-date-'));
    directories.push(directory);
    let now = '2026-10-10T00:00:00Z';
    const store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date(now) });
    const person = store.createPerson({ displayName: '合成成员' });
    const action = store.createUserAction({ personId: person.id, title: '复诊', detail: '', dueDate: null, dueText: null });
    expect(action.completedAt).toBeNull();
    now = '2026-10-11T00:00:00Z';
    const done = store.updateActionStatus({ actionId: action.id, status: 'completed', expectedRevision: 1 });
    expect(done.completedAt).toBe('2026-10-11T00:00:00.000Z');
    now = '2026-10-12T00:00:00Z';
    const rescheduled = store.updateActionSchedule({ personId: person.id, actionId: action.id, expectedRevision: 2, dueDate: null, userScheduleText: '补记' });
    expect(rescheduled.completedAt).toBe('2026-10-11T00:00:00.000Z');
    const reopened = store.updateActionStatus({ actionId: action.id, status: 'planned', expectedRevision: 3 });
    expect(reopened.completedAt).toBeNull();
    store.close();
  });

  it('数据库被其他写入者锁定时快速失败且不留下半事务，解锁后可恢复', () => {
    const store = makeStore({ busyTimeoutMs: 5 });
    const locker = new Database(store.databasePath);
    locker.exec('BEGIN IMMEDIATE');
    expect(() => store.createPerson({ displayName: '锁定期间不应写入' })).toThrow(/database is locked/i);
    locker.exec('ROLLBACK');
    locker.close();
    expect(store.listPersons()).toEqual([]);
    expect(store.createPerson({ displayName: '解锁后恢复' })).toMatchObject({ displayName: '解锁后恢复' });
    expect(store.integrityCheck()).toBe('ok');
    store.close();
  });

  it('数据库容量耗尽时对象登记与审计一并回滚，并清理未引用对象文件', () => {
    let failOnce = true;
    const store = makeStore({
      busyTimeoutMs: 5,
      failureInjector: () => {
        if (!failOnce) return;
        failOnce = false;
        throw new Error('database or disk is full');
      }
    });

    const bytes = Buffer.from('磁盘容量故障下的纯虚构对象');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const objectPath = join(store.vaultDirectory, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
    expect(() => store.putSourceObject({
      bytes,
      mediaType: 'text/plain',
      displayName: `${'x'.repeat(256 * 1024)}.txt`
    })).toThrow(/database or disk is full/i);
    expect(existsSync(objectPath)).toBe(false);
    expect(store.putSourceObject({ bytes, mediaType: 'text/plain', displayName: 'retry-after-space.txt' })).toMatchObject({ duplicate: false });
    expect(existsSync(objectPath)).toBe(true);
    expect(store.integrityCheck()).toBe('ok');
    store.close();
  });

  it('从 schema v2 原位升级并保留工作区', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v2-'));
    directories.push(directory);
    createSchemaV2Database(directory);
    const store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:00:00Z') });
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(WORKSPACE_SCHEMA_VERSION);
    expect(upgraded.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'document_conversions'`).get()).toEqual({ name: 'document_conversions' });
    upgraded.close();
    expect(store.isQueuePaused()).toBe(false);
    store.setQueuePaused(true);
    expect(store.isQueuePaused()).toBe(true);
    const backupNames = readdirSync(store.schemaBackupDirectory).filter((name) => name.endsWith('.db'));
    expect(backupNames).toHaveLength(1);
    const backup = new Database(join(store.schemaBackupDirectory, backupNames[0]!), { readonly: true });
    expect(backup.pragma('user_version', { simple: true })).toBe(2);
    expect(backup.prepare('SELECT id, settings_revision FROM workspaces').get()).toEqual({ id: 'workspace-v2', settings_revision: 4 });
    backup.close();
    store.close();
  });

  it('schema v35 建立成员档案注册表、版本化派生表与可撤销纠错表', () => {
    const store = makeStore();
    const database = new Database(store.databasePath, { readonly: true });
    expect(database.pragma('user_version', { simple: true })).toBe(WORKSPACE_SCHEMA_VERSION);
    const tables = new Set((database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map((row) => row.name));
    for (const table of [
      'body_system_registry',
      'concept_definitions',
      'observation_concept_mappings',
      'system_fact_links',
      'health_events_v2',
      'report_records',
      'system_analysis_snapshots_v2',
      'member_assessment_snapshots_v3',
      'lifestyle_proposals_v2',
      'action_adoptions_v2',
      'derivation_dependencies',
      'concept_mapping_corrections',
      'event_relation_changes'
    ]) expect(tables.has(table)).toBe(true);
    expect(database.prepare(`SELECT COUNT(*) AS count FROM body_system_registry`).get()).toEqual({ count: 12 });
    expect((database.prepare(`SELECT COUNT(*) AS count FROM concept_definitions`).get() as { count: number }).count).toBeGreaterThanOrEqual(10);
    expect(database.prepare(`SELECT canonical_name FROM concept_definitions WHERE id = 'thyroid-ft4'`).get()).toEqual({ canonical_name: '游离甲状腺素' });
    expect(database.prepare(`SELECT canonical_name FROM concept_definitions WHERE id = 'thyroid-total-t4'`).get()).toEqual({ canonical_name: '总甲状腺素' });
    expect((database.pragma('table_info(lifestyle_proposals_v2)') as Array<{ name: string }>).some((column) => column.name === 'structure_json')).toBe(true);
    expect((database.pragma('table_info(action_adoptions_v2)') as Array<{ name: string }>).some((column) => column.name === 'details_json')).toBe(true);
    database.close();
    store.close();
  });

  it('升级旧观测时不把模型标准名伪装成原报告项目名', () => {
    const store = makeStore();
    const rootDirectory = store.rootDirectory;
    const person = store.createPerson({ displayName: '合成成员', relation: '本人' });
    const source = store.putSourceObject({
      bytes: Buffer.from('葡萄糖 5.2 mmol/L'), mediaType: 'text/plain', displayName: '旧观测.txt'
    });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const spanId = 'span-legacy-original-name';
    store.saveSourceManifest({
      id: 'manifest-legacy-original-name', sourceObjectId: source.id, sha256: source.sha256,
      mediaType: 'text/plain', originalDisplayName: '旧观测.txt', totalUnits: 1,
      coveredUnitIndexes: [0], normalizerVersion: 'test', conversionWarnings: [], createdAt: '2026-09-18T00:00:00.000Z',
      spans: [{ id: spanId, documentId: document.documentId, spanKind: 'line', page: null, blockId: null, lineStart: 1, lineEnd: 1, quote: '葡萄糖 5.2 mmol/L', readability: 'clear' }]
    });
    const acceptanceId = store.saveAcceptanceDecision({
      method: 'auto', actor: 'policy', rulesVersion: 'test', inputSignature: 'legacy-name-input',
      outputHash: 'legacy-name-output', reviewRef: null, decision: 'accept'
    });
    store.publishFacts({
      personId: person.id, documentId: document.documentId,
      documentCommitKey: 'c'.repeat(64), expectedRevision: 0, changeSetHash: 'd'.repeat(64), summary: '合成旧名称迁移夹具',
      observations: [{
        conceptKey: '空腹血糖', originalName: '葡萄糖', modelStandardNameCandidate: '空腹血糖',
        rawText: '5.2', valueKind: 'numeric', decimalValue: '5.2', qualifier: 'eq', unit: 'mmol/L',
        referenceRange: null, clinicalDate: '2026-09-18', abnormalFlag: 'unknown', documentId: document.documentId,
        sourceSpanId: spanId, acceptanceId, specimen: '血清', method: null, bodySite: null,
        evidence: [{ sourceSpanId: spanId, quote: '葡萄糖 5.2 mmol/L' }]
      }]
    });
    store.close();

    const legacy = new Database(join(rootDirectory, 'health.db'));
    legacy.exec(`
      UPDATE observations SET original_name = NULL, model_standard_name_candidate = NULL;
      UPDATE workspaces SET schema_version = 33;
      PRAGMA user_version = 33;
    `);
    legacy.close();

    const upgraded = new WorkspaceStore({ rootDirectory, now: () => new Date('2026-09-18T00:00:00Z') });
    expect(upgraded.listAcceptedObservations(person.id)).toEqual([
      expect.objectContaining({
        originalName: '原项目名待核实（旧记录）',
        originalNameStatus: 'legacy_missing',
        modelStandardNameCandidate: '空腹血糖',
        mapping: expect.objectContaining({ status: 'proposed' })
      })
    ]);
    const migrated = new Database(upgraded.databasePath, { readonly: true });
    expect(migrated.prepare(`SELECT original_name FROM observations`).get()).toEqual({ original_name: null });
    expect(migrated.pragma('user_version', { simple: true })).toBe(WORKSPACE_SCHEMA_VERSION);
    migrated.close();
    upgraded.close();
  });

  it('概念修正保留原始事实、使旧新系统快照同时过期，并可撤销', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '合成成员', relation: '本人' });
    const source = store.putSourceObject({ bytes: Buffer.from('LDL-C 3.8 mmol/L'), mediaType: 'text/plain', displayName: 'concept-fixture.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const spanId = 'span-concept-correction';
    store.saveSourceManifest({
      id: 'manifest-concept-correction', sourceObjectId: source.id, sha256: source.sha256,
      mediaType: 'text/plain', originalDisplayName: 'concept-fixture.txt', totalUnits: 1,
      coveredUnitIndexes: [0], normalizerVersion: 'test', conversionWarnings: [], createdAt: '2026-09-18T00:00:00.000Z',
      spans: [{ id: spanId, documentId: document.documentId, spanKind: 'line', page: null, blockId: null, lineStart: 1, lineEnd: 1, quote: 'LDL-C 3.8 mmol/L', readability: 'clear' }]
    });
    const acceptanceId = store.saveAcceptanceDecision({
      method: 'auto', actor: 'policy', rulesVersion: 'test', inputSignature: 'concept-input',
      outputHash: 'concept-output', reviewRef: null, decision: 'accept'
    });
    store.publishFacts({
      personId: person.id, documentId: document.documentId,
      documentCommitKey: 'a'.repeat(64), expectedRevision: 0, changeSetHash: 'b'.repeat(64), summary: '合成概念修正夹具',
      observations: [{
        conceptKey: 'LDL-C', rawText: '3.8', valueKind: 'numeric', decimalValue: '3.8', qualifier: 'eq',
        unit: 'mmol/L', referenceRange: '0-3.4', clinicalDate: '2026-09-18', abnormalFlag: 'high',
        documentId: document.documentId, sourceSpanId: spanId, acceptanceId, specimen: '血清', method: null, bodySite: null,
        evidence: [{ sourceSpanId: spanId, quote: 'LDL-C 3.8 mmol/L' }]
      }]
    });
    const observation = store.listAcceptedObservations(person.id)[0]!;
    expect(observation).toMatchObject({ conceptKey: 'LDL-C', mapping: { conceptId: 'loinc-like-ldl-c', status: 'verified' } });

    const database = new Database(store.databasePath);
    const insertSnapshot = database.prepare(`
      INSERT INTO system_analysis_snapshots_v2 (
        id, person_id, system_id, fact_revision, context_revision, prompt_version, rules_version,
        model_id, evidence_bundle_hash, coverage_json, payload_json, status, created_at
      ) VALUES (?, ?, ?, 1, 0, 'test', 'test', 'test', ?, '{}', '{}', 'current', '2026-09-18T00:00:00.000Z')
    `);
    for (const systemId of ['cardiovascular', 'endocrine_metabolic', 'renal_urinary', 'respiratory']) {
      insertSnapshot.run(`snapshot-${systemId}`, person.id, systemId, `${systemId}-hash`);
    }
    database.close();

    const corrected = store.setObservationConceptMapping({
      personId: person.id,
      observationId: observation.id,
      conceptId: 'renal-creatinine',
      reason: '合成测试：用户确认概念归类'
    });
    expect(corrected).toMatchObject({
      observationId: observation.id,
      mapping: { conceptId: 'renal-creatinine', canonicalName: '血清肌酐', status: 'verified' },
      canUndo: true,
      factRevision: 2
    });
    expect(new Set(corrected.invalidatedSystemIds)).toEqual(new Set(['cardiovascular', 'endocrine_metabolic', 'renal_urinary']));
    expect(store.listAcceptedObservations(person.id)[0]).toMatchObject({
      conceptKey: 'LDL-C',
      rawText: '3.8',
      mapping: { conceptId: 'renal-creatinine', canonicalName: '血清肌酐' },
      mappingCanUndo: true
    });
    const afterCorrection = new Database(store.databasePath, { readonly: true });
    expect(afterCorrection.prepare(`SELECT system_id, status FROM system_analysis_snapshots_v2 ORDER BY system_id`).all()).toEqual([
      { system_id: 'cardiovascular', status: 'stale' },
      { system_id: 'endocrine_metabolic', status: 'stale' },
      { system_id: 'renal_urinary', status: 'stale' },
      { system_id: 'respiratory', status: 'current' }
    ]);
    afterCorrection.close();

    const undone = store.undoObservationConceptMapping({ personId: person.id, observationId: observation.id });
    expect(undone).toMatchObject({ mapping: { conceptId: 'loinc-like-ldl-c' }, canUndo: false, factRevision: 3 });
    expect(store.listAcceptedObservations(person.id)[0]).toMatchObject({
      conceptKey: 'LDL-C', mapping: { conceptId: 'loinc-like-ldl-c' }, mappingCanUndo: false
    });
    const afterUndo = new Database(store.databasePath, { readonly: true });
    expect(afterUndo.prepare(`SELECT COUNT(*) AS count FROM concept_mapping_corrections WHERE observation_id = ?`).get(observation.id)).toEqual({ count: 2 });
    expect(afterUndo.prepare(`SELECT COUNT(*) AS count FROM audit_events WHERE entity_id = ? AND event_type LIKE 'concept_mapping_%'`).get(observation.id)).toEqual({ count: 2 });
    afterUndo.close();
    expect(store.integrityCheck()).toBe('ok');
    store.close();
  });

  it('同次检查的摘要和明细作为一个观测的多处来源持久保存', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '合成成员', relation: '本人' });
    const source = store.putSourceObject({
      bytes: Buffer.from('摘要 LDL-C 4.20\n明细 LDL-C 4.20 mmol/L'),
      mediaType: 'text/plain', displayName: 'duplicate-source-fixture.txt'
    });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.saveSourceManifest({
      id: 'manifest-duplicate-source', sourceObjectId: source.id, sha256: source.sha256,
      mediaType: 'text/plain', originalDisplayName: 'duplicate-source-fixture.txt', totalUnits: 2,
      coveredUnitIndexes: [0, 1], normalizerVersion: 'test', conversionWarnings: [], createdAt: '2026-09-18T00:00:00.000Z',
      spans: [
        { id: 'summary-span', documentId: document.documentId, spanKind: 'line', page: 1, blockId: 'summary', lineStart: 1, lineEnd: 1, quote: '摘要 LDL-C 4.20', readability: 'clear' },
        { id: 'detail-span', documentId: document.documentId, spanKind: 'line', page: 2, blockId: 'detail', lineStart: 2, lineEnd: 2, quote: '明细 LDL-C 4.20 mmol/L', readability: 'clear' }
      ]
    });
    const acceptanceId = store.saveAcceptanceDecision({
      method: 'auto', actor: 'policy', rulesVersion: 'test', inputSignature: 'duplicate-source-input',
      outputHash: 'duplicate-source-output', reviewRef: null, decision: 'accept'
    });
    store.publishFacts({
      personId: person.id, documentId: document.documentId,
      documentCommitKey: '8'.repeat(64), expectedRevision: 0, changeSetHash: '9'.repeat(64), summary: '重复来源夹具',
      observations: [{
        conceptKey: 'LDL-C', rawText: '4.20', valueKind: 'numeric', decimalValue: '4.20', qualifier: 'eq',
        unit: 'mmol/L', referenceRange: null, clinicalDate: '2026-09-18', abnormalFlag: 'unknown',
        documentId: document.documentId, sourceSpanId: 'detail-span', acceptanceId, specimen: '血清', method: null, bodySite: null,
        evidence: [
          { sourceSpanId: 'detail-span', quote: '明细 LDL-C 4.20 mmol/L', sourceRole: 'primary', duplicateBasis: null },
          { sourceSpanId: 'summary-span', quote: '摘要 LDL-C 4.20', sourceRole: 'duplicate_source', duplicateBasis: 'report_structure' }
        ]
      }]
    });

    const observations = store.listAcceptedObservations(person.id);
    expect(observations).toHaveLength(1);
    expect(observations[0]!.evidence).toEqual([
      expect.objectContaining({ sourceSpanId: 'detail-span', sourceRole: 'primary' }),
      expect.objectContaining({ sourceSpanId: 'summary-span', sourceRole: 'duplicate_source', duplicateBasis: 'report_structure' })
    ]);
    store.close();
  });

  it('家庭总览按成员读取有界事实窗口，同时用聚合统计保留精确总数', () => {
    const store = makeStore();
    const people = ['甲', '乙'].map((suffix) => store.createPerson({ displayName: `合成成员${suffix}`, relation: '测试成员' }));
    for (const [personIndex, person] of people.entries()) {
      const source = store.putSourceObject({
        bytes: Buffer.from(`合成容量窗口 ${personIndex}`),
        mediaType: 'text/plain',
        displayName: `window-${personIndex}.txt`
      });
      const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
      const spanId = `window-span-${personIndex}`;
      store.saveSourceManifest({
        id: `window-manifest-${personIndex}`, sourceObjectId: source.id, sha256: source.sha256,
        mediaType: 'text/plain', originalDisplayName: `window-${personIndex}.txt`, totalUnits: 1,
        coveredUnitIndexes: [0], normalizerVersion: 'test', conversionWarnings: [], createdAt: '2026-09-18T00:00:00.000Z',
        spans: [{ id: spanId, documentId: document.documentId, spanKind: 'line', page: null, blockId: null, lineStart: 1, lineEnd: 1, quote: '合成窗口证据', readability: 'clear' }]
      });
      const acceptanceId = store.saveAcceptanceDecision({
        method: 'auto', actor: 'policy', rulesVersion: 'test', inputSignature: `window-input-${personIndex}`,
        outputHash: `window-output-${personIndex}`, reviewRef: null, decision: 'accept'
      });
      store.publishFacts({
        personId: person.id, documentId: document.documentId,
        documentCommitKey: String(personIndex + 3).repeat(64), expectedRevision: 0,
        changeSetHash: String(personIndex + 5).repeat(64), summary: '合成窗口事实',
        observations: [0, 1, 2].map((index) => ({
          conceptKey: `合成指标${index}`, rawText: String(index), valueKind: 'numeric' as const,
          decimalValue: String(index), qualifier: 'eq', unit: 'unit', referenceRange: '0-1',
          clinicalDate: `2026-09-${String(10 + index).padStart(2, '0')}`,
          abnormalFlag: index === 2 ? 'high' as const : 'normal' as const,
          documentId: document.documentId, sourceSpanId: spanId, acceptanceId,
          specimen: null, method: null, bodySite: null,
          evidence: [{ sourceSpanId: spanId, quote: `合成指标${index}` }]
        }))
      });
    }

    const window = store.listAcceptedObservations(undefined, { limitPerPerson: 2 });
    expect(window).toHaveLength(4);
    for (const person of people) {
      expect(window.filter((observation) => observation.personId === person.id).map((observation) => observation.clinicalDate))
        .toEqual(['2026-09-11', '2026-09-12']);
      expect(store.listPersonObservationStats().get(person.id)).toEqual({
        acceptedFactCount: 3,
        attentionCount: 1,
        latestClinicalDate: '2026-09-12'
      });
    }
    expect(() => store.listAcceptedObservations(undefined, { limitPerPerson: 0 })).toThrow('OBSERVATION_WINDOW_LIMIT_INVALID');
    store.close();
  });

  it('报告元数据按字段保存证据，并将历史列作为独立观测而不继承当前机构', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '合成成员', relation: '本人' });
    const sourceText = '合成医院 体检中心 报告号 R-001\n检查日期 2026-09-10 报告日期 2026-09-12\nLDL-C 2024-09-01 3.1 2026-09-10 3.8';
    const source = store.putSourceObject({ bytes: Buffer.from(sourceText), mediaType: 'text/plain', displayName: 'metadata-fixture.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const spanId = 'span-report-metadata';
    store.saveSourceManifest({
      id: 'manifest-report-metadata', sourceObjectId: source.id, sha256: source.sha256,
      mediaType: 'text/plain', originalDisplayName: 'metadata-fixture.txt', totalUnits: 1,
      coveredUnitIndexes: [0], normalizerVersion: 'test', conversionWarnings: [], createdAt: '2026-09-18T00:00:00.000Z',
      spans: [{ id: spanId, documentId: document.documentId, spanKind: 'line', page: null, blockId: null, lineStart: 1, lineEnd: 3, quote: sourceText, readability: 'clear' }]
    });
    const acceptanceId = store.saveAcceptanceDecision({ method: 'auto', actor: 'policy', rulesVersion: 'test', inputSignature: 'metadata-input', outputHash: 'metadata-output', reviewRef: null, decision: 'accept' });
    const observation = (clinicalDate: string, rawText: string) => ({
      conceptKey: 'LDL-C', rawText, valueKind: 'numeric' as const, decimalValue: rawText, qualifier: 'eq',
      unit: 'mmol/L', referenceRange: '0-3.4', clinicalDate, abnormalFlag: 'unknown' as const,
      documentId: document.documentId, sourceSpanId: spanId, acceptanceId, specimen: '血清', method: null, bodySite: null,
      evidence: [{ sourceSpanId: spanId, quote: `LDL-C ${clinicalDate} ${rawText}` }]
    });
    store.publishFacts({
      personId: person.id, documentId: document.documentId,
      documentCommitKey: 'c'.repeat(64), expectedRevision: 0, changeSetHash: 'd'.repeat(64), summary: '历史列与报告元数据夹具',
      reportMetadata: {
        reportKind: { value: '年度体检报告', evidence: [{ sourceSpanId: spanId, quote: '体检中心' }] },
        title: { value: '合成年度体检', evidence: [{ sourceSpanId: spanId, quote: '合成医院 体检中心' }] },
        organization: { value: '合成医院', evidence: [{ sourceSpanId: spanId, quote: '合成医院' }] },
        campus: null,
        department: { value: '体检中心', evidence: [{ sourceSpanId: spanId, quote: '体检中心' }] },
        reportNumber: { value: 'R-001', evidence: [{ sourceSpanId: spanId, quote: '报告号 R-001' }] },
        encounterIdentifier: { value: 'E-001', evidence: [{ sourceSpanId: spanId, quote: '报告号 R-001' }] },
        sampleIdentifiers: [],
        examItems: [{ value: '血脂', evidence: [{ sourceSpanId: spanId, quote: 'LDL-C' }] }],
        times: [
          { value: '2026-09-10', precision: 'day', role: 'examined', evidence: [{ sourceSpanId: spanId, quote: '检查日期 2026-09-10' }] },
          { value: '2026-09-12', precision: 'day', role: 'report_issued', evidence: [{ sourceSpanId: spanId, quote: '报告日期 2026-09-12' }] },
          { value: '2024-09-01', precision: 'day', role: 'history_quoted', evidence: [{ sourceSpanId: spanId, quote: '2024-09-01 3.1' }] },
          { value: '2023', precision: 'year', role: 'history_quoted', evidence: [{ sourceSpanId: spanId, quote: 'LDL-C' }] }
        ]
      },
      observations: [observation('2024-09-01', '3.1'), observation('2026-09-10', '3.8')]
    });

    expect(store.listAcceptedObservations(person.id).map((item) => item.clinicalDate)).toEqual(['2024-09-01', '2026-09-10']);
    const metadata = store.listReportMetadata(person.id)[0]!;
    expect(metadata).toMatchObject({
      title: '合成年度体检', reportKind: '年度体检报告', organization: '合成医院', reportDate: '2026-09-12',
      extracted: { department: { value: '体检中心' }, reportNumber: { value: 'R-001' } }
    });
    expect(metadata.extracted?.times).toContainEqual(expect.objectContaining({ value: '2023', precision: 'year', role: 'history_quoted' }));
    const database = new Database(store.databasePath, { readonly: true });
    expect(database.prepare(`SELECT clinical_date, end_date FROM health_events_v2`).get()).toEqual({ clinical_date: '2026-09-10', end_date: null });
    const payload = JSON.parse(String((database.prepare(`SELECT payload_json FROM report_metadata_revisions`).get() as { payload_json: string }).payload_json)) as { extracted: { times: Array<{ value: string; role: string }> } };
    expect(payload.extracted.times).toContainEqual(expect.objectContaining({ value: '2024-09-01', role: 'history_quoted' }));
    database.close();

    const snapshots = new Database(store.databasePath);
    const insertSnapshot = snapshots.prepare(`
      INSERT INTO system_analysis_snapshots_v2 (
        id, person_id, system_id, fact_revision, context_revision, prompt_version, rules_version,
        model_id, evidence_bundle_hash, coverage_json, payload_json, status, created_at
      ) VALUES (?, ?, ?, 1, 0, 'test', 'test', 'test', ?, '{}', '{}', 'current', '2026-09-18T00:00:00.000Z')
    `);
    for (const systemId of ['cardiovascular', 'endocrine_metabolic', 'respiratory']) {
      insertSnapshot.run(`metadata-snapshot-${systemId}`, person.id, systemId, `metadata-${systemId}`);
    }
    snapshots.close();

    const corrected = store.updateReportMetadata({
      personId: person.id,
      reportId: metadata.reportId,
      expectedRevision: 1,
      title: '本人确认的年度体检',
      organization: '合成医院新院区',
      department: '健康管理科',
      clinicalTime: { value: '2026-09', precision: 'month' },
      reason: '合成测试：核对原报告'
    });
    expect(corrected).toMatchObject({ metadataRevision: 2, factRevision: 2, canUndo: true });
    expect(store.listReportMetadata(person.id)[0]).toMatchObject({
      title: '本人确认的年度体检', organization: '合成医院新院区', department: '健康管理科',
      clinicalTime: { value: '2026-09', precision: 'month' }, metadataStatus: 'corrected', metadataRevision: 2, canUndo: true
    });
    const correctedSnapshots = new Database(store.databasePath, { readonly: true });
    expect(correctedSnapshots.prepare(`SELECT system_id, status FROM system_analysis_snapshots_v2 ORDER BY system_id`).all()).toEqual([
      { system_id: 'cardiovascular', status: 'stale' },
      { system_id: 'endocrine_metabolic', status: 'stale' },
      { system_id: 'respiratory', status: 'current' }
    ]);
    correctedSnapshots.close();
    expect(() => store.updateReportMetadata({
      personId: person.id, reportId: metadata.reportId, expectedRevision: 1,
      title: '迟到修正', organization: null, department: null,
      clinicalTime: { value: null, precision: 'unknown' }, reason: '迟到写入'
    })).toThrow(RevisionConflictError);

    const undone = store.undoReportMetadata({ personId: person.id, reportId: metadata.reportId, expectedRevision: 2 });
    expect(undone).toMatchObject({ metadataRevision: 3, factRevision: 3, canUndo: false });
    expect(store.listReportMetadata(person.id)[0]).toMatchObject({
      title: '合成年度体检', organization: '合成医院', department: '体检中心',
      clinicalTime: { value: '2026-09-10', precision: 'day' }, metadataStatus: 'inferred', metadataRevision: 3, canUndo: false
    });
    const audit = new Database(store.databasePath, { readonly: true });
    expect(audit.prepare(`SELECT COUNT(*) AS count FROM audit_events WHERE entity_id = ? AND event_type LIKE 'report_metadata_%'`).get(metadata.reportId)).toEqual({ count: 2 });
    expect(audit.prepare(`SELECT COUNT(*) AS count FROM report_metadata_revisions WHERE report_id = ?`).get(metadata.reportId)).toEqual({ count: 3 });
    audit.close();

    const publishRelatedReport = (identifier: string, suffix: string, expectedRevision: number) => {
      const relatedText = `合成医院 检查日期 2026-09-10 检查单号 ${identifier} HDL-C 1.2`;
      const relatedSource = store.putSourceObject({ bytes: Buffer.from(relatedText), mediaType: 'text/plain', displayName: `related-${suffix}.txt` });
      const relatedDocument = store.registerImportedDocument({ sourceObjectId: relatedSource.id, personId: person.id });
      const relatedSpan = `span-related-${suffix}`;
      store.saveSourceManifest({
        id: `manifest-related-${suffix}`, sourceObjectId: relatedSource.id, sha256: relatedSource.sha256,
        mediaType: 'text/plain', originalDisplayName: `related-${suffix}.txt`, totalUnits: 1,
        coveredUnitIndexes: [0], normalizerVersion: 'test', conversionWarnings: [], createdAt: '2026-09-18T00:00:00.000Z',
        spans: [{ id: relatedSpan, documentId: relatedDocument.documentId, spanKind: 'line', page: null, blockId: null, lineStart: 1, lineEnd: 1, quote: relatedText, readability: 'clear' }]
      });
      const relatedAcceptance = store.saveAcceptanceDecision({ method: 'auto', actor: 'policy', rulesVersion: 'test', inputSignature: `related-${suffix}`, outputHash: `related-output-${suffix}`, reviewRef: null, decision: 'accept' });
      store.publishFacts({
        personId: person.id, documentId: relatedDocument.documentId,
        documentCommitKey: suffix.repeat(64).slice(0, 64), expectedRevision, changeSetHash: `${suffix}a`.repeat(64).slice(0, 64), summary: '关联报告',
        reportMetadata: {
          reportKind: null, title: { value: '合成检验明细', evidence: [{ sourceSpanId: relatedSpan, quote: relatedText }] },
          organization: { value: '合成医院', evidence: [{ sourceSpanId: relatedSpan, quote: '合成医院' }] },
          campus: null, department: null, reportNumber: null,
          encounterIdentifier: { value: identifier, evidence: [{ sourceSpanId: relatedSpan, quote: `检查单号 ${identifier}` }] }, sampleIdentifiers: [], examItems: [],
          times: [{ value: '2026-09-10', precision: 'day', role: 'examined', evidence: [{ sourceSpanId: relatedSpan, quote: '检查日期 2026-09-10' }] }]
        },
        observations: [{
          conceptKey: 'HDL-C', rawText: '1.2', valueKind: 'numeric', decimalValue: '1.2', qualifier: 'eq', unit: 'mmol/L',
          referenceRange: null, clinicalDate: '2026-09-10', abnormalFlag: 'unknown', documentId: relatedDocument.documentId,
          sourceSpanId: relatedSpan, acceptanceId: relatedAcceptance, specimen: '血清', method: null, bodySite: null,
          evidence: [{ sourceSpanId: relatedSpan, quote: 'HDL-C 1.2' }]
        }]
      });
    };
    publishRelatedReport('E-001', 'e', 3);
    publishRelatedReport('E-OTHER', 'f', 4);
    const groupedReports = store.listReportMetadata(person.id);
    const sameBatchEvents = new Set(groupedReports
      .filter((item) => item.extracted?.encounterIdentifier?.value === 'E-001')
      .map((item) => item.eventId));
    const otherBatchEvent = groupedReports.find((item) => item.extracted?.encounterIdentifier?.value === 'E-OTHER')!.eventId;
    expect(sameBatchEvents.size).toBe(1);
    expect(sameBatchEvents.has(otherBatchEvent)).toBe(false);
    const sameBatchEvent = [...sameBatchEvents][0]!;
    const groupedDatabase = new Database(store.databasePath, { readonly: true });
    expect(groupedDatabase.prepare(`SELECT COUNT(*) AS count FROM health_events_v2`).get()).toEqual({ count: 2 });
    groupedDatabase.close();

    const merged = store.mergeHealthEvents({
      personId: person.id,
      targetEventId: sameBatchEvent,
      sourceEventId: otherBatchEvent,
      reason: '合成测试：本人确认属于同一次检查'
    });
    expect(merged).toMatchObject({ factRevision: 6, canUndo: true, eventIds: [sameBatchEvent, otherBatchEvent] });
    expect(new Set(store.listReportMetadata(person.id).map((item) => item.eventId))).toEqual(new Set([sameBatchEvent]));
    expect(store.getLatestActiveEventRelationChange(person.id, sameBatchEvent)).toMatchObject({ id: merged.changeId, action: 'merge' });

    const mergeUndo = store.undoHealthEventRelation({ personId: person.id, changeId: merged.changeId });
    expect(mergeUndo).toMatchObject({ factRevision: 7, canUndo: false });
    expect(new Set(store.listReportMetadata(person.id).map((item) => item.eventId))).toEqual(new Set([sameBatchEvent, otherBatchEvent]));
    expect(store.getLatestActiveEventRelationChange(person.id, sameBatchEvent)).toBeNull();

    const reportToSplit = groupedReports.find((item) => item.extracted?.encounterIdentifier?.value === 'E-001' && item.reportId !== metadata.reportId)!;
    const split = store.splitHealthEvent({
      personId: person.id,
      eventId: sameBatchEvent,
      reportId: reportToSplit.reportId,
      reason: '合成测试：本人确认不是同一次检查'
    });
    expect(split).toMatchObject({ factRevision: 8, canUndo: true, reportIds: [reportToSplit.reportId] });
    expect(new Set(store.listReportMetadata(person.id)
      .filter((item) => item.extracted?.encounterIdentifier?.value === 'E-001')
      .map((item) => item.eventId)).size).toBe(2);
    expect(store.getLatestActiveEventRelationChange(person.id, sameBatchEvent)).toMatchObject({ id: split.changeId, action: 'split' });

    const splitUndo = store.undoHealthEventRelation({ personId: person.id, changeId: split.changeId });
    expect(splitUndo).toMatchObject({ factRevision: 9, canUndo: false });
    expect(new Set(store.listReportMetadata(person.id)
      .filter((item) => item.extracted?.encounterIdentifier?.value === 'E-001')
      .map((item) => item.eventId))).toEqual(new Set([sameBatchEvent]));
    expect(store.getLatestActiveEventRelationChange(person.id, sameBatchEvent)).toBeNull();

    const relationAudit = new Database(store.databasePath, { readonly: true });
    expect(relationAudit.prepare(`SELECT COUNT(*) AS count FROM event_relation_changes`).get()).toEqual({ count: 4 });
    expect(relationAudit.prepare(`SELECT COUNT(*) AS count FROM audit_events WHERE event_type LIKE 'health_event%'`).get()).toEqual({ count: 4 });
    relationAudit.close();

    const splitBeforeDelete = store.splitHealthEvent({
      personId: person.id,
      eventId: sameBatchEvent,
      reportId: reportToSplit.reportId,
      reason: '合成测试：拆分后删除来源报告'
    });
    expect(splitBeforeDelete.canUndo).toBe(true);
    expect(() => store.deleteDocument({ documentId: reportToSplit.documentId, retainedByRecoveryPoint: true })).not.toThrow();
    expect(store.getLatestActiveEventRelationChange(person.id, sameBatchEvent)).toBeNull();
    expect(store.listReportMetadata(person.id).some((item) => item.reportId === reportToSplit.reportId)).toBe(false);
    expect(store.integrityCheck()).toBe('ok');
    store.close();
  });

  it('schema 多步升级失败时整体回滚并保留升级前一致性备份', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-migration-failure-'));
    directories.push(directory);
    createSchemaV2Database(directory);

    expect(() => new WorkspaceStore({
      rootDirectory: directory,
      now: () => new Date('2026-09-18T00:00:00Z'),
      failureInjector: (point) => {
        if (point === 'during_schema_migration') throw new Error('simulated migration failure');
      }
    })).toThrow('simulated migration failure');

    const database = new Database(join(directory, 'health.db'), { readonly: true });
    expect(database.pragma('user_version', { simple: true })).toBe(2);
    expect(database.prepare('SELECT id, schema_version, settings_revision FROM workspaces').get()).toEqual({
      id: 'workspace-v2',
      schema_version: 2,
      settings_revision: 4
    });
    const columns = database.pragma('table_info(workspaces)') as Array<{ name: string }>;
    expect(columns.some((column) => column.name === 'queue_paused')).toBe(false);
    database.close();

    const backupDirectory = join(directory, 'recovery-points');
    const backupNames = readdirSync(backupDirectory).filter((name) => name.endsWith('.db'));
    expect(backupNames).toHaveLength(1);
    const backup = new Database(join(backupDirectory, backupNames[0]!), { readonly: true });
    expect(backup.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(backup.pragma('user_version', { simple: true })).toBe(2);
    backup.close();
  });

  it('旧版应用打开更高 schema 时在任何写入前拒绝', () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-newer-schema-'));
    directories.push(directory);
    const databasePath = join(directory, 'health.db');
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE downgrade_canary (value TEXT NOT NULL) STRICT;
      INSERT INTO downgrade_canary (value) VALUES ('must remain byte-for-byte unchanged');
      PRAGMA user_version = 99;
    `);
    database.close();
    const before = readFileSync(databasePath);

    expect(() => new WorkspaceStore({ rootDirectory: directory })).toThrow('WORKSPACE_SCHEMA_NEWER_THAN_APP');
    expect(readFileSync(databasePath)).toEqual(before);
    expect(existsSync(join(directory, 'vault'))).toBe(false);
    expect(existsSync(join(directory, 'recovery-points'))).toBe(false);
  });

  it('同一字节只保存一个对象，同时保留不可变内容', () => {
    const store = makeStore();
    const bytes = Buffer.from('完全虚构的健康报告');
    const first = store.putSourceObject({ bytes, mediaType: 'text/plain', displayName: 'a.txt' });
    const second = store.putSourceObject({ bytes, mediaType: 'text/plain', displayName: 'renamed.txt' });
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.id).toBe(first.id);
    expect(readFileSync(join(store.vaultDirectory, first.vaultRelativePath))).toEqual(bytes);
    store.close();
  });

  it('完整保存 SourceManifest 的覆盖缺口与转换警告', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员' });
    const source = store.putSourceObject({ bytes: Buffer.from('覆盖缺口'), mediaType: 'text/plain', displayName: '缺口.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.saveSourceManifest({
      id: 'manifest-gap', sourceObjectId: source.id, sha256: source.sha256, mediaType: 'text/plain',
      originalDisplayName: '缺口.txt', totalUnits: 3, coveredUnitIndexes: [0, 2],
      spans: [
        { id: 'gap-0', documentId: document.documentId, spanKind: 'line', page: null, blockId: null, lineStart: 1, lineEnd: 1, quote: '第一段', readability: 'clear' },
        { id: 'gap-2', documentId: document.documentId, spanKind: 'line', page: null, blockId: null, lineStart: 3, lineEnd: 3, quote: '第三段', readability: 'partial' }
      ],
      normalizerVersion: 'manifest-test-v1', conversionWarnings: ['synthetic_conversion_warning'],
      createdAt: '2026-09-18T00:00:00.000Z'
    });
    expect(store.getDocumentExtractionBundle(document.documentId).manifest).toMatchObject({
      id: 'manifest-gap', totalUnits: 3, coveredUnitIndexes: [0, 2],
      normalizerVersion: 'manifest-test-v1', conversionWarnings: expect.arrayContaining(['synthetic_conversion_warning'])
    });
    store.close();
  });

  it('schema v8 将旧身份冲突升级为可确认关系，并在确认后保留报告姓名', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v7-identity-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:00:00Z') });
    const person = store.createPerson({ displayName: '书书', relation: '本人' });
    const source = store.putSourceObject({ bytes: Buffer.from('姓 名 ： 测试姓名甲 性 别 ： 男'), mediaType: 'text/plain', displayName: '体检报告.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.saveSourceManifest({
      id: 'manifest-identity', sourceObjectId: source.id, sha256: source.sha256, mediaType: 'text/plain',
      originalDisplayName: '体检报告.txt', totalUnits: 1, coveredUnitIndexes: [0],
      spans: [{ id: 'identity-span', documentId: document.documentId, spanKind: 'line', page: 1, blockId: null, lineStart: 1, lineEnd: 1, quote: '姓 名 ： 测试姓名甲 性 别 ： 男', readability: 'clear' }],
      normalizerVersion: 'manifest-test-v1', conversionWarnings: [], createdAt: '2026-09-18T00:00:00.000Z'
    });
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId, kind: 'field_conflict', severity: 'blocking', evidenceRefs: ['identity-span']
    });
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`UPDATE workspaces SET schema_version = 7; PRAGMA user_version = 7;`);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:01:00Z') });
    expect(store.listOpenExtractionReviewIssues()).toEqual([
      expect.objectContaining({ id: issueId, kind: 'person_conflict', reportedName: '测试姓名甲' })
    ]);
    store.confirmDocumentIdentity({ issueId, documentId: document.documentId, personId: person.id });
    expect(store.getDocumentExtractionBundle(document.documentId)).toMatchObject({
      personAssignmentBasis: 'identity_confirmed', confirmedReportedName: '测试姓名甲'
    });
    expect(store.listOpenExtractionReviewIssues()).toEqual([]);
    expect(store.listReadyDocuments()).toEqual([{ id: document.documentId, personId: person.id }]);
    store.close();
  });

  it('身份冲突可原子改归其他成员，旧批次只重建剩余资料且不复用授权', () => {
    const store = makeStore();
    const originalPerson = store.createPerson({ displayName: '原成员', relation: '本人' });
    const targetPerson = store.createPerson({ displayName: '目标成员', relation: '家人' });
    const remainingSource = store.putSourceObject({
      bytes: Buffer.from('纯合成已完成资料'), mediaType: 'text/plain', displayName: '已完成.txt'
    });
    const conflictSource = store.putSourceObject({
      bytes: Buffer.from('姓名：目标成员'), mediaType: 'text/plain', displayName: '待改归.txt'
    });
    const remainingDocument = store.registerImportedDocument({
      sourceObjectId: remainingSource.id, personId: originalPerson.id
    });
    const conflictDocument = store.registerImportedDocument({
      sourceObjectId: conflictSource.id, personId: originalPerson.id
    });
    store.setDocumentStatus(remainingDocument.documentId, 'completed');
    const accountFingerprint = 'identity-reassign-account';
    const consentId = store.createManualProcessingConsent({
      documentIds: [remainingDocument.documentId, conflictDocument.documentId],
      personIds: [originalPerson.id], accountFingerprint, version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z', initialStatus: 'queued', consentId,
      groups: [{
        personId: originalPerson.id,
        documentIds: [remainingDocument.documentId, conflictDocument.documentId],
        inputSignature: 'identity-reassign-job'
      }]
    });
    const job = store.claimNextQueuedJob('identity-runner', accountFingerprint)!;
    const attemptId = store.startJobAttempt(job.id, 'synthetic-runtime');
    store.saveExtractionChunkCheckpoint({
      guard: { jobId: job.id, attemptId, consentId, accountFingerprint },
      documentId: conflictDocument.documentId, signature: '9'.repeat(64), chunkIndex: 0,
      output: { synthetic: 'OLD_CONSENT_CHUNK_MUST_BE_REMOVED' },
      threadId: 'identity-thread', turnId: 'identity-turn', extractionTurnId: 'identity-turn'
    });
    const issueId = store.saveExtractionReviewIssue({
      documentId: conflictDocument.documentId, jobId: job.id,
      kind: 'person_conflict', severity: 'blocking', evidenceRefs: [],
      reportedName: '目标成员', reasonCodes: ['PERSON_NAME_CONFLICT']
    });
    store.updateJobStage(job.id, 'analyze');
    store.finishJobAttempt({ attemptId, status: 'waiting_user' });
    store.finishJob(job.id, 'waiting_user');

    store.publishMemberAssessmentSnapshot({
      snapshot: syntheticAssessmentSnapshot(store, originalPerson.id, 'old-person-before-reassign')
    });
    store.publishMemberAssessmentSnapshot({
      snapshot: syntheticAssessmentSnapshot(store, targetPerson.id, 'target-person-before-reassign')
    });

    store.reassignDocumentPerson({
      issueId, documentId: conflictDocument.documentId, personId: targetPerson.id
    });

    expect(store.listImportedDocuments()).toContainEqual(expect.objectContaining({
      id: conflictDocument.documentId, personId: targetPerson.id, status: 'queued'
    }));
    expect(store.listOpenExtractionReviewIssues()).toEqual([]);
    expect(store.listMemberAssessmentSnapshots(originalPerson.id, true)).toEqual([]);
    expect(store.listMemberAssessmentSnapshots(targetPerson.id, true)).toEqual([]);
    expect(store.listReadyDocuments()).toContainEqual({
      id: conflictDocument.documentId, personId: targetPerson.id
    });
    expect(store.listProcessingDocumentIds().has(conflictDocument.documentId)).toBe(false);

    const database = new Database(store.databasePath, { readonly: true });
    expect(database.prepare(`
      SELECT person_id, person_assignment_basis, confirmed_reported_name
      FROM documents WHERE id = ?
    `).get(conflictDocument.documentId)).toEqual({
      person_id: targetPerson.id,
      person_assignment_basis: 'identity_confirmed',
      confirmed_reported_name: '目标成员'
    });
    const checkpoint = database.prepare(`SELECT checkpoint_json FROM jobs WHERE id = ?`).get(job.id) as { checkpoint_json: string };
    expect(JSON.parse(checkpoint.checkpoint_json)).toMatchObject({
      documentIds: [remainingDocument.documentId], completedUnits: 1
    });
    expect(checkpoint.checkpoint_json).not.toContain(conflictDocument.documentId);
    expect(checkpoint.checkpoint_json).not.toContain('OLD_CONSENT_CHUNK_MUST_BE_REMOVED');
    expect(database.prepare(`SELECT event_type FROM audit_events WHERE entity_id = ?`).get(issueId)).toEqual({
      event_type: 'review_issue.identity_reassigned'
    });
    database.close();
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'queued', stage: 'analyze', completedUnits: 1, totalUnits: 1 });
    expect(store.claimNextQueuedJob('identity-resume', accountFingerprint)).toMatchObject({
      id: job.id, personId: originalPerson.id, documentIds: [remainingDocument.documentId], consentId, stage: 'analyze'
    });
    const unauthorizedTargetBatch = store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:01:00Z', initialStatus: 'queued', consentId,
      groups: [{
        personId: targetPerson.id,
        documentIds: [conflictDocument.documentId],
        inputSignature: 'target-must-reauthorize'
      }]
    });
    expect(store.claimNextQueuedJob('identity-old-consent-target', accountFingerprint)).toBeNull();
    const authorizationDatabase = new Database(store.databasePath, { readonly: true });
    expect(authorizationDatabase.prepare(`SELECT status FROM jobs WHERE id = ?`)
      .get(unauthorizedTargetBatch.jobIds[0])).toEqual({ status: 'waiting_user' });
    authorizationDatabase.close();

    // 同一原文后续从旧成员目录扫描时，人工确认的归属不得被覆盖或重建冲突。
    expect(store.registerImportedDocument({
      sourceObjectId: conflictSource.id, personId: originalPerson.id, assignmentBasis: 'folder_binding'
    })).toEqual({ documentId: conflictDocument.documentId, status: 'duplicate', duplicate: true });
    store.close();
  });

  it('运行中批次和非阻断事项都不得改归', () => {
    const store = makeStore();
    const originalPerson = store.createPerson({ displayName: '原成员' });
    const targetPerson = store.createPerson({ displayName: '目标成员' });
    const source = store.putSourceObject({
      bytes: Buffer.from('纯合成身份冲突'), mediaType: 'text/plain', displayName: '冲突.txt'
    });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: originalPerson.id });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [originalPerson.id],
      accountFingerprint: 'identity-running-account', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z', initialStatus: 'queued', consentId,
      groups: [{ personId: originalPerson.id, documentIds: [document.documentId], inputSignature: 'identity-running-job' }]
    });
    const job = store.claimNextQueuedJob('identity-running', 'identity-running-account')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId, jobId: job.id,
      kind: 'person_conflict', severity: 'blocking', evidenceRefs: [], reportedName: '目标成员'
    });
    expect(() => store.reassignDocumentPerson({
      issueId, documentId: document.documentId, personId: targetPerson.id
    })).toThrow('DOCUMENT_HAS_RUNNING_JOB');
    expect(store.listImportedDocuments()).toContainEqual(expect.objectContaining({
      id: document.documentId, personId: originalPerson.id, status: 'needs_review'
    }));
    expect(store.listOpenExtractionReviewIssues()).toHaveLength(1);

    store.finishJob(job.id, 'cancelled');
    store.resolveReviewIssue({ issueId, documentId: document.documentId, action: 'archive_only' });
    const warningIssue = store.saveExtractionReviewIssue({
      documentId: document.documentId, kind: 'person_conflict', severity: 'warning',
      evidenceRefs: [], reportedName: '目标成员'
    });
    expect(() => store.reassignDocumentPerson({
      issueId: warningIssue, documentId: document.documentId, personId: targetPerson.id
    })).toThrow('REVIEW_ISSUE_NOT_OPEN');
    store.close();
  });

  it('旧成员授权不能领取已改归文档的旧成员任务', () => {
    const store = makeStore();
    const originalPerson = store.createPerson({ displayName: '原成员' });
    const targetPerson = store.createPerson({ displayName: '目标成员' });
    const source = store.putSourceObject({
      bytes: Buffer.from('姓名：目标成员'), mediaType: 'text/plain', displayName: '待改归.txt'
    });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: originalPerson.id });
    const oldConsentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [originalPerson.id],
      accountFingerprint: 'old-person-account', version: 1
    });
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId, kind: 'person_conflict', severity: 'blocking',
      evidenceRefs: [], reportedName: '目标成员'
    });
    store.reassignDocumentPerson({
      issueId, documentId: document.documentId, personId: targetPerson.id
    });

    const staleBatch = store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z', initialStatus: 'queued', consentId: oldConsentId,
      groups: [{
        personId: originalPerson.id,
        documentIds: [document.documentId],
        inputSignature: 'stale-old-person-job'
      }]
    });

    expect(store.claimNextQueuedJob('stale-old-person-runner', 'old-person-account')).toBeNull();
    expect(store.listStoredJobs()).toContainEqual(expect.objectContaining({
      id: staleBatch.jobIds[0], status: 'waiting_user'
    }));
    expect(store.listReadyDocuments()).toContainEqual({
      id: document.documentId, personId: targetPerson.id
    });
    store.close();
  });

  it('改归资料会清理可重试的部分完成任务，重试只带剩余资料', () => {
    const store = makeStore();
    const originalPerson = store.createPerson({ displayName: '原成员' });
    const targetPerson = store.createPerson({ displayName: '目标成员' });
    const remainingSource = store.putSourceObject({
      bytes: Buffer.from('保留资料'), mediaType: 'text/plain', displayName: '保留.txt'
    });
    const conflictSource = store.putSourceObject({
      bytes: Buffer.from('姓名：目标成员'), mediaType: 'text/plain', displayName: '冲突.txt'
    });
    const remainingDocument = store.registerImportedDocument({
      sourceObjectId: remainingSource.id, personId: originalPerson.id
    });
    const conflictDocument = store.registerImportedDocument({
      sourceObjectId: conflictSource.id, personId: originalPerson.id
    });
    store.setDocumentStatus(remainingDocument.documentId, 'completed');
    const accountFingerprint = 'reassign-completed-issues-account';
    const consentId = store.createManualProcessingConsent({
      documentIds: [remainingDocument.documentId, conflictDocument.documentId],
      personIds: [originalPerson.id], accountFingerprint, version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z', initialStatus: 'queued', consentId,
      groups: [{
        personId: originalPerson.id,
        documentIds: [remainingDocument.documentId, conflictDocument.documentId],
        inputSignature: 'reassign-completed-issues-job'
      }]
    });
    const job = store.claimNextQueuedJob('reassign-completed-issues-runner', accountFingerprint)!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: conflictDocument.documentId, jobId: job.id,
      kind: 'person_conflict', severity: 'blocking', evidenceRefs: [], reportedName: '目标成员'
    });
    store.updateJobProgress(job.id, 2);
    store.finishJob(job.id, 'completed_with_issues');

    const legacyDatabase = new Database(store.databasePath);
    const legacyRow = legacyDatabase.prepare(`SELECT checkpoint_json FROM jobs WHERE id = ?`)
      .get(job.id) as { checkpoint_json: string };
    const legacyCheckpoint = JSON.parse(legacyRow.checkpoint_json) as Record<string, unknown>;
    legacyDatabase.prepare(`UPDATE jobs SET checkpoint_json = ? WHERE id = ?`).run(JSON.stringify({
      ...legacyCheckpoint,
      extractionChunks: {
        [conflictDocument.documentId]: { stale: { output: 'MUST_BE_REMOVED' } }
      },
      systemOutcomes: [{ systemId: 'cardiovascular', status: 'held' }]
    }), job.id);
    legacyDatabase.close();

    store.reassignDocumentPerson({
      issueId, documentId: conflictDocument.documentId, personId: targetPerson.id
    });

    const cleanedDatabase = new Database(store.databasePath, { readonly: true });
    const cleanedRow = cleanedDatabase.prepare(`SELECT status, checkpoint_json FROM jobs WHERE id = ?`)
      .get(job.id) as { status: string; checkpoint_json: string };
    cleanedDatabase.close();
    expect(cleanedRow.status).toBe('completed_with_issues');
    expect(JSON.parse(cleanedRow.checkpoint_json)).toMatchObject({
      documentIds: [remainingDocument.documentId], completedUnits: 1
    });
    expect(cleanedRow.checkpoint_json).not.toContain(conflictDocument.documentId);
    expect(cleanedRow.checkpoint_json).not.toContain('MUST_BE_REMOVED');
    expect(cleanedRow.checkpoint_json).not.toContain('systemOutcomes');

    store.retryFailedJob(job.id);
    expect(store.claimNextQueuedJob('reassign-retry', accountFingerprint)).toMatchObject({
      id: job.id,
      stage: 'system_analysis',
      documentIds: [remainingDocument.documentId]
    });
    store.close();
  });

  it('已提交资料、已有观测和已归档目标成员都不得改归，失败时不改文档或事项', () => {
    const store = makeStore();
    const originalPerson = store.createPerson({ displayName: '原成员' });
    const targetPerson = store.createPerson({ displayName: '目标成员' });
    const archivedTarget = store.createPerson({ displayName: '已归档目标' });

    const committedSource = store.putSourceObject({
      bytes: Buffer.from('纯合成已提交资料'), mediaType: 'text/plain', displayName: '已提交.txt'
    });
    const committedDocument = store.registerImportedDocument({
      sourceObjectId: committedSource.id, personId: originalPerson.id
    });
    store.publishFacts({
      personId: originalPerson.id,
      documentId: committedDocument.documentId,
      documentCommitKey: '7'.repeat(64), expectedRevision: 0,
      changeSetHash: '8'.repeat(64), summary: '合成已提交资料', observations: []
    });
    const committedIssue = store.saveExtractionReviewIssue({
      documentId: committedDocument.documentId,
      kind: 'person_conflict', severity: 'blocking', evidenceRefs: [], reportedName: '目标成员'
    });
    expect(() => store.reassignDocumentPerson({
      issueId: committedIssue, documentId: committedDocument.documentId, personId: targetPerson.id
    })).toThrow('DOCUMENT_ALREADY_COMMITTED');

    const observationSource = store.putSourceObject({
      bytes: Buffer.from('纯合成已有观测资料'), mediaType: 'text/plain', displayName: '已有观测.txt'
    });
    const observationDocument = store.registerImportedDocument({
      sourceObjectId: observationSource.id, personId: originalPerson.id
    });
    store.saveSourceManifest({
      id: 'identity-observation-manifest', sourceObjectId: observationSource.id,
      sha256: observationSource.sha256, mediaType: 'text/plain', originalDisplayName: '已有观测.txt',
      totalUnits: 1, coveredUnitIndexes: [0], normalizerVersion: 'test', conversionWarnings: [],
      createdAt: '2026-09-18T00:00:00.000Z',
      spans: [{
        id: 'identity-observation-span', documentId: observationDocument.documentId,
        spanKind: 'line', page: null, blockId: null, lineStart: 1, lineEnd: 1,
        quote: '收缩压 107 mmHg', readability: 'clear'
      }]
    });
    const acceptanceId = store.saveAcceptanceDecision({
      method: 'auto', actor: 'policy', rulesVersion: 'test', inputSignature: 'identity-observation-input',
      outputHash: 'identity-observation-output', reviewRef: null, decision: 'accept'
    });
    store.publishFacts({
      personId: originalPerson.id, documentId: observationDocument.documentId,
      documentCommitKey: '9'.repeat(64), expectedRevision: store.getFactRevision(originalPerson.id),
      changeSetHash: 'a'.repeat(64), summary: '合成观测',
      observations: [{
        conceptKey: '收缩压', rawText: '107', valueKind: 'numeric', decimalValue: '107',
        qualifier: 'eq', unit: 'mmHg', referenceRange: null, clinicalDate: '2026-09-18',
        abnormalFlag: 'unknown', documentId: observationDocument.documentId,
        sourceSpanId: 'identity-observation-span', acceptanceId,
        specimen: null, method: null, bodySite: null,
        evidence: [{ sourceSpanId: 'identity-observation-span', quote: '收缩压 107 mmHg' }]
      }]
    });
    const observationDatabase = new Database(store.databasePath);
    observationDatabase.prepare(`DELETE FROM document_commits WHERE document_id = ?`).run(observationDocument.documentId);
    observationDatabase.close();
    const observationIssue = store.saveExtractionReviewIssue({
      documentId: observationDocument.documentId,
      kind: 'person_conflict', severity: 'blocking', evidenceRefs: [], reportedName: '目标成员'
    });
    expect(() => store.reassignDocumentPerson({
      issueId: observationIssue, documentId: observationDocument.documentId, personId: targetPerson.id
    })).toThrow('DOCUMENT_HAS_OBSERVATIONS');

    const archivedSource = store.putSourceObject({
      bytes: Buffer.from('纯合成待改归资料'), mediaType: 'text/plain', displayName: '待改归.txt'
    });
    const archivedDocument = store.registerImportedDocument({
      sourceObjectId: archivedSource.id, personId: originalPerson.id
    });
    const archivedIssue = store.saveExtractionReviewIssue({
      documentId: archivedDocument.documentId,
      kind: 'person_conflict', severity: 'blocking', evidenceRefs: [], reportedName: '已归档目标'
    });
    store.archivePerson({ personId: archivedTarget.id, expectedDisplayRevision: archivedTarget.displayRevision });
    expect(() => store.reassignDocumentPerson({
      issueId: archivedIssue, documentId: archivedDocument.documentId, personId: archivedTarget.id
    })).toThrow('PERSON_NOT_FOUND');

    expect(store.listImportedDocuments()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: committedDocument.documentId, personId: originalPerson.id, status: 'needs_review'
      }),
      expect.objectContaining({
        id: archivedDocument.documentId, personId: originalPerson.id, status: 'needs_review'
      }),
      expect.objectContaining({
        id: observationDocument.documentId, personId: originalPerson.id, status: 'needs_review'
      })
    ]));
    expect(store.listOpenExtractionReviewIssues().map((issue) => issue.id)).toEqual(expect.arrayContaining([
      committedIssue, observationIssue, archivedIssue
    ]));
    store.close();
  });

  it('身份冲突资料仅归档后脱离成员，旧成员只用剩余资料重建综合', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '合成成员' });
    const remainingSource = store.putSourceObject({
      bytes: Buffer.from('纯合成保留资料'), mediaType: 'text/plain', displayName: '保留.txt'
    });
    const archivedSource = store.putSourceObject({
      bytes: Buffer.from('纯合成归档资料'), mediaType: 'text/plain', displayName: '归档.txt'
    });
    const remainingDocument = store.registerImportedDocument({
      sourceObjectId: remainingSource.id, personId: person.id
    });
    const archivedDocument = store.registerImportedDocument({
      sourceObjectId: archivedSource.id, personId: person.id
    });
    store.setDocumentStatus(remainingDocument.documentId, 'completed');
    store.publishFacts({
      personId: person.id,
      documentId: archivedDocument.documentId,
      documentCommitKey: 'd'.repeat(64), expectedRevision: 0,
      changeSetHash: 'e'.repeat(64), summary: '合成归档前投影', observations: []
    });
    expect(store.listPersonDocumentCounts().get(person.id)).toBe(2);
    expect(store.listReportMetadata(person.id)).toHaveLength(1);

    const consentId = store.createManualProcessingConsent({
      documentIds: [remainingDocument.documentId, archivedDocument.documentId], personIds: [person.id],
      accountFingerprint: 'archive-analyze-account', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z', initialStatus: 'queued', consentId,
      groups: [{
        personId: person.id,
        documentIds: [remainingDocument.documentId, archivedDocument.documentId],
        inputSignature: 'archive-analyze-job'
      }]
    });
    const job = store.claimNextQueuedJob('archive-analyze', 'archive-analyze-account')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: archivedDocument.documentId, jobId: job.id,
      kind: 'person_conflict', severity: 'blocking', evidenceRefs: [],
      preserveDocumentStatus: true, reportedName: '其他姓名'
    });
    store.updateJobStage(job.id, 'analyze');
    store.finishJob(job.id, 'waiting_user');
    store.publishMemberAssessmentSnapshot({
      snapshot: syntheticAssessmentSnapshot(store, person.id, 'before-identity-archive')
    });

    store.resolveReviewIssue({
      issueId, documentId: archivedDocument.documentId, action: 'archive_only'
    });

    expect(store.listStoredJobs()[0]).toMatchObject({
      status: 'queued', stage: 'analyze', completedUnits: 1, totalUnits: 1
    });
    expect(store.claimNextQueuedJob('archive-resume', 'archive-analyze-account')).toMatchObject({
      id: job.id, stage: 'analyze', documentIds: [remainingDocument.documentId]
    });
    expect(store.listPersonDocumentCounts().get(person.id)).toBe(1);
    expect(store.listReportMetadata(person.id)).toEqual([]);
    expect(store.listMemberAssessmentSnapshots(person.id, true)).toEqual([]);
    expect(store.listImportedDocuments()).toContainEqual(expect.objectContaining({
      id: archivedDocument.documentId,
      personId: null,
      personLabel: null,
      status: 'ignored'
    }));
    expect(store.listReadyDocuments()).not.toContainEqual(expect.objectContaining({
      id: archivedDocument.documentId
    }));

    const database = new Database(store.databasePath, { readonly: true });
    expect(database.prepare(`
      SELECT person_id, status, excluded_from_analysis FROM documents WHERE id = ?
    `).get(archivedDocument.documentId)).toEqual({
      person_id: null, status: 'ignored', excluded_from_analysis: 1
    });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM source_objects WHERE id = ?`)
      .get(archivedSource.id)).toEqual({ count: 1 });
    expect(database.prepare(`SELECT resolution_status FROM review_issues WHERE id = ?`)
      .get(issueId)).toEqual({ resolution_status: 'resolved' });
    expect(database.prepare(`SELECT event_type FROM audit_events WHERE entity_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(issueId)).toEqual({ event_type: 'review_issue.resolved' });
    database.close();

    // 原文仍在本地存档，但同一来源再次扫描不得重建成员资料。
    expect(store.registerImportedDocument({
      sourceObjectId: archivedSource.id, personId: person.id, assignmentBasis: 'folder_binding'
    })).toEqual({ documentId: archivedDocument.documentId, status: 'duplicate', duplicate: true });
    store.close();
  });

  it('身份冲突资料归档后批次无剩余资料时安全取消任务', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '合成成员' });
    const source = store.putSourceObject({
      bytes: Buffer.from('唯一的身份冲突资料'), mediaType: 'text/plain', displayName: '唯一资料.txt'
    });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id],
      accountFingerprint: 'archive-only-account', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z', initialStatus: 'queued', consentId,
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: 'archive-only-job' }]
    });
    const job = store.claimNextQueuedJob('archive-only-runner', 'archive-only-account')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId, jobId: job.id,
      kind: 'person_conflict', severity: 'blocking', evidenceRefs: [], reportedName: '其他姓名'
    });
    store.finishJob(job.id, 'waiting_user');

    store.resolveReviewIssue({ issueId, documentId: document.documentId, action: 'archive_only' });

    expect(store.listStoredJobs()).toContainEqual(expect.objectContaining({
      id: job.id, status: 'cancelled', documentIds: [], completedUnits: 0
    }));
    expect(store.claimNextQueuedJob('must-not-resume', 'archive-only-account')).toBeNull();
    expect(store.listImportedDocuments()).toContainEqual(expect.objectContaining({
      id: document.documentId, personId: null, status: 'ignored'
    }));
    store.close();
  });

  it('归档资料会清理可重试的部分完成任务，重试不再带无归属资料', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '合成成员' });
    const remainingSource = store.putSourceObject({
      bytes: Buffer.from('保留资料'), mediaType: 'text/plain', displayName: '保留.txt'
    });
    const archivedSource = store.putSourceObject({
      bytes: Buffer.from('归档资料'), mediaType: 'text/plain', displayName: '归档.txt'
    });
    const remainingDocument = store.registerImportedDocument({
      sourceObjectId: remainingSource.id, personId: person.id
    });
    const archivedDocument = store.registerImportedDocument({
      sourceObjectId: archivedSource.id, personId: person.id
    });
    store.setDocumentStatus(remainingDocument.documentId, 'completed');
    const accountFingerprint = 'archive-completed-issues-account';
    const consentId = store.createManualProcessingConsent({
      documentIds: [remainingDocument.documentId, archivedDocument.documentId],
      personIds: [person.id], accountFingerprint, version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z', initialStatus: 'queued', consentId,
      groups: [{
        personId: person.id,
        documentIds: [remainingDocument.documentId, archivedDocument.documentId],
        inputSignature: 'archive-completed-issues-job'
      }]
    });
    const job = store.claimNextQueuedJob('archive-completed-issues-runner', accountFingerprint)!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: archivedDocument.documentId, jobId: job.id,
      kind: 'person_conflict', severity: 'blocking', evidenceRefs: [], reportedName: '其他姓名'
    });
    store.updateJobProgress(job.id, 2);
    store.finishJob(job.id, 'completed_with_issues');

    const legacyDatabase = new Database(store.databasePath);
    const legacyRow = legacyDatabase.prepare(`SELECT checkpoint_json FROM jobs WHERE id = ?`)
      .get(job.id) as { checkpoint_json: string };
    const legacyCheckpoint = JSON.parse(legacyRow.checkpoint_json) as Record<string, unknown>;
    legacyDatabase.prepare(`UPDATE jobs SET checkpoint_json = ? WHERE id = ?`).run(JSON.stringify({
      ...legacyCheckpoint,
      extractionChunks: {
        [archivedDocument.documentId]: { stale: { output: 'MUST_BE_REMOVED' } }
      },
      systemOutcomes: [{ systemId: 'cardiovascular', status: 'held' }]
    }), job.id);
    legacyDatabase.close();

    store.resolveReviewIssue({
      issueId, documentId: archivedDocument.documentId, action: 'archive_only'
    });

    const cleanedDatabase = new Database(store.databasePath, { readonly: true });
    const cleanedRow = cleanedDatabase.prepare(`SELECT status, checkpoint_json FROM jobs WHERE id = ?`)
      .get(job.id) as { status: string; checkpoint_json: string };
    cleanedDatabase.close();
    expect(cleanedRow.status).toBe('completed_with_issues');
    expect(JSON.parse(cleanedRow.checkpoint_json)).toMatchObject({
      documentIds: [remainingDocument.documentId], completedUnits: 1
    });
    expect(cleanedRow.checkpoint_json).not.toContain(archivedDocument.documentId);
    expect(cleanedRow.checkpoint_json).not.toContain('MUST_BE_REMOVED');
    expect(cleanedRow.checkpoint_json).not.toContain('systemOutcomes');

    store.retryFailedJob(job.id);
    expect(store.claimNextQueuedJob('archive-retry', accountFingerprint)).toMatchObject({
      id: job.id,
      stage: 'system_analysis',
      documentIds: [remainingDocument.documentId]
    });
    store.close();
  });

  it('schema v9 只重试可恢复的旧 PDF 覆盖误拦截，必须由原文件复核后才补全清单', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v8-pdf-manifest-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:00:00Z') });
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const source = store.putSourceObject({ bytes: Buffer.from('旧版 PDF 占位内容'), mediaType: 'application/pdf', displayName: '旧版体检报告.pdf' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.saveSourceManifest({
      id: 'legacy-pdf-manifest', sourceObjectId: source.id, sha256: source.sha256, mediaType: 'application/pdf',
      originalDisplayName: '旧版体检报告.pdf', totalUnits: 2, coveredUnitIndexes: [0, 1],
      spans: [
        { id: 'legacy-page-1', documentId: document.documentId, spanKind: 'page', page: 1, blockId: null, lineStart: null, lineEnd: null, quote: '第一页内容', readability: 'clear' },
        { id: 'legacy-page-2', documentId: document.documentId, spanKind: 'page', page: 2, blockId: null, lineStart: null, lineEnd: null, quote: '第二页内容', readability: 'clear' }
      ],
      normalizerVersion: 'pdfjs-5.4-text-v1', conversionWarnings: [], createdAt: '2026-09-18T00:00:00.000Z'
    });
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'coverage_gap',
      severity: 'blocking',
      evidenceRefs: ['legacy-page-1'],
      candidateOptions: [{
        localKey: 'candidate-1', originalName: '收缩压', standardNameCandidate: null,
        value: { kind: 'numeric', rawText: '107', decimal: '107', comparator: 'eq' },
        unitRaw: 'mmHg', referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: null, bodySite: null, clinicalDate: '2023-10-08',
        evidence: [{ sourceSpanId: 'legacy-page-1', quote: '第一页内容' }], issues: []
      }]
    });
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`
      DELETE FROM source_manifests WHERE document_id = '${document.documentId}';
      UPDATE workspaces SET schema_version = 8;
      PRAGMA user_version = 8;
    `);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:01:00Z') });
    const pendingRecovery = store.getDocumentExtractionBundle(document.documentId);
    expect(pendingRecovery.manifest.coveredUnitIndexes).toEqual([]);
    expect(pendingRecovery.manifest.conversionWarnings).toContain('historical_manifest_metadata_unavailable');
    expect(store.listOpenExtractionReviewIssues().some((issue) => issue.id === issueId)).toBe(false);
    expect(store.listReadyDocuments()).toEqual([{ id: document.documentId, personId: person.id }]);

    expect(() => store.reconstructLegacyPdfManifest({
      documentId: document.documentId,
      sha256: source.sha256,
      totalPages: 3,
      normalizerVersion: 'pdfjs-5.4-text-v1'
    })).toThrow('LEGACY_PDF_MANIFEST_RECOVERY_UNSAFE');
    expect(store.reconstructLegacyPdfManifest({
      documentId: document.documentId,
      sha256: source.sha256,
      totalPages: 2,
      normalizerVersion: 'pdfjs-5.4-text-v1'
    })).toBe(true);
    expect(store.getDocumentExtractionBundle(document.documentId).manifest).toMatchObject({
      totalUnits: 2,
      coveredUnitIndexes: [0, 1],
      conversionWarnings: ['historical_manifest_reconstructed_from_verified_pdf']
    });
    store.close();
  });

  it('schema v11 只重试仅有非阻断标记差异的旧血压组合值核对', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v9-blood-pressure-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:00:00Z') });
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const sourceText = '检查日期 2023-10-08 血压 107/70 mmHg 收缩压 107 mmHg 舒张压 70 mmHg';
    const source = store.putSourceObject({ bytes: Buffer.from(sourceText), mediaType: 'text/plain', displayName: '血压体检报告.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.saveSourceManifest({
      id: 'blood-pressure-manifest', sourceObjectId: source.id, sha256: source.sha256, mediaType: 'text/plain',
      originalDisplayName: '血压体检报告.txt', totalUnits: 1, coveredUnitIndexes: [0],
      spans: [{ id: 'blood-pressure-span', documentId: document.documentId, spanKind: 'line', page: 1, blockId: null, lineStart: 1, lineEnd: 1, quote: sourceText, readability: 'clear' }],
      normalizerVersion: 'manifest-test-v1', conversionWarnings: [], createdAt: '2026-09-18T00:00:00.000Z'
    });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: 'e'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: ['blood-pressure-span'],
      candidateOptions: [{
        localKey: 'blood-pressure', originalName: '血压', standardNameCandidate: '血压',
        value: { kind: 'text', rawText: '107/70' },
        unitRaw: 'mmHg', referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: null, bodySite: null, clinicalDate: '2023-10-08',
        evidence: [{ sourceSpanId: 'blood-pressure-span', quote: sourceText }],
        issues: [{ code: 'pair_value_preserved', message: '保留报告中的成对表达' }]
      }],
      candidateDiffs: [{ localKey: 'blood-pressure', itemName: '血压', fields: ['issues'] }]
    });
    store.finishJob(job.id, 'waiting_user');
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`UPDATE workspaces SET schema_version = 10; PRAGMA user_version = 10;`);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:01:00Z') });
    expect(store.listOpenExtractionReviewIssues().some((issue) => issue.id === issueId)).toBe(false);
    expect(store.listReadyDocuments()).toEqual([{ id: document.documentId, personId: person.id }]);
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'queued', completedUnits: 0, totalUnits: 1 });
    expect(store.getFactRevision(person.id)).toBe(0);
    expect(store.listAcceptedObservations(person.id)).toEqual([]);
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(WORKSPACE_SCHEMA_VERSION);
    upgraded.close();
    store.close();
  });

  it('schema v12 只重试同一来源片段内临床日期唯一的旧证据上下文误拦截', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v11-date-context-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:00:00Z') });
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const sourceText = '检查日期：2023-10-08 检查结果 身高 187 厘米';
    const source = store.putSourceObject({ bytes: Buffer.from(sourceText), mediaType: 'text/plain', displayName: '身高体检报告.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.saveSourceManifest({
      id: 'height-manifest', sourceObjectId: source.id, sha256: source.sha256, mediaType: 'text/plain',
      originalDisplayName: '身高体检报告.txt', totalUnits: 1, coveredUnitIndexes: [0],
      spans: [{ id: 'height-span', documentId: document.documentId, spanKind: 'line', page: 1, blockId: null, lineStart: 1, lineEnd: 1, quote: sourceText, readability: 'clear' }],
      normalizerVersion: 'manifest-test-v1', conversionWarnings: [], createdAt: '2026-09-18T00:00:00.000Z'
    });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: 'f'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: ['height-span'],
      candidateOptions: [{
        localKey: 'height', originalName: '身高', standardNameCandidate: 'Height',
        value: { kind: 'numeric', rawText: '187', decimal: '187', comparator: 'eq' },
        unitRaw: '厘米', referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: null, bodySite: null, clinicalDate: '2023-10-08',
        evidence: [{ sourceSpanId: 'height-span', quote: '身高 187 厘米' }], issues: []
      }],
      candidateDiffs: [{ localKey: 'height', itemName: '身高', fields: ['issues'] }]
    });
    store.finishJob(job.id, 'waiting_user');
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`UPDATE workspaces SET schema_version = 11; PRAGMA user_version = 11;`);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:01:00Z') });
    expect(store.listOpenExtractionReviewIssues().some((issue) => issue.id === issueId)).toBe(false);
    expect(store.listReadyDocuments()).toEqual([{ id: document.documentId, personId: person.id }]);
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'queued', completedUnits: 0, totalUnits: 1 });
    expect(store.getFactRevision(person.id)).toBe(0);
    expect(store.listAcceptedObservations(person.id)).toEqual([]);
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(WORKSPACE_SCHEMA_VERSION);
    upgraded.close();
    store.close();
  });

  it('schema v13 只重试原文定性值有清晰依据的旧标准分类差异', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v12-qualitative-category-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:00:00Z') });
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const sourceText = '检查日期：2023-10-08 尿白细胞 (LEU) 隂性';
    const source = store.putSourceObject({ bytes: Buffer.from(sourceText), mediaType: 'text/plain', displayName: '尿常规报告.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.saveSourceManifest({
      id: 'qualitative-manifest', sourceObjectId: source.id, sha256: source.sha256, mediaType: 'text/plain',
      originalDisplayName: '尿常规报告.txt', totalUnits: 1, coveredUnitIndexes: [0],
      spans: [{ id: 'qualitative-span', documentId: document.documentId, spanKind: 'line', page: 1, blockId: null, lineStart: 1, lineEnd: 1, quote: sourceText, readability: 'clear' }],
      normalizerVersion: 'manifest-test-v1', conversionWarnings: [], createdAt: '2026-09-18T00:00:00.000Z'
    });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: '1'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: ['qualitative-span'],
      candidateOptions: [{
        localKey: 'urine-leukocyte', originalName: '尿白细胞 (LEU)', standardNameCandidate: null,
        value: { kind: 'qualitative', rawText: '隂性', category: '阴性' },
        unitRaw: null, referenceRangeRaw: '隂性', reportedAbnormalFlag: null,
        specimen: '尿液', method: '尿常规', bodySite: null, clinicalDate: '2023-10-08',
        evidence: [{ sourceSpanId: 'qualitative-span', quote: sourceText }], issues: []
      }],
      candidateDiffs: [{ localKey: 'urine-leukocyte', itemName: '尿白细胞 (LEU)', fields: ['value'] }]
    });
    store.finishJob(job.id, 'waiting_user');
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`UPDATE workspaces SET schema_version = 12; PRAGMA user_version = 12;`);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:01:00Z') });
    expect(store.listOpenExtractionReviewIssues().some((issue) => issue.id === issueId)).toBe(false);
    expect(store.listReadyDocuments()).toEqual([{ id: document.documentId, personId: person.id }]);
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'queued', completedUnits: 0, totalUnits: 1 });
    expect(store.getFactRevision(person.id)).toBe(0);
    expect(store.listAcceptedObservations(person.id)).toEqual([]);
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(WORKSPACE_SCHEMA_VERSION);
    upgraded.close();
    store.close();
  });

  it('schema v14 只重试项目文字唯一且前置检查日期一致的旧证据误拦截', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v13-section-date-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:00:00Z') });
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const sourceText = '检验科 幽门螺菌尿素酶抗体 检查日期：2023-10-08 项目名称 检查结果 幽门螺杆菌抗体测定 阴性 阴性 (-) 检验科 EB 病毒抗体 检查日期：2023-10-09 项目名称 检查结果 EB 病毒抗体 0.05';
    const source = store.putSourceObject({ bytes: Buffer.from(sourceText), mediaType: 'text/plain', displayName: '多科室体检报告.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.saveSourceManifest({
      id: 'section-date-manifest', sourceObjectId: source.id, sha256: source.sha256, mediaType: 'text/plain',
      originalDisplayName: '多科室体检报告.txt', totalUnits: 1, coveredUnitIndexes: [0],
      spans: [{ id: 'section-date-span', documentId: document.documentId, spanKind: 'line', page: 1, blockId: null, lineStart: 1, lineEnd: 1, quote: sourceText, readability: 'clear' }],
      normalizerVersion: 'manifest-test-v1', conversionWarnings: [], createdAt: '2026-09-18T00:00:00.000Z'
    });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: '2'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: ['section-date-span'],
      candidateOptions: [{
        localKey: 'h-pylori', originalName: '幽门螺杆菌抗体测定', standardNameCandidate: null,
        value: { kind: 'qualitative', rawText: '阴性', category: 'negative' },
        unitRaw: null, referenceRangeRaw: '阴性 (-)', reportedAbnormalFlag: null,
        specimen: null, method: null, bodySite: null, clinicalDate: '2023-10-08',
        evidence: [{ sourceSpanId: 'section-date-span', quote: '幽门螺杆菌抗体测定 阴性 阴性 (-)' }], issues: []
      }],
      candidateDiffs: [{ localKey: 'h-pylori', itemName: '幽门螺杆菌抗体测定', fields: ['issues'] }]
    });
    store.finishJob(job.id, 'waiting_user');
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`UPDATE workspaces SET schema_version = 13; PRAGMA user_version = 13;`);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:01:00Z') });
    expect(store.listOpenExtractionReviewIssues().some((issue) => issue.id === issueId)).toBe(false);
    expect(store.listReadyDocuments()).toEqual([{ id: document.documentId, personId: person.id }]);
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'queued', completedUnits: 0, totalUnits: 1 });
    expect(store.getFactRevision(person.id)).toBe(0);
    expect(store.listAcceptedObservations(person.id)).toEqual([]);
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(WORKSPACE_SCHEMA_VERSION);
    upgraded.close();
    store.close();
  });

  it('schema v15 只重试同一超声项目的方法别名差异', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v14-ultrasound-method-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:00:00Z') });
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const sourceText = '甲状腺彩超 检查日期：2023-10-09 小结 甲状腺回声异常';
    const source = store.putSourceObject({ bytes: Buffer.from(sourceText), mediaType: 'text/plain', displayName: '超声报告.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.saveSourceManifest({
      id: 'ultrasound-method-manifest', sourceObjectId: source.id, sha256: source.sha256, mediaType: 'text/plain',
      originalDisplayName: '超声报告.txt', totalUnits: 1, coveredUnitIndexes: [0],
      spans: [{ id: 'ultrasound-method-span', documentId: document.documentId, spanKind: 'line', page: 1, blockId: null, lineStart: 1, lineEnd: 1, quote: sourceText, readability: 'clear' }],
      normalizerVersion: 'manifest-test-v1', conversionWarnings: [], createdAt: '2026-09-18T00:00:00.000Z'
    });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: '3'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: ['ultrasound-method-span'],
      candidateOptions: [{
        localKey: 'thyroid-ultrasound', originalName: '甲状腺彩超小结', standardNameCandidate: 'Thyroid ultrasound impression',
        value: { kind: 'text', rawText: '甲状腺回声异常' },
        unitRaw: null, referenceRangeRaw: null, reportedAbnormalFlag: '异常',
        specimen: null, method: '甲状腺彩超', bodySite: '甲状腺', clinicalDate: '2023-10-09',
        evidence: [{ sourceSpanId: 'ultrasound-method-span', quote: sourceText }], issues: []
      }],
      candidateDiffs: [{ localKey: 'thyroid-ultrasound', itemName: '甲状腺彩超小结', fields: ['method'] }]
    });
    store.finishJob(job.id, 'waiting_user');
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`UPDATE workspaces SET schema_version = 14; PRAGMA user_version = 14;`);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:01:00Z') });
    expect(store.listOpenExtractionReviewIssues().some((issue) => issue.id === issueId)).toBe(false);
    expect(store.listReadyDocuments()).toEqual([{ id: document.documentId, personId: person.id }]);
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'queued', completedUnits: 0, totalUnits: 1 });
    expect(store.getFactRevision(person.id)).toBe(0);
    expect(store.listAcceptedObservations(person.id)).toEqual([]);
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(WORKSPACE_SCHEMA_VERSION);
    upgraded.close();
    store.close();
  });

  it('schema v16 只重试 PDF 排版空格造成的结果断字误拦截', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v15-whitespace-evidence-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:00:00Z') });
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const sourceText = '甲状腺彩超 检查日期：2023-10-09 小结 甲状腺回声异常，请结合实验室检 查';
    const source = store.putSourceObject({ bytes: Buffer.from(sourceText), mediaType: 'text/plain', displayName: '断字报告.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.saveSourceManifest({
      id: 'whitespace-evidence-manifest', sourceObjectId: source.id, sha256: source.sha256, mediaType: 'text/plain',
      originalDisplayName: '断字报告.txt', totalUnits: 1, coveredUnitIndexes: [0],
      spans: [{ id: 'whitespace-evidence-span', documentId: document.documentId, spanKind: 'line', page: 1, blockId: null, lineStart: 1, lineEnd: 1, quote: sourceText, readability: 'clear' }],
      normalizerVersion: 'manifest-test-v1', conversionWarnings: [], createdAt: '2026-09-18T00:00:00.000Z'
    });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: '4'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: ['whitespace-evidence-span'],
      candidateOptions: [{
        localKey: 'thyroid-ultrasound', originalName: '甲状腺彩超小结', standardNameCandidate: null,
        value: { kind: 'text', rawText: '甲状腺回声异常，请结合实验室检查' },
        unitRaw: null, referenceRangeRaw: null, reportedAbnormalFlag: '异常',
        specimen: null, method: '甲状腺彩超', bodySite: '甲状腺', clinicalDate: '2023-10-09',
        evidence: [{ sourceSpanId: 'whitespace-evidence-span', quote: sourceText }], issues: []
      }],
      candidateDiffs: [{ localKey: 'thyroid-ultrasound', itemName: '甲状腺彩超小结', fields: ['issues'] }]
    });
    store.finishJob(job.id, 'waiting_user');
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`UPDATE workspaces SET schema_version = 15; PRAGMA user_version = 15;`);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:01:00Z') });
    expect(store.listOpenExtractionReviewIssues().some((issue) => issue.id === issueId)).toBe(false);
    expect(store.listReadyDocuments()).toEqual([{ id: document.documentId, personId: person.id }]);
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'queued', completedUnits: 0, totalUnits: 1 });
    expect(store.getFactRevision(person.id)).toBe(0);
    expect(store.listAcceptedObservations(person.id)).toEqual([]);
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(WORKSPACE_SCHEMA_VERSION);
    upgraded.close();
    store.close();
  });

  it('schema v17 只重试有清晰原文依据的单侧正常小结', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v16-normal-summary-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:00:00Z') });
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const sourceText = '眼科 检查日期：2023-10-08 小结 未见异常';
    const source = store.putSourceObject({ bytes: Buffer.from(sourceText), mediaType: 'text/plain', displayName: '眼科报告.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.saveSourceManifest({
      id: 'normal-summary-manifest', sourceObjectId: source.id, sha256: source.sha256, mediaType: 'text/plain',
      originalDisplayName: '眼科报告.txt', totalUnits: 1, coveredUnitIndexes: [0],
      spans: [{ id: 'normal-summary-span', documentId: document.documentId, spanKind: 'line', page: 1, blockId: null, lineStart: 1, lineEnd: 1, quote: sourceText, readability: 'clear' }],
      normalizerVersion: 'manifest-test-v1', conversionWarnings: [], createdAt: '2026-09-18T00:00:00.000Z'
    });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: '5'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: ['normal-summary-span'],
      candidateOptions: [{
        localKey: 'eye-summary', originalName: '眼科小结', standardNameCandidate: 'Ophthalmology summary',
        value: { kind: 'qualitative', rawText: '未见异常', category: 'no abnormality detected' },
        unitRaw: null, referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: '眼科检查', bodySite: '眼', clinicalDate: '2023-10-08',
        evidence: [{ sourceSpanId: 'normal-summary-span', quote: sourceText }], issues: []
      }],
      candidateDiffs: [{ localKey: 'eye-summary', itemName: '眼科小结', fields: ['presence'] }]
    });
    store.finishJob(job.id, 'waiting_user');
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`UPDATE workspaces SET schema_version = 16; PRAGMA user_version = 16;`);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:01:00Z') });
    expect(store.listOpenExtractionReviewIssues().some((issue) => issue.id === issueId)).toBe(false);
    expect(store.listReadyDocuments()).toEqual([{ id: document.documentId, personId: person.id }]);
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'queued', completedUnits: 0, totalUnits: 1 });
    expect(store.getFactRevision(person.id)).toBe(0);
    expect(store.listAcceptedObservations(person.id)).toEqual([]);
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(WORKSPACE_SCHEMA_VERSION);
    upgraded.close();
    store.close();
  });

  it('schema v18 只重试有清晰项目名依据的单侧空白未知项', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v17-empty-unknown-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:00:00Z') });
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const sourceText = '眼科 检查日期：2023-10-08 裸眼视力 (右)    矫正视力 (右) 5.0';
    const source = store.putSourceObject({ bytes: Buffer.from(sourceText), mediaType: 'text/plain', displayName: '眼科报告.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.saveSourceManifest({
      id: 'empty-unknown-manifest', sourceObjectId: source.id, sha256: source.sha256, mediaType: 'text/plain',
      originalDisplayName: '眼科报告.txt', totalUnits: 1, coveredUnitIndexes: [0],
      spans: [{ id: 'empty-unknown-span', documentId: document.documentId, spanKind: 'line', page: 1, blockId: null, lineStart: 1, lineEnd: 1, quote: sourceText, readability: 'clear' }],
      normalizerVersion: 'manifest-test-v1', conversionWarnings: [], createdAt: '2026-09-18T00:00:00.000Z'
    });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: '6'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: ['empty-unknown-span'],
      candidateOptions: [{
        localKey: 'uncorrected-visual-acuity-right', originalName: '裸眼视力 (右)', standardNameCandidate: 'uncorrected_visual_acuity_right',
        value: { kind: 'unknown', rawText: null, reason: '报告对应栏位为空白' },
        unitRaw: null, referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: '眼科检查', bodySite: '右眼', clinicalDate: '2023-10-08',
        evidence: [{ sourceSpanId: 'empty-unknown-span', quote: sourceText }], issues: []
      }],
      candidateDiffs: [{ localKey: 'uncorrected-visual-acuity-right', itemName: '裸眼视力 (右)', fields: ['presence'] }]
    });
    store.finishJob(job.id, 'waiting_user');
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`UPDATE workspaces SET schema_version = 17; PRAGMA user_version = 17;`);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:01:00Z') });
    expect(store.listOpenExtractionReviewIssues().some((issue) => issue.id === issueId)).toBe(false);
    expect(store.listReadyDocuments()).toEqual([{ id: document.documentId, personId: person.id }]);
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'queued', completedUnits: 0, totalUnits: 1 });
    expect(store.getFactRevision(person.id)).toBe(0);
    expect(store.listAcceptedObservations(person.id)).toEqual([]);
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(WORKSPACE_SCHEMA_VERSION);
    upgraded.close();
    store.close();
  });

  it('schema v19 只重试字符相同但 PDF 空白排版不同的证据摘录', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v18-whitespace-citation-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:00:00Z') });
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const sourceText = '肝胆脾胰彩超 检查日期：2023-10-09 彩色多普 勒 小结 肝、胆、脾、胰：未见明显异常声像';
    const citedText = '肝胆脾胰彩超 检查日期：2023-10-09 彩色多普勒 小结 肝、胆、脾、胰：未见明显异常声像';
    const source = store.putSourceObject({ bytes: Buffer.from(sourceText), mediaType: 'text/plain', displayName: '超声报告.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.saveSourceManifest({
      id: 'whitespace-citation-manifest', sourceObjectId: source.id, sha256: source.sha256, mediaType: 'text/plain',
      originalDisplayName: '超声报告.txt', totalUnits: 1, coveredUnitIndexes: [0],
      spans: [{ id: 'whitespace-citation-span', documentId: document.documentId, spanKind: 'line', page: 1, blockId: null, lineStart: 1, lineEnd: 1, quote: sourceText, readability: 'clear' }],
      normalizerVersion: 'manifest-test-v1', conversionWarnings: [], createdAt: '2026-09-18T00:00:00.000Z'
    });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: '7'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: ['whitespace-citation-span'],
      candidateOptions: [{
        localKey: 'hepatobiliary-summary', originalName: '肝胆脾胰彩超小结', standardNameCandidate: null,
        value: { kind: 'text', rawText: '肝、胆、脾、胰：未见明显异常声像' },
        unitRaw: null, referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: '彩色多普勒超声', bodySite: '肝、胆、脾、胰', clinicalDate: '2023-10-09',
        evidence: [{ sourceSpanId: 'whitespace-citation-span', quote: citedText }], issues: []
      }],
      candidateDiffs: [{ localKey: 'hepatobiliary-summary', itemName: '肝胆脾胰彩超小结', fields: ['issues'] }]
    });
    store.finishJob(job.id, 'waiting_user');
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`UPDATE workspaces SET schema_version = 18; PRAGMA user_version = 18;`);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:01:00Z') });
    expect(store.listOpenExtractionReviewIssues().some((issue) => issue.id === issueId)).toBe(false);
    expect(store.listReadyDocuments()).toEqual([{ id: document.documentId, personId: person.id }]);
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'queued', completedUnits: 0, totalUnits: 1 });
    expect(store.getFactRevision(person.id)).toBe(0);
    expect(store.listAcceptedObservations(person.id)).toEqual([]);
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(WORKSPACE_SCHEMA_VERSION);
    upgraded.close();
    store.close();
  });

  it('schema v20 只重试同一来源内前后片段可唯一定位的省略证据', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v19-abbreviated-citation-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:00:00Z') });
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const sourceText = '一般状况 身高、体重 检查日期：2023-10-08 检查医生：张医生 项目名称 检查结果 身高 187 厘米 体重 91 Kg';
    const citedText = '身高、体重 检查日期：2023-10-08…身高 187 厘米';
    const source = store.putSourceObject({ bytes: Buffer.from(sourceText), mediaType: 'text/plain', displayName: '身高体重报告.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.saveSourceManifest({
      id: 'abbreviated-citation-manifest', sourceObjectId: source.id, sha256: source.sha256, mediaType: 'text/plain',
      originalDisplayName: '身高体重报告.txt', totalUnits: 1, coveredUnitIndexes: [0],
      spans: [{ id: 'abbreviated-citation-span', documentId: document.documentId, spanKind: 'line', page: 1, blockId: null, lineStart: 1, lineEnd: 1, quote: sourceText, readability: 'clear' }],
      normalizerVersion: 'manifest-test-v1', conversionWarnings: [], createdAt: '2026-09-18T00:00:00.000Z'
    });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: '8'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: ['abbreviated-citation-span'],
      candidateOptions: [{
        localKey: 'height', originalName: '身高', standardNameCandidate: 'Body height',
        value: { kind: 'numeric', rawText: '187', decimal: '187', comparator: 'eq' },
        unitRaw: '厘米', referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: null, bodySite: null, clinicalDate: '2023-10-08',
        evidence: [{ sourceSpanId: 'abbreviated-citation-span', quote: citedText }], issues: []
      }],
      candidateDiffs: [{ localKey: 'height', itemName: '身高', fields: ['issues'] }]
    });
    store.finishJob(job.id, 'waiting_user');
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`UPDATE workspaces SET schema_version = 19; PRAGMA user_version = 19;`);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:01:00Z') });
    expect(store.listOpenExtractionReviewIssues().some((issue) => issue.id === issueId)).toBe(false);
    expect(store.listReadyDocuments()).toEqual([{ id: document.documentId, personId: person.id }]);
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'queued', completedUnits: 0, totalUnits: 1 });
    expect(store.getFactRevision(person.id)).toBe(0);
    expect(store.listAcceptedObservations(person.id)).toEqual([]);
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(WORKSPACE_SCHEMA_VERSION);
    upgraded.close();
    store.close();
  });

  it('schema v21 允许省略证据的结尾在后续科室重复，但当前科室内必须唯一', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v20-section-abbreviation-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:00:00Z') });
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const sourceText = '内科 内科 检查日期：2023-10-08 心脏未见异常 小结 未见异常 外科 外科 检查日期：2023-10-08 皮肤无异常 小结 未见异常';
    const citedText = '内科 内科 检查日期：2023-10-08……小结 未见异常';
    const source = store.putSourceObject({ bytes: Buffer.from(sourceText), mediaType: 'text/plain', displayName: '分科报告.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.saveSourceManifest({
      id: 'section-abbreviation-manifest', sourceObjectId: source.id, sha256: source.sha256, mediaType: 'text/plain',
      originalDisplayName: '分科报告.txt', totalUnits: 1, coveredUnitIndexes: [0],
      spans: [{ id: 'section-abbreviation-span', documentId: document.documentId, spanKind: 'line', page: 1, blockId: null, lineStart: 1, lineEnd: 1, quote: sourceText, readability: 'clear' }],
      normalizerVersion: 'manifest-test-v1', conversionWarnings: [], createdAt: '2026-09-18T00:00:00.000Z'
    });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: '9'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: ['section-abbreviation-span'],
      candidateOptions: [{
        localKey: 'internal-summary', originalName: '内科小结', standardNameCandidate: null,
        value: { kind: 'qualitative', rawText: '未见异常', category: 'no abnormality detected' },
        unitRaw: null, referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: null, bodySite: null, clinicalDate: '2023-10-08',
        evidence: [{ sourceSpanId: 'section-abbreviation-span', quote: citedText }], issues: []
      }],
      candidateDiffs: [{ localKey: 'internal-summary', itemName: '内科小结', fields: ['issues'] }]
    });
    store.finishJob(job.id, 'waiting_user');
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`UPDATE workspaces SET schema_version = 20; PRAGMA user_version = 20;`);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:01:00Z') });
    expect(store.listOpenExtractionReviewIssues().some((issue) => issue.id === issueId)).toBe(false);
    expect(store.listReadyDocuments()).toEqual([{ id: document.documentId, personId: person.id }]);
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'queued', completedUnits: 0, totalUnits: 1 });
    expect(store.getFactRevision(person.id)).toBe(0);
    expect(store.listAcceptedObservations(person.id)).toEqual([]);
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(WORKSPACE_SCHEMA_VERSION);
    upgraded.close();
    store.close();
  });

  it('schema v22 将单侧缺失的参考范围保守留空并重新排队', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v21-reference-range-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:00:00Z') });
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const sourceText = '检查日期：2023-10-08 血压 107/70 mmHg';
    const source = store.putSourceObject({ bytes: Buffer.from(sourceText), mediaType: 'text/plain', displayName: '血压报告.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.saveSourceManifest({
      id: 'reference-range-manifest', sourceObjectId: source.id, sha256: source.sha256, mediaType: 'text/plain',
      originalDisplayName: '血压报告.txt', totalUnits: 1, coveredUnitIndexes: [0],
      spans: [{ id: 'reference-range-span', documentId: document.documentId, spanKind: 'line', page: 1, blockId: null, lineStart: 1, lineEnd: 1, quote: sourceText, readability: 'clear' }],
      normalizerVersion: 'manifest-test-v1', conversionWarnings: [], createdAt: '2026-09-18T00:00:00.000Z'
    });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: 'a'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: ['reference-range-span'],
      candidateOptions: [{
        localKey: 'bp-systolic', originalName: '收缩压', standardNameCandidate: 'Systolic blood pressure',
        value: { kind: 'numeric', rawText: '107', decimal: '107', comparator: 'eq' },
        unitRaw: 'mmHg', referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: null, bodySite: null, clinicalDate: '2023-10-08',
        evidence: [{ sourceSpanId: 'reference-range-span', quote: sourceText }], issues: []
      }],
      candidateDiffs: [{ localKey: 'bp-systolic', itemName: '收缩压', fields: ['referenceRangeRaw'] }]
    });
    store.finishJob(job.id, 'waiting_user');
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`UPDATE workspaces SET schema_version = 21; PRAGMA user_version = 21;`);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:01:00Z') });
    expect(store.listOpenExtractionReviewIssues().some((issue) => issue.id === issueId)).toBe(false);
    expect(store.listReadyDocuments()).toEqual([{ id: document.documentId, personId: person.id }]);
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'queued', completedUnits: 0, totalUnits: 1 });
    expect(store.getFactRevision(person.id)).toBe(0);
    expect(store.listAcceptedObservations(person.id)).toEqual([]);
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(WORKSPACE_SCHEMA_VERSION);
    upgraded.close();
    store.close();
  });

  it('schema v23 重新运行可能由否定式医学边界误判而暂停的派生分析', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v22-derived-boundary-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:00:00Z') });
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const source = store.putSourceObject({ bytes: Buffer.from('虚构报告事实'), mediaType: 'text/plain', displayName: '虚构报告.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: 'b'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'derived_safety',
      severity: 'blocking',
      evidenceRefs: [],
      preserveDocumentStatus: true
    });
    store.finishJob(job.id, 'waiting_user');
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`
      UPDATE documents SET status = 'completed' WHERE id = '${document.documentId}';
      UPDATE jobs SET stage = 'analyze' WHERE id = '${job.id}';
      UPDATE workspaces SET schema_version = 22;
      PRAGMA user_version = 22;
    `);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:01:00Z') });
    expect(store.listOpenExtractionReviewIssues().some((issue) => issue.id === issueId)).toBe(false);
    expect(store.listStoredJobs()[0]).toMatchObject({ stage: 'analyze', status: 'queued' });
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(WORKSPACE_SCHEMA_VERSION);
    upgraded.close();
    store.close();
  });

  it('schema v24 恢复没有明确姓名冲突的用户归属资料与同批任务', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v23-identity-review-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-19T13:18:00Z') });
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const source = store.putSourceObject({ bytes: Buffer.from('姓名区域模糊的虚构图片'), mediaType: 'image/png', displayName: '虚构图片.png' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id, assignmentBasis: 'user_selected' });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-19T13:18:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: 'c'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: []
    });
    store.finishJob(job.id, 'waiting_user');
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`UPDATE workspaces SET schema_version = 23; PRAGMA user_version = 23;`);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-19T13:20:00Z') });
    expect(store.listOpenExtractionReviewIssues().some((issue) => issue.id === issueId)).toBe(false);
    expect(store.listReadyDocuments()).toEqual([{ id: document.documentId, personId: person.id }]);
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'queued', completedUnits: 0, totalUnits: 1 });
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(WORKSPACE_SCHEMA_VERSION);
    upgraded.close();
    store.close();
  });

  it('schema v25 自动重试只有内部证据引用或边界备注错误的派生说明', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v24-derived-structure-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-19T14:38:00Z') });
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const source = store.putSourceObject({ bytes: Buffer.from('虚构报告事实'), mediaType: 'text/plain', displayName: '虚构报告.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-19T14:38:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: 'd'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'derived_safety',
      severity: 'blocking',
      evidenceRefs: [],
      preserveDocumentStatus: true,
      reasonCodes: ['boundary_note_required:c4', 'evidence_mismatch:c9']
    });
    store.finishJob(job.id, 'waiting_user');
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`
      UPDATE documents SET status = 'completed' WHERE id = '${document.documentId}';
      UPDATE jobs SET stage = 'analyze' WHERE id = '${job.id}';
      UPDATE workspaces SET schema_version = 24;
      PRAGMA user_version = 24;
    `);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-19T14:39:00Z') });
    expect(store.listOpenExtractionReviewIssues().some((issue) => issue.id === issueId)).toBe(false);
    expect(store.listStoredJobs()[0]).toMatchObject({ stage: 'analyze', status: 'queued' });
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(WORKSPACE_SCHEMA_VERSION);
    upgraded.close();
    store.close();
  });

  it('schema v26 自动重试只有单条说明被独立复核拒绝的派生任务', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v25-derived-item-review-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-19T14:49:00Z') });
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const source = store.putSourceObject({ bytes: Buffer.from('虚构报告事实'), mediaType: 'text/plain', displayName: '虚构报告.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-19T14:49:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: 'e'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'derived_safety',
      severity: 'blocking',
      evidenceRefs: [],
      preserveDocumentStatus: true,
      reasonCodes: ['guidance_rejected:hydration-routine']
    });
    store.finishJob(job.id, 'waiting_user');
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`
      UPDATE documents SET status = 'completed' WHERE id = '${document.documentId}';
      UPDATE jobs SET stage = 'review_derived' WHERE id = '${job.id}';
      UPDATE workspaces SET schema_version = 25;
      PRAGMA user_version = 25;
    `);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-19T14:50:00Z') });
    expect(store.listOpenExtractionReviewIssues().some((issue) => issue.id === issueId)).toBe(false);
    expect(store.listStoredJobs()[0]).toMatchObject({ stage: 'analyze', status: 'queued' });
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(WORKSPACE_SCHEMA_VERSION);
    upgraded.close();
    store.close();
  });

  it('schema v27 关闭缺少双轮原文与覆盖补救能力的旧事项，并按原批次整体重跑', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v26-review-recovery-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-19T15:00:00Z') });
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const firstSource = store.putSourceObject({ bytes: Buffer.from('虚构甲状腺资料'), mediaType: 'text/plain', displayName: '甲状腺.txt' });
    const secondSource = store.putSourceObject({ bytes: Buffer.from('虚构多页资料'), mediaType: 'text/plain', displayName: '多页.txt' });
    const firstDocument = store.registerImportedDocument({ sourceObjectId: firstSource.id, personId: person.id });
    const secondDocument = store.registerImportedDocument({ sourceObjectId: secondSource.id, personId: person.id });
    const documentIds = [firstDocument.documentId, secondDocument.documentId];
    const consentId = store.createManualProcessingConsent({
      documentIds, personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-19T15:00:00Z',
      groups: [{ personId: person.id, documentIds, inputSignature: 'f'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const candidate = {
      localKey: 'thyroid-site', originalName: '甲状腺彩超', standardNameCandidate: null,
      value: { kind: 'text' as const, rawText: '未见异常' }, unitRaw: null, referenceRangeRaw: null,
      reportedAbnormalFlag: null, specimen: null, method: '超声', bodySite: '甲状腺实质', clinicalDate: null,
      evidence: [{ sourceSpanId: 'span-1', quote: '甲状腺实质' }], issues: []
    };
    store.saveExtractionReviewIssue({
      documentId: firstDocument.documentId, kind: 'field_conflict', severity: 'blocking', evidenceRefs: ['span-1'],
      candidateOptions: [candidate],
      candidateDiffs: [{ localKey: candidate.localKey, itemName: candidate.originalName, fields: ['bodySite'] }],
      reasonCodes: ['INDEPENDENT_REVIEW_MISMATCH']
    });
    store.saveExtractionReviewIssue({
      documentId: secondDocument.documentId, kind: 'coverage_gap', severity: 'blocking', evidenceRefs: ['span-2'],
      reasonCodes: ['EXTRACTION_COVERAGE_INCOMPLETE']
    });
    store.finishJob(job.id, 'waiting_user');
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`UPDATE workspaces SET schema_version = 26; PRAGMA user_version = 26;`);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-19T15:01:00Z') });
    expect(store.listOpenExtractionReviewIssues()).toEqual([]);
    expect(store.listReadyDocuments()).toEqual(expect.arrayContaining([
      { id: firstDocument.documentId, personId: person.id },
      { id: secondDocument.documentId, personId: person.id }
    ]));
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'queued', stage: 'extract', completedUnits: 0, totalUnits: 2 });
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(WORKSPACE_SCHEMA_VERSION);
    const checkpoint = JSON.parse((upgraded.prepare('SELECT checkpoint_json FROM jobs WHERE id = ?').get(job.id) as { checkpoint_json: string }).checkpoint_json) as { documentIds: string[] };
    expect(checkpoint.documentIds).toEqual(documentIds);
    upgraded.close();
    store.close();
  });

  it('schema v28 不允许缺少整篇覆盖证明的旧修正事项直接提交', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v27-complete-review-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-20T00:00:00Z') });
    const person = store.createPerson({ displayName: '测试成员' });
    const source = store.putSourceObject({ bytes: Buffer.from('虚构长报告'), mediaType: 'text/plain', displayName: 'long.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-20T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: 'legacy-complete-review' }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const candidate = {
      localKey: 'legacy-value', originalName: '虚构指标', standardNameCandidate: null,
      value: { kind: 'numeric' as const, rawText: '1', decimal: '1', comparator: 'eq' as const },
      unitRaw: null, referenceRangeRaw: null, reportedAbnormalFlag: null,
      specimen: null, method: null, bodySite: null, clinicalDate: null,
      evidence: [{ sourceSpanId: 'span-1', quote: '虚构指标 1' }], issues: []
    };
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      jobId: job.id,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: ['span-1'],
      candidateOptions: [candidate],
      candidateDiffs: [{
        localKey: candidate.localKey,
        itemName: candidate.originalName,
        fields: ['value'],
        firstCandidate: candidate,
        secondCandidate: { ...candidate, value: { kind: 'numeric', rawText: '2', decimal: '2', comparator: 'eq' } }
      }],
      reasonCodes: ['INDEPENDENT_REVIEW_MISMATCH']
    });
    store.finishJob(job.id, 'waiting_user');
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`UPDATE workspaces SET schema_version = 27; PRAGMA user_version = 27;`);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-20T00:01:00Z') });
    expect(store.listOpenExtractionReviewIssues().some((issue) => issue.id === issueId)).toBe(false);
    expect(store.listReadyDocuments()).toContainEqual({ id: document.documentId, personId: person.id });
    expect(store.listStoredJobs()[0]).toMatchObject({ id: job.id, status: 'queued', stage: 'extract', completedUnits: 0 });
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(WORKSPACE_SCHEMA_VERSION);
    upgraded.close();
    store.close();
  });

  it('显示信息与临床上下文使用独立 revision', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '同名成员', relation: '本人' });
    expect(store.updatePersonDisplay({
      personId: person.id,
      displayName: '新昵称',
      relation: '家人',
      birthYear: 1990,
      expectedDisplayRevision: 1
    })).toMatchObject({ displayName: '新昵称', relation: '家人', birthYear: 1990, displayRevision: 2, clinicalContextRevision: 1 });
    expect(() => store.updatePersonDisplay({
      personId: person.id,
      displayName: '迟到昵称',
      relation: '家人',
      birthYear: 1990,
      expectedDisplayRevision: 1
    })).toThrow(RevisionConflictError);
    expect(store.updateClinicalContext(person.id, { allergies: ['虚构过敏史'] }, 1)).toBe(2);
    expect(store.listPersons()[0]).toMatchObject({ displayRevision: 2, clinicalContextRevision: 2 });
    store.close();
  });

  it('成员归档可恢复，并撤回目录授权而不删除历史资料', () => {
    const store = makeStore();
    const inbox = mkdtempSync(join(tmpdir(), 'family-health-archive-inbox-'));
    directories.push(inbox);
    const person = store.createPerson({ displayName: '待归档成员', relation: '家人' });
    const source = store.putSourceObject({ bytes: Buffer.from('纯虚构历史报告'), mediaType: 'text/plain', displayName: '历史报告.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.createInboxBinding({
      canonicalPath: inbox,
      personId: person.id,
      recursive: true,
      allowScheduledAiProcessing: true,
      accountFingerprint: 'f'.repeat(64),
      consentVersion: 1
    });

    const archived = store.archivePerson({ personId: person.id, expectedDisplayRevision: 1 });
    expect(archived).toMatchObject({ archivedAt: '2026-09-18T00:00:00.000Z', displayRevision: 2 });
    expect(store.listActiveInboxBindings()).toEqual([]);
    expect(store.listReadyDocuments()).toEqual([]);
    expect(store.listImportedDocuments()).toEqual([expect.objectContaining({ id: document.documentId, status: 'ignored' })]);

    const restored = store.restorePerson({ personId: person.id, expectedDisplayRevision: 2 });
    expect(restored).toMatchObject({ archivedAt: null, displayRevision: 3, clinicalContextRevision: 0 });
    expect(store.listActiveInboxBindings()).toEqual([]);
    expect(readFileSync(join(store.vaultDirectory, source.vaultRelativePath)).toString('utf8')).toBe('纯虚构历史报告');
    store.close();
  });

  it('恢复到新设备时清除旧路径并暂停目录授权和自动任务', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '恢复测试成员', relation: '本人' });
    const source = store.putSourceObject({ bytes: Buffer.from('纯虚构恢复资料'), mediaType: 'text/plain', displayName: '恢复资料.txt' });
    const binding = store.createInboxBinding({
      canonicalPath: '/Users/example/Health Inbox',
      personId: person.id,
      recursive: true,
      allowScheduledAiProcessing: true,
      accountFingerprint: 'a'.repeat(64),
      consentVersion: 1
    });
    store.registerSourceOccurrence({
      sourceObjectId: source.id,
      bindingId: binding.id,
      originalPath: '/Users/example/Health Inbox/恢复资料.txt',
      displayName: '恢复资料.txt'
    });
    store.updateSchedule({
      enabled: true,
      localTime: '20:00',
      timeZone: 'Asia/Shanghai',
      nextRunUtc: '2026-09-18T12:00:00Z',
      expectedRevision: 0
    });

    expect(store.sanitizeRestoredMachineState()).toMatchObject({
      disabledBindingCount: 1,
      revokedConsentCount: 1,
      pausedScheduleCount: 1
    });
    expect(store.listActiveInboxBindings()).toEqual([]);
    expect(store.getOrCreateSchedule('Asia/Shanghai', null)).toMatchObject({ enabled: false, nextRunUtc: null });
    const databasePath = store.databasePath;
    store.close();

    const database = new Database(databasePath, { readonly: true });
    expect(database.prepare('SELECT canonical_path, enabled FROM inbox_bindings').get()).toEqual({
      canonical_path: `restored://inbox/${binding.id}`,
      enabled: 0
    });
    expect(database.prepare('SELECT original_path FROM source_occurrences').get()).toEqual({
      original_path: expect.stringMatching(/^restored:\/\/source\//)
    });
    expect(database.prepare('SELECT revoked_at, account_fingerprint FROM consents').get()).toMatchObject({
      revoked_at: '2026-09-18T00:00:00.000Z',
      account_fingerprint: null
    });
    database.close();
  });

  it('资料移出分析后保留抑制记录，并可重新纳入待处理队列', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const source = store.putSourceObject({ bytes: Buffer.from('纯虚构待移出报告'), mediaType: 'text/plain', displayName: '待移出.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    expect(store.listReadyDocuments()).toEqual([{ id: document.documentId, personId: person.id }]);

    expect(store.setDocumentIncluded({ documentId: document.documentId, included: false })).toEqual({ included: false, personId: person.id });
    expect(store.listImportedDocuments()).toEqual([expect.objectContaining({ id: document.documentId, status: 'ignored' })]);
    expect(store.listReadyDocuments()).toEqual([]);
    expect(store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id })).toMatchObject({ duplicate: true });

    expect(store.setDocumentIncluded({ documentId: document.documentId, included: true })).toEqual({ included: true, personId: person.id });
    expect(store.listImportedDocuments()).toEqual([expect.objectContaining({ id: document.documentId, status: 'queued' })]);
    expect(store.listReadyDocuments()).toEqual([{ id: document.documentId, personId: person.id }]);
    expect(store.getFactRevision(person.id)).toBe(2);
    store.close();
  });

  it('V3 综合随上下文、待核对范围和事实版本变化同事务失效', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '合成成员', relation: '本人' });
    const source = store.putSourceObject({ bytes: Buffer.from('合成资料'), mediaType: 'text/plain', displayName: '合成.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });

    store.publishMemberAssessmentSnapshot({ snapshot: syntheticAssessmentSnapshot(store, person.id, 'context') });
    expect(store.listMemberAssessmentSnapshots(person.id, true)).toHaveLength(1);
    store.updateClinicalContext(person.id, { synthetic: 'new-context' }, 0);
    expect(store.listMemberAssessmentSnapshots(person.id, true)).toEqual([]);
    expect(store.listMemberAssessmentSnapshots(person.id)[0]?.status).toBe('stale');

    store.publishMemberAssessmentSnapshot({ snapshot: syntheticAssessmentSnapshot(store, person.id, 'review') });
    const current = store.listMemberAssessmentSnapshots(person.id, true)[0]!;
    const factRevision = store.getFactRevision(person.id);
    store.saveExtractionReviewIssue({
      documentId: document.documentId, kind: 'coverage_gap', severity: 'warning',
      preserveDocumentStatus: true, evidenceRefs: [], reasonCodes: ['SYNTHETIC_GAP']
    });
    expect(store.getFactRevision(person.id)).toBe(factRevision);
    expect(store.listMemberAssessmentSnapshots(person.id, true)).toEqual([]);
    expect(() => store.adoptMemberAssessmentAction({
      personId: person.id, snapshotId: current.id, actionId: 'action-followup'
    })).toThrow('MEMBER_ASSESSMENT_ACTION_STALE');

    store.publishMemberAssessmentSnapshot({ snapshot: syntheticAssessmentSnapshot(store, person.id, 'fact') });
    expect(store.listMemberAssessmentSnapshots(person.id, true)).toHaveLength(1);
    store.setDocumentIncluded({ documentId: document.documentId, included: false });
    expect(store.listMemberAssessmentSnapshots(person.id, true)).toEqual([]);
    expect(store.listMemberAssessmentSnapshots(person.id).every((snapshot) => snapshot.status === 'stale')).toBe(true);
    store.close();
  });

  it('currentOnly 再核对实际版本，拒绝错误标记为 current 的旧综合', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '合成成员', relation: '本人' });
    store.publishMemberAssessmentSnapshot({ snapshot: syntheticAssessmentSnapshot(store, person.id, 'legacy-current') });
    const database = new Database(store.databasePath);
    database.prepare(`INSERT INTO person_revisions (person_id, fact_revision) VALUES (?, 1)`).run(person.id);
    database.close();
    expect(store.listMemberAssessmentSnapshots(person.id)[0]?.status).toBe('current');
    expect(store.listMemberAssessmentSnapshots(person.id, true)).toEqual([]);
    store.close();
  });

  it('V3 写库边界拒绝坏 schema、悬空引用和仍在正文中的 held 节点', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '合成成员', relation: '本人' });
    const base = syntheticAssessmentSnapshot(store, person.id, 'write-gate');
    expect(() => store.publishMemberAssessmentSnapshot({ snapshot: {
      ...base, schemaVersion: 4
    } as unknown as typeof base })).toThrow('MEMBER_ASSESSMENT_SCHEMA_INVALID');
    expect(() => store.publishMemberAssessmentSnapshot({ snapshot: {
      ...base, overview: { ...base.overview, actionIds: ['missing-action'] }
    } })).toThrow('MEMBER_ASSESSMENT_REFERENCE_INVALID');
    expect(() => store.publishMemberAssessmentSnapshot({ snapshot: {
      ...base, heldTargetIds: ['action-followup']
    } })).toThrow('MEMBER_ASSESSMENT_HELD_OR_DUPLICATE_NODE');
    expect(() => store.publishMemberAssessmentSnapshot({ snapshot: {
      ...base, actions: [{ ...base.actions[0]!, evidenceIds: ['missing-evidence'] }]
    } })).toThrow('MEMBER_ASSESSMENT_REFERENCE_INVALID');
    expect(store.listMemberAssessmentSnapshots(person.id)).toEqual([]);
    store.close();
  });

  it('V3 私有核查保留未发布原节点和真实回执，但不能凭此复活行动', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '合成成员', relation: '本人' });
    const snapshot = syntheticAssessmentSnapshot(store, person.id, 'review-audit');
    const original = { nodeType: 'action' as const, value: { ...snapshot.actions[0]!, id: 'held-action', firstStep: '合成未发布原行动。' } };
    const body = { targetId: 'held-action', phase: 'p04' as const, original, replacement: null,
      modelDecision: { verdict: 'hold' as const, reason: '合成来源不能支持该安排。' },
      receipt: { stage: 'p04' as const, threadId: 'synthetic-thread', turnId: 'synthetic-turn', outputHash: 'a'.repeat(64) },
      origin: 'model' as const, outcome: 'held' as const, localReasonCodes: ['reviewer_hold'],
      boundEvidenceIds: [], unboundEvidenceIds: [], boundObservationIds: [], unboundObservationIds: [] };
    snapshot.heldTargetIds = ['held-action'];
    snapshot.reviewAuditRecords = { version: 1, personId: person.id, inputSignature: snapshot.inputSignature,
      records: [{ ...body, recordHash: stableHash(body) }] };
    const published = store.publishMemberAssessmentSnapshot({ snapshot });
    const loaded = store.listMemberAssessmentSnapshots(person.id, true)[0]!;
    expect(loaded.reviewAuditRecords).toEqual(snapshot.reviewAuditRecords);
    expect(loaded.actions).toEqual(snapshot.actions);
    expect(() => store.adoptMemberAssessmentAction({ personId: person.id, snapshotId: published.snapshotId, actionId: 'held-action' }))
      .toThrow();
    store.close();
  });

  it.each(['person', 'signature', 'target', 'state', 'source', 'hash', 'missing_target'])(
    'V3 写库拒绝私有审计错绑或伪造 %s', (mode) => {
      const store = makeStore();
      const person = store.createPerson({ displayName: '合成成员', relation: '本人' });
      const snapshot = syntheticAssessmentSnapshot(store, person.id, `audit-invalid-${mode}`);
      const body = { targetId: 'held-action', phase: 'p04' as const,
        original: { nodeType: 'action' as const, value: { ...snapshot.actions[0]!, id: 'held-action' } }, replacement: null,
        modelDecision: { verdict: 'hold' as const, reason: '合成依据不足。' },
        receipt: { stage: 'p04' as const, threadId: 'synthetic-thread', turnId: 'synthetic-turn', outputHash: 'a'.repeat(64) },
        origin: 'model' as const, outcome: 'held' as const, localReasonCodes: ['reviewer_hold'],
        boundEvidenceIds: [] as string[], unboundEvidenceIds: [], boundObservationIds: [], unboundObservationIds: [] };
      snapshot.heldTargetIds = ['held-action'];
      snapshot.reviewAuditRecords = { version: 1, personId: person.id, inputSignature: snapshot.inputSignature,
        records: [{ ...body, recordHash: stableHash(body) }] };
      if (mode === 'person') snapshot.reviewAuditRecords.personId = 'other-member';
      if (mode === 'signature') snapshot.reviewAuditRecords.inputSignature = 'b'.repeat(64);
      if (mode === 'target') snapshot.reviewAuditRecords.records[0]!.original.value.id = 'unrelated';
      if (mode === 'state') snapshot.reviewAuditRecords.records[0]!.outcome = 'rebuilt';
      if (mode === 'source') snapshot.reviewAuditRecords.records[0]!.boundEvidenceIds = ['foreign-source'];
      if (mode === 'hash') snapshot.reviewAuditRecords.records[0]!.modelDecision!.reason = '被篡改的理由';
      if (mode === 'missing_target') snapshot.reviewAuditRecords.records = [];
      expect(() => store.publishMemberAssessmentSnapshot({ snapshot })).toThrow('MEMBER_ASSESSMENT_REVIEW_AUDIT_INVALID');
      expect(store.listMemberAssessmentSnapshots(person.id)).toEqual([]);
      store.close();
    });

  it('分块提取检查点可跨失败重启复用，但签名或授权改变后不得复用', () => {
    const store = makeStore();
    const rootDirectory = store.rootDirectory;
    const person = store.createPerson({ displayName: '合成成员', relation: '本人' });
    const source = store.putSourceObject({ bytes: Buffer.from('纯合成分块资料'), mediaType: 'text/plain', displayName: '合成.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const accountFingerprint = 'synthetic-account';
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint, version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z', initialStatus: 'queued', consentId,
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: 'chunk-restart-test' }]
    });
    const job = store.claimNextQueuedJob('synthetic-runner', accountFingerprint)!;
    const attemptId = store.startJobAttempt(job.id, 'synthetic-runtime');
    const guard = { jobId: job.id, attemptId, consentId, accountFingerprint };
    const signature = createHash('sha256').update('source+span+prompt+rules').digest('hex');
    store.saveExtractionChunkCheckpoint({
      guard, documentId: document.documentId, signature, chunkIndex: 0,
      output: { synthetic: 'SYNTHETIC_CHUNK_BODY' }, threadId: 'thread-1',
      turnId: 'turn-1', extractionTurnId: 'turn-1'
    });
    expect(store.getExtractionChunkCheckpoint(guard, document.documentId, signature)).toMatchObject({
      output: { synthetic: 'SYNTHETIC_CHUNK_BODY' }, extractionTurnId: 'turn-1'
    });
    store.finishJobAttempt({ attemptId, status: 'failed' });
    store.finishJob(job.id, 'failed');
    store.close();

    const restored = new WorkspaceStore({ rootDirectory, now: () => new Date('2026-09-18T00:00:00Z') });
    restored.retryFailedJob(job.id);
    expect(restored.claimNextQueuedJob('synthetic-retry', accountFingerprint)?.id).toBe(job.id);
    const retryAttemptId = restored.startJobAttempt(job.id, 'synthetic-runtime');
    const retryGuard = { ...guard, attemptId: retryAttemptId };
    expect(restored.getExtractionChunkCheckpoint(retryGuard, document.documentId, signature)?.output)
      .toEqual({ synthetic: 'SYNTHETIC_CHUNK_BODY' });
    expect(restored.getExtractionChunkCheckpoint(retryGuard, document.documentId, '0'.repeat(64))).toBeNull();
    restored.finishJobAttempt({ attemptId: retryAttemptId, status: 'failed' });
    restored.finishJob(job.id, 'failed');

    const newConsentId = restored.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint, version: 2
    });
    const database = new Database(restored.databasePath);
    database.prepare(`UPDATE jobs SET checkpoint_json = json_set(checkpoint_json, '$.consentId', ?) WHERE id = ?`)
      .run(newConsentId, job.id);
    database.close();
    restored.retryFailedJob(job.id);
    expect(restored.claimNextQueuedJob('synthetic-new-consent', accountFingerprint)?.id).toBe(job.id);
    const newAttemptId = restored.startJobAttempt(job.id, 'synthetic-runtime');
    const newGuard = { jobId: job.id, attemptId: newAttemptId, consentId: newConsentId, accountFingerprint };
    expect(restored.getExtractionChunkCheckpoint(newGuard, document.documentId, signature)).toBeNull();
    restored.clearExtractionChunkCheckpoints(newGuard, document.documentId);
    expect(restored.getExtractionChunkCheckpoint(newGuard, document.documentId, signature)).toBeNull();
    restored.saveExtractionChunkCheckpoint({
      guard: newGuard, documentId: document.documentId, signature, chunkIndex: 0,
      output: { synthetic: 'NEW_CONSENT_CHUNK_BODY' }, threadId: 'thread-2',
      turnId: 'turn-2', extractionTurnId: 'turn-2'
    });
    restored.revokeConsent(newConsentId);
    expect(() => restored.getExtractionChunkCheckpoint(newGuard, document.documentId, signature))
      .toThrow('CONSENT_REVOKED');
    const revokedDatabase = new Database(restored.databasePath, { readonly: true });
    const revokedCheckpoint = revokedDatabase.prepare(`SELECT checkpoint_json FROM jobs WHERE id = ?`)
      .get(job.id) as { checkpoint_json: string };
    expect(revokedCheckpoint.checkpoint_json).not.toContain('NEW_CONSENT_CHUNK_BODY');
    revokedDatabase.close();
    restored.finishJobAttempt({ attemptId: newAttemptId, status: 'cancelled' });
    restored.finishJob(job.id, 'cancelled');
    restored.close();
  });

  it('永久删除报告会清除失败任务检查点中的该报告分块原文', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '合成成员', relation: '本人' });
    const source = store.putSourceObject({ bytes: Buffer.from('纯合成待删除资料'), mediaType: 'text/plain', displayName: '待删除.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const accountFingerprint = 'synthetic-account';
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint, version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z', initialStatus: 'queued', consentId,
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: 'chunk-delete-test' }]
    });
    const job = store.claimNextQueuedJob('synthetic-runner', accountFingerprint)!;
    const attemptId = store.startJobAttempt(job.id, 'synthetic-runtime');
    store.saveExtractionChunkCheckpoint({
      guard: { jobId: job.id, attemptId, consentId, accountFingerprint },
      documentId: document.documentId, signature: '1'.repeat(64), chunkIndex: 0,
      output: { synthetic: 'SYNTHETIC_SENSITIVE_CHUNK' }, threadId: 'thread-1',
      turnId: 'turn-1', extractionTurnId: 'turn-1'
    });
    store.finishJobAttempt({ attemptId, status: 'failed' });
    store.finishJob(job.id, 'failed');
    store.deleteDocument({ documentId: document.documentId, retainedByRecoveryPoint: false });
    const database = new Database(store.databasePath, { readonly: true });
    const checkpoint = database.prepare(`SELECT checkpoint_json FROM jobs WHERE id = ?`)
      .get(job.id) as { checkpoint_json: string };
    expect(checkpoint.checkpoint_json).toContain(document.documentId);
    expect(checkpoint.checkpoint_json).not.toContain('SYNTHETIC_SENSITIVE_CHUNK');
    expect(checkpoint.checkpoint_json).not.toContain('extractionChunks');
    database.close();
    store.close();
  });

  it.each(['proposed', 'discussed', 'planned', 'in_progress', 'paused', 'completed'] as const)(
    '综合沿用本人已有事项 ID 时重复采纳保留 $0 状态、来源、正文和个人安排', (status) => {
      const store = makeStore();
      const person = store.createPerson({ displayName: '合成已有计划成员' });
      const original = store.createUserAction({ personId: person.id, title: '本人安排的坐位休息',
        detail: '本人记录：每次先休息，感到不适就停止。', dueDate: '2026-10-20', dueText: '本人原定时间' });
      const scheduled = store.updateActionSchedule({ personId: person.id, actionId: original.id,
        dueDate: '2026-10-21', userScheduleText: '晚饭后由家人提醒', expectedRevision: original.userRevision });
      const existing = store.updateActionStatus({ actionId: original.id, status, expectedRevision: scheduled.userRevision });
      const snapshot = syntheticAssessmentSnapshot(store, person.id, `existing-${status}`);
      snapshot.actions[0] = { ...snapshot.actions[0]!, id: existing.id, title: '综合中改写的标题',
        why: '综合中的新说明', firstStep: '综合中重新写的第一步', timing: '综合中建议的时间' };
      snapshot.overview.actionIds = [existing.id];
      const published = store.publishMemberAssessmentSnapshot({ snapshot });
      const input = { personId: person.id, snapshotId: published.snapshotId, actionId: existing.id };
      const database = new Database(store.databasePath, { readonly: true });
      const originalRow = database.prepare('SELECT * FROM action_items WHERE id = ?').get(existing.id);
      const originalEvents = database.prepare('SELECT * FROM action_events WHERE action_id = ? ORDER BY id').all(existing.id);
      expect(store.listAdoptedMemberAssessmentActions(person.id)).toEqual([]);
      expect(store.adoptMemberAssessmentAction(input)).toEqual(existing);
      expect(store.adoptMemberAssessmentAction(input)).toEqual(existing);
      expect(store.listActionItems(person.id)).toEqual([existing]);
      expect(store.listAdoptedMemberAssessmentActions(person.id)).toEqual([]);
      expect(database.prepare('SELECT * FROM action_items WHERE id = ?').get(existing.id)).toEqual(originalRow);
      expect(database.prepare('SELECT * FROM action_events WHERE action_id = ? ORDER BY id').all(existing.id)).toEqual(originalEvents);
      database.close();
      store.close();
    }
  );

  it('综合采纳只按本人成员的精确事项 ID 复用，不按标题匹配或跨成员复用', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '合成成员甲' });
    const other = store.createPerson({ displayName: '合成成员乙' });
    const own = store.createUserAction({ personId: person.id, title: '同名行动', detail: '甲的原安排', dueDate: null, dueText: null });
    const foreign = store.createUserAction({ personId: other.id, title: '同名行动', detail: '乙的原安排', dueDate: null, dueText: null });
    const snapshot = syntheticAssessmentSnapshot(store, person.id, 'member-scoped-id');
    snapshot.actions[0] = { ...snapshot.actions[0]!, id: foreign.id, title: own.title };
    snapshot.overview.actionIds = [foreign.id];
    const published = store.publishMemberAssessmentSnapshot({ snapshot });
    const adopted = store.adoptMemberAssessmentAction({ personId: person.id, snapshotId: published.snapshotId, actionId: foreign.id });
    expect(adopted).toMatchObject({ personId: person.id, origin: 'ai_proposed', title: own.title });
    expect(adopted.id).not.toBe(own.id);
    expect(adopted.id).not.toBe(foreign.id);
    expect(store.listActionItems(person.id)).toHaveLength(2);
    expect(store.listActionItems(person.id)).toContainEqual(own);
    expect(store.listActionItems(other.id)).toEqual([foreign]);
    store.close();
  });

  it('综合沿用本人已撤回事项 ID 时允许另建采纳项，不复活或覆盖原事项', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '合成撤回成员' });
    const original = store.createUserAction({ personId: person.id, title: '本人撤回的计划', detail: '本人原说明',
      dueDate: '2026-10-20', dueText: '本人原时间' });
    const dismissed = store.updateActionStatus({ actionId: original.id, status: 'dismissed', expectedRevision: original.userRevision });
    const snapshot = syntheticAssessmentSnapshot(store, person.id, 'dismissed-existing-id');
    snapshot.actions[0] = { ...snapshot.actions[0]!, id: original.id };
    snapshot.overview.actionIds = [original.id];
    const published = store.publishMemberAssessmentSnapshot({ snapshot });
    const input = { personId: person.id, snapshotId: published.snapshotId, actionId: original.id };
    const adopted = store.adoptMemberAssessmentAction(input);
    expect(adopted.id).not.toBe(original.id);
    expect(adopted.status).toBe('planned');
    expect(store.listActionItems(person.id)).toContainEqual(dismissed);
    expect(store.listActionItems(person.id)).toHaveLength(2);
    expect(store.adoptMemberAssessmentAction(input)).toEqual(adopted);
    store.close();
  });

  it('本人已有同 ID 事项仍不能从过期综合或已隔离节点采纳', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '合成范围门禁成员' });
    const original = store.createUserAction({ personId: person.id, title: '本人已有事项', detail: '原说明', dueDate: null, dueText: null });
    const snapshot = syntheticAssessmentSnapshot(store, person.id, 'existing-id-guard');
    snapshot.actions[0] = { ...snapshot.actions[0]!, id: original.id };
    snapshot.overview.actionIds = [original.id];
    const published = store.publishMemberAssessmentSnapshot({ snapshot });
    const input = { personId: person.id, snapshotId: published.snapshotId, actionId: original.id };
    const database = new Database(store.databasePath);
    database.prepare(`UPDATE member_assessment_snapshots_v3 SET payload_json = json_set(payload_json, '$.heldTargetIds', json(?)) WHERE id = ?`)
      .run(JSON.stringify([original.id]), published.snapshotId);
    expect(() => store.adoptMemberAssessmentAction(input)).toThrow('MEMBER_ASSESSMENT_ACTION_NOT_AVAILABLE');
    database.close();
    store.updateClinicalContext(person.id, { synthetic: 'new-context' }, 0);
    expect(() => store.adoptMemberAssessmentAction(input)).toThrow('MEMBER_ASSESSMENT_ACTION_STALE');
    expect(store.listActionItems(person.id)).toEqual([original]);
    store.close();
  });

  it.each(['valid', 'unreviewed', 'local_only', 'wrong_observation', 'partial_raw', 'no_date', 'forged_quote'] as const)(
    '经P04核验原句计划%s仍须当前同成员同原件事实及真实日期', (mode) => {
      const store = makeStore();
      const rawText = '医生安排：若合成不适持续，四周之后到合成门诊评估。没有新不适时无需自行提前检查。';
      const { person, snapshot } = documentedPlanFixture(store, { rawText, quote: `合成栏目。${rawText}`,
        ...(mode === 'no_date' ? { clinicalDate: null } : {}) });
      const fact = store.listAcceptedObservations(person.id)[0]!;
      const proposal = snapshot.actions[0]!;
      proposal.sourceInstructionObservationId = mode === 'wrong_observation' ? 'other-observation' : fact.id;
      proposal.firstStep = mode === 'partial_raw' ? rawText.split('。')[0]! : rawText;
      proposal.timing = null; proposal.timingBasis = 'none';
      snapshot.validationMode = mode === 'local_only' ? 'local_only' : 'local_and_focused_review';
      snapshot.reviewedTargetIds = mode === 'unreviewed' ? [] : [proposal.id];
      if (mode === 'forged_quote') snapshot.evidenceCatalog[0]!.quote = `${rawText}伪造的附加安排。`;
      const published = store.publishMemberAssessmentSnapshot({ snapshot });
      const adopted = store.adoptMemberAssessmentAction({ personId: person.id, snapshotId: published.snapshotId, actionId: proposal.id });
      expect(adopted.origin).toBe(mode === 'valid' ? 'clinician_document' : 'ai_proposed');
      expect(store.listAdoptedMemberAssessmentActions(person.id)[0]!.sourceDate).toBe(mode === 'valid' ? '2026-08-28' : null);
      expect(proposal.firstStep).toBe(mode === 'partial_raw' ? rawText.split('。')[0]! : rawText);
      store.close();
    });

  it('采纳原医嘱保留临床来源与节点引用，重复、完成进度和撤回后重新采纳均正确', () => {
    const store = makeStore();
    const { person, snapshot } = documentedPlanFixture(store);
    const published = store.publishMemberAssessmentSnapshot({ snapshot });
    const input = { personId: person.id, snapshotId: published.snapshotId, actionId: snapshot.actions[0]!.id };
    const action = store.adoptMemberAssessmentAction(input);
    expect(action).toMatchObject({ origin: 'clinician_document', dueDate: null, dueText: '3个月后', status: 'planned' });
    expect(action.evidenceLabel).toContain('2026-08-28');
    expect(action.evidenceLabel).toContain('报告中的医生建议');
    expect(store.listAdoptedMemberAssessmentActions(person.id)).toMatchObject([{
      action: { id: action.id, origin: 'clinician_document' }, sourceAssessmentId: published.snapshotId,
      sourceActionId: snapshot.actions[0]!.id, sourceDate: '2026-08-28', evidenceRefs: snapshot.evidenceCatalog
    }]);
    expect(store.adoptMemberAssessmentAction(input).id).toBe(action.id);
    const completed = store.updateActionStatus({ actionId: action.id, status: 'completed', expectedRevision: action.userRevision });
    expect(store.adoptMemberAssessmentAction(input)).toMatchObject({ id: action.id, status: 'completed', origin: 'clinician_document' });
    store.updateActionStatus({ actionId: action.id, status: 'dismissed', expectedRevision: completed.userRevision });
    const readopted = store.adoptMemberAssessmentAction(input);
    expect(readopted.id).not.toBe(action.id);
    expect(readopted.origin).toBe('clinician_document');
    expect(store.listAdoptedMemberAssessmentActions(person.id)).toHaveLength(2);
    expect(store.adoptMemberAssessmentAction(input).id).toBe(readopted.id);
    const database = new Database(store.databasePath, { readonly: true });
    const stored = database.prepare('SELECT source_ref FROM action_items WHERE id = ?').get(action.id) as { source_ref: string };
    expect(JSON.parse(stored.source_ref.slice('assessment-v3:'.length))).toMatchObject({
      snapshotId: published.snapshotId, actionId: snapshot.actions[0]!.id,
      sourceDate: '2026-08-28', evidenceRefs: snapshot.evidenceCatalog
    });
    database.close();
    store.close();
  });

  it.each([
    { label: '没有临床日期', options: { clinicalDate: null } },
    { label: '只有普通数值', options: { quote: '2026-08-28 TSH 2.1 mIU/L，无需额外安排。' } },
    { label: '引用中伪造医生安排', options: { quote: '2026-08-28 TSH 2.1 mIU/L。',
      evidenceQuote: '2026-08-28 医生建议：3个月后复查甲状腺功能。' } }
  ])('$label 不能仅凭 documented_plan 枚举升级医生来源', ({ options }) => {
    const store = makeStore();
    const { person, snapshot } = documentedPlanFixture(store, options);
    const published = store.publishMemberAssessmentSnapshot({ snapshot });
    const action = store.adoptMemberAssessmentAction({ personId: person.id,
      snapshotId: published.snapshotId, actionId: snapshot.actions[0]!.id });
    expect(action.origin).toBe('ai_proposed');
    expect(action.evidenceLabel).not.toContain('报告中的医生建议');
    expect(store.listAdoptedMemberAssessmentActions(person.id)[0]!.sourceDate).toBeNull();
    expect(store.listAdoptedMemberAssessmentActions(person.id)[0]!.evidenceRefs).toEqual(snapshot.evidenceCatalog);
    store.close();
  });

  it.each([{ value: '2026-08', precision: 'month' as const }, { value: '2026', precision: 'year' as const }])(
    '原医嘱的 $precision 日期精度保持不变，不由采纳日期补齐或重新起算', ({ value, precision }) => {
      const store = makeStore();
      const { person, snapshot } = documentedPlanFixture(store, { clinicalDate: null,
        quote: `${value} 医生建议：3个月后复查甲状腺功能。`, metadataDate: value, metadataPrecision: precision });
      const published = store.publishMemberAssessmentSnapshot({ snapshot });
      const action = store.adoptMemberAssessmentAction({ personId: person.id,
        snapshotId: published.snapshotId, actionId: snapshot.actions[0]!.id });
      expect(action).toMatchObject({ origin: 'clinician_document', dueDate: null, dueText: '3个月后' });
      expect(store.listAdoptedMemberAssessmentActions(person.id)[0]!.sourceDate).toBe(value);
      expect(action.evidenceLabel).toContain(value);
      store.close();
    }
  );

  it('旧采纳 JSON 没有日期或完整引用时仍可读取与去重，不会改写其来源', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '合成旧行动成员', relation: '本人' });
    const snapshot = syntheticAssessmentSnapshot(store, person.id, 'legacy-action');
    const published = store.publishMemberAssessmentSnapshot({ snapshot });
    const input = { personId: person.id, snapshotId: published.snapshotId, actionId: snapshot.actions[0]!.id };
    const action = store.adoptMemberAssessmentAction(input);
    const database = new Database(store.databasePath);
    database.prepare('UPDATE action_items SET source_ref = ? WHERE id = ?').run(`assessment-v3:${JSON.stringify({
      snapshotId: published.snapshotId, actionId: snapshot.actions[0]!.id, dedupeKey: snapshot.actions[0]!.dedupeKey
    })}`, action.id);
    database.close();
    expect(store.listAdoptedMemberAssessmentActions(person.id)).toMatchObject([{
      action: { id: action.id, origin: 'ai_proposed' }, evidenceRefs: [], sourceDate: null
    }]);
    expect(store.adoptMemberAssessmentAction(input).id).toBe(action.id);
    store.close();
  });

  it('删除报告也会清除以 clinician_document 采纳的 V3 行动与完整来源', () => {
    const store = makeStore();
    const { person, document, snapshot } = documentedPlanFixture(store);
    const published = store.publishMemberAssessmentSnapshot({ snapshot });
    const action = store.adoptMemberAssessmentAction({ personId: person.id,
      snapshotId: published.snapshotId, actionId: snapshot.actions[0]!.id });
    expect(action.origin).toBe('clinician_document');
    store.deleteDocument({ documentId: document.documentId, retainedByRecoveryPoint: false });
    expect(store.listAdoptedMemberAssessmentActions(person.id)).toEqual([]);
    expect(store.listActionItems(person.id)).toEqual([]);
    expect(store.integrityCheck()).toBe('ok');
    store.close();
  });

  it('永久删除一份资料时清除该成员全部 V3 正文和从 V3 采纳的行动，但保留本人事项', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '合成成员', relation: '本人' });
    const source = store.putSourceObject({ bytes: Buffer.from('合成报告中不应残留的正文'), mediaType: 'text/plain', displayName: '待删除.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const published = store.publishMemberAssessmentSnapshot({ snapshot: syntheticAssessmentSnapshot(store, person.id, 'sensitive-body') });
    const adopted = store.adoptMemberAssessmentAction({
      personId: person.id, snapshotId: published.snapshotId, actionId: 'action-followup'
    });
    const personal = store.createUserAction({
      personId: person.id, title: '本人独立事项', detail: '这段由本人写入', dueDate: null, dueText: null
    });
    expect(store.listMemberAssessmentSnapshots(person.id)).toHaveLength(1);
    expect(store.listActionItems(person.id).map((item) => item.id)).toContain(adopted.id);

    store.deleteDocument({ documentId: document.documentId, retainedByRecoveryPoint: false });
    expect(store.listMemberAssessmentSnapshots(person.id)).toEqual([]);
    expect(store.listActionItems(person.id)).toEqual([expect.objectContaining({ id: personal.id, title: '本人独立事项' })]);
    const database = new Database(store.databasePath, { readonly: true });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM member_assessment_snapshots_v3 WHERE person_id = ?`).get(person.id))
      .toEqual({ count: 0 });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM action_items WHERE id = ?`).get(adopted.id)).toEqual({ count: 0 });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM action_events WHERE action_id = ?`).get(adopted.id)).toEqual({ count: 0 });
    database.close();
    expect(store.integrityCheck()).toBe('ok');
    store.close();
  });

  it('已提交事实的资料重新纳入时保持已完成，不会留下无法消失的待处理状态', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const source = store.putSourceObject({ bytes: Buffer.from('纯虚构已提交报告'), mediaType: 'text/plain', displayName: '已提交.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.publishFacts({
      personId: person.id,
      documentId: document.documentId,
      documentCommitKey: 'a'.repeat(64),
      expectedRevision: 0,
      changeSetHash: 'b'.repeat(64),
      summary: '虚构零观察提交',
      observations: []
    });

    store.setDocumentIncluded({ documentId: document.documentId, included: false });
    expect(store.setDocumentIncluded({ documentId: document.documentId, included: true }))
      .toEqual({ included: true, personId: person.id });
    expect(store.listImportedDocuments()).toEqual([
      expect.objectContaining({ id: document.documentId, status: 'completed' })
    ]);
    expect(store.listReadyDocuments()).toEqual([]);
    store.close();
  });

  it('删除报告会清除当前事实链、删除未共享原件并留下可解除的导入抑制记录', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const bytes = Buffer.from('纯虚构待删除报告\nLDL 3.8 mmol/L');
    const source = store.putSourceObject({ bytes, mediaType: 'text/plain', displayName: '待删除.txt' });
    store.registerSourceOccurrence({ sourceObjectId: source.id, originalPath: '/tmp/待删除.txt', displayName: '待删除.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const spanId = 'span-delete-fixture';
    store.saveSourceManifest({
      id: 'manifest-delete-fixture', sourceObjectId: source.id, sha256: source.sha256,
      mediaType: 'text/plain', originalDisplayName: '待删除.txt', totalUnits: 1,
      coveredUnitIndexes: [0], normalizerVersion: 'test', conversionWarnings: [],
      createdAt: '2026-09-18T00:00:00.000Z',
      spans: [{ id: spanId, documentId: document.documentId, spanKind: 'line', page: null, blockId: null, lineStart: 1, lineEnd: 1, quote: 'LDL 3.8 mmol/L', readability: 'clear' }]
    });
    const acceptanceId = store.saveAcceptanceDecision({
      method: 'auto', actor: 'policy', rulesVersion: 'test', inputSignature: 'input',
      outputHash: 'output', reviewRef: null, decision: 'accept'
    });
    store.publishFacts({
      personId: person.id, documentId: document.documentId, documentCommitKey: 'd'.repeat(64), expectedRevision: 0, changeSetHash: 'e'.repeat(64), summary: '虚构报告事实',
      observations: [{ conceptKey: 'LDL-C', rawText: '3.8', valueKind: 'numeric', decimalValue: '3.8', qualifier: 'eq', unit: 'mmol/L', referenceRange: '0-3.4', clinicalDate: '2026-09-18', abnormalFlag: 'high', documentId: document.documentId, sourceSpanId: spanId, acceptanceId, specimen: null, method: null, bodySite: null, evidence: [{ sourceSpanId: spanId, quote: 'LDL 3.8 mmol/L' }] }]
    });
    expect(store.listAcceptedObservations()).toHaveLength(1);
    const semanticIndexBefore = new Database(store.databasePath, { readonly: true });
    expect(semanticIndexBefore.prepare(`SELECT COUNT(*) AS count FROM report_records`).get()).toEqual({ count: 1 });
    expect(semanticIndexBefore.prepare(`SELECT COUNT(*) AS count FROM health_events_v2`).get()).toEqual({ count: 1 });
    semanticIndexBefore.close();
    const sourcePath = join(store.vaultDirectory, source.vaultRelativePath);
    expect(existsSync(sourcePath)).toBe(true);

    expect(store.deleteDocument({ documentId: document.documentId, retainedByRecoveryPoint: false })).toMatchObject({
      currentWorkspaceRemoved: true, rawObjectDeleted: true, retainedByRecoveryPoint: false
    });
    expect(store.listImportedDocuments()).toEqual([]);
    expect(store.listAcceptedObservations()).toEqual([]);
    const semanticIndexAfter = new Database(store.databasePath, { readonly: true });
    expect(semanticIndexAfter.prepare(`SELECT COUNT(*) AS count FROM report_records`).get()).toEqual({ count: 0 });
    expect(semanticIndexAfter.prepare(`SELECT COUNT(*) AS count FROM health_events_v2`).get()).toEqual({ count: 0 });
    semanticIndexAfter.close();
    expect(existsSync(sourcePath)).toBe(false);
    expect(store.isSourceImportSuppressed(source.sha256)).toBe(true);
    expect(store.listDeletedDocuments()).toEqual([expect.objectContaining({ displayName: '待删除.txt', personId: person.id, rawObjectRetained: false })]);
    store.releaseDeletedDocument(source.sha256);
    expect(store.isSourceImportSuppressed(source.sha256)).toBe(false);
    expect(store.integrityCheck()).toBe('ok');
    store.close();
  });

  it('本人事项持久保存，并用 revision 阻止迟到状态覆盖', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const action = store.createUserAction({
      personId: person.id,
      title: '下次复诊时询问指标变化',
      detail: '带上原始报告，不把本人记录冒充医生意见。',
      dueDate: null,
      dueText: '下次复诊时'
    });
    expect(action).toMatchObject({
      personId: person.id,
      origin: 'user_created',
      status: 'planned',
      evidenceLabel: '用户记录',
      userRevision: 1
    });
    const completed = store.updateActionStatus({ actionId: action.id, status: 'completed', expectedRevision: 1 });
    expect(completed).toMatchObject({ status: 'completed', userRevision: 2 });
    expect(() => store.updateActionStatus({ actionId: action.id, status: 'dismissed', expectedRevision: 1 }))
      .toThrow(RevisionConflictError);
    expect(store.listActionItems(person.id)).toEqual([completed]);
    store.close();
  });

  it('本人补充资料保留 user_reported 来源，并只推进该成员临床上下文 revision', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const other = store.createPerson({ displayName: '其他成员', relation: '家人' });
    const note = store.createManualNote({
      personId: person.id,
      kind: 'self_measurement',
      immutableText: '晨起血压：128/82 mmHg；静坐五分钟后测量',
      effectiveDate: '2026-09-18',
      structuredFields: { measurementName: '晨起血压', value: '128/82', unit: 'mmHg' },
      expectedContextRevision: 0
    });
    expect(note).toMatchObject({
      personId: person.id,
      kind: 'self_measurement',
      sourceKind: 'user_reported',
      revision: 1,
      structuredFields: { measurementName: '晨起血压', value: '128/82', unit: 'mmHg' }
    });
    expect(store.listPersons().find((item) => item.id === person.id)?.clinicalContextRevision).toBe(1);
    expect(store.listPersons().find((item) => item.id === other.id)?.clinicalContextRevision).toBe(0);
    expect(() => store.createManualNote({
      personId: person.id,
      kind: 'free_text',
      immutableText: '迟到的旧界面提交',
      effectiveDate: null,
      structuredFields: {},
      expectedContextRevision: 0
    })).toThrow(RevisionConflictError);
    store.close();
  });

  it('CAS 拒绝迟到发布，幂等键阻止重复提交', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员' });
    const source = store.putSourceObject({ bytes: Buffer.from('幂等测试'), mediaType: 'text/plain', displayName: '幂等.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const source2 = store.putSourceObject({ bytes: Buffer.from('并发测试'), mediaType: 'text/plain', displayName: '并发.txt' });
    const document2 = store.registerImportedDocument({ sourceObjectId: source2.id, personId: person.id });
    const input = {
      personId: person.id,
      documentId: document.documentId,
      documentCommitKey: 'c'.repeat(64),
      expectedRevision: 0,
      changeSetHash: 'a'.repeat(64),
      summary: '虚构资料更新',
      observations: []
    };
    const first = store.publishFacts(input);
    const second = store.publishFacts(input);
    expect(first).toMatchObject({ revision: 1, idempotent: false });
    expect(second).toMatchObject({ revision: 1, idempotent: true });
    expect(() => store.publishFacts({ ...input, documentId: document2.documentId, documentCommitKey: 'f'.repeat(64), changeSetHash: 'b'.repeat(64), expectedRevision: 0 }))
      .toThrow(RevisionConflictError);
    expect(store.integrityCheck()).toBe('ok');
    store.close();
  });

  it('首次发布时未纳入项目与已接纳事实原子落库，提醒写入失败则全部回滚', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '合成成员' });
    const source = store.putSourceObject({
      bytes: Buffer.from('甲 5.0\n乙 待核对'), mediaType: 'text/plain', displayName: '原子发布.txt'
    });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.saveSourceManifest({
      id: 'atomic-manifest', sourceObjectId: source.id, sha256: source.sha256,
      mediaType: 'text/plain', originalDisplayName: '原子发布.txt', totalUnits: 1,
      coveredUnitIndexes: [0], normalizerVersion: 'test', conversionWarnings: [],
      createdAt: '2026-09-18T00:00:00.000Z', spans: [
        { id: 'atomic-span-a', documentId: document.documentId, spanKind: 'line', page: null,
          blockId: null, lineStart: 1, lineEnd: 1, quote: '甲 5.0', readability: 'clear' },
        { id: 'atomic-span-b', documentId: document.documentId, spanKind: 'line', page: null,
          blockId: null, lineStart: 2, lineEnd: 2, quote: '乙 待核对', readability: 'clear' }
      ]
    });
    const acceptanceId = store.saveAcceptanceDecision({
      method: 'auto', actor: 'policy', rulesVersion: 'test', inputSignature: 'atomic-input',
      outputHash: 'atomic-output', reviewRef: null, decision: 'accept'
    });
    const input = {
      personId: person.id, documentId: document.documentId,
      documentCommitKey: 'a'.repeat(64), expectedRevision: 0,
      changeSetHash: 'b'.repeat(64), summary: '合成原子发布',
      observations: [{
        conceptKey: '甲', originalName: '甲', rawText: '5.0', valueKind: 'numeric' as const,
        decimalValue: '5.0', qualifier: 'eq', unit: null, referenceRange: null,
        clinicalDate: null, abnormalFlag: 'unknown' as const, documentId: document.documentId,
        sourceSpanId: 'atomic-span-a', acceptanceId, specimen: null, method: null,
        bodySite: null, evidence: [{ sourceSpanId: 'atomic-span-a', quote: '甲 5.0' }]
      }],
      unresolvedReview: {
        kind: 'field_conflict' as const, evidenceRefs: ['atomic-span-b'],
        reasonCodes: ['VALUE_NOT_VERIFIED'], candidateOptions: []
      }
    };

    const database = new Database(store.databasePath);
    database.exec(`
      CREATE TRIGGER reject_atomic_warning BEFORE INSERT ON review_issues
      BEGIN SELECT RAISE(ABORT, 'INJECTED_WARNING_FAILURE'); END;
    `);
    expect(() => store.publishFacts(input)).toThrow('INJECTED_WARNING_FAILURE');
    expect(store.isDocumentCommitted(document.documentId)).toBe(false);
    expect(store.getFactRevision(person.id)).toBe(0);
    expect(store.listAcceptedObservations(person.id)).toEqual([]);
    expect(store.listOpenExtractionReviewIssues()).toEqual([]);

    database.exec('DROP TRIGGER reject_atomic_warning');
    database.close();
    expect(store.publishFacts(input)).toMatchObject({ revision: 1, idempotent: false });
    expect(store.listAcceptedObservations(person.id)).toHaveLength(1);
    expect(store.listOpenExtractionReviewIssues()).toEqual([
      expect.objectContaining({
        documentId: document.documentId, severity: 'warning', stage: 'extract',
        reasonCodes: ['VALUE_NOT_VERIFIED']
      })
    ]);
    expect(store.publishFacts(input)).toMatchObject({ revision: 1, idempotent: true });
    expect(store.listOpenExtractionReviewIssues()).toHaveLength(1);
    expect(store.integrityCheck()).toBe('ok');
    store.close();
  });

  it('已提交报告身份存疑时先隔离，只有显式确认同一人才能恢复事实与重排原任务', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '合成成员' });
    const source = store.putSourceObject({
      bytes: Buffer.from('受检者：张某\n甲 5.0'), mediaType: 'text/plain', displayName: '身份复核.txt'
    });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.saveSourceManifest({
      id: 'committed-identity-manifest', sourceObjectId: source.id, sha256: source.sha256,
      mediaType: 'text/plain', originalDisplayName: '身份复核.txt', totalUnits: 1,
      coveredUnitIndexes: [0], normalizerVersion: 'test', conversionWarnings: [],
      createdAt: '2026-09-18T00:00:00.000Z', spans: [{
        id: 'committed-identity-span', documentId: document.documentId,
        spanKind: 'line', page: null, blockId: null, lineStart: 1, lineEnd: 2,
        quote: '受检者：张某\n甲 5.0', readability: 'clear'
      }]
    });
    const acceptanceId = store.saveAcceptanceDecision({
      method: 'auto', actor: 'policy', rulesVersion: 'test', inputSignature: 'identity-input',
      outputHash: 'identity-output', reviewRef: null, decision: 'accept'
    });
    store.publishFacts({
      personId: person.id, documentId: document.documentId,
      documentCommitKey: 'c'.repeat(64), expectedRevision: 0,
      changeSetHash: 'd'.repeat(64), summary: '合成首次发布',
      observations: [{
        conceptKey: '甲', originalName: '甲', rawText: '5.0', valueKind: 'numeric',
        decimalValue: '5.0', qualifier: 'eq', unit: null, referenceRange: null,
        clinicalDate: null, abnormalFlag: 'unknown', documentId: document.documentId,
        sourceSpanId: 'committed-identity-span', acceptanceId,
        specimen: null, method: null, bodySite: null,
        evidence: [{ sourceSpanId: 'committed-identity-span', quote: '甲 5.0' }]
      }],
      unresolvedReview: { kind: 'field_conflict', evidenceRefs: ['committed-identity-span'],
        candidateOptions: [], reasonCodes: ['PREVIOUS_FIELD_UNVERIFIED'] }
    });
    const originalObservationId = store.listAcceptedObservations(person.id)[0]!.id;
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id],
      historicalObservationIds: [originalObservationId],
      accountFingerprint: 'synthetic-account', version: 1
    });
    const batch = store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z', consentId, initialStatus: 'queued',
      groups: [{ personId: person.id, documentIds: [document.documentId],
        stage: 'extract', inputSignature: 'synthetic-identity-repair' }]
    });
    const jobId = batch.jobIds[0]!;
    const database = new Database(store.databasePath);
    database.prepare(`UPDATE jobs SET status = 'waiting_user' WHERE id = ?`).run(jobId);
    database.close();

    const review = {
      documentId: document.documentId, reportedName: '张某',
      evidenceRefs: ['committed-identity-span'], reasonCodes: ['PERSON_IDENTITY_NOT_CONFIRMED'], jobId
    };
    const identityIssueId = store.saveCommittedIdentityReviewIssue(review);
    expect(store.saveCommittedIdentityReviewIssue(review)).toBe(identityIssueId);
    expect(store.getFactRevision(person.id)).toBe(2);
    expect(store.isDocumentCommitted(document.documentId)).toBe(true);
    expect(store.isDocumentExcluded(document.documentId)).toBe(true);
    expect(store.listAcceptedObservations(person.id)).toEqual([]);
    expect(store.listOpenExtractionReviewIssues()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: identityIssueId, severity: 'blocking',
        reasonCodes: expect.arrayContaining(['COMMITTED_PERSON_IDENTITY_CONFLICT']) }),
      expect.objectContaining({ severity: 'warning', reasonCodes: ['PREVIOUS_FIELD_UNVERIFIED'] })
    ]));
    expect(() => store.retryExtractionReview({ issueId: identityIssueId, documentId: document.documentId }))
      .toThrow('DOCUMENT_REVIEW_STATE_CONFLICT');
    expect(store.isDocumentExcluded(document.documentId)).toBe(true);

    store.confirmDocumentIdentity({
      issueId: identityIssueId, documentId: document.documentId, personId: person.id
    });
    expect(store.getFactRevision(person.id)).toBe(3);
    expect(store.isDocumentExcluded(document.documentId)).toBe(false);
    expect(store.listAcceptedObservations(person.id).map((observation) => observation.id))
      .toEqual([originalObservationId]);
    expect(store.listOpenExtractionReviewIssues()).toEqual([
      expect.objectContaining({ severity: 'warning', reasonCodes: ['PREVIOUS_FIELD_UNVERIFIED'] })
    ]);
    expect(store.listStoredJobs().find((job) => job.id === jobId)).toMatchObject({
      status: 'queued', stage: 'extract'
    });
    const readOnly = new Database(store.databasePath, { readonly: true });
    expect((readOnly.prepare(`SELECT status FROM documents WHERE id = ?`)
      .get(document.documentId) as { status: string }).status).toBe('completed');
    expect((readOnly.prepare(`SELECT COUNT(*) AS count FROM document_commits WHERE document_id = ?`)
      .get(document.documentId) as { count: number }).count).toBe(1);
    readOnly.close();

    // 之后若再次发现身份冲突，“不纳入”仍可永久排除，不会删除旧事实记录。
    const secondIssueId = store.saveCommittedIdentityReviewIssue(review);
    store.resolveReviewIssue({ issueId: secondIssueId, documentId: document.documentId, action: 'archive_only' });
    expect(store.isDocumentExcluded(document.documentId)).toBe(true);
    expect(store.listAcceptedObservations(person.id)).toEqual([]);
    expect(store.isDocumentCommitted(document.documentId)).toBe(true);
    expect(store.integrityCheck()).toBe('ok');
    store.close();
  });

  it('目录授权只向界面暴露名称，停用时同步撤回 AI 授权', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员' });
    const inbox = mkdtempSync(join(tmpdir(), 'family-health-inbox-'));
    directories.push(inbox);
    const binding = store.createInboxBinding({
      canonicalPath: inbox,
      personId: person.id,
      recursive: true,
      allowScheduledAiProcessing: true,
      accountFingerprint: 'account-fingerprint',
      consentVersion: 1
    });
    expect(binding).toMatchObject({
      displayName: expect.stringContaining('family-health-inbox-'),
      personId: person.id,
      recursive: true,
      aiProcessingAuthorized: true,
      enabled: true
    });
    expect(JSON.stringify(binding)).not.toContain(inbox);
    expect(store.listActiveInboxBindings()[0]).toMatchObject({ canonicalPath: inbox, consentId: expect.any(String) });
    store.disableInboxBinding(binding.id);
    expect(store.listInboxBindings()[0]).toMatchObject({ enabled: false, aiProcessingAuthorized: false });
    expect(store.listActiveInboxBindings()).toEqual([]);
    store.close();
  });

  it('退出 Codex 会撤回 AI 授权并暂停待发送任务，但保留本机目录发现和档案', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员' });
    const inbox = mkdtempSync(join(tmpdir(), 'family-health-logout-inbox-'));
    directories.push(inbox);
    const binding = store.createInboxBinding({
      canonicalPath: inbox, personId: person.id, recursive: true,
      allowScheduledAiProcessing: true, accountFingerprint: 'account-fingerprint', consentVersion: 1
    });
    const source = store.putSourceObject({ bytes: Buffer.from('虚构退出资料'), mediaType: 'text/plain', displayName: 'logout.txt' });
    store.registerSourceOccurrence({ sourceObjectId: source.id, bindingId: binding.id, originalPath: join(inbox, 'logout.txt'), displayName: 'logout.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: '9'.repeat(64) }],
      initialStatus: 'queued', consentId
    });

    expect(store.revokeAllAiAuthorizations()).toMatchObject({ revokedConsentCount: 2, waitingJobCount: 1 });
    expect(store.listInboxBindings()[0]).toMatchObject({ enabled: true, aiProcessingAuthorized: false });
    expect(store.listActiveInboxBindings()).toHaveLength(1);
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'waiting_auth' });
    expect(store.listImportedDocuments()).toHaveLength(1);
    store.close();
  });

  it('只有带有效一次性授权的任务才能领取并完成', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员' });
    const source = store.putSourceObject({ bytes: Buffer.from('虚构资料'), mediaType: 'text/plain', displayName: 'fixture.txt' });
    store.registerSourceOccurrence({ sourceObjectId: source.id, originalPath: '/tmp/fixture.txt', displayName: 'fixture.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId],
      personIds: [person.id],
      accountFingerprint: 'account-fingerprint',
      version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: 'a'.repeat(64) }],
      initialStatus: 'queued',
      consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint');
    expect(job).toMatchObject({ personId: person.id, documentIds: [document.documentId], consentId, attemptCount: 1 });
    store.updateJobProgress(job!.id, 1);
    store.finishJob(job!.id, 'succeeded');
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'succeeded', completedUnits: 1, totalUnits: 1 });
    store.close();
  });

  it('会撤回未关联任务的手动处理授权', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员' });
    const source = store.putSourceObject({ bytes: Buffer.from('虚构资料'), mediaType: 'text/plain', displayName: 'fixture.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    expect(store.revokeUnreferencedManualProcessingConsents()).toBe(1);
    expect(store.revokeUnreferencedManualProcessingConsents()).toBe(0);
    store.close();
  });

  it('授权撤回后，运行中尝试的最终事务也不得提交', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员' });
    const source = store.putSourceObject({ bytes: Buffer.from('授权撤回测试'), mediaType: 'text/plain', displayName: '撤回.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const accountFingerprint = 'account-fixture';
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint, version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00.000Z', initialStatus: 'queued', consentId,
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: 'guard-test' }]
    });
    const job = store.claimNextQueuedJob('lease-owner', accountFingerprint)!;
    const attemptId = store.startJobAttempt(job.id, 'fixture-runtime');
    const executionGuard = { jobId: job.id, attemptId, consentId, accountFingerprint };
    expect(() => store.assertJobExecutionActive(executionGuard, document.documentId)).not.toThrow();
    store.revokeAllAiAuthorizations();
    expect(() => store.publishFacts({
      personId: person.id, documentId: document.documentId, documentCommitKey: '9'.repeat(64),
      expectedRevision: 0, changeSetHash: '8'.repeat(64), summary: '不应提交', observations: [], executionGuard
    })).toThrow('CONSENT_REVOKED');
    expect(store.getFactRevision(person.id)).toBe(0);
    expect(store.isDocumentCommitted(document.documentId)).toBe(false);
    store.close();
  });

  it('运行中文档归属变化后，每次执行与事实发布边界都拒绝写入', () => {
    const store = makeStore();
    const originalPerson = store.createPerson({ displayName: '原成员' });
    const targetPerson = store.createPerson({ displayName: '目标成员' });
    const source = store.putSourceObject({
      bytes: Buffer.from('运行中归属变化测试'), mediaType: 'text/plain', displayName: '归属变化.txt'
    });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: originalPerson.id });
    const accountFingerprint = 'ownership-boundary-account';
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [originalPerson.id],
      accountFingerprint, version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z', initialStatus: 'queued', consentId,
      groups: [{
        personId: originalPerson.id,
        documentIds: [document.documentId],
        inputSignature: 'ownership-boundary-job'
      }]
    });
    const job = store.claimNextQueuedJob('ownership-boundary-runner', accountFingerprint)!;
    const attemptId = store.startJobAttempt(job.id, 'synthetic-runtime');
    const executionGuard = { jobId: job.id, attemptId, consentId, accountFingerprint };

    // 用底层写入模拟外部并发改归；正常业务 API 会禁止改归运行中任务。
    const database = new Database(store.databasePath);
    database.prepare(`UPDATE documents SET person_id = ? WHERE id = ?`)
      .run(targetPerson.id, document.documentId);
    database.close();

    expect(() => store.assertJobExecutionActive(executionGuard, document.documentId))
      .toThrow('DOCUMENT_PERSON_SCOPE_MISMATCH');
    expect(() => store.saveExtractionChunkCheckpoint({
      guard: executionGuard,
      documentId: document.documentId,
      signature: 'f'.repeat(64),
      chunkIndex: 0,
      output: { shouldNotPersist: true },
      threadId: 'ownership-thread',
      turnId: 'ownership-turn',
      extractionTurnId: 'ownership-turn'
    })).toThrow('DOCUMENT_PERSON_SCOPE_MISMATCH');
    expect(() => store.publishFacts({
      personId: originalPerson.id,
      documentId: document.documentId,
      documentCommitKey: 'a'.repeat(64),
      expectedRevision: 0,
      changeSetHash: 'b'.repeat(64),
      summary: '不应写入',
      observations: [],
      executionGuard
    })).toThrow('DOCUMENT_PERSON_SCOPE_MISMATCH');
    expect(store.getFactRevision(originalPerson.id)).toBe(0);
    expect(store.getFactRevision(targetPerson.id)).toBe(0);
    expect(store.isDocumentCommitted(document.documentId)).toBe(false);
    store.close();
  });

  it('用户放弃派生说明后，等待核对的任务以已保存事实收口', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员' });
    const source = store.putSourceObject({ bytes: Buffer.from('虚构资料'), mediaType: 'text/plain', displayName: 'fixture.txt' });
    store.registerSourceOccurrence({ sourceObjectId: source.id, originalPath: '/tmp/fixture-derived.txt', displayName: 'fixture.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: 'c'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    store.setDocumentStatus(document.documentId, 'completed');
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId, kind: 'derived_safety', severity: 'blocking', evidenceRefs: [], preserveDocumentStatus: true
    });
    store.finishJob(job.id, 'waiting_user');
    store.resolveReviewIssue({ issueId, documentId: document.documentId, action: 'dismiss_derived' });
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'succeeded', completedUnits: 1, totalUnits: 1 });
    store.close();
  });

  it('整篇事实修正在同一事务中关闭事项并恢复原任务', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员' });
    const source = store.putSourceObject({ bytes: Buffer.from('虚构报告'), mediaType: 'text/plain', displayName: 'fixture.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: 'complete-correction' }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      jobId: job.id,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: ['span-1'],
      documentRun: {
        coverageComplete: true,
        coveredSourceSpanIds: ['span-1'],
        manifestSpanIds: ['span-1'],
        chunkCount: 1
      }
    });
    store.finishJob(job.id, 'waiting_user');

    store.publishFacts({
      personId: person.id,
      documentId: document.documentId,
      documentCommitKey: '1'.repeat(64),
      expectedRevision: 0,
      changeSetHash: '2'.repeat(64),
      summary: '用户核对整篇后提交',
      observations: [],
      resolvedReviewIssueId: issueId
    });

    expect(store.listOpenExtractionReviewIssues()).toEqual([]);
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'queued', stage: 'extract', completedUnits: 0 });
    store.close();
  });

  it('授权撤回后解决阻断核对会终结旧任务，重新处理必须另行授权', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员' });
    const source = store.putSourceObject({ bytes: Buffer.from('撤回授权后的核对'), mediaType: 'text/plain', displayName: 'fixture.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: 'revoked-review-resume' }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      jobId: job.id,
      kind: 'derived_safety',
      severity: 'blocking',
      evidenceRefs: [],
      preserveDocumentStatus: true
    });
    store.finishJob(job.id, 'waiting_user');
    store.revokeAllAiAuthorizations();

    store.resolveReviewIssue({ issueId, documentId: document.documentId, action: 'dismiss_derived' });

    expect(store.listOpenExtractionReviewIssues()).toEqual([]);
    expect(store.listStoredJobs()[0]).toMatchObject({ id: job.id, status: 'cancelled' });
    store.close();
  });

  it('已提交资料不能把后到的核对修正伪装成幂等成功', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员' });
    const source = store.putSourceObject({ bytes: Buffer.from('已提交资料'), mediaType: 'text/plain', displayName: 'fixture.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.publishFacts({
      personId: person.id,
      documentId: document.documentId,
      documentCommitKey: '3'.repeat(64),
      expectedRevision: 0,
      changeSetHash: '4'.repeat(64),
      summary: '首次提交',
      observations: []
    });
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: ['span-1'],
      preserveDocumentStatus: true,
      documentRun: {
        coverageComplete: true,
        coveredSourceSpanIds: ['span-1'],
        manifestSpanIds: ['span-1'],
        chunkCount: 1
      }
    });

    expect(() => store.publishFacts({
      personId: person.id,
      documentId: document.documentId,
      documentCommitKey: '3'.repeat(64),
      expectedRevision: 1,
      changeSetHash: '5'.repeat(64),
      summary: '不应伪装成功',
      observations: [],
      resolvedReviewIssueId: issueId
    })).toThrow('DOCUMENT_ALREADY_COMMITTED_REVIEW_CONFLICT');
    expect(store.listOpenExtractionReviewIssues()).toHaveLength(1);
    store.close();
  });

  it('已提交报告只增量接纳新事实，缩小再关闭旧警告，重复执行保持幂等', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '合成成员' });
    const source = store.putSourceObject({
      bytes: Buffer.from('甲 5.0\n乙 7.0\n丙 9.0'), mediaType: 'text/plain', displayName: '增量报告.txt'
    });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const spanIds = ['append-span-a', 'append-span-b', 'append-span-c'];
    store.saveSourceManifest({
      id: 'append-manifest', sourceObjectId: source.id, sha256: source.sha256,
      mediaType: 'text/plain', originalDisplayName: '增量报告.txt', totalUnits: 1,
      coveredUnitIndexes: [0], normalizerVersion: 'test', conversionWarnings: [],
      createdAt: '2026-09-18T00:00:00.000Z',
      spans: spanIds.map((id, index) => ({
        id, documentId: document.documentId, spanKind: 'line' as const, page: null,
        blockId: null, lineStart: index + 1, lineEnd: index + 1,
        quote: `${'甲乙丙'[index]} ${[5, 7, 9][index]}.0`, readability: 'clear' as const
      }))
    });
    const acceptanceId = store.saveAcceptanceDecision({
      method: 'auto', actor: 'policy', rulesVersion: 'test', inputSignature: 'append-input',
      outputHash: 'append-output', reviewRef: null, decision: 'accept'
    });
    const observation = (name: string, value: string, spanId: string) => ({
      conceptKey: name, originalName: name, modelStandardNameCandidate: null,
      rawText: value, valueKind: 'numeric' as const, decimalValue: value, qualifier: 'eq',
      unit: null, referenceRange: null, clinicalDate: '2026-09-18',
      abnormalFlag: 'unknown' as const, documentId: document.documentId,
      sourceSpanId: spanId, acceptanceId, specimen: null, method: null, bodySite: null,
      evidence: [{ sourceSpanId: spanId, quote: `${name} ${value}` }]
    });
    const first = observation('甲', '5.0', spanIds[0]!);
    const second = observation('乙', '7.0', spanIds[1]!);
    const third = observation('丙', '9.0', spanIds[2]!);
    store.publishFacts({
      personId: person.id, documentId: document.documentId, documentCommitKey: 'e'.repeat(64),
      expectedRevision: 0, changeSetHash: 'f'.repeat(64), summary: '首次接纳', observations: [first]
    });
    const candidate = (key: string, name: string, value: string, spanId: string) => ({
      localKey: key, originalName: name, standardNameCandidate: null,
      value: { kind: 'numeric' as const, rawText: value, decimal: value, comparator: 'eq' as const },
      unitRaw: null, referenceRangeRaw: null, reportedAbnormalFlag: null,
      specimen: null, method: null, bodySite: null, clinicalDate: '2026-09-18',
      evidence: [{ sourceSpanId: spanId, quote: `${name} ${value}` }], issues: []
    });
    const remaining = candidate('candidate-c', '丙', '9.0', spanIds[2]!);
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId, kind: 'field_conflict', severity: 'warning',
      preserveDocumentStatus: true, stage: 'extract',
      evidenceRefs: [spanIds[1]!, spanIds[2]!],
      candidateOptions: [candidate('candidate-b', '乙', '7.0', spanIds[1]!), remaining],
      reasonCodes: ['VALUE_NOT_IN_EVIDENCE']
    });
    const database = new Database(store.databasePath);
    database.prepare(`
      INSERT INTO member_assessment_snapshots_v3 (
        id, person_id, input_signature, fact_revision, context_revision, prompt_version,
        rules_version, model_id, reasoning_effort, validation_mode, payload_json, status, created_at
      ) VALUES ('append-assessment', ?, 'old', 1, 0, 'test', 'test', 'test', 'medium',
        'local_only', '{}', 'current', '2026-09-18T00:00:00.000Z')
    `).run(person.id);
    database.close();

    const appended = store.appendCommittedFacts({
      personId: person.id, documentId: document.documentId, expectedRevision: 1,
      summary: '补入乙', observations: [first, second],
      reviewUpdate: {
        issueId, remainingCandidates: [remaining], remainingReasonCodes: ['UNREADABLE'],
        remainingEvidenceRefs: [spanIds[2]!]
      }
    });
    expect(appended).toMatchObject({
      revision: 2, appendedCount: 1, duplicateCount: 1, idempotent: false, reviewResolved: false
    });
    expect(store.listAcceptedObservations(person.id)).toHaveLength(2);
    expect(store.listOpenExtractionReviewIssues()[0]).toMatchObject({
      id: issueId, candidateOptions: [remaining], reasonCodes: ['UNREADABLE'],
      evidenceRefs: [spanIds[2]!]
    });
    const readOnly = new Database(store.databasePath, { readonly: true });
    expect(readOnly.prepare(`SELECT status FROM member_assessment_snapshots_v3 WHERE id = 'append-assessment'`).get())
      .toEqual({ status: 'stale' });
    expect((readOnly.prepare(`SELECT COUNT(*) AS count FROM document_commits WHERE document_id = ?`)
      .get(document.documentId) as { count: number }).count).toBe(1);
    expect((readOnly.prepare(`SELECT COUNT(*) AS count FROM report_source_links WHERE document_id = ?`)
      .get(document.documentId) as { count: number }).count).toBe(1);
    readOnly.close();

    const scopeBeforeLocalRevision = store.getOpenReviewScopeSignature(person.id);
    const changedWithoutNewFact = store.appendCommittedFacts({
      personId: person.id, documentId: document.documentId, expectedRevision: 2,
      summary: '更新待核对范围', observations: [],
      reviewUpdate: {
        issueId, remainingCandidates: [remaining], remainingReasonCodes: ['STILL_UNREADABLE'],
        remainingEvidenceRefs: [spanIds[2]!]
      }
    });
    expect(changedWithoutNewFact).toMatchObject({ revision: 2, appendedCount: 0, reviewResolved: false });
    expect(store.getOpenReviewScopeSignature(person.id)).not.toBe(scopeBeforeLocalRevision);

    const closed = store.appendCommittedFacts({
      personId: person.id, documentId: document.documentId, expectedRevision: 2,
      summary: '补入丙', observations: [third],
      reviewUpdate: {
        issueId, remainingCandidates: [], remainingReasonCodes: [], remainingEvidenceRefs: []
      }
    });
    expect(closed).toMatchObject({ revision: 3, appendedCount: 1, reviewResolved: true });
    expect(store.listAcceptedObservations(person.id)).toHaveLength(3);
    expect(store.listOpenExtractionReviewIssues()).toEqual([]);
    const replay = store.appendCommittedFacts({
      personId: person.id, documentId: document.documentId, expectedRevision: 2,
      summary: '补入丙', observations: [third],
      reviewUpdate: {
        issueId, remainingCandidates: [], remainingReasonCodes: [], remainingEvidenceRefs: []
      }
    });
    expect(replay).toMatchObject({
      revision: 3, appendedCount: 0, duplicateCount: 1, idempotent: true, reviewResolved: true
    });
    expect(store.getFactRevision(person.id)).toBe(3);
    expect(store.integrityCheck()).toBe('ok');
    store.close();
  });

  it('已提交报告拒绝无接纳决定，内容疑点局部保留且独立来源可增量保存', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '合成成员' });
    const source = store.putSourceObject({ bytes: Buffer.from('甲 5.0'), mediaType: 'text/plain', displayName: '冲突报告.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.saveSourceManifest({
      id: 'conflict-manifest', sourceObjectId: source.id, sha256: source.sha256,
      mediaType: 'text/plain', originalDisplayName: '冲突报告.txt', totalUnits: 1,
      coveredUnitIndexes: [0], normalizerVersion: 'test', conversionWarnings: [],
      createdAt: '2026-09-18T00:00:00.000Z', spans: [{
        id: 'conflict-span', documentId: document.documentId, spanKind: 'line', page: null,
        blockId: null, lineStart: 1, lineEnd: 1, quote: '甲 5.0', readability: 'clear'
      }, {
        id: 'conflict-span-independent', documentId: document.documentId, spanKind: 'line', page: null,
        blockId: null, lineStart: 2, lineEnd: 2, quote: '甲 5.0', readability: 'clear'
      }]
    });
    const acceptanceId = store.saveAcceptanceDecision({
      method: 'auto', actor: 'policy', rulesVersion: 'test', inputSignature: 'conflict-input',
      outputHash: 'conflict-output', reviewRef: null, decision: 'accept'
    });
    const first = {
      conceptKey: '甲', originalName: '甲', rawText: '5.0', valueKind: 'numeric' as const,
      decimalValue: '5.0', qualifier: 'eq', unit: null, referenceRange: null,
      clinicalDate: '2026-09-18', abnormalFlag: 'unknown' as const,
      documentId: document.documentId, sourceSpanId: 'conflict-span', acceptanceId,
      specimen: null, method: null, bodySite: null,
      evidence: [{ sourceSpanId: 'conflict-span', quote: '甲 5.0' }]
    };
    store.publishFacts({
      personId: person.id, documentId: document.documentId, documentCommitKey: '1'.repeat(64),
      expectedRevision: 0, changeSetHash: '2'.repeat(64), summary: '首次接纳', observations: [first]
    });
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId, kind: 'field_conflict', severity: 'warning',
      preserveDocumentStatus: true, stage: 'extract', evidenceRefs: ['conflict-span'],
      candidateOptions: [], reasonCodes: ['TEST_UNRESOLVED']
    });
    const input = {
      personId: person.id, documentId: document.documentId, expectedRevision: 1,
      summary: '不应发布', reviewUpdate: {
        issueId, remainingCandidates: [], remainingReasonCodes: [], remainingEvidenceRefs: []
      }
    };
    expect(() => store.appendCommittedFacts({ ...input, observations: [{ ...first, valueKind: 'unknown' }] }))
      .toThrow('COMMITTED_FACT_EVIDENCE_INVALID');
    expect(() => store.appendCommittedFacts({ ...input, observations: [{ ...first, acceptanceId: 'missing-acceptance' }] }))
      .toThrow('COMMITTED_FACT_NOT_ACCEPTED');
    const held = store.appendCommittedFacts({ ...input, observations: [{ ...first, rawText: '6.0', decimalValue: '6.0' }] });
    expect(held).toMatchObject({ appendedCount: 0, updatedCount: 0, heldCount: 1, reviewResolved: false });
    expect(store.listAcceptedObservations(person.id)[0]?.rawText).toBe('5.0');
    expect(store.appendCommittedFacts({ ...input, reviewUpdate: { ...input.reviewUpdate,
      remainingCandidates: held.heldCandidates, remainingReasonCodes: held.heldReasonCodes,
      remainingEvidenceRefs: ['conflict-span'] }, observations: [{
      ...first, sourceSpanId: 'conflict-span-independent',
      evidence: [{ sourceSpanId: 'conflict-span-independent', quote: '甲 5.0' }]
    }] })).toMatchObject({ appendedCount: 1, heldCount: 0, reviewResolved: false });
    expect(() => store.appendCommittedFacts({ ...input, expectedRevision: 0, observations: [] }))
      .toThrow(RevisionConflictError);
    expect(store.listAcceptedObservations(person.id)).toHaveLength(2);
    expect(store.listOpenExtractionReviewIssues()).toHaveLength(1);
    expect(store.getFactRevision(person.id)).toBe(2);
    expect(store.integrityCheck()).toBe('ok');
    store.close();
  });

  it('派生核对通过 jobId 恢复新批次，不受旧证据报告归属影响', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员' });
    const oldSource = store.putSourceObject({ bytes: Buffer.from('旧报告'), mediaType: 'text/plain', displayName: 'old.txt' });
    const newSource = store.putSourceObject({ bytes: Buffer.from('新报告'), mediaType: 'text/plain', displayName: 'new.txt' });
    const oldDocument = store.registerImportedDocument({ sourceObjectId: oldSource.id, personId: person.id });
    const newDocument = store.registerImportedDocument({ sourceObjectId: newSource.id, personId: person.id });
    const consentId = store.createManualProcessingConsent({
      documentIds: [newDocument.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [newDocument.documentId], inputSignature: 'derived-old-evidence-new-job' }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: oldDocument.documentId,
      jobId: job.id,
      kind: 'derived_safety',
      severity: 'blocking',
      evidenceRefs: [],
      preserveDocumentStatus: true
    });
    store.finishJob(job.id, 'waiting_user');

    store.resolveReviewIssue({ issueId, documentId: oldDocument.documentId, action: 'dismiss_derived' });
    expect(store.listStoredJobs()[0]).toMatchObject({ id: job.id, status: 'succeeded', completedUnits: 1 });
    store.close();
  });

  it('旧版事实核对可以安全回到队列且不会提前写入事实', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员' });
    const source = store.putSourceObject({ bytes: Buffer.from('虚构报告 4.2 mmol/L'), mediaType: 'text/plain', displayName: '旧版核对.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: 'd'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: [],
      candidateOptions: [{
        localKey: 'ldl-legacy', originalName: '低密度脂蛋白胆固醇', standardNameCandidate: 'LDL-C',
        value: { kind: 'numeric', rawText: '4.2', decimal: '4.2', comparator: 'eq' },
        unitRaw: 'mmol/L', referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: null, bodySite: null, clinicalDate: null,
        evidence: [{ sourceSpanId: 'legacy-span', quote: '4.2 mmol/L' }], issues: []
      }]
    });
    store.finishJob(job.id, 'waiting_user');

    store.retryExtractionReview({ issueId, documentId: document.documentId });

    expect(store.listOpenExtractionReviewIssues()).toEqual([]);
    expect(store.listReadyDocuments()).toEqual([{ id: document.documentId, personId: person.id }]);
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'queued', completedUnits: 0, totalUnits: 1 });
    expect(store.getFactRevision(person.id)).toBe(0);
    expect(store.listAcceptedObservations(person.id)).toEqual([]);

    const currentIssueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: [],
      candidateOptions: [{
        localKey: 'current-conflict', originalName: '低密度脂蛋白胆固醇', standardNameCandidate: 'LDL-C',
        value: { kind: 'numeric', rawText: '4.3', decimal: '4.3', comparator: 'eq' },
        unitRaw: 'mmol/L', referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: null, bodySite: null, clinicalDate: null,
        evidence: [{ sourceSpanId: 'current-span', quote: '4.3 mmol/L' }], issues: []
      }],
      candidateDiffs: [{ localKey: 'current-conflict', itemName: '低密度脂蛋白胆固醇', fields: ['value'] }]
    });
    expect(() => store.retryExtractionReview({ issueId: currentIssueId, documentId: document.documentId })).toThrow('REVIEW_ACTION_INVALID');
    store.close();
  });

  it('受检者姓名误读可在原成员和原授权范围内重新提取，不预先确认错误姓名', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员' });
    const source = store.putSourceObject({
      bytes: Buffer.from('报告者：测试报告者；检验结果 4.2 mmol/L'),
      mediaType: 'text/plain', displayName: '报告者误读.txt'
    });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-24T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: 'reporter-recheck' }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId, kind: 'person_conflict', severity: 'blocking',
      evidenceRefs: [], reportedName: '测试报告者', reasonCodes: ['PERSON_IDENTITY_NOT_CONFIRMED']
    });
    store.finishJob(job.id, 'waiting_user');

    store.retryExtractionReview({ issueId, documentId: document.documentId });

    expect(store.listOpenExtractionReviewIssues()).toEqual([]);
    expect(store.listReadyDocuments()).toEqual([{ id: document.documentId, personId: person.id }]);
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'queued', stage: 'extract' });
    expect(store.listAcceptedObservations(person.id)).toEqual([]);
    store.close();
  });

  it('旧流程留下的纯异常标记冲突可以重新交给模型裁决', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员' });
    const source = store.putSourceObject({
      bytes: Buffer.from('心率 64 62 ▼ 60-100 bpm'), mediaType: 'text/plain', displayName: '趋势核对.txt'
    });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-20T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: 'trend-marker-retry' }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const candidate = {
      localKey: 'heart-rate', originalName: '心率', standardNameCandidate: '心率',
      value: { kind: 'numeric' as const, rawText: '62', decimal: '62', comparator: 'eq' as const },
      unitRaw: 'bpm', referenceRangeRaw: '60-100', reportedAbnormalFlag: null,
      specimen: null, method: null, bodySite: null, clinicalDate: null,
      evidence: [{ sourceSpanId: 'trend-span', quote: '心率 64 62 ▼ 60-100 bpm' }], issues: []
    };
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      jobId: job.id,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: ['trend-span'],
      candidateOptions: [candidate],
      candidateDiffs: [{ localKey: candidate.localKey, itemName: candidate.originalName, fields: ['reportedAbnormalFlag'] }]
    });
    store.finishJob(job.id, 'waiting_user');

    store.retryExtractionReview({ issueId, documentId: document.documentId });

    expect(store.listOpenExtractionReviewIssues()).toEqual([]);
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'queued', stage: 'extract', completedUnits: 0 });
    expect(store.listAcceptedObservations(person.id)).toEqual([]);
    store.close();
  });

  it('纯证据绑定问题可以重新排队，但核心事实冲突仍不可直接重试', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员' });
    const source = store.putSourceObject({
      bytes: Buffer.from('2023-10-08 2024-10-22 趋势 身高 187 187'), mediaType: 'text/plain', displayName: '年度对比.txt'
    });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-20T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: 'comparison-date-retry' }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const candidate = {
      localKey: 'height-2023', originalName: '身高', standardNameCandidate: '身高',
      value: { kind: 'numeric' as const, rawText: '187', decimal: '187', comparator: 'eq' as const },
      unitRaw: 'cm', referenceRangeRaw: '---', reportedAbnormalFlag: null,
      specimen: null, method: null, bodySite: null, clinicalDate: '2023-10-08',
      evidence: [{ sourceSpanId: 'comparison-span', quote: '身高 187 187' }], issues: []
    };
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      jobId: job.id,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: ['comparison-span'],
      candidateOptions: [candidate],
      candidateDiffs: [{ localKey: candidate.localKey, itemName: candidate.originalName, fields: ['issues'] }],
      reasonCodes: ['clinical_date_not_in_evidence']
    });
    store.finishJob(job.id, 'waiting_user');

    store.retryExtractionReview({ issueId, documentId: document.documentId });

    expect(store.listOpenExtractionReviewIssues()).toEqual([]);
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'queued', stage: 'extract', completedUnits: 0 });
    expect(store.listAcceptedObservations(person.id)).toEqual([]);
    store.close();
  });

  it('同一批有多条阻断事项时，最后一条解决后才按原批次恢复', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员' });
    const firstSource = store.putSourceObject({ bytes: Buffer.from('虚构资料甲'), mediaType: 'text/plain', displayName: '甲.txt' });
    const secondSource = store.putSourceObject({ bytes: Buffer.from('虚构资料乙'), mediaType: 'text/plain', displayName: '乙.txt' });
    const firstDocument = store.registerImportedDocument({ sourceObjectId: firstSource.id, personId: person.id });
    const secondDocument = store.registerImportedDocument({ sourceObjectId: secondSource.id, personId: person.id });
    const documentIds = [firstDocument.documentId, secondDocument.documentId];
    const consentId = store.createManualProcessingConsent({
      documentIds, personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds, inputSignature: '9'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const candidateFor = (localKey: string) => ({
      localKey, originalName: '虚构项目', standardNameCandidate: null,
      value: { kind: 'text' as const, rawText: '虚构结果' }, unitRaw: null, referenceRangeRaw: null,
      reportedAbnormalFlag: null, specimen: null, method: null, bodySite: null, clinicalDate: null,
      evidence: [{ sourceSpanId: `${localKey}-span`, quote: '虚构结果' }], issues: []
    });
    const firstIssue = store.saveExtractionReviewIssue({
      documentId: firstDocument.documentId, kind: 'field_conflict', severity: 'blocking', evidenceRefs: [], candidateOptions: [candidateFor('first')]
    });
    const secondIssue = store.saveExtractionReviewIssue({
      documentId: secondDocument.documentId, kind: 'field_conflict', severity: 'blocking', evidenceRefs: [], candidateOptions: [candidateFor('second')]
    });
    store.finishJob(job.id, 'waiting_user');

    store.retryExtractionReview({ issueId: firstIssue, documentId: firstDocument.documentId });
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'waiting_user', totalUnits: 2 });
    store.retryExtractionReview({ issueId: secondIssue, documentId: secondDocument.documentId });
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'queued', stage: 'extract', completedUnits: 0, totalUnits: 2 });
    store.close();
  });

  it('日程设置使用 revision，且同一时区日程槽只创建一次授权批次', () => {
    const store = makeStore();
    const initial = store.getOrCreateSchedule('Asia/Shanghai', '2026-09-18T12:00:00.000Z');
    expect(initial).toMatchObject({ enabled: false, localTime: '20:00', timeZone: 'Asia/Shanghai', revision: 0 });
    const schedule = store.updateSchedule({
      enabled: true,
      localTime: '20:30',
      timeZone: 'Asia/Shanghai',
      nextRunUtc: '2026-09-18T12:30:00.000Z',
      expectedRevision: 0
    });
    expect(schedule).toMatchObject({ enabled: true, localTime: '20:30', revision: 1 });
    expect(() => store.updateSchedule({
      enabled: false,
      localTime: '21:00',
      timeZone: 'Asia/Shanghai',
      nextRunUtc: '2026-09-18T13:00:00.000Z',
      expectedRevision: 0
    })).toThrow(RevisionConflictError);

    const person = store.createPerson({ displayName: '测试成员' });
    const inbox = mkdtempSync(join(tmpdir(), 'family-health-scheduled-inbox-'));
    directories.push(inbox);
    const binding = store.createInboxBinding({
      canonicalPath: inbox,
      personId: person.id,
      recursive: true,
      allowScheduledAiProcessing: true,
      accountFingerprint: 'account-fingerprint',
      consentVersion: 1
    });
    const activeBinding = store.listActiveInboxBindings().find((item) => item.id === binding.id)!;
    const source = store.putSourceObject({ bytes: Buffer.from('虚构日程资料'), mediaType: 'text/plain', displayName: 'scheduled.txt' });
    store.registerSourceOccurrence({
      sourceObjectId: source.id,
      bindingId: binding.id,
      originalPath: join(inbox, 'scheduled.txt'),
      displayName: 'scheduled.txt'
    });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const groups = store.listScheduledReadyGroups('account-fingerprint', '2026-09-18T00:00:01Z');
    expect(groups).toEqual([{
      personId: person.id,
      consentId: activeBinding.consentId,
      accountFingerprint: 'account-fingerprint',
      documentIds: [document.documentId]
    }]);
    const batch = store.createScheduledBatch({
      slotKey: 'daily:2026-09-18:r1',
      cutoff: '2026-09-18T00:00:01Z',
      groups: groups.map((group) => ({ ...group, inputSignature: 'd'.repeat(64), initialStatus: 'queued' as const }))
    });
    expect(batch).toMatchObject({ idempotent: false, jobIds: [expect.any(String)] });
    expect(store.createScheduledBatch({
      slotKey: 'daily:2026-09-18:r1',
      cutoff: '2026-09-18T00:00:01Z',
      groups: groups.map((group) => ({ ...group, inputSignature: 'd'.repeat(64), initialStatus: 'queued' as const }))
    })).toMatchObject({ batchId: batch.batchId, idempotent: true, jobIds: [] });

    expect(store.claimNextQueuedJob('wrong-account', 'different-fingerprint')).toBeNull();
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'waiting_auth' });
    expect(store.requeueWaitingJobs('waiting_auth')).toBe(1);
    expect(store.claimNextQueuedJob('scheduled-runner', 'account-fingerprint')).toMatchObject({
      personId: person.id,
      documentIds: [document.documentId],
      consentId: activeBinding.consentId
    });
    store.close();
  });

  it('取消运行任务保留检查点，失败任务重试时重新进入授权领取', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员' });
    const source = store.putSourceObject({ bytes: Buffer.from('虚构取消资料'), mediaType: 'text/plain', displayName: 'cancel.txt' });
    store.registerSourceOccurrence({ sourceObjectId: source.id, originalPath: '/tmp/cancel.txt', displayName: 'cancel.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: 'e'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('runner', 'account-fingerprint')!;
    const attemptId = store.startJobAttempt(job.id, '0.145.0', 'gpt-5.6-sol', 'medium');
    const auditDatabase = new Database(store.databasePath, { readonly: true });
    expect(auditDatabase.prepare(`SELECT model, reasoning_effort FROM job_attempts WHERE id = ?`).get(attemptId)).toEqual({
      model: 'gpt-5.6-sol', reasoning_effort: 'medium'
    });
    auditDatabase.close();
    store.updateJobProgress(job.id, 1);
    expect(store.requestJobCancellation(job.id)).toEqual({ running: true, alreadyTerminal: false });
    expect(store.isJobCancellationRequested(job.id)).toBe(true);
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'running', statusText: '正在安全停止', completedUnits: 1 });
    store.finishJob(job.id, 'cancelled');
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'cancelled', completedUnits: 1 });
    expect(store.requestJobCancellation(job.id)).toEqual({ running: false, alreadyTerminal: true });
    store.finishJobAttempt({ attemptId, status: 'cancelled' });
    expect(store.cleanupTerminalTaskAttempts('2026-10-18T00:00:00Z')).toBe(1);
    expect(store.cleanupTerminalTaskAttempts('2026-10-18T00:00:00Z')).toBe(0);

    const secondSource = store.putSourceObject({ bytes: Buffer.from('虚构重试资料'), mediaType: 'text/plain', displayName: 'retry.txt' });
    store.registerSourceOccurrence({ sourceObjectId: secondSource.id, originalPath: '/tmp/retry.txt', displayName: 'retry.txt' });
    const secondDocument = store.registerImportedDocument({ sourceObjectId: secondSource.id, personId: person.id });
    const secondConsentId = store.createManualProcessingConsent({
      documentIds: [secondDocument.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    const secondBatch = store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [secondDocument.documentId], inputSignature: 'f'.repeat(64) }],
      initialStatus: 'queued', consentId: secondConsentId
    });
    const failedJob = store.claimNextQueuedJob('runner', 'account-fingerprint')!;
    expect(failedJob.id).toBe(secondBatch.jobIds[0]);
    const failedAttemptId = store.startJobAttempt(failedJob.id, '0.145.0', 'gpt-5.6-sol', 'medium');
    store.updateJobStage(failedJob.id, 'analyze');
    store.finishJobAttempt({
      attemptId: failedAttemptId,
      status: 'failed',
      errorCode: "CODEX_RPC_ERROR:-32600:failed to load configuration: unknown configuration field 'tools.view_image'"
    });
    store.finishJob(failedJob.id, 'failed');
    expect(store.listStoredJobs().find((storedJob) => storedJob.id === failedJob.id)).toMatchObject({
      status: 'failed',
      statusText: '当前版本的 Codex 配置不兼容，请安装更新后重试'
    });
    store.retryFailedJob(failedJob.id);
    store.setQueuePaused(true);
    expect(store.isQueuePaused()).toBe(true);
    expect(store.claimNextQueuedJob('paused-runner', 'account-fingerprint')).toBeNull();
    store.setQueuePaused(false);
    expect(store.claimNextQueuedJob('runner-retry', 'account-fingerprint')).toMatchObject({ id: failedJob.id, stage: 'analyze', attemptCount: 2 });
    const schemaAttemptId = store.startJobAttempt(failedJob.id, '0.145.0', 'gpt-5.6-sol', 'medium');
    store.finishJobAttempt({ attemptId: schemaAttemptId, status: 'failed', errorCode: 'CODEX_OUTPUT_SCHEMA_INVALID' });
    store.finishJob(failedJob.id, 'failed');
    expect(store.listStoredJobs().find((storedJob) => storedJob.id === failedJob.id)?.statusText)
      .toBe('结构化输出格式不兼容，请安装更新后重试');
    store.close();
  });
});
