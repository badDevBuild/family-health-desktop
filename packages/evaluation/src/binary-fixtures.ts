import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PDFDocument, createCanvas } from '@napi-rs/canvas';
import JSZip from 'jszip';
import type { GoldFormat, SyntheticGoldCase, SyntheticGoldDataset } from './index.js';

const FIXED_ZIP_DATE = new Date('2026-09-17T00:00:00.000Z');

interface DrawContext {
  fillStyle: string | object;
  font: string;
  fillRect(x: number, y: number, width: number, height: number): void;
  fillText(text: string, x: number, y: number): void;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
}

export interface BinaryFixtureReceipt {
  caseId: string;
  format: GoldFormat;
  fileName: string;
  byteLength: number;
  sha256: string;
  signature: string;
}

export interface BinaryFixtureManifest {
  version: string;
  syntheticOnly: true;
  rendererPlatform: NodeJS.Platform;
  files: BinaryFixtureReceipt[];
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function xmlEscape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function fixtureTitle(testCase: SyntheticGoldCase): string {
  return `纯合成健康资料 ${testCase.id}`;
}

function fixtureLines(testCase: SyntheticGoldCase): string[] {
  return [
    fixtureTitle(testCase),
    `成员：${testCase.memberKey}（虚构）`,
    `就诊：${testCase.encounterKey}`,
    `特征：${testCase.features.join(' / ')}`,
    ...testCase.fields.map((field) => `[${field.sourceSpanId}] ${field.sourceText}`)
  ];
}

function drawHeader(context: DrawContext, testCase: SyntheticGoldCase, width: number): number {
  context.fillStyle = '#f8faf7';
  context.fillRect(0, 0, width, 126);
  context.fillStyle = '#214a3a';
  context.font = 'bold 28px sans-serif';
  context.fillText(fixtureTitle(testCase), 42, 48);
  context.fillStyle = '#52645b';
  context.font = '16px sans-serif';
  context.fillText(`成员 ${testCase.memberKey} · 纯合成测试资料`, 42, 82);
  context.fillText(`特征 ${testCase.features.join(' / ')}`, 42, 108);
  return 154;
}

function drawFields(context: DrawContext, testCase: SyntheticGoldCase, width: number, startY: number, fieldIndexes: number[]): void {
  context.font = '17px sans-serif';
  let y = startY;
  for (const fieldIndex of fieldIndexes) {
    const field = testCase.fields[fieldIndex]!;
    const rowHeight = 52;
    context.fillStyle = field.readable ? (fieldIndex % 2 === 0 ? '#ffffff' : '#f5f7f4') : '#e4e5e2';
    context.fillRect(32, y - 30, width - 64, rowHeight - 4);
    context.fillStyle = field.readable ? '#27312c' : '#767d79';
    const text = field.readable ? field.sourceText : `${field.sourceText}（应标记未知，不得猜测）`;
    context.fillText(text.slice(0, 72), 48, y);
    context.fillStyle = '#728078';
    context.font = '12px sans-serif';
    context.fillText(field.sourceSpanId, 48, y + 19);
    context.font = '17px sans-serif';
    y += rowHeight;
  }
}

function renderRaster(testCase: SyntheticGoldCase, format: 'png' | 'jpeg'): Buffer {
  const width = 1280;
  const height = 1640;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#fffefb';
  context.fillRect(0, 0, width, height);
  const startY = drawHeader(context, testCase, width);
  drawFields(context, testCase, width, startY, testCase.fields.map((_, index) => index));
  if (testCase.features.includes('rotated_image')) {
    context.save();
    context.translate(width - 100, height - 80);
    context.rotate(-Math.PI / 18);
    context.fillStyle = '#8b5e3c';
    context.font = '14px sans-serif';
    context.fillText('方向测试标记', -100, 0);
    context.restore();
  }
  return format === 'jpeg' ? canvas.encodeSync('jpeg', 92) : canvas.encodeSync('png');
}

function renderPdf(testCase: SyntheticGoldCase): Buffer {
  const document = new PDFDocument({
    title: fixtureTitle(testCase),
    author: 'Family Health Synthetic Fixture Generator',
    creator: 'family-health-desktop',
    producer: 'Skia/PDF',
    compressionLevel: 9
  });
  for (let page = 1; page <= 3; page += 1) {
    const context = document.beginPage(595, 842);
    context.fillStyle = '#fffefb';
    context.fillRect(0, 0, 595, 842);
    const startY = drawHeader(context, testCase, 595);
    context.fillStyle = '#52645b';
    context.font = '12px sans-serif';
    context.fillText(`第 ${page} / 3 页`, 500, 32);
    const indexes = testCase.fields.map((_, index) => index).filter((index) => testCase.fields[index]!.sourcePage === page);
    drawFields(context, testCase, 595, startY, indexes);
    document.endPage();
  }
  return document.close();
}

function docxParagraph(text: string, style = ''): string {
  return `<w:p>${style}<w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
}

async function renderDocx(testCase: SyntheticGoldCase): Promise<Buffer> {
  const zip = new JSZip();
  const zipOptions = { date: FIXED_ZIP_DATE };
  const preview = renderRaster(testCase, 'png');
  const rows = testCase.fields.map((field) => `<w:tr><w:tc>${docxParagraph(field.sourceSpanId)}</w:tc><w:tc>${docxParagraph(field.sourceText)}</w:tc></w:tr>`).join('');
  const drawing = '<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="3657600" cy="4686300"/><wp:docPr id="1" name="synthetic-preview.png"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="synthetic-preview.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="3657600" cy="4686300"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>', zipOptions);
  zip.folder('_rels')!.file('.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>', zipOptions);
  zip.folder('word')!.file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${docxParagraph(fixtureTitle(testCase))}${docxParagraph(`成员：${testCase.memberKey}（虚构）`)}<w:tbl>${rows}</w:tbl>${drawing}<w:sectPr/></w:body></w:document>`, zipOptions);
  zip.folder('word')!.folder('_rels')!.file('document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/synthetic-preview.png"/></Relationships>', zipOptions);
  zip.folder('word')!.folder('media')!.file('synthetic-preview.png', preview, zipOptions);
  for (const entry of Object.values(zip.files)) entry.date = FIXED_ZIP_DATE;
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 }, platform: 'UNIX' });
}

function writeLegacyDoc(testCase: SyntheticGoldCase, targetPath: string): void {
  if (process.platform !== 'darwin') throw new Error('GOLD_DOC_RENDERER_UNAVAILABLE');
  const sourcePath = `${targetPath}.source.txt`;
  writeFileSync(sourcePath, `${fixtureLines(testCase).join('\n')}\n`, { mode: 0o600 });
  try {
    execFileSync('/usr/bin/textutil', [
      '-convert', 'doc', '-format', 'txt', '-output', targetPath,
      '-title', fixtureTitle(testCase), '-author', 'Family Health Synthetic Fixture Generator',
      '-creationtime', '2026-09-17T00:00:00Z', '-modificationtime', '2026-09-17T00:00:00Z',
      '--', sourcePath
    ], { stdio: 'pipe' });
  } finally {
    rmSync(sourcePath, { force: true });
  }
}

function writeHeic(testCase: SyntheticGoldCase, targetPath: string): void {
  if (process.platform !== 'darwin') throw new Error('GOLD_HEIC_RENDERER_UNAVAILABLE');
  const sourcePath = `${targetPath}.source.png`;
  writeFileSync(sourcePath, renderRaster(testCase, 'png'), { mode: 0o600 });
  try {
    execFileSync('/usr/bin/sips', ['-s', 'format', 'heic', sourcePath, '--out', targetPath], { stdio: 'pipe' });
  } finally {
    rmSync(sourcePath, { force: true });
  }
}

function signatureFor(format: GoldFormat, value: Buffer): string {
  if (format === 'pdf' && value.subarray(0, 5).toString('ascii') === '%PDF-') return 'pdf';
  if (format === 'jpeg' && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff) return 'jpeg';
  if (format === 'png' && value.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (format === 'heic' && value.subarray(4, 8).toString('ascii') === 'ftyp') return 'heif-container';
  if (format === 'docx' && value[0] === 0x50 && value[1] === 0x4b) return 'zip-ooxml';
  if (format === 'doc' && value.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return 'ole-cfb';
  if (format === 'txt' && !value.includes(0)) return 'utf8-text';
  throw new Error(`GOLD_FIXTURE_SIGNATURE_INVALID:${format}`);
}

async function writeFixture(testCase: SyntheticGoldCase, targetPath: string): Promise<void> {
  switch (testCase.formatTarget) {
    case 'pdf': writeFileSync(targetPath, renderPdf(testCase), { mode: 0o600 }); break;
    case 'jpeg': writeFileSync(targetPath, renderRaster(testCase, 'jpeg'), { mode: 0o600 }); break;
    case 'png': writeFileSync(targetPath, renderRaster(testCase, 'png'), { mode: 0o600 }); break;
    case 'heic': writeHeic(testCase, targetPath); break;
    case 'docx': writeFileSync(targetPath, await renderDocx(testCase), { mode: 0o600 }); break;
    case 'doc': writeLegacyDoc(testCase, targetPath); break;
    case 'txt': writeFileSync(targetPath, `${fixtureLines(testCase).join('\n')}\n`, { mode: 0o600 }); break;
  }
}

export async function materializeSyntheticBinaryFixtures(dataset: SyntheticGoldDataset, rootDirectory: string): Promise<BinaryFixtureManifest> {
  const fixturesDirectory = join(rootDirectory, 'fixtures');
  mkdirSync(fixturesDirectory, { recursive: true, mode: 0o700 });
  const files: BinaryFixtureReceipt[] = [];
  for (const testCase of dataset.cases) {
    const extension = testCase.formatTarget === 'jpeg' ? 'jpg' : testCase.formatTarget;
    const targetPath = join(fixturesDirectory, `${testCase.id}.${extension}`);
    await writeFixture(testCase, targetPath);
    const value = readFileSync(targetPath);
    files.push({
      caseId: testCase.id,
      format: testCase.formatTarget,
      fileName: basename(targetPath),
      byteLength: value.byteLength,
      sha256: sha256(value),
      signature: signatureFor(testCase.formatTarget, value)
    });
  }
  const manifest: BinaryFixtureManifest = {
    version: dataset.version,
    syntheticOnly: true,
    rendererPlatform: process.platform,
    files
  };
  writeFileSync(join(rootDirectory, 'fixtures-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}
