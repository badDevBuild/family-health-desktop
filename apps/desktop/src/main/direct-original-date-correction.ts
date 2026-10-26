import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { directOriginalDateReadingSchema, directOriginalDateReviewCheckpointSchema,
  DIRECT_ORIGINAL_DATE_READING_VERSION, inspectDirectOriginalDateConsensus,
  type DirectOriginalDateReviewCheckpoint } from '@contracts';
import { stableHash } from '@core';
import { prepareDirectOriginalReport } from '@ingestion';
import type { JobExecutionGuard, WorkspaceStore } from '@storage';
import type { ExtractionPipelineResult } from './processing-pipeline.js';
import { HEALTH_MODEL_TURN_TIMEOUT_MS } from './ai-runtime-policy.js';
import { EXTRACTION_PROMPT_VERSION } from './prompts/shared.js';
import { buildBlindDateReadingPrompt } from './prompts/direct-original-date.js';
import { originalPreparationScheduler } from './original-preparation-scheduler.js';

interface DateReadingRuntime {
  runStructuredTurn(input: { prompt: string; imagePaths?: string[]; outputSchema: Record<string, unknown>;
    allowWebSearch?: boolean; timeoutMs?: number }): Promise<{ threadId: string; turnId: string; output: unknown }>;
}


/** 正式日期专用流程：完整原件两次盲读，应用仅投影日期，绝不重新提取医疗字段。 */
export class DirectOriginalDateCorrectionPipeline {
  constructor(private readonly store: WorkspaceStore, private readonly runtime: DateReadingRuntime,
    private readonly executionGuard: JobExecutionGuard,
    private readonly options: { prepareOriginal?: typeof prepareDirectOriginalReport; maxContextBytes?: number } = {}) {}

  private guard(documentId: string): void { this.store.assertJobExecutionActive(this.executionGuard, documentId); }

  private hold(documentId: string, reason: string, receipt?: { threadId: string; turnId: string }, reasons: string[] = []): ExtractionPipelineResult {
    this.guard(documentId);
    const bundle = this.store.getDocumentExtractionBundle(documentId);
    const issueId = this.store.saveDateCorrectionReviewIssue(this.executionGuard, documentId, [reason, ...reasons],
      bundle.manifest.spans.filter((span) => !span.modelEvidence).map((span) => span.id));
    return { status: 'partial', documentId, candidateCount: 0, issueId, reason, requiresUser: false,
      revision: this.store.getFactRevision(bundle.personId), ...receipt };
  }

  async process(documentId: string): Promise<ExtractionPipelineResult> {
    this.guard(documentId);
    if (!this.store.isDateCorrectionJob(this.executionGuard.jobId)) throw new Error('DATE_CORRECTION_SCOPE_INVALID');
    const scope = this.store.getDateCorrectionFactScopes(this.executionGuard, documentId);
    const bundle = this.store.getDocumentExtractionBundle(documentId);
    if (scope.appliedReceipt) return { status: 'published', documentId, candidateCount: 0,
      revision: this.store.getFactRevision(bundle.personId), ...scope.appliedReceipt };
    if (!scope.factScopes.length) return this.hold(documentId, 'DATE_CORRECTION_FACT_SCOPE_EMPTY');
    const original = this.store.getDocumentOriginalSource(documentId);
    if (original.documentId !== documentId || original.personId !== bundle.personId
      || original.sourceObjectId !== bundle.manifest.sourceObjectId || original.sha256 !== bundle.manifest.sha256
      || original.mediaType !== bundle.manifest.mediaType) throw new Error('DIRECT_ORIGINAL_SOURCE_IDENTITY_CHANGED');
    const converted = this.store.getDocumentConvertedView(documentId);
    if (converted && (converted.mediaType !== 'application/pdf' || converted.converterId !== 'libreoffice-headless')) {
      throw new Error('DIRECT_ORIGINAL_CONVERTED_VIEW_INVALID');
    }
    const prepared = await originalPreparationScheduler.run(() => this.guard(documentId),
      () => (this.options.prepareOriginal ?? prepareDirectOriginalReport)({ documentId,
      sourceObjectId: original.sourceObjectId, sha256: original.sha256, displayName: original.displayName,
      bytes: readFileSync(original.sourcePath), createdAt: bundle.manifest.createdAt,
      ...(converted ? { convertedPdf: { ...converted, mediaType: 'application/pdf' as const,
        converterId: 'libreoffice-headless' as const } } : {}) }));
    try {
      this.guard(documentId);
      const primary = bundle.manifest.spans.filter((span) => !span.modelEvidence);
      if (prepared.originalSha256 !== bundle.manifest.sha256 || prepared.totalUnits !== primary.length
        || stableHash(primary) !== stableHash(prepared.manifest.spans)
        || prepared.unitMappings.length !== primary.length
        || new Set(prepared.unitMappings.map((unit) => unit.sourceSpanId)).size !== primary.length
        || prepared.unitMappings.some((unit) => !primary.some((page) => page.id === unit.sourceSpanId))
        || prepared.imagePaths.length !== prepared.unitMappings.filter((unit) => unit.inputKind === 'image').length) {
        throw new Error('DIRECT_ORIGINAL_PREPARATION_STALE');
      }
      // 仅技术来源和本次原件内容，不发送旧引用、旧日期、文件名或上传时间。
      const source = { documentId, sourceObjectId: original.sourceObjectId, originalSha256: prepared.originalSha256,
        completeOriginal: true, totalUnits: prepared.totalUnits, units: prepared.unitMappings,
        images: prepared.imageMappings.map(({ path: _path, ...image }, imageIndex) => ({ ...image, imageIndex })),
        ...(prepared.nativeText === undefined ? {} : { nativeText: prepared.nativeText }),
        ...(prepared.convertedViewSha256 ? { convertedViewSha256: prepared.convertedViewSha256 } : {}) };
      // 冻结字段若本身包含年份/日期，则省略整个描述，不能从标题泄漏旧时间。
      const descriptor = (value: string | null) => value && !/\d{4}/u.test(value.normalize('NFKC')) ? value : null;
      const scopes = scope.factScopes.map((fact) => ({ scopeId: fact.scopeId, originalName: descriptor(fact.originalName),
        specimen: descriptor(fact.specimen), method: descriptor(fact.method), bodySite: descriptor(fact.bodySite) }));
      const body = buildBlindDateReadingPrompt(source, scopes);
      const maxBytes = this.options.maxContextBytes ?? 256 * 1024;
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('DIRECT_ORIGINAL_PROMPT_BUDGET_INVALID');
      if (Buffer.byteLength(body, 'utf8') + 40 > maxBytes) throw new Error('DIRECT_ORIGINAL_CONTEXT_LIMIT_EXCEEDED');
      const signature = stableHash({ purpose: 'date_correction', version: DIRECT_ORIGINAL_DATE_READING_VERSION,
        promptVersion: EXTRACTION_PROMPT_VERSION, modelId: scope.modelId, reasoningEffort: scope.reasoningEffort,
        jobId: this.executionGuard.jobId, source, scopeRevision: scope.scopeRevision, factScopesHash: stableHash(scope.factScopes) });
      const cached = this.store.getExtractionChunkCheckpoint(this.executionGuard, documentId, signature);
      const parsed = directOriginalDateReviewCheckpointSchema.safeParse(cached?.output);
      if (cached && !parsed.success) return this.hold(documentId, 'DATE_CORRECTION_CHECKPOINT_INVALID');
      let state: DirectOriginalDateReviewCheckpoint = parsed.success ? parsed.data : {
        checkpointKind: 'direct_original_date_blind', dateBlindVersion: DIRECT_ORIGINAL_DATE_READING_VERSION,
        scopeRevision: scope.scopeRevision, originalSha256: original.sha256, sourceObjectId: original.sourceObjectId,
        factScopesHash: stableHash(scope.factScopes), reads: [], failureCode: null };
      if (state.failureCode) return this.hold(documentId, state.failureCode, state.reads.at(-1)?.receipt);
      for (let index = state.reads.length; index < 2; index += 1) {
        this.guard(documentId);
        const transmissionId = this.store.beginAiTransmission({ guard: this.executionGuard, documentId,
          stage: index === 0 ? 'extract' : 'repair_extraction' });
        let result: Awaited<ReturnType<DateReadingRuntime['runStructuredTurn']>>;
        try {
          result = await this.runtime.runStructuredTurn({ prompt: `# DIRECT_ORIGINAL_P0${index === 0 ? '1' : '3'}\n${body}`,
            imagePaths: prepared.imagePaths, outputSchema: z.toJSONSchema(directOriginalDateReadingSchema,
              { target: 'draft-7' }) as Record<string, unknown>, allowWebSearch: false, timeoutMs: HEALTH_MODEL_TURN_TIMEOUT_MS });
          this.guard(documentId);
          z.object({ threadId: z.string().min(1), turnId: z.string().min(1) }).parse(result);
          const parsedReading = directOriginalDateReadingSchema.safeParse(result.output);
          this.store.finishDateCorrectionTransmission({ guard: this.executionGuard, documentId, transmissionId,
            inputSignature: signature, outputHash: stableHash(parsedReading.success ? parsedReading.data : result.output),
            threadId: result.threadId, turnId: result.turnId });
        } catch (error) { this.store.finishAiTransmission(transmissionId, 'unknown'); throw error; }
        const reading = directOriginalDateReadingSchema.safeParse(result.output);
        const receipt = { threadId: result.threadId, turnId: result.turnId };
        state = { ...state, reads: [...state.reads, { receipt, transmissionId,
          reading: reading.success ? reading.data : null, outputHash: stableHash(reading.success ? reading.data : result.output) }],
          failureCode: reading.success ? null : 'DATE_CORRECTION_READING_STRUCTURE_INVALID' };
        this.store.saveExtractionChunkCheckpoint({ guard: this.executionGuard, documentId, signature,
          chunkIndex: 0, output: state, ...receipt, extractionTurnId: state.reads[0]!.receipt.turnId });
        if (state.failureCode) return this.hold(documentId, state.failureCode, receipt);
      }
      const first = state.reads[0]!; const second = state.reads[1]!;
      const consensus = inspectDirectOriginalDateConsensus(first.reading!, second.reading!, { documentId,
        pageIds: primary.map((page) => page.id), factScopeIds: scope.factScopes.map((fact) => fact.scopeId),
        subjectPolicy: bundle.personAssignmentBasis === 'user_selected' || bundle.personAssignmentBasis === 'identity_confirmed'
          ? 'user_assigned' : 'require_source_identity',
        acceptedReportedNames: [bundle.personDisplayName, bundle.confirmedReportedName ?? '', ...bundle.confirmedPersonAliases] });
      if (first.receipt.threadId === second.receipt.threadId || first.receipt.turnId === second.receipt.turnId) {
        return this.hold(documentId, 'DATE_CORRECTION_READERS_NOT_INDEPENDENT', second.receipt);
      }
      if (consensus.issues.length) return this.hold(documentId, 'DATE_CORRECTION_READINGS_UNPROVEN', second.receipt, consensus.issues);
      try {
        const result = this.store.applyBlindDateCorrection(this.executionGuard, documentId);
        this.store.clearExtractionChunkCheckpoints(this.executionGuard, documentId);
        return { status: 'published', documentId, revision: result.revision, candidateCount: result.updatedCount, ...second.receipt };
      } catch (error) {
        if (error instanceof Error && ['DATE_CORRECTION_DATE_ONLY_ADMISSION_HELD', 'DATE_CORRECTION_REPORT_DATE_UNPROVEN',
          'DATE_CORRECTION_REPORT_SCOPE_AMBIGUOUS', 'DATE_CORRECTION_REPORT_METADATA_REQUIRED',
          'DATE_CORRECTION_METADATA_TIME_SCOPE_INCOMPLETE', 'DATE_CORRECTION_ORIGINAL_BINDING_UNPROVEN',
          'DATE_CORRECTION_CONTEXT_DATE_SCOPE_AMBIGUOUS'].includes(error.message)) {
          return this.hold(documentId, error.message, second.receipt);
        }
        throw error;
      }
    } finally { await prepared.cleanup(); }
  }
}
