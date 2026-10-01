// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BodySystemDetailV2, BodySystemSummaryV2, MetricSeriesDetailV2 } from '@contracts';
import { bodySystemRegistry, buildMetricSeries, type TrendObservationInput } from '@core';
import { cardiovascularLongitudinalFixture } from '../../../../../../../packages/test-fixtures/src/member-v2.js';
import { createDemoSnapshot } from '../../../../../../../packages/test-fixtures/src/index.js';
import type { HealthDesktopBridge } from '../../../../preload/index.js';
import { MetricHistory } from './MetricHistory.js';
import { MemberProfileV2 } from './MemberProfileV2.js';
import { formatResult, groupMetricSeries, isUnprovidedResult } from './metric-presentation.js';

function fixture() {
  const observations = cardiovascularLongitudinalFixture.map((item, index) => ({
    ...item, method: index === 0 ? null : item.method
  })) as TrendObservationInput[];
  return buildMetricSeries(observations).map((item): MetricSeriesDetailV2 => ({
    ...item, personId: 'person-fixture', systemIds: ['cardiovascular'], aliasesSeen: [item.name],
    comparisonConditions: { specimen: '血清', method: item.points.length === 1 ? null : '酶法', bodySite: null },
    tableRows: item.points
  }));
}

afterEach(() => { cleanup(); delete window.healthDesktop; });

describe('指标阅读分组', () => {
  it('进入详情时把标题滚入可见区域并移动键盘焦点，切换分组不再跳动', () => {
    const original = HTMLElement.prototype.scrollIntoView;
    const scroll = vi.fn();
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      const series = fixture();
      render(<MetricHistory series={series} onBack={vi.fn()} onOpenEvidence={vi.fn()} />);
      expect(scroll).toHaveBeenCalledWith({ block: 'start' });
      expect(document.activeElement).toBe(screen.getByRole('region', { name: '低密度脂蛋白胆固醇指标历史' }));
      fireEvent.change(screen.getByRole('combobox'), { target: { value: series[1]!.id } });
      expect(scroll).toHaveBeenCalledTimes(1);
    } finally { HTMLElement.prototype.scrollIntoView = original; }
  });

  it('同一指标只有一个入口，条件不同的序列和全部来源完整保留', () => {
    const series = fixture();
    const before = JSON.stringify(series);
    const groups = groupMetricSeries(series);
    expect(series).toHaveLength(2);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ pointCount: 3, latestDate: '2026-09-12', latestValue: '4.2 mmol/l', description: '共 3 条记录 · 分 2 组查看趋势' });
    expect(groups[0]!.series).toEqual(series);
    expect(JSON.stringify(series)).toBe(before);
  });

  it('只按已验证概念或精确原名分组，不把模型候选、左右侧或总量游离量混在一起', () => {
    const base = fixture()[0]!;
    const series = [
      { ...base, id: 'a', name: '左眼视力', conceptId: 'visual', mappingStatus: 'proposed' as const },
      { ...base, id: 'b', name: '右眼视力', conceptId: 'visual', mappingStatus: 'proposed' as const },
      { ...base, id: 'c', name: 'T4', conceptId: 't4' },
      { ...base, id: 'd', name: 'FT4', conceptId: 'ft4' }
    ];
    expect(groupMetricSeries(series)).toHaveLength(4);
    expect(groupMetricSeries([{ ...base, mappingStatus: 'unmapped', name: '原名 (A)' },
      { ...base, id: 'other', mappingStatus: 'unmapped', name: '原名（A）' }])).toHaveLength(1);
  });

  it('未知日期不会变成最新检查，同一天不同结果不任意选一个', () => {
    const series = fixture();
    const undated = { ...series[0]!.points[0]!, id: 'undated', timestamp: null, time: { ...series[0]!.points[0]!.time, value: null }, displayValue: '999' };
    series[0]!.points.push(undated);
    expect(groupMetricSeries(series)[0]).toMatchObject({ latestValue: '4.2 mmol/l', undatedCount: 1 });
    const latest = series.flatMap((item) => item.points).find((point) => point.time.value === '2026-09-12')!;
    series[0]!.points.push({ ...latest, id: 'same-day', displayValue: '4.3' });
    expect(groupMetricSeries(series)[0]!.latestValue).toBe('同日多条结果');
  });

  it.each([
    ['20mm', 'mm', '20mm'], ['约27cm/s', 'cm/s', '约27cm/s'], ['19:mm', 'mm', '19:mm'],
    ['4.2 MMOL/L', 'mmol/l', '4.2 MMOL/L'], ['8 μmol/L', 'umol/l', '8 μmol/L'],
    ['20', 'mm', '20 mm'], ['1mm', 'm', '1mm m'], ['0', null, '0'], [null, 'mm', '—']
  ])('结果 %s 与单位 %s 不重复拼接，也不修改原值', (value, unit, expected) => {
    expect(formatResult(value, unit)).toBe(expected);
  });

  it('只分离空白占位，不隐藏阴性、未见异常和零值', () => {
    for (const value of ['无数据', '未填写', '未检测', '—', '']) expect(isUnprovidedResult(value)).toBe(true);
    for (const value of ['阴性', '未见异常', '0', '未见明显异常声像', '无明显增大']) expect(isUnprovidedResult(value)).toBe(false);
  });

  it('详情保留全部历史，切换分组仅改变图表，原始依据仍能打开', () => {
    const series = fixture();
    const open = vi.fn();
    const { container } = render(<MetricHistory series={series} onBack={vi.fn()} onOpenEvidence={open} />);
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(within(table).getAllByRole('row')[1]!.textContent).toContain('2026-09-12');
    const picker = screen.getByRole('combobox', { name: '选择趋势分组' });
    fireEvent.change(picker, { target: { value: series.find((item) => item.points.length === 2)!.id } });
    expect(container.querySelectorAll('.trend-data-line')).toHaveLength(1);
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    fireEvent.click(within(table).getAllByRole('button', { name: '查看依据' })[0]!);
    expect(open).toHaveBeenCalledWith(expect.stringContaining('原始依据'), expect.objectContaining({ sourceSpanId: 'span-cv-2026' }));
  });
});

describe('身体指标入口端到端读模型', () => {
  function mount(failOne = false) {
    const series = fixture();
    const snapshot = createDemoSnapshot();
    const person = { ...snapshot.persons[0]!, id: 'person-fixture' };
    const summary = { id: 'cardiovascular', name: '心血管系统', shortName: '心血管', status: 'building', factCount: 3, summary: '已有检查记录' } as BodySystemSummaryV2;
    const point = series[0]!.points[0]!;
    const detail = { personId: person.id, registry: bodySystemRegistry[0]!, summary, analysis: null, metrics: series,
      findings: [{ id: 'blank', title: '趋势栏目', value: '无数据', time: point.time, abnormalFlag: 'unknown', evidence: [point.evidence] },
        { id: 'negative', title: '文字结果', value: '阴性', time: point.time, abnormalFlag: 'negative', evidence: [point.evidence] }],
      relatedEventIds: [], unmappedFactCount: 0 } as BodySystemDetailV2;
    const getMetricSeries = vi.fn(async (_person: string, id: string) => failOne && id === series[1]!.id
      ? { ok: false as const, error: { code: 'TEMPORARY', message: '合成错误' } }
      : { ok: true as const, data: series.find((item) => item.id === id)! });
    window.healthDesktop = {
      getMemberOverview: async () => ({ ok: true, data: { personId: person.id, systems: [summary], headline: '已有检查记录',
        sourceUrgentNotices: [], currentSymptomNotices: [], priorityIssues: [], importantChanges: [], recentChanges: [], nextActions: [], unclassifiedFactCount: 0 } }),
      listBodySystems: async () => ({ ok: true, data: [summary] }),
      listHealthEvents: async () => ({ ok: true, data: [] }),
      getLifestylePlan: async () => ({ ok: true, data: null }),
      getConceptReview: async () => ({ ok: true, data: null }),
      getBodySystemDetail: async () => ({ ok: true, data: detail }), getMetricSeries
    } as unknown as HealthDesktopBridge;
    render(<MemberProfileV2 snapshot={{ ...snapshot, persons: [person] }} person={person}
      onSelectPerson={vi.fn()} onOpenEvidence={vi.fn()} onAddPerson={vi.fn()} onEditPerson={vi.fn()}
      onArchivedPeople={vi.fn()} onAddNote={vi.fn()} onExport={vi.fn()} onImport={vi.fn()} onRefreshAssessment={vi.fn()}
      onExcludeDocument={vi.fn()} onReincludeDocument={vi.fn()} onDeleteDocument={vi.fn()} onDeletedDocuments={vi.fn()} />);
    return { getMetricSeries };
  }

  it('同名指标只显示一次，点击读取所有分组；空白项目默认折叠但不删除', async () => {
    const { getMetricSeries } = mount();
    fireEvent.click(await screen.findByRole('tab', { name: '身体与指标' }));
    const entry = await screen.findByRole('button', { name: /低密度脂蛋白胆固醇/ });
    expect(entry.textContent).toContain('共 3 条记录');
    expect(screen.getAllByRole('button', { name: /低密度脂蛋白胆固醇/ })).toHaveLength(1);
    expect(screen.getByText('阴性')).toBeTruthy();
    expect(screen.getByText(/原报告未提供结果（1 项）/).closest('details')?.open).toBe(false);
    fireEvent.click(entry);
    await screen.findByRole('table', { name: '低密度脂蛋白胆固醇历史记录' });
    expect(getMetricSeries).toHaveBeenCalledTimes(2);
  });

  it('某个分组读取失败时提示重试，不展示不完整历史', async () => {
    mount(true);
    fireEvent.click(await screen.findByRole('tab', { name: '身体与指标' }));
    fireEvent.click(await screen.findByRole('button', { name: /低密度脂蛋白胆固醇/ }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('部分历史暂时未能读取'));
    expect(screen.queryByRole('table')).toBeNull();
  });
});
