import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, renameSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rename, rm, stat, statfs } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { WORKSPACE_SCHEMA_VERSION, type WorkspaceStore } from '@storage';

const MAGIC = Buffer.from('FHDBACKUPv1_____');
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + SALT_BYTES + IV_BYTES;
const MAX_ENTRY_HEADER_BYTES = 64 * 1024;
const MAX_RESTORE_BYTES = 20 * 1024 * 1024 * 1024;
const MAX_ENCRYPTED_BACKUP_BYTES = MAX_RESTORE_BYTES + 64 * 1024 * 1024;
const RESTORE_FREE_SPACE_RESERVE_BYTES = 64 * 1024 * 1024;
const deriveKey = promisify(scrypt);

export const BACKUP_SECURITY_PROFILE = Object.freeze({
  formatVersion: 1,
  kdf: 'scrypt-fixed-v1',
  derivedKeyBytes: 32,
  acceptsArchiveKdfParameters: false,
  maxEntryHeaderBytes: MAX_ENTRY_HEADER_BYTES,
  maxRestoreBytes: MAX_RESTORE_BYTES,
  maxEncryptedBackupBytes: MAX_ENCRYPTED_BACKUP_BYTES
});

interface ArchiveEntryHeader {
  path: string;
  size: number;
  sha256: string;
}

interface BackupManifest {
  formatVersion: 1;
  workspaceName: string;
  schemaVersion: number;
  createdAt: string;
  objectCount: number;
}

export interface PreparedRestore {
  stagedRoot: string;
  workspaceName: string;
}

type RestoreFailureInjector = (point: 'before_archive_entry_write') => void;

function throwIfRestoreAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('BACKUP_RESTORE_CANCELLED');
}

async function writeBuffer(handle: FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.write(buffer, offset, buffer.length - offset);
    offset += result.bytesWritten;
  }
}

async function readExactly(handle: FileHandle, buffer: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.read(buffer, offset, buffer.length - offset, position + offset);
    if (result.bytesRead === 0) throw new Error('BACKUP_TRUNCATED');
    offset += result.bytesRead;
  }
}

async function hashFile(path: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    hash.update(bytes);
  }
  return { sha256: hash.digest('hex'), size };
}

export function assertBackupArchiveEntryPath(path: string): void {
  if (path === 'backup-manifest.json' || path === 'health.db') return;
  if (/^vault\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(path)) return;
  throw new Error('BACKUP_ENTRY_PATH_REJECTED');
}

function safeVaultPath(vaultRoot: string, relativePath: string): string {
  const root = resolve(vaultRoot);
  const target = resolve(root, relativePath);
  const fromRoot = relative(root, target);
  if (fromRoot.startsWith(`..${sep}`) || fromRoot === '..' || fromRoot === '' || fromRoot.startsWith('/')) {
    throw new Error('BACKUP_OBJECT_PATH_REJECTED');
  }
  return target;
}

async function writeEntryHeader(handle: FileHandle, header: ArchiveEntryHeader): Promise<void> {
  const payload = Buffer.from(JSON.stringify(header), 'utf8');
  if (payload.length > MAX_ENTRY_HEADER_BYTES) throw new Error('BACKUP_ENTRY_HEADER_TOO_LARGE');
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(payload.length);
  await writeBuffer(handle, length);
  await writeBuffer(handle, payload);
}

async function appendFile(handle: FileHandle, archivePath: string, sourcePath: string, expectedSha256?: string): Promise<void> {
  assertBackupArchiveEntryPath(archivePath);
  const hashed = await hashFile(sourcePath);
  if (expectedSha256 && hashed.sha256 !== expectedSha256) throw new Error('BACKUP_SOURCE_HASH_MISMATCH');
  await writeEntryHeader(handle, { path: archivePath, size: hashed.size, sha256: hashed.sha256 });
  for await (const chunk of createReadStream(sourcePath)) await writeBuffer(handle, Buffer.from(chunk));
}

async function appendBytes(handle: FileHandle, archivePath: string, bytes: Buffer): Promise<void> {
  assertBackupArchiveEntryPath(archivePath);
  await writeEntryHeader(handle, {
    path: archivePath,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex')
  });
  await writeBuffer(handle, bytes);
}

async function encryptFile(plainPath: string, targetPath: string, passphrase: string): Promise<void> {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = Buffer.from(await deriveKey(passphrase, salt, BACKUP_SECURITY_PROFILE.derivedKeyBytes) as Buffer);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const temporary = `${targetPath}.${randomUUID()}.tmp`;
  const output = await open(temporary, 'wx', 0o600);
  try {
    await writeBuffer(output, Buffer.concat([MAGIC, salt, iv]));
    for await (const chunk of createReadStream(plainPath)) {
      const encrypted = cipher.update(Buffer.from(chunk));
      if (encrypted.length) await writeBuffer(output, encrypted);
    }
    const final = cipher.final();
    if (final.length) await writeBuffer(output, final);
    await writeBuffer(output, cipher.getAuthTag());
    await output.sync();
    await output.close();
    await rename(temporary, targetPath);
  } catch (error) {
    await output.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    key.fill(0);
  }
}

async function decryptFile(backupPath: string, plainPath: string, passphrase: string, signal?: AbortSignal): Promise<void> {
  throwIfRestoreAborted(signal);
  const file = await open(backupPath, 'r');
  const metadata = await file.stat();
  if (metadata.size <= HEADER_BYTES + TAG_BYTES) {
    await file.close();
    throw new Error('BACKUP_TRUNCATED');
  }
  if (metadata.size > MAX_ENCRYPTED_BACKUP_BYTES) {
    await file.close();
    throw new Error('BACKUP_ENCRYPTED_SIZE_LIMIT_EXCEEDED');
  }
  const volume = await statfs(dirname(plainPath));
  const availableBytes = Number(volume.bavail) * Number(volume.bsize);
  if (!Number.isFinite(availableBytes) || availableBytes < metadata.size + RESTORE_FREE_SPACE_RESERVE_BYTES) {
    await file.close();
    throw new Error('BACKUP_RESTORE_SPACE_INSUFFICIENT');
  }
  const header = Buffer.allocUnsafe(HEADER_BYTES);
  await readExactly(file, header, 0);
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
    await file.close();
    throw new Error('BACKUP_FORMAT_UNSUPPORTED');
  }
  const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_BYTES);
  const iv = header.subarray(MAGIC.length + SALT_BYTES);
  const tag = Buffer.allocUnsafe(TAG_BYTES);
  await readExactly(file, tag, metadata.size - TAG_BYTES);
  const key = Buffer.from(await deriveKey(passphrase, salt, BACKUP_SECURITY_PROFILE.derivedKeyBytes) as Buffer);
  throwIfRestoreAborted(signal);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const output = await open(plainPath, 'wx', 0o600);
  try {
    let position = HEADER_BYTES;
    let decryptedBytes = 0;
    const ciphertextEnd = metadata.size - TAG_BYTES;
    const chunk = Buffer.allocUnsafe(64 * 1024);
    while (position < ciphertextEnd) {
      throwIfRestoreAborted(signal);
      const requested = Math.min(chunk.length, ciphertextEnd - position);
      const result = await file.read(chunk, 0, requested, position);
      if (result.bytesRead === 0) throw new Error('BACKUP_TRUNCATED');
      position += result.bytesRead;
      const plain = decipher.update(chunk.subarray(0, result.bytesRead));
      decryptedBytes += plain.length;
      if (decryptedBytes > MAX_RESTORE_BYTES) throw new Error('BACKUP_RESTORE_LIMIT_EXCEEDED');
      if (plain.length) await writeBuffer(output, plain);
    }
    const final = decipher.final();
    decryptedBytes += final.length;
    if (decryptedBytes > MAX_RESTORE_BYTES) throw new Error('BACKUP_RESTORE_LIMIT_EXCEEDED');
    if (final.length) await writeBuffer(output, final);
    await output.sync();
  } catch (error) {
    if (error instanceof Error && [
      'BACKUP_RESTORE_CANCELLED',
      'BACKUP_RESTORE_LIMIT_EXCEEDED',
      'BACKUP_RESTORE_SPACE_INSUFFICIENT'
    ].includes(error.message)) throw error;
    throw new Error('BACKUP_PASSPHRASE_OR_INTEGRITY_INVALID', { cause: error });
  } finally {
    key.fill(0);
    await file.close();
    await output.close();
  }
}

async function extractArchive(archivePath: string, stagedRoot: string, signal?: AbortSignal, failureInjector?: RestoreFailureInjector): Promise<void> {
  const archive = await open(archivePath, 'r');
  let position = 0;
  let restoredBytes = 0;
  const seen = new Set<string>();
  try {
    while (true) {
      throwIfRestoreAborted(signal);
      const length = Buffer.allocUnsafe(4);
      await readExactly(archive, length, position);
      position += 4;
      const headerLength = length.readUInt32BE(0);
      if (headerLength <= 0 || headerLength > MAX_ENTRY_HEADER_BYTES) throw new Error('BACKUP_ENTRY_HEADER_INVALID');
      const payload = Buffer.allocUnsafe(headerLength);
      await readExactly(archive, payload, position);
      position += headerLength;
      const header = JSON.parse(payload.toString('utf8')) as ArchiveEntryHeader;
      if (header.path === '' && header.size === 0) break;
      assertBackupArchiveEntryPath(header.path);
      if (seen.has(header.path)) throw new Error('BACKUP_DUPLICATE_ENTRY');
      if (!Number.isSafeInteger(header.size) || header.size < 0) throw new Error('BACKUP_ENTRY_SIZE_INVALID');
      restoredBytes += header.size;
      if (restoredBytes > MAX_RESTORE_BYTES) throw new Error('BACKUP_RESTORE_LIMIT_EXCEEDED');
      seen.add(header.path);
      const destination = join(stagedRoot, ...header.path.split('/'));
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      failureInjector?.('before_archive_entry_write');
      const output = await open(destination, 'wx', 0o600);
      const hash = createHash('sha256');
      try {
        let remaining = header.size;
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(remaining, 1)));
        while (remaining > 0) {
          throwIfRestoreAborted(signal);
          const requested = Math.min(chunk.length, remaining);
          const result = await archive.read(chunk, 0, requested, position);
          if (result.bytesRead === 0) throw new Error('BACKUP_TRUNCATED');
          const bytes = chunk.subarray(0, result.bytesRead);
          await writeBuffer(output, bytes);
          hash.update(bytes);
          position += result.bytesRead;
          remaining -= result.bytesRead;
        }
      } finally {
        await output.close();
      }
      if (hash.digest('hex') !== header.sha256) throw new Error('BACKUP_ENTRY_HASH_MISMATCH');
    }
  } finally {
    await archive.close();
  }
  if (!seen.has('backup-manifest.json') || !seen.has('health.db')) throw new Error('BACKUP_REQUIRED_ENTRY_MISSING');
}

async function validateRestoredWorkspace(stagedRoot: string, signal?: AbortSignal): Promise<BackupManifest> {
  throwIfRestoreAborted(signal);
  const manifest = JSON.parse(await readFile(join(stagedRoot, 'backup-manifest.json'), 'utf8')) as BackupManifest;
  if (manifest.formatVersion !== 1 || !manifest.workspaceName || manifest.schemaVersion > WORKSPACE_SCHEMA_VERSION) {
    throw new Error('BACKUP_MANIFEST_UNSUPPORTED');
  }
  const database = new Database(join(stagedRoot, 'health.db'), { readonly: true, fileMustExist: true });
  try {
    const integrity = database.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error('BACKUP_DATABASE_INTEGRITY_FAILED');
    const schemaVersion = Number(database.pragma('user_version', { simple: true }));
    if (schemaVersion > WORKSPACE_SCHEMA_VERSION) throw new Error('BACKUP_SCHEMA_NEWER_THAN_APP');
    const objects = database.prepare(`SELECT sha256, size, vault_relative_path FROM source_objects`).all() as Array<{
      sha256: string;
      size: number;
      vault_relative_path: string;
    }>;
    if (objects.length !== manifest.objectCount) throw new Error('BACKUP_OBJECT_COUNT_MISMATCH');
    for (const object of objects) {
      throwIfRestoreAborted(signal);
      const path = safeVaultPath(join(stagedRoot, 'vault'), object.vault_relative_path);
      const hashed = await hashFile(path);
      if (hashed.sha256 !== object.sha256 || hashed.size !== object.size) throw new Error('BACKUP_OBJECT_INTEGRITY_FAILED');
    }
  } finally {
    database.close();
  }
  return manifest;
}

export async function createEncryptedBackup(input: {
  store: WorkspaceStore;
  workspaceName: string;
  targetPath: string;
  passphrase: string;
  temporaryRoot: string;
  now?: () => Date;
}): Promise<{ objectCount: number; createdAt: string }> {
  if (input.passphrase.length < 10) throw new Error('BACKUP_PASSPHRASE_TOO_SHORT');
  const temporary = await mkdtemp(join(input.temporaryRoot, 'family-health-backup-'));
  const snapshotPath = join(temporary, 'health.db');
  const archivePath = join(temporary, 'backup.archive');
  try {
    await input.store.createDatabaseSnapshot(snapshotPath);
    const snapshot = new Database(snapshotPath, { readonly: true, fileMustExist: true });
    let objects: Array<{ sha256: string; size: number; vault_relative_path: string }>;
    try {
      if (snapshot.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('BACKUP_DATABASE_INTEGRITY_FAILED');
      objects = snapshot.prepare(`SELECT sha256, size, vault_relative_path FROM source_objects ORDER BY sha256`).all() as typeof objects;
    } finally {
      snapshot.close();
    }
    const createdAt = (input.now?.() ?? new Date()).toISOString();
    const manifest: BackupManifest = {
      formatVersion: 1,
      workspaceName: input.workspaceName,
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      createdAt,
      objectCount: objects.length
    };
    const archive = await open(archivePath, 'wx', 0o600);
    try {
      await appendBytes(archive, 'backup-manifest.json', Buffer.from(JSON.stringify(manifest), 'utf8'));
      await appendFile(archive, 'health.db', snapshotPath);
      for (const object of objects) {
        const sourcePath = safeVaultPath(input.store.vaultDirectory, object.vault_relative_path);
        const details = await stat(sourcePath);
        if (!details.isFile() || details.size !== object.size) throw new Error('BACKUP_SOURCE_OBJECT_MISSING');
        await appendFile(archive, `vault/${object.vault_relative_path.replaceAll(sep, '/')}`, sourcePath, object.sha256);
      }
      await writeEntryHeader(archive, { path: '', size: 0, sha256: '' });
      await archive.sync();
    } finally {
      await archive.close();
    }
    await encryptFile(archivePath, input.targetPath, input.passphrase);
    return { objectCount: objects.length, createdAt };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function prepareEncryptedRestore(input: {
  backupPath: string;
  passphrase: string;
  temporaryRoot: string;
  signal?: AbortSignal;
  failureInjector?: RestoreFailureInjector;
}): Promise<PreparedRestore> {
  if (!input.passphrase) throw new Error('BACKUP_PASSPHRASE_REQUIRED');
  const temporary = await mkdtemp(join(input.temporaryRoot, 'family-health-restore-'));
  const archivePath = join(temporary, 'backup.archive');
  const stagedRoot = join(temporary, 'workspace');
  await mkdir(stagedRoot, { recursive: true, mode: 0o700 });
  try {
    throwIfRestoreAborted(input.signal);
    await decryptFile(input.backupPath, archivePath, input.passphrase, input.signal);
    await extractArchive(archivePath, stagedRoot, input.signal, input.failureInjector);
    const manifest = await validateRestoredWorkspace(stagedRoot, input.signal);
    await rm(archivePath, { force: true });
    return { stagedRoot, workspaceName: manifest.workspaceName };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function replaceWorkspaceWithPreparedRestore(input: {
  liveRoot: string;
  stagedRoot: string;
  signal?: AbortSignal;
}): Promise<{ recoveryRoot: string }> {
  throwIfRestoreAborted(input.signal);
  const recoveryRoot = `${input.liveRoot}.before-restore-${randomUUID()}`;
  await rename(input.liveRoot, recoveryRoot);
  try {
    throwIfRestoreAborted(input.signal);
    await rename(input.stagedRoot, input.liveRoot);
    return { recoveryRoot };
  } catch (error) {
    await rename(recoveryRoot, input.liveRoot).catch(() => undefined);
    throw error;
  }
}

export function recoverInterruptedWorkspaceSwitch(liveRoot: string): { recovered: boolean; recoveryRoot: string | null } {
  if (existsSync(join(liveRoot, 'health.db'))) return { recovered: false, recoveryRoot: null };
  const parent = dirname(liveRoot);
  const prefix = `${basename(liveRoot)}.before-restore-`;
  const candidates = readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => join(parent, entry.name))
    .filter((path) => existsSync(join(path, 'health.db')))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  const recoveryRoot = candidates[0] ?? null;
  if (!recoveryRoot) return { recovered: false, recoveryRoot: null };
  if (existsSync(liveRoot)) throw new Error('INTERRUPTED_RESTORE_LIVE_ROOT_CONFLICT');
  renameSync(recoveryRoot, liveRoot);
  return { recovered: true, recoveryRoot };
}
