import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  extractionResultSchema,
  type ExtractionResult,
  type ObservationCandidate,
  type ReviewCandidateDiff,
  type SourceManifest,
  type SourceSpan
} from '@contracts';
import { evaluateObservationCandidate, stableHash } from '@core';
import { buildPdfManifest, INGESTION_LIMITS, renderDocxImagesToFiles, renderHeicImagesToPngs, renderPdfPagesToPngs } from '@ingestion';
import type { JobExecutionGuard, WorkspaceStore } from '@storage';

interface StructuredRuntime {
  runStructuredTurn(input: {
    prompt: string;
    imagePaths?: string[];
    outputSchema: Record<string, unknown>;
    allowWebSearch?: boolean;
    timeoutMs?: number;
  }): Promise<{ threadId: string; turnId: string; output: unknown }>;
}

export type ExtractionPipelineResult =
  | { status: 'published'; documentId: string; revision: number; candidateCount: number; threadId: string; turnId: string }
  | { status: 'needs_review'; documentId: string; issueId: string; reason: string; threadId?: string; turnId?: string };

const outputSchema = z.toJSONSchema(extractionResultSchema, { target: 'draft-7' }) as Record<string, unknown>;
interface ImageMapping {
  imageIndex: number;
  page: number | null;
  sourceSpanIds: string[];
}

function historicalPdfSpansMatch(stored: SourceSpan[], rebuilt: SourceManifest): boolean {
  if (rebuilt.totalUnits !== stored.length || rebuilt.spans.length !== stored.length) return false;
  return stored.every((span, index) => {
    const current = rebuilt.spans[index];
    return current !== undefined
      && span.spanKind === 'page'
      && current.spanKind === 'page'
      && span.page === index + 1
      && current.page === span.page
      && span.blockId === current.blockId
      && span.lineStart === current.lineStart
      && span.lineEnd === current.lineEnd
      && span.quote === current.quote
      && span.readability === current.readability;
  });
}

type ReviewDiffField = ReviewCandidateDiff['fields'][number];

function normalizedComparableText(value: string | null): string | null {
  return value === null ? null : value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('zh-CN');
}

function comparableValue(candidate: ObservationCandidate): unknown {
  if (candidate.value.kind === 'numeric') {
    const numeric = Number(candidate.value.decimal);
    return {
      kind: candidate.value.kind,
      decimal: Number.isFinite(numeric) ? numeric : candidate.value.decimal,
      comparator: candidate.value.comparator
    };
  }
  if (candidate.value.kind === 'text') {
    return { kind: candidate.value.kind, rawText: normalizedComparableText(candidate.value.rawText) };
  }
  if (candidate.value.kind === 'qualitative') {
    return {
      kind: candidate.value.kind,
      rawText: normalizedComparableText(candidate.value.rawText),
      category: normalizedComparableText(candidate.value.category)
    };
  }
  return {
    kind: candidate.value.kind,
    rawText: normalizedComparableText(candidate.value.rawText),
    reason: normalizedComparableText(candidate.value.reason)
  };
}

function candidateConflictFields(first: ObservationCandidate, second: ObservationCandidate): ReviewDiffField[] {
  const fields: ReviewDiffField[] = [];
  const compareText = (
    field: Exclude<ReviewDiffField, 'presence' | 'value' | 'issues'>,
    firstValue: string | null,
    secondValue: string | null,
    allowOneSided = false
  ) => {
    if (allowOneSided && (firstValue === null || secondValue === null)) return;
    if (normalizedComparableText(firstValue) !== normalizedComparableText(secondValue)) fields.push(field);
  };

  compareText('originalName', first.originalName, second.originalName);
  compareText('standardNameCandidate', first.standardNameCandidate, second.standardNameCandidate);
  if (stableHash(comparableValue(first)) !== stableHash(comparableValue(second))) fields.push('value');
  compareText('unitRaw', first.unitRaw, second.unitRaw);
  compareText('referenceRangeRaw', first.referenceRangeRaw, second.referenceRangeRaw);
  compareText('reportedAbnormalFlag', first.reportedAbnormalFlag, second.reportedAbnormalFlag);
  compareText('specimen', first.specimen, second.specimen, true);
  compareText('method', first.method, second.method, true);
  compareText('bodySite', first.bodySite, second.bodySite, true);
  compareText('clinicalDate', first.clinicalDate, second.clinicalDate, true);

  const firstIssueCodes = [...new Set(first.issues.map((issue) => issue.code))].sort();
  const secondIssueCodes = [...new Set(second.issues.map((issue) => issue.code))].sort();
  if (stableHash(firstIssueCodes) !== stableHash(secondIssueCodes)) fields.push('issues');
  return fields;
}

/**
 * 独立复核用于发现临床事实冲突，而不是要求两轮输出的证据摘录和可选元数据逐字一致。
 * 一侧缺少标本、方法、部位或日期时，后续证据规则仍会逐项校验第二轮候选，因此不阻断。
 */
export function compareIndependentExtractions(
  first: ExtractionResult,
  second: ExtractionResult
): { compatible: boolean; differences: ReviewCandidateDiff[] } {
  const unmatchedSecond = new Set(second.candidates.map((_, index) => index));
  const differences: ReviewCandidateDiff[] = [];

  for (const firstCandidate of first.candidates) {
    const sameName = [...unmatchedSecond].filter((index) => (
      normalizedComparableText(second.candidates[index]!.originalName) === normalizedComparableText(firstCandidate.originalName)
    ));
    if (sameName.length === 0) {
      differences.push({ localKey: firstCandidate.localKey, itemName: firstCandidate.originalName, fields: ['presence'] });
      continue;
    }

    const ranked = sameName
      .map((index) => ({ index, fields: candidateConflictFields(firstCandidate, second.candidates[index]!) }))
      .sort((a, b) => a.fields.length - b.fields.length || a.index - b.index);
    const match = ranked[0]!;
    unmatchedSecond.delete(match.index);
    if (match.fields.length > 0) {
      const reviewedCandidate = second.candidates[match.index]!;
      differences.push({
        localKey: reviewedCandidate.localKey,
        itemName: reviewedCandidate.originalName,
        fields: match.fields
      });
    }
  }

  for (const index of unmatchedSecond) {
    const candidate = second.candidates[index]!;
    differences.push({ localKey: candidate.localKey, itemName: candidate.originalName, fields: ['presence'] });
  }
  return { compatible: differences.length === 0, differences };
}

function normalizedPersonName(value: string): string {
  return value.normalize('NFKC').replace(/[\s·•・·]/g, '').toLocaleLowerCase('zh-CN');
}

function subjectEvidenceIsValid(
  result: ExtractionResult,
  bundle: ReturnType<WorkspaceStore['getDocumentExtractionBundle']>
): boolean {
  if (result.subject.confidence !== 'explicit' || !result.subject.reportedName || result.subject.evidence.length === 0) return false;
  const spans = new Map(bundle.manifest.spans.map((span) => [span.id, span]));
  return result.subject.evidence.every((reference) => {
    const span = spans.get(reference.sourceSpanId);
    if (!span || !span.quote || !reference.quote) return false;
    const source = span.quote.normalize('NFKC').replace(/\s+/g, ' ').trim();
    const quote = reference.quote.normalize('NFKC').replace(/\s+/g, ' ').trim();
    return source.includes(quote) && normalizedPersonName(quote).includes(normalizedPersonName(result.subject.reportedName!));
  });
}

function subjectIsConsistent(
  result: ExtractionResult,
  bundle: ReturnType<WorkspaceStore['getDocumentExtractionBundle']>
): boolean {
  if (result.subject.confidence === 'absent' && result.subject.reportedName === null) {
    return bundle.personAssignmentBasis === 'user_selected' || bundle.personAssignmentBasis === 'folder_binding';
  }
  if (!subjectEvidenceIsValid(result, bundle)) return false;
  const expectedName = bundle.confirmedReportedName ?? bundle.personDisplayName;
  return normalizedPersonName(result.subject.reportedName!) === normalizedPersonName(expectedName);
}

function conflictingReportedName(
  result: ExtractionResult,
  bundle: ReturnType<WorkspaceStore['getDocumentExtractionBundle']>
): string | null {
  if (!subjectEvidenceIsValid(result, bundle) || !result.subject.reportedName) return null;
  const expectedName = bundle.confirmedReportedName ?? bundle.personDisplayName;
  return normalizedPersonName(result.subject.reportedName) === normalizedPersonName(expectedName)
    ? null
    : result.subject.reportedName;
}

function hasCompleteCoverage(result: ExtractionResult, expectedSpanIds: string[]): boolean {
  const covered = new Set(result.coveredSourceSpanIds);
  return covered.size === result.coveredSourceSpanIds.length
    && covered.size === expectedSpanIds.length
    && expectedSpanIds.every((id) => covered.has(id));
}

function evidenceIsConfinedToChunk(result: ExtractionResult, expectedSpanIds: string[]): boolean {
  const expected = new Set(expectedSpanIds);
  return result.subject.evidence.every((ref) => expected.has(ref.sourceSpanId))
    && result.candidates.every((candidate) => candidate.evidence.every((ref) => expected.has(ref.sourceSpanId)));
}

function needsVisualEvidence(span: SourceSpan): boolean {
  return span.readability !== 'clear' || !span.quote;
}

function estimatedSpanBytes(span: SourceSpan): number {
  return Buffer.byteLength(JSON.stringify({
    sourceSpanId: span.id,
    page: span.page,
    blockId: span.blockId,
    lineStart: span.lineStart,
    lineEnd: span.lineEnd,
    quote: span.quote,
    readability: span.readability
  }), 'utf8');
}

export function partitionSourceSpans(spans: SourceSpan[]): SourceSpan[][] {
  const chunks: SourceSpan[][] = [];
  let current: SourceSpan[] = [];
  let visualPages = new Set<number>();
  let currentBytes = 0;
  for (const span of spans) {
    const spanBytes = estimatedSpanBytes(span);
    if (spanBytes > INGESTION_LIMITS.maxSourcePackageBytes / 2) throw new Error('SOURCE_SPAN_PROMPT_LIMIT_EXCEEDED');
    const nextVisualPages = new Set(visualPages);
    if (needsVisualEvidence(span) && span.page !== null) nextVisualPages.add(span.page);
    if (current.length > 0 && (
      current.length >= INGESTION_LIMITS.maxSpansPerTurn
      || nextVisualPages.size > INGESTION_LIMITS.maxVisualPagesPerTurn
      || currentBytes + spanBytes > INGESTION_LIMITS.maxSourcePackageBytes / 2
    )) {
      chunks.push(current);
      current = [];
      visualPages = new Set<number>();
      currentBytes = 0;
    }
    current.push(span);
    currentBytes += spanBytes;
    if (needsVisualEvidence(span) && span.page !== null) visualPages.add(span.page);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export const partitionPdfSpans = partitionSourceSpans;

function buildSourcePackage(
  bundle: ReturnType<WorkspaceStore['getDocumentExtractionBundle']>,
  spans: SourceSpan[],
  imageMappings: ImageMapping[]
): string {
  return JSON.stringify({
    documentId: bundle.documentId,
    mediaType: bundle.manifest.mediaType,
    totalUnits: bundle.manifest.totalUnits,
    chunkUnitCount: spans.length,
    spans: spans.map((span) => ({
      sourceSpanId: span.id,
      page: span.page,
      blockId: span.blockId,
      lineStart: span.lineStart,
      lineEnd: span.lineEnd,
      quote: span.quote,
      readability: span.readability
    })),
    imageInputs: imageMappings
  });
}

function normalizeReportedAbnormalFlag(value: string | null): 'high' | 'low' | 'positive' | 'negative' | 'normal' | 'unknown' {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return 'unknown';
  if (['high', 'h', '偏高', '升高', '↑'].includes(normalized)) return 'high';
  if (['low', 'l', '偏低', '降低', '↓'].includes(normalized)) return 'low';
  if (['positive', '+', '阳性'].includes(normalized)) return 'positive';
  if (['negative', '-', '阴性'].includes(normalized)) return 'negative';
  if (['normal', '正常', '未见异常'].includes(normalized)) return 'normal';
  return 'unknown';
}

function candidateToObservation(candidate: ObservationCandidate, acceptanceId: string, documentId: string) {
  const firstEvidence = candidate.evidence[0];
  if (!firstEvidence) throw new Error('CANDIDATE_EVIDENCE_REQUIRED');
  const decimalValue = candidate.value.kind === 'numeric' ? candidate.value.decimal : null;
  const qualifier = candidate.value.kind === 'numeric'
    ? candidate.value.comparator
    : candidate.value.kind === 'qualitative' ? candidate.value.category : null;
  return {
    conceptKey: candidate.standardNameCandidate ?? candidate.originalName,
    rawText: candidate.value.rawText ?? '',
    valueKind: candidate.value.kind,
    decimalValue,
    qualifier,
    unit: candidate.unitRaw,
    referenceRange: candidate.referenceRangeRaw,
    clinicalDate: candidate.clinicalDate,
    abnormalFlag: normalizeReportedAbnormalFlag(candidate.reportedAbnormalFlag),
    documentId,
    sourceSpanId: firstEvidence.sourceSpanId,
    acceptanceId,
    specimen: candidate.specimen,
    method: candidate.method,
    bodySite: candidate.bodySite,
    evidence: candidate.evidence
  };
}

export class DocumentExtractionPipeline {
  constructor(
    private readonly store: WorkspaceStore,
    private readonly runtime: StructuredRuntime,
    private readonly executionGuard?: JobExecutionGuard
  ) {}

  private async runTurn(
    documentId: string,
    stage: string,
    input: Parameters<StructuredRuntime['runStructuredTurn']>[0]
  ): ReturnType<StructuredRuntime['runStructuredTurn']> {
    if (!this.executionGuard) return this.runtime.runStructuredTurn(input);
    this.store.assertJobExecutionActive(this.executionGuard, documentId);
    const transmissionId = this.store.beginAiTransmission({ guard: this.executionGuard, documentId, stage });
    try {
      const result = await this.runtime.runStructuredTurn(input);
      this.store.assertJobExecutionActive(this.executionGuard, documentId);
      this.store.finishAiTransmission(transmissionId, 'completed');
      return result;
    } catch (error) {
      this.store.finishAiTransmission(transmissionId, 'unknown');
      throw error;
    }
  }

  async process(documentId: string): Promise<ExtractionPipelineResult> {
    let bundle = this.store.getDocumentExtractionBundle(documentId);
    if (bundle.manifest.conversionWarnings.includes('historical_manifest_metadata_unavailable')) {
      if (bundle.manifest.mediaType !== 'application/pdf') throw new Error('LEGACY_MANIFEST_RECOVERY_UNSAFE');
      const bytes = readFileSync(bundle.sourcePath);
      const actualHash = createHash('sha256').update(bytes).digest('hex');
      if (actualHash !== bundle.manifest.sha256) throw new Error('LEGACY_PDF_SOURCE_HASH_MISMATCH');
      const rebuilt = await buildPdfManifest({
        sourceObjectId: bundle.manifest.sourceObjectId,
        documentId,
        sha256: actualHash,
        displayName: bundle.manifest.originalDisplayName,
        bytes,
        createdAt: bundle.manifest.createdAt
      });
      if (rebuilt.normalizerVersion !== bundle.manifest.normalizerVersion
        || !historicalPdfSpansMatch(bundle.manifest.spans, rebuilt)) {
        throw new Error('LEGACY_PDF_MANIFEST_RECOVERY_UNSAFE');
      }
      this.store.reconstructLegacyPdfManifest({
        documentId,
        sha256: actualHash,
        totalPages: rebuilt.totalUnits,
        normalizerVersion: rebuilt.normalizerVersion
      });
      bundle = this.store.getDocumentExtractionBundle(documentId);
    }
    const isImage = bundle.manifest.mediaType.startsWith('image/');
    const isHeic = ['image/heic', 'image/heif'].includes(bundle.manifest.mediaType);
    const isPdf = bundle.manifest.mediaType === 'application/pdf';
    const isDocx = bundle.manifest.mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (isDocx && bundle.manifest.conversionWarnings.some((warning) => warning.startsWith('docx_embedded_image_unsupported:'))) {
      return this.needsReview(
        documentId,
        'coverage_gap',
        bundle.manifest.spans.filter((span) => span.spanKind === 'image').map((span) => span.id),
        'DOCX_IMAGE_FORMAT_UNSUPPORTED'
      );
    }
    const hasDocxVisualEvidence = isDocx && bundle.manifest.spans.some((span) => span.spanKind === 'image' && span.readability !== 'unreadable');
    if (!isImage && !isPdf && !hasDocxVisualEvidence && bundle.manifest.spans.every((span) => !span.quote)) {
      return this.needsReview(documentId, 'coverage_gap', bundle.manifest.spans.map((span) => span.id), 'SOURCE_CONTENT_UNREADABLE');
    }
    // 在输入预算允许时保持整篇处理，以便模型联系摘要、检验页与结论页。
    // 只有视觉页数、片段数或字节预算触发硬限制时才保护性分块。
    const chunks = partitionSourceSpans(bundle.manifest.spans);
    const reviewedCandidates: ObservationCandidate[] = [];
    const coveredSourceSpanIds: string[] = [];
    const reviewReceipts: Array<{ extractTurnId: string; reviewTurnId: string }> = [];
    const reviewedSubjects: ExtractionResult['subject'][] = [];
    let lastReceipt: { threadId: string; turnId: string } | null = null;
    let temporaryRoot: string | null = null;
    try {
      for (const [chunkIndex, spans] of chunks.entries()) {
        const imagePaths: string[] = [];
        const imageMappings: ImageMapping[] = [];
        if (isImage && !isHeic) {
          imagePaths.push(bundle.sourcePath);
          imageMappings.push({ imageIndex: 0, page: 1, sourceSpanIds: spans.map((span) => span.id) });
        } else if (isHeic) {
          if (spans.some((span) => span.page === null)) {
            return this.needsReview(documentId, 'coverage_gap', spans.map((span) => span.id), 'HEIC_IMAGE_LOCATOR_MISSING');
          }
          temporaryRoot ??= mkdtempSync(join(tmpdir(), 'family-health-image-'));
          chmodSync(temporaryRoot, 0o700);
          const rendered = await renderHeicImagesToPngs({
            bytes: readFileSync(bundle.sourcePath),
            outputDirectory: join(temporaryRoot, `chunk-${chunkIndex + 1}`),
            imageIndexes: spans.map((span) => span.page!)
          });
          for (const [imageIndex, image] of rendered.entries()) {
            imagePaths.push(image.path);
            imageMappings.push({
              imageIndex,
              page: image.imageIndex,
              sourceSpanIds: spans.filter((span) => span.page === image.imageIndex).map((span) => span.id)
            });
          }
        } else if (isPdf) {
          const visualSpans = spans.filter(needsVisualEvidence);
          if (visualSpans.some((span) => span.page === null)) {
            return this.needsReview(documentId, 'coverage_gap', visualSpans.map((span) => span.id), 'PDF_VISUAL_PAGE_LOCATOR_MISSING');
          }
          const visualPages = [...new Set(visualSpans.map((span) => span.page!))];
          if (visualPages.length > 0) {
            temporaryRoot ??= mkdtempSync(join(tmpdir(), 'family-health-pdf-'));
            chmodSync(temporaryRoot, 0o700);
            const rendered = await renderPdfPagesToPngs({
              bytes: readFileSync(bundle.sourcePath),
              outputDirectory: join(temporaryRoot, `chunk-${chunkIndex + 1}`),
              pageNumbers: visualPages
            });
            for (const [imageIndex, page] of rendered.entries()) {
              imagePaths.push(page.path);
              imageMappings.push({
                imageIndex,
                page: page.page,
                sourceSpanIds: visualSpans.filter((span) => span.page === page.page).map((span) => span.id)
              });
            }
          }
        } else if (isDocx) {
          const visualSpans = spans.filter((span) => span.spanKind === 'image');
          const indexedSpans = visualSpans.map((span) => {
            const matched = /^image-(\d+)$/.exec(span.blockId ?? '');
            if (!matched) return null;
            return { span, imageIndex: Number(matched[1]) };
          });
          if (indexedSpans.some((entry) => entry === null)) {
            return this.needsReview(documentId, 'coverage_gap', visualSpans.map((span) => span.id), 'DOCX_IMAGE_LOCATOR_MISSING');
          }
          if (indexedSpans.length > 0) {
            temporaryRoot ??= mkdtempSync(join(tmpdir(), 'family-health-docx-'));
            chmodSync(temporaryRoot, 0o700);
            const rendered = await renderDocxImagesToFiles({
              bytes: readFileSync(bundle.sourcePath),
              outputDirectory: join(temporaryRoot, `chunk-${chunkIndex + 1}`),
              imageIndexes: indexedSpans.map((entry) => entry!.imageIndex)
            });
            for (const [imageIndex, image] of rendered.entries()) {
              imagePaths.push(image.path);
              imageMappings.push({
                imageIndex,
                page: null,
                sourceSpanIds: indexedSpans.filter((entry) => entry!.imageIndex === image.imageIndex).map((entry) => entry!.span.id)
              });
            }
          }
        }
        const sourcePackage = buildSourcePackage(bundle, spans, imageMappings);
        if (Buffer.byteLength(sourcePackage, 'utf8') > INGESTION_LIMITS.maxSourcePackageBytes) {
          throw new Error('SOURCE_PACKAGE_LIMIT_EXCEEDED');
        }
        const expectedSpanIds = spans.map((span) => span.id);
        const extract = await this.runTurn(documentId, 'extract', {
          prompt: [
            '你是健康报告事实提取器。只提取来源中明确出现的事实，不诊断、不推测、不提供处方。',
            `目标成员显示名为“${bundle.personDisplayName}”。必须单独返回 subject：报告明示姓名时逐字引用证据；未找到时标记 absent；不得根据目标成员反推姓名。`,
            '每个候选必须只引用本块 sourceSpanId；看不清时使用 unknown，不得编造值、单位、日期或成员身份。',
            'imageInputs 的 imageIndex 与随请求附带的图片顺序一一对应；图片来自原报告、PDF 对应页渲染或 DOCX 嵌入图，不是额外来源。',
            'coveredSourceSpanIds 必须逐一列出你实际检查过的本块全部来源片段，即使某片段没有可提取指标也不能省略。',
            `SOURCE_PACKAGE=${sourcePackage}`
          ].join('\n'),
          imagePaths,
          outputSchema,
          timeoutMs: 600_000
        });
        const extracted = extractionResultSchema.parse(extract.output);
        if (extracted.documentId !== documentId) throw new Error('EXTRACTION_DOCUMENT_MISMATCH');
        if (!hasCompleteCoverage(extracted, expectedSpanIds) || !evidenceIsConfinedToChunk(extracted, expectedSpanIds)) {
          return this.needsReview(documentId, 'coverage_gap', expectedSpanIds, 'EXTRACTION_COVERAGE_INCOMPLETE', extract.threadId, extract.turnId);
        }
        if (!subjectIsConsistent(extracted, bundle)) {
          const reportedName = conflictingReportedName(extracted, bundle);
          return this.needsReview(
            documentId,
            reportedName ? 'person_conflict' : 'field_conflict',
            extracted.subject.evidence.map((item) => item.sourceSpanId),
            'PERSON_IDENTITY_NOT_CONFIRMED',
            extract.threadId,
            extract.turnId,
            undefined,
            reportedName ?? undefined
          );
        }

        const review = await this.runTurn(documentId, 'review_facts', {
          prompt: [
            '你是独立事实复核器。重新阅读本块原始来源，并返回你核实后的完整候选集合。',
            '只保留来源明确支持且引用本块有效 sourceSpanId 的事实；不得因为前一份候选存在就默认接受。',
            'imageInputs 的 imageIndex 与随请求附带的图片顺序一一对应。',
            'coveredSourceSpanIds 必须逐一列出你实际检查过的本块全部来源片段。',
            `SOURCE_PACKAGE=${sourcePackage}`,
            `CANDIDATE_TO_REVIEW=${JSON.stringify(extracted)}`
          ].join('\n'),
          imagePaths,
          outputSchema,
          timeoutMs: 600_000
        });
        const reviewed = extractionResultSchema.parse(review.output);
        lastReceipt = { threadId: review.threadId, turnId: review.turnId };
        if (reviewed.documentId !== documentId) throw new Error('REVIEW_DOCUMENT_MISMATCH');
        if (!hasCompleteCoverage(reviewed, expectedSpanIds) || !evidenceIsConfinedToChunk(reviewed, expectedSpanIds)) {
          return this.needsReview(documentId, 'coverage_gap', expectedSpanIds, 'REVIEW_COVERAGE_INCOMPLETE', review.threadId, review.turnId);
        }
        if (!subjectIsConsistent(reviewed, bundle)) {
          const reportedName = conflictingReportedName(reviewed, bundle);
          return this.needsReview(
            documentId,
            reportedName ? 'person_conflict' : 'field_conflict',
            reviewed.subject.evidence.map((item) => item.sourceSpanId),
            'PERSON_IDENTITY_NOT_CONFIRMED',
            review.threadId,
            review.turnId,
            undefined,
            reportedName ?? undefined
          );
        }
        const comparison = compareIndependentExtractions(extracted, reviewed);
        if (!comparison.compatible) {
          const reviewedKeys = new Set(reviewed.candidates.map((candidate) => candidate.localKey));
          const missingCandidates = extracted.candidates.filter((candidate) => (
            !reviewedKeys.has(candidate.localKey)
            && comparison.differences.some((difference) => difference.localKey === candidate.localKey && difference.fields.includes('presence'))
          ));
          const reviewCandidates = [...reviewed.candidates, ...missingCandidates];
          return this.needsReview(
            documentId,
            'field_conflict',
            expectedSpanIds,
            'INDEPENDENT_REVIEW_MISMATCH',
            review.threadId,
            review.turnId,
            reviewCandidates.length > 0 ? reviewCandidates : extracted.candidates,
            undefined,
            comparison.differences
          );
        }
        reviewedCandidates.push(...reviewed.candidates);
        reviewedSubjects.push(reviewed.subject);
        coveredSourceSpanIds.push(...reviewed.coveredSourceSpanIds);
        reviewReceipts.push({ extractTurnId: extract.turnId, reviewTurnId: review.turnId });
        if (temporaryRoot) rmSync(join(temporaryRoot, `chunk-${chunkIndex + 1}`), { recursive: true, force: true });
      }
    } finally {
      if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
    }
    if (!lastReceipt) throw new Error('EXTRACTION_RECEIPT_MISSING');
    if (reviewedCandidates.length === 0) {
      return this.needsReview(documentId, 'coverage_gap', coveredSourceSpanIds, 'NO_EXTRACTABLE_FACTS_CONFIRMED', lastReceipt.threadId, lastReceipt.turnId);
    }
    const reviewed: ExtractionResult = {
      schemaVersion: 1,
      documentId,
      subject: reviewedSubjects[0]!,
      coveredSourceSpanIds,
      candidates: reviewedCandidates
    };
    const reviewRef = `chunk-review:${stableHash(reviewReceipts)}`;

    const accepted: Array<ReturnType<typeof candidateToObservation>> = [];
    for (const candidate of reviewed.candidates) {
      const outcome = evaluateObservationCandidate(candidate, bundle.manifest, {
        personConsistent: reviewedSubjects.every((subject) => stableHash(subject) === stableHash(reviewedSubjects[0])),
        overwritesUserLockedValue: false
      });
      const inputSignature = stableHash({ documentId, manifestSha256: bundle.manifest.sha256, candidate });
      const outputHash = stableHash({ candidate, outcome });
      const acceptanceId = this.store.saveAcceptanceDecision({
        method: 'auto',
        actor: 'policy',
        rulesVersion: 'health-acceptance-v2',
        inputSignature,
        outputHash,
        reviewRef,
        decision: outcome.decision
      });
      if (outcome.decision === 'reject' || outcome.decision === 'needs_review') {
        return this.needsReview(
          documentId,
          outcome.decision === 'reject' ? 'field_conflict' : 'coverage_gap',
          candidate.evidence.map((ref) => ref.sourceSpanId),
          outcome.decision === 'reject' ? outcome.reasons.join(',') : outcome.reasons.join(','),
          lastReceipt.threadId,
          lastReceipt.turnId,
          reviewed.candidates,
          undefined,
          outcome.decision === 'reject'
            ? [{ localKey: candidate.localKey, itemName: candidate.originalName, fields: ['issues'] }]
            : undefined
        );
      }
      accepted.push(candidateToObservation(candidate, acceptanceId, documentId));
    }

    const expectedRevision = this.store.getFactRevision(bundle.personId);
    const publication = this.store.publishFacts({
      personId: bundle.personId,
      documentId,
      documentCommitKey: stableHash({
        documentId,
        sourceSha256: bundle.manifest.sha256,
        normalizerVersion: bundle.manifest.normalizerVersion,
        extractionSchemaVersion: reviewed.schemaVersion,
        rulesVersion: 'health-acceptance-v2'
      }),
      expectedRevision,
      changeSetHash: stableHash({ documentId, reviewed, rulesVersion: 'health-acceptance-v2' }),
      summary: `从 1 份资料接纳 ${accepted.length} 条有来源事实`,
      observations: accepted,
      ...(this.executionGuard ? { executionGuard: this.executionGuard } : {})
    });
    return { status: 'published', documentId, revision: publication.revision, candidateCount: accepted.length, threadId: lastReceipt.threadId, turnId: lastReceipt.turnId };
  }

  private needsReview(
    documentId: string,
    kind: 'person_conflict' | 'field_conflict' | 'coverage_gap',
    evidenceRefs: string[],
    reason: string,
    threadId?: string,
    turnId?: string,
    candidateOptions?: ObservationCandidate[],
    reportedName?: string,
    candidateDiffs?: ReviewCandidateDiff[]
  ): ExtractionPipelineResult {
    const issueId = this.store.saveExtractionReviewIssue({
      documentId,
      kind,
      severity: 'blocking',
      evidenceRefs,
      ...(candidateOptions ? { candidateOptions } : {}),
      ...(reportedName ? { reportedName } : {}),
      ...(candidateDiffs ? { candidateDiffs } : {})
    });
    return {
      status: 'needs_review', documentId, issueId, reason,
      ...(threadId ? { threadId } : {}),
      ...(turnId ? { turnId } : {})
    };
  }
}
