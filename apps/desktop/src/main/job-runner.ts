import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { WorkspaceStore } from '@storage';
import { stableHash } from '@core';
import { DEFAULT_AI_PREFERENCES, type AiPreferences, type JobAssessmentOutcome } from '@contracts';
import { CodexRuntimeManager } from './codex-runtime.js';
import { MemberAssessmentPipeline, type AssessmentRepairDiagnostic } from './member-assessment-pipeline.js';
import { DirectOriginalExtractionPipeline } from './direct-original-extraction.js';
import { getCodexTurnFailureDetails } from './codex-turn-failure.js';
import { localResourceFailureCode } from './local-resource-failure.js';
import { createReportFinalizationGate, MAX_PARALLEL_REPORT_READS, runBoundedReportTasks } from './report-read-scheduler.js';
import { MAX_MODEL_TURN_CONCURRENCY } from './model-turn-scheduler.js';
import type { OfficialKnowledgeTransport } from './official-knowledge-retrieval.js';

type LeanTurnStage = 'P01' | 'P02' | 'P03' | 'P04' | 'other';

// 报告原件读取统一使用用户明确选择的模型，不再经过本机 OCR 提取链路。
export const EXTRACTION_AI_PREFERENCES: AiPreferences = { modelId: 'gpt-6.1-sol', reasoningEffort: 'medium' };

function classifyLeanTurn(prompt: string): LeanTurnStage {
  // 只看模板边界，不扫描 JSON 数据里的用户原文，避免资料内嵌文本冒充阶段。
  if (prompt.startsWith('# DIRECT_ORIGINAL_P03\n') || prompt.includes('\nREPAIR_REQUEST=')) return 'P03';
  if (prompt.includes('\nREVIEW_REQUEST=')) return 'P04';
  if (prompt.includes('\nASSESSMENT_REQUEST=')) return 'P02';
  if (prompt.startsWith('# DIRECT_ORIGINAL_P01\n') || prompt.includes('\nTARGET_MEMBER=')) return 'P01';
  return 'other';
}

function emptyTurnCounts(): Record<LeanTurnStage, number> {
  return { P01: 0, P02: 0, P03: 0, P04: 0, other: 0 };
}

/** 同批多份失败时优先保护本机存储和执行授权，不能由可重试的繁忙吞掉其他故障。 */
function selectReportFailure(errors: readonly unknown[]): unknown {
  const priority = (error: unknown): number => {
    if (localResourceFailureCode(error)) return 5;
    const failure = getCodexTurnFailureDetails(error);
    const code = failure?.code ?? (error instanceof Error ? error.message : 'JOB_FAILED');
    if (code === 'JOB_CANCELLED' || /CONSENT|OUTSIDE_CONSENT_SCOPE|AUTH/.test(code)) return 4;
    if (/QUOTA|RATE_LIMIT|REQUEST_LIMIT/.test(code) || failure?.httpStatus === 429) return 3;
    return failure?.modelBusy ? 1 : 2;
  };
  return errors.reduce((selected, error) => priority(error) > priority(selected) ? error : selected);
}

/** 仅把程序原因归为固定类别；不持久化模型句子、目标名称或原始异常。 */
function assessmentReasonCode(reason: string): NonNullable<JobAssessmentOutcome['reasonCode']> {
  const codes = reason.split(',').map((item) => item.split(':')[0]!);
  if (codes.some((code) => /schema_invalid$/i.test(code))) return 'schema_invalid';
  if (codes.some((code) => /(?:scope|binding|revision|signature|reference|evidence)_mismatch$/i.test(code)
    || /(?:scope|revision)_conflict$/i.test(code))) return 'scope_mismatch';
  if (codes.some((code) => /coverage/i.test(code))) return 'coverage_incomplete';
  if (codes.some((code) => /^focused_/i.test(code))) return 'focused_review_failed';
  if (codes.some((code) => /^publication_/i.test(code))) return 'publication_failed';
  if (codes.some((code) => /^(?:assessment_|documented_|criteria_|unsupported_|unsourced_|unknown_|duplicate_|personal_|diagnostic_|high_impact_|lifestyle_|general_lifestyle_|action_|claim_|direct_medication_|overview_missing_)/.test(code))) {
    return 'validation_failed';
  }
  return 'unknown';
}

export class ProcessingJobRunner extends EventEmitter {
  private running = false;
  private stopped = false;
  private dispatchStopped = false;
  private dispatchFailureCode: string | null = null;
  private readonly activeJobIds = new Set<string>();
  // 写满时连失败回执也可能无法落盘；本进程熔断，不能由定时器或账户事件自动重发。
  private stoppedForLocalStorageFull = false;
  private readonly leaseOwner = `desktop-${randomUUID()}`;

  constructor(
    private readonly runtime: CodexRuntimeManager,
    private readonly getAiPreferences: () => AiPreferences = () => DEFAULT_AI_PREFERENCES,
    private readonly concurrencyOptions: { reportReads?: number; memberJobs?: number } = {},
    private readonly knowledgeTransport?: OfficialKnowledgeTransport
  ) {
    super();
    for (const value of [concurrencyOptions.reportReads ?? MAX_PARALLEL_REPORT_READS,
      concurrencyOptions.memberJobs ?? MAX_MODEL_TURN_CONCURRENCY]) {
      if (!Number.isInteger(value) || value < 1 || value > MAX_MODEL_TURN_CONCURRENCY) {
        throw new Error('JOB_CONCURRENCY_INVALID');
      }
    }
  }

  async cancelJob(store: WorkspaceStore, jobId: string): Promise<{ running: boolean; alreadyTerminal: boolean }> {
    const result = store.requestJobCancellation(jobId);
    this.emit('changed');
    if (result.running) await this.runtime.interruptActiveTurn({ jobId });
    return result;
  }

  /** 工作区关闭前先失效执行代际，迟到回执不得再访问已关闭的数据库。 */
  shutdown(): void {
    this.stopped = true;
    for (const jobId of this.activeJobIds) void this.runtime.interruptActiveTurn({ jobId }).catch(() => undefined);
  }

  async runAvailableJobs(store: WorkspaceStore): Promise<void> {
    if (this.running || this.stopped || this.stoppedForLocalStorageFull) return;
    this.running = true;
    this.dispatchStopped = false;
    this.dispatchFailureCode = null;
    try {
      const worker = async () => {
      try {
      while (true) {
        if (this.stopped || this.dispatchStopped || this.stoppedForLocalStorageFull) return;
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
        this.activeJobIds.add(job.id);
        // 每个任务领取时冻结模型设置，避免用户在处理中修改设置导致同一任务混用模型。
        const analysisAiPreferences = structuredClone(job.modelBusyRetry?.analysisAiPreferences
          ?? job.phaseAnalysisAiPreferences ?? this.getAiPreferences());
        const assessmentOnly = store.isAssessmentOnlyJob(job.id);
        const resumingDerivedStage = ['analyze', 'guidance', 'review_derived', 'system_analysis', 'system_review', 'publish'].includes(job.stage);
        const explicitRepairDocumentIds = store.getJobRepairDocumentIds(job.id);
        const extractionWarningDocumentIds = new Set((assessmentOnly ? [] : store.listOpenExtractionReviewIssues())
          .filter((issue) => issue.severity === 'warning' && issue.stage === 'extract')
          .map((issue) => issue.documentId));
        // 逐份完成记录优先于“仍有警告”：已走完的报告不因未纳入提示而重复提取。
        // 旧任务只由存储层结合该次调用和提交证据恢复，不能盲信旧完成数。
        const processedDocumentIds = store.getJobProcessedDocumentIds(job.id);
        // 旧任务可能在进入分析阶段后仍留有未提交资料；阶段和旧完成数不能替代逐份提交状态。
        const pendingDocumentIds = new Set((assessmentOnly ? [] : job.documentIds).filter((documentId) => (
          !processedDocumentIds.has(documentId)
          &&
          !store.hasOpenBlockingReview(documentId)
          && !store.isDocumentExcluded(documentId)
          && (!store.isDocumentCommitted(documentId)
            || (!resumingDerivedStage && (explicitRepairDocumentIds.has(documentId) || extractionWarningDocumentIds.has(documentId))))
        )));
        let activeAiPreferences = pendingDocumentIds.size > 0 ? EXTRACTION_AI_PREFERENCES : analysisAiPreferences;
        // 同批含提取与分析时，尝试记录先标识提取模型；综合快照另记实际分析模型。
        const attemptId = store.startJobAttempt(job.id, account.runtimeVersion, activeAiPreferences.modelId, activeAiPreferences.reasoningEffort);
        const attemptStartedAtMs = Date.now();
        let reportReadBusyFailure: unknown = null;
        const turnUsage = {
          attemptedTurnRequests: emptyTurnCounts(), completedTurnResponses: emptyTurnCounts(),
          failedTurnRequests: emptyTurnCounts(), timedOutTurnRequests: emptyTurnCounts(),
          completedTurnDurationMs: emptyTurnCounts(), observedTurnMetrics: 0,
          // sending 回执表示已登记调用意图；实际获得名额与模型耗时由 runtime 单独计量。
          completedTurnQueueWaitMs: emptyTurnCounts(), completedTurnRuntimeSetupMs: emptyTurnCounts(),
          completedModelDurationMs: emptyTurnCounts(), completedTurnTotalDurationMs: emptyTurnCounts(),
          observedSeparatedTimingMetrics: 0, turnTimingVersion: 2,
          webToolActions: { searches: 0, pageOpens: 0, pageFinds: 0, other: 0 },
          observedTokenUsage: 0,
          inputTokens: null as number | null, outputTokens: null as number | null,
          cachedInputTokens: null as number | null,
          firstUsableFactMs: null as number | null, attemptDurationMs: 0,
          safeRuntimeFailure: null as {
            code: string; safeReason: string; modelId: string; reasoningEffort: string;
            serviceCode?: string; httpStatus?: number;
          } | null,
          // 仅保存范围/校验元数据；不存模型原文，区分格式失败与仍未成立的医学主张。
          memberAssessmentRepairDiagnostics: [] as AssessmentRepairDiagnostic[],
          memberAssessmentFocusedReviewDiagnostics: [] as Array<{ targetId: string; verdict: 'pass' | 'replace' | 'hold';
            outcome: 'retained' | 'held' | 'dependency_repaired' | 'dependency_held' }>,
          memberAssessmentOutcome: null as JobAssessmentOutcome | null
        };
        const assertCurrentAccount = () => {
          if (this.stopped) throw new Error('JOB_RUNNER_STOPPED');
          if (this.stoppedForLocalStorageFull) throw new Error('LOCAL_STORAGE_FULL');
          const current = this.runtime.getState();
          if (current.status !== 'connected' || !current.displayLabel) throw new Error('CODEX_AUTH_REQUIRED');
          if (stableHash({ provider: 'codex-chatgpt', displayLabel: current.displayLabel }) !== accountFingerprint) {
            throw new Error('JOB_AUTH_ACCOUNT_CHANGED');
          }
        };
        const jobRuntime = {
          runStructuredTurn: async <T>(input: Omit<Parameters<CodexRuntimeManager['runStructuredTurn']>[0], 'aiPreferences'>) => {
            assertCurrentAccount();
            store.assertJobExecutionActive(executionGuard);
            if (this.dispatchFailureCode) throw new Error(this.dispatchFailureCode);
            const stage = classifyLeanTurn(input.prompt);
            if (reportReadBusyFailure && (stage === 'P01' || stage === 'P03')) throw reportReadBusyFailure;
            turnUsage.attemptedTurnRequests[stage] += 1;
            try {
              // 请求绑定完整输入与真实图片内容，不以临时路径、相似提示词或旧成员版本复用回执。
              const imageHashes = (input.imagePaths ?? []).map(path => createHash('sha256').update(readFileSync(path)).digest('hex'));
              const operationKey = stableHash({ stage, images: imageHashes });
              const recoverySignature = stableHash({ version: 1, jobId: job.id, consentId: job.consentId,
                accountFingerprint, aiPreferences: activeAiPreferences, stage, prompt: input.prompt,
                outputSchema: input.outputSchema, allowWebSearch: input.allowWebSearch === true,
                images: imageHashes });
              const result = await this.runtime.runStructuredTurn<T>({ ...input, aiPreferences: activeAiPreferences,
                expectedAccountFingerprint: accountFingerprint,
                runScope: { jobId: job.id, attemptId },
                recovery: {
                  read: () => store.getRuntimeTurnRecovery(executionGuard, recoverySignature, operationKey),
                  save: state => store.saveRuntimeTurnRecovery(executionGuard, recoverySignature, state, operationKey),
                  diagnostic: event => store.recordRuntimeRecoveryDiagnostic(executionGuard, recoverySignature, event),
                  lateReceipt: (threadId, turnId) => store.saveRuntimeLateStartReceipt(executionGuard, recoverySignature, threadId, turnId)
                },
                assertExecutionActive: () => { assertCurrentAccount(); store.assertJobExecutionActive(executionGuard); },
                assertRequestAllowed: () => {
                  if (this.dispatchFailureCode) throw new Error(this.dispatchFailureCode);
                  if (this.runtime.getState().quota.status === 'exhausted') throw new Error('CODEX_QUOTA_EXHAUSTED');
                  if (reportReadBusyFailure && (stage === 'P01' || stage === 'P03')) throw reportReadBusyFailure;
                },
                onRequestFailure: (error) => {
                  const failure = getCodexTurnFailureDetails(error);
                  if (failure?.modelBusy && activeAiPreferences === EXTRACTION_AI_PREFERENCES) reportReadBusyFailure ??= error;
                  const localCode = localResourceFailureCode(error);
                  if (localCode || failure?.httpStatus === 429
                    || ['CODEX_QUOTA_EXHAUSTED', 'CODEX_RATE_LIMITED', 'CODEX_REQUEST_LIMITED_UNKNOWN'].includes(failure?.code ?? '')) {
                    this.dispatchStopped = true;
                    // 明确瞬时限流只由真实失败的任务消费重试预算。其他已排队请求仍受
                    // 全局降档/冷却和实际额度检查，不能用广播错误伪造它们也被服务拒绝。
                    if (localCode || failure?.code !== 'CODEX_RATE_LIMITED') {
                      this.dispatchFailureCode = localCode ?? failure?.code ?? 'CODEX_REQUEST_LIMITED_UNKNOWN';
                    }
                  }
                } });
              assertCurrentAccount();
              store.assertJobExecutionActive(executionGuard);
              turnUsage.completedTurnResponses[stage] += 1;
              if (result.metrics) {
                turnUsage.observedTurnMetrics += 1;
                turnUsage.completedTurnDurationMs[stage] += result.metrics.durationMs;
                if (result.metrics.timingVersion === 2 && result.metrics.queueWaitMs !== undefined
                  && result.metrics.runtimeSetupMs !== undefined && result.metrics.modelDurationMs !== undefined
                  && result.metrics.totalDurationMs !== undefined) {
                  turnUsage.observedSeparatedTimingMetrics += 1;
                  turnUsage.completedTurnQueueWaitMs[stage] += result.metrics.queueWaitMs;
                  turnUsage.completedTurnRuntimeSetupMs[stage] += result.metrics.runtimeSetupMs;
                  turnUsage.completedModelDurationMs[stage] += result.metrics.modelDurationMs;
                  turnUsage.completedTurnTotalDurationMs[stage] += result.metrics.totalDurationMs;
                }
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
              const failure = getCodexTurnFailureDetails(error);
              if (failure?.modelBusy && activeAiPreferences === EXTRACTION_AI_PREFERENCES) reportReadBusyFailure ??= error;
              if (failure?.httpStatus === 429
                || ['CODEX_QUOTA_EXHAUSTED', 'CODEX_RATE_LIMITED', 'CODEX_REQUEST_LIMITED_UNKNOWN'].includes(failure?.code ?? '')) {
                this.dispatchStopped = true;
                if (failure?.code !== 'CODEX_RATE_LIMITED') {
                  this.dispatchFailureCode = failure?.code ?? 'CODEX_REQUEST_LIMITED_UNKNOWN';
                }
              }
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
          let completedUnits = job.documentIds.length - pendingDocumentIds.size;
          let hasContentGaps = false;
          let hasAssessmentRejection = false;
          const lastReceipt: { current: { threadId: string; turnId: string } | null } = { current: null };
          const completeDocument = (documentId: string, outcome: 'published' | 'partial' | 'needs_review' | 'excluded') => {
            if (processedDocumentIds.has(documentId)) return;
            store.markJobDocumentProcessed(job.id, documentId, outcome, executionGuard);
            processedDocumentIds.add(documentId);
            if (pendingDocumentIds.delete(documentId)) completedUnits += 1;
            store.updateJobProgress(job.id, completedUnits);
            this.emit('changed');
          };
          store.assertJobExecutionActive(executionGuard);
          if (assessmentOnly) {
            if (!['analyze', 'review_derived', 'publish'].includes(job.stage)) throw new Error('ASSESSMENT_ONLY_STAGE_INVALID');
            const anchorDocumentId = job.documentIds[0];
            const anchor = store.listImportedDocuments().find((document) => document.id === anchorDocumentId);
            if (job.documentIds.length !== 1 || !anchorDocumentId || anchor?.personId !== job.personId
              || !store.isDocumentCommitted(anchorDocumentId) || store.isDocumentExcluded(anchorDocumentId)
              || !store.listAcceptedObservations(job.personId).some((observation) => observation.documentId === anchorDocumentId)) {
              throw new Error('ASSESSMENT_ONLY_ANCHOR_INVALID');
            }
            completeDocument(anchorDocumentId, 'published');
          }
          if (pendingDocumentIds.size > 0) store.updateJobStage(job.id, 'extract');
          store.updateJobProgress(job.id, completedUnits);
          this.emit('changed');
          // 仅综合任务的锚点不经过提取器；即使任务续跑时原件状态变化，也只允许明确失败。
          const withSerializedFinalization = createReportFinalizationGate({ stopAfterFailure: true });
          const pipeline = assessmentOnly ? null : new DirectOriginalExtractionPipeline(store, jobRuntime, executionGuard,
            { withSerializedFinalization });
          // 读取槽位只是待执行上限；所有成员/阶段实际发给模型的并发由 runtime 自适应池统一裁定。
          // 原先“繁忙后本进程永远单路”的第二层降档已移除，有限持久重试预算保持不变。
          const concurrency = this.concurrencyOptions.reportReads ?? MAX_PARALLEL_REPORT_READS;
          const processDocument = async (documentId: string) => {
            if (reportReadBusyFailure) throw reportReadBusyFailure;
            store.assertJobExecutionActive(executionGuard, documentId);
            if (processedDocumentIds.has(documentId)) return;
            if (store.hasOpenBlockingReview(documentId)) {
              hasContentGaps = true;
              completeDocument(documentId, 'partial');
              return;
            }
            if (store.isDocumentExcluded(documentId)) {
              completeDocument(documentId, 'excluded');
              return;
            }
            if (store.isDocumentCommitted(documentId)
              && (resumingDerivedStage || !explicitRepairDocumentIds.has(documentId) && !extractionWarningDocumentIds.has(documentId))
              && !store.isDateCorrectionJob(job.id)) {
              // 派生阶段不重新读取；明确重核的提取任务不能被“已完成且无警告”短路。
              completeDocument(documentId, 'published');
              return;
            }
            const result = await pipeline!.process(documentId);
            if (turnUsage.firstUsableFactMs === null
              && (result.status === 'published' || result.status === 'partial') && result.candidateCount > 0) {
              turnUsage.firstUsableFactMs = Math.max(0, Date.now() - attemptStartedAtMs);
            }
            if (result.threadId && result.turnId) lastReceipt.current = { threadId: result.threadId, turnId: result.turnId };
            completeDocument(documentId, result.status);
            if (store.isJobCancellationRequested(job.id)) throw new Error('JOB_CANCELLED');
            if (result.status === 'needs_review') {
              hasContentGaps = true;
              // 仅隔离该份资料；同批其余已接纳事实仍可参与成员综合。
              return;
            }
            if (result.status === 'partial') hasContentGaps = true;
          };
          // 上次乱序完成的报告可能已存 P03 证明但尚未提交。先独占恢复它，不能按原列表
          // 让另一份先发布推进事实版本；这只是调度优先级，pipeline 仍完整验证所有证明。
          const proofResumeIds = assessmentOnly ? [] : store.getJobSourceRefinementResumeDocumentIds(executionGuard)
            .filter((documentId) => pendingDocumentIds.has(documentId) && !processedDocumentIds.has(documentId));
          for (const documentId of proofResumeIds) await processDocument(documentId);
          const proofResumeSet = new Set(proofResumeIds);
          await runBoundedReportTasks(assessmentOnly ? [] : job.documentIds.filter((id) => !proofResumeSet.has(id)),
            concurrency, processDocument, selectReportFailure);
          if (store.isJobCancellationRequested(job.id)) throw new Error('JOB_CANCELLED');
          if (store.isDateCorrectionJob(job.id) && !store.getDateCorrectionFactScopes(executionGuard, job.documentIds[0]!).appliedReceipt) {
            // 日期尚未双盲证实时保留既有综合，不能把仍有疑点的旧时间重新包装为新解读。
            store.finishJob(job.id, 'completed_with_issues');
            turnUsage.attemptDurationMs = Math.max(0, Date.now() - attemptStartedAtMs);
            store.finishJobAttempt({ attemptId, status: 'completed_with_issues', ...lastReceipt.current, usage: turnUsage });
            this.emit('terminal', { jobId: job.id, status: 'completed_with_issues' });
            this.emit('changed');
            continue;
          }
          // 断点续跑也要恢复既有内容缺口；延后综合不能把前一批误记为完整成功。
          hasContentGaps ||= !assessmentOnly && store.listOpenExtractionReviewIssues()
            .some((issue) => job.documentIds.includes(issue.documentId));
          if (store.shouldDeferAutomaticUploadAssessment(job.id)) {
            const status = hasContentGaps ? 'completed_with_issues' : 'succeeded';
            // 保存尚待综合的责任，而不是提前结清；后续批次取消也不会漏掉本批的新事实。
            store.deferAutomaticUploadAssessment(executionGuard);
            turnUsage.attemptDurationMs = Math.max(0, Date.now() - attemptStartedAtMs);
            store.finishJobAttempt({ attemptId, status, ...lastReceipt.current, usage: turnUsage });
            this.emit('changed');
            continue;
          }
          if (!assessmentOnly && !resumingDerivedStage && store.shouldYieldMemberAssessment(executionGuard)) {
            turnUsage.attemptDurationMs = Math.max(0, Date.now() - attemptStartedAtMs);
            if (turnUsage.observedTokenUsage !== Object.values(turnUsage.completedTurnResponses).reduce((a, b) => a + b, 0)) {
              turnUsage.inputTokens = turnUsage.outputTokens = turnUsage.cachedInputTokens = null;
            }
            if (store.yieldMemberAssessment({ guard: executionGuard, analysisAiPreferences, ...(lastReceipt.current ?? {}), usage: turnUsage })) {
              this.emit('changed');
              continue;
            }
          }
          activeAiPreferences = analysisAiPreferences;
          const assessment = await new MemberAssessmentPipeline(
            store, jobRuntime, (stage) => {
              store.updateJobStage(job.id, stage);
              this.emit('changed');
            }, executionGuard, job.documentIds[0]!,
            analysisAiPreferences.modelId, analysisAiPreferences.reasoningEffort,
            undefined, true, this.knowledgeTransport
          ).process(job.personId);
          if ('repairDiagnostics' in assessment && assessment.repairDiagnostics) {
            turnUsage.memberAssessmentRepairDiagnostics = assessment.repairDiagnostics;
          }
          if ('focusedReviewDiagnostics' in assessment && assessment.focusedReviewDiagnostics) {
            turnUsage.memberAssessmentFocusedReviewDiagnostics = assessment.focusedReviewDiagnostics;
          }
          if ('threadId' in assessment && assessment.threadId && assessment.turnId) {
            lastReceipt.current = { threadId: assessment.threadId, turnId: assessment.turnId };
          }
          if (assessment.status === 'rejected') hasAssessmentRejection = true;
          if (store.isJobCancellationRequested(job.id)) throw new Error('JOB_CANCELLED');
          if (assessment.inputSignature === undefined || assessment.factRevision === undefined
            || assessment.contextRevision === undefined || assessment.reviewScopeSignature === undefined) {
            throw new Error('JOB_ASSESSMENT_BINDING_MISSING');
          }
          turnUsage.memberAssessmentOutcome = store.updateJobAssessmentOutcome(executionGuard, {
            status: assessment.status === 'skipped'
              ? assessment.reason === 'signature_current' ? 'reused_current' : 'skipped_no_data'
              : assessment.status,
            reasonCode: assessment.status === 'rejected' ? assessmentReasonCode(assessment.reason)
              : assessment.status === 'skipped' && assessment.reason === 'no_accepted_facts' ? 'no_accepted_facts' : null,
            snapshotId: 'snapshotId' in assessment ? assessment.snapshotId ?? null : null,
            inputSignature: assessment.inputSignature,
            factRevision: assessment.factRevision,
            contextRevision: assessment.contextRevision,
            reviewScopeSignature: assessment.reviewScopeSignature
          });
          // 普通内容缺口不等于用户必须确认，也不能在继续后被伪装成全量成功。
          const openIssues = assessmentOnly ? [] : store.listOpenExtractionReviewIssues()
            .filter((issue) => job.documentIds.includes(issue.documentId));
          hasContentGaps ||= openIssues.length > 0;
          const finalStatus = hasAssessmentRejection || hasContentGaps ? 'completed_with_issues' : 'succeeded';
          store.updateJobStage(job.id, 'publish');
          store.finishJob(job.id, finalStatus);
          turnUsage.attemptDurationMs = Math.max(0, Date.now() - attemptStartedAtMs);
          if (turnUsage.observedTokenUsage !== Object.values(turnUsage.completedTurnResponses).reduce((a, b) => a + b, 0)) {
            turnUsage.inputTokens = turnUsage.outputTokens = turnUsage.cachedInputTokens = null;
          }
          store.finishJobAttempt({ attemptId, status: finalStatus, ...lastReceipt.current, usage: turnUsage });
          this.emit('terminal', { jobId: job.id, status: finalStatus });
        } catch (error) {
          if (this.stopped) return;
          const failure = getCodexTurnFailureDetails(error);
          if (failure) turnUsage.safeRuntimeFailure = {
            code: failure.code, safeReason: failure.safeReason,
            modelId: activeAiPreferences.modelId, reasoningEffort: activeAiPreferences.reasoningEffort,
            ...(failure.serviceCode ? { serviceCode: failure.serviceCode } : {}),
            ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus })
          };
          const runtimeFailureCode = localResourceFailureCode(error)
            ?? failure?.code ?? (error instanceof Error ? error.message : 'JOB_FAILED');
          let code = runtimeFailureCode;
          const isRequestLimitFailure = failure?.httpStatus === 429
            || ['CODEX_QUOTA_EXHAUSTED', 'CODEX_RATE_LIMITED', 'CODEX_REQUEST_LIMITED_UNKNOWN'].includes(code);
          let state = this.runtime.getState();
          let refreshedQuota = false;
          if (isRequestLimitFailure) {
            // 429 不等于额度耗尽。仅刷新一次账户状态，不用旧缓存猜原因，也不重发健康资料。
            try { state = await this.runtime.refreshAccount(); refreshedQuota = true; }
            catch { state = this.runtime.getState(); }
          }
          // 刷新或忙碌回执都不是恢复授权的理由；异步读取后再次检查取消、撤权及账户切换。
          if (failure?.modelBusy || isRequestLimitFailure) {
            try { store.assertJobExecutionActive(executionGuard); }
            catch (guardError) { code = guardError instanceof Error ? guardError.message : 'JOB_FAILED'; }
            if (code === runtimeFailureCode
              && state.status === 'connected' && state.displayLabel
              && stableHash({ provider: 'codex-chatgpt', displayLabel: state.displayLabel }) !== accountFingerprint) {
              code = 'JOB_AUTH_ACCOUNT_CHANGED';
            }
          }
          turnUsage.attemptDurationMs = Math.max(0, Date.now() - attemptStartedAtMs);
          if (turnUsage.observedTokenUsage !== Object.values(turnUsage.completedTurnResponses).reduce((a, b) => a + b, 0)) {
            turnUsage.inputTokens = turnUsage.outputTokens = turnUsage.cachedInputTokens = null;
          }
          const confirmedTemporaryLimit = code === 'CODEX_RATE_LIMITED' && failure?.code === 'CODEX_RATE_LIMITED' && refreshedQuota
            && (state.quota.status === 'available' || state.quota.status === 'low');
          if ((code === 'CODEX_MODEL_BUSY' && state.quota.status !== 'exhausted' || confirmedTemporaryLimit)
            && state.status === 'connected') {
            const retry = store.finishModelBusyAttempt({ guard: executionGuard, analysisAiPreferences,
              reasonCode: confirmedTemporaryLimit ? 'CODEX_RATE_LIMITED' : 'CODEX_MODEL_BUSY',
              ...(failure?.threadId ? { threadId: failure.threadId } : {}),
              ...(failure?.turnId ? { turnId: failure.turnId } : {}), usage: turnUsage });
            if (retry.status === 'failed') this.emit('terminal', { jobId: job.id, status: retry.status });
            this.emit('changed');
            continue;
          }
          const status = store.isJobCancellationRequested(job.id)
            ? 'cancelled'
            : code === 'LOCAL_STORAGE_FULL'
              ? 'failed'
            : code.includes('CONSENT') || code.includes('DOCUMENT_OUTSIDE_CONSENT_SCOPE')
              ? 'waiting_user'
            : state.status !== 'connected' || code.includes('AUTH')
            ? 'waiting_auth'
            : state.quota.status === 'exhausted' || code.includes('QUOTA')
              ? 'waiting_quota'
              : 'failed';
          store.finishJob(job.id, status);
          store.finishJobAttempt({ attemptId, status, errorCode: code,
            threadId: failure?.threadId ?? null, turnId: failure?.turnId ?? null, usage: turnUsage });
          this.emit('terminal', { jobId: job.id, status });
          if (code === 'LOCAL_STORAGE_FULL') {
            // 失败回执已可靠保存：只停止本轮领取，释放空间后的显式手动重试仍可使用同一进程。
            this.emit('changed');
            this.dispatchStopped = true;
            return;
          }
        } finally {
          this.activeJobIds.delete(job.id);
        }
        this.emit('changed');
      }
      } catch (error) {
        // 一路遇到本机写满立即停止新领取，另一路仍落定后才结束本次调度。
        if (localResourceFailureCode(error) !== null) this.stoppedForLocalStorageFull = true;
        throw error;
      }
      };
      // 成员 worker 不再把全局模型池锁死在两位成员。逐个让出事件循环后再领取，
      // 仍先检查停机/额度/写满；同成员由存储层的原子领取保护。
      const workers: Array<Promise<void>> = [];
      for (let index = 0; index < (this.concurrencyOptions.memberJobs ?? MAX_MODEL_TURN_CONCURRENCY); index += 1) {
        if (index > 0) await new Promise<void>((resolve) => setImmediate(resolve));
        if (this.stopped || this.dispatchStopped || this.stoppedForLocalStorageFull) break;
        const running = worker();
        // worker 可能在下一轮事件循环前快速拒绝；立即登记处理，最终仍统一选取失败原因。
        void running.catch(() => undefined);
        workers.push(running);
      }
      const settled = await Promise.allSettled(workers);
      const failures = settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length > 0) throw selectReportFailure(failures);
    } catch (error) {
      if (localResourceFailureCode(error) !== null) {
        this.stoppedForLocalStorageFull = true;
        // 只报告本机原因，不伪造数据库终态；即使 attempt 尚未建立或失败写入再次出错也能告知用户。
        this.emit('localStorageFull', { code: 'LOCAL_STORAGE_FULL' });
        return;
      }
      throw error;
    } finally {
      this.running = false;
    }
  }
}
