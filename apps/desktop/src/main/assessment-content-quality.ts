import type { MemberAssessmentCandidateV3 } from '@contracts';
import { containsEditorialInstruction, containsProcessNarrative } from '@contracts';

export { presentAssessmentText } from '@contracts';

/** 每条问题包含现有节点 ID 与字段路径，沿用 P03 的局部修复及依赖隔离机制。 */
export function findProcessNarrativeIssues(candidate: MemberAssessmentCandidateV3): string[] {
  const issues: string[] = [];
  const inspect = (ownerId: string, field: string, value: string | null) => {
    if (value && (containsProcessNarrative(value) || containsEditorialInstruction(value))) {
      issues.push(`process_narrative:${ownerId}:${field}`);
    }
  };
  for (const node of [candidate.overview, ...candidate.systems]) {
    inspect(node.id, 'headline', node.headline);
    inspect(node.id, 'summary', node.summary);
    node.limitations.forEach((value, index) => inspect(node.id, `limitations[${index}]`, value));
  }
  for (const claim of candidate.claims) {
    inspect(claim.id, 'title', claim.title ?? null);
    inspect(claim.id, 'text', claim.text);
    inspect(claim.id, 'rationale', claim.rationale);
    inspect(claim.id, 'materialUncertainty', claim.materialUncertainty);
    inspect(claim.id, 'diseaseName', claim.diseaseName);
    inspect(claim.id, 'changeAssessment.summary', claim.changeAssessment?.summary ?? null);
    inspect(claim.id, 'changeAssessment.reason', claim.changeAssessment?.reason ?? null);
  }
  for (const action of candidate.actions) {
    for (const field of ['title', 'why', 'firstStep', 'timing', 'reviewPlan', 'caution'] as const) {
      inspect(action.id, field, action[field]);
    }
  }
  for (const question of candidate.questions) {
    inspect(question.id, 'question', question.question);
    inspect(question.id, 'whyItMatters', question.whyItMatters);
  }
  return issues;
}
