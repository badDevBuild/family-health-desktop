import { parse, type DefaultTreeAdapterMap } from 'parse5';

type Node = DefaultTreeAdapterMap['node'];
export type OfficialContentScope = 'main' | 'article' | 'body' | 'plain';
const omitted = new Set(['head', 'script', 'style', 'template', 'nav', 'form', 'svg', 'canvas', 'iframe']);
const blocks = new Set(['p', 'div', 'section', 'article', 'main', 'aside', 'header', 'footer', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'caption', 'blockquote', 'pre', 'br', 'hr']);

/** 只转换网页的静态正文，不执行脚本、不生成医学摘要，也不按关键词挑选支持句。 */
export function officialKnowledgeText(decoded: string, contentType: string): { content: string; contentScope: OfficialContentScope } {
  if (/^text\/plain(?:\s*;|$)/i.test(contentType)) return { content: decoded, contentScope: 'plain' };
  const document = parse(decoded);
  const matches = { main: [] as Node[], article: [] as Node[], body: [] as Node[] };
  const pending: Node[] = [document];
  while (pending.length) {
    const node = pending.pop()!;
    if ('tagName' in node) {
      if (omitted.has(node.tagName)) continue;
      if (node.tagName === 'main' || node.tagName === 'article' || node.tagName === 'body') matches[node.tagName].push(node);
    }
    if ('childNodes' in node) for (const child of [...node.childNodes].reverse()) pending.push(child);
  }
  // 有多个正文容器时不任意选一个；回到 body 保留全部静态内容，范围在回执中明示。
  const contentScope: OfficialContentScope = matches.main.length === 1 ? 'main'
    : matches.main.length === 0 && matches.article.length === 1 ? 'article' : 'body';
  const root = matches[contentScope][0] ?? document;
  const parts: string[] = [];
  // 网页结构是不可信输入；迭代遍历避免深层标签耗尽 JS 调用栈。
  const stack: Array<{ node: Node; closing: boolean }> = [{ node: root, closing: false }];
  while (stack.length) {
    const { node, closing } = stack.pop()!;
    if (node.nodeName === '#text' && 'value' in node) { parts.push(node.value.replace(/\s+/g, ' ')); continue; }
    const tag = 'tagName' in node ? node.tagName : '';
    if (omitted.has(tag)) continue;
    if (closing) {
      // 保留空白单元格、列边界与原始顺序，不能把不同列的条件连成一句。
      if (tag === 'td' || tag === 'th') parts.push('\t');
      if (blocks.has(tag)) parts.push('\n');
      continue;
    }
    if (blocks.has(tag)) parts.push('\n');
    stack.push({ node, closing: true });
    if ('childNodes' in node) for (const child of [...node.childNodes].reverse()) stack.push({ node: child, closing: false });
  }
  return { content: parts.join('').replace(/ *\t */g, '\t').replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n').replace(/^[ \n]+|[ \n]+$/g, ''), contentScope };
}
