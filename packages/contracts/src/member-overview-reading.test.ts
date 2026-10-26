import { describe, expect, it } from 'vitest';
import { memberOverviewV2Schema } from './member-v2.js';

describe('成员重点主题的只读阅读上下文', () => {
  const schema = memberOverviewV2Schema.shape.priorityIssues.element;
  const issue = { id: 'synthetic-topic', title: '合成检查的适用范围', explanation: '不能仅凭这次检查确定原因。',
    nextStep: null, systemId: 'sensory_oral' };

  it('旧投影缺字段保持未知，不默认补成已确认的空上下文', () => {
    expect(schema.parse(issue)).not.toHaveProperty('readingContext');
  });

  it('新投影完整条件或明确空数组均保留，不能接受空白条目冒充条件', () => {
    expect(schema.parse({ ...issue, readingContext: ['未散瞳，不能与散瞳结果直接比较。'] }).readingContext)
      .toEqual(['未散瞳，不能与散瞳结果直接比较。']);
    expect(schema.parse({ ...issue, readingContext: [] }).readingContext).toEqual([]);
    expect(schema.safeParse({ ...issue, readingContext: [''] }).success).toBe(false);
  });
});
