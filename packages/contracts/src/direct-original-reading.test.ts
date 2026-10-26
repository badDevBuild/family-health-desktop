import { describe, expect, it } from 'vitest';
import { assembleDirectOriginalReadingRepair, directOriginalReadingRepairSchema,
  directOriginalReadingResultSchema, sourceModelEvidenceSchema, type DirectOriginalReadingResult } from './index.js';

const hash = 'a'.repeat(64);
const fixture = (): DirectOriginalReadingResult => ({
  schemaVersion: 1, documentId: 'synthetic-report',
  pageReadings: [{ sourceSpanId: 'page-a', status: 'read' }],
  sourceExcerpts: [{ localKey: 'e-a', pageSourceSpanId: 'page-a', quote: '示例项目 <2.50E+02 U/L',
    role: 'finding', clarity: 'clear' }],
  extraction: { schemaVersion: 1, documentId: 'synthetic-report',
    subject: { reportedName: null, confidence: 'absent', evidence: [] }, reportMetadata: null,
    coveredSourceSpanIds: ['page-a'], candidates: [{
      localKey: 'c-a', originalName: '示例项目', standardNameCandidate: null,
      value: { kind: 'numeric', rawText: '<2.50E+02', decimal: '250', comparator: 'lt' },
      unitRaw: 'U/L', referenceRangeRaw: null, reportedAbnormalFlag: null,
      specimen: null, method: null, bodySite: null, clinicalDate: null,
      evidence: [{ sourceSpanId: 'e-a', quote: '示例项目 <2.50E+02 U/L' }], issues: []
    }] }
});

describe('原件直读与受控定点修复契约', () => {
  it('仅被行列槽位引用的来源仍属于非目标保留闭包，不能暗改', () => {
    const original = fixture(); const candidate = original.extraction.candidates[0]!;
    original.sourceExcerpts.push({ localKey: 'slot-only', pageSourceSpanId: 'page-a', quote: '本次', role: 'heading', clarity: 'clear' });
    candidate.sourceBinding = { headingEvidence: [], findingEvidence: candidate.evidence,
      structuredSlot: { version: 1, kind: 'table_cell', contextEvidence: candidate.evidence,
        rowEvidence: candidate.evidence, columnEvidence: [{ sourceSpanId: 'slot-only', quote: null }], axes: [], component: null } };
    expect(() => assembleDirectOriginalReadingRepair({ original, originalReadingHash: hash,
      allowedPageSourceSpanIds: ['page-a'], targets: [{ targetId: 'slot-only', nodeType: 'excerpt' }],
      repair: { schemaVersion: 1, documentId: original.documentId, originalReadingHash: hash,
        results: [{ targetId: 'slot-only', action: 'replace', replacement: { nodeType: 'excerpt',
          value: { ...original.sourceExcerpts[1]!, quote: '上次' } } }] } })).toThrow('SHARED_EXCERPT_UNAUTHORIZED');
  });
  it('漏读页补丁可以补该页新发现，非目标原事实与原摘录不变', () => {
    const original = fixture();
    original.pageReadings.push({ sourceSpanId: 'page-b', status: 'unreadable' });
    original.extraction.coveredSourceSpanIds.push('page-b');
    const newExcerpt = { ...original.sourceExcerpts[0]!, localKey: 'e-b', pageSourceSpanId: 'page-b' };
    const newCandidate = { ...original.extraction.candidates[0]!, localKey: 'c-b',
      evidence: [{ sourceSpanId: 'e-b', quote: newExcerpt.quote }] };
    const input = { original, originalReadingHash: hash, allowedPageSourceSpanIds: ['page-a', 'page-b'],
      targets: [{ targetId: 'page-b', nodeType: 'page' as const }], repair: {
        schemaVersion: 1 as const, documentId: original.documentId, originalReadingHash: hash,
        results: [{ targetId: 'page-b', action: 'replace' as const, replacement: { nodeType: 'page' as const,
          value: { sourceSpanId: 'page-b', status: 'read' as const, newExcerpts: [newExcerpt], newCandidates: [newCandidate] } } }] } };
    const result = assembleDirectOriginalReadingRepair(input);
    expect(result.extraction.candidates).toEqual([original.extraction.candidates[0], newCandidate]);
    expect(result.sourceExcerpts).toEqual([original.sourceExcerpts[0], newExcerpt]);
    expect(result.pageReadings[1]).toEqual({ sourceSpanId: 'page-b', status: 'read' });
    expect(original.extraction.candidates).toHaveLength(1);
    expect(() => assembleDirectOriginalReadingRepair({ ...input, repair: { ...input.repair,
      results: [{ ...input.repair.results[0]!, replacement: { nodeType: 'page', value: {
        ...input.repair.results[0]!.replacement.value, newCandidates: [{ ...newCandidate, localKey: 'c-a' }] } } }] } }))
      .toThrow('ADDITION_SCOPE_MISMATCH');
    expect(() => assembleDirectOriginalReadingRepair({ ...input, repair: { ...input.repair,
      results: [{ ...input.repair.results[0]!, replacement: { nodeType: 'page', value: {
        ...input.repair.results[0]!.replacement.value, newExcerpts: [{ ...newExcerpt, pageSourceSpanId: 'page-a' }] } } }] } }))
      .toThrow('ADDITION_SCOPE_MISMATCH');
    expect(() => assembleDirectOriginalReadingRepair({ ...input, repair: { ...input.repair,
      results: [{ ...input.repair.results[0]!, replacement: { nodeType: 'page', value: {
        ...input.repair.results[0]!.replacement.value, newCandidates: [{ ...newCandidate, evidence: original.extraction.candidates[0]!.evidence }] } } }] } }))
      .toThrow('ADDITION_SOURCE_MISMATCH');
  });
  it('保留科学计数法原值，不让模型声明运行收据', () => {
    expect(directOriginalReadingResultSchema.parse(fixture()).extraction.candidates[0]?.value)
      .toMatchObject({ rawText: '<2.50E+02', comparator: 'lt' });
    expect(directOriginalReadingResultSchema.safeParse({ ...fixture(), modelId: 'forged-model' }).success).toBe(false);
  });
  it('文档不一致与重复页面不能通过', () => {
    const reading = fixture(); reading.extraction.documentId = 'other-report';
    expect(directOriginalReadingResultSchema.safeParse(reading).success).toBe(false);
    const duplicated = fixture(); duplicated.pageReadings.push(duplicated.pageReadings[0]!);
    expect(directOriginalReadingResultSchema.safeParse(duplicated).success).toBe(false);
  });
  it('不同节点及保留目标的key不能碰撞', () => {
    const reading = fixture(); reading.sourceExcerpts[0]!.localKey = 'c-a';
    expect(directOriginalReadingResultSchema.safeParse(reading).success).toBe(false);
    const reserved = fixture(); reserved.extraction.candidates[0]!.localKey = 'metadata';
    expect(directOriginalReadingResultSchema.safeParse(reserved).success).toBe(false);
  });
  it('来源证明只能记录模型引擎，不冒充本机识别', () => {
    const evidence = { version: 1, engine: 'codex-original-reading-v1', modelId: 'gpt-6.1-sol',
      threadId: 'thread-synthetic', turnId: 'turn-synthetic', originalSha256: hash,
      originalSourceObjectId: 'object-synthetic', parentSourceSpanId: 'page-a',
      inputKind: 'image', role: 'finding', clarity: 'clear' };
    expect(sourceModelEvidenceSchema.safeParse(evidence).success).toBe(true);
    expect(sourceModelEvidenceSchema.safeParse({ ...evidence, engine: 'apple-vision-local-v1' }).success).toBe(false);
  });
  it('仅替换点名候选，非目标及原对象保持不变', () => {
    const original = fixture();
    const replacement = { ...original.extraction.candidates[0]!, unitRaw: 'IU/L' };
    const result = assembleDirectOriginalReadingRepair({ original, originalReadingHash: hash,
      allowedPageSourceSpanIds: ['page-a'], targets: [{ targetId: 'c-a', nodeType: 'candidate' }],
      repair: { schemaVersion: 1, documentId: original.documentId, originalReadingHash: hash,
        results: [{ targetId: 'c-a', action: 'replace', replacement: { nodeType: 'candidate', value: replacement } }] } });
    expect(result.extraction.candidates[0]?.unitRaw).toBe('IU/L');
    expect(original.extraction.candidates[0]?.unitRaw).toBe('U/L');
    expect(result.pageReadings).toEqual(original.pageReadings);
    expect(result.sourceExcerpts).toEqual(original.sourceExcerpts);
  });
  it('错误文档/hash/目标集合/类型/候选key都拒绝', () => {
    const original = fixture();
    const repair = { schemaVersion: 1 as const, documentId: original.documentId, originalReadingHash: hash,
      results: [{ targetId: 'c-a', action: 'unchanged' as const, replacement: null }] };
    const input = { original, repair, originalReadingHash: hash, targets: [{ targetId: 'c-a', nodeType: 'candidate' as const }],
      allowedPageSourceSpanIds: ['page-a'] };
    expect(() => assembleDirectOriginalReadingRepair({ ...input, repair: { ...repair, documentId: 'other-report' } })).toThrow('SCOPE_MISMATCH');
    expect(() => assembleDirectOriginalReadingRepair({ ...input, originalReadingHash: 'b'.repeat(64) })).toThrow('SCOPE_MISMATCH');
    expect(() => assembleDirectOriginalReadingRepair({ ...input, repair: { ...repair,
      results: [{ targetId: 'outside', action: 'unchanged', replacement: null }] } })).toThrow('TARGET_MISMATCH');
    expect(() => assembleDirectOriginalReadingRepair({ ...input, repair: { ...repair,
      results: [{ targetId: 'c-a', action: 'replace', replacement: { nodeType: 'page', value: original.pageReadings[0]! } }] } }))
      .toThrow('TYPE_MISMATCH');
    expect(() => assembleDirectOriginalReadingRepair({ ...input, repair: { ...repair,
      results: [{ targetId: 'c-a', action: 'replace', replacement: { nodeType: 'candidate',
        value: { ...original.extraction.candidates[0]!, localKey: 'new-key' } } }] } })).toThrow('KEY_MISMATCH');
  });
  it('unchanged不得夹带替换', () => {
    const original = fixture();
    expect(() => assembleDirectOriginalReadingRepair({ original, originalReadingHash: hash,
      allowedPageSourceSpanIds: ['page-a'], targets: [{ targetId: 'c-a', nodeType: 'candidate' }],
      repair: { schemaVersion: 1, documentId: original.documentId, originalReadingHash: hash,
        results: [{ targetId: 'c-a', action: 'unchanged', replacement: { nodeType: 'candidate', value: original.extraction.candidates[0]! } }] } }))
      .toThrow('UNEXPECTED_REPLACEMENT');
  });
  it('改引用来源必须同时授权全部非目标条件和候选', () => {
    const original = fixture();
    const contextOnly = structuredClone(original.extraction.candidates[0]!);
    contextOnly.localKey = 'c-b'; contextOnly.evidence = [{ sourceSpanId: 'e-b', quote: '其他原文' }];
    contextOnly.clinicalContext = { version: 1, status: 'complete', conditions: [{ sourceSpanId: 'e-a', quote: '<2.50E+02' }] };
    original.sourceExcerpts.push({ localKey: 'e-b', pageSourceSpanId: 'page-a', quote: '其他原文', role: 'finding', clarity: 'clear' });
    original.extraction.candidates.push(contextOnly);
    expect(() => assembleDirectOriginalReadingRepair({ original, originalReadingHash: hash,
      allowedPageSourceSpanIds: ['page-a'], targets: [{ targetId: 'e-a', nodeType: 'excerpt' }, { targetId: 'c-a', nodeType: 'candidate' }],
      repair: { schemaVersion: 1, documentId: original.documentId, originalReadingHash: hash,
        results: [{ targetId: 'e-a', action: 'replace', replacement: { nodeType: 'excerpt', value: original.sourceExcerpts[0]! } },
          { targetId: 'c-a', action: 'unchanged', replacement: null }] } })).toThrow('SHARED_EXCERPT_UNAUTHORIZED');
  });
  it('新excerpt不能指向报告之外的页面', () => {
    const original = fixture();
    expect(() => assembleDirectOriginalReadingRepair({ original, originalReadingHash: hash,
      allowedPageSourceSpanIds: ['page-a'], targets: [{ targetId: 'e-c', nodeType: 'excerpt' }],
      repair: { schemaVersion: 1, documentId: original.documentId, originalReadingHash: hash,
        results: [{ targetId: 'e-c', action: 'replace', replacement: { nodeType: 'excerpt',
          value: { localKey: 'e-c', pageSourceSpanId: 'outside-page', quote: '不在原件', role: 'finding', clarity: 'clear' } } }] } }))
      .toThrow('EXCERPT_SCOPE_MISMATCH');
  });
  it('缺失页面只能补回应用已准备的原页', () => {
    const original = fixture();
    const result = assembleDirectOriginalReadingRepair({ original, originalReadingHash: hash,
      allowedPageSourceSpanIds: ['page-a', 'page-b'], targets: [{ targetId: 'page-b', nodeType: 'page' }],
      repair: { schemaVersion: 1, documentId: original.documentId, originalReadingHash: hash,
        results: [{ targetId: 'page-b', action: 'replace', replacement: { nodeType: 'page',
          value: { sourceSpanId: 'page-b', status: 'no_medical_content' } } }] } });
    expect(result.pageReadings).toHaveLength(2);
    expect(result.extraction.coveredSourceSpanIds).toEqual(['page-a', 'page-b']);
    expect(result.extraction.candidates).toEqual(original.extraction.candidates);
  });
  it('修复结果不接受未声明私密字段', () => {
    expect(directOriginalReadingRepairSchema.safeParse({ schemaVersion: 1, documentId: 'doc',
      originalReadingHash: hash, results: [{ targetId: 'subject', action: 'unchanged', replacement: null }],
      localPath: '/synthetic/untrusted' }).success).toBe(false);
  });
  it('来源映射为可选独立输出，明确对应或不确定都不修改候选与来源', () => {
    const original = fixture(); const before = structuredClone(original);
    for (const relation of ['same_original_field', 'uncertain'] as const) {
      const repair = { schemaVersion: 1 as const, documentId: original.documentId, originalReadingHash: hash,
        results: [{ targetId: 'c-a', action: 'unchanged' as const, replacement: null }],
        sourceMappings: [{ candidateKey: 'c-a', comparisonRecordKey: 'ro_record_1', relation }] };
      expect(directOriginalReadingRepairSchema.parse(repair)).toEqual(repair);
      expect(assembleDirectOriginalReadingRepair({ original, repair, originalReadingHash: hash,
        targets: [{ targetId: 'c-a', nodeType: 'candidate' }], allowedPageSourceSpanIds: ['page-a'] })).toEqual(before);
    }
    expect(original).toEqual(before);
  });
  it.each(['candidate', 'comparison'] as const)('来源映射%s编号必须各自唯一，不确定记录也不能制造竞争', (kind) => {
    const mappings = [{ candidateKey: 'c-a', comparisonRecordKey: 'ro_record_1', relation: 'same_original_field' },
      { candidateKey: kind === 'candidate' ? 'c-a' : 'c-b', comparisonRecordKey: kind === 'comparison' ? 'ro_record_1' : 'ro_record_2',
        relation: 'uncertain' }];
    const result = directOriginalReadingRepairSchema.safeParse({ schemaVersion: 1, documentId: 'doc', originalReadingHash: hash,
      results: [{ targetId: 'subject', action: 'unchanged', replacement: null }], sourceMappings: mappings });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((issue) => issue.message === 'DIRECT_ORIGINAL_SOURCE_MAPPING_NOT_UNIQUE')).toBe(true);
  });
  it.each([
    { candidateKey: '', comparisonRecordKey: 'ro_record_1', relation: 'same_original_field' },
    { candidateKey: 'c-a', comparisonRecordKey: '', relation: 'same_original_field' },
    { candidateKey: 'c-a', comparisonRecordKey: 'ro_record_1', relation: 'replace_value' },
    { candidateKey: 'c-a', comparisonRecordKey: 'ro_record_1', relation: 'same_original_field', threadId: 'forged-thread' }
  ])('来源映射拒绝不完整、越权或模型自述凭据 %j', (mapping) => {
    expect(directOriginalReadingRepairSchema.safeParse({ schemaVersion: 1, documentId: 'doc', originalReadingHash: hash,
      results: [{ targetId: 'subject', action: 'unchanged', replacement: null }], sourceMappings: [mapping] }).success).toBe(false);
  });
});
