import { describe, expect, it } from 'vitest';
import type { DirectOriginalReadingResult, ObservationCandidate } from '@contracts';
import { inspectDirectOriginalCoverage } from './direct-original-coverage.js';

function fixture(): DirectOriginalReadingResult {
  const candidate: ObservationCandidate = { localKey: 'candidate-a', originalName: '合成项目', standardNameCandidate: null,
    value: { kind: 'text', rawText: '合成记录' }, unitRaw: null, referenceRangeRaw: null, reportedAbnormalFlag: null,
    specimen: null, method: null, bodySite: null, clinicalDate: null, evidence: [{ sourceSpanId: 'result-a', quote: null }], issues: [] };
  return { schemaVersion: 1, documentId: 'synthetic-document', pageReadings: [{ sourceSpanId: 'page-a', status: 'read',
    resultInventory: [{ sourceSpanId: 'result-a', candidateKeys: ['candidate-a'] }] }],
  sourceExcerpts: [{ localKey: 'result-a', pageSourceSpanId: 'page-a', quote: '合成项目：合成记录', role: 'finding', clarity: 'clear' }],
  extraction: { schemaVersion: 1, documentId: 'synthetic-document', subject: { reportedName: null, confidence: 'absent', evidence: [] },
    coveredSourceSpanIds: ['page-a'], candidates: [candidate] } };
}
describe('原页结果盘点与候选对账', () => {
  it('完整盘点保持不变，不生成或更改检查结果', () => {
    const reading = fixture(); const before = structuredClone(reading);
    expect(inspectDirectOriginalCoverage(reading)).toEqual({ issues: [], pageIds: [], classifiedSourceKeys: new Set() });
    expect(reading).toEqual(before);
  });
  it.each(['missing', 'empty', 'no-candidate', 'unrelated-candidate', 'foreign-page', 'title', 'duplicate'] as const)(
    '%s 不能用页面已读或别的结果代替完整性', (kind) => {
      const reading = fixture(); const page = reading.pageReadings[0]!;
      if (kind === 'missing') delete page.resultInventory;
      if (kind === 'empty') page.resultInventory = [];
      if (kind === 'no-candidate') page.resultInventory![0]!.candidateKeys = [];
      if (kind === 'unrelated-candidate') reading.extraction.candidates[0]!.evidence = [{ sourceSpanId: 'other-result', quote: null }];
      if (kind === 'foreign-page') reading.sourceExcerpts[0]!.pageSourceSpanId = 'page-b';
      if (kind === 'title') reading.sourceExcerpts[0]!.role = 'heading';
      if (kind === 'duplicate') page.resultInventory!.push(structuredClone(page.resultInventory![0]!));
      expect(inspectDirectOriginalCoverage(reading).pageIds).toEqual(['page-a']);
    });
  it('另一个已读页面遗漏结果清单，即使前页有候选也要检查', () => {
    const reading = fixture(); reading.pageReadings.push({ sourceSpanId: 'page-b', status: 'read' });
    expect(inspectDirectOriginalCoverage(reading).pageIds).toEqual(['page-b']);
    reading.pageReadings[1] = { sourceSpanId: 'page-b', status: 'no_medical_content', resultInventory: [] };
    expect(inspectDirectOriginalCoverage(reading).issues).toEqual([]);
  });
  it('科普和参考说明保留逐项原文与角色依据，不生成实测候选', () => {
    const reading = fixture();
    reading.pageReadings.push({ sourceSpanId: 'page-b', status: 'no_medical_content', pageRole: 'education', resultInventory: [
      { sourceSpanId: 'education-a', candidateKeys: [], classification: { disposition: 'education',
        evidence: [{ sourceSpanId: 'education-title', quote: '合成科普说明' }], duplicateSourceSpanId: null } }
    ] });
    reading.sourceExcerpts.push({ localKey: 'education-title', pageSourceSpanId: 'page-b', role: 'heading', clarity: 'clear', quote: '合成科普说明' },
      { localKey: 'education-a', pageSourceSpanId: 'page-b', role: 'context', clarity: 'clear', quote: '这是通用背景，不是个人检查' });
    expect(inspectDirectOriginalCoverage(reading)).toMatchObject({ issues: [], classifiedSourceKeys: new Set(['education-a']) });
    reading.sourceExcerpts.at(-1)!.role = 'finding';
    expect(inspectDirectOriginalCoverage(reading).issues).toContain('direct_original_inventory_classification_unproven');
  });
  it('重复摘要需真实逐字原文和另一原页的候选，不能按相近数字猜重复', () => {
    const reading = fixture();
    reading.pageReadings.push({ sourceSpanId: 'page-b', status: 'read', pageRole: 'duplicate_summary', resultInventory: [
      { sourceSpanId: 'repeat', candidateKeys: [], classification: { disposition: 'duplicate_summary',
        evidence: [{ sourceSpanId: 'repeat-title', quote: '检查摘要' },
          { sourceSpanId: 'context-a', quote: '合成同次检查背景：合成项目：合成记录' },
          { sourceSpanId: 'context-b', quote: '合成同次检查背景：合成项目：合成记录' }], duplicateSourceSpanId: 'result-a' } }
    ] });
    reading.sourceExcerpts.push({ localKey: 'context-a', pageSourceSpanId: 'page-a', role: 'context', clarity: 'clear', quote: '合成同次检查背景：合成项目：合成记录' },
      { localKey: 'context-b', pageSourceSpanId: 'page-b', role: 'context', clarity: 'clear', quote: '合成同次检查背景：合成项目：合成记录' },
      { localKey: 'repeat-title', pageSourceSpanId: 'page-b', role: 'heading', clarity: 'clear', quote: '检查摘要' },
      { ...reading.sourceExcerpts[0]!, localKey: 'repeat', pageSourceSpanId: 'page-b' });
    expect(inspectDirectOriginalCoverage(reading).classifiedSourceKeys.has('repeat')).toBe(true);
    reading.sourceExcerpts.find(item => item.localKey === 'context-b')!.quote = '另一次检查背景：合成项目：合成记录';
    expect(inspectDirectOriginalCoverage(reading).classifiedSourceKeys.size).toBe(0);
    reading.sourceExcerpts.find(item => item.localKey === 'context-b')!.quote = '合成同次检查背景：合成项目：合成记录';
    reading.sourceExcerpts.at(-1)!.quote += '不同条件';
    expect(inspectDirectOriginalCoverage(reading).classifiedSourceKeys.size).toBe(0);
    reading.pageReadings[0]!.resultInventory![0]!.classification = { disposition: 'reference',
      evidence: [{ sourceSpanId: 'repeat-title', quote: '检查摘要' }], duplicateSourceSpanId: null };
    expect(inspectDirectOriginalCoverage(reading).issues).toContain('direct_original_inventory_classification_unproven');
  });
});
