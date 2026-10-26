import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it, vi } from 'vitest';
import { sourceManifestSchema } from '@contracts';
import type { WorkspaceStore } from '@storage';
import { buildImageManifest, enrichManifestWithLocalVisualEvidence } from '@ingestion';
import { normalizeStoredSource, rereadStoredSourceRegion } from './source-normalization.js';

function fixture() {
  const bytes = createCanvas(48, 64).toBuffer('image/png');
  const writes = vi.fn(() => { throw new Error('SYNTHETIC_STORE_SHOULD_NOT_WRITE'); });
  const store = { getDocumentConvertedView: () => null, putSourceObject: writes,
    registerDocumentConversion: writes } as unknown as WorkspaceStore;
  const receipt = { version: 1 as const, engine: 'apple-vision-local-v1' as const,
    imageSize: { width: 48, height: 64 }, recognitionRevision: 3,
    lines: [{ text: '合成项目甲 18.2 U/L', confidence: 0.9, bounds: [0.1, 0.7, 0.7, 0.03] as [number, number, number, number] }] };
  const common = { store, documentId: 'synthetic-document', sourceObjectId: 'synthetic-source',
    sha256: createHash('sha256').update(bytes).digest('hex'), displayName: '合成原件.png', bytes,
    createdAt: '2026-01-01T00:00:00Z' };
  return { common, receipt, writes };
}

async function legacyFixtureManifest(f: ReturnType<typeof fixture>) {
  return enrichManifestWithLocalVisualEvidence({ manifest: buildImageManifest({ ...f.common, mediaType: 'image/png' }),
    images: [{ path: 'synthetic-fixture-only.png', page: 1 }], recognize: async () => f.receipt });
}

describe('原件直接准备与旧 fixture 兼容接口', () => {
  it('默认只准备完整原件骨架，即使有旧识别参数也不调用 OCR、不改原件', async () => {
    const f = fixture();
    const before = Buffer.from(f.common.bytes);
    const recognize = vi.fn(async () => f.receipt);
    const manifest = await normalizeStoredSource({ ...f.common, localVisualRecognize: recognize });
    expect(manifest.normalizerVersion).toBe('direct-original-preparation-v1');
    expect(manifest.spans[0]).toMatchObject({ spanKind: 'image', page: 1, quote: null,
      readability: 'unreadable', blockId: 'direct-original-page:1' });
    expect(manifest.spans[0]?.visualEvidence).toBeUndefined();
    expect(recognize).not.toHaveBeenCalled();
    expect(Buffer.from(f.common.bytes)).toEqual(before);
    expect(f.writes).not.toHaveBeenCalled();
    expect(sourceManifestSchema.parse(manifest)).toEqual(manifest);
  });

  it('只为指定原页追加受控局部视图，不增加页数、不覆盖旧文字、不写数据库', async () => {
    const f = fixture();
    const manifest = await legacyFixtureManifest(f);
    const previous = JSON.stringify(manifest);
    let calls = 0;
    let temporary = '';
    const result = await rereadStoredSourceRegion({ manifest, bytes: f.common.bytes, displayName: f.common.displayName,
      sourceSpanId: manifest.spans[0]!.id, lineStart: 1, lineEnd: 1, createdAt: f.common.createdAt,
      recognize: async (path, options) => {
        temporary = path;
        calls += 1;
        expect(options).toMatchObject({ prepared: true, fallbackBudget: 0 });
        return f.receipt;
      } });
    expect(calls).toBe(1);
    expect(result.diagnostic).toEqual({ code: 'LOCAL_VISUAL_REGION_READ', attempts: 1 });
    expect(result.manifest.spans).toHaveLength(2);
    expect(result.manifest.spans[0]).toEqual(manifest.spans[0]);
    expect(result.manifest.totalUnits).toBe(manifest.totalUnits);
    expect(result.manifest.coveredUnitIndexes).toEqual(manifest.coveredUnitIndexes);
    expect(result.manifest.sha256).toBe(manifest.sha256);
    expect(result.manifest.spans[1]?.blockId).toBe(`local-vision-region:${manifest.spans[0]!.id}`);
    expect(result.manifest.normalizerVersion).toContain('local-visual-region-v1');
    expect(JSON.stringify(manifest)).toBe(previous);
    expect(existsSync(temporary)).toBe(false);
    expect(f.writes).not.toHaveBeenCalled();
    expect(sourceManifestSchema.parse(result.manifest)).toEqual(result.manifest);
  });

  it('不为无几何或不存在的位置调用识别，不为错原件生成证据', async () => {
    const f = fixture();
    const manifest = await legacyFixtureManifest(f);
    const recognize = vi.fn(async () => f.receipt);
    const noScope = await rereadStoredSourceRegion({ manifest, bytes: f.common.bytes, displayName: f.common.displayName,
      sourceSpanId: 'another-source', lineStart: 1, lineEnd: 1, createdAt: f.common.createdAt, recognize });
    expect(noScope.diagnostic).toEqual({ code: 'LOCAL_VISUAL_REGION_UNAVAILABLE', attempts: 0 });
    await expect(rereadStoredSourceRegion({ manifest: { ...manifest, sha256: '0'.repeat(64) }, bytes: f.common.bytes,
      displayName: f.common.displayName, sourceSpanId: manifest.spans[0]!.id,
      lineStart: 1, lineEnd: 1, createdAt: f.common.createdAt, recognize })).rejects.toThrow('SOURCE_HASH_MISMATCH');
    expect(recognize).not.toHaveBeenCalled();
    expect(f.writes).not.toHaveBeenCalled();
  });

  it('遗留生产调用即使拿到旧几何也不会默认启动本机OCR', async () => {
    const f = fixture();
    const manifest = await legacyFixtureManifest(f);
    const result = await rereadStoredSourceRegion({ manifest, bytes: f.common.bytes,
      displayName: f.common.displayName, sourceSpanId: manifest.spans[0]!.id,
      lineStart: 1, lineEnd: 1, createdAt: f.common.createdAt });
    expect(result.diagnostic).toEqual({ code: 'LOCAL_VISUAL_REGION_UNAVAILABLE', attempts: 0 });
    expect(result.manifest).toBe(manifest);
    expect(f.writes).not.toHaveBeenCalled();
  });
});
