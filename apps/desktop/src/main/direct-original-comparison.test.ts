import { describe, expect, it } from 'vitest';
import type { DirectOriginalReadingResult, DirectOriginalRepairTarget, ObservationCandidate, SourceSpan } from '@contracts';
import type { DirectOriginalAdmissionComparisonRecord, DirectOriginalAdmissionPreview } from '@storage';
import { assertNoReadOnlyComparisonReferences, buildDirectOriginalRepairComparison,
  buildDirectOriginalRepairComparisonContext } from './direct-original-comparison.js';
import { decodeDirectOriginalInput, encodeDirectOriginalInput } from './direct-original-input.js';
import { assertDirectOriginalPromptBudget } from './direct-original-extraction.js';
import { buildDirectOriginalRepairPrompt } from './prompts/direct-original.js';

const source = (id = 'private-stored-span'): SourceSpan => ({ id, documentId: 'synthetic-document', spanKind: 'block',
  page: 2, blockId: 'private-block-id', lineStart: null, lineEnd: null, quote: '左侧未见异常；<2.50E＋02 U/L；未服药。',
  readability: 'clear', modelEvidence: { version: 1, engine: 'codex-original-reading-v1', modelId: 'gpt-6.1-sol',
    threadId: 'private-thread', turnId: 'private-turn', originalSha256: 'a'.repeat(64), originalSourceObjectId: 'synthetic-object',
    parentSourceSpanId: 'private-parent', inputKind: 'image', role: 'finding', clarity: 'clear' } });
const candidate = (localKey = 'private-old-local-key', sourceId = 'private-stored-span'): ObservationCandidate => ({
  localKey, originalName: '合成项目', standardNameCandidate: null,
  value: { kind: 'numeric', rawText: '<2.50E＋02', decimal: '250', comparator: 'lt' }, unitRaw: 'U/L',
  referenceRangeRaw: null, reportedAbnormalFlag: 'unknown', specimen: null, method: null, bodySite: '左侧', clinicalDate: null,
  evidence: [{ sourceSpanId: sourceId, quote: '<2.50E＋02 U/L' }], sourceBinding: {
    headingEvidence: [], findingEvidence: [{ sourceSpanId: sourceId, quote: '<2.50E＋02 U/L' }] },
  clinicalContext: { version: 1, status: 'complete', conditions: [{ sourceSpanId: sourceId, quote: '未服药。' }] }, issues: [] });
function fixture() {
  const reading: DirectOriginalReadingResult = { schemaVersion: 1, documentId: 'synthetic-document',
    pageReadings: [{ sourceSpanId: 'page_1', status: 'read' }], sourceExcerpts: [],
    extraction: { schemaVersion: 1, documentId: 'synthetic-document', subject: { reportedName: null, confidence: 'absent', evidence: [] },
      coveredSourceSpanIds: ['page_1'], candidates: [candidate('c_1', 'e_1')] } };
  const record: DirectOriginalAdmissionComparisonRecord = { recordId: 'private-observation-id', origin: 'stored_version',
    bindingStatus: 'resolved', candidate: candidate(), sourceSpans: [source()] };
  const preview: DirectOriginalAdmissionPreview = { mode: 'append', acceptedCount: 0, duplicateCount: 0, refinedCount: 0,
    reportReasonCodes: [], held: [{ candidate: candidate('c_1', 'e_1'), reasons: ['same_source_finding_semantic_conflict'],
      diagnostic: { kind: 'reconciliation', decision: 'conflict', changedFields: ['unit', 'clinicalDate'],
        comparisonScope: 'stored_version', comparisons: [record] } }] };
  return { reading, preview, record, input: { reading, preview, originalSha256: 'a'.repeat(64), sourceObjectId: 'synthetic-object',
    targets: [{ targetId: 'c_1', nodeType: 'candidate' }] as DirectOriginalRepairTarget[], mappedSourceIds: new Map([['e_1', 'current-permanent-span']]),
    reservedLocalKeys: ['page_1', 'c_1', 'e_1', 'metadata', 'subject', 'ro_record_1', 'ro_source_1'] } };
}

describe('真实对账差异的受控只读传输', () => {
  it('保留具体字段、旧值和完整限定，但不传永久编号、路径或运行收据', () => {
    const f = fixture(); const before = structuredClone(f.input);
    const context = buildDirectOriginalRepairComparisonContext(f.input);
    expect(context.reconciliationDiagnostics).toEqual([{ targetId: 'c_1', nodeType: 'candidate', kind: 'reconciliation',
      comparisonScope: 'stored_version', decision: 'conflict', changedFields: ['unit', 'clinicalDate'],
      reasonCodes: ['same_source_finding_semantic_conflict'], comparisonRefs: ['ro_record_2'] }]);
    const stored = context.comparisonRecords[0]!;
    expect(stored).toMatchObject({ localKey: 'ro_record_2', access: 'immutable_non_target', origin: 'stored_version',
      bindingStatus: 'resolved', value: { value: f.record.candidate.value, bodySite: '左侧',
        evidence: [{ sourceSpanId: 'ro_source_2', quote: '<2.50E＋02 U/L' }],
        clinicalContext: { conditions: [{ sourceSpanId: 'ro_source_2', quote: '未服药。' }] } } });
    expect(context.comparisonSourceExcerpts).toEqual([{ localKey: 'ro_source_2', page: 2, quote: source().quote,
      role: 'finding', clarity: 'clear' }]);
    const text = JSON.stringify(context);
    for (const secret of ['private-observation-id', 'private-stored-span', 'private-old-local-key', 'private-thread',
      'private-turn', 'private-block-id', 'private-parent']) expect(text).not.toContain(secret);
    expect(decodeDirectOriginalInput('READ_ONLY_PAGE_CONTEXT', encodeDirectOriginalInput('READ_ONLY_PAGE_CONTEXT', context))).toEqual(context);
    expect(f.input).toEqual(before);
  });

  it('同轮记录明确标为current_reading，共同来源全局只传一次，不为每个项目复制原句', () => {
    const f = fixture();
    f.record.origin = 'current_reading'; f.record.bindingStatus = 'unresolved';
    f.preview.held[0]!.diagnostic!.comparisonScope = 'current_reading';
    f.preview.held[0]!.diagnostic!.comparisons.push({ ...f.record, recordId: 'private-second-record',
      candidate: candidate('second-key') });
    const context = buildDirectOriginalRepairComparisonContext(f.input);
    expect(context.comparisonRecords).toHaveLength(2);
    expect(context.comparisonSourceExcerpts).toHaveLength(1);
    expect(context.comparisonRecords.every((record) => record.origin === 'current_reading'
      && record.bindingStatus === 'unresolved')).toBe(true);
    expect(context.comparisonRecords[0]!.sourceExcerpts).toEqual(context.comparisonRecords[1]!.sourceExcerpts);
    expect(JSON.stringify(context).split(source().quote!).length - 1).toBe(1);
  });

  it('旧行修订能力仅留在本机，只有同原件、已解析、目标范围内且有真实行版本的旧记录可生成', () => {
    const f = fixture(); f.record.recordRevision = 3; f.record.recordHash = 'c'.repeat(64);
    const built = buildDirectOriginalRepairComparison(f.input);
    expect(built.refinementTargets).toEqual([{ comparisonRecordKey: 'ro_record_2', candidateKey: 'c_1',
      recordId: f.record.recordId, recordRevision: 3, recordHash: 'c'.repeat(64) }]);
    for (const secret of [f.record.recordId, 'recordRevision', 'recordHash', 'c'.repeat(64)]) {
      expect(JSON.stringify(built.context)).not.toContain(secret);
    }
    f.record.bindingStatus = 'unresolved'; expect(buildDirectOriginalRepairComparison(f.input).refinementTargets).toEqual([]);
    f.record.bindingStatus = 'resolved'; f.record.origin = 'current_reading';
    expect(buildDirectOriginalRepairComparison(f.input).refinementTargets).toEqual([]);
    f.record.origin = 'stored_version'; f.record.recordRevision = 0;
    expect(buildDirectOriginalRepairComparison(f.input).refinementTargets).toEqual([]);
    f.record.recordRevision = 3; f.record.recordHash = 'not-a-row-hash';
    expect(buildDirectOriginalRepairComparison(f.input).refinementTargets).toEqual([]);
    f.record.recordHash = 'c'.repeat(64); f.input.targets = [];
    expect(buildDirectOriginalRepairComparison(f.input).refinementTargets).toEqual([]);
  });

  it('sourceMappings只允许该目标实际旧记录的专用槽，不能成为来源、目标或嵌套权限', () => {
    const f = fixture(); const context = buildDirectOriginalRepairComparisonContext(f.input);
    const mapping = { candidateKey: 'c_1', comparisonRecordKey: 'ro_record_2', relation: 'same_original_field' };
    expect(() => assertNoReadOnlyComparisonReferences({ sourceMappings: [mapping] }, context)).not.toThrow();
    for (const invalid of [
      { sourceMappings: [{ ...mapping, candidateKey: 'not-a-target' }] },
      { sourceMappings: [{ ...mapping, comparisonRecordKey: 'ro_source_2' }] },
      { sourceMappings: [{ ...mapping, comparisonRecordKey: 'ro_record_999' }] },
      { results: [{ sourceMappings: [mapping] }] },
      { comparisonRecordKey: mapping.comparisonRecordKey },
      { sourceMappings: [mapping], results: [{ targetId: mapping.comparisonRecordKey }] },
      { sourceMappings: [mapping], evidence: [{ sourceSpanId: mapping.comparisonRecordKey }] }
    ]) expect(() => assertNoReadOnlyComparisonReferences(invalid, context)).toThrow('DIRECT_ORIGINAL_READ_ONLY_COMPARISON_REFERENCE');
    context.comparisonRecords[0]!.origin = 'current_reading';
    expect(() => assertNoReadOnlyComparisonReferences({ sourceMappings: [mapping] }, context))
      .toThrow('DIRECT_ORIGINAL_READ_ONLY_COMPARISON_REFERENCE');
  });

  it.each(['document', 'hash', 'object', 'missing'] as const)('对照来源%s不在当前原件证明内时不发送候选正文', (change) => {
    const f = fixture(); const span = f.record.sourceSpans[0]!;
    if (change === 'document') span.documentId = 'other-private-document';
    if (change === 'hash') span.modelEvidence!.originalSha256 = 'b'.repeat(64);
    if (change === 'object') span.modelEvidence!.originalSourceObjectId = 'other-source-object';
    if (change === 'missing') f.record.sourceSpans = [];
    const context = buildDirectOriginalRepairComparisonContext(f.input);
    expect(context.comparisonRecords).toEqual([]);
    expect(context.comparisonSourceExcerpts).toEqual([]);
    expect(context.reconciliationDiagnostics[0]!.comparisonRefs).toEqual([]);
    expect(context.reconciliationDiagnostics[0]!.reasonCodes).toContain('comparison_source_unavailable');
    expect(JSON.stringify(context)).not.toContain('未服药');
  });

  it('引用缺失就保留不可用短编号，不编造来源文字或把unresolved说成唯一匹配', () => {
    const f = fixture(); f.record.bindingStatus = 'unresolved';
    f.record.candidate.clinicalContext!.conditions.push({ sourceSpanId: 'private-missing', quote: '未知条件原记录' });
    const context = buildDirectOriginalRepairComparisonContext(f.input);
    expect(context.comparisonRecords[0]!.bindingStatus).toBe('unresolved');
    expect(context.comparisonRecords[0]!.unavailableSourceRefs).toHaveLength(1);
    expect(context.comparisonSourceExcerpts).toHaveLength(1);
    expect(JSON.stringify(context)).not.toContain('private-missing');
  });

  it('同码日期冲突保留producer真实scope与角色，不带入共享事件其他文件', () => {
    const f = fixture(); f.input.targets.push({ targetId: 'metadata', nodeType: 'metadata' });
    const times = [{ value: '2026-01-02', role: 'examined' as const, precision: 'day' as const,
      evidence: [{ sourceSpanId: 'current-permanent-span', quote: '检查日期：2026-01-02' }] }];
    f.preview.reportDiagnostics = ['current_reading', 'stored_version', 'shared_event'].map((scope) => ({
      scope: scope as 'current_reading' | 'stored_version' | 'shared_event', reasonCodes: ['report_metadata_date_conflict'],
      current: times, sourceSpans: [], comparisons: scope === 'current_reading' ? [] : [{ origin: scope === 'shared_event'
        ? 'shared_event' as const : 'stored_version' as const, reportId: 'private-report-id',
        sourceDocumentId: f.reading.documentId, sourceSha256: f.input.originalSha256,
        times: [{ ...times[0]!, role: 'report_issued', evidence: [{ sourceSpanId: source().id, quote: '签发日期：2026-01-02' }] }],
        sourceSpans: [source()], clinicalDate: null, reportDate: '2026-01-02' }] }));
    const context = buildDirectOriginalRepairComparisonContext(f.input);
    const dates = context.reconciliationDiagnostics.filter((diagnostic) => diagnostic.kind === 'report_date');
    expect(dates.map((diagnostic) => diagnostic.comparisonScope)).toEqual(['current_reading', 'stored_version', 'shared_event']);
    expect(dates.every((diagnostic) => diagnostic.times![0]!.evidence[0]!.sourceSpanId === 'e_1')).toBe(true);
    expect(dates[0]!.comparisonRefs).toEqual([]);
    expect(dates[1]!.comparisonRefs).toHaveLength(1);
    expect(dates[2]!.comparisonRefs).toEqual([]);
    expect(context.comparisonRecords.filter((record) => record.nodeType === 'metadata')).toHaveLength(1);
    expect(JSON.stringify(context)).not.toContain('private-report-id');
  });

  it('无目标对账或无真实preview时，不展开全成员/非目标旧记录', () => {
    const f = fixture();
    for (const input of [{ ...f.input, preview: null }, { ...f.input, targets: [] }]) {
      const context = buildDirectOriginalRepairComparisonContext(input);
      expect(context.reconciliationDiagnostics).toEqual([]);
      expect(context.comparisonRecords).toEqual([]);
      expect(context.comparisonSourceExcerpts).toEqual([]);
    }
  });

  it('只读编号不能成为目标、来源或新增节点；同一句正文中的字符不被脚本改写', () => {
    const context = buildDirectOriginalRepairComparisonContext(fixture().input);
    const record = context.comparisonRecords[0]!.localKey;
    const sourceId = context.comparisonSourceExcerpts[0]!.localKey;
    for (const key of ['targetId', 'localKey', 'sourceSpanId', 'pageSourceSpanId']) {
      for (const id of [record, sourceId, 'ro_source_99999', 'ro_forged']) expect(() => assertNoReadOnlyComparisonReferences({ results: [{ value: { [key]: id } }] }, context))
        .toThrow('DIRECT_ORIGINAL_READ_ONLY_COMPARISON_REFERENCE');
    }
    expect(() => assertNoReadOnlyComparisonReferences({ targetId: 'ro_record_1' }, context)).not.toThrow();
    expect(() => assertNoReadOnlyComparisonReferences({ quote: `原报告文字包含${sourceId}并不构成引用`, targetId: 'c_1' }, context)).not.toThrow();
  });

  it('完整只读对照也计入最终256KiB预算，不截断引用或抽样来适配', () => {
    const f = fixture(); const fullQuote = `起始否定条件：未见；${'合成完整必要上下文。'.repeat(15_000)}末尾条件：左侧、未服药、<2.50E＋02。`;
    f.record.sourceSpans[0]!.quote = fullQuote;
    const context = buildDirectOriginalRepairComparisonContext(f.input);
    const prompt = buildDirectOriginalRepairPrompt({ documentId: f.reading.documentId, targets: f.input.targets },
      { completeOriginal: true, nativeText: '完整原文件自身文字' }, [], context);
    const line = prompt.split('\n').find((line) => line.startsWith('READ_ONLY_PAGE_CONTEXT='))!;
    expect(decodeDirectOriginalInput('READ_ONLY_PAGE_CONTEXT', JSON.parse(line.slice('READ_ONLY_PAGE_CONTEXT='.length)))).toEqual(context);
    expect(context.comparisonSourceExcerpts[0]!.quote).toBe(fullQuote);
    expect(() => assertDirectOriginalPromptBudget(prompt)).toThrow('DIRECT_ORIGINAL_CONTEXT_LIMIT_EXCEEDED');
  });
});
