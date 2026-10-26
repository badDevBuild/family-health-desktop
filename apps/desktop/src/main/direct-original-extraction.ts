import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { assembleDirectOriginalReadingRepair, directOriginalReadingRepairSchema, directOriginalReadingResultSchema, observationStructuredSlotEvidence,
  type DirectOriginalReadingResult, type DirectOriginalReadingRepair, type DirectOriginalRepairTarget,
  type ObservationCandidate, type ReportMetadataCandidate, type SourceManifest, type SourceSpan, type ReportReadingAudit } from '@contracts';
import { evaluateDirectOriginalObservationCandidate, diagnoseDirectOriginalObservationCandidate,
  type DirectOriginalCandidateDiagnostic, type DirectOriginalFieldAdmissionReview, isDirectOriginalConditionSourceRole,
  normalizedDirectOriginalAbnormalFlag, projectDirectOriginalCandidateFields, projectDirectOriginalMetadataFields,
  isDirectOriginalHeadingReferenceValid, directOriginalTimeEvidenceProblems, stableHash, validateDirectOriginalExtraction } from '@core';
import { prepareDirectOriginalReport, type PreparedOriginalModelInput } from '@ingestion';
import { accountReportReading, directOriginalSourceRefinementReviewSignature, directOriginalSourceRefinementPartSignature,
  assembleDirectOriginalRefinementParts, type DirectOriginalSourceRefinementReview,
  type DirectOriginalSourceRefinementContext, type DirectOriginalSourceRefinementPlanPart, type DirectOriginalSourceRefinementPart,
  type DirectOriginalAdmissionPreview, type DocumentExtractionBundle, type JobExecutionGuard,
  type PublishFactsInput, type WorkspaceStore } from '@storage';
import type { ExtractionPipelineResult } from './processing-pipeline.js';
import { HEALTH_MODEL_TURN_TIMEOUT_MS } from './ai-runtime-policy.js';
import { ACCEPTANCE_RULES_VERSION, EXTRACTION_PROMPT_VERSION } from './prompts/shared.js';
import { DirectOriginalDateCorrectionPipeline } from './direct-original-date-correction.js';
import { buildDirectOriginalReadPrompt, buildDirectOriginalRepairPrompt,
  buildDirectOriginalRepairPartitionPrompt } from './prompts/direct-original.js';
import { decodeDirectOriginalReading, decodeDirectOriginalRepair,
  directOriginalReadingWireSchema, directOriginalRepairWireSchema,
  directOriginalStructureFailureReason, type DirectOriginalStructureFailureReason } from './direct-original-wire.js';
import { directOriginalNoResultSourceKeys, diagnoseDirectOriginalNoResult,
  isDirectOriginalExplicitNoResult as explicitNoResult } from './direct-original-no-result.js';
import { diagnoseDirectOriginalSubjectSources } from './direct-original-subject-diagnostics.js';
import { originalPreparationScheduler } from './original-preparation-scheduler.js';
import { directOriginalReferenceObligations } from './direct-original-reference-obligations.js';
import { inspectDirectOriginalCoverage } from './direct-original-coverage.js';
import { diagnoseMissingDateBinding } from './direct-original-date-binding.js';
import { assertNoReadOnlyComparisonReferences, buildDirectOriginalRepairComparison } from './direct-original-comparison.js';
import { planDirectOriginalRepairPartitions, type DirectOriginalRepairReadOnlyContext,
  type RepairReadOnlyNode, type RepairPartitionRequest } from './direct-original-repair-partitions.js';

export const DIRECT_ORIGINAL_MODEL_ID = 'gpt-6.1-sol';
/** 共用调度器负责排队和 finally 释放；仅串行化接纳阶段，原件首次模型读取可并行。 */
export type WithSerializedDirectOriginalFinalization = <T>(operation: () => Promise<T>) => Promise<T>;
// 这是完整提示词的本地 UTF-8 传输预算，不是模型 token 上下文上限，
// 也不借用旧 OCR 分块的 source-package 限额。P01/P03 都只检查最终完整请求。
export const DIRECT_ORIGINAL_PROMPT_MAX_BYTES = 256 * 1024;
export function assertDirectOriginalPromptBudget(prompt: string, maxBytes = DIRECT_ORIGINAL_PROMPT_MAX_BYTES): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('DIRECT_ORIGINAL_PROMPT_BUDGET_INVALID');
  if (Buffer.byteLength(prompt, 'utf8') > maxBytes) throw new Error('DIRECT_ORIGINAL_CONTEXT_LIMIT_EXCEEDED');
  return prompt;
}
interface StructuredRuntime {
  runStructuredTurn(input: { prompt: string; imagePaths?: string[]; outputSchema: Record<string, unknown>;
    allowWebSearch?: boolean; timeoutMs?: number }): Promise<{ threadId: string; turnId: string; output: unknown }>;
}
type Receipt = { threadId: string; turnId: string };
const REPAIR_TRANSPORT_ATTEMPT_LIMIT = 3;
const repairRecoverySchema = z.object({
  version: z.literal(1), requestSignature: z.string().regex(/^[a-f0-9]{64}$/u),
  originalReadingHash: z.string().regex(/^[a-f0-9]{64}$/u),
  scopeHistory: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).max(REPAIR_TRANSPORT_ATTEMPT_LIMIT).default([]),
  phase: z.enum(['in_flight', 'transport_unknown', 'response_saved', 'validated', 'exhausted']),
  transportAttempts: z.number().int().min(1).max(REPAIR_TRANSPORT_ATTEMPT_LIMIT),
  response: z.object({ threadId: z.string().min(1), turnId: z.string().min(1), output: z.unknown(),
    transmissionId: z.string().min(1), inputSignature: z.string().regex(/^[a-f0-9]{64}$/u) }).strict().optional(),
  responseHash: z.string().regex(/^[a-f0-9]{64}$/u).optional()
}).strict().superRefine((state, context) => {
  const hasResponse = state.response !== undefined && state.responseHash !== undefined;
  if ((state.response === undefined) !== (state.responseHash === undefined)) {
    context.addIssue({ code: 'custom', message: 'DIRECT_ORIGINAL_REPAIR_RESPONSE_STATE_INVALID' });
  }
  if ((state.phase === 'response_saved') !== hasResponse && state.phase !== 'validated') {
    context.addIssue({ code: 'custom', message: 'DIRECT_ORIGINAL_REPAIR_RESPONSE_STATE_INVALID' });
  }
  if (state.response && stableHash(state.response) !== state.responseHash) {
    context.addIssue({ code: 'custom', message: 'DIRECT_ORIGINAL_REPAIR_RESPONSE_HASH_INVALID' });
  }
});
const repairTargetSchema = z.object({ targetId: z.string().min(1),
  nodeType: z.enum(['candidate', 'excerpt', 'metadata', 'subject', 'page']) }).strict();
const refinementTargetSchema = z.object({ comparisonRecordKey: z.string().min(1), candidateKey: z.string().min(1),
  recordId: z.string().min(1), recordRevision: z.number().int().positive(), recordHash: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
const repairPlanPartSchema = z.object({ index: z.number().int().nonnegative(), targets: z.array(repairTargetSchema),
  refinementTargets: z.array(refinementTargetSchema), promptHash: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
const repairPartSchema = z.object({ index: z.number().int().nonnegative(), repair: directOriginalReadingRepairSchema,
  repairTransmissionId: z.string().min(1), repairInputSignature: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
const partitionRecoverySchema = z.object({ version: z.literal(1), requestSignature: z.string().regex(/^[a-f0-9]{64}$/u),
  originalReadingHash: z.string().regex(/^[a-f0-9]{64}$/u), plan: z.array(repairPlanPartSchema).min(1),
  parts: z.array(z.object({ index: z.number().int().nonnegative(), recovery: repairRecoverySchema.optional() }).strict()).min(1)
}).strict().superRefine((state, context) => {
  if (state.plan.length !== state.parts.length || state.plan.some((part, index) => part.index !== index)
    || state.parts.some((part, index) => part.index !== index)) {
    context.addIssue({ code: 'custom', message: 'DIRECT_ORIGINAL_REPAIR_PARTITION_CHECKPOINT_INVALID' });
  }
});
interface ReadingCheckpoint {
  checkpointKind: 'direct_original_reading';
  reading: DirectOriginalReadingResult;
  receipt: Receipt;
  excerptReceipts: Record<string, Receipt>;
  repairAttempted: boolean;
  repairRecovery?: z.infer<typeof repairRecoverySchema> | undefined;
  repairPartitionRecovery?: z.infer<typeof partitionRecoverySchema> | undefined;
  incompletePageSourceSpanIds: string[];
  firstReading?: DirectOriginalReadingResult | undefined;
  firstTransmissionId?: string | undefined;
  firstInputSignature?: string | undefined;
  sourceRefinementReview?: DirectOriginalSourceRefinementReview | undefined;
  dateCorrectionReview?: { readingHash: string; firstReceipt: Receipt; reviewReceipt: Receipt } | undefined;
}
const receiptSchema = z.object({ threadId: z.string().min(1), turnId: z.string().min(1) }).strict();
const formatRecoveryCheckpointSchema = z.object({ checkpointKind: z.literal('direct_original_format_recovery'),
  attempted: z.literal(true), phase: z.enum(['in_flight', 'busy', 'transport_unknown', 'exhausted']).default('in_flight'),
  transportAttempts: z.number().int().min(0).max(REPAIR_TRANSPORT_ATTEMPT_LIMIT).optional(),
  requestSignature: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  receipt: receiptSchema.nullable(), reason: z.enum([
    'DIRECT_ORIGINAL_STRUCTURE_ENVELOPE_INVALID', 'DIRECT_ORIGINAL_STRUCTURE_WIRE_VERSION_MISMATCH',
    'DIRECT_ORIGINAL_STRUCTURE_WIRE_CONTRACT_MISMATCH', 'DIRECT_ORIGINAL_STRUCTURE_WIRE_PAYLOAD_INVALID',
    'DIRECT_ORIGINAL_STRUCTURE_CANONICAL_SCHEMA_INVALID', 'DIRECT_ORIGINAL_STRUCTURE_DOCUMENT_MISMATCH'
  ]) }).strict();
function isStructuredOutputFailure(error: unknown): boolean {
  return error instanceof Error && ['CODEX_STRUCTURED_OUTPUT_INVALID', 'CODEX_STRUCTURED_OUTPUT_MISSING'].includes(error.message);
}
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const sourceRefinementReviewSchema: z.ZodType<DirectOriginalSourceRefinementReview> = z.object({
  sourceObjectId: z.string().min(1), originalSha256: hashSchema, factRevision: z.number().int().nonnegative(),
  firstReading: directOriginalReadingResultSchema, repair: directOriginalReadingRepairSchema,
  targets: z.array(z.object({ targetId: z.string().min(1),
    nodeType: z.enum(['candidate', 'excerpt', 'metadata', 'subject', 'page']) }).strict()),
  allowedPageSourceSpanIds: z.array(z.string().min(1)),
  refinementTargets: z.array(z.object({ comparisonRecordKey: z.string().min(1), candidateKey: z.string().min(1),
    recordId: z.string().min(1), recordRevision: z.number().int().positive(), recordHash: hashSchema }).strict()),
  firstTransmissionId: z.string().min(1), firstInputSignature: hashSchema,
  repairTransmissionId: z.string().min(1), repairInputSignature: hashSchema,
  repairPlan: z.array(repairPlanPartSchema).optional(), repairParts: z.array(repairPartSchema).optional()
}).strict();
const checkpointSchema: z.ZodType<ReadingCheckpoint> = z.object({ checkpointKind: z.literal('direct_original_reading'),
  reading: directOriginalReadingResultSchema, receipt: receiptSchema,
  excerptReceipts: z.record(z.string(), receiptSchema), repairAttempted: z.boolean(), repairRecovery: repairRecoverySchema.optional(),
  repairPartitionRecovery: partitionRecoverySchema.optional(),
  incompletePageSourceSpanIds: z.array(z.string()).default([]),
  firstReading: directOriginalReadingResultSchema.optional(), firstTransmissionId: z.string().min(1).optional(),
  firstInputSignature: hashSchema.optional(), sourceRefinementReview: sourceRefinementReviewSchema.optional(),
  dateCorrectionReview: z.object({ readingHash: z.string(), firstReceipt: receiptSchema, reviewReceipt: receiptSchema }).strict().optional() }).strict();
const readingOutputSchema = directOriginalReadingWireSchema;
const repairOutputSchema = directOriginalRepairWireSchema;
type RepairOutcome = 'schema_invalid' | 'scope_violation' | 'applied' | 'still_failed' | 'transport_exhausted';
const refKeys = (candidate: ObservationCandidate) => [...candidate.evidence,
  ...(candidate.sourceBinding?.headingEvidence ?? []), ...(candidate.sourceBinding?.findingEvidence ?? []),
  ...observationStructuredSlotEvidence(candidate), ...(candidate.clinicalContext?.conditions ?? [])].map((ref) => ref.sourceSpanId);
/** 补核扩展共同原文后，旧摘录仅在其中唯一定位且实际结果引用落在该段内时算已承载。 */
function excerptRepresentedInExpandedSource(excerpt: DirectOriginalReadingResult['sourceExcerpts'][number],
  reading: DirectOriginalReadingResult): boolean {
  const uniqueStart = (source: string, quote: string): number => {
    const start = quote.length ? source.indexOf(quote) : -1;
    return start >= 0 && source.indexOf(quote, start + 1) < 0 ? start : -1;
  };
  return reading.extraction.candidates.some((candidate) =>
    (candidate.sourceBinding?.findingEvidence ?? candidate.evidence).some((ref) => {
      if (ref.sourceRole === 'duplicate_source') return false;
      const source = reading.sourceExcerpts.find((item) => item.localKey === ref.sourceSpanId);
      if (!source || source.pageSourceSpanId !== excerpt.pageSourceSpanId || source.clarity !== 'clear'
        || !['finding', 'instruction'].includes(source.role)) return false;
      const oldStart = uniqueStart(source.quote, excerpt.quote);
      const result = ref.quote ?? source.quote;
      const resultStart = uniqueStart(source.quote, result);
      return oldStart >= 0 && resultStart >= oldStart && resultStart + result.length <= oldStart + excerpt.quote.length;
    }));
}
const metadataRefs = (metadata: ReportMetadataCandidate | null | undefined): string[] => !metadata ? []
  : [...[metadata.reportKind, metadata.title, metadata.organization, metadata.campus, metadata.department,
    metadata.reportNumber, metadata.encounterIdentifier, ...(metadata.sampleIdentifiers ?? []), ...metadata.examItems]
    .filter((item) => item != null).flatMap((item) => item.evidence), ...metadata.times.flatMap((time) => time.evidence)]
    .map((ref) => ref.sourceSpanId);
const findingKeys = (candidate: ObservationCandidate, reading: DirectOriginalReadingResult): string[] =>
  (candidate.sourceBinding?.findingEvidence ?? candidate.evidence.filter((ref) => reading.sourceExcerpts.some((excerpt) =>
    excerpt.localKey === ref.sourceSpanId && ['finding', 'instruction'].includes(excerpt.role))))
    .map((ref) => ref.sourceSpanId);
const sourceAdmissionRepairCode = (code: string): boolean => code.startsWith('source_binding_')
  || code.startsWith('same_source_finding_') || code.startsWith('direct_original_binding_')
  || code === 'direct_original_finding_quote_not_unique' || code === 'direct_original_heading_quote_not_unique'
  || code === 'direct_original_structured_slot_invalid';

/** 只把明确的日期出处、角色和主要时间选择失败称为日期未证实；其他报告问题保留自身诊断。 */
export function directOriginalDateCorrectionReportHoldReason(reportIssues: readonly string[]):
  'DATE_CORRECTION_REPORT_DATE_UNPROVEN' | 'DATE_CORRECTION_REPORT_VALIDATION_FAILED' {
  return reportIssues.some((issue) => issue === 'report_metadata_date_evidence_unverified'
    || issue === 'report_metadata_date_role_unverified'
    || issue === 'report_metadata_primary_clinical_time_invalid'
    || issue === 'direct_original_primary_clinical_time_required'
    || issue === 'direct_original_primary_clinical_time_invalid')
    ? 'DATE_CORRECTION_REPORT_DATE_UNPROVEN' : 'DATE_CORRECTION_REPORT_VALIDATION_FAILED';
}

/** 目录只告知已有节点，不授权改写；目标主体仍只在 TARGET_ITEMS 中出现一次。 */
export function repairReadOnlyContext(reading: DirectOriginalReadingResult, prepared: PreparedOriginalModelInput,
  targets: DirectOriginalRepairTarget[], preview: DirectOriginalAdmissionPreview | null,
  mappedSourceIds: ReadonlyMap<string, string>): { context: DirectOriginalRepairReadOnlyContext;
    refinementTargets: DirectOriginalSourceRefinementReview['refinementTargets'] } {
  const targetIds = new Set(targets.map((target) => target.targetId));
  const targetPageIds = new Set(targets.filter((target) => target.nodeType === 'page').map((target) => target.targetId));
  const excerptsByKey = new Map(reading.sourceExcerpts.map((excerpt) => [excerpt.localKey, excerpt]));
  const includedCandidates = new Set<string>();
  const entry = <T extends { localKey: string }>(node: T): RepairReadOnlyNode<T> => targetIds.has(node.localKey)
    ? { localKey: node.localKey, access: 'authorized_target', targetId: node.localKey }
    : { localKey: node.localKey, access: 'immutable_non_target', value: node };
  const targetPages = prepared.manifest.spans.filter((span) => targetPageIds.has(span.id)).map((page) => ({
    pageSourceSpanId: page.id,
    candidates: reading.extraction.candidates.filter((candidate) => findingKeys(candidate, reading).some((key) =>
      excerptsByKey.get(key)?.pageSourceSpanId === page.id)).map((candidate) => {
      includedCandidates.add(candidate.localKey);
      return entry(candidate);
    })
  }));
  // 必要引用闭包跨页保留日期、栏目和检查条件，不展开其他页的无关候选或摘录。
  const referencedKeys = new Set(reading.extraction.candidates.filter((candidate) => includedCandidates.has(candidate.localKey)
    || targets.some((target) => target.nodeType === 'candidate' && target.targetId === candidate.localKey)).flatMap(refKeys));
  for (const target of targets) {
    if (target.nodeType === 'excerpt') referencedKeys.add(target.targetId);
    if (target.nodeType === 'page') for (const item of reading.pageReadings.find((page) => page.sourceSpanId === target.targetId)?.resultInventory ?? []) {
      referencedKeys.add(item.sourceSpanId);
      for (const ref of item.classification?.evidence ?? []) referencedKeys.add(ref.sourceSpanId);
      if (item.classification?.duplicateSourceSpanId) referencedKeys.add(item.classification.duplicateSourceSpanId);
    }
    if (target.nodeType === 'metadata') for (const key of metadataRefs(reading.extraction.reportMetadata)) referencedKeys.add(key);
    if (target.nodeType === 'subject') for (const ref of reading.extraction.subject.evidence) referencedKeys.add(ref.sourceSpanId);
  }
  const comparison = buildDirectOriginalRepairComparison({ reading, originalSha256: prepared.originalSha256,
    sourceObjectId: prepared.manifest.sourceObjectId, targets, mappedSourceIds, preview,
    reservedLocalKeys: [...new Set([...prepared.manifest.spans.map((span) => span.id),
      ...reading.pageReadings.map((page) => page.sourceSpanId), ...reading.sourceExcerpts.map((excerpt) => excerpt.localKey),
      ...reading.extraction.candidates.map((candidate) => candidate.localKey), 'subject', 'metadata'])] });
  return { context: { schemaVersion: 1, targetPages,
    referencedExcerpts: reading.sourceExcerpts.filter((excerpt) => referencedKeys.has(excerpt.localKey)).map(entry),
    // 所有原页和既有短key都保留占位，含目录外的节点；新补漏不能撞上不可见的非目标。
    ...comparison.context }, refinementTargets: comparison.refinementTargets };
}

/** 这里只映射应用分配的来源ID，不变更数值、单位、日期、原文或临床条件。 */
function mapSourceIds<T>(value: T, ids: Map<string, string>): T {
  if (Array.isArray(value)) return value.map((item) => mapSourceIds(item, ids)) as T;
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    key === 'sourceSpanId' && typeof item === 'string' ? ids.get(item) ?? item : mapSourceIds(item, ids)])) as T;
}

function materialize(reading: DirectOriginalReadingResult, prepared: PreparedOriginalModelInput,
  current: SourceManifest, excerptReceipts: Record<string, Receipt>) {
  const parents = new Map(prepared.manifest.spans.map((span) => [span.id, span]));
  const inputKinds = new Map(prepared.unitMappings.map((unit) => [unit.sourceSpanId, unit.inputKind]));
  const ids = new Map<string, string>();
  const excerpts = reading.sourceExcerpts.map((excerpt): SourceSpan => {
    const parent = parents.get(excerpt.pageSourceSpanId);
    const receipt = excerptReceipts[excerpt.localKey];
    if (!parent || !receipt || !inputKinds.has(parent.id)) throw new Error('DIRECT_ORIGINAL_EXCERPT_SCOPE_INVALID');
    const id = `model-original-${stableHash({ documentId: reading.documentId, originalSha256: prepared.originalSha256,
      parentId: parent.id, localKey: excerpt.localKey, receipt, quote: excerpt.quote, role: excerpt.role }).slice(0, 40)}`;
    ids.set(excerpt.localKey, id);
    return { id, documentId: reading.documentId, spanKind: 'block', page: parent.page,
      blockId: `model-original-excerpt:${parent.id}`, lineStart: null, lineEnd: null, quote: excerpt.quote,
      readability: excerpt.clarity === 'clear' ? 'clear' : 'partial', modelEvidence: {
        version: 1, engine: 'codex-original-reading-v1', modelId: DIRECT_ORIGINAL_MODEL_ID,
        ...receipt, originalSha256: prepared.originalSha256, originalSourceObjectId: prepared.manifest.sourceObjectId,
        parentSourceSpanId: parent.id, inputKind: inputKinds.get(parent.id)!, role: excerpt.role, clarity: excerpt.clarity } };
  });
  const spans = [...current.spans];
  for (const excerpt of excerpts) if (!spans.some((span) => span.id === excerpt.id)) spans.push(excerpt);
  return { manifest: { ...current, spans }, extraction: mapSourceIds(reading.extraction, ids), ids };
}

function normalizedName(name: string): string { return name.normalize('NFKC').replace(/[\s·•・]/gu, '').toLocaleLowerCase('zh-CN'); }
function userAssignedSubject(bundle: DocumentExtractionBundle): boolean {
  return bundle.personAssignmentBasis === 'user_selected' || bundle.personAssignmentBasis === 'identity_confirmed';
}
/** 原件身份识别与成员归属分开保留，明确选择成员不能成为模型抄写姓名的答案。 */
function reportedIdentityState(reading: DirectOriginalReadingResult, bundle: DocumentExtractionBundle): 'trusted' | 'conflict' | 'unproven' {
  const subject = reading.extraction.subject;
  if (subject.confidence === 'uncertain') return 'unproven';
  if (subject.confidence === 'absent') return 'unproven';
  if (!subject.reportedName || !subject.evidence.length) return 'unproven';
  const refs = subject.evidence.map((ref) => reading.sourceExcerpts.find((excerpt) => excerpt.localKey === ref.sourceSpanId));
  // 模型负责识别患者与工作人员角色，程序不凭“审核”关键词掩盖明确异名。
  if (refs.some((ref) => !ref || ref.clarity !== 'clear' || ref.role !== 'identity')) return 'unproven';
  const accepted = [bundle.personDisplayName, bundle.confirmedReportedName, ...bundle.confirmedPersonAliases]
    .filter((name): name is string => Boolean(name)).map(normalizedName);
  return accepted.includes(normalizedName(subject.reportedName)) ? 'trusted' : 'conflict';
}
function identityState(reading: DirectOriginalReadingResult, bundle: DocumentExtractionBundle): 'trusted' | 'conflict' | 'unproven' {
  if (userAssignedSubject(bundle)) return 'trusted';
  if (reading.extraction.subject.confidence === 'absent' && bundle.personAssignmentBasis === 'folder_binding') return 'trusted';
  return reportedIdentityState(reading, bundle);
}

function observation(candidate: ObservationCandidate, acceptanceId: string, documentId: string,
  manifest: SourceManifest): PublishFactsInput['observations'][number] {
  // 栏目、发现和解释条件都是模型明示的来源；正式记录汇合完整引用，不要求在 evidence 中重复填写。
  // 按完整引用去重，不能因同一来源ID就丢掉不同引文、重复来源角色或重复依据。
  const references: ObservationCandidate['evidence'] = [...candidate.evidence, ...(candidate.sourceBinding?.headingEvidence ?? []),
    ...(candidate.sourceBinding?.findingEvidence ?? []), ...observationStructuredSlotEvidence(candidate), ...(candidate.clinicalContext?.conditions ?? [])];
  const evidence = [...new Map(references.map((ref) => [stableHash({ sourceSpanId: ref.sourceSpanId,
      quote: ref.quote, sourceRole: ref.sourceRole, duplicateBasis: ref.duplicateBasis }), ref])).values()];
  // 主来源必须是已核验的结果/医生原话，不按general evidence的数组顺序选标题或日期。
  const primary = (candidate.sourceBinding?.findingEvidence ?? candidate.evidence).find((ref) =>
    ref.sourceRole !== 'duplicate_source' && manifest.spans.some((span) => span.id === ref.sourceSpanId
      && span.modelEvidence && ['finding', 'instruction'].includes(span.modelEvidence.role)));
  if (!primary) throw new Error('DIRECT_ORIGINAL_PRIMARY_FINDING_REQUIRED');
  const abnormalFlag = normalizedDirectOriginalAbnormalFlag(candidate.reportedAbnormalFlag) ?? 'unknown';
  return { conceptKey: candidate.originalName, originalName: candidate.originalName,
    modelStandardNameCandidate: candidate.standardNameCandidate, rawText: candidate.value.rawText ?? '',
    valueKind: candidate.value.kind, decimalValue: candidate.value.kind === 'numeric' ? candidate.value.decimal : null,
    qualifier: candidate.value.kind === 'numeric' ? candidate.value.comparator
      : candidate.value.kind === 'qualitative' ? candidate.value.category : null,
    unit: candidate.unitRaw, referenceRange: candidate.referenceRangeRaw, clinicalDate: candidate.clinicalDate,
    abnormalFlag, documentId, sourceSpanId: primary.sourceSpanId, acceptanceId,
    specimen: candidate.specimen, method: candidate.method, bodySite: candidate.bodySite,
    clinicalContext: candidate.clinicalContext ?? null, evidence,
    sourceBinding: candidate.sourceBinding, candidate };
}

/** 所有原页一次直读，格式异常至多恢复一次，内容至多定点修复一次。 */
export class DirectOriginalExtractionPipeline {
  constructor(private readonly store: WorkspaceStore, private readonly runtime: StructuredRuntime,
    private readonly executionGuard?: JobExecutionGuard,
    private readonly options: { prepareOriginal?: typeof prepareDirectOriginalReport; maxContextBytes?: number;
      withSerializedFinalization?: WithSerializedDirectOriginalFinalization } = {}) {}

  private guard(documentId: string): JobExecutionGuard {
    if (!this.executionGuard) throw new Error('DIRECT_ORIGINAL_EXECUTION_GUARD_REQUIRED');
    // 生命周期门禁必须先于任何 SQLite 读取；旧工作区的迟到回调不能靠数据库报错来停止。
    if (!this.store.isOpen()) throw new Error('WORKSPACE_CLOSED');
    this.store.assertJobExecutionActive(this.executionGuard, documentId);
    this.store.getJobReportSupplementScope(this.executionGuard, documentId);
    return this.executionGuard;
  }

  private async finalize(documentId: string, operation: () => Promise<ExtractionPipelineResult>): Promise<ExtractionPipelineResult> {
    const guarded = async () => {
      // 等待同成员前一份接纳期间任务可能被取消；拿到锁后必须重新检查，不能继续发送 P03 或保存结果。
      this.guard(documentId);
      return operation();
    };
    return this.options.withSerializedFinalization ? this.options.withSerializedFinalization(guarded) : guarded();
  }

  private async runTurn(documentId: string, stage: string, input: Parameters<StructuredRuntime['runStructuredTurn']>[0],
    signatureOverride?: string) {
    const guard = this.guard(documentId);
    const transmissionId = this.store.beginAiTransmission({ guard, documentId, stage });
    const inputSignature = signatureOverride ?? stableHash(input);
    let transmissionFinished = false;
    try {
      const result = await this.runtime.runStructuredTurn(input);
      this.guard(documentId);
      receiptSchema.parse({ threadId: result.threadId, turnId: result.turnId });
      let canonical: DirectOriginalReadingResult | ReturnType<typeof decodeDirectOriginalRepair> | undefined;
      try { canonical = stage === 'repair_extraction' ? decodeDirectOriginalRepair(result.output) : decodeDirectOriginalReading(result.output); }
      catch { /* 不合法回包保留正常传输状态，但不能产生来源补齐证明。 */ }
      if (canonical) this.store.finishDirectOriginalTransmission({ guard, documentId, transmissionId, inputSignature,
        outputHash: stableHash(canonical), threadId: result.threadId, turnId: result.turnId,
        proofVersion: 'direct-original-source-refinement-v1' });
      else this.store.finishAiTransmission(transmissionId, 'completed');
      transmissionFinished = true;
      return { ...result, transmissionId, inputSignature };
    } catch (error) {
      // 守住原始失败；传输已关闭或清理本身失败时，不用二次关闭异常掩盖原因。
      if (!transmissionFinished && this.store.isOpen()) try {
        this.guard(documentId);
        this.store.finishAiTransmission(transmissionId, 'unknown');
      } catch { /* 撤权或执行已失效时保留旧未知回执，原始异常继续上抛。 */ }
      throw error;
    }
  }

  private validate(reading: DirectOriginalReadingResult, prepared: PreparedOriginalModelInput,
    bundle: DocumentExtractionBundle, receipts: Record<string, Receipt>, incompletePageSourceSpanIds: string[] = [],
    sourceRefinementReview?: DirectOriginalSourceRefinementReview) {
    const userAssigned = userAssignedSubject(bundle);
    const pageIds = new Set(prepared.manifest.spans.map((span) => span.id));
    const pageErrors = reading.pageReadings.filter((page) => !pageIds.has(page.sourceSpanId))
      .map(() => 'direct_original_page_unknown');
    if (reading.sourceExcerpts.some((excerpt) => !pageIds.has(excerpt.pageSourceSpanId))) {
      pageErrors.push('direct_original_excerpt_page_unknown');
      return { state: 'unproven' as const, userAssigned, reportIssues: pageErrors,
        candidateFailures: reading.extraction.candidates.map((candidate) => ({ candidate, reasons: pageErrors })),
        validationDiagnostics: [] as DirectOriginalCandidateDiagnostic[],
        gapPageIds: [...pageIds], unrepresentedSourceCount: 0, unrepresentedSourceKeys: [] as string[],
        mapped: null, admissionPreview: null, fieldReviews: [] as DirectOriginalFieldAdmissionReview[],
        originalMappedExtraction: null };
    }
    const mapped = materialize(reading, prepared, bundle.manifest, receipts);
    const originalExtraction = mapped.extraction;
    const metadataProjection = projectDirectOriginalMetadataFields(originalExtraction.reportMetadata, mapped.manifest, reading.documentId);
    const fieldReviews: DirectOriginalFieldAdmissionReview[] = metadataProjection.reviews.length
      ? [{ kind: 'metadata', original: originalExtraction.reportMetadata!, fields: metadataProjection.reviews }] : [];
    mapped.extraction = { ...mapped.extraction, reportMetadata: metadataProjection.metadata,
      candidates: mapped.extraction.candidates.map((candidate) => {
        const projected = projectDirectOriginalCandidateFields(candidate, mapped.manifest, {
          personConsistent: identityState(reading, bundle) === 'trusted', overwritesUserLockedValue: false,
          reportMetadata: originalExtraction.reportMetadata ?? null });
        if (projected.reviews.length) fieldReviews.push({ kind: 'candidate', original: candidate, fields: projected.reviews });
        return projected.candidate;
      }) };
    const state = identityState(reading, bundle);
    const reportIssues = [...pageErrors, ...validateDirectOriginalExtraction(mapped.extraction, mapped.manifest,
      { subjectPolicy: userAssigned ? 'user_assigned' : 'require_source_identity',
        allowedPrimarySourceSpanIds: [...pageIds] })];
    for (const pageId of pageIds) if (!reading.pageReadings.some((page) => page.sourceSpanId === pageId)) {
      reportIssues.push('direct_original_page_reading_missing');
    }
    if (reading.pageReadings.some((page) => page.status === 'partial' || page.status === 'unreadable')) {
      reportIssues.push('direct_original_page_not_fully_read');
    }
    const contradictoryPageIds = new Set(reading.pageReadings.filter((page) =>
      (page.status === 'unreadable' || page.status === 'no_medical_content') && reading.sourceExcerpts.some((excerpt) =>
        excerpt.pageSourceSpanId === page.sourceSpanId && excerpt.clarity === 'clear'
        && ['finding', 'instruction'].includes(excerpt.role))).map((page) => page.sourceSpanId));
    if (contradictoryPageIds.size) reportIssues.push('direct_original_page_content_status_conflict');
    if (state !== 'trusted') reportIssues.push(state === 'conflict' ? 'person_conflict' : 'direct_original_subject_source_required');
    const validationDiagnostics: DirectOriginalCandidateDiagnostic[] = userAssigned ? [] : diagnoseDirectOriginalSubjectSources(reading);
    const dateBindingGaps = reading.extraction.candidates.flatMap(candidate => explicitNoResult(candidate, reading)
      ? [] : diagnoseMissingDateBinding(candidate, reading));
    validationDiagnostics.push(...dateBindingGaps);
    reportIssues.push(...dateBindingGaps.map(diagnostic => diagnostic.reasonCode));
    const localSourceIds = new Map([...mapped.ids].map(([localKey, id]) => [id, localKey]));
    const candidateFailures = reading.extraction.candidates.flatMap((candidate, index) => {
      if (findingKeys(candidate, reading).some((key) => reading.sourceExcerpts.some((excerpt) =>
        excerpt.localKey === key && contradictoryPageIds.has(excerpt.pageSourceSpanId)))) {
        return [{ candidate, reasons: ['direct_original_page_content_status_conflict'] }];
      }
      if (explicitNoResult(candidate, reading)) return [];
      // 诊断只传字段位置与规则约束；模型原句仍复用目标及目录，不复制全文或永久来源ID。
      validationDiagnostics.push(...diagnoseDirectOriginalNoResult(candidate, reading));
      validationDiagnostics.push(...diagnoseDirectOriginalObservationCandidate(mapped.extraction.candidates[index]!, mapped.manifest,
        { personConsistent: state === 'trusted', overwritesUserLockedValue: false, reportMetadata: mapped.extraction.reportMetadata ?? null })
        .map((diagnostic) => ({ ...diagnostic, ...(diagnostic.sourceSpanId
          ? { sourceSpanId: localSourceIds.get(diagnostic.sourceSpanId) ?? diagnostic.sourceSpanId } : {}) })));
      const accepted = evaluateDirectOriginalObservationCandidate(mapped.extraction.candidates[index]!, mapped.manifest,
        { personConsistent: state === 'trusted', overwritesUserLockedValue: false, reportMetadata: mapped.extraction.reportMetadata ?? null });
      return accepted.decision === 'accept' || accepted.decision === 'accept_with_warnings' ? []
        : [{ candidate, reasons: accepted.reasons }];
    });
    // 读到了什么与能否覆盖旧事实是两项独立判断。后续业务暂存不能把清楚结果改称漏读。
    const structuralFailureKeys = new Set(candidateFailures.map(({ candidate }) => candidate.localKey));
    let admissionPreview: DirectOriginalAdmissionPreview | null = null;
    if (state === 'trusted') {
      // 与正式保存共享只读决策。这里不保存来源、接纳决定或任何医疗值，临时ID只在内存使用。
      const observations = mapped.extraction.candidates.flatMap((candidate, index) =>
        structuralFailureKeys.has(candidate.localKey) || explicitNoResult(reading.extraction.candidates[index]!, reading) ? []
          : [{ ...observation(candidate, 'direct-original-admission-preview', reading.documentId, mapped.manifest),
            candidate: originalExtraction.candidates[index]! }]);
      const preview = this.store.previewDirectOriginalAdmission({ personId: bundle.personId,
        documentId: reading.documentId, manifest: mapped.manifest, observations,
        fieldReviews,
        ...(this.executionGuard ? { executionGuard: this.executionGuard } : {}),
        reportMetadata: reportIssues.some((issue) => issue.startsWith('direct_original_evidence_')
          || issue.startsWith('direct_original_primary_clinical_time_')
          || issue === 'direct_original_reference_changed') ? null : mapped.extraction.reportMetadata ?? null,
        ...(sourceRefinementReview ? { sourceRefinementReview } : {}) });
      admissionPreview = preview;
      reportIssues.push(...preview.reportReasonCodes);
      for (const held of preview.held) {
        // 只按模型自身稳定localKey接回原候选；永久来源ID和正式记录绝不能混入P03请求。
        const candidate = reading.extraction.candidates.find((item) => item.localKey === held.candidate.localKey);
        if (!candidate) throw new Error('DIRECT_ORIGINAL_PREVIEW_CANDIDATE_SCOPE_INVALID');
        const existing = candidateFailures.find((failure) => failure.candidate.localKey === candidate.localKey);
        if (existing) existing.reasons = [...new Set([...existing.reasons, ...held.reasons])];
        else candidateFailures.push({ candidate, reasons: [...new Set(held.reasons)] });
      }
    }
    const coverage = inspectDirectOriginalCoverage(reading);
    const emptyReadPageIds = reading.pageReadings.filter((page) => page.status === 'read'
      && !(page.resultInventory?.length && page.resultInventory.every(item => coverage.classifiedSourceKeys.has(item.sourceSpanId)))
      && !reading.extraction.candidates.some((candidate) => (candidate.sourceBinding?.findingEvidence ?? candidate.evidence)
        .map((ref) => ref.sourceSpanId).some((key) =>
        reading.sourceExcerpts.some((excerpt) => excerpt.localKey === key && excerpt.pageSourceSpanId === page.sourceSpanId))))
      .map((page) => page.sourceSpanId);
    if (emptyReadPageIds.length) reportIssues.push('direct_original_empty_read_result');
    reportIssues.push(...coverage.issues);
    // 页面已读不等于摘录已完成对账。明确用于栏目、共同表格或报告时间的原句不是孤立结果；
    // 它们的用途仍由各字段独立核验，不据此授予结果接纳或缩小字段竞争范围。
    const represented = new Set([...reading.extraction.candidates.flatMap(refKeys),
      ...metadataRefs(reading.extraction.reportMetadata), ...reading.extraction.subject.evidence.map((ref) => ref.sourceSpanId)]);
    const unrepresentedSources = reading.sourceExcerpts.filter((excerpt) => excerpt.role === 'finding'
      && excerpt.clarity === 'clear' && !represented.has(excerpt.localKey)
      && !coverage.classifiedSourceKeys.has(excerpt.localKey)
      && !excerptRepresentedInExpandedSource(excerpt, reading));
    if (unrepresentedSources.length) reportIssues.push('direct_original_readable_source_not_accounted');
    // 漏读页的定点修复必须真正补到可定位的结果或空白出处，不能只翻转“已读”状态。
    const recoveryGapPageIds = incompletePageSourceSpanIds.filter((pageId) => reading.pageReadings.some((page) =>
      page.sourceSpanId === pageId && page.status === 'read') && !reading.extraction.candidates.some((candidate) =>
      !structuralFailureKeys.has(candidate.localKey) && [...new Set([...findingKeys(candidate, reading),
        ...directOriginalNoResultSourceKeys(candidate, reading)])].some((key) => reading.sourceExcerpts.some((excerpt) =>
        excerpt.localKey === key && excerpt.pageSourceSpanId === pageId && excerpt.clarity === 'clear'
        && (['finding', 'instruction'].includes(excerpt.role)
          || directOriginalNoResultSourceKeys(candidate, reading).includes(key))))));
    if (recoveryGapPageIds.length) reportIssues.push('direct_original_page_recovery_missing_results');
    const gapPageIds = [...new Set([...contradictoryPageIds, ...recoveryGapPageIds, ...emptyReadPageIds, ...coverage.pageIds,
      ...unrepresentedSources.map((excerpt) => excerpt.pageSourceSpanId),
      ...[...pageIds].filter((pageId) => !reading.pageReadings.some((page) => page.sourceSpanId === pageId)),
      ...reading.pageReadings.filter((page) => page.status === 'partial' || page.status === 'unreadable').map((page) => page.sourceSpanId)])];
    return { state, userAssigned, reportIssues: [...new Set(reportIssues)], candidateFailures,
      validationDiagnostics, gapPageIds, unrepresentedSourceCount: unrepresentedSources.length,
      unrepresentedSourceKeys: unrepresentedSources.map(excerpt => excerpt.localKey),
      mapped, admissionPreview, fieldReviews, originalMappedExtraction: originalExtraction };
  }

  private targets(reading: DirectOriginalReadingResult, prepared: PreparedOriginalModelInput,
    validation: ReturnType<DirectOriginalExtractionPipeline['validate']>): DirectOriginalRepairTarget[] {
    const targets = new Map<string, DirectOriginalRepairTarget>();
    const add = (targetId: string, nodeType: DirectOriginalRepairTarget['nodeType']) => {
      const old = targets.get(targetId);
      if (old && old.nodeType !== nodeType) throw new Error('DIRECT_ORIGINAL_REPAIR_NODE_COLLISION');
      targets.set(targetId, { targetId, nodeType });
    };
    for (const { candidate, reasons } of validation.candidateFailures) {
      add(candidate.localKey, 'candidate');
      const repairSourceAdmission = reasons.some(sourceAdmissionRepairCode);
      const mappedCandidate = validation.mapped?.extraction.candidates.find((item) => item.localKey === candidate.localKey);
      for (const key of refKeys(candidate)) {
        const excerpt = reading.sourceExcerpts.find((item) => item.localKey === key);
        const isFinding = findingKeys(candidate, reading).includes(key);
        const isHeading = candidate.sourceBinding?.headingEvidence.some((ref) => ref.sourceSpanId === key);
        const mappedHeadingRefs = mappedCandidate?.sourceBinding?.headingEvidence.filter((ref) =>
          ref.sourceSpanId === validation.mapped?.ids.get(key)) ?? [];
        const headingValid = mappedCandidate && validation.mapped && mappedHeadingRefs.length > 0
          && mappedHeadingRefs.every((ref) => isDirectOriginalHeadingReferenceValid(mappedCandidate, validation.mapped!.manifest, ref));
        const isCondition = candidate.clinicalContext?.conditions.some((ref) => ref.sourceSpanId === key);
        if (!excerpt || excerpt.clarity !== 'clear'
          || isFinding && !['finding', 'instruction'].includes(excerpt.role)
          || isHeading && !headingValid
          || isCondition && !isDirectOriginalConditionSourceRole(excerpt.role)) add(key, 'excerpt');
        if (repairSourceAdmission && excerpt && ['finding', 'instruction', 'heading', 'context'].includes(excerpt.role)) {
          // 分槽/重复引文问题可由模型从必要原页补栏目或新引用；不凭部位、方法或结果猜字段身份。
          add(key, 'excerpt');
          if (prepared.manifest.spans.some((span) => span.id === excerpt.pageSourceSpanId)) add(excerpt.pageSourceSpanId, 'page');
        }
      }
    }
    for (const review of validation.fieldReviews) {
      if (review.kind !== 'candidate' || !review.fields.some(field => field.fieldPath === 'clinicalDate')) continue;
      add(review.original.localKey, 'candidate');
      add('metadata', 'metadata');
      const local = reading.extraction.candidates.find(candidate => candidate.localKey === review.original.localKey);
      for (const key of local ? refKeys(local) : []) {
        const excerpt = reading.sourceExcerpts.find(item => item.localKey === key);
        if (excerpt && prepared.manifest.spans.some(span => span.id === excerpt.pageSourceSpanId)) {
          add(excerpt.pageSourceSpanId, 'page');
        }
      }
    }
    // 字段级来源失败可能需要从真实原页另读独立摘录，而不只是重命名混合来源。
    // 仅开放诊断点名的当前文件实际原页；现有引用闭包和非目标保护继续生效。
    for (const diagnostic of validation.validationDiagnostics) {
      if (diagnostic.reasonCode === 'direct_original_clinical_date_binding_missing') {
        add(diagnostic.targetId, 'candidate');
        add('metadata', 'metadata');
      }
      if (!diagnostic.sourceSpanId) continue;
      const excerpt = reading.sourceExcerpts.find((item) => item.localKey === diagnostic.sourceSpanId);
      if (!excerpt || !prepared.manifest.spans.some((span) => span.id === excerpt.pageSourceSpanId)) continue;
      add(excerpt.localKey, 'excerpt');
      add(excerpt.pageSourceSpanId, 'page');
    }
    const untypedSubjectSource = reading.extraction.subject.confidence === 'explicit'
      && reading.extraction.subject.evidence.some((ref) => !reading.sourceExcerpts.some((excerpt) =>
        excerpt.localKey === ref.sourceSpanId && excerpt.role === 'identity' && excerpt.clarity === 'clear'));
    if (!validation.userAssigned && (validation.state !== 'trusted' || untypedSubjectSource
      || validation.reportIssues.some((issue) => issue.includes('subject')))) {
      add('subject', 'subject');
      for (const ref of reading.extraction.subject.evidence) if (!reading.sourceExcerpts.some((excerpt) =>
        excerpt.localKey === ref.sourceSpanId && excerpt.role === 'identity' && excerpt.clarity === 'clear')) add(ref.sourceSpanId, 'excerpt');
    }
    const invalidDateSourceKeys = new Set((reading.extraction.reportMetadata?.times ?? []).flatMap((time, index) => {
      const mappedTime = validation.originalMappedExtraction?.reportMetadata?.times[index];
      const proven = validation.mapped && mappedTime
        && directOriginalTimeEvidenceProblems(mappedTime, validation.mapped.manifest, reading.documentId).length === 0;
      return proven ? [] : time.evidence.map((ref) => ref.sourceSpanId);
    }));
    const invalidMetadata = metadataRefs(reading.extraction.reportMetadata).some((key) => !reading.sourceExcerpts.some((excerpt) =>
      excerpt.localKey === key && excerpt.clarity === 'clear')) || invalidDateSourceKeys.size > 0;
    if (invalidMetadata || validation.fieldReviews.some((review) => review.kind === 'metadata'
      && review.fields.some((field) => field.fieldPath === 'reportMetadata.primaryClinicalTimeIndex'))
      || validation.reportIssues.some((issue) => issue.startsWith('report_metadata_')
      || issue.startsWith('direct_original_primary_clinical_time_'))
      || validation.candidateFailures.some(({ reasons }) => reasons.includes('direct_original_clinical_date_source_required')
        || reasons.includes('clinical_date_enrichment_unproven'))) {
      add('metadata', 'metadata');
      for (const key of metadataRefs(reading.extraction.reportMetadata)) {
        const excerpt = reading.sourceExcerpts.find((item) => item.localKey === key);
        if (!excerpt || excerpt.clarity !== 'clear' || invalidDateSourceKeys.has(key)) add(key, 'excerpt');
      }
    }
    for (const parent of prepared.manifest.spans) {
      const page = reading.pageReadings.find((item) => item.sourceSpanId === parent.id);
      if (!page || page.status === 'partial' || page.status === 'unreadable'
        || validation.gapPageIds.includes(parent.id)
        || !reading.extraction.coveredSourceSpanIds.includes(parent.id)) add(parent.id, 'page');
      if (!page || page.status === 'partial' || page.status === 'unreadable' || validation.gapPageIds.includes(parent.id)) {
        // 首次漏读页可能包含身份、检查日期；授权结构节点由模型据同整份原件补证。
        if (!validation.userAssigned) add('subject', 'subject');
        add('metadata', 'metadata');
      }
    }
    // 来源片段修改的授权闭包包含所有引用者；非目标的原值和条件不得暗改。
    for (const target of [...targets.values()].filter((item) => item.nodeType === 'excerpt')) {
      for (const candidate of reading.extraction.candidates) if (refKeys(candidate).includes(target.targetId)) add(candidate.localKey, 'candidate');
      if (!validation.userAssigned && reading.extraction.subject.evidence.some((ref) => ref.sourceSpanId === target.targetId)) add('subject', 'subject');
      if (metadataRefs(reading.extraction.reportMetadata).includes(target.targetId)) add('metadata', 'metadata');
    }
    // 共享来源的所有引用者都要保留其职责，不能修结果角色却破坏已正确的身份或日期。
    // 有效引用的记录是保留义务而非新增失败；只授权已有目标引用的本文件真实原页。
    const protectedSourceKeys = new Set([...targets.values()].filter((target) => target.nodeType === 'excerpt').map((target) => target.targetId));
    const obligations = [...(validation.userAssigned ? [] : diagnoseDirectOriginalSubjectSources(reading, { protectedSourceKeys })),
      ...directOriginalReferenceObligations(reading, protectedSourceKeys)];
    const diagnosticKeys = new Set(validation.validationDiagnostics.map((diagnostic) => stableHash(diagnostic)));
    for (const obligation of obligations) {
      if (!diagnosticKeys.has(stableHash(obligation))) {
        validation.validationDiagnostics.push(obligation); diagnosticKeys.add(stableHash(obligation));
      }
      if (!obligation.sourceSpanId) continue;
      const excerpt = reading.sourceExcerpts.find((item) => item.localKey === obligation.sourceSpanId);
      if (excerpt && protectedSourceKeys.has(excerpt.localKey)
        && prepared.manifest.spans.some((span) => span.id === excerpt.pageSourceSpanId)) add(excerpt.pageSourceSpanId, 'page');
    }
    return [...targets.values()];
  }

  async process(documentId: string): Promise<ExtractionPipelineResult> {
    const guard = this.guard(documentId);
    const dateCorrection = this.store.isDateCorrectionJob(guard.jobId);
    // 日期专用流程在首次读取前冻结正式事实范围，因此整个流程共用接纳锁。
    if (dateCorrection) return this.finalize(documentId,
      () => new DirectOriginalDateCorrectionPipeline(this.store, this.runtime, guard, this.options).process(documentId));
    let bundle = this.store.getDocumentExtractionBundle(documentId);
    const originalSource = this.store.getDocumentOriginalSource(documentId);
    if (originalSource.documentId !== documentId || originalSource.personId !== bundle.personId
      || originalSource.sourceObjectId !== bundle.manifest.sourceObjectId || originalSource.sha256 !== bundle.manifest.sha256
      || originalSource.mediaType !== bundle.manifest.mediaType) throw new Error('DIRECT_ORIGINAL_SOURCE_IDENTITY_CHANGED');
    const convertedPdf = this.store.getDocumentConvertedView(documentId);
    if (convertedPdf && (convertedPdf.mediaType !== 'application/pdf' || convertedPdf.converterId !== 'libreoffice-headless')) {
      throw new Error('DIRECT_ORIGINAL_CONVERTED_VIEW_INVALID');
    }
    const supplement = this.store.getJobReportSupplementScope(guard, documentId);
    let prepared = await originalPreparationScheduler.run(() => this.guard(documentId),
      async () => (this.options.prepareOriginal ?? prepareDirectOriginalReport)({ documentId,
      sourceObjectId: originalSource.sourceObjectId, sha256: originalSource.sha256,
      displayName: originalSource.displayName, bytes: readFileSync(originalSource.sourcePath),
      createdAt: bundle.manifest.createdAt, ...(convertedPdf ? { convertedPdf: { ...convertedPdf,
        mediaType: 'application/pdf' as const, converterId: 'libreoffice-headless' as const } } : {}) }));
    try {
      this.guard(documentId);
      const primary = bundle.manifest.spans.filter((span) => !span.modelEvidence);
      if (prepared.originalSha256 !== bundle.manifest.sha256 || prepared.manifest.totalUnits !== primary.length
        || stableHash(primary) !== stableHash(prepared.manifest.spans)
        || prepared.unitMappings.length !== primary.length
        || new Set(prepared.unitMappings.map((unit) => unit.sourceSpanId)).size !== primary.length
        || prepared.unitMappings.some((unit) => !primary.some((span) => span.id === unit.sourceSpanId))
        || prepared.imagePaths.length !== prepared.unitMappings.filter((unit) => unit.inputKind === 'image').length) {
        throw new Error('DIRECT_ORIGINAL_PREPARATION_STALE');
      }
      const totalOriginalPages = prepared.totalUnits;
      if (supplement) {
        const selected = new Set(supplement.pageSourceSpanIds);
        if (prepared.nativeText !== undefined || prepared.unitMappings.some(unit => selected.has(unit.sourceSpanId) && unit.inputKind !== 'image')) {
          throw new Error('REPORT_SUPPLEMENT_IMAGE_SCOPE_REQUIRED');
        }
        const images = prepared.imageMappings.filter(image => selected.has(image.sourceSpanId));
        if (images.length !== selected.size) throw new Error('REPORT_SUPPLEMENT_SCOPE_CHANGED');
        prepared = { ...prepared, imagePaths: images.map(image => image.path), imageMappings: images,
          unitMappings: prepared.unitMappings.filter(unit => selected.has(unit.sourceSpanId)),
          manifest: { ...prepared.manifest, spans: prepared.manifest.spans.filter(span => selected.has(span.id)) } };
      }
      const sourcePackage = { documentId, sourceObjectId: prepared.manifest.sourceObjectId,
        originalSha256: prepared.originalSha256, totalUnits: prepared.totalUnits,
        completeOriginal: !supplement, units: prepared.unitMappings,
        ...(supplement ? { readingScope: 'selected_pages', allowedPageSourceSpanIds: supplement.pageSourceSpanIds,
          existingResultsPolicy: 'read_only_preserved_no_overwrite', baseAuditId: supplement.baseAuditId } : {}),
        images: prepared.imageMappings.map(({ path: _path, ...image }, imageIndex) => ({ ...image, imageIndex })),
        ...(prepared.nativeText === undefined ? {} : { nativeText: prepared.nativeText }),
        ...(prepared.convertedViewSha256 ? { convertedViewSha256: prepared.convertedViewSha256,
          conversionWarnings: prepared.manifest.conversionWarnings } : {}) };
      const ensureBudget = (prompt: string) => assertDirectOriginalPromptBudget(prompt, this.options.maxContextBytes);
      // wire 只改变 RPC 表示；断点仍为完整 canonical 回执，不能因短键换版丢失已用的修复次数。
      const signatureForRules = (rulesVersion: string, promptVersion = EXTRACTION_PROMPT_VERSION) => stableHash({ documentId, originalSha256: prepared.originalSha256,
        ...(supplement ? { supplement } : {}),
        ...(dateCorrection ? { purpose: 'date_correction', jobId: guard.jobId } : {}),
        modelId: DIRECT_ORIGINAL_MODEL_ID, promptVersion,
        rulesVersion, units: prepared.unitMappings,
        nativeTextHash: stableHash(prepared.nativeText ?? ''), convertedViewSha256: prepared.convertedViewSha256 ?? null });
      const signature = signatureForRules(ACCEPTANCE_RULES_VERSION);
      const cached = this.store.getExtractionChunkCheckpoint(guard, documentId, signature);
      let saved = checkpointSchema.safeParse(cached?.output);
      if (cached && !saved.success && cached.output && typeof cached.output === 'object'
        && ('repairRecovery' in cached.output || 'repairPartitionRecovery' in cached.output)) {
        throw new Error('DIRECT_ORIGINAL_REPAIR_RECOVERY_CHECKPOINT_INVALID');
      }
      // 来源位置对账升级不改变canonical读取契约。
      // 同授权、同原件、完整旧P01断点须按新规则重新校验，
      // 真实回执和已用的唯一 P03 不能因升级被重置；更近的损坏断点也不能被旧版掩盖。
      if (!dateCorrection && !cached && ACCEPTANCE_RULES_VERSION === 'direct-original-acceptance-v22'
        && EXTRACTION_PROMPT_VERSION === 'extract-direct-original-v23') {
        for (const [previousPrompt, previousVersion] of [
          ['extract-direct-original-v22', 'direct-original-acceptance-v21'],
          ['extract-direct-original-v21', 'direct-original-acceptance-v20'],
          ['extract-direct-original-v20', 'direct-original-acceptance-v19'],
          ['extract-direct-original-v19', 'direct-original-acceptance-v18'],
          ['extract-direct-original-v18', 'direct-original-acceptance-v17'],
          ['extract-direct-original-v17', 'direct-original-acceptance-v16'],
          ['extract-direct-original-v16', 'direct-original-acceptance-v15'],
          ['extract-direct-original-v15', 'direct-original-acceptance-v14'],
          ['extract-direct-original-v15', 'direct-original-acceptance-v13'],
          ['extract-direct-original-v14', 'direct-original-acceptance-v12'],
          ['extract-direct-original-v14', 'direct-original-acceptance-v11'],
          ['extract-direct-original-v13', 'direct-original-acceptance-v10'],
          ['extract-direct-original-v13', 'direct-original-acceptance-v9'],
          ['extract-direct-original-v12', 'direct-original-acceptance-v9'],
          ['extract-direct-original-v11', 'direct-original-acceptance-v8'],
          ['extract-direct-original-v10', 'direct-original-acceptance-v7'],
          ['extract-direct-original-v9', 'direct-original-acceptance-v7'],
          ['extract-direct-original-v8', 'direct-original-acceptance-v7'],
          ['extract-direct-original-v7', 'direct-original-acceptance-v7'],
          ['extract-direct-original-v6', 'direct-original-acceptance-v7'],
          ['extract-direct-original-v5', 'direct-original-acceptance-v7'],
          ['extract-direct-original-v4', 'direct-original-acceptance-v7'],
          ['extract-direct-original-v3', 'direct-original-acceptance-v6'],
          ['extract-direct-original-v3', 'direct-original-acceptance-v5'],
          ['extract-direct-original-v3', 'direct-original-acceptance-v4']
        ]) {
          // 五页等补读旧断点必须带同一个 supplement 签名；更老版本没有这一契约。
          if (supplement && previousPrompt !== 'extract-direct-original-v22') continue;
          const previous = this.store.getExtractionChunkCheckpoint(guard, documentId,
            signatureForRules(previousVersion!, previousPrompt!));
          if (!previous) continue;
          saved = checkpointSchema.safeParse(previous.output);
          if (saved.success) this.saveCheckpoint(documentId, signature, saved.data);
          break;
        }
      }
      let state: ReadingCheckpoint;
      if (saved.success) state = saved.data;
      else {
        const recoverySignature = stableHash({ checkpointKind: 'direct_original_format_recovery', documentId,
          sourceObjectId: prepared.manifest.sourceObjectId, originalSha256: prepared.originalSha256, modelId: DIRECT_ORIGINAL_MODEL_ID });
        const cachedRecovery = this.store.getExtractionChunkCheckpoint(guard, documentId, recoverySignature);
        const recovered = formatRecoveryCheckpointSchema.safeParse(cachedRecovery?.output);
        if (cachedRecovery && !recovered.success) throw new Error('DIRECT_ORIGINAL_FORMAT_RECOVERY_CHECKPOINT_INVALID');
        if (recovered.success && (recovered.data.phase === 'exhausted'
          || recovered.data.phase === 'in_flight' && recovered.data.transportAttempts === undefined)) return await this.finalize(documentId, async () =>
          this.hold(documentId, 'DIRECT_ORIGINAL_STRUCTURE_INVALID', prepared.manifest.spans.map((span) => span.id),
            [], recovered.data.receipt ?? undefined, undefined, [recovered.data.reason]));
        let recoveryState = recovered.success ? recovered.data : null;
        const saveRecovery = () => {
          if (!recoveryState) throw new Error('DIRECT_ORIGINAL_FORMAT_RECOVERY_STATE_INVALID');
          this.store.saveExtractionChunkCheckpoint({ guard: this.guard(documentId), documentId,
            signature: recoverySignature, chunkIndex: 0, output: recoveryState,
            threadId: recoveryState.receipt?.threadId ?? '', turnId: recoveryState.receipt?.turnId ?? '',
            extractionTurnId: recoveryState.receipt?.turnId ?? '' });
        };
        let formatRecoveryAttempted = recovered.success;
        while (true) {
          let result: Awaited<ReturnType<DirectOriginalExtractionPipeline['runTurn']>> | null = null;
          let reason: DirectOriginalStructureFailureReason | null = null;
          try {
            const readPrompt = buildDirectOriginalReadPrompt(sourcePackage);
            const prompt = ensureBudget(formatRecoveryAttempted
              ? readPrompt.replace('# DIRECT_ORIGINAL_P01\n', '# DIRECT_ORIGINAL_P01\n本轮为唯一一次输出格式恢复。请重新查看同一完整原件，严格返回指定wire结构；不沿用无效回包，不删页、不删项目，不填造不确定结果。\n')
              : readPrompt);
            if (formatRecoveryAttempted && recoveryState) {
              const requestSignature = stableHash({ recoverySignature, prompt, units: prepared.unitMappings });
              if (recoveryState.requestSignature && recoveryState.requestSignature !== requestSignature) {
                throw new Error('DIRECT_ORIGINAL_FORMAT_RECOVERY_SCOPE_CHANGED');
              }
              if ((recoveryState.transportAttempts ?? 1) >= REPAIR_TRANSPORT_ATTEMPT_LIMIT) {
                recoveryState.phase = 'exhausted'; saveRecovery();
                return await this.finalize(documentId, async () => this.hold(documentId, 'DIRECT_ORIGINAL_STRUCTURE_INVALID',
                  prepared.manifest.spans.map((span) => span.id), [], recoveryState!.receipt ?? undefined, undefined, [recoveryState!.reason]));
              }
              recoveryState = { ...recoveryState, phase: 'in_flight', requestSignature,
                transportAttempts: (recoveryState.transportAttempts ?? 1) + 1 };
              saveRecovery();
            }
            result = await this.runTurn(documentId, 'extract', { prompt,
              imagePaths: prepared.imagePaths, outputSchema: readingOutputSchema, allowWebSearch: false, timeoutMs: HEALTH_MODEL_TURN_TIMEOUT_MS });
            this.guard(documentId);
          } catch (error) {
            if (!this.store.isOpen()) throw error;
            this.guard(documentId);
            if (formatRecoveryAttempted && recoveryState && !isStructuredOutputFailure(error)) {
              recoveryState.phase = error instanceof Error && error.message === 'CODEX_MODEL_BUSY' ? 'busy' : 'transport_unknown';
              saveRecovery();
            }
            if (!isStructuredOutputFailure(error)) throw error;
            reason = 'DIRECT_ORIGINAL_STRUCTURE_ENVELOPE_INVALID';
          }
          let decoded: DirectOriginalReadingResult | null = null;
          if (result) {
            try { decoded = decodeDirectOriginalReading(result.output); }
            catch (error) {
              reason = directOriginalStructureFailureReason(error);
              if (reason === 'DIRECT_ORIGINAL_STRUCTURE_DECODE_UNEXPECTED') throw error;
            }
            if (decoded && decoded.documentId !== documentId) reason = 'DIRECT_ORIGINAL_STRUCTURE_DOCUMENT_MISMATCH';
          }
          if (result && decoded && !reason) {
            const receipt = { threadId: result.threadId, turnId: result.turnId };
            state = { checkpointKind: 'direct_original_reading', reading: decoded, receipt,
              firstReading: structuredClone(decoded), firstTransmissionId: result.transmissionId,
              firstInputSignature: result.inputSignature,
              excerptReceipts: Object.fromEntries(decoded.sourceExcerpts.map((excerpt) => [excerpt.localKey, receipt])), repairAttempted: false,
              incompletePageSourceSpanIds: prepared.manifest.spans.filter((span) => !decoded.pageReadings.some((page) =>
                page.sourceSpanId === span.id && (page.status === 'read' || page.status === 'no_medical_content'))).map((span) => span.id) };
            this.saveCheckpoint(documentId, signature, state);
            break;
          }
          if (!reason) throw new Error('DIRECT_ORIGINAL_FORMAT_RECOVERY_STATE_INVALID');
          const receipt = result ? { threadId: result.threadId, turnId: result.turnId } : null;
          recoveryState = { checkpointKind: 'direct_original_format_recovery', attempted: true,
            phase: formatRecoveryAttempted ? 'exhausted' : 'in_flight', receipt, reason,
            transportAttempts: recoveryState?.transportAttempts ?? 0,
            ...(recoveryState?.requestSignature ? { requestSignature: recoveryState.requestSignature } : {}) };
          saveRecovery();
          if (formatRecoveryAttempted) return await this.finalize(documentId, async () =>
            this.hold(documentId, 'DIRECT_ORIGINAL_STRUCTURE_INVALID', prepared.manifest.spans.map((span) => span.id),
              [], receipt ?? undefined, undefined, [reason]));
          formatRecoveryAttempted = true;
        }
      }
      // P01 回执已持久化，之后整个阶段串行；P03 比较目录和 revision 必须在拿到锁后重新读取，
      // 并一直保护到正式发布，不能让另一份报告先提交而使来源补齐证明失效。
      return await this.finalize(documentId, async () => {
        bundle = this.store.getDocumentExtractionBundle(documentId);
        let validation = this.validate(state.reading, prepared, bundle, state.excerptReceipts, state.incompletePageSourceSpanIds,
          state.sourceRefinementReview);
        const targets = this.targets(state.reading, prepared, validation);
        if (dateCorrection && !state.repairAttempted) {
          // 显式日期替换必须独立看完整原件；干净的P01也不能跳过唯一一次P03。
          const required: DirectOriginalRepairTarget[] = [{ targetId: 'metadata', nodeType: 'metadata' },
            ...state.reading.extraction.candidates.map((candidate) => ({ targetId: candidate.localKey, nodeType: 'candidate' as const })),
            ...state.reading.sourceExcerpts.filter((excerpt) => excerpt.role === 'date')
              .map((excerpt) => ({ targetId: excerpt.localKey, nodeType: 'excerpt' as const }))];
          for (const target of required) if (!targets.some((item) => item.targetId === target.targetId)) targets.push(target);
        }
        if (!state.repairAttempted && targets.length > 0) {
          const firstReceipt = state.receipt;
          const originalReadingHash = stableHash(state.reading);
          const request = { schemaVersion: 1, documentId, originalReadingHash, targets,
            issues: [...new Set([...validation.reportIssues, ...validation.candidateFailures.flatMap((item) => item.reasons),
              ...validation.fieldReviews.flatMap((review) => review.fields.flatMap((field) => field.reasonCodes)),
              ...(dateCorrection ? ['explicit_date_correction_requires_independent_original_review'] : [])])],
            validationDiagnostics: validation.validationDiagnostics,
            allowedPageSourceSpanIds: prepared.manifest.spans.map((span) => span.id) };
          const targetItems = targets.map((target) => ({ ...target,
            value: target.nodeType === 'candidate' ? state.reading.extraction.candidates.find((candidate) => candidate.localKey === target.targetId)
              : target.nodeType === 'excerpt' ? state.reading.sourceExcerpts.find((excerpt) => excerpt.localKey === target.targetId) ?? null
              : target.nodeType === 'metadata' ? state.reading.extraction.reportMetadata ?? null
              : target.nodeType === 'subject' ? state.reading.extraction.subject
              : state.reading.pageReadings.find((page) => page.sourceSpanId === target.targetId) ?? null }));
          const comparison = repairReadOnlyContext(state.reading, prepared, targets, validation.admissionPreview,
            validation.mapped?.ids ?? new Map());
          // 永久记录 ID、修订及行哈希仅用于主进程强绑定，发送给模型的只有已脱敏的只读目录。
          const refinementContext = state.firstReading && state.firstTransmissionId && state.firstInputSignature
            && comparison.refinementTargets.length > 0 && stableHash(state.firstReading) === originalReadingHash ? {
              sourceObjectId: prepared.manifest.sourceObjectId, originalSha256: prepared.originalSha256,
              factRevision: this.store.getFactRevision(bundle.personId), firstReading: structuredClone(state.firstReading),
              targets: structuredClone(targets), allowedPageSourceSpanIds: prepared.manifest.spans.map((span) => span.id),
              refinementTargets: comparison.refinementTargets
            } : undefined;
          const fullRepairPrompt = buildDirectOriginalRepairPrompt(request, sourcePackage, targetItems, comparison.context);
          let outcome: RepairOutcome;
          if (state.repairPartitionRecovery || Buffer.byteLength(fullRepairPrompt, 'utf8') > (this.options.maxContextBytes ?? DIRECT_ORIGINAL_PROMPT_MAX_BYTES)) {
            outcome = await this.repairInPartitions({ documentId, signature, state, prepared, sourcePackage, request,
              context: comparison.context, refinementContext: refinementContext ?? {
                sourceObjectId: prepared.manifest.sourceObjectId, originalSha256: prepared.originalSha256,
                factRevision: this.store.getFactRevision(bundle.personId), firstReading: state.reading,
                targets, allowedPageSourceSpanIds: prepared.manifest.spans.map((span) => span.id),
                refinementTargets: comparison.refinementTargets }, dateCorrection });
          } else {
          const repairInput = {
            prompt: ensureBudget(fullRepairPrompt),
            imagePaths: prepared.imagePaths, outputSchema: repairOutputSchema, allowWebSearch: false, timeoutMs: HEALTH_MODEL_TURN_TIMEOUT_MS };
          // 请求身份不含本机临时图片路径；同一原件、目标及正式比较目录才可续接。
          // 旧版 repairAttempted=true 仍视为已用完内容机会，不因升级无限重开。
          const requestSignature = stableHash({ signature, request, sourcePackage, targetItems,
            comparison: comparison.context, refinement: refinementContext ?? null, prompt: repairInput.prompt });
          if (state.repairRecovery && state.repairRecovery.requestSignature !== requestSignature) {
            if (state.repairRecovery.response || state.repairRecovery.originalReadingHash !== originalReadingHash
              || !['transport_unknown', 'in_flight'].includes(state.repairRecovery.phase)) {
              throw new Error('DIRECT_ORIGINAL_REPAIR_RECOVERY_SCOPE_CHANGED');
            }
            // 同成员另一份资料可能在连接失败期间提交；重新核验新比较目录，但不能重置传输预算。
            state.repairRecovery.scopeHistory.push(state.repairRecovery.requestSignature);
            state.repairRecovery.requestSignature = requestSignature;
          }
          let result: Awaited<ReturnType<DirectOriginalExtractionPipeline['runTurn']>> | null = null;
          if (state.repairRecovery?.phase === 'response_saved') {
            // 回包先落盘，解码、合并或发布中断后仅重新校验，不重复发送完整原件。
            result = state.repairRecovery.response!;
          } else if ((state.repairRecovery?.transportAttempts ?? 0) < REPAIR_TRANSPORT_ATTEMPT_LIMIT) {
            state.repairRecovery = { version: 1, requestSignature, originalReadingHash,
              scopeHistory: state.repairRecovery?.scopeHistory ?? [], phase: 'in_flight',
              transportAttempts: (state.repairRecovery?.transportAttempts ?? 0) + 1 };
            this.saveCheckpoint(documentId, signature, state);
            try {
              result = await this.runTurn(documentId, 'repair_extraction', repairInput,
                refinementContext ? directOriginalSourceRefinementReviewSignature(refinementContext) : undefined);
              this.guard(documentId);
            } catch (error) {
              if (!this.store.isOpen()) throw error;
              this.guard(documentId);
              state.repairRecovery.phase = isStructuredOutputFailure(error) ? 'validated' : 'transport_unknown';
              if (isStructuredOutputFailure(error)) state.repairAttempted = true;
              this.saveCheckpoint(documentId, signature, state);
              if (!isStructuredOutputFailure(error)) throw error;
            }
            if (result) {
              state.repairRecovery = { ...state.repairRecovery, phase: 'response_saved',
                response: result, responseHash: stableHash(result) };
              this.saveCheckpoint(documentId, signature, state);
            }
          } else {
            state.repairRecovery = { ...state.repairRecovery!, phase: 'exhausted' };
          }
          state.repairAttempted = true;
          let decoded: unknown;
          if (result) try { decoded = decodeDirectOriginalRepair(result.output); } catch (error) {
            if (directOriginalStructureFailureReason(error) === 'DIRECT_ORIGINAL_STRUCTURE_DECODE_UNEXPECTED') throw error;
            decoded = undefined;
          }
          const patch = directOriginalReadingRepairSchema.safeParse(decoded);
          outcome = state.repairRecovery?.phase === 'exhausted' ? 'transport_exhausted' : patch.success ? 'applied' : 'schema_invalid';
          if (patch.success && result) {
            try {
              assertNoReadOnlyComparisonReferences(patch.data, comparison.context);
              for (const mapping of patch.data.sourceMappings ?? []) {
                if (mapping.relation === 'same_original_field' && (!refinementContext
                  || !comparison.refinementTargets.some((target) => target.candidateKey === mapping.candidateKey
                    && target.comparisonRecordKey === mapping.comparisonRecordKey))) {
                  throw new Error('DIRECT_ORIGINAL_SOURCE_REFINEMENT_TARGET_UNAUTHORIZED');
                }
              }
              const nextReading = assembleDirectOriginalReadingRepair({ original: state.reading, repair: patch.data,
                originalReadingHash, targets, allowedPageSourceSpanIds: prepared.manifest.spans.map((span) => span.id) });
              const nextReview = refinementContext && patch.data.sourceMappings?.length && state.firstTransmissionId && state.firstInputSignature
                ? { ...refinementContext, repair: patch.data,
                  firstTransmissionId: state.firstTransmissionId, firstInputSignature: state.firstInputSignature,
                  repairTransmissionId: result.transmissionId, repairInputSignature: result.inputSignature } : undefined;
              const nextExcerptReceipts = { ...state.excerptReceipts };
              for (const entry of patch.data.results) if (entry.action === 'replace' && entry.replacement?.nodeType === 'excerpt') {
                nextExcerptReceipts[entry.replacement.value.localKey] = { threadId: result.threadId, turnId: result.turnId };
              }
              for (const entry of patch.data.results) if (entry.action === 'replace' && entry.replacement?.nodeType === 'page') {
                for (const excerpt of entry.replacement.value.newExcerpts ?? []) {
                  nextExcerptReceipts[excerpt.localKey] = { threadId: result.threadId, turnId: result.turnId };
                }
              }
              let nextDateCorrectionReview = state.dateCorrectionReview;
              if (dateCorrection && targets.filter((target) => target.nodeType === 'candidate' || target.nodeType === 'metadata'
                || target.nodeType === 'excerpt' && nextReading.sourceExcerpts.some((excerpt) =>
                  excerpt.localKey === target.targetId && excerpt.role === 'date')).every((target) =>
                patch.data.results.some((entry) => entry.targetId === target.targetId && entry.action === 'replace'))
                && firstReceipt.threadId !== result.threadId && firstReceipt.turnId !== result.turnId) {
                nextDateCorrectionReview = { readingHash: stableHash(nextReading), firstReceipt,
                  reviewReceipt: { threadId: result.threadId, turnId: result.turnId } };
              }
              state.reading = nextReading;
              state.excerptReceipts = nextExcerptReceipts;
              if (nextReview) state.sourceRefinementReview = nextReview;
              if (nextDateCorrectionReview) state.dateCorrectionReview = nextDateCorrectionReview;
            } catch { delete state.sourceRefinementReview; outcome = 'scope_violation'; }
          }
          if (result) state.receipt = { threadId: result.threadId, turnId: result.turnId };
          if (state.repairRecovery?.phase === 'response_saved') state.repairRecovery.phase = 'validated';
          this.saveCheckpoint(documentId, signature, state);
          }
          bundle = this.store.getDocumentExtractionBundle(documentId);
          validation = this.validate(state.reading, prepared, bundle, state.excerptReceipts, state.incompletePageSourceSpanIds,
            state.sourceRefinementReview);
          if (outcome === 'applied' && validation.reportIssues.length + validation.candidateFailures.length > 0) outcome = 'still_failed';
          this.store.saveExtractionRepairDiagnostic({ documentId, chunkIndex: 0, triggerCodes: request.issues,
            targetCandidateCount: targets.filter((target) => target.nodeType === 'candidate').length,
            missingSourceCount: targets.filter((target) => target.nodeType === 'page').length,
            metadataTimeTargetCount: targets.filter((target) => target.nodeType === 'metadata').length,
            outcome, remainingFailureCount: validation.reportIssues.length + validation.candidateFailures.length,
            acceptedCount: state.reading.extraction.candidates.filter((candidate) => !explicitNoResult(candidate, state.reading)
              && !validation.candidateFailures.some((failure) => failure.candidate.localKey === candidate.localKey)).length, guard });
        }
        if (!validation.mapped) return this.hold(documentId, 'DIRECT_ORIGINAL_SOURCE_SCOPE_INVALID',
          prepared.manifest.spans.map((span) => span.id), state.reading.extraction.candidates, state.receipt);
        if (dateCorrection && !state.dateCorrectionReview) return this.hold(documentId, 'DATE_CORRECTION_INDEPENDENT_REVIEW_REQUIRED',
          prepared.manifest.spans.map((span) => span.id), state.reading.extraction.candidates, state.receipt);
        if (dateCorrection && validation.reportIssues.length > 0) return this.hold(documentId,
          directOriginalDateCorrectionReportHoldReason(validation.reportIssues),
          prepared.manifest.spans.map((span) => span.id), state.reading.extraction.candidates, state.receipt,
          undefined, validation.reportIssues);
        this.guard(documentId);
        this.store.saveDirectOriginalEvidenceForProcessing(validation.mapped.manifest, { executionGuard: guard });
        bundle = this.store.getDocumentExtractionBundle(documentId);
        if (userAssignedSubject(bundle)) {
          const reportedState = reportedIdentityState(state.reading, bundle);
          if (reportedState !== 'trusted') this.store.recordUserAssignedSubjectNotice({ documentId, jobId: guard.jobId,
            reason: reportedState === 'conflict' ? 'name_mismatch' : 'subject_unproven' });
        }
        if (validation.state !== 'trusted') {
          return this.hold(documentId, validation.state === 'conflict' ? 'PERSON_IDENTITY_NOT_CONFIRMED' : 'DIRECT_ORIGINAL_IDENTITY_UNPROVEN',
            validation.mapped.extraction.subject.evidence.map((ref) => ref.sourceSpanId), [], state.receipt,
            validation.state === 'conflict' ? state.reading.extraction.subject.reportedName ?? undefined : undefined);
        }
        const rejectedKeys = new Set(validation.candidateFailures.map((failure) => failure.candidate.localKey));
        const pairs = state.reading.extraction.candidates.flatMap((candidate, index) => {
          if (rejectedKeys.has(candidate.localKey) || explicitNoResult(candidate, state.reading)) return [];
          const mapped = validation.mapped!.extraction.candidates[index]!;
          const accepted = evaluateDirectOriginalObservationCandidate(mapped, bundle.manifest,
            { personConsistent: true, overwritesUserLockedValue: false, reportMetadata: validation.mapped!.extraction.reportMetadata ?? null });
          if (accepted.decision !== 'accept' && accepted.decision !== 'accept_with_warnings') return [];
          const acceptanceId = this.store.saveAcceptanceDecision({ method: 'auto', actor: 'policy', rulesVersion: ACCEPTANCE_RULES_VERSION,
            inputSignature: stableHash({ documentId, originalSha256: prepared.originalSha256, mapped }),
            outputHash: stableHash({ candidate: mapped, accepted }), reviewRef: `direct-original:${state.receipt.turnId}`, decision: accepted.decision });
          const original = validation.fieldReviews?.find((review) => review.kind === 'candidate'
            && review.original.localKey === mapped.localKey);
          return [{ ...observation(mapped, acceptanceId, documentId, bundle.manifest),
            ...(original?.kind === 'candidate' ? { candidate: original.original } : {}) }];
        });
        const unresolved = validation.candidateFailures.map((failure) => ({
          candidate: validation.mapped!.extraction.candidates.find((candidate) => candidate.localKey === failure.candidate.localKey)!, reasons: failure.reasons }));
        const fieldReviews = validation.fieldReviews ?? [];
        const readingAccounting = { candidates: validation.mapped.extraction.candidates,
          emptyCandidateKeys: state.reading.extraction.candidates.filter((candidate) => explicitNoResult(candidate, state.reading))
            .map((candidate) => candidate.localKey),
          failures: unresolved.map((item) => ({ localKey: item.candidate.localKey, reasons: item.reasons })),
          unrepresentedSourceCount: validation.unrepresentedSourceCount, pageGapCount: validation.gapPageIds.length,
          coverage: { version: 1 as const, scope: supplement ? 'selected_pages' as const : 'full_report' as const,
            ...(supplement ? { baseAuditId: supplement.baseAuditId } : {}), totalOriginalPages,
            originalSha256: prepared.originalSha256,
            promptVersion: EXTRACTION_PROMPT_VERSION, rulesVersion: ACCEPTANCE_RULES_VERSION,
            pages: state.reading.pageReadings.map(page => ({ sourceSpanId: page.sourceSpanId,
              page: prepared.manifest.spans.find(span => span.id === page.sourceSpanId)?.page ?? null,
              status: page.status, inventory: page.resultInventory?.map(item => ({
                sourceKey: item.sourceSpanId, sourceSpanId: validation.mapped!.ids.get(item.sourceSpanId) ?? null,
                candidateKeys: [...item.candidateKeys],
                ...(item.classification ? { classification: {
                  ...mapSourceIds(item.classification, validation.mapped!.ids),
                  duplicateSourceSpanId: item.classification.duplicateSourceSpanId
                    ? validation.mapped!.ids.get(item.classification.duplicateSourceSpanId) ?? null : null
                } } : {}) })) ?? null,
              ...(page.pageRole === undefined ? {} : { pageRole: page.pageRole }) })),
            unrepresentedSources: validation.unrepresentedSourceKeys.map(key => {
              const excerpt = state.reading.sourceExcerpts.find(item => item.localKey === key)!;
              const sourceSpanId = validation.mapped!.ids.get(key);
              if (!sourceSpanId) throw new Error('REPORT_READING_LEDGER_SOURCE_MISSING');
              return { sourceSpanId, pageSourceSpanId: excerpt.pageSourceSpanId,
                role: excerpt.role === 'instruction' ? 'instruction' as const : 'finding' as const, clarity: excerpt.clarity };
            }), gapPageSourceSpanIds: [...validation.gapPageIds]
          } };
        const reasonCodes = [...new Set([...validation.reportIssues, ...unresolved.flatMap((item) => item.reasons),
          ...fieldReviews.flatMap((review) => review.fields.map((field) => field.reasonCodes[0]!))])];
        const refs = [...new Set([...unresolved.flatMap((item) => refKeys(item.candidate)),
          ...validation.gapPageIds, ...fieldReviews.flatMap((review) => review.fields.flatMap((field) =>
            field.evidence.map((ref) => ref.sourceSpanId)))])];
        const safeMetadata = validation.mapped.extraction.reportMetadata ?? null;
        // 报告级结构未成立时不能把可疑元数据包装成正式报告；已确认候选仍可局部保存。
        const reportMetadata = validation.reportIssues.some((issue) => issue.startsWith('direct_original_evidence_')
          || issue.startsWith('direct_original_primary_clinical_time_')
          || issue === 'direct_original_reference_changed') ? null : safeMetadata;
        const committedIssue = this.store.isDocumentCommitted(documentId)
          ? this.store.listOpenExtractionReviewIssues().find((issue) => issue.documentId === documentId && issue.severity === 'warning' && issue.stage === 'extract') : undefined;
        if (this.store.isDocumentCommitted(documentId)) {
          const result = this.store.appendCommittedFacts({ personId: bundle.personId, documentId, readingAccounting,
            expectedRevision: this.store.getFactRevision(bundle.personId), summary: supplement ? '仅补读已绑定问题页并增量接纳' : '按整份原件直接重读并增量接纳', observations: pairs,
            reportMetadata: supplement ? null : reportMetadata, reviewUpdate: { issueId: committedIssue?.id ?? null, reconciliationMode: 'source_proven',
              remainingCandidates: unresolved.map((item) => item.candidate),
              remainingReasonCodes: reasonCodes, remainingEvidenceRefs: refs, fieldReviews }, executionGuard: guard,
            ...(state.sourceRefinementReview ? { sourceRefinementReview: state.sourceRefinementReview } : {}) });
          if (!result.reviewResolved && !result.reviewIssueId) throw new Error('COMMITTED_REVIEW_RECEIPT_MISSING');
          this.store.clearExtractionChunkCheckpoints(guard, documentId);
          return result.reviewResolved ? { status: 'published', documentId, revision: result.revision,
            candidateCount: result.appendedCount, ...state.receipt } : { status: 'partial', documentId,
            revision: result.revision, candidateCount: result.appendedCount, issueId: result.reviewIssueId!,
            reason: 'REPORT_CONTENT_HELD', requiresUser: false, ...state.receipt };
        }
        const hasOnlyEmptyResults = (state.reading.extraction.candidates.length > 0
          && state.reading.extraction.candidates.every((candidate) => explicitNoResult(candidate, state.reading))
          || state.reading.pageReadings.every((page) => page.status === 'no_medical_content'))
          && !state.reading.sourceExcerpts.some((excerpt) => excerpt.role === 'instruction')
          && !state.reading.pageReadings.some((page) => page.status === 'partial' || page.status === 'unreadable');
        if (!pairs.length && (!hasOnlyEmptyResults || reasonCodes.length > 0)) return this.hold(documentId, 'DIRECT_ORIGINAL_NO_ACCEPTABLE_FACTS',
          refs.length ? refs : prepared.manifest.spans.map((span) => span.id), unresolved.map((item) => item.candidate), state.receipt,
          undefined, reasonCodes, accountReportReading(readingAccounting, [], []).audit);
        const result = this.store.publishFacts({ personId: bundle.personId, documentId, readingAccounting,
          documentCommitKey: stableHash({ documentId, originalSha256: prepared.originalSha256, promptVersion: EXTRACTION_PROMPT_VERSION,
            rulesVersion: ACCEPTANCE_RULES_VERSION, directOriginal: true }),
          expectedRevision: this.store.getFactRevision(bundle.personId), changeSetHash: stableHash({ reading: state.reading, rulesVersion: ACCEPTANCE_RULES_VERSION }),
          summary: pairs.length ? `从完整原件接纳 ${pairs.length} 条报告事实` : '原报告空白或未提供结果，保留原件和模型来源引用',
          reportMetadata, observations: pairs, ...(reasonCodes.length ? { unresolvedReview: {
            kind: unresolved.length ? 'field_conflict' as const : 'coverage_gap' as const,
            evidenceRefs: refs.length ? refs : prepared.manifest.spans.map((span) => span.id),
            candidateOptions: unresolved.map((item) => item.candidate), reasonCodes, fieldReviews } } : {}), executionGuard: guard });
        this.store.clearExtractionChunkCheckpoints(guard, documentId);
        return result.reviewIssueId ? { status: 'partial', documentId, revision: result.revision,
          candidateCount: pairs.length - result.heldCount - result.duplicateCount, issueId: result.reviewIssueId,
          reason: 'REPORT_CONTENT_HELD', requiresUser: false, ...state.receipt } : { status: 'published', documentId,
          revision: result.revision, candidateCount: pairs.length - result.duplicateCount, ...state.receipt };
      });
    } finally { await prepared.cleanup(); }
  }

  private async repairInPartitions(input: {
    documentId: string; signature: string; state: ReadingCheckpoint; prepared: PreparedOriginalModelInput;
    sourcePackage: unknown; request: RepairPartitionRequest;
    context: DirectOriginalRepairReadOnlyContext; refinementContext: DirectOriginalSourceRefinementContext;
    dateCorrection: boolean;
  }): Promise<RepairOutcome> {
    const { documentId, signature, state, prepared, request, context, refinementContext } = input;
    const maxBytes = this.options.maxContextBytes ?? DIRECT_ORIGINAL_PROMPT_MAX_BYTES;
    const packets = planDirectOriginalRepairPartitions({ reading: state.reading, request, context, maxBytes,
      buildPrompt: (packet, index, total) => buildDirectOriginalRepairPartitionPrompt(packet.request,
        input.sourcePackage, packet.targetItems, packet.context, index, total) });
    const prompts = packets.map((packet, index) => assertDirectOriginalPromptBudget(buildDirectOriginalRepairPartitionPrompt(
      packet.request, input.sourcePackage, packet.targetItems, packet.context, index, packets.length), maxBytes));
    const plan: DirectOriginalSourceRefinementPlanPart[] = packets.map((packet, index) => ({ index,
      targets: packet.targets, refinementTargets: refinementContext.refinementTargets.filter((target) =>
        packet.targets.some((item) => item.nodeType === 'candidate' && item.targetId === target.candidateKey)),
      promptHash: stableHash(prompts[index]) }));
    const requestSignature = stableHash({ signature, request, sourcePackage: input.sourcePackage, context, refinementContext, plan });
    if (state.repairPartitionRecovery && (state.repairPartitionRecovery.requestSignature !== requestSignature
      || state.repairPartitionRecovery.originalReadingHash !== request.originalReadingHash
      || stableHash(state.repairPartitionRecovery.plan) !== stableHash(plan))) {
      // 已保存分包不能在授权、事实版本、规则或目标变化后冒充当前读取；保留断点等待正式恢复。
      throw new Error('DIRECT_ORIGINAL_REPAIR_RECOVERY_SCOPE_CHANGED');
    }
    if (!state.repairPartitionRecovery) {
      if (state.repairRecovery?.response) throw new Error('DIRECT_ORIGINAL_REPAIR_RECOVERY_SCOPE_CHANGED');
      state.repairPartitionRecovery = { version: 1, requestSignature, originalReadingHash: request.originalReadingHash,
        plan, parts: packets.map((_, index) => ({ index })) };
      this.saveCheckpoint(documentId, signature, state);
    }
    const partitionRecovery = state.repairPartitionRecovery;
    const allResults = new Map<string, DirectOriginalReadingRepair['results'][number]>();
    const mappings: NonNullable<DirectOriginalReadingRepair['sourceMappings']> = [];
    const completedParts: DirectOriginalSourceRefinementPart[] = [];
    const nextExcerptReceipts = { ...state.excerptReceipts };
    const originalReceipt = state.receipt;
    let lastReceipt: Receipt | undefined;
    let outcome: RepairOutcome = 'applied';
    for (const [index, packet] of packets.entries()) {
      const savedPart = partitionRecovery.parts[index]!;
      const partSignature = directOriginalSourceRefinementPartSignature(refinementContext, plan, index);
      let result: Awaited<ReturnType<DirectOriginalExtractionPipeline['runTurn']>> | undefined;
      const recovery = savedPart.recovery;
      if (recovery && (recovery.requestSignature !== partSignature || recovery.originalReadingHash !== request.originalReadingHash)) {
        throw new Error('DIRECT_ORIGINAL_REPAIR_RECOVERY_SCOPE_CHANGED');
      }
      if (recovery?.response) result = recovery.response;
      else if (recovery?.phase !== 'validated' && recovery?.phase !== 'exhausted') {
        // 旧单包发生过传输未知时，分包不把它的已用预算归零。
        const previousAttempts = recovery?.transportAttempts ?? state.repairRecovery?.transportAttempts ?? 0;
        if (previousAttempts >= REPAIR_TRANSPORT_ATTEMPT_LIMIT) {
          savedPart.recovery = { version: 1, requestSignature: partSignature, originalReadingHash: request.originalReadingHash,
            scopeHistory: [], phase: 'exhausted', transportAttempts: REPAIR_TRANSPORT_ATTEMPT_LIMIT };
        } else {
          savedPart.recovery = { version: 1, requestSignature: partSignature, originalReadingHash: request.originalReadingHash,
            scopeHistory: [], phase: 'in_flight', transportAttempts: previousAttempts + 1 };
          this.saveCheckpoint(documentId, signature, state);
          try {
            result = await this.runTurn(documentId, 'repair_extraction', { prompt: prompts[index]!,
              imagePaths: prepared.imagePaths, outputSchema: repairOutputSchema,
              allowWebSearch: false, timeoutMs: HEALTH_MODEL_TURN_TIMEOUT_MS }, partSignature);
            this.guard(documentId);
          } catch (error) {
            if (!this.store.isOpen()) throw error;
            this.guard(documentId);
            savedPart.recovery.phase = isStructuredOutputFailure(error) ? 'validated' : 'transport_unknown';
            this.saveCheckpoint(documentId, signature, state);
            if (!isStructuredOutputFailure(error)) throw error;
          }
          if (result) {
            savedPart.recovery = { ...savedPart.recovery, phase: 'response_saved', response: result, responseHash: stableHash(result) };
            // 每包回执先落盘；下包失败或合并前退出都不重发已经取得的有效内容。
            this.saveCheckpoint(documentId, signature, state);
          }
        }
      }
      let patch: DirectOriginalReadingRepair | undefined;
      if (result) {
        lastReceipt = { threadId: result.threadId, turnId: result.turnId };
        try { patch = directOriginalReadingRepairSchema.parse(decodeDirectOriginalRepair(result.output)); }
        catch (error) {
          if (directOriginalStructureFailureReason(error) === 'DIRECT_ORIGINAL_STRUCTURE_DECODE_UNEXPECTED'
            && !(error instanceof z.ZodError)) throw error;
        }
      }
      let valid = Boolean(patch);
      if (patch && result) {
        try {
          assertNoReadOnlyComparisonReferences(patch, packet.context);
          for (const mapping of patch.sourceMappings ?? []) if (mapping.relation === 'same_original_field'
            && !plan[index]!.refinementTargets.some((target) => target.candidateKey === mapping.candidateKey
              && target.comparisonRecordKey === mapping.comparisonRecordKey)) {
            throw new Error('DIRECT_ORIGINAL_SOURCE_REFINEMENT_TARGET_UNAUTHORIZED');
          }
          for (const entry of patch.results) if (entry.action === 'replace' && entry.replacement?.nodeType === 'page') {
            const added = [...entry.replacement.value.newExcerpts ?? [], ...entry.replacement.value.newCandidates ?? []];
            if (added.some((node) => !node.localKey.startsWith(`p03part_${index + 1}_`))) {
              throw new Error('DIRECT_ORIGINAL_REPAIR_PARTITION_KEY_SCOPE_INVALID');
            }
          }
          // 先核对本包边界，随后仍执行全报告合并和全部来源/同格冲突校验。
          assembleDirectOriginalRefinementParts({ firstReading: state.reading, targets: packet.targets,
            allowedPageSourceSpanIds: request.allowedPageSourceSpanIds,
            repairPlan: [{ ...plan[index]!, index: 0 }],
            repairParts: [{ index: 0, repair: patch, repairTransmissionId: result.transmissionId, repairInputSignature: result.inputSignature }] });
          for (const entry of patch.results) allResults.set(entry.targetId, entry);
          mappings.push(...patch.sourceMappings ?? []);
          completedParts.push({ index, repair: patch, repairTransmissionId: result.transmissionId, repairInputSignature: result.inputSignature });
          for (const entry of patch.results) if (entry.action === 'replace') {
            const changed = entry.replacement?.nodeType === 'excerpt' ? [entry.replacement.value]
              : entry.replacement?.nodeType === 'page' ? entry.replacement.value.newExcerpts ?? [] : [];
            for (const excerpt of changed) nextExcerptReceipts[excerpt.localKey] = { threadId: result.threadId, turnId: result.turnId };
          }
        } catch { valid = false; outcome = 'scope_violation'; }
      }
      if (!valid) {
        if (outcome !== 'scope_violation') outcome = savedPart.recovery?.phase === 'exhausted' ? 'transport_exhausted' : 'schema_invalid';
        for (const target of packet.targets) allResults.set(target.targetId, { targetId: target.targetId, action: 'unchanged', replacement: null });
      }
      if (savedPart.recovery?.phase === 'response_saved') savedPart.recovery.phase = 'validated';
      this.saveCheckpoint(documentId, signature, state);
    }
    const merged: DirectOriginalReadingRepair = { schemaVersion: 1, documentId, originalReadingHash: request.originalReadingHash,
      results: request.targets.map((target) => allResults.get(target.targetId)!), ...(mappings.length ? { sourceMappings: mappings } : {}) };
    try {
      const verifiedRepair = completedParts.length === packets.length
        ? assembleDirectOriginalRefinementParts({ firstReading: state.reading, targets: request.targets,
          allowedPageSourceSpanIds: request.allowedPageSourceSpanIds, repairPlan: plan, repairParts: completedParts }) : merged;
      const nextReading = assembleDirectOriginalReadingRepair({ original: state.reading, repair: verifiedRepair,
        originalReadingHash: request.originalReadingHash, targets: request.targets, allowedPageSourceSpanIds: request.allowedPageSourceSpanIds });
      if (completedParts.length === packets.length && state.firstReading && state.firstTransmissionId && state.firstInputSignature
        && stableHash(state.firstReading) === request.originalReadingHash && mappings.length) {
        state.sourceRefinementReview = { ...refinementContext, repair: verifiedRepair,
          firstTransmissionId: state.firstTransmissionId, firstInputSignature: state.firstInputSignature,
          repairTransmissionId: completedParts[0]!.repairTransmissionId,
          repairInputSignature: directOriginalSourceRefinementReviewSignature(refinementContext), repairPlan: plan, repairParts: completedParts };
      }
      const dateReviewTargets = request.targets.filter((target) => target.nodeType === 'candidate' || target.nodeType === 'metadata'
        || target.nodeType === 'excerpt' && nextReading.sourceExcerpts.some((excerpt) =>
          excerpt.localKey === target.targetId && excerpt.role === 'date'));
      if (input.dateCorrection && completedParts.length === packets.length && lastReceipt
        && dateReviewTargets.every((target) => verifiedRepair.results.some((entry) => entry.targetId === target.targetId && entry.action === 'replace'))
        && partitionRecovery.parts.every((part) => part.recovery?.response
          && originalReceipt.threadId !== part.recovery.response.threadId && originalReceipt.turnId !== part.recovery.response.turnId)) {
        state.dateCorrectionReview = { readingHash: stableHash(nextReading), firstReceipt: originalReceipt, reviewReceipt: lastReceipt };
      }
      state.reading = nextReading; state.excerptReceipts = nextExcerptReceipts;
    } catch { delete state.sourceRefinementReview; outcome = 'scope_violation'; }
    if (lastReceipt) state.receipt = lastReceipt;
    state.repairAttempted = true;
    this.saveCheckpoint(documentId, signature, state);
    return outcome;
  }

  private saveCheckpoint(documentId: string, signature: string, state: ReadingCheckpoint): void {
    this.store.saveExtractionChunkCheckpoint({ guard: this.guard(documentId), documentId, signature, chunkIndex: 0,
      output: state, threadId: state.receipt.threadId, turnId: state.receipt.turnId, extractionTurnId: state.receipt.turnId });
  }

  private hold(documentId: string, reason: string, evidenceRefs: string[], candidateOptions: ObservationCandidate[],
    receipt?: Receipt, reportedName?: string, additionalReasons: string[] = [], readingAudit?: ReportReadingAudit): ExtractionPipelineResult {
    const guard = this.guard(documentId);
    const identity = Boolean(reportedName);
    if (!identity && this.store.isDateCorrectionJob(guard.jobId)) {
      const issueId = this.store.saveExtractionReviewIssue({ documentId, jobId: guard.jobId, attemptId: guard.attemptId,
        stage: 'extract', kind: 'field_conflict', severity: 'warning', preserveDocumentStatus: true,
        evidenceRefs, candidateOptions, reasonCodes: [...new Set([reason, ...additionalReasons])] });
      return { status: 'partial', documentId, candidateCount: 0, issueId, reason, requiresUser: false,
        revision: this.store.getFactRevision(this.store.getDocumentExtractionBundle(documentId).personId), ...receipt };
    }
    if (!identity && this.store.isDocumentCommitted(documentId)) {
      const existing = this.store.listOpenExtractionReviewIssues().find((issue) =>
        issue.documentId === documentId && issue.severity === 'warning' && issue.stage === 'extract');
      const bundle = this.store.getDocumentExtractionBundle(documentId);
      const candidates = [...new Map([...(existing?.candidateOptions ?? []), ...candidateOptions]
        .map((candidate) => [stableHash({ ...candidate, localKey: '' }), candidate])).values()];
      const result = this.store.appendCommittedFacts({ personId: bundle.personId, documentId,
        expectedRevision: this.store.getFactRevision(bundle.personId), observations: [],
        summary: '保留原有可靠事实，本次原件读取缺口暂不纳入', reviewUpdate: {
          issueId: existing?.id ?? null, remainingCandidates: candidates,
          remainingReasonCodes: [...new Set([...(existing?.reasonCodes ?? []), reason, ...additionalReasons])],
          remainingEvidenceRefs: [...new Set([...(existing?.evidenceRefs ?? []), ...evidenceRefs])] }, executionGuard: guard });
      if (!result.reviewIssueId) throw new Error('COMMITTED_REVIEW_RECEIPT_MISSING');
      return { status: 'partial', documentId, candidateCount: 0, issueId: result.reviewIssueId, reason,
        revision: result.revision, requiresUser: false, ...receipt };
    }
    const issueId = identity && this.store.isDocumentCommitted(documentId)
      ? this.store.saveCommittedIdentityReviewIssue({ documentId, reportedName: reportedName!, evidenceRefs,
        reasonCodes: [reason], executionGuard: guard })
      : this.store.saveExtractionReviewIssue({ documentId, jobId: guard.jobId, attemptId: guard.attemptId,
        stage: 'extract', kind: identity ? 'person_conflict' : 'coverage_gap', severity: 'blocking',
        evidenceRefs, candidateOptions, reasonCodes: [...new Set([reason, ...additionalReasons])],
        ...(readingAudit ? { readingAudit } : {}),
        ...(reportedName ? { reportedName } : {}) });
    return { status: 'partial', documentId, candidateCount: 0, issueId, reason, requiresUser: false, ...receipt };
  }
}
