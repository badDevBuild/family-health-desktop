import { describe, expect, it } from 'vitest';
import { healthClaimTitle, type ClinicalFocusedReviewV1, type MemberAssessmentCandidateV3 } from '@contracts';
import { validateAssessmentCandidate, visibleAssessmentTextFields, type AssessmentValidationInput } from './assessment-validation.js';
import { applyFocusedReview, routeFocusedReview } from './clinical-review-router.js';

function syntheticCandidate(
  diseaseName: string, claimText: string,
  diagnosticStatus: 'possible' | 'undetermined' = 'possible'
): MemberAssessmentCandidateV3 {
  return {
    schemaVersion: 3, personId: 'synthetic-person', inputSignature: 'a'.repeat(64),
    mode: 'full', requestedSystemIds: ['cardiovascular'],
    overview: { id: 'overview', headline: '合成判断', summary: claimText,
      claimIds: ['claim-synthetic'], actionIds: [], limitations: [] },
    systems: [{ id: 'system:cardiovascular', systemId: 'cardiovascular', status: 'attention',
      headline: '合成判断', summary: claimText, claimIds: ['claim-synthetic'], actionIds: [], limitations: [] }],
    claims: [{ id: 'claim-synthetic', topicKey: 'synthetic', systemIds: ['cardiovascular'],
      kind: 'diagnostic_assessment', text: claimText, diseaseName, diagnosticStatus,
      temporalStatus: 'current', evidenceIds: ['synthetic-evidence'], counterEvidenceIds: [], trendIds: [],
      knowledgeBasis: 'model_general', knowledgeSourceIds: [], criteriaBasis: null,
      rationale: '仅测试路由，不代表医学判断。', materialUncertainty: null, consequenceLevel: 'routine' }],
    actions: [], questions: [], knowledgeSources: []
  };
}

function validationInput(quote = '合成来源，仅用于测试。'): AssessmentValidationInput {
  return {
    personId: 'synthetic-person', inputSignature: 'a'.repeat(64), mode: 'full',
    requestedSystemIds: ['cardiovascular'],
    evidenceCatalog: [{ id: 'synthetic-evidence', kind: 'observation', observationId: 'synthetic-observation',
      eventId: null, documentId: 'synthetic-document', sourceSpanId: 'synthetic-span', knowledgeId: null,
      label: '合成资料', locator: null, quote }],
    trendIds: [], catalogKnowledgeIds: [], criteriaSets: []
  };
}

function syntheticAction(claimIds = ['claim-synthetic']): MemberAssessmentCandidateV3['actions'][number] {
  return {
    id: 'action-synthetic', dedupeKey: 'synthetic-action', systemIds: ['cardiovascular'], claimIds,
    kind: 'treatment_discussion', title: '与医生讨论', why: '携带合成资料。', firstStep: '下次就诊时与医生讨论现有方案。',
    timing: null, timingBasis: 'none', reviewPlan: null, caution: null, urgency: 'routine',
    evidenceIds: ['synthetic-evidence'], knowledgeSourceIds: []
  };
}

function ordinaryContentCandidate(): MemberAssessmentCandidateV3 {
  const candidate = syntheticCandidate('普通', 'LDL-C 4.2 mmol/L，高于报告参考上限3.4。');
  candidate.claims[0] = { ...candidate.claims[0]!, kind: 'source_fact', diseaseName: null, diagnosticStatus: null };
  candidate.actions = [syntheticAction()];
  candidate.overview.actionIds = ['action-synthetic'];
  candidate.systems[0]!.actionIds = ['action-synthetic'];
  candidate.questions = [{ id: 'question-synthetic', question: '采血时是否空腹？', whyItMatters: '采血条件会影响结果理解。',
    relatedClaimIds: ['claim-synthetic'], evidenceIds: ['synthetic-evidence'] }];
  return candidate;
}

const visibleFieldCases = [
  ...['headline', 'summary', 'limitations'].map((field) => ['overview', field]),
  ...['headline', 'summary', 'limitations'].map((field) => ['system', field]),
  ...['text', 'rationale', 'materialUncertainty', 'diseaseName'].map((field) => ['claim', field]),
  ...['title', 'why', 'firstStep', 'timing', 'reviewPlan', 'caution'].map((field) => ['action', field]),
  ...['question', 'whyItMatters'].map((field) => ['question', field])
];

describe('低影响日常建议的依赖修复边界', () => {
  it('只有独立依据的普通habit可暂留给P03，不直接发布失效引用', () => {
    const candidate = ordinaryContentCandidate();
    candidate.actions[0] = { ...candidate.actions[0]!, kind: 'habit', lifestyleDomain: 'diet', lifestyleBasis: 'personalized',
      title: '调整日常饮食', firstStep: '结合本人的饮食记录安排三餐。' };
    const review: ClinicalFocusedReviewV1 = { schemaVersion: 1, personId: candidate.personId, inputSignature: candidate.inputSignature,
      results: [{ targetId: 'claim-synthetic', verdict: 'hold', reason: '合成隔离', replacement: null }] };
    const deferred = applyFocusedReview(candidate, review, ['claim-synthetic'], { deferIndependentHabitRepair: true });
    expect(deferred.dependentActionIds).toEqual(['action-synthetic']);
    expect(deferred.candidate.actions[0]?.claimIds).toEqual(['claim-synthetic']);
    expect(validateAssessmentCandidate(deferred.candidate, validationInput()).issues).toContain('unknown_claim:action-synthetic:claim-synthetic');
    expect(deferred.candidate.overview.actionIds).toEqual([]);
    expect(applyFocusedReview(candidate, review, ['claim-synthetic']).candidate.actions).toEqual([]);
  });

  it.each(['no_basis', 'explicit_hold', 'dose', 'urgent', 'medical'] as const)('%s 不会借独立日常建议机制保留', (kind) => {
    const candidate = ordinaryContentCandidate();
    candidate.actions[0] = { ...candidate.actions[0]!, kind: 'habit', lifestyleDomain: 'diet', lifestyleBasis: 'personalized',
      title: '合成日常安排', firstStep: '安排日常饮食。', evidenceIds: kind === 'no_basis' ? [] : ['synthetic-evidence'],
      urgency: kind === 'urgent' ? 'urgent' : 'routine' };
    if (kind === 'dose') { candidate.actions[0]!.lifestyleDomain = 'supplements'; candidate.actions[0]!.firstStep = '每日补充维生素D 1000 IU。'; }
    if (kind === 'medical') candidate.actions[0]!.firstStep = '请开始服用阿托伐他汀。';
    const targets = kind === 'explicit_hold' ? ['claim-synthetic', 'action-synthetic'] : ['claim-synthetic'];
    const review: ClinicalFocusedReviewV1 = { schemaVersion: 1, personId: candidate.personId, inputSignature: candidate.inputSignature,
      results: targets.map((targetId) => ({ targetId, verdict: 'hold', reason: '合成隔离', replacement: null })) };
    const applied = applyFocusedReview(candidate, review, targets, { deferIndependentHabitRepair: true });
    expect(applied.dependentActionIds).toEqual([]);
    expect(applied.candidate.actions).toEqual([]);
  });
});

function setVisibleField(candidate: MemberAssessmentCandidateV3, owner: string, field: string, text: string): string {
  const node = owner === 'overview' ? candidate.overview : owner === 'system' ? candidate.systems[0]!
    : owner === 'claim' ? candidate.claims[0]! : owner === 'action' ? candidate.actions[0]! : candidate.questions[0]!;
  (node as unknown as Record<string, unknown>)[field] = field === 'limitations' ? [text] : text;
  return node.id;
}

describe('routeFocusedReview 高后果方向辅助路由', () => {
  it.each(['personalized', 'general'] as const)('数字补充剂剂量即使标%s也进入重点复核，其依赖一并保留', (basis) => {
    const candidate = ordinaryContentCandidate();
    candidate.actions[0] = { ...candidate.actions[0]!, kind: 'habit', lifestyleDomain: 'supplements', lifestyleBasis: basis,
      title: '维生素D补充', firstStep: '每日补充维生素D 1000 IU。' };
    const route = routeFocusedReview(candidate);
    expect(route.targetIds).toEqual(expect.arrayContaining(['action-synthetic', 'system:cardiovascular', 'overview']));
    expect(route.reasons).toContain('numeric_supplement_dose:action-synthetic');
    candidate.actions[0]!.firstStep = '不必自行补充维生素D 1000 IU/天。';
    expect(routeFocusedReview(candidate)).toEqual({ targetIds: ['question-synthetic'], reasons: ['question_premise:question-synthetic'] });
  });

  it.each(visibleFieldCases)('%s.%s 的重大判断不能靠普通严重程度标记绕过重点复核', (owner, field) => {
    const candidate = ordinaryContentCandidate();
    const id = setVisibleField(candidate, owner!, field!, '高度怀疑肺癌。');
    const route = routeFocusedReview(candidate);
    expect(route.targetIds).toContain(id);
    if (owner === 'claim') expect(route.targetIds).toEqual(expect.arrayContaining([
      'claim-synthetic', 'action-synthetic', 'system:cardiovascular', 'overview'
    ]));
    expect(route.targetIds).toContain('question-synthetic');
    expect(route.reasons).toContain('question_premise:question-synthetic');
  });

  it.each(visibleFieldCases)('%s.%s 的直接否定及家族史保持独立，不升级为本人高后果判断', (owner, field) => {
    const candidate = ordinaryContentCandidate();
    setVisibleField(candidate, owner!, field!, '影像已排除肺癌。父亲确诊心肌梗死，非本人诊断。');
    expect(routeFocusedReview(candidate)).toEqual({ targetIds: ['question-synthetic'], reasons: ['question_premise:question-synthetic'] });
  });

  it('逐个限制与字段检查，不能用另一个字段的否定覆盖重大声称', () => {
    const candidate = ordinaryContentCandidate();
    candidate.overview.limitations = ['影像未见肺癌。', '当前症状不能排除肺栓塞。'];
    expect(visibleAssessmentTextFields(candidate.overview).map((entry) => entry.field))
      .toEqual(['headline', 'summary', 'limitations[0]', 'limitations[1]']);
    expect(routeFocusedReview(candidate).targetIds).toContain('overview');
  });

  it.each(['rationale', 'materialUncertainty'])('undetermined 正文排除不能掩盖 %s 内的重大方向', (field) => {
    const candidate = syntheticCandidate('肺癌', '本次影像已排除肺癌。', 'undetermined');
    setVisibleField(candidate, 'claim', field, '现有表现仍可能提示肺癌。');
    expect(routeFocusedReview(candidate).targetIds).toContain('claim-synthetic');
  });

  it('来源已记载的诊断按来源复述不升级新判断，夹带其他病名或当前发作仍复核', () => {
    const candidate = ordinaryContentCandidate();
    candidate.claims[0] = { ...candidate.claims[0]!, kind: 'diagnostic_assessment', diagnosticStatus: 'documented',
      diseaseName: '心肌梗死', temporalStatus: 'historical', text: '2022年报告诊断为心肌梗死。',
      rationale: '2022年原报告明确记载心肌梗死诊断。' };
    expect(validateAssessmentCandidate(candidate, validationInput('2022年诊断：心肌梗死。')).issues).toEqual([]);
    expect(routeFocusedReview(candidate).targetIds).not.toContain('claim-synthetic');
    candidate.claims[0]!.rationale = '本次胸痛提示心肌梗死再次发作。';
    expect(routeFocusedReview(candidate).targetIds).toContain('claim-synthetic');
    candidate.claims[0]!.rationale = '当前资料不能排除肺栓塞。';
    expect(routeFocusedReview(candidate).targetIds).toContain('claim-synthetic');
  });

  it('documented 的病名子串不能替新增亚型判断取得来源豁免', () => {
    const candidate = ordinaryContentCandidate();
    candidate.claims[0] = { ...candidate.claims[0]!, kind: 'diagnostic_assessment', diagnosticStatus: 'documented',
      diseaseName: '肺癌', text: '2022年病理报告诊断为肺癌。', temporalStatus: 'historical',
      rationale: '高度怀疑小细胞肺癌。' };
    expect(routeFocusedReview(candidate).targetIds).toContain('claim-synthetic');
  });

  it.each([
    ['心肌梗死', '无胸痛，但模型考虑心肌梗死方向。'],
    ['肺癌', '家族史无癌症，本人影像结果可能提示肺癌。'],
    ['癌症', '家族史无癌症，本人影像结果可能提示肺癌。'],
    ['脑卒中', '既往心肌梗死，当前资料提示脑卒中可能。'],
    ['脑梗死', '未见出血，但模型新提出脑梗死方向。'],
    ['肺栓塞', '无胸痛，但模型新提出肺栓塞方向。'],
    ['恶性肿瘤', '现有资料不能排除恶性肿瘤。']
  ])('其他语境的否定不能压掉 %s 的新判断', (diseaseName, claimText) => {
    const route = routeFocusedReview(syntheticCandidate(diseaseName, claimText));
    expect(route.targetIds).toEqual(expect.arrayContaining([
      'claim-synthetic', 'system:cardiovascular', 'overview'
    ]));
    expect(route.reasons).toContain('high_consequence_disease:claim-synthetic');
  });

  it.each([
    ['恶性肿瘤', '本次检查已排除恶性肿瘤。'],
    ['脑卒中', '影像未见脑卒中。']
  ])('明确否定 %s 时不因病名本身启动重点复核', (diseaseName, claimText) => {
    expect(routeFocusedReview(syntheticCandidate(diseaseName, claimText, 'undetermined'))).toEqual({ targetIds: [], reasons: [] });
  });

  it('模型一边写明确排除、一边标 possible 时视为高影响矛盾并复核', () => {
    const route = routeFocusedReview(syntheticCandidate('恶性肿瘤', '本次检查已排除恶性肿瘤。'));
    expect(route.reasons).toContain('high_consequence_disease:claim-synthetic');
  });

  it('T08：高后果判断错标 interpretation 仍局部修复并进入重点复核', () => {
    const candidate = syntheticCandidate('恶性肿瘤', '高度怀疑恶性肿瘤。');
    candidate.claims[0] = { ...candidate.claims[0]!, kind: 'interpretation', diseaseName: null, diagnosticStatus: null };
    expect(validateAssessmentCandidate(candidate, validationInput()).issues).toContain('high_impact_claim_untyped:claim-synthetic');
    expect(routeFocusedReview(candidate).targetIds).toContain('claim-synthetic');
  });

  it.each(['不能排除肺癌', '肺癌待排', '不排除肺癌'])('未定型的“%s”不能绕过高后果校验和复核', (text) => {
    const candidate = syntheticCandidate('普通', '合成常规记录。');
    candidate.claims[0] = { ...candidate.claims[0]!, kind: 'interpretation', text,
      diseaseName: null, diagnosticStatus: null };
    candidate.overview.summary = text;
    candidate.overview.claimIds = [];
    const issues = validateAssessmentCandidate(candidate, validationInput()).issues;
    expect(issues).toEqual(expect.arrayContaining([
      'high_impact_claim_untyped:claim-synthetic', 'unsupported_high_impact_text:overview'
    ]));
    expect(routeFocusedReview(candidate).targetIds).toEqual(expect.arrayContaining(['claim-synthetic', 'overview']));
  });

  it('明确排除肺癌仍不会误触发高后果断言', () => {
    const candidate = syntheticCandidate('普通', '合成常规记录。');
    candidate.claims[0] = { ...candidate.claims[0]!, kind: 'source_fact', text: '本次检查已排除肺癌。',
      diseaseName: null, diagnosticStatus: null };
    candidate.overview.summary = '本次检查已排除肺癌。';
    expect(validateAssessmentCandidate(candidate, validationInput()).issues).toEqual([]);
    expect(routeFocusedReview(candidate).targetIds).toEqual([]);
  });

  it('T09：治疗讨论中直接开始服药不能靠 kind 逃过校验和路由', () => {
    const candidate = syntheticCandidate('普通', '合成常规记录。');
    candidate.actions = [{ ...syntheticAction(), firstStep: '建议你立即开始服用某处方药。' }];
    candidate.overview.actionIds = ['action-synthetic'];
    candidate.systems[0]!.actionIds = ['action-synthetic'];
    expect(validateAssessmentCandidate(candidate, validationInput()).issues).toContain('direct_medication_change:action-synthetic');
    expect(routeFocusedReview(candidate).targetIds).toContain('action-synthetic');
    candidate.actions[0]!.firstStep = '下次就诊时与医生讨论现有方案是否仍合适。';
    expect(routeFocusedReview(candidate).targetIds).not.toContain('action-synthetic');
  });

  it('T10–T12：普通疾病、医生讨论与检验单位不额外复核，直接服药指令不因 kind 改变而放过', () => {
    const candidate = syntheticCandidate('脂肪肝', '报告提示可能为脂肪肝，需结合医生评估。');
    candidate.claims[0]!.text = '示例检验结果为 95 mg/dL，另一项为 2 IU/L。';
    candidate.actions = [syntheticAction()];
    expect(validateAssessmentCandidate(candidate, validationInput()).issues).toEqual([]);
    expect(routeFocusedReview(candidate).targetIds).toEqual([]);
    candidate.actions[0] = { ...candidate.actions[0]!, kind: 'habit', firstStep: '建议你立即开始服用某处方药。' };
    expect(validateAssessmentCandidate(candidate, validationInput()).issues).toContain('direct_medication_change:action-synthetic');
  });

  it('T14：总览或系统中无对应主张的高后果断言不能漏过', () => {
    const candidate = syntheticCandidate('普通', '合成常规记录。');
    candidate.claims[0] = { ...candidate.claims[0]!, kind: 'source_fact', diseaseName: null, diagnosticStatus: null };
    candidate.overview.summary = '已经确诊恶性肿瘤。';
    candidate.systems[0]!.headline = '高度怀疑肺癌。';
    const issues = validateAssessmentCandidate(candidate, validationInput()).issues;
    expect(issues).toEqual(expect.arrayContaining([
      'unsupported_high_impact_text:overview', 'unsupported_high_impact_text:system:cardiovascular'
    ]));
    expect(routeFocusedReview(candidate).targetIds).toEqual(expect.arrayContaining(['overview', 'system:cardiovascular']));
  });
});

describe('routeFocusedReview 通用问句前提复核', () => {
  it('普通未知、操作前提和条件式问题都共用一次路由，不穷举医学术语', () => {
    const candidate = ordinaryContentCandidate();
    candidate.questions.push(
      { id: 'question-procedure', question: '接受该部位处理后，是否仍有不适？', whyItMatters: '当前感受会影响活动安排。',
        relatedClaimIds: ['claim-synthetic'], evidenceIds: [] },
      { id: 'question-conditional', question: '若已经完成原计划，目前是否仍有不适？', whyItMatters: '需要区分原计划与实际执行。',
        relatedClaimIds: [], evidenceIds: ['synthetic-evidence'] }
    );
    const before = JSON.stringify(candidate);
    const route = routeFocusedReview(candidate);
    expect(route).toEqual({ targetIds: ['question-synthetic', 'question-procedure', 'question-conditional'], reasons: [
      'question_premise:question-synthetic', 'question_premise:question-procedure', 'question_premise:question-conditional'
    ] });
    expect(new Set(route.targetIds).size).toBe(3);
    expect(route.targetIds).not.toEqual(expect.arrayContaining(['claim-synthetic', 'action-synthetic', 'system:cardiovascular', 'overview']));
    expect(JSON.stringify(candidate)).toBe(before);
  });

  it('普通问题前提复核不取消原有高影响原因及依赖范围', () => {
    const candidate = ordinaryContentCandidate();
    candidate.questions[0]!.whyItMatters = '高度怀疑肺癌。';
    const route = routeFocusedReview(candidate);
    expect(route.reasons).toEqual(['question_premise:question-synthetic', 'high_impact_question:question-synthetic']);
    expect(route.targetIds).toEqual(['question-synthetic', 'system:cardiovascular', 'overview']);
    expect(route.targetIds.filter((id) => id === 'question-synthetic')).toHaveLength(1);
    expect(route.targetIds).not.toContain('claim-synthetic');
  });

  it('没有问题时不为前提复核创建额外目标', () => {
    const candidate = ordinaryContentCandidate();
    candidate.questions = [];
    expect(routeFocusedReview(candidate)).toEqual({ targetIds: [], reasons: [] });
  });

  it('问句同 ID 修正保留限定和来源，不改只读关联主张', () => {
    const candidate = ordinaryContentCandidate();
    const originalQuestion = candidate.questions[0]!;
    const sourceQuestion = { ...originalQuestion, question: '原资料记载局部镜下处理；该次处理后是否仍有不适？',
      whyItMatters: '需要了解该次局部处理后的感受，不预设更大范围操作。' };
    const before = JSON.stringify(candidate);
    const reviewed: ClinicalFocusedReviewV1 = { schemaVersion: 1, personId: candidate.personId, inputSignature: candidate.inputSignature,
      results: [{ targetId: originalQuestion.id, verdict: 'replace', reason: '恢复来源中的操作方式和范围。',
        replacement: { nodeType: 'question', value: sourceQuestion } }] };
    const applied = applyFocusedReview(candidate, reviewed, [originalQuestion.id]);
    expect(applied.candidate.questions).toEqual([sourceQuestion]);
    expect(applied.candidate.claims).toEqual(candidate.claims);
    expect(applied.candidate.actions).toEqual(candidate.actions);
    expect(applied.candidate.overview).toEqual(candidate.overview);
    expect(applied.heldTargetIds).toEqual([]);
    expect(JSON.stringify(candidate)).toBe(before);
  });

  it('无依据的问句前提可单独隔离，不能借替换变更目标 ID 或类型', () => {
    const candidate = ordinaryContentCandidate();
    const question = candidate.questions[0]!;
    const reviewed: ClinicalFocusedReviewV1 = { schemaVersion: 1, personId: candidate.personId, inputSignature: candidate.inputSignature,
      results: [{ targetId: question.id, verdict: 'hold', reason: '来源没有证明问题所预设的事件。', replacement: null }] };
    const applied = applyFocusedReview(candidate, reviewed, [question.id]);
    expect(applied.candidate.questions).toEqual([]);
    expect(applied.heldTargetIds).toEqual([question.id]);
    expect(applied.candidate.claims).toEqual(candidate.claims);
    expect(applied.candidate.actions).toEqual(candidate.actions);
    reviewed.results[0] = { targetId: question.id, verdict: 'replace', reason: '合成越界测试。',
      replacement: { nodeType: 'question', value: { ...question, id: 'question-new' } } };
    expect(() => applyFocusedReview(candidate, reviewed, [question.id])).toThrow('FOCUSED_REVIEW_REPLACEMENT_SCOPE_MISMATCH');
    reviewed.results[0]!.replacement = { nodeType: 'claim', value: { ...candidate.claims[0]!, id: question.id } };
    expect(() => applyFocusedReview(candidate, reviewed, [question.id])).toThrow('FOCUSED_REVIEW_REPLACEMENT_SCOPE_MISMATCH');
  });
});

describe('applyFocusedReview 替换后的依赖闭包', () => {
  it('生活行动替换省略可选元信息时沿用原值，显式改为一般不会绕过个人引用门禁', () => {
    const candidate = ordinaryContentCandidate();
    const action = { ...candidate.actions[0]!, kind: 'habit' as const, lifestyleDomain: 'activity' as const,
      lifestyleBasis: 'personalized' as const, title: '调整活动起点', firstStep: '可先从散步十分钟开始。' };
    candidate.actions = [action];
    const { lifestyleDomain: _domain, lifestyleBasis: _basis, ...oldShapeReplacement } = action;
    const focused: ClinicalFocusedReviewV1 = { schemaVersion: 1, personId: candidate.personId, inputSignature: candidate.inputSignature,
      results: [{ targetId: action.id, verdict: 'replace', reason: '调整活动表达。', replacement: {
        nodeType: 'action', value: { ...oldShapeReplacement, firstStep: '可每周三次散步，每次十分钟。' }
      } }] };
    const retained = applyFocusedReview(candidate, focused, [action.id]).candidate;
    expect(retained.actions[0]).toMatchObject({ lifestyleDomain: 'activity', lifestyleBasis: 'personalized' });
    expect(validateAssessmentCandidate(retained, validationInput()).issues).toEqual([]);
    focused.results[0]!.replacement = { nodeType: 'action', value: { ...action, lifestyleBasis: 'general' } };
    const disguised = applyFocusedReview(candidate, focused, [action.id]).candidate;
    expect(validateAssessmentCandidate(disguised, validationInput()).issues)
      .toContain('general_lifestyle_not_low_risk:action-synthetic');
  });

  function dependentCandidate(originalActionClaimId = 'claim-synthetic') {
    const candidate = syntheticCandidate('普通', '合成常规记录。');
    candidate.claims.push({ ...candidate.claims[0]!, id: 'claim-other', topicKey: 'other', text: '另一条独立来源事实。' });
    candidate.actions = [syntheticAction([originalActionClaimId])];
    candidate.overview.claimIds.push('claim-other');
    candidate.overview.actionIds = ['action-synthetic'];
    candidate.systems[0]!.claimIds.push('claim-other');
    candidate.systems[0]!.actionIds = ['action-synthetic'];
    return candidate;
  }
  function review(candidate: MemberAssessmentCandidateV3, actionVerdict: 'pass' | 'replace' | 'hold', replacementClaimId?: string): ClinicalFocusedReviewV1 {
    return { schemaVersion: 1, personId: candidate.personId, inputSignature: candidate.inputSignature,
      results: [
        { targetId: 'claim-synthetic', verdict: 'hold', reason: '合成测试隔离主张', replacement: null },
        actionVerdict === 'replace'
          ? { targetId: 'action-synthetic', verdict: 'replace', reason: '按来源修正依赖', replacement: {
            nodeType: 'action', value: { ...candidate.actions[0]!, claimIds: [replacementClaimId!] }
          } }
          : { targetId: 'action-synthetic', verdict: actionVerdict, reason: '合成测试', replacement: null }
      ] };
  }

  it('T15：hold 主张后隔离当前依赖行动并收敛标题', () => {
    const candidate = dependentCandidate();
    const result = applyFocusedReview(candidate, review(candidate, 'pass'), ['claim-synthetic', 'action-synthetic']);
    expect(result.candidate.claims.map((claim) => claim.id)).toEqual(['claim-other']);
    expect(result.candidate.actions).toEqual([]);
    expect(result.candidate.overview.headline).toMatch(/^整体情况：/u);
    expect(result.candidate.overview.headline).toBe('整体情况：1项重点，涉及1个身体系统');
    expect(result.candidate.overview.summary).toContain(healthClaimTitle(candidate.claims[1]!));
    expect(result.candidate.overview.summary).toContain('另一条独立来源事实。');
    expect(result.candidate.systems[0]!.summary).toContain('另一条独立来源事实。');
    expect(result.candidate.systems[0]!.status).toBe('insufficient');
    expect(result.rebuiltNodeIds).toEqual(expect.arrayContaining(['overview', 'system:cardiovascular']));
    expect(JSON.stringify([result.candidate.overview, ...result.candidate.systems])).not.toMatch(/仍需核实|已接纳|未发布|未纳入/);
  });

  it('T16：行动改绑到有效主张后保留，不沿用旧依赖图', () => {
    const candidate = dependentCandidate();
    const result = applyFocusedReview(candidate, review(candidate, 'replace', 'claim-other'), ['claim-synthetic', 'action-synthetic']);
    expect(result.candidate.actions.map((action) => action.claimIds)).toEqual([['claim-other']]);
    expect(result.heldTargetIds).not.toContain('action-synthetic');
  });

  it('发布时局部隔离后的摘要保留同源解释和节点条件，重新关联的安全行动单独保留', () => {
    const candidate = dependentCandidate();
    candidate.claims[1] = { ...candidate.claims[1]!, kind: 'source_fact', diseaseName: null,
      diagnosticStatus: null, text: '2025年检查甲高于当次参考范围。', temporalStatus: 'historical',
      rationale: '以该次报告数值和参考范围为依据。' };
    candidate.claims.push({ ...candidate.claims[1]!, id: 'claim-meaning', topicKey: 'meaning', kind: 'interpretation',
      text: '检查甲是身体的一个信号，单次偏高不能确定原因。', materialUncertainty: '还需要结合当时的用药情况。' });
    candidate.overview.claimIds.push('claim-meaning');
    candidate.systems[0]!.claimIds.push('claim-meaning');
    candidate.overview.limitations = ['旧结果不能说明现在的情况。'];
    candidate.systems[0]!.limitations = ['旧结果不能说明现在的情况。'];
    candidate.actions[0] = { ...candidate.actions[0]!, firstStep: '先查看此后的检查结果。',
      timing: '下次就诊讨论时', caution: '不要自行调整药物。' };
    const original = JSON.stringify(candidate);
    const result = applyFocusedReview(candidate, review(candidate, 'replace', 'claim-other'), ['claim-synthetic', 'action-synthetic']);
    expect(result.candidate.overview.headline).toMatch(/^整体情况：/u);
    expect(result.candidate.overview.headline).toBe('整体情况：1项重点，涉及1个身体系统');
    expect(result.candidate.overview.summary).toContain(healthClaimTitle(candidate.claims[1]));
    expect(result.candidate.overview.summary).toContain(candidate.claims[1].text);
    expect(result.candidate.overview.summary).toContain('旧结果不能说明现在');
    expect(result.candidate.overview.summary).not.toContain('先查看此后的检查结果');
    for (const node of [result.candidate.systems[0]!]) {
      expect(node.headline).toBe(healthClaimTitle(candidate.claims[1]));
      expect(node.summary).toContain(candidate.claims[1].text);
      expect(node.summary).toContain(candidate.claims[2]!.text);
      expect(node.summary).toContain('当时的用药情况');
      expect(node.summary).toContain('旧结果不能说明现在');
      expect(node.summary).not.toContain('先查看此后的检查结果');
    }
    expect(result.candidate.actions[0]!.firstStep).toBe('先查看此后的检查结果。');
    expect(result.candidate.actions[0]!.caution).toBe('不要自行调整药物。');
    expect(result.candidate.systems[0]!.actionIds).toContain('action-synthetic');
    expect(result.candidate.systems[0]!.status).toBe('insufficient');
    expect(result.heldTargetIds).toContain('claim-synthetic');
    expect(JSON.stringify(candidate)).toBe(original);
  });

  it('T17：行动新绑到已 hold 主张后隔离，不留下悬空引用', () => {
    const candidate = dependentCandidate('claim-other');
    const result = applyFocusedReview(candidate, review(candidate, 'replace', 'claim-synthetic'), ['claim-synthetic', 'action-synthetic']);
    expect(result.candidate.actions).toEqual([]);
    expect(result.candidate.overview.actionIds).toEqual([]);
    expect(result.heldTargetIds).toContain('action-synthetic');
  });

  it('T18：复核不得插入请求范围以外的目标', () => {
    const candidate = dependentCandidate();
    expect(() => applyFocusedReview(candidate, {
      schemaVersion: 1, personId: candidate.personId, inputSignature: candidate.inputSignature,
      results: [{ targetId: 'not-requested', verdict: 'hold', reason: '合成测试', replacement: null }]
    }, ['claim-synthetic'])).toThrow('FOCUSED_REVIEW_COVERAGE_MISMATCH');
  });

  it('局部隔离后整体概况覆盖其他有效主张，并保留完整临床条件', () => {
    const candidate = dependentCandidate();
    candidate.claims[1] = { ...candidate.claims[1]!,
      text: '报告中的检查甲有变化，但不能单凭这一项确定原因。',
      rationale: '两次检查记录的数值不同。',
      materialUncertainty: '当前用药及症状信息未提供；检测条件不一致，不能直接比较。' };
    candidate.claims.push({ ...candidate.claims[1]!, id: 'claim-third', topicKey: 'third', text: '另一项检查的结果仍可独立解释。' });
    candidate.overview.claimIds.push('claim-third');
    candidate.systems[0]!.claimIds.push('claim-third');
    candidate.systems[0]!.limitations = ['当前用药信息未提供。', '部分判断因证据不足暂未发布。'];
    const original = JSON.stringify(candidate);
    const result = applyFocusedReview(candidate, review(candidate, 'pass'), ['claim-synthetic', 'action-synthetic']);
    expect(result.candidate.overview.headline).toMatch(/^整体情况：/u);
    expect(result.candidate.overview.headline).toBe('整体情况：1项重点，涉及1个身体系统');
    expect(result.candidate.overview.summary).toContain(healthClaimTitle(candidate.claims[1]!));
    expect(result.candidate.overview.summary).toContain(candidate.claims[1]!.text);
    expect(result.candidate.overview.summary).toContain(candidate.claims[1]!.materialUncertainty);
    expect(result.candidate.systems[0]!.summary).toContain(candidate.claims[1]!.text);
    expect(result.candidate.systems[0]!.summary).toContain(candidate.claims[1]!.materialUncertainty);
    expect(result.candidate.overview.claimIds).toEqual(['claim-other', 'claim-third']);
    expect(result.candidate.claims.map((claim) => claim.text)).toContain(candidate.claims[2]!.text);
    expect(result.candidate.systems[0]!.limitations).toEqual(['当前用药信息未提供。']);
    expect(JSON.stringify(candidate)).toBe(original);
  });

  it('只 hold 总览或系统时从保留主张重建，隔离标记与仍存在的节点 ID 分开', () => {
    const candidate = dependentCandidate();
    const results: ClinicalFocusedReviewV1['results'] = ['overview', 'system:cardiovascular'].map((targetId) => ({
      targetId, verdict: 'hold', reason: '原摘要不完全由所引用主张支持。', replacement: null
    }));
    const result = applyFocusedReview(candidate, { schemaVersion: 1, personId: candidate.personId,
      inputSignature: candidate.inputSignature, results }, results.map((item) => item.targetId));
    expect(result.heldTargetIds).toEqual([]);
    expect(result.rebuiltNodeIds).toEqual(expect.arrayContaining(['overview', 'system:cardiovascular']));
    expect(result.candidate.claims).toEqual(candidate.claims);
    expect(result.candidate.overview.headline).toMatch(/^整体情况：/u);
    expect(result.candidate.overview.headline).toBe('整体情况：1项重点，涉及1个身体系统');
    expect(result.candidate.overview.summary).toContain(healthClaimTitle(candidate.claims[0]!));
    expect(result.candidate.overview.summary).toContain(candidate.claims[0]!.text);
    expect(result.candidate.systems[0]!.summary).toContain(candidate.claims[0]!.text);
    expect(result.candidate.systems[0]!.status).toBe('insufficient');
  });

  it('主张被隔离仍保留有独立个人依据的检查条件问题，去掉失效引用', () => {
    const candidate = dependentCandidate();
    candidate.questions = [{ id: 'question-fasting', question: '这次抽血前是否空腹、当时是否仍在服药？',
      whyItMatters: '空腹和用药条件会影响对检查结果的理解。', relatedClaimIds: ['claim-synthetic'],
      evidenceIds: ['synthetic-evidence'] }];
    const result = applyFocusedReview(candidate, review(candidate, 'pass'), ['claim-synthetic', 'action-synthetic']);
    expect(result.candidate.questions).toEqual([{ ...candidate.questions[0]!, relatedClaimIds: [] }]);
    expect(validateAssessmentCandidate(result.candidate, validationInput()).issues).toEqual([]);
  });

  it('明确 hold 的问题和只依赖被隔离风险的提问不作为有效下一步', () => {
    const candidate = dependentCandidate();
    candidate.questions = [{ id: 'question-dependent', question: '是否需要立即处理这个高风险？',
      whyItMatters: '这一判断会影响行动。', relatedClaimIds: ['claim-synthetic'], evidenceIds: ['synthetic-evidence'] },
    { id: 'question-held', question: '这次抽血是否空腹？', whyItMatters: '检查条件会影响结果。',
      relatedClaimIds: ['claim-other'], evidenceIds: ['synthetic-evidence'] }];
    const reviewed = review(candidate, 'pass');
    reviewed.results.push({ targetId: 'question-held', verdict: 'hold', reason: '该问题自身没有可靠依据。', replacement: null });
    const result = applyFocusedReview(candidate, reviewed, ['claim-synthetic', 'action-synthetic', 'question-held']);
    expect(result.candidate.questions).toEqual([]);
    expect(result.heldTargetIds).toContain('question-held');
  });
});
