import type { MemberEvidenceRef } from '@contracts';
import type { AcceptedObservationSummary, WorkspaceStore } from '@storage';

type AcceptedSourceOwner = Pick<AcceptedObservationSummary,
  'id' | 'personId' | 'documentId' | 'sourceSpanId' | 'evidence' | 'clinicalContext'>;
type OriginalQuoteReader = Pick<WorkspaceStore, 'getTrustedDirectOriginalExcerptQuote'>;

/**
 * null 引文表示引用整段原件摘录，只在本机成员综合目录中实体化。
 * 不改观测、趋势或非空引文；查找失败不从结果、标题或其他片段拼答案。
 */
export function materializeWholeExcerptMemberCatalog(
  store: OriginalQuoteReader,
  personId: string,
  observations: readonly AcceptedSourceOwner[],
  references: readonly MemberEvidenceRef[]
): MemberEvidenceRef[] {
  const owners = new Map(observations.filter((item) => item.personId === personId).map((item) => [item.id, item]));
  const quotes = new Map<string, string | null>();
  return references.map((reference) => {
    if (reference.quote !== null || !['observation', 'clinical_finding', 'source_span'].includes(reference.kind)
      || reference.observationId === null || reference.documentId === null || reference.sourceSpanId === null) return reference;
    const owner = owners.get(reference.observationId);
    if (!owner || owner.documentId !== reference.documentId
      || ![owner.sourceSpanId, ...owner.evidence.map((item) => item.sourceSpanId),
        ...(owner.clinicalContext?.conditions ?? []).map((item) => item.sourceSpanId)].includes(reference.sourceSpanId)) return reference;
    const key = JSON.stringify([personId, reference.documentId, reference.sourceSpanId]);
    if (!quotes.has(key)) quotes.set(key, store.getTrustedDirectOriginalExcerptQuote(
      personId, reference.documentId, reference.sourceSpanId));
    const quote = quotes.get(key)!;
    return quote === null ? reference : { ...reference, quote };
  });
}
