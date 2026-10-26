import { describe, expect, it } from 'vitest';
import type { HealthAction, HealthClaim, MemberAssessmentCandidateV3, MemberEvidenceRef } from '@contracts';
import { assessmentLimitationConsistencyTargets, assessmentReviewNodeHash, filterAssessmentReviewIssues,
  partitionAssessmentReviewIssues } from './assessment-semantic-review.js';
import { validateAssessmentCandidate } from './assessment-validation.js';

function source(overrides: Partial<MemberEvidenceRef> = {}): MemberEvidenceRef {
  return { id: 'synthetic-source', kind: 'observation', observationId: 'synthetic-observation',
    eventId: 'synthetic-event', documentId: 'synthetic-document', sourceSpanId: 'synthetic-span', knowledgeId: null,
    label: '合成原件', locator: '合成页1', quote: '合成原始记录中有需要核对的完整临床文字。', ...overrides };
}

function claim(overrides: Partial<HealthClaim> = {}): HealthClaim {
  return { id: 'claim:synthetic:result', topicKey: 'synthetic-topic', systemIds: [], kind: 'diagnostic_assessment',
    text: '原资料记载合成诊断。', diseaseName: '合成诊断', diagnosticStatus: 'documented',
    temporalStatus: 'historical', evidenceIds: ['synthetic-source'], counterEvidenceIds: [], trendIds: [],
    knowledgeBasis: 'not_applicable', knowledgeSourceIds: [], criteriaBasis: null,
    rationale: '原资料提供了相应文字。', materialUncertainty: '仍需临床核实。', consequenceLevel: 'routine', ...overrides };
}

function action(overrides: Partial<HealthAction> = {}): HealthAction {
  return { id: 'action:synthetic:plan', dedupeKey: 'synthetic-plan', systemIds: [], claimIds: [],
    kind: 'documented_plan', title: '报告中的医生建议', why: '按原安排与医生沟通。',
    firstStep: '若仍有不适，请按原报告安排联系原接诊医生。', timing: null, timingBasis: 'documented',
    reviewPlan: null, caution: null, urgency: 'routine', evidenceIds: ['synthetic-source'], knowledgeSourceIds: [], ...overrides };
}

function candidate(): MemberAssessmentCandidateV3 {
  return { schemaVersion: 3, personId: 'synthetic-person', inputSignature: 'a'.repeat(64), mode: 'full',
    requestedSystemIds: [], overview: { id: 'overview', headline: '合成资料概况', summary: '按原报告讨论后续安排。',
      claimIds: [], actionIds: [], limitations: [] }, systems: [], claims: [claim()], actions: [action()],
    questions: [], knowledgeSources: [] };
}

function general(overrides: Partial<HealthAction> = {}): HealthAction {
  return action({ id: 'action:synthetic:general', kind: 'habit', lifestyleDomain: 'supplements', lifestyleBasis: 'general',
    firstStep: '不建议为了视力额外添加保健品；先整理现用产品清单。',
    title: '营养补充先看食物', why: '日常饮食从多样化食物开始。',
    timing: '先试一周', timingBasis: 'practical_trial', evidenceIds: [], ...overrides });
}

const generalIssues = ['general_lifestyle_not_low_risk:action:synthetic:general',
  'action_personal_evidence_required:action:synthetic:general'];

function generalCandidate(overrides: Partial<HealthAction> = {}): MemberAssessmentCandidateV3 {
  const value = candidate();
  value.claims = [];
  value.actions = [general(overrides)];
  value.overview.actionIds = [value.actions[0]!.id];
  return value;
}

function claimSupportedHabit(overrides: Partial<HealthAction> = {}): MemberAssessmentCandidateV3 {
  const value = candidate();
  value.claims[0] = { ...claim(), kind: 'source_fact', diseaseName: null, diagnosticStatus: null,
    criteriaBasis: null, text: '本人记录了日常饮食情况。', rationale: '本人补充了饮食记录。',
    materialUncertainty: null };
  value.actions = [general({ lifestyleDomain: 'diet', lifestyleBasis: 'personalized',
    claimIds: [value.claims[0]!.id], title: '逐步调整日常饮食', why: '结合本人饮食记录，从一件小事开始。',
    firstStep: '午餐先加一份蔬菜。', evidenceIds: [], knowledgeSourceIds: [], ...overrides })];
  value.overview.claimIds = [value.claims[0]!.id];
  value.overview.actionIds = [value.actions[0]!.id];
  return value;
}

function receipt(candidate: MemberAssessmentCandidateV3, targetId: string): Map<string, string> {
  const hash = assessmentReviewNodeHash(candidate, targetId);
  expect(hash).not.toBeNull();
  return new Map([[targetId, hash!]]);
}

describe('本地语义问题仅转交一次P04', () => {
  it('资料缺口也是需要实际来源核对的主张，路由不猜测方法或替换正文', () => {
    const value = candidate();
    value.claims = [claim({ diagnosticStatus: null, kind: 'interpretation', diseaseName: null,
      text: '后一次检查方式未提供。', materialUncertainty: null })];
    const original = structuredClone(value);
    expect(assessmentLimitationConsistencyTargets(value)).toContain(value.claims[0]!.id);
    expect(value).toEqual(original);
    value.claims[0]!.text = '原报告记录合成检查。';
    expect(assessmentLimitationConsistencyTargets(value)).not.toContain(value.claims[0]!.id);
    value.claims[0]!.materialUncertainty = '检查背景未提供。';
    expect(assessmentLimitationConsistencyTargets(value)).toContain(value.claims[0]!.id);
  });

  it('历史药物原记录的否定免责声明不阻断来源语义复核，肯定改药仍不可豁免', () => {
    const value = candidate();
    value.claims = [];
    const quote = '合成药甲 1片 口服 每日一次';
    value.actions = [action({ title: '历史用药原记录', why: '这是当时记录，当前处方未知。',
      firstStep: quote, sourceInstructionObservationId: 'synthetic-observation',
      caution: '原记录未提供疗程，不表示今天应开始、续用或停用。' })];
    const catalog = [source({ quote })];
    const input = { personId: value.personId, inputSignature: value.inputSignature, mode: value.mode,
      requestedSystemIds: [], evidenceCatalog: catalog, trendIds: [], catalogKnowledgeIds: [], criteriaSets: [] };
    const issues = validateAssessmentCandidate(value, input).issues;
    expect(issues).toEqual(['documented_plan_source_not_proven:action:synthetic:plan']);
    expect(partitionAssessmentReviewIssues(value, issues, catalog)).toEqual({
      localIssues: [], semanticIssues: issues, targetIds: ['action:synthetic:plan'] });
    expect(filterAssessmentReviewIssues(value, issues, new Map(), catalog)).toEqual(issues);
    expect(filterAssessmentReviewIssues(value, issues, receipt(value, value.actions[0]!.id), catalog)).toEqual([]);

    value.actions[0]!.caution = '不表示今天应开始、续用或停用，但现在请停用合成药甲。';
    const directIssues = validateAssessmentCandidate(value, input).issues;
    expect(directIssues).toContain('direct_medication_change:action:synthetic:plan');
    expect(partitionAssessmentReviewIssues(value, directIssues, catalog).localIssues).toEqual(directIssues);
    expect(filterAssessmentReviewIssues(value, directIssues, receipt(value, value.actions[0]!.id), catalog))
      .toEqual(directIssues);
  });

  it('有唯一可定位个人原文的常规个性化习惯必须经完整 P04 才能使用关联主张依据', () => {
    const value = claimSupportedHabit();
    const issues = ['action_personal_evidence_required:action:synthetic:general'];
    const catalog = [source({ quote: '本人记录：日常饮食中蔬菜较少。' })];
    const input = { personId: value.personId, inputSignature: value.inputSignature, mode: value.mode,
      requestedSystemIds: [], evidenceCatalog: catalog, trendIds: [], catalogKnowledgeIds: [], criteriaSets: [] };
    expect(validateAssessmentCandidate(value, input).issues).toEqual(issues);
    expect(partitionAssessmentReviewIssues(value, issues, catalog)).toEqual({
      localIssues: [], semanticIssues: issues, targetIds: ['action:synthetic:general'] });
    expect(filterAssessmentReviewIssues(value, issues, new Map(), catalog)).toEqual(issues);
    expect(filterAssessmentReviewIssues(value, issues, receipt(value, value.actions[0]!.id), catalog)).toEqual([]);
    value.claims[0]!.text = '关联主张的正文后来发生改变。';
    const oldReceipt = receipt(claimSupportedHabit(), value.actions[0]!.id);
    expect(filterAssessmentReviewIssues(value, issues, oldReceipt, catalog)).toEqual(issues);
  });

  it.each([
    ['知识来源', { kind: 'knowledge' }], ['目录标签', { kind: 'event_metadata' }],
    ['没有引文和观测定位', { quote: null, observationId: null }], ['没有文件', { documentId: null }],
    ['没有片段定位', { sourceSpanId: null }], ['挂了知识 ID', { knowledgeId: 'synthetic-knowledge' }]
  ] as Array<[string, Partial<MemberEvidenceRef>]>)('%s不能替代个人主张依据', (_label, overrides) => {
    const value = claimSupportedHabit();
    const issues = ['action_personal_evidence_required:action:synthetic:general'];
    expect(partitionAssessmentReviewIssues(value, issues, [source(overrides)])).toEqual({
      localIssues: issues, semanticIssues: [], targetIds: [] });
    expect(filterAssessmentReviewIssues(value, issues, receipt(value, value.actions[0]!.id), [source(overrides)]))
      .toEqual(issues);
  });

  it('完整观测定位可进入 P04，但不能仅凭 locator 自动通过；真正缺引用仍留在本地', () => {
    const value = claimSupportedHabit();
    const issues = ['action_personal_evidence_required:action:synthetic:general'];
    const located = source({ quote: null });
    expect(partitionAssessmentReviewIssues(value, issues, [located]).targetIds).toEqual([value.actions[0]!.id]);
    expect(filterAssessmentReviewIssues(value, issues, new Map(), [located])).toEqual(issues);
    expect(partitionAssessmentReviewIssues(value, issues, [source({ quote: null, observationId: null })]).localIssues)
      .toEqual(issues);
  });

  it('记录用途可以送 P04，新增复查和无剂量补充剂仍不能借关联主张放行', () => {
    const issues = ['action_personal_evidence_required:action:synthetic:general'];
    const routine = claimSupportedHabit({ why: '记录目前习惯供下次就诊了解，不据此确定病因。' });
    expect(partitionAssessmentReviewIssues(routine, issues, [source()]).targetIds).toEqual([routine.actions[0]!.id]);
    for (const firstStep of ['三个月后复查肝功能。', '每天服用鱼油。']) {
      const medical = claimSupportedHabit({ firstStep });
      expect(partitionAssessmentReviewIssues(medical, issues, [source()]).localIssues).toEqual(issues);
    }
    const safety = claimSupportedHabit({ caution: '如出现胸痛，请停止活动并就医。' });
    expect(partitionAssessmentReviewIssues(safety, issues, [source()]).targetIds).toEqual([safety.actions[0]!.id]);
  });

  it('重复、未知和被隔离的关联主张不能借 P04 回执放行；本人补充可凭唯一原文核对', () => {
    const value = claimSupportedHabit();
    const issues = ['action_personal_evidence_required:action:synthetic:general'];
    for (const catalog of [[], [source(), source()], [source({ id: 'other-source' })]]) {
      expect(partitionAssessmentReviewIssues(value, issues, catalog).localIssues).toEqual(issues);
    }
    const held = structuredClone(value);
    held.claims = [];
    expect(partitionAssessmentReviewIssues(held, issues, [source()]).localIssues).toEqual(issues);
    const note = source({ kind: 'user_note', documentId: null, sourceSpanId: null, observationId: null,
      quote: '本人补充：平时吃蔬菜较少。' });
    expect(partitionAssessmentReviewIssues(value, issues, [note]).targetIds).toEqual([value.actions[0]!.id]);
  });

  it.each([
    ['非生活习惯', { kind: 'test_followup' }], ['非一般时效', { urgency: 'soon' }],
    ['报告指示', { timingBasis: 'documented' }], ['指南时效', { timingBasis: 'guideline' }],
    ['原文绑定', { sourceInstructionObservationId: 'synthetic-observation' }],
    ['一般标签', { lifestyleBasis: 'general' }], ['无生活领域', { lifestyleDomain: undefined }],
    ['预约门诊', { firstStep: '下周预约门诊检查。' }], ['复查检查', { firstStep: '三个月后复查肝功能。' }],
    ['注意栏复查检查', { caution: '三个月后复查肝功能。' }],
    ['注意栏定期就诊', { caution: '如有不适，每周就医。' }],
    ['直接改药', { firstStep: '请开始服用阿托伐他汀。' }],
    ['数字补充剂', { firstStep: '每天服用维生素D 1000 IU。' }],
    ['高后果断言', { why: '目前高度怀疑肺癌。' }]
  ] as Array<[string, Partial<HealthAction>]>)('%s不能借关联主张走常规习惯豁免', (_label, overrides) => {
    const value = claimSupportedHabit(overrides);
    const issues = ['action_personal_evidence_required:action:synthetic:general'];
    expect(partitionAssessmentReviewIssues(value, issues, [source()]).localIssues).toEqual(issues);
    expect(filterAssessmentReviewIssues(value, issues, receipt(value, value.actions[0]!.id), [source()]))
      .toEqual(issues);
  });

  it('原诊断或原安排的语义问题保留原串与带冒号ID，需要真实完整个人原件引用', () => {
    const value = candidate();
    const issues = ['documented_source_not_proven:claim:synthetic:result',
      'documented_plan_source_not_proven:action:synthetic:plan',
      'documented_plan_instruction_not_proven:action:synthetic:plan',
      'documented_plan_timing_not_proven:action:synthetic:plan',
      'documented_plan_title_not_supported:action:synthetic:plan'];
    expect(partitionAssessmentReviewIssues(value, issues, [source()])).toEqual({
      localIssues: [], semanticIssues: issues, targetIds: ['claim:synthetic:result', 'action:synthetic:plan'] });
    expect(partitionAssessmentReviewIssues(value, issues)).toEqual({ localIssues: issues, semanticIssues: [], targetIds: [] });
  });

  it('独立诊断栏目与多个来源条目的复合病名和缩写标题交给同次 P04，不按拆词自动证明', () => {
    const value = candidate();
    value.actions = [];
    value.overview.claimIds = [value.claims[0]!.id];
    Object.assign(value.claims[0]!, { title: '原报告诊断为合成甲、乙及丙病',
      diseaseName: '合成甲病、合成乙病、合成丙病',
      text: '原资料分别记载了三项合成诊断，现状仍需结合后续检查。',
      evidenceIds: ['synthetic-heading', 'synthetic-diagnosis-a', 'synthetic-diagnosis-b', 'synthetic-diagnosis-c'] });
    const catalog = [source({ id: 'synthetic-heading', sourceSpanId: 'heading-span', quote: '出院诊断：' }),
      ...['甲', '乙', '丙'].map((item, index) => source({ id: `synthetic-diagnosis-${['a', 'b', 'c'][index]}`,
        sourceSpanId: `diagnosis-span-${index}`, quote: `合成${item}病` }))];
    const input = { personId: value.personId, inputSignature: value.inputSignature, mode: value.mode,
      requestedSystemIds: [], evidenceCatalog: catalog, trendIds: [], catalogKnowledgeIds: [], criteriaSets: [] };
    const before = structuredClone(value);
    const issues = validateAssessmentCandidate(value, input).issues;
    expect(issues).toEqual(['diagnostic_title_contradiction:claim:synthetic:result',
      'documented_source_not_proven:claim:synthetic:result']);
    expect(partitionAssessmentReviewIssues(value, issues, catalog)).toEqual({
      localIssues: [], semanticIssues: issues, targetIds: ['claim:synthetic:result'] });
    expect(filterAssessmentReviewIssues(value, issues, new Map(), catalog)).toEqual(issues);
    expect(filterAssessmentReviewIssues(value, issues, receipt(value, value.claims[0]!.id), catalog)).toEqual([]);
    expect(value).toEqual(before);
    // 凭据只消费相同全文；标题缩写的自动来源证明始终没有发生。
    expect(validateAssessmentCandidate(value, input).issues).toEqual(issues);
  });

  it.each([
    ['否定', '出院诊断：未见合成甲病。'],
    ['疑似', '出院诊断：考虑合成甲病。'],
    ['家属', '父亲出院诊断：合成甲病。'],
    ['历史', '既往诊断：合成甲病。']
  ])('%s原文不能仅靠交给语义复核自动证明来源或标题', (_label, quote) => {
    const value = candidate();
    value.actions = [];
    value.overview.claimIds = [value.claims[0]!.id];
    Object.assign(value.claims[0]!, { title: '目前确诊合成甲病', diseaseName: '合成甲病', temporalStatus: 'historical' });
    const catalog = [source({ quote })];
    const input = { personId: value.personId, inputSignature: value.inputSignature, mode: value.mode,
      requestedSystemIds: [], evidenceCatalog: catalog, trendIds: [], catalogKnowledgeIds: [], criteriaSets: [] };
    const issues = validateAssessmentCandidate(value, input).issues;
    expect(issues).toContain('diagnostic_title_contradiction:claim:synthetic:result');
    if (_label !== '历史') expect(issues).toContain('documented_source_not_proven:claim:synthetic:result');
    expect(partitionAssessmentReviewIssues(value, issues, catalog).semanticIssues).toEqual(issues);
    expect(filterAssessmentReviewIssues(value, issues, new Map(), catalog)).toEqual(issues);
  });

  it('新疾病标题不能从已有诊断得到自动同义豁免；仅同一完整节点的明确 P04 凭据可消费问题', () => {
    const value = candidate();
    value.actions = [];
    value.overview.claimIds = [value.claims[0]!.id];
    Object.assign(value.claims[0]!, { title: '原报告诊断为合成甲病', diseaseName: '合成甲病' });
    const catalog = [source({ quote: '出院诊断：合成甲病。' })];
    const oldReceipts = receipt(value, value.claims[0]!.id);
    const input = { personId: value.personId, inputSignature: value.inputSignature, mode: value.mode,
      requestedSystemIds: [], evidenceCatalog: catalog, trendIds: [], catalogKnowledgeIds: [], criteriaSets: [] };
    expect(validateAssessmentCandidate(value, input).issues).toEqual([]);
    value.claims[0]!.title = '原报告诊断为合成乙病';
    const issues = validateAssessmentCandidate(value, input).issues;
    expect(issues).toEqual(['diagnostic_title_contradiction:claim:synthetic:result']);
    expect(filterAssessmentReviewIssues(value, issues, oldReceipts, catalog)).toEqual(issues);
    const reviewed = receipt(value, value.claims[0]!.id);
    expect(filterAssessmentReviewIssues(value, issues, reviewed, catalog)).toEqual([]);
    for (const change of [
      { text: '另一段未经复核的正文。' }, { diseaseName: '合成丙病' },
      { temporalStatus: 'current' as const }, { evidenceIds: [] },
      { materialUncertainty: '未经复核的新适用条件。' }
    ]) {
      const changed = structuredClone(value);
      Object.assign(changed.claims[0]!, change);
      expect(filterAssessmentReviewIssues(changed, issues, reviewed, catalog)).toEqual(issues);
    }
  });

  it('未分型为原诊断、汇总标题和同节点结构错误仍不能借原诊断语义路线放行', () => {
    const issues = ['diagnostic_title_contradiction:claim:synthetic:result'];
    for (const overrides of [
      { diagnosticStatus: 'possible' as const }, { kind: 'source_fact' as const }, { diseaseName: null }
    ]) {
      const value = candidate();
      Object.assign(value.claims[0]!, overrides);
      expect(partitionAssessmentReviewIssues(value, issues, [source()]).localIssues).toEqual(issues);
      expect(filterAssessmentReviewIssues(value, issues, receipt(value, value.claims[0]!.id), [source()])).toEqual(issues);
    }
    const value = candidate();
    const summaryIssues = ['diagnostic_title_contradiction:overview'];
    expect(partitionAssessmentReviewIssues(value, summaryIssues, [source()]).localIssues).toEqual(summaryIssues);
    const hardIssues = [...issues, 'unknown_evidence:claim:synthetic:result:missing'];
    expect(partitionAssessmentReviewIssues(value, hardIssues, [source()]).localIssues).toEqual(hardIssues);
    expect(filterAssessmentReviewIssues(value, hardIssues, receipt(value, value.claims[0]!.id), [source()]))
      .toEqual(hardIssues);
  });

  it.each([
    ['仅模型标签', { kind: 'event_metadata' as const, label: '出院诊断：合成甲病' }],
    ['知识条目', { kind: 'knowledge' as const }], ['空原文', { quote: null }],
    ['无原件', { documentId: null }], ['无片段', { sourceSpanId: null }],
    ['知识伪装', { knowledgeId: 'synthetic-knowledge' }]
  ])('%s不能把诊断标题问题交给原诊断语义路线或消费旧回执', (_label, overrides) => {
    const value = candidate();
    const issues = ['diagnostic_title_contradiction:claim:synthetic:result'];
    const catalog = [source(overrides)];
    expect(partitionAssessmentReviewIssues(value, issues, catalog).localIssues).toEqual(issues);
    expect(filterAssessmentReviewIssues(value, issues, receipt(value, value.claims[0]!.id), catalog)).toEqual(issues);
  });

  it.each([
    ['空引文', { quote: '' }], ['缺引文', { quote: null }], ['无文件', { documentId: null }],
    ['无定位', { sourceSpanId: null }], ['知识', { kind: 'knowledge' }],
    ['目录标签', { kind: 'event_metadata' }], ['用户自行计划', { kind: 'user_note' }]
  ] as Array<[string, Partial<MemberEvidenceRef>]>)('%s不能把来源证明问题转成语义豁免', (_label, overrides) => {
    const value = candidate();
    const issues = ['documented_plan_source_not_proven:action:synthetic:plan'];
    expect(partitionAssessmentReviewIssues(value, issues, [source(overrides)]).localIssues).toEqual(issues);
    expect(filterAssessmentReviewIssues(value, issues, receipt(value, value.actions[0]!.id), [source(overrides)])).toEqual(issues);
  });

  it('目录中不存在、重复或行动没有引用的个人来源均不支持语义转交', () => {
    const issues = ['documented_plan_source_not_proven:action:synthetic:plan'];
    for (const catalog of [[], [source({ id: 'unrelated' })], [source(), source()]]) {
      expect(partitionAssessmentReviewIssues(candidate(), issues, catalog).localIssues).toEqual(issues);
    }
    const value = candidate();
    value.actions[0]!.evidenceIds = [];
    expect(partitionAssessmentReviewIssues(value, issues, [source()]).localIssues).toEqual(issues);
  });

  it.each(['unknown_evidence', 'permission_denied', 'direct_medication_change', 'unsourced_probability', 'unknown_claim']) (
    '同节点%s硬问题不能被语义转交或旧通过凭据屏蔽', (code) => {
      const value = candidate();
      const issues = ['documented_plan_source_not_proven:action:synthetic:plan', `${code}:action:synthetic:plan:detail`];
      expect(partitionAssessmentReviewIssues(value, issues, [source()])).toEqual({
        localIssues: issues, semanticIssues: [], targetIds: [] });
      expect(filterAssessmentReviewIssues(value, issues, receipt(value, value.actions[0]!.id), [source()])).toEqual(issues);
    }
  );

  it('绑定失败始终留在本地，同节点已有来源语义问题也不能借位', () => {
    const value = candidate();
    const issues = ['documented_plan_instruction_not_proven:action:synthetic:plan',
      'source_instruction:action:synthetic:plan:fact_not_found'];
    expect(partitionAssessmentReviewIssues(value, issues, [source()]).localIssues).toEqual(issues);
    expect(filterAssessmentReviewIssues(value, issues, receipt(value, value.actions[0]!.id), [source()])).toEqual(issues);
  });

  it('未知、歧义目标及全局结构或权限问题继续本地处理', () => {
    const value = candidate();
    const issues = ['documented_source_not_proven:missing:claim', 'scope_mismatch',
      'documented_plan_source_not_proven:action:synthetic:plan'];
    expect(partitionAssessmentReviewIssues(value, issues, [source()]).localIssues).toEqual(issues);
    value.actions.push({ ...value.actions[0]! });
    expect(partitionAssessmentReviewIssues(value, [issues[2]!], [source()]).localIssues).toEqual([issues[2]]);
  });

  it('否定补充剂建议可交语义审查，但未取得通过凭据时原本地问题仍未通过', () => {
    const value = generalCandidate();
    const input = { personId: value.personId, inputSignature: value.inputSignature, mode: value.mode,
      requestedSystemIds: [], evidenceCatalog: [], trendIds: [], catalogKnowledgeIds: [], criteriaSets: [] };
    expect(validateAssessmentCandidate(value, input).issues).toEqual(generalIssues);
    expect(partitionAssessmentReviewIssues(value, generalIssues)).toEqual({
      localIssues: [], semanticIssues: generalIssues, targetIds: ['action:synthetic:general'] });
    expect(filterAssessmentReviewIssues(value, generalIssues, new Map())).toEqual(generalIssues);
    expect(filterAssessmentReviewIssues(value, generalIssues, new Map([['action:synthetic:general', 'pass']]))).toEqual(generalIssues);
    expect(filterAssessmentReviewIssues(value, generalIssues, receipt(value, 'action:synthetic:general'))).toEqual([]);
  });

  it.each([
    ['非习惯', { kind: 'treatment_discussion' }], ['非普通时效', { urgency: 'soon' }],
    ['个体依据', { lifestyleBasis: 'personalized' }], ['无生活领域', { lifestyleDomain: undefined }],
    ['关联主张', { claimIds: ['claim:synthetic:result'] }], ['个人引用', { evidenceIds: ['synthetic-source'] }],
    ['知识引用', { knowledgeSourceIds: ['synthetic-knowledge'] }], ['指南期限', { timingBasis: 'guideline' }],
    ['绑定编号', { sourceInstructionObservationId: 'synthetic-observation' }],
    ['直接改药', { firstStep: '请开始服用阿托伐他汀。' }],
    ['数字剂量', { firstStep: '每天服用维生素D 1000 IU。' }],
    ['高后果断言', { why: '目前可能有肺癌。' }]
  ] as Array<[string, Partial<HealthAction>]>)('%s不能按一般生活意图转交', (_label, overrides) => {
    const value = generalCandidate(overrides);
    expect(partitionAssessmentReviewIssues(value, generalIssues).localIssues).toEqual(generalIssues);
    const hash = assessmentReviewNodeHash(value, 'action:synthetic:general');
    const receipts = new Map([['action:synthetic:general', hash ?? 'synthetic-prior-pass']]);
    expect(filterAssessmentReviewIssues(value, generalIssues, receipts)).toEqual(generalIssues);
  });

  it('无依据的个人断言没有通过凭据仍不放行；单独的个人依据缺失不能借一般问题配对', () => {
    const value = generalCandidate({ why: '你的血压偏高，所以需要调整。' });
    expect(filterAssessmentReviewIssues(value, generalIssues, new Map())).toEqual(generalIssues);
    const personalOnly = [generalIssues[1]!];
    expect(partitionAssessmentReviewIssues(value, personalOnly).localIssues).toEqual(personalOnly);
    expect(filterAssessmentReviewIssues(value, personalOnly, receipt(value, 'action:synthetic:general'))).toEqual(personalOnly);
  });

  it('一般行动上的未核实概率、其他硬问题均阻止语义豁免', () => {
    const value = generalCandidate();
    const issues = [...generalIssues, 'unsourced_probability:action:synthetic:general'];
    expect(partitionAssessmentReviewIssues(value, issues).localIssues).toEqual(issues);
    expect(filterAssessmentReviewIssues(value, issues, receipt(value, 'action:synthetic:general'))).toEqual(issues);
  });

  it('只按各自节点匹配问题，不因另一个节点有凭据而删除本地问题', () => {
    const value = candidate();
    const issues = ['documented_source_not_proven:claim:synthetic:result',
      'documented_plan_source_not_proven:action:synthetic:plan', 'unknown_evidence:claim:synthetic:result:missing'];
    const receipts = receipt(value, value.claims[0]!.id);
    receipts.set(value.actions[0]!.id, assessmentReviewNodeHash(value, value.actions[0]!.id)!);
    expect(filterAssessmentReviewIssues(value, issues, receipts, [source()])).toEqual([issues[0], issues[2]]);
  });
});

describe('P04通过凭据绑定完整节点和当前依赖', () => {
  it('哈希稳定覆盖完整节点，缺失和重复节点不能获得哈希', () => {
    const value = candidate();
    expect(assessmentReviewNodeHash(value, 'action:synthetic:plan')).toMatch(/^[a-f0-9]{64}$/);
    expect(assessmentReviewNodeHash(structuredClone(value), 'action:synthetic:plan'))
      .toBe(assessmentReviewNodeHash(value, 'action:synthetic:plan'));
    expect(assessmentReviewNodeHash(value, 'missing')).toBeNull();
    value.actions.push({ ...value.actions[0]! });
    expect(assessmentReviewNodeHash(value, 'action:synthetic:plan')).toBeNull();
  });

  it.each(['title', 'why', 'firstStep', 'timing', 'reviewPlan', 'caution'] as const)(
    '同ID的%s变化使原凭据失效', (field) => {
      const value = candidate();
      const issues = ['documented_plan_instruction_not_proven:action:synthetic:plan'];
      const receipts = receipt(value, value.actions[0]!.id);
      value.actions[0]![field] = '变更后的合成内容。';
      expect(filterAssessmentReviewIssues(value, issues, receipts, [source()])).toEqual(issues);
    }
  );

  it('行动的关联主张正文、诊断分型、条件或知识条目变化都使凭据失效', () => {
    const original = candidate();
    original.actions[0]!.claimIds = [original.claims[0]!.id];
    original.claims[0]!.knowledgeSourceIds = ['synthetic-knowledge'];
    original.knowledgeSources = [{ id: 'synthetic-knowledge', title: '合成知识', organization: null,
      url: 'https://example.com/synthetic', origin: 'retrieved', supports: '合成适用条件。' }];
    const id = original.actions[0]!.id;
    const hash = assessmentReviewNodeHash(original, id);
    const changedText = structuredClone(original);
    changedText.claims[0]!.text = '另一个判断。';
    const changedStatus = structuredClone(original);
    changedStatus.claims[0]!.diagnosticStatus = 'possible';
    const changedCondition = structuredClone(original);
    changedCondition.claims[0]!.materialUncertainty = '新的适用限制。';
    const changedKnowledge = structuredClone(original);
    changedKnowledge.knowledgeSources[0]!.supports = '不同的适用条件。';
    for (const changed of [changedText, changedStatus, changedCondition, changedKnowledge]) {
      expect(assessmentReviewNodeHash(changed, id)).not.toBe(hash);
    }
    original.claims = [];
    expect(assessmentReviewNodeHash(original, id)).toBeNull();
  });

  it('问题的关联主张和引用知识变化同样使凭据失效', () => {
    const value = candidate();
    value.questions = [{ id: 'question:synthetic:conditions', question: '原记录的条件是否仍适用？',
      whyItMatters: '条件会影响判断。', relatedClaimIds: [value.claims[0]!.id], evidenceIds: ['synthetic-source'] }];
    const original = assessmentReviewNodeHash(value, value.questions[0]!.id);
    value.claims[0]!.knowledgeSourceIds = ['synthetic-new-knowledge'];
    expect(assessmentReviewNodeHash(value, value.questions[0]!.id)).not.toBe(original);
    const withKnowledgeId = assessmentReviewNodeHash(value, value.questions[0]!.id);
    value.knowledgeSources.push({ id: 'synthetic-new-knowledge', title: '新增合成知识', organization: null,
      url: null, origin: 'catalog', supports: '适用条件。' });
    expect(assessmentReviewNodeHash(value, value.questions[0]!.id)).not.toBe(withKnowledgeId);
  });

  it('总览和系统节点的关联行动变化不能复用旧哈希', () => {
    const value = candidate();
    value.overview.actionIds = [value.actions[0]!.id];
    value.systems = [{ id: 'system:cardiovascular', systemId: 'cardiovascular', status: 'monitor',
      headline: '合成系统', summary: '合成说明。', claimIds: [], actionIds: [value.actions[0]!.id], limitations: [] }];
    const overview = assessmentReviewNodeHash(value, 'overview');
    const system = assessmentReviewNodeHash(value, value.systems[0]!.id);
    value.actions[0]!.firstStep = '变更后的安排。';
    expect(assessmentReviewNodeHash(value, 'overview')).not.toBe(overview);
    expect(assessmentReviewNodeHash(value, value.systems[0]!.id)).not.toBe(system);
  });

  it('当前成员、输入版本变化后，同ID同正文也不能复用通过凭据', () => {
    const original = candidate();
    const originalHash = assessmentReviewNodeHash(original, original.actions[0]!.id);
    const otherMember = { ...original, personId: 'synthetic-other-member' };
    const updatedInput = { ...original, inputSignature: 'b'.repeat(64) };
    expect(assessmentReviewNodeHash(otherMember, original.actions[0]!.id)).not.toBe(originalHash);
    expect(assessmentReviewNodeHash(updatedInput, original.actions[0]!.id)).not.toBe(originalHash);
  });
});
