import { describe, expect, it } from 'vitest';
import type { InboxItem, JobAssessmentOutcome, JobSummary, ReviewIssue } from '@contracts';
import { isSourceRepairReview, isUserAssignedIdentityRepairDocument, isUserAssignedIdentityRepairReview, jobProcessingPresentation, reportProcessingPresentation } from './processing-presentation.js';

// 仅用合成对象验证文字映射，不加载界面桥接、模型或本机工作区。
function report(overrides: Partial<InboxItem> = {}): InboxItem {
  return { id: 'synthetic-document', displayName: '合成报告.pdf', discoveredAt: '2026-01-01T00:00:00Z',
    personId: 'synthetic-person', personLabel: '合成成员', status: 'needs_review', format: 'PDF',
    sourceLabel: '合成来源', sentToAi: true, aiTransmissionStatus: 'completed', inProcessingCenter: true,
    issue: null, ...overrides };
}

function review(overrides: Partial<ReviewIssue> = {}): ReviewIssue {
  return { id: 'synthetic-review', personId: 'synthetic-person', documentId: 'synthetic-document',
    kind: 'coverage_gap', severity: 'warning', title: '合成来源事项', description: '合成来源说明',
    evidenceRefs: [], candidateOptions: [], candidateDiffs: [], reportedName: null,
    reasonCodes: ['source_span_missing'], resolutionStatus: 'open', ...overrides };
}

function outcome(status: JobAssessmentOutcome['status']): JobAssessmentOutcome {
  const published = status === 'published' || status === 'reused_current';
  return { status, reasonCode: published ? null : status === 'skipped_no_data' ? 'no_accepted_facts' : 'validation_failed',
    snapshotId: published ? 'synthetic-snapshot' : null, inputSignature: 'a'.repeat(64),
    factRevision: 3, contextRevision: 1, reviewScopeSignature: 'b'.repeat(64),
    attemptId: 'synthetic-attempt', updatedAt: '2026-01-01T00:00:00Z' };
}

function job(overrides: Partial<JobSummary> = {}): JobSummary {
  return { id: 'synthetic-job', batchLabel: '合成自动处理', personLabel: '合成成员', stage: 'publish',
    status: 'succeeded', completedUnits: 26, totalUnits: 26, statusText: '合成工作记录',
    systemOutcomes: [], updatedAt: '2026-01-01T00:00:00Z', canCancel: false, canRetry: false, ...overrides };
}

describe('报告处理结果展示', () => {
  it.each([
    ['discovered', '准备导入', 'neutral'],
    ['stabilizing', '等待文件保存完成', 'neutral'],
    ['queued', '等待处理', 'info'],
    ['processing', '处理中', 'info'],
    ['completed', '已完成', 'success'],
    ['ignored', '已忽略', 'neutral'],
    ['duplicate', '重复资料', 'neutral'],
    ['blocked', '暂时无法读取', 'alert']
  ] as const)('%s 保留原状态与资料说明', (status, label, tone) => {
    expect(reportProcessingPresentation(report({ status, issue: '合成原始说明' }), [review()]))
      .toEqual({ label, tone, issue: '合成原始说明' });
  });

  it('明确零条可用结果时用信息提示，旧快照缺少数量时不推断为零', () => {
    expect(reportProcessingPresentation(report({ status: 'completed', acceptedFactCount: 0 }), []))
      .toEqual({ label: '已读完，暂无可用结果', tone: 'info', issue: null });
    expect(reportProcessingPresentation(report({ status: 'completed' }), []))
      .toEqual({ label: '已完成', tone: 'success', issue: null });
    expect(reportProcessingPresentation(report({ status: 'completed', acceptedFactCount: 2 }), []))
      .toEqual({ label: '已完成', tone: 'success', issue: null });
  });

  it('来源限制且已有可用结果时，说明可靠结果已保存', () => {
    expect(reportProcessingPresentation(report({ acceptedFactCount: 2 }), [review()]))
      .toEqual({ label: '部分内容未纳入', tone: 'info',
        issue: '可靠结果已保存；部分内容暂未用于健康解读。' });
  });

  it.each(['field_conflict', 'coverage_gap', 'overwrite_protected'] as const)('%s 已读完但零结果时不冒充成功', (kind) => {
    expect(reportProcessingPresentation(report({ acceptedFactCount: 0 }), [review({ kind })]))
      .toEqual({ label: '暂无可用结果', tone: 'info',
        issue: '暂未获得可靠的检查结果；原件已保存，其他资料会继续整理。' });
  });

  it.each(['not_sent', 'completed', 'unknown'] as const)('重新排队且传输为 %s 时不推断从未发送', (aiTransmissionStatus) => {
    expect(reportProcessingPresentation(report({ status: 'queued', aiTransmissionStatus }), []))
      .toEqual({ label: '等待处理', tone: 'info', issue: null });
  });

  it('没有读取完成依据时不声称已读完，零结果也不能当作正常', () => {
    expect(reportProcessingPresentation(report({ aiTransmissionStatus: 'not_sent', acceptedFactCount: 0 }), [review()]))
      .toEqual({ label: '部分内容未纳入', tone: 'info',
        issue: '这份资料的部分内容暂未用于健康解读，原件已保存。' });
  });

  it('未归属资料优先说明身份，不把来源限制说成已纳入成员', () => {
    expect(reportProcessingPresentation(report({ personId: null, personLabel: null, acceptedFactCount: 0 }), [review()]))
      .toEqual({ label: '暂未纳入成员', tone: 'info',
        issue: '这份资料尚不能可靠对应到成员，原件已保存；其他资料会继续整理。' });
  });

  it.each([
    { kind: 'person_conflict' as const, reasonCodes: [] },
    { kind: 'coverage_gap' as const, reasonCodes: ['PERSON_MISMATCH'] }
  ])('已归属但有开放身份问题时，身份提示优先于来源结果：$kind', (identity) => {
    expect(reportProcessingPresentation(report({ acceptedFactCount: 2 }), [review(), review(identity)]))
      .toEqual({ label: '暂未纳入成员', tone: 'info',
        issue: '这份资料的身份信息与当前成员不一致，暂未用于成员解读；其他资料会继续整理。' });
  });

  it('其他报告或已处理的身份事项不改变本报告的来源说明', () => {
    const reviews = [review(), review({ kind: 'person_conflict', documentId: 'other-document' }),
      review({ kind: 'person_conflict', resolutionStatus: 'resolved' }),
      review({ kind: 'person_conflict', resolutionStatus: 'deferred' })];
    expect(reportProcessingPresentation(report({ acceptedFactCount: 1 }), reviews).issue)
      .toBe('可靠结果已保存；部分内容暂未用于健康解读。');
  });

  it.each(['user_selected', 'identity_confirmed'] as const)('明确 %s 的旧姓名阻断说明按所选成员恢复，未知原因不被掩盖', (personAssignmentBasis) => {
    const item = report({ personAssignmentBasis, acceptedFactCount: 0 });
    const identity = review({ kind: 'person_conflict', severity: 'blocking', reasonCodes: ['PERSON_IDENTITY_NOT_CONFIRMED'] });
    expect(reportProcessingPresentation(item, [identity])).toEqual({ label: '可按已选成员重新整理', tone: 'info',
      issue: '上传时已指定成员；旧版姓名校验曾阻止整理，原件和已有结果保留，可按当前归属重新读取。' });
    expect(reportProcessingPresentation(item, [identity, review({ kind: 'person_conflict', reasonCodes: ['COMMITTED_PERSON_IDENTITY_CONFLICT'] })]).label)
      .toBe('暂未纳入成员');
  });

  it.each([{ reviews: [] }, { reviews: [review({ kind: 'derived_safety' })] }])('旧 unknown 且原因不足时保留通用限制，不猜身份、未发送或正常', ({ reviews }) => {
    expect(reportProcessingPresentation(report({ aiTransmissionStatus: 'unknown', sentToAi: false }), reviews))
      .toEqual({ label: '部分内容未纳入', tone: 'info',
        issue: '这份资料的部分内容暂未用于健康解读，原件已保存。' });
  });

  it('旧 unknown 中有已接纳事实时，使用事实数量作为已整理依据', () => {
    expect(reportProcessingPresentation(report({ aiTransmissionStatus: 'unknown', acceptedFactCount: 1 }), [review()]).issue)
      .toBe('可靠结果已保存；部分内容暂未用于健康解读。');
  });
});

describe('来源事项分类', () => {
  it.each(['field_conflict', 'coverage_gap'] as const)('%s 无候选差异和身份原因时是来源事项', (kind) => {
    expect(isSourceRepairReview(review({ kind }))).toBe(true);
  });

  it.each(['person_conflict', 'overwrite_protected', 'derived_safety'] as const)('%s 不冒充来源事项', (kind) => {
    expect(isSourceRepairReview(review({ kind }))).toBe(false);
  });

  it('候选值差异或身份原因保留为需区分的事项', () => {
    expect(isSourceRepairReview(review({ candidateDiffs: [{ localKey: 'synthetic-field', itemName: '合成指标', fields: ['value'] }] })))
      .toBe(false);
    expect(isSourceRepairReview(review({ reasonCodes: ['PERSON_NAME_CONFLICT'] }))).toBe(false);
    expect(isSourceRepairReview(review({ reasonCodes: ['DIRECT_ORIGINAL_IDENTITY_UNPROVEN'] }))).toBe(false);
  });
});

describe('旧姓名门禁的维护资格', () => {
  it.each(['user_selected', 'identity_confirmed'] as const)('%s 仅恢复同成员同文档的已知旧身份阻断', (personAssignmentBasis) => {
    const item = report({ personAssignmentBasis });
    for (const reason of ['PERSON_IDENTITY_NOT_CONFIRMED', 'DIRECT_ORIGINAL_IDENTITY_UNPROVEN']) {
      expect(isUserAssignedIdentityRepairReview(review({ kind: 'person_conflict', severity: 'blocking', reasonCodes: [reason] }), item)).toBe(true);
      expect(isUserAssignedIdentityRepairReview(review({ kind: 'coverage_gap', severity: 'blocking', reasonCodes: [reason] }), item)).toBe(true);
    }
  });

  it.each([undefined, 'folder_binding', 'legacy'] as const)('归属依据 %s 不以已有personId代替用户明确选择', (personAssignmentBasis) => {
    expect(isUserAssignedIdentityRepairReview(review({ severity: 'blocking', reasonCodes: ['DIRECT_ORIGINAL_IDENTITY_UNPROVEN'] }), report({ personAssignmentBasis })))
      .toBe(false);
  });

  it('未知或混合原因、候选变化、跨成员/跨文档和非开放阻断不获得资格', () => {
    const item = report({ personAssignmentBasis: 'user_selected' });
    const identity = review({ kind: 'person_conflict', severity: 'blocking', reasonCodes: ['PERSON_IDENTITY_NOT_CONFIRMED'] });
    for (const change of [
      { reasonCodes: [] }, { reasonCodes: ['COMMITTED_PERSON_IDENTITY_CONFLICT'] },
      { reasonCodes: ['PERSON_IDENTITY_NOT_CONFIRMED', 'unknown_reason'] },
      { candidateDiffs: [{ localKey: 'synthetic', itemName: '合成项目', fields: ['value'] as const }] },
      { personId: 'other-person' }, { documentId: 'other-document' }, { severity: 'warning' as const },
      { resolutionStatus: 'resolved' as const }, { kind: 'overwrite_protected' as const }
    ]) expect(isUserAssignedIdentityRepairReview({ ...identity, ...change } as ReviewIssue, item)).toBe(false);
    expect(isUserAssignedIdentityRepairReview(identity, report({ personId: null, personAssignmentBasis: 'user_selected' }))).toBe(false);
    expect(isUserAssignedIdentityRepairReview(identity)).toBe(false);
  });

  it('同报告的独立阻断或任意候选差异不因身份恢复而被绕过，普通来源warning可继续保留', () => {
    const item = report({ personAssignmentBasis: 'user_selected' });
    const identity = review({ kind: 'person_conflict', severity: 'blocking', reasonCodes: ['PERSON_IDENTITY_NOT_CONFIRMED'] });
    expect(isUserAssignedIdentityRepairDocument(item, [identity, review()])).toBe(true);
    expect(isUserAssignedIdentityRepairDocument(item, [identity, review({ severity: 'blocking' })])).toBe(false);
    expect(isUserAssignedIdentityRepairDocument(item, [identity, review({ candidateDiffs: [{ localKey: 'synthetic', itemName: '合成项目', fields: ['value'] }] })])).toBe(false);
    expect(isUserAssignedIdentityRepairDocument(item, [identity, review({ personId: 'other-person' })])).toBe(false);
    expect(isUserAssignedIdentityRepairDocument(item, [identity, review({ kind: 'overwrite_protected' })])).toBe(false);
    expect(isUserAssignedIdentityRepairDocument(item, [identity, review({ severity: 'blocking', resolutionStatus: 'resolved' })])).toBe(true);
  });
});

describe('任务处理结果展示', () => {
  const liveStates = [
    ['running', '处理中', 'info'],
    ['queued', '等待自动处理', 'info'],
    ['retry_wait', '正在自动恢复', 'info'],
    ['waiting_auth', '等待登录', 'info'],
    ['waiting_quota', '等待可用额度', 'info'],
    ['waiting_user', '发送范围暂不可用', 'warning'],
    ['failed', '处理未完成', 'warning'],
    ['cancelled', '已停止', 'neutral']
  ] as const;

  it.each(liveStates)('%s 使用实际状态，残留发布回执不覆盖当前提示', (status, label, tone) => {
    expect(jobProcessingPresentation(job({ status, assessmentOutcome: outcome('published') }))).toEqual({ label, tone });
  });

  it.each(['succeeded', 'completed_with_issues'] as const)('%s 必须按独立综合回执区分结果', (status) => {
    expect(jobProcessingPresentation(job({ status, assessmentOutcome: outcome('published') })))
      .toEqual({ label: '健康看板已更新', tone: 'success' });
    expect(jobProcessingPresentation(job({ status, assessmentOutcome: outcome('reused_current') })))
      .toEqual({ label: '健康看板已更新', tone: 'success' });
    expect(jobProcessingPresentation(job({ status, assessmentOutcome: outcome('rejected') })))
      .toEqual({ label: '综合解读未更新', tone: 'info' });
    expect(jobProcessingPresentation(job({ status, assessmentOutcome: outcome('skipped_no_data') })))
      .toEqual({ label: '暂无可用于综合解读的资料', tone: 'info' });
  });

  it.each([undefined, null])('旧任务缺综合回执（%s）时不从 26/26、阶段或器官结果猜看板成功', (assessmentOutcome) => {
    const systemOutcomes: JobSummary['systemOutcomes'] = [{ systemId: 'synthetic-system', status: 'published',
      reason: null, inputSignature: 'c'.repeat(64), updatedAt: '2026-01-01T00:00:00Z' }];
    expect(jobProcessingPresentation(job({ status: 'succeeded', assessmentOutcome, systemOutcomes })))
      .toEqual({ label: '已完成', tone: 'success' });
    expect(jobProcessingPresentation(job({ status: 'completed_with_issues', assessmentOutcome, systemOutcomes })))
      .toEqual({ label: '已结束，部分内容未纳入', tone: 'info' });
  });

  it('真实发送范围限制不会因读取数量齐全或旧回执而变成内容已完成', () => {
    expect(jobProcessingPresentation(job({ status: 'waiting_user', statusText: 'CONSENT_SCOPE_MISMATCH',
      assessmentOutcome: outcome('reused_current'), canCancel: true, canRetry: true })))
      .toEqual({ label: '发送范围暂不可用', tone: 'warning' });
    expect(jobProcessingPresentation(job({ status: 'waiting_auth', statusText: '请登录', assessmentOutcome: outcome('rejected') })))
      .toEqual({ label: '等待登录', tone: 'info' });
  });
});
