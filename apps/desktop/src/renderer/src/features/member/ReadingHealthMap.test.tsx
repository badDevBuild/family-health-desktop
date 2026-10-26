// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BodySystemSummaryV2 } from '@contracts';
import { ReadingHealthMap } from './ReadingHealthMap.js';

afterEach(cleanup);
const system = (id: BodySystemSummaryV2['id'], shortName: string, status: BodySystemSummaryV2['status'], factCount = 2): BodySystemSummaryV2 => ({
  id, name: shortName, shortName, status, factCount, metricCount: 1, attentionCount: 0, latestDate: null,
  analysisStatus: 'current', topics: [], summary: '完整解释仍由原来的健康解读提供。'
});

describe('身体情况的阅读地图', () => {
  it('只按已发布状态分组，明确未提示问题的范围，不构造健康总分或确定病因', () => {
    const onSelectSystem = vi.fn();
    const systems = [system('cardiovascular', '心血管', 'attention'), system('hepatobiliary', '肝胆', 'no_signal_in_scope'),
      system('digestive', '消化', 'monitor'), system('dermatological', '皮肤', 'insufficient', 0)];
    render(<ReadingHealthMap systems={systems} onSelectSystem={onSelectSystem} />);
    expect(within(screen.getByRole('region', { name: '值得留意' })).getAllByRole('button')).toHaveLength(2);
    expect(within(screen.getByRole('region', { name: '本次未提示问题' })).getByText('肝胆')).toBeTruthy();
    expect(screen.getByText('只说明已有检查的范围，不等于全身都正常。')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: '尚无相关检查' })).getByText('皮肤')).toBeTruthy();
    expect(onSelectSystem).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '查看消化：值得留意' }));
    expect(onSelectSystem).toHaveBeenCalledExactlyOnceWith('digestive');
    expect(systems.map((item) => item.status)).toEqual(['attention', 'no_signal_in_scope', 'monitor', 'insufficient']);
  });

  it('缺少检查记录不能因为错误的正常状态成为绿色结果，无回调时仅静态显示', () => {
    render(<ReadingHealthMap compact systems={[system('dermatological', '皮肤', 'stable', 0)]} />);
    expect(screen.queryByRole('region', { name: '本次未提示问题' })).toBeNull();
    expect(screen.getByRole('region', { name: '尚无相关检查' }).textContent).toContain('皮肤');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('已有事实但整体判断不完整时显示记录入口，不混同尚无检查或推断正常和异常', () => {
    const onSelectSystem = vi.fn();
    render(<ReadingHealthMap onSelectSystem={onSelectSystem} systems={[
      { ...system('cardiovascular', '心血管', 'building'), interpretationState: 'partial' },
      { ...system('digestive', '消化', 'insufficient'), interpretationState: 'unavailable' },
      system('dermatological', '皮肤', 'insufficient', 0)
    ]} />);
    const recorded = screen.getByRole('region', { name: '已有检查记录' });
    expect(within(recorded).getByText('心血管')).toBeTruthy();
    expect(within(recorded).getByText('消化')).toBeTruthy();
    expect(recorded.textContent).toContain('暂不能概括整个系统的情况');
    expect(screen.getByRole('region', { name: '尚无相关检查' }).textContent).not.toContain('消化');
    expect(screen.queryByRole('region', { name: '本次未提示问题' })).toBeNull();
    expect(screen.queryByRole('region', { name: '值得留意' })).toBeNull();
    fireEvent.click(within(recorded).getByRole('button', { name: '查看消化：已有检查记录' }));
    expect(onSelectSystem).toHaveBeenCalledExactlyOnceWith('digestive');
  });

  it('四种范围可以同时出现，每个系统只进入一个组', () => {
    const { container } = render(<ReadingHealthMap systems={[
      system('cardiovascular', '心血管', 'attention'), system('hepatobiliary', '肝胆', 'stable'),
      system('digestive', '消化', 'building'), system('dermatological', '皮肤', 'insufficient', 0)
    ]} />);
    expect(container.querySelector('.reading-health-map__groups--four')).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    for (const name of ['心血管', '肝胆', '消化', '皮肤']) expect(screen.getAllByText(name)).toHaveLength(1);
  });

  it('家庭紧凑地图和成员地图对同一资料使用相同的分组，不因切换展示改变原状态', () => {
    const systems = [system('cardiovascular', '心血管', 'building'), system('dermatological', '皮肤', 'insufficient', 0)];
    const before = JSON.stringify(systems);
    const { rerender } = render(<ReadingHealthMap systems={systems} />);
    const groupNames = () => screen.getAllByRole('region').slice(1).map((region) => region.getAttribute('aria-label'));
    const expected = groupNames();
    rerender(<ReadingHealthMap compact systems={systems} />);
    expect(groupNames()).toEqual(expected);
    expect(JSON.stringify(systems)).toBe(before);
  });
});
