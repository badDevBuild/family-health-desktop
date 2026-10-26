import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { UpdateActionScheduleInput } from '@contracts';
import { processNowInputSchema, type ProcessNowInput } from '@contracts';
import type { AccountState, ActionItem, ActionStatus, AdoptMemberAssessmentActionInput, AdoptedActionReceipt, AdoptLifestyleProposalInput, ArchivePersonInput, BodySystemDetailV2, BodySystemId, BodySystemSummaryV2, ConceptMappingReceipt, ConceptReviewBundle, CreateActionItemInput, CreateManualNoteInput, CreatePersonInput, DashboardSnapshot, DeleteDocumentInput, HealthEventDetailV2, HealthEventRelationReceipt, HealthEventV2, ImportFilesReceipt, InboxBindingSummary, LifestylePlanV2, LifestyleProposalDecisionReceipt, MemberAssessmentSnapshotV3, MemberEvidenceBundle, MemberEvidenceRef, MemberOverviewV2, MergeHealthEventsInput, MetricSeriesDetailV2, MetricSeriesSummary, ObservationCandidate, ReportMetadataCorrectionReceipt, RestorePersonInput, SetConceptMappingInput, SetDocumentInclusionInput, SetLifestyleProposalDecisionInput, SplitHealthEventInput, SystemAnalysisSnapshot, SystemEvidenceBundle, UndoConceptMappingInput, UndoHealthEventRelationInput, UndoReportMetadataInput, UpdatePersonDisplayInput, UpdateReportMetadataInput, UpdateScheduleInput } from '@contracts';
import { bodySystemDetailV2Schema, bodySystemSummaryV2Schema, conceptMappingReceiptSchema, conceptReviewBundleSchema, containsProcessNarrative, dashboardSnapshotSchema, formatResult, healthEventDetailV2Schema, healthEventV2Schema, lifestylePlanV2Schema, memberAssessmentSnapshotV3Schema, memberEvidenceBundleSchema, memberOverviewV2Schema, metricSeriesDetailV2Schema, presentAssessmentText } from '@contracts';
import { bodySystemRegistry, buildMetricSeries as buildMetricSeriesV2, classifyHealthEventType, conceptDictionary, evaluateObservationCandidate, linkConceptToSystems, linkLegacyCandidateToSystems, sameAdoptedActionScope, stableHash, type TrendObservationInput } from '@core';
import { detectInput, prepareDirectOriginalReport, type LegacyDocConverter } from '@ingestion';
import { WorkspaceStore, type AcceptedObservationSummary, type OpenExtractionReviewIssue } from '@storage';
import { determineEligibleSlot, jobInputSignature, nextScheduledRunUtc } from '@workflow';
import { recoveryPointsReferenceSourceHash } from './recovery-point-service.js';
import { buildSourceUrgentNotices } from './source-urgent-notice.js';
import { buildCurrentSymptomNotices } from './current-symptom-notice.js';
import { ACCEPTANCE_RULES_VERSION, MEMBER_ASSESSMENT_PROMPT_VERSION, MEMBER_ASSESSMENT_RULES_VERSION, promptMetaForStage } from './prompts/index.js';
import { buildSystemEvidenceBundle as buildSystemEvidenceBundleFromStore } from './system-evidence.js';
import { familyAssessmentNarrative, presentMemberAssessment } from './assessment-presentation.js';
import { buildAssessmentPriorities } from './assessment-priorities.js';
import { buildMemberSummaryData, type MemberSummaryData } from './export-service.js';
import { normalizeStoredSource } from './source-normalization.js';
import { processingRebuildExpectedSourcesSchema, type ProcessingRebuildReceipt, type ProcessingRebuildSourceIdentity } from '@contracts';
import { projectEventDate, readEventDateSources } from './event-date-projection.js';
import { withDocumentTimes, observationDisplayTime, type ObservationWithDocumentTime } from './observation-date-presentation.js';
import { hasSurvivingSystemSupport } from './assessment-review-boundary.js';
import { isReadableAssessmentVersion } from './assessment-readable-versions.js';

const organNames = [
  ['cardiovascular', '心血管'],
  ['metabolic', '代谢 / 内分泌'],
  ['hepatobiliary', '肝胆'],
  ['renal', '肾脏 / 泌尿'],
  ['digestive', '消化'],
  ['hematology', '血液'],
  ['respiratory', '肺 / 呼吸'],
  ['sensory', '眼 / 五官']
] as const;

type OrganId = typeof organNames[number][0];

function savedAiActionTitle(value: string): string {
  const text = presentAssessmentText(value).text;
  return containsProcessNarrative(text) ? '已有行动记录，安排前需确认依据' : text || '已保存的行动安排';
}

/** 只读整理历史 AI 行动；生活采纳的正文由本人填写，不能按 AI 来源一并改写。 */
export function presentSavedAction(action: ActionItem, userDetail = false): ActionItem {
  if (action.origin !== 'ai_proposed') return action;
  const title = presentAssessmentText(action.title).text;
  const detail = userDetail ? action.detail : presentAssessmentText(action.detail).text;
  const dueText = userDetail || action.dueText === null ? action.dueText : presentAssessmentText(action.dueText).text || null;
  // 无法安全剥离的混合句不能继续成为做法；整条派生安排暂不用于执行，原文仍留在数据库。
  const unsafeInstruction = !userDetail && [title, detail, dueText ?? ''].some(containsProcessNarrative);
  return {
    ...action,
    title: unsafeInstruction ? '已有行动记录，安排前需确认依据' : savedAiActionTitle(action.title),
    detail: userDetail ? action.detail : unsafeInstruction
      ? '这项行动记录仍保留。安排前请回看原始依据及适用限制，不宜直接按这段文字执行。'
      : detail || '具体做法待确认，请结合本人原有安排决定。',
    dueText: unsafeInstruction ? null : dueText
  };
}

const organMatchers: Record<OrganId, RegExp> = {
  cardiovascular: /低密度|高密度|胆固醇|甘油三酯|载脂蛋白|血压|ldl|hdl|cholesterol|triglyceride|apolipoprotein/i,
  metabolic: /血糖|葡萄糖|糖化血红蛋白|胰岛素|甲状腺|促甲状腺|尿酸|glucose|hba1c|insulin|thyroid|tsh|ft3|ft4|uric/i,
  hepatobiliary: /谷丙|谷草|转氨酶|胆红素|白蛋白|球蛋白|碱性磷酸酶|谷氨酰|alt|ast|bilirubin|albumin|globulin|alp|ggt/i,
  renal: /肌酐|尿素|肾小球|尿蛋白|尿微量白蛋白|尿酸|creatinine|urea|egfr|proteinuria|uric/i,
  digestive: /便潜血|幽门螺杆菌|淀粉酶|脂肪酶|胃蛋白酶|fecal|occult blood|helicobacter|amylase|lipase|pepsin/i,
  hematology: /血红蛋白|红细胞|白细胞|血小板|铁蛋白|血清铁|中性粒|淋巴细胞|hemoglobin|rbc|wbc|platelet|ferritin|neutrophil|lymphocyte/i,
  respiratory: /肺活量|肺功能|呼吸|肺结节|一秒率|fev|fvc|spirometry|pulmonary/i,
  sensory: /视力|眼压|眼底|听力|耳鼻喉|vision|intraocular|fundus|hearing|audiometry/i
};

function observationOrgans(observation: AcceptedObservationSummary): OrganId[] {
  return organNames
    .filter(([id]) => organMatchers[id].test(observation.conceptKey))
    .map(([id]) => id);
}

function parseReferenceRange(value: string | null): { low: number | null; high: number | null } {
  if (!value) return { low: null, high: null };
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)\s*(?:-|–|—|~|至)\s*(-?\d+(?:\.\d+)?)(?:\s.*)?$/);
  if (!match) return { low: null, high: null };
  const low = Number(match[1]);
  const high = Number(match[2]);
  return Number.isFinite(low) && Number.isFinite(high) ? { low, high } : { low: null, high: null };
}

function buildTrendSeries(observations: AcceptedObservationSummary[]) {
  const groups = new Map<string, AcceptedObservationSummary[]>();
  for (const observation of observations) {
    if (observation.valueKind !== 'numeric' || !observation.clinicalDate) continue;
    const contextKey = [observation.specimen, observation.method, observation.bodySite]
      .map((value) => value?.trim().toLocaleLowerCase('zh-CN') ?? '未记录')
      .join('|');
    const key = `${observation.personId}\u0000${observation.conceptKey}\u0000${observation.unit ?? ''}\u0000${contextKey}`;
    const group = groups.get(key) ?? [];
    group.push(observation);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const first = group[0]!;
    const points = group
      .map((observation) => {
        const numeric = observation.qualifier === 'eq' && observation.decimalValue !== null
          ? Number(observation.decimalValue)
          : null;
        const range = parseReferenceRange(observation.referenceRange);
        return {
          date: observation.clinicalDate!,
          displayValue: observation.rawText,
          numericValue: numeric !== null && Number.isFinite(numeric) ? numeric : null,
          referenceLow: range.low,
          referenceHigh: range.high,
          abnormalFlag: observation.abnormalFlag,
          sourceLabel: observation.sourceLabel,
          sourceSpanId: observation.sourceSpanId,
          documentId: observation.documentId
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date));
    return {
      id: `trend-${stableHash({ personId: first.personId, concept: first.conceptKey, unit: first.unit, specimen: first.specimen, method: first.method, bodySite: first.bodySite }).slice(0, 20)}`,
      personId: first.personId,
      name: first.conceptKey,
      unit: first.unit,
      interpretation: points.length > 1 ? `已有 ${points.length} 次带日期的数值记录。` : '目前只有 1 次带日期的数值记录，暂不能判断趋势。',
      comparisonNote: `已按相同单位、标本、方法和部位分组；未记录的比较条件不会与已知条件混合。`,
      points
    };
  });
}

function formatLabel(mediaType: string): string {
  const labels: Record<string, string> = {
    'application/pdf': 'PDF',
    'image/jpeg': 'JPEG',
    'image/png': 'PNG',
    'image/heic': 'HEIC',
    'image/heif': 'HEIC',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word DOCX',
    'application/msword': 'Word DOC',
    'text/plain': '纯文本'
  };
  return labels[mediaType] ?? mediaType;
}

function isReadOnlyPartialPublishIssue(
  issue: OpenExtractionReviewIssue,
  documentStatus: 'queued' | 'needs_review' | 'completed' | 'blocked' | 'ignored' | undefined,
  committed: boolean
): boolean {
  return issue.severity === 'warning'
    && (issue.kind === 'field_conflict' || issue.kind === 'coverage_gap')
    && issue.candidateDiffs.length === 0
    && documentStatus === 'completed'
    && committed;
}

/** 只有来源对账事项可从收件箱迁移，身份、值选择及其他开放事项仍保留原入口。 */
function isSourceOnlyExtractionIssue(issue: OpenExtractionReviewIssue): boolean {
  return (issue.kind === 'field_conflict' || issue.kind === 'coverage_gap')
    && issue.candidateDiffs.length === 0
    && !issue.reasonCodes.some((code) => code.startsWith('PERSON_'));
}

/** 原因只解释处理阶段，不把本机识别失败说成原件坏了，也不让用户猜结果。 */
function sourceRepairExplanation(reasonCodes: string[], latestRepairOutcome: string | null): string {
  const codes = reasonCodes.map((code) => code.split(':')[0]!);
  if (codes.length > 0 && codes.every((code) => [
    'direct_original_clinical_date_unverified', 'direct_original_clinical_date_binding_missing', 'direct_original_metadata_field_unverified',
    'direct_original_metadata_time_unverified'
  ].includes(code))) {
    return codes.some(code => ['direct_original_clinical_date_unverified', 'direct_original_clinical_date_binding_missing'].includes(code))
      ? '检查结果已保存；部分检查日期暂不能确认，未用于按日期判断变化。'
      : '检查结果已保存；报告标题、机构或报告日期等辅助信息仍有未确认项。';
  }
  if (latestRepairOutcome && ['schema_invalid', 'scope_violation', 'candidate_drift'].includes(latestRepairOutcome)
    || codes.some((code) => /^EXTRACTION_REPAIR_(?:SCHEMA|SCOPE|CANDIDATE)/u.test(code))) {
    return '自动修复的内容或格式没有通过检查，本次修复未被采用；没有改动已经保存的结果。';
  }
  if (codes.some((code) => /^(?:LOCAL_VISUAL_|local_visual_|ORIGINAL_VISUAL_|source_span_missing|missing_evidence|evidence_missing|source_readability|SOURCE_REBINDING_)/u.test(code))) {
    return '部分来源文字或位置还没有可靠读出、对应到检查结果；本机识别未成功不等于原件不可读。';
  }
  return '模型读取的结果与本机来源在项目、结果、单位或日期上尚未核验一致；这不等于原报告的检查结果有误。';
}

function normalizeAbnormalFlag(value: string | null) {
  const normalized = value?.trim().toLowerCase();
  if (['high', 'h', '偏高', '升高', '↑'].includes(normalized ?? '')) return 'high' as const;
  if (['low', 'l', '偏低', '降低', '↓'].includes(normalized ?? '')) return 'low' as const;
  if (['positive', '+', '阳性'].includes(normalized ?? '')) return 'positive' as const;
  if (['negative', '-', '阴性'].includes(normalized ?? '')) return 'negative' as const;
  if (['normal', '正常', '未见异常'].includes(normalized ?? '')) return 'normal' as const;
  return 'unknown' as const;
}

function clinicalTimeLabel(value: string, precision: 'year' | 'month' | 'day'): string {
  if (precision === 'year') return `${value}年`;
  if (precision === 'month') {
    const [year, month] = value.split('-');
    return `${year}年${Number(month)}月`;
  }
  return value;
}

function historicalTimeForObservation(
  observation: AcceptedObservationSummary,
  report: ReturnType<WorkspaceStore['listReportMetadata']>[number] | undefined
) {
  const clinicalDate = observation.clinicalDate;
  if (!clinicalDate || !report?.extracted) return null;
  const precisionRank = { day: 3, month: 2, year: 1 } as const;
  return report.extracted.times
    .filter((time) => time.role === 'history_quoted' && ['day', 'month', 'year'].includes(time.precision))
    .filter((time) => clinicalDate === time.value || clinicalDate.startsWith(`${time.value}-`))
    .sort((left, right) => precisionRank[right.precision as keyof typeof precisionRank]
      - precisionRank[left.precision as keyof typeof precisionRank])[0] ?? null;
}

function memberEvidence(observation: AcceptedObservationSummary): MemberEvidenceRef {
  return {
    id: `evidence-${observation.id}-${observation.sourceSpanId}-primary`,
    kind: 'observation',
    observationId: observation.id,
    eventId: observation.eventId,
    documentId: observation.documentId,
    sourceSpanId: observation.sourceSpanId,
    knowledgeId: null,
    label: observation.sourceLabel,
    locator: null,
    quote: observation.sourceQuote
  };
}

function memberEvidenceSources(observation: AcceptedObservationSummary): MemberEvidenceRef[] {
  const refs = observation.evidence.length > 0
    ? observation.evidence
    : [{ sourceSpanId: observation.sourceSpanId, quote: observation.sourceQuote }];
  return refs.map((reference, index) => ({
    id: `evidence-${observation.id}-${reference.sourceSpanId}-${index}`,
    kind: 'observation',
    observationId: observation.id,
    eventId: observation.eventId,
    documentId: observation.documentId,
    sourceSpanId: reference.sourceSpanId,
    knowledgeId: null,
    label: reference.sourceRole === 'duplicate_source'
      ? `${observation.sourceLabel}（同次检查的另一处来源）`
      : observation.sourceLabel,
    locator: null,
    quote: reference.quote
  }));
}

function memberMapping(observation: AcceptedObservationSummary) {
  return observation.mapping;
}

function memberSystemLinks(observation: AcceptedObservationSummary) {
  if (observation.originalNameStatus === 'legacy_missing') {
    return linkLegacyCandidateToSystems(observation.mapping, observation.modelStandardNameCandidate);
  }
  return linkConceptToSystems(memberMapping(observation));
}

function memberDisplayName(observation: AcceptedObservationSummary): string {
  if (observation.originalNameStatus === 'legacy_missing') {
    return `${observation.modelStandardNameCandidate ?? observation.conceptKey}（旧记录候选名）`;
  }
  const mapping = memberMapping(observation);
  return mapping.status === 'verified'
    ? mapping.canonicalName ?? observation.originalName
    : observation.originalName;
}

function trendMapping(observation: AcceptedObservationSummary) {
  if (observation.originalNameStatus !== 'legacy_missing') return observation.mapping;
  const name = observation.modelStandardNameCandidate ?? observation.conceptKey;
  return {
    rawName: name,
    normalizedName: name,
    conceptId: null,
    canonicalName: null,
    status: 'unmapped' as const,
    confidence: 0,
    reasons: ['旧记录缺少原始项目名，只按原有候选名精确分组，不做别名合并。']
  };
}

function asTrendObservation(observation: ObservationWithDocumentTime): TrendObservationInput {
  const range = parseReferenceRange(observation.referenceRange);
  const qualifier = ['eq', 'lt', 'lte', 'gt', 'gte'].includes(observation.qualifier ?? '')
    ? observation.qualifier as TrendObservationInput['comparator']
    : null;
  const numericValue = observation.decimalValue === null ? null : Number(observation.decimalValue);
  return {
    id: observation.id,
    personId: observation.personId,
    rawName: observation.originalNameStatus === 'legacy_missing'
      ? observation.modelStandardNameCandidate ?? observation.conceptKey
      : observation.originalName,
    standardName: observation.modelStandardNameCandidate,
    resolvedMapping: trendMapping(observation),
    rawText: observation.rawText,
    numericValue: numericValue !== null && Number.isFinite(numericValue) ? numericValue : null,
    comparator: qualifier,
    unit: observation.unit,
    referenceLow: range.low,
    referenceHigh: range.high,
    abnormalFlag: observation.abnormalFlag,
    clinicalDate: observation.clinicalDate,
    ...(observation.documentTime ? { documentTime: observation.documentTime } : {}),
    ...(observation.effectiveTime ? { effectiveTime: observation.effectiveTime } : {}),
    dateRole: 'unknown',
    specimen: observation.specimen,
    method: observation.method,
    bodySite: observation.bodySite,
    documentId: observation.documentId,
    sourceSpanId: observation.sourceSpanId,
    sourceLabel: observation.sourceLabel,
    quote: observation.sourceQuote,
    evidenceSources: memberEvidenceSources(observation),
    duplicateSourceCount: observation.evidence.filter((reference) => reference.sourceRole === 'duplicate_source').length
  };
}

function buildMemberMetricSeries(observations: ObservationWithDocumentTime[]): MetricSeriesSummary[] {
  return buildMetricSeriesV2(observations.map(asTrendObservation));
}

const legacyOrganToSystem: Record<string, BodySystemId> = {
  cardiovascular: 'cardiovascular',
  metabolic: 'endocrine_metabolic',
  hepatobiliary: 'hepatobiliary',
  renal: 'renal_urinary',
  digestive: 'digestive',
  hematology: 'hematology_immune',
  respiratory: 'respiratory',
  sensory: 'sensory_oral'
};

// 发送范围与 IPC 共用契约类型，新增范围字段不再维护第二份手写名单。
export type ProcessNowOptions = Omit<ProcessNowInput, 'confirmedDataRecipient' | 'consentVersion'> & {
  accountState: AccountState;
  consentVersion: number;
};

export class PersonalWorkspaceService {
  readonly store: WorkspaceStore;
  readonly automaticUploadRecovery: Promise<void>;
  private closed = false;

  constructor(
    rootDirectory: string,
    readonly workspaceName: string,
    private readonly now: () => Date = () => new Date(),
    private readonly timeZoneProvider: () => string = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    private readonly legacyDocConverter: LegacyDocConverter | null = null
  ) {
    this.store = new WorkspaceStore({ rootDirectory, now });
    this.store.recoverInterruptedJobs();
    // 正常工作区启动时仅升级旧自动签发日期投影；只读页面轮询不触发结果修订。
    this.store.upgradeDirectOriginalReportDateProjection();
    this.store.revokeUnreferencedManualProcessingConsents();
    // 启动恢复失败保持意图未完成，下次正常启动仍可恢复；不能产生未处理的 Promise 拒绝。
    this.automaticUploadRecovery = this.resumeInterruptedUploads().catch(() => undefined);
  }

  /** 只恢复持久上传意图已绑定的保险库原件，不重扫旧待处理资料或重新打开用户路径。 */
  private async resumeInterruptedUploads(): Promise<void> {
    const assertOpen = () => { if (this.closed) throw new Error('WORKSPACE_CLOSED'); };
    for (const item of this.store.automaticUploadIntents.listRecoveryItems()) {
      try {
        const source = this.store.getDocumentOriginalSource(item.documentId);
        if (source.personId !== item.personId || source.sourceObjectId !== item.sourceObjectId || source.sha256 !== item.sha256) {
          throw new Error('AUTOMATIC_UPLOAD_INTENT_SOURCE_CHANGED');
        }
        const bytes = await readFile(source.sourcePath);
        assertOpen();
        if (createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error('SOURCE_HASH_MISMATCH');
        const manifest = await normalizeStoredSource({ store: this.store, documentId: item.documentId,
          sourceObjectId: item.sourceObjectId, sha256: item.sha256, displayName: source.displayName, bytes,
          createdAt: this.now().toISOString(), legacyDocConverter: this.legacyDocConverter, validateBeforeCommit: assertOpen });
        assertOpen();
        this.store.saveSourceManifest(manifest);
        this.store.automaticUploadIntents.markReady(item.intentId, item.itemIndex);
      } catch (error) {
        if (this.closed) return;
        this.store.automaticUploadIntents.markRejected(item.intentId, item.itemIndex,
          error instanceof Error ? error.message : 'IMPORT_FAILED');
      }
    }
    if (this.closed) return;
    for (const intentId of this.store.automaticUploadIntents.listOpenIntentIds()) this.store.automaticUploadIntents.finalize(intentId);
  }

  private requireActivePerson(personId: string) {
    const person = this.store.listPersons().find((item) => item.id === personId && item.archivedAt === null);
    if (!person) throw new Error('PERSON_NOT_FOUND');
    return person;
  }

  private memberObservations(personId: string, includeDocumentTime = false): ObservationWithDocumentTime[] {
    this.requireActivePerson(personId);
    const conflictedDocumentIds = new Set(this.store.listOpenExtractionReviewIssues()
      .filter((issue) => issue.personId === personId && issue.kind === 'person_conflict')
      .map((issue) => issue.documentId));
    const observations = this.store.listAcceptedObservations(personId)
      .filter((observation) => !conflictedDocumentIds.has(observation.documentId));
    return includeDocumentTime ? withDocumentTimes(this.store, personId, observations) : observations;
  }

  /** 导出按成员读取完整事实，不复用页面最近 500 条的展示窗口，也不扩大 UI 快照。 */
  getMemberSummaryExport(
    input: { personId: string; dateFrom: string | null; dateTo: string | null },
    exportedAt = this.now().toISOString()
  ): MemberSummaryData {
    const observations = this.memberObservations(input.personId);
    return buildMemberSummaryData(this.getSnapshot(), input, exportedAt,
      this.getMemberAssessment(input.personId), observations);
  }

  getMemberAssessment(personId: string): MemberAssessmentSnapshotV3 | null {
    this.requireActivePerson(personId);
    const snapshot = this.store.listMemberAssessmentSnapshots(personId, true)[0];
    if (!snapshot) return null;
    const latestRules = snapshot.promptVersion === MEMBER_ASSESSMENT_PROMPT_VERSION
      && snapshot.rulesVersion === MEMBER_ASSESSMENT_RULES_VERSION;
    // 只读兼容登记过的已发布版本；事实、背景及核查范围仍必须匹配。
    const readablePrevious = isReadableAssessmentVersion(snapshot.promptVersion, snapshot.rulesVersion);
    if ((!latestRules && !readablePrevious)
      || snapshot.factRevision !== this.store.getFactRevision(personId)
      || snapshot.contextRevision !== this.store.getClinicalContextRevision(personId)
      || snapshot.reviewScopeSignature !== this.store.getOpenReviewScopeSignature(personId)) return null;
    const parsed = memberAssessmentSnapshotV3Schema.safeParse(snapshot);
    if (!parsed.success) return null;
    // 未发布正文只供本机核查，不进入普通健康页面、摘要导出或其他展示投影。
    const visibleSnapshot = { ...parsed.data, status: latestRules ? 'current' as const : 'stale' as const };
    delete visibleSnapshot.reviewAuditRecords;
    return presentMemberAssessment(visibleSnapshot);
  }

  getConceptReview(personId: string): ConceptReviewBundle {
    const observations = this.memberObservations(personId);
    return conceptReviewBundleSchema.parse({
      personId,
      dictionaryVersion: conceptDictionary[0]?.version ?? 'unknown',
      catalog: conceptDictionary.map((definition) => ({
        id: definition.id,
        version: definition.version,
        canonicalName: definition.canonicalName,
        aliases: definition.aliases,
        specimen: definition.specimen,
        compatibleUnits: definition.compatibleUnits,
        systemLinks: definition.systemLinks
      })),
      items: observations.map((observation) => ({
        observationId: observation.id,
        rawName: observation.originalName,
        displayValue: observation.rawText,
        unit: observation.unit,
        clinicalDate: observation.clinicalDate,
        mapping: observation.mapping,
        mappingVersion: observation.mappingVersion,
        correctedAt: observation.mappingCorrectedAt,
        canUndo: observation.mappingCanUndo,
        evidence: memberEvidence(observation)
      })).sort((left, right) => {
        const statusOrder = { unmapped: 0, proposed: 1, verified: 2 } as const;
        return statusOrder[left.mapping.status] - statusOrder[right.mapping.status]
          || left.rawName.localeCompare(right.rawName, 'zh-CN');
      })
    });
  }

  setConceptMapping(input: SetConceptMappingInput): ConceptMappingReceipt {
    this.requireActivePerson(input.personId);
    return conceptMappingReceiptSchema.parse(this.store.setObservationConceptMapping(input));
  }

  undoConceptMapping(input: UndoConceptMappingInput): ConceptMappingReceipt {
    this.requireActivePerson(input.personId);
    return conceptMappingReceiptSchema.parse(this.store.undoObservationConceptMapping(input));
  }

  private currentSystemAnalysis(personId: string, systemId: BodySystemId, observations: AcceptedObservationSummary[]): SystemAnalysisSnapshot | null {
    // 一旦采用 V3，旧系统结论只能作为历史存储，不能在 V3 因待核对范围变化失效时回退冒充当前结果。
    if (this.store.hasMemberAssessmentHistory(personId)) return null;
    const allSystemSnapshots = this.store.listSystemAnalysisSnapshots(personId, false)
      .filter((item) => item.systemId === systemId);
    const systemSnapshot = allSystemSnapshots.find((item) => item.status === 'current')
      ?? allSystemSnapshots.find((item) => item.status === 'stale');
    if (systemSnapshot) {
      // v1 系统快照仍可能保存在本机数据库中。读取时补齐 result-first 字段，
      // 让升级后的界面可继续显示旧结论；输入签名已经包含 v2 提示词，后续任务会重算。
      const legacy = systemSnapshot as SystemAnalysisSnapshot & {
        overview?: string;
        assessmentStatus?: SystemAnalysisSnapshot['assessmentStatus'];
        recommendations?: SystemAnalysisSnapshot['recommendations'];
        clinicallyImportantUnknowns?: string[];
      };
      return {
        ...systemSnapshot,
        // V3 已接管当前解读；即使旧系统快照当时通过复核，也只能作为带日期的历史说明。
        status: 'stale',
        overview: legacy.overview ?? systemSnapshot.headline,
        assessmentStatus: legacy.assessmentStatus ?? 'undetermined',
        recommendations: legacy.recommendations ?? [],
        clinicallyImportantUnknowns: legacy.clinicallyImportantUnknowns
          ?? systemSnapshot.dataGaps.map((gap) => `${gap.text} ${gap.consequence}`)
      };
    }
    const snapshot = this.store.listCurrentDerivedSnapshots().find((item) => item.personId === personId);
    if (!snapshot) return null;
    const claims = snapshot.payload.claims.filter((claim) => claim.organId && legacyOrganToSystem[claim.organId] === systemId);
    if (claims.length === 0) return null;
    const evidenceObservationIds = [...new Set(claims.flatMap((claim) => claim.evidenceObservationIds))];
    const summaryParts = claims.filter((claim) => ['fact', 'trend'].includes(claim.level)).map((claim) => claim.explanation);
    const dates = evidenceObservationIds
      .map((observationId) => observations.find((observation) => observation.id === observationId)?.clinicalDate)
      .filter((value): value is string => Boolean(value))
      .sort();
    return {
      schemaVersion: 2,
      id: `system-analysis-${snapshot.id}-${systemId}`,
      personId,
      systemId,
      inputSignature: stableHash({ compatibilitySnapshotId: snapshot.id, systemId }),
      scope: { from: dates[0] ?? null, to: dates.at(-1) ?? null, clinicalAsOf: dates.at(-1) ?? null },
      factRevision: snapshot.factRevision,
      promptVersion: 'derived-v2-compatibility-projection',
      status: 'stale',
      dataQuality: snapshot.payload.dataQuality,
      headline: summaryParts.join(' ') || claims.map((claim) => claim.explanation).join(' '),
      overview: claims.map((claim) => claim.explanation).join(' '),
      assessmentStatus: 'undetermined',
      keyPoints: claims.map((claim) => ({
        id: claim.id,
        kind: claim.level === 'fact' ? 'fact_summary' : claim.level === 'trend' ? 'trend_description' : claim.level === 'association' ? 'contextual_interpretation' : 'question',
        text: claim.explanation,
        evidence: claim.evidenceObservationIds
          .map((observationId) => observations.find((observation) => observation.id === observationId))
          .filter((observation): observation is AcceptedObservationSummary => Boolean(observation))
          .map(memberEvidence),
        limitations: claim.boundaryNote ? [claim.boundaryNote] : [],
        trendFactIds: []
      })),
      topicSections: [{
        topicId: `${systemId}-legacy`,
        title: '已有综合说明',
        claimIds: claims.map((claim) => claim.id),
        seriesIds: [],
        findingIds: []
      }],
      conflicts: [],
      dataGaps: [{
        text: '这是升级前的成员级分析投影，尚未按该身体系统的完整证据包重新生成。',
        consequence: '可以阅读已有说明，但不应把它当成最新的系统级完整综合。'
      }],
      discussionPoints: claims.filter((claim) => claim.level === 'action').map((claim) => ({
        text: claim.explanation,
        evidence: claim.evidenceObservationIds
          .map((observationId) => observations.find((observation) => observation.id === observationId))
          .filter((observation): observation is AcceptedObservationSummary => Boolean(observation))
          .map(memberEvidence),
        source: 'ai_suggested' as const
      })),
      recommendations: claims.filter((claim) => claim.level === 'action').map((claim) => ({
        id: `recommendation-${claim.id}`,
        title: claim.title,
        why: claim.explanation,
        firstStep: claim.explanation,
        schedule: null,
        reviewPlan: null,
        importantCaution: claim.boundaryNote,
        evidence: claim.evidenceObservationIds
          .map((observationId) => observations.find((observation) => observation.id === observationId))
          .filter((observation): observation is AcceptedObservationSummary => Boolean(observation))
          .map(memberEvidence),
        trendFactIds: []
      })),
      clinicallyImportantUnknowns: ['这份说明来自旧版成员级分析，尚未按当前身体系统重新生成。'],
      coverage: { inputCount: evidenceObservationIds.length, linkedEventCount: 0, excludedCount: 0, incompleteReasons: ['待生成 v2 系统级分析。'] },
      review: { status: 'passed', reviewerRunId: null, rulesVersion: 'derived-safety-v1-compatibility' },
      generatedAt: snapshot.createdAt
    };
  }

  listBodySystems(personId: string): BodySystemSummaryV2[] {
    const observations = this.memberObservations(personId);
    const series = buildMemberMetricSeries(observations);
    const assessment = this.getMemberAssessment(personId);
    return bodySystemRegistry.map((registry): BodySystemSummaryV2 => {
      const related = observations.filter((observation) => memberSystemLinks(observation).some((link) => link.systemId === registry.id));
      const direct = observations.filter((observation) => memberSystemLinks(observation).some((link) => link.systemId === registry.id && link.relation === 'direct'));
      const attention = direct.filter((observation) => ['high', 'low', 'positive'].includes(observation.abnormalFlag));
      const relatedObservationIds = new Set(related.map((observation) => observation.id));
      const relatedSeries = series.filter((item) => item.points.some((point) => relatedObservationIds.has(point.observationId)));
      const analysis = this.currentSystemAnalysis(personId, registry.id, observations);
      const v3System = assessment?.systems.find((item) => item.systemId === registry.id);
      const rebuilt = v3System && assessment?.presentation?.rebuiltNodeIds.includes(v3System.id);
      const survivingSystemSupport = v3System && assessment
        && hasSurvivingSystemSupport(assessment, v3System, assessment.evidenceCatalog);
      const reviewedConcern = v3System && assessment?.validationMode === 'local_and_focused_review'
        && assessment.reviewedTargetIds.includes(v3System.id)
        && (v3System.status === 'attention' || v3System.status === 'monitor')
        && survivingSystemSupport;
      const interpretationState = rebuilt
        ? survivingSystemSupport || v3System.claimIds.some((id) => assessment?.claims.some((claim) => claim.id === id)) ? 'partial' : 'unavailable'
        : v3System ? 'complete' : undefined;
      const currentAnalysis = analysis?.status === 'current' && analysis.review.status === 'passed'
        ? analysis
        : null;
      const legacyRelatedCount = related.filter((observation) => observation.originalNameStatus === 'legacy_missing').length;
      const topicCounts = new Map<string, number>();
      for (const observation of related) {
        const mapping = memberMapping(observation);
        const definition = conceptDictionary.find((item) => item.id === mapping.conceptId);
        if (definition?.topicId) topicCounts.set(definition.topicId, (topicCounts.get(definition.topicId) ?? 0) + 1);
      }
      return bodySystemSummaryV2Schema.parse({
        id: registry.id,
        name: registry.name,
        shortName: registry.shortName,
        // 重建范围单独用 partial 表达；同次真实复核且仍有来源的关注状态不再被处理状态盖住。
        // 未复核、空支持或正常类仍保持中性，不能从事实异常标记反推健康状态。
        status: rebuilt && !reviewedConcern ? 'building' : v3System?.status ?? (direct.length === 0
          ? legacyRelatedCount > 0 ? 'building' : 'insufficient'
          : currentAnalysis?.assessmentStatus === 'attention' || attention.length > 0 ? 'attention'
            : currentAnalysis?.assessmentStatus === 'monitor' ? 'monitor'
              : currentAnalysis?.assessmentStatus === 'no_signal_in_scope' ? 'no_signal_in_scope' : 'building'),
        summary: v3System?.headline ?? currentAnalysis?.headline
          ?? (direct.length === 0
            ? related.length > 0 ? '有相关背景资料，但还没有本系统的直接检查。' : '尚无相关检查。'
            : '已有相关检查，综合解读正在准备。'),
        factCount: related.length,
        metricCount: relatedSeries.length,
        attentionCount: attention.length,
        latestDate: related.map((item) => item.clinicalDate).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null,
        analysisStatus: v3System ? 'current' : analysis?.status ?? 'unavailable',
        ...(interpretationState ? { interpretationState } : {}),
        topics: registry.topics.map((topic) => ({ id: topic.id, name: topic.name, factCount: topicCounts.get(topic.id) ?? 0 }))
      });
    });
  }

  getMemberOverview(personId: string): MemberOverviewV2 {
    const observations = this.memberObservations(personId);
    const assessment = this.getMemberAssessment(personId);
    const assessmentNarrative = assessment ? familyAssessmentNarrative(assessment) : null;
    const systems = this.listBodySystems(personId);
    const events = this.listHealthEvents(personId);
    const actions = this.store.listActionItems(personId).filter((item) => !['completed', 'dismissed'].includes(item.status));
    const attentionSystems = systems.filter((system) => system.status === 'attention');
    const legacyObservationCount = observations.filter((item) => item.originalNameStatus === 'legacy_missing').length;
    const unclassifiedFactCount = observations.filter((item) => memberSystemLinks(item).length === 0).length;
    const analyses = systems
      .map((system) => ({ system, analysis: this.currentSystemAnalysis(personId, system.id, observations) }))
      .filter((item): item is { system: BodySystemSummaryV2; analysis: SystemAnalysisSnapshot } => (
        item.analysis?.status === 'current' && item.analysis.review.status === 'passed'
      ))
      .sort((left, right) => {
        const order = { attention: 0, monitor: 1, undetermined: 2, no_signal_in_scope: 3 } as const;
        return order[left.analysis.assessmentStatus] - order[right.analysis.assessmentStatus]
          || (right.analysis.scope.clinicalAsOf ?? '').localeCompare(left.analysis.scope.clinicalAsOf ?? '');
      });
    const legacyOverview = analyses.length > 0 ? {
      headline: '整体健康情况',
      summary: analyses.map(({ system, analysis }) => `${system.shortName}：${[analysis.overview,
        ...analysis.clinicallyImportantUnknowns].join('\n')}`).join('\n\n')
    } : null;
    const priorityIssues = assessment ? buildAssessmentPriorities(assessment) : analyses
      .filter(({ analysis }) => ['attention', 'monitor'].includes(analysis.assessmentStatus))
      .slice(0, 3)
      .map(({ system, analysis }) => ({
        id: `priority-${system.id}-${analysis.id}`,
        title: analysis.headline,
        explanation: analysis.overview,
        nextStep: analysis.recommendations[0]?.firstStep ?? null,
        systemId: system.id
      }));
    const importantChanges = assessment ? assessment.claims
      .filter((claim) => claim.kind === 'trend' && claim.systemIds.length > 0)
      .slice(0, 4).map((claim) => ({
        id: claim.id, title: '检查结果的变化', meaning: claim.text,
        systemId: claim.systemIds[0]!, seriesIds: claim.trendIds
      })) : analyses.flatMap(({ system, analysis }) => analysis.keyPoints
      .filter((point) => point.kind === 'trend_description')
      .map((point) => ({
        id: `change-${system.id}-${point.id}`,
        title: `${system.shortName}的变化`,
        meaning: point.text,
        systemId: system.id,
        seriesIds: point.trendFactIds
      }))).slice(0, 4);
    return memberOverviewV2Schema.parse({
      personId,
      generatedAt: this.now().toISOString(),
      dataQuality: observations.length === 0 ? 'insufficient' : assessment?.processingPlan.aggregateSummarizedOnlyObservationIds?.length
        || legacyObservationCount > 0 || unclassifiedFactCount > 0
        || observations.some((item) => !item.clinicalDate) ? 'partial' : 'complete',
      headline: assessmentNarrative?.headline ?? (observations.length === 0
        ? '还没有可解读的健康资料。'
        : legacyOverview?.headline ?? '报告内容已保存，健康解读正在准备。'),
      overview: assessment ? [assessmentNarrative!.summary,
        ...(assessment.processingPlan.aggregateSummarizedOnlyObservationIds?.length
          ? assessment.overview.limitations.filter((item) => item.includes('仅经分区摘要参与综合')) : [])].join(' ')
        : (observations.length === 0
        ? '添加体检、门诊或检查资料后，这里会先告诉你最值得知道的情况和下一步。'
        : legacyOverview?.summary
          ?? (legacyObservationCount > 0
            ? '旧资料仍然保留；系统正在按新的结果优先方式重新整理，完成前不会用数量冒充健康结论。'
            : '已有资料不会丢失；综合分析完成后，这里会给出结论、原因和可执行的下一步。')),
      latestClinicalDate: observations.map((item) => item.clinicalDate).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null,
      sourceUrgentNotices: buildSourceUrgentNotices(observations, this.now()),
      currentSymptomNotices: buildCurrentSymptomNotices(this.store.listManualNotes(personId), this.now()),
      acceptedFactCount: observations.length,
      unclassifiedFactCount,
      eventCount: events.length,
      attentionSystemIds: attentionSystems.map((system) => system.id),
      systems,
      priorityIssues,
      importantChanges,
      recentChanges: events.slice(0, 5).map((event) => ({
        id: event.id,
        title: event.title,
        detail: event.summary,
        date: event.time.value,
        systemId: event.systemIds[0] ?? null,
        evidence: []
      })),
      nextActions: assessment
        ? assessment.actions.slice(0, 5).map((action) => ({ id: action.id, title: action.title, status: '建议，尚未加入我的计划' }))
        : actions.slice(0, 5).map((action) => ({ id: action.id, title: action.title, status: action.status }))
    });
  }

  getBodySystemDetail(personId: string, systemId: BodySystemId): BodySystemDetailV2 {
    const observations = this.memberObservations(personId, true);
    const registry = bodySystemRegistry.find((item) => item.id === systemId);
    if (!registry) throw new Error('BODY_SYSTEM_NOT_FOUND');
    const summary = this.listBodySystems(personId).find((item) => item.id === systemId)!;
    const related = observations.filter((observation) => memberSystemLinks(observation).some((link) => link.systemId === systemId));
    const mappings = related.map((observation) => ({ observation, mapping: memberMapping(observation) }));
    const metrics = buildMemberMetricSeries(related)
      .filter((series) => series.points.some((point) => point.numericValue !== null));
    const latestByName = new Map<string, ObservationWithDocumentTime>();
    for (const observation of related) {
      const name = memberDisplayName(observation);
      const previous = latestByName.get(name);
      if (!previous || (observation.clinicalDate ?? observation.createdAt) >= (previous.clinicalDate ?? previous.createdAt)) latestByName.set(name, observation);
    }
    const events = this.listHealthEvents(personId).filter((event) => event.systemIds.includes(systemId));
    return bodySystemDetailV2Schema.parse({
      personId,
      registry,
      summary,
      analysis: this.currentSystemAnalysis(personId, systemId, observations),
      metrics,
      findings: [...latestByName.entries()]
        .filter(([, observation]) => observation.decimalValue === null)
        .map(([title, observation]) => ({
        id: `finding-${observation.id}`,
        title,
        value: `${observation.rawText}${observation.unit ? ` ${observation.unit}` : ''}`,
        time: observationDisplayTime(observation),
        abnormalFlag: observation.abnormalFlag,
        evidence: memberEvidenceSources(observation)
        })),
      relatedEventIds: events.map((event) => event.id),
      unmappedFactCount: mappings.filter(({ mapping }) => mapping.status === 'unmapped').length
    });
  }

  getMetricSeries(personId: string, seriesId: string): MetricSeriesDetailV2 {
    const observations = this.memberObservations(personId, true);
    const series = buildMemberMetricSeries(observations).find((item) => item.id === seriesId);
    if (!series) throw new Error('METRIC_SERIES_NOT_FOUND');
    const pointIds = new Set(series.points.map((point) => point.observationId));
    const rows = observations.filter((observation) => pointIds.has(observation.id));
    const definition = series.conceptId ? conceptDictionary.find((item) => item.id === series.conceptId) : null;
    const first = rows[0];
    return metricSeriesDetailV2Schema.parse({
      ...series,
      personId,
      systemIds: definition?.systemLinks.map((link) => link.systemId) ?? [...new Set(rows.flatMap((observation) => memberSystemLinks(observation).map((link) => link.systemId)))],
      comparisonConditions: { specimen: first?.specimen ?? null, method: first?.method ?? null, bodySite: first?.bodySite ?? null },
      aliasesSeen: [...new Set(rows.map((observation) => observation.originalNameStatus === 'legacy_missing'
        ? `${observation.modelStandardNameCandidate ?? observation.conceptKey}（旧记录候选名）`
        : observation.originalName))],
      tableRows: series.points
    });
  }

  listHealthEvents(personId: string, filters: { systemId?: BodySystemId | null; type?: HealthEventV2['type'] | null } = {}): HealthEventV2[] {
    const observations = this.memberObservations(personId);
    const metadataByDocument = new Map(this.store.listReportMetadata(personId).map((item) => [item.documentId, item]));
    const grouped = new Map<string, AcceptedObservationSummary[]>();
    for (const observation of observations) {
      const eventKey = metadataByDocument.get(observation.documentId)?.eventId ?? `document-${observation.documentId}`;
      grouped.set(eventKey, [...(grouped.get(eventKey) ?? []), observation]);
    }
    return [...grouped.values()].map((items): HealthEventV2 => {
      const first = items[0]!;
      const documentIds = [...new Set(items.map((item) => item.documentId))];
      const reports = documentIds.map((documentId) => metadataByDocument.get(documentId)).filter((item): item is NonNullable<typeof item> => Boolean(item));
      const report = reports.find((item) => item.metadataStatus === 'corrected') ?? reports[0];
      const extracted = report?.extracted;
      // 历史对比栏不属于当前事件的检查日期；同一文件中的多次独立检查则保留各自日期。
      const currentItems = items.filter((item) => !historicalTimeForObservation(item, metadataByDocument.get(item.documentId)));
      const dates = [...new Set(currentItems.map((item) => item.clinicalDate).filter((value): value is string => Boolean(value)))].sort();
      const { eventDate, endDate, eventPrecision, basis, explicitClinicalTime, explicitReportTime, hasExplicitRange } = projectEventDate(
        readEventDateSources(this.store, personId, reports), dates);
      const systemIds = [...new Set(items.flatMap((item) => memberSystemLinks(item).map((link) => link.systemId)))];
      const verifiedEventText = reports.map((item) => (
        item.metadataStatus === 'corrected'
          ? [item.reportKind, item.title]
          : [item.extracted?.reportKind?.value, item.extracted?.title?.value]
      ).filter(Boolean).join(' ')).join(' ');
      const eventType = classifyHealthEventType({
        verifiedReportText: verifiedEventText,
        fallbackObservationTexts: reports.length === 0 ? items.flatMap((item) => [
          item.method ?? '', item.originalNameStatus === 'recorded' ? item.originalName : ''
        ]) : []
      });
      const looksLikeCheckup = eventType === 'checkup';
      const fallbackTitle = eventType === 'checkup'
        ? `${eventDate?.slice(0, 4) ?? '日期待确认'} 年度体检`
        : eventType === 'imaging'
          ? '影像检查'
          : eventType === 'laboratory' ? '检验记录' : '检查记录';
      const reportIssued = extracted?.times.find((time) => time.role === 'report_issued' && ['day', 'month', 'year'].includes(time.precision)) ?? null;
      const historicalObservationCount = items.filter((item) => historicalTimeForObservation(item, metadataByDocument.get(item.documentId))).length;
      const attentionNames = [...new Set(items
        .filter((item) => ['high', 'low', 'positive'].includes(item.abnormalFlag))
        .map(memberDisplayName))];
      const systemNames = systemIds
        .map((systemId) => bodySystemRegistry.find((system) => system.id === systemId)?.shortName)
        .filter((name): name is string => Boolean(name));
      const resultSummary = attentionNames.length > 0
        ? `${attentionNames.slice(0, 3).join('、')}${attentionNames.length > 3 ? '等项目' : ''}在原报告中标记为需要留意。`
        : systemNames.length > 0
          ? `${hasExplicitRange ? '这份资料' : '这次检查'}涉及${systemNames.slice(0, 3).join('、')}，可以打开查看完整结果。`
          : '可以打开查看这次检查的完整结果。';
      return healthEventV2Schema.parse({
        id: report?.eventId ?? `event-document-${first.documentId}`,
        personId,
        type: eventType,
        title: report?.metadataStatus === 'corrected' ? report.title : extracted?.title?.value ?? report?.title ?? fallbackTitle,
        time: {
          value: eventDate,
          endValue: endDate,
          precision: eventPrecision,
          basis,
          role: eventDate === null ? 'unknown' : explicitReportTime ? 'report' : explicitClinicalTime?.role === 'sampled' ? 'specimen' : explicitClinicalTime ? 'exam' : looksLikeCheckup ? 'exam' : 'unknown',
          source: explicitClinicalTime || explicitReportTime ? 'explicit' : eventDate ? 'inherited' : 'unknown',
          displayLabel: eventDate
            ? `${endDate ? `${eventDate} 至 ${endDate}` : clinicalTimeLabel(eventDate, eventPrecision as 'year' | 'month' | 'day')}${basis === 'report' ? ' · 按报告日期' : ''}`
            : '报告日期待确认'
        },
        organization: report?.metadataStatus === 'corrected' ? report.organization : extracted?.organization?.value ?? report?.organization ?? null,
        department: report?.metadataStatus === 'corrected' ? report.department : extracted?.department?.value ?? null,
        reportNumber: extracted?.reportNumber?.value ?? null,
        examItems: extracted?.examItems.map((item) => item.value) ?? [],
        reportIssuedTime: reportIssued ? {
          value: reportIssued.value,
          endValue: null,
          precision: reportIssued.precision,
          role: 'report',
          source: 'explicit',
          displayLabel: `报告签发于 ${clinicalTimeLabel(reportIssued.value, reportIssued.precision as 'year' | 'month' | 'day')}`
        } : null,
        summary: `${[
          report?.metadataStatus === 'corrected' ? report.organization : extracted?.organization?.value ?? report?.organization ?? null,
          report?.metadataStatus === 'corrected' ? report.department : extracted?.department?.value ?? null,
          reportIssued ? `报告签发于 ${reportIssued.value}` : null
        ].filter(Boolean).join(' · ')}${extracted?.organization || report?.organization || extracted?.department || reportIssued ? '；' : ''}${resultSummary}${historicalObservationCount > 0 ? ' 报告中另有历史对比结果，已与本次检查分开。' : ''}${dates.length > 1 && !eventDate ? ' 报告包含跨期资料，本次检查日期仍待确认。' : ''}`,
        systemIds,
        documentIds,
        factCount: items.length,
        metadataStatus: report?.metadataStatus ?? (eventDate ? 'inferred' : 'unknown')
      });
    }).filter((event) => (!filters.systemId || event.systemIds.includes(filters.systemId)) && (!filters.type || event.type === filters.type))
      .sort((left, right) => (right.time.endValue ?? right.time.value ?? '').localeCompare(left.time.endValue ?? left.time.value ?? ''));
  }

  getHealthEventDetail(personId: string, eventId: string): HealthEventDetailV2 {
    const event = this.listHealthEvents(personId).find((item) => item.id === eventId);
    if (!event) throw new Error('HEALTH_EVENT_NOT_FOUND');
    const observations = this.memberObservations(personId, true).filter((item) => event.documentIds.includes(item.documentId));
    const series = buildMemberMetricSeries(observations);
    const reportMetadata = this.store.listReportMetadata(personId).filter((item) => event.documentIds.includes(item.documentId));
    const metadataByDocument = new Map(reportMetadata.map((item) => [item.documentId, item]));
    const historicalGroups = new Map<string, {
      value: string;
      precision: 'year' | 'month' | 'day';
      sourceReportTitle: string;
      observations: AcceptedObservationSummary[];
    }>();
    const currentObservations: AcceptedObservationSummary[] = [];
    for (const observation of observations) {
      const report = metadataByDocument.get(observation.documentId);
      const historicalTime = historicalTimeForObservation(observation, report);
      if (!historicalTime) {
        currentObservations.push(observation);
        continue;
      }
      const key = `${report?.reportId ?? observation.documentId}\u0000${historicalTime.value}\u0000${historicalTime.precision}`;
      const group = historicalGroups.get(key) ?? {
        value: historicalTime.value,
        precision: historicalTime.precision as 'year' | 'month' | 'day',
        sourceReportTitle: report?.title ?? observation.sourceLabel,
        observations: []
      };
      group.observations.push(observation);
      historicalGroups.set(key, group);
    }
    const relationChange = this.store.getLatestActiveEventRelationChange(personId, eventId);
    return healthEventDetailV2Schema.parse({
      ...event,
      evidence: observations.map(memberEvidence),
      metricSeriesIds: series.map((item) => item.id),
      findings: currentObservations.map((observation) => ({
        id: observation.id,
        label: memberMapping(observation).canonicalName ?? observation.conceptKey,
        value: formatResult(observation.rawText, observation.unit),
        time: observationDisplayTime(observation),
        abnormalFlag: observation.abnormalFlag
      })),
      historicalReferences: [...historicalGroups.values()]
        .sort((left, right) => right.value.localeCompare(left.value))
        .map((group) => ({
          time: {
            value: group.value,
            endValue: null,
            precision: group.precision,
            role: 'measurement' as const,
            source: 'explicit' as const,
            displayLabel: clinicalTimeLabel(group.value, group.precision)
          },
          sourceReportTitle: group.sourceReportTitle,
          findings: group.observations.map((observation) => ({
            id: observation.id,
            label: memberMapping(observation).canonicalName ?? observation.conceptKey,
            value: formatResult(observation.rawText, observation.unit),
            evidence: memberEvidence(observation)
          }))
        })),
      reports: reportMetadata.map((item) => ({
        reportId: item.reportId,
        documentId: item.documentId,
        title: item.title
      })),
      metadataRevision: Math.max(1, ...reportMetadata.map((item) => item.metadataRevision)),
      reportId: reportMetadata[0]?.reportId ?? null,
      metadataCanUndo: reportMetadata.some((item) => item.canUndo),
      relationChangeId: relationChange?.id ?? null,
      relationChangeAction: relationChange?.action ?? null,
      relationCanUndo: relationChange !== null
    });
  }

  updateReportMetadata(input: UpdateReportMetadataInput): ReportMetadataCorrectionReceipt {
    return this.store.updateReportMetadata(input);
  }

  undoReportMetadata(input: UndoReportMetadataInput): ReportMetadataCorrectionReceipt {
    return this.store.undoReportMetadata(input);
  }

  mergeHealthEvents(input: MergeHealthEventsInput): HealthEventRelationReceipt {
    return this.store.mergeHealthEvents(input);
  }

  splitHealthEvent(input: SplitHealthEventInput): HealthEventRelationReceipt {
    return this.store.splitHealthEvent(input);
  }

  undoHealthEventRelation(input: UndoHealthEventRelationInput): HealthEventRelationReceipt {
    return this.store.undoHealthEventRelation(input);
  }

  getMemberEvidenceBundle(personId: string, evidenceIds: string[]): MemberEvidenceBundle {
    const observations = this.memberObservations(personId);
    const byId = new Map<string, MemberEvidenceRef>();
    for (const observation of observations) {
      const evidence = memberEvidence(observation);
      byId.set(evidence.id, evidence);
      byId.set(observation.id, evidence);
      byId.set(observation.sourceSpanId, evidence);
      const legacyEvidenceId = `evidence-${observation.sourceSpanId}`;
      if (!byId.has(legacyEvidenceId)) {
        byId.set(legacyEvidenceId, {
          ...evidence,
          id: legacyEvidenceId,
          kind: 'source_span',
          observationId: null,
          label: `${observation.sourceLabel}（旧版页面级依据）`
        });
      }
      for (const source of memberEvidenceSources(observation)) {
        byId.set(source.id, source);
        if (source.sourceSpanId) byId.set(source.sourceSpanId, source);
      }
    }
    // 条件补齐的来源可能不在旧观测的主引用里；只读取仍属本人的有效事实及同文件原页。
    const requested = new Set(evidenceIds);
    const liveFacts = new Map(observations.map((observation) => [observation.id, observation]));
    for (const snapshot of this.store.listMemberAssessmentSnapshots(personId)) {
      for (const evidence of snapshot.evidenceCatalog) {
        if (!requested.has(evidence.id) || byId.has(evidence.id) || !evidence.id.startsWith('context-')
          || !evidence.observationId || !evidence.sourceSpanId) continue;
        const fact = liveFacts.get(evidence.observationId);
        if (!fact || fact.documentId !== evidence.documentId) continue;
        try {
          const source = this.store.getEvidenceAccess({ sourceSpanId: evidence.sourceSpanId });
          if (source.documentId !== fact.documentId
            || (source.quote !== null && (!evidence.quote || !source.quote.includes(evidence.quote)))) continue;
          byId.set(evidence.id, { ...evidence, locator: source.locator });
        } catch { /* 原件已删除时明确返回 missingIds，不回退到其他文件。 */ }
      }
    }
    const items = evidenceIds.map((id) => byId.get(id)).filter((item): item is MemberEvidenceRef => Boolean(item));
    return memberEvidenceBundleSchema.parse({ personId, items, missingIds: evidenceIds.filter((id) => !byId.has(id)) });
  }

  buildSystemEvidenceBundle(personId: string, systemId: BodySystemId, modelId?: string): SystemEvidenceBundle {
    return buildSystemEvidenceBundleFromStore(this.store, personId, systemId, modelId ? { modelId } : {});
  }

  getLifestylePlan(personId: string): LifestylePlanV2 {
    const observations = this.memberObservations(personId);
    const byId = new Map(observations.map((observation) => [observation.id, observation]));
    const derived = this.store.listLatestDerivedSnapshots().find((snapshot) => snapshot.personId === personId);
    const storedProposals = this.store.listLifestyleProposals(personId);
    const storedAdoptions = this.store.listActionAdoptions(personId);
    const assessmentAdoptions = this.store.listAdoptedMemberAssessmentActions(personId);
    const currentActions = this.getMemberAssessment(personId)?.actions ?? [];
    const legacyAssessmentKeys = new Map(storedProposals.flatMap((proposal) => {
      if (proposal.status !== 'adopted') return [];
      const matched = currentActions.find((action) => sameAdoptedActionScope(proposal, action));
      return matched ? [[proposal.id, matched.dedupeKey] as const] : [];
    }));
    const assessmentAdoptionIds = new Set(assessmentAdoptions.map((item) => item.action.id));
    const useMaterializedPlan = storedProposals.length > 0 || storedAdoptions.length > 0;
    const legacyActions = useMaterializedPlan ? [] : this.store.listActionItems(personId)
      .filter((action) => !assessmentAdoptionIds.has(action.id));
    const proposalSchema = lifestylePlanV2Schema.shape.proposals.element;
    let legacyProjectionUsed = false;
    const legacyProposals = useMaterializedPlan ? [] : (derived?.payload.lifestyleGuidance ?? []).flatMap((guidance) => {
      const evidenceObservations = guidance.evidenceObservationIds?.map((id) => byId.get(id))
        .filter((item): item is AcceptedObservationSummary => Boolean(item)) ?? [];
      const parsed = proposalSchema.safeParse({
        id: guidance.id,
        category: guidance.category,
        title: guidance.title,
        goal: guidance.goal,
        rationale: guidance.rationale,
        detail: guidance.detail,
        steps: guidance.steps,
        startingOptions: guidance.startingOptions,
        scheduleSuggestion: guidance.scheduleSuggestion,
        trackingSuggestion: guidance.trackingSuggestion,
        constraints: guidance.constraints,
        uncertainties: guidance.uncertainties,
        consultProfessional: guidance.consultProfessional,
        status: 'proposed' as const,
        evidence: evidenceObservations.map(memberEvidence),
        generalKnowledgeEvidence: guidance.generalKnowledgeEvidence,
        sourceKind: guidance.sourceKind,
        relatedSystemIds: guidance.relatedSystemIds
      });
      if (parsed.success) return [parsed.data];

      // v1/v2 快照可能只有标题和一段说明。保留它们供人阅读，
      // 但明确标为 stale，且不允许直接采纳成行动。
      const title = typeof guidance.title === 'string' ? guidance.title.trim() : '';
      const detail = typeof guidance.detail === 'string' ? guidance.detail.trim() : '';
      if (!title || !detail) return [];
      const legacyCategory = String(guidance.category ?? '').toLocaleLowerCase('zh-CN');
      const category = /exercise|activity|运动|活动/.test(legacyCategory) ? 'exercise'
        : /diet|nutrition|饮食|营养/.test(legacyCategory) ? 'diet'
          : /sleep|睡眠|作息/.test(legacyCategory) ? 'sleep'
            : /monitor|记录|监测/.test(legacyCategory) ? 'monitoring'
              : /review|check|复查|就医/.test(legacyCategory) ? 'review'
                : 'other';
      const fallback = proposalSchema.safeParse({
        id: guidance.id,
        category,
        title,
        goal: title,
        rationale: detail,
        detail,
        steps: [detail],
        startingOptions: ['先回看原有建议，结合当前身体情况再决定。'],
        scheduleSuggestion: null,
        trackingSuggestion: '按自己已经确定的安排记录进展；需要调整时先与医生确认。',
        constraints: ['这条建议缺少适用条件，不宜直接据此改变现在的安排。'],
        uncertainties: [],
        consultProfessional: Boolean(guidance.consultProfessional),
        status: 'proposed' as const,
        evidence: evidenceObservations.map(memberEvidence),
        generalKnowledgeEvidence: [],
        sourceKind: 'ai_proposed' as const,
        relatedSystemIds: [...new Set(evidenceObservations.flatMap((observation) => memberSystemLinks(observation).map((link) => link.systemId)))]
      });
      if (!fallback.success) return [];
      legacyProjectionUsed = true;
      return [fallback.data];
    });
    return lifestylePlanV2Schema.parse({
      personId,
      // V3 的行动方案由成员综合快照提供；旧派生快照及物化建议只供回看。
      status: legacyProjectionUsed || Boolean(derived) || useMaterializedPlan ? 'stale' : 'unavailable',
      dataQuality: derived?.payload.dataQuality ?? (observations.length > 0 ? 'partial' : 'insufficient'),
      updatedAt: storedProposals[0]?.updatedAt ?? storedAdoptions[0]?.updatedAt
        ?? assessmentAdoptions[0]?.action.updatedAt ?? derived?.createdAt ?? null,
      priorities: derived?.payload.claims.filter((claim) => claim.level === 'action').slice(0, 3).map((claim) => ({
        id: `priority-${claim.id}`,
        title: claim.title,
        why: claim.explanation,
        evidence: claim.evidenceObservationIds.map((id) => byId.get(id)).filter((item): item is AcceptedObservationSummary => Boolean(item)).map(memberEvidence)
      })) ?? [],
      proposals: useMaterializedPlan
        ? storedProposals.map((proposal) => ({
          id: proposal.id,
          category: proposal.category,
          title: proposal.title,
          goal: proposal.goal,
          rationale: proposal.rationale,
          detail: proposal.detail,
          steps: proposal.steps,
          startingOptions: proposal.startingOptions,
          scheduleSuggestion: proposal.scheduleSuggestion,
          trackingSuggestion: proposal.trackingSuggestion,
          constraints: proposal.constraints,
          uncertainties: proposal.uncertainties,
          consultProfessional: proposal.consultProfessional,
          status: proposal.status === 'superseded' ? 'dismissed' : proposal.status,
          evidence: proposal.evidenceObservationIds.map((id) => byId.get(id)).filter((item): item is AcceptedObservationSummary => Boolean(item)).map(memberEvidence),
          generalKnowledgeEvidence: proposal.generalKnowledgeEvidence,
          sourceKind: proposal.sourceKind,
          relatedSystemIds: proposal.relatedSystemIds
        }))
        : legacyProposals,
      adoptedActions: [...(useMaterializedPlan
        ? storedAdoptions.map((action) => ({
          id: action.id,
          proposalId: action.proposalId,
          assessmentDedupeKey: action.proposalId === null ? null
            : legacyAssessmentKeys.get(action.proposalId) ?? null,
          title: savedAiActionTitle(action.title),
          userGoal: action.userGoal,
          selectedStartingOption: action.selectedStartingOption,
          plannedTime: action.plannedTime,
          owner: action.owner,
          progressNote: action.progressNote,
          status: action.status,
          dueDate: action.dueDate,
          updatedAt: action.updatedAt
        }))
        : legacyActions.map((storedAction) => {
          const action = presentSavedAction(storedAction);
          return {
            id: action.id,
            proposalId: null,
            title: action.title,
            userGoal: action.title,
            selectedStartingOption: action.detail,
            plannedTime: action.userScheduleText ?? null,
            reportTiming: action.origin === 'user_created' ? null : action.dueText,
            owner: '本人',
            progressNote: null,
            status: action.status,
            dueDate: action.dueDate,
            updatedAt: action.updatedAt
          };
        })), ...assessmentAdoptions.map(({ action: storedAction, dedupeKey }) => {
        const action = presentSavedAction(storedAction);
        return {
          id: action.id, proposalId: null, assessmentDedupeKey: dedupeKey,
          title: action.title, userGoal: action.title, selectedStartingOption: action.detail,
          plannedTime: action.userScheduleText ?? null, reportTiming: action.dueText, owner: '本人', progressNote: null,
          status: action.status, dueDate: action.dueDate, updatedAt: action.updatedAt
        };
      })]
    });
  }

  adoptLifestyleProposal(input: AdoptLifestyleProposalInput): AdoptedActionReceipt {
    this.requireActivePerson(input.personId);
    // 不依赖界面禁用按钮：旧版建议不能通过直接 IPC 调用新增行动。
    throw new Error('LIFESTYLE_PROPOSAL_STALE_REVIEW_REQUIRED');
  }

  adoptMemberAssessmentAction(input: AdoptMemberAssessmentActionInput): ActionItem {
    this.requireActivePerson(input.personId);
    const current = this.getMemberAssessment(input.personId);
    if (!current || current.status !== 'current' || current.id !== input.snapshotId) throw new Error('MEMBER_ASSESSMENT_ACTION_STALE');
    return this.store.adoptMemberAssessmentAction(input);
  }

  setLifestyleProposalDecision(input: SetLifestyleProposalDecisionInput): LifestyleProposalDecisionReceipt {
    this.requireActivePerson(input.personId);
    // 旧建议只读兼容；不能绕过页面状态直接恢复为可采纳候选。
    throw new Error('LIFESTYLE_PROPOSAL_STALE_REVIEW_REQUIRED');
  }

  close(): void {
    this.closed = true;
    this.store.close();
  }

  ensurePrimaryMember(input: { displayName: string; relation: string }): string {
    const existing = this.store.listPersons().find((person) => person.archivedAt === null);
    if (existing) return existing.id;
    return this.store.createPerson(input).id;
  }

  createMember(input: CreatePersonInput): string {
    return this.store.createPerson(input).id;
  }

  updateMemberDisplay(input: UpdatePersonDisplayInput) {
    return this.store.updatePersonDisplay(input);
  }

  listArchivedMembers() {
    return this.store.listPersons().filter((person) => person.archivedAt !== null);
  }

  archiveMember(input: ArchivePersonInput) {
    return this.store.archivePerson(input);
  }

  restoreMember(input: RestorePersonInput) {
    return this.store.restorePerson(input);
  }

  setDocumentIncluded(input: SetDocumentInclusionInput) {
    return this.store.setDocumentIncluded(input);
  }

  /** 重新纳入前只补齐缺失的完整原件输入。已准备或已提交的历史结果绝不重新规范化。 */
  async prepareDocumentForReinclusion(input: SetDocumentInclusionInput): Promise<{ prepared: boolean }> {
    if (!input.included || this.store.countSourceSpans(input.documentId) > 0) return { prepared: false };
    const source = this.store.getDocumentOriginalSource(input.documentId);
    if (!source.personId || source.personArchived) throw new Error('DOCUMENT_PERSON_REQUIRED');
    const bytes = await readFile(source.sourcePath);
    if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new Error('SOURCE_HASH_MISMATCH');
    const manifest = await normalizeStoredSource({ store: this.store, documentId: source.documentId,
      sourceObjectId: source.sourceObjectId, sha256: source.sha256, displayName: source.displayName,
      bytes, createdAt: this.now().toISOString(), legacyDocConverter: this.legacyDocConverter });
    if (manifest.spans.length === 0 || new Set(manifest.coveredUnitIndexes).size !== manifest.totalUnits
      || manifest.coveredUnitIndexes.some((index) => index < 0 || index >= manifest.totalUnits)) {
      throw new Error('PROCESSING_REBUILD_ORIGINAL_PREPARATION_INCOMPLETE');
    }
    return { prepared: this.store.saveMissingSourceManifestForReinclusion(manifest, source) };
  }

  listDeletedDocuments() {
    return this.store.listDeletedDocuments();
  }

  async deleteDocument(input: DeleteDocumentInput) {
    const sourceHash = this.store.getDocumentSourceHash(input.documentId);
    const retainedByRecoveryPoint = await recoveryPointsReferenceSourceHash(this.store.rootDirectory, sourceHash);
    return this.store.deleteDocument({ documentId: input.documentId, retainedByRecoveryPoint });
  }

  releaseDeletedDocument(sourceHash: string): void {
    this.store.releaseDeletedDocument(sourceHash);
  }

  createAction(input: CreateActionItemInput) {
    return this.store.createUserAction(input);
  }

  updateActionSchedule(input: UpdateActionScheduleInput): ActionItem {
    this.requireActivePerson(input.personId);
    const updated = this.store.updateActionSchedule(input);
    const userDetail = this.store.listActionAdoptions(input.personId).some((item) => item.id === updated.id && item.proposalId !== null);
    return presentSavedAction(updated, userDetail);
  }

  createManualNote(input: CreateManualNoteInput) {
    return this.store.createManualNote(input);
  }

  acceptCorrectedFacts(input: { issueId: string; documentId: string; candidates: ObservationCandidate[] }) {
    const issue = this.store.listOpenExtractionReviewIssues().find((candidateIssue) => (
      candidateIssue.id === input.issueId && candidateIssue.documentId === input.documentId
    ));
    if (!issue || issue.kind !== 'field_conflict') throw new Error('REVIEW_ISSUE_NOT_OPEN');
    if (!issue.documentRun?.coverageComplete) throw new Error('DOCUMENT_REVIEW_RUN_INCOMPLETE');
    const submittedByKey = new Map(input.candidates.map((candidate) => [candidate.localKey, candidate]));
    if (submittedByKey.size !== input.candidates.length) throw new Error('CORRECTION_DUPLICATE_KEY');
    const storedByKey = new Map(issue.candidateOptions.map((candidate) => [candidate.localKey, candidate]));
    if ([...submittedByKey.keys()].some((localKey) => !storedByKey.has(localKey))) {
      throw new Error('CORRECTION_SCOPE_INVALID');
    }
    for (const original of issue.candidateOptions) {
      const submitted = submittedByKey.get(original.localKey);
      const difference = issue.candidateDiffs.find((candidateDifference) => candidateDifference.localKey === original.localKey);
      if (!submitted) {
        // 证据绑定仍不清楚的单项不能靠人工猜测补齐。允许用户明确
        // 将该项排除，同时接纳同份报告中其余已核实的事实。
        if (!difference?.fields.includes('presence') && !difference?.fields.includes('issues')) {
          throw new Error('CORRECTION_INCOMPLETE');
        }
        continue;
      }
      const normalizedSubmitted = { ...submitted } as Record<string, unknown>;
      const originalRecord = original as unknown as Record<string, unknown>;
      for (const field of difference?.fields ?? []) {
        if (field !== 'presence') normalizedSubmitted[field] = originalRecord[field];
      }
      if (stableHash(normalizedSubmitted) !== stableHash(original)) throw new Error('CORRECTION_SCOPE_INVALID');
    }
    const bundle = this.store.getDocumentExtractionBundle(input.documentId);
    const observations = input.candidates.map((candidate) => {
      const outcome = evaluateObservationCandidate(candidate, bundle.manifest, {
        personConsistent: bundle.personAssignmentBasis !== 'legacy',
        overwritesUserLockedValue: false
      });
      if (outcome.decision === 'reject' || outcome.decision === 'needs_review') {
        throw new Error(`CORRECTION_INVALID:${candidate.localKey}:${outcome.reasons.join(',')}`);
      }
      const acceptanceId = this.store.saveAcceptanceDecision({
        method: 'user_resolution', actor: 'user', rulesVersion: ACCEPTANCE_RULES_VERSION,
        inputSignature: stableHash({ documentId: input.documentId, candidate }),
        outputHash: stableHash({ candidate, outcome }), reviewRef: input.issueId, decision: outcome.decision
      });
      const firstEvidence = candidate.evidence[0]!;
      return {
        conceptKey: candidate.originalName,
        originalName: candidate.originalName,
        modelStandardNameCandidate: candidate.standardNameCandidate,
        rawText: candidate.value.rawText ?? '',
        valueKind: candidate.value.kind,
        decimalValue: candidate.value.kind === 'numeric' ? candidate.value.decimal : null,
        qualifier: candidate.value.kind === 'numeric' ? candidate.value.comparator : candidate.value.kind === 'qualitative' ? candidate.value.category : null,
        unit: candidate.unitRaw,
        referenceRange: candidate.referenceRangeRaw,
        clinicalDate: candidate.clinicalDate,
        abnormalFlag: normalizeAbnormalFlag(candidate.reportedAbnormalFlag),
        documentId: input.documentId,
        sourceSpanId: firstEvidence.sourceSpanId,
        acceptanceId,
        specimen: candidate.specimen,
        method: candidate.method,
        bodySite: candidate.bodySite,
        evidence: candidate.evidence
      };
    });
    return this.store.publishFacts({
      personId: bundle.personId,
      documentId: input.documentId,
      documentCommitKey: stableHash({
        documentId: input.documentId, sourceSha256: bundle.manifest.sha256,
        normalizerVersion: bundle.manifest.normalizerVersion,
        extractionSchemaVersion: 1, rulesVersion: ACCEPTANCE_RULES_VERSION
      }),
      expectedRevision: this.store.getFactRevision(bundle.personId),
      changeSetHash: stableHash({ documentId: input.documentId, candidates: input.candidates, rulesVersion: ACCEPTANCE_RULES_VERSION, actor: 'user' }),
      summary: `用户核对原始依据后修正并接纳 ${observations.length} 条事实`,
      observations,
      resolvedReviewIssueId: input.issueId
    });
  }

  updateActionStatus(input: { actionId: string; status: ActionStatus; expectedRevision: number }) {
    return this.store.updateActionStatus(input);
  }

  createInboxBinding(input: {
    canonicalPath: string;
    personId: string | null;
    recursive: boolean;
    allowScheduledAiProcessing: boolean;
    consentVersion: number;
    accountState: AccountState;
  }): InboxBindingSummary {
    const accountFingerprint = input.accountState.status === 'connected' && input.accountState.displayLabel
      ? stableHash({ provider: 'codex-chatgpt', displayLabel: input.accountState.displayLabel })
      : null;
    return this.store.createInboxBinding({
      canonicalPath: input.canonicalPath,
      personId: input.personId,
      recursive: input.recursive,
      allowScheduledAiProcessing: input.allowScheduledAiProcessing,
      accountFingerprint,
      consentVersion: input.consentVersion
    });
  }

  listInboxBindings(): InboxBindingSummary[] {
    return this.store.listInboxBindings();
  }

  disableInboxBinding(bindingId: string): void {
    this.store.disableInboxBinding(bindingId);
  }

  private timeZone(): string {
    return this.timeZoneProvider();
  }

  getSchedule() {
    const timeZone = this.timeZone();
    const current = this.store.getOrCreateSchedule(timeZone, nextScheduledRunUtc('20:00', timeZone, this.now()));
    if (current.timeZone === timeZone) return current;
    return this.store.updateSchedule({
      enabled: current.enabled,
      localTime: current.localTime,
      timeZone,
      nextRunUtc: nextScheduledRunUtc(current.localTime, timeZone, this.now()),
      expectedRevision: current.revision
    });
  }

  updateSchedule(input: UpdateScheduleInput) {
    const timeZone = this.timeZone();
    return this.store.updateSchedule({
      ...input,
      localTime: input.localTime as `${number}:${number}`,
      timeZone,
      nextRunUtc: nextScheduledRunUtc(input.localTime as `${number}:${number}`, timeZone, this.now())
    });
  }

  runScheduleCheck(accountState: AccountState): { created: boolean; queued: boolean; idempotent: boolean } {
    const now = this.now();
    const schedule = this.getSchedule();
    const accountFingerprint = accountState.status === 'connected' && accountState.displayLabel
      ? stableHash({ provider: 'codex-chatgpt', displayLabel: accountState.displayLabel })
      : null;
    const groups = this.store.listScheduledReadyGroups(null, now.toISOString());
    const slot = determineEligibleSlot({
      id: schedule.id,
      enabled: schedule.enabled,
      localTime: schedule.localTime,
      timeZone: schedule.timeZone,
      revision: schedule.revision,
      lastSlot: schedule.lastSlot
    }, now, true);
    if (!slot) return { created: false, queued: false, idempotent: false };
    const nextRunUtc = nextScheduledRunUtc(schedule.localTime, schedule.timeZone, now);
    if (groups.length === 0) {
      this.store.markScheduleChecked(slot.key, nextRunUtc);
      return { created: false, queued: false, idempotent: false };
    }
    const created = this.store.createScheduledBatch({
      slotKey: slot.key,
      cutoff: slot.observedAtUtc,
      groups: groups.map((group) => ({
        ...group,
        initialStatus: accountFingerprint === null || group.accountFingerprint !== accountFingerprint
          ? 'waiting_auth' as const
          : accountState.quota.status === 'exhausted' || accountState.quota.status === 'unknown'
            ? 'waiting_quota' as const : 'queued' as const,
        inputSignature: jobInputSignature({
          stage: 'extract',
          personId: group.personId,
          sourceRevisionIds: group.documentIds,
          factRevision: this.store.getFactRevision(group.personId),
          contextRevision: 0,
          ...promptMetaForStage('extract')
        })
      }))
    });
    this.store.markScheduleChecked(slot.key, nextRunUtc);
    return {
      created: !created.idempotent,
      queued: groups.some((group) => accountFingerprint !== null
        && group.accountFingerprint === accountFingerprint
        && !['exhausted', 'unknown'].includes(accountState.quota.status)),
      idempotent: created.idempotent
    };
  }

  processNow(options?: ProcessNowOptions): { batchId: string; idempotent: boolean } {
    if (options?.readingScope && (!options.documentIds?.length || options.assessmentPersonId
      || options.expectedAssessmentDataRevision || options.purpose || options.dateCorrectionDocumentId
      || options.expectedDateCorrectionDataRevision)) throw new Error('REPORT_SUPPLEMENT_SCOPE_UNAVAILABLE');
    if (options?.purpose === 'date_correction' || options?.dateCorrectionDocumentId !== undefined
      || options?.expectedDateCorrectionDataRevision !== undefined) return this.processDateCorrection(options);
    if (options?.assessmentPersonId !== undefined || options?.expectedAssessmentDataRevision !== undefined) {
      return this.processAssessmentOnly(options);
    }
    const selectedIds = options?.documentIds ? new Set(options.documentIds) : null;
    if (options?.readingScope && (!selectedIds || options.assessmentPersonId || options.purpose)) {
      throw new Error('REPORT_SUPPLEMENT_SCOPE_UNAVAILABLE');
    }
    const supplementScopes = options?.readingScope === 'unresolved_pages'
      ? [...selectedIds!].map(id => this.store.getReportSupplementScope(id)) : [];
    const trackedDocumentIds = options ? this.store.listProcessingDocumentIds() : new Set<string>();
    const activeDocumentIds = options ? this.store.listActiveProcessingDocumentIds() : new Set<string>();
    const reviewRepairableIds = selectedIds ? this.store.listRepairableExtractionDocumentIds() : new Set<string>();
    const committedReviewIssues = selectedIds ? this.store.listOpenExtractionReviewIssues().filter((issue) => (
      issue.severity === 'warning' && issue.stage === 'extract'
      && this.store.isDocumentCommitted(issue.documentId)
    )) : [];
    const repairableIds = reviewRepairableIds;
    if (selectedIds && [...selectedIds].some((documentId) => trackedDocumentIds.has(documentId)
      && !repairableIds.has(documentId))) {
      throw new Error('DOCUMENT_ALREADY_IN_PROCESSING');
    }
    const byPerson = new Map<string, { documentIds: string[]; stage: 'extract' | 'analyze' }>();
    for (const document of this.store.listReadyDocuments()) {
      if (selectedIds && !selectedIds.has(document.id)) continue;
      if (trackedDocumentIds.has(document.id) && !repairableIds.has(document.id)) continue;
      const group = byPerson.get(document.personId) ?? { documentIds: [], stage: 'extract' as const };
      group.documentIds.push(document.id);
      byPerson.set(document.personId, group);
    }
    if (selectedIds) {
      // 已完成且没有开放事项的旧报告也可能缺单项日期；仅纳入用户明确选中且事务可重核的资料。
      for (const document of this.store.listImportedDocuments()) {
        if (!selectedIds.has(document.id) || !repairableIds.has(document.id) || !document.personId
          || document.status !== 'completed' || !this.store.isDocumentCommitted(document.id)) continue;
        const group = byPerson.get(document.personId) ?? { documentIds: [], stage: 'extract' as const };
        if (!group.documentIds.includes(document.id)) group.documentIds.push(document.id);
        byPerson.set(document.personId, group);
      }
      // 只为明确选中的可修复问题建局部任务；旧身份事项仅在用户已明确归属时由存储事务替代。
      for (const issue of this.store.listOpenExtractionReviewIssues()) {
        if (!selectedIds.has(issue.documentId) || !repairableIds.has(issue.documentId) || !issue.personId) continue;
        const group = byPerson.get(issue.personId) ?? { documentIds: [], stage: 'extract' as const };
        if (!group.documentIds.includes(issue.documentId)) group.documentIds.push(issue.documentId);
        byPerson.set(issue.personId, group);
      }
      // 明确点选旧报告时允许重新核对其未纳入项目；不把所有历史报告自动重传。
      for (const issue of committedReviewIssues) {
        if (!selectedIds.has(issue.documentId) || issue.severity !== 'warning'
          || issue.stage !== 'extract' || !issue.personId
          || !this.store.isDocumentCommitted(issue.documentId)
          || this.store.isDocumentExcluded(issue.documentId)
          || !repairableIds.has(issue.documentId)) continue;
        const group = byPerson.get(issue.personId) ?? { documentIds: [], stage: 'extract' as const };
        if (!group.documentIds.includes(issue.documentId)) group.documentIds.push(issue.documentId);
        byPerson.set(issue.personId, group);
      }
    }
    if (!selectedIds) {
      // 旧报告直接复用已接纳事实，按成员刷新唯一的 V3 综合快照。
      for (const person of this.store.listPersons().filter((item) => item.archivedAt === null)) {
        if (byPerson.has(person.id)) continue;
        const observations = this.store.listAcceptedObservations(person.id);
        const sourceDocumentId = observations[0]?.documentId;
        if (!sourceDocumentId || activeDocumentIds.has(sourceDocumentId)) continue;
        // 已验证旧规则结果仍可只读，不因安装升级就隐式扩大发送范围。
        // 可选规则更新必须通过指定成员的独立综合确认入口发起。
        if (this.getMemberAssessment(person.id)) continue;
        byPerson.set(person.id, { documentIds: [sourceDocumentId], stage: 'analyze' });
      }
    }
    if (byPerson.size === 0) throw new Error('NO_READY_DOCUMENTS');
    if (options && (options.accountState.status !== 'connected' || !options.accountState.displayLabel)) {
      throw new Error('AUTH_REQUIRED');
    }
    const groups = [...byPerson.entries()].map(([personId, group]) => ({
      personId,
      documentIds: group.documentIds,
      stage: group.stage,
      inputSignature: stableHash({
        stage: group.stage,
        personId,
        documentIds: [...group.documentIds].sort(),
        factRevision: this.store.getFactRevision(personId),
        contextRevision: this.store.getClinicalContextRevision(personId),
        reviewScopeSignature: this.store.getOpenReviewScopeSignature(personId),
        ...(supplementScopes.length ? { supplementScopes: supplementScopes.filter(scope => scope.personId === personId) } : {}),
        ...promptMetaForStage(group.stage)
      })
    }));
    const consentId = options
      ? this.store.createManualProcessingConsent({
        documentIds: groups.flatMap((group) => group.documentIds),
        personIds: groups.map((group) => group.personId),
        historicalObservationIds: groups.flatMap((group) => this.store.listAcceptedObservations(group.personId).map((observation) => observation.id)),
        accountFingerprint: stableHash({ provider: 'codex-chatgpt', displayLabel: options.accountState.displayLabel }),
        version: options.consentVersion,
        ...(supplementScopes.length ? { supplementScopes } : {})
      })
      : null;
    try {
      const created = this.store.createWaitingAuthBatch({
        cutoff: this.now().toISOString(),
        groups,
        initialStatus: options ? 'queued' : 'waiting_auth',
        consentId,
        ...(supplementScopes.length ? { supplementScopes } : {}),
        ...(selectedIds ? { repairDocumentIds: [...selectedIds].filter((id) => repairableIds.has(id)) } : {})
      });
      return { batchId: created.batchId, idempotent: created.idempotent };
    } catch (error) {
      if (consentId) this.store.revokeConsent(consentId);
      throw error;
    }
  }

  /** 单份已提交报告的显式日期纠错；没有新日期参数，也不改个人计划。 */
  private processDateCorrection(options: ProcessNowOptions): { batchId: string; idempotent: boolean } {
    const { accountState: _accountState, ...request } = options;
    const input = processNowInputSchema.parse({ ...request, confirmedDataRecipient: 'OpenAI/Codex' });
    const documentId = input.dateCorrectionDocumentId!;
    const scope = this.store.getDateCorrectionScope(documentId);
    if (options.accountState.status !== 'connected' || !options.accountState.displayLabel) throw new Error('AUTH_REQUIRED');
    if (this.getSnapshot(options.accountState).persons.find((person) => person.id === scope.personId)?.dataRevision
      !== input.expectedDateCorrectionDataRevision) throw new Error('DATE_CORRECTION_SCOPE_CHANGED');
    if (this.store.listActiveProcessingDocumentIds().has(documentId)) throw new Error('DOCUMENT_ALREADY_IN_PROCESSING');
    const consentId = this.store.createManualProcessingConsent({ documentIds: [documentId], personIds: [scope.personId],
      dateCorrectionDocumentId: documentId, historicalObservationIds: this.store.listAcceptedObservations(scope.personId).map((item) => item.id),
      accountFingerprint: stableHash({ provider: 'codex-chatgpt', displayLabel: options.accountState.displayLabel }), version: options.consentVersion });
    try {
      const batch = this.store.createWaitingAuthBatch({ cutoff: this.now().toISOString(), initialStatus: 'queued', consentId,
        dateCorrectionDocumentId: documentId, groups: [{ personId: scope.personId, documentIds: [documentId], stage: 'extract',
          inputSignature: stableHash({ purpose: 'date_correction', scope, ...promptMetaForStage('extract') }) }] });
      return { batchId: batch.batchId, idempotent: batch.idempotent };
    } catch (error) { this.store.revokeConsent(consentId); throw error; }
  }

  /** 明确指定成员时，只用其已接纳事实综合；锚点仅定位任务，不代表原件读取授权。 */
  private processAssessmentOnly(options: ProcessNowOptions): { batchId: string; idempotent: boolean } {
    const scope = processNowInputSchema.parse({
      consentVersion: options.consentVersion, confirmedDataRecipient: 'OpenAI/Codex',
      assessmentPersonId: options.assessmentPersonId,
      expectedAssessmentDataRevision: options.expectedAssessmentDataRevision,
      ...(options.documentIds === undefined ? {} : { documentIds: options.documentIds })
    });
    const personId = scope.assessmentPersonId!;
    const person = this.store.listPersons().find((item) => item.id === personId);
    if (!person) throw new Error('PERSON_NOT_FOUND');
    if (person.archivedAt !== null) throw new Error('PERSON_ARCHIVED');
    if (options.accountState.status !== 'connected' || !options.accountState.displayLabel) throw new Error('AUTH_REQUIRED');
    // 确认界面之后的异步恢复点可能跨过事实变更；建授权前同步重验用户确认的成员版本。
    const currentPerson = this.getSnapshot(options.accountState).persons.find((item) => item.id === personId);
    if (currentPerson?.dataRevision !== scope.expectedAssessmentDataRevision) throw new Error('ASSESSMENT_SCOPE_CHANGED');
    const observations = this.store.listAcceptedObservations(personId);
    const personDocumentIds = new Set(this.store.listImportedDocuments()
      .filter((document) => document.personId === personId).map((document) => document.id));
    const anchorDocumentId = observations.find((observation) => personDocumentIds.has(observation.documentId)
      && this.store.isDocumentCommitted(observation.documentId)
      && !this.store.isDocumentExcluded(observation.documentId))?.documentId;
    if (!anchorDocumentId) throw new Error('NO_ACCEPTED_FACTS');
    const documentIds = [anchorDocumentId];
    const inputSignature = stableHash({
      purpose: 'assessment_only', stage: 'analyze', personId,
      expectedAssessmentDataRevision: scope.expectedAssessmentDataRevision,
      documentIds, historicalObservationIds: observations.map((observation) => observation.id).sort(),
      factRevision: this.store.getFactRevision(personId),
      contextRevision: this.store.getClinicalContextRevision(personId),
      reviewScopeSignature: this.store.getOpenReviewScopeSignature(personId),
      ...promptMetaForStage('analyze')
    });
    const consentId = this.store.createManualProcessingConsent({
      assessmentOnly: true, documentIds, personIds: [personId],
      historicalObservationIds: observations.map((observation) => observation.id),
      accountFingerprint: stableHash({ provider: 'codex-chatgpt', displayLabel: options.accountState.displayLabel }),
      version: options.consentVersion
    });
    try {
      const created = this.store.createWaitingAuthBatch({
        cutoff: this.now().toISOString(), initialStatus: 'queued', consentId,
        groups: [{ personId, documentIds, stage: 'analyze', inputSignature }]
      });
      return { batchId: created.batchId, idempotent: created.idempotent };
    } catch (error) {
      this.store.revokeConsent(consentId);
      throw error;
    }
  }

  /** 先完整准备新证据，再保存本次恢复点；任何准备失败都不会清理旧结果。 */
  async rebuildProcessingFromSources(options: {
    accountState: AccountState;
    consentVersion: number;
    confirmedRebuildReportResults: true;
    expectedSources: ProcessingRebuildSourceIdentity[];
    personIds?: string[];
    clearPersonalData?: true;
    confirmedClearPersonalData?: true;
    confirmedPersonAliases?: Array<{ personId: string; reportedName: string }>;
    validateBeforeCommit?: () => void;
  }): Promise<ProcessingRebuildReceipt> {
    if (options.accountState.status !== 'connected' || !options.accountState.displayLabel) {
      throw new Error('AUTH_REQUIRED');
    }
    if (!Number.isInteger(options.consentVersion) || options.consentVersion < 1
      || options.confirmedRebuildReportResults !== true
      || Boolean(options.clearPersonalData) !== Boolean(options.confirmedClearPersonalData)) {
      throw new Error('PROCESSING_REBUILD_AUTH_REQUIRED');
    }
    this.store.assertProcessingRebuildIdle();
    const expected = processingRebuildExpectedSourcesSchema.safeParse(options.expectedSources);
    if (!expected.success) throw new Error('PROCESSING_REBUILD_SOURCE_SCOPE_CHANGED');
    const sourceIdentities = (sources: readonly ProcessingRebuildSourceIdentity[]) => sources
      .map(({ documentId, personId, sourceObjectId, sha256 }) => ({ documentId, personId, sourceObjectId, sha256 }))
      .sort((left, right) => left.documentId.localeCompare(right.documentId));
    const sources = this.store.listProcessingRebuildSources(options.personIds);
    if (sources.length === 0) throw new Error('NO_READY_DOCUMENTS');
    const sourceSignature = stableHash(sourceIdentities(sources));
    // 首次读原件前绑定预览；后置漂移检查不能替代确认到请求入口之间的范围校验。
    if (stableHash(sourceIdentities(expected.data)) !== sourceSignature) {
      throw new Error('PROCESSING_REBUILD_SOURCE_SCOPE_CHANGED');
    }
    const manifests = [];
    for (const source of sources) {
      this.store.assertProcessingRebuildIdle();
      const bytes = await readFile(source.sourcePath);
      if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) {
        throw new Error('SOURCE_HASH_MISMATCH');
      }
      const manifest = await normalizeStoredSource({ store: this.store, documentId: source.documentId,
        sourceObjectId: source.sourceObjectId, sha256: source.sha256, displayName: source.displayName,
        bytes, createdAt: this.now().toISOString(), legacyDocConverter: this.legacyDocConverter });
      // 本机只准备完整原件输入，不调用 OCR；识别与日期语义交给后续原件模型。
      if (manifest.spans.length === 0 || manifest.totalUnits !== new Set(manifest.coveredUnitIndexes).size
        || manifest.coveredUnitIndexes.some((index) => index < 0 || index >= manifest.totalUnits)) {
        throw new Error('PROCESSING_REBUILD_ORIGINAL_PREPARATION_INCOMPLETE');
      }
      // 页数骨架不代表模型输入已能生成：清理旧结果前真实渲染整份原件。
      // 一份检查完立即释放，不堆积整批图片，也不调用 OCR 或发送模型请求。
      const convertedPdf = this.store.getDocumentConvertedView(source.documentId);
      const prepared = await prepareDirectOriginalReport({ documentId: source.documentId,
        sourceObjectId: source.sourceObjectId, sha256: source.sha256, displayName: source.displayName,
        bytes, createdAt: manifest.createdAt,
        ...(convertedPdf ? { convertedPdf: { ...convertedPdf, mediaType: 'application/pdf' as const,
          converterId: 'libreoffice-headless' as const } } : {}) });
      try {
        if (prepared.originalSha256 !== source.sha256 || prepared.totalUnits !== manifest.totalUnits
          || stableHash(prepared.manifest.spans) !== stableHash(manifest.spans)
          || prepared.unitMappings.length !== manifest.totalUnits
          || new Set(prepared.unitMappings.map((unit) => unit.sourceSpanId)).size !== manifest.totalUnits
          || prepared.unitMappings.some((unit) => !manifest.spans.some((span) => span.id === unit.sourceSpanId))
          || prepared.imagePaths.length !== prepared.unitMappings.filter((unit) => unit.inputKind === 'image').length) {
          throw new Error('PROCESSING_REBUILD_ORIGINAL_PREPARATION_INCOMPLETE');
        }
      } finally { await prepared.cleanup(); }
      manifests.push(manifest);
    }
    // 文件归属、排除范围或导入集合在准备期间变化，必须重新预览，不能清掉另一批结果。
    if (stableHash(sourceIdentities(this.store.listProcessingRebuildSources(options.personIds))) !== sourceSignature) {
      throw new Error('PROCESSING_REBUILD_SOURCE_SCOPE_CHANGED');
    }
    const backup = await this.store.createProcessingRebuildBackup();
    const meta = promptMetaForStage('extract');
    // 准备证据和备份是异步过程；最终授权检查与事务提交之间不再让出执行权。
    options.validateBeforeCommit?.();
    return this.store.rebuildProcessingResults({ backup, manifests,
      accountFingerprint: stableHash({ provider: 'codex-chatgpt', displayLabel: options.accountState.displayLabel }),
      consentVersion: options.consentVersion, confirmedRebuildReportResults: true,
      ...(options.personIds ? { personIds: options.personIds } : {}),
      ...(options.clearPersonalData ? { clearPersonalData: true, confirmedClearPersonalData: true } : {}),
      ...(options.confirmedPersonAliases ? { confirmedPersonAliases: options.confirmedPersonAliases } : {}),
      promptVersion: meta.promptVersion, rulesVersion: meta.rulesVersion });
  }

  async importFiles(files: Array<{ path: string; bytes: Uint8Array | (() => Promise<Uint8Array>) }>, personId: string | null, bindingId: string | null = null): Promise<ImportFilesReceipt> {
    return (await this.importFilesWithDocumentIds(files, personId, bindingId)).receipt;
  }

  async importFilesAndProcess(files: Array<{ path: string; bytes: Uint8Array | (() => Promise<Uint8Array>) }>, personId: string | null, options: {
    accountState: AccountState;
    consentVersion: number;
  }): Promise<ImportFilesReceipt> {
    await this.automaticUploadRecovery;
    if (personId && !this.store.listPersons().some((person) => person.id === personId && person.archivedAt === null)) {
      throw new Error('PERSON_NOT_FOUND');
    }
    const authorizationEpoch = this.store.getAutomaticUploadAuthorizationEpoch();
    const accountFingerprint = options.accountState.status === 'connected' && options.accountState.displayLabel
      ? stableHash({ provider: 'codex-chatgpt', displayLabel: options.accountState.displayLabel }) : null;
    const meta = promptMetaForStage('extract');
    const intentId = personId && files.length ? this.store.automaticUploadIntents.begin({ personId, accountFingerprint,
      authorizationEpoch, version: options.consentVersion, promptVersion: meta.promptVersion, rulesVersion: meta.rulesVersion,
      displayNames: files.map((file) => basename(file.path)) }) : null;
    const { receipt } = await this.importFilesWithDocumentIds(files, personId, null, intentId);
    const batch = intentId ? this.store.automaticUploadIntents.finalize(intentId) : null;
    return { ...receipt, processing: batch ? { status: batch.accountFingerprint ? 'queued' : 'waiting_connection', batchId: batch.batchId }
      : { status: 'local_only' } };
  }

  private async importFilesWithDocumentIds(files: Array<{ path: string; bytes: Uint8Array | (() => Promise<Uint8Array>) }>, personId: string | null,
    bindingId: string | null, uploadIntentId: string | null = null): Promise<{ receipt: ImportFilesReceipt; documentIds: string[] }> {
    const documentIds: string[] = [];
    const receipt: ImportFilesReceipt = {
      selectedCount: files.length,
      importedCount: 0,
      duplicateCount: 0,
      suppressedCount: 0,
      rejected: []
    };
    for (const [itemIndex, file] of files.entries()) {
      const displayName = basename(file.path);
      try {
        const detected = await detectInput(displayName, typeof file.bytes === 'function' ? await file.bytes() : file.bytes);
        if (this.closed) throw new Error('WORKSPACE_CLOSED');
        const sourceHash = createHash('sha256').update(detected.bytes).digest('hex');
        if (this.store.isSourceImportSuppressed(sourceHash)) {
          receipt.suppressedCount += 1;
          if (uploadIntentId) this.store.automaticUploadIntents.markRejected(uploadIntentId, itemIndex, 'SOURCE_IMPORT_SUPPRESSED');
          continue;
        }
        const source = this.store.putSourceObject({
          bytes: detected.bytes,
          mediaType: detected.mediaType,
          displayName
        });
        this.store.registerSourceOccurrence({
          sourceObjectId: source.id,
          bindingId,
          originalPath: file.path,
          displayName
        });
        const document = this.store.registerImportedDocument({
          sourceObjectId: source.id,
          personId,
          assignmentBasis: bindingId ? 'folder_binding' : 'user_selected',
          ...(uploadIntentId ? { uploadIntent: { intentId: uploadIntentId, itemIndex } } : {})
        });
        if (document.duplicate) {
          receipt.duplicateCount += 1;
          continue;
        }
        const createdAt = this.now().toISOString();
        try {
          const common = {
            sourceObjectId: source.id,
            documentId: document.documentId,
            sha256: source.sha256,
            displayName,
            createdAt
          };
          const manifest = await normalizeStoredSource({
            ...common, store: this.store, bytes: detected.bytes, legacyDocConverter: this.legacyDocConverter,
            validateBeforeCommit: () => { if (this.closed) throw new Error('WORKSPACE_CLOSED'); }
          });
          if (this.closed) throw new Error('WORKSPACE_CLOSED');
          this.store.saveSourceManifest(manifest);
          if (uploadIntentId) this.store.automaticUploadIntents.markReady(uploadIntentId, itemIndex);
          receipt.importedCount += 1;
          documentIds.push(document.documentId);
        } catch (error) {
          if (this.closed) throw error;
          this.store.setDocumentStatus(document.documentId, 'blocked');
          throw error;
        }
      } catch (error) {
        if (this.closed) throw error;
        if (uploadIntentId) this.store.automaticUploadIntents.markRejected(uploadIntentId, itemIndex,
          error instanceof Error ? error.message : 'IMPORT_FAILED');
        receipt.rejected.push({
          displayName,
          code: error instanceof Error ? error.message : 'IMPORT_FAILED'
        });
      }
    }
    return { receipt, documentIds };
  }

  getSnapshot(accountState: AccountState | null = null): DashboardSnapshot {
    const generatedAt = this.now();
    const schedule = this.getSchedule();
    const counts = this.store.listPersonDocumentCounts();
    const observationStats = this.store.listPersonObservationStats();
    const storedPersons = this.store.listPersons();
    const activePersonIds = new Set(storedPersons.filter((person) => person.archivedAt === null).map((person) => person.id));
    const imported = this.store.listImportedDocuments().filter((document) => document.personId === null || activePersonIds.has(document.personId));
    const processingDocumentIds = this.store.listProcessingDocumentIds();
    const extractionIssues = this.store.listOpenExtractionReviewIssues()
      .filter((issue) => issue.personId === null || activePersonIds.has(issue.personId));
    // 主快照只承载每位成员最近的展示窗口；精确总数由 SQL 聚合读取，完整事实由成员级查询按需打开。
    // 这样家庭总览不会把全家数万条明细一次性传给 renderer。
    const conflictedDocumentIds = new Set(extractionIssues
      .filter((issue) => issue.kind === 'person_conflict').map((issue) => issue.documentId));
    const nonSourceReviewDocumentIds = new Set(extractionIssues.filter((issue) => !isSourceOnlyExtractionIssue(issue))
      .map((issue) => issue.documentId));
    const sourceReviewDocumentIds = new Set(extractionIssues.filter(isSourceOnlyExtractionIssue).map((issue) => issue.documentId));
    const acceptedObservations = this.store.listAcceptedObservations(undefined, { limitPerPerson: 500 })
      .filter((observation) => activePersonIds.has(observation.personId)
        && !conflictedDocumentIds.has(observation.documentId));
    const v3HistoryPersonIds = new Set(storedPersons.filter((person) => this.store.hasMemberAssessmentHistory(person.id))
      .map((person) => person.id));
    const derivedByPerson = new Map(this.store.listCurrentDerivedSnapshots()
      .filter((snapshot) => !v3HistoryPersonIds.has(snapshot.personId))
      .map((snapshot) => [snapshot.personId, snapshot]));
    const latestDerivedByPerson = new Map(this.store.listLatestDerivedSnapshots()
      .filter((snapshot) => !v3HistoryPersonIds.has(snapshot.personId))
      .map((snapshot) => [snapshot.personId, snapshot]));
    const userDetailActionIds = new Set([...activePersonIds].flatMap((personId) =>
      this.store.listActionAdoptions(personId).map((action) => action.id)));
    const allActions = this.store.listActionItems().map((action) => presentSavedAction(action, userDetailActionIds.has(action.id)));
    const assessmentByPerson = new Map<string, MemberAssessmentSnapshotV3 | null>();
    const persons = storedPersons.filter((person) => person.archivedAt === null).map((person) => {
      const documentCount = counts.get(person.id) ?? 0;
      const pendingCount = imported.filter((document) => document.personId === person.id && document.status === 'queued' && !processingDocumentIds.has(document.id)).length;
      const processingCount = imported.filter((document) => document.personId === person.id && processingDocumentIds.has(document.id)).length;
      const stats = observationStats.get(person.id) ?? { acceptedFactCount: 0, attentionCount: 0, latestClinicalDate: null };
      const attentionCount = stats.attentionCount;
      const lastDocumentDate = stats.latestClinicalDate;
      const derived = latestDerivedByPerson.get(person.id);
      const assessment = this.getMemberAssessment(person.id);
      const familyNarrative = assessment ? familyAssessmentNarrative(assessment) : null;
      assessmentByPerson.set(person.id, assessment);
      const systemAnalyses = this.store.listSystemAnalysisSnapshots(person.id, false);
      const proposals = this.store.listLifestyleProposals(person.id);
      const personActions = allActions.filter((action) => action.personId === person.id);
      return {
        id: person.id,
        displayName: person.displayName,
        relation: person.relation ?? '家庭成员',
        birthYear: person.birthYear,
        avatarInitial: Array.from(person.displayName)[0] ?? '家',
        lastDocumentDate,
        documentCount,
        acceptedFactCount: stats.acceptedFactCount,
        pendingCount,
        attentionCount,
        dataQuality: documentCount > 0 ? 'partial' as const : 'insufficient' as const,
        freshnessLabel: stats.acceptedFactCount > 0
          ? `已接纳 ${stats.acceptedFactCount} 条有来源事实`
          : processingCount > 0 ? `${processingCount} 份资料已进入处理中心`
            : documentCount > 0 ? `${documentCount} 份资料等待处理` : '尚未导入资料',
        changeSummary: familyNarrative?.headline ?? (stats.acceptedFactCount > 0
          ? `已保存 ${stats.acceptedFactCount} 条报告事实，健康解读暂未发布`
          : processingCount > 0 ? '资料已安全保存在本机，处理进度可在处理中心查看'
            : documentCount > 0 ? '资料已安全保存在本机，尚未形成健康结论' : '可以先添加一份体检或门诊资料'),
        derivedStatus: assessment?.status === 'current' ? 'current' as const : derived || v3HistoryPersonIds.has(person.id)
          ? 'stale' as const : 'unavailable' as const,
        assessmentRefreshStatus: stats.acceptedFactCount === 0 || assessment?.status === 'current'
          ? 'none' as const : assessment ? 'optional_rules' as const : 'required' as const,
        assessmentSummary: familyNarrative?.summary ?? null,
        dataRevision: stableHash({
          factRevision: this.store.getFactRevision(person.id),
          clinicalContextRevision: person.clinicalContextRevision,
          displayRevision: person.displayRevision,
          derived: derived ? { id: derived.id, status: derived.status, createdAt: derived.createdAt } : null,
          memberAssessment: assessment ? { id: assessment.id, status: assessment.status, inputSignature: assessment.inputSignature,
            presentationVersion: assessment.presentation?.version ?? null } : null,
          systemAnalyses: systemAnalyses.map((analysis) => ({ id: analysis.id, status: analysis.status, generatedAt: analysis.generatedAt })),
          proposals: proposals.map((proposal) => ({ id: proposal.id, status: proposal.status, version: proposal.version, updatedAt: proposal.updatedAt })),
          actions: personActions.map((action) => ({ id: action.id, userRevision: action.userRevision, status: action.status }))
        }),
        displayRevision: person.displayRevision,
        clinicalContextRevision: person.clinicalContextRevision
      };
    });
    const transmissionStatuses = this.store.listDocumentAiTransmissionStatuses(imported.map((document) => document.id));
    const documentAcceptedFactCounts = this.store.listDocumentAcceptedFactCounts();
    const dateBindingReviewCounts = this.store.listDateBindingReviewDocumentCounts();
    const inbox = imported.map((document) => ({
      id: document.id,
      displayName: document.displayName,
      discoveredAt: document.discoveredAt,
      personId: document.personId,
      personLabel: document.personLabel,
      personAssignmentBasis: document.personAssignmentBasis,
      status: document.status,
      format: formatLabel(document.mediaType),
      sourceLabel: document.sourceLabel,
      sentToAi: transmissionStatuses.get(document.id) !== 'not_sent',
      aiTransmissionStatus: transmissionStatuses.get(document.id) ?? 'not_sent',
      // 已读报告的来源核查归处理中心；不篡改文档/核查终态，也不把它当作未开始的新资料。
      inProcessingCenter: processingDocumentIds.has(document.id)
        || document.status === 'needs_review' && document.personId !== null
          && transmissionStatuses.get(document.id) === 'completed'
          && sourceReviewDocumentIds.has(document.id) && !nonSourceReviewDocumentIds.has(document.id),
      issue: document.status === 'completed' && (documentAcceptedFactCounts.get(document.id) ?? 0) === 0
        ? '已读完，尚无可纳入分析的检查结果；原件已保留。'
        : document.issue,
      acceptedFactCount: documentAcceptedFactCounts.get(document.id) ?? 0,
      dateBindingReviewCount: dateBindingReviewCounts.get(document.id) ?? 0
    }));
    const assignmentReviews = imported
      .filter((document) => document.status === 'needs_review' && document.personId === null)
      .map((document) => ({
        id: `review-${document.id}`,
        personId: null,
        documentId: document.id,
        kind: 'person_conflict' as const,
        severity: 'blocking' as const,
        title: `确认“${document.displayName}”属于谁`,
        description: '这份资料尚未可靠关联到家庭成员。确认之前不会发送给 AI。',
        evidenceRefs: [],
        candidateOptions: [],
        candidateDiffs: [],
        reportedName: null,
        reasonCodes: [],
        resolutionStatus: 'open' as const
      }));
    const extractionDocumentIds = new Set(extractionIssues.map((issue) => issue.documentId));
    const importedById = new Map(imported.map((document) => [document.id, document]));
    const repairOutcomesByDocument = new Map([...extractionDocumentIds].map((documentId) => [documentId,
      this.store.listExtractionRepairDiagnostics({ documentId }).at(-1)?.outcome ?? null]));
    const reviews = [
      ...assignmentReviews.filter((issue) => !extractionDocumentIds.has(issue.documentId)),
      ...extractionIssues.map((issue) => {
        const partialPublishLimitation = isReadOnlyPartialPublishIssue(
          issue,
          importedById.get(issue.documentId)?.status,
          this.store.isDocumentCommitted(issue.documentId)
        );
        const legacyFieldReview = issue.severity === 'blocking'
          && issue.kind === 'field_conflict'
          && issue.candidateOptions.length > 0
          && (issue.candidateDiffs.length === 0 || issue.reasonCodes.includes('INDEPENDENT_REVIEW_MISMATCH'));
        const unverifiedIdentity = issue.reasonCodes.includes('PERSON_IDENTITY_NOT_CONFIRMED')
          && issue.reportedName === null;
        const differenceCount = issue.candidateDiffs.length;
        const evidenceOnlyReview = differenceCount > 0
          && issue.candidateDiffs.every((difference) => difference.fields.length === 1 && difference.fields[0] === 'issues');
        const mixedFieldReview = differenceCount > 0
          && issue.candidateDiffs.some((difference) => difference.fields.includes('issues'))
          && !evidenceOnlyReview;
        const sourceOnlyIssue = (issue.kind === 'field_conflict' || issue.kind === 'coverage_gap')
          && differenceCount === 0 && !issue.reasonCodes.some((code) => code.startsWith('PERSON_'));
        const documentStatus = importedById.get(issue.documentId)?.status;
        const noAcceptedResults = sourceOnlyIssue && ['completed', 'needs_review'].includes(documentStatus ?? '')
          && (documentAcceptedFactCounts.get(issue.documentId) ?? 0) === 0;
        const repairExplanation = sourceRepairExplanation(issue.reasonCodes, repairOutcomesByDocument.get(issue.documentId) ?? null);
        const auxiliaryOnlyLimitation = issue.severity === 'warning' && differenceCount === 0
          && issue.candidateOptions.length === 0 && issue.reasonCodes.length > 0
          && issue.reasonCodes.every((code) => ['direct_original_clinical_date_unverified', 'direct_original_clinical_date_binding_missing',
            'direct_original_metadata_field_unverified', 'direct_original_metadata_time_unverified'].includes(code.split(':')[0]!));
        return {
          id: issue.id,
          personId: issue.personId,
          documentId: issue.documentId,
          kind: issue.kind,
          severity: issue.severity,
          title: issue.kind === 'person_conflict'
            ? '确认报告姓名与成员归属'
            : auxiliaryOnlyLimitation ? '结果已保存，部分日期或辅助信息待确认'
            : noAcceptedResults ? '已读完，尚无可纳入分析的检查结果'
            : partialPublishLimitation
              ? '这份报告有读取内容待核实'
            : legacyFieldReview ? '请重新读取这份报告'
            : unverifiedIdentity ? '这份资料没有可确认的姓名'
            : issue.kind === 'field_conflict'
              ? evidenceOnlyReview
                ? `${differenceCount} 项原始依据还不够清楚`
                : mixedFieldReview
                  ? `发现 ${differenceCount} 项需要处理的内容`
                  : `请确认 ${differenceCount} 项检查结果`
            : issue.kind === 'derived_safety' ? '这次健康解读暂不可用' : '请确认报告中未读清的内容',
          description: issue.kind === 'person_conflict'
            ? `应用把“${issue.reportedName ?? '未识别姓名'}”识别为受检者，当前准备归入已选成员。请对照原图：如果这是报告者、审核人等工作人员，可选择重新核对姓名。`
            : auxiliaryOnlyLimitation
              ? `${repairExplanation}原始内容仍保留，不影响其他有独立依据的结果和建议；无需重复确认。`
            : noAcceptedResults
              ? `${repairExplanation}这份资料尚无检查结果纳入健康分析，原件仍已保留，不代表结果正常；不用凭猜测确认。`
            : partialPublishLimitation
              ? `${repairExplanation}其他有可靠依据的检查结果已经保存；这些项目暂时无法可靠确认，没有用于健康分析，不代表结果正常。可查看原报告，或重新读取这份报告。`
            : issue.kind === 'derived_safety'
            ? issue.reasonCodes.some((code) => code.startsWith('evidence_mismatch:'))
              ? '已保存的检查结果仍可查看。这次解读中有内容无法从报告得到支持，暂不用于健康判断；你可以重新生成解读，或先保留报告结果。'
              : issue.reasonCodes.some((code) => code.startsWith('medical_boundary:') || code.startsWith('dosage_boundary:'))
                ? '已保存的检查结果仍可查看。这次解读中有内容可能被误当成诊断、处方或用药剂量，不能据此采取行动；你可以重新生成解读，或先保留报告结果。'
                : '已保存的检查结果仍可查看。这次健康解读暂时不能可靠使用；你可以重新生成解读，或先保留报告结果。'
            : legacyFieldReview
              ? `${repairExplanation}这份报告的部分内容还未确认清楚。可以按当前流程重新读取，原件和已保存的结果会保留。`
              : unverifiedIdentity
                ? '原报告中没有读到明确的受检者姓名。请查看原报告，确认这份资料属于哪位家人；不要把报告医生或审核人的姓名当作受检者。'
              : issue.kind === 'field_conflict'
                ? evidenceOnlyReview
                  ? '这些项目的原文、检查日期或异常提示还没有读清，不一定是数值有误。可以先重新读取报告；仍无法确认的单项可暂不纳入，其他结果会保留。'
                  : mixedFieldReview
                    ? '请对照原报告确认下方项目的结果、单位或检查日期。原文看不清的单项可暂不纳入，其他结果会保留。'
                    : `请对照原报告，确认下方 ${differenceCount} 项的检查结果、单位或日期。只需处理列出的项目；看不清的单项可暂不纳入。`
                : '报告中还有未读清的内容。请查看原报告并重新读取；仍看不清的项目可暂不纳入，不会被当作正常结果。',
          evidenceRefs: issue.evidenceRefs,
          candidateOptions: issue.candidateOptions,
          ...(issue.readingAudit ? { readingAudit: issue.readingAudit } : {}),
          candidateDiffs: issue.candidateDiffs,
          reportedName: issue.reportedName,
          reasonCodes: issue.reasonCodes,
          resolutionStatus: 'open' as const
        };
      })
    ];
    const storedJobs = this.store.listStoredJobs();
    const latestJobByDocument = new Map<string, string>();
    const latestReadingJobByDocument = new Map<string, string>();
    const readingDocumentIdsByJob = new Map(storedJobs.map((job) => [job.id, this.store.getJobReadingDocumentIds(job.id)]));
    const processedDocumentIdsByJob = new Map(storedJobs.map((job) => [job.id, this.store.getJobProcessedDocumentIds(job.id)]));
    for (const job of storedJobs) {
      // 已取消的新任务不能接替旧任务的恢复入口。
      if (job.status === 'cancelled') continue;
      for (const documentId of job.documentIds) {
        if (!latestJobByDocument.has(documentId)) latestJobByDocument.set(documentId, job.id);
        // 综合可以读取旧事实，但不能冒充这次重新读取的任务所有者。
        // 读取推进到分析阶段后，明确的重核范围或真实读取传输仍能证明其读取职责。
        if (readingDocumentIdsByJob.get(job.id)!.has(documentId) && !latestReadingJobByDocument.has(documentId)) {
          latestReadingJobByDocument.set(documentId, job.id);
        }
      }
    }
    // 新综合可能只覆盖旧批次中的部分报告；旧批次独有的未保存资料仍需要恢复入口。
    const unfinishedDocumentIds = new Set(imported.filter((document) => document.personId !== null
      && !this.store.isDocumentCommitted(document.id)
      && !this.store.isDocumentExcluded(document.id)).map((document) => document.id));
    return dashboardSnapshotSchema.parse({
      workspaceMode: 'personal',
      workspaceName: this.workspaceName,
      account: accountState ?? {
        status: 'disconnected',
        displayLabel: null,
        quota: { status: 'unknown', primaryUsedPercent: null, secondaryUsedPercent: null, resetsAt: null },
        runtimeVersion: null,
        lastCheckedAt: null
      },
      nextScheduledRun: schedule.enabled ? schedule.nextRunUtc : null,
      scheduleEnabled: schedule.enabled,
      scheduleLocalTime: schedule.localTime,
      scheduleTimeZone: schedule.timeZone,
      scheduleRevision: schedule.revision,
      queuePaused: this.store.isQueuePaused(),
      pendingInboxCount: inbox.filter((item) => !item.inProcessingCenter && ['queued', 'needs_review'].includes(item.status)).length,
      openReviewCount: reviews.filter((review) => review.severity === 'blocking' && review.resolutionStatus === 'open').length,
      processingRebuildSources: this.store.listProcessingRebuildSources()
        .map(({ documentId, personId, sourceObjectId, sha256 }) => ({ documentId, personId, sourceObjectId, sha256 })),
      persons,
      organs: persons.flatMap((person) => organNames.map(([id, name]) => {
        const related = acceptedObservations.filter((observation) => observation.personId === person.id && observationOrgans(observation).includes(id));
        const attention = related.filter((observation) => ['high', 'low', 'positive'].includes(observation.abnormalFlag));
        const evidenceDate = related.filter((observation) => observation.clinicalDate).map((observation) => observation.clinicalDate!).sort().at(-1) ?? null;
        const derivedClaim = derivedByPerson.get(person.id)?.payload.claims.find((claim) => claim.organId === id);
        const derivedEvidence = derivedClaim?.evidenceObservationIds
          .map((observationId) => acceptedObservations.find((observation) => observation.id === observationId))
          .find(Boolean);
        return {
          id,
          personId: person.id,
          name,
          status: related.length === 0 ? 'insufficient' as const : attention.length > 0 ? 'attention' as const : 'stable' as const,
          summary: derivedClaim?.explanation ?? (related.length === 0
            ? '尚无经过接纳的相关记录。'
            : attention.length > 0
              ? `已记录 ${related.length} 项，其中 ${attention.length} 项由原报告标记需关注。`
              : `已记录 ${related.length} 项，现有原报告未标记异常。`),
          evidenceDate,
          evidenceSourceSpanId: derivedEvidence?.sourceSpanId ?? related.at(-1)?.sourceSpanId ?? null,
          metricCount: related.length
        };
      })),
      trends: buildTrendSeries(acceptedObservations),
      timeline: [
        ...[...acceptedObservations.reduce((groups, observation) => {
          const group = groups.get(observation.documentId) ?? [];
          group.push(observation);
          groups.set(observation.documentId, group);
          return groups;
        }, new Map<string, AcceptedObservationSummary[]>()).values()].map((sameDocument) => {
          const observation = sameDocument[0]!;
          const date = sameDocument.map((item) => item.clinicalDate).filter((value): value is string => Boolean(value)).sort()[0] ?? null;
          const names = [...new Set(sameDocument.map((item) => item.conceptKey))];
          return {
            id: `event-document-${observation.documentId}`,
            personId: observation.personId,
            date,
            dateLabel: date ?? '报告日期待确认',
            type: 'health_report' as const,
            title: observation.sourceLabel,
            summary: `${sameDocument.length} 条已接纳记录：${names.slice(0, 3).join('、')}${names.length > 3 ? '等' : ''}`,
            sourceLabel: observation.sourceLabel,
            documentId: observation.documentId,
            sourceSpanId: observation.sourceSpanId
          };
        }),
        ...this.store.listManualNotes().filter((note) => activePersonIds.has(note.personId)).map((note) => ({
          id: `event-note-${note.id}`,
          personId: note.personId,
          date: note.effectiveDate,
          dateLabel: note.effectiveDate ?? new Date(note.recordedAt).toISOString().slice(0, 10),
          type: 'manual_note' as const,
          title: '本人补充',
          summary: note.immutableText,
          sourceLabel: '用户填写',
          documentId: null,
          sourceSpanId: null
        }))
      ].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')),
      guidance: [...derivedByPerson.values()].filter((snapshot) => activePersonIds.has(snapshot.personId)).flatMap((snapshot) => snapshot.payload.lifestyleGuidance.map((guidance) => ({
        id: guidance.id,
        personId: snapshot.personId,
        title: guidance.title,
        detail: guidance.detail,
        consultProfessional: guidance.consultProfessional,
        evidenceCount: guidance.evidenceObservationIds.length
      }))),
      inbox,
      jobs: storedJobs.map((job) => {
        const readingDocumentIds = readingDocumentIdsByJob.get(job.id)!;
        const processedDocumentIds = processedDocumentIdsByJob.get(job.id)!;
        const latestOwner = (documentId: string) => readingDocumentIds.has(documentId)
          ? latestReadingJobByDocument.get(documentId) : latestJobByDocument.get(documentId);
        const unfinishedOwnedCount = job.documentIds.filter((documentId) => {
          const document = importedById.get(documentId);
          if (!document?.personId || this.store.isDocumentExcluded(documentId) || latestOwner(documentId) !== job.id) return false;
          // 旧提交只证明以前保存过结果，不能证明这次重核已走完。
          // partial/needs_review/excluded等逐份终态收据均算读完，不因零接纳再称“未处理”。
          if (readingDocumentIds.has(documentId)) return !processedDocumentIds.has(documentId);
          // 旧派生任务可能错误地先推进了阶段；没有本轮读取证明时仍保留未提交检查。
          return unfinishedDocumentIds.has(documentId);
        }).length;
        const fullyHandedOff = job.documentIds.length > 0 && job.documentIds.every((documentId) => (
          latestOwner(documentId) !== undefined && latestOwner(documentId) !== job.id
        ));
        // 成员综合可能只用一份报告作为任务入口。只有日期更新、全成员范围且仍匹配当前资料的综合才能接替旧分析。
        // getMemberAssessment 已核查事实、个人背景和待确认范围版本，不能仅凭另一项任务“成功”就宣称覆盖。
        const coveredByAssessment = job.documentIds.length > 0 && job.documentIds.every((documentId) => {
          const document = importedById.get(documentId);
          if (!document?.personId || !this.store.isDocumentCommitted(documentId)) return false;
          const assessment = assessmentByPerson.get(document.personId);
          return Boolean(assessment && assessment.mode !== 'partition' && assessment.requestedSystemIds.length === 0
            && Date.parse(assessment.generatedAt) > Date.parse(job.updatedAt));
        });
        const terminal = ['succeeded', 'failed', 'completed_with_issues', 'cancelled'].includes(job.status);
        const superseded = terminal && unfinishedOwnedCount === 0 && (fullyHandedOff || coveredByAssessment);
        const unfinishedFailure = ['failed', 'completed_with_issues'].includes(job.status) && unfinishedOwnedCount > 0;
        const readFinished = ['succeeded', 'completed_with_issues'].includes(job.status) && job.completedUnits >= job.totalUnits;
        const noResultDocumentCount = readFinished ? job.documentIds.filter((documentId) => (
          importedById.get(documentId)?.status === 'completed'
          && (documentAcceptedFactCounts.get(documentId) ?? 0) === 0
        )).length : 0;
        const hasHeldReports = readFinished && extractionIssues.some((issue) => job.documentIds.includes(issue.documentId)
          && (issue.kind === 'field_conflict' || issue.kind === 'coverage_gap') && issue.candidateDiffs.length === 0);
        const status = job.status === 'succeeded' && (noResultDocumentCount > 0 || hasHeldReports)
          ? 'completed_with_issues' as const : job.status;
        const { documentIds: _documentIds, ...summary } = job;
        return {
          ...summary,
          status,
          statusText: superseded ? '已有较新的处理任务，请使用上方任务继续'
            : unfinishedFailure ? `${job.status === 'failed' ? `${job.statusText}；` : ''}还有 ${unfinishedOwnedCount} 份资料未完成整理，可重试继续处理；已保存的检查结果仍可查看`
            : job.assessmentOutcome?.status === 'rejected'
              ? `${readFinished ? '报告处理已完成，' : ''}综合解读未更新；已保存的检查结果仍可查看`
            : noResultDocumentCount > 0 ? `资料已读完；其中 ${noResultDocumentCount} 份尚无可纳入分析的检查结果，原件已保留`
            : hasHeldReports ? '可靠检查结果已保存，部分项目未纳入；可按成员查看原因' : job.statusText,
          canCancel: !superseded && ['queued', 'running', 'waiting_auth', 'waiting_quota', 'waiting_user', 'retry_wait'].includes(job.status)
            && job.statusText !== '正在安全停止',
          canRetry: !superseded && ['failed', 'completed_with_issues', 'waiting_quota'].includes(job.status)
        };
      }),
      reviews,
      actions: allActions.filter((action) => activePersonIds.has(action.personId)),
      notes: this.store.listManualNotes().filter((note) => activePersonIds.has(note.personId)),
      privacyNotice: '资料已保存在本机个人工作区。只有在你连接 Codex 并明确授权范围后，必要内容才会发送给 OpenAI。',
      generatedAt: generatedAt.toISOString()
    });
  }
}
