import { describe, expect, it } from 'vitest';
import type { ObservationCandidate, ReportMetadataCandidate, SourceManifest, SourceSpan } from '@contracts';
import { evaluateObservationCandidate, resolveReportSourceBinding } from '@core';
import { provenReportMetadata, reportMetadataTimeFailures } from './processing-pipeline.js';

function fixture() {
  const rows: NonNullable<SourceSpan['visualEvidence']>['rows'] = [
    { line: 1, text: '检查日期：2026-04-27', bounds: [0.1, 0.82, 0.6, 0.04],
      boxes: [{ text: '检查日期：2026-04-27', confidence: 0.99, bounds: [0.1, 0.82, 0.6, 0.04] }] },
    { line: 2, text: '合成检查 未见异常', bounds: [0.1, 0.64, 0.6, 0.04],
      boxes: [{ text: '合成检查 未见异常', confidence: 0.99, bounds: [0.1, 0.64, 0.6, 0.04] }] },
    { line: 3, text: '合成边角 文字不清', bounds: [0.1, 0.21, 0.6, 0.04],
      boxes: [{ text: '合成边角 文字不清', confidence: 0.94, bounds: [0.1, 0.21, 0.6, 0.04] }] }
  ];
  const span: SourceSpan = { id: 'synthetic-partial-span', documentId: 'synthetic-document', spanKind: 'page',
    page: 1, blockId: null, lineStart: null, lineEnd: null, quote: rows.map((row) => row.text).join('\n'), readability: 'partial',
    visualEvidence: { version: 1, engine: 'apple-vision-local-v1', layoutVersion: 'local-visual-layout-v2',
      coordinateSystem: 'normalized-bottom-left', reading: { mode: 'full_image', fallbackUsed: false }, rows,
      omittedBoxes: [{ text: '不清晰片段', confidence: 0.1, bounds: [0.72, 0.21, 0.1, 0.04] }] } };
  const metadata: ReportMetadataCandidate = { reportKind: null, title: null, organization: null, campus: null,
    department: null, reportNumber: null, examItems: [], times: [{ value: '2026-04-27', precision: 'day', role: 'examined',
      evidence: [{ sourceSpanId: span.id, quote: rows[0]!.text }] }] };
  const candidate: ObservationCandidate = { localKey: 'synthetic-finding', originalName: '合成检查', standardNameCandidate: null,
    value: { kind: 'text', rawText: '未见异常' }, unitRaw: null, referenceRangeRaw: null, reportedAbnormalFlag: null,
    specimen: null, method: null, bodySite: null, clinicalDate: '2026-04-27', issues: [],
    evidence: [{ sourceSpanId: span.id, quote: rows[1]!.text }, { sourceSpanId: span.id, quote: rows[0]!.text }],
    sourceBinding: { headingEvidence: [{ sourceSpanId: span.id, quote: '合成检查' }],
      findingEvidence: [{ sourceSpanId: span.id, quote: rows[1]!.text }] } };
  const manifest: SourceManifest = { id: 'synthetic-manifest', sourceObjectId: 'synthetic-source', sha256: 'a'.repeat(64),
    mediaType: 'application/pdf', originalDisplayName: '合成报告.pdf', totalUnits: 1, coveredUnitIndexes: [0],
    normalizerVersion: 'synthetic-visual-geometry', spans: [span], conversionWarnings: [], createdAt: '2026-01-01T00:00:00Z' };
  return { span, metadata, candidate, manifest };
}

describe('部分视觉来源的精确元数据日期依据', () => {
  it('低置信遗漏在其他独立行时，可靠日期与发现均可通过且页本身仍为partial', () => {
    const { span, metadata, candidate, manifest } = fixture();
    expect(reportMetadataTimeFailures(metadata, [span])).toEqual([]);
    expect(provenReportMetadata(metadata, [span])?.times).toEqual(metadata.times);
    expect(evaluateObservationCandidate(candidate, manifest, { personConsistent: true, overwritesUserLockedValue: false }))
      .toMatchObject({ decision: 'accept_with_warnings' });
    expect(resolveReportSourceBinding(candidate, manifest).status).toBe('resolved');
    expect(span.readability).toBe('partial');
  });

  it.each(['omitted_on_date_row', 'no_geometry', 'whole_partial_page', 'repeated_quote'])(
    '有疑点的日期引用不能被元数据补证：%s', (variant) => {
      const { span, metadata } = fixture();
      if (variant === 'omitted_on_date_row') span.visualEvidence!.omittedBoxes[0]!.bounds = [0.72, 0.82, 0.1, 0.04];
      if (variant === 'no_geometry') delete span.visualEvidence;
      if (variant === 'whole_partial_page') metadata.times[0]!.evidence[0]!.quote = span.quote;
      if (variant === 'repeated_quote') {
        span.visualEvidence!.rows[2]!.text = span.visualEvidence!.rows[0]!.text;
        span.quote = span.visualEvidence!.rows.map((row) => row.text).join('\n');
      }
      expect(reportMetadataTimeFailures(metadata, [span])).toEqual([{ index: 0, sourceSpanIds: [span.id],
        reasons: ['metadata_date_evidence_not_proven'] }]);
      expect(provenReportMetadata(metadata, [span])?.times).toEqual([]);
    }
  );

  it('精确可靠行不放松日期角色：签发与出生日期仍不能变成检查日', () => {
    for (const label of ['报告日期', '出生日期']) {
      const { span, metadata } = fixture();
      const text = `${label}：2026-04-27`;
      span.visualEvidence!.rows[0]!.text = text;
      span.visualEvidence!.rows[0]!.boxes[0]!.text = text;
      span.quote = span.visualEvidence!.rows.map((row) => row.text).join('\n');
      metadata.times[0]!.evidence[0]!.quote = text;
      expect(reportMetadataTimeFailures(metadata, [span])).toEqual([{ index: 0, sourceSpanIds: [span.id],
        reasons: ['metadata_date_role_mismatch'] }]);
      expect(provenReportMetadata(metadata, [span])?.times).toEqual([]);
    }
  });

  it('可定位日期行也不能证明另一个日期值，或授权范围外的来源', () => {
    const { span, metadata } = fixture();
    metadata.times[0]!.value = '2026-04-28';
    expect(reportMetadataTimeFailures(metadata, [span])[0]?.reasons).toEqual(['metadata_date_not_in_evidence']);
    metadata.times[0]!.value = '2026-04-27';
    metadata.times[0]!.evidence[0]!.sourceSpanId = 'synthetic-other-span';
    expect(reportMetadataTimeFailures(metadata, [span])[0]?.reasons).toEqual(['metadata_date_evidence_not_proven']);
  });
});
