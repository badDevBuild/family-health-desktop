import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DirectOriginalReadingResult, ObservationCandidate } from '@contracts';
import { stableHash } from '@core';
import type { WorkspaceStore } from '@storage';
import { DirectOriginalExtractionPipeline } from './direct-original-extraction.js';
import { encodeDirectOriginalReading } from './direct-original-wire.js';
import { createMemberAnalysisTransport } from './member-analysis-package.js';
import { buildMemberAssessmentInput } from './member-assessment-input.js';
import { PersonalWorkspaceService } from './workspace-service.js';

const services: PersonalWorkspaceService[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 只查看隔离测试库；同时记录所有表和SQLite写入计数，不能用回滚伪装零写。 */
function databaseState(store: WorkspaceStore) {
  const db = (store as unknown as { db: Database.Database }).db;
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .map((row) => String((row as { name: string }).name));
  return {
    changes: db.prepare('SELECT total_changes() AS count').get(),
    files: ['', '-wal'].map((suffix) => {
      const path = `${store.databasePath}${suffix}`;
      return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
    }),
    tables: tables.map((name) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()])
  };
}

describe('原件提取接纳到成员综合的整段来源接线', () => {
  it.each(['complete', 'unresolved'] as const)('%s条件保留，只有本机目录补全文，P02包装及正式事实不变', async (contextStatus) => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-whole-excerpt-producer-synthetic-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '合成工作区', () => new Date('2026-02-04T00:00:00Z'));
    services.push(service);
    const store = service.store;
    const personId = store.createPerson({ displayName: '合成成员' }).id;
    const wholeQuote = 'Synthetic whole-excerpt marker. Synthetic follow-up plan: Return after four weeks for synthetic review.';
    const explicitQuote = 'Synthetic metric 7 U/L';
    const dateQuote = 'Exam date: 2026-02-03';
    // 合成原图真实经过格式验证与原件准备，只有模型回执替身，不调用OCR或真实模型。
    const canvas = createCanvas(1000, 180);
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#000'; context.font = '16px sans-serif';
    [wholeQuote, explicitQuote, dateQuote].forEach((line, index) => context.fillText(line, 16, 32 + index * 40));
    const bytes = canvas.toBuffer('image/png');
    expect(await service.importFiles([{ path: join(root, 'synthetic-original.png'), bytes }], personId))
      .toMatchObject({ importedCount: 1, rejected: [] });
    const documentId = store.listProcessingRebuildSources()[0]!.documentId;
    const manifest = store.getDocumentExtractionBundle(documentId).manifest;
    expect(manifest.spans).toHaveLength(1);
    expect(manifest.spans[0]).toMatchObject({ quote: null, readability: 'unreadable' });
    const pageId = manifest.spans[0]!.id;
    const planRef = { sourceSpanId: 'synthetic-plan-excerpt', quote: null };
    const metricRef = { sourceSpanId: 'synthetic-metric-excerpt', quote: explicitQuote };
    const dateRef = { sourceSpanId: 'synthetic-date-excerpt', quote: dateQuote };
    const base: Omit<ObservationCandidate, 'localKey' | 'originalName' | 'value' | 'evidence'> = {
      standardNameCandidate: null, unitRaw: null, referenceRangeRaw: null, reportedAbnormalFlag: null,
      specimen: null, method: null, bodySite: null, clinicalDate: null,
      clinicalContext: { version: 1, status: contextStatus, conditions: [] }, issues: []
    };
    const output: DirectOriginalReadingResult = {
      schemaVersion: 1, documentId, pageReadings: [{ sourceSpanId: pageId, status: 'read', resultInventory: [
        { sourceSpanId: planRef.sourceSpanId, candidateKeys: ['synthetic-plan'] },
        { sourceSpanId: metricRef.sourceSpanId, candidateKeys: ['synthetic-metric'] }
      ] }],
      sourceExcerpts: [
        { localKey: planRef.sourceSpanId, pageSourceSpanId: pageId, quote: wholeQuote, role: 'instruction', clarity: 'clear' },
        { localKey: metricRef.sourceSpanId, pageSourceSpanId: pageId, quote: `${explicitQuote}; synthetic additional context.`, role: 'finding', clarity: 'clear' },
        { localKey: dateRef.sourceSpanId, pageSourceSpanId: pageId, quote: dateQuote, role: 'date', clarity: 'clear' }
      ],
      extraction: {
        schemaVersion: 1, documentId, subject: { reportedName: null, confidence: 'absent', evidence: [] },
        coveredSourceSpanIds: [pageId],
        reportMetadata: { reportKind: null, title: null, organization: null, campus: null, department: null,
          reportNumber: null, examItems: [], primaryClinicalTimeIndex: 0,
          times: [{ value: '2026-02-03', precision: 'day', role: 'examined', evidence: [dateRef] }] },
        candidates: [
          { ...base, localKey: 'synthetic-plan', originalName: 'Synthetic follow-up plan',
            value: { kind: 'text', rawText: 'Return after four weeks for synthetic review.' }, evidence: [planRef],
            sourceBinding: { headingEvidence: [], findingEvidence: [planRef] } },
          { ...base, localKey: 'synthetic-metric', originalName: 'Synthetic metric',
            value: { kind: 'numeric', rawText: '7', decimal: '7', comparator: 'eq' }, unitRaw: 'U/L',
            clinicalDate: '2026-02-03', evidence: [metricRef, dateRef],
            sourceBinding: { headingEvidence: [], findingEvidence: [metricRef] } }
        ]
      }
    };
    const originalOutput = structuredClone(output);
    const displayLabel = 'synthetic-account';
    service.processNow({ consentVersion: 1, documentIds: [documentId], accountState: {
      status: 'connected', displayLabel, runtimeVersion: 'synthetic-runtime', lastCheckedAt: '2026-02-04T00:00:00Z',
      quota: { status: 'available', primaryUsedPercent: 1, secondaryUsedPercent: null, resetsAt: null }
    } });
    const accountFingerprint = stableHash({ provider: 'codex-chatgpt', displayLabel });
    const job = store.claimNextQueuedJob('synthetic-runner', accountFingerprint)!;
    const attemptId = store.startJobAttempt(job.id, 'synthetic-runtime', 'gpt-6.1-sol', 'medium');
    const runtime = { runStructuredTurn: vi.fn(async (input: { imagePaths?: string[]; allowWebSearch?: boolean }) => {
      expect(input.allowWebSearch).toBe(false);
      expect(input.imagePaths).toHaveLength(1);
      expect(readFileSync(input.imagePaths![0]!)).toEqual(bytes);
      return { threadId: 'synthetic-thread', turnId: 'synthetic-turn', output: encodeDirectOriginalReading(output) };
    }) };
    const pipeline = new DirectOriginalExtractionPipeline(store, runtime, {
      jobId: job.id, attemptId, consentId: job.consentId!, accountFingerprint
    });
    expect(await pipeline.process(documentId)).toMatchObject({ status: 'published', candidateCount: 2 });
    expect(runtime.runStructuredTurn).toHaveBeenCalledTimes(1);
    expect(output).toEqual(originalOutput);
    const accepted = store.listAcceptedObservations(personId);
    const plan = accepted.find((fact) => fact.originalName === 'Synthetic follow-up plan')!;
    const metric = accepted.find((fact) => fact.originalName === 'Synthetic metric')!;
    expect(plan).toMatchObject({ clinicalDate: null, evidence: [expect.objectContaining({ quote: null })] });
    expect(metric).toMatchObject({ clinicalDate: '2026-02-03' });
    expect(accepted).toHaveLength(2);
    const before = databaseState(store);
    const built = buildMemberAssessmentInput(store, personId, { modelId: 'gpt-6.1-sol', reasoningEffort: 'medium',
      analysisReferenceDate: '2026-02-04', webSearchAllowed: false });
    const planCatalog = built.evidencePackage.evidenceCatalog.find((ref) => ref.observationId === plan.id && ref.sourceSpanId === plan.sourceSpanId)!;
    expect(planCatalog.quote).toBe(wholeQuote);
    expect(built.analysisEvidenceCatalog.find((ref) => ref.id === planCatalog.id)?.quote).toBeNull();
    expect(built.evidencePackage.evidenceCatalog.find((ref) => ref.observationId === metric.id && ref.sourceSpanId === metric.sourceSpanId)?.quote)
      .toBe(explicitQuote);
    expect(built.evidencePackage.facts.map((fact) => ({ id: fact.observationId, date: fact.clinicalDate, context: fact.clinicalContext })))
      .toEqual(accepted.map((fact) => ({ id: fact.id, date: fact.clinicalDate, context: fact.clinicalContext })));
    const packet = createMemberAnalysisTransport(built.evidencePackage, built.analysisEvidenceCatalog).packet;
    const packageBeforeMaterialization = { ...built.evidencePackage, evidenceCatalog: built.analysisEvidenceCatalog };
    expect(packet).toEqual(createMemberAnalysisTransport(packageBeforeMaterialization).packet);
    expect(JSON.stringify(packet)).not.toContain('Synthetic whole-excerpt marker');
    expect(store.listAcceptedObservations(personId)).toEqual(accepted);
    expect(databaseState(store)).toEqual(before);
  });
});
