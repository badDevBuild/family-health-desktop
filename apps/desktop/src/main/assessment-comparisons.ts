import type { HealthClaim, MemberAssessmentCandidateV3, MemberEvidenceRef } from '@contracts';

/** 使用模型已明确标出的主题和优先级，不靠病名或数值阈值推断新的健康问题。 */
export function assessmentPriorityTopicKeys(candidate: MemberAssessmentCandidateV3, includeOverview = true): string[] {
  const priorityIds = new Set([...candidate.overview.claimIds,
    ...candidate.actions.filter((action) => ['urgent', 'emergency'].includes(action.urgency)).flatMap((action) => action.claimIds)]);
  if (!includeOverview) {
    priorityIds.clear();
    candidate.actions.filter((action) => ['urgent', 'emergency'].includes(action.urgency))
      .flatMap((action) => action.claimIds).forEach((id) => priorityIds.add(id));
  }
  return [...new Set(candidate.claims.filter((claim) => claim.consequenceLevel !== 'routine' || priorityIds.has(claim.id))
    .map((claim) => claim.topicKey))];
}

/** 以生成时的重点为基线；本地重建摘要不能把全部常规记录升级为新的重点。 */
export function assessmentComparisonCoverage(candidate: MemberAssessmentCandidateV3, originalPriorityTopics?: readonly string[]) {
  const topics = new Map<string, HealthClaim[]>();
  for (const claim of candidate.claims) {
    const group = topics.get(claim.topicKey) ?? [];
    group.push(claim);
    topics.set(claim.topicKey, group);
  }
  const keys = originalPriorityTopics === undefined ? assessmentPriorityTopicKeys(candidate)
    : [...new Set([...originalPriorityTopics, ...assessmentPriorityTopicKeys(candidate, false)])];
  const priorityTopics = keys.map((key) => [key, topics.get(key) ?? []] as const);
  return { version: 1 as const, topicCount: priorityTopics.length,
    coveredTopicKeys: priorityTopics.filter(([, claims]) => claims.some((claim) => claim.changeAssessment)).map(([key]) => key),
    missingTopicKeys: priorityTopics.filter(([, claims]) => !claims.some((claim) => claim.changeAssessment)).map(([key]) => key) };
}

/** 有限补写只针对现有主题代表节点；不能凭质量检查增加医学事实或无限重跑。 */
export function findMissingAssessmentComparisons(candidate: MemberAssessmentCandidateV3): string[] {
  return assessmentComparisonCoverage(candidate).missingTopicKeys.map((key) => {
    const group = candidate.claims.filter((claim) => claim.topicKey === key);
    const representative = group.find((claim) => claim.kind === 'interpretation')
      ?? group.find((claim) => candidate.overview.claimIds.includes(claim.id)) ?? group[0]!;
    return `topic_comparison_missing:${representative.id}`;
  });
}

/** 只核对引用和角色，方向与医学可比性仍由模型结合完整来源判断并复核。 */
export function findInvalidAssessmentComparisons(candidate: MemberAssessmentCandidateV3,
  catalog: readonly MemberEvidenceRef[]): string[] {
  const known = new Map(catalog.map((ref) => [ref.id, ref]));
  return candidate.claims.flatMap((claim) => {
    const change = claim.changeAssessment;
    if (!change) return [];
    const issues: string[] = [];
    const personal = new Set([...claim.evidenceIds, ...claim.counterEvidenceIds]);
    for (const id of [...change.currentEvidenceIds, ...change.previousEvidenceIds]) {
      if (!known.has(id)) {
        // 主引用已由统一存在性校验覆盖，只补比较字段独有的外来引用。
        if (!personal.has(id)) issues.push(`unknown_evidence:${claim.id}:${id}`);
      }
      else if (!personal.has(id) || !['observation', 'user_note', 'clinical_finding', 'source_span'].includes(known.get(id)!.kind)) {
        issues.push(`comparison_evidence_scope:${claim.id}`);
      }
    }
    const location = (id: string) => known.get(id)?.observationId ?? known.get(id)?.sourceSpanId ?? id;
    const current = new Set(change.currentEvidenceIds.map(location));
    if (change.previousEvidenceIds.some((id) => current.has(location(id)))) issues.push(`comparison_same_record:${claim.id}`);
    if (['improving', 'worsening', 'stable', 'mixed'].includes(change.direction)
      && (change.previousEvidenceIds.length === 0 || change.basis === 'insufficient')) {
      issues.push(`comparison_history_required:${claim.id}`);
    }
    if (change.direction === 'first_record' && change.previousEvidenceIds.length > 0) issues.push(`comparison_first_record_conflict:${claim.id}`);
    return [...new Set(issues)];
  });
}
