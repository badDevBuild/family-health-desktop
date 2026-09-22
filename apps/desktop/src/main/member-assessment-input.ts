import type { AssessmentRequestV3, BodySystemId, MemberEvidencePackageV3, MemberEvidenceRef } from '@contracts';
import { assessmentRequestV3Schema, memberEvidencePackageV3Schema } from '@contracts';
import { bodySystemRegistry, stableHash } from '@core';
import type { WorkspaceStore } from '@storage';
import { buildSystemEvidenceBundle } from './system-evidence.js';
import { MEMBER_ASSESSMENT_PROMPT_VERSION } from './prompts/index.js';

export const MEMBER_EVIDENCE_SELECTOR_VERSION = 'member-evidence-v3';

export interface BuiltMemberAssessmentInput {
  request: AssessmentRequestV3;
  evidencePackage: MemberEvidencePackageV3;
  factRevision: number;
  contextRevision: number;
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
  const bundles = bodySystemRegistry.map((item) => buildSystemEvidenceBundle(store, personId, item.id, { modelId: options.modelId }));
  const systemsByObservation = new Map<string, Set<BodySystemId>>();
  const evidenceByObservation = new Map<string, MemberEvidenceRef[]>();
  const noteSystems = new Map<string, Set<BodySystemId>>();
  const actionSystems = new Map<string, Set<BodySystemId>>();
  const trendById = new Map<string, MemberEvidencePackageV3['trends'][number]>();
  const knowledgeById = new Map<string, MemberEvidencePackageV3['knowledge'][number]>();
  const requestedSystemIds: BodySystemId[] = [];
  for (const bundle of bundles) {
    const systemId = bundle.identity.systemId;
    if (bundle.directFacts.length > 0 || bundle.personalContext.some((note) =>
      !/全局背景|所有系统/.test(note.selectionReason))) requestedSystemIds.push(systemId);
    for (const fact of [...bundle.directFacts, ...bundle.contextFacts]) {
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
  const facts: MemberEvidencePackageV3['facts'] = observations.map((observation) => {
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
  const unresolvedScope = store.listOpenExtractionReviewIssues()
    .filter((issue) => issue.personId === personId)
    .map((issue) => ({ documentId: issue.documentId, reasonCodes: issue.reasonCodes.length ? issue.reasonCodes : [issue.kind] }));
  const existingActions = store.listActionItems(personId).map((action) => ({
    id: action.id, title: action.title, detail: action.detail, status: action.status,
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
  const inputSignature = stableHash({
    personId, selectorVersion: MEMBER_EVIDENCE_SELECTOR_VERSION,
    promptVersion: MEMBER_ASSESSMENT_PROMPT_VERSION, modelId: options.modelId, reasoningEffort: options.reasoningEffort,
    analysisReferenceDate: options.analysisReferenceDate, factRevision, contextRevision, evidencePackage
  });
  const request = assessmentRequestV3Schema.parse({
    personId, inputSignature, mode: 'full', requestedSystemIds,
    analysisReferenceDate: options.analysisReferenceDate,
    clinicalFrom: dates[0] ?? null, clinicalAsOf: dates.at(-1) ?? null,
    webSearchAllowed: options.webSearchAllowed
  });
  return { request, evidencePackage, factRevision, contextRevision };
}
