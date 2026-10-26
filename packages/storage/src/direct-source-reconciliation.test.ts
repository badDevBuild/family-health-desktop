import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { directOriginalReadingRepairSchema, directOriginalReadingResultSchema, type DirectOriginalReadingResult,
  type ObservationCandidate, type ReportMetadataCandidate, type SourceManifest, type SourceSpan } from '@contracts';
import { conceptDictionary, evaluateDirectOriginalObservationCandidate, stableHash } from '@core';
import { WorkspaceStore, type PublishFactsInput } from './index.js';
import { DIRECT_ORIGINAL_SOURCE_REFINEMENT_VERSION, directOriginalSourceRefinementReviewSignature,
  type DirectOriginalSourceRefinementReview } from './direct-original-source-refinement.js';

const stores = new Set<WorkspaceStore>();
const roots: string[] = [];
afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(extraPage = false) {
  const rootDirectory = mkdtempSync(join(tmpdir(), 'family-health-direct-field-synthetic-'));
  roots.push(rootDirectory);
  const store = new WorkspaceStore({ rootDirectory, now: () => new Date('2026-01-01T00:00:00Z') });
  stores.add(store);
  const person = store.createPerson({ displayName: '合成成员' });
  const otherPerson = store.createPerson({ displayName: '另一合成成员' });
  const source = store.putSourceObject({ bytes: Buffer.from('完全合成的固定原件'),
    mediaType: extraPage ? 'application/pdf' : 'image/png', displayName: extraPage ? '合成原件.pdf' : '合成原件.png' });
  const { documentId } = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
  const page: SourceSpan = { id: randomUUID(), documentId, spanKind: 'image', page: 1,
    blockId: 'direct-original-page:1', lineStart: null, lineEnd: null, quote: null, readability: 'clear' };
  const manifest: SourceManifest = { id: randomUUID(), sourceObjectId: source.id, sha256: source.sha256,
    mediaType: extraPage ? 'application/pdf' : 'image/png', originalDisplayName: extraPage ? '合成原件.pdf' : '合成原件.png',
    totalUnits: extraPage ? 2 : 1, coveredUnitIndexes: extraPage ? [0, 1] : [0],
    normalizerVersion: 'direct-original-preparation-v1', conversionWarnings: [], createdAt: '2026-01-01T00:00:00Z',
    spans: [page, ...(extraPage ? [{ ...page, id: randomUUID(), page: 2, blockId: 'direct-original-page:2' }] : [])] };
  store.saveSourceManifest(manifest);
  const consentId = store.createManualProcessingConsent({ documentIds: [documentId], personIds: [person.id],
    accountFingerprint: 'synthetic-account', version: 1 });
  const batch = store.createWaitingAuthBatch({ cutoff: '2026-01-01T00:00:00Z', consentId, initialStatus: 'queued',
    groups: [{ personId: person.id, documentIds: [documentId], stage: 'extract', inputSignature: randomUUID() }] });
  const job = store.claimNextQueuedJob('synthetic-runner', 'synthetic-account')!;
  const guard = { jobId: batch.jobIds[0]!, attemptId: store.startJobAttempt(job.id, 'synthetic', 'gpt-6.1-sol', 'medium'),
    consentId, accountFingerprint: 'synthetic-account' };
  const acceptanceId = store.saveAcceptanceDecision({ method: 'auto', actor: 'policy', rulesVersion: 'synthetic-direct',
    inputSignature: 'synthetic-direct-input', outputHash: 'synthetic-direct-output', reviewRef: null, decision: 'accept' });
  const excerpt = (quote: string, role: NonNullable<SourceSpan['modelEvidence']>['role'] = 'finding'): SourceSpan => ({
    id: randomUUID(), documentId, spanKind: 'block', page: page.page, blockId: `model-original-excerpt:${page.id}`,
    lineStart: null, lineEnd: null, quote, readability: 'clear', modelEvidence: {
      version: 1, engine: 'codex-original-reading-v1', modelId: 'gpt-6.1-sol', threadId: 'synthetic-thread', turnId: randomUUID(),
      originalSha256: manifest.sha256, originalSourceObjectId: manifest.sourceObjectId, parentSourceSpanId: page.id,
      inputKind: 'image', role, clarity: 'clear' } });
  const save = (...spans: SourceSpan[]) => {
    const current = store.getDocumentExtractionBundle(documentId).manifest;
    store.saveDirectOriginalEvidenceForProcessing({ ...current, spans: [...current.spans, ...spans] }, { executionGuard: guard });
  };
  const candidate = (name: string, finding: SourceSpan, heading?: SourceSpan, changes: Partial<ObservationCandidate> = {}): ObservationCandidate => ({
    localKey: randomUUID(), originalName: name, standardNameCandidate: null,
    value: { kind: 'text', rawText: '合成文字结果' }, unitRaw: null, referenceRangeRaw: null,
    reportedAbnormalFlag: null, specimen: null, method: null, bodySite: null, clinicalDate: null,
    evidence: [{ sourceSpanId: finding.id, quote: finding.quote }],
    sourceBinding: { headingEvidence: heading ? [{ sourceSpanId: heading.id, quote: heading.quote }] : [],
      findingEvidence: [{ sourceSpanId: finding.id, quote: finding.quote, sourceRole: 'primary' }] },
    issues: [], ...changes });
  const observation = (candidate: ObservationCandidate): PublishFactsInput['observations'][number] => {
    const ref = candidate.sourceBinding?.findingEvidence.find((ref) => ref.sourceRole !== 'duplicate_source') ?? candidate.evidence[0]!;
    return { conceptKey: candidate.originalName, originalName: candidate.originalName, modelStandardNameCandidate: null,
      rawText: candidate.value.rawText ?? '', valueKind: candidate.value.kind,
      decimalValue: candidate.value.kind === 'numeric' ? candidate.value.decimal : null,
      qualifier: candidate.value.kind === 'numeric' ? candidate.value.comparator
        : candidate.value.kind === 'qualitative' ? candidate.value.category : null,
      unit: candidate.unitRaw, referenceRange: candidate.referenceRangeRaw, clinicalDate: candidate.clinicalDate,
      abnormalFlag: 'unknown', documentId, sourceSpanId: ref.sourceSpanId, acceptanceId,
      specimen: candidate.specimen, method: candidate.method, bodySite: candidate.bodySite,
      clinicalContext: candidate.clinicalContext ?? null, evidence: candidate.evidence,
      sourceBinding: candidate.sourceBinding, candidate };
  };
  const publish = (candidates: ObservationCandidate[], reportMetadata?: ReportMetadataCandidate) => store.publishFacts({ personId: person.id, documentId,
    expectedRevision: 0, documentCommitKey: 'a'.repeat(64), changeSetHash: 'b'.repeat(64),
    summary: '合成完整原件保存', observations: candidates.map(observation), executionGuard: guard,
    ...(reportMetadata ? { reportMetadata } : {}) });
  const review = () => store.saveExtractionReviewIssue({ documentId, stage: 'extract', kind: 'field_conflict',
    severity: 'warning', preserveDocumentStatus: true, evidenceRefs: [], candidateOptions: [], reasonCodes: ['SYNTHETIC_REMAINDER'] });
  const append = (candidates: ObservationCandidate[], issueId: string, expectedRevision = store.getFactRevision(person.id)) =>
    store.appendCommittedFacts({ personId: person.id, documentId, expectedRevision, observations: candidates.map(observation),
      summary: '合成增量重读', reviewUpdate: { issueId, remainingCandidates: [], remainingReasonCodes: [], remainingEvidenceRefs: [] },
      executionGuard: guard });
  return { store, person, otherPerson, source, documentId, manifest, guard, excerpt, save, candidate, observation, publish, review, append };
}

function missingHeadingFixture(frame = '合成栏目甲\n合成文字结果\n合成其他记录') {
  const f = fixture();
  const make = (finding: SourceSpan, heading?: SourceSpan, changes: Partial<ObservationCandidate> = {}) => {
    const ref = { sourceSpanId: finding.id, quote: '合成文字结果', sourceRole: 'primary' as const };
    return f.candidate('合成结果', finding, heading, { evidence: [ref],
      sourceBinding: { headingEvidence: heading ? [{ sourceSpanId: heading.id, quote: heading.quote }] : [], findingEvidence: [ref] }, ...changes });
  };
  const oldFinding = f.excerpt(frame, 'instruction'); const original = make(oldFinding);
  f.save(oldFinding); f.publish([original]);
  const read = (title = '合成栏目甲', changes: Partial<ObservationCandidate> = {}) => {
    const finding = f.excerpt(frame, 'instruction'); const heading = f.excerpt(title, 'heading');
    return { finding, heading, candidate: make(finding, heading, changes) };
  };
  return { ...f, frame, make, oldFinding, original, read };
}

describe('直接原件来源字段的正常发布与增量对账', () => {
  it.each([false, true])('旧来源无法重证时按结果页而非日期页限域；同页=%s仍保护', (samePage) => {
    const f = fixture(true);
    const page2 = f.manifest.spans.find((span) => span.page === 2)!;
    const prior = f.excerpt('旧合成结果：合成文字结果');
    prior.page = 2; prior.modelEvidence!.parentSourceSpanId = page2.id; prior.blockId = `model-original-excerpt:${page2.id}`;
    const date = f.excerpt('报告时间：2026-01-01', 'date');
    const old = f.candidate('旧合成结果', prior);
    old.evidence.push({ sourceSpanId: date.id, quote: date.quote });
    f.save(prior, date); f.publish([old]); const issueId = f.review();
    const db = (f.store as unknown as { db: Database.Database }).db;
    const original = f.store.listAcceptedObservations(f.person.id)[0]!;
    // 合成一个指纹无法重证的旧角色记录；实际产品不会修改旧修订。
    db.prepare("UPDATE observation_revisions SET source_binding_json=json_set(source_binding_json,'$.key','synthetic-old-unresolved') WHERE observation_id=?")
      .run(original.id);
    const before = db.prepare('SELECT * FROM observation_revisions WHERE observation_id=?').all(original.id);
    const next = f.excerpt('新合成结果：合成文字结果');
    if (samePage) { next.page = 2; next.modelEvidence!.parentSourceSpanId = page2.id; next.blockId = `model-original-excerpt:${page2.id}`; }
    f.save(next);
    const result = f.append([f.candidate('新合成结果', next)], issueId);
    expect(result).toMatchObject({ appendedCount: samePage ? 0 : 1, heldCount: samePage ? 1 : 0 });
    expect(db.prepare('SELECT * FROM observation_revisions WHERE observation_id=?').all(original.id)).toEqual(before);
  });

  function savedRoleFixture(twoFindings = false) {
    const f = fixture();
    const frame = '合成栏目甲\n合成文字结果\n合成尾部条件';
    const finding = f.excerpt(frame, 'instruction');
    const headingRef = { sourceSpanId: finding.id, quote: '合成栏目甲' };
    const findingRef = { sourceSpanId: finding.id, quote: '合成文字结果', sourceRole: 'primary' as const };
    const other = twoFindings ? f.excerpt('合成另一段独立结果', 'instruction') : null;
    const findingEvidence = [findingRef, ...(other ? [{ sourceSpanId: other.id, quote: other.quote, sourceRole: 'primary' as const }] : [])];
    const original = f.candidate('合成结果', finding, undefined, {
      evidence: [{ sourceSpanId: finding.id, quote: '合成文字结果' }],
      sourceBinding: { headingEvidence: [headingRef], findingEvidence }
    });
    f.save(finding, ...(other ? [other] : [])); f.publish([original]);
    const db = (f.store as unknown as { db: Database.Database }).db;
    const id = f.store.listAcceptedObservations(f.person.id)[0]!.id;
    const nextFinding = f.excerpt(frame, 'instruction');
    const nextHeading = f.excerpt('合成栏目甲', 'heading');
    const next = f.candidate('合成结果', nextFinding, nextHeading, {
      evidence: [{ sourceSpanId: nextFinding.id, quote: '合成文字结果' }],
      sourceBinding: { headingEvidence: [{ sourceSpanId: nextHeading.id, quote: nextHeading.quote }],
        findingEvidence: [{ sourceSpanId: nextFinding.id, quote: '合成文字结果', sourceRole: 'primary' }] }
    });
    const current = f.store.getDocumentExtractionBundle(f.documentId).manifest;
    const memory = { ...current, spans: [...current.spans, nextFinding, nextHeading] };
    const preview = (candidate = next) => f.store.previewDirectOriginalAdmission({ personId: f.person.id,
      documentId: f.documentId, manifest: memory, observations: [f.observation(candidate)], executionGuard: f.guard });
    return { ...f, db, id, finding, original, next, nextFinding, nextHeading, memory, preview };
  }

  it('同一原字段的旧标题不能在扁平 evidence 恢复时变成第二个结果槽；只读对账判重且不改旧记录', () => {
    const f = savedRoleFixture();
    const oldRows = f.db.prepare('SELECT * FROM observation_revisions ORDER BY rowid').all();
    const changes = f.db.prepare('SELECT total_changes() AS count').get();
    expect(f.preview()).toMatchObject({ acceptedCount: 0, refinedCount: 0, duplicateCount: 1, held: [] });
    expect(f.db.prepare('SELECT total_changes() AS count').get()).toEqual(changes);
    f.save(f.nextFinding, f.nextHeading);
    expect(f.append([f.next], f.review())).toMatchObject({ appendedCount: 0, updatedCount: 0, duplicateCount: 1, heldCount: 0 });
    expect(f.db.prepare('SELECT * FROM observation_revisions ORDER BY rowid').all()).toEqual(oldRows);
  });

  it('恢复显式来源角色后，旧字段的两个结果引用仍完整保留，医疗值变化不放行', () => {
    const f = savedRoleFixture(true);
    const changed = { ...f.next, value: { kind: 'text' as const, rawText: '另一个合成结果' } };
    const preview = f.preview(changed);
    expect(preview).toMatchObject({ acceptedCount: 0, refinedCount: 0, duplicateCount: 0, held: expect.any(Array) });
    const old = preview.held.flatMap((item) => item.diagnostic?.comparisons ?? []).find((item) => item.recordId === f.id)!;
    expect(old.bindingStatus).toBe('resolved');
    expect(old.candidate.sourceBinding?.findingEvidence).toHaveLength(2);
    expect(old.candidate.sourceBinding?.headingEvidence).toHaveLength(1);
    f.save(f.nextFinding, f.nextHeading);
    expect(f.append([changed], f.review())).toMatchObject({ appendedCount: 0, updatedCount: 0, heldCount: 1 });
  });

  it.each(['document', 'object', 'hash', 'version', 'missing_unit', 'missing_heading', 'missing_finding_ref', 'missing_heading_ref',
    'ambiguous_heading_ref', 'invalid_range', 'wrong_unit_page', 'changed_key', 'malformed_json', 'malformed_shape', 'no_binding'] as const)(
    '旧绑定%s损坏时不能用摘要恢复角色或冒充同字段', (mode) => {
      const f = savedRoleFixture();
      const row = f.db.prepare('SELECT source_binding_json FROM observation_revisions WHERE observation_id=?').get(f.id) as { source_binding_json: string };
      const saved = JSON.parse(row.source_binding_json);
      if (mode === 'document') saved.documentId = randomUUID();
      if (mode === 'object') saved.sourceObjectId = randomUUID();
      if (mode === 'hash') saved.sourceSha256 = 'f'.repeat(64);
      if (mode === 'version') saved.version = 2;
      if (mode === 'missing_unit') saved.units[0].sourceSpanId = randomUUID();
      if (mode === 'missing_heading') saved.directOriginalField.headingKeys = ['f'.repeat(64)];
      if (mode === 'invalid_range') saved.units[0].segmentEnd = f.finding.quote!.length + 1;
      if (mode === 'wrong_unit_page') saved.units[0].page = 2;
      if (mode === 'changed_key') saved.key = 'f'.repeat(64);
      if (mode === 'missing_finding_ref' || mode === 'missing_heading_ref') {
        const evidenceRow = f.db.prepare('SELECT evidence_json FROM observation_revisions WHERE observation_id=?').get(f.id) as { evidence_json: string };
        const savedEvidence = JSON.parse(evidenceRow.evidence_json) as ObservationCandidate['evidence'];
        f.db.prepare('UPDATE observation_revisions SET evidence_json=? WHERE observation_id=?')
          .run(JSON.stringify(savedEvidence.filter((ref) => ref.quote !== (mode === 'missing_finding_ref' ? '合成文字结果' : '合成栏目甲'))), f.id);
      }
      if (mode === 'ambiguous_heading_ref') {
        const duplicate = f.excerpt('合成栏目甲', 'heading'); f.save(duplicate); f.memory.spans.push(duplicate);
        const evidenceRow = f.db.prepare('SELECT evidence_json FROM observation_revisions WHERE observation_id=?').get(f.id) as { evidence_json: string };
        const savedEvidence = JSON.parse(evidenceRow.evidence_json) as ObservationCandidate['evidence'];
        f.db.prepare('UPDATE observation_revisions SET evidence_json=? WHERE observation_id=?')
          .run(JSON.stringify([...savedEvidence, { sourceSpanId: duplicate.id, quote: duplicate.quote }]), f.id);
      }
      const json = mode === 'no_binding' ? null : mode === 'malformed_json' ? '{'
        : mode === 'malformed_shape' ? '{"units":[null],"sourceViewId":9}' : JSON.stringify(saved);
      f.db.prepare('UPDATE observation_revisions SET source_binding_json=? WHERE observation_id=?').run(json, f.id);
      const before = f.db.prepare('SELECT * FROM observation_revisions ORDER BY rowid').all();
      expect(f.preview()).toMatchObject({ acceptedCount: 0, refinedCount: 0, duplicateCount: 0, held: expect.any(Array) });
      expect(f.db.prepare('SELECT * FROM observation_revisions ORDER BY rowid').all()).toEqual(before);
    });

  it('旧来源角色重证不授权覆盖新医疗值，仍保留全部旧医疗字段和来源修订', () => {
    const f = savedRoleFixture();
    const before = f.db.prepare('SELECT * FROM observation_revisions ORDER BY rowid').all();
    const changed = { ...f.next, value: { kind: 'text' as const, rawText: '另一个合成结果' } };
    const preview = f.preview(changed);
    expect(preview).toMatchObject({ acceptedCount: 0, refinedCount: 0, duplicateCount: 0, held: expect.any(Array) });
    const old = preview.held.flatMap((item) => item.diagnostic?.comparisons ?? []).find((item) => item.recordId === f.id)!;
    expect(old.candidate.sourceBinding?.findingEvidence).toHaveLength(1);
    expect(old.candidate.sourceBinding?.headingEvidence).toHaveLength(1);
    f.save(f.nextFinding, f.nextHeading);
    expect(f.append([changed], f.review())).toMatchObject({ appendedCount: 0, updatedCount: 0, heldCount: 1 });
    expect(f.db.prepare('SELECT * FROM observation_revisions ORDER BY rowid').all()).toEqual(before);
  });

  it('恢复时 null 整段与实句同槽仍保留 null，不把旧整段来源升级成窄引用证明', () => {
    const f = fixture(); const heading = f.excerpt('合成固定栏目', 'heading'); const finding = f.excerpt('合成文字结果');
    const original = f.candidate('合成结果', finding, heading, {
      sourceBinding: { headingEvidence: [{ sourceSpanId: heading.id, quote: heading.quote }],
        findingEvidence: [{ sourceSpanId: finding.id, quote: null, sourceRole: 'primary' }] }
    });
    f.save(heading, finding); f.publish([original]);
    const nextFinding = f.excerpt('合成文字结果'); const nextHeading = f.excerpt('合成固定栏目', 'heading');
    const next = f.candidate('合成结果', nextFinding, nextHeading, { value: { kind: 'text', rawText: '另一个合成结果' } });
    const current = f.store.getDocumentExtractionBundle(f.documentId).manifest;
    const preview = f.store.previewDirectOriginalAdmission({ personId: f.person.id, documentId: f.documentId,
      manifest: { ...current, spans: [...current.spans, nextFinding, nextHeading] }, observations: [f.observation(next)], executionGuard: f.guard });
    expect(preview).toMatchObject({ acceptedCount: 0, refinedCount: 0, duplicateCount: 0, held: expect.any(Array) });
    const old = preview.held.flatMap((item) => item.diagnostic?.comparisons ?? []).find((item) => item.origin === 'stored_version')!;
    expect(old.bindingStatus).toBe('resolved');
    expect(old.candidate.sourceBinding?.findingEvidence).toEqual([{ sourceSpanId: finding.id, quote: null, sourceRole: 'primary' }]);
  });

  it('正常重核仅补真实缺失栏目并保存来源新修订；预检零写、原值旧引用保留且重复重读幂等', () => {
    const f = missingHeadingFixture(); const originalId = f.store.listAcceptedObservations(f.person.id)[0]!.id;
    const db = (f.store as unknown as { db: Database.Database }).db;
    const beforeRevision = f.store.getFactRevision(f.person.id);
    const old = db.prepare('SELECT * FROM observation_revisions WHERE observation_id=? AND revision=1').get(originalId) as Record<string, unknown>;
    const oldObservation = db.prepare('SELECT * FROM observations WHERE id=?').get(originalId) as Record<string, unknown>;
    const oldEncounters = db.prepare('SELECT * FROM encounters ORDER BY id').all();
    const next = f.read(); const current = f.store.getDocumentExtractionBundle(f.documentId).manifest;
    const memory = { ...current, spans: [...current.spans, next.finding, next.heading] };
    const changes = db.prepare('SELECT total_changes() AS count').get();
    expect(f.store.previewDirectOriginalAdmission({ personId: f.person.id, documentId: f.documentId, manifest: memory,
      observations: [f.observation(next.candidate)], executionGuard: f.guard }))
      .toMatchObject({ mode: 'append', acceptedCount: 0, refinedCount: 1, duplicateCount: 0, held: [] });
    expect(db.prepare('SELECT total_changes() AS count').get()).toEqual(changes);
    expect(f.store.getDocumentExtractionBundle(f.documentId).manifest.spans).toEqual(current.spans);
    for (const personId of [f.person.id, f.otherPerson.id]) {
      db.prepare(`INSERT INTO derived_snapshots (id,person_id,fact_revision,context_revision,prompt_version,rules_version,
        model_id,coverage_json,payload_json,status,created_at) VALUES (?,?,?,0,'synthetic','synthetic','synthetic','{}','{}','current',?)`)
        .run(randomUUID(), personId, beforeRevision, '2026-01-01T00:00:00Z');
      db.prepare(`INSERT INTO member_assessment_snapshots_v3 (id,person_id,input_signature,fact_revision,context_revision,
        prompt_version,rules_version,model_id,reasoning_effort,validation_mode,payload_json,status,created_at)
        VALUES (?,?,'synthetic',?,0,'synthetic','synthetic','synthetic','medium','synthetic','{}','current',?)`)
        .run(randomUUID(), personId, beforeRevision, '2026-01-01T00:00:00Z');
    }
    f.save(next.finding, next.heading); const issue = f.review();
    expect(f.append([next.candidate], issue)).toMatchObject({ appendedCount: 0, updatedCount: 1, heldCount: 0 });
    expect(f.store.getFactRevision(f.person.id)).toBe(beforeRevision + 1);
    for (const table of ['derived_snapshots', 'member_assessment_snapshots_v3']) {
      expect(db.prepare(`SELECT status FROM ${table} WHERE person_id=?`).get(f.person.id)).toEqual({ status: 'stale' });
      expect(db.prepare(`SELECT status FROM ${table} WHERE person_id=?`).get(f.otherPerson.id)).toEqual({ status: 'current' });
    }
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(1);
    expect(db.prepare('SELECT * FROM observation_revisions WHERE observation_id=? AND revision=1').get(originalId)).toEqual(old);
    const revised = db.prepare('SELECT * FROM observation_revisions WHERE observation_id=? AND revision=2').get(originalId) as Record<string, unknown>;
    for (const field of ['value_kind', 'raw_text', 'decimal_value', 'qualifier', 'unit', 'reference_range', 'abnormal_flag',
      'specimen', 'method', 'body_site', 'clinical_date', 'clinical_context_json', 'date_evidence_json']) expect(revised[field]).toEqual(old[field]);
    expect(revised.supersedes).toBe(1);
    expect(JSON.parse(revised.evidence_json as string)).toEqual(expect.arrayContaining(JSON.parse(old.evidence_json as string)));
    expect(JSON.parse(revised.evidence_json as string)).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceSpanId: next.finding.id }), expect.objectContaining({ sourceSpanId: next.heading.id })]));
    expect(JSON.parse(revised.source_binding_json as string).directOriginalField.headingKeys).toHaveLength(1);
    expect((db.prepare('SELECT * FROM observations WHERE id=?').get(originalId) as Record<string, unknown>).encounter_id).toBe(oldObservation.encounter_id);
    expect(db.prepare('SELECT * FROM encounters ORDER BY id').all()).toEqual(oldEncounters);
    expect(db.prepare("SELECT 1 FROM audit_events WHERE event_type='observation.source_binding_enriched' AND entity_id=?").get(originalId)).toBeTruthy();
    expect(f.append([next.candidate], issue)).toMatchObject({ updatedCount: 0, duplicateCount: 1, idempotent: true });
    const repeated = f.read(); f.save(repeated.finding, repeated.heading);
    expect(f.append([repeated.candidate], f.review())).toMatchObject({ updatedCount: 0, appendedCount: 0, duplicateCount: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM observation_revisions WHERE observation_id=?').get(originalId)).toEqual({ count: 2 });
    expect(f.store.getFactRevision(f.person.id)).toBe(beforeRevision + 1);
  });

  it.each(['user_actor', 'user_lock', 'manual_report', 'date_changed', 'value_changed', 'name_changed', 'role_mismatch', 'uncertain'] as const)(
    '来源补齐不覆盖%s，不改旧修订或原值', (mode) => {
      const f = missingHeadingFixture(); const db = (f.store as unknown as { db: Database.Database }).db;
      const id = f.store.listAcceptedObservations(f.person.id)[0]!.id;
      if (mode === 'user_actor') db.prepare("UPDATE acceptance_decisions SET actor='user' WHERE id IN (SELECT acceptance_id FROM observation_revisions)").run();
      if (mode === 'user_lock') f.store.setObservationConceptMapping({ personId: f.person.id, observationId: id,
        conceptId: conceptDictionary[0]!.id, reason: '合成手工锁定' });
      if (mode === 'manual_report') {
        const report = f.store.listReportMetadata(f.person.id)[0]!;
        f.store.updateReportMetadata({ personId: f.person.id, reportId: report.reportId, expectedRevision: report.metadataRevision,
          title: '合成人工修订', organization: null, department: null, clinicalTime: { value: null, precision: 'unknown' }, reason: '合成用户修订' });
      }
      const next = f.read('合成栏目甲', mode === 'date_changed' ? { clinicalDate: '2026-02-03' }
        : mode === 'value_changed' ? { value: { kind: 'text', rawText: '另一个结果' } }
        : mode === 'name_changed' ? { originalName: ' 合成结果 ' } : {});
      if (mode === 'role_mismatch') next.heading.modelEvidence!.role = 'identity';
      if (mode === 'uncertain') { next.heading.modelEvidence!.clarity = 'uncertain'; next.heading.readability = 'partial'; }
      f.save(next.finding, next.heading);
      const beforeFacts = f.store.listAcceptedObservations(f.person.id); const beforeRevision = f.store.getFactRevision(f.person.id);
      const oldRows = db.prepare('SELECT * FROM observation_revisions ORDER BY rowid').all();
      expect(f.append([next.candidate], f.review())).toMatchObject({ appendedCount: 0, updatedCount: 0 });
      expect(db.prepare('SELECT * FROM observation_revisions ORDER BY rowid').all()).toEqual(oldRows);
      expect(f.store.listAcceptedObservations(f.person.id)).toEqual(beforeFacts); expect(f.store.getFactRevision(f.person.id)).toBe(beforeRevision);
    });

  it.each(['heading_competition', 'medical_conflict', 'conflict_first'] as const)('同批%s撤回来源补齐，后续重复输入不能复活最后映射', (mode) => {
    const f = missingHeadingFixture('合成栏目甲\n合成栏目乙\n合成文字结果\n合成其他记录');
    const a = f.read(); const b = mode === 'heading_competition' ? f.read('合成栏目乙') : f.read();
    if (mode !== 'heading_competition') b.candidate = f.make(b.finding, undefined, { value: { kind: 'text', rawText: '冲突结果' } });
    const c = f.read(); f.save(a.finding, a.heading, b.finding, b.heading, c.finding, c.heading);
    const before = f.store.listAcceptedObservations(f.person.id); const revision = f.store.getFactRevision(f.person.id);
    const current = f.store.getDocumentExtractionBundle(f.documentId).manifest;
    const candidates = mode === 'conflict_first' ? [b.candidate, a.candidate, c.candidate] : [a.candidate, b.candidate, c.candidate];
    expect(f.store.previewDirectOriginalAdmission({ personId: f.person.id, documentId: f.documentId, manifest: current,
      observations: candidates.map(f.observation) }))
      .toMatchObject({ acceptedCount: 0, refinedCount: 0, held: expect.any(Array) });
    expect(f.append(candidates, f.review()))
      .toMatchObject({ appendedCount: 0, updatedCount: 0, heldCount: 3, reviewResolved: false });
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual(before); expect(f.store.getFactRevision(f.person.id)).toBe(revision);
  });

  it('来源新修订CAS失败整次回滚，旧版本和事实版本均保留', () => {
    const f = missingHeadingFixture(); const next = f.read(); f.save(next.finding, next.heading); const issue = f.review();
    const db = (f.store as unknown as { db: Database.Database }).db;
    const old = db.prepare('SELECT * FROM observation_revisions ORDER BY rowid').all();
    const before = f.store.listAcceptedObservations(f.person.id); const revision = f.store.getFactRevision(f.person.id);
    db.exec(`CREATE TRIGGER synthetic_source_cas_block BEFORE UPDATE OF current_revision ON observations
      WHEN NEW.current_revision=OLD.current_revision+1 BEGIN SELECT RAISE(IGNORE); END;`);
    expect(() => f.append([next.candidate], issue)).toThrow('OBSERVATION_REFINEMENT_STATE_CHANGED');
    expect(db.prepare('SELECT * FROM observation_revisions ORDER BY rowid').all()).toEqual(old);
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual(before); expect(f.store.getFactRevision(f.person.id)).toBe(revision);
    expect(db.prepare("SELECT 1 FROM audit_events WHERE event_type='observation.source_binding_enriched'").get()).toBeUndefined();
  });

  it('来源补齐仍需同成员同原件；错误哈希、成员和过期事实版本均不能写入', () => {
    const f = missingHeadingFixture(); const next = f.read();
    const current = f.store.getDocumentExtractionBundle(f.documentId).manifest;
    const manifest = { ...current, spans: [...current.spans, next.finding, next.heading] };
    const before = f.store.listAcceptedObservations(f.person.id); const revision = f.store.getFactRevision(f.person.id);
    expect(() => f.store.previewDirectOriginalAdmission({ personId: f.otherPerson.id, documentId: f.documentId,
      manifest, observations: [f.observation(next.candidate)] })).toThrow('DOCUMENT_PERSON_SCOPE_MISMATCH');
    expect(() => f.store.previewDirectOriginalAdmission({ personId: f.person.id, documentId: f.documentId,
      manifest: { ...manifest, sha256: 'f'.repeat(64) }, observations: [f.observation(next.candidate)] }))
      .toThrow('DIRECT_ORIGINAL_ADMISSION_SCOPE_MISMATCH');
    next.heading.modelEvidence!.originalSha256 = 'f'.repeat(64);
    expect(() => f.save(next.finding, next.heading)).toThrow('DIRECT_ORIGINAL_EXCERPT_PROVENANCE_INVALID');
    next.heading.modelEvidence!.originalSha256 = current.sha256; f.save(next.finding, next.heading); const issue = f.review();
    expect(() => f.store.appendCommittedFacts({ personId: f.otherPerson.id, documentId: f.documentId,
      expectedRevision: revision, observations: [f.observation(next.candidate)], summary: '合成范围检查',
      reviewUpdate: { issueId: issue, remainingCandidates: [], remainingReasonCodes: [], remainingEvidenceRefs: [] } }))
      .toThrow('DOCUMENT_PERSON_SCOPE_MISMATCH');
    expect(() => f.append([next.candidate], issue, revision - 1)).toThrow();
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual(before); expect(f.store.getFactRevision(f.person.id)).toBe(revision);
  });

  it('nullable整段引用只读回同成员当前原件摘录，不用结果/标题拼替代且全表/WAL/changes零写', () => {
    const f = fixture(); const finding = f.excerpt('合成安排：合成文字结果；四周后回看原记录。', 'instruction');
    f.save(finding); f.publish([f.candidate('合成安排', finding)]);
    const db = (f.store as unknown as { db: Database.Database }).db;
    const state = () => ({ changes: db.prepare('SELECT total_changes() AS count').get(),
      files: ['', '-wal'].map((suffix) => {
        const path = `${f.store.databasePath}${suffix}`;
        return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
      }),
      tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
        .map((row) => String((row as { name: string }).name)).map((name) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]) });
    const before = state();
    expect(f.store.getTrustedDirectOriginalExcerptQuote(f.person.id, f.documentId, finding.id)).toBe(finding.quote);
    expect(f.store.getTrustedDirectOriginalExcerptQuote(f.person.id, f.documentId, randomUUID())).toBeNull();
    expect(f.store.getTrustedDirectOriginalExcerptQuote(f.otherPerson.id, f.documentId, finding.id)).toBeNull();
    expect(f.store.getTrustedDirectOriginalExcerptQuote(f.person.id, randomUUID(), finding.id)).toBeNull();
    expect(state()).toEqual(before);
    expect(f.store.listAcceptedObservations(f.person.id)[0]!.rawText).toBe('合成文字结果');
  });

  it.each(['member_archived', 'excluded', 'not_committed', 'person_conflict', 'membership_missing',
    'manifest_hash', 'manifest_object', 'model_hash', 'model_object', 'parent', 'uncertain', 'identity', 'legacy',
    'unreferenced_excerpt', 'not_accepted'] as const)(
  '整段引用的%s边界不成立时返回null，不新增来源或修改任何表', (mode) => {
    const f = fixture(); const finding = f.excerpt('合成安排：合成文字结果；四周后回看原记录。', 'instruction');
    f.save(finding); if (mode !== 'not_committed') f.publish([f.candidate('合成安排', finding)]);
    let requestedSpanId = finding.id;
    const db = (f.store as unknown as { db: Database.Database }).db;
    if (mode === 'member_archived') db.prepare('UPDATE persons SET archived_at=? WHERE id=?').run('2026-01-01T00:00:00Z', f.person.id);
    else if (mode === 'excluded') db.prepare('UPDATE documents SET excluded_from_analysis=1 WHERE id=?').run(f.documentId);
    else if (mode === 'person_conflict') f.store.saveExtractionReviewIssue({ documentId: f.documentId, stage: 'extract', kind: 'person_conflict',
      severity: 'blocking', preserveDocumentStatus: true, evidenceRefs: [finding.id], reasonCodes: ['SYNTHETIC_IDENTITY_UNPROVEN'] });
    else if (mode === 'membership_missing') db.prepare('DELETE FROM source_manifest_spans WHERE document_id=? AND source_span_id=?').run(f.documentId, finding.id);
    else if (mode === 'manifest_hash') db.prepare('UPDATE source_manifests SET sha256=? WHERE document_id=?').run('f'.repeat(64), f.documentId);
    else if (mode === 'manifest_object') {
      const other = f.store.putSourceObject({ bytes: Buffer.from('另一合成原件'), mediaType: 'image/png', displayName: 'synthetic-other.png' });
      db.prepare('UPDATE source_manifests SET source_object_id=? WHERE document_id=?').run(other.id, f.documentId);
    } else if (mode === 'legacy') db.prepare('UPDATE source_manifests SET normalizer_version=? WHERE document_id=?').run('synthetic-legacy-v1', f.documentId);
    else if (mode === 'unreferenced_excerpt') {
      const orphan = f.excerpt(finding.quote!, 'instruction'); f.save(orphan);
      // 清晰同原件摘录并不自动成为已接纳来源；相同原文也不替代明确引用。
      requestedSpanId = orphan.id;
    } else if (mode === 'not_accepted') db.prepare("UPDATE acceptance_decisions SET decision='reject' WHERE id IN (SELECT acceptance_id FROM observation_revisions)").run();
    else if (mode !== 'not_committed') {
      const model = { ...finding.modelEvidence!, ...(mode === 'model_hash' ? { originalSha256: 'f'.repeat(64) }
        : mode === 'model_object' ? { originalSourceObjectId: randomUUID() } : mode === 'parent' ? { parentSourceSpanId: randomUUID() }
        : mode === 'identity' ? { role: 'identity' } : { clarity: 'uncertain' }) };
      db.prepare('UPDATE source_spans SET model_evidence_json=? WHERE id=?').run(JSON.stringify(model), finding.id);
    }
    const before = { changes: db.prepare('SELECT total_changes() AS count').get(),
      tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
        .map((row) => String((row as { name: string }).name)).map((name) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]) };
    expect(f.store.getTrustedDirectOriginalExcerptQuote(f.person.id, f.documentId, requestedSpanId)).toBeNull();
    expect({ changes: db.prepare('SELECT total_changes() AS count').get(),
      tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
        .map((row) => String((row as { name: string }).name)).map((name) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]) }).toEqual(before);
  });

  it('部分项目仍held时可只读回当前已接纳条件来源，不误读未接纳摘录', () => {
    const f = fixture(); const finding = f.excerpt('合成文字结果'); const condition = f.excerpt('合成检测条件与监测区间', 'date');
    const unaccepted = f.excerpt('尚未接纳的另一个合成安排', 'instruction'); f.save(finding, condition, unaccepted);
    const candidate = f.candidate('合成结果', finding, undefined, { clinicalContext: { version: 1, status: 'complete',
      conditions: [{ sourceSpanId: condition.id, quote: condition.quote! }] } });
    f.publish([candidate]);
    f.store.saveExtractionReviewIssue({ documentId: f.documentId, stage: 'extract', kind: 'coverage_gap', severity: 'warning',
      preserveDocumentStatus: true, evidenceRefs: [unaccepted.id], reasonCodes: ['SYNTHETIC_PARTIAL_REPORT'] });
    const db = (f.store as unknown as { db: Database.Database }).db;
    db.prepare("UPDATE documents SET status='needs_review' WHERE id=?").run(f.documentId);
    // 独立证明条件引用路径，不依赖通用evidence里的机械复制。
    db.prepare('UPDATE observation_revisions SET evidence_json=?,source_binding_json=NULL WHERE observation_id=? AND revision=1')
      .run(JSON.stringify(candidate.evidence), f.store.listAcceptedObservations(f.person.id)[0]!.id);
    const before = db.prepare('SELECT total_changes() AS count').get();
    expect(f.store.getTrustedDirectOriginalExcerptQuote(f.person.id, f.documentId, condition.id)).toBe(condition.quote);
    expect(f.store.getTrustedDirectOriginalExcerptQuote(f.person.id, f.documentId, unaccepted.id)).toBeNull();
    expect(db.prepare('SELECT total_changes() AS count').get()).toEqual(before);
  });

  it.each([false, true])('日期来源作为明确解释条件正式保存；metadata双用途=%s不自动补项目日期', (withMetadata) => {
    const f = fixture(); const finding = f.excerpt('合成文字结果');
    const date = f.excerpt('检查日期：2026-01-02；合成检测区间：前一日到当日', 'date'); f.save(finding, date);
    const clinicalContext = { version: 1 as const, status: 'complete' as const,
      conditions: [{ sourceSpanId: date.id, quote: date.quote! }] };
    const candidate = f.candidate('合成结果', finding, undefined, { clinicalContext });
    const metadata: ReportMetadataCandidate | undefined = withMetadata ? { reportKind: null, title: null, organization: null,
      campus: null, department: null, reportNumber: null, examItems: [], primaryClinicalTimeIndex: 0,
      times: [{ value: '2026-01-02', precision: 'day', role: 'examined', evidence: [{ sourceSpanId: date.id, quote: date.quote }] }] } : undefined;
    expect(f.publish([candidate], metadata)).toMatchObject({ heldCount: 0 });
    const stored = f.store.listAcceptedObservations(f.person.id)[0]!;
    expect(stored.clinicalContext).toEqual(clinicalContext); expect(stored.clinicalDate).toBeNull();
    expect(f.store.listReportMetadata(f.person.id)[0]!.clinicalTime.value).toBe(withMetadata ? '2026-01-02' : null);
  });

  it.each(['hash', 'object', 'parent'] as const)('日期条件的错误%s原件出处仍在存储边界拒绝，来源事务不留下半份记录', (field) => {
    const f = fixture(); const finding = f.excerpt('合成文字结果'); const date = f.excerpt('合成日期条件', 'date');
    if (field === 'hash') date.modelEvidence!.originalSha256 = 'f'.repeat(64);
    else if (field === 'object') date.modelEvidence!.originalSourceObjectId = randomUUID();
    else date.modelEvidence!.parentSourceSpanId = randomUUID();
    expect(() => f.save(finding, date)).toThrow('DIRECT_ORIGINAL_EXCERPT_PROVENANCE_INVALID');
    expect(f.store.getDocumentExtractionBundle(f.documentId).manifest.spans).toEqual(f.manifest.spans);
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(0);
  });

  it.each(['uncertain', 'bare_page', 'heading'] as const)('日期角色扩展不放行%s条件，正式发布不保存未可信上下文', (mode) => {
    const f = fixture(); const finding = f.excerpt('合成文字结果');
    const condition = mode === 'bare_page' ? f.manifest.spans[0]! : f.excerpt('合成日期条件', mode === 'heading' ? 'heading' : 'date');
    if (mode === 'uncertain') { condition.modelEvidence!.clarity = 'uncertain'; condition.readability = 'partial'; }
    f.save(finding, ...(mode === 'bare_page' ? [] : [condition]));
    const candidate = f.candidate('合成结果', finding, undefined, { clinicalContext: { version: 1, status: 'complete',
      conditions: [{ sourceSpanId: condition.id, quote: '合成日期条件' }] } });
    expect(f.publish([candidate]).heldCount).toBe(1); expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(0);
  });

  it.each([null, { version: 1 as const, status: 'unresolved' as const, conditions: [] },
    { version: 1 as const, status: 'complete' as const, conditions: [] }])('正常重读只版本化补回旧缺失条件%s，预检与append一致且不造新事实/日期', (oldContext) => {
    const f = fixture(); const finding = f.excerpt('合成文字结果'); const oldDate = f.excerpt('合成监测区间：2026-01-01至2026-01-02', 'date');
    f.save(finding, oldDate);
    const original = f.candidate('合成结果', finding, undefined, { clinicalContext: { version: 1, status: 'complete',
      conditions: [{ sourceSpanId: oldDate.id, quote: oldDate.quote! }] } });
    f.publish([original]); const originalId = f.store.listAcceptedObservations(f.person.id)[0]!.id;
    const db = new Database(f.store.databasePath);
    try {
      // 仅在隔离库复现旧保存层漏掉条件；原值、证据、成员和原件都保持真实同槽。
      db.prepare('UPDATE observation_revisions SET clinical_context_json=? WHERE observation_id=? AND revision=1')
        .run(oldContext === null ? null : JSON.stringify(oldContext), originalId);
      const oldRevision = db.prepare('SELECT * FROM observation_revisions WHERE observation_id=? AND revision=1').get(originalId) as Record<string, unknown>;
      const oldObservation = db.prepare('SELECT * FROM observations WHERE id=?').get(originalId) as Record<string, unknown>;
      const oldEncounters = db.prepare('SELECT * FROM encounters ORDER BY id').all();
      const nextFinding = f.excerpt('合成文字结果'); const nextDate = f.excerpt(oldDate.quote!, 'date');
      const context = { version: 1 as const, status: 'complete' as const, conditions: [{ sourceSpanId: nextDate.id, quote: nextDate.quote! }] };
      const incoming = f.candidate('合成结果', nextFinding, undefined, { clinicalContext: context });
      const current = f.store.getDocumentExtractionBundle(f.documentId).manifest;
      const memory = { ...current, spans: [...current.spans, nextFinding, nextDate] };
      const beforePreview = db.prepare('SELECT total_changes() AS count').get();
      expect(f.store.previewDirectOriginalAdmission({ personId: f.person.id, documentId: f.documentId, manifest: memory,
        observations: [f.observation(incoming)] })).toMatchObject({ mode: 'append', acceptedCount: 0, refinedCount: 1, held: [] });
      expect(db.prepare('SELECT total_changes() AS count').get()).toEqual(beforePreview);
      expect(f.store.getDocumentExtractionBundle(f.documentId).manifest.spans).toEqual(current.spans);
      f.save(nextFinding, nextDate); const issueId = f.review();
      expect(f.append([incoming], issueId)).toMatchObject({ appendedCount: 0, updatedCount: 1, duplicateCount: 0, heldCount: 0, reviewResolved: true });
      const stored = f.store.listAcceptedObservations(f.person.id);
      expect(stored).toHaveLength(1); expect(stored[0]).toMatchObject({ id: originalId, rawText: '合成文字结果', clinicalDate: null, clinicalContext: context });
      expect(db.prepare('SELECT * FROM observation_revisions WHERE observation_id=? AND revision=1').get(originalId)).toEqual(oldRevision);
      const nextRevision = db.prepare('SELECT * FROM observation_revisions WHERE observation_id=? AND revision=2').get(originalId) as Record<string, unknown>;
      for (const field of ['value_kind', 'raw_text', 'decimal_value', 'qualifier', 'unit', 'reference_range', 'abnormal_flag',
        'specimen', 'method', 'body_site', 'clinical_date', 'date_evidence_json']) expect(nextRevision[field]).toEqual(oldRevision[field]);
      expect((db.prepare('SELECT * FROM observations WHERE id=?').get(originalId) as Record<string, unknown>).encounter_id).toBe(oldObservation.encounter_id);
      expect(db.prepare('SELECT * FROM encounters ORDER BY id').all()).toEqual(oldEncounters);
      expect(db.prepare("SELECT 1 FROM audit_events WHERE event_type='observation.clinical_context_enriched' AND entity_id=?").get(originalId)).toBeTruthy();
      expect(f.append([incoming], issueId)).toMatchObject({ appendedCount: 0, updatedCount: 0, duplicateCount: 1, idempotent: true });
      expect(db.prepare('SELECT COUNT(*) AS count FROM observation_revisions WHERE observation_id=?').get(originalId)).toEqual({ count: 2 });
    } finally { db.close(); }
  });

  it.each(['nonempty', 'user_actor', 'manual_report', 'date_changed', 'value_changed'] as const)('正常条件补充不覆盖%s或绕过真实语义冲突', (mode) => {
    const f = fixture(); const finding = f.excerpt('合成文字结果'); const date = f.excerpt('合成监测区间：2026-01-01至2026-01-02', 'date'); f.save(finding, date);
    const context = { version: 1 as const, status: 'complete' as const, conditions: [{ sourceSpanId: date.id, quote: date.quote! }] };
    const original = f.candidate('合成结果', finding, undefined, { clinicalContext: mode === 'nonempty' ? context : null }); f.publish([original]);
    const before = f.store.listAcceptedObservations(f.person.id); const db = new Database(f.store.databasePath);
    try {
      if (mode === 'user_actor') {
        const previous = db.prepare('SELECT acceptance_id FROM observation_revisions WHERE observation_id=?').get(before[0]!.id) as { acceptance_id: string };
        db.prepare("UPDATE acceptance_decisions SET actor='user' WHERE id=?").run(previous.acceptance_id);
      }
      if (mode === 'manual_report') {
        const report = f.store.listReportMetadata(f.person.id)[0]!;
        f.store.updateReportMetadata({ personId: f.person.id, reportId: report.reportId, expectedRevision: report.metadataRevision,
          title: '合成人工修订', organization: null, department: null, clinicalTime: { value: null, precision: 'unknown' }, reason: '合成用户修订' });
      }
      const nextDate = f.excerpt('另一个合成监测条件', 'date'); f.save(nextDate);
      const incoming = f.candidate('合成结果', finding, undefined, { clinicalContext: { ...context,
        conditions: [{ sourceSpanId: nextDate.id, quote: nextDate.quote! }] },
        ...(mode === 'date_changed' ? { clinicalDate: '2026-01-02' } : mode === 'value_changed' ? { value: { kind: 'text', rawText: '另一个合成结果' } } : {}) });
      expect(f.append([incoming], f.review())).toMatchObject({ appendedCount: 0, updatedCount: 0, heldCount: 1, reviewResolved: false });
      expect(f.store.listAcceptedObservations(f.person.id)).toEqual(before);
    } finally { db.close(); }
  });

  it('解释条件新修订的CAS失败时整次回滚，不留下新事实版本或丢掉旧结果', () => {
    const f = fixture(); const finding = f.excerpt('合成文字结果'); const date = f.excerpt('合成监测区间：2026-01-01至2026-01-02', 'date');
    f.save(finding, date); const initial = f.candidate('合成结果', finding); f.publish([initial]); const issueId = f.review();
    const beforeFacts = f.store.listAcceptedObservations(f.person.id); const beforeRevision = f.store.getFactRevision(f.person.id);
    const db = new Database(f.store.databasePath);
    try {
      const oldRows = db.prepare('SELECT * FROM observation_revisions ORDER BY rowid').all();
      // 仅在合成库模拟更新被其他保护拒绝，最终CAS必须失败并回滚前面的INSERT。
      db.exec(`CREATE TRIGGER synthetic_context_cas_block BEFORE UPDATE OF current_revision ON observations
        WHEN NEW.current_revision=OLD.current_revision+1 BEGIN SELECT RAISE(IGNORE); END;`);
      const incoming = { ...initial, clinicalContext: { version: 1 as const, status: 'complete' as const,
        conditions: [{ sourceSpanId: date.id, quote: date.quote! }] } };
      expect(() => f.append([incoming], issueId)).toThrow('OBSERVATION_REFINEMENT_STATE_CHANGED');
      expect(db.prepare('SELECT * FROM observation_revisions ORDER BY rowid').all()).toEqual(oldRows);
      expect(f.store.listAcceptedObservations(f.person.id)).toEqual(beforeFacts); expect(f.store.getFactRevision(f.person.id)).toBe(beforeRevision);
      expect(db.prepare("SELECT 1 FROM audit_events WHERE event_type='observation.clinical_context_enriched'").get()).toBeUndefined();
    } finally { db.close(); }
  });

  it('标题放在来源绑定即可，正常校验及SQLite发布不要求它重复进入通用引用', () => {
    const f = fixture(); const heading = f.excerpt('合成检查栏目', 'heading'); const finding = f.excerpt('合成文字结果');
    f.save(heading, finding);
    const candidate = f.candidate('合成检查栏目—结果', finding, heading);
    expect(evaluateDirectOriginalObservationCandidate(candidate, f.store.getDocumentExtractionBundle(f.documentId).manifest,
      { personConsistent: true, overwritesUserLockedValue: false }).decision).toBe('accept_with_warnings');
    expect(f.publish([candidate])).toMatchObject({ heldCount: 0, duplicateCount: 0 });
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(1);
  });

  it('同段内两个不同项目均保存，复读仍识别各自字段，不走旧OCR同位置合并', () => {
    const f = fixture(); const finding = f.excerpt('合成项目甲 7 U/L；合成项目乙 11 U/L'); f.save(finding);
    const candidates = ['甲', '乙'].map((name, index) => f.candidate(`合成项目${name}`, finding, undefined, {
      value: { kind: 'numeric', rawText: String([7, 11][index]), decimal: String([7, 11][index]), comparator: 'eq' }, unitRaw: 'U/L' }));
    expect(f.publish(candidates)).toMatchObject({ heldCount: 0, duplicateCount: 0 });
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(2);
    const issueId = f.review();
    expect(f.append(candidates, issueId)).toMatchObject({ duplicateCount: 2, appendedCount: 0, heldCount: 0 });
    expect(f.append(candidates, issueId)).toMatchObject({ duplicateCount: 2, appendedCount: 0, heldCount: 0, idempotent: true });
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(2);
  });

  it('不同真实标题的同名同文字结果独立保存，检查方式与部位不是来源身份猜测', () => {
    const f = fixture(); const headings = [f.excerpt('合成检查甲', 'heading'), f.excerpt('合成检查乙', 'heading')];
    const findings = [f.excerpt('合成文字结果'), f.excerpt('合成文字结果')]; f.save(...headings, ...findings);
    const candidates = headings.map((heading, index) => f.candidate('合成结果', findings[index]!, heading,
      { method: `合成方式${index}`, bodySite: `合成部位${index}` }));
    expect(f.publish(candidates)).toMatchObject({ heldCount: 0 });
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(2);
    expect(f.append(candidates, f.review())).toMatchObject({ duplicateCount: 2, appendedCount: 0, heldCount: 0 });
  });

  it('重复佐证不占主字段槽位，来源回执编号变化也不新增重复事实', () => {
    const f = fixture(); const heading = f.excerpt('合成固定栏目', 'heading'); const first = f.excerpt('合成文字结果');
    const duplicate = f.excerpt('另一处合成相同结果'); f.save(heading, first, duplicate);
    const original = f.candidate('合成固定栏目—结果', first, heading);
    const corroboration = { sourceSpanId: duplicate.id, quote: duplicate.quote, sourceRole: 'duplicate_source' as const,
      duplicateBasis: 'report_structure' as const };
    const withDuplicate = { ...original, evidence: [...original.evidence, corroboration], sourceBinding: {
      ...original.sourceBinding!, findingEvidence: [...original.sourceBinding!.findingEvidence, corroboration] } };
    expect(f.publish([withDuplicate])).toMatchObject({ heldCount: 0 });
    const second = f.excerpt('合成文字结果'); const secondHeading = f.excerpt('合成固定栏目', 'heading'); f.save(second, secondHeading);
    expect(f.append([f.candidate(original.originalName, second, secondHeading)], f.review()))
      .toMatchObject({ appendedCount: 0, duplicateCount: 1, heldCount: 0 });
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(1);
  });

  it('窄引用只绑定对应片段，整段其他字段不会被误判占用同一个槽位', () => {
    const f = fixture(); const finding = f.excerpt('合成字段甲：文字甲；合成字段乙：文字乙'); f.save(finding);
    const candidates = ['甲', '乙'].map((name) => {
      const ref = { sourceSpanId: finding.id, quote: `合成字段${name}：文字${name}`, sourceRole: 'primary' as const };
      return f.candidate(`合成字段${name}`, finding, undefined, { value: { kind: 'text', rawText: `文字${name}` },
        evidence: [ref], sourceBinding: { headingEvidence: [], findingEvidence: [ref] } });
    });
    expect(f.publish(candidates)).toMatchObject({ heldCount: 0 });
    expect(f.append(candidates, f.review())).toMatchObject({ duplicateCount: 2, appendedCount: 0, heldCount: 0 });
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(2);
  });

  it.each(['column', 'row'] as const)('同项目同标题的不同真实%s槽位可分别保存和复读，不把日期或值当身份', (position) => {
    const f = fixture(); const heading = f.excerpt('合成同名指标', 'heading');
    const labels = position === 'column' ? ['历史列甲', '历史列乙'] : ['实际行甲', '实际行乙'];
    const finding = f.excerpt(`合成同名指标；${labels[0]}：7 U/L；${labels[1]}：11 U/L`);
    f.save(heading, finding);
    const candidates = labels.map((label, index) => {
      const value = String([7, 11][index]);
      const ref = { sourceSpanId: finding.id, quote: `${label}：${value} U/L`, sourceRole: 'primary' as const };
      return f.candidate('合成同名指标', finding, heading, {
        value: { kind: 'numeric', rawText: value, decimal: value, comparator: 'eq' }, unitRaw: 'U/L',
        evidence: [ref], sourceBinding: { headingEvidence: [{ sourceSpanId: heading.id, quote: heading.quote }], findingEvidence: [ref] } });
    });
    expect(f.publish(candidates)).toMatchObject({ heldCount: 0, duplicateCount: 0 });
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(2);
    expect(f.append(candidates, f.review())).toMatchObject({ appendedCount: 0, duplicateCount: 2, heldCount: 0 });
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(2);
  });

  it.each(['value', 'numeric', 'comparator', 'date', 'side', 'negation', 'method'] as const)('真实同字段%s矛盾仍保留核对，不修改已有结果', (change) => {
    const f = fixture(); const heading = f.excerpt('合成固定栏目', 'heading'); const finding = f.excerpt('合成文字结果'); f.save(heading, finding);
    const date = f.excerpt('合成检查日期：2026-01-01', 'date'); f.save(date);
    const initial = f.candidate('合成固定结果', finding, heading, { method: '合成方式甲', bodySite: '合成左侧',
      ...(change === 'numeric' || change === 'comparator'
        ? { value: { kind: 'numeric' as const, rawText: '<7', decimal: '7', comparator: 'lt' as const }, unitRaw: 'U/L' } : {}),
      ...(change === 'date' ? { clinicalDate: '2026-01-01', evidence: [
        { sourceSpanId: finding.id, quote: finding.quote }, { sourceSpanId: date.id, quote: date.quote }] } : {}) });
    f.publish([initial]); const issueId = f.review();
    const changes: Partial<ObservationCandidate> = change === 'value' ? { value: { kind: 'text', rawText: '合成不同结果' } }
      : change === 'numeric' ? { value: { kind: 'numeric', rawText: '<8', decimal: '8', comparator: 'lt' } }
      : change === 'comparator' ? { value: { kind: 'numeric', rawText: '>7', decimal: '7', comparator: 'gt' } }
      : change === 'date' ? { clinicalDate: '2026-02-02' }
      : change === 'side' ? { bodySite: '合成右侧' }
      : change === 'negation' ? { value: { kind: 'text', rawText: '未见合成文字结果' } }
      : { method: '合成方式乙' };
    const before = f.store.listAcceptedObservations(f.person.id);
    expect(f.append([{ ...initial, ...changes }], issueId)).toMatchObject({ appendedCount: 0, duplicateCount: 0, updatedCount: 0, heldCount: 1 });
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual(before);
  });

  it('同轮同字段的真实矛盾整组拦截，不靠字段标签放行后来的重复项', () => {
    const f = fixture(); const heading = f.excerpt('合成固定栏目', 'heading'); const finding = f.excerpt('合成文字结果'); f.save(heading, finding);
    const initial = f.candidate('合成固定结果', finding, heading);
    expect(f.publish([initial, { ...initial, localKey: randomUUID(), method: '合成不同方法' },
      { ...initial, localKey: randomUUID() }])).toMatchObject({ heldCount: 3 });
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(0);
  });

  it('同字段出现不同摘录范围的新冲突时仍整组拦截，不让后续重复项复活', () => {
    const f = fixture(); const heading = f.excerpt('合成固定栏目', 'heading');
    const finding = f.excerpt('合成固定结果 7 U/L；补充说明'); f.save(heading, finding);
    const full = f.candidate('合成固定结果', finding, heading, {
      value: { kind: 'numeric', rawText: '7', decimal: '7', comparator: 'eq' }, unitRaw: 'U/L' });
    const narrowRef = { sourceSpanId: finding.id, quote: '合成固定结果 7 U/L', sourceRole: 'primary' as const };
    const narrow = { ...full, localKey: randomUUID(), method: '合成不同方法', evidence: [narrowRef],
      sourceBinding: { headingEvidence: full.sourceBinding!.headingEvidence, findingEvidence: [narrowRef] } };
    expect(f.publish([full, narrow, { ...full, localKey: randomUUID() }])).toMatchObject({ heldCount: 3 });
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(0);
  });

  it('宽引用连接两个窄槽时矛盾按传递整组保留，末尾重复候选不能复活', () => {
    const f = fixture(); const heading = f.excerpt('合成同名指标', 'heading');
    const finding = f.excerpt('实际行甲：7 U/L；实际行乙：11 U/L'); f.save(heading, finding);
    const item = (quote: string | null, value: string) => {
      const ref = { sourceSpanId: finding.id, quote, sourceRole: 'primary' as const };
      return f.candidate('合成同名指标', finding, heading, {
        value: { kind: 'numeric', rawText: value, decimal: value, comparator: 'eq' }, unitRaw: 'U/L', evidence: [ref],
        sourceBinding: { headingEvidence: [{ sourceSpanId: heading.id, quote: heading.quote }], findingEvidence: [ref] } });
    };
    const first = item('实际行甲：7 U/L', '7'); const last = item('实际行乙：11 U/L', '11');
    expect(f.publish([first, item(finding.quote, '7'), last, { ...first, localKey: randomUUID() }]))
      .toMatchObject({ heldCount: 4 });
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(0);
  });

  it('旧已接纳direct绑定仅在内存重算，重跑不新增且不改写旧事实或旧绑定JSON', () => {
    const f = fixture(); const heading = f.excerpt('合成固定栏目', 'heading'); const finding = f.excerpt('合成文字结果'); f.save(heading, finding);
    // 模拟旧直接读取只将标题放在通用引用，绑定key没有标题/字段信息。
    const initial = f.candidate('合成固定结果', finding, undefined, {
      evidence: [{ sourceSpanId: heading.id, quote: heading.quote }, { sourceSpanId: finding.id, quote: finding.quote }], sourceBinding: undefined });
    f.publish([initial]); const issueId = f.review();
    const db = new Database(f.store.databasePath);
    const row = db.prepare('SELECT observation_id,source_binding_json FROM observation_revisions').get() as
      { observation_id: string; source_binding_json: string };
    const legacy = JSON.parse(row.source_binding_json) as Record<string, unknown>;
    delete legacy.directOriginalField;
    legacy.key = 'synthetic-old-direct-key';
    const oldBinding = JSON.stringify(legacy);
    db.prepare('UPDATE observation_revisions SET source_binding_json=? WHERE observation_id=?').run(oldBinding, row.observation_id);
    const before = f.store.listAcceptedObservations(f.person.id);
    const nextHeading = f.excerpt('合成固定栏目', 'heading'); const nextFinding = f.excerpt('合成文字结果'); f.save(nextHeading, nextFinding);
    expect(f.append([f.candidate(initial.originalName, nextFinding, nextHeading)], issueId))
      .toMatchObject({ duplicateCount: 1, appendedCount: 0, updatedCount: 0, heldCount: 0 });
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual(before);
    expect((db.prepare('SELECT source_binding_json FROM observation_revisions WHERE observation_id=? AND revision=1')
      .get(row.observation_id) as { source_binding_json: string }).source_binding_json).toBe(oldBinding);
    expect(f.store.integrityCheck()).toBe('ok'); db.close();
  });

  it('原件hash与成员范围仍校验，异来源模型出处不能接纳', () => {
    const f = fixture(); const finding = f.excerpt('合成文字结果'); finding.modelEvidence!.originalSha256 = 'f'.repeat(64);
    expect(() => f.save(finding)).toThrow('DIRECT_ORIGINAL_EXCERPT_PROVENANCE_INVALID');
    const valid = f.excerpt('合成文字结果'); f.save(valid); const candidate = f.candidate('合成固定结果', valid);
    f.publish([candidate]); const issueId = f.review();
    expect(() => f.store.appendCommittedFacts({ personId: f.otherPerson.id, documentId: f.documentId,
      expectedRevision: 0, observations: [f.observation(candidate)], summary: '合成越界调用',
      reviewUpdate: { issueId, remainingCandidates: [], remainingReasonCodes: [], remainingEvidenceRefs: [] } }))
      .toThrow('DOCUMENT_PERSON_SCOPE_MISMATCH');
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(1);
    expect(f.store.listAcceptedObservations(f.otherPerson.id)).toHaveLength(0);
  });

  it('旧OCR与新direct混合视图不能只凭同页同值认定同字段，既有事实保持不变', () => {
    const f = fixture();
    const legacy: SourceSpan = { id: randomUUID(), documentId: f.documentId, spanKind: 'line', page: 1,
      blockId: 'synthetic-legacy-line', lineStart: 1, lineEnd: 1, quote: '合成指标 7 U/L', readability: 'clear' };
    f.store.replaceSourceManifestForReprocessing({ ...f.manifest, normalizerVersion: 'synthetic-legacy-v1',
      spans: [legacy] }, { executionGuard: f.guard });
    const legacySource = f.store.getDocumentExtractionBundle(f.documentId).manifest.spans[0]!;
    const oldCandidate = f.candidate('合成指标', legacySource, undefined, {
      value: { kind: 'numeric', rawText: '7', decimal: '7', comparator: 'eq' }, unitRaw: 'U/L', sourceBinding: undefined });
    const oldObservation = f.observation(oldCandidate);
    delete oldObservation.candidate;
    f.store.publishFacts({ personId: f.person.id, documentId: f.documentId, expectedRevision: 0,
      documentCommitKey: 'a'.repeat(64), changeSetHash: 'b'.repeat(64), summary: '合成旧OCR保存', observations: [oldObservation] });
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(1);
    const issueId = f.review();
    f.store.replaceSourceManifestForReprocessing(f.manifest, { executionGuard: f.guard });
    const parent = f.store.getDocumentExtractionBundle(f.documentId).manifest.spans[0]!;
    const finding = f.excerpt('合成指标 7 U/L'); const heading = f.excerpt('合成指标', 'heading');
    for (const span of [finding, heading]) {
      span.blockId = `model-original-excerpt:${parent.id}`;
      span.modelEvidence!.parentSourceSpanId = parent.id;
    }
    f.save(finding, heading);
    const incoming = f.candidate('合成指标', finding, heading, { value: oldCandidate.value, unitRaw: 'U/L' });
    const before = f.store.listAcceptedObservations(f.person.id);
    expect(f.append([incoming], issueId)).toMatchObject({ appendedCount: 0, duplicateCount: 0, updatedCount: 0, heldCount: 1 });
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual(before);
  });
});

describe('真实读取回执限定的短引用来源补齐', () => {
  function mappedFixture(crossPage = false, repeated = false, protect?: 'user_actor' | 'user_lock', changes: Partial<ObservationCandidate> = {}) {
    const f = fixture(crossPage); const db = (f.store as unknown as { db: Database.Database }).db;
    const page = f.manifest.spans[0]!;
    const findingPage = crossPage ? f.manifest.spans[1]! : page;
    const oldFinding = f.excerpt('合成文字结果。', 'instruction');
    oldFinding.page = findingPage.page; oldFinding.modelEvidence!.parentSourceSpanId = findingPage.id;
    oldFinding.blockId = `model-original-excerpt:${findingPage.id}`;
    const original = f.candidate('合成安排', oldFinding);
    f.save(oldFinding); f.publish([original]);
    const id = f.store.listAcceptedObservations(f.person.id)[0]!.id;
    if (protect === 'user_actor') db.prepare("UPDATE acceptance_decisions SET actor='user' WHERE id IN (SELECT acceptance_id FROM observation_revisions)").run();
    if (protect === 'user_lock') f.store.setObservationConceptMapping({ personId: f.person.id, observationId: id,
      conceptId: conceptDictionary[0]!.id, reason: '合成用户锁定' });
    const firstReading: DirectOriginalReadingResult = directOriginalReadingResultSchema.parse({ schemaVersion: 1, documentId: f.documentId,
      pageReadings: [page, ...(crossPage ? [findingPage] : [])].map((item) => ({ sourceSpanId: item.id, status: 'read' })),
      sourceExcerpts: [
        { localKey: 'e-finding', pageSourceSpanId: findingPage.id, quote: `合成栏目甲续文：合成文字结果。${repeated ? '另一处合成文字结果。' : '保留其后条件。'}`,
          role: 'instruction', clarity: 'clear' },
        { localKey: 'e-heading', pageSourceSpanId: page.id, quote: '合成栏目甲', role: 'heading', clarity: 'clear' }
      ], extraction: { schemaVersion: 1, documentId: f.documentId,
        subject: { reportedName: null, evidence: [], confidence: 'absent' }, reportMetadata: null,
        coveredSourceSpanIds: [page.id, ...(crossPage ? [findingPage.id] : [])], candidates: [{ ...original, ...changes, localKey: 'c-result',
          evidence: [{ sourceSpanId: 'e-finding', quote: oldFinding.quote }],
          sourceBinding: { headingEvidence: [{ sourceSpanId: 'e-heading', quote: '合成栏目甲' }],
            findingEvidence: [{ sourceSpanId: 'e-finding', quote: oldFinding.quote, sourceRole: 'primary' }] } }] } });
    const firstReceipt = { threadId: randomUUID(), turnId: randomUUID() };
    const repairReceipt = { threadId: randomUUID(), turnId: randomUUID() };
    const ids = new Map(firstReading.sourceExcerpts.map((excerpt) => [excerpt.localKey,
      `model-original-${stableHash({ documentId: f.documentId, originalSha256: f.manifest.sha256,
        parentId: excerpt.pageSourceSpanId, localKey: excerpt.localKey, receipt: firstReceipt,
        quote: excerpt.quote, role: excerpt.role }).slice(0, 40)}`]));
    const newSpans: SourceSpan[] = firstReading.sourceExcerpts.map((excerpt) => ({ id: ids.get(excerpt.localKey)!,
      documentId: f.documentId, spanKind: 'block', page: excerpt.pageSourceSpanId === page.id ? 1 : 2,
      blockId: `model-original-excerpt:${excerpt.pageSourceSpanId}`, lineStart: null, lineEnd: null,
      quote: excerpt.quote, readability: 'clear', modelEvidence: { version: 1, engine: 'codex-original-reading-v1',
        modelId: 'gpt-6.1-sol', ...firstReceipt, originalSha256: f.manifest.sha256,
        originalSourceObjectId: f.manifest.sourceObjectId, parentSourceSpanId: excerpt.pageSourceSpanId,
        inputKind: 'image', role: excerpt.role, clarity: excerpt.clarity } }));
    const local = firstReading.extraction.candidates[0]!;
    const candidate: ObservationCandidate = { ...local,
      evidence: local.evidence.map((ref) => ({ ...ref, sourceSpanId: ids.get(ref.sourceSpanId)! })),
      sourceBinding: { headingEvidence: local.sourceBinding!.headingEvidence.map((ref) => ({ ...ref, sourceSpanId: ids.get(ref.sourceSpanId)! })),
        findingEvidence: local.sourceBinding!.findingEvidence.map((ref) => ({ ...ref, sourceSpanId: ids.get(ref.sourceSpanId)! })) } };
    const memory = { ...f.store.getDocumentExtractionBundle(f.documentId).manifest,
      spans: [...f.store.getDocumentExtractionBundle(f.documentId).manifest.spans, ...newSpans] };
    // 重复短句会先在来源定位阶段拦住；只为取得应用旧行CAS，用清晰整段的只读预检诊断取版本。
    const comparisonCandidate = repeated ? { ...candidate, originalName: original.originalName, evidence: [{ sourceSpanId: ids.get('e-finding')!,
      quote: firstReading.sourceExcerpts[0]!.quote }], sourceBinding: { ...candidate.sourceBinding!,
      findingEvidence: [{ sourceSpanId: ids.get('e-finding')!, quote: firstReading.sourceExcerpts[0]!.quote, sourceRole: 'primary' as const }] } }
      : { ...candidate, originalName: original.originalName };
    const preliminary = f.store.previewDirectOriginalAdmission({ personId: f.person.id, documentId: f.documentId,
      manifest: memory, observations: [f.observation(comparisonCandidate)], executionGuard: f.guard });
    const comparison = preliminary.held.flatMap((item) => item.diagnostic?.comparisons ?? []).find((item) => item.recordId === id)!;
    expect(comparison?.recordRevision).toBe(1); expect(comparison?.recordHash).toMatch(/^[a-f0-9]{64}$/);
    const firstTransmissionId = f.store.beginAiTransmission({ guard: f.guard, documentId: f.documentId, stage: 'extract' });
    const repairTransmissionId = f.store.beginAiTransmission({ guard: f.guard, documentId: f.documentId, stage: 'repair_extraction' });
    const review: DirectOriginalSourceRefinementReview = { sourceObjectId: f.manifest.sourceObjectId,
      originalSha256: f.manifest.sha256, factRevision: f.store.getFactRevision(f.person.id), firstReading,
      repair: directOriginalReadingRepairSchema.parse({ schemaVersion: 1, documentId: f.documentId, originalReadingHash: stableHash(firstReading),
        results: [{ targetId: 'c-result', action: 'unchanged', replacement: null }],
        sourceMappings: [{ candidateKey: 'c-result', comparisonRecordKey: 'ro_record_1', relation: 'same_original_field' }] }),
      targets: [{ targetId: 'c-result', nodeType: 'candidate' }],
      allowedPageSourceSpanIds: firstReading.pageReadings.map((item) => item.sourceSpanId),
      refinementTargets: [{ candidateKey: 'c-result', comparisonRecordKey: 'ro_record_1', recordId: id,
        recordRevision: comparison.recordRevision!, recordHash: comparison.recordHash! }],
      firstTransmissionId, firstInputSignature: stableHash({ synthetic: 'first', documentId: f.documentId }),
      repairTransmissionId, repairInputSignature: '' };
    review.repairInputSignature = directOriginalSourceRefinementReviewSignature(review);
    const finish = () => {
      f.store.finishDirectOriginalTransmission({ guard: f.guard, documentId: f.documentId, transmissionId: firstTransmissionId,
        inputSignature: review.firstInputSignature, outputHash: stableHash(firstReading), ...firstReceipt,
        proofVersion: DIRECT_ORIGINAL_SOURCE_REFINEMENT_VERSION });
      f.store.finishDirectOriginalTransmission({ guard: f.guard, documentId: f.documentId, transmissionId: repairTransmissionId,
        inputSignature: review.repairInputSignature, outputHash: stableHash(review.repair), ...repairReceipt,
        proofVersion: DIRECT_ORIGINAL_SOURCE_REFINEMENT_VERSION });
    };
    const preview = (sourceRefinementReview: DirectOriginalSourceRefinementReview | undefined = review) => f.store.previewDirectOriginalAdmission({
      personId: f.person.id, documentId: f.documentId, manifest: memory, observations: [f.observation(candidate)],
      ...(sourceRefinementReview ? { sourceRefinementReview } : {}), executionGuard: f.guard });
    const append = (issueId: string, observations = [candidate]) => f.store.appendCommittedFacts({ personId: f.person.id,
      documentId: f.documentId, expectedRevision: f.store.getFactRevision(f.person.id), observations: observations.map(f.observation),
      summary: '合成正式来源补齐', sourceRefinementReview: review, executionGuard: f.guard,
      reviewUpdate: { issueId, remainingCandidates: [], remainingReasonCodes: [], remainingEvidenceRefs: [] } });
    return { ...f, db, id, original, candidate, memory, sourceReview: review, newSpans, finish, preview, append };
  }

  it.each([false, true])('短来源扩大并补明确栏目，跨页=%s：预检零写，正式修订只补来源并保留旧版本', (crossPage) => {
    const f = mappedFixture(crossPage); f.finish();
    const before = f.db.prepare('SELECT * FROM observation_revisions WHERE observation_id=? AND revision=1').get(f.id) as Record<string, unknown>;
    const beforeObservation = f.db.prepare('SELECT * FROM observations WHERE id=?').get(f.id) as Record<string, unknown>;
    const revision = f.store.getFactRevision(f.person.id);
    const changes = f.db.prepare('SELECT total_changes() AS count').get();
    const oldSpans = f.store.getDocumentExtractionBundle(f.documentId).manifest.spans;
    expect(f.preview()).toMatchObject({ acceptedCount: 0, refinedCount: 1, held: [] });
    expect(f.db.prepare('SELECT total_changes() AS count').get()).toEqual(changes);
    expect(f.store.getDocumentExtractionBundle(f.documentId).manifest.spans).toEqual(oldSpans);
    f.save(...f.newSpans);
    expect(f.append(f.review())).toMatchObject({ appendedCount: 0, updatedCount: 1, heldCount: 0 });
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(1);
    expect(f.store.getFactRevision(f.person.id)).toBe(revision + 1);
    expect(f.db.prepare('SELECT * FROM observation_revisions WHERE observation_id=? AND revision=1').get(f.id)).toEqual(before);
    const next = f.db.prepare('SELECT * FROM observation_revisions WHERE observation_id=? AND revision=2').get(f.id) as Record<string, unknown>;
    for (const field of ['value_kind', 'raw_text', 'decimal_value', 'qualifier', 'unit', 'reference_range', 'abnormal_flag',
      'specimen', 'method', 'body_site', 'clinical_date', 'clinical_context_json', 'date_evidence_json']) expect(next[field]).toEqual(before[field]);
    expect(JSON.parse(next.evidence_json as string)).toEqual(expect.arrayContaining(JSON.parse(before.evidence_json as string)));
    expect(JSON.parse(next.source_binding_json as string).directOriginalField.headingKeys).toHaveLength(1);
    expect(next.supersedes).toBe(1);
    expect((f.db.prepare('SELECT * FROM observations WHERE id=?').get(f.id) as Record<string, unknown>).encounter_id).toBe(beforeObservation.encounter_id);
    expect(f.db.prepare("SELECT 1 FROM audit_events WHERE event_type='observation.source_binding_enriched' AND entity_id=?").get(f.id)).toBeTruthy();
    // 来源修订使事实版本前进后，原回执不能再次用于下一次写入。
    expect(() => f.preview()).toThrow('DIRECT_ORIGINAL_SOURCE_REFINEMENT_REVIEW_INVALID');
  });

  it('未带正式映射时，短引用与扩大引用的旧保守行为不放宽', () => {
    const f = mappedFixture(); f.finish();
    expect(f.store.previewDirectOriginalAdmission({ personId: f.person.id, documentId: f.documentId, manifest: f.memory,
      observations: [f.observation(f.candidate)], executionGuard: f.guard })).toMatchObject({ refinedCount: 0, held: expect.any(Array) });
    f.save(...f.newSpans);
    expect(f.store.appendCommittedFacts({ personId: f.person.id, documentId: f.documentId, expectedRevision: f.store.getFactRevision(f.person.id),
      observations: [f.observation(f.candidate)], summary: '合成无映射对照', executionGuard: f.guard,
      reviewUpdate: { issueId: f.review(), remainingCandidates: [], remainingReasonCodes: [], remainingEvidenceRefs: [] } }))
      .toMatchObject({ appendedCount: 0, updatedCount: 0, heldCount: 1 });
  });

  it.each(['missing_receipt', 'wrong_job', 'wrong_hash', 'wrong_revision', 'wrong_record_hash', 'changed_candidate'] as const)(
    '%s无法把来源映射变成写入权限', (mode) => {
      const f = mappedFixture(); if (mode !== 'missing_receipt') f.finish();
      if (mode === 'wrong_job') {
        const otherBatch = f.store.createWaitingAuthBatch({ cutoff: '2026-01-01T00:00:00Z', consentId: f.guard.consentId,
          initialStatus: 'queued', groups: [{ personId: f.person.id, documentIds: [f.documentId], stage: 'extract', inputSignature: randomUUID() }] });
        f.db.prepare('UPDATE ai_transmissions SET job_id=? WHERE id=?').run(otherBatch.jobIds[0]!, f.sourceReview.repairTransmissionId);
      }
      if (mode === 'wrong_hash') f.sourceReview.originalSha256 = 'f'.repeat(64);
      if (mode === 'wrong_revision') f.sourceReview.refinementTargets[0]!.recordRevision++;
      if (mode === 'wrong_record_hash') f.sourceReview.refinementTargets[0]!.recordHash = 'f'.repeat(64);
      if (mode === 'changed_candidate') f.candidate.value = { kind: 'text', rawText: '不能覆盖的另一个结果' };
      const before = f.store.listAcceptedObservations(f.person.id); const revision = f.store.getFactRevision(f.person.id);
      expect(() => f.preview()).toThrow();
      f.save(...f.newSpans);
      expect(() => f.append(f.review())).toThrow();
      expect(f.store.listAcceptedObservations(f.person.id)).toEqual(before);
      expect(f.store.getFactRevision(f.person.id)).toBe(revision);
      expect(f.db.prepare('SELECT COUNT(*) AS count FROM observation_revisions WHERE observation_id=?').get(f.id)).toEqual({ count: 1 });
    });

  it.each(['user_actor', 'user_lock', 'repeated_source'] as const)('%s即使回执完备也不补来源或覆盖原记录', (mode) => {
    const f = mappedFixture(true, mode === 'repeated_source', mode === 'user_actor' || mode === 'user_lock' ? mode : undefined);
    f.finish(); const before = f.store.listAcceptedObservations(f.person.id); const revision = f.store.getFactRevision(f.person.id);
    expect(f.preview()).toMatchObject({ refinedCount: 0 });
    f.save(...f.newSpans);
    expect(f.append(f.review())).toMatchObject({ appendedCount: 0, updatedCount: 0, heldCount: 1 });
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual(before); expect(f.store.getFactRevision(f.person.id)).toBe(revision);
  });

  it.each(['value', 'negation', 'unit', 'date', 'body_site', 'method', 'specimen', 'name'] as const)(
    '模型回执有效但%s变化时仍保留旧医疗内容，不借来源补齐改结果', (mode) => {
      const changes: Partial<ObservationCandidate> = mode === 'value' ? { value: { kind: 'text', rawText: '另一个合成结果' } }
        : mode === 'negation' ? { value: { kind: 'text', rawText: '未见合成文字结果' } }
        : mode === 'unit' ? { unitRaw: 'cm/s' } : mode === 'date' ? { clinicalDate: '2026-03-04' }
        : mode === 'body_site' ? { bodySite: '合成右侧' } : mode === 'method' ? { method: '合成另一方式' }
        : mode === 'specimen' ? { specimen: '合成另一标本' } : { originalName: '合成另一个安排' };
      const f = mappedFixture(false, false, undefined, changes); f.finish();
      const before = f.store.listAcceptedObservations(f.person.id); const revision = f.store.getFactRevision(f.person.id);
      expect(f.preview()).toMatchObject({ refinedCount: 0 });
      f.save(...f.newSpans);
      expect(f.append(f.review())).toMatchObject({ appendedCount: 0, updatedCount: 0, heldCount: 1 });
      expect(f.store.listAcceptedObservations(f.person.id)).toEqual(before); expect(f.store.getFactRevision(f.person.id)).toBe(revision);
    });

  it('已签名旧行在核查后发生变化时CAS拒绝，不能沿用旧目标指纹补来源', () => {
    const f = mappedFixture(); f.finish();
    f.db.prepare("UPDATE acceptance_decisions SET actor='user' WHERE id IN (SELECT acceptance_id FROM observation_revisions WHERE observation_id=?)").run(f.id);
    const before = f.store.listAcceptedObservations(f.person.id); const changes = f.db.prepare('SELECT total_changes() AS count').get();
    expect(() => f.preview()).toThrow('DIRECT_ORIGINAL_SOURCE_REFINEMENT_VERSION_CHANGED');
    expect(f.db.prepare('SELECT total_changes() AS count').get()).toEqual(changes);
    f.save(...f.newSpans);
    expect(() => f.append(f.review())).toThrow('DIRECT_ORIGINAL_SOURCE_REFINEMENT_VERSION_CHANGED');
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual(before);
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM observation_revisions WHERE observation_id=?').get(f.id)).toEqual({ count: 1 });
  });

  it.each(['originalName', 'rawText', 'valueKind', 'decimalValue', 'qualifier', 'unit', 'referenceRange', 'abnormalFlag',
    'specimen', 'method', 'bodySite', 'clinicalDate', 'clinicalContext', 'sourceSpanId', 'evidence', 'sourceBinding'] as const)(
    '真实candidate未变但外层%s被偷换时，不能借有效回执获得来源修订权限', (field) => {
      const f = mappedFixture(); f.finish();
      const observation = f.observation(f.candidate);
      const changes: Record<typeof field, unknown> = { [field]: field === 'clinicalContext'
        ? { version: 1, status: 'complete', conditions: [] } : field === 'evidence' ? []
        : field === 'sourceBinding' ? { headingEvidence: [], findingEvidence: f.candidate.sourceBinding!.findingEvidence }
        : field === 'valueKind' ? 'qualitative' : field === 'decimalValue' ? '7' : field === 'clinicalDate' ? '2026-03-04'
        : field === 'abnormalFlag' ? 'high' : '合成偷换内容' } as Record<typeof field, unknown>;
      Object.assign(observation, changes);
      const before = f.store.listAcceptedObservations(f.person.id); const revision = f.store.getFactRevision(f.person.id);
      expect(() => f.store.previewDirectOriginalAdmission({ personId: f.person.id, documentId: f.documentId, manifest: f.memory,
        observations: [observation], sourceRefinementReview: f.sourceReview, executionGuard: f.guard }))
        .toThrow(field === 'clinicalDate' ? 'DIRECT_ORIGINAL_FIELD_PROJECTION_REQUIRED'
          : 'DIRECT_ORIGINAL_SOURCE_REFINEMENT_CANDIDATE_CHANGED');
      f.save(...f.newSpans);
      expect(() => f.store.appendCommittedFacts({ personId: f.person.id, documentId: f.documentId, expectedRevision: revision,
        observations: [observation], sourceRefinementReview: f.sourceReview, summary: '合成外层篡改防护', executionGuard: f.guard,
        reviewUpdate: { issueId: f.review(), remainingCandidates: [], remainingReasonCodes: [], remainingEvidenceRefs: [] } })).toThrow();
      expect(f.store.listAcceptedObservations(f.person.id)).toEqual(before); expect(f.store.getFactRevision(f.person.id)).toBe(revision);
    });

  it('P03真实候选已改变结果，外围偷换回旧值也不能伪装成“医疗值未变”的来源补齐', () => {
    const f = mappedFixture(false, false, undefined, { value: { kind: 'text', rawText: '另一个合成结果' } }); f.finish();
    const observation = { ...f.observation(f.candidate), rawText: f.original.value.rawText! };
    const before = f.store.listAcceptedObservations(f.person.id); const revision = f.store.getFactRevision(f.person.id);
    expect(() => f.store.previewDirectOriginalAdmission({ personId: f.person.id, documentId: f.documentId,
      manifest: f.memory, observations: [observation], sourceRefinementReview: f.sourceReview, executionGuard: f.guard }))
      .toThrow('DIRECT_ORIGINAL_SOURCE_REFINEMENT_CANDIDATE_CHANGED');
    f.save(...f.newSpans);
    expect(() => f.store.appendCommittedFacts({ personId: f.person.id, documentId: f.documentId, expectedRevision: revision,
      observations: [observation], sourceRefinementReview: f.sourceReview, summary: '合成旧值伪装防护', executionGuard: f.guard,
      reviewUpdate: { issueId: f.review(), remainingCandidates: [], remainingReasonCodes: [], remainingEvidenceRefs: [] } }))
      .toThrow('DIRECT_ORIGINAL_SOURCE_REFINEMENT_CANDIDATE_CHANGED');
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual(before); expect(f.store.getFactRevision(f.person.id)).toBe(revision);
  });

  it.each([false, true])('同批短句可对应两个扩大新槽，反向输入=%s：真实一对一回执也不能抢先补齐', (reverse) => {
    const f = mappedFixture();
    const secondOriginal = { ...f.original, localKey: 'old-other', originalName: '合成安排乙' };
    expect(f.store.appendCommittedFacts({ personId: f.person.id, documentId: f.documentId,
      expectedRevision: f.store.getFactRevision(f.person.id), summary: '合成另一个既有记录',
      observations: [f.observation(secondOriginal)], executionGuard: f.guard,
      reviewUpdate: { issueId: f.review(), remainingCandidates: [], remainingReasonCodes: [], remainingEvidenceRefs: [] } }))
      .toMatchObject({ appendedCount: 1, heldCount: 0 });
    const secondId = f.store.listAcceptedObservations(f.person.id).find((item) => item.originalName === '合成安排乙')!.id;
    const reading = f.sourceReview.firstReading;
    reading.sourceExcerpts.push({ localKey: 'e-other-finding', pageSourceSpanId: reading.pageReadings[0]!.sourceSpanId,
      quote: '合成栏目乙续文：合成文字结果。另一处保留条件。', role: 'instruction', clarity: 'clear' },
    { localKey: 'e-other-heading', pageSourceSpanId: reading.pageReadings[0]!.sourceSpanId,
      quote: '合成栏目乙', role: 'heading', clarity: 'clear' });
    reading.extraction.candidates.push({ ...secondOriginal, localKey: 'c-other',
      evidence: [{ sourceSpanId: 'e-other-finding', quote: f.original.evidence[0]!.quote }],
      sourceBinding: { headingEvidence: [{ sourceSpanId: 'e-other-heading', quote: '合成栏目乙' }],
        findingEvidence: [{ sourceSpanId: 'e-other-finding', quote: f.original.evidence[0]!.quote, sourceRole: 'primary' }] } });
    Object.assign(reading, directOriginalReadingResultSchema.parse(reading));
    const receipt = { threadId: f.newSpans[0]!.modelEvidence!.threadId, turnId: f.newSpans[0]!.modelEvidence!.turnId };
    const ids = new Map<string, string>();
    for (const excerpt of reading.sourceExcerpts) {
      const id = `model-original-${stableHash({ documentId: f.documentId, originalSha256: f.manifest.sha256,
        parentId: excerpt.pageSourceSpanId, localKey: excerpt.localKey, receipt, quote: excerpt.quote, role: excerpt.role }).slice(0, 40)}`;
      ids.set(excerpt.localKey, id);
      if (!f.newSpans.some((span) => span.id === id)) f.newSpans.push({ ...f.newSpans[0]!, id, quote: excerpt.quote,
        modelEvidence: { ...f.newSpans[0]!.modelEvidence!, role: excerpt.role, clarity: excerpt.clarity } });
    }
    const candidates = reading.extraction.candidates.map((candidate): ObservationCandidate => ({ ...candidate,
      evidence: candidate.evidence.map((ref) => ({ ...ref, sourceSpanId: ids.get(ref.sourceSpanId)! })),
      sourceBinding: { headingEvidence: candidate.sourceBinding!.headingEvidence.map((ref) => ({ ...ref, sourceSpanId: ids.get(ref.sourceSpanId)! })),
        findingEvidence: candidate.sourceBinding!.findingEvidence.map((ref) => ({ ...ref, sourceSpanId: ids.get(ref.sourceSpanId)! })) } }));
    const manifest = { ...f.store.getDocumentExtractionBundle(f.documentId).manifest,
      spans: [...f.store.getDocumentExtractionBundle(f.documentId).manifest.spans, ...f.newSpans] };
    const diagnostic = f.store.previewDirectOriginalAdmission({ personId: f.person.id, documentId: f.documentId, manifest,
      observations: candidates.map(f.observation), executionGuard: f.guard });
    const comparison = diagnostic.held.flatMap((item) => item.diagnostic?.comparisons ?? []).find((item) => item.recordId === secondId)!;
    expect(comparison?.recordHash).toMatch(/^[a-f0-9]{64}$/);
    f.sourceReview.factRevision = f.store.getFactRevision(f.person.id);
    f.sourceReview.targets.push({ targetId: 'c-other', nodeType: 'candidate' });
    f.sourceReview.refinementTargets.push({ candidateKey: 'c-other', comparisonRecordKey: 'ro_record_2', recordId: secondId,
      recordRevision: comparison.recordRevision!, recordHash: comparison.recordHash! });
    f.sourceReview.repair = directOriginalReadingRepairSchema.parse({ ...f.sourceReview.repair, originalReadingHash: stableHash(reading),
      results: [...f.sourceReview.repair.results, { targetId: 'c-other', action: 'unchanged', replacement: null }],
      sourceMappings: [...f.sourceReview.repair.sourceMappings!,
        { candidateKey: 'c-other', comparisonRecordKey: 'ro_record_2', relation: 'same_original_field' }] });
    f.sourceReview.repairInputSignature = directOriginalSourceRefinementReviewSignature(f.sourceReview);
    f.finish(); const before = f.store.listAcceptedObservations(f.person.id); const revision = f.store.getFactRevision(f.person.id);
    const observations = (reverse ? [...candidates].reverse() : candidates).map(f.observation);
    const changes = f.db.prepare('SELECT total_changes() AS count').get();
    expect(f.store.previewDirectOriginalAdmission({ personId: f.person.id, documentId: f.documentId, manifest,
      observations, sourceRefinementReview: f.sourceReview, executionGuard: f.guard }))
      .toMatchObject({ acceptedCount: 0, refinedCount: 0, held: [expect.objectContaining({ reasons: ['source_binding_ambiguous'] }),
        expect.objectContaining({ reasons: ['source_binding_ambiguous'] })] });
    expect(f.db.prepare('SELECT total_changes() AS count').get()).toEqual(changes);
    f.save(...f.newSpans);
    expect(f.store.appendCommittedFacts({ personId: f.person.id, documentId: f.documentId, expectedRevision: revision,
      observations, sourceRefinementReview: f.sourceReview, summary: '合成批次位置歧义', executionGuard: f.guard,
      reviewUpdate: { issueId: f.review(), remainingCandidates: [], remainingReasonCodes: [], remainingEvidenceRefs: [] } }))
      .toMatchObject({ appendedCount: 0, updatedCount: 0, heldCount: 2 });
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual(before); expect(f.store.getFactRevision(f.person.id)).toBe(revision);
  });
});
