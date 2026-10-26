import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ObservationCandidate, SourceManifest, SourceSpan, SourceVisualEvidence } from '@contracts';
import { WorkspaceStore, type PublishFactsInput } from './index.js';

const stores = new Set<WorkspaceStore>();
const roots: string[] = [];
afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Observation = PublishFactsInput['observations'][number];
type Rect = [number, number, number, number];
const defaultLines = ['检查日期：2026-01-02', '合成项目甲 7 U/L', '合成项目乙 9 U/L'];

function visual(lines: string[], broadBox = false): SourceVisualEvidence {
  return { version: 1, engine: 'apple-vision-local-v1', layoutVersion: 'local-visual-layout-v2',
    coordinateSystem: 'normalized-bottom-left', reading: { mode: 'full_image', fallbackUsed: false },
    rows: lines.map((text, index) => {
      const bounds: Rect = [0.1, 0.9 - index * Math.min(0.2, 0.8 / lines.length), 0.65, 0.04];
      const cells = text.split(' ');
      return { line: index + 1, text, bounds, boxes: broadBox || cells.length !== 3
        ? [{ text, confidence: 0.95, bounds }]
        : cells.map((value, cell) => ({ text: value, confidence: 0.95,
          bounds: [0.1 + cell * 0.23, bounds[1], cell === 0 ? 0.22 : 0.15, 0.04] as Rect })) };
    }), omittedBoxes: [] };
}

function fixture(options: { legacy?: boolean; lines?: string[]; broadBox?: boolean; twoPages?: boolean; thin?: 'row' | 'column' } = {}) {
  const rootDirectory = mkdtempSync(join(tmpdir(), 'family-health-region-reconcile-synthetic-'));
  roots.push(rootDirectory);
  const store = new WorkspaceStore({ rootDirectory });
  stores.add(store);
  const person = store.createPerson({ displayName: '合成成员' });
  const mediaType = options.twoPages ? 'application/pdf' : 'image/png';
  const source = store.putSourceObject({ bytes: Buffer.from('合成固定原图'), mediaType, displayName: '合成检查.png' });
  const { documentId } = store.registerImportedDocument({ sourceObjectId: source.id, personId: person.id });
  const lines = options.lines ?? defaultLines;
  const geometry = visual(lines, options.broadBox);
  if (options.thin) geometry.rows.forEach((row, index) => {
    if (options.thin === 'row') {
      row.bounds = [row.bounds[0], 0.7 + index * 0.002, row.bounds[2], 0.001];
      row.boxes = row.boxes.map((box) => ({ ...box, bounds: [box.bounds[0], row.bounds[1], box.bounds[2], 0.001] }));
    } else {
      row.bounds = [0.1 + index * 0.002, 0.7, 0.65, 0.04];
      row.boxes = row.boxes.map((box, cell) => ({ ...box, bounds: [0.1 + cell * 0.23 + index * 0.002, 0.7, 0.001, 0.04] }));
    }
  });
  const span: SourceSpan = { id: randomUUID(), documentId, spanKind: 'image', page: 1,
    blockId: 'local-vision-page-v3', lineStart: 1, lineEnd: lines.length,
    quote: lines.join('\n'), readability: 'clear', ...(options.legacy ? {} : { visualEvidence: geometry }) };
  const manifest: SourceManifest = { id: randomUUID(), sourceObjectId: source.id, sha256: source.sha256,
    mediaType, originalDisplayName: '合成检查.png', totalUnits: options.twoPages ? 2 : 1, coveredUnitIndexes: options.twoPages ? [0, 1] : [0],
    normalizerVersion: options.legacy ? 'image-evidence-v1+local-visual-v1' : 'image-evidence-v1+local-visual-geometry-v1',
    conversionWarnings: [], createdAt: '2026-01-03T00:00:00Z',
    spans: options.twoPages ? [span, { ...span, id: randomUUID(), page: 2 }] : [span] };
  store.saveSourceManifest(manifest);
  const acceptanceId = store.saveAcceptanceDecision({ method: 'auto', actor: 'policy', rulesVersion: 'synthetic',
    inputSignature: 'synthetic-input', outputHash: 'synthetic-output', reviewRef: null, decision: 'accept' });
  return { store, person, source, documentId, manifest, span, lines, geometry, acceptanceId };
}

type Fixture = ReturnType<typeof fixture>;
function observation(f: Fixture, name: string, value: string, span = f.span, findingQuote = `${name} ${value} U/L`): Observation {
  const evidence = [{ sourceSpanId: span.id, quote: findingQuote }];
  const candidate: ObservationCandidate = { localKey: randomUUID(), originalName: name, standardNameCandidate: null,
    value: { kind: 'numeric', rawText: value, decimal: value, comparator: 'eq' }, unitRaw: 'U/L',
    referenceRangeRaw: null, reportedAbnormalFlag: null, specimen: null, method: null, bodySite: null,
    clinicalDate: null, evidence, sourceBinding: { headingEvidence: [], findingEvidence: evidence }, issues: [] };
  return { conceptKey: name, originalName: name, rawText: value, valueKind: 'numeric', decimalValue: value,
    qualifier: 'eq', unit: 'U/L', referenceRange: null, clinicalDate: null, abnormalFlag: 'unknown',
    documentId: f.documentId, sourceSpanId: span.id, acceptanceId: f.acceptanceId,
    specimen: null, method: null, bodySite: null, evidence, candidate, sourceBinding: candidate.sourceBinding };
}

function publish(f: Fixture, first: Observation) {
  f.store.publishFacts({ personId: f.person.id, documentId: f.documentId, documentCommitKey: 'a'.repeat(64),
    expectedRevision: 0, changeSetHash: 'b'.repeat(64), summary: '合成首次接纳', observations: [first] });
  return f.store.saveExtractionReviewIssue({ documentId: f.documentId, kind: 'field_conflict', severity: 'warning',
    preserveDocumentStatus: true, stage: 'extract', evidenceRefs: [f.span.id], candidateOptions: [], reasonCodes: ['UNREADABLE'] });
}

function region(f: Fixture, rowIndex: number, text?: string, page = 1): SourceSpan {
  const parent = f.store.getDocumentExtractionBundle(f.documentId).manifest.spans.find((span) =>
    span.page === page && !span.blockId?.startsWith('local-vision-region:'))!;
  const row = parent.visualEvidence!.rows[rowIndex]!;
  const content = text ?? row.text;
  const changedCells = content.split(' ');
  const boxes = row.boxes.map((box, index) => ({ ...box, text: row.boxes.length === 1 ? content : changedCells[index]! }));
  const readingBounds: Rect = [0.07, row.bounds[1] - 0.02, 0.72, 0.08];
  const span: SourceSpan = { id: randomUUID(), documentId: f.documentId, spanKind: 'image', page,
    blockId: `local-vision-region:${parent.id}`, lineStart: 1, lineEnd: 1, quote: content, readability: 'clear',
    visualEvidence: { ...parent.visualEvidence!, reading: { mode: 'region', regionBounds: readingBounds, fallbackUsed: false },
      rows: [{ ...row, line: 1, text: content, boxes }], omittedBoxes: [] } };
  f.store.appendLocalVisualEvidenceForReprocessing({ ...f.store.getDocumentExtractionBundle(f.documentId).manifest,
    normalizerVersion: `${parent.visualEvidence!.layoutVersion}+local-visual-region-v1`,
    spans: [...f.store.getDocumentExtractionBundle(f.documentId).manifest.spans, span] });
  return span;
}

function append(f: Fixture, issueId: string, observations: Observation[], extra: Partial<Parameters<WorkspaceStore['appendCommittedFacts']>[0]> = {}) {
  return f.store.appendCommittedFacts({ personId: f.person.id, documentId: f.documentId,
    expectedRevision: f.store.getFactRevision(f.person.id), summary: '合成局部补修', observations,
    reviewUpdate: { issueId, remainingCandidates: [], remainingReasonCodes: [], remainingEvidenceRefs: [] }, ...extra });
}

function dateMetadata(f: Fixture, role: 'examined' | 'report_issued' | 'history_quoted', quote: string): NonNullable<PublishFactsInput['reportMetadata']> {
  return { reportKind: null, title: null, organization: null, campus: null, department: null, reportNumber: null,
    examItems: [], times: [{ role, value: '2026-01-02', precision: 'day', evidence: [{ sourceSpanId: f.span.id, quote }] }] };
}

describe('受控region增量对账保留已接纳结果', () => {
  it('同页真实不同槽位可以补入新项目，旧事实及原引文不变', () => {
    const f = fixture();
    const first = observation(f, '合成项目甲', '7');
    const issueId = publish(f, first);
    const before = f.store.listAcceptedObservations(f.person.id)[0];
    const oldQuote = f.store.getEvidenceAccess({ sourceSpanId: f.span.id }).quote;
    const repaired = region(f, 2);
    const receipt = append(f, issueId, [first, observation(f, '合成项目乙', '9', repaired)]);
    expect(receipt).toMatchObject({ appendedCount: 1, duplicateCount: 1, heldCount: 0, revision: 2 });
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(2);
    expect(f.store.listAcceptedObservations(f.person.id).find((item) => item.id === before!.id)).toEqual(before);
    expect(f.store.getEvidenceAccess({ sourceSpanId: f.span.id }).quote).toBe(oldQuote);
    expect(f.store.getDocumentExtractionBundle(f.documentId).manifest.sha256).toBe(f.source.sha256);
  });

  it('region重新读到同一来源槽位，不制造副本', () => {
    const f = fixture();
    const issueId = publish(f, observation(f, '合成项目甲', '7'));
    const repaired = region(f, 1);
    expect(append(f, issueId, [observation(f, '合成项目甲', '7', repaired)]))
      .toMatchObject({ appendedCount: 0, duplicateCount: 1, heldCount: 0, revision: 1 });
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(1);
  });

  it.each(['value', 'side', 'comparator'] as const)('同槽位%s真实冲突局部隔离，不覆盖原事实', (kind) => {
    const f = fixture();
    const first = observation(f, '合成项目甲', '7');
    if (kind === 'side') first.bodySite = '右侧';
    const issueId = publish(f, first);
    const before = f.store.listAcceptedObservations(f.person.id);
    const repaired = region(f, 1, kind === 'value' ? '合成项目甲 8 U/L' : undefined);
    const changed = observation(f, '合成项目甲', kind === 'value' ? '8' : '7', repaired);
    if (kind === 'side') changed.bodySite = '左侧';
    if (kind === 'comparator') { changed.qualifier = 'lt'; changed.candidate!.value = { kind: 'numeric', rawText: '<7', decimal: '7', comparator: 'lt' }; }
    expect(append(f, issueId, [changed])).toMatchObject({ appendedCount: 0, duplicateCount: 0, heldCount: 1, revision: 1 });
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual(before);
  });

  it('否定词冲突保留旧文字结果，不以相同位置自动改成肯定', () => {
    const f = fixture({ lines: ['检查日期：2026-01-02', '合成项目甲 未见异常'] });
    const make = (span: SourceSpan, value: string): Observation => {
      const base = observation(f, '合成项目甲', '7', span, `合成项目甲 ${value}`);
      return { ...base, rawText: value, valueKind: 'text', decimalValue: null, qualifier: null, unit: null,
        candidate: { ...base.candidate!, unitRaw: null, value: { kind: 'text', rawText: value } } };
    };
    const issueId = publish(f, make(f.span, '未见异常'));
    const repaired = region(f, 1, '合成项目甲 见异常');
    expect(append(f, issueId, [make(repaired, '见异常')])).toMatchObject({ appendedCount: 0, heldCount: 1 });
    expect(f.store.listAcceptedObservations(f.person.id)[0]?.rawText).toBe('未见异常');
  });

  it('旧版无几何时可由原句唯一精确映射到新primary，不能仅按数值猜', () => {
    const f = fixture({ legacy: true });
    const issueId = publish(f, observation(f, '合成项目甲', '7'));
    const before = f.store.listAcceptedObservations(f.person.id);
    const current = { ...f.span, id: randomUUID(), visualEvidence: f.geometry };
    f.store.replaceSourceManifestForReprocessing({ ...f.manifest, id: randomUUID(),
      normalizerVersion: 'image-evidence-v1+local-visual-geometry-v1', spans: [current] });
    const repaired = region(f, 2);
    expect(append(f, issueId, [observation(f, '合成项目乙', '9', repaired)]))
      .toMatchObject({ appendedCount: 1, heldCount: 0 });
    expect(f.store.listAcceptedObservations(f.person.id).find((item) => item.id === before[0]!.id)).toEqual(before[0]);
    expect(f.store.getEvidenceAccess({ sourceSpanId: f.span.id }).quote).toBe(f.span.quote);
  });

  it.each(['changed_words', 'repeated_witness'] as const)('旧版%s不能唯一映射时仍隔离，不放宽OCR字符', (kind) => {
    const oldLines = ['检查日期：2026-01-02', '合成末端甲 7 U/L', '合成项目乙 9 U/L'];
    const f = fixture({ legacy: true, lines: oldLines });
    const issueId = publish(f, observation(f, '合成末端甲', '7'));
    const lines = kind === 'changed_words' ? [oldLines[0]!, '合成未端甲 7 U/L', oldLines[2]!]
      : [...oldLines, ...oldLines];
    const current = { ...f.span, id: randomUUID(), quote: lines.join('\n'), visualEvidence: visual(lines), lineEnd: lines.length };
    // 几何不覆盖原句差异，也不能由同名同值或重复正文补出唯一位置。
    f.store.replaceSourceManifestForReprocessing({ ...f.manifest, id: randomUUID(),
      normalizerVersion: 'image-evidence-v1+local-visual-geometry-v1', spans: [current] });
    const repaired = region(f, 2);
    expect(append(f, issueId, [observation(f, '合成项目乙', '9', repaired)]))
      .toMatchObject({ appendedCount: 0, heldCount: 1 });
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(1);
  });

  it('同OCR整框内并排同值项目不能因为框坐标相同被吞为重复', () => {
    const f = fixture({ lines: ['合成项目甲 7 U/L 合成项目乙 7 U/L'], broadBox: true });
    const issueId = publish(f, observation(f, '合成项目甲', '7', f.span, '合成项目甲 7 U/L'));
    const repaired = region(f, 0);
    expect(append(f, issueId, [observation(f, '合成项目乙', '7', repaired, '合成项目乙 7 U/L')]))
      .toMatchObject({ appendedCount: 0, duplicateCount: 0, heldCount: 1 });
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(1);
  });

  it('同坐标但不同原页不是同一槽位，保留两页各自记录', () => {
    const f = fixture({ twoPages: true });
    const issueId = publish(f, observation(f, '合成项目甲', '7'));
    const repaired = region(f, 1, undefined, 2);
    expect(append(f, issueId, [observation(f, '合成项目甲', '7', repaired)]))
      .toMatchObject({ appendedCount: 1, duplicateCount: 0, heldCount: 0 });
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(2);
  });

  it.each(['row', 'column'] as const)('紧邻细%s真实框不交叠，不能凭归一化坐标容差吞掉同值项目', (thin) => {
    const f = fixture({ lines: ['合成项目甲 7 U/L', '合成项目乙 7 U/L'], thin });
    const issueId = publish(f, observation(f, '合成项目甲', '7'));
    const repaired = region(f, 1);
    expect(append(f, issueId, [observation(f, '合成项目乙', '7', repaired)]))
      .toMatchObject({ appendedCount: 0, duplicateCount: 0, heldCount: 1 });
    expect(f.store.listAcceptedObservations(f.person.id)).toHaveLength(1);
  });

  it('旧无几何原数值只在新历史段重现，不把旧当前槽位迁到历史后新增当前值', () => {
    const f = fixture({ legacy: true });
    const issueId = publish(f, observation(f, '合成项目甲', '7'));
    const lines = [defaultLines[0]!, '合成项目甲 8 U/L', defaultLines[2]!, '历史记录', defaultLines[1]!];
    f.store.replaceSourceManifestForReprocessing({ ...f.manifest, normalizerVersion: 'image-evidence-v1+local-visual-geometry-v1',
      spans: [{ ...f.span, id: randomUUID(), quote: lines.join('\n'), lineEnd: lines.length, visualEvidence: visual(lines) }] });
    const repaired = region(f, 1);
    expect(append(f, issueId, [observation(f, '合成项目甲', '8', repaired)]))
      .toMatchObject({ appendedCount: 0, duplicateCount: 0, heldCount: 1 });
    expect(f.store.listAcceptedObservations(f.person.id)[0]?.rawText).toBe('7');
  });

  it('region追加后仍可从真实primary临床日期补证，辅助页不会破坏日期排序', () => {
    const f = fixture();
    const issueId = publish(f, observation(f, '合成项目甲', '7'));
    const repaired = region(f, 1);
    const changed = { ...observation(f, '合成项目甲', '7', repaired), clinicalDate: '2026-01-02' };
    changed.candidate!.clinicalDate = changed.clinicalDate;
    expect(append(f, issueId, [changed], { reportMetadata: dateMetadata(f, 'examined', defaultLines[0]!) }))
      .toMatchObject({ updatedCount: 1, appendedCount: 0, heldCount: 0 });
    expect(f.store.listAcceptedObservations(f.person.id)[0]?.clinicalDate).toBe('2026-01-02');
  });

  it.each(['report_issued', 'history_quoted'] as const)('辅助来源不把%s日期变成临床日期', (role) => {
    const f = fixture({ lines: ['签发日期：2026-01-02', defaultLines[1]!, defaultLines[2]!] });
    const issueId = publish(f, observation(f, '合成项目甲', '7'));
    const repaired = region(f, 1);
    const changed = { ...observation(f, '合成项目甲', '7', repaired), clinicalDate: '2026-01-02' };
    changed.candidate!.clinicalDate = changed.clinicalDate;
    expect(append(f, issueId, [changed], { reportMetadata: dateMetadata(f, role, '签发日期：2026-01-02') }))
      .toMatchObject({ updatedCount: 0, appendedCount: 0, heldCount: 1 });
    expect(f.store.listAcceptedObservations(f.person.id)[0]?.clinicalDate).toBeNull();
  });

  it('授权撤回阻止整个增量事务，不留下新事实或已解决核对记录', () => {
    const f = fixture();
    const issueId = publish(f, observation(f, '合成项目甲', '7'));
    const repaired = region(f, 2);
    const accountFingerprint = 'synthetic-account';
    const consentId = f.store.createManualProcessingConsent({ documentIds: [f.documentId], personIds: [f.person.id], accountFingerprint, version: 1 });
    f.store.createWaitingAuthBatch({ cutoff: '2026-01-03T00:00:00Z', initialStatus: 'queued', consentId,
      groups: [{ personId: f.person.id, documentIds: [f.documentId], inputSignature: 'synthetic-guard' }] });
    const job = f.store.claimNextQueuedJob('synthetic-runner', accountFingerprint)!;
    const attemptId = f.store.startJobAttempt(job.id, 'synthetic-runtime');
    const executionGuard = { jobId: job.id, attemptId, consentId, accountFingerprint };
    const before = f.store.listAcceptedObservations(f.person.id);
    f.store.revokeAllAiAuthorizations();
    expect(() => append(f, issueId, [observation(f, '合成项目乙', '9', repaired)], { executionGuard })).toThrow('CONSENT_REVOKED');
    expect(f.store.listAcceptedObservations(f.person.id)).toEqual(before);
    expect(f.store.getFactRevision(f.person.id)).toBe(1);
    expect(f.store.listOpenExtractionReviewIssues().map((issue) => issue.id)).toContain(issueId);
  });
});
