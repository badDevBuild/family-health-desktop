import { describe, expect, it } from 'vitest';
import { healthActionSchema, memberAssessmentCandidateV3Schema,
  type HealthAction, type MemberAssessmentCandidateV3, type MemberEvidencePackageV3,
  type MemberEvidenceRef } from '@contracts';
import { bindAssessmentSourceInstructions } from './assessment-source-instructions.js';
import { createMemberAnalysisTransport } from './member-analysis-package.js';

const observationId = 'synthetic-instruction-observation-0001';
const evidenceId = 'synthetic-instruction-evidence-0001';
const documentId = 'synthetic-instruction-document-0001';
const rawValue = '若连续3天的记录仍高于140/90 mmHg，且休息后仍不适，医生建议在2周内复诊；未出现这些情况时不要自行加药。';

function fact(overrides: Partial<MemberEvidencePackageV3['facts'][number]> = {}): MemberEvidencePackageV3['facts'][number] {
  return { observationId, originalName: '合成医生安排', modelStandardNameCandidate: null,
    rawValue, valueKind: 'text', qualifier: null, unit: null, referenceRange: null,
    clinicalDate: '2026-01-02', reportedAbnormalFlag: 'unknown', specimen: null, method: null, bodySite: null,
    documentId, systemIds: ['cardiovascular'], evidenceIds: [evidenceId], sourceKind: 'report', ...overrides };
}

function evidence(overrides: Partial<MemberEvidenceRef> = {}): MemberEvidenceRef {
  return { id: evidenceId, kind: 'observation', observationId, eventId: 'synthetic-event',
    documentId, sourceSpanId: 'synthetic-span', knowledgeId: null, label: '合成原件', locator: '合成页1',
    quote: `合成记录。${rawValue}`, ...overrides };
}

function action(overrides: Partial<HealthAction> = {}): HealthAction {
  return { id: 'synthetic:action', dedupeKey: 'synthetic-plan', systemIds: ['cardiovascular'], claimIds: [],
    kind: 'documented_plan', sourceInstructionObservationId: observationId,
    title: '报告中的医生建议', why: '按报告中的安排与医生沟通。', firstStep: '模型转述省略了条件。',
    timing: '2周内', timingBasis: 'documented', reviewPlan: null, caution: null, urgency: 'routine',
    evidenceIds: [evidenceId], knowledgeSourceIds: [], ...overrides };
}

function candidate(overrides: Partial<HealthAction> = {}): MemberAssessmentCandidateV3 {
  return { schemaVersion: 3, personId: 'synthetic-person', inputSignature: 'a'.repeat(64), mode: 'full',
    requestedSystemIds: ['cardiovascular'], overview: { id: 'overview', headline: '合成健康资料',
      summary: '查看原报告中的安排。', claimIds: [], actionIds: ['synthetic:action'], limitations: [] },
    systems: [], claims: [], actions: [action(overrides)], questions: [], knowledgeSources: [] };
}

function evidencePackage(): MemberEvidencePackageV3 {
  return { identity: { personId: 'synthetic-person', birthYear: null, genderContext: null, source: 'user_profile' },
    facts: [fact()], evidenceCatalog: [evidence()], trends: [], personalContext: [], unresolvedScope: [],
    existingActions: [], knowledge: [], criteriaSets: [], partitionResults: [] };
}

describe('原医生安排直接绑定已接纳文本事实', () => {
  it('完整复制条件、否定、数值和期限，不采用模型转述，也不改变其他字段或输入', () => {
    const original = candidate();
    const facts = [fact()];
    const catalog = [evidence()];
    const before = structuredClone({ original, facts, catalog });
    const result = bindAssessmentSourceInstructions(original, facts, catalog);
    expect(result.issues).toEqual([]);
    expect(result.boundActionIds).toEqual(['synthetic:action']);
    expect(result.candidate.actions[0]).toEqual({ ...original.actions[0], firstStep: rawValue });
    expect({ original, facts, catalog }).toEqual(before);
    expect(result.candidate.claims).toEqual(original.claims);
    expect(result.candidate.questions).toEqual(original.questions);
    expect(result.candidate.actions[0]!.evidenceIds).toEqual([evidenceId]);
  });

  it('保留完整多句原值及排版，不切句、不按医学词猜类型；是否为医生指示仍交P04', () => {
    const full = '  合成原始记录：本次没有安排复查。\n若后续有不适，\n请先联系原接诊门诊；不要自行改变处理。  ';
    const result = bindAssessmentSourceInstructions(candidate({ timing: null }), [fact({ rawValue: full })], [evidence()]);
    expect(result.issues).toEqual([]);
    expect(result.candidate.actions[0]!.firstStep).toBe(full);
    expect(result.boundActionIds).toEqual(['synthetic:action']);
  });

  it.each(['missing', 'other-member', 'knowledge'] as const)('拒绝不在当前成员事实中的%s编号', (name) => {
    const original = candidate({ sourceInstructionObservationId: `synthetic-${name}` });
    const result = bindAssessmentSourceInstructions(original, [fact()], [evidence()]);
    expect(result.issues).toEqual(['source_instruction:synthetic:action:fact_not_found']);
    expect(result.candidate).toEqual(original);
    expect(result.boundActionIds).toEqual([]);
  });

  it('拒绝同一观测编号对应多条事实，不挑其中一条猜测', () => {
    const result = bindAssessmentSourceInstructions(candidate(), [fact(), fact({ rawValue: '另一条合成事实。' })], [evidence()]);
    expect(result.issues).toEqual(['source_instruction:synthetic:action:fact_not_unique']);
    expect(result.boundActionIds).toEqual([]);
  });

  it.each(['numeric', 'qualitative', 'unknown'] as const)('不从%s事实推断医生安排', (valueKind) => {
    const result = bindAssessmentSourceInstructions(candidate(), [fact({ valueKind })], [evidence()]);
    expect(result.issues).toEqual(['source_instruction:synthetic:action:fact_not_text']);
    expect(result.boundActionIds).toEqual([]);
  });

  it.each([
    ['空引用', []], ['目录标签', ['合成原件']], ['观测编号', [observationId]],
    ['其他来源', ['synthetic-unrelated-evidence']], ['知识编号', ['synthetic-knowledge']]
  ])('%s不能代替事实实际引用', (_label, evidenceIds) => {
    const result = bindAssessmentSourceInstructions(candidate({ evidenceIds }), [fact()], [evidence(),
      evidence({ id: 'synthetic-unrelated-evidence', observationId: 'synthetic-other-observation' }),
      evidence({ id: 'synthetic-knowledge', kind: 'knowledge', knowledgeId: 'synthetic-knowledge' })]);
    expect(result.issues).toEqual(['source_instruction:synthetic:action:evidence_not_linked']);
    expect(result.boundActionIds).toEqual([]);
  });

  it.each([
    ['知识', { kind: 'knowledge', knowledgeId: 'synthetic-knowledge' }],
    ['目录元数据', { kind: 'event_metadata' }], ['本人计划', { kind: 'user_note' }],
    ['其他文件', { documentId: 'synthetic-other-member-document' }],
    ['其他观测', { observationId: 'synthetic-other-observation' }],
    ['无片段定位', { sourceSpanId: null }], ['无引文', { quote: null }], ['空引文', { quote: '  ' }]
  ] as Array<[string, Partial<MemberEvidenceRef>]>)('事实引用指向%s时拒绝绑定', (_label, overrides) => {
    const result = bindAssessmentSourceInstructions(candidate(), [fact()], [evidence(overrides)]);
    expect(result.issues).toEqual(['source_instruction:synthetic:action:evidence_not_linked']);
    expect(result.boundActionIds).toEqual([]);
  });

  it('引用ID有冲突时拒绝绑定，不挑选看似合适的一条', () => {
    const result = bindAssessmentSourceInstructions(candidate(), [fact()], [evidence(), evidence({ kind: 'knowledge' })]);
    expect(result.issues).toEqual(['source_instruction:synthetic:action:evidence_not_linked']);
  });

  it('允许已接纳事实的任一真实引用交集，不自动新增其他引用', () => {
    const original = candidate({ evidenceIds: ['synthetic-second-evidence'] });
    const result = bindAssessmentSourceInstructions(original,
      [fact({ evidenceIds: [evidenceId, 'synthetic-second-evidence'] })],
      [evidence(), evidence({ id: 'synthetic-second-evidence', kind: 'source_span', observationId: null })]);
    expect(result.issues).toEqual([]);
    expect(result.candidate.actions[0]!.firstStep).toBe(rawValue);
    expect(result.candidate.actions[0]!.evidenceIds).toEqual(['synthetic-second-evidence']);
  });

  it.each(['3周内', '14天内', '两周内', '现在开始', '2周内复查'])('不推算、换算或拼接声明的期限：%s', (timing) => {
    const original = candidate({ timing });
    const result = bindAssessmentSourceInstructions(original, [fact()], [evidence()]);
    expect(result.issues).toEqual(['source_instruction:synthetic:action:timing_not_literal']);
    expect(result.candidate).toEqual(original);
    expect(result.boundActionIds).toEqual([]);
  });

  it('全半角与空白排版等价只用于校验，仍返回完整原值和原期限字段', () => {
    const full = '合成医生安排：２\n周内复诊，未复诊前不要自行改变剂量。';
    const original = candidate({ timing: '2 周内' });
    const result = bindAssessmentSourceInstructions(original, [fact({ rawValue: full })], [evidence()]);
    expect(result.issues).toEqual([]);
    expect(result.candidate.actions[0]).toEqual({ ...original.actions[0], firstStep: full });
  });

  it.each([['13个月后复诊。', '3个月后'], ['十三个月后复诊。', '三个月后']])(
    '不把长数字中的子串当成较短期限：%s / %s', (source, timing) => {
      const result = bindAssessmentSourceInstructions(candidate({ timing }), [fact({ rawValue: source })], [evidence()]);
      expect(result.issues).toEqual(['source_instruction:synthetic:action:timing_not_literal']);
    }
  );

  it('长原句在结构上限内完整保留，超过上限明确失败，不截断', () => {
    const limit = healthActionSchema.shape.firstStep.maxLength!;
    const complete = '合'.repeat(limit - 5) + '2周内复诊';
    expect(complete).toHaveLength(limit);
    const within = bindAssessmentSourceInstructions(candidate(), [fact({ rawValue: complete })], [evidence()]);
    expect(within.issues).toEqual([]);
    expect(within.candidate.actions[0]!.firstStep).toBe(complete);
    const original = candidate();
    const exceeded = bindAssessmentSourceInstructions(original, [fact({ rawValue: `${complete}。` })], [evidence()]);
    expect(exceeded.issues).toEqual(['source_instruction:synthetic:action:source_text_too_long']);
    expect(exceeded.candidate).toEqual(original);
    expect(exceeded.boundActionIds).toEqual([]);
  });

  it('空白原值失败，不用模型文本补成医生安排', () => {
    const result = bindAssessmentSourceInstructions(candidate(), [fact({ rawValue: '  ' })], [evidence()]);
    expect(result.issues).toEqual(['source_instruction:synthetic:action:source_text_invalid']);
    expect(result.boundActionIds).toEqual([]);
  });

  it.each(['habit', 'self_monitor', 'test_followup', 'seek_care', 'treatment_discussion'] as const)(
    '%s不能滥用原句绑定编号', (kind) => {
      const original = candidate({ kind });
      const result = bindAssessmentSourceInstructions(original, [fact()], [evidence()]);
      expect(result.issues).toEqual(['source_instruction:synthetic:action:kind']);
      expect(result.candidate).toEqual(original);
      expect(result.boundActionIds).toEqual([]);
    }
  );

  it('旧候选和旧快照行动没有绑定字段时保持原路径与原正文', () => {
    const original = candidate();
    delete original.actions[0]!.sourceInstructionObservationId;
    expect(memberAssessmentCandidateV3Schema.parse(original)).toEqual(original);
    const result = bindAssessmentSourceInstructions(original, [], []);
    expect(result).toEqual({ candidate: original, issues: [], boundActionIds: [] });
    expect(result.candidate.actions[0]).not.toHaveProperty('sourceInstructionObservationId');
    expect(healthActionSchema.parse(action()).sourceInstructionObservationId).toBe(observationId);
    expect(healthActionSchema.safeParse(action({ sourceInstructionObservationId: '' })).success).toBe(false);
  });

  it('既有成员分析transport还原ref编号，绑定字段不需要新增别名机制', () => {
    const input = evidencePackage();
    const transport = createMemberAnalysisTransport(input);
    const modelCandidate = transport.aliasCandidate(candidate());
    expect(modelCandidate.actions[0]!.sourceInstructionObservationId).toMatch(/^ref:/);
    // P02 以观测编号引用个人事实，既有输出映射还原为该事实真实evidenceIds。
    const restored = transport.restoreOutput(modelCandidate);
    expect(restored).toEqual(candidate());
    const result = bindAssessmentSourceInstructions(restored, input.facts, input.evidenceCatalog);
    expect(result.issues).toEqual([]);
    expect(result.candidate.actions[0]!.firstStep).toBe(rawValue);
    expect(result.boundActionIds).toEqual(['synthetic:action']);
  });
});
