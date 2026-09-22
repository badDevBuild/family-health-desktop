import type { BodySystemId, MemberAssessmentCandidateV3, MemberEvidencePackageV3 } from '@contracts';

type Fact = MemberEvidencePackageV3['facts'][number];

export interface AssessmentPartition {
  systemIds: BodySystemId[];
  evidencePackage: MemberEvidencePackageV3;
  basis: 'system' | 'document' | 'clinical_date' | 'fact_group';
  label: string;
  primaryObservationIds: string[];
  contextObservationIds: string[];
}

/** 跨系统背景只保留有明确来源提示的关键线索；共享事实仍沿用同一 observation/evidence ID。 */
function sharedClinicalSignal(fact: Fact): boolean {
  return ['high', 'low', 'positive'].includes(fact.reportedAbnormalFlag)
    || (fact.valueKind === 'text' && /诊断|考虑|疑似|恶性|肿瘤|结节|炎|医嘱|用药|手术|复查/.test(`${fact.originalName} ${fact.rawValue}`));
}

function filterEvidencePackage(
  source: MemberEvidencePackageV3,
  facts: Fact[],
  systemIds: BodySystemId[],
  partitionResults: MemberAssessmentCandidateV3[]
): MemberEvidencePackageV3 {
  const evidenceIds = new Set(facts.flatMap((fact) => fact.evidenceIds));
  const personalContext = source.personalContext.filter((note) =>
    systemIds.length === 0 || note.systemIds.length === 0 || note.systemIds.some((id) => systemIds.includes(id)));
  for (const note of personalContext) evidenceIds.add(note.evidenceId);
  const trends = source.trends.filter((trend) =>
    systemIds.length === 0 || trend.systemIds.some((id) => systemIds.includes(id)));
  const includedCriteria = source.criteriaSets.filter((set) => set.verifiedRequirements.every((requirement) =>
    requirement.evidenceIds.every((id) => evidenceIds.has(id))));
  return {
    ...source,
    facts,
    evidenceCatalog: source.evidenceCatalog.filter((item) => evidenceIds.has(item.id)),
    trends,
    personalContext,
    existingActions: source.existingActions.filter((action) =>
      systemIds.length === 0 || action.systemIds.length === 0 || action.systemIds.some((id) => systemIds.includes(id))),
    criteriaSets: includedCriteria,
    partitionResults
  };
}

/** 首次超限后按身体系统拆分，绝不按“最近 N 条”裁剪主分区的事实。 */
export function buildMemberSystemPartitions(
  source: MemberEvidencePackageV3,
  requestedSystemIds: BodySystemId[]
): AssessmentPartition[] {
  if (requestedSystemIds.length === 0) return [{
    systemIds: [], evidencePackage: filterEvidencePackage(source, source.facts, [], []),
    basis: 'fact_group', label: '尚未归入身体系统的来源事实',
    primaryObservationIds: source.facts.map((fact) => fact.observationId), contextObservationIds: []
  }];
  return requestedSystemIds.map((systemId, index) => {
    const primary = source.facts.filter((fact) => fact.systemIds.includes(systemId)
      || (index === 0 && !fact.systemIds.some((id) => requestedSystemIds.includes(id))));
    const primaryIds = new Set(primary.map((fact) => fact.observationId));
    const context = source.facts.filter((fact) => !primaryIds.has(fact.observationId) && sharedClinicalSignal(fact));
    const facts = [...primary, ...context];
    return {
      systemIds: [systemId],
      evidencePackage: filterEvidencePackage(source, facts, [systemId], []),
      basis: 'system', label: systemId,
      primaryObservationIds: primary.map((fact) => fact.observationId),
      contextObservationIds: context.map((fact) => fact.observationId)
    };
  });
}

/** 单分区仍超限时只细分该分区，优先保持报告或临床日期的上下文。 */
export function splitMemberPartition(partition: AssessmentPartition): AssessmentPartition[] | null {
  const facts = partition.evidencePackage.facts;
  if (facts.length < 2) return null;
  const byDocument = new Map<string, Fact[]>();
  for (const fact of facts) byDocument.set(fact.documentId, [...byDocument.get(fact.documentId) ?? [], fact]);
  const byDate = new Map<string, Fact[]>();
  for (const fact of facts) {
    const date = fact.clinicalDate ?? 'date-unknown';
    byDate.set(date, [...byDate.get(date) ?? [], fact]);
  }
  let groups: Fact[][];
  let basis: AssessmentPartition['basis'];
  if (byDocument.size > 1) {
    groups = [...byDocument.values()];
    basis = 'document';
  } else if (byDate.size > 1) {
    groups = [...byDate.values()];
    basis = 'clinical_date';
  } else {
    const middle = Math.ceil(facts.length / 2);
    groups = [facts.slice(0, middle), facts.slice(middle)];
    basis = 'fact_group';
  }
  return groups.map((group, index) => ({
    systemIds: partition.systemIds,
    evidencePackage: filterEvidencePackage(partition.evidencePackage, group, partition.systemIds, []),
    basis, label: `${partition.label} · ${index + 1}/${groups.length}`,
    primaryObservationIds: partition.primaryObservationIds.filter((id) => group.some((fact) => fact.observationId === id)),
    contextObservationIds: partition.contextObservationIds.filter((id) => group.some((fact) => fact.observationId === id))
  }));
}

/** 聚合保留全部分区结果、被引用的原子事实及跨系统关键反证，不把旧摘要当成个人事实。 */
export function buildMemberAggregatePackage(
  source: MemberEvidencePackageV3,
  results: MemberAssessmentCandidateV3[]
): MemberEvidencePackageV3 {
  const citedEvidenceIds = new Set(results.flatMap((result) => [
    ...result.claims.flatMap((claim) => [...claim.evidenceIds, ...claim.counterEvidenceIds]),
    ...result.actions.flatMap((action) => action.evidenceIds),
    ...result.questions.flatMap((question) => question.evidenceIds)
  ]));
  const criteriaEvidenceIds = new Set(source.criteriaSets.flatMap((set) =>
    set.verifiedRequirements.flatMap((requirement) => requirement.evidenceIds)));
  const facts = source.facts.filter((fact) => sharedClinicalSignal(fact)
    || fact.evidenceIds.some((id) => citedEvidenceIds.has(id) || criteriaEvidenceIds.has(id)));
  const directIds = new Set(facts.map((fact) => fact.observationId));
  const documentCounts = new Map<string, { totalFactCount: number; directFactCount: number }>();
  for (const fact of source.facts) {
    const counts = documentCounts.get(fact.documentId) ?? { totalFactCount: 0, directFactCount: 0 };
    counts.totalFactCount += 1;
    if (directIds.has(fact.observationId)) counts.directFactCount += 1;
    documentCounts.set(fact.documentId, counts);
  }
  const packageData = filterEvidencePackage(source, facts, [], results);
  const allCited = new Set([...citedEvidenceIds, ...packageData.evidenceCatalog.map((item) => item.id)]);
  return {
    ...packageData,
    evidenceCatalog: source.evidenceCatalog.filter((item) => allCited.has(item.id)),
    aggregateCoverage: {
      totalFactCount: source.facts.length,
      directFactCount: facts.length,
      summarizedOnlyFactCount: source.facts.length - facts.length,
      byDocument: [...documentCounts].map(([documentId, counts]) => ({ documentId, ...counts }))
    }
  };
}
