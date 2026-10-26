import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountState, AssessmentRepairRequestV1, AssessmentRequestV3, ExtractionResult, MemberAssessmentCandidateV3, MemberEvidencePackageV3 } from '@contracts';
import { stableHash } from '@core';
import type { CodexRuntimeManager } from './codex-runtime.js';
import { EXTRACTION_AI_PREFERENCES, ProcessingJobRunner } from './job-runner.js';
import { LegacyTextFixtureWorkspaceService as PersonalWorkspaceService } from './legacy-text-source.fixture.js';
import { DocumentExtractionPipeline } from './processing-pipeline.js';
import { DirectOriginalExtractionPipeline } from './direct-original-extraction.js';
import type { JobExecutionGuard, WorkspaceStore } from '@storage';
import { buildMemberAssessmentInput } from './member-assessment-input.js';
import { expandMemberEvidence, restoreMemberEvidenceReferences } from './member-evidence-transport.js';
import { buildMemberAnalysisPackage, createMemberAnalysisTransport } from './member-analysis-package.js';
import { assessmentRepairNode, MemberAssessmentPipeline, type AssessmentRepairDiagnostic, type FocusedReviewDiagnostic } from './member-assessment-pipeline.js';
import { CodexTurnFailure } from './codex-turn-failure.js';
import { requeueCurrentAccountWaitingJobs } from './account-job-recovery.js';
import { MEMBER_ASSESSMENT_PROMPT_VERSION, MEMBER_ASSESSMENT_RULES_VERSION } from './prompts/index.js';

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
      memberAssessmentRepairDiagnostics: AssessmentRepairDiagnostic[];
      memberAssessmentFocusedReviewDiagnostics: FocusedReviewDiagnostic[];
    };
  } finally { database.close(); }
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ProcessingJobRunner 旧记录续跑兼容（显式旧提取替身）', () => {
  beforeEach(() => {
    // 本文件保留旧队列、取消、授权及恢复记录的合成回归。只有测试显式替换旧提取器；
    // 生产 runner 始终调用 DirectOriginalExtractionPipeline，新入口另有真实接线集成测试。
    vi.spyOn(DirectOriginalExtractionPipeline.prototype, 'process').mockImplementation(function (this: DirectOriginalExtractionPipeline, documentId) {
      const fixture = this as unknown as { store: WorkspaceStore;
        runtime: ConstructorParameters<typeof DocumentExtractionPipeline>[1]; executionGuard: JobExecutionGuard };
      return new DocumentExtractionPipeline(fixture.store, fixture.runtime, fixture.executionGuard).process(documentId);
    });
  });
  const connectedState: AccountState = {
    status: 'connected', displayLabel: 'fixture@example.test',
    quota: { status: 'available', primaryUsedPercent: 10, secondaryUsedPercent: null, resetsAt: null },
    runtimeVersion: 'fixture-runtime', lastCheckedAt: '2026-09-18T00:00:00Z'
  };
  const assessmentOnlyOptions = (service: PersonalWorkspaceService, personId: string) => ({
    accountState: connectedState, consentVersion: 1, assessmentPersonId: personId,
    expectedAssessmentDataRevision: service.getSnapshot(connectedState).persons.find((person) => person.id === personId)!.dataRevision
  });

  it.each(['published', 'rejected'] as const)('成员综合 %s 后保存局部修复门禁元数据，不复制模型健康正文', async (status) => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-runner-repair-metadata-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '合成诊断记录工作区', () => new Date('2026-09-22T00:00:00Z'));
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
      await service.importFiles([{ path: '/tmp/合成门禁测试.txt', bytes: Buffer.from('2026-09-17 LDL-C 4.2 mmol/L') }], personId);
      service.processNow({ accountState: connectedState, consentVersion: 1 });
      const diagnostics: AssessmentRepairDiagnostic[] = [{
        originalCandidateHash: 'a'.repeat(64), targetIds: ['synthetic-claim', 'synthetic-action'],
        schemaVerdict: 'accepted', scopeVerdict: 'accepted',
        initialIssues: ['documented_source_not_proven:synthetic-claim'],
        remainingIssues: ['documented_source_not_proven:synthetic-claim'],
        heldTargetIds: ['synthetic-claim', 'synthetic-action'], failureReason: null
      }];
      const focusedDiagnostics: FocusedReviewDiagnostic[] = [
        { targetId: 'synthetic-claim', verdict: 'replace', reviewOrigin: 'model', outcome: 'held',
          reasonCodes: ['focused_scope_boundary_changed'],
          boundaryReasonCodes: ['p04_scope_boundary_changed', 'support_expanded', 'disease_changed'] },
        { targetId: 'synthetic-action', verdict: 'pass', reviewOrigin: 'model', outcome: 'dependency_held',
          reasonCodes: ['focused_scope_boundary_changed'],
          boundaryReasonCodes: ['post_review_action_hash_changed', 'post_review_action_premise_changed'] },
        { targetId: 'synthetic-local-dependency', verdict: 'hold', reviewOrigin: 'local_dependency_guard', outcome: 'dependency_repaired',
          reasonCodes: ['final_dependency_not_reviewed'], boundaryReasonCodes: ['final_dependency_not_reviewed'] }
      ];
      // 只替代综合结果以检验队列持久化；真实医学校验由 pipeline 的独立回归覆盖。
      vi.spyOn(MemberAssessmentPipeline.prototype, 'process').mockImplementation(async () => status === 'published'
        ? { ...publishedAssessmentFor(service, personId), repairDiagnostics: diagnostics, focusedReviewDiagnostics: focusedDiagnostics }
        : { ...assessmentBinding(service, personId), status, reason: 'documented_source_not_proven:synthetic-claim',
          threadId: 'synthetic-thread', turnId: 'synthetic-turn', callCount: 1, repairDiagnostics: diagnostics,
          focusedReviewDiagnostics: focusedDiagnostics });
      const runtime = {
        getState: () => connectedState,
        runStructuredTurn: async (input: { prompt: string }) => {
          const source = parsePromptValue<{ documentId: string }>(input.prompt, 'SOURCE_PACKAGE');
          return { threadId: 'synthetic-extract', turnId: 'synthetic-extract', output: extractionForDocument(service, source.documentId) };
        }
      } as unknown as CodexRuntimeManager;
      await new ProcessingJobRunner(runtime).runAvailableJobs(service.store);
      const usage = recordedTurnUsage(service.store.databasePath);
      expect(usage.memberAssessmentRepairDiagnostics).toEqual(diagnostics);
      expect(usage.memberAssessmentFocusedReviewDiagnostics).toEqual(focusedDiagnostics);
      expect(JSON.stringify(usage)).not.toContain('LDL-C 4.2');
      expect(service.store.listStoredJobs()[0]!.status).toBe(status === 'published' ? 'succeeded' : 'completed_with_issues');
      expect(service.store.listStoredJobs()[0]!.assessmentOutcome).toMatchObject({ status,
        reasonCode: status === 'published' ? null : 'validation_failed' });
      const database = new Database(service.store.databasePath, { readonly: true });
      expect(database.prepare('SELECT error_code FROM job_attempts ORDER BY rowid DESC LIMIT 1').get()).toEqual({ error_code: null });
      database.close();
    } finally { service.close(); }
  });

  it.each(['skipped_no_data', 'reused_current'] as const)('综合 %s 单独落盘，不以任务 publish 阶段冒充新生成', async (outcomeStatus) => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-runner-assessment-skip-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '合成综合跳过工作区', () => new Date('2026-09-22T00:00:00Z'));
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
      await service.importFiles([{ path: '/tmp/合成跳过报告.txt', bytes: Buffer.from('2026-09-17 LDL-C 4.2 mmol/L') }], personId);
      service.processNow({ accountState: connectedState, consentVersion: 1 });
      if (outcomeStatus === 'skipped_no_data') {
        vi.spyOn(DirectOriginalExtractionPipeline.prototype, 'process').mockImplementation(async (documentId) => ({
          status: 'partial', documentId, candidateCount: 0, issueId: 'synthetic-blank', reason: 'synthetic-no-result', requiresUser: false
        }));
      }
      vi.spyOn(MemberAssessmentPipeline.prototype, 'process').mockImplementation(async () => {
        if (outcomeStatus === 'skipped_no_data') return { ...assessmentBinding(service, personId),
          status: 'skipped', reason: 'no_accepted_facts', callCount: 0 };
        const published = publishedAssessmentFor(service, personId);
        return { ...published, status: 'skipped', reason: 'signature_current', callCount: 0 };
      });
      const runtime = { getState: () => connectedState, runStructuredTurn: async (input: { prompt: string }) => {
        const source = parsePromptValue<{ documentId: string }>(input.prompt, 'SOURCE_PACKAGE');
        return { threadId: 'synthetic-extract', turnId: 'synthetic-extract', output: extractionForDocument(service, source.documentId) };
      } } as unknown as CodexRuntimeManager;
      await new ProcessingJobRunner(runtime).runAvailableJobs(service.store);
      expect(service.store.listStoredJobs()[0]!.assessmentOutcome).toMatchObject({ status: outcomeStatus,
        reasonCode: outcomeStatus === 'skipped_no_data' ? 'no_accepted_facts' : null });
      expect(service.store.listStoredJobs()[0]!.assessmentOutcome?.snapshotId === null).toBe(outcomeStatus === 'skipped_no_data');
      expect(service.store.listStoredJobs()[0]!.stage).toBe('publish');
    } finally { service.close(); }
  });

  it('模型综合声称发布却没有真实匹配快照时终止，保留已接纳报告', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-runner-assessment-proof-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '合成综合绑定工作区', () => new Date('2026-09-22T00:00:00Z'));
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
      await service.importFiles([{ path: '/tmp/合成绑定报告.txt', bytes: Buffer.from('2026-09-17 LDL-C 4.2 mmol/L') }], personId);
      service.processNow({ accountState: connectedState, consentVersion: 1 });
      vi.spyOn(MemberAssessmentPipeline.prototype, 'process').mockImplementation(async () => ({ ...assessmentBinding(service, personId),
        status: 'published', snapshotId: 'nonexistent-snapshot', idempotent: false, threadId: 'synthetic', turnId: 'synthetic', callCount: 1 }));
      const runtime = { getState: () => connectedState, runStructuredTurn: async (input: { prompt: string }) => {
        const source = parsePromptValue<{ documentId: string }>(input.prompt, 'SOURCE_PACKAGE');
        return { threadId: 'synthetic-extract', turnId: 'synthetic-extract', output: extractionForDocument(service, source.documentId) };
      } } as unknown as CodexRuntimeManager;
      await new ProcessingJobRunner(runtime).runAvailableJobs(service.store);
      expect(service.store.listStoredJobs()[0]).toMatchObject({ status: 'failed', completedUnits: 1, assessmentOutcome: null });
      expect(service.store.listAcceptedObservations(personId)).toHaveLength(1);
      const database = new Database(service.store.databasePath, { readonly: true });
      expect(database.prepare('SELECT error_code FROM job_attempts ORDER BY rowid DESC LIMIT 1').get())
        .toEqual({ error_code: 'JOB_ASSESSMENT_SNAPSHOT_MISMATCH' });
      database.close();
    } finally { service.close(); }
  });

  function parsePromptValue<T>(prompt: string, key: string, nextKey?: string): T {
    const content = prompt.split(key + '=')[1]!;
    const value = JSON.parse(nextKey ? content.split('\n' + nextKey + '=')[0]! : content);
    return (key === 'MEMBER_EVIDENCE_PACKAGE' ? expandMemberEvidence(value) : value) as T;
  }

  function assessmentBinding(service: PersonalWorkspaceService, personId: string) {
    const built = buildMemberAssessmentInput(service.store, personId, { modelId: 'synthetic-model', reasoningEffort: 'medium',
      analysisReferenceDate: '2026-09-18', webSearchAllowed: true });
    return { inputSignature: built.request.inputSignature, factRevision: built.factRevision,
      contextRevision: built.contextRevision, reviewScopeSignature: built.reviewScopeSignature };
  }

  it('两位成员可以交错处理，综合等待时不占住另一位成员的整批队列', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-runner-fair-members-')); roots.push(root);
    const service = new PersonalWorkspaceService(root, '合成公平调度', () => new Date('2026-09-22T00:00:00Z'));
    try {
      const firstPerson = service.ensurePrimaryMember({ displayName: '合成甲', relation: '本人' });
      const secondPerson = service.createMember({ displayName: '合成乙', relation: '家人', birthYear: null });
      await service.importFiles([{ path: '/tmp/合成甲并行.txt', bytes: Buffer.from('2026-09-17 LDL-C 4.2 mmol/L') }], firstPerson);
      await service.importFiles([{ path: '/tmp/合成乙并行.txt', bytes: Buffer.from('2026-09-17 LDL-C 4.2 mmol/L') }], secondPerson);
      service.processNow({ accountState: connectedState, consentVersion: 1 });
      let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
      let bothStarted!: () => void; const started = new Promise<void>((resolve) => { bothStarted = resolve; });
      const scopes: Array<{ jobId: string; attemptId: string }> = [];
      const runtime = { getState: () => connectedState, runStructuredTurn: async (input: {
        prompt: string; runScope: { jobId: string; attemptId: string }; assertExecutionActive: () => void;
      }) => {
        input.assertExecutionActive(); scopes.push(input.runScope);
        if (scopes.length === 2) bothStarted();
        await gate;
        const source = parsePromptValue<{ documentId: string }>(input.prompt, 'SOURCE_PACKAGE');
        return { threadId: 'synthetic-extract', turnId: source.documentId,
          output: extractionForDocument(service, source.documentId) };
      } } as unknown as CodexRuntimeManager;
      vi.spyOn(MemberAssessmentPipeline.prototype, 'process').mockImplementation(async (personId) => publishedAssessmentFor(service, personId));
      const runner = new ProcessingJobRunner(runtime); const running = runner.runAvailableJobs(service.store);
      await started;
      expect(new Set(scopes.map((scope) => scope.jobId)).size).toBe(2);
      expect(service.store.listStoredJobs().filter((job) => job.status === 'running')).toHaveLength(2);
      release(); await running;
      expect(service.store.listStoredJobs().every((job) => job.status === 'succeeded')).toBe(true);
      expect(service.store.listAcceptedObservations(firstPerson)).toHaveLength(1);
      expect(service.store.listAcceptedObservations(secondPerson)).toHaveLength(1);
    } finally { service.close(); }
  });

  it('默认成员 worker 可接入十位成员，不再用两位成员上限限制全局模型池', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-runner-ten-members-')); roots.push(root);
    const service = new PersonalWorkspaceService(root, '合成十成员工作区', () => new Date('2026-09-22T00:00:00Z'));
    try {
      const persons = Array.from({ length: 10 }, (_, index) => service.createMember({
        displayName: `合成容量成员${index}`, relation: '家人', birthYear: null
      }));
      for (const [index, personId] of persons.entries()) {
        await service.importFiles([{ path: `/tmp/合成容量${index}.txt`,
          bytes: Buffer.from('2026-09-17 LDL-C 4.2 mmol/L') }], personId);
      }
      service.processNow({ accountState: connectedState, consentVersion: 1 });
      let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
      let markAllStarted!: () => void; const allStarted = new Promise<void>((resolve) => { markAllStarted = resolve; });
      const scopes = new Set<string>();
      const runtime = { getState: () => connectedState, runStructuredTurn: async (input: {
        prompt: string; runScope: { jobId: string }; assertExecutionActive: () => void;
      }) => {
        input.assertExecutionActive(); scopes.add(input.runScope.jobId);
        if (scopes.size === 10) markAllStarted();
        await gate;
        const source = parsePromptValue<{ documentId: string }>(input.prompt, 'SOURCE_PACKAGE');
        return { threadId: 'synthetic-ten', turnId: source.documentId, output: extractionForDocument(service, source.documentId) };
      } } as unknown as CodexRuntimeManager;
      vi.spyOn(MemberAssessmentPipeline.prototype, 'process').mockImplementation(async (personId) => publishedAssessmentFor(service, personId));
      const running = new ProcessingJobRunner(runtime).runAvailableJobs(service.store);
      await allStarted;
      expect(service.store.listStoredJobs().filter((job) => job.status === 'running')).toHaveLength(10);
      release(); await running;
      expect(persons.every((personId) => service.store.listAcceptedObservations(personId).length === 1)).toBe(true);
      expect(service.store.listStoredJobs().every((job) => job.status === 'succeeded')).toBe(true);
    } finally { service.close(); }
  });

  it('明确短期限流只消耗真实失败成员的预算，不广播给尚在等名额的另一成员', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-runner-scoped-limit-')); roots.push(root);
    const service = new PersonalWorkspaceService(root, '合成限流隔离', () => new Date('2026-09-22T00:00:00Z'));
    try {
      const persons = ['合成甲', '合成乙'].map((displayName) => service.createMember({ displayName, relation: '家人', birthYear: null }));
      for (const [index, personId] of persons.entries()) {
        await service.importFiles([{ path: `/tmp/合成限流隔离${index}.txt`,
          bytes: Buffer.from('2026-09-17 LDL-C 4.2 mmol/L') }], personId);
      }
      service.processNow({ accountState: connectedState, consentVersion: 1 });
      let markBoth!: () => void; const both = new Promise<void>((resolve) => { markBoth = resolve; });
      let markFailed!: () => void; const failed = new Promise<void>((resolve) => { markFailed = resolve; });
      const scopes: string[] = [];
      const runtime = { getState: () => connectedState, refreshAccount: async () => connectedState,
        runStructuredTurn: async (input: { prompt: string; runScope: { jobId: string };
          assertRequestAllowed: () => void; onRequestFailure: (error: unknown) => void }) => {
          scopes.push(input.runScope.jobId);
          if (scopes.length === 1) {
            await both;
            const error = new CodexTurnFailure({ code: 'CODEX_RATE_LIMITED', serviceCode: 'rate_limit_exceeded', httpStatus: 429 });
            input.onRequestFailure(error); markFailed(); throw error;
          }
          // 第二位成员已提出请求但尚未获模型许可；另一位限流后才检查它能否真正发送。
          markBoth(); await failed; input.assertRequestAllowed();
          const source = parsePromptValue<{ documentId: string }>(input.prompt, 'SOURCE_PACKAGE');
          return { threadId: 'synthetic-peer', turnId: source.documentId, output: extractionForDocument(service, source.documentId) };
        } } as unknown as CodexRuntimeManager;
      vi.spyOn(MemberAssessmentPipeline.prototype, 'process').mockImplementation(async (personId) => publishedAssessmentFor(service, personId));
      await new ProcessingJobRunner(runtime).runAvailableJobs(service.store);
      expect(scopes).toHaveLength(2);
      const jobs = service.store.listStoredJobs();
      expect(jobs.find((job) => job.id === scopes[0])).toMatchObject({ status: 'retry_wait' });
      const peer = jobs.find((job) => job.id === scopes[1])!;
      expect(peer).toMatchObject({ status: 'succeeded', completedUnits: 1 });
      const db = new Database(service.store.databasePath, { readonly: true });
      try {
        const checkpoint = (id: string) => JSON.parse((db.prepare('SELECT checkpoint_json FROM jobs WHERE id=?')
          .get(id) as { checkpoint_json: string }).checkpoint_json) as { modelBusyRetry?: { retryCount: number } };
        expect(checkpoint(scopes[0]!).modelBusyRetry?.retryCount).toBe(1);
        expect(checkpoint(peer.id).modelBusyRetry).toBeUndefined();
      } finally { db.close(); }
    } finally { service.close(); }
  });

  it('关闭执行器后迟到的模型回执不再访问已经关闭的工作区', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-runner-close-generation-')); roots.push(root);
    const service = new PersonalWorkspaceService(root, '合成关闭代际', () => new Date('2026-09-22T00:00:00Z'));
    const personId = service.ensurePrimaryMember({ displayName: '合成甲', relation: '本人' });
    await service.importFiles([{ path: '/tmp/合成关闭.txt', bytes: Buffer.from('2026-09-17 LDL-C 4.2 mmol/L') }], personId);
    const documentId = service.store.listImportedDocuments()[0]!.id;
    const output = extractionForDocument(service, documentId);
    service.processNow({ accountState: connectedState, consentVersion: 1 });
    let release!: () => void; let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const interruptActiveTurn = vi.fn(async () => undefined);
    const runtime = { getState: () => connectedState, interruptActiveTurn, runStructuredTurn: async () => {
      markStarted(); await gate; return { threadId: 'synthetic', turnId: 'synthetic', output };
    } } as unknown as CodexRuntimeManager;
    const runner = new ProcessingJobRunner(runtime); const running = runner.runAvailableJobs(service.store);
    await started; const jobId = service.store.listStoredJobs()[0]!.id;
    runner.shutdown(); service.close(); release();
    await expect(running).resolves.toBeUndefined();
    expect(interruptActiveTurn).toHaveBeenCalledWith({ jobId });
  });

  it('提取阶段持久交接使第三位先读取，不让两份长综合堵住队列，续领保留模型且不重提', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-runner-three-members-')); roots.push(root);
    const service = new PersonalWorkspaceService(root, '合成三成员容量', () => new Date('2026-09-22T00:00:00Z'));
    try {
      const persons = [service.ensurePrimaryMember({ displayName: '合成甲', relation: '本人' }),
        service.createMember({ displayName: '合成乙', relation: '家人', birthYear: null }),
        service.createMember({ displayName: '合成丙', relation: '家人', birthYear: null })];
      for (const [index, personId] of persons.entries()) await service.importFiles([{ path: `/tmp/合成成员容量${index}.txt`,
        bytes: Buffer.from('2026-09-17 LDL-C 4.2 mmol/L') }], personId);
      service.processNow({ accountState: connectedState, consentVersion: 1 });
      const started: string[] = []; const releases = new Map<string, () => void>();
      const analysisStarted: string[] = []; const analysisEfforts = new Map<string, string>();
      let releaseAnalysis!: () => void; let markAnalysisStarted!: () => void;
      const analysisGate = new Promise<void>((resolve) => { releaseAnalysis = resolve; });
      const firstAnalysis = new Promise<void>((resolve) => { markAnalysisStarted = resolve; });
      let startedTwo!: () => void; let startedThree!: () => void;
      const two = new Promise<void>((resolve) => { startedTwo = resolve; });
      const three = new Promise<void>((resolve) => { startedThree = resolve; });
      const runtime = { getState: () => connectedState, runStructuredTurn: async (input: { prompt: string }) => {
        const { documentId } = parsePromptValue<{ documentId: string }>(input.prompt, 'SOURCE_PACKAGE');
        const gate = new Promise<void>((resolve) => { releases.set(documentId, resolve); });
        started.push(documentId); if (started.length === 2) startedTwo(); if (started.length === 3) startedThree();
        await gate; return { threadId: 'synthetic', turnId: documentId, output: extractionForDocument(service, documentId) };
      } } as unknown as CodexRuntimeManager;
      vi.spyOn(MemberAssessmentPipeline.prototype, 'process').mockImplementation(async function (this: MemberAssessmentPipeline, personId) {
        analysisStarted.push(personId); analysisEfforts.set(personId, (this as unknown as { reasoningEffort: string }).reasoningEffort);
        markAnalysisStarted(); await analysisGate; return publishedAssessmentFor(service, personId);
      });
      let effort: 'medium' | 'high' = 'medium';
      const running = new ProcessingJobRunner(runtime, () => ({ modelId: 'gpt-6.1-sol', reasoningEffort: effort }),
        { memberJobs: 2 }).runAvailableJobs(service.store);
      await two;
      expect(started).toHaveLength(2); expect(service.store.listStoredJobs().filter((job) => job.status === 'running')).toHaveLength(2);
      effort = 'high';
      releases.get(started[0]!)!(); await three;
      expect(analysisStarted).toHaveLength(0);
      expect(service.store.listStoredJobs().filter((job) => job.status === 'running')).toHaveLength(2);
      releases.get(started[1]!)!(); await firstAnalysis;
      expect(started).toHaveLength(3); expect(analysisStarted).toHaveLength(1);
      releases.get(started[2]!)!(); releaseAnalysis(); await running;
      expect(service.store.listStoredJobs().every((job) => job.status === 'succeeded')).toBe(true);
      const yieldedPerson = service.store.listImportedDocuments().find((document) => document.id === started[0])!.personId!;
      expect(analysisEfforts.get(yieldedPerson)).toBe('medium');
      expect(started).toHaveLength(3); expect(new Set(started).size).toBe(3);
    } finally { service.close(); }
  });

  // 合成综合替身也必须经真实快照边界发布，不能用不存在的快照 ID 冒充成功。
  function publishedAssessmentFor(service: PersonalWorkspaceService, personId: string) {
    const binding = assessmentBinding(service, personId);
    const published = service.store.publishMemberAssessmentSnapshot({ snapshot: {
      schemaVersion: 3, personId, ...binding, mode: 'full', requestedSystemIds: [],
      promptVersion: MEMBER_ASSESSMENT_PROMPT_VERSION, rulesVersion: MEMBER_ASSESSMENT_RULES_VERSION,
      modelId: 'synthetic-model', reasoningEffort: 'medium', validationMode: 'local_only',
      reviewedTargetIds: [], heldTargetIds: [], limitations: [], evidenceCatalog: [],
      processingPlan: { strategy: 'full', trigger: 'none', partitionCount: 0 }, knowledgeVerifications: [],
      overview: { id: 'overview', headline: '合成综合', summary: '合成回执，不产生医学结论。',
        claimIds: [], actionIds: [], limitations: [] }, systems: [], claims: [], actions: [], questions: [], knowledgeSources: []
    } });
    return { ...binding, status: 'published' as const, snapshotId: published.snapshotId, idempotent: published.idempotent,
      threadId: 'synthetic-thread', turnId: 'synthetic-turn', callCount: 1 };
  }

  function assessmentFor(request: AssessmentRequestV3, evidence: MemberEvidencePackageV3): MemberAssessmentCandidateV3 {
    const evidenceId = evidence.facts[0]!.evidenceIds?.[0] ?? evidence.facts[0]!.observationId;
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
        rationale: '报告记载该数值。', materialUncertainty: null, consequenceLevel: 'routine',
        changeAssessment: { direction: 'first_record', basis: 'insufficient',
          summary: '目前只有这项检查的一次结果，不能判断前后变化。', reason: '没有对应的历史结果可比。',
          currentEvidenceIds: [evidenceId], previousEvidenceIds: [] } }],
      actions: [], questions: [], knowledgeSources: []
    };
  }

  function extractionForDocument(service: PersonalWorkspaceService, documentId: string): ExtractionResult {
    const spans = service.store.getDocumentExtractionBundle(documentId).manifest.spans;
    const span = spans[0]!;
    const value = span.quote!.match(/LDL-C ([\d.]+)/)![1]!;
    return {
      schemaVersion: 1, documentId, coveredSourceSpanIds: spans.map((item) => item.id),
      subject: { reportedName: null, evidence: [], confidence: 'absent' },
      candidates: [{ localKey: 'ldl', originalName: 'LDL-C', standardNameCandidate: 'LDL-C',
        value: { kind: 'numeric', rawText: value, decimal: value, comparator: 'eq' },
        unitRaw: 'mmol/L', referenceRangeRaw: null, reportedAbnormalFlag: null,
        specimen: null, method: null, bodySite: null, clinicalDate: '2026-09-17',
        evidence: [{ sourceSpanId: span.id, quote: span.quote! }],
        clinicalContext: { version: 1, status: 'complete', conditions: [] }, issues: [] }]
    };
  }

  // 只在新建临时库接纳合成事实；准备过程不建立模型任务或传输。
  async function publishAssessmentOnlyFixture(service: PersonalWorkspaceService, personId: string, label: string) {
    await service.importFiles([{ path: `/tmp/${label}.txt`, bytes: Buffer.from(`2026-09-17 LDL-C 4.2 mmol/L ${label}`) }], personId);
    const documentId = service.store.listImportedDocuments().find((document) => document.displayName === `${label}.txt`)!.id;
    const span = service.store.getDocumentExtractionBundle(documentId).manifest.spans[0]!;
    const acceptanceId = service.store.saveAcceptanceDecision({ method: 'auto', actor: 'policy',
      rulesVersion: 'synthetic-assessment-only', inputSignature: stableHash({ documentId }),
      outputHash: stableHash({ documentId, fixture: 'accepted' }), reviewRef: null, decision: 'accept' });
    service.store.publishFacts({ personId, documentId, documentCommitKey: stableHash({ documentId, fixture: 'commit' }),
      expectedRevision: service.store.getFactRevision(personId), changeSetHash: stableHash({ documentId, fixture: 'facts' }),
      summary: '合成已接纳历史', observations: [{ conceptKey: 'LDL-C', originalName: 'LDL-C', rawText: '4.2',
        valueKind: 'numeric', decimalValue: '4.2', qualifier: 'eq', unit: 'mmol/L', referenceRange: '0-3.4',
        clinicalDate: '2026-09-17', abnormalFlag: 'high', specimen: null, method: null, bodySite: null,
        clinicalContext: { version: 1, status: 'complete', conditions: [] },
        documentId, sourceSpanId: span.id, acceptanceId, evidence: [{ sourceSpanId: span.id, quote: span.quote! }] }] });
    return documentId;
  }

  it.each(['DATE_CORRECTION_READINGS_UNPROVEN', 'DATE_CORRECTION_DATE_ONLY_ADMISSION_HELD'] as const)(
    '日期用途%s时停止后续综合，入列及收尾均保留旧快照完整行', async (reason) => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-runner-date-held-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '合成日期未证明队列', () => new Date('2026-10-13T00:00:00Z'));
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成日期成员', relation: '本人' });
      const documentId = await publishAssessmentOnlyFixture(service, personId, '合成日期旧记录');
      publishedAssessmentFor(service, personId);
      const facts = service.store.listAcceptedObservations(personId);
      const database = new Database(service.store.databasePath, { readonly: true });
      const snapshotRows = () => database.prepare('SELECT * FROM member_assessment_snapshots_v3 ORDER BY id').all();
      try {
        const before = snapshotRows();
        expect(before).toHaveLength(1);
        expect(before[0]).toMatchObject({ status: 'current' });
        service.processNow({ accountState: connectedState, consentVersion: 1, purpose: 'date_correction',
          dateCorrectionDocumentId: documentId,
          expectedDateCorrectionDataRevision: service.getSnapshot(connectedState).persons.find((person) => person.id === personId)!.dataRevision });
        expect(snapshotRows()).toEqual(before);
        const jobId = service.store.listStoredJobs()[0]!.id;
        const extraction = vi.mocked(DirectOriginalExtractionPipeline.prototype.process).mockImplementation(async (targetId) => {
          expect(targetId).toBe(documentId);
          expect(service.store.isDateCorrectionJob(jobId)).toBe(true);
          return { status: 'partial', documentId, candidateCount: 0,
            issueId: service.store.listOpenExtractionReviewIssues().find((issue) => issue.documentId === documentId)!.id,
            reason, requiresUser: false, threadId: 'synthetic-date-thread', turnId: 'synthetic-date-turn' };
        });
        const assessment = vi.spyOn(MemberAssessmentPipeline.prototype, 'process');
        const turns = vi.fn();
        const runtime = { getState: () => connectedState, runStructuredTurn: turns } as unknown as CodexRuntimeManager;

        await new ProcessingJobRunner(runtime).runAvailableJobs(service.store);

        expect(extraction).toHaveBeenCalledTimes(1);
        expect(assessment).not.toHaveBeenCalled();
        expect(turns).not.toHaveBeenCalled();
        expect(service.store.listStoredJobs()[0]).toMatchObject({ status: 'completed_with_issues', assessmentOutcome: null });
        expect(recordedTurnUsage(service.store.databasePath).attemptedTurnRequests.P02).toBe(0);
        expect(snapshotRows()).toEqual(before);
        expect(service.store.listAcceptedObservations(personId)).toEqual(facts);
        expect(database.prepare('SELECT status,error_code FROM job_attempts ORDER BY rowid DESC LIMIT 1').get())
          .toEqual({ status: 'completed_with_issues', error_code: null });
      } finally { database.close(); }
    } finally { service.close(); }
  });

  it.each(['CODEX_MODEL_BUSY', 'CODEX_CONNECTION_FAILED'] as const)(
    '日期已应用后综合%s续跑使用独立分析配置，不重读原件', async (code) => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-runner-date-analysis-resume-'));
    roots.push(root);
    let now = new Date('2026-10-13T00:00:00Z').getTime();
    const service = new PersonalWorkspaceService(root, '合成日期后续综合恢复', () => new Date(now));
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成恢复成员', relation: '本人' });
      const documentId = await publishAssessmentOnlyFixture(service, personId, '合成日期已应用记录');
      service.processNow({ accountState: connectedState, consentVersion: 1, purpose: 'date_correction',
        dateCorrectionDocumentId: documentId,
        expectedDateCorrectionDataRevision: service.getSnapshot(connectedState).persons.find((person) => person.id === personId)!.dataRevision });
      const jobId = service.store.listStoredJobs()[0]!.id;
      const extraction = vi.mocked(DirectOriginalExtractionPipeline.prototype.process).mockImplementation(async (targetId) => {
        expect(targetId).toBe(documentId);
        // 这里只替代已由日期/storage测试覆盖的原子提交，调度、guard、P02及恢复均走真实代码。
        const database = new Database(service.store.databasePath);
        try {
          const row = database.prepare('SELECT checkpoint_json FROM jobs WHERE id=?').get(jobId) as { checkpoint_json: string };
          database.prepare('UPDATE jobs SET checkpoint_json=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(row.checkpoint_json),
            dateCorrectionAppliedRevision: service.store.getDateCorrectionScope(documentId).revision,
            dateCorrectionReceipt: { threadId: 'synthetic-applied-thread', turnId: 'synthetic-applied-turn' } }), jobId);
          database.prepare(`UPDATE review_issues SET resolution_status='resolved',resolution_revision=1,
            evidence_refs_json='[]',payload_json=json_set(payload_json,'$.candidateOptions',json('[]'),'$.reasonCodes',json('[]'))
            WHERE job_id=? AND field_ref=? AND json_extract(payload_json,'$.purpose')='date_correction'`)
            .run(jobId, `document:${documentId}`);
        } finally { database.close(); }
        return { status: 'published', documentId, candidateCount: 0, revision: service.store.getFactRevision(personId),
          threadId: 'synthetic-applied-thread', turnId: 'synthetic-applied-turn' };
      });
      const analysisPreferences = { modelId: 'gpt-6-sol', reasoningEffort: 'high' as const };
      let analysisCalls = 0;
      const turns = vi.fn(async (input: { prompt: string; aiPreferences: typeof analysisPreferences }) => {
        expect(input.aiPreferences).toEqual(analysisPreferences);
        expect(input.prompt).toContain('ASSESSMENT_REQUEST=');
        expect(input.prompt).not.toContain('DIRECT_ORIGINAL_P01');
        expect(input.prompt).not.toContain('DIRECT_ORIGINAL_P03');
        if (++analysisCalls === 1) throw new CodexTurnFailure({ code,
          threadId: 'synthetic-analysis-busy', turnId: 'synthetic-analysis-busy-turn' });
        const request = parsePromptValue<AssessmentRequestV3>(input.prompt, 'ASSESSMENT_REQUEST', 'MEMBER_EVIDENCE_PACKAGE');
        const evidence = parsePromptValue<MemberEvidencePackageV3>(input.prompt, 'MEMBER_EVIDENCE_PACKAGE');
        return { threadId: 'synthetic-analysis-completed', turnId: 'synthetic-analysis-completed-turn',
          output: assessmentFor(request, evidence) };
      });
      const runtime = { getState: () => connectedState, runStructuredTurn: turns } as unknown as CodexRuntimeManager;
      const runner = new ProcessingJobRunner(runtime, () => analysisPreferences);
      const facts = service.store.listAcceptedObservations(personId);

      await runner.runAvailableJobs(service.store);
      expect(service.store.listStoredJobs()[0]).toMatchObject({ status: code === 'CODEX_MODEL_BUSY' ? 'retry_wait' : 'failed',
        stage: 'analyze', completedUnits: 1 });
      expect(extraction).toHaveBeenCalledTimes(1);
      expect(turns).toHaveBeenCalledTimes(1);
      if (code === 'CODEX_MODEL_BUSY') now += 30_000;
      else service.store.retryFailedJob(jobId);

      await runner.runAvailableJobs(service.store);

      expect(service.store.listStoredJobs()[0]).toMatchObject({ status: 'succeeded', completedUnits: 1,
        assessmentOutcome: { status: 'published' } });
      expect(turns).toHaveBeenCalledTimes(2);
      expect(extraction).toHaveBeenCalledTimes(1);
      expect(service.store.listAcceptedObservations(personId)).toEqual(facts);
      const database = new Database(service.store.databasePath, { readonly: true });
      try {
        const attempts = database.prepare('SELECT model,reasoning_effort,status,error_code,usage_json FROM job_attempts ORDER BY rowid')
          .all() as Array<{ model: string; reasoning_effort: string; status: string; error_code: string | null; usage_json: string }>;
        expect(attempts).toHaveLength(2);
        expect(attempts[0]).toMatchObject({ model: 'gpt-6.1-sol', reasoning_effort: 'medium', error_code: code });
        expect(attempts[1]).toMatchObject({ model: analysisPreferences.modelId, reasoning_effort: analysisPreferences.reasoningEffort,
          status: 'succeeded', error_code: null });
        expect(JSON.parse(attempts[1]!.usage_json).attemptedTurnRequests).toMatchObject({ P01: 0, P03: 0, P02: 1 });
      } finally { database.close(); }
    } finally { service.close(); }
  });

  it.each(['P02', 'P03', 'P04'] as const)('仅成员综合通过真实 %s 接线读取该成员全部已接纳事实，待处理和其他成员均不发送，P01 为零', async (phase) => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-runner-assessment-only-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '合成指定综合', () => new Date('2026-09-22T00:00:00Z'));
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成甲', relation: '本人' });
      const otherPersonId = service.createMember({ displayName: '合成乙', relation: '家人', birthYear: null });
      await publishAssessmentOnlyFixture(service, personId, '合成甲一');
      await publishAssessmentOnlyFixture(service, personId, '合成甲二');
      const otherDocumentId = await publishAssessmentOnlyFixture(service, otherPersonId, '合成乙历史');
      await service.importFiles([{ path: '/tmp/合成甲待处理.txt', bytes: Buffer.from('合成待处理秘密，不应读取原件') }], personId);
      const pendingDocumentId = service.store.listImportedDocuments().find((document) => document.displayName === '合成甲待处理.txt')!.id;
      const accepted = service.store.listAcceptedObservations(personId);
      const localInput = buildMemberAssessmentInput(service.store, personId, {
        modelId: 'gpt-6.1-sol', reasoningEffort: 'medium', analysisReferenceDate: '2026-09-22', webSearchAllowed: true
      });
      const referenceIds = createMemberAnalysisTransport(localInput.evidencePackage, localInput.analysisEvidenceCatalog).referenceIds;
      service.processNow(assessmentOnlyOptions(service, personId));
      const extract = vi.mocked(DirectOriginalExtractionPipeline.prototype.process);
      let validCandidate: MemberAssessmentCandidateV3 | null = null;
      const turns = vi.fn(async (input: { prompt: string }) => {
        expect(input.prompt).not.toContain('合成待处理秘密');
        expect(input.prompt).not.toContain(otherDocumentId);
        expect(input.prompt).not.toContain(pendingDocumentId);
        if (input.prompt.includes('\nREPAIR_REQUEST=')) {
          const request = parsePromptValue<AssessmentRepairRequestV1>(input.prompt, 'REPAIR_REQUEST', 'SOURCE_CONTEXT');
          expect(request.personId).toBe(personId);
          return { threadId: 'synthetic-assessment', turnId: 'synthetic-p03', output: {
            schemaVersion: 1, personId, inputSignature: validCandidate!.inputSignature,
            originalCandidateHash: request.originalCandidateHash,
            results: request.targets.map((targetId) => ({ targetId, verdict: 'replace', reason: '合成引用修复。',
              replacement: structuredClone(assessmentRepairNode(validCandidate!, targetId)) }))
          } };
        }
        if (input.prompt.includes('\nREVIEW_REQUEST=')) {
          const request = parsePromptValue<{ targets: string[]; personId: string; inputSignature: string }>(
            input.prompt, 'REVIEW_REQUEST', 'SOURCE_CONTEXT');
          expect(request.personId).toBe(personId);
          return { threadId: 'synthetic-assessment', turnId: 'synthetic-p04', output: {
            schemaVersion: 1, personId, inputSignature: request.inputSignature,
            results: request.targets.map((targetId) => ({ targetId, verdict: 'pass', reason: '合成来源已核对。', replacement: null }))
          } };
        }
        expect(input.prompt).toContain('\nASSESSMENT_REQUEST=');
        const request = parsePromptValue<AssessmentRequestV3>(input.prompt, 'ASSESSMENT_REQUEST', 'MEMBER_EVIDENCE_PACKAGE');
        const evidence = parsePromptValue<MemberEvidencePackageV3>(input.prompt, 'MEMBER_EVIDENCE_PACKAGE');
        expect(request.personId).toBe(personId);
        const restored = restoreMemberEvidenceReferences(evidence, referenceIds);
        expect(restored.facts.map((fact) => fact.observationId).sort()).toEqual(accepted.map((fact) => fact.id).sort());
        expect(restored.facts.every((fact) => fact.documentId !== pendingDocumentId && fact.documentId !== otherDocumentId)).toBe(true);
        validCandidate = assessmentFor(request, evidence);
        if (phase === 'P04') validCandidate.claims[0]!.consequenceLevel = 'high';
        const output = structuredClone(validCandidate);
        if (phase === 'P03') output.claims[0]!.evidenceIds = ['unknown-synthetic-reference'];
        return { threadId: 'synthetic-assessment', turnId: 'synthetic-p02', output };
      });
      const runtime = { getState: () => connectedState, runStructuredTurn: turns } as unknown as CodexRuntimeManager;
      await new ProcessingJobRunner(runtime).runAvailableJobs(service.store);
      expect(turns).toHaveBeenCalledTimes(phase === 'P02' ? 1 : 2);
      expect(extract).not.toHaveBeenCalled();
      expect(recordedTurnUsage(service.store.databasePath).attemptedTurnRequests)
        .toMatchObject({ P01: 0, P02: 1, P03: phase === 'P03' ? 1 : 0, P04: phase === 'P04' ? 1 : 0 });
      const attemptReadback = new Database(service.store.databasePath, { readonly: true });
      try {
        expect(attemptReadback.prepare('SELECT error_code FROM job_attempts ORDER BY rowid DESC LIMIT 1').get())
          .toEqual({ error_code: null });
        const transmissions = attemptReadback.prepare('SELECT consent_id,document_id,stage FROM ai_transmissions ORDER BY rowid')
          .all() as Array<{ consent_id: string; document_id: string; stage: string }>;
        expect(new Set(transmissions.map((transmission) => transmission.consent_id)).size).toBe(1);
        expect(new Set(transmissions.map((transmission) => transmission.document_id)))
          .toEqual(new Set(service.store.listStoredJobs()[0]!.documentIds));
        expect(transmissions.map((transmission) => transmission.stage)).toEqual(phase === 'P02' ? ['member_assessment']
          : ['member_assessment', phase === 'P03' ? 'assessment_repair' : 'focused_review']);
      } finally { attemptReadback.close(); }
      expect(service.store.listStoredJobs()).toEqual([expect.objectContaining({ status: 'succeeded', stage: 'publish' })]);
      expect(service.store.listAcceptedObservations(personId)).toEqual(accepted);
      expect(service.store.isDocumentCommitted(pendingDocumentId)).toBe(false);
    } finally { service.close(); }
  });

  it.each(['uncommitted', 'wrong_anchor', 'extract_stage'] as const)('仅综合任务的 %s 状态明确失败，不降级或调用提取器', async (change) => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-runner-assessment-anchor-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '合成锚点隔离', () => new Date('2026-09-22T00:00:00Z'));
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成锚点成员', relation: '本人' });
      const documentId = await publishAssessmentOnlyFixture(service, personId, '合成锚点历史');
      await service.importFiles([{ path: '/tmp/合成不匹配锚点.txt', bytes: Buffer.from('合成尚未接纳的锚点') }], personId);
      const pendingDocumentId = service.store.listImportedDocuments().find((document) => document.displayName === '合成不匹配锚点.txt')!.id;
      service.processNow(assessmentOnlyOptions(service, personId));
      const jobId = service.store.listStoredJobs()[0]!.id;
      const database = new Database(service.store.databasePath);
      try {
        if (change === 'uncommitted') database.prepare('DELETE FROM document_commits WHERE document_id=?').run(documentId);
        if (change === 'wrong_anchor') database.prepare(`UPDATE jobs SET checkpoint_json=json_set(checkpoint_json,'$.documentIds',json(?)) WHERE id=?`)
          .run(JSON.stringify([pendingDocumentId]), jobId);
        if (change === 'extract_stage') database.prepare("UPDATE jobs SET stage='extract' WHERE id=?").run(jobId);
      } finally { database.close(); }
      const turns = vi.fn();
      const runtime = { getState: () => connectedState, runStructuredTurn: turns } as unknown as CodexRuntimeManager;
      await new ProcessingJobRunner(runtime).runAvailableJobs(service.store);
      expect(turns).not.toHaveBeenCalled();
      expect(DirectOriginalExtractionPipeline.prototype.process).not.toHaveBeenCalled();
      // 范围/阶段被篡改时存储层在领取前即隔离；已领取但锚点失去提交则由 runner 失败。
      expect(service.store.listStoredJobs()[0]!.status).toBe(change === 'uncommitted' ? 'failed' : 'waiting_user');
      const readback = new Database(service.store.databasePath, { readonly: true });
      try {
        expect(readback.prepare('SELECT error_code FROM job_attempts ORDER BY rowid DESC LIMIT 1').get())
          .toEqual(change === 'uncommitted' ? { error_code: 'ASSESSMENT_ONLY_ANCHOR_INVALID' } : undefined);
        expect(readback.prepare("SELECT COUNT(*) AS count FROM ai_transmissions WHERE job_id=? AND stage='extract'").get(jobId))
          .toEqual({ count: 0 });
      } finally { readback.close(); }
      if (change === 'uncommitted') expect(recordedTurnUsage(service.store.databasePath).attemptedTurnRequests.P01).toBe(0);
    } finally { service.close(); }
  });

  it('仅综合任务忙碌重试保留原授权和模型设置，整个续跑不调用 P01', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-runner-assessment-busy-'));
    roots.push(root);
    let now = new Date('2026-10-13T00:00:00Z').getTime();
    const service = new PersonalWorkspaceService(root, '合成综合繁忙续跑', () => new Date(now));
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成忙碌成员', relation: '本人' });
      await publishAssessmentOnlyFixture(service, personId, '合成忙碌历史');
      service.processNow(assessmentOnlyOptions(service, personId));
      const jobId = service.store.listStoredJobs()[0]!.id;
      let calls = 0;
      vi.spyOn(MemberAssessmentPipeline.prototype, 'process').mockImplementation(async () => {
        expect(service.store.isAssessmentOnlyJob(jobId)).toBe(true);
        service.store.updateJobStage(jobId, 'analyze');
        if (++calls === 1) throw new CodexTurnFailure({ code: 'CODEX_MODEL_BUSY' });
        return publishedAssessmentFor(service, personId);
      });
      const turns = vi.fn();
      const runtime = { getState: () => connectedState, runStructuredTurn: turns } as unknown as CodexRuntimeManager;
      const runner = new ProcessingJobRunner(runtime);
      await runner.runAvailableJobs(service.store);
      expect(service.store.listStoredJobs()[0]).toMatchObject({ status: 'retry_wait', stage: 'analyze' });
      now += 30_000;
      await runner.runAvailableJobs(service.store);
      expect(calls).toBe(2);
      expect(service.store.listStoredJobs()[0]!.status).toBe('succeeded');
      expect(service.store.isAssessmentOnlyJob(jobId)).toBe(true);
      expect(turns).not.toHaveBeenCalled();
      expect(DirectOriginalExtractionPipeline.prototype.process).not.toHaveBeenCalled();
    } finally { service.close(); }
  });

  it.each(['analyze', 'review_derived', 'publish'] as const)('仅综合任务从 %s 失败后正常重试，仍只恢复该成员综合', async (stage) => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-runner-assessment-retry-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '合成综合正常续跑', () => new Date('2026-09-22T00:00:00Z'));
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成续跑成员', relation: '本人' });
      await publishAssessmentOnlyFixture(service, personId, '合成续跑历史');
      service.processNow(assessmentOnlyOptions(service, personId));
      const claimed = service.store.claimNextQueuedJob('synthetic-failed-runner',
        stableHash({ provider: 'codex-chatgpt', displayLabel: connectedState.displayLabel }))!;
      const attemptId = service.store.startJobAttempt(claimed.id, 'synthetic-runtime');
      service.store.updateJobStage(claimed.id, stage);
      service.store.finishJobAttempt({ attemptId, status: 'failed', errorCode: 'SYNTHETIC_ASSESSMENT_FAILURE' });
      service.store.finishJob(claimed.id, 'failed');
      service.store.retryFailedJob(claimed.id);
      const assessment = vi.spyOn(MemberAssessmentPipeline.prototype, 'process')
        .mockImplementation(async (targetPersonId) => {
          expect(targetPersonId).toBe(personId);
          expect(service.store.isAssessmentOnlyJob(claimed.id)).toBe(true);
          return publishedAssessmentFor(service, personId);
        });
      const turns = vi.fn();
      const runtime = { getState: () => connectedState, runStructuredTurn: turns } as unknown as CodexRuntimeManager;
      await new ProcessingJobRunner(runtime).runAvailableJobs(service.store);
      expect(assessment).toHaveBeenCalledTimes(1);
      expect(turns).not.toHaveBeenCalled();
      expect(DirectOriginalExtractionPipeline.prototype.process).not.toHaveBeenCalled();
      expect(service.store.listStoredJobs()[0]!.status).toBe('succeeded');
    } finally { service.close(); }
  });

  function retryLegacyFailure(service: PersonalWorkspaceService,
    stage: 'analyze' | 'guidance' | 'review_derived' | 'system_analysis' | 'system_review' | 'publish', beforeRetry?: () => void) {
    const job = service.store.claimNextQueuedJob('synthetic-legacy-runner',
      stableHash({ provider: 'codex-chatgpt', displayLabel: connectedState.displayLabel }))!;
    const attemptId = service.store.startJobAttempt(job.id, 'synthetic-legacy-runtime');
    service.store.updateJobStage(job.id, stage);
    // 模拟旧执行器的错误 checkpoint：尚未提交的资料也被记作完成。
    service.store.updateJobProgress(job.id, job.documentIds.length);
    service.store.finishJob(job.id, 'failed');
    service.store.finishJobAttempt({ attemptId, status: 'failed', errorCode: 'SYNTHETIC_LEGACY_ANALYSIS_FAILURE' });
    beforeRetry?.();
    service.store.retryFailedJob(job.id);
    return job.id;
  }

  const derivedRetryStages = ['analyze', 'guidance', 'review_derived', 'system_analysis', 'system_review', 'publish'] as const;

  it('综合模型繁忙等待到期再续跑，已完成22份报告不再提取，模型设置变化也不混用', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-runner-busy-resume-'));
    roots.push(root);
    let now = new Date('2026-10-13T00:00:00Z').getTime();
    let preferences = { modelId: 'gpt-6.1-sol', reasoningEffort: 'medium' as const };
    const service = new PersonalWorkspaceService(root, '合成繁忙续跑工作区', () => new Date(now));
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
      await service.importFiles(Array.from({ length: 22 }, (_, index) => ({
        path: `/tmp/合成繁忙报告${index}.txt`, bytes: Buffer.from(`2026-09-17 LDL-C ${4 + index / 10} mmol/L`)
      })), personId);
      service.processNow({ accountState: connectedState, consentVersion: 1 });
      const jobId = service.store.listStoredJobs()[0]!.id;
      const extractCalls = vi.fn(async (input: { prompt: string }) => {
        const source = parsePromptValue<{ documentId: string }>(input.prompt, 'SOURCE_PACKAGE');
        return { threadId: 'synthetic-extract', turnId: source.documentId,
          output: extractionForDocument(service, source.documentId) };
      });
      let analysisCalls = 0;
      vi.spyOn(MemberAssessmentPipeline.prototype, 'process').mockImplementation(async () => {
        service.store.updateJobStage(jobId, 'analyze');
        analysisCalls += 1;
        if (analysisCalls === 1) throw new CodexTurnFailure({ code: 'CODEX_MODEL_BUSY',
          threadId: 'synthetic-busy-thread', turnId: 'synthetic-busy-turn', serviceCode: 'model_at_capacity' });
        return { ...publishedAssessmentFor(service, personId), threadId: 'synthetic-analysis', turnId: 'synthetic-analysis-turn' };
      });
      const runtime = { getState: () => connectedState, runStructuredTurn: extractCalls } as unknown as CodexRuntimeManager;
      const runner = new ProcessingJobRunner(runtime, () => preferences);
      const terminal = vi.fn();
      runner.on('terminal', terminal);
      await runner.runAvailableJobs(service.store);
      expect(service.store.listStoredJobs()[0]).toMatchObject({ status: 'retry_wait', completedUnits: 22, stage: 'analyze' });
      expect(extractCalls).toHaveBeenCalledTimes(22);
      expect(terminal).not.toHaveBeenCalled();
      const accepted = service.store.listAcceptedObservations(personId);
      expect(accepted).toHaveLength(22);
      preferences = { modelId: 'different-model', reasoningEffort: 'medium' };
      now += 29_999;
      await runner.runAvailableJobs(service.store);
      expect(analysisCalls).toBe(1);
      now += 1;
      await runner.runAvailableJobs(service.store);
      expect(analysisCalls).toBe(2);
      expect(extractCalls).toHaveBeenCalledTimes(22);
      expect(service.store.listAcceptedObservations(personId)).toEqual(accepted);
      expect(service.store.listStoredJobs()[0]).toMatchObject({ status: 'succeeded', completedUnits: 22 });
      expect(terminal).toHaveBeenCalledTimes(1);
      const db = new Database(service.store.databasePath, { readonly: true });
      const attempts = db.prepare('SELECT status,thread_id,turn_id,model,reasoning_effort,usage_json FROM job_attempts ORDER BY rowid')
        .all() as Array<{ status: string; thread_id: string; turn_id: string; model: string; reasoning_effort: string; usage_json: string }>;
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toMatchObject({ status: 'retry_wait', thread_id: 'synthetic-busy-thread', turn_id: 'synthetic-busy-turn' });
      expect(JSON.parse(attempts[0]!.usage_json).safeRuntimeFailure).toMatchObject({
        code: 'CODEX_MODEL_BUSY', modelId: 'gpt-6.1-sol', reasoningEffort: 'medium' });
      expect(attempts[1]).toMatchObject({ model: 'gpt-6.1-sol', reasoning_effort: 'medium' });
      db.close();
    } finally { service.close(); }
  });

  it.each(['CODEX_MODEL_BUSY', 'CODEX_CONNECTION_FAILED', 'SQLITE_CORRUPT', 'ENOSPC', 'SQLITE_FULL'])('只为模型繁忙有限重试，不吞 %s 失败', async (code) => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-runner-busy-budget-'));
    roots.push(root);
    let now = new Date('2026-10-13T00:00:00Z').getTime();
    const service = new PersonalWorkspaceService(root, '合成繁忙预算工作区', () => new Date(now));
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
      await service.importFiles([{ path: '/tmp/合成预算报告.txt', bytes: Buffer.from('2026-09-17 LDL-C 4.2 mmol/L') }], personId);
      service.processNow({ accountState: connectedState, consentVersion: 1 });
      const jobId = service.store.listStoredJobs()[0]!.id;
      const analysis = vi.spyOn(MemberAssessmentPipeline.prototype, 'process').mockImplementation(async () => {
        service.store.updateJobStage(jobId, 'analyze');
        throw code.startsWith('CODEX_') ? new CodexTurnFailure({ code }) : new Error(code);
      });
      const runtime = { getState: () => connectedState, runStructuredTurn: async (input: { prompt: string }) => {
        const source = parsePromptValue<{ documentId: string }>(input.prompt, 'SOURCE_PACKAGE');
        return { threadId: 'synthetic-extract', turnId: source.documentId, output: extractionForDocument(service, source.documentId) };
      } } as unknown as CodexRuntimeManager;
      const runner = new ProcessingJobRunner(runtime);
      await runner.runAvailableJobs(service.store);
      if (code === 'CODEX_MODEL_BUSY') {
        expect(service.store.listStoredJobs()[0]!.status).toBe('retry_wait');
        now += 30_000;
        await runner.runAvailableJobs(service.store);
        expect(service.store.listStoredJobs()[0]!.status).toBe('retry_wait');
        now += 120_000;
        await runner.runAvailableJobs(service.store);
        expect(analysis).toHaveBeenCalledTimes(3);
      } else expect(analysis).toHaveBeenCalledTimes(1);
      expect(service.store.listStoredJobs()[0]!.status).toBe('failed');
      now += 1_000_000;
      await runner.runAvailableJobs(service.store);
      expect(analysis).toHaveBeenCalledTimes(code === 'CODEX_MODEL_BUSY' ? 3 : 1);
      expect(service.store.listAcceptedObservations(personId)).toHaveLength(1);
      if (code === 'ENOSPC' || code === 'SQLITE_FULL') {
        expect(service.store.hasDueModelBusyRetry()).toBe(false);
        expect(service.store.listStoredJobs()[0]!.statusText).toContain('本机磁盘空间不足');
        expect(service.store.listStoredJobs()[0]!.statusText).toContain('从保存的进度继续');
        const db = new Database(service.store.databasePath, { readonly: true });
        try {
          expect(db.prepare('SELECT error_code FROM job_attempts ORDER BY rowid DESC LIMIT 1').get())
            .toEqual({ error_code: 'LOCAL_STORAGE_FULL' });
        } finally { db.close(); }
      }
    } finally { service.close(); }
  });

  it('磁盘失败回执可保存时停止本轮领取，释放空间后的手动重试不被进程内熔断拦住', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-runner-storage-retry-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '合成磁盘恢复工作区', () => new Date('2026-10-13T00:00:00Z'));
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成成员甲', relation: '本人' });
      const otherPersonId = service.store.createPerson({ displayName: '合成成员乙', relation: '家人' }).id;
      await service.importFiles([{ path: '/tmp/合成甲报告.txt', bytes: Buffer.from('2026-09-17 LDL-C 4.2 mmol/L') }], personId);
      await service.importFiles([{ path: '/tmp/合成乙报告.txt', bytes: Buffer.from('2026-09-17 LDL-C 4.3 mmol/L') }], otherPersonId);
      service.processNow({ accountState: connectedState, consentVersion: 1 });
      const extract = vi.spyOn(DirectOriginalExtractionPipeline.prototype, 'process').mockRejectedValue(
        Object.assign(new Error('合成来源写满'), { code: 'ENOSPC' }));
      const model = vi.fn();
      const runner = new ProcessingJobRunner({ getState: () => connectedState,
        runStructuredTurn: model } as unknown as CodexRuntimeManager);
      const storageNotice = vi.fn();
      runner.on('localStorageFull', storageNotice);
      await runner.runAvailableJobs(service.store);
      const failed = service.store.listStoredJobs().find((job) => job.status === 'failed')!;
      expect(failed.statusText).toContain('本机磁盘空间不足');
      expect(service.store.listStoredJobs().filter((job) => job.status === 'queued')).toHaveLength(1);
      expect(extract).toHaveBeenCalledTimes(1);
      expect(storageNotice).not.toHaveBeenCalled();
      expect(model).not.toHaveBeenCalled();
      // 用户明确重试后允许继续；这里用固定非存储错误结束替身，不发生真实模型调用。
      service.store.retryFailedJob(failed.id);
      extract.mockRejectedValue(new Error('SYNTHETIC_RECOVERED_FAILURE'));
      await runner.runAvailableJobs(service.store);
      expect(extract).toHaveBeenCalledTimes(3);
      expect(model).not.toHaveBeenCalled();
      expect(storageNotice).not.toHaveBeenCalled();
    } finally { service.close(); }
  });

  it.each(['startJobAttempt', 'finishJob', 'finishJobAttempt'] as const)(
    '%s 写满即使不能保存失败回执也安全熔断，不继续领取后续任务或重发模型', async (method) => {
      const root = mkdtempSync(join(tmpdir(), 'family-health-runner-storage-full-'));
      roots.push(root);
      const service = new PersonalWorkspaceService(root, '合成写满隔离工作区', () => new Date('2026-10-13T00:00:00Z'));
      try {
        const personId = service.ensurePrimaryMember({ displayName: '合成成员甲', relation: '本人' });
        const otherPersonId = service.store.createPerson({ displayName: '合成成员乙', relation: '家人' }).id;
        await service.importFiles([{ path: '/tmp/合成甲报告.txt', bytes: Buffer.from('2026-09-17 LDL-C 4.2 mmol/L') }], personId);
        await service.importFiles([{ path: '/tmp/合成乙报告.txt', bytes: Buffer.from('2026-09-17 LDL-C 4.3 mmol/L') }], otherPersonId);
        service.processNow({ accountState: connectedState, consentVersion: 1 });
        expect(service.store.listStoredJobs()).toHaveLength(2);
        const claim = vi.spyOn(service.store, 'claimNextQueuedJob');
        const storageError = Object.assign(new Error('合成私密路径不可记录'), { code: 'SQLITE_FULL' });
        const blockedWrite = vi.spyOn(service.store, method).mockImplementation(() => { throw storageError; });
        const extract = vi.spyOn(DirectOriginalExtractionPipeline.prototype, 'process').mockRejectedValue(
          Object.assign(new Error('合成私密来源不可记录'), { code: 'ENOSPC' }));
        const model = vi.fn();
        const runtime = { getState: () => connectedState, runStructuredTurn: model } as unknown as CodexRuntimeManager;
        const runner = new ProcessingJobRunner(runtime);
        const storageNotice = vi.fn();
        const terminalNotice = vi.fn();
        runner.on('localStorageFull', storageNotice);
        runner.on('terminal', terminalNotice);
        await expect(runner.runAvailableJobs(service.store)).resolves.toBeUndefined();
        expect(storageNotice).toHaveBeenCalledExactlyOnceWith({ code: 'LOCAL_STORAGE_FULL' });
        expect(terminalNotice).not.toHaveBeenCalled();
        expect(model).not.toHaveBeenCalled();
        expect(extract).toHaveBeenCalledTimes(method === 'startJobAttempt' ? 0 : 1);
        expect(claim).toHaveBeenCalledTimes(1);
        expect(blockedWrite).toHaveBeenCalledTimes(1);
        expect(service.store.listStoredJobs().filter((job) => job.status === 'queued')).toHaveLength(1);
        expect(service.store.hasDueModelBusyRetry()).toBe(false);
        // 磁盘后来可写也不让同一进程的轮询擅自续跑，按提示重开应用后再显式恢复。
        blockedWrite.mockRestore();
        await runner.runAvailableJobs(service.store);
        expect(claim).toHaveBeenCalledTimes(1);
        expect(storageNotice).toHaveBeenCalledTimes(1);
        expect(model).not.toHaveBeenCalled();
        expect(extract).toHaveBeenCalledTimes(method === 'startJobAttempt' ? 0 : 1);
      } finally { service.close(); }
    });

  it.each([
    { code: 'CODEX_REQUEST_LIMITED_UNKNOWN', quota: 'available', expected: 'failed', text: '原因尚未明确' },
    { code: 'CODEX_REQUEST_LIMITED_UNKNOWN', quota: 'exhausted', expected: 'waiting_quota', text: '等待额度恢复' },
    { code: 'CODEX_REQUEST_LIMITED_UNKNOWN', quota: 'unknown', expected: 'failed', text: '原因尚未明确' },
    { code: 'CODEX_QUOTA_EXHAUSTED', quota: 'available', expected: 'waiting_quota', text: '服务已返回用量上限' },
    { code: 'CODEX_RATE_LIMITED', quota: 'available', expected: 'retry_wait', text: '稍后自动重试' },
    { code: 'CODEX_RATE_LIMITED', quota: 'low', expected: 'retry_wait', text: '稍后自动重试' },
    { code: 'CODEX_RATE_LIMITED', quota: 'unknown', expected: 'failed', text: '请求被服务限流' },
    { code: 'CODEX_RATE_LIMITED', quota: 'exhausted', expected: 'waiting_quota', text: '等待额度恢复' }
  ] as const)('请求限制 $code 刷新一次账户，只有明确短期限流且额度可用才有限续跑：$expected', async ({ code, quota, expected, text }) => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-runner-request-limit-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '合成请求限制工作区', () => new Date('2026-10-13T00:00:00Z'));
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
      await service.importFiles([{ path: '/tmp/合成限流报告.txt', bytes: Buffer.from('2026-09-17 LDL-C 4.2 mmol/L') }], personId);
      service.processNow({ accountState: connectedState, consentVersion: 1 });
      const jobId = service.store.listStoredJobs()[0]!.id;
      let state = structuredClone(connectedState);
      const refreshAccount = vi.fn(async () => {
        state = { ...state, quota: { ...state.quota, status: quota } };
        return state;
      });
      const extract = vi.fn(async (input: { prompt: string }) => {
        const source = parsePromptValue<{ documentId: string }>(input.prompt, 'SOURCE_PACKAGE');
        return { threadId: 'synthetic-extract', turnId: source.documentId, output: extractionForDocument(service, source.documentId) };
      });
      const analysis = vi.spyOn(MemberAssessmentPipeline.prototype, 'process').mockImplementation(async () => {
        service.store.updateJobStage(jobId, 'analyze');
        throw new CodexTurnFailure({ code, httpStatus: 429, threadId: 'synthetic-limit-thread', turnId: 'synthetic-limit-turn' });
      });
      const runtime = { getState: () => state, refreshAccount, runStructuredTurn: extract } as unknown as CodexRuntimeManager;
      const runner = new ProcessingJobRunner(runtime);
      await runner.runAvailableJobs(service.store);
      expect(refreshAccount).toHaveBeenCalledTimes(1);
      expect(service.store.listStoredJobs()[0]).toMatchObject({ status: expected, completedUnits: 1, stage: 'analyze' });
      expect(service.store.listStoredJobs()[0]!.statusText).toContain(text);
      const saved = service.store.listAcceptedObservations(personId);
      expect(saved).toHaveLength(1);
      await runner.runAvailableJobs(service.store);
      expect(analysis).toHaveBeenCalledTimes(1);
      expect(refreshAccount).toHaveBeenCalledTimes(1);
      expect(extract).toHaveBeenCalledTimes(1);
      expect(service.store.listAcceptedObservations(personId)).toEqual(saved);
      const db = new Database(service.store.databasePath, { readonly: true });
      const attempt = db.prepare('SELECT status,error_code,finished_at,usage_json FROM job_attempts ORDER BY rowid DESC LIMIT 1')
        .get() as { status: string; error_code: string; finished_at: string | null; usage_json: string };
      db.close();
      expect(attempt).toMatchObject({ status: expected, error_code: code });
      expect(attempt.finished_at).not.toBeNull();
      expect(JSON.parse(attempt.usage_json).safeRuntimeFailure).toMatchObject({ code, httpStatus: 429,
        modelId: 'gpt-6.1-sol', reasoningEffort: 'medium' });
      expect(service.store.hasDueModelBusyRetry()).toBe(false);
    } finally { service.close(); }
  });

  it.each(['CODEX_REQUEST_LIMITED_UNKNOWN', 'CODEX_RATE_LIMITED'])(
    '%s 的账户刷新失败时保留断点，不能用过期可用额度盲目续跑', async (code) => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-runner-limit-account-read-failed-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '合成账户读取失败工作区', () => new Date('2026-10-13T00:00:00Z'));
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
      await service.importFiles([{ path: '/tmp/合成断点报告.txt', bytes: Buffer.from('2026-09-17 LDL-C 4.2 mmol/L') }], personId);
      service.processNow({ accountState: connectedState, consentVersion: 1 });
      const refreshAccount = vi.fn(async () => { throw new Error('SYNTHETIC_ACCOUNT_READ_FAILED'); });
      const analysis = vi.spyOn(MemberAssessmentPipeline.prototype, 'process').mockRejectedValue(
        new CodexTurnFailure({ code, httpStatus: 429 }));
      const runtime = { getState: () => connectedState, refreshAccount,
        runStructuredTurn: async (input: { prompt: string }) => {
          const source = parsePromptValue<{ documentId: string }>(input.prompt, 'SOURCE_PACKAGE');
          return { threadId: 'synthetic-extract', turnId: source.documentId, output: extractionForDocument(service, source.documentId) };
        } } as unknown as CodexRuntimeManager;
      const runner = new ProcessingJobRunner(runtime);
      await runner.runAvailableJobs(service.store);
      await runner.runAvailableJobs(service.store);
      expect(refreshAccount).toHaveBeenCalledTimes(1);
      expect(analysis).toHaveBeenCalledTimes(1);
      expect(service.store.listStoredJobs()[0]).toMatchObject({ status: 'failed', completedUnits: 1 });
      expect(service.store.listStoredJobs()[0]!.statusText).toContain(code === 'CODEX_REQUEST_LIMITED_UNKNOWN' ? '原因尚未明确' : '限流');
      expect(service.store.listAcceptedObservations(personId)).toHaveLength(1);
    } finally { service.close(); }
  });

  it.each([
    { code: 'CODEX_QUOTA_EXHAUSTED', freshQuota: 'available' },
    { code: 'CODEX_REQUEST_LIMITED_UNKNOWN', freshQuota: 'exhausted' }
  ] as const)('真实账户事件延迟恢复点之后不会重排 $code 的额度等待或重复读取报告', async ({ code, freshQuota }) => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-runner-account-event-recovery-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '合成账户恢复接线工作区', () => new Date('2026-10-13T00:00:00Z'));
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
      await service.importFiles([{ path: '/tmp/合成接线报告.txt', bytes: Buffer.from('2026-09-17 LDL-C 4.2 mmol/L') }], personId);
      service.processNow({ accountState: connectedState, consentVersion: 1 });
      const jobId = service.store.listStoredJobs()[0]!.id;
      let state = structuredClone(connectedState);
      let releaseRecovery!: () => void;
      const recovery = new Promise<void>((resolve) => { releaseRecovery = resolve; });
      const pendingRecoveries: Promise<void>[] = [];
      const emitter = new EventEmitter();
      const refreshAccount = vi.fn(async () => {
        state = { ...state, quota: { ...state.quota, status: freshQuota } };
        emitter.emit('stateChanged', state);
        return state;
      });
      const extract = vi.fn(async (input: { prompt: string }) => {
        const source = parsePromptValue<{ documentId: string }>(input.prompt, 'SOURCE_PACKAGE');
        return { threadId: 'synthetic-extract', turnId: source.documentId, output: extractionForDocument(service, source.documentId) };
      });
      const runtime = Object.assign(emitter, { getState: () => state, refreshAccount, runStructuredTurn: extract }) as unknown as CodexRuntimeManager;
      const runner = new ProcessingJobRunner(runtime);
      emitter.on('stateChanged', (eventState: AccountState) => {
        if (eventState.status !== 'connected') return;
        // 与主进程接线相同：先等待恢复点，再通过实际 helper 使用当前账户状态。
        pendingRecoveries.push((async () => {
          await recovery;
          requeueCurrentAccountWaitingJobs(service.store, () => runtime.getState());
          await runner.runAvailableJobs(service.store);
        })());
      });
      // 更早的 available 事件尚在等恢复点，也不能覆盖稍后刷新得知的 exhausted。
      emitter.emit('stateChanged', state);
      const analysis = vi.spyOn(MemberAssessmentPipeline.prototype, 'process').mockImplementation(async () => {
        service.store.updateJobStage(jobId, 'analyze');
        throw new CodexTurnFailure({ code, httpStatus: 429 });
      });
      await runner.runAvailableJobs(service.store);
      expect(service.store.listStoredJobs()[0]).toMatchObject({ status: 'waiting_quota', completedUnits: 1 });
      expect(service.getSnapshot(state).jobs[0]).toMatchObject({ status: 'waiting_quota', canRetry: true });
      const saved = service.store.listAcceptedObservations(personId);
      releaseRecovery();
      await Promise.all(pendingRecoveries);
      await runner.runAvailableJobs(service.store);
      expect(refreshAccount).toHaveBeenCalledTimes(1);
      expect(analysis).toHaveBeenCalledTimes(1);
      expect(extract).toHaveBeenCalledTimes(1);
      expect(service.store.listStoredJobs()[0]).toMatchObject({ status: 'waiting_quota', completedUnits: 1 });
      expect(service.store.listAcceptedObservations(personId)).toEqual(saved);
    } finally { service.close(); }
  });

  it.each(['cancel', 'consent', 'account'] as const)('429后刷新账户期间发生 %s，不能覆盖用户控制或继续发送', async (gate) => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-runner-limit-refresh-controls-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '合成限流控制工作区', () => new Date('2026-10-13T00:00:00Z'));
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
      await service.importFiles([{ path: '/tmp/合成控制报告.txt', bytes: Buffer.from('2026-09-17 LDL-C 4.2 mmol/L') }], personId);
      service.processNow({ accountState: connectedState, consentVersion: 1 });
      const jobId = service.store.listStoredJobs()[0]!.id;
      let state = structuredClone(connectedState);
      const refreshAccount = vi.fn(async () => {
        if (gate === 'cancel') await runner.cancelJob(service.store, jobId);
        else if (gate === 'account') state = { ...state, displayLabel: 'other-synthetic-account@example.test' };
        else {
          const db = new Database(service.store.databasePath, { readonly: true });
          const row = db.prepare('SELECT checkpoint_json FROM jobs WHERE id=?').get(jobId) as { checkpoint_json: string };
          db.close();
          service.store.revokeConsent((JSON.parse(row.checkpoint_json) as { consentId: string }).consentId);
        }
        return state;
      });
      const analysis = vi.spyOn(MemberAssessmentPipeline.prototype, 'process').mockRejectedValue(
        new CodexTurnFailure({ code: 'CODEX_REQUEST_LIMITED_UNKNOWN', httpStatus: 429 }));
      const runtime = { getState: () => state, refreshAccount, interruptActiveTurn: vi.fn(async () => undefined),
        runStructuredTurn: async (input: { prompt: string }) => {
          const source = parsePromptValue<{ documentId: string }>(input.prompt, 'SOURCE_PACKAGE');
          return { threadId: 'synthetic-extract', turnId: source.documentId, output: extractionForDocument(service, source.documentId) };
        } } as unknown as CodexRuntimeManager;
      const runner = new ProcessingJobRunner(runtime);
      await runner.runAvailableJobs(service.store);
      expect(service.store.listStoredJobs()[0]!.status).toBe(gate === 'cancel' ? 'cancelled' : gate === 'consent' ? 'waiting_user' : 'waiting_auth');
      await runner.runAvailableJobs(service.store);
      expect(refreshAccount).toHaveBeenCalledTimes(1);
      expect(analysis).toHaveBeenCalledTimes(1);
      expect(service.store.listAcceptedObservations(personId)).toHaveLength(1);
    } finally { service.close(); }
  });

  it.each(['cancel', 'consent', 'pause'] as const)('调用期间 %s 后收到繁忙回执，仍遵守用户控制而不偷偷续跑', async (gate) => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-runner-busy-controls-'));
    roots.push(root);
    let now = new Date('2026-10-13T00:00:00Z').getTime();
    const service = new PersonalWorkspaceService(root, '合成繁忙控制工作区', () => new Date(now));
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
      await service.importFiles([{ path: '/tmp/合成控制报告.txt', bytes: Buffer.from('2026-09-17 LDL-C 4.2 mmol/L') }], personId);
      service.processNow({ accountState: connectedState, consentVersion: 1 });
      const jobId = service.store.listStoredJobs()[0]!.id;
      const runtime = { getState: () => connectedState, interruptActiveTurn: vi.fn(async () => undefined),
        runStructuredTurn: async (input: { prompt: string }) => {
          const source = parsePromptValue<{ documentId: string }>(input.prompt, 'SOURCE_PACKAGE');
          return { threadId: 'synthetic-extract', turnId: source.documentId, output: extractionForDocument(service, source.documentId) };
        } } as unknown as CodexRuntimeManager;
      const runner = new ProcessingJobRunner(runtime);
      const analysis = vi.spyOn(MemberAssessmentPipeline.prototype, 'process').mockImplementation(async () => {
        service.store.updateJobStage(jobId, 'analyze');
        if (gate === 'cancel') await runner.cancelJob(service.store, jobId);
        else if (gate === 'pause') service.store.setQueuePaused(true);
        else {
          const db = new Database(service.store.databasePath, { readonly: true });
          const row = db.prepare('SELECT checkpoint_json FROM jobs WHERE id=?').get(jobId) as { checkpoint_json: string };
          db.close();
          service.store.revokeConsent((JSON.parse(row.checkpoint_json) as { consentId: string }).consentId);
        }
        throw new CodexTurnFailure({ code: 'CODEX_MODEL_BUSY', threadId: 'synthetic-busy-thread', turnId: 'synthetic-busy-turn' });
      });
      await runner.runAvailableJobs(service.store);
      expect(service.store.listStoredJobs()[0]!.status).toBe(gate === 'cancel' ? 'cancelled' : gate === 'consent' ? 'waiting_user' : 'retry_wait');
      now += 1_000_000;
      await runner.runAvailableJobs(service.store);
      expect(analysis).toHaveBeenCalledTimes(1);
      expect(service.store.listAcceptedObservations(personId)).toHaveLength(1);
      if (gate === 'cancel') expect(runtime.interruptActiveTurn).toHaveBeenCalledTimes(1);
    } finally { service.close(); }
  });

  it('续跑只处理失败处及后续报告，已完成且仍有内容提示的报告不重复提取', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-runner-document-resume-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '合成逐份续跑工作区', () => new Date('2026-09-18T00:00:00Z'));
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
      await service.importFiles([
        { path: '/tmp/合成前份报告.txt', bytes: Buffer.from('2026-09-17 LDL-C 4.2 mmol/L') },
        { path: '/tmp/合成后份报告.txt', bytes: Buffer.from('2026-09-17 LDL-C 4.3 mmol/L') }
      ], personId);
      service.processNow({ accountState: connectedState, consentVersion: 1 });
      const job = service.store.listStoredJobs()[0]!;
      const [firstId, failedId] = job.documentIds as [string, string];
      const originalProcess = DocumentExtractionPipeline.prototype.process;
      const calls: string[] = [];
      let failSecond = true;
      vi.spyOn(DocumentExtractionPipeline.prototype, 'process').mockImplementation(async function (this: DocumentExtractionPipeline, documentId: string) {
        calls.push(documentId);
        if (documentId === failedId && failSecond) throw new Error('SYNTHETIC_RUNTIME_FAILURE');
        const result = await originalProcess.call(this, documentId);
        if (documentId === firstId) service.store.saveExtractionReviewIssue({
          documentId, stage: 'extract', kind: 'coverage_gap', severity: 'warning',
          evidenceRefs: [], preserveDocumentStatus: true, reasonCodes: ['SYNTHETIC_CONTENT_GAP']
        });
        return result;
      });
      vi.spyOn(MemberAssessmentPipeline.prototype, 'process').mockImplementation(async () => publishedAssessmentFor(service, personId));
      const runtime = {
        getState: () => connectedState,
        runStructuredTurn: async (input: { prompt: string }) => {
          const source = parsePromptValue<{ documentId: string }>(input.prompt, 'SOURCE_PACKAGE');
          return { threadId: 'synthetic-extract', turnId: source.documentId,
            output: extractionForDocument(service, source.documentId) };
        }
      } as unknown as CodexRuntimeManager;
      const runner = new ProcessingJobRunner(runtime);
      await runner.runAvailableJobs(service.store);
      expect(service.store.listStoredJobs()[0]).toMatchObject({ status: 'failed', completedUnits: 1 });
      expect(service.store.getJobProcessedDocumentIds(job.id)).toEqual(new Set([firstId]));
      const savedFirst = service.store.listAcceptedObservations(personId);
      failSecond = false;
      service.store.retryFailedJob(job.id);
      await runner.runAvailableJobs(service.store);
      expect(calls).toEqual([firstId, failedId, failedId]);
      expect(service.store.listAcceptedObservations(personId)).toEqual(expect.arrayContaining(savedFirst));
      expect(service.store.listAcceptedObservations(personId)).toHaveLength(2);
      expect(service.store.listStoredJobs()[0]).toMatchObject({ status: 'completed_with_issues', completedUnits: 2 });
    } finally { service.close(); }
  });

  it('普通内容疑点只隔离该份报告，其他报告和成员综合继续，最终明确部分完成', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-runner-content-isolation-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '合成内容隔离工作区', () => new Date('2026-09-18T00:00:00Z'));
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
      await service.importFiles([
        { path: '/tmp/合成疑点报告.txt', bytes: Buffer.from('2026-09-17 LDL-C 4.2 mmol/L') },
        { path: '/tmp/合成清楚报告.txt', bytes: Buffer.from('2026-09-17 LDL-C 4.3 mmol/L') }
      ], personId);
      service.processNow({ accountState: connectedState, consentVersion: 1 });
      const job = service.store.listStoredJobs()[0]!;
      const [unclearId, clearId] = job.documentIds as [string, string];
      const originalProcess = DocumentExtractionPipeline.prototype.process;
      vi.spyOn(DocumentExtractionPipeline.prototype, 'process').mockImplementation(async function (this: DocumentExtractionPipeline, documentId: string) {
        if (documentId !== unclearId) return originalProcess.call(this, documentId);
        const issueId = service.store.saveExtractionReviewIssue({ documentId, stage: 'extract',
          kind: 'field_conflict', severity: 'blocking', evidenceRefs: [],
          reasonCodes: ['SOURCE_BINDING_UNRESOLVED'] });
        return { status: 'partial', documentId, issueId, reason: 'SOURCE_BINDING_UNRESOLVED',
          candidateCount: 0, requiresUser: false };
      });
      const assess = vi.spyOn(MemberAssessmentPipeline.prototype, 'process').mockImplementation(async () => publishedAssessmentFor(service, personId));
      const runtime = {
        getState: () => connectedState,
        runStructuredTurn: async () => ({ threadId: 'synthetic-extract', turnId: clearId,
          output: extractionForDocument(service, clearId) })
      } as unknown as CodexRuntimeManager;
      await new ProcessingJobRunner(runtime, undefined, { reportReads: 2 }).runAvailableJobs(service.store);
      expect(assess).toHaveBeenCalledOnce();
      expect(service.store.isDocumentCommitted(unclearId)).toBe(false);
      expect(service.store.isDocumentCommitted(clearId)).toBe(true);
      expect(service.store.listStoredJobs()[0]).toMatchObject({ status: 'completed_with_issues', completedUnits: 2 });
      expect(service.store.getJobProcessedDocumentIds(job.id)).toEqual(new Set(job.documentIds));
    } finally { service.close(); }
  });

  it('未知数据库故障仍终止批次，不能吞掉异常后宣布处理完成', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-runner-fatal-isolation-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '合成严重故障工作区', () => new Date('2026-09-18T00:00:00Z'));
    try {
      const personId = service.ensurePrimaryMember({ displayName: '合成成员', relation: '本人' });
      await service.importFiles([
        { path: '/tmp/合成系统故障报告.txt', bytes: Buffer.from('2026-09-17 LDL-C 4.2 mmol/L') },
        { path: '/tmp/合成并发故障报告.txt', bytes: Buffer.from('2026-09-17 LDL-C 4.4 mmol/L') },
        { path: '/tmp/合成未处理报告.txt', bytes: Buffer.from('2026-09-17 LDL-C 4.3 mmol/L') }
      ], personId);
      service.processNow({ accountState: connectedState, consentVersion: 1 });
      const extract = vi.spyOn(DocumentExtractionPipeline.prototype, 'process').mockRejectedValue(new Error('SQLITE_CORRUPT'));
      const assess = vi.spyOn(MemberAssessmentPipeline.prototype, 'process');
      const runtime = { getState: () => connectedState } as unknown as CodexRuntimeManager;
      await new ProcessingJobRunner(runtime, undefined, { reportReads: 2 }).runAvailableJobs(service.store);
      // 两份已开始的任务全部落定；发现失败后第三份不能再启动。
      expect(extract).toHaveBeenCalledTimes(2);
      expect(assess).not.toHaveBeenCalled();
      expect(service.store.listStoredJobs()[0]).toMatchObject({ status: 'failed', completedUnits: 0 });
      expect(service.store.getJobProcessedDocumentIds(service.store.listStoredJobs()[0]!.id)).toEqual(new Set());
    } finally { service.close(); }
  });

  it.each(derivedRetryStages)('旧 %s 重试只补未提交资料，已提交且有提示的资料不重提取', async (stage) => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-runner-legacy-retry-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '合成旧任务工作区', () => new Date('2026-09-18T00:00:00Z'));
    const personId = service.ensurePrimaryMember({ displayName: '测试成员', relation: '本人' });
    await service.importFiles([
      { path: '/tmp/合成已提交报告.txt', bytes: Buffer.from('2026-09-17 LDL-C 4.2 mmol/L') },
      { path: '/tmp/合成未提交报告.txt', bytes: Buffer.from('2026-09-17 LDL-C 4.3 mmol/L') }
    ], personId);
    service.processNow({ accountState: connectedState, consentVersion: 1 });
    const [committedId, pendingId] = service.store.listStoredJobs()[0]!.documentIds;
    await new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async () => ({ threadId: 'committed', turnId: 'committed', output: extractionForDocument(service, committedId!) })
    }).process(committedId!);
    const committedFacts = service.store.listAcceptedObservations(personId);
    const warningId = service.store.saveExtractionReviewIssue({ documentId: committedId!, stage: 'extract',
      kind: 'coverage_gap', severity: 'warning', evidenceRefs: [], preserveDocumentStatus: true,
      reasonCodes: ['SYNTHETIC_OPTIONAL_REVIEW'] });
    expect(service.store.isDocumentCommitted(pendingId!)).toBe(false);
    const jobId = retryLegacyFailure(service, stage);
    const turns: string[] = [];
    const runtime = {
      getState: () => connectedState,
      runStructuredTurn: async (input: { prompt: string; aiPreferences: { modelId: string; reasoningEffort: string } }) => {
        if (input.prompt.includes('\nSOURCE_PACKAGE=')) {
          const source = parsePromptValue<{ documentId: string }>(input.prompt, 'SOURCE_PACKAGE');
          turns.push('P01:' + source.documentId);
          expect(source.documentId).toBe(pendingId);
          expect(input.aiPreferences).toEqual(EXTRACTION_AI_PREFERENCES);
          expect(service.store.listStoredJobs()[0]).toMatchObject({ stage: 'extract', completedUnits: 1 });
          return { threadId: 'extract-retry', turnId: 'extract-retry', output: extractionForDocument(service, source.documentId) };
        }
        turns.push('P02');
        expect(input.aiPreferences).toEqual({ modelId: 'gpt-6-sol', reasoningEffort: 'high' });
        expect(service.store.listStoredJobs()[0]).toMatchObject({ stage: 'analyze', completedUnits: 2 });
        const request = parsePromptValue<AssessmentRequestV3>(input.prompt, 'ASSESSMENT_REQUEST', 'MEMBER_EVIDENCE_PACKAGE');
        const evidence = parsePromptValue<MemberEvidencePackageV3>(input.prompt, 'MEMBER_EVIDENCE_PACKAGE');
        expect(evidence.facts).toHaveLength(2);
        return { threadId: 'assess-retry', turnId: 'assess-retry', output: assessmentFor(request, evidence) };
      }
    } as unknown as CodexRuntimeManager;
    await new ProcessingJobRunner(runtime, () => ({ modelId: 'gpt-6-sol', reasoningEffort: 'high' })).runAvailableJobs(service.store);
    expect(turns).toEqual(['P01:' + pendingId, 'P02']);
    expect(service.store.listStoredJobs()[0]).toMatchObject({ id: jobId, status: 'completed_with_issues', completedUnits: 2, stage: 'publish' });
    expect(service.store.listAcceptedObservations(personId)).toEqual(expect.arrayContaining(committedFacts));
    expect(service.store.listOpenExtractionReviewIssues().map((issue) => issue.id)).toContain(warningId);
    expect(recordedTurnUsage(service.store.databasePath).attemptedTurnRequests)
      .toEqual({ P01: 1, P02: 1, P03: 0, P04: 0, other: 0 });
    service.close();
  });

  it.each(['committed', 'blocked', 'excluded'] as const)('旧分析重试的其余资料为 %s 时不运行 P01', async (remainingStatus) => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-runner-legacy-resolved-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '合成续跑工作区', () => new Date('2026-09-18T00:00:00Z'));
    const personId = service.ensurePrimaryMember({ displayName: '测试成员', relation: '本人' });
    await service.importFiles([
      { path: '/tmp/合成已提交资料.txt', bytes: Buffer.from('2026-09-17 LDL-C 4.2 mmol/L') },
      { path: '/tmp/合成其余资料.txt', bytes: Buffer.from('2026-09-17 LDL-C 4.3 mmol/L') }
    ], personId);
    service.processNow({ accountState: connectedState, consentVersion: 1 });
    const [committedId, remainingId] = service.store.listStoredJobs()[0]!.documentIds;
    const commit = async (documentId: string) => new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async () => ({ threadId: 'committed', turnId: documentId, output: extractionForDocument(service, documentId) })
    }).process(documentId);
    await commit(committedId!);
    if (remainingStatus === 'committed') await commit(remainingId!);
    if (remainingStatus === 'blocked') service.store.saveExtractionReviewIssue({ documentId: remainingId!, stage: 'extract',
      kind: 'person_conflict', severity: 'blocking', evidenceRefs: [], reasonCodes: ['SYNTHETIC_IDENTITY_CONFLICT'] });
    retryLegacyFailure(service, 'analyze', () => {
      if (remainingStatus === 'excluded') service.setDocumentIncluded({ documentId: remainingId!, included: false, confirmedExclusion: true });
    });
    let assessmentCalls = 0;
    const runtime = {
      getState: () => connectedState,
      runStructuredTurn: async (input: { prompt: string; aiPreferences: { modelId: string; reasoningEffort: string } }) => {
        expect(input.prompt).toContain('\nASSESSMENT_REQUEST=');
        expect(input.aiPreferences).toEqual({ modelId: 'gpt-6.1-sol', reasoningEffort: 'medium' });
        assessmentCalls += 1;
        const request = parsePromptValue<AssessmentRequestV3>(input.prompt, 'ASSESSMENT_REQUEST', 'MEMBER_EVIDENCE_PACKAGE');
        const evidence = parsePromptValue<MemberEvidencePackageV3>(input.prompt, 'MEMBER_EVIDENCE_PACKAGE');
        expect(evidence.facts).toHaveLength(remainingStatus === 'committed' ? 2 : 1);
        return { threadId: 'assess-only', turnId: 'assess-only', output: assessmentFor(request, evidence) };
      }
    } as unknown as CodexRuntimeManager;
    await new ProcessingJobRunner(runtime).runAvailableJobs(service.store);
    expect(assessmentCalls).toBe(1);
    expect(service.store.listStoredJobs()[0]).toMatchObject({ status: remainingStatus === 'blocked' ? 'completed_with_issues' : 'succeeded', completedUnits: 2 });
    expect(recordedTurnUsage(service.store.databasePath).attemptedTurnRequests)
      .toEqual({ P01: 0, P02: 1, P03: 0, P04: 0, other: 0 });
    service.close();
  });

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
      runStructuredTurn: async (input: { prompt: string; allowWebSearch?: boolean; aiPreferences: { modelId: string; reasoningEffort: string } }) => {
        if (input.prompt.includes('SOURCE_PACKAGE=')) {
          extractionCalls += 1;
          expect(input.allowWebSearch).toBe(false);
          expect(input.aiPreferences).toEqual({ modelId: 'gpt-6.1-sol', reasoningEffort: 'medium' });
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
              evidence: [{ sourceSpanId: span.sourceSpanId, quote: span.quote }], clinicalContext: { version: 1 as const, status: 'complete' as const, conditions: [] }, issues: []
            }]
          };
          return { threadId: 'extract', turnId: 'extract-' + extractionCalls, output: extraction,
            metrics: { durationMs: 10, webSearches: 0, webPageOpens: 0, webPageFinds: 0,
              webSearchOtherActions: 0, inputTokens: 10, outputTokens: 20, cachedInputTokens: 0 } };
        }
        assessmentCalls += 1;
        expect(input.prompt).toContain('ASSESSMENT_REQUEST=');
        expect(input.aiPreferences).toEqual({ modelId: 'gpt-6.1-sol', reasoningEffort: 'medium' });
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
    expect(service.store.listMemberAssessmentSnapshots(personId, true)[0]).toMatchObject({ modelId: 'gpt-6.1-sol', reasoningEffort: 'medium' });
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

  it('显式重核已完成报告时实际重读 P01，并只补入新核实的项目', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-runner-committed-repair-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '旧报告补修工作区', () => new Date('2026-09-24T00:00:00Z'));
    const personId = service.ensurePrimaryMember({ displayName: '测试成员', relation: '本人' });
    await service.importFiles([{
      path: '/tmp/旧报告补修.txt',
      bytes: Buffer.from('2026-09-17 LDL-C 4.2 mmol/L\n2026-09-17 ALT 32 U/L')
    }], personId);
    const documentId = service.getSnapshot(null).inbox[0]!.id;
    const spans = service.store.getDocumentExtractionBundle(documentId).manifest.spans;
    const candidate = (span: typeof spans[number], name: string, value: string, unit: string) => ({
      localKey: name, originalName: name, standardNameCandidate: name,
      value: { kind: 'numeric' as const, rawText: value, decimal: value, comparator: 'eq' as const },
      unitRaw: unit, referenceRangeRaw: null, reportedAbnormalFlag: null,
      specimen: null, method: null, bodySite: null, clinicalDate: '2026-09-17',
      evidence: [{ sourceSpanId: span.id, quote: span.quote }], clinicalContext: { version: 1 as const, status: 'complete' as const, conditions: [] }, issues: []
    });
    const result = (alt: string): ExtractionResult => ({
      schemaVersion: 1, documentId,
      subject: { reportedName: null, evidence: [], confidence: 'absent' },
      coveredSourceSpanIds: spans.map((span) => span.id),
      candidates: [candidate(spans[0]!, 'LDL-C', '4.2', 'mmol/L'), candidate(spans[1]!, 'ALT', alt, 'U/L')]
    });
    await new DocumentExtractionPipeline(service.store, {
      runStructuredTurn: async () => ({ threadId: 'old-thread', turnId: 'old-turn', output: result('999') })
    }).process(documentId);
    expect(service.store.listAcceptedObservations(personId)).toHaveLength(1);
    expect(service.store.listOpenExtractionReviewIssues()).toHaveLength(1);
    service.processNow({ accountState: connectedState, consentVersion: 1, documentIds: [documentId] });
    let extractionCalls = 0;
    const runtime = {
      getState: () => connectedState,
      runStructuredTurn: async (input: { prompt: string }) => {
        if (input.prompt.includes('SOURCE_PACKAGE=')) {
          extractionCalls += 1;
          return { threadId: 'repair-thread', turnId: 'repair-turn', output: result('32') };
        }
        const request = parsePromptValue<AssessmentRequestV3>(input.prompt, 'ASSESSMENT_REQUEST', 'MEMBER_EVIDENCE_PACKAGE');
        const evidence = parsePromptValue<MemberEvidencePackageV3>(input.prompt, 'MEMBER_EVIDENCE_PACKAGE');
        return { threadId: 'assess-thread', turnId: 'assess-turn', output: assessmentFor(request, evidence) };
      }
    } as unknown as CodexRuntimeManager;
    await new ProcessingJobRunner(runtime).runAvailableJobs(service.store);
    expect(extractionCalls).toBe(1);
    expect(service.store.listAcceptedObservations(personId)).toHaveLength(2);
    // 无法定位到原文结果的旧误候选不能仅因项目名相同而被结清。
    expect(service.store.listOpenExtractionReviewIssues()).toHaveLength(1);
    expect(service.store.listOpenExtractionReviewIssues()[0]!.reasonCodes).toContain('PREVIOUS_CANDIDATE_NOT_VERIFIED');
    expect(service.store.listStoredJobs()[0]!.status).toBe('completed_with_issues');
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
              evidence: [{ sourceSpanId: span.sourceSpanId, quote: span.quote }], clinicalContext: { version: 1 as const, status: 'complete' as const, conditions: [] }, issues: []
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
    const fullPackage = buildMemberAssessmentInput(reopened.store, personId, {
      modelId: 'gpt-6.1-sol', reasoningEffort: 'medium', analysisReferenceDate: '2026-09-22', webSearchAllowed: true
    }).evidencePackage;
    const fullEvidence = restoreMemberEvidenceReferences(nextRequests[1]!.evidence!,
      createMemberAnalysisTransport(fullPackage).referenceIds);
    expect(fullEvidence).toEqual(buildMemberAnalysisPackage(fullPackage));
    expect(fullEvidence.facts.map((fact) => fact.rawValue)).toEqual(['4.1', '4.2', '4.3', '4.4']);
    expect(fullEvidence.facts.map((fact) => fact.observationId).slice(0, 3)).toEqual(historical.map((item) => item.id));
    expect(fullEvidence.trends.length).toBeGreaterThan(0);
    expect(fullEvidence.facts.map((fact) => fact.clinicalDate)).toContain('2023-06-10');
    expect(fullEvidence.facts.map((fact) => fact.clinicalDate)).toContain('2026-06-10');
    // 趋势中的点引用完整事实，日期不重复抄写。
    const knownFacts = new Set(fullEvidence.facts.map((fact) => fact.observationId));
    for (const trend of fullEvidence.trends) {
      expect((trend.payload as { points: Array<{ observationId: string }> }).points
        .every((point) => knownFacts.has(point.observationId))).toBe(true);
    }
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
    type WholeReportTarget = { documentId: string; targetSourceSpanIds: string[]; spans: Array<{ sourceSpanId: string; quote: string }> };
    const extractionFor = (source: WholeReportTarget): ExtractionResult => {
      const span = source.spans.find((item) => source.targetSourceSpanIds.includes(item.sourceSpanId))!;
      const value = span.quote.match(/LDL-C ([\d.]+)/)![1]!;
      return {
        schemaVersion: 1, documentId: source.documentId,
        coveredSourceSpanIds: source.targetSourceSpanIds,
        subject: { reportedName: null, evidence: [], confidence: 'absent' },
        candidates: [{ localKey: 'ldl', originalName: 'LDL-C', standardNameCandidate: 'LDL-C',
          value: { kind: 'numeric', rawText: value, decimal: value, comparator: 'eq' },
          unitRaw: 'mmol/L', referenceRangeRaw: null, reportedAbnormalFlag: null,
          specimen: null, method: null, bodySite: null, clinicalDate: '2026-09-21',
          evidence: [{ sourceSpanId: span.sourceSpanId, quote: span.quote }], clinicalContext: { version: 1 as const, status: 'complete' as const, conditions: [] }, issues: [] }]
      };
    };
    const failingRuntime = {
      getState: () => connectedState,
      runStructuredTurn: async (input: { prompt: string }) => {
        const source = parsePromptValue<WholeReportTarget>(
          input.prompt, 'SOURCE_PACKAGE');
        expect(source.spans).toHaveLength(41);
        firstChunks.push(source.targetSourceSpanIds.length);
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
          const source = parsePromptValue<WholeReportTarget>(
            input.prompt, 'SOURCE_PACKAGE');
          expect(source.spans).toHaveLength(41);
          retryChunks.push(source.targetSourceSpanIds.length);
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

  it('目录自动归属有身份冲突时只隔离该资料，其他资料仍参与一次成员综合', async () => {
    const root = mkdtempSync(join(tmpdir(), 'family-health-runner-partial-review-'));
    roots.push(root);
    const service = new PersonalWorkspaceService(root, '测试工作区', () => new Date('2026-09-18T00:00:00Z'));
    const personId = service.ensurePrimaryMember({ displayName: '测试成员', relation: '本人' });
    await service.importFiles([
      { path: '/tmp/虚构待核对报告一.txt', bytes: Buffer.from('姓名：另一人 2026-09-17 LDL-C 4.1 mmol/L') },
      { path: '/tmp/虚构清晰报告二.txt', bytes: Buffer.from('2026-09-17 LDL-C 4.2 mmol/L') }
    ], personId);
    const assignmentDatabase = new Database(service.store.databasePath);
    try { assignmentDatabase.prepare("UPDATE documents SET person_assignment_basis = 'folder_binding'").run(); }
    finally { assignmentDatabase.close(); }
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
              evidence: [{ sourceSpanId: span.sourceSpanId, quote: span.quote }], clinicalContext: { version: 1 as const, status: 'complete' as const, conditions: [] }, issues: []
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
    expect(service.store.listStoredJobs()[0]).toMatchObject({ status: 'completed_with_issues', completedUnits: 2, totalUnits: 2 });
    expect(service.store.isDocumentCommitted(conflictDocumentId!)).toBe(false);
    expect(service.store.isDocumentCommitted(clearDocumentId!)).toBe(true);
    expect(service.store.listAcceptedObservations(personId)).toHaveLength(1);
    expect(service.store.listMemberAssessmentSnapshots(personId, true)).toHaveLength(1);
    service.close();
  });

  it.each(['extract', 'analyze'] as const)('只中断本应用当前 turn，并把任务确认成 cancelled（%s 入口）', async (stage) => {
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
    if (stage === 'analyze') retryLegacyFailure(service, stage);
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

  it.each(['extract', 'analyze'] as const)('取消后即使迟到的 AI 结果返回成功也不得落库（%s 入口）', async (stage) => {
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
    if (stage === 'analyze') retryLegacyFailure(service, stage);
    let resolveTurn!: (value: { threadId: string; turnId: string; output: ExtractionResult }) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const extraction: ExtractionResult = {
      schemaVersion: 1, documentId, subject: { reportedName: null, evidence: [], confidence: 'absent' }, coveredSourceSpanIds: [spanId],
      candidates: [{
        localKey: 'ldl-late', originalName: 'LDL-C', standardNameCandidate: 'LDL-C',
        value: { kind: 'numeric', rawText: '4.2', decimal: '4.2', comparator: 'eq' }, unitRaw: 'mmol/L',
        referenceRangeRaw: null, reportedAbnormalFlag: null, specimen: null, method: null, bodySite: null,
        clinicalDate: null, evidence: [{ sourceSpanId: spanId, quote: 'LDL-C 4.2 mmol/L' }], clinicalContext: { version: 1 as const, status: 'complete' as const, conditions: [] }, issues: []
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
