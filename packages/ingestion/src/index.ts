import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { fileTypeFromBuffer } from 'file-type';
import iconv from 'iconv-lite';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { SourceManifest, SourceSpan } from '@contracts';

export * from './legacy-doc-converter.js';

const require = createRequire(import.meta.url);
// pdf.js 要求资源根路径以正斜杠结尾；Node 的本地文件读取在 Windows
// 同样接受正斜杠路径，因此这里保留文件系统路径而不是转换成 file:// URL。
const pdfStandardFontsPath = `${join(
  dirname(require.resolve('pdfjs-dist/package.json')),
  'standard_fonts'
).replaceAll('\\', '/')}/`;

export const INGESTION_LIMITS = {
  maxFileBytes: 100 * 1024 * 1024,
  maxBatchFiles: 100,
  maxPdfPages: 200,
  maxRenderedPdfPagePixels: 6_000_000,
  maxHeicImages: 20,
  maxHeicTotalPixels: 160_000_000,
  maxImagePixels: 80_000_000,
  maxDocxEntries: 2_000,
  maxDocxUncompressedBytes: 256 * 1024 * 1024,
  maxDocxImages: 50,
  maxDocxImageBytes: 25 * 1024 * 1024,
  maxNormalizedTextBytes: 8 * 1024 * 1024,
  maxSourceSpans: 10_000,
  maxSpanQuoteBytes: 64 * 1024,
  maxSourcePackageBytes: 256 * 1024,
  maxSpansPerTurn: 40,
  maxVisualPagesPerTurn: 8,
  stableForMs: 5_000
} as const;

function assertNormalizedTextBudget(values: string[]): void {
  if (values.length > INGESTION_LIMITS.maxSourceSpans) throw new Error('NORMALIZED_SPAN_COUNT_LIMIT_EXCEEDED');
  let totalBytes = 0;
  for (const value of values) {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > INGESTION_LIMITS.maxSpanQuoteBytes) throw new Error('NORMALIZED_SPAN_SIZE_LIMIT_EXCEEDED');
    totalBytes += bytes;
    if (totalBytes > INGESTION_LIMITS.maxNormalizedTextBytes) throw new Error('NORMALIZED_TEXT_LIMIT_EXCEEDED');
  }
}

export interface RenderedPdfPage {
  page: number;
  path: string;
  width: number;
  height: number;
}

export interface RenderedHeicImage {
  imageIndex: number;
  path: string;
  width: number;
  height: number;
}

export interface RenderedDocxImage {
  imageIndex: number;
  path: string;
  mediaType: 'image/png' | 'image/jpeg';
}

interface DocxEmbeddedImage {
  imageIndex: number;
  bytes: Buffer;
  mediaType: string;
  supported: boolean;
}

interface DocxTextUnit {
  spanKind: 'block' | 'table_cell';
  blockId: string;
  text: string;
}

interface ZipObjectWithCompressedMetadata extends JSZip.JSZipObject {
  _data?: { uncompressedSize?: number };
}

interface HeifDecodedImage {
  get_width(): number;
  get_height(): number;
  display(target: { data: Uint8ClampedArray; width: number; height: number }, callback: (result: unknown) => void): void;
  free(): void;
}

interface HeifModule {
  HeifDecoder: new () => { decode(bytes: Uint8Array): HeifDecodedImage[] };
}

interface LegacyWordDocument {
  getBody(): string;
  getHeaders(options?: { includeFooters?: boolean }): string;
  getFooters(): string;
  getFootnotes(): string;
  getEndnotes(): string;
  getAnnotations(): string;
  getTextboxes(options?: { includeHeadersAndFooters?: boolean; includeBody?: boolean }): string;
}

interface LegacyWordExtractor {
  extract(source: Buffer): Promise<LegacyWordDocument>;
}

export type SupportedKind = 'pdf' | 'jpeg' | 'png' | 'heic' | 'docx' | 'doc' | 'txt';

export interface DetectedInput {
  kind: SupportedKind;
  mediaType: string;
  extension: string;
  bytes: Uint8Array;
  sha256: string;
}

const extensionKinds: Record<string, SupportedKind | 'unsupported'> = {
  '.pdf': 'pdf', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.png': 'png',
  '.heic': 'heic', '.heif': 'heic', '.docx': 'docx', '.doc': 'doc', '.txt': 'txt',
  '.docm': 'unsupported', '.dcm': 'unsupported', '.html': 'unsupported', '.htm': 'unsupported'
};

const detectedKindByMime: Record<string, SupportedKind | undefined> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/heif': 'heic',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc'
};

export async function detectInput(displayName: string, bytes: Uint8Array): Promise<DetectedInput> {
  if (bytes.byteLength === 0) throw new Error('FILE_EMPTY');
  if (bytes.byteLength > INGESTION_LIMITS.maxFileBytes) throw new Error('INPUT_LIMIT_EXCEEDED');
  const extension = extname(displayName).toLowerCase();
  const expectedKind = extensionKinds[extension];
  if (!expectedKind || expectedKind === 'unsupported') throw new Error('UNSUPPORTED_FORMAT');

  const detected = await fileTypeFromBuffer(bytes);
  let detectedKind = detected ? detectedKindByMime[detected.mime] : undefined;
  if (!detectedKind && expectedKind === 'txt' && looksLikeText(bytes)) detectedKind = 'txt';
  if (!detectedKind && expectedKind === 'doc' && hasCompoundFileBinarySignature(bytes)) detectedKind = 'doc';
  if (!detectedKind) throw new Error('FILE_TYPE_UNKNOWN');
  if (detectedKind !== expectedKind) throw new Error('FILE_TYPE_MISMATCH');
  if (detectedKind === 'jpeg' || detectedKind === 'png') assertImagePixelLimit(detectedKind, bytes);

  return {
    kind: detectedKind,
    mediaType: detectedKind === 'doc' ? 'application/msword' : detected?.mime ?? 'text/plain',
    extension,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex')
  };
}

function openValidatedHeic(bytes: Uint8Array): {
  decoder: { decode(bytes: Uint8Array): HeifDecodedImage[] };
  images: HeifDecodedImage[];
  metadata: Array<{ imageIndex: number; width: number; height: number }>;
} {
  const libheif = require('libheif-js') as HeifModule;
  const decoder = new libheif.HeifDecoder();
  const images = decoder.decode(Uint8Array.from(bytes));
  if (images.length === 0) throw new Error('HEIC_DECODE_FAILED');
  try {
    if (images.length > INGESTION_LIMITS.maxHeicImages) throw new Error('HEIC_IMAGE_COUNT_LIMIT_EXCEEDED');
    let totalPixels = 0;
    const metadata = images.map((image, index) => {
      const width = image.get_width();
      const height = image.get_height();
      const pixels = width * height;
      if (!Number.isSafeInteger(pixels) || width <= 0 || height <= 0) throw new Error('IMAGE_DIMENSIONS_UNAVAILABLE');
      if (pixels > INGESTION_LIMITS.maxImagePixels) throw new Error('IMAGE_PIXEL_LIMIT_EXCEEDED');
      totalPixels += pixels;
      if (totalPixels > INGESTION_LIMITS.maxHeicTotalPixels) throw new Error('HEIC_TOTAL_PIXEL_LIMIT_EXCEEDED');
      return { imageIndex: index + 1, width, height };
    });
    return { decoder, images, metadata };
  } catch (error) {
    for (const image of images) image.free();
    throw error;
  }
}

function inspectHeicImages(bytes: Uint8Array): Array<{ imageIndex: number; width: number; height: number }> {
  const opened = openValidatedHeic(bytes);
  try {
    return opened.metadata;
  } finally {
    for (const image of opened.images) image.free();
  }
}

export async function renderHeicImagesToPngs(input: {
  bytes: Uint8Array;
  outputDirectory: string;
  imageIndexes?: number[];
}): Promise<RenderedHeicImage[]> {
  mkdirSync(input.outputDirectory, { recursive: true, mode: 0o700 });
  const selected = input.imageIndexes ? new Set(input.imageIndexes) : null;
  const metadata = inspectHeicImages(input.bytes);
  if (selected && [...selected].some((index) => !Number.isInteger(index) || index < 1 || index > metadata.length)) {
    throw new Error('HEIC_IMAGE_INDEX_INVALID');
  }
  const opened = openValidatedHeic(input.bytes);
  const rendered: RenderedHeicImage[] = [];
  try {
    for (const [index, image] of opened.images.entries()) {
      const frame = opened.metadata[index]!;
      if (selected && !selected.has(frame.imageIndex)) continue;
      const rgba = new Uint8ClampedArray(frame.width * frame.height * 4);
      await new Promise<void>((resolvePromise, rejectPromise) => {
        image.display({ data: rgba, width: frame.width, height: frame.height }, (result) => {
          if (!result) rejectPromise(new Error('HEIC_DECODE_FAILED'));
          else resolvePromise();
        });
      });
      const canvas = createCanvas(frame.width, frame.height);
      const context = canvas.getContext('2d');
      const imageData = context.createImageData(frame.width, frame.height);
      imageData.data.set(rgba);
      context.putImageData(imageData, 0, 0);
      const path = join(input.outputDirectory, `image-${String(frame.imageIndex).padStart(3, '0')}.png`);
      writeFileSync(path, canvas.toBuffer('image/png'), { mode: 0o600 });
      rendered.push({ imageIndex: frame.imageIndex, path, width: frame.width, height: frame.height });
    }
  } finally {
    for (const image of opened.images) image.free();
  }
  return rendered;
}

export function readRasterDimensions(kind: 'jpeg' | 'png', bytes: Uint8Array): { width: number; height: number } {
  if (kind === 'png') {
    if (bytes.byteLength < 24) throw new Error('IMAGE_DIMENSIONS_UNAVAILABLE');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    if (width === 0 || height === 0) throw new Error('IMAGE_DIMENSIONS_UNAVAILABLE');
    return { width, height };
  }

  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('IMAGE_DIMENSIONS_UNAVAILABLE');
  const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 3 < bytes.byteLength) {
    while (offset < bytes.byteLength && bytes[offset] !== 0xff) offset += 1;
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) break;
    const marker = bytes[offset]!;
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.byteLength) break;
    const segmentLength = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) throw new Error('IMAGE_DIMENSIONS_UNAVAILABLE');
    if (sofMarkers.has(marker)) {
      if (segmentLength < 7) throw new Error('IMAGE_DIMENSIONS_UNAVAILABLE');
      const height = (bytes[offset + 3]! << 8) | bytes[offset + 4]!;
      const width = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      if (width === 0 || height === 0) throw new Error('IMAGE_DIMENSIONS_UNAVAILABLE');
      return { width, height };
    }
    offset += segmentLength;
  }
  throw new Error('IMAGE_DIMENSIONS_UNAVAILABLE');
}

export function assertImagePixelLimit(kind: 'jpeg' | 'png', bytes: Uint8Array): { width: number; height: number } {
  const dimensions = readRasterDimensions(kind, bytes);
  if (dimensions.width * dimensions.height > INGESTION_LIMITS.maxImagePixels) {
    throw new Error('IMAGE_PIXEL_LIMIT_EXCEEDED');
  }
  return dimensions;
}

export function assertSafeInboxDirectory(candidatePath: string, forbiddenRoots: string[]): string {
  if (!isAbsolute(candidatePath)) throw new Error('INBOX_PATH_MUST_BE_ABSOLUTE');
  const stat = lstatSync(candidatePath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('INBOX_PATH_NOT_SAFE_DIRECTORY');
  const canonical = realpathSync(candidatePath);
  for (const root of forbiddenRoots.map((path) => realpathSync(path))) {
    const fromRoot = relative(root, canonical);
    const fromCandidate = relative(canonical, root);
    const insideRoot = fromRoot === '' || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== '..' && !isAbsolute(fromRoot));
    const containsRoot = fromCandidate === '' || (!fromCandidate.startsWith(`..${sep}`) && fromCandidate !== '..' && !isAbsolute(fromCandidate));
    if (insideRoot || containsRoot) throw new Error('INBOX_OVERLAPS_FORBIDDEN_ROOT');
  }
  return canonical;
}

export function isStableFile(before: { size: number; mtimeMs: number }, after: { size: number; mtimeMs: number }, elapsedMs: number): boolean {
  return elapsedMs >= INGESTION_LIMITS.stableForMs && before.size === after.size && before.mtimeMs === after.mtimeMs;
}

export function decodeText(bytes: Uint8Array, encodingHint?: string): { text: string; encoding: string; warning: string | null } {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: iconv.decode(Buffer.from(bytes.slice(3)), 'utf8'), encoding: 'utf8-bom', warning: null };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: iconv.decode(Buffer.from(bytes.slice(2)), 'utf16-le'), encoding: 'utf16-le', warning: null };
  }
  if (encodingHint) {
    if (!iconv.encodingExists(encodingHint)) throw new Error('TEXT_ENCODING_UNSUPPORTED');
    return { text: iconv.decode(Buffer.from(bytes), encodingHint), encoding: encodingHint, warning: 'encoding_selected_by_user' };
  }
  const utf8 = iconv.decode(Buffer.from(bytes), 'utf8');
  if (utf8.includes('\uFFFD')) throw new Error('TEXT_ENCODING_CONFIRMATION_REQUIRED');
  return { text: utf8, encoding: 'utf8', warning: null };
}

export function buildTextManifest(input: {
  sourceObjectId: string;
  documentId: string;
  sha256: string;
  displayName: string;
  text: string;
  createdAt: string;
}): SourceManifest {
  const lines = input.text.split(/\r?\n/)
    .map((line, index) => ({ line, sourceLine: index + 1 }))
    .filter(({ line }) => line.trim().length > 0);
  if (lines.length === 0) throw new Error('TEXT_HAS_NO_CONTENT');
  assertNormalizedTextBudget(lines.map(({ line }) => line));
  const spans: SourceSpan[] = lines.map(({ line, sourceLine }) => ({
    id: randomUUID(),
    documentId: input.documentId,
    spanKind: 'line',
    page: null,
    blockId: null,
    lineStart: sourceLine,
    lineEnd: sourceLine,
    quote: line,
    readability: 'clear'
  }));
  return {
    id: randomUUID(),
    sourceObjectId: input.sourceObjectId,
    sha256: input.sha256,
    mediaType: 'text/plain',
    originalDisplayName: basename(input.displayName),
    totalUnits: lines.length,
    coveredUnitIndexes: Array.from({ length: lines.length }, (_, index) => index),
    spans,
    normalizerVersion: 'txt-v2',
    conversionWarnings: [],
    createdAt: input.createdAt
  };
}

export async function extractDocxBlocks(bytes: Uint8Array): Promise<{ blocks: string[]; warnings: string[] }> {
  const content = await extractDocxContent(bytes);
  return {
    blocks: content.textUnits.map((unit) => unit.text),
    warnings: content.warnings
  };
}

function unsafeArchivePath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  return normalized.startsWith('/') || normalized.split('/').some((part) => part === '..');
}

async function assertSafeDocxArchive(bytes: Uint8Array): Promise<void> {
  const archive = await JSZip.loadAsync(Buffer.from(bytes), { createFolders: false });
  const entries = Object.values(archive.files).filter((entry) => !entry.dir);
  if (entries.length > INGESTION_LIMITS.maxDocxEntries) throw new Error('DOCX_ENTRY_COUNT_LIMIT_EXCEEDED');
  let uncompressedBytes = 0;
  let imageCount = 0;
  for (const entry of entries) {
    const originalName = entry.unsafeOriginalName ?? entry.name;
    if (unsafeArchivePath(originalName)) throw new Error('DOCX_ENTRY_PATH_REJECTED');
    const normalized = entry.name.replaceAll('\\', '/').toLowerCase();
    if (normalized === 'word/vbaproject.bin') throw new Error('DOCX_MACRO_CONTENT_REJECTED');
    const size = (entry as ZipObjectWithCompressedMetadata)._data?.uncompressedSize;
    if (!Number.isSafeInteger(size) || size === undefined || size < 0) throw new Error('DOCX_ENTRY_SIZE_INVALID');
    uncompressedBytes += size;
    if (uncompressedBytes > INGESTION_LIMITS.maxDocxUncompressedBytes) throw new Error('DOCX_UNCOMPRESSED_LIMIT_EXCEEDED');
    if (normalized.startsWith('word/media/')) {
      imageCount += 1;
      if (imageCount > INGESTION_LIMITS.maxDocxImages) throw new Error('DOCX_IMAGE_COUNT_LIMIT_EXCEEDED');
      if (size > INGESTION_LIMITS.maxDocxImageBytes) throw new Error('DOCX_IMAGE_SIZE_LIMIT_EXCEEDED');
    }
  }
}

function decodeGeneratedHtmlText(value: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, digits: string) => String.fromCodePoint(Number.parseInt(digits, 16)))
    .replace(/&#(\d+);/g, (_, digits: string) => String.fromCodePoint(Number.parseInt(digits, 10)))
    .replace(/&([a-z]+);/gi, (entity, name: string) => named[name.toLowerCase()] ?? entity)
    .replace(/\s+/g, ' ')
    .trim();
}

function extractDocxTextUnits(html: string): DocxTextUnit[] {
  const units: DocxTextUnit[] = [];
  let tableIndex = 0;
  const withoutTables = html.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (tableHtml) => {
    tableIndex += 1;
    let rowIndex = 0;
    for (const rowMatch of tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      rowIndex += 1;
      let cellIndex = 0;
      for (const cellMatch of rowMatch[1]!.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)) {
        cellIndex += 1;
        const text = decodeGeneratedHtmlText(cellMatch[1]!);
        if (text) units.push({ spanKind: 'table_cell', blockId: `table-${tableIndex}-row-${rowIndex}-cell-${cellIndex}`, text });
      }
    }
    return '';
  });
  let blockIndex = 0;
  for (const blockMatch of withoutTables.matchAll(/<(p|h[1-6]|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const text = decodeGeneratedHtmlText(blockMatch[2]!);
    if (!text) continue;
    blockIndex += 1;
    units.push({ spanKind: 'block', blockId: `block-${blockIndex}`, text });
  }
  return units;
}

async function extractDocxContent(bytes: Uint8Array): Promise<{ textUnits: DocxTextUnit[]; images: DocxEmbeddedImage[]; warnings: string[] }> {
  await assertSafeDocxArchive(bytes);
  const images: DocxEmbeddedImage[] = [];
  const imageResult = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) }, {
    externalFileAccess: false,
    convertImage: mammoth.images.imgElement(async (image) => {
      if (images.length >= INGESTION_LIMITS.maxDocxImages) throw new Error('DOCX_IMAGE_COUNT_LIMIT_EXCEEDED');
      const imageBytes = await image.readAsBuffer();
      if (imageBytes.byteLength > INGESTION_LIMITS.maxDocxImageBytes) throw new Error('DOCX_IMAGE_SIZE_LIMIT_EXCEEDED');
      const normalizedMediaType = image.contentType.toLowerCase() === 'image/jpg' ? 'image/jpeg' : image.contentType.toLowerCase();
      const supported = normalizedMediaType === 'image/png' || normalizedMediaType === 'image/jpeg';
      if (normalizedMediaType === 'image/png') assertImagePixelLimit('png', imageBytes);
      if (normalizedMediaType === 'image/jpeg') assertImagePixelLimit('jpeg', imageBytes);
      const imageIndex = images.length + 1;
      images.push({ imageIndex, bytes: imageBytes, mediaType: normalizedMediaType, supported });
      return { src: `embedded-image-${imageIndex}` };
    })
  });
  const textUnits = extractDocxTextUnits(imageResult.value);
  assertNormalizedTextBudget(textUnits.map((unit) => unit.text));
  if (textUnits.length + images.length > INGESTION_LIMITS.maxSourceSpans) throw new Error('NORMALIZED_SPAN_COUNT_LIMIT_EXCEEDED');
  const warnings = imageResult.messages.map((message) => `${message.type}:${message.message}`);
  for (const image of images) {
    if (!image.supported) warnings.push(`docx_embedded_image_unsupported:${image.mediaType}`);
  }
  return { textUnits, images, warnings: [...new Set(warnings)] };
}

export async function renderDocxImagesToFiles(input: {
  bytes: Uint8Array;
  outputDirectory: string;
  imageIndexes?: number[];
}): Promise<RenderedDocxImage[]> {
  const content = await extractDocxContent(input.bytes);
  const selected = input.imageIndexes ? new Set(input.imageIndexes) : null;
  if (selected && [...selected].some((index) => !Number.isInteger(index) || index < 1 || index > content.images.length)) {
    throw new Error('DOCX_IMAGE_INDEX_INVALID');
  }
  const requested = content.images.filter((image) => !selected || selected.has(image.imageIndex));
  if (requested.some((image) => !image.supported)) throw new Error('DOCX_IMAGE_FORMAT_UNSUPPORTED');
  mkdirSync(input.outputDirectory, { recursive: true, mode: 0o700 });
  return requested.map((image) => {
    const mediaType = image.mediaType as RenderedDocxImage['mediaType'];
    const extension = mediaType === 'image/png' ? 'png' : 'jpg';
    const path = join(input.outputDirectory, `image-${String(image.imageIndex).padStart(3, '0')}.${extension}`);
    writeFileSync(path, image.bytes, { mode: 0o600 });
    return { imageIndex: image.imageIndex, path, mediaType };
  });
}

export async function buildPdfManifest(input: {
  sourceObjectId: string;
  documentId: string;
  sha256: string;
  displayName: string;
  bytes: Uint8Array;
  createdAt: string;
}): Promise<SourceManifest> {
  const loadingTask = getDocument({
    data: Uint8Array.from(input.bytes),
    useSystemFonts: false,
    standardFontDataUrl: pdfStandardFontsPath
  });
  const pdf = await loadingTask.promise;
  if (pdf.numPages > INGESTION_LIMITS.maxPdfPages) {
    await loadingTask.destroy();
    throw new Error('PDF_PAGE_LIMIT_EXCEEDED');
  }
  const spans: SourceSpan[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const quote = content.items
        .flatMap((item) => ('str' in item && typeof item.str === 'string' ? [item.str] : []))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      spans.push({
        id: randomUUID(),
        documentId: input.documentId,
        spanKind: 'page',
        page: pageNumber,
        blockId: null,
        lineStart: null,
        lineEnd: null,
        quote: quote || null,
        readability: quote ? 'clear' : 'unreadable'
      });
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
  return {
    id: randomUUID(),
    sourceObjectId: input.sourceObjectId,
    sha256: input.sha256,
    mediaType: 'application/pdf',
    originalDisplayName: basename(input.displayName),
    totalUnits: Math.max(spans.length, 1),
    coveredUnitIndexes: Array.from({ length: Math.max(spans.length, 1) }, (_, index) => index),
    spans: spans.length > 0 ? spans : [{
      id: randomUUID(), documentId: input.documentId, spanKind: 'page', page: 1,
      blockId: null, lineStart: null, lineEnd: null, quote: null, readability: 'unreadable'
    }],
    normalizerVersion: 'pdfjs-5.4-text-v1',
    conversionWarnings: spans.some((span) => span.readability === 'unreadable') ? ['one_or_more_pages_need_visual_review'] : [],
    createdAt: input.createdAt
  };
}

export async function renderPdfPagesToPngs(input: {
  bytes: Uint8Array;
  outputDirectory: string;
  pageNumbers: number[];
  maxScale?: number;
  maxPixels?: number;
}): Promise<RenderedPdfPage[]> {
  const pageNumbers = [...new Set(input.pageNumbers)].sort((a, b) => a - b);
  if (pageNumbers.some((page) => !Number.isInteger(page) || page < 1)) throw new Error('PDF_PAGE_NUMBER_INVALID');
  if (pageNumbers.length === 0) return [];
  mkdirSync(input.outputDirectory, { recursive: true, mode: 0o700 });
  const loadingTask = getDocument({
    data: Uint8Array.from(input.bytes),
    useSystemFonts: false,
    standardFontDataUrl: pdfStandardFontsPath
  });
  const pdf = await loadingTask.promise;
  const maxScale = input.maxScale ?? 2;
  const maxPixels = input.maxPixels ?? INGESTION_LIMITS.maxRenderedPdfPagePixels;
  const rendered: RenderedPdfPage[] = [];
  try {
    for (const pageNumber of pageNumbers) {
      if (pageNumber > pdf.numPages) throw new Error('PDF_PAGE_NUMBER_INVALID');
      const page = await pdf.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      if (baseViewport.width <= 0 || baseViewport.height <= 0) throw new Error('PDF_PAGE_DIMENSIONS_INVALID');
      const scale = Math.min(maxScale, Math.sqrt(maxPixels / (baseViewport.width * baseViewport.height)));
      const viewport = page.getViewport({ scale });
      const width = Math.max(1, Math.floor(viewport.width));
      const height = Math.max(1, Math.floor(viewport.height));
      if (width * height > maxPixels) throw new Error('PDF_RENDER_PIXEL_LIMIT_EXCEEDED');
      const canvas = createCanvas(width, height);
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
      await page.render({ canvasContext: context, viewport, canvas } as never).promise;
      const path = join(input.outputDirectory, `page-${String(pageNumber).padStart(3, '0')}.png`);
      writeFileSync(path, canvas.toBuffer('image/png'), { mode: 0o600 });
      rendered.push({ page: pageNumber, path, width, height });
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
  return rendered;
}

export async function buildDocxManifest(input: {
  sourceObjectId: string;
  documentId: string;
  sha256: string;
  displayName: string;
  bytes: Uint8Array;
  createdAt: string;
}): Promise<SourceManifest> {
  const extracted = await extractDocxContent(input.bytes);
  const textUnits = extracted.textUnits.length > 0
    ? extracted.textUnits
    : [{ spanKind: 'block' as const, blockId: 'block-1', text: '' }];
  const textSpans: SourceSpan[] = textUnits.map((unit) => ({
    id: randomUUID(),
    documentId: input.documentId,
    spanKind: unit.spanKind,
    page: null,
    blockId: unit.blockId,
    lineStart: null,
    lineEnd: null,
    quote: unit.text || null,
    readability: unit.text ? 'clear' : 'unreadable'
  }));
  const imageSpans: SourceSpan[] = extracted.images.map((image) => ({
    id: randomUUID(),
    documentId: input.documentId,
    spanKind: 'image',
    page: null,
    blockId: `image-${image.imageIndex}`,
    lineStart: null,
    lineEnd: null,
    quote: null,
    readability: image.supported ? 'partial' : 'unreadable'
  }));
  const spans = [...textSpans, ...imageSpans];
  return {
    id: randomUUID(),
    sourceObjectId: input.sourceObjectId,
    sha256: input.sha256,
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    originalDisplayName: basename(input.displayName),
    totalUnits: spans.length,
    coveredUnitIndexes: spans.map((_, index) => index),
    spans,
    normalizerVersion: 'mammoth-1.12-structured-v2',
    conversionWarnings: extracted.images.some((image) => image.supported)
      ? [...extracted.warnings, 'docx_embedded_images_require_visual_review']
      : extracted.warnings,
    createdAt: input.createdAt
  };
}

export async function buildLegacyDocManifest(input: {
  sourceObjectId: string;
  documentId: string;
  sha256: string;
  displayName: string;
  bytes: Uint8Array;
  createdAt: string;
}): Promise<SourceManifest> {
  const WordExtractor = require('word-extractor') as new () => LegacyWordExtractor;
  const document = await new WordExtractor().extract(Buffer.from(input.bytes));
  const sections = [
    ['body', document.getBody()],
    ['headers', document.getHeaders({ includeFooters: false })],
    ['footers', document.getFooters()],
    ['footnotes', document.getFootnotes()],
    ['endnotes', document.getEndnotes()],
    ['annotations', document.getAnnotations()],
    ['textboxes', document.getTextboxes({ includeHeadersAndFooters: false, includeBody: false })]
  ] as const;
  const blocks = sections.flatMap(([section, text]) => text
    .split(/\r?\n+/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((quote, index) => ({ section, quote, index: index + 1 })));
  if (blocks.length === 0) throw new Error('LEGACY_DOC_TEXT_UNREADABLE');
  assertNormalizedTextBudget(blocks.map((block) => block.quote));
  return {
    id: randomUUID(),
    sourceObjectId: input.sourceObjectId,
    sha256: input.sha256,
    mediaType: 'application/msword',
    originalDisplayName: basename(input.displayName),
    totalUnits: blocks.length,
    coveredUnitIndexes: blocks.map((_, index) => index),
    spans: blocks.map((block) => ({
      id: randomUUID(),
      documentId: input.documentId,
      spanKind: 'block',
      page: null,
      blockId: `${block.section}-${block.index}`,
      lineStart: null,
      lineEnd: null,
      quote: block.quote,
      readability: 'clear'
    })),
    normalizerVersion: 'word-extractor-1.0.4-text-v1',
    conversionWarnings: ['legacy_doc_text_view_no_original_pagination', 'embedded_images_not_extracted'],
    createdAt: input.createdAt
  };
}

export async function buildHeicManifest(input: {
  sourceObjectId: string;
  documentId: string;
  sha256: string;
  mediaType: string;
  displayName: string;
  bytes: Uint8Array;
  createdAt: string;
}): Promise<SourceManifest> {
  const decoded = inspectHeicImages(input.bytes);
  return {
    id: randomUUID(),
    sourceObjectId: input.sourceObjectId,
    sha256: input.sha256,
    mediaType: input.mediaType,
    originalDisplayName: basename(input.displayName),
    totalUnits: decoded.length,
    coveredUnitIndexes: decoded.map((_, index) => index),
    spans: decoded.map((image) => ({
      id: randomUUID(),
      documentId: input.documentId,
      spanKind: 'image',
      page: image.imageIndex,
      blockId: null,
      lineStart: null,
      lineEnd: null,
      quote: null,
      readability: 'partial'
    })),
    normalizerVersion: 'libheif-js-1.19.8-v1',
    conversionWarnings: ['heic_decoded_locally_for_model_review'],
    createdAt: input.createdAt
  };
}

export function buildImageManifest(input: {
  sourceObjectId: string;
  documentId: string;
  sha256: string;
  mediaType: string;
  displayName: string;
  createdAt: string;
}): SourceManifest {
  return {
    id: randomUUID(),
    sourceObjectId: input.sourceObjectId,
    sha256: input.sha256,
    mediaType: input.mediaType,
    originalDisplayName: basename(input.displayName),
    totalUnits: 1,
    coveredUnitIndexes: [0],
    spans: [{
      id: randomUUID(),
      documentId: input.documentId,
      spanKind: 'image',
      page: 1,
      blockId: null,
      lineStart: null,
      lineEnd: null,
      quote: null,
      readability: 'partial'
    }],
    normalizerVersion: 'image-evidence-v1',
    conversionWarnings: ['visual_content_requires_model_review'],
    createdAt: input.createdAt
  };
}

export function assertPathWithinRoot(rootPath: string, candidatePath: string): string {
  const root = resolve(rootPath);
  const candidate = resolve(candidatePath);
  const relativePath = relative(root, candidate);
  if (relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath))) return candidate;
  throw new Error('PATH_OUTSIDE_AUTHORIZED_ROOT');
}

function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.slice(0, Math.min(bytes.byteLength, 4096));
  let controlCharacters = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32)) controlCharacters += 1;
  }
  return controlCharacters / Math.max(sample.byteLength, 1) < 0.02;
}

function hasCompoundFileBinarySignature(bytes: Uint8Array): boolean {
  const signature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  return signature.every((byte, index) => bytes[index] === byte);
}
