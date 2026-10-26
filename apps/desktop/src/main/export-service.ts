import { healthClaimTitle } from '@contracts';
import type { BodySystemId, DashboardSnapshot, ExportMemberSummaryInput, MemberAssessmentSnapshotV3 } from '@contracts';
import type { AcceptedObservationSummary } from '@storage';

export interface MemberSummaryData {
  schemaVersion: 1;
  exportedAt: string;
  member: {
    id: string;
    displayName: string;
    relation: string;
    dataQuality: string;
    freshnessLabel: string;
  };
  dateRange: { from: string | null; to: string | null };
  assessment: {
    status: 'current' | 'stale' | 'building' | 'unavailable';
    summary: string | null;
    // 追加可选字段，仍可读取旧版只含 summary 的摘要。
    headline?: string | null;
    limitations?: string[];
    systems?: Array<{ name: string; headline: string; summary: string; limitations: string[] }>;
    findings?: Array<{
      title: string;
      bodySystems: string[];
      text: string;
      rationale: string;
      materialUncertainty: string | null;
      diagnosticContext: string | null;
    }>;
    questions?: Array<{ question: string; whyItMatters: string }>;
  };
  observations: Array<{
    name: string;
    date: string;
    value: string;
    unit: string | null;
    abnormalFlag: string;
    sourceLabel: string;
    clinicalDate?: string | null;
    valueKind?: AcceptedObservationSummary['valueKind'];
    referenceRange?: string | null;
    specimen?: string | null;
    method?: string | null;
    bodySite?: string | null;
    clinicalConditions?: string[];
  }>;
  userReportedNotes: Array<{
    kind: string;
    date: string | null;
    text: string;
    structuredFields: Record<string, string>;
  }>;
  actionItems: Array<{
    title: string;
    detail: string;
    origin: string;
    status: string;
    dueDate: string | null;
    dueText: string | null;
  }>;
  suggestedActions: Array<{
    title: string;
    why: string;
    firstStep: string;
    timing: string | null;
    reviewPlan: string | null;
    caution: string | null;
    kind: MemberAssessmentSnapshotV3['actions'][number]['kind'];
  }>;
  lifestyleGuidance: Array<{
    title: string;
    detail: string;
    consultProfessional: boolean;
  }>;
  sourceDocuments: Array<{ displayName: string; format: string; status: string }>;
  warnings: string[];
}

function dateInRange(date: string | null, from: string | null, to: string | null): boolean {
  if (!date) return from === null && to === null;
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

const bodySystemNames: Record<BodySystemId, string> = {
  cardiovascular: '心血管', endocrine_metabolic: '内分泌 / 代谢', hepatobiliary: '肝胆', renal_urinary: '肾脏 / 泌尿',
  digestive: '消化', respiratory: '肺 / 呼吸', hematology_immune: '血液 / 免疫', musculoskeletal: '骨骼 / 肌肉',
  neurological: '神经', sensory_oral: '眼 / 五官 / 口腔', reproductive: '生殖', dermatological: '皮肤'
};

function diagnosticContext(status: MemberAssessmentSnapshotV3['claims'][number]['diagnosticStatus']): string | null {
  if (status === 'documented') return '报告记录的诊断';
  if (status === 'criteria_met') return '符合参考条件，仍需医生确认';
  if (status === 'likely' || status === 'possible') return '一种可能的解释，需医生确认';
  if (status === 'undetermined') return '目前还不能确定';
  return null;
}

export function buildMemberSummaryData(
  snapshot: DashboardSnapshot,
  input: Pick<ExportMemberSummaryInput, 'personId' | 'dateFrom' | 'dateTo'>,
  exportedAt = new Date().toISOString(),
  memberAssessment: MemberAssessmentSnapshotV3 | null = null,
  completeObservations?: readonly AcceptedObservationSummary[]
): MemberSummaryData {
  const person = snapshot.persons.find((item) => item.id === input.personId);
  if (!person) throw new Error('PERSON_NOT_FOUND');
  // V3 是全历史综合，不把它塞进只导出某一日期区间的文件中。
  const fullHistoryExport = input.dateFrom === null && input.dateTo === null;
  const currentAssessment = fullHistoryExport && person.derivedStatus === 'current'
    && memberAssessment?.personId === person.id && memberAssessment.status === 'current' ? memberAssessment : null;
  // 页面趋势只带最近窗口，导出正式入口必须传完整事实；旧调用保留原有字段兼容。
  const observations: MemberSummaryData['observations'] = completeObservations
    ? completeObservations.filter((item) => item.personId === person.id
      && dateInRange(item.clinicalDate, input.dateFrom, input.dateTo)).map((item) => ({
      name: item.originalName, date: item.clinicalDate ?? '检查日期未记录', clinicalDate: item.clinicalDate,
      value: item.rawText, unit: item.unit, valueKind: item.valueKind, abnormalFlag: item.abnormalFlag,
      sourceLabel: item.sourceLabel, referenceRange: item.referenceRange,
      specimen: item.specimen, method: item.method, bodySite: item.bodySite,
      clinicalConditions: item.clinicalContext?.conditions.map((condition) => condition.quote) ?? []
    }))
    : snapshot.trends
      .filter((series) => series.personId === person.id)
      .flatMap((series) => series.points
        .filter((point) => dateInRange(point.date, input.dateFrom, input.dateTo))
        .map((point) => ({
          name: series.name,
          date: point.date,
          value: point.displayValue,
          unit: series.unit,
          abnormalFlag: point.abnormalFlag,
          sourceLabel: point.sourceLabel
        })));
  observations.sort((a, b) => {
    const leftDate = a.clinicalDate === undefined ? a.date : a.clinicalDate;
    const rightDate = b.clinicalDate === undefined ? b.date : b.clinicalDate;
    return leftDate === null ? rightDate === null ? a.name.localeCompare(b.name, 'zh-CN') : 1
      : rightDate === null ? -1 : rightDate.localeCompare(leftDate) || a.name.localeCompare(b.name, 'zh-CN');
  });
  const notes = snapshot.notes
    .filter((note) => note.personId === person.id && dateInRange(note.effectiveDate, input.dateFrom, input.dateTo))
    .map((note) => ({
      kind: note.kind,
      date: note.effectiveDate,
      text: note.immutableText,
      structuredFields: note.structuredFields
    }));
  const unknownDateCount = snapshot.notes.filter((note) => note.personId === person.id && note.effectiveDate === null).length;
  const warnings = [
    '本摘要来自当前本机已保存内容，不是诊断、处方或医生审核。',
    '原始报告未附在摘要中；请以原报告和医生意见为准。',
    '本人补充和自测记录与医院检查分开列出，不等同于医院检验。'
  ];
  if ((input.dateFrom || input.dateTo) && unknownDateCount > 0) warnings.push(`有 ${unknownDateCount} 条日期未知的本人补充未纳入所选日期范围。`);
  const unknownReportDateCount = completeObservations?.filter((item) => item.personId === person.id && item.clinicalDate === null).length ?? 0;
  if ((input.dateFrom || input.dateTo) && unknownReportDateCount > 0) warnings.push(`有 ${unknownReportDateCount} 条检查日期未记录的报告结果未纳入所选日期范围。`);
  if (person.derivedStatus === 'stale') warnings.push('健康解读待更新，本摘要未使用此前的健康解读。');
  if (!fullHistoryExport) warnings.push('按日期筛选仅限制报告指标与本人补充；跨期综合及建议未纳入。后续事项和资料清单仍按成员列出。');
  return {
    schemaVersion: 1,
    exportedAt,
    member: {
      id: person.id,
      displayName: person.displayName,
      relation: person.relation,
      dataQuality: person.dataQuality,
      freshnessLabel: person.freshnessLabel
    },
    dateRange: { from: input.dateFrom, to: input.dateTo },
    assessment: {
      status: fullHistoryExport ? person.derivedStatus : 'unavailable',
      summary: fullHistoryExport && person.derivedStatus === 'current'
        ? currentAssessment?.overview.summary ?? (memberAssessment ? null : person.assessmentSummary) : null,
      headline: currentAssessment?.overview.headline ?? null,
      // 不能假定摘要已经重复了这些条件。按原范围保留完整句子，不截字、不改写医学判断。
      limitations: currentAssessment ? [...new Set([...currentAssessment.overview.limitations, ...currentAssessment.limitations])] : [],
      systems: currentAssessment?.systems.map((system) => ({
        name: bodySystemNames[system.systemId], headline: system.headline,
        summary: system.summary, limitations: [...system.limitations]
      })) ?? [],
      findings: currentAssessment?.claims.map((claim) => ({
        title: healthClaimTitle(claim), bodySystems: claim.systemIds.map((id) => bodySystemNames[id]),
        text: claim.text, rationale: claim.rationale, materialUncertainty: claim.materialUncertainty,
        diagnosticContext: diagnosticContext(claim.diagnosticStatus)
      })) ?? [],
      questions: currentAssessment?.questions.map((question) => ({
        question: question.question, whyItMatters: question.whyItMatters
      })) ?? []
    },
    observations,
    userReportedNotes: notes,
    actionItems: snapshot.actions.filter((item) => item.personId === person.id).map((item) => ({
      title: item.title,
      detail: item.detail,
      origin: item.origin,
      status: item.status,
      dueDate: item.dueDate,
      dueText: item.dueText
    })),
    suggestedActions: currentAssessment?.actions.map((action) => ({
      title: action.title,
      why: action.why,
      firstStep: action.firstStep,
      timing: action.timing,
      reviewPlan: action.reviewPlan,
      caution: action.caution,
      kind: action.kind
    })) ?? [],
    // V3 发布后不再把旧派生建议混入同一份导出；已采纳行动仍从 actionItems 单独列出。
    lifestyleGuidance: (fullHistoryExport && person.derivedStatus === 'current' && !currentAssessment
      ? snapshot.guidance : []).filter((item) => item.personId === person.id).map((item) => ({
      title: item.title,
      detail: item.detail,
      consultProfessional: item.consultProfessional
    })),
    sourceDocuments: snapshot.inbox.filter((item) => item.personId === person.id && item.status !== 'ignored').map((item) => ({
      displayName: item.displayName,
      format: item.format,
      status: item.status
    })),
    warnings
  };
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const noteLabels: Record<string, string> = {
  history: '既往情况', allergy: '过敏记录', medication: '用药记录',
  self_measurement: '本人自测', free_text: '补充说明'
};

const actionOriginLabels: Record<string, string> = {
  clinician_document: '报告中的医生意见', user_created: '本人安排', ai_proposed: '健康解读中的建议'
};

const actionStatusLabels: Record<string, string> = {
  proposed: '待安排', discussed: '已讨论', planned: '已计划', in_progress: '进行中', paused: '已暂停',
  completed: '已完成', dismissed: '已取消'
};
const documentStatusLabels: Record<string, string> = {
  queued: '待处理', needs_review: '需要核对', duplicate: '重复资料', blocked: '暂时无法处理', processing: '处理中',
  completed: '已处理', ignored: '已移出分析', stabilizing: '正在导入', discovered: '已发现新资料'
};
const renderLimitations = (values: string[] | undefined): string => values?.length
  ? `<div class="conditions"><h4>理解这些结果时需注意</h4><ul>${values.map((value) => `<li>${escapeHtml(value)}</li>`).join('')}</ul></div>` : '';

export function renderMemberSummaryHtml(summary: MemberSummaryData): string {
  const range = summary.dateRange.from || summary.dateRange.to
    ? `${summary.dateRange.from ?? '最早'} 至 ${summary.dateRange.to ?? '最新'}` : '全部已保存日期';
  const rows = summary.observations.map((item) => {
    const conditions = [item.referenceRange ? `参考范围：${item.referenceRange}` : null,
      item.specimen ? `标本：${item.specimen}` : null, item.method ? `方法：${item.method}` : null,
      item.bodySite ? `部位：${item.bodySite}` : null, ...(item.clinicalConditions ?? [])].filter(Boolean).map(escapeHtml).join('；');
    return `<tr><td>${escapeHtml(item.date)}</td><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.value)} ${escapeHtml(item.unit)}${conditions ? `<p>${conditions}</p>` : ''}</td><td>${escapeHtml(item.sourceLabel)}</td></tr>`;
  }).join('');
  const notes = summary.userReportedNotes.map((item) => `<article><span class="pill blue">${escapeHtml(noteLabels[item.kind] ?? item.kind)} · 本人补充</span><h3>${escapeHtml(item.date ?? '日期未知')}</h3><p>${escapeHtml(item.text)}</p></article>`).join('');
  const actions = summary.actionItems.map((item) => `<li><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(actionOriginLabels[item.origin] ?? '已保存的安排')} · ${escapeHtml(actionStatusLabels[item.status] ?? '未注明进度')} · ${escapeHtml(item.dueDate ?? item.dueText ?? '无固定日期')}</span><p>${escapeHtml(item.detail)}</p></li>`).join('');
  const suggestedActions = summary.suggestedActions.map((item) => `<li><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.why)}</p><p>第一步：${escapeHtml(item.firstStep)}</p>${item.timing ? `<p>何时：${escapeHtml(item.timing)}</p>` : ''}${item.reviewPlan ? `<p>回看：${escapeHtml(item.reviewPlan)}</p>` : ''}${item.caution ? `<p>注意：${escapeHtml(item.caution)}</p>` : ''}</li>`).join('');
  const guidance = summary.lifestyleGuidance.map((item) => `<li><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.detail)}</p>${item.consultProfessional ? '<span>建议与专业人员确认</span>' : ''}</li>`).join('');
  const sources = summary.sourceDocuments.map((item) => `<li>${escapeHtml(item.displayName)} <span>${escapeHtml(item.format)} · ${escapeHtml(documentStatusLabels[item.status] ?? '未注明状态')}</span></li>`).join('');
  const warnings = summary.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('');
  const systems = (summary.assessment.systems ?? []).map((system) => `<article><span class="pill">${escapeHtml(system.name)}</span><h3>${escapeHtml(system.headline)}</h3><p>${escapeHtml(system.summary)}</p>${renderLimitations(system.limitations)}</article>`).join('');
  const findings = (summary.assessment.findings ?? []).map((finding) => `<article><h3>${escapeHtml(finding.title)}</h3>${finding.bodySystems.length ? `<span class="meta">${escapeHtml(finding.bodySystems.join(' · '))}</span>` : ''}${finding.diagnosticContext ? `<span class="pill blue">${escapeHtml(finding.diagnosticContext)}</span>` : ''}<p>${escapeHtml(finding.text)}</p><p>${escapeHtml(finding.rationale)}</p>${finding.materialUncertainty ? `<div class="conditions"><strong>仍需注意</strong><p>${escapeHtml(finding.materialUncertainty)}</p></div>` : ''}</article>`).join('');
  const questions = (summary.assessment.questions ?? []).map((question) => `<li><strong>${escapeHtml(question.question)}</strong><p>${escapeHtml(question.whyItMatters)}</p></li>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(summary.member.displayName)}的健康资料摘要</title><style>
    :root{color:#39352f;background:#fbfaf7;font:15px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}*{box-sizing:border-box}body{max-width:920px;margin:0 auto;padding:44px 48px}header{padding:28px;border:1px solid #dfe8e2;border-radius:22px;background:#f0f7f3}h1{margin:4px 0 8px;font-size:30px}h2{margin:30px 0 12px;font-size:20px}h3{margin:8px 0 2px;font-size:15px}p{margin:5px 0;color:#625c54}.meta{display:flex;gap:12px;flex-wrap:wrap;color:#6d665e}.pill{display:inline-block;padding:3px 9px;border-radius:999px;color:#35644d;background:#dcefe5;font-size:12px}.blue{color:#365d7d;background:#e8f2fa}section{break-inside:avoid}article,li{break-inside:avoid}article{margin:10px 0;padding:14px;border:1px solid #e7e2da;border-radius:14px;background:#fff}table{width:100%;border-collapse:collapse;background:#fff}th,td{padding:9px;border-bottom:1px solid #e7e2da;text-align:left;vertical-align:top}th{color:#6d665e;font-size:12px}ul{padding-left:20px}li{margin:8px 0}li span{display:block;color:#837b71;font-size:12px}.warning{padding:16px;border-radius:14px;background:#fff6dc}.footer{margin-top:32px;padding-top:14px;border-top:1px solid #e7e2da;color:#837b71;font-size:12px}@media print{body{max-width:none;padding:20mm 16mm}header{background:#f0f7f3;-webkit-print-color-adjust:exact;print-color-adjust:exact}}
    p,.conditions li{white-space:pre-line;overflow-wrap:anywhere}.conditions{margin-top:12px;padding:12px;border-left:3px solid #8cb49c;background:#f4f8f5}.conditions h4{margin:0 0 6px}.conditions ul{margin:0}h3{font-size:18px}:root{font-size:16px}
  </style></head><body><header><span class="pill">个人健康资料</span><h1>${escapeHtml(summary.member.displayName)}的健康资料摘要</h1><div class="meta"><span>${escapeHtml(summary.member.relation)}</span><span>${escapeHtml(range)}</span></div></header>
  <section><h2>整体健康解读</h2>${summary.assessment.summary ? `${summary.assessment.headline ? `<h3>${escapeHtml(summary.assessment.headline)}</h3>` : ''}<p>${escapeHtml(summary.assessment.summary)}</p>${renderLimitations(summary.assessment.limitations)}` : '<p>当前还没有可导出的最新健康解读。已有检查记录与本人补充仍按各自来源列出。</p>'}</section>
  ${systems ? `<section><h2>按身体系统理解</h2>${systems}</section>` : ''}
  ${findings ? `<section><h2>相关结果与说明</h2>${findings}</section>` : ''}
  <section><h2>报告检查记录</h2>${rows ? `<table><thead><tr><th>检查日期</th><th>项目</th><th>结果与检查条件</th><th>来源</th></tr></thead><tbody>${rows}</tbody></table>` : '<p>所选范围内没有可列出的报告检查记录。</p>'}</section>
  <section><h2>本人补充</h2>${notes || '<p>所选范围内没有本人补充资料。</p>'}</section>
  <section><h2>后续事项</h2>${actions ? `<ul>${actions}</ul>` : '<p>没有已保存的后续事项。</p>'}</section>
  <section><h2>接下来怎么做</h2><p>这些建议供选择和安排，不表示你已开始执行。</p>${suggestedActions ? `<ul>${suggestedActions}</ul>` : '<p>当前没有可导出的行动建议。</p>'}</section>
  ${questions ? `<section><h2>补充这些情况，帮助理解你的健康</h2><ul>${questions}</ul></section>` : ''}
  ${guidance ? `<section><h2>日常生活建议</h2><ul>${guidance}</ul></section>` : ''}
  <section><h2>资料清单</h2><p>只列名称和处理状态，不附原始报告。</p>${sources ? `<ul>${sources}</ul>` : '<p>没有已导入资料。</p>'}</section>
  <section class="warning"><h2>重要边界</h2><ul>${warnings}</ul></section><p class="footer">导出时间：${escapeHtml(summary.exportedAt)} · 格式版本：${summary.schemaVersion}</p></body></html>`;
}

export function renderMemberSummaryJson(summary: MemberSummaryData): string {
  return `${JSON.stringify(summary, null, 2)}\n`;
}
