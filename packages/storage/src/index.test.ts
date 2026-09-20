import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { RevisionConflictError, WorkspaceStore } from './index.js';

const directories: string[] = [];
function makeStore(options: {
  busyTimeoutMs?: number;
  failureInjector?: (point: 'after_source_object_insert' | 'during_schema_migration') => void;
} = {}): WorkspaceStore {
  const directory = mkdtempSync(join(tmpdir(), 'family-health-store-'));
  directories.push(directory);
  return new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:00:00Z'), ...options });
}

function createSchemaV2Database(directory: string): void {
  const database = new Database(join(directory, 'health.db'));
  database.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, created_at TEXT NOT NULL,
      settings_revision INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    INSERT INTO workspaces (id, schema_version, created_at, settings_revision)
    VALUES ('workspace-v2', 2, '2026-09-17T00:00:00Z', 4);
    PRAGMA user_version = 2;
  `);
  database.close();
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('WorkspaceStore', () => {
  it('数据库被其他写入者锁定时快速失败且不留下半事务，解锁后可恢复', () => {
    const store = makeStore({ busyTimeoutMs: 5 });
    const locker = new Database(store.databasePath);
    locker.exec('BEGIN IMMEDIATE');
    expect(() => store.createPerson({ displayName: '锁定期间不应写入' })).toThrow(/database is locked/i);
    locker.exec('ROLLBACK');
    locker.close();
    expect(store.listPersons()).toEqual([]);
    expect(store.createPerson({ displayName: '解锁后恢复' })).toMatchObject({ displayName: '解锁后恢复' });
    expect(store.integrityCheck()).toBe('ok');
    store.close();
  });

  it('数据库容量耗尽时对象登记与审计一并回滚，并清理未引用对象文件', () => {
    let failOnce = true;
    const store = makeStore({
      busyTimeoutMs: 5,
      failureInjector: () => {
        if (!failOnce) return;
        failOnce = false;
        throw new Error('database or disk is full');
      }
    });

    const bytes = Buffer.from('磁盘容量故障下的纯虚构对象');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const objectPath = join(store.vaultDirectory, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
    expect(() => store.putSourceObject({
      bytes,
      mediaType: 'text/plain',
      displayName: `${'x'.repeat(256 * 1024)}.txt`
    })).toThrow(/database or disk is full/i);
    expect(existsSync(objectPath)).toBe(false);
    expect(store.putSourceObject({ bytes, mediaType: 'text/plain', displayName: 'retry-after-space.txt' })).toMatchObject({ duplicate: false });
    expect(existsSync(objectPath)).toBe(true);
    expect(store.integrityCheck()).toBe('ok');
    store.close();
  });

  it('从 schema v2 原位升级并保留工作区', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v2-'));
    directories.push(directory);
    createSchemaV2Database(directory);
    const store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:00:00Z') });
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(28);
    expect(upgraded.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'document_conversions'`).get()).toEqual({ name: 'document_conversions' });
    upgraded.close();
    expect(store.isQueuePaused()).toBe(false);
    store.setQueuePaused(true);
    expect(store.isQueuePaused()).toBe(true);
    const backupNames = readdirSync(store.schemaBackupDirectory).filter((name) => name.endsWith('.db'));
    expect(backupNames).toHaveLength(1);
    const backup = new Database(join(store.schemaBackupDirectory, backupNames[0]!), { readonly: true });
    expect(backup.pragma('user_version', { simple: true })).toBe(2);
    expect(backup.prepare('SELECT id, settings_revision FROM workspaces').get()).toEqual({ id: 'workspace-v2', settings_revision: 4 });
    backup.close();
    store.close();
  });

  it('schema 多步升级失败时整体回滚并保留升级前一致性备份', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-migration-failure-'));
    directories.push(directory);
    createSchemaV2Database(directory);

    expect(() => new WorkspaceStore({
      rootDirectory: directory,
      now: () => new Date('2026-09-18T00:00:00Z'),
      failureInjector: (point) => {
        if (point === 'during_schema_migration') throw new Error('simulated migration failure');
      }
    })).toThrow('simulated migration failure');

    const database = new Database(join(directory, 'health.db'), { readonly: true });
    expect(database.pragma('user_version', { simple: true })).toBe(2);
    expect(database.prepare('SELECT id, schema_version, settings_revision FROM workspaces').get()).toEqual({
      id: 'workspace-v2',
      schema_version: 2,
      settings_revision: 4
    });
    const columns = database.pragma('table_info(workspaces)') as Array<{ name: string }>;
    expect(columns.some((column) => column.name === 'queue_paused')).toBe(false);
    database.close();

    const backupDirectory = join(directory, 'recovery-points');
    const backupNames = readdirSync(backupDirectory).filter((name) => name.endsWith('.db'));
    expect(backupNames).toHaveLength(1);
    const backup = new Database(join(backupDirectory, backupNames[0]!), { readonly: true });
    expect(backup.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(backup.pragma('user_version', { simple: true })).toBe(2);
    backup.close();
  });

  it('旧版应用打开更高 schema 时在任何写入前拒绝', () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-newer-schema-'));
    directories.push(directory);
    const databasePath = join(directory, 'health.db');
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE downgrade_canary (value TEXT NOT NULL) STRICT;
      INSERT INTO downgrade_canary (value) VALUES ('must remain byte-for-byte unchanged');
      PRAGMA user_version = 99;
    `);
    database.close();
    const before = readFileSync(databasePath);

    expect(() => new WorkspaceStore({ rootDirectory: directory })).toThrow('WORKSPACE_SCHEMA_NEWER_THAN_APP');
    expect(readFileSync(databasePath)).toEqual(before);
    expect(existsSync(join(directory, 'vault'))).toBe(false);
    expect(existsSync(join(directory, 'recovery-points'))).toBe(false);
  });

  it('同一字节只保存一个对象，同时保留不可变内容', () => {
    const store = makeStore();
    const bytes = Buffer.from('完全虚构的健康报告');
    const first = store.putSourceObject({ bytes, mediaType: 'text/plain', displayName: 'a.txt' });
    const second = store.putSourceObject({ bytes, mediaType: 'text/plain', displayName: 'renamed.txt' });
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.id).toBe(first.id);
    expect(readFileSync(join(store.vaultDirectory, first.vaultRelativePath))).toEqual(bytes);
    store.close();
  });

  it('完整保存 SourceManifest 的覆盖缺口与转换警告', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员' });
    const source = store.putSourceObject({ bytes: Buffer.from('覆盖缺口'), mediaType: 'text/plain', displayName: '缺口.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.saveSourceManifest({
      id: 'manifest-gap', sourceObjectId: source.id, sha256: source.sha256, mediaType: 'text/plain',
      originalDisplayName: '缺口.txt', totalUnits: 3, coveredUnitIndexes: [0, 2],
      spans: [
        { id: 'gap-0', documentId: document.documentId, spanKind: 'line', page: null, blockId: null, lineStart: 1, lineEnd: 1, quote: '第一段', readability: 'clear' },
        { id: 'gap-2', documentId: document.documentId, spanKind: 'line', page: null, blockId: null, lineStart: 3, lineEnd: 3, quote: '第三段', readability: 'partial' }
      ],
      normalizerVersion: 'manifest-test-v1', conversionWarnings: ['synthetic_conversion_warning'],
      createdAt: '2026-09-18T00:00:00.000Z'
    });
    expect(store.getDocumentExtractionBundle(document.documentId).manifest).toMatchObject({
      id: 'manifest-gap', totalUnits: 3, coveredUnitIndexes: [0, 2],
      normalizerVersion: 'manifest-test-v1', conversionWarnings: expect.arrayContaining(['synthetic_conversion_warning'])
    });
    store.close();
  });

  it('schema v8 将旧身份冲突升级为可确认关系，并在确认后保留报告姓名', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v7-identity-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:00:00Z') });
    const person = store.createPerson({ displayName: '书书', relation: '本人' });
    const source = store.putSourceObject({ bytes: Buffer.from('姓 名 ： 测试姓名甲 性 别 ： 男'), mediaType: 'text/plain', displayName: '体检报告.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.saveSourceManifest({
      id: 'manifest-identity', sourceObjectId: source.id, sha256: source.sha256, mediaType: 'text/plain',
      originalDisplayName: '体检报告.txt', totalUnits: 1, coveredUnitIndexes: [0],
      spans: [{ id: 'identity-span', documentId: document.documentId, spanKind: 'line', page: 1, blockId: null, lineStart: 1, lineEnd: 1, quote: '姓 名 ： 测试姓名甲 性 别 ： 男', readability: 'clear' }],
      normalizerVersion: 'manifest-test-v1', conversionWarnings: [], createdAt: '2026-09-18T00:00:00.000Z'
    });
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId, kind: 'field_conflict', severity: 'blocking', evidenceRefs: ['identity-span']
    });
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`UPDATE workspaces SET schema_version = 7; PRAGMA user_version = 7;`);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:01:00Z') });
    expect(store.listOpenExtractionReviewIssues()).toEqual([
      expect.objectContaining({ id: issueId, kind: 'person_conflict', reportedName: '测试姓名甲' })
    ]);
    store.confirmDocumentIdentity({ issueId, documentId: document.documentId, personId: person.id });
    expect(store.getDocumentExtractionBundle(document.documentId)).toMatchObject({
      personAssignmentBasis: 'identity_confirmed', confirmedReportedName: '测试姓名甲'
    });
    expect(store.listOpenExtractionReviewIssues()).toEqual([]);
    expect(store.listReadyDocuments()).toEqual([{ id: document.documentId, personId: person.id }]);
    store.close();
  });

  it('schema v9 只重试可恢复的旧 PDF 覆盖误拦截，必须由原文件复核后才补全清单', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v8-pdf-manifest-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:00:00Z') });
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const source = store.putSourceObject({ bytes: Buffer.from('旧版 PDF 占位内容'), mediaType: 'application/pdf', displayName: '旧版体检报告.pdf' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.saveSourceManifest({
      id: 'legacy-pdf-manifest', sourceObjectId: source.id, sha256: source.sha256, mediaType: 'application/pdf',
      originalDisplayName: '旧版体检报告.pdf', totalUnits: 2, coveredUnitIndexes: [0, 1],
      spans: [
        { id: 'legacy-page-1', documentId: document.documentId, spanKind: 'page', page: 1, blockId: null, lineStart: null, lineEnd: null, quote: '第一页内容', readability: 'clear' },
        { id: 'legacy-page-2', documentId: document.documentId, spanKind: 'page', page: 2, blockId: null, lineStart: null, lineEnd: null, quote: '第二页内容', readability: 'clear' }
      ],
      normalizerVersion: 'pdfjs-5.4-text-v1', conversionWarnings: [], createdAt: '2026-09-18T00:00:00.000Z'
    });
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'coverage_gap',
      severity: 'blocking',
      evidenceRefs: ['legacy-page-1'],
      candidateOptions: [{
        localKey: 'candidate-1', originalName: '收缩压', standardNameCandidate: null,
        value: { kind: 'numeric', rawText: '107', decimal: '107', comparator: 'eq' },
        unitRaw: 'mmHg', referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: null, bodySite: null, clinicalDate: '2023-10-08',
        evidence: [{ sourceSpanId: 'legacy-page-1', quote: '第一页内容' }], issues: []
      }]
    });
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`
      DELETE FROM source_manifests WHERE document_id = '${document.documentId}';
      UPDATE workspaces SET schema_version = 8;
      PRAGMA user_version = 8;
    `);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:01:00Z') });
    const pendingRecovery = store.getDocumentExtractionBundle(document.documentId);
    expect(pendingRecovery.manifest.coveredUnitIndexes).toEqual([]);
    expect(pendingRecovery.manifest.conversionWarnings).toContain('historical_manifest_metadata_unavailable');
    expect(store.listOpenExtractionReviewIssues().some((issue) => issue.id === issueId)).toBe(false);
    expect(store.listReadyDocuments()).toEqual([{ id: document.documentId, personId: person.id }]);

    expect(() => store.reconstructLegacyPdfManifest({
      documentId: document.documentId,
      sha256: source.sha256,
      totalPages: 3,
      normalizerVersion: 'pdfjs-5.4-text-v1'
    })).toThrow('LEGACY_PDF_MANIFEST_RECOVERY_UNSAFE');
    expect(store.reconstructLegacyPdfManifest({
      documentId: document.documentId,
      sha256: source.sha256,
      totalPages: 2,
      normalizerVersion: 'pdfjs-5.4-text-v1'
    })).toBe(true);
    expect(store.getDocumentExtractionBundle(document.documentId).manifest).toMatchObject({
      totalUnits: 2,
      coveredUnitIndexes: [0, 1],
      conversionWarnings: ['historical_manifest_reconstructed_from_verified_pdf']
    });
    store.close();
  });

  it('schema v11 只重试仅有非阻断标记差异的旧血压组合值核对', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v9-blood-pressure-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:00:00Z') });
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const sourceText = '检查日期 2023-10-08 血压 107/70 mmHg 收缩压 107 mmHg 舒张压 70 mmHg';
    const source = store.putSourceObject({ bytes: Buffer.from(sourceText), mediaType: 'text/plain', displayName: '血压体检报告.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.saveSourceManifest({
      id: 'blood-pressure-manifest', sourceObjectId: source.id, sha256: source.sha256, mediaType: 'text/plain',
      originalDisplayName: '血压体检报告.txt', totalUnits: 1, coveredUnitIndexes: [0],
      spans: [{ id: 'blood-pressure-span', documentId: document.documentId, spanKind: 'line', page: 1, blockId: null, lineStart: 1, lineEnd: 1, quote: sourceText, readability: 'clear' }],
      normalizerVersion: 'manifest-test-v1', conversionWarnings: [], createdAt: '2026-09-18T00:00:00.000Z'
    });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: 'e'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: ['blood-pressure-span'],
      candidateOptions: [{
        localKey: 'blood-pressure', originalName: '血压', standardNameCandidate: '血压',
        value: { kind: 'text', rawText: '107/70' },
        unitRaw: 'mmHg', referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: null, bodySite: null, clinicalDate: '2023-10-08',
        evidence: [{ sourceSpanId: 'blood-pressure-span', quote: sourceText }],
        issues: [{ code: 'pair_value_preserved', message: '保留报告中的成对表达' }]
      }],
      candidateDiffs: [{ localKey: 'blood-pressure', itemName: '血压', fields: ['issues'] }]
    });
    store.finishJob(job.id, 'waiting_user');
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`UPDATE workspaces SET schema_version = 10; PRAGMA user_version = 10;`);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:01:00Z') });
    expect(store.listOpenExtractionReviewIssues().some((issue) => issue.id === issueId)).toBe(false);
    expect(store.listReadyDocuments()).toEqual([{ id: document.documentId, personId: person.id }]);
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'queued', completedUnits: 0, totalUnits: 1 });
    expect(store.getFactRevision(person.id)).toBe(0);
    expect(store.listAcceptedObservations(person.id)).toEqual([]);
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(28);
    upgraded.close();
    store.close();
  });

  it('schema v12 只重试同一来源片段内临床日期唯一的旧证据上下文误拦截', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v11-date-context-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:00:00Z') });
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const sourceText = '检查日期：2023-10-08 检查结果 身高 187 厘米';
    const source = store.putSourceObject({ bytes: Buffer.from(sourceText), mediaType: 'text/plain', displayName: '身高体检报告.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.saveSourceManifest({
      id: 'height-manifest', sourceObjectId: source.id, sha256: source.sha256, mediaType: 'text/plain',
      originalDisplayName: '身高体检报告.txt', totalUnits: 1, coveredUnitIndexes: [0],
      spans: [{ id: 'height-span', documentId: document.documentId, spanKind: 'line', page: 1, blockId: null, lineStart: 1, lineEnd: 1, quote: sourceText, readability: 'clear' }],
      normalizerVersion: 'manifest-test-v1', conversionWarnings: [], createdAt: '2026-09-18T00:00:00.000Z'
    });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: 'f'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: ['height-span'],
      candidateOptions: [{
        localKey: 'height', originalName: '身高', standardNameCandidate: 'Height',
        value: { kind: 'numeric', rawText: '187', decimal: '187', comparator: 'eq' },
        unitRaw: '厘米', referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: null, bodySite: null, clinicalDate: '2023-10-08',
        evidence: [{ sourceSpanId: 'height-span', quote: '身高 187 厘米' }], issues: []
      }],
      candidateDiffs: [{ localKey: 'height', itemName: '身高', fields: ['issues'] }]
    });
    store.finishJob(job.id, 'waiting_user');
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`UPDATE workspaces SET schema_version = 11; PRAGMA user_version = 11;`);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:01:00Z') });
    expect(store.listOpenExtractionReviewIssues().some((issue) => issue.id === issueId)).toBe(false);
    expect(store.listReadyDocuments()).toEqual([{ id: document.documentId, personId: person.id }]);
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'queued', completedUnits: 0, totalUnits: 1 });
    expect(store.getFactRevision(person.id)).toBe(0);
    expect(store.listAcceptedObservations(person.id)).toEqual([]);
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(28);
    upgraded.close();
    store.close();
  });

  it('schema v13 只重试原文定性值有清晰依据的旧标准分类差异', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v12-qualitative-category-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:00:00Z') });
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const sourceText = '检查日期：2023-10-08 尿白细胞 (LEU) 隂性';
    const source = store.putSourceObject({ bytes: Buffer.from(sourceText), mediaType: 'text/plain', displayName: '尿常规报告.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.saveSourceManifest({
      id: 'qualitative-manifest', sourceObjectId: source.id, sha256: source.sha256, mediaType: 'text/plain',
      originalDisplayName: '尿常规报告.txt', totalUnits: 1, coveredUnitIndexes: [0],
      spans: [{ id: 'qualitative-span', documentId: document.documentId, spanKind: 'line', page: 1, blockId: null, lineStart: 1, lineEnd: 1, quote: sourceText, readability: 'clear' }],
      normalizerVersion: 'manifest-test-v1', conversionWarnings: [], createdAt: '2026-09-18T00:00:00.000Z'
    });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: '1'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: ['qualitative-span'],
      candidateOptions: [{
        localKey: 'urine-leukocyte', originalName: '尿白细胞 (LEU)', standardNameCandidate: null,
        value: { kind: 'qualitative', rawText: '隂性', category: '阴性' },
        unitRaw: null, referenceRangeRaw: '隂性', reportedAbnormalFlag: null,
        specimen: '尿液', method: '尿常规', bodySite: null, clinicalDate: '2023-10-08',
        evidence: [{ sourceSpanId: 'qualitative-span', quote: sourceText }], issues: []
      }],
      candidateDiffs: [{ localKey: 'urine-leukocyte', itemName: '尿白细胞 (LEU)', fields: ['value'] }]
    });
    store.finishJob(job.id, 'waiting_user');
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`UPDATE workspaces SET schema_version = 12; PRAGMA user_version = 12;`);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:01:00Z') });
    expect(store.listOpenExtractionReviewIssues().some((issue) => issue.id === issueId)).toBe(false);
    expect(store.listReadyDocuments()).toEqual([{ id: document.documentId, personId: person.id }]);
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'queued', completedUnits: 0, totalUnits: 1 });
    expect(store.getFactRevision(person.id)).toBe(0);
    expect(store.listAcceptedObservations(person.id)).toEqual([]);
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(28);
    upgraded.close();
    store.close();
  });

  it('schema v14 只重试项目文字唯一且前置检查日期一致的旧证据误拦截', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v13-section-date-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:00:00Z') });
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const sourceText = '检验科 幽门螺菌尿素酶抗体 检查日期：2023-10-08 项目名称 检查结果 幽门螺杆菌抗体测定 阴性 阴性 (-) 检验科 EB 病毒抗体 检查日期：2023-10-09 项目名称 检查结果 EB 病毒抗体 0.05';
    const source = store.putSourceObject({ bytes: Buffer.from(sourceText), mediaType: 'text/plain', displayName: '多科室体检报告.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.saveSourceManifest({
      id: 'section-date-manifest', sourceObjectId: source.id, sha256: source.sha256, mediaType: 'text/plain',
      originalDisplayName: '多科室体检报告.txt', totalUnits: 1, coveredUnitIndexes: [0],
      spans: [{ id: 'section-date-span', documentId: document.documentId, spanKind: 'line', page: 1, blockId: null, lineStart: 1, lineEnd: 1, quote: sourceText, readability: 'clear' }],
      normalizerVersion: 'manifest-test-v1', conversionWarnings: [], createdAt: '2026-09-18T00:00:00.000Z'
    });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: '2'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: ['section-date-span'],
      candidateOptions: [{
        localKey: 'h-pylori', originalName: '幽门螺杆菌抗体测定', standardNameCandidate: null,
        value: { kind: 'qualitative', rawText: '阴性', category: 'negative' },
        unitRaw: null, referenceRangeRaw: '阴性 (-)', reportedAbnormalFlag: null,
        specimen: null, method: null, bodySite: null, clinicalDate: '2023-10-08',
        evidence: [{ sourceSpanId: 'section-date-span', quote: '幽门螺杆菌抗体测定 阴性 阴性 (-)' }], issues: []
      }],
      candidateDiffs: [{ localKey: 'h-pylori', itemName: '幽门螺杆菌抗体测定', fields: ['issues'] }]
    });
    store.finishJob(job.id, 'waiting_user');
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`UPDATE workspaces SET schema_version = 13; PRAGMA user_version = 13;`);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:01:00Z') });
    expect(store.listOpenExtractionReviewIssues().some((issue) => issue.id === issueId)).toBe(false);
    expect(store.listReadyDocuments()).toEqual([{ id: document.documentId, personId: person.id }]);
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'queued', completedUnits: 0, totalUnits: 1 });
    expect(store.getFactRevision(person.id)).toBe(0);
    expect(store.listAcceptedObservations(person.id)).toEqual([]);
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(28);
    upgraded.close();
    store.close();
  });

  it('schema v15 只重试同一超声项目的方法别名差异', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v14-ultrasound-method-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:00:00Z') });
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const sourceText = '甲状腺彩超 检查日期：2023-10-09 小结 甲状腺回声异常';
    const source = store.putSourceObject({ bytes: Buffer.from(sourceText), mediaType: 'text/plain', displayName: '超声报告.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.saveSourceManifest({
      id: 'ultrasound-method-manifest', sourceObjectId: source.id, sha256: source.sha256, mediaType: 'text/plain',
      originalDisplayName: '超声报告.txt', totalUnits: 1, coveredUnitIndexes: [0],
      spans: [{ id: 'ultrasound-method-span', documentId: document.documentId, spanKind: 'line', page: 1, blockId: null, lineStart: 1, lineEnd: 1, quote: sourceText, readability: 'clear' }],
      normalizerVersion: 'manifest-test-v1', conversionWarnings: [], createdAt: '2026-09-18T00:00:00.000Z'
    });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: '3'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: ['ultrasound-method-span'],
      candidateOptions: [{
        localKey: 'thyroid-ultrasound', originalName: '甲状腺彩超小结', standardNameCandidate: 'Thyroid ultrasound impression',
        value: { kind: 'text', rawText: '甲状腺回声异常' },
        unitRaw: null, referenceRangeRaw: null, reportedAbnormalFlag: '异常',
        specimen: null, method: '甲状腺彩超', bodySite: '甲状腺', clinicalDate: '2023-10-09',
        evidence: [{ sourceSpanId: 'ultrasound-method-span', quote: sourceText }], issues: []
      }],
      candidateDiffs: [{ localKey: 'thyroid-ultrasound', itemName: '甲状腺彩超小结', fields: ['method'] }]
    });
    store.finishJob(job.id, 'waiting_user');
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`UPDATE workspaces SET schema_version = 14; PRAGMA user_version = 14;`);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:01:00Z') });
    expect(store.listOpenExtractionReviewIssues().some((issue) => issue.id === issueId)).toBe(false);
    expect(store.listReadyDocuments()).toEqual([{ id: document.documentId, personId: person.id }]);
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'queued', completedUnits: 0, totalUnits: 1 });
    expect(store.getFactRevision(person.id)).toBe(0);
    expect(store.listAcceptedObservations(person.id)).toEqual([]);
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(28);
    upgraded.close();
    store.close();
  });

  it('schema v16 只重试 PDF 排版空格造成的结果断字误拦截', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v15-whitespace-evidence-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:00:00Z') });
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const sourceText = '甲状腺彩超 检查日期：2023-10-09 小结 甲状腺回声异常，请结合实验室检 查';
    const source = store.putSourceObject({ bytes: Buffer.from(sourceText), mediaType: 'text/plain', displayName: '断字报告.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.saveSourceManifest({
      id: 'whitespace-evidence-manifest', sourceObjectId: source.id, sha256: source.sha256, mediaType: 'text/plain',
      originalDisplayName: '断字报告.txt', totalUnits: 1, coveredUnitIndexes: [0],
      spans: [{ id: 'whitespace-evidence-span', documentId: document.documentId, spanKind: 'line', page: 1, blockId: null, lineStart: 1, lineEnd: 1, quote: sourceText, readability: 'clear' }],
      normalizerVersion: 'manifest-test-v1', conversionWarnings: [], createdAt: '2026-09-18T00:00:00.000Z'
    });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: '4'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: ['whitespace-evidence-span'],
      candidateOptions: [{
        localKey: 'thyroid-ultrasound', originalName: '甲状腺彩超小结', standardNameCandidate: null,
        value: { kind: 'text', rawText: '甲状腺回声异常，请结合实验室检查' },
        unitRaw: null, referenceRangeRaw: null, reportedAbnormalFlag: '异常',
        specimen: null, method: '甲状腺彩超', bodySite: '甲状腺', clinicalDate: '2023-10-09',
        evidence: [{ sourceSpanId: 'whitespace-evidence-span', quote: sourceText }], issues: []
      }],
      candidateDiffs: [{ localKey: 'thyroid-ultrasound', itemName: '甲状腺彩超小结', fields: ['issues'] }]
    });
    store.finishJob(job.id, 'waiting_user');
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`UPDATE workspaces SET schema_version = 15; PRAGMA user_version = 15;`);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:01:00Z') });
    expect(store.listOpenExtractionReviewIssues().some((issue) => issue.id === issueId)).toBe(false);
    expect(store.listReadyDocuments()).toEqual([{ id: document.documentId, personId: person.id }]);
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'queued', completedUnits: 0, totalUnits: 1 });
    expect(store.getFactRevision(person.id)).toBe(0);
    expect(store.listAcceptedObservations(person.id)).toEqual([]);
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(28);
    upgraded.close();
    store.close();
  });

  it('schema v17 只重试有清晰原文依据的单侧正常小结', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v16-normal-summary-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:00:00Z') });
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const sourceText = '眼科 检查日期：2023-10-08 小结 未见异常';
    const source = store.putSourceObject({ bytes: Buffer.from(sourceText), mediaType: 'text/plain', displayName: '眼科报告.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.saveSourceManifest({
      id: 'normal-summary-manifest', sourceObjectId: source.id, sha256: source.sha256, mediaType: 'text/plain',
      originalDisplayName: '眼科报告.txt', totalUnits: 1, coveredUnitIndexes: [0],
      spans: [{ id: 'normal-summary-span', documentId: document.documentId, spanKind: 'line', page: 1, blockId: null, lineStart: 1, lineEnd: 1, quote: sourceText, readability: 'clear' }],
      normalizerVersion: 'manifest-test-v1', conversionWarnings: [], createdAt: '2026-09-18T00:00:00.000Z'
    });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: '5'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: ['normal-summary-span'],
      candidateOptions: [{
        localKey: 'eye-summary', originalName: '眼科小结', standardNameCandidate: 'Ophthalmology summary',
        value: { kind: 'qualitative', rawText: '未见异常', category: 'no abnormality detected' },
        unitRaw: null, referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: '眼科检查', bodySite: '眼', clinicalDate: '2023-10-08',
        evidence: [{ sourceSpanId: 'normal-summary-span', quote: sourceText }], issues: []
      }],
      candidateDiffs: [{ localKey: 'eye-summary', itemName: '眼科小结', fields: ['presence'] }]
    });
    store.finishJob(job.id, 'waiting_user');
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`UPDATE workspaces SET schema_version = 16; PRAGMA user_version = 16;`);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:01:00Z') });
    expect(store.listOpenExtractionReviewIssues().some((issue) => issue.id === issueId)).toBe(false);
    expect(store.listReadyDocuments()).toEqual([{ id: document.documentId, personId: person.id }]);
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'queued', completedUnits: 0, totalUnits: 1 });
    expect(store.getFactRevision(person.id)).toBe(0);
    expect(store.listAcceptedObservations(person.id)).toEqual([]);
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(28);
    upgraded.close();
    store.close();
  });

  it('schema v18 只重试有清晰项目名依据的单侧空白未知项', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v17-empty-unknown-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:00:00Z') });
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const sourceText = '眼科 检查日期：2023-10-08 裸眼视力 (右)    矫正视力 (右) 5.0';
    const source = store.putSourceObject({ bytes: Buffer.from(sourceText), mediaType: 'text/plain', displayName: '眼科报告.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.saveSourceManifest({
      id: 'empty-unknown-manifest', sourceObjectId: source.id, sha256: source.sha256, mediaType: 'text/plain',
      originalDisplayName: '眼科报告.txt', totalUnits: 1, coveredUnitIndexes: [0],
      spans: [{ id: 'empty-unknown-span', documentId: document.documentId, spanKind: 'line', page: 1, blockId: null, lineStart: 1, lineEnd: 1, quote: sourceText, readability: 'clear' }],
      normalizerVersion: 'manifest-test-v1', conversionWarnings: [], createdAt: '2026-09-18T00:00:00.000Z'
    });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: '6'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: ['empty-unknown-span'],
      candidateOptions: [{
        localKey: 'uncorrected-visual-acuity-right', originalName: '裸眼视力 (右)', standardNameCandidate: 'uncorrected_visual_acuity_right',
        value: { kind: 'unknown', rawText: null, reason: '报告对应栏位为空白' },
        unitRaw: null, referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: '眼科检查', bodySite: '右眼', clinicalDate: '2023-10-08',
        evidence: [{ sourceSpanId: 'empty-unknown-span', quote: sourceText }], issues: []
      }],
      candidateDiffs: [{ localKey: 'uncorrected-visual-acuity-right', itemName: '裸眼视力 (右)', fields: ['presence'] }]
    });
    store.finishJob(job.id, 'waiting_user');
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`UPDATE workspaces SET schema_version = 17; PRAGMA user_version = 17;`);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:01:00Z') });
    expect(store.listOpenExtractionReviewIssues().some((issue) => issue.id === issueId)).toBe(false);
    expect(store.listReadyDocuments()).toEqual([{ id: document.documentId, personId: person.id }]);
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'queued', completedUnits: 0, totalUnits: 1 });
    expect(store.getFactRevision(person.id)).toBe(0);
    expect(store.listAcceptedObservations(person.id)).toEqual([]);
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(28);
    upgraded.close();
    store.close();
  });

  it('schema v19 只重试字符相同但 PDF 空白排版不同的证据摘录', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v18-whitespace-citation-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:00:00Z') });
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const sourceText = '肝胆脾胰彩超 检查日期：2023-10-09 彩色多普 勒 小结 肝、胆、脾、胰：未见明显异常声像';
    const citedText = '肝胆脾胰彩超 检查日期：2023-10-09 彩色多普勒 小结 肝、胆、脾、胰：未见明显异常声像';
    const source = store.putSourceObject({ bytes: Buffer.from(sourceText), mediaType: 'text/plain', displayName: '超声报告.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.saveSourceManifest({
      id: 'whitespace-citation-manifest', sourceObjectId: source.id, sha256: source.sha256, mediaType: 'text/plain',
      originalDisplayName: '超声报告.txt', totalUnits: 1, coveredUnitIndexes: [0],
      spans: [{ id: 'whitespace-citation-span', documentId: document.documentId, spanKind: 'line', page: 1, blockId: null, lineStart: 1, lineEnd: 1, quote: sourceText, readability: 'clear' }],
      normalizerVersion: 'manifest-test-v1', conversionWarnings: [], createdAt: '2026-09-18T00:00:00.000Z'
    });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: '7'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: ['whitespace-citation-span'],
      candidateOptions: [{
        localKey: 'hepatobiliary-summary', originalName: '肝胆脾胰彩超小结', standardNameCandidate: null,
        value: { kind: 'text', rawText: '肝、胆、脾、胰：未见明显异常声像' },
        unitRaw: null, referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: '彩色多普勒超声', bodySite: '肝、胆、脾、胰', clinicalDate: '2023-10-09',
        evidence: [{ sourceSpanId: 'whitespace-citation-span', quote: citedText }], issues: []
      }],
      candidateDiffs: [{ localKey: 'hepatobiliary-summary', itemName: '肝胆脾胰彩超小结', fields: ['issues'] }]
    });
    store.finishJob(job.id, 'waiting_user');
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`UPDATE workspaces SET schema_version = 18; PRAGMA user_version = 18;`);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:01:00Z') });
    expect(store.listOpenExtractionReviewIssues().some((issue) => issue.id === issueId)).toBe(false);
    expect(store.listReadyDocuments()).toEqual([{ id: document.documentId, personId: person.id }]);
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'queued', completedUnits: 0, totalUnits: 1 });
    expect(store.getFactRevision(person.id)).toBe(0);
    expect(store.listAcceptedObservations(person.id)).toEqual([]);
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(28);
    upgraded.close();
    store.close();
  });

  it('schema v20 只重试同一来源内前后片段可唯一定位的省略证据', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v19-abbreviated-citation-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:00:00Z') });
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const sourceText = '一般状况 身高、体重 检查日期：2023-10-08 检查医生：张医生 项目名称 检查结果 身高 187 厘米 体重 91 Kg';
    const citedText = '身高、体重 检查日期：2023-10-08…身高 187 厘米';
    const source = store.putSourceObject({ bytes: Buffer.from(sourceText), mediaType: 'text/plain', displayName: '身高体重报告.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.saveSourceManifest({
      id: 'abbreviated-citation-manifest', sourceObjectId: source.id, sha256: source.sha256, mediaType: 'text/plain',
      originalDisplayName: '身高体重报告.txt', totalUnits: 1, coveredUnitIndexes: [0],
      spans: [{ id: 'abbreviated-citation-span', documentId: document.documentId, spanKind: 'line', page: 1, blockId: null, lineStart: 1, lineEnd: 1, quote: sourceText, readability: 'clear' }],
      normalizerVersion: 'manifest-test-v1', conversionWarnings: [], createdAt: '2026-09-18T00:00:00.000Z'
    });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: '8'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: ['abbreviated-citation-span'],
      candidateOptions: [{
        localKey: 'height', originalName: '身高', standardNameCandidate: 'Body height',
        value: { kind: 'numeric', rawText: '187', decimal: '187', comparator: 'eq' },
        unitRaw: '厘米', referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: null, bodySite: null, clinicalDate: '2023-10-08',
        evidence: [{ sourceSpanId: 'abbreviated-citation-span', quote: citedText }], issues: []
      }],
      candidateDiffs: [{ localKey: 'height', itemName: '身高', fields: ['issues'] }]
    });
    store.finishJob(job.id, 'waiting_user');
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`UPDATE workspaces SET schema_version = 19; PRAGMA user_version = 19;`);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:01:00Z') });
    expect(store.listOpenExtractionReviewIssues().some((issue) => issue.id === issueId)).toBe(false);
    expect(store.listReadyDocuments()).toEqual([{ id: document.documentId, personId: person.id }]);
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'queued', completedUnits: 0, totalUnits: 1 });
    expect(store.getFactRevision(person.id)).toBe(0);
    expect(store.listAcceptedObservations(person.id)).toEqual([]);
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(28);
    upgraded.close();
    store.close();
  });

  it('schema v21 允许省略证据的结尾在后续科室重复，但当前科室内必须唯一', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v20-section-abbreviation-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:00:00Z') });
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const sourceText = '内科 内科 检查日期：2023-10-08 心脏未见异常 小结 未见异常 外科 外科 检查日期：2023-10-08 皮肤无异常 小结 未见异常';
    const citedText = '内科 内科 检查日期：2023-10-08……小结 未见异常';
    const source = store.putSourceObject({ bytes: Buffer.from(sourceText), mediaType: 'text/plain', displayName: '分科报告.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.saveSourceManifest({
      id: 'section-abbreviation-manifest', sourceObjectId: source.id, sha256: source.sha256, mediaType: 'text/plain',
      originalDisplayName: '分科报告.txt', totalUnits: 1, coveredUnitIndexes: [0],
      spans: [{ id: 'section-abbreviation-span', documentId: document.documentId, spanKind: 'line', page: 1, blockId: null, lineStart: 1, lineEnd: 1, quote: sourceText, readability: 'clear' }],
      normalizerVersion: 'manifest-test-v1', conversionWarnings: [], createdAt: '2026-09-18T00:00:00.000Z'
    });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: '9'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: ['section-abbreviation-span'],
      candidateOptions: [{
        localKey: 'internal-summary', originalName: '内科小结', standardNameCandidate: null,
        value: { kind: 'qualitative', rawText: '未见异常', category: 'no abnormality detected' },
        unitRaw: null, referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: null, bodySite: null, clinicalDate: '2023-10-08',
        evidence: [{ sourceSpanId: 'section-abbreviation-span', quote: citedText }], issues: []
      }],
      candidateDiffs: [{ localKey: 'internal-summary', itemName: '内科小结', fields: ['issues'] }]
    });
    store.finishJob(job.id, 'waiting_user');
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`UPDATE workspaces SET schema_version = 20; PRAGMA user_version = 20;`);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:01:00Z') });
    expect(store.listOpenExtractionReviewIssues().some((issue) => issue.id === issueId)).toBe(false);
    expect(store.listReadyDocuments()).toEqual([{ id: document.documentId, personId: person.id }]);
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'queued', completedUnits: 0, totalUnits: 1 });
    expect(store.getFactRevision(person.id)).toBe(0);
    expect(store.listAcceptedObservations(person.id)).toEqual([]);
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(28);
    upgraded.close();
    store.close();
  });

  it('schema v22 将单侧缺失的参考范围保守留空并重新排队', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v21-reference-range-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:00:00Z') });
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const sourceText = '检查日期：2023-10-08 血压 107/70 mmHg';
    const source = store.putSourceObject({ bytes: Buffer.from(sourceText), mediaType: 'text/plain', displayName: '血压报告.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.saveSourceManifest({
      id: 'reference-range-manifest', sourceObjectId: source.id, sha256: source.sha256, mediaType: 'text/plain',
      originalDisplayName: '血压报告.txt', totalUnits: 1, coveredUnitIndexes: [0],
      spans: [{ id: 'reference-range-span', documentId: document.documentId, spanKind: 'line', page: 1, blockId: null, lineStart: 1, lineEnd: 1, quote: sourceText, readability: 'clear' }],
      normalizerVersion: 'manifest-test-v1', conversionWarnings: [], createdAt: '2026-09-18T00:00:00.000Z'
    });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: 'a'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: ['reference-range-span'],
      candidateOptions: [{
        localKey: 'bp-systolic', originalName: '收缩压', standardNameCandidate: 'Systolic blood pressure',
        value: { kind: 'numeric', rawText: '107', decimal: '107', comparator: 'eq' },
        unitRaw: 'mmHg', referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: null, bodySite: null, clinicalDate: '2023-10-08',
        evidence: [{ sourceSpanId: 'reference-range-span', quote: sourceText }], issues: []
      }],
      candidateDiffs: [{ localKey: 'bp-systolic', itemName: '收缩压', fields: ['referenceRangeRaw'] }]
    });
    store.finishJob(job.id, 'waiting_user');
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`UPDATE workspaces SET schema_version = 21; PRAGMA user_version = 21;`);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:01:00Z') });
    expect(store.listOpenExtractionReviewIssues().some((issue) => issue.id === issueId)).toBe(false);
    expect(store.listReadyDocuments()).toEqual([{ id: document.documentId, personId: person.id }]);
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'queued', completedUnits: 0, totalUnits: 1 });
    expect(store.getFactRevision(person.id)).toBe(0);
    expect(store.listAcceptedObservations(person.id)).toEqual([]);
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(28);
    upgraded.close();
    store.close();
  });

  it('schema v23 重新运行可能由否定式医学边界误判而暂停的派生分析', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v22-derived-boundary-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:00:00Z') });
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const source = store.putSourceObject({ bytes: Buffer.from('虚构报告事实'), mediaType: 'text/plain', displayName: '虚构报告.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: 'b'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'derived_safety',
      severity: 'blocking',
      evidenceRefs: [],
      preserveDocumentStatus: true
    });
    store.finishJob(job.id, 'waiting_user');
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`
      UPDATE documents SET status = 'completed' WHERE id = '${document.documentId}';
      UPDATE jobs SET stage = 'analyze' WHERE id = '${job.id}';
      UPDATE workspaces SET schema_version = 22;
      PRAGMA user_version = 22;
    `);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:01:00Z') });
    expect(store.listOpenExtractionReviewIssues().some((issue) => issue.id === issueId)).toBe(false);
    expect(store.listStoredJobs()[0]).toMatchObject({ stage: 'analyze', status: 'queued' });
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(28);
    upgraded.close();
    store.close();
  });

  it('schema v24 恢复没有明确姓名冲突的用户归属资料与同批任务', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v23-identity-review-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-19T13:18:00Z') });
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const source = store.putSourceObject({ bytes: Buffer.from('姓名区域模糊的虚构图片'), mediaType: 'image/png', displayName: '虚构图片.png' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id, assignmentBasis: 'user_selected' });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-19T13:18:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: 'c'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: []
    });
    store.finishJob(job.id, 'waiting_user');
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`UPDATE workspaces SET schema_version = 23; PRAGMA user_version = 23;`);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-19T13:20:00Z') });
    expect(store.listOpenExtractionReviewIssues().some((issue) => issue.id === issueId)).toBe(false);
    expect(store.listReadyDocuments()).toEqual([{ id: document.documentId, personId: person.id }]);
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'queued', completedUnits: 0, totalUnits: 1 });
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(28);
    upgraded.close();
    store.close();
  });

  it('schema v25 自动重试只有内部证据引用或边界备注错误的派生说明', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v24-derived-structure-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-19T14:38:00Z') });
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const source = store.putSourceObject({ bytes: Buffer.from('虚构报告事实'), mediaType: 'text/plain', displayName: '虚构报告.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-19T14:38:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: 'd'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'derived_safety',
      severity: 'blocking',
      evidenceRefs: [],
      preserveDocumentStatus: true,
      reasonCodes: ['boundary_note_required:c4', 'evidence_mismatch:c9']
    });
    store.finishJob(job.id, 'waiting_user');
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`
      UPDATE documents SET status = 'completed' WHERE id = '${document.documentId}';
      UPDATE jobs SET stage = 'analyze' WHERE id = '${job.id}';
      UPDATE workspaces SET schema_version = 24;
      PRAGMA user_version = 24;
    `);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-19T14:39:00Z') });
    expect(store.listOpenExtractionReviewIssues().some((issue) => issue.id === issueId)).toBe(false);
    expect(store.listStoredJobs()[0]).toMatchObject({ stage: 'analyze', status: 'queued' });
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(28);
    upgraded.close();
    store.close();
  });

  it('schema v26 自动重试只有单条说明被独立复核拒绝的派生任务', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v25-derived-item-review-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-19T14:49:00Z') });
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const source = store.putSourceObject({ bytes: Buffer.from('虚构报告事实'), mediaType: 'text/plain', displayName: '虚构报告.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-19T14:49:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: 'e'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'derived_safety',
      severity: 'blocking',
      evidenceRefs: [],
      preserveDocumentStatus: true,
      reasonCodes: ['guidance_rejected:hydration-routine']
    });
    store.finishJob(job.id, 'waiting_user');
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`
      UPDATE documents SET status = 'completed' WHERE id = '${document.documentId}';
      UPDATE jobs SET stage = 'review_derived' WHERE id = '${job.id}';
      UPDATE workspaces SET schema_version = 25;
      PRAGMA user_version = 25;
    `);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-19T14:50:00Z') });
    expect(store.listOpenExtractionReviewIssues().some((issue) => issue.id === issueId)).toBe(false);
    expect(store.listStoredJobs()[0]).toMatchObject({ stage: 'analyze', status: 'queued' });
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(28);
    upgraded.close();
    store.close();
  });

  it('schema v27 关闭缺少双轮原文与覆盖补救能力的旧事项，并按原批次整体重跑', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v26-review-recovery-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-19T15:00:00Z') });
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const firstSource = store.putSourceObject({ bytes: Buffer.from('虚构甲状腺资料'), mediaType: 'text/plain', displayName: '甲状腺.txt' });
    const secondSource = store.putSourceObject({ bytes: Buffer.from('虚构多页资料'), mediaType: 'text/plain', displayName: '多页.txt' });
    const firstDocument = store.registerImportedDocument({ sourceObjectId: firstSource.id, personId: person.id });
    const secondDocument = store.registerImportedDocument({ sourceObjectId: secondSource.id, personId: person.id });
    const documentIds = [firstDocument.documentId, secondDocument.documentId];
    const consentId = store.createManualProcessingConsent({
      documentIds, personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-19T15:00:00Z',
      groups: [{ personId: person.id, documentIds, inputSignature: 'f'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const candidate = {
      localKey: 'thyroid-site', originalName: '甲状腺彩超', standardNameCandidate: null,
      value: { kind: 'text' as const, rawText: '未见异常' }, unitRaw: null, referenceRangeRaw: null,
      reportedAbnormalFlag: null, specimen: null, method: '超声', bodySite: '甲状腺实质', clinicalDate: null,
      evidence: [{ sourceSpanId: 'span-1', quote: '甲状腺实质' }], issues: []
    };
    store.saveExtractionReviewIssue({
      documentId: firstDocument.documentId, kind: 'field_conflict', severity: 'blocking', evidenceRefs: ['span-1'],
      candidateOptions: [candidate],
      candidateDiffs: [{ localKey: candidate.localKey, itemName: candidate.originalName, fields: ['bodySite'] }],
      reasonCodes: ['INDEPENDENT_REVIEW_MISMATCH']
    });
    store.saveExtractionReviewIssue({
      documentId: secondDocument.documentId, kind: 'coverage_gap', severity: 'blocking', evidenceRefs: ['span-2'],
      reasonCodes: ['EXTRACTION_COVERAGE_INCOMPLETE']
    });
    store.finishJob(job.id, 'waiting_user');
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`UPDATE workspaces SET schema_version = 26; PRAGMA user_version = 26;`);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-19T15:01:00Z') });
    expect(store.listOpenExtractionReviewIssues()).toEqual([]);
    expect(store.listReadyDocuments()).toEqual(expect.arrayContaining([
      { id: firstDocument.documentId, personId: person.id },
      { id: secondDocument.documentId, personId: person.id }
    ]));
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'queued', stage: 'extract', completedUnits: 0, totalUnits: 2 });
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(28);
    const checkpoint = JSON.parse((upgraded.prepare('SELECT checkpoint_json FROM jobs WHERE id = ?').get(job.id) as { checkpoint_json: string }).checkpoint_json) as { documentIds: string[] };
    expect(checkpoint.documentIds).toEqual(documentIds);
    upgraded.close();
    store.close();
  });

  it('schema v28 不允许缺少整篇覆盖证明的旧修正事项直接提交', { timeout: 15_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v27-complete-review-'));
    directories.push(directory);
    let store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-20T00:00:00Z') });
    const person = store.createPerson({ displayName: '测试成员' });
    const source = store.putSourceObject({ bytes: Buffer.from('虚构长报告'), mediaType: 'text/plain', displayName: 'long.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-20T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: 'legacy-complete-review' }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const candidate = {
      localKey: 'legacy-value', originalName: '虚构指标', standardNameCandidate: null,
      value: { kind: 'numeric' as const, rawText: '1', decimal: '1', comparator: 'eq' as const },
      unitRaw: null, referenceRangeRaw: null, reportedAbnormalFlag: null,
      specimen: null, method: null, bodySite: null, clinicalDate: null,
      evidence: [{ sourceSpanId: 'span-1', quote: '虚构指标 1' }], issues: []
    };
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      jobId: job.id,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: ['span-1'],
      candidateOptions: [candidate],
      candidateDiffs: [{
        localKey: candidate.localKey,
        itemName: candidate.originalName,
        fields: ['value'],
        firstCandidate: candidate,
        secondCandidate: { ...candidate, value: { kind: 'numeric', rawText: '2', decimal: '2', comparator: 'eq' } }
      }],
      reasonCodes: ['INDEPENDENT_REVIEW_MISMATCH']
    });
    store.finishJob(job.id, 'waiting_user');
    store.close();

    const legacy = new Database(join(directory, 'health.db'));
    legacy.exec(`UPDATE workspaces SET schema_version = 27; PRAGMA user_version = 27;`);
    legacy.close();

    store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-20T00:01:00Z') });
    expect(store.listOpenExtractionReviewIssues().some((issue) => issue.id === issueId)).toBe(false);
    expect(store.listReadyDocuments()).toContainEqual({ id: document.documentId, personId: person.id });
    expect(store.listStoredJobs()[0]).toMatchObject({ id: job.id, status: 'queued', stage: 'extract', completedUnits: 0 });
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(28);
    upgraded.close();
    store.close();
  });

  it('显示信息与临床上下文使用独立 revision', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '同名成员', relation: '本人' });
    expect(store.updatePersonDisplay({
      personId: person.id,
      displayName: '新昵称',
      relation: '家人',
      birthYear: 1990,
      expectedDisplayRevision: 1
    })).toMatchObject({ displayName: '新昵称', relation: '家人', birthYear: 1990, displayRevision: 2, clinicalContextRevision: 1 });
    expect(() => store.updatePersonDisplay({
      personId: person.id,
      displayName: '迟到昵称',
      relation: '家人',
      birthYear: 1990,
      expectedDisplayRevision: 1
    })).toThrow(RevisionConflictError);
    expect(store.updateClinicalContext(person.id, { allergies: ['虚构过敏史'] }, 1)).toBe(2);
    expect(store.listPersons()[0]).toMatchObject({ displayRevision: 2, clinicalContextRevision: 2 });
    store.close();
  });

  it('成员归档可恢复，并撤回目录授权而不删除历史资料', () => {
    const store = makeStore();
    const inbox = mkdtempSync(join(tmpdir(), 'family-health-archive-inbox-'));
    directories.push(inbox);
    const person = store.createPerson({ displayName: '待归档成员', relation: '家人' });
    const source = store.putSourceObject({ bytes: Buffer.from('纯虚构历史报告'), mediaType: 'text/plain', displayName: '历史报告.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.createInboxBinding({
      canonicalPath: inbox,
      personId: person.id,
      recursive: true,
      allowScheduledAiProcessing: true,
      accountFingerprint: 'f'.repeat(64),
      consentVersion: 1
    });

    const archived = store.archivePerson({ personId: person.id, expectedDisplayRevision: 1 });
    expect(archived).toMatchObject({ archivedAt: '2026-09-18T00:00:00.000Z', displayRevision: 2 });
    expect(store.listActiveInboxBindings()).toEqual([]);
    expect(store.listReadyDocuments()).toEqual([]);
    expect(store.listImportedDocuments()).toEqual([expect.objectContaining({ id: document.documentId, status: 'ignored' })]);

    const restored = store.restorePerson({ personId: person.id, expectedDisplayRevision: 2 });
    expect(restored).toMatchObject({ archivedAt: null, displayRevision: 3, clinicalContextRevision: 0 });
    expect(store.listActiveInboxBindings()).toEqual([]);
    expect(readFileSync(join(store.vaultDirectory, source.vaultRelativePath)).toString('utf8')).toBe('纯虚构历史报告');
    store.close();
  });

  it('恢复到新设备时清除旧路径并暂停目录授权和自动任务', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '恢复测试成员', relation: '本人' });
    const source = store.putSourceObject({ bytes: Buffer.from('纯虚构恢复资料'), mediaType: 'text/plain', displayName: '恢复资料.txt' });
    const binding = store.createInboxBinding({
      canonicalPath: '/Users/example/Health Inbox',
      personId: person.id,
      recursive: true,
      allowScheduledAiProcessing: true,
      accountFingerprint: 'a'.repeat(64),
      consentVersion: 1
    });
    store.registerSourceOccurrence({
      sourceObjectId: source.id,
      bindingId: binding.id,
      originalPath: '/Users/example/Health Inbox/恢复资料.txt',
      displayName: '恢复资料.txt'
    });
    store.updateSchedule({
      enabled: true,
      localTime: '20:00',
      timeZone: 'Asia/Shanghai',
      nextRunUtc: '2026-09-18T12:00:00Z',
      expectedRevision: 0
    });

    expect(store.sanitizeRestoredMachineState()).toMatchObject({
      disabledBindingCount: 1,
      revokedConsentCount: 1,
      pausedScheduleCount: 1
    });
    expect(store.listActiveInboxBindings()).toEqual([]);
    expect(store.getOrCreateSchedule('Asia/Shanghai', null)).toMatchObject({ enabled: false, nextRunUtc: null });
    const databasePath = store.databasePath;
    store.close();

    const database = new Database(databasePath, { readonly: true });
    expect(database.prepare('SELECT canonical_path, enabled FROM inbox_bindings').get()).toEqual({
      canonical_path: `restored://inbox/${binding.id}`,
      enabled: 0
    });
    expect(database.prepare('SELECT original_path FROM source_occurrences').get()).toEqual({
      original_path: expect.stringMatching(/^restored:\/\/source\//)
    });
    expect(database.prepare('SELECT revoked_at, account_fingerprint FROM consents').get()).toMatchObject({
      revoked_at: '2026-09-18T00:00:00.000Z',
      account_fingerprint: null
    });
    database.close();
  });

  it('资料移出分析后保留抑制记录，并可重新纳入待处理队列', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const source = store.putSourceObject({ bytes: Buffer.from('纯虚构待移出报告'), mediaType: 'text/plain', displayName: '待移出.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    expect(store.listReadyDocuments()).toEqual([{ id: document.documentId, personId: person.id }]);

    expect(store.setDocumentIncluded({ documentId: document.documentId, included: false })).toEqual({ included: false, personId: person.id });
    expect(store.listImportedDocuments()).toEqual([expect.objectContaining({ id: document.documentId, status: 'ignored' })]);
    expect(store.listReadyDocuments()).toEqual([]);
    expect(store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id })).toMatchObject({ duplicate: true });

    expect(store.setDocumentIncluded({ documentId: document.documentId, included: true })).toEqual({ included: true, personId: person.id });
    expect(store.listImportedDocuments()).toEqual([expect.objectContaining({ id: document.documentId, status: 'queued' })]);
    expect(store.listReadyDocuments()).toEqual([{ id: document.documentId, personId: person.id }]);
    expect(store.getFactRevision(person.id)).toBe(2);
    store.close();
  });

  it('删除报告会清除当前事实链、删除未共享原件并留下可解除的导入抑制记录', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const bytes = Buffer.from('纯虚构待删除报告\nLDL 3.8 mmol/L');
    const source = store.putSourceObject({ bytes, mediaType: 'text/plain', displayName: '待删除.txt' });
    store.registerSourceOccurrence({ sourceObjectId: source.id, originalPath: '/tmp/待删除.txt', displayName: '待删除.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const spanId = 'span-delete-fixture';
    store.saveSourceManifest({
      id: 'manifest-delete-fixture', sourceObjectId: source.id, sha256: source.sha256,
      mediaType: 'text/plain', originalDisplayName: '待删除.txt', totalUnits: 1,
      coveredUnitIndexes: [0], normalizerVersion: 'test', conversionWarnings: [],
      createdAt: '2026-09-18T00:00:00.000Z',
      spans: [{ id: spanId, documentId: document.documentId, spanKind: 'line', page: null, blockId: null, lineStart: 1, lineEnd: 1, quote: 'LDL 3.8 mmol/L', readability: 'clear' }]
    });
    const acceptanceId = store.saveAcceptanceDecision({
      method: 'auto', actor: 'policy', rulesVersion: 'test', inputSignature: 'input',
      outputHash: 'output', reviewRef: null, decision: 'accept'
    });
    store.publishFacts({
      personId: person.id, documentId: document.documentId, documentCommitKey: 'd'.repeat(64), expectedRevision: 0, changeSetHash: 'e'.repeat(64), summary: '虚构报告事实',
      observations: [{ conceptKey: 'LDL-C', rawText: '3.8', valueKind: 'numeric', decimalValue: '3.8', qualifier: 'eq', unit: 'mmol/L', referenceRange: '0-3.4', clinicalDate: '2026-09-18', abnormalFlag: 'high', documentId: document.documentId, sourceSpanId: spanId, acceptanceId, specimen: null, method: null, bodySite: null, evidence: [{ sourceSpanId: spanId, quote: 'LDL 3.8 mmol/L' }] }]
    });
    expect(store.listAcceptedObservations()).toHaveLength(1);
    const sourcePath = join(store.vaultDirectory, source.vaultRelativePath);
    expect(existsSync(sourcePath)).toBe(true);

    expect(store.deleteDocument({ documentId: document.documentId, retainedByRecoveryPoint: false })).toMatchObject({
      currentWorkspaceRemoved: true, rawObjectDeleted: true, retainedByRecoveryPoint: false
    });
    expect(store.listImportedDocuments()).toEqual([]);
    expect(store.listAcceptedObservations()).toEqual([]);
    expect(existsSync(sourcePath)).toBe(false);
    expect(store.isSourceImportSuppressed(source.sha256)).toBe(true);
    expect(store.listDeletedDocuments()).toEqual([expect.objectContaining({ displayName: '待删除.txt', personId: person.id, rawObjectRetained: false })]);
    store.releaseDeletedDocument(source.sha256);
    expect(store.isSourceImportSuppressed(source.sha256)).toBe(false);
    expect(store.integrityCheck()).toBe('ok');
    store.close();
  });

  it('本人事项持久保存，并用 revision 阻止迟到状态覆盖', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const action = store.createUserAction({
      personId: person.id,
      title: '下次复诊时询问指标变化',
      detail: '带上原始报告，不把本人记录冒充医生意见。',
      dueDate: null,
      dueText: '下次复诊时'
    });
    expect(action).toMatchObject({
      personId: person.id,
      origin: 'user_created',
      status: 'planned',
      evidenceLabel: '用户记录',
      userRevision: 1
    });
    const completed = store.updateActionStatus({ actionId: action.id, status: 'completed', expectedRevision: 1 });
    expect(completed).toMatchObject({ status: 'completed', userRevision: 2 });
    expect(() => store.updateActionStatus({ actionId: action.id, status: 'dismissed', expectedRevision: 1 }))
      .toThrow(RevisionConflictError);
    expect(store.listActionItems(person.id)).toEqual([completed]);
    store.close();
  });

  it('本人补充资料保留 user_reported 来源，并只推进该成员临床上下文 revision', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员', relation: '本人' });
    const other = store.createPerson({ displayName: '其他成员', relation: '家人' });
    const note = store.createManualNote({
      personId: person.id,
      kind: 'self_measurement',
      immutableText: '晨起血压：128/82 mmHg；静坐五分钟后测量',
      effectiveDate: '2026-09-18',
      structuredFields: { measurementName: '晨起血压', value: '128/82', unit: 'mmHg' },
      expectedContextRevision: 0
    });
    expect(note).toMatchObject({
      personId: person.id,
      kind: 'self_measurement',
      sourceKind: 'user_reported',
      revision: 1,
      structuredFields: { measurementName: '晨起血压', value: '128/82', unit: 'mmHg' }
    });
    expect(store.listPersons().find((item) => item.id === person.id)?.clinicalContextRevision).toBe(1);
    expect(store.listPersons().find((item) => item.id === other.id)?.clinicalContextRevision).toBe(0);
    expect(() => store.createManualNote({
      personId: person.id,
      kind: 'free_text',
      immutableText: '迟到的旧界面提交',
      effectiveDate: null,
      structuredFields: {},
      expectedContextRevision: 0
    })).toThrow(RevisionConflictError);
    store.close();
  });

  it('CAS 拒绝迟到发布，幂等键阻止重复提交', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员' });
    const source = store.putSourceObject({ bytes: Buffer.from('幂等测试'), mediaType: 'text/plain', displayName: '幂等.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const source2 = store.putSourceObject({ bytes: Buffer.from('并发测试'), mediaType: 'text/plain', displayName: '并发.txt' });
    const document2 = store.registerImportedDocument({ sourceObjectId: source2.id, personId: person.id });
    const input = {
      personId: person.id,
      documentId: document.documentId,
      documentCommitKey: 'c'.repeat(64),
      expectedRevision: 0,
      changeSetHash: 'a'.repeat(64),
      summary: '虚构资料更新',
      observations: []
    };
    const first = store.publishFacts(input);
    const second = store.publishFacts(input);
    expect(first).toMatchObject({ revision: 1, idempotent: false });
    expect(second).toMatchObject({ revision: 1, idempotent: true });
    expect(() => store.publishFacts({ ...input, documentId: document2.documentId, documentCommitKey: 'f'.repeat(64), changeSetHash: 'b'.repeat(64), expectedRevision: 0 }))
      .toThrow(RevisionConflictError);
    expect(store.integrityCheck()).toBe('ok');
    store.close();
  });

  it('目录授权只向界面暴露名称，停用时同步撤回 AI 授权', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员' });
    const inbox = mkdtempSync(join(tmpdir(), 'family-health-inbox-'));
    directories.push(inbox);
    const binding = store.createInboxBinding({
      canonicalPath: inbox,
      personId: person.id,
      recursive: true,
      allowScheduledAiProcessing: true,
      accountFingerprint: 'account-fingerprint',
      consentVersion: 1
    });
    expect(binding).toMatchObject({
      displayName: expect.stringContaining('family-health-inbox-'),
      personId: person.id,
      recursive: true,
      aiProcessingAuthorized: true,
      enabled: true
    });
    expect(JSON.stringify(binding)).not.toContain(inbox);
    expect(store.listActiveInboxBindings()[0]).toMatchObject({ canonicalPath: inbox, consentId: expect.any(String) });
    store.disableInboxBinding(binding.id);
    expect(store.listInboxBindings()[0]).toMatchObject({ enabled: false, aiProcessingAuthorized: false });
    expect(store.listActiveInboxBindings()).toEqual([]);
    store.close();
  });

  it('退出 Codex 会撤回 AI 授权并暂停待发送任务，但保留本机目录发现和档案', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员' });
    const inbox = mkdtempSync(join(tmpdir(), 'family-health-logout-inbox-'));
    directories.push(inbox);
    const binding = store.createInboxBinding({
      canonicalPath: inbox, personId: person.id, recursive: true,
      allowScheduledAiProcessing: true, accountFingerprint: 'account-fingerprint', consentVersion: 1
    });
    const source = store.putSourceObject({ bytes: Buffer.from('虚构退出资料'), mediaType: 'text/plain', displayName: 'logout.txt' });
    store.registerSourceOccurrence({ sourceObjectId: source.id, bindingId: binding.id, originalPath: join(inbox, 'logout.txt'), displayName: 'logout.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: '9'.repeat(64) }],
      initialStatus: 'queued', consentId
    });

    expect(store.revokeAllAiAuthorizations()).toMatchObject({ revokedConsentCount: 2, waitingJobCount: 1 });
    expect(store.listInboxBindings()[0]).toMatchObject({ enabled: true, aiProcessingAuthorized: false });
    expect(store.listActiveInboxBindings()).toHaveLength(1);
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'waiting_auth' });
    expect(store.listImportedDocuments()).toHaveLength(1);
    store.close();
  });

  it('只有带有效一次性授权的任务才能领取并完成', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员' });
    const source = store.putSourceObject({ bytes: Buffer.from('虚构资料'), mediaType: 'text/plain', displayName: 'fixture.txt' });
    store.registerSourceOccurrence({ sourceObjectId: source.id, originalPath: '/tmp/fixture.txt', displayName: 'fixture.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId],
      personIds: [person.id],
      accountFingerprint: 'account-fingerprint',
      version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: 'a'.repeat(64) }],
      initialStatus: 'queued',
      consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint');
    expect(job).toMatchObject({ personId: person.id, documentIds: [document.documentId], consentId, attemptCount: 1 });
    store.updateJobProgress(job!.id, 1);
    store.finishJob(job!.id, 'succeeded');
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'succeeded', completedUnits: 1, totalUnits: 1 });
    store.close();
  });

  it('会撤回未关联任务的手动处理授权', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员' });
    const source = store.putSourceObject({ bytes: Buffer.from('虚构资料'), mediaType: 'text/plain', displayName: 'fixture.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    expect(store.revokeUnreferencedManualProcessingConsents()).toBe(1);
    expect(store.revokeUnreferencedManualProcessingConsents()).toBe(0);
    store.close();
  });

  it('授权撤回后，运行中尝试的最终事务也不得提交', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员' });
    const source = store.putSourceObject({ bytes: Buffer.from('授权撤回测试'), mediaType: 'text/plain', displayName: '撤回.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const accountFingerprint = 'account-fixture';
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint, version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00.000Z', initialStatus: 'queued', consentId,
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: 'guard-test' }]
    });
    const job = store.claimNextQueuedJob('lease-owner', accountFingerprint)!;
    const attemptId = store.startJobAttempt(job.id, 'fixture-runtime');
    const executionGuard = { jobId: job.id, attemptId, consentId, accountFingerprint };
    expect(() => store.assertJobExecutionActive(executionGuard, document.documentId)).not.toThrow();
    store.revokeAllAiAuthorizations();
    expect(() => store.publishFacts({
      personId: person.id, documentId: document.documentId, documentCommitKey: '9'.repeat(64),
      expectedRevision: 0, changeSetHash: '8'.repeat(64), summary: '不应提交', observations: [], executionGuard
    })).toThrow('CONSENT_REVOKED');
    expect(store.getFactRevision(person.id)).toBe(0);
    expect(store.isDocumentCommitted(document.documentId)).toBe(false);
    store.close();
  });

  it('用户放弃派生说明后，等待核对的任务以已保存事实收口', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员' });
    const source = store.putSourceObject({ bytes: Buffer.from('虚构资料'), mediaType: 'text/plain', displayName: 'fixture.txt' });
    store.registerSourceOccurrence({ sourceObjectId: source.id, originalPath: '/tmp/fixture-derived.txt', displayName: 'fixture.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: 'c'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    store.setDocumentStatus(document.documentId, 'completed');
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId, kind: 'derived_safety', severity: 'blocking', evidenceRefs: [], preserveDocumentStatus: true
    });
    store.finishJob(job.id, 'waiting_user');
    store.resolveReviewIssue({ issueId, documentId: document.documentId, action: 'dismiss_derived' });
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'succeeded', completedUnits: 1, totalUnits: 1 });
    store.close();
  });

  it('整篇事实修正在同一事务中关闭事项并恢复原任务', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员' });
    const source = store.putSourceObject({ bytes: Buffer.from('虚构报告'), mediaType: 'text/plain', displayName: 'fixture.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: 'complete-correction' }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      jobId: job.id,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: ['span-1'],
      documentRun: {
        coverageComplete: true,
        coveredSourceSpanIds: ['span-1'],
        manifestSpanIds: ['span-1'],
        chunkCount: 1
      }
    });
    store.finishJob(job.id, 'waiting_user');

    store.publishFacts({
      personId: person.id,
      documentId: document.documentId,
      documentCommitKey: '1'.repeat(64),
      expectedRevision: 0,
      changeSetHash: '2'.repeat(64),
      summary: '用户核对整篇后提交',
      observations: [],
      resolvedReviewIssueId: issueId
    });

    expect(store.listOpenExtractionReviewIssues()).toEqual([]);
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'queued', stage: 'extract', completedUnits: 0 });
    store.close();
  });

  it('授权撤回后，即使解决阻断核对也不会恢复原任务', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员' });
    const source = store.putSourceObject({ bytes: Buffer.from('撤回授权后的核对'), mediaType: 'text/plain', displayName: 'fixture.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: 'revoked-review-resume' }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      jobId: job.id,
      kind: 'derived_safety',
      severity: 'blocking',
      evidenceRefs: [],
      preserveDocumentStatus: true
    });
    store.finishJob(job.id, 'waiting_user');
    store.revokeAllAiAuthorizations();

    store.resolveReviewIssue({ issueId, documentId: document.documentId, action: 'dismiss_derived' });

    expect(store.listOpenExtractionReviewIssues()).toEqual([]);
    expect(store.listStoredJobs()[0]).toMatchObject({ id: job.id, status: 'waiting_user' });
    store.close();
  });

  it('已提交资料不能把后到的核对修正伪装成幂等成功', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员' });
    const source = store.putSourceObject({ bytes: Buffer.from('已提交资料'), mediaType: 'text/plain', displayName: 'fixture.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    store.publishFacts({
      personId: person.id,
      documentId: document.documentId,
      documentCommitKey: '3'.repeat(64),
      expectedRevision: 0,
      changeSetHash: '4'.repeat(64),
      summary: '首次提交',
      observations: []
    });
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: ['span-1'],
      preserveDocumentStatus: true,
      documentRun: {
        coverageComplete: true,
        coveredSourceSpanIds: ['span-1'],
        manifestSpanIds: ['span-1'],
        chunkCount: 1
      }
    });

    expect(() => store.publishFacts({
      personId: person.id,
      documentId: document.documentId,
      documentCommitKey: '3'.repeat(64),
      expectedRevision: 1,
      changeSetHash: '5'.repeat(64),
      summary: '不应伪装成功',
      observations: [],
      resolvedReviewIssueId: issueId
    })).toThrow('DOCUMENT_ALREADY_COMMITTED_REVIEW_CONFLICT');
    expect(store.listOpenExtractionReviewIssues()).toHaveLength(1);
    store.close();
  });

  it('派生核对通过 jobId 恢复新批次，不受旧证据报告归属影响', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员' });
    const oldSource = store.putSourceObject({ bytes: Buffer.from('旧报告'), mediaType: 'text/plain', displayName: 'old.txt' });
    const newSource = store.putSourceObject({ bytes: Buffer.from('新报告'), mediaType: 'text/plain', displayName: 'new.txt' });
    const oldDocument = store.registerImportedDocument({ sourceObjectId: oldSource.id, personId: person.id });
    const newDocument = store.registerImportedDocument({ sourceObjectId: newSource.id, personId: person.id });
    const consentId = store.createManualProcessingConsent({
      documentIds: [newDocument.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [newDocument.documentId], inputSignature: 'derived-old-evidence-new-job' }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: oldDocument.documentId,
      jobId: job.id,
      kind: 'derived_safety',
      severity: 'blocking',
      evidenceRefs: [],
      preserveDocumentStatus: true
    });
    store.finishJob(job.id, 'waiting_user');

    store.resolveReviewIssue({ issueId, documentId: oldDocument.documentId, action: 'dismiss_derived' });
    expect(store.listStoredJobs()[0]).toMatchObject({ id: job.id, status: 'succeeded', completedUnits: 1 });
    store.close();
  });

  it('旧版事实核对可以安全回到队列且不会提前写入事实', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员' });
    const source = store.putSourceObject({ bytes: Buffer.from('虚构报告 4.2 mmol/L'), mediaType: 'text/plain', displayName: '旧版核对.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: 'd'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const issueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: [],
      candidateOptions: [{
        localKey: 'ldl-legacy', originalName: '低密度脂蛋白胆固醇', standardNameCandidate: 'LDL-C',
        value: { kind: 'numeric', rawText: '4.2', decimal: '4.2', comparator: 'eq' },
        unitRaw: 'mmol/L', referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: null, bodySite: null, clinicalDate: null,
        evidence: [{ sourceSpanId: 'legacy-span', quote: '4.2 mmol/L' }], issues: []
      }]
    });
    store.finishJob(job.id, 'waiting_user');

    store.retryExtractionReview({ issueId, documentId: document.documentId });

    expect(store.listOpenExtractionReviewIssues()).toEqual([]);
    expect(store.listReadyDocuments()).toEqual([{ id: document.documentId, personId: person.id }]);
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'queued', completedUnits: 0, totalUnits: 1 });
    expect(store.getFactRevision(person.id)).toBe(0);
    expect(store.listAcceptedObservations(person.id)).toEqual([]);

    const currentIssueId = store.saveExtractionReviewIssue({
      documentId: document.documentId,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: [],
      candidateOptions: [{
        localKey: 'current-conflict', originalName: '低密度脂蛋白胆固醇', standardNameCandidate: 'LDL-C',
        value: { kind: 'numeric', rawText: '4.3', decimal: '4.3', comparator: 'eq' },
        unitRaw: 'mmol/L', referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: null, bodySite: null, clinicalDate: null,
        evidence: [{ sourceSpanId: 'current-span', quote: '4.3 mmol/L' }], issues: []
      }],
      candidateDiffs: [{ localKey: 'current-conflict', itemName: '低密度脂蛋白胆固醇', fields: ['value'] }]
    });
    expect(() => store.retryExtractionReview({ issueId: currentIssueId, documentId: document.documentId })).toThrow('REVIEW_ACTION_INVALID');
    store.close();
  });

  it('同一批有多条阻断事项时，最后一条解决后才按原批次恢复', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员' });
    const firstSource = store.putSourceObject({ bytes: Buffer.from('虚构资料甲'), mediaType: 'text/plain', displayName: '甲.txt' });
    const secondSource = store.putSourceObject({ bytes: Buffer.from('虚构资料乙'), mediaType: 'text/plain', displayName: '乙.txt' });
    const firstDocument = store.registerImportedDocument({ sourceObjectId: firstSource.id, personId: person.id });
    const secondDocument = store.registerImportedDocument({ sourceObjectId: secondSource.id, personId: person.id });
    const documentIds = [firstDocument.documentId, secondDocument.documentId];
    const consentId = store.createManualProcessingConsent({
      documentIds, personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds, inputSignature: '9'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('test-runner', 'account-fingerprint')!;
    const candidateFor = (localKey: string) => ({
      localKey, originalName: '虚构项目', standardNameCandidate: null,
      value: { kind: 'text' as const, rawText: '虚构结果' }, unitRaw: null, referenceRangeRaw: null,
      reportedAbnormalFlag: null, specimen: null, method: null, bodySite: null, clinicalDate: null,
      evidence: [{ sourceSpanId: `${localKey}-span`, quote: '虚构结果' }], issues: []
    });
    const firstIssue = store.saveExtractionReviewIssue({
      documentId: firstDocument.documentId, kind: 'field_conflict', severity: 'blocking', evidenceRefs: [], candidateOptions: [candidateFor('first')]
    });
    const secondIssue = store.saveExtractionReviewIssue({
      documentId: secondDocument.documentId, kind: 'field_conflict', severity: 'blocking', evidenceRefs: [], candidateOptions: [candidateFor('second')]
    });
    store.finishJob(job.id, 'waiting_user');

    store.retryExtractionReview({ issueId: firstIssue, documentId: firstDocument.documentId });
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'waiting_user', totalUnits: 2 });
    store.retryExtractionReview({ issueId: secondIssue, documentId: secondDocument.documentId });
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'queued', stage: 'extract', completedUnits: 0, totalUnits: 2 });
    store.close();
  });

  it('日程设置使用 revision，且同一时区日程槽只创建一次授权批次', () => {
    const store = makeStore();
    const initial = store.getOrCreateSchedule('Asia/Shanghai', '2026-09-18T12:00:00.000Z');
    expect(initial).toMatchObject({ enabled: false, localTime: '20:00', timeZone: 'Asia/Shanghai', revision: 0 });
    const schedule = store.updateSchedule({
      enabled: true,
      localTime: '20:30',
      timeZone: 'Asia/Shanghai',
      nextRunUtc: '2026-09-18T12:30:00.000Z',
      expectedRevision: 0
    });
    expect(schedule).toMatchObject({ enabled: true, localTime: '20:30', revision: 1 });
    expect(() => store.updateSchedule({
      enabled: false,
      localTime: '21:00',
      timeZone: 'Asia/Shanghai',
      nextRunUtc: '2026-09-18T13:00:00.000Z',
      expectedRevision: 0
    })).toThrow(RevisionConflictError);

    const person = store.createPerson({ displayName: '测试成员' });
    const inbox = mkdtempSync(join(tmpdir(), 'family-health-scheduled-inbox-'));
    directories.push(inbox);
    const binding = store.createInboxBinding({
      canonicalPath: inbox,
      personId: person.id,
      recursive: true,
      allowScheduledAiProcessing: true,
      accountFingerprint: 'account-fingerprint',
      consentVersion: 1
    });
    const activeBinding = store.listActiveInboxBindings().find((item) => item.id === binding.id)!;
    const source = store.putSourceObject({ bytes: Buffer.from('虚构日程资料'), mediaType: 'text/plain', displayName: 'scheduled.txt' });
    store.registerSourceOccurrence({
      sourceObjectId: source.id,
      bindingId: binding.id,
      originalPath: join(inbox, 'scheduled.txt'),
      displayName: 'scheduled.txt'
    });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const groups = store.listScheduledReadyGroups('account-fingerprint', '2026-09-18T00:00:01Z');
    expect(groups).toEqual([{
      personId: person.id,
      consentId: activeBinding.consentId,
      accountFingerprint: 'account-fingerprint',
      documentIds: [document.documentId]
    }]);
    const batch = store.createScheduledBatch({
      slotKey: 'daily:2026-09-18:r1',
      cutoff: '2026-09-18T00:00:01Z',
      groups: groups.map((group) => ({ ...group, inputSignature: 'd'.repeat(64), initialStatus: 'queued' as const }))
    });
    expect(batch).toMatchObject({ idempotent: false, jobIds: [expect.any(String)] });
    expect(store.createScheduledBatch({
      slotKey: 'daily:2026-09-18:r1',
      cutoff: '2026-09-18T00:00:01Z',
      groups: groups.map((group) => ({ ...group, inputSignature: 'd'.repeat(64), initialStatus: 'queued' as const }))
    })).toMatchObject({ batchId: batch.batchId, idempotent: true, jobIds: [] });

    expect(store.claimNextQueuedJob('wrong-account', 'different-fingerprint')).toBeNull();
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'waiting_auth' });
    expect(store.requeueWaitingJobs('waiting_auth')).toBe(1);
    expect(store.claimNextQueuedJob('scheduled-runner', 'account-fingerprint')).toMatchObject({
      personId: person.id,
      documentIds: [document.documentId],
      consentId: activeBinding.consentId
    });
    store.close();
  });

  it('取消运行任务保留检查点，失败任务重试时重新进入授权领取', () => {
    const store = makeStore();
    const person = store.createPerson({ displayName: '测试成员' });
    const source = store.putSourceObject({ bytes: Buffer.from('虚构取消资料'), mediaType: 'text/plain', displayName: 'cancel.txt' });
    store.registerSourceOccurrence({ sourceObjectId: source.id, originalPath: '/tmp/cancel.txt', displayName: 'cancel.txt' });
    const document = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const consentId = store.createManualProcessingConsent({
      documentIds: [document.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [document.documentId], inputSignature: 'e'.repeat(64) }],
      initialStatus: 'queued', consentId
    });
    const job = store.claimNextQueuedJob('runner', 'account-fingerprint')!;
    const attemptId = store.startJobAttempt(job.id, '0.145.0', 'gpt-5.6-sol', 'medium');
    const auditDatabase = new Database(store.databasePath, { readonly: true });
    expect(auditDatabase.prepare(`SELECT model, reasoning_effort FROM job_attempts WHERE id = ?`).get(attemptId)).toEqual({
      model: 'gpt-5.6-sol', reasoning_effort: 'medium'
    });
    auditDatabase.close();
    store.updateJobProgress(job.id, 1);
    expect(store.requestJobCancellation(job.id)).toEqual({ running: true, alreadyTerminal: false });
    expect(store.isJobCancellationRequested(job.id)).toBe(true);
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'running', statusText: '正在安全停止', completedUnits: 1 });
    store.finishJob(job.id, 'cancelled');
    expect(store.listStoredJobs()[0]).toMatchObject({ status: 'cancelled', completedUnits: 1 });
    expect(store.requestJobCancellation(job.id)).toEqual({ running: false, alreadyTerminal: true });
    store.finishJobAttempt({ attemptId, status: 'cancelled' });
    expect(store.cleanupTerminalTaskAttempts('2026-10-18T00:00:00Z')).toBe(1);
    expect(store.cleanupTerminalTaskAttempts('2026-10-18T00:00:00Z')).toBe(0);

    const secondSource = store.putSourceObject({ bytes: Buffer.from('虚构重试资料'), mediaType: 'text/plain', displayName: 'retry.txt' });
    store.registerSourceOccurrence({ sourceObjectId: secondSource.id, originalPath: '/tmp/retry.txt', displayName: 'retry.txt' });
    const secondDocument = store.registerImportedDocument({ sourceObjectId: secondSource.id, personId: person.id });
    const secondConsentId = store.createManualProcessingConsent({
      documentIds: [secondDocument.documentId], personIds: [person.id], accountFingerprint: 'account-fingerprint', version: 1
    });
    const secondBatch = store.createWaitingAuthBatch({
      cutoff: '2026-09-18T00:00:00Z',
      groups: [{ personId: person.id, documentIds: [secondDocument.documentId], inputSignature: 'f'.repeat(64) }],
      initialStatus: 'queued', consentId: secondConsentId
    });
    const failedJob = store.claimNextQueuedJob('runner', 'account-fingerprint')!;
    expect(failedJob.id).toBe(secondBatch.jobIds[0]);
    const failedAttemptId = store.startJobAttempt(failedJob.id, '0.145.0', 'gpt-5.6-sol', 'medium');
    store.updateJobStage(failedJob.id, 'analyze');
    store.finishJobAttempt({
      attemptId: failedAttemptId,
      status: 'failed',
      errorCode: "CODEX_RPC_ERROR:-32600:failed to load configuration: unknown configuration field 'tools.view_image'"
    });
    store.finishJob(failedJob.id, 'failed');
    expect(store.listStoredJobs().find((storedJob) => storedJob.id === failedJob.id)).toMatchObject({
      status: 'failed',
      statusText: '当前版本的 Codex 配置不兼容，请安装更新后重试'
    });
    store.retryFailedJob(failedJob.id);
    store.setQueuePaused(true);
    expect(store.isQueuePaused()).toBe(true);
    expect(store.claimNextQueuedJob('paused-runner', 'account-fingerprint')).toBeNull();
    store.setQueuePaused(false);
    expect(store.claimNextQueuedJob('runner-retry', 'account-fingerprint')).toMatchObject({ id: failedJob.id, stage: 'analyze', attemptCount: 2 });
    const schemaAttemptId = store.startJobAttempt(failedJob.id, '0.145.0', 'gpt-5.6-sol', 'medium');
    store.finishJobAttempt({ attemptId: schemaAttemptId, status: 'failed', errorCode: 'CODEX_OUTPUT_SCHEMA_INVALID' });
    store.finishJob(failedJob.id, 'failed');
    expect(store.listStoredJobs().find((storedJob) => storedJob.id === failedJob.id)?.statusText)
      .toBe('结构化输出格式不兼容，请安装更新后重试');
    store.close();
  });
});
