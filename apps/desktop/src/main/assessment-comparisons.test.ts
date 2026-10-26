import { describe, expect, it } from 'vitest';
import { healthClaimSchema, type HealthClaim, type MemberAssessmentCandidateV3, type MemberEvidenceRef } from '@contracts';
import { assessmentComparisonCoverage, assessmentPriorityTopicKeys, findInvalidAssessmentComparisons, findMissingAssessmentComparisons } from './assessment-comparisons.js';
import { validateAssessmentCandidate, visibleAssessmentTextFields } from './assessment-validation.js';
import { buildAssessmentPriorities } from './assessment-priorities.js';

function fixture() {
  const claim: HealthClaim = { id: 'claim:synthetic', topicKey: 'synthetic_topic', systemIds: ['cardiovascular'],
    kind: 'interpretation', text: '近期检查仍需关注，较早记录偏离参考范围的程度有所减轻。',
    diseaseName: null, diagnosticStatus: null, temporalStatus: 'current', evidenceIds: ['recent', 'older'],
    counterEvidenceIds: [], trendIds: [], knowledgeBasis: 'model_general', knowledgeSourceIds: [], criteriaBasis: null,
    rationale: '两份报告各自的结果和参考范围支持有限的前后解释。', materialUncertainty: null, consequenceLevel: 'important',
    changeAssessment: { direction: 'improving', basis: 'reference_status', summary: '近期结果较以往更接近各自的参考范围。',
      reason: '检测口径不同，只能说这一维度有改善迹象，不能精确量化变化或认为疾病已消失。',
      currentEvidenceIds: ['recent'], previousEvidenceIds: ['older'] } };
  const candidate: MemberAssessmentCandidateV3 = { schemaVersion: 3, personId: 'synthetic', inputSignature: 'a'.repeat(64),
    mode: 'full', requestedSystemIds: ['cardiovascular'],
    overview: { id: 'overview', headline: '已有检查可前后理解', summary: claim.text, claimIds: [claim.id], actionIds: [], limitations: [] },
    systems: [{ id: 'system:cardiovascular', systemId: 'cardiovascular', status: 'monitor', headline: '检查变化',
      summary: claim.text, claimIds: [claim.id], actionIds: [], limitations: [] }],
    claims: [claim], actions: [], questions: [], knowledgeSources: [] };
  const catalog: MemberEvidenceRef[] = ['recent', 'older'].map((id) => ({ id, kind: 'observation', observationId: `obs-${id}`,
    eventId: null, documentId: `doc-${id}`, sourceSpanId: `span-${id}`, knowledgeId: null, label: '合成检查',
    locator: '第1页', quote: '合成检查结果及自身参考范围。' }));
  return { candidate, claim, catalog };
}

describe('重点问题的前后解释', () => {
  it('重建摘要不能升级常规主题；原重点被隔离仍准确记录缺口', () => {
    const { candidate, claim } = fixture();
    const routine = { ...claim, id: 'routine', topicKey: 'routine', consequenceLevel: 'routine' as const };
    delete routine.changeAssessment;
    candidate.claims.push(routine);
    const priorities = assessmentPriorityTopicKeys(candidate);
    candidate.overview.claimIds.push(routine.id);
    expect(assessmentComparisonCoverage(candidate, priorities).missingTopicKeys).toEqual([]);
    candidate.claims = [routine];
    expect(assessmentComparisonCoverage(candidate, priorities)).toEqual({ version: 1, topicCount: 1,
      coveredTopicKeys: [], missingTopicKeys: ['synthetic_topic'] });
  });
  it('无程序趋势对象也允许有来源的定性比较，原候选不被改写', () => {
    const { candidate, catalog } = fixture();
    const before = structuredClone(candidate);
    expect(validateAssessmentCandidate(candidate, { personId: candidate.personId, inputSignature: candidate.inputSignature,
      mode: 'full', requestedSystemIds: candidate.requestedSystemIds, evidenceCatalog: catalog,
      trendIds: [], catalogKnowledgeIds: [], criteriaSets: [] }).issues).toEqual([]);
    expect(candidate).toEqual(before);
    expect(buildAssessmentPriorities({ ...candidate, limitations: [] })[0]!.explanation).toContain('不能精确量化');
  });

  it('按主题查漏，不要求同问题的每条事实重复写变化；旧快照仍可读取', () => {
    const { candidate, claim } = fixture();
    const prior = { ...claim, id: 'claim:history' };
    delete prior.changeAssessment;
    expect(healthClaimSchema.safeParse(prior).success).toBe(true);
    candidate.claims.push(prior, { ...prior, id: 'claim:other', topicKey: 'other_topic' });
    expect(findMissingAssessmentComparisons(candidate)).toEqual(['topic_comparison_missing:claim:other']);
    expect(assessmentComparisonCoverage(candidate)).toEqual({ version: 1, topicCount: 2,
      coveredTopicKeys: ['synthetic_topic'], missingTopicKeys: ['other_topic'] });
  });

  it.each(['improving', 'worsening', 'stable', 'mixed'] as const)('%s 需要两侧来源，不能用一条记录冒充趋势', (direction) => {
    const { candidate, claim, catalog } = fixture();
    claim.changeAssessment!.direction = direction;
    claim.changeAssessment!.previousEvidenceIds = [];
    expect(findInvalidAssessmentComparisons(candidate, catalog)).toContain('comparison_history_required:claim:synthetic');
    claim.changeAssessment!.previousEvidenceIds = ['older'];
    catalog[1]!.observationId = catalog[0]!.observationId;
    expect(findInvalidAssessmentComparisons(candidate, catalog)).toContain('comparison_same_record:claim:synthetic');
  });

  it('未知引用、只存在于目录却不属于本主张的依据均不能支持比较', () => {
    const { candidate, claim, catalog } = fixture();
    claim.evidenceIds = ['recent'];
    expect(findInvalidAssessmentComparisons(candidate, catalog)).toContain('comparison_evidence_scope:claim:synthetic');
    claim.changeAssessment!.previousEvidenceIds = ['foreign'];
    expect(findInvalidAssessmentComparisons(candidate, catalog)).toContain('unknown_evidence:claim:synthetic:foreign');
  });

  it('没有历史和无法比较可解释，但不能伪称首次记录或丢掉判断原因', () => {
    const { candidate, claim, catalog } = fixture();
    claim.changeAssessment!.direction = 'first_record';
    expect(findInvalidAssessmentComparisons(candidate, catalog)).toContain('comparison_first_record_conflict:claim:synthetic');
    claim.changeAssessment!.direction = 'uncertain';
    claim.changeAssessment!.basis = 'insufficient';
    expect(findInvalidAssessmentComparisons(candidate, catalog)).toEqual([]);
    expect(visibleAssessmentTextFields(claim).map((field) => field.field)).toContain('changeAssessment.reason');
    claim.changeAssessment!.reason = ' ';
    expect(healthClaimSchema.safeParse(claim).success).toBe(false);
  });
});
