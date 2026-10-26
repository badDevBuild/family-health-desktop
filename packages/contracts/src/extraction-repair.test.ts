import { describe, expect, it } from 'vitest';
import type { ExtractionResult, ObservationCandidate } from './index.js';
import { assembleExtractionRepair, extractionRepairSchema, type ExtractionRepairScope, type ExtractionRepairV1 } from './extraction-repair.js';

function fixture() {
  const candidate = (localKey: string, decimal: string, source = 'result-page'): ObservationCandidate => ({
    localKey, originalName: '合成检验甲', standardNameCandidate: null,
    value: { kind: 'numeric', rawText: decimal, decimal, comparator: 'lt' },
    unitRaw: 'U/L', referenceRangeRaw: null, reportedAbnormalFlag: null,
    specimen: null, method: null, bodySite: null, clinicalDate: null,
    evidence: [{ sourceSpanId: source, quote: `合成检验甲 <${decimal} U/L` }], issues: []
  });
  const original: ExtractionResult = { schemaVersion: 1, documentId: 'synthetic-document',
    subject: { reportedName: null, evidence: [], confidence: 'absent' },
    coveredSourceSpanIds: ['result-page'], candidates: [candidate('target', '999'), candidate('keep', '7')] };
  const scope: ExtractionRepairScope = { documentId: original.documentId, originalCandidateHash: 'a'.repeat(64),
    targets: [{ nodeType: 'candidate', targetId: 'target', localKey: 'target' }],
    allowedSourceSpanIds: ['result-page', 'context-page'], targetSourceSpanIds: ['result-page'] };
  const patch = (replacement = candidate('target', '9')): ExtractionRepairV1 => ({ schemaVersion: 1,
    documentId: original.documentId, originalCandidateHash: scope.originalCandidateHash,
    results: [{ nodeType: 'candidate', targetId: 'target', decision: { verdict: 'replace', replacement, reason: '依据原行修正' } }] });
  return { candidate, original, scope, patch };
}

describe('提取目标补丁契约', () => {
  it('只替换授权localKey，非目标对象保持原样，原候选不被修改', () => {
    const f = fixture();
    const before = JSON.stringify(f.original);
    const result = assembleExtractionRepair(f.original, f.scope, f.patch());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.candidates[0]!.value.rawText).toBe('9');
    expect(result.result.candidates[0]!.value).toMatchObject({ comparator: 'lt' });
    expect(result.result.candidates[1]).toBe(f.original.candidates[1]);
    expect(result.result.subject).toBe(f.original.subject);
    expect(JSON.stringify(f.original)).toBe(before);
  });
  it.each(['wrong_document', 'hash_drift', 'missing_target', 'extra_target', 'duplicate_target', 'rename_key', 'change_type', 'outside_source'])('%s 不允许拼装发布', (failure) => {
    const f = fixture();
    const p = f.patch();
    if (failure === 'wrong_document') p.documentId = 'other-document';
    if (failure === 'hash_drift') p.originalCandidateHash = 'b'.repeat(64);
    if (failure === 'missing_target') p.results = [];
    if (failure === 'extra_target') p.results.push({ ...p.results[0]!, targetId: 'keep' });
    if (failure === 'duplicate_target') p.results.push(p.results[0]!);
    if (failure === 'rename_key') p.results = f.patch(f.candidate('new-key', '9')).results;
    if (failure === 'change_type') p.results = [{ nodeType: 'source_coverage', targetId: 'target',
      decision: { verdict: 'replace', replacement: { covered: true, candidates: [] }, reason: '非法换型' } }];
    if (failure === 'outside_source') p.results = f.patch(f.candidate('target', '9', 'other-file')).results;
    expect(assembleExtractionRepair(f.original, f.scope, p).ok).toBe(false);
  });
  it('unchanged必须明确原因且replacement=null，不能用空目标冒充完成', () => {
    const f = fixture();
    const p: ExtractionRepairV1 = { ...f.patch(), results: [{ nodeType: 'candidate', targetId: 'target',
      decision: { verdict: 'unchanged', replacement: null, reason: '原图仍无法可靠对应' } }] };
    expect(extractionRepairSchema.safeParse(p).success).toBe(true);
    expect(extractionRepairSchema.safeParse({ ...p, results: [{ ...p.results[0], decision: { verdict: 'unchanged', replacement: null, reason: '' } }] }).success).toBe(false);
    const assembled = assembleExtractionRepair(f.original, f.scope, p);
    expect(assembled.ok && assembled.result.candidates).toEqual(f.original.candidates);
  });
  it('拒绝整块提取格式以及subject/其他字段混入补丁', () => {
    const f = fixture();
    expect(extractionRepairSchema.safeParse(f.original).success).toBe(false);
    expect(extractionRepairSchema.safeParse({ ...f.patch(), subject: f.original.subject }).success).toBe(false);
  });
  it('允许缺覆盖来源内新增项，不允许从上下文补入无关结果或覆盖既有项', () => {
    const f = fixture();
    const scope = { ...f.scope, targets: [{ nodeType: 'source_coverage' as const, targetId: 'coverage:missing', sourceSpanId: 'missing' }],
      allowedSourceSpanIds: ['result-page', 'missing', 'context-page'], targetSourceSpanIds: ['result-page', 'missing'] };
    const patch: ExtractionRepairV1 = { ...f.patch(), results: [{ nodeType: 'source_coverage', targetId: 'coverage:missing',
      decision: { verdict: 'replace', replacement: { covered: true, candidates: [f.candidate('new', '4', 'missing')] }, reason: '补原页漏项' } }] };
    const assembled = assembleExtractionRepair(f.original, scope, patch);
    expect(assembled.ok && assembled.result.candidates.length).toBe(3);
    if (patch.results[0]!.nodeType !== 'source_coverage' || patch.results[0]!.decision.verdict !== 'replace') return;
    patch.results[0]!.decision.replacement.candidates = [f.candidate('new', '4', 'context-page')];
    expect(assembleExtractionRepair(f.original, scope, patch).ok).toBe(false);
    patch.results[0]!.decision.replacement.candidates = [f.candidate('keep', '4', 'missing')];
    expect(assembleExtractionRepair(f.original, scope, patch).ok).toBe(false);
  });
  it('跨页日期和条件引用可保留，但不能借上下文替换成另一页结果', () => {
    const f = fixture();
    const candidate = f.candidate('target', '9');
    candidate.evidence.push({ sourceSpanId: 'context-page', quote: '检查日期：2026-01-02' });
    candidate.sourceBinding = { headingEvidence: [{ sourceSpanId: 'context-page', quote: '合成检验栏目' }], findingEvidence: [candidate.evidence[0]!] };
    expect(assembleExtractionRepair(f.original, f.scope, f.patch(candidate)).ok).toBe(true);
    candidate.sourceBinding.findingEvidence = [{ sourceSpanId: 'context-page', quote: '其他检验 <9 U/L' }];
    expect(assembleExtractionRepair(f.original, f.scope, f.patch(candidate)).ok).toBe(false);
  });
});
