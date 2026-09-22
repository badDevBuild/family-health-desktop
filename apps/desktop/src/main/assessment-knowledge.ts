import type { MemberAssessmentCandidateV3, MemberAssessmentSnapshotV3, MemberEvidencePackageV3 } from '@contracts';
import { stableHash } from '@core';

/** 受控条目的标题与网址来自本地目录，不能由模型按相同 ID 偷换。 */
export function canonicalizeAssessmentKnowledge(
  candidate: MemberAssessmentCandidateV3,
  evidencePackage: MemberEvidencePackageV3
): MemberAssessmentCandidateV3 {
  const catalog = new Map(evidencePackage.knowledge.map((entry) => [entry.id, entry]));
  const entriesByUrl = new Map<string, typeof evidencePackage.knowledge>();
  for (const entry of evidencePackage.knowledge) {
    if (!entry.sourceUrl) continue;
    entriesByUrl.set(entry.sourceUrl, [...entriesByUrl.get(entry.sourceUrl) ?? [], entry]);
  }
  const aliases = new Map<string, string>();
  const sources = candidate.knowledgeSources.map((source) => {
    if (source.origin !== 'catalog') return source;
    const exact = catalog.get(source.id);
    // 只允许本地目录中唯一且网址完全一致的条目纠正模型临时 ID；标题相似不够。
    const byUrl = source.url ? entriesByUrl.get(source.url) : undefined;
    const entry = exact ?? (byUrl?.length === 1 ? byUrl[0] : undefined);
    if (!entry) return source;
    aliases.set(source.id, entry.id);
    return {
      ...source,
      id: entry.id,
      title: entry.title,
      organization: entry.sourceOrganization,
      url: entry.sourceUrl,
      supports: entry.supportedScope
    };
  });
  const canonicalIds = (ids: string[]) => [...new Set(ids.map((id) => aliases.get(id) ?? id))];
  return {
    ...candidate,
    claims: candidate.claims.map((claim) => ({ ...claim,
      knowledgeSourceIds: canonicalIds(claim.knowledgeSourceIds),
      criteriaBasis: claim.criteriaBasis && aliases.has(claim.criteriaBasis.sourceId)
        ? { ...claim.criteriaBasis, sourceId: aliases.get(claim.criteriaBasis.sourceId)! }
        : claim.criteriaBasis
    })),
    actions: candidate.actions.map((action) => ({ ...action,
      knowledgeSourceIds: canonicalIds(action.knowledgeSourceIds)
    })),
    knowledgeSources: [...new Map(sources.map((source) => [source.id, source])).values()]
  };
}

/** 当前运行时未提供可证明网页正文的工具回执，检索网址只能标为模型引用。 */
export function buildAssessmentKnowledgeVerifications(
  candidate: MemberAssessmentCandidateV3,
  evidencePackage: MemberEvidencePackageV3
): MemberAssessmentSnapshotV3['knowledgeVerifications'] {
  const catalog = new Map(evidencePackage.knowledge.map((entry) => [entry.id, entry]));
  return candidate.knowledgeSources.map((source) => {
    const entry = source.origin === 'catalog' ? catalog.get(source.id) : undefined;
    return {
      sourceId: source.id,
      status: entry ? 'catalog_curated' : 'model_cited',
      checkedAt: entry?.reviewedAt ?? null,
      contentHash: entry ? stableHash(entry.content) : null,
      toolReceiptId: null
    };
  });
}
