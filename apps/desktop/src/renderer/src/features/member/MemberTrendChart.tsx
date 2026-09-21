import type { MetricSeriesSummary, TrendPointV2 } from '@contracts';

const WIDTH = 760;
const HEIGHT = 250;
const PADDING = { left: 52, right: 24, top: 24, bottom: 42 };

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
  const path = exact.map((point, index) => `${index === 0 ? 'M' : 'L'} ${xFor(point, timestamps)} ${yFor(point.numericValue!)}`).join(' ');
  const referenceHigh = exact.filter((point) => point.referenceHigh !== null);
  const referenceLow = exact.filter((point) => point.referenceLow !== null);
  const referencePath = (points: TrendPointV2[], key: 'referenceHigh' | 'referenceLow') => points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${xFor(point, timestamps)} ${yFor(point[key]!)}`).join(' ');
  const ticks = [max, (max + min) / 2, min];

  return <div className="member-trend-chart" aria-label={`${series.name}按真实日期间距绘制的趋势图`}>
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img">
      <title>{series.name}趋势；横轴按真实日期间隔，纵轴随可见数据自适应</title>
      {ticks.map((tick) => <g key={tick}><line x1={PADDING.left} x2={WIDTH - PADDING.right} y1={yFor(tick)} y2={yFor(tick)} className="trend-grid-line" /><text x={PADDING.left - 8} y={yFor(tick) + 4} textAnchor="end">{tick.toFixed(2).replace(/\.00$/, '')}</text></g>)}
      {referenceHigh.length >= 2 && <path d={referencePath(referenceHigh, 'referenceHigh')} className="trend-reference-line" />}
      {referenceLow.length >= 2 && <path d={referencePath(referenceLow, 'referenceLow')} className="trend-reference-line" />}
      {exact.length >= 2 && <path d={path} className="trend-data-line" />}
      {exact.map((point) => <g key={point.id}>
        <circle cx={xFor(point, timestamps)} cy={yFor(point.numericValue!)} r="6" className={['high', 'low', 'positive'].includes(point.abnormalFlag) ? 'trend-dot is-attention' : 'trend-dot'} />
        <text x={xFor(point, timestamps)} y={HEIGHT - 18} textAnchor="middle">{point.time.value?.slice(0, 7)}</text>
      </g>)}
    </svg>
    <div className="member-trend-legend"><span><i className="is-value" />报告数值</span>{(referenceHigh.length >= 2 || referenceLow.length >= 2) && <span><i className="is-reference" />各次报告参考边界</span>}<span>{series.trendFacts.statement}</span></div>
  </div>;
}
