import { z } from 'zod';
import { bodySystemIdSchema, memberEvidenceRefSchema } from './member-v2.js';

const id = z.string().min(1).max(160);
const signature = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1).max(2_000);

export const diagnosticStatusSchema = z.enum(['documented', 'criteria_met', 'likely', 'possible', 'undetermined']);
export const knowledgeBasisSchema = z.enum(['model_general', 'catalog', 'retrieved', 'not_applicable']);
export const assessmentModeSchema = z.enum(['full', 'partition', 'aggregate']);
export const assessmentSystemStatusSchema = z.enum(['attention', 'monitor', 'no_signal_in_scope', 'insufficient']);

export const criteriaBasisSchema = z.object({
  criteriaSetId: id.nullable(),
  sourceId: id,
  applicability: text,
  requirements: z.array(z.object({
    criterionId: id,
    status: z.enum(['met', 'not_met', 'unknown']),
    evidenceIds: z.array(id)
  }).strict()).min(1).max(30)
}).strict();

export const healthClaimSchema = z.object({
  id,
  topicKey: id,
  systemIds: z.array(bodySystemIdSchema).min(1),
  kind: z.enum(['source_fact', 'trend', 'interpretation', 'diagnostic_assessment']),
  text,
  diseaseName: text.nullable(),
  diagnosticStatus: diagnosticStatusSchema.nullable(),
  temporalStatus: z.enum(['current', 'historical', 'uncertain']),
  evidenceIds: z.array(id),
  counterEvidenceIds: z.array(id),
  trendIds: z.array(id),
  knowledgeBasis: knowledgeBasisSchema,
  knowledgeSourceIds: z.array(id),
  criteriaBasis: criteriaBasisSchema.nullable(),
  rationale: text,
  materialUncertainty: text.nullable(),
  consequenceLevel: z.enum(['routine', 'important', 'high'])
}).strict();
export type HealthClaim = z.infer<typeof healthClaimSchema>;

export const healthActionSchema = z.object({
  id,
  dedupeKey: id,
  systemIds: z.array(bodySystemIdSchema).min(1),
  claimIds: z.array(id),
  kind: z.enum(['habit', 'self_monitor', 'test_followup', 'seek_care', 'treatment_discussion', 'documented_plan']),
  title: text,
  why: text,
  firstStep: text,
  timing: text.nullable(),
  timingBasis: z.enum(['documented', 'guideline', 'practical_trial', 'none']),
  reviewPlan: text.nullable(),
  caution: text.nullable(),
  urgency: z.enum(['routine', 'soon', 'urgent', 'emergency']),
  evidenceIds: z.array(id),
  knowledgeSourceIds: z.array(id)
}).strict();
export type HealthAction = z.infer<typeof healthActionSchema>;

export const overviewNodeSchema = z.object({
  id: z.literal('overview'),
  headline: text,
  summary: text,
  claimIds: z.array(id),
  actionIds: z.array(id),
  limitations: z.array(text)
}).strict();
export type OverviewNode = z.infer<typeof overviewNodeSchema>;

export const systemNodeSchema = z.object({
  id,
  systemId: bodySystemIdSchema,
  status: assessmentSystemStatusSchema,
  headline: text,
  summary: text,
  claimIds: z.array(id),
  actionIds: z.array(id),
  limitations: z.array(text)
}).strict();
export type SystemNode = z.infer<typeof systemNodeSchema>;

export const questionNodeSchema = z.object({
  id,
  question: text,
  whyItMatters: text,
  relatedClaimIds: z.array(id),
  evidenceIds: z.array(id)
}).strict();
export type QuestionNode = z.infer<typeof questionNodeSchema>;

export const knowledgeSourceCandidateSchema = z.object({
  id,
  title: text,
  organization: text.nullable(),
  url: z.string().url().nullable(),
  origin: z.enum(['catalog', 'retrieved']),
  supports: text
}).strict();

export const memberAssessmentCandidateV3Schema = z.object({
  schemaVersion: z.literal(3),
  personId: id,
  inputSignature: signature,
  mode: assessmentModeSchema,
  requestedSystemIds: z.array(bodySystemIdSchema),
  overview: overviewNodeSchema,
  systems: z.array(systemNodeSchema),
  claims: z.array(healthClaimSchema),
  actions: z.array(healthActionSchema),
  questions: z.array(questionNodeSchema),
  knowledgeSources: z.array(knowledgeSourceCandidateSchema)
}).strict();
export type MemberAssessmentCandidateV3 = z.infer<typeof memberAssessmentCandidateV3Schema>;

/** P02 的输入也受约束，避免把展示名或未归属资料误当作临床依据。 */
export const assessmentRequestV3Schema = z.object({
  personId: id,
  inputSignature: signature,
  mode: assessmentModeSchema,
  requestedSystemIds: z.array(bodySystemIdSchema),
  analysisReferenceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  clinicalFrom: z.string().nullable(),
  clinicalAsOf: z.string().nullable(),
  webSearchAllowed: z.boolean()
}).strict();
export type AssessmentRequestV3 = z.infer<typeof assessmentRequestV3Schema>;

export const memberEvidencePackageV3Schema = z.object({
  identity: z.object({
    personId: id,
    birthYear: z.number().int().nullable(),
    genderContext: z.string().nullable(),
    source: z.literal('user_profile')
  }).strict(),
  facts: z.array(z.object({
    observationId: id,
    originalName: text,
    modelStandardNameCandidate: z.string().nullable(),
    rawValue: text,
    valueKind: z.enum(['numeric', 'qualitative', 'text', 'unknown']),
    qualifier: z.string().nullable(),
    unit: z.string().nullable(),
    referenceRange: z.string().nullable(),
    clinicalDate: z.string().nullable(),
    reportedAbnormalFlag: z.enum(['high', 'low', 'positive', 'negative', 'normal', 'unknown']),
    specimen: z.string().nullable(),
    method: z.string().nullable(),
    bodySite: z.string().nullable(),
    documentId: id,
    systemIds: z.array(bodySystemIdSchema),
    evidenceIds: z.array(id).min(1),
    sourceKind: z.literal('report')
  }).strict()),
  evidenceCatalog: z.array(memberEvidenceRefSchema),
  trends: z.array(z.object({ id, systemIds: z.array(bodySystemIdSchema), payload: z.unknown() }).strict()),
  personalContext: z.array(z.object({
    id,
    kind: z.enum(['history', 'allergy', 'medication', 'self_measurement', 'goal', 'constraint', 'free_text']),
    text,
    effectiveDate: z.string().nullable(),
    recordedAt: z.string(),
    systemIds: z.array(bodySystemIdSchema),
    evidenceId: id,
    sourceKind: z.literal('user_reported')
  }).strict()),
  unresolvedScope: z.array(z.object({ documentId: id, reasonCodes: z.array(z.string()) }).strict()),
  existingActions: z.array(z.object({
    id,
    title: text,
    detail: z.string(),
    status: z.string(),
    systemIds: z.array(bodySystemIdSchema)
  }).strict()),
  knowledge: z.array(z.object({
    id,
    version: id,
    title: text,
    content: text,
    applicability: text,
    sourceOrganization: text,
    sourceUrl: z.string().url(),
    reviewedAt: z.string(),
    supportedScope: text
  }).strict()),
  criteriaSets: z.array(z.object({
    id,
    sourceId: id,
    applicability: text,
    requiredCriterionIds: z.array(id).min(1),
    /** 仅由应用的受控标准匹配器产生，模型不能自行增加合格证据。 */
    verifiedRequirements: z.array(z.object({ criterionId: id, evidenceIds: z.array(id).min(1) }).strict())
  }).strict()),
  partitionResults: z.array(memberAssessmentCandidateV3Schema)
}).strict();
export type MemberEvidencePackageV3 = z.infer<typeof memberEvidencePackageV3Schema>;

export const reviewReplacementSchema = z.discriminatedUnion('nodeType', [
  z.object({ nodeType: z.literal('claim'), value: healthClaimSchema }).strict(),
  z.object({ nodeType: z.literal('action'), value: healthActionSchema }).strict(),
  z.object({ nodeType: z.literal('overview'), value: overviewNodeSchema }).strict(),
  z.object({ nodeType: z.literal('system'), value: systemNodeSchema }).strict(),
  z.object({ nodeType: z.literal('question'), value: questionNodeSchema }).strict()
]);

export const clinicalFocusedReviewV1Schema = z.object({
  schemaVersion: z.literal(1),
  personId: id,
  inputSignature: signature,
  results: z.array(z.object({
    targetId: id,
    verdict: z.enum(['pass', 'replace', 'hold']),
    reason: text,
    replacement: reviewReplacementSchema.nullable()
  }).strict())
}).strict();
export type ClinicalFocusedReviewV1 = z.infer<typeof clinicalFocusedReviewV1Schema>;

export const memberAssessmentSnapshotV3Schema = memberAssessmentCandidateV3Schema.extend({
  id,
  status: z.enum(['current', 'stale']),
  generatedAt: z.string().datetime({ offset: true }),
  factRevision: z.number().int().nonnegative(),
  contextRevision: z.number().int().nonnegative(),
  promptVersion: id,
  rulesVersion: id,
  modelId: id,
  reasoningEffort: id,
  validationMode: z.enum(['local_only', 'local_and_focused_review']),
  reviewedTargetIds: z.array(id),
  heldTargetIds: z.array(id),
  limitations: z.array(text),
  evidenceCatalog: z.array(memberEvidenceRefSchema)
}).strict();
export type MemberAssessmentSnapshotV3 = z.infer<typeof memberAssessmentSnapshotV3Schema>;
