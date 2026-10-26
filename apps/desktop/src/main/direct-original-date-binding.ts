import type { DirectOriginalReadingResult, ObservationCandidate } from '@contracts';
import { calendarDateOccurrences, type DirectOriginalCandidateDiagnostic } from '@core';

/** 只发现模型已读取的日期线索未绑定；交模型核实适用范围，不自动推填结果日期。 */
export function diagnoseMissingDateBinding(candidate: ObservationCandidate,
  reading: DirectOriginalReadingResult): DirectOriginalCandidateDiagnostic[] {
  if (candidate.clinicalDate !== null || !['numeric', 'qualitative'].includes(candidate.value.kind)
    || candidate.issues.some(issue => issue.code === 'clinical_date_not_assignable')) return [];
  const refs = [...candidate.evidence, ...(candidate.sourceBinding?.structuredSlot?.axes
    .filter(axis => axis.kind === 'time').flatMap(axis => axis.evidence) ?? [])];
  const usableDateRef = (ref: ObservationCandidate['evidence'][number]): boolean => {
    if (ref.sourceRole === 'duplicate_source') return false;
    const declared = reading.extraction.reportMetadata?.times.filter(time => time.evidence.some(
      date => date.sourceSpanId === ref.sourceSpanId && date.quote === ref.quote)) ?? [];
    if (declared.length && declared.every(time => time.role === 'report_issued')) return false;
    const excerpt = reading.sourceExcerpts.find(item => item.localKey === ref.sourceSpanId);
    if (!excerpt || excerpt.clarity !== 'clear' || !['date', 'finding'].includes(excerpt.role)) return false;
    const quote = ref.quote ?? excerpt.quote;
    return excerpt.quote.includes(quote) && calendarDateOccurrences(quote).length > 0;
  };
  // 报告主日期已读取、后页结果却漏引日期时也要补核。主日期只是核实线索，不能直接赋给历史点。
  const metadata = reading.extraction.reportMetadata;
  const primaryIndex = metadata?.primaryClinicalTimeIndex;
  const primary = typeof primaryIndex === 'number' ? metadata?.times[primaryIndex] : undefined;
  const primaryRefs = primary && ['sampled', 'examined', 'encounter'].includes(primary.role)
    ? primary.evidence.filter(ref => usableDateRef(ref) && calendarDateOccurrences(ref.quote ?? '').some(date => date.date === primary.value)) : [];
  const matched = refs.find(usableDateRef) ?? primaryRefs[0];
  return matched ? [{ targetId: candidate.localKey, fieldPath: 'clinicalDate',
    sourceSpanId: matched.sourceSpanId, reasonCode: 'direct_original_clinical_date_binding_missing',
    constraint: '本报告已读取含日期的原文，但该结果的单项日期仍为null。重新看原页，确认此数值属于哪个检查/采样/历史列日期；明确时补齐clinicalDate、metadata.times的正确角色及相同日期引用。多日期不能按顺序猜配，签发时间不能冒充检查时间。确实无法唯一对应则保留null并在issues用clinical_date_not_assignable说明，不改数值、单位或条件。' }] : [];
}
