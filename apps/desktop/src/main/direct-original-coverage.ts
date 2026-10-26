import type { DirectOriginalReadingResult } from '@contracts';

/** 只核对模型原页盘点与真实候选的引用关系；不从图片、项目词典或数值猜缺了什么。 */
export function inspectDirectOriginalCoverage(reading: DirectOriginalReadingResult): {
  issues: string[]; pageIds: string[]; classifiedSourceKeys: Set<string>;
} {
  const issues = new Set<string>(); const pages = new Set<string>();
  const classifiedSourceKeys = new Set<string>();
  const candidates = new Map(reading.extraction.candidates.map((candidate) => [candidate.localKey, candidate]));
  const excerpts = new Map(reading.sourceExcerpts.map((excerpt) => [excerpt.localKey, excerpt]));
  const fail = (pageId: string, code: string) => { pages.add(pageId); issues.add(code); };
  const exactUnique = (text: string, quote: string): boolean => {
    const index = text.indexOf(quote);
    return index >= 0 && text.indexOf(quote, index + 1) < 0;
  };
  const claimedResults = new Set(reading.extraction.candidates.flatMap(candidate =>
    (candidate.sourceBinding?.findingEvidence ?? candidate.evidence).map(ref => ref.sourceSpanId)));
  for (const page of reading.pageReadings) {
    if (page.resultInventory === undefined) {
      if (page.status === 'read' || page.status === 'partial') fail(page.sourceSpanId, 'direct_original_result_inventory_missing');
      continue;
    }
    const entries = new Set<string>();
    if (page.status === 'read' && page.resultInventory.length === 0) fail(page.sourceSpanId, 'direct_original_result_inventory_unaccounted');
    for (const item of page.resultInventory) {
      const excerpt = excerpts.get(item.sourceSpanId);
      if (item.classification) {
        const classification = item.classification;
        const duplicate = classification.duplicateSourceSpanId ? excerpts.get(classification.duplicateSourceSpanId) : undefined;
        const grounded = classification.evidence.every(ref => {
          const context = excerpts.get(ref.sourceSpanId);
          return (context?.pageSourceSpanId === page.sourceSpanId
            || classification.disposition === 'duplicate_summary' && context?.pageSourceSpanId === duplicate?.pageSourceSpanId)
            && context?.clarity === 'clear'
            && ['heading', 'context'].includes(context.role) && exactUnique(context.quote, ref.quote);
        });
        // 相同短结果可能来自不同日期或条件。只有两页完整上下文一致才排除重复摘要，标题相同不够。
        const contexts = classification.evidence.flatMap(ref => {
          const context = excerpts.get(ref.sourceSpanId);
          return context?.role === 'context' && context.quote === ref.quote && excerpt
            && context.quote.length > excerpt.quote.length && exactUnique(context.quote, excerpt.quote) ? [context] : [];
        });
        const sharedContext = contexts.some(context => context.pageSourceSpanId === page.sourceSpanId
          && contexts.some(other => other.pageSourceSpanId === duplicate?.pageSourceSpanId && other.quote === context.quote));
        // 分类仅解释未作为候选的内容；不能隐藏已有候选，不能仅凭pageRole跳过一整页。
        const duplicateProven = classification.disposition === 'duplicate_summary'
          ? duplicate?.clarity === 'clear' && duplicate.pageSourceSpanId !== page.sourceSpanId
            && duplicate.quote === excerpt?.quote && claimedResults.has(duplicate.localKey) && sharedContext
          : classification.duplicateSourceSpanId === null && excerpt?.role === 'context';
        if (!excerpt || excerpt.pageSourceSpanId !== page.sourceSpanId || excerpt.clarity !== 'clear'
          || item.candidateKeys.length !== 0 || claimedResults.has(item.sourceSpanId) || !grounded || !duplicateProven
          || classifiedSourceKeys.has(item.sourceSpanId)) {
          fail(page.sourceSpanId, 'direct_original_inventory_classification_unproven');
        } else classifiedSourceKeys.add(item.sourceSpanId);
        continue;
      }
      const declaredBlank = item.candidateKeys.length > 0 && item.candidateKeys.every((key) => {
        const candidate = candidates.get(key);
        return candidate?.value.kind === 'unknown' && candidate.value.reason === 'original_blank'
          && (candidate.sourceBinding?.findingEvidence ?? candidate.evidence).some((ref) => ref.sourceSpanId === item.sourceSpanId);
      });
      const identity = JSON.stringify([item.sourceSpanId, [...item.candidateKeys].sort()]);
      if (entries.has(identity) || new Set(item.candidateKeys).size !== item.candidateKeys.length
        || !excerpt || excerpt.pageSourceSpanId !== page.sourceSpanId
        || !(declaredBlank && ['heading', 'context'].includes(excerpt.role)) && !['finding', 'instruction'].includes(excerpt.role)
        || page.status === 'no_medical_content') {
        fail(page.sourceSpanId, 'direct_original_result_inventory_invalid');
        continue;
      }
      entries.add(identity);
      // 原件不清楚本身仍由页面/候选保留说明，不能以一个无关候选抵消另一个可读项目。
      if (item.candidateKeys.length === 0 || item.candidateKeys.some((key) => {
        const candidate = candidates.get(key);
        return !candidate || !(candidate.sourceBinding?.findingEvidence ?? candidate.evidence)
          .some((reference) => reference.sourceSpanId === item.sourceSpanId && reference.sourceRole !== 'duplicate_source');
      })) fail(page.sourceSpanId, 'direct_original_result_inventory_unaccounted');
    }
  }
  return { issues: [...issues], pageIds: [...pages], classifiedSourceKeys };
}
