import { describe, expect, it } from 'vitest';
import type { ClinicalFocusedReviewV1, MemberAssessmentCandidateV3 } from '@contracts';
import { validateAssessmentCandidate, type AssessmentValidationInput } from './assessment-validation.js';
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

describe('routeFocusedReview 高后果方向辅助路由', () => {
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

describe('applyFocusedReview 替换后的依赖闭包', () => {
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
    expect(result.candidate.overview.headline).toBe('部分健康判断仍需核实');
  });

  it('T16：行动改绑到有效主张后保留，不沿用旧依赖图', () => {
    const candidate = dependentCandidate();
    const result = applyFocusedReview(candidate, review(candidate, 'replace', 'claim-other'), ['claim-synthetic', 'action-synthetic']);
    expect(result.candidate.actions.map((action) => action.claimIds)).toEqual([['claim-other']]);
    expect(result.heldTargetIds).not.toContain('action-synthetic');
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
});
