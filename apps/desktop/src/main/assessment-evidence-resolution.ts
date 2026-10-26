import { stableHash } from '@core';
import type { ClinicalFocusedReviewV1, MemberAssessmentCandidateV3, MemberEvidenceRef } from '@contracts';

type Node = MemberAssessmentCandidateV3['claims'][number] | MemberAssessmentCandidateV3['actions'][number]
  | MemberAssessmentCandidateV3['questions'][number];

/** 仅应用根据本次真实输入和回执生成，不能从同ID或模型reason恢复权限。 */
export interface AssessmentEvidenceResolution {
  targetId: string;
  personId: string;
  inputSignature: string;
  originalHash: string;
  reviewedHash: string;
  sourceHashes: Array<{ id: string; hash: string }>;
  reboundEvidenceIds: string[];
  preservesSourceUncertainty: boolean;
  contextQuotes?: Array<{ field: 'rationale' | 'materialUncertainty' | 'changeAssessment.reason'; quote: string }>;
}

function node(candidate: MemberAssessmentCandidateV3, id: string): Node | null {
  const matches = [...candidate.claims, ...candidate.actions, ...candidate.questions].filter((item) => item.id === id);
  const other = [candidate.overview, ...candidate.systems, ...candidate.knowledgeSources].some((item) => item.id === id);
  return matches.length === 1 && !other ? matches[0]! : null;
}

function source(catalog: readonly MemberEvidenceRef[], id: string): MemberEvidenceRef | null {
  const matches = catalog.filter((item) => item.id === id);
  const value = matches.length === 1 ? matches[0] : undefined;
  return value && ['observation', 'clinical_finding', 'source_span'].includes(value.kind)
    && value.knowledgeId === null && value.documentId && value.sourceSpanId && value.quote?.trim() ? value : null;
}

/** 同一条已接纳事实或同一不可分割来源位置；同文档/页/同值均不能单独作为证明。 */
export function sameAssessmentFactLocation(left: MemberEvidenceRef, right: MemberEvidenceRef): boolean {
  if (!left.documentId || left.documentId !== right.documentId || !left.sourceSpanId || left.sourceSpanId !== right.sourceSpanId
    || left.eventId !== right.eventId || left.knowledgeId !== null || right.knowledgeId !== null
    || !left.quote?.trim() || left.quote !== right.quote || left.locator !== right.locator) return false;
  if (left.observationId || right.observationId) return Boolean(left.observationId) && left.observationId === right.observationId;
  return left.kind === right.kind && left.locator === right.locator && left.quote === right.quote;
}

const compact = (value: string) => value.normalize('NFKC').replace(/\s+/gu, '').replace(/[。.!！]+$/gu, '');

function missingStatementMatches(statement: string, subject: string): boolean {
  const value = compact(statement), label = compact(subject);
  // 仅单一缺资料断言；不把复合未知、条件或否定医学状态当成报告栏目缺失。
  if (!label || /[，,；;。！？?!:：]|(?:并且|而且|以及|或者|但是|如果|只有|除非|尚未|未知|不明)/u.test(label)) return false;
  return ['未提供', '尚未提供', '未记录', '未注明', '未说明', '不详', '未知'].some((suffix) => value === label + suffix)
    || ['缺少', '缺乏', '未提供'].some((prefix) => value === prefix + label);
}

function resolvedClaimShape(before: Node, after: Node, statement: string, quote: string): boolean {
  if (!('text' in before) || !('text' in after) || before.materialUncertainty !== statement
    || after.materialUncertainty !== quote) return false;
  // 只把“未提供”换成栏目原话；不推断该值明确，也不给置null或修改其他临床正文的权限。
  const shape = (value: typeof before) => ({ ...value, materialUncertainty: null, evidenceIds: [] });
  return stableHash(shape(before)) === stableHash(shape(after));
}

/**
 * 在主P04真实回包后授予窄权限；固定输入、逐字原文和完整节点hash三者缺一不可。
 * 来源是数据而不是授权；模型明确证明、当地唯一位置和最后全套临床门禁仍同时需要。
 */
export function buildAssessmentEvidenceResolutions(
  original: MemberAssessmentCandidateV3, reviewed: MemberAssessmentCandidateV3,
  review: ClinicalFocusedReviewV1, targetIds: readonly string[],
  suppliedCatalog: readonly MemberEvidenceRef[], evidenceCatalog: readonly MemberEvidenceRef[]
): AssessmentEvidenceResolution[] {
  if (original.personId !== review.personId || original.inputSignature !== review.inputSignature
    || original.personId !== reviewed.personId || original.inputSignature !== reviewed.inputSignature) return [];
  const grants: AssessmentEvidenceResolution[] = [];
  for (const result of review.results) {
    const proofs = result.evidenceResolutionProofs ?? [];
    if (result.verdict !== 'replace' || !targetIds.includes(result.targetId) || proofs.length === 0
      || review.results.filter((item) => item.targetId === result.targetId).length !== 1) continue;
    const before = node(original, result.targetId), after = node(reviewed, result.targetId);
    if (!before || !after || new Set(before.evidenceIds).size !== before.evidenceIds.length
      || new Set(after.evidenceIds).size !== after.evidenceIds.length
      || !result.replacement || stableHash(result.replacement.value) !== stableHash(after)) continue;
    const used = new Map<string, MemberEvidenceRef>();
    const frozenSource = (id: string) => {
      const actual = source(evidenceCatalog, id), supplied = source(suppliedCatalog, id);
      if (!actual || !supplied || stableHash(actual) !== stableHash(supplied)) return null;
      used.set(id, actual);
      return actual;
    };
    const rebound: string[] = [];
    let preservesSourceUncertainty = false, valid = true;
    const contextQuotes: NonNullable<AssessmentEvidenceResolution['contextQuotes']> = [];
    for (const proof of proofs) {
      if (proof.kind === 'same_fact_reference') {
        const from = frozenSource(proof.fromEvidenceId), to = frozenSource(proof.toEvidenceId);
        if (!from || !to || proof.fromEvidenceId === proof.toEvidenceId
          || !before.evidenceIds.includes(from.id) || !after.evidenceIds.includes(to.id)
          || before.evidenceIds.includes(to.id) || rebound.includes(to.id)
          || 'counterEvidenceIds' in before && before.counterEvidenceIds.includes(to.id)
          || !sameAssessmentFactLocation(from, to) || !proof.sourceQuote.trim()
          || !from.quote!.includes(proof.sourceQuote) || !to.quote!.includes(proof.sourceQuote)
          || from.quote!.split(proof.sourceQuote).length !== 2 || to.quote!.split(proof.sourceQuote).length !== 2) { valid = false; break; }
        rebound.push(to.id);
      } else if (proof.kind === 'source_context_text') {
        const ref = frozenSource(proof.evidenceId);
        const quote = proof.sourceQuote;
        const fieldText = 'text' in after ? proof.field === 'changeAssessment.reason'
          ? after.changeAssessment?.reason : after[proof.field] : null;
        // 只证明指定解释字段中的原话与来源一致；医学分类仍由P04判断，其他数字及结论继续严校验。
        if (!ref || !('text' in before) || !('text' in after) || before.kind !== 'interpretation' || after.kind !== 'interpretation'
          || !before.evidenceIds.includes(ref.id) || !after.evidenceIds.includes(ref.id)
          || before.counterEvidenceIds.includes(ref.id) || !quote.trim() || !/[\p{L}]/u.test(quote)
          || ref.quote!.split(quote).length !== 2 || !fieldText?.includes(quote)
          || fieldText.split(quote).length !== 2
          || contextQuotes.some((item) => item.field === proof.field && item.quote === quote)) { valid = false; break; }
        contextQuotes.push({ field: proof.field, quote });
      } else {
        const ref = frozenSource(proof.evidenceId);
        const segments = ref?.quote?.split(/[\n\r；;]/u).map((part) => part.trim()) ?? [];
        const separator = proof.sourceQuote.search(/[:：]/u);
        if (preservesSourceUncertainty || !ref || !before.evidenceIds.includes(ref.id) || !after.evidenceIds.includes(ref.id)
          || 'counterEvidenceIds' in before && before.counterEvidenceIds.includes(ref.id)
          || !missingStatementMatches(proof.uncertaintyText, proof.subject)
          || separator < 1 || compact(proof.sourceQuote.slice(0, separator)) !== compact(proof.subject)
          || segments.filter((part) => part === proof.sourceQuote).length !== 1
          || !resolvedClaimShape(before, after, proof.uncertaintyText, proof.sourceQuote)) { valid = false; break; }
        preservesSourceUncertainty = true;
      }
    }
    if (!valid || after.evidenceIds.some((id) => !before.evidenceIds.includes(id) && !rebound.includes(id))) continue;
    // 单纯改绑不授予正文修改权限。缺口修正的正文只由上面逐字证明授予。
    const fixed = (value: Node) => ({ ...value, evidenceIds: [] });
    if (contextQuotes.length > 0) {
      if (!('text' in before) || !('text' in after) || preservesSourceUncertainty || rebound.length > 0) continue;
      const shape = (value: typeof before) => {
        const projected = structuredClone(value);
        for (const { field } of contextQuotes) {
          if (field === 'changeAssessment.reason') {
            if (projected.changeAssessment) projected.changeAssessment.reason = '';
          } else if (field === 'materialUncertainty') projected.materialUncertainty = '';
          else projected.rationale = '';
        }
        // 知识归属收窄另走既有门禁；这份证明不能修改结论、比较方向或个人引用。
        return { ...projected, knowledgeBasis: null, knowledgeSourceIds: [] };
      };
      if (stableHash(shape(before)) !== stableHash(shape(after))) continue;
    } else if (!preservesSourceUncertainty && stableHash(fixed(before)) !== stableHash(fixed(after))) continue;
    grants.push({ targetId: result.targetId, personId: original.personId, inputSignature: original.inputSignature,
      originalHash: stableHash(before), reviewedHash: stableHash(after),
      sourceHashes: [...used.values()].map((ref) => ({ id: ref.id, hash: stableHash(ref) })),
      reboundEvidenceIds: rebound, preservesSourceUncertainty,
      ...(contextQuotes.length ? { contextQuotes } : {}) });
  }
  return grants;
}

export function validAssessmentEvidenceResolution(
  original: MemberAssessmentCandidateV3, reviewed: MemberAssessmentCandidateV3, targetId: string,
  evidenceCatalog: readonly MemberEvidenceRef[], grants: readonly AssessmentEvidenceResolution[]
): AssessmentEvidenceResolution | null {
  const matches = grants.filter((grant) => grant.targetId === targetId), grant = matches.length === 1 ? matches[0] : undefined;
  const before = node(original, targetId), after = node(reviewed, targetId);
  if (!grant || !before || !after || grant.personId !== original.personId || grant.personId !== reviewed.personId
    || grant.inputSignature !== original.inputSignature || grant.inputSignature !== reviewed.inputSignature
    || grant.originalHash !== stableHash(before) || grant.reviewedHash !== stableHash(after)
    || grant.sourceHashes.some((expected) => {
      const matches = evidenceCatalog.filter((item) => item.id === expected.id);
      return matches.length !== 1 || stableHash(matches[0]) !== expected.hash;
    })) return null;
  return grant;
}
