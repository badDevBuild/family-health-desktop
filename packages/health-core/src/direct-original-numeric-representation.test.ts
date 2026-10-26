import { describe, expect, it } from 'vitest';
import type { ObservationCandidate, SourceManifest, SourceSpan } from '@contracts';
import { evaluateDirectOriginalObservationCandidate } from './direct-original-validation.js';

function fixture(rawText: string, decimal: string, comparator: 'eq' | 'lt' | 'lte' | 'gt' | 'gte', unitRaw: string | null) {
  const page: SourceSpan = { id: 'synthetic-page', documentId: 'synthetic-document', spanKind: 'page', page: 1,
    blockId: 'direct-original-page:1', lineStart: null, lineEnd: null, quote: null, readability: 'clear' };
  const finding: SourceSpan = { id: 'synthetic-finding', documentId: page.documentId, spanKind: 'block', page: 1,
    blockId: `model-original-excerpt:${page.id}`, lineStart: null, lineEnd: null,
    quote: `合成项目 ${rawText}`, readability: 'clear', modelEvidence: { version: 1,
      engine: 'codex-original-reading-v1', modelId: 'synthetic-model', threadId: 'synthetic-thread', turnId: 'synthetic-turn',
      originalSha256: 'a'.repeat(64), originalSourceObjectId: 'synthetic-object', parentSourceSpanId: page.id,
      inputKind: 'image', role: 'finding', clarity: 'clear' } };
  const ref = { sourceSpanId: finding.id, quote: finding.quote };
  const manifest: SourceManifest = { id: 'synthetic-manifest', sourceObjectId: 'synthetic-object', sha256: 'a'.repeat(64),
    mediaType: 'application/pdf', originalDisplayName: '合成原件.pdf', totalUnits: 1, coveredUnitIndexes: [0],
    spans: [page, finding], normalizerVersion: 'direct-original-v1', conversionWarnings: [], createdAt: '2026-01-01T00:00:00Z' };
  const candidate: ObservationCandidate = { localKey: 'synthetic-candidate', originalName: '合成项目', standardNameCandidate: null,
    value: { kind: 'numeric', rawText, decimal, comparator }, unitRaw, referenceRangeRaw: null,
    reportedAbnormalFlag: null, specimen: null, method: null, bodySite: null, clinicalDate: null,
    evidence: [ref], sourceBinding: { headingEvidence: [], findingEvidence: [ref] }, issues: [] };
  const options = { personConsistent: true, overwritesUserLockedValue: false };
  return { candidate, manifest, options };
}

function evaluate(rawText: string, decimal: string, comparator: 'eq' | 'lt' | 'lte' | 'gt' | 'gte', unitRaw: string | null) {
  const f = fixture(rawText, decimal, comparator, unitRaw);
  const before = structuredClone(f);
  const result = evaluateDirectOriginalObservationCandidate(f.candidate, f.manifest, f.options);
  expect(f).toEqual(before);
  return result;
}

describe('原件数值表示：仅隔离已明示完整单位，不改写原值', () => {
  it.each([
    ['7.40mmol/L', '7.4', 'eq', 'mmol/L'],
    ['7.40 mmol/L', '7.4', 'eq', 'mmol/L'],
    ['7.40\nmmol/L', '7.4', 'eq', 'mmol/L'],
    ['＜ 2.50E＋03 cm/s', '2500', 'lt', 'cm/s'],
    ['≥ 4.2 e -3mg/L', '0.0042', 'gte', 'mg/L'],
    ['－7.400 kg', '-7.4', 'eq', 'kg'],
    ['−7.400kg', '-7.4', 'eq', 'kg'],
    ['+7.40 kg', '7.4', 'eq', 'kg'],
    ['- 7.40 kg', '-7.4', 'eq', 'kg'],
    ['＋\n7.40', '7.4', 'eq', null],
    ['≤ −\t2.50E＋03', '-2500', 'lte', null],
    ['8%', '8', 'eq', '%'],
    ['8％', '8', 'eq', '%'],
    ['3.2‰', '3.2', 'eq', '‰'],
    ['36.8℃', '36.8', 'eq', '°C'],
    ['16.2次/分钟', '16.2', 'eq', '次/分钟'],
    ['2.3 万/微升', '2.3', 'eq', '万/微升'],
    ['7.4 10^9/L', '7.4', 'eq', '10^9/L'],
    ['7.4 1/L', '7.4', 'eq', '1/L'],
    ['7.4 mm Hg', '7.4', 'eq', 'mm Hg'],
    ['7.4mol×s/L', '7.4', 'eq', 'mol×s/L'],
    ['7.4kg·m/s^2', '7.4', 'eq', 'kg·m/s^2'],
    ['7.4kg⋅m/s²', '7.4', 'eq', 'kg⋅m/s²'],
    ['7.4 10×L', '7.4', 'eq', '10×L'],
    ['7.4mm[Hg]', '7.4', 'eq', 'mm[Hg]'],
    ['0.0000000000000000000025mg/L', '0.0000000000000000000025', 'eq', 'mg/L'],
    ['900719925474099312345.50U/L', '900719925474099312345.5', 'eq', 'U/L']
  ] as const)('完整尾缀 %s 可核验但原值原封保留', (raw, decimal, comparator, unit) => {
    expect(evaluate(raw, decimal, comparator, unit).decision).toBe('accept_with_warnings');
  });

  it.each([
    ['7.4', '7.4', 'eq', null], ['<2.50E＋03', '2500', 'lt', 'cm/s'],
    ['−7.40', '-7.4', 'eq', 'kg'], ['.25', '0.25', 'eq', 'mL'], ['-0.00', '0', 'eq', null]
  ] as const)('原有纯数值路径不依赖unit且保持兼容 %s', (raw, decimal, comparator, unit) => {
    expect(evaluate(raw, decimal, comparator, unit).decision).toBe('accept_with_warnings');
  });

  it.each([
    ['12', '1', 'eq', '2'],
    ['1E+02', '1', 'eq', 'E+02'],
    ['<12', '1', 'lt', '2'],
    ['7.4', '7.4', 'lt', '4'],
    ['7.4cm/s', '7.4', 'eq', 'cm'],
    ['7.4cm/s', '7.4', 'eq', 's'],
    ['7.4 mmol / L', '7.4', 'eq', 'mmol/L'],
    ['7.4 mmol/L', '7.4', 'eq', 'MMOL/L'],
    ['7.4 mmol/L', '7.4', 'eq', null],
    ['7.4 mmol/L', '7.4', 'eq', ''],
    ['7.4 mmol/L', '7.4', 'eq', '   '],
    ['1 2 mmol/L', '12', 'eq', 'mmol/L'],
    ['1\n2 mmol/L', '12', 'eq', 'mmol/L'],
    ['- 7 4 kg', '-74', 'eq', 'kg'],
    ['+ -7.4 kg', '-7.4', 'eq', 'kg'],
    ['- +7.4 kg', '-7.4', 'eq', 'kg'],
    ['7 - 4 kg', '3', 'eq', 'kg'],
    ['7.4 E + 03', '7400', 'eq', null],
    ['7-9kg', '7', 'eq', 'kg'],
    ['7～9 kg', '7', 'eq', 'kg'],
    ['≠7kg', '7', 'eq', 'kg'],
    ['!=7 kg', '7', 'eq', 'kg'],
    ['7±2 kg', '7', 'eq', 'kg'],
    ['7kg 阴性', '7', 'eq', 'kg'],
    ['7阴性', '7', 'eq', '阴性'],
    ['7未检出', '7', 'eq', '未检出'],
    ['7正常', '7', 'eq', '正常'],
    ['7负', '7', 'eq', '负'],
    ['7 negative', '7', 'eq', 'negative'],
    ['7kg+', '7', 'eq', 'kg+'],
    ['7kg-', '7', 'eq', 'kg-'],
    ['7>kg', '7', 'eq', '>kg'],
    ['7E+02/L', '7', 'eq', 'E+02/L'],
    ['7 E+02', '7', 'eq', 'E+02'],
    ['7 2', '7', 'eq', '2'],
    ['7 2E3', '7', 'eq', '2E3'],
    ['7.410^9/L', '7.4', 'eq', '10^9/L'],
    ['7.4 2 kg', '7.4', 'eq', '2 kg'],
    ['7.4 2kg', '7.4', 'eq', '2kg'],
    ['<2.5kg', '2.5', 'eq', 'kg'],
    ['-7.4kg', '7.4', 'eq', 'kg'],
    ['2.5E+03cm/s', '250', 'eq', 'cm/s']
  ] as const)('歧义/边界变化仍拒绝 %s，不借unit改读数值', (raw, decimal, comparator, unit) => {
    expect(evaluate(raw, decimal, comparator, unit)).toEqual({ decision: 'reject', reasons: ['direct_original_numeric_representation_conflict'] });
  });

  it.each(['≈', '~', '～', '∼', '≃', '≅', '≲', '≳', '…', ':'])('%s等非单位限定符出现在unit前、中、后都不能被隔离', (marker) => {
    for (const unit of [`${marker}kg`, `k${marker}g`, `kg${marker}`]) {
      expect(evaluate(`7${unit}`, '7', 'eq', unit)).toEqual({
        decision: 'reject', reasons: ['direct_original_numeric_representation_conflict']
      });
    }
  });
});
