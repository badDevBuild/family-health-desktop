import type { BodySystemSummaryV2 } from '@contracts';
import type { Tone } from '../../components/StatusBadge.js';

export type SystemReadingGroup = 'attention' | 'reassuring' | 'recorded' | 'limited';

/** 展示已有判断或记录范围，不把解读缺失变成没有检查，也不据此推断病情。 */
export function systemReadingStatus(system: Pick<BodySystemSummaryV2, 'status' | 'factCount'>): {
  group: SystemReadingGroup;
  label: string;
  tone: Tone;
} {
  if (system.factCount === 0) return { group: 'limited', label: '尚无相关检查', tone: 'neutral' };
  switch (system.status) {
    case 'attention': return { group: 'attention', label: '建议关注', tone: 'warning' };
    case 'monitor': return { group: 'attention', label: '继续观察', tone: 'info' };
    case 'stable': return { group: 'reassuring', label: '继续保持', tone: 'success' };
    case 'no_signal_in_scope': return { group: 'reassuring', label: '本次未提示问题', tone: 'success' };
    default: return { group: 'recorded', label: '已有检查记录', tone: 'neutral' };
  }
}
