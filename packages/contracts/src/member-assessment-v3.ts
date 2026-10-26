import { z } from 'zod';
import { bodySystemIdSchema, clinicalTimeSchema, memberEvidenceRefSchema } from './member-v2.js';
import { clinicalContextSchema } from './clinical-context.js';

const id = z.string().min(1).max(160);
const signature = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1).max(2_000);

export const diagnosticStatusSchema = z.enum(['documented', 'criteria_met', 'likely', 'possible', 'undetermined']);
export const knowledgeBasisSchema = z.enum(['model_general', 'catalog', 'retrieved', 'not_applicable']);
export const assessmentModeSchema = z.enum(['full', 'partition', 'aggregate']);
export const assessmentSystemStatusSchema = z.enum(['attention', 'monitor', 'no_signal_in_scope', 'insufficient']);
export const lifestyleDomainSchema = z.enum(['diet', 'activity', 'sleep', 'supplements', 'daily_routine']);
export type LifestyleDomain = z.infer<typeof lifestyleDomainSchema>;
export const lifestyleBasisSchema = z.enum(['personalized', 'general']);
export type LifestyleBasis = z.infer<typeof lifestyleBasisSchema>;

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
  // 用户关心的健康问题，而非 source_fact/trend/诊断解释等证据层级。
  topicKey: id,
  systemIds: z.array(bodySystemIdSchema),
  kind: z.enum(['source_fact', 'trend', 'interpretation', 'diagnostic_assessment']),
  // 兼容旧快照；标题只用于定位主题，完整判断与条件仍在正文中。
  title: z.string().trim().min(1).max(80).optional(),
  text,
  // 同一主题的一条代表性解释承载变化判断；旧快照缺失不补造结论。
  changeAssessment: z.object({
    direction: z.enum(['improving', 'worsening', 'stable', 'mixed', 'uncertain', 'first_record']),
    basis: z.enum(['comparable_measurements', 'reference_status', 'qualitative_findings', 'mixed', 'insufficient']),
    summary: text,
    reason: text,
    currentEvidenceIds: z.array(id).min(1),
    previousEvidenceIds: z.array(id)
  }).strict().optional(),
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

export function assessmentChangeLabel(direction: NonNullable<HealthClaim['changeAssessment']>['direction']): string {
  return { improving: '有改善迹象', worsening: '较以前更需关注', stable: '基本稳定',
    mixed: '不同方面变化不一', uncertain: '暂不能判断变化', first_record: '暂无以往结果可比' }[direction];
}

const claimSystemNames: Record<z.infer<typeof bodySystemIdSchema>, string> = {
  cardiovascular: '心血管', endocrine_metabolic: '内分泌 / 代谢',
  hepatobiliary: '肝胆', renal_urinary: '肾脏 / 泌尿', digestive: '消化',
  respiratory: '肺 / 呼吸', hematology_immune: '血液 / 免疫',
  musculoskeletal: '肌肉 / 骨骼', neurological: '神经', sensory_oral: '眼耳鼻喉 / 口腔',
  reproductive: '生殖', dermatological: '皮肤'
};

/** 旧结果使用中性主题标题，不截断原判断，也不从病名推断新的结论。 */
export function healthClaimTitle(claim: HealthClaim): string {
  if (claim.title?.trim()) return claim.title.trim();
  const name = claim.systemIds[0] ? claimSystemNames[claim.systemIds[0]] : '健康';
  return `${name}检查结果`;
}

export const healthActionSchema = z.object({
  id,
  dedupeKey: id,
  systemIds: z.array(bodySystemIdSchema),
  claimIds: z.array(id),
  kind: z.enum(['habit', 'self_monitor', 'test_followup', 'seek_care', 'treatment_discussion', 'documented_plan']),
  // 原报告安排绑定本轮成员包中的文本事实；旧快照缺失时沿用原校验路径。
  sourceInstructionObservationId: id.optional(),
  // 新生成的日常建议明确主题与依据；旧快照保持兼容，不从缺失字段反推个性化。
  lifestyleDomain: lifestyleDomainSchema.optional(),
  lifestyleBasis: lifestyleBasisSchema.optional(),
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
  webSearchAllowed: z.boolean(),
  partitionScope: z.object({
    basis: z.enum(['system', 'document', 'clinical_date', 'fact_group']),
    label: text,
    selectedFactCount: z.number().int().nonnegative(),
    totalAcceptedFactCount: z.number().int().nonnegative(),
    primaryObservationIds: z.array(id),
    contextObservationIds: z.array(id)
  }).strict().optional()
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
    // 读取投影的记录日期及依据；不改写原事实 clinicalDate，也不从报告日期生成医疗期限。
    effectiveTime: clinicalTimeSchema.extend({
      evidence: z.array(z.object({ sourceSpanId: id, quote: z.string().nullable() }).strict()).min(1)
    }).optional(),
    // 本报告的资料时间背景；不能据此改写逐项临床日期或历史对比年份。
    sourceTime: z.object({
      scope: z.literal('document'),
      value: clinicalTimeSchema.shape.value.unwrap(),
      precision: z.enum(['day', 'month', 'year']),
      basis: z.enum(['clinical', 'report']),
      role: z.enum(['sampled', 'examined', 'encounter', 'report_issued']),
      evidence: z.array(z.object({ sourceSpanId: id, quote: z.string().nullable() }).strict()).min(1)
    }).strict().refine((time) => (time.basis === 'report') === (time.role === 'report_issued'),
      'Source time basis must match its date role')
      .refine((time) => time.value.split('-').length === ({ year: 1, month: 2, day: 3 } as const)[time.precision],
        'Source time precision must match its value').optional(),
    reportedAbnormalFlag: z.enum(['high', 'low', 'positive', 'negative', 'normal', 'unknown']),
    specimen: z.string().nullable(),
    method: z.string().nullable(),
    bodySite: z.string().nullable(),
    documentId: id,
    systemIds: z.array(bodySystemIdSchema),
    evidenceIds: z.array(id).min(1),
    sourceKind: z.literal('report'),
    clinicalContext: clinicalContextSchema.nullable().optional()
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
  unresolvedScope: z.array(z.object({
    documentId: id, reasonCodes: z.array(z.string()),
    affectedItemNames: z.array(z.string().min(1)).optional(),
    potentialImpact: z.string().min(1).optional()
  }).strict()),
  existingActions: z.array(z.object({
    id,
    title: text,
    detail: z.string(),
    status: z.string(),
    systemIds: z.array(bodySystemIdSchema),
    // 可选字段保持旧输入可读；来源时间与当下行动安排分开，不能把旧医嘱重新起算。
    origin: z.enum(['clinician_document', 'user_created', 'ai_proposed']).optional(),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    dueText: z.string().nullable().optional(),
    // 本人自行安排的说明；与原建议 dueText 分开，清空不回退到原建议。
    userScheduleText: z.string().nullable().optional(),
    evidenceLabel: z.string().nullable().optional(),
    sourceDate: clinicalTimeSchema.shape.value.optional(),
    sourceAssessmentId: id.optional(),
    sourceActionId: id.optional(),
    evidenceRefs: z.array(memberEvidenceRefSchema).optional()
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
  partitionResults: z.array(memberAssessmentCandidateV3Schema),
  /** 仅聚合模式使用：明确哪些已接纳事实未以原子事实再次送入模型。 */
  aggregateCoverage: z.object({
    totalFactCount: z.number().int().nonnegative(),
    directFactCount: z.number().int().nonnegative(),
    summarizedOnlyFactCount: z.number().int().nonnegative(),
    byDocument: z.array(z.object({
      documentId: id,
      totalFactCount: z.number().int().nonnegative(),
      directFactCount: z.number().int().nonnegative()
    }).strict())
  }).strict().optional()
}).strict();
export type MemberEvidencePackageV3 = z.infer<typeof memberEvidencePackageV3Schema>;

export const reviewReplacementSchema = z.discriminatedUnion('nodeType', [
  z.object({ nodeType: z.literal('claim'), value: healthClaimSchema }).strict(),
  z.object({ nodeType: z.literal('action'), value: healthActionSchema }).strict(),
  z.object({ nodeType: z.literal('overview'), value: overviewNodeSchema }).strict(),
  z.object({ nodeType: z.literal('system'), value: systemNodeSchema }).strict(),
  z.object({ nodeType: z.literal('question'), value: questionNodeSchema }).strict()
]);

/** P03 只回填本轮已授权节点，不复制或重新生成整个综合结果。 */
export const assessmentRepairReplacementSchema = z.discriminatedUnion('nodeType', [
  ...reviewReplacementSchema.options,
  z.object({ nodeType: z.literal('knowledge_source'), value: knowledgeSourceCandidateSchema }).strict()
]);
export type AssessmentRepairReplacement = z.infer<typeof assessmentRepairReplacementSchema>;

export const assessmentRepairRequestV1Schema = z.object({
  schemaVersion: z.literal(1),
  stage: z.literal('assessment'),
  personId: id,
  inputSignature: signature,
  originalCandidateHash: signature,
  targets: z.array(id).min(1),
  allowedPaths: z.array(z.string().min(1).max(200)).min(1),
  issues: z.array(text).min(1),
  targetDetails: z.array(z.object({
    targetId: id,
    nodeType: z.enum(['claim', 'action', 'overview', 'system', 'question', 'knowledge_source']),
    role: z.enum(['issue_owner', 'dependent']),
    ownIssues: z.array(text),
    dependsOnIds: z.array(id),
    triggerIssues: z.array(text),
    // 可用个人事实引用不表示诊断标签成立；由后续医学门禁继续核对实际用途。
    remainingEvidenceIds: z.array(id),
    remainingClaimIds: z.array(id),
    // 仅由应用补给本目标已引用的真实来源；不是新事实或原诊断/医嘱成立的凭据。
    sourceQuotes: z.array(z.object({
      evidenceId: id,
      quote: z.string().min(1),
      clinicalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable()
    }).strict()).optional()
  }).strict()).min(1)
}).strict();
export type AssessmentRepairRequestV1 = z.infer<typeof assessmentRepairRequestV1Schema>;

export const memberAssessmentRepairV1Schema = z.object({
  schemaVersion: z.literal(1),
  personId: id,
  inputSignature: signature,
  originalCandidateHash: signature,
  results: z.array(z.object({
    targetId: id,
    verdict: z.enum(['replace', 'unchanged']),
    // 无法可靠修正也必须逐目标明确说明，不省略依赖目标冒充完成。
    reason: text,
    replacement: assessmentRepairReplacementSchema.nullable()
  }).strict()).min(1)
}).strict();
export type MemberAssessmentRepairV1 = z.infer<typeof memberAssessmentRepairV1Schema>;

export const clinicalFocusedReviewV1Schema = z.object({
  schemaVersion: z.literal(1),
  personId: id,
  inputSignature: signature,
  results: z.array(z.object({
    targetId: id,
    verdict: z.enum(['pass', 'replace', 'hold']),
    reason: text,
    replacement: reviewReplacementSchema.nullable(),
    // 原因说明不是证据。仅同次替换可提供可由冻结原文逐字核查的窄证明。
    evidenceResolutionProofs: z.array(z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('same_fact_reference'), fromEvidenceId: id, toEvidenceId: id,
        sourceQuote: z.string().min(1).max(2000)
      }).strict(),
      z.object({
        kind: z.literal('missing_information_resolved'), evidenceId: id,
        uncertaintyText: z.string().min(1).max(2000), subject: z.string().min(1).max(100),
        sourceQuote: z.string().min(1).max(2000)
      }).strict(),
      z.object({
        kind: z.literal('source_context_text'), evidenceId: id,
        contextKind: z.enum(['method', 'test_name']),
        field: z.enum(['rationale', 'materialUncertainty', 'changeAssessment.reason']),
        sourceQuote: z.string().min(1).max(2000)
      }).strict()
    ])).max(16).optional()
  }).strict())
}).strict();
export type ClinicalFocusedReviewV1 = z.infer<typeof clinicalFocusedReviewV1Schema>;

/** 只供本机问题核查；不是健康正文、接纳凭据或可再次发送给模型的上下文。 */
export const assessmentReviewAuditRecordSchema = z.object({
  targetId: id,
  phase: z.enum(['p03_before_review', 'p04', 'p03_after_review', 'local_validation', 'local_dependency_guard']),
  original: assessmentRepairReplacementSchema,
  replacement: assessmentRepairReplacementSchema.nullable(),
  modelDecision: z.object({
    verdict: z.enum(['pass', 'replace', 'hold', 'unchanged']),
    reason: text
  }).strict().nullable(),
  receipt: z.object({
    stage: z.enum(['p02', 'p03', 'p04']), threadId: id, turnId: id, outputHash: signature
  }).strict(),
  origin: z.enum(['model', 'local_boundary_guard', 'local_dependency_guard', 'local_validation']),
  outcome: z.enum(['held', 'rebuilt']),
  localReasonCodes: z.array(z.string().min(1).max(240)).max(100),
  /** 完整原因过多时保留可见前缀和完整集合摘要，不让审计体积阻断可靠内容发布。 */
  localReasonOverflow: z.object({
    totalCount: z.number().int().min(101),
    omittedCount: z.number().int().positive(),
    fullHash: signature
  }).strict().optional(),
  // 不存在的引用仅记为未绑定尝试，不把它伪装成本成员可用的证据。
  boundEvidenceIds: z.array(id),
  unboundEvidenceIds: z.array(id),
  boundObservationIds: z.array(id),
  unboundObservationIds: z.array(id),
  recordHash: signature
}).strict();
export type AssessmentReviewAuditRecord = z.infer<typeof assessmentReviewAuditRecordSchema>;

export const assessmentReviewAuditSchema = z.object({
  version: z.literal(1),
  personId: id,
  inputSignature: signature,
  records: z.array(assessmentReviewAuditRecordSchema).max(4_000)
}).strict();
export type AssessmentReviewAudit = z.infer<typeof assessmentReviewAuditSchema>;

export const memberAssessmentSnapshotV3Schema = memberAssessmentCandidateV3Schema.extend({
  id,
  status: z.enum(['current', 'stale']),
  generatedAt: z.string().datetime({ offset: true }),
  factRevision: z.number().int().nonnegative(),
  contextRevision: z.number().int().nonnegative(),
  reviewScopeSignature: signature,
  promptVersion: id,
  rulesVersion: id,
  modelId: id,
  reasoningEffort: id,
  validationMode: z.enum(['local_only', 'local_and_focused_review']),
  reviewedTargetIds: z.array(id),
  heldTargetIds: z.array(id),
  /** 应用生成的私有核查记录。旧快照缺失表示不可追溯，不能补造模型判定。 */
  reviewAuditRecords: assessmentReviewAuditSchema.optional(),
  /** 结构完整性记录，不代表医学判断已获证明；缺项不撤下其他可靠结论。 */
  comparisonCoverage: z.object({
    version: z.literal(1),
    topicCount: z.number().int().nonnegative(),
    coveredTopicKeys: z.array(id),
    missingTopicKeys: z.array(id)
  }).strict().optional(),
  /** 主进程的只读展示投影；不是模型结果或新的校验凭据，不回写持久化快照。 */
  presentation: z.object({
    version: id,
    rebuiltNodeIds: z.array(id)
  }).strict().optional(),
  limitations: z.array(text),
  evidenceCatalog: z.array(memberEvidenceRefSchema),
  /** 应用记录的执行路径；不由模型回填。 */
  processingPlan: z.object({
    strategy: z.enum(['full', 'partitioned']),
    trigger: z.enum(['none', 'runtime_context_window_exceeded']),
    partitionCount: z.number().int().nonnegative(),
    /** 分区内被隔离过的节点数；最终通过 P04 后也保留过程审计，不代表仍被隔离。 */
    partitionHeldTargetCount: z.number().int().nonnegative().optional(),
    /** 本机审计用；不把长 ID 清单送入聚合模型输入。 */
    aggregateSummarizedOnlyObservationIds: z.array(id).optional()
  }).strict(),
  /** 仅由应用写入；模型给出 URL 不构成已核验来源。 */
  knowledgeVerifications: z.array(z.object({
    sourceId: id,
    status: z.enum(['catalog_curated', 'model_cited', 'tool_content_verified']),
    checkedAt: z.string().nullable(),
    contentHash: signature.nullable(),
    toolReceiptId: id.nullable()
  }).strict())
}).strict();
export type MemberAssessmentSnapshotV3 = z.infer<typeof memberAssessmentSnapshotV3Schema>;

/** 缺失是旧版未留存，并不表示从未发生隔离或已经通过复核。 */
export function assessmentReviewAuditAvailability(snapshot: Pick<MemberAssessmentSnapshotV3, 'reviewAuditRecords'>):
  'recorded' | 'unavailable_legacy' {
  return snapshot.reviewAuditRecords ? 'recorded' : 'unavailable_legacy';
}

/** 私有审计只能解释已隔离/重建节点；其中的引用不能成为生效内容的依据。 */
export function assessmentReviewAuditEvidenceIds(node: AssessmentRepairReplacement): string[] {
  const value = node.value;
  return [...new Set([
    ...('evidenceIds' in value ? value.evidenceIds : []),
    ...('counterEvidenceIds' in value ? value.counterEvidenceIds : []),
    ...('criteriaBasis' in value ? value.criteriaBasis?.requirements.flatMap((item) => item.evidenceIds) ?? [] : [])
  ])];
}

export function assessmentReviewAuditScopeValid(snapshot: Pick<MemberAssessmentSnapshotV3,
  'personId' | 'inputSignature' | 'reviewAuditRecords' | 'heldTargetIds' | 'presentation' | 'evidenceCatalog'>): boolean {
  const audit = snapshot.reviewAuditRecords;
  if (!audit) return true;
  if (audit.personId !== snapshot.personId || audit.inputSignature !== snapshot.inputSignature) return false;
  const evidenceIds = new Set(snapshot.evidenceCatalog.map((item) => item.id));
  const observationIds = new Set(snapshot.evidenceCatalog.flatMap((item) => item.observationId ? [item.observationId] : []));
  const held = new Set(snapshot.heldTargetIds);
  const rebuilt = new Set(snapshot.presentation?.rebuiltNodeIds ?? []);
  if ([...held, ...rebuilt].some((id) => !audit.records.some((record) => record.targetId === id))) return false;
  const recordKeys = audit.records.map((record) => [record.targetId, record.phase, record.receipt.threadId, record.receipt.turnId].join('\n'));
  if (new Set(recordKeys).size !== recordKeys.length) return false;
  return audit.records.every((record) => {
    if (record.localReasonOverflow && (record.localReasonCodes.length !== 100
      || record.localReasonOverflow.totalCount !== record.localReasonCodes.length + record.localReasonOverflow.omittedCount)) return false;
    if (record.original.value.id !== record.targetId || record.replacement && (record.replacement.value.id !== record.targetId
      || record.replacement.nodeType !== record.original.nodeType)) return false;
    if (record.outcome === 'held' ? !held.has(record.targetId) : !rebuilt.has(record.targetId) || held.has(record.targetId)) return false;
    if (record.phase === 'p04' && (record.receipt.stage !== 'p04' || record.modelDecision === null)
      || record.phase.startsWith('p03_') && (record.receipt.stage !== 'p03' || record.modelDecision === null)) return false;
    if (record.phase === 'p04' && record.modelDecision?.verdict === 'unchanged'
      || record.phase.startsWith('p03_') && !['replace', 'unchanged'].includes(record.modelDecision?.verdict ?? '')
      || record.phase.startsWith('local_') && record.modelDecision !== null
      || record.origin === 'model' && record.modelDecision?.verdict !== 'hold') return false;
    if (record.modelDecision?.verdict === 'replace' ? !record.replacement : record.replacement !== null) return false;
    const referenced = [...new Set([...assessmentReviewAuditEvidenceIds(record.original),
      ...(record.replacement ? assessmentReviewAuditEvidenceIds(record.replacement) : [])])];
    const bound = new Set(record.boundEvidenceIds), unbound = new Set(record.unboundEvidenceIds);
    const observationReferences = [...new Set([record.original, record.replacement].flatMap((node) =>
      node?.nodeType === 'action' && node.value.sourceInstructionObservationId ? [node.value.sourceInstructionObservationId] : []))];
    const boundObservations = new Set(record.boundObservationIds), unboundObservations = new Set(record.unboundObservationIds);
    return bound.size === record.boundEvidenceIds.length && unbound.size === record.unboundEvidenceIds.length
      && [...bound].every((id) => evidenceIds.has(id) && referenced.includes(id) && !unbound.has(id))
      && [...unbound].every((id) => !evidenceIds.has(id) && referenced.includes(id))
      && referenced.every((id) => bound.has(id) || unbound.has(id))
      && boundObservations.size === record.boundObservationIds.length && unboundObservations.size === record.unboundObservationIds.length
      && [...boundObservations].every((id) => observationIds.has(id) && observationReferences.includes(id) && !unboundObservations.has(id))
      && [...unboundObservations].every((id) => !observationIds.has(id) && observationReferences.includes(id))
      && observationReferences.every((id) => boundObservations.has(id) || unboundObservations.has(id));
  });
}

/** 只能选择当前已发布快照中的现有行动；标题与内容由主进程从快照读取。 */
export const adoptMemberAssessmentActionInputSchema = z.object({
  personId: id,
  snapshotId: id,
  actionId: id
}).strict();
export type AdoptMemberAssessmentActionInput = z.infer<typeof adoptMemberAssessmentActionInputSchema>;
