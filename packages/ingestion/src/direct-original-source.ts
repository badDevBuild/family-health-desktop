import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { SourceManifest } from '@contracts';
import { assertImagePixelLimit, assertSafeDocxArchive, buildHeicManifest, decodeText, detectInput, INGESTION_LIMITS,
  renderHeicImagesToPngs, renderPdfPagesToPngs, type SupportedKind } from './index.js';
import type { LegacyDocConversionResult, LegacyDocConverter } from './legacy-doc-converter.js';

export const DIRECT_ORIGINAL_NORMALIZER_VERSION = 'direct-original-preparation-v1';

export interface DirectOriginalSourceInput {
  documentId: string;
  sourceObjectId: string;
  sha256: string;
  displayName: string;
  bytes: Uint8Array;
  createdAt: string;
  legacyDocConverter?: LegacyDocConverter | null;
  convertedPdf?: LegacyDocConversionResult;
}

/** 这里只说明技术视图与原件的关系，不保存本机识别文字或临床字段。 */
export interface DirectOriginalSourceBundle {
  manifest: SourceManifest;
  kind: SupportedKind;
  originalBytes: Uint8Array;
  pdfBytes?: Uint8Array;
  nativeText?: string;
  convertedView?: LegacyDocConversionResult;
}

export interface DirectOriginalUnitMapping {
  page: number;
  sourceSpanId: string;
  inputKind: 'image' | 'native_text';
}

export interface DirectOriginalImageMapping extends DirectOriginalUnitMapping {
  inputKind: 'image';
  path: string;
  mediaType: 'image/png' | 'image/jpeg';
  /** 图像视图的实际哈希；不能拿它替换原文件哈希。 */
  sha256: string;
  width: number;
  height: number;
}

export interface PreparedOriginalModelInput {
  manifest: SourceManifest;
  imagePaths: string[];
  imageMappings: DirectOriginalImageMapping[];
  unitMappings: DirectOriginalUnitMapping[];
  nativeText?: string;
  originalSha256: string;
  convertedViewSha256?: string;
  totalUnits: number;
  tempRoot: string;
  /** 只清理本次新建私有目录；调用方应在模型处理的 finally 中调用。 */
  cleanup(): Promise<void>;
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function stableId(input: DirectOriginalSourceInput, suffix: string): string {
  return `direct-original-${createHash('sha256').update(JSON.stringify([
    DIRECT_ORIGINAL_NORMALIZER_VERSION, input.documentId, input.sourceObjectId, input.sha256, suffix
  ])).digest('hex').slice(0, 40)}`;
}

async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  // 不调用 getTextContent，也不根据文字/图片数量跳过页面。
  const loading = getDocument({ data: Uint8Array.from(bytes), useSystemFonts: false });
  try {
    const pdf = await loading.promise;
    if (!Number.isInteger(pdf.numPages) || pdf.numPages < 1) throw new Error('PDF_HAS_NO_PAGES');
    if (pdf.numPages > INGESTION_LIMITS.maxPdfPages) throw new Error('PDF_PAGE_COUNT_LIMIT_EXCEEDED');
    return pdf.numPages;
  } finally { await loading.destroy(); }
}

/** 完整原件准备：只验格式、哈希、页数和资源界限，绝不调用 OCR。 */
export async function prepareOriginalSource(input: DirectOriginalSourceInput): Promise<{
  manifest: SourceManifest;
  bundle: DirectOriginalSourceBundle;
}> {
  const detected = await detectInput(input.displayName, input.bytes);
  if (detected.sha256 !== input.sha256) throw new Error('SOURCE_HASH_MISMATCH');
  let totalUnits = 1;
  let pdfBytes: Uint8Array | undefined;
  let nativeText: string | undefined;
  let convertedView: LegacyDocConversionResult | undefined;
  const warnings: string[] = ['direct_original_prepared_not_medically_read'];
  if (detected.kind === 'pdf') {
    pdfBytes = input.bytes;
    totalUnits = await pdfPageCount(pdfBytes);
  } else if (detected.kind === 'jpeg' || detected.kind === 'png') {
    assertImagePixelLimit(detected.kind, input.bytes);
  } else if (detected.kind === 'heic') {
    // 解码只验证容器和全部图像尺寸，不读任何图上的文字。
    totalUnits = (await buildHeicManifest({ ...input, mediaType: detected.mediaType })).totalUnits;
    warnings.push('heic_full_image_conversion_view');
  } else if (detected.kind === 'txt') {
    const decoded = decodeText(input.bytes);
    nativeText = decoded.text;
    if (Buffer.byteLength(nativeText, 'utf8') > INGESTION_LIMITS.maxNormalizedTextBytes) {
      throw new Error('DIRECT_ORIGINAL_TEXT_LIMIT_EXCEEDED');
    }
    if (decoded.warning) warnings.push(decoded.warning);
  } else if (detected.kind === 'doc' || detected.kind === 'docx') {
    if (detected.kind === 'docx') await assertSafeDocxArchive(input.bytes);
    if (!input.convertedPdf && !input.legacyDocConverter) {
      throw new Error(detected.kind === 'docx' ? 'DOCX_ORIGINAL_VIEW_CONVERSION_REQUIRED' : 'LEGACY_DOC_CONVERSION_REQUIRED');
    }
    convertedView = input.convertedPdf ?? await input.legacyDocConverter!.convert(input.bytes, detected.kind);
    if (convertedView.mediaType !== 'application/pdf'
      || !Buffer.from(convertedView.bytes).subarray(0, 5).equals(Buffer.from('%PDF-'))
      || hash(convertedView.bytes) !== convertedView.sha256) throw new Error('CONVERTED_VIEW_HASH_MISMATCH');
    pdfBytes = convertedView.bytes;
    totalUnits = await pdfPageCount(pdfBytes);
    warnings.push(`converted_view:${convertedView.converterId}:${convertedView.converterVersion}`,
      'word_layout_may_differ_from_original');
  }
  const manifest: SourceManifest = {
    id: stableId(input, 'manifest'), sourceObjectId: input.sourceObjectId, sha256: input.sha256,
    mediaType: detected.mediaType, originalDisplayName: basename(input.displayName), totalUnits,
    coveredUnitIndexes: Array.from({ length: totalUnits }, (_, index) => index),
    spans: Array.from({ length: totalUnits }, (_, index) => ({
      id: stableId(input, `page:${index + 1}`), documentId: input.documentId, spanKind: 'image' as const,
      page: index + 1, blockId: `direct-original-page:${index + 1}`, lineStart: null, lineEnd: null,
      quote: null, readability: 'unreadable' as const
    })),
    normalizerVersion: DIRECT_ORIGINAL_NORMALIZER_VERSION, conversionWarnings: warnings, createdAt: input.createdAt
  };
  return { manifest, bundle: { manifest, kind: detected.kind, originalBytes: input.bytes,
    ...(pdfBytes ? { pdfBytes } : {}), ...(nativeText !== undefined ? { nativeText } : {}),
    ...(convertedView ? { convertedView } : {}) } };
}

/** 整份报告一次提供所有原页；准备失败显式报错，不删页或按 8 张图片拆分。 */
export async function prepareOriginalModelInput(input: {
  bundle: DirectOriginalSourceBundle;
  outputDirectory?: string;
}): Promise<PreparedOriginalModelInput> {
  const { bundle } = input;
  const manifest = bundle.manifest;
  if (manifest.normalizerVersion !== DIRECT_ORIGINAL_NORMALIZER_VERSION
    || hash(bundle.originalBytes) !== manifest.sha256) throw new Error('DIRECT_ORIGINAL_BUNDLE_INVALID');
  const detected = await detectInput(manifest.originalDisplayName, bundle.originalBytes);
  if (detected.kind !== bundle.kind || detected.mediaType !== manifest.mediaType
    || (bundle.kind === 'pdf' && (!bundle.pdfBytes || hash(bundle.pdfBytes) !== manifest.sha256))
    || (bundle.kind === 'txt' && bundle.nativeText !== decodeText(bundle.originalBytes).text)) {
    throw new Error('DIRECT_ORIGINAL_BUNDLE_INVALID');
  }
  if (manifest.spans.length !== manifest.totalUnits
    || new Set(manifest.spans.map((span) => span.id)).size !== manifest.totalUnits
    || manifest.spans.some((span, index) => span.page !== index + 1
      || span.quote !== null || span.readability !== 'unreadable'
      || span.visualEvidence !== undefined || span.modelEvidence !== undefined
      || span.blockId !== `direct-original-page:${index + 1}`)
    || manifest.coveredUnitIndexes.length !== manifest.totalUnits
    || manifest.coveredUnitIndexes.some((unit, index) => unit !== index)) throw new Error('DIRECT_ORIGINAL_PREPARATION_COVERAGE_INVALID');
  const parent = input.outputDirectory ?? tmpdir();
  if (input.outputDirectory) await mkdir(parent, { recursive: true, mode: 0o700 });
  // 即使调用方提供目录，也只使用其中新建的独立子目录，避免覆盖或删除其他文件。
  const tempRoot = await mkdtemp(join(parent, 'family-health-direct-original-'));
  const cleanup = async () => { await rm(tempRoot, { recursive: true, force: true }); };
  try {
    await chmod(tempRoot, 0o700);
    const imageMappings: DirectOriginalImageMapping[] = [];
    if (bundle.pdfBytes) {
      if (bundle.convertedView && hash(bundle.pdfBytes) !== bundle.convertedView.sha256) throw new Error('CONVERTED_VIEW_HASH_MISMATCH');
      const count = await pdfPageCount(bundle.pdfBytes);
      if (count !== manifest.totalUnits) throw new Error('DIRECT_ORIGINAL_PREPARATION_COVERAGE_INVALID');
      const rendered = await renderPdfPagesToPngs({ bytes: bundle.pdfBytes, outputDirectory: tempRoot,
        pageNumbers: Array.from({ length: count }, (_, index) => index + 1) });
      if (rendered.length !== count || rendered.some((page, index) => page.page !== index + 1)) {
        throw new Error('DIRECT_ORIGINAL_PREPARATION_COVERAGE_INVALID');
      }
      for (const page of rendered) imageMappings.push({ inputKind: 'image', page: page.page,
        sourceSpanId: manifest.spans[page.page - 1]!.id, path: page.path, mediaType: 'image/png',
        sha256: hash(await readFile(page.path)), width: page.width, height: page.height });
    } else if (bundle.kind === 'heic') {
      const images = await renderHeicImagesToPngs({ bytes: bundle.originalBytes, outputDirectory: tempRoot });
      if (images.length !== manifest.totalUnits || images.some((page, index) => page.imageIndex !== index + 1)) {
        throw new Error('DIRECT_ORIGINAL_PREPARATION_COVERAGE_INVALID');
      }
      for (const page of images) imageMappings.push({ inputKind: 'image', page: page.imageIndex,
        sourceSpanId: manifest.spans[page.imageIndex - 1]!.id, path: page.path, mediaType: 'image/png',
        sha256: hash(await readFile(page.path)), width: page.width, height: page.height });
    } else if (bundle.kind === 'jpeg' || bundle.kind === 'png') {
      const dimensions = assertImagePixelLimit(bundle.kind, bundle.originalBytes);
      const path = join(tempRoot, bundle.kind === 'png' ? 'original.png' : 'original.jpg');
      await writeFile(path, bundle.originalBytes, { mode: 0o600, flag: 'wx' });
      imageMappings.push({ inputKind: 'image', page: 1, sourceSpanId: manifest.spans[0]!.id, path,
        mediaType: bundle.kind === 'png' ? 'image/png' : 'image/jpeg', sha256: manifest.sha256, ...dimensions });
    } else if (bundle.kind !== 'txt' || bundle.nativeText === undefined || manifest.totalUnits !== 1) {
      throw new Error('DIRECT_ORIGINAL_MODEL_INPUT_UNAVAILABLE');
    }
    const unitMappings: DirectOriginalUnitMapping[] = bundle.kind === 'txt'
      ? [{ page: 1, sourceSpanId: manifest.spans[0]!.id, inputKind: 'native_text' }]
      : imageMappings.map(({ page, sourceSpanId }) => ({ page, sourceSpanId, inputKind: 'image' }));
    if (unitMappings.length !== manifest.totalUnits) throw new Error('DIRECT_ORIGINAL_PREPARATION_COVERAGE_INVALID');
    return { manifest, imageMappings, unitMappings, imagePaths: imageMappings.map((image) => image.path),
      ...(bundle.nativeText !== undefined ? { nativeText: bundle.nativeText } : {}),
      originalSha256: manifest.sha256, ...(bundle.convertedView ? { convertedViewSha256: bundle.convertedView.sha256 } : {}),
      totalUnits: manifest.totalUnits, tempRoot, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

export async function prepareDirectOriginalReport(input: DirectOriginalSourceInput & {
  outputDirectory?: string;
}): Promise<PreparedOriginalModelInput> {
  const { bundle } = await prepareOriginalSource(input);
  return prepareOriginalModelInput({ bundle, ...(input.outputDirectory ? { outputDirectory: input.outputDirectory } : {}) });
}
