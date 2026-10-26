import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { processNowInputSchema, type ObservationCandidate, type ReportMetadataCandidate, type SourceManifest, type SourceSpan } from '@contracts';
import { stableHash } from '@core';
import { WorkspaceStore, type JobExecutionGuard, type PublishFactsInput } from './index.js';

const resources: Array<{ store: WorkspaceStore; root: string }> = [];
afterEach(() => { for (const { store, root } of resources.splice(0)) { store.close(); rmSync(root, { recursive: true, force: true }); } });

function fixture(correction = true, options: { auxiliary?: boolean; historicalTime?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'date-correction-synthetic-'));
  const store = new WorkspaceStore({ rootDirectory: root }); resources.push({ store, root });
  const db = (store as unknown as { db: Database.Database }).db;
  const person = store.createPerson({ displayName: '合成日期成员' });
  const source = store.putSourceObject({ bytes: Buffer.from('合成原件'), mediaType: 'image/png', displayName: 'synthetic.png' });
  const { documentId } = store.registerImportedDocument({ personId: person.id, sourceObjectId: source.id });
  const page: SourceSpan = { id: randomUUID(), documentId, spanKind: 'image', page: 1, blockId: 'direct-original-page:1',
    lineStart: null, lineEnd: null, quote: null, readability: 'unreadable' };
  const excerpt = (quote: string, role: 'finding' | 'date', review = false): SourceSpan => ({
    id: randomUUID(), documentId, spanKind: 'block', page: 1, blockId: `model-original-excerpt:${page.id}`,
    lineStart: null, lineEnd: null, quote, readability: 'clear', modelEvidence: { version: 1,
      engine: 'codex-original-reading-v1', modelId: 'gpt-6.1-sol', threadId: review ? 'synthetic-review-thread' : 'synthetic-first-thread',
      turnId: review ? 'synthetic-review-turn' : 'synthetic-first-turn', originalSha256: source.sha256,
      originalSourceObjectId: source.id, parentSourceSpanId: page.id, inputKind: 'image', role, clarity: 'clear' } });
  const firstFinding = excerpt('合成项目：合成结果', 'finding'); const firstDate = excerpt('检查日期：2020-03-04', 'date');
  const auxiliary = excerpt('合成辅助检查：其他说明', 'finding');
  const historicalDate = excerpt('历史检查日期：2019-03-04', 'date');
  const manifest: SourceManifest = { id: randomUUID(), sourceObjectId: source.id, sha256: source.sha256, mediaType: 'image/png',
    originalDisplayName: 'synthetic.png', totalUnits: 1, coveredUnitIndexes: [0], spans: [page, firstFinding, firstDate,
      ...(options.auxiliary ? [auxiliary] : []), ...(options.historicalTime ? [historicalDate] : [])],
    normalizerVersion: 'direct-original-preparation-v1', conversionWarnings: [], createdAt: '2026-01-01T00:00:00Z' };
  store.saveSourceManifest(manifest);
  const ref = (span: SourceSpan) => ({ sourceSpanId: span.id, quote: span.quote });
  const acceptanceId = store.saveAcceptanceDecision({ method: 'auto', actor: 'policy', rulesVersion: 'synthetic',
    inputSignature: randomUUID(), outputHash: randomUUID(), reviewRef: null, decision: 'accept' });
  const candidate = (finding: SourceSpan, date: SourceSpan, clinicalDate: string): ObservationCandidate => ({
    localKey: 'synthetic-candidate', originalName: '合成项目', standardNameCandidate: null,
    value: { kind: 'text', rawText: '合成结果' }, unitRaw: null, referenceRangeRaw: null,
    reportedAbnormalFlag: null, specimen: null, method: null, bodySite: null, clinicalDate,
    evidence: [ref(finding), ref(date)], sourceBinding: { headingEvidence: [], findingEvidence: [ref(finding)] }, issues: [] });
  const observation = (c: ObservationCandidate): PublishFactsInput['observations'][number] => ({
    conceptKey: c.originalName, originalName: c.originalName, modelStandardNameCandidate: null,
    valueKind: 'text', rawText: c.value.rawText!, decimalValue: null, qualifier: null, unit: null, referenceRange: null,
    clinicalDate: c.clinicalDate, abnormalFlag: 'unknown', documentId, sourceSpanId: c.sourceBinding!.findingEvidence[0]!.sourceSpanId,
    acceptanceId, specimen: null, method: null, bodySite: null, clinicalContext: null,
    evidence: c.evidence, sourceBinding: c.sourceBinding!, candidate: c });
  const metadata = (date: SourceSpan, value: string): ReportMetadataCandidate => ({ reportKind: null, title: null,
    organization: null, campus: null, department: null, reportNumber: null, examItems: [],
    times: [{ role: 'examined', precision: 'day', value, evidence: [ref(date)] }], primaryClinicalTimeIndex: 0 });
  const initial = observation(candidate(firstFinding, firstDate, '2020-03-04'));
  if (options.auxiliary) initial.evidence.push(ref(auxiliary));
  const initialMetadata = metadata(firstDate, '2020-03-04');
  if (options.historicalTime) initialMetadata.times.push({ role: 'history_quoted', value: '2019-03-04', precision: 'day', evidence: [ref(historicalDate)] });
  store.publishFacts({ personId: person.id, documentId, documentCommitKey: 'a'.repeat(64), expectedRevision: 0,
    changeSetHash: 'b'.repeat(64), summary: '合成初始事实', observations: [initial], reportMetadata: initialMetadata });
  store.createUserAction({ personId: person.id, title: '合成本人计划', detail: '合成个人计划，不随报告日期替换',
    dueDate: '2026-04-05', dueText: '合成用户指定时间' });
  const consentId = store.createManualProcessingConsent({ documentIds: [documentId], personIds: [person.id],
    accountFingerprint: 'synthetic-account', version: 1, ...(correction ? { dateCorrectionDocumentId: documentId } : {}) });
  const batch = store.createWaitingAuthBatch({ cutoff: '2026-01-01T00:00:00Z', initialStatus: 'queued', consentId,
    ...(correction ? { dateCorrectionDocumentId: documentId } : {}),
    groups: [{ personId: person.id, documentIds: [documentId], stage: 'extract', inputSignature: randomUUID() }] });
  const job = store.claimNextQueuedJob('synthetic-worker', 'synthetic-account')!;
  const guard = { jobId: batch.jobIds[0]!, attemptId: store.startJobAttempt(job.id, 'synthetic-runtime', 'gpt-6.1-sol', 'medium'),
    consentId, accountFingerprint: 'synthetic-account' };
  const finding = excerpt('合成项目：合成结果', 'finding', true); const date = excerpt('检查日期：2026-03-04', 'date', true);
  const currentManifest = { ...manifest, spans: [...manifest.spans, finding, date] };
  store.saveDirectOriginalEvidenceForProcessing(currentManifest, { executionGuard: guard });
  let next = observation(candidate(finding, date, '2026-03-04')); let nextMetadata = metadata(date, '2026-03-04');
  const reviewId = store.listOpenExtractionReviewIssues().find((issue) => issue.documentId === documentId)?.id
    ?? store.saveExtractionReviewIssue({ documentId, stage: 'extract', kind: 'field_conflict', severity: 'warning', preserveDocumentStatus: true,
      evidenceRefs: [], candidateOptions: [], reasonCodes: ['synthetic'] });
  const proof = () => {
    const transmissions = ['extract', 'repair_extraction'].map((stage) => {
      return store.beginAiTransmission({ guard, documentId, stage });
    });
    const frozen = store.getDateCorrectionFactScopes(guard, documentId);
    const reading = { schemaVersion: 1, documentId,
      subject: { reportedName: person.displayName, confidence: 'explicit', evidence: [
        { pageSourceSpanId: page.id, quote: `姓名：${person.displayName}`, clarity: 'clear' }] },
      dates: [{ localKey: 'exam', value: '2026-03-04', role: 'examined', pageSourceSpanId: page.id,
        quote: '检查日期：2026-03-04', clarity: 'clear', factScopeIds: frozen.factScopes.map((scope) => scope.scopeId) }],
      primaryClinicalDateKey: 'exam' };
    transmissions.forEach((transmissionId, index) => store.finishDateCorrectionTransmission({ guard, documentId,
      transmissionId, inputSignature: 'c'.repeat(64), outputHash: stableHash(reading),
      threadId: index === 0 ? 'synthetic-first-thread' : 'synthetic-review-thread',
      turnId: index === 0 ? 'synthetic-first-turn' : 'synthetic-review-turn' }));
    store.saveExtractionChunkCheckpoint({ guard, documentId, signature: 'c'.repeat(64), chunkIndex: 0,
      threadId: 'synthetic-review-thread', turnId: 'synthetic-review-turn', extractionTurnId: 'synthetic-first-turn',
      output: { checkpointKind: 'direct_original_date_blind', dateBlindVersion: 'direct-original-date-blind-v1',
        scopeRevision: frozen.scopeRevision, originalSha256: source.sha256, sourceObjectId: source.id,
        factScopesHash: stableHash(frozen.factScopes), failureCode: null,
        reads: [
          { receipt: { threadId: 'synthetic-first-thread', turnId: 'synthetic-first-turn' },
            transmissionId: transmissions[0], reading, outputHash: stableHash(reading) },
          { receipt: { threadId: 'synthetic-review-thread', turnId: 'synthetic-review-turn' },
            transmissionId: transmissions[1], reading: structuredClone(reading), outputHash: stableHash(reading) }
        ] } });
    const projected = (store as unknown as { dateCorrectionProjection(guard: JobExecutionGuard, documentId: string):
      { observations: PublishFactsInput['observations']; metadata: ReportMetadataCandidate; manifest: SourceManifest } })
      .dateCorrectionProjection(guard, documentId);
    next = projected.observations[0]!; nextMetadata = projected.metadata;
    store.saveDirectOriginalEvidenceForProcessing(projected.manifest, { executionGuard: guard });
    Object.assign(currentManifest, projected.manifest);
  };
  const append = (observations = [next], expectedRevision = store.getFactRevision(person.id)) => store.appendCommittedFacts({
    personId: person.id, documentId, expectedRevision, observations, summary: '合成日期修正', reportMetadata: nextMetadata, executionGuard: guard,
    reviewUpdate: { issueId: reviewId, remainingCandidates: [], remainingReasonCodes: [], remainingEvidenceRefs: [] } });
  return { store, db, person, documentId, guard, get next() { return next; }, get nextMetadata() { return nextMetadata; }, currentManifest, proof, append, consentId };
}

function previousDateWarning(f: ReturnType<typeof fixture>, mode = 'eligible') {
  const cloneRow = (table: 'consents' | 'jobs', row: Record<string, unknown>) => f.db.prepare(`INSERT INTO ${table}
    (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row) as Array<string | number | null>);
  const consent = f.db.prepare('SELECT * FROM consents WHERE id=?').get(f.consentId) as Record<string, unknown>;
  const job = f.db.prepare('SELECT * FROM jobs WHERE id=?').get(f.guard.jobId) as Record<string, unknown>;
  const scope = JSON.parse(consent.scope_json as string); const checkpoint = JSON.parse(job.checkpoint_json as string);
  if (mode === 'ordinary') { delete scope.dateCorrection; delete checkpoint.dateCorrection; }
  if (mode === 'unknown') delete checkpoint.dateCorrection;
  if (mode === 'hash') { scope.dateCorrection.sha256 = 'f'.repeat(64); checkpoint.dateCorrection.sha256 = 'f'.repeat(64); }
  if (mode === 'document') { scope.dateCorrection.documentId = 'synthetic-other-doc'; checkpoint.dateCorrection.documentId = 'synthetic-other-doc'; }
  if (mode === 'person') { scope.dateCorrection.personId = 'synthetic-other-person'; checkpoint.dateCorrection.personId = 'synthetic-other-person'; }
  const consentId = randomUUID(); const jobId = randomUUID(); checkpoint.consentId = consentId; delete checkpoint.extractionChunks;
  cloneRow('consents', { ...consent, id: consentId, scope_json: JSON.stringify(scope) });
  cloneRow('jobs', { ...job, id: jobId, idempotency_key: randomUUID(), input_signature: randomUUID(),
    status: mode === 'running' ? 'running' : 'completed_with_issues', checkpoint_json: JSON.stringify(checkpoint) });
  if (mode === 'unfinished_attempt') f.store.startJobAttempt(jobId, 'synthetic-old-runtime', 'gpt-6.1-sol', 'medium');
  const issueId = f.store.saveExtractionReviewIssue({ documentId: f.documentId, jobId,
    stage: mode === 'stage' ? 'analyze' : 'extract', kind: 'field_conflict', severity: mode === 'blocking' ? 'blocking' : 'warning',
    preserveDocumentStatus: true, candidateOptions: [{ ...f.next.candidate!, localKey: 'old-date-repair-reading', originalName: '合成旧日期尝试候选' }],
    reasonCodes: ['synthetic_previous_date_reading_held'], evidenceRefs: f.next.evidence.map((ref) => ref.sourceSpanId) });
  return { issueId, row: f.db.prepare('SELECT * FROM review_issues WHERE id=?').get(issueId) as Record<string, unknown> };
}

describe('正式单报告日期纠错用途', () => {
  it('契约必须单独确认用途和资料版本，不允许传新日期或与其他任务混用', () => {
    const input = { consentVersion: 1, confirmedDataRecipient: 'OpenAI/Codex', purpose: 'date_correction',
      dateCorrectionDocumentId: 'synthetic-doc', expectedDateCorrectionDataRevision: 'a'.repeat(64) };
    expect(processNowInputSchema.safeParse(input).success).toBe(true);
    for (const extra of [{ clinicalDate: '2026-03-04' }, { documentIds: ['synthetic-doc'] }, { purpose: undefined },
      { expectedDateCorrectionDataRevision: undefined }]) expect(processNowInputSchema.safeParse({ ...input, ...extra }).success).toBe(false);
  });
  it('预检和正式保存仅允许日期变更，旧修订逐字保留并更新自动事件日期', () => {
    const f = fixture(); f.proof();
    const old = f.db.prepare('SELECT * FROM observation_revisions').all();
    const plans = f.db.prepare('SELECT * FROM action_items').all();
    expect(f.store.previewDirectOriginalAdmission({ personId: f.person.id, documentId: f.documentId, manifest: f.currentManifest,
      observations: [f.next], reportMetadata: f.nextMetadata, executionGuard: f.guard })).toMatchObject({ refinedCount: 1, held: [] });
    expect(f.append()).toMatchObject({ appendedCount: 0, updatedCount: 1, heldCount: 0 });
    expect(f.db.prepare('SELECT * FROM observation_revisions WHERE revision=1').all()).toEqual(old);
    expect(f.store.listAcceptedObservations(f.person.id)[0]!.clinicalDate).toBe('2026-03-04');
    expect(f.db.prepare('SELECT clinical_date FROM health_events_v2').get()).toEqual({ clinical_date: '2026-03-04' });
    expect(f.db.prepare('SELECT * FROM action_items').all()).toEqual(plans);
    expect(() => f.store.assertJobExecutionActive(f.guard, f.documentId)).not.toThrow();
  });
  it('正常日期提交保留旧来源绑定字节，并从当前日期依据剔除已替代的旧日期引用', () => {
    const f = fixture(); f.proof();
    const old = f.db.prepare('SELECT * FROM observation_revisions WHERE revision=1').get() as Record<string, unknown>;
    expect(f.store.applyBlindDateCorrection(f.guard, f.documentId)).toMatchObject({ updatedCount: 1, reviewResolved: true });
    const next = f.db.prepare('SELECT * FROM observation_revisions WHERE revision=2').get() as Record<string, unknown>;
    for (const key of ['value_kind', 'raw_text', 'decimal_value', 'qualifier', 'unit', 'reference_range', 'abnormal_flag',
      'source_span_id', 'acceptance_id', 'specimen', 'method', 'body_site', 'clinical_context_json', 'source_binding_json']) {
      expect(next[key], key).toEqual(old[key]);
    }
    const oldDateIds = new Set((JSON.parse(old.date_evidence_json as string) as Array<{ sourceSpanId: string }>).map((ref) => ref.sourceSpanId));
    expect((JSON.parse(next.evidence_json as string) as Array<{ sourceSpanId: string }>).some((ref) => oldDateIds.has(ref.sourceSpanId))).toBe(false);
    expect((JSON.parse(next.date_evidence_json as string) as Array<{ sourceSpanId: string }>)).toHaveLength(2);
    expect(f.db.prepare('SELECT * FROM observation_revisions WHERE revision=1').get()).toEqual(old);
    expect(f.store.getDateCorrectionFactScopes(f.guard, f.documentId).appliedReceipt).toEqual({
      threadId: 'synthetic-review-thread', turnId: 'synthetic-review-turn' });
  });
  it('日期已证明提交后，综合断点允许按用户分析模型恢复而不再要求提取模型', () => {
    const f = fixture(); f.proof(); f.store.applyBlindDateCorrection(f.guard, f.documentId);
    f.db.prepare("UPDATE job_attempts SET model='synthetic-analysis-model',reasoning_effort='high' WHERE id=?").run(f.guard.attemptId);
    expect(f.store.getDateCorrectionFactScopes(f.guard, f.documentId).appliedReceipt?.turnId).toBe('synthetic-review-turn');
  });
  it('general evidence的其他finding不能扩大旧primary来源绑定', () => {
    const f = fixture(true, { auxiliary: true }); f.proof();
    const old = f.db.prepare('SELECT source_binding_json,evidence_json FROM observation_revisions WHERE revision=1').get();
    f.store.applyBlindDateCorrection(f.guard, f.documentId);
    expect(f.db.prepare('SELECT source_binding_json FROM observation_revisions WHERE revision=2').get())
      .toEqual({ source_binding_json: (old as { source_binding_json: string }).source_binding_json });
    const previous = JSON.parse((old as { evidence_json: string }).evidence_json) as Array<{ sourceSpanId: string; quote: string }>;
    const auxiliary = previous.find((ref) => ref.quote.includes('合成辅助'))!;
    const current = f.db.prepare('SELECT evidence_json FROM observation_revisions WHERE revision=2').get() as { evidence_json: string };
    expect(JSON.parse(current.evidence_json)).toContainEqual(auxiliary);
  });
  it('未覆盖的独立历史时间槽保持原样并明确hold，不能用日期用途整表替换', () => {
    const f = fixture(true, { historicalTime: true });
    const old = f.db.prepare('SELECT * FROM report_metadata_revisions').all();
    const facts = f.db.prepare('SELECT * FROM observation_revisions').all();
    expect(() => f.proof()).toThrow('DATE_CORRECTION_METADATA_TIME_SCOPE_INCOMPLETE');
    expect(() => f.store.applyBlindDateCorrection(f.guard, f.documentId)).toThrow('DATE_CORRECTION_METADATA_TIME_SCOPE_INCOMPLETE');
    expect(f.db.prepare('SELECT * FROM report_metadata_revisions').all()).toEqual(old);
    expect(f.db.prepare('SELECT * FROM observation_revisions').all()).toEqual(facts);
  });
  it('本job日期warning与旧未核实医疗候选隔离，成功只解决自己的记录', () => {
    const f = fixture(); f.proof();
    const issueId = f.store.saveExtractionReviewIssue({ documentId: f.documentId, stage: 'extract', kind: 'field_conflict',
      severity: 'warning', preserveDocumentStatus: true, candidateOptions: [{ ...f.next.candidate!, localKey: 'unrelated-medical-field',
        originalName: '合成未核实医疗项目' }], reasonCodes: ['synthetic_medical_conflict'], evidenceRefs: [] });
    const oldIssue = f.db.prepare('SELECT * FROM review_issues WHERE id=?').get(issueId);
    f.store.applyBlindDateCorrection(f.guard, f.documentId);
    expect(f.db.prepare('SELECT * FROM review_issues WHERE id=?').get(issueId)).toEqual(oldIssue);
    expect(f.store.listOpenExtractionReviewIssues().find((issue) => issue.id === issueId)?.candidateOptions).toHaveLength(1);
    expect(f.db.prepare("SELECT resolution_status FROM review_issues WHERE job_id=? AND json_extract(payload_json,'$.purpose')='date_correction'")
      .get(f.guard.jobId)).toEqual({ resolution_status: 'resolved' });
  });
  it('成功双盲提交只将同原件旧日期用途warning标为被替代，原候选/原因/证据和历史完整保留', () => {
    const f = fixture(); f.proof(); const previous = previousDateWarning(f);
    const oldPayload = JSON.parse(previous.row.payload_json as string);
    const oldFacts = f.db.prepare('SELECT * FROM observation_revisions').all();
    f.store.applyBlindDateCorrection(f.guard, f.documentId);
    const row = f.db.prepare('SELECT * FROM review_issues WHERE id=?').get(previous.issueId) as Record<string, unknown>;
    const payload = JSON.parse(row.payload_json as string); const { supersededByDateVerification, ...original } = payload;
    expect(row.resolution_status).toBe('resolved'); expect(original).toEqual(oldPayload);
    expect(row.evidence_refs_json).toBe(previous.row.evidence_refs_json); expect(row.created_at).toBe(previous.row.created_at);
    expect(supersededByDateVerification).toMatchObject({ jobId: f.guard.jobId, documentId: f.documentId,
      version: 'direct-original-date-blind-v1', candidateDisposition: 'not_reextracted_or_accepted' });
    expect(f.db.prepare('SELECT * FROM observation_revisions WHERE revision=1').all()).toEqual(oldFacts);
  });
  it('不同原件/主体/hash、普通或未知用途、blocking、其他stage、仍运行的旧任务均不被日期结案', () => {
    const f = fixture(); f.proof();
    const rows = ['ordinary', 'unknown', 'hash', 'document', 'person', 'blocking', 'stage', 'running', 'unfinished_attempt']
      .map((mode) => previousDateWarning(f, mode));
    f.store.applyBlindDateCorrection(f.guard, f.documentId);
    for (const previous of rows) expect(f.db.prepare('SELECT * FROM review_issues WHERE id=?').get(previous.issueId)).toEqual(previous.row);
  });
  it('日期proof或后续日期提交失败时旧warning也不能被提前结案', () => {
    const f = fixture(); f.proof(); const previous = previousDateWarning(f);
    f.db.exec('DELETE FROM ai_transmission_receipts');
    expect(() => f.store.applyBlindDateCorrection(f.guard, f.documentId)).toThrow('DATE_CORRECTION_INDEPENDENT_REVIEW_REQUIRED');
    expect(f.db.prepare('SELECT * FROM review_issues WHERE id=?').get(previous.issueId)).toEqual(previous.row);
    expect(f.store.listAcceptedObservations(f.person.id)[0]!.clinicalDate).toBe('2020-03-04');
  });
  it.each(['reading_and_hash', 'receipt', 'signature', 'old_completed_only'] as const)('%s不能伪造双盲真实传输凭据', (mode) => {
    const f = fixture(); f.proof();
    const row = f.db.prepare('SELECT checkpoint_json FROM jobs WHERE id=?').get(f.guard.jobId) as { checkpoint_json: string };
    const checkpoint = JSON.parse(row.checkpoint_json);
    const chunk = checkpoint.extractionChunks[f.documentId]['c'.repeat(64)];
    if (mode === 'reading_and_hash') { chunk.output.reads[1].reading.dates[0].value = '2027-03-04';
      chunk.output.reads[1].reading.dates[0].quote = '检查日期：2027-03-04';
      chunk.output.reads[1].outputHash = stableHash(chunk.output.reads[1].reading); }
    if (mode === 'receipt') { chunk.output.reads[1].receipt.turnId = 'not-actual-turn'; chunk.turnId = 'not-actual-turn'; }
    if (mode === 'signature') chunk.signature = 'd'.repeat(64);
    if (mode === 'old_completed_only') f.db.exec('DELETE FROM ai_transmission_receipts');
    f.db.prepare('UPDATE jobs SET checkpoint_json=? WHERE id=?').run(JSON.stringify(checkpoint), f.guard.jobId);
    expect(() => f.store.applyBlindDateCorrection(f.guard, f.documentId)).toThrow('DATE_CORRECTION_INDEPENDENT_REVIEW_REQUIRED');
    expect(f.store.listAcceptedObservations(f.person.id)[0]!.clinicalDate).toBe('2020-03-04');
  });
  it('普通重核仍不覆盖非空日期', () => {
    const f = fixture(false); expect(f.append()).toMatchObject({ updatedCount: 0, heldCount: 1 });
    expect(f.store.listAcceptedObservations(f.person.id)[0]!.clinicalDate).toBe('2020-03-04');
  });
  it('无独立原件核验凭据时拒绝日期替换', () => {
    const f = fixture(); expect(() => f.append()).toThrow('DATE_CORRECTION_INDEPENDENT_REVIEW_REQUIRED');
  });
  it('核验之后再篡改结果不能复用P03凭据', () => {
    const f = fixture(); f.proof();
    expect(() => f.append([{ ...f.next, rawText: '核验后新增的合成结果' }])).toThrow('DATE_CORRECTION_REVIEWED_CONTENT_CHANGED');
    expect(f.store.listAcceptedObservations(f.person.id)[0]!.clinicalDate).toBe('2020-03-04');
  });
  it.each(['changed_to_high', 'hidden_reviewed_high'] as const)('核验后的异常标记%s不能复用P03凭据', (mode) => {
    const f = fixture();
    f.proof();
    if (mode === 'hidden_reviewed_high') f.next.candidate!.reportedAbnormalFlag = 'high';
    const old = f.db.prepare('SELECT * FROM observation_revisions').all();
    expect(() => f.append([{ ...f.next, abnormalFlag: mode === 'changed_to_high' ? 'high' : 'unknown' }]))
      .toThrow('DATE_CORRECTION_REVIEWED_CONTENT_CHANGED');
    expect(f.db.prepare('SELECT * FROM observation_revisions').all()).toEqual(old);
  });
  it('日期用途连版式等价的原值修改也不授权；新日期修订仍逐字继承旧rawText', () => {
    const f = fixture(); f.proof();
    const old = f.db.prepare('SELECT * FROM observation_revisions').all();
    expect(() => f.append([{ ...f.next, rawText: `${f.next.rawText} ` }])).toThrow('DATE_CORRECTION_REVIEWED_CONTENT_CHANGED');
    expect(f.append()).toMatchObject({ updatedCount: 1, heldCount: 0 });
    expect(f.store.listAcceptedObservations(f.person.id)[0]!.rawText).toBe(f.next.rawText);
    expect(f.db.prepare('SELECT * FROM observation_revisions WHERE revision=1').all()).toEqual(old);
  });
  it('已人工接纳的事实没有自动日期替换能力', () => {
    const f = fixture(); f.proof();
    f.db.prepare(`UPDATE acceptance_decisions SET actor='user' WHERE id=(SELECT acceptance_id FROM observation_revisions LIMIT 1)`).run();
    expect(f.append()).toMatchObject({ updatedCount: 0, heldCount: 1 });
    expect(f.store.listAcceptedObservations(f.person.id)[0]!.clinicalDate).toBe('2020-03-04');
  });
  it('任务用途不能被移用于第二份报告', () => {
    const f = fixture(); f.proof();
    expect(() => f.store.assertJobExecutionActive(f.guard, 'synthetic-other-document')).toThrow('DOCUMENT_OUTSIDE_CONSENT_SCOPE');
  });
  it('日期同时改结果或尝试新增项目时仍hold，既有值不变', () => {
    const f = fixture();
    const changed = { ...f.next, rawText: '不同合成结果', candidate: { ...f.next.candidate!, value: { kind: 'text' as const, rawText: '不同合成结果' } } };
    f.proof();
    expect(() => f.append([changed])).toThrow('DATE_CORRECTION_REVIEWED_CONTENT_CHANGED');
    expect(f.store.listAcceptedObservations(f.person.id)[0]!.rawText).toBe('合成结果');
  });
  it.each(['revoke', 'cancel', 'scope_change', 'cas'] as const)('%s之后拒绝写入并保留原修订', (mode) => {
    const f = fixture(); f.proof(); const old = f.db.prepare('SELECT * FROM observation_revisions').all();
    if (mode === 'revoke') f.store.revokeConsent(f.consentId);
    if (mode === 'cancel') f.store.requestJobCancellation(f.guard.jobId);
    if (mode === 'scope_change') f.db.prepare('UPDATE person_revisions SET fact_revision=fact_revision+1 WHERE person_id=?').run(f.person.id);
    expect(() => f.append(undefined, mode === 'cas' ? 0 : undefined)).toThrow();
    expect(f.db.prepare('SELECT * FROM observation_revisions').all()).toEqual(old);
  });
});
