import { z } from 'zod';
import { actionStatusSchema } from './action-status.js';

const idSchema = z.string().min(1).max(160);
const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const utcTimestampSchema = z.string().datetime({ offset: true });

export const bodySystemIdSchema = z.enum([
  'cardiovascular',
  'endocrine_metabolic',
  'hepatobiliary',
  'renal_urinary',
  'digestive',
  'respiratory',
  'hematology_immune',
  'musculoskeletal',
  'neurological',
  'sensory_oral',
  'reproductive',
  'dermatological'
]);
export type BodySystemId = z.infer<typeof bodySystemIdSchema>;

export const bodySystemRegistryItemSchema = z.object({
  id: bodySystemIdSchema,
  version: z.string().min(1),
  name: z.string().min(1),
  shortName: z.string().min(1),
  description: z.string().min(1),
  order: z.number().int().nonnegative(),
  topics: z.array(z.object({
    id: idSchema,
    name: z.string().min(1),
    description: z.string().min(1)
  }).strict())
}).strict();
export type BodySystemRegistryItem = z.infer<typeof bodySystemRegistryItemSchema>;

const partialClinicalTimeValueSchema = z.string().regex(/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/).refine((value) => {
  const [year, month, day] = value.split('-').map(Number);
  if (!year || year < 1900 || year > 2200) return false;
  if (month === undefined) return true;
  if (month < 1 || month > 12) return false;
  if (day === undefined) return true;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}, 'Invalid clinical time value');

export const clinicalTimeSchema = z.object({
  value: partialClinicalTimeValueSchema.nullable(),
  endValue: partialClinicalTimeValueSchema.nullable(),
  precision: z.enum(['day', 'month', 'year', 'unknown']),
  role: z.enum(['specimen', 'measurement', 'exam', 'report', 'onset', 'unknown']),
  source: z.enum(['explicit', 'inherited', 'corrected', 'unknown']),
  displayLabel: z.string().min(1)
}).strict().superRefine((time, context) => {
  if (time.value === null) {
    if (time.precision !== 'unknown') context.addIssue({ code: 'custom', message: 'Null clinical time must use unknown precision', path: ['precision'] });
    return;
  }
  const parts = time.value.split('-').length;
  const expected = parts === 1 ? 'year' : parts === 2 ? 'month' : 'day';
  if (time.precision !== expected) {
    context.addIssue({ code: 'custom', message: 'Clinical time precision must match value', path: ['precision'] });
  }
});
export type ClinicalTime = z.infer<typeof clinicalTimeSchema>;

export const memberEvidenceRefSchema = z.object({
  id: idSchema,
  kind: z.enum([
    'observation',
    'clinical_finding',
    'user_note',
    'event_metadata',
    'source_span',
    'knowledge'
  ]),
  observationId: idSchema.nullable(),
  eventId: idSchema.nullable(),
  documentId: idSchema.nullable(),
  sourceSpanId: idSchema.nullable(),
  knowledgeId: idSchema.nullable(),
  label: z.string().min(1),
  locator: z.string().nullable(),
  quote: z.string().nullable()
}).strict();
export type MemberEvidenceRef = z.infer<typeof memberEvidenceRefSchema>;

export const conceptMappingStatusSchema = z.enum(['verified', 'proposed', 'unmapped']);
export const conceptDefinitionSchema = z.object({
  id: idSchema,
  version: z.string().min(1),
  canonicalName: z.string().min(1),
  aliases: z.array(z.string().min(1)),
  specimen: z.string().nullable(),
  method: z.string().nullable(),
  bodySite: z.string().nullable(),
  compatibleUnits: z.array(z.string().min(1)),
  systemLinks: z.array(z.object({
    systemId: bodySystemIdSchema,
    relation: z.enum(['direct', 'context'])
  }).strict()),
  topicId: idSchema.nullable()
}).strict();
export type ConceptDefinition = z.infer<typeof conceptDefinitionSchema>;

export const conceptMappingSchema = z.object({
  rawName: z.string().min(1),
  normalizedName: z.string().min(1),
  conceptId: idSchema.nullable(),
  canonicalName: z.string().nullable(),
  status: conceptMappingStatusSchema,
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string().min(1))
}).strict();
export type ConceptMapping = z.infer<typeof conceptMappingSchema>;

export const conceptCatalogItemSchema = conceptDefinitionSchema.pick({
  id: true,
  canonicalName: true,
  aliases: true,
  specimen: true,
  compatibleUnits: true,
  systemLinks: true
}).extend({
  version: z.string().min(1)
}).strict();
export type ConceptCatalogItem = z.infer<typeof conceptCatalogItemSchema>;

export const conceptReviewItemSchema = z.object({
  observationId: idSchema,
  rawName: z.string().min(1),
  displayValue: z.string().min(1),
  unit: z.string().nullable(),
  clinicalDate: localDateSchema.nullable(),
  mapping: conceptMappingSchema,
  mappingVersion: z.string().min(1),
  correctedAt: utcTimestampSchema.nullable(),
  canUndo: z.boolean(),
  evidence: memberEvidenceRefSchema
}).strict();
export type ConceptReviewItem = z.infer<typeof conceptReviewItemSchema>;

export const conceptReviewBundleSchema = z.object({
  personId: idSchema,
  dictionaryVersion: z.string().min(1),
  catalog: z.array(conceptCatalogItemSchema),
  items: z.array(conceptReviewItemSchema)
}).strict();
export type ConceptReviewBundle = z.infer<typeof conceptReviewBundleSchema>;

export const setConceptMappingInputSchema = z.object({
  personId: idSchema,
  observationId: idSchema,
  conceptId: idSchema.nullable(),
  reason: z.string().trim().min(1).max(300)
}).strict();
export type SetConceptMappingInput = z.infer<typeof setConceptMappingInputSchema>;

export const undoConceptMappingInputSchema = z.object({
  personId: idSchema,
  observationId: idSchema
}).strict();
export type UndoConceptMappingInput = z.infer<typeof undoConceptMappingInputSchema>;

export const conceptMappingReceiptSchema = z.object({
  observationId: idSchema,
  mapping: conceptMappingSchema,
  mappingVersion: z.string().min(1),
  correctedAt: utcTimestampSchema,
  canUndo: z.boolean(),
  invalidatedSystemIds: z.array(bodySystemIdSchema),
  factRevision: z.number().int().nonnegative()
}).strict();
export type ConceptMappingReceipt = z.infer<typeof conceptMappingReceiptSchema>;

export const trendPointV2Schema = z.object({
  id: idSchema,
  observationId: idSchema,
  time: clinicalTimeSchema,
  timestamp: z.number().int().nullable(),
  displayValue: z.string().min(1),
  numericValue: z.number().finite().nullable(),
  comparator: z.enum(['eq', 'lt', 'lte', 'gt', 'gte']).nullable(),
  unit: z.string().nullable(),
  referenceLow: z.number().finite().nullable(),
  referenceHigh: z.number().finite().nullable(),
  abnormalFlag: z.enum(['high', 'low', 'positive', 'negative', 'normal', 'unknown']),
  comparable: z.boolean(),
  comparabilityReasons: z.array(z.string().min(1)),
  evidence: memberEvidenceRefSchema,
  evidenceSources: z.array(memberEvidenceRefSchema).min(1).optional(),
  duplicateSourceCount: z.number().int().nonnegative().optional()
}).strict();
export type TrendPointV2 = z.infer<typeof trendPointV2Schema>;

export const trendFactsSchema = z.object({
  status: z.enum(['comparable', 'conditional', 'not_comparable']),
  direction: z.enum(['insufficient', 'stable', 'increasing', 'decreasing', 'fluctuating', 'mixed']),
  pointCount: z.number().int().nonnegative(),
  usablePointCount: z.number().int().nonnegative(),
  spanDays: z.number().int().nonnegative().nullable(),
  firstValue: z.number().finite().nullable(),
  latestValue: z.number().finite().nullable(),
  absoluteChange: z.number().finite().nullable(),
  relativeChangePercent: z.number().finite().nullable(),
  latestChange: z.number().finite().nullable(),
  segmentDirections: z.array(z.enum(['up', 'down', 'flat'])),
  reportedFlagChanges: z.number().int().nonnegative(),
  referenceBoundaryCrossings: z.number().int().nonnegative(),
  reasons: z.array(z.string().min(1)),
  statement: z.string().min(1)
}).strict();
export type TrendFacts = z.infer<typeof trendFactsSchema>;

export const metricSeriesSummarySchema = z.object({
  id: idSchema,
  conceptId: idSchema.nullable(),
  name: z.string().min(1),
  unit: z.string().nullable(),
  latestValue: z.string().nullable(),
  latestDate: localDateSchema.nullable(),
  latestAbnormalFlag: z.enum(['high', 'low', 'positive', 'negative', 'normal', 'unknown']),
  mappingStatus: conceptMappingStatusSchema,
  trendFacts: trendFactsSchema,
  points: z.array(trendPointV2Schema)
}).strict();
export type MetricSeriesSummary = z.infer<typeof metricSeriesSummarySchema>;

export const systemAnalysisSnapshotSchema = z.object({
  schemaVersion: z.literal(2),
  id: idSchema,
  personId: idSchema,
  systemId: bodySystemIdSchema,
  inputSignature: z.string().regex(/^[a-f0-9]{64}$/),
  scope: z.object({
    from: localDateSchema.nullable(),
    to: localDateSchema.nullable(),
    clinicalAsOf: localDateSchema.nullable()
  }).strict(),
  factRevision: z.number().int().nonnegative(),
  promptVersion: z.string().min(1),
  status: z.enum(['current', 'stale', 'building', 'failed', 'unavailable', 'needs_review']),
  dataQuality: z.enum(['complete', 'partial', 'insufficient']),
  headline: z.string().min(1),
  keyPoints: z.array(z.object({
    id: idSchema,
    kind: z.enum(['fact_summary', 'trend_description', 'contextual_interpretation', 'question']),
    text: z.string().min(1),
    evidence: z.array(memberEvidenceRefSchema),
    limitations: z.array(z.string().min(1)),
    trendFactIds: z.array(idSchema)
  }).strict()),
  topicSections: z.array(z.object({
    topicId: idSchema,
    title: z.string().min(1),
    claimIds: z.array(idSchema),
    seriesIds: z.array(idSchema),
    findingIds: z.array(idSchema)
  }).strict()),
  conflicts: z.array(z.object({
    text: z.string().min(1),
    evidence: z.array(memberEvidenceRefSchema).min(1)
  }).strict()),
  dataGaps: z.array(z.object({
    text: z.string().min(1),
    consequence: z.string().min(1)
  }).strict()),
  discussionPoints: z.array(z.object({
    text: z.string().min(1),
    evidence: z.array(memberEvidenceRefSchema),
    source: z.enum(['ai_suggested', 'clinician_reported'])
  }).strict()),
  coverage: z.object({
    inputCount: z.number().int().nonnegative(),
    linkedEventCount: z.number().int().nonnegative(),
    excludedCount: z.number().int().nonnegative(),
    incompleteReasons: z.array(z.string().min(1))
  }).strict(),
  review: z.object({
    status: z.enum(['pending', 'passed', 'failed']),
    reviewerRunId: idSchema.nullable(),
    rulesVersion: z.string().min(1)
  }).strict(),
  generatedAt: utcTimestampSchema
}).strict();
export type SystemAnalysisSnapshot = z.infer<typeof systemAnalysisSnapshotSchema>;

const systemAnalysisKeyPointCandidateSchema = z.object({
  id: idSchema,
  kind: z.enum(['fact_summary', 'trend_description', 'contextual_interpretation', 'question']),
  text: z.string().min(1).max(1_200),
  evidenceIds: z.array(idSchema),
  limitations: z.array(z.string().min(1).max(500)),
  trendFactIds: z.array(idSchema)
}).strict();

export const systemAnalysisCandidateSchema = z.object({
  schemaVersion: z.literal(2),
  personId: idSchema,
  systemId: bodySystemIdSchema,
  inputSignature: z.string().regex(/^[a-f0-9]{64}$/),
  headline: z.string().min(1).max(300),
  dataQuality: z.enum(['complete', 'partial', 'insufficient']),
  keyPoints: z.array(systemAnalysisKeyPointCandidateSchema).max(20),
  topicSections: z.array(z.object({
    topicId: idSchema,
    title: z.string().min(1).max(120),
    claimIds: z.array(idSchema),
    seriesIds: z.array(idSchema),
    findingIds: z.array(idSchema)
  }).strict()).max(20),
  conflicts: z.array(z.object({
    text: z.string().min(1).max(800),
    evidenceIds: z.array(idSchema).min(1)
  }).strict()).max(20),
  dataGaps: z.array(z.object({
    text: z.string().min(1).max(500),
    consequence: z.string().min(1).max(500)
  }).strict()).max(20),
  discussionPoints: z.array(z.object({
    text: z.string().min(1).max(800),
    evidenceIds: z.array(idSchema),
    source: z.enum(['ai_suggested', 'clinician_reported'])
  }).strict()).max(20)
}).strict();
export type SystemAnalysisCandidate = z.infer<typeof systemAnalysisCandidateSchema>;

export const systemAnalysisReviewSchema = z.object({
  schemaVersion: z.literal(1),
  personId: idSchema,
  systemId: bodySystemIdSchema,
  inputSignature: z.string().regex(/^[a-f0-9]{64}$/),
  overallSupported: z.boolean(),
  itemReviews: z.array(z.object({
    itemId: idSchema,
    supported: z.boolean(),
    safe: z.boolean(),
    trendConsistent: z.boolean(),
    issue: z.string().nullable()
  }).strict())
}).strict();
export type SystemAnalysisReview = z.infer<typeof systemAnalysisReviewSchema>;

export const bodySystemSummaryV2Schema = z.object({
  id: bodySystemIdSchema,
  name: z.string().min(1),
  shortName: z.string().min(1),
  status: z.enum(['stable', 'attention', 'insufficient', 'building']),
  summary: z.string().min(1),
  factCount: z.number().int().nonnegative(),
  metricCount: z.number().int().nonnegative(),
  attentionCount: z.number().int().nonnegative(),
  latestDate: localDateSchema.nullable(),
  analysisStatus: systemAnalysisSnapshotSchema.shape.status,
  topics: z.array(z.object({ id: idSchema, name: z.string().min(1), factCount: z.number().int().nonnegative() }).strict())
}).strict();
export type BodySystemSummaryV2 = z.infer<typeof bodySystemSummaryV2Schema>;

export const memberOverviewV2Schema = z.object({
  personId: idSchema,
  generatedAt: utcTimestampSchema,
  dataQuality: z.enum(['complete', 'partial', 'insufficient']),
  headline: z.string().min(1),
  latestClinicalDate: localDateSchema.nullable(),
  acceptedFactCount: z.number().int().nonnegative(),
  eventCount: z.number().int().nonnegative(),
  attentionSystemIds: z.array(bodySystemIdSchema),
  systems: z.array(bodySystemSummaryV2Schema),
  recentChanges: z.array(z.object({
    id: idSchema,
    title: z.string().min(1),
    detail: z.string().min(1),
    date: localDateSchema.nullable(),
    systemId: bodySystemIdSchema.nullable(),
    evidence: z.array(memberEvidenceRefSchema)
  }).strict()),
  nextActions: z.array(z.object({ id: idSchema, title: z.string().min(1), status: z.string().min(1) }).strict())
}).strict();
export type MemberOverviewV2 = z.infer<typeof memberOverviewV2Schema>;

export const bodySystemDetailV2Schema = z.object({
  personId: idSchema,
  registry: bodySystemRegistryItemSchema,
  summary: bodySystemSummaryV2Schema,
  analysis: systemAnalysisSnapshotSchema.nullable(),
  metrics: z.array(metricSeriesSummarySchema),
  findings: z.array(z.object({
    id: idSchema,
    title: z.string().min(1),
    value: z.string().min(1),
    time: clinicalTimeSchema,
    abnormalFlag: z.enum(['high', 'low', 'positive', 'negative', 'normal', 'unknown']),
    evidence: z.array(memberEvidenceRefSchema)
  }).strict()),
  relatedEventIds: z.array(idSchema),
  unmappedFactCount: z.number().int().nonnegative()
}).strict();
export type BodySystemDetailV2 = z.infer<typeof bodySystemDetailV2Schema>;

export const metricSeriesDetailV2Schema = metricSeriesSummarySchema.extend({
  personId: idSchema,
  systemIds: z.array(bodySystemIdSchema),
  comparisonConditions: z.object({
    specimen: z.string().nullable(),
    method: z.string().nullable(),
    bodySite: z.string().nullable()
  }).strict(),
  aliasesSeen: z.array(z.string().min(1)),
  tableRows: z.array(trendPointV2Schema)
}).strict();
export type MetricSeriesDetailV2 = z.infer<typeof metricSeriesDetailV2Schema>;

export const healthEventV2Schema = z.object({
  id: idSchema,
  personId: idSchema,
  type: z.enum(['checkup', 'outpatient', 'inpatient', 'imaging', 'laboratory', 'self_measurement', 'manual_note', 'other']),
  title: z.string().min(1),
  time: clinicalTimeSchema,
  organization: z.string().nullable().optional(),
  department: z.string().nullable().optional(),
  reportNumber: z.string().nullable().optional(),
  examItems: z.array(z.string().min(1)).optional(),
  reportIssuedTime: clinicalTimeSchema.nullable().optional(),
  summary: z.string().min(1),
  systemIds: z.array(bodySystemIdSchema),
  documentIds: z.array(idSchema),
  factCount: z.number().int().nonnegative(),
  metadataStatus: z.enum(['confirmed', 'inferred', 'unknown', 'corrected'])
}).strict();
export type HealthEventV2 = z.infer<typeof healthEventV2Schema>;

export const healthEventDetailV2Schema = healthEventV2Schema.extend({
  evidence: z.array(memberEvidenceRefSchema),
  metricSeriesIds: z.array(idSchema),
  findings: z.array(z.object({
    id: idSchema,
    label: z.string().min(1),
    value: z.string().min(1),
    abnormalFlag: z.enum(['high', 'low', 'positive', 'negative', 'normal', 'unknown'])
  }).strict()),
  historicalReferences: z.array(z.object({
    time: clinicalTimeSchema,
    sourceReportTitle: z.string().min(1),
    findings: z.array(z.object({
      id: idSchema,
      label: z.string().min(1),
      value: z.string().min(1),
      evidence: memberEvidenceRefSchema
    }).strict()).min(1)
  }).strict()),
  reports: z.array(z.object({
    reportId: idSchema,
    documentId: idSchema,
    title: z.string().min(1)
  }).strict()),
  metadataRevision: z.number().int().positive(),
  reportId: idSchema.nullable().optional(),
  metadataCanUndo: z.boolean().optional(),
  relationChangeId: idSchema.nullable().optional(),
  relationChangeAction: z.enum(['merge', 'split']).nullable().optional(),
  relationCanUndo: z.boolean().optional()
}).strict();
export type HealthEventDetailV2 = z.infer<typeof healthEventDetailV2Schema>;

export const updateReportMetadataInputSchema = z.object({
  personId: idSchema,
  reportId: idSchema,
  expectedRevision: z.number().int().positive(),
  title: z.string().trim().min(1).max(200),
  organization: z.string().trim().max(200).nullable(),
  department: z.string().trim().max(200).nullable(),
  clinicalTime: z.object({
    value: partialClinicalTimeValueSchema.nullable(),
    precision: z.enum(['year', 'month', 'day', 'unknown'])
  }).strict().superRefine((time, context) => {
    if (time.value === null && time.precision !== 'unknown') {
      context.addIssue({ code: 'custom', message: 'Null clinical time must use unknown precision', path: ['precision'] });
    }
    if (time.value !== null) {
      const expected = time.value.split('-').length === 1 ? 'year' : time.value.split('-').length === 2 ? 'month' : 'day';
      if (time.precision !== expected) context.addIssue({ code: 'custom', message: 'Clinical time precision must match value', path: ['precision'] });
    }
  }),
  reason: z.string().trim().min(1).max(300)
}).strict();
export type UpdateReportMetadataInput = z.infer<typeof updateReportMetadataInputSchema>;

export const undoReportMetadataInputSchema = z.object({
  personId: idSchema,
  reportId: idSchema,
  expectedRevision: z.number().int().positive()
}).strict();
export type UndoReportMetadataInput = z.infer<typeof undoReportMetadataInputSchema>;

export const reportMetadataCorrectionReceiptSchema = z.object({
  reportId: idSchema,
  metadataRevision: z.number().int().positive(),
  factRevision: z.number().int().nonnegative(),
  canUndo: z.boolean()
}).strict();
export type ReportMetadataCorrectionReceipt = z.infer<typeof reportMetadataCorrectionReceiptSchema>;

export const mergeHealthEventsInputSchema = z.object({
  personId: idSchema,
  targetEventId: idSchema,
  sourceEventId: idSchema,
  reason: z.string().trim().min(1).max(300)
}).strict().refine((input) => input.targetEventId !== input.sourceEventId, 'Events must be different');
export type MergeHealthEventsInput = z.infer<typeof mergeHealthEventsInputSchema>;

export const splitHealthEventInputSchema = z.object({
  personId: idSchema,
  eventId: idSchema,
  reportId: idSchema,
  reason: z.string().trim().min(1).max(300)
}).strict();
export type SplitHealthEventInput = z.infer<typeof splitHealthEventInputSchema>;

export const undoHealthEventRelationInputSchema = z.object({
  personId: idSchema,
  changeId: idSchema
}).strict();
export type UndoHealthEventRelationInput = z.infer<typeof undoHealthEventRelationInputSchema>;

export const healthEventRelationReceiptSchema = z.object({
  changeId: idSchema,
  eventIds: z.array(idSchema).min(1),
  reportIds: z.array(idSchema).min(1),
  factRevision: z.number().int().nonnegative(),
  canUndo: z.boolean()
}).strict();
export type HealthEventRelationReceipt = z.infer<typeof healthEventRelationReceiptSchema>;

export const lifestylePlanV2Schema = z.object({
  personId: idSchema,
  status: z.enum(['current', 'stale', 'building', 'unavailable']),
  dataQuality: z.enum(['complete', 'partial', 'insufficient']),
  updatedAt: utcTimestampSchema.nullable(),
  priorities: z.array(z.object({
    id: idSchema,
    title: z.string().min(1),
    why: z.string().min(1),
    evidence: z.array(memberEvidenceRefSchema)
  }).strict()),
  proposals: z.array(z.object({
    id: idSchema,
    category: z.enum(['exercise', 'diet', 'sleep', 'monitoring', 'review', 'other']),
    title: z.string().min(1),
    goal: z.string().min(1),
    rationale: z.string().min(1),
    detail: z.string().min(1),
    steps: z.array(z.string().min(1)).min(1),
    startingOptions: z.array(z.string().min(1)).min(1),
    scheduleSuggestion: z.string().nullable(),
    trackingSuggestion: z.string().min(1),
    constraints: z.array(z.string().min(1)),
    uncertainties: z.array(z.string().min(1)),
    consultProfessional: z.boolean(),
    status: z.enum(['proposed', 'adopted', 'dismissed']),
    evidence: z.array(memberEvidenceRefSchema),
    generalKnowledgeEvidence: z.array(z.object({
      id: idSchema,
      sourceTitle: z.string().min(1),
      sourceOrganization: z.string().min(1),
      sourceUrl: z.string().url(),
      reviewedAt: localDateSchema,
      supportedScope: z.string().min(1),
      verificationStatus: z.enum(['unverified_model_candidate', 'controlled_source_verified']).default('unverified_model_candidate')
    }).strict()),
    sourceKind: z.enum(['ai_proposed', 'clinician_reported', 'care_preparation']),
    relatedSystemIds: z.array(bodySystemIdSchema)
  }).strict()),
  adoptedActions: z.array(z.object({
    id: idSchema,
    proposalId: idSchema.nullable(),
    title: z.string().min(1),
    userGoal: z.string().min(1),
    selectedStartingOption: z.string().min(1),
    plannedTime: z.string().nullable(),
    owner: z.string().min(1),
    progressNote: z.string().nullable(),
    status: actionStatusSchema,
    dueDate: localDateSchema.nullable(),
    updatedAt: utcTimestampSchema
  }).strict())
}).strict();
export type LifestylePlanV2 = z.infer<typeof lifestylePlanV2Schema>;

export const memberPersonInputSchema = z.object({ personId: idSchema }).strict();
export const memberSystemInputSchema = z.object({ personId: idSchema, systemId: bodySystemIdSchema }).strict();
export const memberMetricInputSchema = z.object({ personId: idSchema, seriesId: idSchema }).strict();
export const memberEventInputSchema = z.object({ personId: idSchema, eventId: idSchema }).strict();
export const memberEvidenceBundleInputSchema = z.object({ personId: idSchema, evidenceIds: z.array(idSchema).min(1).max(100) }).strict();
export const adoptLifestyleProposalInputSchema = z.object({
  personId: idSchema,
  proposalId: idSchema,
  userGoal: z.string().trim().min(1).max(300),
  selectedStartingOption: z.string().trim().min(1).max(500),
  plannedTime: z.string().trim().max(200).nullable(),
  owner: z.string().trim().min(1).max(120),
  progressNote: z.string().trim().max(500).nullable(),
  dueDate: localDateSchema.nullable()
}).strict();
export type AdoptLifestyleProposalInput = z.infer<typeof adoptLifestyleProposalInputSchema>;

export const setLifestyleProposalDecisionInputSchema = z.object({
  personId: idSchema,
  proposalId: idSchema,
  decision: z.enum(['dismiss', 'restore'])
}).strict();
export type SetLifestyleProposalDecisionInput = z.infer<typeof setLifestyleProposalDecisionInputSchema>;

export const lifestyleProposalDecisionReceiptSchema = z.object({
  proposalId: idSchema,
  status: z.enum(['proposed', 'dismissed']),
  updatedAt: utcTimestampSchema
}).strict();
export type LifestyleProposalDecisionReceipt = z.infer<typeof lifestyleProposalDecisionReceiptSchema>;

export const adoptedActionReceiptSchema = z.object({
  id: idSchema,
  proposalId: idSchema,
  title: z.string().min(1),
  userGoal: z.string().min(1),
  selectedStartingOption: z.string().min(1),
  plannedTime: z.string().nullable(),
  owner: z.string().min(1),
  progressNote: z.string().nullable(),
  status: actionStatusSchema,
  dueDate: localDateSchema.nullable(),
  updatedAt: utcTimestampSchema
}).strict();
export type AdoptedActionReceipt = z.infer<typeof adoptedActionReceiptSchema>;
export const memberEventListInputSchema = z.object({
  personId: idSchema,
  systemId: bodySystemIdSchema.nullable().optional(),
  type: healthEventV2Schema.shape.type.nullable().optional()
}).strict();

export const memberEvidenceBundleSchema = z.object({
  personId: idSchema,
  items: z.array(memberEvidenceRefSchema),
  missingIds: z.array(idSchema)
}).strict();
export type MemberEvidenceBundle = z.infer<typeof memberEvidenceBundleSchema>;

export const systemEvidenceFactSchema = z.object({
  observationId: idSchema,
  conceptId: idSchema.nullable(),
  name: z.string().min(1),
  value: z.string().min(1),
  abnormalFlag: z.enum(['high', 'low', 'positive', 'negative', 'normal', 'unknown']),
  time: clinicalTimeSchema,
  relation: z.enum(['direct', 'context']),
  relationReason: z.string().min(1),
  evidence: memberEvidenceRefSchema,
  evidenceSources: z.array(memberEvidenceRefSchema).min(1)
}).strict();
export type SystemEvidenceFact = z.infer<typeof systemEvidenceFactSchema>;

export const systemEvidenceBundleSchema = z.object({
  schemaVersion: z.literal(1),
  identity: z.object({
    personId: idSchema,
    systemId: bodySystemIdSchema,
    birthYear: z.number().int().min(1900).max(2200).nullable(),
    genderContext: z.string().max(120).nullable(),
    contextSource: z.literal('user_profile')
  }).strict(),
  scope: z.object({
    factRevision: z.number().int().nonnegative(),
    contextRevision: z.number().int().nonnegative(),
    clinicalFrom: localDateSchema.nullable(),
    clinicalAsOf: localDateSchema.nullable(),
    inputSignature: z.string().regex(/^[a-f0-9]{64}$/)
  }).strict(),
  directFacts: z.array(systemEvidenceFactSchema),
  contextFacts: z.array(systemEvidenceFactSchema),
  personalContext: z.array(z.object({
    id: idSchema,
    kind: z.enum(['history', 'allergy', 'medication', 'self_measurement', 'goal', 'constraint', 'free_text']),
    text: z.string().min(1),
    effectiveDate: localDateSchema.nullable(),
    source: z.literal('user_reported'),
    revision: z.number().int().positive(),
    applicableSystemIds: z.array(bodySystemIdSchema),
    selectionReason: z.string().min(1)
  }).strict()),
  events: z.array(healthEventV2Schema),
  trends: z.array(metricSeriesSummarySchema),
  existingActions: z.array(z.object({
    id: idSchema,
    title: z.string().min(1),
    status: z.string().min(1),
    userRevision: z.number().int().positive(),
    relatedSystemIds: z.array(bodySystemIdSchema),
    selectionReason: z.string().min(1)
  }).strict()),
  knowledge: z.array(z.object({ id: idSchema, version: z.string().min(1), title: z.string().min(1) }).strict()),
  coverage: z.object({
    selectedObservationIds: z.array(idSchema),
    excludedObservationIds: z.array(idSchema),
    unclassifiedObservationIds: z.array(idSchema),
    selectedContextIds: z.array(idSchema),
    excludedContextIds: z.array(idSchema),
    selectedActionIds: z.array(idSchema),
    excludedActionIds: z.array(idSchema),
    incompleteReasons: z.array(z.string().min(1))
  }).strict()
}).strict();
export type SystemEvidenceBundle = z.infer<typeof systemEvidenceBundleSchema>;
