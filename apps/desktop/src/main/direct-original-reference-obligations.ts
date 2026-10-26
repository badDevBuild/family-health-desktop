import type { DirectOriginalReadingResult, ObservationCandidate } from '@contracts';
import type { DirectOriginalCandidateDiagnostic } from '@core';

type EvidenceRef = ObservationCandidate['evidence'][number];

/** 共享来源被授权修改时，列出全部引用者的保留义务；这不是新的失败或接纳规则。 */
export function directOriginalReferenceObligations(reading: DirectOriginalReadingResult,
  protectedSourceKeys: ReadonlySet<string>): DirectOriginalCandidateDiagnostic[] {
  const result: DirectOriginalCandidateDiagnostic[] = [];
  const add = (targetId: string, fieldPath: string, ref: EvidenceRef, constraint: string, allowedRoles?: string[]) => {
    if (!protectedSourceKeys.has(ref.sourceSpanId)) return;
    const matches = reading.sourceExcerpts.filter((excerpt) => excerpt.localKey === ref.sourceSpanId);
    result.push({ targetId, reasonCode: 'DIRECT_ORIGINAL_REFERENCE_OBLIGATION', fieldPath,
      sourceSpanId: ref.sourceSpanId, actualRole: matches.length === 1 ? matches[0]!.role : null,
      ...(allowedRoles ? { allowedRoles } : {}), constraint });
  };
  const each = (targetId: string, fieldPath: string, refs: EvidenceRef[], constraint: string, allowedRoles?: string[]) =>
    refs.forEach((ref, index) => add(targetId, `${fieldPath}[${index}]`, ref, constraint, allowedRoles));
  const general = '这是授权共享来源的引用者保留义务，不表示本字段已失败。引用仍须指向同一真实原页的清晰原话并证明本字段；修复其他引用不能删改本字段的原值、日期角色、否定、左右侧或条件。需要不同角色时，从已授权原页新增独立摘录后重绑本目标，不能只改整块角色。';
  for (const candidate of reading.extraction.candidates) {
    const noResult = candidate.value.kind === 'unknown'
      && ['original_blank', 'not_performed', 'no_data'].includes(candidate.value.reason);
    const explicitBlank = candidate.value.kind === 'unknown' && candidate.value.reason === 'original_blank'
      && candidate.value.rawText === null;
    each(candidate.localKey, 'evidence', candidate.evidence, general);
    each(candidate.localKey, 'sourceBinding.findingEvidence', candidate.sourceBinding?.findingEvidence ?? [],
      explicitBlank
        ? `${general} 本引用承担明确空白出处职责；finding/instruction 须有原件明确原话，heading 仅限既有唯一、同名完整字段标签规则且 rawText=null，不能用目录或一般标题证明空白。`
        : `${general} 本引用承担具体结果或报告医生原话职责，仍须满足 finding/instruction 及精确结果来源门禁。`,
      explicitBlank ? ['finding', 'instruction', 'heading'] : ['finding', 'instruction']);
    each(candidate.localKey, 'sourceBinding.headingEvidence', candidate.sourceBinding?.headingEvidence ?? [],
      noResult ? `${general} 本引用只是无结果候选的附带栏目依据，不可冒充主要空白字段或结果；沿用既有无结果来源规则。`
        : `${general} 本引用承担本候选栏目职责；heading/context 可独立证明，混合 finding/instruction 只有本候选同摘录的唯一、不重叠、非整块窄标题和窄结果同时成立时才可复用，不能借其他候选的结果证明标题。`,
      noResult ? undefined : ['heading', 'context', 'finding', 'instruction']);
    each(candidate.localKey, 'clinicalContext.conditions', candidate.clinicalContext?.conditions ?? [],
      noResult ? `${general} 本引用是无结果候选的附带条件，仍须清晰同源，不新增确认事实的角色门禁。`
        : `${general} 本引用承担真实检查条件职责，必须保留影响比较和解释的条件，不能清空以规避来源问题。`,
      noResult ? undefined : ['finding', 'context', 'instruction', 'date']);
    const slot = candidate.sourceBinding?.structuredSlot;
    if (slot) {
      const slotConstraint = `${general} 本引用承担真实表格或分量身份，须保持同页共同上下文及真实行列/轴/分量关系；不得为减少矛盾改编号、移到别列、借用另一侧或另一日期，也不能删引用后降级绕过。`;
      for (const key of ['contextEvidence', 'rowEvidence', 'columnEvidence'] as const) {
        each(candidate.localKey, `sourceBinding.structuredSlot.${key}`, slot[key], slotConstraint,
          ['finding', 'instruction', 'context', 'heading', 'date']);
      }
      slot.axes.forEach((axis, index) => each(candidate.localKey,
        `sourceBinding.structuredSlot.axes[${index}].evidence`, axis.evidence, slotConstraint,
        ['finding', 'instruction', 'context', 'heading', 'date']));
      if (slot.component) each(candidate.localKey, 'sourceBinding.structuredSlot.component.evidence',
        slot.component.evidence, slotConstraint, ['finding', 'instruction', 'context', 'heading', 'date']);
    }
  }
  const metadata = reading.extraction.reportMetadata;
  if (metadata) {
    for (const key of ['reportKind', 'title', 'organization', 'campus', 'department', 'reportNumber', 'encounterIdentifier'] as const) {
      const value = metadata[key];
      if (value) each('metadata', `${key}.evidence`, value.evidence, general);
    }
    for (const key of ['sampleIdentifiers', 'examItems'] as const) metadata[key]?.forEach((item, index) =>
      each('metadata', `${key}[${index}].evidence`, item.evidence, general));
    metadata.times.forEach((time, index) => each('metadata', `times[${index}].evidence`, time.evidence,
      `${general} 本引用承担日期证明职责，仍须由 date/finding/instruction 清晰证明本时间值、精度及日期角色；不能把检查时间改成签发时间，也不能为修复另一结果删除已证实日期。`, ['date', 'finding', 'instruction']));
  }
  return result;
}
