import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { ObservationCandidate, ReportMetadataCandidate, SourceManifest, SourceSpan } from '@contracts';
import { projectDirectOriginalCandidateFields } from '@core';
import { WorkspaceStore, type PublishFactsInput } from './index.js';

const fixtures: Array<{ store: WorkspaceStore; root: string }> = [];
afterEach(() => {
  for (const { store, root } of fixtures.splice(0)) { store.close(); rmSync(root, { recursive: true, force: true }); }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'direct-admission-preview-synthetic-'));
  const store = new WorkspaceStore({ rootDirectory: root, now: () => new Date('2026-01-01T00:00:00Z') });
  fixtures.push({ store, root });
  const person = store.createPerson({ displayName: '合成预检成员' });
  const other = store.createPerson({ displayName: '另一合成成员' });
  const source = store.putSourceObject({ bytes: Buffer.from('仅测试使用的合成原件'), mediaType: 'image/png', displayName: 'synthetic.png' });
  const { documentId } = store.registerImportedDocument({ personId: person.id, sourceObjectId: source.id });
  const page: SourceSpan = { id: randomUUID(), documentId, spanKind: 'image', page: 1, blockId: 'direct-original-page:1',
    lineStart: null, lineEnd: null, quote: null, readability: 'unreadable' };
  const manifest: SourceManifest = { id: randomUUID(), sourceObjectId: source.id, sha256: source.sha256, mediaType: 'image/png',
    originalDisplayName: 'synthetic.png', totalUnits: 1, coveredUnitIndexes: [0], spans: [page],
    normalizerVersion: 'direct-original-preparation-v1', conversionWarnings: [], createdAt: '2026-01-01T00:00:00Z' };
  store.saveSourceManifest(manifest);
  const consentId = store.createManualProcessingConsent({ documentIds: [documentId], personIds: [person.id],
    accountFingerprint: 'synthetic-account', version: 1 });
  const batch = store.createWaitingAuthBatch({ consentId, cutoff: '2026-01-01T00:00:00Z', initialStatus: 'queued',
    groups: [{ personId: person.id, documentIds: [documentId], stage: 'extract', inputSignature: randomUUID() }] });
  const job = store.claimNextQueuedJob('synthetic-worker', 'synthetic-account')!;
  const guard = { jobId: batch.jobIds[0]!, attemptId: store.startJobAttempt(job.id, 'synthetic-runtime', 'gpt-6.1-sol', 'medium'),
    consentId, accountFingerprint: 'synthetic-account' };
  const acceptanceId = store.saveAcceptanceDecision({ actor: 'policy', method: 'auto', decision: 'accept', rulesVersion: 'synthetic',
    inputSignature: 'synthetic-input', outputHash: 'synthetic-output', reviewRef: null });
  const excerpt = (quote: string, role: NonNullable<SourceSpan['modelEvidence']>['role'] = 'finding'): SourceSpan => ({
    id: randomUUID(), documentId, spanKind: 'block', page: 1, blockId: `model-original-excerpt:${page.id}`,
    lineStart: null, lineEnd: null, quote, readability: 'clear', modelEvidence: { version: 1,
      engine: 'codex-original-reading-v1', modelId: 'gpt-6.1-sol', threadId: 'synthetic-thread', turnId: randomUUID(),
      originalSha256: source.sha256, originalSourceObjectId: source.id, parentSourceSpanId: page.id,
      inputKind: 'image', role, clarity: 'clear' } });
  const candidate = (name: string, finding: SourceSpan, changes: Partial<ObservationCandidate> = {}): ObservationCandidate => ({
    localKey: randomUUID(), originalName: name, standardNameCandidate: null, value: { kind: 'text', rawText: '合成结果' },
    unitRaw: null, referenceRangeRaw: null, reportedAbnormalFlag: null, specimen: null, method: null, bodySite: null,
    clinicalDate: null, evidence: [{ sourceSpanId: finding.id, quote: finding.quote }],
    sourceBinding: { headingEvidence: [], findingEvidence: [{ sourceSpanId: finding.id, quote: finding.quote }] },
    issues: [], ...changes });
  const observation = (c: ObservationCandidate, temporary = false): PublishFactsInput['observations'][number] => ({
    conceptKey: c.originalName, originalName: c.originalName, modelStandardNameCandidate: null,
    rawText: c.value.rawText ?? '', valueKind: c.value.kind, decimalValue: c.value.kind === 'numeric' ? c.value.decimal : null,
    qualifier: c.value.kind === 'numeric' ? c.value.comparator : c.value.kind === 'qualitative' ? c.value.category : null,
    unit: c.unitRaw, referenceRange: c.referenceRangeRaw, clinicalDate: c.clinicalDate, abnormalFlag: 'unknown', documentId,
    sourceSpanId: c.sourceBinding!.findingEvidence.find((ref) => ref.sourceRole !== 'duplicate_source')!.sourceSpanId,
    acceptanceId: temporary ? 'memory-only-preview-acceptance' : acceptanceId,
    specimen: c.specimen, method: c.method, bodySite: c.bodySite, clinicalContext: c.clinicalContext ?? null,
    evidence: c.evidence, sourceBinding: c.sourceBinding!, candidate: c });
  const memoryManifest = (...spans: SourceSpan[]) => {
    const current = store.getDocumentExtractionBundle(documentId).manifest;
    return { ...current, spans: [...current.spans, ...spans] };
  };
  const save = (m: SourceManifest) => store.saveDirectOriginalEvidenceForProcessing(m, { executionGuard: guard });
  const preview = (candidates: ObservationCandidate[], m: SourceManifest, metadata?: ReportMetadataCandidate) =>
    store.previewDirectOriginalAdmission({ personId: person.id, documentId, manifest: m,
      observations: candidates.map((item) => observation(item, true)), ...(metadata ? { reportMetadata: metadata } : {}) });
  const publish = (candidates: ObservationCandidate[], metadata?: ReportMetadataCandidate) => store.publishFacts({
    personId: person.id, documentId, documentCommitKey: 'a'.repeat(64), changeSetHash: 'b'.repeat(64), expectedRevision: 0,
    summary: '合成预检发布', observations: candidates.map((c) => observation(c)), executionGuard: guard,
    ...(metadata ? { reportMetadata: metadata } : {}) });
  const review = () => store.saveExtractionReviewIssue({ documentId, stage: 'extract', kind: 'field_conflict',
    severity: 'warning', preserveDocumentStatus: true, evidenceRefs: [], candidateOptions: [], reasonCodes: ['SYNTHETIC'] });
  const append = (candidates: ObservationCandidate[], metadata?: ReportMetadataCandidate) => store.appendCommittedFacts({
    personId: person.id, documentId, expectedRevision: store.getFactRevision(person.id), summary: '合成预检追加',
    observations: candidates.map((c) => observation(c)), executionGuard: guard,
    reviewUpdate: { issueId: review(), remainingCandidates: [], remainingReasonCodes: [], remainingEvidenceRefs: [] },
    ...(metadata ? { reportMetadata: metadata } : {}) });
  const db = (store as unknown as { db: Database.Database }).db;
  const state = () => {
    // SHM的读者标记可因正常SELECT变化；正式数据文件、WAL、SQL changes和所有行均须不变。
    const files = ['', '-wal'].map((suffix) => {
      const path = `${store.databasePath}${suffix}`;
      return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
    });
    return { files, changes: db.prepare('SELECT total_changes() AS count').get(),
      tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
        .map((row) => String((row as { name: string }).name)).map((name) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]) };
  };
  return { store, db, source, person, other, documentId, manifest, excerpt, candidate, observation, memoryManifest, preview, save, publish, append, state };
}

const heldKeys = (items: ObservationCandidate[]) => items.map((item) => item.localKey).sort();
const metadataFor = (date: SourceSpan, role: 'examined' | 'report_issued' = 'examined', value = '2026-01-02'): ReportMetadataCandidate => ({
  reportKind: null, title: null, organization: null, campus: null, department: null, reportNumber: null, examItems: [],
  times: [{ value, precision: 'day', role, evidence: [{ sourceSpanId: date.id, quote: date.quote }] }]
});

describe('直接原件接纳预检与正式保存共享计划', () => {
  it.each(['absent', 'added_binding', 'changed_value'] as const)('可选来源绑定%s时日期投影不会哈希空值；真实差异仍拒绝', mode => {
    const f = fixture(); const finding = f.excerpt('合成项目 合成结果');
    const bound = f.candidate('合成项目', finding, { clinicalDate: '2024-02-02' });
    const original = { ...bound }; delete original.sourceBinding;
    const manifest = f.memoryManifest(finding);
    const projection = projectDirectOriginalCandidateFields(original, manifest, {
      personConsistent: true, overwritesUserLockedValue: false, reportMetadata: null
    });
    expect(projection.candidate.clinicalDate).toBeNull();
    expect(projection.reviews.length).toBeGreaterThan(0);
    const observation = { ...f.observation(bound, true), candidate: original, clinicalDate: projection.candidate.clinicalDate };
    delete observation.sourceBinding;
    if (mode === 'added_binding') observation.sourceBinding = bound.sourceBinding;
    if (mode === 'changed_value') observation.rawText = '另一个合成结果';
    const read = () => f.store.previewDirectOriginalAdmission({ personId: f.person.id, documentId: f.documentId,
      manifest, observations: [observation], fieldReviews: [{ kind: 'candidate', original, fields: projection.reviews }] });
    if (mode === 'absent') expect(read).not.toThrow();
    else expect(read).toThrow('DIRECT_ORIGINAL_FIELD_PROJECTION_INVALID');
  });
  it('未保存模型摘录及临时acceptanceId也可只读预检，数据库/WAL/changes逐字不变', () => {
    const f = fixture(); const finding = f.excerpt('合成结果'); const c = f.candidate('合成项目', finding);
    const m = f.memoryManifest(finding); const before = f.state();
    expect(f.preview([c], m)).toMatchObject({ mode: 'publish', acceptedCount: 1, duplicateCount: 0, refinedCount: 0, held: [] });
    expect(f.state()).toEqual(before);
    expect(f.store.getDocumentExtractionBundle(f.documentId).manifest.spans).toHaveLength(1);
    f.save(m); expect(f.publish([c])).toMatchObject({ heldCount: 0, duplicateCount: 0 });
  });

  it('真实同槽的整组矛盾预检与publish全部hold，后来重复不能复活', () => {
    const f = fixture(); const finding = f.excerpt('合成结果'); const first = f.candidate('合成项目', finding);
    const candidates = [first, { ...first, localKey: randomUUID(), method: '另一合成方法' }, { ...first, localKey: randomUUID() }];
    const m = f.memoryManifest(finding); const before = f.state(); const p = f.preview(candidates, m);
    expect(p.acceptedCount).toBe(0); expect(p.held).toHaveLength(3);
    expect(p.held.every((item) => item.reasons.includes('same_source_finding_batch_conflict'))).toBe(true);
    for (const item of p.held) {
      expect(item.diagnostic).toMatchObject({ kind: 'batch_conflict', decision: 'conflict', changedFields: ['method'],
        comparisonScope: 'current_reading' });
      expect(item.diagnostic!.comparisons.map((record) => record.candidate.localKey).sort())
        .toEqual(candidates.filter((candidate) => candidate.localKey !== item.candidate.localKey).map((candidate) => candidate.localKey).sort());
      expect(item.diagnostic!.comparisons.every((record) => record.origin === 'current_reading' && record.bindingStatus === 'resolved')).toBe(true);
    }
    expect(f.state()).toEqual(before); f.save(m); const published = f.publish(candidates);
    expect(heldKeys(published.heldCandidates)).toEqual(heldKeys(p.held.map((item) => item.candidate)));
  });

  it('同段同名且方法/部位不同但没有真实分槽证据，不以这些字段放行', () => {
    const f = fixture(); const finding = f.excerpt('合成结果；合成结果');
    const candidates = ['甲', '乙'].map((key) => f.candidate('合成项目', finding, { method: `方法${key}`, bodySite: `部位${key}` }));
    const m = f.memoryManifest(finding); const p = f.preview(candidates, m);
    expect(p.held).toHaveLength(2); expect(p.acceptedCount).toBe(0);
    f.save(m); expect(f.publish(candidates).heldCount).toBe(2);
  });

  it('真实不同项目及窄范围可以共享摘录，预检不新增旧OCR误拦', () => {
    const f = fixture(); const finding = f.excerpt('合成项目甲：结果甲；合成项目乙：结果乙');
    const candidates = ['甲', '乙'].map((key) => {
      const ref = { sourceSpanId: finding.id, quote: `合成项目${key}：结果${key}` };
      return f.candidate(`合成项目${key}`, finding, { value: { kind: 'text', rawText: `结果${key}` }, evidence: [ref],
        sourceBinding: { headingEvidence: [], findingEvidence: [ref] } });
    });
    const m = f.memoryManifest(finding); expect(f.preview(candidates, m)).toMatchObject({ acceptedCount: 2, held: [] });
    f.save(m); expect(f.publish(candidates)).toMatchObject({ heldCount: 0, duplicateCount: 0 });
  });

  it('不唯一的引用回传稳定hold码和具体resolver原因，publish判定相同', () => {
    const f = fixture(); const finding = f.excerpt('合成结果；合成结果'); const c = f.candidate('合成项目', finding,
      { sourceBinding: { headingEvidence: [], findingEvidence: [{ sourceSpanId: finding.id, quote: '合成结果' }] } });
    const m = f.memoryManifest(finding); const p = f.preview([c], m);
    expect(p.held[0]!.candidate.localKey).toBe(c.localKey);
    expect(p.held[0]!.reasons).toEqual(expect.arrayContaining(['source_binding_unresolved', 'direct_original_finding_quote_not_unique']));
    f.save(m); expect(f.publish([c]).heldReasonCodes).toEqual(p.held[0]!.reasons);
  });

  it('已接纳同字段新回执只算duplicate，append预检不改旧binding/结果', () => {
    const f = fixture(); const old = f.excerpt('合成结果'); const initial = f.candidate('合成项目', old);
    f.save(f.memoryManifest(old)); f.publish([initial]);
    const next = f.excerpt('合成结果'); const c = f.candidate('合成项目', next); const m = f.memoryManifest(next);
    const before = f.state(); expect(f.preview([c], m)).toMatchObject({ mode: 'append', acceptedCount: 0, duplicateCount: 1, held: [] });
    expect(f.state()).toEqual(before); f.save(m);
    expect(f.append([c])).toMatchObject({ appendedCount: 0, duplicateCount: 1, updatedCount: 0, heldCount: 0 });
  });

  it('append同批冲突也整组返回，包括原本与已保存结果相同的候选', () => {
    const f = fixture(); const finding = f.excerpt('合成结果'); const initial = f.candidate('合成项目', finding);
    f.save(f.memoryManifest(finding)); f.publish([initial]);
    const candidates = [{ ...initial, localKey: randomUUID() },
      { ...initial, localKey: randomUUID(), bodySite: '另一合成部位' }];
    const before = f.state(); const p = f.preview(candidates, f.memoryManifest());
    expect(p.held).toHaveLength(2); expect(p.acceptedCount).toBe(0); expect(p.duplicateCount).toBe(0);
    expect(f.state()).toEqual(before);
    const receipt = f.append(candidates);
    expect(heldKeys(receipt.heldCandidates)).toEqual(heldKeys(p.held.map((item) => item.candidate)));
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(1);
  });

  it('原页骨架并非真实模型发现，预检和正式publish不会把它当作可靠来源', () => {
    const f = fixture(); const c = f.candidate('合成项目', f.manifest.spans[0]!);
    const m = f.memoryManifest(); const before = f.state(); const p = f.preview([c], m);
    expect(p.held).toHaveLength(1); expect(p.acceptedCount).toBe(0); expect(f.state()).toEqual(before);
    expect(f.publish([c]).heldReasonCodes).toEqual(p.held[0]!.reasons);
  });

  it('已经保存的来源内容不可借内存预检重写，范围拒绝没有任何写入', () => {
    const f = fixture(); const finding = f.excerpt('合成结果'); f.save(f.memoryManifest(finding));
    const c = f.candidate('合成项目', finding); const current = f.memoryManifest(); const before = f.state();
    expect(() => f.preview([c], { ...current, spans: current.spans.map((span) => span.id === finding.id
      ? { ...span, quote: '被改变的合成内容' } : span) })).toThrow('DIRECT_ORIGINAL_ADMISSION_SCOPE_MISMATCH');
    expect(f.state()).toEqual(before);
  });

  it.each(['value', 'comparator', 'date', 'side', 'unit', 'method', 'context'] as const)('已接纳同槽%s冲突预检与append一致', (field) => {
    const f = fixture(); const finding = f.excerpt('合成固定结果 7 U/L');
    const initial = f.candidate('合成项目', finding, { value: { kind: 'numeric', rawText: '7', decimal: '7', comparator: 'eq' },
      unitRaw: 'U/L', bodySite: '合成左侧', method: '合成方法甲', ...(field === 'date' ? { clinicalDate: '2026-01-01' } : {}) });
    f.save(f.memoryManifest(finding)); f.publish([initial]);
    const changes: Partial<ObservationCandidate> = field === 'value' ? { value: { kind: 'numeric', rawText: '8', decimal: '8', comparator: 'eq' } }
      : field === 'comparator' ? { value: { kind: 'numeric', rawText: '<7', decimal: '7', comparator: 'lt' } }
      : field === 'date' ? { clinicalDate: '2026-01-02' }
      : field === 'side' ? { bodySite: '合成右侧' } : field === 'unit' ? { unitRaw: '其他合成单位' }
      : field === 'method' ? { method: '合成方法乙' } : { clinicalContext: { version: 1, status: 'unresolved', conditions: [] } };
    const c = { ...initial, localKey: randomUUID(), ...changes }; const m = f.memoryManifest(); const before = f.state();
    const p = f.preview([c], m); expect(p.held).toHaveLength(1); expect(p.acceptedCount).toBe(0);
    const changedField = { value: 'value', comparator: 'qualifier', date: 'clinicalDate', side: 'bodySite',
      unit: 'unit', method: 'method', context: 'clinicalContext' }[field];
    expect(p.held[0]!.diagnostic).toMatchObject({ kind: 'reconciliation', decision: 'conflict',
      changedFields: [changedField], comparisonScope: 'stored_version', comparisons: [{
        recordId: f.store.listAcceptedObservations(f.person.id)[0]!.id, origin: 'stored_version', bindingStatus: 'resolved',
        candidate: { value: initial.value, unitRaw: initial.unitRaw, clinicalDate: initial.clinicalDate },
        sourceSpans: expect.arrayContaining([finding, f.manifest.spans[0]])
      }] });
    expect(f.state()).toEqual(before); const receipt = f.append([c]);
    expect(receipt.heldReasonCodes).toEqual(p.held[0]!.reasons);
    expect(heldKeys(receipt.heldCandidates)).toEqual(heldKeys(p.held.map((item) => item.candidate)));
  });

  it('明确临床角色的新日期可在内存预检合法refine，正式append仍再次证明来源', () => {
    const f = fixture(); const finding = f.excerpt('合成结果'); const initial = f.candidate('合成项目', finding);
    f.save(f.memoryManifest(finding)); f.publish([initial]);
    const date = f.excerpt('合成检查日期：2026-01-02', 'date'); const m = f.memoryManifest(date);
    const c = { ...initial, clinicalDate: '2026-01-02', evidence: [...initial.evidence, { sourceSpanId: date.id, quote: date.quote }] };
    const metadata = metadataFor(date); const before = f.state();
    expect(f.preview([c], m, metadata)).toMatchObject({ refinedCount: 1, acceptedCount: 0, held: [], reportReasonCodes: [] });
    expect(f.state()).toEqual(before); f.save(m);
    expect(f.append([c], metadata)).toMatchObject({ updatedCount: 1, appendedCount: 0, heldCount: 0 });
  });

  it('签发日期不能作为空临床日期refine，未证明日期仍被共同门禁拦截', () => {
    const f = fixture(); const finding = f.excerpt('合成结果'); const initial = f.candidate('合成项目', finding);
    f.save(f.memoryManifest(finding)); f.publish([initial]);
    const date = f.excerpt('合成签发日期：2026-01-02', 'date'); const m = f.memoryManifest(date);
    const c = { ...initial, clinicalDate: '2026-01-02', evidence: [...initial.evidence, { sourceSpanId: date.id, quote: date.quote }] };
    const metadata = metadataFor(date, 'report_issued'); const p = f.preview([c], m, metadata);
    expect(p.refinedCount).toBe(0); expect(p.held[0]!.reasons).toContain('clinical_date_enrichment_unproven');
    f.save(m); expect(f.append([c], metadata).heldReasonCodes).toEqual(p.held[0]!.reasons);
  });

  it('报告日期的冲突预检纯只读，reportReasonCodes与正式metadata enrichment一致', () => {
    const f = fixture(); const finding = f.excerpt('合成结果'); const date = f.excerpt('合成检查日期：2026-01-02', 'date');
    const initial = f.candidate('合成项目', finding); f.save(f.memoryManifest(finding, date)); f.publish([initial], metadataFor(date));
    const metadata = metadataFor(date, 'examined', '2026-02-03'); const before = f.state();
    const p = f.preview([], f.memoryManifest(), metadata);
    expect(p.reportReasonCodes).toEqual(['report_metadata_date_conflict']); expect(f.state()).toEqual(before);
    expect(p.reportDiagnostics).toMatchObject([{ scope: 'stored_version', current: metadata.times,
      comparisons: [{ origin: 'stored_version', sourceDocumentId: f.documentId, sourceSha256: f.source.sha256,
        times: metadataFor(date).times, clinicalDate: '2026-01-02', sourceSpans: expect.arrayContaining([date]) }] }]);
    expect(f.append([], metadata).heldReasonCodes).toEqual(p.reportReasonCodes);
  });

  it('当前引用不能唯一定位时只返回真实未对应决定，不借用已保存事实', () => {
    const f = fixture(); const old = f.excerpt('合成结果'); const initial = f.candidate('合成项目', old);
    f.save(f.memoryManifest(old)); f.publish([initial]);
    const ambiguous = f.excerpt('合成结果；合成结果');
    const candidate = f.candidate('合成项目', ambiguous, { sourceBinding: { headingEvidence: [],
      findingEvidence: [{ sourceSpanId: ambiguous.id, quote: '合成结果' }] } });
    const before = f.state(); const p = f.preview([candidate], f.memoryManifest(ambiguous));
    expect(p.held[0]!.diagnostic).toEqual({ kind: 'reconciliation', decision: 'unresolved', changedFields: [],
      comparisonScope: 'none', comparisons: [] });
    expect(f.state()).toEqual(before);
  });

  it('真实参与比较但旧引用已缺失的记录明确标为未定位，不相信旧JSON自称已核验', () => {
    const f = fixture(); const old = f.excerpt('合成结果'); const initial = f.candidate('合成项目', old);
    f.save(f.memoryManifest(old)); f.publish([initial]);
    f.db.prepare('UPDATE observation_revisions SET evidence_json=?').run(JSON.stringify([{ sourceSpanId: randomUUID(), quote: '缺失合成出处' }]));
    const current = f.excerpt('合成结果'); const candidate = f.candidate('合成项目', current);
    const before = f.state(); const p = f.preview([candidate], f.memoryManifest(current));
    expect(p.held[0]!.diagnostic).toMatchObject({ decision: 'unresolved', changedFields: [], comparisonScope: 'stored_version',
      comparisons: [{ origin: 'stored_version', bindingStatus: 'unresolved', sourceSpans: [] }] });
    expect(f.state()).toEqual(before);
  });

  it('同轮暂存候选参与后续日期对账时明确为当前读取，不能冒称已保存版本', () => {
    const f = fixture(); const finding = f.excerpt('合成结果'); const first = f.candidate('合成项目', finding);
    const next = { ...first, localKey: randomUUID(), clinicalDate: '2026-01-02' };
    const before = f.state(); const p = f.preview([first, next], f.memoryManifest(finding));
    expect(p.acceptedCount).toBe(0); expect(p.held).toHaveLength(2);
    for (const item of p.held) {
      expect(item.diagnostic).toMatchObject({ kind: 'reconciliation', decision: 'unresolved', changedFields: ['clinicalDate'],
        comparisonScope: 'current_reading', comparisons: [{ origin: 'current_reading', bindingStatus: 'resolved' }] });
      expect(item.diagnostic!.comparisons[0]!.candidate.localKey).not.toBe(item.candidate.localKey);
    }
    expect(f.state()).toEqual(before);
  });

  it('同轮多个冲突组只返回本组实际对照，来源闭包不夹带同页其他项目', () => {
    const f = fixture(); const a = f.excerpt('合成结果甲'); const b = f.excerpt('合成结果乙'); const noise = f.excerpt('无关合成内容');
    const groups = [a, b].map((span, index) => [f.candidate(`合成项目${index}`, span),
      f.candidate(`合成项目${index}`, span, { method: '不同合成方法' })]);
    const before = f.state(); const p = f.preview(groups.flat(), f.memoryManifest(a, b, noise));
    expect(p.held).toHaveLength(4);
    for (const item of p.held) {
      const peer = groups.find((group) => group.some((candidate) => candidate.localKey === item.candidate.localKey))!
        .find((candidate) => candidate.localKey !== item.candidate.localKey)!;
      expect(item.diagnostic!.comparisons).toHaveLength(1);
      expect(item.diagnostic!.comparisons[0]!.candidate.localKey).toBe(peer.localKey);
      expect(item.diagnostic!.comparisons[0]!.sourceSpans.map((span) => span.id).sort())
        .toEqual([peer.evidence[0]!.sourceSpanId, f.manifest.spans[0]!.id].sort());
    }
    expect(f.state()).toEqual(before);
  });

  it('已存对照只附该记录实际标题、日期、条件和发现的必要来源闭包', () => {
    const f = fixture(); const finding = f.excerpt('合成结果'); const heading = f.excerpt('合成栏目', 'heading');
    const date = f.excerpt('合成检查日期：2026-01-02', 'date'); const context = f.excerpt('合成检测条件', 'context');
    const noise = f.excerpt('同页另一项目正文');
    const initial = f.candidate('合成项目', finding, { clinicalDate: '2026-01-02',
      evidence: [finding, date, context].map((span) => ({ sourceSpanId: span.id, quote: span.quote })),
      clinicalContext: { version: 1, status: 'complete', conditions: [{ sourceSpanId: context.id, quote: context.quote! }] },
      sourceBinding: { headingEvidence: [{ sourceSpanId: heading.id, quote: heading.quote }],
        findingEvidence: [{ sourceSpanId: finding.id, quote: finding.quote }] } });
    f.save(f.memoryManifest(finding, heading, date, context, noise)); f.publish([initial]);
    const before = f.state(); const p = f.preview([{ ...initial, method: '另一合成方法' }], f.memoryManifest());
    expect(p.held[0]!.diagnostic!.comparisons[0]!.sourceSpans.map((span) => span.id).sort())
      .toEqual([finding.id, heading.id, date.id, context.id, f.manifest.spans[0]!.id].sort());
    expect(f.state()).toEqual(before);
  });

  it('其他成员、其他文档和不同源码hash的记录不混入当前原件对照', () => {
    const f = fixture(); const finding = f.excerpt('合成结果'); const initial = f.candidate('合成项目', finding);
    f.save(f.memoryManifest(finding)); f.publish([initial]);
    const observation = f.db.prepare('SELECT * FROM observations LIMIT 1').get() as Record<string, unknown>;
    const revision = f.db.prepare('SELECT * FROM observation_revisions LIMIT 1').get() as Record<string, unknown>;
    const insert = (table: string, row: Record<string, unknown>) => f.db.prepare(
      `INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
    const clone = (personId: string, changes: Record<string, unknown> = {}) => {
      const id = randomUUID(); insert('observations', { ...observation, id, person_id: personId });
      insert('observation_revisions', { ...revision, observation_id: id, ...changes }); return id;
    };
    const otherPersonId = clone(f.other.id);
    const otherSource = f.store.putSourceObject({ bytes: Buffer.from('另一份合成原件'), mediaType: 'image/png', displayName: 'other.png' });
    const otherDocument = f.store.registerImportedDocument({ personId: f.person.id, sourceObjectId: otherSource.id });
    const foreignSpan = { ...f.manifest.spans[0]!, id: randomUUID(), documentId: otherDocument.documentId };
    f.store.saveSourceManifest({ ...f.manifest, id: randomUUID(), sourceObjectId: otherSource.id, sha256: otherSource.sha256,
      spans: [foreignSpan] });
    const otherDocumentId = clone(f.person.id, { source_span_id: foreignSpan.id });
    const savedBinding = JSON.parse(String(revision.source_binding_json)) as Record<string, unknown>;
    const otherHashId = clone(f.person.id, { source_binding_json: JSON.stringify({ ...savedBinding, sourceSha256: 'f'.repeat(64) }) });
    const before = f.state(); const p = f.preview([{ ...initial, method: '另一合成方法' }], f.memoryManifest());
    const ids = p.held.flatMap((item) => item.diagnostic!.comparisons.map((record) => record.recordId));
    expect(ids).toEqual([observation.id]);
    expect(ids).not.toEqual(expect.arrayContaining([otherPersonId, otherDocumentId, otherHashId]));
    expect(p.held.flatMap((item) => item.diagnostic!.comparisons.flatMap((record) => record.sourceSpans))
      .every((span) => span.documentId === f.documentId)).toBe(true);
    expect(f.state()).toEqual(before);
  });

  it('新selector的多个签发日冲突明确属于当前读取，不能误称旧版本日期冲突', () => {
    const f = fixture(); const finding = f.excerpt('合成结果'); const first = f.candidate('合成项目', finding);
    f.save(f.memoryManifest(finding)); f.publish([first]);
    const a = f.excerpt('合成签发日期：2026-01-02', 'date'); const b = f.excerpt('合成签发日期：2026-01-03', 'date');
    const metadata = { ...metadataFor(a, 'report_issued'), primaryClinicalTimeIndex: null,
      times: [...metadataFor(a, 'report_issued').times, ...metadataFor(b, 'report_issued', '2026-01-03').times] };
    const before = f.state(); const p = f.preview([], f.memoryManifest(a, b), metadata);
    expect(p.reportReasonCodes).toEqual(['report_metadata_date_conflict']);
    expect(p.reportDiagnostics).toMatchObject([{ scope: 'current_reading', current: metadata.times,
      comparisons: [], sourceSpans: expect.arrayContaining([a, b]) }]);
    expect(f.state()).toEqual(before);
  });

  it.each(['legacy', 'selector'] as const)('%s共享事件日期冲突保留真实scope，不带另一原件日期正文', (mode) => {
    const f = fixture(); const finding = f.excerpt('合成结果'); const initial = f.candidate('合成项目', finding);
    f.save(f.memoryManifest(finding)); f.publish([initial]);
    const report = f.db.prepare('SELECT * FROM report_records LIMIT 1').get() as Record<string, unknown>;
    const sharedId = randomUUID(); const shared = { ...report, id: sharedId };
    f.db.prepare(`INSERT INTO report_records (${Object.keys(shared).join(',')}) VALUES (${Object.keys(shared).map(() => '?').join(',')})`).run(...Object.values(shared));
    f.db.prepare(`INSERT INTO report_metadata_revisions (report_id,revision,payload_json,actor,evidence_refs_json,created_at)
      VALUES (?,1,?,'policy','[]','2026-01-01T00:00:00Z')`).run(sharedId,
        JSON.stringify({ extracted: { times: [{ value: '2025-04-09', role: 'examined', precision: 'day', evidence: [] }] } }));
    const date = f.excerpt('合成检查日期：2026-01-02', 'date');
    const metadata = { ...metadataFor(date), ...(mode === 'selector' ? { primaryClinicalTimeIndex: 0 } : {}) };
    const before = f.state(); const p = f.preview([], f.memoryManifest(date), metadata);
    expect(p.reportDiagnostics).toMatchObject([{ scope: 'shared_event', current: metadata.times, comparisons: [] }]);
    expect(JSON.stringify(p.reportDiagnostics)).not.toContain('2025-04-09');
    expect(f.state()).toEqual(before);
  });

  it.each(['legacy_clinical', 'legacy_issued', 'selector', 'selector_corrected'] as const)(
    '%s两原件共享事件时，当前文件只有旧签发日也不借另一文件的事件日期作对照', (mode) => {
      const f = fixture(); const finding = f.excerpt('合成结果'); const issued = f.excerpt('合成签发日期：2026-01-05', 'date');
      const initial = f.candidate('合成项目', finding);
      f.save(f.memoryManifest(finding, issued)); f.publish([initial], metadataFor(issued, 'report_issued', '2026-01-05'));
      const otherSource = f.store.putSourceObject({ bytes: Buffer.from('另一份合成日期原件'), mediaType: 'image/png', displayName: 'other-date.png' });
      const { documentId: otherDocumentId } = f.store.registerImportedDocument({ personId: f.person.id, sourceObjectId: otherSource.id });
      const otherPage = { ...f.manifest.spans[0]!, id: randomUUID(), documentId: otherDocumentId };
      const otherDateBase = f.excerpt('另一原件专属正文；检查日期：2025-04-09', 'date');
      const otherDate: SourceSpan = { ...otherDateBase, documentId: otherDocumentId, blockId: `model-original-excerpt:${otherPage.id}`,
        modelEvidence: { ...otherDateBase.modelEvidence!, parentSourceSpanId: otherPage.id,
          originalSourceObjectId: otherSource.id, originalSha256: otherSource.sha256 } };
      f.store.saveSourceManifest({ ...f.manifest, id: randomUUID(), sourceObjectId: otherSource.id, sha256: otherSource.sha256,
        spans: [otherPage, otherDate] });
      f.store.publishFacts({ personId: f.person.id, documentId: otherDocumentId, expectedRevision: f.store.getFactRevision(f.person.id),
        documentCommitKey: randomUUID(), changeSetHash: randomUUID(), summary: '另一合成原件建立事件日期', observations: [],
        reportMetadata: metadataFor(otherDate, 'examined', '2025-04-09') });
      const ownReport = f.db.prepare('SELECT r.id FROM report_records r JOIN report_source_links l ON l.report_id=r.id WHERE l.document_id=?')
        .get(f.documentId) as { id: string };
      const otherReport = f.db.prepare('SELECT r.event_id FROM report_records r JOIN report_source_links l ON l.report_id=r.id WHERE l.document_id=?')
        .get(otherDocumentId) as { event_id: string };
      // 仅在合成数据库中复现跨文件已合并事件：事件日期由另一原件建立，当前文件只保有自己的签发日期。
      f.db.prepare('UPDATE report_records SET event_id=? WHERE id=?').run(otherReport.event_id, ownReport.id);
      f.db.prepare('UPDATE event_report_links SET event_id=? WHERE report_id=?').run(otherReport.event_id, ownReport.id);
      if (mode === 'selector_corrected') f.db.prepare("UPDATE health_events_v2 SET metadata_status='corrected' WHERE id=?").run(otherReport.event_id);
      const date = f.excerpt(mode === 'legacy_issued' ? '合成签发日期：2026-01-06' : '合成检查日期：2026-01-02', 'date');
      const metadata = { ...metadataFor(date, mode === 'legacy_issued' ? 'report_issued' : 'examined',
        mode === 'legacy_issued' ? '2026-01-06' : '2026-01-02'), ...(mode.startsWith('selector') ? { primaryClinicalTimeIndex: 0 } : {}) };
      const before = f.state(); const p = f.preview([], f.memoryManifest(date), metadata);
      const scope = mode === 'legacy_issued' ? 'stored_version' : 'shared_event';
      const reason = mode === 'selector_corrected' ? 'report_metadata_user_corrected_projection'
        : mode === 'selector' ? 'report_metadata_shared_event_projection_conflict' : 'report_metadata_date_conflict';
      expect(p.reportReasonCodes).toEqual([reason]); expect(p.reportDiagnostics![0]!.scope).toBe(scope);
      if (scope === 'shared_event') expect(p.reportDiagnostics![0]!.comparisons).toEqual([]);
      else {
        expect(p.reportDiagnostics![0]!.comparisons[0]).toMatchObject({ times: metadataFor(issued, 'report_issued', '2026-01-05').times,
          reportDate: '2026-01-05' });
        expect(p.reportDiagnostics![0]!.comparisons[0]).not.toHaveProperty('clinicalDate');
      }
      const output = JSON.stringify(p.reportDiagnostics);
      expect(output).not.toContain('2025-04-09'); expect(output).not.toContain('另一原件专属正文');
      expect(output).not.toContain(otherDocumentId); expect(output).not.toContain(otherSource.sha256);
      expect(f.state()).toEqual(before);
    });

  it.each(['person', 'hash', 'object', 'page', 'document'] as const)('错误%s范围不能用于预检', (field) => {
    const f = fixture(); const finding = f.excerpt('合成结果'); const c = f.candidate('合成项目', finding); const m = f.memoryManifest(finding);
    const modified = field === 'hash' ? { ...m, sha256: 'f'.repeat(64) } : field === 'object' ? { ...m, sourceObjectId: randomUUID() }
      : field === 'page' ? { ...m, spans: [{ ...m.spans[0]!, id: randomUUID() }, finding] }
      : field === 'document' ? { ...m, spans: [{ ...m.spans[0]!, documentId: randomUUID() }, finding] } : m;
    const before = f.state();
    expect(() => f.store.previewDirectOriginalAdmission({ personId: field === 'person' ? f.other.id : f.person.id,
      documentId: f.documentId, manifest: modified, observations: [f.observation(c, true)] })).toThrow();
    expect(f.state()).toEqual(before);
  });
});
