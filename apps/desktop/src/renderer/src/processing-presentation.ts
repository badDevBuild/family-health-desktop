import type { InboxItem, JobSummary, ReviewIssue } from '@contracts';
import type { Tone } from './components/StatusBadge.js';

type ProcessingPresentation = { label: string; tone: Tone };
type ReportProcessingPresentation = ProcessingPresentation & { issue: string | null };

function inboxStatusPresentation(status: InboxItem['status']): ProcessingPresentation {
  switch (status) {
    case 'queued': return { label: '等待处理', tone: 'info' };
    case 'needs_review': return { label: '部分内容未纳入', tone: 'info' };
    case 'duplicate': return { label: '重复资料', tone: 'neutral' };
    case 'blocked': return { label: '暂时无法读取', tone: 'alert' };
    case 'processing': return { label: '处理中', tone: 'info' };
    case 'completed': return { label: '已完成', tone: 'success' };
    case 'ignored': return { label: '已忽略', tone: 'neutral' };
    case 'stabilizing': return { label: '等待文件保存完成', tone: 'neutral' };
    case 'discovered': return { label: '准备导入', tone: 'neutral' };
  }
}

/** 身份问题和读取结果问题分开呈现，不沿用旧版对 needs_review 的统一归属提示。 */
export function reportProcessingPresentation(item: InboxItem, reviews: ReviewIssue[]): ReportProcessingPresentation {
  const status = inboxStatusPresentation(item.status);
  if (item.status !== 'needs_review') {
    if (item.status === 'completed' && item.acceptedFactCount === 0) {
      return { label: '已读完，暂无可用结果', tone: 'info', issue: item.issue };
    }
    return { ...status, issue: item.issue };
  }
  const openReviews = reviews.filter((review) => review.documentId === item.id && review.resolutionStatus === 'open');
  if (isUserAssignedIdentityRepairDocument(item, openReviews)) {
    return { label: '可按已选成员重新整理', tone: 'info',
      issue: '上传时已指定成员；旧版姓名校验曾阻止整理，原件和已有结果保留，可按当前归属重新读取。' };
  }
  if (item.personId === null || openReviews.some((review) => review.kind === 'person_conflict'
    || review.reasonCodes.some((code) => code.startsWith('PERSON_') || code === 'DIRECT_ORIGINAL_IDENTITY_UNPROVEN'))) {
    return { label: '暂未纳入成员', tone: 'info', issue: item.personId === null
      ? '这份资料尚不能可靠对应到成员，原件已保存；其他资料会继续整理。'
      : '这份资料的身份信息与当前成员不一致，暂未用于成员解读；其他资料会继续整理。' };
  }
  if (openReviews.some((review) => ['field_conflict', 'coverage_gap', 'overwrite_protected'].includes(review.kind))) {
    const readCompleted = item.aiTransmissionStatus === 'completed' || (item.acceptedFactCount ?? 0) > 0;
    // 一次模型请求结束不能证明完整读完原件；没有正式完成状态时只说明可用结果。
    return { label: item.acceptedFactCount === 0 && readCompleted ? '暂无可用结果' : '部分内容未纳入', tone: 'info', issue: readCompleted
      ? item.acceptedFactCount === 0
        ? '暂未获得可靠的检查结果；原件已保存，其他资料会继续整理。'
        : '可靠结果已保存；部分内容暂未用于健康解读。'
      : '这份资料的部分内容暂未用于健康解读，原件已保存。' };
  }
  // 旧快照没有可证明的原因时保持通用，不能推断身份冲突或声称从未发送。
  return { label: '部分内容未纳入', tone: 'info', issue: '这份资料的部分内容暂未用于健康解读，原件已保存。' };
}

export function isSourceRepairReview(review: ReviewIssue): boolean {
  return (review.kind === 'field_conflict' || review.kind === 'coverage_gap')
    && review.candidateDiffs.length === 0
    && !review.reasonCodes.some((code) => code.startsWith('PERSON_') || code === 'DIRECT_ORIGINAL_IDENTITY_UNPROVEN');
}

/** 仅恢复旧版姓名门禁；归属未知、混合原因和已提交结果隔离仍须保持保护。 */
export function isUserAssignedIdentityRepairReview(review: ReviewIssue, item?: InboxItem): boolean {
  return Boolean(item && item.personId !== null && review.documentId === item.id && review.personId === item.personId
    && ['user_selected', 'identity_confirmed'].includes(item.personAssignmentBasis ?? '')
    && ['person_conflict', 'coverage_gap'].includes(review.kind) && review.severity === 'blocking'
    && review.resolutionStatus === 'open' && review.candidateDiffs.length === 0 && review.reasonCodes.length > 0
    && review.reasonCodes.every((code) => ['PERSON_IDENTITY_NOT_CONFIRMED', 'DIRECT_ORIGINAL_IDENTITY_UNPROVEN'].includes(code)));
}

/** 同份报告仍有其他阻断或候选差异时，不借姓名规则升级绕过其独立保护。 */
export function isUserAssignedIdentityRepairDocument(item: InboxItem | undefined, reviews: ReviewIssue[]): boolean {
  if (!item) return false;
  const openReviews = reviews.filter((review) => review.documentId === item.id && review.resolutionStatus === 'open');
  return openReviews.some((review) => isUserAssignedIdentityRepairReview(review, item))
    && openReviews.every((review) => isUserAssignedIdentityRepairReview(review, item)
      || review.personId === item.personId && review.severity === 'warning' && isSourceRepairReview(review));
}

/** 资料读取进度不能证明综合解读已发布，只有终态回执可以给出该结论。 */
export function jobProcessingPresentation(job: JobSummary): ProcessingPresentation {
  switch (job.status) {
    case 'running': return { label: '处理中', tone: 'info' };
    case 'queued': return { label: '等待自动处理', tone: 'info' };
    case 'retry_wait': return { label: '正在自动恢复', tone: 'info' };
    case 'waiting_auth': return { label: '等待登录', tone: 'info' };
    case 'waiting_quota': return { label: '等待可用额度', tone: 'info' };
    // 当前 waiting_user 表示发送授权或范围暂不可用，不能宣称报告内容已经完成。
    case 'waiting_user': return { label: '发送范围暂不可用', tone: 'warning' };
    case 'failed': return { label: '处理未完成', tone: 'warning' };
    case 'cancelled': return { label: '已停止', tone: 'neutral' };
    case 'succeeded':
    case 'completed_with_issues': {
      switch (job.assessmentOutcome?.status) {
        case 'published':
        case 'reused_current': return { label: '健康看板已更新', tone: 'success' };
        case 'rejected': return { label: '综合解读未更新', tone: 'info' };
        case 'skipped_no_data': return { label: '暂无可用于综合解读的资料', tone: 'info' };
        default: return job.status === 'succeeded'
          ? { label: '已完成', tone: 'success' }
          : { label: '已结束，部分内容未纳入', tone: 'info' };
      }
    }
  }
}
