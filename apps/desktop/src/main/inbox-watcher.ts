import { EventEmitter } from 'node:events';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import type { ActiveInboxBinding } from '@storage';
import { INGESTION_LIMITS } from '@ingestion';

const supportedExtensions = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.heic', '.heif', '.docx', '.doc', '.txt']);

interface InboxWatcherOptions {
  stabilityThresholdMs?: number;
  pollIntervalMs?: number;
  importFile(input: { bindingId: string; personId: string | null; path: string; bytes: Uint8Array }): Promise<void>;
}

interface WatcherEntry {
  signature: string;
  watcher: FSWatcher;
}

export class InboxWatcherManager extends EventEmitter {
  private readonly watchers = new Map<string, WatcherEntry>();
  private readonly processingPaths = new Set<string>();
  private readonly knownSignatures = new Map<string, string>();

  constructor(private readonly options: InboxWatcherOptions) {
    super();
  }

  async sync(bindings: ActiveInboxBinding[]): Promise<void> {
    const activeIds = new Set(bindings.map((binding) => binding.id));
    for (const [bindingId, entry] of this.watchers) {
      if (!activeIds.has(bindingId)) {
        await entry.watcher.close();
        this.watchers.delete(bindingId);
        for (const key of this.knownSignatures.keys()) {
          if (key.startsWith(`${bindingId}\u0000`)) this.knownSignatures.delete(key);
        }
      }
    }
    for (const binding of bindings) {
      const signature = JSON.stringify({
        path: binding.canonicalPath,
        personId: binding.personId,
        recursive: binding.recursive
      });
      const existing = this.watchers.get(binding.id);
      if (existing?.signature === signature) continue;
      if (existing) await existing.watcher.close();
      const watcher = watch(binding.canonicalPath, {
        persistent: true,
        ignoreInitial: false,
        followSymlinks: false,
        ...(binding.recursive ? {} : { depth: 0 }),
        ignored: (path, stats) => Boolean(stats?.isDirectory() && path !== binding.canonicalPath && path.split(/[\\/]/).at(-1)?.startsWith('.')),
        awaitWriteFinish: {
          stabilityThreshold: this.options.stabilityThresholdMs ?? INGESTION_LIMITS.stableForMs,
          pollInterval: this.options.pollIntervalMs ?? 500
        }
      });
      watcher.on('add', (path) => void this.ingest(binding, path));
      watcher.on('change', (path) => void this.ingest(binding, path));
      watcher.on('error', () => this.emit('watchError', { bindingId: binding.id, code: 'INBOX_WATCH_FAILED' }));
      this.watchers.set(binding.id, { signature, watcher });
    }
  }

  async close(): Promise<void> {
    const entries = [...this.watchers.values()];
    this.watchers.clear();
    await Promise.all(entries.map((entry) => entry.watcher.close()));
  }

  async reconcile(bindings: ActiveInboxBinding[]): Promise<void> {
    for (const binding of bindings) {
      await this.walkBinding(binding, binding.canonicalPath, 0);
    }
  }

  private async walkBinding(binding: ActiveInboxBinding, directory: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      this.emit('watchError', { bindingId: binding.id, code: 'INBOX_DIRECTORY_UNAVAILABLE' });
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (binding.recursive && depth < 64 && !entry.name.startsWith('.')) {
          await this.walkBinding(binding, path, depth + 1);
        }
      } else if (entry.isFile()) {
        await this.ingest(binding, path);
      }
    }
  }

  private async ingest(binding: ActiveInboxBinding, path: string): Promise<void> {
    const processingKey = `${binding.id}\u0000${path}`;
    if (!supportedExtensions.has(extname(path).toLowerCase()) || this.processingPaths.has(processingKey)) return;
    this.processingPaths.add(processingKey);
    try {
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink()) throw new Error('INBOX_FILE_NOT_SAFE');
      if (before.size > INGESTION_LIMITS.maxFileBytes) throw new Error('INPUT_LIMIT_EXCEEDED');
      const signature = `${before.size}:${before.mtimeMs}`;
      if (this.knownSignatures.get(processingKey) === signature) return;
      const bytes = await readFile(path);
      const after = await lstat(path);
      if (!after.isFile() || after.isSymbolicLink() || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        throw new Error('INBOX_FILE_CHANGED_DURING_READ');
      }
      await this.options.importFile({ bindingId: binding.id, personId: binding.personId, path, bytes });
      this.knownSignatures.set(processingKey, signature);
      this.emit('imported', { bindingId: binding.id });
    } catch (error) {
      this.emit('importError', {
        bindingId: binding.id,
        code: error instanceof Error ? error.message : 'INBOX_IMPORT_FAILED'
      });
    } finally {
      this.processingPaths.delete(processingKey);
    }
  }
}
