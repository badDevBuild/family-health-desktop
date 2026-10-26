import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ExtractionResult, ExtractionRepairV1, ObservationCandidate, SourceSpan } from '@contracts';
import type { DocumentExtractionBundle, WorkspaceStore } from '@storage';
import { DocumentExtractionPipeline } from './processing-pipeline.js';
import { syntheticExtractionRepair } from './extraction-repair.fixture.js';
import * as sourceNormalization from './source-normalization.js';

function fixture() {
  const source = '合成检验甲 9 U/L\n合成检验乙 7 U/L';
  const spans: SourceSpan[] = [{ id: 'synthetic-span', documentId: 'synthetic-document', spanKind: 'line',
    page: 1, blockId: null, lineStart: 1, lineEnd: 2, quote: source, readability: 'clear' }];
  const bundle: DocumentExtractionBundle = { documentId: 'synthetic-document', personId: 'synthetic-member',
    personDisplayName: '合成成员', personAssignmentBasis: 'user_selected', confirmedReportedName: null,
    confirmedPersonAliases: [], sourcePath: '/tmp/pure-synthetic.txt', manifest: { id: 'synthetic-manifest',
      sourceObjectId: 'synthetic-source', sha256: 'a'.repeat(64), mediaType: 'text/plain', originalDisplayName: '合成报告',
      totalUnits: 1, coveredUnitIndexes: [0], normalizerVersion: 'txt-synthetic', spans, conversionWarnings: [], createdAt: '2026-01-01T00:00:00Z' } };
  const candidate = (key: string, name: string, value: string): ObservationCandidate => ({ localKey: key,
    originalName: name, standardNameCandidate: null, value: { kind: 'numeric', rawText: value, decimal: value, comparator: 'eq' },
    unitRaw: 'U/L', referenceRangeRaw: null, reportedAbnormalFlag: null, specimen: null, method: null, bodySite: null,
    clinicalDate: null, evidence: [{ sourceSpanId: 'synthetic-span', quote: `${name} ${name.endsWith('甲') ? 9 : 7} U/L` }], issues: [] });
  const bad = candidate('target', '合成检验甲', '999');
  const keep = candidate('keep', '合成检验乙', '7');
  const original: ExtractionResult = { schemaVersion: 1, documentId: bundle.documentId,
    subject: { reportedName: null, evidence: [], confidence: 'absent' }, coveredSourceSpanIds: ['synthetic-span'], candidates: [bad, keep] };
  const corrected = { ...original, candidates: [candidate('target', '合成检验甲', '9'), keep] };
  const publishFacts = vi.fn((input: Parameters<WorkspaceStore['publishFacts']>[0]) => ({ revision: 1,
    duplicateCount: 0, heldCount: 0, reviewIssueId: input.unresolvedReview ? 'synthetic-issue' : null }));
  const diagnostic = vi.fn();
  const store = { isDocumentCommitted: () => false, getDocumentExtractionBundle: () => bundle,
    getFactRevision: () => 0, publishFacts, saveAcceptanceDecision: () => 'synthetic-acceptance',
    saveExtractionReviewIssue: vi.fn(() => 'synthetic-issue'), saveExtractionRepairDiagnostic: diagnostic } as unknown as WorkspaceStore;
  return { bundle, store, original, corrected, keep, publishFacts, diagnostic };
}

async function run(f: ReturnType<typeof fixture>, transform: (patch: ExtractionRepairV1) => unknown = (patch) => patch) {
  let calls = 0;
  const runtime = { runStructuredTurn: vi.fn(async (input: { prompt: string; outputSchema: Record<string, unknown> }) => ({
    threadId: 'synthetic-thread', turnId: `synthetic-turn-${++calls}`,
    output: calls === 1 ? f.original : transform(syntheticExtractionRepair(input.prompt, f.original, f.corrected))
  })) };
  const result = await new DocumentExtractionPipeline(f.store, runtime).process(f.bundle.documentId);
  return { result, runtime };
}

describe('提取P03按目标补丁完成后再接纳', () => {
  it('只发送并返回错项，非目标由应用保留，仍执行全部接纳规则', async () => {
    const f = fixture();
    const { result, runtime } = await run(f);
    expect(result).toMatchObject({ status: 'published', candidateCount: 2 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
    const input = runtime.runStructuredTurn.mock.calls[1]![0];
    const items = JSON.parse(input.prompt.split('TARGET_ITEMS=')[1]!) as Array<{ value: ObservationCandidate }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.value.originalName).toBe('合成检验甲');
    expect(input.prompt).not.toContain('TARGET_CANDIDATE=');
    expect(input.prompt).not.toContain('lifestyleDomain');
    expect(f.publishFacts.mock.calls[0]![0].observations.map((item) => item.rawText)).toEqual(['9', '7']);
    expect(f.diagnostic).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'applied', targetCandidateCount: 1,
      acceptedCount: 2, remainingFailureCount: 0 }));
  });
  it.each(['schema_invalid', 'candidate_drift', 'scope_violation'] as const)('%s 只保留原可靠结果，不第三次重写', async (failure) => {
    const f = fixture();
    const { result, runtime } = await run(f, (patch) => failure === 'schema_invalid' ? f.corrected
      : failure === 'candidate_drift' ? { ...patch, originalCandidateHash: 'b'.repeat(64) }
        : { ...patch, results: [...patch.results, { ...patch.results[0], targetId: 'keep' }] });
    expect(result).toMatchObject({ status: 'partial', candidateCount: 1 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
    expect(f.publishFacts.mock.calls[0]![0].observations.map((item) => item.rawText)).toEqual(['7']);
    expect(f.diagnostic).toHaveBeenCalledWith(expect.objectContaining({ outcome: failure, remainingFailureCount: 1 }));
  });
  it('结构正确但原值仍不可靠时明确still_failed，不因补丁形式正确就通过', async () => {
    const f = fixture();
    const { result, runtime } = await run(f, (patch) => ({ ...patch,
      results: patch.results.map((entry) => entry.nodeType === 'candidate' ? { ...entry, decision: {
        verdict: 'unchanged', replacement: null, reason: '没有可靠依据，保留原缺口' } } : entry) }));
    expect(result.status).toBe('partial');
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
    expect(f.diagnostic).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'still_failed', acceptedCount: 1 }));
  });

  it.each(['comparator', 'unit', 'date'] as const)('补丁不能用错误%s通过原接纳门禁', async (field) => {
    const f = fixture();
    const { result } = await run(f, (patch) => {
      const entry = patch.results[0]!;
      if (entry.nodeType !== 'candidate' || entry.decision.verdict !== 'replace') return patch;
      const candidate = entry.decision.replacement;
      if (field === 'comparator' && candidate.value.kind === 'numeric') candidate.value.comparator = 'lt';
      if (field === 'unit') candidate.unitRaw = 'mg/L';
      if (field === 'date') candidate.clinicalDate = '2023-01-01';
      return patch;
    });
    expect(result).toMatchObject({ status: 'partial', candidateCount: 1 });
    expect(f.publishFacts.mock.calls[0]![0].observations[0]!.originalName).toBe('合成检验乙');
    expect(f.diagnostic).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'still_failed' }));
  });

  it('左右侧冲突仍被原门禁阻断，不能用标准名改成另一侧', async () => {
    const f = fixture();
    f.bundle.manifest.spans[0]!.quote = '右眼眼压 9 mmHg\n合成检验乙 7 U/L';
    for (const output of [f.original, f.corrected]) {
      const candidate = output.candidates[0]!;
      candidate.originalName = '右眼眼压';
      candidate.unitRaw = 'mmHg';
      candidate.evidence = [{ sourceSpanId: 'synthetic-span', quote: '右眼眼压 9 mmHg' }];
    }
    const { result } = await run(f, (patch) => {
      const entry = patch.results[0]!;
      if (entry.nodeType === 'candidate' && entry.decision.verdict === 'replace') entry.decision.replacement.standardNameCandidate = '左眼眼压';
      return patch;
    });
    expect(result).toMatchObject({ status: 'partial', candidateCount: 1 });
    expect(f.publishFacts.mock.calls[0]![0].observations[0]!.originalName).toBe('合成检验乙');
  });

  it('科学计数法原值与小于边界在目标修复及正式接纳中保持一致', async () => {
    const f = fixture();
    f.bundle.manifest.spans[0]!.quote = '合成检验甲 <2.50E+02 U/L\n合成检验乙 7 U/L';
    for (const output of [f.original, f.corrected]) output.candidates[0]!.evidence = [
      { sourceSpanId: 'synthetic-span', quote: '合成检验甲 <2.50E+02 U/L' }
    ];
    f.corrected.candidates[0]!.value = { kind: 'numeric', rawText: '<2.50E+02', decimal: '250', comparator: 'lt' };
    const { result } = await run(f);
    expect(result).toMatchObject({ status: 'published', candidateCount: 2 });
    expect(f.publishFacts.mock.calls[0]![0].observations[0]).toMatchObject({ rawText: '<2.50E+02', decimalValue: '250', qualifier: 'lt', unit: 'U/L' });
  });

  it('可定位疑点先独立区域重读一次，辅助依据不增加检查页或必覆盖项', async () => {
    const f = fixture();
    const root = mkdtempSync(join(tmpdir(), 'synthetic-extraction-region-'));
    f.bundle.sourcePath = join(root, 'synthetic-image.png');
    writeFileSync(f.bundle.sourcePath, Buffer.from('pure synthetic source; mocked recognizer'));
    f.bundle.manifest.mediaType = 'image/png';
    f.bundle.manifest.normalizerVersion = 'image-v1+local-visual-evidence-v1+local-visual-layout-v2+local-visual-geometry-v1';
    const originalSpan = f.bundle.manifest.spans[0]!;
    originalSpan.spanKind = 'image';
    originalSpan.visualEvidence = { version: 1, engine: 'apple-vision-local-v1', layoutVersion: 'local-visual-layout-v2',
      coordinateSystem: 'normalized-bottom-left', reading: { mode: 'full_image', fallbackUsed: false }, omittedBoxes: [], rows: [
        { line: 1, text: '合成检验甲 9 U/L', bounds: [0.1, 0.7, 0.7, 0.05], boxes: [{ text: '合成检验甲 9 U/L', confidence: 0.99, bounds: [0.1, 0.7, 0.7, 0.05] }] },
        { line: 2, text: '合成检验乙 7 U/L', bounds: [0.1, 0.5, 0.7, 0.05], boxes: [{ text: '合成检验乙 7 U/L', confidence: 0.99, bounds: [0.1, 0.5, 0.7, 0.05] }] }
      ] };
    const reread = vi.spyOn(sourceNormalization, 'rereadStoredSourceRegion').mockImplementation(async (input) => ({
      readSpanId: 'synthetic-region', diagnostic: { code: 'LOCAL_VISUAL_REGION_READ', attempts: 1 },
      manifest: { ...input.manifest, normalizerVersion: `${input.manifest.normalizerVersion}+local-visual-region-v1`,
        spans: [...input.manifest.spans, { ...originalSpan, id: 'synthetic-region', blockId: 'local-vision-region:synthetic-span',
          quote: '合成检验甲 9 U/L', lineStart: 1, lineEnd: 1, visualEvidence: { ...originalSpan.visualEvidence!,
            reading: { mode: 'region', regionBounds: [0.09, 0.69, 0.72, 0.08], fallbackUsed: false }, rows: [originalSpan.visualEvidence!.rows[0]!] } }] }
    }));
    const append = vi.fn((manifest: DocumentExtractionBundle['manifest']) => { f.bundle.manifest = manifest; });
    Object.assign(f.store, { appendLocalVisualEvidenceForReprocessing: append });
    try {
      const { result } = await run(f, (patch) => {
        const entry = patch.results[0]!;
        if (entry.nodeType === 'candidate' && entry.decision.verdict === 'replace') {
          entry.decision.replacement.evidence = [{ sourceSpanId: 'synthetic-region', quote: '合成检验甲 9 U/L' }];
        }
        return patch;
      });
      expect(result).toMatchObject({ status: 'published', candidateCount: 2 });
      expect(reread).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sourceSpanId: 'synthetic-span', lineStart: 1, lineEnd: 1 }));
      expect(append).toHaveBeenCalledOnce();
      expect(f.bundle.manifest.totalUnits).toBe(1);
      expect(f.bundle.manifest.coveredUnitIndexes).toEqual([0]);
      expect(f.bundle.manifest.spans[0]).toBe(originalSpan);
      expect(f.publishFacts.mock.calls[0]![0].observations[0]!.sourceSpanId).toBe('synthetic-region');
    } finally {
      reread.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('输出分组始终读取全报告原文，后页可引用首页身份和检查日但不复制其他页结果', async () => {
    const f = fixture();
    f.bundle.manifest.spans = Array.from({ length: 42 }, (_, index): SourceSpan => ({ id: `span-${index + 1}`,
      documentId: f.bundle.documentId, spanKind: 'line', page: index + 1, blockId: null,
      lineStart: index + 1, lineEnd: index + 1, quote: index === 0 ? '姓名：合成成员 检查日期：2026-01-02'
        : index === 41 ? '合成检验甲 9 U/L' : '合成栏目空栏', readability: 'clear' }));
    f.bundle.manifest.totalUnits = 42;
    f.bundle.manifest.coveredUnitIndexes = Array.from({ length: 42 }, (_, index) => index);
    const reportMetadata: NonNullable<ExtractionResult['reportMetadata']> = { reportKind: null, title: null,
      organization: null, campus: null, department: null, reportNumber: null, examItems: [], times: [
        { value: '2026-01-02', precision: 'day', role: 'examined', evidence: [{ sourceSpanId: 'span-1', quote: '检查日期：2026-01-02' }] }
      ] };
    const runtime = { runStructuredTurn: vi.fn(async (input: { prompt: string }) => {
      const pack = JSON.parse(input.prompt.split('SOURCE_PACKAGE=')[1]!) as {
        targetSourceSpanIds: string[]; spans: Array<{ sourceSpanId: string }>; contextMode: string;
      };
      expect(pack.spans).toHaveLength(42);
      expect(pack.contextMode).toBe('whole_document_text');
      const candidate = { ...f.corrected.candidates[0]!, clinicalDate: '2026-01-02',
        evidence: [{ sourceSpanId: 'span-42', quote: '合成检验甲 9 U/L' }, { sourceSpanId: 'span-1', quote: '检查日期：2026-01-02' }] };
      return { threadId: 'synthetic-thread', turnId: `synthetic-${pack.targetSourceSpanIds[0]}`, output: {
        ...f.original, subject: { reportedName: '合成成员', confidence: 'explicit', evidence: [{ sourceSpanId: 'span-1', quote: '姓名：合成成员' }] },
        reportMetadata, coveredSourceSpanIds: pack.targetSourceSpanIds,
        candidates: pack.targetSourceSpanIds.includes('span-42') ? [candidate] : [] } };
    }) };
    const result = await new DocumentExtractionPipeline(f.store, runtime).process(f.bundle.documentId);
    expect(result).toMatchObject({ status: 'published', candidateCount: 1 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
    expect(f.publishFacts.mock.calls[0]![0].observations[0]!.clinicalDate).toBe('2026-01-02');
  });
});
