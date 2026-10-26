import { describe, expect, it } from 'vitest';
import type { DirectOriginalReadingResult, DirectOriginalRepairTarget, ObservationCandidate } from '@contracts';
import { directOriginalRepairDependencyGroups, planDirectOriginalRepairPartitions, sliceDirectOriginalRepairPartition,
  type DirectOriginalRepairReadOnlyContext, type RepairPartitionRequest } from './direct-original-repair-partitions.js';

function fixture() {
  const candidates: ObservationCandidate[] = [1, 2, 3].map((index) => ({ localKey: `c${index}`,
    originalName: `合成项目${index}`, standardNameCandidate: null,
    value: { kind: 'numeric', rawText: '<2.50E＋02', decimal: '250', comparator: 'lt' }, unitRaw: 'U/L',
    referenceRangeRaw: null, reportedAbnormalFlag: null, specimen: null, method: null, bodySite: null,
    clinicalDate: null, clinicalContext: { version: 1, status: 'complete', conditions: [{ sourceSpanId: 'condition', quote: '未散瞳' }] },
    evidence: [{ sourceSpanId: `e${index}`, quote: null }, { sourceSpanId: 'date', quote: '检查日期 2026-01-02' }],
    sourceBinding: { headingEvidence: [], findingEvidence: [{ sourceSpanId: `e${index}`, quote: null }] }, issues: [] }));
  const reading: DirectOriginalReadingResult = { schemaVersion: 1, documentId: 'synthetic',
    pageReadings: [1, 2, 3].map((index) => ({ sourceSpanId: `p${index}`, status: 'read' })),
    sourceExcerpts: [...[1, 2, 3].map((index) => ({ localKey: `e${index}`, pageSourceSpanId: `p${index}`,
      quote: `合成项目${index} <2.50E＋02 U/L`, role: 'finding' as const, clarity: 'clear' as const })),
    { localKey: 'date', pageSourceSpanId: 'p1', quote: '检查日期 2026-01-02', role: 'date', clarity: 'clear' },
    { localKey: 'condition', pageSourceSpanId: 'p1', quote: '未散瞳', role: 'context', clarity: 'clear' }],
    extraction: { schemaVersion: 1, documentId: 'synthetic', subject: { reportedName: null, confidence: 'absent', evidence: [] },
      coveredSourceSpanIds: ['p1', 'p2', 'p3'], candidates, reportMetadata: null } };
  const targets: DirectOriginalRepairTarget[] = candidates.map((candidate) => ({ targetId: candidate.localKey, nodeType: 'candidate' }));
  const request: RepairPartitionRequest = { schemaVersion: 1, documentId: 'synthetic', originalReadingHash: 'a'.repeat(64),
    targets, issues: ['synthetic'], validationDiagnostics: [], allowedPageSourceSpanIds: ['p1', 'p2', 'p3'] };
  const context: DirectOriginalRepairReadOnlyContext = { schemaVersion: 1, targetPages: [],
    referencedExcerpts: reading.sourceExcerpts.map((value) => ({ localKey: value.localKey, access: 'immutable_non_target', value })),
    comparisonRecords: [], comparisonSourceExcerpts: [], reconciliationDiagnostics: [], reservedLocalKeys: ['p1', 'p2', 'p3', 'c1', 'c2', 'c3', 'e1', 'e2', 'e3', 'date', 'condition'] };
  return { reading, request, context };
}

describe('完整原件P03依赖安全分包', () => {
  it('补漏清单尚无候选的摘录也在只读闭包内，不因此授予片段改写权限', () => {
    const f = fixture();
    f.reading.sourceExcerpts.push({ localKey: 'missing-result', pageSourceSpanId: 'p1',
      quote: '合成待补项目 4 U/L', role: 'finding', clarity: 'clear' });
    f.reading.pageReadings[0]!.resultInventory = [{ sourceSpanId: 'missing-result', candidateKeys: [] }];
    const page: DirectOriginalRepairTarget = { targetId: 'p1', nodeType: 'page' };
    f.request.targets.push(page);
    const part = sliceDirectOriginalRepairPartition(f, [page]);
    expect(part.context.referencedExcerpts).toContainEqual({ localKey: 'missing-result', access: 'immutable_non_target',
      value: f.reading.sourceExcerpts.at(-1) });
    expect(part.targets).toEqual([page]);
    f.request.targets.push({ targetId: 'missing-result', nodeType: 'excerpt' });
    expect(directOriginalRepairDependencyGroups(f).some((group) =>
      group.some((target) => target.targetId === 'p1') && group.some((target) => target.targetId === 'missing-result'))).toBe(true);
  });
  it('可跨包复用只读日期与条件，保留完整原串、角色、引用和全局保留键', () => {
    const f = fixture(); const before = JSON.stringify(f);
    expect(directOriginalRepairDependencyGroups(f).map((group) => group.map((target) => target.targetId)))
      .toEqual([['c1'], ['c2'], ['c3']]);
    const part = sliceDirectOriginalRepairPartition(f, [f.request.targets[2]!]);
    expect(part.context.referencedExcerpts.map((item) => item.localKey)).toEqual(['e3', 'date', 'condition']);
    expect(part.targetItems[0]!.value).toEqual(f.reading.extraction.candidates[2]);
    expect(part.context.reservedLocalKeys).toEqual(f.context.reservedLocalKeys);
    expect(JSON.stringify(f)).toBe(before);
  });
  it('可变共享片段与全部引用者不可分割，超预算时不能截断或拆散', () => {
    const f = fixture(); f.request.targets.push({ targetId: 'date', nodeType: 'excerpt' });
    const groups = directOriginalRepairDependencyGroups(f);
    expect(groups).toHaveLength(1); expect(groups[0]).toHaveLength(4);
    expect(() => planDirectOriginalRepairPartitions({ ...f, maxBytes: 10,
      buildPrompt: (packet) => JSON.stringify(packet) })).toThrow('DIRECT_ORIGINAL_CONTEXT_LIMIT_EXCEEDED');
  });
  it('分包数量有限且targets恰好覆盖一次，每包包含自己的全部诊断和对照', () => {
    const f = fixture();
    f.request.validationDiagnostics = f.request.targets.map((target) => ({ targetId: target.targetId,
      nodeType: 'candidate', reasonCode: 'synthetic_failure', fieldPath: 'value.decimal', constraint: '合成完整约束' }));
    const buildPrompt = (packet: ReturnType<typeof sliceDirectOriginalRepairPartition>) => JSON.stringify(packet);
    const maximumSingle = Math.max(...f.request.targets.map((target) => Buffer.byteLength(buildPrompt(sliceDirectOriginalRepairPartition(f, [target])))));
    const parts = planDirectOriginalRepairPartitions({ ...f, maxBytes: maximumSingle, buildPrompt });
    expect(parts).toHaveLength(3);
    expect(parts.flatMap((part) => part.targets)).toEqual(f.request.targets);
    expect(parts.every((part) => part.request.validationDiagnostics.length === 1)).toBe(true);
    expect(parts.map((part) => JSON.stringify(part))).toEqual(planDirectOriginalRepairPartitions({ ...f,
      maxBytes: maximumSingle, buildPrompt }).map((part) => JSON.stringify(part)));
  });
  it('同旧记录的只读对照可以被不同包完整复用，不能因此连成超大可变依赖组', () => {
    const f = fixture();
    f.context.reconciliationDiagnostics = ['c1', 'c2'].map((targetId) => ({ targetId, nodeType: 'candidate', kind: 'reconciliation',
      comparisonScope: 'stored_version', decision: 'held', reasonCodes: ['synthetic'], changedFields: [], comparisonRefs: ['ro_record_1'] }));
    expect(directOriginalRepairDependencyGroups(f).map((group) => group.map((target) => target.targetId))).toEqual([['c1'], ['c2'], ['c3']]);
    expect(sliceDirectOriginalRepairPartition(f, [f.request.targets[0]!]).context.reconciliationDiagnostics).toHaveLength(1);
    expect(sliceDirectOriginalRepairPartition(f, [f.request.targets[1]!]).context.reconciliationDiagnostics).toHaveLength(1);
    expect(sliceDirectOriginalRepairPartition(f, [f.request.targets[2]!]).context.reconciliationDiagnostics).toEqual([]);
  });
});
