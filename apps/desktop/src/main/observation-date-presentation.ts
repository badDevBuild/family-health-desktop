import type { ClinicalTime } from '@contracts';
import { calendarDateOccurrences, resolveDirectOriginalWholeExcerptQuote } from '@core';
import type { AcceptedObservationSummary, WorkspaceStore } from '@storage';
import { projectEventDate, projectReportIssuedTime, readEventDateSources, type EventDateSource } from './event-date-projection.js';

export const OBSERVATION_DATE_POLICY_VERSION = 'observation-recorded-time-v1';
type DateEvidence = Array<{ sourceSpanId: string; quote: string | null }>;
interface ProjectedDate { documentTime?: ClinicalTime; effectiveTime?: ClinicalTime; effectiveTimeEvidence?: DateEvidence }
export type ObservationWithDocumentTime = AcceptedObservationSummary & ProjectedDate;
type DateInput = Pick<AcceptedObservationSummary, 'clinicalDate' | 'documentId'>
  & Partial<Pick<AcceptedObservationSummary, 'originalName' | 'evidence' | 'sourceQuote' | 'clinicalContext'>>;

const compact = (value: string) => value.normalize('NFKC').replace(/\s/gu, '');

/** 只复用旧模型已经逐项引用的唯一日期，不按数值顺序、名称或整页日期猜配历史列。 */
function linkedDate(item: DateInput, sources: EventDateSource[]): { value: string; evidence: DateEvidence } | null {
  const found: Array<{ value: string; sourceSpanId: string; quote: string }> = [];
  for (const ref of item.evidence ?? []) {
    if (!ref.quote || ref.sourceRole === 'duplicate_source') continue;
    const dates = calendarDateOccurrences(ref.quote);
    // 日期须是已接纳引用专门选定的完整日期；长表格包含日期不等于已定位某一列。
    if (dates.length !== 1 || compact(ref.quote) !== compact(ref.quote.slice(dates[0]!.index, dates[0]!.index + dates[0]!.length))) continue;
    const value = dates[0]!.date;
    for (const { report, manifest } of sources) {
      if (!manifest || report.metadataStatus === 'corrected') continue;
      const span = manifest.spans.find(span => span.id === ref.sourceSpanId);
      const whole = resolveDirectOriginalWholeExcerptQuote(manifest, item.documentId, ref.sourceSpanId);
      if (!span || !whole || !compact(whole).includes(compact(ref.quote))
        || !['date', 'finding'].includes(span.modelEvidence?.role ?? '')) continue;
      const declared = (report.extracted?.times ?? []).filter(time => time.value === value
        && time.evidence.some(e => e.sourceSpanId === ref.sourceSpanId));
      if (declared.some(time => ['report_issued', 'unknown'].includes(time.role))) continue;
      const wholeDates = calendarDateOccurrences(whole).map(date => date.date);
      const nameDates = [...new Set(calendarDateOccurrences(item.originalName ?? '').map(date => date.date))];
      // 已保存的专门日期引用就是逐项关系；不再要求模型把日期重复写进展示名。
      // 引用仍须在同原件中唯一定位；名称若另有明确日期则不能与引用矛盾。
      if (wholeDates.filter(date => date === value).length !== 1
        || nameDates.length > 0 && (nameDates.length !== 1 || nameDates[0] !== value)) continue;
      found.push({ value, sourceSpanId: ref.sourceSpanId, quote: ref.quote });
    }
  }
  return new Set(found.map(ref => ref.value)).size === 1
    ? { value: found[0]!.value, evidence: found.map(({ sourceSpanId, quote }) => ({ sourceSpanId, quote })) } : null;
}

/** 历史/多期线索只用于阻止套用本次日期，不从这些词推导任何医疗值或历史日期。 */
function hasIndependentTimeScope(item: DateInput, sources: EventDateSource[]): boolean {
  const texts = [item.originalName ?? '', item.sourceQuote ?? '',
    ...(item.clinicalContext?.conditions ?? []).map(ref => ref.quote),
    ...(item.evidence ?? []).filter(ref => ref.sourceRole !== 'duplicate_source').flatMap(ref =>
      sources.flatMap(source => source.manifest?.spans.filter(span => span.id === ref.sourceSpanId)
        .map(span => ref.quote ?? span.quote ?? '') ?? []))];
  return texts.some(text => /历史|历年|历次|趋势|上次|既往|往年|前次/u.test(text))
    || new Set(texts.flatMap(text => calendarDateOccurrences(text).map(date => date.date))).size > 1;
}

/** 日期使用统一投影：明确单项日期优先，其次已有日期引用，普通未定日期结果按有据报告日期记录。原事实不改写。 */
export function withDocumentTimes<T extends DateInput>(
  store: Pick<WorkspaceStore, 'listReportMetadata' | 'getDocumentExtractionBundle'>,
  personId: string, observations: T[]): Array<T & ProjectedDate> {
  const needed = new Set(observations.filter(item => !item.clinicalDate).map(item => item.documentId));
  if (!needed.size) return observations;
  const grouped = new Map<string, EventDateSource[]>();
  for (const source of readEventDateSources(store, personId,
    store.listReportMetadata(personId).filter(report => needed.has(report.documentId)))) {
    grouped.set(source.report.documentId, [...grouped.get(source.report.documentId) ?? [], source]);
  }
  const times = new Map([...grouped].map(([documentId, sources]) => {
    const projected = projectEventDate(sources, []);
    const time = !projected.hasExplicitRange && projected.sourceTime || projectReportIssuedTime(sources);
    return [documentId, time ? { time: {
      value: time.value, endValue: null, precision: time.precision, role: 'report' as const,
      source: 'inherited' as const, basis: 'report' as const,
      displayLabel: `${time.value} · 所属报告的${time.role === 'report_issued' ? '签发' : time.role === 'sampled' ? '采样'
        : time.role === 'encounter' ? '就诊' : '检查'}日期`
    }, evidence: time.evidence } : null] as const;
  }));
  return observations.map(item => {
    if (item.clinicalDate) return item;
    const sources = grouped.get(item.documentId) ?? [];
    const linked = linkedDate(item, sources);
    const report = times.get(item.documentId);
    if (linked) return { ...item, ...(report ? { documentTime: report.time } : {}),
      effectiveTime: { value: linked.value, endValue: null, precision: 'day', role: 'measurement',
        source: 'inherited', basis: 'clinical', displayLabel: `${linked.value} · 原记录日期引用` }, effectiveTimeEvidence: linked.evidence };
    if (!report) return item;
    const fallback = !hasIndependentTimeScope(item, sources) && report.evidence.length > 0;
    return { ...item, documentTime: report.time, ...(fallback ? {
      effectiveTime: { ...report.time, displayLabel: `${report.time.value} · 按报告日期记录` },
      effectiveTimeEvidence: report.evidence.map(({ sourceSpanId, quote }) => ({ sourceSpanId, quote }))
    } : {}) };
  });
}

export function observationDisplayTime(observation: ObservationWithDocumentTime, includeDocumentContext = true): ClinicalTime {
  return observation.clinicalDate ? { value: observation.clinicalDate, endValue: null,
    precision: 'day', role: 'measurement', source: 'explicit', basis: 'clinical', displayLabel: observation.clinicalDate }
    : observation.effectiveTime ?? (includeDocumentContext ? observation.documentTime : undefined) ?? { value: null, endValue: null, precision: 'unknown', role: 'unknown',
      source: 'unknown', basis: 'unknown', displayLabel: '检查及报告日期未记录' };
}
