import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { ReportMetadataCandidate } from '../packages/contracts/src/index.ts';
import { PersonalWorkspaceService } from '../apps/desktop/src/main/workspace-service.ts';

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const requestedUserData = argument('user-data');
if (!requestedUserData) throw new Error('请提供 --user-data=/private/tmp/family-health-app-smoke-...');
const userData = resolve(requestedUserData);
const expectedParent = resolve(tmpdir());
if (dirname(userData) !== expectedParent || !basename(userData).startsWith('family-health-app-smoke-')) {
  throw new Error(`SMOKE_USER_DATA_OUTSIDE_ALLOWED_ROOT: ${userData}`);
}

mkdirSync(userData, { recursive: true });
const workspaceRoot = join(userData, 'workspace');
mkdirSync(workspaceRoot, { recursive: true });
writeFileSync(join(userData, 'desktop-state.json'), `${JSON.stringify({
  activeWorkspaceMode: 'personal',
  workspaceName: '事件合成验收工作区',
  stayInTray: false,
  openAtLogin: false,
  notificationsEnabled: true,
  displayPreferences: { fontScale: 'standard', reduceMotion: false, dateStyle: 'friendly' },
  aiPreferences: { modelId: 'gpt-5.6-sol', reasoningEffort: 'medium' }
}, null, 2)}\n`);

const service = new PersonalWorkspaceService(workspaceRoot, '事件合成验收工作区', () => new Date('2026-09-21T10:00:00.000Z'));

try {
  requireCondition(service.getSnapshot(null).persons.length === 0, 'SMOKE_WORKSPACE_MUST_BE_EMPTY');
  const personId = service.ensurePrimaryMember({ displayName: '合成成员丙', relation: '本人' });
  const reportDate = '2026-09-12';
  const organization = '合成健康中心（旧称）';
  const encounterIdentifier = 'CHECKUP-2026-SYNTHETIC-001';
  const metadataFor = (title: string, spanId: string, quote: string): ReportMetadataCandidate => ({
    reportKind: { value: '年度体检报告', evidence: [{ sourceSpanId: spanId, quote }] },
    title: { value: title, evidence: [{ sourceSpanId: spanId, quote }] },
    organization: { value: organization, evidence: [{ sourceSpanId: spanId, quote }] },
    campus: null,
    department: null,
    reportNumber: null,
    encounterIdentifier: { value: encounterIdentifier, evidence: [{ sourceSpanId: spanId, quote }] },
    sampleIdentifiers: [],
    examItems: [],
    times: [{ value: reportDate, precision: 'day', role: 'examined', evidence: [{ sourceSpanId: spanId, quote }] }]
  });
  const documents: Array<{
    displayName: string;
    title: string;
    sourceText: string;
    observations: Array<{
      conceptKey: string;
      rawText: string;
      valueKind: 'numeric' | 'qualitative' | 'text';
      decimalValue: string | null;
      qualifier: string | null;
      unit: string | null;
      referenceRange: string | null;
      clinicalDate: string;
      abnormalFlag: 'high' | 'normal' | 'unknown';
      specimen: string | null;
      method: string | null;
      bodySite: string | null;
    }>;
    historyTime?: string;
  }> = [
    {
      displayName: '2026年度体检总报告.txt',
      title: '2026 年度体检',
      sourceText: `${organization} ${reportDate} ${encounterIdentifier} 体重指数 26.0`,
      observations: [{ conceptKey: '体重指数', rawText: '26.0', valueKind: 'numeric', decimalValue: '26.0', qualifier: 'eq', unit: 'kg/m²', referenceRange: '18.5-23.9', clinicalDate: reportDate, abnormalFlag: 'high', specimen: null, method: null, bodySite: null }]
    },
    {
      displayName: '2026检验明细.txt',
      title: '2026 检验明细',
      sourceText: `${organization} ${reportDate} ${encounterIdentifier} LDL-C 4.2 mmol/L`,
      observations: [{ conceptKey: 'LDL-C', rawText: '4.2', valueKind: 'numeric', decimalValue: '4.2', qualifier: 'eq', unit: 'mmol/L', referenceRange: '0-3.4', clinicalDate: reportDate, abnormalFlag: 'high', specimen: '血清', method: '酶法', bodySite: null }]
    },
    {
      displayName: '2026心电图明细.txt',
      title: '2026 心电图明细',
      sourceText: `${organization} ${reportDate} ${encounterIdentifier} 心电图小结 窦性心律`,
      observations: [{ conceptKey: '心电图小结', rawText: '窦性心律', valueKind: 'text', decimalValue: null, qualifier: null, unit: null, referenceRange: null, clinicalDate: reportDate, abnormalFlag: 'unknown', specimen: null, method: '心电图', bodySite: '心脏' }]
    },
    {
      displayName: '2026超声明细.txt',
      title: '2026 超声明细',
      sourceText: `${organization} ${reportDate} ${encounterIdentifier} 甲状腺超声小结 回声不均匀`,
      observations: [{ conceptKey: '甲状腺超声小结', rawText: '回声不均匀', valueKind: 'text', decimalValue: null, qualifier: null, unit: null, referenceRange: null, clinicalDate: reportDate, abnormalFlag: 'unknown', specimen: null, method: '超声', bodySite: '甲状腺' }]
    },
    {
      displayName: '2026肾功能历史比较.txt',
      title: '2026 肾功能历史比较',
      sourceText: `${organization} ${reportDate} ${encounterIdentifier} 血清肌酐 2024-09-01 84 umol/L；${reportDate} 90 umol/L`,
      observations: [
        { conceptKey: '血清肌酐', rawText: '84', valueKind: 'numeric', decimalValue: '84', qualifier: 'eq', unit: 'umol/L', referenceRange: '57-97', clinicalDate: '2024-09-01', abnormalFlag: 'normal', specimen: '血清', method: null, bodySite: null },
        { conceptKey: '血清肌酐', rawText: '90', valueKind: 'numeric', decimalValue: '90', qualifier: 'eq', unit: 'umol/L', referenceRange: '57-97', clinicalDate: reportDate, abnormalFlag: 'normal', specimen: '血清', method: null, bodySite: null }
      ],
      historyTime: '2024-09-01'
    }
  ];

  const importedReports: Array<{ documentId: string; reportId: string; displayName: string }> = [];
  for (const item of documents) {
    const receipt = await service.importFiles([{ path: `/tmp/${item.displayName}`, bytes: Buffer.from(item.sourceText) }], personId);
    requireCondition(receipt.importedCount === 1, `SMOKE_EVENT_IMPORT_FAILED:${item.displayName}:${JSON.stringify(receipt)}`);
    const document = service.getSnapshot(null).inbox.find((candidate) => candidate.displayName === item.displayName);
    requireCondition(document, `SMOKE_EVENT_DOCUMENT_NOT_FOUND:${item.displayName}`);
    const documentId = document.id;
    const span = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!;
    const acceptanceId = service.store.saveAcceptanceDecision({
      method: 'auto',
      actor: 'policy',
      rulesVersion: 'synthetic-event-v1',
      inputSignature: createHash('sha256').update(`${documentId}:input`).digest('hex'),
      outputHash: createHash('sha256').update(`${documentId}:output`).digest('hex'),
      reviewRef: null,
      decision: 'accept'
    });
    const metadata = metadataFor(item.title, span.id, span.quote ?? item.sourceText);
    if (item.historyTime) {
      metadata.times.push({
        value: item.historyTime,
        precision: 'day',
        role: 'history_quoted',
        evidence: [{ sourceSpanId: span.id, quote: span.quote ?? item.sourceText }]
      });
    }
    service.store.publishFacts({
      personId,
      documentId,
      documentCommitKey: createHash('sha256').update(`${documentId}:commit`).digest('hex'),
      expectedRevision: service.store.getFactRevision(personId),
      changeSetHash: createHash('sha256').update(`${documentId}:changes`).digest('hex'),
      summary: `接纳合成事件资料：${item.title}`,
      reportMetadata: metadata,
      observations: item.observations.map((observation) => ({
        ...observation,
        documentId,
        sourceSpanId: span.id,
        acceptanceId,
        evidence: [{ sourceSpanId: span.id, quote: span.quote }]
      }))
    });
    const report = service.store.listReportMetadata(personId).find((candidate) => candidate.documentId === documentId);
    requireCondition(report, `SMOKE_EVENT_REPORT_NOT_FOUND:${item.displayName}`);
    importedReports.push({ documentId, reportId: report.reportId, displayName: item.displayName });
  }

  const eventsBeforeCorrection = service.listHealthEvents(personId);
  requireCondition(eventsBeforeCorrection.length === 1, `SMOKE_EXPECTED_ONE_EVENT:${eventsBeforeCorrection.length}`);
  const eventBefore = service.getHealthEventDetail(personId, eventsBeforeCorrection[0]!.id);
  requireCondition(eventBefore.reports.length === 5, `SMOKE_EXPECTED_FIVE_REPORTS:${eventBefore.reports.length}`);
  requireCondition(eventBefore.findings.length === 5, `SMOKE_EXPECTED_FIVE_CURRENT_FINDINGS:${eventBefore.findings.length}`);
  requireCondition(eventBefore.historicalReferences.length === 1, `SMOKE_EXPECTED_ONE_HISTORY_GROUP:${eventBefore.historicalReferences.length}`);
  requireCondition(eventBefore.historicalReferences[0]?.time.value === '2024-09-01', 'SMOKE_HISTORY_DATE_NOT_PRESERVED');
  requireCondition(!eventBefore.historicalReferences[0]?.sourceReportTitle.includes(organization), 'SMOKE_CURRENT_ORGANIZATION_LEAKED_TO_HISTORY');
  requireCondition(eventBefore.systemIds.includes('cardiovascular') && eventBefore.systemIds.includes('endocrine_metabolic') && eventBefore.systemIds.includes('renal_urinary'), 'SMOKE_EVENT_SYSTEM_LINKS_INCOMPLETE');

  const mainReport = service.store.listReportMetadata(personId).find((report) => report.documentId === importedReports[0]!.documentId);
  requireCondition(mainReport, 'SMOKE_MAIN_REPORT_METADATA_NOT_FOUND');
  const jobsBeforeCorrection = service.store.listStoredJobs().length;
  const correction = service.updateReportMetadata({
    personId,
    reportId: mainReport.reportId,
    expectedRevision: mainReport.metadataRevision,
    title: '2026 年度体检',
    organization: '合成健康中心南山院区',
    department: '健康管理科',
    clinicalTime: { value: reportDate, precision: 'day' },
    reason: '修正合成机构名称'
  });
  const eventsAfterCorrection = service.listHealthEvents(personId);
  const eventAfter = service.getHealthEventDetail(personId, eventsAfterCorrection[0]!.id);
  requireCondition(eventsAfterCorrection.length === 1 && eventAfter.reports.length === 5, 'SMOKE_EVENT_SPLIT_AFTER_METADATA_CORRECTION');
  requireCondition(service.store.listStoredJobs().length === jobsBeforeCorrection, 'SMOKE_METADATA_CORRECTION_TRIGGERED_MODEL_JOB');
  const correctedMain = service.store.listReportMetadata(personId).find((report) => report.reportId === mainReport.reportId);
  requireCondition(correctedMain?.organization === '合成健康中心南山院区', 'SMOKE_ORGANIZATION_CORRECTION_NOT_VISIBLE');
  requireCondition(correction.canUndo, 'SMOKE_METADATA_CORRECTION_NOT_UNDOABLE');

  process.stdout.write(`${JSON.stringify({
    userData,
    personId,
    eventId: eventAfter.id,
    eventCount: eventsAfterCorrection.length,
    reportCount: eventAfter.reports.length,
    currentFindingCount: eventAfter.findings.length,
    historicalReferenceCount: eventAfter.historicalReferences.length,
    historicalOrganizationInferred: false,
    systemIds: eventAfter.systemIds,
    metadataCorrection: {
      reportId: correctedMain.reportId,
      organization: correctedMain.organization,
      canUndo: correction.canUndo,
      modelJobsCreated: service.store.listStoredJobs().length - jobsBeforeCorrection
    }
  }, null, 2)}\n`);
} finally {
  service.close();
}
