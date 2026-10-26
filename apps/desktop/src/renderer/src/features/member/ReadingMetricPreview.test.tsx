// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { MetricSeriesSummary, TrendPointV2 } from '@contracts';
import { ReadingMetricPreview } from './ReadingMetricPreview.js';

afterEach(cleanup);
function point(id: string, date: string, value: number): TrendPointV2 {
  return { id, observationId: id, time: { value: date, endValue: null, precision: 'day', role: 'exam', source: 'explicit', displayLabel: date },
    timestamp: Date.parse(`${date}T00:00:00Z`), displayValue: String(value), numericValue: value, comparator: 'eq', unit: 'mmol/L',
    referenceLow: null, referenceHigh: null, abnormalFlag: 'unknown', comparable: true, comparabilityReasons: [],
    evidence: { id, kind: 'observation', observationId: id, eventId: null, documentId: id, sourceSpanId: id, knowledgeId: null, label: '合成报告', locator: null, quote: '合成数据' } };
}
const series = (points: TrendPointV2[]) => ({ id: 'synthetic-series', name: '合成指标', unit: 'mmol/L', points,
  trendFacts: { status: 'comparable', reasons: [] } } as unknown as MetricSeriesSummary);

describe('数值入口的可访问微型趋势', () => {
  it('按真实日期间隔显示，同步给出数值文字，不把上升解释成变坏', () => {
    const { container } = render(<ReadingMetricPreview series={[series([point('a', '2026-01-01', 2), point('b', '2026-01-02', 3), point('c', '2026-01-11', 4)])]} />);
    const positions = [...container.querySelectorAll('circle')].map((circle) => Number(circle.getAttribute('cx')));
    expect(positions[1]! - positions[0]!).toBeLessThan((positions[2]! - positions[1]!) / 5);
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('2026-01-01 2 mmol/L；2026-01-02 3 mmol/L；2026-01-11 4 mmol/L');
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('不代表变化的健康好坏');
    expect(container.querySelectorAll('path')).toHaveLength(2);
  });

  it('不跨检测分组、不明确日期或界限值画一条伪趋势线', () => {
    const one = series([point('a', '2026-01-01', 2), point('b', '2026-01-02', 3)]);
    const { container, rerender } = render(<ReadingMetricPreview series={[one, { ...one, id: 'different-method' }]} />);
    expect(container.querySelector('svg')).toBeNull();
    rerender(<ReadingMetricPreview series={[series([point('a', '2026-01-01', 2), { ...point('limit', '2026-01-02', 3), comparator: 'lt' }, point('c', '2026-01-03', 4)])]} />);
    expect(container.querySelectorAll('circle')).toHaveLength(2);
    expect(container.querySelectorAll('path')).toHaveLength(0);
    rerender(<ReadingMetricPreview series={[series([point('a', '2026-01-01', 2), { ...point('unknown', '2026-01-02', 3), timestamp: null }])]} />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('同日两条结果和缺失检测单位都不任取一个连线', () => {
    const { container, rerender } = render(<ReadingMetricPreview series={[series([point('a', '2026-01-01', 2), point('b', '2026-01-02', 3), point('c', '2026-01-02', 4), point('d', '2026-01-03', 5)])]} />);
    expect(container.querySelectorAll('path')).toHaveLength(0);
    rerender(<ReadingMetricPreview series={[series([point('a', '2026-01-01', 2), { ...point('different-unit', '2026-01-02', 3), unit: null }, point('c', '2026-01-03', 4)])]} />);
    expect(container.querySelectorAll('circle')).toHaveLength(2);
    expect(container.querySelectorAll('path')).toHaveLength(0);
  });

  it('有条件比较保留数值和折线，显示详情入口并保留完整去重可访问限制', () => {
    const conditional = series([point('a', '2026-01-01', 2), point('b', '2026-02-01', 3)]);
    conditional.trendFacts = { ...conditional.trendFacts, status: 'conditional',
      reasons: ['部分标本、方法或部位未记录，因此比较结果需保留条件。', '两点只能说明前后差异，不能证明长期趋势。', '部分标本、方法或部位未记录，因此比较结果需保留条件。'] };
    const { container } = render(<ReadingMetricPreview series={[conditional]} />);
    expect(container.querySelectorAll('circle')).toHaveLength(2);
    expect(container.querySelectorAll('path')).toHaveLength(1);
    expect(screen.getByText('有条件比较，点开查看限制')).toBeTruthy();
    expect(container.textContent).not.toContain('部分标本、方法或部位未记录');
    const accessibleText = screen.getByRole('img').getAttribute('aria-label')!;
    expect(accessibleText).toContain('共 2 次有条件比较记录');
    expect(accessibleText).toContain('有条件比较：部分标本、方法或部位未记录，因此比较结果需保留条件。 两点只能说明前后差异，不能证明长期趋势。');
    expect(accessibleText.split('部分标本、方法或部位未记录')).toHaveLength(2);
  });

  it('点已标明检测条件缺失时也不无条件地声称可比较，不删除已有点', () => {
    const entries = [point('a', '2026-01-01', 2), point('b', '2026-02-01', 3)]
      .map((entry) => ({ ...entry, comparabilityReasons: ['comparison_context_unknown'] }));
    const { container } = render(<ReadingMetricPreview series={[series(entries)]} />);
    expect(container.querySelectorAll('circle')).toHaveLength(2);
    expect(screen.getByText('有条件比较，点开查看限制')).toBeTruthy();
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('请点开指标查看各次记录和比较限制。');
    expect(screen.getByRole('img').getAttribute('aria-label')).not.toContain('次可比较记录');
  });
});
