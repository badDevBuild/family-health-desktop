import type { MetricSeriesSummary, TrendPointV2 } from '@contracts';

const WIDTH = 760;
const HEIGHT = 250;
const PADDING = { left: 52, right: 24, top: 24, bottom: 42 };
const abnormalFlagLabels: Record<TrendPointV2['abnormalFlag'], string> = {
  high: '偏高', low: '偏低', positive: '阳性', negative: '阴性', normal: '正常', unknown: '未标记'
};

function xFor(point: TrendPointV2, timestamps: number[]): number {
  if (point.timestamp === null || timestamps.length === 0) return PADDING.left;
  const min = Math.min(...timestamps);
  const max = Math.max(...timestamps);
  if (min === max) return WIDTH / 2;
  return PADDING.left + ((point.timestamp - min) / (max - min)) * (WIDTH - PADDING.left - PADDING.right);
}

export function MemberTrendChart({ series }: { series: MetricSeriesSummary }) {
  const exact = series.points.filter((point) => point.timestamp !== null && point.numericValue !== null);
  if (exact.length === 0) {
    return <div className="member-trend-empty">没有可按时间绘制的精确数值；带“&lt; / &gt;”的结果会保留在表格中，但不会伪装成点。</div>;
  }
  const values = exact.flatMap((point) => [point.numericValue!, point.referenceLow, point.referenceHigh].filter((value): value is number => value !== null));
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const padding = Math.max((rawMax - rawMin) * 0.12, Math.abs(rawMax || 1) * 0.04, 0.1);
  const min = rawMin - padding;
  const max = rawMax + padding;
  const yFor = (value: number) => PADDING.top + ((max - value) / (max - min)) * (HEIGHT - PADDING.top - PADDING.bottom);
  const timestamps = exact.map((point) => point.timestamp!);
  // 只连接原始序列中相邻的精确点。界限值、缺失值或不可比记录会显式打断折线，
  // 避免用一条线跨过未知的中间状态。
  const pointIndex = new Map(series.points.map((point, index) => [point.id, index]));
  const dataSegments = exact.slice(1).flatMap((point, index) => {
    const previous = exact[index]!;
    return pointIndex.get(point.id) === (pointIndex.get(previous.id) ?? -2) + 1
      ? [[previous, point] as const]
      : [];
  });
  const referenceSegments = (key: 'referenceHigh' | 'referenceLow') => exact.slice(1).flatMap((point, index) => {
    const previous = exact[index]!;
    return pointIndex.get(point.id) === (pointIndex.get(previous.id) ?? -2) + 1
      && previous[key] !== null && point[key] !== null
      ? [[previous, point] as const]
      : [];
  });
  const ticks = [max, (max + min) / 2, min];
  const visibleDateLabels = new Set<number>();
  let lastMonth = '';
  exact.forEach((point, index) => {
    const month = point.time.value?.slice(0, 7) ?? '';
    if (index === 0 || index === exact.length - 1 || month !== lastMonth) visibleDateLabels.add(index);
    lastMonth = month;
  });

  return <div className="member-trend-chart" aria-label={`${series.name}按真实日期间距绘制的趋势图，单位 ${series.unit ?? '未记录'}`}>
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img">
      <title>{series.name}趋势；单位 {series.unit ?? '未记录'}；横轴按真实日期间隔，纵轴随可见数据自适应</title>
      {ticks.map((tick) => <g key={tick}><line x1={PADDING.left} x2={WIDTH - PADDING.right} y1={yFor(tick)} y2={yFor(tick)} className="trend-grid-line" /><text x={PADDING.left - 8} y={yFor(tick) + 4} textAnchor="end">{tick.toFixed(2).replace(/\.00$/, '')}</text></g>)}
      {referenceSegments('referenceHigh').map(([left, right]) => <path key={`high-${left.id}-${right.id}`} d={`M ${xFor(left, timestamps)} ${yFor(left.referenceHigh!)} L ${xFor(right, timestamps)} ${yFor(right.referenceHigh!)}`} className="trend-reference-line" />)}
      {referenceSegments('referenceLow').map(([left, right]) => <path key={`low-${left.id}-${right.id}`} d={`M ${xFor(left, timestamps)} ${yFor(left.referenceLow!)} L ${xFor(right, timestamps)} ${yFor(right.referenceLow!)}`} className="trend-reference-line" />)}
      {dataSegments.map(([left, right]) => <path key={`${left.id}-${right.id}`} d={`M ${xFor(left, timestamps)} ${yFor(left.numericValue!)} L ${xFor(right, timestamps)} ${yFor(right.numericValue!)}`} className="trend-data-line" />)}
      {exact.map((point, index) => <g key={point.id} tabIndex={0} role="img" aria-label={`${point.time.value ?? '日期未记录'}，${point.displayValue}${point.unit ? ` ${point.unit}` : ''}，报告标记 ${abnormalFlagLabels[point.abnormalFlag]}`}>
        <title>{point.time.value ?? '日期未记录'}：{point.displayValue}{point.unit ? ` ${point.unit}` : ''}</title>
        <circle cx={xFor(point, timestamps)} cy={yFor(point.numericValue!)} r="6" className={['high', 'low', 'positive'].includes(point.abnormalFlag) ? 'trend-dot is-attention' : 'trend-dot'} />
        {visibleDateLabels.has(index) && <text x={xFor(point, timestamps)} y={HEIGHT - 18} textAnchor="middle">{point.time.value}</text>}
      </g>)}
    </svg>
    <div className="member-trend-legend"><span><i className="is-value" />报告数值{series.unit ? `（${series.unit}）` : ''}</span>{(referenceSegments('referenceHigh').length > 0 || referenceSegments('referenceLow').length > 0) && <span><i className="is-reference" />各次报告参考边界</span>}<span>{series.trendFacts.statement}</span></div>
  </div>;
}
