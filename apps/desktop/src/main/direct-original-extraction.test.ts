import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { directOriginalReadingResultSchema, type DirectOriginalReadingResult, type DirectOriginalReadingRepair,
  type DirectOriginalRepairTarget, type ObservationCandidate, type SourceManifest } from '@contracts';
import { prepareDirectOriginalReport, prepareOriginalSource, type PreparedOriginalModelInput } from '@ingestion';
import { stableHash, type DirectOriginalCandidateDiagnostic } from '@core';
import { directOriginalSourceRefinementReviewSignature, WorkspaceStore } from '@storage';
import { DirectOriginalExtractionPipeline } from './direct-original-extraction.js';
import { CodexRuntimeManager } from './codex-runtime.js';
import { ACCEPTANCE_RULES_VERSION, EXTRACTION_PROMPT_VERSION } from './prompts/shared.js';
import { DIRECT_ORIGINAL_WIRE_KEY_MAP, DIRECT_ORIGINAL_WIRE_VERSION,
  encodeDirectOriginalReading, encodeDirectOriginalRepair } from './direct-original-wire.js';
import { decodeDirectOriginalInput, DIRECT_ORIGINAL_INPUT_SECTIONS,
  DIRECT_ORIGINAL_INPUT_V6_VERSION } from './direct-original-input.js';
import type { DirectOriginalRepairComparisonContext } from './direct-original-comparison.js';
import { PersonalWorkspaceService } from './workspace-service.js';
import { createProcessNowHandler } from './process-now-ipc.js';
import type { HealthDesktopBridge } from '../preload/index.js';

const ipcBoundary = vi.hoisted(() => ({ invoke: vi.fn(), expose: vi.fn() }));
vi.mock('electron', () => ({ ipcRenderer: { invoke: ipcBoundary.invoke },
  contextBridge: { exposeInMainWorld: ipcBoundary.expose }, webUtils: {} }));

const stores = new Set<WorkspaceStore>();
const runtimeManagers = new Set<CodexRuntimeManager>();
const roots: string[] = [];
afterEach(() => {
  for (const manager of runtimeManagers) manager.shutdown();
  runtimeManagers.clear();
  for (const store of stores) store.close();
  stores.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(pages = 1, assignmentBasis: 'user_selected' | 'folder_binding' = 'user_selected', existingStore?: WorkspaceStore) {
  const rootDirectory = existingStore?.rootDirectory ?? mkdtempSync(join(tmpdir(), 'family-health-direct-original-synthetic-'));
  if (!roots.includes(rootDirectory)) roots.push(rootDirectory);
  const store = existingStore ?? new WorkspaceStore({ rootDirectory });
  stores.add(store);
  const person = store.createPerson({ displayName: '合成成员' });
  const source = store.putSourceObject({ bytes: Buffer.from('合成固定原图，不含OCR转写'), mediaType: 'image/png', displayName: '合成原件.png' });
  const { documentId } = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id, assignmentBasis });
  const manifest: SourceManifest = { id: 'synthetic-direct-manifest', sourceObjectId: source.id, sha256: source.sha256,
    mediaType: 'image/png', originalDisplayName: '合成原件.png', totalUnits: pages, coveredUnitIndexes: Array.from({ length: pages }, (_, index) => index),
    normalizerVersion: 'direct-original-preparation-v1', conversionWarnings: [], createdAt: '2026-01-03T00:00:00Z',
    spans: Array.from({ length: pages }, (_, index) => ({ id: `synthetic-direct-page-${index + 1}`, documentId,
      spanKind: 'image', page: index + 1, blockId: `direct-original-page:${index + 1}`, lineStart: null,
      lineEnd: null, quote: null, readability: 'unreadable' })) };
  store.saveSourceManifest(manifest);
  const accountFingerprint = 'synthetic-direct-account';
  const consentId = store.createManualProcessingConsent({ documentIds: [documentId], personIds: [person.id], accountFingerprint, version: 1 });
  store.createWaitingAuthBatch({ cutoff: '2026-01-03T00:00:00Z', initialStatus: 'queued', consentId,
    groups: [{ personId: person.id, documentIds: [documentId], inputSignature: 'synthetic-direct-job' }] });
  const job = store.claimNextQueuedJob('synthetic-direct-runner', accountFingerprint)!;
  const attemptId = store.startJobAttempt(job.id, 'synthetic-runtime', 'gpt-6.1-sol', 'medium');
  const guard = { jobId: job.id, attemptId, consentId, accountFingerprint };
  const cleanup = vi.fn(async () => undefined);
  const prepared: PreparedOriginalModelInput = { manifest, originalSha256: source.sha256, totalUnits: pages, tempRoot: '/synthetic-private-temp', cleanup,
    imagePaths: manifest.spans.map((_, index) => `/synthetic-original/page-${index + 1}.png`),
    imageMappings: manifest.spans.map((span, index) => ({ inputKind: 'image', page: index + 1, sourceSpanId: span.id,
      path: `/synthetic-original/page-${index + 1}.png`, mediaType: 'image/png', sha256: source.sha256, width: 1200, height: 1600 })),
    unitMappings: manifest.spans.map((span, index) => ({ inputKind: 'image', page: index + 1, sourceSpanId: span.id })) };
  const prepareOriginal = vi.fn(async () => prepared);
  return { rootDirectory, store, person, source, documentId, manifest, job, guard, prepared, prepareOriginal, cleanup };
}

describe('正式问题页补读不重提已完成原页', () => {
  it('真实 preload→IPC→服务→授权→任务→模型图片链路只发送冻结的五个完整原页', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-scope-ipc-synthetic-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '合成测试工作区');
    await service.automaticUploadRecovery;
    const f = fixture(9, 'user_selected', service.store);
    const selectedIndexes = [0, 2, 3, 6, 7];
    const selectedPages = selectedIndexes.map(index => f.manifest.spans[index]!.id);
    const original = reading(f);
    for (const index of selectedIndexes) {
      const sourceSpanId = f.manifest.spans[index]!.id;
      original.sourceExcerpts.push({ localKey: `gap_${index}`, pageSourceSpanId: sourceSpanId,
        quote: `合成遗漏项目${index} 12 U/L`, role: 'finding', clarity: 'clear' });
      original.pageReadings[index] = { sourceSpanId, status: 'read', resultInventory: [{ sourceSpanId: `gap_${index}`, candidateKeys: [] }] };
    }
    const firstRuntime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(original))
      .mockImplementationOnce(async input => receipt(targetRepair(f, original, input), 2)) };
    expect(await pipeline(f, firstRuntime).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: 1 });
    f.store.finishJob(f.job.id, 'completed_with_issues');
    f.store.finishJobAttempt({ attemptId: f.guard.attemptId, status: 'completed_with_issues' });
    const before = f.store.listAcceptedObservations(f.person.id);
    const scope = f.store.getReportSupplementScope(f.documentId);
    expect(scope.pageSourceSpanIds).toEqual(selectedPages);
    const account = { status: 'connected' as const, displayLabel: 'synthetic-scope@example.test',
      quota: { status: 'available' as const, primaryUsedPercent: 0, secondaryUsedPercent: null, resetsAt: null },
      runtimeVersion: 'synthetic', lastCheckedAt: new Date().toISOString() };
    const runAvailableJobs = vi.fn();
    const handler = createProcessNowHandler({ validateSender: vi.fn(), getWorkspace: () => service,
      currentAccountState: () => account, isRebuildRunning: () => false,
      ensureRecoveryPointBeforeWrite: async () => undefined, runAvailableJobs });
    ipcBoundary.invoke.mockImplementation((channel: string, input: unknown) => {
      expect(channel).toBe('jobs:process-now'); return handler('synthetic-sender', input);
    });
    await import('../preload/index.js');
    const bridge = ipcBoundary.expose.mock.calls.find(([name]) => name === 'healthDesktop')![1] as HealthDesktopBridge;
    const result = await bridge.processNow({ consentVersion: 1, confirmedDataRecipient: 'OpenAI/Codex',
      documentIds: [f.documentId], readingScope: 'unresolved_pages' });
    expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.error.code);
    expect(runAvailableJobs).toHaveBeenCalledExactlyOnceWith(service);
    const db = new Database(f.store.databasePath, { readonly: true });
    try {
      const rows = db.prepare(`SELECT j.checkpoint_json,c.scope_json FROM jobs j JOIN consents c
        ON c.id=json_extract(j.checkpoint_json,'$.consentId') WHERE j.batch_id=?`).all(result.data.batchId) as Array<{ checkpoint_json: string; scope_json: string }>;
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]!.checkpoint_json)).toMatchObject({ documentIds: [f.documentId], supplementScopes: [scope] });
      expect(JSON.parse(rows[0]!.scope_json)).toMatchObject({ documentIds: [f.documentId], supplementScopes: [scope] });
    } finally { db.close(); }
    const fingerprint = stableHash({ provider: 'codex-chatgpt', displayLabel: account.displayLabel });
    const job = f.store.claimNextQueuedJob('synthetic-scoped-runner', fingerprint)!;
    const attemptId = f.store.startJobAttempt(job.id, 'synthetic', 'gpt-6.1-sol', 'medium');
    const guard = { jobId: job.id, attemptId, consentId: job.consentId!, accountFingerprint: fingerprint };
    const next = reading(f);
    next.pageReadings = selectedIndexes.map(index => ({ sourceSpanId: f.manifest.spans[index]!.id,
      status: 'no_medical_content', resultInventory: [] }));
    next.sourceExcerpts = []; next.extraction.candidates = [];
    next.extraction.coveredSourceSpanIds = selectedPages;
    const runtime = { runStructuredTurn: vi.fn(async input => {
      expect(input.imagePaths).toEqual(selectedIndexes.map(index => f.prepared.imagePaths[index]));
      expect(input.prompt).toContain('"completeOriginal":false');
      return receipt(next, 3);
    }) };
    await new DirectOriginalExtractionPipeline(f.store, runtime, guard, { prepareOriginal: f.prepareOriginal }).process(f.documentId);
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(1);
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual(before);
    expect(f.store.getLatestReportReadingAudit(f.documentId)?.audit.ledger).toMatchObject({
      scope: 'selected_pages', totalOriginalPages: 9, baseAuditId: scope.baseAuditId,
      pages: selectedPages.map(sourceSpanId => ({ sourceSpanId })) });
  });
  async function pendingFixture() {
    const f = fixture(2); const original = reading(f); const pageId = f.manifest.spans[0]!.id;
    original.sourceExcerpts.push({ localKey: 'gap', pageSourceSpanId: pageId,
      quote: '另一合成项目 12 U/L', role: 'finding', clarity: 'clear' });
    original.pageReadings[0] = { sourceSpanId: pageId, status: 'read', resultInventory: [{ sourceSpanId: 'gap', candidateKeys: [] }] };
    const firstRuntime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(original))
      .mockImplementationOnce(async input => receipt(targetRepair(f, original, input), 2)) };
    expect(await pipeline(f, firstRuntime).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: 1 });
    f.store.finishJob(f.job.id, 'completed_with_issues');
    f.store.finishJobAttempt({ attemptId: f.guard.attemptId, status: 'completed_with_issues' });
    const before = f.store.listAcceptedObservations(f.person.id);
    const scope = f.store.getReportSupplementScope(f.documentId);
    expect(scope.pageSourceSpanIds).toEqual([pageId]);
    const consentId = f.store.createManualProcessingConsent({ documentIds: [f.documentId], personIds: [f.person.id],
      accountFingerprint: f.guard.accountFingerprint, version: 1, supplementScopes: [scope] });
    const job = f.store.createWaitingAuthBatch({ cutoff: new Date().toISOString(), initialStatus: 'queued', consentId,
      repairDocumentIds: [f.documentId], supplementScopes: [scope], groups: [{ personId: f.person.id,
        documentIds: [f.documentId], stage: 'extract', inputSignature: 'synthetic-selected-page-supplement' }] });
    f.store.claimNextQueuedJob('synthetic-supplement-runner', f.guard.accountFingerprint);
    const attemptId = f.store.startJobAttempt(job.jobIds[0]!, 'synthetic', 'gpt-6.1-sol', 'medium');
    const guard = { ...f.guard, jobId: job.jobIds[0]!, attemptId, consentId };
    const next = reading(f);
    next.pageReadings = [{ sourceSpanId: pageId, status: 'read', resultInventory: [{ sourceSpanId: 'e_new', candidateKeys: ['c_new'] }] }];
    next.extraction.coveredSourceSpanIds = [pageId];
    next.sourceExcerpts = [{ localKey: 'e_new', pageSourceSpanId: pageId, quote: '另一合成项目 12 U/L', role: 'finding', clarity: 'clear' }];
    const extra = candidate('c_new', 'e_new', '12'); extra.originalName = '另一合成项目'; extra.evidence[0]!.quote = '另一合成项目 12 U/L';
    next.extraction.candidates = [extra];
    return { f, scope, guard, next, before };
  }

  it('冻结问题页、发送范围与原件绑定，只增量接纳新结果并保留全量旧账本', async () => {
    const { f, scope, guard, next, before } = await pendingFixture();
    const runtime = { runStructuredTurn: vi.fn(async input => {
      expect(input.imagePaths).toEqual([f.prepared.imagePaths[0]]);
      expect(input.prompt).toContain('"completeOriginal":false');
      return receipt(next, 3);
    }) };
    const result = await new DirectOriginalExtractionPipeline(f.store, runtime, guard, { prepareOriginal: f.prepareOriginal }).process(f.documentId);
    expect(result).toMatchObject({ status: 'published', candidateCount: 1 });
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(2);
    expect(f.store.listAcceptedObservations(f.person.id).find(item => item.id === before[0]!.id)).toEqual(before[0]);
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(1);
    expect(f.store.getLatestReportReadingAudit(f.documentId)?.audit.ledger).toMatchObject({
      scope: 'selected_pages', totalOriginalPages: 2, baseAuditId: scope.baseAuditId,
      pages: [{ sourceSpanId: scope.pageSourceSpanIds[0] }], candidates: [{ localKey: 'c_new', disposition: 'saved_or_existing' }]
    });
    const db = new Database(f.store.databasePath, { readonly: true });
    try { expect(db.prepare('SELECT id FROM audit_events WHERE id=?').get(scope.baseAuditId)).toBeDefined(); }
    finally { db.close(); }
  });

  it('模型夹带未授权原页内容不能接纳，也不会偷偷扩大图片发送范围', async () => {
    const { f, guard, next, before } = await pendingFixture();
    next.sourceExcerpts[0]!.pageSourceSpanId = f.manifest.spans[1]!.id;
    const runtime = { runStructuredTurn: vi.fn(async input => input.prompt.startsWith('# DIRECT_ORIGINAL_P01')
      ? receipt(next, 3) : receipt(targetRepair(f, next, input), 4)) };
    await new DirectOriginalExtractionPipeline(f.store, runtime, guard, { prepareOriginal: f.prepareOriginal }).process(f.documentId);
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual(before);
    for (const [input] of runtime.runStructuredTurn.mock.calls) expect(input.imagePaths).toEqual([f.prepared.imagePaths[0]]);
  });

  it('原件或成员范围变化使冻结授权失效，未发送内容且不回退为全报告读取', async () => {
    const { f, guard } = await pendingFixture();
    // 合成测试模拟外部撤权，不修改任何真实数据库。
    f.store.revokeConsent(guard.consentId);
    const runtime = { runStructuredTurn: vi.fn() };
    await expect(new DirectOriginalExtractionPipeline(f.store, runtime, guard, { prepareOriginal: f.prepareOriginal })
      .process(f.documentId)).rejects.toThrow();
    expect(runtime.runStructuredTurn).not.toHaveBeenCalled();
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(1);
  });

  it.each(['missing-consent-scope', 'missing-job-scope', 'extra-full-document', 'idempotent-scope-downgrade'] as const)(
    '排队事务拒绝%s，不把局部授权混成整份任务', async problem => {
      const { f, scope } = await pendingFixture();
      const supplementScopes = problem === 'missing-job-scope' || problem === 'idempotent-scope-downgrade' ? [] : [scope];
      const consentId = f.store.createManualProcessingConsent({ documentIds: [f.documentId], personIds: [f.person.id],
        accountFingerprint: f.guard.accountFingerprint, version: 1,
        ...(problem === 'missing-consent-scope' || problem === 'idempotent-scope-downgrade' ? {} : { supplementScopes: [scope] }) });
      const before = f.store.listStoredJobs().map(job => job.id);
      expect(() => f.store.createWaitingAuthBatch({ cutoff: new Date().toISOString(), initialStatus: 'queued', consentId,
        supplementScopes, repairDocumentIds: [f.documentId], groups: [{ personId: f.person.id, stage: 'extract',
          documentIds: [f.documentId, ...(problem === 'extra-full-document' ? ['synthetic-unselected-document'] : [])],
          inputSignature: problem === 'idempotent-scope-downgrade' ? 'synthetic-selected-page-supplement' : `synthetic-${problem}` }] }))
        .toThrow(/REPORT_SUPPLEMENT_(SCOPE_CHANGED|CONSENT_MISMATCH)/);
      expect(f.store.listStoredJobs().map(job => job.id)).toEqual(before);
      expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(1);
    });
});
type Fixture = ReturnType<typeof fixture>;
function candidate(key = 'c_a', excerpt = 'e_a', value = '7'): ObservationCandidate {
  const evidence = [{ sourceSpanId: excerpt, quote: `合成指标 ${value} U/L` }];
  return { localKey: key, originalName: '合成指标', standardNameCandidate: null,
    value: { kind: 'numeric', rawText: value, decimal: value, comparator: 'eq' }, unitRaw: 'U/L', referenceRangeRaw: null,
    reportedAbnormalFlag: null, specimen: null, method: null, bodySite: null, clinicalDate: null,
    clinicalContext: { version: 1, status: 'complete', conditions: [] }, evidence,
    sourceBinding: { headingEvidence: [], findingEvidence: evidence }, issues: [] };
}
function reading(f: Pick<Fixture, 'documentId' | 'manifest'>): DirectOriginalReadingResult {
  return { schemaVersion: 1, documentId: f.documentId,
    pageReadings: f.manifest.spans.map((span, index) => ({ sourceSpanId: span.id,
      status: index === f.manifest.spans.length - 1 ? 'read' : 'no_medical_content',
      resultInventory: index === f.manifest.spans.length - 1 ? [{ sourceSpanId: 'e_a', candidateKeys: ['c_a'] }] : [] })),
    sourceExcerpts: [{ localKey: 'e_a', pageSourceSpanId: f.manifest.spans.at(-1)!.id, quote: '合成指标 7 U/L', role: 'finding', clarity: 'clear' }],
    extraction: { schemaVersion: 1, documentId: f.documentId, subject: { reportedName: null, confidence: 'absent', evidence: [] },
      reportMetadata: null, coveredSourceSpanIds: f.manifest.spans.map((span) => span.id), candidates: [candidate()] } };
}
// 合成模型回执的盘点清单。仅测试已知夹具，不用于读取原件或补写生产结果。
function inventoryForSyntheticReading(output: DirectOriginalReadingResult): void {
  for (const page of output.pageReadings) {
    page.resultInventory = output.sourceExcerpts.filter((source) => source.pageSourceSpanId === page.sourceSpanId
      && (['finding', 'instruction'].includes(source.role) || output.extraction.candidates.some((item) =>
        item.value.kind === 'unknown' && item.value.reason === 'original_blank'
        && (item.sourceBinding?.findingEvidence ?? item.evidence).some((ref) => ref.sourceSpanId === source.localKey))))
      .map((source) => ({ sourceSpanId: source.localKey, candidateKeys: output.extraction.candidates.filter((item) =>
        (item.sourceBinding?.findingEvidence ?? item.evidence).some((ref) => ref.sourceSpanId === source.localKey)).map((item) => item.localKey) }));
    if (page.status === 'read' || page.status === 'no_medical_content') page.status = page.resultInventory.length ? 'read' : 'no_medical_content';
  }
}
function readingWithBoundHeading(f: Fixture): DirectOriginalReadingResult {
  const output = reading(f);
  output.extraction.candidates[0]!.originalName = '合成甲指标';
  output.extraction.candidates[0]!.evidence[0]!.quote = '合成甲指标 7 U/L';
  output.sourceExcerpts[0]!.quote = '合成甲指标 7 U/L';
  output.sourceExcerpts.push({ localKey: 'e_heading', pageSourceSpanId: f.manifest.spans[0]!.id,
    quote: '合成检查项目', role: 'heading', clarity: 'clear' });
  output.extraction.candidates[0]!.sourceBinding!.headingEvidence = [{ sourceSpanId: 'e_heading', quote: '合成检查项目' }];
  const second = candidate('c_b', 'e_b', '11');
  second.originalName = '合成乙指标'; second.evidence[0]!.quote = '合成乙指标 11 U/L';
  output.sourceExcerpts.push({ localKey: 'e_b', pageSourceSpanId: f.manifest.spans[0]!.id,
    quote: '合成乙指标 11 U/L', role: 'finding', clarity: 'clear' });
  output.extraction.candidates.push(second);
  return output;
}

describe('读取完整性不等于任务终态', () => {
  it('同页共同摘录已有候选，但原页盘点仍有未对应项目时进行一次补漏并正式接纳', async () => {
    const f = fixture(); const output = reading(f); const pageId = f.manifest.spans[0]!.id;
    output.sourceExcerpts[0]!.quote += '\n另一合成项目 12 U/L';
    output.pageReadings[0]!.resultInventory!.push({ sourceSpanId: 'e_a', candidateKeys: [] });
    const extra = candidate('c_extra', 'e_a', '12'); extra.originalName = '另一合成项目';
    extra.evidence[0]!.quote = '另一合成项目 12 U/L';
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output)).mockImplementationOnce(async (input) => {
      expect(repairRequest(input).issues).toContain('direct_original_result_inventory_unaccounted');
      return receipt(targetRepair(f, output, input, { [pageId]: { nodeType: 'page', value: {
        sourceSpanId: pageId, status: 'read', resultInventory: [
          { sourceSpanId: 'e_a', candidateKeys: ['c_a'] }, { sourceSpanId: 'e_a', candidateKeys: ['c_extra'] }],
        newCandidates: [extra] } } }), 2);
    }) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 2 });
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(2);
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
  });

  it('另一页有结果不能掩盖已读空页，补核未完成时保留独立正确结果和缺口', async () => {
    const f = fixture(2); const output = reading(f);
    output.pageReadings[0] = { sourceSpanId: f.manifest.spans[0]!.id, status: 'read', resultInventory: [] };
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output)).mockImplementationOnce(async (input) => {
      expect(repairRequest(input).issues).toContain('direct_original_empty_read_result');
      return receipt(targetRepair(f, output, input), 2);
    }) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: 1 });
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(1);
    expect(f.store.listOpenExtractionReviewIssues()[0]!.readingAudit?.pageGapCount).toBe(1);
  });
  it.each([false, true])('清晰结果摘录没有候选时进入一次补漏，共同全文包含该段=%s也不能冒充已提取', async (includedInCommonFrame) => {
    const f = fixture(); const output = reading(f);
    output.sourceExcerpts.push({ localKey: 'orphan-finding', pageSourceSpanId: f.manifest.spans[0]!.id,
      quote: '另一合成指标 12 U/L', role: 'finding', clarity: 'clear' });
    if (includedInCommonFrame) output.sourceExcerpts[0]!.quote += '\n另一合成指标 12 U/L';
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output)).mockImplementationOnce(async (input) => {
      const request = repairRequest(input);
      expect(request.issues).toContain('direct_original_readable_source_not_accounted');
      return receipt(repair(f, output, request.targets.map((target) => ({ targetId: target.targetId, action: 'unchanged', replacement: null }))), 2);
    }) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: 1 });
    const review = f.store.listOpenExtractionReviewIssues()[0]!;
    expect(review.readingAudit).toMatchObject({ totalCandidates: 1, savedCandidates: 1, pending: [], unrepresentedSourceCount: 1 });
    const persisted = f.store.getLatestReportReadingAudit(f.documentId)!;
    expect(persisted.audit.ledger).toMatchObject({ scope: 'full_report', originalSha256: f.source.sha256,
      candidates: [{ localKey: 'c_a', disposition: 'saved_or_existing' }], gapPageSourceSpanIds: [f.manifest.spans[0]!.id] });
    const orphan = persisted.audit.ledger!.unrepresentedSources[0]!;
    expect(f.store.getDocumentExtractionBundle(f.documentId).manifest.spans.find(span => span.id === orphan.sourceSpanId)?.quote)
      .toBe('另一合成指标 12 U/L');
    // 原详细临时断点清理后，正式事务中的逐项来源和未对账项仍可读取。
    const db = new Database(f.store.databasePath,{ readonly: true });
    try {
      const row = db.prepare('SELECT checkpoint_json FROM jobs WHERE id=?').get(f.guard.jobId) as { checkpoint_json: string };
      expect(JSON.parse(row.checkpoint_json).extractionChunks?.[f.documentId]).toBeUndefined();
    } finally { db.close(); }
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(1);
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
  });
});
const rawReceipt = (output: unknown, turn = 1) => ({ threadId: `synthetic-direct-thread-${turn}`, turnId: `synthetic-direct-turn-${turn}`, output });
// 合成测例继续描述原语义对象，但模型返回边界只能是明确的 wire；产品没有长 JSON 回退。
const receipt = (output: unknown, turn = 1) => rawReceipt(output && typeof output === 'object'
  && 'pageReadings' in output ? encodeDirectOriginalReading(output as DirectOriginalReadingResult)
  : output && typeof output === 'object' && 'results' in output ? encodeDirectOriginalRepair(output as DirectOriginalReadingRepair)
    : output, turn);
function repair(f: Fixture, original: DirectOriginalReadingResult, results: DirectOriginalReadingRepair['results']): DirectOriginalReadingRepair {
  return { schemaVersion: 1, documentId: f.documentId, originalReadingHash: stableHash(directOriginalReadingResultSchema.parse(original)), results };
}
function repairRequest(input: { prompt: string }): { targets: DirectOriginalRepairTarget[]; issues: string[];
  validationDiagnostics: DirectOriginalCandidateDiagnostic[] } {
  const line = input.prompt.split('\n').find((line) => line.startsWith('REPAIR_REQUEST='));
  if (!line) throw new Error('SYNTHETIC_REPAIR_REQUEST_REQUIRED');
  return decodeDirectOriginalInput('REPAIR_REQUEST', JSON.parse(line.slice('REPAIR_REQUEST='.length))) as ReturnType<typeof repairRequest>;
}
function targetItems(input: { prompt: string }): { targetId: string; nodeType: string; value: unknown }[] {
  const line = input.prompt.split('\n').find((line) => line.startsWith('TARGET_ITEMS='));
  if (!line) throw new Error('SYNTHETIC_REPAIR_TARGET_ITEMS_REQUIRED');
  return decodeDirectOriginalInput('TARGET_ITEMS', JSON.parse(line.slice('TARGET_ITEMS='.length))) as ReturnType<typeof targetItems>;
}
type ContextEntry<T> = { localKey: string; access: 'authorized_target' | 'immutable_non_target'; targetId?: string; value?: T };
function readOnlyPageContext(input: { prompt: string }): DirectOriginalRepairComparisonContext & {
  schemaVersion: 1;
  targetPages: { pageSourceSpanId: string; candidates: ContextEntry<ObservationCandidate>[] }[];
  referencedExcerpts: ContextEntry<DirectOriginalReadingResult['sourceExcerpts'][number]>[];
  reservedLocalKeys: string[];
} {
  const line = input.prompt.split('\n').find((line) => line.startsWith('READ_ONLY_PAGE_CONTEXT='));
  if (!line) throw new Error('SYNTHETIC_REPAIR_READ_ONLY_CONTEXT_REQUIRED');
  return decodeDirectOriginalInput('READ_ONLY_PAGE_CONTEXT', JSON.parse(line.slice('READ_ONLY_PAGE_CONTEXT='.length))) as ReturnType<typeof readOnlyPageContext>;
}
function partialPageWithExistingFields(f: Fixture) {
  const output = reading(f); const pageId = f.manifest.spans[2]!.id;
  output.pageReadings[2]!.status = 'partial';
  output.sourceExcerpts[0] = { ...output.sourceExcerpts[0]!, pageSourceSpanId: pageId, quote: '合成甲项 7 U/L' };
  const existing = output.extraction.candidates[0]!;
  existing.originalName = '合成甲项'; existing.evidence[0]!.quote = output.sourceExcerpts[0]!.quote;
  const dateRef = { sourceSpanId: 'e_date', quote: 'Exam performed: 02/03/2026' };
  const conditionRef = { sourceSpanId: 'e_condition', quote: '合成检查条件：未散瞳' };
  output.sourceExcerpts.push(
    { localKey: 'e_date', pageSourceSpanId: f.manifest.spans[0]!.id, quote: dateRef.quote, role: 'date', clarity: 'clear' },
    { localKey: 'e_heading', pageSourceSpanId: f.manifest.spans[1]!.id, quote: '合成检查栏目', role: 'heading', clarity: 'clear' },
    { localKey: 'e_condition', pageSourceSpanId: f.manifest.spans[1]!.id, quote: conditionRef.quote, role: 'context', clarity: 'clear' },
    { localKey: 'e_unused', pageSourceSpanId: pageId, quote: '未引用的技术页脚', role: 'context', clarity: 'clear' },
    { localKey: 'e_hidden', pageSourceSpanId: pageId, quote: '合成遮挡字段……', role: 'finding', clarity: 'uncertain' },
    { localKey: 'e_outside', pageSourceSpanId: f.manifest.spans[3]!.id, quote: '合成独立项目 13 U/L', role: 'finding', clarity: 'clear' });
  existing.clinicalDate = '2026-02-03';
  existing.sourceBinding = { headingEvidence: [{ sourceSpanId: 'e_heading', quote: '合成检查栏目' }], findingEvidence: [...existing.evidence] };
  existing.evidence.push(dateRef);
  existing.clinicalContext = { version: 1, status: 'complete', conditions: [conditionRef] };
  output.extraction.reportMetadata = { reportKind: null, title: null, organization: null, campus: null,
    department: null, reportNumber: null, examItems: [], times: [{ value: '2026-02-03', precision: 'day', role: 'examined', evidence: [dateRef] }] };
  const hidden = candidate('c_hidden', 'e_hidden');
  hidden.originalName = '合成遮挡字段'; hidden.value = { kind: 'unknown', rawText: null, reason: 'unreadable' };
  hidden.unitRaw = null; hidden.evidence[0]!.quote = '合成遮挡字段……';
  const outside = candidate('c_outside', 'e_outside', '13');
  outside.originalName = '合成独立项目'; outside.evidence[0]!.quote = '合成独立项目 13 U/L';
  output.extraction.candidates.push(hidden, outside);
  output.pageReadings[2]!.resultInventory = [{ sourceSpanId: 'e_a', candidateKeys: ['c_a'] },
    { sourceSpanId: 'e_hidden', candidateKeys: ['c_hidden'] }];
  output.pageReadings[3]!.resultInventory = [{ sourceSpanId: 'e_outside', candidateKeys: ['c_outside'] }];
  return { output, pageId, existing, hidden, outside };
}
function targetRepair(f: Fixture, original: DirectOriginalReadingResult, input: { prompt: string },
  replacements: Record<string, NonNullable<DirectOriginalReadingRepair['results'][number]['replacement']>> = {}) {
  return repair(f, original, repairRequest(input).targets.map((target) => ({ targetId: target.targetId,
    action: replacements[target.targetId] ? 'replace' as const : 'unchanged' as const,
    replacement: replacements[target.targetId] ?? null })));
}
function pipeline(f: Fixture, runtime: { runStructuredTurn: ReturnType<typeof vi.fn> }, maxContextBytes?: number) {
  return new DirectOriginalExtractionPipeline(f.store, runtime, f.guard, { prepareOriginal: f.prepareOriginal,
    ...(maxContextBytes === undefined ? {} : { maxContextBytes }) });
}

describe('跨页日期绑定补核', () => {
  it.each(['missing', 'missing_reference', 'isolated'] as const)('%s日期问题进入同一次P03，不能因结果已接纳而跳过', async mode => {
    const f = fixture(2); const output = reading(f);
    const dateRef = { sourceSpanId: 'e_date', quote: '检查日期 2026-03-12' };
    output.sourceExcerpts.push({ localKey: 'e_date', pageSourceSpanId: f.manifest.spans[0]!.id,
      quote: dateRef.quote, role: 'date', clarity: 'clear' });
    output.extraction.candidates[0]!.sourceBinding!.findingEvidence = [...output.extraction.candidates[0]!.evidence];
    if (mode !== 'missing_reference') output.extraction.candidates[0]!.evidence.push(dateRef);
    if (mode === 'isolated') output.extraction.candidates[0]!.clinicalDate = '2026-03-12';
    const metadata = { reportKind: null, title: null, organization: null, campus: null, department: null,
      reportNumber: null, examItems: [], primaryClinicalTimeIndex: 0,
      times: [{ role: 'examined' as const, precision: 'day' as const, value: '2026-03-12', evidence: [dateRef] }] };
    if (mode !== 'isolated') output.extraction.reportMetadata = metadata;
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output))
      .mockImplementationOnce(async input => {
        expect(repairRequest(input).targets).toEqual(expect.arrayContaining([
          { targetId: 'c_a', nodeType: 'candidate' }, { targetId: 'metadata', nodeType: 'metadata' }]));
        return receipt(targetRepair(f, output, input, {
          c_a: { nodeType: 'candidate', value: { ...output.extraction.candidates[0]!, clinicalDate: '2026-03-12',
            evidence: [...output.extraction.candidates[0]!.sourceBinding!.findingEvidence, dateRef] } },
          metadata: { nodeType: 'metadata', value: metadata }
        }), 2);
      }) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 1 });
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual([
      expect.objectContaining({ rawText: '7', clinicalDate: '2026-03-12' })]);
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
  });

  it('补核仍无法把历史列对应到日期时只保留日期说明，结果不丢失也不无限重读', async () => {
    const f = fixture(); const output = reading(f);
    output.sourceExcerpts[0]!.quote += '\n2024-03-12 2026-03-12';
    output.extraction.candidates[0]!.evidence = [{ sourceSpanId: 'e_a', quote: null }];
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output))
      .mockImplementationOnce(async input => receipt(targetRepair(f, output, input), 2)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: 1 });
    expect(f.store.listAcceptedObservations(f.person.id)[0]).toMatchObject({ clinicalDate: null, rawText: '7' });
    expect(f.store.listOpenExtractionReviewIssues()[0]!.reasonCodes).toContain('direct_original_clinical_date_binding_missing');
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
  });
});

function canonicalCheckpointSignature(f: Fixture, rulesVersion = ACCEPTANCE_RULES_VERSION,
  promptVersion = rulesVersion === ACCEPTANCE_RULES_VERSION ? EXTRACTION_PROMPT_VERSION : 'extract-direct-original-v3'): string {
  return stableHash({ documentId: f.documentId, originalSha256: f.prepared.originalSha256,
    modelId: 'gpt-6.1-sol', promptVersion, rulesVersion,
    units: f.prepared.unitMappings, nativeTextHash: stableHash(f.prepared.nativeText ?? ''),
    convertedViewSha256: f.prepared.convertedViewSha256 ?? null });
}

function saveCanonicalCheckpoint(f: Fixture, output: DirectOriginalReadingResult, repairAttempted: boolean,
  rulesVersion = ACCEPTANCE_RULES_VERSION, promptVersion?: string) {
  const reading = directOriginalReadingResultSchema.parse(output);
  const originalReceipt = { threadId: 'synthetic-canonical-cache-thread', turnId: 'synthetic-canonical-cache-turn' };
  const state = { checkpointKind: 'direct_original_reading', reading, receipt: originalReceipt,
    excerptReceipts: Object.fromEntries(reading.sourceExcerpts.map((excerpt) => [excerpt.localKey, originalReceipt])),
    repairAttempted, incompletePageSourceSpanIds: [] };
  f.store.saveExtractionChunkCheckpoint({ guard: f.guard, documentId: f.documentId,
    signature: canonicalCheckpointSignature(f, rulesVersion, promptVersion), chunkIndex: 0, output: state, ...originalReceipt,
    extractionTurnId: originalReceipt.turnId });
  return state;
}

/** 只模拟 RPC 回执；真实 runStructuredTurn 的 schema 适配、JSON 解析与可选字段恢复仍完整执行。 */
function structuredRuntime(f: Fixture, outputs: unknown[]) {
  class SyntheticRpcClient extends EventEmitter {
    requests: Array<{ method: string; params: unknown }> = [];
    threadCount = 0;
    async initialize() { return {}; }
    async request<T>(method: string, params?: unknown): Promise<T> {
      this.requests.push({ method, params });
      if (method === 'account/read') return { account: { type: 'chatgpt', email: null, planType: 'synthetic' }, requiresOpenaiAuth: true } as T;
      if (method === 'account/rateLimits/read') return { rateLimits: { primary: null, secondary: null } } as T;
      if (method === 'thread/start') return { thread: { id: `synthetic-rpc-thread-${++this.threadCount}` } } as T;
      if (method === 'turn/start') {
        const turnId = `synthetic-rpc-turn-${this.threadCount}`;
        const threadId = (params as { threadId: string }).threadId;
        if (outputs.length === 0) throw new Error('SYNTHETIC_RPC_OUTPUT_REQUIRED');
        const output = outputs.shift();
        queueMicrotask(() => this.emit('turn/completed', { threadId, turn: { id: turnId, status: 'completed',
          error: null, items: [{ id: `synthetic-item-${this.threadCount}`, type: 'agentMessage', phase: 'final_answer',
            text: JSON.stringify(output) }] } }));
        return { turn: { id: turnId } } as T;
      }
      return {} as T;
    }
    shutdown() {}
  }
  const client = new SyntheticRpcClient();
  const manager = new CodexRuntimeManager({ executable: f.store.getDocumentOriginalSource(f.documentId).sourcePath,
    runtimeVersion: 'synthetic-wire-boundary', codexHome: join(f.rootDirectory, 'isolated-codex-home'),
    workingDirectory: join(f.rootDirectory, 'isolated-runtime-work'), createClient: () => client });
  runtimeManagers.add(manager);
  const runtime = { runStructuredTurn: vi.fn((input) => manager.runStructuredTurn({ ...input,
    aiPreferences: { modelId: 'gpt-6.1-sol', reasoningEffort: 'medium' } })) };
  return { runtime, client, manager };
}

describe('整份原件直接提取与有限定点修复', () => {
  it('真实结构化运行边界使用显式短键wire，32页整份输入及显式null主要日期完整保存', async () => {
    const f = fixture(32); const output = reading(f);
    f.prepared.nativeText = '合成完整32页原生文字上下文，包含否定、左右侧与历史列，不拆分。';
    const dateRef = { sourceSpanId: 'e_date', quote: '合成本次检查日期：2026-02-03' };
    output.sourceExcerpts.push({ localKey: dateRef.sourceSpanId, pageSourceSpanId: f.manifest.spans[0]!.id,
      quote: dateRef.quote, role: 'date', clarity: 'clear' });
    output.extraction.reportMetadata = { reportKind: null, title: null, organization: null, campus: null,
      department: null, reportNumber: null, examItems: [], primaryClinicalTimeIndex: null,
      times: [{ value: '2026-02-03', precision: 'day', role: 'examined', evidence: [dateRef] }] };
    const { runtime, client } = structuredRuntime(f, [encodeDirectOriginalReading(output)]);
    const save = vi.spyOn(f.store, 'saveExtractionChunkCheckpoint');
    const publish = vi.spyOn(f.store, 'publishFacts');
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 1 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(1);
    const input = runtime.runStructuredTurn.mock.calls[0]![0];
    expect(input.imagePaths).toEqual(f.prepared.imagePaths); expect(input.imagePaths).toHaveLength(32);
    expect(input.prompt).toContain(JSON.stringify(f.prepared.nativeText));
    expect(input.prompt).toContain(DIRECT_ORIGINAL_WIRE_VERSION);
    const start = client.requests.find((request) => request.method === 'turn/start')!.params as {
      input: Array<{ type: string; path?: string }>; outputSchema: { properties: Record<string, unknown> };
    };
    expect(start.input.filter((item) => item.type === 'localImage').map((item) => item.path)).toEqual(f.prepared.imagePaths);
    expect(start.outputSchema.properties).toHaveProperty('wireVersion');
    expect(start.outputSchema.properties).toHaveProperty('contract');
    expect(save.mock.calls[0]![0].signature).toBe(canonicalCheckpointSignature(f));
    expect(save.mock.calls[0]![0].output).toMatchObject({ checkpointKind: 'direct_original_reading', reading: output,
      repairAttempted: false, receipt: { threadId: 'synthetic-rpc-thread-1', turnId: 'synthetic-rpc-turn-1' } });
    expect(save.mock.calls[0]![0].output).not.toHaveProperty('wireVersion');
    expect(publish.mock.calls[0]![0].reportMetadata).toHaveProperty('primaryClinicalTimeIndex', null);
    expect(f.store.listAcceptedObservations(f.person.id)[0]).toMatchObject({ rawText: '7', clinicalDate: null });
  });

  it('真实P03短键解码仍按canonical hash只修目标，32页图片和完整原文均不裁剪', async () => {
    const f = fixture(32); const output = reading(f);
    f.prepared.nativeText = '合成整篇32页全文上下文，P01与P03完全相同。';
    output.extraction.candidates[0]!.value = { kind: 'numeric', rawText: '7', decimal: '8', comparator: 'eq' };
    const patch = repair(f, output, [{ targetId: 'c_a', action: 'replace', replacement: { nodeType: 'candidate', value: candidate() } }]);
    const { runtime, client } = structuredRuntime(f, [encodeDirectOriginalReading(output), encodeDirectOriginalRepair(patch)]);
    const save = vi.spyOn(f.store, 'saveExtractionChunkCheckpoint');
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 1 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
    const p03 = runtime.runStructuredTurn.mock.calls[1]![0];
    expect(repairRequest(p03)).toMatchObject({ originalReadingHash: stableHash(directOriginalReadingResultSchema.parse(output)),
      targets: [{ targetId: 'c_a', nodeType: 'candidate' }] });
    for (const [input] of runtime.runStructuredTurn.mock.calls) {
      expect(input.imagePaths).toEqual(f.prepared.imagePaths); expect(input.imagePaths).toHaveLength(32);
      expect(input.prompt).toContain(JSON.stringify(f.prepared.nativeText));
    }
    expect(client.requests.filter((request) => request.method === 'turn/start')).toHaveLength(2);
    const saved = save.mock.calls.at(-1)![0].output as { reading: DirectOriginalReadingResult; repairAttempted: boolean;
      excerptReceipts: Record<string, { turnId: string }> };
    expect(saved.repairAttempted).toBe(true); expect(saved.reading).not.toHaveProperty('wireVersion');
    expect(saved.reading.sourceExcerpts).toEqual(output.sourceExcerpts);
    expect(saved.excerptReceipts.e_a!.turnId).toBe('synthetic-rpc-turn-1');
    expect(f.store.listAcceptedObservations(f.person.id)[0]?.decimalValue).toBe('7');
  });

  it.each([ACCEPTANCE_RULES_VERSION, 'direct-original-acceptance-v6', 'direct-original-acceptance-v5', 'direct-original-acceptance-v4'])(
    '%s旧canonical未修断点升级后只做一次P03，不重新P01或补造缺失null字段', async (rulesVersion) => {
    const f = fixture(); const output = reading(f);
    delete output.extraction.reportMetadata;
    output.extraction.candidates[0]!.value = { kind: 'numeric', rawText: '7', decimal: '8', comparator: 'eq' };
    const original = saveCanonicalCheckpoint(f, output, false, rulesVersion);
    const runtime = { runStructuredTurn: vi.fn(async (input) => {
      expect(input.prompt.startsWith('# DIRECT_ORIGINAL_P03')).toBe(true);
      expect(repairRequest(input)).toMatchObject({ originalReadingHash: stableHash(original.reading) });
      return receipt(targetRepair(f, original.reading, input, { c_a: { nodeType: 'candidate', value: candidate() } }), 2);
    }) };
    const save = vi.spyOn(f.store, 'saveExtractionChunkCheckpoint');
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 1 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(1);
    const saved = save.mock.calls.at(-1)![0].output as typeof original;
    expect(saved.repairAttempted).toBe(true); expect(saved.reading.extraction).not.toHaveProperty('reportMetadata');
    expect(saved.excerptReceipts).toEqual(original.excerptReceipts);
    expect(save.mock.calls[0]![0].signature).toBe(canonicalCheckpointSignature(f));
  });

  it.each([false, true].flatMap((repairAttempted) => [
    { repairAttempted, previousRules: 'direct-original-acceptance-v14', previousPrompt: 'extract-direct-original-v15' },
    { repairAttempted, previousRules: 'direct-original-acceptance-v13', previousPrompt: 'extract-direct-original-v15' },
    { repairAttempted, previousRules: 'direct-original-acceptance-v12', previousPrompt: 'extract-direct-original-v14' },
    { repairAttempted, previousRules: 'direct-original-acceptance-v11', previousPrompt: 'extract-direct-original-v14' },
    { repairAttempted, previousRules: 'direct-original-acceptance-v10', previousPrompt: 'extract-direct-original-v13' }
  ]))('实际$previousPrompt/$previousRules断点升级不重读P01、不伪造来源证明或重置P03次数=$repairAttempted', async ({ repairAttempted, previousRules, previousPrompt }) => {
    const f = fixture(); const output = reading(f);
    output.extraction.candidates[0]!.value = { kind: 'numeric', rawText: '7', decimal: '8', comparator: 'eq' };
    const previous = saveCanonicalCheckpoint(f, output, repairAttempted, previousRules, previousPrompt);
    const runtime = { runStructuredTurn: vi.fn().mockImplementation(async (input) => {
      expect(input.prompt.startsWith('# DIRECT_ORIGINAL_P03')).toBe(true);
      return receipt(targetRepair(f, previous.reading, input, { c_a: { nodeType: 'candidate', value: candidate() } }), 2);
    }) };
    const checkpointWrites: unknown[] = [];
    const saveCheckpoint = f.store.saveExtractionChunkCheckpoint.bind(f.store);
    const save = vi.spyOn(f.store, 'saveExtractionChunkCheckpoint').mockImplementation((input) => {
      checkpointWrites.push(structuredClone(input.output));
      return saveCheckpoint(input);
    });
    await pipeline(f, runtime).process(f.documentId);
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(repairAttempted ? 0 : 1);
    expect(checkpointWrites[0]).toEqual(previous);
    expect(save.mock.calls.every(([input]) => !Object.hasOwn(input.output as object, 'firstTransmissionId')
      && !Object.hasOwn(input.output as object, 'sourceRefinementReview'))).toBe(true);
  });

  it.each([false, true].flatMap((repairAttempted) => ['extract-direct-original-v4', 'extract-direct-original-v7',
    'extract-direct-original-v8', 'extract-direct-original-v9', 'extract-direct-original-v10', 'extract-direct-original-v11',
    'extract-direct-original-v12', 'extract-direct-original-v13']
    .map((previousPrompt) => ({ repairAttempted, previousPrompt }))))('旧$previousPrompt断点升级仍保留原收据和已用修复额度=$repairAttempted', async ({ repairAttempted, previousPrompt }) => {
    const f = fixture(); const output = reading(f);
    output.extraction.candidates[0]!.value = { kind: 'numeric', rawText: '7', decimal: '8', comparator: 'eq' };
    const original = saveCanonicalCheckpoint(f, output, repairAttempted,
      ['extract-direct-original-v12', 'extract-direct-original-v13'].includes(previousPrompt) ? 'direct-original-acceptance-v9'
        : previousPrompt === 'extract-direct-original-v11' ? 'direct-original-acceptance-v8' : 'direct-original-acceptance-v7', previousPrompt);
    const checkpointWrites: unknown[] = [];
    const saveCheckpoint = f.store.saveExtractionChunkCheckpoint.bind(f.store);
    const save = vi.spyOn(f.store, 'saveExtractionChunkCheckpoint').mockImplementation((input) => {
      checkpointWrites.push(structuredClone(input.output));
      return saveCheckpoint(input);
    });
    const runtime = { runStructuredTurn: vi.fn(async (input) => {
      expect(input.prompt.startsWith('# DIRECT_ORIGINAL_P03')).toBe(true);
      expect(repairRequest(input)).toMatchObject({ originalReadingHash: stableHash(original.reading) });
      return receipt(targetRepair(f, original.reading, input, { c_a: { nodeType: 'candidate', value: candidate() } }), 2);
    }) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: repairAttempted ? 'partial' : 'published',
      candidateCount: repairAttempted ? 0 : 1 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(repairAttempted ? 0 : 1);
    expect(save.mock.calls[0]![0].signature).toBe(canonicalCheckpointSignature(f));
    expect(checkpointWrites[0]).toEqual(original);
    if (repairAttempted) expect(f.store.getDocumentExtractionBundle(f.documentId).manifest.spans.find((span) => span.modelEvidence)?.modelEvidence)
      .toMatchObject(original.receipt);
  });

  it.each(['extract-direct-original-v4', 'extract-direct-original-v9'])(
    '较近%s断点损坏时不跳回更旧成功断点，也不伪称保留原收据', async (previousPrompt) => {
    const f = fixture(); saveCanonicalCheckpoint(f, reading(f), true, 'direct-original-acceptance-v6');
    f.store.saveExtractionChunkCheckpoint({ guard: f.guard, documentId: f.documentId,
      signature: canonicalCheckpointSignature(f, 'direct-original-acceptance-v7', previousPrompt), chunkIndex: 0,
      output: { checkpointKind: 'invalid_recent_cache' }, threadId: 'synthetic-invalid-thread',
      turnId: 'synthetic-invalid-turn', extractionTurnId: 'synthetic-invalid-turn' });
    const runtime = { runStructuredTurn: vi.fn(async (input) => {
      expect(input.prompt.startsWith('# DIRECT_ORIGINAL_P01')).toBe(true); return receipt(reading(f), 2);
    }) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 1 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(1);
    expect(f.store.getDocumentExtractionBundle(f.documentId).manifest.spans.find((span) => span.modelEvidence)?.modelEvidence)
      .toMatchObject({ threadId: 'synthetic-direct-thread-2', turnId: 'synthetic-direct-turn-2' });
  });

  it.each([ACCEPTANCE_RULES_VERSION, 'direct-original-acceptance-v6', 'direct-original-acceptance-v5', 'direct-original-acceptance-v4'])(
    '%s旧canonical已修断点不因升级增加P01或第二次P03，原收据与未解决候选仍保留', async (rulesVersion) => {
    const f = fixture(); const output = reading(f);
    output.extraction.candidates[0]!.value = { kind: 'numeric', rawText: '7', decimal: '8', comparator: 'eq' };
    const original = saveCanonicalCheckpoint(f, output, true, rulesVersion);
    const runtime = { runStructuredTurn: vi.fn() };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: 0 });
    expect(runtime.runStructuredTurn).not.toHaveBeenCalled();
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual([]);
    expect(f.store.getDocumentExtractionBundle(f.documentId).manifest.spans.find((span) => span.modelEvidence)?.modelEvidence)
      .toMatchObject(original.receipt);
    expect(f.store.listOpenExtractionReviewIssues()[0]?.candidateOptions[0]?.value).toEqual(output.extraction.candidates[0]!.value);
    expect(f.store.listExtractionRepairDiagnostics({ documentId: f.documentId })).toEqual([]);
  });

  it.each([ACCEPTANCE_RULES_VERSION, 'direct-original-acceptance-v6', 'direct-original-acceptance-v5'])(
    '%s较近断点损坏时不退回更旧有效断点，也不伪称复用了旧收据', async (rulesVersion) => {
      const f = fixture();
      saveCanonicalCheckpoint(f, reading(f), true, 'direct-original-acceptance-v4');
      f.store.saveExtractionChunkCheckpoint({ guard: f.guard, documentId: f.documentId,
        signature: canonicalCheckpointSignature(f, rulesVersion), chunkIndex: 0,
        output: { checkpointKind: 'synthetic_invalid_checkpoint' },
        threadId: 'synthetic-invalid-cache-thread', turnId: 'synthetic-invalid-cache-turn',
        extractionTurnId: 'synthetic-invalid-cache-turn' });
      const runtime = { runStructuredTurn: vi.fn(async (input: { prompt: string }) => {
        expect(input.prompt.startsWith('# DIRECT_ORIGINAL_P01\n')).toBe(true);
        return receipt(reading(f), 2);
      }) };
      expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 1 });
      expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(1);
      expect(f.store.getDocumentExtractionBundle(f.documentId).manifest.spans.find((span) => span.modelEvidence)?.modelEvidence)
        .toMatchObject({ threadId: 'synthetic-direct-thread-2', turnId: 'synthetic-direct-turn-2' });
    });

  it.each(['finding', 'instruction'] as const)(
    '同可信%s摘录内互不重叠的标题与结果窄引用，正常预检和发布无需额外P03', async (role) => {
      const f = fixture(); const output = reading(f);
      const resultText = role === 'finding' ? '合成指标 7 U/L' : '合成安排内容，不构成真实医学建议。';
      output.sourceExcerpts[0]!.quote = `合成独立栏目\n${resultText}`;
      output.sourceExcerpts[0]!.role = role;
      const item = output.extraction.candidates[0]!;
      item.evidence[0]!.quote = resultText;
      item.sourceBinding = { headingEvidence: [{ sourceSpanId: 'e_a', quote: '合成独立栏目' }],
        findingEvidence: [item.evidence[0]!] };
      if (role === 'instruction') { item.value = { kind: 'text', rawText: resultText }; item.unitRaw = null; }
      const original = structuredClone(output);
      const runtime = { runStructuredTurn: vi.fn(async (input) => {
        expect(input.prompt.startsWith('# DIRECT_ORIGINAL_P01')).toBe(true);
        return receipt(output);
      }) };
      expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 1 });
      expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(1);
      expect(f.store.listOpenExtractionReviewIssues()).toEqual([]);
      expect(f.store.listExtractionRepairDiagnostics({ documentId: f.documentId })).toEqual([]);
      expect(output).toEqual(original);
      expect(f.store.listAcceptedObservations(f.person.id)[0]?.rawText).toBe(item.value.rawText);
    });

  it('同页两个独立结果各自复用标题与结果摘录，一次读取正常发布且不丢否定或左右侧', async () => {
    const f = fixture(); const output = reading(f);
    const results = ['左侧合成所见未见异常', '右侧合成所见需结合其他检查'];
    output.sourceExcerpts = results.map((result, index) => ({ localKey: `e_${index + 1}`,
      pageSourceSpanId: f.manifest.spans[0]!.id, quote: `合成检查栏目\n${result}`, role: 'finding', clarity: 'clear' }));
    output.extraction.candidates = results.map((result, index) => {
      const ref = { sourceSpanId: `e_${index + 1}`, quote: result };
      return { ...candidate(`c_${index + 1}`), originalName: `合成所见（${index === 0 ? '左' : '右'}）`,
        value: { kind: 'text' as const, rawText: result }, unitRaw: null, evidence: [ref],
        sourceBinding: { headingEvidence: [{ sourceSpanId: ref.sourceSpanId, quote: '合成检查栏目' }], findingEvidence: [ref] } };
    });
    inventoryForSyntheticReading(output);
    const runtime = { runStructuredTurn: vi.fn(async () => receipt(output)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 2 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(1);
    expect(f.store.listAcceptedObservations(f.person.id).map((fact) => fact.rawText).sort()).toEqual(results.toSorted());
  });

  it('重叠标题绑定由唯一一次P03重读后修窄引用，不由应用裁切，原结果限定词保持完整', async () => {
    const f = fixture(); const output = reading(f);
    const result = '左侧合成结果未见明显异常';
    output.sourceExcerpts[0]!.quote = `合成独立栏目\n${result}`;
    const item = output.extraction.candidates[0]!;
    item.value = { kind: 'text', rawText: result }; item.unitRaw = null;
    item.evidence = [{ sourceSpanId: 'e_a', quote: output.sourceExcerpts[0]!.quote }];
    item.sourceBinding = { headingEvidence: [{ sourceSpanId: 'e_a', quote: '合成独立栏目' }], findingEvidence: [...item.evidence] };
    const fixed = structuredClone(item); fixed.evidence[0]!.quote = result;
    fixed.sourceBinding!.findingEvidence = [...fixed.evidence];
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output)).mockImplementationOnce(async (input) => {
      expect(repairRequest(input).targets).toContainEqual({ targetId: 'c_a', nodeType: 'candidate' });
      return receipt(targetRepair(f, output, input, { c_a: { nodeType: 'candidate', value: fixed } }), 2);
    }) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 1 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
    expect(f.store.listAcceptedObservations(f.person.id)[0]!.rawText).toBe(result);
  });

  it.each(['canonical', 'wrong_wire_version'] as const)('新P01仅收显式wire，%s不按JSON长相回退或生成事实', async (problem) => {
    const f = fixture(); const output = reading(f);
    const wire = encodeDirectOriginalReading(output);
    const runtime = { runStructuredTurn: vi.fn(async () => rawReceipt(problem === 'canonical' ? output : {
      ...wire, wireVersion: 'unsupported-synthetic-wire' })) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', reason: 'DIRECT_ORIGINAL_STRUCTURE_INVALID' });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2); expect(f.store.listAcceptedObservations(f.person.id)).toEqual([]);
  });

  it('首次格式失败自动重读同一完整原件，成功后仍可使用唯一内容修复', async () => {
    const f = fixture(9); const output = reading(f);
    output.extraction.candidates[0]!.value = { kind: 'numeric', rawText: '7', decimal: '8', comparator: 'eq' };
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(rawReceipt({ invalid: true }))
      .mockResolvedValueOnce(receipt(output, 2)).mockImplementationOnce(async (input) =>
        receipt(targetRepair(f, output, input, { c_a: { nodeType: 'candidate', value: candidate() } }), 3)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 1 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(3);
    const inputs = runtime.runStructuredTurn.mock.calls.map(([input]) => input);
    expect(inputs.map((input) => input.imagePaths)).toEqual([f.prepared.imagePaths, f.prepared.imagePaths, f.prepared.imagePaths]);
    expect(inputs.every((input) => input.allowWebSearch === false)).toBe(true);
    expect(inputs[1]!.prompt).toContain('唯一一次输出格式恢复');
    expect(inputs[2]!.prompt.startsWith('# DIRECT_ORIGINAL_P03\n')).toBe(true);
    expect(f.store.listAcceptedObservations(f.person.id)[0]?.decimalValue).toBe('7');
    expect(f.store.listOpenExtractionReviewIssues()).toEqual([]);
  });

  it.each(['CODEX_STRUCTURED_OUTPUT_INVALID', 'CODEX_STRUCTURED_OUTPUT_MISSING'])('固定输出错误%s自动恢复，不要求用户点击', async (code) => {
    const f = fixture();
    const runtime = { runStructuredTurn: vi.fn().mockRejectedValueOnce(new Error(code))
      .mockResolvedValueOnce(receipt(reading(f), 2)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 1 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
    expect(f.store.listOpenExtractionReviewIssues()).toEqual([]);
  });

  it('格式恢复在发送前持久化，进程退出后的新attempt只续接有限恢复请求', async () => {
    const f = fixture();
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(rawReceipt({ invalid: true }))
      .mockRejectedValueOnce(new Error('CODEX_RUNTIME_EXITED')).mockResolvedValueOnce(receipt(reading(f), 3)) };
    await expect(pipeline(f, runtime).process(f.documentId)).rejects.toThrow('CODEX_RUNTIME_EXITED');
    f.store.finishJob(f.job.id, 'failed');
    f.store.finishJobAttempt({ attemptId: f.guard.attemptId, status: 'failed', errorCode: 'CODEX_RUNTIME_EXITED' });
    f.store.retryFailedJob(f.job.id);
    const resumedJob = f.store.claimNextQueuedJob('synthetic-format-resumed-runner', f.guard.accountFingerprint)!;
    const attemptId = f.store.startJobAttempt(resumedJob.id, 'synthetic-runtime', 'gpt-6.1-sol', 'medium');
    const resumed = { ...f, guard: { ...f.guard, attemptId } };
    expect(await pipeline(resumed, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 1 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(3);
    expect(runtime.runStructuredTurn.mock.calls[1]![0].prompt).toBe(runtime.runStructuredTurn.mock.calls[2]![0].prompt);
  });

  it.each(['CODEX_CONNECTION_FAILED', 'CODEX_TURN_TIMEOUT'])('格式恢复%s后仍可完成同一有限恢复，不误判内容失败', async (code) => {
    const f = fixture();
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(rawReceipt({ invalid: true }))
      .mockRejectedValueOnce(new Error(code)).mockResolvedValueOnce(receipt(reading(f), 3)) };
    await expect(pipeline(f, runtime).process(f.documentId)).rejects.toThrow(code);
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 1 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(3);
  });

  it('格式恢复传输预算跨续跑有限，连续未知终态不会无限重发', async () => {
    const f = fixture();
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(rawReceipt({ invalid: true }))
      .mockRejectedValue(new Error('CODEX_CONNECTION_FAILED')) };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(pipeline(f, runtime).process(f.documentId)).rejects.toThrow('CODEX_CONNECTION_FAILED');
    }
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', reason: 'DIRECT_ORIGINAL_STRUCTURE_INVALID' });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(4);
  });

  it('格式恢复明确繁忙后新attempt仅继续同一恢复请求，连续繁忙不重读首次P01', async () => {
    const f = fixture(5);
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(rawReceipt({ invalid: true }))
      .mockRejectedValueOnce(new Error('CODEX_MODEL_BUSY')).mockRejectedValueOnce(new Error('CODEX_MODEL_BUSY'))
      .mockResolvedValueOnce(receipt(reading(f), 4)) };
    await expect(pipeline(f, runtime).process(f.documentId)).rejects.toThrow('CODEX_MODEL_BUSY');
    f.store.finishJob(f.job.id, 'failed');
    f.store.finishJobAttempt({ attemptId: f.guard.attemptId, status: 'failed', errorCode: 'CODEX_MODEL_BUSY' });
    f.store.retryFailedJob(f.job.id);
    const resumedJob = f.store.claimNextQueuedJob('synthetic-busy-format-runner', f.guard.accountFingerprint)!;
    const attemptId = f.store.startJobAttempt(resumedJob.id, 'synthetic-runtime', 'gpt-6.1-sol', 'medium');
    const resumed = { ...f, guard: { ...f.guard, attemptId } };
    await expect(pipeline(resumed, runtime).process(f.documentId)).rejects.toThrow('CODEX_MODEL_BUSY');
    expect(await pipeline(resumed, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 1 });
    const inputs = runtime.runStructuredTurn.mock.calls.map(([input]) => input);
    expect(inputs).toHaveLength(4);
    expect(inputs[0]!.prompt).not.toContain('唯一一次输出格式恢复');
    expect(inputs.slice(1).every((input) => input.prompt.includes('唯一一次输出格式恢复'))).toBe(true);
    expect(inputs.slice(1).map((input) => input.prompt)).toEqual(Array(3).fill(inputs[1]!.prompt));
    expect(inputs.every((input) => input.allowWebSearch === false)).toBe(true);
    expect(inputs.map((input) => input.imagePaths)).toEqual(Array(4).fill(f.prepared.imagePaths));
    expect(f.store.listOpenExtractionReviewIssues()).toEqual([]);
  });

  it('格式恢复耗尽后再次续读只返回范围提示，不新增模型调用', async () => {
    const f = fixture(); const runtime = { runStructuredTurn: vi.fn(async () => rawReceipt({ invalid: true })) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', requiresUser: false });
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', requiresUser: false });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual([]);
  });

  it('未知解码程序错误不伪装成报告格式问题或触发自动恢复', async () => {
    const f = fixture(); const wire = encodeDirectOriginalReading(reading(f));
    Object.defineProperty(wire, 'wireVersion', { enumerable: true, get() { throw new Error('SYNTHETIC_INTERNAL_BUG'); } });
    const runtime = { runStructuredTurn: vi.fn(async () => rawReceipt(wire)) };
    await expect(pipeline(f, runtime).process(f.documentId)).rejects.toThrow('SYNTHETIC_INTERNAL_BUG');
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(1);
    expect(f.store.listOpenExtractionReviewIssues()).toEqual([]);
  });

  it.each(['cancel', 'consent'] as const)('格式恢复返回时发生%s，不能保存结果或继续下一次读取', async (gate) => {
    const f = fixture();
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(rawReceipt({ invalid: true }))
      .mockImplementationOnce(async () => {
        if (gate === 'cancel') f.store.requestJobCancellation(f.job.id);
        else f.store.revokeAllAiAuthorizations();
        return receipt(reading(f), 2);
      }) };
    await expect(pipeline(f, runtime).process(f.documentId)).rejects.toThrow(gate === 'cancel' ? 'JOB_CANCELLED' : 'CONSENT_REVOKED');
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual([]);
    expect(f.store.listOpenExtractionReviewIssues()).toEqual([]);
  });

  it.each([
    ['envelope', 'DIRECT_ORIGINAL_STRUCTURE_ENVELOPE_INVALID'],
    ['version', 'DIRECT_ORIGINAL_STRUCTURE_WIRE_VERSION_MISMATCH'],
    ['contract', 'DIRECT_ORIGINAL_STRUCTURE_WIRE_CONTRACT_MISMATCH'],
    ['payload', 'DIRECT_ORIGINAL_STRUCTURE_WIRE_PAYLOAD_INVALID'],
    ['canonical', 'DIRECT_ORIGINAL_STRUCTURE_CANONICAL_SCHEMA_INVALID'],
    ['document', 'DIRECT_ORIGINAL_STRUCTURE_DOCUMENT_MISMATCH']
  ] as const)('P01的%s只持久化固定子原因，唯一格式恢复不保存私人异常或未知字段', async (problem, reason) => {
    const f = fixture(); const wire = encodeDirectOriginalReading(reading(f));
    const privateMarker = 'synthetic-private-receipt-and-field';
    if (problem === 'envelope') Object.assign(wire, { [privateMarker]: privateMarker });
    if (problem === 'version') Object.assign(wire, { wireVersion: privateMarker });
    if (problem === 'contract') Object.assign(wire, { contract: privateMarker });
    if (problem === 'payload') wire.payload[privateMarker] = privateMarker;
    if (problem === 'canonical') {
      const excerpts = wire.payload[DIRECT_ORIGINAL_WIRE_KEY_MAP.sourceExcerpts] as unknown[];
      excerpts.push(structuredClone(excerpts[0]));
    }
    if (problem === 'document') {
      wire.payload[DIRECT_ORIGINAL_WIRE_KEY_MAP.documentId] = privateMarker;
      const extraction = wire.payload[DIRECT_ORIGINAL_WIRE_KEY_MAP.extraction] as Record<string, unknown>;
      extraction[DIRECT_ORIGINAL_WIRE_KEY_MAP.documentId] = privateMarker;
    }
    const savedIssues = vi.spyOn(f.store, 'saveExtractionReviewIssue');
    const checkpoints = vi.spyOn(f.store, 'saveExtractionChunkCheckpoint');
    const runtime = { runStructuredTurn: vi.fn(async () => rawReceipt(wire)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial',
      reason: 'DIRECT_ORIGINAL_STRUCTURE_INVALID', requiresUser: false });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
    expect(checkpoints).toHaveBeenCalledTimes(3);
    expect(checkpoints.mock.calls.every(([input]) => !JSON.stringify(input.output).includes(privateMarker))).toBe(true);
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual([]);
    expect(f.store.listExtractionRepairDiagnostics({ documentId: f.documentId })).toEqual([]);
    expect(f.store.listOpenExtractionReviewIssues()[0]?.reasonCodes).toEqual(['DIRECT_ORIGINAL_STRUCTURE_INVALID', reason]);
    expect(f.store.listOpenExtractionReviewIssues()[0]?.candidateOptions).toEqual([]);
    expect(savedIssues).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(savedIssues.mock.calls)).not.toContain(privateMarker);
  });

  it.each(['canonical', 'wrong_wire_version', 'wrong_contract', 'missing_presence'] as const)(
    'P03的%s只记结构失败，不回退长对象、不改非目标或新增修复轮次', async (problem) => {
      const f = fixture(); const output = reading(f);
      output.extraction.candidates[0]!.value = { kind: 'numeric', rawText: '7', decimal: '8', comparator: 'eq' };
      output.sourceExcerpts.push({ localKey: 'e_b', pageSourceSpanId: f.manifest.spans[0]!.id,
        quote: '合成指标 11 U/L', role: 'finding', clarity: 'clear' });
      output.extraction.candidates.push(candidate('c_b', 'e_b', '11'));
      const patch = repair(f, output, [{ targetId: 'c_a', action: 'replace', replacement: { nodeType: 'candidate', value: candidate() } }]);
      const wire = encodeDirectOriginalRepair(patch);
      let invalid: unknown = wire;
      if (problem === 'canonical') invalid = patch;
      if (problem === 'wrong_wire_version') invalid = { ...wire, wireVersion: 'unsupported-synthetic-wire' };
      if (problem === 'wrong_contract') invalid = { ...wire, contract: 'reading' };
      if (problem === 'missing_presence') {
        const results = wire.payload[DIRECT_ORIGINAL_WIRE_KEY_MAP.results] as Record<string, unknown>[];
        const replacement = results[0]![DIRECT_ORIGINAL_WIRE_KEY_MAP.replacement] as Record<string, unknown>;
        const value = replacement[DIRECT_ORIGINAL_WIRE_KEY_MAP.value] as Record<string, unknown>;
        delete value._p;
      }
      const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output)).mockResolvedValueOnce(rawReceipt(invalid, 2)) };
      expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: 1 });
      expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
      expect(f.store.listAcceptedObservations(f.person.id).map((fact) => fact.rawText)).toEqual(['11']);
      expect(f.store.listOpenExtractionReviewIssues()[0]?.candidateOptions[0]?.value).toEqual(output.extraction.candidates[0]!.value);
      expect(f.store.listExtractionRepairDiagnostics({ documentId: f.documentId })[0]?.outcome).toBe('schema_invalid');
    });

  it.each(['repair', 'unchanged'] as const)('多日期主日缺失进入唯一metadata修复，%s不改项目真实日期或猜首项', async (action) => {
    const f = fixture(); const output = reading(f);
    const oldRef = { sourceSpanId: 'e_history_date', quote: '合成历史轴日期 2022-02-03' };
    const currentRef = { sourceSpanId: 'e_current_date', quote: '合成本次检查日期 2026-02-03' };
    output.sourceExcerpts.push(
      { localKey: oldRef.sourceSpanId, pageSourceSpanId: f.manifest.spans[0]!.id, quote: oldRef.quote, role: 'date', clarity: 'clear' },
      { localKey: currentRef.sourceSpanId, pageSourceSpanId: f.manifest.spans[0]!.id, quote: currentRef.quote, role: 'date', clarity: 'clear' });
    output.extraction.candidates[0]!.clinicalDate = '2026-02-03';
    output.extraction.candidates[0]!.sourceBinding!.findingEvidence = [...output.extraction.candidates[0]!.evidence];
    output.extraction.candidates[0]!.evidence.push(currentRef);
    output.extraction.reportMetadata = { reportKind: null, title: null, organization: null, campus: null,
      department: null, reportNumber: null, examItems: [], times: [
        { value: '2022-02-03', precision: 'day', role: 'examined', evidence: [oldRef] },
        { value: '2026-02-03', precision: 'day', role: 'examined', evidence: [currentRef] }
      ] };
    const publish = vi.spyOn(f.store, 'publishFacts');
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output)).mockImplementationOnce(async (input) => {
      const request = repairRequest(input);
      expect(request.issues).toContain('direct_original_primary_clinical_time_required');
      expect(request.targets).toEqual([{ targetId: 'metadata', nodeType: 'metadata' }]);
      const replacement = { ...output.extraction.reportMetadata!, primaryClinicalTimeIndex: 1,
        times: output.extraction.reportMetadata!.times.map((time, index) => index === 0 ? { ...time, role: 'history_quoted' as const } : time) };
      return receipt(targetRepair(f, output, input, action === 'repair'
        ? { metadata: { nodeType: 'metadata', value: replacement } } : {}), 2);
    }) };
    await pipeline(f, runtime).process(f.documentId);
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
    for (const [input] of runtime.runStructuredTurn.mock.calls) expect(input.imagePaths).toEqual(f.prepared.imagePaths);
    expect(publish).toHaveBeenCalledTimes(1);
    if (action === 'repair') expect(publish.mock.calls[0]![0].reportMetadata).toMatchObject({ primaryClinicalTimeIndex: 1,
      times: [expect.objectContaining({ role: 'history_quoted' }), expect.objectContaining({ role: 'examined' })] });
    else expect(publish.mock.calls[0]![0].reportMetadata).toMatchObject({ primaryClinicalTimeIndex: null,
      times: [expect.objectContaining({ value: '2022-02-03', role: 'examined' }),
        expect.objectContaining({ value: '2026-02-03', role: 'examined' })] });
    expect(f.store.listAcceptedObservations(f.person.id)[0]).toMatchObject({ rawText: '7', clinicalDate: '2026-02-03' });
  });
  it('页补漏带已有只读字段和跨页引用闭包，目标不重复且其他页仅占用key；遮挡仍未知但真遗漏可补', async () => {
    const f = fixture(4); const { output, pageId, existing, hidden, outside } = partialPageWithExistingFields(f);
    f.prepared.nativeText = '完整原生技术附注：第一页\n第二页\n第三页\n第四页，不裁剪';
    const original = structuredClone(output);
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output)).mockImplementationOnce(async (input) => {
      const context = readOnlyPageContext(input); const request = repairRequest(input);
      expect(context.schemaVersion).toBe(1);
      expect(context.targetPages).toEqual([{ pageSourceSpanId: pageId, candidates: [
        { localKey: existing.localKey, access: 'immutable_non_target', value: existing },
        { localKey: hidden.localKey, access: 'authorized_target', targetId: hidden.localKey }
      ] }]);
      expect(request.targets.some((target) => target.targetId === existing.localKey || target.targetId === outside.localKey)).toBe(false);
      expect(request.targets.some((target) => [f.manifest.spans[0]!.id, f.manifest.spans[1]!.id, f.manifest.spans[3]!.id].includes(target.targetId))).toBe(false);
      expect(context.referencedExcerpts.map((entry) => entry.localKey).sort()).toEqual(['e_a', 'e_condition', 'e_date', 'e_heading', 'e_hidden']);
      expect(context.referencedExcerpts.find((entry) => entry.localKey === 'e_hidden'))
        .toEqual({ localKey: 'e_hidden', access: 'authorized_target', targetId: 'e_hidden' });
      for (const key of ['e_date', 'e_heading', 'e_condition']) {
        expect(context.referencedExcerpts.find((entry) => entry.localKey === key)).toEqual({
          localKey: key, access: 'immutable_non_target', value: output.sourceExcerpts.find((excerpt) => excerpt.localKey === key) });
        expect(request.targets.some((target) => target.targetId === key)).toBe(false);
      }
      expect(context.reservedLocalKeys).toEqual(expect.arrayContaining([
        ...f.manifest.spans.map((span) => span.id), ...output.sourceExcerpts.map((excerpt) => excerpt.localKey),
        ...output.extraction.candidates.map((candidate) => candidate.localKey), 'subject', 'metadata'
      ]));
      expect(new Set(context.reservedLocalKeys).size).toBe(context.reservedLocalKeys.length);
      expect(targetItems(input).find((target) => target.targetId === hidden.localKey)!.value).toEqual(hidden);
      const newCandidate = candidate('c_new', 'e_new', '17'); newCandidate.originalName = '合成真正遗漏项目';
      newCandidate.evidence[0]!.quote = '合成真正遗漏项目 17 U/L';
      expect(context.reservedLocalKeys).not.toContain(newCandidate.localKey); expect(context.reservedLocalKeys).not.toContain('e_new');
      return receipt(targetRepair(f, output, input, { [pageId]: { nodeType: 'page', value: { sourceSpanId: pageId,
        status: 'partial', newExcerpts: [{ localKey: 'e_new', pageSourceSpanId: pageId, quote: newCandidate.evidence[0]!.quote!,
          role: 'finding', clarity: 'clear' }], newCandidates: [newCandidate] } } }), 2);
    }) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: 3 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
    for (const [input] of runtime.runStructuredTurn.mock.calls) {
      expect(input).toMatchObject({ imagePaths: f.prepared.imagePaths, allowWebSearch: false });
      expect(input.prompt).toContain(JSON.stringify(f.prepared.nativeText));
    }
    const saved = f.store.listAcceptedObservations(f.person.id);
    expect(saved.map((item) => item.originalName).sort()).toEqual(['合成真正遗漏项目', '合成独立项目', '合成甲项'].sort());
    expect(saved.find((item) => item.originalName === existing.originalName)).toMatchObject({
      rawText: existing.value.rawText, clinicalDate: existing.clinicalDate, unit: existing.unitRaw });
    expect(saved.find((item) => item.originalName === existing.originalName)?.clinicalContext?.conditions[0]?.quote)
      .toBe(existing.clinicalContext!.conditions[0]!.quote);
    const held = f.store.listOpenExtractionReviewIssues()[0]!.candidateOptions.find((item) => item.localKey === hidden.localKey)!;
    expect(held.value).toEqual(hidden.value); expect(saved.some((item) => item.originalName === hidden.originalName)).toBe(false);
    expect(output).toEqual(original);
  });

  it('页目录不是授权：跨页条件/日期以及已有非目标候选不能被P03替换', async () => {
    const f = fixture(4); const { output, pageId, existing } = partialPageWithExistingFields(f);
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output)).mockImplementationOnce(async (input) => {
      expect(readOnlyPageContext(input).targetPages[0]!.candidates[0]!.access).toBe('immutable_non_target');
      const patch = targetRepair(f, output, input, { [pageId]: { nodeType: 'page', value: { sourceSpanId: pageId, status: 'partial' } } });
      patch.results.push({ targetId: existing.localKey, action: 'replace', replacement: { nodeType: 'candidate', value: {
        ...existing, value: { kind: 'numeric', rawText: '99', decimal: '99', comparator: 'eq' }, clinicalDate: null,
        clinicalContext: { version: 1, status: 'complete', conditions: [] } } } });
      return receipt(patch, 2);
    }) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: 2 });
    expect(f.store.listAcceptedObservations(f.person.id).find((item) => item.originalName === existing.originalName))
      .toMatchObject({ rawText: '7', clinicalDate: '2026-02-03' });
    expect(f.store.listExtractionRepairDiagnostics({ documentId: f.documentId })[0]?.outcome).toBe('scope_violation');
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
  });

  it('全局key目录包含不展开的其他页；撞其既有候选key的新补漏被拒绝', async () => {
    const f = fixture(4); const { output, pageId, outside } = partialPageWithExistingFields(f);
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output)).mockImplementationOnce(async (input) => {
      const context = readOnlyPageContext(input);
      expect(context.targetPages.some((page) => page.pageSourceSpanId === f.manifest.spans[3]!.id)).toBe(false);
      expect(context.referencedExcerpts.some((excerpt) => excerpt.localKey === 'e_outside')).toBe(false);
      expect(context.reservedLocalKeys).toContain(outside.localKey);
      const addition = candidate(outside.localKey, 'e_new', '17'); addition.originalName = '合成真正遗漏项目';
      return receipt(targetRepair(f, output, input, { [pageId]: { nodeType: 'page', value: { sourceSpanId: pageId,
        status: 'partial', newExcerpts: [{ localKey: 'e_new', pageSourceSpanId: pageId, quote: '合成指标 17 U/L',
          role: 'finding', clarity: 'clear' }], newCandidates: [addition] } } }), 2);
    }) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: 2 });
    expect(f.store.listAcceptedObservations(f.person.id).find((item) => item.originalName === outside.originalName)?.rawText).toBe('13');
    expect(f.store.listExtractionRepairDiagnostics({ documentId: f.documentId })[0]?.outcome).toBe('scope_violation');
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
  });

  it('页目录不自动等价合并重输出字段，真实同槽参考范围差异仍hold且只修一次', async () => {
    const f = fixture(); const output = reading(f); const pageId = f.manifest.spans[0]!.id;
    output.pageReadings[0]!.status = 'partial';
    output.sourceExcerpts[0]!.quote = '合成指标 7 U/L 参考范围3–9';
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output)).mockImplementationOnce(async (input) => {
      expect(readOnlyPageContext(input).targetPages[0]!.candidates[0])
        .toMatchObject({ localKey: 'c_a', access: 'immutable_non_target', value: output.extraction.candidates[0] });
      const duplicate = structuredClone(output.extraction.candidates[0]!); duplicate.localKey = 'c_new'; duplicate.referenceRangeRaw = '3–9';
      return receipt(targetRepair(f, output, input, { [pageId]: { nodeType: 'page', value: {
        sourceSpanId: pageId, status: 'read', newCandidates: [duplicate] } } }), 2);
    }) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: 0 });
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual([]);
    expect(f.store.listOpenExtractionReviewIssues()[0]?.reasonCodes).toContain('same_source_finding_batch_conflict');
    expect(f.store.listOpenExtractionReviewIssues()[0]?.readingAudit).toMatchObject({ totalCandidates: 2,
      savedCandidates: 0, emptyCandidates: 0, pending: [{ localKey: 'c_a' }, { localKey: 'c_new' }] });
    expect(f.store.listExtractionRepairDiagnostics({ documentId: f.documentId })[0]?.outcome).toBe('still_failed');
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
  });

  it('首次保存前发现泛化字段冲突，P03补真实栏目后接纳；预检不保存来源或接纳决定', async () => {
    const f = fixture(3); const output = reading(f); const pageId = f.manifest.spans[2]!.id;
    output.extraction.candidates[0]!.originalName = '合成综合检查';
    const second = candidate('c_b', 'e_b', '11'); second.originalName = '合成综合检查'; second.bodySite = '合成部位乙';
    output.sourceExcerpts.push({ localKey: 'e_b', pageSourceSpanId: pageId, quote: '合成指标 11 U/L', role: 'finding', clarity: 'clear' });
    const unchanged = candidate('c_other', 'e_other', '13'); unchanged.originalName = '合成独立项目';
    output.sourceExcerpts.push({ localKey: 'e_other', pageSourceSpanId: f.manifest.spans[0]!.id,
      quote: '合成指标 13 U/L', role: 'finding', clarity: 'clear' });
    output.extraction.candidates.push(second, unchanged);
    inventoryForSyntheticReading(output);
    const original = structuredClone(output);
    const sourceSave = vi.spyOn(f.store, 'saveDirectOriginalEvidenceForProcessing');
    const acceptanceSave = vi.spyOn(f.store, 'saveAcceptanceDecision');
    const publish = vi.spyOn(f.store, 'publishFacts');
    const preview = vi.spyOn(f.store, 'previewDirectOriginalAdmission');
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output)).mockImplementationOnce(async (input) => {
      expect(sourceSave).not.toHaveBeenCalled(); expect(acceptanceSave).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
      expect(f.store.getDocumentExtractionBundle(f.documentId).manifest.spans.every((span) => !span.modelEvidence)).toBe(true);
      expect(f.store.listAcceptedObservations(f.person.id)).toEqual([]);
      const request = repairRequest(input);
      expect(request.issues).toContain('same_source_finding_batch_conflict');
      expect(request.targets).toEqual(expect.arrayContaining([{ targetId: 'c_a', nodeType: 'candidate' },
        { targetId: 'c_b', nodeType: 'candidate' }, { targetId: pageId, nodeType: 'page' }]));
      expect(request.targets.some((target) => target.targetId === 'c_other')).toBe(false);
      expect(request.targets.some((target) => target.targetId === f.manifest.spans[0]!.id)).toBe(false);
      expect(input.prompt).not.toContain('model-original-');
      const headings = [{ localKey: 'e_heading_a', pageSourceSpanId: pageId, quote: '合成栏目甲', role: 'heading' as const, clarity: 'clear' as const },
        { localKey: 'e_heading_b', pageSourceSpanId: pageId, quote: '合成栏目乙', role: 'heading' as const, clarity: 'clear' as const }];
      const fixed = [output.extraction.candidates[0]!, second].map((c, index) => ({ ...c,
        originalName: index === 0 ? '合成综合检查—甲项' : '合成综合检查—乙项',
        sourceBinding: { headingEvidence: [{ sourceSpanId: headings[index]!.localKey, quote: null }],
          findingEvidence: c.sourceBinding!.findingEvidence } }));
      return receipt(targetRepair(f, output, input, { c_a: { nodeType: 'candidate', value: fixed[0]! },
        c_b: { nodeType: 'candidate', value: fixed[1]! }, [pageId]: { nodeType: 'page', value: {
          sourceSpanId: pageId, status: 'read', newExcerpts: headings } } }), 2);
    }) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 3 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
    for (const [input] of runtime.runStructuredTurn.mock.calls) expect(input).toMatchObject({ imagePaths: f.prepared.imagePaths, allowWebSearch: false });
    expect(preview).toHaveBeenCalledTimes(2);
    expect(preview.mock.calls[0]![0].observations.every((observation) => observation.acceptanceId === 'direct-original-admission-preview')).toBe(true);
    expect(preview.mock.results[0]!.value.held).toHaveLength(2); expect(preview.mock.results[1]!.value.held).toEqual([]);
    const saved = f.store.listAcceptedObservations(f.person.id).sort((a, b) => Number(a.rawText) - Number(b.rawText));
    expect(saved.map((item) => item.rawText)).toEqual(['7', '11', '13']);
    expect(saved[1]!.bodySite).toBe('合成部位乙');
    expect(saved[2]).toMatchObject({ originalName: unchanged.originalName, method: unchanged.method, clinicalDate: null });
    expect(f.store.listOpenExtractionReviewIssues()).toEqual([]); expect(output).toEqual(original);
  });

  it('同页同名同标题的独立局部结果经一次P03补共同完整摘录后分槽接纳，不改原值、条件或否定', async () => {
    const f = fixture(); const output = reading(f); const pageId = f.manifest.spans[0]!.id;
    const heading = '合成检查栏目';
    const condition = { sourceSpanId: 'e_condition', quote: '合成检查条件：未加压' };
    const results = ['合成甲区域未见明显异常；不能排除微小变化。', '合成乙区域轻度改变；未见明显占位。'];
    output.sourceExcerpts = results.map((result, index) => ({ localKey: `e_${index + 1}`, pageSourceSpanId: pageId,
      quote: `${heading}\n${result}`, role: 'finding' as const, clarity: 'clear' as const }));
    output.sourceExcerpts.push({ localKey: condition.sourceSpanId, pageSourceSpanId: pageId,
      quote: condition.quote, role: 'context', clarity: 'clear' });
    output.extraction.candidates = results.map((result, index) => {
      const ref = { sourceSpanId: `e_${index + 1}`, quote: result };
      return { ...candidate(`c_${index + 1}`), originalName: '合成检查结果', value: { kind: 'text' as const, rawText: result },
        unitRaw: null, evidence: [ref], clinicalContext: { version: 1 as const, status: 'complete' as const, conditions: [condition] },
        sourceBinding: { headingEvidence: [{ sourceSpanId: ref.sourceSpanId, quote: heading }], findingEvidence: [ref] } };
    });
    inventoryForSyntheticReading(output);
    const original = structuredClone(output);
    // 一个连续完整摘录保留原页两个重复标题；不以改名、虚构唯一标题或不同结果值证明分槽。
    const commonQuote = `${condition.quote}\n${heading}\n${results[0]}\n${heading}\n${results[1]}`;
    expect(commonQuote.split(heading)).toHaveLength(3);
    expect(commonQuote.indexOf(results[0]!)).toBe(commonQuote.lastIndexOf(results[0]!));
    expect(commonQuote.indexOf(results[1]!)).toBe(commonQuote.lastIndexOf(results[1]!));
    expect(commonQuote.indexOf(results[0]!) + results[0]!.length).toBeLessThan(commonQuote.indexOf(results[1]!));
    const preview = vi.spyOn(f.store, 'previewDirectOriginalAdmission');
    const publish = vi.spyOn(f.store, 'publishFacts');
    const sourceSave = vi.spyOn(f.store, 'saveDirectOriginalEvidenceForProcessing');
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output)).mockImplementationOnce(async (input) => {
      expect(input.prompt.startsWith('# DIRECT_ORIGINAL_P03')).toBe(true);
      expect(sourceSave).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
      expect(f.store.listAcceptedObservations(f.person.id)).toEqual([]);
      const request = repairRequest(input);
      expect(request.issues).toContain('same_source_finding_batch_conflict');
      expect(request.targets).toEqual(expect.arrayContaining([{ targetId: 'c_1', nodeType: 'candidate' },
        { targetId: 'c_2', nodeType: 'candidate' }, { targetId: 'e_1', nodeType: 'excerpt' }]));
      const replacements = Object.fromEntries(output.extraction.candidates.map((item) => {
        const ref = { sourceSpanId: 'e_1', quote: item.value.rawText };
        return [item.localKey, { nodeType: 'candidate' as const, value: { ...item, evidence: [ref],
          sourceBinding: { headingEvidence: [], findingEvidence: [ref] } } }];
      }));
      const patch = targetRepair(f, output, input, { ...replacements,
        e_1: { nodeType: 'excerpt', value: { ...output.sourceExcerpts[0]!, quote: commonQuote } },
        [pageId]: { nodeType: 'page', value: { sourceSpanId: pageId, status: 'read',
          resultInventory: [{ sourceSpanId: 'e_1', candidateKeys: ['c_1', 'c_2'] }] } } });
      expect(patch.results.filter((item) => item.action === 'replace').map((item) => item.targetId).sort())
        .toEqual(['c_1', 'c_2', 'e_1', pageId].sort());
      expect(patch.results.filter((item) => item.action === 'replace').every((item) =>
        item.replacement?.nodeType === 'candidate' || item.replacement?.nodeType === 'excerpt' || item.replacement?.nodeType === 'page')).toBe(true);
      for (const result of patch.results) if (result.replacement?.nodeType === 'candidate') {
        const originalItem = original.extraction.candidates.find((item) => item.localKey === result.targetId)!;
        expect(result.replacement.value.value).toEqual(originalItem.value);
        expect(result.replacement.value.clinicalContext).toEqual(originalItem.clinicalContext);
        expect(result.replacement.value.sourceBinding?.headingEvidence).toEqual([]);
      }
      return receipt(patch, 2);
    }) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 2 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
    for (const [input] of runtime.runStructuredTurn.mock.calls) expect(input).toMatchObject({
      imagePaths: f.prepared.imagePaths, allowWebSearch: false });
    expect(preview).toHaveBeenCalledTimes(2);
    expect(preview.mock.results[0]!.value.held).toHaveLength(2);
    expect(preview.mock.results[1]!.value.held).toEqual([]);
    const saved = f.store.listAcceptedObservations(f.person.id);
    expect(saved).toHaveLength(2);
    expect(saved.map((fact) => fact.rawText).sort()).toEqual(results.toSorted());
    expect(saved.every((fact) => fact.originalName === '合成检查结果'
      && fact.clinicalContext?.conditions.map((item) => item.quote).join('') === condition.quote)).toBe(true);
    expect(saved.map((fact) => fact.evidence.find((ref) => results.includes(ref.quote ?? ''))?.sourceSpanId))
      .toEqual([saved[0]!.sourceSpanId, saved[0]!.sourceSpanId]);
    expect(f.store.getDocumentExtractionBundle(f.documentId).manifest.spans.filter((span) => span.quote === commonQuote)).toHaveLength(1);
    expect(f.store.listOpenExtractionReviewIssues()).toEqual([]);
    expect(f.store.listExtractionRepairDiagnostics({ documentId: f.documentId })[0]?.outcome).toBe('applied');
    expect(output).toEqual(original);
  });

  it('重复短引文在保存前进入P03，模型补唯一引用后接纳而不是首次保存才held', async () => {
    const f = fixture(2); const output = reading(f);
    output.sourceExcerpts[0]!.quote = '合成行甲 未见异常；合成行乙 未见异常';
    const c = output.extraction.candidates[0]!;
    c.originalName = '合成行甲结果'; c.value = { kind: 'text', rawText: '未见异常' }; c.unitRaw = null;
    const dateRef = { sourceSpanId: 'e_date', quote: 'Exam performed: 02/03/2026' };
    output.sourceExcerpts.push({ localKey: dateRef.sourceSpanId, pageSourceSpanId: f.manifest.spans[0]!.id,
      quote: dateRef.quote, role: 'date', clarity: 'clear' });
    output.extraction.reportMetadata = { reportKind: null, title: null, organization: null, campus: null,
      department: null, reportNumber: null, examItems: [], times: [{ value: '2026-02-03', precision: 'day', role: 'examined', evidence: [dateRef] }] };
    c.clinicalDate = '2026-02-03'; c.evidence = [{ sourceSpanId: 'e_a', quote: '未见异常' }, dateRef]; delete c.sourceBinding;
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output)).mockImplementationOnce(async (input) => {
      expect(repairRequest(input).issues).toContain('direct_original_finding_quote_not_unique');
      expect(repairRequest(input).targets.some((target) => target.targetId === 'e_date'
        || target.targetId === f.manifest.spans[0]!.id)).toBe(false); // 正确日期不是结果，不扩大必要页权限。
      const ref = { sourceSpanId: 'e_a', quote: '合成行甲 未见异常' };
      return receipt(targetRepair(f, output, input, { c_a: { nodeType: 'candidate', value: {
        ...c, evidence: [ref, dateRef], sourceBinding: { headingEvidence: [], findingEvidence: [ref] } } } }), 2);
    }) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 1 });
    expect(f.store.listOpenExtractionReviewIssues()).toEqual([]);
    expect(f.store.listExtractionRepairDiagnostics({ documentId: f.documentId })[0]?.outcome).toBe('applied');
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
    expect(f.store.listAcceptedObservations(f.person.id)[0]?.clinicalDate).toBe('2026-02-03');
  });

  it('真实同槽冲突仅一次P03且unchanged后仍held，不改数值或用局部字段清空绕过', async () => {
    const f = fixture(); const output = reading(f);
    const conflict = { ...candidate('c_b'), value: { kind: 'numeric' as const, rawText: '11', decimal: '11', comparator: 'eq' as const } };
    output.extraction.candidates.push(conflict);
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output)).mockImplementationOnce(async (input) =>
      receipt(targetRepair(f, output, input), 2)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: 0 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual([]);
    expect(f.store.listOpenExtractionReviewIssues()[0]?.reasonCodes).toContain('same_source_finding_batch_conflict');
    expect(f.store.listExtractionRepairDiagnostics({ documentId: f.documentId })[0]?.outcome).toBe('still_failed');
  });

  it('修复共享摘录授权完整引用者闭包，原有可靠引用者不被悄悄改写', async () => {
    const f = fixture(); const output = reading(f); const pageId = f.manifest.spans[0]!.id;
    output.sourceExcerpts[0]!.quote = '合成字段甲 未见异常；合成字段乙 未见异常';
    const c = output.extraction.candidates[0]!; c.originalName = '合成字段甲'; c.value = { kind: 'text', rawText: '未见异常' }; c.unitRaw = null;
    c.evidence = [{ sourceSpanId: 'e_a', quote: '未见异常' }]; c.sourceBinding!.findingEvidence = [...c.evidence];
    const correct: ObservationCandidate = { ...c, localKey: 'c_correct', originalName: '合成字段乙',
      evidence: [{ sourceSpanId: 'e_a', quote: '合成字段乙 未见异常' }], sourceBinding: {
        headingEvidence: [], findingEvidence: [{ sourceSpanId: 'e_a', quote: '合成字段乙 未见异常' }] } };
    output.extraction.candidates.push(correct);
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output)).mockImplementationOnce(async (input) => {
      expect(repairRequest(input).targets).toEqual(expect.arrayContaining([{ targetId: 'c_correct', nodeType: 'candidate' },
        { targetId: 'e_a', nodeType: 'excerpt' }, { targetId: pageId, nodeType: 'page' }]));
      const ref = { sourceSpanId: 'e_a', quote: '合成字段甲 未见异常' };
      return receipt(targetRepair(f, output, input, { c_a: { nodeType: 'candidate', value: {
        ...c, evidence: [ref], sourceBinding: { headingEvidence: [], findingEvidence: [ref] } } },
        e_a: { nodeType: 'excerpt', value: { ...output.sourceExcerpts[0]!, quote: `${output.sourceExcerpts[0]!.quote}；合成上下文说明` } } }), 2);
    }) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 2 });
    expect(f.store.listAcceptedObservations(f.person.id).map((item) => item.originalName).sort()).toEqual(['合成字段乙', '合成字段甲']);
    expect(f.store.getDocumentExtractionBundle(f.documentId).manifest.spans.filter((span) => span.modelEvidence?.role === 'finding')
      .every((span) => span.modelEvidence?.turnId === 'synthetic-direct-turn-2')).toBe(true);
  });

  it.each(['unchanged', 'copy_readonly_source', 'new_readonly_key', 'unresolved_mapping'] as const)(
    '已提交历史冲突的具体差异进入P03，%s不能绕过旧事实保护', async (mode) => {
    const f = fixture(); const first = reading(f); const pending = candidate('c_pending', 'e_pending', '9');
    pending.originalName = '合成待补指标'; pending.value = { kind: 'numeric', rawText: '9', decimal: '8', comparator: 'eq' };
    first.sourceExcerpts.push({ localKey: 'e_pending', pageSourceSpanId: f.manifest.spans[0]!.id,
      quote: '合成指标 9 U/L', role: 'finding', clarity: 'clear' }); first.extraction.candidates.push(pending);
    const initialRuntime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(first)).mockImplementationOnce(async (input) =>
      receipt(targetRepair(f, first, input), 2)) };
    expect(await pipeline(f, initialRuntime).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: 1 });
    const before = f.store.listAcceptedObservations(f.person.id);
    const next = structuredClone(first); next.sourceExcerpts[0]!.quote = '合成指标 8 U/L';
    next.extraction.candidates[0] = candidate('c_a', 'e_a', '8');
    next.extraction.candidates[1]!.value = { kind: 'numeric', rawText: '9', decimal: '9', comparator: 'eq' };
    const realPreview = f.store.previewDirectOriginalAdmission.bind(f.store);
    const preview = vi.spyOn(f.store, 'previewDirectOriginalAdmission');
    if (mode === 'unresolved_mapping') preview.mockImplementation((input) => {
      const result = realPreview(input);
      for (const held of result.held) for (const comparison of held.diagnostic?.comparisons ?? []) comparison.bindingStatus = 'unresolved';
      return result;
    });
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(next, 3)).mockImplementationOnce(async (input) => {
      expect(repairRequest(input).issues).toContain('same_source_finding_semantic_conflict');
      expect(repairRequest(input).targets.some((target) => target.targetId === 'c_pending')).toBe(false);
      const context = readOnlyPageContext(input);
      expect(context.reconciliationDiagnostics.find((diagnostic) => diagnostic.targetId === 'c_a')).toMatchObject({
        comparisonScope: 'stored_version', decision: 'conflict', changedFields: ['value'] });
      expect(context.comparisonRecords).toHaveLength(1);
      expect(context.comparisonRecords[0]!.value).toMatchObject({ value: { kind: 'numeric', rawText: '7', decimal: '7' } });
      expect(JSON.stringify(context)).not.toContain(before[0]!.id);
      expect(input.imagePaths).toEqual(f.prepared.imagePaths);
      const result = targetRepair(f, next, input);
      if (mode === 'unresolved_mapping') result.sourceMappings = [{ candidateKey: 'c_a',
        comparisonRecordKey: context.comparisonRecords[0]!.localKey, relation: 'same_original_field' }];
      if (mode === 'copy_readonly_source') {
        const replacement = structuredClone(next.extraction.candidates[0]!);
        replacement.evidence = [{ sourceSpanId: context.comparisonSourceExcerpts[0]!.localKey, quote: null }];
        result.results.find((entry) => entry.targetId === 'c_a')!.action = 'replace';
        result.results.find((entry) => entry.targetId === 'c_a')!.replacement = { nodeType: 'candidate', value: replacement };
      }
      if (mode === 'new_readonly_key') {
        const page = result.results.find((entry) => entry.replacement?.nodeType === 'page'
          || repairRequest(input).targets.some((target) => target.targetId === entry.targetId && target.nodeType === 'page'))!;
        page.action = 'replace'; page.replacement = { nodeType: 'page', value: { sourceSpanId: page.targetId, status: 'read', newExcerpts: [{
          localKey: context.comparisonSourceExcerpts[0]!.localKey, pageSourceSpanId: page.targetId,
          quote: '合成指标 8 U/L', role: 'finding', clarity: 'clear' }], newCandidates: [] } };
      }
      return receipt(result, 4);
    }) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: 1 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
    expect(preview.mock.results.every((result) => result.value.mode === 'append')).toBe(true);
    const saved = f.store.listAcceptedObservations(f.person.id);
    expect(saved.find((item) => item.id === before[0]!.id)).toEqual(before[0]);
    expect(saved.map((item) => item.rawText).sort()).toEqual(['7', '9']);
    expect(f.store.listOpenExtractionReviewIssues()[0]?.reasonCodes).toContain('same_source_finding_semantic_conflict');
    expect(f.store.listExtractionRepairDiagnostics({ documentId: f.documentId }).at(-1)!.outcome)
      .toBe(mode === 'unchanged' ? 'still_failed' : 'scope_violation');
  });

  it.each(['same_original_field', 'uncertain'] as const)('真实P01/P03回执的%s来源映射只补来源，不改旧医疗字段或再开P03', async (relation) => {
    const f = fixture(2); const first = reading(f); const quote = '合成安排：合成文字结果。';
    const original = first.extraction.candidates[0]!;
    original.originalName = '合成安排'; original.value = { kind: 'text', rawText: quote }; original.unitRaw = null;
    original.evidence = [{ sourceSpanId: 'e_a', quote }]; original.sourceBinding = { headingEvidence: [], findingEvidence: [...original.evidence] };
    first.sourceExcerpts[0] = { ...first.sourceExcerpts[0]!, quote, role: 'instruction' };
    const pending = candidate('c_pending', 'e_pending', '9');
    pending.originalName = '合成待补指标'; pending.value = { kind: 'numeric', rawText: '9', decimal: '8', comparator: 'eq' };
    first.sourceExcerpts.push({ localKey: 'e_pending', pageSourceSpanId: f.manifest.spans[1]!.id,
      quote: '合成指标 9 U/L', role: 'finding', clarity: 'clear' }); first.extraction.candidates.push(pending);
    const initialRuntime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(first)).mockImplementationOnce(async (input) =>
      receipt(targetRepair(f, first, input), 2)) };
    expect(await pipeline(f, initialRuntime).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: 1 });
    const before = f.store.listAcceptedObservations(f.person.id)[0]!;
    const next = structuredClone(first);
    next.sourceExcerpts[0]!.quote = `合成段落起始\n${quote}\n合成段落结束。`;
    next.sourceExcerpts.push({ localKey: 'e_heading', pageSourceSpanId: f.manifest.spans[0]!.id,
      quote: '合成安排', role: 'heading', clarity: 'clear' });
    next.extraction.candidates[0]!.sourceBinding!.headingEvidence = [{ sourceSpanId: 'e_heading', quote: '合成安排' }];
    next.extraction.candidates[1]!.value = { kind: 'numeric', rawText: '9', decimal: '9', comparator: 'eq' };
    const finish = vi.spyOn(f.store, 'finishDirectOriginalTransmission');
    const preview = vi.spyOn(f.store, 'previewDirectOriginalAdmission');
    let returnedRepair: DirectOriginalReadingRepair | undefined;
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(next, 3)).mockImplementationOnce(async (input) => {
      const context = readOnlyPageContext(input);
      const diagnostic = context.reconciliationDiagnostics.find((item) => item.targetId === 'c_a')!;
      expect(diagnostic.reasonCodes).toContain('source_binding_requires_unique_mapping');
      expect(JSON.stringify(context)).not.toContain(before.id);
      const patch = targetRepair(f, next, input);
      patch.sourceMappings = [{ candidateKey: 'c_a', comparisonRecordKey: diagnostic.comparisonRefs[0]!, relation }];
      returnedRepair = patch;
      return receipt(patch, 4);
    }) };
    const processed = await pipeline(f, runtime).process(f.documentId);
    expect({ ...processed, reason: 'reason' in processed ? processed.reason : null, calls: runtime.runStructuredTurn.mock.calls.length })
      .toEqual(expect.objectContaining({ status: relation === 'same_original_field' ? 'published' : 'partial', candidateCount: 1, calls: 2 }));
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
    expect(finish).toHaveBeenCalledTimes(2);
    expect(finish.mock.calls[0]![0]).toMatchObject({ outputHash: stableHash(directOriginalReadingResultSchema.parse(next)),
      proofVersion: 'direct-original-source-refinement-v1', turnId: 'synthetic-direct-turn-3' });
    expect(finish.mock.calls[1]![0]).toMatchObject({ outputHash: stableHash(returnedRepair!),
      proofVersion: 'direct-original-source-refinement-v1', turnId: 'synthetic-direct-turn-4' });
    const review = preview.mock.calls.flatMap(([input]) => input.sourceRefinementReview ? [input.sourceRefinementReview] : [])[0]!;
    expect(review).toBeDefined();
    expect(review.repairInputSignature).toBe(directOriginalSourceRefinementReviewSignature(review));
    expect(review.firstReading).toEqual(next);
    expect(review.refinementTargets).toEqual([{ candidateKey: 'c_a', comparisonRecordKey: returnedRepair!.sourceMappings![0]!.comparisonRecordKey,
      recordId: before.id, recordRevision: 1, recordHash: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    const saved = f.store.listAcceptedObservations(f.person.id).find((item) => item.id === before.id)!;
    for (const key of ['originalName', 'rawText', 'decimalValue', 'qualifier', 'unit', 'clinicalDate', 'clinicalContext'] as const) {
      expect(saved[key]).toEqual(before[key]);
    }
    expect(saved.evidence).toEqual(relation === 'same_original_field' ? expect.arrayContaining(before.evidence) : before.evidence);
    expect(preview.mock.results.at(-1)!.value.refinedCount).toBe(relation === 'same_original_field' ? 1 : 0);
    expect(f.store.getExtractionChunkCheckpoint(f.guard, f.documentId, canonicalCheckpointSignature(f))).toBeNull();
  });

  it('已提交unknown日期从真实direct metadata补证，预检和append一致且不借旧日期正则', async () => {
    const f = fixture(); const first = reading(f); const pending = candidate('c_pending', 'e_pending', '9');
    pending.originalName = '合成待补指标'; pending.value = { kind: 'numeric', rawText: '9', decimal: '8', comparator: 'eq' };
    first.sourceExcerpts.push({ localKey: 'e_pending', pageSourceSpanId: f.manifest.spans[0]!.id,
      quote: '合成指标 9 U/L', role: 'finding', clarity: 'clear' }); first.extraction.candidates.push(pending);
    const initialRuntime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(first)).mockImplementationOnce(async (input) =>
      receipt(targetRepair(f, first, input), 2)) };
    expect(await pipeline(f, initialRuntime).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: 1 });
    const originalValue = f.store.listAcceptedObservations(f.person.id)[0]!.rawText;
    const next = structuredClone(first); const quote = 'Exam performed: 02/03/2026';
    next.sourceExcerpts.push({ localKey: 'e_date', pageSourceSpanId: f.manifest.spans[0]!.id, quote, role: 'date', clarity: 'clear' });
    next.extraction.reportMetadata = { reportKind: null, title: null, organization: null, campus: null, department: null,
      reportNumber: null, examItems: [], times: [{ value: '2026-02-03', precision: 'day', role: 'examined', evidence: [{ sourceSpanId: 'e_date', quote }] }] };
    next.extraction.candidates[0]!.clinicalDate = '2026-02-03';
    next.extraction.candidates[0]!.sourceBinding!.findingEvidence = [...next.extraction.candidates[0]!.evidence];
    next.extraction.candidates[0]!.evidence.push({ sourceSpanId: 'e_date', quote });
    const preview = vi.spyOn(f.store, 'previewDirectOriginalAdmission');
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(next, 3)).mockImplementationOnce(async (input) =>
      receipt(targetRepair(f, next, input), 4)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: 0 });
    expect(preview.mock.results.every((result) => result.value.refinedCount === 1 && result.value.held.length === 0)).toBe(true);
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual([expect.objectContaining({ rawText: originalValue, clinicalDate: '2026-02-03' })]);
  });

  it.each(['numeric', 'date'] as const)('basic %s分别验收：数值错误不接纳，日期未知只隔离日期字段', async (problem) => {
    const f = fixture(); const output = reading(f); const c = output.extraction.candidates[0]!;
    if (problem === 'numeric') c.value = { kind: 'numeric', rawText: '7', decimal: '8', comparator: 'eq' };
    else c.clinicalDate = '2026-02-03';
    const preview = vi.spyOn(f.store, 'previewDirectOriginalAdmission');
    const acceptance = vi.spyOn(f.store, 'saveAcceptanceDecision');
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output)).mockImplementationOnce(async (input) => {
      expect(acceptance).not.toHaveBeenCalled();
      return receipt(targetRepair(f, output, input), 2);
    }) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: problem === 'numeric' ? 0 : 1 });
    expect(preview.mock.calls.every(([input]) => input.observations.length === (problem === 'numeric' ? 0 : 1))).toBe(true);
    if (problem === 'numeric') expect(acceptance).not.toHaveBeenCalled();
    else {
      expect(acceptance).toHaveBeenCalledTimes(1);
      expect(f.store.listAcceptedObservations(f.person.id)[0]).toMatchObject({ rawText: '7', clinicalDate: null });
      const db = (f.store as unknown as { db: Database.Database }).db;
      const payload = JSON.parse((db.prepare("SELECT payload_json FROM review_issues WHERE resolution_status='open'").get() as { payload_json: string }).payload_json);
      expect(payload.candidateOptions).toEqual([]);
      expect(payload.fieldReviews[0]).toMatchObject({ kind: 'candidate', original: { clinicalDate: '2026-02-03' },
        fields: [{ fieldPath: 'clinicalDate', reasonCodes: ['direct_original_clinical_date_unverified'] }] });
    }
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
  });

  it('Word使用不可变原件路径，预览PDF与原件分别验算并完整传入两页', async () => {
    const rootDirectory = mkdtempSync(join(tmpdir(), 'family-health-direct-word-synthetic-')); roots.push(rootDirectory);
    const store = new WorkspaceStore({ rootDirectory }); stores.add(store);
    const person = store.createPerson({ displayName: '合成成员' });
    const original = Buffer.alloc(512);
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(original);
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 120 160] /Contents 4 0 R >>', '<< /Length 0 >>\nstream\n\nendstream',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 120 160] /Contents 6 0 R >>', '<< /Length 0 >>\nstream\n\nendstream'];
    let pdfText = '%PDF-1.4\n'; const offsets: number[] = [];
    objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdfText)); pdfText += `${index + 1} 0 obj\n${object}\nendobj\n`; });
    const xref = Buffer.byteLength(pdfText);
    pdfText += `xref\n0 7\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    const pdf = Buffer.from(pdfText, 'latin1');
    const source = store.putSourceObject({ bytes: original, mediaType: 'application/msword', displayName: '合成原件.doc' });
    const view = store.putSourceObject({ bytes: pdf, mediaType: 'application/pdf', displayName: '合成完整转换.pdf' });
    const { documentId } = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const conversion = { bytes: pdf, sha256: view.sha256, mediaType: 'application/pdf' as const,
      converterId: 'libreoffice-headless' as const, converterVersion: 'synthetic-controlled-1', executableSha256: 'a'.repeat(64) };
    store.registerDocumentConversion({ documentId, convertedSourceObjectId: view.id,
      converterId: conversion.converterId, converterVersion: conversion.converterVersion,
      executableSha256: conversion.executableSha256, warnings: [] });
    const { manifest } = await prepareOriginalSource({ documentId, sourceObjectId: source.id,
      bytes: original, sha256: source.sha256, displayName: '合成原件.doc', createdAt: '2026-01-03T00:00:00Z', convertedPdf: conversion });
    store.saveSourceManifest(manifest);
    const accountFingerprint = 'synthetic-direct-word-account';
    const consentId = store.createManualProcessingConsent({ documentIds: [documentId], personIds: [person.id], accountFingerprint, version: 1 });
    store.createWaitingAuthBatch({ cutoff: '2026-01-03T00:00:00Z', initialStatus: 'queued', consentId,
      groups: [{ personId: person.id, documentIds: [documentId], inputSignature: 'synthetic-direct-word-job' }] });
    const job = store.claimNextQueuedJob('synthetic-direct-word-runner', accountFingerprint)!;
    const attemptId = store.startJobAttempt(job.id, 'synthetic-runtime', 'gpt-6.1-sol', 'medium');
    const guard = { jobId: job.id, attemptId, consentId, accountFingerprint };
    const bundle = store.getDocumentExtractionBundle(documentId); const rawSource = store.getDocumentOriginalSource(documentId);
    expect(readFileSync(bundle.sourcePath)).toEqual(pdf); expect(readFileSync(rawSource.sourcePath)).toEqual(original);
    expect(rawSource.sourcePath).not.toBe(bundle.sourcePath);
    const prepareOriginal = vi.fn(prepareDirectOriginalReport);
    const runtime = { runStructuredTurn: vi.fn(async () => receipt(reading({ documentId, manifest }))) };
    expect(await new DirectOriginalExtractionPipeline(store, runtime, guard, { prepareOriginal }).process(documentId))
      .toMatchObject({ status: 'published', candidateCount: 1 });
    expect(prepareOriginal.mock.calls[0]?.[0].bytes).toEqual(original);
    expect(prepareOriginal.mock.calls[0]?.[0].sha256).toBe(createHash('sha256').update(original).digest('hex'));
    expect(prepareOriginal.mock.calls[0]?.[0].convertedPdf?.sha256).toBe(createHash('sha256').update(pdf).digest('hex'));
    const modelInput = runtime.runStructuredTurn.mock.calls[0] as unknown as [{ prompt: string; imagePaths: string[] }];
    expect(modelInput[0].imagePaths).toHaveLength(2);
    expect(modelInput[0].prompt).toContain(`"originalSha256":"${source.sha256}"`);
    expect(modelInput[0].prompt).toContain(`"convertedViewSha256":"${view.sha256}"`);
    expect(store.getDocumentExtractionBundle(documentId).manifest.spans.find((span) => span.modelEvidence)?.modelEvidence)
      .toMatchObject({ originalSha256: source.sha256, originalSourceObjectId: source.id });
  });

  it('原件getter与当前报告来源hash不一致时发送前拒绝，不调用模型', async () => {
    const f = fixture(); const original = f.store.getDocumentOriginalSource(f.documentId);
    vi.spyOn(f.store, 'getDocumentOriginalSource').mockReturnValue({ ...original, sha256: '0'.repeat(64) });
    const runtime = { runStructuredTurn: vi.fn() };
    await expect(pipeline(f, runtime).process(f.documentId)).rejects.toThrow('DIRECT_ORIGINAL_SOURCE_IDENTITY_CHANGED');
    expect(f.prepareOriginal).not.toHaveBeenCalled(); expect(runtime.runStructuredTurn).not.toHaveBeenCalled();
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual([]);
  });

  it('十二页同一P01调用，无OCR quote，模型原文及真实调用provenance保存', async () => {
    const f = fixture(12);
    const output = reading(f);
    const runtime = { runStructuredTurn: vi.fn(async (_input: { prompt: string; imagePaths?: string[] }) => receipt(output)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 1 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(1);
    expect(runtime.runStructuredTurn.mock.calls[0]![0]).toMatchObject({ imagePaths: f.prepared.imagePaths, allowWebSearch: false });
    const saved = f.store.getDocumentExtractionBundle(f.documentId).manifest;
    expect(saved.spans.filter((span) => !span.modelEvidence).every((span) => span.quote === null && !span.visualEvidence)).toBe(true);
    expect(saved.spans.find((span) => span.modelEvidence)?.modelEvidence).toMatchObject({ engine: 'codex-original-reading-v1',
      modelId: 'gpt-6.1-sol', originalSha256: f.source.sha256, originalSourceObjectId: f.source.id,
      parentSourceSpanId: f.manifest.spans[11]!.id, threadId: 'synthetic-direct-thread-1', turnId: 'synthetic-direct-turn-1' });
    expect(f.cleanup).toHaveBeenCalledTimes(1);
  });

  it('单页两个结果的栏目或发现仅在binding明示仍直接接纳，正式来源完整且不要求P03重复填写', async () => {
    const f = fixture(); const output = readingWithBoundHeading(f);
    output.extraction.candidates[1]!.sourceBinding!.headingEvidence = [...output.extraction.candidates[0]!.sourceBinding!.headingEvidence];
    // 第一条的栏目、第二条的结果分别只在 binding 出现，不能为过门禁要求冗余附着。
    output.extraction.candidates[1]!.evidence = [...output.extraction.candidates[1]!.sourceBinding!.headingEvidence];
    const original = structuredClone(output);
    const publish = vi.spyOn(f.store, 'publishFacts');
    const runtime = { runStructuredTurn: vi.fn(async () => receipt(output)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 2 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(1);
    expect(f.store.listExtractionRepairDiagnostics({ documentId: f.documentId })).toEqual([]);
    const saved = f.store.listAcceptedObservations(f.person.id).sort((a, b) => Number(a.rawText) - Number(b.rawText));
    expect(saved).toHaveLength(2);
    for (const [index, fact] of saved.entries()) {
      expect(fact).toMatchObject({ originalName: index === 0 ? '合成甲指标' : '合成乙指标', rawText: index === 0 ? '7' : '11',
        decimalValue: index === 0 ? '7' : '11', qualifier: 'eq', unit: 'U/L', clinicalDate: null,
        clinicalContext: { version: 1, status: 'complete', conditions: [] } });
      expect(fact.evidence).toHaveLength(2); // 完全相同的finding引用不存两个副本。
      const heading = fact.evidence.find((ref) => ref.quote === '合成检查项目')!;
      expect(heading).toBeDefined();
      expect(f.store.getDocumentExtractionBundle(f.documentId).manifest.spans.find((span) => span.id === heading.sourceSpanId)?.modelEvidence)
        .toMatchObject({ role: 'heading', clarity: 'clear', originalSha256: f.source.sha256,
          originalSourceObjectId: f.source.id, threadId: 'synthetic-direct-thread-1', turnId: 'synthetic-direct-turn-1' });
    }
    for (const published of publish.mock.calls[0]![0].observations) {
      expect(published.candidate!.evidence).toHaveLength(1);
      expect(published.sourceBinding!.headingEvidence).toHaveLength(1);
      expect(published.evidence).toHaveLength(2);
    }
    expect(output).toEqual(original);
  });

  it.each(['changed_quote', 'foreign_reference', 'uncertain_excerpt'] as const)(
    '仅binding提供的栏目引用仍严格拒绝%s，不影响同页另一可靠结果', async (problem) => {
      const f = fixture(); const output = readingWithBoundHeading(f);
      const heading = output.extraction.candidates[0]!.sourceBinding!.headingEvidence[0]!;
      if (problem === 'changed_quote') heading.quote = '不存在的栏目引用';
      if (problem === 'foreign_reference') heading.sourceSpanId = 'foreign-document-model-excerpt';
      if (problem === 'uncertain_excerpt') output.sourceExcerpts.find((excerpt) => excerpt.localKey === 'e_heading')!.clarity = 'uncertain';
      const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output))
        .mockImplementationOnce(async (input) => {
          // 共用引用判定会点名坏标题引用本身；合成模型仍对全部真实授权目标保持不变。
          expect(repairRequest(input).targets).toContainEqual({ targetId: heading.sourceSpanId, nodeType: 'excerpt' });
          return receipt(targetRepair(f, output, input), 2);
        }) };
      expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: 1, requiresUser: false });
      expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
      expect(f.store.listAcceptedObservations(f.person.id).map((fact) => fact.rawText)).toEqual(['11']);
      const expectedReason = problem === 'changed_quote' ? 'direct_original_reference_changed'
        : problem === 'foreign_reference' ? 'direct_original_evidence_mismatch' : 'direct_original_evidence_uncertain';
      expect(f.store.listOpenExtractionReviewIssues().find((issue) => issue.documentId === f.documentId)?.reasonCodes).toContain(expectedReason);
      expect(f.store.listExtractionRepairDiagnostics({ documentId: f.documentId })[0]?.outcome).toBe('still_failed');
    });

  it('仅clinicalConditions引用的清晰解释条件进入正式来源并集，原候选与条件不改且无需P03', async () => {
    const f = fixture(); const output = reading(f); const quote = '检查条件：未散瞳';
    output.sourceExcerpts.push({ localKey: 'e_condition', pageSourceSpanId: f.manifest.spans[0]!.id,
      quote, role: 'context', clarity: 'clear' });
    output.extraction.candidates[0]!.clinicalContext = { version: 1, status: 'complete',
      conditions: [{ sourceSpanId: 'e_condition', quote }] };
    const original = structuredClone(output);
    const publish = vi.spyOn(f.store, 'publishFacts');
    const runtime = { runStructuredTurn: vi.fn(async () => receipt(output)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 1 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(1);
    const published = publish.mock.calls[0]![0].observations[0]!;
    const condition = published.clinicalContext!.conditions[0]!;
    expect(published.evidence).toContainEqual(condition); // 在storage防御补全前，pipeline自己的正式来源已完整。
    expect(published.evidence).toHaveLength(2);
    expect(published.candidate!.evidence).toHaveLength(1);
    expect(published.candidate!.clinicalContext!.conditions).toEqual([condition]);
    const saved = f.store.listAcceptedObservations(f.person.id)[0]!;
    expect(saved.evidence).toContainEqual(condition);
    expect(saved).toMatchObject({ rawText: '7', decimalValue: '7', qualifier: 'eq', unit: 'U/L', clinicalDate: null });
    expect(saved.clinicalContext).toEqual(published.clinicalContext);
    expect(f.store.getDocumentExtractionBundle(f.documentId).manifest.spans.find((span) => span.id === condition.sourceSpanId)?.modelEvidence)
      .toMatchObject({ role: 'context', clarity: 'clear', threadId: 'synthetic-direct-thread-1', turnId: 'synthetic-direct-turn-1' });
    expect(output).toEqual(original);
  });

  it.each(['valid', 'value-repair'] as const)('清晰监测区间日期与条件双用途保持原角色，%s不补项目日期或扩大修复权限', async (mode) => {
    const f = fixture(); const output = reading(f);
    const quote = '监测区间：2026-02-04至2026-02-11';
    const periodRef = { sourceSpanId: 'e_period', quote };
    output.sourceExcerpts.push({ localKey: periodRef.sourceSpanId,
      pageSourceSpanId: f.manifest.spans[0]!.id, quote, role: 'date', clarity: 'clear' });
    output.extraction.candidates[0]!.clinicalContext = {
      version: 1, status: 'complete', conditions: [periodRef]
    };
    output.extraction.reportMetadata = { reportKind: null, title: null, organization: null,
      campus: null, department: null, reportNumber: null, examItems: [], primaryClinicalTimeIndex: null,
      times: [
        { value: '2026-02-04', precision: 'day', role: 'examined', evidence: [periodRef] },
        { value: '2026-02-11', precision: 'day', role: 'examined', evidence: [periodRef] }
      ] };
    if (mode === 'value-repair') output.extraction.candidates[0]!.value = {
      kind: 'numeric', rawText: '7', decimal: '8', comparator: 'eq'
    };
    const original = structuredClone(output);
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output)) };
    if (mode === 'value-repair') runtime.runStructuredTurn.mockImplementationOnce(async (input) => {
      expect(repairRequest(input).targets).toEqual([{ targetId: 'c_a', nodeType: 'candidate' }]);
      return receipt(repair(f, output, [{ targetId: 'c_a', action: 'replace', replacement: {
        nodeType: 'candidate', value: { ...output.extraction.candidates[0]!,
          value: { kind: 'numeric', rawText: '7', decimal: '7', comparator: 'eq' } }
      } }]), 2);
    });
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 1 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(mode === 'value-repair' ? 2 : 1);
    const saved = f.store.listAcceptedObservations(f.person.id)[0]!;
    expect(saved).toMatchObject({ rawText: '7', decimalValue: '7', unit: 'U/L', clinicalDate: null });
    const condition = saved.clinicalContext!.conditions[0]!;
    expect(condition.quote).toBe(quote);
    expect(saved.evidence).toContainEqual(condition);
    expect(f.store.getDocumentExtractionBundle(f.documentId).manifest.spans.find((span) => span.id === condition.sourceSpanId)?.modelEvidence)
      .toMatchObject({ role: 'date', clarity: 'clear', threadId: 'synthetic-direct-thread-1' });
    expect(f.store.listReportMetadata(f.person.id)[0]).toMatchObject({ reportDate: null,
      extracted: { primaryClinicalTimeIndex: null, times: [
        expect.objectContaining({ value: '2026-02-04', role: 'examined', evidence: [condition] }),
        expect.objectContaining({ value: '2026-02-11', role: 'examined', evidence: [condition] })
      ] } });
    expect(f.store.listOpenExtractionReviewIssues()).toEqual([]);
    expect(output).toEqual(original);
  });

  it.each(['heading', 'date'] as const)('无sourceBinding且%s先于finding时，正式主来源仍定位真实结果', async (role) => {
    const f = fixture(); const output = reading(f);
    const quote = role === 'heading' ? '合成检查项目' : '检查日期：2026-01-02';
    output.sourceExcerpts.push({ localKey: 'e_prefix', pageSourceSpanId: f.manifest.spans[0]!.id,
      quote, role, clarity: 'clear' });
    const c = output.extraction.candidates[0]!;
    c.evidence = [{ sourceSpanId: 'e_prefix', quote }, ...c.evidence];
    delete c.sourceBinding;
    const original = structuredClone(output);
    const publish = vi.spyOn(f.store, 'publishFacts');
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output))
      .mockImplementationOnce(async input => receipt(targetRepair(f, output, input), 2)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: role === 'date' ? 'partial' : 'published', candidateCount: 1 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(role === 'date' ? 2 : 1);
    const published = publish.mock.calls[0]![0].observations[0]!;
    const saved = f.store.listAcceptedObservations(f.person.id)[0]!;
    expect(saved.sourceSpanId).toBe(published.sourceSpanId);
    expect(saved.sourceQuote).toBe('合成指标 7 U/L');
    expect(saved).toMatchObject({ rawText: '7', decimalValue: '7', qualifier: 'eq', unit: 'U/L', clinicalDate: null });
    expect(saved.evidence.map((ref) => ref.quote)).toEqual([quote, '合成指标 7 U/L']);
    expect(f.store.getDocumentExtractionBundle(f.documentId).manifest.spans.find((span) => span.id === saved.sourceSpanId)?.modelEvidence)
      .toMatchObject({ role: 'finding', clarity: 'clear' });
    expect(output).toEqual(original);
  });

  it('数值表示错误仅P03修目标，第二次仍传整份十二页，不重写非目标', async () => {
    const f = fixture(12);
    const output = reading(f);
    output.extraction.candidates[0]!.value = { kind: 'numeric', rawText: '7', decimal: '8', comparator: 'eq' };
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output))
      .mockResolvedValueOnce(receipt(repair(f, output, [{ targetId: 'c_a', action: 'replace', replacement: { nodeType: 'candidate', value: candidate() } }]), 2)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 1 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
    expect(runtime.runStructuredTurn.mock.calls[1]![0]).toMatchObject({ imagePaths: f.prepared.imagePaths, allowWebSearch: false });
    expect(f.store.listAcceptedObservations(f.person.id)[0]?.rawText).toBe('7');
    expect(f.store.listExtractionRepairDiagnostics({ documentId: f.documentId })[0]?.outcome).toBe('applied');
  });

  it('P03越权修改非目标被拒绝，原正确结果仍保存，不递归修复', async () => {
    const f = fixture();
    const output = reading(f);
    output.extraction.candidates[0]!.value = { kind: 'numeric', rawText: '7', decimal: '8', comparator: 'eq' };
    output.sourceExcerpts.push({ localKey: 'e_b', pageSourceSpanId: f.manifest.spans[0]!.id, quote: '合成指标 11 U/L', role: 'finding', clarity: 'clear' });
    output.extraction.candidates.push(candidate('c_b', 'e_b', '11'));
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output)).mockResolvedValueOnce(receipt(repair(f, output, [
      { targetId: 'c_a', action: 'unchanged', replacement: null },
      { targetId: 'c_b', action: 'replace', replacement: { nodeType: 'candidate', value: candidate('c_b', 'e_b', '99') } }
    ]), 2)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: 1 });
    expect(f.store.listAcceptedObservations(f.person.id).map((item) => item.rawText)).toEqual(['11']);
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
    expect(f.store.listExtractionRepairDiagnostics({ documentId: f.documentId })[0]?.outcome).toBe('scope_violation');
  });

  it('不清楚的模型excerpt定点重读后clear，receipt属于第二次真实调用', async () => {
    const f = fixture();
    const output = reading(f);
    output.sourceExcerpts[0]!.clarity = 'uncertain';
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output)).mockImplementationOnce(async (input) =>
      receipt(targetRepair(f, output, input, { e_a: { nodeType: 'excerpt',
        value: { ...output.sourceExcerpts[0]!, clarity: 'clear' } } }), 2)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 1 });
    expect(f.store.getDocumentExtractionBundle(f.documentId).manifest.spans.find((span) => span.modelEvidence)?.modelEvidence?.turnId)
      .toBe('synthetic-direct-turn-2');
  });

  it.each([false, true])('跨页混合来源给出字段诊断与必要原页权限；错误页=%s仍不能通过', async (wrongPage) => {
    const f = fixture(32); const output = reading(f);
    f.prepared.nativeText = '合成完整32页上下文，保留全部原页、否定和左右侧。';
    const shared = { localKey: 'e_shared', pageSourceSpanId: f.manifest.spans[0]!.id,
      quote: '合成栏目\n合成丙项 13 U/L', role: 'finding' as const, clarity: 'clear' as const };
    const makeCandidate = (key: string, source: string, name: string, value: string) => {
      const c = candidate(key, source, value); c.originalName = name;
      c.evidence[0]!.quote = `${name} ${value} U/L`;
      c.sourceBinding = { headingEvidence: [{ sourceSpanId: shared.localKey, quote: '合成栏目' }],
        findingEvidence: structuredClone(c.evidence) };
      return c;
    };
    const a = makeCandidate('c_a', 'e_a', '合成甲项', '7');
    const b = makeCandidate('c_b', 'e_b', '合成乙项', '11');
    const existing = makeCandidate('c_existing', shared.localKey, '合成丙项', '13');
    const outside = candidate('c_outside', 'e_outside', '17');
    output.sourceExcerpts = [shared,
      { localKey: 'e_a', pageSourceSpanId: f.manifest.spans[1]!.id, quote: a.evidence[0]!.quote!, role: 'finding', clarity: 'clear' },
      { localKey: 'e_b', pageSourceSpanId: f.manifest.spans[1]!.id, quote: b.evidence[0]!.quote!, role: 'finding', clarity: 'clear' },
      { localKey: 'e_outside', pageSourceSpanId: f.manifest.spans[31]!.id, quote: outside.evidence[0]!.quote!, role: 'finding', clarity: 'clear' }];
    output.extraction.candidates = [a, b, existing, outside];
    inventoryForSyntheticReading(output);
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output)).mockImplementationOnce(async (input) => {
      const request = repairRequest(input);
      for (const c of [a, b]) expect(request.validationDiagnostics).toContainEqual(expect.objectContaining({
        targetId: c.localKey, reasonCode: 'direct_original_evidence_role_mismatch',
        fieldPath: 'sourceBinding.headingEvidence[0]', sourceSpanId: shared.localKey, actualRole: 'finding' }));
      expect(request.validationDiagnostics.every((diagnostic) => !diagnostic.sourceSpanId
        || !diagnostic.sourceSpanId.startsWith('model-original-'))).toBe(true);
      expect(request.targets.filter((target) => target.nodeType === 'page')).toEqual([
        { targetId: f.manifest.spans[0]!.id, nodeType: 'page' }]);
      expect(request.targets).toContainEqual({ targetId: existing.localKey, nodeType: 'candidate' });
      expect(request.targets.some((target) => target.targetId === outside.localKey)).toBe(false);
      expect(input.imagePaths).toEqual(f.prepared.imagePaths); expect(input.imagePaths).toHaveLength(32);
      expect(input.prompt).toContain(JSON.stringify(f.prepared.nativeText));
      const newHeading = { localKey: 'e_independent_heading', pageSourceSpanId: f.manifest.spans[wrongPage ? 1 : 0]!.id,
        quote: '合成栏目', role: 'heading' as const, clarity: 'clear' as const };
      const fix = (c: ObservationCandidate) => ({ nodeType: 'candidate' as const, value: { ...c,
        sourceBinding: { ...c.sourceBinding!, headingEvidence: [{ sourceSpanId: newHeading.localKey, quote: null }] } } });
      return receipt(targetRepair(f, output, input, {
        c_a: fix(a), c_b: fix(b), [f.manifest.spans[0]!.id]: { nodeType: 'page',
          value: { sourceSpanId: f.manifest.spans[0]!.id, status: 'read', newExcerpts: [newHeading], newCandidates: [] } }
      }), 2);
    }) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: wrongPage ? 'partial' : 'published',
      candidateCount: wrongPage ? 2 : 4 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
    const facts = f.store.listAcceptedObservations(f.person.id);
    expect(facts.find((fact) => fact.originalName === existing.originalName)?.rawText).toBe('13');
    expect(facts.find((fact) => fact.originalName === outside.originalName)?.rawText).toBe('17');
    if (!wrongPage) {
      expect(facts.find((fact) => fact.originalName === a.originalName)?.rawText).toBe('7');
      expect(facts.find((fact) => fact.originalName === b.originalName)?.rawText).toBe('11');
      const sources = f.store.getDocumentExtractionBundle(f.documentId).manifest.spans;
      expect(sources.find((source) => source.quote === shared.quote)?.modelEvidence?.turnId).toBe('synthetic-direct-turn-1');
      expect(sources.find((source) => source.quote === '合成栏目')?.modelEvidence?.turnId).toBe('synthetic-direct-turn-2');
    }
  });

  it.each([false, true])('身份误用结果来源可由同一P03补独立身份引用；越页=%s仍拒绝', async (wrongPage) => {
    const f = fixture(2, 'folder_binding'); const output = reading(f); const pageId = f.manifest.spans[1]!.id;
    output.sourceExcerpts[0]!.quote = '患者姓名：合成成员\n合成指标 7 U/L';
    output.extraction.subject = { reportedName: f.person.displayName, confidence: 'explicit',
      evidence: [{ sourceSpanId: 'e_a', quote: '患者姓名：合成成员' }] };
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output)).mockImplementationOnce(async (input) => {
      const request = repairRequest(input);
      expect(request.validationDiagnostics).toContainEqual(expect.objectContaining({ targetId: 'subject',
        reasonCode: 'SUBJECT_SOURCE_ROLE_NOT_ALLOWED', fieldPath: 'evidence[0].sourceSpanId',
        sourceSpanId: 'e_a', actualRole: 'finding', allowedRoles: ['identity'] }));
      expect(request.targets).toContainEqual({ targetId: pageId, nodeType: 'page' });
      expect(request.targets.some((target) => target.targetId === f.manifest.spans[0]!.id)).toBe(false);
      const identity = { localKey: 'e_independent_identity', pageSourceSpanId: f.manifest.spans[wrongPage ? 0 : 1]!.id,
        quote: '患者姓名：合成成员', role: 'identity' as const, clarity: 'clear' as const };
      return receipt(targetRepair(f, output, input, {
        subject: { nodeType: 'subject', value: { ...output.extraction.subject,
          evidence: [{ sourceSpanId: identity.localKey, quote: null }] } },
        [pageId]: { nodeType: 'page', value: { sourceSpanId: pageId, status: 'read', newExcerpts: [identity], newCandidates: [] } }
      }), 2);
    }) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: wrongPage ? 'partial' : 'published', candidateCount: wrongPage ? 0 : 1 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(wrongPage ? 0 : 1);
    expect(f.store.listExtractionRepairDiagnostics({ documentId: f.documentId })[0]?.outcome).toBe(wrongPage ? 'scope_violation' : 'applied');
  });

  it.each([false, true])('目录自动归属的共享来源同时保留身份日期及结果职责；破坏身份=%s仍不能放行', async (breakIdentity) => {
    const f = fixture(2, 'folder_binding'); const output = reading(f); const pageId = f.manifest.spans[1]!.id;
    const shared = output.sourceExcerpts[0]!;
    shared.role = 'identity'; shared.quote = '患者姓名：合成成员\n检查日期：2026-01-02\n合成指标 7 U/L';
    output.extraction.subject = { reportedName: f.person.displayName, confidence: 'explicit',
      evidence: [{ sourceSpanId: shared.localKey, quote: '患者姓名：合成成员' }] };
    output.extraction.reportMetadata = { reportKind: null, title: null, organization: null, campus: null,
      department: null, reportNumber: null, examItems: [], times: [{ value: '2026-01-02', precision: 'day', role: 'examined',
        evidence: [{ sourceSpanId: shared.localKey, quote: '检查日期：2026-01-02' }] }] };
    const original = structuredClone(output);
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output)).mockImplementationOnce(async (input) => {
      const request = repairRequest(input);
      expect(request.validationDiagnostics).toContainEqual(expect.objectContaining({ targetId: 'subject', reasonCode: 'SUBJECT_REFERENCE_OBLIGATION',
        fieldPath: 'evidence[0].sourceSpanId', sourceSpanId: shared.localKey, allowedRoles: ['identity'] }));
      expect(request.validationDiagnostics).toContainEqual(expect.objectContaining({ targetId: 'metadata', reasonCode: 'DIRECT_ORIGINAL_REFERENCE_OBLIGATION',
        fieldPath: 'times[0].evidence[0]', sourceSpanId: shared.localKey, allowedRoles: ['date', 'finding', 'instruction'] }));
      expect(request.validationDiagnostics).toContainEqual(expect.objectContaining({ targetId: 'c_a', reasonCode: 'DIRECT_ORIGINAL_REFERENCE_OBLIGATION',
        fieldPath: 'sourceBinding.findingEvidence[0]', sourceSpanId: shared.localKey, allowedRoles: ['finding', 'instruction'] }));
      expect(request.targets).toContainEqual({ targetId: 'subject', nodeType: 'subject' });
      expect(request.targets).toContainEqual({ targetId: 'metadata', nodeType: 'metadata' });
      expect(request.targets.filter((target) => target.nodeType === 'page')).toEqual([{ targetId: pageId, nodeType: 'page' }]);
      const finding = { localKey: 'e_independent_finding', pageSourceSpanId: pageId, quote: '合成指标 7 U/L', role: 'finding' as const, clarity: 'clear' as const };
      const date = { localKey: 'e_independent_date', pageSourceSpanId: pageId, quote: '检查日期：2026-01-02', role: 'date' as const, clarity: 'clear' as const };
      return receipt(targetRepair(f, output, input, breakIdentity ? {
        [shared.localKey]: { nodeType: 'excerpt', value: { ...shared, role: 'finding' } }
      } : {
        c_a: { nodeType: 'candidate', value: candidate('c_a', finding.localKey) },
        metadata: { nodeType: 'metadata', value: { ...output.extraction.reportMetadata!, times: [
          { ...output.extraction.reportMetadata!.times[0]!, evidence: [{ sourceSpanId: date.localKey, quote: null }] }
        ] } },
        [pageId]: { nodeType: 'page', value: { sourceSpanId: pageId, status: 'read',
          resultInventory: [{ sourceSpanId: finding.localKey, candidateKeys: ['c_a'] }], newExcerpts: [finding, date], newCandidates: [] } }
      }), 2);
    }) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: breakIdentity ? 'partial' : 'published', candidateCount: breakIdentity ? 0 : 1 });
    expect(output).toEqual(original); expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
    const facts = f.store.listAcceptedObservations(f.person.id);
    expect(facts).toHaveLength(breakIdentity ? 0 : 1);
    if (!breakIdentity) {
      expect(facts[0]!).toMatchObject({ rawText: '7', decimalValue: '7', qualifier: 'eq', unit: 'U/L' });
      const sources = f.store.getDocumentExtractionBundle(f.documentId).manifest.spans;
      expect(sources.find((source) => source.modelEvidence?.role === 'identity')?.modelEvidence?.turnId).toBe('synthetic-direct-turn-1');
      expect(sources.find((source) => source.modelEvidence?.role === 'finding')?.modelEvidence?.turnId).toBe('synthetic-direct-turn-2');
    }
  });

  it('来源role错误允许定点修excerpt及其引用闭包，而非穷举栏目文字放行', async () => {
    const f = fixture();
    const output = reading(f); output.sourceExcerpts[0]!.role = 'heading';
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output)).mockImplementationOnce(async (input) =>
      receipt(targetRepair(f, output, input, { e_a: { nodeType: 'excerpt',
        value: { ...output.sourceExcerpts[0]!, role: 'finding' } } }), 2)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published' });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
  });

  it('临床条件的未知引用只能由原件P03补有收据的excerpt，不能悄悄进入结果', async () => {
    const f = fixture();
    const output = reading(f); const quote = '检查条件：未散瞳';
    output.extraction.candidates[0]!.clinicalContext = { version: 1, status: 'complete', conditions: [{ sourceSpanId: 'e_condition', quote }] };
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output)).mockResolvedValueOnce(receipt(repair(f, output, [
      { targetId: 'c_a', action: 'unchanged', replacement: null },
      { targetId: 'e_condition', action: 'replace', replacement: { nodeType: 'excerpt', value: { localKey: 'e_condition',
        pageSourceSpanId: f.manifest.spans[0]!.id, quote, role: 'context', clarity: 'clear' } } }
    ]), 2)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published' });
    const accepted = f.store.listAcceptedObservations(f.person.id)[0]!;
    expect(accepted.clinicalContext?.conditions[0]?.quote).toBe(quote);
    const sourceId = accepted.clinicalContext!.conditions[0]!.sourceSpanId;
    expect(f.store.getDocumentExtractionBundle(f.documentId).manifest.spans.find((span) => span.id === sourceId)?.modelEvidence?.turnId)
      .toBe('synthetic-direct-turn-2');
  });

  it('临床条件已存在却role错误时P03点名excerpt及引用闭包，不能只能删条件来过门禁', async () => {
    const f = fixture(); const output = reading(f); const quote = '检查条件：未散瞳';
    output.sourceExcerpts.push({ localKey: 'e_condition', pageSourceSpanId: f.manifest.spans[0]!.id,
      quote, role: 'identity', clarity: 'clear' });
    output.extraction.candidates[0]!.clinicalContext = { version: 1, status: 'complete', conditions: [{ sourceSpanId: 'e_condition', quote }] };
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output)).mockImplementationOnce(async (input) =>
      receipt(targetRepair(f, output, input, { e_condition: { nodeType: 'excerpt',
        value: { ...output.sourceExcerpts[1]!, role: 'context' } } }), 2)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 1 });
    expect(f.store.listAcceptedObservations(f.person.id)[0]?.clinicalContext?.conditions[0]?.quote).toBe(quote);
    expect(repairRequest(runtime.runStructuredTurn.mock.calls[1]![0]).targets).toContainEqual({ targetId: 'e_condition', nodeType: 'excerpt' });
  });

  it('异常结构字段由模型修成枚举，原箭头保留在来源，不由应用判升降或异常', async () => {
    const f = fixture();
    const output = reading(f); output.sourceExcerpts[0]!.quote += ' 提示↑';
    output.extraction.candidates[0]!.reportedAbnormalFlag = '↑';
    const fixed = { ...output.extraction.candidates[0]!, reportedAbnormalFlag: 'high' };
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output)).mockResolvedValueOnce(receipt(repair(f, output, [
      { targetId: 'c_a', action: 'replace', replacement: { nodeType: 'candidate', value: fixed } }
    ]), 2)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published' });
    expect(f.store.listAcceptedObservations(f.person.id)[0]?.abnormalFlag).toBe('high');
    expect(f.store.getDocumentExtractionBundle(f.documentId).manifest.spans.find((span) => span.modelEvidence)?.quote).toContain('↑');
  });

  it('跨页检查日期由模型明确关联，程序只检日期角色/引用一致，不补猜', async () => {
    const f = fixture(3);
    const output = reading(f);
    output.sourceExcerpts.push({ localKey: 'e_date', pageSourceSpanId: f.manifest.spans[0]!.id,
      quote: '检查日期：2026-01-02', role: 'date', clarity: 'clear' });
    output.extraction.reportMetadata = { reportKind: null, title: null, organization: null, campus: null, department: null, reportNumber: null,
      examItems: [], times: [{ role: 'examined', precision: 'day', value: '2026-01-02', evidence: [{ sourceSpanId: 'e_date', quote: '检查日期：2026-01-02' }] }] };
    output.extraction.candidates[0]!.clinicalDate = '2026-01-02';
    output.extraction.candidates[0]!.sourceBinding!.findingEvidence = [...output.extraction.candidates[0]!.evidence];
    output.extraction.candidates[0]!.evidence.push({ sourceSpanId: 'e_date', quote: '检查日期：2026-01-02' });
    const runtime = { runStructuredTurn: vi.fn(async () => receipt(output)) };
    const result = await pipeline(f, runtime).process(f.documentId);
    expect(result, JSON.stringify(f.store.listOpenExtractionReviewIssues().map((issue) => issue.reasonCodes))).toMatchObject({ status: 'published' });
    expect(f.store.listAcceptedObservations(f.person.id)[0]?.clinicalDate).toBe('2026-01-02');
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(1);
  });

  it('科学计数法与不等号不被改写成精确结果，复合单位不截断', async () => {
    const f = fixture();
    const output = reading(f);
    output.sourceExcerpts[0]!.quote = '合成指标 <2.50E＋02 cm/s';
    const c = output.extraction.candidates[0]!;
    c.value = { kind: 'numeric', rawText: '<2.50E＋02', decimal: '250', comparator: 'lt' }; c.unitRaw = 'cm/s';
    c.evidence[0]!.quote = output.sourceExcerpts[0]!.quote;
    const runtime = { runStructuredTurn: vi.fn(async () => receipt(output)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published' });
    expect(f.store.listAcceptedObservations(f.person.id)[0]).toMatchObject({ rawText: '<2.50E＋02', decimalValue: '250', qualifier: 'lt', unit: 'cm/s' });
  });

  it('数值原串含模型明确读取的完整单位时保留原串发布，不为纯数字格式额外P03', async () => {
    const f = fixture(); const output = reading(f); const c = output.extraction.candidates[0]!;
    output.sourceExcerpts[0]!.quote = '合成指标 8.75分';
    c.value = { kind: 'numeric', rawText: '8.75分', decimal: '8.75', comparator: 'eq' }; c.unitRaw = '分';
    c.evidence[0]!.quote = output.sourceExcerpts[0]!.quote;
    const runtime = { runStructuredTurn: vi.fn(async () => receipt(output)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 1 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(1);
    expect(f.store.listAcceptedObservations(f.person.id)[0]).toMatchObject({ rawText: '8.75分', decimalValue: '8.75', qualifier: 'eq', unit: '分' });
  });

  it('原医生安排原话作为报告事实保留，不代用户生成或采纳计划', async () => {
    const f = fixture();
    const output = reading(f);
    const quote = '原医生安排：两周后携完整报告复诊，如有不适提前就诊。';
    output.sourceExcerpts[0]!.quote = quote; output.sourceExcerpts[0]!.role = 'instruction';
    const c = output.extraction.candidates[0]!; c.originalName = '原医生安排'; c.value = { kind: 'text', rawText: quote }; c.unitRaw = null;
    c.evidence[0]!.quote = quote;
    const runtime = { runStructuredTurn: vi.fn(async () => receipt(output)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published' });
    expect(f.store.listAcceptedObservations(f.person.id)[0]?.rawText).toBe(quote);
  });

  it('原空白仅保留模型来源，不生成正常或unknown事实，不重复要求确认', async () => {
    const f = fixture();
    const output = reading(f);
    output.sourceExcerpts[0]!.quote = '合成指标：未填写';
    const c = output.extraction.candidates[0]!; c.value = { kind: 'unknown', rawText: null, reason: 'original_blank' };
    c.evidence[0]!.quote = output.sourceExcerpts[0]!.quote;
    const runtime = { runStructuredTurn: vi.fn(async () => receipt(output)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 0 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(1);
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual([]);
    expect(f.store.listOpenExtractionReviewIssues()).toEqual([]);
    expect(f.store.getDocumentExtractionBundle(f.documentId).manifest.spans.some((span) => span.modelEvidence)).toBe(true);
    expect(f.store.getLatestReportReadingAudit(f.documentId)?.audit.ledger?.candidates).toMatchObject([
      { localKey: 'c_a', disposition: 'original_no_result', value: { kind: 'unknown', rawText: null, reason: 'original_blank' },
        evidence: [{ quote: '合成指标：未填写' }] }
    ]);
  });

  it('模型显式绑定同名具体空白字段标签时只保留来源，不生成事实或额外P03', async () => {
    const f = fixture(); const output = reading(f); const label = '合成具体空白字段';
    output.sourceExcerpts[0] = { ...output.sourceExcerpts[0]!, quote: label, role: 'heading' };
    const c = output.extraction.candidates[0]!; c.originalName = label;
    c.value = { kind: 'unknown', rawText: null, reason: 'original_blank' };
    c.evidence = [{ sourceSpanId: 'e_a', quote: null }];
    c.sourceBinding = { headingEvidence: [], findingEvidence: [...c.evidence] };
    const runtime = { runStructuredTurn: vi.fn(async () => receipt(output)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 0 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(1);
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual([]);
    expect(f.store.listOpenExtractionReviewIssues()).toEqual([]);
    expect(f.store.getDocumentExtractionBundle(f.documentId).manifest.spans.some((span) => span.modelEvidence?.role === 'heading')).toBe(true);
  });

  it('具体空白字段在已读页，附带清晰封面日期不因no_medical_content误报或额外修复', async () => {
    const f = fixture(2); const output = reading(f); const label = '合成具体空白字段';
    output.pageReadings[0]!.status = 'no_medical_content';
    output.sourceExcerpts[0] = { ...output.sourceExcerpts[0]!, quote: label, role: 'heading' };
    const date = { sourceSpanId: 'e_date', quote: '合成检查日期：2026-02-03' };
    output.sourceExcerpts.push({ localKey: date.sourceSpanId, pageSourceSpanId: f.manifest.spans[0]!.id,
      quote: date.quote, role: 'date', clarity: 'clear' });
    const c = output.extraction.candidates[0]!; c.originalName = label;
    c.value = { kind: 'unknown', reason: 'original_blank', rawText: null };
    c.evidence = [{ sourceSpanId: 'e_a', quote: null }, date]; c.clinicalDate = '2026-02-03';
    c.sourceBinding = { headingEvidence: [], findingEvidence: [{ sourceSpanId: 'e_a', quote: null }] };
    output.extraction.reportMetadata = { reportKind: null, title: null, organization: null, campus: null,
      department: null, reportNumber: null, examItems: [], primaryClinicalTimeIndex: 0,
      times: [{ value: '2026-02-03', precision: 'day', role: 'examined', evidence: [date] }] };
    const runtime = { runStructuredTurn: vi.fn(async () => receipt(output)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 0 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(1);
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual([]);
    expect(f.store.listOpenExtractionReviewIssues()).toEqual([]);
  });

  it('空白标签表示不一致给出精确字段诊断，由模型一次修正绑定而不由程序剥标点', async () => {
    const f = fixture(); const output = reading(f); const label = '合成具体空白字段：';
    output.sourceExcerpts[0] = { ...output.sourceExcerpts[0]!, quote: label, role: 'heading' };
    const c = output.extraction.candidates[0]!; c.originalName = '合成具体空白字段';
    c.value = { kind: 'unknown', reason: 'original_blank', rawText: null };
    c.evidence = [{ sourceSpanId: 'e_a', quote: null }];
    c.sourceBinding = { headingEvidence: [], findingEvidence: structuredClone(c.evidence) };
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output)).mockImplementationOnce(async (input) => {
      expect(repairRequest(input).validationDiagnostics).toContainEqual(expect.objectContaining({
        targetId: c.localKey, fieldPath: 'originalName', sourceSpanId: 'e_a' }));
      expect(repairRequest(input).targets).toContainEqual({ targetId: f.manifest.spans[0]!.id, nodeType: 'page' });
      return receipt(targetRepair(f, output, input, { c_a: { nodeType: 'candidate', value: { ...c, originalName: label } } }), 2);
    }) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 0 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual([]);
    expect(f.store.listOpenExtractionReviewIssues()).toEqual([]);
  });

  it('原空白仅有泛用标题时仍请模型定点明确字段，不按名称相似或原空白reason直接跳过', async () => {
    const f = fixture(); const output = reading(f); output.sourceExcerpts[0]!.role = 'heading';
    output.extraction.candidates[0]!.value = { kind: 'unknown', rawText: null, reason: 'original_blank' };
    delete output.extraction.candidates[0]!.sourceBinding;
    const fixed = structuredClone(output.extraction.candidates[0]!); fixed.originalName = '合成具体空白字段';
    fixed.evidence = [{ sourceSpanId: 'e_a', quote: null }];
    fixed.sourceBinding = { headingEvidence: [], findingEvidence: [...fixed.evidence] };
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output))
      .mockResolvedValueOnce(receipt(repair(f, output, [
        { targetId: 'c_a', action: 'replace', replacement: { nodeType: 'candidate', value: fixed } }
      ]), 2)) };
    // 不能修改未授权的来源来拼出空白证明；当前泛用标题不等于所声称的具体字段。
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: 0 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual([]);
  });

  it('P03可从原件明确空白字段绑定，结束无谓确认而不生成正常结果', async () => {
    const f = fixture(); const output = reading(f); const label = '合成具体空白字段';
    output.sourceExcerpts[0] = { ...output.sourceExcerpts[0]!, quote: label, role: 'heading' };
    const original = output.extraction.candidates[0]!; original.originalName = `合成上级栏目—${label}`;
    original.value = { kind: 'unknown', rawText: null, reason: 'original_blank' };
    original.evidence = [{ sourceSpanId: 'e_a', quote: null }]; delete original.sourceBinding;
    const fixed = structuredClone(original); fixed.originalName = label;
    fixed.sourceBinding = { headingEvidence: [], findingEvidence: [...fixed.evidence] };
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output))
      .mockResolvedValueOnce(receipt(repair(f, output, [
        { targetId: 'c_a', action: 'replace', replacement: { nodeType: 'candidate', value: fixed } }
      ]), 2)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 0 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual([]);
    expect(f.store.listOpenExtractionReviewIssues()).toEqual([]);
  });

  it('漏读原页补出明确空白字段标签后可结束覆盖核对，不能只翻转已读状态', async () => {
    const f = fixture(); const output = reading(f);
    output.pageReadings[0]!.status = 'partial'; output.sourceExcerpts = []; output.extraction.candidates = [];
    const pageId = f.manifest.spans[0]!.id; const label = '合成具体空白字段';
    const empty = candidate('c_blank', 'e_blank'); empty.originalName = label;
    empty.value = { kind: 'unknown', rawText: null, reason: 'original_blank' }; empty.unitRaw = null;
    empty.evidence = [{ sourceSpanId: 'e_blank', quote: null }];
    empty.sourceBinding = { headingEvidence: [], findingEvidence: [...empty.evidence] };
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output))
      .mockImplementationOnce(async (input: { prompt: string }) => {
        const results: DirectOriginalReadingRepair['results'] = repairRequest(input).targets.map((target) => target.targetId === pageId
          ? { targetId: pageId, action: 'replace', replacement: { nodeType: 'page', value: {
            sourceSpanId: pageId, status: 'read', resultInventory: [{ sourceSpanId: 'e_blank', candidateKeys: ['c_blank'] }],
            newExcerpts: [{ localKey: 'e_blank', pageSourceSpanId: pageId,
              quote: label, role: 'heading', clarity: 'clear' }], newCandidates: [empty] } } }
          : { targetId: target.targetId, action: 'unchanged', replacement: null });
        return receipt(repair(f, output, results), 2);
      }) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 0 });
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual([]);
    expect(f.store.listOpenExtractionReviewIssues()).toEqual([]);
  });

  it('original_blank不能用clear日期或标题绕过结果出处要求', async () => {
    const f = fixture(); const output = reading(f); output.sourceExcerpts[0]!.role = 'date';
    output.extraction.candidates[0]!.value = { kind: 'unknown', rawText: null, reason: 'original_blank' };
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output))
      .mockResolvedValueOnce(receipt(repair(f, output, [
        { targetId: 'c_a', action: 'unchanged', replacement: null },
        { targetId: 'e_a', action: 'unchanged', replacement: null }
      ]), 2)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: 0 });
    expect(f.store.isDocumentCommitted(f.documentId)).toBe(false);
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual([]);
  });

  it('空白结果与页面回执矛盾时诊断接纳计数仍为零，不因负计数导致整份失败', async () => {
    const f = fixture(); const output = reading(f); output.pageReadings[0]!.status = 'no_medical_content';
    output.extraction.candidates[0]!.value = { kind: 'unknown', rawText: null, reason: 'original_blank' };
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output))
      .mockResolvedValueOnce(receipt(repair(f, output, [
        { targetId: 'c_a', action: 'unchanged', replacement: null },
        { targetId: f.manifest.spans[0]!.id, action: 'unchanged', replacement: null },
        { targetId: 'metadata', action: 'unchanged', replacement: null }
      ]), 2)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: 0 });
    expect(f.store.listExtractionRepairDiagnostics({ documentId: f.documentId })[0]?.diagnostic.acceptedCount).toBe(0);
  });

  it('初次漏读页不能仅P03翻转read就发布零事实完成', async () => {
    const f = fixture(); const output = reading(f);
    output.pageReadings[0]!.status = 'partial'; output.sourceExcerpts = []; output.extraction.candidates = [];
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output))
      .mockResolvedValueOnce(receipt(repair(f, output, [
        { targetId: f.manifest.spans[0]!.id, action: 'replace', replacement: {
          nodeType: 'page', value: { sourceSpanId: f.manifest.spans[0]!.id, status: 'read' } } },
        { targetId: 'metadata', action: 'unchanged', replacement: null }
      ]), 2)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: 0 });
    expect(f.store.isDocumentCommitted(f.documentId)).toBe(false);
    expect(f.store.listOpenExtractionReviewIssues()[0]?.reasonCodes).toContain('direct_original_page_recovery_missing_results');
    expect(f.store.listExtractionRepairDiagnostics({ documentId: f.documentId })[0]?.outcome).toBe('still_failed');
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
  });

  it('漏读原页允许P03补该页新结果和日期出处，原页结果不改且新来源用真实P03收据', async () => {
    const f = fixture(2); const output = reading(f);
    output.sourceExcerpts[0]!.pageSourceSpanId = f.manifest.spans[0]!.id;
    output.pageReadings = [output.pageReadings[0]!];
    inventoryForSyntheticReading(output);
    const pageId = f.manifest.spans[1]!.id;
    const newExcerpts = [{ localKey: 'e_b', pageSourceSpanId: pageId, quote: '合成指标 11 U/L', role: 'finding' as const, clarity: 'clear' as const },
      { localKey: 'e_date', pageSourceSpanId: pageId, quote: '检查日期：2026-01-02', role: 'date' as const, clarity: 'clear' as const }];
    const newCandidate = candidate('c_b', 'e_b', '11');
    newCandidate.clinicalDate = '2026-01-02'; newCandidate.sourceBinding!.findingEvidence = [...newCandidate.evidence];
    newCandidate.evidence.push({ sourceSpanId: 'e_date', quote: newExcerpts[1]!.quote });
    const metadata = { reportKind: null, title: null, organization: null, campus: null, department: null, reportNumber: null,
      examItems: [], times: [{ role: 'examined' as const, precision: 'day' as const, value: '2026-01-02',
        evidence: [{ sourceSpanId: 'e_date', quote: newExcerpts[1]!.quote }] }] };
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output))
      .mockResolvedValueOnce(receipt(repair(f, output, [
        { targetId: pageId, action: 'replace', replacement: { nodeType: 'page', value: {
          sourceSpanId: pageId, status: 'read', resultInventory: [{ sourceSpanId: 'e_b', candidateKeys: ['c_b'] }],
          newExcerpts, newCandidates: [newCandidate] } } },
        { targetId: 'metadata', action: 'replace', replacement: { nodeType: 'metadata', value: metadata } }
      ]), 2)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 2 });
    const saved = f.store.getDocumentExtractionBundle(f.documentId).manifest;
    expect(saved.spans.find((span) => span.quote === '合成指标 7 U/L')?.modelEvidence?.turnId).toBe('synthetic-direct-turn-1');
    expect(saved.spans.find((span) => span.quote === '合成指标 11 U/L')?.modelEvidence?.turnId).toBe('synthetic-direct-turn-2');
    expect(f.store.listAcceptedObservations(f.person.id).map((item) => [item.rawText, item.clinicalDate]).sort()).toEqual([['11', '2026-01-02'], ['7', null]]);
  });

  it.each(['unreadable', 'no_medical_content'] as const)('%s页与clear临床结果矛盾，唯一P03仍未纠正不得接纳', async (status) => {
    const f = fixture(); const output = reading(f); output.pageReadings[0]!.status = status;
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output))
      .mockResolvedValueOnce(receipt(repair(f, output, [
        { targetId: 'c_a', action: 'unchanged', replacement: null },
        { targetId: f.manifest.spans[0]!.id, action: 'unchanged', replacement: null },
        { targetId: 'metadata', action: 'unchanged', replacement: null }
      ]), 2)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: 0 });
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual([]);
    expect(f.store.listOpenExtractionReviewIssues()[0]?.reasonCodes).toContain('direct_original_page_content_status_conflict');
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
  });

  it('页面回执矛盾由模型定点纠正read，已读清的原候选可以接纳', async () => {
    const f = fixture(); const output = reading(f); output.pageReadings[0]!.status = 'unreadable';
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output))
      .mockResolvedValueOnce(receipt(repair(f, output, [
        { targetId: 'c_a', action: 'unchanged', replacement: null },
        { targetId: f.manifest.spans[0]!.id, action: 'replace', replacement: { nodeType: 'page', value: {
          sourceSpanId: f.manifest.spans[0]!.id, status: 'read' } } },
        { targetId: 'metadata', action: 'unchanged', replacement: null }
      ]), 2)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 1 });
  });

  it('partial页个别可靠结果可保存，未读部分仍保留缺口而非整份阻断', async () => {
    const f = fixture(); const output = reading(f); output.pageReadings[0]!.status = 'partial';
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output))
      .mockResolvedValueOnce(receipt(repair(f, output, [
        { targetId: f.manifest.spans[0]!.id, action: 'unchanged', replacement: null },
        { targetId: 'metadata', action: 'unchanged', replacement: null }
      ]), 2)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: 1 });
    expect(f.store.listAcceptedObservations(f.person.id)[0]?.rawText).toBe('7');
  });

  it('明确全份no_medical_content不生成事实且无需循环确认', async () => {
    const f = fixture(); const output = reading(f);
    output.pageReadings[0]!.status = 'no_medical_content'; output.sourceExcerpts = []; output.extraction.candidates = [];
    output.pageReadings[0]!.resultInventory = [];
    const runtime = { runStructuredTurn: vi.fn(async () => receipt(output)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 0 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(1); expect(f.store.listOpenExtractionReviewIssues()).toEqual([]);
  });

  it('read空候选不以every空数组发布成功，可在唯一P03补原页真实结果', async () => {
    const f = fixture(); const output = reading(f); output.sourceExcerpts = []; output.extraction.candidates = [];
    const restored = reading(f);
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output))
      .mockResolvedValueOnce(receipt(repair(f, output, [
        { targetId: f.manifest.spans[0]!.id, action: 'replace', replacement: { nodeType: 'page', value: {
          sourceSpanId: f.manifest.spans[0]!.id, status: 'read', newExcerpts: restored.sourceExcerpts, newCandidates: restored.extraction.candidates } } },
        { targetId: 'metadata', action: 'unchanged', replacement: null }
      ]), 2)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 1 });
    expect(f.store.listAcceptedObservations(f.person.id)[0]?.rawText).toBe('7');
  });

  it('已接纳报告的续读结构失败只更新既有缺口，旧事实和已完成状态不降级', async () => {
    const f = fixture(); const output = reading(f);
    output.extraction.candidates[0]!.value = { kind: 'numeric', rawText: '7', decimal: '8', comparator: 'eq' };
    output.sourceExcerpts.push({ localKey: 'e_b', pageSourceSpanId: f.manifest.spans[0]!.id, quote: '合成指标 11 U/L', role: 'finding', clarity: 'clear' });
    output.extraction.candidates.push(candidate('c_b', 'e_b', '11'));
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output))
      .mockResolvedValueOnce(receipt(repair(f, output, [{ targetId: 'c_a', action: 'unchanged', replacement: null }]), 2))
      .mockResolvedValueOnce(receipt({ invalid: true }, 3)).mockResolvedValueOnce(receipt({ invalid: true }, 4)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: 1 });
    const before = f.store.listAcceptedObservations(f.person.id); const issue = f.store.listOpenExtractionReviewIssues()[0]!;
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: 0, issueId: issue.id });
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual(before);
    expect(f.store.isDocumentCommitted(f.documentId)).toBe(true);
    expect(f.store.listOpenExtractionReviewIssues()).toHaveLength(1);
    expect(f.store.listOpenExtractionReviewIssues()[0]?.severity).toBe('warning');
    expect(f.store.listOpenExtractionReviewIssues()[0]?.reasonCodes).toEqual(expect.arrayContaining([
      ...issue.reasonCodes, 'DIRECT_ORIGINAL_STRUCTURE_INVALID', 'DIRECT_ORIGINAL_STRUCTURE_ENVELOPE_INVALID'
    ]));
  });

  it('模型不能自填provenance收据，结构非法不回退旧OCR流程', async () => {
    const f = fixture();
    const output = reading(f);
    const wire = encodeDirectOriginalReading(output);
    const excerpts = wire.payload[DIRECT_ORIGINAL_WIRE_KEY_MAP.sourceExcerpts] as Record<string, unknown>[];
    excerpts[0]!.modelEvidence = { originalSha256: f.source.sha256 };
    const runtime = { runStructuredTurn: vi.fn(async () => rawReceipt(wire)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', reason: 'DIRECT_ORIGINAL_STRUCTURE_INVALID' });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual([]);
    expect(f.store.getDocumentExtractionBundle(f.documentId).manifest.spans.every((span) => !span.modelEvidence)).toBe(true);
  });

  it.each(['masked', 'different', 'uncertain', 'absent', 'invalid-source'] as const)(
    '用户明确选择成员后%s身份仅留说明，不重读、不改原姓名或阻止可靠结果', async (mode) => {
      const f = fixture(); const output = reading(f);
      if (mode === 'uncertain') output.extraction.subject = { reportedName: null, confidence: 'uncertain', evidence: [] };
      if (mode === 'masked' || mode === 'different' || mode === 'invalid-source') {
        const reportedName = mode === 'masked' ? '*成员' : '另一合成成员';
        output.sourceExcerpts.push({ localKey: 'e_identity', pageSourceSpanId: f.manifest.spans[0]!.id,
          quote: `患者姓名：${reportedName}`, role: mode === 'invalid-source' ? 'context' : 'identity', clarity: 'clear' });
        output.extraction.subject = { reportedName, confidence: 'explicit', evidence: [{ sourceSpanId: 'e_identity', quote: null }] };
      }
      const original = structuredClone(output);
      const notice = vi.spyOn(f.store, 'recordUserAssignedSubjectNotice');
      const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output)) };
      expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 1 });
      expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(1);
      expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(1);
      expect(f.store.listOpenExtractionReviewIssues()).toEqual([]);
      expect(f.store.getDocumentExtractionBundle(f.documentId).confirmedReportedName).toBeNull();
      expect(f.store.getDocumentExtractionBundle(f.documentId).confirmedPersonAliases).toEqual([]);
      expect(notice).toHaveBeenCalledWith({ documentId: f.documentId, jobId: f.job.id,
        reason: mode === 'masked' || mode === 'different' ? 'name_mismatch' : 'subject_unproven' });
      expect(output).toEqual(original);
    });

  it('已由用户确认归属的报告继续使用该成员，不要求原件姓名再次匹配', async () => {
    const f = fixture(); const output = reading(f);
    output.extraction.subject = { reportedName: null, confidence: 'uncertain', evidence: [] };
    const getBundle = f.store.getDocumentExtractionBundle.bind(f.store);
    vi.spyOn(f.store, 'getDocumentExtractionBundle').mockImplementation((documentId) => ({
      ...getBundle(documentId), personAssignmentBasis: 'identity_confirmed'
    }));
    // 只模拟已持久化的确认归属，审计存储的真实范围验证另有独立合成测试。
    const notice = vi.spyOn(f.store, 'recordUserAssignedSubjectNotice').mockImplementation(() => undefined);
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 1 });
    expect(notice).toHaveBeenCalledWith({ documentId: f.documentId, jobId: f.job.id, reason: 'subject_unproven' });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(1);
  });

  it('用户明确归属不放行数值错误，也不为身份差异增加主体修复目标', async () => {
    const f = fixture(); const output = reading(f);
    output.extraction.subject = { reportedName: null, confidence: 'uncertain', evidence: [] };
    output.extraction.candidates[0]!.value = { kind: 'numeric', rawText: '7', decimal: '8', comparator: 'eq' };
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output)).mockImplementationOnce(async (input) => {
      const request = repairRequest(input);
      expect(request.targets.some((target) => target.nodeType === 'subject')).toBe(false);
      expect(request.validationDiagnostics.some((item) => item.targetId === 'subject')).toBe(false);
      return receipt(targetRepair(f, output, input), 2);
    }) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: 0 });
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual([]);
    expect(f.store.listOpenExtractionReviewIssues()[0]?.reasonCodes).not.toContain('person_conflict');
  });

  it('用户明确归属不把实际未读清的医疗页面改成已读，清晰结果仍局部接纳', async () => {
    const f = fixture(); const output = reading(f); output.pageReadings[0]!.status = 'partial';
    output.extraction.subject = { reportedName: null, confidence: 'uncertain', evidence: [] };
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output)).mockImplementationOnce(async (input) => {
      expect(repairRequest(input).targets.some((target) => target.nodeType === 'subject')).toBe(false);
      return receipt(targetRepair(f, output, input), 2);
    }) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: 1 });
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(1);
    expect(f.store.listOpenExtractionReviewIssues()[0]?.reasonCodes).toContain('direct_original_page_not_fully_read');
    expect(output.pageReadings[0]!.status).toBe('partial');
  });

  it('目录自动归属的真实患者异名在唯一重读后隔离该资料', async () => {
    const f = fixture(1, 'folder_binding');
    const output = reading(f);
    output.sourceExcerpts.push({ localKey: 'e_identity', pageSourceSpanId: f.manifest.spans[0]!.id,
      quote: '患者姓名：另一合成成员', role: 'identity', clarity: 'clear' });
    output.extraction.subject = { reportedName: '另一合成成员', confidence: 'explicit', evidence: [{ sourceSpanId: 'e_identity', quote: '患者姓名：另一合成成员' }] };
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output))
      .mockResolvedValueOnce(receipt(repair(f, output, [
        { targetId: 'c_a', action: 'unchanged', replacement: null }, { targetId: 'subject', action: 'unchanged', replacement: null }
      ]), 2)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', requiresUser: false, reason: 'PERSON_IDENTITY_NOT_CONFIRMED' });
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual([]);
    expect(f.store.listOpenExtractionReviewIssues()[0]?.kind).toBe('person_conflict');
  });

  it('同一摘录中包含审核医生也不能掩盖明确患者异名', async () => {
    const f = fixture(1, 'folder_binding');
    const output = reading(f);
    const quote = '姓名：另一合成成员 审核医生：合成审核人';
    output.sourceExcerpts.push({ localKey: 'e_identity', pageSourceSpanId: f.manifest.spans[0]!.id,
      quote, role: 'identity', clarity: 'clear' });
    output.extraction.subject = { reportedName: '另一合成成员', confidence: 'explicit', evidence: [{ sourceSpanId: 'e_identity', quote }] };
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output))
      .mockResolvedValueOnce(receipt(repair(f, output, [
        { targetId: 'c_a', action: 'unchanged', replacement: null }, { targetId: 'subject', action: 'unchanged', replacement: null }
      ]), 2)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', requiresUser: false });
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual([]);
  });

  it('目录自动归属的uncertain身份不能靠显示名自动变成已确认', async () => {
    const f = fixture(1, 'folder_binding');
    const output = reading(f);
    output.extraction.subject = { reportedName: null, confidence: 'uncertain', evidence: [] };
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output))
      .mockResolvedValueOnce(receipt(repair(f, output, [
        { targetId: 'c_a', action: 'unchanged', replacement: null }, { targetId: 'subject', action: 'unchanged', replacement: null }
      ]), 2)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', reason: 'DIRECT_ORIGINAL_IDENTITY_UNPROVEN', requiresUser: false });
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual([]);
  });

  it('工作人员不是受检者由同原件P03纠正subject，程序不靠角色关键词猜患者', async () => {
    const f = fixture(1, 'folder_binding');
    const output = reading(f);
    const quote = '审核医生：合成审核人';
    output.sourceExcerpts.push({ localKey: 'e_staff', pageSourceSpanId: f.manifest.spans[0]!.id, quote, role: 'context', clarity: 'clear' });
    output.extraction.subject = { reportedName: '合成审核人', confidence: 'explicit', evidence: [{ sourceSpanId: 'e_staff', quote }] };
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output)).mockImplementationOnce(async (input) =>
      receipt(targetRepair(f, output, input, {
        subject: { nodeType: 'subject', value: { reportedName: null, confidence: 'absent', evidence: [] } }
      }), 2)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 1 });
    expect(f.store.listOpenExtractionReviewIssues()).toEqual([]);
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
  });

  it.each(['date', 'finding', 'instruction'] as const)('报告时间复用清晰%s原文直接发布，保留报告时间性质而不推成检查日期', async (role) => {
    const f = fixture(); const output = reading(f);
    const quote = '合成报告时间：2026-01-04';
    output.sourceExcerpts[0]!.quote = `${output.sourceExcerpts[0]!.quote}\n${quote}`;
    output.sourceExcerpts.push({ localKey: 'e_report_time', pageSourceSpanId: f.manifest.spans[0]!.id,
      quote, role, clarity: 'clear' });
    output.extraction.reportMetadata = { reportKind: null, title: null, organization: null, campus: null,
      department: null, reportNumber: null, examItems: [], primaryClinicalTimeIndex: null,
      times: [{ role: 'report_issued', precision: 'day', value: '2026-01-04',
        evidence: [{ sourceSpanId: 'e_report_time', quote: null }] }] };
    const publish = vi.spyOn(f.store, 'publishFacts');
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({
      status: 'published', candidateCount: 1 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(1);
    expect(f.store.listAcceptedObservations(f.person.id)[0]?.clinicalDate).toBeNull();
    const metadata = publish.mock.calls[0]![0].reportMetadata;
    expect(metadata).toMatchObject({ primaryClinicalTimeIndex: null,
      times: [{ role: 'report_issued', value: '2026-01-04' }] });
    expect(f.store.listOpenExtractionReviewIssues()).toEqual([]);
  });

  it('签发日期不支持clinicalDate：一次日期补核后仍不能证明时保留正确结果和字段审计', async () => {
    const f = fixture();
    const output = reading(f);
    const quote = '签发日期：2026-01-02';
    output.sourceExcerpts.push({ localKey: 'e_date', pageSourceSpanId: f.manifest.spans[0]!.id, quote, role: 'date', clarity: 'clear' });
    output.extraction.reportMetadata = { reportKind: null, title: null, organization: null, campus: null, department: null, reportNumber: null,
      examItems: [], times: [{ role: 'report_issued', precision: 'day', value: '2026-01-02', evidence: [{ sourceSpanId: 'e_date', quote }] }] };
    const c = output.extraction.candidates[0]!;
    c.clinicalDate = '2026-01-02'; c.sourceBinding!.findingEvidence = [...c.evidence]; c.evidence.push({ sourceSpanId: 'e_date', quote });
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output))
      .mockImplementationOnce(async input => receipt(targetRepair(f, output, input), 2)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: 1, requiresUser: false });
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual([expect.objectContaining({ clinicalDate: null, rawText: '7' })]);
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
    expect(f.store.listOpenExtractionReviewIssues()[0]?.reasonCodes).toContain('direct_original_clinical_date_unverified');
  });

  it('P03繁忙后保留完整P01断点，续跑只修目标而不再次提取', async () => {
    const f = fixture(4);
    const output = reading(f);
    output.extraction.candidates[0]!.value = { kind: 'numeric', rawText: '7', decimal: '8', comparator: 'eq' };
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output)).mockRejectedValueOnce(new Error('CODEX_MODEL_BUSY'))
      .mockResolvedValueOnce(receipt(repair(f, output, [{ targetId: 'c_a', action: 'replace', replacement: { nodeType: 'candidate', value: candidate() } }]), 2)) };
    await expect(pipeline(f, runtime).process(f.documentId)).rejects.toThrow('CODEX_MODEL_BUSY');
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published' });
    expect(runtime.runStructuredTurn.mock.calls.filter(([input]) => input.prompt.startsWith('# DIRECT_ORIGINAL_P01'))).toHaveLength(1);
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(3);
    expect(f.cleanup).toHaveBeenCalledTimes(2);
  });

  it.each(['CODEX_CONNECTION_FAILED', 'CODEX_TURN_TIMEOUT'])('P03%s不消耗内容修复机会，续跑仍只补核同一目标', async (code) => {
    const f = fixture(); const output = reading(f);
    output.extraction.candidates[0]!.value = { kind: 'numeric', rawText: '7', decimal: '8', comparator: 'eq' };
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output)).mockRejectedValueOnce(new Error(code))
      .mockResolvedValueOnce(receipt(repair(f, output, [{ targetId: 'c_a', action: 'replace',
        replacement: { nodeType: 'candidate', value: candidate() } }]), 2)) };
    await expect(pipeline(f, runtime).process(f.documentId)).rejects.toThrow(code);
    const cache = f.store.getExtractionChunkCheckpoint(f.guard, f.documentId, canonicalCheckpointSignature(f))!;
    expect(cache.output).toMatchObject({ repairAttempted: false,
      repairRecovery: { phase: 'transport_unknown', transportAttempts: 1 } });
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 1 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(3);
    expect(runtime.runStructuredTurn.mock.calls[1]![0].prompt).toBe(runtime.runStructuredTurn.mock.calls[2]![0].prompt);
  });

  it('P03传输预算持久有限，重复续跑不能无限重发，也不会重提P01', async () => {
    const f = fixture(); const output = reading(f);
    output.extraction.candidates[0]!.value = { kind: 'numeric', rawText: '7', decimal: '8', comparator: 'eq' };
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output))
      .mockRejectedValue(new Error('CODEX_CONNECTION_FAILED')) };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(pipeline(f, runtime).process(f.documentId)).rejects.toThrow('CODEX_CONNECTION_FAILED');
    }
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: 0 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(4);
    expect(f.store.listExtractionRepairDiagnostics({ documentId: f.documentId })[0]?.outcome).toBe('transport_exhausted');
    expect(f.store.getExtractionChunkCheckpoint(f.guard, f.documentId, canonicalCheckpointSignature(f))!.output)
      .toMatchObject({ repairAttempted: true, repairRecovery: { phase: 'exhausted', transportAttempts: 3 } });
  });

  it('连接失败期间比较校验范围变化可重新规划，但沿用同一原件并保留总传输预算与scope历史', async () => {
    const f = fixture(); const output = reading(f);
    const checkpoints = vi.spyOn(f.store, 'saveExtractionChunkCheckpoint');
    output.extraction.candidates[0]!.value = { kind: 'numeric', rawText: '7', decimal: '8', comparator: 'eq' };
    let comparisonScopeChanged = false;
    const realPreview = f.store.previewDirectOriginalAdmission.bind(f.store);
    vi.spyOn(f.store, 'previewDirectOriginalAdmission').mockImplementation((input) => {
      const preview = realPreview(input);
      // 模拟同成员另一份报告提交后，新一轮本地对账增加来源诊断；不改读取结果或已接纳数据。
      if (comparisonScopeChanged) preview.reportReasonCodes.push('direct_original_binding_comparison_scope_changed');
      return preview;
    });
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output)).mockImplementationOnce(async () => {
      comparisonScopeChanged = true; throw new Error('CODEX_CONNECTION_FAILED');
    }).mockImplementationOnce(async (input) => receipt(targetRepair(f, output, input,
      { c_a: { nodeType: 'candidate', value: candidate() } }), 2)) };
    await expect(pipeline(f, runtime).process(f.documentId)).rejects.toThrow('CODEX_CONNECTION_FAILED');
    const first = f.store.getExtractionChunkCheckpoint(f.guard, f.documentId, canonicalCheckpointSignature(f))!.output as {
      repairRecovery: { requestSignature: string } };
    await pipeline(f, runtime).process(f.documentId);
    const resumed = checkpoints.mock.calls.at(-1)![0].output as {
      repairRecovery: { requestSignature: string; transportAttempts: number; scopeHistory: string[] } };
    expect(resumed.repairRecovery).toMatchObject({ transportAttempts: 2, scopeHistory: [first.repairRecovery.requestSignature] });
    expect(resumed.repairRecovery.requestSignature).not.toBe(first.repairRecovery.requestSignature);
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(3);
    expect(runtime.runStructuredTurn.mock.calls.slice(1).every(([input]) => input.imagePaths === f.prepared.imagePaths)).toBe(true);
  });

  it('P03回包先持久化，合并前中断后重用同一回包，不再次发送原件', async () => {
    const f = fixture(); const output = reading(f);
    output.extraction.candidates[0]!.value = { kind: 'numeric', rawText: '7', decimal: '8', comparator: 'eq' };
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output))
      .mockResolvedValueOnce(receipt(repair(f, output, [{ targetId: 'c_a', action: 'replace',
        replacement: { nodeType: 'candidate', value: candidate() } }]), 2)) };
    const originalSave = f.store.saveExtractionChunkCheckpoint.bind(f.store);
    let interrupted = false;
    vi.spyOn(f.store, 'saveExtractionChunkCheckpoint').mockImplementation((input) => {
      const result = originalSave(input);
      if (!interrupted && (input.output as { repairRecovery?: { phase: string } }).repairRecovery?.phase === 'response_saved') {
        interrupted = true; throw new Error('SYNTHETIC_AFTER_RESPONSE_SAVED');
      }
      return result;
    });
    await expect(pipeline(f, runtime).process(f.documentId)).rejects.toThrow('SYNTHETIC_AFTER_RESPONSE_SAVED');
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 1 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
  });

  it.each(['resolve', 'reject'] as const)('真实P03等待时关闭工作区，迟到%s不触碰已关闭存储也不消耗新模型请求', async (completion) => {
    const rootDirectory = mkdtempSync(join(tmpdir(), 'family-health-direct-close-synthetic-'));
    const service = new PersonalWorkspaceService(rootDirectory, '合成工作区关闭');
    await service.automaticUploadRecovery;
    const f = fixture(1, 'user_selected', service.store); const output = reading(f);
    output.extraction.candidates[0]!.value = { kind: 'numeric', rawText: '7', decimal: '8', comparator: 'eq' };
    let started!: () => void;
    const reachedP03 = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output))
      .mockImplementationOnce(async (input) => new Promise((resolve, reject) => {
        release = () => completion === 'resolve' ? resolve(receipt(targetRepair(f, output, input,
          { c_a: { nodeType: 'candidate', value: candidate() } }), 2)) : reject(new Error('CODEX_CONNECTION_FAILED'));
        started();
      })) };
    const protectedCalls = [vi.spyOn(f.store, 'assertJobExecutionActive'),
      vi.spyOn(f.store, 'finishAiTransmission'), vi.spyOn(f.store, 'finishDirectOriginalTransmission'),
      vi.spyOn(f.store, 'saveExtractionChunkCheckpoint'), vi.spyOn(f.store, 'saveDirectOriginalEvidenceForProcessing'),
      vi.spyOn(f.store, 'saveAcceptanceDecision'), vi.spyOn(f.store, 'saveExtractionRepairDiagnostic'),
      vi.spyOn(f.store, 'publishFacts'), vi.spyOn(f.store, 'appendCommittedFacts'), vi.spyOn(f.store, 'saveExtractionReviewIssue')];
    const pending = pipeline(f, runtime).process(f.documentId);
    await reachedP03;
    expect(f.store.getExtractionChunkCheckpoint(f.guard, f.documentId, canonicalCheckpointSignature(f))!.output)
      .toMatchObject({ repairAttempted: false, repairRecovery: { phase: 'in_flight', transportAttempts: 1 } });
    service.close(); stores.delete(f.store);
    for (const spy of protectedCalls) spy.mockClear();
    release();
    await expect(pending).rejects.toThrow(completion === 'resolve' ? 'WORKSPACE_CLOSED' : 'CODEX_CONNECTION_FAILED');
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
    for (const spy of protectedCalls) expect(spy).not.toHaveBeenCalled();
    expect(f.cleanup).toHaveBeenCalledTimes(1);
    const db = new Database(f.store.databasePath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare('SELECT checkpoint_json FROM jobs WHERE id=?').get(f.job.id) as { checkpoint_json: string };
      const checkpoint = JSON.parse(row.checkpoint_json);
      expect(checkpoint.extractionChunks[f.documentId][canonicalCheckpointSignature(f)].output)
        .toMatchObject({ repairAttempted: false, repairRecovery: { phase: 'in_flight', transportAttempts: 1 } });
    } finally { db.close(); }
  });

  it('上下文预算超限明确拒绝，不截断、不拆段、不调用模型', async () => {
    const f = fixture(12);
    const runtime = { runStructuredTurn: vi.fn() };
    await expect(pipeline(f, runtime, 100).process(f.documentId)).rejects.toThrow('DIRECT_ORIGINAL_CONTEXT_LIMIT_EXCEEDED');
    expect(runtime.runStructuredTurn).not.toHaveBeenCalled(); expect(f.cleanup).toHaveBeenCalledTimes(1);
  });

  function partitionedReading(f: Fixture): DirectOriginalReadingResult {
    const output = reading(f);
    output.sourceExcerpts = f.manifest.spans.map((page, index) => ({ localKey: `large_e_${index}`, pageSourceSpanId: page.id,
      quote: `合成项目${index} 7 U/L；` + Array.from({ length: 950 }, (_, item) => `合成原页${index}背景${item}。`).join(''),
      role: 'finding', clarity: 'clear' }));
    output.extraction.candidates = output.sourceExcerpts.map((excerpt, index) => ({ ...candidate(`large_c_${index}`, excerpt.localKey),
      originalName: `合成项目${index}`, value: { kind: 'numeric', rawText: '7', decimal: '8', comparator: 'eq' },
      evidence: [{ sourceSpanId: excerpt.localKey, quote: `合成项目${index} 7 U/L` }],
      sourceBinding: { headingEvidence: [], findingEvidence: [{ sourceSpanId: excerpt.localKey, quote: `合成项目${index} 7 U/L` }] } }));
    inventoryForSyntheticReading(output);
    return output;
  }

  it('超限P03依赖分包且下包连接失败后只续未完成包，完整P01与已回包不重发', async () => {
    const f = fixture(6); const output = partitionedReading(f);
    saveCanonicalCheckpoint(f, output, false, 'direct-original-acceptance-v16', 'extract-direct-original-v17');
    const sent: string[] = []; let failSecond = true;
    const runtime = { runStructuredTurn: vi.fn(async (input) => {
      expect(input.prompt).toContain('REPAIR_PARTITION=');
      expect(Buffer.byteLength(input.prompt, 'utf8')).toBeLessThanOrEqual(75_000);
      expect(input.imagePaths).toEqual(f.prepared.imagePaths);
      sent.push(input.prompt);
      if (failSecond && sent.length === 2) { failSecond = false; throw new Error('CODEX_CONNECTION_FAILED'); }
      const replacements = Object.fromEntries(repairRequest(input).targets.filter((target) => target.nodeType === 'candidate')
        .map((target) => [target.targetId, { nodeType: 'candidate' as const, value: { ...output.extraction.candidates.find((item) => item.localKey === target.targetId)!,
          value: { kind: 'numeric' as const, rawText: '7', decimal: '7', comparator: 'eq' as const } } }]));
      return receipt(targetRepair(f, output, input, replacements), sent.length + 10);
    }) };
    await expect(pipeline(f, runtime, 75_000).process(f.documentId)).rejects.toThrow('CODEX_CONNECTION_FAILED');
    const stored = f.store.getExtractionChunkCheckpoint(f.guard, f.documentId, canonicalCheckpointSignature(f))!.output as {
      repairAttempted: boolean; repairPartitionRecovery: { parts: unknown[] } };
    expect(stored.repairAttempted).toBe(false);
    expect(stored.repairPartitionRecovery.parts.slice(0, 2)).toMatchObject([
      { index: 0, recovery: { phase: 'validated', transportAttempts: 1 } },
      { index: 1, recovery: { phase: 'transport_unknown', transportAttempts: 1 } }
    ]);
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(0);
    expect(await pipeline(f, runtime, 75_000).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 6 });
    expect(sent.filter((prompt) => prompt === sent[0])).toHaveLength(1);
    expect(sent.filter((prompt) => prompt === sent[1])).toHaveLength(2);
    expect(sent.every((prompt) => !prompt.startsWith('# DIRECT_ORIGINAL_P01'))).toBe(true);
  });

  it('分包已保存回执遇上下文版本变化拒绝复用，不再发送或提交', async () => {
    const f = fixture(6); const output = partitionedReading(f); saveCanonicalCheckpoint(f, output, false);
    let calls = 0;
    const runtime = { runStructuredTurn: vi.fn(async (input) => {
      calls++;
      if (calls === 2) throw new Error('CODEX_CONNECTION_FAILED');
      return receipt(targetRepair(f, output, input), calls + 20);
    }) };
    await expect(pipeline(f, runtime, 75_000).process(f.documentId)).rejects.toThrow('CODEX_CONNECTION_FAILED');
    const preview = f.store.previewDirectOriginalAdmission.bind(f.store);
    vi.spyOn(f.store, 'previewDirectOriginalAdmission').mockImplementation((input) => {
      const result = preview(input); result.reportReasonCodes.push('synthetic_scope_changed'); return result;
    });
    await expect(pipeline(f, runtime, 75_000).process(f.documentId)).rejects.toThrow('DIRECT_ORIGINAL_REPAIR_RECOVERY_SCOPE_CHANGED');
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(0);
  });

  it('分包传输最多3次且持久化，其他有效包仍只读取一次并统一接纳', async () => {
    const f = fixture(3); const output = partitionedReading(f); saveCanonicalCheckpoint(f, output, false);
    const sent: number[] = [];
    const runtime = { runStructuredTurn: vi.fn(async (input) => {
      const line = input.prompt.split('\n').find((line: string) => line.startsWith('REPAIR_PARTITION='));
      const part = JSON.parse(line.slice('REPAIR_PARTITION='.length)); sent.push(part.index);
      if (part.index === 1) throw new Error('CODEX_TURN_TIMEOUT');
      const replacements = Object.fromEntries(repairRequest(input).targets.filter((target) => target.nodeType === 'candidate')
        .map((target) => [target.targetId, { nodeType: 'candidate' as const,
          value: { ...output.extraction.candidates.find((item) => item.localKey === target.targetId)!,
            value: { kind: 'numeric' as const, rawText: '7', decimal: '7', comparator: 'eq' as const } } }]));
      return receipt(targetRepair(f, output, input, replacements), sent.length + 30);
    }) };
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(pipeline(f, runtime, 75_000).process(f.documentId)).rejects.toThrow('CODEX_TURN_TIMEOUT');
      expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(0);
    }
    expect(await pipeline(f, runtime, 75_000).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: 2 });
    expect(sent).toEqual([0, 1, 1, 1, 2]);
    expect(f.store.listExtractionRepairDiagnostics({ documentId: f.documentId })[0]?.outcome).toBe('transport_exhausted');
  });

  it('分包回包保存后意外退出，仅重验已有回包再继续，不重新发送该原件包', async () => {
    const f = fixture(3); const output = partitionedReading(f); saveCanonicalCheckpoint(f, output, false);
    const sent: string[] = [];
    const runtime = { runStructuredTurn: vi.fn(async (input) => {
      sent.push(input.prompt); return receipt(targetRepair(f, output, input), sent.length + 40);
    }) };
    const save = f.store.saveExtractionChunkCheckpoint.bind(f.store);
    let interrupted = false;
    vi.spyOn(f.store, 'saveExtractionChunkCheckpoint').mockImplementation((input) => {
      const result = save(input);
      if (!interrupted && (input.output as { repairPartitionRecovery?: { parts: { recovery?: { phase: string } }[] } })
        .repairPartitionRecovery?.parts[0]?.recovery?.phase === 'response_saved') {
        interrupted = true; throw new Error('SYNTHETIC_PART_SAVED_INTERRUPTION');
      }
      return result;
    });
    await expect(pipeline(f, runtime, 75_000).process(f.documentId)).rejects.toThrow('SYNTHETIC_PART_SAVED_INTERRUPTION');
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(0);
    expect(await pipeline(f, runtime, 75_000).process(f.documentId)).toMatchObject({ status: 'partial' });
    expect(sent).toHaveLength(3); expect(new Set(sent).size).toBe(3);
  });

  it.each([ACCEPTANCE_RULES_VERSION, 'direct-original-acceptance-v6', 'direct-original-acceptance-v5', 'direct-original-acceptance-v4'])(
    '%s完整P03前置预算失败保留17页P01与收据，正常续跑只做唯一P03', async (rulesVersion) => {
      const f = fixture(17); const output = reading(f);
      f.prepared.nativeText = '合成完整原文件文字：左侧，未散瞳，<2.50E＋02。';
      output.extraction.candidates[0]!.value = { kind: 'numeric', rawText: '7', decimal: '8', comparator: 'eq' };
      const original = saveCanonicalCheckpoint(f, output, false, rulesVersion);
      const transmit = vi.spyOn(f.store, 'beginAiTransmission');
      const runtime = { runStructuredTurn: vi.fn(async (input) => {
        expect(input.prompt.startsWith('# DIRECT_ORIGINAL_P03')).toBe(true);
        expect(input.imagePaths).toEqual(f.prepared.imagePaths);
        expect(input.imagePaths).toHaveLength(17);
        expect(input.prompt).toContain(JSON.stringify(f.prepared.nativeText));
        expect(input.allowWebSearch).toBe(false);
        expect(repairRequest(input)).toMatchObject({ originalReadingHash: stableHash(original.reading) });
        return receipt(targetRepair(f, original.reading, input, { c_a: { nodeType: 'candidate', value: candidate() } }), 2);
      }) };

      await expect(pipeline(f, runtime, 100).process(f.documentId)).rejects.toThrow('DIRECT_ORIGINAL_CONTEXT_LIMIT_EXCEEDED');
      expect(runtime.runStructuredTurn).not.toHaveBeenCalled();
      expect(transmit).not.toHaveBeenCalled();
      expect(f.store.getDocumentAiTransmissionStatus(f.documentId)).toBe('not_sent');
      expect(f.store.listAcceptedObservations(f.person.id)).toEqual([]);
      const preserved = f.store.getExtractionChunkCheckpoint(f.guard, f.documentId, canonicalCheckpointSignature(f));
      expect(preserved?.output).toEqual(original);
      expect(preserved?.output).toMatchObject({ repairAttempted: false, excerptReceipts: original.excerptReceipts });

      expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 1 });
      expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(1);
      expect(transmit).toHaveBeenCalledTimes(1);
      expect(transmit.mock.calls[0]![0].stage).toBe('repair_extraction');
      const accepted = f.store.listAcceptedObservations(f.person.id)[0]!;
      expect(accepted.decimalValue).toBe('7');
      expect(f.store.getDocumentExtractionBundle(f.documentId).manifest.spans.find((span) => span.modelEvidence)?.modelEvidence)
        .toMatchObject(original.receipt);
      expect(f.cleanup).toHaveBeenCalledTimes(2);
    });

  it.each(['current', 'v13'] as const)('217候选122摘录的17页任务预算失败后，同job新attempt复用%s完整P01并只发送一次P03', async (checkpointVersion) => {
    const f = fixture(17); const output = reading(f);
    f.prepared.nativeText = f.manifest.spans.map((_, index) => `第${index + 1}页合成完整原文：左侧，未散瞳，<2.50E＋02；本页内容完整保留。`).join('\n');
    output.sourceExcerpts = [];
    output.extraction.candidates = [];
    const replacements: Record<string, NonNullable<DirectOriginalReadingRepair['results'][number]['replacement']>> = {};
    for (let excerptIndex = 0; excerptIndex < 122; excerptIndex += 1) {
      const excerptKey = `e_synthetic_${excerptIndex}`;
      const quotes: string[] = [];
      // 前95个摘录各含两个独立字段，其余各含一个，共217个候选，均为脱敏合成内容。
      for (let fieldIndex = 0; fieldIndex < (excerptIndex < 95 ? 2 : 1); fieldIndex += 1) {
        const index = output.extraction.candidates.length;
        const value = String(index + 7);
        const expected = candidate(`c_synthetic_${index}`, excerptKey, value);
        expected.originalName = `合成指标${index}`;
        const quote = `${expected.originalName} ${value} U/L`;
        expected.evidence[0]!.quote = quote;
        quotes.push(quote);
        replacements[expected.localKey] = { nodeType: 'candidate', value: structuredClone(expected) };
        output.extraction.candidates.push({ ...expected,
          value: { kind: 'numeric', rawText: value, decimal: String(index + 8), comparator: 'eq' } });
      }
      output.sourceExcerpts.push({ localKey: excerptKey,
        pageSourceSpanId: f.manifest.spans[excerptIndex % f.manifest.spans.length]!.id,
        quote: quotes.join('；'), role: 'finding', clarity: 'clear' });
    }
    inventoryForSyntheticReading(output);
    expect(output.extraction.candidates).toHaveLength(217);
    expect(output.sourceExcerpts).toHaveLength(122);
    const sourceBefore = f.store.getDocumentOriginalSource(f.documentId);
    const sourceBytesBefore = readFileSync(sourceBefore.sourcePath);
    const factsBefore = f.store.listAcceptedObservations(f.person.id);
    const transmission = vi.spyOn(f.store, 'beginAiTransmission');
    const checkpoints = vi.spyOn(f.store, 'saveExtractionChunkCheckpoint');
    const runtime = { runStructuredTurn: vi.fn(async (input) => {
      expect(input.imagePaths).toEqual(f.prepared.imagePaths);
      expect(input.imagePaths).toHaveLength(17);
      expect(input.prompt).toContain(JSON.stringify(f.prepared.nativeText));
      expect(input.allowWebSearch).toBe(false);
      if (input.prompt.startsWith('# DIRECT_ORIGINAL_P01')) return receipt(output);
      expect(input.prompt.startsWith('# DIRECT_ORIGINAL_P03')).toBe(true);
      for (const section of DIRECT_ORIGINAL_INPUT_SECTIONS) {
        const line = input.prompt.split('\n').find((entry: string) => entry.startsWith(`${section}=`))!;
        const envelope = JSON.parse(line.slice(section.length + 1));
        expect(envelope).toMatchObject({ inputVersion: DIRECT_ORIGINAL_INPUT_V6_VERSION, section });
        // 每块独立反展，整份原件、原句、日期角色和授权范围不能随传输换版丢失。
        expect(() => decodeDirectOriginalInput(section, envelope)).not.toThrow();
      }
      expect(repairRequest(input)).toMatchObject({ originalReadingHash: stableHash(directOriginalReadingResultSchema.parse(output)) });
      expect(targetItems(input)).toHaveLength(217);
      return receipt(targetRepair(f, output, input, replacements), 2);
    }) };

    await expect(pipeline(f, runtime, 32 * 1024).process(f.documentId)).rejects.toThrow('DIRECT_ORIGINAL_CONTEXT_LIMIT_EXCEEDED');
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(1);
    expect(runtime.runStructuredTurn.mock.calls[0]![0].prompt.startsWith('# DIRECT_ORIGINAL_P01')).toBe(true);
    expect(transmission.mock.calls.map(([input]) => input.stage)).toEqual(['extract']);
    const signature = canonicalCheckpointSignature(f);
    const before = f.store.getExtractionChunkCheckpoint(f.guard, f.documentId, signature)!;
    expect(before.output).toMatchObject({ checkpointKind: 'direct_original_reading', reading: output,
      repairAttempted: false, receipt: { threadId: 'synthetic-direct-thread-1', turnId: 'synthetic-direct-turn-1' } });
    const savedSignature = checkpointVersion === 'v13'
      ? canonicalCheckpointSignature(f, 'direct-original-acceptance-v13', 'extract-direct-original-v15') : signature;
    if (checkpointVersion === 'v13') {
      // 只在隔离测试库重建上一安装版的同一完整回执；升级不得重读、截断或重置额度。
      f.store.clearExtractionChunkCheckpoints(f.guard, f.documentId);
      f.store.saveExtractionChunkCheckpoint({ guard: f.guard, documentId: f.documentId,
        signature: savedSignature, chunkIndex: 0, ...before });
      expect(f.store.getExtractionChunkCheckpoint(f.guard, f.documentId, signature)).toBeNull();
    }
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual(factsBefore);
    f.store.finishJob(f.job.id, 'failed');
    f.store.finishJobAttempt({ attemptId: f.guard.attemptId, status: 'failed', errorCode: 'DIRECT_ORIGINAL_CONTEXT_LIMIT_EXCEEDED' });
    const failedAttemptId = f.guard.attemptId;

    f.store.retryFailedJob(f.job.id);
    const resumedJob = f.store.claimNextQueuedJob('synthetic-direct-resumed-runner', f.guard.accountFingerprint)!;
    expect(resumedJob).toMatchObject({ id: f.job.id, stage: 'extract', documentIds: [f.documentId], consentId: f.guard.consentId });
    const resumedAttemptId = f.store.startJobAttempt(resumedJob.id, 'synthetic-runtime', 'gpt-6.1-sol', 'medium');
    expect(resumedAttemptId).not.toBe(failedAttemptId);
    const resumed = { ...f, guard: { ...f.guard, attemptId: resumedAttemptId } };
    expect(f.store.getExtractionChunkCheckpoint(resumed.guard, f.documentId, savedSignature)).toEqual(before);
    expect(f.store.getJobProcessedDocumentIds(f.job.id)).toEqual(new Set());
    runtime.runStructuredTurn.mockClear(); transmission.mockClear();

    expect(await pipeline(resumed, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 217 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(1);
    expect(runtime.runStructuredTurn.mock.calls.every(([input]) => input.prompt.startsWith('# DIRECT_ORIGINAL_P03'))).toBe(true);
    expect(transmission.mock.calls).toHaveLength(1);
    expect(transmission.mock.calls[0]![0]).toMatchObject({ stage: 'repair_extraction', documentId: f.documentId,
      guard: { jobId: f.job.id, attemptId: resumedAttemptId, consentId: f.guard.consentId } });
    expect(checkpoints.mock.calls.at(-1)![0].output).toMatchObject({ repairAttempted: true, firstReading: output,
      firstTransmissionId: (before.output as { firstTransmissionId: string }).firstTransmissionId });
    // 正式发布完成才清理原文断点；失败后的本人重试不会先丢掉它。
    expect(f.store.getExtractionChunkCheckpoint(resumed.guard, f.documentId, signature)).toBeNull();
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(217);
    expect(f.store.getDocumentOriginalSource(f.documentId)).toEqual({ ...sourceBefore, status: 'completed' });
    expect(readFileSync(sourceBefore.sourcePath)).toEqual(sourceBytesBefore);
    expect(f.prepared.nativeText).toContain('第17页合成完整原文');
    expect(f.cleanup).toHaveBeenCalledTimes(2);
  }, 30_000);

  it.each(['replace', 'keep'] as const)('显式日期纠错强制独立完整原件P03，%s按真实核验结果处理', async (mode) => {
    const f = fixture();
    const dated = (value: string) => {
      const output = reading(f);
      output.sourceExcerpts.push({ localKey: 'e_date', pageSourceSpanId: f.manifest.spans[0]!.id,
        quote: `检查日期：${value}`, role: 'date', clarity: 'clear' });
      const dateRef = { sourceSpanId: 'e_date', quote: `检查日期：${value}` };
      output.extraction.candidates[0]!.clinicalDate = value;
      output.extraction.candidates[0]!.sourceBinding!.findingEvidence = [...output.extraction.candidates[0]!.evidence];
      output.extraction.candidates[0]!.evidence.push(dateRef);
      output.extraction.reportMetadata = { reportKind: null, title: null, organization: null,
        campus: null, department: null, reportNumber: null, examItems: [], primaryClinicalTimeIndex: 0,
        times: [{ value, precision: 'day', role: 'examined', evidence: [dateRef] }] };
      return output;
    };
    const initialResult = await pipeline(f, { runStructuredTurn: vi.fn(async () => receipt(dated('2020-03-04'))) }).process(f.documentId);
    expect(f.store.listOpenExtractionReviewIssues().map((issue) => issue.reasonCodes)).toEqual([]);
    expect(initialResult).toMatchObject({ status: 'published' });
    f.store.finishJobAttempt({ attemptId: f.guard.attemptId, status: 'succeeded' }); f.store.finishJob(f.guard.jobId, 'succeeded');
    const consentId = f.store.createManualProcessingConsent({ documentIds: [f.documentId], personIds: [f.person.id],
      accountFingerprint: f.guard.accountFingerprint, version: 1, dateCorrectionDocumentId: f.documentId });
    f.store.createWaitingAuthBatch({ cutoff: '2026-01-03T00:00:00Z', initialStatus: 'queued', consentId,
      dateCorrectionDocumentId: f.documentId,
      groups: [{ personId: f.person.id, documentIds: [f.documentId], stage: 'extract', inputSignature: `synthetic-date-${mode}` }] });
    const job = f.store.claimNextQueuedJob('synthetic-date-worker', f.guard.accountFingerprint)!;
    const guard = { ...f.guard, consentId, jobId: job.id,
      attemptId: f.store.startJobAttempt(job.id, 'synthetic-runtime', 'gpt-6.1-sol', 'medium') };
    const scopes = f.store.getDateCorrectionFactScopes(guard, f.documentId);
    let calls = 0;
    const runtime = { runStructuredTurn: vi.fn(async (input: { prompt: string; imagePaths?: string[] }) => {
      expect(input.imagePaths).toEqual(f.prepared.imagePaths);
      expect(input.prompt).not.toContain('2020-03-04');
      expect(input.prompt).not.toContain('READ_ONLY_PAGE_CONTEXT=');
      const value = calls++ === 1 && mode === 'keep' ? '2027-03-04' : '2026-03-04';
      return rawReceipt({ schemaVersion: 1, documentId: f.documentId,
        subject: { reportedName: f.person.displayName, confidence: 'explicit', evidence: [
          { pageSourceSpanId: f.manifest.spans[0]!.id, quote: `姓名：${f.person.displayName}`, clarity: 'clear' }] },
        dates: [{ localKey: 'exam', value, role: 'examined', pageSourceSpanId: f.manifest.spans[0]!.id,
          quote: `检查日期：${value}`, clarity: 'clear', factScopeIds: scopes.factScopes.map((scope) => scope.scopeId) }],
        primaryClinicalDateKey: 'exam' }, calls + 1);
    }) };
    const result = await new DirectOriginalExtractionPipeline(f.store, runtime, guard, { prepareOriginal: f.prepareOriginal }).process(f.documentId);
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
    expect(result.status).toBe(mode === 'replace' ? 'published' : 'partial');
    expect(f.store.listAcceptedObservations(f.person.id)[0]!.clinicalDate).toBe(mode === 'replace' ? '2026-03-04' : '2020-03-04');
  });

  it('模型返回前撤权，来源、事实和断点都不能提交', async () => {
    const f = fixture();
    const runtime = { runStructuredTurn: vi.fn(async () => { f.store.revokeAllAiAuthorizations(); return receipt(reading(f)); }) };
    await expect(pipeline(f, runtime).process(f.documentId)).rejects.toThrow('CONSENT_REVOKED');
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual([]);
    expect(f.store.getDocumentExtractionBundle(f.documentId).manifest.spans.every((span) => !span.modelEvidence)).toBe(true);
    expect(f.cleanup).toHaveBeenCalledTimes(1);
  });

  it('明确异常符号正常接纳并保存已解决协议审计，不制造待核对或第二次读取', async () => {
    const f = fixture(); const output = reading(f);
    output.extraction.candidates[0]!.reportedAbnormalFlag = '↑';
    const runtime = { runStructuredTurn: vi.fn(async () => receipt(output)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 1 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(1);
    expect(f.store.listAcceptedObservations(f.person.id)[0]!.abnormalFlag).toBe('high');
    expect(f.store.listOpenExtractionReviewIssues()).toEqual([]);
    const db = (f.store as unknown as { db: Database.Database }).db;
    const row = db.prepare("SELECT resolution_status,payload_json FROM review_issues WHERE resolution_status='resolved'").get() as {
      resolution_status: string; payload_json: string };
    expect(JSON.parse(row.payload_json)).toMatchObject({ protocolNormalization: { fieldPath: 'reportedAbnormalFlag',
      canonicalValue: 'high', originalCandidate: { reportedAbnormalFlag: '↑' } } });
  });

  it('辅助标题缺引用时保留独立结果及其他元数据，并持久保留原辅助字段', async () => {
    const f = fixture(); const output = reading(f);
    output.extraction.reportMetadata = { reportKind: null, title: { value: '合成标题',
      evidence: [{ sourceSpanId: 'e_a', quote: '原件并不存在的合成标题' }] }, organization: null, campus: null,
      department: null, reportNumber: null, examItems: [], times: [] };
    const runtime = { runStructuredTurn: vi.fn(async () => receipt(output)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: 1 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(1);
    expect(f.store.listAcceptedObservations(f.person.id)[0]!.rawText).toBe('7');
    const db = (f.store as unknown as { db: Database.Database }).db;
    const payload = JSON.parse((db.prepare("SELECT payload_json FROM review_issues WHERE resolution_status='open'").get() as {
      payload_json: string }).payload_json);
    expect(payload.candidateOptions).toEqual([]);
    expect(payload.fieldReviews[0]).toMatchObject({ kind: 'metadata', original: { title: { value: '合成标题' } },
      fields: [{ fieldPath: 'reportMetadata.title', reasonCodes: ['direct_original_metadata_field_unverified', 'direct_original_reference_changed'] }] });
  });

  it('日期字段隔离不得改写已存正确日期；新回包原日期仍有审计', async () => {
    const f = fixture(); const first = reading(f); const date = { sourceSpanId: 'date', quote: '合成检查日期2026-02-03' };
    first.sourceExcerpts.push({ localKey: date.sourceSpanId, pageSourceSpanId: f.manifest.spans[0]!.id,
      quote: date.quote, role: 'date', clarity: 'clear' });
    first.extraction.candidates[0]!.sourceBinding!.findingEvidence = [...first.extraction.candidates[0]!.evidence];
    first.extraction.candidates[0]!.evidence.push(date);
    first.extraction.candidates[0]!.clinicalDate = '2026-02-03';
    first.extraction.reportMetadata = { reportKind: null, title: null, organization: null, campus: null,
      department: null, reportNumber: null, examItems: [], times: [{
        role: 'examined', value: '2026-02-03', precision: 'day', evidence: [date] }] };
    expect(await pipeline(f, { runStructuredTurn: vi.fn(async () => receipt(first)) }).process(f.documentId)).toMatchObject({ status: 'published' });
    const before = f.store.listAcceptedObservations(f.person.id);
    const db = (f.store as unknown as { db: Database.Database }).db;
    const previousRevisions = db.prepare('SELECT * FROM observation_revisions').all();
    f.store.saveExtractionReviewIssue({ documentId: f.documentId, stage: 'extract', kind: 'coverage_gap', severity: 'warning',
      evidenceRefs: [], preserveDocumentStatus: true, candidateOptions: [], reasonCodes: ['synthetic_recheck'] });
    const next = structuredClone(first); next.extraction.candidates[0]!.clinicalDate = '2026-02-04';
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(next, 2))
      .mockImplementationOnce(async input => receipt(targetRepair(f, next, input), 3)) };
    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: 0 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual(before);
    expect(db.prepare('SELECT * FROM observation_revisions').all()).toEqual(previousRevisions);
    const payload = JSON.parse((db.prepare("SELECT payload_json FROM review_issues WHERE resolution_status='open'").get() as {
      payload_json: string }).payload_json);
    expect(payload.fieldReviews[0].original.clinicalDate).toBe('2026-02-04');
  });

  it('保存层拒绝没有字段审计或伪造审计的null日期投影', async () => {
    const f = fixture(); const output = reading(f); output.extraction.candidates[0]!.clinicalDate = '2026-02-03';
    const preview = vi.spyOn(f.store, 'previewDirectOriginalAdmission');
    await pipeline(f, { runStructuredTurn: vi.fn(async () => receipt(output)) }).process(f.documentId);
    const input = preview.mock.calls[0]![0];
    expect(() => f.store.previewDirectOriginalAdmission({ ...input, fieldReviews: [] }))
      .toThrow('DIRECT_ORIGINAL_FIELD_PROJECTION_REQUIRED');
    expect(() => f.store.previewDirectOriginalAdmission({ ...input, fieldReviews: input.fieldReviews!.map((review) =>
      ({ ...review, fields: review.fields.map((field) => ({ ...field, reasonCodes: ['fabricated_reason'] })) })) }))
      .toThrow('DIRECT_ORIGINAL_FIELD_PROJECTION_INVALID');
  });
});
