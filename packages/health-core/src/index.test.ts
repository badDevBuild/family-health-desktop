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
    { id: 'span-1', documentId: 'doc-1', spanKind: 'page', page: 1, blockId: null, lineStart: null, lineEnd: null, quote: '2026-09-12 LDL 4.2', readability: 'clear' },
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
  evidence: [{ sourceSpanId: 'span-1', quote: '2026-09-12 LDL 4.2' }],
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

  it('数值必须和对应指标出现在同一证据行，不能借用邻项数字', () => {
    const rowManifest: SourceManifest = {
      ...manifest,
      totalUnits: 1,
      coveredUnitIndexes: [0],
      spans: [{
        ...manifest.spans[0]!,
        quote: '低密度脂蛋白 4.2 mmol/L；甘油三酯 1.3 mmol/L'
      }]
    };
    const misplaced: ObservationCandidate = {
      ...candidate,
      originalName: '甘油三酯',
      standardNameCandidate: 'TG',
      referenceRangeRaw: null,
      clinicalDate: null,
      evidence: [{ sourceSpanId: 'span-1', quote: '低密度脂蛋白 4.2 mmol/L；甘油三酯 1.3 mmol/L' }]
    };
    expect(evaluateObservationCandidate(misplaced, rowManifest, { personConsistent: true, overwritesUserLockedValue: false }))
      .toEqual({ decision: 'reject', reasons: ['numeric_value_not_in_evidence'] });
  });

  it('年度对比行中的相邻数值保持分隔，不会把 91 和 94 误拼为 9194', () => {
    const comparisonManifest: SourceManifest = {
      ...manifest,
      totalUnits: 1,
      coveredUnitIndexes: [0],
      spans: [{ ...manifest.spans[0]!, quote: '体 重 91 94 ▲ --- kg' }]
    };
    const currentWeight: ObservationCandidate = {
      ...candidate,
      localKey: 'weight-current',
      originalName: '体重',
      standardNameCandidate: '体重',
      value: { kind: 'numeric', rawText: '94', decimal: '94', comparator: 'eq' },
      unitRaw: 'kg',
      referenceRangeRaw: '---',
      reportedAbnormalFlag: null,
      clinicalDate: null,
      evidence: [{ sourceSpanId: 'span-1', quote: '体 重 91 94 ▲ --- kg' }]
    };
    expect(evaluateObservationCandidate(currentWeight, comparisonManifest, {
      personConsistent: true, overwritesUserLockedValue: false
    })).toEqual({ decision: 'accept', warnings: [] });
  });

  it('同一超声部位连续尺寸可共享前缀，但不会串用另一尺寸的数值', () => {
    const quote = '检查日期：2024-10-25 甲状腺左侧叶前后径：15.7mm，左右径：14.8mm；甲状腺右侧叶前后径：19.4mm，左右径：16.9mm';
    const ultrasoundManifest: SourceManifest = {
      ...manifest,
      totalUnits: 1,
      coveredUnitIndexes: [0],
      spans: [{ ...manifest.spans[0]!, quote }]
    };
    const leftTransverse: ObservationCandidate = {
      ...candidate,
      localKey: 'thyroid-left-transverse',
      originalName: '甲状腺左侧叶左右径',
      standardNameCandidate: '甲状腺左叶左右径',
      value: { kind: 'numeric', rawText: '14.8mm', decimal: '14.8', comparator: 'eq' },
      unitRaw: 'mm',
      referenceRangeRaw: null,
      reportedAbnormalFlag: null,
      specimen: null,
      method: '甲状腺彩超',
      bodySite: '甲状腺左侧叶',
      clinicalDate: '2024-10-25',
      evidence: [{ sourceSpanId: 'span-1', quote }],
      issues: []
    };
    expect(evaluateObservationCandidate(leftTransverse, ultrasoundManifest, {
      personConsistent: true, overwritesUserLockedValue: false
    })).toEqual({ decision: 'accept_with_warnings', warnings: ['reference_range_not_provided'] });
    expect(evaluateObservationCandidate({
      ...leftTransverse,
      value: { kind: 'numeric', rawText: '16.9mm', decimal: '16.9', comparator: 'eq' }
    }, ultrasoundManifest, { personConsistent: true, overwritesUserLockedValue: false }))
      .toEqual({ decision: 'reject', reasons: ['numeric_value_not_in_evidence'] });
  });

  it('明确单位和比较符必须属于当前指标证据', () => {
    const pressureManifest: SourceManifest = {
      ...manifest,
      totalUnits: 1,
      coveredUnitIndexes: [0],
      spans: [{ ...manifest.spans[0]!, quote: '收缩压 > 18 kPa' }]
    };
    const pressure: ObservationCandidate = {
      ...candidate,
      originalName: '收缩压',
      standardNameCandidate: '收缩压',
      value: { kind: 'numeric', rawText: '>18', decimal: '18', comparator: 'gt' },
      unitRaw: 'mmHg',
      referenceRangeRaw: null,
      clinicalDate: null,
      evidence: [{ sourceSpanId: 'span-1', quote: '收缩压 > 18 kPa' }]
    };
    expect(evaluateObservationCandidate(pressure, pressureManifest, { personConsistent: true, overwritesUserLockedValue: false }))
      .toEqual({ decision: 'reject', reasons: ['unit_not_bound_to_measurement'] });
  });

  it('甲状腺激素的 pmol/L 单位不会被后续 mIU/mL 项目误判为单位冲突', () => {
    const quote = '血清游离三碘甲状原氨酸 (FT3) 4.80 pmol/l 2.76-6.45 血清促甲状腺激素 (TSH) 6.45 mIU/ml 0.35-5.1';
    const thyroidManifest: SourceManifest = {
      ...manifest,
      totalUnits: 1,
      coveredUnitIndexes: [0],
      spans: [{ ...manifest.spans[0]!, quote }]
    };
    const ft3: ObservationCandidate = {
      ...candidate,
      localKey: 'ft3',
      originalName: '血清游离三碘甲状原氨酸 (FT3)',
      standardNameCandidate: '游离三碘甲状腺原氨酸',
      value: { kind: 'numeric', rawText: '4.80', decimal: '4.80', comparator: 'eq' },
      unitRaw: 'pmol/l',
      referenceRangeRaw: '2.76-6.45',
      reportedAbnormalFlag: null,
      specimen: '血清',
      clinicalDate: null,
      evidence: [{ sourceSpanId: 'span-1', quote }]
    };
    expect(evaluateObservationCandidate(ft3, thyroidManifest, {
      personConsistent: true, overwritesUserLockedValue: false
    })).toEqual({ decision: 'accept', warnings: [] });
  });

  it('文字结果仅被 PDF 排版空格断开时仍可接纳，真实文字差异仍拒绝', () => {
    const textManifest: SourceManifest = {
      ...manifest,
      totalUnits: 1,
      coveredUnitIndexes: [0],
      spans: [{
        ...manifest.spans[0]!,
        quote: '2023-10-09 小结 请结合实验室检 查'
      }]
    };
    const textCandidate: ObservationCandidate = {
      ...candidate,
      value: { kind: 'text', rawText: '请结合实验室检查' },
      clinicalDate: '2023-10-09',
      evidence: [{ sourceSpanId: 'span-1', quote: '2023-10-09 小结 请结合实验室检 查' }]
    };
    expect(evaluateObservationCandidate(textCandidate, textManifest, { personConsistent: true, overwritesUserLockedValue: false }))
      .toMatchObject({ decision: 'accept' });
    expect(evaluateObservationCandidate({
      ...textCandidate,
      value: { kind: 'text', rawText: '请结合实验室复查' }
    }, textManifest, { personConsistent: true, overwritesUserLockedValue: false }))
      .toEqual({ decision: 'reject', reasons: ['reported_value_not_in_evidence'] });
  });

  it('证据摘录与 PDF 原文仅空白排版不同时仍可定位，字符变化仍拒绝', () => {
    const whitespaceManifest: SourceManifest = {
      ...manifest,
      totalUnits: 1,
      coveredUnitIndexes: [0],
      spans: [{
        ...manifest.spans[0]!,
        quote: '2023-10-09 肝胆脾胰 彩色多普 勒 小结 未见明显异常声像'
      }]
    };
    const whitespaceCandidate: ObservationCandidate = {
      ...candidate,
      value: { kind: 'text', rawText: '未见明显异常声像' },
      unitRaw: null,
      referenceRangeRaw: null,
      reportedAbnormalFlag: null,
      clinicalDate: '2023-10-09',
      evidence: [{
        sourceSpanId: 'span-1',
        quote: '2023-10-09 肝胆脾胰 彩色多普勒 小结 未见明显异常声像'
      }]
    };
    expect(evaluateObservationCandidate(whitespaceCandidate, whitespaceManifest, {
      personConsistent: true, overwritesUserLockedValue: false
    })).toMatchObject({ decision: 'accept_with_warnings' });
    expect(evaluateObservationCandidate({
      ...whitespaceCandidate,
      evidence: [{ sourceSpanId: 'span-1', quote: '2023-10-09 肝胆脾胰 彩色多普勒 小结 发现异常声像' }]
    }, whitespaceManifest, { personConsistent: true, overwritesUserLockedValue: false }))
      .toEqual({ decision: 'reject', reasons: ['evidence_quote_mismatch:span-1'] });
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
