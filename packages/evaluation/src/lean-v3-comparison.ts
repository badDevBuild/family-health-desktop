/** 旧路径可能在生成后的本地证据门禁提前拒绝，此时不会调用独立复核。 */
export function completeOldNewComparison(input: {
  legacyStatus: 'published' | 'rejected' | 'skipped';
  legacyCalls: number;
  v3Status: 'published' | 'rejected' | 'skipped';
  v3Calls: number;
  calls: Array<{ stage: string; webSearches: number }>;
}): boolean {
  const legacyComplete = input.legacyStatus === 'published'
    ? input.legacyCalls === 2
    : input.legacyStatus === 'rejected' && [1, 2].includes(input.legacyCalls);
  if (!legacyComplete || input.v3Status !== 'published' || input.v3Calls !== 1) return false;
  const expectedStages = input.legacyCalls === 2
    ? ['legacy_analysis', 'legacy_review', 'P02']
    : ['legacy_analysis', 'P02'];
  return input.calls.length === expectedStages.length
    && input.calls.every((call, index) => call.stage === expectedStages[index] && call.webSearches === 0);
}
