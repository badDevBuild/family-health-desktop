import type { DashboardSnapshot, ExportMemberSummaryInput } from '@contracts';

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
  };
  observations: Array<{
    name: string;
    date: string;
    value: string;
    unit: string | null;
    abnormalFlag: string;
    sourceLabel: string;
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

export function buildMemberSummaryData(
  snapshot: DashboardSnapshot,
  input: Pick<ExportMemberSummaryInput, 'personId' | 'dateFrom' | 'dateTo'>,
  exportedAt = new Date().toISOString()
): MemberSummaryData {
  const person = snapshot.persons.find((item) => item.id === input.personId);
  if (!person) throw new Error('PERSON_NOT_FOUND');
  const observations = snapshot.trends
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
      })))
    .sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name, 'zh-CN'));
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
    '本人补充和自测记录保留 user_reported 来源，不等同于医院检验。'
  ];
  if ((input.dateFrom || input.dateTo) && unknownDateCount > 0) warnings.push(`有 ${unknownDateCount} 条日期未知的本人补充未纳入所选日期范围。`);
  if (person.derivedStatus === 'stale') warnings.push('成员背景或事实已变化，旧的 AI 派生说明已标记为待更新，本摘要未使用旧说明。');
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
      status: person.derivedStatus,
      summary: person.derivedStatus === 'current' ? person.assessmentSummary : null
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
    lifestyleGuidance: snapshot.guidance.filter((item) => item.personId === person.id).map((item) => ({
      title: item.title,
      detail: item.detail,
      consultProfessional: item.consultProfessional
    })),
    sourceDocuments: snapshot.inbox.filter((item) => item.personId === person.id).map((item) => ({
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
  clinician_document: '报告中的医生意见', user_created: '本人安排', ai_proposed: 'AI 提议，待咨询'
};

export function renderMemberSummaryHtml(summary: MemberSummaryData): string {
  const range = summary.dateRange.from || summary.dateRange.to
    ? `${summary.dateRange.from ?? '最早'} 至 ${summary.dateRange.to ?? '最新'}` : '全部已保存日期';
  const rows = summary.observations.map((item) => `<tr><td>${escapeHtml(item.date)}</td><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.value)} ${escapeHtml(item.unit)}</td><td>${escapeHtml(item.sourceLabel)}</td></tr>`).join('');
  const notes = summary.userReportedNotes.map((item) => `<article><span class="pill blue">${escapeHtml(noteLabels[item.kind] ?? item.kind)} · 本人补充</span><h3>${escapeHtml(item.date ?? '日期未知')}</h3><p>${escapeHtml(item.text)}</p></article>`).join('');
  const actions = summary.actionItems.map((item) => `<li><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(actionOriginLabels[item.origin] ?? item.origin)} · ${escapeHtml(item.status)} · ${escapeHtml(item.dueDate ?? item.dueText ?? '无固定日期')}</span><p>${escapeHtml(item.detail)}</p></li>`).join('');
  const guidance = summary.lifestyleGuidance.map((item) => `<li><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.detail)}</p>${item.consultProfessional ? '<span>建议与专业人员确认</span>' : ''}</li>`).join('');
  const sources = summary.sourceDocuments.map((item) => `<li>${escapeHtml(item.displayName)} <span>${escapeHtml(item.format)} · ${escapeHtml(item.status)}</span></li>`).join('');
  const warnings = summary.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(summary.member.displayName)}的健康资料摘要</title><style>
    :root{color:#39352f;background:#fbfaf7;font:15px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}*{box-sizing:border-box}body{max-width:920px;margin:0 auto;padding:44px 48px}header{padding:28px;border:1px solid #dfe8e2;border-radius:22px;background:#f0f7f3}h1{margin:4px 0 8px;font-size:30px}h2{margin:30px 0 12px;font-size:20px}h3{margin:8px 0 2px;font-size:15px}p{margin:5px 0;color:#625c54}.meta{display:flex;gap:12px;flex-wrap:wrap;color:#6d665e}.pill{display:inline-block;padding:3px 9px;border-radius:999px;color:#35644d;background:#dcefe5;font-size:12px}.blue{color:#365d7d;background:#e8f2fa}section{break-inside:avoid}article,li{break-inside:avoid}article{margin:10px 0;padding:14px;border:1px solid #e7e2da;border-radius:14px;background:#fff}table{width:100%;border-collapse:collapse;background:#fff}th,td{padding:9px;border-bottom:1px solid #e7e2da;text-align:left;vertical-align:top}th{color:#6d665e;font-size:12px}ul{padding-left:20px}li{margin:8px 0}li span{display:block;color:#837b71;font-size:12px}.warning{padding:16px;border-radius:14px;background:#fff6dc}.footer{margin-top:32px;padding-top:14px;border-top:1px solid #e7e2da;color:#837b71;font-size:12px}@media print{body{max-width:none;padding:20mm 16mm}header{background:#f0f7f3;-webkit-print-color-adjust:exact;print-color-adjust:exact}}
  </style></head><body><header><span class="pill">本机固定模板导出</span><h1>${escapeHtml(summary.member.displayName)}的健康资料摘要</h1><div class="meta"><span>${escapeHtml(summary.member.relation)}</span><span>${escapeHtml(range)}</span><span>${escapeHtml(summary.member.freshnessLabel)}</span></div></header>
  <section><h2>当前说明</h2>${summary.assessment.summary ? `<p>${escapeHtml(summary.assessment.summary)}</p><span class="pill">已复核派生说明</span>` : '<p>当前没有可用于导出的最新复核说明。报告事实与本人补充仍按各自来源列出。</p>'}</section>
  <section><h2>有日期的报告指标</h2>${rows ? `<table><thead><tr><th>日期</th><th>项目</th><th>原始显示值</th><th>来源</th></tr></thead><tbody>${rows}</tbody></table>` : '<p>所选范围内没有可列出的带日期数值记录。</p>'}</section>
  <section><h2>本人补充</h2>${notes || '<p>所选范围内没有本人补充资料。</p>'}</section>
  <section><h2>后续事项</h2>${actions ? `<ul>${actions}</ul>` : '<p>没有已保存的后续事项。</p>'}</section>
  <section><h2>生活指南</h2>${guidance ? `<ul>${guidance}</ul>` : '<p>当前没有已发布的生活指南。</p>'}</section>
  <section><h2>资料清单</h2><p>只列名称和处理状态，不附原始报告。</p>${sources ? `<ul>${sources}</ul>` : '<p>没有已导入资料。</p>'}</section>
  <section class="warning"><h2>重要边界</h2><ul>${warnings}</ul></section><p class="footer">导出时间：${escapeHtml(summary.exportedAt)} · 格式版本：${summary.schemaVersion}</p></body></html>`;
}

export function renderMemberSummaryJson(summary: MemberSummaryData): string {
  return `${JSON.stringify(summary, null, 2)}\n`;
}
