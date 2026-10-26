import { describe, expect, it, vi } from 'vitest';
import type { ExtractionResult, ObservationCandidate, SourceManifest } from '@contracts';
import type { DocumentExtractionBundle, WorkspaceStore } from '@storage';
import { DocumentExtractionPipeline } from './processing-pipeline.js';

// 完全脱敏的流程用例：核验实际管道，数据库事务的来源对账另有存储集成测试。
function fixture(committed = false) {
  const manifest: SourceManifest = {
    id: 'synthetic-manifest', sourceObjectId: 'synthetic-source', sha256: 'a'.repeat(64),
    mediaType: 'text/plain', originalDisplayName: '合成报告', totalUnits: 2, coveredUnitIndexes: [0, 1],
    normalizerVersion: 'txt-synthetic', conversionWarnings: [], createdAt: '2026-01-01T00:00:00Z',
    spans: [
      { id: 'heading-span', documentId: 'synthetic-document', spanKind: 'line', page: 1,
        blockId: null, lineStart: 1, lineEnd: 1, quote: '超声检查 检查所见', readability: 'clear' },
      { id: 'finding-span', documentId: 'synthetic-document', spanKind: 'line', page: 2,
        blockId: null, lineStart: 2, lineEnd: 2, quote: '形态饱满，血流丰富。', readability: 'clear' }
    ]
  };
  const bundle: DocumentExtractionBundle = {
    documentId: 'synthetic-document', personId: 'synthetic-member', personDisplayName: '合成成员',
    personAssignmentBasis: 'user_selected', confirmedReportedName: null, confirmedPersonAliases: [],
    sourcePath: '/tmp/synthetic-general-report.txt', manifest
  };
  const issue = { id: 'synthetic-review', documentId: bundle.documentId, severity: 'warning', stage: 'extract',
    kind: 'field_conflict', candidateOptions: [] as ObservationCandidate[], evidenceRefs: [], reasonCodes: [] };
  const publishFacts = vi.fn((input: Parameters<WorkspaceStore['publishFacts']>[0]) => ({ revision: 1,
    heldCount: 0, duplicateCount: 0, reviewIssueId: input.unresolvedReview ? 'synthetic-review' : null }));
  const appendCommittedFacts = vi.fn((input: Parameters<WorkspaceStore['appendCommittedFacts']>[0]) => ({
    revision: 2, appendedCount: 2, updatedCount: 0, duplicateCount: 0, heldCount: 0,
    heldCandidates: [] as ObservationCandidate[], heldReasonCodes: [] as string[],
    reviewResolved: input.reviewUpdate.remainingCandidates.length === 0 && input.reviewUpdate.remainingReasonCodes.length === 0 }));
  const store = {
    isDocumentCommitted: () => committed, getDocumentExtractionBundle: () => bundle,
    listOpenExtractionReviewIssues: () => [issue], getFactRevision: () => 1,
    saveAcceptanceDecision: () => 'synthetic-acceptance', publishFacts, appendCommittedFacts,
    saveExtractionReviewIssue: vi.fn(() => 'synthetic-review'),
    isSameSourceLocationInDocument: (left: string, right: string) => left === right
  } as unknown as WorkspaceStore;
  const candidate = (rawText: string, localKey: string): ObservationCandidate => {
    const heading = { sourceSpanId: 'heading-span', quote: '检查所见' };
    const finding = { sourceSpanId: 'finding-span', quote: rawText };
    return { localKey, originalName: '检查所见', standardNameCandidate: null,
      value: { kind: 'text', rawText }, unitRaw: null, referenceRangeRaw: null, reportedAbnormalFlag: null,
      specimen: null, method: null, bodySite: null, clinicalDate: null, issues: [],
      evidence: [heading, finding], sourceBinding: { headingEvidence: [heading], findingEvidence: [finding] } };
  };
  const output = (candidates: ObservationCandidate[]): ExtractionResult => ({ schemaVersion: 1,
    documentId: bundle.documentId, subject: { reportedName: null, evidence: [], confidence: 'absent' },
    coveredSourceSpanIds: manifest.spans.map((span) => span.id), candidates });
  return { store, bundle, issue, candidate, output, publishFacts, appendCommittedFacts };
}

function runtime(outputs: ExtractionResult[]) {
  let calls = 0;
  return { runStructuredTurn: vi.fn(async (_input: { prompt: string; allowWebSearch?: boolean }) => ({
    threadId: 'synthetic-thread', turnId: `synthetic-turn-${calls}`, output: outputs[Math.min(calls++, outputs.length - 1)]
  })) };
}

describe('通用报告对账与疑点局部隔离', () => {
  it('同栏目旧缺口与新发现不同，不能仅因唯一栏目名而把漏提的旧发现结清', async () => {
    const f = fixture(true);
    const old = f.candidate('血流丰富', 'old-flow');
    f.issue.candidateOptions = [old];
    const r = runtime([f.output([f.candidate('形态饱满', 'shape')])]);
    await expect(new DocumentExtractionPipeline(f.store, r).process(f.bundle.documentId)).resolves.toMatchObject({
      status: 'partial', requiresUser: false, reason: 'REPORT_CONTENT_HELD'
    });
    const append = f.appendCommittedFacts.mock.calls[0]![0];
    expect(append.reviewUpdate.remainingCandidates).toContainEqual(old);
    expect(append.reviewUpdate.remainingReasonCodes).toContain('PREVIOUS_CANDIDATE_NOT_VERIFIED');
    expect(r.runStructuredTurn).toHaveBeenCalledTimes(1);
  });

  it('旧未绑定的粗引用也不能用同栏目名结清，具体证据仍不明确时保留原缺口', async () => {
    const f = fixture(true);
    const old: ObservationCandidate = { ...f.candidate('无法读清的所见', 'old-unbound'),
      sourceBinding: undefined,
      evidence: [{ sourceSpanId: 'heading-span', quote: '检查所见' }] };
    f.issue.candidateOptions = [old];
    const r = runtime([f.output([f.candidate('形态饱满', 'shape')])]);
    await expect(new DocumentExtractionPipeline(f.store, r).process(f.bundle.documentId)).resolves.toMatchObject({
      status: 'partial', requiresUser: false
    });
    expect(f.appendCommittedFacts.mock.calls[0]![0].reviewUpdate.remainingCandidates).toContainEqual(old);
  });

  it('同一具体发现已唯一补齐时，模型临时键改变不阻碍结清旧缺口', async () => {
    const f = fixture(true);
    f.issue.candidateOptions = [f.candidate('血流丰富', 'old-flow')];
    const r = runtime([f.output([f.candidate('形态饱满', 'shape'), f.candidate('血流丰富', 'new-flow')])]);
    await expect(new DocumentExtractionPipeline(f.store, r).process(f.bundle.documentId)).resolves.toMatchObject({
      status: 'published', candidateCount: 2
    });
    expect(f.appendCommittedFacts.mock.calls[0]![0].reviewUpdate.remainingCandidates).toEqual([]);
    expect(f.appendCommittedFacts.mock.calls[0]![0].reviewUpdate.remainingReasonCodes).toEqual([]);
  });
  it('同栏目、同页、日期缺失的不同真实发现全部交给来源槽位对账，不按名称预筛成冲突', async () => {
    const f = fixture(true);
    const r = runtime([f.output([f.candidate('形态饱满', 'one'), f.candidate('血流丰富', 'two')])]);
    const result = await new DocumentExtractionPipeline(f.store, r).process(f.bundle.documentId);
    expect(result).toMatchObject({ status: 'published', candidateCount: 2 });
    expect(r.runStructuredTurn).toHaveBeenCalledTimes(1);
    const append = f.appendCommittedFacts.mock.calls[0] as unknown as [Parameters<WorkspaceStore['appendCommittedFacts']>[0]];
    expect(append[0].observations).toHaveLength(2);
    expect(append[0].observations.map((observation) => observation.candidate?.value.rawText)).toEqual(['形态饱满', '血流丰富']);
    expect(append[0].observations.every((observation) => observation.sourceBinding?.findingEvidence.length === 1)).toBe(true);
  });

  it('普通内容冲突返回 partial 并保留可靠成果，不把来源冲突抛成整批技术失败', async () => {
    const f = fixture(true);
    f.appendCommittedFacts.mockReturnValue({ revision: 2, appendedCount: 1, updatedCount: 0,
      duplicateCount: 0, heldCount: 1, heldCandidates: [], heldReasonCodes: ['source_content_conflict'], reviewResolved: false });
    const r = runtime([f.output([f.candidate('形态饱满', 'one'), f.candidate('血流丰富', 'two')])]);
    await expect(new DocumentExtractionPipeline(f.store, r).process(f.bundle.documentId)).resolves.toMatchObject({
      status: 'partial', candidateCount: 1, issueId: 'synthetic-review', requiresUser: false
    });
  });

  it('只有具体疑点才请求一次修复，完整来源仍给模型，不把无关候选允许改写', async () => {
    const f = fixture();
    const good = f.candidate('形态饱满', 'one');
    const bad = f.candidate('血流消失', 'two');
    const r = runtime([f.output([good, bad]), f.output([good, bad])]);
    await expect(new DocumentExtractionPipeline(f.store, r).process(f.bundle.documentId)).resolves.toMatchObject({
      status: 'partial', candidateCount: 1, requiresUser: false
    });
    expect(r.runStructuredTurn).toHaveBeenCalledTimes(2);
    const repairPrompt = r.runStructuredTurn.mock.calls[1]![0].prompt;
    expect(repairPrompt).toContain('heading-span');
    expect(repairPrompt).toContain('finding-span');
    const request = JSON.parse(repairPrompt.split('REPAIR_REQUEST=')[1]!.split('\n')[0]!) as { targets: string[]; maxRepairAttempts: number };
    expect(request.maxRepairAttempts).toBe(1);
    expect(request.targets).toHaveLength(1);
    expect(r.runStructuredTurn.mock.calls.every(([input]) => input.allowWebSearch === false)).toBe(true);
  });

  it('全部未读清只留下明确 partial 内容缺口，不要求用户猜一个医学结果', async () => {
    const f = fixture();
    const bad = f.candidate('血流消失', 'two');
    const r = runtime([f.output([bad]), f.output([bad])]);
    await expect(new DocumentExtractionPipeline(f.store, r).process(f.bundle.documentId)).resolves.toMatchObject({
      status: 'partial', candidateCount: 0, reason: 'NO_ACCEPTABLE_FACTS', requiresUser: false
    });
    expect(f.publishFacts).not.toHaveBeenCalled();
    expect(r.runStructuredTurn).toHaveBeenCalledTimes(2);
  });

  it('未知数据库故障不能被当作普通内容疑点吞掉', async () => {
    const f = fixture(true);
    f.appendCommittedFacts.mockImplementation(() => { throw new Error('SQLITE_IOERR_SYNTHETIC'); });
    const r = runtime([f.output([f.candidate('形态饱满', 'one')])]);
    await expect(new DocumentExtractionPipeline(f.store, r).process(f.bundle.documentId)).rejects.toThrow('SQLITE_IOERR_SYNTHETIC');
  });
});
