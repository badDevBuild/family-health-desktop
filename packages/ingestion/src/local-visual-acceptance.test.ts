import { describe, expect, it } from 'vitest';
import type { ObservationCandidate } from '@contracts';
import { evaluateObservationCandidate } from '@core';
import { buildImageManifest } from './index.js';
import { reconstructLocalVisualLayout, type LocalVisualTextBox } from './local-visual-layout.js';

const box = (text: string, x: number, y: number, width = 0.1): LocalVisualTextBox => ({
  text, confidence: 0.9, bounds: [x, y, width, 0.025]
});
const headings = () => [box('项目', 0.02, 0.8), box('结果', 0.35, 0.8), box('单位', 0.55, 0.8),
  box('参考范围', 0.72, 0.8, 0.2)];
function evaluate(lines: LocalVisualTextBox[], name: string, value: string, unitRaw: string | null = 'U/L',
  kind: 'numeric' | 'text' | 'qualitative' = 'numeric') {
  const layout = reconstructLocalVisualLayout(lines);
  const manifest = buildImageManifest({ sourceObjectId: 'synthetic-source', documentId: 'synthetic-document',
    sha256: 'a'.repeat(64), mediaType: 'image/png', displayName: '合成表格.png', createdAt: '2026-10-13T00:00:00Z' });
  const span = manifest.spans[0]!;
  span.quote = layout.quote;
  span.readability = 'clear';
  const candidate: ObservationCandidate = { localKey: 'synthetic-candidate', originalName: name,
    standardNameCandidate: null, value: kind === 'numeric' ? { kind, rawText: value, decimal: value, comparator: 'eq' }
      : kind === 'text' ? { kind, rawText: value } : { kind, rawText: value, category: null },
    unitRaw, referenceRangeRaw: null, reportedAbnormalFlag: null, specimen: null, method: null,
    bodySite: null, clinicalDate: null, evidence: [{ sourceSpanId: span.id, quote: layout.quote }], issues: [] };
  return evaluateObservationCandidate(candidate, manifest, { personConsistent: true, overwritesUserLockedValue: false });
}

describe('本地视觉行列恢复与真实接纳规则的联合防串列门禁', () => {
  it('参考范围只有顶部表头时，真结果可接纳，参考下限不可当结果', () => {
    const lines = [...headings(), box('合成项目甲', 0.02, 0.72, 0.22), box('18.2', 0.35, 0.72),
      box('U/L', 0.55, 0.72), box('3.0-9.0', 0.72, 0.72, 0.2)];
    expect(evaluate(lines, '合成项目甲', '18.2').decision).toMatch(/^accept(?:_with_warnings)?$/u);
    expect(evaluate(lines, '合成项目甲', '3.0')).toMatchObject({ decision: 'reject', reasons: ['numeric_value_not_in_evidence'] });
  });

  it('结果列空白时参考范围不能填充成已确认事实', () => {
    const lines = [...headings(), box('合成项目甲', 0.02, 0.72, 0.22), box('U/L', 0.55, 0.72),
      box('3.0-9.0', 0.72, 0.72, 0.2)];
    expect(evaluate(lines, '合成项目甲', '3.0').decision).toBe('reject');
  });

  it('没有表头也不把独立范围的下限借给前一项目', () => {
    const lines = [box('合成项目甲', 0.02, 0.72, 0.22), box('18.2', 0.35, 0.72),
      box('U/L', 0.55, 0.72), box('3.0-9.0', 0.72, 0.72, 0.2)];
    expect(evaluate(lines, '合成项目甲', '18.2').decision).toMatch(/^accept(?:_with_warnings)?$/u);
    expect(evaluate(lines, '合成项目甲', '3.0').decision).toBe('reject');
  });

  it('同高双栏分别接纳自己的结果，拒绝借用另一项目结果', () => {
    const lines = [box('合成项目甲', 0.02, 0.72, 0.2), box('18.2 U/L', 0.25, 0.72, 0.2),
      box('合成项目乙', 0.52, 0.72, 0.2), box('7.1 U/L', 0.75, 0.72, 0.2)];
    expect(evaluate(lines, '合成项目甲', '18.2').decision).toMatch(/^accept(?:_with_warnings)?$/u);
    expect(evaluate(lines, '合成项目乙', '7.1').decision).toMatch(/^accept(?:_with_warnings)?$/u);
    expect(evaluate(lines, '合成项目甲', '7.1').decision).toBe('reject');
  });

  it('跨年度的两个结果列不能在没有列日期绑定时冒充同一当前结果', () => {
    const lines = [box('项目', 0.02, 0.8), box('2023年', 0.35, 0.8), box('2025年', 0.65, 0.8),
      box('合成项目甲', 0.02, 0.72, 0.22), box('18.2', 0.35, 0.72), box('7.1', 0.65, 0.72)];
    expect(evaluate(lines, '合成项目甲', '18.2', null).decision).toBe('reject');
    expect(evaluate(lines, '合成项目甲', '7.1', null).decision).toBe('reject');
  });

  it('表头参考列中的文字也不能填充空白结果', () => {
    const lines = [...headings(), box('合成项目甲', 0.02, 0.72, 0.22), box('未见异常', 0.72, 0.72, 0.2)];
    expect(evaluate(lines, '合成项目甲', '未见异常', null, 'text').decision).toBe('reject');
    expect(evaluate(lines, '合成项目甲', '未见异常', null, 'qualitative').decision).toBe('reject');
  });
});
