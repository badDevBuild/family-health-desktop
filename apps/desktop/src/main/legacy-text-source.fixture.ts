import { readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative } from 'node:path';
import type Database from 'better-sqlite3';
import { buildTextManifest, decodeText } from '@ingestion';
import { PersonalWorkspaceService } from './workspace-service.js';

/** 仅为旧流水线/派生兼容测试提供已知合成文字；正式入口仍只生成原件未读骨架。
 * 此 helper 不得被应用或新 direct 原件集成测试导入。它只操作新建临时测试库，
 * 不能读取/改写正式资料、已完成事实或任何已有提交。
 */
export function installLegacySyntheticTextFixture(service: PersonalWorkspaceService, documentId: string): void {
  const root = realpathSync(service.store.rootDirectory);
  const withinTemporary = relative(realpathSync(tmpdir()), root);
  if (!withinTemporary || withinTemporary.startsWith('..') || isAbsolute(withinTemporary)) {
    throw new Error('LEGACY_TEXT_FIXTURE_TEMPORARY_WORKSPACE_REQUIRED');
  }
  const bundle = service.store.getDocumentExtractionBundle(documentId);
  if (bundle.manifest.mediaType !== 'text/plain') return;
  if (bundle.manifest.spans.some((span) => span.quote !== null || span.visualEvidence || span.modelEvidence)) {
    throw new Error('LEGACY_TEXT_FIXTURE_UNREAD_NEW_DOCUMENT_REQUIRED');
  }
  // 测试专用同连接事务，删除未被任何正式结果引用的空骨架，再由正常存储API保存合成原文。
  const database = (service.store as unknown as { db: Database.Database }).db;
  const committed = database.prepare(`SELECT
    (SELECT COUNT(*) FROM document_commits WHERE document_id=?) +
    (SELECT COUNT(*) FROM observation_revisions r JOIN source_spans s ON s.id=r.source_span_id WHERE s.document_id=?) +
    (SELECT COUNT(*) FROM clinical_statements WHERE document_id=?) AS count`).get(documentId, documentId, documentId) as { count: number };
  if (committed.count !== 0) throw new Error('LEGACY_TEXT_FIXTURE_COMMITTED_DOCUMENT_REJECTED');
  const manifest = buildTextManifest({ documentId, sourceObjectId: bundle.manifest.sourceObjectId,
    sha256: bundle.manifest.sha256, displayName: bundle.manifest.originalDisplayName,
    createdAt: bundle.manifest.createdAt, text: decodeText(readFileSync(bundle.sourcePath)).text });
  database.transaction(() => {
    database.prepare('DELETE FROM source_manifest_spans WHERE document_id=?').run(documentId);
    database.prepare('DELETE FROM source_manifests WHERE document_id=?').run(documentId);
    database.prepare('DELETE FROM source_spans WHERE document_id=?').run(documentId);
    service.store.saveSourceManifest(manifest);
  })();
}

/** 旧兼容测试显式选择此类；不改变 PersonalWorkspaceService 的正式导入行为。 */
export class LegacyTextFixtureWorkspaceService extends PersonalWorkspaceService {
  override async importFiles(...args: Parameters<PersonalWorkspaceService['importFiles']>): ReturnType<PersonalWorkspaceService['importFiles']> {
    const existing = new Set(this.store.listImportedDocuments().map((document) => document.id));
    const receipt = await super.importFiles(...args);
    for (const document of this.store.listImportedDocuments()) {
      if (!existing.has(document.id) && document.mediaType === 'text/plain' && document.status !== 'blocked') {
        installLegacySyntheticTextFixture(this, document.id);
      }
    }
    return receipt;
  }
}
