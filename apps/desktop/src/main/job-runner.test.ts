import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_AI_PREFERENCES, type AccountState, type DerivedSafetyReview, type DerivedSnapshotCandidate, type ExtractionResult, type SystemAnalysisCandidate, type SystemAnalysisReview } from '@contracts';
import type { CodexRuntimeManager } from './codex-runtime.js';
import { ProcessingJobRunner } from './job-runner.js';
import { PersonalWorkspaceService } from './workspace-service.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ProcessingJobRunner', () => {
  it.each([
    { label: '一次性授权任务依次完成事实与派生阶段', rejectSystem: false, expectedStatus: 'succeeded', expectedCalls: 6 },
    { label: '系统说明未通过时保留事实并标记部分完成', rejectSystem: true, expectedStatus: 'completed_with_issues', expectedCalls: 5 }
  ])('$label', async ({ rejectSystem, expectedStatus, expectedCalls }) => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-runner-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '测试工作区', () => new Date('2026-09-18T00:00:00Z'));
    const personId = service.ensurePrimaryMember({ displayName: '测试成员', relation: '本人' });
    await service.importFiles([{ path: '/tmp/虚构报告.txt', bytes: Buffer.from('2026-09-17 LDL-C 4.2 mmol/L') }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    const spanId = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!.id;
    const state: AccountState = {
      status: 'connected', displayLabel: 'fixture@example.test',
      quota: { status: 'available', primaryUsedPercent: 10, secondaryUsedPercent: null, resetsAt: null },
      runtimeVersion: 'fixture-runtime', lastCheckedAt: '2026-09-18T00:00:00Z'
    };
    service.processNow({ accountState: state, consentVersion: 1 });
    const extraction: ExtractionResult = {
      schemaVersion: 1, documentId, coveredSourceSpanIds: [spanId],
      subject: { reportedName: null, evidence: [], confidence: 'absent' },
      candidates: [{
        localKey: 'ldl-1', originalName: 'LDL-C', standardNameCandidate: 'LDL-C',
        value: { kind: 'numeric', rawText: '4.2', decimal: '4.2', comparator: 'eq' },
        unitRaw: 'mmol/L', referenceRangeRaw: '0-3.4', reportedAbnormalFlag: 'high',
        specimen: null, method: null, bodySite: null, clinicalDate: '2026-09-17',
        evidence: [{ sourceSpanId: spanId, quote: '2026-09-17 LDL-C 4.2 mmol/L' }], issues: []
      }]
    };
    let call = 0;
    let candidate: DerivedSnapshotCandidate | null = null;
    const runtime = {
      getState: () => state,
      runStructuredTurn: async (input: { prompt: string }) => {
        call += 1;
        if (call <= 2) return { threadId: 'extract-thread', turnId: `extract-${call}`, output: extraction };
        const observationId = service.store.listAcceptedObservations(personId)[0]!.id;
        if (call === 3) {
          candidate = {
            schemaVersion: 1, personId, factRevision: 1, dataQuality: 'partial',
            claims: [{
              id: 'claim-1', organId: 'cardiovascular', level: 'action', title: '咨询血脂记录',
              explanation: '原报告记录 LDL-C 4.2 mmol/L；建议就此咨询医生。',
              evidenceObservationIds: [observationId], boundaryNote: '这不是诊断。'
            }],
            lifestyleGuidance: []
          };
          return { threadId: 'derived-thread', turnId: 'derived-1', output: candidate };
        }
        if (call === 4) {
          const review: DerivedSafetyReview = {
            schemaVersion: 1, personId, factRevision: 1, overallSafe: true,
            claimReviews: [{ claimId: candidate!.claims[0]!.id, supported: true, safe: true, issue: null }],
            guidanceReviews: []
          };
          return { threadId: 'derived-thread', turnId: 'derived-2', output: review };
        }
        const bundle = service.buildSystemEvidenceBundle(personId, 'cardiovascular', DEFAULT_AI_PREFERENCES.modelId);
        if (call === 5 || (rejectSystem && call === 6)) {
          const citedEvidenceId = input.prompt.match(/evidence-[^"\\]+-primary/)?.[0]
            ?? bundle.directFacts[0]!.evidence.id;
          const systemCandidate: SystemAnalysisCandidate = {
            schemaVersion: 2,
            personId,
            systemId: 'cardiovascular',
            inputSignature: bundle.scope.inputSignature,
            headline: '这份记录中的 LDL-C 带有原报告偏高标记。',
            overview: 'LDL-C 带有原报告偏高标记；目前只有一次结果，不能判断长期变化。',
            assessmentStatus: 'attention',
            dataQuality: 'partial',
            keyPoints: [{
              id: 'point-ldl',
              kind: 'fact_summary',
              text: 'LDL-C 4.2 mmol/L，高于该报告参考上限 3.4。',
              evidenceIds: [rejectSystem && call === 5 ? 'missing-fact-evidence' : citedEvidenceId],
              limitations: [],
              trendFactIds: []
            }],
            topicSections: [{ topicId: 'lipids', title: '血脂', claimIds: ['point-ldl'], seriesIds: [], findingIds: [] }],
            conflicts: [],
            dataGaps: [{ text: '只有一次结果。', consequence: '不能判断趋势。' }],
            discussionPoints: [],
            recommendations: [],
            clinicallyImportantUnknowns: ['目前只有一次结果。']
          };
          return { threadId: 'system-thread', turnId: 'system-1', output: systemCandidate };
        }
        const review: SystemAnalysisReview = {
          schemaVersion: 1, personId,
          systemId: 'cardiovascular',
          inputSignature: bundle.scope.inputSignature,
          overallSupported: true,
          itemReviews: [{ itemId: 'point-ldl', supported: true, safe: true, trendConsistent: true, useful: true, issue: null }]
        };
        return { threadId: 'system-thread', turnId: 'system-2', output: review };
      }
    } as unknown as CodexRuntimeManager;
    const runner = new ProcessingJobRunner(runtime);
    await runner.runAvailableJobs(service.store);
    expect(call).toBe(expectedCalls);
    expect(service.store.listStoredJobs()[0]).toMatchObject({
      status: expectedStatus,
      stage: 'publish',
      completedUnits: 1,
      systemOutcomes: expect.arrayContaining([
        expect.objectContaining({ systemId: 'cardiovascular', status: rejectSystem ? 'rejected' : 'published' }),
        expect.objectContaining({ systemId: 'endocrine_metabolic', status: 'skipped_no_data' }),
        expect.objectContaining({ systemId: 'renal_urinary', status: 'skipped_no_data' })
      ])
    });
    expect(service.store.listCurrentDerivedSnapshots()).toHaveLength(1);
    expect(service.store.listSystemAnalysisSnapshots(personId, true)).toHaveLength(rejectSystem ? 0 : 1);
    expect(service.getSnapshot(state).persons[0]).toMatchObject({ derivedStatus: 'current', acceptedFactCount: 1 });
    expect(service.getSnapshot(state).inbox[0]).toMatchObject({ sentToAi: true, aiTransmissionStatus: 'completed' });
    if (rejectSystem) {
      const jobId = service.store.listStoredJobs()[0]!.id;
      service.store.retryFailedJob(jobId);
      await runner.runAvailableJobs(service.store);
      expect(call).toBe(7);
      expect(service.store.listStoredJobs()[0]).toMatchObject({
        status: 'succeeded',
        systemOutcomes: expect.arrayContaining([
          expect.objectContaining({ systemId: 'cardiovascular', status: 'published' }),
          expect.objectContaining({ systemId: 'endocrine_metabolic', status: 'skipped_no_data' })
        ])
      });
      expect(service.store.listAcceptedObservations(personId)).toHaveLength(1);
      expect(service.store.listCurrentDerivedSnapshots()).toHaveLength(1);
      expect(service.store.listSystemAnalysisSnapshots(personId, true)).toHaveLength(1);
    }
    service.close();
  });

  it('一份资料需要核对时仍继续处理同批其余资料', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-runner-partial-review-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '测试工作区', () => new Date('2026-09-18T00:00:00Z'));
    const personId = service.ensurePrimaryMember({ displayName: '测试成员', relation: '本人' });
    await service.importFiles([
      { path: '/tmp/虚构待核对报告一.txt', bytes: Buffer.from('报告一 2026-09-17 LDL-C 4.2 mmol/L') },
      { path: '/tmp/虚构清晰报告二.txt', bytes: Buffer.from('报告二 2026-09-17 LDL-C 4.2 mmol/L') }
    ], personId);
    const state: AccountState = {
      status: 'connected', displayLabel: 'fixture@example.test',
      quota: { status: 'available', primaryUsedPercent: 10, secondaryUsedPercent: null, resetsAt: null },
      runtimeVersion: 'fixture-runtime', lastCheckedAt: '2026-09-18T00:00:00Z'
    };
    service.processNow({ accountState: state, consentVersion: 1 });
    const job = service.store.listStoredJobs()[0]!;
    const [reviewDocumentId, clearDocumentId] = job.documentIds;
    const reviewSpanId = service.store.getDocumentExtractionBundle(reviewDocumentId!).manifest.spans[0]!.id;
    const clearSpanId = service.store.getDocumentExtractionBundle(clearDocumentId!).manifest.spans[0]!.id;
    const needsReviewOutput: ExtractionResult = {
      schemaVersion: 1,
      documentId: reviewDocumentId!,
      subject: { reportedName: null, evidence: [], confidence: 'absent' },
      coveredSourceSpanIds: [],
      candidates: []
    };
    const clearOutput: ExtractionResult = {
      schemaVersion: 1,
      documentId: clearDocumentId!,
      subject: { reportedName: null, evidence: [], confidence: 'absent' },
      coveredSourceSpanIds: [clearSpanId],
      candidates: [{
        localKey: 'ldl-clear', originalName: 'LDL-C', standardNameCandidate: 'LDL-C',
        value: { kind: 'numeric', rawText: '4.2', decimal: '4.2', comparator: 'eq' },
        unitRaw: 'mmol/L', referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: null, bodySite: null, clinicalDate: '2026-09-17',
        evidence: [{ sourceSpanId: clearSpanId, quote: '2026-09-17 LDL-C 4.2 mmol/L' }], issues: []
      }]
    };
    let call = 0;
    const runtime = {
      getState: () => state,
      runStructuredTurn: async () => {
        call += 1;
        return call <= 2
          ? { threadId: 'review-thread', turnId: 'review-turn', output: needsReviewOutput }
          : { threadId: 'clear-thread', turnId: `clear-${call}`, output: clearOutput };
      }
    } as unknown as CodexRuntimeManager;

    await new ProcessingJobRunner(runtime).runAvailableJobs(service.store);

    expect(call).toBe(4);
    expect(service.store.listStoredJobs()[0]).toMatchObject({ status: 'waiting_user', completedUnits: 2, totalUnits: 2 });
    expect(service.store.listOpenExtractionReviewIssues()).toEqual([
      expect.objectContaining({ documentId: reviewDocumentId, kind: 'coverage_gap', reasonCodes: ['EXTRACTION_COVERAGE_INCOMPLETE'] })
    ]);
    expect(service.store.isDocumentCommitted(clearDocumentId!)).toBe(true);
    expect(service.store.isDocumentCommitted(reviewDocumentId!)).toBe(false);
    expect(service.store.getFactRevision(personId)).toBe(1);
    expect(reviewSpanId).toBeTruthy();
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
