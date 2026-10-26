import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { WORKSPACE_SCHEMA_VERSION } from '@storage';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccountState, AssessmentRepairRequestV1, AssessmentRequestV3, ClinicalFocusedReviewV1, DerivedSnapshotCandidate, ExtractionResult, MemberAssessmentCandidateV3, MemberAssessmentRepairV1, MemberEvidencePackageV3 } from '@contracts';
import { healthClaimTitle, DOCUMENTED_PLAN_NEUTRAL_TITLE, assessmentRepairRequestV1Schema, memberAssessmentCandidateV3Schema, memberAssessmentRepairV1Schema } from '@contracts';
import { stableHash } from '@core';
import { buildTextManifest } from '@ingestion';
import type { CodexRuntimeManager } from './codex-runtime.js';
import { ProcessingJobRunner } from './job-runner.js';
import { DocumentExtractionPipeline } from './processing-pipeline.js';
import { assessmentRepairNode, buildActionDependencyRebindings, buildAssessmentRepairRequest, finalizeActionDependencyRebindings, focusedReviewBoundaryPreserved, focusedReviewDependencyClosure, focusedReviewSourceContext, knowledgeDependentClinicalTargets, MemberAssessmentPipeline, mergeAssessmentRepair, repairTargets } from './member-assessment-pipeline.js';
import { buildMemberAssessmentInput } from './member-assessment-input.js';
import { expandMemberEvidence } from './member-evidence-transport.js';
import { buildMemberAnalysisPackage, createMemberAnalysisTransport } from './member-analysis-package.js';
import { buildMemberAggregatePackage, buildMemberSystemPartitions, splitMemberPartition } from './member-assessment-partition.js';
import { validateAssessmentCandidate } from './assessment-validation.js';
import { routeFocusedReview } from './clinical-review-router.js';
import { inspectAssessmentReviewBoundary } from './assessment-review-boundary.js';
import { buildAssessmentKnowledgeVerifications, canonicalizeAssessmentKnowledge } from './assessment-knowledge.js';
import { buildMemberSummaryData } from './export-service.js';
import { PersonalWorkspaceService as BasePersonalWorkspaceService } from './workspace-service.js';
import { restoreCodexOptionalFields } from './structured-output-schema.js';
import { CodexTurnFailure } from './codex-turn-failure.js';

const roots: string[] = [];
const openServices = new Set<BasePersonalWorkspaceService>();

class PersonalWorkspaceService extends BasePersonalWorkspaceService {
  constructor(...args: ConstructorParameters<typeof BasePersonalWorkspaceService>) {
    super(...args);
    openServices.add(this);
  }

  override async importFiles(...args: Parameters<BasePersonalWorkspaceService['importFiles']>) {
    const previous = new Set(this.store.listProcessingRebuildSources().map((source) => source.documentId));
    const receipt = await super.importFiles(...args);
    // 本文件测试综合阶段与历史事实兼容，不测试生产的原件直读入口。
    // 明确生成临时合成 TXT 的旧版证据，不能让生产导入为旧测试回退到 OCR。
    for (const source of this.store.listProcessingRebuildSources().filter((item) => !previous.has(item.documentId)
      && item.mediaType === 'text/plain')) {
      const manifest = buildTextManifest({ ...source, text: readFileSync(source.sourcePath, 'utf8'),
        createdAt: '2026-09-22T00:00:00Z' });
      const database = new Database(this.store.databasePath);
      try {
        database.transaction(() => {
          database.prepare('DELETE FROM source_manifest_spans WHERE document_id=?').run(source.documentId);
          database.prepare('DELETE FROM source_manifests WHERE document_id=?').run(source.documentId);
          database.prepare('DELETE FROM source_spans WHERE document_id=?').run(source.documentId);
        })();
      } finally { database.close(); }
      this.store.saveSourceManifest(manifest);
    }
    return receipt;
  }

  override close(): void {
    if (!openServices.delete(this)) return;
    super.close();
  }
}

afterEach(() => {
  for (const service of [...openServices]) service.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function fixture(legacyContext = false, documentedPlan = false, thyroid = false, planText = '3个月后复查血脂。', sourceSuffix = '') {
  const root = mkdtempSync(join(tmpdir(), 'family-health-lean-assessment-'));
  roots.push(root);
  const service = new PersonalWorkspaceService(root, '合成工作区', () => new Date('2026-09-22T00:00:00Z'));
  const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
  const sourceQuote = (thyroid ? '2026-09-21 TSH 6.2 mIU/L, reference 0.27-4.2' : '2026-09-21 LDL-C 4.2 mmol/L, reference 0-3.4')
    + (legacyContext ? '；采样时未服药。' : '') + (documentedPlan ? `；医生建议：${planText}` : '') + sourceSuffix;
  await service.importFiles([{ path: thyroid ? '/tmp/合成甲状腺报告.txt' : '/tmp/合成血脂报告.txt', bytes: Buffer.from(sourceQuote) }], personId);
  const documentId = service.getSnapshot(null).inbox[0]!.id;
  const sourceSpanId = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!.id;
  const extraction: ExtractionResult = {
    schemaVersion: 1, documentId, coveredSourceSpanIds: [sourceSpanId],
    subject: { reportedName: null, evidence: [], confidence: 'absent' },
    candidates: [{
      localKey: thyroid ? 'tsh' : 'ldl', originalName: thyroid ? 'TSH' : 'LDL-C', standardNameCandidate: thyroid ? 'TSH' : 'LDL-C',
      value: { kind: 'numeric', rawText: thyroid ? '6.2' : '4.2', decimal: thyroid ? '6.2' : '4.2', comparator: 'eq' },
      unitRaw: thyroid ? 'mIU/L' : 'mmol/L', referenceRangeRaw: thyroid ? '0.27-4.2' : '0-3.4', reportedAbnormalFlag: 'high',
      specimen: null, method: null, bodySite: null, clinicalDate: '2026-09-21',
      evidence: [{ sourceSpanId, quote: sourceQuote }],
      clinicalContext: legacyContext ? null : { version: 1, status: 'complete', conditions: [] }, issues: []
    }]
  };
  let extractionCalls = 0;
  const extracted = await new DocumentExtractionPipeline(service.store, {
    runStructuredTurn: async (input) => {
      extractionCalls += 1;
      return { threadId: 'p01-thread', turnId: 'p01-turn', output: assessmentOutputFor(input.prompt, extraction) };
    }
  }).process(documentId);
  expect(extracted.status).toBe('published');
  expect(extractionCalls).toBe(1);
  const built = buildMemberAssessmentInput(service.store, personId, {
    modelId: 'test-model', reasoningEffort: 'medium', analysisReferenceDate: '2026-09-22', webSearchAllowed: true
  });
  return { service, personId, documentId, built };
}

async function fixtureTwoSystems() {
  const { service, personId } = await fixture();
  await service.importFiles([{ path: '/tmp/合成肝功报告.txt', bytes: Buffer.from('2026-09-21 谷丙转氨酶 42 U/L') }], personId);
  const documentId = service.getSnapshot(null).inbox.find((item) => item.displayName === '合成肝功报告.txt')!.id;
  const span = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!;
  const result: ExtractionResult = {
    schemaVersion: 1, documentId, coveredSourceSpanIds: [span.id],
    subject: { reportedName: null, evidence: [], confidence: 'absent' },
    candidates: [{
      localKey: 'alt', originalName: '谷丙转氨酶', standardNameCandidate: 'ALT',
      value: { kind: 'numeric', rawText: '42', decimal: '42', comparator: 'eq' },
      unitRaw: 'U/L', referenceRangeRaw: null, reportedAbnormalFlag: null,
      specimen: null, method: null, bodySite: null, clinicalDate: '2026-09-21',
      evidence: [{ sourceSpanId: span.id, quote: '2026-09-21 谷丙转氨酶 42 U/L' }], clinicalContext: { version: 1, status: 'complete', conditions: [] }, issues: []
    }]
  };
  const extracted = await new DocumentExtractionPipeline(service.store, {
    runStructuredTurn: async (input) => ({ threadId: 'alt-thread', turnId: 'alt-turn', output: assessmentOutputFor(input.prompt, result) })
  }).process(documentId);
  expect(extracted.status).toBe('published');
  const built = buildMemberAssessmentInput(service.store, personId, {
    modelId: 'test-model', reasoningEffort: 'medium', analysisReferenceDate: '2026-09-22', webSearchAllowed: true
  });
  expect(built.request.requestedSystemIds.length).toBeGreaterThanOrEqual(2);
  return { service, personId, built };
}

async function fixtureSourceInstruction(rawText: string) {
  const { service, personId } = await fixture();
  const quote = `检查日期：2026-09-21；原医生安排：${rawText}`;
  await service.importFiles([{ path: '/tmp/合成原医生安排.txt', bytes: Buffer.from(quote) }], personId);
  const documentId = service.getSnapshot(null).inbox.find((item) => item.displayName === '合成原医生安排.txt')!.id;
  const spans = service.store.getDocumentExtractionBundle(documentId).manifest.spans;
  const extraction: ExtractionResult = { schemaVersion: 1, documentId,
    coveredSourceSpanIds: spans.map((span) => span.id), subject: { reportedName: null, evidence: [], confidence: 'absent' },
    candidates: [{ localKey: 'original-instruction', originalName: '原医生安排', standardNameCandidate: null,
      value: { kind: 'text', rawText }, unitRaw: null, referenceRangeRaw: null, reportedAbnormalFlag: null,
      specimen: null, method: null, bodySite: null, clinicalDate: '2026-09-21',
      clinicalContext: { version: 1, status: 'complete', conditions: [] },
      evidence: spans.map((span) => ({ sourceSpanId: span.id, quote: span.quote })), issues: [] }] };
  expect(await new DocumentExtractionPipeline(service.store, { runStructuredTurn: async () => ({
    threadId: 'instruction-p01', turnId: 'synthetic', output: extraction
  }) }).process(documentId)).toMatchObject({ status: 'published' });
  const built = buildMemberAssessmentInput(service.store, personId, { modelId: 'test-model', reasoningEffort: 'medium',
    analysisReferenceDate: '2026-09-22', webSearchAllowed: true });
  return { service, personId, built, fact: built.evidencePackage.facts.find((item) => item.originalName === '原医生安排')! };
}

async function fixtureNeckFindings() {
  const { service, personId } = await fixture();
  const quote = '检查日期：2026-09-21；颈椎影像小结：颈椎曲度变直、轻度骨质增生；颈5/6椎间盘轻度突出（中央型）。所见脊髓形态和信号未见异常。';
  await service.importFiles([{ path: '/tmp/合成颈椎影像发现.txt', bytes: Buffer.from(quote) }], personId);
  const documentId = service.getSnapshot(null).inbox.find((item) => item.displayName === '合成颈椎影像发现.txt')!.id;
  const spans = service.store.getDocumentExtractionBundle(documentId).manifest.spans;
  const rawText = '颈椎曲度变直、轻度骨质增生；颈5/6椎间盘轻度突出（中央型）。所见脊髓形态和信号未见异常。';
  const extraction: ExtractionResult = { schemaVersion: 1, documentId,
    coveredSourceSpanIds: spans.map((span) => span.id),
    subject: { reportedName: null, evidence: [], confidence: 'absent' },
    candidates: [{ localKey: 'neck-imaging', originalName: '颈椎影像小结', standardNameCandidate: null,
      value: { kind: 'text', rawText }, unitRaw: null, referenceRangeRaw: null, reportedAbnormalFlag: null,
      specimen: null, method: null, bodySite: '颈椎', clinicalDate: '2026-09-21',
      clinicalContext: { version: 1, status: 'complete', conditions: [] },
      evidence: spans.map((span) => ({ sourceSpanId: span.id, quote: span.quote })), issues: [] }]
  };
  const extracted = await new DocumentExtractionPipeline(service.store, { runStructuredTurn: async (input) => ({
    threadId: 'neck-p01', turnId: 'synthetic', output: assessmentOutputFor(input.prompt, extraction)
  }) }).process(documentId);
  expect(extracted).toMatchObject({ status: 'published' });
  const built = buildMemberAssessmentInput(service.store, personId, {
    modelId: 'test-model', reasoningEffort: 'medium', analysisReferenceDate: '2026-09-22', webSearchAllowed: true
  });
  expect(built.evidencePackage.facts.some((fact) => fact.originalName === '颈椎影像小结')).toBe(true);
  return { service, personId, built };
}

async function fixtureUnclassified() {
  const root = mkdtempSync(join(tmpdir(), 'family-health-unclassified-assessment-'));
  roots.push(root);
  const service = new PersonalWorkspaceService(root, '合成工作区', () => new Date('2026-09-22T00:00:00Z'));
  const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
  await service.importFiles([{ path: '/tmp/合成未归类检查.txt', bytes: Buffer.from('2026-09-21 合成未归类检查：记录甲。') }], personId);
  const documentId = service.getSnapshot(null).inbox[0]!.id;
  const span = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!;
  const extraction: ExtractionResult = {
    schemaVersion: 1, documentId, coveredSourceSpanIds: [span.id],
    subject: { reportedName: null, evidence: [], confidence: 'absent' },
    candidates: [{
      localKey: 'unclassified-result', originalName: '合成未归类检查', standardNameCandidate: null,
      value: { kind: 'text', rawText: '记录甲' }, unitRaw: null, referenceRangeRaw: null,
      reportedAbnormalFlag: null, specimen: null, method: null, bodySite: null,
      clinicalDate: '2026-09-21', evidence: [{ sourceSpanId: span.id, quote: span.quote }], clinicalContext: { version: 1, status: 'complete', conditions: [] }, issues: []
    }]
  };
  const result = await new DocumentExtractionPipeline(service.store, {
    runStructuredTurn: async (input) => ({ threadId: 'p01', turnId: 'p01', output: assessmentOutputFor(input.prompt, extraction) })
  }).process(documentId);
  expect(result.status).toBe('published');
  const built = buildMemberAssessmentInput(service.store, personId, {
    modelId: 'test-model', reasoningEffort: 'medium', analysisReferenceDate: '2026-09-22', webSearchAllowed: true
  });
  return { service, personId, built };
}

async function fixtureReportFindings() {
  const { service, personId } = await fixture();
  const entries = [
    { name: '内镜检查', value: '胃黏膜充血、水肿，未见溃疡。' },
    { name: '鼻腔检查', value: '鼻腔黏膜增厚。' },
    { name: '咽部检查', value: '咽部充血。' },
    { name: '原报告诊断', value: '慢性胃炎' }
  ];
  for (const item of entries) {
    const quote = `检查日期：2026-09-21；${item.name}：${item.value}`;
    await service.importFiles([{ path: `/tmp/合成${item.name}.txt`, bytes: Buffer.from(quote) }], personId);
    const documentId = service.getSnapshot(null).inbox.find((document) => document.displayName === `合成${item.name}.txt`)!.id;
    const spans = service.store.getDocumentExtractionBundle(documentId).manifest.spans;
    const extraction: ExtractionResult = { schemaVersion: 1, documentId,
      coveredSourceSpanIds: spans.map((span) => span.id), subject: { reportedName: null, evidence: [], confidence: 'absent' },
      candidates: [{ localKey: 'finding', originalName: item.name, standardNameCandidate: null,
        value: { kind: 'text', rawText: item.value }, unitRaw: null, referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: null, bodySite: null, clinicalDate: '2026-09-21',
        clinicalContext: { version: 1, status: 'complete', conditions: [] },
        evidence: spans.map((span) => ({ sourceSpanId: span.id, quote: span.quote })), issues: [] }] };
    expect(await new DocumentExtractionPipeline(service.store, { runStructuredTurn: async () => ({
      threadId: 'synthetic-findings', turnId: 'p01', output: extraction
    }) }).process(documentId)).toMatchObject({ status: 'published' });
  }
  const built = buildMemberAssessmentInput(service.store, personId, {
    modelId: 'test-model', reasoningEffort: 'medium', analysisReferenceDate: '2026-09-22', webSearchAllowed: true
  });
  return { service, personId, built };
}

function firstRecordChange(evidenceIds: string[]): NonNullable<MemberAssessmentCandidateV3['claims'][number]['changeAssessment']> {
  return { direction: 'first_record', basis: 'insufficient', summary: '目前只有这项检查的一次结果，不能判断前后变化。',
    reason: '没有对应的历史结果可比。', currentEvidenceIds: evidenceIds, previousEvidenceIds: [] };
}

function candidateFor(request: AssessmentRequestV3, source: Pick<MemberEvidencePackageV3, 'facts'>
  | Pick<ReturnType<typeof buildMemberAnalysisPackage>, 'facts'>): MemberAssessmentCandidateV3 {
  const first = source.facts[0]!;
  const evidenceId = 'evidenceIds' in first ? first.evidenceIds[0]! : first.observationId;
  const systemIds = request.requestedSystemIds;
  return {
    schemaVersion: 3, personId: request.personId, inputSignature: request.inputSignature,
    mode: request.mode, requestedSystemIds: systemIds,
    overview: {
      id: 'overview', headline: '这次血脂检查有一项需要关注',
      summary: 'LDL-C 高于这份报告的参考上限；目前只有一次结果，下一步先补足整体风险背景。',
      claimIds: ['claim-ldl'], actionIds: ['action-review'], limitations: ['只有一次结果。']
    },
    systems: systemIds.map((systemId) => ({
      id: `system:${systemId}`, systemId, status: 'attention',
      headline: 'LDL-C 有原报告留意标记', summary: '这次结果高于报告参考上限。',
      claimIds: ['claim-ldl'], actionIds: ['action-review'], limitations: []
    })),
    claims: [{
      id: 'claim-ldl', topicKey: 'lipids', systemIds, kind: 'interpretation',
      text: 'LDL-C 4.2 mmol/L，高于该报告参考上限 3.4。',
      changeAssessment: firstRecordChange([evidenceId]),
      diseaseName: null, diagnosticStatus: null, temporalStatus: 'current',
      evidenceIds: [evidenceId], counterEvidenceIds: [], trendIds: [],
      knowledgeBasis: 'model_general', knowledgeSourceIds: [], criteriaBasis: null,
      rationale: '报告同时给出结果与参考范围。', materialUncertainty: null, consequenceLevel: 'routine'
    }],
    actions: [{
      id: 'action-review', dedupeKey: 'lipid-risk-context', systemIds, claimIds: ['claim-ldl'],
      kind: 'test_followup', title: '整理血脂及相关病史后复核',
      why: '单次结果不足以决定长期管理方向。', firstStep: '整理既往血脂报告和相关病史。',
      timing: '下次就诊时', timingBasis: 'none', reviewPlan: null, caution: null,
      urgency: 'routine', evidenceIds: [evidenceId], knowledgeSourceIds: []
    }],
    questions: [], knowledgeSources: []
  };
}

function attachCatalogSource(candidate: MemberAssessmentCandidateV3, evidencePackage: MemberEvidencePackageV3,
  sourceId = 'knowledge-lab-results-context', targetClaimId = 'claim-ldl') {
  const entry = evidencePackage.knowledge.find((item) => item.id === sourceId)!;
  expect(entry).toBeDefined();
  candidate.knowledgeSources.push({ id: entry.id, title: entry.title, organization: entry.sourceOrganization,
    url: entry.sourceUrl, origin: 'catalog', supports: entry.supportedScope });
  const claim = candidate.claims.find((item) => item.id === targetClaimId)!;
  claim.knowledgeBasis = 'catalog';
  claim.knowledgeSourceIds = [entry.id];
  return entry;
}

describe('主 P04 前提补齐权限绑定真实输入及最终合法回执', () => {
  it.each(['unchanged_target', 'unchanged_readonly', 'date_erasure'] as const)('%s 可补齐原建议关联，原件事实不变', async (mode) => {
    const { service, built } = await fixture();
    const original = candidateFor(built.request, built.evidencePackage);
    original.actions[0]!.claimIds = [];
    if (mode === 'date_erasure') Object.assign(original.claims[0]!, { kind: 'source_fact',
      text: '2026年9月21日 LDL-C 4.2 mmol/L，高于该报告参考上限 3.4。' });
    const targets = ['action-review', 'overview', ...(mode === 'unchanged_readonly' ? [] : ['claim-ldl'])];
    const context = focusedReviewSourceContext(original, targets, built.evidencePackage, '2026-09-22');
    const offered = buildActionDependencyRebindings(original, targets, context, built.evidencePackage.evidenceCatalog);
    expect(offered[0]!.claims.map((claim) => claim.id)).toEqual(['claim-ldl']);
    const reviewed = structuredClone(original);
    reviewed.actions[0]!.claimIds = ['claim-ldl'];
    if (mode === 'date_erasure') Object.assign(reviewed.claims[0]!, {
      text: 'LDL-C 4.2 mmol/L，高于该报告参考上限 3.4。', temporalStatus: 'uncertain', materialUncertainty: '具体日期无法确认。' });
    const review: ClinicalFocusedReviewV1 = { schemaVersion: 1, personId: original.personId, inputSignature: original.inputSignature,
      results: targets.map((targetId) => ({ targetId, verdict: targetId === 'action-review' || mode === 'date_erasure' && targetId === 'claim-ldl'
        ? 'replace' : 'pass', reason: '合成完整核对。', replacement: targetId === 'action-review' || mode === 'date_erasure' && targetId === 'claim-ldl'
          ? assessmentRepairNode(reviewed, targetId) as ClinicalFocusedReviewV1['results'][number]['replacement'] : null })) };
    expect(focusedReviewBoundaryPreserved(original, reviewed, 'action-review', built.evidencePackage.evidenceCatalog,
      '2026-09-22', [], [], offered)).toBe(false);
    const finalized = finalizeActionDependencyRebindings(original, reviewed, review, targets, offered,
      built.evidencePackage.evidenceCatalog, '2026-09-22', []);
    expect(finalized[0]!.claims[0]!.inputHash).toBe(stableHash(original.claims[0]));
    expect(finalized[0]!.claims[0]!.reviewedHash).toBe(stableHash(reviewed.claims[0]));
    expect(focusedReviewBoundaryPreserved(original, reviewed, 'action-review', built.evidencePackage.evidenceCatalog,
      '2026-09-22', [], [], finalized)).toBe(true);
    service.close();
  });

  it.each(['unknown_claim', 'hidden_claim', 'source_missing', 'counter_missing', 'source_duplicate', 'source_changed',
    'claim_changed', 'measure_changed', 'claim_held', 'claim_pass_changed', 'replacement_mismatch', 'readonly_changed',
    'local_invalid_claim', 'knowledge_only_action', 'action_pass', 'action_hold', 'post_p03_claim_changed'] as const)(
    '%s 不获得补齐授权或使已冻结权限失效', async (mode) => {
      const { service, built } = await fixture();
      const original = candidateFor(built.request, built.evidencePackage);
      original.actions[0]!.claimIds = [];
      if (mode === 'measure_changed') original.claims[0]!.kind = 'source_fact';
      const sources = structuredClone(built.evidencePackage.evidenceCatalog);
      const counter = { ...sources[0]!, id: 'synthetic-counter', quote: '合成反证，条件未知。' };
      sources.push(counter);
      original.claims[0]!.counterEvidenceIds = [counter.id];
      const targets = ['action-review', 'overview', ...(mode === 'readonly_changed' || mode === 'hidden_claim' ? [] : ['claim-ldl'])];
      const context = focusedReviewSourceContext(original, targets, { ...built.evidencePackage, evidenceCatalog: sources }, '2026-09-22');
      if (mode === 'hidden_claim') context.readOnlyClaims = [];
      if (mode === 'source_missing') context.evidenceCatalog = context.evidenceCatalog.filter((source) => source.id === counter.id);
      if (mode === 'counter_missing') context.evidenceCatalog = context.evidenceCatalog.filter((source) => source.id !== counter.id);
      if (mode === 'source_duplicate') sources.push(structuredClone(sources[0]!));
      if (mode === 'source_changed') context.evidenceCatalog = context.evidenceCatalog.map((source) => ({ ...source, quote: '伪造同ID。' }));
      const offered = buildActionDependencyRebindings(original, targets, context, sources);
      const reviewed = structuredClone(original);
      reviewed.actions[0]!.claimIds = [mode === 'unknown_claim' ? 'claim:unknown' : 'claim-ldl'];
      if (['claim_changed', 'measure_changed', 'claim_pass_changed', 'readonly_changed', 'replacement_mismatch'].includes(mode)) {
        reviewed.claims[0]!.text = mode === 'measure_changed' ? 'LDL-C 5.2 mmol/L。' : '另一项医学解释。';
      }
      const review: ClinicalFocusedReviewV1 = { schemaVersion: 1, personId: original.personId, inputSignature: original.inputSignature,
        results: targets.map((targetId) => ({ targetId,
          verdict: targetId === 'action-review' ? mode === 'action_pass' ? 'pass' : mode === 'action_hold' ? 'hold' : 'replace'
            : targetId === 'claim-ldl' && mode === 'claim_held' ? 'hold'
              : targetId === 'claim-ldl' && ['claim_changed', 'measure_changed', 'replacement_mismatch'].includes(mode) ? 'replace' : 'pass',
          reason: '合成核对。', replacement: targetId === 'action-review' && !['action_pass', 'action_hold'].includes(mode)
            || targetId === 'claim-ldl' && ['claim_changed', 'measure_changed', 'replacement_mismatch'].includes(mode)
            ? assessmentRepairNode(mode === 'replacement_mismatch' ? original : reviewed, targetId) as ClinicalFocusedReviewV1['results'][number]['replacement']
            : null })) };
      // 未限定的原解释不靠词面换写本身判定为非法；本例明确变成新增医学方向。
      if (mode === 'claim_changed') reviewed.claims[0]!.kind = 'diagnostic_assessment';
      if (mode === 'claim_held') reviewed.claims = [];
      const finalized = finalizeActionDependencyRebindings(original, reviewed, review,
        mode === 'knowledge_only_action' ? targets.filter((id) => id !== 'action-review') : targets,
        offered, sources, '2026-09-22', mode === 'local_invalid_claim' ? ['claim-ldl'] : []);
      if (mode === 'post_p03_claim_changed') reviewed.claims[0]!.rationale += '后置修复改变前提。';
      expect(focusedReviewBoundaryPreserved(original, reviewed, 'action-review', sources, '2026-09-22', [], [], finalized)).toBe(false);
      service.close();
    });

  it.each(['date_only', 'metadata_modifier', 'partial_date_with_retained_date'] as const)('同次 P04 合法撤回主张日期（%s）并仅补原治疗讨论的关联，完整发布且不重新提取事实', async (dateStyle) => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    Object.assign(candidate.claims[0]!, { kind: 'source_fact', consequenceLevel: 'high',
      text: dateStyle === 'partial_date_with_retained_date'
        ? '2026年9月21日的检验记录：LDL-C 4.2 mmol/L，高于该报告参考上限 3.4；9月25日报告时期的小结沿用该结果。'
        : dateStyle === 'metadata_modifier' ? '2026年9月21日签发的合成检验记录：LDL-C 4.2 mmol/L，高于该报告参考上限 3.4。'
        : '2026年9月21日 LDL-C 4.2 mmol/L，高于该报告参考上限 3.4。' });
    candidate.claims.push({ ...candidate.claims[0]!, id: 'claim-source', topicKey: 'source-result', consequenceLevel: 'routine',
      text: '报告保留血脂检查结果。' });
    Object.assign(candidate.actions[0]!, { kind: 'treatment_discussion', claimIds: ['claim-source'],
      why: '结合既有资料，与医生讨论目前的安排。', urgency: 'emergency' });
    candidate.overview.claimIds.push('claim-source');
    candidate.systems.forEach((system) => system.claimIds.push('claim-source'));
    const reviewed = structuredClone(candidate);
    Object.assign(reviewed.claims[0]!, {
      text: dateStyle === 'partial_date_with_retained_date'
        ? '2026年9月21日的检验记录：LDL-C 4.2 mmol/L，高于该报告参考上限 3.4；小结沿用该结果。'
        : `${dateStyle === 'metadata_modifier' ? '合成检验记录：' : ''}LDL-C 4.2 mmol/L，高于该报告参考上限 3.4。`,
      temporalStatus: 'uncertain', materialUncertainty: dateStyle !== 'date_only'
        ? '该检验报告的具体日期尚未确认。' : '具体日期无法确认。' });
    reviewed.actions[0]!.claimIds.push('claim-ldl');
    const factsBefore = service.store.listAcceptedObservations(personId);
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      if (calls === 1) return { threadId: 'p02', turnId: '1', output: assessmentOutputFor(input.prompt, candidate) };
      expect(calls).toBe(2);
      const request = JSON.parse(input.prompt.split('REVIEW_REQUEST=')[1]!.split('\nSOURCE_CONTEXT=')[0]!) as {
        actionDependencyRebindings: Array<{ targetId: string; allowedClaimIds: string[] }>
      };
      expect(request.actionDependencyRebindings).toContainEqual({ targetId: 'action-review',
        allowedClaimIds: expect.arrayContaining(['claim-ldl']) });
      return { threadId: 'p04', turnId: '2', output: focusedOutputFor(input.prompt, reviewed, ['claim-ldl', 'action-review']) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims).toEqual(reviewed.claims);
    expect(snapshot.actions).toEqual(reviewed.actions);
    expect(snapshot.heldTargetIds).not.toContain('action-review');
    expect(service.store.listAcceptedObservations(personId)).toEqual(factsBefore);
    service.close();
  });
});

describe('后置日期隔离后的有界独立日常补救', () => {
  it('仅撤回无把握的绝对日期并保留时间说明，原事实与独立行动一起发布', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    Object.assign(candidate.claims[0]!, { kind: 'source_fact', consequenceLevel: 'high',
      text: '2026年9月21日 LDL-C 4.2 mmol/L，高于该报告参考上限 3.4。' });
    const reviewed = structuredClone(candidate);
    Object.assign(reviewed.claims[0]!, { text: 'LDL-C 4.2 mmol/L，高于该报告参考上限 3.4。',
      temporalStatus: 'uncertain', materialUncertainty: '具体日期无法确认。' });
    const beforeFacts = service.store.listAcceptedObservations(personId);
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      return { threadId: 'synthetic', turnId: calls === 1 ? 'p02' : 'p04', output: calls === 1 ? candidate
        : focusedOutputFor(input.prompt, reviewed, ['claim-ldl']) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims).toEqual(reviewed.claims);
    expect(snapshot.actions).toEqual(candidate.actions);
    expect(snapshot.heldTargetIds).toEqual([]);
    expect(service.store.listAcceptedObservations(personId)).toEqual(beforeFacts);
    service.close();
  });

  it('无人引用的失效知识书目不触发整份修复或拦截', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.knowledgeSources.push({ id: 'unused-bad-source', origin: 'retrieved', title: '合成无效书目',
      organization: null, url: null, supports: '合成范围' });
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async () => {
      calls += 1;
      return { threadId: 'synthetic', turnId: 'p02', output: candidate };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 1 });
    expect(calls).toBe(1);
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims).toEqual(candidate.claims);
    expect(snapshot.actions).toEqual(candidate.actions);
    expect(snapshot.knowledgeSources).toEqual([]);
    service.close();
  });

  it.each(['pass', 'existing_claim_source_rebind', 'partial_hold', 'bad_source', 'incomplete_review', 'invalid_node', 'invalid_type', 'metadata_only', 'new_dose',
    'numeric_after_review', 'original_action_hold', 'busy_repair', 'timeout_repair', 'busy_review', 'timeout_review',
    'cancel_review', 'revision_changed_review'] as const)('%s 只发布取得新全文回执的既有行动，其余结果保留', async (mode) => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    const originalAction = candidate.actions[0]!;
    Object.assign(candidate.claims[0]!, { kind: 'source_fact', consequenceLevel: 'high',
      text: '2026年9月21日 LDL-C 4.2 mmol/L，高于该报告参考上限 3.4。' });
    candidate.claims.push({ ...candidate.claims[0]!, id: 'claim-source', consequenceLevel: 'routine',
      text: '这份报告提供了血脂结果。', materialUncertainty: '只有一次结果。' });
    candidate.actions = [
      { ...originalAction, id: 'habit:diet', dedupeKey: 'synthetic-diet', kind: 'habit',
        lifestyleDomain: 'diet', lifestyleBasis: 'personalized', timing: null,
        title: '记录饮食习惯', why: '结合当次结果了解饮食。', firstStep: '先记录三餐。' },
      { ...originalAction, id: 'habit:activity', dedupeKey: 'synthetic-activity', kind: 'habit',
        lifestyleDomain: 'activity', lifestyleBasis: 'personalized', timing: null,
        title: '记录日常活动', why: '结合当次结果了解活动。', firstStep: '先记录平时活动。' },
      { ...originalAction, id: 'unaffected', dedupeKey: 'synthetic-unaffected', claimIds: ['claim-source'] }
    ];
    if (mode === 'existing_claim_source_rebind') candidate.actions.filter((action) => action.kind === 'habit').forEach((action) => {
      action.evidenceIds = [];
      action.claimIds = ['claim-ldl', 'claim-source'];
      action.caution = '如出现明显不适应就医。';
    });
    candidate.overview.claimIds = candidate.claims.map((claim) => claim.id);
    candidate.overview.actionIds = candidate.actions.map((action) => action.id);
    candidate.systems.forEach((system) => {
      system.claimIds = [...candidate.overview.claimIds]; system.actionIds = [...candidate.overview.actionIds];
    });
    const reviewed = structuredClone(candidate);
    reviewed.claims[0]!.text = '2026年9月 LDL-C 4.2 mmol/L，高于该报告参考上限 3.4。';
    const independent = structuredClone(candidate);
    independent.actions.filter((action) => action.kind === 'habit').forEach((action) => {
      action.claimIds = [];
      if (mode === 'existing_claim_source_rebind') {
        action.claimIds = ['claim-source'];
        action.evidenceIds = [...candidate.claims[1]!.evidenceIds];
        action.caution += '旧记录的时间不从今天重新起算。';
      }
      if (mode !== 'metadata_only') {
        action.why = '原报告有单次血脂结果，可以记录目前习惯供下次就诊了解，不据此确定病因。';
        action.firstStep = action.lifestyleDomain === 'diet' ? '本周记录三餐搭配。' : '本周记录活动后的感受。';
      }
    });
    if (mode === 'bad_source') independent.actions[0]!.evidenceIds = ['missing-personal-source'];
    if (mode === 'new_dose') independent.actions[0]!.firstStep = '每日补充维生素D 1000 IU。';
    const facts = service.store.listAcceptedObservations(personId);
    const revision = service.store.getFactRevision(personId);
    let calls = 0;
    const processing = new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      expect(calls).toBeLessThanOrEqual(4);
      if (calls === 1) return { threadId: 'synthetic', turnId: 'p02', output: candidate };
      expect(input.allowWebSearch).toBe(false);
      if (calls === 2) return { threadId: 'synthetic', turnId: 'p04', output: focusedOutputFor(input.prompt, reviewed,
        ['claim-ldl'], mode === 'original_action_hold' ? ['habit:diet'] : []) };
      if (calls === 3) {
        if (mode === 'busy_repair') throw new CodexTurnFailure({ code: 'CODEX_MODEL_BUSY' });
        if (mode === 'timeout_repair') throw new Error('CODEX_TURN_TIMEOUT');
        expect(input.prompt).toContain('"recoveryMode":"late_independent_habits"');
        const request = JSON.parse(input.prompt.split('REPAIR_REQUEST=')[1]!.split('\nSOURCE_CONTEXT=')[0]!) as AssessmentRepairRequestV1;
        expect(request.targets).toEqual(mode === 'original_action_hold' ? ['habit:activity'] : ['habit:diet', 'habit:activity']);
        expect(request.targets).not.toContain('claim-ldl');
        expect(request.targets).not.toContain('unaffected');
        return { threadId: 'synthetic', turnId: 'late-p03', output: assessmentOutputFor(input.prompt, independent) };
      }
      if (mode === 'busy_review') throw new CodexTurnFailure({ code: 'CODEX_MODEL_BUSY' });
      if (mode === 'timeout_review') throw new Error('CODEX_TURN_TIMEOUT');
      if (mode === 'cancel_review') throw new Error('JOB_CANCELLED');
      if (mode === 'revision_changed_review') {
        service.store.getFactRevision = () => revision + 1;
        throw new CodexTurnFailure({ code: 'CODEX_MODEL_BUSY' });
      }
      expect(input.prompt).toContain('"recoveryMode":"late_independent_habits"');
      expect(input.prompt).toContain('不据此确定病因');
      const final = structuredClone(independent);
      if (mode === 'numeric_after_review') final.actions[0]!.firstStep = '本周记录三餐，并将体重降至70 kg。';
      const output = focusedOutputFor(input.prompt, final,
        mode === 'numeric_after_review' ? ['habit:diet'] : [], mode === 'partial_hold' ? ['habit:diet'] : []);
      if (mode === 'incomplete_review') output.results = [];
      if (mode === 'invalid_node') output.results[0] = { targetId: 'habit:diet', verdict: 'replace', reason: '合成错绑。',
        replacement: { nodeType: 'action', value: { ...independent.actions[0]!, id: 'foreign-action' } } };
      if (mode === 'invalid_type') output.results[0] = { targetId: 'habit:diet', verdict: 'replace', reason: '合成错类。',
        replacement: { nodeType: 'claim', value: { ...candidate.claims[1]!, id: 'habit:diet' } } };
      return { threadId: 'synthetic', turnId: 'late-p04', output };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    if (mode === 'cancel_review' || mode === 'revision_changed_review') {
      await expect(processing).rejects.toThrow(mode === 'cancel_review' ? 'JOB_CANCELLED' : 'MEMBER_ASSESSMENT_FACT_REVISION_CONFLICT');
      expect(service.store.listMemberAssessmentSnapshots(personId, true)).toEqual([]);
      service.close();
      return;
    }
    const result = await processing;
    expect(result, JSON.stringify(result))
      .toMatchObject({ status: 'published', callCount: ['metadata_only', 'busy_repair', 'timeout_repair'].includes(mode) ? 3 : 4 });
    if (result.status !== 'published') throw new Error('合成独立建议任务未发布。');
    if (['bad_source', 'new_dose', 'metadata_only'].includes(mode)) {
      expect(result.repairDiagnostics?.some((item) => item.failureReason === 'independent_habit_replacement_scope_not_preserved')).toBe(true);
    }
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    const dietRetained = mode === 'pass' || mode === 'existing_claim_source_rebind';
    const activityRetained = !['metadata_only', 'incomplete_review', 'invalid_node', 'invalid_type',
      'busy_repair', 'timeout_repair', 'busy_review', 'timeout_review'].includes(mode);
    expect(snapshot.actions.some((action) => action.id === 'habit:diet')).toBe(dietRetained);
    expect(snapshot.actions.some((action) => action.id === 'habit:activity')).toBe(activityRetained);
    expect(snapshot.actions.find((action) => action.id === 'unaffected')).toEqual(candidate.actions[2]);
    expect(snapshot.claims).toEqual([candidate.claims[1]]);
    expect(snapshot.heldTargetIds).toContain('claim-ldl');
    for (const id of ['habit:diet', 'habit:activity']) {
      const retained = snapshot.actions.some((action) => action.id === id);
      expect(snapshot.heldTargetIds.includes(id)).toBe(!retained);
      if (retained) expect(snapshot.reviewedTargetIds).toContain(id);
    }
    expect(service.store.listAcceptedObservations(personId)).toEqual(facts);
    expect(service.store.getFactRevision(personId)).toBe(revision);
    expect(JSON.stringify(snapshot.reviewAuditRecords)).not.toContain('foreign-action');
    service.close();
  });

  it.each(['pass', 'hold'] as const)('早期清理目录后late独立行动经完整出处复核%s，最终引用闭合且可保存到隔离库', async (verdict) => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    Object.assign(candidate.claims[0]!, { kind: 'source_fact', consequenceLevel: 'high',
      text: '2026年9月21日 LDL-C 4.2 mmol/L，高于该报告参考上限 3.4。' });
    candidate.claims.push({ ...candidate.claims[0]!, id: 'claim:late-basis', topicKey: 'synthetic-late-basis' });
    const entry = built.evidencePackage.knowledge.find((item) => item.id === 'knowledge-physical-activity-tailoring')!;
    expect(entry).toBeDefined();
    candidate.knowledgeSources = [{ id: entry.id, title: entry.title, organization: entry.sourceOrganization,
      url: entry.sourceUrl, origin: 'catalog', supports: entry.supportedScope }];
    candidate.actions = [{ ...candidate.actions[0]!, id: 'habit:catalog', dedupeKey: 'synthetic-late-catalog',
      kind: 'habit', lifestyleDomain: 'activity', lifestyleBasis: 'personalized',
      claimIds: candidate.claims.map((claim) => claim.id), timing: null, title: '记录日常活动',
      why: '结合旧记录了解日常活动。', firstStep: '记录平时活动。', knowledgeSourceIds: [entry.id] }];
    for (const aggregate of [candidate.overview, ...candidate.systems]) {
      aggregate.claimIds = candidate.claims.map((claim) => claim.id);
      aggregate.actionIds = candidate.actions.map((action) => action.id);
    }
    const reviewed = structuredClone(candidate);
    reviewed.claims[1]!.text = '2026年9月 LDL-C 4.2 mmol/L，高于该报告参考上限 3.4。';
    const independent = structuredClone(candidate);
    independent.actions[0]!.claimIds = [];
    independent.actions[0]!.why = '旧记录只有单次结果，记录当前活动感受供下次就诊了解，不据此判断病因。';
    independent.actions[0]!.firstStep = '从容易坚持的日常活动开始，记录活动后感受。';
    const facts = service.store.listAcceptedObservations(personId);
    const revision = service.store.getFactRevision(personId);
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      if (calls === 1) return { threadId: 'synthetic', turnId: 'p02', output: candidate };
      if (calls === 2) return { threadId: 'synthetic', turnId: 'main-p04', output: focusedOutputFor(input.prompt, reviewed,
        ['claim:late-basis'], ['claim-ldl']) };
      expect(input.allowWebSearch).toBe(false);
      expect(input.prompt).toContain('"recoveryMode":"late_independent_habits"');
      if (calls === 3) return { threadId: 'synthetic', turnId: 'late-p03', output: assessmentOutputFor(input.prompt, independent) };
      expect(calls).toBe(4);
      expect(input.prompt).toContain(entry.content);
      expect(input.prompt).toContain(entry.supportedScope);
      expect(input.prompt).toContain('catalog_knowledge_attribution:habit:catalog');
      return { threadId: 'synthetic', turnId: 'late-p04', output: focusedOutputFor(input.prompt, independent, [],
        verdict === 'hold' ? ['habit:catalog'] : []) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'published', callCount: 4 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.actions.map((action) => action.id)).toEqual(verdict === 'pass' ? ['habit:catalog'] : []);
    expect(snapshot.knowledgeSources).toEqual(verdict === 'pass' ? candidate.knowledgeSources : []);
    expect(snapshot.knowledgeVerifications).toEqual(verdict === 'pass' ? [{ sourceId: entry.id,
      status: 'catalog_curated', checkedAt: entry.reviewedAt, contentHash: stableHash(entry.content), toolReceiptId: null }] : []);
    expect(snapshot.heldTargetIds.includes('habit:catalog')).toBe(verdict === 'hold');
    expect(service.store.listAcceptedObservations(personId)).toEqual(facts);
    expect(service.store.getFactRevision(personId)).toBe(revision);
    service.close();
  });
});

describe('问句前提的同次复核与只读来源闭包', () => {
  it.each(['claim_rewritten', 'claim_held'] as const)('后置P03使关联前提%s，问句即使unchanged也不能沿用P04回执', async (mode) => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0]!.consequenceLevel = 'high';
    const question = { id: 'question:conditions', question: '这次抽血前是否空腹？',
      whyItMatters: '帮助理解这次结果。', relatedClaimIds: ['claim-ldl'],
      evidenceIds: candidate.claims[0]!.evidenceIds };
    candidate.questions.push(question);
    const review = replaceFocusedClaim(candidate, { ...candidate.claims[0]!, rationale: '经模型复核，报告有这项结果。' });
    const repaired = structuredClone(candidate);
    repaired.claims[0]!.rationale = mode === 'claim_held' ? '经模型复核，报告有这项结果。'
      : '该次报告有结果与参考范围，未提供空腹条件。';
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      if (calls === 1) return { threadId: 'p02', turnId: '1', output: candidate };
      if (calls === 2) return { threadId: 'p04', turnId: '2', output: review };
      expect(calls).toBe(3);
      const output = assessmentOutputFor(input.prompt, repaired) as MemberAssessmentRepairV1;
      const unchanged = output.results.find((item) => item.targetId === question.id)!;
      unchanged.verdict = 'unchanged';
      unchanged.replacement = null;
      return { threadId: 'p03', turnId: '3', output };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 3 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.questions).toEqual([]);
    expect(snapshot.heldTargetIds).toContain(question.id);
    expect(snapshot.claims.some((claim) => claim.id === 'claim-ldl')).toBe(mode === 'claim_rewritten');
    expect(calls).toBe(3);
    service.close();
  });

  it.each(['question', 'whyItMatters', 'evidenceIds', 'relatedClaimIds'] as const)(
    'P04之后P03又改写问句的%s时不沿用旧前提回执，也不增加下一次P04', async (field) => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    const question = { id: 'question:conditions', question: '这次抽血前是否空腹？',
      whyItMatters: '帮助理解这次结果。', relatedClaimIds: ['claim-ldl'], evidenceIds: [] };
    candidate.questions.push(question);
    const repaired = structuredClone(candidate);
    if (field === 'question') repaired.questions[0]!.question = '上一次抽血前是否空腹？';
    if (field === 'whyItMatters') repaired.questions[0]!.whyItMatters = '用于理解另一次结果。';
    if (field === 'evidenceIds') repaired.questions[0]!.evidenceIds = candidate.claims[0]!.evidenceIds;
    if (field === 'relatedClaimIds') repaired.questions[0]!.relatedClaimIds = [];
    const observations = service.store.listAcceptedObservations(personId);
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      if (calls === 1) return { threadId: 'p02', turnId: '1', output: candidate };
      if (calls === 2) return { threadId: 'p04', turnId: '2', output: { schemaVersion: 1, personId,
        inputSignature: candidate.inputSignature, results: [{ targetId: question.id, verdict: 'replace',
          reason: '合成替换', replacement: { nodeType: 'question', value: { ...question,
            question: '经模型复核，这次抽血前是否空腹？' } } }] } };
      expect(calls).toBe(3);
      expect(input.prompt).toContain('REPAIR_REQUEST=');
      return { threadId: 'p03', turnId: '3', output: assessmentOutputFor(input.prompt, repaired) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 3,
      focusedReviewDiagnostics: [{ targetId: question.id, verdict: 'replace', outcome: 'held',
        reasonCodes: ['focused_scope_boundary_changed'] }] });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.questions).toEqual([]);
    expect(snapshot.heldTargetIds).toContain(question.id);
    expect(snapshot.claims).toEqual(candidate.claims);
    expect(service.store.listAcceptedObservations(personId)).toEqual(observations);
    expect(calls).toBe(3);
    service.close();
  });

  it('带齐关联主张的支持和反证，但不扩大目标或混入无关来源', async () => {
    const { service, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    const source = built.evidencePackage.evidenceCatalog.find((ref) => ref.id === candidate.claims[0]!.evidenceIds[0])!;
    const condition = { ...source, id: 'ref:condition', quote: '合成报告：检测前条件未提供。' };
    const unrelated = { ...source, id: 'ref:unrelated', quote: '合成的无关来源。' };
    const evidencePackage = { ...built.evidencePackage,
      evidenceCatalog: [...built.evidencePackage.evidenceCatalog, condition, unrelated] };
    candidate.claims[0]!.counterEvidenceIds = [condition.id];
    candidate.questions.push({ id: 'question:conditions', question: '抽血前是否空腹？',
      whyItMatters: '帮助理解这次结果。', relatedClaimIds: ['claim-ldl'], evidenceIds: [] });
    const targets = ['question:conditions'];
    const candidateBefore = structuredClone(candidate);
    const context = focusedReviewSourceContext(candidate, targets, evidencePackage, '2026-09-22');
    expect(context.readOnlyClaims).toEqual(candidate.claims);
    expect(new Set(context.evidenceCatalog.map((ref) => ref.id))).toEqual(new Set([source.id, condition.id]));
    expect(context.evidenceCatalog).not.toContainEqual(unrelated);
    expect(context.analysisReferenceDate).toBe('2026-09-22');
    expect(targets).toEqual(['question:conditions']);
    expect(candidate).toEqual(candidateBefore);
    expect(focusedReviewSourceContext(candidate, ['question:conditions', 'claim-ldl'], evidencePackage,
      '2026-09-22').readOnlyClaims).toEqual([]);
    service.close();
  });

  it.each(['report', 'clinical'] as const)('P04保留已引用事实的%s记录日期和依据，不把空单项日期误当全部无日期', async (basis) => {
    const { service, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    const source = built.evidencePackage.evidenceCatalog.find((ref) => ref.id === candidate.claims[0]!.evidenceIds[0])!;
    const fact = built.evidencePackage.facts.find((item) => item.observationId === source.observationId)!;
    const effectiveTime = { value: '2026-02-09', endValue: null, precision: 'day' as const,
      role: basis === 'report' ? 'report' as const : 'measurement' as const,
      source: 'inherited' as const, basis, displayLabel: '合成日期依据',
      evidence: [{ sourceSpanId: 'synthetic-date-span', quote: '2026-02-09' }] };
    const dated = { ...fact, clinicalDate: null, effectiveTime };
    const evidencePackage = { ...built.evidencePackage, facts: [dated,
      { ...dated, observationId: 'unrelated-same-document-fact', originalName: '其他合成项目' }] };
    const before = structuredClone(evidencePackage);
    const context = focusedReviewSourceContext(candidate, [candidate.claims[0]!.id], evidencePackage, '2026-09-22');
    expect(context.factTimes).toEqual([{ observationId: fact.observationId, documentId: fact.documentId,
      clinicalDate: null, effectiveTime, ...(fact.sourceTime ? { sourceTime: fact.sourceTime } : {}) }]);
    expect(context.factTimes).not.toContainEqual(expect.objectContaining({ observationId: 'unrelated-same-document-fact' }));
    expect(evidencePackage).toEqual(before);
    service.close();
  });

  it.each(['replace', 'hold', 'readonly_injection'] as const)('普通问句同次P04执行%s，不允许替换只读关联主张', async (verdict) => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    const question = { id: 'question:conditions', question: '复查前是否空腹？',
      whyItMatters: '帮助理解这次结果。', relatedClaimIds: ['claim-ldl'], evidenceIds: [] };
    candidate.questions.push(question);
    const observations = service.store.listAcceptedObservations(personId);
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      if (calls === 1) return { threadId: 'p02', turnId: '1', output: assessmentOutputFor(input.prompt, candidate) };
      expect(calls).toBe(2);
      expect(input.allowWebSearch).toBe(false);
      const request = JSON.parse(input.prompt.split('REVIEW_REQUEST=')[1]!.split('\nSOURCE_CONTEXT=')[0]!) as {
        targets: string[]; reasons: string[];
      };
      const context = JSON.parse(input.prompt.split('SOURCE_CONTEXT=')[1]!.split('\nTARGET_NODES=')[0]!) as {
        readOnlyClaims: Array<{ id: string }>; evidenceCatalog: Array<{ id: string }>;
      };
      expect(request.targets).toEqual([question.id]);
      expect(request.reasons).toContain(`question_premise:${question.id}`);
      expect(context.readOnlyClaims.map((claim) => claim.id)).toEqual(['claim-ldl']);
      expect(context.evidenceCatalog.map((ref) => ref.id)).toContain(candidate.claims[0]!.evidenceIds[0]);
      const results: ClinicalFocusedReviewV1['results'] = [{ targetId: question.id,
        verdict: verdict === 'hold' ? 'hold' : 'replace', reason: '合成前提检查',
        replacement: verdict === 'hold' ? null : { nodeType: 'question', value: { ...question, question: '这次抽血前是否空腹？' } } }];
      if (verdict === 'readonly_injection') results.push({ targetId: 'claim-ldl', verdict: 'replace',
        reason: '越权修改只读主张', replacement: { nodeType: 'claim', value: { ...candidate.claims[0]!, text: '不能写入的合成替换。' } } });
      return { threadId: 'p04', turnId: '2', output: { schemaVersion: 1, personId,
        inputSignature: candidate.inputSignature, results } };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    if (verdict === 'readonly_injection') {
      expect(result).toMatchObject({ status: 'rejected', reason: 'FOCUSED_REVIEW_COVERAGE_MISMATCH', callCount: 2 });
      expect(service.store.listMemberAssessmentSnapshots(personId, true)).toEqual([]);
    } else {
      expect(result).toMatchObject({ status: 'published', callCount: 2 });
      const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
      expect(snapshot.claims).toEqual(candidate.claims);
      expect(snapshot.questions).toEqual(verdict === 'hold' ? [] : [{ ...question, question: '这次抽血前是否空腹？' }]);
      expect(snapshot.reviewedTargetIds).toEqual([question.id]);
      expect(snapshot.heldTargetIds.includes(question.id)).toBe(verdict === 'hold');
    }
    expect(service.store.listAcceptedObservations(personId)).toEqual(observations);
    expect(calls).toBe(2);
    service.close();
  });
});

describe('语义争议与原句绑定的一次P04集成', () => {
  it.each(['pass', 'hold'] as const)('否定补充剂语句由P04明确%s，不能由旧正则或来源存在决定', async (verdict) => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.actions[0] = { ...candidate.actions[0]!, kind: 'habit', lifestyleDomain: 'supplements', lifestyleBasis: 'general',
      claimIds: [], evidenceIds: [], knowledgeSourceIds: [], title: '营养补充先看食物',
      why: '日常饮食先从多样化食物开始。', firstStep: '不建议为了视力额外添加保健品；先整理现用产品清单。',
      timing: '先试一周', timingBasis: 'practical_trial' };
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      if (calls === 1) return { threadId: 'p02', turnId: 'general', output: candidate };
      expect(calls).toBe(2);
      expect(input.prompt).toContain('REVIEW_REQUEST=');
      expect(input.prompt).toContain('semantic_review:general_lifestyle_not_low_risk:action-review');
      expect(input.allowWebSearch).toBe(false);
      return { threadId: 'p04', turnId: 'general', output: focusedOutputFor(input.prompt, candidate, [],
        verdict === 'hold' ? ['action-review'] : []) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.actions).toEqual(verdict === 'pass' ? candidate.actions : []);
    expect(snapshot.heldTargetIds.includes('action-review')).toBe(verdict === 'hold');
    expect(snapshot.claims).toEqual(candidate.claims);
  });

  it.each(['pass', 'replace'] as const)('原安排有独立依据时，%s不能冒充或跳过失效历史解释的实质修正', async (verdict) => {
    const rawText = '医生建议3个月后复查血脂。';
    const { service, personId, built, fact } = await fixtureSourceInstruction(rawText);
    const ldl = built.evidencePackage.facts.find((item) => item.originalName === 'LDL-C')!;
    const candidate = candidateFor(built.request, { facts: [ldl] });
    candidate.claims.push({ ...candidate.claims[0]!, id: 'claim:optional-history',
      text: '既往血脂记录曾出现波动。', temporalStatus: 'historical', consequenceLevel: 'high' });
    Object.assign(candidate.actions[0]!, { kind: 'documented_plan', sourceInstructionObservationId: fact.observationId,
      title: DOCUMENTED_PLAN_NEUTRAL_TITLE, firstStep: rawText, timing: '3个月后', timingBasis: 'documented',
      why: '本次血脂结果及历次变化需要复查。',
      claimIds: ['claim-ldl', 'claim:optional-history'], evidenceIds: [...fact.evidenceIds, ...ldl.evidenceIds] });
    const reviewed = structuredClone(candidate);
    reviewed.actions[0]!.claimIds = ['claim-ldl'];
    reviewed.actions[0]!.why = '本次血脂结果需要复查。';
    const factsBefore = service.store.listAcceptedObservations(personId);
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      if (calls === 1) return { threadId: 'p02', turnId: 'synthetic', output: candidate };
      expect(calls).toBe(2);
      const request = JSON.parse(input.prompt.split('REVIEW_REQUEST=')[1]!.split('\nSOURCE_CONTEXT=')[0]!) as {
        targets: string[]
      };
      expect(request.targets).toContain('claim:optional-history');
      return { threadId: 'p04', turnId: 'synthetic', output: focusedOutputFor(input.prompt, reviewed,
        verdict === 'replace' ? ['action-review'] : [], ['claim:optional-history']) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.heldTargetIds).toContain('claim:optional-history');
    expect(snapshot.actions.some((action) => action.id === 'action-review'), JSON.stringify({ held: snapshot.heldTargetIds,
      reviewed: snapshot.reviewedTargetIds, claims: snapshot.actions[0]?.claimIds })).toBe(verdict === 'replace');
    if (verdict === 'replace') expect(snapshot.actions[0]).toMatchObject({ firstStep: rawText, timing: '3个月后',
      claimIds: ['claim-ldl'], sourceInstructionObservationId: fact.observationId });
    expect(service.store.listAcceptedObservations(personId)).toEqual(factsBefore);
    service.close();
  });

  it.each(['pass', 'hold'] as const)('原医生安排绑定完整条件原句后仍强制P04，%s控制最终保留', async (verdict) => {
    const rawText = '若复查仍异常，医生建议3个月后回原门诊；未完成复查前不要自行改变用药。';
    const { service, personId, built, fact } = await fixtureSourceInstruction(rawText);
    const ldl = built.evidencePackage.facts.find((item) => item.originalName === 'LDL-C')!;
    const candidate = candidateFor(built.request, { facts: [ldl] });
    Object.assign(candidate.actions[0]!, { kind: 'documented_plan', sourceInstructionObservationId: fact.observationId,
      title: DOCUMENTED_PLAN_NEUTRAL_TITLE, firstStep: '模型省略条件的转述不应发布。', timing: '3个月后',
      timingBasis: 'documented', evidenceIds: [...fact.evidenceIds] });
    const factsBefore = service.store.listAcceptedObservations(personId);
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      if (calls === 1) return { threadId: 'p02', turnId: 'instruction', output: candidate };
      expect(calls).toBe(2);
      expect(input.prompt).toContain('source_instruction_role_review:action-review');
      const targetNodes = JSON.parse(input.prompt.split('TARGET_NODES=')[1]!) as Array<{ id: string; node: unknown }>;
      expect(targetNodes.find((item) => item.id === 'action-review')!.node)
        .toMatchObject({ firstStep: rawText, sourceInstructionObservationId: fact.observationId });
      const context = JSON.parse(input.prompt.split('SOURCE_CONTEXT=')[1]!.split('\nTARGET_NODES=')[0]!) as {
        sourceInstructions: unknown[]
      };
      expect(context.sourceInstructions).toEqual([{ actionId: 'action-review', observationId: fact.observationId,
        clinicalDate: '2026-09-21', rawValue: rawText,
        acceptedFactContext: { provenance: 'accepted_report_observation', originalName: fact.originalName } }]);
      expect(JSON.stringify(context.sourceInstructions)).not.toContain('模型省略条件的转述');
      expect(JSON.stringify(context.sourceInstructions)).not.toContain('2026-09-21 LDL-C');
      return { threadId: 'p04', turnId: 'instruction', output: focusedOutputFor(input.prompt, candidate, [],
        verdict === 'hold' ? ['action-review'] : []) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.actions).toEqual(verdict === 'pass' ? [{ ...candidate.actions[0], firstStep: rawText }] : []);
    expect(snapshot.heldTargetIds.includes('action-review')).toBe(verdict === 'hold');
    expect(service.store.listAcceptedObservations(personId)).toEqual(factsBefore);
  });

  it('无效绑定不能因同一原句似乎有依据而绕过本地门禁或获得P04通过', async () => {
    const { service, personId, built } = await fixture(false, true);
    const candidate = candidateFor(built.request, built.evidencePackage);
    Object.assign(candidate.actions[0]!, { kind: 'documented_plan', sourceInstructionObservationId: 'synthetic-other-member-observation',
      title: DOCUMENTED_PLAN_NEUTRAL_TITLE, firstStep: '3个月后复查血脂。', timing: '3个月后', timingBasis: 'documented' });
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      if (calls === 1) return { threadId: 'p02', turnId: 'invalid-instruction', output: candidate };
      if (input.prompt.includes('REVIEW_REQUEST=')) return { threadId: 'p04', turnId: 'neutral-system',
        output: focusedOutputFor(input.prompt, candidate) };
      expect(input.prompt).toContain('REPAIR_REQUEST=');
      expect(input.prompt).toContain('source_instruction:action-review:fact_not_found');
      return { threadId: 'p03', turnId: 'unchanged-instruction', output: assessmentOutputFor(input.prompt, candidate) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 3 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.actions).toEqual([]);
    expect(snapshot.heldTargetIds).toContain('action-review');
    expect(snapshot.reviewedTargetIds).not.toContain('action-review');
    expect(snapshot.claims).toEqual(candidate.claims);
  });

  it('本地已识别的documented诊断仍须P04核对归属，hold时隔离判断而不改变本人事实', async () => {
    const { service, personId, built } = await fixtureReportFindings();
    const fact = built.evidencePackage.facts.find((item) => item.originalName === '原报告诊断')!;
    const candidate = candidateFor(built.request, { facts: [fact] });
    Object.assign(candidate.claims[0]!, { kind: 'diagnostic_assessment', diseaseName: '慢性胃炎', diagnosticStatus: 'documented',
      temporalStatus: 'historical', text: '原报告明确记载诊断：慢性胃炎。',
      rationale: '原资料给出了诊断文字。', knowledgeBasis: 'not_applicable' });
    Object.assign(candidate.actions[0]!, { title: '整理原报告供就诊讨论', why: '原报告中的安排需结合本人当前情况理解。',
      firstStep: '带上原报告和实际症状记录与接诊医生沟通。' });
    const validation = validateAssessmentCandidate(candidate, { personId, inputSignature: candidate.inputSignature,
      mode: candidate.mode, requestedSystemIds: built.request.requestedSystemIds,
      evidenceCatalog: built.evidencePackage.evidenceCatalog, trendIds: [], catalogKnowledgeIds: [], criteriaSets: [] });
    expect(validation.issues).not.toContain('documented_source_not_proven:claim-ldl');
    const facts = service.store.listAcceptedObservations(personId);
    const revision = service.store.getFactRevision(personId);
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      if (calls === 1) return { threadId: 'p02', turnId: 'documented-attribution', output: candidate };
      expect(calls).toBe(2);
      expect(input.prompt).toContain('documented_attribution_review:claim-ldl');
      return { threadId: 'p04', turnId: 'documented-attribution', output: focusedOutputFor(input.prompt, candidate, [], ['claim-ldl']) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims).toEqual([]);
    expect(snapshot.actions).toEqual([]);
    expect(snapshot.heldTargetIds).toContain('claim-ldl');
    expect(service.store.listAcceptedObservations(personId)).toEqual(facts);
    expect(service.store.getFactRevision(personId)).toBe(revision);
  });

  it.each(['pass', 'hold'] as const)('并列诊断及标题措辞疑点进入同一P04，%s回执决定依赖建议发布且不重提取', async (verdict) => {
    const { service, personId, built, fact } = await fixtureSourceInstruction('出院诊断：左肾囊肿。出院诊断：右肾结石。');
    const candidate = candidateFor(built.request, { facts: [fact] });
    Object.assign(candidate.claims[0]!, { kind: 'diagnostic_assessment', diseaseName: '左肾囊肿、右肾结石',
      title: '左肾囊肿和右肾结石已有明确诊断', diagnosticStatus: 'documented', temporalStatus: 'historical',
      text: '出院报告分别记载左肾囊肿、右肾结石。', rationale: '原报告列出两项诊断。', knowledgeBasis: 'not_applicable' });
    Object.assign(candidate.actions[0]!, { kind: 'habit', lifestyleDomain: 'daily_routine', lifestyleBasis: 'personalized',
      title: '记录排尿感受供复诊了解', why: '既有泌尿系统记录需结合实际感受理解。',
      firstStep: '记录有无排尿不适，复诊时提供给接诊医生。', timing: null, timingBasis: 'none' });
    const validation = validateAssessmentCandidate(candidate, { personId, inputSignature: candidate.inputSignature,
      mode: candidate.mode, requestedSystemIds: built.request.requestedSystemIds,
      evidenceCatalog: built.evidencePackage.evidenceCatalog, trendIds: [], catalogKnowledgeIds: [], criteriaSets: [] });
    expect(validation.issues).toEqual(expect.arrayContaining(['documented_source_not_proven:claim-ldl',
      'diagnostic_title_contradiction:claim-ldl']));
    const factsBefore = service.store.listAcceptedObservations(personId);
    const revisionBefore = service.store.getFactRevision(personId);
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      if (calls === 1) return { threadId: 'p02', turnId: 'compound-diagnosis', output: candidate };
      expect(calls).toBe(2);
      expect(input.prompt).toContain('REVIEW_REQUEST=');
      expect(input.prompt).not.toContain('REPAIR_REQUEST=');
      expect(input.prompt).toContain('semantic_review:diagnostic_title_contradiction:claim-ldl');
      expect(input.prompt).toContain('semantic_review:documented_source_not_proven:claim-ldl');
      expect(input.prompt).toContain('出院诊断：左肾囊肿。出院诊断：右肾结石。');
      return { threadId: 'p04', turnId: 'compound-diagnosis', output: focusedOutputFor(input.prompt, candidate, [],
        verdict === 'hold' ? ['claim-ldl', 'action-review'] : []) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims).toEqual(verdict === 'pass' ? candidate.claims : []);
    expect(snapshot.actions).toEqual(verdict === 'pass' ? candidate.actions : []);
    expect(snapshot.reviewedTargetIds).toEqual(expect.arrayContaining(['claim-ldl', 'action-review']));
    expect(service.store.listAcceptedObservations(personId)).toEqual(factsBefore);
    expect(service.store.getFactRevision(personId)).toBe(revisionBefore);
  });

  it.each(['complete_rewrite', 'metadata_only'] as const)('同次P04隔离坏主张并%s行动，完整独立依据决定能否保留', async (mode) => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    Object.assign(candidate.claims[0]!, { kind: 'diagnostic_assessment', diseaseName: '脂质代谢异常', diagnosticStatus: 'documented' });
    Object.assign(candidate.actions[0]!, { kind: 'habit', lifestyleDomain: 'diet', lifestyleBasis: 'personalized',
      title: '记录日常饮食', why: '结合血脂判断安排三餐。', firstStep: '先记录三餐。', timing: null });
    const corrected = structuredClone(candidate);
    corrected.actions[0]!.claimIds = [];
    if (mode === 'complete_rewrite') Object.assign(corrected.actions[0]!, {
      why: '报告有单次血脂结果，先记录三餐供下次就诊了解，不据此确定病因。',
      firstStep: '记录自己的三餐与活动安排，提供给接诊医生了解。' });
    let calls = 0;
    const facts = service.store.listAcceptedObservations(personId);
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      if (calls === 1) return { threadId: 'p02', turnId: 'independent', output: candidate };
      expect(calls).toBe(2);
      expect(input.prompt).toContain('semantic_review:documented_source_not_proven:claim-ldl');
      expect(input.prompt).toContain('"finalDependencyGraph":true');
      const request = JSON.parse(input.prompt.split('REVIEW_REQUEST=')[1]!.split('\nSOURCE_CONTEXT=')[0]!) as { targets: string[] };
      expect(request.targets).toEqual(expect.arrayContaining(['claim-ldl', 'action-review']));
      return { threadId: 'p04', turnId: 'independent', output: focusedOutputFor(input.prompt, corrected,
        ['action-review'], ['claim-ldl']) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims).toEqual([]);
    expect(snapshot.actions).toEqual(mode === 'complete_rewrite' ? corrected.actions : []);
    expect(snapshot.heldTargetIds.includes('action-review')).toBe(mode !== 'complete_rewrite');
    expect(snapshot.reviewedTargetIds).toEqual(expect.arrayContaining(['claim-ldl', 'action-review']));
    expect(service.store.listAcceptedObservations(personId)).toEqual(facts);
  });

  it.each(['body', 'dependency'] as const)('语义P04通过后P03改变%s，旧凭据不能给新图背书或触发第二P04', async (change) => {
    const { service, personId, built } = await fixture(false, true);
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0]!.consequenceLevel = 'high';
    Object.assign(candidate.actions[0]!, { kind: 'documented_plan', title: DOCUMENTED_PLAN_NEUTRAL_TITLE,
      firstStep: '遵从原报告所列血脂复检安排。', timing: '3个月后', timingBasis: 'documented' });
    const reviewed = structuredClone(candidate);
    reviewed.claims[0]!.rationale = '经模型复核，报告有本次血脂结果。';
    const repaired = structuredClone(candidate);
    repaired.claims[0]!.rationale = '该份报告给出了血脂结果及参考范围；单次结果不能代表长期趋势。';
    if (change === 'body') repaired.actions[0]!.firstStep = '遵循该次医生列出的血脂复检安排。';
    let calls = 0;
    let reviews = 0;
    let repairs = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      if (calls === 1) return { threadId: 'p02', turnId: 'semantic-proof', output: candidate };
      if (input.prompt.includes('REVIEW_REQUEST=')) {
        reviews += 1;
        expect(reviews).toBe(1);
        return { threadId: 'p04', turnId: 'semantic-proof', output: focusedOutputFor(input.prompt, reviewed, ['claim-ldl']) };
      }
      repairs += 1;
      expect(repairs).toBeLessThanOrEqual(2);
      expect(input.prompt).toContain('REPAIR_REQUEST=');
      return { threadId: 'p03', turnId: `semantic-proof-${repairs}`, output: assessmentOutputFor(input.prompt, repaired) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    // 同一内容补救后凭据失效即定向隔离，不为它再追加一轮复核或无意义修复。
    expect({ status: result.status, callCount: result.callCount, reviews, repairs })
      .toEqual({ status: 'published', callCount: 3, reviews: 1, repairs: 1 });
    expect(reviews).toBe(1);
    expect(repairs).toBe(1);
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.actions).toEqual([]);
    expect(snapshot.heldTargetIds).toContain('action-review');
    expect(snapshot.claims).toEqual(repaired.claims);
  });

  it('越界主张先被删依赖边后才隔离时，问句和摘要不能凭原ID保留旧前提', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0]!.consequenceLevel = 'high';
    candidate.overview.summary = '这项判断决定后续治疗安排。';
    candidate.systems.forEach((system) => { system.summary = '这项判断决定后续治疗安排。'; });
    candidate.questions.push({ id: 'question:retained-premise', question: '这项判断是否说明需要进一步治疗？',
      whyItMatters: '这项判断影响后续安排。', relatedClaimIds: ['claim-ldl'],
      evidenceIds: [...candidate.claims[0]!.evidenceIds] });
    const replaced = structuredClone(candidate);
    Object.assign(replaced.claims[0]!, { kind: 'diagnostic_assessment', diseaseName: '脂质代谢异常', diagnosticStatus: 'possible',
      text: '需要考虑脂质代谢异常可能，尚不能确定。' });
    replaced.questions[0]!.relatedClaimIds = [];
    for (const node of [replaced.overview, ...replaced.systems]) { node.claimIds = []; node.actionIds = []; }
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      if (calls === 1) return { threadId: 'p02', turnId: 'deleted-edges', output: candidate };
      expect(calls).toBe(2);
      return { threadId: 'p04', turnId: 'deleted-edges', output: focusedOutputFor(input.prompt, replaced,
        ['claim-ldl', 'question:retained-premise', 'overview', ...candidate.systems.map((system) => system.id)]) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims).toEqual([]);
    expect(snapshot.actions).toEqual([]);
    expect(snapshot.questions).toEqual([]);
    expect(snapshot.heldTargetIds).toEqual(expect.arrayContaining(['claim-ldl', 'question:retained-premise']));
    expect(snapshot.presentation?.rebuiltNodeIds).toEqual(expect.arrayContaining(['overview', ...candidate.systems.map((system) => system.id)]));
    expect([snapshot.overview.summary, ...snapshot.systems.map((system) => system.summary)].join('\n'))
      .not.toContain('这项判断决定后续治疗安排');
  });
});

describe('隔离判断后日常建议的有界重新接线', () => {
  it('行动复核取得关联主张的完整只读支持与反证，不扩大替换目标', async () => {
    const { service, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    const counter = { ...built.evidencePackage.evidenceCatalog[0]!, id: 'synthetic-counter-source', quote: '合成复测记录。' };
    candidate.claims[0]!.counterEvidenceIds = [counter.id];
    candidate.actions[0]!.evidenceIds = [];
    const context = focusedReviewSourceContext(candidate, ['action-review'],
      { ...built.evidencePackage, evidenceCatalog: [...built.evidencePackage.evidenceCatalog, counter] }, '2026-09-22');
    expect(context.readOnlyClaims).toEqual(candidate.claims);
    expect(context.evidenceCatalog.map((source) => source.id)).toEqual(expect.arrayContaining([
      ...candidate.claims[0]!.evidenceIds, counter.id
    ]));
    expect(candidate.actions[0]!.claimIds).toEqual(['claim-ldl']);
    service.close();
  });

  it.each([
    ['unchanged', 'independent'], ['malformed', 'independent'], ['removed_dependencies', 'independent'],
    ['removed_dependencies', 'metadata_only'], ['unchanged', 'metadata_only'],
    ['unchanged', 'general_only'], ['unchanged', 'review_hold'], ['unchanged', 'review_invalid']
  ] as const)('首次P03 %s 后批量补救三类既有建议，%s 保持共享预算和完整复核', async (firstRepair, mode) => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    // 合成不合法诊断字段；报告事实本身没有改变，也不把诊断标签当作个人依据。
    candidate.claims[0]!.kind = 'source_fact';
    candidate.claims[0]!.diseaseName = '脂质代谢异常';
    candidate.claims[0]!.diagnosticStatus = 'documented';
    const domains = ['diet', 'activity', 'daily_routine'] as const;
    candidate.actions = domains.map((domain) => ({ ...candidate.actions[0]!, id: `habit:${domain}`,
      dedupeKey: `habit-${domain}`, kind: 'habit', lifestyleDomain: domain, lifestyleBasis: 'personalized',
      title: `合成${domain}习惯`, why: '结合血脂判断安排日常习惯。',
      firstStep: '先记录自己的日常安排。', timing: null }));
    candidate.overview.actionIds = candidate.actions.map((action) => action.id);
    candidate.systems.forEach((system) => { system.actionIds = [...candidate.overview.actionIds]; });
    const facts = service.store.listAcceptedObservations(personId);
    const revision = service.store.getFactRevision(personId);
    let calls = 0;
    let repairs = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      if (calls === 1) return { threadId: 'synthetic', turnId: 'p02', output: candidate };
      expect(input.allowWebSearch).toBe(false);
      if (input.prompt.includes('REPAIR_REQUEST=')) {
        repairs += 1;
        expect(repairs).toBeLessThanOrEqual(2);
        const request = JSON.parse(input.prompt.split('REPAIR_REQUEST=')[1]!.split('\nSOURCE_CONTEXT=')[0]!) as AssessmentRepairRequestV1;
        if (repairs === 1) {
          const firstCandidate = structuredClone(candidate);
          if (firstRepair === 'removed_dependencies') firstCandidate.actions.forEach((action) => { action.claimIds = []; });
          return { threadId: 'synthetic', turnId: 'p03-first', output: firstRepair === 'malformed'
            ? { schemaVersion: 1, results: [] } : assessmentOutputFor(input.prompt, firstCandidate) };
        }
        expect(request.targets).toEqual(expect.arrayContaining(candidate.actions.map((action) => action.id)));
        expect(request.targets.every((id) => ['overview', ...candidate.systems.map((system) => system.id),
          ...candidate.actions.map((action) => action.id)].includes(id))).toBe(true);
        expect(request.targetDetails.filter((detail) => detail.nodeType === 'action')
          .every((detail) => detail.remainingEvidenceIds.length > 0)).toBe(true);
        expect(request.targets).not.toContain('claim-ldl');
        const repaired = structuredClone(candidate);
        repaired.overview.claimIds = [];
        repaired.systems.forEach((system) => { system.claimIds = []; system.status = 'insufficient'; });
        repaired.actions = repaired.actions.map((action) => ({ ...action, claimIds: [],
          ...(mode === 'general_only' ? { lifestyleBasis: 'general' as const } : {}),
          ...(['metadata_only', 'general_only'].includes(mode) ? {} : {
            why: '这份报告有血脂结果，先记录习惯以供下次就诊了解，不凭单项结果确定病因。',
            firstStep: '本周记录自己目前的饮食、活动和日常安排，下次就诊时带给医生。'
          }) }));
        return { threadId: 'synthetic', turnId: 'p03-independent', output: assessmentOutputFor(input.prompt, repaired) };
      }
      // 只有实质改写的行动进入唯一一次 P04，核对的确实是新正文及其原有个人来源。
      expect(['metadata_only', 'general_only']).not.toContain(mode);
      expect(calls).toBe(4);
      const request = JSON.parse(input.prompt.split('REVIEW_REQUEST=')[1]!.split('\nSOURCE_CONTEXT=')[0]!) as { targets: string[] };
      const expectedTargets = [...candidate.actions.map((action) => action.id),
        ...(firstRepair === 'removed_dependencies' ? ['overview', ...candidate.systems.map((system) => system.id)] : [])];
      expect(new Set(request.targets)).toEqual(new Set(expectedTargets));
      expect(input.prompt).toContain('independent_habit_basis_review:habit:diet');
      expect(input.prompt).toContain('不凭单项结果确定病因');
      expect(input.prompt).not.toContain('"targets":["claim-ldl"');
      return { threadId: 'synthetic', turnId: 'p04', output: {
        schemaVersion: 1, personId, inputSignature: candidate.inputSignature,
        results: request.targets.map((targetId) => ({ targetId,
          verdict: mode === 'review_hold' ? 'hold' : mode === 'review_invalid' && targetId === 'habit:diet' ? 'replace' : 'pass',
          reason: '合成独立依据核对。', replacement: mode === 'review_invalid' && targetId === 'habit:diet'
            ? { nodeType: 'action', value: { ...candidate.actions[0]!, claimIds: [], evidenceIds: ['missing-personal-source'] } } : null }))
      } };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result, result.status === 'rejected' ? result.reason : undefined)
      .toMatchObject({ status: 'published', callCount: ['metadata_only', 'general_only'].includes(mode) ? 3 : 4 });
    expect(repairs).toBe(2);
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims).toEqual([]);
    const retained = ['metadata_only', 'general_only', 'review_hold'].includes(mode) ? []
      : candidate.actions.filter((action) => mode !== 'review_invalid' || action.id !== 'habit:diet').map((action) => action.id);
    expect(snapshot.actions.map((action) => action.id)).toEqual(retained);
    expect(snapshot.actions.every((action) => action.claimIds.length === 0 && action.lifestyleBasis === 'personalized')).toBe(true);
    expect(snapshot.actions.some((action) => ['sleep', 'supplements'].includes(action.lifestyleDomain ?? ''))).toBe(false);
    expect(new Set(snapshot.reviewedTargetIds)).toEqual(new Set(['metadata_only', 'general_only'].includes(mode) ? []
      : [...candidate.actions.map((action) => action.id),
        ...(firstRepair === 'removed_dependencies' ? ['overview', ...candidate.systems.map((system) => system.id)] : [])]));
    expect(snapshot.heldTargetIds).toContain('claim-ldl');
    expect(service.store.listAcceptedObservations(personId)).toEqual(facts);
    expect(service.store.getFactRevision(personId)).toBe(revision);
    service.close();
  });

  it.each(['not_habit', 'not_routine', 'no_personal_basis'] as const)('普通P03不能通过改写 %s 为原本无资格行动取得独立补救权限', async (mode) => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0]!.kind = 'source_fact';
    candidate.claims[0]!.diseaseName = '脂质代谢异常';
    candidate.claims[0]!.diagnosticStatus = 'documented';
    candidate.actions[0] = { ...candidate.actions[0]!, kind: mode === 'not_habit' ? 'test_followup' : 'habit',
      lifestyleDomain: 'diet', lifestyleBasis: 'personalized', urgency: mode === 'not_routine' ? 'soon' : 'routine',
      evidenceIds: mode === 'no_personal_basis' ? [] : candidate.actions[0]!.evidenceIds };
    const repaired = structuredClone(candidate);
    repaired.actions[0] = { ...repaired.actions[0]!, kind: 'habit', urgency: 'routine',
      claimIds: [],
      evidenceIds: built.evidencePackage.facts[0]!.evidenceIds,
      why: '原报告有单次血脂结果，可先记录日常三餐。' };
    let calls = 0;
    const facts = service.store.listAcceptedObservations(personId);
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      expect(calls).toBeLessThanOrEqual(2);
      return { threadId: 'synthetic', turnId: String(calls), output: calls === 1 ? candidate : assessmentOutputFor(input.prompt, repaired) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.actions).toEqual([]);
    expect(snapshot.heldTargetIds).toEqual(expect.arrayContaining(['claim-ldl', 'action-review']));
    expect(service.store.listAcceptedObservations(personId)).toEqual(facts);
    service.close();
  });

  it('首次P03已实质独立改写的旧行动直接进入完整P04，不重复消耗第二P03', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0]!.kind = 'source_fact';
    candidate.claims[0]!.diseaseName = '脂质代谢异常';
    candidate.claims[0]!.diagnosticStatus = 'documented';
    candidate.actions[0] = { ...candidate.actions[0]!, kind: 'habit', lifestyleDomain: 'diet', lifestyleBasis: 'personalized',
      title: '记录饮食习惯', why: '结合血脂判断安排饮食。', firstStep: '记录三餐。', timing: null };
    const repaired = structuredClone(candidate);
    repaired.actions[0]!.claimIds = [];
    repaired.actions[0]!.why = '原报告有血脂结果，可先记录目前习惯供医生了解，不据此确定病因。';
    let calls = 0;
    const facts = service.store.listAcceptedObservations(personId);
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      if (calls === 1) return { threadId: 'synthetic', turnId: 'p02', output: candidate };
      if (calls === 2) return { threadId: 'synthetic', turnId: 'p03', output: assessmentOutputFor(input.prompt, repaired) };
      expect(calls).toBe(3);
      expect(input.prompt).toContain('independent_habit_basis_review:action-review');
      expect(input.prompt).toContain(repaired.actions[0]!.why);
      return { threadId: 'synthetic', turnId: 'p04', output: focusedOutputFor(input.prompt, repaired) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 3 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims).toEqual([]);
    expect(snapshot.actions).toEqual(repaired.actions);
    expect(new Set(snapshot.reviewedTargetIds)).toEqual(new Set(['action-review', 'overview', ...candidate.systems.map((system) => system.id)]));
    expect(service.store.listAcceptedObservations(personId)).toEqual(facts);
    service.close();
  });

  it('P04替换的坏主张在后置P03被隔离时，连带的新独立改写不能沿用旧行动回执', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0]!.consequenceLevel = 'high';
    candidate.actions[0] = { ...candidate.actions[0]!, kind: 'habit', lifestyleDomain: 'diet', lifestyleBasis: 'personalized',
      title: '记录三餐习惯', why: '结合血脂判断了解饮食。', firstStep: '先记录三餐。', timing: null };
    const badClaim = { ...candidate.claims[0]!, evidenceIds: ['missing-personal-source'] };
    const repaired = structuredClone(candidate);
    repaired.claims[0] = badClaim;
    repaired.actions[0]!.claimIds = [];
    repaired.actions[0]!.why = '报告有单次血脂结果，先记录日常三餐供下次就诊了解，不据此确定病因。';
    let calls = 0;
    const facts = service.store.listAcceptedObservations(personId);
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      if (calls === 1) return { threadId: 'synthetic', turnId: 'p02', output: candidate };
      if (calls === 2) return { threadId: 'synthetic', turnId: 'p04', output: replaceFocusedClaim(candidate, badClaim) };
      if (calls === 4) {
        expect(input.prompt).toContain('"recoveryMode":"late_independent_habits"');
        return { threadId: 'synthetic', turnId: 'late-p03-unchanged', output: assessmentOutputFor(input.prompt, candidate) };
      }
      expect(calls).toBe(3);
      expect(input.prompt).toContain('REPAIR_REQUEST=');
      return { threadId: 'synthetic', turnId: 'p03', output: assessmentOutputFor(input.prompt, repaired) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 4 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims).toEqual([]);
    expect(snapshot.actions).toEqual([]);
    expect(snapshot.heldTargetIds).toEqual(expect.arrayContaining(['claim-ldl', 'action-review']));
    expect(service.store.listAcceptedObservations(personId)).toEqual(facts);
    service.close();
  });

  it('P04越过原医学范围后仅删引用的饮食建议不能沿用旧回执', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0]!.consequenceLevel = 'high';
    candidate.actions[0] = { ...candidate.actions[0]!, kind: 'habit', lifestyleDomain: 'diet', lifestyleBasis: 'personalized',
      title: '记录饮食习惯', why: '现有血脂结果可以用于安排日常饮食。', firstStep: '记录三餐并减少油炸食品。', timing: null };
    const facts = service.store.listAcceptedObservations(personId);
    const replacement = { ...candidate.claims[0]!, kind: 'diagnostic_assessment' as const,
      diseaseName: '脂质代谢异常', diagnosticStatus: 'possible' as const,
      text: '目前需要考虑脂质代谢异常可能，不能仅凭这一份报告确诊。', materialUncertainty: '病史和症状未提供。' };
    const repaired = structuredClone(candidate);
    repaired.actions[0]!.claimIds = [];
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      if (calls === 1) return { threadId: 'p02', turnId: '1', output: candidate };
      if (calls === 3) {
        expect(input.prompt).toContain('"recoveryMode":"late_independent_habits"');
        return { threadId: 'late-p03', turnId: '3', output: assessmentOutputFor(input.prompt, repaired) };
      }
      expect(calls).toBe(2);
      repaired.claims[0] = replacement;
      return { threadId: 'p04', turnId: '2', output: focusedOutputFor(input.prompt, repaired, ['claim-ldl', 'action-review']) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 3 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims).toEqual([]);
    expect(snapshot.actions).toEqual([]);
    expect(snapshot.heldTargetIds).toContain('claim-ldl');
    expect(snapshot.heldTargetIds).toContain('action-review');
    expect(result).toHaveProperty('focusedReviewDiagnostics', expect.arrayContaining([
      expect.objectContaining({ targetId: 'claim-ldl', verdict: 'replace', outcome: 'held', reasonCodes: ['focused_scope_boundary_changed'],
        boundaryReasonCodes: expect.arrayContaining(['p04_scope_boundary_changed', 'claim_kind_expanded', 'disease_changed']) }),
      expect.objectContaining({ targetId: 'action-review', verdict: 'replace', outcome: 'dependency_held', reasonCodes: ['focused_scope_boundary_changed'],
        boundaryReasonCodes: expect.arrayContaining(['original_claim_dependency_held', 'dependency_rewrite_not_substantive']) })
    ]));
    const audit = snapshot.reviewAuditRecords!;
    const claimAudit = audit.records.find((record) => record.targetId === 'claim-ldl' && record.phase === 'p04')!;
    expect(claimAudit.original).toEqual({ nodeType: 'claim', value: candidate.claims[0] });
    expect(claimAudit.replacement).toEqual({ nodeType: 'claim', value: replacement });
    expect(claimAudit).toMatchObject({ modelDecision: { verdict: 'replace', reason: '合成同次完整更正。' },
      receipt: { stage: 'p04', threadId: 'p04', turnId: '2' }, origin: 'local_boundary_guard', outcome: 'held',
      localReasonCodes: expect.arrayContaining(['p04_scope_boundary_changed', 'disease_changed']) });
    expect(result).not.toHaveProperty('reviewAuditRecords');
    // 下一次综合只读正常事实/本人背景，不把未发布原文、替换或模型理由当作事实再送回模型。
    const nextInput = buildMemberAssessmentInput(service.store, personId, {
      modelId: 'test-model', reasoningEffort: 'medium', analysisReferenceDate: '2026-09-22', webSearchAllowed: true
    });
    expect(JSON.stringify(nextInput)).not.toContain('reviewAuditRecords');
    expect(JSON.stringify(nextInput)).not.toContain('合成同次完整更正。');
    expect(service.store.listAcceptedObservations(personId)).toEqual(facts);
    service.close();
  });

  it('P04改写来源日期的原因贯通到私有审计，仍隔离原依赖且不再次调用模型', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    Object.assign(candidate.claims[0]!, { kind: 'source_fact', consequenceLevel: 'high',
      text: '2026年9月21日 LDL-C 4.2 mmol/L，高于该报告参考上限 3.4。' });
    const facts = service.store.listAcceptedObservations(personId);
    const replacement = structuredClone(candidate);
    replacement.claims[0]!.text = '2026年9月 LDL-C 4.2 mmol/L，高于该报告参考上限 3.4。';
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      if (calls === 1) return { threadId: 'p02', turnId: '1', output: candidate };
      expect(calls).toBe(2);
      return { threadId: 'p04', turnId: '2', output: focusedOutputFor(input.prompt, replacement, ['claim-ldl']) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims).toEqual([]);
    expect(snapshot.actions).toEqual([]);
    expect(snapshot.heldTargetIds).toEqual(expect.arrayContaining(['claim-ldl', 'action-review']));
    expect(result).toHaveProperty('focusedReviewDiagnostics', expect.arrayContaining([
      expect.objectContaining({ targetId: 'claim-ldl', outcome: 'held',
        boundaryReasonCodes: expect.arrayContaining(['date_scope_or_precision_changed']) })
    ]));
    const claimAudit = snapshot.reviewAuditRecords!.records.find((record) => record.targetId === 'claim-ldl'
      && record.phase === 'p04')!;
    expect(claimAudit.localReasonCodes).toContain('date_scope_or_precision_changed');
    expect(claimAudit.localReasonCodes).not.toContain('numeric_fact_added');
    expect(claimAudit.localReasonCodes).not.toContain('source_fact_numeric_changed');
    expect(service.store.listAcceptedObservations(personId)).toEqual(facts);
    service.close();
  });

  it.each(['pass_with_old_dependency', 'metadata_only_replace', 'direct_hold'] as const)('同次依赖回执%s仍隔离该行动，不复活直接拒绝或重复调用', async (mode) => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0]!.consequenceLevel = 'high';
    candidate.actions[0] = { ...candidate.actions[0]!, kind: 'habit', lifestyleDomain: 'diet', lifestyleBasis: 'personalized',
      title: '合成饮食安排', why: '结合现有报告。', firstStep: '记录日常三餐。', timing: null };
    const facts = service.store.listAcceptedObservations(personId);
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      if (calls === 1) return { threadId: 'p02', turnId: '1', output: candidate };
      expect(calls).toBe(2);
      const replacement = structuredClone(candidate);
      replacement.actions[0]!.claimIds = [];
      return { threadId: 'p04', turnId: '2', output: focusedOutputFor(input.prompt, replacement,
        mode === 'metadata_only_replace' ? ['action-review'] : [],
        ['claim-ldl', ...(mode === 'direct_hold' ? ['action-review'] : [])]) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    const published = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(published.actions).toEqual([]);
    expect(published.heldTargetIds).toContain('action-review');
    expect(service.store.listAcceptedObservations(personId)).toEqual(facts);
  });

  it('P04隔离主张后仅删除饮食行动依赖仍需隔离，不重提取事实', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0]!.consequenceLevel = 'high';
    candidate.actions[0] = { ...candidate.actions[0]!, kind: 'habit', lifestyleDomain: 'diet', lifestyleBasis: 'personalized',
      title: '调整日常饮食', why: '现有血脂记录提示需要关注饮食习惯。', firstStep: '记录三餐并减少油炸食品。',
      timing: null };
    const factsBefore = service.store.listAcceptedObservations(personId);
    const repaired = structuredClone(candidate);
    repaired.actions[0]!.claimIds = [];
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      if (calls === 1) return { threadId: 'p02', turnId: '1', output: candidate };
      expect(calls).toBe(2);
      expect(input.allowWebSearch).toBe(false);
      return { threadId: 'p04', turnId: '2', output: focusedOutputFor(input.prompt, repaired, ['action-review'], ['claim-ldl']) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    const published = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(published.claims).toEqual([]);
    expect(published.actions).toEqual([]);
    expect(published.heldTargetIds).toContain('action-review');
    expect(result).toHaveProperty('focusedReviewDiagnostics', expect.arrayContaining([
      expect.objectContaining({ targetId: 'action-review', verdict: 'replace', outcome: 'dependency_held', reasonCodes: ['independent_habit_repair_failed'],
        boundaryReasonCodes: expect.arrayContaining(['original_claim_dependency_held', 'dependency_rewrite_not_substantive']) })
    ]));
    expect(service.store.listAcceptedObservations(personId)).toEqual(factsBefore);
  });

  it.each(['new_evidence', 'new_scope', 'dose', 'urgency'] as const)('日常建议缩小依赖不能顺便%s', async (change) => {
    const { service, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.actions[0] = { ...candidate.actions[0]!, kind: 'habit', lifestyleDomain: 'diet', lifestyleBasis: 'personalized' };
    const after = structuredClone(candidate);
    after.actions[0]!.claimIds = [];
    if (change === 'new_evidence') after.actions[0]!.evidenceIds.push('new-evidence');
    if (change === 'new_scope') after.actions[0]!.systemIds.push('dermatological');
    if (change === 'dose') { after.actions[0]!.lifestyleDomain = 'supplements'; after.actions[0]!.firstStep = '每日补充维生素D 1000 IU。'; }
    if (change === 'urgency') after.actions[0]!.urgency = 'urgent';
    expect(focusedReviewBoundaryPreserved(candidate, after, 'action-review', built.evidencePackage.evidenceCatalog, '2026-09-22')).toBe(false);
    service.close();
  });
});

/** 测试中的 P03 模型回执只返回指定目标，非目标无需复制。 */
function assessmentOutputFor(prompt: string, output: unknown): unknown {
  if (!prompt.includes('REPAIR_REQUEST=') || typeof output !== 'object' || output === null
    || !('schemaVersion' in output) || output.schemaVersion !== 3) return output;
  const candidate = output as MemberAssessmentCandidateV3;
  const request = JSON.parse(prompt.split('REPAIR_REQUEST=')[1]!.split('\nSOURCE_CONTEXT=')[0]!) as AssessmentRepairRequestV1;
  return { schemaVersion: 1, personId: candidate.personId, inputSignature: candidate.inputSignature,
    originalCandidateHash: request.originalCandidateHash,
    results: request.targets.map((targetId) => ({ targetId, verdict: 'replace', reason: '合成目标修正。',
      replacement: structuredClone(assessmentRepairNode(candidate, targetId)) })) };
}

/** 旧临床门禁用例中的最终摘要机会明确返回不改写；专门的全文通过/拒绝测试见 final-dependencies。 */
function unchangedAggregateOutput(prompt: string): MemberAssessmentRepairV1 {
  expect(prompt).toContain('final_aggregate_summary_required:');
  const request = JSON.parse(prompt.split('REPAIR_REQUEST=')[1]!.split('\nSOURCE_CONTEXT=')[0]!) as AssessmentRepairRequestV1;
  return { schemaVersion: 1, personId: request.personId, inputSignature: request.inputSignature,
    originalCandidateHash: request.originalCandidateHash, results: request.targets.map((targetId) => ({
      targetId, verdict: 'unchanged', reason: '合成摘要保持不变。', replacement: null
    })) };
}

function replaceFocusedClaim(candidate: MemberAssessmentCandidateV3,
  replacement: MemberAssessmentCandidateV3['claims'][number]): ClinicalFocusedReviewV1 {
  return { schemaVersion: 1, personId: candidate.personId, inputSignature: candidate.inputSignature,
    results: routeFocusedReview(candidate).targetIds.map((targetId) => targetId === replacement.id
      ? { targetId, verdict: 'replace', reason: '合成局部替换。', replacement: { nodeType: 'claim', value: replacement } }
      : { targetId, verdict: 'pass', reason: '合成核对。', replacement: null }) };
}

describe('局部隔离后的系统关注状态复核', () => {
  it.each(['complete', 'unchanged'] as const)('重点主题变化解释只补一次，%s 后可靠事实与行动仍保留', async (mode) => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    const complete = structuredClone(candidate);
    delete candidate.claims[0]!.changeAssessment;
    const factsBefore = service.store.listAcceptedObservations(personId);
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      if (calls === 1) return { threadId: 'synthetic', turnId: 'p02', output: candidate };
      expect(input.prompt).toContain('topic_comparison_missing:claim-ldl');
      return { threadId: 'synthetic', turnId: 'p03', output: assessmentOutputFor(input.prompt, mode === 'complete' ? complete : candidate) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims).toEqual(mode === 'complete' ? complete.claims : candidate.claims);
    expect(snapshot.actions).toEqual(candidate.actions);
    expect(snapshot.comparisonCoverage?.missingTopicKeys).toEqual(mode === 'complete' ? [] : ['lipids']);
    expect(service.store.listAcceptedObservations(personId)).toEqual(factsBefore);
    service.close();
  });
  it.each(['attention', 'monitor'] as const)('无据汇总被隔离后P04可从存活支持显式恢复原%s，事实不变', async (status) => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    const systemId = candidate.systems[0]!.id;
    Object.assign(candidate.systems[0]!, { status, headline: '已经确诊恶性肿瘤。' });
    const facts = service.store.listAcceptedObservations(personId);
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      if (!input.prompt.includes('REVIEW_REQUEST=')) return {
        threadId: calls === 1 ? 'p02' : 'p03', turnId: String(calls), output: assessmentOutputFor(input.prompt, candidate)
      };
      const reviewRequest = JSON.parse(input.prompt.split('REVIEW_REQUEST=')[1]!.split('\nSOURCE_CONTEXT=')[0]!);
      expect(reviewRequest.rebuiltSystemStatusRestorations).toContainEqual({ targetId: systemId,
        systemId: candidate.systems[0]!.systemId, originalStatus: status });
      const nodes = JSON.parse(input.prompt.split('TARGET_NODES=')[1]!) as Array<{ id: string; node: MemberAssessmentCandidateV3['systems'][number] }>;
      const rebuilt = nodes.find((node) => node.id === systemId)!.node;
      expect(rebuilt.status).toBe('insufficient');
      const replacements = structuredClone(candidate);
      replacements.systems[0] = { ...rebuilt, status };
      return { threadId: 'p04', turnId: String(calls), output: focusedOutputFor(input.prompt, replacements, [systemId]) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 3 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.systems[0]).toMatchObject({ status, claimIds: ['claim-ldl'] });
    expect(snapshot.presentation?.rebuiltNodeIds).toContain(systemId);
    expect(service.listBodySystems(personId).find((system) => system.id === candidate.systems[0]!.systemId))
      .toMatchObject({ status, interpretationState: 'partial' });
    expect(snapshot.claims).toEqual(candidate.claims);
    expect(service.store.listAcceptedObservations(personId)).toEqual(facts);
    service.close();
  });

  it.each(['pass', 'hold', 'different_status', 'new_claim', 'support_held'] as const)(
    '重建系统遇到%s仍不自动恢复关注状态，也不复活已隔离内容', async (mode) => {
      const { service, personId, built } = await fixture();
      const candidate = candidateFor(built.request, built.evidencePackage);
      const systemId = candidate.systems[0]!.id;
      candidate.systems[0]!.headline = '已经确诊恶性肿瘤。';
      if (mode === 'support_held') candidate.claims[0]!.consequenceLevel = 'high';
      let calls = 0;
      const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
        calls += 1;
        if (!input.prompt.includes('REVIEW_REQUEST=')) return { threadId: 'synthetic', turnId: String(calls),
          output: assessmentOutputFor(input.prompt, candidate) };
        const nodes = JSON.parse(input.prompt.split('TARGET_NODES=')[1]!) as Array<{ id: string; node: MemberAssessmentCandidateV3['systems'][number] }>;
        const replacement = structuredClone(candidate);
        replacement.systems[0] = { ...nodes.find((node) => node.id === systemId)!.node,
          status: mode === 'different_status' ? 'monitor' : 'attention' };
        if (mode === 'new_claim') replacement.systems[0]!.claimIds.push('unknown-claim');
        return { threadId: 'p04', turnId: String(calls), output: focusedOutputFor(input.prompt, replacement,
          ['different_status', 'new_claim', 'support_held'].includes(mode) ? [systemId] : [],
          mode === 'hold' ? [systemId] : mode === 'support_held' ? ['claim-ldl'] : []) };
      } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
      expect(result.status).toBe('published');
      const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
      expect(snapshot.systems[0]!.status).toBe('insufficient');
      expect(service.listBodySystems(personId).find((system) => system.id === candidate.systems[0]!.systemId)?.status).toBe('building');
      if (mode === 'support_held') expect(snapshot.claims).toEqual([]);
      service.close();
    });

  it('仅行动在P04被hold时，未显式复核最终系统状态仍安全回退', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0]!.consequenceLevel = 'high';
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      return { threadId: calls === 1 ? 'p02' : 'p04', turnId: String(calls), output: calls === 1
        ? candidate : focusedOutputFor(input.prompt, candidate, [], ['action-review']) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims).toEqual(candidate.claims);
    expect(snapshot.actions).toEqual([]);
    expect(snapshot.systems[0]!.status).toBe('insufficient');
    service.close();
  });

  it('P04恢复后P03改变实际支持主张时，旧状态恢复权限不能代替最终依赖复核凭据', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    const systemId = candidate.systems[0]!.id;
    candidate.systems[0]!.headline = '已经确诊恶性肿瘤。';
    candidate.claims[0]!.consequenceLevel = 'high';
    let calls = 0;
    let focusedGraph: MemberAssessmentCandidateV3 | null = null;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      if (input.prompt.includes('REVIEW_REQUEST=')) {
        const nodes = JSON.parse(input.prompt.split('TARGET_NODES=')[1]!) as Array<{ id: string; node: MemberAssessmentCandidateV3['systems'][number] }>;
        focusedGraph = structuredClone(candidate);
        focusedGraph.systems[0] = { ...nodes.find((node) => node.id === systemId)!.node, status: 'attention' };
        focusedGraph.claims[0]!.rationale = '经模型复核，报告有对应结果。';
        return { threadId: 'p04', turnId: String(calls), output: focusedOutputFor(input.prompt, focusedGraph, [systemId, 'claim-ldl']) };
      }
      const output = focusedGraph ? structuredClone(focusedGraph) : candidate;
      if (focusedGraph) output.claims[0]!.rationale = '这份报告有对应结果，仍需结合原有条件理解。';
      return { threadId: calls === 1 ? 'p02' : 'p03', turnId: String(calls), output: assessmentOutputFor(input.prompt, output) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 4 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims[0]!.rationale).toBe('这份报告有对应结果，仍需结合原有条件理解。');
    expect(snapshot.systems[0]!.status).toBe('insufficient');
    expect(service.listBodySystems(personId).find((system) => system.id === candidate.systems[0]!.systemId)?.status).toBe('building');
    service.close();
  });
});

/** 按本次P04真实目标生成完整合成回执；依赖闭包扩展时不能遗漏目标。 */
function focusedOutputFor(prompt: string, candidate: MemberAssessmentCandidateV3,
  replacementIds: readonly string[] = [], heldIds: readonly string[] = []): ClinicalFocusedReviewV1 {
  const request = JSON.parse(prompt.split('REVIEW_REQUEST=')[1]!.split('\nSOURCE_CONTEXT=')[0]!) as {
    personId: string; inputSignature: string; targets: string[]
  };
  return { schemaVersion: 1, personId: request.personId, inputSignature: request.inputSignature,
    results: request.targets.map((targetId) => {
      if (heldIds.includes(targetId)) return { targetId, verdict: 'hold', reason: '合成来源不能支持此节点。', replacement: null };
      if (!replacementIds.includes(targetId)) return { targetId, verdict: 'pass', reason: '合成全文核对通过。', replacement: null };
      const replacement = assessmentRepairNode(candidate, targetId);
      if (!replacement || replacement.nodeType === 'knowledge_source') throw new Error('SYNTHETIC_REVIEW_REPLACEMENT_INVALID');
      return { targetId, verdict: 'replace', reason: '合成同次完整更正。', replacement: structuredClone(replacement) };
    }) };
}

/** 固定真实纯合成 turn2/turn3 的临床结构，日期和证据在测试工作区重新产生。 */
async function chestReviewFixture(separateEcgSpans = false) {
  const root = mkdtempSync(join(tmpdir(), 'family-health-chest-focused-review-'));
  roots.push(root);
  const service = new PersonalWorkspaceService(root, '合成工作区', () => new Date('2026-09-22T00:00:00Z'));
  const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
  const quote = separateEcgSpans ? '检查日期：2023-10-08\n心电图小结：未见明显异常。'
    : '检查日期：2023-10-08；心电图小结：未见明显异常。';
  await service.importFiles([{ path: '/tmp/合成旧心电图.txt', bytes: Buffer.from(quote) }], personId);
  const documentId = service.getSnapshot(null).inbox[0]!.id;
  const spans = service.store.getDocumentExtractionBundle(documentId).manifest.spans;
  const extraction: ExtractionResult = { schemaVersion: 1, documentId, coveredSourceSpanIds: spans.map((span) => span.id),
    subject: { reportedName: null, evidence: [], confidence: 'absent' }, candidates: [{
      localKey: 'ecg-summary', originalName: '心电图小结', standardNameCandidate: null,
      value: { kind: 'text', rawText: '未见明显异常。' }, unitRaw: null, referenceRangeRaw: null,
      reportedAbnormalFlag: null, specimen: null, method: null, bodySite: null, clinicalDate: '2023-10-08',
      clinicalContext: { version: 1, status: 'complete', conditions: [] },
      evidence: spans.map((span) => ({ sourceSpanId: span.id, quote: span.quote })), issues: []
    }] };
  expect((await new DocumentExtractionPipeline(service.store, { runStructuredTurn: async (input) => ({
    threadId: 'p01', turnId: 'synthetic', output: assessmentOutputFor(input.prompt, extraction)
  }) }).process(documentId)).status).toBe('published');
  const note = service.createManualNote({ personId, kind: 'history', immutableText: '本人今天自述持续胸痛并伴出汗。',
    effectiveDate: '2026-09-22', structuredFields: {}, expectedContextRevision: 0 });
  const built = buildMemberAssessmentInput(service.store, personId, {
    modelId: 'test-model', reasoningEffort: 'medium', analysisReferenceDate: '2026-09-22', webSearchAllowed: true
  });
  const sourceId = `note-evidence-${note.id}`;
  const ecgIds = built.evidencePackage.facts[0]!.evidenceIds;
  const systemIds = built.request.requestedSystemIds;
  const base = candidateFor(built.request, built.evidencePackage).claims[0]!;
  const ecg = { ...base, id: 'claim:ecg', topicKey: 'historical_ecg', kind: 'source_fact' as const,
    text: '2023年10月8日的心电图小结记载“未见明显异常”。心电图反映的是检查当时的心脏电活动，这份旧结果不能说明2026年9月22日胸痛时的情况。',
    temporalStatus: 'historical' as const, evidenceIds: ecgIds, knowledgeBasis: 'catalog' as const,
    knowledgeSourceIds: ['knowledge-lab-results-context'], consequenceLevel: 'important' as const,
    rationale: '报告只有2023年一次心电图小结；单次检查结果不能代表其他时间的整体健康状况。' };
  const chest = { ...base, id: 'claim:chest_pain', topicKey: 'chest_pain_with_sweating', kind: 'source_fact' as const,
    changeAssessment: firstRecordChange([sourceId]),
    text: '本人自述2026年9月22日当天持续胸痛并伴出汗；这是本人提供的症状信息，尚无同期医院检查结果。',
    temporalStatus: 'historical' as const, evidenceIds: [sourceId], knowledgeBasis: 'not_applicable' as const,
    rationale: '本人自述明确给出了症状及适用日期。',
    materialUncertainty: '不知道症状目前是否仍持续、是否复发，以及当时是否已经就医。', consequenceLevel: 'high' as const };
  const acs = { ...chest, id: 'claim:acs', topicKey: 'possible_acute_coronary_syndrome', kind: 'diagnostic_assessment' as const,
    text: '2026年9月22日自述的持续胸痛伴出汗，可能与急性冠脉综合征有关。这是心脏供血突然减少的一组急症，仅供排查方向参考，并非已经确诊；若现在仍有胸痛或再次发作，需要立即就医。',
    diseaseName: '急性冠脉综合征', diagnosticStatus: 'possible' as const, knowledgeBasis: 'model_general' as const,
    rationale: '持续胸痛伴出汗值得及时排查心脏供血问题；旧心电图不能判断这次发作。',
    materialUncertainty: '缺少发作时的心电图、肌钙蛋白等心肌损伤检查及临床评估，无法确定病因，也不知道目前是否仍有症状。' };
  const action = { ...candidateFor(built.request, built.evidencePackage).actions[0]!, id: 'action:chest_pain_emergency',
    dedupeKey: 'chest_pain_with_sweating_urgent_assessment', claimIds: [chest.id, acs.id, ecg.id], kind: 'seek_care' as const,
    title: '根据胸痛是否仍在，尽快接受评估', why: '持续胸痛伴出汗需要排查心脏急症；2023年的心电图不能判断这次症状。',
    firstStep: '如果现在仍在胸痛，或胸痛再次出现，立即停止活动、坐下休息并拨打120，不要自行驾车。若症状已缓解，但9月22日那次发作尚未接受评估，尽快到急诊说明发作经过。',
    timing: '仍在胸痛或再次发作时立即；已缓解但未评估时尽快。',
    reviewPlan: '向接诊人员说明胸痛和出汗的发生时间、持续情况及是否复发，由其判断是否需要当下心电图、肌钙蛋白等检查。',
    caution: '不要因为2023年的心电图小结未见明显异常而延迟处理新的胸痛。',
    urgency: 'emergency' as const, evidenceIds: [sourceId, ...ecgIds] };
  const candidate: MemberAssessmentCandidateV3 = { ...candidateFor(built.request, built.evidencePackage),
    overview: { id: 'overview', headline: '胸痛伴出汗需要优先处理',
      summary: '2026年9月22日，本人自述当日持续胸痛并伴出汗。这种症状需要及时排查心脏急症：如果现在仍在胸痛，或胸痛再次出现，应立即拨打120。2023年10月8日的心电图小结为“未见明显异常”，但那是近三年前的检查，不能说明这次胸痛的原因。',
      claimIds: [chest.id, ecg.id, acs.id], actionIds: [action.id],
      limitations: ['尚无这次胸痛发作时的检查或就医结果，也不知道症状目前是否仍在持续。'] },
    systems: systemIds.map((systemId) => ({ id: `system:${systemId}`, systemId, status: 'attention',
      headline: '持续胸痛伴出汗，需排查心脏急症',
      summary: '心电图记录的是检查时的心脏电活动。2023年10月8日的心电图小结未见明显异常，不能排除2026年9月22日自述胸痛时出现的新问题。胸痛伴出汗可能与心脏供血突然减少等急症有关，仅凭症状无法确定原因；若现在仍有症状或再次发作，应立即拨打120。',
      claimIds: [ecg.id, chest.id, acs.id], actionIds: [action.id],
      limitations: ['缺少胸痛发作时的心电图、心肌损伤检查及临床评估。'] })),
    claims: [ecg, chest, acs], actions: [action], questions: [{ id: 'question:current_symptoms_and_assessment',
      question: '9月22日那次胸痛后来是否缓解、是否复发，目前还有胸痛吗；当时是否接受过急诊评估？',
      whyItMatters: '这些信息决定是否需要现在立即呼叫急救，以及能否依据同期检查进一步判断原因。若目前正在胸痛，不必等回答后再拨打120。',
      relatedClaimIds: [chest.id, acs.id], evidenceIds: [sourceId] }], knowledgeSources: [] };
  const entry = built.evidencePackage.knowledge.find((item) => item.id === 'knowledge-lab-results-context')!;
  candidate.knowledgeSources.push({ id: entry.id, title: entry.title, organization: entry.sourceOrganization,
    url: entry.sourceUrl, origin: 'catalog', supports: entry.supportedScope });
  const correctedChest = { ...chest, temporalStatus: 'current' as const,
    text: '本人自述2026年9月22日当天持续胸痛并伴出汗；这是本人提供的症状信息，尚无当天医院检查结果。',
    rationale: '本人自述明确给出了症状及适用日期，日期与分析参考日期相同。',
    materialUncertainty: '不知道胸痛此刻是否仍持续、是否复发，以及是否已经就医。' };
  const correctedAcs = { ...acs, temporalStatus: 'current' as const,
    rationale: '当天自述的持续胸痛伴出汗值得及时排查心脏供血问题；旧心电图不能判断这次发作。',
    materialUncertainty: '缺少发作时的心电图、肌钙蛋白等心肌损伤检查及临床评估，无法确定病因，也不知道胸痛此刻是否仍在持续。' };
  const targets = [chest.id, action.id, ...candidate.systems.map((system) => system.id), 'overview', acs.id, ecg.id,
    ...candidate.questions.map((question) => question.id)];
  const review: ClinicalFocusedReviewV1 = { schemaVersion: 1, personId, inputSignature: built.request.inputSignature,
    results: targets.map((targetId) => targetId === chest.id || targetId === acs.id
      ? { targetId, verdict: 'replace', reason: '适用日期与分析参考日期相同，症状是否仍持续保留未知。',
        replacement: { nodeType: 'claim', value: targetId === chest.id ? correctedChest : correctedAcs } }
      : { targetId, verdict: targetId === ecg.id ? 'hold' : 'pass', reason: '核对原范围内依据与紧急行动。', replacement: null }) };
  return { service, personId, built, candidate, review, correctedChest, correctedAcs };
}

/** 固定 nT1ck0 的同次 P04 纠错：删除旧 ECG 反证，而非增加新方向或支持依据。 */
async function counterEvidenceReviewFixture() {
  const { service, personId, built, candidate: base } = await chestReviewFixture(true);
  const sourceId = base.claims.find((claim) => claim.id === 'claim:chest_pain')!.evidenceIds[0]!;
  const ecgIds = base.claims.find((claim) => claim.id === 'claim:ecg')!.evidenceIds;
  expect(ecgIds).toHaveLength(2);
  const chest = { ...base.claims.find((claim) => claim.id === 'claim:chest_pain')!,
    text: '本人在2026年9月22日自述持续胸痛并伴出汗。',
    rationale: '症状及适用日期来自本人自述，尚无同期医院检查结果。',
    materialUncertainty: '无法从这条自述确定症状此刻是否仍在持续。' };
  const acs = { ...base.claims.find((claim) => claim.id === 'claim:acs')!, id: 'claim:cardiac_cause',
    text: '持续胸痛伴出汗提示需要立即排查急性冠脉综合征等危险原因；这是需要急诊鉴别的可能方向，并非已经确诊。',
    counterEvidenceIds: [...ecgIds],
    rationale: '2026年9月22日自述持续胸痛伴出汗；2023年的心电图结果不能判断这次发作的原因。',
    materialUncertainty: '需要发作时的心电图、心肌损伤相关检查及医生评估，才能区分心脏与其他病因；现有资料也不能判断症状目前是否持续。' };
  const ecg = { ...base.claims.find((claim) => claim.id === 'claim:ecg')!, id: 'claim:old_ecg', kind: 'interpretation' as const,
    text: '2023年10月8日的心电图小结为“未见明显异常”。心电图反映检查当时的心脏电活动；这份旧结果不能排除2026年9月22日胸痛时出现的新问题。',
    evidenceIds: [...ecgIds, sourceId], knowledgeBasis: 'model_general' as const, knowledgeSourceIds: [],
    rationale: '心电图检查日期早于本人自述胸痛的日期，且没有本次发作时的检查结果。', materialUncertainty: null };
  const claimIds = [chest.id, acs.id, ecg.id];
  const action = { ...base.actions[0]!, id: 'action:emergency_chest_pain',
    dedupeKey: 'emergency_evaluation_for_chest_pain_with_sweating', claimIds,
    title: '胸痛仍在持续或再次出现时，立即呼叫急救',
    why: '持续胸痛伴出汗可能涉及需要尽快处理的心脏问题；2023年的心电图不能判断这次发作。',
    firstStep: '若此刻仍在胸痛，或胸痛再次出现，立即拨打当地急救电话，说明胸痛和出汗的情况；等待救援时避免自行驾车。',
    timing: '症状仍在持续或再次出现时立即行动；若2026年9月22日的症状已结束但当时未接受评估，也应尽快就医说明经过。',
    reviewPlan: '由急诊医生结合发作时的心电图、心肌损伤相关检查和症状经过判断原因及后续安排。',
    caution: '不要因为过去的心电图小结正常而延误当前就医。' };
  const actionIds = [action.id];
  const candidate: MemberAssessmentCandidateV3 = { ...base,
    overview: { id: 'overview', headline: '持续胸痛伴出汗需要立即排查危险原因',
      summary: '本人在2026年9月22日自述持续胸痛并伴出汗，这是需要立即急诊评估的症状。2023年的心电图小结虽写着“未见明显异常”，但它反映的是当时的检查，不能说明这次胸痛是否安全。若此刻仍在胸痛，或胸痛再次出现，应立即呼叫急救。',
      claimIds, actionIds, limitations: ['现有资料没有这次胸痛发作时的心电图、心肌损伤相关检查或医生评估，无法确定病因。'] },
    systems: base.systems.map((system) => ({ ...system,
      headline: '胸痛伴出汗，应立即评估心脏等危险原因',
      summary: '心电图记录的是检查当时的心脏电活动。2023年10月8日报告的小结为“未见明显异常”，但与2026年9月22日自述的持续胸痛并非同一次发作。胸痛伴出汗可能与急性心脏问题有关，仅凭症状不能确定原因，需要及时做发作时的检查。',
      claimIds, actionIds, limitations: ['缺少这次胸痛发作时的检查结果；既往心电图不能代替当前评估。'] })),
    claims: [chest, acs, ecg], actions: [action], questions: [{ id: 'question:current_symptoms',
      question: '胸痛和出汗现在是否仍在持续，或此后是否再次出现？',
      whyItMatters: '这决定是否需要立即呼叫急救；无论答案如何，都不影响对2026年9月22日那次持续胸痛进行医学评估的必要性。',
      relatedClaimIds: [chest.id, acs.id], evidenceIds: [sourceId] }], knowledgeSources: [] };
  const correctedChest = { ...chest, temporalStatus: 'current' as const,
    rationale: '症状和日期来自本人自述，尚无这次发作时的医院检查结果。',
    materialUncertainty: '无法从这条自述确定此刻是否仍在胸痛。' };
  const correctedAcs = { ...acs, temporalStatus: 'current' as const, counterEvidenceIds: [],
    text: '2026年9月22日本人自述持续胸痛并伴出汗，需要立即排查急性冠脉综合征，即心脏供血突然受到阻碍的一组急症。这是可能的原因，并非已经确诊。',
    rationale: '持续胸痛伴出汗是需要紧急排查心脏危险原因的表现；2023年10月8日的心电图不能判断2026年9月22日这次发作的原因。',
    materialUncertainty: '缺少这次发作相关的心电图、心肌损伤检查和医生评估，无法判断是否为急性冠脉综合征或其他病因；也无法确定此刻是否仍在胸痛。' };
  const correctedAction = { ...action, title: '胸痛伴出汗，请立即接受急诊评估',
    why: '2026年9月22日自述的持续胸痛伴出汗，可能涉及需要紧急处理的心脏问题；即使胸痛已经缓解，也不能仅凭症状变化或2023年的心电图排除危险原因。',
    firstStep: '若此刻仍在胸痛或胸痛再次出现，立即拨打当地急救电话，说明胸痛和出汗的情况，避免自行驾车；若症状已缓解但尚未接受评估，也请立即前往急诊说明发作经过。',
    timing: '现在行动；持续或再次胸痛时立即呼叫急救，已缓解但未经评估时也立即接受急诊评估。',
    reviewPlan: '由急诊医生结合症状经过、这次发作相关的心电图和心肌损伤检查判断原因及后续安排。',
    caution: '不要因为2023年心电图小结写着“未见明显异常”而延误这次就医。' };
  const correctedSystems = candidate.systems.map((system) => ({ ...system,
    headline: '胸痛伴出汗，应立即排查危险原因',
    summary: '心电图记录检查当时心脏的电活动。2023年10月8日的心电图小结为“未见明显异常”，不能说明2026年9月22日自述的持续胸痛伴出汗是否安全。这种症状可能涉及心脏供血突然受阻等急症，但单凭症状不能确定病因。若仍在胸痛或再次发作，请立即呼叫急救；若已缓解但尚未接受评估，也请立即到急诊说明经过。',
    limitations: ['缺少这次胸痛发作相关的检查和医生评估，目前无法确定病因或症状此刻是否仍在持续。'] }));
  const correctedOverview = { ...candidate.overview, headline: '胸痛伴出汗，需要立即就医排查',
    summary: '本人在2026年9月22日自述持续胸痛并伴出汗，可能涉及心脏供血突然受阻等危险原因，需要立即接受急诊评估。2023年心电图小结写着“未见明显异常”，只能反映当时的检查，不能判断这次胸痛的原因。若此刻仍在胸痛或再次发作，请立即呼叫急救；即使已经缓解，只要尚未接受评估，也请立即到急诊说明经过。',
    limitations: ['现有资料没有这次发作相关的心电图、心肌损伤检查或医生评估，无法确定病因；也无法确定此刻是否仍在胸痛。'] };
  const review: ClinicalFocusedReviewV1 = { schemaVersion: 1, personId, inputSignature: candidate.inputSignature,
    results: [{ targetId: chest.id, verdict: 'replace', reason: '当日症状标为 current，但是否仍持续保持未知。',
      replacement: { nodeType: 'claim', value: correctedChest } },
    { targetId: action.id, verdict: 'replace', reason: '已缓解但未经评估也立即急诊；原本就是同一紧急行动。',
      replacement: { nodeType: 'action', value: correctedAction } },
    ...correctedSystems.map((system) => ({ targetId: system.id, verdict: 'replace' as const,
      reason: '旧 ECG 不是这次症状的反证。', replacement: { nodeType: 'system' as const, value: system } })),
    { targetId: 'overview', verdict: 'replace', reason: '保留同次急诊评估与未知边界。',
      replacement: { nodeType: 'overview', value: correctedOverview } },
    { targetId: acs.id, verdict: 'replace', reason: '旧 ECG 不应列作排除当日心脏问题的反证。',
      replacement: { nodeType: 'claim', value: correctedAcs } },
    ...candidate.questions.map((question) => ({ targetId: question.id, verdict: 'pass' as const,
      reason: '同次核对问题前提及其未知范围。', replacement: null }))] };
  return { service, personId, built, candidate, review, correctedChest, correctedAcs, correctedAction };
}

describe('MemberAssessmentPipeline', () => {
  it('系统代理实际正文进入 P04，回执与发布同次绑定；只更新综合且事实不变', async () => {
    const { service, personId, documentId, built } = await fixture();
    const originalFacts = service.store.listAcceptedObservations(personId);
    const candidate = candidateFor(built.request, built.evidencePackage);
    const knowledgeId = 'synthetic-public-guidance';
    candidate.knowledgeSources = [{ id: knowledgeId, title: '合成公共材料', organization: null,
      url: 'https://www.who.int/synthetic-guidance', origin: 'retrieved', supports: '合成测试范围' }];
    candidate.claims[0]!.knowledgeBasis = 'retrieved'; candidate.claims[0]!.knowledgeSourceIds = [knowledgeId];
    candidate.claims[0]!.consequenceLevel = 'high';
    const accountFingerprint = 'synthetic-public-source-account';
    const consentId = service.store.createManualProcessingConsent({ documentIds: [documentId], personIds: [personId],
      historicalObservationIds: originalFacts.map((fact) => fact.id), accountFingerprint, version: 1, assessmentOnly: true });
    const jobId = service.store.createWaitingAuthBatch({ cutoff: '2026-09-22T00:00:00Z', initialStatus: 'queued', consentId,
      groups: [{ personId, documentIds: [documentId], inputSignature: 'synthetic-official-body', stage: 'analyze' }] }).jobIds[0]!;
    service.store.claimNextQueuedJob('synthetic-runner', accountFingerprint);
    const attemptId = service.store.startJobAttempt(jobId, 'synthetic-runtime', 'test-model', 'medium');
    const guard = { jobId, attemptId, consentId, accountFingerprint };
    const prompts: string[] = []; let proxyReads = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      prompts.push(input.prompt);
      return { threadId: 'synthetic', turnId: 'synthetic', output: input.prompt.includes('REVIEW_REQUEST=')
        ? focusedOutputFor(input.prompt, candidate) : candidate };
    } }, undefined, guard, documentId, 'test-model', 'medium', '2026-09-22', true, {
      resolveSystemProxy: async () => 'PROXY 127.0.0.1:7897',
      lookup: async () => { throw new Error('MUST_NOT_RESOLVE_TARGET_LOCALLY'); },
      request: async () => { throw new Error('MUST_NOT_CONNECT_DIRECT'); },
      requestViaProxy: async () => { proxyReads += 1; return { status: 200, headers: { 'content-type': 'text/html' },
        body: Buffer.from(`<head><script>${'synthetic-metadata'.repeat(2000)}</script></head><main>Actual fictional source condition.</main>`) }; }
    }).process(personId);
    expect(result.status).toBe('published'); expect(proxyReads).toBe(1);
    const reviewPrompt = prompts.find((prompt) => prompt.includes('REVIEW_REQUEST='))!;
    expect(reviewPrompt).toContain('Actual fictional source condition.');
    expect(reviewPrompt).toContain('official-https-content-v2:');
    expect(reviewPrompt).toContain('"contentScope":"main"');
    expect(reviewPrompt).not.toContain('synthetic-metadata');
    expect(prompts.some((prompt) => prompt.includes('DIRECT_ORIGINAL_P01'))).toBe(false);
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.knowledgeVerifications).toContainEqual(expect.objectContaining({ sourceId: knowledgeId,
      status: 'tool_content_verified', toolReceiptId: expect.stringMatching(/^official-https-content-v2:/) }));
    expect(service.store.listAcceptedObservations(personId)).toEqual(originalFacts);
    service.close();
  });

  it('实际知识读取失败原因在综合成功和检查点清理之后仍可核查', async () => {
    const { service, personId, documentId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    const knowledgeId = 'synthetic-unavailable-knowledge';
    candidate.knowledgeSources = [{ id: knowledgeId, title: '合成公开材料', organization: null,
      url: 'https://not-approved.example/public-reference', origin: 'retrieved', supports: '合成范围' }];
    candidate.claims[0]!.knowledgeBasis = 'retrieved'; candidate.claims[0]!.knowledgeSourceIds = [knowledgeId];
    const accountFingerprint = 'synthetic-diagnostic-account';
    const consentId = service.store.createManualProcessingConsent({ documentIds: [documentId], personIds: [personId],
      historicalObservationIds: service.store.listAcceptedObservations(personId).map((fact) => fact.id),
      accountFingerprint, version: 1, assessmentOnly: true });
    const jobId = service.store.createWaitingAuthBatch({ cutoff: '2026-09-22T00:00:00Z', initialStatus: 'queued', consentId,
      groups: [{ personId, documentIds: [documentId], inputSignature: 'synthetic-diagnostic', stage: 'analyze' }] }).jobIds[0]!;
    service.store.claimNextQueuedJob('synthetic-runner', accountFingerprint);
    const attemptId = service.store.startJobAttempt(jobId, 'synthetic-runtime', 'test-model', 'medium');
    const guard = { jobId, attemptId, consentId, accountFingerprint };
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => ({
      threadId: 'synthetic', turnId: 'synthetic', output: input.prompt.includes('REVIEW_REQUEST=')
        ? focusedOutputFor(input.prompt, candidate) : candidate
    }) }, undefined, guard, documentId, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result.status).toBe('published');
    service.store.finishJob(jobId, 'completed_with_issues');
    service.store.finishJobAttempt({ attemptId, status: 'completed_with_issues' });
    const db = new Database(service.store.databasePath, { readonly: true });
    try {
      const rows = db.prepare("SELECT summary FROM audit_events WHERE event_type='assessment_knowledge_retrieval' AND entity_id=?")
        .all(jobId) as Array<{ summary: string }>;
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]!.summary).outcomes).toEqual([expect.objectContaining({ status: 'failed', code: 'url_not_allowed' })]);
      expect(rows[0]!.summary).not.toContain('not-approved.example');
      expect(rows[0]!.summary).not.toContain(knowledgeId);
    } finally { db.close(); service.close(); }
  });

  it('P04连接失败后跨进程从综合断点继续，不重新发送已成功P02或重新提取事实', async () => {
    const prepared = await fixture();
    let service = prepared.service;
    const { personId, documentId, built } = prepared;
    const originalFacts = service.store.listAcceptedObservations(personId);
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0]!.consequenceLevel = 'high';
    const accountFingerprint = 'synthetic-checkpoint-account';
    const consentId = service.store.createManualProcessingConsent({ documentIds: [documentId], personIds: [personId],
      historicalObservationIds: originalFacts.map((fact) => fact.id), accountFingerprint, version: 1, assessmentOnly: true });
    const jobId = service.store.createWaitingAuthBatch({ cutoff: '2026-09-22T00:00:00Z', initialStatus: 'queued', consentId,
      groups: [{ personId, documentIds: [documentId], inputSignature: 'synthetic-assessment-resume', stage: 'analyze' }] }).jobIds[0]!;
    service.store.claimNextQueuedJob('synthetic-runner', accountFingerprint);
    const attemptId = service.store.startJobAttempt(jobId, 'synthetic-runtime', 'test-model', 'medium');
    const guard = { jobId, attemptId, consentId, accountFingerprint };
    let p02 = 0; let p04 = 0;
    const runtime = { runStructuredTurn: async (input: { prompt: string }) => {
      if (input.prompt.includes('REVIEW_REQUEST=')) {
        p04++;
        if (p04 === 1) throw new CodexTurnFailure({ code: 'CODEX_CONNECTION_FAILED' });
        return { threadId: 'synthetic-p04', turnId: 'review', output: focusedOutputFor(input.prompt, candidate),
          metrics: { durationMs: 10, inputTokens: 20, outputTokens: 5 } };
      }
      p02++;
      return { threadId: 'synthetic-p02', turnId: 'analysis', output: candidate,
        metrics: { durationMs: 20, inputTokens: 40, outputTokens: 10 } };
    } };
    await expect(new MemberAssessmentPipeline(service.store, runtime, undefined, guard, documentId,
      'test-model', 'medium', '2026-09-22').process(personId)).rejects.toThrow();
    service.store.finishJobAttempt({ attemptId, status: 'failed', errorCode: 'CODEX_CONNECTION_FAILED' });
    service.store.finishJob(jobId, 'failed');
    const directory = service.store.rootDirectory;
    service.close();
    service = new PersonalWorkspaceService(directory, '合成工作区', () => new Date('2026-09-22T00:00:00Z'));
    service.store.retryFailedJob(jobId);
    expect(service.store.claimNextQueuedJob('synthetic-runner', accountFingerprint)?.id).toBe(jobId);
    const resumedGuard = { ...guard, attemptId: service.store.startJobAttempt(jobId, 'synthetic-runtime', 'test-model', 'medium') };
    await expect(new MemberAssessmentPipeline(service.store, runtime, undefined, resumedGuard, documentId,
      'test-model', 'medium', '2026-09-22').process(personId)).resolves.toMatchObject({ status: 'published' });
    expect({ p02, p04 }).toEqual({ p02: 1, p04: 2 });
    expect(service.store.listAcceptedObservations(personId)).toEqual(originalFacts);
  });

  it('系统摘要与带不确定性的解释同时进入复核，不把错误前提当只读事实带回', async () => {
    const { service, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0]!.materialUncertainty = '合成检查背景未提供。';
    const ids = focusedReviewDependencyClosure(candidate, [candidate.systems[0]!.id]);
    expect(ids).toContain(candidate.claims[0]!.id);
    expect(ids).toContain(candidate.actions[0]!.id);
    expect(ids).toContain('overview');
    expect(focusedReviewDependencyClosure(candidate, ['overview'])).toContain(candidate.claims[0]!.id);
    const context = focusedReviewSourceContext(candidate, ids, built.evidencePackage, '2026-09-22');
    expect(context.readOnlyClaims).toEqual([]);
    service.close();
  });

  it('来源明示方法但正文写缺方法时，前置核正后P04复核主张和摘要并保留其他真实未知', async () => {
    const { service, personId, built } = await fixture(false, false, false, '', '；检查方法：合成光学法。');
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0]!.materialUncertainty = '检查方法及检查前用药条件未提供。';
    candidate.claims[0]!.text += '检查方法未提供。';
    candidate.overview.summary = candidate.claims[0]!.text;
    candidate.systems[0]!.summary = candidate.claims[0]!.text;
    const repaired = structuredClone(candidate);
    repaired.claims[0]!.text = candidateFor(built.request, built.evidencePackage).claims[0]!.text + '报告写明采用合成光学法。';
    repaired.claims[0]!.materialUncertainty = '检查前用药条件未提供。';
    repaired.overview.summary = repaired.claims[0]!.text;
    repaired.systems[0]!.summary = repaired.claims[0]!.text;
    const factsBefore = service.store.listAcceptedObservations(personId);
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls++;
      if (calls === 1) return { threadId: 'synthetic', turnId: 'p02', output: candidate };
      if (calls === 2) {
        expect(input.prompt).toContain('limitation_source_check_required:claim-ldl');
        expect(input.prompt).toContain('检查方法：合成光学法');
        return { threadId: 'synthetic', turnId: 'p03', output: assessmentOutputFor(input.prompt, repaired) };
      }
      expect(calls).toBe(3);
      expect(input.prompt).toContain('limitation_source_consistency:claim-ldl');
      expect(input.prompt).toContain('检查方法：合成光学法');
      expect(input.prompt).toContain('仅修摘要而留下错误 claim 不算完成');
      expect(input.allowWebSearch).toBe(false);
      return { threadId: 'synthetic', turnId: 'p04', output: focusedOutputFor(input.prompt, repaired) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 3 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims).toEqual(repaired.claims);
    expect(snapshot.overview.summary).toBe(repaired.overview.summary);
    expect(snapshot.systems[0]!.summary).toBe(repaired.systems[0]!.summary);
    expect(snapshot.heldTargetIds).toEqual([]);
    expect(service.store.listAcceptedObservations(personId)).toEqual(factsBefore);
    service.close();
  });

  it('实际知识正文进入P04并明确提供片段范围，不将网址标题标成已读取全文', async () => {
    const { service, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    const receipt = { sourceId: 'synthetic-retrieved', url: 'https://www.who.int/synthetic-public-page',
      finalUrl: 'https://www.who.int/synthetic-public-page', content: 'x'.repeat(30_000), contentType: 'text/html',
      contentHash: '1'.repeat(64), bodyHash: '2'.repeat(64), checkedAt: '2026-09-22T00:00:00Z',
      toolReceiptId: 'synthetic-http-content-receipt', retrievalVersion: 'official-https-content-v2' as const,
      contentFormat: 'static_text' as const, contentScope: 'main' as const };
    candidate.knowledgeSources.push({ id: receipt.sourceId, title: '合成公共知识页', organization: null,
      url: receipt.url, origin: 'retrieved', supports: '仅合成范围' });
    const context = focusedReviewSourceContext(candidate, [candidate.claims[0]!.id], built.evidencePackage, '2026-09-22', [receipt]);
    expect(context.retrievedKnowledge?.[0]).toMatchObject({ contentRange: { start: 0, end: 24_000, total: 30_000, partial: true },
      providedContentHash: stableHash('x'.repeat(24_000)), contentHash: receipt.contentHash });
    expect(context.retrievedKnowledge?.[0]?.content).toHaveLength(24_000);
    expect(buildAssessmentKnowledgeVerifications(candidate, built.evidencePackage).find((item) => item.sourceId === receipt.sourceId)?.status)
      .toBe('model_cited');
    expect(buildAssessmentKnowledgeVerifications(candidate, built.evidencePackage, [receipt]).find((item) => item.sourceId === receipt.sourceId))
      .toMatchObject({ status: 'tool_content_verified', toolReceiptId: receipt.toolReceiptId, contentHash: receipt.contentHash });
    service.close();
  });
  it('P03 请求把本体和依赖问题分别列出，独立个人来源不被诊断标签遮住', async () => {
    const { service, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims.push({ ...candidate.claims[0]!, id: 'claim:gastric', topicKey: 'gastric' });
    candidate.actions[0]!.claimIds.push('claim:gastric');
    candidate.overview.claimIds.push('claim:gastric');
    const issue = 'documented_source_not_proven:claim:gastric';
    const request = buildAssessmentRepairRequest(candidate, [issue], built.evidencePackage.evidenceCatalog);
    expect(assessmentRepairRequestV1Schema.safeParse(request).success).toBe(true);
    expect(request.targetDetails.find((detail) => detail.targetId === 'claim:gastric')).toMatchObject({
      role: 'issue_owner', ownIssues: [issue], dependsOnIds: [], triggerIssues: [issue]
    });
    expect(request.targetDetails.find((detail) => detail.targetId === 'action-review')).toMatchObject({
      role: 'dependent', ownIssues: [], dependsOnIds: ['claim:gastric'], triggerIssues: [issue],
      remainingClaimIds: ['claim-ldl'], remainingEvidenceIds: candidate.claims[0]!.evidenceIds
    });
    expect(request.targetDetails.find((detail) => detail.targetId === 'overview')!.triggerIssues).toContain(issue);
    expect(request.targets).not.toContain('claim-ldl');
    service.close();
  });

  it('定向来源只补有问题目标已引用的真实报告 quote，不扩全来源也不填补空白', async () => {
    const { service, built } = await fixtureTwoSystems();
    const candidate = candidateFor(built.request, built.evidencePackage);
    const quoteRef = built.evidencePackage.evidenceCatalog.find((ref) => ref.id === candidate.claims[0]!.evidenceIds[0])!;
    const catalog = [{ ...quoteRef, quote: null }, ...built.evidencePackage.evidenceCatalog.filter((ref) => ref.id !== quoteRef.id)];
    const nullQuoteRequest = buildAssessmentRepairRequest(candidate, ['documented_source_not_proven:claim-ldl'], catalog,
      built.evidencePackage.facts);
    expect(nullQuoteRequest.targetDetails.every((detail) => detail.sourceQuotes === undefined)).toBe(true);
    const request = buildAssessmentRepairRequest(candidate, ['documented_source_not_proven:claim-ldl'],
      built.evidencePackage.evidenceCatalog, built.evidencePackage.facts);
    expect(request.targetDetails.find((detail) => detail.targetId === 'claim-ldl')!.sourceQuotes).toEqual([
      { evidenceId: quoteRef.id, quote: quoteRef.quote, clinicalDate: '2026-09-21' }
    ]);
    expect(request.targetDetails.filter((detail) => detail.targetId !== 'claim-ldl')
      .every((detail) => detail.sourceQuotes === undefined)).toBe(true);
    const nonDocumented = buildAssessmentRepairRequest(candidate, ['unknown_evidence:claim-ldl:missing'],
      built.evidencePackage.evidenceCatalog, built.evidencePackage.facts);
    expect(nonDocumented.targetDetails.every((detail) => detail.sourceQuotes === undefined)).toBe(true);
    const unknownDate = buildAssessmentRepairRequest(candidate, ['documented_source_not_proven:claim-ldl'],
      built.evidencePackage.evidenceCatalog);
    expect(unknownDate.targetDetails.find((detail) => detail.targetId === 'claim-ldl')!.sourceQuotes![0]!.clinicalDate).toBeNull();
    service.close();
  });

  it('typed P03 只合并目标，非目标原引用、数组顺序、签名和原输入不变', async () => {
    const { service, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    const request = buildAssessmentRepairRequest(candidate, ['unknown_evidence:action-review:missing'], built.evidencePackage.evidenceCatalog);
    const original = JSON.stringify(candidate);
    const corrected = structuredClone(candidate);
    corrected.actions[0]!.firstStep = '整理既往血脂报告和真实用药记录，下次就诊时带上。';
    const receipt = assessmentOutputFor(`REPAIR_REQUEST=${JSON.stringify(request)}\nSOURCE_CONTEXT={}`, corrected) as MemberAssessmentRepairV1;
    expect(memberAssessmentRepairV1Schema.safeParse(receipt).success).toBe(true);
    receipt.results.find((item) => item.targetId === 'overview')!.verdict = 'unchanged';
    receipt.results.find((item) => item.targetId === 'overview')!.replacement = null;
    const result = mergeAssessmentRepair(candidate, request, receipt);
    expect(result.reason).toBeNull();
    expect(result.candidate!.actions[0]).toEqual(corrected.actions[0]);
    expect(result.candidate!.claims[0]).toBe(candidate.claims[0]);
    expect(result.candidate!.overview).toBe(candidate.overview);
    expect(result.candidate!.requestedSystemIds).toBe(candidate.requestedSystemIds);
    expect(memberAssessmentCandidateV3Schema.safeParse(result.candidate).success).toBe(true);
    expect(JSON.stringify(candidate)).toBe(original);
    service.close();
  });

  it('跨类型同 ID 的目标明确拒绝，不把 claim 替换覆盖到未授权知识来源', async () => {
    const { service, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    const request = buildAssessmentRepairRequest(candidate, ['unknown_evidence:claim-ldl:missing'], built.evidencePackage.evidenceCatalog);
    const source = { id: 'claim-ldl', title: '合成医学来源', organization: null, url: 'https://example.org/synthetic',
      origin: 'retrieved' as const, supports: '合成医学背景' };
    candidate.knowledgeSources.push(source);
    request.originalCandidateHash = stableHash(candidate);
    expect(memberAssessmentCandidateV3Schema.safeParse(candidate).success).toBe(true);
    expect(() => buildAssessmentRepairRequest(candidate, ['unknown_evidence:claim-ldl:missing'], built.evidencePackage.evidenceCatalog))
      .toThrow('assessment_repair_ambiguous_target');
    const output = assessmentOutputFor(`REPAIR_REQUEST=${JSON.stringify(request)}\nSOURCE_CONTEXT={}`, candidate);
    expect(mergeAssessmentRepair(candidate, request, output)).toEqual({ candidate: null, reason: 'assessment_repair_ambiguous_target' });
    expect(candidate.knowledgeSources[0]).toBe(source);
    expect(memberAssessmentCandidateV3Schema.safeParse(candidate).success).toBe(true);
    service.close();
  });

  it('跨类型同 ID 不在目标范围时，真正目标修复不改写任何非目标来源或主张', async () => {
    const { service, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.knowledgeSources.push({ id: 'claim-ldl', title: '合成医学来源', organization: null,
      url: 'https://example.org/synthetic', origin: 'retrieved', supports: '合成医学背景' });
    const request = buildAssessmentRepairRequest(candidate, ['unknown_evidence:action-review:missing'], built.evidencePackage.evidenceCatalog);
    const corrected = structuredClone(candidate);
    corrected.actions[0]!.firstStep = '保留报告和真实病史，供下次就诊讨论。';
    const output = assessmentOutputFor(`REPAIR_REQUEST=${JSON.stringify(request)}\nSOURCE_CONTEXT={}`, corrected);
    const merged = mergeAssessmentRepair(candidate, request, output);
    expect(merged.reason).toBeNull();
    expect(merged.candidate!.knowledgeSources[0]).toBe(candidate.knowledgeSources[0]);
    expect(merged.candidate!.claims[0]).toBe(candidate.claims[0]);
    expect(memberAssessmentCandidateV3Schema.safeParse(merged.candidate).success).toBe(true);
    service.close();
  });

  it.each(['missing', 'duplicate', 'extra', 'person', 'signature', 'hash', 'id', 'type', 'replace_null',
    'unchanged_replacement', 'full_candidate', 'top_level_injection'] as const)(
    'typed P03 拒收 %s，不合并任何部分回执', async (failure) => {
      const { service, built } = await fixture();
      const candidate = candidateFor(built.request, built.evidencePackage);
      const request = buildAssessmentRepairRequest(candidate, ['unknown_evidence:claim-ldl:missing'], built.evidencePackage.evidenceCatalog);
      const receipt = assessmentOutputFor(`REPAIR_REQUEST=${JSON.stringify(request)}\nSOURCE_CONTEXT={}`, candidate) as MemberAssessmentRepairV1;
      let output: unknown = receipt;
      if (failure === 'missing') receipt.results.pop();
      if (failure === 'duplicate') receipt.results.push(receipt.results[0]!);
      if (failure === 'extra') receipt.results.push({ targetId: 'unauthorized', verdict: 'unchanged', reason: '越界', replacement: null });
      if (failure === 'person') receipt.personId = 'other-person';
      if (failure === 'signature') receipt.inputSignature = 'c'.repeat(64);
      if (failure === 'hash') receipt.originalCandidateHash = 'd'.repeat(64);
      if (failure === 'id') receipt.results[0]!.replacement!.value.id = 'other-id';
      if (failure === 'type') receipt.results[0]!.replacement = { nodeType: 'action', value: { ...candidate.actions[0]!, id: receipt.results[0]!.targetId } };
      if (failure === 'replace_null') receipt.results[0]!.replacement = null;
      if (failure === 'unchanged_replacement') receipt.results[0]!.verdict = 'unchanged';
      if (failure === 'full_candidate') output = candidate;
      if (failure === 'top_level_injection') output = { ...receipt, mode: 'full' };
      const reason = ['missing', 'duplicate', 'extra'].includes(failure) ? 'assessment_repair_target_coverage_mismatch'
        : ['person', 'signature', 'hash'].includes(failure) ? 'assessment_repair_binding_mismatch'
          : failure === 'unchanged_replacement' ? 'assessment_repair_unexpected_replacement'
            : ['full_candidate', 'top_level_injection'].includes(failure) ? 'assessment_repair_schema_invalid'
              : 'assessment_repair_replacement_scope_mismatch';
      const result = mergeAssessmentRepair(candidate, request, output);
      expect(result).toMatchObject({ candidate: null, reason });
      if (reason === 'assessment_repair_schema_invalid') expect(result).toMatchObject({ schemaIssues: expect.any(Array),
        schemaIssueCount: expect.any(Number) });
      else expect(result).toEqual({ candidate: null, reason });
      service.close();
    }
  );

  it('schema 失败只记契约字段路径和 code，错误正文、非法枚举值与未知字段名不进入工作记录', async () => {
    const { service, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    const request = buildAssessmentRepairRequest(candidate, ['unknown_evidence:claim-ldl:missing'], built.evidencePackage.evidenceCatalog);
    const receipt = assessmentOutputFor(`REPAIR_REQUEST=${JSON.stringify(request)}\nSOURCE_CONTEXT={}`, candidate) as MemberAssessmentRepairV1;
    const result = receipt.results.find((item) => item.replacement?.nodeType === 'claim')!;
    Object.assign(result.replacement!.value, { title: null, diagnosticStatus: 'PRIVATE_SYNTHETIC_INVALID_ENUM',
      PRIVATE_SYNTHETIC_UNKNOWN_KEY: 'PRIVATE_SYNTHETIC_BODY' });
    const rejected = mergeAssessmentRepair(candidate, request, receipt);
    expect(rejected).toMatchObject({ candidate: null, reason: 'assessment_repair_schema_invalid', schemaIssues: [
      { path: ['results', 0, 'replacement', 'value', 'title'], code: 'invalid_type' },
      { path: ['results', 0, 'replacement', 'value', 'diagnosticStatus'], code: 'invalid_value' },
      { path: ['results', 0, 'replacement', 'value'], code: 'unrecognized_keys' }
    ], schemaIssueCount: 3 });
    expect(JSON.stringify(rejected)).not.toContain('PRIVATE_SYNTHETIC');
    expect(JSON.stringify(rejected)).not.toContain(candidate.claims[0]!.text);
    const many = { ...receipt, results: Array.from({ length: 100 }, () => receipt.results[0]) };
    const bounded = mergeAssessmentRepair(candidate, request, many);
    expect(bounded).toMatchObject({ candidate: null, schemaIssueCount: 300 });
    expect(bounded.candidate === null && bounded.schemaIssues).toHaveLength(30);
    service.close();
  });

  it('真实 wire 的 typed P03 可选 null 恢复后引用和授权范围不变，修复不增加调用', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    const corrected = structuredClone(candidate);
    candidate.claims[0]!.evidenceIds = ['missing-evidence'];
    const transport = createMemberAnalysisTransport(built.evidencePackage);
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (turn) => {
      calls += 1;
      if (calls === 1) return { threadId: 'p02', turnId: 'original', output: candidate };
      const wire = assessmentOutputFor(turn.prompt, transport.aliasCandidate(corrected)) as MemberAssessmentRepairV1;
      wire.results.forEach((item) => {
        if (item.replacement?.nodeType === 'claim') Object.assign(item.replacement.value, { title: null });
        if (item.replacement?.nodeType === 'action') Object.assign(item.replacement.value, { lifestyleDomain: null, lifestyleBasis: null });
      });
      expect(memberAssessmentRepairV1Schema.safeParse(wire).success).toBe(false);
      return { threadId: 'p03', turnId: 'wire-restored', output: restoreCodexOptionalFields(wire, turn.outputSchema) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2, repairDiagnostics: [{ schemaVerdict: 'accepted',
      scopeVerdict: 'accepted', remainingIssues: [], heldTargetIds: [], failureReason: null }] });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims).toEqual(corrected.claims);
    expect(snapshot.actions).toEqual(corrected.actions);
    expect(snapshot.claims[0]!.evidenceIds).toEqual(built.evidencePackage.facts[0]!.evidenceIds);
    expect(snapshot.heldTargetIds).toEqual([]);
    service.close();
  });

  it('局部格式失败在发布结果里保留安全路径诊断，不能把未知枚举恢复为合法医疗回复', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.actions[0]!.evidenceIds = ['missing-evidence'];
    const corrected = candidateFor(built.request, built.evidencePackage);
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (turn) => {
      calls += 1;
      if (calls === 1) return { threadId: 'p02', turnId: 'original', output: candidate };
      if (turn.prompt.includes('REVIEW_REQUEST=')) return { threadId: 'p04', turnId: 'neutral-system',
        output: focusedOutputFor(turn.prompt, candidate) };
      const wire = assessmentOutputFor(turn.prompt, corrected) as MemberAssessmentRepairV1;
      Object.assign(wire.results.find((item) => item.replacement?.nodeType === 'action')!.replacement!.value,
        { lifestyleDomain: 'PRIVATE_SYNTHETIC_INVALID_DOMAIN', lifestyleBasis: null });
      return { threadId: 'p03', turnId: 'invalid-enum', output: restoreCodexOptionalFields(wire, turn.outputSchema) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 3, repairDiagnostics: [{ schemaVerdict: 'invalid',
      scopeVerdict: 'not_checked', failureReason: 'assessment_repair_schema_invalid', schemaIssues: [
        { path: ['results', 0, 'replacement', 'value', 'lifestyleDomain'], code: 'invalid_value' }
      ], schemaIssueCount: 1, heldTargetIds: expect.arrayContaining(['action-review']) }] });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SYNTHETIC_INVALID_DOMAIN');
    expect(service.store.listMemberAssessmentSnapshots(personId, true)[0]!.claims).toEqual(candidate.claims);
    expect(service.store.listMemberAssessmentSnapshots(personId, true)[0]!.actions).toEqual([]);
    service.close();
  });

  it.each(['extra_target', 'wrong_replacement_id', 'wrong_person'] as const)(
    'P03合并失败%s仍保留本目标可归属的替换，外来正文不写入本目标审计', async (failure) => {
      const { service, personId, built } = await fixture();
      const candidate = candidateFor(built.request, built.evidencePackage);
      candidate.actions[0]!.evidenceIds = ['missing-evidence'];
      const corrected = candidateFor(built.request, built.evidencePackage);
      let calls = 0;
      let responseHash = '';
      const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (turn) => {
        calls += 1;
        if (calls === 1) return { threadId: 'p02', turnId: 'original', output: candidate };
        if (turn.prompt.includes('REVIEW_REQUEST=')) return { threadId: 'p04', turnId: 'neutral-system',
          output: focusedOutputFor(turn.prompt, candidate) };
        expect(calls).toBe(2);
        const response = assessmentOutputFor(turn.prompt, corrected) as MemberAssessmentRepairV1;
        const target = response.results.find((item) => item.targetId === 'action-review')!;
        target.reason = '合成本目标模型修复理由。';
        if (failure === 'extra_target') response.results.push({ targetId: 'foreign-target', verdict: 'replace',
          reason: 'PRIVATE_FOREIGN_REVIEW_REASON', replacement: { nodeType: 'action',
            value: { ...corrected.actions[0]!, id: 'foreign-target', firstStep: 'PRIVATE_FOREIGN_MEDICAL_BODY' } } });
        if (failure === 'wrong_replacement_id') Object.assign(target.replacement!.value,
          { id: 'foreign-target', firstStep: 'PRIVATE_FOREIGN_MEDICAL_BODY' });
        if (failure === 'wrong_person') {
          response.personId = 'foreign-person';
          Object.assign(target.replacement!.value, { firstStep: 'PRIVATE_FOREIGN_MEDICAL_BODY' });
        }
        responseHash = stableHash(response);
        return { threadId: 'p03', turnId: 'rejected-merge', output: response };
      } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
      expect(result).toMatchObject({ status: 'published', callCount: 3 });
      const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
      expect(snapshot.actions).toEqual([]);
      const audit = snapshot.reviewAuditRecords!;
      expect(JSON.stringify(audit)).not.toContain('PRIVATE_FOREIGN_MEDICAL_BODY');
      expect(JSON.stringify(audit)).not.toContain('PRIVATE_FOREIGN_REVIEW_REASON');
      const record = audit.records.find((item) => item.targetId === 'action-review')!;
      expect(record.original).toEqual({ nodeType: 'action', value: candidate.actions[0] });
      expect(record.receipt).toEqual({ stage: 'p03', threadId: 'p03', turnId: 'rejected-merge', outputHash: responseHash });
      if (failure === 'extra_target') {
        expect(record).toMatchObject({ phase: 'p03_before_review', replacement: { nodeType: 'action', value: corrected.actions[0] },
          modelDecision: { verdict: 'replace', reason: '合成本目标模型修复理由。' } });
      } else {
        expect(record).toMatchObject({ phase: 'local_validation', replacement: null, modelDecision: null });
      }
      service.close();
    });

  it.each(['missing', 'null', 'unchanged'] as const)('P03 %s 回执不能使未解决依赖通过，安全内容保留且工作记录区分原因', async (receiptType) => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims.push({ ...candidate.claims[0]!, id: 'claim:bad', topicKey: 'bad', evidenceIds: ['missing-evidence'],
      changeAssessment: firstRecordChange(['missing-evidence']) });
    candidate.actions.push({ ...candidate.actions[0]!, id: 'action:bad', dedupeKey: 'bad', claimIds: ['claim:bad'] });
    candidate.overview.claimIds.push('claim:bad');
    candidate.overview.actionIds.push('action:bad');
    const factsBefore = service.store.listAcceptedObservations(personId);
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      if (calls === 1) return { threadId: 'p02', turnId: 'original', output: candidate };
      const output = assessmentOutputFor(input.prompt, candidate) as MemberAssessmentRepairV1;
      if (receiptType === 'missing') output.results = output.results.filter((item) => item.targetId !== 'action:bad');
      if (receiptType === 'unchanged') output.results = output.results.map((item) => ({ ...item, verdict: 'unchanged', replacement: null }));
      return { threadId: 'p03', turnId: 'repair', output: receiptType === 'null' ? null : output };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2, repairDiagnostics: [{
      schemaVerdict: receiptType === 'null' ? 'invalid' : 'accepted',
      scopeVerdict: receiptType === 'null' ? 'not_checked' : receiptType === 'missing' ? 'invalid' : 'accepted',
      initialIssues: ['unknown_evidence:claim:bad:missing-evidence'],
      remainingIssues: ['unknown_evidence:claim:bad:missing-evidence'],
      heldTargetIds: expect.arrayContaining(['claim:bad', 'action:bad']),
      failureReason: receiptType === 'null' ? 'assessment_repair_schema_invalid'
        : receiptType === 'missing' ? 'assessment_repair_target_coverage_mismatch' : null
    }] });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims).toEqual(candidate.claims.slice(0, 1));
    expect(snapshot.actions).toEqual(candidate.actions.slice(0, 1));
    expect(snapshot.heldTargetIds).toEqual(expect.arrayContaining(['claim:bad', 'action:bad']));
    expect(service.store.listAcceptedObservations(personId)).toEqual(factsBefore);
    expect(JSON.stringify(result)).not.toContain(candidate.claims[0]!.text);
    service.close();
  });

  it('P03 类型相同但整份系统范围改变时拒绝发布，也返回已发生的无正文修复记录', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.actions[0]!.evidenceIds = ['missing-evidence'];
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      if (calls === 1) return { threadId: 'p02', turnId: 'original', output: candidate };
      const corrected = candidateFor(built.request, built.evidencePackage);
      const output = assessmentOutputFor(input.prompt, corrected) as MemberAssessmentRepairV1;
      const replacement = output.results.find((item) => item.replacement?.nodeType === 'system')!.replacement!;
      if (replacement.nodeType === 'system') replacement.value.systemId = 'dermatological';
      return { threadId: 'p03', turnId: 'scope-change', output };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'rejected', reason: 'system_scope_mismatch', callCount: 2,
      repairDiagnostics: [{ schemaVerdict: 'accepted', scopeVerdict: 'invalid',
        remainingIssues: ['system_scope_mismatch'], failureReason: 'system_scope_mismatch' }] });
    expect(service.store.listMemberAssessmentSnapshots(personId, true)).toEqual([]);
    service.close();
  });

  it('局部修复失败仍发布具体保留摘要，读取不重跑、不改库、不伪造健康状态', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.actions[0]!.evidenceIds = ['missing-evidence'];
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        if (input.prompt.includes('REVIEW_REQUEST=')) return { threadId: 'p04', turnId: 'neutral-system',
          output: focusedOutputFor(input.prompt, candidate) };
        return { threadId: 'synthetic', turnId: String(calls), output: assessmentOutputFor(input.prompt, candidate) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 3 });
    const storedBefore = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    const factsBefore = service.store.listAcceptedObservations(personId);
    expect(storedBefore.overview.headline).toBe('整体情况：1项重点，涉及1个身体系统');
    expect(storedBefore.overview.summary).toContain('心血管');
    expect(storedBefore.overview.summary).toContain('完整结果、判断依据和检查条件');
    expect(storedBefore.claims).toEqual(candidate.claims);
    expect(storedBefore.overview.summary).toContain('只有一次结果。');
    expect(storedBefore.presentation?.rebuiltNodeIds).toContain('overview');
    expect(JSON.stringify([storedBefore.overview, ...storedBefore.systems])).not.toMatch(/仍需核实|已接纳|未发布|未纳入/);
    const presented = service.getMemberAssessment(personId)!;
    expect(presented.overview.headline).toBe('整体情况：1项重点，涉及1个身体系统');
    expect(presented.overview.summary).toContain('心血管');
    expect(presented.overview.summary).toContain('完整结果、判断依据和检查条件');
    expect(presented.overview.summary).toContain('只有一次结果。');
    expect(presented.systems[0]!.headline).toBe(healthClaimTitle(candidate.claims[0]!));
    expect(presented.systems[0]!.summary).toContain(candidate.claims[0]!.text);
    expect(presented.systems[0]!.summary).toContain(candidate.claims[0]!.rationale);
    expect(presented.actions).toEqual([]);
    expect(presented.heldTargetIds).toContain('action-review');
    expect(service.listBodySystems(personId).find((system) => system.id === built.request.requestedSystemIds[0])).toMatchObject({
      interpretationState: 'partial', status: 'building', summary: healthClaimTitle(candidate.claims[0]!)
    });
    expect(service.getMemberOverview(personId).headline).toBe('整体情况：1项重点，涉及1个身体系统');
    expect(service.getMemberOverview(personId).overview).toContain('心血管');
    expect(service.getMemberOverview(personId).overview).toContain('完整结果、判断依据和检查条件');
    expect(service.getMemberOverview(personId).overview).toContain('只有一次结果。');
    expect(service.getSnapshot(null).persons[0]!.changeSummary).toBe('整体情况：1项重点，涉及1个身体系统');
    expect(service.store.listMemberAssessmentSnapshots(personId, true)[0]).toEqual(storedBefore);
    expect(service.store.listAcceptedObservations(personId)).toEqual(factsBefore);
    expect(calls).toBe(3);
    service.close();
  });

  it('旧报告一次补齐后全量综合；次日再次综合只复用条件缓存，不再读原文', async () => {
    const { service, personId } = await fixture(true);
    const before = buildMemberAssessmentInput(service.store, personId, {
      modelId: 'test-model', reasoningEffort: 'medium', analysisReferenceDate: '2026-09-26', webSearchAllowed: true
    });
    const stages: string[] = [];
    const sentSignatures: string[] = [];
    const runtime = { runStructuredTurn: async (input: { prompt: string; allowWebSearch?: boolean }) => {
      if (input.prompt.includes('CLINICAL_CONTEXT_INPUT=')) {
        stages.push('context');
        expect(input.allowWebSearch).toBe(false);
        const data = JSON.parse(input.prompt.split('CLINICAL_CONTEXT_INPUT=')[1]!) as {
          facts: Array<{ observationId: string }>; sources: Array<{ sourceSpanId: string }> };
        return { threadId: 'context', turnId: 'context', output: assessmentOutputFor(input.prompt, { version: 1, items: data.facts.map((fact) => ({
          observationId: fact.observationId, context: { version: 1, status: 'complete',
            conditions: [{ sourceSpanId: data.sources[0]!.sourceSpanId, quote: '采样时未服药。' }] }
        })) }) };
      }
      stages.push('full-analysis');
      const request = JSON.parse(input.prompt.split('ASSESSMENT_REQUEST=')[1]!.split('\nMEMBER_EVIDENCE_PACKAGE=')[0]!) as AssessmentRequestV3;
      sentSignatures.push(request.inputSignature);
      const source = expandMemberEvidence<ReturnType<typeof buildMemberAnalysisPackage>>(
        JSON.parse(input.prompt.split('MEMBER_EVIDENCE_PACKAGE=')[1]!));
      expect(source.sourceContext).toEqual([]);
      expect(source.evidenceCatalog).toEqual([]);
      return { threadId: 'analysis', turnId: 'analysis', output: assessmentOutputFor(input.prompt, candidateFor(request, source)) };
    } };
    const first = await new MemberAssessmentPipeline(service.store, runtime, undefined, undefined, undefined,
      'test-model', 'medium', '2026-09-26').process(personId);
    expect(first).toMatchObject({ status: 'published', callCount: 2,
      inputSignature: sentSignatures[0], factRevision: before.factRevision, contextRevision: before.contextRevision,
      reviewScopeSignature: before.reviewScopeSignature });
    expect(first.inputSignature).not.toBe(before.request.inputSignature);
    await expect(new MemberAssessmentPipeline(service.store, runtime, undefined, undefined, undefined,
      'test-model', 'medium', '2026-09-27').process(personId)).resolves.toMatchObject({ status: 'published', callCount: 1 });
    expect(stages).toEqual(['context', 'full-analysis', 'full-analysis']);
    expect(service.store.listAcceptedObservations(personId)).toHaveLength(1);
    expect(service.getMemberAssessment(personId)!.evidenceCatalog.some((ref) => ref.quote?.includes('LDL-C'))).toBe(true);
    const contextIds = service.getMemberAssessment(personId)!.evidenceCatalog.filter((ref) => ref.id.startsWith('context-')).map((ref) => ref.id);
    expect(contextIds).toHaveLength(1);
    expect(service.getMemberEvidenceBundle(personId, contextIds)).toMatchObject({ missingIds: [],
      items: [{ quote: '采样时未服药。' }] });
    const other = service.store.createPerson({ displayName: '另一个合成成员' });
    expect(service.getMemberEvidenceBundle(other.id, contextIds).missingIds).toEqual(contextIds);
  });

  it('补齐条件后的拒绝回执绑定真正 P02 输入，不沿用准备前的签名', async () => {
    const { service, personId } = await fixture(true);
    const before = buildMemberAssessmentInput(service.store, personId, {
      modelId: 'test-model', reasoningEffort: 'medium', analysisReferenceDate: '2026-09-22', webSearchAllowed: true
    });
    let sentSignature: string | null = null;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      if (input.prompt.includes('CLINICAL_CONTEXT_INPUT=')) {
        const data = JSON.parse(input.prompt.split('CLINICAL_CONTEXT_INPUT=')[1]!) as {
          facts: Array<{ observationId: string }>; sources: Array<{ sourceSpanId: string }>
        };
        return { threadId: 'context', turnId: 'context', output: { version: 1, items: data.facts.map((fact) => ({
          observationId: fact.observationId, context: { version: 1, status: 'complete',
            conditions: [{ sourceSpanId: data.sources[0]!.sourceSpanId, quote: '采样时未服药。' }] }
        })) } };
      }
      sentSignature = (JSON.parse(input.prompt.split('ASSESSMENT_REQUEST=')[1]!.split('\nMEMBER_EVIDENCE_PACKAGE=')[0]!) as AssessmentRequestV3).inputSignature;
      return { threadId: 'analysis', turnId: 'invalid', output: { schemaVersion: 3 } };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'rejected', reason: 'assessment_schema_invalid', callCount: 2,
      inputSignature: sentSignature, factRevision: before.factRevision, contextRevision: before.contextRevision,
      reviewScopeSignature: before.reviewScopeSignature });
    expect(result.inputSignature).not.toBe(before.request.inputSignature);
    expect(service.store.listMemberAssessmentSnapshots(personId, true)).toEqual([]);
    service.close();
  });

  it('没有分析资料时跳过也返回实际输入绑定且不调用模型', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-no-analysis-input-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '合成工作区');
    const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
    const built = buildMemberAssessmentInput(service.store, personId, {
      modelId: 'test-model', reasoningEffort: 'medium', analysisReferenceDate: '2026-09-22', webSearchAllowed: true
    });
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async () => {
      throw new Error('NO_DATA_MUST_NOT_CALL_MODEL');
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'skipped', reason: 'no_accepted_facts', callCount: 0,
      inputSignature: built.request.inputSignature, factRevision: built.factRevision,
      contextRevision: built.contextRevision, reviewScopeSignature: built.reviewScopeSignature });
    expect('snapshotId' in result).toBe(false);
    service.close();
  });
  it('待核对范围变化即使事实版本不变，也使旧综合失效并拒绝迟到发布', async () => {
    const { service, personId, documentId } = await fixture();
    const runtime = {
      runStructuredTurn: async (input: { prompt: string }) => {
        const request = JSON.parse(input.prompt.split('ASSESSMENT_REQUEST=')[1]!.split('\nMEMBER_EVIDENCE_PACKAGE=')[0]!) as AssessmentRequestV3;
        const source = expandMemberEvidence(JSON.parse(input.prompt.split('MEMBER_EVIDENCE_PACKAGE=')[1]!));
        return { threadId: 'p02', turnId: 'turn', output: assessmentOutputFor(input.prompt, candidateFor(request, source)) };
      }
    };
    await expect(new MemberAssessmentPipeline(service.store, runtime,
      undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId))
      .resolves.toMatchObject({ status: 'published', callCount: 1 });
    const prior = service.getMemberAssessment(personId)!;
    const factRevision = service.store.getFactRevision(personId);
    const scopeBefore = service.store.getOpenReviewScopeSignature(personId);
    service.store.saveExtractionReviewIssue({
      documentId, kind: 'coverage_gap', severity: 'warning', preserveDocumentStatus: true,
      evidenceRefs: [], reasonCodes: ['SYNTHETIC_UNRESOLVED_SPAN']
    });
    expect(service.store.getFactRevision(personId)).toBe(factRevision);
    expect(service.store.getOpenReviewScopeSignature(personId)).not.toBe(scopeBefore);
    expect(service.getMemberAssessment(personId)).toBeNull();
    expect(() => service.store.publishMemberAssessmentSnapshot({ snapshot: prior }))
      .toThrow('MEMBER_ASSESSMENT_REVIEW_SCOPE_CONFLICT');
    expect(service.processNow()).toMatchObject({ idempotent: false });
    await expect(new MemberAssessmentPipeline(service.store, runtime,
      undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId))
      .resolves.toMatchObject({ status: 'published', callCount: 1 });
    const refreshed = service.getMemberAssessment(personId)!;
    expect(refreshed.id).not.toBe(prior.id);
    expect(refreshed.reviewScopeSignature).toBe(service.store.getOpenReviewScopeSignature(personId));
    service.close();
  });

  it('通用“诊断”项目仅在原文明确支持检查部位时归入相应身体系统', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-generic-diagnosis-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '合成工作区', () => new Date('2026-09-22T00:00:00Z'));
    const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
    const sourceText = '2025-06-10 肝脏彩超小结：诊断：脂肪肝。';
    await service.importFiles([{ path: '/tmp/合成肝脏彩超.txt', bytes: Buffer.from(sourceText) }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    const span = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!;
    const extracted: ExtractionResult = {
      schemaVersion: 1, documentId, coveredSourceSpanIds: [span.id],
      subject: { reportedName: null, evidence: [], confidence: 'absent' },
      candidates: [{
        localKey: 'diagnosis', originalName: '诊断', standardNameCandidate: null,
        value: { kind: 'text', rawText: '脂肪肝' }, unitRaw: null, referenceRangeRaw: null,
        reportedAbnormalFlag: null, specimen: null, method: '彩超', bodySite: '肝脏',
        clinicalDate: '2025-06-10', evidence: [{ sourceSpanId: span.id, quote: sourceText }], clinicalContext: { version: 1, status: 'complete', conditions: [] }, issues: []
      }]
    };
    await expect(new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async (input) => ({ threadId: 'p01', turnId: 'first', output: assessmentOutputFor(input.prompt, extracted) })
    }).process(documentId)).resolves.toMatchObject({ status: 'published', candidateCount: 1 });
    const built = buildMemberAssessmentInput(service.store, personId, {
      modelId: 'test-model', reasoningEffort: 'medium', analysisReferenceDate: '2026-09-22', webSearchAllowed: false
    });
    expect(built.request.requestedSystemIds).toContain('hepatobiliary');
    expect(built.evidencePackage.facts[0]?.systemIds).toContain('hepatobiliary');
    service.close();
  });

  it('局部读不清时接纳清楚的 TSH，并把未解析的超声项目及影响送入综合', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-partial-scope-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '合成工作区', () => new Date('2026-09-22T00:00:00Z'));
    const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
    const sourceText = '2025-06-10 TSH 6.8 mIU/L；甲状腺超声结论无法辨认';
    await service.importFiles([{ path: '/tmp/合成局部模糊.txt', bytes: Buffer.from(sourceText) }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    const span = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!;
    const extracted: ExtractionResult = {
      schemaVersion: 1, documentId, coveredSourceSpanIds: [span.id],
      subject: { reportedName: null, evidence: [], confidence: 'absent' },
      candidates: [{
        localKey: 'tsh', originalName: 'TSH', standardNameCandidate: 'TSH',
        value: { kind: 'numeric', rawText: '6.8', decimal: '6.8', comparator: 'eq' },
        unitRaw: 'mIU/L', referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: null, bodySite: '甲状腺', clinicalDate: '2025-06-10',
        evidence: [{ sourceSpanId: span.id, quote: sourceText }], clinicalContext: { version: 1, status: 'complete', conditions: [] }, issues: []
      }, {
        localKey: 'ultrasound-unreadable', originalName: '甲状腺超声', standardNameCandidate: null,
        value: { kind: 'unknown', rawText: null, reason: '超声结论无法辨认' },
        unitRaw: null, referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: '超声', bodySite: '甲状腺', clinicalDate: '2025-06-10',
        evidence: [{ sourceSpanId: span.id, quote: sourceText }],
        issues: [{ code: 'unreadable_result', message: '结论无法辨认' }]
      }]
    };
    let calls = 0;
    await expect(new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async (input) => ({ threadId: 'extract', turnId: `turn-${++calls}`, output: assessmentOutputFor(input.prompt, extracted) })
    }).process(documentId)).resolves.toMatchObject({ status: 'partial', candidateCount: 1, requiresUser: false });
    expect(calls).toBe(2);
    const built = buildMemberAssessmentInput(service.store, personId, {
      modelId: 'test-model', reasoningEffort: 'medium', analysisReferenceDate: '2026-09-22', webSearchAllowed: false
    });
    expect(built.evidencePackage.facts.map((fact) => fact.originalName)).toEqual(['TSH']);
    expect(built.evidencePackage.unresolvedScope).toEqual([expect.objectContaining({
      documentId, affectedItemNames: ['甲状腺超声'],
      reasonCodes: expect.arrayContaining(['value_unknown']),
      potentialImpact: expect.stringContaining('不能把未解析的项目当成正常')
    })]);
    service.close();
  });

  it.each([
    { kind: 'overwrite_protected' as const, severity: 'blocking' as const, retained: false },
    { kind: 'overwrite_protected' as const, severity: 'warning' as const, retained: true },
    { kind: 'field_conflict' as const, severity: 'blocking' as const, retained: true },
    { kind: 'coverage_gap' as const, severity: 'warning' as const, retained: true }
  ])('综合隔离真正的本人保护冲突，普通字段缺口不否定已接纳事实：$kind/$severity', async ({ kind, severity, retained }) => {
    const { service, personId, documentId } = await fixture();
    const before = service.store.listAcceptedObservations(personId);
    service.store.saveExtractionReviewIssue({ documentId, kind, severity,
      preserveDocumentStatus: true, evidenceRefs: [], reasonCodes: ['SYNTHETIC_READING_SCOPE'] });
    const built = buildMemberAssessmentInput(service.store, personId, {
      modelId: 'test-model', reasoningEffort: 'medium', analysisReferenceDate: '2026-09-22', webSearchAllowed: false
    });
    expect(built.evidencePackage.facts).toHaveLength(retained ? 1 : 0);
    expect(built.evidencePackage.unresolvedScope).toContainEqual(expect.objectContaining({ documentId,
      reasonCodes: expect.arrayContaining(['SYNTHETIC_READING_SCOPE']) }));
    expect(service.store.listAcceptedObservations(personId)).toEqual(before);
    service.close();
  });

  it('身份冲突资料只告知综合存在归属缺口，不发送可能属于另一成员的项目名', async () => {
    const { service, personId, documentId } = await fixture();
    const previouslyAccepted = service.store.listAcceptedObservations(personId)[0]!;
    const span = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!;
    service.store.saveExtractionReviewIssue({
      documentId, kind: 'person_conflict', severity: 'warning', preserveDocumentStatus: true,
      evidenceRefs: [span.id], reasonCodes: ['PERSON_IDENTITY_NOT_CONFIRMED'],
      candidateOptions: [{
        localKey: 'other-member', originalName: '其他成员敏感项目', standardNameCandidate: null,
        value: { kind: 'text', rawText: '不应外发' }, unitRaw: null, referenceRangeRaw: null,
        reportedAbnormalFlag: null, specimen: null, method: null, bodySite: null,
        clinicalDate: null, evidence: [{ sourceSpanId: span.id, quote: span.quote }], clinicalContext: { version: 1, status: 'complete', conditions: [] }, issues: []
      }]
    });
    const built = buildMemberAssessmentInput(service.store, personId, {
      modelId: 'test-model', reasoningEffort: 'medium', analysisReferenceDate: '2026-09-22', webSearchAllowed: false
    });
    expect(built.evidencePackage.unresolvedScope).toEqual([expect.objectContaining({
      documentId, reasonCodes: ['PERSON_IDENTITY_NOT_CONFIRMED'], affectedItemNames: [],
      potentialImpact: expect.stringContaining('成员归属未确认')
    })]);
    expect(built.evidencePackage.facts).toEqual([]);
    expect(built.evidencePackage.trends).toEqual([]);
    expect(built.request.requestedSystemIds).toEqual([]);
    expect(JSON.stringify(built.evidencePackage)).not.toContain('2026-09-21 LDL-C 4.2');
    expect(JSON.stringify(built.evidencePackage)).not.toContain('其他成员敏感项目');
    expect(service.store.listAcceptedObservations(personId)).toHaveLength(1);
    expect(service.getMemberOverview(personId).acceptedFactCount).toBe(0);
    expect(service.listHealthEvents(personId)).toEqual([]);
    expect(service.getSnapshot(null).trends).toEqual([]);
    expect(buildMemberSummaryData(service.getSnapshot(null), {
      personId, dateFrom: null, dateTo: null
    }).observations).toEqual([]);
    expect(service.getMemberEvidenceBundle(personId, [previouslyAccepted.id]).missingIds)
      .toEqual([previouslyAccepted.id]);
    service.close();
  });

  it('旧库空值观测仍保留在数据库，但综合输入只取有结果事实并记录缺口', async () => {
    const { service, personId } = await fixture();
    await service.importFiles([{ path: '/tmp/合成旧版空值.txt', bytes: Buffer.from('甲状腺超声：结论无法辨认') }], personId);
    const documentId = service.getSnapshot(null).inbox.find((item) => item.displayName === '合成旧版空值.txt')!.id;
    const span = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!;
    const acceptanceId = service.store.saveAcceptanceDecision({
      method: 'auto', actor: 'policy', rulesVersion: 'health-acceptance-v3',
      inputSignature: 'synthetic-legacy-unknown', outputHash: 'synthetic-legacy-unknown',
      reviewRef: null, decision: 'accept_with_warnings'
    });
    service.store.publishFacts({
      personId, documentId, documentCommitKey: 'e'.repeat(64),
      expectedRevision: service.store.getFactRevision(personId), changeSetHash: 'f'.repeat(64),
      summary: '合成旧规则空值观测', observations: [{
        conceptKey: '甲状腺超声', originalName: '甲状腺超声', modelStandardNameCandidate: null,
        rawText: '', valueKind: 'unknown', decimalValue: null, qualifier: null, unit: null,
        referenceRange: null, clinicalDate: null, abnormalFlag: 'unknown', documentId,
        sourceSpanId: span.id, acceptanceId, specimen: null, method: '超声', bodySite: '甲状腺',
        evidence: [{ sourceSpanId: span.id, quote: span.quote }]
      }]
    });
    const built = buildMemberAssessmentInput(service.store, personId, {
      modelId: 'test-model', reasoningEffort: 'medium', analysisReferenceDate: '2026-09-22', webSearchAllowed: false
    });
    expect(service.store.listAcceptedObservations(personId)).toHaveLength(2);
    expect(built.evidencePackage.facts).toHaveLength(1);
    expect(built.evidencePackage.facts[0]?.originalName).toBe('LDL-C');
    expect(built.evidencePackage.unresolvedScope).toEqual([expect.objectContaining({
      documentId, reasonCodes: ['LEGACY_VALUE_UNKNOWN'], affectedItemNames: ['甲状腺超声'],
      potentialImpact: expect.stringContaining('不能据此判断该检查正常')
    })]);
    service.close();
  });

  it('事实已接纳但尚未归入系统时仍一次 P02 发布成员总览，不猜系统或重提取', async () => {
    const { service, personId, built } = await fixtureUnclassified();
    expect(built.evidencePackage.facts).toHaveLength(1);
    expect(built.evidencePackage.facts[0]?.systemIds).toEqual([]);
    expect(built.request.requestedSystemIds).toEqual([]);
    expect(built.evidencePackage.unresolvedScope).toEqual([expect.objectContaining({
      documentId: built.evidencePackage.facts[0]!.documentId, reasonCodes: ['FACT_SYSTEM_UNMAPPED'],
      affectedItemNames: ['合成未归类检查']
    })]);
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.overview = { ...candidate.overview, headline: '报告记录了一项检查结果',
      summary: '这次检查结果为“记录甲”，只有一次记录，尚不能说明长期变化。',
      limitations: ['只有一次检查记录，不能说明长期变化。'] };
    candidate.claims[0] = { ...candidate.claims[0]!, topicKey: 'unclassified', kind: 'source_fact',
      text: '2026-09-21 报告记录合成未归类检查为“记录甲”。', knowledgeBasis: 'not_applicable' };
    candidate.actions[0] = { ...candidate.actions[0]!, title: '了解这项检查的含义',
      firstStep: '下次就诊时携带报告，向接诊医生了解这项检查的含义。' };
    let calls = 0;
    const first = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => { calls += 1; return { threadId: 'p02', turnId: 'only', output: assessmentOutputFor(input.prompt, candidate) }; }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(first).toMatchObject({ status: 'published', callCount: 1 });
    expect(calls).toBe(1);
    const snapshot = service.getMemberAssessment(personId);
    expect(snapshot?.systems).toEqual([]);
    expect(snapshot?.claims[0]?.systemIds).toEqual([]);
    expect(snapshot?.limitations).toEqual([]);
    expect(snapshot?.overview.limitations).toEqual(['只有一次检查记录，不能说明长期变化。']);
    expect(buildMemberAssessmentInput(service.store, personId, {
      modelId: 'test-model', reasoningEffort: 'medium', analysisReferenceDate: '2026-09-22', webSearchAllowed: true
    }).evidencePackage.unresolvedScope)
      .toEqual(expect.arrayContaining([expect.objectContaining({ reasonCodes: ['FACT_SYSTEM_UNMAPPED'] })]));
    expect(service.getMemberOverview(personId)).toMatchObject({
      headline: '报告记录了一项检查结果', unclassifiedFactCount: 1, dataQuality: 'partial'
    });
    const again = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async () => { throw new Error('SHOULD_NOT_CALL'); }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(again).toMatchObject({ status: 'skipped', reason: 'signature_current', callCount: 0,
      snapshotId: snapshot!.id, inputSignature: snapshot!.inputSignature, factRevision: snapshot!.factRevision,
      contextRevision: snapshot!.contextRevision, reviewScopeSignature: snapshot!.reviewScopeSignature });
    service.close();
  });

  it('无系统可分时上下文超限仍可按来源事实分区，不丢掉已接纳项目', async () => {
    const { service, built } = await fixtureUnclassified();
    const source = structuredClone(built.evidencePackage);
    source.facts.push({ ...source.facts[0]!, observationId: 'synthetic-second-fact' });
    const partitions = buildMemberSystemPartitions(source, []);
    expect(partitions).toHaveLength(1);
    expect(partitions[0]?.systemIds).toEqual([]);
    const children = splitMemberPartition(partitions[0]!);
    expect(children).toHaveLength(2);
    expect(children?.flatMap((item) => item.primaryObservationIds)).toEqual(
      expect.arrayContaining(source.facts.map((fact) => fact.observationId))
    );
    service.close();
  });

  it('真实模型的系统 ID 与 undetermined 类型可本地归一化，正常路径仍只需一次 P02', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.systems[0]!.id = `system-${candidate.systems[0]!.systemId}`;
    candidate.claims[0] = { ...candidate.claims[0]!, kind: 'interpretation',
      diseaseName: '血脂异常的具体病因', diagnosticStatus: 'undetermined',
      text: '目前不能仅凭一次 LDL-C 结果判断血脂异常的具体病因。' };
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => { calls += 1; return { threadId: 'p02', turnId: 'turn', output: assessmentOutputFor(input.prompt, candidate) }; }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 1 });
    expect(calls).toBe(1);
    expect(service.store.listMemberAssessmentSnapshots(personId, true)[0]?.systems[0]?.id)
      .toBe(`system:${candidate.systems[0]!.systemId}`);
    expect(service.store.listMemberAssessmentSnapshots(personId, true)[0]?.claims[0]?.kind)
      .toBe('diagnostic_assessment');
    service.close();
  });

  it('分区覆盖每条选入事实，共享线索复用原 ID，聚合保留分区结果与原子依据', async () => {
    const { service, built } = await fixtureTwoSystems();
    const source = structuredClone(built.evidencePackage);
    source.facts.push({ ...source.facts[0]!, observationId: 'unmapped-fact', originalName: '未映射项目',
      rawValue: '原文记录', valueKind: 'text', systemIds: [], evidenceIds: ['unmapped-evidence'],
      reportedAbnormalFlag: 'unknown' });
    source.evidenceCatalog.push({ ...source.evidenceCatalog[0]!, id: 'unmapped-evidence',
      observationId: 'unmapped-fact', quote: '未映射项目：原文记录' });
    source.facts.push({ ...source.facts[0]!, observationId: 'ordinary-fact', originalName: '普通指标',
      rawValue: '2.0', valueKind: 'numeric', systemIds: [built.request.requestedSystemIds[0]!],
      evidenceIds: ['ordinary-evidence'], reportedAbnormalFlag: 'unknown' });
    source.evidenceCatalog.push({ ...source.evidenceCatalog[0]!, id: 'ordinary-evidence',
      observationId: 'ordinary-fact', quote: '普通指标：2.0' });
    source.criteriaSets.push({ id: 'synthetic-set', sourceId: 'synthetic-knowledge', applicability: '合成条件',
      requiredCriterionIds: ['required-measurement'],
      verifiedRequirements: [{ criterionId: 'required-measurement', evidenceIds: ['unmapped-evidence'] }] });
    const partitions = buildMemberSystemPartitions(source, built.request.requestedSystemIds);
    expect(new Set(partitions.flatMap((item) => item.evidencePackage.facts.map((fact) => fact.observationId))))
      .toEqual(new Set(source.facts.map((fact) => fact.observationId)));
    expect(partitions[0]!.evidencePackage.facts.some((fact) => fact.observationId === 'unmapped-fact')).toBe(true);
    for (const partition of partitions) {
      const catalogIds = new Set(partition.evidencePackage.evidenceCatalog.map((item) => item.id));
      expect(partition.evidencePackage.facts.every((fact) => fact.evidenceIds.every((id) => catalogIds.has(id)))).toBe(true);
    }
    const results = partitions.map((partition) => candidateFor({
      ...built.request, mode: 'partition', requestedSystemIds: partition.systemIds
    }, partition.evidencePackage));
    const aggregate = buildMemberAggregatePackage(source, results);
    expect(aggregate.partitionResults).toHaveLength(partitions.length);
    expect(aggregate.facts.some((fact) => fact.observationId === source.facts[0]!.observationId)).toBe(true);
    expect(aggregate.facts.some((fact) => fact.observationId === 'unmapped-fact')).toBe(true);
    expect(aggregate.criteriaSets).toHaveLength(1);
    expect(aggregate.trends).toEqual(source.trends);
    expect(aggregate.facts.some((fact) => fact.observationId === 'ordinary-fact')).toBe(false);
    expect(aggregate.aggregateCoverage).toMatchObject({
      totalFactCount: source.facts.length,
      directFactCount: source.facts.length - 1,
      summarizedOnlyFactCount: 1
    });
    expect(aggregate.aggregateCoverage?.byDocument.reduce((sum, item) => sum + item.totalFactCount, 0))
      .toBe(source.facts.length);
    service.close();
  });

  it.each([
    'CODEX_CONTEXT_WINDOW_EXCEEDED',
    'CODEX_RPC_ERROR:-32602:Input exceeds the maximum length of 1048576 characters.'
  ])('完整上下文超限时不分段、不发布：%s', async (message) => {
    const { service, personId, built } = await fixtureTwoSystems();
    let calls = 0;
    await expect(new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        expect(input.prompt).toContain('"mode":"full"');
        expect(input.prompt).toContain('member-evidence-table-v1');
        throw new Error(message);
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId))
      .rejects.toThrow('MEMBER_ASSESSMENT_INPUT_TOO_LARGE');
    expect(calls).toBe(1);
    expect(service.store.listMemberAssessmentSnapshots(personId, true)).toEqual([]);
    expect(service.store.listAcceptedObservations(personId)).toHaveLength(built.evidencePackage.facts.length);
    service.close();
  });

  it('一次完整分析接收全部紧凑事实，短引用在发布前恢复为真实来源', async () => {
    const { service, personId, built } = await fixtureTwoSystems();
    const referenceIds = createMemberAnalysisTransport(built.evidencePackage).referenceIds;
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        const request = JSON.parse(input.prompt.split('ASSESSMENT_REQUEST=')[1]!.split('\nMEMBER_EVIDENCE_PACKAGE=')[0]!) as AssessmentRequestV3;
        const packet = JSON.parse(input.prompt.split('MEMBER_EVIDENCE_PACKAGE=')[1]!);
        expect(expandMemberEvidence(packet, referenceIds)).toEqual(buildMemberAnalysisPackage(built.evidencePackage));
        const evidence = expandMemberEvidence(packet);
        expect(evidence.facts[0]!.observationId).toMatch(/^ref:/);
        expect(request).toEqual(built.request);
        return { threadId: 'full', turnId: 'full', output: assessmentOutputFor(input.prompt, candidateFor(request, evidence)) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 1 });
    expect(calls).toBe(1);
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims[0]!.evidenceIds).toEqual(built.evidencePackage.facts[0]!.evidenceIds);
    expect(snapshot.evidenceCatalog).toEqual(built.evidencePackage.evidenceCatalog);
    expect(snapshot.processingPlan).toEqual({ strategy: 'full', trigger: 'none', partitionCount: 0, partitionHeldTargetCount: 0 });
    service.close();
  });

  it('局部结构修复也使用完整紧凑资料，修复后的短引用正确恢复', async () => {
    const { service, personId, built } = await fixture();
    const transport = createMemberAnalysisTransport(built.evidencePackage);
    const valid = transport.aliasCandidate(candidateFor(built.request, built.evidencePackage));
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        if (input.prompt.includes('REPAIR_REQUEST=')) {
          const packet = JSON.parse(input.prompt.split('SOURCE_CONTEXT=')[1]!.split('\nTARGET_NODES=')[0]!);
          expect(expandMemberEvidence(packet, transport.referenceIds)).toEqual(buildMemberAnalysisPackage(built.evidencePackage));
          const repairNodes = JSON.parse(input.prompt.split('TARGET_NODES=')[1]!) as Array<{ nodeType: string; value: { evidenceIds?: string[] } }>;
          expect(repairNodes.find((node) => node.nodeType === 'action')!.value.evidenceIds![0]).toMatch(/^ref:/);
          expect(input.prompt).not.toContain('TARGET_CANDIDATE=');
          return { threadId: 'repair', turnId: 'repair', output: assessmentOutputFor(input.prompt, valid) };
        }
        const invalid = structuredClone(valid);
        invalid.claims[0]!.evidenceIds = ['unknown-reference'];
        return { threadId: 'full', turnId: 'full', output: assessmentOutputFor(input.prompt, invalid) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    expect(calls).toBe(2);
    expect(service.store.listMemberAssessmentSnapshots(personId, true)[0]!.claims[0]!.evidenceIds)
      .toEqual(built.evidencePackage.facts[0]!.evidenceIds);
    service.close();
  });

  it('重点复核行动时把行动自己的个人证据也送给复核者', async () => {
    const { service, personId, built } = await fixtureTwoSystems();
    const actionEvidenceId = built.evidencePackage.facts.find((fact) => fact.originalName === '谷丙转氨酶')!.evidenceIds[0]!;
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.actions[0]!.urgency = 'emergency';
    candidate.actions[0]!.evidenceIds = [actionEvidenceId];
    let reviewCalls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        if (!input.prompt.includes('REVIEW_REQUEST=')) {
          return { threadId: 'p02', turnId: 'assessment', output: assessmentOutputFor(input.prompt, candidate) };
        }
        reviewCalls += 1;
        const sourceContext = JSON.parse(input.prompt.split('SOURCE_CONTEXT=')[1]!.split('\nTARGET_NODES=')[0]!) as {
          evidenceCatalog: Array<{ id: string }>
        };
        expect(sourceContext.evidenceCatalog.map((item) => item.id)).toContain(actionEvidenceId);
        const request = JSON.parse(input.prompt.split('REVIEW_REQUEST=')[1]!.split('\nSOURCE_CONTEXT=')[0]!) as {
          targets: string[]; personId: string; inputSignature: string
        };
        return { threadId: 'p04', turnId: 'review', output: assessmentOutputFor(input.prompt, {
          schemaVersion: 1, personId, inputSignature: request.inputSignature,
          results: request.targets.map((targetId) => ({ targetId, verdict: 'pass', reason: '合成复核已核对来源。', replacement: null }))
        }) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    expect(reviewCalls).toBe(1);
    service.close();
  });

  it('清晰资料只调用一次 P01、一次 P02，并发布一份成员快照', async () => {
    const { service, personId, built } = await fixture();
    let assessmentCalls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        assessmentCalls += 1;
        expect(input.prompt).toContain('ASSESSMENT_REQUEST=');
        expect(input.allowWebSearch).toBe(true);
        return { threadId: 'p02-thread', turnId: 'p02-turn', output: assessmentOutputFor(input.prompt, candidateFor(built.request, built.evidencePackage)) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 1 });
    expect(assessmentCalls).toBe(1);
    expect(service.store.listMemberAssessmentSnapshots(personId, true)).toHaveLength(1);
    expect(service.getMemberOverview(personId).headline).toBe('这次血脂检查有一项需要关注');
    expect(service.getLifestylePlan(personId).adoptedActions).toEqual([]);
    expect(await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async () => { throw new Error('SHOULD_NOT_RUN'); } },
      undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId))
      .toMatchObject({ status: 'skipped', reason: 'signature_current', callCount: 0 });
    service.close();
  });

  it('发送 P02 前历史来源被排除时，旧证据包不能送给模型', async () => {
    const { service, personId, built } = await fixtureTwoSystems();
    const historicalDocumentId = built.evidencePackage.facts[0]!.documentId;
    let calls = 0;
    await expect(new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async () => {
        calls += 1;
        throw new Error('STALE_PACKAGE_WAS_SENT');
      }
    }, (stage) => {
      if (stage === 'analyze') service.store.setDocumentIncluded({ documentId: historicalDocumentId, included: false });
    }, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId))
      .rejects.toThrow('MEMBER_ASSESSMENT_FACT_REVISION_CONFLICT');
    expect(calls).toBe(0);
    expect(service.store.listAcceptedObservations(personId).some((fact) => fact.documentId === historicalDocumentId)).toBe(false);
    service.close();
  });

  it.each(['repair', 'focused'] as const)('P02 后授权事实变化时不再发送 %s 请求', async (nextStage) => {
    const { service, personId, built } = await fixtureTwoSystems();
    const historicalDocumentId = built.evidencePackage.facts[0]!.documentId;
    const candidate = candidateFor(built.request, built.evidencePackage);
    if (nextStage === 'repair') candidate.claims[0]!.evidenceIds = ['missing-evidence'];
    else candidate.claims[0]!.consequenceLevel = 'high';
    let calls = 0;
    await expect(new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        if (calls !== 1) throw new Error('STALE_PACKAGE_WAS_SENT');
        service.store.setDocumentIncluded({ documentId: historicalDocumentId, included: false });
        return { threadId: 'p02', turnId: 'first', output: assessmentOutputFor(input.prompt, candidate) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId))
      .rejects.toThrow('MEMBER_ASSESSMENT_FACT_REVISION_CONFLICT');
    expect(calls).toBe(1);
    service.close();
  });

  it('成员建议只有本人点击后成为行动，重复点击不重复创建，资料变化后拒绝旧快照', async () => {
    const { service, personId, built } = await fixture();
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => ({ threadId: 'p02', turnId: 'turn', output: assessmentOutputFor(input.prompt, candidateFor(built.request, built.evidencePackage)) })
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result.status).toBe('published');
    expect(service.getLifestylePlan(personId).adoptedActions).toEqual([]);
    const snapshot = service.getMemberAssessment(personId)!;
    const input = { personId, snapshotId: snapshot.id, actionId: snapshot.actions[0]!.id };
    const first = service.adoptMemberAssessmentAction(input);
    expect(first).toMatchObject({ origin: 'ai_proposed', status: 'planned' });
    expect(service.adoptMemberAssessmentAction(input).id).toBe(first.id);
    expect(service.getLifestylePlan(personId).adoptedActions).toMatchObject([{
      id: first.id, assessmentDedupeKey: snapshot.actions[0]!.dedupeKey
    }]);
    expect(service.store.listActionItems(personId).filter((item) => item.id === first.id)).toHaveLength(1);
    expect(() => service.adoptMemberAssessmentAction({ ...input, actionId: 'not-in-snapshot' })).toThrow('MEMBER_ASSESSMENT_ACTION_NOT_AVAILABLE');
    service.store.createManualNote({
      personId, kind: 'free_text', immutableText: '合成补充说明', effectiveDate: '2026-09-22',
      structuredFields: {}, expectedContextRevision: 0
    });
    expect(() => service.adoptMemberAssessmentAction(input)).toThrow('MEMBER_ASSESSMENT_ACTION_STALE');
    expect(service.store.listActionItems(personId).some((item) => item.id === first.id)).toBe(true);
    service.close();
  });

  it('医嘱采纳的来源日期与引用进入后续综合，保留进度且重新综合不重复创建', async () => {
    const { service, personId } = await fixture(false, true);
    const runtime = { runStructuredTurn: async (input: { prompt: string }) => {
      const request = JSON.parse(input.prompt.split('ASSESSMENT_REQUEST=')[1]!.split('\nMEMBER_EVIDENCE_PACKAGE=')[0]!) as AssessmentRequestV3;
      const source = expandMemberEvidence(JSON.parse(input.prompt.split('MEMBER_EVIDENCE_PACKAGE=')[1]!));
      const candidate = candidateFor(request, source);
      Object.assign(candidate.actions[0]!, { kind: 'documented_plan', title: '复查血脂',
        firstStep: '按报告中的医生安排复查血脂。', timing: '3个月后', timingBasis: 'documented' });
      return { threadId: 'synthetic-plan', turnId: 'synthetic-plan', output: assessmentOutputFor(input.prompt, candidate) };
    } };
    await new MemberAssessmentPipeline(service.store, runtime,
      undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    const firstSnapshot = service.getMemberAssessment(personId)!;
    const adopted = service.adoptMemberAssessmentAction({ personId, snapshotId: firstSnapshot.id,
      actionId: firstSnapshot.actions[0]!.id });
    expect(adopted.origin).toBe('clinician_document');
    const options = { modelId: 'test-model', reasoningEffort: 'medium', analysisReferenceDate: '2026-09-22', webSearchAllowed: true };
    const beforeProgress = buildMemberAssessmentInput(service.store, personId, options);
    expect(beforeProgress.evidencePackage.existingActions).toMatchObject([{
      id: adopted.id, origin: 'clinician_document', dueDate: null, dueText: '3个月后', sourceDate: '2026-09-21',
      sourceAssessmentId: firstSnapshot.id, sourceActionId: firstSnapshot.actions[0]!.id,
      evidenceRefs: firstSnapshot.evidenceCatalog.filter((ref) => firstSnapshot.actions[0]!.evidenceIds.includes(ref.id))
    }]);
    expect(buildMemberAnalysisPackage(beforeProgress.evidencePackage).existingActions)
      .toEqual(beforeProgress.evidencePackage.existingActions);
    service.store.updateActionStatus({ actionId: adopted.id, status: 'completed', expectedRevision: adopted.userRevision });
    const afterProgress = buildMemberAssessmentInput(service.store, personId, options);
    expect(afterProgress.request.inputSignature).toBe(beforeProgress.request.inputSignature);
    service.store.createManualNote({ personId, kind: 'free_text', immutableText: '本人已整理报告。',
      effectiveDate: '2026-09-22', structuredFields: {}, expectedContextRevision: 0 });
    await new MemberAssessmentPipeline(service.store, runtime,
      undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    const secondSnapshot = service.getMemberAssessment(personId)!;
    const repeated = service.adoptMemberAssessmentAction({ personId, snapshotId: secondSnapshot.id,
      actionId: secondSnapshot.actions[0]!.id });
    expect(repeated).toMatchObject({ id: adopted.id, origin: 'clinician_document', status: 'completed' });
    expect(service.getLifestylePlan(personId).adoptedActions).toMatchObject([{
      id: adopted.id, status: 'completed', assessmentDedupeKey: secondSnapshot.actions[0]!.dedupeKey
    }]);
    service.close();
  });

  it.each([
    ['短标题同义改写', '复查血脂，一起查看', '按报告中的医生安排复查血脂。', '3个月后复查血脂。', '3个月后'],
    ['反向标题', '无需复查血脂', '按报告中的医生安排复查血脂。', '3个月后复查血脂。', '3个月后'],
    ['标题交换期限', '六个月后复查血常规，三天后复查肝功能', '三天后复查血常规，六个月后复查肝功能。',
      '三天后复查血常规，六个月后复查肝功能。', null],
    ['儿童眼科原建议', '由家长陪同完成眼科检查', '由家长陪同到眼科进一步检查，结合散瞳验光结果判断屈光状态。',
      '由家长陪同到眼科进一步检查，结合散瞳验光结果判断屈光状态。', null]
  ])('%s只中性化新候选标题，不增加调用或改变原建议', async (_label, title, firstStep, planText, timing) => {
    const { service, personId, built } = await fixture(false, true, false, planText!);
    const candidate = candidateFor(built.request, built.evidencePackage);
    Object.assign(candidate.actions[0]!, { kind: 'documented_plan', title, firstStep, timing,
      timingBasis: timing === null ? 'none' : 'documented' });
    const original = JSON.stringify(candidate);
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => ({
      threadId: 'synthetic-title-only', turnId: 'p02', output: assessmentOutputFor(input.prompt, candidate)
    }) }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 1 });
    const snapshot = service.getMemberAssessment(personId)!;
    expect(snapshot.actions).toEqual([{ ...candidate.actions[0], title: DOCUMENTED_PLAN_NEUTRAL_TITLE }]);
    expect(snapshot.heldTargetIds).toEqual([]);
    expect(snapshot.overview.actionIds).toEqual(candidate.overview.actionIds);
    expect(JSON.stringify(candidate)).toBe(original);
    service.close();
  });

  it.each([
    ['无需复查血脂。', 'documented_plan_instruction_not_proven'],
    ['复查血脂和胸部CT。', 'documented_plan_instruction_not_proven'],
    ['立即复查血脂。', 'documented_plan_timing_not_proven']
  ])('正文问题 %s 同次P04明确隔离行动，不因中性标题放行', async (firstStep, issue) => {
    const { service, personId, built } = await fixture(false, true);
    const candidate = candidateFor(built.request, built.evidencePackage);
    Object.assign(candidate.actions[0]!, { kind: 'documented_plan', title: DOCUMENTED_PLAN_NEUTRAL_TITLE,
      firstStep, timing: '3个月后', timingBasis: 'documented' });
    const prompts: string[] = [];
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async ({ prompt }) => {
      prompts.push(prompt);
      return { threadId: 'synthetic-body-invalid', turnId: String(prompts.length), output: prompts.length === 1 ? candidate
        : focusedOutputFor(prompt, candidate, [], [candidate.actions[0]!.id]) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    expect(prompts[1]).toContain(`${issue}:${candidate.actions[0]!.id}`);
    const snapshot = service.getMemberAssessment(personId)!;
    expect(snapshot.actions).toEqual([]);
    expect(snapshot.heldTargetIds).toContain(candidate.actions[0]!.id);
    expect(snapshot.claims).toEqual(candidate.claims);
    expect(service.getMemberAssessment(personId)!.actions).toEqual([]);
    expect(service.store.listAcceptedObservations(personId)).toHaveLength(1);
    service.close();
  });

  it.each([true, false])('无期限原甲状腺指示保留完整主题前缀和动作（P02已完整引用=%s）', async (completeInitially) => {
    const sourceInstruction = '桥本氏甲状腺炎超声改变 : 请到内分泌科随访，动态观察甲状腺彩超及甲状腺功能指标。';
    const { service, personId, built } = await fixture(false, true, false, sourceInstruction);
    const candidate = candidateFor(built.request, built.evidencePackage);
    const fullStep = `2026-09-21报告建议：“${sourceInstruction}”`;
    Object.assign(candidate.actions[0]!, { kind: 'documented_plan', title: DOCUMENTED_PLAN_NEUTRAL_TITLE,
      why: '原报告记录了内分泌随访安排，是否继续适用需结合当前情况。',
      firstStep: completeInitially ? fullStep : '2026-09-21报告建议：“请到内分泌科随访，动态观察甲状腺彩超及甲状腺功能指标。”',
      timing: null, timingBasis: 'none', reviewPlan: '结合当前医生评估讨论后续安排。',
      caution: '原报告未给具体期限，不按今天重新起算。' });
    const factsBefore = service.store.listAcceptedObservations(personId);
    const repaired = structuredClone(candidate);
    repaired.actions[0]!.firstStep = fullStep;
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (turn) => {
      calls += 1;
      if (calls === 1) return { threadId: 'p02', turnId: 'original-plan', output: assessmentOutputFor(turn.prompt, candidate) };
      expect(calls).toBe(2);
      expect(turn.allowWebSearch).toBe(false);
      expect(turn.prompt).toContain('documented_plan_instruction_not_proven:action-review');
      expect(turn.prompt).toContain('REVIEW_REQUEST=');
      expect(turn.prompt).toContain(sourceInstruction);
      return { threadId: 'p04', turnId: 'full-source-clause', output: focusedOutputFor(turn.prompt, repaired, ['action-review']) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: completeInitially ? 1 : 2 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.heldTargetIds).toEqual([]);
    expect(snapshot.actions[0]).toMatchObject({ kind: 'documented_plan', firstStep: fullStep, timing: null,
      timingBasis: 'none', evidenceIds: candidate.actions[0]!.evidenceIds, caution: candidate.actions[0]!.caution });
    expect(snapshot.claims).toEqual(candidate.claims);
    expect(service.store.listAcceptedObservations(personId)).toEqual(factsBefore);
    service.close();
  });

  it('complete 缓存省略原页后，P04核对相关医嘱真实完整前缀和日期，回执保留原期限边界', async () => {
    const { service, personId } = await fixture();
    const firstStep = '请到内分泌科随访，动态观察甲状腺彩超及甲状腺功能指标。';
    const sourceInstruction = `桥本氏甲状腺炎超声改变 : ${firstStep}`;
    const quote = `检查日期：2026-09-21；医生建议：${sourceInstruction}`;
    await service.importFiles([{ path: '/tmp/合成完整甲状腺安排.txt', bytes: Buffer.from(quote) }], personId);
    const documentId = service.getSnapshot(null).inbox.find((item) => item.displayName === '合成完整甲状腺安排.txt')!.id;
    const spans = service.store.getDocumentExtractionBundle(documentId).manifest.spans;
    const extraction: ExtractionResult = { schemaVersion: 1, documentId,
      coveredSourceSpanIds: spans.map((span) => span.id), subject: { reportedName: null, evidence: [], confidence: 'absent' },
      candidates: [{ localKey: 'original-plan', originalName: '医生建议', standardNameCandidate: null,
        value: { kind: 'text', rawText: firstStep }, unitRaw: null, referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: null, bodySite: null, clinicalDate: '2026-09-21',
        clinicalContext: { version: 1, status: 'complete', conditions: [] },
        evidence: spans.map((span) => ({ sourceSpanId: span.id, quote: span.quote })), issues: [] }] };
    expect(await new DocumentExtractionPipeline(service.store, { runStructuredTurn: async () => ({
      threadId: 'synthetic-plan', turnId: 'p01', output: extraction
    }) }).process(documentId)).toMatchObject({ status: 'published' });
    const built = buildMemberAssessmentInput(service.store, personId, { modelId: 'test-model', reasoningEffort: 'medium',
      analysisReferenceDate: '2026-09-22', webSearchAllowed: true });
    const fact = built.evidencePackage.facts.find((item) => item.originalName === '医生建议')!;
    expect(fact.rawValue).toBe(firstStep);
    expect(fact.clinicalContext!.status).toBe('complete');
    expect(buildMemberAnalysisPackage(built.evidencePackage).sourceContext).toEqual([]);
    const candidate = candidateFor(built.request, built.evidencePackage);
    Object.assign(candidate.actions[0]!, { kind: 'documented_plan', title: DOCUMENTED_PLAN_NEUTRAL_TITLE,
      why: '原报告有随访安排，当前是否适用需结合医生评估。', firstStep: `2026-09-21报告建议：“${firstStep}”`,
      timing: null, timingBasis: 'none', reviewPlan: '结合当前医生评估讨论后续安排。',
      caution: '原报告未给具体期限，不按今天重新起算。', evidenceIds: [...fact.evidenceIds] });
    const corrected = structuredClone(candidate);
    corrected.actions[0]!.firstStep = `2026-09-21报告建议：“${sourceInstruction}”`;
    const factsBefore = service.store.listAcceptedObservations(personId);
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (turn) => {
      calls += 1;
      if (calls === 1) {
        expect(turn.prompt).not.toContain(sourceInstruction);
        return { threadId: 'p02', turnId: 'cached-facts', output: candidate };
      }
      expect(turn.prompt).toContain('REVIEW_REQUEST=');
      const context = JSON.parse(turn.prompt.split('SOURCE_CONTEXT=')[1]!.split('\nTARGET_NODES=')[0]!) as {
        evidenceCatalog: MemberEvidencePackageV3['evidenceCatalog']
      };
      expect(context.evidenceCatalog.filter((ref) => fact.evidenceIds.includes(ref.id)))
        .toEqual(built.evidencePackage.evidenceCatalog.filter((ref) => fact.evidenceIds.includes(ref.id)));
      expect(context.evidenceCatalog.some((ref) => ref.quote?.includes(sourceInstruction))).toBe(true);
      expect(turn.allowWebSearch).toBe(false);
      const wire = focusedOutputFor(turn.prompt, corrected, ['action-review']);
      wire.results.forEach((item) => {
        if (item.replacement?.nodeType === 'action') Object.assign(item.replacement.value, { lifestyleDomain: null, lifestyleBasis: null });
      });
      return { threadId: 'p04', turnId: 'original-instruction', output: restoreCodexOptionalFields(wire, turn.outputSchema) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    if (result.status !== 'published') throw new Error('SYNTHETIC_ASSESSMENT_NOT_PUBLISHED');
    expect(result.repairDiagnostics).toBeUndefined();
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.actions[0]).toMatchObject({ firstStep: corrected.actions[0]!.firstStep, timing: null,
      timingBasis: 'none', caution: candidate.actions[0]!.caution, evidenceIds: fact.evidenceIds });
    expect(snapshot.claims).toEqual(candidate.claims);
    expect(service.store.listAcceptedObservations(personId)).toEqual(factsBefore);
    service.close();
  });

  it('来源不能证明医嘱时P04只隔离该行动，保留血脂事实和可用解读', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    Object.assign(candidate.actions[0]!, { kind: 'documented_plan', title: '复查甲状腺功能',
      firstStep: '按原报告医嘱复查甲状腺功能。', timing: '3个月后', timingBasis: 'documented' });
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      return { threadId: 'synthetic-invalid-plan', turnId: String(calls), output: calls === 1 ? candidate
        : focusedOutputFor(input.prompt, candidate, [], ['action-review']) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    const snapshot = service.getMemberAssessment(personId)!;
    expect(snapshot.claims).toEqual(candidate.claims);
    expect(snapshot.actions).toEqual([]);
    expect(snapshot.heldTargetIds).toContain(candidate.actions[0]!.id);
    expect(service.store.listAcceptedObservations(personId)).toHaveLength(1);
    service.close();
  });

  it('新增本人资料并重新综合后保留已采纳行动的进度且不重复创建', async () => {
    const { service, personId, built } = await fixture();
    const runtime = {
      runStructuredTurn: async (input: { prompt: string }) => {
        const request = JSON.parse(input.prompt.split('ASSESSMENT_REQUEST=')[1]!.split('\nMEMBER_EVIDENCE_PACKAGE=')[0]!) as AssessmentRequestV3;
        const source = expandMemberEvidence(JSON.parse(input.prompt.split('MEMBER_EVIDENCE_PACKAGE=')[1]!));
        return { threadId: 'p02', turnId: 'turn', output: assessmentOutputFor(input.prompt, candidateFor(request, source)) };
      }
    };
    const firstResult = await new MemberAssessmentPipeline(service.store, runtime,
      undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(firstResult).toMatchObject({ status: 'published', callCount: 1 });
    const firstSnapshot = service.getMemberAssessment(personId)!;
    expect(firstSnapshot.inputSignature).toBe(built.request.inputSignature);
    const adopted = service.adoptMemberAssessmentAction({
      personId, snapshotId: firstSnapshot.id, actionId: firstSnapshot.actions[0]!.id
    });
    service.store.updateActionStatus({ actionId: adopted.id, status: 'completed', expectedRevision: adopted.userRevision });
    service.store.createManualNote({
      personId, kind: 'free_text', immutableText: '合成补充说明', effectiveDate: '2026-09-22',
      structuredFields: {}, expectedContextRevision: 0
    });
    const secondResult = await new MemberAssessmentPipeline(service.store, runtime,
      undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(secondResult).toMatchObject({ status: 'published', callCount: 1 });
    const secondSnapshot = service.getMemberAssessment(personId)!;
    expect(secondSnapshot.id).not.toBe(firstSnapshot.id);
    expect(service.getLifestylePlan(personId).adoptedActions).toMatchObject([{
      id: adopted.id, assessmentDedupeKey: secondSnapshot.actions[0]!.dedupeKey, status: 'completed'
    }]);
    expect(service.store.listActionItems(personId).filter((item) => item.id === adopted.id)).toHaveLength(1);
    service.close();
  });

  it('合成 v34 库升级为 V3 后，重启仍保留事实、旧快照、修正和已完成事项', async () => {
    const { service, personId, documentId } = await fixture();
    const root = service.store.rootDirectory;
    const report = service.store.listReportMetadata(personId)[0]!;
    service.updateReportMetadata({
      personId, reportId: report.reportId, expectedRevision: report.metadataRevision,
      title: '本人核对后的合成血脂报告', organization: null, department: null,
      clinicalTime: { value: '2026-09-21', precision: 'day' }, reason: '合成升级测试：保留手工修正'
    });
    const note = service.createManualNote({
      personId, kind: 'free_text', immutableText: '本人补充：尚未复测血脂。',
      effectiveDate: '2026-09-22', structuredFields: {}, expectedContextRevision: 0
    });
    const action = service.createAction({
      personId, title: '带报告复核', detail: '本人已完成的旧版事项', dueDate: null, dueText: null
    });
    service.updateActionStatus({ actionId: action.id, status: 'completed', expectedRevision: action.userRevision });
    const fact = service.store.listAcceptedObservations(personId)[0]!;
    const factRevision = service.store.getFactRevision(personId);
    const sourceHash = service.store.getDocumentSourceHash(documentId);
    const legacyCandidate: DerivedSnapshotCandidate = {
      schemaVersion: 1, personId, factRevision, dataQuality: 'partial', claims: [],
      lifestyleGuidance: [{
        id: 'old-guidance', dedupeKey: 'lipid-risk-context', category: 'review', title: '旧版生活建议',
        detail: '带上报告讨论复查安排。', goal: '确定复查安排',
        rationale: '已有一项带来源的检查结果。', steps: ['整理报告'],
        startingOptions: ['先整理资料'], scheduleSuggestion: null,
        trackingSuggestion: '记录是否完成', constraints: [], uncertainties: [],
        generalKnowledgeEvidence: [], sourceKind: 'ai_proposed', relatedSystemIds: ['cardiovascular'],
        evidenceObservationIds: [fact.id], consultProfessional: false
      }]
    };
    const legacySnapshot = service.store.publishDerivedSnapshot({
      candidate: legacyCandidate, expectedFactRevision: factRevision,
      expectedContextRevision: service.store.getClinicalContextRevision(personId),
      promptVersion: 'derived-v1', rulesVersion: 'derived-safety-v1', modelId: 'legacy-model'
    });
    const legacyProposal = service.store.listLifestyleProposals(personId)[0]!;
    // 模拟旧版本已经允许的采纳；现版本服务入口会阻止新增旧建议。
    const adopted = service.store.adoptLifestyleProposal({
      personId, proposalId: legacyProposal.id, userGoal: '带上报告讨论复查安排',
      selectedStartingOption: '先整理资料', plannedTime: '下次就诊时', owner: '本人',
      progressNote: '已整理旧报告', dueDate: null
    });
    service.updateActionStatus({ actionId: adopted.id, status: 'completed', expectedRevision: 1 });
    expect(service.getLifestylePlan(personId).proposals).toEqual([
      expect.objectContaining({ id: legacyProposal.id, title: '旧版生活建议', status: 'adopted' })
    ]);
    service.close();

    // 撤回 v34 之后的新增结构；重开时必须走真实迁移与备份路径。
    const oldSchema = new Database(join(root, 'health.db'));
    oldSchema.exec(`
      DROP TABLE member_assessment_snapshots_v3;
      DROP TABLE report_clinical_contexts;
      ALTER TABLE observation_revisions DROP COLUMN clinical_context_json;
      ALTER TABLE action_items DROP COLUMN user_schedule_text;
      UPDATE workspaces SET schema_version = 34;
      PRAGMA user_version = 34;
    `);
    expect(oldSchema.pragma('user_version', { simple: true })).toBe(34);
    oldSchema.close();

    const reopened = new PersonalWorkspaceService(root, '合成工作区', () => new Date('2026-09-22T00:00:00Z'));
    const migratedDatabase = new Database(reopened.store.databasePath, { readonly: true });
    expect(migratedDatabase.pragma('user_version', { simple: true })).toBe(WORKSPACE_SCHEMA_VERSION);
    expect(migratedDatabase.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'member_assessment_snapshots_v3'`).get())
      .toEqual({ name: 'member_assessment_snapshots_v3' });
    migratedDatabase.close();
    const backupNames = readdirSync(reopened.store.schemaBackupDirectory).filter((name) => name.endsWith('.db'));
    expect(backupNames).toHaveLength(1);
    const preMigrationBackup = new Database(join(reopened.store.schemaBackupDirectory, backupNames[0]!), { readonly: true });
    expect(preMigrationBackup.pragma('user_version', { simple: true })).toBe(34);
    expect(preMigrationBackup.prepare(`SELECT id FROM derived_snapshots WHERE id = ?`).get(legacySnapshot.snapshotId))
      .toEqual({ id: legacySnapshot.snapshotId });
    expect(preMigrationBackup.prepare(`SELECT status FROM action_adoptions_v2 WHERE id = ?`).get(adopted.id)).toEqual({ status: 'completed' });
    preMigrationBackup.close();
    expect(reopened.getMemberAssessment(personId)).toBeNull();
    expect(reopened.getMemberOverview(personId).headline).toBe('报告内容已保存，健康解读正在准备。');
    expect(reopened.getLifestylePlan(personId)).toMatchObject({
      status: 'stale',
      proposals: [expect.objectContaining({ id: legacyProposal.id, status: 'adopted' })],
      adoptedActions: [expect.objectContaining({ id: adopted.id, status: 'completed' })]
    });
    expect(() => reopened.adoptLifestyleProposal({
      personId, proposalId: legacyProposal.id, userGoal: '重复采纳旧建议',
      selectedStartingOption: '先整理资料', plannedTime: null, owner: '本人',
      progressNote: null, dueDate: null
    })).toThrow('LIFESTYLE_PROPOSAL_STALE_REVIEW_REQUIRED');
    expect(reopened.getSnapshot(null).persons.find((person) => person.id === personId)).toMatchObject({
      derivedStatus: 'stale', assessmentSummary: null
    });
    let calls = 0;
    const result = await new MemberAssessmentPipeline(reopened.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        if (input.prompt.includes('CLINICAL_CONTEXT_INPUT=')) {
          expect(input.allowWebSearch).toBe(false);
          const data = JSON.parse(input.prompt.split('CLINICAL_CONTEXT_INPUT=')[1]!) as {
            facts: Array<{ observationId: string }>;
          };
          return { threadId: 'v3-context-upgrade', turnId: 'v3-context-upgrade', output: assessmentOutputFor(input.prompt, {
            version: 1, items: data.facts.map((item) => ({ observationId: item.observationId,
              context: { version: 1, status: 'complete', conditions: [] } }))
          }) };
        }
        const request = JSON.parse(input.prompt.split('ASSESSMENT_REQUEST=')[1]!.split('\nMEMBER_EVIDENCE_PACKAGE=')[0]!) as AssessmentRequestV3;
        const evidence = expandMemberEvidence(JSON.parse(input.prompt.split('MEMBER_EVIDENCE_PACKAGE=')[1]!));
        expect(evidence.facts.some((item) => item.originalName === fact.originalName && item.rawValue === fact.rawText)).toBe(true);
        expect(evidence.personalContext.some((item) => item.text === note.immutableText)).toBe(true);
        return { threadId: 'v3-upgrade', turnId: 'v3-upgrade', output: assessmentOutputFor(input.prompt, candidateFor(request, evidence)) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    expect(calls).toBe(2);
    const assessment = reopened.getMemberAssessment(personId)!;
    expect(assessment.overview.headline).toBe('这次血脂检查有一项需要关注');
    expect(reopened.getLifestylePlan(personId).adoptedActions).toContainEqual(
      expect.objectContaining({ id: adopted.id, assessmentDedupeKey: assessment.actions[0]!.dedupeKey })
    );
    expect(reopened.adoptMemberAssessmentAction({
      personId, snapshotId: assessment.id, actionId: assessment.actions[0]!.id
    }).id).toBe(adopted.id);
    expect(reopened.store.listActionItems(personId).filter((item) => item.origin === 'ai_proposed')).toHaveLength(1);
    expect(reopened.store.getFactRevision(personId)).toBe(factRevision);
    expect(reopened.store.getDocumentSourceHash(documentId)).toBe(sourceHash);
    expect(reopened.store.listAcceptedObservations(personId)).toMatchObject([{
      id: fact.id, rawText: '4.2', documentId
    }]);
    expect(reopened.store.listReportMetadata(personId)[0]).toMatchObject({ title: '本人核对后的合成血脂报告' });
    expect(reopened.store.listManualNotes(personId)).toContainEqual(expect.objectContaining({ id: note.id }));
    expect(reopened.store.listActionItems(personId)).toContainEqual(expect.objectContaining({ id: action.id, status: 'completed' }));
    expect(reopened.store.listActionAdoptions(personId)).toEqual([
      expect.objectContaining({ id: adopted.id, proposalId: legacyProposal.id, status: 'completed' })
    ]);
    expect(reopened.getLifestylePlan(personId).adoptedActions).toContainEqual(
      expect.objectContaining({ id: adopted.id, status: 'completed' })
    );
    const persisted = new Database(reopened.store.databasePath, { readonly: true });
    expect(persisted.prepare('SELECT payload_json FROM derived_snapshots WHERE id = ?').get(legacySnapshot.snapshotId))
      .toEqual({ payload_json: JSON.stringify(legacyCandidate) });
    persisted.close();
    reopened.close();

    const restarted = new PersonalWorkspaceService(root, '合成工作区', () => new Date('2026-09-22T00:00:00Z'));
    expect(restarted.getMemberAssessment(personId)?.overview.headline).toBe('这次血脂检查有一项需要关注');
    expect(restarted.store.getDocumentSourceHash(documentId)).toBe(sourceHash);
    expect(restarted.store.listActionItems(personId)).toContainEqual(expect.objectContaining({ id: action.id, status: 'completed' }));
    expect(restarted.store.listActionAdoptions(personId)).toEqual([
      expect.objectContaining({ id: adopted.id, status: 'completed' })
    ]);
    expect(await new MemberAssessmentPipeline(restarted.store, {
      runStructuredTurn: async () => { throw new Error('SHOULD_NOT_REPROCESS'); }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId))
      .toMatchObject({ status: 'skipped', reason: 'signature_current', callCount: 0 });
    restarted.store.saveExtractionReviewIssue({
      documentId, kind: 'coverage_gap', severity: 'warning', preserveDocumentStatus: true,
      evidenceRefs: [], reasonCodes: ['SYNTHETIC_NEW_SCOPE']
    });
    expect(restarted.getMemberAssessment(personId)).toBeNull();
    const staleHome = restarted.getSnapshot(null);
    expect(staleHome.persons.find((person) => person.id === personId)).toMatchObject({
      derivedStatus: 'stale', assessmentSummary: null
    });
    expect(staleHome.guidance).toEqual([]);
    expect(restarted.getMemberOverview(personId).headline).toBe('报告内容已保存，健康解读正在准备。');
    restarted.close();
  });

  it('隔离合成评测可显式关闭 P02 联网，输入签名和运行权限保持一致', async () => {
    const { service, personId } = await fixture();
    const built = buildMemberAssessmentInput(service.store, personId, {
      modelId: 'test-model', reasoningEffort: 'medium', analysisReferenceDate: '2026-09-22', webSearchAllowed: false
    });
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        expect(input.allowWebSearch).toBe(false);
        const request = JSON.parse(input.prompt.split('ASSESSMENT_REQUEST=')[1]!.split('\nMEMBER_EVIDENCE_PACKAGE=')[0]!) as AssessmentRequestV3;
        expect(request.webSearchAllowed).toBe(false);
        return { threadId: 'offline', turnId: 'offline', output: assessmentOutputFor(input.prompt, candidateFor(built.request, built.evidencePackage)) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22', false).process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 1 });
    service.close();
  });

  it('仅更新已采纳行动的完成进度不会使成员医学输入失效', async () => {
    const { service, personId } = await fixture();
    const action = service.store.createUserAction({
      personId, title: '整理既往报告', detail: '下次就诊携带', dueDate: null, dueText: null
    });
    const options = { modelId: 'test-model', reasoningEffort: 'medium', analysisReferenceDate: '2026-09-22', webSearchAllowed: true };
    const before = buildMemberAssessmentInput(service.store, personId, options);
    service.store.updateActionStatus({ actionId: action.id, status: 'completed', expectedRevision: action.userRevision });
    const after = buildMemberAssessmentInput(service.store, personId, options);
    expect(after.request.inputSignature).toBe(before.request.inputSignature);
    expect(after.evidencePackage.existingActions[0]!.status).toBe('existing');
    service.close();
  });

  it('本人时间安排独立进入后续综合，清空不恢复原时间且完成进度仍不改变医学签名', async () => {
    const { service, personId } = await fixture();
    const action = service.store.createUserAction({ personId, title: '携带报告就诊',
      detail: '带既往检查资料', dueDate: null, dueText: '原先计划下周二' });
    const options = { modelId: 'test-model', reasoningEffort: 'medium', analysisReferenceDate: '2026-09-22', webSearchAllowed: false };
    const original = buildMemberAssessmentInput(service.store, personId, options);
    expect(original.evidencePackage.existingActions[0]).toMatchObject({ dueText: '原先计划下周二', userScheduleText: '原先计划下周二' });
    const scheduled = service.updateActionSchedule({ personId, actionId: action.id,
      dueDate: '2026-10-20', userScheduleText: '这是回顾日期，上午检查预约进展', expectedRevision: 1 });
    const updated = buildMemberAssessmentInput(service.store, personId, options);
    expect(updated.evidencePackage.existingActions[0]).toMatchObject({ dueDate: '2026-10-20',
      dueText: '原先计划下周二', userScheduleText: '这是回顾日期，上午检查预约进展' });
    expect(buildMemberAnalysisPackage(updated.evidencePackage).existingActions).toEqual(updated.evidencePackage.existingActions);
    const cleared = service.updateActionSchedule({ personId, actionId: action.id,
      dueDate: null, userScheduleText: null, expectedRevision: scheduled.userRevision });
    const beforeCompletion = buildMemberAssessmentInput(service.store, personId, options);
    expect(beforeCompletion.evidencePackage.existingActions[0]).toMatchObject({ dueDate: null,
      userScheduleText: null, dueText: '原先计划下周二' });
    service.store.updateActionStatus({ actionId: action.id, status: 'completed', expectedRevision: cleared.userRevision });
    expect(buildMemberAssessmentInput(service.store, personId, options).request.inputSignature).toBe(beforeCompletion.request.inputSignature);
    service.close();
  });

  it.each([
    { reason: '提示词版本变化', promptVersion: 'member-assessment-v2', rulesVersion: null },
    { reason: '重点复核路由规则升级', promptVersion: null, rulesVersion: 'lean-health-v3.4' }
  ])('$reason 时只重做 P02，已接纳报告事实不重新提取', async ({ promptVersion, rulesVersion }) => {
    const { service, personId, built } = await fixture();
    await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => ({ threadId: 'original', turnId: 'original', output: assessmentOutputFor(input.prompt, candidateFor(built.request, built.evidencePackage)) })
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    const original = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    const oldSignature = 'f'.repeat(64);
    const database = new Database(service.store.databasePath);
    database.prepare(`UPDATE member_assessment_snapshots_v3 SET input_signature = ?, prompt_version = ?, rules_version = ?,
      payload_json = json_set(payload_json, '$.inputSignature', ?, '$.promptVersion', ?, '$.rulesVersion', ?) WHERE id = ?`)
      .run(oldSignature, promptVersion ?? original.promptVersion, rulesVersion ?? original.rulesVersion,
        oldSignature, promptVersion ?? original.promptVersion, rulesVersion ?? original.rulesVersion, original.id);
    database.close();
    expect(service.getMemberAssessment(personId)).toBeNull();
    const state: AccountState = { status: 'connected', displayLabel: 'fixture@example.test',
      quota: { status: 'available', primaryUsedPercent: 10, secondaryUsedPercent: null, resetsAt: null },
      runtimeVersion: 'fixture', lastCheckedAt: '2026-09-22T00:00:00Z' };
    service.processNow({ accountState: state, consentVersion: 1 });
    expect(service.store.listStoredJobs()[0]).toMatchObject({ stage: 'analyze' });
    const factRevision = service.store.getFactRevision(personId);
    let calls = 0;
    const runtime = {
      getState: () => state,
      runStructuredTurn: async (input: { prompt: string }) => {
        calls += 1;
        expect(input.prompt).toContain('ASSESSMENT_REQUEST=');
        expect(input.prompt).not.toContain('SOURCE_PACKAGE=');
        const request = JSON.parse(input.prompt.split('ASSESSMENT_REQUEST=')[1]!.split('\nMEMBER_EVIDENCE_PACKAGE=')[0]!) as AssessmentRequestV3;
        const evidence = expandMemberEvidence(JSON.parse(input.prompt.split('MEMBER_EVIDENCE_PACKAGE=')[1]!));
        return { threadId: 'refresh', turnId: 'refresh', output: assessmentOutputFor(input.prompt, candidateFor(request, evidence)) };
      }
    } as unknown as CodexRuntimeManager;
    await new ProcessingJobRunner(runtime).runAvailableJobs(service.store);
    expect(calls).toBe(1);
    expect(service.store.getFactRevision(personId)).toBe(factRevision);
    expect(service.store.listAcceptedObservations(personId)).toHaveLength(1);
    expect(service.store.listMemberAssessmentSnapshots(personId, true)).toHaveLength(1);
    expect(service.store.listMemberAssessmentSnapshots(personId, false)).toHaveLength(2);
    service.close();
  });

  it('具体引用问题只做一次 P03，不重做全量综合', async () => {
    const { service, personId, built } = await fixture();
    const valid = candidateFor(built.request, built.evidencePackage);
    const repaired = structuredClone(valid);
    repaired.overview.summary = '修正引用后，LDL-C 仍高于报告参考上限，下一步整理病史。';
    repaired.systems[0]!.summary = '已核对的 LDL-C 结果高于参考上限。';
    repaired.actions[0]!.why = '修正引用后，单次结果仍不足以决定长期管理方向。';
    const wrong = structuredClone(valid);
    wrong.claims[0]!.evidenceIds = ['missing-evidence'];
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        if (calls === 1) return { threadId: 'p02', turnId: 'first', output: assessmentOutputFor(input.prompt, wrong) };
        expect(input.prompt).toContain('REPAIR_REQUEST=');
        expect(input.prompt).toContain('node:action-review');
        expect(input.prompt).toContain('node:system:cardiovascular');
        expect(input.prompt).toContain('"overview"');
        expect(input.allowWebSearch).toBe(false);
        return { threadId: 'p03', turnId: 'second', output: assessmentOutputFor(input.prompt, repaired) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    expect(calls).toBe(2);
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.overview.summary).toBe(repaired.overview.summary);
    expect(snapshot.systems[0]!.summary).toBe(repaired.systems[0]!.summary);
    expect(snapshot.actions[0]!.why).toBe(repaired.actions[0]!.why);
    service.close();
  });

  it.each([true, false])('P04修正复合documented影像标签同时保留有据运动和作息（完整清空诊断字段=%s）', async (clearDiagnosticFields) => {
    const { service, personId, built } = await fixtureNeckFindings();
    const neckFact = built.evidencePackage.facts.find((fact) => fact.originalName === '颈椎影像小结')!;
    const ldlFact = built.evidencePackage.facts.find((fact) => fact.originalName === 'LDL-C')!;
    const candidate = candidateFor(built.request, { facts: [ldlFact, neckFact] });
    const systemIds = built.request.requestedSystemIds;
    const neckText = '颈椎影像记载曲度变直、轻度骨质增生和颈5/6椎间盘轻度突出（中央型）；所见脊髓形态和信号未见异常。是否与颈部不适相关仍需结合症状和查体。';
    candidate.claims.push({ ...candidate.claims[0]!, id: 'claim:neck', topicKey: 'neck',
      changeAssessment: firstRecordChange(neckFact.evidenceIds),
      kind: 'diagnostic_assessment', diagnosticStatus: 'documented', diseaseName: '颈椎轻度骨质增生及颈5/6椎间盘轻度突出',
      text: neckText, evidenceIds: neckFact.evidenceIds, temporalStatus: 'historical',
      rationale: '原影像小结提供了颈椎发现和脊髓未见异常的结果。',
      materialUncertainty: '影像不能单独确定症状来源。' });
    candidate.actions.push({ id: 'action:activity', dedupeKey: 'activity-start', systemIds,
      claimIds: ['claim-ldl', 'claim:neck'], kind: 'habit', lifestyleDomain: 'activity', lifestyleBasis: 'personalized',
      title: '从不诱发颈部不适的步行开始', why: '规律活动有助于代谢管理，已有颈椎影像改变，因此起点要舒适、可降低。',
      firstStep: '若走路不引起胸部或颈部不适，本周可选3天，每次舒适步行10分钟，以能轻松说完整句子为宜；不适合时缩短，不做强力扭颈和负重颈部训练。',
      timing: '先试行1–2周。', timingBasis: 'practical_trial', reviewPlan: '记录活动后有无疼痛、麻木及异常疲乏，耐受良好再逐步增加。',
      caution: '出现胸痛、明显气促、头晕或上肢麻木加重时停止该次活动并评估；已有医生活动限制时按原安排。',
      urgency: 'routine', evidenceIds: [...ldlFact.evidenceIds, ...neckFact.evidenceIds], knowledgeSourceIds: [] },
    { id: 'action:routine', dedupeKey: 'routine-posture', systemIds, claimIds: ['claim:neck'],
      kind: 'habit', lifestyleDomain: 'daily_routine', lifestyleBasis: 'personalized', title: '减少久坐低头',
      why: '已有颈椎影像改变，日常可用小幅调整观察舒适度。',
      firstStep: '若平时长时间看屏幕，可每30–60分钟起身或变换姿势2–3分钟，把屏幕抬到较自然的视线高度。',
      timing: '先试行2周。', timingBasis: 'practical_trial', reviewPlan: '回看颈部舒适度，避免强行坚持诱发疼痛的动作。',
      caution: '不强行拉伸或旋转疼痛的颈部；出现上肢无力或麻木加重时需要评估。',
      urgency: 'routine', evidenceIds: neckFact.evidenceIds, knowledgeSourceIds: [] });
    candidate.overview = { ...candidate.overview, headline: '血脂和颈部检查各有需要关注的方面',
      summary: '血脂需结合整体背景管理；颈部影像发现需结合症状理解，可从舒适的日常活动开始。',
      claimIds: candidate.claims.map((claim) => claim.id), actionIds: candidate.actions.map((action) => action.id) };
    for (const system of candidate.systems) {
      system.claimIds = candidate.overview.claimIds;
      system.actionIds = candidate.overview.actionIds;
      system.headline = '已有检查结果可结合症状理解';
      system.summary = '血脂与颈部影像各有报告发现，仍需结合相关背景。';
    }
    const beforeFacts = service.store.listAcceptedObservations(personId);
    const beforeRevision = service.store.getFactRevision(personId);
    const repaired = structuredClone(candidate);
    repaired.claims[1] = clearDiagnosticFields
      ? { ...repaired.claims[1]!, kind: 'source_fact', diagnosticStatus: null, diseaseName: null, criteriaBasis: null,
        knowledgeBasis: 'not_applicable' }
      : { ...repaired.claims[1]!, kind: 'interpretation' };
    // 依赖建议同步改写疾病归因，完整保留动作、原证据及停止条件，而不是撤引用或改为general。
    repaired.actions[1]!.why = '血脂结果可结合规律活动管理；颈椎影像记录的改变提示活动起点应舒适、可降低。';
    repaired.actions[2]!.why = '报告记载了颈椎影像发现，可用小幅姿势调整观察颈部舒适度，不能仅凭影像确定症状来源。';
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (turn) => {
      calls += 1;
      if (calls === 1) return { threadId: 'p02', turnId: 'neck', output: assessmentOutputFor(turn.prompt, candidate) };
      if (calls === 4) {
        expect(turn.prompt).toContain('"recoveryMode":"late_independent_habits"');
        return { threadId: 'late-p03', turnId: 'neck-unchanged', output: assessmentOutputFor(turn.prompt, candidate) };
      }
      if (calls === 3) {
        expect(clearDiagnosticFields).toBe(false);
        expect(turn.allowWebSearch).toBe(false);
        const request = JSON.parse(turn.prompt.split('REPAIR_REQUEST=')[1]!.split('\nSOURCE_CONTEXT=')[0]!) as AssessmentRepairRequestV1;
        expect(request.targets).toEqual(expect.arrayContaining(['action:activity', 'action:routine']));
        expect(request.targets).toContain('claim:neck');
        return { threadId: 'p03', turnId: 'neck-dependent-unchanged', output: {
          schemaVersion: 1, personId: request.personId, inputSignature: request.inputSignature,
          originalCandidateHash: request.originalCandidateHash,
          results: request.targets.map((targetId) => ({ targetId, verdict: 'unchanged',
            reason: '合成回执未实质改写失效前提。', replacement: null }))
        } };
      }
      expect(calls).toBe(2);
      expect(turn.allowWebSearch).toBe(false);
      expect(turn.prompt).toContain('REVIEW_REQUEST=');
      expect(turn.prompt).toContain('documented_source_not_proven:claim:neck');
      const request = JSON.parse(turn.prompt.split('REVIEW_REQUEST=')[1]!.split('\nSOURCE_CONTEXT=')[0]!) as { targets: string[] };
      expect(request.targets).toEqual(expect.arrayContaining(['claim:neck', 'action:activity', 'action:routine']));
      return { threadId: 'p04', turnId: 'neck-repair', output: focusedOutputFor(turn.prompt, repaired,
        ['claim:neck', 'action:activity', 'action:routine']) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: clearDiagnosticFields ? 2 : 4 });
    expect(calls).toBe(clearDiagnosticFields ? 2 : 4);
    expect(service.store.getFactRevision(personId)).toBe(beforeRevision);
    expect(service.store.listAcceptedObservations(personId)).toEqual(beforeFacts);
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    if (clearDiagnosticFields) {
      expect(snapshot.heldTargetIds).toEqual([]);
      expect(snapshot.claims.find((claim) => claim.id === 'claim:neck')).toMatchObject({
        kind: 'source_fact', diagnosticStatus: null, diseaseName: null, criteriaBasis: null, text: neckText,
        evidenceIds: neckFact.evidenceIds, materialUncertainty: '影像不能单独确定症状来源。'
      });
      for (const action of repaired.actions.slice(1)) expect(snapshot.actions).toContainEqual(action);
    } else {
      expect(snapshot.heldTargetIds).toEqual(expect.arrayContaining(['claim:neck', 'action:activity', 'action:routine']));
      expect(snapshot.actions.map((action) => action.id)).toEqual(['action-review']);
    }
    service.close();
  });

  it.each([true, false])('四类报告发现与饮食依赖同次P04校正，来源和胃部条件不丢失（完整降级=%s）', async (completeDowngrade) => {
    const { service, personId, built } = await fixtureReportFindings();
    const factFor = (name: string) => built.evidencePackage.facts.find((fact) => fact.originalName === name)!;
    const ldl = factFor('LDL-C');
    const candidate = candidateFor(built.request, { facts: [ldl] });
    const realDiagnosis = { ...candidate.claims[0]!, id: 'claim:documented', topicKey: 'documented-gastric',
      changeAssessment: firstRecordChange(factFor('原报告诊断').evidenceIds),
      kind: 'diagnostic_assessment' as const, diagnosticStatus: 'documented' as const, diseaseName: '慢性胃炎',
      text: '2026-09-21原报告明确记载诊断：慢性胃炎。', evidenceIds: factFor('原报告诊断').evidenceIds,
      temporalStatus: 'historical' as const, rationale: '原文明确给出诊断，不以其他检查所见反推。', materialUncertainty: null };
    candidate.claims.push(realDiagnosis);
    const entries = [
      { id: 'claim:lipids-history', name: 'LDL-C', disease: '高脂血症', text: '2026-09-21 LDL-C 4.2 mmol/L，高于该次报告参考上限 3.4。' },
      { id: 'claim:gastric', name: '内镜检查', disease: '慢性胃炎', text: '2026-09-21内镜所见胃黏膜充血、水肿，未见溃疡；所见需结合症状理解。' },
      { id: 'claim:nasal', name: '鼻腔检查', disease: '鼻炎', text: '2026-09-21鼻腔检查记载黏膜增厚，需结合是否有鼻部症状理解。' },
      { id: 'claim:throat', name: '咽部检查', disease: '慢性咽炎', text: '2026-09-21咽部检查记载充血，所见需结合症状理解。' }
    ];
    for (const item of entries) candidate.claims.push({ ...candidate.claims[0]!, id: item.id, topicKey: item.id,
      changeAssessment: firstRecordChange(factFor(item.name).evidenceIds),
      kind: 'diagnostic_assessment', diagnosticStatus: 'documented', diseaseName: item.disease,
      text: item.text, evidenceIds: factFor(item.name).evidenceIds, temporalStatus: 'historical',
      rationale: '报告明确记载了当时的检查所见。', materialUncertainty: '单项所见不能单独确定病因。' });
    const diet = { ...candidate.actions[0]!, id: 'action:diet', dedupeKey: 'diet-start',
      kind: 'habit' as const, lifestyleDomain: 'diet' as const, lifestyleBasis: 'personalized' as const,
      title: '从日常三餐调整开始', why: '血脂结果可结合日常饮食管理，具体搭配需按身体耐受调整。',
      firstStep: '本周先保留规律三餐，主食一部分换成耐受的粗粮，增加蔬菜并减少高脂零食；胃部有不适时按耐受调整粗粮及刺激性食物，不因检查标签自行长期限制食物。',
      timing: '先试行1–2周。', timingBasis: 'practical_trial' as const, reviewPlan: '回看三餐安排和胃部耐受，不强行坚持诱发不适的食物。',
      caution: '若已有医生饮食限制或食物过敏，按原安排；持续胃部不适需结合临床评估。',
      claimIds: ['claim-ldl', 'claim:lipids-history', 'claim:gastric'],
      evidenceIds: [...ldl.evidenceIds, ...factFor('内镜检查').evidenceIds] };
    candidate.actions.push(diet);
    candidate.overview = { ...candidate.overview, headline: '血脂与其他检查所见可结合症状理解',
      summary: '血脂结果值得按个人背景管理；胃、鼻腔和咽部所见需结合症状理解，饮食先从可耐受的调整开始。',
      claimIds: candidate.claims.map((item) => item.id), actionIds: candidate.actions.map((item) => item.id) };
    const factsBefore = service.store.listAcceptedObservations(personId);
    const repaired = structuredClone(candidate);
    repaired.claims = repaired.claims.map((claim) => entries.some((entry) => entry.id === claim.id)
      ? completeDowngrade ? { ...claim, kind: 'source_fact', diagnosticStatus: null, diseaseName: null,
        criteriaBasis: null, knowledgeBasis: 'not_applicable' } : { ...claim, kind: 'source_fact' } : claim);
    repaired.actions[1]!.why = '报告有血脂结果和胃部内镜所见，饮食可从低风险、可耐受的日常搭配调整开始；不单凭所见确定病因。';
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      if (calls === 1) return { threadId: 'p02', turnId: 'findings', output: candidate };
      if (input.prompt.includes('final_aggregate_summary_required:')) return {
        threadId: 'final-summary', turnId: String(calls), output: unchangedAggregateOutput(input.prompt)
      };
      if (calls === 4) {
        expect(input.prompt).toContain('"recoveryMode":"late_independent_habits"');
        return { threadId: 'late-p03', turnId: 'findings-unchanged', output: assessmentOutputFor(input.prompt, candidate) };
      }
      if (calls === 3) {
        expect(completeDowngrade).toBe(false);
        expect(input.allowWebSearch).toBe(false);
        const request = JSON.parse(input.prompt.split('REPAIR_REQUEST=')[1]!.split('\nSOURCE_CONTEXT=')[0]!) as AssessmentRepairRequestV1;
        expect(request.targets).toContain('action:diet');
        for (const entry of entries) expect(request.targets).toContain(entry.id);
        return { threadId: 'p03', turnId: 'findings-dependent-unchanged', output: {
          schemaVersion: 1, personId: request.personId, inputSignature: request.inputSignature,
          originalCandidateHash: request.originalCandidateHash,
          results: request.targets.map((targetId) => ({ targetId, verdict: 'unchanged',
            reason: '合成回执未实质改写失效前提。', replacement: null }))
        } };
      }
      expect(calls).toBe(2);
      const request = JSON.parse(input.prompt.split('REVIEW_REQUEST=')[1]!.split('\nSOURCE_CONTEXT=')[0]!) as { targets: string[] };
      expect(request.targets).toEqual(expect.arrayContaining([...entries.map((entry) => entry.id), 'action:diet']));
      expect(input.prompt).not.toContain('TARGET_CANDIDATE=');
      const targetNodes = JSON.parse(input.prompt.split('TARGET_NODES=')[1]!) as Array<{ id: string }>;
      expect(targetNodes.map((item) => item.id)).toEqual(request.targets);
      expect(targetNodes.map((item) => item.id)).not.toContain('claim-ldl');
      expect(targetNodes.map((item) => item.id)).toContain('claim:documented');
      expect(input.prompt).toContain('documented_attribution_review:claim:documented');
      return { threadId: 'p04', turnId: 'same-findings', output: focusedOutputFor(input.prompt, repaired,
        [...entries.map((entry) => entry.id), 'action:diet']) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: completeDowngrade ? 2 : 5 });
    expect(calls).toBe(completeDowngrade ? 2 : 5);
    if (result.status !== 'published') throw new Error('SYNTHETIC_ASSESSMENT_NOT_PUBLISHED');
    expect(result.repairDiagnostics ?? []).toHaveLength(completeDowngrade ? 0 : 2);
    if (!completeDowngrade) {
      expect(result.repairDiagnostics?.[1]?.initialIssues).toEqual(['independent_habit_dependency_repair_required:action:diet']);
      expect(result.repairDiagnostics?.[1]?.heldTargetIds).toEqual(['action:diet']);
    }
    if (!completeDowngrade) expect(result.repairDiagnostics?.[0]).toMatchObject({ schemaVerdict: 'accepted', scopeVerdict: 'accepted',
      remainingIssues: entries.flatMap((entry) => [
        `diagnostic_fields_incomplete:${entry.id}`, `documented_source_not_proven:${entry.id}`]) });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims).toContainEqual(realDiagnosis);
    if (completeDowngrade) {
      expect(snapshot.heldTargetIds).toEqual([]);
      expect(snapshot.actions).toContainEqual(repaired.actions[1]);
      expect(snapshot.actions[1]!.firstStep).toBe(diet.firstStep);
      expect(snapshot.actions[1]!.caution).toBe(diet.caution);
      expect(snapshot.actions[1]!.claimIds).toEqual(diet.claimIds);
      expect(snapshot.actions[1]!.evidenceIds).toEqual(diet.evidenceIds);
      for (const item of entries) expect(snapshot.claims.find((claim) => claim.id === item.id)).toMatchObject({
        text: item.text, kind: 'source_fact', diseaseName: null, diagnosticStatus: null,
        evidenceIds: factFor(item.name).evidenceIds, materialUncertainty: '单项所见不能单独确定病因。'
      });
    } else {
      expect(snapshot.heldTargetIds).toEqual(expect.arrayContaining([...entries.map((item) => item.id), 'action:diet']));
      expect(snapshot.actions.some((action) => action.id === 'action:diet')).toBe(false);
      expect(snapshot.claims).toEqual(candidate.claims.slice(0, 2));
    }
    expect(service.store.listAcceptedObservations(personId)).toEqual(factsBefore);
    service.close();
  });

  it('P03 只放开有明确引用的依赖节点，重复行动键也能定位到两个具体行动', async () => {
    const { service, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims.push({ ...candidate.claims[0]!, id: 'claim:other', topicKey: 'other' });
    candidate.actions.push({ ...candidate.actions[0]!, id: 'action:duplicate', claimIds: ['claim:other'] });
    candidate.questions.push({ id: 'question:related', question: '待核对？', whyItMatters: '影响下一步。',
      relatedClaimIds: ['claim-ldl'], evidenceIds: candidate.claims[0]!.evidenceIds });
    expect(new Set(repairTargets(candidate, ['unknown_evidence:claim-ldl:missing']))).toEqual(new Set([
      'claim-ldl', 'action-review', 'question:related', 'overview', ...candidate.systems.map((system) => system.id)
    ]));
    expect(new Set(repairTargets(candidate, ['duplicate_action_key:lipid-risk-context']))).toEqual(new Set([
      'action-review', 'action:duplicate', 'overview', ...candidate.systems.map((system) => system.id)
    ]));
    service.close();
  });

  it('含冒号的节点 ID 仍能精确进入 P03，且不会误选同前缀节点', async () => {
    const { service, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims.push({ ...candidate.claims[0]!, id: 'claim:thyroid-nodule-2022', topicKey: 'thyroid' });
    candidate.claims.push({ ...candidate.claims[0]!, id: 'claim:thyroid', topicKey: 'other' });
    expect(repairTargets(candidate, [
      'documented_source_not_proven:claim:thyroid-nodule-2022',
      'unknown_evidence:claim:thyroid-nodule-2022:missing-evidence'
    ])).toEqual(['claim:thyroid-nodule-2022']);
    expect(repairTargets(candidate, ['unknown_evidence:system:metabolic:missing-evidence'])).toEqual([]);
    service.close();
  });

  it('P03 仍未修好一条主张时只隔离该主张，其余有依据内容继续发布', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims.push({
      ...candidate.claims[0]!, id: 'claim:unverified', topicKey: 'unverified',
      text: '这条判断的来源引用有误。', evidenceIds: ['nonexistent-evidence']
    });
    candidate.overview.claimIds.push('claim:unverified');
    for (const system of candidate.systems) system.claimIds.push('claim:unverified');
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        if (input.prompt.includes('REVIEW_REQUEST=')) return { threadId: 'p04', turnId: 'neutral-system',
          output: focusedOutputFor(input.prompt, candidate) };
        if (calls === 2) expect(input.prompt).toContain('REPAIR_REQUEST=');
        return { threadId: `turn-${calls}`, turnId: `turn-${calls}`, output: assessmentOutputFor(input.prompt, candidate) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 3 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims.map((item) => item.id)).toEqual(['claim-ldl']);
    expect(snapshot.heldTargetIds).toContain('claim:unverified');
    expect(snapshot.overview.claimIds).toEqual(['claim-ldl']);
    expect(snapshot.actions.map((item) => item.id)).toEqual(['action-review']);
    expect(snapshot.overview.summary).not.toContain('已核实');
    service.close();
  });

  it.each(['overview', 'system', 'both'] as const)('%s 无依据高影响汇总只重建摘要，完整保留可靠主张、必要条件和五类独立建议', async (owner) => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0]!.materialUncertainty = '只有这次结果；采血时是否空腹和用药情况未知，不能据此确定原因。';
    candidate.actions.push(...(['diet', 'activity', 'sleep', 'supplements', 'daily_routine'] as const).map((domain) => ({
      ...candidate.actions[0]!, id: `action:habit:${domain}`, dedupeKey: `habit:${domain}`,
      kind: 'habit' as const, lifestyleDomain: domain, lifestyleBasis: 'personalized' as const,
      title: '整理日常习惯', why: '结合现有检查背景，先记录日常习惯以便了解情况。',
      firstStep: '本周记录自己目前的日常安排，下次回看时一并了解。',
      timing: '本周开始', timingBasis: 'practical_trial' as const, reviewPlan: '一周后回看记录。', caution: null
    })));
    for (const node of [candidate.overview, ...candidate.systems]) node.actionIds = candidate.actions.map((action) => action.id);
    const nodes = owner === 'overview' ? [candidate.overview] : owner === 'system' ? [candidate.systems[0]!]
      : [candidate.overview, candidate.systems[0]!];
    for (const node of nodes) {
      node.headline = '已经确诊恶性肿瘤。';
      node.summary = '高度怀疑肺癌。';
      node.limitations = ['本次未散瞳。', '尚不能排除恶性肿瘤。'];
    }
    const candidateBefore = structuredClone(candidate);
    const factsBefore = service.store.listAcceptedObservations(personId);
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      if (input.prompt.includes('REVIEW_REQUEST=')) return { threadId: 'p04', turnId: 'neutral-system',
        output: focusedOutputFor(input.prompt, candidate) };
      if (calls === 2) for (const node of nodes) expect(input.prompt).toContain(`unsupported_high_impact_text:${node.id}`);
      return { threadId: 'synthetic', turnId: String(calls), output: assessmentOutputFor(input.prompt, candidate) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 3,
      inputSignature: built.request.inputSignature, factRevision: built.factRevision,
      contextRevision: built.contextRevision, reviewScopeSignature: built.reviewScopeSignature });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims).toEqual(candidate.claims);
    expect(snapshot.actions).toEqual(candidate.actions);
    expect(snapshot.heldTargetIds).toEqual([]);
    for (const node of nodes) {
      const rebuilt = node.id === 'overview' ? snapshot.overview : snapshot.systems.find((system) => system.id === node.id)!;
      expect(snapshot.presentation?.rebuiltNodeIds).toContain(node.id);
      expect(rebuilt.limitations).toEqual(['本次未散瞳。']);
      expect(rebuilt.summary).toContain(candidate.claims[0]!.text);
      expect(rebuilt.summary).toContain(candidate.claims[0]!.rationale);
      expect(rebuilt.summary).toContain(candidate.claims[0]!.materialUncertainty!);
      expect(rebuilt.headline).not.toMatch(/核实|核对|复核/);
    }
    expect(JSON.stringify([snapshot.overview, ...snapshot.systems, ...snapshot.claims, ...snapshot.actions, ...snapshot.questions]))
      .not.toMatch(/已经确诊恶性肿瘤|高度怀疑肺癌/);
    // 私有 before/after 审计保留被隔离原文，不属于发布给家庭成员的健康正文。
    expect(snapshot.reviewAuditRecords?.records.length).toBeGreaterThan(0);
    expect(candidate).toEqual(candidateBefore);
    expect(service.store.listAcceptedObservations(personId)).toEqual(factsBefore);
    service.close();
  });

  it('无依据高影响汇总与来源和期限错误同时出现时分别隔离，安全主张和独立行动不受牵连', async () => {
    const { service, personId, built } = await fixture(false, true);
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.overview.summary = '已经确诊恶性肿瘤。';
    candidate.systems[0]!.summary = '高度怀疑肺癌。';
    candidate.claims.push({ ...candidate.claims[0]!, id: 'claim:unproven', topicKey: 'unproven',
      kind: 'diagnostic_assessment', diseaseName: '脂质代谢异常', diagnosticStatus: 'documented',
      text: '报告已确诊脂质代谢异常。' });
    candidate.actions.push({ ...candidate.actions[0]!, id: 'action:unproven-plan', dedupeKey: 'unproven-plan',
      kind: 'documented_plan', claimIds: ['claim:unproven'], title: DOCUMENTED_PLAN_NEUTRAL_TITLE,
      firstStep: '立即复查血脂。', timing: '3个月后', timingBasis: 'documented' });
    for (const node of [candidate.overview, ...candidate.systems]) {
      node.claimIds.push('claim:unproven');
      node.actionIds.push('action:unproven-plan');
    }
    const factsBefore = service.store.listAcceptedObservations(personId);
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      if (calls === 2) {
        expect(input.prompt).toContain('REPAIR_REQUEST=');
        expect(input.prompt).toContain('unsupported_high_impact_text:overview');
      }
      if (calls === 3) {
        expect(input.prompt).toContain('REVIEW_REQUEST=');
        expect(input.prompt).toContain('semantic_review:documented_source_not_proven:claim:unproven');
        expect(input.prompt).toContain('semantic_review:documented_plan_timing_not_proven:action:unproven-plan');
        return { threadId: 'p04', turnId: 'mixed-source-issues', output: focusedOutputFor(input.prompt, candidate, [],
          ['claim:unproven', 'action:unproven-plan']) };
      }
      return { threadId: 'synthetic', turnId: String(calls), output: assessmentOutputFor(input.prompt, candidate) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 3 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims).toEqual([candidate.claims[0]]);
    expect(snapshot.actions).toEqual([candidate.actions[0]]);
    expect(snapshot.heldTargetIds).toEqual(expect.arrayContaining(['claim:unproven', 'action:unproven-plan']));
    expect(snapshot.presentation?.rebuiltNodeIds).toEqual(expect.arrayContaining(['overview', candidate.systems[0]!.id]));
    expect(JSON.stringify([snapshot.overview, ...snapshot.systems, ...snapshot.claims, ...snapshot.actions, ...snapshot.questions]))
      .not.toMatch(/已经确诊恶性肿瘤|高度怀疑肺癌|报告已确诊脂质/);
    expect(snapshot.reviewAuditRecords?.records.length).toBeGreaterThan(0);
    expect(service.store.listAcceptedObservations(personId)).toEqual(factsBefore);
    service.close();
  });

  it.each(['action', 'question'] as const)('%s 的无依据高影响断言整条隔离，摘要式 ID 不放行断言或阻止独立结果发布', async (owner) => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    const targetId = owner === 'action' ? 'overview:clinical-action' : `${candidate.systems[0]!.id}:question`;
    candidate.overview.summary = '已经确诊恶性肿瘤。';
    if (owner === 'action') {
      candidate.actions.push({ ...candidate.actions[0]!, id: 'safe-independent-action', dedupeKey: 'safe-independent-action' });
      candidate.actions[0] = { ...candidate.actions[0]!, id: targetId, firstStep: '已经确诊恶性肿瘤。' };
      for (const node of [candidate.overview, ...candidate.systems]) node.actionIds = [targetId, 'safe-independent-action'];
    } else candidate.questions.push({ id: targetId, question: '已经确诊恶性肿瘤，下一步是什么？',
      whyItMatters: '影响后续安排。', relatedClaimIds: ['claim-ldl'], evidenceIds: candidate.claims[0]!.evidenceIds });
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      if (input.prompt.includes('REVIEW_REQUEST=')) return { threadId: 'p04', turnId: 'safe-nodes',
        output: focusedOutputFor(input.prompt, candidate, [], []) };
      return { threadId: 'synthetic', turnId: String(calls), output: assessmentOutputFor(input.prompt, candidate) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'published' });
    expect(calls).toBeLessThanOrEqual(3);
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims).toEqual(candidate.claims);
    expect(snapshot.heldTargetIds).toContain(targetId);
    expect([...snapshot.actions, ...snapshot.questions].some((node) => node.id === targetId)).toBe(false);
    expect(JSON.stringify([snapshot.overview, ...snapshot.systems, ...snapshot.claims, ...snapshot.actions, ...snapshot.questions]))
      .not.toContain('已经确诊恶性肿瘤');
    if (owner === 'question') expect(snapshot.actions).toEqual(candidate.actions);
    service.close();
  });

  it.each(['person', 'scope', 'duplicate'] as const)('摘要例外不掩盖全局 %s 错误', async (error) => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.overview.summary = '已经确诊恶性肿瘤。';
    if (error === 'person') candidate.personId = 'different-member';
    else if (error === 'scope') candidate.requestedSystemIds = [];
    else candidate.claims.push({ ...candidate.claims[0]! });
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      return { threadId: 'synthetic', turnId: String(calls), output: assessmentOutputFor(input.prompt, candidate) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'rejected', callCount: 1 });
    expect(service.store.listMemberAssessmentSnapshots(personId, true)).toEqual([]);
    service.close();
  });

  it('摘要重建后仍对保留的高影响主张执行 P04，不增加额外模型轮次', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0] = { ...candidate.claims[0]!, kind: 'diagnostic_assessment', diagnosticStatus: 'possible',
      diseaseName: '冠心病', text: '仅有这次血脂结果，不能确定冠心病，可能性需结合其他资料评估。',
      materialUncertainty: '没有症状、心电图或其他检查资料，不能据此作出诊断。', consequenceLevel: 'high' };
    candidate.overview.summary = '已经确诊恶性肿瘤。';
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      if (calls <= 2) return { threadId: 'synthetic', turnId: String(calls), output: assessmentOutputFor(input.prompt, candidate) };
      expect(input.prompt).not.toContain('REPAIR_REQUEST=');
      return { threadId: 'p04', turnId: 'focused', output: {
        schemaVersion: 1, personId, inputSignature: candidate.inputSignature,
        results: routeFocusedReview(candidate).targetIds.map((targetId) => ({ targetId, verdict: 'pass',
          reason: '合成复核：保留现有不确定性边界。', replacement: null }))
      } };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 3 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims).toEqual(candidate.claims);
    expect(snapshot.reviewedTargetIds).toContain('claim-ldl');
    expect(snapshot.overview.summary).toContain(candidate.claims[0]!.materialUncertainty!);
    service.close();
  });

  it('普通疾病的确诊标题进入一次 P03，修复仅改变标题且完整保留临床正文条件', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0] = { ...candidate.claims[0]!, title: '已经确诊脂质代谢异常', kind: 'diagnostic_assessment',
      diseaseName: '脂质代谢异常', diagnosticStatus: 'possible',
      text: '这次 LDL-C 高于报告范围，可能与脂质代谢异常有关，但不能仅凭一次结果确定。',
      rationale: '只有一次结果，需结合当次采血条件与其他检查理解。',
      materialUncertainty: '未提供当时用药和空腹情况，不能据此确定原因。' };
    const repaired = structuredClone(candidate);
    repaired.claims[0]!.title = '这次血脂高于报告范围';
    const factsBefore = service.store.listAcceptedObservations(personId);
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        if (input.prompt.includes('REVIEW_REQUEST=')) return { threadId: 'p04', turnId: 'limits',
          output: focusedOutputFor(input.prompt, repaired) };
        if (calls === 2) expect(input.prompt).toContain('diagnostic_title_contradiction:claim-ldl');
        return { threadId: 'synthetic', turnId: String(calls), output: assessmentOutputFor(input.prompt, calls === 1 ? candidate : repaired) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 3 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims[0]).toEqual(repaired.claims[0]);
    expect(snapshot.actions).toEqual(candidate.actions);
    expect(snapshot.heldTargetIds).toEqual([]);
    expect(snapshot.limitations).toEqual([]);
    expect(service.store.listAcceptedObservations(personId)).toEqual(factsBefore);
    service.close();
  });

  it.each(['claim', 'overview', 'system'] as const)('%s 确诊标题修复失败有界隔离，独立结果和报告事实仍保留', async (owner) => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    const diagnostic = { ...candidate.claims[0]!, id: 'claim:diagnostic', topicKey: 'lipid-cause',
      kind: 'diagnostic_assessment' as const, diseaseName: '脂质代谢异常', diagnosticStatus: 'possible' as const,
      text: '这次 LDL-C 偏高，可能与脂质代谢异常有关，但不能仅凭一次结果确定。',
      materialUncertainty: '未提供当时用药和空腹情况。' };
    candidate.claims.push(diagnostic);
    for (const node of [candidate.overview, ...candidate.systems]) node.claimIds.push(diagnostic.id);
    const target = owner === 'claim' ? diagnostic : owner === 'overview' ? candidate.overview : candidate.systems[0]!;
    if ('text' in target) target.title = '已经确诊脂质代谢异常';
    else target.headline = '已经确诊脂质代谢异常';
    const factsBefore = service.store.listAcceptedObservations(personId);
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        if (input.prompt.includes('final_aggregate_summary_required:')) return {
          threadId: 'final-summary', turnId: String(calls), output: unchangedAggregateOutput(input.prompt)
        };
        if (input.prompt.includes('REVIEW_REQUEST=')) return { threadId: 'p04', turnId: 'neutral-system',
          output: focusedOutputFor(input.prompt, candidate) };
        if (calls === 2) expect(input.prompt).toContain('diagnostic_title_contradiction:' + target.id);
        return { threadId: 'synthetic', turnId: String(calls), output: assessmentOutputFor(input.prompt, candidate) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: owner === 'claim' ? 3 : 4 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims[0]).toEqual(candidate.claims[0]);
    expect(snapshot.actions).toEqual(candidate.actions);
    expect(snapshot.claims).toHaveLength(owner === 'claim' ? 1 : 2);
    if (owner === 'claim') expect(snapshot.heldTargetIds).toContain(diagnostic.id);
    else expect(snapshot.presentation?.rebuiltNodeIds).toContain(target.id);
    expect(JSON.stringify([snapshot.overview, ...snapshot.systems, ...snapshot.claims])).not.toContain('已经确诊');
    expect(snapshot.limitations).toEqual([]);
    expect(service.store.listAcceptedObservations(personId)).toEqual(factsBefore);
    service.close();
  });

  it.each(['historical_current_contradiction', 'unknown_normal_contradiction'] as const)(
    '%s 修复失败只隔离错误主张和依赖行动，不改写事实或丢掉独立结果', async (code) => {
      const { service, personId } = await fixture();
      const note = service.createManualNote({ personId, kind: 'free_text', immutableText: '目前没有甲状腺功能检查结果。',
        effectiveDate: '2026-09-22', structuredFields: {}, expectedContextRevision: 0 });
      const built = buildMemberAssessmentInput(service.store, personId, {
        modelId: 'test-model', reasoningEffort: 'medium', analysisReferenceDate: '2026-09-22', webSearchAllowed: true
      });
      const candidate = candidateFor(built.request, built.evidencePackage);
      const id = 'claim:contradiction:thyroid';
      const unknown = code === 'unknown_normal_contradiction';
      candidate.claims.push({ ...candidate.claims[0]!, id, topicKey: 'thyroid-function',
        text: '目前甲状腺功能正常，无需继续关注。', temporalStatus: unknown ? 'uncertain' : 'historical',
        evidenceIds: unknown ? [`note-evidence-${note.id}`] : candidate.claims[0]!.evidenceIds,
        rationale: '这次状态需结合检查资料理解。',
        materialUncertainty: unknown ? '当前甲状腺功能未知，因为缺少这次检查结果。' : '没有当前检查结果。' });
      candidate.actions.push({ ...candidate.actions[0]!, id: 'action:contradiction', dedupeKey: 'contradiction', claimIds: [id] });
      candidate.overview.claimIds.push(id);
      candidate.overview.actionIds.push('action:contradiction');
      for (const system of candidate.systems) {
        system.claimIds.push(id);
        system.actionIds.push('action:contradiction');
      }
      const factsBefore = service.store.listAcceptedObservations(personId);
      let calls = 0;
      const result = await new MemberAssessmentPipeline(service.store, {
        runStructuredTurn: async (input) => {
          calls += 1;
          if (input.prompt.includes('REVIEW_REQUEST=')) return { threadId: 'p04', turnId: 'neutral-system',
            output: focusedOutputFor(input.prompt, candidate) };
          if (calls === 2) {
            expect(input.prompt).toContain(code + ':' + id);
            expect(input.prompt).toContain('node:' + id);
          }
          return { threadId: 'synthetic', turnId: String(calls), output: assessmentOutputFor(input.prompt, candidate) };
        }
      }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
      expect(result).toMatchObject({ status: 'published', callCount: 3 });
      const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
      expect(snapshot.claims.map((item) => item.id)).toEqual(['claim-ldl']);
      expect(snapshot.actions.map((item) => item.id)).toEqual(['action-review']);
      expect(snapshot.heldTargetIds).toEqual(expect.arrayContaining([id, 'action:contradiction']));
      expect(snapshot.overview.headline).toBe('整体情况：1项重点，涉及1个身体系统');
      expect(snapshot.overview.summary).toContain('心血管');
      expect(snapshot.overview.summary).toContain('完整结果、判断依据和检查条件');
      expect(snapshot.claims).toContainEqual(candidate.claims[0]!);
      expect(snapshot.overview.summary).toContain('只有一次结果。');
      expect(snapshot.systems.every((system) => system.status === 'insufficient')).toBe(true);
      expect(service.store.listAcceptedObservations(personId)).toEqual(factsBefore);
      service.close();
    }
  );

  it.each(['overview', 'system'] as const)('只有历史依据的%s修复失败仅重建汇总，合格历史正文仍保留', async (owner) => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0]!.temporalStatus = 'historical';
    candidate.claims[0]!.text = '2026年9月21日当次 LDL-C 4.2 mmol/L，高于报告参考上限。';
    const node = owner === 'overview' ? candidate.overview : candidate.systems[0]!;
    node.summary = '目前血脂正常，无需继续关注。';
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        if (input.prompt.includes('REVIEW_REQUEST=')) return { threadId: 'p04', turnId: 'neutral-system',
          output: focusedOutputFor(input.prompt, candidate) };
        if (calls === 2) expect(input.prompt).toContain('historical_current_contradiction:' + node.id);
        return { threadId: 'synthetic', turnId: String(calls), output: assessmentOutputFor(input.prompt, candidate) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: owner === 'overview' ? 2 : 3 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    const rebuilt = owner === 'overview' ? snapshot.overview : snapshot.systems[0]!;
    expect(snapshot.claims).toEqual(candidate.claims);
    expect(snapshot.actions).toEqual(candidate.actions);
    expect(snapshot.heldTargetIds).toEqual([]);
    expect(snapshot.presentation?.rebuiltNodeIds).toContain(node.id);
    expect(rebuilt.headline).toBe(owner === 'overview' ? '整体情况：1项重点，涉及1个身体系统' : healthClaimTitle(candidate.claims[0]!));
    if (owner === 'overview') {
      expect(rebuilt.summary).toContain('心血管检查结果');
      expect(rebuilt.summary).toContain(candidate.claims[0]!.text);
      expect(rebuilt.summary).toContain(candidate.claims[0]!.rationale);
      expect(rebuilt.summary).toContain('完整结果、判断依据和检查条件');
    } else {
      expect(rebuilt.summary).toContain(candidate.claims[0]!.text);
      expect(rebuilt.summary).toContain(candidate.claims[0]!.rationale);
    }
    for (const limitation of node.limitations) expect(rebuilt.summary).toContain(limitation);
    expect(rebuilt.summary).not.toContain('目前血脂正常');
    service.close();
  });

  it('no_signal仅由明确未知支持时，修复失败只重建系统状态，不删除合格未知主张', async () => {
    const { service, personId } = await fixture();
    const note = service.createManualNote({ personId, kind: 'free_text', immutableText: '目前没有甲状腺功能检查结果。',
      effectiveDate: '2026-09-22', structuredFields: {}, expectedContextRevision: 0 });
    const built = buildMemberAssessmentInput(service.store, personId, {
      modelId: 'test-model', reasoningEffort: 'medium', analysisReferenceDate: '2026-09-22', webSearchAllowed: true
    });
    const candidate = candidateFor(built.request, built.evidencePackage);
    const id = 'claim:thyroid:unknown';
    candidate.claims.push({ ...candidate.claims[0]!, id, topicKey: 'thyroid-function',
      changeAssessment: firstRecordChange([`note-evidence-${note.id}`]),
      text: '当前甲状腺功能尚不能确定。', temporalStatus: 'uncertain', evidenceIds: [`note-evidence-${note.id}`],
      rationale: '缺少这次检查结果，不能据此判断正常或异常。', materialUncertainty: '当前甲状腺功能未知。' });
    const node = candidate.systems.find((system) => system.systemId === 'endocrine_metabolic')!;
    expect(node).toBeDefined();
    node.status = 'no_signal_in_scope';
    node.claimIds = [id];
    node.actionIds = [];
    node.headline = '缺少本次甲状腺功能结果';
    node.summary = '当前甲状腺功能尚不能确定。';
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        if (input.prompt.includes('REVIEW_REQUEST=')) return { threadId: 'p04', turnId: 'limits',
          output: focusedOutputFor(input.prompt, candidate) };
        if (calls === 2) expect(input.prompt).toContain('unknown_normal_contradiction:' + node.id);
        return { threadId: 'synthetic', turnId: String(calls), output: assessmentOutputFor(input.prompt, candidate) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 3 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims).toEqual(candidate.claims);
    expect(snapshot.actions).toEqual(candidate.actions);
    expect(snapshot.systems.find((system) => system.id === node.id)?.status).toBe('insufficient');
    expect(snapshot.heldTargetIds).toEqual([]);
    expect(snapshot.presentation?.rebuiltNodeIds).toContain(node.id);
    service.close();
  });

  it('明确同次已做检查被误写成未做时局部修复，不因资料缺项重跑其他结果', async () => {
    const { service, personId } = await fixture();
    const note = service.createManualNote({ personId, kind: 'free_text', immutableText: '本人于2026-09-22已接受眼科检查。',
      effectiveDate: '2026-09-22', structuredFields: {}, expectedContextRevision: 0 });
    const built = buildMemberAssessmentInput(service.store, personId, {
      modelId: 'test-model', reasoningEffort: 'medium', analysisReferenceDate: '2026-09-22', webSearchAllowed: true
    });
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0]!.evidenceIds.push(`note-evidence-${note.id}`);
    candidate.claims[0]!.materialUncertainty = '本人于2026-09-22未接受眼科检查。';
    const repaired = structuredClone(candidate);
    repaired.claims[0]!.materialUncertainty = '本次资料未提供完整的眼科检查结果。';
    const factsBefore = service.store.listAcceptedObservations(personId);
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        if (input.prompt.includes('REVIEW_REQUEST=')) return { threadId: 'p04', turnId: 'limits',
          output: focusedOutputFor(input.prompt, repaired) };
        if (calls === 2) {
          expect(input.prompt).toContain('missing_exam_scope:claim-ldl:materialUncertainty');
          expect(input.prompt).toContain('node:claim-ldl');
        }
        return { threadId: 'synthetic', turnId: String(calls), output: assessmentOutputFor(input.prompt, calls === 1 ? candidate : repaired) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 3 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims).toEqual(repaired.claims);
    expect(snapshot.actions).toEqual(candidate.actions);
    expect(snapshot.heldTargetIds).toEqual([]);
    expect(service.store.listAcceptedObservations(personId)).toEqual(factsBefore);
    service.close();
  });

  it('同次检查有无矛盾的摘要修复失败只重建摘要，不丢弃已有检查和行动', async () => {
    const { service, personId } = await fixture();
    const note = service.createManualNote({ personId, kind: 'free_text', immutableText: '本人于2026-09-22已接受眼科检查。',
      effectiveDate: '2026-09-22', structuredFields: {}, expectedContextRevision: 0 });
    const built = buildMemberAssessmentInput(service.store, personId, {
      modelId: 'test-model', reasoningEffort: 'medium', analysisReferenceDate: '2026-09-22', webSearchAllowed: true
    });
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0]!.evidenceIds.push(`note-evidence-${note.id}`);
    candidate.overview.summary = '本人于2026-09-22未接受眼科检查。';
    const factsBefore = service.store.listAcceptedObservations(personId);
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        if (calls === 2) expect(input.prompt).toContain('missing_exam_scope:overview:summary');
        return { threadId: 'synthetic', turnId: String(calls), output: assessmentOutputFor(input.prompt, candidate) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims).toEqual(candidate.claims);
    expect(snapshot.actions).toEqual(candidate.actions);
    expect(snapshot.presentation?.rebuiltNodeIds).toContain('overview');
    expect(snapshot.overview.summary).not.toContain('未接受眼科检查');
    expect(service.store.listAcceptedObservations(personId)).toEqual(factsBefore);
    service.close();
  });

  it('P03 越界改写时不接纳改写，只隔离原候选中可定位的问题节点', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims.push({ ...candidate.claims[0]!, id: 'claim-unverified', topicKey: 'unverified',
      evidenceIds: ['nonexistent-evidence'] });
    candidate.overview.claimIds.push('claim-unverified');
    for (const system of candidate.systems) system.claimIds.push('claim-unverified');
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        if (calls === 1) return { threadId: 'p02', turnId: 'first', output: assessmentOutputFor(input.prompt, candidate) };
        if (input.prompt.includes('REVIEW_REQUEST=')) return { threadId: 'p04', turnId: 'neutral-system',
          output: focusedOutputFor(input.prompt, candidate) };
        const outOfScope = structuredClone(candidate);
        outOfScope.claims[0]!.text = '模型越界改写了原本正确的主张。';
        const receipt = assessmentOutputFor(input.prompt, outOfScope) as MemberAssessmentRepairV1;
        receipt.results.push({ targetId: 'claim-ldl', verdict: 'replace', reason: '未授权改写。',
          replacement: { nodeType: 'claim', value: outOfScope.claims[0]! } });
        return { threadId: 'p03', turnId: 'second', output: receipt };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 3,
      repairFailureReasons: ['assessment_repair_target_coverage_mismatch'] });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims).toHaveLength(1);
    expect(snapshot.claims[0]!.text).toBe(candidate.claims[0]!.text);
    expect(snapshot.heldTargetIds).toContain('claim-unverified');
    service.close();
  });

  it('带冒号节点的过程文案精确进入局部修复，原始事实和临床条件不变', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0]!.id = 'claim:lipid:current';
    candidate.claims[0]!.text = '已接纳的 LDL-C 4.2 mmol/L，高于报告参考上限。';
    candidate.claims[0]!.materialUncertainty = '当前用药及症状未提供，不能单凭这一项判断原因。';
    candidate.overview.claimIds = [candidate.claims[0]!.id];
    for (const system of candidate.systems) system.claimIds = [candidate.claims[0]!.id];
    candidate.actions[0]!.claimIds = [candidate.claims[0]!.id];
    const repaired = structuredClone(candidate);
    repaired.claims[0]!.text = 'LDL-C 4.2 mmol/L，高于报告参考上限。';
    const factsBefore = service.store.listAcceptedObservations(personId);
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        if (calls === 1) return { threadId: 'p02', turnId: 'first', output: assessmentOutputFor(input.prompt, candidate) };
        if (input.prompt.includes('REVIEW_REQUEST=')) return { threadId: 'p04', turnId: 'limits',
          output: focusedOutputFor(input.prompt, repaired) };
        expect(input.prompt).toContain('process_narrative:claim:lipid:current:text');
        expect(input.prompt).toContain('node:claim:lipid:current');
        return { threadId: 'p03', turnId: 'second', output: assessmentOutputFor(input.prompt, repaired) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 3 });
    const published = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(published.claims[0]!.text).toBe(repaired.claims[0]!.text);
    expect(published.claims[0]!.materialUncertainty).toBe(candidate.claims[0]!.materialUncertainty);
    expect(published.heldTargetIds).toEqual([]);
    expect(service.store.listAcceptedObservations(personId)).toEqual(factsBefore);
    service.close();
  });

  it('总览过程文案修复失败只重建总览，不丢掉有效主张、不留下 held 的活节点 ID', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.overview.headline = '经模型复核，健康解读已经生成。';
    const factsBefore = service.store.listAcceptedObservations(personId);
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => { calls += 1; return { threadId: 'synthetic', turnId: String(calls), output: assessmentOutputFor(input.prompt, candidate) }; }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    const published = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(published.overview.headline).toBe('整体情况：1项重点，涉及1个身体系统');
    expect(published.overview.summary).toContain(candidate.claims[0]!.text);
    expect(published.overview.summary).toContain('完整结果、判断依据和检查条件');
    expect(published.overview.summary).toContain('只有一次结果。');
    expect(published.heldTargetIds).not.toContain('overview');
    expect(published.presentation?.rebuiltNodeIds).toContain('overview');
    expect(published.claims).toEqual(candidate.claims);
    expect(published.actions).toEqual(candidate.actions);
    expect(service.store.listAcceptedObservations(personId)).toEqual(factsBefore);
    expect(published.overview.summary).not.toMatch(/模型|已接纳|未发布/);
    service.close();
  });

  it('模型自称网址已核验也只能得到应用的 model_cited 状态', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.knowledgeSources.push({ id: 'model-source', title: '模型声称已核验的来源',
      organization: '合成机构', url: 'https://example.org/medical', origin: 'retrieved',
      supports: '模型自称已经打开并核验网页正文' });
    candidate.claims[0]!.knowledgeBasis = 'retrieved';
    candidate.claims[0]!.knowledgeSourceIds = ['model-source'];
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => ({ threadId: 'p02', turnId: 'first', output: assessmentOutputFor(input.prompt, candidate) })
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 1 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.knowledgeVerifications).toEqual([{
      sourceId: 'model-source', status: 'model_cited', checkedAt: null,
      contentHash: null, toolReceiptId: null
    }]);
    expect(service.getMemberAssessment(personId)?.knowledgeVerifications[0]?.status).toBe('model_cited');
    service.close();
  });

  it('模型冒用受控知识 ID 时，标题、网址和支持范围仍以应用目录为准', async () => {
    const { service, built } = await fixture();
    const evidencePackage = structuredClone(built.evidencePackage);
    evidencePackage.knowledge.push({
      id: 'controlled-source', version: 'v1', title: '应用收录的指南', content: '合成受控正文',
      applicability: '合成适用范围', sourceOrganization: '受控机构',
      sourceUrl: 'https://official.example.org/guide', reviewedAt: '2026-09-01',
      supportedScope: '只支持一般说明'
    });
    const candidate = candidateFor(built.request, evidencePackage);
    candidate.knowledgeSources.push({
      id: 'controlled-source', title: '冒名来源', organization: '假机构',
      url: 'https://attacker.example.org/', origin: 'catalog', supports: '已核验可确诊'
    });
    const normalized = canonicalizeAssessmentKnowledge(candidate, evidencePackage);
    expect(normalized.knowledgeSources[0]).toEqual({
      id: 'controlled-source', title: '应用收录的指南', organization: '受控机构',
      url: 'https://official.example.org/guide', origin: 'catalog', supports: '只支持一般说明'
    });
    expect(buildAssessmentKnowledgeVerifications(normalized, evidencePackage)[0]).toMatchObject({
      sourceId: 'controlled-source', status: 'catalog_curated', checkedAt: '2026-09-01', toolReceiptId: null
    });
    service.close();
  });

  it('目录来源网址唯一且完全一致时，纠正临时 ID 并同步引用而不多发 P03', async () => {
    const { service, personId, built } = await fixture();
    const entry = built.evidencePackage.knowledge.find((item) => item.id === 'knowledge-physical-activity-tailoring')!;
    expect(entry).toBeDefined();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.knowledgeSources.push({
      id: 'knowledge-source-physical-activity-tailoring', title: '模型转述标题', organization: '模型转述机构',
      url: entry.sourceUrl, origin: 'catalog', supports: '模型自称的更宽范围'
    });
    candidate.actions[0]!.knowledgeSourceIds = ['knowledge-source-physical-activity-tailoring'];
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        if (calls === 1) return { threadId: 'p02', turnId: 'first', output: assessmentOutputFor(input.prompt, candidate) };
        expect(input.prompt).toContain('knowledgeOnlyTargetIds');
        expect(input.prompt).toContain(entry.content);
        return { threadId: 'p04', turnId: 'second', output: assessmentOutputFor(input.prompt, { schemaVersion: 1, personId,
          inputSignature: built.request.inputSignature, results: [{ targetId: 'action-review', verdict: 'pass',
            reason: '合成来源归属核对通过。', replacement: null }] }) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    expect(calls).toBe(2);
    const snapshot = service.getMemberAssessment(personId)!;
    expect(snapshot.actions[0]?.knowledgeSourceIds).toEqual([entry.id]);
    expect(snapshot.knowledgeSources[0]).toMatchObject({
      id: entry.id, title: entry.title, organization: entry.sourceOrganization,
      url: entry.sourceUrl, supports: entry.supportedScope
    });
    expect(snapshot.knowledgeVerifications[0]).toMatchObject({ sourceId: entry.id, status: 'catalog_curated' });
    service.close();
  });

  it('普通 model_general 无目录引用只生成一次，不额外请求来源核对', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => { calls += 1; return { threadId: 'p02', turnId: 'first', output: assessmentOutputFor(input.prompt, candidate) }; }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 1 });
    expect(calls).toBe(1);
    expect(service.store.listMemberAssessmentSnapshots(personId, true)[0]!.reviewedTargetIds).toEqual([]);
    service.close();
  });

  it('TSH 生理与通用检验边界混合引用只做一次局部 P04，hold 撤引用并保留全部个人解释和行动', async () => {
    const { service, personId, built } = await fixture(false, false, true);
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0]!.topicKey = 'thyroid';
    candidate.claims[0]!.text = 'TSH 是让甲状腺产生激素的调节信号；本次 TSH 6.2 mIU/L，高于报告上限 4.2，单次结果不能确定原因。';
    candidate.claims[0]!.rationale = '需要结合 FT4 和检查条件理解。';
    candidate.claims[0]!.materialUncertainty = '单次结果不能确定原因。';
    candidate.overview.headline = '这次甲状腺检查需要关注';
    candidate.overview.summary = candidate.claims[0]!.text;
    for (const system of candidate.systems) {
      system.headline = 'TSH 高于报告参考上限';
      system.summary = candidate.claims[0]!.text;
    }
    candidate.actions[0]!.title = '整理甲状腺检查资料';
    candidate.actions[0]!.firstStep = '保留本次报告，记录检查时是否用药。';
    const entry = attachCatalogSource(candidate, built.evidencePackage);
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        if (calls === 1) return { threadId: 'p02', turnId: 'first', output: assessmentOutputFor(input.prompt, candidate) };
        expect(input.prompt).toContain('"targets":["claim-ldl"]');
        expect(input.prompt).toContain('"knowledgeOnlyTargetIds":["claim-ldl"]');
        expect(input.prompt).toContain(entry.content);
        expect(input.prompt).toContain(entry.supportedScope);
        expect(input.allowWebSearch).toBe(false);
        return { threadId: 'p04', turnId: 'second', output: assessmentOutputFor(input.prompt, { schemaVersion: 1, personId,
          inputSignature: built.request.inputSignature, results: [{ targetId: 'claim-ldl', verdict: 'hold',
            reason: '通用检验条目不支持 TSH 的生理解释。', replacement: null }] }) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    expect(calls).toBe(2);
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims).toEqual([{ ...candidate.claims[0]!, knowledgeBasis: 'model_general', knowledgeSourceIds: [] }]);
    expect(snapshot.actions).toEqual(candidate.actions);
    expect(snapshot.systems).toEqual(candidate.systems);
    expect(snapshot.overview).toEqual(candidate.overview);
    expect(snapshot.knowledgeSources).toEqual([]);
    expect(snapshot.knowledgeVerifications).toEqual([]);
    expect(snapshot.heldTargetIds).toEqual([]);
    expect(snapshot.reviewedTargetIds).toEqual([]);
    expect(snapshot.validationMode).toBe('local_only');
    expect(snapshot.presentation).toBeUndefined();
    service.close();
  });

  it('受控条目支持完整解释时 pass 保持引用，来源核对不冒充临床复核', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    const entry = attachCatalogSource(candidate, built.evidencePackage);
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        return { threadId: calls === 1 ? 'p02' : 'p04', turnId: String(calls), output: assessmentOutputFor(input.prompt, calls === 1 ? candidate : {
          schemaVersion: 1, personId, inputSignature: built.request.inputSignature,
          results: [{ targetId: 'claim-ldl', verdict: 'pass', reason: '目录正文支持本条检验边界解释。', replacement: null }]
        }) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims).toEqual(candidate.claims);
    expect(snapshot.knowledgeSources).toEqual(candidate.knowledgeSources);
    expect(snapshot.knowledgeVerifications[0]).toMatchObject({ sourceId: entry.id, status: 'catalog_curated' });
    expect(snapshot.reviewedTargetIds).toEqual([]);
    expect(snapshot.validationMode).toBe('local_only');
    service.close();
  });

  it('紧急行动与独立知识目标合并到同一次 P04，临床复核只记录临床范围', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    attachCatalogSource(candidate, built.evidencePackage);
    candidate.actions[0]!.urgency = 'emergency';
    let calls = 0;
    const clinicalTargets = ['action-review', ...candidate.systems.map((system) => system.id), 'overview'];
    const allTargets = [...clinicalTargets, 'claim-ldl'];
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        if (calls === 1) return { threadId: 'p02', turnId: 'first', output: assessmentOutputFor(input.prompt, candidate) };
        expect(input.prompt).toContain('"knowledgeOnlyTargetIds":["claim-ldl"]');
        return { threadId: 'p04', turnId: 'second', output: assessmentOutputFor(input.prompt, { schemaVersion: 1, personId,
          inputSignature: built.request.inputSignature, results: allTargets.map((targetId) => ({ targetId,
            verdict: 'pass', reason: '合成局部核对通过。', replacement: null })) }) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    expect(calls).toBe(2);
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.reviewedTargetIds).toEqual(clinicalTargets);
    expect(snapshot.actions).toEqual(candidate.actions);
    expect(snapshot.validationMode).toBe('local_and_focused_review');
    service.close();
  });

  it('来源专用 replacement 试图改正文、必要条件和执行建议时，拒绝改写并撤下引用', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    const entry = attachCatalogSource(candidate, built.evidencePackage);
    candidate.actions[0]!.knowledgeSourceIds = [entry.id];
    candidate.claims[0]!.materialUncertainty = '单次结果不能确定原因。';
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        if (calls === 1) return { threadId: 'p02', turnId: 'first', output: assessmentOutputFor(input.prompt, candidate) };
        const review: ClinicalFocusedReviewV1 = { schemaVersion: 1, personId, inputSignature: built.request.inputSignature,
          results: [
            { targetId: 'claim-ldl', verdict: 'replace', reason: '越权修改个人解读。', replacement: { nodeType: 'claim',
              value: { ...candidate.claims[0]!, text: 'LDL-C 2.0 mmol/L，已经恢复正常。', materialUncertainty: null } } },
            { targetId: 'action-review', verdict: 'replace', reason: '越权修改执行建议。', replacement: { nodeType: 'action',
              value: { ...candidate.actions[0]!, firstStep: '今天立即自行开始处方药。', timing: '今天', urgency: 'emergency' } } }
          ] };
        return { threadId: 'p04', turnId: 'second', output: assessmentOutputFor(input.prompt, review) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims).toEqual([{ ...candidate.claims[0]!, knowledgeBasis: 'model_general', knowledgeSourceIds: [] }]);
    expect(snapshot.actions).toEqual([{ ...candidate.actions[0]!, knowledgeSourceIds: [] }]);
    expect(snapshot.knowledgeSources).toEqual([]);
    expect(snapshot.heldTargetIds).toEqual([]);
    service.close();
  });

  it('临床目标仅替换知识归属不会触发新增高影响隔离', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    attachCatalogSource(candidate, built.evidencePackage);
    candidate.claims[0]!.consequenceLevel = 'high';
    const replacementId = 'knowledge-dyslipidemia-personalized-context';
    const targets = ['claim-ldl', 'action-review', ...candidate.systems.map((system) => system.id), 'overview'];
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        if (calls === 1) return { threadId: 'p02', turnId: 'first', output: assessmentOutputFor(input.prompt, candidate) };
        expect(input.prompt).toContain('"knowledgeOnlyTargetIds":[]');
        const review: ClinicalFocusedReviewV1 = { schemaVersion: 1, personId, inputSignature: built.request.inputSignature,
          results: targets.map((targetId) => targetId === 'claim-ldl'
            ? { targetId, verdict: 'replace', reason: '只纠正目录归属。', replacement: { nodeType: 'claim',
              value: { ...candidate.claims[0]!, knowledgeSourceIds: [replacementId] } } }
            : { targetId, verdict: 'pass', reason: '临床局部核对通过。', replacement: null }) };
        return { threadId: 'p04', turnId: 'second', output: assessmentOutputFor(input.prompt, review) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims).toEqual([{ ...candidate.claims[0]!, knowledgeSourceIds: [replacementId] }]);
    expect(snapshot.actions).toEqual(candidate.actions);
    expect(snapshot.heldTargetIds).toEqual([]);
    expect(snapshot.knowledgeSources.map((source) => source.id)).toEqual([replacementId]);
    service.close();
  });

  it('临床 hold 移除依赖行动时不破坏独立来源目标，依赖行动始终属于完整临床范围', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0]!.consequenceLevel = 'high';
    candidate.claims.push({ ...candidate.claims[0]!, id: 'claim-knowledge-only', consequenceLevel: 'routine' });
    candidate.overview.claimIds.push('claim-knowledge-only');
    for (const system of candidate.systems) system.claimIds.push('claim-knowledge-only');
    const entry = attachCatalogSource(candidate, built.evidencePackage, 'knowledge-lab-results-context', 'claim-knowledge-only');
    candidate.actions[0]!.knowledgeSourceIds = [entry.id];
    const clinicalTargets = ['claim-ldl', 'action-review', ...candidate.systems.map((system) => system.id), 'overview'];
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        if (calls === 1) return { threadId: 'p02', turnId: 'first', output: assessmentOutputFor(input.prompt, candidate) };
        expect(input.prompt).toContain('"knowledgeOnlyTargetIds":["claim-knowledge-only"]');
        return { threadId: 'p04', turnId: 'second', output: assessmentOutputFor(input.prompt, { schemaVersion: 1, personId,
          inputSignature: built.request.inputSignature,
          results: [...clinicalTargets, 'claim-knowledge-only'].map((targetId) => ({ targetId,
            verdict: targetId === 'claim-ldl' ? 'hold' : 'pass', reason: '合成局部核对。', replacement: null })) }) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims.map((claim) => claim.id)).toEqual(['claim-knowledge-only']);
    expect(snapshot.actions).toEqual([]);
    expect(snapshot.heldTargetIds).toEqual(expect.arrayContaining(['claim-ldl', 'action-review']));
    expect(snapshot.reviewedTargetIds).toEqual(clinicalTargets);
    expect(snapshot.knowledgeSources.map((source) => source.id)).toEqual([entry.id]);
    service.close();
  });

  it('同次P04原文字段证明将单一缺资料断言换成栏目原话，最终快照保留限制字段', async () => {
    const { service, personId, built } = await fixture(false, false, false, undefined, '；检测方式：合成方法');
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0]!.materialUncertainty = '检测方式未提供';
    const replacement = { ...candidate.claims[0]!, materialUncertainty: '检测方式：合成方法' };
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      if (calls === 1) return { threadId: 'p02', turnId: '1', output: assessmentOutputFor(input.prompt, candidate) };
      expect(input.prompt).toContain('evidenceResolutionProofs');
      const request = JSON.parse(input.prompt.split('REVIEW_REQUEST=')[1]!.split('\nSOURCE_CONTEXT=')[0]!) as { targets: string[] };
      return { threadId: 'p04', turnId: '2', output: assessmentOutputFor(input.prompt, {
        schemaVersion: 1, personId, inputSignature: candidate.inputSignature,
        results: request.targets.map((targetId) => targetId === 'claim-ldl' ? {
          targetId, verdict: 'replace', reason: '合成原文证明',
          replacement: { nodeType: 'claim', value: replacement },
          evidenceResolutionProofs: [{ kind: 'missing_information_resolved', evidenceId: replacement.evidenceIds[0],
            uncertaintyText: '检测方式未提供', subject: '检测方式', sourceQuote: '检测方式：合成方法' }]
        } : { targetId, verdict: 'pass', reason: '合成核对', replacement: null })
      }) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims[0]).toEqual(replacement);
    expect(snapshot.heldTargetIds).not.toContain('claim-ldl');
    service.close();
  });

  it.each(['missing', 'duplicate', 'unknown', 'scope'] as const)(
    'P04问句回执%s：只有单纯遗漏可以局部隔离，不能伪造复核通过', async (mutation) => {
      const { service, personId, built } = await fixture();
      const candidate = candidateFor(built.request, built.evidencePackage);
      const question = { id: 'question:synthetic', question: '检查前是否有不适？',
        whyItMatters: '有助于理解既有结果。', relatedClaimIds: ['claim-ldl'], evidenceIds: [] };
      candidate.questions.push(question);
      let calls = 0;
      const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
        calls += 1;
        if (calls === 1) return { threadId: 'p02', turnId: '1', output: assessmentOutputFor(input.prompt, candidate) };
        const receipt = { targetId: question.id, verdict: 'pass', reason: '合成核对', replacement: null };
        return { threadId: 'p04', turnId: '2', output: assessmentOutputFor(input.prompt, {
          schemaVersion: 1, personId: mutation === 'scope' ? 'foreign-person' : personId,
          inputSignature: candidate.inputSignature, results: mutation === 'duplicate' ? [receipt, receipt]
            : mutation === 'unknown' ? [{ ...receipt, targetId: 'unknown' }] : []
        }) };
      } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
      if (mutation === 'missing') {
        expect(result).toMatchObject({ status: 'published', callCount: 2,
          focusedReviewDiagnostics: [{ targetId: question.id, reviewOrigin: 'local_dependency_guard', verdict: 'hold',
            outcome: 'held', boundaryReasonCodes: ['review_receipt_missing'] }] });
        const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
        expect(snapshot.questions).toEqual([]);
        expect(snapshot.claims).toEqual(candidate.claims);
        expect(snapshot.actions).toEqual(candidate.actions);
        expect(snapshot.reviewedTargetIds).not.toContain(question.id);
        const record = snapshot.reviewAuditRecords!.records.find((record) => record.targetId === question.id)!;
        expect(record.modelDecision).toBeNull();
        expect(record.localReasonCodes).toContain('review_receipt_missing');
      } else {
        expect(result.status).toBe('rejected');
        expect(service.store.listMemberAssessmentSnapshots(personId, true)).toEqual([]);
      }
      service.close();
    });

  it('P04漏主张回执时隔离实际依赖，另一独立主张不受牵连', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0]!.consequenceLevel = 'high';
    candidate.claims.push({ ...candidate.claims[0]!, id: 'claim-independent', consequenceLevel: 'routine' });
    candidate.overview.claimIds.push('claim-independent');
    for (const system of candidate.systems) system.claimIds.push('claim-independent');
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, { runStructuredTurn: async (input) => {
      calls += 1;
      if (calls === 1) return { threadId: 'p02', turnId: '1', output: assessmentOutputFor(input.prompt, candidate) };
      const request = JSON.parse(input.prompt.split('REVIEW_REQUEST=')[1]!.split('\nSOURCE_CONTEXT=')[0]!) as { targets: string[] };
      return { threadId: 'p04', turnId: '2', output: assessmentOutputFor(input.prompt, {
        schemaVersion: 1, personId, inputSignature: candidate.inputSignature,
        results: request.targets.filter((id) => id !== 'claim-ldl').map((targetId) => ({
          targetId, verdict: 'pass', reason: '合成核对', replacement: null
        }))
      }) };
    } }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims.map((claim) => claim.id)).toEqual(['claim-independent']);
    expect(snapshot.actions).toEqual([]);
    expect(snapshot.heldTargetIds).toEqual(expect.arrayContaining(['claim-ldl', 'action-review']));
    service.close();
  });

  it('混合范围的P04遗漏知识回执只撤下该知识引用，已核实的临床子集正常发布', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    attachCatalogSource(candidate, built.evidencePackage);
    candidate.actions[0]!.urgency = 'emergency';
    const clinicalTargets = ['action-review', ...candidate.systems.map((system) => system.id), 'overview'];
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        return { threadId: calls === 1 ? 'p02' : 'p04', turnId: String(calls), output: assessmentOutputFor(input.prompt, calls === 1 ? candidate : {
          schemaVersion: 1, personId, inputSignature: built.request.inputSignature,
          results: clinicalTargets.map((targetId) => ({ targetId, verdict: 'pass', reason: '遗漏来源目标。', replacement: null }))
        }) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims[0]!.knowledgeSourceIds).toEqual([]);
    expect(snapshot.claims[0]!.text).toBe(candidate.claims[0]!.text);
    expect(snapshot.actions).toEqual(candidate.actions);
    expect(snapshot.reviewedTargetIds).toEqual(clinicalTargets);
    service.close();
  });

  it.each([true, false])('指南制定的医疗时间有引用=%s 时都做完整临床核对，来源不支持不能只撤引用留下原建议', async (withCatalogReference) => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    if (withCatalogReference) {
      const entry = attachCatalogSource(candidate, built.evidencePackage);
      candidate.claims[0]!.knowledgeBasis = 'model_general';
      candidate.claims[0]!.knowledgeSourceIds = [];
      candidate.actions[0]!.knowledgeSourceIds = [entry.id];
    }
    candidate.actions[0]!.timingBasis = 'guideline';
    candidate.actions[0]!.timing = '3个月内';
    const targets = ['action-review', ...candidate.systems.map((system) => system.id), 'overview'];
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        if (calls === 1) return { threadId: 'p02', turnId: 'first', output: assessmentOutputFor(input.prompt, candidate) };
        expect(input.prompt).toContain('"knowledgeOnlyTargetIds":[]');
        expect(input.prompt).toContain('knowledge_dependent_clinical_review:action-review');
        return { threadId: 'p04', turnId: 'second', output: assessmentOutputFor(input.prompt, { schemaVersion: 1, personId,
          inputSignature: built.request.inputSignature, results: targets.map((targetId) => ({ targetId,
            verdict: targetId === 'action-review' ? 'hold' : 'pass',
            reason: '目录条目不支持制定这个具体医疗时间。', replacement: null })) }) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    expect(calls).toBe(2);
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.actions).toEqual([]);
    expect(snapshot.claims).toEqual(candidate.claims);
    expect(snapshot.overview.actionIds).toEqual([]);
    expect(snapshot.systems.every((system) => system.actionIds.length === 0)).toBe(true);
    expect(snapshot.heldTargetIds).toContain('action-review');
    expect(snapshot.reviewedTargetIds).toEqual(targets);
    expect(snapshot.knowledgeSources).toEqual([]);
    service.close();
  });

  it('criteria_met 无引用仍需完整临床核对并包含依赖行动与汇总，普通习惯起点和已记录医嘱不扩展范围', async () => {
    const { service, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    expect(knowledgeDependentClinicalTargets(candidate)).toEqual([]);
    candidate.actions[0]!.timingBasis = 'practical_trial';
    expect(knowledgeDependentClinicalTargets(candidate)).toEqual([]);
    candidate.actions[0]!.timingBasis = 'documented';
    expect(knowledgeDependentClinicalTargets(candidate)).toEqual([]);
    candidate.claims[0]!.diagnosticStatus = 'criteria_met';
    expect(knowledgeDependentClinicalTargets(candidate)).toEqual(['claim-ldl', 'action-review',
      ...candidate.systems.map((system) => system.id), 'overview']);
    service.close();
  });

  it('新提出的高后果疾病判断即使漏标高影响，也只触发一次重点复核', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0] = {
      ...candidate.claims[0]!, kind: 'diagnostic_assessment', diseaseName: '恶性肿瘤',
      diagnosticStatus: 'possible', text: '这可能提示恶性肿瘤，需要核实。',
      consequenceLevel: 'routine', materialUncertainty: '目前只有一项非特异血脂结果。'
    };
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        if (calls === 1) return { threadId: 'p02', turnId: 'first', output: assessmentOutputFor(input.prompt, candidate) };
        expect(input.prompt).toContain('REVIEW_REQUEST=');
        const targets = [...new Set(['claim-ldl', 'action-review', 'overview', ...built.request.requestedSystemIds.map((id) => `system:${id}`)])];
        const review: ClinicalFocusedReviewV1 = {
          schemaVersion: 1, personId, inputSignature: built.request.inputSignature,
          results: targets.map((targetId) => ({ targetId, verdict: targetId === 'claim-ldl' ? 'hold' : 'pass',
            reason: '单项非特异指标不能支持该高后果疾病判断。', replacement: null }))
        };
        return { threadId: 'p04', turnId: 'second', output: assessmentOutputFor(input.prompt, review) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    expect(calls).toBe(2);
    const published = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(published.claims).toEqual([]);
    expect(published.overview.headline).toBe('整体健康情况');
    expect(published.actions).toEqual([]);
    expect(published.heldTargetIds).toContain('claim-ldl');
    service.close();
  });

  it('当前胸痛的 typed 主张明确包含心肌梗死方向时，汇总无需 P03 修复即可进入一次 P04 独立临床核对', async () => {
    const { service, personId } = await fixture();
    const note = service.createManualNote({ personId, kind: 'free_text',
      immutableText: '2026-09-22 本人现在胸骨后闷痛持续30分钟，伴冷汗和恶心。',
      effectiveDate: '2026-09-22', structuredFields: {}, expectedContextRevision: 0 });
    const built = buildMemberAssessmentInput(service.store, personId, {
      modelId: 'test-model', reasoningEffort: 'medium', analysisReferenceDate: '2026-09-22', webSearchAllowed: true
    });
    const candidate = candidateFor(built.request, built.evidencePackage);
    const evidenceId = `note-evidence-${note.id}`;
    candidate.claims[0] = { ...candidate.claims[0]!, id: 'claim-chest', topicKey: 'current-chest-pain',
      changeAssessment: firstRecordChange([evidenceId]),
      kind: 'diagnostic_assessment', diseaseName: '急性冠脉综合征', diagnosticStatus: 'possible',
      text: '本人当前持续胸痛伴冷汗，需要警惕急性冠脉综合征，包括心肌梗死的可能。',
      evidenceIds: [evidenceId], rationale: '本人描述的持续胸痛与伴随症状需要紧急医学评估。',
      materialUncertainty: '尚无本次心电图或心肌损伤指标，不能据此确诊。' };
    candidate.actions[0] = { ...candidate.actions[0]!, id: 'action-emergency', dedupeKey: 'current-chest-emergency',
      claimIds: ['claim-chest'], kind: 'seek_care', title: '立即寻求急诊帮助',
      why: '持续胸痛伴冷汗需要及时排查，包括心肌梗死的可能。', firstStep: '立即呼叫120，由急救人员安排转运。',
      timing: '现在', urgency: 'emergency', evidenceIds: [evidenceId] };
    candidate.overview = { ...candidate.overview, headline: '当前胸痛需要立即评估',
      summary: '持续胸痛伴冷汗需要及时排查，包括心肌梗死的可能。',
      claimIds: ['claim-chest'], actionIds: ['action-emergency'], limitations: ['现有资料不能确定病因。'] };
    for (const system of candidate.systems) Object.assign(system, {
      headline: candidate.overview.headline, summary: candidate.overview.summary,
      claimIds: ['claim-chest'], actionIds: ['action-emergency']
    });
    let calls = 0;
    const expectedTargets = ['claim-chest', 'action-emergency', ...candidate.systems.map((system) => system.id), 'overview'];
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (turn) => {
        calls += 1;
        if (calls === 1) return { threadId: 'p02', turnId: 'first', output: assessmentOutputFor(turn.prompt, candidate) };
        expect(turn.prompt).toContain('REVIEW_REQUEST=');
        expect(turn.prompt).not.toContain('REPAIR_REQUEST=');
        expect(turn.prompt).toContain(note.immutableText);
        const review: ClinicalFocusedReviewV1 = { schemaVersion: 1, personId, inputSignature: built.request.inputSignature,
          results: expectedTargets.map((targetId) => ({ targetId, verdict: 'pass',
            reason: '当前症状支持紧急排查，诊断仍保留可能状态。', replacement: null })) };
        return { threadId: 'p04', turnId: 'second', output: assessmentOutputFor(turn.prompt, review) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    expect(calls).toBe(2);
    const published = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(published.overview).toEqual(candidate.overview);
    expect(published.claims).toEqual(candidate.claims);
    expect(published.actions).toEqual(candidate.actions);
    expect(published.reviewedTargetIds).toEqual(expectedTargets);
    expect(published.validationMode).toBe('local_and_focused_review');
    service.close();
  });

  it('治疗讨论也不能夹带让本人直接停药的指令，概率不能藏在总览', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.actions[0] = { ...candidate.actions[0]!, kind: 'treatment_discussion', firstStep: '请现在停药。' };
    candidate.overview.summary = '你患癌症风险约 73%。';
    const result = validateAssessmentCandidate(candidate, {
      personId, inputSignature: built.request.inputSignature, mode: built.request.mode,
      requestedSystemIds: built.request.requestedSystemIds,
      evidenceCatalog: built.evidencePackage.evidenceCatalog,
      trendIds: built.evidencePackage.trends.map((item) => item.id),
      catalogKnowledgeIds: built.evidencePackage.knowledge.map((item) => item.id),
      criteriaSets: built.evidencePackage.criteriaSets
    });
    expect(result.issues).toContain('direct_medication_change:action-review');
    expect(result.issues).toContain('unsourced_probability:overview');
    service.close();
  });

  it('禁止自行加量的安全提醒不是让本人加量的指令', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.actions[0] = { ...candidate.actions[0]!, caution: '若活动时胸痛，应停止自行加量并尽快就医评估。' };
    const result = validateAssessmentCandidate(candidate, {
      personId, inputSignature: built.request.inputSignature, mode: built.request.mode,
      requestedSystemIds: built.request.requestedSystemIds,
      evidenceCatalog: built.evidencePackage.evidenceCatalog,
      trendIds: built.evidencePackage.trends.map((item) => item.id),
      catalogKnowledgeIds: built.evidencePackage.knowledge.map((item) => item.id),
      criteriaSets: built.evidencePackage.criteriaSets
    });
    expect(result.issues).not.toContain('direct_medication_change:action-review');
    service.close();
  });

  it('药物变更门禁区分直接指令和否定式安全提醒', async () => {
    const { service, personId, built } = await fixture();
    const input = {
      personId, inputSignature: built.request.inputSignature, mode: built.request.mode,
      requestedSystemIds: built.request.requestedSystemIds,
      evidenceCatalog: built.evidencePackage.evidenceCatalog,
      trendIds: built.evidencePackage.trends.map((item) => item.id),
      catalogKnowledgeIds: built.evidencePackage.knowledge.map((item) => item.id),
      criteriaSets: built.evidencePackage.criteriaSets
    };
    for (const [field, wording, blocked] of [
      ['firstStep', '自行停药即可。', true],
      ['firstStep', '应立即加量。', true],
      ['firstStep', '请勿自行加量，应及时咨询医生。', false],
      ['firstStep', '请整理目前实际用药，以及是否漏服或自行停药，带给医生核对。', false],
      ['caution', '自行停药有风险，请咨询医生。', false]
    ] as const) {
      const candidate = candidateFor(built.request, built.evidencePackage);
      candidate.actions[0] = { ...candidate.actions[0]!, [field]: wording };
      const result = validateAssessmentCandidate(candidate, input);
      expect(result.issues.includes('direct_medication_change:action-review'), wording).toBe(blocked);
    }
    service.close();
  });

  it('明确报告诊断可为 documented；考虑和既往语句不能升级成当前确诊', async () => {
    const { service, personId, built } = await fixture();
    const evidenceId = built.evidencePackage.facts[0]!.evidenceIds[0]!;
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0] = { ...candidate.claims[0]!, kind: 'diagnostic_assessment', diseaseName: '脂肪肝',
      diagnosticStatus: 'documented', text: '2024 年报告明确诊断为脂肪肝。', temporalStatus: 'historical' };
    const input = (quote: string) => ({
      personId, inputSignature: built.request.inputSignature, mode: built.request.mode,
      requestedSystemIds: built.request.requestedSystemIds,
      evidenceCatalog: built.evidencePackage.evidenceCatalog.map((item) => item.id === evidenceId ? { ...item, quote } : item),
      trendIds: [], catalogKnowledgeIds: [], criteriaSets: []
    });
    expect(validateAssessmentCandidate(candidate, input('2024-10-22 诊断：脂肪肝')).issues).not.toContain('documented_source_not_proven:claim-ldl');
    expect(validateAssessmentCandidate(candidate, input('2024-10-22 诊断：考虑脂肪肝')).issues).toContain('documented_source_not_proven:claim-ldl');
    expect(validateAssessmentCandidate(candidate, input('2024-10-22 诊断：排除脂肪肝')).issues).toContain('documented_source_not_proven:claim-ldl');
    expect(validateAssessmentCandidate(candidate, input('2024-10-22 既往诊断：脂肪肝')).issues).not.toContain('documented_source_not_proven:claim-ldl');
    expect(validateAssessmentCandidate(candidate, input('2024-10-22 病史记载既往诊断脂肪肝')).issues).not.toContain('documented_source_not_proven:claim-ldl');
    expect(validateAssessmentCandidate(candidate, input('2024-10-22 既往病理诊断：脂肪肝')).issues).not.toContain('documented_source_not_proven:claim-ldl');
    expect(validateAssessmentCandidate(candidate, input('2024-10-22 病理诊断：脂肪肝，家族史：无特殊')).issues).not.toContain('documented_source_not_proven:claim-ldl');
    expect(validateAssessmentCandidate(candidate, input('2024-10-22 父亲病理诊断：脂肪肝')).issues).toContain('documented_source_not_proven:claim-ldl');
    expect(validateAssessmentCandidate(candidate, input('2024-10-22 既往诊断疑似脂肪肝')).issues).toContain('documented_source_not_proven:claim-ldl');
    candidate.claims[0]!.temporalStatus = 'current';
    expect(validateAssessmentCandidate(candidate, input('2024-10-22 既往诊断：脂肪肝')).issues).toContain('documented_source_not_proven:claim-ldl');
    service.close();
  });

  it('符合标准必须逐项命中应用核验的证据，不能靠模型自报 met', async () => {
    const { service, personId, built } = await fixture();
    const firstEvidence = built.evidencePackage.facts[0]!.evidenceIds[0]!;
    const secondEvidence = 'evidence-independent-confirmation';
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0] = { ...candidate.claims[0]!, kind: 'diagnostic_assessment', diseaseName: '合成疾病X',
      diagnosticStatus: 'criteria_met', text: '现有资料符合合成疾病X的标准。',
      knowledgeBasis: 'catalog', knowledgeSourceIds: ['controlled-criteria'], evidenceIds: [firstEvidence, secondEvidence],
      criteriaBasis: { criteriaSetId: 'synthetic-criteria', sourceId: 'controlled-criteria', applicability: '合成测试适用范围',
        requirements: [
          { criterionId: 'first-result', status: 'met', evidenceIds: [firstEvidence] },
          { criterionId: 'independent-confirmation', status: 'met', evidenceIds: [secondEvidence] }
        ] } };
    const base = {
      personId, inputSignature: built.request.inputSignature, mode: built.request.mode,
      requestedSystemIds: built.request.requestedSystemIds,
      evidenceCatalog: [...built.evidencePackage.evidenceCatalog, {
        ...built.evidencePackage.evidenceCatalog[0]!, id: secondEvidence, quote: '独立复测结果'
      }], trendIds: [], catalogKnowledgeIds: ['controlled-criteria']
    };
    const completeSet = { id: 'synthetic-criteria', sourceId: 'controlled-criteria', applicability: '合成测试适用范围',
      requiredCriterionIds: ['first-result', 'independent-confirmation'],
      verifiedRequirements: [
        { criterionId: 'first-result', evidenceIds: [firstEvidence] },
        { criterionId: 'independent-confirmation', evidenceIds: [secondEvidence] }
      ] };
    expect(validateAssessmentCandidate(candidate, { ...base, criteriaSets: [completeSet] }).issues).not.toContain('criteria_not_proven:claim-ldl');
    expect(validateAssessmentCandidate(candidate, { ...base, criteriaSets: [{
      ...completeSet, verifiedRequirements: completeSet.verifiedRequirements.slice(0, 1)
    }] }).issues).toContain('criteria_not_proven:claim-ldl');
    service.close();
  });

  it.each(['process_text', 'invalid_evidence'] as const)('P04 返回 %s 后P03保留修好结论和原始事实，依赖行动不能借旧回执', async (problem) => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0]!.consequenceLevel = 'high';
    candidate.claims[0]!.materialUncertainty = '用药及症状未提供，不能单凭这一项判断原因。';
    const replacement = { ...candidate.claims[0]!, ...(problem === 'process_text'
      ? { text: `经模型复核，${candidate.claims[0]!.text}` } : { evidenceIds: ['missing-p04-evidence'] }) };
    const review = replaceFocusedClaim(candidate, replacement);
    const factsBefore = service.store.listAcceptedObservations(personId);
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        if (calls === 1) return { threadId: 'p02', turnId: '1', output: assessmentOutputFor(input.prompt, candidate) };
        if (calls === 2) return { threadId: 'p04', turnId: '2', output: assessmentOutputFor(input.prompt, review) };
        expect(calls).toBe(3);
        expect(input.prompt).toContain(problem === 'process_text' ? 'process_narrative:claim-ldl:text' : 'unknown_evidence:claim-ldl');
        expect(input.prompt).toContain('node:claim-ldl');
        expect(input.allowWebSearch).toBe(false);
        return { threadId: 'p03', turnId: '3', output: assessmentOutputFor(input.prompt, candidate) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 3 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims).toEqual(candidate.claims);
    expect(snapshot.actions).toEqual([]);
    expect(snapshot.heldTargetIds).toEqual(['action-review']);
    expect(service.store.listAcceptedObservations(personId)).toEqual(factsBefore);
    service.close();
  });

  it.each([true, false])('P04 新增普通疾病确诊标题后仅允许一次临床P03（修复成功=%s），不靠展示过滤发布', async (repairSucceeds) => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0] = { ...candidate.claims[0]!, kind: 'diagnostic_assessment', diseaseName: '脂质代谢异常',
      diagnosticStatus: 'possible', consequenceLevel: 'high',
      text: '这次 LDL-C 高于报告范围，可能与脂质代谢异常有关，但单次结果不能确诊。',
      materialUncertainty: '用药及空腹情况未提供。' };
    candidate.claims.push({ ...candidate.claims[0]!, id: 'claim:independent', topicKey: 'lipid-source',
      kind: 'source_fact', diseaseName: null, diagnosticStatus: null, consequenceLevel: 'routine',
      text: 'LDL-C 4.2 mmol/L，高于当次报告参考上限。', materialUncertainty: null });
    for (const node of [candidate.overview, ...candidate.systems]) node.claimIds.push('claim:independent');
    const replacement = { ...candidate.claims[0]!, title: '已经确诊脂质代谢异常' };
    const review = replaceFocusedClaim(candidate, replacement);
    const unrepaired = structuredClone(candidate);
    unrepaired.claims[0] = replacement;
    const factsBefore = service.store.listAcceptedObservations(personId);
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        if (input.prompt.includes('final_aggregate_summary_required:')) return {
          threadId: 'final-summary', turnId: String(calls), output: unchangedAggregateOutput(input.prompt)
        };
        expect(calls).toBeLessThanOrEqual(3);
        if (calls === 1) return { threadId: 'p02', turnId: '1', output: assessmentOutputFor(input.prompt, candidate) };
        if (calls === 2) return { threadId: 'p04', turnId: '2', output: assessmentOutputFor(input.prompt, review) };
        expect(input.prompt).toContain('diagnostic_title_contradiction:claim-ldl');
        expect(input.allowWebSearch).toBe(false);
        return { threadId: 'p03', turnId: '3', output: assessmentOutputFor(input.prompt, repairSucceeds ? candidate : unrepaired) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: repairSucceeds ? 4 : 3 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(JSON.stringify([snapshot.overview, ...snapshot.systems, ...snapshot.claims])).not.toContain('已经确诊');
    expect(snapshot.claims.find((claim) => claim.id === 'claim:independent')).toEqual(candidate.claims[1]);
    expect(snapshot.claims.some((claim) => claim.id === 'claim-ldl')).toBe(repairSucceeds);
    expect(snapshot.heldTargetIds.includes('claim-ldl')).toBe(!repairSucceeds);
    expect(snapshot.limitations).toEqual([]);
    expect(service.store.listAcceptedObservations(personId)).toEqual(factsBefore);
    service.close();
  });

  it.each(['new_disease', 'stronger_assertion', 'new_evidence', 'medication', 'emergency'] as const)(
    'P04 后 P03 的 %s 不能借相同目标 ID 或 reason 越过重点复核范围', async (change) => {
      const { service, personId, built } = await fixtureTwoSystems();
      const candidate = candidateFor(built.request, built.evidencePackage);
      candidate.claims[0] = { ...candidate.claims[0]!, consequenceLevel: 'high', kind: 'diagnostic_assessment',
        diseaseName: '急性冠脉综合征', diagnosticStatus: 'possible', text: '需要考虑急性冠脉综合征可能，但现有资料不能确诊。' };
      const review = replaceFocusedClaim(candidate, { ...candidate.claims[0]!,
        rationale: '经模型复核，仍需要结合症状和现有检查。' });
      const repaired = structuredClone(candidate);
      if (change === 'new_disease') Object.assign(repaired.claims[0]!, { diseaseName: '脑卒中', text: '需要考虑脑卒中可能。' });
      if (change === 'stronger_assertion') repaired.claims[0]!.text = '已经确诊急性冠脉综合征。';
      if (change === 'new_evidence') repaired.claims[0]!.evidenceIds = [built.evidencePackage.facts[1]!.evidenceIds[0]!];
      if (change === 'medication') repaired.actions[0]!.firstStep = '立即停用阿司匹林。';
      if (change === 'emergency') Object.assign(repaired.actions[0]!, { urgency: 'emergency', firstStep: '立即拨打120。' });
      const factsBefore = service.store.listAcceptedObservations(personId);
      let calls = 0;
      const result = await new MemberAssessmentPipeline(service.store, {
        runStructuredTurn: async (input) => {
          calls += 1;
          expect(calls).toBeLessThanOrEqual(3);
          return { threadId: 'synthetic', turnId: String(calls), output: assessmentOutputFor(input.prompt, calls === 1 ? candidate : calls === 2 ? review : repaired) };
        }
      }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
      expect(result).toMatchObject({ status: 'published', callCount: 3 });
      const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
      const target = change === 'medication' || change === 'emergency' ? 'action-review' : 'claim-ldl';
      expect(snapshot.heldTargetIds).toContain(target);
      expect([...snapshot.claims, ...snapshot.actions].some((node) => node.id === target)).toBe(false);
      expect(service.store.listAcceptedObservations(personId)).toEqual(factsBefore);
      service.close();
    }
  );

  it.each(['new_catalog', 'changed_catalog', 'changed_text'] as const)(
    'P04 后修复出现 %s 时撤下未重新核对的目录归属，不冒充已有背书', async (change) => {
      const { service, personId, built } = await fixture();
      const candidate = candidateFor(built.request, built.evidencePackage);
      candidate.claims[0]!.consequenceLevel = 'high';
      const entries = built.evidencePackage.knowledge.slice(0, 2);
      expect(entries).toHaveLength(2);
      candidate.knowledgeSources = entries.map((entry) => ({ id: entry.id, title: entry.title,
        organization: entry.sourceOrganization, url: entry.sourceUrl, origin: 'catalog', supports: entry.supportedScope }));
      // 独立且已在本次 P04 范围中的行动保留这两个目录，P03 不需要新增来源节点权限。
      candidate.actions[0]!.claimIds = [];
      candidate.actions[0]!.knowledgeSourceIds = entries.map((entry) => entry.id);
      if (change !== 'new_catalog') {
        candidate.claims[0]!.knowledgeBasis = 'catalog';
        candidate.claims[0]!.knowledgeSourceIds = [entries[0]!.id];
      }
      const reviewedCandidate = structuredClone(candidate);
      reviewedCandidate.claims[0]!.rationale = '经模型复核，报告有对应结果。';
      const repaired = structuredClone(candidate);
      repaired.claims[0]!.knowledgeBasis = 'catalog';
      repaired.claims[0]!.knowledgeSourceIds = [entries[change === 'changed_catalog' ? 1 : 0]!.id];
      if (change === 'changed_text') repaired.claims[0]!.rationale = '单次血脂结果需要结合血压和既往病史理解。';
      let calls = 0;
      const result = await new MemberAssessmentPipeline(service.store, {
        runStructuredTurn: async (input) => {
          calls += 1;
          expect(calls).toBeLessThanOrEqual(3);
          return { threadId: 'synthetic', turnId: String(calls), output: calls === 2
            ? focusedOutputFor(input.prompt, reviewedCandidate, ['claim-ldl'])
            : assessmentOutputFor(input.prompt, calls === 1 ? candidate : repaired) };
        }
      }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
      expect(result).toMatchObject({ status: 'published', callCount: 3 });
      const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
      expect(snapshot.claims[0]).toMatchObject({ text: repaired.claims[0]!.text, knowledgeBasis: 'model_general', knowledgeSourceIds: [] });
      expect(snapshot.actions[0]!.knowledgeSourceIds).toEqual(candidate.actions[0]!.knowledgeSourceIds);
      expect(snapshot.knowledgeVerifications.map((entry) => entry.sourceId)).toEqual(entries.map((entry) => entry.id));
      expect(snapshot.heldTargetIds).toEqual([]);
      service.close();
    }
  );

  it('P02 和 P04 都出现局部错误时全程最多两次 P03，第二次仍失败就隔离而不回滚事实', async () => {
    const { service, personId, built } = await fixture();
    const valid = candidateFor(built.request, built.evidencePackage);
    valid.claims[0]!.consequenceLevel = 'high';
    valid.claims.push({ ...valid.claims[0]!, id: 'claim-retained', consequenceLevel: 'routine', text: '报告给出了血脂结果及参考范围。' });
    valid.overview.claimIds.push('claim-retained');
    valid.systems.forEach((system) => system.claimIds.push('claim-retained'));
    const bad = structuredClone(valid);
    bad.claims[0]!.rationale = '经模型复核，报告中存在对应结果。';
    const review = replaceFocusedClaim(valid, bad.claims[0]!);
    const outputs = [bad, valid, review, bad];
    const factsBefore = service.store.listAcceptedObservations(personId);
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        const output = outputs[calls++];
        expect(calls).toBeLessThanOrEqual(4);
        if (calls === 2 || calls === 4) expect(input.prompt).toContain('REPAIR_REQUEST=');
        return { threadId: 'synthetic', turnId: String(calls), output: assessmentOutputFor(input.prompt, output) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 4 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims.map((claim) => claim.id)).toEqual(['claim-retained']);
    expect(snapshot.heldTargetIds).toContain('claim-ldl');
    expect(service.store.listAcceptedObservations(personId)).toEqual(factsBefore);
    service.close();
  });

  it.each([true, false])('P04 后补救新增指南医疗时间（目录引用=%s）时隔离行动，不能只撤引用留下建议', async (withCatalog) => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0]!.consequenceLevel = 'high';
    if (withCatalog) {
      const entry = built.evidencePackage.knowledge[0]!;
      candidate.knowledgeSources.push({ id: entry.id, title: entry.title, organization: entry.sourceOrganization,
        url: entry.sourceUrl, origin: 'catalog', supports: entry.supportedScope });
      candidate.actions[0]!.knowledgeSourceIds = [entry.id];
    }
    const review = replaceFocusedClaim(candidate, { ...candidate.claims[0]!, rationale: '经模型复核，报告有对应结果。' });
    const repaired = structuredClone(candidate);
    Object.assign(repaired.actions[0]!, { timingBasis: 'guideline', timing: '3个月后复查血脂。' });
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        expect(calls).toBeLessThanOrEqual(3);
        return { threadId: 'synthetic', turnId: String(calls), output: assessmentOutputFor(input.prompt, calls === 1 ? candidate : calls === 2 ? review : repaired) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 3 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.actions).toEqual([]);
    expect(snapshot.heldTargetIds).toContain('action-review');
    expect(snapshot.claims).toEqual(candidate.claims);
    service.close();
  });

  it.each(['person', 'signature', 'systems'] as const)('P04 后 P03 的 %s 越界回执明确拒收，原有局部问题仍隔离且事实不变', async (change) => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0]!.consequenceLevel = 'high';
    const review = replaceFocusedClaim(candidate, { ...candidate.claims[0]!, rationale: '经模型复核，报告有对应结果。' });
    const repaired = structuredClone(candidate);
    if (change === 'person') repaired.personId = 'another-person';
    if (change === 'signature') repaired.inputSignature = 'f'.repeat(64);
    if (change === 'systems') repaired.requestedSystemIds = [];
    const factsBefore = service.store.listAcceptedObservations(personId);
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        const output = assessmentOutputFor(input.prompt, calls === 1 ? candidate : calls === 2 ? review : repaired);
        return { threadId: 'synthetic', turnId: String(calls), output: calls === 3 && change === 'systems'
          ? { ...(output as MemberAssessmentRepairV1), requestedSystemIds: [] } : output };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 3,
      repairFailureReasons: [change === 'systems' ? 'assessment_repair_schema_invalid' : 'assessment_repair_binding_mismatch'] });
    const published = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(published.personId).toBe(personId);
    expect(published.inputSignature).toBe(built.request.inputSignature);
    expect(published.requestedSystemIds).toEqual(built.request.requestedSystemIds);
    expect(published.heldTargetIds).toContain('claim-ldl');
    expect(published.claims).toEqual([]);
    expect(service.store.listAcceptedObservations(personId)).toEqual(factsBefore);
    service.close();
  });

  it('P04 后资料授权发生变化时不得发送补救请求或发布旧范围', async () => {
    const { service, personId, built, documentId } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0]!.consequenceLevel = 'high';
    const review = replaceFocusedClaim(candidate, { ...candidate.claims[0]!, rationale: '经模型复核，报告有对应结果。' });
    let calls = 0;
    await expect(new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        if (calls === 1) return { threadId: 'p02', turnId: '1', output: assessmentOutputFor(input.prompt, candidate) };
        expect(calls).toBe(2);
        service.store.setDocumentIncluded({ documentId, included: false });
        return { threadId: 'p04', turnId: '2', output: assessmentOutputFor(input.prompt, review) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId))
      .rejects.toThrow('MEMBER_ASSESSMENT_FACT_REVISION_CONFLICT');
    expect(calls).toBe(2);
    expect(service.store.listMemberAssessmentSnapshots(personId, true)).toEqual([]);
    service.close();
  });

  it('P04 替换关联行动时引入紧急行动，不再次调用模型而隔离新风险', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0]!.consequenceLevel = 'high';
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        if (calls === 1) return { threadId: 'p02', turnId: 'first', output: assessmentOutputFor(input.prompt, candidate) };
        const targets = ['claim-ldl', 'action-review', 'overview', ...built.request.requestedSystemIds.map((id) => `system:${id}`)];
        const review: ClinicalFocusedReviewV1 = {
          schemaVersion: 1, personId, inputSignature: built.request.inputSignature,
          results: targets.map((targetId) => targetId === 'action-review'
            ? { targetId, verdict: 'replace', reason: '合成测试替换', replacement: {
              nodeType: 'action', value: { ...candidate.actions[0]!, urgency: 'emergency', title: '立即急诊就医' }
            } }
            : { targetId, verdict: 'pass', reason: '无需改动', replacement: null })
        };
        return { threadId: 'p04', turnId: 'second', output: assessmentOutputFor(input.prompt, review) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    expect(calls).toBe(2);
    const published = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(published.heldTargetIds).toContain('action-review');
    expect(published.actions).toEqual([]);
    expect(published.overview.actionIds).toEqual([]);
    service.close();
  });

  it('P04 同范围修正当日症状和 ACS historical→current 后，终态保留当前主张与急救行动', async () => {
    const { service, personId, built, candidate, review, correctedChest, correctedAcs } = await chestReviewFixture();
    const correctedGraph = { ...candidate, claims: candidate.claims.map((claim) => claim.id === correctedAcs.id ? correctedAcs : claim) };
    expect(inspectAssessmentReviewBoundary(candidate, correctedGraph, correctedAcs.id,
      built.evidencePackage.evidenceCatalog, '2026-09-22').reasonCodes).toEqual([]);
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        if (calls === 1) return { threadId: 'p02', turnId: 'first', output: assessmentOutputFor(input.prompt, candidate) };
        expect(input.prompt).toContain('"knowledgeOnlyTargetIds":["claim:ecg"]');
        expect(input.prompt).toContain('2026-09-22');
        return { threadId: 'p04', turnId: 'second', output: assessmentOutputFor(input.prompt, review) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    expect(calls).toBe(2);
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims.find((claim) => claim.id === correctedChest.id)).toEqual(correctedChest);
    expect(snapshot.claims.find((claim) => claim.id === correctedAcs.id)).toEqual(correctedAcs);
    expect(snapshot.actions).toEqual(candidate.actions);
    expect(snapshot.actions[0]!.firstStep).toContain('拨打120');
    expect(snapshot.overview).toEqual(candidate.overview);
    expect(snapshot.questions).toEqual(candidate.questions);
    expect(snapshot.heldTargetIds).toEqual([]);
    expect(snapshot.claims.find((claim) => claim.id === 'claim:ecg')).toMatchObject({
      temporalStatus: 'historical', knowledgeBasis: 'model_general', knowledgeSourceIds: []
    });
    expect(snapshot.knowledgeSources).toEqual([]);
    expect(snapshot.inputSignature).toBe(built.request.inputSignature);
    service.close();
  });

  it('同日完整日期由中文改 ISO 格式不被当作来源数值改变，急救行动仍保留', async () => {
    const { service, personId, candidate, review } = await chestReviewFixture();
    const changedReview: ClinicalFocusedReviewV1 = { ...review, results: review.results.map((result) =>
      result.targetId === 'claim:chest_pain' && result.replacement?.nodeType === 'claim'
        ? { ...result, replacement: { nodeType: 'claim', value: { ...result.replacement.value,
          text: result.replacement.value.text.replace('2026年9月22日', '2026-09-22') } } } : result) };
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => { calls += 1; return { threadId: calls === 1 ? 'p02' : 'p04',
        turnId: String(calls), output: assessmentOutputFor(input.prompt, calls === 1 ? candidate : changedReview) }; }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims.find((claim) => claim.id === 'claim:chest_pain')).toMatchObject({
      temporalStatus: 'current', text: expect.stringContaining('2026-09-22')
    });
    expect(snapshot.actions).toEqual(candidate.actions);
    expect(snapshot.heldTargetIds).toEqual([]);
    service.close();
  });

  it('nT1ck0 同次 P04 删除旧 ECG 反证后，终态保留当日 ACS 可能方向与加强的原急救行动', async () => {
    const { service, personId, built, candidate, review, correctedChest, correctedAcs, correctedAction } = await counterEvidenceReviewFixture();
    const correctedGraph = { ...candidate, claims: candidate.claims.map((claim) => claim.id === correctedAcs.id ? correctedAcs : claim),
      actions: [correctedAction] };
    expect(inspectAssessmentReviewBoundary(candidate, correctedGraph, correctedAcs.id,
      built.evidencePackage.evidenceCatalog, '2026-09-22').reasonCodes).toEqual([]);
    expect(inspectAssessmentReviewBoundary(candidate, correctedGraph, correctedAction.id,
      built.evidencePackage.evidenceCatalog, '2026-09-22').reasonCodes).toEqual([]);
    for (const replacement of review.results.flatMap((result) => result.replacement?.nodeType === 'system' ? [result.replacement.value] : [])) {
      const graph = { ...correctedGraph, systems: candidate.systems.map((system) => system.id === replacement.id ? replacement : system) };
      expect(inspectAssessmentReviewBoundary(candidate, graph, replacement.id,
        built.evidencePackage.evidenceCatalog, '2026-09-22').reasonCodes).toEqual([]);
    }
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => { calls += 1; return { threadId: calls === 1 ? 'p02' : 'p04',
        turnId: String(calls), output: assessmentOutputFor(input.prompt, calls === 1 ? candidate : review) }; }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    expect(calls).toBe(2);
    const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(snapshot.claims.find((claim) => claim.id === correctedChest.id)).toEqual(correctedChest);
    expect(snapshot.claims.find((claim) => claim.id === correctedAcs.id)).toEqual(correctedAcs);
    expect(snapshot.claims.find((claim) => claim.id === 'claim:old_ecg')).toEqual(candidate.claims[2]);
    expect(snapshot.actions).toEqual([correctedAction]);
    expect(snapshot.actions[0]!.firstStep).toContain('立即拨打当地急救电话');
    expect(snapshot.actions[0]!.firstStep).toContain('若症状已缓解但尚未接受评估，也请立即前往急诊');
    expect(snapshot.overview.summary).toContain('即使已经缓解');
    expect(snapshot.systems[0]!.summary).toContain('若已缓解但尚未接受评估');
    expect(snapshot.questions).toEqual(candidate.questions);
    expect(snapshot.heldTargetIds).toEqual([]);
    service.close();
  });

  it.each(['delete_all', 'narrow'] as const)('同次 P04 %s 反证不扩张支持或判断，可保留原临床范围', async (change) => {
    const { service, built, candidate } = await counterEvidenceReviewFixture();
    const after = structuredClone(candidate);
    const claim = after.claims.find((item) => item.id === 'claim:cardiac_cause')!;
    claim.counterEvidenceIds = change === 'delete_all' ? [] : claim.counterEvidenceIds.slice(0, 1);
    expect(focusedReviewBoundaryPreserved(candidate, after, claim.id, built.evidencePackage.evidenceCatalog, '2026-09-22')).toBe(true);
    service.close();
  });

  it.each(['swap_roles', 'add_counter', 'expand_support'] as const)(
    '删除旧反证纠错不能授权 %s，仍隔离 ACS 及依赖行动，最终摘要不能恢复它们', async (change) => {
      const { service, personId, built, candidate, review, correctedAcs } = await counterEvidenceReviewFixture();
      const before = candidate.claims.find((claim) => claim.id === correctedAcs.id)!;
      const replacement = change === 'swap_roles'
        ? { ...correctedAcs, evidenceIds: [...before.counterEvidenceIds], counterEvidenceIds: [...before.evidenceIds] }
        : change === 'add_counter' ? { ...correctedAcs, counterEvidenceIds: [...before.counterEvidenceIds, ...before.evidenceIds] }
          : { ...correctedAcs, evidenceIds: [...before.evidenceIds, ...before.counterEvidenceIds] };
      const after = { ...candidate, claims: candidate.claims.map((claim) => claim.id === before.id ? replacement : claim) };
      expect(focusedReviewBoundaryPreserved(candidate, after, before.id, built.evidencePackage.evidenceCatalog, '2026-09-22')).toBe(false);
      const changedReview: ClinicalFocusedReviewV1 = { ...review, results: review.results.map((result) => result.targetId === before.id
        ? { ...result, replacement: { nodeType: 'claim', value: replacement } } : result) };
      let calls = 0;
      const result = await new MemberAssessmentPipeline(service.store, {
        runStructuredTurn: async (input) => { calls += 1; return { threadId: calls === 1 ? 'p02' : 'p04',
          turnId: String(calls), output: input.prompt.includes('final_aggregate_summary_required:') ? unchangedAggregateOutput(input.prompt)
            : assessmentOutputFor(input.prompt, calls === 1 ? candidate : changedReview) }; }
      }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
      expect(result).toMatchObject({ status: 'published', callCount: 3 });
      expect(calls).toBe(3);
      const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
      expect(snapshot.claims.some((claim) => claim.id === before.id)).toBe(false);
      expect(snapshot.actions).toEqual([]);
      expect(snapshot.heldTargetIds).toContain(before.id);
      expect(snapshot.heldTargetIds).toContain('action:emergency_chest_pain');
      expect(snapshot.claims.find((claim) => claim.id === 'claim:chest_pain')?.temporalStatus).toBe('current');
      service.close();
    }
  );

  it.each(['2026-09-21', '2023-10-08', null])('来源日期为 %s 时不能任意将历史标签改为 current', async (sourceDate) => {
    const { service, built, candidate, correctedAcs } = await chestReviewFixture();
    const after = { ...candidate, claims: candidate.claims.map((claim) => claim.id === correctedAcs.id ? correctedAcs : claim) };
    const sources = built.evidencePackage.evidenceCatalog.map((source) => correctedAcs.evidenceIds.includes(source.id)
      ? { ...source, locator: sourceDate, quote: sourceDate ? `${sourceDate} 本人自述持续胸痛并伴出汗。` : '本人自述持续胸痛并伴出汗。' }
      : source);
    expect(focusedReviewBoundaryPreserved(candidate, after, correctedAcs.id, sources, '2026-09-22')).toBe(false);
    service.close();
  });

  it('同一支持来源同时含历史日期和当日日期时，不能借当日日期将旧情况标成 current', async () => {
    const { service, built, candidate, correctedAcs } = await chestReviewFixture();
    const after = { ...candidate, claims: candidate.claims.map((claim) => claim.id === correctedAcs.id ? correctedAcs : claim) };
    const sources = built.evidencePackage.evidenceCatalog.map((source) => correctedAcs.evidenceIds.includes(source.id)
      ? { ...source, locator: '2026-09-22', quote: '2023-10-08 发生过胸痛；2026-09-22 记录旧情况。' } : source);
    expect(focusedReviewBoundaryPreserved(candidate, after, correctedAcs.id, sources, '2026-09-22')).toBe(false);
    service.close();
  });

  it.each(['stronger_text', 'new_evidence', 'swap_evidence_roles'] as const)(
    '同一 P04 reason 下 %s 仍隔离扩张，不能仅因目标已复核就放行', async (change) => {
      const { service, personId, candidate, review, correctedAcs } = await chestReviewFixture();
      const ecgIds = candidate.claims.find((claim) => claim.id === 'claim:ecg')!.evidenceIds;
      if (change === 'swap_evidence_roles') candidate.claims.find((claim) => claim.id === correctedAcs.id)!.counterEvidenceIds = [...ecgIds];
      const replacement = change === 'stronger_text'
        ? { ...correctedAcs, text: '已经确诊急性冠脉综合征，需立即就医。' }
        : change === 'new_evidence' ? { ...correctedAcs, evidenceIds: [...correctedAcs.evidenceIds, ...ecgIds] }
          : { ...correctedAcs, evidenceIds: [...ecgIds], counterEvidenceIds: [...correctedAcs.evidenceIds] };
      const changedReview: ClinicalFocusedReviewV1 = { ...review, results: review.results.map((result) => result.targetId === correctedAcs.id
        ? { ...result, replacement: { nodeType: 'claim', value: replacement } } : result) };
      let calls = 0;
      const result = await new MemberAssessmentPipeline(service.store, {
        runStructuredTurn: async (input) => { calls += 1; return { threadId: calls === 1 ? 'p02' : 'p04',
          turnId: String(calls), output: input.prompt.includes('final_aggregate_summary_required:') ? unchangedAggregateOutput(input.prompt)
            : assessmentOutputFor(input.prompt, calls === 1 ? candidate : changedReview) }; }
      }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
      expect(result).toMatchObject({ status: 'published', callCount: 3 });
      expect(calls).toBe(3);
      const snapshot = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
      expect(snapshot.claims.some((claim) => claim.id === correctedAcs.id)).toBe(false);
      expect(snapshot.heldTargetIds).toContain(correctedAcs.id);
      expect(snapshot.claims.find((claim) => claim.id === 'claim:chest_pain')?.temporalStatus).toBe('current');
      service.close();
    }
  );

  it('标准依据的新增、来源变化或条件削弱不能作为原范围内的文字更正放行', async () => {
    const { service, built, candidate } = await chestReviewFixture();
    const original = structuredClone(candidate);
    const claim = original.claims.find((item) => item.id === 'claim:acs')!;
    claim.diagnosticStatus = 'criteria_met';
    claim.criteriaBasis = { criteriaSetId: 'synthetic-criteria', sourceId: 'knowledge-lab-results-context',
      applicability: '合成适用条件', requirements: [{ criterionId: 'required', status: 'met', evidenceIds: claim.evidenceIds }] };
    const variations = [null, { ...claim.criteriaBasis, sourceId: 'other-source' },
      { ...claim.criteriaBasis, requirements: [] }, { ...claim.criteriaBasis,
        requirements: [{ ...claim.criteriaBasis.requirements[0]!, status: 'unknown' as const }] }];
    for (const criteriaBasis of variations) {
      const after = structuredClone(original);
      after.claims.find((item) => item.id === claim.id)!.criteriaBasis = criteriaBasis;
      expect(focusedReviewBoundaryPreserved(original, after, claim.id, built.evidencePackage.evidenceCatalog, '2026-09-22')).toBe(false);
    }
    const after = structuredClone(candidate);
    after.claims.find((item) => item.id === claim.id)!.criteriaBasis = claim.criteriaBasis;
    expect(focusedReviewBoundaryPreserved(candidate, after, claim.id, built.evidencePackage.evidenceCatalog, '2026-09-22')).toBe(false);
    service.close();
  });

  it('P04 同一高影响 reason 下替换成另一疾病判断，也隔离未经再次核查的新内容', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0] = { ...candidate.claims[0]!, kind: 'diagnostic_assessment',
      diseaseName: '恶性肿瘤', diagnosticStatus: 'possible', text: '高度怀疑恶性肿瘤。' };
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        if (calls === 1) return { threadId: 'p02', turnId: 'first', output: assessmentOutputFor(input.prompt, candidate) };
        const targets = ['claim-ldl', 'action-review', 'overview',
          ...built.request.requestedSystemIds.map((id) => `system:${id}`)];
        const review: ClinicalFocusedReviewV1 = { schemaVersion: 1, personId,
          inputSignature: built.request.inputSignature,
          results: targets.map((targetId) => targetId === 'claim-ldl'
            ? { targetId, verdict: 'replace', reason: '改写主张', replacement: {
              nodeType: 'claim', value: { ...candidate.claims[0]!, diseaseName: '脑卒中', text: '高度怀疑脑卒中。' }
            } }
            : { targetId, verdict: 'pass', reason: '合成核查', replacement: null }) };
        return { threadId: 'p04', turnId: 'second', output: assessmentOutputFor(input.prompt, review) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    expect(calls).toBe(2);
    const published = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(published.claims).toEqual([]);
    expect(published.heldTargetIds).toContain('claim-ldl');
    service.close();
  });

  it('高影响主张被 hold 后，保留另一条可用解释但不残留原状态和问题', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0]!.consequenceLevel = 'high';
    candidate.claims.push({ ...candidate.claims[0]!, id: 'claim-other', text: '原报告记载 LDL-C 4.2 mmol/L。', consequenceLevel: 'routine' });
    candidate.overview.claimIds.push('claim-other');
    for (const system of candidate.systems) system.claimIds.push('claim-other');
    candidate.questions.push({ id: 'question-dependent', question: '是否需要立即处理这个高风险？',
      whyItMatters: '与被隔离主张相关', relatedClaimIds: ['claim-ldl'],
      evidenceIds: [built.evidencePackage.facts[0]!.evidenceIds[0]!] });
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        if (calls === 1) return { threadId: 'p02', turnId: 'first', output: assessmentOutputFor(input.prompt, candidate) };
        const targets = ['claim-ldl', 'action-review', 'overview', 'question-dependent',
          ...built.request.requestedSystemIds.map((id) => `system:${id}`)];
        const review: ClinicalFocusedReviewV1 = { schemaVersion: 1, personId, inputSignature: built.request.inputSignature,
          results: targets.map((targetId) => ({ targetId, verdict: targetId === 'claim-ldl' ? 'hold' : 'pass',
            reason: '合成测试中只隔离一条主张', replacement: null })) };
        return { threadId: 'p04', turnId: 'second', output: assessmentOutputFor(input.prompt, review) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    const published = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(published.claims.map((item) => item.id)).toEqual(['claim-other']);
    expect(published.systems.every((system) => system.status === 'insufficient')).toBe(true);
    expect(published.presentation?.rebuiltNodeIds).toContain('overview');
    expect(published.questions).toEqual([]);
    expect(published.actions).toEqual([]);
    service.close();
  });

  it('高影响判断被隔离后，带个人来源的用药和检查条件问题仍可发布', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0]!.consequenceLevel = 'high';
    candidate.questions.push({ id: 'question-medication', question: '这次检查时是否正在服药、抽血前是否空腹？',
      whyItMatters: '这些条件会影响检查结果的解释。', relatedClaimIds: ['claim-ldl'],
      evidenceIds: [built.evidencePackage.facts[0]!.evidenceIds[0]!] });
    const independentQuestion = { ...candidate.questions[0]!, relatedClaimIds: [],
      question: '这份报告的采样条件是什么，采样时是否使用药物或空腹？',
      whyItMatters: '了解报告当时的采样背景，便于接诊医生解释这份结果。' };
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        if (calls === 1) return { threadId: 'p02', turnId: 'first', output: assessmentOutputFor(input.prompt, candidate) };
        const targets = ['claim-ldl', 'action-review', 'overview', 'question-medication',
          ...built.request.requestedSystemIds.map((id) => `system:${id}`)];
        return { threadId: 'p04', turnId: 'second', output: assessmentOutputFor(input.prompt, { schemaVersion: 1, personId,
          inputSignature: built.request.inputSignature,
          results: targets.map((targetId) => targetId === 'question-medication'
            ? { targetId, verdict: 'replace', reason: '同次核实为独立问题，原个人来源保留。',
              replacement: { nodeType: 'question', value: independentQuestion } }
            : { targetId, verdict: targetId === 'claim-ldl' ? 'hold' : 'pass',
              reason: '仅保留有可靠依据的内容。', replacement: null }) }) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    const published = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(published.questions).toEqual([independentQuestion]);
    expect(published.overview.headline).toBe('整体健康情况');
    expect(published.limitations).not.toContain('部分判断因数据或依据问题暂未发布。');
    expect(service.getMemberAssessment(personId)?.questions).toEqual(published.questions);
    service.close();
  });

  it('两条高影响主张共享来源和行动时只做一次 P04，并覆盖共同依赖', async () => {
    const { service, personId, built } = await fixture();
    const candidate = candidateFor(built.request, built.evidencePackage);
    candidate.claims[0]!.consequenceLevel = 'high';
    candidate.claims.push({ ...candidate.claims[0]!, id: 'claim-second', text: '另一条待重点复核的高影响判断。' });
    candidate.overview.claimIds.push('claim-second');
    candidate.actions[0]!.claimIds.push('claim-second');
    for (const system of candidate.systems) system.claimIds.push('claim-second');
    let calls = 0;
    const result = await new MemberAssessmentPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        if (calls === 1) return { threadId: 'p02', turnId: 'first', output: assessmentOutputFor(input.prompt, candidate) };
        expect(input.prompt).toContain('claim-ldl');
        expect(input.prompt).toContain('claim-second');
        const targets = ['claim-ldl', 'claim-second', 'action-review', 'overview',
          ...built.request.requestedSystemIds.map((id) => `system:${id}`)];
        const review: ClinicalFocusedReviewV1 = { schemaVersion: 1, personId, inputSignature: built.request.inputSignature,
          results: targets.map((targetId) => ({ targetId, verdict: 'pass', reason: '合成测试中已检查', replacement: null })) };
        return { threadId: 'p04', turnId: 'second', output: assessmentOutputFor(input.prompt, review) };
      }
    }, undefined, undefined, undefined, 'test-model', 'medium', '2026-09-22').process(personId);
    expect(result).toMatchObject({ status: 'published', callCount: 2 });
    expect(calls).toBe(2);
    const published = service.store.listMemberAssessmentSnapshots(personId, true)[0]!;
    expect(published.reviewedTargetIds).toEqual(expect.arrayContaining(['claim-ldl', 'claim-second', 'action-review', 'overview']));
    service.close();
  });
});
