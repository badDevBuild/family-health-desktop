import { z } from 'zod';
import { extractionResultSchema, observationCandidateSchema, observationStructuredSlotEvidence, reportMetadataCandidateSchema,
  type ExtractionResult } from './index.js';

const keySchema = z.string().min(1).max(120);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const directOriginalExcerptRoleSchema = z.enum([
  'finding', 'heading', 'identity', 'date', 'instruction', 'context'
]);

/** 只记录真实模型调用和原件来源，不把模型转写伪装成本机 OCR 收据。 */
export const sourceModelEvidenceSchema = z.object({
  version: z.literal(1),
  engine: z.literal('codex-original-reading-v1'),
  modelId: keySchema,
  threadId: keySchema,
  turnId: keySchema,
  originalSha256: hashSchema,
  originalSourceObjectId: keySchema,
  parentSourceSpanId: keySchema,
  inputKind: z.enum(['image', 'native_text']),
  role: directOriginalExcerptRoleSchema,
  clarity: z.enum(['clear', 'uncertain'])
}).strict();
export type SourceModelEvidence = z.infer<typeof sourceModelEvidenceSchema>;

/** 分类不是删除许可；非检查内容也须保留原页引用，重复摘要须指向真实对应结果。 */
export const directOriginalInventoryClassificationSchema = z.object({
  disposition: z.enum(['education', 'reference', 'duplicate_summary']),
  evidence: z.array(z.object({ sourceSpanId: keySchema, quote: z.string().min(1).max(16_384) }).strict()).min(1).max(20),
  duplicateSourceSpanId: keySchema.nullable()
}).strict();

export const directOriginalPageReadingSchema = z.object({
  sourceSpanId: keySchema,
  status: z.enum(['read', 'partial', 'unreadable', 'no_medical_content']),
  pageRole: z.enum(['results', 'mixed', 'education', 'reference', 'cover', 'duplicate_summary', 'unknown']).optional(),
  // 兼容历史回执；新读取须先按原页盘点结果，再与候选对应，不能用“read”代替完整性检查。
  resultInventory: z.array(z.object({ sourceSpanId: keySchema,
    candidateKeys: z.array(keySchema).max(8_000),
    classification: directOriginalInventoryClassificationSchema.optional() }).strict()).max(8_000).optional()
}).strict();
export type DirectOriginalPageReading = z.infer<typeof directOriginalPageReadingSchema>;

export const directOriginalSourceExcerptSchema = z.object({
  localKey: keySchema,
  pageSourceSpanId: keySchema,
  quote: z.string().trim().min(1).max(16_384),
  role: directOriginalExcerptRoleSchema,
  clarity: z.enum(['clear', 'uncertain'])
}).strict();
export type DirectOriginalSourceExcerpt = z.infer<typeof directOriginalSourceExcerptSchema>;

export interface DirectOriginalReadingResult {
  schemaVersion: 1;
  documentId: string;
  pageReadings: DirectOriginalPageReading[];
  sourceExcerpts: DirectOriginalSourceExcerpt[];
  extraction: ExtractionResult;
}

/** 模型引用的是本次原页和局部 excerpt key，正式 span 编号只能由应用分配。 */
export const directOriginalReadingResultSchema: z.ZodType<DirectOriginalReadingResult> = z.object({
  schemaVersion: z.literal(1),
  documentId: keySchema,
  pageReadings: z.array(directOriginalPageReadingSchema).min(1).max(1_500),
  sourceExcerpts: z.array(directOriginalSourceExcerptSchema).max(8_000),
  // 延迟读取公共提取契约，避免聚合导出模块中的初始化循环。
  extraction: z.lazy(() => extractionResultSchema)
}).strict().superRefine((reading, context) => {
  if (reading.documentId !== reading.extraction.documentId) {
    context.addIssue({ code: 'custom', path: ['extraction', 'documentId'], message: 'DIRECT_ORIGINAL_DOCUMENT_MISMATCH' });
  }
  for (const [field, keys] of [
    ['pageReadings', reading.pageReadings.map((page) => page.sourceSpanId)],
    ['sourceExcerpts', reading.sourceExcerpts.map((excerpt) => excerpt.localKey)],
    ['candidates', reading.extraction.candidates.map((candidate) => candidate.localKey)]
  ] as const) {
    if (new Set(keys).size !== keys.length) context.addIssue({
      code: 'custom', path: [field], message: 'DIRECT_ORIGINAL_DUPLICATE_KEY'
    });
  }
  const nodeKeys = [...reading.pageReadings.map((page) => page.sourceSpanId),
    ...reading.sourceExcerpts.map((excerpt) => excerpt.localKey),
    ...reading.extraction.candidates.map((candidate) => candidate.localKey), 'subject', 'metadata'];
  if (new Set(nodeKeys).size !== nodeKeys.length) context.addIssue({
    code: 'custom', message: 'DIRECT_ORIGINAL_NODE_KEY_COLLISION'
  });
});

export const directOriginalRepairNodeTypeSchema = z.enum(['candidate', 'excerpt', 'metadata', 'subject', 'page']);
export type DirectOriginalRepairNodeType = z.infer<typeof directOriginalRepairNodeTypeSchema>;
export interface DirectOriginalRepairTarget { targetId: string; nodeType: DirectOriginalRepairNodeType }

/** 漏读原页的补救可以补该页发现，不只更改一个“已读”状态。非目标旧节点不可覆盖。 */
export const directOriginalPageRepairSchema = directOriginalPageReadingSchema.extend({
  newExcerpts: z.array(directOriginalSourceExcerptSchema).max(8_000).optional(),
  newCandidates: z.array(z.lazy(() => observationCandidateSchema)).max(8_000).optional()
}).strict();

const replacementSchema = z.discriminatedUnion('nodeType', [
  z.object({ nodeType: z.literal('candidate'), value: z.lazy(() => observationCandidateSchema) }).strict(),
  z.object({ nodeType: z.literal('excerpt'), value: directOriginalSourceExcerptSchema }).strict(),
  z.object({ nodeType: z.literal('metadata'), value: z.lazy(() => reportMetadataCandidateSchema).nullable() }).strict(),
  z.object({ nodeType: z.literal('subject'), value: z.lazy(() => extractionResultSchema.shape.subject) }).strict(),
  z.object({ nodeType: z.literal('page'), value: directOriginalPageRepairSchema }).strict()
]);

export const directOriginalReadingRepairSchema = z.object({
  schemaVersion: z.literal(1),
  documentId: keySchema,
  originalReadingHash: hashSchema,
  results: z.array(z.object({
    targetId: keySchema,
    action: z.enum(['replace', 'unchanged']),
    replacement: replacementSchema.nullable()
  }).strict()).min(1).max(10_000),
  // 只读旧记录仅可在这个专用槽中声明对应关系，不能成为替换目标或新来源。
  // 实际旧行、版本、原件和模型读取回执由应用另行核验，模型不提供写入权限。
  sourceMappings: z.array(z.object({
    candidateKey: keySchema,
    comparisonRecordKey: keySchema,
    relation: z.enum(['same_original_field', 'uncertain'])
  }).strict()).max(8_000).optional()
}).strict().superRefine((repair, context) => {
  const mappings = repair.sourceMappings ?? [];
  if (new Set(mappings.map((mapping) => mapping.candidateKey)).size !== mappings.length
    || new Set(mappings.map((mapping) => mapping.comparisonRecordKey)).size !== mappings.length) {
    context.addIssue({ code: 'custom', path: ['sourceMappings'], message: 'DIRECT_ORIGINAL_SOURCE_MAPPING_NOT_UNIQUE' });
  }
});
export type DirectOriginalReadingRepair = z.infer<typeof directOriginalReadingRepairSchema>;

function referencedExcerptKeys(reading: DirectOriginalReadingResult, candidateKey: string): string[] {
  const candidate = reading.extraction.candidates.find((item) => item.localKey === candidateKey);
  if (!candidate) return [];
  return [...candidate.evidence, ...(candidate.sourceBinding?.headingEvidence ?? []),
    ...(candidate.sourceBinding?.findingEvidence ?? []), ...(candidate.clinicalContext?.conditions ?? []),
    ...observationStructuredSlotEvidence(candidate)]
    .map((ref) => ref.sourceSpanId);
}

/** 修复只替换应用点名的节点；不得靠整份新回执改写已正确的非目标内容。 */
export function assembleDirectOriginalReadingRepair(input: {
  original: DirectOriginalReadingResult;
  repair: DirectOriginalReadingRepair;
  originalReadingHash: string;
  targets: DirectOriginalRepairTarget[];
  allowedPageSourceSpanIds: string[];
}): DirectOriginalReadingResult {
  const original = directOriginalReadingResultSchema.parse(input.original);
  const repair = directOriginalReadingRepairSchema.parse(input.repair);
  if (repair.documentId !== original.documentId || repair.originalReadingHash !== input.originalReadingHash) {
    throw new Error('DIRECT_ORIGINAL_REPAIR_SCOPE_MISMATCH');
  }
  const targets = new Map(input.targets.map((target) => [target.targetId, target]));
  if (targets.size !== input.targets.length || repair.results.length !== targets.size
    || new Set(repair.results.map((result) => result.targetId)).size !== targets.size
    || repair.results.some((result) => !targets.has(result.targetId))) {
    throw new Error('DIRECT_ORIGINAL_REPAIR_TARGET_MISMATCH');
  }
  const pages = new Set(input.allowedPageSourceSpanIds);
  const declaredPageExcerpts = repair.results.flatMap((result) => result.action === 'replace'
    && result.replacement?.nodeType === 'page' ? result.replacement.value.newExcerpts ?? [] : []);
  const assembled = structuredClone(original);
  for (const result of repair.results) {
    const target = targets.get(result.targetId)!;
    if (result.action === 'unchanged') {
      if (result.replacement !== null) throw new Error('DIRECT_ORIGINAL_REPAIR_UNEXPECTED_REPLACEMENT');
      continue;
    }
    const replacement = result.replacement;
    if (!replacement || replacement.nodeType !== target.nodeType) throw new Error('DIRECT_ORIGINAL_REPAIR_TYPE_MISMATCH');
    switch (replacement.nodeType) {
      case 'candidate': {
        if (replacement.value.localKey !== target.targetId) throw new Error('DIRECT_ORIGINAL_REPAIR_KEY_MISMATCH');
        const index = assembled.extraction.candidates.findIndex((item) => item.localKey === target.targetId);
        if (index < 0) throw new Error('DIRECT_ORIGINAL_REPAIR_TARGET_UNKNOWN');
        assembled.extraction.candidates[index] = replacement.value;
        break;
      }
      case 'excerpt': {
        if (replacement.value.localKey !== target.targetId || !pages.has(replacement.value.pageSourceSpanId)) {
          throw new Error('DIRECT_ORIGINAL_REPAIR_EXCERPT_SCOPE_MISMATCH');
        }
        // 一个来源片段可能被多人可见的多个节点复用。改来源也必须授权其全部引用目标。
        for (const candidate of original.extraction.candidates) {
          if (referencedExcerptKeys(original, candidate.localKey).includes(target.targetId)
            && !targets.has(candidate.localKey)) throw new Error('DIRECT_ORIGINAL_REPAIR_SHARED_EXCERPT_UNAUTHORIZED');
        }
        if (original.extraction.subject.evidence.some((ref) => ref.sourceSpanId === target.targetId)
          && ![...targets.values()].some((value) => value.nodeType === 'subject')) {
          throw new Error('DIRECT_ORIGINAL_REPAIR_SHARED_EXCERPT_UNAUTHORIZED');
        }
        const metadataRefs = original.extraction.reportMetadata
          ? Object.values(original.extraction.reportMetadata).flatMap((value) => {
            if (Array.isArray(value)) return value.flatMap((item) => item?.evidence ?? []);
            return value && typeof value === 'object' && 'evidence' in value ? value.evidence : [];
          }) : [];
        if (metadataRefs.some((ref) => ref.sourceSpanId === target.targetId)
          && ![...targets.values()].some((value) => value.nodeType === 'metadata')) {
          throw new Error('DIRECT_ORIGINAL_REPAIR_SHARED_EXCERPT_UNAUTHORIZED');
        }
        const index = assembled.sourceExcerpts.findIndex((item) => item.localKey === target.targetId);
        if (index < 0) assembled.sourceExcerpts.push(replacement.value);
        else assembled.sourceExcerpts[index] = replacement.value;
        break;
      }
      case 'metadata': assembled.extraction.reportMetadata = replacement.value; break;
      case 'subject': assembled.extraction.subject = replacement.value; break;
      case 'page': {
        if (replacement.value.sourceSpanId !== target.targetId || !pages.has(target.targetId)) {
          throw new Error('DIRECT_ORIGINAL_REPAIR_PAGE_SCOPE_MISMATCH');
        }
        const newExcerpts = replacement.value.newExcerpts ?? [];
        const newCandidates = replacement.value.newCandidates ?? [];
        const oldKeys = new Set([...assembled.pageReadings.map((page) => page.sourceSpanId),
          ...assembled.sourceExcerpts.map((excerpt) => excerpt.localKey),
          ...assembled.extraction.candidates.map((candidate) => candidate.localKey), 'subject', 'metadata']);
        const newKeys = [...newExcerpts.map((excerpt) => excerpt.localKey), ...newCandidates.map((candidate) => candidate.localKey)];
        if (new Set(newKeys).size !== newKeys.length || newKeys.some((key) => oldKeys.has(key))
          || newExcerpts.some((excerpt) => excerpt.pageSourceSpanId !== target.targetId)) {
          throw new Error('DIRECT_ORIGINAL_REPAIR_PAGE_ADDITION_SCOPE_MISMATCH');
        }
        const excerptsById = new Map([...assembled.sourceExcerpts, ...declaredPageExcerpts].map((excerpt) => [excerpt.localKey, excerpt]));
        for (const candidate of newCandidates) {
          const refs = [...candidate.evidence, ...(candidate.sourceBinding?.headingEvidence ?? []),
            ...(candidate.sourceBinding?.findingEvidence ?? []), ...(candidate.clinicalContext?.conditions ?? []),
            ...observationStructuredSlotEvidence(candidate)];
          const findings = candidate.sourceBinding?.findingEvidence ?? candidate.evidence.filter((ref) =>
            ['finding', 'instruction'].includes(excerptsById.get(ref.sourceSpanId)?.role ?? ''));
          if (refs.some((ref) => !excerptsById.has(ref.sourceSpanId)) || findings.length === 0
            || findings.some((ref) => excerptsById.get(ref.sourceSpanId)?.pageSourceSpanId !== target.targetId)) {
            throw new Error('DIRECT_ORIGINAL_REPAIR_PAGE_ADDITION_SOURCE_MISMATCH');
          }
        }
        assembled.sourceExcerpts.push(...newExcerpts);
        assembled.extraction.candidates.push(...newCandidates);
        const previousPage = assembled.pageReadings.find((page) => page.sourceSpanId === target.targetId);
        const inventory = replacement.value.resultInventory ?? previousPage?.resultInventory;
        const pageReading = { sourceSpanId: replacement.value.sourceSpanId, status: replacement.value.status,
          ...(replacement.value.pageRole === undefined ? {} : { pageRole: replacement.value.pageRole }),
          ...(inventory === undefined ? {} : { resultInventory: inventory }) };
        const index = assembled.pageReadings.findIndex((page) => page.sourceSpanId === target.targetId);
        if (index < 0) assembled.pageReadings.push(pageReading);
        else assembled.pageReadings[index] = pageReading;
        // 覆盖只表示该原页的模型读取回执，不生成不存在的医学结果。
        if (!assembled.extraction.coveredSourceSpanIds.includes(target.targetId)) {
          assembled.extraction.coveredSourceSpanIds.push(target.targetId);
        }
        break;
      }
    }
  }
  return directOriginalReadingResultSchema.parse(assembled);
}
