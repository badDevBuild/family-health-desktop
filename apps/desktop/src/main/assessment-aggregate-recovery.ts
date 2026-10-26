import { stableHash } from '@core';
import type { MemberAssessmentCandidateV3, MemberEvidenceRef, OverviewNode, SystemNode } from '@contracts';
import { visibleAssessmentTextFields } from './assessment-validation.js';
import { inspectAssessmentReviewBoundary } from './assessment-review-boundary.js';

type Aggregate = OverviewNode | SystemNode;
export interface FinalAggregateRecovery {
  baseline: MemberAssessmentCandidateV3;
  targetIds: string[];
  boundaryBaseline: MemberAssessmentCandidateV3;
}

/** 叶子内容全部定稿后才重写摘要，不能用旧摘要里的失效前提给新摘要背书。 */
export function prepareFinalAggregateRecovery(final: MemberAssessmentCandidateV3,
  original: MemberAssessmentCandidateV3, rebuiltIds: readonly string[]): FinalAggregateRecovery {
  const baseline = structuredClone(final);
  const targetIds: string[] = [];
  const prepare = (node: Aggregate): Aggregate => {
    const prior = [original.overview, ...original.systems].find((item) => item.id === node.id);
    if (!rebuiltIds.includes(node.id) || !prior) return node;
    // 不把重建时补入的常规记录升级成新的整体重点；保留原聚合范围内仍有效的内容。
    const actionIds = prior.actionIds.filter((id) => final.actions.some((action) => action.id === id));
    const allowedClaims = new Set([...prior.claimIds, ...final.actions.filter((action) => actionIds.includes(action.id))
      .flatMap((action) => action.claimIds)]);
    const claimIds = final.claims.filter((claim) => allowedClaims.has(claim.id)
      && (!('systemId' in node) || claim.systemIds.includes(node.systemId))).map((claim) => claim.id);
    // 仅有一条存活主张时可直接阅读完整解释；需要重新综合多个结论才追加摘要调用。
    if (claimIds.length < 2) return node;
    targetIds.push(node.id);
    return { ...node, claimIds, actionIds };
  };
  baseline.overview = prepare(baseline.overview) as OverviewNode;
  baseline.systems = baseline.systems.map((node) => prepare(node) as SystemNode);
  const boundaryBaseline = structuredClone(baseline);
  const bind = (node: Aggregate): Aggregate => {
    if (!targetIds.includes(node.id)) return node;
    const leaves = [...baseline.claims.filter((claim) => node.claimIds.includes(claim.id)),
      ...baseline.actions.filter((action) => node.actionIds.includes(action.id))];
    // 仅用于比较许可范围，不作为用户可见摘要；数字、时间和医学方向仍须来自最终保留内容。
    return { ...node, headline: '', summary: leaves.flatMap((leaf) => visibleAssessmentTextFields(leaf)
      .map((field) => field.text)).join('。') };
  };
  boundaryBaseline.overview = bind(boundaryBaseline.overview) as OverviewNode;
  boundaryBaseline.systems = boundaryBaseline.systems.map((node) => bind(node) as SystemNode);
  return { baseline, targetIds, boundaryBaseline };
}

/** 只允许最终摘要的文字及引用收窄；来源、叶子内容、状态和必要条件均冻结。 */
export function finalAggregateReplacementPreserved(recovery: FinalAggregateRecovery,
  replacement: MemberAssessmentCandidateV3, id: string, catalog: readonly MemberEvidenceRef[], referenceDate: string): boolean {
  if (!recovery.targetIds.includes(id)) return false;
  const before = [recovery.baseline.overview, ...recovery.baseline.systems].find((node) => node.id === id);
  const after = [replacement.overview, ...replacement.systems].find((node) => node.id === id);
  if (!before || !after || !after.claimIds.length
    || new Set(after.claimIds).size !== after.claimIds.length || new Set(after.actionIds).size !== after.actionIds.length) return false;
  const fixed = (node: Aggregate) => ({ ...node, headline: '', summary: '', claimIds: [], actionIds: [] });
  const frozen = (candidate: MemberAssessmentCandidateV3) => ({ ...candidate, overview: null, systems: [] });
  if (stableHash(fixed(before)) !== stableHash(fixed(after))
    || stableHash(frozen(recovery.baseline)) !== stableHash(frozen(replacement))) return false;
  return inspectAssessmentReviewBoundary(recovery.boundaryBaseline, replacement, id, [...catalog], referenceDate).preserved;
}
