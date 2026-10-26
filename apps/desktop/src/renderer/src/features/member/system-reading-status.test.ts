import { describe, expect, it } from 'vitest';
import type { BodySystemSummaryV2 } from '@contracts';
import { systemReadingStatus } from './system-reading-status.js';

describe('身体系统的统一阅读状态', () => {
  const statuses: BodySystemSummaryV2['status'][] = ['attention', 'monitor', 'stable', 'no_signal_in_scope', 'building', 'insufficient'];

  it.each(statuses)('没有相关事实时，%s 也不显示正常或异常结论', (status) => {
    expect(systemReadingStatus({ status, factCount: 0 })).toEqual({ group: 'limited', label: '尚无相关检查', tone: 'neutral' });
  });

  it.each(['building', 'insufficient'] as const)('%s 有记录时不写资料不足，也不猜测医学结论', (status) => {
    const input = Object.freeze({ status, factCount: 3 });
    expect(systemReadingStatus(input)).toEqual({ group: 'recorded', label: '已有检查记录', tone: 'neutral' });
    expect(input).toEqual({ status, factCount: 3 });
  });

  it.each([
    ['attention', 'attention', '建议关注', 'warning'],
    ['monitor', 'attention', '继续观察', 'info'],
    ['stable', 'reassuring', '继续保持', 'success'],
    ['no_signal_in_scope', 'reassuring', '本次未提示问题', 'success']
  ] as const)('已有 %s 判断保持原有语义', (status, group, label, tone) => {
    expect(systemReadingStatus({ status, factCount: 1 })).toEqual({ group, label, tone });
  });
});
