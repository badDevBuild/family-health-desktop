import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { clinicalFocusedReviewV1Schema, extractionResultSchema, extractionRepairSchema, knowledgeSourceCandidateSchema,
  memberAssessmentCandidateV3Schema, memberAssessmentRepairV1Schema, type AssessmentRepairReplacement } from '@contracts';
import { restoreCodexOptionalFields, toCodexOutputSchema } from './structured-output-schema.js';

function hasKey(value: unknown, target: string): boolean {
  if (Array.isArray(value)) return value.some((item) => hasKey(item, target));
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(([key, child]) => key === target || hasKey(child, target));
}

const syntheticReplacements: AssessmentRepairReplacement[] = [
  { nodeType: 'claim', value: { id: 'claim', topicKey: 'synthetic', systemIds: [], kind: 'source_fact', text: '合成检查记录。',
    diseaseName: null, diagnosticStatus: null, temporalStatus: 'current', evidenceIds: ['source'], counterEvidenceIds: [],
    trendIds: [], knowledgeBasis: 'not_applicable', knowledgeSourceIds: [], criteriaBasis: null,
    rationale: '原报告记录。', materialUncertainty: null, consequenceLevel: 'routine' } },
  { nodeType: 'action', value: { id: 'action', dedupeKey: 'synthetic', systemIds: [], claimIds: [], kind: 'habit',
    title: '整理日常记录', why: '作为一般习惯起点。', firstStep: '记录作息。', timing: null, timingBasis: 'none',
    reviewPlan: null, caution: null, urgency: 'routine', evidenceIds: [], knowledgeSourceIds: [] } },
  { nodeType: 'overview', value: { id: 'overview', headline: '合成整体情况', summary: '合成检查记录。',
    claimIds: ['claim'], actionIds: ['action'], limitations: [] } },
  { nodeType: 'system', value: { id: 'system', systemId: 'cardiovascular', status: 'monitor', headline: '合成系统情况',
    summary: '合成检查记录。', claimIds: ['claim'], actionIds: ['action'], limitations: [] } },
  { nodeType: 'question', value: { id: 'question', question: '是否有其他资料？', whyItMatters: '限定本次范围。',
    relatedClaimIds: ['claim'], evidenceIds: [] } },
  { nodeType: 'knowledge_source', value: { id: 'source', title: '合成来源', organization: null, url: null,
    origin: 'catalog', supports: '合成医学背景。' } }
];

function repairWireReceipt() {
  return { schemaVersion: 1, personId: 'synthetic', inputSignature: 'a'.repeat(64), originalCandidateHash: 'b'.repeat(64),
    results: syntheticReplacements.map((replacement) => ({ targetId: replacement.value.id, verdict: 'replace',
      reason: '合成结构修复。', replacement: { ...replacement, value: { ...replacement.value,
        ...(replacement.nodeType === 'claim' ? { title: null } : {}),
        ...(replacement.nodeType === 'action' ? { lifestyleDomain: null, lifestyleBasis: null } : {}) } } })) };
}

describe('toCodexOutputSchema', () => {
  it('目标提取补丁恢复candidate/time/coverage嵌套nullable字段，同时保留unchanged必需null', () => {
    const originalSchema = z.toJSONSchema(extractionRepairSchema, { target: 'draft-7' }) as Record<string, unknown>;
    const compatible = toCodexOutputSchema(originalSchema);
    expect(hasKey(compatible, 'oneOf')).toBe(false);
    const candidate = { localKey: 'synthetic', originalName: '合成项目', standardNameCandidate: null,
      value: { kind: 'numeric', rawText: '18.2', decimal: '18.2', comparator: 'eq' },
      unitRaw: 'U/L', referenceRangeRaw: null, reportedAbnormalFlag: null,
      specimen: null, method: null, bodySite: null, clinicalDate: null, clinicalContext: null, sourceBinding: null,
      evidence: [{ sourceSpanId: 'source', quote: '合成项目 18.2 U/L', sourceRole: null, duplicateBasis: null }], issues: [] };
    const output = { schemaVersion: 1, documentId: 'synthetic', originalCandidateHash: 'a'.repeat(64), results: [
      { nodeType: 'candidate', targetId: 'synthetic', decision: { verdict: 'replace', reason: '合成修正', replacement: candidate } },
      { nodeType: 'source_coverage', targetId: 'coverage:source', decision: { verdict: 'replace', reason: '合成补充',
        replacement: { covered: true, candidates: [candidate] } } },
      { nodeType: 'metadata_time', targetId: 'reportMetadata:times:0', decision: { verdict: 'unchanged', reason: '合成保留', replacement: null } }
    ] };
    const restored = extractionRepairSchema.parse(restoreCodexOptionalFields(output, originalSchema));
    const first = restored.results[0]!;
    expect(first.nodeType === 'candidate' && first.decision.verdict === 'replace' && first.decision.replacement)
      .not.toHaveProperty('sourceBinding');
    expect(first.nodeType === 'candidate' && first.decision.verdict === 'replace' && first.decision.replacement.evidence[0])
      .toEqual({ sourceSpanId: 'source', quote: '合成项目 18.2 U/L' });
    const second = restored.results[1]!;
    expect(second.nodeType === 'source_coverage' && second.decision.verdict === 'replace' && second.decision.replacement.candidates[0])
      .not.toHaveProperty('sourceBinding');
    expect(restored.results[2]!.decision.replacement).toBeNull();
    expect(extractionRepairSchema.safeParse(restoreCodexOptionalFields({ ...output, personId: 'unauthorized' }, originalSchema)).success).toBe(false);
  });

  it('把体检提取 Schema 中的嵌套 oneOf 转为 Codex 支持的 anyOf', () => {
    const draft7 = z.toJSONSchema(extractionResultSchema, { target: 'draft-7' }) as Record<string, unknown>;
    expect(hasKey(draft7, 'oneOf')).toBe(true);

    const compatible = toCodexOutputSchema(draft7);

    expect(hasKey(compatible, 'oneOf')).toBe(false);
    expect(hasKey(compatible, 'anyOf')).toBe(true);
    expect(hasKey(draft7, 'oneOf')).toBe(true);
  });

  it('传输层把可选字段改为必填可空，收到 null 后恢复原契约的省略语义', () => {
    const draft7 = z.toJSONSchema(extractionResultSchema, { target: 'draft-7' }) as Record<string, unknown>;
    const compatible = toCodexOutputSchema(draft7);
    const subject = compatible.properties as Record<string, Record<string, unknown>>;
    const evidence = (subject.subject!.properties as Record<string, Record<string, unknown>>).evidence!;
    const reference = evidence.items as Record<string, unknown>;
    expect(reference.required).toEqual(['sourceSpanId', 'quote', 'sourceRole', 'duplicateBasis']);
    expect((reference.properties as Record<string, Record<string, unknown>>).sourceRole!.enum)
      .toEqual(['primary', 'duplicate_source', null]);
    expect(compatible.required).toContain('reportMetadata');
    const restored = restoreCodexOptionalFields({
      subject: { evidence: [{ sourceSpanId: 'span', quote: null, sourceRole: null, duplicateBasis: null }] },
      reportMetadata: null,
      candidates: [{ evidence: [{ sourceSpanId: 'span', quote: null, sourceRole: 'primary', duplicateBasis: null }] }]
    }, draft7) as Record<string, unknown>;
    expect(restored).not.toHaveProperty('reportMetadata');
    expect((restored.subject as { evidence: Array<Record<string, unknown>> }).evidence[0])
      .toEqual({ sourceSpanId: 'span', quote: null });
    expect((restored.candidates as Array<{ evidence: Array<Record<string, unknown>> }>)[0]!.evidence[0])
      .toEqual({ sourceSpanId: 'span', quote: null, sourceRole: 'primary' });
  });

  it('提取来源绑定在旧省略、新完整绑定及strict null回执之间保持契约，不吞掉非法绑定', () => {
    const originalSchema = z.toJSONSchema(extractionResultSchema, { target: 'draft-7' }) as Record<string, unknown>;
    const wireSchema = toCodexOutputSchema(originalSchema);
    const candidateSchema = ((wireSchema.properties as Record<string, Record<string, unknown>>).candidates!.items) as Record<string, unknown>;
    expect(candidateSchema.required).toContain('sourceBinding');
    const sourceBindingSchema = (candidateSchema.properties as Record<string, Record<string, unknown>>).sourceBinding!;
    expect(sourceBindingSchema.type).toEqual(['object', 'null']);
    const candidate = { localKey: 'temporary', originalName: '合成项目', standardNameCandidate: null,
      value: { kind: 'numeric', rawText: '18.2', decimal: '18.2', comparator: 'eq' },
      unitRaw: 'U/L', referenceRangeRaw: null, reportedAbnormalFlag: null,
      specimen: null, method: null, bodySite: null, clinicalDate: null,
      evidence: [{ sourceSpanId: 'source', quote: '合成项目 18.2 U/L' }], issues: [] };
    const base = { schemaVersion: 1, documentId: 'document',
      subject: { reportedName: null, evidence: [], confidence: 'absent' }, coveredSourceSpanIds: ['source'] };
    const legacy = { ...base, candidates: [candidate] };
    expect(extractionResultSchema.safeParse(legacy).success).toBe(true);
    const emptyWire = { ...base, candidates: [{ ...candidate, sourceBinding: null }] };
    expect(extractionResultSchema.safeParse(emptyWire).success).toBe(false);
    const emptyRestored = extractionResultSchema.parse(restoreCodexOptionalFields(emptyWire, originalSchema));
    expect(emptyRestored.candidates[0]).not.toHaveProperty('sourceBinding');
    const boundWire = { ...base, candidates: [{ ...candidate, sourceBinding: {
      headingEvidence: [{ sourceSpanId: 'source', quote: '合成项目', sourceRole: null, duplicateBasis: null }],
      findingEvidence: [{ sourceSpanId: 'source', quote: '18.2 U/L', sourceRole: null, duplicateBasis: null }]
    } }] };
    const boundRestored = extractionResultSchema.parse(restoreCodexOptionalFields(boundWire, originalSchema));
    expect(boundRestored.candidates[0]!.sourceBinding).toEqual({
      headingEvidence: [{ sourceSpanId: 'source', quote: '合成项目' }],
      findingEvidence: [{ sourceSpanId: 'source', quote: '18.2 U/L' }]
    });
    expect(boundWire.candidates[0]!.sourceBinding.findingEvidence[0]).toHaveProperty('sourceRole', null);
    const invalid = { ...base, candidates: [{ ...candidate, sourceBinding: { headingEvidence: [], findingEvidence: 'wrong' } }] };
    expect(extractionResultSchema.safeParse(restoreCodexOptionalFields(invalid, originalSchema)).success).toBe(false);
  });

  it('拒绝根节点联合，避免把服务端必然拒绝的 Schema 发出去', () => {
    expect(() => toCodexOutputSchema({ oneOf: [{ type: 'object' }, { type: 'object' }] }))
      .toThrow('CODEX_OUTPUT_SCHEMA_ROOT_UNION_UNSUPPORTED');
  });

  it('移除 V3 候选 URL 的不支持 uri 格式，但保留本地 URL 校验与受支持的日期格式', () => {
    const draft7 = z.toJSONSchema(memberAssessmentCandidateV3Schema, { target: 'draft-7' }) as Record<string, unknown>;
    const compatible = toCodexOutputSchema(draft7);
    expect(JSON.stringify(draft7)).toContain('"format":"uri"');
    expect(JSON.stringify(compatible)).not.toContain('"format":"uri"');
    expect(toCodexOutputSchema({ type: 'string', format: 'date-time' })).toEqual({ type: 'string', format: 'date-time' });
    expect(knowledgeSourceCandidateSchema.safeParse({ id: 'source', title: '合成来源', organization: null,
      url: 'not-a-url', origin: 'retrieved', supports: '合成用途' }).success).toBe(false);
  });

  it('真实 P03 schema 的 nullable 外层与 typed 联合内层正确恢复所有节点的可选字段', () => {
    const originalSchema = z.toJSONSchema(memberAssessmentRepairV1Schema, { target: 'draft-7' }) as Record<string, unknown>;
    const compatible = toCodexOutputSchema(originalSchema);
    const resultItem = ((compatible.properties as Record<string, Record<string, unknown>>).results!.items) as Record<string, unknown>;
    const replacement = (resultItem.properties as Record<string, Record<string, unknown>>).replacement!;
    const nodeBranches = (replacement.anyOf as Array<Record<string, unknown>>)[0]!.anyOf as Array<Record<string, unknown>>;
    const claimValue = ((nodeBranches[0]!.properties as Record<string, Record<string, unknown>>).value)!;
    const actionValue = ((nodeBranches[1]!.properties as Record<string, Record<string, unknown>>).value)!;
    expect(claimValue.required).toContain('title');
    expect((claimValue.properties as Record<string, Record<string, unknown>>).title!.type).toEqual(['string', 'null']);
    expect(actionValue.required).toEqual(expect.arrayContaining(['lifestyleDomain', 'lifestyleBasis']));
    const wire = repairWireReceipt();
    const before = structuredClone(wire);
    expect(memberAssessmentRepairV1Schema.safeParse(wire).success).toBe(false);
    const restored = memberAssessmentRepairV1Schema.parse(restoreCodexOptionalFields(wire, originalSchema));
    expect(restored.results.map((item) => item.replacement)).toEqual(syntheticReplacements);
    expect(restored.results[0]!.replacement!.value).not.toHaveProperty('title');
    expect(restored.results[1]!.replacement!.value).not.toHaveProperty('lifestyleDomain');
    expect(restored.results[1]!.replacement!.value).not.toHaveProperty('lifestyleBasis');
    expect(restored.results[0]!.replacement!.value).toMatchObject({ diseaseName: null, diagnosticStatus: null,
      criteriaBasis: null, materialUncertainty: null });
    expect(restored.results[1]!.replacement!.value).toMatchObject({ timing: null, reviewPlan: null, caution: null });
    expect(wire).toEqual(before);
  });

  it('P03 的 unchanged 仍必须保留 required replacement:null', () => {
    const originalSchema = z.toJSONSchema(memberAssessmentRepairV1Schema, { target: 'draft-7' }) as Record<string, unknown>;
    const wire = { schemaVersion: 1, personId: 'synthetic', inputSignature: 'a'.repeat(64), originalCandidateHash: 'b'.repeat(64),
      results: [{ targetId: 'claim', verdict: 'unchanged', reason: '合成来源不足。', replacement: null }] };
    const restored = memberAssessmentRepairV1Schema.parse(restoreCodexOptionalFields(wire, originalSchema));
    expect(restored.results[0]!.replacement).toBeNull();
    expect(restored).toEqual(wire);
  });

  it('P04 使用同一 nullable typed 联合，required null 和 unchanged null 不被误删', () => {
    const originalSchema = z.toJSONSchema(clinicalFocusedReviewV1Schema, { target: 'draft-7' }) as Record<string, unknown>;
    const { originalCandidateHash: _hash, ...wire } = repairWireReceipt();
    wire.results = wire.results.filter((item) => item.replacement.nodeType !== 'knowledge_source');
    const output = { ...wire, results: [...wire.results, { targetId: 'pass-target', verdict: 'pass',
      reason: '合成通过。', replacement: null }] };
    const restored = clinicalFocusedReviewV1Schema.parse(restoreCodexOptionalFields(output, originalSchema));
    expect(restored.results.slice(0, 5).map((item) => item.replacement)).toEqual(syntheticReplacements.slice(0, 5));
    expect(restored.results.at(-1)!.replacement).toBeNull();
    expect(_hash).toHaveLength(64);
  });

  it.each(['invalid_enum', 'unknown_type', 'extra_field'] as const)('联合恢复不放宽 %s 回执', (failure) => {
    const originalSchema = z.toJSONSchema(memberAssessmentRepairV1Schema, { target: 'draft-7' }) as Record<string, unknown>;
    const wire = repairWireReceipt();
    if (failure === 'invalid_enum') Object.assign(wire.results[1]!.replacement.value, { lifestyleDomain: 'medical' });
    if (failure === 'unknown_type') Object.assign(wire.results[1]!.replacement, { nodeType: 'foreign' });
    if (failure === 'extra_field') Object.assign(wire.results[0]!.replacement.value, { unauthorized: '合成额外正文。' });
    const restored = restoreCodexOptionalFields(wire, originalSchema);
    expect(memberAssessmentRepairV1Schema.safeParse(restored).success).toBe(false);
    if (failure === 'unknown_type') expect((restored as typeof wire).results[1]!.replacement).toBe(wire.results[1]!.replacement);
    if (failure === 'extra_field') expect((restored as typeof wire).results[0]!.replacement.value)
      .toHaveProperty('unauthorized', '合成额外正文。');
  });

  it('无法唯一选择联合分支时保持输入，不猜测哪个 null 可以省略', () => {
    const schema = { anyOf: [{ type: 'object', properties: { title: { type: 'string' } } },
      { anyOf: [{ type: 'object', properties: { caution: { type: 'string' } } }, { type: 'null' }] }] };
    const wire = { title: null, caution: null };
    expect(restoreCodexOptionalFields(wire, schema)).toBe(wire);
  });
});
