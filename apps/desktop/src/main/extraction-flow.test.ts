import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ExtractionResult, ObservationCandidate, SourceSpan } from '@contracts';
import type { DocumentExtractionBundle, JobExecutionGuard, WorkspaceStore } from '@storage';
import { DocumentExtractionPipeline } from './processing-pipeline.js';
import { syntheticExtractionRepair } from './extraction-repair.fixture.js';
import { createSyntheticTwoPageScannedPdf } from '../../../../packages/evaluation/src/scanned-pdf-fixture.js';

// 这些用例验证真实流水线的合并与接纳分支；只替换持久化端，不依赖 SQLite ABI。
function fixture(quotes: Array<string | null>, options: { image?: boolean; aliases?: string[];
  assignmentBasis?: DocumentExtractionBundle['personAssignmentBasis'] } = {}) {
  const spans: SourceSpan[] = quotes.map((quote, index) => ({
    id: `source-${index + 1}`, documentId: 'synthetic-document',
    spanKind: options.image ? 'image' : 'line', page: index + 1,
    blockId: null, lineStart: index + 1, lineEnd: index + 1,
    quote, readability: quote ? 'clear' : 'partial'
  }));
  const bundle: DocumentExtractionBundle = {
    documentId: 'synthetic-document', personId: 'synthetic-member', personDisplayName: '合成成员',
    personAssignmentBasis: options.assignmentBasis ?? 'user_selected', confirmedReportedName: null,
    confirmedPersonAliases: options.aliases ?? [], sourcePath: '/tmp/synthetic-evidence.png',
    manifest: {
      id: 'synthetic-manifest', sourceObjectId: 'synthetic-source', sha256: 'a'.repeat(64),
      mediaType: options.image ? 'image/png' : 'text/plain', originalDisplayName: '纯合成资料',
      totalUnits: spans.length, coveredUnitIndexes: spans.map((_, index) => index), spans,
      normalizerVersion: options.image ? 'image-evidence-v1+local-visual-evidence-v1+local-visual-layout-v2+local-visual-geometry-v1' : 'txt-v2',
      conversionWarnings: [], createdAt: '2026-10-13T00:00:00Z'
    }
  };
  const published: Array<Parameters<WorkspaceStore['publishFacts']>[0]> = [];
  const issues: Array<Parameters<WorkspaceStore['saveExtractionReviewIssue']>[0]> = [];
  const store = {
    isDocumentCommitted: () => false,
    getDocumentExtractionBundle: () => bundle,
    getFactRevision: () => 0,
    saveAcceptanceDecision: () => 'synthetic-acceptance',
    publishFacts: (input: Parameters<WorkspaceStore['publishFacts']>[0]) => {
      published.push(input);
      return { revision: 1, duplicateCount: 0, heldCount: 0, reviewIssueId: input.unresolvedReview ? 'synthetic-issue' : null };
    },
    saveExtractionReviewIssue: (input: Parameters<WorkspaceStore['saveExtractionReviewIssue']>[0]) => { issues.push(input); return 'synthetic-issue'; }
  } as unknown as WorkspaceStore;
  const candidate = (overrides: Partial<ObservationCandidate> = {}): ObservationCandidate => ({
    localKey: 'height', originalName: '身高', standardNameCandidate: null,
    value: { kind: 'numeric', rawText: '187', decimal: '187', comparator: 'eq' },
    unitRaw: '厘米', referenceRangeRaw: null, reportedAbnormalFlag: null,
    specimen: null, method: null, bodySite: null, clinicalDate: null,
    evidence: [{ sourceSpanId: spans.at(-1)!.id, quote: '身高 187 厘米' }], issues: [], ...overrides
  });
  const output = (candidates: ObservationCandidate[], overrides: Partial<ExtractionResult> = {}): ExtractionResult => ({
    schemaVersion: 1, documentId: bundle.documentId,
    subject: { reportedName: null, evidence: [], confidence: 'absent' },
    coveredSourceSpanIds: spans.map((span) => span.id), candidates, ...overrides
  });
  const reportMetadata = (examined: string, issued?: string): NonNullable<ExtractionResult['reportMetadata']> => ({
    reportKind: null, title: null, organization: null, campus: null, department: null,
    reportNumber: null, examItems: [], times: [
      { value: examined, precision: 'day', role: 'examined', evidence: [{ sourceSpanId: spans[0]!.id, quote: `检查日期：${examined}` }] },
      ...(issued ? [{ value: issued, precision: 'day' as const, role: 'report_issued' as const,
        evidence: [{ sourceSpanId: spans[0]!.id, quote: `报告日期：${issued}` }] }] : [])
    ]
  });
  return { bundle, store, published, issues, candidate, output, reportMetadata };
}

async function process(f: ReturnType<typeof fixture>, outputs: ExtractionResult[]) {
  let index = 0;
  const runtime = { runStructuredTurn: vi.fn(async (input: Parameters<ConstructorParameters<typeof DocumentExtractionPipeline>[1]['runStructuredTurn']>[0]) => {
    const output = outputs[Math.min(index++, outputs.length - 1)]!;
    return { threadId: 'synthetic-thread', turnId: `synthetic-turn-${index}`,
      output: input.prompt.includes('REPAIR_REQUEST=') ? syntheticExtractionRepair(input.prompt, outputs[0]!, output) : output };
  }) };
  const result = await new DocumentExtractionPipeline(f.store, runtime).process(f.bundle.documentId);
  return { result, runtime };
}

function withGuardCache(f: ReturnType<typeof fixture>) {
  const guard: JobExecutionGuard = { jobId: 'synthetic-job', attemptId: 'synthetic-attempt',
    consentId: 'synthetic-consent', accountFingerprint: 'synthetic-account' };
  const checkpoints = new Map<string, NonNullable<ReturnType<WorkspaceStore['getExtractionChunkCheckpoint']>>>();
  const save = vi.fn((input: Parameters<WorkspaceStore['saveExtractionChunkCheckpoint']>[0]) => {
    checkpoints.set(input.signature, { output: input.output, threadId: input.threadId,
      turnId: input.turnId, extractionTurnId: input.extractionTurnId });
  });
  Object.assign(f.store, {
    assertJobExecutionActive: vi.fn(), beginAiTransmission: vi.fn(() => 'synthetic-transmission'),
    finishAiTransmission: vi.fn(), saveExtractionChunkCheckpoint: save,
    getExtractionChunkCheckpoint: (_guard: JobExecutionGuard, _documentId: string, signature: string) => checkpoints.get(signature) ?? null,
    clearExtractionChunkCheckpoints: () => checkpoints.clear()
  });
  return { guard, checkpoints, save };
}

describe('报告提取流程闭环', () => {
  it('同任务附加独立区域不使primary检查点失效，恢复仍不重读已完成内容', async () => {
    const f = fixture(['身高 187 厘米']);
    const cached = withGuardCache(f);
    const output = f.output([f.candidate()]);
    const runtime = { runStructuredTurn: vi.fn(async () => ({ threadId: 'synthetic-thread', turnId: 'synthetic-turn', output })) };
    const pipeline = new DocumentExtractionPipeline(f.store, runtime, cached.guard);
    let publicationAttempts = 0;
    Object.assign(f.store, { publishFacts: (input: Parameters<WorkspaceStore['publishFacts']>[0]) => {
      if (++publicationAttempts === 1) throw new Error('SYNTHETIC_PUBLICATION_INTERRUPTED');
      f.published.push(input);
      return { revision: 1, duplicateCount: 0, heldCount: 0, reviewIssueId: null };
    } });
    await expect(pipeline.process(f.bundle.documentId)).rejects.toThrow('SYNTHETIC_PUBLICATION_INTERRUPTED');
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(1);
    expect(cached.checkpoints.size).toBe(1);
    f.bundle.manifest = { ...f.bundle.manifest, id: 'changed-view-only',
      normalizerVersion: `${f.bundle.manifest.normalizerVersion}+local-visual-region-v1`,
      spans: [...f.bundle.manifest.spans, { ...f.bundle.manifest.spans[0]!, id: 'synthetic-region',
        blockId: 'local-vision-region:source-1', quote: '身高 187 厘米', spanKind: 'image' }] };
    expect((await pipeline.process(f.bundle.documentId)).status).toBe('published');
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(1);
    expect(f.published.at(-1)!.observations[0]!.sourceSpanId).toBe('source-1');
  });

  it('后页继承检查日，不被另一年的签发日误阻断', async () => {
    const f = fixture(['检查日期：2023-10-08 报告日期：2024-02-01', '身高 187 厘米']);
    const extraction = f.output([f.candidate()], { reportMetadata: f.reportMetadata('2023-10-08', '2024-02-01') });
    const { result, runtime } = await process(f, [extraction]);
    expect(result.status).toBe('published');
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(1);
    expect(f.published[0]!.observations[0]!.clinicalDate).toBe('2023-10-08');
    expect(f.published[0]!.observations[0]!.evidence).toContainEqual({ sourceSpanId: 'source-1', quote: '检查日期：2023-10-08' });
  });

  it('另有真实检查日时仍不把首页检查日套到全部结果', async () => {
    const f = fixture(['检查日期：2026-01-10 报告日期：2026-01-12', '复查日期：2026-01-12', '身高 187 厘米']);
    await process(f, [f.output([f.candidate()], { reportMetadata: f.reportMetadata('2026-01-10', '2026-01-12') })]);
    expect(f.published[0]!.observations[0]!.clinicalDate).toBeNull();
  });

  it.each(['视力：未填写', '视力：'])('局部修复可去掉可证明空白的目标，不留下假待确认：%s', async (blank) => {
    const f = fixture([blank, '身高 187 厘米']);
    const empty = f.candidate({ localKey: 'vision-blank', originalName: '视力',
      value: { kind: 'unknown', rawText: null, reason: '原报告结果栏为空白' }, unitRaw: null,
      evidence: [{ sourceSpanId: 'source-1', quote: blank }] });
    const { result, runtime } = await process(f, [f.output([f.candidate(), empty]), f.output([f.candidate()])]);
    expect(result).toMatchObject({ status: 'published', candidateCount: 1 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
    expect(f.published[0]!.unresolvedReview).toBeUndefined();
  });

  it('不能删除有值候选来假装修复成功，零接纳保留具体原因', async () => {
    const f = fixture(['身高 187 厘米']);
    const bad = f.candidate({ value: { kind: 'numeric', rawText: '999', decimal: '999', comparator: 'eq' } });
    const { result } = await process(f, [f.output([bad]), f.output([])]);
    expect(result).toMatchObject({ status: 'partial', reason: 'NO_ACCEPTABLE_FACTS' });
    expect(f.published).toEqual([]);
    expect(f.issues[0]!.reasonCodes).toEqual(expect.arrayContaining(['NO_ACCEPTABLE_FACTS', 'numeric_value_not_in_evidence']));
    expect(f.issues[0]!.documentRun).toMatchObject({ coverageComplete: true, chunkCount: 1 });
  });

  it('成员已确认的别名在新的资料里正常接纳，不需逐文件确认', async () => {
    const f = fixture(['姓名：合成昵称', '身高 187 厘米'], { aliases: ['合成昵称'] });
    const { result, runtime } = await process(f, [f.output([f.candidate()], {
      subject: { reportedName: '合成昵称', confidence: 'explicit', evidence: [{ sourceSpanId: 'source-1', quote: '姓名：合成昵称' }] }
    })]);
    expect(result.status).toBe('published');
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(1);
  });

  it('目录自动归属的资料身份确认后复用已读报告，仍做字段修复而不重复整份 P01', async () => {
    const f = fixture(['姓名：合成昵称', '身高 187 厘米'], { assignmentBasis: 'folder_binding' });
    const { guard, checkpoints, save } = withGuardCache(f);
    const subject: ExtractionResult['subject'] = { reportedName: '合成昵称', confidence: 'explicit',
      evidence: [{ sourceSpanId: 'source-1', quote: '姓名：合成昵称' }] };
    const bad = f.candidate({ value: { kind: 'numeric', rawText: '999', decimal: '999', comparator: 'eq' } });
    let turn = 0;
    const runtime = { runStructuredTurn: vi.fn(async (input: Parameters<ConstructorParameters<typeof DocumentExtractionPipeline>[1]['runStructuredTurn']>[0]) => {
      turn += 1;
      // 修复沿用应用生成的候选 key；其余字段和身份来源不变。
      const output = turn === 1 ? f.output([bad], { subject })
        : syntheticExtractionRepair(input.prompt, f.output([bad], { subject }), f.output([f.candidate()], { subject }));
      return { threadId: 'synthetic-thread', turnId: `synthetic-turn-${turn}`, output };
    }) };
    const pipeline = new DocumentExtractionPipeline(f.store, runtime, guard);
    expect(await pipeline.process(f.bundle.documentId)).toMatchObject({ status: 'needs_review', reason: 'PERSON_IDENTITY_NOT_CONFIRMED' });
    expect(save).toHaveBeenCalledOnce();
    expect(f.published).toEqual([]);
    // 未确认的重试不得把缓存的数值当成事实，也不额外发送整份报告。
    expect(await pipeline.process(f.bundle.documentId)).toMatchObject({ status: 'needs_review', reason: 'PERSON_IDENTITY_NOT_CONFIRMED' });
    expect(runtime.runStructuredTurn).toHaveBeenCalledOnce();
    f.bundle.confirmedPersonAliases.push('合成昵称');
    expect(await pipeline.process(f.bundle.documentId)).toMatchObject({ status: 'published', candidateCount: 1 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
    expect(runtime.runStructuredTurn.mock.calls[1]![0].prompt).toContain('numeric_value_not_in_evidence');
    expect(f.published[0]!.observations[0]!.decimalValue).toBe('187');
    expect(checkpoints.size).toBe(0);
  });

  it.each(['视力：未填写', '视力：'])('只有可证明空白的结果也能完成，保留空白而不生成假事实：%s', async (blank) => {
    const f = fixture([blank]);
    const empty = f.candidate({ originalName: '视力', unitRaw: null,
      value: { kind: 'unknown', rawText: null, reason: '原报告结果栏为空白' },
      evidence: [{ sourceSpanId: 'source-1', quote: blank }] });
    const { result } = await process(f, [f.output([empty]), f.output([])]);
    expect(result).toMatchObject({ status: 'published', candidateCount: 0 });
    expect(f.published[0]!.observations).toEqual([]);
    expect(f.published[0]!.unresolvedReview).toBeUndefined();
    expect(f.issues).toEqual([]);
  });

  it('模型返回空列表不能把有结果或 OCR 未读到冒充全空白', async () => {
    const visible = fixture(['身高 187 厘米']);
    expect((await process(visible, [visible.output([])])).result).toMatchObject({ status: 'partial', reason: 'NO_ACCEPTABLE_FACTS' });
    expect(visible.published).toEqual([]);
    const visual = fixture(['视力：未填写'], { image: true });
    expect((await process(visual, [visual.output([])])).result).toMatchObject({ status: 'partial', reason: 'NO_ACCEPTABLE_FACTS' });
    expect(visual.published).toEqual([]);
  });

  it('图片已有独立文字依据仍附原图，错误日期触发一次局部修复', async () => {
    const f = fixture(['检查日期：2026-07-02 身高 187 厘米'], { image: true });
    const bad = f.candidate({ clinicalDate: '2023-02-02', evidence: [{ sourceSpanId: 'source-1', quote: '检查日期：2026-07-02 身高 187 厘米' }] });
    const correct = { ...bad, clinicalDate: '2026-07-02' };
    const { result, runtime } = await process(f, [f.output([bad]), f.output([correct])]);
    expect(result.status).toBe('published');
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
    expect(runtime.runStructuredTurn.mock.calls.every(([input]) => input.imagePaths?.length === 1)).toBe(true);
    expect(f.published[0]!.observations[0]!.clinicalDate).toBe('2026-07-02');
  });

  it('图片原医生安排保留完整可核验原句与原页，不仅保存结果正文', async () => {
    const source = '检查日期：2026-07-02 医生建议：如有不适请到门诊复诊，建议一年后复查肠镜。';
    const f = fixture([source], { image: true });
    const plan = f.candidate({ originalName: '医生建议', value: { kind: 'text', rawText: '如有不适请到门诊复诊，建议一年后复查肠镜。' },
      unitRaw: null, clinicalDate: '2026-07-02', evidence: [{ sourceSpanId: 'source-1', quote: source }] });
    const { result } = await process(f, [f.output([plan])]);
    expect(result.status).toBe('published');
    expect(f.published[0]!.observations[0]!.evidence).toEqual([{ sourceSpanId: 'source-1', quote: source }]);
  });

  it('图片页脚实际日期无标签仍可接纳，不允许错误元数据时间进入时间线', async () => {
    const source = '身高 187 厘米\n2026年7月2日';
    const f = fixture([source], { image: true });
    const correctCandidate = f.candidate({ clinicalDate: '2026-07-02', evidence: [{ sourceSpanId: 'source-1', quote: source }] });
    const reportMetadata = { ...f.reportMetadata('2026-07-02'), times: [
      { value: '2023-02-02', precision: 'day' as const, role: 'examined' as const,
        evidence: [{ sourceSpanId: 'source-1', quote: source }] }
    ] };
    const bad = f.output([correctCandidate], { reportMetadata });
    const good = f.output([correctCandidate], { reportMetadata: { ...reportMetadata, times: [
      { ...reportMetadata.times[0]!, value: '2026-07-02' }
    ] } });
    const { result, runtime } = await process(f, [bad, good]);
    expect(result.status).toBe('published');
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
    expect(runtime.runStructuredTurn.mock.calls[1]![0].prompt).toContain('reportMetadata.times[0]');
    expect(f.published[0]!.reportMetadata!.times[0]!.value).toBe('2026-07-02');
    expect(f.published[0]!.unresolvedReview).toBeUndefined();
  });

  it('元数据日期补救失败时隔离错误时间，仍保存日期正确的其他结果', async () => {
    const source = '检查日期：2026-07-02 身高 187 厘米';
    const f = fixture([source], { image: true });
    const reportMetadata = { ...f.reportMetadata('2026-07-02'), times: [
      { value: '2023-02-02', precision: 'day' as const, role: 'examined' as const,
        evidence: [{ sourceSpanId: 'source-1', quote: source }] }
    ] };
    const bad = f.output([f.candidate({ clinicalDate: '2026-07-02', evidence: [{ sourceSpanId: 'source-1', quote: source }] })], { reportMetadata });
    expect((await process(f, [bad])).result.status).toBe('partial');
    expect(f.published[0]!.observations[0]!.clinicalDate).toBe('2026-07-02');
    expect(f.published[0]!.reportMetadata!.times).toEqual([]);
    expect(f.published[0]!.unresolvedReview!.reasonCodes).toContain('metadata_date_not_in_evidence');
  });

  it.each(['报告日期：2026-07-02', '报 告 日 期 ： 2026-07-02'])('签发时间不能因日期值在报告中存在而冒充检查时间：%s', async (dateSource) => {
    const f = fixture([dateSource, '身高 187 厘米']);
    const reportMetadata = { ...f.reportMetadata('2026-07-02'), times: [
      { value: '2026-07-02', precision: 'day' as const, role: 'examined' as const,
        evidence: [{ sourceSpanId: 'source-1', quote: dateSource }] }
    ] };
    await process(f, [f.output([f.candidate()], { reportMetadata })]);
    expect(f.published[0]!.observations[0]!.clinicalDate).toBeNull();
    expect(f.published[0]!.reportMetadata!.times).toEqual([]);
    expect(f.published[0]!.unresolvedReview!.reasonCodes).toContain('metadata_date_role_mismatch');
  });

  it('可读 PDF 发生具体单位绑定问题时，同次 P03 补原页图且保留全部文字', async () => {
    const root = mkdtempSync(join(tmpdir(), 'synthetic-local-pdf-repair-'));
    try {
      const source = '检查日期：2025-06-10 低密度脂蛋白胆固醇 LDL-C：4.2 mmol/L';
      const f = fixture([source]);
      f.bundle.manifest.mediaType = 'application/pdf';
      f.bundle.manifest.normalizerVersion = 'pdfjs-5.4-text-v1';
      f.bundle.manifest.spans[0]!.spanKind = 'page';
      f.bundle.sourcePath = join(root, 'pure-synthetic.pdf');
      writeFileSync(f.bundle.sourcePath, createSyntheticTwoPageScannedPdf());
      const bad = f.candidate({ originalName: '低密度脂蛋白胆固醇 LDL-C', value: { kind: 'numeric', rawText: '4.2', decimal: '4.2', comparator: 'eq' },
        unitRaw: 'mg/L', clinicalDate: '2025-06-10', evidence: [{ sourceSpanId: 'source-1', quote: source }] });
      const { result, runtime } = await process(f, [f.output([bad]), f.output([{ ...bad, unitRaw: 'mmol/L' }])]);
      expect(result.status).toBe('published');
      expect(runtime.runStructuredTurn.mock.calls[0]![0].imagePaths).toEqual([]);
      expect(runtime.runStructuredTurn.mock.calls[1]![0].imagePaths).toHaveLength(1);
      expect(runtime.runStructuredTurn.mock.calls[1]![0].prompt).toContain(source);
      expect(f.published[0]!.observations[0]!.unit).toBe('mmol/L');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
