import { describe, expect, it } from 'vitest';
import type { SourceManifest, SourceSpan } from '@contracts';
import { reportFindingPageScope } from './report-source-page-scope.js';

function fixture() {
  const pages: SourceSpan[] = [1, 2, 3].map((page) => ({ id: `page-${page}`, documentId: 'doc', page,
    spanKind: 'image', blockId: null, lineStart: null, lineEnd: null, quote: null, readability: 'clear' }));
  const span = (id: string, page: number, role: 'finding' | 'date' | 'context' | 'heading' | 'instruction'): SourceSpan => ({
    ...pages[page - 1]!, id, spanKind: 'block', quote: '合成原件引用', modelEvidence: {
      version: 1, engine: 'codex-original-reading-v1', modelId: 'gpt-6.1-sol', threadId: 'synthetic', turnId: 'synthetic',
      originalSha256: 'a'.repeat(64), originalSourceObjectId: 'object', parentSourceSpanId: `page-${page}`, inputKind: 'image', role, clarity: 'clear' } });
  const manifest: SourceManifest = { id: 'manifest', sourceObjectId: 'object', sha256: 'a'.repeat(64), mediaType: 'application/pdf',
    originalDisplayName: 'synthetic.pdf', totalUnits: 3, coveredUnitIndexes: [0, 1, 2], normalizerVersion: 'synthetic',
    conversionWarnings: [], createdAt: '2026-01-01T00:00:00Z', spans: [...pages, span('result', 2, 'finding'),
      span('date', 1, 'date'), span('context', 3, 'context'), span('heading', 1, 'heading')] };
  const observation = { documentId: 'doc', sourceSpanId: 'result', evidence: ['result', 'date', 'context', 'heading']
    .map((sourceSpanId) => ({ sourceSpanId, quote: '合成原件引用' })) };
  return { manifest, observation, span };
}
describe('结果位置和日期背景分别限域', () => {
  it('日期、标题和背景页不扩大结果竞争范围', () => {
    const f = fixture(); expect(reportFindingPageScope(f.observation, f.manifest)?.pages).toEqual([2]);
  });
  it('跨页结果与医生原话仍完整保护', () => {
    const f = fixture(); f.manifest.spans.push(f.span('continued', 3, 'instruction'));
    f.observation.evidence.push({ sourceSpanId: 'continued', quote: '合成原件引用' });
    expect(reportFindingPageScope(f.observation, f.manifest)?.pages).toEqual([2, 3]);
  });
  it.each(['missing', 'wrong-document', 'wrong-object', 'wrong-page', 'primary-date'])('缺失或不可信%s不缩小范围', (kind) => {
    const f = fixture(); const result = f.manifest.spans.find((s) => s.id === 'result')!;
    if (kind === 'missing') f.manifest.spans = f.manifest.spans.filter((s) => s.id !== 'date');
    if (kind === 'wrong-document') result.documentId = 'other';
    if (kind === 'wrong-object') result.modelEvidence!.originalSourceObjectId = 'other';
    if (kind === 'wrong-page') result.modelEvidence!.parentSourceSpanId = 'page-1';
    if (kind === 'primary-date') f.observation.sourceSpanId = 'date';
    expect(reportFindingPageScope(f.observation, f.manifest)).toBeNull();
  });
  it('无模型来源角色的旧记录仍保守保护所有引用页', () => {
    const f = fixture(); f.manifest.spans.forEach((span) => { delete span.modelEvidence; });
    expect(reportFindingPageScope(f.observation, f.manifest)?.pages).toEqual([1, 2, 3]);
  });
});
