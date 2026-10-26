import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { SourceManifest, SourceVisualEvidence } from '@contracts';
import { rereadLocalVisualRegion } from '@ingestion';
import { WorkspaceStore, WORKSPACE_SCHEMA_VERSION } from './index.js';

const stores = new Set<WorkspaceStore>();
const roots: string[] = [];
afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function storeFixture() {
  const rootDirectory = mkdtempSync(join(tmpdir(), 'family-health-visual-storage-synthetic-'));
  roots.push(rootDirectory);
  const store = new WorkspaceStore({ rootDirectory });
  stores.add(store);
  const person = store.createPerson({ displayName: '合成成员' });
  const source = store.putSourceObject({ bytes: Buffer.from('合成固定原件'), mediaType: 'image/png', displayName: '合成原件.png' });
  const { documentId } = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
  const quote = '合成项目甲 18.2 U/L';
  const box = { text: quote, confidence: 0.9, bounds: [0.1, 0.7, 0.7, 0.03] as [number, number, number, number] };
  const visualEvidence: SourceVisualEvidence = { version: 1, engine: 'apple-vision-local-v1',
    layoutVersion: 'local-visual-layout-v2', coordinateSystem: 'normalized-bottom-left',
    imageSize: { width: 1200, height: 1600 }, recognitionRevision: 3,
    reading: { mode: 'full_image', fallbackUsed: false },
    rows: [{ line: 1, text: quote, bounds: box.bounds, boxes: [box] }], omittedBoxes: [] };
  const manifest: SourceManifest = { id: randomUUID(), sourceObjectId: source.id, sha256: source.sha256,
    mediaType: 'image/png', originalDisplayName: '合成原件.png', totalUnits: 1, coveredUnitIndexes: [0],
    normalizerVersion: 'image-evidence-v1+local-visual-geometry-v1', conversionWarnings: [], createdAt: '2026-01-01T00:00:00Z',
    spans: [{ id: randomUUID(), documentId, spanKind: 'image', page: 1, blockId: 'local-vision-page-v3',
      lineStart: 1, lineEnd: 1, quote, readability: 'clear', visualEvidence }] };
  store.saveSourceManifest(manifest);
  return { store, source, documentId, person, manifest };
}

async function withRegion(f: ReturnType<typeof storeFixture>) {
  const read = await rereadLocalVisualRegion({ span: f.manifest.spans[0]!, image: { path: 'synthetic-only', page: 1 },
    lineStart: 1, lineEnd: 1, recognize: async () => ({ version: 1, engine: 'apple-vision-local-v1',
      imageSize: { width: 1200, height: 1600 }, recognitionRevision: 3,
      lines: f.manifest.spans[0]!.visualEvidence!.rows[0]!.boxes }) });
  expect(read.span).not.toBeNull();
  return { ...f.manifest, normalizerVersion: `${f.manifest.normalizerVersion}+local-visual-region-v1`,
    spans: [...f.manifest.spans, read.span!] };
}

describe('受控视觉来源持久化与历史保护', () => {
  it('几何、低评分遗漏框、版本与原件尺寸往返保存，不只保留quote', () => {
    const f = storeFixture();
    expect(f.store.getDocumentExtractionBundle(f.documentId).manifest).toEqual(f.manifest);
    const database = new Database(f.store.databasePath, { readonly: true });
    try {
      const row = database.prepare('SELECT visual_evidence_json FROM source_spans WHERE id=?')
        .get(f.manifest.spans[0]!.id) as { visual_evidence_json: string };
      expect(JSON.parse(row.visual_evidence_json)).toEqual(f.manifest.spans[0]!.visualEvidence);
      expect(Number(database.pragma('user_version', { simple: true }))).toBe(WORKSPACE_SCHEMA_VERSION);
    } finally { database.close(); }
  });

  it('schema40到41保留所有旧原文定位、原件和成员，仅增加可选几何与固定诊断表', () => {
    const f = storeFixture();
    const path = f.store.databasePath;
    const root = f.store.rootDirectory;
    const originalBytes = readFileSync(f.store.getDocumentExtractionBundle(f.documentId).sourcePath);
    f.store.close(); stores.delete(f.store);
    const old = new Database(path);
    old.exec(`ALTER TABLE source_spans DROP COLUMN visual_evidence_json;
      DROP TABLE extraction_repair_diagnostics;
      UPDATE workspaces SET schema_version=40; PRAGMA user_version=40;`);
    old.close();
    const migrated = new WorkspaceStore({ rootDirectory: root });
    stores.add(migrated);
    const bundle = migrated.getDocumentExtractionBundle(f.documentId);
    const { visualEvidence: _omitted, ...oldSpan } = f.manifest.spans[0]!;
    expect(bundle.manifest.spans).toEqual([oldSpan]);
    expect(readFileSync(bundle.sourcePath)).toEqual(originalBytes);
    expect(migrated.listPersons().map((person) => person.id)).toContain(f.person.id);
    const database = new Database(path, { readonly: true });
    try {
      expect(Number(database.pragma('user_version', { simple: true }))).toBe(WORKSPACE_SCHEMA_VERSION);
      expect(database.prepare("SELECT name FROM sqlite_master WHERE name='extraction_repair_diagnostics'").get()).toBeTruthy();
      expect(database.prepare('SELECT visual_evidence_json FROM source_spans WHERE id=?').get(oldSpan.id))
        .toEqual({ visual_evidence_json: null });
    } finally { database.close(); }
  });

  it('局部重读只追加同页辅助来源，不改变旧span、原件哈希和页覆盖', async () => {
    const f = storeFixture();
    const next = await withRegion(f);
    f.store.appendLocalVisualEvidenceForReprocessing(next);
    const current = f.store.getDocumentExtractionBundle(f.documentId).manifest;
    expect(current.spans).toEqual(next.spans);
    expect(current.spans[0]).toEqual(f.manifest.spans[0]);
    expect(current.sha256).toBe(f.manifest.sha256);
    expect(current.totalUnits).toBe(1);
    expect(current.coveredUnitIndexes).toEqual([0]);
    expect(f.store.getEvidenceAccess({ sourceSpanId: f.manifest.spans[0]!.id }).quote).toBe(f.manifest.spans[0]!.quote);
    f.store.appendLocalVisualEvidenceForReprocessing(current);
    expect(f.store.getDocumentExtractionBundle(f.documentId).manifest.spans).toHaveLength(2);
  });

  it('拒绝修改旧来源、串页、串hash与超范围区域，事务不留下半条来源', async () => {
    const f = storeFixture();
    const next = await withRegion(f);
    expect(() => f.store.appendLocalVisualEvidenceForReprocessing({ ...next,
      spans: [{ ...next.spans[0]!, quote: '被修改的旧转写' }, next.spans[1]!] })).toThrow('SOURCE_REGION_HISTORY_CHANGED');
    expect(() => f.store.appendLocalVisualEvidenceForReprocessing({ ...next,
      spans: [next.spans[0]!, { ...next.spans[1]!, page: 2 }] })).toThrow('SOURCE_REGION_SCOPE_INVALID');
    expect(() => f.store.appendLocalVisualEvidenceForReprocessing({ ...next, sha256: '0'.repeat(64) }))
      .toThrow('SOURCE_MANIFEST_REPROCESSING_SOURCE_MISMATCH');
    const area = next.spans[1]!.visualEvidence!;
    expect(() => f.store.appendLocalVisualEvidenceForReprocessing({ ...next,
      spans: [next.spans[0]!, { ...next.spans[1]!, visualEvidence: { ...area,
        reading: { ...area.reading, regionBounds: [0.1, 0.1, 0.7, 0.1] } } }] })).toThrow('SOURCE_REGION_SCOPE_INVALID');
    expect(f.store.getDocumentExtractionBundle(f.documentId).manifest).toEqual(f.manifest);
  });

  it('新规范化仅比较primary页定位，辅助region退出当前清单但历史引用仍保留', async () => {
    const f = storeFixture();
    const next = await withRegion(f);
    f.store.appendLocalVisualEvidenceForReprocessing(next);
    const regionId = next.spans[1]!.id;
    const quote = '合成项目甲 18.2 U/L\n合成新增位置';
    f.store.replaceSourceManifestForReprocessing({ ...f.manifest,
      normalizerVersion: `${f.manifest.normalizerVersion}+synthetic-renormalized`,
      spans: [{ ...f.manifest.spans[0]!, id: randomUUID(), quote }] });
    const current = f.store.getDocumentExtractionBundle(f.documentId).manifest;
    expect(current.spans).toHaveLength(1);
    expect(current.spans[0]!.quote).toBe(quote);
    expect(f.store.getEvidenceAccess({ sourceSpanId: regionId }).quote).toBe(next.spans[1]!.quote);
    expect(f.store.getEvidenceAccess({ sourceSpanId: f.manifest.spans[0]!.id }).quote).toBe(f.manifest.spans[0]!.quote);
    expect(current.sha256).toBe(f.manifest.sha256);
    expect(current.totalUnits).toBe(1);
  });

  it.each(['full_page', 'quote_mismatch', 'row_outside', 'box_outside', 'omitted_outside', 'line_sequence'] as const)(
    '局部写边界重新拒绝%s，不仅依赖上游helper作保证', async (kind) => {
      const f = storeFixture();
      const next = await withRegion(f);
      const region = next.spans[1]!;
      const original = region.visualEvidence!;
      const visual: SourceVisualEvidence = {
        ...original, reading: { ...original.reading },
        rows: original.rows.map((row) => ({ ...row, bounds: [...row.bounds],
          boxes: row.boxes.map((box) => ({ ...box, bounds: [...box.bounds] })) })),
        omittedBoxes: [...original.omittedBoxes]
      };
      let quote = region.quote;
      if (kind === 'full_page') visual.reading.regionBounds = [0, 0, 1, 1];
      if (kind === 'quote_mismatch') quote = '不对应新回执的合成文字';
      if (kind === 'row_outside') visual.rows[0]!.bounds = [0.8, 0.1, 0.1, 0.02];
      if (kind === 'box_outside') visual.rows[0]!.boxes[0]!.bounds = [0.8, 0.1, 0.1, 0.02];
      if (kind === 'omitted_outside') visual.omittedBoxes.push({ text: '合成未读清框', confidence: 0.1,
        bounds: [0.8, 0.1, 0.1, 0.02] });
      if (kind === 'line_sequence') visual.rows[0]!.line = 2;
      expect(() => f.store.appendLocalVisualEvidenceForReprocessing({ ...next,
        spans: [next.spans[0]!, { ...region, quote, visualEvidence: visual }] })).toThrow('SOURCE_REGION_SCOPE_INVALID');
      expect(f.store.getDocumentExtractionBundle(f.documentId).manifest).toEqual(f.manifest);
    });

  it('修复诊断只存固定字段、原因码和计数，额外正文路径忽略，非法信息拒绝', () => {
    const f = storeFixture();
    const diagnostic = { documentId: f.documentId, chunkIndex: 1,
      triggerCodes: ['numeric_value_not_in_evidence:synthetic-span', 'numeric_value_not_in_evidence:other-span'],
      targetCandidateCount: 2, missingSourceCount: 0, metadataTimeTargetCount: 1,
      outcome: 'applied' as const, remainingFailureCount: 1, acceptedCount: 1 };
    f.store.saveExtractionRepairDiagnostic({ ...diagnostic,
      rawModelText: '合成不应存储正文', localPath: '/synthetic/not-to-save' } as typeof diagnostic);
    const rows = f.store.listExtractionRepairDiagnostics({ documentId: f.documentId });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.diagnostic).toEqual({ chunkIndex: 1, targetCandidateCount: 2, missingSourceCount: 0,
      metadataTimeTargetCount: 1, outcome: 'applied', remainingFailureCount: 1, acceptedCount: 1,
      triggerCodes: ['numeric_value_not_in_evidence'] });
    expect(JSON.stringify(rows)).not.toMatch(/not-to-save|合成不应存储正文|synthetic-span|other-span/u);
    expect(() => f.store.saveExtractionRepairDiagnostic({ ...diagnostic, triggerCodes: ['/synthetic/private-path'] }))
      .toThrow('EXTRACTION_REPAIR_DIAGNOSTIC_INVALID');
    expect(() => f.store.saveExtractionRepairDiagnostic({ ...diagnostic, acceptedCount: -1 }))
      .toThrow('EXTRACTION_REPAIR_DIAGNOSTIC_INVALID');
    expect(() => f.store.listExtractionRepairDiagnostics({})).toThrow('EXTRACTION_REPAIR_DIAGNOSTIC_SCOPE_REQUIRED');
    expect(f.store.listExtractionRepairDiagnostics({ documentId: f.documentId })).toHaveLength(1);
  });
});
