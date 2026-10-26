import { describe, expect, it } from 'vitest';
import { buildImageManifest } from './index.js';
import { sourceManifestSchema } from '@contracts';
import { classifyLocalVisualRecognitionFailure, enrichManifestWithLocalVisualEvidence,
  LocalVisualRecognitionError, recognizeLocalVisualText, rereadLocalVisualRegion,
  selectLocalVisualRegion, type LocalVisualReceipt } from './local-visual-evidence.js';

const manifest = () => buildImageManifest({ sourceObjectId: 'source-test', documentId: 'document-test',
  sha256: 'a'.repeat(64), mediaType: 'image/png', displayName: '虚构.png', createdAt: '2026-10-13T00:00:00Z' });
describe('独立本地图像文字依据', () => {
  it('保留原图定位并保存可交叉核验原句，日期仍需模型读原图核验', async () => {
    const original = manifest();
    const result = await enrichManifestWithLocalVisualEvidence({ manifest: original, images: [{ path: 'fixture', page: 1 }],
      recognize: async () => ({ version: 1, engine: 'apple-vision-local-v1', lines: [
        { text: '检查日期：2026-07-02', confidence: 0.99, bounds: [0, 0.1, 0.8, 0.1] },
        { text: '无法看清', confidence: 0.1, bounds: [0, 0.2, 0.8, 0.1] }
      ] }) });
    expect(original.spans[0]?.quote).toBeNull();
    expect(result.spans[0]).toMatchObject({ id: original.spans[0]?.id, spanKind: 'image', page: 1,
      quote: '检查日期：2026-07-02', readability: 'partial', lineStart: 1, lineEnd: 1 });
    expect(result.normalizerVersion).toContain('local-visual-evidence-v1');
    expect(result.conversionWarnings).toContain('local_visual_low_confidence_content_not_transcribed');
    expect(result.spans[0]?.visualEvidence).toMatchObject({ version: 1,
      coordinateSystem: 'normalized-bottom-left', reading: { mode: 'full_image', fallbackUsed: false },
      rows: [{ line: 1, bounds: [0, 0.1, 0.8, 0.1], boxes: [{ text: '检查日期：2026-07-02' }] }],
      omittedBoxes: [{ text: '无法看清', confidence: 0.1, bounds: [0, 0.2, 0.8, 0.1] }] });
    expect(sourceManifestSchema.parse(result)).toEqual(result);
  });
  it('中文OCR的低离散评分不会丢掉正确日期，但明确它只是核验依据', async () => {
    const result = await enrichManifestWithLocalVisualEvidence({ manifest: manifest(), images: [{ path: 'fixture', page: 1 }],
      recognize: async () => ({ version: 1, engine: 'apple-vision-local-v1', lines: [
        { text: '检查日期：2026-07-02', confidence: 0.3, bounds: [0, 0.1, 0.8, 0.1] }
      ] }) });
    expect(result.spans[0]?.quote).toBe('检查日期：2026-07-02');
    expect(result.conversionWarnings).toContain('local_visual_text_is_crosscheck_not_confirmed_fact');
  });
  it('引擎不可用或没有可靠文字时不能把图像伪装为clear', async () => {
    const result = await enrichManifestWithLocalVisualEvidence({ manifest: manifest(), images: [{ path: 'fixture', page: 1 }],
      recognize: async () => { throw new Error('LOCAL_VISUAL_ENGINE_UNAVAILABLE'); } });
    expect(result.spans[0]).toMatchObject({ quote: null, readability: 'partial' });
    expect(result.conversionWarnings).toContain('local_visual_engine_unavailable');
  });
  it('不会把另一页的独立识别结果借给当前页', async () => {
    const result = await enrichManifestWithLocalVisualEvidence({ manifest: manifest(), images: [{ path: 'fixture', page: 2 }],
      recognize: async () => { throw new Error('should not run'); } });
    expect(result.spans[0]?.quote).toBeNull();
    expect(result.normalizerVersion).not.toContain('local-visual');
  });
  it('几何乱序的表格仍按实际行入来源quote，但不改项目、数值或单位', async () => {
    const result = await enrichManifestWithLocalVisualEvidence({ manifest: manifest(), images: [{ path: 'fixture', page: 1 }],
      recognize: async () => ({ version: 1, engine: 'apple-vision-local-v1', lines: [
        { text: '7.2', confidence: 0.9, bounds: [0.5, 0.6, 0.12, 0.025] },
        { text: '合成项目甲', confidence: 0.9, bounds: [0.08, 0.7, 0.25, 0.025] },
        { text: 'U/L', confidence: 0.9, bounds: [0.65, 0.7, 0.1, 0.025] },
        { text: '18', confidence: 0.9, bounds: [0.5, 0.7, 0.12, 0.025] },
        { text: '合成项目乙', confidence: 0.9, bounds: [0.08, 0.6, 0.25, 0.025] }
      ] }) });
    expect(result.spans[0]).toMatchObject({ quote: '合成项目甲 18 U/L\n合成项目乙 7.2', lineStart: 1, lineEnd: 2 });
    expect(result.normalizerVersion).toContain('local-visual-layout-v2');
  });
  it('越出图像边界的伪位置不能用于来源绑定', async () => {
    const result = await enrichManifestWithLocalVisualEvidence({ manifest: manifest(), images: [{ path: 'fixture', page: 1 }],
      recognize: async () => ({ version: 1, engine: 'apple-vision-local-v1', lines: [
        { text: '合成项目 18', confidence: 0.9, bounds: [0.9, 0.7, 0.25, 0.025] }
      ] }) });
    expect(result.spans[0]?.quote).toBeNull();
    expect(result.conversionWarnings).toContain('local_visual_recognition_failed');
  });
});

const receipt = (): LocalVisualReceipt => ({ version: 1, engine: 'apple-vision-local-v1',
  imageSize: { width: 1200, height: 1600 }, recognitionRevision: 3,
  lines: [{ text: '合成项目甲 18.2 U/L', confidence: 0.9, bounds: [0.1, 0.7, 0.7, 0.03] }] });

describe('本机识别失败分类及有界重读', () => {
  it('缓冲区与超时被分类，不把含路径或系统描述的错误带出去', () => {
    expect(classifyLocalVisualRecognitionFailure({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stderr: '/private/sensitive' }))
      .toBe('LOCAL_VISUAL_OUTPUT_LIMIT_EXCEEDED');
    expect(classifyLocalVisualRecognitionFailure({ killed: true, signal: 'SIGTERM' })).toBe('LOCAL_VISUAL_TIMEOUT');
    expect(classifyLocalVisualRecognitionFailure({ stderr: 'LOCAL_VISUAL_IMAGE_DECODE_FAILED\n' }))
      .toBe('LOCAL_VISUAL_IMAGE_DECODE_FAILED');
    expect(classifyLocalVisualRecognitionFailure(new Error('secret-path/unknown'))).toBe('LOCAL_VISUAL_RECOGNITION_FAILED');
  });

  it('资源失败后只执行一次标准图像回退，成功回执保留版本与尺寸', async () => {
    const optionsSeen: unknown[] = [];
    const result = await recognizeLocalVisualText('synthetic-only', {}, async (_path, options) => {
      optionsSeen.push(options);
      if (!options.prepared) throw new LocalVisualRecognitionError('LOCAL_VISUAL_TIMEOUT');
      return receipt();
    });
    expect(optionsSeen).toEqual([{}, { prepared: true, fallbackBudget: 0 }]);
    expect(result).toMatchObject({ fallbackUsed: true, imageSize: { width: 1200, height: 1600 }, recognitionRevision: 3 });
  });

  it('两次失败后安全结束，不循环重读，也不宣称原件unreadable', async () => {
    let calls = 0;
    await expect(recognizeLocalVisualText('synthetic-only', {}, async () => {
      calls += 1; throw Object.assign(new Error('contains-private-path'), { code: 'ENOBUFS', stderr: 'private' });
    })).rejects.toMatchObject({ message: 'LOCAL_VISUAL_OUTPUT_LIMIT_EXCEEDED', attempts: 2 });
    expect(calls).toBe(2);
    const result = await enrichManifestWithLocalVisualEvidence({ manifest: manifest(), images: [{ path: 'synthetic-only', page: 1 }],
      recognize: async () => { throw new LocalVisualRecognitionError('LOCAL_VISUAL_OUTPUT_LIMIT_EXCEEDED', 2); } });
    expect(result.spans[0]?.readability).toBe('partial');
    expect(result.conversionWarnings).toContain('local_visual_output_limit_exceeded');
    expect(result.conversionWarnings).not.toContain('local_visual_evidence_unreadable');
  });

  it('引擎缺失不重复启动，非法回执不被当作受控原文', async () => {
    let calls = 0;
    await expect(recognizeLocalVisualText('synthetic-only', {}, async () => {
      calls += 1; throw new LocalVisualRecognitionError('LOCAL_VISUAL_ENGINE_UNAVAILABLE');
    })).rejects.toMatchObject({ code: 'LOCAL_VISUAL_ENGINE_UNAVAILABLE', attempts: 1 });
    expect(calls).toBe(1);
    await expect(recognizeLocalVisualText('synthetic-only', { fallbackBudget: 0 }, async () => ({
      ...receipt(), fabricatedModelReceipt: true
    } as LocalVisualReceipt))).rejects.toMatchObject({ code: 'LOCAL_VISUAL_RECEIPT_INVALID' });
  });

  it('64KiB识别输出不冒充不可读：一次回退允许有界较大本机转写，仍不截掉尾部', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => ({ text: `${i}${'合成正文'.repeat(500)}`, confidence: 0.9,
      bounds: [0.1, 0.02 + i * 0.04, 0.7, 0.025] as [number, number, number, number] }));
    let calls = 0;
    const result = await recognizeLocalVisualText('synthetic-only', {}, async () => {
      calls += 1; return { ...receipt(), lines };
    });
    expect(calls).toBe(2);
    expect(result).toMatchObject({ fallbackUsed: true, lines });
  });

  it('低置信度否定框保留供疑点重读，不能标为完整clear', async () => {
    const result = await enrichManifestWithLocalVisualEvidence({ manifest: manifest(), images: [{ path: 'synthetic-only', page: 1 }],
      recognize: async () => ({ ...receipt(), lines: [...receipt().lines,
        { text: '未见', confidence: 0.1, bounds: [0.04, 0.7, 0.05, 0.03] }] }) });
    expect(result.spans[0]?.readability).toBe('partial');
    expect(result.spans[0]?.visualEvidence?.omittedBoxes[0]?.text).toBe('未见');
  });

  it('局部重读只用原行框，严格一次，并保留旧quote和原页坐标', async () => {
    const prepared = await enrichManifestWithLocalVisualEvidence({ manifest: manifest(), images: [{ path: 'synthetic-only', page: 1 }],
      recognize: async () => receipt() });
    const span = prepared.spans[0]!;
    const before = JSON.stringify(span);
    let calls = 0;
    const result = await rereadLocalVisualRegion({ span, image: { path: 'synthetic-only', page: 1 }, lineStart: 1, lineEnd: 1,
      recognize: async (_path, options) => {
        calls += 1;
        expect(options).toMatchObject({ prepared: true, fallbackBudget: 0 });
        expect(options.regionBounds).toEqual(selectLocalVisualRegion(span, 1, 1));
        return receipt();
      } });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ diagnostic: { code: 'LOCAL_VISUAL_REGION_READ', attempts: 1 },
      span: { blockId: `local-vision-region:${span.id}`, quote: span.quote, page: 1,
        visualEvidence: { reading: { mode: 'region' }, rows: [{ boxes: receipt().lines }] } } });
    expect(result.span?.id).not.toBe(span.id);
    expect(JSON.stringify(span)).toBe(before);
    expect(selectLocalVisualRegion(result.span!, 1, 1)).toBeNull();
    expect(sourceManifestSchema.parse({ ...prepared, spans: [...prepared.spans, result.span] })).toBeTruthy();
  });

  it('拒绝错页、区域外回执、缺几何和超大区域，不猜模型希望的数值位置', async () => {
    const prepared = await enrichManifestWithLocalVisualEvidence({ manifest: manifest(), images: [{ path: 'synthetic-only', page: 1 }],
      recognize: async () => receipt() });
    const span = prepared.spans[0]!;
    const invalidPage = await rereadLocalVisualRegion({ span, image: { path: 'synthetic-only', page: 2 }, lineStart: 1, lineEnd: 1,
      recognize: async () => { throw new Error('should-not-run'); } });
    expect(invalidPage.diagnostic).toEqual({ code: 'LOCAL_VISUAL_REGION_UNAVAILABLE', attempts: 0 });
    const outside = await rereadLocalVisualRegion({ span, image: { path: 'synthetic-only', page: 1 }, lineStart: 1, lineEnd: 1,
      recognize: async () => ({ ...receipt(), lines: [{ text: '合成另一区域', confidence: 0.9, bounds: [0.1, 0.1, 0.7, 0.03] }] }) });
    expect(outside.diagnostic).toEqual({ code: 'LOCAL_VISUAL_RECEIPT_INVALID', attempts: 1 });
    expect(selectLocalVisualRegion(manifest().spans[0]!, 1, 1)).toBeNull();
    expect(selectLocalVisualRegion(span, 1, 10)).toBeNull();
  });
});
