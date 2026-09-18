import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InboxWatcherManager } from './inbox-watcher.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('InboxWatcherManager', () => {
  it('只在文件稳定后导入受支持的普通文件', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-watch-'));
    roots.push(root);
    const imported: Array<{ path: string; text: string }> = [];
    let resolveImport!: () => void;
    const completed = new Promise<void>((resolve) => { resolveImport = resolve; });
    const manager = new InboxWatcherManager({
      stabilityThresholdMs: 30,
      pollIntervalMs: 10,
      importFile: async (input) => {
        imported.push({ path: input.path, text: Buffer.from(input.bytes).toString('utf8') });
        resolveImport();
      }
    });
    await manager.sync([{
      id: 'binding-1',
      displayName: '收件箱',
      canonicalPath: root,
      consentId: 'consent-1',
      personId: 'person-1',
      personLabel: '测试成员',
      recursive: true,
      aiProcessingAuthorized: false,
      enabled: true,
      createdAt: '2026-09-18T00:00:00Z'
    }]);
    writeFileSync(join(root, '虚构报告.txt'), '虚构健康资料');
    await Promise.race([
      completed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('WATCH_TIMEOUT')), 2_000))
    ]);
    expect(imported).toEqual([{ path: join(root, '虚构报告.txt'), text: '虚构健康资料' }]);
    await manager.close();
  });

  it('对账扫描跳过未变化文件，并重新登记内容变化', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-reconcile-'));
    roots.push(root);
    const reportPath = join(root, '虚构报告.txt');
    writeFileSync(reportPath, '第一版虚构资料');
    const imported: string[] = [];
    const manager = new InboxWatcherManager({
      importFile: async (input) => {
        imported.push(Buffer.from(input.bytes).toString('utf8'));
      }
    });
    const binding = {
      id: 'binding-reconcile',
      displayName: '收件箱',
      canonicalPath: root,
      consentId: 'consent-reconcile',
      personId: 'person-1',
      personLabel: '测试成员',
      recursive: true,
      aiProcessingAuthorized: false,
      enabled: true,
      createdAt: '2026-09-18T00:00:00Z'
    };
    await manager.reconcile([binding]);
    await manager.reconcile([binding]);
    writeFileSync(reportPath, '第二版虚构健康资料');
    await manager.reconcile([binding]);
    expect(imported).toEqual(['第一版虚构资料', '第二版虚构健康资料']);
    await manager.close();
  });
});
