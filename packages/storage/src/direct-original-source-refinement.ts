import { assembleDirectOriginalReadingRepair, directOriginalReadingRepairSchema, directOriginalReadingResultSchema,
  type DirectOriginalReadingRepair, type DirectOriginalReadingResult, type DirectOriginalRepairTarget,
  type ObservationCandidate, type SourceManifest } from '@contracts';
import { stableHash } from '@core';

export const DIRECT_ORIGINAL_SOURCE_REFINEMENT_VERSION = 'direct-original-source-refinement-v1' as const;

/** 永久记录和旧行指纹只留在应用内，不进入模型提示词。 */
export interface DirectOriginalSourceRefinementTarget {
  comparisonRecordKey: string;
  candidateKey: string;
  recordId: string;
  recordRevision: number;
  recordHash: string;
}

export interface DirectOriginalSourceRefinementReview {
  sourceObjectId: string;
  originalSha256: string;
  factRevision: number;
  firstReading: DirectOriginalReadingResult;
  repair: DirectOriginalReadingRepair;
  targets: DirectOriginalRepairTarget[];
  allowedPageSourceSpanIds: string[];
  refinementTargets: DirectOriginalSourceRefinementTarget[];
  firstTransmissionId: string;
  firstInputSignature: string;
  repairTransmissionId: string;
  repairInputSignature: string;
  /** 分包只是传输边界，完整结果仍一次组装、校验和提交。 */
  repairPlan?: DirectOriginalSourceRefinementPlanPart[] | undefined;
  repairParts?: DirectOriginalSourceRefinementPart[] | undefined;
}

export interface DirectOriginalSourceRefinementPlanPart {
  index: number;
  targets: DirectOriginalRepairTarget[];
  refinementTargets: DirectOriginalSourceRefinementTarget[];
  promptHash: string;
}

export interface DirectOriginalSourceRefinementPart {
  index: number;
  repair: DirectOriginalReadingRepair;
  repairTransmissionId: string;
  repairInputSignature: string;
}

export type DirectOriginalSourceRefinementContext = Omit<DirectOriginalSourceRefinementReview,
  'repair' | 'firstTransmissionId' | 'firstInputSignature' | 'repairTransmissionId' | 'repairInputSignature'
  | 'repairPlan' | 'repairParts'>;

/** 签名绑定应用实际点名的旧版本和本轮目标，不让模型回执自己扩大权限。 */
export function directOriginalSourceRefinementReviewSignature(context: DirectOriginalSourceRefinementContext): string {
  return stableHash({ version: DIRECT_ORIGINAL_SOURCE_REFINEMENT_VERSION,
    sourceObjectId: context.sourceObjectId, originalSha256: context.originalSha256, factRevision: context.factRevision,
    firstReading: context.firstReading, targets: context.targets,
    allowedPageSourceSpanIds: context.allowedPageSourceSpanIds, refinementTargets: context.refinementTargets });
}

/** 每个实际发送回执同时绑定完整原件上下文、全部分包计划和本包位置。 */
export function directOriginalSourceRefinementPartSignature(context: DirectOriginalSourceRefinementContext,
  plan: readonly DirectOriginalSourceRefinementPlanPart[], index: number): string {
  return stableHash({ version: 'direct-original-source-refinement-parts-v1',
    rootSignature: directOriginalSourceRefinementReviewSignature(context), plan, index });
}

export function assembleDirectOriginalRefinementParts(input: Pick<DirectOriginalSourceRefinementContext,
  'firstReading' | 'targets' | 'allowedPageSourceSpanIds'> & {
  repairPlan: readonly DirectOriginalSourceRefinementPlanPart[];
  repairParts: readonly DirectOriginalSourceRefinementPart[];
}): DirectOriginalReadingRepair {
  const { firstReading, targets, repairPlan: plan, repairParts: parts } = input;
  if (plan.length < 1 || plan.length !== parts.length || plan.some((part, index) => part.index !== index
    || !part.targets.length || !/^[a-f0-9]{64}$/u.test(part.promptHash))
    || parts.some((part, index) => part.index !== index)) invalid();
  const planned = plan.flatMap((part) => part.targets);
  if (new Set(planned.map((target) => target.targetId)).size !== targets.length
    || planned.length !== targets.length || planned.some((target) =>
      !targets.some((original) => stableHash(original) === stableHash(target)))) invalid();
  const results = new Map<string, DirectOriginalReadingRepair['results'][number]>();
  const sourceMappings: NonNullable<DirectOriginalReadingRepair['sourceMappings']> = [];
  for (const [index, part] of parts.entries()) {
    const repair = directOriginalReadingRepairSchema.parse(part.repair);
    const partTargets = plan[index]!.targets;
    const readableSources = new Set([...input.allowedPageSourceSpanIds,
      ...firstReading.sourceExcerpts.map((excerpt) => excerpt.localKey),
      ...repair.results.flatMap((entry) => entry.action !== 'replace' ? []
        : entry.replacement?.nodeType === 'excerpt' ? [entry.replacement.value.localKey]
          : entry.replacement?.nodeType === 'page' ? (entry.replacement.value.newExcerpts ?? []).map((excerpt) => excerpt.localKey) : [])]);
    const referencesReadableSources = (node: unknown): boolean => {
      if (Array.isArray(node)) return node.every(referencesReadableSources);
      if (node === null || typeof node !== 'object') return true;
      return Object.entries(node).every(([key, value]) => key === 'sourceSpanId'
        ? typeof value === 'string' && readableSources.has(value) : referencesReadableSources(value));
    };
    // B包不能预先引用只在A包回包中产生的新摘录；其输入并没有该来源的读取回执。
    if (repair.results.some((result) => !referencesReadableSources(result.replacement))) invalid();
    // 每包只能修改本包闭包，不能靠最后合并掩盖未经本包原件读取支持的跨包写入。
    assembleDirectOriginalReadingRepair({ original: firstReading, repair,
      originalReadingHash: stableHash(firstReading), targets: partTargets,
      allowedPageSourceSpanIds: input.allowedPageSourceSpanIds });
    for (const mapping of repair.sourceMappings ?? []) {
      if (!partTargets.some((target) => target.nodeType === 'candidate' && target.targetId === mapping.candidateKey)
        || mapping.relation === 'same_original_field' && !plan[index]!.refinementTargets.some((target) =>
          target.candidateKey === mapping.candidateKey && target.comparisonRecordKey === mapping.comparisonRecordKey)) invalid();
      sourceMappings.push(mapping);
    }
    repair.results.forEach((result) => results.set(result.targetId, result));
  }
  const repair = directOriginalReadingRepairSchema.parse({ schemaVersion: 1, documentId: firstReading.documentId,
    originalReadingHash: stableHash(firstReading), results: targets.map((target) => results.get(target.targetId)),
    ...(sourceMappings.length ? { sourceMappings } : {}) });
  assembleDirectOriginalReadingRepair({ original: firstReading, repair, originalReadingHash: stableHash(firstReading),
    targets, allowedPageSourceSpanIds: input.allowedPageSourceSpanIds });
  return repair;
}

export interface DirectOriginalSourceRefinementReceipt {
  transmissionId: string;
  stage: string;
  proofVersion: string;
  inputSignature: string;
  outputHash: string;
  threadId: string;
  turnId: string;
}

function invalid(): never { throw new Error('DIRECT_ORIGINAL_SOURCE_REFINEMENT_REVIEW_INVALID'); }

function mapSourceIds<T>(value: T, ids: ReadonlyMap<string, string>): T {
  if (Array.isArray(value)) return value.map((item) => mapSourceIds(item, ids)) as T;
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    key === 'sourceSpanId' && typeof item === 'string' ? ids.get(item) ?? item : mapSourceIds(item, ids)])) as T;
}

/** 只核验真实传输、完整原页及来源物化；医疗语义和同字段唯一性仍由核心独立校验。 */
export function verifyDirectOriginalSourceRefinementReview(input: {
  review: DirectOriginalSourceRefinementReview;
  documentId: string;
  factRevision: number;
  manifest: SourceManifest;
  receipts: readonly DirectOriginalSourceRefinementReceipt[];
}): Array<{ target: DirectOriginalSourceRefinementTarget; candidate: ObservationCandidate }> {
  const { review, manifest, documentId } = input;
  const first = directOriginalReadingResultSchema.parse(review.firstReading);
  const repair = directOriginalReadingRepairSchema.parse(review.repair);
  const pages = manifest.spans.filter((span) => !span.modelEvidence && span.documentId === documentId
    && ['image', 'page'].includes(span.spanKind));
  // 原页节点也可能是 native-text block；按允许页和父节点共同验完整集合。
  const parents = manifest.spans.filter((span) => !span.modelEvidence && span.documentId === documentId
    && span.blockId?.startsWith('direct-original-page:'));
  const pageIds = (parents.length ? parents : pages).map((span) => span.id).sort();
  if (review.sourceObjectId !== manifest.sourceObjectId || review.originalSha256 !== manifest.sha256
    || review.factRevision !== input.factRevision || first.documentId !== documentId || repair.documentId !== documentId
    || repair.originalReadingHash !== stableHash(first) || !pageIds.length
    || stableHash([...review.allowedPageSourceSpanIds].sort()) !== stableHash(pageIds)
    || first.pageReadings.length !== pageIds.length || first.pageReadings.some((page) => !pageIds.includes(page.sourceSpanId))
    || review.repairInputSignature !== directOriginalSourceRefinementReviewSignature(review)
    || review.firstTransmissionId === review.repairTransmissionId) invalid();
  const firstReceipt = input.receipts.find((receipt) => receipt.transmissionId === review.firstTransmissionId);
  if (!firstReceipt || firstReceipt.stage !== 'extract'
    || firstReceipt.proofVersion !== DIRECT_ORIGINAL_SOURCE_REFINEMENT_VERSION
    || firstReceipt.inputSignature !== review.firstInputSignature || firstReceipt.outputHash !== stableHash(first)
    || !firstReceipt.threadId || !firstReceipt.turnId) invalid();
  const repairReceipts = new Map<string, DirectOriginalSourceRefinementReceipt>();
  const repairByReceipt = new Map<string, DirectOriginalReadingRepair>();
  const expectedRepairs = review.repairPlan || review.repairParts ? (() => {
    if (!review.repairPlan || !review.repairParts
      || review.repairTransmissionId !== review.repairParts[0]?.repairTransmissionId) invalid();
    const mappings = review.repairPlan.flatMap((part) => part.refinementTargets);
    if (mappings.length !== review.refinementTargets.length
      || new Set(mappings.map((mapping) => stableHash(mapping))).size !== mappings.length
      || mappings.some((mapping) => !review.refinementTargets.some((target) => stableHash(target) === stableHash(mapping)))
      || review.repairPlan.some((part) => part.refinementTargets.some((mapping) =>
        !part.targets.some((target) => target.nodeType === 'candidate' && target.targetId === mapping.candidateKey)))
      || stableHash(assembleDirectOriginalRefinementParts({ ...review,
        repairPlan: review.repairPlan, repairParts: review.repairParts })) !== stableHash(repair)) invalid();
    return review.repairParts.map((part) => ({ ...part,
      expectedSignature: directOriginalSourceRefinementPartSignature(review, review.repairPlan!, part.index) }));
  })() : [{ repair, repairTransmissionId: review.repairTransmissionId,
    repairInputSignature: review.repairInputSignature, expectedSignature: review.repairInputSignature }];
  for (const part of expectedRepairs) {
    const receipt = input.receipts.find((item) => item.transmissionId === part.repairTransmissionId);
    if (!receipt || repairReceipts.has(receipt.transmissionId) || receipt.transmissionId === firstReceipt.transmissionId
      || receipt.stage !== 'repair_extraction' || receipt.proofVersion !== DIRECT_ORIGINAL_SOURCE_REFINEMENT_VERSION
      || part.repairInputSignature !== part.expectedSignature || receipt.inputSignature !== part.expectedSignature
      || receipt.outputHash !== stableHash(part.repair) || !receipt.threadId || !receipt.turnId
      || receipt.threadId === firstReceipt.threadId || receipt.turnId === firstReceipt.turnId
      || [...repairReceipts.values()].some((other) => other.threadId === receipt.threadId || other.turnId === receipt.turnId)) invalid();
    repairReceipts.set(receipt.transmissionId, receipt); repairByReceipt.set(receipt.transmissionId, part.repair);
  }
  const assembled = assembleDirectOriginalReadingRepair({ original: first, repair, originalReadingHash: stableHash(first),
    targets: review.targets, allowedPageSourceSpanIds: review.allowedPageSourceSpanIds });
  const changedExcerpts = new Map<string, DirectOriginalSourceRefinementReceipt>();
  for (const [id, part] of repairByReceipt) {
    const keys = part.results.flatMap((entry) => entry.action !== 'replace' ? []
      : entry.replacement?.nodeType === 'excerpt' ? [entry.replacement.value.localKey]
        : entry.replacement?.nodeType === 'page' ? (entry.replacement.value.newExcerpts ?? []).map((excerpt) => excerpt.localKey) : []);
    for (const key of keys) {
      if (changedExcerpts.has(key)) invalid();
      changedExcerpts.set(key, repairReceipts.get(id)!);
    }
  }
  const ids = new Map<string, string>();
  for (const excerpt of assembled.sourceExcerpts) {
    const receipt = changedExcerpts.get(excerpt.localKey) ?? firstReceipt;
    const id = `model-original-${stableHash({ documentId, originalSha256: manifest.sha256,
      parentId: excerpt.pageSourceSpanId, localKey: excerpt.localKey,
      receipt: { threadId: receipt.threadId, turnId: receipt.turnId }, quote: excerpt.quote, role: excerpt.role }).slice(0, 40)}`;
    const span = manifest.spans.find((item) => item.id === id);
    if (!span || span.documentId !== documentId || span.quote !== excerpt.quote
      || span.modelEvidence?.engine !== 'codex-original-reading-v1' || span.modelEvidence.modelId !== 'gpt-6.1-sol'
      || span.modelEvidence?.threadId !== receipt.threadId || span.modelEvidence.turnId !== receipt.turnId
      || span.modelEvidence.parentSourceSpanId !== excerpt.pageSourceSpanId || !pageIds.includes(excerpt.pageSourceSpanId)
      || span.modelEvidence.originalSha256 !== manifest.sha256
      || span.modelEvidence.originalSourceObjectId !== manifest.sourceObjectId
      || span.modelEvidence.role !== excerpt.role || span.modelEvidence.clarity !== excerpt.clarity) invalid();
    ids.set(excerpt.localKey, id);
  }
  const mappings = (repair.sourceMappings ?? []).filter((mapping) => mapping.relation === 'same_original_field');
  const selected: Array<{ target: DirectOriginalSourceRefinementTarget; candidate: ObservationCandidate }> = [];
  for (const mapping of mappings) {
    if (!review.targets.some((target) => target.nodeType === 'candidate' && target.targetId === mapping.candidateKey)) invalid();
    const targets = review.refinementTargets.filter((target) => target.comparisonRecordKey === mapping.comparisonRecordKey
      && target.candidateKey === mapping.candidateKey);
    if (targets.length !== 1) invalid();
    const candidate = assembled.extraction.candidates.find((item) => item.localKey === mapping.candidateKey);
    if (!candidate || selected.some((item) => item.target.recordId === targets[0]!.recordId)) invalid();
    selected.push({ target: targets[0]!, candidate: mapSourceIds(candidate, ids) });
  }
  return selected;
}
