import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceStore, WORKSPACE_SCHEMA_VERSION } from './index.js';

const resources: Array<{ root: string; store?: WorkspaceStore; db?: Database.Database }> = [];
afterEach(() => { for (const item of resources.splice(0)) { item.store?.close(); item.db?.close(); rmSync(item.root, { recursive: true, force: true }); } });
function legacy42() {
  const root = mkdtempSync(join(tmpdir(), 'date-receipt-migration-synthetic-'));
  const state: typeof resources[number] = { root }; resources.push(state);
  const store = new WorkspaceStore({ rootDirectory: root });
  const person = store.createPerson({ displayName: '合成迁移成员' });
  store.createUserAction({ personId: person.id, title: '合成计划', detail: '保留原计划', dueDate: '2028-06-07', dueText: '合成时间' });
  const source = store.putSourceObject({ bytes: Buffer.from('合成迁移原件'), mediaType: 'text/plain', displayName: 'synthetic.txt' });
  store.registerImportedDocument({ personId: person.id, sourceObjectId: source.id }); store.close();
  const db = new Database(join(root, 'health.db')); db.exec(`DROP TABLE ai_transmission_receipts;
    UPDATE workspaces SET schema_version=42; PRAGMA user_version=42;`);
  const rows = ['persons', 'action_items', 'documents', 'source_objects'].map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]);
  db.close(); return { state, root, rows };
}

describe('日期盲读传输凭据正常版本迁移', () => {
  it('v42到v43只新增无正文凭据表，既有成员/计划/原件逐字不变并保存可读恢复点', () => {
    const f = legacy42(); const store = new WorkspaceStore({ rootDirectory: f.root }); f.state.store = store;
    const db = new Database(join(f.root, 'health.db'), { readonly: true }); f.state.db = db;
    expect(db.pragma('user_version', { simple: true })).toBe(WORKSPACE_SCHEMA_VERSION);
    for (const [table, rows] of f.rows) expect(db.prepare(`SELECT * FROM ${table as string} ORDER BY rowid`).all()).toEqual(rows);
    expect(db.prepare('SELECT * FROM ai_transmission_receipts').all()).toEqual([]);
    const backups = readdirSync(store.schemaBackupDirectory).filter((name) => name.endsWith('.db'));
    expect(backups).toHaveLength(1);
    const backup = new Database(join(store.schemaBackupDirectory, backups[0]!), { readonly: true });
    try { expect(backup.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(backup.pragma('user_version', { simple: true })).toBe(42);
      for (const [table, rows] of f.rows) expect(backup.prepare(`SELECT * FROM ${table as string} ORDER BY rowid`).all()).toEqual(rows);
    } finally { backup.close(); }
  });
  it('迁移失败原子回滚，旧数据库和原件元数据仍保持v42', () => {
    const f = legacy42();
    expect(() => new WorkspaceStore({ rootDirectory: f.root, failureInjector: (point) => {
      if (point === 'during_schema_migration') throw new Error('synthetic-migration-failure');
    } })).toThrow('synthetic-migration-failure');
    const db = new Database(join(f.root, 'health.db'), { readonly: true }); f.state.db = db;
    expect(db.pragma('user_version', { simple: true })).toBe(42);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='ai_transmission_receipts'").get()).toBeUndefined();
    for (const [table, rows] of f.rows) expect(db.prepare(`SELECT * FROM ${table as string} ORDER BY rowid`).all()).toEqual(rows);
  });
});
