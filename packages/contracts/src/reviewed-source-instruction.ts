import type { HealthAction, MemberAssessmentSnapshotV3 } from './member-assessment-v3.js';
import type { MemberEvidenceRef } from './member-v2.js';

/** 排序对象键只为比较同一已发布节点；绝不整理原医嘱正文。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/**
 * 只认已发布综合中经过重点复核的完整原句节点，不用枚举或医嘱关键词猜来源。
 * 这里只供展示来源识别；采纳时存储层还须核对当前成员、事实原值、原件引用及日期。
 */
export function reviewedSourceInstructionEvidence(action: HealthAction,
  snapshot: MemberAssessmentSnapshotV3 | null | undefined): MemberEvidenceRef[] {
  const sourceId = action.sourceInstructionObservationId;
  if (!sourceId || action.kind !== 'documented_plan' || !action.firstStep.trim()
    || !snapshot?.id || !snapshot.personId || !['current', 'stale'].includes(snapshot.status)
    || snapshot.validationMode !== 'local_and_focused_review'
    || !snapshot.reviewedTargetIds.includes(action.id) || snapshot.heldTargetIds.includes(action.id)) return [];
  const nodes = snapshot.actions.filter((item) => item.id === action.id);
  if (nodes.length !== 1 || canonical(nodes[0]) !== canonical(action)) return [];
  const evidenceIds = new Set(action.evidenceIds);
  return snapshot.evidenceCatalog.filter((ref) => evidenceIds.has(ref.id)
    && ['observation', 'clinical_finding'].includes(ref.kind)
    && ref.observationId === sourceId && ref.documentId !== null && ref.sourceSpanId !== null
    && ref.knowledgeId === null && Boolean(ref.quote?.includes(action.firstStep)));
}
