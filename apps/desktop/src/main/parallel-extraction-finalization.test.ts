import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { directOriginalReadingResultSchema, type DirectOriginalReadingResult,
  type DirectOriginalReadingRepair, type DirectOriginalRepairTarget, type SourceManifest } from '@contracts';
import { stableHash } from '@core';
import type { PreparedOriginalModelInput } from '@ingestion';
import { WorkspaceStore } from '@storage';
import { DirectOriginalExtractionPipeline, type WithSerializedDirectOriginalFinalization } from './direct-original-extraction.js';
import { decodeDirectOriginalInput } from './direct-original-input.js';
import { encodeDirectOriginalReading, encodeDirectOriginalRepair } from './direct-original-wire.js';
import { ACCEPTANCE_RULES_VERSION, EXTRACTION_PROMPT_VERSION } from './prompts/shared.js';
import { createReportFinalizationGate } from './report-read-scheduler.js';

const fixtures: { store: WorkspaceStore; rootDirectory: string }[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const { store, rootDirectory } of fixtures.splice(0)) {
    store.close(); rmSync(rootDirectory, { recursive: true, force: true });
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(pages = 1) {
  const rootDirectory = mkdtempSync(join(tmpdir(), 'family-health-parallel-finalization-'));
  const store = new WorkspaceStore({ rootDirectory });
  fixtures.push({ store, rootDirectory });
  const person = store.createPerson({ displayName: '合成并行成员' });
  const documents = ['a', 'b'].map((key) => {
    const source = store.putSourceObject({ bytes: Buffer.from(`合成并行原件 ${key}`), mediaType: 'image/png', displayName: `合成${key}.png` });
    const { documentId } = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const manifest: SourceManifest = { id: `synthetic-parallel-manifest-${key}`, sourceObjectId: source.id, sha256: source.sha256,
      mediaType: 'image/png', originalDisplayName: `合成${key}.png`, totalUnits: pages,
      coveredUnitIndexes: Array.from({ length: pages }, (_, index) => index),
      normalizerVersion: 'direct-original-preparation-v1', conversionWarnings: [], createdAt: '2026-01-03T00:00:00Z',
      spans: Array.from({ length: pages }, (_, index) => ({ id: `synthetic-parallel-page-${key}-${index + 1}`, documentId,
        spanKind: 'image', page: index + 1, blockId: `direct-original-page:${index + 1}`,
        lineStart: null, lineEnd: null, quote: null, readability: 'unreadable' })) };
    store.saveSourceManifest(manifest);
    const cleanup = vi.fn(async () => undefined);
    const imagePaths = manifest.spans.map((_, index) => `/synthetic-parallel/${key}-${index + 1}.png`);
    const prepared: PreparedOriginalModelInput = { manifest, originalSha256: source.sha256, totalUnits: pages,
      tempRoot: `/synthetic-parallel/${key}`, cleanup, imagePaths,
      imageMappings: manifest.spans.map((span, index) => ({ inputKind: 'image', page: index + 1, sourceSpanId: span.id,
        path: imagePaths[index]!, mediaType: 'image/png', sha256: source.sha256, width: 1000, height: 1200 })),
      unitMappings: manifest.spans.map((span, index) => ({ inputKind: 'image', page: index + 1, sourceSpanId: span.id })) };
    return { documentId, manifest, prepared, cleanup, prepareOriginal: vi.fn(async () => prepared) };
  });
  const accountFingerprint = 'synthetic-parallel-account';
  const consentId = store.createManualProcessingConsent({ documentIds: documents.map((doc) => doc.documentId),
    personIds: [person.id], accountFingerprint, version: 1 });
  store.createWaitingAuthBatch({ cutoff: '2026-01-03T00:00:00Z', initialStatus: 'queued', consentId,
    groups: [{ personId: person.id, documentIds: documents.map((doc) => doc.documentId), inputSignature: 'synthetic-parallel-job' }] });
  const job = store.claimNextQueuedJob('synthetic-parallel-runner', accountFingerprint)!;
  const attemptId = store.startJobAttempt(job.id, 'synthetic-runtime', 'gpt-6.1-sol', 'medium');
  return { store, person, documents, guard: { jobId: job.id, attemptId, consentId, accountFingerprint } };
}
type Fixture = ReturnType<typeof fixture>;
type Document = Fixture['documents'][number];

function reading(doc: Document, needsRepair = false): DirectOriginalReadingResult {
  const finding = { sourceSpanId: 'e_result', quote: '合成甲项 7 U/L' };
  const result: DirectOriginalReadingResult = { schemaVersion: 1, documentId: doc.documentId,
    pageReadings: doc.manifest.spans.map((span, index) => ({ sourceSpanId: span.id,
      status: index === doc.manifest.spans.length - 1 ? 'read' : 'no_medical_content',
      resultInventory: index === doc.manifest.spans.length - 1 ? [{ sourceSpanId: 'e_result', candidateKeys: ['c_result'] }] : [] })),
    sourceExcerpts: [{ localKey: 'e_result', pageSourceSpanId: doc.manifest.spans.at(-1)!.id,
      quote: finding.quote, role: 'finding', clarity: 'clear' }],
    extraction: { schemaVersion: 1, documentId: doc.documentId,
      subject: { reportedName: null, confidence: 'absent', evidence: [] }, reportMetadata: null,
      coveredSourceSpanIds: doc.manifest.spans.map((span) => span.id), candidates: [{ localKey: 'c_result',
        originalName: '合成甲项', standardNameCandidate: null, value: { kind: 'numeric', rawText: '7', decimal: '7', comparator: 'eq' },
        unitRaw: 'U/L', referenceRangeRaw: null, reportedAbnormalFlag: null, specimen: null, method: null, bodySite: null,
        clinicalDate: null, clinicalContext: { version: 1, status: 'complete', conditions: [] }, evidence: [finding],
        sourceBinding: { headingEvidence: [], findingEvidence: [finding] }, issues: [] }] } };
  if (needsRepair) {
    result.pageReadings[0]!.status = 'read';
    result.pageReadings[0]!.resultInventory!.push({ sourceSpanId: 'e_unproven', candidateKeys: ['c_unproven'] });
    result.sourceExcerpts.push({ localKey: 'e_unproven', pageSourceSpanId: doc.manifest.spans[0]!.id,
      quote: '合成乙项 9 U/L', role: 'finding', clarity: 'clear' });
    result.extraction.candidates.push({ ...structuredClone(result.extraction.candidates[0]!), localKey: 'c_unproven',
      originalName: '合成乙项', value: { kind: 'numeric', rawText: '9', decimal: '8', comparator: 'eq' },
      evidence: [{ sourceSpanId: 'e_unproven', quote: '合成乙项 9 U/L' }],
      sourceBinding: { headingEvidence: [], findingEvidence: [{ sourceSpanId: 'e_unproven', quote: '合成乙项 9 U/L' }] } });
  }
  return result;
}

function unchangedRepair(original: DirectOriginalReadingResult, prompt: string): DirectOriginalReadingRepair {
  const request = prompt.split('\n').find((line) => line.startsWith('REPAIR_REQUEST='))!;
  const { targets } = decodeDirectOriginalInput('REPAIR_REQUEST', JSON.parse(request.slice('REPAIR_REQUEST='.length))) as { targets: DirectOriginalRepairTarget[] };
  return { schemaVersion: 1, documentId: original.documentId,
    originalReadingHash: stableHash(directOriginalReadingResultSchema.parse(original)),
    results: targets.map((target) => ({ targetId: target.targetId, action: 'unchanged', replacement: null })) };
}
function receipt(doc: Document, output: unknown, stage: string) {
  return { threadId: `synthetic-parallel-thread-${doc.documentId}-${stage}`, turnId: `synthetic-parallel-turn-${doc.documentId}-${stage}`, output };
}
function checkpoint(f: Fixture, doc: Document) {
  return f.store.getExtractionChunkCheckpoint(f.guard, doc.documentId, stableHash({ documentId: doc.documentId,
    originalSha256: doc.prepared.originalSha256, modelId: 'gpt-6.1-sol', promptVersion: EXTRACTION_PROMPT_VERSION,
    rulesVersion: ACCEPTANCE_RULES_VERSION, units: doc.prepared.unitMappings,
    nativeTextHash: stableHash(''), convertedViewSha256: null }));
}
function serialGate() {
  let tail = Promise.resolve();
  const calls: string[] = [];
  const run: WithSerializedDirectOriginalFinalization = (operation) => {
    calls.push('queued');
    const result = tail.then(operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  return { run, calls };
}
function pipeline(f: Fixture, doc: Document, runtime: { runStructuredTurn: ReturnType<typeof vi.fn> }, gate: WithSerializedDirectOriginalFinalization) {
  return new DirectOriginalExtractionPipeline(f.store, runtime, f.guard,
    { prepareOriginal: doc.prepareOriginal, withSerializedFinalization: gate });
}

describe('并行原件读取与有序接纳', () => {
  it('P01可同时运行且先存回执，P03至发布保持串行并在前份发布后重新预检', async () => {
    const f = fixture(); const [a, b] = f.documents as [Document, Document];
    const gate = serialGate(); const aRead = deferred<void>(); const bRead = deferred<void>();
    const aRepair = deferred<void>(); const aRepairStarted = deferred<void>();
    const first = reading(a, true); const second = reading(b, true);
    const runtimeA = { runStructuredTurn: vi.fn(async ({ prompt }: { prompt: string }) => {
      if (prompt.startsWith('# DIRECT_ORIGINAL_P01')) { await aRead.promise; return receipt(a, encodeDirectOriginalReading(first), 'p01'); }
      aRepairStarted.resolve(undefined); await aRepair.promise;
      return receipt(a, encodeDirectOriginalRepair(unchangedRepair(first, prompt)), 'p03');
    }) };
    const runtimeB = { runStructuredTurn: vi.fn(async ({ prompt }: { prompt: string }) => {
      if (prompt.startsWith('# DIRECT_ORIGINAL_P01')) { await bRead.promise; return receipt(b, encodeDirectOriginalReading(second), 'p01'); }
      return receipt(b, encodeDirectOriginalRepair(unchangedRepair(second, prompt)), 'p03');
    }) };
    const seenRevisions: { documentId: string; revision: number }[] = [];
    const preview = f.store.previewDirectOriginalAdmission.bind(f.store);
    vi.spyOn(f.store, 'previewDirectOriginalAdmission').mockImplementation((input) => {
      seenRevisions.push({ documentId: input.documentId, revision: f.store.getFactRevision(f.person.id) });
      return preview(input);
    });
    const resultA = pipeline(f, a, runtimeA, gate.run).process(a.documentId);
    const resultB = pipeline(f, b, runtimeB, gate.run).process(b.documentId);
    await vi.waitFor(() => { expect(runtimeA.runStructuredTurn).toHaveBeenCalledTimes(1); expect(runtimeB.runStructuredTurn).toHaveBeenCalledTimes(1); });
    aRead.resolve(undefined); await aRepairStarted.promise; bRead.resolve(undefined);
    await vi.waitFor(() => expect(gate.calls).toHaveLength(2));
    expect(checkpoint(f, b)?.output).toMatchObject({ checkpointKind: 'direct_original_reading', repairAttempted: false });
    expect(runtimeB.runStructuredTurn).toHaveBeenCalledTimes(1);
    expect(f.store.getFactRevision(f.person.id)).toBe(0);
    expect(b.cleanup).not.toHaveBeenCalled();
    aRepair.resolve(undefined);
    expect(await resultA).toMatchObject({ status: 'partial', revision: 1, candidateCount: 1 });
    expect(await resultB).toMatchObject({ status: 'partial', revision: 2, candidateCount: 1 });
    expect(seenRevisions.filter((item) => item.documentId === b.documentId).map((item) => item.revision)).toEqual([1, 1]);
    expect(f.store.listAcceptedObservations(f.person.id).map((item) => item.documentId).sort()).toEqual([a.documentId, b.documentId].sort());
    expect(a.cleanup).toHaveBeenCalledOnce(); expect(b.cleanup).toHaveBeenCalledOnce();
  });

  it('已接纳报告重核的P03来源证明冻结最新revision，并保护旧医疗字段', async () => {
    const f = fixture(2); const [a, b] = f.documents as [Document, Document]; const gate = serialGate();
    const instruction = '合成安排：合成文字结果。';
    const originals = new Map(f.documents.map((doc) => {
      const original = reading(doc, true); const candidate = original.extraction.candidates[0]!;
      candidate.originalName = '合成安排'; candidate.value = { kind: 'text', rawText: instruction }; candidate.unitRaw = null;
      candidate.evidence = [{ sourceSpanId: 'e_result', quote: instruction }];
      candidate.sourceBinding = { headingEvidence: [], findingEvidence: [...candidate.evidence] };
      original.sourceExcerpts[0] = { ...original.sourceExcerpts[0]!, quote: instruction, role: 'instruction' };
      return [doc.documentId, original] as const;
    }));
    for (const doc of f.documents) {
      const original = originals.get(doc.documentId)!;
      const runtime = { runStructuredTurn: vi.fn(async ({ prompt }: { prompt: string }) => receipt(doc,
        prompt.startsWith('# DIRECT_ORIGINAL_P01') ? encodeDirectOriginalReading(original)
          : encodeDirectOriginalRepair(unchangedRepair(original, prompt)), prompt.startsWith('# DIRECT_ORIGINAL_P01') ? 'initial-p01' : 'initial-p03')) };
      expect(await pipeline(f, doc, runtime, gate.run).process(doc.documentId)).toMatchObject({ status: 'partial', candidateCount: 1 });
    }
    expect(f.store.getFactRevision(f.person.id)).toBe(2);
    const previous = f.store.listAcceptedObservations(f.person.id);
    const started = deferred<void>(); const release = deferred<void>();
    const reviewedRevisions: { documentId: string; revision: number }[] = [];
    const preview = f.store.previewDirectOriginalAdmission.bind(f.store);
    vi.spyOn(f.store, 'previewDirectOriginalAdmission').mockImplementation((input) => {
      if (input.sourceRefinementReview) reviewedRevisions.push({ documentId: input.documentId,
        revision: input.sourceRefinementReview.factRevision });
      return preview(input);
    });
    const recheckRuntime = (doc: Document) => {
      const next = structuredClone(originals.get(doc.documentId)!);
      next.sourceExcerpts[0]!.quote = `合成段落起始\n${instruction}\n合成段落结束`;
      next.sourceExcerpts.push({ localKey: 'e_heading', pageSourceSpanId: doc.manifest.spans[0]!.id,
        quote: '合成安排', role: 'heading', clarity: 'clear' });
      next.extraction.candidates[0]!.sourceBinding!.headingEvidence = [{ sourceSpanId: 'e_heading', quote: '合成安排' }];
      next.extraction.candidates[1]!.value = { kind: 'numeric', rawText: '9', decimal: '9', comparator: 'eq' };
      return { runStructuredTurn: vi.fn(async ({ prompt }: { prompt: string }) => {
        if (prompt.startsWith('# DIRECT_ORIGINAL_P01')) return receipt(doc, encodeDirectOriginalReading(next), 'recheck-p01');
        const contextLine = prompt.split('\n').find((line) => line.startsWith('READ_ONLY_PAGE_CONTEXT='))!;
        const context = decodeDirectOriginalInput('READ_ONLY_PAGE_CONTEXT', JSON.parse(contextLine.slice('READ_ONLY_PAGE_CONTEXT='.length))) as {
          reconciliationDiagnostics: { targetId: string; comparisonRefs: string[] }[] };
        const mapping = context.reconciliationDiagnostics.find((item) => item.targetId === 'c_result')!;
        expect(mapping.comparisonRefs).not.toEqual([]);
        if (doc.documentId === a.documentId) { started.resolve(undefined); await release.promise; }
        const patch = unchangedRepair(next, prompt);
        patch.sourceMappings = [{ candidateKey: 'c_result', comparisonRecordKey: mapping.comparisonRefs[0]!, relation: 'same_original_field' }];
        return receipt(doc, encodeDirectOriginalRepair(patch), 'recheck-p03');
      }) };
    };
    const runtimeA = recheckRuntime(a); const runtimeB = recheckRuntime(b);
    const resultA = pipeline(f, a, runtimeA, gate.run).process(a.documentId); await started.promise;
    const resultB = pipeline(f, b, runtimeB, gate.run).process(b.documentId);
    await vi.waitFor(() => expect(gate.calls).toHaveLength(4));
    expect(runtimeB.runStructuredTurn).toHaveBeenCalledOnce();
    release.resolve(undefined);
    const finalA = await resultA; const finalB = await resultB;
    expect(reviewedRevisions).toEqual([{ documentId: a.documentId, revision: 2 }, { documentId: b.documentId, revision: 3 }]);
    expect(f.store.listOpenExtractionReviewIssues().map((issue) => issue.reasonCodes)).toEqual([]);
    expect(finalA).toMatchObject({ status: 'published', revision: 3, candidateCount: 1 });
    expect(finalB).toMatchObject({ status: 'published', revision: 4, candidateCount: 1 });
    const saved = f.store.listAcceptedObservations(f.person.id);
    expect(saved).toHaveLength(4);
    for (const before of previous) {
      const after = saved.find((item) => item.id === before.id)!;
      for (const key of ['originalName', 'rawText', 'decimalValue', 'qualifier', 'unit', 'clinicalDate', 'clinicalContext'] as const) {
        expect(after[key]).toEqual(before[key]);
      }
      expect(after.evidence).toEqual(expect.arrayContaining(before.evidence));
    }
  });

  it('P03异常释放接纳队列，保留首读断点并让后一份正常发布', async () => {
    const f = fixture(); const [a, b] = f.documents as [Document, Document]; const gate = serialGate();
    const repairStarted = deferred<void>(); const failRepair = deferred<void>(); const first = reading(a, true);
    const runtimeA = { runStructuredTurn: vi.fn(async ({ prompt }: { prompt: string }) => {
      if (prompt.startsWith('# DIRECT_ORIGINAL_P01')) return receipt(a, encodeDirectOriginalReading(first), 'p01');
      repairStarted.resolve(undefined); await failRepair.promise; throw new Error('CODEX_MODEL_BUSY');
    }) };
    const runtimeB = { runStructuredTurn: vi.fn(async () => receipt(b, encodeDirectOriginalReading(reading(b)), 'p01')) };
    const resultA = pipeline(f, a, runtimeA, gate.run).process(a.documentId);
    const failure = expect(resultA).rejects.toThrow('CODEX_MODEL_BUSY');
    await repairStarted.promise;
    const resultB = pipeline(f, b, runtimeB, gate.run).process(b.documentId);
    await vi.waitFor(() => expect(gate.calls).toHaveLength(2));
    failRepair.resolve(undefined); await failure;
    expect(await resultB).toMatchObject({ status: 'published', revision: 1, candidateCount: 1 });
    expect(checkpoint(f, a)?.output).toMatchObject({ checkpointKind: 'direct_original_reading', repairAttempted: false });
    expect(a.cleanup).toHaveBeenCalledOnce(); expect(b.cleanup).toHaveBeenCalledOnce();
  });

  it('原列表第二份先存P03证明后失败，恢复时独占续完该证明再处理第一份', async () => {
    const f = fixture(2); const [a, b] = f.documents as [Document, Document];
    const instruction = '合成安排：合成文字结果。'; const original = reading(b, true);
    const originalCandidate = original.extraction.candidates[0]!;
    originalCandidate.originalName = '合成安排'; originalCandidate.value = { kind: 'text', rawText: instruction };
    originalCandidate.unitRaw = null; originalCandidate.evidence = [{ sourceSpanId: 'e_result', quote: instruction }];
    originalCandidate.sourceBinding = { headingEvidence: [], findingEvidence: [...originalCandidate.evidence] };
    original.sourceExcerpts[0] = { ...original.sourceExcerpts[0]!, quote: instruction, role: 'instruction' };
    const initialRuntime = { runStructuredTurn: vi.fn(async ({ prompt }: { prompt: string }) => receipt(b,
      prompt.startsWith('# DIRECT_ORIGINAL_P01') ? encodeDirectOriginalReading(original)
        : encodeDirectOriginalRepair(unchangedRepair(original, prompt)), prompt.startsWith('# DIRECT_ORIGINAL_P01') ? 'initial-p01' : 'initial-p03')) };
    expect(await pipeline(f, b, initialRuntime, serialGate().run).process(b.documentId)).toMatchObject({ status: 'partial', revision: 1 });
    const previous = f.store.listAcceptedObservations(f.person.id)[0]!;
    const next = structuredClone(original);
    next.sourceExcerpts[0]!.quote = `合成段落起始\n${instruction}\n合成段落结束`;
    next.sourceExcerpts.push({ localKey: 'e_heading', pageSourceSpanId: b.manifest.spans[0]!.id,
      quote: '合成安排', role: 'heading', clarity: 'clear' });
    next.extraction.candidates[0]!.sourceBinding!.headingEvidence = [{ sourceSpanId: 'e_heading', quote: '合成安排' }];
    next.extraction.candidates[1]!.value = { kind: 'numeric', rawText: '9', decimal: '9', comparator: 'eq' };
    const repairStarted = deferred<void>(); const releaseRepair = deferred<void>();
    const runtimeB = { runStructuredTurn: vi.fn(async ({ prompt }: { prompt: string }) => {
      if (prompt.startsWith('# DIRECT_ORIGINAL_P01')) return receipt(b, encodeDirectOriginalReading(next), 'recheck-p01');
      const contextLine = prompt.split('\n').find((line) => line.startsWith('READ_ONLY_PAGE_CONTEXT='))!;
      const context = decodeDirectOriginalInput('READ_ONLY_PAGE_CONTEXT', JSON.parse(contextLine.slice('READ_ONLY_PAGE_CONTEXT='.length))) as {
        reconciliationDiagnostics: { targetId: string; comparisonRefs: string[] }[] };
      const mapping = context.reconciliationDiagnostics.find((item) => item.targetId === 'c_result')!;
      repairStarted.resolve(undefined); await releaseRepair.promise;
      const patch = unchangedRepair(next, prompt);
      patch.sourceMappings = [{ candidateKey: 'c_result', comparisonRecordKey: mapping.comparisonRefs[0]!, relation: 'same_original_field' }];
      return receipt(b, encodeDirectOriginalRepair(patch), 'recheck-p03');
    }) };
    const runtimeA = { runStructuredTurn: vi.fn(async () => receipt(a, encodeDirectOriginalReading(reading(a)), 'peer-p01')) };
    const failure = new Error('SYNTHETIC_PUBLICATION_STORAGE_FAILURE');
    const saveEvidence = vi.spyOn(f.store, 'saveDirectOriginalEvidenceForProcessing').mockImplementationOnce(() => { throw failure; });
    const gate = createReportFinalizationGate({ stopAfterFailure: true });
    const resultB = pipeline(f, b, runtimeB, gate).process(b.documentId);
    const failedB = expect(resultB).rejects.toBe(failure);
    await repairStarted.promise;
    const resultA = pipeline(f, a, runtimeA, gate).process(a.documentId);
    const failedA = expect(resultA).rejects.toBe(failure);
    await vi.waitFor(() => expect(checkpoint(f, a)?.output).toMatchObject({ checkpointKind: 'direct_original_reading', repairAttempted: false }));
    releaseRepair.resolve(undefined); await Promise.all([failedB, failedA]);
    expect(saveEvidence).toHaveBeenCalledOnce();
    expect(checkpoint(f, b)?.output).toMatchObject({ repairAttempted: true, sourceRefinementReview: { factRevision: 1 } });
    expect(f.store.getFactRevision(f.person.id)).toBe(1);
    expect(f.store.isDocumentCommitted(a.documentId)).toBe(false);
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual([previous]);
    saveEvidence.mockRestore();
    const retryRuntime = { runStructuredTurn: vi.fn(async () => { throw new Error('SYNTHETIC_READING_MUST_NOT_REPEAT'); }) };
    const retryGate = createReportFinalizationGate({ stopAfterFailure: true });
    expect(f.documents.map((doc) => doc.documentId)).toEqual([a.documentId, b.documentId]);
    const proofResumeIds = new Set(f.store.getJobSourceRefinementResumeDocumentIds(f.guard));
    expect([...proofResumeIds]).toEqual([b.documentId]);
    const resumed = [];
    // 与正式调度一致：证明续跑必须先独占落定；仅排序后并发仍可能让慢渲染的证明报告被抢先提交。
    for (const doc of f.documents.filter((item) => proofResumeIds.has(item.documentId))) {
      resumed.push(await pipeline(f, doc, retryRuntime, retryGate).process(doc.documentId));
    }
    expect(f.store.getJobSourceRefinementResumeDocumentIds(f.guard)).toEqual([]);
    resumed.push(...await Promise.all(f.documents.filter((doc) => !proofResumeIds.has(doc.documentId))
      .map((doc) => pipeline(f, doc, retryRuntime, retryGate).process(doc.documentId))));
    expect(resumed).toEqual([expect.objectContaining({ documentId: b.documentId, status: 'published', revision: 2, candidateCount: 1 }),
      expect.objectContaining({ documentId: a.documentId, status: 'published', revision: 3, candidateCount: 1 })]);
    expect(retryRuntime.runStructuredTurn).not.toHaveBeenCalled();
    expect(runtimeB.runStructuredTurn).toHaveBeenCalledTimes(2); expect(runtimeA.runStructuredTurn).toHaveBeenCalledOnce();
    expect(f.store.listOpenExtractionReviewIssues()).toEqual([]);
    const current = f.store.listAcceptedObservations(f.person.id).find((item) => item.id === previous.id)!;
    for (const key of ['originalName', 'rawText', 'decimalValue', 'qualifier', 'unit', 'clinicalDate', 'clinicalContext'] as const) {
      expect(current[key]).toEqual(previous[key]);
    }
    expect(current.evidence).toEqual(expect.arrayContaining(previous.evidence));
  });

  it('等待接纳期间取消任务后不再运行P03或发布，仍清理临时原页', async () => {
    const f = fixture(); const doc = f.documents[0]!; const entered = deferred<void>(); const release = deferred<void>();
    const gate: WithSerializedDirectOriginalFinalization = async (operation) => {
      entered.resolve(undefined); await release.promise; return operation();
    };
    const runtime = { runStructuredTurn: vi.fn(async () => receipt(doc, encodeDirectOriginalReading(reading(doc, true)), 'p01')) };
    const result = pipeline(f, doc, runtime, gate).process(doc.documentId);
    const failure = expect(result).rejects.toThrow('JOB_CANCELLED');
    await entered.promise;
    expect(checkpoint(f, doc)?.output).toMatchObject({ checkpointKind: 'direct_original_reading' });
    f.store.requestJobCancellation(f.guard.jobId); release.resolve(undefined); await failure;
    expect(runtime.runStructuredTurn).toHaveBeenCalledOnce();
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual([]);
    expect(doc.cleanup).toHaveBeenCalledOnce();
  });

  it('首读格式恢复耗尽也等待接纳锁，不在另一份P03中间写入核对结果', async () => {
    const f = fixture(); const [a, b] = f.documents as [Document, Document]; const gate = serialGate();
    const started = deferred<void>(); const release = deferred<void>(); const first = reading(a, true);
    const runtimeA = { runStructuredTurn: vi.fn(async ({ prompt }: { prompt: string }) => {
      if (prompt.startsWith('# DIRECT_ORIGINAL_P01')) return receipt(a, encodeDirectOriginalReading(first), 'p01');
      started.resolve(undefined); await release.promise;
      return receipt(a, encodeDirectOriginalRepair(unchangedRepair(first, prompt)), 'p03');
    }) };
    const runtimeB = { runStructuredTurn: vi.fn(async () => receipt(b, { invalid: true }, 'invalid-p01')) };
    const resultA = pipeline(f, a, runtimeA, gate.run).process(a.documentId); await started.promise;
    const resultB = pipeline(f, b, runtimeB, gate.run).process(b.documentId);
    await vi.waitFor(() => expect(gate.calls).toHaveLength(2));
    expect(runtimeB.runStructuredTurn).toHaveBeenCalledTimes(2);
    expect(f.store.listOpenExtractionReviewIssues()).toEqual([]);
    expect(b.cleanup).not.toHaveBeenCalled();
    release.resolve(undefined); await resultA;
    expect(await resultB).toMatchObject({ status: 'partial', reason: 'DIRECT_ORIGINAL_STRUCTURE_INVALID' });
    expect(f.store.listOpenExtractionReviewIssues().map((issue) => issue.documentId).sort()).toEqual([a.documentId, b.documentId].sort());
    expect(b.cleanup).toHaveBeenCalledOnce();
  });
});
