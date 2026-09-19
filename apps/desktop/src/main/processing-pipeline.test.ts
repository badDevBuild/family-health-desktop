import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtractionResult } from '@contracts';
import { PersonalWorkspaceService } from './workspace-service.js';
import { compareIndependentExtractions, DocumentExtractionPipeline, partitionPdfSpans, partitionSourceSpans } from './processing-pipeline.js';

const roots: string[] = [];
const require = createRequire(import.meta.url);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'family-health-pipeline-'));
  roots.push(root);
  const service = new PersonalWorkspaceService(root, '测试工作区', () => new Date('2026-09-18T00:00:00Z'));
  const personId = service.ensurePrimaryMember({ displayName: '测试成员', relation: '本人' });
  await service.importFiles([{ path: '/tmp/虚构报告.txt', bytes: Buffer.from('姓名：测试姓名甲 性别：男\n2026-09-17 低密度脂蛋白胆固醇 4.2 mmol/L，参考范围 0-3.4 mmol/L') }], personId);
  const documentId = service.getSnapshot(null).inbox[0]!.id;
  const spans = service.store.getDocumentExtractionBundle(documentId).manifest.spans;
  const subjectSpanId = spans.find((span) => span.quote?.includes('测试姓名甲'))!.id;
  const measurementSpanId = spans.find((span) => span.quote?.includes('低密度脂蛋白'))!.id;
  const output: ExtractionResult = {
    schemaVersion: 1,
    documentId,
    subject: { reportedName: null, evidence: [], confidence: 'absent' },
    coveredSourceSpanIds: spans.map((span) => span.id),
    candidates: [{
      localKey: 'ldl-1',
      originalName: '低密度脂蛋白胆固醇',
      standardNameCandidate: 'LDL-C',
      value: { kind: 'numeric', rawText: '4.2', decimal: '4.2', comparator: 'eq' },
      unitRaw: 'mmol/L',
      referenceRangeRaw: '0-3.4 mmol/L',
      reportedAbnormalFlag: '偏高',
      specimen: null,
      method: null,
      bodySite: null,
      clinicalDate: '2026-09-17',
      evidence: [{ sourceSpanId: measurementSpanId, quote: '2026-09-17 低密度脂蛋白胆固醇 4.2 mmol/L' }],
      issues: []
    }]
  };
  return { service, personId, documentId, output, subjectSpanId };
}

function createScannedLikePdf(): Uint8Array {
  const content = 'q 0.9 0.9 0.9 rg 0 0 612 792 re f 0 0 0 rg 72 680 300 24 re f Q';
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

function createTextPdf(text: string): Uint8Array {
  const escaped = text.replace(/[()\\]/g, (character) => `\\${character}`);
  const content = `BT /F1 12 Tf 10 70 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
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

describe('DocumentExtractionPipeline', () => {
  it('旧版 PDF 缺少清单元数据时重读原文件核对，不再误拦截为覆盖缺口', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-legacy-pdf-pipeline-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '旧版 PDF 工作区', () => new Date('2026-09-18T00:00:00Z'));
    const personId = service.ensurePrimaryMember({ displayName: '测试成员', relation: '本人' });
    const receipt = await service.importFiles([{
      path: '/tmp/legacy-report.pdf',
      bytes: createTextPdf('LDL 4.2 mmol/L')
    }], personId);
    expect(receipt.rejected).toEqual([]);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    const span = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!;
    const database = new Database(service.store.databasePath);
    database.prepare('DELETE FROM source_manifests WHERE document_id = ?').run(documentId);
    database.close();
    expect(service.store.getDocumentExtractionBundle(documentId).manifest.conversionWarnings)
      .toContain('historical_manifest_metadata_unavailable');

    const output: ExtractionResult = {
      schemaVersion: 1,
      documentId,
      subject: { reportedName: null, evidence: [], confidence: 'absent' },
      coveredSourceSpanIds: [span.id],
      candidates: [{
        localKey: 'legacy-ldl', originalName: 'LDL', standardNameCandidate: 'LDL-C',
        value: { kind: 'numeric', rawText: '4.2', decimal: '4.2', comparator: 'eq' },
        unitRaw: 'mmol/L', referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: null, bodySite: null, clinicalDate: null,
        evidence: [{ sourceSpanId: span.id, quote: 'LDL 4.2 mmol/L' }], issues: []
      }]
    };
    let turns = 0;
    const pipeline = new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async () => ({ threadId: 'legacy-thread', turnId: `legacy-turn-${++turns}`, output })
    });
    await expect(pipeline.process(documentId)).resolves.toMatchObject({ status: 'published', candidateCount: 1 });
    expect(turns).toBe(2);
    expect(service.store.getDocumentExtractionBundle(documentId).manifest).toMatchObject({
      totalUnits: 1,
      coveredUnitIndexes: [0],
      conversionWarnings: ['historical_manifest_reconstructed_from_verified_pdf']
    });
    expect(service.store.listOpenExtractionReviewIssues()).toEqual([]);
    service.close();
  });

  it('DOCX 嵌入图会带着对应 source span 进入两次独立视觉读取，完成后清理', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-docx-pipeline-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, 'DOCX 工作区', () => new Date('2026-09-18T00:00:00Z'));
    const personId = service.ensurePrimaryMember({ displayName: '测试成员', relation: '本人' });
    const fixturePath = join(dirname(require.resolve('mammoth/package.json')), 'test', 'test-data', 'tiny-picture.docx');
    const receipt = await service.importFiles([{ path: '/tmp/含图虚构报告.docx', bytes: readFileSync(fixturePath) }], personId);
    expect(receipt.rejected).toEqual([]);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    const manifest = service.store.getDocumentExtractionBundle(documentId).manifest;
    const imageSpan = manifest.spans.find((span) => span.spanKind === 'image')!;
    const output: ExtractionResult = {
      schemaVersion: 1,
      documentId,
      subject: { reportedName: null, evidence: [], confidence: 'absent' },
      coveredSourceSpanIds: manifest.spans.map((span) => span.id),
      candidates: [{
        localKey: 'visual-fixture-1', originalName: '虚构图示数值', standardNameCandidate: null,
        value: { kind: 'numeric', rawText: '1', decimal: '1', comparator: 'eq' },
        unitRaw: null, referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: null, bodySite: null, clinicalDate: null,
        evidence: [{ sourceSpanId: imageSpan.id, quote: null }], issues: []
      }]
    };
    const observedPaths: string[] = [];
    let turn = 0;
    const pipeline = new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async (input) => {
        expect(input.imagePaths).toHaveLength(1);
        expect(input.timeoutMs).toBe(600_000);
        expect(existsSync(input.imagePaths![0]!)).toBe(true);
        expect(input.prompt).toContain(imageSpan.id);
        observedPaths.push(input.imagePaths![0]!);
        return { threadId: `docx-thread-${turn}`, turnId: `docx-turn-${++turn}`, output };
      }
    });
    await expect(pipeline.process(documentId)).resolves.toMatchObject({ status: 'published', candidateCount: 1 });
    expect(observedPaths).toHaveLength(2);
    expect(observedPaths[0]).toBe(observedPaths[1]);
    expect(existsSync(observedPaths[0]!)).toBe(false);
    service.close();
  });

  it('扫描 PDF 页会渲染成临时图片供两次独立读取，成功后清理', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-scanned-pipeline-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '扫描件工作区', () => new Date('2026-09-18T00:00:00Z'));
    const personId = service.ensurePrimaryMember({ displayName: '测试成员', relation: '本人' });
    const receipt = await service.importFiles([{ path: '/tmp/扫描件.pdf', bytes: createScannedLikePdf() }], personId);
    expect(receipt.rejected).toEqual([]);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    const spanId = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!.id;
    const output: ExtractionResult = {
      schemaVersion: 1,
      documentId,
      subject: { reportedName: null, evidence: [], confidence: 'absent' },
      coveredSourceSpanIds: [spanId],
      candidates: [{
        localKey: 'visual-ldl-1', originalName: '低密度脂蛋白胆固醇', standardNameCandidate: 'LDL-C',
        value: { kind: 'numeric', rawText: '4.2', decimal: '4.2', comparator: 'eq' },
        unitRaw: 'mmol/L', referenceRangeRaw: '0-3.4 mmol/L', reportedAbnormalFlag: '偏高',
        specimen: null, method: null, bodySite: null, clinicalDate: '2026-09-17',
        evidence: [{ sourceSpanId: spanId, quote: null }], issues: []
      }]
    };
    const observedPaths: string[] = [];
    let turn = 0;
    const pipeline = new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async (input) => {
        expect(input.imagePaths).toHaveLength(1);
        expect(existsSync(input.imagePaths![0]!)).toBe(true);
        observedPaths.push(input.imagePaths![0]!);
        return { threadId: `scan-thread-${turn}`, turnId: `scan-turn-${++turn}`, output };
      }
    });
    await expect(pipeline.process(documentId)).resolves.toMatchObject({ status: 'published', candidateCount: 1 });
    expect(observedPaths).toHaveLength(2);
    expect(observedPaths[0]).toBe(observedPaths[1]);
    expect(existsSync(observedPaths[0]!)).toBe(false);
    service.close();
  });

  it('扫描页分块时每次最多携带八个视觉页且不遗漏 source span', () => {
    const spans = Array.from({ length: 17 }, (_, index) => ({
      id: `span-${index + 1}`, documentId: 'doc', spanKind: 'page' as const, page: index + 1,
      blockId: null, lineStart: null, lineEnd: null, quote: null, readability: 'unreadable' as const
    }));
    const chunks = partitionPdfSpans(spans);
    expect(chunks.map((chunk) => chunk.length)).toEqual([8, 8, 1]);
    expect(chunks.flat().map((span) => span.id)).toEqual(spans.map((span) => span.id));
  });

  it('PDF 文字层清晰且未触发硬上限时保持整篇处理', () => {
    const spans = Array.from({ length: 17 }, (_, index) => ({
      id: `text-page-${index + 1}`, documentId: 'doc', spanKind: 'page' as const, page: index + 1,
      blockId: null, lineStart: null, lineEnd: null, quote: '虚构体检文字', readability: 'clear' as const
    }));
    expect(partitionPdfSpans(spans).map((chunk) => chunk.length)).toEqual([17]);
  });

  it('文本片段也按统一的每轮数量预算分块', () => {
    const spans = Array.from({ length: 81 }, (_, index) => ({
      id: `text-${index + 1}`, documentId: 'doc', spanKind: 'line' as const, page: null,
      blockId: null, lineStart: index + 1, lineEnd: index + 1, quote: '虚构指标 1.0', readability: 'clear' as const
    }));
    const chunks = partitionSourceSpans(spans);
    expect(chunks.map((chunk) => chunk.length)).toEqual([40, 40, 1]);
    expect(chunks.flat().map((span) => span.id)).toEqual(spans.map((span) => span.id));
  });

  it('只有独立复核一致且证据有效时才正式发布', async () => {
    const { service, personId, documentId, output } = await setup();
    let turn = 0;
    const pipeline = new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async () => ({ threadId: `thread-${turn}`, turnId: `turn-${++turn}`, output })
    });
    await expect(pipeline.process(documentId)).resolves.toMatchObject({ status: 'published', candidateCount: 1, revision: 1 });
    expect(service.store.getFactRevision(personId)).toBe(1);
    expect(service.getSnapshot(null).inbox[0]).toMatchObject({ status: 'completed' });
    expect(service.store.listAcceptedObservations(personId)[0]).toMatchObject({
      conceptKey: 'LDL-C', clinicalDate: '2026-09-17', abnormalFlag: 'high', documentId
    });
    expect(service.getSnapshot(null)).toMatchObject({
      persons: [expect.objectContaining({ id: personId, attentionCount: 1, lastDocumentDate: '2026-09-17' })],
      trends: [expect.objectContaining({ personId, name: 'LDL-C', points: [expect.objectContaining({ numericValue: 4.2, referenceHigh: 3.4, abnormalFlag: 'high' })] })],
      timeline: [expect.objectContaining({ personId, type: 'health_report', date: '2026-09-17', documentId })]
    });
    service.close();
  });

  it('独立复核不一致时转人工核对且不发布', async () => {
    const { service, personId, documentId, output } = await setup();
    let turn = 0;
    const pipeline = new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async () => ({
        threadId: `thread-${turn}`,
        turnId: `turn-${++turn}`,
        output: turn === 1 ? output : { ...output, candidates: [] }
      })
    });
    await expect(pipeline.process(documentId)).resolves.toMatchObject({ status: 'needs_review', reason: 'INDEPENDENT_REVIEW_MISMATCH' });
    expect(service.store.getFactRevision(personId)).toBe(0);
    expect(service.getSnapshot(null).inbox[0]).toMatchObject({ status: 'needs_review' });
    const issue = service.store.listOpenExtractionReviewIssues()[0]!;
    expect(issue.candidateOptions).toHaveLength(1);
    expect(issue.candidateDiffs).toEqual([expect.objectContaining({ itemName: '低密度脂蛋白胆固醇', fields: ['presence'] })]);
    service.acceptCorrectedFacts({ issueId: issue.id, documentId, candidates: issue.candidateOptions });
    expect(service.store.getFactRevision(personId)).toBe(1);
    expect(service.getSnapshot(null).inbox[0]).toMatchObject({ status: 'completed' });
    service.close();
  });

  it('两轮仅证据摘录或单侧可选元数据不同时继续发布', async () => {
    const { service, personId, documentId, output } = await setup();
    const first: ExtractionResult = {
      ...output,
      candidates: output.candidates.map((candidate) => ({ ...candidate, specimen: '血' }))
    };
    const second: ExtractionResult = {
      ...output,
      candidates: output.candidates.map((candidate) => ({
        ...candidate,
        clinicalDate: null,
        evidence: candidate.evidence.map((reference) => ({ ...reference, quote: '低密度脂蛋白胆固醇 4.2 mmol/L' }))
      }))
    };
    let turn = 0;
    const pipeline = new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async () => ({
        threadId: `soft-diff-thread-${turn}`,
        turnId: `soft-diff-turn-${++turn}`,
        output: turn === 1 ? first : second
      })
    });

    await expect(pipeline.process(documentId)).resolves.toMatchObject({ status: 'published', candidateCount: 1 });
    expect(service.store.getFactRevision(personId)).toBe(1);
    expect(service.store.listOpenExtractionReviewIssues()).toEqual([]);
    service.close();
  });

  it('两轮只有一侧给出参考范围时保守留空并继续发布', async () => {
    const { service, personId, documentId, output } = await setup();
    const withoutReferenceRange: ExtractionResult = {
      ...output,
      candidates: output.candidates.map((candidate) => ({ ...candidate, referenceRangeRaw: null }))
    };
    let turn = 0;
    const pipeline = new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async () => ({
        threadId: `one-sided-range-thread-${turn}`,
        turnId: `one-sided-range-turn-${++turn}`,
        output: turn === 1 ? output : withoutReferenceRange
      })
    });

    await expect(pipeline.process(documentId)).resolves.toMatchObject({ status: 'published', candidateCount: 1 });
    expect(service.store.listOpenExtractionReviewIssues()).toEqual([]);
    expect(service.store.listAcceptedObservations(personId)).toEqual([
      expect.objectContaining({ conceptKey: 'LDL-C', decimalValue: '4.2', referenceRange: null })
    ]);
    service.close();
  });

  it('同一来源内前后片段唯一的省略证据会展开为连续原文', async () => {
    const { service, personId, documentId, output } = await setup();
    const abbreviated: ExtractionResult = {
      ...output,
      candidates: output.candidates.map((item) => ({
        ...item,
        evidence: item.evidence.map((reference) => ({
          ...reference,
          quote: '2026-09-17…低密度脂蛋白胆固醇 4.2 mmol/L'
        }))
      }))
    };
    let turn = 0;
    const pipeline = new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async () => ({
        threadId: `abbreviated-evidence-thread-${turn}`,
        turnId: `abbreviated-evidence-turn-${++turn}`,
        output: turn === 1 ? output : abbreviated
      })
    });

    await expect(pipeline.process(documentId)).resolves.toMatchObject({ status: 'published', candidateCount: 1 });
    expect(service.store.listAcceptedObservations(personId)).toHaveLength(1);
    expect(service.store.listOpenExtractionReviewIssues()).toEqual([]);
    service.close();
  });

  it('省略证据的结尾在后续科室重复时，只在下一科室日期前展开', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-section-abbreviation-pipeline-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '分科证据工作区', () => new Date('2026-09-18T00:00:00Z'));
    const personId = service.ensurePrimaryMember({ displayName: '测试成员', relation: '本人' });
    const sourceText = '内科 内科 检查日期：2023-10-08 心脏未见异常 小结 未见异常 外科 外科 检查日期：2023-10-08 皮肤无异常 小结 未见异常';
    await service.importFiles([{ path: '/tmp/分科报告.txt', bytes: Buffer.from(sourceText) }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    const span = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!;
    const base: ExtractionResult = {
      schemaVersion: 1,
      documentId,
      subject: { reportedName: null, evidence: [], confidence: 'absent' },
      coveredSourceSpanIds: [span.id],
      candidates: [{
        localKey: 'internal-summary', originalName: '内科小结', standardNameCandidate: null,
        value: { kind: 'qualitative', rawText: '未见异常', category: 'no abnormality detected' },
        unitRaw: null, referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: null, bodySite: null, clinicalDate: '2023-10-08',
        evidence: [{ sourceSpanId: span.id, quote: '内科 内科 检查日期：2023-10-08 心脏未见异常 小结 未见异常' }],
        issues: []
      }]
    };
    const abbreviated: ExtractionResult = {
      ...base,
      candidates: base.candidates.map((candidate) => ({
        ...candidate,
        evidence: [{ sourceSpanId: span.id, quote: '内科 内科 检查日期：2023-10-08……小结 未见异常' }]
      }))
    };
    let turn = 0;
    const pipeline = new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async () => ({
        threadId: `section-abbreviation-thread-${turn}`,
        turnId: `section-abbreviation-turn-${++turn}`,
        output: turn === 1 ? base : abbreviated
      })
    });

    await expect(pipeline.process(documentId)).resolves.toMatchObject({ status: 'published', candidateCount: 1 });
    expect(service.store.listAcceptedObservations(personId)).toHaveLength(1);
    expect(service.store.listOpenExtractionReviewIssues()).toEqual([]);
    service.close();
  });

  it('同一事实的彩超与多普勒超声写法视为同一方法，真正不同的影像方法仍阻断', async () => {
    const { service, output } = await setup();
    const withMethod = (method: string): ExtractionResult => ({
      ...output,
      candidates: output.candidates.map((candidate) => ({ ...candidate, method }))
    });

    expect(compareIndependentExtractions(
      withMethod('甲状腺彩超'),
      withMethod('彩色多普勒超声检查')
    )).toEqual({ compatible: true, differences: [] });
    expect(compareIndependentExtractions(
      withMethod('胸部 CT'),
      withMethod('胸部 MRI')
    )).toEqual({
      compatible: false,
      differences: [expect.objectContaining({ fields: ['method'] })]
    });
    service.close();
  });

  it('单轮额外提取的正常小结静默省略，异常小结仍要求核对', async () => {
    const first = await setup();
    const normalSummary = {
      ...first.output.candidates[0]!,
      localKey: 'eye-summary',
      originalName: '眼科小结',
      standardNameCandidate: 'Ophthalmology summary',
      value: { kind: 'qualitative' as const, rawText: '未见异常', category: 'no abnormality detected' },
      unitRaw: null,
      referenceRangeRaw: null,
      reportedAbnormalFlag: null
    };
    let turn = 0;
    const normalPipeline = new DocumentExtractionPipeline(first.service.store, {
      runStructuredTurn: async () => ({
        threadId: `normal-summary-thread-${turn}`,
        turnId: `normal-summary-turn-${++turn}`,
        output: turn === 1
          ? { ...first.output, candidates: [...first.output.candidates, normalSummary] }
          : first.output
      })
    });
    await expect(normalPipeline.process(first.documentId)).resolves.toMatchObject({ status: 'published', candidateCount: 1 });
    expect(first.service.store.listAcceptedObservations(first.personId)).toHaveLength(1);
    first.service.close();

    const second = await setup();
    const abnormalSummary = {
      ...second.output.candidates[0]!,
      localKey: 'thyroid-summary',
      originalName: '甲状腺彩超小结',
      standardNameCandidate: 'Thyroid ultrasound impression',
      value: { kind: 'text' as const, rawText: '甲状腺回声异常' },
      unitRaw: null,
      referenceRangeRaw: null,
      reportedAbnormalFlag: '异常'
    };
    turn = 0;
    const abnormalPipeline = new DocumentExtractionPipeline(second.service.store, {
      runStructuredTurn: async () => ({
        threadId: `abnormal-summary-thread-${turn}`,
        turnId: `abnormal-summary-turn-${++turn}`,
        output: turn === 1
          ? { ...second.output, candidates: [...second.output.candidates, abnormalSummary] }
          : second.output
      })
    });
    await expect(abnormalPipeline.process(second.documentId)).resolves.toMatchObject({
      status: 'needs_review', reason: 'INDEPENDENT_REVIEW_MISMATCH'
    });
    expect(second.service.store.getFactRevision(second.personId)).toBe(0);
    second.service.close();
  });

  it('单轮把空白栏识别成未知时静默省略，已填写事实仍正常发布', async () => {
    const { service, personId, documentId, output } = await setup();
    const emptyUnknown = {
      ...output.candidates[0]!,
      localKey: 'uncorrected-visual-acuity-right',
      originalName: '裸眼视力 (右)',
      standardNameCandidate: 'uncorrected_visual_acuity_right',
      value: { kind: 'unknown' as const, rawText: null, reason: '报告对应栏位为空白' },
      unitRaw: null,
      referenceRangeRaw: null,
      reportedAbnormalFlag: null,
      issues: []
    };
    let turn = 0;
    const pipeline = new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async () => ({
        threadId: `empty-unknown-thread-${turn}`,
        turnId: `empty-unknown-turn-${++turn}`,
        output: turn === 1
          ? { ...output, candidates: [...output.candidates, emptyUnknown] }
          : output
      })
    });

    await expect(pipeline.process(documentId)).resolves.toMatchObject({ status: 'published', candidateCount: 1 });
    expect(service.store.listAcceptedObservations(personId)).toHaveLength(1);
    expect(service.store.listOpenExtractionReviewIssues()).toEqual([]);
    service.close();
  });

  it('明确标出收缩压和舒张压的组合值会稳定拆为两个数值事实', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-blood-pressure-pipeline-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '血压规范化工作区', () => new Date('2026-09-18T00:00:00Z'));
    const personId = service.ensurePrimaryMember({ displayName: '测试成员', relation: '本人' });
    const sourceText = '检查日期 2023-10-08 血压 107/70 mmHg 收缩压 107 mmHg 舒张压 70 mmHg';
    await service.importFiles([{ path: '/tmp/血压报告.txt', bytes: Buffer.from(sourceText) }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    const span = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!;
    const shared = {
      unitRaw: 'mmHg', referenceRangeRaw: null, reportedAbnormalFlag: null,
      specimen: null, method: null, bodySite: null, clinicalDate: '2023-10-08',
      evidence: [{ sourceSpanId: span.id, quote: sourceText }]
    };
    const base: Omit<ExtractionResult, 'candidates'> = {
      schemaVersion: 1,
      documentId,
      subject: { reportedName: null, evidence: [], confidence: 'absent' },
      coveredSourceSpanIds: [span.id]
    };
    const combined: ExtractionResult = {
      ...base,
      candidates: [{
        localKey: 'blood-pressure', originalName: '血压', standardNameCandidate: '血压',
        value: { kind: 'text', rawText: '107/70' }, ...shared,
        issues: [{ code: 'pair_value_preserved', message: '保留报告中的成对表达' }]
      }]
    };
    const separated: ExtractionResult = {
      ...base,
      candidates: [
        {
          localKey: 'model-sbp', originalName: '收缩压', standardNameCandidate: 'SBP',
          value: { kind: 'numeric', rawText: '107', decimal: '107', comparator: 'eq' }, ...shared, issues: []
        },
        {
          localKey: 'model-dbp', originalName: '舒张压', standardNameCandidate: 'DBP',
          value: { kind: 'numeric', rawText: '70', decimal: '70', comparator: 'eq' }, ...shared, issues: []
        }
      ]
    };
    let turn = 0;
    const pipeline = new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async () => ({
        threadId: `bp-thread-${turn}`,
        turnId: `bp-turn-${++turn}`,
        output: turn === 1 ? combined : separated
      })
    });

    await expect(pipeline.process(documentId)).resolves.toMatchObject({ status: 'published', candidateCount: 2 });
    expect(service.store.listAcceptedObservations(personId)).toEqual([
      expect.objectContaining({ conceptKey: '收缩压', valueKind: 'numeric', decimalValue: '107', unit: 'mmHg', clinicalDate: '2023-10-08' }),
      expect.objectContaining({ conceptKey: '舒张压', valueKind: 'numeric', decimalValue: '70', unit: 'mmHg', clinicalDate: '2023-10-08' })
    ]);
    expect(service.store.listOpenExtractionReviewIssues()).toEqual([]);
    service.close();
  });

  it('同一清晰来源片段只有一个日期时会补齐日期上下文而不要求人工确认', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-date-context-pipeline-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '日期上下文工作区', () => new Date('2026-09-18T00:00:00Z'));
    const personId = service.ensurePrimaryMember({ displayName: '测试成员', relation: '本人' });
    const sourceText = '检查日期：2023-10-08 检查结果 身高 187 厘米';
    await service.importFiles([{ path: '/tmp/身高报告.txt', bytes: Buffer.from(sourceText) }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    const span = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!;
    const output: ExtractionResult = {
      schemaVersion: 1,
      documentId,
      subject: { reportedName: null, evidence: [], confidence: 'absent' },
      coveredSourceSpanIds: [span.id],
      candidates: [{
        localKey: 'height', originalName: '身高', standardNameCandidate: 'Height',
        value: { kind: 'numeric', rawText: '187', decimal: '187', comparator: 'eq' },
        unitRaw: '厘米', referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: null, bodySite: null, clinicalDate: '2023-10-08',
        evidence: [{ sourceSpanId: span.id, quote: '身高 187 厘米' }], issues: []
      }]
    };
    let turn = 0;
    const pipeline = new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async () => ({ threadId: 'date-context-thread', turnId: `date-context-turn-${++turn}`, output })
    });

    await expect(pipeline.process(documentId)).resolves.toMatchObject({ status: 'published', candidateCount: 1 });
    expect(service.store.listAcceptedObservations(personId)).toEqual([
      expect.objectContaining({ conceptKey: 'Height', decimalValue: '187', clinicalDate: '2023-10-08' })
    ]);
    expect(service.store.listOpenExtractionReviewIssues()).toEqual([]);
    service.close();
  });

  it('同一长来源片段包含多个科室日期时按项目之前最近的检查日期补齐证据', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-section-date-context-pipeline-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '科室日期上下文工作区', () => new Date('2026-09-18T00:00:00Z'));
    const personId = service.ensurePrimaryMember({ displayName: '测试成员', relation: '本人' });
    const sourceText = '检验科 幽门螺菌尿素酶抗体 检查日期：2023-10-08 项目名称 检查结果 幽门螺杆菌抗体测定 阴性 阴性 (-) 检验科 EB 病毒抗体 检查日期：2023-10-09 项目名称 检查结果 EB 病毒抗体 0.05';
    await service.importFiles([{ path: '/tmp/多科室报告.txt', bytes: Buffer.from(sourceText) }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    const span = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!;
    const output: ExtractionResult = {
      schemaVersion: 1,
      documentId,
      subject: { reportedName: null, evidence: [], confidence: 'absent' },
      coveredSourceSpanIds: [span.id],
      candidates: [{
        localKey: 'h-pylori', originalName: '幽门螺杆菌抗体测定', standardNameCandidate: null,
        value: { kind: 'qualitative', rawText: '阴性', category: 'negative' },
        unitRaw: null, referenceRangeRaw: '阴性 (-)', reportedAbnormalFlag: null,
        specimen: null, method: null, bodySite: null, clinicalDate: '2023-10-08',
        evidence: [{ sourceSpanId: span.id, quote: '幽门螺杆菌抗体测定 阴性 阴性 (-)' }], issues: []
      }]
    };
    let turn = 0;
    const pipeline = new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async () => ({ threadId: 'section-date-thread', turnId: `section-date-turn-${++turn}`, output })
    });

    await expect(pipeline.process(documentId)).resolves.toMatchObject({ status: 'published', candidateCount: 1 });
    expect(service.store.listAcceptedObservations(personId)).toEqual([
      expect.objectContaining({ conceptKey: '幽门螺杆菌抗体测定', rawText: '阴性', clinicalDate: '2023-10-08' })
    ]);
    expect(service.store.listOpenExtractionReviewIssues()).toEqual([]);
    service.close();
  });

  it('同一项目文字在不同日期重复出现时不自动补齐临床日期', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-ambiguous-date-pipeline-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '多日期工作区', () => new Date('2026-09-18T00:00:00Z'));
    const personId = service.ensurePrimaryMember({ displayName: '测试成员', relation: '本人' });
    const sourceText = '检查日期：2023-10-08 身高 187 厘米；检查日期：2024-10-08 身高 187 厘米';
    await service.importFiles([{ path: '/tmp/多日期报告.txt', bytes: Buffer.from(sourceText) }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    const span = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!;
    const output: ExtractionResult = {
      schemaVersion: 1,
      documentId,
      subject: { reportedName: null, evidence: [], confidence: 'absent' },
      coveredSourceSpanIds: [span.id],
      candidates: [{
        localKey: 'height', originalName: '身高', standardNameCandidate: 'Height',
        value: { kind: 'numeric', rawText: '187', decimal: '187', comparator: 'eq' },
        unitRaw: '厘米', referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: null, bodySite: null, clinicalDate: '2023-10-08',
        evidence: [{ sourceSpanId: span.id, quote: '身高 187 厘米' }], issues: []
      }]
    };
    let turn = 0;
    const pipeline = new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async () => ({ threadId: 'ambiguous-date-thread', turnId: `ambiguous-date-turn-${++turn}`, output })
    });

    await expect(pipeline.process(documentId)).resolves.toMatchObject({
      status: 'needs_review', reason: 'clinical_date_not_in_evidence'
    });
    expect(service.store.getFactRevision(personId)).toBe(0);
    expect(service.store.listAcceptedObservations(personId)).toEqual([]);
    service.close();
  });

  it('非阻断数据标记的写法差异不要求人工确认，阻断标记仍保持失败关闭', async () => {
    const { service, personId, documentId, output } = await setup();
    const withIssue = (code: string): ExtractionResult => ({
      ...output,
      candidates: output.candidates.map((candidate) => ({
        ...candidate,
        issues: [{ code, message: '虚构测试标记' }]
      }))
    });
    let turn = 0;
    const nonBlockingPipeline = new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async () => ({
        threadId: `non-blocking-thread-${turn}`,
        turnId: `non-blocking-turn-${++turn}`,
        output: turn === 1 ? withIssue('format_note') : output
      })
    });
    await expect(nonBlockingPipeline.process(documentId)).resolves.toMatchObject({ status: 'published' });
    expect(service.store.getFactRevision(personId)).toBe(1);
    service.close();

    const second = await setup();
    turn = 0;
    const blockingPipeline = new DocumentExtractionPipeline(second.service.store, {
      runStructuredTurn: async () => ({
        threadId: `blocking-thread-${turn}`,
        turnId: `blocking-turn-${++turn}`,
        output: turn === 1
          ? { ...second.output, candidates: second.output.candidates.map((candidate) => ({ ...candidate, issues: [{ code: 'blocking_source_ambiguity', message: '来源仍有歧义' }] })) }
          : second.output
      })
    });
    await expect(blockingPipeline.process(second.documentId)).resolves.toMatchObject({ status: 'needs_review', reason: 'INDEPENDENT_REVIEW_MISMATCH' });
    expect(second.service.store.getFactRevision(second.personId)).toBe(0);
    expect(second.service.store.listOpenExtractionReviewIssues()[0]!.candidateDiffs)
      .toEqual([{ localKey: 'ldl-1', itemName: '低密度脂蛋白胆固醇', fields: ['issues'] }]);
    second.service.close();
  });

  it('定性原文一致且只有一轮补充标准分类时继续发布', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-qualitative-category-pipeline-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '定性分类工作区', () => new Date('2026-09-18T00:00:00Z'));
    const personId = service.ensurePrimaryMember({ displayName: '测试成员', relation: '本人' });
    const sourceText = '检查日期：2023-10-08 尿白细胞 (LEU) 隂性';
    await service.importFiles([{ path: '/tmp/尿常规报告.txt', bytes: Buffer.from(sourceText) }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    const span = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!;
    const candidate = {
      localKey: 'urine-leukocyte', originalName: '尿白细胞 (LEU)', standardNameCandidate: null,
      unitRaw: null, referenceRangeRaw: '隂性', reportedAbnormalFlag: null,
      specimen: '尿液', method: '尿常规', bodySite: null, clinicalDate: '2023-10-08',
      evidence: [{ sourceSpanId: span.id, quote: sourceText }], issues: []
    } as const;
    const base: Omit<ExtractionResult, 'candidates'> = {
      schemaVersion: 1,
      documentId,
      subject: { reportedName: null, evidence: [], confidence: 'absent' },
      coveredSourceSpanIds: [span.id]
    };
    let turn = 0;
    const pipeline = new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async () => ({
        threadId: 'qualitative-category-thread',
        turnId: `qualitative-category-turn-${++turn}`,
        output: {
          ...base,
          candidates: [{
            ...candidate,
            value: { kind: 'qualitative' as const, rawText: '隂性', category: turn === 1 ? null : '阴性' }
          }]
        }
      })
    });

    await expect(pipeline.process(documentId)).resolves.toMatchObject({ status: 'published', candidateCount: 1 });
    expect(service.store.listAcceptedObservations(personId)).toEqual([
      expect.objectContaining({ conceptKey: '尿白细胞 (LEU)', rawText: '隂性', valueKind: 'qualitative' })
    ]);
    expect(service.store.listOpenExtractionReviewIssues()).toEqual([]);
    service.close();
  });

  it('定性原文一致但两轮标准分类相互矛盾时仍阻止发布', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-conflicting-category-pipeline-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '定性冲突工作区', () => new Date('2026-09-18T00:00:00Z'));
    const personId = service.ensurePrimaryMember({ displayName: '测试成员', relation: '本人' });
    const sourceText = '检查日期：2023-10-08 尿白细胞 (LEU) 隂性';
    await service.importFiles([{ path: '/tmp/尿常规分类冲突.txt', bytes: Buffer.from(sourceText) }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    const span = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!;
    let turn = 0;
    const pipeline = new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async () => ({
        threadId: 'conflicting-category-thread',
        turnId: `conflicting-category-turn-${++turn}`,
        output: {
          schemaVersion: 1,
          documentId,
          subject: { reportedName: null, evidence: [], confidence: 'absent' },
          coveredSourceSpanIds: [span.id],
          candidates: [{
            localKey: 'urine-leukocyte', originalName: '尿白细胞 (LEU)', standardNameCandidate: null,
            value: { kind: 'qualitative' as const, rawText: '隂性', category: turn === 1 ? '阴性' : '阳性' },
            unitRaw: null, referenceRangeRaw: '隂性', reportedAbnormalFlag: null,
            specimen: '尿液', method: '尿常规', bodySite: null, clinicalDate: '2023-10-08',
            evidence: [{ sourceSpanId: span.id, quote: sourceText }], issues: []
          }]
        }
      })
    });

    await expect(pipeline.process(documentId)).resolves.toMatchObject({ status: 'needs_review', reason: 'INDEPENDENT_REVIEW_MISMATCH' });
    expect(service.store.getFactRevision(personId)).toBe(0);
    expect(service.store.listOpenExtractionReviewIssues()[0]!.candidateDiffs)
      .toEqual([{ localKey: 'urine-leukocyte', itemName: '尿白细胞 (LEU)', fields: ['value'] }]);
    service.close();
  });

  it('核心数值不一致时只记录真正的差异字段并保持未发布', async () => {
    const { service, personId, documentId, output } = await setup();
    const conflicting: ExtractionResult = {
      ...output,
      candidates: output.candidates.map((candidate) => ({
        ...candidate,
        value: { kind: 'numeric', rawText: '4.3', decimal: '4.3', comparator: 'eq' }
      }))
    };
    let turn = 0;
    const pipeline = new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async () => ({
        threadId: `hard-diff-thread-${turn}`,
        turnId: `hard-diff-turn-${++turn}`,
        output: turn === 1 ? output : conflicting
      })
    });

    await expect(pipeline.process(documentId)).resolves.toMatchObject({ status: 'needs_review', reason: 'INDEPENDENT_REVIEW_MISMATCH' });
    expect(service.store.getFactRevision(personId)).toBe(0);
    const issue = service.store.listOpenExtractionReviewIssues()[0]!;
    expect(issue.candidateDiffs).toEqual([{ localKey: 'ldl-1', itemName: '低密度脂蛋白胆固醇', fields: ['value'] }]);
    expect(issue.candidateOptions[0]!.value).toMatchObject({ decimal: '4.3' });
    service.close();
  });

  it('模型未逐一确认全部来源片段时阻止入库', async () => {
    const { service, personId, documentId, output } = await setup();
    const pipeline = new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async () => ({
        threadId: 'thread-coverage', turnId: 'turn-coverage',
        output: { ...output, coveredSourceSpanIds: [] }
      })
    });
    await expect(pipeline.process(documentId)).resolves.toMatchObject({
      status: 'needs_review', reason: 'EXTRACTION_COVERAGE_INCOMPLETE'
    });
    expect(service.store.getFactRevision(personId)).toBe(0);
    service.close();
  });

  it('用户已明确归属时，姓名看不清但没有可验证冲突仍继续处理', async () => {
    const { service, personId, documentId, output } = await setup();
    const uncertainIdentity: ExtractionResult = {
      ...output,
      subject: { reportedName: null, evidence: [], confidence: 'uncertain' }
    };
    const pipeline = new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async () => ({
        threadId: 'uncertain-identity-thread',
        turnId: 'uncertain-identity-turn',
        output: uncertainIdentity
      })
    });

    await expect(pipeline.process(documentId)).resolves.toMatchObject({
      status: 'published', candidateCount: 1, revision: 1
    });
    expect(service.store.listOpenExtractionReviewIssues()).toEqual([]);
    expect(service.store.getFactRevision(personId)).toBe(1);
    service.close();
  });

  it('报告姓名与成员昵称不同时要求身份确认，确认后按原姓名再次核对并发布', async () => {
    const { service, personId, documentId, output, subjectSpanId } = await setup();
    const conflicting = {
      ...output,
      subject: {
        reportedName: '测试姓名甲',
        confidence: 'explicit' as const,
        evidence: [{ sourceSpanId: subjectSpanId, quote: '姓名：测试姓名甲 性别：男' }]
      }
    };
    const pipeline = new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async () => ({ threadId: 'identity-thread', turnId: 'identity-turn', output: conflicting })
    });
    await expect(pipeline.process(documentId)).resolves.toMatchObject({ status: 'needs_review', reason: 'PERSON_IDENTITY_NOT_CONFIRMED' });
    expect(service.store.getFactRevision(personId)).toBe(0);
    const issue = service.store.listOpenExtractionReviewIssues()[0]!;
    expect(issue).toMatchObject({ kind: 'person_conflict', personId, reportedName: '测试姓名甲' });
    service.store.confirmDocumentIdentity({ issueId: issue.id, documentId, personId });
    expect(service.store.getDocumentExtractionBundle(documentId)).toMatchObject({
      personAssignmentBasis: 'identity_confirmed',
      confirmedReportedName: '测试姓名甲'
    });
    await expect(pipeline.process(documentId)).resolves.toMatchObject({ status: 'published', candidateCount: 1, revision: 1 });
    expect(service.store.getFactRevision(personId)).toBe(1);
    service.close();
  });

  it('候选数值与所引原文不一致时阻止入库', async () => {
    const { service, personId, documentId, output } = await setup();
    const forged = {
      ...output,
      candidates: output.candidates.map((candidate) => ({
        ...candidate,
        value: { kind: 'numeric' as const, rawText: '999', decimal: '999', comparator: 'eq' as const }
      }))
    };
    const pipeline = new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async () => ({ threadId: 'evidence-thread', turnId: 'evidence-turn', output: forged })
    });
    await expect(pipeline.process(documentId)).resolves.toMatchObject({
      status: 'needs_review', reason: expect.stringContaining('numeric_value_not_in_evidence')
    });
    expect(service.store.getFactRevision(personId)).toBe(0);
    service.close();
  });
});
