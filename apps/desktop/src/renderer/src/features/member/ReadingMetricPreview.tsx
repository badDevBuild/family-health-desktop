import type { MetricSeriesSummary, TrendPointV2 } from '@contracts';
import { formatResult } from './metric-presentation.js';

/** 列表中的小图只取同一严格分组；它不把上升/下降再解释成变好/变坏。 */
export function ReadingMetricPreview({ series }: { series: MetricSeriesSummary[] }) {
  // 多组条件即使单位相同，也不能拼成一条更好看的线。
  if (series.length !== 1) return null;
  const selected = series[0]!;
  const usable = (point: TrendPointV2) => point.comparable && point.comparator === 'eq'
    && point.timestamp !== null && Number.isFinite(point.timestamp)
    && point.numericValue !== null && Number.isFinite(point.numericValue)
    && point.unit === selected.unit;
  const exact = selected.points.filter(usable);
  if (exact.length < 2) return null;
  const ordered = [...exact].sort((left, right) => left.timestamp! - right.timestamp!);
  const minTime = ordered[0]!.timestamp!;
  const maxTime = ordered.at(-1)!.timestamp!;
  if (minTime === maxTime) return null;
  const values = exact.map((point) => point.numericValue!);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const valueSpan = maxValue - minValue || Math.max(Math.abs(minValue) * .1, 1);
  const x = (point: TrendPointV2) => 8 + (point.timestamp! - minTime) / (maxTime - minTime) * 124;
  const y = (point: TrendPointV2) => 43 - (point.numericValue! - minValue) / valueSpan * 31;
  const timeCounts = new Map<number, number>();
  exact.forEach((point) => timeCounts.set(point.timestamp!, (timeCounts.get(point.timestamp!) ?? 0) + 1));
  const segments = selected.points.slice(1).flatMap((point, index) => {
    const previous = selected.points[index]!;
    if (!usable(previous) || !usable(point) || previous.timestamp! >= point.timestamp!
      || timeCounts.get(previous.timestamp!) !== 1 || timeCounts.get(point.timestamp!) !== 1) return [];
    return [{ id: `${previous.id}-${point.id}`, path: `M ${x(previous)} ${y(previous)} L ${x(point)} ${y(point)}` }];
  });
  const first = ordered[0]!;
  const latest = ordered.at(-1)!;
  // 可用数值不等于检测条件齐全；保留有条件序列，同时把限制带到新的阅读入口。
  const conditional = selected.trendFacts.status === 'conditional'
    || exact.some((point) => point.comparabilityReasons.includes('comparison_context_unknown'));
  const conditionText = conditional ? `有条件比较：${[...new Set(selected.trendFacts.reasons)].join(' ') || '请点开指标查看各次记录和比较限制。'}` : '';
  const equivalent = `${ordered.map((point) => `${point.time.displayLabel} ${formatResult(point.displayValue, point.unit)}`).join('；')}。共 ${exact.length} 次${conditional ? '有条件比较' : '可比较'}记录，按真实日期间隔绘制，不代表变化的健康好坏。${conditionText}`;
  return <span className="reading-metric-preview" role="img" aria-label={`${selected.name}变化速览：${equivalent}`}>
    <svg viewBox="0 0 140 56" aria-hidden="true" focusable="false">
      {segments.map((segment) => <path key={segment.id} d={segment.path} />)}
      {exact.map((point) => <circle key={point.id} cx={x(point)} cy={y(point)} r="3" />)}
    </svg>
    <span className="reading-metric-preview__dates" aria-hidden="true"><span>{first.time.value?.slice(0, 7)}</span><span>{latest.time.value?.slice(0, 7)}</span></span>
    {conditional && <span className="reading-metric-preview__condition" aria-hidden="true">有条件比较，点开查看限制</span>}
  </span>;
}
