import { describe, expect, it } from 'vitest';
import { memberEvidencePackageV3Schema, type HealthAction, type MemberAssessmentCandidateV3, type MemberEvidencePackageV3, type MemberEvidenceRef } from '@contracts';
import { buildAssessmentSourceInstructionReviewContext } from './member-assessment-input.js';
import { buildMemberAnalysisPackage } from './member-analysis-package.js';

const personId = 'synthetic-person';
const actionId = 'synthetic:source-action';
const observationId = 'synthetic-source-observation';
const documentId = 'synthetic-source-document';
const evidenceId = 'synthetic-source-evidence';
const sourceSpanId = 'synthetic-source-span';
const contextEvidenceId = 'synthetic-context-evidence';
const contextSpanId = 'synthetic-context-span';

function fact(overrides: Partial<MemberEvidencePackageV3['facts'][number]> = {}): MemberEvidencePackageV3['facts'][number] {
  return { observationId, originalName: '合成血脂检查医生建议', modelStandardNameCandidate: '模型另拟的主题不能作为原件标题',
    rawValue: '择期复查。', valueKind: 'text', qualifier: null, unit: null, referenceRange: null,
    clinicalDate: null, reportedAbnormalFlag: 'unknown', specimen: null, method: null, bodySite: null,
    documentId, systemIds: ['cardiovascular'], evidenceIds: [evidenceId], sourceKind: 'report', ...overrides };
}

function evidence(overrides: Partial<MemberEvidenceRef> = {}): MemberEvidenceRef {
  return { id: evidenceId, kind: 'observation', observationId, eventId: 'synthetic-event', documentId,
    sourceSpanId, knowledgeId: null, label: '合成报告.pdf', locator: '第1页', quote: '择期复查。', ...overrides };
}

function action(overrides: Partial<HealthAction> = {}): HealthAction {
  return { id: actionId, dedupeKey: 'synthetic-source-plan', systemIds: ['cardiovascular'], claimIds: [],
    kind: 'documented_plan', sourceInstructionObservationId: observationId,
    title: '候选标题擅自新增的检查主题', why: '候选理由不能冒充原件上下文。', firstStep: '候选重述不能代替原话。',
    timing: null, timingBasis: 'none', reviewPlan: null, caution: null, urgency: 'routine',
    evidenceIds: [evidenceId], knowledgeSourceIds: [], ...overrides };
}

function candidate(actionOverrides: Partial<HealthAction> = {}): MemberAssessmentCandidateV3 {
  return { schemaVersion: 3, personId, inputSignature: 'a'.repeat(64), mode: 'full', requestedSystemIds: ['cardiovascular'],
    overview: { id: 'overview', headline: '合成概览', summary: '合成说明', claimIds: [], actionIds: [actionId], limitations: [] },
    systems: [], claims: [], actions: [action(actionOverrides)], questions: [], knowledgeSources: [] };
}

function evidencePackage(factOverrides: Partial<MemberEvidencePackageV3['facts'][number]> = {}): MemberEvidencePackageV3 {
  return { identity: { personId, birthYear: null, genderContext: null, source: 'user_profile' },
    facts: [fact(factOverrides)], evidenceCatalog: [evidence()], trends: [], personalContext: [], unresolvedScope: [],
    existingActions: [], knowledge: [], criteriaSets: [], partitionResults: [] };
}

function withClinicalContext(): MemberEvidencePackageV3 {
  const condition = { sourceSpanId: contextSpanId, quote: '若复查仍异常，结合原接诊医生的意见。' };
  const input = evidencePackage({ evidenceIds: [evidenceId, contextEvidenceId],
    clinicalContext: { version: 1, status: 'complete', conditions: [condition] } });
  input.evidenceCatalog.push(evidence({ id: contextEvidenceId, sourceSpanId: contextSpanId, quote: condition.quote }));
  return input;
}

describe('P04 原医生安排的已接纳主题与适用条件投影', () => {
  it('备用资料时间完整传入综合，临床日期保持未知，也不把报告日期补成医生安排期限', () => {
    const input = evidencePackage({ effectiveTime: { value: '2024-10-23', endValue: null, precision: 'day',
      role: 'report', source: 'inherited', basis: 'report', displayLabel: '2024-10-23 · 按报告日期记录',
      evidence: [{ sourceSpanId: 'synthetic-issued-span', quote: '签发日期：2024-10-23' }] },
      sourceTime: { scope: 'document', value: '2024-10-23', precision: 'day',
      basis: 'report', role: 'report_issued', evidence: [{ sourceSpanId: 'synthetic-issued-span', quote: '签发日期：2024-10-23' }] } });
    const accepted = memberEvidencePackageV3Schema.parse(input);
    const original = candidate();
    const beforeCandidate = structuredClone(original);
    const output = buildMemberAnalysisPackage(accepted);
    expect(output.facts[0]!.clinicalDate).toBeNull();
    expect(output.facts[0]!.sourceTime).toEqual(input.facts[0]!.sourceTime);
    expect(output.facts[0]!.effectiveTime).toEqual(input.facts[0]!.effectiveTime);
    const context = buildAssessmentSourceInstructionReviewContext(original, [actionId], accepted)[0]!;
    expect(context.clinicalDate).toBeNull();
    expect(context.sourceTime).toEqual(input.facts[0]!.sourceTime);
    expect(context.effectiveTime).toEqual(input.facts[0]!.effectiveTime);
    expect(context.sourceTime!.role).toBe('report_issued');
    expect(context.sourceTime!.basis).toBe('report');
    expect(original).toEqual(beforeCandidate);
    expect(input.facts[0]!.clinicalDate).toBeNull();
    context.sourceTime!.evidence[0]!.quote = '调用方后续编辑，不能反写来源时间';
    expect(accepted.facts[0]!.sourceTime).toEqual(input.facts[0]!.sourceTime);
  });

  it.each(['role', 'precision'] as const)('资料时间的%s与来源含义不一致时拒绝该包装', (mode) => {
    const input = evidencePackage({ sourceTime: { scope: 'document', value: '2024-10-23', precision: 'day',
      basis: 'report', role: 'report_issued', evidence: [{ sourceSpanId: 'synthetic-issued-span', quote: '签发日期：2024-10-23' }] } });
    if (mode === 'role') input.facts[0]!.sourceTime!.role = 'examined';
    if (mode === 'precision') input.facts[0]!.sourceTime!.precision = 'month';
    expect(memberEvidencePackageV3Schema.safeParse(input).success).toBe(false);
    expect(buildAssessmentSourceInstructionReviewContext(candidate(), [actionId], input)[0]!).not.toHaveProperty('sourceTime');
    expect(buildAssessmentSourceInstructionReviewContext(candidate(), [actionId], input)[0]!.clinicalDate).toBeNull();
  });

  it.each([
    { scope: 'document' as const, value: '2024', precision: 'year' as const, basis: 'report' as const,
      role: 'report_issued' as const, evidence: [{ sourceSpanId: 'synthetic-year-span', quote: null },
        { sourceSpanId: 'synthetic-year-label-span', quote: '报告年度：2024年' }] },
    { scope: 'document' as const, value: '2024-10', precision: 'month' as const, basis: 'clinical' as const,
      role: 'examined' as const, evidence: [{ sourceSpanId: 'synthetic-month-span', quote: '检查月份：2024年10月' }] }
  ])('来源时间保持原有 $precision 精度、日期角色和完整证据，不补成精确检查日', (sourceTime) => {
    const input = memberEvidencePackageV3Schema.parse(evidencePackage({ sourceTime }));
    const before = structuredClone(input);
    const context = buildAssessmentSourceInstructionReviewContext(candidate(), [actionId], input)[0]!;
    expect(context.sourceTime).toEqual(sourceTime);
    expect(context.clinicalDate).toBeNull();
    expect(input).toEqual(before);
  });

  it('不借用未选择行动或其他事实的来源时间，也不从目录中的签发日期构造来源时间', () => {
    const input = evidencePackage();
    const otherObservationId = 'synthetic-unselected-time-observation';
    const otherEvidenceId = 'synthetic-unselected-time-evidence';
    input.facts.push(fact({ observationId: otherObservationId, evidenceIds: [otherEvidenceId],
      sourceTime: { scope: 'document', value: '2024-10-23', precision: 'day', basis: 'report', role: 'report_issued',
        evidence: [{ sourceSpanId: 'synthetic-other-issued-span', quote: '签发日期：2024-10-23' }] } }));
    input.evidenceCatalog.push(evidence({ id: otherEvidenceId, observationId: otherObservationId }));
    input.evidenceCatalog[0]!.locator = '报告签发日期：2024-08-09';
    const original = candidate();
    original.actions.push(action({ id: 'synthetic:unselected-time-action', sourceInstructionObservationId: otherObservationId,
      evidenceIds: [otherEvidenceId] }));
    const result = buildAssessmentSourceInstructionReviewContext(original, [actionId], input);
    expect(result).toHaveLength(1);
    expect(result[0]!).not.toHaveProperty('sourceTime');
    expect(result[0]!.clinicalDate).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/2024-10-23|2024-08-09|synthetic-other-issued-span/);
  });

  it('短原话仍带已接纳的原项目名，明确这是提取字段，不冒充原件逐字标题', () => {
    const result = buildAssessmentSourceInstructionReviewContext(candidate(), [actionId], evidencePackage());
    expect(result).toEqual([{ actionId, observationId, clinicalDate: null, rawValue: '择期复查。',
      acceptedFactContext: { provenance: 'accepted_report_observation', originalName: '合成血脂检查医生建议' } }]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('候选标题擅自新增的检查主题');
    expect(serialized).not.toContain('模型另拟的主题不能作为原件标题');
    expect(serialized).not.toContain('候选理由不能冒充原件上下文');
    expect(serialized).not.toContain('合成报告.pdf');
  });

  it('日期缺失保持 null，不从签发日期、候选中的今天或处理日期补出临床日期', () => {
    const original = candidate({ title: '今天复查，处理日期为2026-11-08' });
    const input = evidencePackage();
    input.evidenceCatalog[0] = evidence({ locator: '报告签发于2026-09-03', quote: '报告签发日期2026-09-03。择期复查。' });
    const result = buildAssessmentSourceInstructionReviewContext(original, [actionId], input);
    expect(result[0]!.clinicalDate).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/2026-09-03|2026-11-08/);
  });

  it('有临床日期就精确保留，不改变原话、数值、否定和条件', () => {
    const rawValue = '若连续记录仍高于130/85 mmHg，\n且休息后仍不适，2周内复诊；不要自行加药。';
    const input = evidencePackage({ clinicalDate: '2026-02-04', rawValue });
    input.evidenceCatalog[0] = evidence({ quote: rawValue });
    const result = buildAssessmentSourceInstructionReviewContext(candidate({ timing: '2周内' }), [actionId], input);
    expect(result[0]!.clinicalDate).toBe('2026-02-04');
    expect(result[0]!.rawValue).toBe(rawValue);
  });

  it('只附带已存在的样本、方法和部位，不推断缺失字段，也不改写已接纳名称', () => {
    const input = evidencePackage({ originalName: '  合成检查后安排（原提取字段）  ', specimen: '血清',
      method: '合成检测方法', bodySite: '左侧合成部位' });
    const result = buildAssessmentSourceInstructionReviewContext(candidate(), [actionId], input);
    expect(result[0]!.acceptedFactContext).toEqual({ provenance: 'accepted_report_observation',
      originalName: input.facts[0]!.originalName, specimen: '血清', method: '合成检测方法', bodySite: '左侧合成部位' });
    const absent = evidencePackage({ specimen: '', method: '  ', bodySite: null });
    expect(buildAssessmentSourceInstructionReviewContext(candidate(), [actionId], absent)[0]!.acceptedFactContext)
      .toEqual({ provenance: 'accepted_report_observation', originalName: absent.facts[0]!.originalName });
  });

  it('可选描述过长时不截断或注入全文，原话和主题仍原样保留', () => {
    const input = evidencePackage({ specimen: '合'.repeat(2_001), method: '成'.repeat(2_000) });
    const result = buildAssessmentSourceInstructionReviewContext(candidate(), [actionId], input);
    expect(result[0]!.acceptedFactContext).not.toHaveProperty('specimen');
    expect(result[0]!.acceptedFactContext.method).toBe(input.facts[0]!.method);
    expect(result[0]!.rawValue).toBe(input.facts[0]!.rawValue);
  });

  it('原有条件必须由本事实自己的精确来源引用证明，完整保留而不复制整页', () => {
    const input = withClinicalContext();
    input.evidenceCatalog[1]!.quote = `其他页眉。${input.facts[0]!.clinicalContext!.conditions[0]!.quote}其他页脚。`;
    const original = candidate();
    const before = structuredClone({ original, input });
    const result = buildAssessmentSourceInstructionReviewContext(original, [actionId], input);
    expect(result[0]!.acceptedFactContext.clinicalContext).toEqual(input.facts[0]!.clinicalContext);
    expect(JSON.stringify(result)).not.toMatch(/其他页眉|其他页脚/);
    expect({ original, input }).toEqual(before);
    result[0]!.acceptedFactContext.clinicalContext!.conditions[0]!.quote = '调用方的后续编辑';
    expect(input.facts[0]!.clinicalContext).toEqual(before.input.facts[0]!.clinicalContext);
  });

  it.each([
    ['其他观测', { observationId: 'synthetic-other-observation' }],
    ['其他文件', { documentId: 'synthetic-other-document' }],
    ['其他片段', { sourceSpanId: 'synthetic-other-span' }],
    ['通用知识', { kind: 'knowledge', knowledgeId: 'synthetic-knowledge' }],
    ['目录元数据', { kind: 'event_metadata' }],
    ['没有观测归属的片段', { kind: 'source_span', observationId: null }],
    ['不对应原有条件的引文', { quote: '另一条件，不能借位。' }],
    ['没有引文', { quote: null }]
  ] as Array<[string, Partial<MemberEvidenceRef>]>)('条件指向%s时不发送该组条件', (_label, overrides) => {
    const input = withClinicalContext();
    input.evidenceCatalog[1] = { ...input.evidenceCatalog[1]!, ...overrides };
    const result = buildAssessmentSourceInstructionReviewContext(candidate(), [actionId], input);
    expect(result).toHaveLength(1);
    expect(result[0]!.acceptedFactContext).not.toHaveProperty('clinicalContext');
  });

  it('目录中虽有符合条件的原文，但不在本事实引用内时不得借用', () => {
    const input = withClinicalContext();
    input.facts[0]!.evidenceIds = [evidenceId];
    expect(buildAssessmentSourceInstructionReviewContext(candidate(), [actionId], input)[0]!.acceptedFactContext)
      .not.toHaveProperty('clinicalContext');
  });

  it('引用编号不唯一时不从同名引用中选择看似合适的条件', () => {
    const input = withClinicalContext();
    input.evidenceCatalog.push({ ...input.evidenceCatalog[1]!, observationId: 'synthetic-other-observation' });
    expect(buildAssessmentSourceInstructionReviewContext(candidate(), [actionId], input)[0]!.acceptedFactContext)
      .not.toHaveProperty('clinicalContext');
  });

  it('不丢弃一个未绑定条件后仍把其余条件标为完整', () => {
    const input = withClinicalContext();
    input.facts[0]!.clinicalContext!.conditions.push({ sourceSpanId: 'synthetic-unbound-span', quote: '不要省略的另一条件。' });
    expect(buildAssessmentSourceInstructionReviewContext(candidate(), [actionId], input)[0]!.acceptedFactContext)
      .not.toHaveProperty('clinicalContext');
  });

  it('没有原有条件就不补条件，未解决状态也不冒充完整', () => {
    const absent = evidencePackage({ clinicalContext: null });
    const unresolved = evidencePackage({ clinicalContext: { version: 1, status: 'unresolved', conditions: [] } });
    for (const input of [absent, unresolved]) {
      expect(buildAssessmentSourceInstructionReviewContext(candidate(), [actionId], input)[0]!.acceptedFactContext)
        .not.toHaveProperty('clinicalContext');
    }
    const existing = withClinicalContext();
    existing.facts[0]!.clinicalContext!.status = 'unresolved';
    expect(buildAssessmentSourceInstructionReviewContext(candidate(), [actionId], existing)[0]!.acceptedFactContext
      .clinicalContext!.status).toBe('unresolved');
  });

  it('只投影被选中且已绑定的行动，不带无关事实、目录全文或候选快照', () => {
    const original = candidate();
    const input = evidencePackage();
    input.facts.push(fact({ observationId: 'synthetic-unrelated-observation', rawValue: '另一份原报告全文'.repeat(200),
      evidenceIds: ['synthetic-unrelated-evidence'] }));
    input.evidenceCatalog.push(evidence({ id: 'synthetic-unrelated-evidence', observationId: 'synthetic-unrelated-observation',
      quote: '无关原文'.repeat(1_000) }));
    original.actions.push(action({ id: 'synthetic:unselected-action', sourceInstructionObservationId: 'synthetic-unrelated-observation',
      evidenceIds: ['synthetic-unrelated-evidence'], title: '未选择的候选标题' }));
    const result = buildAssessmentSourceInstructionReviewContext(original, [actionId, actionId], input);
    expect(result).toHaveLength(1);
    expect(JSON.stringify(result).length).toBeLessThan(1_000);
    expect(JSON.stringify(result)).not.toMatch(/无关原文|另一份原报告全文|未选择的候选标题|overview|inputSignature/);
    expect(buildAssessmentSourceInstructionReviewContext(original, [], input)).toEqual([]);
    expect(buildAssessmentSourceInstructionReviewContext(original, ['missing-target'], input)).toEqual([]);
  });

  it('候选与成员包不是同一成员时整组拒绝，不靠相似原话或观测编号跨成员补充', () => {
    const original = candidate();
    original.personId = 'synthetic-other-person';
    expect(buildAssessmentSourceInstructionReviewContext(original, [actionId], evidencePackage())).toEqual([]);
  });

  it('其他成员观测不在本成员包时不读取、不发送，也不按模型候选标题寻找替代事实', () => {
    const original = candidate({ sourceInstructionObservationId: 'synthetic-other-member-observation' });
    expect(buildAssessmentSourceInstructionReviewContext(original, [actionId], evidencePackage())).toEqual([]);
  });

  it.each([
    ['没有事实来源', { evidenceIds: [] }],
    ['来源未绑定', { evidenceIds: ['synthetic-other-evidence'] }],
    ['候选自创期限', { timing: '3个月后' }],
    ['并非原医生安排', { kind: 'test_followup' }]
  ] as Array<[string, Partial<HealthAction>]>)('%s不会得到已接纳来源上下文', (_label, overrides) => {
    expect(buildAssessmentSourceInstructionReviewContext(candidate(overrides), [actionId], evidencePackage())).toEqual([]);
  });

  it('观测编号或行动编号不唯一时不挑选第一条进行投影', () => {
    const duplicateFacts = evidencePackage();
    duplicateFacts.facts.push(fact({ originalName: '同编号的另一事实' }));
    expect(buildAssessmentSourceInstructionReviewContext(candidate(), [actionId], duplicateFacts)).toEqual([]);
    const duplicateActions = candidate();
    duplicateActions.actions.push(action({ sourceInstructionObservationId: 'missing-observation' }));
    expect(buildAssessmentSourceInstructionReviewContext(duplicateActions, [actionId], evidencePackage())).toEqual([]);
  });
});
