import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { directOriginalReadingResultSchema, type DirectOriginalReadingRepair, type DirectOriginalReadingResult,
  type DirectOriginalRepairTarget, type ObservationCandidate, type SourceManifest } from '@contracts';
import { stableHash } from '@core';
import type { PreparedOriginalModelInput } from '@ingestion';
import { WorkspaceStore } from '@storage';
import { DirectOriginalExtractionPipeline, directOriginalDateCorrectionReportHoldReason } from './direct-original-extraction.js';
import { decodeDirectOriginalInput } from './direct-original-input.js';
import { encodeDirectOriginalReading, encodeDirectOriginalRepair } from './direct-original-wire.js';

const stores = new Set<WorkspaceStore>();
const roots: string[] = [];
afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// 仅使用本测例创建的临时数据库、合成原件和模拟模型回执，不读取正式健康资料。
function fixture() {
  const rootDirectory = mkdtempSync(join(tmpdir(), 'family-health-admission-diagnostics-synthetic-'));
  roots.push(rootDirectory);
  const store = new WorkspaceStore({ rootDirectory });
  stores.add(store);
  const person = store.createPerson({ displayName: '合成复核成员' });
  const source = store.putSourceObject({ bytes: Buffer.from('合成原件占位，不含健康资料'),
    mediaType: 'image/png', displayName: '合成日期诊断.png' });
  const { documentId } = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
  const pageId = 'synthetic-admission-page-1';
  const manifest: SourceManifest = { id: 'synthetic-admission-manifest', sourceObjectId: source.id,
    sha256: source.sha256, mediaType: 'image/png', originalDisplayName: '合成日期诊断.png', totalUnits: 1,
    coveredUnitIndexes: [0], normalizerVersion: 'direct-original-preparation-v1', conversionWarnings: [],
    createdAt: '2026-01-03T00:00:00Z', spans: [{ id: pageId, documentId, spanKind: 'image', page: 1,
      blockId: 'direct-original-page:1', lineStart: null, lineEnd: null, quote: null, readability: 'unreadable' }] };
  store.saveSourceManifest(manifest);
  const accountFingerprint = 'synthetic-admission-account';
  const consentId = store.createManualProcessingConsent({ documentIds: [documentId], personIds: [person.id],
    accountFingerprint, version: 1 });
  store.createWaitingAuthBatch({ cutoff: '2026-01-03T00:00:00Z', initialStatus: 'queued', consentId,
    groups: [{ personId: person.id, documentIds: [documentId], inputSignature: 'synthetic-admission-job' }] });
  const job = store.claimNextQueuedJob('synthetic-admission-runner', accountFingerprint)!;
  const attemptId = store.startJobAttempt(job.id, 'synthetic-runtime', 'gpt-6.1-sol', 'medium');
  const guard = { jobId: job.id, attemptId, consentId, accountFingerprint };
  const prepared: PreparedOriginalModelInput = { manifest, originalSha256: source.sha256, totalUnits: 1,
    tempRoot: '/synthetic-private-temp', cleanup: async () => undefined,
    imagePaths: ['/synthetic-original/page-1.png'], imageMappings: [{ inputKind: 'image', page: 1,
      sourceSpanId: pageId, path: '/synthetic-original/page-1.png', mediaType: 'image/png', sha256: source.sha256,
      width: 1200, height: 1600 }], unitMappings: [{ inputKind: 'image', page: 1, sourceSpanId: pageId }] };
  return { store, person, documentId, pageId, manifest, guard, prepareOriginal: async () => prepared };
}
type Fixture = ReturnType<typeof fixture>;

function candidate(localKey = 'c_a'): ObservationCandidate {
  const evidence = [{ sourceSpanId: 'e_a', quote: '合成指标 7 U/L' }];
  return { localKey, originalName: '合成指标', standardNameCandidate: null,
    value: { kind: 'numeric', rawText: '7', decimal: '7', comparator: 'eq' }, unitRaw: 'U/L',
    referenceRangeRaw: null, reportedAbnormalFlag: null, specimen: null, method: null, bodySite: null,
    clinicalDate: null, clinicalContext: { version: 1, status: 'complete', conditions: [] }, evidence,
    sourceBinding: { headingEvidence: [], findingEvidence: evidence }, issues: [] };
}
function reading(f: Fixture): DirectOriginalReadingResult {
  return { schemaVersion: 1, documentId: f.documentId, pageReadings: [{ sourceSpanId: f.pageId, status: 'read',
    resultInventory: [{ sourceSpanId: 'e_a', candidateKeys: ['c_a'] }] }],
    sourceExcerpts: [{ localKey: 'e_a', pageSourceSpanId: f.pageId, quote: '合成指标 7 U/L', role: 'finding', clarity: 'clear' }],
    extraction: { schemaVersion: 1, documentId: f.documentId,
      subject: { reportedName: null, confidence: 'absent', evidence: [] }, reportMetadata: null,
      coveredSourceSpanIds: [f.pageId], candidates: [candidate()] } };
}
const receipt = (output: DirectOriginalReadingResult | DirectOriginalReadingRepair, turn: number) => ({
  threadId: `synthetic-admission-thread-${turn}`, turnId: `synthetic-admission-turn-${turn}`,
  output: 'pageReadings' in output ? encodeDirectOriginalReading(output) : encodeDirectOriginalRepair(output)
});
function request(input: { prompt: string }): { targets: DirectOriginalRepairTarget[]; issues: string[] } {
  const line = input.prompt.split('\n').find((item) => item.startsWith('REPAIR_REQUEST='));
  if (!line) throw new Error('SYNTHETIC_REPAIR_REQUEST_REQUIRED');
  return decodeDirectOriginalInput('REPAIR_REQUEST', JSON.parse(line.slice('REPAIR_REQUEST='.length))) as ReturnType<typeof request>;
}
function readPageRepair(f: Fixture, original: DirectOriginalReadingResult, input: { prompt: string }): DirectOriginalReadingRepair {
  return { schemaVersion: 1, documentId: f.documentId,
    originalReadingHash: stableHash(directOriginalReadingResultSchema.parse(original)),
    results: request(input).targets.map((target) => target.nodeType === 'page'
      ? { targetId: target.targetId, action: 'replace' as const,
        replacement: { nodeType: 'page' as const, value: { sourceSpanId: target.targetId, status: 'read' as const } } }
      : { targetId: target.targetId, action: 'unchanged' as const, replacement: null }) };
}
function pipeline(f: Fixture, runtime: { runStructuredTurn: ReturnType<typeof vi.fn> }) {
  return new DirectOriginalExtractionPipeline(f.store, runtime, f.guard, { prepareOriginal: f.prepareOriginal });
}
function reasons(f: Fixture): string[] {
  return f.store.listOpenExtractionReviewIssues().filter((issue) => issue.documentId === f.documentId)
    .flatMap((issue) => issue.reasonCodes);
}

describe('原件读取与正式接纳的诊断边界', () => {
  it('恢复页读到清楚结果但同轮语义冲突时仍暂存，不误称未补到结果', async () => {
    const f = fixture(); const output = reading(f); output.pageReadings[0]!.status = 'partial';
    const conflict = candidate('c_b'); conflict.method = '合成不同检测方法';
    output.extraction.candidates.push(conflict);
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output, 1))
      .mockImplementationOnce(async (input) => receipt(readPageRepair(f, output, input), 2)) };

    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: 0 });
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual([]);
    expect(f.store.isDocumentCommitted(f.documentId)).toBe(false);
    expect(reasons(f)).toContain('same_source_finding_batch_conflict');
    expect(reasons(f)).not.toContain('direct_original_page_not_fully_read');
    expect(reasons(f)).not.toContain('direct_original_page_recovery_missing_results');
    expect(f.store.listExtractionRepairDiagnostics({ documentId: f.documentId })[0]).toMatchObject({
      outcome: 'still_failed', diagnostic: { acceptedCount: 0, remainingFailureCount: 2 } });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
  });

  it('恢复页的新读取与已保存事实冲突时保留旧事实，不把业务暂存诊断变成漏读', async () => {
    const f = fixture(); const first = reading(f);
    const initialRuntime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(first, 1)) };
    expect(await pipeline(f, initialRuntime).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 1 });
    const before = f.store.listAcceptedObservations(f.person.id);
    const revision = f.store.getFactRevision(f.person.id);
    f.store.saveExtractionReviewIssue({ documentId: f.documentId, stage: 'extract', kind: 'field_conflict',
      severity: 'warning', preserveDocumentStatus: true, evidenceRefs: [], candidateOptions: [],
      reasonCodes: ['synthetic_recheck_required'] });
    const next = reading(f); next.pageReadings[0]!.status = 'partial';
    next.extraction.candidates[0]!.method = '合成不同检测方法';
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(next, 3))
      .mockImplementationOnce(async (input) => {
        expect(request(input).issues).toContain('same_source_finding_semantic_conflict');
        return receipt(readPageRepair(f, next, input), 4);
      }) };

    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: 0 });
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual(before);
    expect(f.store.getFactRevision(f.person.id)).toBe(revision);
    expect(reasons(f)).toContain('same_source_finding_semantic_conflict');
    expect(reasons(f)).not.toContain('direct_original_page_not_fully_read');
    expect(reasons(f)).not.toContain('direct_original_page_recovery_missing_results');
    expect(f.store.listExtractionRepairDiagnostics({ documentId: f.documentId }).at(-1)).toMatchObject({
      outcome: 'still_failed', diagnostic: { acceptedCount: 0, remainingFailureCount: 1 } });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
  });

  it('真正未补到任何结果的页不能只改read回执，仍按漏读暂存', async () => {
    const f = fixture(); const output = reading(f); output.pageReadings[0]!.status = 'partial';
    output.sourceExcerpts = []; output.extraction.candidates = [];
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output, 1))
      .mockImplementationOnce(async (input) => receipt(readPageRepair(f, output, input), 2)) };

    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: 0 });
    expect(f.store.isDocumentCommitted(f.documentId)).toBe(false);
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual([]);
    expect(reasons(f)).toContain('direct_original_page_recovery_missing_results');
    expect(f.store.listExtractionRepairDiagnostics({ documentId: f.documentId })[0]?.outcome).toBe('still_failed');
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
  });

  it('结果自身结构未成立时不能借清楚摘录绕过恢复页结果证明', async () => {
    const f = fixture(); const output = reading(f); output.pageReadings[0]!.status = 'partial';
    output.extraction.candidates[0]!.value = { kind: 'numeric', rawText: '7', decimal: '8', comparator: 'eq' };
    const runtime = { runStructuredTurn: vi.fn().mockResolvedValueOnce(receipt(output, 1))
      .mockImplementationOnce(async (input) => receipt(readPageRepair(f, output, input), 2)) };

    expect(await pipeline(f, runtime).process(f.documentId)).toMatchObject({ status: 'partial', candidateCount: 0 });
    expect(f.store.isDocumentCommitted(f.documentId)).toBe(false);
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual([]);
    expect(reasons(f)).toContain('direct_original_page_recovery_missing_results');
    expect(f.store.listExtractionRepairDiagnostics({ documentId: f.documentId })[0]?.outcome).toBe('still_failed');
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
  });
});

describe('旧日期修正分支的最终原因分类', () => {
  it.each(['report_metadata_date_evidence_unverified', 'report_metadata_date_role_unverified',
    'report_metadata_primary_clinical_time_invalid', 'direct_original_primary_clinical_time_required',
    'direct_original_primary_clinical_time_invalid'])('明确日期来源或角色问题%s才称日期未证实', (reason) => {
    expect(directOriginalDateCorrectionReportHoldReason([reason])).toBe('DATE_CORRECTION_REPORT_DATE_UNPROVEN');
  });

  it.each(['direct_original_page_recovery_missing_results', 'direct_original_page_not_fully_read',
    'direct_original_page_coverage_incomplete', 'report_metadata_date_conflict',
    'report_metadata_projection_ambiguous', 'report_metadata_shared_event_projection_conflict',
    'direct_original_evidence_role_mismatch', 'person_conflict'])('其他报告问题%s不冒充日期未证实', (reason) => {
    expect(directOriginalDateCorrectionReportHoldReason([reason])).toBe('DATE_CORRECTION_REPORT_VALIDATION_FAILED');
  });

  it('混合报告问题含明确日期证据失败时仍能保留准确的日期未证实总因', () => {
    expect(directOriginalDateCorrectionReportHoldReason(['direct_original_page_not_fully_read',
      'report_metadata_date_role_unverified'])).toBe('DATE_CORRECTION_REPORT_DATE_UNPROVEN');
  });
});
