import { describe, expect, it } from 'vitest';
import type { HealthClaim, MemberAssessmentCandidateV3, MemberEvidenceRef } from '@contracts';
import { findAssessmentSemanticIssues, findClaimSemanticIssues, findMissingExamScopeIssues } from './assessment-semantic-quality.js';

function claim(overrides: Partial<HealthClaim> = {}): HealthClaim {
  return {
    id: 'claim:thyroid:2022', topicKey: 'thyroid-function', systemIds: ['endocrine_metabolic'],
    kind: 'source_fact', text: '2022年甲状腺功能当次正常，不代表现在。',
    diseaseName: null, diagnosticStatus: null, temporalStatus: 'historical',
    evidenceIds: ['evidence:thyroid'], counterEvidenceIds: [], trendIds: [],
    knowledgeBasis: 'not_applicable', knowledgeSourceIds: [], criteriaBasis: null,
    rationale: '这是旧报告中的当次结果。', materialUncertainty: '没有当前检查结果。', consequenceLevel: 'routine',
    ...overrides
  };
}

function evidence(quote = '2022年TSH 2.1 mIU/L，甲状腺功能当次正常。', overrides: Partial<MemberEvidenceRef> = {}): MemberEvidenceRef {
  return { id: 'evidence:thyroid', kind: 'source_span', observationId: null, eventId: 'event:2022',
    documentId: 'document:2022', sourceSpanId: 'span:2022', knowledgeId: null, label: '旧报告',
    locator: null, quote, ...overrides };
}

function unknownClaim(overrides: Partial<HealthClaim> = {}): HealthClaim {
  return claim({ temporalStatus: 'uncertain', text: '当前甲状腺功能尚不能确定。',
    rationale: '缺少这次检查结果，不能据此判断正常或异常。',
    materialUncertainty: '当前甲状腺功能尚不能确定，因为缺少这次检查结果。', ...overrides });
}

function candidate(claims = [claim()]): MemberAssessmentCandidateV3 {
  const claimIds = claims.map((item) => item.id);
  return { schemaVersion: 3, personId: 'synthetic-person', inputSignature: 'a'.repeat(64), mode: 'full',
    requestedSystemIds: ['endocrine_metabolic'], overview: { id: 'overview',
      headline: '只有旧报告记录', summary: '2022年的当次结果不代表现在。', claimIds, actionIds: [], limitations: [] },
    systems: [{ id: 'system:endocrine_metabolic', systemId: 'endocrine_metabolic', status: 'insufficient',
      headline: '只有旧报告记录', summary: '2022年的当次结果不代表现在。', claimIds, actionIds: [], limitations: [] }],
    claims, actions: [], questions: [], knowledgeSources: [] };
}

const missing = [evidence('目前没有甲状腺功能检查结果。', { kind: 'user_note', documentId: null, sourceSpanId: null })];

describe('新生成正文的检查缺项范围', () => {
  it.each([
    '缺少散瞳验光、戴合适镜片后的视力和眼科检查，尚不能确定近视是否存在及其程度，也不能确定是否有其他影响视力的原因。',
    '缺少尿液检查，现有检查尚不足以确认慢性肾病或分期。',
    '目前没有做眼科检查。',
    '本人尚未接受甲状腺超声。',
    '缺少完整眼科检查。',
    '缺少发作时的心电图、肌钙蛋白等心肌损伤检查及临床评估，无法确定病因。',
    '缺少当前心电图和肌钙蛋白检查。',
    '本人本次未接受眼科检查。'
  ])('缺项或依据不足仅由提示词改善，不硬判矛盾或增加处理回合：%s', (text) => {
    const value = candidate([claim({ text, temporalStatus: 'current' })]);
    const before = structuredClone(value);
    expect(findMissingExamScopeIssues(value, [evidence('本次资料未提供眼科检查结果。')])).toEqual([]);
    expect(value).toEqual(before);
    expect(findAssessmentSemanticIssues(value, [evidence()])).toEqual([]);
  });

  it.each([
    '本次资料未提供散瞳验光、戴合适镜片后的视力或完整眼科检查结果，尚不能确定看不清的具体原因。',
    '缺少眼科检查结果，尚不能确认近视程度。',
    '现有资料中没有甲状腺超声。',
    '当前记录没有眼科检查。',
    '目前没有眼科检查的完整结果。',
    '未散瞳，不能直接判断近视程度。',
    '缺少检查时的用药情况。',
    '只有一次结果，不能判断长期变化。',
    '如果没有做眼科检查，应和医生讨论是否适合补充。',
    '不能确定是否未做眼科检查。',
    '缺少眼科检查结果不等于没有做眼科检查。',
    '本人没有做眼科检查吗？',
    '没有做眼科检查的说法还不能确定。'
  ])('保留资料限定、临床条件、问题及条件式讨论：%s', (text) => {
    expect(findMissingExamScopeIssues(candidate([claim({ text })]), [evidence()])).toEqual([]);
  });

  it('明确完整同日同检查已做的来源，才能反证本节点的未做断言', () => {
    const value = candidate([claim({ text: '本人于2026-09-22未接受眼科检查。' })]);
    const source = evidence('本人于2026-09-22已接受眼科检查。', { kind: 'user_note' });
    expect(findMissingExamScopeIssues(value, [source])).toEqual(['missing_exam_scope:claim:thyroid:2022:text']);
    expect(findMissingExamScopeIssues(value, [evidence('本人2026-09-22未接受眼科检查。', { kind: 'user_note' })])).toEqual([]);
    // 两份本人自述互有矛盾时，本规则不替用户决定哪份正确。
    value.claims[0]!.evidenceIds.push('note:other');
    expect(findMissingExamScopeIssues(value, [source,
      evidence('本人2026-09-22未接受眼科检查。', { id: 'note:other', kind: 'user_note' })])).toEqual([]);
  });

  it.each([
    '本次资料未提供眼科检查结果。', '本人本次已接受眼科检查吗？',
    '如果本人本次已接受眼科检查，需了解结果。', '可能本人本次已接受眼科检查。',
    '本人上次已接受眼科检查。', '本人2024年已接受眼科检查。',
    '2024年记录：本人本次已接受眼科检查。', '本人本次已接受甲状腺超声。',
    '家人本次已接受眼科检查。', '是否本人本次已接受眼科检查尚不清楚。'
  ])('不把历史、其他检查、提问或不确定来源当成本次反证：%s', (quote) => {
    expect(findMissingExamScopeIssues(candidate([claim({ text: '本人本次未接受眼科检查。' })]),
      [evidence(quote, { kind: 'user_note' })])).toEqual([]);
  });

  it.each([
    { id: 'unrelated-source', kind: 'user_note' as const },
    { kind: 'knowledge' as const }, { kind: 'source_span' as const }
  ])('不从未关联、知识或旧报告的相对本次借出反证：%s', (overrides) => {
    expect(findMissingExamScopeIssues(candidate([claim({ text: '本人本次未接受眼科检查。' })]),
      [evidence('本人本次已接受眼科检查。', overrides)])).toEqual([]);
  });

  it.each(['2024-09-12', '2026-09-22'])('本人自述的相对本次不借用来源日期 %s 反证当前候选', (locator) => {
    expect(findMissingExamScopeIssues(candidate([claim({ text: '本人本次未接受眼科检查。' })]),
      [evidence('本人本次已接受眼科检查。', { kind: 'user_note', locator })])).toEqual([]);
  });

  it.each([{ id: 'unrelated-source' }, { kind: 'knowledge' as const }])('完整同日也不能借用未关联或知识来源：%s', (overrides) => {
    expect(findMissingExamScopeIssues(candidate([claim({ text: '本人2026-09-22未接受眼科检查。' })]),
      [evidence('本人2026-09-22已接受眼科检查。', overrides)])).toEqual([]);
  });

  it('完整同日的同项已做与未做才冲突，不把旧检查搬到本次', () => {
    const value = candidate([claim({ text: '本人2026-09-12未接受眼科检查。' })]);
    expect(findMissingExamScopeIssues(value, [evidence('本人2024-09-12已接受眼科检查。')])).toEqual([]);
    expect(findMissingExamScopeIssues(value, [evidence('本人2026-09-12已接受甲状腺超声。')])).toEqual([]);
    expect(findMissingExamScopeIssues(value, [evidence('本人2026年9月12日已接受眼科检查。')]))
      .toEqual(['missing_exam_scope:claim:thyroid:2022:text']);
    value.claims[0]!.text = '本人本次未接受眼科检查。';
    expect(findMissingExamScopeIssues(value, [evidence('本人2026-09-12已接受眼科检查。', { kind: 'user_note' })])).toEqual([]);
  });

  it('完整同日反证也适用于汇总和限制，但不将普通缺项判为矛盾', () => {
    const value = candidate();
    value.overview.summary = '本人2026-09-22未接受眼科检查。';
    value.systems[0]!.limitations = ['本次资料未提供结果，因此本人2026-09-22未接受眼科检查。', '缺少眼科检查。'];
    expect(findMissingExamScopeIssues(value, [evidence('本人2026-09-22已接受眼科检查。', { kind: 'user_note' })])).toEqual([
      'missing_exam_scope:overview:summary', 'missing_exam_scope:system:endocrine_metabolic:limitations[0]'
    ]);
    expect(findMissingExamScopeIssues(value, [evidence('本人2026-09-22未接受眼科检查。', { kind: 'user_note' })])).toEqual([]);
  });
});

describe('成员正文可证明的时间和缺项矛盾', () => {
  it.each(['甲状腺炎', '过敏性鼻炎', '胃炎', '近视'])('普通疾病 %s 的可能性不能在标题升级为确诊', (diseaseName) => {
    for (const diagnosticStatus of ['possible', 'likely', 'undetermined', 'criteria_met'] as const) {
      const value = claim({ kind: 'diagnostic_assessment', diseaseName, diagnosticStatus,
        title: `已经确诊${diseaseName}`, text: `这次检查考虑${diseaseName}，尚不能据此确诊。` });
      expect(findClaimSemanticIssues(value, [evidence()])).toEqual(['diagnostic_title_contradiction:' + value.id]);
    }
  });

  it.each(['鼻炎已经确诊', '已经患有鼻炎', '明确诊断为鼻炎', '诊断：鼻炎', '鼻炎诊断明确', '未完成检查的情况下已经确诊鼻炎'])('明确肯定标题会定位到主张：%s', (title) => {
    const value = claim({ kind: 'diagnostic_assessment', diseaseName: '鼻炎', diagnosticStatus: 'possible', title });
    expect(findClaimSemanticIssues(value, [evidence()])).toEqual(['diagnostic_title_contradiction:' + value.id]);
  });

  it.each(['尚不能确诊鼻炎', '鼻炎尚未确诊', '鼻炎尚不能确诊', '不能据此确定已经确诊鼻炎',
    '不代表你已经确诊鼻炎', '并非已经确诊鼻炎', '否认患有鼻炎', '是否已经确诊鼻炎？',
    '没有确诊鼻炎', '无法仅凭这些结果确诊鼻炎', '考虑患有鼻炎', '未必已经确诊鼻炎',
    '如果确诊鼻炎，需要结合症状理解', '可能患有鼻炎', '这次考虑鼻炎', '鼻炎的检查结果'])('否定、提问和条件标题完整保留：%s', (title) => {
    const value = claim({ kind: 'diagnostic_assessment', diseaseName: '鼻炎', diagnosticStatus: 'possible', title });
    expect(findClaimSemanticIssues(value, [evidence()])).toEqual([]);
  });

  it.each(['2021年报告记载确诊胃炎', '2021年报告记载胃炎已经确诊', '原报告诊断为胃炎', '既往报告确诊了胃炎'])('来源记载的历史诊断标题不丢掉年月和来源：%s', (title) => {
    const value = claim({ kind: 'diagnostic_assessment', diseaseName: '胃炎', diagnosticStatus: 'documented', title,
      text: '2021年报告记载诊断为胃炎，不代表今天的检查结果。' });
    expect(findClaimSemanticIssues(value, [evidence()])).toEqual([]);
    expect(value.title).toBe(title);
  });

  it.each(['已经确诊鼻炎', '已经确诊胃炎和鼻炎'])('documented 胃炎不能让另一个标题诊断通过：%s', (title) => {
    const value = claim({ kind: 'diagnostic_assessment', diseaseName: '胃炎', diagnosticStatus: 'documented', title });
    expect(findClaimSemanticIssues(value, [evidence()])).toEqual(['diagnostic_title_contradiction:' + value.id]);
  });

  it('前一分句否定不能掩盖后一独立确诊，非诊断字段不能借标题绕过分级', () => {
    const value = claim({ title: '尚未确诊鼻炎，但已经确诊胃炎' });
    expect(findClaimSemanticIssues(value, [evidence()])).toEqual(['diagnostic_title_contradiction:' + value.id]);
  });

  it.each(['尚不能确诊鼻炎却已经确诊胃炎', '无法确诊鼻炎转而已经确诊胃炎',
    '不能忽视已经确诊的胃炎'])('否定的作用域不能覆盖另一个诊断断言：%s', (title) => {
    const value = claim({ title, kind: 'diagnostic_assessment', diseaseName: '胃炎', diagnosticStatus: 'possible',
      text: '这次检查考虑胃炎，但尚不能确诊。' });
    expect(findClaimSemanticIssues(value, [evidence()])).toEqual(['diagnostic_title_contradiction:' + value.id]);
  });

  it('提醒关注原有诊断不等于否定该诊断，有来源的同病名仍可保留', () => {
    const value = claim({ title: '不能忽视已经确诊的胃炎', kind: 'diagnostic_assessment',
      diseaseName: '胃炎', diagnosticStatus: 'documented' });
    expect(findClaimSemanticIssues(value, [evidence()])).toEqual([]);
  });

  it.each(['overview', 'system'] as const)('%s 标题也不能把 possible 主张升级为确诊', (owner) => {
    const value = candidate([claim({ kind: 'diagnostic_assessment', diseaseName: '胃炎', diagnosticStatus: 'possible' })]);
    const node = owner === 'overview' ? value.overview : value.systems[0]!;
    node.headline = '已经确诊胃炎';
    expect(findAssessmentSemanticIssues(value, [evidence()])).toEqual(['diagnostic_title_contradiction:' + node.id]);
  });

  it('汇总确诊标题只能由本节点引用的对应 documented 主张支持', () => {
    const value = candidate([claim({ kind: 'diagnostic_assessment', diseaseName: '胃炎', diagnosticStatus: 'documented' })]);
    value.overview.headline = '2021年报告记载确诊胃炎';
    expect(findAssessmentSemanticIssues(value, [evidence()])).toEqual([]);
    value.overview.claimIds = [];
    expect(findAssessmentSemanticIssues(value, [evidence()])).toEqual(['diagnostic_title_contradiction:overview']);
  });

  it('多份来源分别记载的历史诊断可以并列，但不能因此升级成现在新确诊', () => {
    const value = candidate([
      claim({ kind: 'diagnostic_assessment', diseaseName: '胃炎', diagnosticStatus: 'documented' }),
      claim({ id: 'claim:nose', kind: 'diagnostic_assessment', diseaseName: '鼻炎', diagnosticStatus: 'documented' })
    ]);
    value.overview.headline = '2021年报告记载已确诊胃炎和鼻炎';
    expect(findAssessmentSemanticIssues(value, [evidence()])).toEqual([]);
    value.overview.headline = '目前已经确诊胃炎';
    expect(findAssessmentSemanticIssues(value, [evidence()])).toEqual(['diagnostic_title_contradiction:overview']);
    value.overview.headline = '目前掌握的2021年报告记载已确诊胃炎';
    expect(findAssessmentSemanticIssues(value, [evidence()])).toEqual([]);
  });

  it('完整已记载病名优先，不把病名中的连接词误拆成新诊断', () => {
    const value = claim({ title: '原报告诊断为胃及十二指肠溃疡', kind: 'diagnostic_assessment',
      diseaseName: '胃及十二指肠溃疡', diagnosticStatus: 'documented' });
    expect(findClaimSemanticIssues(value, [evidence()])).toEqual([]);
  });

  it.each(['title', 'text', 'rationale', 'materialUncertainty'] as const)('historical 的 %s 不能独立声称现在正常或无需关注', (field) => {
    expect(findClaimSemanticIssues(claim({ [field]: '目前甲状腺功能正常，不需要继续关注。' }), [evidence()]))
      .toEqual(['historical_current_contradiction:claim:thyroid:2022']);
  });

  it.each([
    '2022年甲状腺功能当次正常，不代表现在。',
    '目前掌握的2022年报告记载甲状腺功能正常，不代表今天的情况。',
    '目前仅知道2022年的结果正常，不能说明现在正常。',
    '目前甲状腺功能不能说正常，缺少当前检查结果。',
    '目前甲状腺功能不是正常。',
    '目前甲状腺功能并非正常。',
    '目前不能据此确认甲状腺功能正常。',
    '如果目前甲状腺功能正常，通常可由医生结合症状决定下一步。',
    '目前甲状腺功能正常吗？',
    '目前甲状腺功能正常参考范围需结合实验室说明。',
    '一般情况下甲状腺功能正常不意味着其他项目正常。'
  ])('历史结果、知识范围、否定和问题保留：%s', (text) => {
    expect(findClaimSemanticIssues(claim({ text }), [evidence()])).toEqual([]);
  });

  it('旧报告转述不能为同句后续新的当前状态提供豁免', () => {
    expect(findClaimSemanticIssues(claim({ text: '目前掌握的2022年报告记载甲状腺功能正常，目前甲状腺功能也正常。' }), [evidence()]))
      .toEqual(['historical_current_contradiction:claim:thyroid:2022']);
  });

  it('current 节点不单靠正常一词触发历史矛盾', () => {
    expect(findClaimSemanticIssues(claim({ temporalStatus: 'current', text: '目前甲状腺功能正常。' }), [evidence()])).toEqual([]);
  });

  it.each(['text', 'rationale', 'materialUncertainty'] as const)('唯一同项目缺项且自身承认未知，%s 不能说正常', (field) => {
    const value = unknownClaim({ [field]: '目前甲状腺功能正常。' });
    // 不确定性本身须同时承认未知，避免凭缺项猜测全部状态。
    if (field === 'materialUncertainty') value.materialUncertainty = '当前甲状腺功能未知；目前甲状腺功能正常。';
    expect(findClaimSemanticIssues(value, missing)).toEqual(['unknown_normal_contradiction:claim:thyroid:2022']);
  });

  it.each([
    '目前甲状腺功能不能确定正常或异常。',
    '甲状腺功能并非正常。',
    '如果甲状腺功能正常，可由医生结合症状理解。',
    '一般甲状腺功能正常范围需结合实验室参考值。',
    '甲状腺功能正常范围需结合实验室参考值。',
    '甲状腺功能正常吗？',
    '目前血常规正常。'
  ])('缺项不否定相邻知识、否定、问题或别的项目：%s', (text) => {
    expect(findClaimSemanticIssues(unknownClaim({ text }), missing)).toEqual([]);
  });

  it('缺超声不能否定明确的甲状腺检验正常', () => {
    const value = unknownClaim({ text: '目前甲状腺功能检验正常。', materialUncertainty: '当前甲状腺超声未知。' });
    expect(findClaimSemanticIssues(value, [evidence('目前没有甲状腺超声检查结果。')])).toEqual([]);
  });

  it.each([
    ['不同项目未知', '当前血常规未知。', missing],
    ['没有自身未知', null, missing],
    ['只是知识资料', '当前甲状腺功能未知。', [evidence('目前没有甲状腺功能检查结果。', { kind: 'knowledge' })]],
    ['来源是问题', '当前甲状腺功能未知。', [evidence('目前没有甲状腺功能检查结果吗？')]],
    ['来源另有已知结果', '当前甲状腺功能未知。', [evidence('没有甲状腺功能检查结果；TSH 2.1 mIU/L。')]]
  ] as const)('不从%s推断状态矛盾', (_label, materialUncertainty, catalog) => {
    expect(findClaimSemanticIssues(unknownClaim({ text: '目前甲状腺功能正常。', materialUncertainty }), catalog)).toEqual([]);
  });

  it('多条证据不按唯一缺项规则推断正常错误', () => {
    const value = unknownClaim({ text: '目前甲状腺功能正常。', evidenceIds: ['evidence:thyroid', 'evidence:current'] });
    expect(findClaimSemanticIssues(value, [...missing, evidence('TSH 2.1 mIU/L。', { id: 'evidence:current' })])).toEqual([]);
  });

  it.each(['overview', 'system'] as const)('合格历史claim不能让%s的当前正常摘要绕过检查', (owner) => {
    const value = candidate();
    const node = owner === 'overview' ? value.overview : value.systems[0]!;
    node.summary = '目前甲状腺功能正常，无需继续关注。';
    expect(findAssessmentSemanticIssues(value, [evidence()])).toEqual(['historical_current_contradiction:' + node.id]);
  });

  it('摘要指向独立当前结果，不因另一个历史项目被判矛盾', () => {
    const value = candidate([claim(), claim({ id: 'claim:current', temporalStatus: 'current', text: '本次血常规正常。' })]);
    value.overview.summary = '目前血常规正常。';
    expect(findAssessmentSemanticIssues(value, [evidence()])).toEqual([]);
  });

  it.each(['overview', 'system'] as const)('同项目只有合格未知claim时，%s的正常摘要精确归属汇总', (owner) => {
    const value = candidate([unknownClaim()]);
    const node = owner === 'overview' ? value.overview : value.systems[0]!;
    node.summary = '目前甲状腺功能正常。';
    expect(findAssessmentSemanticIssues(value, missing)).toEqual(['unknown_normal_contradiction:' + node.id]);
  });

  it('只有明确未知项目不能标no_signal，未知正文和候选不被改写', () => {
    const value = candidate([unknownClaim()]);
    value.systems[0]!.status = 'no_signal_in_scope';
    const before = JSON.stringify(value);
    expect(findAssessmentSemanticIssues(value, missing)).toEqual(['unknown_normal_contradiction:system:endocrine_metabolic']);
    expect(JSON.stringify(value)).toBe(before);
  });

  it('缺甲状腺超声但有独立检验结果，不用缺项将检验和系统整体一并否定', () => {
    const value = candidate([unknownClaim({ text: '当前甲状腺超声未知。', materialUncertainty: '当前甲状腺超声未知。' }),
      claim({ id: 'claim:lab', text: '目前甲状腺功能检验正常。', temporalStatus: 'current', evidenceIds: ['evidence:lab'], materialUncertainty: null })]);
    value.systems[0]!.status = 'no_signal_in_scope';
    value.overview.summary = '目前甲状腺功能检验正常，超声结果尚未提供。';
    expect(findAssessmentSemanticIssues(value, [evidence('目前没有甲状腺超声检查结果。'),
      evidence('TSH 2.1 mIU/L。', { id: 'evidence:lab' })])).toEqual([]);
  });
});
