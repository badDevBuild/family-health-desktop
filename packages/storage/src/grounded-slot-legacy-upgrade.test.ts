import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { directOriginalReadingRepairSchema, directOriginalReadingResultSchema, observationStructuredSlotEvidence,
  type ObservationCandidate, type SourceManifest, type SourceSpan } from '@contracts';
import { conceptDictionary, stableHash } from '@core';
import { WorkspaceStore, type PublishFactsInput } from './index.js';
import { DIRECT_ORIGINAL_SOURCE_REFINEMENT_VERSION, directOriginalSourceRefinementReviewSignature,
  type DirectOriginalSourceRefinementReview } from './direct-original-source-refinement.js';

const roots: string[] = [];
const stores = new Set<WorkspaceStore>();
afterEach(() => {
  for (const store of stores) store.close(); stores.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(options: { equalValues?: boolean; locked?: boolean; changedMedical?: boolean; ambiguousOld?: boolean;
  narrowHistory?: boolean; secondOld?: boolean; mapSecond?: boolean; forceSameColumn?: boolean;
  conditionMode?: 'rebound' | 'wrong_page' | 'different_frame' | 'condition_only' | 'drop_negation' | 'laterality'
    | 'duplicate' | 'duplicate_overlapping_frames' | 'missing' | 'status' } = {}) {
  const rootDirectory = mkdtempSync(join(tmpdir(), 'synthetic-grounded-legacy-')); roots.push(rootDirectory);
  const store = new WorkspaceStore({ rootDirectory }); stores.add(store);
  const db = new Database(store.databasePath, { readonly: true });
  const person = store.createPerson({ displayName: '合成成员' });
  const source = store.putSourceObject({ bytes: Buffer.from('合成旧整行升级原件'), mediaType: 'image/png', displayName: 'synthetic.png' });
  const { documentId } = store.registerImportedDocument({ personId: person.id, sourceObjectId: source.id });
  const history = options.equalValues ? '5.0' : '8.0';
  const row = `甲项 5.0 ${history}`;
  const page: SourceSpan = { id: 'legacy-page', documentId, spanKind: 'image', page: 1, blockId: 'direct-original-page:1',
    lineStart: null, lineEnd: null, quote: null, readability: 'clear' };
  const oldSpan: SourceSpan = { ...page, id: 'legacy-row', spanKind: 'block', quote: options.ambiguousOld ? '5.0' : row,
    blockId: `model-original-excerpt:${page.id}`, modelEvidence: { version: 1, engine: 'codex-original-reading-v1',
      modelId: 'gpt-6.1-sol', threadId: 'old-thread', turnId: 'old-turn', originalSha256: source.sha256,
      originalSourceObjectId: source.id, parentSourceSpanId: page.id, inputKind: 'image', role: 'finding', clarity: 'clear' } };
  const pages = [page, ...(options.conditionMode === 'wrong_page' ? [{ ...page, id: 'condition-page-2', page: 2,
    blockId: 'direct-original-page:2' }] : [])];
  const oldCondition: SourceSpan = { ...structuredClone(oldSpan), id: 'legacy-condition',
    quote: options.conditionMode === 'condition_only' ? '未散瞳；仅右眼' : '检查条件：未散瞳；仅右眼',
    modelEvidence: { ...oldSpan.modelEvidence!, role: 'context' } };
  const oldConditionWide: SourceSpan = { ...structuredClone(oldCondition), id: 'legacy-condition-wide',
    quote: `合成说明\n${oldCondition.quote}\n其余信息未知` };
  const manifest: SourceManifest = { id: 'legacy-manifest', sourceObjectId: source.id, sha256: source.sha256,
    mediaType: 'image/png', originalDisplayName: 'synthetic.png', totalUnits: pages.length, coveredUnitIndexes: pages.map((_, index) => index),
    spans: [...pages, oldSpan, ...(options.conditionMode ? [oldCondition] : []),
      ...(options.conditionMode === 'duplicate_overlapping_frames' ? [oldConditionWide] : [])], normalizerVersion: 'direct-original-v1',
    conversionWarnings: [], createdAt: '2026-01-01T00:00:00Z' };
  store.saveSourceManifest({ ...manifest, spans: pages });
  const accountFingerprint = 'synthetic-grounded-account';
  const consentId = store.createManualProcessingConsent({ documentIds: [documentId], personIds: [person.id], accountFingerprint, version: 1 });
  store.createWaitingAuthBatch({ cutoff: '2026-01-01T00:00:00Z', initialStatus: 'queued', consentId,
    groups: [{ personId: person.id, documentIds: [documentId], inputSignature: 'synthetic-legacy-input' }] });
  const job = store.claimNextQueuedJob('synthetic-legacy-worker', accountFingerprint)!;
  const guard = { jobId: job.id, consentId, accountFingerprint,
    attemptId: store.startJobAttempt(job.id, 'synthetic', 'gpt-6.1-sol', 'medium') };
  store.saveDirectOriginalEvidenceForProcessing(manifest, { executionGuard: guard });
  const acceptanceId = store.saveAcceptanceDecision({ method: 'auto', actor: 'policy', rulesVersion: 'synthetic-legacy',
    inputSignature: 'synthetic-acceptance', outputHash: 'synthetic-output', reviewRef: null, decision: 'accept_with_warnings' });
  const oldRef = { sourceSpanId: oldSpan.id, quote: oldSpan.quote };
  const old: ObservationCandidate = { localKey: 'old-candidate', originalName: '合成项目', standardNameCandidate: null,
    value: { kind: 'numeric', rawText: '5.0', decimal: '5', comparator: 'eq' }, unitRaw: null, referenceRangeRaw: null,
    reportedAbnormalFlag: null, specimen: null, method: null, bodySite: null, clinicalDate: null,
    evidence: [oldRef], sourceBinding: { headingEvidence: [], findingEvidence: [oldRef] }, issues: [] };
  if (options.conditionMode) old.clinicalContext = { version: 1, status: 'complete', conditions: Array.from({
    length: ['duplicate', 'duplicate_overlapping_frames'].includes(options.conditionMode) ? 2 : 1 }, (_, index) =>
      ({ sourceSpanId: index === 1 && options.conditionMode === 'duplicate_overlapping_frames' ? oldConditionWide.id : oldCondition.id,
        quote: '未散瞳；仅右眼' })) };
  const observation = (candidate: ObservationCandidate): PublishFactsInput['observations'][number] => ({
    conceptKey: candidate.originalName, originalName: candidate.originalName, modelStandardNameCandidate: null,
    rawText: candidate.value.rawText!, valueKind: candidate.value.kind,
    decimalValue: candidate.value.kind === 'numeric' ? candidate.value.decimal : null,
    qualifier: candidate.value.kind === 'numeric' ? candidate.value.comparator : null,
    unit: candidate.unitRaw, referenceRange: candidate.referenceRangeRaw, clinicalDate: candidate.clinicalDate,
    abnormalFlag: 'unknown', documentId, sourceSpanId: candidate.evidence[0]!.sourceSpanId, acceptanceId,
    specimen: null, method: null, bodySite: candidate.bodySite, clinicalContext: candidate.clinicalContext ?? null,
    evidence: [...candidate.evidence, ...(candidate.sourceBinding?.headingEvidence ?? []), ...observationStructuredSlotEvidence(candidate),
      ...(candidate.clinicalContext?.conditions ?? [])],
    sourceBinding: candidate.sourceBinding, candidate });
  const oldHistory: ObservationCandidate = { ...structuredClone(old), localKey: 'old-history', originalName: '合成历史项目',
    value: { kind: 'numeric', rawText: history, decimal: String(Number(history)), comparator: 'eq' } };
  store.publishFacts({ personId: person.id, documentId, expectedRevision: 0, documentCommitKey: 'c'.repeat(64),
    changeSetHash: 'd'.repeat(64), summary: '合成旧整行正确结果', observations: [old, ...(options.secondOld ? [oldHistory] : [])].map(observation), executionGuard: guard });
  const oldId = store.listAcceptedObservations(person.id).find((fact) => fact.originalName === old.originalName)!.id;
  const oldHistoryId = store.listAcceptedObservations(person.id).find((fact) => fact.originalName === oldHistory.originalName)?.id;
  if (options.locked) store.setObservationConceptMapping({ personId: person.id, observationId: oldId,
    conceptId: conceptDictionary[0]!.id, reason: '合成人工锁' });
  const firstReceipt = { threadId: 'new-thread', turnId: 'new-turn' };
  const repairReceipt = { threadId: 'repair-thread', turnId: 'repair-turn' };
  const localRef = (quote: string | null) => ({ sourceSpanId: 'e-context', quote });
  const nextConditionQuote = options.conditionMode === 'drop_negation' ? '散瞳；仅右眼'
    : options.conditionMode === 'laterality' ? '未散瞳；仅左眼' : '未散瞳；仅右眼';
  const localCandidate = (column: string, value: string): ObservationCandidate => ({ ...structuredClone(old), localKey: `c-${column}`,
    originalName: column === '上次' && options.secondOld ? oldHistory.originalName : old.originalName,
    value: { kind: 'numeric', rawText: value, decimal: String(Number(value)), comparator: 'eq' },
    ...(options.conditionMode ? { clinicalContext: { version: 1, status: options.conditionMode === 'status' ? 'unresolved' : 'complete',
      conditions: Array.from({ length: options.conditionMode === 'missing' ? 0
        : ['duplicate', 'duplicate_overlapping_frames'].includes(options.conditionMode!) ? 2 : 1 }, (_, index) =>
        ({ sourceSpanId: index === 1 && options.conditionMode === 'duplicate_overlapping_frames' ? 'e-wide-context' : 'e-condition',
          quote: nextConditionQuote })) } } : {}),
    evidence: [localRef(column === '上次' && options.narrowHistory ? history : row)], sourceBinding: {
      headingEvidence: [], findingEvidence: [localRef(column === '上次' && options.narrowHistory ? history : row)], structuredSlot: {
      version: 1, kind: 'table_cell', contextEvidence: [localRef(null)], rowEvidence: [localRef('甲项')],
      columnEvidence: [localRef(options.forceSameColumn ? '本次' : column)], axes: [], component: null } } });
  const firstReading = directOriginalReadingResultSchema.parse({ schemaVersion: 1, documentId,
    pageReadings: pages.map((item) => ({ sourceSpanId: item.id, status: 'read' })),
    sourceExcerpts: [{ localKey: 'e-context', pageSourceSpanId: page.id, quote: `合成表\n项目 本次 上次\n${row}`,
      role: 'finding', clarity: 'clear' }, ...(options.conditionMode ? [{ localKey: 'e-condition',
      pageSourceSpanId: pages.at(-1)!.id, quote: options.conditionMode === 'different_frame'
        ? `另一事项：${nextConditionQuote}` : options.conditionMode === 'condition_only' ? nextConditionQuote
          : `合成说明\n检查条件：${nextConditionQuote}\n其余信息未知`,
      role: 'context', clarity: 'clear' }] : []), ...(options.conditionMode === 'duplicate_overlapping_frames' ? [{
        localKey: 'e-wide-context', pageSourceSpanId: page.id,
        quote: `另一合成背景\n合成说明\n检查条件：${nextConditionQuote}\n其余信息未知\n附注`, role: 'context', clarity: 'clear'
      }] : [])], extraction: { schemaVersion: 1, documentId,
      subject: { reportedName: null, confidence: 'absent', evidence: [] }, reportMetadata: null,
      coveredSourceSpanIds: pages.map((item) => item.id), candidates: [localCandidate('本次', options.changedMedical ? '6.0' : '5.0'), localCandidate('上次', history)] } });
  const sourceIds = new Map<string, string>();
  for (const excerpt of firstReading.sourceExcerpts) {
    const materializedId = `model-original-${stableHash({ documentId, originalSha256: source.sha256, parentId: excerpt.pageSourceSpanId,
      localKey: excerpt.localKey, receipt: firstReceipt, quote: excerpt.quote, role: excerpt.role }).slice(0, 40)}`;
    sourceIds.set(excerpt.localKey, materializedId);
    const parent = pages.find((item) => item.id === excerpt.pageSourceSpanId)!;
    manifest.spans.push({ ...structuredClone(oldSpan), id: materializedId, quote: excerpt.quote, page: parent.page,
      blockId: `model-original-excerpt:${parent.id}`, modelEvidence: { ...oldSpan.modelEvidence!, ...firstReceipt,
        role: excerpt.role, parentSourceSpanId: parent.id } });
  }
  const candidates = firstReading.extraction.candidates.map((candidate) => {
    let json = JSON.stringify(candidate); for (const [key, value] of sourceIds) json = json.replaceAll(JSON.stringify(key), JSON.stringify(value));
    return JSON.parse(json) as ObservationCandidate;
  });
  const preliminary = store.previewDirectOriginalAdmission({ personId: person.id, documentId, manifest,
    observations: candidates.map(observation), executionGuard: guard });
  const comparison = preliminary.held.flatMap((item) => item.diagnostic?.comparisons ?? []).find((item) => item.recordId === oldId)!;
  expect(comparison?.recordHash).toMatch(/^[a-f0-9]{64}$/);
  const firstTransmissionId = store.beginAiTransmission({ guard, documentId, stage: 'extract' });
  const repairTransmissionId = store.beginAiTransmission({ guard, documentId, stage: 'repair_extraction' });
  const mappingKeys = [{ candidateKey: 'c-本次', comparisonRecordKey: 'ro_record_1', recordId: oldId },
    ...(options.mapSecond ? [{ candidateKey: 'c-上次', comparisonRecordKey: 'ro_record_2', recordId: oldHistoryId! }] : [])];
  const comparisons = preliminary.held.flatMap((item) => item.diagnostic?.comparisons ?? []);
  const review: DirectOriginalSourceRefinementReview = { sourceObjectId: source.id, originalSha256: source.sha256,
    factRevision: store.getFactRevision(person.id), firstReading,
    repair: { schemaVersion: 1, documentId, originalReadingHash: stableHash(firstReading),
      results: mappingKeys.map((mapping) => ({ targetId: mapping.candidateKey, action: 'unchanged', replacement: null })),
      sourceMappings: mappingKeys.map(({ candidateKey, comparisonRecordKey }) => ({ candidateKey, comparisonRecordKey, relation: 'same_original_field' })) },
    targets: mappingKeys.map((mapping) => ({ targetId: mapping.candidateKey, nodeType: 'candidate' })), allowedPageSourceSpanIds: pages.map((item) => item.id),
    refinementTargets: mappingKeys.map((mapping) => {
      const compared = comparisons.find((item) => item.recordId === mapping.recordId)!;
      return { ...mapping, recordRevision: compared.recordRevision!, recordHash: compared.recordHash! };
    }),
    firstTransmissionId, firstInputSignature: 'a'.repeat(64), repairTransmissionId, repairInputSignature: '' };
  review.repair = directOriginalReadingRepairSchema.parse(review.repair);
  review.repairInputSignature = directOriginalSourceRefinementReviewSignature(review);
  store.finishDirectOriginalTransmission({ guard, documentId, transmissionId: firstTransmissionId,
    inputSignature: review.firstInputSignature, outputHash: stableHash(firstReading), ...firstReceipt,
    proofVersion: DIRECT_ORIGINAL_SOURCE_REFINEMENT_VERSION });
  store.finishDirectOriginalTransmission({ guard, documentId, transmissionId: repairTransmissionId,
    inputSignature: review.repairInputSignature, outputHash: stableHash(review.repair), ...repairReceipt,
    proofVersion: DIRECT_ORIGINAL_SOURCE_REFINEMENT_VERSION });
  store.saveDirectOriginalEvidenceForProcessing(manifest, { executionGuard: guard });
  const append = (inputCandidates = candidates, withReview = true) => {
    const issueId = store.saveExtractionReviewIssue({ documentId, stage: 'extract', kind: 'coverage_gap', severity: 'warning',
      preserveDocumentStatus: true, candidateOptions: [], evidenceRefs: [], reasonCodes: ['SYNTHETIC_LEGACY_SLOT_RECHECK'] });
    return store.appendCommittedFacts({ personId: person.id, documentId, expectedRevision: store.getFactRevision(person.id),
      summary: '合成正式槽位升级', observations: inputCandidates.map(observation), executionGuard: guard,
      ...(withReview ? { sourceRefinementReview: review } : {}),
      reviewUpdate: { issueId, reconciliationMode: 'source_proven', remainingCandidates: [], remainingReasonCodes: [], remainingEvidenceRefs: [] } });
  };
  const closeRead = () => db.close();
  return { store, db, person, documentId, oldId, old, guard, manifest, candidates, review, append, observation, closeRead };
}

describe('正式两轮来源映射：旧整行升级为真实槽位', () => {
  it.each([false, true].flatMap((equalValues) => [false, true].map((reverse) => ({ equalValues, reverse }))))(
    '医疗字段不变且真实一对一映射时补入另一列，不依赖输入顺序 $equalValues/$reverse', ({ equalValues, reverse }) => {
      const f = fixture({ equalValues });
      try {
        const before = f.db.prepare('SELECT * FROM observation_revisions WHERE observation_id=? AND revision=1').get(f.oldId) as Record<string, unknown>;
        expect(f.append(reverse ? [...f.candidates].reverse() : f.candidates)).toMatchObject({ updatedCount: 1, appendedCount: 1, heldCount: 0 });
        expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(2);
        expect(f.db.prepare('SELECT * FROM observation_revisions WHERE observation_id=? AND revision=1').get(f.oldId)).toEqual(before);
        const next = f.db.prepare('SELECT * FROM observation_revisions WHERE observation_id=? AND revision=2').get(f.oldId) as Record<string, unknown>;
        for (const key of ['value_kind', 'raw_text', 'decimal_value', 'qualifier', 'unit', 'reference_range', 'clinical_date',
          'clinical_context_json', 'body_site', 'method', 'specimen']) expect(next[key]).toEqual(before[key]);
        expect(JSON.parse(next.source_binding_json as string).directOriginalField.structuredSlot.columnEvidence[0].quote).toBe('本次');
        expect(f.append(f.candidates, false)).toMatchObject({ duplicateCount: 2, appendedCount: 0, updatedCount: 0, heldCount: 0 });
      } finally { f.closeRead(); }
    });

  it('没有正式P03映射不能借新槽位越过旧整行的不确定性', () => {
    const f = fixture();
    try { expect(f.append(f.candidates, false)).toMatchObject({ updatedCount: 0, appendedCount: 0, heldCount: 2 }); }
    finally { f.closeRead(); }
  });

  it.each(['locked', 'changedMedical', 'ambiguousOld'] as const)('映射因 %s 未接纳时，依赖它的新列也不能新增，旧正确结果不动', (mode) => {
    const f = fixture({ [mode]: true });
    try {
      const old = f.store.listAcceptedObservations(f.person.id);
      expect(f.append()).toMatchObject({ updatedCount: 0, appendedCount: 0, heldCount: 2 });
      expect(f.store.listAcceptedObservations(f.person.id)).toEqual(old);
    } finally { f.closeRead(); }
  });

  it.each([false, true])('真正同格数值冲突会整组撤回升级及依赖新增，输入倒序=%s', (reverse) => {
    const f = fixture();
    try {
      const old = f.store.listAcceptedObservations(f.person.id);
      const conflict = structuredClone(f.candidates[0]!); conflict.localKey = 'conflicting-cell';
      conflict.value = { kind: 'numeric', rawText: '6.0', decimal: '6', comparator: 'eq' };
      const inputs = [...f.candidates, conflict]; if (reverse) inputs.reverse();
      expect(f.append(inputs)).toMatchObject({ updatedCount: 0, appendedCount: 0, heldCount: 3 });
      expect(f.store.listAcceptedObservations(f.person.id)).toEqual(old);
    } finally { f.closeRead(); }
  });

  it.each([false, true])('末尾未知整块输入使映射未接纳时，撤回依赖的新列及其判重，倒序=%s', (reverse) => {
    const f = fixture({ narrowHistory: true });
    try {
      const old = f.store.listAcceptedObservations(f.person.id);
      const uncertain = structuredClone(f.candidates[0]!); uncertain.localKey = 'uncertain-whole-context';
      uncertain.evidence[0]!.quote = null; uncertain.sourceBinding!.findingEvidence[0]!.quote = null;
      delete uncertain.sourceBinding!.structuredSlot;
      const duplicateHistory = structuredClone(f.candidates[1]!); duplicateHistory.localKey = 'duplicate-history';
      const inputs = [f.candidates[1]!, duplicateHistory, f.candidates[0]!, uncertain]; if (reverse) inputs.reverse();
      expect(f.append(inputs)).toMatchObject({ updatedCount: 0, appendedCount: 0, duplicateCount: 0, heldCount: 4 });
      expect(f.store.listAcceptedObservations(f.person.id)).toEqual(old);
    } finally { f.closeRead(); }
  });

  it.each([false, true])('两条已保存旧整行各有真实一对一映射时同时升级，倒序=%s', (reverse) => {
    const f = fixture({ secondOld: true, mapSecond: true });
    try {
      const before = f.db.prepare('SELECT * FROM observation_revisions WHERE revision=1 ORDER BY observation_id').all();
      expect(f.append(reverse ? [...f.candidates].reverse() : f.candidates)).toMatchObject({ updatedCount: 2, appendedCount: 0, heldCount: 0 });
      expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(2);
      expect(f.db.prepare('SELECT * FROM observation_revisions WHERE revision=1 ORDER BY observation_id').all()).toEqual(before);
    } finally { f.closeRead(); }
  });

  it.each(['unmapped_old', 'same_new_cell'] as const)('旧行竞争或映到同一实际新格不提供升级权限：%s', (mode) => {
    const f = fixture({ secondOld: true, mapSecond: mode === 'same_new_cell', forceSameColumn: mode === 'same_new_cell', equalValues: true });
    try {
      const before = f.store.listAcceptedObservations(f.person.id);
      expect(f.append()).toMatchObject({ updatedCount: 0, appendedCount: 0, heldCount: 2 });
      expect(f.store.listAcceptedObservations(f.person.id)).toEqual(before);
    } finally { f.closeRead(); }
  });

  it.each([false, true])('检查条件原话和真实位置不变、仅来源ID重绑时可正式升级，旧context JSON原样保留，倒序=%s', (reverse) => {
    const f = fixture({ conditionMode: 'rebound' });
    try {
      const before = f.db.prepare('SELECT clinical_context_json FROM observation_revisions WHERE observation_id=? AND revision=1').get(f.oldId);
      expect(f.candidates[0]!.clinicalContext!.conditions[0]!.sourceSpanId).not.toBe(f.old.clinicalContext!.conditions[0]!.sourceSpanId);
      expect(f.append(reverse ? [...f.candidates].reverse() : f.candidates)).toMatchObject({ updatedCount: 1, appendedCount: 1, heldCount: 0 });
      expect(f.db.prepare('SELECT clinical_context_json FROM observation_revisions WHERE observation_id=? AND revision=2').get(f.oldId)).toEqual(before);
      const repeated = f.append(f.candidates, false);
      expect(repeated.heldCandidates.map((candidate) => candidate.issues.map((issue) => issue.code))).toEqual([]);
      expect(repeated).toMatchObject({ duplicateCount: 2, appendedCount: 0, updatedCount: 0, heldCount: 0 });
    } finally { f.closeRead(); }
  });

  it.each(['wrong_page', 'different_frame', 'condition_only', 'drop_negation', 'laterality', 'duplicate',
    'duplicate_overlapping_frames', 'missing', 'status'] as const)(
    '来源条件未证明等价时不借重绑删改医疗条件：%s', (conditionMode) => {
      const f = fixture({ conditionMode });
      try {
        const before = f.store.listAcceptedObservations(f.person.id);
        expect(f.append()).toMatchObject({ updatedCount: 0, appendedCount: 0, heldCount: 2 });
        expect(f.store.listAcceptedObservations(f.person.id)).toEqual(before);
      } finally { f.closeRead(); }
    });
});
