import { describe, expect, it } from 'vitest';
import { DOCUMENTED_PLAN_NEUTRAL_TITLE, healthActionSchema, type HealthAction, type MemberAssessmentCandidateV3, type MemberEvidenceRef } from '@contracts';
import { extractHighConsequenceAssertions, highConsequenceAssertionMentions, hasDirectMedicationChange, hasNumericSupplementDose,
  isReviewablePersonalizedHabit, validateAssessmentCandidate,
  type AssessmentValidationInput } from './assessment-validation.js';
import { routeFocusedReview } from './clinical-review-router.js';

function fixture(): MemberAssessmentCandidateV3 {
  return {
    schemaVersion: 3, personId: 'synthetic-person', inputSignature: 'a'.repeat(64), mode: 'full',
    requestedSystemIds: [], overview: { id: 'overview', headline: '目前没有相关检查资料',
      summary: '没有资料不能说明身体正常；如有既往报告，可整理后与医生讨论。',
      claimIds: [], actionIds: [], limitations: [] }, systems: [], claims: [], actions: [], questions: [], knowledgeSources: []
  };
}

const input = { personId: 'synthetic-person', inputSignature: 'a'.repeat(64), mode: 'full' as const,
  requestedSystemIds: [], evidenceCatalog: [], trendIds: [], catalogKnowledgeIds: [], criteriaSets: [] };

function withReportedPlan(overrides: Partial<HealthAction> = {}): MemberAssessmentCandidateV3 {
  const value = fixture();
  value.overview.actionIds = ['action:report-plan'];
  value.actions = [{
    id: 'action:report-plan', dedupeKey: 'report-plan', systemIds: [], claimIds: [], kind: 'documented_plan',
    title: '按原报告复查甲状腺功能', why: '报告中有复查安排。', firstStep: '按原安排复查甲状腺功能。',
    timing: '三个月后', timingBasis: 'documented', reviewPlan: null, caution: null, urgency: 'routine',
    evidenceIds: ['plan-source'], knowledgeSourceIds: [], ...overrides
  }];
  return value;
}

function reportSource(quote: string): MemberEvidenceRef {
  return { id: 'plan-source', kind: 'source_span', observationId: null, eventId: 'event-1', documentId: 'report-1',
    sourceSpanId: 'span-1', knowledgeId: null, label: '医嘱报告.pdf', locator: '第2页', quote };
}

function visibleContentCandidate(): MemberAssessmentCandidateV3 {
  const value = withReportedPlan({ kind: 'test_followup', timingBasis: 'none', title: '整理报告',
    firstStep: '下次就诊带上报告。', timing: null, why: '了解已有检查结果。', claimIds: ['claim:result'] });
  value.requestedSystemIds = ['cardiovascular'];
  value.overview = { ...value.overview, headline: '已有检查记录', summary: '结果需结合本人情况理解。', claimIds: ['claim:result'] };
  value.systems = [{ id: 'system:cardiovascular', systemId: 'cardiovascular', status: 'monitor',
    headline: '已有血脂记录', summary: '目前只有一次结果。', claimIds: ['claim:result'], actionIds: [], limitations: [] }];
  value.claims = [{ id: 'claim:result', topicKey: 'ldl', systemIds: ['cardiovascular'], kind: 'source_fact',
    text: 'LDL-C 4.2 mmol/L，高于参考上限3.4。', diseaseName: null, diagnosticStatus: null,
    temporalStatus: 'current', evidenceIds: ['plan-source'], counterEvidenceIds: [], trendIds: [],
    knowledgeBasis: 'not_applicable', knowledgeSourceIds: [], criteriaBasis: null,
    rationale: '报告提供了结果和参考范围。', materialUncertainty: null, consequenceLevel: 'routine' }];
  value.questions = [{ id: 'question:conditions', question: '采血时是否空腹？', whyItMatters: '采血条件影响结果理解。',
    relatedClaimIds: ['claim:result'], evidenceIds: ['plan-source'] }];
  return value;
}

const visibleFieldCases = [
  ...['headline', 'summary', 'limitations'].map((field) => ['overview', field]),
  ...['headline', 'summary', 'limitations'].map((field) => ['system', field]),
  ...['title', 'text', 'rationale', 'materialUncertainty', 'diseaseName'].map((field) => ['claim', field]),
  ...['title', 'why', 'firstStep', 'timing', 'reviewPlan', 'caution'].map((field) => ['action', field]),
  ...['question', 'whyItMatters'].map((field) => ['question', field])
];

function setVisibleField(value: MemberAssessmentCandidateV3, owner: string, field: string, text: string): string {
  const node = owner === 'overview' ? value.overview : owner === 'system' ? value.systems[0]!
    : owner === 'claim' ? value.claims[0]! : owner === 'action' ? value.actions[0]! : value.questions[0]!;
  (node as unknown as Record<string, unknown>)[field] = field === 'limitations' ? [text] : text;
  return node.id;
}

function contentInput(quote = 'LDL-C 4.2 mmol/L，参考上限3.4。'): AssessmentValidationInput {
  return { ...input, requestedSystemIds: ['cardiovascular'], evidenceCatalog: [reportSource(quote)] };
}

function typedDirectionsCandidate(text = '目前不能排除急性冠脉综合征，包括心肌梗死的可能。'): MemberAssessmentCandidateV3 {
  const value = visibleContentCandidate();
  value.claims[0] = { ...value.claims[0]!, kind: 'diagnostic_assessment', diagnosticStatus: 'possible',
    diseaseName: '急性冠脉综合征', text, rationale: '还需要结合其他检查判断。' };
  value.overview.summary = '目前需考虑心肌梗死的可能，不能仅凭现有资料确定。';
  value.systems[0]!.summary = value.overview.summary;
  return value;
}

function generalHabit(overrides: Partial<HealthAction> = {}): HealthAction {
  return { id: 'action:daily-life', dedupeKey: 'daily-life', systemIds: [], claimIds: [], kind: 'habit',
    lifestyleDomain: 'diet', lifestyleBasis: 'general', title: '从三餐搭配开始',
    why: '日常饮食有规律，方便逐步调整搭配。', firstStep: '本周每顿加一种蔬菜，主食搭配蛋或豆制品。',
    timing: '先试一周', timingBasis: 'practical_trial', reviewPlan: '一周后看是否方便坚持。',
    caution: '若已有医生要求的饮食限制，遵循原安排。', urgency: 'routine', evidenceIds: [], knowledgeSourceIds: [],
    ...overrides };
}

function habitCandidate(action = generalHabit()): MemberAssessmentCandidateV3 {
  const value = fixture();
  value.actions = [action];
  value.overview.actionIds = [action.id];
  return value;
}

describe('个性化习惯补救的原安全条件与追加限制', () => {
  const originalCaution = '如出现持续咳嗽应就医。';
  function personalizedHabit(overrides: Partial<HealthAction> = {}): HealthAction {
    return generalHabit({ lifestyleBasis: 'personalized', caution: originalCaution, ...overrides });
  }

  it('完整保留原安全句并追加独立非医疗限制，不当成新增医疗安排', () => {
    for (const caution of [originalCaution, `${originalCaution}旧记录的时间不从今天重新起算。`,
      `${originalCaution}\n旧记录的时间不从今天重新起算。资料未确认当前状态。`]) {
      expect(isReviewablePersonalizedHabit(personalizedHabit({ caution }), originalCaution), caution).toBe(true);
    }
  });

  it.each([
    '如出现持续咳嗽可以就医。旧记录的时间不从今天重新起算。',
    '出现持续咳嗽应就医。旧记录的时间不从今天重新起算。',
    '旧记录的时间不从今天重新起算。如出现持续咳嗽应就医。',
    `${originalCaution}明天预约门诊。`,
    `${originalCaution}未确认时间，明天复查。`,
    `${originalCaution}原条件不再适用。`,
    `${originalCaution}无需遵守原限制。`,
    `${originalCaution}但原限制不重要。`,
    `${originalCaution}开始新的行动。`
  ])('新增医疗方向不能借原安全提醒改写条件或追加新安排：%s', (caution) => {
    expect(isReviewablePersonalizedHabit(personalizedHabit({ caution }), originalCaution)).toBe(false);
  });

  it('其他字段不能借用原安全句豁免新增医疗安排', () => {
    expect(isReviewablePersonalizedHabit(personalizedHabit({ caution: '旧记录的时间不从今天重新起算。',
      reviewPlan: originalCaution }), originalCaution)).toBe(false);
  });

  it('无句界不能把追加内容接成原条件的一部分', () => {
    const original = '如出现持续咳嗽应就医';
    expect(isReviewablePersonalizedHabit(personalizedHabit({ caution: `${original}旧记录的时间不从今天重新起算。` }), original))
      .toBe(false);
    expect(isReviewablePersonalizedHabit(personalizedHabit({ caution: `${original}。旧记录的时间不从今天重新起算。` }), original))
      .toBe(true);
  });

  it('新增字段仍检查改药、高后果、剂量和补充剂，不借保留原安全句豁免', () => {
    for (const suffix of ['请开始服用阿托伐他汀。', '不必担心，你已确诊肺癌。', '每日补充维生素D 1000 IU。']) {
      expect(isReviewablePersonalizedHabit(personalizedHabit({ caution: `${originalCaution}${suffix}` }), originalCaution), suffix)
        .toBe(false);
    }
  });

  it('非医疗说明仍走原检查和完整P04，不因原caution非空就强制逐字前缀', () => {
    const original = '若已有医生要求的饮食限制，遵循原安排。';
    expect(isReviewablePersonalizedHabit(personalizedHabit({ caution: '若医生已有餐食要求，遵循已有安排；资料未确认当前日常习惯。' }), original))
      .toBe(true);
    expect(isReviewablePersonalizedHabit(personalizedHabit({ caution: '如出现胸痛，请停止活动并就医。' }), null)).toBe(true);
  });

  it('既有非医疗检查未命中的安全句可原样分段保留并插入独立未知说明，仍需完整P04', () => {
    const original = '避免超出耐受的活动；旧记录的限制不从今天重启。出现异常应停止；新发严重症状应急诊。';
    const caution = '避免超出耐受的活动；旧记录的限制不从今天重启。资料未确认目前恢复情况。出现异常应停止；新发严重症状应急诊。';
    expect(isReviewablePersonalizedHabit(personalizedHabit({ caution }), original)).toBe(true);
  });

  it('本门禁不替代后续边界对原否定限制的保护', () => {
    // 纯非医疗候选沿用旧资格路径；完整 P04 和其边界不能因为此处返回 true 被跳过。
    expect(isReviewablePersonalizedHabit(personalizedHabit({ caution: '先记录当前习惯。' }), '不要自行改变原限制。')).toBe(true);
  });
});

describe('药物改变指令的局部否定作用域', () => {
  it.each([
    '不表示今天应开始、续用或停用。',
    '原报告的历史安排不意味着现在应开始服用。',
    '不能理解为现在应立即停药。',
    '不应视为现在应自行调整剂量。',
    '不要自行停用或换药。',
    '请不要立即停用。',
    '不表示在未核实新处方时应停药。',
    '不能理解为在未确认现处方时应停药。',
    '不表示在无症状时应停药。',
    '不表示在不适时应停药。',
    '不要在未咨询医生时自行停药。',
    '请整理目前实际用药，以及是否漏服或自行停药，带给医生核对。',
    '核对是否曾自行减量或自行停药。',
    '核对是否曾自行减量并且自行停药。',
    '核对是否曾自行减量同时自行停药。',
    '请询问是否曾停药或自行换药。',
    '不要自行停用或自行换药。',
    '暂不自行加量或新增补充剂。',
    '暂时不自行调整剂量。',
    '先不自行改用其他药物。',
    '仍不自行停药。',
    '过去是否曾经自行停药？'
  ])('免责声明、禁止和历史问题不反转成执行指令：%s', (text) => {
    expect(hasDirectMedicationChange(generalHabit({ firstStep: text }))).toBe(false);
  });

  it.each([
    '并非不表示今天应开始、续用或停用。',
    '不是不应立即停药。',
    '不表示不应立即停药。',
    '不要不应立即停药。',
    '不得不立即停药。',
    '不要不遵医嘱立即停药。',
    '不要只记录药名请立即停药。',
    '不表示今天应开始、续用或停用，但请立即停用。',
    '不要自行停用，不过现在应换药。',
    '不要自行停用；立即停药。',
    '不要自行停用,请开始服用。',
    '不要自行停用、立即换药。',
    '不要自行停用或应立即换药。',
    '不要自行停用并立即换药。',
    '不要自行停用同时应立即换药。',
    '不要自行停用立即换药。',
    '过去是否曾经自行停药？现在应开始服用。',
    '过去曾经停药现在应换药。',
    '是否曾停药，或请现在停药。',
    '是否曾停药，或自行停药即可。',
    '是否曾停药或自行停药即可。',
    '是否曾停药和必须加量。',
    '核对是否曾自行减量并且请现在停药。',
    '核对是否曾自行减量同时请现在停药。',
    '核对是否曾自行减量并且自行停药即可。',
    '核对是否曾自行减量同时自行停药即可。',
    '不表示今天应停用，但停药即可。',
    '不是暂不自行加量。',
    '不表示暂不自行调整剂量。',
    '暂不自行加量，但现在应停药。',
    '暂不自行加量；请立即换药。'
  ])('双重否定和后续独立肯定指令仍触发门禁：%s', (text) => {
    expect(hasDirectMedicationChange(generalHabit({ firstStep: text }))).toBe(true);
  });

  it.each(['title', 'why', 'firstStep', 'timing', 'reviewPlan', 'caution'] as const)(
    '%s 中仅否定当前动作，不能凭该字段免责声明豁免其他动作', (field) => {
      expect(hasDirectMedicationChange(generalHabit({ [field]: '不表示今天应开始、续用或停用。' }))).toBe(false);
      expect(hasDirectMedicationChange(generalHabit({ [field]: '不表示今天应开始、续用或停用。现在应停药。' }))).toBe(true);
      expect(hasDirectMedicationChange(generalHabit({ [field]: '不表示今天应开始、续用或停用。',
        firstStep: '请立即换药。' }))).toBe(true);
    }
  );

  it('原报告安排仍验证来源，免责声明只解除直接执行指令的字面误判', () => {
    const value = withReportedPlan({ caution: '这条历史安排不表示今天应开始、续用或停用。' });
    const catalog = { ...input, evidenceCatalog: [reportSource('建议3个月后复查甲状腺功能。')] };
    expect(validateAssessmentCandidate(value, catalog).issues).toEqual([]);
    expect(validateAssessmentCandidate(value, { ...catalog, evidenceCatalog: [reportSource('未见异常。')] }).issues)
      .toEqual(['documented_plan_source_not_proven:action:report-plan']);
    expect(validateAssessmentCandidate({ ...value, actions: [{ ...value.actions[0]!, caution: '现在应停药。' }] }, catalog)
      .issues).toContain('direct_medication_change:action:report-plan');
  });
});

describe('日常生活建议的依据边界', () => {
  it.each([
    ['diet', '本周每顿加一种蔬菜，主食搭配蛋或豆制品。'],
    ['activity', '可先每周三次散步，每次十分钟，以能轻松说话的速度开始。'],
    ['sleep', '可先连续一周固定起床时间，睡前半小时放下屏幕。'],
    ['supplements', '先从食物获得营养，暂不新增保健品，整理已有药物和补充品清单。'],
    ['daily_routine', '可在连续坐一小时后起身活动两分钟。']
  ] as const)('%s 没有个人依据时允许明确的一般低风险起点，不编引用', (domain, firstStep) => {
    const value = habitCandidate(generalHabit({ lifestyleDomain: domain, firstStep }));
    const before = JSON.stringify(value);
    expect(validateAssessmentCandidate(value, input).issues).toEqual([]);
    expect(JSON.stringify(value)).toBe(before);
  });

  it('旧动作没有生活元信息仍可读取，但不获一般建议豁免；部分字段不能混用', () => {
    const original = withReportedPlan().actions[0]!;
    expect(healthActionSchema.safeParse(original).success).toBe(true);
    const noMetadata = generalHabit();
    delete noMetadata.lifestyleDomain;
    delete noMetadata.lifestyleBasis;
    expect(validateAssessmentCandidate(habitCandidate(noMetadata), input).issues)
      .toEqual(['action_personal_evidence_required:action:daily-life']);
    expect(validateAssessmentCandidate(habitCandidate(generalHabit({ lifestyleBasis: undefined })), input).issues)
      .toEqual(['lifestyle_metadata_incomplete:action:daily-life', 'action_personal_evidence_required:action:daily-life']);
    expect(healthActionSchema.safeParse({ ...original, lifestyleDomain: 'medicine', lifestyleBasis: 'general' }).success).toBe(false);
  });

  it('个性化习惯仍需有效个人依据，一般标签不能给既有医嘱或个人断言通行', () => {
    const personalized = generalHabit({ lifestyleBasis: 'personalized' });
    expect(validateAssessmentCandidate(habitCandidate(personalized), input).issues)
      .toEqual(['action_personal_evidence_required:action:daily-life']);
    const sourced = { ...personalized, evidenceIds: ['plan-source'] };
    expect(validateAssessmentCandidate(habitCandidate(sourced), { ...input, evidenceCatalog: [reportSource('本人希望调整饮食搭配。')] }).issues).toEqual([]);
    const disguised = generalHabit({ why: '你的血脂偏高，需靠饮食把它降低。' });
    expect(validateAssessmentCandidate(habitCandidate(disguised), input).issues).toEqual([
      'general_lifestyle_not_low_risk:action:daily-life', 'action_personal_evidence_required:action:daily-life'
    ]);
    const plan = withReportedPlan({ lifestyleDomain: 'supplements', lifestyleBasis: 'general' });
    expect(validateAssessmentCandidate(plan, { ...input, evidenceCatalog: [reportSource('建议3个月后复查甲状腺功能。')] }).issues)
      .toEqual(['general_lifestyle_not_low_risk:action:report-plan']);
  });

  it.each([
    { firstStep: '近期复查肝功能。' },
    { kind: 'treatment_discussion' as const },
    { urgency: 'soon' as const },
    { timingBasis: 'guideline' as const },
    { claimIds: ['unproven-claim'] },
    { evidenceIds: ['unproven-evidence'] }
  ])('一般生活豁免不适用于医疗安排、个体关联或非低风险边界 %j', (overrides) => {
    const issues = validateAssessmentCandidate(habitCandidate(generalHabit(overrides)), input).issues;
    expect(issues).toContain('general_lifestyle_not_low_risk:action:daily-life');
  });

  it('保健品的缺乏依据与用药未知保留为条件，不推断本人未服药', () => {
    const value = habitCandidate(generalHabit({ lifestyleDomain: 'supplements', title: '保健品与营养补充',
      why: '补充品并非人人需要。', firstStep: '暂不新增保健品；先整理食物来源和已经在用的补充品。',
      caution: '若正在用药，添加补充品前请与医生或药师核对重复成分和相互作用。' }));
    expect(validateAssessmentCandidate(value, input).issues).toEqual([]);
    value.actions[0]!.firstStep = '每天补充维生素D。';
    expect(validateAssessmentCandidate(value, input).issues).toEqual([
      'general_lifestyle_not_low_risk:action:daily-life', 'action_personal_evidence_required:action:daily-life'
    ]);
  });

  it.each([
    { timing: '从现在开始作为日常选择。' },
    { timing: '本周开始记录餐食搭配。' },
    { firstStep: '本周先不新增所谓护眼保健品。' },
    { firstStep: '本周先不自行新增保健品。' },
    { firstStep: '暂不新增保健品。' },
    { firstStep: '把已有补充品的名称和成分记下，供就诊时讨论。' },
    { firstStep: '就诊时带清单。' },
    { firstStep: '请就诊时带清单。' },
    { firstStep: '请在下次就诊时带上已有补充品清单。' },
    { firstStep: '下次就诊时带上已有补充品清单。' },
    { reviewPlan: '只有出现明确缺乏、特殊需要或医生建议时，再讨论是否需要补充。' },
    { reviewPlan: '和医生讨论是否需要补充维生素D，不以购买保健品作为默认做法。' },
    { firstStep: '补充维生素D相关信息，整理已有补充品清单。' },
    { firstStep: '通过食物补充营养，先搭配多样化餐食。' },
    { firstStep: '通过食物补充维生素，不把购买保健品作为默认做法。' }
  ])('补充品一般建议不把日常开始、否定、清单和需要评估误认执行 %j', (overrides) => {
    const value = habitCandidate(generalHabit({ lifestyleDomain: 'supplements', title: '暂不自行新增保健品', ...overrides }));
    expect(validateAssessmentCandidate(value, input).issues).toEqual([]);
  });

  it('儿童真模型产生的完整一般补充品建议不触发不必要修复或隔离', () => {
    const value = habitCandidate(generalHabit({ lifestyleDomain: 'supplements', title: '暂不为视力问题自行新增保健品',
      why: '本次资料没有营养缺乏或特殊补充需要的依据，优先从日常食物获得营养更合适；保健品不能替代验光和必要的眼科处理。',
      firstStep: '本周先不新增所谓护眼保健品。若正在使用营养补充剂，由家长查看成分是否重复，并把名称和成分记下，供就诊时讨论。',
      timing: '从现在开始作为日常选择。',
      reviewPlan: '只有出现明确缺乏、特殊需要或医生建议时，再讨论是否需要补充。',
      caution: '如已有医生安排的补充方案，不自行停用或调整；本次资料未提供正在使用的药物和补充剂情况。' }));
    const original = JSON.stringify(value);
    expect(validateAssessmentCandidate(value, input)).toEqual({ issues: [], focusedReviewReasons: [] });
    expect(JSON.stringify(value)).toBe(original);
  });

  it('补充品标题的名词主题不视为服用，已用产品的条件记录仍可保留', () => {
    for (const title of ['保健品与营养补充', '维生素D补充']) {
      const value = habitCandidate(generalHabit({ lifestyleDomain: 'supplements', title,
        firstStep: '与医生讨论是否需要补充维生素D。',
        caution: '若正在服用补充剂，整理已有产品清单；如已有医生安排的补充方案，不自行改变。' }));
      expect(validateAssessmentCandidate(value, input).issues, title).toEqual([]);
    }
  });

  it('营养补充作为既有安排名词的勿擅改提醒不被误判为新增产品', () => {
    const value = habitCandidate(generalHabit({ lifestyleDomain: 'supplements', title: '保健品与营养补充',
      why: '没有额外补充需要的依据时，优先从多样化食物获得营养。',
      firstStep: '先不新增保健品，整理已有药物及补充品清单。',
      caution: '已由医生安排的营养补充不要自行停用；这条建议不涉及处方药调整。' }));
    const original = JSON.stringify(value);
    expect(validateAssessmentCandidate(value, input)).toEqual({ issues: [], focusedReviewReasons: [] });
    expect(JSON.stringify(value)).toBe(original);
    for (const caution of [
      '已由医生安排的营养补充不要自行停用；每天服用鱼油。',
      '已由医生安排的营养补充不要自行停用但每天服用鱼油。',
      '已由医生安排的营养补充应当每天服用鱼油。',
      '请开始医生安排的营养补充不要自行停用。',
      '建议每天进行营养补充，不要自行停用。'
    ]) {
      expect(validateAssessmentCandidate(habitCandidate({ ...value.actions[0]!, caution }), input).issues, caution).toEqual([
        'general_lifestyle_not_low_risk:action:daily-life', 'action_personal_evidence_required:action:daily-life'
      ]);
    }
    const dose = habitCandidate({ ...value.actions[0]!, caution: `${value.actions[0]!.caution}每天服用鱼油1g。` });
    expect(hasNumericSupplementDose(dose.actions[0]!)).toBe(true);
    expect(validateAssessmentCandidate(dose, input).focusedReviewReasons).toContain('numeric_supplement_dose:action:daily-life');
    expect(routeFocusedReview(dose).targetIds).toContain('action:daily-life');
  });

  it.each(['title', 'why', 'firstStep', 'timing', 'reviewPlan', 'caution'] as const)(
    '%s 和其他可见字段一样拦住无依据服用与数字剂量，不挡否定、评估和现用条件', (field) => {
      const base = generalHabit({ lifestyleDomain: 'supplements', title: '保健品与营养补充',
        firstStep: '暂不新增保健品，整理已有补充品清单。' });
      const unsafe = habitCandidate({ ...base, [field]: '每天服用鱼油。' });
      expect(validateAssessmentCandidate(unsafe, input).issues).toEqual([
        'general_lifestyle_not_low_risk:action:daily-life', 'action_personal_evidence_required:action:daily-life'
      ]);
      for (const text of ['暂不服用鱼油。', '先不新增保健品。', '与医生讨论是否需要服用鱼油。',
        '与医生讨论是否需要口服维生素D。', '不要开始服用鱼油。', '如果已在服用鱼油，整理已有清单。']) {
        expect(validateAssessmentCandidate(habitCandidate({ ...base, [field]: text }), input).issues, `${field}: ${text}`).toEqual([]);
      }
      for (const text of ['先不新增保健品。每天服用鱼油。', '如果已在服用鱼油，整理清单。每天服用维生素D。']) {
        expect(validateAssessmentCandidate(habitCandidate({ ...base, [field]: text }), input).issues, `${field}: ${text}`).toEqual([
          'general_lifestyle_not_low_risk:action:daily-life', 'action_personal_evidence_required:action:daily-life'
        ]);
      }
      const dose = habitCandidate({ ...base, [field]: '每日服用鱼油1g。' });
      expect(hasNumericSupplementDose(dose.actions[0]!)).toBe(true);
      expect(validateAssessmentCandidate(dose, input).focusedReviewReasons).toContain('numeric_supplement_dose:action:daily-life');
      expect(routeFocusedReview(dose).targetIds).toEqual(expect.arrayContaining(['action:daily-life', 'overview']));
      expect(routeFocusedReview(dose).reasons).toContain('numeric_supplement_dose:action:daily-life');
    }
  );

  it.each(['title', 'why', 'firstStep', 'timing', 'reviewPlan', 'caution'] as const)(
    '%s 中明确拒绝个人结论或否定补充品效果，不视为疾病断言或新增指令', (field) => {
      const base = generalHabit({ lifestyleDomain: 'supplements', title: '保健品与营养补充',
        firstStep: '暂不新增保健品，整理已有补充品清单。' });
      for (const text of [
        '目前没有资料显示本人存在睡眠问题。',
        '一般日常安排中，不代表本人已存在睡眠疾病。',
        '新增保健品未必有帮助，还可能与现有产品成分重复。',
        '添加保健品不等于保护心脏或肾脏。',
        '一般情况下优先从食物获得营养；目前没有提供营养缺乏或需要额外补充的依据，添加保健品不等于保护心脏或肾脏。',
        '现有资料不足以说明本人已存在睡眠疾病。',
        '不能据此认定本人已确诊糖尿病。',
        '本次缺少相关证据证明你的血脂偏高。',
        '没有资料显示你的血脂偏高但也不能据此认定你已确诊糖尿病。',
        '没有资料显示你的血脂偏高且不足以说明你已确诊糖尿病。',
        '没有资料显示你的血脂偏高而不能据此认定你已确诊糖尿病。',
        '增加维生素D不一定有效。',
        '补充鱼油并不能保证改善身体情况。'
      ]) {
        expect(validateAssessmentCandidate(habitCandidate({ ...base, [field]: text }), input).issues, `${field}: ${text}`).toEqual([]);
      }
      for (const text of [
        '目前没有资料显示本人存在睡眠问题。你已确诊糖尿病。',
        '本次没有足够证据证明你的血脂偏高然而你已确诊糖尿病。',
        '没有资料显示你的血脂偏高但你已确诊糖尿病。',
        '没有资料显示你的血脂偏高但是你已确诊糖尿病。',
        '没有资料显示你的血脂偏高而你已确诊糖尿病。',
        '没有资料显示你的血脂偏高且你已确诊糖尿病。',
        '没有资料显示你胖而你已确诊糖尿病。',
        '没有资料显示你胖且你已确诊糖尿病。',
        '不代表本人已存在睡眠疾病，但本人已确诊糖尿病。',
        '不能据此认定本人已确诊糖尿病；你的血脂偏高。',
        '新增保健品未必有帮助。每天服用鱼油。',
        '新增保健品未必有帮助但因此建议新增鱼油。',
        '虽然新增保健品未必有帮助但是每天服用鱼油。',
        '添加保健品不等于保护心脏或肾脏，因此建议新增鱼油。',
        '目前没有提供需要额外补充的依据，但每天服用鱼油。',
        '每天服用鱼油未必有帮助。',
        '因此建议新增保健品未必有帮助。'
      ]) {
        expect(validateAssessmentCandidate(habitCandidate({ ...base, [field]: text }), input).issues, `${field}: ${text}`).toEqual([
          'general_lifestyle_not_low_risk:action:daily-life', 'action_personal_evidence_required:action:daily-life'
        ]);
      }
      const dose = habitCandidate({ ...base, [field]: '新增保健品未必有帮助，但每天服用鱼油1g。' });
      expect(validateAssessmentCandidate(dose, input).focusedReviewReasons).toContain('numeric_supplement_dose:action:daily-life');
      expect(routeFocusedReview(dose).targetIds).toContain('action:daily-life');
    }
  );

  it.each([
    '先不新增保健品。每天服用鱼油。',
    '暂不新增保健品，但请服用维生素D。',
    '先不新增保健品并且服用鱼油。',
    '讨论是否需要补充维生素D。随后开始服用鱼油。',
    '讨论是否需要补充维生素D后每天服用鱼油。',
    '从食物获得营养并且新增维生素D。',
    '从现在开始作为日常选择。新增鱼油。',
    '就诊时带清单。近期复查肝功能。',
    '供就诊时讨论，然后预约眼科。',
    '本周预约就诊时带上清单。',
    '前往医院就诊时带清单。',
    '请近期就诊。',
    '每日服用一粒。'
  ])('正常前句不能让后续独立补充剂或医疗安排获得一般豁免：%s', (firstStep) => {
    const value = habitCandidate(generalHabit({ lifestyleDomain: 'supplements', title: '保健品与营养补充', firstStep }));
    expect(validateAssessmentCandidate(value, input).issues).toEqual([
      'general_lifestyle_not_low_risk:action:daily-life', 'action_personal_evidence_required:action:daily-life'
    ]);
  });

  it('一般行动的注意事项同样不能夹带个人疾病或检验肯定断言', () => {
    for (const caution of ['你的血脂偏高。', '你已确诊糖尿病。', '本人的检查显示肾功能偏低。']) {
      const value = habitCandidate(generalHabit({ caution }));
      expect(validateAssessmentCandidate(value, input).issues, caution).toEqual([
        'general_lifestyle_not_low_risk:action:daily-life', 'action_personal_evidence_required:action:daily-life'
      ]);
    }
  });

  it('若或如果已患病的条件提醒可保留，后续独立肯定句不借条件前缀放行', () => {
    for (const caution of ['如果你已确诊糖尿病，遵循医生原有安排。', '若你有食物过敏，避开过敏食物。',
      '如果已确诊糖尿病，保持医生指导的餐食安排。']) {
      expect(validateAssessmentCandidate(habitCandidate(generalHabit({ caution })), input).issues, caution).toEqual([]);
    }
    for (const caution of ['如果你已确诊糖尿病，遵循原安排。你的血脂偏高。',
      '若你有食物过敏，避开相关食物；你已确诊糖尿病。',
      '如果已确诊糖尿病可按原安排，但你的血脂偏高。']) {
      expect(validateAssessmentCandidate(habitCandidate(generalHabit({ caution })), input).issues, caution).toEqual([
        'general_lifestyle_not_low_risk:action:daily-life', 'action_personal_evidence_required:action:daily-life'
      ]);
    }
  });

  it('数字补充剂剂量不能当一般建议绕过个人依据；检验浓度与不添加提醒不误判', () => {
    const dose = generalHabit({ lifestyleDomain: 'supplements', title: '维生素D补充', firstStep: '每天补充维生素D 1000 IU。' });
    const result = validateAssessmentCandidate(habitCandidate(dose), input);
    expect(result.issues).toEqual(['general_lifestyle_not_low_risk:action:daily-life', 'action_personal_evidence_required:action:daily-life']);
    expect(result.focusedReviewReasons).toContain('numeric_supplement_dose:action:daily-life');
    expect(hasNumericSupplementDose({ ...dose, firstStep: '报告维生素D浓度为20 ng/mL；另一浓度95 mg/dL。' })).toBe(false);
    expect(hasNumericSupplementDose({ ...dose, firstStep: '不必自行补充维生素D 1000 IU/天。' })).toBe(false);
    expect(hasNumericSupplementDose({ ...dose, title: '鱼油补充', firstStep: '每日服用鱼油1g。' })).toBe(true);
    expect(hasNumericSupplementDose({ ...dose, title: '鱼油补充', firstStep: '每天服用一粒鱼油。' })).toBe(true);
    expect(hasNumericSupplementDose({ ...dose, title: '先从食物补充营养', firstStep: '每天可尝试一份牛奶约300克。' })).toBe(false);
    expect(hasNumericSupplementDose({ ...dose, firstStep: '每天口服维生素D 1000 IU，随牛奶服用。' })).toBe(true);
    expect(hasNumericSupplementDose({ ...dose, firstStep: '先不自行新增维生素D 1000 IU/天。' })).toBe(false);
    expect(hasNumericSupplementDose({ ...dose, firstStep: '先不新增维生素D 1000 IU/天，但每天服用鱼油1g。' })).toBe(true);
    expect(hasNumericSupplementDose({ ...dose, firstStep: '先不新增维生素D 1000 IU/天。每天服用鱼油1g。' })).toBe(true);
    expect(hasNumericSupplementDose({ ...dose, firstStep: '讨论是否需要补充维生素D 1000 IU/天。' })).toBe(true);
  });
});

describe('成员分析本地正文门禁', () => {
  it.each([
    '该结果不能单独诊断肺栓塞。',
    '该结果无法单独诊断肺栓塞。',
    '该结果尚不能独立确诊肺栓塞。',
    '当前不能直接诊断为肺栓塞。',
    '该结果不应单独诊断肺栓塞。',
    '不能仅凭本次资料诊断肺栓塞。',
    '尚不能仅仅根据此次门诊保存的全部检查资料确诊肺栓塞。',
    '无法依据该组本次及前次影像的完整比较结果单独诊断肺栓塞。',
    '不能通过这一组正常结果直接诊断为肺栓塞。',
    '不能只凭相关证据来单独诊断肺栓塞。',
    '无法根据本次报告来直接确诊肺栓塞。',
    '不能用该次正常结果确诊肺栓塞。',
    '不能以现有资料单独诊断肺栓塞。',
    '不能单独诊断肺癌或脑癌。',
    '不能仅凭本次结果诊断非小细胞肺癌。',
    '肺栓塞目前不能单独诊断。',
    '肺癌尚不能仅凭这一项现有结果直接确诊。',
    '肺栓塞不能依据这次检查资料单独诊断。'
  ])('模态否定通过方式或依据短语约束诊断，不改判确诊：%s', (text) => {
    expect(highConsequenceAssertionMentions(text)).toEqual([]);
  });

  it.each([
    '不能单独排除', '无法直接排除', '尚不能独立排除', '不应单独排除',
    '不能仅凭影像排除', '不能通过症状排除', '无法依据病史排除', '不能仅凭本次检查排除',
    '不能立刻排除', '不能仅依据尚待解释的异常表现排除',
    '不能仅凭本次检查的正常结果排除',
    '不能依据本次及上次门诊保存的所有完整影像检查结果排除',
    '无法根据这一系列已经保存的检查结果直接排除',
    '不能通过本次正常的检查结果单独排除'
  ])('模态否定排除仍是高影响不确定方向：%s', (cue) => {
    expect(highConsequenceAssertionMentions(`${cue}肺栓塞。`)).toEqual([{ diseaseName: '肺栓塞', definite: false }]);
  });

  it('依据内容长度不改变否定诊断或不能排除的确定性', () => {
    for (const length of [1, 20, 300]) {
      const evidence = '本次'.repeat(length) + '正常结果';
      expect(highConsequenceAssertionMentions(`不能仅凭${evidence}诊断肺栓塞。`)).toEqual([]);
      expect(highConsequenceAssertionMentions(`不能仅凭${evidence}排除肺栓塞。`))
        .toEqual([{ diseaseName: '肺栓塞', definite: false }]);
    }
  });

  it.each([
    ['不能单独诊断肺栓塞但已确诊脑出血。', [{ diseaseName: '脑出血', definite: true }]],
    ['不能仅凭当前结果诊断肺栓塞且现在考虑脑出血。', [{ diseaseName: '脑出血', definite: false }]],
    ['不能仅凭当前结果排除肺栓塞但已确诊脑出血。', [
      { diseaseName: '肺栓塞', definite: false }, { diseaseName: '脑出血', definite: true }
    ]],
    ['不能单独诊断肺栓塞。本人已确诊脑出血。', [{ diseaseName: '脑出血', definite: true }]],
    ['父亲不能单独诊断肺栓塞但本人已确诊脑出血。', [{ diseaseName: '脑出血', definite: true }]],
    ['本人不能单独诊断肺栓塞但父亲已确诊脑出血。', []],
    ['不能隐瞒已确诊肺栓塞。', [{ diseaseName: '肺栓塞', definite: true }]],
    ['不能告诉他人已诊断肺栓塞。', [{ diseaseName: '肺栓塞', definite: true }]],
    ['不能依据这一结果并且已确诊肺栓塞。', [{ diseaseName: '肺栓塞', definite: true }]],
    ['不能根据这项资料考虑肺栓塞。', [{ diseaseName: '肺栓塞', definite: false }]],
    ['不能依据相关资料掩盖已经确诊肺栓塞。', [{ diseaseName: '肺栓塞', definite: true }]],
    ['不能依据保密要求隐瞒确诊肺栓塞。', [{ diseaseName: '肺栓塞', definite: true }]],
    ['不能用资料不足否认确诊肺栓塞。', [{ diseaseName: '肺栓塞', definite: true }]],
    ['不能根据个人意愿撤销诊断肺栓塞。', [{ diseaseName: '肺栓塞', definite: true }]],
    ['不能基于隐私理由告诉别人诊断肺栓塞。', [{ diseaseName: '肺栓塞', definite: true }]],
    ['不能凭相关资料隐瞒诊断肺栓塞。', [{ diseaseName: '肺栓塞', definite: true }]],
    ['不能依据未知动词确诊肺栓塞。', [{ diseaseName: '肺栓塞', definite: true }]],
    ['不能仅凭相关情况诊断肺栓塞。', [{ diseaseName: '肺栓塞', definite: true }]],
    ['不能诊断肺栓塞但不能排除脑出血。', [{ diseaseName: '脑出血', definite: false }]],
    ['不能单独排除肺癌及脑癌。', [
      { diseaseName: '肺癌', definite: false }, { diseaseName: '脑癌', definite: false }
    ]],
    ['肺栓塞无法仅凭本次结果排除。', [{ diseaseName: '肺栓塞', definite: false }]],
    ['已确诊肺栓塞但诊断记录尚未提供。', [{ diseaseName: '肺栓塞', definite: true }]]
  ])('方式依据短语不越过新谓词、主体、转折或改变不同病名的极性：%s', (text, expected) => {
    expect(highConsequenceAssertionMentions(text as string)).toEqual(expected);
  });

  it.each([
    '并非不能单独诊断肺栓塞。',
    '并不是完全无法依据此次结果诊断肺栓塞。',
    '不能简单认为无法单独诊断肺栓塞。',
    '不是不能仅凭本次正常结果排除肺栓塞。',
    '不能不排除肺栓塞。'
  ])('模态双重否定不能借未确诊或排除措辞躲开高影响复核：%s', (text) => {
    expect(highConsequenceAssertionMentions(text).length).toBeGreaterThan(0);
  });

  it.each([
    '该检查未提供肺栓塞的诊断记录。',
    '资料尚未提供肺栓塞诊断。',
    '资料没有提供肺栓塞诊断记录；本次仍需结合就诊经过。',
    '当前记录没有给出肺栓塞的诊断依据。',
    '资料未记录肺栓塞的诊断。',
    '资料没有记载肺栓塞诊断结论。',
    '资料并未明确记录肺栓塞的诊断。',
    '资料未提供关于肺栓塞的诊断记录。',
    '资料尚未提供肺栓塞、脑出血诊断。',
    '资料未提供肺栓塞及脑出血的诊断。',
    '资料未提供肺栓塞诊断和脑出血诊断。',
    '资料未提供肺癌、脑癌的诊断。',
    '资料未记录肺癌诊断以及脑癌的诊断记录。',
    '肺栓塞诊断记录尚未提供。',
    '肺栓塞的诊断没有提供。',
    '本次尚未确诊肺栓塞。',
    '本次没有诊断肺栓塞。',
    '本次并未发现肺栓塞。'
  ])('资料缺失谓词及其并列诊断名词不是肯定诊断：%s', (text) => {
    expect(highConsequenceAssertionMentions(text)).toEqual([]);
  });

  it.each(['这不是肺栓塞的诊断。', '这并非肺栓塞诊断记录。', '这并不是肺栓塞和脑出血的诊断。',
    '这不是肺栓塞的诊断以及脑出血的诊断。'])('否定系词支配完整诊断名词，不冒充确诊：%s', (text) => {
    expect(highConsequenceAssertionMentions(text)).toEqual([]);
  });
  it.each(['并非不是肺栓塞的诊断。', '不能说这不是肺栓塞的诊断。', '这不是肺栓塞现已确诊。',
    '这不是肺栓塞的诊断但已确诊脑出血。', '这不是肺栓塞的诊断也不能排除脑出血。'])(
    '否定名词不吞掉双重否定或独立断言：%s', (text) => {
    expect(highConsequenceAssertionMentions(text).length).toBeGreaterThan(0);
  });

  it.each([
    ['资料未提供肺栓塞诊断但已确诊脑出血。', [{ diseaseName: '脑出血', definite: true }]],
    ['资料尚未提供肺栓塞的诊断记录然而仍考虑脑出血。', [{ diseaseName: '脑出血', definite: false }]],
    ['资料未提供肺栓塞诊断并确诊脑出血。', [{ diseaseName: '脑出血', definite: true }]],
    ['资料没有提供肺栓塞诊断也不能排除脑出血。', [{ diseaseName: '脑出血', definite: false }]],
    ['资料没有提供肺栓塞诊断，但不排除脑出血。', [{ diseaseName: '脑出血', definite: false }]],
    ['资料没有提供肺栓塞诊断。已确诊脑出血。', [{ diseaseName: '脑出血', definite: true }]],
    ['资料未提供病史。肺栓塞已确诊。', [{ diseaseName: '肺栓塞', definite: true }]],
    ['资料未提供胸痛情况但已确诊肺栓塞。', [{ diseaseName: '肺栓塞', definite: true }]],
    ['未记录胸痛的肺栓塞诊断。', [{ diseaseName: '肺栓塞', definite: true }]],
    ['未提供咳嗽症状也诊断肺栓塞。', [{ diseaseName: '肺栓塞', definite: true }]],
    ['本人未见胸痛并考虑肺栓塞。', [{ diseaseName: '肺栓塞', definite: false }]],
    ['未提供肺栓塞现已确诊。', [{ diseaseName: '肺栓塞', definite: true }]],
    ['未提供肺栓塞诊断为急性肺栓塞。', [
      { diseaseName: '肺栓塞', definite: true }, { diseaseName: '肺栓塞', definite: true }
    ]],
    ['明确确诊肺栓塞的诊断记录未提供。', [{ diseaseName: '肺栓塞', definite: true }]],
    ['确诊肺栓塞和脑出血的诊断记录未提供。', [
      { diseaseName: '肺栓塞', definite: true }, { diseaseName: '脑出血', definite: true }
    ]],
    ['可能肺栓塞和脑出血的诊断记录未提供。', [
      { diseaseName: '肺栓塞', definite: false }, { diseaseName: '脑出血', definite: false }
    ]],
    ['不能排除肺栓塞和脑出血的诊断记录未提供。', [
      { diseaseName: '肺栓塞', definite: false }, { diseaseName: '脑出血', definite: false }
    ]],
    ['肺栓塞的诊断记录未提供但已确诊脑出血。', [{ diseaseName: '脑出血', definite: true }]],
    ['未提供肺癌诊断但已确诊脑癌。', [{ diseaseName: '脑癌', definite: true }]],
    ['未提供肺癌诊断和已确诊脑癌。', [{ diseaseName: '脑癌', definite: true }]],
    ['未提供肺栓塞诊断、已确诊脑出血及疑似肝衰竭。', [
      { diseaseName: '脑出血', definite: true }, { diseaseName: '肝衰竭', definite: false }
    ]],
    ['未提供肺癌诊断以及脑癌诊断但考虑肝癌。', [{ diseaseName: '肝癌', definite: false }]],
    ['未提供肺栓塞诊断；不能排除肺栓塞。', [{ diseaseName: '肺栓塞', definite: false }]],
    ['未记录肺栓塞诊断但已明确排除脑出血。', []]
  ])('缺失资料的否定不污染独立新谓词、后句或其他对象：%s', (text, expected) => {
    expect(highConsequenceAssertionMentions(text as string)).toEqual(expected);
  });

  it.each([
    '并非未提供肺栓塞诊断。',
    '并不是没有记录肺栓塞诊断。',
    '不是未给出肺栓塞诊断记录。',
    '不能说未提供肺栓塞诊断。',
    '不能认定没有提供肺栓塞诊断。',
    '不只是未提供肺栓塞诊断。',
    '并非完全没有提供肺栓塞诊断。',
    '并不是完全没有提供肺栓塞诊断。',
    '不能简单认为未提供肺栓塞诊断。',
    '不能说目前尚未提供肺栓塞诊断。',
    '并非肺栓塞的诊断记录未提供。',
    '并不是肺栓塞诊断未提供。',
    '不能说肺栓塞的诊断记录未提供。',
    '肺栓塞的诊断记录并非未提供。',
    '并非肺栓塞和脑出血的诊断记录未提供。',
    '并非未提供肺癌诊断。'
  ])('双重否定或争议范围不借资料缺失豁免高影响复核：%s', (text) => {
    expect(highConsequenceAssertionMentions(text).length).toBeGreaterThan(0);
    expect(highConsequenceAssertionMentions(text).every((item) => item.definite)).toBe(true);
  });

  it.each(visibleFieldCases.filter(([owner, field]) => owner !== 'claim' || field !== 'diseaseName'))(
    '%s.%s 中缺失诊断资料不误拦，也不改写可见文本', (owner, field) => {
      const value = visibleContentCandidate();
      setVisibleField(value, owner!, field!, '该检查未提供肺栓塞的诊断记录。');
      const before = JSON.stringify(value);
      const validation = validateAssessmentCandidate(value, contentInput());
      expect(validation.issues).toEqual([]);
      expect(validation.focusedReviewReasons.some((reason) => reason.startsWith('high_consequence:'))).toBe(false);
      expect(JSON.stringify(value)).toBe(before);
    }
  );

  it.each([
    '检查未发现肺癌。', '复查尚未发现脑卒中。', '本次没有检出肺癌。', '影像并未发现心肌梗死。',
    '本次未曾发现肺栓塞。', '复查尚未检出脑癌。', '复查未能检出肺癌。', '本次检查未发现癌栓。',
    '未发现肺癌、脑癌。', '左侧未发现肺癌且右侧未检出脑癌。'
  ])('完整否定谓词不截成肯定的“发现/检出”：%s', (text) => {
    expect(highConsequenceAssertionMentions(text)).toEqual([]);
  });

  it.each(['不能排除', '尚不能据此排除', '未能立即排除', '无法排除', '未排除'])('“%s”保留为疑似方向而非明确阴性', (cue) => {
    expect(highConsequenceAssertionMentions(`${cue}肺癌。`)).toEqual([{ diseaseName: '肺癌', definite: false }]);
  });

  it.each([
    ['未发现肺癌但仍考虑脑癌。', [{ diseaseName: '脑癌', definite: false }]],
    ['未发现新病灶但原报告明确诊断肺癌。', [{ diseaseName: '肺癌', definite: true }]],
    ['左侧未发现肺癌且右侧检出脑癌。', [{ diseaseName: '脑癌', definite: true }]],
    ['父亲未发现肺癌但本人确诊脑癌。', [{ diseaseName: '脑癌', definite: true }]],
    ['本人未发现肺癌但父亲确诊脑癌。', []],
    ['不能排除肺癌但未见脑癌。', [{ diseaseName: '肺癌', definite: false }]],
    ['发现心肌梗死并考虑肺癌。', [{ diseaseName: '心肌梗死', definite: true }, { diseaseName: '肺癌', definite: false }]],
    ['明确诊断肺癌未发现转移。', [{ diseaseName: '肺癌', definite: true }]],
    ['本次发现癌栓。', [{ diseaseName: '癌栓', definite: true }]]
  ])('否定只绑定当前对象，转折、新主体和新的肯定断言重新判定：%s', (text, expected) => {
    expect(highConsequenceAssertionMentions(text as string)).toEqual(expected);
  });

  it.each(['并非未发现肺癌。', '并不是没有发现肺癌。', '不是未检出肺癌。'])('双重否定不能借明确阴性豁免高影响复核：%s', (text) => {
    expect(highConsequenceAssertionMentions(text)).toEqual([{ diseaseName: '肺癌', definite: true }]);
  });

  it.each([
    ['某虚构机构报告明确诊断肺原位癌。', '肺原位癌'],
    ['某虚构机构报告明确诊断为非小细胞肺癌。', '非小细胞肺癌'],
    ['报告明确确诊鳞状细胞癌。', '鳞状细胞癌']
  ])('完整语气词先定位病名起点，不从任意汉字窗口截出半个“诊断”：%s', (text, diseaseName) => {
    expect(highConsequenceAssertionMentions(text!)).toEqual([{ diseaseName, definite: true }]);
  });

  it.each([
    '原报告诊断明确记载肺癌。',
    '原报告诊断已明确记录肺癌。',
    '原报告诊断当时明确注明为肺癌。',
    '原报告诊断已经清楚地写明为肺癌。',
    '原报告诊断清晰记载的肺癌。',
    '原报告诊断明确记录患者为肺癌。'
  ])('来源转述框架不吞进病名，换用“诊断为”仍是同一明确方向：%s', (text) => {
    expect(highConsequenceAssertionMentions(text)).toEqual(highConsequenceAssertionMentions('原报告诊断为肺癌。'));
    expect(highConsequenceAssertionMentions(text)).toEqual([{ diseaseName: '肺癌', definite: true }]);
  });

  it.each([
    ['原报告诊断明确记载左肺原位癌。', [{ diseaseName: '左肺原位癌', definite: true }]],
    ['原报告诊断明确记载右肺原位癌。', [{ diseaseName: '右肺原位癌', definite: true }]],
    ['原报告诊断已明确记录非小细胞肺癌。', [{ diseaseName: '非小细胞肺癌', definite: true }]],
    ['原报告诊断明确记载浸润性肺癌。', [{ diseaseName: '浸润性肺癌', definite: true }]],
    ['原报告诊断可能记载为肺癌。', [{ diseaseName: '肺癌', definite: false }]],
    ['原报告诊断明确记载不能排除肺癌。', [{ diseaseName: '肺癌', definite: false }]],
    ['原报告诊断未明确记载肺癌。', []],
    ['原报告诊断没有记录肺癌。', []],
    ['原报告诊断并非未明确记载肺癌。', [{ diseaseName: '肺癌', definite: true }]],
    ['原报告诊断明确记载其父亲肺癌。', []],
    ['原报告诊断明确记载本人肺癌。', [{ diseaseName: '肺癌', definite: true }]],
    ['原报告诊断未明确记载肺癌但本人考虑脑癌。', [{ diseaseName: '脑癌', definite: false }]]
  ])('转述边界保留修饰、左右侧、否定、确定性、主体及后续独立方向：%s', (text, expected) => {
    expect(highConsequenceAssertionMentions(text as string)).toEqual(expected);
  });

  it.each([
    ['原报告诊断明确记载无功能性胰腺神经内分泌癌。', '无功能性胰腺神经内分泌癌'],
    ['原报告诊断明确记载有棘细胞癌。', '有棘细胞癌'],
    ['原报告诊断明确记载本人无功能性胰腺神经内分泌癌。', '无功能性胰腺神经内分泌癌'],
    ['原报告诊断明确记载患者无功能性胰腺神经内分泌癌。', '无功能性胰腺神经内分泌癌'],
    ['原报告诊断明确记载本人患有无功能性胰腺神经内分泌癌。', '无功能性胰腺神经内分泌癌'],
    ['原报告诊断明确记载本人患有有棘细胞癌。', '有棘细胞癌']
  ])('裸字不是可反复剥离的语法，完整病名修饰不变：%s', (text, diseaseName) => {
    expect(highConsequenceAssertionMentions(text!)).toEqual([{ diseaseName, definite: true }]);
  });

  it.each([
    '原报告诊断明确记载并非肺癌。',
    '原报告诊断明确记载不是肺癌。',
    '原报告诊断明确记载并不是肺癌。',
    '原报告诊断为肺癌的可能性已排除。',
    '原报告诊断考虑肺癌的可能性明确排除。'
  ])('前置诊断框架不能覆盖同一对象的直接否定或后置排除：%s', (text) => {
    expect(highConsequenceAssertionMentions(text)).toEqual([]);
  });

  it.each([
    ['原报告诊断明确记载本人无法排除肺癌。', [{ diseaseName: '肺癌', definite: false }]],
    ['原报告诊断明确记载本人不能排除肺癌。', [{ diseaseName: '肺癌', definite: false }]],
    ['原报告诊断明确记载并非本人无肺癌。', [{ diseaseName: '无肺癌', definite: true }]],
    ['原报告诊断明确记载不是未发现肺癌。', [{ diseaseName: '肺癌', definite: true }]],
    ['原报告诊断明确记载不是未见肺癌。', [{ diseaseName: '肺癌', definite: true }]],
    ['原报告未发现肺癌现已确诊。', [{ diseaseName: '肺癌', definite: true }]],
    ['本人疑似肺癌现已排除。', []],
    ['原报告诊断明确记载本人无肺癌但本人确诊脑癌。', [
      { diseaseName: '无肺癌', definite: true }, { diseaseName: '脑癌', definite: true }
    ]],
    ['原报告诊断为肺癌但转移的可能性已排除。', [{ diseaseName: '肺癌', definite: true }]]
  ])('否定范围不覆盖无法排除、双重否定及其他对象：%s', (text, expected) => {
    expect(highConsequenceAssertionMentions(text as string)).toEqual(expected);
  });

  it('转述后的“并非无”不能借裸字阴性豁免，也不猜测删字后的病名等价', () => {
    const assertions = highConsequenceAssertionMentions('原报告诊断明确记载并非无肺癌。');
    expect(assertions).toEqual([{ diseaseName: '无肺癌', definite: true }]);
    expect(assertions).not.toEqual(highConsequenceAssertionMentions('原报告诊断明确记载肺癌。'));
  });

  it.each(['本人', '患者'])('“%s无X癌”无法纯字法区分否定与病名修饰时保留原串，不借未知切分豁免', (subject) => {
    const assertions = highConsequenceAssertionMentions(`原报告诊断明确记载${subject}无肺癌。`);
    expect(assertions).toEqual([{ diseaseName: '无肺癌', definite: true }]);
    expect(assertions).not.toEqual(highConsequenceAssertionMentions(`原报告诊断明确记载${subject}肺癌。`));
  });

  it.each(visibleFieldCases.filter(([owner, field]) => owner !== 'claim' || field !== 'diseaseName'))(
    '%s.%s 中未发现不被本地正文门禁改判为肯定疾病', (owner, field) => {
      const value = visibleContentCandidate();
      setVisibleField(value, owner!, field!, '本次检查未发现癌栓；尚未检出脑卒中。');
      const before = JSON.stringify(value);
      expect(validateAssessmentCandidate(value, contentInput()).issues).toEqual([]);
      expect(JSON.stringify(value)).toBe(before);
    }
  );

  it.each(['claim', 'overview', 'system'])('普通诊断的%s标题越级有可定位的问题码，不能借正文的可能性通过', (owner) => {
    const value = visibleContentCandidate();
    value.claims[0] = { ...value.claims[0]!, kind: 'diagnostic_assessment', diagnosticStatus: 'possible',
      diseaseName: '鼻炎', text: '这次检查考虑鼻炎，尚不能确定。', rationale: '需要结合症状与查体。',
      materialUncertainty: '缺少鼻部查体记录。' };
    const id = setVisibleField(value, owner, owner === 'claim' ? 'title' : 'headline', '已经确诊鼻炎');
    expect(validateAssessmentCandidate(value, contentInput()).issues).toEqual(['diagnostic_title_contradiction:' + id]);
  });

  it('有直接来源的 documented 普通诊断保留历史标题，不能据此给另一疾病背书', () => {
    const value = visibleContentCandidate();
    value.claims[0] = { ...value.claims[0]!, title: '2021年报告诊断为胃炎', kind: 'diagnostic_assessment',
      diseaseName: '胃炎', diagnosticStatus: 'documented', temporalStatus: 'historical',
      text: '2021年报告记载诊断为胃炎，不代表现在的检查结果。', rationale: '按当次医生诊断记录理解。' };
    value.overview.headline = '2021年报告诊断为胃炎';
    const validationInput = contentInput('2021年临床诊断：胃炎。');
    expect(validateAssessmentCandidate(value, validationInput).issues).toEqual([]);
    value.claims[0]!.title = '已经确诊鼻炎';
    expect(validateAssessmentCandidate(value, validationInput).issues).toEqual(['diagnostic_title_contradiction:claim:result']);
  });

  it('已引用的 typed 主张正文明确提出多个方向时，汇总可逐字关联其中方向而不推断病名关系', () => {
    const value = typedDirectionsCandidate();
    const original = JSON.stringify(value);
    const result = validateAssessmentCandidate(value, contentInput());
    expect(result.issues).toEqual([]);
    expect(result.focusedReviewReasons).toContain('high_consequence:claim:result');
    expect(JSON.stringify(value)).toBe(original);
  });

  it('只有主病名而没有正文提出另一方向时，不能推断其医学包含或同义关系', () => {
    const value = typedDirectionsCandidate('目前不能排除急性冠脉综合征。');
    expect(validateAssessmentCandidate(value, contentInput()).issues).toEqual([
      'unsupported_high_impact_text:overview', 'unsupported_high_impact_text:system:cardiovascular'
    ]);
  });

  it('其他未引用的 typed 主张提出同一病名，也不能替汇总补足结构关联', () => {
    const value = typedDirectionsCandidate('目前不能排除急性冠脉综合征。');
    value.claims.push({ ...value.claims[0]!, id: 'claim:unreferenced', text: '目前需考虑心肌梗死的可能。' });
    expect(validateAssessmentCandidate(value, contentInput()).issues).toEqual([
      'unsupported_high_impact_text:overview', 'unsupported_high_impact_text:system:cardiovascular'
    ]);
  });

  it.each([
    '已排除心肌梗死。',
    '未见心肌梗死。',
    '心肌梗死尚未确诊。',
    '心肌梗死的可能已排除。',
    '资料尚未提供心肌梗死的诊断记录。',
    '资料没有记录心肌梗死诊断。',
    '心肌梗死诊断记录未提供。',
    '家族史：父亲曾诊断心肌梗死。',
    '这份资料只介绍心肌梗死这一病名。'
  ])('typed 主张中仅否定、家族史或普通提及不能给汇总的肯定方向背书：%s', (text) => {
    const value = typedDirectionsCandidate(text);
    value.claims[0]!.diseaseName = '心肌梗死';
    expect(validateAssessmentCandidate(value, contentInput()).issues).toEqual([
      'unsupported_high_impact_text:overview', 'unsupported_high_impact_text:system:cardiovascular'
    ]);
  });

  it('untyped 普通主张夹带重大方向仍拒绝，不能因汇总引用而放过', () => {
    const value = typedDirectionsCandidate();
    value.claims[0] = { ...value.claims[0]!, kind: 'interpretation', diagnosticStatus: null, diseaseName: null };
    expect(validateAssessmentCandidate(value, contentInput()).issues).toEqual([
      'unsupported_high_impact_text:overview', 'unsupported_high_impact_text:system:cardiovascular',
      'high_impact_claim_untyped:claim:result'
    ]);
  });

  it.each(['possible', 'likely', 'undetermined'] as const)('%s 主张不能支持汇总确诊，即使是同一字面病名', (diagnosticStatus) => {
    const value = typedDirectionsCandidate();
    value.claims[0]!.diagnosticStatus = diagnosticStatus;
    value.overview.summary = '目前已经确诊心肌梗死。';
    value.systems[0]!.summary = value.overview.summary;
    expect(validateAssessmentCandidate(value, contentInput()).issues).toEqual([
      'unsupported_high_impact_text:overview', 'unsupported_high_impact_text:system:cardiovascular'
    ]);
  });

  it('同分句前一方向的“可能”不能弱化后一方向独立的“已确诊”', () => {
    const value = typedDirectionsCandidate();
    value.overview.summary = '目前可能急性冠脉综合征且已经确诊心肌梗死。';
    value.systems[0]!.summary = value.overview.summary;
    expect(validateAssessmentCandidate(value, contentInput()).issues).toEqual([
      'unsupported_high_impact_text:overview', 'unsupported_high_impact_text:system:cardiovascular'
    ]);
  });

  it('同分句早先的“本人”不能将最近归属于“父亲”的病名转成本人方向', () => {
    const value = typedDirectionsCandidate('本人没有胸痛且父亲曾诊断心肌梗死。');
    value.claims[0]!.diseaseName = '心肌梗死';
    value.overview.summary = '本人需考虑心肌梗死的可能。';
    value.systems[0]!.summary = value.overview.summary;
    expect(extractHighConsequenceAssertions(value.claims[0]!.text)).toEqual([]);
    expect(validateAssessmentCandidate(value, contentInput()).issues).toEqual([
      'unsupported_high_impact_text:overview', 'unsupported_high_impact_text:system:cardiovascular'
    ]);
    expect(extractHighConsequenceAssertions('父亲曾诊断心肌梗死且本人需考虑急性冠脉综合征。'))
      .toEqual(['急性冠脉综合征']);
  });

  it.each(['和', '以及', '与', '及', '或'])('并列癌词通过“%s”逐个提取并沿用共同可能语气，不截去病名修饰', (connector) => {
    const text = `可能是肺癌${connector}脑癌。`;
    expect(extractHighConsequenceAssertions(text)).toEqual(['肺癌', '脑癌']);
    const value = typedDirectionsCandidate(text);
    value.claims[0]!.diseaseName = '肺癌';
    value.overview.summary = '目前考虑脑癌的可能。';
    value.systems[0]!.summary = value.overview.summary;
    expect(validateAssessmentCandidate(value, contentInput()).issues).toEqual([]);
    value.overview.summary = '目前已经确诊脑癌。';
    value.systems[0]!.summary = value.overview.summary;
    expect(validateAssessmentCandidate(value, contentInput()).issues).toEqual([
      'unsupported_high_impact_text:overview', 'unsupported_high_impact_text:system:cardiovascular'
    ]);
    expect(extractHighConsequenceAssertions('可能非小细胞肺癌。')).toEqual(['非小细胞肺癌']);
  });

  it('并列癌词中独立“已确诊”不能借用前一癌词的共同可能语气', () => {
    const value = typedDirectionsCandidate('可能是肺癌和脑癌。');
    value.claims[0]!.diseaseName = '肺癌';
    value.overview.summary = '可能是肺癌和已经确诊脑癌。';
    value.systems[0]!.summary = value.overview.summary;
    expect(validateAssessmentCandidate(value, contentInput()).issues).toEqual([
      'unsupported_high_impact_text:overview', 'unsupported_high_impact_text:system:cardiovascular'
    ]);
  });

  it('同为明确记录的诊断且有对应来源时，汇总保持其确定性而不被降级', () => {
    const value = typedDirectionsCandidate('原报告诊断心肌梗死。');
    value.claims[0]!.diagnosticStatus = 'documented';
    value.claims[0]!.diseaseName = '心肌梗死';
    value.overview.summary = '本次原报告诊断心肌梗死。';
    value.systems[0]!.summary = value.overview.summary;
    expect(validateAssessmentCandidate(value, contentInput('2026-09-22 诊断：心肌梗死。')).issues).toEqual([]);
  });

  it('逐项保留不同方向的断言语义，否定和家族史不被相邻肯定语气吞掉', () => {
    expect(extractHighConsequenceAssertions('目前不能排除急性冠脉综合征，包括心肌梗死的可能。'))
      .toEqual(['急性冠脉综合征', '心肌梗死']);
    expect(extractHighConsequenceAssertions('已排除心肌梗死；父亲曾诊断肺栓塞；本人需考虑主动脉夹层。'))
      .toEqual(['主动脉夹层']);
    expect(extractHighConsequenceAssertions('高度怀疑肺癌。可能是肺癌。肺癌仍有可能。'))
      .toEqual(['肺癌']);
  });

  it.each(visibleFieldCases)('%s.%s 不能夹带重大疾病判断绕过普通结论门禁', (owner, field) => {
    const value = visibleContentCandidate();
    const id = setVisibleField(value, owner!, field!, '高度怀疑肺癌，需要由专科医生评估。');
    const issue = owner === 'claim' ? `high_impact_claim_untyped:${id}` : `unsupported_high_impact_text:${id}`;
    expect(validateAssessmentCandidate(value, contentInput()).issues).toContain(issue);
  });

  it.each(visibleFieldCases)('%s.%s 不能藏入模型自估的患病概率', (owner, field) => {
    const value = visibleContentCandidate();
    const id = setVisibleField(value, owner!, field!, '患肺癌风险80%。');
    expect(validateAssessmentCandidate(value, contentInput()).issues).toContain(`unsourced_probability:${id}`);
  });

  it.each(visibleFieldCases.filter(([owner, field]) => owner !== 'claim' || field !== 'diseaseName'))(
    '%s.%s 中明确排除不被当成新增重大判断', (owner, field) => {
      const value = visibleContentCandidate();
      setVisibleField(value, owner!, field!, '本次影像已排除肺癌；未见脑卒中。');
      expect(validateAssessmentCandidate(value, contentInput()).issues).toEqual([]);
    }
  );

  it.each([
    ['病理诊断：未见肺癌。', 'documented_source_not_proven:claim:result'],
    ['诊断：无肺癌证据。', 'documented_source_not_proven:claim:result'],
    ['诊断：非肺癌。', 'documented_source_not_proven:claim:result'],
    ['诊断：肺癌待查。', 'documented_source_not_proven:claim:result'],
    ['2022年病理诊断：肺癌，未见转移。', null]
  ])('来源限定不能被 documented 枚举反转：%s', (quote, issue) => {
    const value = visibleContentCandidate();
    value.claims[0] = { ...value.claims[0]!, kind: 'diagnostic_assessment', diagnosticStatus: 'documented',
      diseaseName: '肺癌', temporalStatus: 'historical', text: '2022年原报告病理诊断记载肺癌。' };
    const issues = validateAssessmentCandidate(value, contentInput(quote!)).issues;
    expect(issues).toEqual(issue ? [issue] : []);
  });

  it('没有资料的解释可通过，不用处理失败或正常状态填空', () => {
    expect(validateAssessmentCandidate(fixture(), input).issues).toEqual([]);
  });

  it('历史主张不能升级当前正常，时间矛盾给P03精确的claim owner', () => {
    const value = visibleContentCandidate();
    value.claims[0] = { ...value.claims[0]!, temporalStatus: 'historical',
      text: '目前血脂正常，不需要继续关注。', materialUncertainty: '没有当前检查结果。' };
    expect(validateAssessmentCandidate(value, contentInput()).issues).toEqual(['historical_current_contradiction:claim:result']);
  });

  it('唯一同项目明确缺项与自身未知，正常主张和no_signal状态分别定位', () => {
    const value = visibleContentCandidate();
    value.claims[0] = { ...value.claims[0]!, text: '目前血脂正常。', temporalStatus: 'uncertain',
      materialUncertainty: '当前血脂未知，因为没有这次检查结果。' };
    value.systems[0]!.status = 'no_signal_in_scope';
    expect(validateAssessmentCandidate(value, contentInput('目前没有血脂检查结果。')).issues).toEqual([
      'unknown_normal_contradiction:claim:result', 'unknown_normal_contradiction:system:cardiovascular'
    ]);
  });

  it('正文如实保留旧当次正常与当前未知，缺其他检查不否定本项目', () => {
    const value = visibleContentCandidate();
    value.claims[0] = { ...value.claims[0]!, text: '2022年血脂当次正常，不代表现在。', temporalStatus: 'historical',
      materialUncertainty: '当前甲状腺超声未知。' };
    value.overview.summary = '目前仅知道2022年的结果正常，不能说明现在正常。';
    expect(validateAssessmentCandidate(value, contentInput('目前没有甲状腺超声检查结果。')).issues).toEqual([]);
  });

  it('即使引用和结构正确也拒绝工程正文，给P03可定位的节点字段', () => {
    const value = fixture();
    value.overview.summary = 'P02生成完成，经本地校验通过。';
    value.overview.limitations = ['尚未按新规则复核。'];
    expect(validateAssessmentCandidate(value, input).issues).toEqual([
      'process_narrative:overview:summary', 'process_narrative:overview:limitations[0]'
    ]);
  });

  it('正文门禁与原有作用域校验并存，不改变输入或内部处理字段', () => {
    const value = fixture();
    value.personId = 'other-person';
    value.overview.headline = '模型正在处理';
    expect(validateAssessmentCandidate(value, input).issues).toEqual([
      'process_narrative:overview:headline', 'scope_mismatch'
    ]);
  });

  it.each([
    ['普通结果不等于医生安排', 'TSH 2.1 mIU/L，甲状腺功能在参考范围。', 'source'],
    ['不能借其他项目医嘱', '建议三个月后复查肝功能。', 'instruction'],
    ['不得反转医嘱否定', '无需复查甲状腺功能。', 'source'],
    ['不得换原文时间', '建议六个月后复查甲状腺功能。', 'timing']
  ])('%s时返回可定位的P03字段问题', (_label, quote, field) => {
    const result = validateAssessmentCandidate(withReportedPlan(), { ...input, evidenceCatalog: [reportSource(quote)] });
    expect(result.issues).toEqual([`documented_plan_${field}_not_proven:action:report-plan`]);
  });

  it('标题与原指示正文的错误分别定位，期限藏在正文也不能绕过', () => {
    const catalog = { ...input, evidenceCatalog: [reportSource('建议三个月后复查甲状腺功能。')] };
    expect(validateAssessmentCandidate(withReportedPlan({ title: '无需复查甲状腺功能' }), catalog).issues)
      .toEqual(['documented_plan_title_not_supported:action:report-plan']);
    expect(validateAssessmentCandidate(withReportedPlan({ firstStep: '无需复查甲状腺功能。' }), catalog).issues)
      .toEqual(['documented_plan_instruction_not_proven:action:report-plan']);
    expect(validateAssessmentCandidate(withReportedPlan({ firstStep: '立即复查甲状腺功能。' }), catalog).issues)
      .toEqual(['documented_plan_timing_not_proven:action:report-plan']);
  });

  it('真实引用的对应报告安排与原文时间可通过，不改写原文或候选', () => {
    const value = withReportedPlan();
    const source = reportSource('建议3个月后复查甲状腺功能。');
    const original = JSON.stringify(value);
    expect(validateAssessmentCandidate(value, { ...input, evidenceCatalog: [source] }).issues).toEqual([]);
    expect(JSON.stringify(value)).toBe(original);
  });

  it.each([
    '注意合理饮食、适当活动，可预约全科门诊讨论日常安排。',
    '建议记录规律饮食。若活动后仍有不适，建议三个月后复查肝功能。',
    '若不适持续。建议三个月后复查肝功能。'
  ])('忠实原注意/预约或同引用完整多句安排通过最终本地校验：%s', (quote) => {
    const value = withReportedPlan({ title: DOCUMENTED_PLAN_NEUTRAL_TITLE, firstStep: quote,
      timing: null, timingBasis: 'none' });
    const source = reportSource(quote);
    const original = JSON.stringify(value);
    expect(validateAssessmentCandidate(value, { ...input, evidenceCatalog: [source] }).issues).toEqual([]);
    expect(JSON.stringify(value)).toBe(original);
    expect(source.quote).toBe(quote);
    expect(validateAssessmentCandidate({ ...value, actions: [{ ...value.actions[0]!,
      firstStep: `${quote}并开始每日服用药物5毫克。` }] }, { ...input, evidenceCatalog: [source] }).issues)
      .toContain('documented_plan_instruction_not_proven:action:report-plan');
  });

  it('同引用连续安排不是跨引用或省前提许可，失败仍精确定位原指示正文', () => {
    const first = '建议记录规律饮食。';
    const condition = '若活动后仍有不适，';
    const second = '建议三个月后复查肝功能。';
    const source = reportSource(`${first}${condition}${second}`);
    const value = withReportedPlan({ title: DOCUMENTED_PLAN_NEUTRAL_TITLE, firstStep: `${first}${second}`,
      timing: null, timingBasis: 'none' });
    expect(validateAssessmentCandidate(value, { ...input, evidenceCatalog: [source] }).issues)
      .toEqual(['documented_plan_instruction_not_proven:action:report-plan']);
    value.actions[0]!.firstStep = `${first}${condition}${second}`;
    value.actions[0]!.evidenceIds.push('other-source');
    expect(validateAssessmentCandidate(value, { ...input, evidenceCatalog: [reportSource(first),
      { ...reportSource(`${condition}${second}`), id: 'other-source', sourceSpanId: 'other-span' }] }).issues)
      .toEqual(['documented_plan_instruction_not_proven:action:report-plan']);
  });

  it.each(['若休息后仍有不适。', '若需复查合成项目甲。', '症状持续者。', '三个月后。'])(
    '最终门禁保留独立前提或期限，拒绝仅摘后续指示：%s', (premise) => {
      const instruction = '建议复查合成项目甲。';
      const quote = `${premise}${instruction}`;
      const value = withReportedPlan({ title: DOCUMENTED_PLAN_NEUTRAL_TITLE, firstStep: quote,
        timing: null, timingBasis: 'none' });
      const catalog = { ...input, evidenceCatalog: [reportSource(quote)] };
      expect(validateAssessmentCandidate(value, catalog).issues).toEqual([]);
      expect(validateAssessmentCandidate({ ...value, actions: [{ ...value.actions[0]!, firstStep: instruction }] }, catalog)
        .issues).toEqual(['documented_plan_instruction_not_proven:action:report-plan']);
    }
  );

  it.each(['可预约科技园停车位。', '注意事项：可预约科技馆参观。', '可预约车辆检查。', '可预约设备复查。',
    '无需 注意合理饮食。', '目前已 注意合理饮食。'])(
    '最终门禁不把非医疗预约、否定或已执行习惯变成原安排：%s', (quote) => {
      const value = withReportedPlan({ title: DOCUMENTED_PLAN_NEUTRAL_TITLE, firstStep: quote,
        timing: null, timingBasis: 'none' });
      expect(validateAssessmentCandidate(value, { ...input, evidenceCatalog: [reportSource(quote)] }).issues)
        .toEqual(['documented_plan_source_not_proven:action:report-plan']);
    }
  );

  it('仅timingBasis=documented不能绕过来源验证，普通当前建议不被新门禁误拦', () => {
    const source = reportSource('TSH 2.1 mIU/L，甲状腺功能在参考范围。');
    expect(validateAssessmentCandidate(withReportedPlan({ kind: 'test_followup' }), { ...input, evidenceCatalog: [source] }).issues)
      .toEqual(['documented_plan_source_not_proven:action:report-plan']);
    expect(validateAssessmentCandidate(withReportedPlan({ kind: 'test_followup', timingBasis: 'none' }), { ...input, evidenceCatalog: [source] }).issues)
      .toEqual([]);
  });
});
