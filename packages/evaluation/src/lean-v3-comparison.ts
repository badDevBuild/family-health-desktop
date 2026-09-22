/** 旧路径可能在生成后的本地证据门禁提前拒绝，此时不会调用独立复核。 */
export function completeOldNewComparison(input: {
  legacyStatus: 'published' | 'rejected' | 'skipped';
  legacyCalls: number;
  v3Status: 'published' | 'rejected' | 'skipped';
  v3Calls: number;
  /** 普通样例为 P02；高影响样例必须真的完成 P04，不能把额外调用藏进一次综合。 */
  expectedV3Stages?: readonly string[];
  calls: Array<{ stage: string; webSearches: number }>;
}): boolean {
  const legacyComplete = input.legacyStatus === 'published'
    ? input.legacyCalls === 2
    : input.legacyStatus === 'rejected' && [1, 2].includes(input.legacyCalls);
  const expectedV3Stages = input.expectedV3Stages ?? ['P02'];
  const validV3Stages = expectedV3Stages[0] === 'P02'
    && (expectedV3Stages.length === 1
      || expectedV3Stages.length === 2 && expectedV3Stages[1] === 'P04');
  if (!legacyComplete || !validV3Stages || input.v3Status !== 'published'
    || input.v3Calls !== expectedV3Stages.length) return false;
  const expectedStages = [
    'legacy_analysis',
    ...(input.legacyCalls === 2 ? ['legacy_review'] : []),
    ...expectedV3Stages
  ];
  return input.calls.length === expectedStages.length
    && input.calls.every((call, index) => call.stage === expectedStages[index] && call.webSearches === 0);
}
