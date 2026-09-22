import type { AssessmentRequestV3, BodySystemId, MemberEvidencePackageV3, MemberEvidenceRef } from '@contracts';
import { assessmentRequestV3Schema, memberEvidencePackageV3Schema } from '@contracts';
import { bodySystemRegistry, stableHash } from '@core';
import type { WorkspaceStore } from '@storage';
import { buildSystemEvidenceBundle } from './system-evidence.js';
import { HEALTH_PIPELINE_VERSION, MEMBER_ASSESSMENT_PROMPT_VERSION, MEMBER_ASSESSMENT_RULES_VERSION, RUNTIME_PROMPT_VERSION } from './prompts/index.js';
import { ASSESSMENT_VALIDATION_RULES_VERSION } from './assessment-validation.js';
import { CLINICAL_ROUTER_VERSION } from './clinical-review-router.js';

export const MEMBER_EVIDENCE_SELECTOR_VERSION = 'member-evidence-v7';

export interface BuiltMemberAssessmentInput {
  request: AssessmentRequestV3;
  evidencePackage: MemberEvidencePackageV3;
  factRevision: number;
  contextRevision: number;
  reviewScopeSignature: string;
}

/** 全部聚合在本机完成；系统视角只选择输入，不产生额外模型调用。 */
export function buildMemberAssessmentInput(
  store: WorkspaceStore,
  personId: string,
  options: { modelId: string; reasoningEffort: string; analysisReferenceDate: string; webSearchAllowed: boolean }
): BuiltMemberAssessmentInput {
  const person = store.listPersons().find((item) => item.id === personId && item.archivedAt === null);
  if (!person) throw new Error('PERSON_NOT_FOUND');
  const observations = store.listAcceptedObservations(personId);
  const openIssues = store.listOpenExtractionReviewIssues().filter((issue) => issue.personId === personId);
  const identityConflictDocumentIds = new Set(openIssues
    .filter((issue) => issue.kind === 'person_conflict').map((issue) => issue.documentId));
  // 兼容旧规则曾接纳的空值观测：保留库中原记录，但不让它冒充可分析事实。
  const usableObservations = observations.filter((observation) => observation.valueKind !== 'unknown'
    && observation.rawText.trim().length > 0 && !identityConflictDocumentIds.has(observation.documentId));
  const usableObservationIds = new Set(usableObservations.map((observation) => observation.id));
  const skippedObservations = observations.filter((observation) => !identityConflictDocumentIds.has(observation.documentId)
    && !usableObservationIds.has(observation.id));
  const bundles = bodySystemRegistry.map((item) => buildSystemEvidenceBundle(store, personId, item.id, {
    modelId: options.modelId, excludedDocumentIds: identityConflictDocumentIds
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
    evidenceCatalog.push(...refs);
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
      reportedAbnormalFlag: observation.abnormalFlag,
      specimen: observation.specimen,
      method: observation.method,
      bodySite: observation.bodySite,
      documentId: observation.documentId,
      systemIds: [...systemsByObservation.get(observation.id) ?? []],
      evidenceIds: refs.map((item) => item.id),
      sourceKind: 'report' as const
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
  const existingActions = store.listActionItems(personId).map((action) => ({
    // 进度由本地覆盖层管理；从计划到完成不改变医学输入签名。
    // 明确“暂不采纳”才是需要尊重的内容偏好。
    id: action.id, title: action.title, detail: action.detail,
    status: action.status === 'dismissed' ? 'dismissed' : 'existing',
    systemIds: [...actionSystems.get(action.id) ?? []]
  }));
  const evidencePackage = memberEvidencePackageV3Schema.parse({
    identity: { personId, birthYear: person.birthYear, genderContext: person.genderContext, source: 'user_profile' },
    facts, evidenceCatalog: [...new Map(evidenceCatalog.map((item) => [item.id, item])).values()],
    trends: [...trendById.values()], personalContext, unresolvedScope, existingActions,
    knowledge: [...knowledgeById.values()], criteriaSets: [], partitionResults: []
  });
  const dates = facts.map((item) => item.clinicalDate).filter((value): value is string => value !== null).sort();
  const factRevision = store.getFactRevision(personId);
  const contextRevision = store.getClinicalContextRevision(personId);
  const reviewScopeSignature = store.getOpenReviewScopeSignature(personId);
  const inputSignature = stableHash({
    personId, selectorVersion: MEMBER_EVIDENCE_SELECTOR_VERSION,
    pipelineVersion: HEALTH_PIPELINE_VERSION, runtimePromptVersion: RUNTIME_PROMPT_VERSION,
    promptVersion: MEMBER_ASSESSMENT_PROMPT_VERSION, rulesVersion: MEMBER_ASSESSMENT_RULES_VERSION,
    validationRulesVersion: ASSESSMENT_VALIDATION_RULES_VERSION, clinicalRouterVersion: CLINICAL_ROUTER_VERSION,
    modelId: options.modelId, reasoningEffort: options.reasoningEffort,
    analysisReferenceDate: options.analysisReferenceDate, webSearchAllowed: options.webSearchAllowed,
    factRevision, contextRevision, reviewScopeSignature, evidencePackage
  });
  const request = assessmentRequestV3Schema.parse({
    personId, inputSignature, mode: 'full', requestedSystemIds,
    analysisReferenceDate: options.analysisReferenceDate,
    clinicalFrom: dates[0] ?? null, clinicalAsOf: dates.at(-1) ?? null,
    webSearchAllowed: options.webSearchAllowed
  });
  return { request, evidencePackage, factRevision, contextRevision, reviewScopeSignature };
}
