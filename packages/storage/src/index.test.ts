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

  it('从 schema v2 原位升级并保留工作区', () => {
    const directory = mkdtempSync(join(tmpdir(), 'family-health-store-v2-'));
    directories.push(directory);
    createSchemaV2Database(directory);
    const store = new WorkspaceStore({ rootDirectory: directory, now: () => new Date('2026-09-18T00:00:00Z') });
    const upgraded = new Database(store.databasePath, { readonly: true });
    expect(upgraded.pragma('user_version', { simple: true })).toBe(8);
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

  it('schema 多步升级失败时整体回滚并保留升级前一致性备份', () => {
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

  it('schema v8 将旧身份冲突升级为可确认关系，并在确认后保留报告姓名', () => {
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
