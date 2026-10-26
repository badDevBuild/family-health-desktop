import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ObservationCandidate, ReportMetadataCandidate, SourceManifest, SourceSpan } from '@contracts';
import { stableHash } from '@core';
import type { PublishFactsInput, StoredReportMetadataSummary, WorkspaceStore } from '@storage';
import { EVENT_DATE_PROJECTION_VERSION, projectEventDate, projectReportIssuedTime, readEventDateSources, type EventDateSource } from './event-date-projection.js';
import { buildSystemEvidenceBundle } from './system-evidence.js';
import { PersonalWorkspaceService } from './workspace-service.js';
import { buildMemberAssessmentInput } from './member-assessment-input.js';
import { withDocumentTimes } from './observation-date-presentation.js';
import { buildMetricSeries } from '@core';

vi.mock('@core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core')>();
  return { ...actual, stableHash: vi.fn(actual.stableHash) };
});

const services: PersonalWorkspaceService[] = [];
const roots: string[] = [];
afterEach(() => { services.splice(0).forEach((service) => service.close()); roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });

function fixture(legacy = false, documentId = 'synthetic-document', sourceObjectId = 'synthetic-source', sha256 = 'a'.repeat(64)) {
  const page: SourceSpan = { id: `page-${documentId}`, documentId, spanKind: 'image', page: 1,
    blockId: 'direct-original-page:1', lineStart: null, lineEnd: null, quote: null, readability: 'unreadable' };
  const excerpt = (id: string, quote: string, role: NonNullable<SourceSpan['modelEvidence']>['role']): SourceSpan => ({
    id: `${id}-${documentId}`, documentId, spanKind: 'block', page: 1, blockId: `model-original-excerpt:${page.id}`,
    lineStart: null, lineEnd: null, quote, readability: 'clear', ...(legacy ? {} : { modelEvidence: {
      version: 1, engine: 'codex-original-reading-v1', modelId: 'synthetic-model', threadId: 'synthetic-thread',
      turnId: 'synthetic-turn', originalSha256: sha256, originalSourceObjectId: sourceObjectId,
      parentSourceSpanId: page.id, inputKind: 'image', role, clarity: 'clear'
    } as const })
  });
  const earlier = excerpt('earlier', '检查日期 2026-02-01', 'date');
  const main = excerpt('main', '检查日期 2026-02-03', 'date');
  const issued = excerpt('issued', '签发日期 2026-02-04', 'date');
  const history = excerpt('history', '历史检查日期 2020-02-01', 'date');
  const finding = excerpt('finding', '收缩压 128 mmHg', 'finding');
  const ref = (span: SourceSpan) => ({ sourceSpanId: span.id, quote: span.quote });
  const time = (span: SourceSpan, value: string, role: ReportMetadataCandidate['times'][number]['role'] = 'examined') =>
    ({ value, precision: 'day' as const, role, evidence: [ref(span)] });
  const metadata: ReportMetadataCandidate = { reportKind: null, title: null, organization: null, campus: null,
    department: null, reportNumber: null, examItems: [],
    times: [time(earlier, '2026-02-01'), time(main, '2026-02-03'), time(issued, '2026-02-04', 'report_issued'), time(history, '2020-02-01', 'history_quoted')] };
  const manifest: SourceManifest = { id: `manifest-${documentId}`, sourceObjectId, sha256, mediaType: 'image/png',
    originalDisplayName: 'synthetic.png', totalUnits: 1, coveredUnitIndexes: [0],
    spans: legacy ? [earlier, main, issued, history, finding] : [page, earlier, main, issued, history, finding],
    normalizerVersion: legacy ? 'synthetic-legacy-text-v1' : 'direct-original-preparation-v1',
    conversionWarnings: [], createdAt: '2026-02-05T00:00:00Z' };
  const report: StoredReportMetadataSummary = { documentId, reportId: `report-${documentId}`, eventId: `event-${documentId}`,
    title: '合成报告', reportKind: 'health_report', organization: null, reportDate: '2026-02-04',
    metadataStatus: 'inferred', metadataRevision: 1, extracted: metadata, department: null,
    clinicalTime: { value: '2026-02-01', precision: 'day' }, canUndo: false };
  const source: EventDateSource = { report, manifest };
  return { source, manifest, report, metadata, page, earlier, main, issued, history, finding, ref };
}

const unknownDate = { eventDate: null, endDate: null, eventPrecision: 'unknown', basis: 'unknown',
  explicitClinicalTime: null, explicitReportTime: null, sourceTime: null, hasExplicitRange: false };

describe('单项日期与报告所属时间分开显示', () => {
  it.each(['clinical', 'report', 'multiple_clinical_dates'] as const)('%s有据报告时期用于普通结果展示和趋势，但不改写原事实', basis => {
    const f = fixture(); f.metadata.primaryClinicalTimeIndex = basis === 'clinical' ? 1 : null;
    if (basis === 'report') f.metadata.times = [f.metadata.times[2]!];
    const store = { listReportMetadata: () => [f.report], getDocumentExtractionBundle: () => ({
      personId: 'synthetic-person', documentId: f.report.documentId, manifest: f.manifest
    }) } as unknown as Pick<WorkspaceStore, 'listReportMetadata' | 'getDocumentExtractionBundle'>;
    const rows = [{ documentId: f.report.documentId, clinicalDate: null }];
    const projected = withDocumentTimes(store, 'synthetic-person', rows);
    expect(projected[0]!.clinicalDate).toBeNull(); expect(rows).toEqual([{ documentId: f.report.documentId, clinicalDate: null }]);
    expect(projected[0]!.documentTime).toMatchObject({ value: basis === 'clinical' ? '2026-02-03' : '2026-02-04', basis: 'report' });
    const [series] = buildMetricSeries([{ ...projected[0]!, id: 'test', personId: 'synthetic-person',
      rawName: '合成指标', rawText: '7', numericValue: 7, comparator: 'eq', unit: 'U/L', referenceLow: null,
      referenceHigh: null, abnormalFlag: 'unknown', specimen: null, method: null, bodySite: null,
      sourceSpanId: null, sourceLabel: '合成报告' }]);
    expect(series!.points[0]).toMatchObject({ timestamp: expect.any(Number), comparable: true,
      time: { value: projected[0]!.documentTime!.value, basis: 'report', displayLabel: expect.stringContaining('按报告日期记录') },
      documentTime: { value: projected[0]!.documentTime!.value } });
    expect(series!.points[0]!.comparabilityReasons).toContain('report_date_used');
    expect(series!.latestDate).toBe(projected[0]!.documentTime!.value); expect(series!.trendFacts.usablePointCount).toBe(1);
  });

  it('有单项日期不被报告主日期覆盖，缺来源或他人原件也不提供备用日期', () => {
    const f = fixture(); f.metadata.primaryClinicalTimeIndex = 1;
    const store = { listReportMetadata: () => [f.report], getDocumentExtractionBundle: () => ({
      personId: 'other-person', documentId: f.report.documentId, manifest: f.manifest
    }) } as unknown as Pick<WorkspaceStore, 'listReportMetadata' | 'getDocumentExtractionBundle'>;
    const rows = [{ documentId: f.report.documentId, clinicalDate: '2020-02-01' },
      { documentId: f.report.documentId, clinicalDate: null }];
    expect(withDocumentTimes(store, 'synthetic-person', rows)).toEqual(rows);
  });

  it('签发时间只作显示备用，缺证据或相互矛盾时仍不选其中一个日期', () => {
    const f = fixture(); f.metadata.primaryClinicalTimeIndex = null;
    expect(projectEventDate([f.source], [])).toEqual(unknownDate);
    expect(projectReportIssuedTime([f.source])).toMatchObject({ value: '2026-02-04', role: 'report_issued', basis: 'report' });
    const other = fixture(false, 'other-document');
    other.issued.quote = '签发日期 2026-02-05';
    other.metadata.times[2] = { ...other.metadata.times[2]!, value: '2026-02-05', evidence: [other.ref(other.issued)] };
    expect(projectReportIssuedTime([f.source, other.source])).toBeNull();
    f.metadata.times[2]!.evidence = [{ sourceSpanId: f.page.id, quote: null }];
    expect(projectReportIssuedTime([f.source])).toBeNull();
  });

  it('旧模型已逐项引用的历史日期可恢复，名称或同页日期本身不能创造对应关系', () => {
    const f = fixture(); f.metadata.primaryClinicalTimeIndex = 1;
    const store = { listReportMetadata: () => [f.report], getDocumentExtractionBundle: () => ({
      personId: 'synthetic-person', documentId: f.report.documentId, manifest: f.manifest
    }) } as unknown as Pick<WorkspaceStore, 'listReportMetadata' | 'getDocumentExtractionBundle'>;
    const row = { documentId: f.report.documentId, clinicalDate: null,
      originalName: '合成趋势（2020-02-01）', evidence: [{ sourceSpanId: f.history.id, quote: '2020-02-01' }] };
    const before = structuredClone(row);
    expect(withDocumentTimes(store, 'synthetic-person', [row])[0]).toMatchObject({ clinicalDate: null,
      effectiveTime: { value: '2020-02-01', basis: 'clinical' }, effectiveTimeEvidence: row.evidence });
    expect(row).toEqual(before);
    for (const invalid of [ { ...row, evidence: [] }, { ...row, evidence: [f.ref(f.history)] },
      { ...row, evidence: [{ sourceSpanId: f.main.id, quote: '2020-02-01' }] },
      { ...row, originalName: '合成趋势（2019-02-01）' } ]) {
      expect(withDocumentTimes(store, 'synthetic-person', [invalid])[0]).not.toHaveProperty('effectiveTime');
    }
  });

  it.each(['valid', 'no_dedicated_quote', 'no_item_date', 'duplicate_position', 'wrong_hash', 'issued_role'] as const)(
    '多期框架须有已保存的唯一专门日期引用，不要求展示名重复日期：%s', mode => {
      const f = fixture(); f.metadata.primaryClinicalTimeIndex = 1;
      f.finding.quote = '历史对照\n2020-02-01 2021-02-01\n合成甲 7 8';
      const store = { listReportMetadata: () => [f.report], getDocumentExtractionBundle: () => ({
        personId: 'synthetic-person', documentId: f.report.documentId, manifest: f.manifest
      }) } as unknown as Pick<WorkspaceStore, 'listReportMetadata' | 'getDocumentExtractionBundle'>;
      const row = { documentId: f.report.documentId, clinicalDate: null, originalName: '合成趋势（2020-02-01）',
        evidence: [{ sourceSpanId: f.finding.id, quote: '2020-02-01' }] };
      if (mode === 'no_dedicated_quote') row.evidence[0]!.quote = f.finding.quote;
      if (mode === 'no_item_date') row.originalName = '合成趋势';
      if (mode === 'duplicate_position') f.finding.quote += '\n2020-02-01';
      if (mode === 'wrong_hash') f.finding.modelEvidence!.originalSha256 = 'b'.repeat(64);
      if (mode === 'issued_role') f.metadata.times.push({ value: '2020-02-01', precision: 'day', role: 'report_issued', evidence: row.evidence });
      const result = withDocumentTimes(store, 'synthetic-person', [row])[0]!;
      if (mode === 'valid' || mode === 'no_item_date') expect(result.effectiveTime).toMatchObject({ value: '2020-02-01', basis: 'clinical' });
      else expect(result).not.toHaveProperty('effectiveTime');
    });
});

describe('事件主日期的共享纯读取规则', () => {
  it.each(['explicit_null', 'missing_multi', 'missing_metadata'] as const)('%s不复活旧锚点，也不借事实或签发时间猜临床日期', (mode) => {
    const f = fixture();
    if (mode === 'explicit_null') f.metadata.primaryClinicalTimeIndex = null;
    if (mode === 'missing_metadata') f.report.extracted = null;
    const before = structuredClone(f.source);
    expect(projectEventDate([f.source], ['2026-02-01', '2026-02-03'])).toEqual(unknownDate);
    expect(f.source).toEqual(before);
  });

  it('仅有有据报告日期时按报告时间放入时间线，历史日期和事实日期不改写为本次日期', () => {
    const f = fixture(); f.metadata.primaryClinicalTimeIndex = null;
    f.metadata.times = [f.metadata.times[2]!, f.metadata.times[3]!];
    const before = structuredClone(f.source);
    expect(projectEventDate([f.source], ['2020-02-01'])).toMatchObject({ eventDate: '2026-02-04',
      basis: 'report', explicitClinicalTime: null, explicitReportTime: { role: 'report_issued' },
      sourceTime: { basis: 'report', evidence: [f.ref(f.issued)] }, hasExplicitRange: false });
    expect(f.source).toEqual(before);
  });

  it('可用临床时间优先于报告时间，保留真实日期角色', () => {
    const f = fixture(); f.metadata.primaryClinicalTimeIndex = 1;
    expect(projectEventDate([f.source], [])).toMatchObject({ eventDate: '2026-02-03', basis: 'clinical',
      explicitClinicalTime: { role: 'examined' }, explicitReportTime: null });
  });

  it.each(['history_only', 'missing_source', 'conflicting_issued', 'empty'] as const)('%s不能充作报告备用时间', (mode) => {
    const f = fixture(); f.metadata.primaryClinicalTimeIndex = null;
    f.metadata.times = [f.metadata.times[2]!, f.metadata.times[3]!];
    if (mode === 'history_only') f.metadata.times = [f.metadata.times[1]!];
    if (mode === 'missing_source') f.metadata.times[0]!.evidence = [{ sourceSpanId: f.page.id, quote: null }];
    if (mode === 'conflicting_issued') f.metadata.times.push({ ...f.metadata.times[0]!, value: '2026-02-05' });
    if (mode === 'empty') f.metadata.times = [];
    expect(projectEventDate([f.source], ['2020-02-01'])).toEqual(unknownDate);
  });

  it.each(['finding', 'instruction'] as const)('同一%s原文中明确绑定的日期可复用，不必复制date摘录', (role) => {
    const f = fixture(); f.metadata.primaryClinicalTimeIndex = 1; f.main.modelEvidence!.role = role;
    expect(projectEventDate([f.source], [])).toMatchObject({ eventDate: '2026-02-03', basis: 'clinical' });
    f.main.quote = '同段检查发现，没有该日期'; f.metadata.times[1]!.evidence[0]!.quote = null;
    expect(projectEventDate([f.source], [])).toEqual(unknownDate);
  });

  it('合并事件中的每份文件必须有各自时间，不能借另一文件的报告日期', () => {
    const f = fixture(); f.metadata.times = [f.metadata.times[2]!]; f.metadata.primaryClinicalTimeIndex = null;
    const other = fixture(false, 'other-document'); other.metadata.times = []; other.metadata.primaryClinicalTimeIndex = null;
    expect(projectEventDate([f.source, other.source], [])).toEqual(unknownDate);
    other.metadata.times = [{ ...f.metadata.times[0]!, evidence: [other.ref(other.issued)] }];
    expect(projectEventDate([f.source, other.source], [])).toMatchObject({ eventDate: '2026-02-04', basis: 'report' });
    other.metadata.times[0]!.value = '2025-02-04';
    expect(projectEventDate([f.source, other.source], [])).toEqual(unknownDate);
  });

  it('有效selector指向非首项，保留该日期和角色而不自动拼范围', () => {
    const f = fixture(); f.metadata.primaryClinicalTimeIndex = 1; f.metadata.times[1]!.role = 'sampled';
    expect(projectEventDate([f.source], ['2026-02-01'])).toMatchObject({ eventDate: '2026-02-03',
      endDate: null, eventPrecision: 'day', explicitClinicalTime: { role: 'sampled' }, hasExplicitRange: false });
  });

  it('缺selector只兼容唯一且有真实模型日期出处的临床日期', () => {
    const f = fixture(); f.metadata.times = [f.metadata.times[1]!, f.metadata.times[2]!, f.metadata.times[3]!];
    expect(projectEventDate([f.source], [])).toMatchObject({ eventDate: '2026-02-03', endDate: null });
    f.metadata.times[0]!.evidence = [{ sourceSpanId: f.page.id, quote: null }];
    expect(projectEventDate([f.source], ['2026-02-03'])).toEqual(unknownDate);
  });

  it('仅有正规原页骨架、尚无模型摘录时也不能退回事实日期；未知准备版本同样不能冒充legacy', () => {
    const f = fixture(); f.manifest.spans = [f.page]; f.report.extracted = null;
    expect(projectEventDate([f.source], ['2026-02-03'])).toEqual(unknownDate);
    f.manifest.normalizerVersion = 'direct-original-unrecognized-version';
    expect(projectEventDate([f.source], ['2026-02-03'])).toEqual(unknownDate);
  });

  it.each(['issued', 'history', 'out_of_range'] as const)('非法主日期%s保持未知', (mode) => {
    const f = fixture(); f.metadata.primaryClinicalTimeIndex = mode === 'issued' ? 2 : mode === 'history' ? 3 : 99;
    expect(projectEventDate([f.source], ['2026-02-03'])).toEqual(unknownDate);
  });

  it.each(['hash', 'object', 'parent', 'uncertain', 'role', 'quote', 'other_document', 'forged_legacy'] as const)('来源%s不可信不能作为主日期，也不能退回事实日期', (mode) => {
    const f = fixture(); f.metadata.primaryClinicalTimeIndex = 1;
    if (mode === 'hash') f.main.modelEvidence!.originalSha256 = 'b'.repeat(64);
    if (mode === 'object') f.main.modelEvidence!.originalSourceObjectId = 'other-source';
    if (mode === 'parent') f.main.modelEvidence!.parentSourceSpanId = 'missing-page';
    if (mode === 'uncertain') f.main.modelEvidence!.clarity = 'uncertain';
    if (mode === 'role') f.main.modelEvidence!.role = 'context';
    if (mode === 'quote') f.metadata.times[1]!.evidence[0]!.quote = '不存在的合成引文';
    if (mode === 'other_document') f.main.documentId = 'other-document';
    if (mode === 'forged_legacy') f.manifest.normalizerVersion = 'synthetic-legacy-text-v1';
    expect(projectEventDate([f.source], ['2026-02-03'])).toEqual(unknownDate);
  });

  it('用户corrected日期优先，用户明确清空日期也不被提取或事实补回', () => {
    const f = fixture(); f.metadata.primaryClinicalTimeIndex = null; f.report.metadataStatus = 'corrected';
    f.report.clinicalTime = { value: '2025-01', precision: 'month' };
    expect(projectEventDate([f.source], [])).toMatchObject({ eventDate: '2025-01', eventPrecision: 'month', endDate: null });
    f.report.clinicalTime = { value: null, precision: 'unknown' };
    expect(projectEventDate([f.source], ['2026-02-03'])).toEqual(unknownDate);
  });

  it('仅明确非direct旧来源保留多次检查范围和事实日期兼容，明示null仍优先', () => {
    const f = fixture(true);
    expect(projectEventDate([f.source], [])).toMatchObject({ eventDate: '2026-02-01', endDate: '2026-02-03', hasExplicitRange: true });
    f.metadata.times = [];
    expect(projectEventDate([f.source], ['2026-02-03'])).toMatchObject({ eventDate: '2026-02-03', explicitClinicalTime: null });
    f.metadata.primaryClinicalTimeIndex = null;
    expect(projectEventDate([f.source], ['2026-02-03'])).toEqual(unknownDate);
  });

  it('共享事件不能从另一报告覆盖direct的未知，读取来源缺失或成员不符也保持未知', () => {
    const f = fixture(); f.metadata.primaryClinicalTimeIndex = 1;
    const other = fixture(false, 'other-document'); other.metadata.primaryClinicalTimeIndex = null;
    expect(projectEventDate([f.source, other.source], [])).toEqual(unknownDate);
    const getter = vi.fn(() => ({ documentId: f.report.documentId, personId: 'other-person', manifest: f.manifest }));
    const sources = readEventDateSources({ getDocumentExtractionBundle: getter } as unknown as WorkspaceStore, 'synthetic-person', [f.report]);
    expect(sources[0]!.manifest).toBeNull();
    expect(projectEventDate(sources, ['2026-02-03'])).toEqual(unknownDate);
    getter.mockImplementation(() => { throw new Error('SYNTHETIC_MISSING'); });
    expect(readEventDateSources({ getDocumentExtractionBundle: getter } as unknown as WorkspaceStore, 'synthetic-person', [f.report])[0]!.manifest).toBeNull();
  });
});

function databaseState(store: WorkspaceStore) {
  const db = (store as unknown as { db: Database.Database }).db;
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .map((row) => String((row as { name: string }).name));
  return { changes: db.prepare('SELECT total_changes() AS count').get(),
    files: ['', '-wal'].map((suffix) => existsSync(`${store.databasePath}${suffix}`)
      ? createHash('sha256').update(readFileSync(`${store.databasePath}${suffix}`)).digest('hex') : null),
    tables: tables.map((name) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]) };
}

describe('真实服务和身体系统事件日期的只读接线', () => {
  it.each(['explicit_null', 'missing_multi', 'nonfirst_selector', 'corrected', 'report_only', 'report_finding'] as const)('%s在两条读取路径一致，旧库锚点及逐项事实完全不变', (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-event-date-synthetic-')); roots.push(root);
    const service = new PersonalWorkspaceService(root, '合成工作区', () => new Date('2026-02-05T00:00:00Z')); services.push(service);
    const store = service.store;
    const personId = store.createPerson({ displayName: '合成成员' }).id;
    const original = store.putSourceObject({ bytes: Buffer.from(`synthetic original ${randomUUID()}`), mediaType: 'image/png', displayName: 'synthetic.png' });
    const { documentId } = store.registerImportedDocument({ sourceObjectId: original.id, personId });
    const f = fixture(false, documentId, original.id, original.sha256);
    if (mode === 'explicit_null') f.metadata.primaryClinicalTimeIndex = null;
    if (mode === 'nonfirst_selector') f.metadata.primaryClinicalTimeIndex = 1;
    const reportOnly = mode === 'report_only' || mode === 'report_finding';
    if (reportOnly) {
      f.metadata.primaryClinicalTimeIndex = null;
      f.metadata.times = [f.metadata.times[2]!, f.metadata.times[3]!];
    }
    if (mode === 'report_finding') {
      f.issued.modelEvidence!.role = 'finding';
      f.metadata.times[0]!.evidence = [{ sourceSpanId: f.issued.id, quote: null }];
    }
    store.saveSourceManifest(f.manifest);
    const clinicalDate = reportOnly ? null : '2026-02-03';
    const acceptanceId = store.saveAcceptanceDecision({ method: 'auto', actor: 'policy', decision: 'accept',
      rulesVersion: 'synthetic', inputSignature: randomUUID(), outputHash: randomUUID(), reviewRef: null });
    const candidate: ObservationCandidate = { localKey: 'synthetic-pressure', originalName: '收缩压', standardNameCandidate: null,
      value: { kind: 'numeric', rawText: '128', decimal: '128', comparator: 'eq' }, unitRaw: 'mmHg', referenceRangeRaw: null,
      reportedAbnormalFlag: null, specimen: null, method: null, bodySite: null, clinicalDate,
      evidence: [f.ref(f.finding), f.ref(f.main)], sourceBinding: { headingEvidence: [], findingEvidence: [f.ref(f.finding)] }, issues: [] };
    const observation: PublishFactsInput['observations'][number] = { conceptKey: '收缩压', originalName: '收缩压', rawText: '128',
      valueKind: 'numeric', decimalValue: '128', qualifier: 'eq', unit: 'mmHg', referenceRange: null,
      clinicalDate, abnormalFlag: 'unknown', specimen: null, method: null, bodySite: null,
      documentId, sourceSpanId: f.finding.id, acceptanceId, evidence: candidate.evidence, sourceBinding: candidate.sourceBinding, candidate };
    store.publishFacts({ personId, documentId, documentCommitKey: randomUUID(), changeSetHash: randomUUID(),
      expectedRevision: 0, observations: [observation], reportMetadata: f.metadata, summary: '合成主日期接纳' });
    const report = store.listReportMetadata(personId)[0]!;
    expect(store.listAcceptedObservations(personId)).toHaveLength(1);
    // 仅在隔离合成库模拟旧自动缓存；正式读取不得修写它，也不得将它当作主日期依据。
    const db = (store as unknown as { db: Database.Database }).db;
    db.prepare("UPDATE health_events_v2 SET clinical_date='2026-02-01',date_precision='day',date_source='explicit' WHERE id=?").run(report.eventId);
    if (mode === 'corrected') store.updateReportMetadata({ personId, reportId: report.reportId,
      expectedRevision: report.metadataRevision, title: report.title, organization: null, department: null,
      clinicalTime: { value: '2025-01', precision: 'month' }, reason: '合成用户修正' });
    const before = databaseState(store);
    const event = service.listHealthEvents(personId)[0]!;
    vi.mocked(stableHash).mockClear();
    const bundle = buildSystemEvidenceBundle(store, personId, 'cardiovascular');
    const signatureInput = vi.mocked(stableHash).mock.calls.map(([input]) => input)
      .find((input) => input !== null && typeof input === 'object' && 'selectorVersions' in input) as {
        selectorVersions: Record<string, string>;
      };
    expect(signatureInput.selectorVersions.eventDateProjection).toBe(EVENT_DATE_PROJECTION_VERSION);
    const oldSignatureInput = structuredClone(signatureInput);
    delete oldSignatureInput.selectorVersions.eventDateProjection;
    expect(stableHash(signatureInput)).toBe(bundle.scope.inputSignature);
    expect(stableHash(oldSignatureInput)).not.toBe(bundle.scope.inputSignature);
    const expected = mode === 'corrected' ? '2025-01' : mode === 'nonfirst_selector' ? '2026-02-03'
      : reportOnly ? '2026-02-04' : null;
    expect(event.time).toMatchObject({ value: expected, endValue: null,
      precision: expected === null ? 'unknown' : mode === 'corrected' ? 'month' : 'day', source: expected === null ? 'unknown' : 'explicit' });
    expect(bundle.events[0]!.time).toMatchObject({ value: expected, endValue: null, precision: event.time.precision, source: event.time.source });
    expect(service.getHealthEventDetail(personId, event.id).time).toEqual(event.time);
    expect(bundle.directFacts[0]!.time.value).toBe(reportOnly ? '2026-02-04' : clinicalDate);
    const assessment = buildMemberAssessmentInput(store, personId, { modelId: 'synthetic-model', reasoningEffort: 'low',
      analysisReferenceDate: '2026-03-01', webSearchAllowed: false });
    expect(assessment.evidencePackage.facts[0]!.clinicalDate).toBe(clinicalDate);
    if (reportOnly) {
      expect(event.time).toMatchObject({ basis: 'report', role: 'report', displayLabel: expect.stringContaining('按报告日期') });
      expect(bundle.events[0]!.time.basis).toBe('report');
      const body = service.getBodySystemDetail(personId, 'cardiovascular');
      expect(body.metrics[0]!.points[0]).toMatchObject({ time: { value: '2026-02-04', basis: 'report' }, timestamp: expect.any(Number),
        documentTime: { value: '2026-02-04', basis: 'report', displayLabel: '2026-02-04 · 所属报告的签发日期' } });
      expect(service.getMetricSeries(personId, body.metrics[0]!.id).tableRows[0]).toEqual(body.metrics[0]!.points[0]);
      expect(service.getHealthEventDetail(personId, event.id).findings[0]!.time).toMatchObject({
        value: '2026-02-04', basis: 'report', displayLabel: '2026-02-04 · 按报告日期记录' });
      expect(assessment.evidencePackage.facts[0]!.sourceTime).toMatchObject({ scope: 'document',
        value: '2026-02-04', basis: 'report', role: 'report_issued', evidence: f.metadata.times[0]!.evidence });
      expect(assessment.evidencePackage.facts[0]!.effectiveTime).toMatchObject({ value: '2026-02-04', basis: 'report', evidence: f.metadata.times[0]!.evidence });
      expect(assessment.evidencePackage.evidenceCatalog.some(ref => ref.observationId === assessment.evidencePackage.facts[0]!.observationId
        && ref.sourceSpanId === f.issued.id)).toBe(true);
      expect(assessment.request.clinicalAsOf).toBe('2026-02-04');
    } else expect(assessment.evidencePackage.facts[0]).not.toHaveProperty('sourceTime');
    expect(databaseState(store)).toEqual(before);
    expect(store.listAcceptedObservations(personId)[0]).toMatchObject({ clinicalDate, rawText: '128' });
  });
});
