import { describe, expect, it } from 'vitest';
import { jobAssessmentOutcomeSchema, jobSummarySchema } from './index.js';

const base = {
  status: 'published', reasonCode: null, snapshotId: 'synthetic-snapshot',
  inputSignature: 'a'.repeat(64), factRevision: 2, contextRevision: 1,
  reviewScopeSignature: 'b'.repeat(64), attemptId: 'synthetic-attempt', updatedAt: '2026-10-15T00:00:00Z'
};

describe('成员综合独立任务终态契约', () => {
  it('四种终态使用受控结构，不能把跳过误称为发布', () => {
    for (const status of ['published', 'reused_current']) {
      expect(jobAssessmentOutcomeSchema.safeParse({ ...base, status }).success).toBe(true);
      expect(jobAssessmentOutcomeSchema.safeParse({ ...base, status, snapshotId: null }).success).toBe(false);
    }
    expect(jobAssessmentOutcomeSchema.safeParse({ ...base, status: 'skipped_no_data', snapshotId: null,
      reasonCode: 'no_accepted_facts' }).success).toBe(true);
    expect(jobAssessmentOutcomeSchema.safeParse({ ...base, status: 'rejected', snapshotId: null,
      reasonCode: 'validation_failed' }).success).toBe(true);
    expect(jobAssessmentOutcomeSchema.safeParse({ ...base, status: 'skipped_no_data' }).success).toBe(false);
    expect(jobAssessmentOutcomeSchema.safeParse({ ...base, status: 'rejected', snapshotId: null }).success).toBe(false);
  });

  it('拒绝自由正文、伪签名和不一致原因；旧任务摘要仍兼容', () => {
    expect(jobAssessmentOutcomeSchema.safeParse({ ...base, reasonCode: '私人报告正文' }).success).toBe(false);
    expect(jobAssessmentOutcomeSchema.safeParse({ ...base, detail: '私人报告正文' }).success).toBe(false);
    expect(jobAssessmentOutcomeSchema.safeParse({ ...base, inputSignature: 'not-a-signature' }).success).toBe(false);
    expect(jobAssessmentOutcomeSchema.safeParse({ ...base, factRevision: -1 }).success).toBe(false);
    const summary = { id: 'synthetic-job', batchLabel: '合成批次', personLabel: null,
      stage: 'publish', status: 'succeeded', completedUnits: 1, totalUnits: 1,
      statusText: '已完成', systemOutcomes: [], updatedAt: base.updatedAt, canCancel: false, canRetry: false };
    expect(jobSummarySchema.safeParse(summary).success).toBe(true);
    expect(jobSummarySchema.parse({ ...summary, assessmentOutcome: null }).assessmentOutcome).toBeNull();
    expect(jobSummarySchema.parse({ ...summary, assessmentOutcome: base }).assessmentOutcome?.status).toBe('published');
  });
});
