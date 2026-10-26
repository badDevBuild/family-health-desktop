import type { HealthAction, LifestylePlanV2 } from '@contracts';

export type DailyLifeDomain = 'diet' | 'activity' | 'sleep' | 'supplements' | 'daily_routine' | 'other';
export type DailyLifeItem = { id: string; title: string; domain: DailyLifeDomain; action?: HealthAction; proposal?: LifestylePlanV2['proposals'][number] };

export const dailyLifeDomains: Array<{ id: Exclude<DailyLifeDomain, 'other'>; title: string; description: string }> = [
  { id: 'diet', title: '饮食与摄入', description: '把三餐、饮水和需要留意的摄入放在一起看。' },
  { id: 'activity', title: '运动与活动', description: '选择适合身体情况、能持续做的活动。' },
  { id: 'sleep', title: '睡眠与休息', description: '了解作息、睡眠和白天精力之间的关系。' },
  { id: 'supplements', title: '营养补充与保健品', description: '了解是否需要补充，以及现有药物或身体情况带来的限制。' },
  { id: 'daily_routine', title: '日常习惯与自我观察', description: '把日常照顾和有必要记录的变化安排好。' }
];

/** 老快照只归入有明显文字依据的主题，不从病名猜做法，也不据此声称建议已个性化。 */
function legacyHabitDomain(title: string, firstStep: string): DailyLifeDomain {
  const domains: Array<[DailyLifeDomain, RegExp]> = [
    ['supplements', /(?:保健品|补充剂|营养补充|维生素|鱼油|钙片)/],
    ['sleep', /(?:睡眠|睡觉|入睡|起床|睡前|作息|熬夜|午睡)/],
    ['activity', /(?:运动|锻炼|散步|步行|快走|骑车|骑行|游泳|力量训练|久坐|活动量)/],
    ['diet', /(?:饮食|三餐|早餐|午餐|晚餐|食物|食材|饮水|喝水|摄入|饮酒|蔬菜|水果|蛋白质|零食|盐量)/]
  ];
  // 先按明确标题归类；一句同时讲多种做法时保留在其他建议，不任选一种。
  for (const text of [title, firstStep]) {
    const matched = domains.filter(([, pattern]) => pattern.test(text));
    if (matched.length === 1) return matched[0]![0];
    if (matched.length > 1) return 'other';
  }
  if (/(?:记录|测量|观察|监测|吸烟|戒烟|用眼|口腔|刷牙|户外|家人协助)/.test(`${title} ${firstStep}`)) return 'daily_routine';
  return 'other';
}

/** 就医和原报告中的医嘱始终单列，不能仅凭 diet 等标签挪到日常生活里。 */
export function dailyLifeContent(assessmentActions: HealthAction[], proposals: LifestylePlanV2['proposals'] = []) {
  const daily: DailyLifeItem[] = [];
  const medicalActions: HealthAction[] = [];
  const medicalProposals: LifestylePlanV2['proposals'] = [];
  for (const action of assessmentActions) {
    if (!['habit', 'self_monitor'].includes(action.kind)) {
      medicalActions.push(action);
      continue;
    }
    daily.push({ id: action.id, title: action.title, domain: action.lifestyleDomain ?? legacyHabitDomain(action.title, action.firstStep), action });
  }
  for (const proposal of proposals) {
    if (proposal.category === 'review' || proposal.sourceKind === 'clinician_reported' || proposal.sourceKind === 'care_preparation') {
      medicalProposals.push(proposal);
      continue;
    }
    const domain = proposal.category === 'exercise' ? 'activity' : proposal.category === 'diet' ? 'diet'
      : proposal.category === 'sleep' ? 'sleep' : proposal.category === 'monitoring' ? 'daily_routine'
        : legacyHabitDomain(proposal.title, proposal.steps[0] ?? proposal.detail);
    daily.push({ id: proposal.id, title: proposal.title, domain, proposal });
  }
  return { daily, medicalActions, medicalProposals };
}
