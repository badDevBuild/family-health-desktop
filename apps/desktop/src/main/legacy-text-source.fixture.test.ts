import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PersonalWorkspaceService } from './workspace-service.js';
import { installLegacySyntheticTextFixture, LegacyTextFixtureWorkspaceService } from './legacy-text-source.fixture.js';

const roots: string[] = [];
const services: PersonalWorkspaceService[] = [];
afterEach(() => { services.splice(0).forEach((service) => service.close()); roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });
function service(legacy: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'family-health-legacy-fixture-test-'));
  roots.push(root);
  const app = legacy ? new LegacyTextFixtureWorkspaceService(root, '纯合成旧兼容测试') : new PersonalWorkspaceService(root, '纯合成正式入口测试');
  services.push(app);
  return app;
}

describe('显式隔离的旧TXT合成fixture', () => {
  it('只有旧测试子类恢复合成原文，正式导入仍是模型未读骨架', async () => {
    for (const legacy of [false, true]) {
      const app = service(legacy);
      const personId = app.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
      await app.importFiles([{ path: '/tmp/合成.txt', bytes: Buffer.from('合成第一行\n\n合成末行') }], personId);
      const document = app.store.listImportedDocuments()[0]!;
      const manifest = app.store.getDocumentExtractionBundle(document.id).manifest;
      expect(manifest.normalizerVersion).toBe(legacy ? 'txt-v2' : 'direct-original-preparation-v1');
      expect(manifest.spans.map((span) => span.quote)).toEqual(legacy ? ['合成第一行', '合成末行'] : [null]);
      expect(document.personId).toBe(personId);
    }
  });

  it('重复导入不替换任何已有fixture来源，也不重新产生片段', async () => {
    const app = service(true);
    const personId = app.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
    const files = [{ path: '/tmp/合成.txt', bytes: Buffer.from('合成第一行\n合成末行') }];
    await app.importFiles(files, personId);
    const document = app.store.listImportedDocuments()[0]!;
    const before = app.store.getDocumentExtractionBundle(document.id).manifest;
    expect((await app.importFiles(files, personId)).duplicateCount).toBe(1);
    expect(app.store.getDocumentExtractionBundle(document.id).manifest).toEqual(before);
    expect(() => installLegacySyntheticTextFixture(app, document.id)).toThrow('LEGACY_TEXT_FIXTURE_UNREAD_NEW_DOCUMENT_REQUIRED');
  });

  it('非临时工作区在读取文档或执行任何数据库操作前拒绝', () => {
    // 仓库本身可能位于临时目录，使用临时根的父目录稳定覆盖越界拒绝。
    const notTemporary = { store: { rootDirectory: resolve(tmpdir(), '..') } } as unknown as PersonalWorkspaceService;
    expect(() => installLegacySyntheticTextFixture(notTemporary, 'synthetic-id')).toThrow('LEGACY_TEXT_FIXTURE_TEMPORARY_WORKSPACE_REQUIRED');
  });
});
