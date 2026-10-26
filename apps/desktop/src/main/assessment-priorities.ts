import { assessmentChangeLabel, healthClaimTitle, type HealthAction, type HealthClaim, type MemberAssessmentSnapshotV3, type MemberOverviewV2 } from '@contracts';

type PrioritySource = Pick<MemberAssessmentSnapshotV3, 'claims' | 'actions' | 'overview'>
  & Partial<Pick<MemberAssessmentSnapshotV3, 'systems' | 'limitations'>>;
type RankedClaim = { claim: HealthClaim; index: number; overviewIndex: number; urgentRank: number };

const urgentRank = (action: HealthAction): number => action.urgency === 'emergency' ? 2 : action.urgency === 'urgent' ? 1 : 0;

function compareClaims(left: RankedClaim, right: RankedClaim): number {
  return right.urgentRank - left.urgentRank
    || Number(right.claim.consequenceLevel === 'high') - Number(left.claim.consequenceLevel === 'high')
    || left.overviewIndex - right.overviewIndex
    || left.index - right.index;
}

function explain(claim: HealthClaim): string {
  const change = claim.changeAssessment;
  return [...new Set([claim.text,
    ...(change ? [`${assessmentChangeLabel(change.direction)}：${change.summary}`, change.reason] : []),
    claim.materialUncertainty].filter(Boolean))].join(' ');
}

/**
 * 输入已经经过展示边界检查。只按明确的主题键组织入口，不猜测旧键、病名、器官或共同医嘱。
 * 同组正文和不同的下一步完整保留；首屏折叠数量由界面决定，不能在读模型截掉高影响事项。
 */
export function buildAssessmentPriorities(snapshot: PrioritySource): MemberOverviewV2['priorityIssues'] {
  const overviewOrder = new Map<string, number>();
  snapshot.overview.claimIds.forEach((id, index) => {
    if (!overviewOrder.has(id)) overviewOrder.set(id, index);
  });
  const groups = new Map<string, RankedClaim[]>();
  snapshot.claims.forEach((claim, index) => {
    // 保持现有可导航边界；尚无系统归属的内容仍由成员总述和完整正文承载。
    if (claim.systemIds.length === 0) return;
    const linkedActions = snapshot.actions.filter((action) => action.claimIds.includes(claim.id));
    const ranked: RankedClaim = { claim, index, overviewIndex: overviewOrder.get(claim.id) ?? Number.MAX_SAFE_INTEGER,
      urgentRank: linkedActions.reduce((rank, action) => Math.max(rank, urgentRank(action)), 0) };
    const group = groups.get(claim.topicKey) ?? [];
    group.push(ranked);
    groups.set(claim.topicKey, group);
  });

  return [...groups.values()].flatMap((group) => {
    const eligible = group.filter(({ claim, urgentRank: rank }) => claim.consequenceLevel !== 'routine' || rank > 0)
      .sort(compareClaims);
    const lead = eligible[0];
    if (!lead) return [];
    const groupIds = new Set(group.map(({ claim }) => claim.id));
    const actions = snapshot.actions.map((action, index) => ({ action, index }))
      .filter(({ action }) => action.claimIds.some((id) => groupIds.has(id)))
      .sort((left, right) => urgentRank(right.action) - urgentRank(left.action)
        || Number(right.action.claimIds.includes(lead.claim.id)) - Number(left.action.claimIds.includes(lead.claim.id))
        || left.index - right.index);
    // 不做语义去重，也不剥掉日期、条件或否定；相同下一步的完整行动仍各自保留。
    const nextSteps = [...new Set(actions.map(({ action }) => action.firstStep).filter((step) => step.trim()))];
    const primarySystems = snapshot.systems?.filter((system) => system.systemId === lead.claim.systemIds[0]);
    const primarySystem = primarySystems?.length === 1 ? primarySystems[0] : undefined;
    // 只有完整已发布系统上下文可得时，才允许界面在长总述收起时展示解释；不能漏掉适用条件。
    const readingContext = primarySystem && snapshot.limitations !== undefined ? [...new Set([
      lead.claim.rationale, ...primarySystem.limitations, ...snapshot.overview.limitations, ...snapshot.limitations
    ].filter((value) => value.trim()))] : undefined;
    return [{ lead, issue: {
      id: lead.claim.id, title: healthClaimTitle(lead.claim), explanation: explain(lead.claim),
      nextStep: nextSteps[0] ?? null, systemId: lead.claim.systemIds[0]!,
      ...(readingContext !== undefined ? { readingContext } : {}),
      relatedExplanations: group.filter(({ claim }) => claim.id !== lead.claim.id).sort(compareClaims)
        .map(({ claim }) => ({ id: claim.id, title: healthClaimTitle(claim), explanation: explain(claim), systemId: claim.systemIds[0]! })),
      additionalNextSteps: nextSteps.slice(1),
      isHighPriority: group.some(({ claim, urgentRank: rank }) => claim.consequenceLevel === 'high' || rank > 0)
    } }];
  }).sort((left, right) => compareClaims(left.lead, right.lead)).map(({ issue }) => issue);
}
