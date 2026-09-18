import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccountState, DerivedSafetyReview, DerivedSnapshotCandidate, ExtractionResult } from '@contracts';
import type { CodexRuntimeManager } from './codex-runtime.js';
import { ProcessingJobRunner } from './job-runner.js';
import { PersonalWorkspaceService } from './workspace-service.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ProcessingJobRunner', () => {
  it('一次性授权任务依次完成事实与派生阶段', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-runner-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '测试工作区', () => new Date('2026-09-18T00:00:00Z'));
    const personId = service.ensurePrimaryMember({ displayName: '测试成员', relation: '本人' });
    await service.importFiles([{ path: '/tmp/虚构报告.txt', bytes: Buffer.from('LDL-C 4.2 mmol/L') }], personId);
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
      candidates: [{
        localKey: 'ldl-1', originalName: 'LDL-C', standardNameCandidate: 'LDL-C',
        value: { kind: 'numeric', rawText: '4.2', decimal: '4.2', comparator: 'eq' },
        unitRaw: 'mmol/L', referenceRangeRaw: '0-3.4', reportedAbnormalFlag: 'high',
        specimen: null, method: null, bodySite: null, clinicalDate: '2026-09-17',
        evidence: [{ sourceSpanId: spanId, quote: 'LDL-C 4.2 mmol/L' }], issues: []
      }]
    };
    let call = 0;
    let candidate: DerivedSnapshotCandidate | null = null;
    const runtime = {
      getState: () => state,
      runStructuredTurn: async () => {
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
        const review: DerivedSafetyReview = {
          schemaVersion: 1, personId, factRevision: 1, overallSafe: true,
          claimReviews: [{ claimId: candidate!.claims[0]!.id, supported: true, safe: true, issue: null }],
          guidanceReviews: []
        };
        return { threadId: 'derived-thread', turnId: 'derived-2', output: review };
      }
    } as unknown as CodexRuntimeManager;
    await new ProcessingJobRunner(runtime).runAvailableJobs(service.store);
    expect(call).toBe(4);
    expect(service.store.listStoredJobs()[0]).toMatchObject({ status: 'succeeded', stage: 'publish', completedUnits: 1 });
    expect(service.store.listCurrentDerivedSnapshots()).toHaveLength(1);
    expect(service.getSnapshot(state).persons[0]).toMatchObject({ derivedStatus: 'current', acceptedFactCount: 1 });
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
});
