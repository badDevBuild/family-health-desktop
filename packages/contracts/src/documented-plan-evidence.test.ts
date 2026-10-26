import { describe, expect, it } from 'vitest';
import type { HealthAction } from './member-assessment-v3.js';
import type { MemberEvidenceRef } from './member-v2.js';
import { documentedPlanEvidence, inspectDocumentedPlanEvidence, DOCUMENTED_PLAN_NEUTRAL_TITLE } from './documented-plan-evidence.js';

function action(overrides: Partial<HealthAction> = {}): HealthAction {
  return {
    id: 'action:thyroid', dedupeKey: 'thyroid', systemIds: ['endocrine_metabolic'], claimIds: [],
    kind: 'documented_plan', title: '按原报告复查甲状腺功能', why: '原报告有复查安排。',
    firstStep: '带上报告，按原安排复查甲状腺功能。', timing: '三个月后', timingBasis: 'documented',
    reviewPlan: null, caution: null, urgency: 'routine', evidenceIds: ['plan-source'], knowledgeSourceIds: [],
    ...overrides
  };
}

function evidence(quote: string, overrides: Partial<MemberEvidenceRef> = {}): MemberEvidenceRef {
  return {
    id: 'plan-source', kind: 'source_span', observationId: null, eventId: 'event-1', documentId: 'report-1',
    sourceSpanId: 'span-1', knowledgeId: null, label: '2026-06体检报告.pdf', locator: '第2页', quote, ...overrides
  };
}

describe('原报告安排的实际引用证明', () => {
  it('对应原文指示与原文相对时间可支持，中文数字可白话等价', () => {
    const source = evidence('建议3个月后复查甲状腺功能。');
    expect(documentedPlanEvidence(action(), [source])).toEqual([source]);
  });

  it('带栏目主题的原医嘱完整转述，不能裁掉前文来猜适用范围', () => {
    const quote = '甲状腺超声改变 : 请到内分泌科随访，动态观察甲状腺彩超及甲状腺功能指标。';
    const source = evidence(quote);
    const date = evidence('总检日期：2021-10-15', { id: 'report-date', sourceSpanId: 'date-span' });
    const reported = action({ title: DOCUMENTED_PLAN_NEUTRAL_TITLE,
      firstStep: `2021-10-15报告建议：“${quote}”`, timing: null, timingBasis: 'none' });
    expect(inspectDocumentedPlanEvidence(reported, [source, date]))
      .toMatchObject({ evidence: [source], unsupportedField: null, titleSupported: true });
    expect(inspectDocumentedPlanEvidence(reported, [source]).unsupportedField).toBe('firstStep');
    expect(inspectDocumentedPlanEvidence(reported, [source, { ...date, documentId: 'other-report' }]).unsupportedField).toBe('firstStep');
    expect(inspectDocumentedPlanEvidence({ ...reported,
      firstStep: '请到内分泌科随访，动态观察甲状腺彩超及甲状腺功能指标。' }, [source, date]).unsupportedField).toBe('firstStep');
    expect(source.quote).toBe(quote);
  });

  it.each([
    '注意合理饮食、适当运动。',
    '注意规律饮食、适当活动，可预约营养科门诊讨论饮食安排。',
    '注意合理饮食、适当活动，可预约营养科、内分泌等门诊讨论饮食安排。',
    '可预约营养科。',
    '可预约全科门诊讨论下一步检查。',
    '如有需要，可预约营养科门诊讨论饮食安排。'
  ])('有明确行动的注意或可预约原句可忠实保留：%s', (quote) => {
    const source = evidence(quote);
    const reported = action({ title: DOCUMENTED_PLAN_NEUTRAL_TITLE, firstStep: quote, timing: null, timingBasis: 'none' });
    expect(inspectDocumentedPlanEvidence(reported, [source])).toMatchObject({ evidence: [source], unsupportedField: null });
    expect(inspectDocumentedPlanEvidence({ ...reported, firstStep: `${quote}并开始每日服用补充剂5毫克。` }, [source]).unsupportedField)
      .toBe('firstStep');
    expect(source.quote).toBe(quote);
  });

  it.each([
    '注意到检查数值变化。', '注意到饮食记录缺失。', '注意事项：检查结果仅供参考。', '可预约停车位。',
    '可预约科技园停车位。', '注意事项：可预约科技馆参观。', '可预约车辆检查。', '可预约设备复查。',
    '不可预约营养科门诊。', '暂未注意规律饮食。', '无需 注意合理饮食。', '目前已 注意合理饮食。',
    '无需 注意休息。', '目前已 可预约营养科门诊。'
  ])('事实、标题、无关预约或否定行为不能变成原安排：%s', (quote) => {
    expect(inspectDocumentedPlanEvidence(action({ title: DOCUMENTED_PLAN_NEUTRAL_TITLE, firstStep: quote,
      timing: null, timingBasis: 'none' }), [evidence(quote)]).unsupportedField).toBe('source');
  });

  it('同一引用的连续完整指示句可按原序连用，保留所有条件、数值和对应期限', () => {
    const first = '医生建议：保持规律饮食，三天后记录活动1.0公里后的感受。';
    const second = '若仍有不适，建议六个月后复查肝功能，检查数值超过5.5时请到门诊评估。';
    const quote = `${first}${second}`;
    const source = evidence(quote);
    const reported = action({ title: DOCUMENTED_PLAN_NEUTRAL_TITLE, firstStep: quote, timing: null, timingBasis: 'none' });
    expect(inspectDocumentedPlanEvidence(reported, [source])).toMatchObject({ evidence: [source], unsupportedField: null });
    expect(inspectDocumentedPlanEvidence({ ...reported, firstStep: first }, [source]).unsupportedField).toBeNull();
    expect(inspectDocumentedPlanEvidence({ ...reported, firstStep: second }, [source]).unsupportedField).toBeNull();
    for (const firstStep of [
      `${second}${first}`, quote.replace('若仍有不适，', ''), quote.replace('1.0公里', '10公里'),
      quote.replace('5.5时', '55时'), quote.replace('三天后', '六个月后').replace('建议六个月后', '建议三天后'),
      `${quote}另加胸部CT检查。`
    ]) expect(inspectDocumentedPlanEvidence({ ...reported, firstStep }, [source]).unsupportedField).not.toBeNull();
    expect(inspectDocumentedPlanEvidence({ ...reported, evidenceIds: ['plan-source', 'other-source'] },
      [evidence(first), evidence(second, { id: 'other-source', sourceSpanId: 'other-span' })])
      .unsupportedField).toBe('firstStep');
    expect(source.quote).toBe(quote);
  });

  it.each([
    '检查结果仅反映当时情况。', '若发生新的不适。', '无需复查肝功能。'
  ])('连续指示窗口不能跳过中间中性、条件或否定句：%s', (middle) => {
    const first = '建议记录规律饮食。';
    const last = '建议三个月后复查肝功能。';
    const source = evidence(`${first}${middle}${last}`);
    const reported = action({ title: DOCUMENTED_PLAN_NEUTRAL_TITLE, firstStep: `${first}${last}`, timing: null, timingBasis: 'none' });
    expect(inspectDocumentedPlanEvidence(reported, [source]).unsupportedField).toBe('firstStep');
  });

  it('紧邻独立条件句与后续原指示为不可拆单元，不推断跨中性句或另一引用', () => {
    const condition = '若胸部不适持续。';
    const instruction = '建议三个月后复查肝功能。';
    const source = evidence(`${condition}${instruction}`);
    const reported = action({ title: DOCUMENTED_PLAN_NEUTRAL_TITLE, firstStep: `${condition}${instruction}`,
      timing: null, timingBasis: 'none' });
    expect(inspectDocumentedPlanEvidence(reported, [source])).toMatchObject({ evidence: [source], unsupportedField: null });
    expect(inspectDocumentedPlanEvidence({ ...reported, firstStep: instruction }, [source]).unsupportedField).toBe('firstStep');
    expect(inspectDocumentedPlanEvidence({ ...reported, firstStep: '复查肝功能。', timing: '三个月后' }, [source])
      .unsupportedField).toBe('firstStep');
    expect(inspectDocumentedPlanEvidence({ ...reported, evidenceIds: ['plan-source', 'other-source'] },
      [evidence(condition), evidence(instruction, { id: 'other-source', sourceSpanId: 'other-span' })])
      .unsupportedField).toBe('firstStep');
    expect(inspectDocumentedPlanEvidence(reported, [evidence(`${condition}检查结果仅反映当时情况。${instruction}`)])
      .unsupportedField).toBe('firstStep');
  });

  it.each([
    '若休息后仍有不适。', '若需复查合成项目甲。', '症状持续者。', '指标偏高者。', '三个月后。'
  ])('独立前提里的弱动作词、者式或期限不能让后句脱离前提：%s', (premise) => {
    const instruction = '建议复查合成项目甲。';
    const quote = `${premise}${instruction}`;
    const source = evidence(quote);
    const reported = action({ title: DOCUMENTED_PLAN_NEUTRAL_TITLE, firstStep: quote, timing: null, timingBasis: 'none' });
    expect(inspectDocumentedPlanEvidence(reported, [source])).toMatchObject({ evidence: [source], unsupportedField: null });
    expect(inspectDocumentedPlanEvidence({ ...reported, firstStep: instruction }, [source]).unsupportedField).toBe('firstStep');
    expect(inspectDocumentedPlanEvidence({ ...reported, firstStep: premise }, [source]).evidence).toEqual([]);
    expect(inspectDocumentedPlanEvidence({ ...reported, firstStep: quote.replace(premise, '另一个前提。') }, [source])
      .unsupportedField).toBe('firstStep');
    expect(inspectDocumentedPlanEvidence(reported, [evidence(`${premise}检查结果仅反映当时情况。${instruction}`)])
      .unsupportedField).toBe('firstStep');
  });

  it.each([
    '若休息后仍有不适，请复查合成项目甲。',
    '若需复查合成项目甲，则建议到合成门诊。',
    '症状持续者：请到合成门诊评估。',
    '若仍有不适，就需复查合成项目甲。',
    '若仍有不适，三个月后复查合成项目甲。'
  ])('明确后件使条件行动保持完整单句，不再推断绑定下一条：%s', (quote) => {
    const source = evidence(`${quote}建议记录饮食。`);
    const reported = action({ title: DOCUMENTED_PLAN_NEUTRAL_TITLE, firstStep: quote, timing: null, timingBasis: 'none' });
    expect(inspectDocumentedPlanEvidence(reported, [source])).toMatchObject({ evidence: [source], unsupportedField: null });
    expect(inspectDocumentedPlanEvidence({ ...reported, firstStep: '建议记录饮食。' }, [source]).unsupportedField).toBeNull();
    expect(inspectDocumentedPlanEvidence({ ...reported, firstStep: quote.replace(/^.*?[，,：:]\s*/, '') }, [source])
      .unsupportedField).not.toBeNull();
  });

  it('含前提与否定的同句忠实原建议仍完整证明，单摘后半句不证明', () => {
    const quote = '血常规中某项减少时，建议定期复查血常规；暂不安排其他检查。';
    const source = evidence(quote);
    const reported = action({ title: DOCUMENTED_PLAN_NEUTRAL_TITLE,
      firstStep: '血常规中某项减少时，建议定期复查血常规。', timing: null, timingBasis: 'none' });
    expect(inspectDocumentedPlanEvidence(reported, [source]).unsupportedField).toBeNull();
    expect(inspectDocumentedPlanEvidence({ ...reported, firstStep: '建议定期复查血常规。' }, [source]).unsupportedField).toBe('firstStep');
    expect(inspectDocumentedPlanEvidence({ ...reported, firstStep: `${reported.firstStep}安排其他检查。` }, [source])
      .unsupportedField).toBe('firstStep');
  });

  it.each(['症状持续者', 'if symptoms persist', '若仍有不适', '三个月后'])('冒号前条件 %s 不按栏目标签移走', (lead) => {
    const source = evidence(`${lead}：请到内分泌科随访。`);
    expect(inspectDocumentedPlanEvidence(action({ title: DOCUMENTED_PLAN_NEUTRAL_TITLE,
      firstStep: '请到内分泌科随访。', timing: null, timingBasis: 'none' }), [source])).toMatchObject({ evidence: [], unsupportedField: 'firstStep' });
  });

  it.each(['2026-08-28', '2026-08', '2026'])('来源日期 %s 与执行期限分开，保持来源日期原精度', (date) => {
    const source = evidence(`${date} 医生建议：3个月后复查甲状腺功能。`);
    const reported = action({ firstStep: '按报告建议复查甲状腺功能。', timing: '3个月后' });
    expect(documentedPlanEvidence(reported, [source])).toEqual([source]);
    expect(inspectDocumentedPlanEvidence({ ...reported, firstStep: `${date} 医生建议：复查甲状腺功能。` }, [source]).unsupportedField).toBeNull();
    expect(inspectDocumentedPlanEvidence({ ...reported, timing: date }, [source]).unsupportedField).toBe('timing');
    expect(source.quote).toBe(`${date} 医生建议：3个月后复查甲状腺功能。`);
  });

  it.each([
    '不建议复查肾功能，若仍有不适，建议三个月后复查甲状腺功能。',
    '暂无肾功能复查计划，若仍有不适，建议三个月后复查甲状腺功能。',
    '若仍有不适则暂无肾功能复查计划，建议三个月后复查甲状腺功能。'
  ])('否定或条件混合句不拆走作用条件：%s', (quote) => {
    expect(inspectDocumentedPlanEvidence(action({ title: DOCUMENTED_PLAN_NEUTRAL_TITLE,
      firstStep: '复查甲状腺功能。' }), [evidence(quote)]).evidence).toEqual([]);
  });

  it('原句、来源日期和时间已证明时，标题改写与正文证明分开，不靠同义词放宽', () => {
    const source = evidence('医生建议：记录家庭血压，复诊时一并查看血压和肾功能结果。');
    const date = evidence('检查日期：2026年9月10日。', { id: 'report-date', sourceSpanId: 'date-span' });
    const reported = action({ title: '记录家庭血压，复诊时一起查看',
      firstStep: '按2026年9月10日报告中的原建议：“记录家庭血压，复诊时一并查看血压和肾功能结果。”',
      timing: null, timingBasis: 'none' });
    const original = JSON.stringify(reported);
    expect(inspectDocumentedPlanEvidence(reported, [source, date])).toEqual({
      required: true, evidence: [source], unsupportedField: null, titleSupported: false
    });
    expect(inspectDocumentedPlanEvidence({ ...reported, title: DOCUMENTED_PLAN_NEUTRAL_TITLE }, [source, date]).titleSupported).toBe(true);
    expect(inspectDocumentedPlanEvidence(reported, [source]).unsupportedField).toBe('firstStep');
    expect(inspectDocumentedPlanEvidence(reported, [source, { ...date, documentId: 'other-report' }]).unsupportedField).toBe('firstStep');
    expect(JSON.stringify(reported)).toBe(original);
  });

  it.each([
    ['无需记录家庭血压，复诊时一并查看血压和肾功能结果。', 'firstStep'],
    ['不记录家庭血压，复诊时一并查看血压和肾功能结果。', 'firstStep'],
    ['记录家庭血压，不复诊，一并查看血压和肾功能结果。', 'firstStep'],
    ['记录家庭血压，复诊时一并查看血压和肾功能及胸部CT结果。', 'firstStep'],
    ['记录家庭血压，立即复诊时一并查看血压和肾功能结果。', 'timing'],
    ['记录家庭血压，三天后复诊时一并查看血压和肾功能结果。', 'timing'],
    ['按报告原建议：“记录家庭血压，复诊时一并查看血压和肾功能结果。”另外不要复诊。', 'firstStep']
  ])('正文不可被归因外壳或宽松片段匹配掩盖：%s', (firstStep, unsupportedField) => {
    const source = evidence('医生建议：记录家庭血压，复诊时一并查看血压和肾功能结果。');
    const check = inspectDocumentedPlanEvidence(action({ title: DOCUMENTED_PLAN_NEUTRAL_TITLE, firstStep,
      timing: null, timingBasis: 'none' }), [source]);
    expect(check).toMatchObject({ evidence: [], unsupportedField, titleSupported: false });
  });

  it('反向标题不通过，但不让它撤掉已证明的正文；中性标题不掩盖反向正文', () => {
    const source = evidence('建议三个月后复查甲状腺功能。');
    expect(inspectDocumentedPlanEvidence(action({ title: '无需复查甲状腺功能' }), [source]))
      .toMatchObject({ evidence: [source], unsupportedField: null, titleSupported: false });
    expect(inspectDocumentedPlanEvidence(action({ title: DOCUMENTED_PLAN_NEUTRAL_TITLE,
      firstStep: '无需复查甲状腺功能。' }), [source]).unsupportedField).toBe('firstStep');
  });

  it('原文必要条件和期限不能省略，时间字段不能加入反向指示', () => {
    const source = evidence('医生建议：若仍有不适，三个月后复查甲状腺功能。');
    const reported = action({ firstStep: '若仍有不适，复查甲状腺功能。' });
    expect(documentedPlanEvidence(reported, [source])).toEqual([source]);
    expect(inspectDocumentedPlanEvidence(action(), [source]).unsupportedField).toBe('firstStep');
    expect(inspectDocumentedPlanEvidence({ ...reported, timing: null }, [source]).unsupportedField).toBe('timing');
    expect(inspectDocumentedPlanEvidence({ ...reported, timing: '三个月后不复查' }, [source]).unsupportedField).toBe('timing');
  });

  it('数值的小数点不能被当作排版符号吞掉', () => {
    const source = evidence('医生建议：记录步行1.0公里后的感受。');
    expect(documentedPlanEvidence(action({ firstStep: '记录步行1.0公里后的感受。', timing: null }), [source])).toEqual([source]);
    expect(inspectDocumentedPlanEvidence(action({ firstStep: '记录步行10公里后的感受。', timing: null }), [source]).unsupportedField).toBe('firstStep');
  });

  it('多项原安排的期限必须保留对应位置，不能交换或折成全体通用期限', () => {
    const source = evidence('医生建议：三天后复查血常规，六个月后复查肝功能。');
    const reported = action({ firstStep: '三天后复查血常规，六个月后复查肝功能。', timing: null });
    expect(documentedPlanEvidence(reported, [source])).toEqual([source]);
    expect(inspectDocumentedPlanEvidence({ ...reported,
      title: '三天后复查血常规，六个月后复查肝功能' }, [source]).titleSupported).toBe(true);
    expect(inspectDocumentedPlanEvidence({ ...reported,
      title: '六个月后复查血常规，三天后复查肝功能' }, [source]))
      .toMatchObject({ evidence: [source], unsupportedField: null, titleSupported: false });
    expect(inspectDocumentedPlanEvidence({ ...reported,
      firstStep: '六个月后复查血常规，三天后复查肝功能。' }, [source]).unsupportedField).toBe('timing');
    expect(inspectDocumentedPlanEvidence({ ...reported,
      firstStep: '复查血常规，复查肝功能。', timing: '三天后，六个月后' }, [source]).unsupportedField).toBe('timing');
  });

  it('无具体项目的原安排可以原样保留，不凭空新增项目', () => {
    const source = evidence('三个月后复查。');
    expect(documentedPlanEvidence(action({ title: '三个月后复查', firstStep: '按原报告安排复查。' }), [source])).toEqual([source]);
    expect(documentedPlanEvidence(action(), [source])).toEqual([]);
  });

  it('实际项目的白话简写可对应，但不能额外扩出其他检查项目', () => {
    const source = evidence('建议三个月后复查肝功能。');
    expect(documentedPlanEvidence(action({ title: '复查肝功', firstStep: '带上既往报告，按原安排复查肝功。' }), [source])).toEqual([source]);
    expect(documentedPlanEvidence(action({ title: '复查肝功能和胸部CT', firstStep: '复查肝功能和胸部CT。' }), [source])).toEqual([]);
  });

  it.each([
    ['普通检查数值', '甲状腺功能TSH 2.1 mIU/L。'],
    ['相似词不是指示', 'C反应蛋白在参考范围，甲状腺功能正常。'],
    ['否定建议', '未建议复查甲状腺功能。'],
    ['无需复查', '无需复查甲状腺功能。'],
    ['建议不复查', '建议不复查甲状腺功能。'],
    ['不同项目', '建议三个月后复查肝功能。'],
    ['结果借用其他安排', '甲状腺功能正常。建议三个月后复查肝功能。'],
    ['时间错配', '建议六个月后复查甲状腺功能。'],
    ['时间单位错配', '建议三天后复查甲状腺功能。'],
    ['时间前后错配', '建议三个月内复查甲状腺功能。']
  ])('%s不能只靠AI枚举标成医生原安排', (_label, quote) => {
    expect(documentedPlanEvidence(action(), [evidence(quote, { label: '医嘱报告.pdf' })])).toEqual([]);
  });

  it.each([
    ['没有实际引用', { evidenceIds: [] }, {}],
    ['引用了另一节点', { evidenceIds: ['other-source'] }, {}],
    ['本人自述', {}, { kind: 'user_note' as const }],
    ['外部知识', {}, { kind: 'knowledge' as const }],
    ['没有报告来源', {}, { documentId: null }],
    ['没有原文片段', {}, { sourceSpanId: null }]
  ])('%s不作为报告医嘱证明', (_label, actionOverrides, evidenceOverrides) => {
    expect(documentedPlanEvidence(action(actionOverrides), [evidence('建议三个月后复查甲状腺功能。', evidenceOverrides)])).toEqual([]);
  });

  it('当前参考建议不因标题中有复查而被当作原医生安排', () => {
    expect(documentedPlanEvidence(action({ kind: 'test_followup', timingBasis: 'none' }), [evidence('建议三个月后复查甲状腺功能。')])).toEqual([]);
  });

  it('只有timingBasis声明documented也必须有来源，输出引用不改原文时间', () => {
    const source = evidence('建议2026年12月复查甲状腺功能。');
    expect(documentedPlanEvidence(action({ kind: 'test_followup', timing: '2026-12' }), [source])).toEqual([source]);
    expect(source.quote).toBe('建议2026年12月复查甲状腺功能。');
  });

  it('documented_plan不靠更换timingBasis绕开原安排时间', () => {
    expect(documentedPlanEvidence(action({ timingBasis: 'none' }), [evidence('建议六个月后复查甲状腺功能。')])).toEqual([]);
  });

  it('纯合成儿童原建议没有期限时仍可保留，额外就诊准备不能冒充原指示', () => {
    const source = evidence('医生建议：由家长陪同到眼科进一步检查，结合散瞳验光结果判断屈光状态。');
    const reported = action({
      title: '由家长陪同完成眼科检查',
      firstStep: '由家长陪同到眼科进一步检查，结合散瞳验光结果判断屈光状态。',
      timing: null, timingBasis: 'none',
      why: '家长补充孩子看黑板不清楚，需要进一步了解原因。'
    });
    expect(documentedPlanEvidence(reported, [source])).toEqual([source]);
    const expanded = { ...reported,
      firstStep: `${reported.firstStep}就诊时带上这次视力和验光记录，说明看黑板不清楚、目前未戴眼镜。` };
    expect(documentedPlanEvidence(expanded, [source])).toEqual([]);
    expect(documentedPlanEvidence({ ...expanded, timingBasis: 'documented' }, [source])).toEqual([]);
    expect(documentedPlanEvidence({ ...reported, timing: '近期', timingBasis: 'documented' }, [source])).toEqual([]);
    expect(documentedPlanEvidence({ ...reported, firstStep: `${reported.firstStep}并检查肝功能。` }, [source])).toEqual([]);
    expect(documentedPlanEvidence(reported, [evidence('右眼裸眼远视力：0.6。', { label: '医生建议报告.pdf' })])).toEqual([]);
    expect(documentedPlanEvidence(reported, [evidence('未建议到眼科进一步检查。')])).toEqual([]);
  });

  it.each([
    '暂无甲状腺功能复查计划。',
    '尚无甲状腺功能复查安排。',
    '没有甲状腺功能复查建议。',
    '暂无甲状腺功能复查的计划。',
    '没有医生建议，甲状腺功能在范围内。',
    '甲状腺功能复查计划未记录。',
    '无甲状腺功能复查医嘱。',
    '这不是医生安排，甲状腺功能可再讨论。',
    '甲状腺功能复查不在医嘱中。',
    '甲状腺功能复查：暂无计划。',
    '甲状腺功能复查：未安排。',
    '甲状腺功能复查暂未安排。',
    '未计划复查甲状腺功能。',
    '甲状腺功能复查，暂无安排。',
    '暂无计划，复查甲状腺功能。',
    '甲状腺功能复查。',
    '暂不复查甲状腺功能。',
    '甲状腺功能无须复查。'
  ])('不写具体时间也不能把缺失/否定安排反成医嘱：%s', (quote) => {
    expect(documentedPlanEvidence(action({ timing: null }), [evidence(quote)])).toEqual([]);
  });

  it('纯无医嘱说明不能支撑泛化的遵医嘱行动', () => {
    expect(documentedPlanEvidence(action({ title: '按原安排复查', firstStep: '按原安排复查。', timing: null }), [evidence('无医嘱。')])).toEqual([]);
  });

  it('不存在另一项目安排，不妨碍引用原文真正写有的本项目医嘱', () => {
    const source = evidence('暂无肝功能复查计划，建议3个月后复查甲状腺功能。');
    expect(documentedPlanEvidence(action(), [source])).toEqual([source]);
  });

  it('真实指示跨逗号时仍保留其具体项目和时间', () => {
    const source = evidence('建议三个月后，复查甲状腺功能。');
    expect(documentedPlanEvidence(action(), [source])).toEqual([source]);
  });

  it('同项目暂无安排后，相邻独立的肯定医嘱仍可引用', () => {
    const source = evidence('甲状腺功能复查，暂无安排。医生建议3个月后复查甲状腺功能。');
    expect(documentedPlanEvidence(action(), [source])).toEqual([source]);
  });

  it('否定与另一个明确肯定指示共句时，不把项目标题当指示，保留独立医嘱', () => {
    const source = evidence('暂无肝功能复查安排，医生建议3个月后复查甲状腺功能。');
    expect(documentedPlanEvidence(action(), [source])).toEqual([source]);
    expect(documentedPlanEvidence(action({ title: '复查肝功能', firstStep: '复查肝功能。', timing: null }), [source])).toEqual([]);
  });
});
