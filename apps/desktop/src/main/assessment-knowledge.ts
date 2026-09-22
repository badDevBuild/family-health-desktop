import type { MemberAssessmentCandidateV3, MemberAssessmentSnapshotV3, MemberEvidencePackageV3 } from '@contracts';
import { stableHash } from '@core';

/** 受控条目的标题与网址来自本地目录，不能由模型按相同 ID 偷换。 */
export function canonicalizeAssessmentKnowledge(
  candidate: MemberAssessmentCandidateV3,
  evidencePackage: MemberEvidencePackageV3
): MemberAssessmentCandidateV3 {
  const catalog = new Map(evidencePackage.knowledge.map((entry) => [entry.id, entry]));
  return {
    ...candidate,
    knowledgeSources: candidate.knowledgeSources.map((source) => {
      if (source.origin !== 'catalog') return source;
      const entry = catalog.get(source.id);
      if (!entry) return source;
      return {
        ...source,
        title: entry.title,
        organization: entry.sourceOrganization,
        url: entry.sourceUrl,
        supports: entry.supportedScope
      };
    })
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
