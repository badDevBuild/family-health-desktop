import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { ObservationCandidate, ReportMetadataCandidate, SourceManifest, SourceSpan } from '@contracts';
import { WorkspaceStore, type PublishFactsInput } from './index.js';

const fixtures: Array<{ store: WorkspaceStore; root: string }> = [];
afterEach(() => {
  for (const { store, root } of fixtures.splice(0)) { store.close(); rmSync(root, { recursive: true, force: true }); }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'source-proven-review-synthetic-'));
  const store = new WorkspaceStore({ rootDirectory: root, now: () => new Date('2026-01-01T00:00:00Z') });
  fixtures.push({ store, root });
  const person = store.createPerson({ displayName: '合成成员' });
  const source = store.putSourceObject({ bytes: Buffer.from('仅用于合成测试的原件'), mediaType: 'image/png', displayName: 'synthetic.png' });
  const { documentId } = store.registerImportedDocument({ personId: person.id, sourceObjectId: source.id });
  const page: SourceSpan = { id: randomUUID(), documentId, spanKind: 'image', page: 1,
    blockId: 'direct-original-page:1', lineStart: null, lineEnd: null, quote: null, readability: 'clear' };
  const manifest: SourceManifest = { id: randomUUID(), sourceObjectId: source.id, sha256: source.sha256,
    mediaType: 'image/png', originalDisplayName: 'synthetic.png', totalUnits: 1, coveredUnitIndexes: [0],
    spans: [page], normalizerVersion: 'direct-original-preparation-v1', conversionWarnings: [], createdAt: '2026-01-01T00:00:00Z' };
  store.saveSourceManifest(manifest);
  const consentId = store.createManualProcessingConsent({ documentIds: [documentId], personIds: [person.id], accountFingerprint: 'synthetic-account', version: 1 });
  const batch = store.createWaitingAuthBatch({ consentId, cutoff: '2026-01-01T00:00:00Z', initialStatus: 'queued',
    groups: [{ personId: person.id, documentIds: [documentId], stage: 'extract', inputSignature: randomUUID() }] });
  const job = store.claimNextQueuedJob('synthetic-runner', 'synthetic-account')!;
  const guard = { jobId: batch.jobIds[0]!, attemptId: store.startJobAttempt(job.id, 'synthetic', 'gpt-6.1-sol', 'medium'),
    consentId, accountFingerprint: 'synthetic-account' };
  const acceptanceId = store.saveAcceptanceDecision({ method: 'auto', actor: 'policy', rulesVersion: 'synthetic',
    inputSignature: 'synthetic', outputHash: 'synthetic', reviewRef: null, decision: 'accept' });
  const excerpt = (quote: string, role: NonNullable<SourceSpan['modelEvidence']>['role'] = 'finding'): SourceSpan => ({
    id: randomUUID(), documentId, spanKind: 'block', page: 1, blockId: `model-original-excerpt:${page.id}`,
    lineStart: null, lineEnd: null, quote, readability: 'clear', modelEvidence: { version: 1,
      engine: 'codex-original-reading-v1', modelId: 'gpt-6.1-sol', threadId: 'synthetic-thread', turnId: randomUUID(),
      originalSha256: source.sha256, originalSourceObjectId: source.id, parentSourceSpanId: page.id,
      inputKind: 'image', role, clarity: 'clear' } });
  const save = (...spans: SourceSpan[]) => {
    const current = store.getDocumentExtractionBundle(documentId).manifest;
    store.saveDirectOriginalEvidenceForProcessing({ ...current, spans: [...current.spans, ...spans] }, { executionGuard: guard });
  };
  const candidate = (finding: SourceSpan, changes: Partial<ObservationCandidate> = {}): ObservationCandidate => ({
    localKey: randomUUID(), originalName: '合成项目', standardNameCandidate: null,
    value: { kind: 'text', rawText: '合成结果' }, unitRaw: null, referenceRangeRaw: null,
    reportedAbnormalFlag: null, specimen: null, method: null, bodySite: null, clinicalDate: null,
    evidence: [{ sourceSpanId: finding.id, quote: finding.quote }],
    sourceBinding: { headingEvidence: [], findingEvidence: [{ sourceSpanId: finding.id, quote: finding.quote, sourceRole: 'primary' }] },
    issues: [], ...changes });
  const observation = (c: ObservationCandidate): PublishFactsInput['observations'][number] => ({
    conceptKey: c.originalName, originalName: c.originalName, modelStandardNameCandidate: null,
    rawText: c.value.rawText ?? '', valueKind: c.value.kind,
    decimalValue: c.value.kind === 'numeric' ? c.value.decimal : null,
    qualifier: c.value.kind === 'numeric' ? c.value.comparator : c.value.kind === 'qualitative' ? c.value.category : null,
    unit: c.unitRaw, referenceRange: c.referenceRangeRaw, clinicalDate: c.clinicalDate, abnormalFlag: 'unknown',
    specimen: c.specimen, method: c.method, bodySite: c.bodySite, documentId, acceptanceId,
    sourceSpanId: c.sourceBinding!.findingEvidence[0]!.sourceSpanId, evidence: c.evidence,
    clinicalContext: c.clinicalContext ?? null, sourceBinding: c.sourceBinding, candidate: c });
  const publish = (candidates: ObservationCandidate[] = []) => store.publishFacts({ personId: person.id, documentId,
    expectedRevision: 0, documentCommitKey: 'a'.repeat(64), changeSetHash: 'b'.repeat(64), summary: '合成首次保存',
    observations: candidates.map(observation), executionGuard: guard });
  const review = (candidates: ObservationCandidate[], reasonCodes = ['OLD_SYNTHETIC_REASON']) => store.saveExtractionReviewIssue({
    documentId, stage: 'extract', kind: 'coverage_gap', severity: 'warning', preserveDocumentStatus: true,
    candidateOptions: candidates, reasonCodes, evidenceRefs: candidates.flatMap((c) => c.evidence.map((ref) => ref.sourceSpanId)) });
  const append = (issueId: string, candidates: ObservationCandidate[], options: {
    remaining?: ObservationCandidate[]; reasons?: string[]; metadata?: ReportMetadataCandidate; mode?: 'legacy';
  } = {}) => store.appendCommittedFacts({ personId: person.id, documentId, expectedRevision: store.getFactRevision(person.id),
    summary: '合成原件续读', observations: candidates.map(observation), executionGuard: guard,
    ...(options.metadata ? { reportMetadata: options.metadata } : {}),
    reviewUpdate: { issueId, remainingCandidates: options.remaining ?? [], remainingReasonCodes: options.reasons ?? [],
      remainingEvidenceRefs: [], ...(options.mode === 'legacy' ? {} : { reconciliationMode: 'source_proven' }) } });
  const db = (store as unknown as { db: Database.Database }).db;
  const issue = (id: string) => {
    const row = db.prepare('SELECT resolution_status,payload_json,evidence_refs_json FROM review_issues WHERE id=?').get(id) as {
      resolution_status: string; payload_json: string; evidence_refs_json: string;
    };
    return { status: row.resolution_status, payload: JSON.parse(row.payload_json) as {
      candidateOptions: ObservationCandidate[]; reasonCodes: string[]; previousReasons?: string[];
    }, evidenceRefs: JSON.parse(row.evidence_refs_json) as string[] };
  };
  return { store, documentId, person, manifest, page, excerpt, save, candidate, observation, publish, review, append, issue };
}

const metadata = (date: SourceSpan): ReportMetadataCandidate => ({ reportKind: null, title: null,
  organization: null, campus: null, department: null, reportNumber: null, examItems: [],
  times: [{ role: 'examined', precision: 'day', value: '2026-01-02', evidence: [{ sourceSpanId: date.id, quote: date.quote }] }] });

describe('原件重读的来源证明式旧疑点收窄', () => {
  it('新回包漏列旧疑点时仍保留原候选、逐项依据和诊断史，不冒充具体旧规则仍失败', () => {
    const f = fixture(); const old = f.excerpt('合成旧项目：合成结果'); const next = f.excerpt('合成新项目：合成结果');
    const a = f.candidate(old); const b = f.candidate(next, { originalName: '另一合成项目' });
    f.save(old, next); f.publish(); const id = f.review([a], ['OLD_VALUE_REASON', 'OLD_METADATA_REASON']);
    expect(f.append(id, [b])).toMatchObject({ appendedCount: 1, reviewResolved: false });
    expect(f.issue(id)).toMatchObject({ status: 'open', evidenceRefs: [old.id], payload: {
      candidateOptions: [a], reasonCodes: ['prior_unresolved_source_not_reconciled'],
      previousReasons: ['OLD_VALUE_REASON', 'OLD_METADATA_REASON'] } });
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(1);
  });

  it.each(['addition', 'duplicate'] as const)('本轮正式%s的同原件唯一字段和相同原值可以解决旧疑点', (mode) => {
    const f = fixture(); const old = f.excerpt('合成项目：合成结果'); const a = f.candidate(old);
    f.save(old); f.publish(mode === 'duplicate' ? [a] : []); const id = f.review([a]);
    const next = f.excerpt('合成项目：合成结果'); f.save(next);
    expect(f.append(id, [f.candidate(next)])).toMatchObject({ reviewResolved: true,
      appendedCount: mode === 'addition' ? 1 : 0, duplicateCount: mode === 'duplicate' ? 1 : 0 });
    expect(f.issue(id)).toMatchObject({ status: 'resolved', payload: { candidateOptions: [], reasonCodes: [],
      previousReasons: ['OLD_SYNTHETIC_REASON'] } });
  });

  it('只补充本轮有明确出处的缺失日期时可解决旧日期疑点，不继续显示旧日期错误', () => {
    const f = fixture(); const result = f.excerpt('合成项目：合成结果'); const a = f.candidate(result);
    f.save(result); f.publish([a]); const id = f.review([a], ['OLD_DATE_REASON']);
    const date = f.excerpt('检查日期：2026-01-02', 'date'); f.save(date);
    const next = { ...a, clinicalDate: '2026-01-02', evidence: [...a.evidence, { sourceSpanId: date.id, quote: date.quote }] };
    expect(f.append(id, [next], { metadata: metadata(date) })).toMatchObject({ updatedCount: 1, reviewResolved: true });
    expect(f.issue(id).payload).toMatchObject({ reasonCodes: [], previousReasons: ['OLD_DATE_REASON'] });
  });

  it.each([
    ['9', '8', 'eq', '9', 'eq', 'U/L'],
    ['<2.50E+03 cm/s', '250', 'lt', '2500', 'lt', 'cm/s'],
    ['≤7.40', '7.4', 'eq', '7.4', 'lte', null],
    ['≥2E+03', '2', 'eq', '2000', 'gte', null]
  ] as const)('旧未接纳候选%s的错误JSON表示可由同raw的正式正确解析解决，原句不改',
    (rawText, oldDecimal, oldComparator, decimal, comparator, unitRaw) => {
      const f = fixture(); const span = f.excerpt(`合成项目：${rawText}`);
      const old = f.candidate(span, { value: { kind: 'numeric', rawText, decimal: oldDecimal, comparator: oldComparator }, unitRaw });
      const corrected = { ...old, localKey: randomUUID(), value: { kind: 'numeric' as const, rawText, decimal, comparator } };
      f.save(span); f.publish(); const id = f.review([old], ['direct_original_numeric_representation_conflict']);
      expect(f.append(id, [corrected])).toMatchObject({ appendedCount: 1, heldCount: 0, reviewResolved: true });
      expect(f.issue(id).payload).toMatchObject({ candidateOptions: [], reasonCodes: [],
        previousReasons: ['direct_original_numeric_representation_conflict'] });
      expect(f.store.listAcceptedObservations(f.person.id)[0]).toMatchObject({ rawText, decimalValue: decimal, qualifier: comparator, unit: unitRaw });
    });

  it.each(['still_invalid', 'unit', 'date'] as const)('旧numeric表示错误不授权%s的新变化解决疑点', (change) => {
    const f = fixture(); const span = f.excerpt('合成项目：<2.50E+03 cm/s');
    const old = f.candidate(span, { value: { kind: 'numeric', rawText: '<2.50E+03 cm/s', decimal: '250', comparator: 'lt' }, unitRaw: 'cm/s' });
    const corrected = { ...old, localKey: randomUUID(), value: { kind: 'numeric' as const,
      rawText: '<2.50E+03 cm/s', decimal: change === 'still_invalid' ? '25' : '2500', comparator: 'lt' as const } };
    if (change === 'unit') corrected.unitRaw = 'cm';
    if (change === 'date') old.clinicalDate = '2025-01-01';
    f.save(span); f.publish(); const id = f.review([old]);
    expect(f.append(id, [corrected])).toMatchObject({ reviewResolved: false });
    expect(f.issue(id).payload.candidateOptions).toContainEqual(old);
  });

  it.each(['raw', 'comparator', 'unit', 'negation', 'side', 'date', 'condition'] as const)(
    '同来源但%s不同不能以新值消除旧疑点', (field) => {
      const f = fixture(); const span = f.excerpt('合成项目：<2.00E+02 cm/s；未见异常；左侧');
      const a = f.candidate(span, { value: { kind: 'numeric', rawText: '<2.00E+02', decimal: '200', comparator: 'lt' }, unitRaw: 'cm/s' });
      const current: ObservationCandidate = structuredClone(a); current.localKey = randomUUID();
      if (field === 'raw') current.value = { kind: 'numeric', rawText: '<200', decimal: '200', comparator: 'lt' };
      if (field === 'comparator') current.value = { kind: 'numeric', rawText: '<2.00E+02', decimal: '200', comparator: 'eq' };
      if (field === 'unit') current.unitRaw = 'cm';
      if (field === 'negation') current.value = { kind: 'text', rawText: '可见异常' };
      if (field === 'side') current.bodySite = '右侧';
      if (field === 'date') a.clinicalDate = '2025-01-01';
      if (field === 'condition') a.clinicalContext = { version: 1, status: 'complete', conditions: [{ sourceSpanId: span.id, quote: '左侧' }] };
      f.save(span); f.publish(); const id = f.review([a]);
      expect(f.append(id, [current])).toMatchObject({ appendedCount: 1, reviewResolved: false });
      expect(f.issue(id).payload.candidateOptions).toContainEqual(a);
    });

  it('同页同名同值但真实栏目不同不解决旧项', () => {
    const f = fixture(); const finding = f.excerpt('合成项目：合成结果');
    const aHeading = f.excerpt('合成栏目甲', 'heading'); const bHeading = f.excerpt('合成栏目乙', 'heading');
    const a = f.candidate(finding, { sourceBinding: { headingEvidence: [{ sourceSpanId: aHeading.id, quote: aHeading.quote }],
      findingEvidence: [{ sourceSpanId: finding.id, quote: finding.quote, sourceRole: 'primary' }] } });
    const b = { ...a, localKey: randomUUID(), sourceBinding: { ...a.sourceBinding!,
      headingEvidence: [{ sourceSpanId: bHeading.id, quote: bHeading.quote }] } };
    f.save(finding, aHeading, bHeading); f.publish(); const id = f.review([a]);
    expect(f.append(id, [b])).toMatchObject({ appendedCount: 1, reviewResolved: false });
    expect(f.issue(id).payload.candidateOptions).toContainEqual(a);
  });

  it.each(['ambiguous', 'invalid_reference'] as const)('旧%s绑定无法唯一复证时，清晰新项不能凭同名同值代替它', (kind) => {
    const f = fixture(); const old = f.excerpt('合成结果；合成结果'); const next = f.excerpt('合成项目：合成结果');
    const ref = { sourceSpanId: kind === 'invalid_reference' ? randomUUID() : old.id, quote: '合成结果' };
    const a = f.candidate(old, { evidence: [ref], sourceBinding: { headingEvidence: [], findingEvidence: [ref] } });
    f.save(old, next); f.publish(); const id = f.review([a]);
    expect(f.append(id, [f.candidate(next)])).toMatchObject({ appendedCount: 1, reviewResolved: false });
    expect(f.issue(id).payload.candidateOptions).toContainEqual(a);
  });

  it('本轮存储校验最终hold的候选不具备清除旧项的权限', () => {
    const f = fixture(); const span = f.excerpt('合成项目：合成结果'); const a = f.candidate(span);
    f.save(span); f.publish([{ ...a, value: { kind: 'text', rawText: '原合成结果' } }]);
    const id = f.review([a]); expect(f.append(id, [a])).toMatchObject({ appendedCount: 0, heldCount: 1, reviewResolved: false });
    expect(f.issue(id).payload.candidateOptions).toContainEqual(a);
    expect(f.issue(id).payload.reasonCodes).toContain('prior_unresolved_source_not_reconciled');
  });

  it('同轮冲突整组撤回后，先出现的可接纳项也不能清旧项', () => {
    const f = fixture(); const span = f.excerpt('合成项目：合成结果'); const a = f.candidate(span);
    f.save(span); f.publish(); const id = f.review([a]);
    expect(f.append(id, [a, { ...a, localKey: randomUUID(), method: '另一合成方法' }]))
      .toMatchObject({ appendedCount: 0, heldCount: 2, reviewResolved: false });
    expect(f.issue(id).payload.candidateOptions).toContainEqual(a);
  });

  it.each(['unknown', 'empty'] as const)('旧%s项不会被同来源的新值擅自消除', (kind) => {
    const f = fixture(); const span = f.excerpt('合成项目：合成结果'); const a = f.candidate(span,
      { value: kind === 'unknown' ? { kind: 'unknown', rawText: null, reason: 'synthetic_unclear' } : { kind: 'text', rawText: '' } });
    f.save(span); f.publish(); const id = f.review([a]);
    expect(f.append(id, [f.candidate(span)])).toMatchObject({ reviewResolved: false });
    expect(f.issue(id).payload.candidateOptions).toContainEqual(a);
  });

  it('旧有值不会因本轮只返回空白而消除，且旧原因归档不污染新空白原因', () => {
    const f = fixture(); const span = f.excerpt('合成项目：合成结果'); const a = f.candidate(span);
    const blank = { ...a, localKey: randomUUID(), value: { kind: 'unknown' as const, rawText: null, reason: 'source_blank' } };
    f.save(span); f.publish(); const id = f.review([a]);
    expect(f.append(id, [], { remaining: [blank], reasons: ['CURRENT_UNCLEAR'] })).toMatchObject({ reviewResolved: false });
    expect(f.issue(id).payload).toMatchObject({ candidateOptions: expect.arrayContaining([a, blank]),
      reasonCodes: ['CURRENT_UNCLEAR', 'prior_unresolved_source_not_reconciled'], previousReasons: ['OLD_SYNTHETIC_REASON'] });
  });

  it('只有旧metadata警告时依据本轮metadata重算，不把旧扁平原因重新黏回', () => {
    const f = fixture(); f.publish(); const id = f.review([], ['report_metadata_date_role_unverified']);
    const date = f.excerpt('检查日期：2026-01-02', 'date'); f.save(date);
    expect(f.append(id, [], { metadata: metadata(date) })).toMatchObject({ reviewResolved: true });
    expect(f.issue(id).payload).toMatchObject({ candidateOptions: [], reasonCodes: [], previousReasons: ['report_metadata_date_role_unverified'] });
  });

  it('保留疑点的第二次相同处理幂等，历史原因不丢失或反复增加事实修订', () => {
    const f = fixture(); const span = f.excerpt('合成项目：合成结果'); const a = f.candidate(span);
    f.save(span); f.publish(); const id = f.review([a]); f.append(id, []);
    const before = f.issue(id); const revision = f.store.getFactRevision(f.person.id);
    expect(f.append(id, [])).toMatchObject({ idempotent: true, reviewResolved: false });
    expect(f.issue(id)).toEqual(before); expect(f.store.getFactRevision(f.person.id)).toBe(revision);
  });

  it('不启用来源证明模式时保留原有显式remainder契约，避免改变人工/专用日期流程', () => {
    const f = fixture(); const span = f.excerpt('合成项目：合成结果'); const a = f.candidate(span);
    f.save(span); f.publish(); const id = f.review([a]);
    expect(f.append(id, [], { mode: 'legacy' })).toMatchObject({ reviewResolved: true });
    expect(f.issue(id).payload.previousReasons).toBeUndefined();
  });
});
