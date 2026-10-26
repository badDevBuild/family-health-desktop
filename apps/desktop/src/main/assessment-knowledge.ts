import { isDeepStrictEqual } from 'node:util';
import type {
  ClinicalFocusedReviewV1, HealthAction, HealthClaim, MemberAssessmentCandidateV3,
  MemberAssessmentSnapshotV3, MemberEvidencePackageV3
} from '@contracts';
import { memberEvidencePackageV3Schema } from '@contracts';
import { stableHash } from '@core';
import type { OfficialKnowledgeReceipt } from './official-knowledge-retrieval.js';

type CatalogEntries = MemberEvidencePackageV3['knowledge'];

/** 输入目录决定真实 ID 的归属，模型不能通过 origin 字段取消目录支持范围核对。 */
function catalogReferenceIds(catalogEntries: CatalogEntries): Set<string> {
  return new Set(catalogEntries.map((entry) => entry.id));
}

/** 只选择宣称有受控知识依据的主张和行动，不为普通模型知识增加整篇复核。 */
export function routeKnowledgeAttributionReview(
  candidate: MemberAssessmentCandidateV3,
  catalogEntries: CatalogEntries
): { targetIds: string[]; reasons: string[] } {
  const catalogIds = catalogReferenceIds(catalogEntries);
  const targetIds = [
    ...candidate.claims.filter((claim) => [...claim.knowledgeSourceIds,
      ...(claim.criteriaBasis ? [claim.criteriaBasis.sourceId] : [])].some((id) => catalogIds.has(id))),
    ...candidate.actions.filter((action) => action.knowledgeSourceIds.some((id) => catalogIds.has(id)))
  ].map((node) => node.id);
  return { targetIds, reasons: targetIds.map((id) => `catalog_knowledge_attribution:${id}`) };
}

function clinicalFields(node: HealthClaim | HealthAction): Record<string, unknown> {
  return Object.fromEntries(Object.entries(node)
    .filter(([key]) => key !== 'knowledgeSourceIds' && key !== 'knowledgeBasis'));
}

/** 没有正文或标准依赖的失效书目只撤书目，不让无关元数据阻止健康内容发布。 */
export function pruneUnreferencedInvalidKnowledge(candidate: MemberAssessmentCandidateV3,
  catalogEntries: CatalogEntries): MemberAssessmentCandidateV3 {
  const used = new Set([
    ...candidate.claims.flatMap((claim) => [...claim.knowledgeSourceIds,
      ...(claim.criteriaBasis ? [claim.criteriaBasis.sourceId] : [])]),
    ...candidate.actions.flatMap((action) => action.knowledgeSourceIds)
  ]);
  const catalogIds = catalogReferenceIds(catalogEntries);
  return { ...candidate, knowledgeSources: candidate.knowledgeSources.filter((source) => {
    // 重复 ID 属于范围歧义，不能借清理无引用元数据掩盖。
    if (used.has(source.id) || candidate.knowledgeSources.filter((item) => item.id === source.id).length !== 1) return true;
    return !(source.origin === 'catalog' && !catalogIds.has(source.id)
      || source.origin === 'retrieved' && (!source.url?.startsWith('https://') || !source.supports));
  }) };
}

/** 不再被正文、行动或诊断标准使用的目录来源不能悬挂在整份报告上。 */
export function pruneUnusedCatalogKnowledge(candidate: MemberAssessmentCandidateV3): MemberAssessmentCandidateV3 {
  const used = new Set([
    ...candidate.claims.flatMap((claim) => [...claim.knowledgeSourceIds,
      ...(claim.criteriaBasis ? [claim.criteriaBasis.sourceId] : [])]),
    ...candidate.actions.flatMap((action) => action.knowledgeSourceIds)
  ]);
  return { ...candidate, knowledgeSources: candidate.knowledgeSources.filter((source) => source.origin !== 'catalog' || used.has(source.id)) };
}

/** 来源核对不取得医学编辑权限：hold 或越权改写只撤下不能证明的目录归属。 */
export function applyKnowledgeAttributionReview(
  candidate: MemberAssessmentCandidateV3,
  review: ClinicalFocusedReviewV1,
  targetIds: string[],
  catalogEntries: CatalogEntries
): MemberAssessmentCandidateV3 {
  if (review.personId !== candidate.personId || review.inputSignature !== candidate.inputSignature) {
    throw new Error('FOCUSED_REVIEW_SCOPE_MISMATCH');
  }
  const expected = new Set(targetIds);
  if (review.results.length !== expected.size || new Set(review.results.map((result) => result.targetId)).size !== expected.size
    || review.results.some((result) => !expected.has(result.targetId))) throw new Error('FOCUSED_REVIEW_COVERAGE_MISMATCH');
  const catalogIds = catalogReferenceIds(catalogEntries);
  const claims = new Map(candidate.claims.map((claim) => [claim.id, claim]));
  const actions = new Map(candidate.actions.map((action) => [action.id, action]));
  for (const result of review.results) {
    const claim = claims.get(result.targetId);
    const action = actions.get(result.targetId);
    const original = claim ?? action;
    if (!original) throw new Error('FOCUSED_REVIEW_TARGET_UNKNOWN');
    if (result.verdict === 'pass' || result.verdict === 'hold') {
      if (result.replacement !== null) throw new Error('FOCUSED_REVIEW_UNEXPECTED_REPLACEMENT');
      if (result.verdict === 'pass') continue;
    } else {
      const replacement = result.replacement;
      if (!replacement || replacement.nodeType !== (claim ? 'claim' : 'action') || replacement.value.id !== result.targetId) {
        throw new Error('FOCUSED_REVIEW_REPLACEMENT_SCOPE_MISMATCH');
      }
      if (replacement.nodeType !== 'claim' && replacement.nodeType !== 'action') {
        throw new Error('FOCUSED_REVIEW_REPLACEMENT_SCOPE_MISMATCH');
      }
      if (isDeepStrictEqual(clinicalFields(original), clinicalFields(replacement.value))) {
        // 只可加入输入中真实的目录 ID；原有非目录引用可保留，不能趁本次核对新挂检索来源。
        if (replacement.value.knowledgeSourceIds.some((id) => !catalogIds.has(id) && !original.knowledgeSourceIds.includes(id))) {
          throw new Error('FOCUSED_REVIEW_KNOWLEDGE_SOURCE_OUTSIDE_SCOPE');
        }
        if (replacement.nodeType === 'claim') claims.set(result.targetId, replacement.value);
        else actions.set(result.targetId, replacement.value);
        continue;
      }
    }
    // 正文、个人证据、未知条件、日期和行动全部取原节点，不能采用来源复核的医学改写。
    const knowledgeSourceIds = original.knowledgeSourceIds.filter((id) => !catalogIds.has(id));
    if (claim) claims.set(result.targetId, { ...claim, knowledgeBasis: 'model_general', knowledgeSourceIds });
    else actions.set(result.targetId, { ...action!, knowledgeSourceIds });
  }
  const updated = { ...candidate, claims: [...claims.values()], actions: [...actions.values()] };
  const referencedIds = new Set([...updated.claims, ...updated.actions].flatMap((node) => node.knowledgeSourceIds));
  const existingIds = new Set(updated.knowledgeSources.map((source) => source.id));
  // 回执没有新增来源节点的权限；新增的真实目录引用由应用据输入目录生成规范元数据。
  updated.knowledgeSources = [...updated.knowledgeSources, ...catalogEntries
    .filter((entry) => referencedIds.has(entry.id) && !existingIds.has(entry.id))
    .map((entry) => ({ id: entry.id, title: entry.title, organization: entry.sourceOrganization,
      url: entry.sourceUrl, origin: 'catalog' as const, supports: entry.supportedScope }))];
  return pruneUnusedCatalogKnowledge(updated);
}

/**
 * 受控条目的标题与网址来自本次输入，不能由模型按相同 ID 偷换。
 * 已清理的书目可按当前真实引用补回；这只闭合元数据，不授予医学归属或联网读取凭据。
 */
export function canonicalizeAssessmentKnowledge(
  candidate: MemberAssessmentCandidateV3,
  evidencePackage: MemberEvidencePackageV3
): MemberAssessmentCandidateV3 {
  const catalogEntries = evidencePackage.knowledge.filter((entry, _index, entries) =>
    entries.filter((item) => item.id === entry.id).length === 1
    && memberEvidencePackageV3Schema.shape.knowledge.element.safeParse(entry).success && entry.content.trim().length > 0);
  const catalog = new Map(catalogEntries.map((entry) => [entry.id, entry]));
  const entriesByUrl = new Map<string, typeof evidencePackage.knowledge>();
  for (const entry of catalogEntries) {
    if (!entry.sourceUrl) continue;
    entriesByUrl.set(entry.sourceUrl, [...entriesByUrl.get(entry.sourceUrl) ?? [], entry]);
  }
  const aliases = new Map<string, string>();
  const sources = candidate.knowledgeSources.map((source) => {
    if (source.origin !== 'catalog' && !catalog.has(source.id)) return source;
    const exact = catalog.get(source.id);
    // 只允许本地目录中唯一且网址完全一致的条目纠正模型临时 ID；标题相似不够。
    const byUrl = source.url ? entriesByUrl.get(source.url) : undefined;
    const entry = exact ?? (byUrl?.length === 1 ? byUrl[0] : undefined);
    if (!entry) return source;
    aliases.set(source.id, entry.id);
    return {
      ...source,
      origin: 'catalog' as const,
      id: entry.id,
      title: entry.title,
      organization: entry.sourceOrganization,
      url: entry.sourceUrl,
      supports: entry.supportedScope
    };
  });
  const canonicalIds = (ids: string[]) => [...new Set(ids.map((id) => aliases.get(id) ?? id))];
  const claims = candidate.claims.map((claim) => ({ ...claim,
      knowledgeSourceIds: canonicalIds(claim.knowledgeSourceIds),
      criteriaBasis: claim.criteriaBasis && aliases.has(claim.criteriaBasis.sourceId)
        ? { ...claim.criteriaBasis, sourceId: aliases.get(claim.criteriaBasis.sourceId)! }
        : claim.criteriaBasis
    }));
  const actions = candidate.actions.map((action) => ({ ...action,
      knowledgeSourceIds: canonicalIds(action.knowledgeSourceIds)
    }));
  const referencedIds = new Set([
    ...claims.flatMap((claim) => [...claim.knowledgeSourceIds, ...(claim.criteriaBasis ? [claim.criteriaBasis.sourceId] : [])]),
    ...actions.flatMap((action) => action.knowledgeSourceIds)
  ]);
  const existingIds = new Set(sources.map((source) => source.id));
  for (const id of referencedIds) {
    const entry = catalog.get(id);
    if (existingIds.has(id) || !entry) continue;
    sources.push({ id: entry.id, title: entry.title, organization: entry.sourceOrganization,
      url: entry.sourceUrl, origin: 'catalog', supports: entry.supportedScope });
  }
  return { ...candidate, claims, actions,
    // 别名映射产生的完全相同书目可合并；同ID不同内容仍保留冲突供后续门禁拒绝。
    knowledgeSources: [...new Map(sources.map((source) => [stableHash(source), source])).values()]
  };
}

/** 真实正文读取与医学支持分开记录；单有网址仍只能标为模型引用。 */
export function buildAssessmentKnowledgeVerifications(
  candidate: MemberAssessmentCandidateV3,
  evidencePackage: MemberEvidencePackageV3,
  retrieved: readonly OfficialKnowledgeReceipt[] = []
): MemberAssessmentSnapshotV3['knowledgeVerifications'] {
  const catalog = new Map(evidencePackage.knowledge.map((entry) => [entry.id, entry]));
  return candidate.knowledgeSources.map((source) => {
    const entry = source.origin === 'catalog' ? catalog.get(source.id) : undefined;
    const reads = retrieved.filter((item) => item.sourceId === source.id && item.url === source.url);
    const receipt = reads.length === 1 ? reads[0] : undefined;
    return {
      sourceId: source.id,
      status: entry ? 'catalog_curated' : receipt ? 'tool_content_verified' : 'model_cited',
      checkedAt: entry?.reviewedAt ?? receipt?.checkedAt ?? null,
      contentHash: entry ? stableHash(entry.content) : receipt?.contentHash ?? null,
      toolReceiptId: entry ? null : receipt?.toolReceiptId ?? null
    };
  });
}
