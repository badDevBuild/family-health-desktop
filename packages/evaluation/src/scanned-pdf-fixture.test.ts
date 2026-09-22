import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPdfManifest, renderPdfPagesToPngs } from '@ingestion';
import { createSyntheticTwoPageScannedPdf } from './scanned-pdf-fixture.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('纯合成双页扫描 PDF', () => {
  it('两页均无文字层，能按页渲染图像供一次提取任务使用', async () => {
    const bytes = createSyntheticTwoPageScannedPdf();
    expect(createSyntheticTwoPageScannedPdf()).toEqual(bytes);
    const manifest = await buildPdfManifest({
      sourceObjectId: 'synthetic-source', documentId: 'synthetic-document', sha256: 'a'.repeat(64),
      displayName: '纯合成双页扫描件.pdf', bytes, createdAt: '2026-09-22T00:00:00Z'
    });
    expect(manifest.totalUnits).toBe(2);
    expect(manifest.spans.map((span) => [span.page, span.quote, span.readability])).toEqual([
      [1, null, 'unreadable'], [2, null, 'unreadable']
    ]);
    const root = mkdtempSync(join(tmpdir(), 'family-health-two-page-scan-'));
    roots.push(root);
    const rendered = await renderPdfPagesToPngs({ bytes, outputDirectory: root, pageNumbers: [1, 2] });
    expect(rendered.map((item) => item.page)).toEqual([1, 2]);
    expect(rendered.every((item) => existsSync(item.path) && item.width > 0 && item.height > 0)).toBe(true);
  });
});
