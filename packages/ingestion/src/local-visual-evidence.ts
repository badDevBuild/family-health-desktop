import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { SourceManifest, SourceSpan, SourceVisualEvidence } from '@contracts';
import { reconstructLocalVisualLayout } from './local-visual-layout.js';

const execute = promisify(execFile);
const receiptSchema = z.object({
  version: z.literal(1), engine: z.literal('apple-vision-local-v1'),
  lines: z.array(z.object({
    text: z.string().max(16_384), confidence: z.number().min(0).max(1),
    bounds: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1),
      z.number().positive().max(1), z.number().positive().max(1)])
      .refine(([x, y, width, height]) => x + width <= 1.000001 && y + height <= 1.000001)
  }).strict()).max(10_000),
  imageSize: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict().optional(),
  recognitionRevision: z.number().int().nonnegative().optional(),
  fallbackUsed: z.boolean().optional()
}).strict();
export type LocalVisualReceipt = z.infer<typeof receiptSchema>;
export type LocalVisualBounds = [number, number, number, number];
export interface LocalVisualImage { path: string; page: number | null; blockId?: string | null }
export interface LocalVisualRecognitionOptions { regionBounds?: LocalVisualBounds; prepared?: boolean; fallbackBudget?: 0 | 1 }
const failureCodes = ['LOCAL_VISUAL_ENGINE_UNAVAILABLE', 'LOCAL_VISUAL_TIMEOUT', 'LOCAL_VISUAL_OUTPUT_LIMIT_EXCEEDED',
  'LOCAL_VISUAL_RECEIPT_INVALID', 'LOCAL_VISUAL_TEXT_LIMIT_EXCEEDED', 'LOCAL_VISUAL_IMAGE_DECODE_FAILED',
  'LOCAL_VISUAL_IMAGE_DIMENSIONS_EXCEEDED', 'LOCAL_VISUAL_IMAGE_PREPARATION_FAILED',
  'LOCAL_VISUAL_VISION_REQUEST_FAILED', 'LOCAL_VISUAL_RECOGNITION_FAILED'] as const;
export type LocalVisualFailureCode = typeof failureCodes[number];
export class LocalVisualRecognitionError extends Error {
  constructor(readonly code: LocalVisualFailureCode, readonly attempts = 1) { super(code); this.name = 'LocalVisualRecognitionError'; }
}

/** 对外只有固定分类；stderr、系统路径和报告正文不进入错误对象。 */
export function classifyLocalVisualRecognitionFailure(error: unknown): LocalVisualFailureCode {
  if (error instanceof LocalVisualRecognitionError) return error.code;
  if (error instanceof Error && failureCodes.includes(error.message as LocalVisualFailureCode)) return error.message as LocalVisualFailureCode;
  if (typeof error === 'object' && error !== null) {
    const failure = error as { code?: unknown; killed?: unknown; signal?: unknown; stderr?: unknown };
    if (failure.code === 'ENOENT') return 'LOCAL_VISUAL_ENGINE_UNAVAILABLE';
    if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || failure.code === 'ENOBUFS') return 'LOCAL_VISUAL_OUTPUT_LIMIT_EXCEEDED';
    if (failure.killed === true && failure.signal === 'SIGTERM') return 'LOCAL_VISUAL_TIMEOUT';
    const fixed = typeof failure.stderr === 'string' ? failure.stderr.trim() : '';
    if (failureCodes.includes(fixed as LocalVisualFailureCode)) return fixed as LocalVisualFailureCode;
  }
  return 'LOCAL_VISUAL_RECOGNITION_FAILED';
}

function parseReceipt(value: unknown, textLimit = 64 * 1024): LocalVisualReceipt {
  let receipt: LocalVisualReceipt;
  try { receipt = receiptSchema.parse(value); } catch { throw new LocalVisualRecognitionError('LOCAL_VISUAL_RECEIPT_INVALID'); }
  if (receipt.lines.reduce((bytes, line) => bytes + Buffer.byteLength(line.text, 'utf8'), 0) > textLimit) {
    throw new LocalVisualRecognitionError('LOCAL_VISUAL_TEXT_LIMIT_EXCEEDED');
  }
  return receipt;
}

function executablePath(): string | null {
  if (process.platform !== 'darwin') return null;
  const target = `darwin-${process.arch}`;
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    ...(resources ? [join(resources, 'runtime', 'vision', target, 'vision-ocr')] : []),
    join(process.cwd(), '.runtime-stage', 'vision', target, 'vision-ocr')
  ];
  return candidates.find(existsSync) ?? null;
}

/** 引擎结果只能来自本机受控二进制，不从模型返回值构造来源文字。 */
async function recognizeOnce(path: string, options: LocalVisualRecognitionOptions): Promise<LocalVisualReceipt> {
  const executable = executablePath();
  if (!executable) throw new LocalVisualRecognitionError('LOCAL_VISUAL_ENGINE_UNAVAILABLE');
  try {
    const args = [path, ...(options.prepared ? ['--prepared'] : []),
      ...(options.regionBounds ? ['--region', ...options.regionBounds.map(String)] : [])];
    const { stdout } = await execute(executable, args, { timeout: 45_000, maxBuffer: (options.prepared ? 4 : 2) * 1024 * 1024 });
    let value: unknown;
    try { value = JSON.parse(stdout); } catch { throw new LocalVisualRecognitionError('LOCAL_VISUAL_RECEIPT_INVALID'); }
    return parseReceipt(value, options.prepared ? 256 * 1024 : 64 * 1024);
  } catch (error) {
    throw new LocalVisualRecognitionError(classifyLocalVisualRecognitionFailure(error));
  }
}

/** 首读失败后最多一次标准图像回退；资源失败不等同于原件不可读。 */
export async function recognizeLocalVisualText(path: string, options: LocalVisualRecognitionOptions = {},
  localRecognize: (path: string, options: LocalVisualRecognitionOptions) => Promise<LocalVisualReceipt> = recognizeOnce
): Promise<LocalVisualReceipt> {
  try {
    return { ...parseReceipt(await localRecognize(path, options), options.prepared ? 256 * 1024 : 64 * 1024), fallbackUsed: false };
  } catch (firstError) {
    const firstCode = classifyLocalVisualRecognitionFailure(firstError);
    if (options.fallbackBudget === 0 || firstCode === 'LOCAL_VISUAL_ENGINE_UNAVAILABLE'
      || firstCode === 'LOCAL_VISUAL_IMAGE_DECODE_FAILED' || firstCode === 'LOCAL_VISUAL_IMAGE_DIMENSIONS_EXCEEDED') {
      throw new LocalVisualRecognitionError(firstCode);
    }
    try {
      return { ...parseReceipt(await localRecognize(path, { ...options, prepared: true, fallbackBudget: 0 }), 256 * 1024), fallbackUsed: true };
    } catch (error) { throw new LocalVisualRecognitionError(classifyLocalVisualRecognitionFailure(error), 2); }
  }
}

function receiptEvidence(receipt: LocalVisualReceipt, regionBounds?: LocalVisualBounds): {
  quote: string; evidence: SourceVisualEvidence; warnings: string[]
} {
  const reliable = receipt.lines.filter((line) => line.confidence >= 0.3 && line.text.trim().length > 0);
  const omittedBoxes = receipt.lines.filter((line) => line.confidence < 0.3 && line.text.trim().length > 0);
  const layout = reconstructLocalVisualLayout(reliable);
  if (Buffer.byteLength(layout.quote, 'utf8') > 256 * 1024) throw new LocalVisualRecognitionError('LOCAL_VISUAL_TEXT_LIMIT_EXCEEDED');
  return { quote: layout.quote, warnings: layout.warnings,
    evidence: { version: 1, engine: receipt.engine, layoutVersion: layout.version,
      coordinateSystem: 'normalized-bottom-left', ...(receipt.imageSize ? { imageSize: receipt.imageSize } : {}),
      ...(receipt.recognitionRevision !== undefined ? { recognitionRevision: receipt.recognitionRevision } : {}),
      reading: { mode: regionBounds ? 'region' : 'full_image', ...(regionBounds ? { regionBounds } : {}),
        fallbackUsed: receipt.fallbackUsed ?? false },
      rows: layout.rows.map((row, index) => ({ line: index + 1, text: row.text, bounds: row.bounds, boxes: row.boxes })),
      omittedBoxes } };
}

/** 原页/图像定位不变；独立 OCR 是交叉核验依据而非事实，模型仍须读取原图。 */
export async function enrichManifestWithLocalVisualEvidence(input: {
  manifest: SourceManifest;
  images: LocalVisualImage[];
  recognize?: (path: string) => Promise<LocalVisualReceipt>;
}): Promise<SourceManifest> {
  const spans = input.manifest.spans.map((span) => ({ ...span }));
  const warnings = new Set(input.manifest.conversionWarnings);
  let attempted = false;
  for (const image of input.images) {
    const span = spans.find((item) => item.page === image.page
      && (image.blockId === undefined || item.blockId === image.blockId)
      && (!item.quote || item.readability !== 'clear' || item.spanKind === 'image'));
    if (!span) continue;
    attempted = true;
    try {
      const receipt = parseReceipt(await (input.recognize ?? recognizeLocalVisualText)(image.path), 256 * 1024);
      // Vision 中文经常给可读原句 0.3；confidence 不是医学正确率。
      // 不靠一个置信度阈值决定事实正确，而由原图读取与独立转写逐字段一致性共同接纳。
      const prepared = receiptEvidence(receipt);
      for (const warning of prepared.warnings) warnings.add(warning);
      const quote = prepared.quote;
      span.visualEvidence = prepared.evidence;
      if (!quote) {
        warnings.add('local_visual_no_reliable_text');
        continue;
      }
      span.quote = quote;
      // 有文字被阈值遗漏时不把整页标成完整清晰，尤其不能遗漏否定词或数值。
      span.readability = prepared.evidence.omittedBoxes.length > 0 ? 'partial' : 'clear';
      // 扫描页有了 OCR 文字也仍是视觉来源，不能因此不附原图。
      span.spanKind = 'image';
      span.lineStart = 1;
      span.lineEnd = prepared.evidence.rows.length;
      // 保留原始页/图像定位和转写行号，不借模型自己的输出证明模型自身。
      span.blockId ??= 'local-vision-page-v3';
      warnings.add('local_visual_text_requires_original_image_context');
      if (receipt.lines.some((line) => line.confidence < 0.9)) warnings.add('local_visual_text_is_crosscheck_not_confirmed_fact');
      if (prepared.evidence.omittedBoxes.length > 0) warnings.add('local_visual_low_confidence_content_not_transcribed');
      if (receipt.fallbackUsed) warnings.add('local_visual_single_preparation_fallback_used');
    } catch (error) {
      const code = classifyLocalVisualRecognitionFailure(error);
      warnings.add(code.toLowerCase());
      // 保留兼容概括，同时固定细分类区分本机资源/解码/识别故障。
      if (code !== 'LOCAL_VISUAL_ENGINE_UNAVAILABLE') warnings.add('local_visual_recognition_failed');
    }
  }
  return {
    ...input.manifest, spans,
    normalizerVersion: attempted ? `${input.manifest.normalizerVersion}+local-visual-evidence-v1+local-visual-layout-v2+local-visual-geometry-v1` : input.manifest.normalizerVersion,
    conversionWarnings: [...warnings]
  };
}

/** 只从已保存的真实行框选区域。不会按模型的项目名或数值猜测位置。 */
export function selectLocalVisualRegion(span: SourceSpan, lineStart: number, lineEnd: number): LocalVisualBounds | null {
  const evidence = span.visualEvidence;
  if (!evidence || evidence.reading.mode !== 'full_image' || !Number.isInteger(lineStart) || !Number.isInteger(lineEnd)
    || lineStart < 1 || lineEnd < lineStart || lineEnd - lineStart > 7) return null;
  const rows = evidence.rows.filter((row) => row.line >= lineStart && row.line <= lineEnd);
  if (rows.length !== lineEnd - lineStart + 1) return null;
  const selected = rows.flatMap((row) => row.boxes);
  // 疑点行旁边的低评分文字可能是“未见”、左右侧或比较符，不裁掉它们。
  // 这里只按同一水平带扩大原图读取范围，并不据此认定文字归属哪个项目。
  const omittedInBand = evidence.omittedBoxes.filter((omitted) => selected.some((box) => (
    omitted.bounds[1] < box.bounds[1] + box.bounds[3]
    && omitted.bounds[1] + omitted.bounds[3] > box.bounds[1]
  )));
  const boxes = [...selected, ...omittedInBand];
  if (boxes.length === 0) return null;
  const left = Math.max(0, Math.min(...boxes.map((box) => box.bounds[0])) - 0.015);
  const bottom = Math.max(0, Math.min(...boxes.map((box) => box.bounds[1])) - 0.015);
  const right = Math.min(1, Math.max(...boxes.map((box) => box.bounds[0] + box.bounds[2])) + 0.015);
  const top = Math.min(1, Math.max(...boxes.map((box) => box.bounds[1] + box.bounds[3])) + 0.015);
  // 区域过大应走显式整页来源升级，不能把重读整页伪装成局部重读。
  if ((right - left) * (top - bottom) > 0.5) return null;
  return [left, bottom, right - left, top - bottom];
}

export interface LocalVisualRegionReadResult {
  span: SourceSpan | null;
  diagnostic: { code: 'LOCAL_VISUAL_REGION_READ' | 'LOCAL_VISUAL_REGION_UNAVAILABLE' | 'LOCAL_VISUAL_REGION_EMPTY' | LocalVisualFailureCode; attempts: number };
}

/** 有界独立重读创建新的受控来源片段，旧文字与旧来源ID不变。 */
export async function rereadLocalVisualRegion(input: {
  span: SourceSpan; image: LocalVisualImage; lineStart: number; lineEnd: number;
  recognize?: (path: string, options: LocalVisualRecognitionOptions) => Promise<LocalVisualReceipt>;
}): Promise<LocalVisualRegionReadResult> {
  const regionBounds = selectLocalVisualRegion(input.span, input.lineStart, input.lineEnd);
  if (!regionBounds || input.span.page !== input.image.page
    || input.image.blockId !== undefined && input.span.blockId !== input.image.blockId) {
    return { span: null, diagnostic: { code: 'LOCAL_VISUAL_REGION_UNAVAILABLE', attempts: 0 } };
  }
  try {
    const receipt = parseReceipt(await (input.recognize ?? recognizeLocalVisualText)(input.image.path, {
      regionBounds, prepared: true, fallbackBudget: 0
    }), 256 * 1024);
    // 边界由本机helper映回原页。区域外返回不能成为这个局部来源的证据。
    if (receipt.lines.some((line) => line.bounds[0] < regionBounds[0] - 0.000001
      || line.bounds[1] < regionBounds[1] - 0.000001
      || line.bounds[0] + line.bounds[2] > regionBounds[0] + regionBounds[2] + 0.000001
      || line.bounds[1] + line.bounds[3] > regionBounds[1] + regionBounds[3] + 0.000001)) {
      throw new LocalVisualRecognitionError('LOCAL_VISUAL_RECEIPT_INVALID');
    }
    const prepared = receiptEvidence(receipt, regionBounds);
    if (!prepared.quote) return { span: null, diagnostic: { code: 'LOCAL_VISUAL_REGION_EMPTY', attempts: 1 } };
    const hash = createHash('sha256').update(JSON.stringify({ source: input.span.id, regionBounds,
      receipt: { ...receipt, fallbackUsed: undefined } })).digest('hex').slice(0, 32);
    return { span: { ...input.span, id: `local-region-${hash}`, spanKind: 'image',
      blockId: `local-vision-region:${input.span.id}`, lineStart: 1, lineEnd: prepared.evidence.rows.length,
      quote: prepared.quote, readability: prepared.evidence.omittedBoxes.length > 0 ? 'partial' : 'clear',
      visualEvidence: prepared.evidence }, diagnostic: { code: 'LOCAL_VISUAL_REGION_READ', attempts: 1 } };
  } catch (error) { return { span: null, diagnostic: { code: classifyLocalVisualRecognitionFailure(error), attempts: 1 } }; }
}
