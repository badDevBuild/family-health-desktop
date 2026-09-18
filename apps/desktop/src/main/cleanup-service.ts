import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

const ownedPrefixes = [
  'family-health-preview-',
  'family-health-export-',
  'family-health-image-',
  'family-health-pdf-',
  'family-health-backup-',
  'family-health-restore-'
];

export async function cleanupOwnedTemporaryEntries(input: {
  temporaryRoot: string;
  olderThan: Date;
}): Promise<number> {
  const entries = await readdir(input.temporaryRoot, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !ownedPrefixes.some((prefix) => entry.name.startsWith(prefix))) continue;
    const path = join(input.temporaryRoot, entry.name);
    const details = await stat(path).catch(() => null);
    if (!details || details.mtimeMs >= input.olderThan.getTime()) continue;
    await rm(path, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
