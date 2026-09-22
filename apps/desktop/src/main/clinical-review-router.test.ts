import { describe, expect, it } from 'vitest';
import type { MemberAssessmentCandidateV3 } from '@contracts';
import { routeFocusedReview } from './clinical-review-router.js';

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
});
