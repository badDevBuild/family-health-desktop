import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { ObservationCandidate, ReportMetadataCandidate, SourceManifest, SourceSpan } from '@contracts';
import { WorkspaceStore, type PublishFactsInput } from './index.js';

const fixtures: Array<{ store: WorkspaceStore; root: string }> = [];
afterEach(() => {
  for (const { store, root } of fixtures.splice(0)) { store.close(); rmSync(root, { recursive: true, force: true }); }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'primary-date-projection-synthetic-'));
  const store = new WorkspaceStore({ rootDirectory: root, now: () => new Date('2026-01-01T00:00:00Z') });
  fixtures.push({ store, root });
  const person = store.createPerson({ displayName: '合成日期成员' });
  const db = (store as unknown as { db: Database.Database }).db;
  const state = () => ({ changes: db.prepare('SELECT total_changes() AS count').get(),
    files: ['', '-wal'].map((suffix) => {
      const path = `${store.databasePath}${suffix}`;
      return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
    }),
    tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
      .map((row) => String((row as { name: string }).name)).map((name) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]) });
  const report = (legacy = false, dateSourceRole: 'date' | 'finding' | 'instruction' = 'date',
    amendManifest?: (manifest: SourceManifest) => void) => {
    const source = store.putSourceObject({ bytes: Buffer.from(`完全合成日期原件 ${randomUUID()}`), mediaType: 'image/png', displayName: 'synthetic.png' });
    const { documentId } = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
    const page: SourceSpan = { id: randomUUID(), documentId, spanKind: 'image', page: 1, blockId: 'direct-original-page:1',
      lineStart: null, lineEnd: null, quote: null, readability: 'unreadable' };
    const excerpt = (quote: string, role: NonNullable<SourceSpan['modelEvidence']>['role']): SourceSpan => ({
      id: randomUUID(), documentId, spanKind: 'block', page: 1, blockId: `model-original-excerpt:${page.id}`,
      lineStart: null, lineEnd: null, quote, readability: 'clear', ...(legacy ? {} : { modelEvidence: { version: 1,
        engine: 'codex-original-reading-v1', modelId: 'gpt-6.1-sol', threadId: 'synthetic-thread', turnId: randomUUID(),
        originalSha256: source.sha256, originalSourceObjectId: source.id, parentSourceSpanId: page.id,
        inputKind: 'image', role, clarity: 'clear' } as const }) });
    const historical = excerpt('检查日期：2020-02-01', 'date');
    const current = excerpt('检查日期：2026-02-02', dateSourceRole);
    const otherCurrent = excerpt('采样日期：2026-02-03', 'date');
    const signed = excerpt('报告签发日期：2026-02-04', dateSourceRole);
    const finding = excerpt('合成项目：合成结果', 'finding');
    const organization = excerpt('合成医院；就诊标识：synthetic-encounter', 'identity');
    const spans = legacy ? [historical, current, otherCurrent, signed, finding, organization]
      : [page, historical, current, otherCurrent, signed, finding, organization];
    const manifest: SourceManifest = { id: randomUUID(), sourceObjectId: source.id, sha256: source.sha256,
      mediaType: 'image/png', originalDisplayName: 'synthetic.png', totalUnits: 1, coveredUnitIndexes: [0], spans,
      normalizerVersion: legacy ? 'synthetic-legacy-text-v1' : 'direct-original-preparation-v1',
      conversionWarnings: [], createdAt: '2026-01-01T00:00:00Z' };
    amendManifest?.(manifest);
    store.saveSourceManifest(manifest);
    const acceptanceId = store.saveAcceptanceDecision({ actor: 'policy', method: 'auto', decision: 'accept', rulesVersion: 'synthetic',
      inputSignature: randomUUID(), outputHash: randomUUID(), reviewRef: null });
    const ref = (span: SourceSpan) => ({ sourceSpanId: span.id, quote: span.quote });
    const time = (span: SourceSpan, value: string, role: ReportMetadataCandidate['times'][number]['role'] = 'examined') =>
      ({ value, precision: 'day' as const, role, evidence: [ref(span)] });
    const base: ReportMetadataCandidate = { reportKind: null, title: null, organization: null, campus: null,
      department: null, reportNumber: null, examItems: [], times: [] };
    const times = [time(historical, '2020-02-01'), time(current, '2026-02-02'), time(otherCurrent, '2026-02-03'), time(signed, '2026-02-04', 'report_issued')];
    const candidate: ObservationCandidate = { localKey: randomUUID(), originalName: '合成项目', standardNameCandidate: null,
      value: { kind: 'text', rawText: '合成结果' }, unitRaw: null, referenceRangeRaw: null, reportedAbnormalFlag: null,
      specimen: null, method: null, bodySite: null, clinicalDate: null, evidence: [ref(finding)],
      sourceBinding: { headingEvidence: [], findingEvidence: [ref(finding)] }, issues: [] };
    const observation: PublishFactsInput['observations'][number] = { conceptKey: candidate.originalName, originalName: candidate.originalName,
      modelStandardNameCandidate: null, rawText: '合成结果', valueKind: 'text', decimalValue: null, qualifier: null,
      unit: null, referenceRange: null, clinicalDate: null, abnormalFlag: 'unknown', documentId, sourceSpanId: finding.id,
      acceptanceId, specimen: null, method: null, bodySite: null, evidence: candidate.evidence,
      ...(legacy ? {} : { sourceBinding: candidate.sourceBinding, candidate }) };
    const publish = (metadata?: ReportMetadataCandidate | null, obs = observation) => store.publishFacts({ personId: person.id,
      documentId, documentCommitKey: randomUUID(), changeSetHash: randomUUID(), expectedRevision: store.getFactRevision(person.id),
      summary: '合成日期发布', observations: [obs], ...(metadata === undefined ? {} : { reportMetadata: metadata }) });
    const preview = (metadata: ReportMetadataCandidate) => store.previewDirectOriginalAdmission({ personId: person.id,
      documentId, manifest: store.getDocumentExtractionBundle(documentId).manifest, observations: [], reportMetadata: metadata });
    let dateIssueId: string | null = null;
    const prepareReview = () => dateIssueId = store.saveExtractionReviewIssue({ documentId,
      stage: 'extract', kind: 'field_conflict', severity: 'warning', preserveDocumentStatus: true,
      evidenceRefs: [], candidateOptions: [], reasonCodes: ['SYNTHETIC_DATE_REVIEW'] });
    const append = (metadata: ReportMetadataCandidate, reuseIssue = false) => {
      const issueId = reuseIssue && dateIssueId ? dateIssueId : prepareReview();
      return store.appendCommittedFacts({ personId: person.id, documentId, expectedRevision: store.getFactRevision(person.id),
        summary: '合成正常日期重读', observations: [], reportMetadata: metadata,
        reviewUpdate: { issueId, remainingCandidates: [], remainingReasonCodes: [], remainingEvidenceRefs: [] } });
    };
    const summary = () => store.listReportMetadata(person.id).find((item) => item.documentId === documentId)!;
    const strong = (metadata: ReportMetadataCandidate) => ({ ...metadata,
      organization: { value: '合成医院', evidence: [ref(organization)] },
      encounterIdentifier: { value: 'synthetic-encounter', evidence: [ref(organization)] } });
    return { source, documentId, manifest, historical, current, otherCurrent, signed, finding, base, times,
      candidate, observation, ref, time, publish, preview, append, prepareReview, summary, strong };
  };
  return { store, person, db, state, report };
}

describe('主要临床日期的有来源投影与正常版本化重读', () => {
  it.each(['examined', 'sampled', 'encounter'] as const)('同日历史转述不污染有独立来源的%s日期，预检、发布和重投影一致', (role) => {
    const f = fixture();
    const r = f.report(false, 'date', (manifest) => {
      manifest.spans.find((span) => span.quote === '检查日期：2020-02-01')!.quote = '历史检查日期：2026-02-02';
    });
    const metadata: ReportMetadataCandidate = { ...r.base, times: [r.time(r.current, '2026-02-02', role),
      r.time(r.historical, '2026-02-02', 'history_quoted'), r.times[3]!], primaryClinicalTimeIndex: 0 };
    const before = f.state();
    expect(r.preview(metadata).reportReasonCodes).toEqual([]);
    expect(f.state()).toEqual(before);
    expect(r.publish(metadata).heldReasonCodes).toEqual([]);
    expect(r.summary()).toMatchObject({ reportDate: '2026-02-04', clinicalTime: { value: '2026-02-02', precision: 'day' } });
    const facts = f.store.listAcceptedObservations(f.person.id);
    r.append({ ...metadata, primaryClinicalTimeIndex: null });
    expect(r.summary().clinicalTime.value).toBeNull();
    expect(r.append(metadata).heldReasonCodes).toEqual([]);
    expect(r.summary().clinicalTime.value).toBe('2026-02-02');
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual(facts);
    expect(r.summary().extracted?.times).toEqual(metadata.times);
  });

  it('只有同日历史或签发日期时，不能借当前片段的存在选成检查主日期', () => {
    const f = fixture(); const r = f.report(false, 'date', (manifest) => {
      manifest.spans.find((span) => span.quote === '检查日期：2020-02-01')!.quote = '历史检查日期：2026-02-02';
      manifest.spans.find((span) => span.quote === '报告签发日期：2026-02-04')!.quote = '报告签发日期：2026-02-02';
    });
    for (const selected of [r.time(r.historical, '2026-02-02', 'history_quoted'), r.time(r.signed, '2026-02-02', 'report_issued')]) {
      const metadata = { ...r.base, times: [selected], primaryClinicalTimeIndex: 0 };
      expect(r.preview(metadata).reportReasonCodes).toEqual(['report_metadata_primary_clinical_time_invalid']);
    }
  });

  it.each(['missing_label', 'issued_label', 'history_label', 'negative_label'] as const)('同日历史旁有%s当前证据时仍拒绝，不按日期相同放行', (mode) => {
    const f = fixture();
    const r = f.report(true, 'date', (manifest) => {
      manifest.spans.forEach((span, index) => Object.assign(span, { spanKind: 'line', page: null,
        blockId: null, lineStart: index + 1, lineEnd: index + 1 }));
      manifest.spans.find((span) => span.quote === '检查日期：2020-02-01')!.quote = '历史检查日期：2026-02-02';
      manifest.spans.find((span) => span.quote === '检查日期：2026-02-02')!.quote = {
        missing_label: '合成日期值：2026-02-02', issued_label: '报告签发日期：2026-02-02',
        history_label: '上次检查日期：2026-02-02', negative_label: '非检查日期：2026-02-02'
      }[mode];
    });
    const metadata = { ...r.base, times: [r.time(r.current, '2026-02-02'),
      r.time(r.historical, '2026-02-02', 'history_quoted')], primaryClinicalTimeIndex: 0 };
    expect(r.publish(metadata).heldReasonCodes).toEqual(['report_metadata_date_role_unverified']);
    expect(r.summary().clinicalTime.value).toBeNull();
    expect(r.append(metadata).heldReasonCodes).toEqual(['report_metadata_date_role_unverified']);
    expect(r.summary().clinicalTime.value).toBeNull();
  });

  it.each(['hash', 'wrong_role', 'foreign_document'] as const)('同日历史不掩盖direct当前来源的%s错误', (mode) => {
    const f = fixture();
    const r = f.report(false, 'date', (manifest) => {
      manifest.spans.find((span) => span.quote === '检查日期：2020-02-01')!.quote = '历史检查日期：2026-02-02';
      const current = manifest.spans.find((span) => span.quote === '检查日期：2026-02-02')!;
      if (mode === 'hash') current.modelEvidence!.originalSha256 = 'b'.repeat(64);
      if (mode === 'wrong_role') current.modelEvidence!.role = 'heading';
    });
    const other = mode === 'foreign_document' ? f.report() : null;
    const metadata = { ...r.base, times: [r.time(other?.current ?? r.current, '2026-02-02'),
      r.time(r.historical, '2026-02-02', 'history_quoted')], primaryClinicalTimeIndex: 0 };
    if (mode === 'hash') expect(() => r.preview(metadata)).toThrow('DIRECT_ORIGINAL_ADMISSION_SCOPE_MISMATCH');
    else if (mode === 'foreign_document') expect(() => r.preview(metadata)).toThrow('COMMITTED_REPORT_METADATA_DOCUMENT_SCOPE_MISMATCH');
    else expect(r.preview(metadata).reportReasonCodes).toEqual(['report_metadata_date_role_unverified']);
  });

  it.each(['finding', 'instruction'] as const)('日期共用%s出处时预检、发布与正常重读一致，不为摘录角色复制原文', (role) => {
    const f = fixture(); const r = f.report(false, role);
    const metadata = { ...r.base, times: [r.times[1]!, r.times[3]!], primaryClinicalTimeIndex: 0 };
    const before = f.state();
    expect(r.preview(metadata).reportReasonCodes).toEqual([]);
    expect(f.state()).toEqual(before);
    expect(r.publish(metadata).heldReasonCodes).toEqual([]);
    expect(r.summary()).toMatchObject({ reportDate: '2026-02-04', clinicalTime: { value: '2026-02-02', precision: 'day' } });
    expect(r.append({ ...metadata, primaryClinicalTimeIndex: null }).heldReasonCodes).toEqual([]);
    expect(r.summary()).toMatchObject({ reportDate: '2026-02-04', clinicalTime: { value: null, precision: 'unknown' } });
    expect(f.store.listAcceptedObservations(f.person.id)[0]!.clinicalDate).toBeNull();
  });

  it('报告时间共用finding来源仍只保存reportDate，不补本次临床时间和项目日期', () => {
    const f = fixture(); const r = f.report(false, 'finding');
    const metadata = { ...r.base, times: [r.times[3]!], primaryClinicalTimeIndex: null };
    expect(r.publish(metadata).heldReasonCodes).toEqual([]);
    expect(r.summary()).toMatchObject({ reportDate: '2026-02-04', clinicalTime: { value: null, precision: 'unknown' } });
    expect(f.store.listAcceptedObservations(f.person.id)[0]!.clinicalDate).toBeNull();
  });

  it('临床日期可由本项目显式绑定的同原件finding日期补充，不由报告签发时间填入', () => {
    const f = fixture(); const r = f.report(false, 'finding');
    r.publish({ ...r.base, primaryClinicalTimeIndex: null });
    const evidence = [...r.candidate.evidence, r.ref(r.current)];
    const clinicalDate = '2026-02-02';
    const candidate = { ...r.candidate, clinicalDate, evidence };
    const issueId = r.prepareReview();
    const result = f.store.appendCommittedFacts({ personId: f.person.id, documentId: r.documentId,
      expectedRevision: f.store.getFactRevision(f.person.id), summary: '合成已知临床日期补充',
      observations: [{ ...r.observation, clinicalDate, evidence, candidate }],
      reportMetadata: { ...r.base, times: [r.times[1]!], primaryClinicalTimeIndex: 0 },
      reviewUpdate: { issueId, remainingCandidates: [], remainingReasonCodes: [], remainingEvidenceRefs: [] } });
    expect(result.heldCandidates).toEqual([]);
    expect(result.heldReasonCodes).toEqual([]);
    expect(f.store.listAcceptedObservations(f.person.id)[0]!.clinicalDate).toBe(clinicalDate);
    expect(r.summary().reportDate).toBeNull();
  });

  it.each(['missing_date', 'wrong_date', 'hash', 'foreign_quote'] as const)('共用finding的%s仍拒绝日期投影，不能借别的正文补证', (mode) => {
    const f = fixture(); const r = f.report(false, 'finding', (manifest) => {
      const current = manifest.spans.find((span) => span.quote === '检查日期：2026-02-02')!;
      if (mode === 'missing_date') current.quote = '合成结果原文，没有日期';
      if (mode === 'hash') current.modelEvidence!.originalSha256 = 'b'.repeat(64);
    });
    const time = { ...r.times[1]!, evidence: [{ sourceSpanId: r.current.id, quote: null as string | null }] };
    if (mode === 'wrong_date') time.value = '2026-02-03';
    if (mode === 'foreign_quote') time.evidence[0]!.quote = '另一份报告的原文';
    const metadata = { ...r.base, times: [time], primaryClinicalTimeIndex: 0 };
    const before = f.state();
    if (mode === 'hash') expect(() => r.preview(metadata)).toThrow('DIRECT_ORIGINAL_ADMISSION_SCOPE_MISMATCH');
    else expect(r.preview(metadata).reportReasonCodes).not.toEqual([]);
    expect(f.state()).toEqual(before);
  });

  it('历史日期在前也只用模型明示主日期，签发时间单独保留', () => {
    const f = fixture(); const r = f.report();
    r.publish({ ...r.base, times: r.times, primaryClinicalTimeIndex: 1 });
    expect(r.summary()).toMatchObject({ reportDate: '2026-02-04', clinicalTime: { value: '2026-02-02', precision: 'day' } });
    expect(f.store.listAcceptedObservations(f.person.id)[0]!.clinicalDate).toBeNull();
  });

  it.each(['explicit_null', 'multiple_without_selector', 'missing_metadata'] as const)('%s不借事实或签发日猜主要日期', (mode) => {
    const f = fixture(); const r = f.report();
    const metadata = mode === 'missing_metadata' ? undefined : { ...r.base, times: r.times,
      ...(mode === 'explicit_null' ? { primaryClinicalTimeIndex: null } : {}) };
    r.publish(metadata, { ...r.observation, clinicalDate: '2026-02-02', candidate: { ...r.candidate, clinicalDate: '2026-02-02' } });
    expect(r.summary().clinicalTime).toEqual({ value: null, precision: 'unknown' });
    expect(f.store.listAcceptedObservations(f.person.id)[0]!.clinicalDate).toBe('2026-02-02');
  });

  it('旧单一有来源临床日期兼容，direct没有签发来源时保持reportDate空白', () => {
    const f = fixture(); const r = f.report(); r.publish({ ...r.base, times: [r.times[1]!] });
    expect(r.summary()).toMatchObject({ reportDate: null, clinicalTime: { value: '2026-02-02', precision: 'day' } });
  });

  it('仅非direct且完全缺metadata的旧入口保留原观察日期兼容', () => {
    const f = fixture(); const legacy = f.report(true); legacy.publish(undefined, { ...legacy.observation, clinicalDate: '2026-02-02' });
    expect(legacy.summary()).toMatchObject({ reportDate: '2026-02-02', clinicalTime: { value: '2026-02-02', precision: 'day' } });
    const metadataPresent = f.report(true); metadataPresent.publish({ ...metadataPresent.base, times: [] },
      { ...metadataPresent.observation, clinicalDate: '2026-02-02' });
    expect(metadataPresent.summary().clinicalTime.value).toBeNull();
  });

  it.each(['issued_role', 'out_of_range', 'unproven_source'] as const)('非法%s主要日期在preview和publish均拒绝且不猜时间', (mode) => {
    const f = fixture(); const r = f.report();
    const times = mode === 'unproven_source' ? [{ ...r.times[1]!, evidence: [r.ref(r.manifest.spans[0]!)] }] : r.times;
    const metadata = { ...r.base, times, primaryClinicalTimeIndex: mode === 'issued_role' ? 3 : mode === 'out_of_range' ? 99 : 0 };
    const before = f.state(); const p = r.preview(metadata); expect(p.reportReasonCodes).not.toEqual([]); expect(f.state()).toEqual(before);
    expect(r.publish(metadata).heldReasonCodes).toEqual(p.reportReasonCodes); expect(r.summary().clinicalTime.value).toBeNull();
  });

  it('正常append把自动非空错误锚点版本化重投影，历史事实逐字不变', () => {
    const f = fixture(); const r = f.report(); r.publish({ ...r.base, times: r.times, primaryClinicalTimeIndex: 0 });
    const facts = f.store.listAcceptedObservations(f.person.id); const rows = f.db.prepare('SELECT * FROM observation_revisions ORDER BY rowid').all();
    const old = r.summary(); const metadata = { ...r.base, times: r.times, primaryClinicalTimeIndex: 1 };
    const before = f.state(); expect(r.preview(metadata).reportReasonCodes).toEqual([]); expect(f.state()).toEqual(before);
    expect(r.append(metadata)).toMatchObject({ appendedCount: 0, updatedCount: 0, revision: 2, idempotent: false });
    expect(r.summary()).toMatchObject({ metadataRevision: 2, clinicalTime: { value: '2026-02-02', precision: 'day' } });
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual(facts); expect(f.db.prepare('SELECT * FROM observation_revisions ORDER BY rowid').all()).toEqual(rows);
    const versions = f.db.prepare('SELECT revision,payload_json FROM report_metadata_revisions WHERE report_id=? ORDER BY revision').all(old.reportId) as Array<{ revision: number; payload_json: string }>;
    expect(versions).toHaveLength(2); expect(JSON.parse(versions[1]!.payload_json)).toMatchObject({ action: 'policy_reproject_primary',
      projectionVersion: 'primary-clinical-time-v1', extracted: metadata, previous: { clinicalDate: '2020-02-01', payload: { extracted: { primaryClinicalTimeIndex: 0 } } } });
    expect(r.append(metadata, true)).toMatchObject({ idempotent: true, revision: 2 });
  });

  it('新times重排与index完整成对保存，读回仍指向本轮主要时间', () => {
    const f = fixture(); const r = f.report(); r.publish({ ...r.base, times: r.times, primaryClinicalTimeIndex: 0 });
    const metadata = { ...r.base, times: [r.times[3]!, r.times[2]!, r.times[1]!, { ...r.times[0]!, role: 'history_quoted' as const }], primaryClinicalTimeIndex: 2 };
    r.append(metadata); const extracted = r.summary().extracted!;
    expect(extracted.times).toEqual(metadata.times); expect(extracted.primaryClinicalTimeIndex).toBe(2);
    expect(extracted.times[extracted.primaryClinicalTimeIndex!]!.value).toBe(r.summary().clinicalTime.value);
  });

  it('明示unknown可撤下旧自动锚点，但不会补签发日或改事实日期', () => {
    const f = fixture(); const r = f.report(); r.publish({ ...r.base, times: [r.times[0]!], primaryClinicalTimeIndex: 0 });
    r.append({ ...r.base, times: [r.times[1]!], primaryClinicalTimeIndex: null });
    expect(r.summary()).toMatchObject({ reportDate: null, clinicalTime: { value: null, precision: 'unknown' } });
    expect(f.store.listAcceptedObservations(f.person.id)[0]!.clinicalDate).toBeNull();
  });

  it('用户corrected日期在正常重读和预检中保持保护', () => {
    const f = fixture(); const r = f.report(); r.publish({ ...r.base, times: r.times, primaryClinicalTimeIndex: 0 });
    const old = r.summary(); f.store.updateReportMetadata({ personId: f.person.id, reportId: old.reportId, expectedRevision: old.metadataRevision,
      title: '合成人工标题', organization: null, department: null, clinicalTime: { value: '2025-01-01', precision: 'day' }, reason: '合成人工修订' });
    const metadata = { ...r.base, times: r.times, primaryClinicalTimeIndex: 1 }; const before = f.state();
    expect(r.preview(metadata).reportReasonCodes).toEqual(['report_metadata_user_corrected_projection']); expect(f.state()).toEqual(before);
    expect(r.append(metadata).heldReasonCodes).toEqual(['report_metadata_user_corrected_projection']);
    expect(r.summary()).toMatchObject({ metadataStatus: 'corrected', clinicalTime: { value: '2025-01-01', precision: 'day' } });
  });

  it('强标识匹配使用明示日期而不是第一项，真正共享事件的局部日期冲突不能覆盖', () => {
    const f = fixture(); const first = f.report(); const second = f.report();
    first.publish(first.strong({ ...first.base, times: first.times, primaryClinicalTimeIndex: 1 }));
    second.publish(second.strong({ ...second.base, times: [second.times[2]!, second.times[1]!], primaryClinicalTimeIndex: 1 }));
    expect(second.summary().eventId).toBe(first.summary().eventId);
    expect(second.summary().reportDate).toBeNull();
    const metadata = first.strong({ ...first.base, times: first.times, primaryClinicalTimeIndex: 2 });
    const before = f.state(); expect(first.preview(metadata).reportReasonCodes).toEqual(['report_metadata_shared_event_projection_conflict']); expect(f.state()).toEqual(before);
    expect(first.append(metadata).heldReasonCodes).toEqual(['report_metadata_shared_event_projection_conflict']);
    expect(second.summary().clinicalTime.value).toBe('2026-02-02'); expect(first.summary().clinicalTime.value).toBe('2026-02-02');
  });

  it.each(['automatic_stale', 'manual_corrected'] as const)('强标识不会继承%s实际事件锚点', (mode) => {
    const f = fixture(); const first = f.report(); first.publish(first.strong({ ...first.base, times: first.times, primaryClinicalTimeIndex: 1 }));
    const old = first.summary();
    if (mode === 'automatic_stale') {
      // 合成旧版本的自动锚点与元数据不一致，用于验证新报告不会强合并继承它。
      f.db.prepare('UPDATE health_events_v2 SET clinical_date=? WHERE id=?').run('2020-02-01', old.eventId);
    } else f.store.updateReportMetadata({ personId: f.person.id, reportId: old.reportId, expectedRevision: old.metadataRevision,
      title: '合成人工标题', organization: '合成医院', department: null, clinicalTime: { value: '2020-02-01', precision: 'day' }, reason: '合成人工修订' });
    const second = f.report(); second.publish(second.strong({ ...second.base, times: second.times, primaryClinicalTimeIndex: 1 }));
    expect(second.summary().eventId).not.toBe(old.eventId); expect(second.summary().clinicalTime.value).toBe('2026-02-02');
    expect(first.summary().clinicalTime.value).toBe('2020-02-01');
  });

  it('只更换selector的正常修订有不同changeSetHash，时间数组相同不导致签名相同', () => {
    const f = fixture(); const r = f.report(); r.publish({ ...r.base, times: r.times, primaryClinicalTimeIndex: 0 });
    r.append({ ...r.base, times: r.times, primaryClinicalTimeIndex: 1 }); r.append({ ...r.base, times: r.times, primaryClinicalTimeIndex: 2 });
    const hashes = f.db.prepare('SELECT change_set_hash FROM publication_events WHERE person_id=? ORDER BY rowid').all(f.person.id) as Array<{ change_set_hash: string }>;
    expect(hashes).toHaveLength(3); expect(hashes[1]!.change_set_hash).not.toBe(hashes[2]!.change_set_hash);
  });

  it.each(['2020-02-01', '2026-02-02'])('已有非空事实日期%s不随主要日期重投影而改写', (clinicalDate) => {
    const f = fixture(); const r = f.report(); const ownDate = clinicalDate === '2020-02-01' ? r.historical : r.current;
    const evidence = [...r.candidate.evidence, r.ref(ownDate)];
    r.publish({ ...r.base, times: r.times, primaryClinicalTimeIndex: 0 },
      { ...r.observation, clinicalDate, evidence, candidate: { ...r.candidate, clinicalDate, evidence } });
    const observations = f.db.prepare('SELECT * FROM observation_revisions ORDER BY rowid').all();
    const facts = f.store.listAcceptedObservations(f.person.id);
    r.append({ ...r.base, times: r.times, primaryClinicalTimeIndex: 1 });
    expect(r.summary().clinicalTime.value).toBe('2026-02-02');
    expect(f.db.prepare('SELECT * FROM observation_revisions ORDER BY rowid').all()).toEqual(observations);
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual(facts);
  });

  it('事件CAS中途失败时，报告/事件/元数据修订及事实整次事务回滚', () => {
    const f = fixture(); const r = f.report(); r.publish({ ...r.base, times: r.times, primaryClinicalTimeIndex: 0 });
    r.prepareReview();
    f.db.exec(`CREATE TRIGGER synthetic_event_cas_conflict AFTER UPDATE OF metadata_revision ON report_records
      BEGIN UPDATE health_events_v2 SET metadata_revision=metadata_revision+1 WHERE id=NEW.event_id; END;`);
    const before = f.state();
    expect(() => r.append({ ...r.base, times: r.times, primaryClinicalTimeIndex: 1 }, true)).toThrow('COMMITTED_REPORT_METADATA_STATE_CHANGED');
    // SQLite total_changes也计入已回滚语句，回滚完整性按持久表与文件验证。
    expect(f.state().tables).toEqual(before.tables); expect(f.state().files).toEqual(before.files);
  });
});

describe('正常初始化的旧direct签发日期缓存升级', () => {
  const oldCache = (f: ReturnType<typeof fixture>, r: ReturnType<ReturnType<typeof fixture>['report']>, actor = 'independent_review_projection') => {
    const summary = r.summary();
    // 仅在隔离合成数据库中复现旧版本自动把检查日写入report_date的缓存。
    f.db.prepare('UPDATE report_records SET report_date=? WHERE id=?').run(summary.clinicalTime.value, summary.reportId);
    f.db.prepare('UPDATE report_metadata_revisions SET actor=? WHERE report_id=? AND revision=?').run(actor, summary.reportId, summary.metadataRevision);
    return r.summary();
  };

  it.each(['policy', 'independent_review_projection'])('已证明自动actor %s可只清签发缓存，事实/事件及原times/index逐字不变', (actor) => {
    const f = fixture(); const r = f.report(); const metadata = { ...r.base, times: [r.times[1]!], primaryClinicalTimeIndex: 0 };
    r.publish(metadata); const old = oldCache(f, r, actor); const revision = f.store.getFactRevision(f.person.id);
    const observations = f.db.prepare('SELECT * FROM observation_revisions ORDER BY rowid').all();
    const events = f.db.prepare('SELECT * FROM health_events_v2 ORDER BY rowid').all();
    expect(f.store.upgradeDirectOriginalReportDateProjection()).toEqual({ upgradedReportIds: [old.reportId], affectedPersonIds: [f.person.id], skippedActive: false });
    expect(r.summary()).toMatchObject({ reportDate: null, metadataRevision: 2, clinicalTime: old.clinicalTime, extracted: metadata });
    expect(f.db.prepare('SELECT * FROM observation_revisions ORDER BY rowid').all()).toEqual(observations);
    expect(f.db.prepare('SELECT * FROM health_events_v2 ORDER BY rowid').all()).toEqual(events);
    expect(f.store.getFactRevision(f.person.id)).toBe(revision + 1);
    const latest = f.db.prepare('SELECT actor,payload_json FROM report_metadata_revisions WHERE report_id=? AND revision=2').get(old.reportId) as { actor: string; payload_json: string };
    expect(latest.actor).toBe('policy'); expect(JSON.parse(latest.payload_json)).toMatchObject({ action: 'policy_clear_inherited_report_date',
      projectionVersion: 'report-issued-date-v1', extracted: metadata, previous: { reportDate: '2026-02-02', metadataRevision: 1 } });
    const beforeSecond = f.state(); expect(f.store.upgradeDirectOriginalReportDateProjection()).toEqual({ upgradedReportIds: [], affectedPersonIds: [], skippedActive: false });
    expect(f.state()).toEqual(beforeSecond);
  });

  it.each(['user_actor', 'deterministic_actor', 'corrected', 'legacy', 'issued_time', 'ambiguous_current', 'no_issuer_different_report_date'])('%s不被缓存升级覆盖，调用零写', (mode) => {
    const f = fixture(); const r = f.report(mode === 'legacy');
    const times = mode === 'issued_time' ? [r.times[1]!, r.times[3]!] : mode === 'ambiguous_current' ? [r.times[0]!, r.times[1]!] : [r.times[1]!];
    const metadata = { ...r.base, times, ...(mode === 'ambiguous_current' ? {} : { primaryClinicalTimeIndex: 0 }) };
    r.publish(metadata);
    if (mode === 'ambiguous_current') {
      // 真正复现旧first-clinical算法：多日期、缺selector，但旧自动事件与签发缓存均非空。
      const initial = r.summary();
      f.db.prepare(`UPDATE health_events_v2 SET clinical_date=?,date_precision='day',date_source='explicit',metadata_status='inferred'
        WHERE id=?`).run('2020-02-01', initial.eventId);
    }
    const old = oldCache(f, r, mode === 'user_actor' ? 'user'
      : mode === 'deterministic_actor' ? 'deterministic_projection' : 'independent_review_projection');
    if (mode === 'corrected') f.store.updateReportMetadata({ personId: f.person.id, reportId: old.reportId, expectedRevision: old.metadataRevision,
      title: '合成人工标题', organization: null, department: null, clinicalTime: { value: '2026-02-02', precision: 'day' }, reason: '合成人工修订' });
    if (mode === 'no_issuer_different_report_date') f.db.prepare('UPDATE report_records SET report_date=? WHERE id=?').run('2026-02-05', old.reportId);
    if (mode === 'ambiguous_current') {
      expect(old.reportDate).toBe('2020-02-01'); expect(old.clinicalTime.value).toBe('2020-02-01');
      expect(old.extracted?.primaryClinicalTimeIndex).toBeUndefined(); expect(old.extracted?.times).toHaveLength(2);
    }
    const before = f.state(); expect(f.store.upgradeDirectOriginalReportDateProjection().upgradedReportIds).toEqual([]); expect(f.state()).toEqual(before);
  });

  it.each(['model_hash', 'model_object', 'model_parent', 'model_role', 'model_engine', 'model_receipt', 'unclear',
    'non_direct_manifest', 'wrong_excerpt_block', 'link_hash', 'foreign_ref', 'shared_document_link'])('%s来源不可靠或关联不唯一时不升级', (mode) => {
    const f = fixture(); const r = f.report(); r.publish({ ...r.base, times: [r.times[1]!], primaryClinicalTimeIndex: 0 });
    const old = oldCache(f, r);
    if (mode === 'link_hash') f.db.prepare('UPDATE report_source_links SET source_hash=? WHERE report_id=?').run('f'.repeat(64), old.reportId);
    else if (mode === 'shared_document_link') {
      const other = f.report(); other.publish({ ...other.base, times: [other.times[1]!], primaryClinicalTimeIndex: 0 });
      const otherReport = other.summary();
      expect(other.documentId).not.toBe(r.documentId); expect(other.source.id).not.toBe(r.source.id);
      expect(otherReport.reportId).not.toBe(old.reportId);
      f.db.prepare('INSERT INTO report_source_links (report_id,document_id,relation,source_hash,created_at) VALUES (?,?,?,?,?)')
        .run(otherReport.reportId, r.documentId, 'primary', r.source.sha256, '2026-01-01T00:00:00Z');
      const links = f.db.prepare('SELECT report_id FROM report_source_links WHERE document_id=? ORDER BY report_id')
        .all(r.documentId) as Array<{ report_id: string }>;
      expect(links.map((link) => link.report_id)).toEqual([old.reportId, otherReport.reportId].sort());
      expect(f.db.prepare('SELECT COUNT(*) AS count FROM report_source_links WHERE report_id=?').get(otherReport.reportId)).toEqual({ count: 2 });
    } else if (mode === 'foreign_ref') {
      const other = f.report(); const metadata = { ...r.base, times: [{ ...r.times[1]!, evidence: [other.ref(other.current)] }], primaryClinicalTimeIndex: 0 };
      const row = f.db.prepare('SELECT payload_json FROM report_metadata_revisions WHERE report_id=? AND revision=1').get(old.reportId) as { payload_json: string };
      f.db.prepare('UPDATE report_metadata_revisions SET payload_json=? WHERE report_id=? AND revision=1')
        .run(JSON.stringify({ ...JSON.parse(row.payload_json) as object, extracted: metadata }), old.reportId);
    } else if (mode === 'non_direct_manifest') f.db.prepare('UPDATE source_manifests SET normalizer_version=? WHERE document_id=?')
      .run('synthetic-legacy-v1', r.documentId);
    else if (mode === 'wrong_excerpt_block') f.db.prepare('UPDATE source_spans SET block_id=? WHERE id=?').run('synthetic-wrong-block', r.current.id);
    else {
      const model = { ...r.current.modelEvidence!, ...(mode === 'model_hash' ? { originalSha256: 'f'.repeat(64) }
        : mode === 'model_object' ? { originalSourceObjectId: randomUUID() }
        : mode === 'model_parent' ? { parentSourceSpanId: randomUUID() }
        : mode === 'model_role' ? { role: 'context' } : mode === 'model_engine' ? { engine: 'synthetic-other-engine' }
        : mode === 'model_receipt' ? { turnId: '' } : { clarity: 'uncertain' }) };
      f.db.prepare('UPDATE source_spans SET model_evidence_json=? WHERE id=?').run(JSON.stringify(model), r.current.id);
    }
    const before = f.state(); expect(f.store.upgradeDirectOriginalReportDateProjection().upgradedReportIds).toEqual([]); expect(f.state()).toEqual(before);
    // 刻意建立多报告关联后documentId首条摘要不唯一，按原reportId验证目标缓存未变。
    expect(f.db.prepare('SELECT report_date FROM report_records WHERE id=?').get(old.reportId)).toEqual({ report_date: old.reportDate });
  });

  it.each(['queued', 'unfinished_attempt'])('%s存在时整次跳过，不产生审计/修订/事实版本或数据文件变化', (mode) => {
    const f = fixture(); const r = f.report(); r.publish({ ...r.base, times: [r.times[1]!], primaryClinicalTimeIndex: 0 }); oldCache(f, r);
    const consentId = f.store.createManualProcessingConsent({ documentIds: [r.documentId], personIds: [f.person.id], accountFingerprint: 'synthetic-account', version: 1 });
    const batch = f.store.createWaitingAuthBatch({ cutoff: '2026-01-01T00:00:00Z', consentId, initialStatus: 'queued',
      groups: [{ personId: f.person.id, documentIds: [r.documentId], stage: 'analyze', inputSignature: randomUUID() }] });
    if (mode === 'unfinished_attempt') {
      const job = f.store.claimNextQueuedJob('synthetic-worker', 'synthetic-account')!;
      f.store.startJobAttempt(job.id, 'synthetic-runtime', 'gpt-6.1-sol', 'medium');
      // 合成孤立运行尝试：即使任务状态已终止，未结束的running attempt仍阻止升级。
      f.db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(batch.jobIds[0]);
    }
    const before = f.state(); expect(f.store.upgradeDirectOriginalReportDateProjection()).toEqual({ upgradedReportIds: [], affectedPersonIds: [], skippedActive: true });
    expect(f.state()).toEqual(before);
  });

  it('同一成员多份缓存一次升级只推进一次成员freshness，不改背景版本', () => {
    const f = fixture(); const first = f.report(); const second = f.report();
    for (const r of [first, second]) { r.publish({ ...r.base, times: [r.times[1]!], primaryClinicalTimeIndex: 0 }); oldCache(f, r); }
    const before = f.store.getFactRevision(f.person.id); const context = f.store.getClinicalContextRevision(f.person.id);
    const receipt = f.store.upgradeDirectOriginalReportDateProjection();
    expect(receipt.upgradedReportIds).toEqual(expect.arrayContaining([first.summary().reportId, second.summary().reportId]));
    expect(receipt.affectedPersonIds).toEqual([f.person.id]); expect(f.store.getFactRevision(f.person.id)).toBe(before + 1);
    expect(f.store.getClinicalContextRevision(f.person.id)).toBe(context);
  });
});
