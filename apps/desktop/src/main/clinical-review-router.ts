import type {
  ClinicalFocusedReviewV1, HealthAction, HealthClaim, MemberAssessmentCandidateV3,
  OverviewNode, QuestionNode, SystemNode
} from '@contracts';
import {
  hasDirectMedicationChange, hasHighConsequenceNodeAssertion,
  hasNovelHighConsequenceClaimAssertion, hasNumericSupplementDose, visibleAssessmentTextFields
} from './assessment-validation.js';
import { presentAssessmentText } from './assessment-content-quality.js';
import { retainedAssessmentNarrative, retainedOverviewNarrative } from './assessment-presentation.js';
import { hasSubstantiveActionRewrite } from './assessment-independent-habit-repair.js';

export const CLINICAL_ROUTER_VERSION = 'clinical-router-v9';

const highConsequenceDisease = /(?:恶性肿瘤|恶性淋巴瘤|癌症|癌变|[\p{Script=Han}]{1,8}癌|心肌梗死|急性冠脉综合征|主动脉夹层|肺栓塞|脑卒中|脑梗死|脑出血|败血症|脓毒症|急性肾衰|急性肾损伤|肝衰竭|器官衰竭)/iu;
const directlyNegatedDisease = /(?:已排除|明确排除|未见|无|不支持|未确诊|不能确诊|尚不能确诊)\s*$/i;

function onlyDirectlyNegatedDiseaseMentions(claim: HealthClaim): boolean {
  const disease = claim.diseaseName;
  if (!disease) return false;
  // 另一个高后果病名即使与当前 diseaseName 同处一句，也不能被此病名的否定吞掉。
  const texts = visibleAssessmentTextFields(claim).filter(({ field }) => field !== 'diseaseName').map(({ text }) => text);
  if (texts.some((text) => highConsequenceDisease.test(text.replaceAll(disease, '')))) return false;
  const clauses = texts.flatMap((text) => text.split(/[。；;！？!?\n]/)).filter((clause) => clause.includes(disease));
  if (clauses.length === 0) return false;
  for (const clause of clauses) {
    let position = clause.indexOf(disease);
    while (position >= 0) {
      const prefix = clause.slice(Math.max(0, position - 16), position);
      // “无症状、但考虑 X”与“不能排除 X”都不是对 X 的明确否定。
      if (!directlyNegatedDisease.test(prefix) || /(?:不能|尚不能|无法)排除\s*$/i.test(prefix)) return false;
      position = clause.indexOf(disease, position + disease.length);
    }
  }
  return true;
}

export interface FocusedReviewRoute {
  targetIds: string[];
  reasons: string[];
}

/** 路由覆盖高影响内容与问句前提，不用病名正则作疾病诊断或自动否决。 */
export function routeFocusedReview(candidate: MemberAssessmentCandidateV3): FocusedReviewRoute {
  const targets = new Set<string>();
  const reasons: string[] = [];
  for (const claim of candidate.claims) {
    const novel = claim.diagnosticStatus !== 'documented';
    const highConsequence = novel && (claim.kind === 'diagnostic_assessment' && claim.diagnosticStatus !== null
      && highConsequenceDisease.test(`${claim.diseaseName ?? ''} ${claim.text}`)
      && (claim.diagnosticStatus !== 'undetermined' || !onlyDirectlyNegatedDiseaseMentions(claim))
      || hasHighConsequenceNodeAssertion(claim))
      || hasNovelHighConsequenceClaimAssertion(claim);
    if (claim.consequenceLevel !== 'high' && !highConsequence) continue;
    targets.add(claim.id);
    reasons.push(highConsequence ? `high_consequence_disease:${claim.id}` : `reported_high_consequence:${claim.id}`);
    for (const action of candidate.actions.filter((item) => item.claimIds.includes(claim.id))) targets.add(action.id);
    for (const system of candidate.systems.filter((item) => item.claimIds.includes(claim.id))) targets.add(system.id);
    if (candidate.overview.claimIds.includes(claim.id)) targets.add('overview');
  }
  for (const action of candidate.actions) {
    const numericSupplementDose = hasNumericSupplementDose(action);
    if (action.urgency === 'emergency' || hasDirectMedicationChange(action)
      || hasHighConsequenceNodeAssertion(action) || numericSupplementDose) {
      targets.add(action.id);
      reasons.push(`high_impact_action:${action.id}`);
      if (numericSupplementDose) reasons.push(`numeric_supplement_dose:${action.id}`);
      for (const system of candidate.systems.filter((item) => item.actionIds.includes(action.id))) targets.add(system.id);
      if (candidate.overview.actionIds.includes(action.id)) targets.add('overview');
    }
  }
  for (const question of candidate.questions) {
    // 普通问句也会暗含“做过哪种操作”等既知事实；不靠医学术语穷举判断是否需要核对。
    // 与高影响内容共用既有的一次 P04，不要求用户补答，也不因此扩大其他节点的替换权限。
    targets.add(question.id);
    reasons.push(`question_premise:${question.id}`);
    if (!hasHighConsequenceNodeAssertion(question)) continue;
    reasons.push(`high_impact_question:${question.id}`);
    for (const system of candidate.systems.filter((item) => item.claimIds.some((id) => question.relatedClaimIds.includes(id)))) {
      targets.add(system.id);
    }
    if (candidate.overview.claimIds.some((id) => question.relatedClaimIds.includes(id))) targets.add('overview');
  }
  if (hasHighConsequenceNodeAssertion(candidate.overview)) {
    targets.add('overview');
    reasons.push('high_consequence_statement:overview');
  }
  for (const system of candidate.systems) {
    if (!hasHighConsequenceNodeAssertion(system)) continue;
    targets.add(system.id);
    reasons.push(`high_consequence_statement:${system.id}`);
  }
  return { targetIds: [...targets], reasons: [...new Set(reasons)] };
}

type Node = HealthClaim | HealthAction | OverviewNode | SystemNode | QuestionNode;
type NodeType = 'claim' | 'action' | 'overview' | 'system' | 'question';

export function applyFocusedReview(
  candidate: MemberAssessmentCandidateV3,
  review: ClinicalFocusedReviewV1,
  targetIds: string[],
  options?: { deferIndependentHabitRepair?: boolean; finalDependencyGraph?: boolean }
): { candidate: MemberAssessmentCandidateV3; heldTargetIds: string[]; rebuiltNodeIds: string[]; dependentActionIds: string[] } {
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
    let replacement: Node = result.replacement.value;
    if (original.type === 'action') {
      const originalAction = original.value as HealthAction;
      const replacementAction = replacement as HealthAction;
      // 可选字段兼容旧模型/快照；省略不是解除生活依据门禁，显式变更仍由后续校验核对。
      replacement = {
        ...replacementAction,
        ...(replacementAction.lifestyleDomain === undefined && originalAction.lifestyleDomain !== undefined
          ? { lifestyleDomain: originalAction.lifestyleDomain } : {}),
        ...(replacementAction.lifestyleBasis === undefined && originalAction.lifestyleBasis !== undefined
          ? { lifestyleBasis: originalAction.lifestyleBasis } : {})
      };
    }
    byId.set(result.targetId, { type: original.type, value: replacement });
  }
  const heldClaims = new Set(candidate.claims.filter((item) => held.has(item.id)).map((item) => item.id));
  if (options?.finalDependencyGraph) {
    for (const original of candidate.actions) {
      if (held.has(original.id) || !original.claimIds.some((id) => heldClaims.has(id))) continue;
      const after = byId.get(original.id)!.value as HealthAction;
      const explicitRewrite = review.results.some((result) => result.targetId === original.id && result.verdict === 'replace');
      if (!explicitRewrite || after.claimIds.some((id) => heldClaims.has(id))
        || after.claimIds.length + after.evidenceIds.length === 0 || !hasSubstantiveActionRewrite(original, after)) held.add(original.id);
    }
  }
  // 低影响的日常建议可以有独立报告依据。先修复失效引用，不因一个被隔离判断就丢掉整类建议。
  // 这只是临时保留给 P03；发布前仍须完整校验，失败时沿用隔离，不直接删引用放行正文。
  const dependentActionIds = options?.deferIndependentHabitRepair ? candidate.actions.filter((item) => {
    const action = byId.get(item.id)!.value as HealthAction;
    return !held.has(item.id) && action.kind === 'habit' && action.urgency === 'routine'
      && !hasDirectMedicationChange(action) && !hasHighConsequenceNodeAssertion(action) && !hasNumericSupplementDose(action)
      && action.claimIds.some((id) => heldClaims.has(id))
      && (action.evidenceIds.length > 0 || action.claimIds.some((id) => !heldClaims.has(id)));
  }).map((item) => item.id) : [];
  const pendingActions = new Set(dependentActionIds);
  const heldActions = new Set(candidate.actions.filter((item) => held.has(item.id)
    || !pendingActions.has(item.id) && (byId.get(item.id)!.value as HealthAction).claimIds.some((id) => heldClaims.has(id))).map((item) => item.id));
  for (const id of heldActions) held.add(id);
  const claims = candidate.claims.filter((item) => !heldClaims.has(item.id)).map((item) => byId.get(item.id)!.value as HealthClaim);
  const actions = candidate.actions.filter((item) => !heldActions.has(item.id)).map((item) => byId.get(item.id)!.value as HealthAction);
  const claimsById = new Map(claims.map((claim) => [claim.id, claim]));
  const actionsById = new Map(actions.map((action) => [action.id, action]));
  const rebuiltNodeIds: string[] = [];
  const cleanLimitations = (values: string[]) => values.map((value) => presentAssessmentText(value).text).filter(Boolean);
  const systems = candidate.systems.map((item) => {
    const node = byId.get(item.id)!.value as SystemNode;
    const claimIds = node.claimIds.filter((id) => !heldClaims.has(id));
    const actionIds = node.actionIds.filter((id) => !heldActions.has(id) && !pendingActions.has(id));
    const dependent = held.has(item.id) || node.claimIds.length !== claimIds.length || node.actionIds.length !== actionIds.length;
    if (dependent) rebuiltNodeIds.push(item.id);
    return dependent ? {
      ...node, claimIds, actionIds,
      // 原状态可能只由被隔离主张支撑；不从剩余主张数量推断“继续观察”或“本范围正常”。
      // 展示层通过 rebuiltNodeIds 单独表达解读范围，身体情况仍由具体主张说明。
      status: 'insufficient' as const,
      ...retainedAssessmentNarrative(claimIds.map((id) => claimsById.get(id)!).filter(Boolean),
        actionIds.map((id) => actionsById.get(id)!).filter(Boolean), cleanLimitations(node.limitations)),
      limitations: cleanLimitations(node.limitations)
    } : node;
  });
  const originalOverview = byId.get('overview')!.value as OverviewNode;
  const overviewChanged = held.has('overview') || originalOverview.claimIds.some((id) => heldClaims.has(id))
    || originalOverview.actionIds.some((id) => heldActions.has(id) || pendingActions.has(id));
  if (overviewChanged) rebuiltNodeIds.push('overview');
  // 原总览可能只关联一个器官；重建整体概况时覆盖本轮仍可用的全部主张。
  const overviewClaimIds = overviewChanged ? claims.map((claim) => claim.id)
    : originalOverview.claimIds.filter((id) => !heldClaims.has(id));
  const overview = overviewChanged ? {
    ...originalOverview,
    ...retainedOverviewNarrative(claims, cleanLimitations(originalOverview.limitations), 2_000, { systems, rebuiltNodeIds }),
    claimIds: overviewClaimIds,
    actionIds: originalOverview.actionIds.filter((id) => !heldActions.has(id) && !pendingActions.has(id)),
    limitations: cleanLimitations(originalOverview.limitations)
  } : originalOverview;
  const questions = candidate.questions.filter((item) => !held.has(item.id)).flatMap((item) => {
    const node = byId.get(item.id)!.value as QuestionNode;
    const relatedClaimIds = node.relatedClaimIds.filter((id) => !heldClaims.has(id));
    if (relatedClaimIds.length === node.relatedClaimIds.length) return [node];
    // 最终图必须由同次 P04 显式给出独立问句，不能在 pass 后由程序另删前提冒充复核。
    if (options?.finalDependencyGraph) { held.add(item.id); return []; }
    // 对检查条件、症状或当前用药的独立问题仍有个人依据时保留；移除失效引用。
    // 依赖“这个高风险”等失效判断、或直接复述其病名的问题不能冒充有效下一步。
    const removedClaims = node.relatedClaimIds.filter((id) => heldClaims.has(id))
      .map((id) => byId.get(id)?.value as HealthClaim | undefined).filter(Boolean);
    const questionText = `${node.question} ${node.whyItMatters}`;
    const reliesOnRemovedAssessment = /(?:这个|该项|上述|这一)(?:判断|风险|问题)|这个高风险|立即处理这个/.test(questionText)
      || removedClaims.some((claim) => claim?.diseaseName && questionText.includes(claim.diseaseName));
    if (relatedClaimIds.length === 0 && (node.evidenceIds.length === 0 || reliesOnRemovedAssessment)) return [];
    return [{ ...node, relatedClaimIds }];
  });
  // 总览和系统节点已由有效内容替换，原文隔离信息放在展示元信息；held ID 仅指实际移除的节点。
  const heldTargetIds = [...held].filter((id) => byId.get(id)?.type !== 'overview' && byId.get(id)?.type !== 'system');
  return { candidate: { ...candidate, overview, systems, claims, actions, questions }, heldTargetIds, rebuiltNodeIds, dependentActionIds };
}
