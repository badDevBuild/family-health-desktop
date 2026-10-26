import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { stableHash } from '@core';
import { droppedFilePathsInputSchema, importFilesInputSchema, importFilesReceiptSchema, type AccountState } from '@contracts';
import { PersonalWorkspaceService } from './workspace-service.js';
import { requeueCurrentAccountWaitingJobs } from './account-job-recovery.js';

const fixtures: Array<{ root: string; service: PersonalWorkspaceService }> = [];
const account: AccountState = { status: 'connected', displayLabel: 'synthetic-upload@example.test',
  quota: { status: 'available', primaryUsedPercent: 0, secondaryUsedPercent: null, resetsAt: null },
  runtimeVersion: 'synthetic-runtime', lastCheckedAt: '2026-10-17T00:00:00Z' };
const fingerprint = stableHash({ provider: 'codex-chatgpt', displayLabel: account.displayLabel });
afterEach(() => {
  for (const { root, service } of fixtures.splice(0)) {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'family-health-auto-upload-'));
  const service = new PersonalWorkspaceService(root, '合成自动上传', () => new Date('2026-10-17T00:00:00Z'));
  fixtures.push({ root, service });
  const person = service.store.createPerson({ displayName: '合成成员' });
  return { root, service, person };
}
function files(label: string) { return [{ path: `/synthetic/${label}.txt`, bytes: Buffer.from(`合成报告 ${label}`) }]; }
function database<T>(service: PersonalWorkspaceService, run: (db: Database.Database) => T): T {
  const db = new Database(service.store.databasePath);
  try { return run(db); } finally { db.close(); }
}
function jobFor(service: PersonalWorkspaceService, batchId: string) {
  return database(service, (db) => db.prepare('SELECT id,checkpoint_json FROM jobs WHERE batch_id=?').get(batchId)) as {
    id: string; checkpoint_json: string;
  };
}
function consentFor(service: PersonalWorkspaceService, jobId: string) {
  return database(service, (db) => db.prepare(`SELECT c.id,c.purpose,c.account_fingerprint,c.scope_json FROM jobs j
    JOIN consents c ON c.id=json_extract(j.checkpoint_json,'$.consentId') WHERE j.id=?`).get(jobId)) as {
      id: string; purpose: string; account_fingerprint: string | null; scope_json: string;
    };
}
async function automatic(service: PersonalWorkspaceService, personId: string | null, label: string, state = account) {
  return service.importFilesAndProcess(files(label), personId, { accountState: state, consentVersion: 1 });
}
function begin(service: PersonalWorkspaceService) {
  const job = service.store.claimNextQueuedJob('synthetic-auto-runner', fingerprint)!;
  expect(job).not.toBeNull();
  const attemptId = service.store.startJobAttempt(job.id, 'synthetic-runtime');
  return { ...job, guard: { jobId: job.id, attemptId, consentId: job.consentId, accountFingerprint: fingerprint } };
}
function publishHistory(service: PersonalWorkspaceService, personId: string, label: string) {
  const quote = `合成测量 ${label}`;
  const source = service.store.putSourceObject({ bytes: Buffer.from(quote), mediaType: 'text/plain', displayName: `${label}.txt` });
  const { documentId } = service.store.registerImportedDocument({ sourceObjectId: source.id, personId });
  const spanId = `synthetic-${documentId}`;
  service.store.saveSourceManifest({ id: `manifest-${documentId}`, sourceObjectId: source.id, sha256: source.sha256,
    mediaType: 'text/plain', originalDisplayName: `${label}.txt`, totalUnits: 1, coveredUnitIndexes: [0],
    normalizerVersion: 'synthetic', conversionWarnings: [], createdAt: '2026-10-17T00:00:00Z',
    spans: [{ id: spanId, documentId, spanKind: 'line', page: null, blockId: null, lineStart: 1,
      lineEnd: 1, quote, readability: 'clear' }] });
  const acceptanceId = service.store.saveAcceptanceDecision({ method: 'auto', actor: 'policy', rulesVersion: 'synthetic',
    inputSignature: stableHash({ label }), outputHash: stableHash({ quote }), reviewRef: null, decision: 'accept' });
  service.store.publishFacts({ personId, documentId, documentCommitKey: stableHash({ documentId }),
    expectedRevision: service.store.getFactRevision(personId), changeSetHash: stableHash({ documentId, quote }),
    summary: '合成自动上传历史', observations: [{ conceptKey: '合成项目', originalName: '合成项目', rawText: '合成结果',
      valueKind: 'text', decimalValue: null, qualifier: null, unit: null, referenceRange: null, clinicalDate: null,
      abnormalFlag: 'unknown', specimen: null, method: null, bodySite: null,
      documentId, sourceSpanId: spanId, acceptanceId, evidence: [{ sourceSpanId: spanId, quote }] }] });
  return service.store.listAcceptedObservations(personId).find((item) => item.documentId === documentId)!;
}

describe('上传即处理的精确范围与持久授权', () => {
  it('导入中断后只恢复同一持久意图内已复制资料，未复制项和旧待处理资料不夹带', async () => {
    const f = fixture(); await f.service.automaticUploadRecovery;
    await f.service.importFiles(files('旧待处理本机资料'), f.person.id);
    const intentId = f.service.store.automaticUploadIntents.begin({ personId: f.person.id,
      accountFingerprint: fingerprint, authorizationEpoch: f.service.store.getAutomaticUploadAuthorizationEpoch(),
      version: 1, promptVersion: 'synthetic-upload-prompt', rulesVersion: 'synthetic-upload-rules',
      displayNames: ['合成已复制甲.txt', '合成已复制乙.txt', '合成未复制丙.txt'] });
    const selectedIds: string[] = [];
    for (let itemIndex = 0; itemIndex < 2; itemIndex += 1) {
      const displayName = `合成已复制${itemIndex}.txt`;
      const source = f.service.store.putSourceObject({ bytes: Buffer.from(`合成中断原件${itemIndex}`), mediaType: 'text/plain', displayName });
      f.service.store.registerSourceOccurrence({ sourceObjectId: source.id, originalPath: `/synthetic/${displayName}`, displayName });
      const document = f.service.store.registerImportedDocument({ sourceObjectId: source.id, personId: f.person.id,
        assignmentBasis: 'user_selected', uploadIntent: { intentId, itemIndex } });
      selectedIds.push(document.documentId);
    }
    expect(f.service.store.listStoredJobs()).toHaveLength(0);
    f.service.close();
    const reopened = new PersonalWorkspaceService(f.root, '合成意图恢复');
    fixtures.find((item) => item.root === f.root)!.service = reopened;
    await reopened.automaticUploadRecovery;
    expect(reopened.store.listStoredJobs()).toHaveLength(1);
    expect(reopened.store.listStoredJobs()[0]!.documentIds.sort()).toEqual(selectedIds.sort());
    expect(reopened.store.listImportedDocuments()).toHaveLength(3);
    const states = database(reopened, (db) => db.prepare(`SELECT item_index,status,failure_code
      FROM automatic_upload_intent_items WHERE intent_id=? ORDER BY item_index`).all(intentId));
    expect(states).toMatchObject([{ status: 'queued' }, { status: 'queued' },
      { status: 'failed', failure_code: 'UPLOAD_INTERRUPTED_BEFORE_COPY' }]);
    expect(reopened.store.automaticUploadIntents.hasPendingPerson(f.person.id, fingerprint)).toBe(false);
    const batch = reopened.store.automaticUploadIntents.finalize(intentId)!;
    expect(jobFor(reopened, batch.batchId).id).toBe(reopened.store.listStoredJobs()[0]!.id);
  });

  it.each(['logout', 'person_changed', 'source_changed', 'excluded'])('中断上传恢复重新核对%s，不扩大发送范围', async (change) => {
    const f = fixture(); await f.service.automaticUploadRecovery;
    const intentId = f.service.store.automaticUploadIntents.begin({ personId: f.person.id,
      accountFingerprint: fingerprint, authorizationEpoch: f.service.store.getAutomaticUploadAuthorizationEpoch(),
      version: 1, promptVersion: 'synthetic', rulesVersion: 'synthetic', displayNames: ['合成范围保护.txt'] });
    const source = f.service.store.putSourceObject({ bytes: Buffer.from('合成范围保护原件'), mediaType: 'text/plain', displayName: '合成范围保护.txt' });
    const document = f.service.store.registerImportedDocument({ sourceObjectId: source.id, personId: f.person.id,
      assignmentBasis: 'user_selected', uploadIntent: { intentId, itemIndex: 0 } });
    if (change === 'logout') f.service.store.revokeAllAiAuthorizations();
    else database(f.service, (db) => {
      if (change === 'person_changed') db.prepare('UPDATE documents SET person_id=NULL WHERE id=?').run(document.documentId);
      if (change === 'source_changed') db.prepare('UPDATE source_objects SET sha256=? WHERE id=?').run('0'.repeat(64), source.id);
      if (change === 'excluded') db.prepare('UPDATE documents SET excluded_from_analysis=1 WHERE id=?').run(document.documentId);
    });
    f.service.close();
    const reopened = new PersonalWorkspaceService(f.root, '合成意图保护');
    fixtures.find((item) => item.root === f.root)!.service = reopened;
    await reopened.automaticUploadRecovery;
    expect(reopened.store.listStoredJobs()).toHaveLength(0);
    expect(reopened.store.automaticUploadIntents.hasPendingPerson(f.person.id, fingerprint)).toBe(false);
  });

  it('契约需显式autoProcess，旧调用和旧收据仍兼容', () => {
    expect(importFilesInputSchema.parse({ personId: null })).toEqual({ personId: null });
    expect(importFilesInputSchema.parse({ personId: null, autoProcess: true }).autoProcess).toBe(true);
    expect(droppedFilePathsInputSchema.parse({ personId: null, paths: ['/synthetic/a.txt'], autoProcess: true }).autoProcess).toBe(true);
    expect(() => importFilesInputSchema.parse({ personId: null, autoProcess: false })).toThrow();
    expect(importFilesReceiptSchema.parse({ selectedCount: 0, importedCount: 0, duplicateCount: 0, suppressedCount: 0,
      rejected: [] }).processing).toBeUndefined();
  });

  it('低层导入仍仅在本机；自动入口只排本次新原件，不夹带旧文件', async () => {
    const { service, person } = fixture();
    await service.importFiles(files('旧本机文件'), person.id);
    expect(service.store.listStoredJobs()).toHaveLength(0);
    const receipt = await automatic(service, person.id, '新自动文件');
    expect(receipt.processing?.status).toBe('queued');
    const job = jobFor(service, receipt.processing!.batchId!);
    const ids = JSON.parse(job.checkpoint_json).documentIds as string[];
    expect(ids).toHaveLength(1);
    const consent = consentFor(service, job.id);
    expect(consent.purpose).toBe('automatic_upload_processing');
    expect(consent.account_fingerprint).toBe(fingerprint);
    expect(JSON.parse(consent.scope_json).documentIds).toEqual(ids);
    expect(begin(service).documentIds).toEqual(ids);
  });

  it('同次多份合并一个任务，按需加载原件；重复上传不产生新任务', async () => {
    const { service, person } = fixture();
    const order: string[] = [];
    const receipt = await service.importFilesAndProcess(['甲', '乙'].map((label) => ({ path: `/synthetic/${label}.txt`,
      bytes: async () => { order.push(label); return Buffer.from(`合成惰性报告 ${label}`); } })), person.id,
    { accountState: account, consentVersion: 1 });
    expect(order).toEqual(['甲', '乙']);
    expect(service.store.listStoredJobs()).toHaveLength(1);
    expect(service.store.listStoredJobs()[0]!.documentIds).toHaveLength(2);
    expect(receipt.importedCount).toBe(2);
    const duplicate = await service.importFilesAndProcess([{ path: '/synthetic/甲.txt', bytes: Buffer.from('合成惰性报告 甲') }],
      person.id, { accountState: account, consentVersion: 1 });
    expect(duplicate.duplicateCount).toBe(1);
    expect(duplicate.processing?.status).toBe('local_only');
    expect(service.store.listStoredJobs()).toHaveLength(1);
  });

  it('无成员只保存在本机，不将公共待归属资料发送', async () => {
    const { service } = fixture();
    expect((await automatic(service, null, '未归属报告')).processing?.status).toBe('local_only');
    expect(service.store.listStoredJobs()).toHaveLength(0);
  });

  it('异步导入期间退出Codex会阻止建立新授权，原件仍在本机', async () => {
    const { service, person } = fixture();
    const receipt = await service.importFilesAndProcess([{ path: '/synthetic/撤权期间上传.txt', bytes: async () => {
      service.store.revokeAllAiAuthorizations();
      return Buffer.from('合成撤权竞态报告');
    } }], person.id, { accountState: account, consentVersion: 1 });
    expect(receipt.importedCount).toBe(1);
    expect(receipt.processing?.status).toBe('local_only');
    expect(service.store.listStoredJobs()).toHaveLength(0);
    expect(service.store.listImportedDocuments()).toHaveLength(1);
    expect(requeueCurrentAccountWaitingJobs(service.store, () => account)).toBe(0);
  });

  it('离线上传持久保存精确任务，重开后首次连接自动绑定，不扩大到旧本机资料', async () => {
    const f = fixture();
    await f.service.importFiles(files('旧未授权报告'), f.person.id);
    const receipt = await automatic(f.service, f.person.id, '离线新报告', { ...account, status: 'disconnected', displayLabel: null });
    expect(receipt.processing?.status).toBe('waiting_connection');
    const row = jobFor(f.service, receipt.processing!.batchId!);
    f.service.close();
    const reopened = new PersonalWorkspaceService(f.root, '合成自动上传');
    fixtures.find((item) => item.root === f.root)!.service = reopened;
    expect(requeueCurrentAccountWaitingJobs(reopened.store, () => account)).toBeGreaterThan(0);
    const active = begin(reopened);
    expect(active.id).toBe(row.id);
    expect(active.documentIds).toHaveLength(1);
    expect(consentFor(reopened, row.id).account_fingerprint).toBe(fingerprint);
    expect(reopened.store.bindPendingAutomaticUploads('different-account')).toBe(0);
  });

  it.each(['cancelled', 'revoked', 'source_changed', 'excluded', 'person_changed', 'archived'])('离线%s后不能自动发送', async (change) => {
    const { service, person } = fixture();
    const receipt = await automatic(service, person.id, `离线阻止${change}`, { ...account, status: 'disconnected', displayLabel: null });
    const row = jobFor(service, receipt.processing!.batchId!);
    const documentId = (JSON.parse(row.checkpoint_json).documentIds as string[])[0]!;
    const consent = consentFor(service, row.id);
    if (change === 'cancelled') service.store.requestJobCancellation(row.id);
    else if (change === 'revoked') service.store.revokeConsent(consent.id);
    else database(service, (db) => {
      if (change === 'source_changed') db.prepare('UPDATE source_objects SET sha256=? WHERE id=(SELECT source_object_id FROM documents WHERE id=?)')
        .run('0'.repeat(64), documentId);
      if (change === 'excluded') db.prepare('UPDATE documents SET excluded_from_analysis=1 WHERE id=?').run(documentId);
      if (change === 'person_changed') db.prepare('UPDATE documents SET person_id=NULL WHERE id=?').run(documentId);
      if (change === 'archived') db.prepare('UPDATE persons SET archived_at=? WHERE id=?').run('2026-10-17T00:00:00Z', person.id);
    });
    expect(service.store.bindPendingAutomaticUploads(fingerprint)).toBe(0);
    service.store.requeueWaitingJobs('waiting_auth');
    expect(service.store.claimNextQueuedJob('synthetic-blocked-runner', fingerprint)).toBeNull();
    if (!['cancelled', 'revoked'].includes(change)) {
      expect(service.store.listStoredJobs()[0]!.status).toBe('completed_with_issues');
      expect(service.store.listStoredJobs()[0]!.statusText).toContain('范围已发生变化');
    }
  });

  it('连续同成员自动上传先完成报告，后续同账户任务负责最新综合', async () => {
    const { service, person } = fixture();
    const first = await automatic(service, person.id, '连续甲');
    const firstId = jobFor(service, first.processing!.batchId!).id;
    expect(service.store.shouldDeferAutomaticUploadAssessment(firstId)).toBe(false);
    await automatic(service, person.id, '连续乙');
    expect(service.store.shouldDeferAutomaticUploadAssessment(firstId)).toBe(true);
  });

  it.each(['excluded', 'person_changed', 'cancelled'])('后续上传%s时，延期的综合责任持久保留并可继续', async (change) => {
    const f = fixture();
    await automatic(f.service, f.person.id, `延期甲${change}`);
    const first = begin(f.service);
    f.service.store.markJobDocumentProcessed(first.id, first.documentIds[0]!, 'partial', first.guard);
    f.service.store.updateJobProgress(first.id, 1);
    const receipt = await automatic(f.service, f.person.id, `延期乙${change}`);
    const second = jobFor(f.service, receipt.processing!.batchId!);
    const secondDocumentId = (JSON.parse(second.checkpoint_json).documentIds as string[])[0]!;
    f.service.store.deferAutomaticUploadAssessment(first.guard);
    f.service.store.finishJobAttempt({ attemptId: first.guard.attemptId, status: 'succeeded' });
    expect(f.service.store.listStoredJobs().find((job) => job.id === first.id)).toMatchObject({ status: 'queued', stage: 'analyze' });
    if (change === 'cancelled') f.service.store.requestJobCancellation(second.id);
    else database(f.service, (db) => db.prepare(change === 'excluded'
      ? 'UPDATE documents SET excluded_from_analysis=1 WHERE id=?'
      : 'UPDATE documents SET person_id=NULL WHERE id=?').run(secondDocumentId));
    f.service.close();
    const reopened = new PersonalWorkspaceService(f.root, '合成自动上传');
    fixtures.find((item) => item.root === f.root)!.service = reopened;
    const resumed = begin(reopened);
    expect(resumed.id).toBe(first.id);
    expect(resumed.stage).toBe('analyze');
    expect(reopened.store.getJobProcessedDocumentIds(first.id)).toEqual(new Set(first.documentIds));
  });

  it('后续报告等待未来重试时，不反复领取延期综合；失效后自动恢复既有综合责任', async () => {
    const { service, person } = fixture();
    await automatic(service, person.id, '重试延期甲');
    const first = begin(service);
    const secondReceipt = await automatic(service, person.id, '重试延期乙');
    const secondId = jobFor(service, secondReceipt.processing!.batchId!).id;
    service.store.deferAutomaticUploadAssessment(first.guard);
    service.store.finishJobAttempt({ attemptId: first.guard.attemptId, status: 'succeeded' });
    const second = begin(service);
    expect(second.id).toBe(secondId);
    service.store.finishModelBusyAttempt({ guard: second.guard,
      analysisAiPreferences: { modelId: 'gpt-6.1-sol', reasoningEffort: 'medium' } });
    expect(service.store.claimNextQueuedJob('synthetic-deferred-check', fingerprint)).toBeNull();
    expect(service.store.claimNextQueuedJob('synthetic-deferred-check', fingerprint)).toBeNull();
    expect(service.store.listStoredJobs().find((job) => job.id === first.id)!.status).toBe('queued');
    database(service, (db) => db.prepare('UPDATE documents SET excluded_from_analysis=1 WHERE id=?').run(second.documentIds[0]!));
    expect(begin(service).id).toBe(first.id);
  });

  it('旧账户任务不阻挡当前账户上传，不把授权切到另一账户', async () => {
    const { service, person } = fixture();
    const old = await automatic(service, person.id, '旧账户上传', { ...account, displayLabel: 'old-synthetic@example.test' });
    const current = await automatic(service, person.id, '当前账户上传');
    const oldId = jobFor(service, old.processing!.batchId!).id;
    const currentId = jobFor(service, current.processing!.batchId!).id;
    database(service, (db) => db.prepare("UPDATE jobs SET created_at='2026-01-01T00:00:00Z' WHERE id=?").run(oldId));
    expect(service.store.shouldDeferAutomaticUploadAssessment(currentId)).toBe(false);
    expect(begin(service).id).toBe(currentId);
    expect(service.store.listStoredJobs().find((job) => job.id === oldId)!.status).toBe('waiting_auth');
    expect(requeueCurrentAccountWaitingJobs(service.store, () => account)).toBe(0);
    expect(consentFor(service, oldId).account_fingerprint).not.toBe(fingerprint);
  });

  it('自动综合可用授权后同成员新接纳的事实，手动任务仍受原授权快照约束', async () => {
    const { service, person } = fixture();
    const receipt = await automatic(service, person.id, '综合范围');
    const recent = publishHistory(service, person.id, '授权后接纳历史');
    const run = begin(service);
    expect(() => service.store.assertObservationScopeActive(run.guard, person.id, [recent])).not.toThrow();
    expect(() => service.store.assertObservationScopeActive(run.guard, person.id, [{ ...recent, id: '伪造未接纳ID' }]))
      .toThrow('HISTORICAL_FACTS_OUTSIDE_CONSENT_SCOPE');
    service.store.finishJobAttempt({ attemptId: run.guard.attemptId, status: 'succeeded' });
    service.store.finishJob(run.id, 'succeeded');
    const autoDocumentIds = JSON.parse(jobFor(service, receipt.processing!.batchId!).checkpoint_json).documentIds as string[];
    const manualConsentId = service.store.createManualProcessingConsent({ documentIds: autoDocumentIds, personIds: [person.id],
      historicalObservationIds: [], accountFingerprint: fingerprint, version: 1 });
    service.store.createWaitingAuthBatch({ cutoff: '2026-10-17T00:00:00Z', initialStatus: 'queued', consentId: manualConsentId,
      groups: [{ personId: person.id, documentIds: autoDocumentIds, inputSignature: 'synthetic-manual-frozen-history' }] });
    const manual = begin(service);
    expect(() => service.store.assertObservationScopeActive(manual.guard, person.id, [recent]))
      .toThrow('HISTORICAL_FACTS_OUTSIDE_CONSENT_SCOPE');
  });

  it.each(['foreign', 'excluded', 'identity_hold', 'protected', 'uncommitted', 'source_changed'])('自动历史不能夹带%s事实', async (kind) => {
    const { service, person } = fixture();
    await automatic(service, person.id, `历史门禁${kind}`);
    const other = kind === 'foreign' ? service.store.createPerson({ displayName: '合成其他成员' }) : person;
    const fact = publishHistory(service, other.id, `合成历史${kind}`);
    if (kind === 'excluded') database(service, (db) => db.prepare('UPDATE documents SET excluded_from_analysis=1 WHERE id=?').run(fact.documentId));
    if (kind === 'uncommitted') database(service, (db) => db.prepare('DELETE FROM document_commits WHERE document_id=?').run(fact.documentId));
    if (kind === 'source_changed') database(service, (db) => db.prepare('UPDATE source_manifests SET sha256=? WHERE document_id=?')
      .run('0'.repeat(64), fact.documentId));
    if (kind === 'identity_hold' || kind === 'protected') service.store.saveExtractionReviewIssue({ documentId: fact.documentId,
      kind: kind === 'identity_hold' ? 'person_conflict' : 'overwrite_protected', severity: 'blocking', evidenceRefs: [],
      reasonCodes: ['synthetic-scope-protection'], stage: 'extract' });
    const run = begin(service);
    expect(() => service.store.assertObservationScopeActive(run.guard, person.id, [fact]))
      .toThrow('HISTORICAL_FACTS_OUTSIDE_CONSENT_SCOPE');
  });

  it('手动授权伪造automaticUpload字段不能取得自动历史能力', async () => {
    const { service, person } = fixture();
    await automatic(service, person.id, '伪造自动标记');
    const job = service.store.listStoredJobs()[0]!;
    const consent = consentFor(service, job.id);
    database(service, (db) => db.prepare("UPDATE consents SET purpose='manual_health_report_processing' WHERE id=?").run(consent.id));
    expect(service.store.claimNextQueuedJob('synthetic-forged-runner', fingerprint)).toBeNull();
  });

  it('自动上传重启后保留逐份断点和恢复预算，旧attempt准确结算为中断', async () => {
    const f = fixture();
    await f.service.importFilesAndProcess([...files('重启甲'), ...files('重启乙')], f.person.id,
      { accountState: account, consentVersion: 1 });
    const run = begin(f.service);
    f.service.store.markJobDocumentProcessed(run.id, run.documentIds[0]!, 'needs_review', run.guard);
    f.service.store.updateJobProgress(run.id, 1);
    database(f.service, (db) => {
      const row = db.prepare('SELECT checkpoint_json FROM jobs WHERE id=?').get(run.id) as { checkpoint_json: string };
      const checkpoint = JSON.parse(row.checkpoint_json) as Record<string, unknown>;
      db.prepare('UPDATE jobs SET checkpoint_json=? WHERE id=?').run(JSON.stringify({ ...checkpoint,
        preservedSyntheticBudget: { formatRepairs: 1, sourceRepairs: 1 } }), run.id);
    });
    f.service.close();
    const reopened = new PersonalWorkspaceService(f.root, '合成自动上传');
    fixtures.find((item) => item.root === f.root)!.service = reopened;
    expect(reopened.store.listStoredJobs()[0]!.status).toBe('queued');
    expect(reopened.store.hasQueuedAutomaticUploads()).toBe(true);
    expect(reopened.store.getJobProcessedDocumentIds(run.id)).toEqual(new Set([run.documentIds[0]]));
    expect(reopened.store.listStoredJobs()[0]!.completedUnits).toBe(1);
    const before = database(reopened, (db) => db.prepare('SELECT status,error_code,finished_at FROM job_attempts WHERE id=?')
      .get(run.guard.attemptId)) as { status: string; error_code: string; finished_at: string | null };
    expect(before.status).toBe('failed');
    expect(before.error_code).toBe('APP_RESTART_INTERRUPTED');
    expect(before.finished_at).not.toBeNull();
    const checkpoint = database(reopened, (db) => db.prepare('SELECT checkpoint_json FROM jobs WHERE id=?').get(run.id)) as { checkpoint_json: string };
    expect(JSON.parse(checkpoint.checkpoint_json).preservedSyntheticBudget).toEqual({ formatRepairs: 1, sourceRepairs: 1 });
    expect(() => reopened.store.assertJobExecutionActive(run.guard)).toThrow('JOB_EXECUTION_INACTIVE');
    expect(reopened.store.claimNextQueuedJob('synthetic-different-account', 'different-account')).toBeNull();
    expect(reopened.store.listStoredJobs()[0]!.status).toBe('waiting_auth');
    requeueCurrentAccountWaitingJobs(reopened.store, () => account);
    expect(begin(reopened).id).toBe(run.id);
  });

  it.each(['cancelled', 'revoked', 'manual', 'source_changed'])('重启不恢复%s任务', async (kind) => {
    const f = fixture();
    if (kind === 'manual') {
      await f.service.importFiles(files('手动重启'), f.person.id);
      f.service.processNow({ accountState: account, consentVersion: 1 });
    } else await automatic(f.service, f.person.id, `重启保护${kind}`);
    const run = begin(f.service);
    if (kind === 'cancelled') f.service.store.requestJobCancellation(run.id);
    if (kind === 'revoked') f.service.store.revokeConsent(run.consentId);
    if (kind === 'source_changed') database(f.service, (db) => db.prepare('UPDATE documents SET excluded_from_analysis=1 WHERE id=?')
      .run(run.documentIds[0]!));
    f.service.close();
    const reopened = new PersonalWorkspaceService(f.root, '合成自动上传');
    fixtures.find((item) => item.root === f.root)!.service = reopened;
    expect(reopened.store.listStoredJobs()[0]!.status).toBe('failed');
    expect(reopened.store.claimNextQueuedJob('synthetic-no-recovery', fingerprint)).toBeNull();
  });
});
