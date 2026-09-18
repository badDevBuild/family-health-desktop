import { describe, expect, it } from 'vitest';
import { createDemoSnapshot } from '../../../../packages/test-fixtures/src/index.js';
import { buildMemberSummaryData, renderMemberSummaryHtml, renderMemberSummaryJson } from './export-service.js';

describe('成员摘要导出', () => {
  it('只包含选择的成员，并按临床日期范围筛选记录', () => {
    const snapshot = createDemoSnapshot();
    const summary = buildMemberSummaryData(snapshot, {
      personId: 'person-lin-ming',
      dateFrom: '2026-01-01',
      dateTo: '2026-12-31'
    }, '2026-09-18T00:00:00.000Z');
    expect(summary.member.displayName).toBe('林明');
    expect(summary.observations).toHaveLength(2);
    expect(summary.observations.every((item) => item.date.startsWith('2026-'))).toBe(true);
    expect(summary.actionItems.every((item) => !item.title.includes('甲状腺'))).toBe(true);
    expect(renderMemberSummaryJson(summary)).not.toContain('周岚');
  });

  it('HTML 转义用户文本，并明确原始报告不随摘要导出', () => {
    const snapshot = createDemoSnapshot();
    snapshot.notes[0] = { ...snapshot.notes[0]!, immutableText: '<script>alert(1)</script>' };
    const summary = buildMemberSummaryData(snapshot, {
      personId: 'person-lin-ming',
      dateFrom: null,
      dateTo: null
    });
    const html = renderMemberSummaryHtml(summary);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('不附原始报告');
  });
});
