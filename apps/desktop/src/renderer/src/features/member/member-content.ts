import { containsProcessNarrative, documentedPlanEvidence, reviewedSourceInstructionEvidence } from '@contracts';
import type { ActionItem, BodySystemId, HealthAction, HealthEventV2, InboxItem, LifestylePlanV2, MemberEvidenceRef, MemberAssessmentSnapshotV3 } from '@contracts';
import { assessmentOverviewText } from './assessment-overview-text.js';

export type MemberQuestionPrompt = { questionId: string; snapshotId: string; question: string };

/** 未知日期只说明报告缺失的信息，不把它表现为等待用户完成的核对任务。 */
export function reportDateLabel(value: string | null | undefined): string {
  return !value || /^(?:(?:报告|检查|临床)?日期待确认|日期未知|日期未明确)$/.test(value)
    ? '检查日期未记录' : value;
}

export const bodySystemNames: Record<BodySystemId, string> = {
  cardiovascular: '心血管', endocrine_metabolic: '内分泌 / 代谢', hepatobiliary: '肝胆', renal_urinary: '肾脏 / 泌尿',
  digestive: '消化', respiratory: '肺 / 呼吸', hematology_immune: '血液 / 免疫', musculoskeletal: '骨骼 / 肌肉',
  neurological: '神经', sensory_oral: '眼 / 五官 / 口腔', reproductive: '生殖', dermatological: '皮肤'
};

/** 仅整理派生说明的显示语法；报告原文、数值、来源摘录与本人输入不经过此函数。 */
export function memberText(value: string | null | undefined): string {
  return assessmentOverviewText(value);
}

/** 已绑定原报告指示的完整原句不经过派生正文整理，其余做法仍按派生文字显示。 */
export function memberActionFirstStep(action: Pick<HealthAction, 'kind' | 'firstStep' | 'sourceInstructionObservationId'>): string {
  return action.kind === 'documented_plan' && action.sourceInstructionObservationId ? action.firstStep : memberText(action.firstStep);
}

/** 只整理 AI 派生标题；本人安排和原报告中的医生文字不改写。 */
export function savedActionTitle(value: string, origin: ActionItem['origin']): string {
  if (origin !== 'ai_proposed') return value;
  const text = memberText(value);
  return containsProcessNarrative(text) ? '已有行动记录，安排前需确认依据' : text || '已保存的行动安排';
}

/** 生活提案标题来自 AI；其余行动由服务按真实来源整理，不凭综合关联键猜测来源。 */
export function adoptedActionTitle(action: Pick<LifestylePlanV2['adoptedActions'][number], 'title' | 'proposalId' | 'assessmentDedupeKey'>): string {
  return action.proposalId ? savedActionTitle(action.title, 'ai_proposed') : action.title;
}

/** 检查摘要保留历史结果这一事实，不讲软件如何拆分记录。 */
export function memberEventSummary(value: string): string {
  return memberText(value.replace(/报告中另有历史对比结果[，,]\s*已与本次检查分开[。.]?/g, '原报告还含历史对比结果。'));
}

/** 同一文件的同一已知位置只提供一个附件入口；页码缺失时不补造页码。 */
export function eventSourceGroups(evidence: MemberEvidenceRef[]): Array<{ key: string; sources: MemberEvidenceRef[] }> {
  const groups = new Map<string, { key: string; sources: MemberEvidenceRef[] }>();
  for (const source of evidence) {
    const key = source.documentId ? `${source.documentId}\u0000${source.locator?.normalize('NFKC').replace(/\s+/g, '') ?? ''}` : source.id;
    const group = groups.get(key) ?? { key, sources: [] };
    group.sources.push(source);
    groups.set(key, group);
  }
  return [...groups.values()];
}

// 只忽略句子首尾空白和句末句号；小数、比较符、否定词、单位大小写均有医学含义。
const textIdentity = (value: string) => value.normalize('NFC').trim().replace(/[。.]$/, '');
const textSentences = (value: string) => value.match(/[^。！？\n]+[。！？]?/g) ?? [];

/** 已在标题或前文解释过的句子不再重复，新增的临床条件仍保留。 */
export function additionalMemberText(value: string | null | undefined, preceding: string[]): string {
  const text = memberText(value);
  const previous = new Set(preceding.flatMap((value) => textSentences(memberText(value)).map(textIdentity)).filter(Boolean));
  // 保留完整解释、条件和行动之间的段落，不将多段安全提醒挤成一段长文字。
  return text.split(/\n+/).map((paragraph) => textSentences(paragraph).filter((sentence) => {
    const identity = textIdentity(sentence);
    if (!identity || previous.has(identity)) return false;
    previous.add(identity);
    return true;
  }).join('').trim()).filter(Boolean).join('\n\n');
}

export function uniqueMemberTexts(values: Array<string | null | undefined>, preceding: string[] = []): string[] {
  const seen = [...preceding];
  return values.flatMap((value) => {
    const text = additionalMemberText(value, seen);
    if (!text) return [];
    seen.push(text);
    return [text];
  });
}

export function documentStatusLabel(status: InboxItem['status']): string {
  const labels: Record<InboxItem['status'], string> = {
    queued: '待处理', needs_review: '部分内容未纳入', duplicate: '重复资料', blocked: '暂时无法处理', processing: '处理中',
    completed: '已处理', ignored: '已移出分析', stabilizing: '正在导入', discovered: '已发现新资料'
  };
  return labels[status];
}

export function actionStatusLabel(status: string): string {
  const labels: Record<string, string> = { proposed: '待安排', discussed: '已讨论', planned: '已计划', in_progress: '进行中',
    paused: '已暂停', completed: '已完成', dismissed: '已取消', 待安排: '待安排', 待讨论: '待讨论', 已安排: '已安排',
    已讨论: '已讨论', 已计划: '已计划', 进行中: '进行中', 已暂停: '已暂停', 已完成: '已完成', 已取消: '已取消',
    '建议，尚未加入我的计划': '尚未加入计划' };
  return labels[status] ?? '未注明进度';
}

export function isReportAdviceName(name: string): boolean {
  return /(?:医生建议|医师建议|医嘱|诊疗建议|处理建议|复查建议|随访建议|体检建议|健康建议|出院指导|治疗计划|复查计划|建议)/.test(name);
}

export function reportDates(events: HealthEventV2[]): Record<string, string> {
  const dates: Record<string, string> = {};
  const documentDates = new Map<string, Set<string>>();
  for (const event of events) {
    if (!event.time.value) continue;
    dates[event.id] = event.time.displayLabel;
    for (const documentId of event.documentIds) {
      const values = documentDates.get(documentId) ?? new Set<string>();
      values.add(event.time.displayLabel);
      documentDates.set(documentId, values);
    }
  }
  for (const [id, values] of documentDates) if (values.size === 1) dates[id] = [...values][0]!;
  return dates;
}

export function reportAdviceSource(evidence: MemberEvidenceRef[], dates: Record<string, string>): string {
  const source = evidence.find((item) => item.kind !== 'knowledge');
  if (!source) return '来源日期未记录';
  const date = (source.eventId ? dates[source.eventId] : undefined) ?? (source.documentId ? dates[source.documentId] : undefined);
  return `${date ?? '日期未记录'} · ${source.label}`;
}

/** 只在原文确有本安排、并且有真实检查日期时，标作报告中的医生建议。 */
export function reportPlanSource(action: Pick<HealthAction, 'kind' | 'timingBasis' | 'title' | 'firstStep' | 'timing' | 'evidenceIds'>
  & Partial<Pick<HealthAction, 'id' | 'sourceInstructionObservationId'>>,
  evidence: MemberEvidenceRef[], dates: Record<string, string>, snapshot?: MemberAssessmentSnapshotV3 | null): string | null {
  const matched = action.sourceInstructionObservationId
    ? action.id && snapshot ? reviewedSourceInstructionEvidence(action as HealthAction, snapshot) : []
    : documentedPlanEvidence(action, evidence);
  const sources = matched.filter((source) =>
    Boolean((source.eventId ? dates[source.eventId] : undefined) ?? (source.documentId ? dates[source.documentId] : undefined)));
  return sources.length > 0 ? reportAdviceSource(sources, dates) : null;
}
