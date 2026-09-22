import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { AccountState, ActionItem, ActionStatus, AdoptMemberAssessmentActionInput, AdoptedActionReceipt, AdoptLifestyleProposalInput, ArchivePersonInput, BodySystemDetailV2, BodySystemId, BodySystemSummaryV2, ConceptMappingReceipt, ConceptReviewBundle, CreateActionItemInput, CreateManualNoteInput, CreatePersonInput, DashboardSnapshot, DeleteDocumentInput, HealthEventDetailV2, HealthEventRelationReceipt, HealthEventV2, ImportFilesReceipt, InboxBindingSummary, LifestylePlanV2, LifestyleProposalDecisionReceipt, MemberAssessmentSnapshotV3, MemberEvidenceBundle, MemberEvidenceRef, MemberOverviewV2, MergeHealthEventsInput, MetricSeriesDetailV2, MetricSeriesSummary, ObservationCandidate, ReportMetadataCorrectionReceipt, RestorePersonInput, SetConceptMappingInput, SetDocumentInclusionInput, SetLifestyleProposalDecisionInput, SplitHealthEventInput, SystemAnalysisSnapshot, SystemEvidenceBundle, UndoConceptMappingInput, UndoHealthEventRelationInput, UndoReportMetadataInput, UpdatePersonDisplayInput, UpdateReportMetadataInput, UpdateScheduleInput } from '@contracts';
import { bodySystemDetailV2Schema, bodySystemSummaryV2Schema, conceptMappingReceiptSchema, conceptReviewBundleSchema, dashboardSnapshotSchema, healthEventDetailV2Schema, healthEventV2Schema, lifestylePlanV2Schema, memberAssessmentSnapshotV3Schema, memberEvidenceBundleSchema, memberOverviewV2Schema, metricSeriesDetailV2Schema } from '@contracts';
import { bodySystemRegistry, buildMetricSeries as buildMetricSeriesV2, conceptDictionary, evaluateObservationCandidate, linkConceptToSystems, linkLegacyCandidateToSystems, sameAdoptedActionScope, stableHash, type TrendObservationInput } from '@core';
import { buildDocxManifest, buildHeicManifest, buildImageManifest, buildPdfManifest, buildTextManifest, decodeText, detectInput, type LegacyDocConverter } from '@ingestion';
import { WorkspaceStore, type AcceptedObservationSummary } from '@storage';
import { determineEligibleSlot, jobInputSignature, nextScheduledRunUtc } from '@workflow';
import { recoveryPointsReferenceSourceHash } from './recovery-point-service.js';
import { buildSourceUrgentNotices } from './source-urgent-notice.js';
import { buildCurrentSymptomNotices } from './current-symptom-notice.js';
import { ACCEPTANCE_RULES_VERSION, MEMBER_ASSESSMENT_PROMPT_VERSION, MEMBER_ASSESSMENT_RULES_VERSION, promptMetaForStage } from './prompts/index.js';
import { buildSystemEvidenceBundle as buildSystemEvidenceBundleFromStore } from './system-evidence.js';

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

function asTrendObservation(observation: AcceptedObservationSummary): TrendObservationInput {
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

function buildMemberMetricSeries(observations: AcceptedObservationSummary[]): MetricSeriesSummary[] {
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

export class PersonalWorkspaceService {
  readonly store: WorkspaceStore;

  constructor(
    rootDirectory: string,
    readonly workspaceName: string,
    private readonly now: () => Date = () => new Date(),
    private readonly timeZoneProvider: () => string = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    private readonly legacyDocConverter: LegacyDocConverter | null = null
  ) {
    this.store = new WorkspaceStore({ rootDirectory, now });
    this.store.recoverInterruptedJobs();
    this.store.revokeUnreferencedManualProcessingConsents();
  }

  private requireActivePerson(personId: string) {
    const person = this.store.listPersons().find((item) => item.id === personId && item.archivedAt === null);
    if (!person) throw new Error('PERSON_NOT_FOUND');
    return person;
  }

  private memberObservations(personId: string): AcceptedObservationSummary[] {
    this.requireActivePerson(personId);
    const conflictedDocumentIds = new Set(this.store.listOpenExtractionReviewIssues()
      .filter((issue) => issue.personId === personId && issue.kind === 'person_conflict')
      .map((issue) => issue.documentId));
    return this.store.listAcceptedObservations(personId)
      .filter((observation) => !conflictedDocumentIds.has(observation.documentId));
  }

  getMemberAssessment(personId: string): MemberAssessmentSnapshotV3 | null {
    this.requireActivePerson(personId);
    const snapshot = this.store.listMemberAssessmentSnapshots(personId, true)[0];
    if (!snapshot || snapshot.promptVersion !== MEMBER_ASSESSMENT_PROMPT_VERSION
      || snapshot.rulesVersion !== MEMBER_ASSESSMENT_RULES_VERSION
      || snapshot.factRevision !== this.store.getFactRevision(personId)
      || snapshot.contextRevision !== this.store.getClinicalContextRevision(personId)
      || snapshot.reviewScopeSignature !== this.store.getOpenReviewScopeSignature(personId)) return null;
    const parsed = memberAssessmentSnapshotV3Schema.safeParse(snapshot);
    return parsed.success ? parsed.data : null;
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
        status: v3System?.status ?? (direct.length === 0
          ? legacyRelatedCount > 0 ? 'building' : 'insufficient'
          : currentAnalysis?.assessmentStatus === 'attention' || attention.length > 0 ? 'attention'
            : currentAnalysis?.assessmentStatus === 'undetermined' || !currentAnalysis ? 'building' : 'stable'),
        summary: v3System?.headline ?? currentAnalysis?.headline
          ?? (direct.length === 0
            ? related.length > 0 ? '有相关背景资料，但还没有本系统的直接检查。' : '尚无相关检查。'
            : '已有相关检查，综合解读正在准备。'),
        factCount: related.length,
        metricCount: relatedSeries.length,
        attentionCount: attention.length,
        latestDate: related.map((item) => item.clinicalDate).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null,
        analysisStatus: v3System ? 'current' : analysis?.status ?? 'unavailable',
        topics: registry.topics.map((topic) => ({ id: topic.id, name: topic.name, factCount: topicCounts.get(topic.id) ?? 0 }))
      });
    });
  }

  getMemberOverview(personId: string): MemberOverviewV2 {
    const observations = this.memberObservations(personId);
    const assessment = this.getMemberAssessment(personId);
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
    const lead = analyses[0]?.analysis ?? null;
    const priorityIssues = assessment ? assessment.claims
      .filter((claim) => claim.consequenceLevel !== 'routine' && claim.systemIds.length > 0)
      .slice(0, 3)
      .map((claim) => ({
        id: claim.id, title: claim.text, explanation: claim.rationale,
        nextStep: assessment.actions.find((action) => action.claimIds.includes(claim.id))?.firstStep ?? null,
        systemId: claim.systemIds[0]!
      })) : analyses
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
      headline: assessment?.overview.headline ?? (observations.length === 0
        ? '还没有可解读的健康资料。'
        : lead?.headline ?? '报告内容已保存，健康解读正在准备。'),
      overview: assessment ? [assessment.overview.summary,
        ...(assessment.processingPlan.aggregateSummarizedOnlyObservationIds?.length
          ? assessment.overview.limitations.filter((item) => item.includes('仅经分区摘要参与综合')) : [])].join(' ')
        : (observations.length === 0
        ? '添加体检、门诊或检查资料后，这里会先告诉你最值得知道的情况和下一步。'
        : lead?.overview
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
    const observations = this.memberObservations(personId);
    const registry = bodySystemRegistry.find((item) => item.id === systemId);
    if (!registry) throw new Error('BODY_SYSTEM_NOT_FOUND');
    const summary = this.listBodySystems(personId).find((item) => item.id === systemId)!;
    const related = observations.filter((observation) => memberSystemLinks(observation).some((link) => link.systemId === systemId));
    const mappings = related.map((observation) => ({ observation, mapping: memberMapping(observation) }));
    const metrics = buildMemberMetricSeries(related)
      .filter((series) => series.points.some((point) => point.numericValue !== null));
    const latestByName = new Map<string, AcceptedObservationSummary>();
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
        time: {
          value: observation.clinicalDate,
          endValue: null,
          precision: observation.clinicalDate ? 'day' : 'unknown',
          role: 'unknown',
          source: observation.clinicalDate ? 'explicit' : 'unknown',
          displayLabel: observation.clinicalDate ?? '日期待确认'
        },
        abnormalFlag: observation.abnormalFlag,
        evidence: memberEvidenceSources(observation)
        })),
      relatedEventIds: events.map((event) => event.id),
      unmappedFactCount: mappings.filter(({ mapping }) => mapping.status === 'unmapped').length
    });
  }

  getMetricSeries(personId: string, seriesId: string): MetricSeriesDetailV2 {
    const observations = this.memberObservations(personId);
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
      const dates = [...new Set(items.map((item) => item.clinicalDate).filter((value): value is string => Boolean(value)))].sort();
      const firstDate = dates[0] ?? null;
      const lastDate = dates.at(-1) ?? null;
      const spanDays = firstDate && lastDate ? Math.round((Date.parse(`${lastDate}T00:00:00Z`) - Date.parse(`${firstDate}T00:00:00Z`)) / 86_400_000) : null;
      const extractedClinicalTime = extracted?.times
        .filter((time) => ['day', 'month', 'year'].includes(time.precision) && ['sampled', 'examined', 'encounter'].includes(time.role))
        .sort((left, right) => ({ day: 3, month: 2, year: 1 }[right.precision as 'day' | 'month' | 'year']
          - { day: 3, month: 2, year: 1 }[left.precision as 'day' | 'month' | 'year']))[0];
      const explicitClinicalTime = report?.metadataStatus === 'corrected'
        ? { ...report.clinicalTime, role: 'examined' as const }
        : extractedClinicalTime;
      const eventDate = explicitClinicalTime?.value ?? (dates.length === 1 || (spanDays !== null && spanDays <= 14) ? firstDate : null);
      const endDate = explicitClinicalTime ? null : eventDate && lastDate !== eventDate ? lastDate : null;
      const eventPrecision = explicitClinicalTime?.precision as 'year' | 'month' | 'day' | undefined
        ?? (eventDate ? 'day' : 'unknown');
      const systemIds = [...new Set(items.flatMap((item) => memberSystemLinks(item).map((link) => link.systemId)))];
      const verifiedEventText = reports.map((item) => (
        item.metadataStatus === 'corrected'
          ? [item.reportKind, item.title]
          : [item.extracted?.reportKind?.value, item.extracted?.title?.value]
      ).filter(Boolean).join(' ')).join(' ');
      const looksLikeCheckup = /体检|健康检查|健康体检/i.test(verifiedEventText);
      const looksLikeImaging = items.some((item) => /超声|彩超|ct|mr|磁共振|x线|dr|影像/i.test(`${item.method ?? ''}${item.conceptKey}`));
      const eventType: HealthEventV2['type'] = looksLikeCheckup
        ? 'checkup'
        : /(影像|超声|彩超|ct|mr|磁共振|x线|dr)/i.test(verifiedEventText)
          ? 'imaging'
          : looksLikeImaging && reports.length === 0 ? 'imaging' : 'laboratory';
      const fallbackTitle = eventType === 'checkup'
        ? `${eventDate?.slice(0, 4) ?? '日期待确认'} 年度体检`
        : eventType === 'imaging'
          ? '影像检查'
          : '检验记录';
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
          ? `这次检查涉及${systemNames.slice(0, 3).join('、')}，可以打开查看完整结果。`
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
          role: explicitClinicalTime?.role === 'sampled' ? 'specimen' : explicitClinicalTime ? 'exam' : looksLikeCheckup ? 'exam' : 'unknown',
          source: explicitClinicalTime ? 'explicit' : eventDate ? 'inherited' : 'unknown',
          displayLabel: eventDate
            ? (endDate ? `${eventDate} 至 ${endDate}` : clinicalTimeLabel(eventDate, eventPrecision as 'year' | 'month' | 'day'))
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
      .sort((left, right) => (right.time.value ?? '').localeCompare(left.time.value ?? ''));
  }

  getHealthEventDetail(personId: string, eventId: string): HealthEventDetailV2 {
    const event = this.listHealthEvents(personId).find((item) => item.id === eventId);
    if (!event) throw new Error('HEALTH_EVENT_NOT_FOUND');
    const observations = this.memberObservations(personId).filter((item) => event.documentIds.includes(item.documentId));
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
        value: `${observation.rawText}${observation.unit ? ` ${observation.unit}` : ''}`,
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
            value: `${observation.rawText}${observation.unit ? ` ${observation.unit}` : ''}`,
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
        startingOptions: ['先保留为参考，等待新版复核后再决定是否采纳'],
        scheduleSuggestion: null,
        trackingSuggestion: '当前为旧版建议，重新复核前不自动创建跟进行动。',
        constraints: ['旧版记录缺少新版所需的适用边界，不能直接采纳为行动。'],
        uncertainties: ['尚未按当前提示词和安全规则重新复核。'],
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
          title: action.title,
          userGoal: action.userGoal,
          selectedStartingOption: action.selectedStartingOption,
          plannedTime: action.plannedTime,
          owner: action.owner,
          progressNote: action.progressNote,
          status: action.status,
          dueDate: action.dueDate,
          updatedAt: action.updatedAt
        }))
        : legacyActions.map((action) => ({
          id: action.id,
          proposalId: null,
          title: action.title,
          userGoal: action.title,
          selectedStartingOption: action.detail,
          plannedTime: action.dueText,
          owner: '本人',
          progressNote: null,
          status: action.status,
          dueDate: action.dueDate,
          updatedAt: action.updatedAt
        }))), ...assessmentAdoptions.map(({ action, dedupeKey }) => ({
        id: action.id, proposalId: null, assessmentDedupeKey: dedupeKey,
        title: action.title, userGoal: action.title, selectedStartingOption: action.detail,
        plannedTime: action.dueText, owner: '本人', progressNote: null,
        status: action.status, dueDate: action.dueDate, updatedAt: action.updatedAt
      }))]
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
    if (!current || current.id !== input.snapshotId) throw new Error('MEMBER_ASSESSMENT_ACTION_STALE');
    return this.store.adoptMemberAssessmentAction(input);
  }

  setLifestyleProposalDecision(input: SetLifestyleProposalDecisionInput): LifestyleProposalDecisionReceipt {
    this.requireActivePerson(input.personId);
    // 旧建议只读兼容；不能绕过页面状态直接恢复为可采纳候选。
    throw new Error('LIFESTYLE_PROPOSAL_STALE_REVIEW_REQUIRED');
  }

  close(): void {
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

  processNow(options?: {
    accountState: AccountState;
    consentVersion: number;
    documentIds?: string[];
  }): { batchId: string; idempotent: boolean } {
    const selectedIds = options?.documentIds ? new Set(options.documentIds) : null;
    const trackedDocumentIds = options ? this.store.listProcessingDocumentIds() : new Set<string>();
    const activeDocumentIds = options ? this.store.listActiveProcessingDocumentIds() : new Set<string>();
    if (selectedIds && [...selectedIds].some((documentId) => trackedDocumentIds.has(documentId))) {
      throw new Error('DOCUMENT_ALREADY_IN_PROCESSING');
    }
    const byPerson = new Map<string, { documentIds: string[]; stage: 'extract' | 'analyze' }>();
    for (const document of this.store.listReadyDocuments()) {
      if (selectedIds && !selectedIds.has(document.id)) continue;
      if (trackedDocumentIds.has(document.id)) continue;
      const group = byPerson.get(document.personId) ?? { documentIds: [], stage: 'extract' as const };
      group.documentIds.push(document.id);
      byPerson.set(document.personId, group);
    }
    if (!selectedIds) {
      // 旧报告直接复用已接纳事实，按成员刷新唯一的 V3 综合快照。
      for (const person of this.store.listPersons().filter((item) => item.archivedAt === null)) {
        if (byPerson.has(person.id)) continue;
        const observations = this.store.listAcceptedObservations(person.id);
        const sourceDocumentId = observations[0]?.documentId;
        if (!sourceDocumentId || activeDocumentIds.has(sourceDocumentId)) continue;
        const current = this.store.listMemberAssessmentSnapshots(person.id, true)[0];
        if (current?.promptVersion === MEMBER_ASSESSMENT_PROMPT_VERSION
          && current.rulesVersion === MEMBER_ASSESSMENT_RULES_VERSION
          && current.factRevision === this.store.getFactRevision(person.id)
          && current.contextRevision === this.store.getClinicalContextRevision(person.id)
          && current.reviewScopeSignature === this.store.getOpenReviewScopeSignature(person.id)) continue;
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
        ...promptMetaForStage(group.stage)
      })
    }));
    const consentId = options
      ? this.store.createManualProcessingConsent({
        documentIds: groups.flatMap((group) => group.documentIds),
        personIds: groups.map((group) => group.personId),
        historicalObservationIds: groups.flatMap((group) => this.store.listAcceptedObservations(group.personId).map((observation) => observation.id)),
        accountFingerprint: stableHash({ provider: 'codex-chatgpt', displayLabel: options.accountState.displayLabel }),
        version: options.consentVersion
      })
      : null;
    try {
      const created = this.store.createWaitingAuthBatch({
        cutoff: this.now().toISOString(),
        groups,
        initialStatus: options ? 'queued' : 'waiting_auth',
        consentId
      });
      return { batchId: created.batchId, idempotent: created.idempotent };
    } catch (error) {
      if (consentId) this.store.revokeConsent(consentId);
      throw error;
    }
  }

  async importFiles(files: Array<{ path: string; bytes: Uint8Array }>, personId: string | null, bindingId: string | null = null): Promise<ImportFilesReceipt> {
    const receipt: ImportFilesReceipt = {
      selectedCount: files.length,
      importedCount: 0,
      duplicateCount: 0,
      suppressedCount: 0,
      rejected: []
    };
    for (const file of files) {
      const displayName = basename(file.path);
      try {
        const detected = await detectInput(displayName, file.bytes);
        const sourceHash = createHash('sha256').update(detected.bytes).digest('hex');
        if (this.store.isSourceImportSuppressed(sourceHash)) {
          receipt.suppressedCount += 1;
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
          assignmentBasis: bindingId ? 'folder_binding' : 'user_selected'
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
          if (detected.kind === 'txt') {
            const decoded = decodeText(detected.bytes);
            this.store.saveSourceManifest(buildTextManifest({ ...common, text: decoded.text }));
          } else if (detected.kind === 'docx') {
            this.store.saveSourceManifest(await buildDocxManifest({ ...common, bytes: detected.bytes }));
          } else if (detected.kind === 'pdf') {
            this.store.saveSourceManifest(await buildPdfManifest({ ...common, bytes: detected.bytes }));
          } else if (detected.kind === 'heic') {
            this.store.saveSourceManifest(await buildHeicManifest({ ...common, mediaType: detected.mediaType, bytes: detected.bytes }));
          } else if (['jpeg', 'png'].includes(detected.kind)) {
            this.store.saveSourceManifest(buildImageManifest({ ...common, mediaType: detected.mediaType }));
          } else if (detected.kind === 'doc') {
            if (!this.legacyDocConverter) throw new Error('LEGACY_DOC_CONVERSION_REQUIRED');
            const converted = await this.legacyDocConverter.convert(detected.bytes);
            const convertedSource = this.store.putSourceObject({
              bytes: converted.bytes,
              mediaType: converted.mediaType,
              displayName: `${displayName}.converted.pdf`
            });
            this.store.registerDocumentConversion({
              documentId: document.documentId,
              convertedSourceObjectId: convertedSource.id,
              converterId: converted.converterId,
              converterVersion: converted.converterVersion,
              executableSha256: converted.executableSha256,
              warnings: ['legacy_doc_layout_may_differ_from_original']
            });
            const manifest = await buildPdfManifest({ ...common, bytes: converted.bytes });
            manifest.normalizerVersion = `${converted.converterId}-${converted.converterVersion}-pdf-v1`;
            manifest.conversionWarnings = [
              `converted_view:${converted.converterId}:${converted.converterVersion}`,
              'legacy_doc_layout_may_differ_from_original',
              ...manifest.conversionWarnings
            ];
            this.store.saveSourceManifest(manifest);
          } else {
            throw new Error('UNSUPPORTED_FORMAT');
          }
          receipt.importedCount += 1;
        } catch (error) {
          this.store.setDocumentStatus(document.documentId, 'blocked');
          throw error;
        }
      } catch (error) {
        receipt.rejected.push({
          displayName,
          code: error instanceof Error ? error.message : 'IMPORT_FAILED'
        });
      }
    }
    return receipt;
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
    // 主快照只承载每位成员最近的展示窗口；精确总数由 SQL 聚合读取，完整事实由成员级查询按需打开。
    // 这样家庭总览不会把全家数万条明细一次性传给 renderer。
    const conflictedDocumentIds = new Set(this.store.listOpenExtractionReviewIssues()
      .filter((issue) => issue.kind === 'person_conflict').map((issue) => issue.documentId));
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
    const allActions = this.store.listActionItems();
    const persons = storedPersons.filter((person) => person.archivedAt === null).map((person) => {
      const documentCount = counts.get(person.id) ?? 0;
      const pendingCount = imported.filter((document) => document.personId === person.id && document.status === 'queued' && !processingDocumentIds.has(document.id)).length;
      const processingCount = imported.filter((document) => document.personId === person.id && processingDocumentIds.has(document.id)).length;
      const stats = observationStats.get(person.id) ?? { acceptedFactCount: 0, attentionCount: 0, latestClinicalDate: null };
      const attentionCount = stats.attentionCount;
      const lastDocumentDate = stats.latestClinicalDate;
      const derived = latestDerivedByPerson.get(person.id);
      const assessment = this.getMemberAssessment(person.id);
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
        changeSummary: assessment?.overview.headline ?? (stats.acceptedFactCount > 0
          ? `最近处理已保存 ${stats.acceptedFactCount} 条报告事实；健康解释仍需单独生成和复核`
          : processingCount > 0 ? '资料已安全保存在本机，请到处理中心查看进度或恢复失败任务'
            : documentCount > 0 ? '资料已安全保存在本机，尚未形成健康结论' : '可以先添加一份体检或门诊资料'),
        derivedStatus: assessment ? 'current' as const : derived || v3HistoryPersonIds.has(person.id)
          ? 'stale' as const : 'unavailable' as const,
        assessmentSummary: assessment?.overview.summary ?? null,
        dataRevision: stableHash({
          factRevision: this.store.getFactRevision(person.id),
          clinicalContextRevision: person.clinicalContextRevision,
          displayRevision: person.displayRevision,
          derived: derived ? { id: derived.id, status: derived.status, createdAt: derived.createdAt } : null,
          memberAssessment: assessment ? { id: assessment.id, inputSignature: assessment.inputSignature } : null,
          systemAnalyses: systemAnalyses.map((analysis) => ({ id: analysis.id, status: analysis.status, generatedAt: analysis.generatedAt })),
          proposals: proposals.map((proposal) => ({ id: proposal.id, status: proposal.status, version: proposal.version, updatedAt: proposal.updatedAt })),
          actions: personActions.map((action) => ({ id: action.id, userRevision: action.userRevision, status: action.status }))
        }),
        displayRevision: person.displayRevision,
        clinicalContextRevision: person.clinicalContextRevision
      };
    });
    const transmissionStatuses = this.store.listDocumentAiTransmissionStatuses(imported.map((document) => document.id));
    const inbox = imported.map((document) => ({
      id: document.id,
      displayName: document.displayName,
      discoveredAt: document.discoveredAt,
      personId: document.personId,
      personLabel: document.personLabel,
      status: document.status,
      format: formatLabel(document.mediaType),
      sourceLabel: document.sourceLabel,
      sentToAi: transmissionStatuses.get(document.id) !== 'not_sent',
      aiTransmissionStatus: transmissionStatuses.get(document.id) ?? 'not_sent',
      inProcessingCenter: processingDocumentIds.has(document.id),
      issue: document.issue
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
    const extractionIssues = this.store.listOpenExtractionReviewIssues()
      .filter((issue) => issue.personId === null || activePersonIds.has(issue.personId));
    const extractionDocumentIds = new Set(extractionIssues.map((issue) => issue.documentId));
    const reviews = [
      ...assignmentReviews.filter((issue) => !extractionDocumentIds.has(issue.documentId)),
      ...extractionIssues.map((issue) => {
        const legacyFieldReview = issue.kind === 'field_conflict'
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
        return {
          id: issue.id,
          personId: issue.personId,
          documentId: issue.documentId,
          kind: issue.kind,
          severity: issue.severity,
          title: issue.kind === 'person_conflict'
            ? '确认报告姓名与成员身份'
            : legacyFieldReview ? '按新规则重新核对这份报告'
            : unverifiedIdentity ? '这份资料没有可确认的姓名'
            : issue.kind === 'field_conflict'
              ? evidenceOnlyReview
                ? `${differenceCount} 项原始依据还不够清楚`
                : mixedFieldReview
                  ? `发现 ${differenceCount} 项需要处理的内容`
                  : `发现 ${differenceCount} 项核心事实差异`
            : issue.kind === 'derived_safety' ? '健康说明未通过安全复核' : '资料覆盖需要人工确认',
          description: issue.kind === 'person_conflict'
            ? `报告写的是“${issue.reportedName ?? '未识别姓名'}”，当前准备归入已选成员。请确认两者是否为同一人。`
            : issue.kind === 'derived_safety'
            ? issue.reasonCodes.some((code) => code.startsWith('evidence_mismatch:'))
              ? '报告事实已经安全保存；这次生成的说明有内容缺少对应事实依据，因此没有发布。'
              : issue.reasonCodes.some((code) => code.startsWith('medical_boundary:') || code.startsWith('dosage_boundary:'))
                ? '报告事实已经安全保存；这次生成的说明可能被误解为诊断、处方或剂量建议，因此没有发布。'
                : '报告事实已经安全保存，但分析或生活指南包含需要人工核对的内容，因此没有发布这部分说明。'
            : legacyFieldReview
              ? '这项核对由旧版逐字段完全一致规则产生。重新核对后，只在核心事实真正冲突时再请你确认。'
              : unverifiedIdentity
                ? '系统无法从原始资料中确认姓名，也没有发现可验证的不同姓名。已手动归属或来自成员文件夹的资料会按当前成员继续处理。'
              : issue.kind === 'field_conflict'
                ? evidenceOnlyReview
                  ? '这些项目的数值未必有冲突，但原始依据还不足以安全入库。系统会先尝试重新核对。'
                  : mixedFieldReview
                    ? '只需修正有明确差异的项目；证据仍不清楚的单项可以先排除，不会卡住整份报告。'
                    : `两轮核对共有 ${issue.candidateOptions.length} 项候选，其中 ${differenceCount} 项核心字段不一致。只需核对下方差异项。`
                : '为避免把不确定内容写入健康档案，这份资料已暂停并等待你的核对。',
          evidenceRefs: issue.evidenceRefs,
          candidateOptions: issue.candidateOptions,
          candidateDiffs: issue.candidateDiffs,
          reportedName: issue.reportedName,
          reasonCodes: issue.reasonCodes,
          resolutionStatus: 'open' as const
        };
      })
    ];
    const storedJobs = this.store.listStoredJobs();
    const latestJobByDocument = new Map<string, string>();
    for (const job of storedJobs) {
      for (const documentId of job.documentIds) {
        if (!latestJobByDocument.has(documentId)) latestJobByDocument.set(documentId, job.id);
      }
    }
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
      openReviewCount: reviews.length,
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
        const superseded = job.documentIds.some((documentId) => latestJobByDocument.get(documentId) !== job.id);
        const { documentIds: _documentIds, ...summary } = job;
        return {
          ...summary,
          statusText: superseded ? '已有较新的处理任务，请使用上方任务继续' : job.statusText,
          canCancel: !superseded && ['queued', 'running', 'waiting_auth', 'waiting_quota', 'waiting_user', 'retry_wait'].includes(job.status)
            && job.statusText !== '正在安全停止',
          canRetry: !superseded && ['failed', 'completed_with_issues'].includes(job.status)
        };
      }),
      reviews,
      actions: this.store.listActionItems().filter((action) => activePersonIds.has(action.personId)),
      notes: this.store.listManualNotes().filter((note) => activePersonIds.has(note.personId)),
      privacyNotice: '资料已保存在本机个人工作区。只有在你连接 Codex 并明确授权范围后，必要内容才会发送给 OpenAI。',
      generatedAt: generatedAt.toISOString()
    });
  }
}
