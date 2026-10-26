import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SourceManifest } from '@contracts';
import { prepareOriginalSource, DIRECT_ORIGINAL_NORMALIZER_VERSION,
  detectInput, renderDocxImagesToFiles,
  renderHeicImagesToPngs, renderPdfPagesToPngs, rereadLocalVisualRegion, selectLocalVisualRegion,
  type LegacyDocConverter, type LocalVisualImage, type LocalVisualRegionReadResult,
  type LocalVisualRecognitionOptions, type LocalVisualReceipt } from '@ingestion';
import type { WorkspaceStore } from '@storage';

export { DIRECT_ORIGINAL_NORMALIZER_VERSION };

/** 新导入与全量重建共用技术准备；本机不识别文字，也不把准备覆盖当医学成功。 */
export async function normalizeStoredSource(input: {
  store: WorkspaceStore;
  documentId: string;
  sourceObjectId: string;
  sha256: string;
  displayName: string;
  bytes: Uint8Array;
  createdAt: string;
  legacyDocConverter?: LegacyDocConverter | null;
  /** 准备期间工作区可能已关闭；异步完成后不能再向旧工作区写入转换视图。 */
  validateBeforeCommit?: () => void;
  /** 仅兼容旧调用类型；直接原件流程永不调用本机识别。 */
  localVisualRecognize?: (path: string) => Promise<LocalVisualReceipt>;
}): Promise<SourceManifest> {
  // 正常重建/重新纳入保留原件及其受控转换视图。先读已核验哈希的完整PDF，
  // 避免重复转换造成页布局变化或重复登记；它始终不是新的原件对象。
  const cachedView = input.store.getDocumentConvertedView(input.documentId);
  if (cachedView && (cachedView.mediaType !== 'application/pdf' || cachedView.converterId !== 'libreoffice-headless'
    || !cachedView.converterVersion.trim() || !/^[a-f0-9]{64}$/u.test(cachedView.executableSha256))) {
    throw new Error('DIRECT_ORIGINAL_CONVERTED_VIEW_INVALID');
  }
  const { manifest, bundle } = await prepareOriginalSource({ ...input,
    ...(cachedView ? { convertedPdf: { ...cachedView, mediaType: 'application/pdf' as const,
      converterId: 'libreoffice-headless' as const } } : {}) });
  input.validateBeforeCommit?.();
  if (bundle.convertedView && !cachedView) {
    const converted = bundle.convertedView;
    const source = input.store.putSourceObject({ bytes: converted.bytes, mediaType: converted.mediaType,
      displayName: `${input.displayName}.converted.pdf` });
    input.store.registerDocumentConversion({ documentId: input.documentId, convertedSourceObjectId: source.id,
      converterId: converted.converterId, converterVersion: converted.converterVersion,
      executableSha256: converted.executableSha256, warnings: ['word_layout_may_differ_from_original'] });
  }
  return manifest;
}

/** 仅供旧 fixture 的显式兼容接口；直接原件骨架不具备 OCR 几何，不走此入口。 */
export async function rereadStoredSourceRegion(input: {
  manifest: SourceManifest;
  bytes: Uint8Array;
  displayName: string;
  sourceSpanId: string;
  lineStart: number;
  lineEnd: number;
  createdAt: string;
  recognize?: (path: string, options: LocalVisualRecognitionOptions) => Promise<LocalVisualReceipt>;
}): Promise<{ manifest: SourceManifest; readSpanId: string | null; diagnostic: LocalVisualRegionReadResult['diagnostic'] }> {
  const span = input.manifest.spans.find((item) => item.id === input.sourceSpanId);
  const unavailable = { manifest: input.manifest, readSpanId: null,
    diagnostic: { code: 'LOCAL_VISUAL_REGION_UNAVAILABLE' as const, attempts: 0 } };
  // 正式调用永不启动本机识别。只有旧合成 fixture 显式提供识别替身时
  // 才保留旧接口的行为，避免遗留流水线调用再次偷偷使用 OCR。
  if (!input.recognize || !span || !selectLocalVisualRegion(span, input.lineStart, input.lineEnd)) return unavailable;
  const detected = await detectInput(input.displayName, input.bytes);
  if (detected.sha256 !== input.manifest.sha256) throw new Error('SOURCE_HASH_MISMATCH');
  const temporary = await mkdtemp(join(tmpdir(), 'family-health-image-region-ocr-'));
  try {
    let image: LocalVisualImage | undefined;
    if (detected.kind === 'pdf' && span.page !== null) {
      const rendered = await renderPdfPagesToPngs({ bytes: input.bytes, outputDirectory: temporary, pageNumbers: [span.page] });
      const page = rendered[0];
      if (page) image = { path: page.path, page: page.page };
    } else if (detected.kind === 'heic' && span.page !== null) {
      const rendered = await renderHeicImagesToPngs({ bytes: input.bytes, outputDirectory: temporary, imageIndexes: [span.page] });
      const page = rendered[0];
      if (page) image = { path: page.path, page: page.imageIndex };
    } else if (detected.kind === 'docx') {
      const index = /^image-(\d+)$/u.exec(span.blockId ?? '')?.[1];
      if (!index) return unavailable;
      const rendered = await renderDocxImagesToFiles({ bytes: input.bytes, outputDirectory: temporary, imageIndexes: [Number(index)] });
      const page = rendered[0];
      if (page) image = { path: page.path, page: null, blockId: span.blockId };
    } else if (detected.kind === 'jpeg' || detected.kind === 'png') {
      const path = join(temporary, detected.kind === 'png' ? 'source.png' : 'source.jpg');
      await writeFile(path, input.bytes, { mode: 0o600 });
      image = { path, page: 1 };
    }
    if (!image) return unavailable;
    const result = await rereadLocalVisualRegion({ span, image, lineStart: input.lineStart, lineEnd: input.lineEnd,
      ...(input.recognize ? { recognize: input.recognize } : {}) });
    if (!result.span) return { ...unavailable, diagnostic: result.diagnostic };
    // 不增加必覆盖的原页数；新片段只是该页疑点的独立来源视图。
    const spans = input.manifest.spans.some((item) => item.id === result.span!.id)
      ? input.manifest.spans : [...input.manifest.spans, result.span];
    return { readSpanId: result.span.id, diagnostic: result.diagnostic, manifest: {
      ...input.manifest, spans, createdAt: input.createdAt,
      normalizerVersion: input.manifest.normalizerVersion.includes('+local-visual-region-v1')
        ? input.manifest.normalizerVersion : `${input.manifest.normalizerVersion}+local-visual-region-v1`,
      conversionWarnings: [...new Set([...input.manifest.conversionWarnings, 'local_visual_region_is_independent_crosscheck'])]
    } };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
