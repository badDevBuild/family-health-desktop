// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MemberOverviewV2 } from '@contracts';
import { ReadingPriorityPreview } from './ReadingPriorityPreview.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
type Issue = MemberOverviewV2['priorityIssues'][number];
const issue = (id: string, isHighPriority = false): Issue => ({ id, title: `合成主题${id}`,
  explanation: `这是${id}的完整已发布解释，需结合检查条件理解，不能据此诊断。`, nextStep: null,
  systemId: 'sensory_oral', isHighPriority, readingContext: [] });

describe('整体说明收起后的具体重点解读', () => {
  it('全部高影响事项不受三个普通主题的限额阻挡，并保持已发布原顺序', () => {
    const issues = [issue('普通一'), issue('重点一', true), issue('普通二'), issue('普通三'),
      issue('普通四'), issue('重点二', true), issue('重点三', true), issue('普通五')];
    const before = JSON.stringify(issues);
    render(<ReadingPriorityPreview issues={issues} />);
    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual([
      '合成主题普通一', '合成主题重点一', '合成主题普通二', '合成主题普通三', '合成主题重点二', '合成主题重点三'
    ]);
    expect(screen.getByText('另有2项关注事项，见完整解读')).toBeTruthy();
    expect(screen.queryByText('合成主题普通四')).toBeNull();
    expect(screen.queryByText('合成主题普通五')).toBeNull();
    expect(JSON.stringify(issues)).toBe(before);
  });

  it('完整保留长解释末尾的否定、时间、左右侧和检查条件，不生成医学摘要', () => {
    const title = '左右眼结果需要分别理解';
    const explanation = `${'这是已发布的检查背景说明。'.repeat(70)}\n左眼仅有2024年的检查，右眼是2026年的结果；本次未散瞳，不能说明左眼目前正常，也不能据此确定右眼屈光状态。`;
    render(<ReadingPriorityPreview issues={[{ ...issue('长解释'), title, explanation }]} />);
    const article = screen.getByRole('article');
    expect(within(article).getByRole('heading', { level: 3 }).textContent).toBe(title);
    expect(article.querySelector('p')?.textContent).toBe(explanation);
    expect(article.textContent).toContain('不能说明左眼目前正常，也不能据此确定右眼屈光状态。');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('只用既有纯展示规则清理工程文字和 HTTPS 链接，保留标签里的限制', () => {
    render(<ReadingPriorityPreview issues={[{ ...issue('引用'), title: '已接纳的左右眼检查',
      explanation: '参见[只有旧记录，不能说明现在](https://example.com/history)。右眼本次未散瞳，不能据此确认屈光状态。' }]} />);
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('左右眼检查');
    expect(screen.getByText('参见只有旧记录，不能说明现在。右眼本次未散瞳，不能据此确认屈光状态。')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('空输入或清理后无标题不输出，空标题也不占普通主题额度或省略数量', () => {
    const { container, rerender } = render(<ReadingPriorityPreview issues={[]} onOpenOverview={vi.fn()} />);
    expect(container.innerHTML).toBe('');
    rerender(<ReadingPriorityPreview issues={[{ ...issue('空白'), title: ' \n ' }, { ...issue('工程'), title: '本轮检查全部通过' }]} />);
    expect(container.innerHTML).toBe('');
    rerender(<ReadingPriorityPreview issues={[{ ...issue('空白'), title: ' ' }, issue('一'), issue('二'), issue('三'), issue('四')]} />);
    expect(screen.getAllByRole('article')).toHaveLength(3);
    expect(screen.getByText('另有1项关注事项，见完整解读')).toBeTruthy();
  });

  it('导航按钮独立于标题和解释，点击只调用系统回调，不进行发送或改变数据', () => {
    const onSelectSystem = vi.fn();
    const onOpenOverview = vi.fn();
    const send = vi.fn();
    const fetch = vi.fn();
    vi.stubGlobal('healthDesktop', { processNow: send });
    vi.stubGlobal('fetch', fetch);
    const issues = [issue('入口')];
    const before = JSON.stringify(issues);
    render(<ReadingPriorityPreview issues={issues} onSelectSystem={onSelectSystem} onOpenOverview={onOpenOverview} />);
    expect(onSelectSystem).not.toHaveBeenCalled();
    const button = screen.getByRole('button', { name: '查看完整解读：合成主题入口' });
    expect(button.textContent).not.toContain(issues[0]!.explanation);
    expect(screen.queryByRole('button', { name: '合成主题入口' })).toBeNull();
    fireEvent.click(button);
    expect(onSelectSystem).toHaveBeenCalledExactlyOnceWith('sensory_oral');
    expect(onOpenOverview).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(issues)).toBe(before);
  });

  it('无系统导航时保留静态文章，并可通过独立总入口打开完整解读', () => {
    const onOpenOverview = vi.fn();
    render(<ReadingPriorityPreview issues={[issue('静态')]} onOpenOverview={onOpenOverview} />);
    expect(screen.getByRole('region', { name: '已发布的重点主题' })).toBeTruthy();
    expect(screen.getByRole('article').textContent).toContain('这是静态的完整已发布解释');
    expect(within(screen.getByRole('article')).queryByRole('button')).toBeNull();
    expect(onOpenOverview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '查看完整整体解读' }));
    expect(onOpenOverview).toHaveBeenCalledExactlyOnceWith();
    expect(screen.queryByText(/另有\d+项/)).toBeNull();
  });

  it('完整展示额外解释和系统限制，仅精确去重，不拆掉末尾条件或否定', () => {
    const explanation = '左眼和右眼的检查结果不同，不能混为一条记录。';
    const rationale = '左眼记录来自2024年，右眼记录来自2026年；现有资料不能说明左眼现在正常。';
    const limitations = `${'检查背景需要单独说明。'.repeat(50)}本次未散瞳，不能据此确认右眼屈光状态。`;
    render(<ReadingPriorityPreview issues={[{ ...issue('完整条件'), explanation,
      readingContext: [explanation, rationale, limitations, rationale] }]} />);
    expect([...screen.getByRole('article').querySelectorAll('p')].map((paragraph) => paragraph.textContent))
      .toEqual([explanation, rationale, limitations]);
  });

  it('默认只展开主题，完整解释与条件在同一个可展开单元中，不让长文挤走其他主题', () => {
    render(<ReadingPriorityPreview issues={[issue('主题一'), issue('主题二')]} />);
    for (const article of screen.getAllByRole('article')) {
      const details = article.querySelector('details')!;
      expect(details.hasAttribute('open')).toBe(false);
      expect(details.querySelector('summary')?.textContent).toBe('查看解释与适用条件');
      expect(details.querySelector('p')?.textContent).toContain('不能据此诊断');
    }
    const first = screen.getAllByRole('article')[0]!.querySelector('details')!;
    fireEvent.click(first.querySelector('summary')!);
    expect(first.hasAttribute('open')).toBe(true);
    expect(first.querySelector('p')?.textContent).toBe(issue('主题一').explanation);
  });

  it('旧投影未声明完整上下文时只展示完整主题导航，不孤立展示 explanation', () => {
    const onSelectSystem = vi.fn();
    const oldIssue = { ...issue('旧主题'), readingContext: undefined };
    const newIssue = issue('新主题');
    render(<ReadingPriorityPreview issues={[oldIssue, newIssue]} onSelectSystem={onSelectSystem} />);
    const articles = screen.getAllByRole('article');
    expect(within(articles[0]!).getByRole('heading', { level: 3 }).textContent).toBe(oldIssue.title);
    expect(articles[0]!.querySelector('p')).toBeNull();
    expect(screen.queryByText(oldIssue.explanation)).toBeNull();
    expect(articles[1]!.querySelector('p')?.textContent).toBe(newIssue.explanation);
    fireEvent.click(within(articles[0]!).getByRole('button', { name: `查看完整解读：${oldIssue.title}` }));
    expect(onSelectSystem).toHaveBeenCalledExactlyOnceWith('sensory_oral');
  });
});
