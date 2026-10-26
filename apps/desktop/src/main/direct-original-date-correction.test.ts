import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DirectOriginalDateReading, SourceManifest, SourceSpan } from '@contracts';
import type { PreparedOriginalModelInput } from '@ingestion';
import { WorkspaceStore } from '@storage';
import { DirectOriginalDateCorrectionPipeline } from './direct-original-date-correction.js';

const resources: Array<{ root: string; store: WorkspaceStore }> = [];
afterEach(() => { for (const item of resources.splice(0)) { item.store.close(); rmSync(item.root, { recursive: true, force: true }); } });
function fixture(assignmentBasis: 'user_selected' | 'folder_binding' = 'user_selected') {
  const root = mkdtempSync(join(tmpdir(), 'date-blind-main-synthetic-')); const store = new WorkspaceStore({ rootDirectory: root });
  resources.push({ root, store }); const db = (store as unknown as { db: Database.Database }).db;
  const person = store.createPerson({ displayName: '合成盲读成员' });
  const source = store.putSourceObject({ bytes: Buffer.from('合成完整原件'), mediaType: 'image/png', displayName: '私有旧20200102文件.png' });
  const { documentId } = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id, assignmentBasis });
  const pages: SourceSpan[] = Array.from({ length: 12 }, (_, index) => ({ id: `synthetic-page-${index + 1}`, documentId,
    spanKind: 'image', page: index + 1, blockId: `direct-original-page:${index + 1}`, lineStart: null, lineEnd: null,
    quote: null, readability: 'unreadable' }));
  const excerpt = (id: string, quote: string, role: 'date' | 'finding'): SourceSpan => ({
    id, documentId, spanKind: 'block', page: 1, blockId: `model-original-excerpt:${pages[0]!.id}`,
    lineStart: null, lineEnd: null, quote, readability: 'clear', modelEvidence: { version: 1,
      engine: 'codex-original-reading-v1', modelId: 'gpt-6.1-sol', threadId: 'old-thread', turnId: 'old-turn',
      originalSha256: source.sha256, originalSourceObjectId: source.id, parentSourceSpanId: pages[0]!.id,
      inputKind: 'image', role, clarity: 'clear' } });
  const finding = excerpt('synthetic-finding', '合成项目 <3.10E+03 IU/L', 'finding');
  const oldDate = excerpt('synthetic-date', '检查日期：2020-01-02', 'date');
  const base: SourceManifest = { id: 'synthetic-manifest', sourceObjectId: source.id, sha256: source.sha256,
    mediaType: 'image/png', originalDisplayName: '私有旧20200102文件.png', totalUnits: pages.length,
    coveredUnitIndexes: pages.map((_, index) => index), normalizerVersion: 'direct-original-preparation-v1',
    spans: pages, createdAt: '2001-02-03T00:00:00Z', conversionWarnings: [] };
  store.saveSourceManifest({ ...base, spans: [...pages, finding, oldDate] });
  const ref = (span: SourceSpan) => ({ sourceSpanId: span.id, quote: span.quote });
  const acceptanceId = store.saveAcceptanceDecision({ method: 'auto', actor: 'policy', rulesVersion: 'synthetic',
    inputSignature: 'synthetic-signature', outputHash: 'synthetic-output', reviewRef: null, decision: 'accept' });
  store.publishFacts({ documentId, personId: person.id, documentCommitKey: 'a'.repeat(64), changeSetHash: 'b'.repeat(64),
    expectedRevision: 0, summary: '合成旧事实', observations: [{ conceptKey: '合成项目', originalName: '合成项目',
      rawText: '<3.10E+03', valueKind: 'numeric', decimalValue: '3100', qualifier: 'lt', unit: 'IU/L', referenceRange: null,
      clinicalDate: '2020-01-02', abnormalFlag: 'unknown', documentId, sourceSpanId: finding.id, acceptanceId,
      specimen: null, method: null, bodySite: '左侧', evidence: [ref(finding), ref(oldDate)],
      sourceBinding: { headingEvidence: [], findingEvidence: [ref(finding)] } }],
    reportMetadata: { reportKind: null, title: null, organization: null, campus: null, department: null,
      reportNumber: null, examItems: [], primaryClinicalTimeIndex: 0,
      times: [{ role: 'examined', value: '2020-01-02', precision: 'day', evidence: [ref(oldDate)] }] } });
  const consentId = store.createManualProcessingConsent({ documentIds: [documentId], personIds: [person.id],
    accountFingerprint: 'synthetic-account', version: 1, dateCorrectionDocumentId: documentId });
  store.createWaitingAuthBatch({ cutoff: '2028-01-01T00:00:00Z', consentId, dateCorrectionDocumentId: documentId,
    initialStatus: 'queued', groups: [{ personId: person.id, documentIds: [documentId], stage: 'extract', inputSignature: 'synthetic-date-job' }] });
  const job = store.claimNextQueuedJob('synthetic-worker', 'synthetic-account')!;
  const guard = { jobId: job.id, attemptId: store.startJobAttempt(job.id, 'synthetic-runtime', 'gpt-6.1-sol', 'medium'),
    consentId, accountFingerprint: 'synthetic-account' };
  const prepared: PreparedOriginalModelInput = { manifest: base, originalSha256: source.sha256, totalUnits: pages.length,
    imagePaths: pages.map((_, index) => `/synthetic-whole-original/page-${index + 1}.png`),
    imageMappings: pages.map((page, index) => ({ inputKind: 'image', page: index + 1, sourceSpanId: page.id,
      path: `/synthetic-whole-original/page-${index + 1}.png`, mediaType: 'image/png', sha256: source.sha256, width: 2732, height: 3334 })),
    unitMappings: pages.map((page, index) => ({ inputKind: 'image', page: index + 1, sourceSpanId: page.id })),
    tempRoot: '/synthetic-whole-original', cleanup: vi.fn(async () => undefined) };
  const reading = (value = '2027-04-05'): DirectOriginalDateReading => ({ schemaVersion: 1, documentId,
    subject: { reportedName: person.displayName, confidence: 'explicit', evidence: [
      { pageSourceSpanId: pages[0]!.id, quote: `姓名：${person.displayName}`, clarity: 'clear' }] },
    dates: [{ localKey: 'exam', value, role: 'examined', pageSourceSpanId: pages[0]!.id,
      quote: `检查日期：${value}`, clarity: 'clear', factScopeIds: ['fact_1'] }], primaryClinicalDateKey: 'exam' });
  const modelReceipt = (output: unknown, index: number) => ({ output, threadId: `blind-thread-${index}`, turnId: `blind-turn-${index}` });
  return { store, db, person, documentId, guard, prepared, reading, modelReceipt };
}

describe('日期专用完整原件双盲流程', () => {
  it.each(['user_selected', 'identity_confirmed', 'folder_binding', 'legacy'] as const)(
    '%s归属仅明确用户选择可在姓名不符时核实日期，医疗原字段及旧版本保持', async (basis) => {
      const f = fixture(basis === 'folder_binding' ? 'folder_binding' : 'user_selected');
      if (basis === 'identity_confirmed' || basis === 'legacy') {
        // 只在隔离合成库构造已确认/旧版归属，不修改任何医疗数据。
        f.db.prepare('UPDATE documents SET person_assignment_basis=? WHERE id=?').run(basis, f.documentId);
      }
      const raw = f.reading(); raw.subject.reportedName = '*合成'; raw.subject.evidence[0]!.quote = '患者姓名：*合成';
      const original = structuredClone(raw); let calls = 0;
      const runtime = { runStructuredTurn: vi.fn(async () => f.modelReceipt(structuredClone(raw), ++calls)) };
      const before = f.store.listAcceptedObservations(f.person.id)[0]!;
      const oldRevision = f.db.prepare('SELECT * FROM observation_revisions WHERE revision=1').all();
      const result = await new DirectOriginalDateCorrectionPipeline(f.store, runtime, f.guard,
        { prepareOriginal: vi.fn(async () => f.prepared) }).process(f.documentId);
      expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
      expect(raw).toEqual(original);
      expect(result.status).toBe(basis === 'user_selected' || basis === 'identity_confirmed' ? 'published' : 'partial');
      const after = f.store.listAcceptedObservations(f.person.id)[0]!;
      expect(after.clinicalDate).toBe(basis === 'user_selected' || basis === 'identity_confirmed' ? '2027-04-05' : '2020-01-02');
      for (const field of ['rawText', 'decimalValue', 'qualifier', 'unit', 'bodySite', 'originalName'] as const) {
        expect(after[field]).toEqual(before[field]);
      }
      expect(f.db.prepare('SELECT * FROM observation_revisions WHERE revision=1').all()).toEqual(oldRevision);
      expect(f.store.getDocumentExtractionBundle(f.documentId).confirmedPersonAliases).toEqual([]);
    });
  it.each(['absent', 'uncertain'] as const)('用户明确归属的%s身份保留原状，不阻止两次可靠日期共识', async (confidence) => {
    const f = fixture(); let calls = 0; const raw = f.reading();
    raw.subject = { reportedName: null, confidence, evidence: [] };
    const runtime = { runStructuredTurn: vi.fn(async () => f.modelReceipt(structuredClone(raw), ++calls)) };
    expect(await new DirectOriginalDateCorrectionPipeline(f.store, runtime, f.guard,
      { prepareOriginal: vi.fn(async () => f.prepared) }).process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 1 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
    expect(raw.subject).toEqual({ reportedName: null, confidence, evidence: [] });
  });
  it('两读只见相同完整原件及无日期范围，不见旧日期/旧引用/文件名/上传时间/第一读输出', async () => {
    const f = fixture(); const prompts: string[] = []; let calls = 0;
    const runtime = { runStructuredTurn: vi.fn(async (input: { prompt: string; imagePaths?: string[]; allowWebSearch?: boolean }) => {
      prompts.push(input.prompt); expect(input.imagePaths).toEqual(f.prepared.imagePaths); expect(input.imagePaths).toHaveLength(12);
      expect(input.allowWebSearch).toBe(false); expect(input.prompt).not.toContain('2020'); expect(input.prompt).not.toContain('2001');
      expect(input.prompt).not.toContain('私有旧'); expect(input.prompt).not.toContain('synthetic-date');
      expect(input.prompt).not.toContain('clinicalDate'); expect(input.prompt).not.toContain('<3.10E+03');
      return f.modelReceipt(f.reading(), ++calls);
    }) };
    const oldRows = f.db.prepare('SELECT * FROM observation_revisions').all();
    const pipeline = new DirectOriginalDateCorrectionPipeline(f.store, runtime, f.guard, { prepareOriginal: vi.fn(async () => f.prepared) });
    expect(await pipeline.process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 1 });
    expect(prompts[0]!.slice(prompts[0]!.indexOf('\n'))).toBe(prompts[1]!.slice(prompts[1]!.indexOf('\n')));
    expect(f.store.listAcceptedObservations(f.person.id)[0]).toMatchObject({ clinicalDate: '2027-04-05', rawText: '<3.10E+03',
      decimalValue: '3100', qualifier: 'lt', unit: 'IU/L', bodySite: '左侧' });
    expect(f.db.prepare('SELECT * FROM observation_revisions WHERE revision=1').all()).toEqual(oldRows);
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM ai_transmission_receipts').get()).toEqual({ count: 2 });
    expect(f.db.prepare('SELECT report_date FROM report_records').get()).toEqual({ report_date: null });
    expect(await pipeline.process(f.documentId)).toMatchObject({ status: 'published', candidateCount: 0 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(2);
  });
  it.each(['different_date', 'empty', 'role', 'scope', 'same_thread', 'schema_first', 'schema_second'] as const)('%s保留旧结果，不修null、不第三次读，也不无限新增warning', async (mode) => {
    const f = fixture(); let calls = 0;
    const runtime = { runStructuredTurn: vi.fn(async () => {
      calls += 1; const out = f.reading(calls === 2 && mode === 'different_date' ? '2028-04-05' : '2027-04-05');
      if (calls === 2 && mode === 'empty') { out.dates = []; out.primaryClinicalDateKey = null; }
      if (calls === 2 && mode === 'role') out.dates[0]!.role = 'report_issued';
      if (calls === 2 && mode === 'scope') out.dates[0]!.factScopeIds = ['other-fact'];
      const result = f.modelReceipt(mode === 'schema_first' || mode === 'schema_second' && calls === 2 ? {} : out, calls);
      if (mode === 'same_thread') result.threadId = 'not-independent'; return result;
    }) };
    const pipeline = new DirectOriginalDateCorrectionPipeline(f.store, runtime, f.guard, { prepareOriginal: vi.fn(async () => f.prepared) });
    const oldRows = f.db.prepare('SELECT * FROM observation_revisions').all();
    expect(await pipeline.process(f.documentId)).toMatchObject({ status: 'partial' });
    const warningCount = f.store.listOpenExtractionReviewIssues().length;
    expect(await pipeline.process(f.documentId)).toMatchObject({ status: 'partial' });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(mode === 'schema_first' ? 1 : 2);
    expect(f.store.listOpenExtractionReviewIssues()).toHaveLength(warningCount);
    expect(f.db.prepare('SELECT * FROM observation_revisions').all()).toEqual(oldRows);
    expect(f.store.getDateCorrectionFactScopes(f.guard, f.documentId).appliedReceipt).toBeNull();
  });
  it('第二读繁忙仅续第二读，完整第一读及实际receipt保留', async () => {
    const f = fixture(); let calls = 0;
    const runtime = { runStructuredTurn: vi.fn(async () => {
      if (++calls === 2) throw new Error('CODEX_MODEL_BUSY'); return f.modelReceipt(f.reading(), calls);
    }) };
    const pipeline = new DirectOriginalDateCorrectionPipeline(f.store, runtime, f.guard, { prepareOriginal: vi.fn(async () => f.prepared) });
    await expect(pipeline.process(f.documentId)).rejects.toThrow('CODEX_MODEL_BUSY');
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM ai_transmission_receipts').get()).toEqual({ count: 1 });
    expect(await pipeline.process(f.documentId)).toMatchObject({ status: 'published' });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(3);
    expect(f.db.prepare('SELECT status FROM ai_transmissions ORDER BY rowid').all()).toEqual([
      { status: 'completed' }, { status: 'unknown' }, { status: 'completed' }]);
  });
  it('模型返回前取消时，不能保存completed凭据、日期或新来源', async () => {
    const f = fixture(); const runtime = { runStructuredTurn: vi.fn(async () => {
      f.store.requestJobCancellation(f.guard.jobId); return f.modelReceipt(f.reading(), 1);
    }) };
    await expect(new DirectOriginalDateCorrectionPipeline(f.store, runtime, f.guard,
      { prepareOriginal: vi.fn(async () => f.prepared) }).process(f.documentId)).rejects.toThrow('JOB_CANCELLED');
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM ai_transmission_receipts').get()).toEqual({ count: 0 });
    expect(f.store.listAcceptedObservations(f.person.id)[0]!.clinicalDate).toBe('2020-01-02');
  });
});
