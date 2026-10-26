import { describe, expect, it } from 'vitest';
import { assessmentOverviewText } from './assessment-overview-text.js';

describe('整体概况引用的纯文本展示', () => {
  it('HTTPS Markdown只显示完整标签，医学解释、日期和末尾否定不变', () => {
    const text = '2025年结果需要结合检测背景理解，参见[医学资料A](https://example.com/source?a=1&b=2)。\n本次未散瞳，不能据此确认屈光状态。';
    expect(assessmentOverviewText(text)).toBe('2025年结果需要结合检测背景理解，参见医学资料A。\n本次未散瞳，不能据此确认屈光状态。');
  });

  it('链接标签本身含医学条件时不删标签里的限制', () => {
    expect(assessmentOverviewText('[只有旧记录，不能说明现在](https://example.com/history)；仍需结合症状。'))
      .toBe('只有旧记录，不能说明现在；仍需结合症状。');
  });

  it.each(['javascript:alert(1)', 'data:text/html,test', 'file:///Users/example/record', 'http://example.com/source'])('不解析或执行非支持URL：%s', (url) => {
    const text = `只作纯文本显示[资料](${url})，不能确定病因。`;
    expect(assessmentOverviewText(text)).toBe(text);
  });

  it('HTML、图片、损坏链接及认证URL不被解释为点击内容，也不裁掉正文', () => {
    const text = '<img src=x onerror=alert(1)>\n![图像](https://example.com/a)\n[损坏](https://)\n[资料](https://user:pass@example.com/source)\n不能据此概括未检查的身体情况。';
    expect(assessmentOverviewText(text)).toBe(text);
  });
});
