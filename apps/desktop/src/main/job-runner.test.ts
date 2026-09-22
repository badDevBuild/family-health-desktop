import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccountState, AssessmentRequestV3, ExtractionResult, MemberAssessmentCandidateV3, MemberEvidencePackageV3 } from '@contracts';
import type { CodexRuntimeManager } from './codex-runtime.js';
import { ProcessingJobRunner } from './job-runner.js';
import { PersonalWorkspaceService } from './workspace-service.js';

const roots: string[] = [];

function recordedTurnUsage(databasePath: string) {
  const database = new Database(databasePath, { readonly: true });
  try {
    const row = database.prepare('SELECT usage_json FROM job_attempts ORDER BY rowid DESC LIMIT 1')
      .get() as { usage_json: string | null };
    return JSON.parse(row.usage_json!) as {
      attemptedTurnRequests: Record<'P01' | 'P02' | 'P03' | 'P04' | 'other', number>;
      completedTurnResponses: Record<'P01' | 'P02' | 'P03' | 'P04' | 'other', number>;
      failedTurnRequests: Record<'P01' | 'P02' | 'P03' | 'P04' | 'other', number>;
      timedOutTurnRequests: Record<'P01' | 'P02' | 'P03' | 'P04' | 'other', number>;
      completedTurnDurationMs: Record<'P01' | 'P02' | 'P03' | 'P04' | 'other', number>;
      observedTurnMetrics: number;
      observedTokenUsage: number;
      webToolActions: { searches: number; pageOpens: number; pageFinds: number; other: number };
      inputTokens: number | null;
      outputTokens: number | null;
      cachedInputTokens: number | null;
      firstUsableFactMs: number | null;
      attemptDurationMs: number;
    };
  } finally { database.close(); }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ProcessingJobRunner', () => {
  const connectedState: AccountState = {
    status: 'connected', displayLabel: 'fixture@example.test',
    quota: { status: 'available', primaryUsedPercent: 10, secondaryUsedPercent: null, resetsAt: null },
    runtimeVersion: 'fixture-runtime', lastCheckedAt: '2026-09-18T00:00:00Z'
  };

  function parsePromptValue<T>(prompt: string, key: string, nextKey?: string): T {
    const content = prompt.split(key + '=')[1]!;
    return JSON.parse(nextKey ? content.split('\n' + nextKey + '=')[0]! : content) as T;
  }

  function assessmentFor(request: AssessmentRequestV3, evidence: MemberEvidencePackageV3): MemberAssessmentCandidateV3 {
    const evidenceId = evidence.facts[0]!.evidenceIds[0]!;
    return {
      schemaVersion: 3, personId: request.personId, inputSignature: request.inputSignature,
      mode: request.mode, requestedSystemIds: request.requestedSystemIds,
      overview: { id: 'overview', headline: '一项血脂结果需要关注',
        summary: '这份报告中的 LDL-C 高于随附参考上限；目前不据此宣布疾病。',
        claimIds: ['claim-ldl'], actionIds: [], limitations: [] },
      systems: request.requestedSystemIds.map((systemId) => ({
        id: 'system:' + systemId, systemId, status: 'attention',
        headline: '血脂结果需关注', summary: 'LDL-C 高于报告参考上限。',
        claimIds: ['claim-ldl'], actionIds: [], limitations: []
      })),
      claims: [{ id: 'claim-ldl', topicKey: 'lipids', systemIds: request.requestedSystemIds,
        kind: 'interpretation', text: 'LDL-C 4.2 mmol/L，高于报告参考上限。',
        diseaseName: null, diagnosticStatus: null, temporalStatus: 'current',
        evidenceIds: [evidenceId], counterEvidenceIds: [], trendIds: [],
        knowledgeBasis: 'model_general', knowledgeSourceIds: [], criteriaBasis: null,
        rationale: '报告记载该数值。', materialUncertainty: null, consequenceLevel: 'routine' }],
      actions: [], questions: [], knowledgeSources: []
    };
  }

  it.each([1, 3])('同批 %i 份资料各一次 P01，全部完成后只做一次 P02', async (documentCount) => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-runner-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '测试工作区', () => new Date('2026-09-18T00:00:00Z'));
    const personId = service.ensurePrimaryMember({ displayName: '测试成员', relation: '本人' });
    await service.importFiles(Array.from({ length: documentCount }, (_, index) => ({
      path: '/tmp/虚构报告-' + index + '.txt',
      bytes: Buffer.from('2026-09-17 LDL-C 4.' + (index + 2) + ' mmol/L')
    })), personId);
    service.processNow({ accountState: connectedState, consentVersion: 1 });
    let extractionCalls = 0;
    let assessmentCalls = 0;
    const runtime = {
      getState: () => connectedState,
      runStructuredTurn: async (input: { prompt: string; allowWebSearch?: boolean }) => {
        if (input.prompt.includes('SOURCE_PACKAGE=')) {
          extractionCalls += 1;
          expect(input.allowWebSearch).toBe(false);
          const source = parsePromptValue<{ documentId: string; spans: Array<{ sourceSpanId: string; quote: string }> }>(input.prompt, 'SOURCE_PACKAGE');
          const span = source.spans[0]!;
          const value = span.quote.match(/LDL-C ([\d.]+)/)![1]!;
          const extraction: ExtractionResult = {
            schemaVersion: 1, documentId: source.documentId, coveredSourceSpanIds: source.spans.map((item) => item.sourceSpanId),
            subject: { reportedName: null, evidence: [], confidence: 'absent' },
            candidates: [{
              localKey: 'ldl', originalName: 'LDL-C', standardNameCandidate: 'LDL-C',
              value: { kind: 'numeric', rawText: value, decimal: value, comparator: 'eq' },
              unitRaw: 'mmol/L', referenceRangeRaw: null, reportedAbnormalFlag: null,
              specimen: null, method: null, bodySite: null, clinicalDate: '2026-09-17',
              evidence: [{ sourceSpanId: span.sourceSpanId, quote: span.quote }], issues: []
            }]
          };
          return { threadId: 'extract', turnId: 'extract-' + extractionCalls, output: extraction,
            metrics: { durationMs: 10, webSearches: 0, webPageOpens: 0, webPageFinds: 0,
              webSearchOtherActions: 0, inputTokens: 10, outputTokens: 20, cachedInputTokens: 0 } };
        }
        assessmentCalls += 1;
        expect(input.prompt).toContain('ASSESSMENT_REQUEST=');
        const request = parsePromptValue<AssessmentRequestV3>(input.prompt, 'ASSESSMENT_REQUEST', 'MEMBER_EVIDENCE_PACKAGE');
        const evidence = parsePromptValue<MemberEvidencePackageV3>(input.prompt, 'MEMBER_EVIDENCE_PACKAGE');
        return { threadId: 'assess', turnId: 'assess-1', output: assessmentFor(request, evidence),
          metrics: { durationMs: 20, webSearches: 2, webPageOpens: 1, webPageFinds: 0,
            webSearchOtherActions: 0, inputTokens: 40, outputTokens: 50, cachedInputTokens: 15 } };
      }
    } as unknown as CodexRuntimeManager;
    await new ProcessingJobRunner(runtime).runAvailableJobs(service.store);
    expect(extractionCalls).toBe(documentCount);
    expect(assessmentCalls).toBe(1);
    expect(service.store.listStoredJobs()[0]).toMatchObject({
      status: 'succeeded', stage: 'publish', completedUnits: documentCount
    });
    expect(service.store.listAcceptedObservations(personId)).toHaveLength(documentCount);
    expect(service.store.listMemberAssessmentSnapshots(personId, true)).toHaveLength(1);
    expect(recordedTurnUsage(service.store.databasePath)).toMatchObject({
      attemptedTurnRequests: { P01: documentCount, P02: 1, P03: 0, P04: 0, other: 0 },
      completedTurnResponses: { P01: documentCount, P02: 1, P03: 0, P04: 0, other: 0 },
      completedTurnDurationMs: { P01: documentCount * 10, P02: 20, P03: 0, P04: 0, other: 0 },
      observedTurnMetrics: documentCount + 1,
      observedTokenUsage: documentCount + 1,
      webToolActions: { searches: 2, pageOpens: 1, pageFinds: 0, other: 0 },
      inputTokens: documentCount * 10 + 40, outputTokens: documentCount * 20 + 50,
      cachedInputTokens: 15
    });
    expect(recordedTurnUsage(service.store.databasePath).firstUsableFactMs).toBeGreaterThanOrEqual(0);
    service.close();
  });

  it('ABC 已完成后重启加入 D：只提取 D，P02 读取全历史、授权范围与现有行动，排除后不再发送旧事实', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-runner-history-'));
    roots.push(root);
    const timeline = [
      ['A', '2023-06-10', '4.1'], ['B', '2024-06-10', '4.2'],
      ['C', '2025-06-10', '4.3'], ['D', '2026-06-10', '4.4']
    ] as const;
    const runtimeFor = (requests: Array<{ stage: 'P01' | 'P02'; documentId?: string;
      evidence?: MemberEvidencePackageV3; request?: AssessmentRequestV3 }>) => ({
      getState: () => connectedState,
      runStructuredTurn: async (input: { prompt: string; allowWebSearch?: boolean; outputSchema: Record<string, unknown> }) => {
        if (input.prompt.includes('\nSOURCE_PACKAGE=')) {
          expect(input.allowWebSearch).toBe(false);
          expect(input.outputSchema.properties).toHaveProperty('documentId');
          const source = parsePromptValue<{ documentId: string; spans: Array<{ sourceSpanId: string; quote: string }> }>(
            input.prompt, 'SOURCE_PACKAGE');
          const span = source.spans[0]!;
          const clinicalDate = span.quote.match(/\d{4}-\d{2}-\d{2}/)![0]!;
          const value = span.quote.match(/LDL-C ([\d.]+)/)![1]!;
          requests.push({ stage: 'P01', documentId: source.documentId });
          return { threadId: 'extract', turnId: `extract-${requests.length}`, output: {
            schemaVersion: 1, documentId: source.documentId,
            coveredSourceSpanIds: source.spans.map((item) => item.sourceSpanId),
            subject: { reportedName: null, evidence: [], confidence: 'absent' },
            candidates: [{
              localKey: 'ldl', originalName: 'LDL-C', standardNameCandidate: 'LDL-C',
              value: { kind: 'numeric', rawText: value, decimal: value, comparator: 'eq' },
              unitRaw: 'mmol/L', referenceRangeRaw: null, reportedAbnormalFlag: null,
              specimen: null, method: null, bodySite: null, clinicalDate,
              evidence: [{ sourceSpanId: span.sourceSpanId, quote: span.quote }], issues: []
            }]
          } satisfies ExtractionResult };
        }
        expect(input.prompt).toContain('\nASSESSMENT_REQUEST=');
        expect(input.outputSchema.properties).toHaveProperty('inputSignature');
        const request = parsePromptValue<AssessmentRequestV3>(input.prompt, 'ASSESSMENT_REQUEST', 'MEMBER_EVIDENCE_PACKAGE');
        const evidence = parsePromptValue<MemberEvidencePackageV3>(input.prompt, 'MEMBER_EVIDENCE_PACKAGE');
        requests.push({ stage: 'P02', request, evidence });
        return { threadId: 'assess', turnId: `assess-${requests.length}`, output: assessmentFor(request, evidence) };
      }
    } as unknown as CodexRuntimeManager);

    const first = new PersonalWorkspaceService(root, '合成历史工作区', () => new Date('2026-09-22T00:00:00Z'));
    const personId = first.ensurePrimaryMember({ displayName: '合成本人', relation: '本人' });
    await first.importFiles(timeline.slice(0, 3).map(([label, date, value]) => ({
      path: `/tmp/合成报告-${label}.txt`, bytes: Buffer.from(`${date} LDL-C ${value} mmol/L`)
    })), personId);
    first.processNow({ accountState: connectedState, consentVersion: 1 });
    const firstRequests: Parameters<typeof runtimeFor>[0] = [];
    await new ProcessingJobRunner(runtimeFor(firstRequests)).runAvailableJobs(first.store);
    expect(first.store.listStoredJobs()[0]).toMatchObject({ status: 'succeeded' });
    expect(firstRequests.map((item) => item.stage)).toEqual(['P01', 'P01', 'P01', 'P02']);
    const historical = first.store.listAcceptedObservations(personId);
    expect(historical.map((item) => item.rawText)).toEqual(['4.1', '4.2', '4.3']);
    const action = first.createAction({ personId, title: '保留既有行动', detail: '本人已完成', dueDate: null, dueText: null });
    first.updateActionStatus({ actionId: action.id, status: 'completed', expectedRevision: action.userRevision });
    first.close();

    const reopened = new PersonalWorkspaceService(root, '合成历史工作区', () => new Date('2026-09-22T00:00:00Z'));
    const otherPersonId = reopened.createMember({ displayName: '隔离成员', relation: '家人', birthYear: null });
    reopened.createManualNote({ personId: otherPersonId, kind: 'history',
      immutableText: '其他成员独有的合成病史', effectiveDate: '2026-09-22', structuredFields: {}, expectedContextRevision: 0 });
    const [label, date, value] = timeline[3];
    await reopened.importFiles([{ path: `/tmp/合成报告-${label}.txt`,
      bytes: Buffer.from(`${date} LDL-C ${value} mmol/L`) }], personId);
    const documentD = reopened.getSnapshot(null).inbox.find((item) => item.displayName === '合成报告-D.txt')!.id;
    reopened.processNow({ accountState: connectedState, consentVersion: 1, documentIds: [documentD] });
    const dJob = reopened.store.listStoredJobs().find((job) => job.documentIds.includes(documentD))!;
    const consentDb = new Database(reopened.store.databasePath, { readonly: true });
    const dConsent = JSON.parse((consentDb.prepare(`
      SELECT c.scope_json FROM jobs j
      JOIN consents c ON c.id = json_extract(j.checkpoint_json, '$.consentId')
      WHERE j.id = ?
    `).get(dJob.id) as { scope_json: string }).scope_json) as {
      documentIds: string[]; historicalObservationIds: string[]; personIds: string[]
    };
    consentDb.close();
    expect(dConsent.documentIds).toEqual([documentD]);
    expect(dConsent.historicalObservationIds.sort()).toEqual(historical.map((item) => item.id).sort());
    expect(dConsent.personIds).toEqual([personId]);
    const nextRequests: Parameters<typeof runtimeFor>[0] = [];
    await new ProcessingJobRunner(runtimeFor(nextRequests)).runAvailableJobs(reopened.store);
    expect(nextRequests.map((item) => item.stage)).toEqual(['P01', 'P02']);
    expect(nextRequests[0]?.documentId).toBe(documentD);
    const fullEvidence = nextRequests[1]!.evidence!;
    expect(fullEvidence.facts.map((fact) => fact.rawValue)).toEqual(['4.1', '4.2', '4.3', '4.4']);
    expect(fullEvidence.facts.map((fact) => fact.observationId).slice(0, 3)).toEqual(historical.map((item) => item.id));
    expect(fullEvidence.trends.length).toBeGreaterThan(0);
    expect(JSON.stringify(fullEvidence.trends)).toContain('2023-06-10');
    expect(JSON.stringify(fullEvidence.trends)).toContain('2026-06-10');
    expect(JSON.stringify(fullEvidence)).not.toContain('其他成员独有的合成病史');
    expect(fullEvidence.existingActions).toEqual([expect.objectContaining({ id: action.id, title: '保留既有行动' })]);
    expect(reopened.store.listActionItems(personId)).toContainEqual(expect.objectContaining({ id: action.id, status: 'completed' }));
    expect(recordedTurnUsage(reopened.store.databasePath).attemptedTurnRequests)
      .toEqual({ P01: 1, P02: 1, P03: 0, P04: 0, other: 0 });

    const excludedId = historical[1]!.documentId;
    reopened.setDocumentIncluded({ documentId: excludedId, included: false, confirmedExclusion: true });
    reopened.processNow({ accountState: connectedState, consentVersion: 1 });
    const refreshRequests: Parameters<typeof runtimeFor>[0] = [];
    await new ProcessingJobRunner(runtimeFor(refreshRequests)).runAvailableJobs(reopened.store);
    expect(refreshRequests.map((item) => item.stage)).toEqual(['P02']);
    expect(refreshRequests[0]!.evidence!.facts.map((fact) => fact.rawValue)).toEqual(['4.1', '4.3', '4.4']);
    expect(JSON.stringify(refreshRequests[0]!.evidence)).not.toContain('4.2');
    expect(reopened.store.listActionItems(personId)).toContainEqual(expect.objectContaining({ id: action.id, status: 'completed' }));
    reopened.close();
  });

  it('多块提取在第二块失败后重启重试，只重发未完成块', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-runner-resume-chunk-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '合成多块工作区', () => new Date('2026-09-22T00:00:00Z'));
    const personId = service.ensurePrimaryMember({ displayName: '合成本人', relation: '本人' });
    const lines = Array.from({ length: 41 }, (_, index) =>
      `2026-09-21 LDL-C ${index === 40 ? '4.4' : '4.1'} mmol/L 第 ${index + 1} 行`);
    await service.importFiles([{ path: '/tmp/合成多块报告.txt', bytes: Buffer.from(lines.join('\n')) }], personId);
    service.processNow({ accountState: connectedState, consentVersion: 1 });
    const jobId = service.store.listStoredJobs()[0]!.id;
    const firstChunks: number[] = [];
    const extractionFor = (source: { documentId: string; spans: Array<{ sourceSpanId: string; quote: string }> }): ExtractionResult => {
      const span = source.spans[0]!;
      const value = span.quote.match(/LDL-C ([\d.]+)/)![1]!;
      return {
        schemaVersion: 1, documentId: source.documentId,
        coveredSourceSpanIds: source.spans.map((item) => item.sourceSpanId),
        subject: { reportedName: null, evidence: [], confidence: 'absent' },
        candidates: [{ localKey: 'ldl', originalName: 'LDL-C', standardNameCandidate: 'LDL-C',
          value: { kind: 'numeric', rawText: value, decimal: value, comparator: 'eq' },
          unitRaw: 'mmol/L', referenceRangeRaw: null, reportedAbnormalFlag: null,
          specimen: null, method: null, bodySite: null, clinicalDate: '2026-09-21',
          evidence: [{ sourceSpanId: span.sourceSpanId, quote: span.quote }], issues: [] }]
      };
    };
    const failingRuntime = {
      getState: () => connectedState,
      runStructuredTurn: async (input: { prompt: string }) => {
        const source = parsePromptValue<{ documentId: string; spans: Array<{ sourceSpanId: string; quote: string }> }>(
          input.prompt, 'SOURCE_PACKAGE');
        firstChunks.push(source.spans.length);
        if (firstChunks.length === 2) throw new Error('SYNTHETIC_TRANSIENT_FAILURE');
        return { threadId: 'extract', turnId: 'extract-first-chunk', output: extractionFor(source) };
      }
    } as unknown as CodexRuntimeManager;
    await new ProcessingJobRunner(failingRuntime).runAvailableJobs(service.store);
    expect(firstChunks).toEqual([40, 1]);
    expect(service.store.listStoredJobs()[0]).toMatchObject({ status: 'failed' });
    expect(service.store.listAcceptedObservations(personId)).toEqual([]);
    service.close();

    const reopened = new PersonalWorkspaceService(root, '合成多块工作区', () => new Date('2026-09-22T00:00:00Z'));
    reopened.store.retryFailedJob(jobId);
    const retryChunks: number[] = [];
    let assessmentCalls = 0;
    const retryRuntime = {
      getState: () => connectedState,
      runStructuredTurn: async (input: { prompt: string }) => {
        if (input.prompt.includes('\nSOURCE_PACKAGE=')) {
          const source = parsePromptValue<{ documentId: string; spans: Array<{ sourceSpanId: string; quote: string }> }>(
            input.prompt, 'SOURCE_PACKAGE');
          retryChunks.push(source.spans.length);
          return { threadId: 'extract-retry', turnId: 'extract-second-chunk', output: extractionFor(source) };
        }
        assessmentCalls += 1;
        const request = parsePromptValue<AssessmentRequestV3>(input.prompt, 'ASSESSMENT_REQUEST', 'MEMBER_EVIDENCE_PACKAGE');
        const evidence = parsePromptValue<MemberEvidencePackageV3>(input.prompt, 'MEMBER_EVIDENCE_PACKAGE');
        return { threadId: 'assess', turnId: 'assess-retry', output: assessmentFor(request, evidence) };
      }
    } as unknown as CodexRuntimeManager;
    await new ProcessingJobRunner(retryRuntime).runAvailableJobs(reopened.store);
    expect(retryChunks).toEqual([1]);
    expect(assessmentCalls).toBe(1);
    expect(reopened.store.listStoredJobs()[0]).toMatchObject({ status: 'succeeded' });
    expect(reopened.store.listAcceptedObservations(personId).map((item) => item.rawText).sort()).toEqual(['4.1', '4.4']);
    expect(recordedTurnUsage(reopened.store.databasePath).attemptedTurnRequests)
      .toEqual({ P01: 1, P02: 1, P03: 0, P04: 0, other: 0 });
    reopened.close();
  });

  it('身份冲突只隔离该资料，其他资料仍提取并参与一次成员综合', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-runner-partial-review-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '测试工作区', () => new Date('2026-09-18T00:00:00Z'));
    const personId = service.ensurePrimaryMember({ displayName: '测试成员', relation: '本人' });
    await service.importFiles([
      { path: '/tmp/虚构待核对报告一.txt', bytes: Buffer.from('姓名：另一人 2026-09-17 LDL-C 4.1 mmol/L') },
      { path: '/tmp/虚构清晰报告二.txt', bytes: Buffer.from('2026-09-17 LDL-C 4.2 mmol/L') }
    ], personId);
    service.processNow({ accountState: connectedState, consentVersion: 1 });
    const documentIds = service.store.listStoredJobs()[0]!.documentIds;
    const conflictDocumentId = documentIds.find((id) => service.store.getDocumentExtractionBundle(id).manifest.spans
      .some((span) => span.quote?.includes('姓名：另一人')))!;
    const clearDocumentId = documentIds.find((id) => id !== conflictDocumentId)!;
    let extractionCalls = 0;
    let assessmentCalls = 0;
    const runtime = {
      getState: () => connectedState,
      runStructuredTurn: async (input: { prompt: string }) => {
        if (input.prompt.includes('SOURCE_PACKAGE=')) {
          extractionCalls += 1;
          const source = parsePromptValue<{ documentId: string; spans: Array<{ sourceSpanId: string; quote: string }> }>(input.prompt, 'SOURCE_PACKAGE');
          const span = source.spans[0]!;
          const conflict = source.documentId === conflictDocumentId;
          const output: ExtractionResult = {
            schemaVersion: 1, documentId: source.documentId, coveredSourceSpanIds: source.spans.map((item) => item.sourceSpanId),
            subject: conflict
              ? { reportedName: '另一人', evidence: [{ sourceSpanId: span.sourceSpanId, quote: '姓名：另一人' }], confidence: 'explicit' }
              : { reportedName: null, evidence: [], confidence: 'absent' },
            candidates: [{
              localKey: 'ldl', originalName: 'LDL-C', standardNameCandidate: 'LDL-C',
              value: { kind: 'numeric', rawText: conflict ? '4.1' : '4.2', decimal: conflict ? '4.1' : '4.2', comparator: 'eq' },
              unitRaw: 'mmol/L', referenceRangeRaw: null, reportedAbnormalFlag: null,
              specimen: null, method: null, bodySite: null, clinicalDate: '2026-09-17',
              evidence: [{ sourceSpanId: span.sourceSpanId, quote: span.quote }], issues: []
            }]
          };
          return { threadId: 'extract', turnId: 'extract-' + extractionCalls, output };
        }
        assessmentCalls += 1;
        const request = parsePromptValue<AssessmentRequestV3>(input.prompt, 'ASSESSMENT_REQUEST', 'MEMBER_EVIDENCE_PACKAGE');
        const evidence = parsePromptValue<MemberEvidencePackageV3>(input.prompt, 'MEMBER_EVIDENCE_PACKAGE');
        expect(evidence.facts).toHaveLength(1);
        return { threadId: 'assess', turnId: 'assess-1', output: assessmentFor(request, evidence) };
      }
    } as unknown as CodexRuntimeManager;
    await new ProcessingJobRunner(runtime).runAvailableJobs(service.store);
    expect(extractionCalls).toBe(2);
    expect(assessmentCalls).toBe(1);
    expect(service.store.listStoredJobs()[0]).toMatchObject({ status: 'waiting_user', completedUnits: 2, totalUnits: 2 });
    expect(service.store.isDocumentCommitted(conflictDocumentId!)).toBe(false);
    expect(service.store.isDocumentCommitted(clearDocumentId!)).toBe(true);
    expect(service.store.listAcceptedObservations(personId)).toHaveLength(1);
    expect(service.store.listMemberAssessmentSnapshots(personId, true)).toHaveLength(1);
    service.close();
  });

  it('只中断本应用当前 turn，并把任务确认成 cancelled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-runner-cancel-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '测试工作区', () => new Date('2026-09-18T00:00:00Z'));
    const personId = service.ensurePrimaryMember({ displayName: '测试成员', relation: '本人' });
    await service.importFiles([{ path: '/tmp/虚构取消报告.txt', bytes: Buffer.from('虚构待取消资料') }], personId);
    const state: AccountState = {
      status: 'connected', displayLabel: 'fixture@example.test',
      quota: { status: 'available', primaryUsedPercent: 10, secondaryUsedPercent: null, resetsAt: null },
      runtimeVersion: 'fixture-runtime', lastCheckedAt: '2026-09-18T00:00:00Z'
    };
    service.processNow({ accountState: state, consentVersion: 1 });
    let rejectTurn!: (error: Error) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const runtime = {
      getState: () => state,
      runStructuredTurn: async () => new Promise<never>((_resolve, reject) => {
        rejectTurn = reject;
        markStarted();
      }),
      interruptActiveTurn: async () => rejectTurn(new Error('CODEX_TURN_INTERRUPTED'))
    } as unknown as CodexRuntimeManager;
    const runner = new ProcessingJobRunner(runtime);
    const running = runner.runAvailableJobs(service.store);
    await started;
    const jobId = service.store.listStoredJobs()[0]!.id;
    expect(await runner.cancelJob(service.store, jobId)).toEqual({ running: true, alreadyTerminal: false });
    await running;
    expect(service.store.listStoredJobs()[0]).toMatchObject({ id: jobId, status: 'cancelled', completedUnits: 0 });
    expect(service.store.listAcceptedObservations(personId)).toEqual([]);
    expect(recordedTurnUsage(service.store.databasePath)).toMatchObject({
      attemptedTurnRequests: { P01: 1, P02: 0, P03: 0, P04: 0, other: 0 },
      completedTurnResponses: { P01: 0, P02: 0, P03: 0, P04: 0, other: 0 },
      failedTurnRequests: { P01: 1, P02: 0, P03: 0, P04: 0, other: 0 },
      firstUsableFactMs: null
    });
    service.close();
  });

  it('取消后即使迟到的 AI 结果返回成功也不得落库', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-runner-late-result-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '测试工作区', () => new Date('2026-09-18T00:00:00Z'));
    const personId = service.ensurePrimaryMember({ displayName: '测试成员', relation: '本人' });
    await service.importFiles([{ path: '/tmp/迟到结果.txt', bytes: Buffer.from('LDL-C 4.2 mmol/L') }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    const spanId = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!.id;
    const state: AccountState = {
      status: 'connected', displayLabel: 'fixture@example.test',
      quota: { status: 'available', primaryUsedPercent: 10, secondaryUsedPercent: null, resetsAt: null },
      runtimeVersion: 'fixture-runtime', lastCheckedAt: '2026-09-18T00:00:00Z'
    };
    service.processNow({ accountState: state, consentVersion: 1 });
    let resolveTurn!: (value: { threadId: string; turnId: string; output: ExtractionResult }) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const extraction: ExtractionResult = {
      schemaVersion: 1, documentId, subject: { reportedName: null, evidence: [], confidence: 'absent' }, coveredSourceSpanIds: [spanId],
      candidates: [{
        localKey: 'ldl-late', originalName: 'LDL-C', standardNameCandidate: 'LDL-C',
        value: { kind: 'numeric', rawText: '4.2', decimal: '4.2', comparator: 'eq' }, unitRaw: 'mmol/L',
        referenceRangeRaw: null, reportedAbnormalFlag: null, specimen: null, method: null, bodySite: null,
        clinicalDate: null, evidence: [{ sourceSpanId: spanId, quote: 'LDL-C 4.2 mmol/L' }], issues: []
      }]
    };
    const runtime = {
      getState: () => state,
      runStructuredTurn: async () => new Promise<{ threadId: string; turnId: string; output: ExtractionResult }>((resolve) => {
        resolveTurn = resolve;
        markStarted();
      }),
      interruptActiveTurn: async () => undefined
    } as unknown as CodexRuntimeManager;
    const runner = new ProcessingJobRunner(runtime);
    const running = runner.runAvailableJobs(service.store);
    await started;
    const jobId = service.store.listStoredJobs()[0]!.id;
    await runner.cancelJob(service.store, jobId);
    resolveTurn({ threadId: 'late-thread', turnId: 'late-turn', output: extraction });
    await running;
    expect(service.store.listStoredJobs()[0]).toMatchObject({ status: 'cancelled' });
    expect(service.store.listAcceptedObservations(personId)).toEqual([]);
    expect(service.store.getDocumentAiTransmissionStatus(documentId)).toBe('unknown');
    service.close();
  });
});
