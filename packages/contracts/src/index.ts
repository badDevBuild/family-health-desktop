import { z } from 'zod';

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
  quote: z.string().nullable()
}).strict();

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
  evidence: z.array(evidenceRefSchema).min(1),
  issues: z.array(z.object({
    code: z.string().min(1),
    message: z.string().min(1)
  }).strict())
}).strict();

export type ObservationCandidate = z.infer<typeof observationCandidateSchema>;

export const extractionResultSchema = z.object({
  schemaVersion: z.literal(1),
  documentId: idSchema,
  subject: z.object({
    reportedName: z.string().trim().min(1).max(120).nullable(),
    evidence: z.array(evidenceRefSchema),
    confidence: z.enum(['explicit', 'absent', 'uncertain'])
  }).strict(),
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

export const derivedSnapshotCandidateSchema = z.object({
  schemaVersion: z.literal(1),
  personId: idSchema,
  factRevision: z.number().int().nonnegative(),
  dataQuality: dataQualitySchema,
  claims: z.array(derivedClaimSchema).max(40),
  lifestyleGuidance: z.array(z.object({
    id: idSchema,
    title: z.string().min(1).max(120),
    detail: z.string().min(1).max(800),
    evidenceObservationIds: z.array(idSchema).min(1),
    consultProfessional: z.boolean()
  }).strict()).max(20)
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

export const sourceSpanSchema = z.object({
  id: idSchema,
  documentId: idSchema,
  spanKind: z.enum(['page', 'block', 'image', 'line', 'table_cell']),
  page: z.number().int().positive().nullable(),
  blockId: z.string().nullable(),
  lineStart: z.number().int().positive().nullable(),
  lineEnd: z.number().int().positive().nullable(),
  quote: z.string().nullable(),
  readability: z.enum(['clear', 'partial', 'unreadable'])
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
  kind: z.enum(['history', 'allergy', 'medication', 'self_measurement', 'free_text']),
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
  kind: z.enum(['history', 'allergy', 'medication', 'self_measurement', 'free_text']),
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
  'failed',
  'cancelled'
]);

export const healthTaskEnvelopeSchema = z.object({
  taskId: idSchema,
  stage: z.enum(['extract', 'review_facts', 'analyze', 'guidance', 'review_derived']),
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

export const actionItemSchema = z.object({
  id: idSchema,
  personId: idSchema,
  title: z.string().min(1),
  detail: z.string(),
  origin: z.enum(['clinician_document', 'user_created', 'ai_proposed']),
  status: z.enum(['proposed', 'discussed', 'planned', 'completed', 'dismissed']),
  dueDate: localDateSchema.nullable(),
  dueText: z.string().nullable(),
  evidenceLabel: z.string().nullable(),
  userRevision: z.number().int().positive(),
  updatedAt: utcTimestampSchema
}).strict();

export type ActionItem = z.infer<typeof actionItemSchema>;

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
  assessmentSummary: z.string().nullable(),
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
  status: z.enum(['discovered', 'stabilizing', 'queued', 'processing', 'needs_review', 'completed', 'ignored', 'duplicate', 'blocked']),
  format: z.string(),
  sourceLabel: z.string(),
  sentToAi: z.boolean(),
  aiTransmissionStatus: z.enum(['not_sent', 'sending', 'acknowledged', 'completed', 'unknown']),
  issue: z.string().nullable()
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

export const jobSummarySchema = z.object({
  id: idSchema,
  batchLabel: z.string(),
  personLabel: z.string().nullable(),
  stage: taskStageSchema,
  status: jobStatusSchema,
  completedUnits: z.number().int().nonnegative(),
  totalUnits: z.number().int().positive(),
  statusText: z.string(),
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
  modelId: 'gpt-5.6-sol',
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
  status: z.enum(['proposed', 'discussed', 'planned', 'completed', 'dismissed']),
  expectedRevision: z.number().int().nonnegative()
}).strict();

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
  personId: idSchema.nullable()
}).strict();

export const droppedFilePathsInputSchema = z.object({
  personId: idSchema.nullable(),
  paths: z.array(z.string().min(1).max(4_096)).min(1).max(100)
}).strict();

export const importFilesReceiptSchema = z.object({
  selectedCount: z.number().int().nonnegative(),
  importedCount: z.number().int().nonnegative(),
  duplicateCount: z.number().int().nonnegative(),
  suppressedCount: z.number().int().nonnegative(),
  rejected: z.array(z.object({
    displayName: z.string(),
    code: z.string()
  }).strict())
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
  documentIds: z.array(idSchema).min(1).max(100).optional()
}).strict();

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
