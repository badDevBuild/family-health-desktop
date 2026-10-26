import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { ObservationCandidate, SourceManifest, SourceSpan } from '@contracts';
import { WorkspaceStore, WORKSPACE_SCHEMA_VERSION } from './index.js';

const stores = new Set<WorkspaceStore>();
const roots: string[] = [];
afterEach(() => { for (const store of stores) store.close(); stores.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const rootDirectory = mkdtempSync(join(tmpdir(), 'family-health-direct-reset-synthetic-'));
  roots.push(rootDirectory);
  const store = new WorkspaceStore({ rootDirectory, now: () => new Date('2026-01-01T00:00:00Z') });
  stores.add(store);
  const persons = [store.createPerson({ displayName: '合成成员甲' }), store.createPerson({ displayName: '合成成员乙' })];
  const docs = persons.map((person, index) => {
    const source = store.putSourceObject({ bytes: Buffer.from(`合成固定原件 ${index}`), mediaType: 'image/png', displayName: `合成${index}.png` });
    const { documentId } = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const manifest: SourceManifest = { id: randomUUID(), sourceObjectId: source.id, sha256: source.sha256,
      mediaType: 'image/png', originalDisplayName: `合成${index}.png`, totalUnits: 1, coveredUnitIndexes: [0],
      normalizerVersion: 'direct-original-preparation-v1', conversionWarnings: [], createdAt: '2026-01-01T00:00:00Z',
      spans: [{ id: randomUUID(), documentId, spanKind: 'image', page: 1, blockId: 'direct-original-page:1',
        lineStart: null, lineEnd: null, quote: null, readability: 'clear' }] };
    store.saveSourceManifest(manifest);
    return { source, documentId, manifest, person };
  });
  return { store, docs, persons };
}

function execution(f: ReturnType<typeof fixture>, documentId = f.docs[0]!.documentId) {
  const personId = f.docs.find((doc) => doc.documentId === documentId)!.person.id;
  const consentId = f.store.createManualProcessingConsent({ documentIds: [documentId], personIds: [personId],
    accountFingerprint: 'synthetic-account', version: 1 });
  const batch = f.store.createWaitingAuthBatch({ cutoff: '2026-01-01T00:00:00Z', consentId, initialStatus: 'queued',
    groups: [{ personId, documentIds: [documentId], stage: 'extract', inputSignature: randomUUID() }] });
  const job = f.store.claimNextQueuedJob('synthetic-runner', 'synthetic-account')!;
  const attemptId = f.store.startJobAttempt(job.id, 'synthetic', 'gpt-6.1-sol', 'medium');
  return { jobId: batch.jobIds[0]!, attemptId, consentId, accountFingerprint: 'synthetic-account' };
}

function excerpt(manifest: SourceManifest, quote = '合成检查结果：7 U/L'): SourceSpan {
  const parent = manifest.spans[0]!;
  return { id: randomUUID(), documentId: parent.documentId, spanKind: 'block', page: parent.page,
    blockId: `model-original-excerpt:${parent.id}`, lineStart: null, lineEnd: null, quote, readability: 'clear',
    modelEvidence: { version: 1, engine: 'codex-original-reading-v1', modelId: 'gpt-6.1-sol',
      threadId: 'synthetic-thread', turnId: randomUUID(), originalSha256: manifest.sha256,
      originalSourceObjectId: manifest.sourceObjectId, parentSourceSpanId: parent.id, inputKind: 'image', role: 'finding', clarity: 'clear' } };
}

describe('模型直接读原件证据存储边界', () => {
  it.each(['application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])(
    'Word转换同时支持 %s，原件getter不会返回转换件，重复同一视图注册幂等', (mediaType) => {
      const f = fixture();
      const originalBytes = Buffer.from(`合成Word原件：${mediaType}`);
      const original = f.store.putSourceObject({ bytes: originalBytes, mediaType, displayName: '合成Word.docx' });
      const { documentId } = f.store.registerImportedDocument({ sourceObjectId: original.id, personId: f.persons[0]!.id });
      const pdfBytes = Buffer.from('%PDF-1.7\n合成转换视图\n%%EOF');
      const converted = f.store.putSourceObject({ bytes: pdfBytes, mediaType: 'application/pdf', displayName: '合成Word.pdf' });
      const input = { documentId, convertedSourceObjectId: converted.id, converterId: 'synthetic-controlled-converter',
        converterVersion: 'synthetic-v1', executableSha256: 'a'.repeat(64), warnings: ['word_layout_may_differ_from_original'] };
      f.store.registerDocumentConversion(input);
      expect(() => f.store.registerDocumentConversion(input)).not.toThrow();
      const source = f.store.getDocumentOriginalSource(documentId);
      expect(source.sourceObjectId).toBe(original.id); expect(source.sha256).toBe(original.sha256);
      expect(source.mediaType).toBe(mediaType); expect(readFileSync(source.sourcePath)).toEqual(originalBytes);
      expect(f.store.getDocumentConvertedView(documentId)).toMatchObject({ bytes: pdfBytes, sha256: converted.sha256,
        mediaType: 'application/pdf', converterId: input.converterId, executableSha256: input.executableSha256 });
      expect(() => f.store.registerDocumentConversion({ ...input, executableSha256: 'not-a-hash' }))
        .toThrow('DOCUMENT_CONVERSION_PROVENANCE_INVALID');
      expect(() => f.store.registerDocumentConversion({ ...input, converterVersion: 'synthetic-v2' }))
        .toThrow('DOCUMENT_CONVERSION_VIEW_CHANGED');
      expect(f.store.getDocumentConvertedView(documentId)?.converterVersion).toBe('synthetic-v1');
  });

  it('schema42保留原页与原件，模型回执往返保存且不伪装成OCR来源', () => {
    const f = fixture(); const doc = f.docs[0]!; const guard = execution(f);
    const span = excerpt(doc.manifest);
    const next = { ...doc.manifest, spans: [...doc.manifest.spans, span] };
    f.store.saveDirectOriginalEvidenceForProcessing(next, { executionGuard: guard });
    expect(f.store.getDocumentExtractionBundle(doc.documentId).manifest).toEqual(next);
    expect(f.store.getDocumentExtractionBundle(doc.documentId).manifest.spans[0]).toEqual(doc.manifest.spans[0]);
    const db = new Database(f.store.databasePath, { readonly: true });
    try { expect(Number(db.pragma('user_version', { simple: true }))).toBe(WORKSPACE_SCHEMA_VERSION);
      const saved = db.prepare('SELECT model_evidence_json,visual_evidence_json FROM source_spans WHERE id=?').get(span.id) as
        { model_evidence_json: string; visual_evidence_json: null };
      expect(JSON.parse(saved.model_evidence_json)).toEqual(span.modelEvidence); expect(saved.visual_evidence_json).toBeNull();
    } finally { db.close(); }
  });

  it.each(['hash', 'parent', 'page', 'old_content', 'clarity', 'expired_consent'] as const)('拒绝%s，失败不留下半条模型来源', (kind) => {
    const f = fixture(); const doc = f.docs[0]!; const guard = execution(f); const span = excerpt(doc.manifest);
    if (kind === 'hash') span.modelEvidence!.originalSha256 = 'b'.repeat(64);
    if (kind === 'parent') span.modelEvidence!.parentSourceSpanId = 'foreign-parent';
    if (kind === 'page') span.page = 2;
    if (kind === 'clarity') span.modelEvidence!.clarity = 'uncertain';
    if (kind === 'expired_consent') f.store.revokeConsent(guard.consentId);
    const spans = [{ ...doc.manifest.spans[0]!, ...(kind === 'old_content' ? { quote: '改写原页' } : {}) }, span];
    expect(() => f.store.saveDirectOriginalEvidenceForProcessing({ ...doc.manifest, spans }, { executionGuard: guard })).toThrow();
    expect(f.store.getDocumentExtractionBundle(doc.documentId).manifest).toEqual(doc.manifest);
  });

  it('停止后的旧调用不能附加出处，也不能借另一个成员的任务写入', () => {
    const f = fixture(); const guard = execution(f); const doc = f.docs[1]!;
    expect(() => f.store.saveDirectOriginalEvidenceForProcessing({ ...doc.manifest, spans: [...doc.manifest.spans, excerpt(doc.manifest)] },
      { executionGuard: guard })).toThrow('DOCUMENT_OUTSIDE_CONSENT_SCOPE');
    f.store.finishJobAttempt({ attemptId: guard.attemptId, status: 'cancelled' }); f.store.finishJob(guard.jobId, 'cancelled');
    const first = f.docs[0]!;
    expect(() => f.store.saveDirectOriginalEvidenceForProcessing({ ...first.manifest, spans: [...first.manifest.spans, excerpt(first.manifest)] },
      { executionGuard: guard })).toThrow('JOB_EXECUTION_INACTIVE');
  });

  it('不能把旧模型尝试伪装成6.1原件读取来源', () => {
    const f = fixture(); const guard = execution(f); const doc = f.docs[0]!;
    const isolated = new Database(f.store.databasePath);
    isolated.prepare("UPDATE job_attempts SET model='synthetic-other-model' WHERE id=?").run(guard.attemptId); isolated.close();
    expect(() => f.store.saveDirectOriginalEvidenceForProcessing({ ...doc.manifest, spans: [...doc.manifest.spans, excerpt(doc.manifest)] },
      { executionGuard: guard })).toThrow('DIRECT_ORIGINAL_MODEL_SCOPE_INVALID');
    expect(f.store.getDocumentExtractionBundle(doc.documentId).manifest).toEqual(doc.manifest);
  });

  it('schema41到42只增加可选模型出处，旧转写、来源和成员不被修改', () => {
    const f = fixture(); const path = f.store.databasePath; const root = f.store.rootDirectory;
    f.store.close(); stores.delete(f.store);
    const old = new Database(path); old.exec('ALTER TABLE source_spans DROP COLUMN model_evidence_json; UPDATE workspaces SET schema_version=41; PRAGMA user_version=41;'); old.close();
    const migrated = new WorkspaceStore({ rootDirectory: root }); stores.add(migrated);
    expect(migrated.listPersons().map((person) => person.id)).toEqual(expect.arrayContaining(f.persons.map((person) => person.id)));
    expect(migrated.getDocumentExtractionBundle(f.docs[0]!.documentId).manifest).toEqual(f.docs[0]!.manifest);
    expect(migrated.integrityCheck()).toBe('ok');
  });

  it('同一次模型摘录重复提取时不因localKey或span编号变化新增重复事实', () => {
    const f = fixture(); const doc = f.docs[0]!; const guard = execution(f); const span = excerpt(doc.manifest);
    const manifest = { ...doc.manifest, spans: [...doc.manifest.spans, span] };
    f.store.saveDirectOriginalEvidenceForProcessing(manifest, { executionGuard: guard });
    const acceptanceId = f.store.saveAcceptanceDecision({ method: 'auto', actor: 'policy', rulesVersion: 'synthetic-direct',
      inputSignature: 'direct-first', outputHash: 'direct-output', reviewRef: null, decision: 'accept' });
    const evidence = [{ sourceSpanId: span.id, quote: span.quote }];
    const candidate: ObservationCandidate = { localKey: randomUUID(), originalName: '合成检查结果', standardNameCandidate: null,
      value: { kind: 'numeric', rawText: '7', decimal: '7', comparator: 'eq' }, unitRaw: 'U/L', referenceRangeRaw: null,
      reportedAbnormalFlag: null, specimen: null, method: null, bodySite: null, clinicalDate: null,
      evidence, sourceBinding: { headingEvidence: [], findingEvidence: evidence }, issues: [] };
    const observation = { conceptKey: candidate.originalName, originalName: candidate.originalName, rawText: '7', valueKind: 'numeric' as const,
      decimalValue: '7', qualifier: 'eq', unit: 'U/L', referenceRange: null, clinicalDate: null, abnormalFlag: 'unknown' as const,
      documentId: doc.documentId, sourceSpanId: span.id, acceptanceId, specimen: null, method: null, bodySite: null,
      evidence, candidate, sourceBinding: candidate.sourceBinding };
    f.store.publishFacts({ personId: doc.person.id, documentId: doc.documentId, documentCommitKey: 'a'.repeat(64),
      expectedRevision: 0, changeSetHash: 'b'.repeat(64), summary: '合成第一次保存', observations: [observation] });
    const issueId = f.store.saveExtractionReviewIssue({ documentId: doc.documentId, kind: 'field_conflict', severity: 'warning',
      preserveDocumentStatus: true, stage: 'extract', evidenceRefs: [span.id], candidateOptions: [], reasonCodes: ['SYNTHETIC'] });
    const second = excerpt(doc.manifest);
    f.store.saveDirectOriginalEvidenceForProcessing({ ...manifest, spans: [...manifest.spans, second] }, { executionGuard: guard });
    const refs = [{ sourceSpanId: second.id, quote: second.quote }];
    const result = f.store.appendCommittedFacts({ personId: doc.person.id, documentId: doc.documentId,
      expectedRevision: f.store.getFactRevision(doc.person.id), summary: '合成重复回执', observations: [{ ...observation,
        sourceSpanId: second.id, evidence: refs, candidate: { ...candidate, localKey: randomUUID(), evidence: refs,
          sourceBinding: { headingEvidence: [], findingEvidence: refs } }, sourceBinding: { headingEvidence: [], findingEvidence: refs } }],
      reviewUpdate: { issueId, remainingCandidates: [], remainingReasonCodes: [], remainingEvidenceRefs: [] } });
    expect(result).toMatchObject({ duplicateCount: 1, appendedCount: 0, heldCount: 0 });
    expect(f.store.listAcceptedObservations(doc.person.id)).toHaveLength(1);
  });
});

describe('仅保留原件和成员的显式全清重建', () => {
  async function seeded() {
    const f = fixture();
    for (const person of f.persons) {
      f.store.createManualNote({ personId: person.id, kind: 'history', immutableText: '合成个人补充', effectiveDate: null,
        structuredFields: {}, expectedContextRevision: 0 });
      f.store.createUserAction({ personId: person.id, title: '合成个人计划', detail: '合成行动正文', dueDate: null, dueText: null });
    }
    f.store.confirmPersonNameAlias({ personId: f.persons[0]!.id, reportedName: '合成确认别名' });
    const guard = execution(f); f.store.finishJobAttempt({ attemptId: guard.attemptId, status: 'succeeded' }); f.store.finishJob(guard.jobId, 'succeeded');
    const db = new Database(f.store.databasePath);
    db.prepare(`INSERT INTO clinical_statements(id,person_id,document_id,statement_kind,text,reported_status,source_span_id,source_kind,created_at)
      VALUES ('old-user-context',?,NULL,'context','合成旧用户背景',NULL,NULL,'user_reported','2026-01-01T00:00:00Z')`).run(f.persons[0]!.id);
    db.exec(`INSERT INTO notifications(id,event_type,status,created_at,read_at) VALUES ('old-notification','test','unread','2026-01-01T00:00:00Z',NULL);`);
    db.prepare(`INSERT INTO lifestyle_proposals_v2(id,person_id,category,title,detail,consult_professional,evidence_refs_json,structure_json,status,source_snapshot_id,version,created_at,updated_at)
      VALUES ('old-proposal',?,'diet','合成旧建议','合成旧内容',0,'[]','{}','adopted',NULL,1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`).run(f.persons[0]!.id);
    db.prepare(`INSERT INTO action_adoptions_v2(id,person_id,proposal_id,title,details_json,status,due_date,user_revision,created_at,updated_at)
      VALUES ('old-adoption',?,'old-proposal','合成已采纳建议','{}','todo',NULL,1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`).run(f.persons[0]!.id);
    db.close();
    const backup = await f.store.createProcessingRebuildBackup();
    const input = { backup, manifests: f.docs.map((doc) => doc.manifest), accountFingerprint: 'new-account',
      consentVersion: 1, confirmedRebuildReportResults: true as const, clearPersonalData: true as const,
      confirmedClearPersonalData: true as const, promptVersion: 'synthetic-direct-v1', rulesVersion: 'synthetic-direct-v1' };
    return { ...f, guard, input, backup };
  }

  it('恢复点真实保存旧个人内容；活动库彻底清除旧数据、任务和收据，原件及成员保持一致', async () => {
    const f = await seeded(); const original = f.store.listProcessingRebuildSources().map((source) => readFileSync(source.sourcePath));
    const receipt = f.store.rebuildProcessingResults(f.input);
    expect(receipt).toMatchObject({ personCount: 2, documentCount: 2, recoveryPointCreated: true });
    expect(f.store.listPersons()).toHaveLength(2); expect(f.store.listManualNotes()).toEqual([]);
    for (const doc of f.docs) expect(f.store.getDocumentExtractionBundle(doc.documentId).manifest.spans.map((span) => span.id))
      .toEqual(doc.manifest.spans.map((span) => span.id));
    expect(f.store.listActionItems()).toEqual([]); expect(f.store.listConfirmedPersonNameAliases(f.persons[0]!.id)).toContain('合成确认别名');
    const sources = f.store.listProcessingRebuildSources(); expect(sources).toHaveLength(2);
    sources.forEach((source, index) => expect(readFileSync(source.sourcePath)).toEqual(original[index]));
    const current = new Database(f.store.databasePath, { readonly: true });
    try {
      for (const table of ['user_notes', 'person_context_revisions', 'clinical_statements', 'observations', 'observation_revisions',
        'action_items', 'action_events', 'action_adoptions_v2', 'lifestyle_proposals_v2', 'job_attempts', 'review_issues',
        'ai_transmissions', 'extraction_repair_diagnostics', 'notifications', 'member_assessment_snapshots_v3', 'derived_snapshots']) {
        expect((current.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count, table).toBe(0);
      }
      expect(current.prepare('SELECT id FROM jobs WHERE id=?').get(f.guard.jobId)).toBeUndefined();
      expect(current.prepare('SELECT id FROM consents WHERE id=?').get(f.guard.consentId)).toBeUndefined();
      expect((current.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number }).count).toBe(2);
      expect(current.pragma('foreign_key_check')).toEqual([]);
      expect(current.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally { current.close(); }
    const saved = new Database(f.backup.databasePath, { readonly: true });
    try { expect((saved.prepare('SELECT COUNT(*) AS count FROM user_notes').get() as { count: number }).count).toBe(2);
      expect(saved.prepare("SELECT id FROM action_adoptions_v2 WHERE id='old-adoption'").get()).toBeTruthy();
      expect(saved.prepare('SELECT id FROM jobs WHERE id=?').get(f.guard.jobId)).toBeTruthy();
      expect(saved.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally { saved.close(); }
  });

  it('旧OCR定位ID不会污染新原件骨架，实际重建完整保留新技术准备的稳定ID', async () => {
    const f = await seeded();
    const manifests = f.docs.map((doc) => ({ ...doc.manifest,
      spans: doc.manifest.spans.map((span) => ({ ...span, id: `new-stable-original-${doc.documentId}` })) }));
    f.store.rebuildProcessingResults({ ...f.input, manifests });
    for (const doc of f.docs) expect(f.store.getDocumentExtractionBundle(doc.documentId).manifest.spans[0]!.id)
      .toBe(`new-stable-original-${doc.documentId}`);
  });

  it('没有单独确认清空个人内容不能执行，变化中的通知也使恢复点过期', async () => {
    const f = await seeded();
    expect(() => f.store.rebuildProcessingResults({ ...f.input, confirmedClearPersonalData: undefined } as unknown as typeof f.input))
      .toThrow('PROCESSING_REBUILD_AUTH_REQUIRED');
    expect(f.store.listManualNotes()).toHaveLength(2);
    const db = new Database(f.store.databasePath); db.exec(`UPDATE notifications SET status='read' WHERE id='old-notification'`); db.close();
    expect(() => f.store.rebuildProcessingResults(f.input)).toThrow('PROCESSING_REBUILD_BACKUP_CHANGED');
    expect(f.store.listActionItems()).toHaveLength(2); expect(f.store.listManualNotes()).toHaveLength(2);
  });
});

describe('显式单成员重建的范围隔离', () => {
  // 完整合成两位成员的数据图；不连接正式库，也不调用模型。
  async function scopedSeeded() {
    const f = fixture();
    const guards = f.docs.map((doc) => {
      const guard = execution(f, doc.documentId);
      f.store.finishJobAttempt({ attemptId: guard.attemptId, status: 'succeeded' });
      f.store.finishJob(guard.jobId, 'succeeded');
      return guard;
    });
    const bindings = f.persons.map((person, index) => f.store.createInboxBinding({
      canonicalPath: join(f.store.rootDirectory, `synthetic-inbox-${index}`), personId: person.id,
      recursive: true, allowScheduledAiProcessing: true, accountFingerprint: 'synthetic-account', consentVersion: 1
    }));
    const plans = f.persons.map((person, index) => {
      f.store.createManualNote({ personId: person.id, kind: 'history', immutableText: `合成个人补充${index}`,
        effectiveDate: null, structuredFields: {}, expectedContextRevision: 0 });
      f.store.confirmPersonNameAlias({ personId: person.id, reportedName: `合成身份别名${index}` });
      return f.store.createUserAction({ personId: person.id, title: `合成计划${index}`, detail: '合成已有计划', dueDate: null, dueText: null });
    });
    for (const [index, doc] of f.docs.entries()) f.store.registerSourceOccurrence({ sourceObjectId: doc.source.id,
      bindingId: bindings[index]!.id, originalPath: join(f.store.rootDirectory, `synthetic-source-${index}.png`), displayName: `合成${index}.png` });
    const sharedConsentId = f.store.createManualProcessingConsent({ documentIds: f.docs.map((doc) => doc.documentId),
      personIds: f.persons.map((person) => person.id), accountFingerprint: 'synthetic-account', version: 1 });
    const sharedBatch = f.store.createWaitingAuthBatch({ cutoff: '2026-01-01T00:00:00Z', initialStatus: 'waiting_auth',
      consentId: sharedConsentId, groups: f.docs.map((doc) => ({ personId: doc.person.id,
        documentIds: [doc.documentId], inputSignature: randomUUID() })) });
    f.store.createInboxBinding({ canonicalPath: join(f.store.rootDirectory, 'synthetic-global-inbox'), personId: null,
      recursive: false, allowScheduledAiProcessing: false, accountFingerprint: null, consentVersion: 1 });
    const db = new Database(f.store.databasePath); db.pragma('foreign_keys=ON');
    const at = '2026-01-01T00:00:00Z';
    db.prepare(`INSERT INTO acceptance_decisions(id,method,actor,rules_version,input_signature,output_hash,review_ref,decision,decided_at)
      VALUES ('shared-acceptance','auto','policy','synthetic','shared-input','shared-output',NULL,'accept',?)`).run(at);
    for (const [index, doc] of f.docs.entries()) {
      const personId = doc.person.id; const guard = guards[index]!;
      db.prepare(`INSERT INTO acceptance_decisions(id,method,actor,rules_version,input_signature,output_hash,review_ref,decision,decided_at)
        VALUES (?,'auto','policy','synthetic',?,?,NULL,'accept',?)`).run(`accept-${index}`, `input-${index}`, `output-${index}`, at);
      db.prepare('UPDATE documents SET acceptance_id=?,status=?,confirmed_reported_name=? WHERE id=?')
        .run('shared-acceptance', 'completed', `合成身份别名${index}`, doc.documentId);
      db.prepare(`INSERT INTO encounters VALUES (?,?,?,'day','lab','合成事件',1)`).run(`encounter-${index}`, personId, '2025-02-03');
      db.prepare('INSERT INTO encounter_documents VALUES (?,?)').run(`encounter-${index}`, doc.documentId);
      db.prepare(`INSERT INTO observations(id,person_id,encounter_id,concept_key,original_name,current_revision,created_at)
        VALUES (?,?,?,'synthetic-result','合成结果',1,?)`).run(`observation-${index}`, personId, `encounter-${index}`, at);
      db.prepare(`INSERT INTO observation_revisions(observation_id,revision,value_kind,raw_text,decimal_value,qualifier,unit,
        reference_range,abnormal_flag,source_span_id,acceptance_id,clinical_date,created_at)
        VALUES (?,1,'numeric','7','7','eq','U/L',NULL,'unknown',?,?,?,?)`)
        .run(`observation-${index}`, doc.manifest.spans[0]!.id, `accept-${index}`, '2025-02-03', at);
      db.prepare(`UPDATE person_revisions SET fact_revision=3 WHERE person_id=?`).run(personId);
      db.prepare(`INSERT INTO clinical_statements VALUES (?,?,?,'context','合成报告陈述',NULL,?,'report',?)`)
        .run(`statement-${index}`, personId, doc.documentId, doc.manifest.spans[0]!.id, at);
      db.prepare(`INSERT INTO derived_snapshots VALUES (?,?,3,1,'synthetic','synthetic','synthetic','{}','{}','current',?)`)
        .run(`derived-${index}`, personId, at);
      db.prepare(`INSERT INTO snapshot_evidence VALUES (?, 'claim',NULL,?)`).run(`derived-${index}`, doc.manifest.spans[0]!.id);
      db.prepare(`INSERT INTO member_assessment_snapshots_v3 VALUES (?,?,?,3,1,'synthetic','synthetic','gpt-6.1-sol',
        'medium','local_only','{}','current',?)`).run(`assessment-${index}`, personId, `assessment-input-${index}`, at);
      db.prepare(`INSERT INTO system_analysis_snapshots_v2 VALUES (?,?,'digestive',3,1,'synthetic','synthetic','synthetic',
        'synthetic-hash','{}','{}','current',?)`).run(`system-${index}`, personId, at);
      db.prepare(`INSERT INTO derivation_dependencies VALUES ('system_analysis',?,'observation',?,'1',?)`)
        .run(`system-${index}`, `observation-${index}`, at);
      db.prepare(`INSERT INTO health_events_v2 VALUES (?,?,'lab','合成检查','2025-02-03',NULL,'day','examined','report','confirmed',1,?,?)`)
        .run(`event-${index}`, personId, at, at);
      db.prepare(`INSERT INTO report_records VALUES (?,?,?,'lab','合成报告',NULL,'2025-02-04','confirmed',1,?)`)
        .run(`report-${index}`, personId, `event-${index}`, at);
      db.prepare(`INSERT INTO report_metadata_revisions VALUES (?,1,'{}','model','[]',?)`).run(`report-${index}`, at);
      db.prepare(`INSERT INTO report_source_links VALUES (?,?,'primary',?,?)`).run(`report-${index}`, doc.documentId, doc.source.sha256, at);
      db.prepare('INSERT INTO event_report_links VALUES (?,?)').run(`event-${index}`, `report-${index}`);
      db.prepare(`INSERT INTO report_clinical_contexts VALUES (?,?,?,'{}',?)`).run(personId, doc.documentId, `context-${index}`, at);
      db.prepare(`INSERT INTO publication_events VALUES (?,?,0,3,?,'合成旧发布',?)`).run(`publication-${index}`, personId, `change-${index}`, at);
      db.prepare(`INSERT INTO document_commits VALUES (?,?,?,3,?)`).run(doc.documentId, `commit-${index}`, `publication-${index}`, at);
      db.prepare(`INSERT INTO lifestyle_proposals_v2 VALUES (?,?,'diet','合成已采纳建议','合成内容',0,'[]','{}',
        'adopted',?,1,?,?)`).run(`proposal-${index}`, personId, `derived-${index}`, at, at);
      db.prepare(`INSERT INTO action_adoptions_v2 VALUES (?,?,?,'合成已采纳计划','{}','todo',NULL,1,?,?)`)
        .run(`adoption-${index}`, personId, `proposal-${index}`, at, at);
      db.prepare(`INSERT INTO ai_transmissions VALUES (?,?,?,?,?,'extract','finished',?,?)`)
        .run(`transmission-${index}`, guard.jobId, guard.attemptId, guard.consentId, doc.documentId, at, at);
      db.prepare(`INSERT INTO ai_transmission_receipts VALUES (?,'synthetic','synthetic','thread','turn','hash',?)`)
        .run(`transmission-${index}`, at);
      db.prepare(`INSERT INTO extraction_repair_diagnostics VALUES (?,?,?,?,0,'held','{}',?)`)
        .run(`diagnostic-${index}`, doc.documentId, guard.jobId, guard.attemptId, at);
      db.prepare(`INSERT INTO review_issues VALUES (?,?,?,'field_conflict','warning','[]','open',NULL,'{}',?)`)
        .run(`review-${index}`, guard.jobId, `document:${doc.documentId}`, at);
    }
    db.prepare(`INSERT INTO notifications VALUES ('global-notification','synthetic','unread',?,NULL)`).run(at);
    db.prepare(`INSERT INTO audit_events VALUES ('global-audit','synthetic',NULL,'合成全局记录',?)`).run(at);
    db.prepare(`INSERT INTO audit_events VALUES ('shared-batch-audit','synthetic',?,'合成共享批次记录',?)`)
      .run(sharedBatch.batchId, at);
    db.prepare(`INSERT INTO audit_events VALUES ('shared-acceptance-audit','synthetic','shared-acceptance','合成共享接纳记录',?)`)
      .run(at);
    for (const [index, guard] of guards.entries()) db.prepare(`INSERT INTO audit_events VALUES (?,'synthetic',?,'合成任务记录',?)`)
      .run(`job-audit-${index}`, guard.jobId, at);
    db.prepare(`INSERT INTO schedules VALUES ('global-schedule',1,'09:00','[]',NULL,NULL,0,1)`).run();
    db.prepare(`INSERT INTO knowledge_entries VALUES ('global-knowledge','synthetic','zh','合成公开知识',NULL,NULL,'{}','1',?)`).run(at);
    db.prepare(`INSERT INTO exclusions VALUES ('global-exclusion',NULL,NULL,NULL,'合成全局排除',?)`).run(at);
    db.close();
    const backup = await f.store.createProcessingRebuildBackup();
    const input = { backup, manifests: [f.docs[0]!.manifest], personIds: [f.persons[0]!.id], accountFingerprint: 'new-account',
      consentVersion: 1, confirmedRebuildReportResults: true as const, clearPersonalData: true as const,
      confirmedClearPersonalData: true as const, promptVersion: 'synthetic-direct-v2', rulesVersion: 'synthetic-direct-v2' };
    return { ...f, guards, bindings, plans, sharedConsentId, sharedBatch, input, backup };
  }

  function allRows(databasePath: string) {
    const db = new Database(databasePath, { readonly: true });
    try { return Object.fromEntries((db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as Array<{ name: string }>).map(({ name }) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
    } finally { db.close(); }
  }

  it('只清空目标成员完整数据图；另一个成员、共享授权/批次及全局数据逐行保留', async () => {
    const f = await scopedSeeded(); const before = allRows(f.store.databasePath);
    const bytes = f.store.listProcessingRebuildSources().map((source) => ({ id: source.documentId, bytes: readFileSync(source.sourcePath) }));
    const receipt = f.store.rebuildProcessingResults(f.input);
    expect(receipt).toMatchObject({ personCount: 1, documentCount: 1, recoveryPointCreated: true });
    const after = allRows(f.store.databasePath);
    for (const table of ['source_objects', 'source_occurrences', 'person_name_aliases', 'schedules', 'notifications',
      'knowledge_entries', 'backup_manifests', 'body_system_registry', 'concept_definitions', 'concept_aliases', 'workspaces']) {
      if (table === 'source_occurrences') {
        expect(after[table]).toEqual(before[table]!.map((row) => ({ ...(row as object),
          ...((row as { binding_id: string | null }).binding_id === f.bindings[0]!.id ? { binding_id: null } : {}) })));
      } else expect(after[table], table).toEqual(before[table]);
    }
    for (const table of ['user_notes', 'person_context_revisions', 'clinical_statements', 'observations', 'action_items',
      'action_adoptions_v2', 'lifestyle_proposals_v2', 'jobs', 'inbox_bindings', 'encounters', 'health_events_v2', 'report_records',
      'report_clinical_contexts', 'publication_events', 'derived_snapshots', 'member_assessment_snapshots_v3', 'system_analysis_snapshots_v2']) {
      const foreign = (rows: unknown[]) => rows.filter((row) => (row as { person_id: string | null }).person_id !== f.persons[0]!.id);
      expect(foreign(after[table]!), table).toEqual(foreign(before[table]!));
      if (!['jobs'].includes(table)) expect(after[table]!.filter((row) => (row as { person_id: string }).person_id === f.persons[0]!.id), table).toEqual([]);
    }
    const foreignEntityIds = new Set([f.persons[1]!.id, f.docs[1]!.documentId, f.docs[1]!.manifest.spans[0]!.id,
      f.guards[1]!.jobId, f.guards[1]!.attemptId, f.guards[1]!.consentId, f.plans[1]!.id,
      'observation-1', 'derived-1', 'report-1', 'event-1', 'transmission-1', 'system-1', 'accept-1', 'shared-acceptance']);
    for (const table of ['observation_revisions', 'snapshot_evidence', 'report_metadata_revisions', 'event_report_links',
      'report_source_links', 'action_events', 'ai_transmissions', 'ai_transmission_receipts', 'extraction_repair_diagnostics',
      'review_issues', 'document_commits', 'job_attempts', 'acceptance_decisions', 'derivation_dependencies']) {
      const otherRows = before[table]!.filter((row) => Object.values(row as object)
        .some((value) => typeof value === 'string' && foreignEntityIds.has(value)));
      for (const row of otherRows) expect(after[table], table).toContainEqual(row);
    }
    const db = new Database(f.store.databasePath, { readonly: true });
    try {
      expect(db.prepare('SELECT * FROM consents WHERE id=?').get(f.sharedConsentId))
        .toEqual(before.consents!.find((row) => (row as { id: string }).id === f.sharedConsentId));
      expect(db.prepare('SELECT * FROM batches WHERE id=?').get(f.sharedBatch.batchId))
        .toEqual(before.batches!.find((row) => (row as { id: string }).id === f.sharedBatch.batchId));
      for (const id of ['global-audit', 'shared-batch-audit', 'shared-acceptance-audit', 'job-audit-1']) {
        expect(after.audit_events).toContainEqual(before.audit_events!.find((row) => (row as { id: string }).id === id));
      }
      expect(db.prepare("SELECT id FROM audit_events WHERE id='job-audit-0'").get()).toBeUndefined();
      expect(db.prepare('SELECT id FROM jobs WHERE id=?').get(f.guards[0]!.jobId)).toBeUndefined();
      expect(db.prepare('SELECT id FROM jobs WHERE id=?').get(f.sharedBatch.jobIds[0]!)).toBeUndefined();
      expect(db.prepare('SELECT id FROM consents WHERE id=?').get(f.guards[0]!.consentId)).toBeUndefined();
      expect(db.prepare("SELECT id FROM acceptance_decisions WHERE id='accept-0'").get()).toBeUndefined();
      expect(db.prepare('SELECT id FROM documents WHERE id=?').get(f.docs[0]!.documentId)).toBeTruthy();
      expect(db.prepare('SELECT fact_revision FROM person_revisions WHERE person_id=?').get(f.persons[0]!.id)).toEqual({ fact_revision: 1 });
      expect(db.prepare('SELECT clinical_context_revision FROM persons WHERE id=?').get(f.persons[0]!.id)).toEqual({ clinical_context_revision: 0 });
      expect(db.pragma('foreign_key_check')).toEqual([]); expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally { db.close(); }
    expect(f.store.listConfirmedPersonNameAliases(f.persons[0]!.id)).toContain('合成身份别名0');
    for (const source of f.store.listProcessingRebuildSources()) expect(readFileSync(source.sourcePath))
      .toEqual(bytes.find((item) => item.id === source.documentId)!.bytes);
    expect(() => f.store.assertJobExecutionActive(f.guards[0]!, f.docs[0]!.documentId)).toThrow('JOB_EXECUTION_INACTIVE');
    const saved = allRows(f.backup.databasePath);
    expect(saved.user_notes).toHaveLength(2); expect(saved.observations).toHaveLength(2); expect(saved.action_items).toHaveLength(2);
  });

  it('空、重复、未知、归档和没有可重建原件的显式成员范围都拒绝，不静默缩小', async () => {
    const f = await scopedSeeded();
    const empty = f.store.createPerson({ displayName: '合成无资料成员' });
    const archived = f.store.createPerson({ displayName: '合成已归档成员' });
    f.store.archivePerson({ personId: archived.id, expectedDisplayRevision: archived.displayRevision });
    const backup = await f.store.createProcessingRebuildBackup();
    const before = allRows(f.store.databasePath);
    for (const personIds of [[], [f.persons[0]!.id, f.persons[0]!.id], ['synthetic-missing'],
      [f.persons[0]!.id, empty.id], [archived.id]]) {
      expect(() => f.store.rebuildProcessingResults({ ...f.input, backup, personIds })).toThrow('PROCESSING_REBUILD_PERSON_SCOPE_INVALID');
      expect(allRows(f.store.databasePath)).toEqual(before);
    }
  });

  it('重建新骨架失败时，清空、任务、授权与个人计划在同一事务中全部回滚', async () => {
    const f = await scopedSeeded();
    const db = new Database(f.store.databasePath);
    db.exec(`CREATE TRIGGER synthetic_fail_scoped_manifest BEFORE INSERT ON source_manifests BEGIN
      SELECT RAISE(ABORT,'SYNTHETIC_SCOPED_REBUILD_FAILURE'); END;`); db.close();
    const before = allRows(f.store.databasePath);
    expect(() => f.store.rebuildProcessingResults(f.input)).toThrow('SYNTHETIC_SCOPED_REBUILD_FAILURE');
    expect(allRows(f.store.databasePath)).toEqual(before);
    expect(f.store.listManualNotes()).toHaveLength(2); expect(f.store.listActionItems()).toHaveLength(2);
    expect(f.store.integrityCheck()).toBe('ok');
  });

  it('异常跨成员派生引用不靠删除另一成员的依赖掩盖，整笔拒绝', async () => {
    const f = await scopedSeeded();
    const db = new Database(f.store.databasePath);
    db.prepare(`INSERT INTO derivation_dependencies VALUES ('system_analysis','system-1','observation','observation-0','1',?)`)
      .run('2026-01-01T00:00:00Z'); db.close();
    const backup = await f.store.createProcessingRebuildBackup(); const before = allRows(f.store.databasePath);
    expect(() => f.store.rebuildProcessingResults({ ...f.input, backup })).toThrow('PROCESSING_REBUILD_CROSS_PERSON_REFERENCE');
    expect(allRows(f.store.databasePath)).toEqual(before);
  });

  it.each(['transmission', 'repair', 'review', 'publication'])(
    '目标原件反向连到另一成员的%s记录时，保留回执并整笔拒绝', async (kind) => {
      const f = await scopedSeeded(); const db = new Database(f.store.databasePath); db.pragma('foreign_keys=ON');
      if (kind === 'transmission') db.prepare(`UPDATE ai_transmissions SET job_id=?,attempt_id=? WHERE id='transmission-0'`)
        .run(f.guards[1]!.jobId, f.guards[1]!.attemptId);
      if (kind === 'repair') db.prepare(`UPDATE extraction_repair_diagnostics SET job_id=?,attempt_id=? WHERE id='diagnostic-0'`)
        .run(f.guards[1]!.jobId, f.guards[1]!.attemptId);
      if (kind === 'review') db.prepare(`UPDATE review_issues SET job_id=? WHERE id='review-0'`).run(f.guards[1]!.jobId);
      if (kind === 'publication') db.prepare(`UPDATE document_commits SET publication_id='publication-1' WHERE document_id=?`)
        .run(f.docs[0]!.documentId);
      db.close(); const backup = await f.store.createProcessingRebuildBackup(); const before = allRows(f.store.databasePath);
      expect(() => f.store.rebuildProcessingResults({ ...f.input, backup })).toThrow('PROCESSING_REBUILD_CROSS_PERSON_REFERENCE');
      expect(allRows(f.store.databasePath)).toEqual(before);
    });
});
