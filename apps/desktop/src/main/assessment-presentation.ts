import type { HealthClaim, MemberAssessmentSnapshotV3, OverviewNode, SystemNode } from '@contracts';

/** 展示投影独立版本化：不改变事实、模型提示词、校验规则或旧快照的有效性。 */
export const ASSESSMENT_PRESENTATION_VERSION = 'result-summary-v1';

const heldHeadlines = new Set(['部分健康判断仍需核实', '部分判断仍需核实', '这部分判断仍需核实']);
const heldSummaries = new Set([
  '已接纳的报告事实仍可查看；本系统有部分判断暂未纳入本次解读。',
  '已接纳的报告事实和其他行动仍可查看；有部分判断暂未纳入本次总览。'
]);

/** 只摘用完整、仍可发布的原句；不截断否定/条件，也不从数值推断新的健康结论。 */
function retainedNarrative(claims: HealthClaim[]): Pick<OverviewNode, 'headline' | 'summary'> {
  const first = claims[0];
  if (!first) return {
    headline: '暂未形成完整解读',
    summary: '目前还不能给出这部分的完整结论；已有的检查结果和原始依据仍可查看。'
  };
  // 标题保留第一条完整判断，其适用限制紧随标题显示，不把“可能”变成“确定”。
  const paragraphs = first.materialUncertainty ? [first.materialUncertainty] : [];
  for (const claim of claims.slice(1)) {
    const paragraph = [claim.text, claim.materialUncertainty].filter(Boolean).join(' ');
    // 摘要放不下时整条留在详细解读，不裁剪临床语义。原始 claims 始终完整保留。
    if ([...paragraphs, paragraph].join('\n\n').length <= 2_000) paragraphs.push(paragraph);
  }
  return { headline: first.text, summary: paragraphs.join('\n\n') || first.rationale };
}

/**
 * 兼容已发布的旧结果和未来的局部隔离结果。只读投影，不迁移/覆盖数据库，
 * 不恢复 held 内容，不增加模型调用。处理记录与面向用户的身体摘要分开。
 */
export function presentMemberAssessment(snapshot: MemberAssessmentSnapshotV3): MemberAssessmentSnapshotV3 {
  const held = new Set(snapshot.heldTargetIds);
  const byId = new Map(snapshot.claims.filter((claim) => !held.has(claim.id)).map((claim) => [claim.id, claim]));
  const rebuiltNodeIds = new Set(snapshot.presentation?.rebuiltNodeIds ?? []);
  const project = <T extends OverviewNode | SystemNode>(node: T): T => {
    const isFallback = held.size > 0 && (held.has(node.id)
      || heldHeadlines.has(node.headline) || heldSummaries.has(node.summary));
    if (!isFallback && !rebuiltNodeIds.has(node.id)) return node;
    rebuiltNodeIds.add(node.id);
    const claims = [...new Set(node.claimIds)].map((id) => byId.get(id))
      .filter((claim): claim is HealthClaim => Boolean(claim));
    return { ...node, ...retainedNarrative(claims) };
  };
  const overview = project(snapshot.overview);
  const systems = snapshot.systems.map(project);
  if (rebuiltNodeIds.size === 0) return snapshot;
  return {
    ...snapshot, overview, systems,
    presentation: { version: ASSESSMENT_PRESENTATION_VERSION, rebuiltNodeIds: [...rebuiltNodeIds] }
  };
}
