import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtractionResult } from '@contracts';
import { createSyntheticTwoPageScannedPdf } from '../../../../packages/evaluation/src/scanned-pdf-fixture.js';
import { HEALTH_MODEL_TURN_TIMEOUT_MS } from './ai-runtime-policy.js';
import { PersonalWorkspaceService as BasePersonalWorkspaceService } from './workspace-service.js';
import { compareIndependentExtractions, DocumentExtractionPipeline, mergeIndependentlyConfirmedEvidence, partitionPdfSpans, partitionSourceSpans, scopeCandidateKeys } from './processing-pipeline.js';

const roots: string[] = [];
const openServices = new Set<BasePersonalWorkspaceService>();
const require = createRequire(import.meta.url);

class PersonalWorkspaceService extends BasePersonalWorkspaceService {
  constructor(...args: ConstructorParameters<typeof BasePersonalWorkspaceService>) {
    super(...args);
    openServices.add(this);
  }

  override close(): void {
    if (!openServices.delete(this)) return;
    super.close();
  }
}

afterEach(() => {
  for (const service of [...openServices]) service.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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

async function setupTwoMeasurements() {
  const root = mkdtempSync(join(tmpdir(), 'family-health-two-measurements-'));
  roots.push(root);
  const service = new PersonalWorkspaceService(root, '双指标测试工作区', () => new Date('2026-09-18T00:00:00Z'));
  const personId = service.ensurePrimaryMember({ displayName: '测试成员', relation: '本人' });
  await service.importFiles([{
    path: '/tmp/双指标虚构报告.txt',
    bytes: Buffer.from([
      '姓名：测试姓名甲 性别：男',
      '2026-09-17 低密度脂蛋白胆固醇 4.2 mmol/L，参考范围 0-3.4 mmol/L',
      '2026-09-17 高密度脂蛋白胆固醇 1.1 mmol/L，参考范围 1.0-1.8 mmol/L'
    ].join('\n'))
  }], personId);
  const documentId = service.getSnapshot(null).inbox[0]!.id;
  const spans = service.store.getDocumentExtractionBundle(documentId).manifest.spans;
  const candidate = (
    localKey: string,
    name: string,
    standardNameCandidate: string,
    decimal: string,
    referenceRangeRaw: string | null,
    reportedAbnormalFlag: string | null
  ) => {
    const span = spans.find((item) => item.quote?.includes(name))!;
    return {
      localKey,
      originalName: name,
      standardNameCandidate,
      value: { kind: 'numeric' as const, rawText: decimal, decimal, comparator: 'eq' as const },
      unitRaw: 'mmol/L',
      referenceRangeRaw,
      reportedAbnormalFlag,
      specimen: null,
      method: null,
      bodySite: null,
      clinicalDate: '2026-09-17',
      evidence: [{ sourceSpanId: span.id, quote: span.quote }],
      issues: []
    };
  };
  const result = (
    ldlRange: string | null,
    hdlRange: string | null,
    ldlFlag: string | null,
    hdlFlag: string | null
  ): ExtractionResult => ({
    schemaVersion: 1,
    documentId,
    subject: { reportedName: null, evidence: [], confidence: 'absent' },
    coveredSourceSpanIds: spans.map((span) => span.id),
    candidates: [
      candidate('ldl-1', '低密度脂蛋白胆固醇', 'LDL-C', '4.2', ldlRange, ldlFlag),
      candidate('hdl-1', '高密度脂蛋白胆固醇', 'HDL-C', '1.1', hdlRange, hdlFlag)
    ]
  });
  return { service, personId, documentId, result };
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
  it('由应用为每个分块生成稳定候选引用，跨块重复 localKey 不会冲突', () => {
    const base = {
      localKey: 'glucose', originalName: '葡萄糖', standardNameCandidate: null,
      value: { kind: 'numeric' as const, rawText: '5.2', decimal: '5.2', comparator: 'eq' as const },
      unitRaw: 'mmol/L', referenceRangeRaw: null, reportedAbnormalFlag: null,
      specimen: null, method: null, bodySite: null, clinicalDate: '2024-01-01',
      evidence: [{ sourceSpanId: 'span-1', quote: '葡萄糖 5.2 mmol/L' }], issues: []
    };
    const first = scopeCandidateKeys([base], 0)[0]!;
    const repeated = scopeCandidateKeys([{ ...base, clinicalDate: '2025-01-01' }], 1)[0]!;
    expect(first.localKey).not.toBe(repeated.localKey);
    expect(scopeCandidateKeys([first], 0)[0]!.localKey).toBe(first.localKey);
  });

  it('只保留两次独立读取都确认的重复来源角色', () => {
    const baseCandidate = (localKey: string, evidence: ExtractionResult['candidates'][number]['evidence']) => ({
      localKey, originalName: 'LDL-C', standardNameCandidate: 'LDL-C',
      value: { kind: 'numeric' as const, rawText: '4.20', decimal: '4.20', comparator: 'eq' as const },
      unitRaw: 'mmol/L', referenceRangeRaw: '0-3.4', reportedAbnormalFlag: '偏高',
      specimen: '血清', method: null, bodySite: null, clinicalDate: '2026-09-18', evidence, issues: []
    });
    const result = (candidate: ExtractionResult['candidates'][number]): ExtractionResult => ({
      schemaVersion: 1, documentId: 'document-duplicate-source',
      subject: { reportedName: null, evidence: [], confidence: 'absent' },
      coveredSourceSpanIds: ['summary-span', 'detail-span'], candidates: [candidate]
    });
    const first = result(baseCandidate('first', [
      { sourceSpanId: 'detail-span', quote: 'LDL-C 4.20', sourceRole: 'primary', duplicateBasis: null },
      { sourceSpanId: 'summary-span', quote: '摘要 LDL-C 4.20', sourceRole: 'duplicate_source', duplicateBasis: 'exam_item_id' }
    ]));
    const second = result(baseCandidate('second', [
      { sourceSpanId: 'detail-span', quote: 'LDL-C 4.20', sourceRole: 'primary', duplicateBasis: null },
      { sourceSpanId: 'summary-span', quote: '摘要 LDL-C 4.20', sourceRole: 'duplicate_source', duplicateBasis: 'exam_item_id' }
    ]));

    const merged = mergeIndependentlyConfirmedEvidence(first, second);
    expect(merged.candidates).toHaveLength(1);
    expect(merged.candidates[0]!.evidence).toEqual([
      expect.objectContaining({ sourceSpanId: 'detail-span', sourceRole: 'primary' }),
      expect.objectContaining({ sourceSpanId: 'summary-span', sourceRole: 'duplicate_source', duplicateBasis: 'exam_item_id' })
    ]);

    const oneSidedClaim = mergeIndependentlyConfirmedEvidence(first, result(baseCandidate('second', [
      { sourceSpanId: 'detail-span', quote: 'LDL-C 4.20' },
      { sourceSpanId: 'summary-span', quote: '摘要 LDL-C 4.20' }
    ])));
    expect(oneSidedClaim.candidates[0]!.evidence.every((reference) => reference.sourceRole === 'primary')).toBe(true);
  });

  it('同日同值的两次独立采样不会因证据合并而少计', () => {
    const candidate = (localKey: string, sourceSpanId: string) => ({
      localKey, originalName: 'TSH', standardNameCandidate: 'TSH',
      value: { kind: 'numeric' as const, rawText: '2.10', decimal: '2.10', comparator: 'eq' as const },
      unitRaw: 'mIU/L', referenceRangeRaw: null, reportedAbnormalFlag: null,
      specimen: '血清', method: null, bodySite: null, clinicalDate: '2026-09-18',
      evidence: [{ sourceSpanId, quote: `TSH 2.10 ${sourceSpanId}` }], issues: []
    });
    const result = (prefix: string): ExtractionResult => ({
      schemaVersion: 1, documentId: 'document-two-samples',
      subject: { reportedName: null, evidence: [], confidence: 'absent' },
      coveredSourceSpanIds: ['sample-a', 'sample-b'],
      candidates: [candidate(`${prefix}-a`, 'sample-a'), candidate(`${prefix}-b`, 'sample-b')]
    });
    const merged = mergeIndependentlyConfirmedEvidence(result('first'), result('second'));
    expect(merged.candidates).toHaveLength(2);
    expect(merged.candidates.map((item) => item.evidence)).toEqual([
      [{ sourceSpanId: 'sample-a', quote: 'TSH 2.10 sample-a' }],
      [{ sourceSpanId: 'sample-b', quote: 'TSH 2.10 sample-b' }]
    ]);
  });

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
    expect(turns).toBe(1);
    expect(service.store.getDocumentExtractionBundle(documentId).manifest).toMatchObject({
      totalUnits: 1,
      coveredUnitIndexes: [0],
      conversionWarnings: ['historical_manifest_reconstructed_from_verified_pdf']
    });
    expect(service.store.listOpenExtractionReviewIssues()).toEqual([]);
    service.close();
  });

  it('DOCX 嵌入图会带着对应 source span 进入一次视觉读取，完成后清理', async () => {
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
        expect(input.timeoutMs).toBe(HEALTH_MODEL_TURN_TIMEOUT_MS);
        expect(existsSync(input.imagePaths![0]!)).toBe(true);
        expect(input.prompt).toContain(imageSpan.id);
        observedPaths.push(input.imagePaths![0]!);
        return { threadId: `docx-thread-${turn}`, turnId: `docx-turn-${++turn}`, output };
      }
    });
    await expect(pipeline.process(documentId)).resolves.toMatchObject({ status: 'published', candidateCount: 1 });
    expect(observedPaths).toHaveLength(1);
    expect(existsSync(observedPaths[0]!)).toBe(false);
    service.close();
  });

  it('扫描 PDF 页会渲染成临时图片供一次视觉读取，成功后清理', async () => {
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
    expect(observedPaths).toHaveLength(1);
    expect(existsSync(observedPaths[0]!)).toBe(false);
    service.close();
  });

  it('双页无文字层 PDF 一次传入两页，跨页日期与各页来源均可接纳', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-two-page-scan-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '双页扫描工作区', () => new Date('2026-09-22T00:00:00Z'));
    const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
    const receipt = await service.importFiles([{
      path: '/tmp/纯合成双页扫描件.pdf', bytes: createSyntheticTwoPageScannedPdf()
    }], personId);
    expect(receipt.rejected).toEqual([]);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    const spans = service.store.getDocumentExtractionBundle(documentId).manifest.spans;
    expect(spans.map((span) => [span.page, span.quote])).toEqual([[1, null], [2, null]]);
    const candidates = [
      { localKey: 'ldl', originalName: '低密度脂蛋白胆固醇 LDL-C', standardNameCandidate: 'LDL-C',
        value: { kind: 'numeric' as const, rawText: '4.2', decimal: '4.2', comparator: 'eq' as const },
        unitRaw: 'mmol/L', referenceRangeRaw: '0-3.4 mmol/L', reportedAbnormalFlag: '偏高',
        specimen: null, method: null, bodySite: null, clinicalDate: '2025-06-10',
        evidence: [{ sourceSpanId: spans[0]!.id, quote: null }], issues: [] },
      { localKey: 'glucose', originalName: '空腹血糖', standardNameCandidate: '空腹血糖',
        value: { kind: 'numeric' as const, rawText: '5.1', decimal: '5.1', comparator: 'eq' as const },
        unitRaw: 'mmol/L', referenceRangeRaw: '3.9-6.1 mmol/L', reportedAbnormalFlag: null,
        specimen: null, method: null, bodySite: null, clinicalDate: '2025-06-10',
        evidence: [{ sourceSpanId: spans[1]!.id, quote: null }], issues: [] }
    ];
    let turns = 0;
    const observedPaths: string[] = [];
    const pipeline = new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async (input) => {
        turns += 1;
        expect(input.allowWebSearch).toBe(false);
        expect(input.imagePaths).toHaveLength(2);
        expect(input.imagePaths?.every((path) => existsSync(path))).toBe(true);
        expect(input.prompt).toContain(spans[0]!.id);
        expect(input.prompt).toContain(spans[1]!.id);
        observedPaths.push(...input.imagePaths!);
        return { threadId: 'two-page-scan', turnId: 'two-page-scan', output: {
          schemaVersion: 1, documentId,
          subject: { reportedName: '合成成员', evidence: [{ sourceSpanId: spans[0]!.id, quote: null }], confidence: 'explicit' },
          coveredSourceSpanIds: spans.map((span) => span.id), candidates
        } satisfies ExtractionResult };
      }
    });
    expect(await pipeline.process(documentId)).toMatchObject({ status: 'published', candidateCount: 2 });
    expect(turns).toBe(1);
    expect(observedPaths.every((path) => !existsSync(path))).toBe(true);
    expect(service.store.listAcceptedObservations(personId).map((fact) => [fact.rawText, fact.clinicalDate]))
      .toEqual(expect.arrayContaining([['4.2', '2025-06-10'], ['5.1', '2025-06-10']]));
    service.close();
  }, 20_000);

  it('扫描图像中明确读到不同姓名时必须阻断，不因缺少文字层放行', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-image-identity-conflict-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '图像身份工作区', () => new Date('2026-09-18T00:00:00Z'));
    const personId = service.ensurePrimaryMember({ displayName: '测试姓名甲', relation: '本人' });
    const receipt = await service.importFiles([{ path: '/tmp/扫描件.pdf', bytes: createScannedLikePdf() }], personId);
    expect(receipt.rejected).toEqual([]);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    const spanId = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!.id;
    const output: ExtractionResult = {
      schemaVersion: 1,
      documentId,
      subject: {
        reportedName: '测试姓名乙',
        evidence: [{ sourceSpanId: spanId, quote: null }],
        confidence: 'explicit'
      },
      coveredSourceSpanIds: [spanId],
      candidates: []
    };
    let turns = 0;
    const pipeline = new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async () => ({ threadId: 'image-name-thread', turnId: `image-name-${++turns}`, output })
    });

    await expect(pipeline.process(documentId)).resolves.toMatchObject({
      status: 'needs_review', reason: 'PERSON_IDENTITY_NOT_CONFIRMED'
    });
    expect(turns).toBe(1);
    expect(service.store.listOpenExtractionReviewIssues()[0]).toMatchObject({
      kind: 'person_conflict', reportedName: '测试姓名乙'
    });
    expect(service.store.getFactRevision(personId)).toBe(0);
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
      conceptKey: '低密度脂蛋白胆固醇', originalName: '低密度脂蛋白胆固醇',
      modelStandardNameCandidate: 'LDL-C', clinicalDate: '2026-09-17', abnormalFlag: 'high', documentId
    });
    expect(service.getSnapshot(null)).toMatchObject({
      persons: [expect.objectContaining({ id: personId, attentionCount: 1, lastDocumentDate: '2026-09-17' })],
      trends: [expect.objectContaining({ personId, name: '低密度脂蛋白胆固醇', points: [expect.objectContaining({ numericValue: 4.2, referenceHigh: 3.4, abnormalFlag: 'high' })] })],
      timeline: [expect.objectContaining({ personId, type: 'health_report', date: '2026-09-17', documentId })]
    });
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

  it('科室简称、正常标记、标准名称和未知原因措辞不制造健康事实冲突', async () => {
    const { service, output } = await setup();
    const normalCandidate = {
      ...output.candidates[0]!,
      localKey: 'lymph',
      originalName: '淋巴',
      standardNameCandidate: '淋巴结检查',
      value: { kind: 'qualitative' as const, rawText: '未见异常', category: '未见异常' },
      unitRaw: null,
      referenceRangeRaw: null,
      reportedAbnormalFlag: '正常',
      method: '外科检查',
      bodySite: '淋巴结'
    };
    const unknownCandidate = {
      ...normalCandidate,
      localKey: 'hearing',
      originalName: '听力（左）',
      standardNameCandidate: '左耳听力',
      value: { kind: 'unknown' as const, rawText: null, reason: '检查结果未显示' },
      reportedAbnormalFlag: null,
      method: '耳鼻喉科检查',
      bodySite: '左耳'
    };
    const first: ExtractionResult = { ...output, candidates: [normalCandidate, unknownCandidate] };
    const second: ExtractionResult = {
      ...output,
      candidates: [
        {
          ...normalCandidate,
          standardNameCandidate: '淋巴',
          reportedAbnormalFlag: null,
          method: '外科',
          bodySite: '淋巴'
        },
        {
          ...unknownCandidate,
          standardNameCandidate: '听力左',
          value: { kind: 'unknown', rawText: null, reason: '来源列出项目，但检查结果未显示' },
          method: '耳鼻喉科'
        }
      ]
    };

    expect(compareIndependentExtractions(first, second)).toEqual({ compatible: true, differences: [] });
    service.close();
  });

  it('检查部位的泛化组织词不制造冲突，但左右侧差异仍阻断', async () => {
    const { service, output } = await setup();
    const withBodySite = (bodySite: string): ExtractionResult => ({
      ...output,
      candidates: output.candidates.map((candidate) => ({ ...candidate, bodySite }))
    });

    expect(compareIndependentExtractions(
      withBodySite('甲状腺'),
      withBodySite('甲状腺实质')
    )).toEqual({ compatible: true, differences: [] });
    expect(compareIndependentExtractions(
      withBodySite('左肾'),
      withBodySite('右肾')
    )).toEqual({
      compatible: false,
      differences: [expect.objectContaining({ fields: ['bodySite'] })]
    });
    service.close();
  });

  it('HTML 实体与报告原符号视为同一参考范围', async () => {
    const { service, output } = await setup();
    const withRange = (referenceRangeRaw: string): ExtractionResult => ({
      ...output,
      candidates: output.candidates.map((candidate) => ({ ...candidate, referenceRangeRaw }))
    });
    expect(compareIndependentExtractions(withRange('<9.00'), withRange('&lt;9.00')))
      .toEqual({ compatible: true, differences: [] });
    service.close();
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

  it('血压名称规范不改写原单位、原文和比较符', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-blood-pressure-source-fidelity-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '血压原值工作区', () => new Date('2026-09-18T00:00:00Z'));
    const personId = service.ensurePrimaryMember({ displayName: '测试成员', relation: '本人' });
    const sourceText = '收缩压 > 18 kPa';
    await service.importFiles([{ path: '/tmp/血压原值报告.txt', bytes: Buffer.from(sourceText) }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    const span = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!;
    const output: ExtractionResult = {
      schemaVersion: 1,
      documentId,
      subject: { reportedName: null, evidence: [], confidence: 'absent' },
      coveredSourceSpanIds: [span.id],
      candidates: [{
        localKey: 'pressure-source', originalName: '收缩压', standardNameCandidate: 'SBP',
        value: { kind: 'numeric', rawText: '>18', decimal: '18', comparator: 'gt' },
        unitRaw: 'kPa', referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: null, bodySite: null, clinicalDate: null,
        evidence: [{ sourceSpanId: span.id, quote: sourceText }], issues: []
      }]
    };
    const pipeline = new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async () => ({ threadId: 'pressure-source-thread', turnId: 'pressure-source-turn', output })
    });

    await expect(pipeline.process(documentId)).resolves.toMatchObject({ status: 'published', candidateCount: 1 });
    expect(service.store.listAcceptedObservations(personId)).toEqual([
      expect.objectContaining({ conceptKey: '收缩压', rawText: '>18', decimalValue: '18', qualifier: 'gt', unit: 'kPa' })
    ]);
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
      expect.objectContaining({
        conceptKey: '身高', originalName: '身高', modelStandardNameCandidate: 'Height',
        decimalValue: '187', clinicalDate: '2023-10-08'
      })
    ]);
    expect(service.store.listOpenExtractionReviewIssues()).toEqual([]);
    service.close();
  });

  it('年度对比表会把日期表头与数据行联合为证据，不要求用户确认日期', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-comparison-table-date-context-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '年度对比日期工作区', () => new Date('2026-09-20T00:00:00Z'));
    const personId = service.ensurePrimaryMember({ displayName: '测试成员', relation: '本人' });
    const sourceText = '合成医院 体检中心 报告日期 2024-10-23 历次体检结果对比 一般检查 2023-10-08 2024-10-22 趋势 正常参考 单位 体重 91 94 ▲ --- kg';
    await service.importFiles([{ path: '/tmp/年度对比报告.txt', bytes: Buffer.from(sourceText) }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    const span = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!;
    const candidate = (localKey: string, value: string, clinicalDate: string): ExtractionResult['candidates'][number] => ({
      localKey,
      originalName: '体重',
      standardNameCandidate: '体重',
      value: { kind: 'numeric', rawText: value, decimal: value, comparator: 'eq' },
      unitRaw: 'kg',
      referenceRangeRaw: '---',
      reportedAbnormalFlag: null,
      specimen: null,
      method: null,
      bodySite: null,
      clinicalDate,
      evidence: [{ sourceSpanId: span.id, quote: '体重 91 94 ▲ --- kg' }],
      issues: []
    });
    const output: ExtractionResult = {
      schemaVersion: 1,
      documentId,
      subject: { reportedName: null, evidence: [], confidence: 'absent' },
      reportMetadata: {
        reportKind: { value: '体检报告', evidence: [{ sourceSpanId: span.id, quote: '体检中心' }] },
        title: { value: '历次体检结果对比', evidence: [{ sourceSpanId: span.id, quote: '历次体检结果对比' }] },
        organization: { value: '合成医院', evidence: [{ sourceSpanId: span.id, quote: '合成医院' }] },
        campus: null,
        department: { value: '体检中心', evidence: [{ sourceSpanId: span.id, quote: '体检中心' }] },
        reportNumber: null,
        examItems: [{ value: '一般检查', evidence: [{ sourceSpanId: span.id, quote: '一般检查' }] }],
        times: [
          { value: '2024-10-22', precision: 'day', role: 'examined', evidence: [{ sourceSpanId: span.id, quote: '2024-10-22' }] },
          { value: '2024-10-23', precision: 'day', role: 'report_issued', evidence: [{ sourceSpanId: span.id, quote: '报告日期 2024-10-23' }] },
          { value: '2023-10-08', precision: 'day', role: 'history_quoted', evidence: [{ sourceSpanId: span.id, quote: '2023-10-08' }] }
        ]
      },
      coveredSourceSpanIds: [span.id],
      candidates: [
        candidate('weight-2023', '91', '2023-10-08'),
        candidate('weight-2024', '94', '2024-10-22')
      ]
    };
    let turn = 0;
    const pipeline = new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async () => ({ threadId: 'comparison-date-thread', turnId: `comparison-date-${++turn}`, output })
    });

    await expect(pipeline.process(documentId)).resolves.toMatchObject({ status: 'published', candidateCount: 2 });
    expect(service.store.listAcceptedObservations(personId)).toEqual([
      expect.objectContaining({ conceptKey: '体重', decimalValue: '91', clinicalDate: '2023-10-08' }),
      expect.objectContaining({ conceptKey: '体重', decimalValue: '94', clinicalDate: '2024-10-22' })
    ]);
    expect(service.store.listReportMetadata(personId)[0]).toMatchObject({
      title: '历次体检结果对比', organization: '合成医院', reportDate: '2024-10-23',
      extracted: { department: { value: '体检中心' } }
    });
    expect(service.listHealthEvents(personId)[0]).toMatchObject({
      title: '历次体检结果对比', organization: '合成医院', department: '体检中心',
      time: { value: '2024-10-22', source: 'explicit' },
      reportIssuedTime: { value: '2024-10-23' },
      factCount: 2
    });
    expect(service.store.listOpenExtractionReviewIssues()).toEqual([]);
    service.close();
  });

  it('跨页小结会从紧邻上一页同名科室补齐检查日期，不要求用户确认', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-cross-page-summary-date-context-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '跨页小结日期工作区', () => new Date('2026-09-20T00:00:00Z'));
    const personId = service.ensurePrimaryMember({ displayName: '测试成员', relation: '本人' });
    await service.importFiles([{ path: '/tmp/跨页小结报告.txt', bytes: Buffer.from('占位内容') }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    const firstSpan = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!;
    const secondSpanId = '22222222-2222-4222-8222-222222222222';
    const firstPage = '超声科 甲状腺彩超 检查日期： 2024-10-25 检查医生：胡松 项目名称 检查结果 甲状腺 甲状腺左侧叶前后径：15.7mm，左右径：14.8mm。甲状腺切面形态正常，内部回声分布不均匀。';
    const secondPage = '小结 甲状腺声像图改变，考虑桥本氏甲状腺炎可能，请结合临床其它检查。 超声科 肝胆脾胰彩超 检查日期： 2024-10-25 检查结果未见明显异常。';
    const database = new Database(service.store.databasePath);
    database.prepare(`
      UPDATE source_spans
      SET span_kind = 'page', page_number = 1, quote = ?
      WHERE id = ?
    `).run(firstPage, firstSpan.id);
    database.prepare(`
      INSERT INTO source_spans (
        id, document_id, span_kind, page_number, block_id, line_start, line_end,
        quote, readability, normalizer_version
      )
      SELECT ?, document_id, 'page', 2, NULL, NULL, NULL, ?, 'clear', normalizer_version
      FROM source_spans WHERE id = ?
    `).run(secondSpanId, secondPage, firstSpan.id);
    database.prepare(`
      UPDATE source_manifests
      SET total_units = 2, covered_unit_indexes_json = '[0,1]'
      WHERE document_id = ?
    `).run(documentId);
    database.close();

    const output: ExtractionResult = {
      schemaVersion: 1,
      documentId,
      subject: { reportedName: null, evidence: [], confidence: 'absent' },
      coveredSourceSpanIds: [firstSpan.id, secondSpanId],
      candidates: [{
        localKey: 'thyroid-us-summary',
        originalName: '甲状腺彩超小结',
        standardNameCandidate: null,
        value: { kind: 'text', rawText: '甲状腺声像图改变，考虑桥本氏甲状腺炎可能，请结合临床其它检查。' },
        unitRaw: null,
        referenceRangeRaw: null,
        reportedAbnormalFlag: null,
        specimen: null,
        method: '彩色多普勒超声',
        bodySite: '甲状腺',
        clinicalDate: '2024-10-25',
        evidence: [{ sourceSpanId: secondSpanId, quote: '小结 甲状腺声像图改变，考虑桥本氏甲状腺炎可能，请结合临床其它检查。' }],
        issues: [{ code: 'uncertain_finding', message: '原报告使用“考虑……可能”表述。' }]
      }]
    };
    let turn = 0;
    const pipeline = new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async () => ({ threadId: 'cross-page-summary-thread', turnId: `cross-page-summary-${++turn}`, output })
    });

    await expect(pipeline.process(documentId)).resolves.toMatchObject({ status: 'published', candidateCount: 1 });
    expect(service.store.listAcceptedObservations(personId)).toEqual([
      expect.objectContaining({
        conceptKey: '甲状腺彩超小结',
        rawText: '甲状腺声像图改变，考虑桥本氏甲状腺炎可能，请结合临床其它检查。',
        clinicalDate: '2024-10-25'
      })
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
      status: 'needs_review', reason: 'NO_ACCEPTABLE_FACTS'
    });
    expect(service.store.getFactRevision(personId)).toBe(0);
    expect(service.store.listAcceptedObservations(personId)).toEqual([]);
    service.close();
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



  it('模型漏报覆盖清单时局部可用事实仍入库，并留下明确的覆盖问题', async () => {
    const { service, personId, documentId, output } = await setup();
    const pipeline = new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async () => ({
        threadId: 'thread-coverage', turnId: 'turn-coverage',
        output: { ...output, coveredSourceSpanIds: [] }
      })
    });
    await expect(pipeline.process(documentId)).resolves.toMatchObject({ status: 'published', candidateCount: 1 });
    expect(service.store.getFactRevision(personId)).toBe(1);
    expect(service.store.listOpenExtractionReviewIssues()).toEqual([expect.objectContaining({
      severity: 'warning', reasonCodes: expect.arrayContaining([expect.stringContaining('UNCOVERED_SPAN:')])
    })]);
    service.close();
  });

  it('模型漏报覆盖清单时仅做一次 P03 局部补救', async () => {
    const { service, personId, documentId, output } = await setup();
    let turn = 0;
    const pipeline = new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async () => ({
        threadId: `coverage-recovery-thread-${turn}`,
        turnId: `coverage-recovery-turn-${++turn}`,
        output: turn === 1 ? { ...output, coveredSourceSpanIds: [] } : output
      })
    });
    await expect(pipeline.process(documentId)).resolves.toMatchObject({ status: 'published', candidateCount: 1 });
    expect(turn).toBe(2);
    expect(service.store.getFactRevision(personId)).toBe(1);
    expect(service.store.listOpenExtractionReviewIssues()).toEqual([]);
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
      status: 'needs_review', reason: 'NO_ACCEPTABLE_FACTS'
    });
    expect(service.store.getFactRevision(personId)).toBe(0);
    service.close();
  });

  it('同一成员在不同块引用不同姓名证据时仍视为同一人', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-chunk-subject-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '分块身份工作区', () => new Date('2026-09-18T00:00:00Z'));
    const personId = service.ensurePrimaryMember({ displayName: '测试成员', relation: '本人' });
    const lines = Array.from({ length: 41 }, (_, index) => `测试成员 虚构指标${index + 1} ${index + 1} mmol/L`);
    await service.importFiles([{ path: '/tmp/分块身份.txt', bytes: Buffer.from(lines.join('\n')) }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    const chunks = partitionSourceSpans(service.store.getDocumentExtractionBundle(documentId).manifest.spans);
    expect(chunks.map((chunk) => chunk.length)).toEqual([40, 1]);
    let turn = 0;
    const pipeline = new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async () => {
        const chunkIndex = turn;
        turn += 1;
        const spans = chunks[chunkIndex]!;
        const itemNumber = chunkIndex === 0 ? 1 : 41;
        const quote = lines[itemNumber - 1]!;
        const output: ExtractionResult = {
          schemaVersion: 1,
          documentId,
          subject: {
            reportedName: '测试成员',
            evidence: [{ sourceSpanId: spans[0]!.id, quote }],
            confidence: 'explicit'
          },
          coveredSourceSpanIds: spans.map((span) => span.id),
          candidates: [{
            localKey: `chunk-${chunkIndex + 1}`, originalName: `虚构指标${itemNumber}`, standardNameCandidate: null,
            value: { kind: 'numeric', rawText: String(itemNumber), decimal: String(itemNumber), comparator: 'eq' },
            unitRaw: 'mmol/L', referenceRangeRaw: null, reportedAbnormalFlag: null,
            specimen: null, method: null, bodySite: null, clinicalDate: null,
            evidence: [{ sourceSpanId: spans[0]!.id, quote }], issues: []
          }]
        };
        return { threadId: 'chunk-subject-thread', turnId: `chunk-subject-${turn}`, output };
      }
    });

    await expect(pipeline.process(documentId)).resolves.toMatchObject({ status: 'published', candidateCount: 2 });
    expect(turn).toBe(2);
    expect(service.store.listAcceptedObservations(personId)).toHaveLength(2);
    service.close();
  });

  it('一个块中多个数值错绑只发起一次 P03，并只发布修正后的事实', async () => {
    const { service, personId, documentId, result } = await setupTwoMeasurements();
    const correct = result('0-3.4', '1.0-1.8', 'high', 'normal');
    const wrong: ExtractionResult = { ...correct, candidates: correct.candidates.map((item) => ({
      ...item, value: { kind: 'numeric' as const, rawText: '999', decimal: '999', comparator: 'eq' as const }
    })) };
    let calls = 0;
    const observedTimeouts: Array<number | undefined> = [];
    const pipeline = new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async (input) => {
        calls += 1;
        observedTimeouts.push(input.timeoutMs);
        if (calls === 1) return { threadId: 'p01', turnId: 'first', output: wrong };
        expect(input.prompt).toContain('REPAIR_REQUEST=');
        expect(input.prompt).toContain('numeric_value_not_in_evidence');
        return { threadId: 'p03', turnId: 'second', output: correct };
      }
    });
    await expect(pipeline.process(documentId)).resolves.toMatchObject({ status: 'published', candidateCount: 2 });
    expect(calls).toBe(2);
    expect(observedTimeouts).toEqual([HEALTH_MODEL_TURN_TIMEOUT_MS, HEALTH_MODEL_TURN_TIMEOUT_MS]);
    expect(service.store.listAcceptedObservations(personId)).toHaveLength(2);
    expect(service.store.listOpenExtractionReviewIssues()).toEqual([]);
    service.close();
  });

  it('P03 仍无法修复一个项目时不递归，正确项目可入库并标出局部缺口', async () => {
    const { service, personId, documentId, result } = await setupTwoMeasurements();
    const source = result('0-3.4', '1.0-1.8', 'high', 'normal');
    const partlyWrong: ExtractionResult = { ...source, candidates: [source.candidates[0]!, {
      ...source.candidates[1]!, value: { kind: 'numeric', rawText: '999', decimal: '999', comparator: 'eq' }
    }] };
    let calls = 0;
    const pipeline = new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async () => ({ threadId: 'p03-thread', turnId: 'turn-' + (++calls), output: partlyWrong })
    });
    await expect(pipeline.process(documentId)).resolves.toMatchObject({ status: 'published', candidateCount: 1 });
    expect(calls).toBe(2);
    const observations = service.store.listAcceptedObservations(personId);
    expect(observations).toHaveLength(1);
    expect(observations[0]!.originalName).toBe('低密度脂蛋白胆固醇');
    expect(service.store.listOpenExtractionReviewIssues()).toEqual([expect.objectContaining({
      severity: 'warning', reasonCodes: expect.arrayContaining(['numeric_value_not_in_evidence'])
    })]);
    service.close();
  });

  it('同日同名同值但来自两个独立来源片段时不自动去重', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-two-samples-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '合成双样本', () => new Date('2026-09-18T00:00:00Z'));
    const personId = service.ensurePrimaryMember({ displayName: '测试成员', relation: '本人' });
    await service.importFiles([{ path: '/tmp/双样本.txt', bytes: Buffer.from('2026-09-17 TSH 2.1 mIU/L 样本甲\n2026-09-17 TSH 2.1 mIU/L 样本乙') }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    const spans = service.store.getDocumentExtractionBundle(documentId).manifest.spans;
    expect(spans).toHaveLength(2);
    const output: ExtractionResult = {
      schemaVersion: 1, documentId, subject: { reportedName: null, evidence: [], confidence: 'absent' },
      coveredSourceSpanIds: spans.map((span) => span.id),
      candidates: spans.map((span, index) => ({
        localKey: 'tsh-' + index, originalName: 'TSH', standardNameCandidate: 'TSH',
        value: { kind: 'numeric', rawText: '2.1', decimal: '2.1', comparator: 'eq' },
        unitRaw: 'mIU/L', referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: '血清', method: null, bodySite: null, clinicalDate: '2026-09-17',
        evidence: [{ sourceSpanId: span.id, quote: span.quote }], issues: []
      }))
    };
    await expect(new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async () => ({ threadId: 'p01', turnId: 'one', output })
    }).process(documentId)).resolves.toMatchObject({ status: 'published', candidateCount: 2 });
    expect(service.store.listAcceptedObservations(personId)).toHaveLength(2);
    service.close();
  });

  it('引用存在但结果属于另一项目时，局部修复不成功也不能入库', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-misbinding-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '合成错绑', () => new Date('2026-09-18T00:00:00Z'));
    const personId = service.ensurePrimaryMember({ displayName: '测试成员', relation: '本人' });
    await service.importFiles([{ path: '/tmp/项目错绑.txt', bytes: Buffer.from('TSH 4.2 mIU/L；ALT 32 U/L') }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    const span = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!;
    const output: ExtractionResult = {
      schemaVersion: 1, documentId, subject: { reportedName: null, evidence: [], confidence: 'absent' },
      coveredSourceSpanIds: [span.id], candidates: [{
        localKey: 'wrong-tsh', originalName: 'TSH', standardNameCandidate: 'TSH',
        value: { kind: 'numeric', rawText: '32', decimal: '32', comparator: 'eq' },
        unitRaw: 'U/L', referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: null, bodySite: null, clinicalDate: null,
        evidence: [{ sourceSpanId: span.id, quote: span.quote }], issues: []
      }]
    };
    let calls = 0;
    await expect(new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async () => ({ threadId: 'p03', turnId: 'turn-' + (++calls), output })
    }).process(documentId)).resolves.toMatchObject({ status: 'needs_review', reason: 'NO_ACCEPTABLE_FACTS' });
    expect(calls).toBe(2);
    expect(service.store.listAcceptedObservations(personId)).toEqual([]);
    service.close();
  });

});
