import { describe, expect, it } from 'vitest';
import { reportReadingAuditSchema, type ObservationCandidate } from '@contracts';
import { accountReportReading } from './report-reading-accounting.js';

const candidate = (localKey: string): ObservationCandidate => ({ localKey, originalName: '合成项目', standardNameCandidate: null,
  value: { kind: 'text', rawText: '合成内容' }, unitRaw: null, referenceRangeRaw: null, reportedAbnormalFlag: null,
  specimen: null, method: null, bodySite: null, clinicalDate: null, evidence: [], issues: [] });
const input = { candidates: ['saved', 'blank', 'held'].map(candidate), emptyCandidateKeys: ['blank'],
  failures: [{ localKey: 'held', reasons: ['synthetic_source_unresolved'] }], unrepresentedSourceCount: 1, pageGapCount: 1 };
describe('逐次读取完整性对账', () => {
  it('逐条保留空白、已保存和待处理的原始声明及来源，聚合相等不伪称原件全覆盖', () => {
    const detailed = structuredClone(input);
    detailed.candidates[1]!.value = { kind: 'unknown', rawText: null, reason: 'original_blank' };
    detailed.candidates.forEach(item => { item.evidence = [{ sourceSpanId: 'real-source', quote: `合成引用-${item.localKey}` }]; });
    const result = accountReportReading({ ...detailed, coverage: { version: 1, scope: 'full_report', originalSha256: 'a'.repeat(64),
      promptVersion: 'synthetic-prompt', rulesVersion: 'synthetic-rules',
      pages: [{ sourceSpanId: 'page-1', page: 1, status: 'partial', inventory: [
        { sourceKey: 'excerpt-key', sourceSpanId: 'real-source', candidateKeys: ['saved','blank','held'] }
      ] }], unrepresentedSources: [{ sourceSpanId: 'orphan-source', pageSourceSpanId: 'page-1', role: 'finding', clarity: 'clear' }],
      gapPageSourceSpanIds: ['page-1'] } }, ['saved'], []);
    expect(result.audit.ledger?.candidates).toMatchObject([
      { localKey: 'saved', disposition: 'saved_or_existing', evidence: [{ quote: '合成引用-saved' }] },
      { localKey: 'blank', disposition: 'original_no_result', value: { kind: 'unknown', reason: 'original_blank' } },
      { localKey: 'held', disposition: 'pending', reasonCodes: ['synthetic_source_unresolved'] }
    ]);
    expect(result.audit.ledger?.unrepresentedSources[0]?.sourceSpanId).toBe('orphan-source');
    expect(() => reportReadingAuditSchema.parse({ ...result.audit, emptyCandidates: 2 })).toThrow();
    expect(() => reportReadingAuditSchema.parse({ ...result.audit,
      ledger: { ...result.audit.ledger, candidates: result.audit.ledger!.candidates.slice(1) } })).toThrow();
  });
  it('历史只有聚合计数时明确没有逐项账本，不补造空白清单', () => {
    expect(accountReportReading(input,['saved'],[]).audit.ledger).toBeUndefined();
  });
  it('每个当前条目必须有去向，历史读取版本单独记账', () => {
    expect(accountReportReading(input, ['saved'], [], [candidate('old-a'), candidate('old-b'), candidate('held')]))
      .toMatchObject({ audit: { totalCandidates: 3, savedCandidates: 1, emptyCandidates: 1,
        pending: [{ localKey: 'held', reasonCodes: ['synthetic_source_unresolved'] }], historicalReadingCount: 2,
        unrepresentedSourceCount: 1 }, pendingCandidates: [candidate('held')] });
  });
  it('没有落库且没有失败原因的条目不能无声丢失', () => {
    const result = accountReportReading({ ...input, failures: [] }, ['saved'], []);
    expect(result.audit.pending[0]?.reasonCodes).toEqual(['reading_candidate_not_accounted']);
  });
  it.each(['unknown-admitted', 'unknown-empty', 'saved-and-empty', 'duplicate-key'])('拒绝%s的伪完整对账', (kind) => {
    const changed = structuredClone(input);
    if (kind === 'unknown-empty') changed.emptyCandidateKeys.push('outside');
    if (kind === 'saved-and-empty') changed.emptyCandidateKeys.push('saved');
    if (kind === 'duplicate-key') changed.candidates.push(candidate('saved'));
    expect(() => accountReportReading(changed, [kind === 'unknown-admitted' ? 'outside' : 'saved'], []))
      .toThrow('REPORT_READING_ACCOUNTING_SCOPE_INVALID');
  });
  it('同名同值但不同读取编号不能冒充已对应到同一原件字段', () => {
    const result = accountReportReading({ ...input, candidates: [candidate('a'), candidate('b')], emptyCandidateKeys: [] }, ['a'], []);
    expect(result.audit).toMatchObject({ savedCandidates: 1, pending: [{ localKey: 'b' }] });
  });
});
