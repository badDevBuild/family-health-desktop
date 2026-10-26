import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExtractionResult, ObservationCandidate } from '@contracts';
import { buildImageManifest } from '@ingestion';
import { stableHash } from '@core';
import { PersonalWorkspaceService } from './workspace-service.js';
import { DocumentExtractionPipeline } from './processing-pipeline.js';
import * as normalization from './source-normalization.js';

const services: PersonalWorkspaceService[] = [];
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const service of services.splice(0)) service.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(committed: boolean, clinicalDate: string | null = null) {
  const root = mkdtempSync(join(tmpdir(), 'family-health-source-upgrade-synthetic-'));
  roots.push(root);
  const service = new PersonalWorkspaceService(root, '合成升级工作区');
  services.push(service);
  const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
  const source = service.store.putSourceObject({ bytes: createCanvas(32, 32).toBuffer('image/png'),
    mediaType: 'image/png', displayName: '合成图像.png' });
  const { documentId } = service.store.registerImportedDocument({ sourceObjectId: source.id, personId });
  const manifest = buildImageManifest({ sourceObjectId: source.id, documentId, sha256: source.sha256,
    mediaType: 'image/png', displayName: '合成图像.png', createdAt: '2026-01-01T00:00:00Z' });
  manifest.normalizerVersion += '+local-visual-evidence-v1';
  const oldSpan = manifest.spans[0]!;
  oldSpan.quote = '检查日期：2026-01-01\n合成项目甲\n18.2\nU/L';
  oldSpan.readability = 'clear';
  oldSpan.lineStart = 1;
  oldSpan.lineEnd = 4;
  service.store.saveSourceManifest(manifest);
  const candidate: ObservationCandidate = { localKey: 'synthetic-value', originalName: '合成项目甲',
    standardNameCandidate: null, value: { kind: 'numeric', rawText: '18.2', decimal: '18.2', comparator: 'eq' },
    unitRaw: 'U/L', referenceRangeRaw: null, reportedAbnormalFlag: null, specimen: null,
    method: null, bodySite: null, clinicalDate, evidence: [{ sourceSpanId: oldSpan.id, quote: oldSpan.quote }], issues: [] };
  if (committed) {
    const acceptanceId = service.store.saveAcceptanceDecision({ method: 'auto', actor: 'policy', rulesVersion: 'synthetic',
      inputSignature: stableHash(candidate), outputHash: stableHash(candidate), reviewRef: null, decision: 'accept' });
    service.store.publishFacts({ personId, documentId, documentCommitKey: stableHash({ documentId }),
      expectedRevision: 0, changeSetHash: stableHash(candidate), summary: '合成已接纳事实', observations: [{
        documentId, sourceSpanId: oldSpan.id, acceptanceId, originalName: candidate.originalName,
        conceptKey: candidate.originalName, rawText: '18.2', valueKind: 'numeric', decimalValue: '18.2',
        qualifier: 'eq', unit: 'U/L', referenceRange: null, abnormalFlag: 'unknown', clinicalDate,
        specimen: null, method: null, bodySite: null, evidence: candidate.evidence
      }], unresolvedReview: { kind: 'field_conflict', evidenceRefs: [oldSpan.id], candidateOptions: [candidate],
        reasonCodes: ['synthetic_old_binding_issue'] } });
  }
  const newQuote = '检查日期：2026-01-01\n合成项目甲 18.2 U/L';
  vi.spyOn(normalization, 'normalizeStoredSource').mockResolvedValue({ ...manifest,
    normalizerVersion: `${manifest.normalizerVersion}+local-visual-layout-v2+local-visual-geometry-v1`,
    spans: [{ ...oldSpan, id: 'synthetic-new-span', quote: newQuote, lineEnd: 2 }] });
  const runStructuredTurn = vi.fn(async (input: { prompt: string }) => {
    const pack = JSON.parse(input.prompt.split('SOURCE_PACKAGE=')[1]!.split('\n')[0]!) as {
      spans: Array<{ sourceSpanId: string; quote: string }>
    };
    const span = pack.spans[0]!;
    const output: ExtractionResult = { schemaVersion: 1, documentId,
      subject: { reportedName: null, evidence: [], confidence: 'absent' },
      coveredSourceSpanIds: pack.spans.map((item) => item.sourceSpanId), candidates: [{ ...candidate,
        evidence: [{ sourceSpanId: span.sourceSpanId, quote: span.quote }] }] };
    return { threadId: 'synthetic-thread', turnId: 'synthetic-turn', output };
  });
  return { service, personId, documentId, oldSpan, candidate, runStructuredTurn };
}

describe('正常局部提取会升级来源，而不是改写旧事实', () => {
  it('旧OCR经当前流程恢复行绑定，模型读取新版来源后正式接纳，旧原句仍可查看', async () => {
    const f = fixture(false);
    const result = await new DocumentExtractionPipeline(f.service.store, { runStructuredTurn: f.runStructuredTurn }).process(f.documentId);
    expect(result).toMatchObject({ status: 'published', candidateCount: 1 });
    expect(f.runStructuredTurn).toHaveBeenCalledTimes(1);
    expect(f.service.store.getDocumentExtractionBundle(f.documentId).manifest.normalizerVersion).toContain('local-visual-layout-v2');
    expect(f.service.store.getEvidenceAccess({ sourceSpanId: f.oldSpan.id }).quote).toBe(f.oldSpan.quote);
    expect(f.service.store.listAcceptedObservations(f.personId)).toHaveLength(1);
  });

  it('同原件位置同项目同值的重读不会新增重复事实，也不改旧事实的引用和版本', async () => {
    const f = fixture(true);
    const before = f.service.store.listAcceptedObservations(f.personId);
    await expect(new DocumentExtractionPipeline(f.service.store, { runStructuredTurn: f.runStructuredTurn }).process(f.documentId))
      .resolves.toMatchObject({ status: 'published', candidateCount: 0 });
    expect(f.service.store.listAcceptedObservations(f.personId)).toEqual(before);
    expect(f.service.store.listOpenExtractionReviewIssues()).toEqual([]);
    expect(f.service.store.getEvidenceAccess({ sourceSpanId: f.oldSpan.id }).quote).toBe(f.oldSpan.quote);
  });

  it('旧未知日期经唯一同源新证据补为新修订，不产生第二条事实且旧值、旧日期和原句仍可追溯', async () => {
    const f = fixture(true);
    const before = f.service.store.listAcceptedObservations(f.personId);
    f.runStructuredTurn.mockImplementation(async (input: { prompt: string }) => {
      const pack = JSON.parse(input.prompt.split('SOURCE_PACKAGE=')[1]!.split('\n')[0]!) as {
        spans: Array<{ sourceSpanId: string; quote: string }>
      };
      const span = pack.spans[0]!;
      return { threadId: 'synthetic-thread', turnId: 'synthetic-turn', output: { schemaVersion: 1 as const,
        documentId: f.documentId, subject: { reportedName: null, evidence: [], confidence: 'absent' as const },
        coveredSourceSpanIds: [span.sourceSpanId], candidates: [{ ...f.candidate, clinicalDate: '2026-01-01',
          evidence: [{ sourceSpanId: span.sourceSpanId, quote: span.quote }] }] } };
    });
    await expect(new DocumentExtractionPipeline(f.service.store, { runStructuredTurn: f.runStructuredTurn }).process(f.documentId))
      .resolves.toMatchObject({ status: 'published', candidateCount: 0 });
    const current = f.service.store.listAcceptedObservations(f.personId);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ id: before[0]!.id, rawText: before[0]!.rawText,
      decimalValue: before[0]!.decimalValue, qualifier: before[0]!.qualifier, unit: before[0]!.unit,
      clinicalDate: '2026-01-01' });
    expect(f.service.store.listOpenExtractionReviewIssues()).toEqual([]);
    expect(f.service.store.getEvidenceAccess({ sourceSpanId: f.oldSpan.id }).quote).toBe(f.oldSpan.quote);
    const database = new Database(f.service.store.databasePath, { readonly: true });
    try {
      expect(database.prepare(`SELECT revision,raw_text,decimal_value,qualifier,unit,clinical_date,
        source_span_id,supersedes FROM observation_revisions WHERE observation_id=? ORDER BY revision`)
        .all(before[0]!.id)).toEqual([
          { revision: 1, raw_text: '18.2', decimal_value: '18.2', qualifier: 'eq', unit: 'U/L',
            clinical_date: null, source_span_id: f.oldSpan.id, supersedes: null },
          { revision: 2, raw_text: '18.2', decimal_value: '18.2', qualifier: 'eq', unit: 'U/L',
            clinical_date: '2026-01-01', source_span_id: current[0]!.sourceSpanId, supersedes: 1 }
        ]);
      expect(database.prepare(`SELECT event_type FROM audit_events
        WHERE entity_id=? AND event_type='observation.clinical_date_enriched'`).get(before[0]!.id)).toBeTruthy();
    } finally { database.close(); }
  });
});
