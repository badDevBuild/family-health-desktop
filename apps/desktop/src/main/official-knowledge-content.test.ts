import { describe, expect, it } from 'vitest';
import { officialKnowledgeText } from './official-knowledge-content.js';

describe('官方网页静态正文', () => {
  it('网页头部很长时正文仍完整进入有限上下文，不执行脚本或选取支持关键词', () => {
    const html = `<html><head><script>${'metadata'.repeat(5000)}</script></head><body><nav>Navigation</nav>
      <main><h1>Fictional guidance</h1><p>Required condition &amp; uncertainty.</p>
      <aside>Important exception remains.</aside></main><footer>Footer</footer></body></html>`;
    const result = officialKnowledgeText(html, 'text/html; charset=utf-8');
    expect(result.contentScope).toBe('main');
    expect(result.content).toContain('Required condition & uncertainty.');
    expect(result.content).toContain('Important exception remains.');
    for (const value of ['metadata', 'Navigation', 'Footer', '<main>']) expect(result.content).not.toContain(value);
  });

  it('保留表头、行列顺序和否定，不把不同单元格连在一起', () => {
    const result = officialKnowledgeText('<main><table><caption>Fictional table</caption><tr><th>Condition</th><th>Meaning</th></tr>'
      + '<tr><td>Not present</td><td>Do not infer</td></tr></table></main>', 'text/html');
    expect(result.content).toContain('Condition\tMeaning');
    expect(result.content).toContain('Not present\tDo not infer');
  });

  it('只有一个 article 时用其正文；多个容器不能漏掉第二段', () => {
    expect(officialKnowledgeText('<article>One</article>', 'application/xhtml+xml')).toEqual({ content: 'One', contentScope: 'article' });
    expect(officialKnowledgeText('<article>One</article><article>Two</article>', 'text/html'))
      .toEqual({ content: 'One\n\nTwo', contentScope: 'body' });
    expect(officialKnowledgeText('<main>One</main><main>Two</main>', 'text/html').content).toContain('Two');
    expect(officialKnowledgeText('<main><article>One</article></main><main>Two</main>', 'text/html'))
      .toEqual({ content: 'One\n\nTwo', contentScope: 'body' });
  });

  it('空白首列不移动相邻结果，深层 HTML 不导致综合流程栈溢出', () => {
    const result = officialKnowledgeText('<main><table><tr><td></td><td>Second column</td></tr></table></main>', 'text/html');
    expect(result.content).toBe('\tSecond column\t');
    expect(officialKnowledgeText('<div>'.repeat(6000) + 'Deep source' + '</div>'.repeat(6000), 'text/html').content).toBe('Deep source');
  });

  it('纯文本不按 HTML 解析，空白页面或纯脚本不伪造正文', () => {
    expect(officialKnowledgeText('A < B\nDo not change.', 'text/plain').content).toBe('A < B\nDo not change.');
    expect(officialKnowledgeText('<script>invented support</script><main> </main>', 'text/html').content).toBe('');
  });
});
