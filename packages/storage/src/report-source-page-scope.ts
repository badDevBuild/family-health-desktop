import type { ObservationCandidate, SourceManifest } from '@contracts';
import type { ReportSourcePageScope } from '@core';

/** 页范围只回答结果位于哪里，不把独立的日期、标题或解释条件变成结果位置。 */
export function reportFindingPageScope(input: {
  documentId: string; sourceSpanId: string; evidence: ObservationCandidate['evidence'];
  sourceBinding?: ObservationCandidate['sourceBinding'];
  clinicalContext?: ObservationCandidate['clinicalContext'];
}, manifest: SourceManifest): ReportSourcePageScope | null {
  const references = [...new Set([input.sourceSpanId, ...input.evidence.map((ref) => ref.sourceSpanId),
    ...(input.sourceBinding?.findingEvidence.map((ref) => ref.sourceSpanId) ?? []),
    ...(input.clinicalContext?.conditions.map((ref) => ref.sourceSpanId) ?? [])])];
  const spans = references.map((id) => manifest.spans.filter((span) => span.id === id));
  // 破损、跨原件或缺页引用仍不能提供缩小竞争范围的证明。
  if (!spans.length || spans.some((matches) => matches.length !== 1 || matches[0]!.documentId !== input.documentId
    || matches[0]!.page === null || !Number.isInteger(matches[0]!.page) || matches[0]!.page! < 1)) return null;
  const resolved = spans.map((matches) => matches[0]!);
  const direct = resolved.some((span) => span.modelEvidence);
  let findingSpans = resolved;
  if (direct) {
    if (resolved.some((span) => span.modelEvidence && (span.modelEvidence.originalSha256 !== manifest.sha256
      || span.modelEvidence.originalSourceObjectId !== manifest.sourceObjectId
      || manifest.spans.filter((parent) => parent.id === span.modelEvidence!.parentSourceSpanId
        && parent.documentId === input.documentId && parent.page === span.page).length !== 1))) return null;
    // 来源角色来自持久原件回执，而非展示名称、同值推测或模型新编号。
    findingSpans = resolved.filter((span) => span.modelEvidence
      && ['finding', 'instruction'].includes(span.modelEvidence.role));
    const declared = input.sourceBinding?.findingEvidence.filter((ref) => ref.sourceRole !== 'duplicate_source') ?? [];
    if (declared.some((ref) => !findingSpans.some((span) => span.id === ref.sourceSpanId))) return null;
    // 无 finding 角色时保持未知；不能只凭日期或背景证明结果在某页。
    if (!findingSpans.length || !findingSpans.some((span) => span.id === input.sourceSpanId)) return null;
  }
  return { documentId: input.documentId, sourceObjectId: manifest.sourceObjectId, sourceSha256: manifest.sha256,
    pages: [...new Set(findingSpans.map((span) => span.page!))].sort((a, b) => a - b) };
}
