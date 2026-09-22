import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { stableHash } from '@core';
import { PersonalWorkspaceService } from './workspace-service.js';
import { ensureLocalRecoveryPoints } from './recovery-point-service.js';
import type { LegacyDocConverter } from '@ingestion';

const directories: string[] = [];

function makeService(): PersonalWorkspaceService {
  const root = mkdtempSync(join(tmpdir(), 'family-health-service-'));
  directories.push(root);
  return new PersonalWorkspaceService(root, '我的家庭健康', () => new Date('2026-09-18T01:00:00Z'));
}

function createMinimalPdf(text: string): Buffer {
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

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('PersonalWorkspaceService', () => {
  it('初始化成员并生成不含虚构健康结论的个人快照', () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    const snapshot = service.getSnapshot({
      status: 'disconnected', displayLabel: null,
      quota: { status: 'unknown', primaryUsedPercent: null, secondaryUsedPercent: null, resetsAt: null },
      runtimeVersion: 'test-runtime', lastCheckedAt: null
    });
    expect(snapshot.workspaceMode).toBe('personal');
    expect(snapshot.persons).toHaveLength(1);
    expect(snapshot.persons[0]).toMatchObject({ id: personId, documentCount: 0, dataQuality: 'insufficient' });
    expect(snapshot.organs.every((organ) => organ.status === 'insufficient')).toBe(true);
    expect(snapshot.trends).toEqual([]);
    service.close();
  });

  it('离线新增家庭成员不会生成健康数据', () => {
    const service = makeService();
    service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    const personId = service.createMember({ displayName: '家人甲', relation: '母亲', birthYear: 1962 });
    const snapshot = service.getSnapshot(null);
    expect(snapshot.persons).toHaveLength(2);
    expect(snapshot.persons.find((person) => person.id === personId)).toMatchObject({
      displayName: '家人甲',
      documentCount: 0,
      dataQuality: 'insufficient'
    });
    expect(snapshot.trends).toEqual([]);
    service.close();
  });

  it('归档成员会从日常快照隐藏，恢复后重新显示且不自动恢复授权', () => {
    const service = makeService();
    const primaryId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    const archivedId = service.createMember({ displayName: '家人乙', relation: '父亲', birthYear: 1960 });
    service.archiveMember({ personId: archivedId, expectedDisplayRevision: 1, confirmedArchive: true });
    expect(service.getSnapshot(null).persons.map((person) => person.id)).toEqual([primaryId]);
    expect(service.listArchivedMembers()).toEqual([expect.objectContaining({ id: archivedId, archivedAt: expect.any(String) })]);
    const archived = service.listArchivedMembers()[0]!;
    service.restoreMember({ personId: archived.id, expectedDisplayRevision: archived.displayRevision });
    expect(new Set(service.getSnapshot(null).persons.map((person) => person.id))).toEqual(new Set([primaryId, archivedId]));
    service.close();
  });

  it('导入本地文本并按内容哈希去重', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    const bytes = Buffer.from('纯虚构报告\nLDL 3.8 mmol/L');
    const first = await service.importFiles([{ path: '/tmp/虚构报告.txt', bytes }], personId);
    const second = await service.importFiles([{ path: '/tmp/虚构报告副本.txt', bytes }], personId);
    expect(first).toMatchObject({ importedCount: 1, duplicateCount: 0 });
    expect(second).toMatchObject({ importedCount: 0, duplicateCount: 1 });
    const snapshot = service.getSnapshot(null);
    expect(snapshot.inbox).toHaveLength(1);
    expect(snapshot.inbox[0]).toMatchObject({ status: 'queued', sentToAi: false });
    expect(service.store.countSourceSpans(snapshot.inbox[0]!.id)).toBe(2);
    const firstSpanId = service.store.getDocumentExtractionBundle(snapshot.inbox[0]!.id).manifest.spans[0]!.id;
    expect(service.store.getEvidenceAccess({ sourceSpanId: firstSpanId })).toMatchObject({
      documentId: snapshot.inbox[0]!.id,
      locator: '第 1 行',
      quote: '纯虚构报告'
    });
    expect(service.store.getEvidenceAccess({ documentId: snapshot.inbox[0]!.id }).sourceSpanId).toBe(firstSpanId);
    expect(() => service.store.getEvidenceAccess({ sourceSpanId: 'missing' })).toThrow('EVIDENCE_NOT_FOUND');
    const batch = service.processNow();
    const repeated = service.processNow();
    expect(batch.idempotent).toBe(false);
    expect(repeated).toMatchObject({ batchId: batch.batchId, idempotent: true });
    expect(service.getSnapshot(null)).toMatchObject({
      pendingInboxCount: 0,
      inbox: [expect.objectContaining({ inProcessingCenter: true })],
      jobs: [expect.objectContaining({ status: 'waiting_auth', stage: 'extract' })]
    });
    service.close();
  });

  it('混合差异中可排除证据不清的单项，不阻断其余已核实事实入库', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    await service.importFiles([{
      path: '/tmp/混合差异报告.txt',
      bytes: Buffer.from('肌钙蛋白 <0.01 ng/mL\n葡萄糖 5.2 mmol/L')
    }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    const bundle = service.store.getDocumentExtractionBundle(documentId);
    const [troponinSpan, glucoseSpan] = bundle.manifest.spans;
    const troponin = {
      localKey: 'troponin', originalName: '肌钙蛋白', standardNameCandidate: 'cTnI',
      value: { kind: 'numeric' as const, rawText: '<0.01', decimal: '0.01', comparator: 'lt' as const },
      unitRaw: 'ng/mL', referenceRangeRaw: null, reportedAbnormalFlag: null,
      specimen: null, method: null, bodySite: null, clinicalDate: null,
      evidence: [{ sourceSpanId: troponinSpan!.id, quote: troponinSpan!.quote }], issues: []
    };
    const glucose = {
      localKey: 'glucose', originalName: '葡萄糖', standardNameCandidate: '空腹血糖',
      value: { kind: 'numeric' as const, rawText: '5.2', decimal: '5.2', comparator: 'eq' as const },
      unitRaw: 'mmol/L', referenceRangeRaw: null, reportedAbnormalFlag: null,
      specimen: null, method: null, bodySite: null, clinicalDate: null,
      evidence: [{ sourceSpanId: glucoseSpan!.id, quote: glucoseSpan!.quote }], issues: []
    };
    const issueId = service.store.saveExtractionReviewIssue({
      documentId, kind: 'field_conflict', severity: 'blocking',
      evidenceRefs: bundle.manifest.spans.map((span) => span.id),
      candidateOptions: [troponin, glucose],
      candidateDiffs: [
        { localKey: troponin.localKey, itemName: troponin.originalName, fields: ['value'] },
        { localKey: glucose.localKey, itemName: glucose.originalName, fields: ['issues'] }
      ],
      reasonCodes: ['FACT_ADJUDICATION_UNRESOLVED'],
      documentRun: {
        coverageComplete: true,
        coveredSourceSpanIds: bundle.manifest.spans.map((span) => span.id),
        manifestSpanIds: bundle.manifest.spans.map((span) => span.id),
        chunkCount: 1
      }
    });

    service.acceptCorrectedFacts({ issueId, documentId, candidates: [troponin] });
    expect(service.store.listAcceptedObservations(personId)).toEqual([
      expect.objectContaining({
        conceptKey: '肌钙蛋白',
        originalName: '肌钙蛋白',
        modelStandardNameCandidate: 'cTnI',
        rawText: '<0.01',
        qualifier: 'lt'
      })
    ]);
    expect(service.store.listOpenExtractionReviewIssues()).toEqual([]);
    service.close();
  });

  it('成员档案 v2 以身体系统读取事实，并把多年度别名组成可审查趋势', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    await service.importFiles([{
      path: '/tmp/虚构纵向血脂.txt',
      bytes: Buffer.from('2022-02-10 LDL-C 3.1 mmol/L\n2024-08-18 低密度脂蛋白 3.6 mmol/L ↑\n2026-09-12 低密度脂蛋白胆固醇 4.2 mmol/L ↑')
    }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    const bundle = service.store.getDocumentExtractionBundle(documentId);
    const names = ['LDL-C', '低密度脂蛋白', '低密度脂蛋白胆固醇'];
    const dates = ['2022-02-10', '2024-08-18', '2026-09-12'];
    const values = ['3.1', '3.6', '4.2'];
    const candidates = bundle.manifest.spans.map((span, index) => ({
      localKey: `ldl-${index}`,
      originalName: names[index]!,
      standardNameCandidate: '低密度脂蛋白胆固醇',
      value: { kind: 'numeric' as const, rawText: values[index]!, decimal: values[index]!, comparator: 'eq' as const },
      unitRaw: 'mmol/L',
      referenceRangeRaw: '0-3.4',
      reportedAbnormalFlag: index === 0 ? '正常' : '↑',
      specimen: '血清', method: '酶法', bodySite: null,
      clinicalDate: dates[index]!,
      evidence: [{ sourceSpanId: span.id, quote: span.quote }],
      issues: []
    }));
    const issueId = service.store.saveExtractionReviewIssue({
      documentId,
      kind: 'field_conflict',
      severity: 'blocking',
      evidenceRefs: bundle.manifest.spans.map((span) => span.id),
      candidateOptions: candidates,
      candidateDiffs: candidates.map((candidate) => ({ localKey: candidate.localKey, itemName: candidate.originalName, fields: ['value'] })),
      reasonCodes: ['TEST_FIXTURE'],
      documentRun: {
        coverageComplete: true,
        coveredSourceSpanIds: bundle.manifest.spans.map((span) => span.id),
        manifestSpanIds: bundle.manifest.spans.map((span) => span.id),
        chunkCount: 1
      }
    });
    service.acceptCorrectedFacts({ issueId, documentId, candidates });

    const overview = service.getMemberOverview(personId);
    expect(overview).toMatchObject({ acceptedFactCount: 3, eventCount: 1, attentionSystemIds: ['cardiovascular'] });
    const systems = service.listBodySystems(personId);
    expect(systems.find((system) => system.id === 'cardiovascular')).toMatchObject({ factCount: 3, metricCount: 1, status: 'attention' });
    const detail = service.getBodySystemDetail(personId, 'cardiovascular');
    expect(detail.metrics[0]).toMatchObject({
      conceptId: 'loinc-like-ldl-c',
      trendFacts: { direction: 'increasing', usablePointCount: 3 }
    });
    const metric = service.getMetricSeries(personId, detail.metrics[0]!.id);
    expect(metric.aliasesSeen).toEqual(['LDL-C', '低密度脂蛋白', '低密度脂蛋白胆固醇']);
    expect(metric.tableRows).toHaveLength(3);
    expect(service.listHealthEvents(personId)[0]).toMatchObject({ metadataStatus: 'unknown', factCount: 3 });
    const evidenceId = metric.tableRows[0]!.evidence.id;
    expect(service.getMemberEvidenceBundle(personId, [evidenceId])).toMatchObject({ items: [{ id: evidenceId }], missingIds: [] });
    service.store.createManualNote({
      personId,
      kind: 'medication',
      immutableText: '纯合成自述：正在记录一种用药，尚未核对剂量。',
      effectiveDate: '2026-09-01',
      structuredFields: {},
      expectedContextRevision: 0
    });
    const bundleForAnalysis = service.buildSystemEvidenceBundle(personId, 'cardiovascular');
    expect(bundleForAnalysis).toMatchObject({
      identity: { personId, systemId: 'cardiovascular' },
      scope: { factRevision: 1, contextRevision: 1, clinicalFrom: '2022-02-10', clinicalAsOf: '2026-09-12' },
      coverage: { selectedObservationIds: expect.arrayContaining(metric.tableRows.map((row) => row.observationId)) }
    });
    expect(bundleForAnalysis.directFacts).toHaveLength(3);
    expect(bundleForAnalysis.contextFacts).toHaveLength(0);
    expect(bundleForAnalysis.personalContext).toEqual([expect.objectContaining({ source: 'user_reported', kind: 'medication' })]);
    expect(bundleForAnalysis.trends[0]).toMatchObject({ trendFacts: { direction: 'increasing' } });
    expect(bundleForAnalysis.scope.inputSignature).toMatch(/^[a-f0-9]{64}$/);
    const modelASignature = service.buildSystemEvidenceBundle(personId, 'cardiovascular', 'model-a').scope.inputSignature;
    expect(service.buildSystemEvidenceBundle(personId, 'cardiovascular', 'model-b').scope.inputSignature).not.toBe(modelASignature);
    const report = service.store.listReportMetadata(personId)[0]!;
    service.updateReportMetadata({
      personId,
      reportId: report.reportId,
      expectedRevision: report.metadataRevision,
      title: '本人核对后的血脂检查',
      organization: '合成医院',
      department: '检验科',
      clinicalTime: { value: '2026-09', precision: 'month' },
      reason: '合成测试：核对报告事件依赖'
    });
    const afterMetadataCorrection = service.buildSystemEvidenceBundle(personId, 'cardiovascular', 'model-a');
    expect(afterMetadataCorrection.scope.inputSignature).not.toBe(modelASignature);
    expect(afterMetadataCorrection.events).toEqual([
      expect.objectContaining({ title: '本人核对后的血脂检查', time: expect.objectContaining({ value: '2026-09', precision: 'month' }) })
    ]);
    const afterMetadataDefaultSignature = service.buildSystemEvidenceBundle(personId, 'cardiovascular').scope.inputSignature;
    const unrelatedGoal = service.store.createManualNote({
      personId,
      kind: 'goal',
      immutableText: '希望把日常作息安排得更规律',
      effectiveDate: null,
      structuredFields: {},
      expectedContextRevision: 1
    });
    const afterUnrelatedGoal = service.buildSystemEvidenceBundle(personId, 'cardiovascular');
    expect(afterUnrelatedGoal.scope.contextRevision).toBe(2);
    expect(afterUnrelatedGoal.scope.inputSignature).toBe(afterMetadataDefaultSignature);
    expect(afterUnrelatedGoal.coverage.excludedContextIds).toContain(unrelatedGoal.id);
    service.updateMemberDisplay({
      personId,
      displayName: '测试用户',
      relation: '本人',
      birthYear: 1990,
      expectedDisplayRevision: 1
    });
    const afterBirthYear = service.buildSystemEvidenceBundle(personId, 'cardiovascular');
    expect(afterBirthYear.identity).toMatchObject({
      birthYear: 1990,
      genderContext: null,
      contextSource: 'user_profile'
    });
    expect(afterBirthYear.scope.inputSignature).not.toBe(afterUnrelatedGoal.scope.inputSignature);
    service.close();
  });

  it('系统分析版本升级后可复用已接纳事实刷新，不要求重新上传报告', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    await service.importFiles([{
      path: '/tmp/合成刷新报告.txt',
      bytes: Buffer.from('2026-09-12 LDL-C 4.2 mmol/L')
    }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    const span = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!;
    const candidate = {
      localKey: 'ldl-refresh', originalName: 'LDL-C', standardNameCandidate: '低密度脂蛋白胆固醇',
      value: { kind: 'numeric' as const, rawText: '4.2', decimal: '4.2', comparator: 'eq' as const },
      unitRaw: 'mmol/L', referenceRangeRaw: '0-3.4', reportedAbnormalFlag: '↑',
      specimen: '血清', method: null, bodySite: null, clinicalDate: '2026-09-12',
      evidence: [{ sourceSpanId: span.id, quote: span.quote }], issues: []
    };
    const issueId = service.store.saveExtractionReviewIssue({
      documentId, kind: 'field_conflict', severity: 'blocking', evidenceRefs: [span.id],
      candidateOptions: [candidate],
      candidateDiffs: [{ localKey: candidate.localKey, itemName: candidate.originalName, fields: ['value'] }],
      reasonCodes: ['TEST_FIXTURE'],
      documentRun: {
        coverageComplete: true, coveredSourceSpanIds: [span.id], manifestSpanIds: [span.id], chunkCount: 1
      }
    });
    service.acceptCorrectedFacts({ issueId, documentId, candidates: [candidate] });
    service.store.publishDerivedSnapshot({
      candidate: {
        schemaVersion: 1,
        personId,
        factRevision: service.store.getFactRevision(personId),
        dataQuality: 'partial',
        claims: [],
        lifestyleGuidance: []
      },
      expectedFactRevision: service.store.getFactRevision(personId),
      expectedContextRevision: service.store.getClinicalContextRevision(personId),
      promptVersion: 'derived-v3',
      rulesVersion: 'derived-safety-v2',
      modelId: 'test-model'
    });
    expect(service.store.listDerivedRefreshTargets()).toEqual([]);
    expect(service.store.listCurrentDerivedSnapshots()[0]?.promptVersion).toBe('derived-v3');

    const batch = service.processNow();
    expect(service.getSnapshot(null).jobs).toEqual([
      expect.objectContaining({ stage: 'analyze', status: 'waiting_auth' })
    ]);
    expect(service.processNow()).toMatchObject({ batchId: batch.batchId, idempotent: true });
    service.close();
  });

  it('旧记录缺少原项目名时恢复可查看的系统归类，但不把候选名当成已验证事实', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    await service.importFiles([{
      path: '/tmp/合成旧版血脂.txt',
      bytes: Buffer.from('2026-09-10 低密度脂蛋白胆固醇 3.8 mmol/L')
    }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    const span = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!;
    const acceptanceId = service.store.saveAcceptanceDecision({
      method: 'auto', actor: 'policy', rulesVersion: 'test', inputSignature: 'legacy-name-input',
      outputHash: 'legacy-name-output', reviewRef: null, decision: 'accept'
    });
    service.store.publishFacts({
      personId,
      documentId,
      documentCommitKey: 'e'.repeat(64),
      expectedRevision: 0,
      changeSetHash: 'f'.repeat(64),
      summary: '合成旧版项目名兼容测试',
      observations: [{
        conceptKey: '低密度脂蛋白胆固醇',
        originalName: '低密度脂蛋白胆固醇',
        modelStandardNameCandidate: '低密度脂蛋白胆固醇',
        rawText: '3.8', valueKind: 'numeric', decimalValue: '3.8', qualifier: 'eq', unit: 'mmol/L',
        referenceRange: '0-3.4', clinicalDate: '2026-09-10', abnormalFlag: 'high', documentId,
        sourceSpanId: span.id, acceptanceId, specimen: '血清', method: null, bodySite: null,
        evidence: [{ sourceSpanId: span.id, quote: span.quote }]
      }]
    });
    const database = new Database(service.store.databasePath);
    database.prepare('UPDATE observations SET original_name = NULL WHERE person_id = ?').run(personId);
    database.close();

    expect(service.store.listAcceptedObservations(personId)[0]).toMatchObject({
      originalNameStatus: 'legacy_missing',
      mapping: { status: 'proposed' }
    });
    expect(service.listBodySystems(personId).find((system) => system.id === 'cardiovascular')).toMatchObject({
      status: 'building', factCount: 1, metricCount: 1, attentionCount: 0
    });
    const detail = service.getBodySystemDetail(personId, 'cardiovascular');
    expect(detail.metrics[0]).toMatchObject({ name: '低密度脂蛋白胆固醇', conceptId: null, mappingStatus: 'unmapped' });
    expect(detail.findings).toEqual([]);
    expect(service.buildSystemEvidenceBundle(personId, 'cardiovascular')).toMatchObject({
      directFacts: [],
      contextFacts: [{ name: '低密度脂蛋白胆固醇（旧记录候选名）', relation: 'context' }]
    });
    service.close();
  });

  it('事件详情把当前检查与报告引用的历史结果分开，不把当前机构套给历史结果', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    await service.importFiles([{
      path: '/tmp/虚构年度对比.txt',
      bytes: Buffer.from('合成医院 检查日期 2026-09-10\nLDL-C 2024-09-01 3.1 2026-09-10 3.8')
    }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    const span = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!;
    const acceptanceId = service.store.saveAcceptanceDecision({
      method: 'auto', actor: 'policy', rulesVersion: 'test', inputSignature: 'history-event-input',
      outputHash: 'history-event-output', reviewRef: null, decision: 'accept'
    });
    const observation = (clinicalDate: string, rawText: string) => ({
      conceptKey: 'LDL-C', rawText, valueKind: 'numeric' as const, decimalValue: rawText, qualifier: 'eq',
      unit: 'mmol/L', referenceRange: '0-3.4', clinicalDate, abnormalFlag: 'unknown' as const,
      documentId, sourceSpanId: span.id, acceptanceId, specimen: '血清', method: null, bodySite: null,
      evidence: [{ sourceSpanId: span.id, quote: `LDL-C ${clinicalDate} ${rawText}` }]
    });
    service.store.publishFacts({
      personId, documentId, documentCommitKey: '1'.repeat(64), expectedRevision: 0,
      changeSetHash: '2'.repeat(64), summary: '合成历史列事件',
      reportMetadata: {
        reportKind: { value: '年度体检报告', evidence: [{ sourceSpanId: span.id, quote: '合成医院' }] },
        title: { value: '2026 年度体检', evidence: [{ sourceSpanId: span.id, quote: '合成医院' }] },
        organization: { value: '合成医院', evidence: [{ sourceSpanId: span.id, quote: '合成医院' }] },
        campus: null, department: null, reportNumber: null, encounterIdentifier: null, sampleIdentifiers: [], examItems: [],
        times: [
          { value: '2026-09-10', precision: 'day', role: 'examined', evidence: [{ sourceSpanId: span.id, quote: '检查日期 2026-09-10' }] },
          { value: '2024-09-01', precision: 'day', role: 'history_quoted', evidence: [{ sourceSpanId: span.id, quote: '2024-09-01 3.1' }] }
        ]
      },
      observations: [observation('2024-09-01', '3.1'), observation('2026-09-10', '3.8')]
    });

    const event = service.listHealthEvents(personId)[0]!;
    expect(event.summary).toContain('报告中另有历史对比结果，已与本次检查分开');
    const detail = service.getHealthEventDetail(personId, event.id);
    expect(detail.findings).toEqual([expect.objectContaining({ value: '3.8 mmol/L' })]);
    expect(detail.historicalReferences).toEqual([expect.objectContaining({
      time: expect.objectContaining({ value: '2024-09-01', role: 'measurement' }),
      sourceReportTitle: '2026 年度体检',
      findings: [expect.objectContaining({ value: '3.1 mmol/L' })]
    })]);
    service.close();
  });

  it('仅修改文件名不会改变检查事件类别', async () => {
    const eventTypeFor = async (fileName: string) => {
      const service = makeService();
      const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
      await service.importFiles([{
        path: `/tmp/${fileName}`,
        bytes: Buffer.from('2026-09-17 LDL-C 4.2 mmol/L')
      }], personId);
      const documentId = service.getSnapshot(null).inbox[0]!.id;
      const span = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!;
      const candidate = {
        localKey: 'ldl-file-name', originalName: 'LDL-C', standardNameCandidate: 'LDL-C',
        value: { kind: 'numeric' as const, rawText: '4.2', decimal: '4.2', comparator: 'eq' as const },
        unitRaw: 'mmol/L', referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: null, bodySite: null, clinicalDate: '2026-09-17',
        evidence: [{ sourceSpanId: span.id, quote: '2026-09-17 LDL-C 4.2 mmol/L' }], issues: []
      };
      const issueId = service.store.saveExtractionReviewIssue({
        documentId, kind: 'field_conflict', severity: 'blocking',
        evidenceRefs: [span.id], candidateOptions: [candidate],
        candidateDiffs: [{ localKey: candidate.localKey, itemName: candidate.originalName, fields: ['value'] }],
        reasonCodes: ['TEST_FIXTURE'],
        documentRun: {
          coverageComplete: true,
          coveredSourceSpanIds: [span.id],
          manifestSpanIds: [span.id],
          chunkCount: 1
        }
      });
      service.acceptCorrectedFacts({ issueId, documentId, candidates: [candidate] });
      const type = service.listHealthEvents(personId)[0]!.type;
      service.close();
      return type;
    };

    await expect(eventTypeFor('年度体检_胸部影像.txt')).resolves.toBe('laboratory');
    await expect(eventTypeFor('普通记录.txt')).resolves.toBe('laboratory');
  });

  it('旧版生活建议缺少新版安全字段时保留可读内容但禁止直接采纳', () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-legacy-lifestyle-'));
    directories.push(root);
    const service = new PersonalWorkspaceService(root, '我的家庭健康', () => new Date('2026-09-18T01:00:00Z'));
    const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    const database = new Database(service.store.databasePath);
    database.prepare(`
      INSERT INTO derived_snapshots (
        id, person_id, fact_revision, context_revision, prompt_version,
        rules_version, model_id, coverage_json, payload_json, status, created_at
      ) VALUES (?, ?, 0, 0, 'derived-v1', 'derived-safety-v1', 'legacy-model', '[]', ?, 'current', ?)
    `).run('legacy-derived-snapshot', personId, JSON.stringify({
      schemaVersion: 1,
      personId,
      factRevision: 0,
      dataQuality: 'partial',
      claims: [],
      lifestyleGuidance: [{
        id: 'legacy-guidance',
        category: 'nutrition',
        title: '旧版建议',
        detail: '旧版记录没有新版所需的目标、步骤、来源和适用边界。',
        evidenceObservationIds: [],
        consultProfessional: false
      }]
    }), '2026-09-18T01:00:00.000Z');
    database.close();

    expect(service.getLifestylePlan(personId)).toMatchObject({
      personId,
      status: 'stale',
      dataQuality: 'partial',
      priorities: [],
      proposals: [{
        id: 'legacy-guidance',
        category: 'diet',
        title: '旧版建议',
        goal: '旧版建议',
        detail: '旧版记录没有新版所需的目标、步骤、来源和适用边界。',
        status: 'proposed',
        sourceKind: 'ai_proposed'
      }],
      adoptedActions: []
    });
    service.close();
  });

  it('已进入处理中心的失败资料不再建立新批次', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    await service.importFiles([{ path: '/tmp/虚构长报告.txt', bytes: Buffer.from('纯虚构报告') }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    const accountState = {
      status: 'connected' as const,
      displayLabel: 'masked@example.com',
      quota: { status: 'available' as const, primaryUsedPercent: 1, secondaryUsedPercent: null, resetsAt: null },
      runtimeVersion: 'test-runtime',
      lastCheckedAt: '2026-09-18T01:00:00Z'
    };
    service.processNow({ accountState, consentVersion: 1, documentIds: [documentId] });
    const fingerprint = stableHash({ provider: 'codex-chatgpt', displayLabel: accountState.displayLabel });
    const job = service.store.claimNextQueuedJob('test-runner', fingerprint)!;
    const attemptId = service.store.startJobAttempt(job.id, 'test-runtime');
    service.store.finishJobAttempt({ attemptId, status: 'failed', errorCode: 'CODEX_TURN_TIMEOUT' });
    service.store.finishJob(job.id, 'failed');

    expect(() => service.processNow({ accountState, consentVersion: 1, documentIds: [documentId] }))
      .toThrow('DOCUMENT_ALREADY_IN_PROCESSING');
    service.store.createWaitingAuthBatch({
      cutoff: '2026-09-18T01:00:00Z', initialStatus: 'queued', consentId: job.consentId,
      groups: [{ personId, documentIds: [documentId], inputSignature: 'newer-timeout-task' }]
    });
    const newerJob = service.store.claimNextQueuedJob('test-runner-2', fingerprint)!;
    const newerAttemptId = service.store.startJobAttempt(newerJob.id, 'test-runtime');
    service.store.finishJobAttempt({ attemptId: newerAttemptId, status: 'failed', errorCode: 'CODEX_TURN_TIMEOUT' });
    service.store.finishJob(newerJob.id, 'failed');

    const snapshot = service.getSnapshot(accountState);
    expect(snapshot).toMatchObject({
      pendingInboxCount: 0,
      inbox: [expect.objectContaining({ id: documentId, inProcessingCenter: true })],
      jobs: [
        expect.objectContaining({ status: 'failed', statusText: expect.stringContaining('等待超时'), canCancel: false, canRetry: true }),
        expect.objectContaining({ status: 'failed', statusText: expect.stringContaining('较新的处理任务'), canCancel: false, canRetry: false })
      ]
    });
    service.close();
  });

  it('旧版 DOC 在完整转换组件缺失时保留原件并失败关闭', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    const bytes = Buffer.alloc(512);
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(bytes);

    const receipt = await service.importFiles([{ path: '/tmp/旧版虚构报告.doc', bytes }], personId);
    expect(receipt).toMatchObject({
      selectedCount: 1,
      importedCount: 0,
      rejected: [{ displayName: '旧版虚构报告.doc', code: 'LEGACY_DOC_CONVERSION_REQUIRED' }]
    });
    const snapshot = service.getSnapshot(null);
    expect(snapshot.inbox).toEqual([expect.objectContaining({
      displayName: '旧版虚构报告.doc',
      status: 'blocked',
      sentToAi: false
    })]);
    expect(service.store.countSourceSpans(snapshot.inbox[0]!.id)).toBe(0);
    const sourceHash = createHash('sha256').update(bytes).digest('hex');
    expect(service.store.getDocumentSourceHash(snapshot.inbox[0]!.id)).toBe(sourceHash);
    expect(existsSync(join(service.store.vaultDirectory, sourceHash.slice(0, 2), sourceHash.slice(2, 4), sourceHash))).toBe(true);
    service.close();
  });

  it('经校验的旧版 DOC 转换器保留原件并登记可追溯 PDF 转换视图', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-service-'));
    directories.push(root);
    const pdf = createMinimalPdf('Synthetic LDL 3.8 mmol/L');
    const converter: LegacyDocConverter = {
      async convert() {
        return {
          bytes: pdf,
          mediaType: 'application/pdf',
          sha256: createHash('sha256').update(pdf).digest('hex'),
          converterId: 'libreoffice-headless',
          converterVersion: '25.8.7.2',
          executableSha256: 'a'.repeat(64)
        };
      }
    };
    const service = new PersonalWorkspaceService(
      root,
      '我的家庭健康',
      () => new Date('2026-09-18T01:00:00Z'),
      () => 'Asia/Shanghai',
      converter
    );
    const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    const bytes = Buffer.alloc(512);
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(bytes);

    const receipt = await service.importFiles([{ path: '/tmp/旧版虚构报告.doc', bytes }], personId);
    expect(receipt).toMatchObject({ selectedCount: 1, importedCount: 1, rejected: [] });
    const item = service.getSnapshot(null).inbox[0]!;
    const bundle = service.store.getDocumentExtractionBundle(item.id);
    expect(bundle.manifest.mediaType).toBe('application/pdf');
    expect(bundle.manifest.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(bundle.manifest.conversionWarnings).toEqual(expect.arrayContaining(['converted_view:libreoffice-headless:25.8.7.2']));
    expect(readFileSync(bundle.sourcePath).subarray(0, 5).toString()).toBe('%PDF-');
    const evidence = service.store.getEvidenceAccess({ documentId: item.id });
    expect(evidence).toMatchObject({ mediaType: 'application/pdf', conversionView: true, displayName: '旧版虚构报告.doc' });
    const originalHash = createHash('sha256').update(bytes).digest('hex');
    const originalPath = join(service.store.vaultDirectory, originalHash.slice(0, 2), originalHash.slice(2, 4), originalHash);
    expect(existsSync(originalPath)).toBe(true);
    expect(existsSync(bundle.sourcePath)).toBe(true);
    await service.deleteDocument({ documentId: item.id, confirmedDelete: true, acknowledgedRecoveryCopies: true });
    expect(existsSync(originalPath)).toBe(false);
    expect(existsSync(bundle.sourcePath)).toBe(false);
    service.close();
  });

  it('手动处理可只冻结选中的就绪资料', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    await service.importFiles([
      { path: '/tmp/选中资料.txt', bytes: Buffer.from('纯虚构选中资料') },
      { path: '/tmp/留待下次.txt', bytes: Buffer.from('纯虚构留待下次') }
    ], personId);
    const [selected, deferred] = service.getSnapshot(null).inbox;
    const account = {
      status: 'connected' as const,
      displayLabel: 'selection@example.invalid',
      quota: { status: 'available' as const, primaryUsedPercent: 10, secondaryUsedPercent: null, resetsAt: null },
      runtimeVersion: 'test-runtime',
      lastCheckedAt: '2026-09-18T01:00:00Z'
    };
    service.processNow({ accountState: account, consentVersion: 1, documentIds: [selected!.id] });
    const job = service.store.claimNextQueuedJob('selection-test', stableHash({ provider: 'codex-chatgpt', displayLabel: account.displayLabel }));
    expect(job?.documentIds).toEqual([selected!.id]);
    expect(job?.documentIds).not.toContain(deferred!.id);
    service.close();
  });

  it('已删除资料不会从收件箱自动回灌，解除抑制后才可重新导入', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    const bytes = Buffer.from('纯虚构删除与回灌测试');
    const first = await service.importFiles([{ path: '/tmp/待删除报告.txt', bytes }], personId);
    expect(first).toMatchObject({ importedCount: 1, suppressedCount: 0 });
    const documentId = service.getSnapshot(null).inbox[0]!.id;

    service.processNow();
    await expect(service.deleteDocument({ documentId, confirmedDelete: true, acknowledgedRecoveryCopies: true }))
      .rejects.toThrow('DOCUMENT_HAS_ACTIVE_JOB');
    const waitingJob = service.getSnapshot(null).jobs[0]!;
    service.store.requestJobCancellation(waitingJob.id);

    const deleted = await service.deleteDocument({ documentId, confirmedDelete: true, acknowledgedRecoveryCopies: true });
    expect(deleted).toMatchObject({ currentWorkspaceRemoved: true, rawObjectDeleted: true, retainedByRecoveryPoint: false });
    expect(service.getSnapshot(null).inbox).toEqual([]);
    expect(service.listDeletedDocuments()).toEqual([expect.objectContaining({ displayName: '待删除报告.txt' })]);

    const suppressed = await service.importFiles([{ path: '/tmp/待删除报告.txt', bytes }], personId);
    expect(suppressed).toMatchObject({ importedCount: 0, duplicateCount: 0, suppressedCount: 1 });
    expect(service.getSnapshot(null).inbox).toEqual([]);

    service.releaseDeletedDocument(deleted.sourceHash);
    const reimported = await service.importFiles([{ path: '/tmp/待删除报告.txt', bytes }], personId);
    expect(reimported).toMatchObject({ importedCount: 1, suppressedCount: 0 });
    service.close();
  });

  it('恢复点引用报告时删除当前档案但保留共享原始对象并明确回执', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    await service.importFiles([{ path: '/tmp/恢复点报告.txt', bytes: Buffer.from('纯虚构恢复点保留测试') }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    const bundle = service.store.getDocumentExtractionBundle(documentId);
    const sourcePath = bundle.sourcePath;
    await ensureLocalRecoveryPoints({ store: service.store, now: new Date('2026-09-18T02:00:00Z') });

    const deleted = await service.deleteDocument({ documentId, confirmedDelete: true, acknowledgedRecoveryCopies: true });
    expect(deleted).toMatchObject({ currentWorkspaceRemoved: true, rawObjectDeleted: false, retainedByRecoveryPoint: true });
    expect(existsSync(sourcePath)).toBe(true);
    expect(service.listDeletedDocuments()).toEqual([expect.objectContaining({ rawObjectRetained: true })]);
    service.close();
  });

  it('未指定成员的资料保持待归属且不会发送', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    await service.importFiles([{ path: '/tmp/公共资料.txt', bytes: Buffer.from('纯虚构公共资料') }], null);
    let snapshot = service.getSnapshot(null);
    expect(snapshot.inbox[0]).toMatchObject({ personId: null, status: 'needs_review', sentToAi: false });
    expect(snapshot.reviews).toHaveLength(1);
    service.store.assignDocumentPerson(snapshot.inbox[0]!.id, personId);
    snapshot = service.getSnapshot(null);
    expect(snapshot.inbox[0]).toMatchObject({ personId, status: 'queued' });
    expect(snapshot.reviews).toEqual([]);
    service.close();
  });

  it('事实冲突可选择仅归档，派生安全问题可只放弃说明', async () => {
    const service = makeService();
    const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    await service.importFiles([{ path: '/tmp/冲突资料.txt', bytes: Buffer.from('纯虚构冲突资料') }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    const spanId = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!.id;
    const fieldIssueId = service.store.saveExtractionReviewIssue({
      documentId, kind: 'field_conflict', severity: 'blocking', evidenceRefs: [spanId]
    });
    service.store.resolveReviewIssue({ issueId: fieldIssueId, documentId, action: 'archive_only' });
    expect(service.getSnapshot(null)).toMatchObject({ inbox: [expect.objectContaining({ id: documentId, status: 'completed' })], reviews: [] });

    const derivedIssueId = service.store.saveExtractionReviewIssue({
      documentId, kind: 'derived_safety', severity: 'blocking', evidenceRefs: [spanId], preserveDocumentStatus: true
    });
    service.store.resolveReviewIssue({ issueId: derivedIssueId, documentId, action: 'dismiss_derived' });
    expect(service.getSnapshot(null)).toMatchObject({ inbox: [expect.objectContaining({ id: documentId, status: 'completed' })], reviews: [] });
    service.close();
  });

  it('按授权目录和本地时区建立每日幂等任务', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-schedule-service-'));
    const inbox = mkdtempSync(join(tmpdir(), 'family-health-schedule-inbox-'));
    directories.push(root, inbox);
    const service = new PersonalWorkspaceService(
      root,
      '我的家庭健康',
      () => new Date('2026-09-18T01:00:00Z'),
      () => 'Asia/Shanghai'
    );
    const personId = service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    const account = {
      status: 'connected' as const,
      displayLabel: 'schedule@example.invalid',
      quota: { status: 'available' as const, primaryUsedPercent: 10, secondaryUsedPercent: null, resetsAt: null },
      runtimeVersion: 'test-runtime',
      lastCheckedAt: '2026-09-18T01:00:00Z'
    };
    const binding = service.createInboxBinding({
      canonicalPath: inbox,
      personId,
      recursive: true,
      allowScheduledAiProcessing: true,
      consentVersion: 1,
      accountState: account
    });
    await service.importFiles([{ path: join(inbox, '虚构日程资料.txt'), bytes: Buffer.from('纯虚构日程资料') }], personId, binding.id);
    const current = service.getSnapshot(account);
    const updated = service.updateSchedule({ enabled: true, localTime: '08:00', expectedRevision: current.scheduleRevision });
    expect(updated).toMatchObject({ enabled: true, timeZone: 'Asia/Shanghai', localTime: '08:00' });
    expect(service.runScheduleCheck(account)).toMatchObject({ created: true, queued: true, idempotent: false });
    expect(service.runScheduleCheck(account)).toMatchObject({ created: false, queued: false });
    expect(service.getSnapshot(account)).toMatchObject({
      scheduleEnabled: true,
      scheduleLocalTime: '08:00',
      scheduleTimeZone: 'Asia/Shanghai',
      jobs: [expect.objectContaining({ status: 'queued', stage: 'extract' })]
    });
    service.close();
  });

  it('连续 30 天无新增且每天多次重启，不创建空任务或膨胀日程记录', () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-30-day-schedule-'));
    directories.push(root);
    let now = new Date('2026-09-01T13:05:00Z');
    let service = new PersonalWorkspaceService(root, '我的家庭健康', () => now, () => 'Asia/Shanghai');
    service.ensurePrimaryMember({ displayName: '测试用户', relation: '本人' });
    service.updateSchedule({ enabled: true, localTime: '20:00', expectedRevision: service.getSchedule().revision });
    service.close();

    const account = {
      status: 'disconnected' as const,
      displayLabel: null,
      quota: { status: 'unknown' as const, primaryUsedPercent: null, secondaryUsedPercent: null, resetsAt: null },
      runtimeVersion: 'test-runtime',
      lastCheckedAt: null
    };
    for (let day = 0; day < 30; day += 1) {
      now = new Date(Date.UTC(2026, 8, 1 + day, 13, 5));
      for (let restart = 0; restart < 3; restart += 1) {
        service = new PersonalWorkspaceService(root, '我的家庭健康', () => now, () => 'Asia/Shanghai');
        expect(service.runScheduleCheck(account)).toEqual({ created: false, queued: false, idempotent: false });
        expect(service.store.listStoredJobs()).toEqual([]);
        service.close();
      }
    }

    const database = new Database(join(root, 'health.db'), { readonly: true });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM schedules`).get()).toEqual({ count: 1 });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM batches`).get()).toEqual({ count: 0 });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM jobs`).get()).toEqual({ count: 0 });
    database.close();
  }, 60_000);
});
