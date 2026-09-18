import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { WorkspaceStore } from '@storage';
import { stableHash } from '@core';
import { CodexRuntimeManager } from './codex-runtime.js';
import { DerivedHealthPipeline } from './derived-pipeline.js';
import { DocumentExtractionPipeline } from './processing-pipeline.js';

export class ProcessingJobRunner extends EventEmitter {
  private running = false;
  private readonly leaseOwner = `desktop-${randomUUID()}`;

  constructor(private readonly runtime: CodexRuntimeManager) {
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
        const attemptId = store.startJobAttempt(job.id, account.runtimeVersion);
        const executionGuard = {
          jobId: job.id,
          attemptId,
          consentId: job.consentId,
          accountFingerprint
        };
        try {
          const pipeline = new DocumentExtractionPipeline(store, this.runtime, executionGuard);
          const resumeDerived = ['analyze', 'guidance', 'review_derived', 'publish'].includes(job.stage);
          let completedUnits = resumeDerived ? job.documentIds.length : 0;
          let needsReview = false;
          let lastReceipt: { threadId: string; turnId: string } | null = null;
          if (!resumeDerived) {
            for (const documentId of job.documentIds) {
              store.assertJobExecutionActive(executionGuard, documentId);
              if (store.isDocumentCommitted(documentId)) {
                completedUnits += 1;
                store.updateJobProgress(job.id, completedUnits);
                this.emit('changed');
                continue;
              }
              const result = await pipeline.process(documentId);
              if (result.threadId && result.turnId) lastReceipt = { threadId: result.threadId, turnId: result.turnId };
              completedUnits += 1;
              store.updateJobProgress(job.id, completedUnits);
              this.emit('changed');
              if (store.isJobCancellationRequested(job.id)) throw new Error('JOB_CANCELLED');
              if (result.status === 'needs_review') {
                needsReview = true;
                break;
              }
            }
          }
          if (!needsReview) {
            if (store.isJobCancellationRequested(job.id)) throw new Error('JOB_CANCELLED');
            const derived = await new DerivedHealthPipeline(store, this.runtime, (stage) => {
              store.updateJobStage(job.id, stage);
              this.emit('changed');
            }, executionGuard, job.documentIds[0]!).process(job.personId);
            if (derived.threadId && derived.turnId) lastReceipt = { threadId: derived.threadId, turnId: derived.turnId };
            if (derived.status === 'needs_review') needsReview = true;
          }
          if (store.isJobCancellationRequested(job.id)) throw new Error('JOB_CANCELLED');
          const finalStatus = needsReview ? 'waiting_user' : 'succeeded';
          store.finishJob(job.id, finalStatus);
          store.finishJobAttempt({ attemptId, status: finalStatus, ...lastReceipt });
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
          store.finishJobAttempt({ attemptId, status, errorCode: code });
          this.emit('terminal', { jobId: job.id, status });
        }
        this.emit('changed');
      }
    } finally {
      this.running = false;
    }
  }
}
