import type { TrendSeries } from '@contracts';

export function TrendChart({ series, onSelectPoint }: {
  series: TrendSeries;
  onSelectPoint(pointIndex: number): void;
}) {
  const numeric = series.points
    .map((point, originalIndex) => ({ point, originalIndex }))
    .filter((entry) => entry.point.numericValue !== null);
  if (numeric.length === 0) return <div className="chart-empty">没有可比较的数值记录</div>;

  const values = numeric.map(({ point }) => point.numericValue!);
  const min = Math.min(...values) - 0.3;
  const max = Math.max(...values) + 0.3;
  const span = max - min || 1;
  const width = 560;
  const height = 150;
  const paddingX = 24;
  const paddingY = 20;
  const coordinates = numeric.map(({ point, originalIndex }, index) => ({
    x: paddingX + (index * (width - paddingX * 2)) / Math.max(numeric.length - 1, 1),
    y: paddingY + ((max - point.numericValue!) / span) * (height - paddingY * 2),
    originalIndex
  }));
  const path = coordinates.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');

  return (
    <div className="trend-chart" aria-label={`${series.name}趋势图`}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img">
        <title>{series.name}：{series.interpretation}</title>
        <path className="trend-chart__grid" d={`M ${paddingX} ${height - paddingY} H ${width - paddingX}`} />
        <path className="trend-chart__line" d={path} />
        {coordinates.map((point) => (
          <g
            key={series.points[point.originalIndex]?.date}
            role="button"
            tabIndex={0}
            aria-label={`查看 ${series.points[point.originalIndex]?.date} 的证据`}
            onClick={() => onSelectPoint(point.originalIndex)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') onSelectPoint(point.originalIndex);
            }}
          >
            <circle className="trend-chart__point" cx={point.x} cy={point.y} r="6" />
            <text x={point.x} y={height - 2} textAnchor="middle">{series.points[point.originalIndex]?.date.slice(0, 4)}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}
