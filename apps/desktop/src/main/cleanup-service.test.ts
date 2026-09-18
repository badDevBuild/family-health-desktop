import { mkdir, mkdtemp, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupOwnedTemporaryEntries } from './cleanup-service.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('本应用临时资料清理', () => {
  it('只删除达到期限的本应用目录，不触碰相邻目录或近期任务', async () => {
    const root = await mkdtemp(join(tmpdir(), 'family-health-cleanup-test-'));
    roots.push(root);
    const oldOwned = join(root, 'family-health-preview-old');
    const recentOwned = join(root, 'family-health-pdf-recent');
    const external = join(root, 'unrelated-canary');
    await Promise.all([mkdir(oldOwned), mkdir(recentOwned), mkdir(external)]);
    await utimes(oldOwned, new Date('2026-08-01T00:00:00Z'), new Date('2026-08-01T00:00:00Z'));
    const removed = await cleanupOwnedTemporaryEntries({
      temporaryRoot: root,
      olderThan: new Date('2026-09-11T00:00:00Z')
    });
    expect(removed).toBe(1);
    await expect(stat(oldOwned)).rejects.toThrow();
    await expect(stat(recentOwned)).resolves.toBeDefined();
    await expect(stat(external)).resolves.toBeDefined();
  });
});
