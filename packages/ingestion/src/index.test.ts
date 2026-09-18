import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { assertImagePixelLimit, assertPathWithinRoot, assertSafeInboxDirectory, buildDocxManifest, buildHeicManifest, buildImageManifest, buildPdfManifest, buildTextManifest, decodeText, detectInput, isStableFile, readRasterDimensions, renderDocxImagesToFiles, renderHeicImagesToPngs, renderPdfPagesToPngs } from './index.js';

const temporary: string[] = [];
const require = createRequire(import.meta.url);

function mammothFixture(name: string): Buffer {
  return readFileSync(join(dirname(require.resolve('mammoth/package.json')), 'test', 'test-data', name));
}

function createMinimalPdf(text: string): Uint8Array {
  const escaped = text.replace(/[()\\]/g, (character) => `\\${character}`);
  const content = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(body, 'latin1');
}

function createScannedLikePdf(): Uint8Array {
  const content = 'q 0.95 0.95 0.95 rg 0 0 612 792 re f 0 0 0 rg 72 680 300 24 re f Q';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(body, 'latin1');
}

function createPngHeader(width: number, height: number): Uint8Array {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 2;
  return bytes;
}
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('格式和证据预处理', () => {
  it('拒绝伪装成 PDF 的可执行字节', async () => {
    await expect(detectInput('report.pdf', Buffer.from('#!/bin/sh\necho nope'))).rejects.toThrow('FILE_TYPE_UNKNOWN');
  });

  it('保留比较符、定性和未知的责任交给契约层，不把文本乱码静默入库', () => {
    expect(decodeText(Buffer.from('\uFEFF阴性\n<0.1'))).toMatchObject({ encoding: 'utf8-bom', warning: null });
    expect(() => decodeText(Uint8Array.from([0x81, 0x81, 0x81]))).toThrow('TEXT_ENCODING_CONFIRMATION_REQUIRED');
  });

  it('TXT 每一行都有可回溯 source span', () => {
    const manifest = buildTextManifest({
      sourceObjectId: 'source-1', documentId: 'doc-1', sha256: 'a'.repeat(64),
      displayName: '虚构.txt', text: '第一行\n第二行', createdAt: '2026-09-18T00:00:00Z'
    });
    expect(manifest.totalUnits).toBe(2);
    expect(manifest.coveredUnitIndexes).toEqual([0, 1]);
    expect(manifest.spans[1]?.lineStart).toBe(2);
  });

  it('TXT 规范化后超过单片段或片段数量预算时拒绝', () => {
    const base = {
      sourceObjectId: 'source-limit', documentId: 'doc-limit', sha256: 'c'.repeat(64),
      displayName: '超限.txt', createdAt: '2026-09-18T00:00:00Z'
    };
    expect(() => buildTextManifest({ ...base, text: 'x'.repeat(64 * 1024 + 1) }))
      .toThrow('NORMALIZED_SPAN_SIZE_LIMIT_EXCEEDED');
    expect(() => buildTextManifest({ ...base, text: Array.from({ length: 10_001 }, () => 'x').join('\n') }))
      .toThrow('NORMALIZED_SPAN_COUNT_LIMIT_EXCEEDED');
  });

  it('图片保留对象级证据定位，不伪造 OCR 文本', () => {
    const manifest = buildImageManifest({
      sourceObjectId: 'source-1', documentId: 'doc-1', sha256: 'b'.repeat(64),
      mediaType: 'image/png', displayName: '虚构.png', createdAt: '2026-09-18T00:00:00Z'
    });
    expect(manifest.spans[0]).toMatchObject({ spanKind: 'image', quote: null, readability: 'partial' });
    expect(manifest.conversionWarnings).toContain('visual_content_requires_model_review');
  });

  it('在保存前读取 PNG 像素尺寸并拒绝解压后超限的图片', async () => {
    const safe = createPngHeader(2_000, 2_000);
    expect(readRasterDimensions('png', safe)).toEqual({ width: 2_000, height: 2_000 });
    expect(assertImagePixelLimit('png', safe)).toEqual({ width: 2_000, height: 2_000 });
    await expect(detectInput('safe.png', safe)).resolves.toMatchObject({ kind: 'png' });

    const oversized = createPngHeader(10_000, 10_000);
    expect(() => assertImagePixelLimit('png', oversized)).toThrow('IMAGE_PIXEL_LIMIT_EXCEEDED');
    await expect(detectInput('oversized.png', oversized)).rejects.toThrow('IMAGE_PIXEL_LIMIT_EXCEEDED');
  });

  it('HEIC 使用锁定的本地解码器建立逐图证据并生成 PNG', async () => {
    const heic = Buffer.from('AAAAGGZ0eXBoZWljAAAAAGhlaWNtaWYxAAABr21ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAADnBpdG0AAAAAAAEAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABodmMxAAAAAQ9pcHJwAAAA7WlwY28AAAATY29scm5jbHgAAgACAAaAAAAADGNsbGkAywBAAAAAFGlzcGUAAAAAAAAABAAAAAQAAAAoY2xhcAAAAAQAAAABAAAAAwAAAAEAAAAAAAAAAf/AAAAAgAAAAAAACWlyb3QAAAAAEHBpeGkAAAAAAwgICAAAAHFodmNDAQNwAAAAsAAAAAAAHvAA/P34+AAACwOgAAEAF0ABDAH//wNwAAADALAAAAMAAAMAHnAkoQABACNCAQEDcAAAAwCwAAADAAADAB6gFCBBwJ8P4h7kWVTcCAgYAqIAAQAJRAHAYXLIRFNkAAAAGmlwbWEAAAAAAAAAAQABB4ECAwaHhIUAAAAeaWxvYwAAAABEAAABAAEAAAABAAAB1wAAAEUAAAABbWRhdAAAAAAAAABVAAAAQSgBr6NVGtO03irNKNGr+RnwN9dC8Tv/23M/eNx5+nP2EVvRH8i/PMqtZeesZ8bcpCYLQv/4eT5HcriCgCkb9vjb', 'base64');
    await expect(detectInput('fixture.heic', heic)).resolves.toMatchObject({ kind: 'heic', mediaType: 'image/heic' });
    const manifest = await buildHeicManifest({
      sourceObjectId: 'source-heic', documentId: 'doc-heic', sha256: 'e'.repeat(64), mediaType: 'image/heic',
      displayName: '纯合成色块.heic', bytes: heic, createdAt: '2026-09-18T00:00:00Z'
    });
    expect(manifest.spans).toHaveLength(1);
    expect(manifest.spans[0]).toMatchObject({ spanKind: 'image', page: 1, quote: null, readability: 'partial' });
    const root = mkdtempSync(join(tmpdir(), 'family-health-heic-'));
    temporary.push(root);
    const rendered = await renderHeicImagesToPngs({ bytes: heic, outputDirectory: join(root, 'images') });
    expect(rendered).toHaveLength(1);
    expect(readRasterDimensions('png', readFileSync(rendered[0]!.path))).toEqual({ width: 4, height: 3 });
  });

  it('DOCX 嵌入图建立独立 source span，并可在限额内解出供视觉核对', async () => {
    const bytes = mammothFixture('tiny-picture.docx');
    const manifest = await buildDocxManifest({
      sourceObjectId: 'source-docx', documentId: 'doc-docx', sha256: '9'.repeat(64),
      displayName: '含图虚构报告.docx', bytes, createdAt: '2026-09-18T00:00:00Z'
    });
    const imageSpan = manifest.spans.find((span) => span.spanKind === 'image');
    expect(imageSpan).toMatchObject({ blockId: 'image-1', page: null, quote: null, readability: 'partial' });
    expect(manifest.coveredUnitIndexes).toHaveLength(manifest.totalUnits);
    expect(manifest.conversionWarnings).toContain('docx_embedded_images_require_visual_review');

    const root = mkdtempSync(join(tmpdir(), 'family-health-docx-image-'));
    temporary.push(root);
    const rendered = await renderDocxImagesToFiles({ bytes, outputDirectory: join(root, 'images') });
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toMatchObject({ imageIndex: 1, mediaType: 'image/png' });
    expect(existsSync(rendered[0]!.path)).toBe(true);
  });

  it('DOCX 表格单元格保留结构化 block 定位且不伪造页码', async () => {
    const bytes = mammothFixture('tables.docx');
    const manifest = await buildDocxManifest({
      sourceObjectId: 'source-table', documentId: 'doc-table', sha256: '7'.repeat(64),
      displayName: '含表格虚构报告.docx', bytes, createdAt: '2026-09-18T00:00:00Z'
    });
    const tableCells = manifest.spans.filter((span) => span.spanKind === 'table_cell');
    expect(tableCells.length).toBeGreaterThan(0);
    expect(tableCells[0]).toMatchObject({ page: null, readability: 'clear' });
    expect(tableCells[0]!.blockId).toMatch(/^table-\d+-row-\d+-cell-\d+$/);
    expect(tableCells.every((span) => span.quote && span.quote.length > 0)).toBe(true);
  });

  it('DOCX 预检拒绝路径穿越、宏内容和过多解包条目', async () => {
    const cases: Array<{ expected: string; prepare(zip: JSZip): void }> = [
      { expected: 'DOCX_ENTRY_PATH_REJECTED', prepare: (zip) => { zip.file('../escape.xml', 'x'); } },
      { expected: 'DOCX_MACRO_CONTENT_REJECTED', prepare: (zip) => { zip.file('word/vbaProject.bin', 'macro'); } },
      { expected: 'DOCX_ENTRY_COUNT_LIMIT_EXCEEDED', prepare: (zip) => { for (let index = 0; index <= 2_000; index += 1) zip.file(`word/item-${index}.xml`, 'x'); } }
    ];
    for (const testCase of cases) {
      const zip = new JSZip();
      testCase.prepare(zip);
      const bytes = await zip.generateAsync({ type: 'nodebuffer' });
      await expect(buildDocxManifest({
        sourceObjectId: 'source-docx', documentId: 'doc-docx', sha256: '8'.repeat(64),
        displayName: '恶意.docx', bytes, createdAt: '2026-09-18T00:00:00Z'
      })).rejects.toThrow(testCase.expected);
    }
  });

  it('伪造的旧 DOC 复合文件不会被当成可读 Word 内容', async () => {
    const fakeDoc = Buffer.alloc(512);
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(fakeDoc);
    await expect(detectInput('伪造.doc', fakeDoc)).resolves.toMatchObject({ kind: 'doc' });
    const { buildLegacyDocManifest } = await import('./index.js');
    await expect(buildLegacyDocManifest({
      sourceObjectId: 'source-doc', documentId: 'doc-doc', sha256: 'f'.repeat(64),
      displayName: '伪造.doc', bytes: fakeDoc, createdAt: '2026-09-18T00:00:00Z'
    })).rejects.toThrow();
  });

  it('PDF 按页建立完整覆盖与原文证据', async () => {
    const bytes = createMinimalPdf('LDL 4.2 mmol/L');
    const manifest = await buildPdfManifest({
      sourceObjectId: 'source-pdf', documentId: 'doc-pdf', sha256: 'c'.repeat(64),
      displayName: '虚构.pdf', bytes, createdAt: '2026-09-18T00:00:00Z'
    });
    expect(manifest.totalUnits).toBe(1);
    expect(manifest.coveredUnitIndexes).toEqual([0]);
    expect(manifest.spans[0]).toMatchObject({ page: 1, readability: 'clear' });
    expect(manifest.spans[0]?.quote).toContain('LDL 4.2 mmol/L');
  });

  it('无文本层 PDF 可在像素上限内逐页渲染为受控 PNG', async () => {
    const bytes = createScannedLikePdf();
    const manifest = await buildPdfManifest({
      sourceObjectId: 'source-scan', documentId: 'doc-scan', sha256: 'd'.repeat(64),
      displayName: '扫描件.pdf', bytes, createdAt: '2026-09-18T00:00:00Z'
    });
    expect(manifest.spans[0]).toMatchObject({ page: 1, quote: null, readability: 'unreadable' });
    const root = mkdtempSync(join(tmpdir(), 'family-health-render-'));
    temporary.push(root);
    const rendered = await renderPdfPagesToPngs({ bytes, outputDirectory: join(root, 'pages'), pageNumbers: [1] });
    expect(rendered).toHaveLength(1);
    expect(rendered[0]!.width * rendered[0]!.height).toBeLessThanOrEqual(6_000_000);
    expect(existsSync(rendered[0]!.path)).toBe(true);
  });

  it('文件稳定性要求大小和修改时间均不再变化', () => {
    expect(isStableFile({ size: 10, mtimeMs: 1 }, { size: 10, mtimeMs: 1 }, 5_000)).toBe(true);
    expect(isStableFile({ size: 10, mtimeMs: 1 }, { size: 11, mtimeMs: 2 }, 5_000)).toBe(false);
  });
});

describe('路径边界', () => {
  it('拒绝越出授权根目录的对象路径', () => {
    const authorizedRoot = resolve(tmpdir(), 'safe', 'vault');
    const nestedPath = join(authorizedRoot, 'a', 'b');
    const outsidePath = resolve(tmpdir(), 'safe', 'other');
    expect(assertPathWithinRoot(authorizedRoot, nestedPath)).toBe(nestedPath);
    expect(() => assertPathWithinRoot(authorizedRoot, outsidePath)).toThrow('PATH_OUTSIDE_AUTHORIZED_ROOT');
  });

  it('拒绝与内部工作区重叠的收件箱和符号链接', () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-ingest-'));
    temporary.push(root);
    const workspace = join(root, 'workspace');
    const inbox = join(root, 'inbox');
    mkdirSync(workspace);
    mkdirSync(inbox);
    expect(assertSafeInboxDirectory(inbox, [workspace])).toBe(realpathSync(inbox));
    expect(() => assertSafeInboxDirectory(workspace, [workspace])).toThrow('INBOX_OVERLAPS_FORBIDDEN_ROOT');
    const link = join(root, 'link');
    symlinkSync(inbox, link);
    expect(() => assertSafeInboxDirectory(link, [workspace])).toThrow('INBOX_PATH_NOT_SAFE_DIRECTORY');
  });
});
