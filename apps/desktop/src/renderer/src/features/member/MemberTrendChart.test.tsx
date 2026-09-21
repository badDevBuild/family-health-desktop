// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { MetricSeriesSummary, TrendPointV2 } from '@contracts';
import { MemberTrendChart } from './MemberTrendChart.js';

function point(id: string, date: string, value: number, comparator: TrendPointV2['comparator'] = 'eq'): TrendPointV2 {
  return {
    id,
    observationId: `observation-${id}`,
    time: {
      value: date,
      endValue: null,
      precision: 'day',
      role: 'measurement',
      source: 'explicit',
      displayLabel: date
    },
    timestamp: Date.parse(`${date}T00:00:00Z`),
    displayValue: `${comparator === 'lt' ? '<' : ''}${value}`,
    numericValue: comparator === 'eq' ? value : null,
    comparator,
    unit: 'mmol/L',
    referenceLow: 0,
    referenceHigh: 3.4,
    abnormalFlag: value > 3.4 ? 'high' : 'normal',
    comparable: comparator === 'eq',
    comparabilityReasons: comparator === 'eq' ? [] : ['界限值不能当作精确点'],
    evidence: {
      id: `evidence-${id}`,
      kind: 'observation',
      observationId: `observation-${id}`,
      eventId: null,
      documentId: `document-${id}`,
      sourceSpanId: `span-${id}`,
      knowledgeId: null,
      label: '报告原文',
      locator: date,
      quote: `LDL ${value}`
    }
  };
}

function series(points: TrendPointV2[]): MetricSeriesSummary {
  return {
    id: 'ldl-series',
    conceptId: 'lipid-ldl-c',
    name: '低密度脂蛋白胆固醇',
    unit: 'mmol/L',
    latestValue: points.at(-1)?.displayValue ?? null,
    latestDate: points.at(-1)?.time.value ?? null,
    latestAbnormalFlag: points.at(-1)?.abnormalFlag ?? 'unknown',
    mappingStatus: 'verified',
    trendFacts: {
      status: 'comparable',
      direction: 'increasing',
      pointCount: points.length,
      usablePointCount: points.filter((item) => item.numericValue !== null).length,
      spanDays: 10,
      firstValue: 3,
      latestValue: 4,
      absoluteChange: 1,
      relativeChangePercent: 33.3,
      latestChange: 0.5,
      segmentDirections: ['up', 'up'],
      reportedFlagChanges: 1,
      referenceBoundaryCrossings: 1,
      reasons: ['相同单位与检测条件'],
      statement: '三个可比时间点显示数值上升。'
    },
    points
  };
}

afterEach(cleanup);

describe('MemberTrendChart', () => {
  it('横轴按真实日期间隔，而不是把每次检查等距排列', () => {
    const { container } = render(<MemberTrendChart series={series([
      point('one', '2026-01-01', 3),
      point('two', '2026-01-02', 3.2),
      point('three', '2026-01-11', 4)
    ])} />);

    const circles = [...container.querySelectorAll('circle')];
    const positions = circles.map((circle) => Number(circle.getAttribute('cx')));
    expect(positions).toHaveLength(3);
    expect(positions[1]! - positions[0]!).toBeLessThan((positions[2]! - positions[1]!) / 5);
    expect(screen.getByLabelText(/低密度脂蛋白胆固醇按真实日期间距绘制的趋势图/)).toBeTruthy();
  });

  it('界限值只保留在表格语义中，不伪装成精确趋势点', () => {
    render(<MemberTrendChart series={series([point('bounded', '2026-01-01', 0.1, 'lt')])} />);
    expect(screen.getByText(/带“< \/ >”的结果会保留在表格中/)).toBeTruthy();
  });

  it('精确值之间出现界限值时打断折线', () => {
    const { container } = render(<MemberTrendChart series={series([
      point('before', '2026-01-01', 3),
      point('bounded-middle', '2026-01-02', 3.5, 'lt'),
      point('after', '2026-01-03', 4)
    ])} />);
    expect(container.querySelectorAll('path.trend-data-line')).toHaveLength(0);
    expect(screen.getByLabelText(/2026-01-01，3 mmol\/L/)).toBeTruthy();
    expect(screen.getByLabelText(/2026-01-03，4 mmol\/L/)).toBeTruthy();
  });
});
