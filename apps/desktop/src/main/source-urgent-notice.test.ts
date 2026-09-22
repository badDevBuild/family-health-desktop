import { describe, expect, it } from 'vitest';
import type { AcceptedObservationSummary } from '@storage';
import { buildSourceUrgentNotices } from './source-urgent-notice.js';

const today = new Date(2026, 8, 22, 12);

function observation(overrides: Partial<AcceptedObservationSummary> = {}): AcceptedObservationSummary {
  return {
    id: 'observation-1', personId: 'synthetic-person', originalName: '项目甲',
    originalNameStatus: 'recorded', rawText: '1.0', clinicalDate: '2026-09-22',
    documentId: 'document-1', sourceSpanId: 'span-1', sourceLabel: '合成报告',
    abnormalFlag: 'high', createdAt: '2026-09-22T12:00:00.000Z',
    evidence: [{ sourceSpanId: 'span-1', quote: '项目甲 1.0，报告标注危急值，需立即联系医生。' }],
    ...overrides
  } as AcceptedObservationSummary;
}

describe('报告原文及时处理提示', () => {
  it('P01 已接纳且日期近期时可先展示带来源的原文提示，无需等待 P02', () => {
    expect(buildSourceUrgentNotices([observation()], today)).toEqual([{
      id: 'source-urgent:observation-1', documentId: 'document-1', sourceSpanId: 'span-1',
      clinicalDate: '2026-09-22', instructionLevel: 'critical_result', itemName: '项目甲', sourceLabel: '合成报告',
      sourceExcerpt: '项目甲 1.0，报告标注危急值，需立即联系医生'
    }]);
  });

  it('报告明确要求立即急诊时保留更高的原文行动级别', () => {
    const [notice] = buildSourceUrgentNotices([observation({
      evidence: [{ sourceSpanId: 'span-1', quote: '项目甲 1.0，报告要求立即急诊。' }]
    })], today);
    expect(notice?.instructionLevel).toBe('immediate_care');
  });

  it('立即拨打 120 可识别，尽快就医不被误写为立即就医', () => {
    const emergency = observation({ evidence: [{ sourceSpanId: 'span-1', quote: '项目甲 1.0，立即拨打120。' }] });
    const soon = observation({ evidence: [{ sourceSpanId: 'span-1', quote: '项目甲 1.0，尽快就医。' }] });
    expect(buildSourceUrgentNotices([emergency], today)[0]?.instructionLevel).toBe('immediate_care');
    expect(buildSourceUrgentNotices([soon], today)[0]?.instructionLevel).toBe('critical_result');
  });

  it('多年前的异常即使今天才导入，也不显示成当前紧急提示', () => {
    expect(buildSourceUrgentNotices([observation({ clinicalDate: '2023-10-08' })], today)).toEqual([]);
  });

  it('普通偏高、日期不明、纯图像证据与来源明确否定危急值都不能误报', () => {
    const noAlert = observation({ evidence: [{ sourceSpanId: 'span-1', quote: '项目甲 1.0，报告标注偏高。' }] });
    const noDate = observation({ clinicalDate: null });
    const imageOnly = observation({ evidence: [{ sourceSpanId: 'span-1', quote: null }] });
    const negated = observation({ evidence: [{ sourceSpanId: 'span-1', quote: '项目甲 1.0，无危急值。' }] });
    expect(buildSourceUrgentNotices([noAlert, noDate, imageOnly, negated], today)).toEqual([]);
  });

  it('长来源片段里另一项目的危急标注不能绑定到当前结果', () => {
    const quote = '项目甲 1.0，普通结果。项目乙 2.0，报告标注危急值。';
    expect(buildSourceUrgentNotices([observation({ evidence: [{ sourceSpanId: 'span-1', quote }] })], today)).toEqual([]);
  });

  it('同一报告多条来源提示只显示一张卡，避免重复惊扰', () => {
    const second = observation({ id: 'observation-2', sourceSpanId: 'span-2',
      evidence: [{ sourceSpanId: 'span-2', quote: '项目甲 1.0，报告标注危急值。' }] });
    expect(buildSourceUrgentNotices([observation(), second], today)).toHaveLength(1);
  });
});
