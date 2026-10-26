import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sourceManifestSchema } from '@contracts';
import * as ingestion from './index.js';
import { DIRECT_ORIGINAL_NORMALIZER_VERSION, prepareDirectOriginalReport, prepareOriginalModelInput,
  prepareOriginalSource, type DirectOriginalSourceInput } from './direct-original-source.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function base(bytes: Uint8Array, displayName: string): DirectOriginalSourceInput {
  return { bytes, displayName, sha256: digest(bytes), documentId: 'synthetic-document',
    sourceObjectId: 'synthetic-source', createdAt: '2026-01-01T00:00:00Z' };
}
function outputRoot() {
  const path = mkdtempSync(join(tmpdir(), 'family-health-direct-test-'));
  roots.push(path);
  return path;
}

/** 纯合成 PDF：可包含文字、空白页和不同页面图形，不调用任何识别引擎。 */
function pdfFixture(pageCount: number, nativeText = false): Uint8Array {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, index) => `${3 + index * 2} 0 R`).join(' ')}] /Count ${pageCount} >>`];
  for (let page = 0; page < pageCount; page += 1) {
    const content = nativeText ? `BT /F1 12 Tf 10 130 Td (Synthetic original page ${page + 1}) Tj ET`
      : page % 2 === 0 ? `q 0 0 0 rg 10 ${20 + page} 30 12 re f Q` : '';
    const font = nativeText ? `/Resources << /Font << /F1 ${3 + pageCount * 2} 0 R >> >>` : '';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 120 160] ${font} /Contents ${4 + page * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  if (nativeText) objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(body, 'latin1');
}
async function docxFixture() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>合成全文</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>合成表格</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('原件完整模型输入的纯技术准备', () => {
  it('只生成未识别的逐页骨架，ID稳定且技术覆盖不代表文字已读', async () => {
    const input = base(pdfFixture(3), '合成.pdf');
    const first = await prepareOriginalSource(input);
    const second = await prepareOriginalSource({ ...input, createdAt: '2026-01-02T00:00:00Z' });
    expect(first.manifest.normalizerVersion).toBe(DIRECT_ORIGINAL_NORMALIZER_VERSION);
    expect(first.manifest.coveredUnitIndexes).toEqual([0, 1, 2]);
    expect(first.manifest.spans.map((span) => span.id)).toEqual(second.manifest.spans.map((span) => span.id));
    expect(first.manifest.spans.every((span, index) => span.quote === null && span.readability === 'unreadable'
      && span.spanKind === 'image' && span.page === index + 1 && span.blockId === `direct-original-page:${index + 1}`
      && span.visualEvidence === undefined && span.modelEvidence === undefined)).toBe(true);
    expect(first.manifest.sha256).toBe(input.sha256);
    expect(sourceManifestSchema.parse(first.manifest)).toEqual(first.manifest);
  });

  it('超过旧8图限制的PDF也完整渲染所有10页，不跳过空白页', async () => {
    const outputDirectory = outputRoot();
    const prepared = await prepareDirectOriginalReport({ ...base(pdfFixture(10), '全部十页.pdf'), outputDirectory });
    expect(prepared.imagePaths).toHaveLength(10);
    expect(prepared.unitMappings.map((unit) => unit.page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(prepared.imageMappings.every((image, index) => image.sourceSpanId === prepared.manifest.spans[index]!.id
      && existsSync(image.path) && digest(readFileSync(image.path)) === image.sha256)).toBe(true);
    expect(prepared.nativeText).toBeUndefined();
    expect(statSync(prepared.tempRoot).mode & 0o777).toBe(0o700);
    expect(statSync(prepared.imagePaths[0]!).mode & 0o777).toBe(0o600);
    await prepared.cleanup();
    expect(existsSync(prepared.tempRoot)).toBe(false);
    expect(existsSync(outputDirectory)).toBe(true);
  });

  it('文字型PDF也传完整原页图像，不把本机提取文本替代原件', async () => {
    const prepared = await prepareDirectOriginalReport({ ...base(pdfFixture(2, true), '文字型原件.pdf'), outputDirectory: outputRoot() });
    expect(prepared.imagePaths).toHaveLength(2);
    expect(prepared.nativeText).toBeUndefined();
    expect(prepared.manifest.spans.every((span) => span.quote === null && span.readability === 'unreadable')).toBe(true);
    expect(prepared.unitMappings.every((unit) => unit.inputKind === 'image')).toBe(true);
    await prepared.cleanup();
  });

  it('HEIC安全转换全部原始图像，没有本机识别文字', async () => {
    const bytes = Buffer.from('AAAAGGZ0eXBoZWljAAAAAGhlaWNtaWYxAAABr21ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAADnBpdG0AAAAAAAEAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABodmMxAAAAAQ9pcHJwAAAA7WlwY28AAAATY29scm5jbHgAAgACAAaAAAAADGNsbGkAywBAAAAAFGlzcGUAAAAAAAAABAAAAAQAAAAoY2xhcAAAAAQAAAABAAAAAwAAAAEAAAAAAAAAAf/AAAAAgAAAAAAACWlyb3QAAAAAEHBpeGkAAAAAAwgICAAAAHFodmNDAQNwAAAAsAAAAAAAHvAA/P34+AAACwOgAAEAF0ABDAH//wNwAAADALAAAAMAAAMAHnAkoQABACNCAQEDcAAAAwCwAAADAAADAB6gFCBBwJ8P4h7kWVTcCAgYAqIAAQAJRAHAYXLIRFNkAAAAGmlwbWEAAAAAAAAAAQABB4ECAwaHhIUAAAAeaWxvYwAAAABEAAABAAEAAAABAAAB1wAAAEUAAAABbWRhdAAAAAAAAABVAAAAQSgBr6NVGtO03irNKNGr+RnwN9dC8Tv/23M/eNx5+nP2EVvRH8i/PMqtZeesZ8bcpCYLQv/4eT5HcriCgCkb9vjb', 'base64');
    const prepared = await prepareDirectOriginalReport({ ...base(bytes, '合成颜色.heic'), outputDirectory: outputRoot() });
    expect(prepared.totalUnits).toBe(1);
    expect(prepared.imageMappings).toHaveLength(1);
    expect(prepared.imageMappings[0]).toMatchObject({ page: 1, mediaType: 'image/png', width: 4, height: 3 });
    expect(prepared.imageMappings[0]?.sha256).not.toBe(prepared.originalSha256);
    expect(prepared.manifest.spans[0]?.visualEvidence).toBeUndefined();
    await prepared.cleanup();
  });

  it.each(['png', 'jpeg'] as const)('%s保留原始像素文件字节，不做图像编辑或OCR', async (kind) => {
    const canvas = createCanvas(32, 48);
    const bytes = kind === 'png' ? canvas.toBuffer('image/png') : canvas.toBuffer('image/jpeg');
    const prepared = await prepareDirectOriginalReport({ ...base(bytes, kind === 'png' ? '原件.png' : '原件.jpg'), outputDirectory: outputRoot() });
    expect(readFileSync(prepared.imagePaths[0]!)).toEqual(bytes);
    expect(prepared.imageMappings[0]).toMatchObject({ width: 32, height: 48, sha256: digest(bytes), page: 1 });
    expect(prepared.manifest.spans[0]?.quote).toBeNull();
    await prepared.cleanup();
  });

  it('TXT完整保留空白行、比较符和全文，不切段也不把本机解码当识别事实', async () => {
    const text = '\r\n合成原文 <2.00E＋02\r\n\r\n' + '任意技术文字\n'.repeat(500) + '最后一行\r\n';
    const prepared = await prepareDirectOriginalReport({ ...base(Buffer.from(text), '完整.txt'), outputDirectory: outputRoot() });
    expect(prepared.nativeText).toBe(text);
    expect(prepared.totalUnits).toBe(1);
    expect(prepared.imagePaths).toEqual([]);
    expect(prepared.unitMappings).toEqual([{ page: 1, sourceSpanId: prepared.manifest.spans[0]!.id, inputKind: 'native_text' }]);
    expect(prepared.manifest.spans[0]?.quote).toBeNull();
    await prepared.cleanup();
  });

  it('不把本机解码乱码静默交给模型', async () => {
    await expect(prepareOriginalSource(base(Uint8Array.from([0x81, 0x81, 0x81]), '乱码.txt'))).rejects.toThrow();
  });

  it('DOCX缺完整转换能力时明确阻断，不降级为丢表格图片的文字视图', async () => {
    await expect(prepareOriginalSource(base(await docxFixture(), '原件.docx'))).rejects.toThrow('DOCX_ORIGINAL_VIEW_CONVERSION_REQUIRED');
  });

  it('DOCX用显式格式受控转换PDF并保留两个不同哈希、所有页', async () => {
    const original = await docxFixture();
    const pdf = pdfFixture(2);
    const convert = vi.fn(async () => ({ bytes: pdf, sha256: digest(pdf), mediaType: 'application/pdf' as const,
      converterId: 'libreoffice-headless' as const, converterVersion: 'synthetic-1', executableSha256: 'a'.repeat(64) }));
    const prepared = await prepareDirectOriginalReport({ ...base(original, '原件.docx'), legacyDocConverter: { convert }, outputDirectory: outputRoot() });
    expect(convert).toHaveBeenCalledExactlyOnceWith(original, 'docx');
    expect(prepared.originalSha256).toBe(digest(original));
    expect(prepared.convertedViewSha256).toBe(digest(pdf));
    expect(prepared.originalSha256).not.toBe(prepared.convertedViewSha256);
    expect(prepared.manifest.sha256).toBe(digest(original));
    expect(prepared.manifest.mediaType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(prepared.imagePaths).toHaveLength(2);
    expect(prepared.manifest.conversionWarnings).toContain('word_layout_may_differ_from_original');
    await prepared.cleanup();
  });

  it('转换视图哈希不一致不能冒充原件成功', async () => {
    await expect(prepareOriginalSource({ ...base(await docxFixture(), '原件.docx'), convertedPdf: {
      bytes: pdfFixture(1), sha256: '0'.repeat(64), mediaType: 'application/pdf', converterId: 'libreoffice-headless',
      converterVersion: 'synthetic-1', executableSha256: 'a'.repeat(64)
    } })).rejects.toThrow('CONVERTED_VIEW_HASH_MISMATCH');
  });

  it('不能给别的原件字节套用同一哈希', async () => {
    const input = base(pdfFixture(1), '原件.pdf');
    await expect(prepareOriginalSource({ ...input, sha256: '0'.repeat(64) })).rejects.toThrow('SOURCE_HASH_MISMATCH');
  });

  it('渲染返回缺页时显式失败并清理本次临时视图，不用已有页冒充完整报告', async () => {
    const { bundle } = await prepareOriginalSource(base(pdfFixture(2), '两页.pdf'));
    const outputDirectory = outputRoot();
    const render = vi.spyOn(ingestion, 'renderPdfPagesToPngs').mockResolvedValueOnce([]);
    try {
      await expect(prepareOriginalModelInput({ bundle, outputDirectory })).rejects.toThrow('DIRECT_ORIGINAL_PREPARATION_COVERAGE_INVALID');
      expect(readdirSync(outputDirectory)).toEqual([]);
    } finally { render.mockRestore(); }
  });

  it('已写部分原页后磁盘写满仍清理本次目录，保留调用者其他文件并原样抛出错误', async () => {
    const { bundle } = await prepareOriginalSource(base(pdfFixture(2), '合成写入失败.pdf'));
    const outputDirectory = outputRoot();
    const existing = join(outputDirectory, 'retain.txt');
    writeFileSync(existing, 'synthetic-retained');
    const full = Object.assign(new Error('synthetic write failure'), { code: 'ENOSPC' });
    const render = vi.spyOn(ingestion, 'renderPdfPagesToPngs').mockImplementationOnce(async (input) => {
      writeFileSync(join(input.outputDirectory, 'page-001.png'), 'synthetic-partial-page');
      throw full;
    });
    try {
      await expect(prepareOriginalModelInput({ bundle, outputDirectory })).rejects.toBe(full);
      expect(readdirSync(outputDirectory)).toEqual(['retain.txt']);
      expect(readFileSync(existing, 'utf8')).toBe('synthetic-retained');
    } finally { render.mockRestore(); }
  });

  it('准备目录不覆盖或清理用户已有文件', async () => {
    const outputDirectory = outputRoot();
    const existing = join(outputDirectory, 'page-001.png');
    writeFileSync(existing, 'retain');
    const prepared = await prepareDirectOriginalReport({ ...base(pdfFixture(1), '一页.pdf'), outputDirectory });
    await prepared.cleanup();
    expect(readFileSync(existing, 'utf8')).toBe('retain');
    expect(readdirSync(outputDirectory)).toEqual(['page-001.png']);
  });

  it('缺页、重复单元或附有旧OCR转写的骨架不能进入模型', async () => {
    const { bundle } = await prepareOriginalSource(base(pdfFixture(2), '两页.pdf'));
    const outputDirectory = outputRoot();
    await expect(prepareOriginalModelInput({ bundle: { ...bundle, manifest: { ...bundle.manifest,
      spans: bundle.manifest.spans.slice(0, 1) } }, outputDirectory })).rejects.toThrow('DIRECT_ORIGINAL_PREPARATION_COVERAGE_INVALID');
    await expect(prepareOriginalModelInput({ bundle: { ...bundle, manifest: { ...bundle.manifest,
      spans: [bundle.manifest.spans[0]!, bundle.manifest.spans[0]!] } }, outputDirectory })).rejects.toThrow('DIRECT_ORIGINAL_PREPARATION_COVERAGE_INVALID');
    await expect(prepareOriginalModelInput({ bundle: { ...bundle, manifest: { ...bundle.manifest,
      spans: bundle.manifest.spans.map((span) => ({ ...span, quote: '旧本机转写' })) } }, outputDirectory })).rejects.toThrow('DIRECT_ORIGINAL_PREPARATION_COVERAGE_INVALID');
    expect(readdirSync(outputDirectory)).toEqual([]);
  });

  it('不能替换bundle中的PDF页或原生文字后仍使用原哈希', async () => {
    const pdf = await prepareOriginalSource(base(pdfFixture(1), '一页.pdf'));
    await expect(prepareOriginalModelInput({ bundle: { ...pdf.bundle, pdfBytes: pdfFixture(2) } })).rejects.toThrow('DIRECT_ORIGINAL_BUNDLE_INVALID');
    const text = await prepareOriginalSource(base(Buffer.from('完整原生文字'), '原件.txt'));
    await expect(prepareOriginalModelInput({ bundle: { ...text.bundle, nativeText: '被替换文字' } })).rejects.toThrow('DIRECT_ORIGINAL_BUNDLE_INVALID');
  });
});
