import type { ReportMetadataCandidate, SourceManifest } from '@contracts';
import { directOriginalTimeEvidenceProblems, resolveDirectOriginalWholeExcerptQuote } from '@core';
import { DIRECT_ORIGINAL_NORMALIZER_VERSION } from '@ingestion';
import type { StoredReportMetadataSummary, WorkspaceStore } from '@storage';

export const EVENT_DATE_PROJECTION_VERSION = 'event-date-projection-v2';

type ClinicalTime = ReportMetadataCandidate['times'][number];
type CurrentClinicalTime = ClinicalTime & { role: 'sampled' | 'examined' | 'encounter' };
type IssuedTime = ClinicalTime & { role: 'report_issued' };
type EventClinicalTime = Pick<ClinicalTime, 'value' | 'precision'> & {
  role: CurrentClinicalTime['role'] | IssuedTime['role'];
};
export type EventSourceTime = EventClinicalTime & {
  basis: 'clinical' | 'report';
  evidence: ClinicalTime['evidence'];
};
export interface EventDateSource {
  report: StoredReportMetadataSummary;
  manifest: SourceManifest | null;
}
export interface EventDateProjection {
  eventDate: string | null;
  endDate: string | null;
  eventPrecision: 'year' | 'month' | 'day' | 'unknown';
  basis: 'clinical' | 'report' | 'unknown';
  explicitClinicalTime: EventClinicalTime | null;
  explicitReportTime: EventClinicalTime | null;
  sourceTime: EventSourceTime | null;
  hasExplicitRange: boolean;
}

const isClinical = (time: ClinicalTime): time is CurrentClinicalTime => ['sampled', 'examined', 'encounter'].includes(time.role);
const compact = (text: string): string => text.normalize('NFKC').replace(/\s+/gu, '');
const unknown = (): EventDateProjection => ({ eventDate: null, endDate: null, eventPrecision: 'unknown',
  basis: 'unknown', explicitClinicalTime: null, explicitReportTime: null, sourceTime: null, hasExplicitRange: false });
const selected = (time: EventClinicalTime, basis: 'clinical' | 'report' = 'clinical',
  evidence: ClinicalTime['evidence'] = []): EventDateProjection => ({ eventDate: time.value, endDate: null,
  eventPrecision: time.precision, basis, explicitClinicalTime: basis === 'clinical' ? time : null,
  explicitReportTime: basis === 'report' ? time : null,
  sourceTime: { ...time, basis, evidence: evidence.map((ref) => ({ ...ref })) }, hasExplicitRange: false });

/** 只读取得当前原件来源；缺失来源不能被默认为可猜日期的旧入口。 */
export function readEventDateSources(store: Pick<WorkspaceStore, 'getDocumentExtractionBundle'>, personId: string,
  reports: StoredReportMetadataSummary[]): EventDateSource[] {
  return reports.map((report) => {
    try {
      const bundle = store.getDocumentExtractionBundle(report.documentId);
      return { report, manifest: bundle.personId === personId && bundle.documentId === report.documentId
        && bundle.manifest.spans.every((span) => span.documentId === report.documentId) ? bundle.manifest : null };
    } catch {
      return { report, manifest: null };
    }
  });
}

function sourceMode({ report, manifest }: EventDateSource): 'direct' | 'legacy' | 'unproven' {
  if (!manifest || manifest.spans.some((span) => span.documentId !== report.documentId)) return 'unproven';
  // 正规技术准备骨架不包含识别文字，仍足以阻止缺元数据时退回旧事实猜日期。
  const pages = manifest.spans.filter((span) => !span.modelEvidence && !span.visualEvidence);
  const prepared = manifest.normalizerVersion === DIRECT_ORIGINAL_NORMALIZER_VERSION
    && pages.length === manifest.totalUnits && manifest.totalUnits > 0
    && new Set(pages.map((span) => span.page)).size === manifest.totalUnits
    && pages.every((span) => ['page', 'image'].includes(span.spanKind) && span.quote === null
      && span.page !== null && span.page <= manifest.totalUnits && manifest.coveredUnitIndexes.includes(span.page - 1));
  const verifiedModelSource = !prepared && manifest.spans.some((span) => resolveDirectOriginalWholeExcerptQuote(manifest, report.documentId, span.id) !== null);
  if (prepared || verifiedModelSource) return 'direct';
  // 任意JSON属性不是direct证明；带有未证实模型出处或未知direct版本时一律不走legacy fallback。
  return manifest.normalizerVersion.startsWith('direct-original') || manifest.spans.some((span) => span.modelEvidence)
    ? 'unproven' : 'legacy';
}

function hasDateSource(source: EventDateSource, time: ClinicalTime, direct: boolean): boolean {
  const { report, manifest } = source;
  if (direct) return manifest !== null && directOriginalTimeEvidenceProblems(time, manifest, report.documentId).length === 0;
  return Boolean(manifest && time.evidence.length > 0 && time.evidence.every((ref) => {
    const span = manifest.spans.find((item) => item.id === ref.sourceSpanId);
    if (!span || span.documentId !== report.documentId || span.readability !== 'clear') return false;
    const quote = span.quote;
    return Boolean(quote && ref.quote !== null && compact(ref.quote).length > 0
      && compact(quote).includes(compact(ref.quote)));
  }));
}

/** 只在本报告没有本次临床时间时，用有本原件证据的报告日期作资料时间。 */
function selectedReportIssuedTime(source: EventDateSource, direct: boolean): IssuedTime | null {
  const metadata = source.report.extracted;
  if (!metadata || metadata.times.some(isClinical)) return null;
  return provenReportIssuedTime(source, direct);
}

function provenReportIssuedTime(source: EventDateSource, direct: boolean): IssuedTime | null {
  const metadata = source.report.extracted;
  if (!metadata) return null;
  const issued = metadata.times.filter((time): time is IssuedTime => time.role === 'report_issued');
  if (issued.length === 0 || issued.some((time) => !hasDateSource(source, time, direct))
    || new Set(issued.map((time) => `${time.precision}:${time.value}`)).size !== 1) return null;
  return issued[0]!;
}

/** 仅用于标注资料所属报告；多个检查日不妨碍显示已核实签发时间，但它不能成为单项检查日。 */
export function projectReportIssuedTime(sources: EventDateSource[]): EventSourceTime | null {
  if (!sources.length || sources.some(source => source.report.metadataStatus === 'corrected')) return null;
  const modes = sources.map(sourceMode);
  if (modes.includes('unproven')) return null;
  const times = sources.map((source, index) => provenReportIssuedTime(source, modes[index] === 'direct'));
  if (times.some(time => time === null)) return null;
  const proven = times as IssuedTime[];
  return new Set(proven.map(time => `${time.precision}:${time.value}`)).size === 1
    ? { ...proven[0]!, basis: 'report' } : null;
}

function selectedSourceTime(source: EventDateSource, direct: boolean): EventSourceTime | null {
  const clinical = selectedReportTime(source, direct);
  if (clinical) return { ...clinical, basis: 'clinical' };
  const issued = selectedReportIssuedTime(source, direct);
  return issued ? { ...issued, basis: 'report' } : null;
}

function projectConsistentSourceTimes(sources: EventDateSource[], direct: readonly boolean[]): EventDateProjection {
  const times = sources.map((source, index) => selectedSourceTime(source, direct[index]!));
  if (times.some((time) => time === null)) return unknown();
  const proven = times as EventSourceTime[];
  if (new Set(proven.map((time) => `${time.precision}:${time.value}`)).size !== 1) return unknown();
  // 每份报告都必须有自己的日期出处；同日混合依据时保留较弱的报告日期性质。
  const time = proven.find((item) => item.basis === 'report') ?? proven[0]!;
  return selected(time, time.basis, time.evidence);
}

/** 日期角色来自模型元数据，不按日期文字、数组顺序、签发时间或事实日期推断本次主日期。 */
function selectedReportTime(source: EventDateSource, direct: boolean): CurrentClinicalTime | null {
  const metadata = source.report.extracted;
  if (!metadata || metadata.primaryClinicalTimeIndex === null) return null;
  const index = metadata.primaryClinicalTimeIndex;
  const current = metadata.times.filter(isClinical);
  const time = index === undefined
    ? new Set(current.map((item) => `${item.precision}:${item.value}`)).size === 1 ? current[0] : undefined
    : Number.isInteger(index) && index >= 0 ? metadata.times[index] : undefined;
  return time && isClinical(time) && hasDateSource(source, time, direct) ? time : null;
}

/** 时间线和身体系统共用的纯读取投影，不更新元数据、事实、计划或任何数据库记录。 */
export function projectEventDate(sources: EventDateSource[], observationDates: readonly string[]): EventDateProjection {
  const corrected = sources.find(({ report }) => report.metadataStatus === 'corrected');
  if (corrected) {
    const time = corrected.report.clinicalTime;
    return time.value !== null && time.precision !== 'unknown'
      ? selected({ value: time.value, precision: time.precision, role: 'examined' }) : unknown();
  }
  const modes = sources.map(sourceMode);
  if (modes.some((mode) => mode === 'unproven') || sources.length === 0) return unknown();
  // direct的主日期必须在每份参与报告中明确、一致；不能借同事件的另一份报告补猜。
  if (modes.includes('direct')) {
    return projectConsistentSourceTimes(sources, modes.map((mode) => mode === 'direct'));
  }
  // 明示selector（含null）在旧入口也不能被数组首项或日期范围覆盖。
  if (sources.some(({ report }) => report.extracted?.primaryClinicalTimeIndex !== undefined)) {
    return projectConsistentSourceTimes(sources, sources.map(() => false));
  }
  // 仅有明确非direct来源的历史入口保留已有“多次独立检查”范围兼容，不能套到新原件。
  const times = sources.flatMap((source) => (source.report.extracted?.times ?? [])
    .filter(isClinical).filter((time) => hasDateSource(source, time, false)))
    .sort((left, right) => ({ day: 3, month: 2, year: 1 }[right.precision]
      - { day: 3, month: 2, year: 1 }[left.precision]));
  const first = times[0];
  if (first) {
    const dates = [...new Set(times.filter((time) => time.precision === first.precision).map((time) => time.value))].sort();
    return { ...selected(first, 'clinical', first.evidence), eventDate: dates[0]!, endDate: dates.length > 1 ? dates.at(-1)! : null,
      hasExplicitRange: dates.length > 1 };
  }
  const reportTimes = sources.map((source) => selectedReportIssuedTime(source, false));
  if (reportTimes.every((time) => time !== null)) return projectConsistentSourceTimes(sources, sources.map(() => false));
  const dates = [...new Set(observationDates)].sort();
  const start = dates[0]; const end = dates.at(-1);
  const spanDays = start && end ? Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) : null;
  return start && (dates.length === 1 || spanDays !== null && spanDays <= 14)
    ? { ...unknown(), eventDate: start, endDate: end !== start ? end! : null, eventPrecision: 'day' } : unknown();
}
