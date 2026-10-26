import { describe, expect, it } from 'vitest';
import { assessmentRepairRequestV1Schema, memberAssessmentRepairV1Schema } from './member-assessment-v3.js';

const request = { schemaVersion: 1, stage: 'assessment', personId: 'synthetic-person', inputSignature: 'a'.repeat(64),
  originalCandidateHash: 'b'.repeat(64), targets: ['claim:result', 'action:diet'],
  allowedPaths: ['node:claim:result', 'node:action:diet'], issues: ['documented_source_not_proven:claim:result'],
  targetDetails: [
    { targetId: 'claim:result', nodeType: 'claim', role: 'issue_owner', ownIssues: ['documented_source_not_proven:claim:result'],
      dependsOnIds: [], triggerIssues: ['documented_source_not_proven:claim:result'], remainingEvidenceIds: ['source'], remainingClaimIds: [] },
    { targetId: 'action:diet', nodeType: 'action', role: 'dependent', ownIssues: [], dependsOnIds: ['claim:result'],
      triggerIssues: ['documented_source_not_proven:claim:result'], remainingEvidenceIds: ['source'], remainingClaimIds: ['claim:weight'] }
  ] };
const receipt = { schemaVersion: 1, personId: request.personId, inputSignature: request.inputSignature,
  originalCandidateHash: request.originalCandidateHash,
  results: request.targets.map((targetId) => ({ targetId, verdict: 'unchanged', reason: '该来源不能证明诊断标签，无法可靠改写。', replacement: null })) };

describe('assessment targeted repair contract', () => {
  it('请求明确区分本体问题与依赖校正，回执不需要复制全候选', () => {
    expect(assessmentRepairRequestV1Schema.parse(request)).toEqual(request);
    expect(memberAssessmentRepairV1Schema.parse(receipt)).toEqual(receipt);
  });
  it('定向来源可携带完整原句与已知临床日期，未知日期保持 null', () => {
    const withQuote = structuredClone(request);
    Object.assign(withQuote.targetDetails[0]!, { sourceQuotes: [{ evidenceId: 'source',
      quote: '原报告：有条件的完整检查发现。', clinicalDate: null }] });
    Object.assign(withQuote.targetDetails[1]!, { sourceQuotes: [{ evidenceId: 'source',
      quote: '原报告建议：若有不适请到门诊随访。', clinicalDate: '2026-09-21' }] });
    expect(assessmentRepairRequestV1Schema.parse(withQuote)).toEqual(withQuote);
    Object.assign(withQuote.targetDetails[0]!, { sourceQuotes: [{ evidenceId: 'source', quote: '', clinicalDate: null }] });
    expect(assessmentRepairRequestV1Schema.safeParse(withQuote).success).toBe(false);
  });
  it.each(['personId', 'inputSignature', 'originalCandidateHash', 'results'] as const)('缺少绑定或回执字段 %s 不能视为完成', (key) => {
    const invalid: Record<string, unknown> = { ...receipt };
    delete invalid[key];
    expect(memberAssessmentRepairV1Schema.safeParse(invalid).success).toBe(false);
  });
  it.each([
    { ...receipt, results: [] },
    { ...receipt, claims: [] },
    { ...receipt, results: [{ ...receipt.results[0], verdict: 'pass' }] },
    { ...receipt, results: [{ ...receipt.results[0], reason: '' }] },
    { ...receipt, results: [{ ...receipt.results[0], replacement: { nodeType: 'new_type', value: {} } }] }
  ])('空回执、整报告夹带、P04 verdict 或未知类型被拒绝 %#', (invalid) => {
    expect(memberAssessmentRepairV1Schema.safeParse(invalid).success).toBe(false);
  });
});
