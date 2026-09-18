import { describe, expect, it } from 'vitest';
import type { ObservationCandidate, SourceManifest } from '@contracts';
import {
  canTransitionJob,
  determineInvalidation,
  evaluateObservationCandidate,
  validateCoverage
} from './index.js';

const manifest: SourceManifest = {
  id: 'manifest-1',
  sourceObjectId: 'source-1',
  sha256: 'a'.repeat(64),
  mediaType: 'application/pdf',
  originalDisplayName: '纯虚构报告.pdf',
  totalUnits: 2,
  coveredUnitIndexes: [0, 1],
  spans: [
    { id: 'span-1', documentId: 'doc-1', spanKind: 'page', page: 1, blockId: null, lineStart: null, lineEnd: null, quote: 'LDL 4.2', readability: 'clear' },
    { id: 'span-2', documentId: 'doc-1', spanKind: 'page', page: 2, blockId: null, lineStart: null, lineEnd: null, quote: null, readability: 'clear' }
  ],
  normalizerVersion: '1',
  conversionWarnings: [],
  createdAt: '2026-09-17T08:00:00+00:00'
};

const candidate: ObservationCandidate = {
  localKey: 'ldl',
  originalName: '低密度脂蛋白胆固醇',
  standardNameCandidate: 'LDL-C',
  value: { kind: 'numeric', rawText: '4.2', decimal: '4.2', comparator: 'eq' },
  unitRaw: 'mmol/L',
  referenceRangeRaw: '0-3.4',
  reportedAbnormalFlag: '↑',
  specimen: '血清',
  method: null,
  bodySite: null,
  clinicalDate: '2026-09-12',
  evidence: [{ sourceSpanId: 'span-1', quote: 'LDL 4.2' }],
  issues: []
};

describe('自动接纳规则', () => {
  it('拒绝不存在的证据引用', () => {
    const bad = { ...candidate, evidence: [{ sourceSpanId: 'made-up', quote: null }] };
    expect(evaluateObservationCandidate(bad, manifest, { personConsistent: true, overwritesUserLockedValue: false }))
      .toEqual({ decision: 'reject', reasons: ['evidence_mismatch'] });
  });

  it('覆盖完整且引用有效时可接纳', () => {
    expect(evaluateObservationCandidate(candidate, manifest, { personConsistent: true, overwritesUserLockedValue: false }))
      .toEqual({ decision: 'accept', warnings: [] });
  });

  it('缺页阻止自动接纳', () => {
    const incomplete = { ...manifest, coveredUnitIndexes: [0] };
    expect(validateCoverage(incomplete)).toEqual(['missing_unit:1']);
  });
});

describe('任务与失效规则', () => {
  it('成功任务不能重新进入运行态', () => {
    expect(canTransitionJob('succeeded', 'running')).toBe(false);
    expect(canTransitionJob('failed', 'queued')).toBe(true);
  });

  it('显示名不触发分析，临床背景只使派生结果失效', () => {
    expect(determineInvalidation('display')).toEqual({ facts: false, trends: false, derived: false });
    expect(determineInvalidation('clinical_context')).toEqual({ facts: false, trends: false, derived: true });
  });
});

