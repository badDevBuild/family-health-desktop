import { describe, expect, it } from 'vitest';
import { completeOldNewComparison } from './lean-v3-comparison.js';

describe('同一合成事实的新旧分析阶段对照回执', () => {
  it('旧版生成后本地拒绝时只记录一次旧调用，不虚构独立复核', () => {
    expect(completeOldNewComparison({
      legacyStatus: 'rejected', legacyCalls: 1, v3Status: 'published', v3Calls: 1,
      calls: [{ stage: 'legacy_analysis', webSearches: 0 }, { stage: 'P02', webSearches: 0 }]
    })).toBe(true);
  });

  it('旧版进入独立复核后即使拒绝，也如实计两次旧调用', () => {
    expect(completeOldNewComparison({
      legacyStatus: 'rejected', legacyCalls: 2, v3Status: 'published', v3Calls: 1,
      calls: [{ stage: 'legacy_analysis', webSearches: 0 },
        { stage: 'legacy_review', webSearches: 0 }, { stage: 'P02', webSearches: 0 }]
    })).toBe(true);
  });

  it('不把新版额外修复或联网、旧版跳过、缺少调用当作普通路径完成', () => {
    const base = {
      legacyStatus: 'published' as const, legacyCalls: 2, v3Status: 'published' as const, v3Calls: 1,
      calls: [{ stage: 'legacy_analysis', webSearches: 0 },
        { stage: 'legacy_review', webSearches: 0 }, { stage: 'P02', webSearches: 0 }]
    };
    expect(completeOldNewComparison({ ...base, legacyStatus: 'skipped' })).toBe(false);
    expect(completeOldNewComparison({ ...base, v3Calls: 2 })).toBe(false);
    expect(completeOldNewComparison({ ...base, calls: base.calls.slice(0, 2) })).toBe(false);
    expect(completeOldNewComparison({ ...base, calls: [base.calls[0]!, base.calls[1]!,
      { stage: 'P02', webSearches: 1 }] })).toBe(false);
  });
});
