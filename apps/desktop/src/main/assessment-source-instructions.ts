import { healthActionSchema, type MemberAssessmentCandidateV3, type MemberEvidencePackageV3,
  type MemberEvidenceRef } from '@contracts';

type SourceFact = MemberEvidencePackageV3['facts'][number];

export interface AssessmentSourceInstructionBinding {
  candidate: MemberAssessmentCandidateV3;
  issues: string[];
  /** 仅表示原句已完整绑定；这些行动仍须在同一次 P04 核实是否确为医生指示。 */
  boundActionIds: string[];
}

/** 只接受事实本身的个人原件引用；目录标题、通用知识及别的观测不能借位。 */
function isFactReference(reference: MemberEvidenceRef, fact: SourceFact): boolean {
  return ['observation', 'clinical_finding', 'source_span'].includes(reference.kind)
    && reference.documentId === fact.documentId && Boolean(reference.documentId?.trim())
    && Boolean(reference.sourceSpanId?.trim() && reference.quote?.trim()) && reference.knowledgeId === null
    && (reference.observationId === fact.observationId
      || reference.kind === 'source_span' && reference.observationId === null);
}

/** 仅允许全半角和空白排版等价，不转换数字、中文期限、标点或医学用语。 */
function layoutKey(value: string): string {
  return value.normalize('NFKC').replace(/\s/gu, '');
}

/** 避免把“13个月”内的“3个月”当作原文中独立声明的期限。 */
function hasLiteralTiming(source: string, timing: string): boolean {
  const whole = layoutKey(source);
  const part = layoutKey(timing);
  if (!part) return false;
  const numeric = /[\p{N}零〇一二两三四五六七八九十百千万半]/u;
  let start = whole.indexOf(part);
  while (start >= 0) {
    const end = start + part.length;
    const leftAttached = numeric.test(part[0]!) && start > 0 && numeric.test(whole[start - 1]!);
    const rightAttached = numeric.test(part.at(-1)!) && end < whole.length && numeric.test(whole[end]!);
    if (!leftAttached && !rightAttached) return true;
    start = whole.indexOf(part, start + 1);
  }
  return false;
}

/**
 * facts 必须来自本轮候选对应的成员包，不从全局目录或其他成员补事实。
 * 此处仅做来源绑定：不猜医生指示的语义、不抽句、不改数值，不修改引用及其他行动字段。
 */
export function bindAssessmentSourceInstructions(
  candidate: MemberAssessmentCandidateV3,
  facts: readonly SourceFact[],
  evidenceCatalog: readonly MemberEvidenceRef[]
): AssessmentSourceInstructionBinding {
  const issues: string[] = [];
  const boundActionIds: string[] = [];
  const factsById = new Map<string, SourceFact[]>();
  const referencesById = new Map<string, MemberEvidenceRef[]>();
  for (const fact of facts) factsById.set(fact.observationId, [...factsById.get(fact.observationId) ?? [], fact]);
  for (const reference of evidenceCatalog) referencesById.set(reference.id,
    [...referencesById.get(reference.id) ?? [], reference]);
  const actions = candidate.actions.map((action) => {
    const observationId = action.sourceInstructionObservationId;
    if (observationId === undefined) return action;
    const fail = (reason: string) => {
      issues.push(`source_instruction:${action.id}:${reason}`);
      return action;
    };
    if (action.kind !== 'documented_plan') return fail('kind');
    const matches = factsById.get(observationId) ?? [];
    if (matches.length === 0) return fail('fact_not_found');
    if (matches.length !== 1) return fail('fact_not_unique');
    const fact = matches[0]!;
    if (fact.valueKind !== 'text' || fact.sourceKind !== 'report') return fail('fact_not_text');
    const hasCitedFactReference = action.evidenceIds.some((id) => {
      if (!fact.evidenceIds.includes(id)) return false;
      const references = referencesById.get(id) ?? [];
      return references.length === 1 && isFactReference(references[0]!, fact);
    });
    if (!hasCitedFactReference) return fail('evidence_not_linked');
    // 按实际结构上限拒绝整条原句，不能截断后变成另一条建议。
    const firstStepSchema = healthActionSchema.shape.firstStep;
    if (firstStepSchema.maxLength !== null && fact.rawValue.length > firstStepSchema.maxLength) {
      return fail('source_text_too_long');
    }
    if (!firstStepSchema.safeParse(fact.rawValue).success) return fail('source_text_invalid');
    if (action.timing !== null && !hasLiteralTiming(fact.rawValue, action.timing)) return fail('timing_not_literal');
    boundActionIds.push(action.id);
    return { ...action, firstStep: fact.rawValue };
  });
  return { candidate: { ...candidate, actions }, issues, boundActionIds: [...new Set(boundActionIds)] };
}
