import { describe, expect, it } from 'vitest';
import type { HealthAction } from '@contracts';
import { dailyLifeContent } from './daily-life-content.js';

const habit = (id: string, title: string, overrides: Partial<HealthAction> = {}): HealthAction => ({
  id, dedupeKey: id, kind: 'habit', title, firstStep: title, why: '按本人情况选择做法。',
  systemIds: [], claimIds: [], timing: null, timingBasis: 'none', reviewPlan: null, caution: null,
  urgency: 'routine', evidenceIds: [], knowledgeSourceIds: [], ...overrides
});

describe('日常生活建议归组', () => {
  it('保留明确五域标签，同一建议只进入一个主题，就医和医嘱仍单列', () => {
    const actions = [habit('diet', '调整三餐', { lifestyleDomain: 'diet', lifestyleBasis: 'personalized' }),
      habit('move', '循序增加活动', { lifestyleDomain: 'activity' }), habit('sleep', '休息', { lifestyleDomain: 'sleep' }),
      habit('supp', '查看现有补充剂', { lifestyleDomain: 'supplements', lifestyleBasis: 'general' }),
      habit('routine', '保持日常照顾', { lifestyleDomain: 'daily_routine' }),
      habit('doctor', '报告中的饮食医嘱', { kind: 'documented_plan', lifestyleDomain: 'diet' }),
      habit('review', '复查', { kind: 'test_followup' })];
    const result = dailyLifeContent(actions);
    expect(result.daily.map((item) => [item.id, item.domain])).toEqual([
      ['diet', 'diet'], ['move', 'activity'], ['sleep', 'sleep'], ['supp', 'supplements'], ['routine', 'daily_routine']
    ]);
    expect(result.medicalActions.map((action) => action.id)).toEqual(['doctor', 'review']);
    expect(result.daily[3]!.action?.lifestyleBasis).toBe('general');
    expect(actions[5]!.lifestyleDomain).toBe('diet');
  });

  it('历史习惯有明显做法才归组，无法归类时保留，不从病名推断或补写个性化标签', () => {
    const actions = [habit('diet', '晚餐增加蔬菜'), habit('activity', '晚饭后散步'), habit('sleep', '固定起床时间'),
      habit('supp', '保健品先核对成分'), habit('watch', '记录血压'), habit('unknown', '关注肝胆情况'), habit('mixed', '一起调整饮食和睡眠')];
    const result = dailyLifeContent(actions);
    expect(result.daily.map((item) => item.domain)).toEqual(['diet', 'activity', 'sleep', 'supplements', 'daily_routine', 'other', 'other']);
    expect(result.daily.every((item) => item.action?.lifestyleBasis === undefined)).toBe(true);
    expect(actions.map((action) => action.title)).toEqual(result.daily.map((item) => item.title));
  });
});
