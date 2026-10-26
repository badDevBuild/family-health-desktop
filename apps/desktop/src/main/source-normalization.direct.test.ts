import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';
import { sourceManifestSchema } from '@contracts';
import { DIRECT_ORIGINAL_NORMALIZER_VERSION } from '@ingestion';
import { WorkspaceStore } from '@storage';
import { normalizeStoredSource } from './source-normalization.js';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function pdfBytes() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>'];
  const offsets = [0];
  let body = '%PDF-1.4\n';
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  return Buffer.from(`${body}xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
}
function input(bytes: Uint8Array, displayName: string) {
  const store = { getDocumentConvertedView: vi.fn<WorkspaceStore['getDocumentConvertedView']>(() => null),
    putSourceObject: vi.fn(() => ({ id: 'synthetic-converted' })), registerDocumentConversion: vi.fn() };
  return { documentId: 'synthetic-document', sourceObjectId: 'synthetic-original', bytes, sha256: hash(bytes),
    displayName, createdAt: '2026-01-01T00:00:00Z', store: store as unknown as WorkspaceStore, storeMock: store };
}
async function wordBytes(kind: 'doc' | 'docx'): Promise<Buffer> {
  if (kind === 'doc') {
    const bytes = Buffer.alloc(512);
    Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(bytes);
    return bytes;
  }
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>');
  return zip.generateAsync({ type: 'nodebuffer' });
}
function convertedView() {
  const bytes = pdfBytes();
  return { bytes, sha256: hash(bytes), mediaType: 'application/pdf' as const,
    converterId: 'libreoffice-headless' as const, converterVersion: 'synthetic-1', executableSha256: 'a'.repeat(64) };
}

describe('正式规范化默认只准备原件', () => {
  it('PDF全页骨架为未读取，无论页中能否本机抽到文字都不识别', async () => {
    const f = input(pdfBytes(), '完整.pdf');
    const recognize = vi.fn(() => { throw new Error('OCR_MUST_NOT_RUN'); });
    const result = await normalizeStoredSource({ ...f, localVisualRecognize: recognize });
    expect(result.normalizerVersion).toBe(DIRECT_ORIGINAL_NORMALIZER_VERSION);
    expect(result.totalUnits).toBe(2);
    expect(result.coveredUnitIndexes).toEqual([0, 1]);
    expect(result.spans.map((span) => [span.page, span.quote, span.readability])).toEqual([[1, null, 'unreadable'], [2, null, 'unreadable']]);
    expect(recognize).not.toHaveBeenCalled();
    expect(f.storeMock.putSourceObject).not.toHaveBeenCalled();
    expect(sourceManifestSchema.parse(result)).toEqual(result);
  });

  it('TXT不按行生成本机已读事实，仍由模型完整识别原生全文', async () => {
    const f = input(Buffer.from('合成完整原文\n\n最后一行'), '原件.txt');
    const result = await normalizeStoredSource(f);
    expect(result.totalUnits).toBe(1);
    expect(result.spans[0]).toMatchObject({ quote: null, readability: 'unreadable' });
    expect(result.sha256).toBe(hash(f.bytes));
  });

  it('转换视图通过正常存储接口登记，不偷换Word原件对象和哈希', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>');
    const original = await zip.generateAsync({ type: 'nodebuffer' });
    const f = input(original, '原始.docx');
    const pdf = pdfBytes();
    const convert = vi.fn(async () => ({ bytes: pdf, sha256: hash(pdf), mediaType: 'application/pdf' as const,
      converterId: 'libreoffice-headless' as const, converterVersion: 'synthetic-1', executableSha256: 'a'.repeat(64) }));
    const result = await normalizeStoredSource({ ...f, legacyDocConverter: { convert } });
    expect(convert).toHaveBeenCalledExactlyOnceWith(original, 'docx');
    expect(result.sourceObjectId).toBe('synthetic-original');
    expect(result.sha256).toBe(hash(original));
    expect(result.sha256).not.toBe(hash(pdf));
    expect(f.storeMock.putSourceObject).toHaveBeenCalledExactlyOnceWith({ bytes: pdf, mediaType: 'application/pdf', displayName: '原始.docx.converted.pdf' });
    expect(f.storeMock.registerDocumentConversion).toHaveBeenCalledExactlyOnceWith({ documentId: 'synthetic-document',
      convertedSourceObjectId: 'synthetic-converted', converterId: 'libreoffice-headless', converterVersion: 'synthetic-1',
      executableSha256: 'a'.repeat(64), warnings: ['word_layout_may_differ_from_original'] });
  });

  it.each(['doc', 'docx'] as const)('%s重复准备复用已保存完整PDF，不再次转换或登记，不替换原件', async (kind) => {
    const original = await wordBytes(kind);
    const before = Buffer.from(original);
    const f = input(original, `原始.${kind}`);
    const converted = convertedView();
    const convert = vi.fn(async () => converted);
    f.storeMock.registerDocumentConversion.mockImplementation(() => {
      f.storeMock.getDocumentConvertedView.mockReturnValue(converted);
    });
    const first = await normalizeStoredSource({ ...f, legacyDocConverter: { convert } });
    // 缓存已建立后，即使当前机器没有转换程序，也只重建技术骨架，保持转换证据原样。
    const second = await normalizeStoredSource({ ...f, legacyDocConverter: null });
    const third = await normalizeStoredSource({ ...f, legacyDocConverter: { convert } });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(first.totalUnits).toBe(2);
    expect(first.coveredUnitIndexes).toEqual([0, 1]);
    expect(first.spans.map((span) => [span.page, span.quote, span.readability]))
      .toEqual([[1, null, 'unreadable'], [2, null, 'unreadable']]);
    expect(first.sourceObjectId).toBe('synthetic-original');
    expect(first.sha256).toBe(hash(original));
    expect(first.sha256).not.toBe(converted.sha256);
    expect(first.mediaType).toBe(kind === 'doc' ? 'application/msword'
      : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(convert).toHaveBeenCalledExactlyOnceWith(original, kind);
    expect(f.storeMock.putSourceObject).toHaveBeenCalledTimes(1);
    expect(f.storeMock.registerDocumentConversion).toHaveBeenCalledTimes(1);
    expect(f.storeMock.getDocumentConvertedView).toHaveBeenCalledTimes(3);
    expect(f.storeMock.getDocumentConvertedView).toHaveBeenCalledWith(f.documentId);
    expect(original).toEqual(before);
  });

  it.each(['doc', 'docx'] as const)('%s在隔离真实存储中复用历史转换警告与完整页，不重复登记', async (kind) => {
    const rootDirectory = mkdtempSync(join(tmpdir(), 'family-health-cached-word-synthetic-'));
    const store = new WorkspaceStore({ rootDirectory });
    try {
      const original = await wordBytes(kind);
      const person = store.createPerson({ displayName: '合成成员' });
      const mediaType = kind === 'doc' ? 'application/msword'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      const source = store.putSourceObject({ bytes: original, mediaType, displayName: `合成原件.${kind}` });
      const { documentId } = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
      const view = convertedView();
      const converted = store.putSourceObject({ bytes: view.bytes, mediaType: view.mediaType, displayName: '合成转换.pdf' });
      store.registerDocumentConversion({ documentId, convertedSourceObjectId: converted.id, converterId: view.converterId,
        converterVersion: view.converterVersion, executableSha256: view.executableSha256,
        warnings: ['synthetic_historical_conversion_warning'] });
      const savedView = store.getDocumentConvertedView(documentId);
      const registration = vi.spyOn(store, 'registerDocumentConversion');
      const convert = vi.fn(async () => { throw new Error('REPEATED_CONVERSION_MUST_NOT_RUN'); });
      const prepare = { store, documentId, sourceObjectId: source.id, sha256: source.sha256,
        bytes: original, displayName: `合成原件.${kind}`, createdAt: '2026-01-01T00:00:00Z', legacyDocConverter: { convert } };
      const first = await normalizeStoredSource(prepare);
      const second = await normalizeStoredSource(prepare);
      expect(first).toEqual(second);
      expect(first).toMatchObject({ sourceObjectId: source.id, sha256: source.sha256, mediaType, totalUnits: 2,
        coveredUnitIndexes: [0, 1] });
      expect(first.spans.map((span) => span.page)).toEqual([1, 2]);
      expect(first.spans.every((span) => span.quote === null && span.readability === 'unreadable')).toBe(true);
      expect(store.getDocumentConvertedView(documentId)).toEqual(savedView);
      expect(store.getDocumentOriginalSource(documentId)).toMatchObject({ sourceObjectId: source.id, sha256: hash(original) });
      expect(registration).not.toHaveBeenCalled();
      expect(convert).not.toHaveBeenCalled();
    } finally { store.close(); rmSync(rootDirectory, { recursive: true, force: true }); }
  });

  it.each([
    { mediaType: 'text/plain' }, { converterId: 'uncontrolled-converter' },
    { converterVersion: ' ' }, { executableSha256: 'not-a-hash' }
  ])('缓存转换来源非法时明确失败，不重转换掩盖旧视图', async (invalid) => {
    const f = input(await wordBytes('docx'), '原始.docx');
    f.storeMock.getDocumentConvertedView.mockReturnValue({ ...convertedView(), ...invalid });
    const convert = vi.fn(async () => convertedView());
    await expect(normalizeStoredSource({ ...f, legacyDocConverter: { convert } }))
      .rejects.toThrow('DIRECT_ORIGINAL_CONVERTED_VIEW_INVALID');
    expect(convert).not.toHaveBeenCalled();
    expect(f.storeMock.putSourceObject).not.toHaveBeenCalled();
    expect(f.storeMock.registerDocumentConversion).not.toHaveBeenCalled();
  });

  it('缓存PDF哈希不符或getter核验失败都不回退重新转换，不偷换原件哈希', async () => {
    const f = input(await wordBytes('docx'), '原始.docx');
    const convert = vi.fn(async () => convertedView());
    f.storeMock.getDocumentConvertedView.mockReturnValue({ ...convertedView(), sha256: '0'.repeat(64) });
    await expect(normalizeStoredSource({ ...f, legacyDocConverter: { convert } }))
      .rejects.toThrow('CONVERTED_VIEW_HASH_MISMATCH');
    f.storeMock.getDocumentConvertedView.mockImplementation(() => { throw new Error('CONVERTED_SOURCE_VIEW_INVALID'); });
    await expect(normalizeStoredSource({ ...f, legacyDocConverter: { convert } }))
      .rejects.toThrow('CONVERTED_SOURCE_VIEW_INVALID');
    f.storeMock.getDocumentConvertedView.mockReturnValue(convertedView());
    await expect(normalizeStoredSource({ ...f, sha256: '0'.repeat(64), legacyDocConverter: { convert } }))
      .rejects.toThrow('SOURCE_HASH_MISMATCH');
    expect(convert).not.toHaveBeenCalled();
    expect(f.storeMock.putSourceObject).not.toHaveBeenCalled();
    expect(f.storeMock.registerDocumentConversion).not.toHaveBeenCalled();
  });
});
