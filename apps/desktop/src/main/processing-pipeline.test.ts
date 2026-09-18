import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtractionResult } from '@contracts';
import { PersonalWorkspaceService } from './workspace-service.js';
import { DocumentExtractionPipeline, partitionPdfSpans, partitionSourceSpans } from './processing-pipeline.js';

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
  await service.importFiles([{ path: '/tmp/虚构报告.txt', bytes: Buffer.from('2026-09-17 低密度脂蛋白胆固醇 4.2 mmol/L，参考范围 0-3.4 mmol/L') }], personId);
  const documentId = service.getSnapshot(null).inbox[0]!.id;
  const spanId = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!.id;
  const output: ExtractionResult = {
    schemaVersion: 1,
    documentId,
    subject: { reportedName: null, evidence: [], confidence: 'absent' },
    coveredSourceSpanIds: [spanId],
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
      evidence: [{ sourceSpanId: spanId, quote: '2026-09-17 低密度脂蛋白胆固醇 4.2 mmol/L' }],
      issues: []
    }]
  };
  return { service, personId, documentId, output };
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

describe('DocumentExtractionPipeline', () => {
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
    service.acceptCorrectedFacts({ issueId: issue.id, documentId, candidates: issue.candidateOptions });
    expect(service.store.getFactRevision(personId)).toBe(1);
    expect(service.getSnapshot(null).inbox[0]).toMatchObject({ status: 'completed' });
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

  it('报告显示姓名与目标成员不一致时阻止自动归档', async () => {
    const { service, personId, documentId, output } = await setup();
    const conflicting = {
      ...output,
      subject: {
        reportedName: '其他成员',
        confidence: 'explicit' as const,
        evidence: [{ sourceSpanId: output.coveredSourceSpanIds[0]!, quote: '2026-09-17 低密度脂蛋白胆固醇 4.2 mmol/L' }]
      }
    };
    const pipeline = new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async () => ({ threadId: 'identity-thread', turnId: 'identity-turn', output: conflicting })
    });
    await expect(pipeline.process(documentId)).resolves.toMatchObject({ status: 'needs_review', reason: 'PERSON_IDENTITY_NOT_CONFIRMED' });
    expect(service.store.getFactRevision(personId)).toBe(0);
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
