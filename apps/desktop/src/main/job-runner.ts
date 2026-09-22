import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { WorkspaceStore } from '@storage';
import { stableHash } from '@core';
import { DEFAULT_AI_PREFERENCES, type AiPreferences } from '@contracts';
import { CodexRuntimeManager } from './codex-runtime.js';
import { MemberAssessmentPipeline } from './member-assessment-pipeline.js';
import { DocumentExtractionPipeline } from './processing-pipeline.js';

type LeanTurnStage = 'P01' | 'P02' | 'P03' | 'P04' | 'other';

function classifyLeanTurn(prompt: string): LeanTurnStage {
  // 只看模板边界，不扫描 JSON 数据里的用户原文，避免资料内嵌文本冒充阶段。
  if (prompt.includes('\nREPAIR_REQUEST=')) return 'P03';
  if (prompt.includes('\nREVIEW_REQUEST=')) return 'P04';
  if (prompt.includes('\nASSESSMENT_REQUEST=')) return 'P02';
  if (prompt.includes('\nTARGET_MEMBER=')) return 'P01';
  return 'other';
}

function emptyTurnCounts(): Record<LeanTurnStage, number> {
  return { P01: 0, P02: 0, P03: 0, P04: 0, other: 0 };
}

export class ProcessingJobRunner extends EventEmitter {
  private running = false;
  private readonly leaseOwner = `desktop-${randomUUID()}`;

  constructor(
    private readonly runtime: CodexRuntimeManager,
    private readonly getAiPreferences: () => AiPreferences = () => DEFAULT_AI_PREFERENCES
  ) {
    super();
  }

  async cancelJob(store: WorkspaceStore, jobId: string): Promise<{ running: boolean; alreadyTerminal: boolean }> {
    const result = store.requestJobCancellation(jobId);
    this.emit('changed');
    if (result.running) await this.runtime.interruptActiveTurn();
    return result;
  }

  async runAvailableJobs(store: WorkspaceStore): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (true) {
        const account = this.runtime.getState();
        if (account.status !== 'connected' || !account.displayLabel) return;
        const accountFingerprint = stableHash({ provider: 'codex-chatgpt', displayLabel: account.displayLabel });
        const job = store.claimNextQueuedJob(this.leaseOwner, accountFingerprint);
        if (!job) return;
        this.emit('changed');
        if (account.quota.status === 'exhausted') {
          store.finishJob(job.id, 'waiting_quota');
          this.emit('changed');
          continue;
        }
        // 每个任务领取时冻结模型设置，避免用户在处理中修改设置导致同一任务混用模型。
        const aiPreferences = structuredClone(this.getAiPreferences());
        const attemptId = store.startJobAttempt(job.id, account.runtimeVersion, aiPreferences.modelId, aiPreferences.reasoningEffort);
        const attemptStartedAtMs = Date.now();
        const turnUsage = {
          attemptedTurnRequests: emptyTurnCounts(), completedTurnResponses: emptyTurnCounts(),
          failedTurnRequests: emptyTurnCounts(), timedOutTurnRequests: emptyTurnCounts(),
          completedTurnDurationMs: emptyTurnCounts(), observedTurnMetrics: 0,
          webToolActions: { searches: 0, pageOpens: 0, pageFinds: 0, other: 0 },
          observedTokenUsage: 0,
          inputTokens: null as number | null, outputTokens: null as number | null,
          cachedInputTokens: null as number | null,
          firstUsableFactMs: null as number | null, attemptDurationMs: 0
        };
        const jobRuntime = {
          runStructuredTurn: async <T>(input: Omit<Parameters<CodexRuntimeManager['runStructuredTurn']>[0], 'aiPreferences'>) => {
            const stage = classifyLeanTurn(input.prompt);
            turnUsage.attemptedTurnRequests[stage] += 1;
            try {
              const result = await this.runtime.runStructuredTurn<T>({ ...input, aiPreferences });
              turnUsage.completedTurnResponses[stage] += 1;
              if (result.metrics) {
                turnUsage.observedTurnMetrics += 1;
                turnUsage.completedTurnDurationMs[stage] += result.metrics.durationMs;
                turnUsage.webToolActions.searches += result.metrics.webSearches;
                turnUsage.webToolActions.pageOpens += result.metrics.webPageOpens;
                turnUsage.webToolActions.pageFinds += result.metrics.webPageFinds;
                turnUsage.webToolActions.other += result.metrics.webSearchOtherActions;
                if (Number.isFinite(result.metrics.inputTokens) && Number.isFinite(result.metrics.outputTokens)
                  && Number.isFinite(result.metrics.cachedInputTokens)) {
                  turnUsage.observedTokenUsage += 1;
                  turnUsage.inputTokens = (turnUsage.inputTokens ?? 0) + (result.metrics.inputTokens ?? 0);
                  turnUsage.outputTokens = (turnUsage.outputTokens ?? 0) + (result.metrics.outputTokens ?? 0);
                  turnUsage.cachedInputTokens = (turnUsage.cachedInputTokens ?? 0) + (result.metrics.cachedInputTokens ?? 0);
                }
              }
              return result;
            } catch (error) {
              turnUsage.failedTurnRequests[stage] += 1;
              if (error instanceof Error && error.message === 'CODEX_TURN_TIMEOUT') turnUsage.timedOutTurnRequests[stage] += 1;
              throw error;
            }
          }
        };
        const executionGuard = {
          jobId: job.id,
          attemptId,
          consentId: job.consentId,
          accountFingerprint
        };
        try {
          const pipeline = new DocumentExtractionPipeline(store, jobRuntime, executionGuard);
          const resumeAnalysis = ['analyze', 'guidance', 'review_derived', 'system_analysis', 'system_review', 'publish'].includes(job.stage);
          let completedUnits = resumeAnalysis ? job.documentIds.length : 0;
          let needsReview = false;
          let hasAssessmentRejection = false;
          let lastReceipt: { threadId: string; turnId: string } | null = null;
          if (!resumeAnalysis) {
            for (const documentId of job.documentIds) {
              store.assertJobExecutionActive(executionGuard, documentId);
              if (store.hasOpenBlockingReview(documentId)) {
                needsReview = true;
                completedUnits += 1;
                store.updateJobProgress(job.id, completedUnits);
                this.emit('changed');
                continue;
              }
              if (store.isDocumentCommitted(documentId) || store.isDocumentExcluded(documentId)) {
                completedUnits += 1;
                store.updateJobProgress(job.id, completedUnits);
                this.emit('changed');
                continue;
              }
              const result = await pipeline.process(documentId);
              if (turnUsage.firstUsableFactMs === null && result.status === 'published' && result.candidateCount > 0) {
                turnUsage.firstUsableFactMs = Math.max(0, Date.now() - attemptStartedAtMs);
              }
              if (result.threadId && result.turnId) lastReceipt = { threadId: result.threadId, turnId: result.turnId };
              completedUnits += 1;
              store.updateJobProgress(job.id, completedUnits);
              this.emit('changed');
              if (store.isJobCancellationRequested(job.id)) throw new Error('JOB_CANCELLED');
              if (result.status === 'needs_review') {
                needsReview = true;
                // 仅隔离该份资料；同批其余已接纳事实仍可参与成员综合。
                continue;
              }
            }
          }
          if (store.isJobCancellationRequested(job.id)) throw new Error('JOB_CANCELLED');
          const assessment = await new MemberAssessmentPipeline(
            store, jobRuntime, (stage) => {
              store.updateJobStage(job.id, stage);
              this.emit('changed');
            }, executionGuard, job.documentIds[0]!,
            aiPreferences.modelId, aiPreferences.reasoningEffort
          ).process(job.personId);
          if ('threadId' in assessment && assessment.threadId && assessment.turnId) {
            lastReceipt = { threadId: assessment.threadId, turnId: assessment.turnId };
          }
          if (assessment.status === 'rejected') hasAssessmentRejection = true;
          if (store.isJobCancellationRequested(job.id)) throw new Error('JOB_CANCELLED');
          const finalStatus = needsReview ? 'waiting_user' : hasAssessmentRejection ? 'completed_with_issues' : 'succeeded';
          if (!needsReview) store.updateJobStage(job.id, 'publish');
          store.finishJob(job.id, finalStatus);
          turnUsage.attemptDurationMs = Math.max(0, Date.now() - attemptStartedAtMs);
          if (turnUsage.observedTokenUsage !== Object.values(turnUsage.completedTurnResponses).reduce((a, b) => a + b, 0)) {
            turnUsage.inputTokens = turnUsage.outputTokens = turnUsage.cachedInputTokens = null;
          }
          store.finishJobAttempt({ attemptId, status: finalStatus, ...lastReceipt, usage: turnUsage });
          this.emit('terminal', { jobId: job.id, status: finalStatus });
        } catch (error) {
          const code = error instanceof Error ? error.message : 'JOB_FAILED';
          const state = this.runtime.getState();
          const status = store.isJobCancellationRequested(job.id)
            ? 'cancelled'
            : code.includes('CONSENT') || code.includes('DOCUMENT_OUTSIDE_CONSENT_SCOPE')
              ? 'waiting_user'
            : state.status !== 'connected' || code.includes('AUTH')
            ? 'waiting_auth'
            : state.quota.status === 'exhausted' || code.includes('QUOTA')
              ? 'waiting_quota'
              : 'failed';
          store.finishJob(job.id, status);
          turnUsage.attemptDurationMs = Math.max(0, Date.now() - attemptStartedAtMs);
          if (turnUsage.observedTokenUsage !== Object.values(turnUsage.completedTurnResponses).reduce((a, b) => a + b, 0)) {
            turnUsage.inputTokens = turnUsage.outputTokens = turnUsage.cachedInputTokens = null;
          }
          store.finishJobAttempt({ attemptId, status, errorCode: code, usage: turnUsage });
          this.emit('terminal', { jobId: job.id, status });
        }
        this.emit('changed');
      }
    } finally {
      this.running = false;
    }
  }
}
