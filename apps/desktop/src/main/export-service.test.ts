import { describe, expect, it } from 'vitest';
import type { MemberAssessmentSnapshotV3 } from '@contracts';
import { createDemoSnapshot } from '../../../../packages/test-fixtures/src/index.js';
import { buildMemberSummaryData, renderMemberSummaryHtml, renderMemberSummaryJson } from './export-service.js';

const syntheticAssessment = {
  id: 'synthetic-v3-current', personId: 'person-lin-ming',
  overview: { summary: '新版全历史综合：主要关注合成血脂变化。' },
  actions: [{ kind: 'habit', title: '新版合成行动', why: '与合成检查结果有关',
    firstStep: '先记下自己可执行的一步', timing: '本周', reviewPlan: '下周回看',
    caution: '<仅供测试>' }]
} as unknown as MemberAssessmentSnapshotV3;

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

  it('当前 V3 导出同一份总述和待采纳行动，不混入旧版生活建议', () => {
    const snapshot = createDemoSnapshot();
    const summary = buildMemberSummaryData(snapshot, {
      personId: 'person-lin-ming', dateFrom: null, dateTo: null
    }, '2026-09-22T00:00:00.000Z', syntheticAssessment);
    expect(summary.assessment.summary).toBe(syntheticAssessment.overview.summary);
    expect(summary.suggestedActions).toEqual([expect.objectContaining({
      title: '新版合成行动', firstStep: '先记下自己可执行的一步'
    })]);
    expect(summary.lifestyleGuidance).toEqual([]);
    const html = renderMemberSummaryHtml(summary);
    expect(html).toContain('新版综合建议');
    expect(html).toContain('新版合成行动');
    expect(html).toContain('&lt;仅供测试&gt;');
    expect(html).not.toContain('保持规律步行');
    const json = renderMemberSummaryJson(summary);
    expect(json).toContain('新版合成行动');
    expect(json).not.toContain('保持规律步行');
  });

  it('旧快照和其他成员的 V3 内容不从失效、跨成员或日期筛选导出旁路出现', () => {
    const stale = createDemoSnapshot();
    stale.persons[0] = { ...stale.persons[0]!, derivedStatus: 'stale', assessmentSummary: '旧综合敏感正文' };
    const staleSummary = buildMemberSummaryData(stale, {
      personId: 'person-lin-ming', dateFrom: null, dateTo: null
    }, '2026-09-22T00:00:00.000Z', syntheticAssessment);
    expect(staleSummary.assessment.summary).toBeNull();
    expect(staleSummary.suggestedActions).toEqual([]);
    expect(staleSummary.lifestyleGuidance).toEqual([]);
    expect(renderMemberSummaryJson(staleSummary)).not.toContain('旧综合敏感正文');
    expect(renderMemberSummaryJson(staleSummary)).not.toContain('新版合成行动');

    const otherMember = buildMemberSummaryData(createDemoSnapshot(), {
      personId: 'person-zhou-lan', dateFrom: null, dateTo: null
    }, '2026-09-22T00:00:00.000Z', syntheticAssessment);
    expect(otherMember.suggestedActions).toEqual([]);
    expect(renderMemberSummaryJson(otherMember)).not.toContain('新版合成行动');

    const limited = buildMemberSummaryData(createDemoSnapshot(), {
      personId: 'person-lin-ming', dateFrom: '2026-01-01', dateTo: '2026-12-31'
    }, '2026-09-22T00:00:00.000Z', syntheticAssessment);
    expect(limited.assessment.summary).toBeNull();
    expect(limited.suggestedActions).toEqual([]);
    expect(limited.lifestyleGuidance).toEqual([]);
    expect(limited.warnings.some((warning) => warning.includes('跨期综合及建议未纳入'))).toBe(true);
  });
});
