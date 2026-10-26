import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClinicalContext, ObservationCandidate, SourceManifest, SourceSpan } from '@contracts';
import { candidateToReconciliationFact, reconcileReportFact, resolveDirectOriginalSourceBinding } from '@core';
import { WorkspaceStore, type PublishFactsInput } from './index.js';
import { selectCanonicalStoredObservations, type CanonicalStoredObservation } from './canonical-observations.js';

function sourceFixture(documentId = 'synthetic-doc', sourceObjectId = 'synthetic-object', sha256 = 'a'.repeat(64)) {
  const page: SourceSpan = { id: randomUUID(), documentId, spanKind: 'image', page: 1,
    blockId: 'direct-original-page:1', lineStart: null, lineEnd: null, quote: null, readability: 'clear' };
  const manifest: SourceManifest = { id: randomUUID(), sourceObjectId, sha256, mediaType: 'image/png',
    originalDisplayName: 'synthetic.png', totalUnits: 1, coveredUnitIndexes: [0], normalizerVersion: 'direct-original-v1',
    conversionWarnings: [], createdAt: '2026-01-01T00:00:00Z', spans: [page] };
  const excerpt = (quote: string, role: NonNullable<SourceSpan['modelEvidence']>['role'] = 'finding'): SourceSpan => ({
    id: randomUUID(), documentId, spanKind: 'block', page: 1, blockId: `model-original-excerpt:${page.id}`,
    lineStart: null, lineEnd: null, quote, readability: 'clear', modelEvidence: { version: 1,
      engine: 'codex-original-reading-v1', modelId: 'gpt-6.1-sol', threadId: 'synthetic-thread', turnId: randomUUID(),
      originalSha256: sha256, originalSourceObjectId: sourceObjectId, parentSourceSpanId: page.id,
      inputKind: 'image', role, clarity: 'clear' } });
  const frame = '合成左侧栏目\n合成项目 <7 U/L\n合成行结束';
  const oldFinding = excerpt(frame); const nextFinding = excerpt(`合成页首\n${frame}\n合成页末`);
  const oldHeading = excerpt('左侧栏目', 'heading'); const nextHeading = excerpt('合成左侧栏目', 'heading');
  const condition = excerpt('合成检查条件保持不变', 'context');
  manifest.spans.push(oldFinding, nextFinding, oldHeading, nextHeading, condition);
  const candidate = (next: boolean): ObservationCandidate => {
    const finding = next ? nextFinding : oldFinding; const heading = next ? nextHeading : oldHeading;
    const ref = { sourceSpanId: finding.id, quote: next ? '合成项目 <7 U/L' : '<7 U/L' };
    const headingRef = { sourceSpanId: heading.id, quote: heading.quote };
    return { localKey: randomUUID(), originalName: '合成项目', standardNameCandidate: null,
      value: { kind: 'numeric', rawText: '<7', decimal: '7', comparator: 'lt' }, unitRaw: 'U/L', referenceRangeRaw: null,
      reportedAbnormalFlag: null, specimen: null, method: null, bodySite: '左侧', clinicalDate: null,
      clinicalContext: null, evidence: [ref, headingRef],
      sourceBinding: { headingEvidence: [headingRef], findingEvidence: [ref] }, issues: [] };
  };
  const oldCandidate = candidate(false); const nextCandidate = candidate(true);
  const binding = (value: ObservationCandidate) => {
    const result = resolveDirectOriginalSourceBinding(value, manifest);
    if (result.status !== 'resolved') throw new Error(`SYNTHETIC_BINDING_FAILED:${result.reason}`);
    return result.binding;
  };
  const entry = (id: string, value: ObservationCandidate, createdAt = '2026-01-01T00:00:00Z'): CanonicalStoredObservation => ({
    observationId: id, personId: 'synthetic-person', documentId, revision: 1, createdAt, displayClinicalDate: null,
    acceptanceActor: 'policy', userLocked: false, fact: candidateToReconciliationFact(value), binding: binding(value), contextGrounded: false
  });
  const context: ClinicalContext = { version: 1, status: 'complete', conditions: [{ sourceSpanId: condition.id, quote: condition.quote! }] };
  return { manifest, oldCandidate, nextCandidate, binding, entry, context, condition };
}

describe('已保存事实的保守canonical投影', () => {
  it('同一单字段旧整行误作标题与新前缀标题只投影旧行，正式接纳也判重且不授予补写权限', () => {
    const f = sourceFixture(); const original = f.oldCandidate;
    const finding = f.manifest.spans.find((span) => span.id === original.sourceBinding!.findingEvidence[0]!.sourceSpanId)!;
    const heading = f.manifest.spans.find((span) => span.id === original.sourceBinding!.headingEvidence[0]!.sourceSpanId)!;
    finding.quote = '合成字段: 23 mm'; heading.quote = finding.quote;
    const oldRef = { sourceSpanId: finding.id, quote: finding.quote };
    const oldHeading = { sourceSpanId: heading.id, quote: heading.quote };
    const oldCandidate: ObservationCandidate = { ...original, originalName: '合成字段',
      value: { kind: 'numeric', rawText: '23', decimal: '23', comparator: 'eq' }, unitRaw: 'mm', bodySite: null,
      evidence: [oldRef, oldHeading], sourceBinding: { headingEvidence: [oldHeading], findingEvidence: [oldRef] } };
    const nextRef = { sourceSpanId: finding.id, quote: '23 mm' };
    const nextHeading = { sourceSpanId: finding.id, quote: '合成字段' };
    const nextCandidate: ObservationCandidate = { ...oldCandidate, evidence: [nextRef, nextHeading],
      sourceBinding: { headingEvidence: [nextHeading], findingEvidence: [nextRef] } };
    const old = f.entry('old', oldCandidate); const next = f.entry('next', nextCandidate, '2026-01-02');
    expect(selectCanonicalStoredObservations([old, next]).observations).toEqual([old]);
    const bound = (entry: CanonicalStoredObservation) => ({ recordId: entry.observationId, fact: entry.fact, binding: entry.binding });
    expect(reconcileReportFact(bound(next), [bound(old)], { canRefineSourceBinding: () => true }).decision).toBe('duplicate');
    const conflicting = { ...next, fact: { ...next.fact, rawText: '24', decimalValue: '24' } };
    expect(selectCanonicalStoredObservations([old, conflicting]).observations).toHaveLength(2);
    expect(reconcileReportFact(bound(conflicting), [bound(old)]).decision).not.toBe('duplicate');
    expect(selectCanonicalStoredObservations([old, next, conflicting]).observations).toHaveLength(3);
    const dated = { ...next, fact: { ...next.fact, clinicalDate: '2026-02-02' } };
    expect(reconcileReportFact(bound(dated), [bound(old)], { canRefineClinicalDate: () => true }).decision).not.toBe('enrichment');
  });

  it('完整医疗字段逐字相同时只选现有旧行，输入、ID和修订不变', () => {
    const f = sourceFixture(); const old = f.entry('old', f.oldCandidate); const next = f.entry('next', f.nextCandidate, '2026-01-02');
    const before = JSON.stringify([old, next]); const result = selectCanonicalStoredObservations([next, old]);
    expect(result.observations).toEqual([old]); expect(result.observations[0]).toBe(old);
    expect(result.canonicalIdByObservationId).toEqual(new Map([['next', 'old'], ['old', 'old']]));
    expect(JSON.stringify([old, next])).toBe(before);
  });

  it('仅缺失context时选已经保存的grounded完整行，不合成医疗字段', () => {
    const f = sourceFixture(); const old = f.entry('old', f.oldCandidate);
    const rich = { ...f.entry('rich', f.nextCandidate, '2026-01-02'), fact: { ...old.fact, clinicalContext: f.context }, contextGrounded: true };
    const selected = selectCanonicalStoredObservations([old, rich]);
    expect(selected.observations).toEqual([rich]); expect(selected.observations[0]).toBe(rich);
    expect(selected.canonicalIdByObservationId.get('old')).toBe('rich'); expect(old.fact.clinicalContext).toBeNull();
  });

  it.each(['originalName', 'rawText', 'decimalValue', 'qualifier', 'unit', 'referenceRange', 'abnormalFlag',
    'specimen', 'method', 'bodySite', 'clinicalDate', 'valueKind'] as const)('%s有任何逐字差异就整组保留', (field) => {
    const f = sourceFixture(); const old = f.entry('old', f.oldCandidate); const next = f.entry('next', f.nextCandidate);
    const fact = { ...next.fact, [field]: field === 'valueKind' ? 'text' : '另一合成字段' } as typeof next.fact;
    const result = selectCanonicalStoredObservations([old, { ...next, fact }]);
    expect(result.observations).toHaveLength(2);
  });

  it.each(['locked', 'manual', 'unverified', 'cross_person', 'cross_document', 'revision'] as const)('不绕过%s门禁', (mode) => {
    const f = sourceFixture(); const old = f.entry('old', f.oldCandidate); const next = f.entry('next', f.nextCandidate);
    if (mode === 'locked') old.userLocked = true;
    if (mode === 'manual') old.acceptanceActor = 'user';
    if (mode === 'unverified') old.binding = structuredClone(old.binding);
    if (mode === 'cross_person') old.personId = 'another-person';
    if (mode === 'cross_document') old.documentId = 'another-document';
    if (mode === 'revision') old.revision = 0;
    expect(selectCanonicalStoredObservations([old, next]).observations).toHaveLength(2);
  });

  it.each(['ungrounded', 'empty', 'unresolved', 'different'] as const)('条件%s时不能冒充安全的缺失补齐', (mode) => {
    const f = sourceFixture(); const old = f.entry('old', f.oldCandidate); const next = f.entry('next', f.nextCandidate);
    next.fact = { ...next.fact, clinicalContext: mode === 'empty' ? { version: 1, status: 'complete', conditions: [] }
      : mode === 'unresolved' ? { ...f.context, status: 'unresolved' } : f.context };
    next.contextGrounded = mode !== 'ungrounded';
    if (mode === 'different') old.fact = { ...old.fact, clinicalContext: { ...f.context,
      conditions: [{ sourceSpanId: f.condition.id, quote: '另一合成条件' }] } };
    expect(selectCanonicalStoredObservations([old, next]).observations).toHaveLength(2);
  });

  it.each(['name', 'value'] as const)('同slot第三条%s冲突时，不能先把另外两条折叠后隐藏竞争', (field) => {
    const f = sourceFixture(); const old = f.entry('old', f.oldCandidate); const next = f.entry('next', f.nextCandidate);
    const conflictingCandidate: ObservationCandidate = field === 'name'
      ? { ...f.nextCandidate, originalName: '另一合成展示名' }
      : { ...f.nextCandidate, value: { kind: 'numeric', rawText: '8', decimal: '8', comparator: 'eq' } };
    const conflict = f.entry('conflict', conflictingCandidate);
    expect(selectCanonicalStoredObservations([old, next, conflict]).observations).toHaveLength(3);
  });

  it('第三条宽来源未获同slot证明时，保留它且不冒称其已解决；独立已证重复对仍可折叠', () => {
    const f = sourceFixture(); const old = f.entry('old', f.oldCandidate); const next = f.entry('next', f.nextCandidate, '2026-01-02');
    const wideRef = { ...f.nextCandidate.sourceBinding!.findingEvidence[0]!, quote: '合成项目 <7 U/L\n合成行结束' };
    const wide = f.entry('wide', { ...f.nextCandidate, value: { kind: 'numeric', rawText: '8', decimal: '8', comparator: 'eq' },
      evidence: [wideRef, ...f.nextCandidate.sourceBinding!.headingEvidence],
      sourceBinding: { headingEvidence: f.nextCandidate.sourceBinding!.headingEvidence, findingEvidence: [wideRef] } });
    const selected = selectCanonicalStoredObservations([old, next, wide]);
    expect(selected.observations).toEqual([old, wide]);
    expect(selected.canonicalIdByObservationId.get('wide')).toBe('wide');
    expect(wide.fact.decimalValue).toBe('8');
  });

  it('重复输入ID或同报告未定位的旧事实不能为其他两条提供去重授权', () => {
    const f = sourceFixture(); const old = f.entry('old', f.oldCandidate); const next = f.entry('next', f.nextCandidate);
    expect(selectCanonicalStoredObservations([old, { ...next, observationId: 'old' }]).observations).toHaveLength(2);
    expect(selectCanonicalStoredObservations([old, next, { ...old, observationId: 'unbound', binding: null }]).observations).toHaveLength(3);
  });

  it('同原件已证明在另一页的旧未定位事实不拖住已证明同槽的重复对', () => {
    const f = sourceFixture(); const old = f.entry('old', f.oldCandidate); const next = f.entry('next', f.nextCandidate, '2026-01-02');
    const unbound = { ...old, observationId: 'unbound', binding: null, sourcePageScope: {
      documentId: f.manifest.spans[0]!.documentId, sourceObjectId: f.manifest.sourceObjectId,
      sourceSha256: f.manifest.sha256, pages: [2]
    } };
    expect(selectCanonicalStoredObservations([old, next, unbound]).observations).toEqual([old, unbound]);
    expect(selectCanonicalStoredObservations([old, next, { ...unbound, sourcePageScope: { ...unbound.sourcePageScope, pages: [1, 2] } }])
      .observations).toHaveLength(3);
    expect(selectCanonicalStoredObservations([old, next, { ...unbound, sourcePageScope: null }]).observations).toHaveLength(3);
    expect(selectCanonicalStoredObservations([old, next, { ...unbound, sourcePageScope: { ...unbound.sourcePageScope, sourceSha256: 'b'.repeat(64) } }])
      .observations).toHaveLength(3);
    const incoming = { recordId: 'new', fact: old.fact, binding: old.binding };
    expect(reconcileReportFact(incoming, [{ recordId: 'unbound', fact: old.fact, binding: null,
      sourcePageScope: unbound.sourcePageScope }]).decision).toBe('addition');
    expect(reconcileReportFact(incoming, [{ recordId: 'unbound', fact: old.fact, binding: null }]).decision).toBe('unresolved');
  });

  it('同槽纯排版等价只投影现有行，不拼接数字或吞单位/比较符差异', () => {
    const f = sourceFixture(); const old = f.entry('old', f.oldCandidate); const next = f.entry('next', f.nextCandidate, '2026-01-02');
    next.fact = { ...next.fact, originalName: '  合成项目 ', rawText: ' <７  ' };
    const before = structuredClone([old.fact, next.fact]);
    expect(selectCanonicalStoredObservations([old, next]).observations).toEqual([old]);
    expect([old.fact, next.fact]).toEqual(before);
    for (const fact of [{ ...next.fact, rawText: '<7 0' }, { ...next.fact, unit: 'u/l' },
      { ...next.fact, qualifier: 'lte' }, { ...next.fact, bodySite: '右侧' }]) {
      expect(selectCanonicalStoredObservations([old, { ...next, fact }]).observations).toHaveLength(2);
    }
  });

  it('revision日期相同但实际事件日期不同仍全部保留', () => {
    const f = sourceFixture(); const old = f.entry('old', f.oldCandidate); const next = f.entry('next', f.nextCandidate);
    old.displayClinicalDate = '2026-01-01'; next.displayClinicalDate = '2026-01-02';
    expect(old.fact.clinicalDate).toBe(next.fact.clinicalDate);
    expect(selectCanonicalStoredObservations([old, next]).observations).toHaveLength(2);
  });
});

const stores: Array<{ store: WorkspaceStore; root: string }> = [];
afterEach(() => { for (const { store, root } of stores.splice(0)) { store.close(); rmSync(root, { recursive: true, force: true }); } });

function storedFixture(rich = false, sectionContext = false) {
  const root = mkdtempSync(join(tmpdir(), 'canonical-observations-synthetic-'));
  const store = new WorkspaceStore({ rootDirectory: root, now: () => new Date('2026-01-01T00:00:00Z') }); stores.push({ store, root });
  const person = store.createPerson({ displayName: '合成成员' });
  const source = store.putSourceObject({ bytes: Buffer.from('只用于合成测试'), mediaType: 'image/png', displayName: 'synthetic.png' });
  const { documentId } = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
  const f = sourceFixture(documentId, source.id, source.sha256);
  let contextSpanId: string | null = null;
  if (sectionContext) {
    for (const [index, candidate] of [f.oldCandidate, f.nextCandidate].entries()) {
      const finding = f.manifest.spans.find((span) => span.id === candidate.sourceBinding!.findingEvidence[0]!.sourceSpanId)!;
      const heading = f.manifest.spans.find((span) => span.id === candidate.sourceBinding!.headingEvidence[0]!.sourceSpanId)!;
      finding.quote = '合成项目 <7 U/L'; heading.quote = index === 0 ? '合成章节' : '合成项目';
      const findingRef = { sourceSpanId: finding.id, quote: index === 0 ? null : '<7 U/L' };
      const headingRef = { sourceSpanId: heading.id, quote: heading.quote };
      candidate.evidence = [findingRef, headingRef];
      candidate.sourceBinding = { findingEvidence: [findingRef], headingEvidence: [headingRef] };
    }
    const template = f.manifest.spans.find((span) => span.id === f.condition.id)!;
    contextSpanId = randomUUID();
    f.manifest.spans.push({ ...structuredClone(template), id: contextSpanId,
      quote: '合成章节\n合成项目 <7 U/L\n合成记录末尾' });
  }
  store.saveSourceManifest(f.manifest);
  const acceptanceId = store.saveAcceptanceDecision({ actor: 'policy', method: 'auto', decision: 'accept', rulesVersion: 'synthetic',
    inputSignature: 'synthetic-input', outputHash: 'synthetic-output', reviewRef: null });
  const observation = (candidate: ObservationCandidate): PublishFactsInput['observations'][number] => ({
    conceptKey: candidate.originalName, originalName: candidate.originalName, rawText: '<7', valueKind: 'numeric', decimalValue: '7',
    qualifier: 'lt', unit: 'U/L', referenceRange: null, clinicalDate: null, abnormalFlag: 'unknown', documentId,
    sourceSpanId: candidate.sourceBinding!.findingEvidence[0]!.sourceSpanId, acceptanceId,
    specimen: null, method: null, bodySite: '左侧', clinicalContext: candidate.clinicalContext ?? null,
    candidate, sourceBinding: candidate.sourceBinding, evidence: candidate.evidence });
  store.publishFacts({ personId: person.id, documentId, documentCommitKey: 'a'.repeat(64), changeSetHash: 'b'.repeat(64),
    expectedRevision: 0, summary: '合成初始事实', observations: [observation(f.oldCandidate)] });
  const db = (store as unknown as { db: Database.Database }).db;
  const oldId = store.listAcceptedObservations(person.id)[0]!.id; const nextId = randomUUID();
  const nextCandidate = { ...f.nextCandidate, clinicalContext: rich ? f.context : null };
  const next = observation(nextCandidate);
  // 仅在隔离合成库重现旧版本已保存重复；生产路径没有这条写入入口。
  db.prepare(`INSERT INTO observations SELECT ?,person_id,encounter_id,concept_key,original_name,
    model_standard_name_candidate,current_revision,'2026-01-02T00:00:00Z' FROM observations WHERE id=?`).run(nextId, oldId);
  db.prepare(`INSERT INTO observation_revisions SELECT ?,revision,value_kind,raw_text,decimal_value,qualifier,unit,
    reference_range,abnormal_flag,?,acceptance_id,specimen,method,body_site,?,?,?,clinical_date,date_evidence_json,
    supersedes,'2026-01-02T00:00:00Z' FROM observation_revisions WHERE observation_id=? AND revision=1`)
    .run(nextId, next.sourceSpanId, JSON.stringify(next.evidence), next.clinicalContext == null ? null : JSON.stringify(next.clinicalContext), JSON.stringify(f.binding(nextCandidate)), oldId);
  return { ...f, store, db, root, person, documentId, oldId, nextId, next, observation, contextSpanId };
}

describe('canonical投影的存储接线', () => {
  it('未被字段引用的共同上下文持久保存，关闭重开后重证去重且物理历史不变', () => {
    const f = storedFixture(false, true);
    const before = f.db.prepare('SELECT * FROM observation_revisions ORDER BY observation_id,revision').all();
    expect(f.store.listAcceptedObservations(f.person.id).map((item) => item.id)).toEqual([f.oldId]);
    // 仅在隔离合成库撤下上下文成员，验证不能仅靠已缓存的绑定延续许可。
    f.db.prepare('DELETE FROM source_manifest_spans WHERE document_id=? AND source_span_id=?').run(f.documentId, f.contextSpanId);
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(2);
    f.db.prepare('INSERT INTO source_manifest_spans(document_id,source_span_id) VALUES (?,?)').run(f.documentId, f.contextSpanId);
    f.store.close();
    const reopened = new WorkspaceStore({ rootDirectory: f.root });
    stores.find((entry) => entry.root === f.root)!.store = reopened;
    const reopenedDb = (reopened as unknown as { db: Database.Database }).db;
    const changes = reopenedDb.prepare('SELECT total_changes() AS count').get();
    expect(reopened.listAcceptedObservations(f.person.id).map((item) => item.id)).toEqual([f.oldId]);
    expect(reopened.listDocumentAcceptedFactCounts().get(f.documentId)).toBe(1);
    expect(reopenedDb.prepare('SELECT total_changes() AS count').get()).toEqual(changes);
    expect(reopenedDb.prepare('SELECT * FROM observation_revisions ORDER BY observation_id,revision').all()).toEqual(before);
    expect(reopenedDb.prepare('SELECT count(*) AS count FROM observations').get()).toEqual({ count: 2 });
  });
  it.each([false, true])('counts/分析读取/预检共用现有canonical行，rich=%s，物理历史全保留且读取无写入', (rich) => {
    const f = storedFixture(rich);
    const before = f.db.prepare('SELECT * FROM observation_revisions ORDER BY observation_id,revision').all();
    const changes = f.db.prepare('SELECT total_changes() AS count').get();
    const canonicalId = rich ? f.nextId : f.oldId;
    expect(f.store.listAcceptedObservations(f.person.id).map((item) => item.id)).toEqual([canonicalId]);
    expect(f.store.listPersonObservationStats().get(f.person.id)?.acceptedFactCount).toBe(1);
    expect(f.store.listDocumentAcceptedFactCounts().get(f.documentId)).toBe(1);
    expect(f.store.previewDirectOriginalAdmission({ personId: f.person.id, documentId: f.documentId,
      manifest: f.manifest, observations: [f.next] })).toMatchObject({ acceptedCount: 0, duplicateCount: 1, held: [] });
    expect(f.db.prepare('SELECT total_changes() AS count').get()).toEqual(changes);
    expect(f.db.prepare('SELECT * FROM observation_revisions ORDER BY observation_id,revision').all()).toEqual(before);
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM observations').get()).toEqual({ count: 2 });
    if (rich) expect(f.store.listAcceptedObservations(f.person.id)[0]!.clinicalContext).toEqual(f.context);
  });

  it('先去重后按成员窗口取样，重复行不占用窗口名额', () => {
    const f = storedFixture();
    // 未绑定的另一文档必须保留；不能借同值跨文档去重。
    const otherSource = f.store.putSourceObject({ bytes: Buffer.from('第二个合成原件'), mediaType: 'image/png', displayName: 'other.png' });
    const { documentId } = f.store.registerImportedDocument({ sourceObjectId: otherSource.id, personId: f.person.id });
    const other = sourceFixture(documentId, otherSource.id, otherSource.sha256); f.store.saveSourceManifest(other.manifest);
    const acceptanceId = (f.db.prepare('SELECT acceptance_id FROM observation_revisions LIMIT 1').get() as { acceptance_id: string }).acceptance_id;
    f.store.publishFacts({ personId: f.person.id, documentId, expectedRevision: f.store.getFactRevision(f.person.id),
      documentCommitKey: 'c'.repeat(64), changeSetHash: 'd'.repeat(64), summary: '另一合成报告', observations: [{ ...f.observation(other.oldCandidate),
        documentId, sourceSpanId: other.oldCandidate.sourceBinding!.findingEvidence[0]!.sourceSpanId, acceptanceId }] });
    expect(f.store.listAcceptedObservations(f.person.id, { limitPerPerson: 2 })).toHaveLength(2);
    expect(f.store.listAcceptedObservations(f.person.id, { limitPerPerson: 1 })).toHaveLength(1);
    expect(new Set(f.store.listAcceptedObservations(f.person.id).map((item) => item.documentId)).size).toBe(2);
  });

  it('两个实际encounter日期不同，不以相同revision日期跨事件折叠', () => {
    const f = storedFixture();
    const oldEncounter = (f.db.prepare('SELECT encounter_id FROM observations WHERE id=?').get(f.oldId) as { encounter_id: string }).encounter_id;
    const nextEncounter = randomUUID();
    f.db.prepare(`INSERT INTO encounters SELECT ?,person_id,'2026-01-02',date_precision,type,source_text,version
      FROM encounters WHERE id=?`).run(nextEncounter, oldEncounter);
    f.db.prepare('UPDATE encounters SET clinical_date=? WHERE id=?').run('2026-01-01', oldEncounter);
    f.db.prepare('UPDATE observations SET encounter_id=? WHERE id=?').run(nextEncounter, f.nextId);
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(2);
    expect(f.store.listPersonObservationStats().get(f.person.id)?.acceptedFactCount).toBe(2);
    expect(f.store.listDocumentAcceptedFactCounts().get(f.documentId)).toBe(2);
  });

  it('缓存随本连接角色/锁/当前修订变化失效，不能复用旧来源许可', () => {
    const f = storedFixture(); expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(1);
    const acceptanceId = (f.db.prepare('SELECT acceptance_id FROM observation_revisions LIMIT 1').get() as { acceptance_id: string }).acceptance_id;
    f.db.prepare("UPDATE acceptance_decisions SET actor='user' WHERE id=?").run(acceptanceId);
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(2);
    f.db.prepare("UPDATE acceptance_decisions SET actor='policy' WHERE id=?").run(acceptanceId);
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(1);
    const findingId = f.nextCandidate.sourceBinding!.findingEvidence[0]!.sourceSpanId;
    const original = (f.db.prepare('SELECT model_evidence_json FROM source_spans WHERE id=?').get(findingId) as { model_evidence_json: string }).model_evidence_json;
    f.db.prepare('UPDATE source_spans SET model_evidence_json=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(original), role: 'identity' }), findingId);
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(2);
    f.db.prepare('UPDATE source_spans SET model_evidence_json=? WHERE id=?').run(original, findingId);
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(1);
    f.db.prepare(`INSERT INTO observation_revisions SELECT observation_id,2,value_kind,'<8','8',qualifier,unit,
      reference_range,abnormal_flag,source_span_id,acceptance_id,specimen,method,body_site,evidence_json,clinical_context_json,
      source_binding_json,clinical_date,date_evidence_json,1,created_at FROM observation_revisions WHERE observation_id=? AND revision=1`).run(f.nextId);
    f.db.prepare('UPDATE observations SET current_revision=2 WHERE id=?').run(f.nextId);
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(2);
  });

  it('其他连接提交的保护变化同样使缓存失效', () => {
    const f = storedFixture(); expect(f.store.listDocumentAcceptedFactCounts().get(f.documentId)).toBe(1);
    const external = new Database(f.store.databasePath);
    try { external.prepare("UPDATE acceptance_decisions SET actor='user'").run(); } finally { external.close(); }
    expect(f.store.listDocumentAcceptedFactCounts().get(f.documentId)).toBe(2);
  });

  it('manifest头和原文不变但当前成员集改变也必须使来源证明缓存失效', () => {
    const f = storedFixture(); expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(1);
    const headingIds = [f.oldCandidate, f.nextCandidate].flatMap((candidate) =>
      candidate.sourceBinding!.headingEvidence.map((ref) => ref.sourceSpanId));
    const manifest = f.db.prepare('SELECT * FROM source_manifests WHERE document_id=?').get(f.documentId);
    const spans = f.db.prepare('SELECT * FROM source_spans WHERE document_id=? ORDER BY id').all(f.documentId);
    const remove = f.db.prepare('DELETE FROM source_manifest_spans WHERE document_id=? AND source_span_id=?');
    for (const id of headingIds) remove.run(f.documentId, id);
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(2);
    expect(f.db.prepare('SELECT * FROM source_manifests WHERE document_id=?').get(f.documentId)).toEqual(manifest);
    expect(f.db.prepare('SELECT * FROM source_spans WHERE document_id=? ORDER BY id').all(f.documentId)).toEqual(spans);
    const insert = f.db.prepare('INSERT INTO source_manifest_spans(document_id,source_span_id) VALUES (?,?)');
    for (const id of headingIds) insert.run(f.documentId, id);
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(1);
  });

  it('无关工作记录写入只刷新范围，完整关键输入相同时复用文档来源证明', () => {
    const f = storedFixture();
    const projection = f.store as unknown as {
      canonicalStoredObservationRows(personId?: string): { observations: object[] };
    };
    const before = projection.canonicalStoredObservationRows(f.person.id);
    f.db.prepare(`INSERT INTO audit_events (id,event_type,entity_id,summary,created_at)
      VALUES (?,'synthetic_progress','synthetic-job','合成无关进度','2026-01-03T00:00:00Z')`).run(randomUUID());
    const after = projection.canonicalStoredObservationRows(f.person.id);
    expect(after).not.toBe(before);
    expect(after.observations[0]).toBe(before.observations[0]);
    expect(f.store.listDocumentAcceptedFactCounts().get(f.documentId)).toBe(1);
  });
});
