import type { AssessmentRequestV3, BodySystemId, MemberAssessmentCandidateV3, MemberEvidencePackageV3,
  MemberEvidenceRef } from '@contracts';
import { assessmentRequestV3Schema, clinicalContextSchema, memberEvidencePackageV3Schema } from '@contracts';
import { bodySystemRegistry, stableHash } from '@core';
import type { WorkspaceStore } from '@storage';
import { buildSystemEvidenceBundle } from './system-evidence.js';
import { HEALTH_PIPELINE_VERSION, MEMBER_ASSESSMENT_PROMPT_VERSION, MEMBER_ASSESSMENT_RULES_VERSION, RUNTIME_PROMPT_VERSION } from './prompts/index.js';
import { ASSESSMENT_VALIDATION_RULES_VERSION } from './assessment-validation.js';
import { CLINICAL_ROUTER_VERSION } from './clinical-review-router.js';
import { attachClinicalContextEvidence, hydrateCachedClinicalRecords, CLINICAL_RECORD_VERSION } from './clinical-record-preparation.js';
import { materializeWholeExcerptMemberCatalog } from './member-whole-excerpt-evidence.js';
import { bindAssessmentSourceInstructions } from './assessment-source-instructions.js';
import { EVENT_DATE_PROJECTION_VERSION, projectEventDate, readEventDateSources } from './event-date-projection.js';
import { withDocumentTimes, OBSERVATION_DATE_POLICY_VERSION } from './observation-date-presentation.js';

export const MEMBER_EVIDENCE_SELECTOR_VERSION = 'member-evidence-v10';

export interface BuiltMemberAssessmentInput {
  request: AssessmentRequestV3;
  evidencePackage: MemberEvidencePackageV3;
  /** 只供综合传输选择原有上下文；完整引用目录只用于本机核对和目标修复。 */
  analysisEvidenceCatalog: MemberEvidenceRef[];
  factRevision: number;
  contextRevision: number;
  reviewScopeSignature: string;
}

type AcceptedSourceInstructionFact = MemberEvidencePackageV3['facts'][number];

export interface AssessmentSourceInstructionReviewContext {
  actionId: string;
  observationId: string;
  clinicalDate: string | null;
  /** 本事实已有的报告时间背景；不等同于逐项检查日期或当前行动期限。 */
  sourceTime?: NonNullable<AcceptedSourceInstructionFact['sourceTime']>;
  effectiveTime?: NonNullable<AcceptedSourceInstructionFact['effectiveTime']>;
  rawValue: string;
  /** 已接纳的提取字段，不声称这些名称就是原件上的逐字标题。 */
  acceptedFactContext: {
    provenance: 'accepted_report_observation';
    originalName: string;
    specimen?: string;
    method?: string;
    bodySite?: string;
    clinicalContext?: NonNullable<AcceptedSourceInstructionFact['clinicalContext']>;
  };
}

/** 只带本事实确有来源的完整适用条件，不借别的观测、目录标题或知识补条件。 */
function sourceInstructionClinicalContext(
  fact: AcceptedSourceInstructionFact,
  referencesById: ReadonlyMap<string, readonly MemberEvidenceRef[]>
): NonNullable<AcceptedSourceInstructionFact['clinicalContext']> | undefined {
  const context = fact.clinicalContext;
  if (!context || context.conditions.length === 0 || !clinicalContextSchema.safeParse(context).success) return undefined;
  const allConditionsBound = context.conditions.every((condition) => fact.evidenceIds.some((id) => {
    const references = referencesById.get(id) ?? [];
    if (references.length !== 1) return false;
    const reference = references[0]!;
    return ['observation', 'clinical_finding', 'source_span'].includes(reference.kind)
      && reference.observationId === fact.observationId && reference.documentId === fact.documentId
      && reference.sourceSpanId === condition.sourceSpanId && reference.knowledgeId === null
      && Boolean(reference.quote?.includes(condition.quote));
  }));
  // 不能丢掉某一条件后仍把余下条件标成完整；任何一项未绑定时不投影这组条件。
  if (!allConditionsBound) return undefined;
  return { ...context, conditions: context.conditions.map((condition) => ({ ...condition })) };
}

/**
 * P04 的原医生安排只投影目标行动绑定的本成员事实，不重新查库、读全文或补日期。
 * 短原话的主题来自已接纳 originalName，而不是模型候选标题或文件名。
 */
export function buildAssessmentSourceInstructionReviewContext(
  candidate: MemberAssessmentCandidateV3,
  targetIds: readonly string[],
  evidencePackage: MemberEvidencePackageV3
): AssessmentSourceInstructionReviewContext[] {
  if (candidate.personId !== evidencePackage.identity.personId) return [];
  const targets = new Set(targetIds);
  const binding = bindAssessmentSourceInstructions(candidate, evidencePackage.facts, evidencePackage.evidenceCatalog);
  const referencesById = new Map<string, MemberEvidenceRef[]>();
  for (const reference of evidencePackage.evidenceCatalog) referencesById.set(reference.id,
    [...referencesById.get(reference.id) ?? [], reference]);
  return binding.boundActionIds.filter((id) => targets.has(id)).flatMap((actionId) => {
    const actions = candidate.actions.filter((action) => action.id === actionId);
    if (actions.length !== 1) return [];
    const fact = evidencePackage.facts.find((item) => item.observationId === actions[0]!.sourceInstructionObservationId)!;
    // 只复制已绑定目标事实已有、且通过原合同校验的时间结构，不从候选或其他事实补时间。
    const sourceTime = memberEvidencePackageV3Schema.shape.facts.element.shape.sourceTime.safeParse(fact.sourceTime);
    const effectiveTime = memberEvidencePackageV3Schema.shape.facts.element.shape.effectiveTime.safeParse(fact.effectiveTime);
    const clinicalContext = sourceInstructionClinicalContext(fact, referencesById);
    const acceptedFactContext: AssessmentSourceInstructionReviewContext['acceptedFactContext'] = {
      provenance: 'accepted_report_observation', originalName: fact.originalName
    };
    // 可选描述只保留紧凑的既有字段；超长内容不截断成另一段含义，也不扩成原报告。
    for (const field of ['specimen', 'method', 'bodySite'] as const) {
      const value = fact[field];
      if (value?.trim() && value.length <= 2_000) acceptedFactContext[field] = value;
    }
    if (clinicalContext) acceptedFactContext.clinicalContext = clinicalContext;
    return [{ actionId, observationId: fact.observationId, clinicalDate: fact.clinicalDate,
      ...(sourceTime.success && sourceTime.data ? { sourceTime: sourceTime.data } : {}),
      ...(effectiveTime.success && effectiveTime.data ? { effectiveTime: effectiveTime.data } : {}),
      rawValue: fact.rawValue, acceptedFactContext }];
  });
}

/** 全部聚合在本机完成；系统视角只选择输入，不产生额外模型调用。 */
export function buildMemberAssessmentInput(
  store: WorkspaceStore,
  personId: string,
  options: { modelId: string; reasoningEffort: string; analysisReferenceDate: string; webSearchAllowed: boolean }
): BuiltMemberAssessmentInput {
  const person = store.listPersons().find((item) => item.id === personId && item.archivedAt === null);
  if (!person) throw new Error('PERSON_NOT_FOUND');
  const observations = withDocumentTimes(store, personId, store.listAcceptedObservations(personId));
  const openIssues = store.listOpenExtractionReviewIssues().filter((issue) => issue.personId === personId);
  const identityConflictDocumentIds = new Set(openIssues
    // 隔离身份或本人保护冲突的整份资料，其他报告仍可综合；普通字段缺口不否定已接纳事实。
    .filter((issue) => issue.kind === 'person_conflict'
      || (issue.kind === 'overwrite_protected' && issue.severity === 'blocking'))
    .map((issue) => issue.documentId));
  // 兼容旧规则曾接纳的空值观测：保留库中原记录，但不让它冒充可分析事实。
  const usableObservations = observations.filter((observation) => observation.valueKind !== 'unknown'
    && observation.rawText.trim().length > 0 && !identityConflictDocumentIds.has(observation.documentId));
  const usableObservationIds = new Set(usableObservations.map((observation) => observation.id));
  const usableDocumentIds = new Set(usableObservations.map((observation) => observation.documentId));
  const sourceTimes = new Map(readEventDateSources(store, personId, store.listReportMetadata(personId)
    .filter((report) => usableDocumentIds.has(report.documentId))).map((source) => {
      const projected = projectEventDate([source], []);
      return [source.report.documentId, projected.hasExplicitRange ? null : projected.sourceTime] as const;
    }));
  const skippedObservations = observations.filter((observation) => !identityConflictDocumentIds.has(observation.documentId)
    && !usableObservationIds.has(observation.id));
  const bundles = bodySystemRegistry.map((item) => buildSystemEvidenceBundle(store, personId, item.id, {
    modelId: options.modelId, excludedDocumentIds: identityConflictDocumentIds, preparedObservations: observations
  }));
  const systemsByObservation = new Map<string, Set<BodySystemId>>();
  const evidenceByObservation = new Map<string, MemberEvidenceRef[]>();
  const noteSystems = new Map<string, Set<BodySystemId>>();
  const actionSystems = new Map<string, Set<BodySystemId>>();
  const trendById = new Map<string, MemberEvidencePackageV3['trends'][number]>();
  const knowledgeById = new Map<string, MemberEvidencePackageV3['knowledge'][number]>();
  const requestedSystemIds: BodySystemId[] = [];
  for (const bundle of bundles) {
    const systemId = bundle.identity.systemId;
    if (bundle.directFacts.some((fact) => usableObservationIds.has(fact.observationId)) || bundle.personalContext.some((note) =>
      !/全局背景|所有系统/.test(note.selectionReason))) requestedSystemIds.push(systemId);
    for (const fact of [...bundle.directFacts, ...bundle.contextFacts]) {
      if (!usableObservationIds.has(fact.observationId)) continue;
      const systems = systemsByObservation.get(fact.observationId) ?? new Set<BodySystemId>();
      systems.add(systemId);
      systemsByObservation.set(fact.observationId, systems);
      if (!evidenceByObservation.has(fact.observationId)) evidenceByObservation.set(fact.observationId, fact.evidenceSources);
    }
    for (const note of bundle.personalContext) {
      const systems = noteSystems.get(note.id) ?? new Set<BodySystemId>();
      systems.add(systemId);
      noteSystems.set(note.id, systems);
    }
    for (const action of bundle.existingActions) {
      const systems = actionSystems.get(action.id) ?? new Set<BodySystemId>();
      systems.add(systemId);
      actionSystems.set(action.id, systems);
    }
    for (const trend of bundle.trends) {
      const existing = trendById.get(trend.id);
      if (existing) existing.systemIds = [...new Set([...existing.systemIds, systemId])];
      else trendById.set(trend.id, { id: trend.id, systemIds: [systemId], payload: trend });
    }
    for (const knowledge of bundle.knowledge) knowledgeById.set(knowledge.id, knowledge);
  }
  const evidenceCatalog: MemberEvidenceRef[] = [];
  const facts: MemberEvidencePackageV3['facts'] = usableObservations.map((observation) => {
    const refs = evidenceByObservation.get(observation.id) ?? observation.evidence.map((item, index): MemberEvidenceRef => ({
      id: `evidence-${observation.id}-${item.sourceSpanId}-${index}`,
      kind: 'observation', observationId: observation.id, eventId: observation.eventId,
      documentId: observation.documentId, sourceSpanId: item.sourceSpanId, knowledgeId: null,
      label: observation.sourceLabel, locator: null, quote: item.quote
    }));
    if (refs.length === 0) refs.push({
      id: `evidence-${observation.id}-${observation.sourceSpanId}-primary`,
      kind: 'observation', observationId: observation.id, eventId: observation.eventId,
      documentId: observation.documentId, sourceSpanId: observation.sourceSpanId, knowledgeId: null,
      label: observation.sourceLabel, locator: null, quote: observation.sourceQuote
    });
    // 未映射到身体系统的事实也须把记录时间的真实出处带入复核目录。
    for (const ref of observation.effectiveTimeEvidence ?? []) {
      if (!refs.some(item => item.sourceSpanId === ref.sourceSpanId && item.quote === ref.quote)) refs.push({
        id: `evidence-${observation.id}-${ref.sourceSpanId}-recorded-time`, kind: 'observation',
        observationId: observation.id, eventId: observation.eventId, documentId: observation.documentId,
        sourceSpanId: ref.sourceSpanId, knowledgeId: null, label: observation.sourceLabel,
        locator: observation.effectiveTime?.displayLabel ?? null, quote: ref.quote
      });
    }
    evidenceCatalog.push(...refs);
    const sourceTime = observation.clinicalDate === null ? sourceTimes.get(observation.documentId) : null;
    return {
      observationId: observation.id,
      originalName: observation.originalName,
      modelStandardNameCandidate: observation.modelStandardNameCandidate,
      rawValue: observation.rawText,
      valueKind: observation.valueKind,
      qualifier: observation.qualifier,
      unit: observation.unit,
      referenceRange: observation.referenceRange,
      clinicalDate: observation.clinicalDate,
      ...(observation.effectiveTime && observation.effectiveTimeEvidence?.length ? {
        effectiveTime: { ...observation.effectiveTime, evidence: observation.effectiveTimeEvidence }
      } : {}),
      // 仅供理解本报告所属时期；逐项临床日期未知仍为 null，历史事实沿用自身日期。
      ...(sourceTime && sourceTime.evidence.length > 0 ? { sourceTime: {
        scope: 'document' as const, value: sourceTime.value, precision: sourceTime.precision,
        basis: sourceTime.basis, role: sourceTime.role,
        evidence: sourceTime.evidence.map(({ sourceSpanId, quote }) => ({ sourceSpanId, quote }))
      } } : {}),
      reportedAbnormalFlag: observation.abnormalFlag,
      specimen: observation.specimen,
      method: observation.method,
      bodySite: observation.bodySite,
      documentId: observation.documentId,
      systemIds: [...systemsByObservation.get(observation.id) ?? []],
      evidenceIds: refs.map((item) => item.id),
      sourceKind: 'report' as const,
      clinicalContext: observation.clinicalContext ?? null
    };
  });
  const personalContext = store.listManualNotes(personId).map((note) => {
    const evidenceId = `note-evidence-${note.id}`;
    evidenceCatalog.push({
      id: evidenceId, kind: 'user_note', observationId: null, eventId: null, documentId: null,
      sourceSpanId: null, knowledgeId: null, label: '本人补充', locator: note.effectiveDate,
      quote: note.immutableText
    });
    return {
      id: note.id, kind: note.kind, text: note.immutableText, effectiveDate: note.effectiveDate,
      recordedAt: note.recordedAt, systemIds: [...noteSystems.get(note.id) ?? []],
      evidenceId, sourceKind: 'user_reported' as const
    };
  });
  const unresolvedScope: MemberEvidencePackageV3['unresolvedScope'] = openIssues.map((issue) => ({
      documentId: issue.documentId,
      reasonCodes: issue.reasonCodes.length ? issue.reasonCodes : [issue.kind],
      // 身份冲突资料可能属于另一成员，综合只需要知道有缺口，不发送其项目名称。
      affectedItemNames: issue.kind === 'person_conflict' ? []
        : [...new Set(issue.candidateOptions.map((candidate) => candidate.originalName.trim())
          .filter(Boolean).map((name) => name.slice(0, 80)))].slice(0, 12),
      potentialImpact: issue.kind === 'person_conflict'
        ? '成员归属未确认；这部分资料不能归入当前成员。'
        : '相关检查结果未确认；不能把未解析的项目当成正常、阴性或不存在。'
    }));
  for (const observation of skippedObservations) {
    const existing = unresolvedScope.find((scope) => scope.documentId === observation.documentId);
    if (existing) {
      existing.reasonCodes = [...new Set([...existing.reasonCodes, 'LEGACY_VALUE_UNKNOWN'])];
      existing.affectedItemNames = [...new Set([...(existing.affectedItemNames ?? []), observation.originalName])];
    } else unresolvedScope.push({ documentId: observation.documentId, reasonCodes: ['LEGACY_VALUE_UNKNOWN'],
      affectedItemNames: [observation.originalName],
      potentialImpact: '这条旧记录没有可用结果；不能据此判断该检查正常、异常或不存在。' });
  }
  const unmappedDocuments = new Set(facts.filter((fact) => fact.systemIds.length === 0).map((fact) => fact.documentId));
  for (const documentId of unmappedDocuments) {
    const existing = unresolvedScope.find((scope) => scope.documentId === documentId);
    if (existing) {
      existing.reasonCodes = [...new Set([...existing.reasonCodes, 'FACT_SYSTEM_UNMAPPED'])];
      existing.affectedItemNames = [...new Set([...(existing.affectedItemNames ?? []),
        ...facts.filter((fact) => fact.documentId === documentId && fact.systemIds.length === 0)
          .map((fact) => fact.originalName)])].slice(0, 12);
      existing.potentialImpact = `${existing.potentialImpact ?? ''} 相关结果虽已保存，但系统视图可能暂未收录。`.trim();
    }
    else unresolvedScope.push({ documentId, reasonCodes: ['FACT_SYSTEM_UNMAPPED'],
      affectedItemNames: facts.filter((fact) => fact.documentId === documentId && fact.systemIds.length === 0)
        .map((fact) => fact.originalName).slice(0, 12),
      potentialImpact: '相关结果已保存，但尚未归入身体系统；不能从系统视图缺席推断检查结果不存在。' });
  }
  const adoptedSources = new Map(store.listAdoptedMemberAssessmentActions(personId)
    .map((source) => [source.action.id, source]));
  const currentDocumentIds = new Set(usableObservations.map((fact) => fact.documentId));
  const existingActions = store.listActionItems(personId).map((action) => {
    const source = adoptedSources.get(action.id);
    return {
      // 进度由本地覆盖层管理；从计划到完成不改变医学输入签名。
      // 明确“暂不采纳”才是需要尊重的内容偏好。
      id: action.id, title: action.title, detail: action.detail,
      status: action.status === 'dismissed' ? 'dismissed' : 'existing',
      systemIds: [...actionSystems.get(action.id) ?? []],
      origin: action.origin, dueDate: action.dueDate, dueText: action.dueText,
      userScheduleText: action.userScheduleText ?? null,
      evidenceLabel: action.evidenceLabel,
      ...(source ? { sourceDate: source.sourceDate, sourceAssessmentId: source.sourceAssessmentId,
        sourceActionId: source.sourceActionId,
        // 已排除或身份待确认的原文不能借已采纳行动绕回本次模型输入。
        evidenceRefs: source.evidenceRefs.filter((ref) => ref.documentId === null || currentDocumentIds.has(ref.documentId)) } : {})
    };
  });
  const evidencePackage = memberEvidencePackageV3Schema.parse({
    identity: { personId, birthYear: person.birthYear, genderContext: person.genderContext, source: 'user_profile' },
    facts, evidenceCatalog: [...new Map(evidenceCatalog.map((item) => [item.id, item])).values()],
    trends: [...trendById.values()], personalContext, unresolvedScope, existingActions,
    knowledge: [...knowledgeById.values()], criteriaSets: [], partitionResults: []
  });
  const dates = facts.map((item) => item.clinicalDate ?? (item.effectiveTime?.precision === 'day' ? item.effectiveTime.value : null))
    .filter((value): value is string => value !== null).sort();
  hydrateCachedClinicalRecords(store, personId, evidencePackage);
  attachClinicalContextEvidence(evidencePackage);
  const analysisEvidenceCatalog = [...evidencePackage.evidenceCatalog];
  // 只补本机目录中的整段引用，不能把新全文副本注入原有趋势或传输包装。
  evidencePackage.evidenceCatalog = materializeWholeExcerptMemberCatalog(store, personId,
    usableObservations, evidencePackage.evidenceCatalog);
  const factRevision = store.getFactRevision(personId);
  const contextRevision = store.getClinicalContextRevision(personId);
  const reviewScopeSignature = store.getOpenReviewScopeSignature(personId);
  const inputSignature = stableHash({
    personId, selectorVersion: MEMBER_EVIDENCE_SELECTOR_VERSION, clinicalRecordVersion: CLINICAL_RECORD_VERSION,
    eventDateProjectionVersion: EVENT_DATE_PROJECTION_VERSION,
    observationDatePolicyVersion: OBSERVATION_DATE_POLICY_VERSION,
    pipelineVersion: HEALTH_PIPELINE_VERSION, runtimePromptVersion: RUNTIME_PROMPT_VERSION,
    promptVersion: MEMBER_ASSESSMENT_PROMPT_VERSION, rulesVersion: MEMBER_ASSESSMENT_RULES_VERSION,
    validationRulesVersion: ASSESSMENT_VALIDATION_RULES_VERSION, clinicalRouterVersion: CLINICAL_ROUTER_VERSION,
    modelId: options.modelId, reasoningEffort: options.reasoningEffort,
    analysisReferenceDate: options.analysisReferenceDate, webSearchAllowed: options.webSearchAllowed,
    factRevision, contextRevision, reviewScopeSignature, evidencePackage, analysisEvidenceCatalog
  });
  const request = assessmentRequestV3Schema.parse({
    personId, inputSignature, mode: 'full', requestedSystemIds,
    analysisReferenceDate: options.analysisReferenceDate,
    clinicalFrom: dates[0] ?? null, clinicalAsOf: dates.at(-1) ?? null,
    webSearchAllowed: options.webSearchAllowed
  });
  return { request, evidencePackage, analysisEvidenceCatalog, factRevision, contextRevision, reviewScopeSignature };
}
