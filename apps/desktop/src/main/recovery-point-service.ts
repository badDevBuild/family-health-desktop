import { copyFile, chmod, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { WorkspaceStore } from '@storage';

export interface RecoveryPointStatus {
  pointCount: number;
  totalBytes: number;
  latestAt: string | null;
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isoWeekKey(date: Date): string {
  const value = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(value.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((value.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${value.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function validateDatabase(path: string): Promise<void> {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    if (database.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('RECOVERY_POINT_INTEGRITY_FAILED');
  } finally {
    database.close();
  }
}

async function writeManifest(path: string, input: { kind: 'daily' | 'weekly'; createdAt: string; databaseFile: string }): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ formatVersion: 1, ...input }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}

async function rotate(root: string, kind: 'daily' | 'weekly', keep: number): Promise<void> {
  const files = (await readdir(root)).filter((name) => name.startsWith(`${kind}-`) && name.endsWith('.db')).sort().reverse();
  for (const databaseFile of files.slice(keep)) {
    await rm(join(root, databaseFile), { force: true });
    await rm(join(root, `${databaseFile.slice(0, -3)}.json`), { force: true });
  }
}

export async function ensureLocalRecoveryPoints(input: {
  store: WorkspaceStore;
  now?: Date;
}): Promise<RecoveryPointStatus> {
  const now = input.now ?? new Date();
  const root = join(input.store.rootDirectory, 'recovery-points');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dailyBase = `daily-${localDateKey(now)}`;
  const weeklyBase = `weekly-${isoWeekKey(now)}`;
  const dailyPath = join(root, `${dailyBase}.db`);
  const weeklyPath = join(root, `${weeklyBase}.db`);
  const dailyExists = await exists(dailyPath);
  const weeklyExists = await exists(weeklyPath);
  if (!dailyExists) {
    const temporary = join(root, `${dailyBase}.${process.pid}.tmp`);
    await input.store.createDatabaseSnapshot(temporary);
    await validateDatabase(temporary);
    await chmod(temporary, 0o600);
    await rename(temporary, dailyPath);
    await writeManifest(join(root, `${dailyBase}.json`), {
      kind: 'daily', createdAt: now.toISOString(), databaseFile: `${dailyBase}.db`
    });
  }
  if (!weeklyExists) {
    const temporary = join(root, `${weeklyBase}.${process.pid}.tmp`);
    await copyFile(dailyPath, temporary);
    await validateDatabase(temporary);
    await chmod(temporary, 0o600);
    await rename(temporary, weeklyPath);
    await writeManifest(join(root, `${weeklyBase}.json`), {
      kind: 'weekly', createdAt: now.toISOString(), databaseFile: `${weeklyBase}.db`
    });
  }
  await rotate(root, 'daily', 7);
  await rotate(root, 'weekly', 4);
  return getLocalRecoveryPointStatus(input.store.rootDirectory);
}

export async function getLocalRecoveryPointStatus(workspaceRoot: string): Promise<RecoveryPointStatus> {
  const root = join(workspaceRoot, 'recovery-points');
  const files = await readdir(root).catch(() => [] as string[]);
  const databases = files.filter((name) => /^(daily|weekly|schema-upgrade)-.+\.db$/.test(name));
  const metadata = await Promise.all(databases.map(async (name) => ({ name, stats: await stat(join(root, name)) })));
  return {
    pointCount: metadata.length,
    totalBytes: metadata.reduce((total, item) => total + item.stats.size, 0),
    latestAt: metadata.length > 0
      ? new Date(Math.max(...metadata.map((item) => item.stats.mtimeMs))).toISOString()
      : null
  };
}

export async function recoveryPointsReferenceSourceHash(workspaceRoot: string, sourceHash: string): Promise<boolean> {
  const root = join(workspaceRoot, 'recovery-points');
  const files = await readdir(root).catch(() => [] as string[]);
  for (const name of files.filter((file) => /^(daily|weekly|schema-upgrade)-.+\.db$/.test(file))) {
    const database = new Database(join(root, name), { readonly: true, fileMustExist: true });
    try {
      const hasSourceObjects = database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'source_objects'`).get();
      if (!hasSourceObjects) continue;
      const row = database.prepare(`SELECT 1 FROM source_objects WHERE sha256 = ? LIMIT 1`).get(sourceHash);
      if (row) return true;
    } finally {
      database.close();
    }
  }
  return false;
}
