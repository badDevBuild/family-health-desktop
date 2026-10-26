import { describe, expect, it } from 'vitest';
import type { HealthAction, HealthClaim, MemberAssessmentSnapshotV3 } from '@contracts';
import { buildAssessmentPriorities } from './assessment-priorities.js';

function claim(id: string, topicKey = id, overrides: Partial<HealthClaim> = {}): HealthClaim {
  return { id, topicKey, systemIds: ['cardiovascular'], kind: 'interpretation', title: `主题${id}`,
    text: `检查发现${id}。`, diseaseName: null, diagnosticStatus: null, temporalStatus: 'current',
    evidenceIds: [], counterEvidenceIds: [], trendIds: [], knowledgeBasis: 'not_applicable', knowledgeSourceIds: [],
    criteriaBasis: null, rationale: '结合检查结果理解。', materialUncertainty: null, consequenceLevel: 'important', ...overrides };
}

function action(id: string, claimIds: string[], overrides: Partial<HealthAction> = {}): HealthAction {
  return { id, dedupeKey: id, systemIds: ['cardiovascular'], claimIds, kind: 'self_monitor', title: `行动${id}`,
    why: '观察日常变化。', firstStep: `执行${id}。`, timing: null, timingBasis: 'none', reviewPlan: null,
    caution: null, urgency: 'routine', evidenceIds: [], knowledgeSourceIds: [], ...overrides };
}

function source(claims: HealthClaim[], actions: HealthAction[] = [], overviewClaimIds: string[] = claims.map((item) => item.id)):
  Pick<MemberAssessmentSnapshotV3, 'claims' | 'actions' | 'overview'> {
  return { claims, actions, overview: { id: 'overview', headline: '本次健康情况', summary: '请结合检查背景理解。',
    claimIds: overviewClaimIds, actionIds: actions.map((item) => item.id), limitations: [] } };
}

describe('buildAssessmentPriorities', () => {
  it('只读预览保留完整依据、主系统条件和总体边界，不借其他系统补写结论', () => {
    const lead = claim('current', 'vision', { systemIds: ['sensory_oral'],
      rationale: '右眼与左眼采用同一测量方式，但本次未散瞳。', materialUncertainty: '不能据此确认屈光状态。' });
    const input = { ...source([lead]), limitations: ['缺少当前症状，不能代替临床评估。'], systems: [
      { id: 'vision', systemId: 'sensory_oral' as const, status: 'monitor' as const,
        headline: '现有眼部检查', summary: '需结合检查条件理解。', claimIds: [lead.id], actionIds: [],
        limitations: ['只有去年的记录，不能代表现在。', '右眼与左眼采用同一测量方式，但本次未散瞳。'] },
      { id: 'other', systemId: 'hepatobiliary' as const, status: 'monitor' as const,
        headline: '其他系统记录', summary: '不要混入眼部预览。', claimIds: [], actionIds: [], limitations: ['另一系统的限制。'] }
    ] };
    input.overview.limitations = ['未检查的身体部分不能据此判断正常。'];
    const before = structuredClone(input);
    const result = buildAssessmentPriorities(input);
    expect(result[0]).toMatchObject({ explanation: '检查发现current。 不能据此确认屈光状态。',
      readingContext: ['右眼与左眼采用同一测量方式，但本次未散瞳。', '只有去年的记录，不能代表现在。',
        '未检查的身体部分不能据此判断正常。', '缺少当前症状，不能代替临床评估。'] });
    expect(result[0]!.readingContext).not.toContain('另一系统的限制。');
    expect(input).toEqual(before);
  });

  it('内部叙事调用缺少完整系统上下文时不伪装成可直接摘取的完整解释', () => {
    const input = source([claim('current')]);
    expect(buildAssessmentPriorities(input)[0]).not.toHaveProperty('readingContext');
    expect(buildAssessmentPriorities({ ...input, systems: [] })[0]).not.toHaveProperty('readingContext');
  });

  it('系统上下文重复或全局适用范围未知时，退回主题导航而非猜测完整条件', () => {
    const input = source([claim('current')]);
    const node = { id: 'cardio', systemId: 'cardiovascular' as const, status: 'monitor' as const,
      headline: '合成检查', summary: '请结合条件。', claimIds: ['current'], actionIds: [], limitations: [] };
    expect(buildAssessmentPriorities({ ...input, systems: [node] })[0]).not.toHaveProperty('readingContext');
    expect(buildAssessmentPriorities({ ...input, limitations: [], systems: [node, { ...node, id: 'duplicate' }] })[0])
      .not.toHaveProperty('readingContext');
  });

  it('同一明确主题保留全部事实、趋势、解释和必要条件，只占一个关注入口', () => {
    const input = source([
      claim('fact', 'lipids', { kind: 'source_fact', consequenceLevel: 'routine', text: '本次结果为3.5 mmol/L。' }),
      claim('trend', 'lipids', { kind: 'trend', text: '两次结果前后升高。', materialUncertainty: '只有两个时间点。' }),
      claim('meaning', 'lipids', { text: '这次变化值得继续观察。', materialUncertainty: '需结合个人病史理解。' })
    ], [], ['meaning', 'trend', 'fact']);
    const before = structuredClone(input);
    const result = buildAssessmentPriorities(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'meaning', explanation: '这次变化值得继续观察。 需结合个人病史理解。',
      relatedExplanations: [
        { id: 'trend', explanation: '两次结果前后升高。 只有两个时间点。' },
        { id: 'fact', explanation: '本次结果为3.5 mmol/L。' }
      ] });
    expect(input).toEqual(before);
  });

  it('同器官的不同主题不合并，也不按点号前缀猜测旧主题键', () => {
    const claims = [claim('ldl', 'lipids.ldl.change'), claim('lipid-assessment', 'lipids.possible_dyslipidemia'),
      claim('bp', 'blood_pressure'), claim('ecg', 'electrocardiogram')];
    expect(buildAssessmentPriorities(source(claims)).map((item) => item.id))
      .toEqual(['ldl', 'lipid-assessment', 'bp', 'ecg']);
  });

  it('同病名、同证据也不能代替明确主题键合并', () => {
    const claims = [claim('left-eye', 'left-eye', { systemIds: ['sensory_oral'], evidenceIds: ['same-report'],
      diseaseName: '合成眼部问题', text: '左眼需结合未散瞳条件理解。' }),
    claim('right-eye', 'right-eye', { systemIds: ['sensory_oral'], evidenceIds: ['same-report'],
      diseaseName: '合成眼部问题', text: '右眼记录是历史结果。', temporalStatus: 'historical' })];
    expect(buildAssessmentPriorities(source(claims))).toHaveLength(2);
  });

  it('跨系统共用一条原报告安排仍保留血压与肾脏两个主题', () => {
    const input = source([claim('bp', 'blood-pressure'), claim('kidney', 'kidney', { systemIds: ['renal_urinary'] })],
      [action('reported-review', ['bp', 'kidney'], { kind: 'documented_plan',
        firstStep: '记录家庭血压，复诊时一并查看血压和肾功能结果。' })]);
    const result = buildAssessmentPriorities(input);
    expect(result.map((item) => item.id)).toEqual(['bp', 'kidney']);
    expect(result.map((item) => item.systemId)).toEqual(['cardiovascular', 'renal_urinary']);
    expect(result.every((item) => item.nextStep === input.actions[0]!.firstStep)).toBe(true);
  });

  it('同主题关联的饮食、复查和记录行动全部保留，仅去掉完全相同的第一步', () => {
    const input = source([claim('trend', 'lipids'), claim('meaning', 'lipids')], [
      action('diet', ['trend'], { kind: 'habit', firstStep: '如果仍常吃油炸食物，先替换一顿晚餐。' }),
      action('review', ['meaning'], { kind: 'test_followup', firstStep: '带两次结果与医生讨论复查。' }),
      action('record', ['trend'], { firstStep: '每天记录晚餐内容。' }),
      action('record-duplicate', ['meaning'], { firstStep: '每天记录晚餐内容。' })
    ]);
    expect(buildAssessmentPriorities(input)[0]).toMatchObject({ nextStep: input.actions[0]!.firstStep,
      additionalNextSteps: [input.actions[2]!.firstStep, input.actions[1]!.firstStep] });
    expect(input.actions).toHaveLength(4);
  });

  it('不同期限、条件和否定不做模糊去重，完整行动时间和注意事项不被改写', () => {
    const input = source([claim('one', 'followup')], [
      action('three-days', ['one'], { firstStep: '若仍有不适，三天后联系医生。', timing: '三天后', timingBasis: 'documented', caution: '若加重及时就医。' }),
      action('three-months', ['one'], { firstStep: '三个月后联系医生。', timing: '三个月后', timingBasis: 'documented' }),
      action('negated', ['one'], { firstStep: '没有不适时，不自行增加复查频率。' })
    ]);
    const before = structuredClone(input);
    expect(buildAssessmentPriorities(input)[0]).toMatchObject({ nextStep: input.actions[0]!.firstStep,
      additionalNextSteps: [input.actions[1]!.firstStep, input.actions[2]!.firstStep] });
    expect(input).toEqual(before);
  });

  it('组内高影响主张成为主入口，不只把高影响标志加在普通解释上', () => {
    const result = buildAssessmentPriorities(source([
      claim('ordinary', 'same'), claim('high', 'same', { consequenceLevel: 'high', text: '需要优先处理的重要发现。' })
    ]));
    expect(result[0]).toMatchObject({ id: 'high', explanation: '需要优先处理的重要发现。', isHighPriority: true,
      relatedExplanations: [{ id: 'ordinary' }] });
  });

  it('紧急行动关联的常规主张成为主入口，不能藏在详情中或被routine过滤', () => {
    const result = buildAssessmentPriorities(source([
      claim('high', 'same', { consequenceLevel: 'high' }),
      claim('urgent', 'same', { consequenceLevel: 'routine', text: '当前仍有症状时应立即处理。' })
    ], [action('urgent-care', ['urgent'], { urgency: 'urgent', firstStep: '如果现在仍有这些症状，立即就医。' })]));
    expect(result[0]).toMatchObject({ id: 'urgent', explanation: '当前仍有症状时应立即处理。',
      nextStep: '如果现在仍有这些症状，立即就医。', isHighPriority: true,
      relatedExplanations: [{ id: 'high' }] });
  });

  it('急救、紧急、高影响依次优先，超过三项仍返回所有重要主题', () => {
    const input = source([claim('ordinary'), claim('high', 'high', { consequenceLevel: 'high' }),
      claim('urgent', 'urgent', { consequenceLevel: 'routine' }), claim('emergency'), claim('other')],
    [action('urgent-care', ['urgent'], { urgency: 'urgent' }), action('emergency-care', ['emergency'], { urgency: 'emergency' })]);
    const result = buildAssessmentPriorities(input);
    expect(result.map((item) => item.id)).toEqual(['emergency', 'urgent', 'high', 'ordinary', 'other']);
    expect(result.map((item) => item.isHighPriority)).toEqual([true, true, true, false, false]);
  });

  it('同等级使用总览的关注次序，未列出的主张按原顺序保留', () => {
    const input = source([claim('a'), claim('b'), claim('c'), claim('d')], [], ['c', 'b', 'b']);
    expect(buildAssessmentPriorities(input).map((item) => item.id)).toEqual(['c', 'b', 'a', 'd']);
  });

  it('只有常规主张且无紧急行动的组不虚构优先事项', () => {
    expect(buildAssessmentPriorities(source([claim('normal', 'normal', { consequenceLevel: 'routine' })],
      [action('ordinary-plan', ['normal'], { urgency: 'soon' })]))).toEqual([]);
  });

  it('无系统归属不创建失效导航，缺失主张或行动不从残留引用中恢复', () => {
    const input = source([claim('visible'), claim('no-system', 'unknown', { systemIds: [], consequenceLevel: 'high' })],
      [action('removed-claim-action', ['absent'], { urgency: 'emergency' })], ['absent', 'visible']);
    expect(buildAssessmentPriorities(input)).toEqual([expect.objectContaining({ id: 'visible', nextStep: null,
      additionalNextSteps: [], relatedExplanations: [], isHighPriority: false })]);
    expect(buildAssessmentPriorities(source([], [action('unattached', ['absent'], { urgency: 'emergency' })]))).toEqual([]);
  });

  it('同组不同左右侧、历史状态、限定和反向发现完整保留，不拼成新的医学结论', () => {
    const input = source([
      claim('left', 'eye-check', { systemIds: ['sensory_oral'], text: '本次左眼结果需结合未散瞳条件理解。', materialUncertainty: '未提供正式验光。' }),
      claim('right', 'eye-check', { systemIds: ['sensory_oral'], temporalStatus: 'historical', text: '去年右眼记录未提示此项变化。' })
    ]);
    expect(buildAssessmentPriorities(input)[0]).toMatchObject({
      explanation: '本次左眼结果需结合未散瞳条件理解。 未提供正式验光。',
      relatedExplanations: [{ id: 'right', explanation: '去年右眼记录未提示此项变化。', systemId: 'sensory_oral' }]
    });
  });
});
