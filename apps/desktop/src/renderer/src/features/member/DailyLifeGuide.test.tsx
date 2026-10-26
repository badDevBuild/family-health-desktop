// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LifestylePlanV2 } from '@contracts';
import { DailyLifeGuide } from './DailyLifeGuide.js';
import type { DailyLifeItem } from './daily-life-content.js';

afterEach(cleanup);

const item = (id: string, domain: DailyLifeItem['domain']): DailyLifeItem => ({ id, domain, title: `建议${id}` });
const renderGuide = (items: DailyLifeItem[]) => render(<DailyLifeGuide items={items} stale={false} hasAdvice hasPlans={false}
  onRefresh={vi.fn()} renderItem={(entry) => <article key={entry.id} data-testid={entry.id}><h4>{entry.title}</h4><p>完整内容{entry.id}</p></article>}
  medicalAdvice={<section aria-label="复查与就医"><h3>医生安排</h3></section>} />);

describe('日常生活首页入口', () => {
  it('五类建议导航可以直接到对应正文，不自动刷新、采纳或改变计划', () => {
    const onRefresh = vi.fn();
    const scroll = vi.fn();
    render(<DailyLifeGuide items={[item('diet1', 'diet')]} stale={false} hasAdvice hasPlans={false} onRefresh={onRefresh}
      renderItem={(entry) => <article key={entry.id}>{entry.title}</article>} />);
    const topic = screen.getByRole('region', { name: '饮食与摄入' });
    Object.defineProperty(topic, 'scrollIntoView', { value: scroll });
    const navigation = screen.getByRole('navigation', { name: '五类日常生活建议' });
    expect(within(navigation).getAllByRole('button')).toHaveLength(5);
    expect(within(navigation).getAllByText('尚无建议')).toHaveLength(4);
    fireEvent.click(within(navigation).getByRole('button', { name: '饮食与摄入 1 项建议' }));
    expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: 'start' });
    expect(document.activeElement).toBe(topic);
    expect(onRefresh).not.toHaveBeenCalled();
  });
  it('先覆盖三个不同主题，不让连续饮食建议占满入口，并保留五域完整正文与后置医疗安排', () => {
    const items = [item('diet1', 'diet'), item('diet2', 'diet'), item('diet3', 'diet'), item('move1', 'activity'),
      item('sleep1', 'sleep'), item('supp1', 'supplements'), item('routine1', 'daily_routine')];
    const originalOrder = items.map((entry) => entry.id);
    renderGuide(items);
    const shortcuts = screen.getByRole('heading', { name: '先从这些小事开始' }).parentElement!;
    expect(within(shortcuts).getAllByRole('button').map((button) => button.textContent)).toEqual([
      '饮食与摄入：建议diet1', '运动与活动：建议move1', '睡眠与休息：建议sleep1'
    ]);
    for (const entry of items) expect(screen.getByTestId(entry.id).textContent).toContain(`完整内容${entry.id}`);
    expect(within(screen.getByRole('region', { name: '饮食与摄入' })).getAllByRole('article')).toHaveLength(3);
    const topics = ['饮食与摄入', '运动与活动', '睡眠与休息', '营养补充与保健品', '日常习惯与自我观察'];
    const medical = screen.getByRole('region', { name: '复查与就医' });
    for (const name of topics) expect(screen.getByRole('region', { name }).compareDocumentPosition(medical) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(items.map((entry) => entry.id)).toEqual(originalOrder);
  });

  it('主题不足三个时补入已有建议，暂不采纳的提案不占入口但正文仍保留', () => {
    const dismissed = { ...item('dismissed', 'diet'), proposal: { status: 'dismissed' } as LifestylePlanV2['proposals'][number] };
    const items = [dismissed, item('diet1', 'diet'), item('diet2', 'diet'), item('move1', 'activity'), item('diet3', 'diet')];
    renderGuide(items);
    const shortcuts = screen.getByRole('heading', { name: '先从这些小事开始' }).parentElement!;
    expect(within(shortcuts).getAllByRole('button').map((button) => button.textContent)).toEqual([
      '饮食与摄入：建议diet1', '运动与活动：建议move1', '饮食与摄入：建议diet2'
    ]);
    expect(screen.getByTestId('dismissed')).toBeTruthy();
    expect(screen.getAllByRole('article')).toHaveLength(items.length);
    expect(dismissed.proposal.status).toBe('dismissed');
  });
});
