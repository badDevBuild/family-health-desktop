import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Activity, AlertTriangle, Archive, CalendarClock, Check, ChevronDown, ChevronRight, FileCheck2, FileText, LoaderCircle, Plus, RefreshCw, Search, ShieldCheck, Upload } from 'lucide-react';
import type { AdoptLifestyleProposalInput, BodySystemDetailV2, BodySystemId, BodySystemSummaryV2, ConceptReviewBundle, DashboardSnapshot, HealthAction, HealthEventDetailV2, HealthEventV2, InboxItem, LifestylePlanV2, MemberAssessmentSnapshotV3, MemberEvidenceRef, MemberOverviewV2, MetricSeriesDetailV2, PersonSummary, Result, SetConceptMappingInput, UpdateReportMetadataInput } from '@contracts';
import { assessmentChangeLabel } from '@contracts';
import { StatusBadge } from '../../components/StatusBadge.js';
import { reportProcessingPresentation } from '../../processing-presentation.js';
import { ConceptReviewPanel } from './ConceptReviewPanel.js';
import { MetricHistory } from './MetricHistory.js';
import { ReadingHealthMap } from './ReadingHealthMap.js';
import { ReadingPriorityPreview } from './ReadingPriorityPreview.js';
import { ReadingMetricPreview } from './ReadingMetricPreview.js';
import { DailyLifeGuide } from './DailyLifeGuide.js';
import { dailyLifeContent, type DailyLifeItem } from './daily-life-content.js';
import { assessmentOverviewText } from './assessment-overview-text.js';
import { systemReadingStatus } from './system-reading-status.js';
import { groupMetricSeries, isUnprovidedResult } from './metric-presentation.js';
import { actionStatusLabel, additionalMemberText, adoptedActionTitle, bodySystemNames, eventSourceGroups, isReportAdviceName, memberActionFirstStep, memberEventSummary, memberText, reportDateLabel, reportDates, reportPlanSource, savedActionTitle, uniqueMemberTexts, type MemberQuestionPrompt } from './member-content.js';

type EvidenceRequest = {
  title: string;
  label: string;
  quote: string;
  meta: string;
  sourceSpanId?: string | null;
  documentId?: string | null;
};

type MemberTab = 'overview' | 'body' | 'timeline' | 'guidance' | 'sources';
type MemberLoadRegion = 'overview' | 'systems' | 'events' | 'plan' | 'assessment' | 'concept';

const systemSymbol: Record<BodySystemId, string> = {
  cardiovascular: '♥', endocrine_metabolic: '◒', hepatobiliary: '◇', renal_urinary: '◉',
  digestive: '≈', respiratory: '∞', hematology_immune: '✦', musculoskeletal: '⌁',
  neurological: '⌘', sensory_oral: '◎', reproductive: '◌', dermatological: '◍'
};

const adoptedActionStatusLabels: Record<LifestylePlanV2['adoptedActions'][number]['status'], string> = {
  proposed: '待安排', discussed: '已讨论', planned: '已计划', in_progress: '进行中',
  paused: '已暂停', completed: '已完成', dismissed: '已取消'
};

const eventTypeLabels: Record<HealthEventV2['type'], string> = {
  checkup: '体检', laboratory: '检验', imaging: '影像', outpatient: '门诊', inpatient: '住院',
  self_measurement: '本人测量', manual_note: '本人补充', other: '检查'
};

export function systemStatusLabel(system: BodySystemSummaryV2): string {
  return systemReadingStatus(system).label;
}

function evidenceRequest(title: string, evidence: MemberEvidenceRef): EvidenceRequest {
  return {
    title,
    label: evidence.label,
    quote: evidence.quote ?? '查看原报告中的对应内容。',
    meta: evidence.locator ?? '原始资料',
    sourceSpanId: evidence.sourceSpanId,
    documentId: evidence.documentId
  };
}

function FindingSourceLinks({ label, sources, onOpenEvidence }: { label: string; sources: MemberEvidenceRef[]; onOpenEvidence(request: EvidenceRequest): void }) {
  if (sources.length === 0) return null;
  const links = sources.map((source) => <button key={source.id} className="evidence-link"
    aria-label={`查看${label}原文${source.locator ? ` · ${source.locator}` : ''}`}
    onClick={() => onOpenEvidence(evidenceRequest(`${label}原始依据`, source))}>
    {sources.length === 1 ? '查看原文' : `${source.label}${source.locator ? ` · ${source.locator}` : ''}`}
  </button>);
  return sources.length === 1 ? links : <details className="evidence-disclosure evidence-disclosure--compact"><summary>查看原文（{sources.length}处）</summary><div className="evidence-source-list">{links}</div></details>;
}

function ReportMetadataEditor({ event, busy, failed, onCancel, onSave }: {
  event: HealthEventDetailV2;
  busy: boolean;
  failed: boolean;
  onCancel(): void;
  onSave(input: Pick<UpdateReportMetadataInput, 'title' | 'organization' | 'department' | 'clinicalTime' | 'reason'>): void;
}) {
  const [title, setTitle] = useState(event.title);
  const [organization, setOrganization] = useState(event.organization ?? '');
  const [department, setDepartment] = useState(event.department ?? '');
  const [precision, setPrecision] = useState<'year' | 'month' | 'day' | 'unknown'>(event.time.precision);
  const [dateValue, setDateValue] = useState(event.time.value ?? '');
  const [reason, setReason] = useState('本人核对原报告后修正');
  const submit = (submitEvent: FormEvent) => {
    submitEvent.preventDefault();
    onSave({
      title,
      organization: organization.trim() || null,
      department: department.trim() || null,
      clinicalTime: dateValue.trim() ? { value: dateValue.trim(), precision } : { value: null, precision: 'unknown' },
      reason
    });
  };
  return <form className="event-metadata-editor" onSubmit={submit}>
    <div className="panel__heading"><div><span className="eyebrow">仅修正事件信息</span><h3>核对报告标题、机构和日期</h3></div></div>
    <p className="muted-copy">修正会更新时间线和相关分析，不会改写原报告或已提取的检查数值。</p>
    <div className="event-metadata-editor__grid">
      <label>报告标题<input value={title} onChange={(input) => setTitle(input.target.value)} required maxLength={200} /></label>
      <label>机构<input value={organization} onChange={(input) => setOrganization(input.target.value)} maxLength={200} placeholder="原报告未写可留空" /></label>
      <label>科室<input value={department} onChange={(input) => setDepartment(input.target.value)} maxLength={200} placeholder="原报告未写可留空" /></label>
      <label>报告日期写到哪里<select value={precision} onChange={(input) => { const next = input.target.value as typeof precision; setPrecision(next); if (next === 'unknown') setDateValue(''); }}><option value="day">写明年月日</option><option value="month">只写年月</option><option value="year">只写年份</option><option value="unknown">日期不确定</option></select></label>
      {precision !== 'unknown' && <label>检查日期<input type={precision === 'day' ? 'date' : precision === 'month' ? 'month' : 'number'} min={precision === 'year' ? '1900' : undefined} max={precision === 'year' ? '2200' : undefined} value={dateValue} onChange={(input) => setDateValue(input.target.value)} required /></label>}
      <label className="event-metadata-editor__reason">修正说明<input value={reason} onChange={(input) => setReason(input.target.value)} required maxLength={300} /></label>
    </div>
    {failed && <p role="alert" className="form-error">保存失败，可能该事件已被其他操作更新。请返回时间线后重试。</p>}
    <div className="dialog-actions"><button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>取消</button><button type="submit" className="primary-button" disabled={busy}>{busy ? '正在保存' : '保存修正'}</button></div>
  </form>;
}

function MemberHeader({ snapshot, person, onSelectPerson, onAddPerson, onEditPerson, onArchivedPeople, onUploadReports, onAddNote, onExport, onRefreshAssessment }: {
  snapshot: DashboardSnapshot;
  person: PersonSummary;
  onSelectPerson(id: string): void;
  onAddPerson(): void;
  onEditPerson(): void;
  onArchivedPeople(): void;
  onUploadReports(personId: string): void;
  onAddNote(): void;
  onExport(): void;
  onRefreshAssessment(): void;
}) {
  const assessmentBusy = snapshot.jobs.some((job) => job.personLabel === person.displayName
    && ['queued', 'running', 'waiting_auth', 'waiting_quota', 'waiting_user', 'retry_wait'].includes(job.status));
  const canRefreshAssessment = person.acceptedFactCount > 0 && /^[a-f0-9]{64}$/.test(person.dataRevision)
    && !assessmentBusy;
  return <div className="member-header panel">
    <div className="member-header__identity"><span className="avatar avatar--large">{person.avatarInitial}</span><div><span className="eyebrow">个人健康解读</span><h1>{person.displayName}</h1><p>{person.relation}{person.lastDocumentDate ? ` · 最近资料 ${person.lastDocumentDate}` : ''}</p></div></div>
    <div className="member-header__controls">
      <select value={person.id} onChange={(event) => onSelectPerson(event.target.value)} aria-label="切换成员">{snapshot.persons.map((item) => <option key={item.id} value={item.id}>{item.displayName} · {item.relation}</option>)}</select>
      <details className="member-header__secondary member-header__more"><summary>更多管理<ChevronDown size={16} aria-hidden="true" /></summary><div>{person.acceptedFactCount > 0 && <button className="secondary-button" disabled={!canRefreshAssessment} onClick={onRefreshAssessment} title={assessmentBusy ? '这位成员已有处理任务，完成后可再更新' : !canRefreshAssessment ? '请刷新成员档案后再试' : undefined}><RefreshCw size={17} /> 仅更新健康解读</button>}<button className="secondary-button" onClick={onEditPerson}>编辑成员</button><button className="secondary-button" onClick={onAddPerson}><Plus size={17} /> 添加成员</button><button className="secondary-button" onClick={onArchivedPeople}><Archive size={17} /> 已归档成员</button><button className="secondary-button" onClick={onExport}><FileCheck2 size={17} /> 导出摘要</button></div></details>
    </div>
    <div className="member-header__entry-actions" aria-label="为当前成员添加资料">
      <div className="member-entry-action"><button className="primary-button" aria-describedby="member-report-upload-description" onClick={() => onUploadReports(person.id)}><Upload size={18} aria-hidden="true" /> 上传报告</button><p id="member-report-upload-description" className="member-entry-action__copy">上传 PDF、图片等文件，整理到{person.displayName}的档案。</p></div>
      <div className="member-entry-action"><button className="secondary-button" aria-describedby="member-manual-note-description" onClick={() => onAddNote()}><Plus size={18} aria-hidden="true" /> 手动补充</button><p id="member-manual-note-description" className="member-entry-action__copy">填写症状、用药、自测结果和生活情况。</p></div>
    </div>
  </div>;
}

function SystemDirectory({ systems, selected, onSelect }: { systems: BodySystemSummaryV2[]; selected: BodySystemId | null; onSelect(id: BodySystemId): void }) {
  return <nav className="system-directory" aria-label="身体系统目录">
    {systems.map((system) => <button key={system.id} className={selected === system.id ? 'is-active' : ''} onClick={() => onSelect(system.id)}>
      <span className={`system-directory__symbol is-reading-${systemReadingStatus(system).tone}`}>{systemSymbol[system.id]}</span>
      <span><strong>{system.shortName}</strong></span>
      <em className="system-directory__status">{systemStatusLabel(system)}</em><ChevronRight size={17} />
    </button>)}
  </nav>;
}

export function systemAnalysisHeading(headline: string, keyPoints: Array<{ text: string }>) {
  if (keyPoints.length === 0) return headline;
  const normalize = (value: string) => value.toLocaleLowerCase('zh-CN').replace(/[\s，。；：、,.!?！？:;（）()\-—]/g, '');
  const normalizedHeadline = normalize(headline);
  const repeatedPointCount = keyPoints.filter((point) => normalizedHeadline.includes(normalize(point.text))).length;
  return repeatedPointCount >= Math.min(2, keyPoints.length) ? '这套资料目前说明什么' : headline;
}

function SystemAnalysisCard({ detail, sourceDates, onOpenEvidence }: { detail: BodySystemDetailV2; sourceDates: Record<string, string>; onOpenEvidence(request: EvidenceRequest): void }) {
  const original = detail.analysis;
  if (!original) return null;
  const displayHeadline = memberText(original.headline) || memberText(original.keyPoints[0]?.text) || '已有检查记录，暂时还没有健康解读';
  const overview = additionalMemberText(original.overview, [displayHeadline]);
  const seen = [displayHeadline, overview];
  const keyPoints = original.keyPoints.map((point) => {
    const text = additionalMemberText(point.text, seen);
    seen.push(text);
    const limitations = uniqueMemberTexts(point.limitations, seen);
    seen.push(...limitations);
    return { ...point, text, limitations };
  });
  const analysis = { ...original, keyPoints,
    conflicts: original.conflicts.map((item) => ({ ...item, text: memberText(item.text) })).filter((item) => item.text),
    discussionPoints: original.discussionPoints.map((item) => ({ ...item, text: memberText(item.text) })).filter((item) => item.text),
    recommendations: (original.recommendations ?? []).map((item) => ({ ...item, title: memberText(item.title), why: memberText(item.why), firstStep: memberText(item.firstStep),
      schedule: memberText(item.schedule), reviewPlan: memberText(item.reviewPlan), importantCaution: memberText(item.importantCaution) })).filter((item) => item.title && item.firstStep)
  };
  const boundaries = uniqueMemberTexts([...(analysis.clinicallyImportantUnknowns ?? []), ...analysis.dataGaps.flatMap((gap) => [gap.text, gap.consequence])], seen);
  const evidence = [...new Map([
    ...analysis.keyPoints.flatMap((point) => point.evidence),
    ...analysis.conflicts.flatMap((conflict) => conflict.evidence),
    ...analysis.discussionPoints.flatMap((point) => point.evidence),
    ...(analysis.recommendations ?? []).flatMap((point) => point.evidence)
  ].map((item) => [item.id, item])).values()];
  const personalEvidence = evidence.filter((item) => item.kind !== 'knowledge');
  const knowledgeEvidence = evidence.filter((item) => item.kind === 'knowledge' && item.locator);
  return <article className="system-analysis-card">
    <div className="panel__heading"><div><span className="eyebrow">整体解读</span><h3>{displayHeadline}</h3><small>{analysis.scope.clinicalAsOf ? `有明确检查日期的资料截至 ${analysis.scope.clinicalAsOf}` : '报告时间见各份资料'}</small></div></div>
    {overview && <p className="system-analysis-overview">{overview}</p>}
    {analysis.status === 'stale' && <p className="muted-copy">这段解读基于较早资料，请结合下方最新报告结果理解。</p>}
    {analysis.keyPoints.some((point) => point.text || point.limitations.length > 0) && <section className="analysis-explanation"><h4>为什么这样判断</h4><div className="system-analysis-points">{analysis.keyPoints.filter((point) => point.text || point.limitations.length > 0).map((point) => <section key={point.id}>{point.text && <p>{point.text}</p>}{point.limitations.length > 0 && <small>{point.limitations.join(' ')}</small>}</section>)}</div></section>}
    {(analysis.recommendations ?? []).length > 0 && <section className="analysis-recommendations"><h4>接下来怎么做</h4><div>{analysis.recommendations.map((recommendation) => <article key={recommendation.id}><h5>{recommendation.title}</h5><p>{recommendation.why}</p><dl><div><dt>先做什么</dt><dd>{recommendation.firstStep}</dd></div>{recommendation.schedule && <div><dt>什么时候做</dt><dd>{recommendation.schedule}</dd></div>}{recommendation.reviewPlan && <div><dt>何时回看</dt><dd>{recommendation.reviewPlan}</dd></div>}</dl>{recommendation.importantCaution && <small>{recommendation.importantCaution}</small>}</article>)}</div></section>}
    {analysis.conflicts.length > 0 && <div className="info-callout compact"><ShieldCheck size={18} /><div><strong>资料中有需保留的差异</strong><p>{analysis.conflicts.map((item) => item.text).join(' ')}</p></div></div>}
    {analysis.discussionPoints.length > 0 && <section className="analysis-discussion-points"><h4>下次可与医生讨论</h4><ul>{analysis.discussionPoints.map((point, index) => {
      const reportedSource = point.source === 'clinician_reported' ? reportPlanSource({
        kind: 'documented_plan', timingBasis: 'none', title: point.text, firstStep: point.text, timing: null,
        evidenceIds: point.evidence.map((item) => item.id)
      }, point.evidence, sourceDates) : null;
      return <li key={`${point.text}-${index}`}>{point.source === 'clinician_reported' && <small>{reportedSource ? `报告中的医生建议 · ${reportedSource}` : '行动建议 · 安排前请结合当前情况与医生确认。'}</small>}{point.text}</li>;
    })}</ul></section>}
    {boundaries.length > 0 && <details className="analysis-boundaries"><summary>理解这份解读时需注意</summary>{boundaries.map((text) => <p key={text}>{text}</p>)}</details>}
    {personalEvidence.length > 0 && <details className="evidence-disclosure"><summary><FileCheck2 size={16} /> 查看个人资料依据</summary><div className="evidence-source-list">{personalEvidence.map((item, index) => <button key={`${item.id}-${index}`} className="evidence-link" onClick={() => onOpenEvidence(evidenceRequest(`${detail.registry.shortName}综合说明依据 ${index + 1}`, item))}>依据 {index + 1} · {item.label}</button>)}</div></details>}
    {knowledgeEvidence.length > 0 && <details className="evidence-disclosure"><summary>查看通用医学来源</summary><div className="knowledge-source-list">{knowledgeEvidence.map((item) => <a key={item.id} href={item.locator!} target="_blank" rel="noreferrer"><strong>{item.label}</strong><small>{item.quote}</small></a>)}</div></details>}
  </article>;
}

export function assessmentKnowledgeStatusLabel(status: MemberAssessmentSnapshotV3['knowledgeVerifications'][number]['status'] | undefined): string {
  if (status === 'tool_content_verified') return '公开医学资料';
  if (status === 'catalog_curated') return '通用医学资料';
  return 'AI 提供的医学资料';
}

export function diagnosticStatusLabel(status: string | null | undefined): string | null {
  if (!status) return null;
  if (status === 'documented') return '报告记录的诊断';
  if (status === 'criteria_met') return '符合参考条件，仍需医生确认';
  if (status === 'possible' || status === 'suspected') return '一种可能的解释，需医生确认';
  if (status === 'undetermined') return '目前还不能确定';
  return '结合报告的参考解释';
}

function AssessmentClaimSources({ assessment, claim, sourceLabel = '查看原始依据', evidenceTitle = '判断依据', onOpenEvidence }: {
  assessment: MemberAssessmentSnapshotV3;
  claim: Pick<MemberAssessmentSnapshotV3['claims'][number], 'evidenceIds' | 'knowledgeSourceIds'>;
  sourceLabel?: string;
  evidenceTitle?: string;
  onOpenEvidence(request: EvidenceRequest): void;
}) {
  const evidence = [...new Map((claim.evidenceIds ?? []).flatMap((id) => assessment.evidenceCatalog.filter((item) => item.id === id))
    .map((item) => [item.id, item])).values()];
  const knowledgeSources = [...new Map((claim.knowledgeSourceIds ?? []).flatMap((id) => assessment.knowledgeSources.filter((item) => item.id === id))
    .map((item) => [item.id, item])).values()];
  const evidenceLinks = evidence.map((item) => <button key={item.id} className="evidence-link"
      aria-label={evidence.length > 1 ? `${sourceLabel}：${item.label}${item.locator ? ` · ${item.locator}` : ''}` : undefined}
      onClick={() => onOpenEvidence(evidenceRequest(evidenceTitle, item))}><FileCheck2 size={16} /> {evidence.length > 1 ? `${item.label}${item.locator ? ` · ${item.locator}` : ''}` : sourceLabel}</button>);
  return <>
    {evidence.length > 1 ? <details className="evidence-disclosure evidence-disclosure--compact"><summary>{sourceLabel}（{evidence.length}处）</summary><div className="evidence-source-list">{evidenceLinks}</div></details> : evidenceLinks}
    {knowledgeSources.length > 0 && <details className="evidence-disclosure"><summary>查看医学知识来源</summary><div className="knowledge-source-list">{knowledgeSources.map((source) => {
      const label = assessmentKnowledgeStatusLabel(assessment.knowledgeVerifications?.find((item) => item.sourceId === source.id)?.status);
      return source.url ? <a key={source.id} href={source.url} target="_blank" rel="noreferrer"><strong>{source.title}</strong><span>{label}</span></a>
        : <span key={source.id}><strong>{source.title}</strong> · {label}</span>;
    })}</div></details>}
  </>;
}

export function MemberAssessmentSystemCard({ assessment, systemId, factCount, sourceDates = {}, onOpenEvidence }: {
  assessment: MemberAssessmentSnapshotV3;
  systemId: BodySystemId;
  factCount: number;
  sourceDates?: Record<string, string>;
  onOpenEvidence(request: EvidenceRequest): void;
}) {
  const system = assessment.systems.find((item) => item.systemId === systemId);
  if (!system) return null;
  const claims = system.claimIds.map((id) => assessment.claims.find((item) => item.id === id))
    .filter((item): item is MemberAssessmentSnapshotV3['claims'][number] => Boolean(item));
  const actions = system.actionIds.map((id) => assessment.actions.find((item) => item.id === id))
    .filter((item): item is MemberAssessmentSnapshotV3['actions'][number] => Boolean(item));
  const headline = memberText(system.headline) || memberText(claims[0]?.text)
    || (factCount > 0 ? '已有相关检查记录' : '相关检查资料');
  const headlineClaim = claims.find((claim) => memberText(claim.text) && !additionalMemberText(claim.text, [headline]));
  const headlineDiagnosticLabel = diagnosticStatusLabel(headlineClaim?.diagnosticStatus);
  const summary = additionalMemberText(system.summary, [headline]);
  const seen = [headline, summary];
  const visibleClaims = claims.map((claim) => {
    const text = additionalMemberText(claim.text, seen);
    seen.push(text);
    const rationale = /^(?:报告)?原文(?:记载|记录|显示)[。.]?$/.test(claim.rationale) ? '' : additionalMemberText(claim.rationale, seen);
    seen.push(rationale);
    const materialUncertainty = additionalMemberText(claim.materialUncertainty, seen);
    seen.push(materialUncertainty);
    const diagnosticLabel = claim.id === headlineClaim?.id ? null : diagnosticStatusLabel(claim.diagnosticStatus);
    return { ...claim, text, rationale, materialUncertainty, diagnosticLabel };
  });
  const headlineSources = visibleClaims.filter((claim) => !claim.text);
  const detailClaims = visibleClaims.filter((claim) => claim.text || claim.rationale || claim.materialUncertainty || claim.diagnosticLabel || claim.changeAssessment);
  const limitations = uniqueMemberTexts(system.limitations, seen);
  return <article className="system-analysis-card">
    <div className="panel__heading"><div><span className="eyebrow">{claims.length > 0 ? '这部分身体情况' : '检查与报告'}</span><h3>{headline}</h3></div>{headlineDiagnosticLabel && <StatusBadge tone="info">{headlineDiagnosticLabel}</StatusBadge>}</div>
    {assessment.status === 'stale' && <p className="muted-copy">这份解读仍可回看；更新后可将新的建议加入计划。</p>}
    {summary && <p className="system-analysis-overview">{summary}</p>}
    {headlineSources.length > 0 && <div className="evidence-source-list">{headlineSources.map((claim) => <AssessmentClaimSources key={claim.id} assessment={assessment} claim={claim} onOpenEvidence={onOpenEvidence} />)}</div>}
    {detailClaims.length > 0 && <section className="analysis-explanation"><h4>相关结果与说明</h4><p className="reading-explanation-intro">先看检查发现，再看它说明什么；可能的解释不等于已经确定的原因。</p><div className="system-analysis-points">{detailClaims.map((claim) =>
      <section className="reading-claim" key={claim.id}>
        <span className="reading-section-label">{claim.kind === 'source_fact' ? '报告中的发现' : claim.kind === 'trend' ? '和以前相比' : '这说明什么'}</span>
        {memberText(claim.title) && <h5>{memberText(claim.title)}</h5>}
        {(claim.text || claim.diagnosticLabel) && <div className="panel__heading">{claim.text && <p>{claim.text}</p>}{claim.diagnosticLabel && <StatusBadge tone="info">{claim.diagnosticLabel}</StatusBadge>}</div>}
        {claim.changeAssessment && <div className="reading-claim__meaning"><strong>和以前相比 · {assessmentChangeLabel(claim.changeAssessment.direction)}</strong><p>{memberText(claim.changeAssessment.summary)}</p><p>{memberText(claim.changeAssessment.reason)}</p></div>}
        {claim.rationale && <div className="reading-claim__meaning"><strong>如何理解</strong><p>{claim.rationale}</p></div>}
        {claim.materialUncertainty && <div className="reading-claim__condition"><strong>理解时别忽略</strong><p>{claim.materialUncertainty}</p></div>}
        {claim.text && <AssessmentClaimSources assessment={assessment} claim={claim} onOpenEvidence={onOpenEvidence} />}
      </section>
    )}</div></section>}
    {actions.length > 0 && <section className="analysis-recommendations"><h4>接下来怎么做</h4><div>{actions.map((action) => {
      const reportedSource = action.kind === 'documented_plan' ? reportPlanSource(action, assessment.evidenceCatalog ?? [], sourceDates, assessment) : null;
      return <article key={action.id}>
        {action.kind === 'documented_plan' && <small>{reportedSource ? `报告中的医生建议 · ${reportedSource} · 请与医生确认这条安排现在是否仍适用。` : '行动建议 · 安排前请结合当前情况与医生确认。'}</small>}
        <h5>{memberText(action.title)}</h5>{additionalMemberText(action.why, [memberText(action.title)]) && <p>{additionalMemberText(action.why, [memberText(action.title)])}</p>}
        <dl>{memberActionFirstStep(action) && <div><dt>第一步</dt><dd>{memberActionFirstStep(action)}</dd></div>}{memberText(action.timing) && <div><dt>何时</dt><dd>{memberText(action.timing)}</dd></div>}{memberText(action.reviewPlan) && <div><dt>何时回看</dt><dd>{memberText(action.reviewPlan)}</dd></div>}</dl>{memberText(action.caution) && <small>{memberText(action.caution)}</small>}
        <AssessmentClaimSources assessment={assessment} claim={action} sourceLabel="查看建议依据" evidenceTitle="建议依据" onOpenEvidence={onOpenEvidence} />
      </article>;
    })}</div></section>}
    {limitations.length > 0 && <details className="analysis-boundaries"><summary>理解这份解读时需注意</summary>{limitations.map((text) => <p key={text}>{text}</p>)}</details>}
    {assessment.comparisonCoverage?.missingTopicKeys.some((key) => claims.some((claim) => claim.topicKey === key))
      && <p className="muted-copy">这部分有重点问题尚缺前后变化的解释，现有检查结果与建议仍可查看。</p>}
  </article>;
}

function SystemDetail({ detail, assessment, sourceDates, search, onSearch, selectedMetric, metricLoading, metricError, onSelectMetric, onOpenEvidence }: {
  detail: BodySystemDetailV2;
  assessment: MemberAssessmentSnapshotV3 | null;
  sourceDates: Record<string, string>;
  search: string;
  onSearch(value: string): void;
  selectedMetric: MetricSeriesDetailV2[] | null;
  metricLoading: boolean;
  metricError: boolean;
  onSelectMetric(id: string | null): void;
  onOpenEvidence(request: EvidenceRequest): void;
}) {
  if (selectedMetric) return <MetricHistory key={selectedMetric[0]!.id} series={selectedMetric} onOpenEvidence={(title, evidence) => onOpenEvidence(evidenceRequest(title, evidence))} onBack={() => onSelectMetric(null)} />;
  const query = search.trim().toLocaleLowerCase('zh-CN');
  const metrics = groupMetricSeries(detail.metrics).filter((group) => !query || group.series.some((metric) => metric.name.toLocaleLowerCase('zh-CN').includes(query)));
  const matchedFindings = detail.findings.filter((finding) => !query || `${finding.title}${finding.value}`.toLocaleLowerCase('zh-CN').includes(query));
  const findings = matchedFindings.filter((finding) => !isUnprovidedResult(finding.value));
  const unprovided = matchedFindings.filter((finding) => isUnprovidedResult(finding.value));
  return <section className="system-detail">
    <div className="system-detail__hero"><span className={`system-directory__symbol is-reading-${systemReadingStatus(detail.summary).tone}`}>{systemSymbol[detail.registry.id]}</span><div><span className="eyebrow">{detail.registry.name}</span><h2>{detail.registry.shortName}</h2></div></div>
    {assessment?.systems.some((item) => item.systemId === detail.registry.id)
      ? <MemberAssessmentSystemCard assessment={assessment} systemId={detail.registry.id} factCount={detail.summary.factCount} sourceDates={sourceDates} onOpenEvidence={onOpenEvidence} />
      : detail.analysis ? <SystemAnalysisCard detail={detail} sourceDates={sourceDates} onOpenEvidence={onOpenEvidence} />
        : <p className="body-copy">{memberText(detail.summary.summary) || (detail.summary.factCount > 0 ? '已有检查结果，暂时还没有健康解读。' : '还没有这部分身体的检查记录。')}</p>}
    <label className="member-search"><Search size={18} /><span className="sr-only">搜索本系统指标</span><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder={`搜索${detail.registry.shortName}指标`} /></label>
    <div className="system-section-heading"><div><h3>指标与历史</h3><p>点击指标，查看历次结果和当次报告参考范围。</p></div><StatusBadge tone="neutral">{metrics.length} 项</StatusBadge></div>
    {metricLoading && <p role="status">正在读取这个指标的全部历史…</p>}
    {metricError && <p role="alert">部分历史暂时未能读取，请再点一次指标重试。</p>}
    {metrics.length > 0 ? <div className="system-metric-list">{metrics.map((metric) => <button key={metric.id} className={metric.series.length === 1 ? 'has-reading-preview' : ''} disabled={metricLoading} onClick={() => onSelectMetric(metric.id)}><span><strong>{metric.name}</strong><small>{memberText(metric.description)}</small></span><ReadingMetricPreview series={metric.series} /><span className="metric-latest"><b>{metric.latestValue}</b><small>{metric.dateLabel}{metric.latestDate && metric.reportDatedCount > 0 ? ` · 另有 ${metric.reportDatedCount} 条仅对应报告时间` : ''}{metric.latestDate && metric.unknownDateCount > 0 ? ` · 另有 ${metric.unknownDateCount} 条日期未记录` : ''}</small></span><ChevronRight size={17} /></button>)}</div> : <div className="table-empty compact-empty"><Activity size={24} /><strong>{query ? '没有匹配的指标' : '还没有数值检查结果'}</strong><span>{query ? '可以清空搜索词重试。' : '如有报告文字结果，可在下方查看。'}</span></div>}
    {findings.length > 0 && <><div className="system-section-heading"><div><h3>报告中的文字结果与建议</h3></div></div><div className="system-finding-grid">{findings.map((finding) => <article key={finding.id}>{isReportAdviceName(finding.title) && <small>报告中的医生建议 · {reportDateLabel(finding.time.displayLabel)}</small>}<div><strong>{finding.title}</strong>{!isReportAdviceName(finding.title) && <small>{reportDateLabel(finding.time.displayLabel)}</small>}</div><b>{finding.value}</b>{finding.evidence[0] && <button className="evidence-link" onClick={() => onOpenEvidence(evidenceRequest(`${finding.title}原始依据`, finding.evidence[0]!))}><FileCheck2 size={16} /> 查看依据</button>}</article>)}</div></>}
    {unprovided.length > 0 && <details className="analysis-boundaries unprovided-results"><summary>原报告未提供结果（{unprovided.length} 项）</summary><p>原报告没有提供这些结果，无法据此判断是否正常。</p>{unprovided.map((finding) => <div key={finding.id}><strong>{finding.title}</strong><span>{finding.value || '空白'}</span>{finding.evidence[0] && <button className="evidence-link" onClick={() => onOpenEvidence(evidenceRequest(`${finding.title}原始依据`, finding.evidence[0]!))}>查看依据</button>}</div>)}</details>}
  </section>;
}

function AdoptedActionCard({ action }: { action: LifestylePlanV2['adoptedActions'][number] }) {
  const title = adoptedActionTitle(action);
  // 具体做法已由服务区分 AI 派生正文和本人输入；目标、负责人、备注及进度原样显示。
  return <div className="completed-item adopted-action-card"><Check size={18} /><div><strong>{title}</strong>
    {action.userGoal.trim() !== title.trim() && <span>{action.userGoal}</span>}
    <p className="adopted-action-card__detail">{action.selectedStartingOption}</p>
    <small>进度：{adoptedActionStatusLabels[action.status]}</small>
    <small>负责人：{action.owner}</small>
    {action.reportTiming && <small>原建议时间：{action.reportTiming}</small>}
    {action.plannedTime && <small>我的安排：{action.plannedTime}</small>}
    {action.dueDate && <small>我设定的日期：{action.dueDate}</small>}
    {action.progressNote && <small>备注：{action.progressNote}</small>}
  </div></div>;
}

function PriorityIssueCard({ issue, onSelectSystem }: {
  issue: MemberOverviewV2['priorityIssues'][number];
  onSelectSystem(systemId: BodySystemId): void;
}) {
  const title = memberText(issue.title);
  const explanation = additionalMemberText(issue.explanation, [title]);
  const nextStep = memberText(issue.nextStep);
  const relatedExplanations = (issue.relatedExplanations ?? []).map((related) => ({ ...related,
    title: memberText(related.title), explanation: memberText(related.explanation)
  })).filter((related) => related.title || related.explanation);
  // 仅去掉完整相同的行动，不拆掉带条件或时间的原句。
  const nextStepsSeen = new Set([nextStep]);
  const additionalNextSteps = (issue.additionalNextSteps ?? []).map(memberText).filter((step) => {
    if (!step || nextStepsSeen.has(step)) return false;
    nextStepsSeen.add(step);
    return true;
  });
  return <article className="priority-issue-card" aria-label={title}>
    <button className="priority-issue-card__heading" onClick={() => onSelectSystem(issue.systemId)}><strong>{title}</strong><ChevronRight size={18} /></button>
    {explanation && <div className="priority-issue-card__meaning"><span className="reading-section-label">为什么值得留意</span><p>{explanation}</p></div>}
    {nextStep && <p className="priority-issue-card__next-step">先做：{nextStep}</p>}
    {(relatedExplanations.length > 0 || additionalNextSteps.length > 0) && <details className="priority-issue-card__details">
      <summary>查看相关解释与其他安排</summary>
      {relatedExplanations.map((related) => <section key={related.id}><strong>{related.title}</strong>{additionalMemberText(related.explanation, [related.title]) && <p>{additionalMemberText(related.explanation, [related.title])}</p>}</section>)}
      {additionalNextSteps.length > 0 && <section><strong>其他安排</strong>{additionalNextSteps.map((step) => <p key={step}>{step}</p>)}</section>}
    </details>}
  </article>;
}

function LifestyleProposalCard({ proposal: originalProposal, index, busy, canAdopt, sourceDates, onAdopt, onDecide, onOpenEvidence }: {
  proposal: LifestylePlanV2['proposals'][number];
  index: number;
  busy: boolean;
  canAdopt: boolean;
  sourceDates: Record<string, string>;
  onAdopt(input: Omit<AdoptLifestyleProposalInput, 'personId' | 'proposalId'>): void;
  onDecide(decision: 'dismiss' | 'restore'): void;
  onOpenEvidence(request: EvidenceRequest): void;
}) {
  const proposal = { ...originalProposal,
    title: memberText(originalProposal.title), goal: memberText(originalProposal.goal), rationale: memberText(originalProposal.rationale),
    steps: uniqueMemberTexts(originalProposal.steps), startingOptions: uniqueMemberTexts(originalProposal.startingOptions),
    scheduleSuggestion: memberText(originalProposal.scheduleSuggestion), trackingSuggestion: memberText(originalProposal.trackingSuggestion),
    constraints: uniqueMemberTexts(originalProposal.constraints), uncertainties: uniqueMemberTexts(originalProposal.uncertainties)
  };
  const [showAdoptionForm, setShowAdoptionForm] = useState(false);
  const [userGoal, setUserGoal] = useState(proposal.goal);
  const [selectedStartingOption, setSelectedStartingOption] = useState(proposal.startingOptions[0] ?? proposal.steps[0] ?? proposal.title);
  const [plannedTime, setPlannedTime] = useState(proposal.scheduleSuggestion ?? '');
  const [owner, setOwner] = useState('本人');
  const [dueDate, setDueDate] = useState('');
  const [progressNote, setProgressNote] = useState('');
  const statusLabel = proposal.status === 'adopted' ? '已采纳' : proposal.status === 'dismissed' ? '暂不采纳' : '待决定';
  const reportedSource = proposal.sourceKind === 'clinician_reported' ? reportPlanSource({
    kind: 'documented_plan', timingBasis: 'documented', title: proposal.title, firstStep: proposal.steps[0] ?? proposal.title,
    timing: proposal.scheduleSuggestion, evidenceIds: proposal.evidence.map((item) => item.id)
  }, proposal.evidence, sourceDates) : null;
  const sourceLabel = proposal.sourceKind === 'clinician_reported'
    ? reportedSource ? '报告中的医生建议' : '行动建议'
    : proposal.sourceKind === 'care_preparation' ? '记录或就医准备' : 'AI 整理建议';
  return <article className={proposal.status === 'dismissed' ? 'is-muted' : ''}>
    <span className="member-proposal-list__index">{index + 1}</span>
    <div>
      <div className="panel__heading"><div><span className="eyebrow">{sourceLabel} · {proposal.category === 'exercise' ? '活动' : proposal.category === 'diet' ? '饮食' : proposal.category === 'sleep' ? '作息' : proposal.category === 'monitoring' ? '日常记录' : proposal.category === 'review' ? '就医准备' : '生活方向'}</span><h3>{proposal.title}</h3></div><StatusBadge tone={proposal.status === 'adopted' ? 'success' : 'neutral'}>{statusLabel}</StatusBadge></div>
      {proposal.sourceKind === 'clinician_reported' && <small>{reportedSource ? `${reportedSource} · 请与医生确认这条安排现在是否仍适用。` : '安排前请结合当前情况与医生确认。'}</small>}
      <p className="proposal-goal"><strong>目标：</strong>{proposal.goal}</p>
      <p>{proposal.rationale}</p>
      {!canAdopt && proposal.status === 'proposed' && <p className="muted-copy">这条建议基于较早资料，请先更新健康解读；已有计划及进度仍保留。</p>}
      <details>
        <summary>查看怎么开始、依据与限制</summary>
        <div className="proposal-structure">
          <section><h4>具体行动</h4><ol>{proposal.steps.map((step) => <li key={step}>{step}</li>)}</ol></section>
          <section><h4>可以从这里开始</h4><ul>{proposal.startingOptions.map((option) => <li key={option}>{option}</li>)}</ul></section>
          {proposal.scheduleSuggestion && <section><h4>时间安排参考</h4><p>{proposal.scheduleSuggestion}</p></section>}
          <section><h4>如何低负担记录</h4><p>{proposal.trackingSuggestion}</p></section>
          {(proposal.constraints.length > 0 || proposal.uncertainties.length > 0) && <section><h4>适用边界</h4><ul>{proposal.constraints.map((item) => <li key={item}>{item}</li>)}{proposal.uncertainties.map((item) => <li key={item}>尚不确定：{item}</li>)}</ul></section>}
          <section><h4>这项建议与哪些资料有关</h4>{proposal.evidence.length > 0 ? <div className="evidence-source-list">{proposal.evidence.map((evidence, evidenceIndex) => <button key={`${evidence.id}-${evidenceIndex}`} className="evidence-link" onClick={() => onOpenEvidence(evidenceRequest(`${proposal.title}个人依据 ${evidenceIndex + 1}`, evidence))}>查看相关资料 {evidenceIndex + 1}</button>)}</div> : <p>这项建议帮助你记录情况或准备就医，并不表示检查结果有异常。</p>}</section>
          {proposal.generalKnowledgeEvidence.length > 0 && <section><h4>一般知识来源</h4><div className="knowledge-source-list">{proposal.generalKnowledgeEvidence.map((source) => <a key={source.id} href={source.sourceUrl} target="_blank" rel="noreferrer"><strong>{source.sourceTitle}</strong><span>{source.sourceOrganization} · {source.verificationStatus === 'controlled_source_verified' ? '公开医学资料' : 'AI 提供的医学资料'}</span><small>{memberText(source.supportedScope)}</small></a>)}</div></section>}
          {proposal.consultProfessional && <p className="proposal-boundary">明显改变做法前，建议结合本人限制向医生或营养、运动专业人员确认。</p>}
        </div>
      </details>
      {proposal.status === 'proposed' && showAdoptionForm && <form className="proposal-adoption-form" onSubmit={(event) => {
        event.preventDefault();
        onAdopt({
          userGoal,
          selectedStartingOption,
          plannedTime: plannedTime.trim() || null,
          owner,
          progressNote: progressNote.trim() || null,
          dueDate: dueDate || null
        });
      }}>
        <div className="panel__heading"><div><span className="eyebrow">由你决定</span><h4>把建议改成自己的行动</h4></div></div>
        <p className="muted-copy">按自己的时间和身体情况安排。</p>
        <label>我的目标<input value={userGoal} onChange={(event) => setUserGoal(event.target.value)} maxLength={300} required /></label>
        <label>从哪一步开始<select value={selectedStartingOption} onChange={(event) => setSelectedStartingOption(event.target.value)}>{proposal.startingOptions.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
        <div className="proposal-adoption-form__grid">
          <label>计划时间<input value={plannedTime} onChange={(event) => setPlannedTime(event.target.value)} maxLength={200} placeholder="例如：工作日晚饭后" /></label>
          <label>负责人<input value={owner} onChange={(event) => setOwner(event.target.value)} maxLength={120} required /></label>
          <label>希望何时回顾<input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></label>
        </div>
        <label>起始备注（可选）<textarea value={progressNote} onChange={(event) => setProgressNote(event.target.value)} maxLength={500} placeholder="例如：近期膝盖不适，先观察感受" /></label>
        <div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => setShowAdoptionForm(false)}>取消</button><button type="submit" className="primary-button" disabled={busy}>{busy ? '正在保存' : '确认加入行动'}</button></div>
      </form>}
      <div className="proposal-actions">
        {proposal.status === 'proposed' && !showAdoptionForm && <><button className="secondary-button" disabled={busy || !canAdopt} onClick={() => setShowAdoptionForm(true)}>{canAdopt ? '采纳为我的行动' : '更新解读后可加入计划'}</button>{canAdopt && <button className="text-button" disabled={busy} onClick={() => onDecide('dismiss')}>暂不采纳</button>}</>}
        {proposal.status === 'adopted' && <span className="proposal-adopted"><Check size={16} /> 已加入自己的计划</span>}
        {proposal.status === 'dismissed' && canAdopt && <button className="text-button" disabled={busy} onClick={() => onDecide('restore')}>恢复为待决定</button>}
      </div>
    </div>
  </article>;
}

export function MemberProfileV2({ snapshot, person, onSelectPerson, onOpenEvidence, onAddPerson, onEditPerson, onArchivedPeople, onUploadReports, onAddNote, onExport, onRefreshAssessment, onCorrectDocumentDate, onExcludeDocument, onReincludeDocument, onDeleteDocument, onDeletedDocuments }: {
  snapshot: DashboardSnapshot;
  person: PersonSummary;
  onSelectPerson(id: string): void;
  onOpenEvidence(request: EvidenceRequest): void;
  onAddPerson(): void;
  onEditPerson(): void;
  onArchivedPeople(): void;
  onUploadReports(personId: string): void;
  onAddNote(question?: MemberQuestionPrompt): void;
  onExport(): void;
  onRefreshAssessment(): void;
  onCorrectDocumentDate?(document: InboxItem): void;
  onExcludeDocument(document: InboxItem): void;
  onReincludeDocument(document: InboxItem): void;
  onDeleteDocument(document: InboxItem): void;
  onDeletedDocuments(): void;
}) {
  const [tab, setTab] = useState<MemberTab>('overview');
  const [overview, setOverview] = useState<MemberOverviewV2 | null>(null);
  const [overallExpanded, setOverallExpanded] = useState(false);
  const [assessment, setAssessment] = useState<MemberAssessmentSnapshotV3 | null>(null);
  const [systems, setSystems] = useState<BodySystemSummaryV2[]>([]);
  const [selectedSystem, setSelectedSystem] = useState<BodySystemId | null>(null);
  const [systemDetail, setSystemDetail] = useState<BodySystemDetailV2 | null>(null);
  const [selectedMetric, setSelectedMetric] = useState<MetricSeriesDetailV2[] | null>(null);
  const [metricLoading, setMetricLoading] = useState(false);
  const [metricError, setMetricError] = useState(false);
  const [events, setEvents] = useState<HealthEventV2[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<HealthEventDetailV2 | null>(null);
  const [editingEventMetadata, setEditingEventMetadata] = useState(false);
  const [eventMetadataBusy, setEventMetadataBusy] = useState(false);
  const [eventMetadataError, setEventMetadataError] = useState(false);
  const [eventRelationBusy, setEventRelationBusy] = useState(false);
  const [eventRelationError, setEventRelationError] = useState(false);
  const [showAllEventFindings, setShowAllEventFindings] = useState(false);
  const [mergeSourceEventId, setMergeSourceEventId] = useState('');
  const [eventType, setEventType] = useState<HealthEventV2['type'] | 'all'>('all');
  const [eventSystem, setEventSystem] = useState<BodySystemId | 'all'>('all');
  const [plan, setPlan] = useState<LifestylePlanV2 | null>(null);
  const [conceptReview, setConceptReview] = useState<ConceptReviewBundle | null>(null);
  const [conceptBusyId, setConceptBusyId] = useState<string | null>(null);
  const [conceptError, setConceptError] = useState(false);
  const [adoptingProposalId, setAdoptingProposalId] = useState<string | null>(null);
  const [adoptingAssessmentActionId, setAdoptingAssessmentActionId] = useState<string | null>(null);
  const [assessmentAdoptionError, setAssessmentAdoptionError] = useState(false);
  const [decidingProposalId, setDecidingProposalId] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadErrors, setLoadErrors] = useState<Partial<Record<MemberLoadRegion, boolean>>>({});
  const [retryingRegion, setRetryingRegion] = useState<MemberLoadRegion | null>(null);
  const [systemDetailError, setSystemDetailError] = useState(false);
  const [systemDetailRefreshToken, setSystemDetailRefreshToken] = useState(0);
  const loadError = Boolean(loadErrors.overview);
  const partialLoadError = Object.entries(loadErrors).some(([region, failed]) => region !== 'overview' && failed);
  const memberRequestGeneration = useRef(0);
  const metricRequestGeneration = useRef(0);
  const tabSectionStart = useRef<HTMLDivElement>(null);
  const previousTab = useRef(tab);

  useLayoutEffect(() => {
    if (previousTab.current === tab) return;
    previousTab.current = tab;
    // 只滚动内容区，避免 scrollIntoView 同时滚动外层窗口而挤走顶部栏。
    const section = tabSectionStart.current;
    const contentArea = section?.closest<HTMLElement>('.content-area');
    if (section && contentArea) {
      contentArea.scrollTop = Math.max(0, contentArea.scrollTop
        + section.getBoundingClientRect().top - contentArea.getBoundingClientRect().top);
    }
  }, [tab]);

  useEffect(() => () => { metricRequestGeneration.current += 1; }, [person.id, person.dataRevision]);

  useEffect(() => {
    let active = true;
    const generation = ++memberRequestGeneration.current;
    const bridge = window.healthDesktop;
    if (!bridge) {
      queueMicrotask(() => {
        if (!active) return;
        setLoadErrors({ overview: true, systems: true, events: true, plan: true, concept: true, assessment: true });
        setLoading(false);
      });
      return () => { active = false; };
    }
    void Promise.allSettled([
      bridge.getMemberOverview?.(person.id) ?? Promise.reject(new Error('MEMBER_READER_UNAVAILABLE')),
      bridge.listBodySystems?.(person.id) ?? Promise.reject(new Error('MEMBER_READER_UNAVAILABLE')),
      bridge.listHealthEvents?.({ personId: person.id }) ?? Promise.reject(new Error('MEMBER_READER_UNAVAILABLE')),
      bridge.getLifestylePlan?.(person.id) ?? Promise.reject(new Error('MEMBER_READER_UNAVAILABLE')),
      bridge.getConceptReview?.(person.id) ?? Promise.reject(new Error('MEMBER_READER_UNAVAILABLE')),
      bridge.getMemberAssessment ? bridge.getMemberAssessment(person.id) : Promise.resolve({ ok: true as const, data: null })
    ]).then(([overviewSettled, systemsSettled, eventsSettled, planSettled, conceptSettled, assessmentSettled]) => {
      if (!active || generation !== memberRequestGeneration.current) return;
      const overviewResult = overviewSettled.status === 'fulfilled' ? overviewSettled.value : null;
      const systemsResult = systemsSettled.status === 'fulfilled' ? systemsSettled.value : null;
      const eventsResult = eventsSettled.status === 'fulfilled' ? eventsSettled.value : null;
      const planResult = planSettled.status === 'fulfilled' ? planSettled.value : null;
      const conceptResult = conceptSettled.status === 'fulfilled' ? conceptSettled.value : null;
      const assessmentResult = assessmentSettled.status === 'fulfilled' ? assessmentSettled.value : null;
      if (overviewResult?.ok) { setOverview(overviewResult.data); setOverallExpanded(assessmentOverviewText(overviewResult.data.overview).length <= 320); }
      if (systemsResult?.ok) {
        setSystems(systemsResult.data);
        setSelectedSystem((current) => current && systemsResult.data.some((system) => system.id === current)
          ? current
          : systemsResult.data.find((system) => system.factCount > 0)?.id ?? systemsResult.data[0]?.id ?? null);
      }
      if (eventsResult?.ok) setEvents(eventsResult.data);
      if (planResult?.ok) setPlan(planResult.data);
      if (conceptResult?.ok) setConceptReview(conceptResult.data);
      setAssessment(assessmentResult?.ok ? assessmentResult.data : null);
      setLoadErrors({ overview: !overviewResult?.ok, systems: !systemsResult?.ok, events: !eventsResult?.ok,
        plan: !planResult?.ok, concept: !conceptResult?.ok, assessment: !assessmentResult?.ok });
      setRetryingRegion(null);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; if (memberRequestGeneration.current === generation) memberRequestGeneration.current += 1; };
  }, [person.id, person.dataRevision, refreshToken]);

  async function retryRegion<T>(region: MemberLoadRegion, request: () => Promise<Result<T>>, apply: (data: T) => void) {
    if (retryingRegion) return;
    const generation = memberRequestGeneration.current;
    setRetryingRegion(region);
    try {
      const result = await request();
      if (generation !== memberRequestGeneration.current) return;
      if (result.ok) apply(result.data);
      setLoadErrors((current) => ({ ...current, [region]: !result.ok }));
    } catch {
      if (generation === memberRequestGeneration.current) setLoadErrors((current) => ({ ...current, [region]: true }));
    } finally {
      if (generation === memberRequestGeneration.current) setRetryingRegion(null);
    }
  }

  const retryMemberRegion = (region: MemberLoadRegion) => {
    const bridge = window.healthDesktop;
    if (!bridge) return;
    if (region === 'overview' && bridge.getMemberOverview) void retryRegion(region, () => bridge.getMemberOverview(person.id), setOverview);
    if (region === 'systems' && bridge.listBodySystems) void retryRegion(region, () => bridge.listBodySystems(person.id), (data) => {
      setSystems(data);
      setSelectedSystem((current) => current && data.some((system) => system.id === current)
        ? current : data.find((system) => system.factCount > 0)?.id ?? data[0]?.id ?? null);
    });
    if (region === 'events' && bridge.listHealthEvents) void retryRegion(region, () => bridge.listHealthEvents({ personId: person.id }), setEvents);
    if (region === 'plan' && bridge.getLifestylePlan) void retryRegion(region, () => bridge.getLifestylePlan(person.id), setPlan);
    if (region === 'assessment' && bridge.getMemberAssessment) void retryRegion(region, () => bridge.getMemberAssessment(person.id), setAssessment);
    if (region === 'concept' && bridge.getConceptReview) void retryRegion(region, () => bridge.getConceptReview(person.id), setConceptReview);
  };
  const regionFailure = (region: MemberLoadRegion, title: string, description: string, retryLabel: string) =>
    <section className="panel personal-empty-state" role="alert"><ShieldCheck size={28} /><div><h2>{title}</h2><p>{description}</p><button className="secondary-button" disabled={retryingRegion !== null} onClick={() => retryMemberRegion(region)}>{retryingRegion === region ? '正在重试…' : retryLabel}</button></div></section>;

  useEffect(() => {
    if (!overview?.sourceUrgentNotices.length && !overview?.currentSymptomNotices.length) return;
    const now = new Date();
    const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const timer = window.setTimeout(() => setRefreshToken((current) => current + 1), nextMidnight.getTime() - now.getTime());
    return () => window.clearTimeout(timer);
  }, [overview?.sourceUrgentNotices.length, overview?.currentSymptomNotices.length, refreshToken]);

  useEffect(() => {
    if (!selectedSystem) return;
    let active = true;
    const bridge = window.healthDesktop;
    if (!bridge?.getBodySystemDetail) {
      queueMicrotask(() => { if (active) setSystemDetailError(true); });
      return () => { active = false; };
    }
    void bridge.getBodySystemDetail(person.id, selectedSystem).then((result) => {
      if (!active) return;
      setSystemDetailError(!result?.ok);
      if (result?.ok) setSystemDetail(result.data);
    }).catch(() => { if (active) setSystemDetailError(true); });
    return () => { active = false; };
  }, [person.id, person.dataRevision, selectedSystem, systemDetailRefreshToken]);

  useEffect(() => {
    if (!selectedEventId) return;
    let active = true;
    const bridge = window.healthDesktop;
    if (!bridge?.getHealthEventDetail) return;
    void bridge.getHealthEventDetail(person.id, selectedEventId).then((result) => {
      if (!active) return;
      if (result?.ok) setSelectedEvent(result.data);
      else {
        setSelectedEventId(null);
        setSelectedEvent(null);
      }
    });
    return () => { active = false; };
  }, [person.id, person.dataRevision, selectedEventId, refreshToken]);

  const chooseMetric = (seriesId: string | null) => {
    const generation = ++metricRequestGeneration.current;
    setMetricError(false);
    setMetricLoading(false);
    if (!seriesId) { setSelectedMetric(null); return; }
    const bridge = window.healthDesktop;
    if (!bridge?.getMetricSeries || !systemDetail) return;
    const group = groupMetricSeries(systemDetail.metrics).find((item) => item.id === seriesId);
    if (!group) return;
    setMetricLoading(true);
    void Promise.all(group.series.map((item) => bridge.getMetricSeries(person.id, item.id))).then((results) => {
      if (generation !== metricRequestGeneration.current) return;
      if (results.some((result) => !result?.ok)) { setMetricError(true); return; }
      setSelectedMetric(results.flatMap((result) => result.ok ? [result.data] : []));
    }).catch(() => {
      if (generation === metricRequestGeneration.current) setMetricError(true);
    }).finally(() => {
      if (generation === metricRequestGeneration.current) setMetricLoading(false);
    });
  };
  const chooseSystem = (systemId: BodySystemId) => {
    metricRequestGeneration.current += 1;
    setSelectedMetric(null);
    setMetricLoading(false);
    setMetricError(false);
    setSystemDetailError(false);
    setSelectedSystem(systemId);
  };
  const chooseEvent = (eventId: string) => {
    setSelectedEventId(eventId);
    setShowAllEventFindings(false);
    setEditingEventMetadata(false);
    setEventMetadataError(false);
    setEventRelationError(false);
    setMergeSourceEventId('');
  };
  const saveEventMetadata = (values: Pick<UpdateReportMetadataInput, 'title' | 'organization' | 'department' | 'clinicalTime' | 'reason'>) => {
    const bridge = window.healthDesktop;
    if (!bridge?.updateReportMetadata || !selectedEvent?.reportId || eventMetadataBusy) return;
    setEventMetadataBusy(true);
    setEventMetadataError(false);
    void bridge.updateReportMetadata({
      personId: person.id,
      reportId: selectedEvent.reportId,
      expectedRevision: selectedEvent.metadataRevision,
      ...values
    }).then((result) => {
      if (!result?.ok) { setEventMetadataError(true); return; }
      setEditingEventMetadata(false);
      setRefreshToken((value) => value + 1);
    }).finally(() => setEventMetadataBusy(false));
  };
  const undoEventMetadata = () => {
    const bridge = window.healthDesktop;
    if (!bridge?.undoReportMetadata || !selectedEvent?.reportId || eventMetadataBusy) return;
    setEventMetadataBusy(true);
    setEventMetadataError(false);
    void bridge.undoReportMetadata({
      personId: person.id,
      reportId: selectedEvent.reportId,
      expectedRevision: selectedEvent.metadataRevision
    }).then((result) => {
      if (!result?.ok) { setEventMetadataError(true); return; }
      setRefreshToken((value) => value + 1);
    }).finally(() => setEventMetadataBusy(false));
  };
  const mergeEvent = () => {
    const bridge = window.healthDesktop;
    if (!bridge?.mergeHealthEvents || !selectedEvent || !mergeSourceEventId || eventRelationBusy) return;
    setEventRelationBusy(true);
    setEventRelationError(false);
    void bridge.mergeHealthEvents({
      personId: person.id,
      targetEventId: selectedEvent.id,
      sourceEventId: mergeSourceEventId,
      reason: '本人确认这些报告属于同一次检查'
    }).then((result) => {
      if (!result?.ok) { setEventRelationError(true); return; }
      setRefreshToken((value) => value + 1);
    }).finally(() => setEventRelationBusy(false));
  };
  const splitReportFromEvent = (reportId: string) => {
    const bridge = window.healthDesktop;
    if (!bridge?.splitHealthEvent || !selectedEvent || eventRelationBusy) return;
    setEventRelationBusy(true);
    setEventRelationError(false);
    void bridge.splitHealthEvent({
      personId: person.id,
      eventId: selectedEvent.id,
      reportId,
      reason: '本人确认这份报告不属于本次检查'
    }).then((result) => {
      if (!result?.ok) { setEventRelationError(true); return; }
      setRefreshToken((value) => value + 1);
    }).finally(() => setEventRelationBusy(false));
  };
  const undoEventRelation = () => {
    const bridge = window.healthDesktop;
    if (!bridge?.undoHealthEventRelation || !selectedEvent?.relationChangeId || eventRelationBusy) return;
    setEventRelationBusy(true);
    setEventRelationError(false);
    void bridge.undoHealthEventRelation({ personId: person.id, changeId: selectedEvent.relationChangeId }).then((result) => {
      if (!result?.ok) { setEventRelationError(true); return; }
      setRefreshToken((value) => value + 1);
    }).finally(() => setEventRelationBusy(false));
  };
  const adoptProposal = (proposal: LifestylePlanV2['proposals'][number], adoption: Omit<AdoptLifestyleProposalInput, 'personId' | 'proposalId'>) => {
    const bridge = window.healthDesktop;
    if (!bridge?.adoptLifestyleProposal || adoptingProposalId) return;
    setAdoptingProposalId(proposal.id);
    void bridge.adoptLifestyleProposal({
      personId: person.id,
      proposalId: proposal.id,
      ...adoption
    }).then((result) => {
      if (!result?.ok) return;
      setPlan((current) => current ? {
        ...current,
        proposals: current.proposals.map((item) => item.id === proposal.id ? { ...item, status: 'adopted' } : item),
        adoptedActions: [...current.adoptedActions, {
          id: result.data.id,
          proposalId: proposal.id,
          title: result.data.title,
          userGoal: result.data.userGoal,
          selectedStartingOption: result.data.selectedStartingOption,
          plannedTime: result.data.plannedTime,
          owner: result.data.owner,
          progressNote: result.data.progressNote,
          status: 'planned',
          dueDate: result.data.dueDate,
          updatedAt: result.data.updatedAt
        }]
      } : current);
    }).finally(() => setAdoptingProposalId(null));
  };
  const adoptAssessmentAction = (actionId: string) => {
    const bridge = window.healthDesktop;
    if (!assessment || assessment.status === 'stale' || !bridge?.adoptMemberAssessmentAction || adoptingAssessmentActionId) return;
    setAdoptingAssessmentActionId(actionId);
    setAssessmentAdoptionError(false);
    void bridge.adoptMemberAssessmentAction({ personId: person.id, snapshotId: assessment.id, actionId }).then((result) => {
      if (!result?.ok) { setAssessmentAdoptionError(true); return; }
      setRefreshToken((value) => value + 1);
    }).catch(() => setAssessmentAdoptionError(true)).finally(() => setAdoptingAssessmentActionId(null));
  };
  const decideProposal = (proposalId: string, decision: 'dismiss' | 'restore') => {
    const bridge = window.healthDesktop;
    if (!bridge?.setLifestyleProposalDecision || decidingProposalId) return;
    setDecidingProposalId(proposalId);
    void bridge.setLifestyleProposalDecision({ personId: person.id, proposalId, decision }).then((result) => {
      if (!result?.ok) return;
      setPlan((current) => current ? {
        ...current,
        proposals: current.proposals.map((item) => item.id === proposalId ? { ...item, status: result.data.status } : item)
      } : current);
    }).finally(() => setDecidingProposalId(null));
  };
  const saveConceptMapping = (input: SetConceptMappingInput) => {
    const bridge = window.healthDesktop;
    if (!bridge?.setConceptMapping || conceptBusyId) return;
    setConceptBusyId(input.observationId);
    setConceptError(false);
    void bridge.setConceptMapping(input).then((result) => {
      if (!result?.ok) { setConceptError(true); return; }
      setRefreshToken((current) => current + 1);
    }).finally(() => setConceptBusyId(null));
  };
  const undoConceptMapping = (observationId: string) => {
    const bridge = window.healthDesktop;
    if (!bridge?.undoConceptMapping || conceptBusyId) return;
    setConceptBusyId(observationId);
    setConceptError(false);
    void bridge.undoConceptMapping({ personId: person.id, observationId }).then((result) => {
      if (!result?.ok) { setConceptError(true); return; }
      setRefreshToken((current) => current + 1);
    }).finally(() => setConceptBusyId(null));
  };
  const tabs: Array<[MemberTab, string]> = [['overview', '健康总览'], ['body', '身体与指标'], ['guidance', '日常生活'], ['timeline', '检查时间线'], ['sources', '原始资料']];
  const assessmentActionAdoptions = (action: HealthAction) => plan?.personId === person.id
    ? plan.adoptedActions.filter((item) => item.id === action.id || Boolean(action.dedupeKey && item.assessmentDedupeKey === action.dedupeKey))
      .map((item) => ({ ...item, status: snapshot.actions.find((saved) => saved.personId === person.id && saved.id === item.id)?.status ?? item.status }))
    : [];
  const nextActions = (overview?.nextActions ?? []).map((action) => {
    // 综合建议的默认文案不是个人计划状态；同成员的原项 ID 或稳定键可以关联，不能按标题猜测。
    const assessmentAction = assessment?.actions.find((item) => item.id === action.id);
    const matchingAdoptions = assessmentAction ? assessmentActionAdoptions(assessmentAction)
      : plan?.personId === person.id ? plan.adoptedActions.filter((item) => item.id === action.id) : [];
    const adopted = matchingAdoptions.find((item) => item.status !== 'dismissed') ?? matchingAdoptions[0];
    const saved = snapshot.actions.find((item) => item.personId === person.id && item.id === (adopted?.id ?? action.id));
    // 非综合的旧入口可能直接返回本人或医生安排，只凭真实来源整理，不按标题猜测。
    const title = assessmentAction ? memberText(action.title) : saved ? savedActionTitle(action.title, saved.origin) : action.title;
    return { ...action, title, status: saved?.status ?? adopted?.status ?? action.status };
  });
  const personDocuments = snapshot.inbox.filter((document) => document.personId === person.id);
  const filteredEvents = events.filter((event) => (
    (eventType === 'all' || event.type === eventType)
    && (eventSystem === 'all' || event.systemIds.includes(eventSystem))
  )).map((event) => ({ ...event, summary: memberEventSummary(event.summary) }));
  const eventsById = new Map(events.map((event) => [event.id, event]));
  const mergeableEvents = selectedEvent?.reports.length && window.healthDesktop?.mergeHealthEvents
    ? events.filter((event) => event.id !== selectedEvent.id && event.documentIds.length > 0)
    : [];
  const canSplitEvent = Boolean(selectedEvent && selectedEvent.reports.length > 1 && window.healthDesktop?.splitHealthEvent);
  const canUndoEventRelation = Boolean(selectedEvent?.relationCanUndo && selectedEvent.relationChangeId && window.healthDesktop?.undoHealthEventRelation);
  const canOrganizeEvent = mergeableEvents.length > 0 || canSplitEvent || canUndoEventRelation;
  const eventFindings = selectedEvent?.findings ?? [];
  const attentionEventFindings = eventFindings.filter((finding) => ['high', 'low', 'positive'].includes(finding.abnormalFlag));
  const ordinaryEventFindings = eventFindings.filter((finding) => !['high', 'low', 'positive'].includes(finding.abnormalFlag));
  const eventFindingPreviewLimit = 18;
  const previewEventFindings = [
    ...attentionEventFindings,
    ...ordinaryEventFindings.slice(0, Math.max(0, eventFindingPreviewLimit - attentionEventFindings.length))
  ];
  const visibleEventFindings = showAllEventFindings ? eventFindings : previewEventFindings;
  const eventFindingDateGroups = [...visibleEventFindings.reduce((groups, finding) => {
    const date = finding.time?.value ?? null;
    const key = `${finding.time?.precision ?? 'unknown'}:${date ?? 'unknown'}`;
    const group = groups.get(key) ?? { key, date, label: finding.time?.displayLabel ?? '检查日期未记录', findings: [] };
    group.findings.push(finding);
    groups.set(key, group);
    return groups;
  }, new Map<string, { key: string; date: string | null; label: string; findings: HealthEventDetailV2['findings'] }>()).values()]
    .sort((left, right) => (right.date ?? '').localeCompare(left.date ?? ''));
  const sourceDates = reportDates(events);
  const sourceGroups = eventSourceGroups(selectedEvent?.evidence ?? []);
  const priorityIssues = (overview?.priorityIssues ?? []).filter((issue) => memberText(issue.title));
  const ordinaryPriorityIssues = priorityIssues.filter((issue) => !issue.isHighPriority);
  const previewOrdinaryIds = new Set(ordinaryPriorityIssues.slice(0, 3).map((issue) => issue.id));
  const visiblePriorityIssues = priorityIssues.filter((issue) => issue.isHighPriority || previewOrdinaryIds.has(issue.id));
  const remainingPriorityIssues = ordinaryPriorityIssues.slice(3);
  const openPrioritySystem = (systemId: BodySystemId) => { chooseSystem(systemId); setTab('body'); };
  const lifestyle = dailyLifeContent(assessment?.actions ?? [], assessment ? [] : plan?.proposals ?? []);
  const renderAssessmentAction = (action: HealthAction) => {
    if (!assessment) return null;
    const matchingAdoptions = assessmentActionAdoptions(action);
    const adopted = matchingAdoptions.find((item) => item.id === action.id && item.status !== 'dismissed')
      ?? matchingAdoptions.find((item) => item.status !== 'dismissed');
    const reportedSource = action.kind === 'documented_plan' ? reportPlanSource(action, assessment.evidenceCatalog ?? [], sourceDates, assessment) : null;
    const label = action.kind === 'documented_plan' ? reportedSource ? '报告中的医生建议' : '行动建议'
      : action.kind === 'seek_care' ? '就医准备' : action.kind === 'test_followup' ? '复查'
        : action.kind === 'treatment_discussion' ? '与医生讨论治疗' : action.lifestyleBasis === 'general' ? '通用建议'
          : action.lifestyleBasis === 'personalized' ? '结合你的情况' : '日常建议';
    return <article className="assessment-action-card" key={action.id}>
      <div className="panel__heading"><div><span className="eyebrow">{label}</span><h3>{memberText(action.title)}</h3></div><StatusBadge tone={action.urgency === 'urgent' || action.urgency === 'emergency' ? 'warning' : 'info'}>{action.urgency === 'emergency' ? '尽快寻求急救' : action.urgency === 'urgent' ? '及时处理' : action.urgency === 'soon' ? '近期安排' : '按需安排'}</StatusBadge></div>
      {action.kind === 'documented_plan' && <small>{reportedSource ? `${reportedSource} · 请与医生确认这条安排现在是否仍适用。` : '安排前请结合当前情况与医生确认。'}</small>}
      {additionalMemberText(action.why, [memberText(action.title)]) && <p>{additionalMemberText(action.why, [memberText(action.title)])}</p>}
      <dl>{memberActionFirstStep(action) && <div><dt>{['habit', 'self_monitor'].includes(action.kind) ? '怎么做' : '第一步'}</dt><dd>{memberActionFirstStep(action)}</dd></div>}{memberText(action.timing) && <div><dt>何时</dt><dd>{memberText(action.timing)}</dd></div>}{memberText(action.reviewPlan) && <div><dt>何时回看</dt><dd>{memberText(action.reviewPlan)}</dd></div>}</dl>
      {memberText(action.caution) && <small>{memberText(action.caution)}</small>}
      <AssessmentClaimSources assessment={assessment} claim={action} sourceLabel="查看建议依据" evidenceTitle="建议依据" onOpenEvidence={onOpenEvidence} />
      {adopted ? <p className="muted-copy">已加入后续事项 · {actionStatusLabel(adopted.status)}</p> : <button className="secondary-button" onClick={() => adoptAssessmentAction(action.id)} disabled={assessment.status === 'stale' || adoptingAssessmentActionId !== null}>{adoptingAssessmentActionId === action.id ? '正在加入' : assessment.status === 'stale' ? '更新解读后可加入计划' : '加入后续事项'}</button>}
    </article>;
  };
  const renderProposal = (proposal: LifestylePlanV2['proposals'][number], index: number) => <LifestyleProposalCard key={proposal.id} proposal={proposal} sourceDates={sourceDates} index={index} busy={adoptingProposalId !== null || decidingProposalId !== null} canAdopt={plan?.status === 'current'} onAdopt={(adoption) => adoptProposal(proposal, adoption)} onDecide={(decision) => decideProposal(proposal.id, decision)} onOpenEvidence={onOpenEvidence} />;
  const renderDailyItem = (item: DailyLifeItem, index: number) => item.action ? renderAssessmentAction(item.action) : item.proposal ? renderProposal(item.proposal, index) : null;

  return <div className="page-stack member-profile-v2">
    <MemberHeader snapshot={snapshot} person={person} onSelectPerson={onSelectPerson} onAddPerson={onAddPerson} onEditPerson={onEditPerson} onArchivedPeople={onArchivedPeople} onUploadReports={onUploadReports} onAddNote={onAddNote} onExport={onExport} onRefreshAssessment={onRefreshAssessment} />
    {person.acceptedFactCount > 0 && person.derivedStatus !== 'current'
      && !snapshot.jobs.some((job) => job.personLabel === person.displayName
        && ['queued', 'running', 'waiting_auth', 'waiting_quota', 'waiting_user', 'retry_wait'].includes(job.status))
      && <section className="info-callout assessment-refresh-callout" role="status">
      <RefreshCw size={20} aria-hidden="true" />
      <div><strong>{person.assessmentRefreshStatus === 'optional_rules' ? '现有健康解读可继续查看' : '健康解读暂未更新'}</strong><p>{person.assessmentRefreshStatus === 'optional_rules' ? '现有解读仍对应当前资料。后续上传的资料会按新版规则自动整理。' : '报告结果已保存，现有内容仍可查看；后续上传资料会自动整理并更新健康看板。'}</p></div>
    </section>}
    {overview?.personId === person.id && overview.currentSymptomNotices.length > 0 && <section className="source-urgent-notices" role="alert" aria-label="本人今天记录的症状提示">
      {overview.currentSymptomNotices.map((notice) => <div className="source-urgent-notice" key={notice.id}>
        <AlertTriangle size={22} aria-hidden="true" />
        <div><strong>你今天记录了需要及时处理的症状</strong><p>如果现在仍有持续胸痛并伴大汗或冷汗，请立即拨打 120，不要自己开车去医院。这里依据的是本人自述，不代表应用已诊断病因。</p><details><summary>查看本人记录</summary><p>{notice.sourceLabel}：{notice.sourceExcerpt}</p></details></div>
      </div>)}
    </section>}
    {overview?.personId === person.id && overview.sourceUrgentNotices.length > 0 && <section className="source-urgent-notices" role="alert" aria-label="报告原文的及时处理提示">
      {overview.sourceUrgentNotices.map((notice) => <div className="source-urgent-notice" key={notice.id}>
        <AlertTriangle size={22} aria-hidden="true" />
        <div><strong>{notice.instructionLevel === 'immediate_care' ? '这份近期报告原文要求立即就医' : '这份近期报告原文提示需要及时处理'}</strong><p>{notice.clinicalDate} · {notice.itemName}。{notice.instructionLevel === 'immediate_care' ? '如果尚未处理，请按原报告的急诊/就医要求尽快行动，并联系出具机构核实。' : '如果尚未处理，请尽快联系出具报告的医疗机构核实。'}这里转述的是报告提示，不代表应用判断你现在发生急症。</p></div>
        <button className="secondary-button" onClick={() => onOpenEvidence({
          title: '报告原文的及时处理提示', label: notice.sourceLabel,
          quote: notice.sourceExcerpt, meta: `${notice.clinicalDate} · ${notice.itemName}`,
          sourceSpanId: notice.sourceSpanId, documentId: notice.documentId
        })}>查看原文</button>
      </div>)}
    </section>}
    {partialLoadError && <div className="info-callout compact" role="status"><ShieldCheck size={18} /><div><strong>部分内容暂时无法打开</strong><p>已经打开的内容仍可查看。请在相应栏目重试未打开的内容。</p></div></div>}
    <div className="member-tab-section" ref={tabSectionStart}>
    <div className="tabs member-tabs" role="tablist">{tabs.map(([id, label]) => <button role="tab" aria-selected={tab === id} className={tab === id ? 'is-active' : ''} key={id} onClick={() => setTab(id)}>{label}</button>)}</div>
    {(loading || (!loadError && overview?.personId !== person.id)) && <section className="panel table-empty"><LoaderCircle size={24} className="spin" /><strong>正在打开成员档案</strong></section>}
    {!loading && loadError && tab === 'overview' && regionFailure('overview', '暂时无法打开成员档案', '健康总览暂时无法读取，已有报告仍保存在本机。其他已打开的栏目仍可查看，也可重新打开这部分内容。', '重试健康总览')}
    {!loading && overview?.personId === person.id && !loadError && overview && tab === 'overview' && <div className="member-v2-overview">
      <section className="panel member-health-headline"><div><span className="eyebrow">{assessment?.status === 'stale' ? person.assessmentRefreshStatus === 'optional_rules' ? '已发布整体解读' : '此前整体解读' : '现在怎样'}</span><h2>{assessmentOverviewText(overview.headline) || (overview.acceptedFactCount > 0 ? '已有检查记录，暂时还没有健康解读' : '还没有健康资料')}</h2>{assessment?.status === 'stale' && <p className="muted-copy">已发布解读{assessment.generatedAt ? ` · ${assessment.generatedAt.slice(0, 10)}` : ''}{person.assessmentRefreshStatus === 'optional_rules' ? '，基于此前规则，仍对应当前资料；可选择按新规则更新。' : '，需结合当前资料更新。'}</p>}{assessmentOverviewText(overview.overview) && assessmentOverviewText(overview.overview) !== assessmentOverviewText(overview.headline) && <>
        {!overallExpanded && <ReadingPriorityPreview issues={priorityIssues} onSelectSystem={openPrioritySystem} />}
        {overallExpanded && <p className="overall-health-summary">{assessmentOverviewText(overview.overview)}</p>}
        <button className="overall-health-expand" aria-expanded={overallExpanded} onClick={() => setOverallExpanded((value) => !value)}>{overallExpanded ? '收起完整整体情况' : '展开完整整体情况'}<ChevronDown size={16} /></button>
      </>}{!assessment && systems.some((system) => system.analysisStatus === 'stale') && <p>此前的解读可在“身体与指标”中回看，请结合资料日期理解。</p>}<small>{overview.latestClinicalDate ? `有明确检查日期的资料截至 ${overview.latestClinicalDate}` : '报告时间见各份资料'}</small></div></section>
      {systems.length > 0 && <div className="panel wide-panel reading-map-panel"><ReadingHealthMap systems={systems} onSelectSystem={openPrioritySystem} /></div>}
      {priorityIssues.length > 0 && <section className="panel result-first-section"><div className="panel__heading"><div><span className="eyebrow">最值得先看</span><h2>优先关注</h2></div></div><div className="priority-issue-list">{visiblePriorityIssues.map((issue) => <PriorityIssueCard key={issue.id} issue={issue} onSelectSystem={openPrioritySystem} />)}</div>{remainingPriorityIssues.length > 0 && <details className="priority-issue-overflow"><summary>查看其他关注事项（{remainingPriorityIssues.length}项）</summary><div className="priority-issue-list">{remainingPriorityIssues.map((issue) => <PriorityIssueCard key={issue.id} issue={issue} onSelectSystem={openPrioritySystem} />)}</div></details>}</section>}
      {overview.importantChanges.some((change) => memberText(change.title)) && <section className="panel result-first-section"><div className="panel__heading"><div><span className="eyebrow">和以前相比</span><h2>有意义的变化</h2></div></div><div className="important-change-list">{overview.importantChanges.filter((change) => memberText(change.title)).map((change) => <button key={change.id} onClick={() => { chooseSystem(change.systemId); setTab('body'); }}><span><strong>{memberText(change.title)}</strong>{additionalMemberText(change.meaning, [memberText(change.title)]) && <p>{additionalMemberText(change.meaning, [memberText(change.title)])}</p>}</span><ChevronRight size={18} /></button>)}</div></section>}
      {systems.length > 0 && <section className="panel wide-panel">
        <div className="panel__heading"><div><span className="eyebrow">按身体查看</span><h2>有资料的身体系统</h2></div></div>
        <div className="system-summary-grid">{systems.filter((system) => system.factCount > 0).map((system) => {
          const reading = systemReadingStatus(system);
          return <button key={system.id} onClick={() => { chooseSystem(system.id); setTab('body'); }}>
            <span className={`system-directory__symbol is-reading-${reading.tone}`}>{systemSymbol[system.id]}</span>
            <span><strong>{system.shortName}</strong><small>{memberText(system.summary)}</small></span>
            <StatusBadge tone={reading.tone}>{reading.label}</StatusBadge><ChevronRight size={17} />
          </button>;
        })}</div>
        {systems.some((system) => system.factCount === 0) && <details className="empty-system-disclosure">
          <summary>查看尚无相关检查的系统</summary><div>{systems.filter((system) => system.factCount === 0).map((system) =>
            <button key={system.id} onClick={() => { chooseSystem(system.id); setTab('body'); }}>{system.shortName}<ChevronRight size={16} /></button>)}</div>
        </details>}
      </section>}
      <section className="panel"><div className="panel__heading"><h3>最近检查事件</h3><button className="text-button" onClick={() => setTab('timeline')}>查看全部</button></div>{overview.recentChanges.length > 0 ? <div className="recent-event-list">{overview.recentChanges.map((change) => <button key={change.id} onClick={() => setTab('timeline')}><CalendarClock size={18} /><span><strong>{change.title}</strong><small>{reportDateLabel(eventsById.get(change.id)?.time.displayLabel ?? change.date)} · {memberEventSummary(change.detail)}</small></span><ChevronRight size={16} /></button>)}</div> : <p className="muted-copy">还没有可归入时间线的检查事件。</p>}</section>
      <section className="panel"><div className="panel__heading"><h3>接下来</h3><button className="text-button" onClick={() => setTab('guidance')}>日常生活与安排</button></div>{nextActions.length > 0 ? <div className="recent-event-list">{nextActions.map((action) => <div key={action.id}><Check size={17} /><span><strong>{action.title}</strong><small>{actionStatusLabel(action.status)}</small></span></div>)}</div> : <p className="muted-copy">目前没有待办事项。</p>}</section>
    </div>}
    {!loading && tab === 'body' && <>
      {loadErrors.systems && regionFailure('systems', '暂时无法打开身体目录', '这次没有读到身体系统目录，不代表没有检查记录。', '重试身体目录')}
      {selectedEvent && <div className="context-return-bar"><span><strong>正在从检查事件查看身体系统</strong><small>{reportDateLabel(selectedEvent.time.displayLabel)} · {selectedEvent.title}</small></span><button className="secondary-button" onClick={() => setTab('timeline')}>返回这次检查</button></div>}
      {systems.length > 0 ? <div className="body-workspace"><aside className="panel"><div className="body-workspace__label"><span className="eyebrow">身体目录</span><strong>{systems.length} 个系统</strong></div><SystemDirectory systems={systems} selected={selectedSystem} onSelect={chooseSystem} /></aside><main className="panel">{systemDetailError ? <div className="table-empty" role="alert"><ShieldCheck size={24} /><strong>暂时无法打开身体检查记录</strong><span>已有报告未改变，请重试这部分记录。</span><button className="secondary-button" onClick={() => { setSystemDetailError(false); setSystemDetailRefreshToken((value) => value + 1); }}>重试身体检查记录</button></div> : systemDetail && selectedSystem === systemDetail.registry.id ? <SystemDetail detail={systemDetail} assessment={assessment} sourceDates={sourceDates} search={search} onSearch={setSearch} selectedMetric={selectedMetric} metricLoading={metricLoading} metricError={metricError} onSelectMetric={chooseMetric} onOpenEvidence={onOpenEvidence} /> : <div className="table-empty"><LoaderCircle size={24} className="spin" /><strong>正在打开身体检查记录</strong></div>}</main></div> : !loadErrors.systems && <section className="panel table-empty"><Activity size={24} /><strong>还没有身体检查记录</strong><span>添加报告后，可以按身体系统查看检查结果。</span></section>}
      {conceptError && <div className="info-callout compact"><ShieldCheck size={18} /><div><strong>这次归类没有保存</strong><p>原报告和检查结果未改变，可以稍后重试。</p></div></div>}
      {conceptReview && <ConceptReviewPanel bundle={conceptReview} busyObservationId={conceptBusyId} onSave={saveConceptMapping} onUndo={undoConceptMapping} onOpenEvidence={onOpenEvidence} />}
      {loadErrors.concept && regionFailure('concept', '暂时无法打开指标整理', '检查结果仍可查看，这次只未打开可选的名称整理内容。', '重试指标整理')}
    </>}
    {!loading && tab === 'timeline' && loadErrors.events && regionFailure('events', '暂时无法打开检查时间线', '这次没有读到检查记录，不代表此前没有检查。', '重试检查时间线')}
    {!loading && tab === 'timeline' && (!loadErrors.events || events.length > 0 || selectedEvent) && <section className="panel timeline-panel">{selectedEvent ? <div className="event-detail">
      <button className="text-button" onClick={() => { setSelectedEventId(null); setSelectedEvent(null); setShowAllEventFindings(false); }}>← 返回检查时间线</button>
      <div className="panel__heading"><div><span className="eyebrow">{reportDateLabel(selectedEvent.time.displayLabel)}</span><h2>{selectedEvent.title}</h2></div></div>
      {memberEventSummary(selectedEvent.summary) && <p className="body-copy">{memberEventSummary(selectedEvent.summary)}</p>}
      {selectedEvent.systemIds.length > 0 && <div className="event-system-links"><span><strong>这次检查涉及</strong></span><div>{selectedEvent.systemIds.map((systemId) => <button key={systemId} className="secondary-button" onClick={() => { chooseSystem(systemId); setTab('body'); }}>{systems.find((system) => system.id === systemId)?.shortName ?? bodySystemNames[systemId]}<ChevronRight size={15} /></button>)}</div></div>}
      {selectedEvent.reportId && <div className="event-metadata-actions"><button className="secondary-button" onClick={() => { setEditingEventMetadata((value) => !value); setEventMetadataError(false); }} disabled={eventMetadataBusy}>{editingEventMetadata ? '收起修正' : '修正报告信息'}</button>{selectedEvent.metadataCanUndo && <button className="text-button" onClick={undoEventMetadata} disabled={eventMetadataBusy}>撤销上次修正</button>}</div>}
      {editingEventMetadata && <ReportMetadataEditor event={selectedEvent} busy={eventMetadataBusy} failed={eventMetadataError} onCancel={() => setEditingEventMetadata(false)} onSave={saveEventMetadata} />}
      {canOrganizeEvent && <details className="event-organizer">
        <summary>整理这次检查的报告（可选）</summary>
        <p>只有报告放错了检查记录时才需要整理；这里的整理只改变时间线分组，不改报告原文和检查数值，并且可以撤销。</p>
        <div className="event-organizer__reports">
          {selectedEvent.reports.map((report) => <div key={report.reportId}><span><strong>{report.title}</strong><small>这次检查中的报告</small></span>{canSplitEvent && <button className="text-button" onClick={() => splitReportFromEvent(report.reportId)} disabled={eventRelationBusy}>拆成单独事件</button>}</div>)}
        </div>
        {mergeableEvents.length > 0 && <div className="event-organizer__merge"><label>另一条属于同次检查的记录<select value={mergeSourceEventId} onChange={(event) => setMergeSourceEventId(event.target.value)} disabled={eventRelationBusy}><option value="">由我选择需要合并的记录</option>{mergeableEvents.map((event) => <option key={event.id} value={event.id}>{reportDateLabel(event.time.displayLabel)} · {event.title}</option>)}</select></label><button className="secondary-button" onClick={mergeEvent} disabled={!mergeSourceEventId || eventRelationBusy}>合并到这次检查</button></div>}
        {canUndoEventRelation && <button className="text-button" onClick={undoEventRelation} disabled={eventRelationBusy}>撤销上次{selectedEvent.relationChangeAction === 'split' ? '拆分' : '合并'}</button>}
        {eventRelationError && <p role="alert" className="form-error">这次整理没有保存。资料和检查数值未改变，请返回时间线后重试。</p>}
      </details>}
      {selectedEvent.findings.length > 0 && <section className="event-findings-section">
        <div className="system-section-heading"><div><h3>检查结果</h3><p>{selectedEvent.findings.length > eventFindingPreviewLimit && !showAllEventFindings ? `先显示 ${visibleEventFindings.length} 条，已包含全部原报告留意项。` : '按项目各自的检查日期列出，保留原始结果和单位。'}</p></div><StatusBadge tone="neutral">{selectedEvent.findings.length} 条</StatusBadge></div>
        {eventFindingDateGroups.map((group) => <section key={group.key} aria-label={`检查结果 · ${reportDateLabel(group.label)}`}>
          <div className="system-section-heading"><h4>{reportDateLabel(group.label)}</h4><StatusBadge tone="neutral">{group.findings.length} 条</StatusBadge></div>
          <div className="event-detail__facts">{group.findings.map((finding) => <div key={finding.id} className={['high', 'low', 'positive'].includes(finding.abnormalFlag) ? 'is-attention' : ''}><span>{finding.label}</span><strong>{finding.value}</strong>{isReportAdviceName(finding.label) && <small>报告中的医生建议 · {reportDateLabel(group.label)}</small>}{['high', 'low', 'positive'].includes(finding.abnormalFlag) && <small>原报告标记需留意</small>}<FindingSourceLinks label={finding.label} sources={selectedEvent.evidence.filter((source) => source.observationId === finding.id)} onOpenEvidence={onOpenEvidence} /></div>)}</div>
        </section>)}
        {selectedEvent.findings.length > previewEventFindings.length && <button className="secondary-button event-findings-toggle" onClick={() => setShowAllEventFindings((value) => !value)}>{showAllEventFindings ? '收起完整结果' : `查看全部 ${selectedEvent.findings.length} 条结果`}</button>}
      </section>}
      {selectedEvent.historicalReferences.length > 0 && <section className="historical-reference-section"><div className="system-section-heading"><div><h3>本报告引用的历史结果</h3><p>这些数值来自当前报告的历史对比栏，不表示当时在当前机构完成检查。</p></div><StatusBadge tone="info">历史引用</StatusBadge></div>{selectedEvent.historicalReferences.map((reference) => <article key={`${reference.sourceReportTitle}-${reference.time.value}`}><header><strong>{reportDateLabel(reference.time.displayLabel)}</strong><small>由《{reference.sourceReportTitle}》引用</small></header><div className="event-detail__facts">{reference.findings.map((finding) => <div key={finding.id}><span>{finding.label}</span><strong>{finding.value}</strong><button className="evidence-link" onClick={() => onOpenEvidence(evidenceRequest(`${finding.label}历史依据`, finding.evidence))}>查看依据</button></div>)}</div></article>)}</section>}
      <div className="system-section-heading"><div><h3>来源与附件</h3></div><StatusBadge tone="neutral">{sourceGroups.length} 处</StatusBadge></div>
      <div className="evidence-source-list">{sourceGroups.map((group) => {
        const source = group.sources[0]!;
        const label = personDocuments.find((document) => document.id === source.documentId)?.displayName
          ?? selectedEvent.reports.find((report) => report.documentId === source.documentId)?.title ?? source.label;
        return <button key={group.key} className="evidence-link" onClick={() => onOpenEvidence(evidenceRequest(`${label}${source.locator ? ` · ${source.locator}` : ''}`, source))}><FileCheck2 size={16} /> {label}{source.locator ? ` · ${source.locator}` : ''}</button>;
      })}</div>
    </div> : <><div className="panel__heading"><div><span className="eyebrow">检查时间线</span><h2>按时间看每次检查</h2></div><StatusBadge tone="neutral">{filteredEvents.length} / {events.length} 次</StatusBadge></div><p className="body-copy">打开某次检查，可以查看当时发现了什么、涉及哪些身体系统，以及对应的原始依据。</p><div className="timeline-filters"><label>事件类型<select value={eventType} onChange={(event) => setEventType(event.target.value as HealthEventV2['type'] | 'all')}><option value="all">全部类型</option><option value="checkup">体检</option><option value="laboratory">检验</option><option value="imaging">影像</option><option value="outpatient">门诊</option><option value="inpatient">住院</option><option value="self_measurement">本人测量</option><option value="manual_note">本人补充</option><option value="other">其他检查</option></select></label><label>身体系统<select value={eventSystem} onChange={(event) => setEventSystem(event.target.value as BodySystemId | 'all')}><option value="all">全部系统</option>{systems.map((system) => <option key={system.id} value={system.id}>{system.shortName}</option>)}</select></label></div>{filteredEvents.length > 0 ? <div className="timeline-list">{filteredEvents.map((event) => <button key={event.id} onClick={() => chooseEvent(event.id)}><time>{reportDateLabel(event.time.displayLabel)}</time><i /><span><StatusBadge tone={event.metadataStatus === 'unknown' ? 'neutral' : 'success'}>{eventTypeLabels[event.type]}</StatusBadge><strong>{event.title}</strong><small>{event.summary}</small><em>{event.systemIds.length} 个身体系统 · {event.documentIds.length} 份来源文件</em></span><ChevronRight size={18} /></button>)}</div> : <div className="table-empty"><CalendarClock size={24} /><strong>{events.length > 0 ? '没有符合筛选条件的检查' : '还没有检查记录'}</strong><span>{events.length > 0 ? '可以调整检查类型或身体系统。' : '报告处理完成后会按检查时间显示在这里。'}</span></div>}</>}</section>}
    {!loading && tab === 'guidance' && loadErrors.plan && regionFailure('plan', '暂时无法打开日常生活', '这次没有读到生活计划，不代表没有建议或已采纳的行动。已有内容未改变。', '重试日常生活')}
    {!loading && tab === 'guidance' && loadErrors.assessment && regionFailure('assessment', '暂时无法打开行动建议', '这次没有读到健康解读中的行动建议，不代表没有下一步。已有内容未改变。', '重试行动建议')}
    {!loading && tab === 'guidance' && (assessment || plan || (!loadErrors.plan && !loadErrors.assessment)) && <>
      <DailyLifeGuide items={lifestyle.daily} stale={Boolean(assessment ? assessment.status === 'stale' : plan?.status === 'stale')} hasAdvice={Boolean(assessment?.actions.length || plan?.proposals.length)} hasPlans={Boolean(plan?.adoptedActions.length)} onRefresh={onRefreshAssessment} renderItem={renderDailyItem}
        medicalAdvice={lifestyle.medicalActions.length > 0 || lifestyle.medicalProposals.length > 0 ? <section className="panel daily-life-topic"><div className="panel__heading"><div><span className="eyebrow">复查与就医</span><h3>需要与医生一起安排的事</h3></div></div><div className="member-proposal-list">{lifestyle.medicalActions.map(renderAssessmentAction)}{lifestyle.medicalProposals.map(renderProposal)}</div></section> : null}
        plans={(!loadErrors.plan || Boolean(plan?.adoptedActions.length)) && <section className="panel daily-life-plans"><div className="panel__heading"><h3>我的计划</h3><StatusBadge tone="neutral">{plan?.adoptedActions.length ?? 0} 项</StatusBadge></div>{plan?.adoptedActions.length ? plan.adoptedActions.map((action) => <AdoptedActionCard key={action.id} action={action} />) : <p className="muted-copy">选择想做的建议加入计划后，可以在后续事项中安排时间、记录进展。</p>}</section>}
        questions={assessment?.questions.some((question) => memberText(question.question)) && <section className="panel daily-life-questions"><div className="panel__heading"><h3>补充这些情况，让建议更适合你</h3></div><ul>{assessment.questions.filter((question) => memberText(question.question)).map((question) => <li key={question.id}><strong>{memberText(question.question)}</strong>{memberText(question.whyItMatters) && <p>{memberText(question.whyItMatters)}</p>}<button className="secondary-button" aria-label={`补充这项信息：${memberText(question.question)}`} onClick={() => onAddNote({ questionId: question.id, snapshotId: assessment.id, question: memberText(question.question) })}>补充这项信息</button></li>)}</ul></section>}
      />
      {assessmentAdoptionError && <p role="alert" className="form-error">这项行动暂时没有加入。若资料已更新，请刷新成员档案后重试；原有行动未改变。</p>}
    </>}
    {!loading && tab === 'sources' && <section className="panel">
      <div className="panel__heading"><div><span className="eyebrow">原始资料</span><h2>报告与原始资料</h2><p>上传后由 OpenAI/Codex 自动整理报告并生成健康看板，使用本次原件、该成员必要的既有记录和本人补充信息。</p></div><button className="primary-button" onClick={() => onUploadReports(person.id)}><Upload size={17} aria-hidden="true" /> 上传报告</button></div>
      <p className="body-copy">可查看原件，或管理哪些资料用于健康解读。</p>
      {personDocuments.length > 0 ? <div className="source-document-list">{personDocuments.map((document) => {
        const presentation = reportProcessingPresentation(document, snapshot.reviews);
        return <article key={document.id}>
        <span className="file-icon"><FileText size={18} /></span><div><strong>{document.displayName}</strong><small>{document.format} · {document.sourceLabel}</small>{presentation.issue && document.status === 'needs_review' && <p className="muted-copy">{presentation.issue}</p>}</div>
        <StatusBadge tone={presentation.tone}>{presentation.label}</StatusBadge>
        <button className="text-button" onClick={() => onOpenEvidence({ title: document.displayName, label: document.sourceLabel, quote: '正在打开报告…', meta: '原始资料', documentId: document.id })}>查看原件</button>
        {document.status === 'ignored' ? <button className="text-button" onClick={() => onReincludeDocument(document)}>重新纳入</button> : <button className="text-button" onClick={() => onExcludeDocument(document)}>移出分析</button>}
        <button className="text-button is-danger" aria-label="删除本机档案" onClick={() => onDeleteDocument(document)}>删除</button>
        {onCorrectDocumentDate && document.status === 'completed' && document.acceptedFactCount !== 0 && <button className="text-button"
          style={{ gridColumn: '2 / -1', justifySelf: 'start', minHeight: 44, fontSize: 16 }}
          aria-label={`让模型核实并修正日期：${document.displayName}`} disabled={document.inProcessingCenter}
          onClick={() => onCorrectDocumentDate(document)}><CalendarClock size={17} /> 让模型核实并修正日期</button>}
      </article>;
      })}</div> : <div className="table-empty"><FileText size={24} /><strong>还没有原始资料</strong><span>添加报告后，文件会先保存在本机。</span></div>}
      <div className="dialog-actions"><button className="secondary-button" onClick={onDeletedDocuments}>查看已删除资料记录</button></div>
    </section>}
    </div>
  </div>;
}
