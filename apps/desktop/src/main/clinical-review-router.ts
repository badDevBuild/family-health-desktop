import type {
  ClinicalFocusedReviewV1, HealthAction, HealthClaim, MemberAssessmentCandidateV3,
  OverviewNode, QuestionNode, SystemNode
} from '@contracts';

export const CLINICAL_ROUTER_VERSION = 'clinical-router-v1';

const highConsequenceDisease = /(?:恶性肿瘤|癌症|癌变|心肌梗死|脑卒中|脑出血|败血症|脓毒症|急性肾衰|肝衰竭|器官衰竭)/i;
const nonAffirmative = /(?:排除|待排|未见|无|尚不能|不能确诊|既往|家族史)/i;

export interface FocusedReviewRoute {
  targetIds: string[];
  reasons: string[];
}

/** 路由是漏标补查，不是用病名正则作疾病诊断或自动否决。 */
export function routeFocusedReview(candidate: MemberAssessmentCandidateV3): FocusedReviewRoute {
  const targets = new Set<string>();
  const reasons: string[] = [];
  for (const claim of candidate.claims) {
    const novel = claim.diagnosticStatus !== 'documented' && claim.kind === 'diagnostic_assessment';
    const highConsequence = novel && highConsequenceDisease.test(`${claim.diseaseName ?? ''} ${claim.text}`)
      && !nonAffirmative.test(claim.text);
    if (claim.consequenceLevel !== 'high' && !highConsequence) continue;
    targets.add(claim.id);
    reasons.push(highConsequence ? `high_consequence_disease:${claim.id}` : `reported_high_consequence:${claim.id}`);
    for (const action of candidate.actions.filter((item) => item.claimIds.includes(claim.id))) targets.add(action.id);
    for (const system of candidate.systems.filter((item) => item.claimIds.includes(claim.id))) targets.add(system.id);
    if (candidate.overview.claimIds.includes(claim.id)) targets.add('overview');
  }
  for (const action of candidate.actions) {
    if (action.urgency === 'emergency' || action.kind === 'treatment_discussion' && /(?:停药|加量|减量|换药)/.test(action.firstStep)) {
      targets.add(action.id);
      reasons.push(`high_impact_action:${action.id}`);
      for (const system of candidate.systems.filter((item) => item.actionIds.includes(action.id))) targets.add(system.id);
      if (candidate.overview.actionIds.includes(action.id)) targets.add('overview');
    }
  }
  return { targetIds: [...targets], reasons: [...new Set(reasons)] };
}

type Node = HealthClaim | HealthAction | OverviewNode | SystemNode | QuestionNode;
type NodeType = 'claim' | 'action' | 'overview' | 'system' | 'question';

export function applyFocusedReview(
  candidate: MemberAssessmentCandidateV3,
  review: ClinicalFocusedReviewV1,
  targetIds: string[]
): { candidate: MemberAssessmentCandidateV3; heldTargetIds: string[] } {
  if (review.personId !== candidate.personId || review.inputSignature !== candidate.inputSignature) {
    throw new Error('FOCUSED_REVIEW_SCOPE_MISMATCH');
  }
  const expected = new Set(targetIds);
  if (review.results.length !== expected.size || new Set(review.results.map((item) => item.targetId)).size !== expected.size
    || review.results.some((item) => !expected.has(item.targetId))) throw new Error('FOCUSED_REVIEW_COVERAGE_MISMATCH');
  const byId = new Map<string, { type: NodeType; value: Node }>([
    ['overview', { type: 'overview', value: candidate.overview }],
    ...candidate.systems.map((item): [string, { type: NodeType; value: Node }] => [item.id, { type: 'system', value: item }]),
    ...candidate.claims.map((item): [string, { type: NodeType; value: Node }] => [item.id, { type: 'claim', value: item }]),
    ...candidate.actions.map((item): [string, { type: NodeType; value: Node }] => [item.id, { type: 'action', value: item }]),
    ...candidate.questions.map((item): [string, { type: NodeType; value: Node }] => [item.id, { type: 'question', value: item }])
  ]);
  const held = new Set<string>();
  for (const result of review.results) {
    const original = byId.get(result.targetId);
    if (!original) throw new Error('FOCUSED_REVIEW_TARGET_UNKNOWN');
    if (result.verdict === 'pass') {
      if (result.replacement !== null) throw new Error('FOCUSED_REVIEW_UNEXPECTED_REPLACEMENT');
      continue;
    }
    if (result.verdict === 'hold') {
      if (result.replacement !== null) throw new Error('FOCUSED_REVIEW_UNEXPECTED_REPLACEMENT');
      held.add(result.targetId);
      continue;
    }
    if (result.replacement?.nodeType !== original.type || result.replacement.value.id !== result.targetId) {
      throw new Error('FOCUSED_REVIEW_REPLACEMENT_SCOPE_MISMATCH');
    }
    byId.set(result.targetId, { type: original.type, value: result.replacement.value });
  }
  const heldClaims = new Set(candidate.claims.filter((item) => held.has(item.id)).map((item) => item.id));
  const heldActions = new Set(candidate.actions.filter((item) => held.has(item.id)
    || (byId.get(item.id)!.value as HealthAction).claimIds.some((id) => heldClaims.has(id))).map((item) => item.id));
  for (const id of heldActions) held.add(id);
  const claims = candidate.claims.filter((item) => !heldClaims.has(item.id)).map((item) => byId.get(item.id)!.value as HealthClaim);
  const actions = candidate.actions.filter((item) => !heldActions.has(item.id)).map((item) => byId.get(item.id)!.value as HealthAction);
  const systems = candidate.systems.map((item) => {
    const node = byId.get(item.id)!.value as SystemNode;
    const claimIds = node.claimIds.filter((id) => !heldClaims.has(id));
    const actionIds = node.actionIds.filter((id) => !heldActions.has(id));
    const dependent = held.has(item.id) || node.claimIds.length !== claimIds.length || node.actionIds.length !== actionIds.length;
    return dependent ? {
      ...node, claimIds, actionIds,
      // 原状态可能只由被隔离的高影响主张支撑，不能沿用“需关注”或“本范围无提示”。
      status: claimIds.length === 0 ? 'insufficient' as const : 'monitor' as const,
      headline: claimIds.length === 0 ? '这部分判断仍需核实' : '部分判断仍需核实',
      summary: '已核实的资料仍可查看；本系统有重要判断暂未纳入本次解读。',
      limitations: [...node.limitations, '部分判断因证据不足暂未发布。']
    } : node;
  });
  const originalOverview = byId.get('overview')!.value as OverviewNode;
  const overviewChanged = held.has('overview') || originalOverview.claimIds.some((id) => heldClaims.has(id))
    || originalOverview.actionIds.some((id) => heldActions.has(id));
  const overview = overviewChanged ? {
    ...originalOverview,
    headline: '部分健康判断仍需核实',
    summary: '已核实的资料和行动仍可查看；有重要判断暂未纳入本次总览。',
    claimIds: originalOverview.claimIds.filter((id) => !heldClaims.has(id)),
    actionIds: originalOverview.actionIds.filter((id) => !heldActions.has(id)),
    limitations: [...originalOverview.limitations, '部分判断因证据不足暂未发布。']
  } : originalOverview;
  const questions = candidate.questions.filter((item) => !held.has(item.id)
    && !(byId.get(item.id)!.value as QuestionNode).relatedClaimIds.some((id) => heldClaims.has(id))).map((item) => {
    const node = byId.get(item.id)!.value as QuestionNode;
    return node;
  });
  return { candidate: { ...candidate, overview, systems, claims, actions, questions }, heldTargetIds: [...held] };
}
