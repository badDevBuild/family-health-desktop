import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import type { WorkspaceStore } from '@storage';
import { normalizeStoredSource } from '../apps/desktop/src/main/source-normalization.js';

// 只读检查已有原件的本机准备能力；不写工作区、不调用模型、不输出原文或姓名。
const rawPath = process.argv.find((arg) => arg.startsWith('--database='))?.slice('--database='.length);
if (!rawPath) throw new Error('READONLY_DATABASE_REQUIRED');
const path = resolve(rawPath);
const db = new Database(path, { readonly: true, fileMustExist: true });
const noWrites = () => { throw new Error('READONLY_PROBE_CONVERSION_NOT_SUPPORTED'); };
const store = { putSourceObject: noWrites, registerDocumentConversion: noWrites } as unknown as WorkspaceStore;
const summary = { documents: 0, prepared: 0, imageDocuments: 0, imageDocumentsWithText: 0,
  unreadableImageSpans: 0, engineFailures: 0, sourceFailures: 0 };
try {
  const sources = db.prepare(`SELECT d.id, so.id AS source_object_id, so.sha256, so.vault_relative_path,
    COALESCE((SELECT display_name FROM source_occurrences occ WHERE occ.source_object_id = so.id
      ORDER BY occ.last_seen DESC LIMIT 1), '资料') AS display_name
    FROM documents d JOIN persons p ON p.id = d.person_id JOIN source_objects so ON so.id = d.source_object_id
    WHERE p.archived_at IS NULL AND d.excluded_from_analysis = 0 AND d.status != 'ignored'
    ORDER BY d.created_at, d.id`).all() as Array<{ id: string; source_object_id: string; sha256: string;
      vault_relative_path: string; display_name: string }>;
  summary.documents = sources.length;
  for (const source of sources) {
    try {
      const bytes = await readFile(join(dirname(path), 'vault', source.vault_relative_path));
      const manifest = await normalizeStoredSource({ store, documentId: source.id,
        sourceObjectId: source.source_object_id, sha256: source.sha256, displayName: source.display_name,
        bytes, createdAt: new Date().toISOString() });
      summary.prepared += 1;
      const images = manifest.spans.filter((span) => span.spanKind === 'image');
      if (images.length) summary.imageDocuments += 1;
      if (images.some((span) => span.quote)) summary.imageDocumentsWithText += 1;
      summary.unreadableImageSpans += images.filter((span) => !span.quote).length;
      if (manifest.conversionWarnings.some((warning) =>
        ['local_visual_engine_unavailable', 'local_visual_recognition_failed'].includes(warning))) {
        summary.engineFailures += 1;
      }
    } catch {
      summary.sourceFailures += 1;
    }
  }
  process.stdout.write(`${JSON.stringify({ readOnly: true, sentToModel: false, ...summary })}\n`);
  if (summary.engineFailures || summary.sourceFailures) process.exitCode = 1;
} finally {
  db.close();
}
