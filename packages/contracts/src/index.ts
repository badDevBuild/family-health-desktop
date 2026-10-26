import { z } from 'zod';
export { containsEditorialInstruction, containsProcessNarrative, presentAssessmentText, type PresentedAssessmentText } from './health-content-presentation.js';
export { documentedPlanEvidence, inspectDocumentedPlanEvidence, DOCUMENTED_PLAN_NEUTRAL_TITLE } from './documented-plan-evidence.js';
export type { DocumentedPlanEvidenceCheck } from './documented-plan-evidence.js';
export { reviewedSourceInstructionEvidence } from './reviewed-source-instruction.js';
import { actionStatusSchema } from './action-status.js';
import { clinicalContextSchema } from './clinical-context.js';
import { memberEvidenceRefSchema } from './member-v2.js';
import { sourceModelEvidenceSchema } from './direct-original-reading.js';
import { processingRebuildSourceIdentitySchema } from './processing-rebuild.js';

export * from './member-v2.js';
export * from './member-assessment-v3.js';
export * from './action-status.js';
export * from './clinical-context.js';

export const idSchema = z.string().min(1).max(120);
export const utcTimestampSchema = z.string().datetime({ offset: true });
export const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
}, 'Invalid calendar date');

export const resultErrorSchema = z.object({
  code: z.string().min(1),
  messageKey: z.string().min(1),
  retryable: z.boolean(),
  action: z.enum(['login', 'review', 'retry', 'select_file', 'settings']).optional(),
  correlationId: idSchema
}).strict();

export type Result<T> =
  | { ok: true; data: T; revision?: number }
  | { ok: false; error: z.infer<typeof resultErrorSchema> };

export const dataQualitySchema = z.enum(['complete', 'partial', 'insufficient']);
export const derivedStatusSchema = z.enum(['current', 'stale', 'building', 'unavailable']);
export const abnormalFlagSchema = z.enum([
  'high',
  'low',
  'positive',
  'negative',
  'normal',
  'unknown'
]);

export const candidateValueSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('numeric'),
    rawText: z.string(),
    decimal: z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/),
    comparator: z.enum(['eq', 'lt', 'lte', 'gt', 'gte'])
  }).strict(),
  z.object({
    kind: z.literal('qualitative'),
    rawText: z.string(),
    category: z.string().nullable()
  }).strict(),
  z.object({
    kind: z.literal('text'),
    rawText: z.string()
  }).strict(),
  z.object({
    kind: z.literal('unknown'),
    rawText: z.string().nullable(),
    reason: z.string().min(1)
  }).strict()
]);

export type CandidateValue = z.infer<typeof candidateValueSchema>;

export const evidenceRefSchema = z.object({
  sourceSpanId: idSchema,
  quote: z.string().nullable(),
  // 同一次检查在摘要页和明细页重复出现时，仍只生成一个观测，
  // 但保留第二处来源。字段可选以保持旧任务和旧工作区可读。
  sourceRole: z.enum(['primary', 'duplicate_source']).optional(),
  duplicateBasis: z.enum(['report_structure', 'exam_item_id', 'sample_id']).nullable().optional()
}).strict();

// 栏目标题与具体发现的依据分开：标题可以重复，不承担正式事实身份。
// 模型只指出原文位置；永久编号和唯一来源绑定由应用核验后分配。
export const observationSourceBindingSchema = z.object({
  headingEvidence: z.array(evidenceRefSchema),
  findingEvidence: z.array(evidenceRefSchema).min(1),
  // 行列身份来自同一原页的真实锚点，不接受模型任意命名的 cellId/rowId。
  // 缺省保持旧回执兼容；一旦提供，接纳层必须完整验证，不能降级忽略坏槽位。
  structuredSlot: z.object({
    version: z.literal(1),
    kind: z.enum(['table_cell', 'labeled_component']),
    contextEvidence: z.array(evidenceRefSchema).min(1).max(1),
    rowEvidence: z.array(evidenceRefSchema).min(1).max(6),
    columnEvidence: z.array(evidenceRefSchema).max(6),
    axes: z.array(z.object({
      kind: z.enum(['time', 'laterality', 'body_site', 'frequency', 'method', 'unit']),
      evidence: z.array(evidenceRefSchema).min(1).max(6)
    }).strict()).max(6),
    component: z.object({
      kind: z.enum(['quantitative', 'qualitative', 'narrative']),
      evidence: z.array(evidenceRefSchema).min(1).max(6)
    }).strict().nullable()
  }).strict().optional()
}).strict();
export type ObservationSourceBinding = z.infer<typeof observationSourceBindingSchema>;

export const observationCandidateSchema = z.object({
  localKey: idSchema,
  originalName: z.string().min(1),
  standardNameCandidate: z.string().nullable(),
  value: candidateValueSchema,
  unitRaw: z.string().nullable(),
  referenceRangeRaw: z.string().nullable(),
  reportedAbnormalFlag: z.string().nullable(),
  specimen: z.string().nullable(),
  method: z.string().nullable(),
  bodySite: z.string().nullable(),
  clinicalDate: localDateSchema.nullable(),
  // 缺字段表示旧版本尚未检查，不能把它当成“没有额外条件”。
  clinicalContext: clinicalContextSchema.nullable().optional(),
  evidence: z.array(evidenceRefSchema).min(1),
  // 可选扩展，旧候选仍可读取；缺失时应用只能从旧引用作保守定位。
  sourceBinding: observationSourceBindingSchema.optional(),
  issues: z.array(z.object({
    code: z.string().min(1),
    message: z.string().min(1)
  }).strict())
}).strict();

export type ObservationCandidate = z.infer<typeof observationCandidateSchema>;

/** 来源闭包共用此目录，避免新行列引用在修复、保留义务或保存时遗漏。 */
export function observationStructuredSlotEvidence(candidate: ObservationCandidate): ObservationCandidate['evidence'] {
  const slot = candidate.sourceBinding?.structuredSlot;
  return slot ? [...slot.contextEvidence, ...slot.rowEvidence, ...slot.columnEvidence,
    ...slot.axes.flatMap((axis) => axis.evidence), ...(slot.component?.evidence ?? [])] : [];
}

const metadataTextFieldSchema = z.object({
  value: z.string().trim().min(1).max(500),
  evidence: z.array(evidenceRefSchema).min(1)
}).strict();

const partialClinicalDateSchema = z.string().regex(/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/).refine((value) => {
  const parts = value.split('-').map(Number);
  if (parts.length === 1) return parts[0]! >= 1900 && parts[0]! <= 2200;
  const [year, month, day] = parts;
  if (!year || !month || month < 1 || month > 12) return false;
  if (day === undefined) return true;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}, 'Invalid partial clinical date');

export const reportMetadataCandidateSchema = z.object({
  reportKind: metadataTextFieldSchema.nullable(),
  title: metadataTextFieldSchema.nullable(),
  organization: metadataTextFieldSchema.nullable(),
  campus: metadataTextFieldSchema.nullable(),
  department: metadataTextFieldSchema.nullable(),
  reportNumber: metadataTextFieldSchema.nullable(),
  // 只保留报告明示的同次就诊/检查批次标识和样本标识。
  // 它们是跨文件事件关联的强证据，不得由同日或同值推断。
  encounterIdentifier: metadataTextFieldSchema.nullable().optional(),
  sampleIdentifiers: z.array(metadataTextFieldSchema).optional(),
  examItems: z.array(metadataTextFieldSchema),
  // 原件模型明确选择本次报告的主要临床时间；null 表示无法可靠选择，不取数组首项猜测。
  // 可选仅用于读取旧版回执，索引指向的角色和真实来源由接纳门禁核验。
  primaryClinicalTimeIndex: z.number().int().min(0).nullable().optional(),
  times: z.array(z.object({
    value: partialClinicalDateSchema,
    precision: z.enum(['year', 'month', 'day']),
    role: z.enum(['sampled', 'examined', 'encounter', 'report_issued', 'history_quoted', 'unknown']),
    evidence: z.array(evidenceRefSchema).min(1)
  }).strict().refine((time) => time.value.split('-').length === ({ year: 1, month: 2, day: 3 } as const)[time.precision], 'Date precision does not match value'))
}).strict();
export type ReportMetadataCandidate = z.infer<typeof reportMetadataCandidateSchema>;

export const extractionResultSchema = z.object({
  schemaVersion: z.literal(1),
  documentId: idSchema,
  subject: z.object({
    reportedName: z.string().trim().min(1).max(120).nullable(),
    evidence: z.array(evidenceRefSchema),
    confidence: z.enum(['explicit', 'absent', 'uncertain'])
  }).strict(),
  reportMetadata: reportMetadataCandidateSchema.nullable().optional(),
  coveredSourceSpanIds: z.array(idSchema),
  candidates: z.array(observationCandidateSchema)
}).strict();

export type ExtractionResult = z.infer<typeof extractionResultSchema>;

export const derivedClaimSchema = z.object({
  id: idSchema,
  organId: z.enum(['cardiovascular', 'metabolic', 'hepatobiliary', 'renal', 'digestive', 'hematology', 'respiratory', 'sensory']).nullable(),
  level: z.enum(['fact', 'trend', 'association', 'action']),
  title: z.string().min(1).max(120),
  explanation: z.string().min(1).max(800),
  evidenceObservationIds: z.array(idSchema).min(1),
  boundaryNote: z.string().max(300).nullable()
}).strict();

export const generalKnowledgeEvidenceCandidateSchema = z.object({
  id: idSchema,
  sourceTitle: z.string().min(1).max(240),
  sourceOrganization: z.string().min(1).max(160),
  sourceUrl: z.string().url().refine((value) => value.startsWith('https://'), 'Knowledge source must use HTTPS'),
  reviewedAt: localDateSchema,
  supportedScope: z.string().min(1).max(500)
}).strict();

export const lifestyleGuidanceCandidateSchema = z.object({
  id: idSchema,
  dedupeKey: z.string().trim().min(1).max(120),
  category: z.enum(['exercise', 'diet', 'sleep', 'monitoring', 'review', 'other']),
  title: z.string().min(1).max(120),
  goal: z.string().min(1).max(300),
  rationale: z.string().min(1).max(800),
  detail: z.string().min(1).max(800),
  steps: z.array(z.string().min(1).max(300)).min(1).max(8),
  startingOptions: z.array(z.string().min(1).max(300)).min(1).max(4),
  scheduleSuggestion: z.string().min(1).max(300).nullable(),
  trackingSuggestion: z.string().min(1).max(300),
  constraints: z.array(z.string().min(1).max(500)).max(12),
  uncertainties: z.array(z.string().min(1).max(500)).max(12),
  evidenceObservationIds: z.array(idSchema).min(1),
  generalKnowledgeEvidence: z.array(generalKnowledgeEvidenceCandidateSchema).max(8),
  sourceKind: z.enum(['ai_proposed', 'clinician_reported', 'care_preparation']),
  relatedSystemIds: z.array(idSchema).max(12),
  consultProfessional: z.boolean()
}).strict().superRefine((guidance, context) => {
  if (guidance.sourceKind === 'ai_proposed' && guidance.generalKnowledgeEvidence.length === 0) {
    context.addIssue({ code: 'custom', path: ['generalKnowledgeEvidence'], message: 'AI lifestyle proposal requires general knowledge evidence' });
  }
});
export type LifestyleGuidanceCandidate = z.infer<typeof lifestyleGuidanceCandidateSchema>;

export const derivedSnapshotCandidateSchema = z.object({
  schemaVersion: z.literal(1),
  personId: idSchema,
  factRevision: z.number().int().nonnegative(),
  dataQuality: dataQualitySchema,
  claims: z.array(derivedClaimSchema).max(40),
  lifestyleGuidance: z.array(lifestyleGuidanceCandidateSchema).max(20)
}).strict();

export type DerivedSnapshotCandidate = z.infer<typeof derivedSnapshotCandidateSchema>;

export const derivedSafetyReviewSchema = z.object({
  schemaVersion: z.literal(1),
  personId: idSchema,
  factRevision: z.number().int().nonnegative(),
  overallSafe: z.boolean(),
  claimReviews: z.array(z.object({
    claimId: idSchema,
    supported: z.boolean(),
    safe: z.boolean(),
    issue: z.string().nullable()
  }).strict()),
  guidanceReviews: z.array(z.object({
    guidanceId: idSchema,
    supported: z.boolean(),
    safe: z.boolean(),
    issue: z.string().nullable()
  }).strict())
}).strict();

export type DerivedSafetyReview = z.infer<typeof derivedSafetyReviewSchema>;

export * from './processing-rebuild.js';

// 原图中的位置只来自受控本机识别，不把几何排版结果当作医学事实。
const visualBoundsSchema = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1),
  z.number().positive().max(1), z.number().positive().max(1)])
  .refine(([x, y, width, height]) => x + width <= 1.000001 && y + height <= 1.000001);
const visualTextBoxSchema = z.object({
  text: z.string().max(16_384), confidence: z.number().min(0).max(1), bounds: visualBoundsSchema
}).strict();
export const sourceVisualEvidenceSchema = z.object({
  version: z.literal(1), engine: z.literal('apple-vision-local-v1'),
  layoutVersion: z.literal('local-visual-layout-v2'), coordinateSystem: z.literal('normalized-bottom-left'),
  imageSize: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict().optional(),
  recognitionRevision: z.number().int().nonnegative().optional(),
  reading: z.object({ mode: z.enum(['full_image', 'region']), regionBounds: visualBoundsSchema.optional(),
    fallbackUsed: z.boolean() }).strict(),
  rows: z.array(z.object({ line: z.number().int().positive(), text: z.string(), bounds: visualBoundsSchema,
    boxes: z.array(visualTextBoxSchema).max(10_000) }).strict()).max(10_000),
  omittedBoxes: z.array(visualTextBoxSchema).max(10_000)
}).strict().superRefine((value, context) => {
  if ((value.reading.mode === 'region') !== Boolean(value.reading.regionBounds)) {
    context.addIssue({ code: 'custom', message: 'VISUAL_REGION_BOUNDARY_REQUIRED', path: ['reading'] });
  }
});
export type SourceVisualEvidence = z.infer<typeof sourceVisualEvidenceSchema>;

export const sourceSpanSchema = z.object({
  id: idSchema,
  documentId: idSchema,
  spanKind: z.enum(['page', 'block', 'image', 'line', 'table_cell']),
  page: z.number().int().positive().nullable(),
  blockId: z.string().nullable(),
  lineStart: z.number().int().positive().nullable(),
  lineEnd: z.number().int().positive().nullable(),
  quote: z.string().nullable(),
  readability: z.enum(['clear', 'partial', 'unreadable']),
  visualEvidence: sourceVisualEvidenceSchema.optional(),
  modelEvidence: sourceModelEvidenceSchema.optional()
}).strict();

export type SourceSpan = z.infer<typeof sourceSpanSchema>;

export const sourceManifestSchema = z.object({
  id: idSchema,
  sourceObjectId: idSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mediaType: z.string().min(1),
  originalDisplayName: z.string().min(1),
  totalUnits: z.number().int().positive(),
  coveredUnitIndexes: z.array(z.number().int().nonnegative()),
  spans: z.array(sourceSpanSchema),
  normalizerVersion: z.string().min(1),
  conversionWarnings: z.array(z.string()),
  createdAt: utcTimestampSchema
}).strict();

export type SourceManifest = z.infer<typeof sourceManifestSchema>;

export const personSchema = z.object({
  id: idSchema,
  displayName: z.string().trim().min(1).max(80),
  relation: z.string().trim().max(40).nullable(),
  birthYear: z.number().int().min(1900).max(2200).nullable(),
  genderContext: z.string().trim().max(120).nullable(),
  displayRevision: z.number().int().nonnegative(),
  clinicalContextRevision: z.number().int().nonnegative(),
  archivedAt: utcTimestampSchema.nullable()
}).strict();

export type Person = z.infer<typeof personSchema>;

export const manualNoteSchema = z.object({
  id: idSchema,
  personId: idSchema,
  kind: z.enum(['history', 'allergy', 'medication', 'self_measurement', 'goal', 'constraint', 'free_text']),
  immutableText: z.string().min(1),
  effectiveDate: localDateSchema.nullable(),
  sourceKind: z.literal('user_reported'),
  structuredFields: z.record(z.string(), z.string()),
  revision: z.number().int().positive(),
  recordedAt: utcTimestampSchema
}).strict();

export type ManualNote = z.infer<typeof manualNoteSchema>;

export const createManualNoteInputSchema = z.object({
  personId: idSchema,
  kind: z.enum(['history', 'allergy', 'medication', 'self_measurement', 'goal', 'constraint', 'free_text']),
  immutableText: z.string().trim().min(1).max(4_000),
  effectiveDate: localDateSchema.nullable(),
  structuredFields: z.record(z.string().min(1).max(80), z.string().max(500)),
  expectedContextRevision: z.number().int().nonnegative()
}).strict().superRefine((value, context) => {
  if (value.kind !== 'self_measurement') return;
  if (!value.structuredFields.measurementName?.trim()) {
    context.addIssue({ code: 'custom', path: ['structuredFields', 'measurementName'], message: '自测项目不能为空' });
  }
  if (!value.structuredFields.value?.trim()) {
    context.addIssue({ code: 'custom', path: ['structuredFields', 'value'], message: '自测结果不能为空' });
  }
});

export type CreateManualNoteInput = z.infer<typeof createManualNoteInputSchema>;

export const exportMemberSummaryInputSchema = z.object({
  personId: idSchema,
  format: z.enum(['pdf', 'html', 'json']),
  dateFrom: localDateSchema.nullable(),
  dateTo: localDateSchema.nullable(),
  confirmedPrivacyNotice: z.literal(true)
}).strict().refine((value) => !value.dateFrom || !value.dateTo || value.dateFrom <= value.dateTo, {
  path: ['dateTo'],
  message: '结束日期不能早于开始日期'
});

export type ExportMemberSummaryInput = z.infer<typeof exportMemberSummaryInputSchema>;

export const exportMemberSummaryReceiptSchema = z.object({
  displayName: z.string().min(1),
  format: z.enum(['pdf', 'html', 'json']),
  exportedAt: utcTimestampSchema
}).strict();

export type ExportMemberSummaryReceipt = z.infer<typeof exportMemberSummaryReceiptSchema>;

export const diagnosticBundleSchema = z.object({
  formatVersion: z.literal(1),
  generatedAt: utcTimestampSchema,
  application: z.object({
    version: z.string().min(1),
    platform: z.string().min(1),
    arch: z.string().min(1),
    runtimeVersion: z.string().nullable(),
    runtimeStatus: z.enum(['connected', 'connecting', 'disconnected', 'expired', 'error'])
  }).strict(),
  workspace: z.object({
    mode: z.enum(['demo', 'personal']),
    personCount: z.number().int().nonnegative(),
    documentCount: z.number().int().nonnegative(),
    pendingInboxCount: z.number().int().nonnegative(),
    actionCount: z.number().int().nonnegative(),
    openReviewCount: z.number().int().nonnegative(),
    queuePaused: z.boolean(),
    scheduleEnabled: z.boolean()
  }).strict(),
  taskSummary: z.object({
    total: z.number().int().nonnegative(),
    statuses: z.array(z.object({ status: z.string().min(1), count: z.number().int().nonnegative() }).strict()),
    stages: z.array(z.object({ stage: z.string().min(1), count: z.number().int().nonnegative() }).strict())
  }).strict(),
  privacy: z.object({
    telemetryEnabled: z.literal(false),
    containsHealthContent: z.literal(false),
    containsFileNames: z.literal(false),
    containsPaths: z.literal(false),
    containsCredentials: z.literal(false)
  }).strict()
}).strict();

export type DiagnosticBundle = z.infer<typeof diagnosticBundleSchema>;

export const diagnosticExportReceiptSchema = z.object({
  displayName: z.string().min(1),
  generatedAt: utcTimestampSchema
}).strict();

export type DiagnosticExportReceipt = z.infer<typeof diagnosticExportReceiptSchema>;

export const cleanupReceiptSchema = z.object({
  temporaryEntriesRemoved: z.number().int().nonnegative(),
  terminalTaskAttemptsRemoved: z.number().int().nonnegative(),
  codexSessionDataRemoved: z.literal(false),
  explanation: z.string().min(1)
}).strict();

export type CleanupReceipt = z.infer<typeof cleanupReceiptSchema>;

export const taskStageSchema = z.enum([
  'normalize',
  'identify',
  'extract',
  'review_facts',
  'accept_facts',
  'analyze',
  'guidance',
  'review_derived',
  'system_analysis',
  'system_review',
  'publish'
]);

export const jobStatusSchema = z.enum([
  'queued',
  'running',
  'waiting_auth',
  'waiting_quota',
  'waiting_user',
  'retry_wait',
  'succeeded',
  'completed_with_issues',
  'failed',
  'cancelled'
]);

export const healthTaskEnvelopeSchema = z.object({
  taskId: idSchema,
  stage: z.enum(['extract', 'review_facts', 'analyze', 'guidance', 'review_derived', 'system_analysis', 'system_review']),
  personId: idSchema,
  sourceSpanIds: z.array(idSchema),
  inputSignature: z.string().regex(/^[a-f0-9]{64}$/),
  expectedFactRevision: z.number().int().nonnegative(),
  clinicalContextRevision: z.number().int().nonnegative(),
  promptVersion: z.string().min(1),
  rulesVersion: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  consentId: idSchema,
  payload: z.unknown()
}).strict();

export type HealthTaskEnvelope = z.infer<typeof healthTaskEnvelopeSchema>;

export const acceptanceDecisionSchema = z.object({
  id: idSchema,
  method: z.enum(['auto', 'user_resolution']),
  actorType: z.enum(['policy', 'user']),
  decision: z.enum(['accept', 'accept_with_warnings', 'reject', 'needs_review']),
  rulesVersion: z.string().min(1),
  inputSignature: z.string().regex(/^[a-f0-9]{64}$/),
  outputHash: z.string().regex(/^[a-f0-9]{64}$/),
  reviewJobIds: z.array(idSchema),
  warnings: z.array(z.string()),
  decidedAt: utcTimestampSchema
}).strict();

export type AcceptanceDecision = z.infer<typeof acceptanceDecisionSchema>;

export const reviewCandidateDiffSchema = z.object({
  localKey: idSchema,
  itemName: z.string().min(1),
  fields: z.array(z.enum([
    'presence',
    'originalName',
    'standardNameCandidate',
    'value',
    'unitRaw',
    'referenceRangeRaw',
    'reportedAbnormalFlag',
    'specimen',
    'method',
    'bodySite',
    'clinicalDate',
    'issues'
  ])).min(1),
  // 保存两次独立读取的完整候选，界面才能真正向用户解释“哪里不同”。
  // optional 保持旧工作区中既有核对事项可读。
  firstCandidate: observationCandidateSchema.nullable().optional(),
  secondCandidate: observationCandidateSchema.nullable().optional()
}).strict();

export type ReviewCandidateDiff = z.infer<typeof reviewCandidateDiffSchema>;

export const actionItemSchema = z.object({
  id: idSchema,
  personId: idSchema,
  title: z.string().min(1),
  detail: z.string(),
  origin: z.enum(['clinician_document', 'user_created', 'ai_proposed']),
  status: actionStatusSchema,
  dueDate: localDateSchema.nullable(),
  dueText: z.string().nullable(),
  userScheduleText: z.string().nullable().optional(),
  completedAt: utcTimestampSchema.nullable().optional(),
  evidenceRefs: z.array(memberEvidenceRefSchema).optional(),
  evidenceLabel: z.string().nullable(),
  userRevision: z.number().int().positive(),
  updatedAt: utcTimestampSchema
}).strict();

export type ActionItem = z.infer<typeof actionItemSchema>;

export const reportReadingLedgerSchema = z.object({
  version: z.literal(1),
  scope: z.enum(['full_report', 'selected_pages']),
  baseAuditId: idSchema.optional(),
  totalOriginalPages: z.number().int().positive().optional(),
  originalSha256: z.string().regex(/^[a-f0-9]{64}$/),
  promptVersion: z.string().min(1), rulesVersion: z.string().min(1),
  pages: z.array(z.object({
    sourceSpanId: idSchema, page: z.number().int().positive().nullable(),
    status: z.enum(['read','partial','unreadable','no_medical_content']),
    pageRole: z.enum(['results', 'mixed', 'education', 'reference', 'cover', 'duplicate_summary', 'unknown']).optional(),
    inventory: z.array(z.object({ sourceKey: z.string(), sourceSpanId: idSchema.nullable(),
      candidateKeys: z.array(z.string()), classification: z.object({
        disposition: z.enum(['education','reference','duplicate_summary']),
        evidence: z.array(z.object({ sourceSpanId: idSchema, quote: z.string() }).strict()),
        duplicateSourceSpanId: idSchema.nullable()
      }).strict().optional() }).strict()).nullable()
  }).strict()),
  candidates: z.array(z.object({
    localKey: z.string(), originalName: z.string(), value: candidateValueSchema, unitRaw: z.string().nullable(),
    disposition: z.enum(['saved_or_existing','original_no_result','pending']),
    evidence: z.array(evidenceRefSchema), reasonCodes: z.array(z.string())
  }).strict()),
  unrepresentedSources: z.array(z.object({ sourceSpanId: idSchema, pageSourceSpanId: idSchema,
    role: z.enum(['finding','instruction']), clarity: z.enum(['clear','uncertain']) }).strict()),
  gapPageSourceSpanIds: z.array(idSchema)
}).strict().refine(ledger => ledger.scope !== 'selected_pages' || ledger.baseAuditId !== undefined
  && ledger.totalOriginalPages !== undefined && ledger.totalOriginalPages >= ledger.pages.length,
  'REPORT_READING_LEDGER_SCOPE_INVALID');
export type ReportReadingLedger = z.infer<typeof reportReadingLedgerSchema>;

export const reportSupplementScopeSchema = z.object({
  version: z.literal(1), documentId: idSchema, personId: idSchema,
  originalSha256: z.string().regex(/^[a-f0-9]{64}$/), baseAuditId: idSchema,
  pageSourceSpanIds: z.array(idSchema).min(1).max(1_500),
  preservationSignature: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
export type ReportSupplementScope = z.infer<typeof reportSupplementScopeSchema>;

export const reportReadingAuditSchema = z.object({
  version: z.literal(1),
  totalCandidates: z.number().int().nonnegative(),
  savedCandidates: z.number().int().nonnegative(),
  emptyCandidates: z.number().int().nonnegative(),
  pending: z.array(z.object({ localKey: z.string(), originalName: z.string(), reasonCodes: z.array(z.string()) }).strict()),
  historicalReadingCount: z.number().int().nonnegative(),
  unrepresentedSourceCount: z.number().int().nonnegative(),
  pageGapCount: z.number().int().nonnegative(),
  // 旧聚合审计继续可读，但不能补造为已有逐项完整记录。
  ledger: reportReadingLedgerSchema.optional()
}).strict().refine((audit) => audit.totalCandidates === audit.savedCandidates + audit.emptyCandidates + audit.pending.length,
  'REPORT_READING_ACCOUNTING_MISMATCH').refine(audit => !audit.ledger || (
    audit.ledger.candidates.length === audit.totalCandidates
    && new Set(audit.ledger.candidates.map(item => item.localKey)).size === audit.totalCandidates
    && audit.ledger.candidates.filter(item => item.disposition === 'saved_or_existing').length === audit.savedCandidates
    && audit.ledger.candidates.filter(item => item.disposition === 'original_no_result').length === audit.emptyCandidates
    && audit.ledger.candidates.filter(item => item.disposition === 'pending').every(item => audit.pending.some(pending => pending.localKey === item.localKey))
    && audit.ledger.unrepresentedSources.length === audit.unrepresentedSourceCount
    && new Set(audit.ledger.unrepresentedSources.map(item => item.sourceSpanId)).size === audit.unrepresentedSourceCount
    && audit.ledger.gapPageSourceSpanIds.length === audit.pageGapCount
    && new Set(audit.ledger.gapPageSourceSpanIds).size === audit.pageGapCount
    && new Set(audit.ledger.pages.map(page => page.sourceSpanId)).size === audit.ledger.pages.length
  ), 'REPORT_READING_LEDGER_MISMATCH');
export type ReportReadingAudit = z.infer<typeof reportReadingAuditSchema>;

export const reviewIssueSchema = z.object({
  id: idSchema,
  personId: idSchema.nullable(),
  documentId: idSchema,
  kind: z.enum(['person_conflict', 'field_conflict', 'coverage_gap', 'overwrite_protected', 'derived_safety']),
  severity: z.enum(['blocking', 'warning']),
  title: z.string().min(1),
  description: z.string().min(1),
  evidenceRefs: z.array(idSchema),
  candidateOptions: z.array(observationCandidateSchema),
  readingAudit: reportReadingAuditSchema.optional(),
  candidateDiffs: z.array(reviewCandidateDiffSchema),
  reportedName: z.string().min(1).nullable(),
  reasonCodes: z.array(z.string().min(1)),
  resolutionStatus: z.enum(['open', 'resolved', 'deferred'])
}).strict();

export type ReviewIssue = z.infer<typeof reviewIssueSchema>;

export const accountStateSchema = z.object({
  status: z.enum(['disconnected', 'connecting', 'connected', 'expired', 'error']),
  displayLabel: z.string().nullable(),
  quota: z.object({
    status: z.enum(['available', 'low', 'exhausted', 'unknown']),
    primaryUsedPercent: z.number().min(0).max(100).nullable(),
    secondaryUsedPercent: z.number().min(0).max(100).nullable(),
    resetsAt: utcTimestampSchema.nullable()
  }).strict(),
  runtimeVersion: z.string().nullable(),
  lastCheckedAt: utcTimestampSchema.nullable()
}).strict();

export type AccountState = z.infer<typeof accountStateSchema>;

export const personSummarySchema = z.object({
  id: idSchema,
  displayName: z.string(),
  relation: z.string(),
  birthYear: z.number().int().min(1900).max(2200).nullable(),
  avatarInitial: z.string().min(1).max(2),
  lastDocumentDate: localDateSchema.nullable(),
  documentCount: z.number().int().nonnegative(),
  acceptedFactCount: z.number().int().nonnegative(),
  pendingCount: z.number().int().nonnegative(),
  attentionCount: z.number().int().nonnegative(),
  dataQuality: dataQualitySchema,
  freshnessLabel: z.string(),
  changeSummary: z.string(),
  derivedStatus: derivedStatusSchema,
  // 展示有效性与更新必要性分开：旧规则结果仍只读，但不自动变成待办或扩大处理范围。
  assessmentRefreshStatus: z.enum(['none', 'required', 'optional_rules']).optional(),
  assessmentSummary: z.string().nullable(),
  dataRevision: z.string().regex(/^[a-f0-9]{64}$/),
  displayRevision: z.number().int().nonnegative(),
  clinicalContextRevision: z.number().int().nonnegative()
}).strict();

export type PersonSummary = z.infer<typeof personSummarySchema>;

export const organSummarySchema = z.object({
  id: z.enum(['cardiovascular', 'metabolic', 'hepatobiliary', 'renal', 'digestive', 'hematology', 'respiratory', 'sensory']),
  personId: idSchema,
  name: z.string(),
  status: z.enum(['stable', 'attention', 'insufficient']),
  summary: z.string(),
  evidenceDate: localDateSchema.nullable(),
  evidenceSourceSpanId: idSchema.nullable(),
  metricCount: z.number().int().nonnegative()
}).strict();

export type OrganSummary = z.infer<typeof organSummarySchema>;

export const trendPointSchema = z.object({
  date: localDateSchema,
  displayValue: z.string(),
  numericValue: z.number().finite().nullable(),
  referenceLow: z.number().finite().nullable(),
  referenceHigh: z.number().finite().nullable(),
  abnormalFlag: abnormalFlagSchema,
  sourceLabel: z.string(),
  sourceSpanId: idSchema.nullable(),
  documentId: idSchema.nullable()
}).strict();

export const trendSeriesSchema = z.object({
  id: idSchema,
  personId: idSchema,
  name: z.string(),
  unit: z.string().nullable(),
  interpretation: z.string(),
  comparisonNote: z.string(),
  points: z.array(trendPointSchema)
}).strict();

export type TrendSeries = z.infer<typeof trendSeriesSchema>;

export const lifestyleGuidanceSummarySchema = z.object({
  id: idSchema,
  personId: idSchema,
  title: z.string(),
  detail: z.string(),
  consultProfessional: z.boolean(),
  evidenceCount: z.number().int().positive()
}).strict();

export type LifestyleGuidanceSummary = z.infer<typeof lifestyleGuidanceSummarySchema>;

export const inboxItemSchema = z.object({
  id: idSchema,
  displayName: z.string(),
  discoveredAt: utcTimestampSchema,
  personId: idSchema.nullable(),
  personLabel: z.string().nullable(),
  // 旧快照缺省时仍按未知归属处理；只有明确选择才能恢复历史姓名阻断。
  personAssignmentBasis: z.enum(['user_selected', 'folder_binding', 'identity_confirmed', 'legacy']).optional(),
  status: z.enum(['discovered', 'stabilizing', 'queued', 'processing', 'needs_review', 'completed', 'ignored', 'duplicate', 'blocked']),
  format: z.string(),
  sourceLabel: z.string(),
  sentToAi: z.boolean(),
  aiTransmissionStatus: z.enum(['not_sent', 'sending', 'acknowledged', 'completed', 'unknown']),
  inProcessingCenter: z.boolean(),
  issue: z.string().nullable(),
  // 可选以兼容旧快照；使用全量聚合，而不是最近展示窗口推断零接纳。
  acceptedFactCount: z.number().int().nonnegative().optional(),
  // 仅提示可选日期补核，不代表已证明缺失日期，也不改变报告完成状态。
  dateBindingReviewCount: z.number().int().nonnegative().optional()
}).strict();

export type InboxItem = z.infer<typeof inboxItemSchema>;

export const timelineEventSchema = z.object({
  id: idSchema,
  personId: idSchema,
  date: localDateSchema.nullable(),
  dateLabel: z.string(),
  type: z.enum(['health_report', 'manual_note']),
  title: z.string(),
  summary: z.string(),
  sourceLabel: z.string(),
  documentId: idSchema.nullable(),
  sourceSpanId: idSchema.nullable()
}).strict();

export type TimelineEvent = z.infer<typeof timelineEventSchema>;

export const jobSystemOutcomeSchema = z.object({
  systemId: idSchema,
  status: z.enum(['published', 'rejected', 'skipped_no_data', 'skipped_cache', 'out_of_scope']),
  reason: z.string().nullable(),
  inputSignature: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  updatedAt: utcTimestampSchema
}).strict();

export type JobSystemOutcome = z.infer<typeof jobSystemOutcomeSchema>;

/** 综合终态与逐份报告进度独立；只保存受控元数据，不接收模型自由正文。 */
export const jobAssessmentOutcomeSchema = z.object({
  status: z.enum(['published', 'rejected', 'skipped_no_data', 'reused_current']),
  reasonCode: z.enum(['no_accepted_facts', 'validation_failed', 'schema_invalid', 'scope_mismatch',
    'coverage_incomplete', 'focused_review_failed', 'publication_failed', 'unknown']).nullable(),
  snapshotId: idSchema.nullable(),
  inputSignature: z.string().regex(/^[a-f0-9]{64}$/),
  factRevision: z.number().int().nonnegative(),
  contextRevision: z.number().int().nonnegative(),
  reviewScopeSignature: z.string().regex(/^[a-f0-9]{64}$/),
  attemptId: idSchema,
  updatedAt: utcTimestampSchema
}).strict().superRefine((outcome, context) => {
  const published = outcome.status === 'published' || outcome.status === 'reused_current';
  if (published !== (outcome.snapshotId !== null)
    || (published && outcome.reasonCode !== null)
    || (outcome.status === 'skipped_no_data' && outcome.reasonCode !== 'no_accepted_facts')
    || (outcome.status === 'rejected' && (outcome.reasonCode === null || outcome.reasonCode === 'no_accepted_facts'))) {
    context.addIssue({ code: 'custom', message: '综合终态与快照或原因不一致' });
  }
});

export type JobAssessmentOutcome = z.infer<typeof jobAssessmentOutcomeSchema>;

export const jobSummarySchema = z.object({
  id: idSchema,
  batchLabel: z.string(),
  personLabel: z.string().nullable(),
  stage: taskStageSchema,
  status: jobStatusSchema,
  completedUnits: z.number().int().nonnegative(),
  totalUnits: z.number().int().positive(),
  statusText: z.string(),
  systemOutcomes: z.array(jobSystemOutcomeSchema),
  // 旧快照可缺省；存储投影始终返回 null，不从 publish 阶段猜测综合已发布。
  assessmentOutcome: jobAssessmentOutcomeSchema.nullable().optional(),
  updatedAt: utcTimestampSchema,
  canCancel: z.boolean(),
  canRetry: z.boolean()
}).strict();

export type JobSummary = z.infer<typeof jobSummarySchema>;

export const jobActionInputSchema = z.object({
  jobId: idSchema
}).strict();

export type JobActionInput = z.infer<typeof jobActionInputSchema>;

export const setQueuePausedInputSchema = z.object({
  paused: z.boolean()
}).strict();

export const updateDesktopBehaviorInputSchema = z.object({
  stayInTray: z.boolean(),
  openAtLogin: z.boolean(),
  notificationsEnabled: z.boolean()
}).strict();

export const displayPreferencesSchema = z.object({
  fontScale: z.enum(['standard', 'large']),
  reduceMotion: z.boolean(),
  dateStyle: z.enum(['friendly', 'numeric'])
}).strict();

export type DisplayPreferences = z.infer<typeof displayPreferencesSchema>;

export const updateDisplayPreferencesInputSchema = displayPreferencesSchema;

export const aiReasoningEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type AiReasoningEffort = z.infer<typeof aiReasoningEffortSchema>;

export const aiPreferencesSchema = z.object({
  modelId: z.string().min(1),
  reasoningEffort: aiReasoningEffortSchema
}).strict();
export type AiPreferences = z.infer<typeof aiPreferencesSchema>;
export const DEFAULT_AI_PREFERENCES: AiPreferences = {
  modelId: 'gpt-6.1-sol',
  reasoningEffort: 'medium'
};

export const aiModelOptionSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string(),
  supportedReasoningEfforts: z.array(z.object({
    reasoningEffort: aiReasoningEffortSchema,
    description: z.string()
  }).strict()).min(1),
  defaultReasoningEffort: aiReasoningEffortSchema,
  isDefault: z.boolean()
}).strict();
export type AiModelOption = z.infer<typeof aiModelOptionSchema>;

export const aiSettingsSchema = z.object({
  preferences: aiPreferencesSchema,
  models: z.array(aiModelOptionSchema)
}).strict();
export type AiSettings = z.infer<typeof aiSettingsSchema>;

export const updateAiPreferencesInputSchema = aiPreferencesSchema;

export const dashboardSnapshotSchema = z.object({
  workspaceMode: z.enum(['demo', 'personal']),
  workspaceName: z.string(),
  account: accountStateSchema,
  nextScheduledRun: utcTimestampSchema.nullable(),
  scheduleEnabled: z.boolean(),
  scheduleLocalTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  scheduleTimeZone: z.string().min(1),
  scheduleRevision: z.number().int().nonnegative(),
  queuePaused: z.boolean(),
  pendingInboxCount: z.number().int().nonnegative(),
  openReviewCount: z.number().int().nonnegative(),
  persons: z.array(personSummarySchema),
  organs: z.array(organSummarySchema),
  trends: z.array(trendSeriesSchema),
  timeline: z.array(timelineEventSchema),
  guidance: z.array(lifestyleGuidanceSummarySchema),
  inbox: z.array(inboxItemSchema),
  // 来自主进程的完整可重建原件范围，不以收件箱的展示筛选反推发送集合。
  processingRebuildSources: z.array(processingRebuildSourceIdentitySchema).optional(),
  jobs: z.array(jobSummarySchema),
  reviews: z.array(reviewIssueSchema),
  actions: z.array(actionItemSchema),
  notes: z.array(manualNoteSchema),
  privacyNotice: z.string(),
  generatedAt: utcTimestampSchema
}).strict();

export type DashboardSnapshot = z.infer<typeof dashboardSnapshotSchema>;

export const updateActionStatusInputSchema = z.object({
  actionId: idSchema,
  status: actionStatusSchema,
  expectedRevision: z.number().int().nonnegative()
}).strict();

/** 用户安排独立于原报告或健康建议中的时间要求。 */
export const updateActionScheduleInputSchema = z.object({
  personId: idSchema,
  actionId: idSchema,
  dueDate: localDateSchema.nullable(),
  userScheduleText: z.string().trim().max(200).nullable(),
  expectedRevision: z.number().int().positive()
}).strict();
export type UpdateActionScheduleInput = z.infer<typeof updateActionScheduleInputSchema>;

export const createActionItemInputSchema = z.object({
  personId: idSchema,
  title: z.string().trim().min(1).max(160),
  detail: z.string().trim().max(1_200),
  dueDate: localDateSchema.nullable(),
  dueText: z.string().trim().max(160).nullable()
}).strict();

export type CreateActionItemInput = z.infer<typeof createActionItemInputSchema>;

export const createWorkspaceInputSchema = z.object({
  workspaceName: z.string().trim().min(1).max(80),
  primaryMemberName: z.string().trim().min(1).max(80),
  relation: z.string().trim().min(1).max(40).default('本人')
}).strict();

export type CreateWorkspaceInput = z.infer<typeof createWorkspaceInputSchema>;

export const createPersonInputSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  relation: z.string().trim().min(1).max(40),
  birthYear: z.number().int().min(1900).max(2200).nullable()
}).strict();

export type CreatePersonInput = z.infer<typeof createPersonInputSchema>;

export const updatePersonDisplayInputSchema = z.object({
  personId: idSchema,
  displayName: z.string().trim().min(1).max(80),
  relation: z.string().trim().min(1).max(40),
  birthYear: z.number().int().min(1900).max(2200).nullable(),
  expectedDisplayRevision: z.number().int().nonnegative()
}).strict();

export type UpdatePersonDisplayInput = z.infer<typeof updatePersonDisplayInputSchema>;

export const archivePersonInputSchema = z.object({
  personId: idSchema,
  expectedDisplayRevision: z.number().int().nonnegative(),
  confirmedArchive: z.literal(true)
}).strict();

export type ArchivePersonInput = z.infer<typeof archivePersonInputSchema>;

export const restorePersonInputSchema = z.object({
  personId: idSchema,
  expectedDisplayRevision: z.number().int().nonnegative()
}).strict();

export type RestorePersonInput = z.infer<typeof restorePersonInputSchema>;

export const setDocumentInclusionInputSchema = z.discriminatedUnion('included', [
  z.object({
    documentId: idSchema,
    included: z.literal(false),
    confirmedExclusion: z.literal(true)
  }).strict(),
  z.object({
    documentId: idSchema,
    included: z.literal(true)
  }).strict()
]);

export type SetDocumentInclusionInput = z.infer<typeof setDocumentInclusionInputSchema>;

export const deleteDocumentInputSchema = z.object({
  documentId: idSchema,
  confirmedDelete: z.literal(true),
  acknowledgedRecoveryCopies: z.literal(true)
}).strict();

export type DeleteDocumentInput = z.infer<typeof deleteDocumentInputSchema>;

export const deletedDocumentSummarySchema = z.object({
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  displayName: z.string().min(1),
  personId: idSchema.nullable(),
  mediaType: z.string().min(1),
  deletedAt: utcTimestampSchema,
  rawObjectRetained: z.boolean()
}).strict();

export type DeletedDocumentSummary = z.infer<typeof deletedDocumentSummarySchema>;

export const deleteDocumentReceiptSchema = z.object({
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  currentWorkspaceRemoved: z.literal(true),
  rawObjectDeleted: z.boolean(),
  retainedByRecoveryPoint: z.boolean()
}).strict();

export type DeleteDocumentReceipt = z.infer<typeof deleteDocumentReceiptSchema>;

export const releaseDeletedDocumentInputSchema = z.object({
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

export type ReleaseDeletedDocumentInput = z.infer<typeof releaseDeletedDocumentInputSchema>;

export const switchWorkspaceInputSchema = z.object({
  mode: z.enum(['demo', 'personal'])
}).strict();

export const importFilesInputSchema = z.object({
  personId: idSchema.nullable(),
  autoProcess: z.literal(true).optional()
}).strict();

export const droppedFilePathsInputSchema = z.object({
  personId: idSchema.nullable(),
  paths: z.array(z.string().min(1).max(4_096)).min(1).max(100),
  autoProcess: z.literal(true).optional()
}).strict();

export const importFilesReceiptSchema = z.object({
  selectedCount: z.number().int().nonnegative(),
  importedCount: z.number().int().nonnegative(),
  duplicateCount: z.number().int().nonnegative(),
  suppressedCount: z.number().int().nonnegative(),
  rejected: z.array(z.object({
    displayName: z.string(),
    code: z.string()
  }).strict()),
  processing: z.object({
    status: z.enum(['queued', 'waiting_connection', 'local_only']),
    batchId: idSchema.optional()
  }).strict().optional()
}).strict();

export type ImportFilesReceipt = z.infer<typeof importFilesReceiptSchema>;

export const inboxBindingSummarySchema = z.object({
  id: idSchema,
  displayName: z.string().min(1),
  personId: idSchema.nullable(),
  personLabel: z.string().nullable(),
  recursive: z.boolean(),
  aiProcessingAuthorized: z.boolean(),
  enabled: z.boolean(),
  createdAt: utcTimestampSchema
}).strict();

export type InboxBindingSummary = z.infer<typeof inboxBindingSummarySchema>;

export const confirmInboxBindingInputSchema = z.object({
  selectionId: idSchema,
  personId: idSchema.nullable(),
  recursive: z.boolean(),
  allowScheduledAiProcessing: z.boolean(),
  consentVersion: z.literal(1),
  confirmedDataRecipient: z.literal('OpenAI/Codex')
}).strict();

export type ConfirmInboxBindingInput = z.infer<typeof confirmInboxBindingInputSchema>;

export const disableInboxBindingInputSchema = z.object({
  bindingId: idSchema
}).strict();

export const processNowInputSchema = z.object({
  consentVersion: z.literal(1),
  confirmedDataRecipient: z.literal('OpenAI/Codex'),
  documentIds: z.array(idSchema).min(1).max(100).optional(),
  readingScope: z.literal('unresolved_pages').optional(),
  assessmentPersonId: idSchema.refine((value) => !/\s/u.test(value), '成员标识不能包含空白').optional(),
  expectedAssessmentDataRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  purpose: z.literal('date_correction').optional(),
  dateCorrectionDocumentId: idSchema.optional(),
  expectedDateCorrectionDataRevision: z.string().regex(/^[a-f0-9]{64}$/).optional()
}).strict().refine(input => input.readingScope === undefined || input.documentIds !== undefined
  && input.assessmentPersonId === undefined && input.purpose === undefined, {
  message: '问题页补读只适用于明确选中的已保存报告', path: ['readingScope']
}).refine((input) => (input.assessmentPersonId === undefined) === (input.expectedAssessmentDataRevision === undefined), {
  message: '指定成员综合必须同时提交已确认的资料版本', path: ['expectedAssessmentDataRevision']
}).refine((input) => input.documentIds === undefined
  || input.assessmentPersonId === undefined && input.expectedAssessmentDataRevision === undefined, {
  message: '指定报告与仅指定成员综合不能同时使用', path: ['assessmentPersonId']
}).refine((input) => input.purpose === 'date_correction'
  ? input.dateCorrectionDocumentId !== undefined && input.expectedDateCorrectionDataRevision !== undefined
    && input.documentIds === undefined && input.assessmentPersonId === undefined
  : input.dateCorrectionDocumentId === undefined && input.expectedDateCorrectionDataRevision === undefined, {
  message: '日期纠错必须明确确认单份报告与当前资料版本，且不能混用其他任务用途', path: ['dateCorrectionDocumentId']
});

export type ProcessNowInput = z.infer<typeof processNowInputSchema>;

export const updateScheduleInputSchema = z.object({
  enabled: z.boolean(),
  localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  expectedRevision: z.number().int().nonnegative()
}).strict();

export type UpdateScheduleInput = z.infer<typeof updateScheduleInputSchema>;

export const createBackupInputSchema = z.object({
  passphrase: z.string().min(10).max(256)
}).strict();

export const restoreBackupInputSchema = z.object({
  selectionId: idSchema,
  passphrase: z.string().min(1).max(256),
  confirmedReplaceWorkspace: z.literal(true)
}).strict();

export const evidencePreviewRequestSchema = z.object({
  sourceSpanId: idSchema.optional(),
  documentId: idSchema.optional()
}).strict().refine((value) => Boolean(value.sourceSpanId) !== Boolean(value.documentId), {
  message: 'Provide exactly one evidence selector'
});

export type EvidencePreviewRequest = z.infer<typeof evidencePreviewRequestSchema>;

export const evidencePreviewSchema = z.object({
  sourceSpanId: idSchema,
  documentId: idSchema,
  displayName: z.string(),
  mediaType: z.string(),
  locator: z.string(),
  quote: z.string().nullable(),
  readability: z.enum(['clear', 'partial', 'unreadable']),
  conversionView: z.boolean(),
  previewImageDataUrl: z.string().startsWith('data:image/').nullable()
}).strict();

export type EvidencePreview = z.infer<typeof evidencePreviewSchema>;

export const resolveReviewInputSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('assign_person'),
    documentId: idSchema,
    personId: idSchema
  }).strict(),
  z.object({
    action: z.literal('confirm_identity'),
    issueId: idSchema,
    documentId: idSchema,
    personId: idSchema
  }).strict(),
  z.object({
    action: z.literal('reassign_person'),
    issueId: idSchema,
    documentId: idSchema,
    personId: idSchema
  }).strict(),
  z.object({
    action: z.literal('retry_review'),
    issueId: idSchema,
    documentId: idSchema
  }).strict(),
  z.object({
    action: z.literal('archive_only'),
    issueId: idSchema,
    documentId: idSchema
  }).strict(),
  z.object({
    action: z.literal('dismiss_derived'),
    issueId: idSchema,
    documentId: idSchema
  }).strict(),
  z.object({
    action: z.literal('accept_correction'),
    issueId: idSchema,
    documentId: idSchema,
    candidates: z.array(observationCandidateSchema).min(1).max(500)
  }).strict()
]);

export type ResolveReviewInput = z.infer<typeof resolveReviewInputSchema>;

export const appBridgeSchema = z.object({
  platform: z.enum(['darwin', 'win32', 'linux']),
  versions: z.object({
    app: z.string(),
    electron: z.string(),
    chrome: z.string(),
    node: z.string()
  }).strict()
}).strict();

export * from './extraction-repair.js';
export * from './direct-original-reading.js';
export * from './direct-original-date-reading.js';
export * from './runtime-recovery.js';
