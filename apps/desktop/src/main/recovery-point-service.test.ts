import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { WorkspaceStore } from '@storage';
import { ensureLocalRecoveryPoints, getLocalRecoveryPointStatus, recoveryPointsReferenceSourceHash } from './recovery-point-service.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('本机自动恢复点', () => {
  it('使用一致性 SQLite 快照，并轮转为最近 7 个日点和 4 个周点', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-recovery-'));
    directories.push(root);
    const store = new WorkspaceStore({ rootDirectory: root, now: () => new Date('2026-01-01T00:00:00Z') });
    store.createPerson({ displayName: '测试成员' });
    for (let index = 0; index < 10; index += 1) {
      await ensureLocalRecoveryPoints({ store, now: new Date(2026, 0, 1 + index * 7, 12, 0, 0) });
    }
    const files = readdirSync(join(root, 'recovery-points'));
    expect(files.filter((name) => name.startsWith('daily-') && name.endsWith('.db'))).toHaveLength(7);
    expect(files.filter((name) => name.startsWith('weekly-') && name.endsWith('.db'))).toHaveLength(4);
    const status = await ensureLocalRecoveryPoints({ store, now: new Date(2026, 2, 5, 12, 0, 0) });
    expect(status).toMatchObject({ pointCount: 11, latestAt: expect.any(String) });
    expect(status.totalBytes).toBeGreaterThan(0);
    store.close();
  });

  it('schema 升级前快照作为可识别恢复点，并继续保护其引用的原始对象', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-schema-recovery-'));
    directories.push(root);
    const sourceHash = 'a'.repeat(64);
    const database = new Database(join(root, 'health.db'));
    database.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, created_at TEXT NOT NULL,
        settings_revision INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      INSERT INTO workspaces (id, schema_version, created_at, settings_revision)
      VALUES ('workspace-v2', 2, '2026-09-17T00:00:00Z', 0);
      CREATE TABLE source_objects (
        id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, media_type TEXT NOT NULL,
        size INTEGER NOT NULL, vault_relative_path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO source_objects (id, sha256, media_type, size, vault_relative_path, created_at)
      VALUES ('source-1', '${sourceHash}', 'text/plain', 1, 'aa/bb/source', '2026-09-17T00:00:00Z');
      PRAGMA user_version = 2;
    `);
    database.close();

    const store = new WorkspaceStore({ rootDirectory: root, now: () => new Date('2026-09-18T00:00:00Z') });
    await expect(getLocalRecoveryPointStatus(root)).resolves.toMatchObject({ pointCount: 1, latestAt: expect.any(String) });
    await expect(recoveryPointsReferenceSourceHash(root, sourceHash)).resolves.toBe(true);
    store.close();
  });
});
