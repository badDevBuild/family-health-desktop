import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Activity, AlertTriangle, Archive, CalendarClock, Check, ChevronRight, FileCheck2, FileText, LoaderCircle, Plus, Search, ShieldCheck } from 'lucide-react';
import type { AdoptLifestyleProposalInput, BodySystemDetailV2, BodySystemId, BodySystemSummaryV2, ConceptReviewBundle, DashboardSnapshot, HealthEventDetailV2, HealthEventV2, InboxItem, LifestylePlanV2, MemberAssessmentSnapshotV3, MemberEvidenceRef, MemberOverviewV2, MetricSeriesDetailV2, PersonSummary, SetConceptMappingInput, UpdateReportMetadataInput } from '@contracts';
import { StatusBadge, type Tone } from '../../components/StatusBadge.js';
import { ConceptReviewPanel } from './ConceptReviewPanel.js';
import { MemberTrendChart } from './MemberTrendChart.js';

type EvidenceRequest = {
  title: string;
  label: string;
  quote: string;
  meta: string;
  sourceSpanId?: string | null;
  documentId?: string | null;
};

type MemberTab = 'overview' | 'body' | 'timeline' | 'guidance' | 'sources';

const systemSymbol: Record<BodySystemId, string> = {
  cardiovascular: '♥', endocrine_metabolic: '◒', hepatobiliary: '◇', renal_urinary: '◉',
  digestive: '≈', respiratory: '∞', hematology_immune: '✦', musculoskeletal: '⌁',
  neurological: '⌘', sensory_oral: '◎', reproductive: '◌', dermatological: '◍'
};

const abnormalFlagLabels: Record<MetricSeriesDetailV2['tableRows'][number]['abnormalFlag'], string> = {
  high: '偏高', low: '偏低', positive: '阳性', negative: '阴性', normal: '正常', unknown: '未标记'
};

function systemTone(status: BodySystemSummaryV2['status']): Tone {
  return status === 'attention' ? 'warning' : status === 'stable' || status === 'no_signal_in_scope' ? 'success' : status === 'building' || status === 'monitor' ? 'info' : 'neutral';
}

function systemStatusLabel(system: BodySystemSummaryV2): string {
  if (system.status === 'attention') return '建议关注';
  if (system.status === 'monitor') return '继续观察';
  if (system.status === 'no_signal_in_scope') return '本次未提示问题';
  if (system.status === 'stable') return '继续保持';
  if (system.status === 'building') return system.factCount > 0 ? '解读待完成' : '整理中';
  return '尚无相关检查';
}

function evidenceRequest(title: string, evidence: MemberEvidenceRef): EvidenceRequest {
  return {
    title,
    label: evidence.label,
    quote: evidence.quote ?? '原始资料中已定位到对应依据。',
    meta: evidence.locator ?? '受控来源定位',
    sourceSpanId: evidence.sourceSpanId,
    documentId: evidence.documentId
  };
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
      <label>日期精度<select value={precision} onChange={(input) => { const next = input.target.value as typeof precision; setPrecision(next); if (next === 'unknown') setDateValue(''); }}><option value="day">精确到日</option><option value="month">只到月</option><option value="year">只到年</option><option value="unknown">日期不确定</option></select></label>
      {precision !== 'unknown' && <label>检查日期<input type={precision === 'day' ? 'date' : precision === 'month' ? 'month' : 'number'} min={precision === 'year' ? '1900' : undefined} max={precision === 'year' ? '2200' : undefined} value={dateValue} onChange={(input) => setDateValue(input.target.value)} required /></label>}
      <label className="event-metadata-editor__reason">修正说明<input value={reason} onChange={(input) => setReason(input.target.value)} required maxLength={300} /></label>
    </div>
    {failed && <p role="alert" className="form-error">保存失败，可能该事件已被其他操作更新。请返回时间线后重试。</p>}
    <div className="dialog-actions"><button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>取消</button><button type="submit" className="primary-button" disabled={busy}>{busy ? '正在保存' : '保存修正'}</button></div>
  </form>;
}

function MemberHeader({ snapshot, person, onSelectPerson, onAddPerson, onEditPerson, onArchivedPeople, onAddNote, onExport }: {
  snapshot: DashboardSnapshot;
  person: PersonSummary;
  onSelectPerson(id: string): void;
  onAddPerson(): void;
  onEditPerson(): void;
  onArchivedPeople(): void;
  onAddNote(): void;
  onExport(): void;
}) {
  return <div className="member-header panel">
    <div className="member-header__identity"><span className="avatar avatar--large">{person.avatarInitial}</span><div><span className="eyebrow">个人健康解读</span><h1>{person.displayName}</h1><p>{person.relation} · 从结论进入，需要时再查看原始资料</p></div></div>
    <div className="member-header__controls"><select value={person.id} onChange={(event) => onSelectPerson(event.target.value)} aria-label="切换成员">{snapshot.persons.map((item) => <option key={item.id} value={item.id}>{item.displayName} · {item.relation}</option>)}</select><button className="primary-button" onClick={onAddNote}><Plus size={17} /> 补充健康资料</button></div>
    <details className="member-header__secondary member-header__more"><summary>更多管理</summary><div><button className="secondary-button" onClick={onEditPerson}>编辑成员</button><button className="secondary-button" onClick={onAddPerson}><Plus size={17} /> 添加成员</button><button className="secondary-button" onClick={onArchivedPeople}><Archive size={17} /> 已归档成员</button><button className="secondary-button" onClick={onExport}><FileCheck2 size={17} /> 导出摘要</button></div></details>
  </div>;
}

function SystemDirectory({ systems, selected, onSelect }: { systems: BodySystemSummaryV2[]; selected: BodySystemId | null; onSelect(id: BodySystemId): void }) {
  return <nav className="system-directory" aria-label="身体系统目录">
    {systems.map((system) => <button key={system.id} className={selected === system.id ? 'is-active' : ''} onClick={() => onSelect(system.id)}>
      <span className={`system-directory__symbol is-${system.status}`}>{systemSymbol[system.id]}</span>
      <span><strong>{system.shortName}</strong><small>{system.summary}</small></span>
      <em className="system-directory__status">{systemStatusLabel(system)}</em><ChevronRight size={17} />
    </button>)}
  </nav>;
}

function MetricDetail({ metric, onOpenEvidence, onBack }: { metric: MetricSeriesDetailV2; onOpenEvidence(request: EvidenceRequest): void; onBack(): void }) {
  return <section className="member-metric-detail">
    <button className="text-button" onClick={onBack}>← 返回身体系统</button>
    <div className="panel__heading"><div><span className="eyebrow">指标历史</span><h2>{metric.name}</h2></div><StatusBadge tone={metric.trendFacts.status === 'comparable' ? 'success' : 'info'}>{metric.trendFacts.status === 'comparable' ? '可比较' : metric.trendFacts.status === 'conditional' ? '有条件可比较' : '暂不可比较'}</StatusBadge></div>
    <p className="body-copy">{metric.trendFacts.statement}</p>
    <MemberTrendChart series={metric} />
    <div className="metric-history-table" role="table" aria-label={`${metric.name}历史记录`}>
      <div role="row" className="metric-history-table__head"><span>临床日期</span><span>结果</span><span>报告标记</span><span>原始依据</span></div>
      {metric.tableRows.map((point) => {
        const sources = point.evidenceSources ?? [point.evidence];
        return <div role="row" key={point.id}><span>{point.time.displayLabel}</span><strong>{point.displayValue} {point.unit ?? ''}</strong><span>{abnormalFlagLabels[point.abnormalFlag]}</span>{sources.length === 1
          ? <button className="evidence-link" onClick={() => onOpenEvidence(evidenceRequest(`${metric.name}原始依据`, sources[0]!))}><FileCheck2 size={16} /> 查看依据</button>
          : <details className="evidence-disclosure evidence-disclosure--compact"><summary><FileCheck2 size={16} /> 查看 {sources.length} 处依据</summary><div className="evidence-source-list">{sources.map((source, index) => <button key={source.id} className="evidence-link" onClick={() => onOpenEvidence(evidenceRequest(`${metric.name}原始依据 ${index + 1}`, source))}>依据 {index + 1}{index > 0 ? ' · 同次检查的重复来源' : ''}</button>)}</div></details>}
        </div>;
      })}
    </div>
    {metric.trendFacts.reasons.length > 0 && <div className="info-callout compact"><ShieldCheck size={18} /><div><strong>比较边界</strong><p>{metric.trendFacts.reasons.join(' ')}</p></div></div>}
  </section>;
}

export function systemAnalysisHeading(headline: string, keyPoints: Array<{ text: string }>) {
  if (keyPoints.length === 0) return headline;
  const normalize = (value: string) => value.toLocaleLowerCase('zh-CN').replace(/[\s，。；：、,.!?！？:;（）()\-—]/g, '');
  const normalizedHeadline = normalize(headline);
  const repeatedPointCount = keyPoints.filter((point) => normalizedHeadline.includes(normalize(point.text))).length;
  return repeatedPointCount >= Math.min(2, keyPoints.length) ? '这套资料目前说明什么' : headline;
}

function SystemAnalysisCard({ detail, onOpenEvidence }: { detail: BodySystemDetailV2; onOpenEvidence(request: EvidenceRequest): void }) {
  const analysis = detail.analysis;
  if (!analysis) return null;
  const displayHeadline = systemAnalysisHeading(analysis.headline, analysis.keyPoints);
  const evidence = [...new Map([
    ...analysis.keyPoints.flatMap((point) => point.evidence),
    ...analysis.conflicts.flatMap((conflict) => conflict.evidence),
    ...analysis.discussionPoints.flatMap((point) => point.evidence),
    ...(analysis.recommendations ?? []).flatMap((point) => point.evidence)
  ].map((item) => [item.id, item])).values()];
  const personalEvidence = evidence.filter((item) => item.kind !== 'knowledge');
  const knowledgeEvidence = evidence.filter((item) => item.kind === 'knowledge' && item.locator);
  const isCurrent = analysis.status === 'current' && analysis.review.status === 'passed';
  return <article className="system-analysis-card">
    <div className="panel__heading"><div><span className="eyebrow">整体解读</span><h3>{displayHeadline}</h3><small>依据截至 {analysis.scope.clinicalAsOf ?? '日期未记录'} 的资料</small></div><StatusBadge tone={isCurrent ? 'success' : 'info'}>{isCurrent ? '内容已核对' : '基于较早资料'}</StatusBadge></div>
    <p className="system-analysis-overview">{analysis.overview ?? analysis.headline}</p>
    {!isCurrent && <div className="info-callout compact"><ShieldCheck size={18} /><div><strong>旧说明仍可阅读</strong><p>新资料已使这份说明过期，或新一轮尚未通过核对。下方事实保持最新，这段综合说明请按标注日期理解。</p></div></div>}
    {analysis.keyPoints.length > 0 && <section className="analysis-explanation"><h4>为什么这样判断</h4><div className="system-analysis-points">{analysis.keyPoints.map((point) => <section key={point.id}><p>{point.text}</p>{point.limitations.length > 0 && <small>{point.limitations.join(' ')}</small>}</section>)}</div></section>}
    {(analysis.recommendations ?? []).length > 0 && <section className="analysis-recommendations"><h4>接下来怎么做</h4><div>{analysis.recommendations.map((recommendation) => <article key={recommendation.id}><h5>{recommendation.title}</h5><p>{recommendation.why}</p><dl><div><dt>先做什么</dt><dd>{recommendation.firstStep}</dd></div>{recommendation.schedule && <div><dt>什么时候做</dt><dd>{recommendation.schedule}</dd></div>}{recommendation.reviewPlan && <div><dt>何时回看</dt><dd>{recommendation.reviewPlan}</dd></div>}</dl>{recommendation.importantCaution && <small>{recommendation.importantCaution}</small>}</article>)}</div></section>}
    {analysis.conflicts.length > 0 && <div className="info-callout compact"><ShieldCheck size={18} /><div><strong>资料中有需保留的差异</strong><p>{analysis.conflicts.map((item) => item.text).join(' ')}</p></div></div>}
    {analysis.discussionPoints.length > 0 && <section className="analysis-discussion-points"><h4>下次可与医生讨论</h4><ul>{analysis.discussionPoints.map((point, index) => <li key={`${point.text}-${index}`}>{point.text}</li>)}</ul></section>}
    {(analysis.dataGaps.length > 0 || (analysis.clinicallyImportantUnknowns ?? []).length > 0) && <details className="analysis-boundaries"><summary>查看这份解读的范围</summary>{(analysis.clinicallyImportantUnknowns ?? []).map((item) => <p key={item}>{item}</p>)}{analysis.dataGaps.map((gap, index) => <p key={`${gap.text}-${index}`}>{gap.text} {gap.consequence}</p>)}</details>}
    {personalEvidence.length > 0 && <details className="evidence-disclosure"><summary><FileCheck2 size={16} /> 查看个人资料依据</summary><div className="evidence-source-list">{personalEvidence.map((item, index) => <button key={`${item.id}-${index}`} className="evidence-link" onClick={() => onOpenEvidence(evidenceRequest(`${detail.registry.shortName}综合说明依据 ${index + 1}`, item))}>依据 {index + 1} · {item.label}</button>)}</div></details>}
    {knowledgeEvidence.length > 0 && <details className="evidence-disclosure"><summary>查看通用医学来源</summary><div className="knowledge-source-list">{knowledgeEvidence.map((item) => <a key={item.id} href={item.locator!} target="_blank" rel="noreferrer"><strong>{item.label}</strong><small>{item.quote}</small></a>)}</div></details>}
  </article>;
}

const diagnosticLabels: Record<NonNullable<MemberAssessmentSnapshotV3['claims'][number]['diagnosticStatus']>, string> = {
  documented: '报告已有诊断', criteria_met: '根据资料符合标准', likely: '最可能的解释',
  possible: '需要鉴别', undetermined: '目前不能确定'
};

export function assessmentKnowledgeStatusLabel(status: MemberAssessmentSnapshotV3['knowledgeVerifications'][number]['status'] | undefined): string {
  if (status === 'tool_content_verified') return '应用已核对网页正文';
  if (status === 'catalog_curated') return '应用收录的知识条目';
  return 'AI 提供的网址；应用尚未核对正文';
}

function MemberAssessmentSystemCard({ assessment, systemId, onOpenEvidence }: {
  assessment: MemberAssessmentSnapshotV3;
  systemId: BodySystemId;
  onOpenEvidence(request: EvidenceRequest): void;
}) {
  const system = assessment.systems.find((item) => item.systemId === systemId);
  if (!system) return null;
  const claims = system.claimIds.map((id) => assessment.claims.find((item) => item.id === id))
    .filter((item): item is MemberAssessmentSnapshotV3['claims'][number] => Boolean(item));
  const actions = system.actionIds.map((id) => assessment.actions.find((item) => item.id === id))
    .filter((item): item is MemberAssessmentSnapshotV3['actions'][number] => Boolean(item));
  return <article className="system-analysis-card">
    <div className="panel__heading"><div><span className="eyebrow">这部分身体情况</span><h3>{system.headline}</h3></div><StatusBadge tone="success">有来源依据</StatusBadge></div>
    <p className="system-analysis-overview">{system.summary}</p>
    {claims.length > 0 && <section className="analysis-explanation"><h4>为什么这样判断</h4><div className="system-analysis-points">{claims.map((claim) => {
      const evidence = claim.evidenceIds.map((id) => assessment.evidenceCatalog.find((item) => item.id === id)).find(Boolean);
      const knowledgeSources = claim.knowledgeSourceIds.map((id) => assessment.knowledgeSources.find((item) => item.id === id))
        .filter((item): item is MemberAssessmentSnapshotV3['knowledgeSources'][number] => Boolean(item));
      return <section key={claim.id}><div className="panel__heading"><p>{claim.text}</p>{claim.diagnosticStatus && <StatusBadge tone="info">{diagnosticLabels[claim.diagnosticStatus]}</StatusBadge>}</div><small>{claim.rationale}</small>{claim.materialUncertainty && <small>仍需注意：{claim.materialUncertainty}</small>}{evidence && <button className="evidence-link" onClick={() => onOpenEvidence(evidenceRequest('判断依据', evidence))}><FileCheck2 size={16} /> 查看原始依据</button>}{knowledgeSources.length > 0 && <details className="evidence-disclosure"><summary>查看医学知识来源</summary><div className="knowledge-source-list">{knowledgeSources.map((source) => {
        const verification = assessment.knowledgeVerifications.find((item) => item.sourceId === source.id);
        const label = assessmentKnowledgeStatusLabel(verification?.status);
        return source.url ? <a key={source.id} href={source.url} target="_blank" rel="noreferrer"><strong>{source.title}</strong><span>{label}</span></a>
          : <span key={source.id}><strong>{source.title}</strong> · {label}</span>;
      })}</div></details>}</section>;
    })}</div></section>}
    {actions.length > 0 && <section className="analysis-recommendations"><h4>接下来怎么做</h4><div>{actions.map((action) => <article key={action.id}><h5>{action.title}</h5><p>{action.why}</p><dl><div><dt>第一步</dt><dd>{action.firstStep}</dd></div>{action.timing && <div><dt>何时</dt><dd>{action.timing}</dd></div>}{action.reviewPlan && <div><dt>何时回看</dt><dd>{action.reviewPlan}</dd></div>}</dl>{action.caution && <small>{action.caution}</small>}</article>)}</div></section>}
    {system.limitations.length > 0 && <details className="analysis-boundaries"><summary>这部分判断的范围</summary>{system.limitations.map((item) => <p key={item}>{item}</p>)}</details>}
  </article>;
}

function SystemDetail({ detail, assessment, search, onSearch, selectedMetric, onSelectMetric, onOpenEvidence }: {
  detail: BodySystemDetailV2;
  assessment: MemberAssessmentSnapshotV3 | null;
  search: string;
  onSearch(value: string): void;
  selectedMetric: MetricSeriesDetailV2 | null;
  onSelectMetric(id: string | null): void;
  onOpenEvidence(request: EvidenceRequest): void;
}) {
  if (selectedMetric) return <MetricDetail metric={selectedMetric} onOpenEvidence={onOpenEvidence} onBack={() => onSelectMetric(null)} />;
  const query = search.trim().toLocaleLowerCase('zh-CN');
  const metrics = detail.metrics.filter((metric) => !query || metric.name.toLocaleLowerCase('zh-CN').includes(query));
  const findings = detail.findings.filter((finding) => !query || `${finding.title}${finding.value}`.toLocaleLowerCase('zh-CN').includes(query));
  return <section className="system-detail">
    <div className="system-detail__hero"><span className={`system-directory__symbol is-${detail.summary.status}`}>{systemSymbol[detail.registry.id]}</span><div><span className="eyebrow">{detail.registry.name}</span><h2>{detail.registry.shortName}</h2><p>{detail.analysis ? '先看结论和下一步，需要时再展开指标与原始依据。' : detail.summary.summary}</p></div></div>
    {assessment?.systems.some((item) => item.systemId === detail.registry.id)
      ? <MemberAssessmentSystemCard assessment={assessment} systemId={detail.registry.id} onOpenEvidence={onOpenEvidence} />
      : <SystemAnalysisCard detail={detail} onOpenEvidence={onOpenEvidence} />}
    <label className="member-search"><Search size={18} /><span className="sr-only">搜索本系统指标</span><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder={`搜索${detail.registry.shortName}指标`} /></label>
    <div className="system-section-heading"><div><h3>指标与历史</h3><p>点开指标查看按真实日期间隔绘制的历史；不会因点击而调用模型。</p></div><StatusBadge tone="neutral">{metrics.length} 项</StatusBadge></div>
    {metrics.length > 0 ? <div className="system-metric-list">{metrics.map((metric) => <button key={metric.id} onClick={() => onSelectMetric(metric.id)}><span><strong>{metric.name}</strong><small>{metric.trendFacts.statement}</small></span><b>{metric.latestValue ?? '—'} <small>{metric.unit ?? ''}</small></b><ChevronRight size={17} /></button>)}</div> : <div className="table-empty compact-empty"><Activity size={24} /><strong>没有匹配的指标</strong><span>可以清空搜索词，或等待新报告完成事实处理。</span></div>}
    {findings.length > 0 && <><div className="system-section-heading"><div><h3>文字检查结果</h3><p>影像小结、阴性或未见异常等文字结论会完整换行显示。</p></div></div><div className="system-finding-grid">{findings.map((finding) => <article key={finding.id}><div><strong>{finding.title}</strong><small>{finding.time.displayLabel}</small></div><b>{finding.value}</b>{finding.evidence[0] && <button className="evidence-link" onClick={() => onOpenEvidence(evidenceRequest(`${finding.title}原始依据`, finding.evidence[0]!))}><FileCheck2 size={16} /> 查看依据</button>}</article>)}</div></>}
    {detail.unmappedFactCount > 0 && <div className="info-callout compact"><ShieldCheck size={18} /><div><strong>{detail.unmappedFactCount} 条事实保留原始名称</strong><p>词典没有经过验证的精确映射时，系统不会自行改名或合并。</p></div></div>}
  </section>;
}

function LifestyleProposalCard({ proposal, index, busy, canAdopt, onAdopt, onDecide, onOpenEvidence }: {
  proposal: LifestylePlanV2['proposals'][number];
  index: number;
  busy: boolean;
  canAdopt: boolean;
  onAdopt(input: Omit<AdoptLifestyleProposalInput, 'personId' | 'proposalId'>): void;
  onDecide(decision: 'dismiss' | 'restore'): void;
  onOpenEvidence(request: EvidenceRequest): void;
}) {
  const [showAdoptionForm, setShowAdoptionForm] = useState(false);
  const [userGoal, setUserGoal] = useState(proposal.goal);
  const [selectedStartingOption, setSelectedStartingOption] = useState(proposal.startingOptions[0] ?? proposal.steps[0] ?? proposal.title);
  const [plannedTime, setPlannedTime] = useState(proposal.scheduleSuggestion ?? '');
  const [owner, setOwner] = useState('本人');
  const [dueDate, setDueDate] = useState('');
  const [progressNote, setProgressNote] = useState('');
  const statusLabel = proposal.status === 'adopted' ? '已采纳' : proposal.status === 'dismissed' ? '暂不采纳' : '待决定';
  const sourceLabel = proposal.sourceKind === 'clinician_reported'
    ? '报告中的医生安排'
    : proposal.sourceKind === 'care_preparation' ? '记录或就医准备' : 'AI 整理建议';
  return <article className={proposal.status === 'dismissed' ? 'is-muted' : ''}>
    <span className="member-proposal-list__index">{index + 1}</span>
    <div>
      <div className="panel__heading"><div><span className="eyebrow">{sourceLabel} · {proposal.category === 'exercise' ? '活动' : proposal.category === 'diet' ? '饮食' : proposal.category === 'sleep' ? '作息' : proposal.category === 'monitoring' ? '日常记录' : proposal.category === 'review' ? '就医准备' : '生活方向'}</span><h3>{proposal.title}</h3></div><StatusBadge tone={proposal.status === 'adopted' ? 'success' : 'neutral'}>{statusLabel}</StatusBadge></div>
      <p className="proposal-goal"><strong>目标：</strong>{proposal.goal}</p>
      <p>{proposal.rationale}</p>
      {!canAdopt && proposal.status === 'proposed' && <div className="info-callout compact"><ShieldCheck size={18} /><div><strong>这条建议来自较早资料</strong><p>新资料或新限制出现后，需要先重新核对，再决定是否加入行动。已采纳的行动不受影响。</p></div></div>}
      <details>
        <summary>查看怎么开始、依据与限制</summary>
        <div className="proposal-structure">
          <section><h4>具体行动</h4><ol>{proposal.steps.map((step) => <li key={step}>{step}</li>)}</ol></section>
          <section><h4>可以从这里开始</h4><ul>{proposal.startingOptions.map((option) => <li key={option}>{option}</li>)}</ul></section>
          {proposal.scheduleSuggestion && <section><h4>时间安排参考</h4><p>{proposal.scheduleSuggestion}</p></section>}
          <section><h4>如何低负担记录</h4><p>{proposal.trackingSuggestion}</p></section>
          {(proposal.constraints.length > 0 || proposal.uncertainties.length > 0) && <section><h4>适用边界</h4><ul>{proposal.constraints.map((item) => <li key={item}>{item}</li>)}{proposal.uncertainties.map((item) => <li key={item}>尚不确定：{item}</li>)}</ul></section>}
          <section><h4>为什么适用于此人</h4>{proposal.evidence.length > 0 ? <div className="evidence-source-list">{proposal.evidence.map((evidence, evidenceIndex) => <button key={`${evidence.id}-${evidenceIndex}`} className="evidence-link" onClick={() => onOpenEvidence(evidenceRequest(`${proposal.title}个人依据 ${evidenceIndex + 1}`, evidence))}>个人资料依据 {evidenceIndex + 1}</button>)}</div> : <p>没有个人异常作为依据；这条内容仅用于记录或就医准备。</p>}</section>
          <section><h4>一般知识来源</h4>{proposal.generalKnowledgeEvidence.length > 0 ? <div className="knowledge-source-list">{proposal.generalKnowledgeEvidence.map((source) => <a key={source.id} href={source.sourceUrl} target="_blank" rel="noreferrer"><strong>{source.sourceTitle}</strong><span>{source.sourceOrganization} · {source.verificationStatus === 'controlled_source_verified' ? '已由应用核验' : 'AI 提供的候选来源，未独立打开核对'}</span><small>{source.supportedScope}</small></a>)}</div> : <p>没有可靠的一般知识来源，因此这条建议不能冒充已证实的具体生活做法。</p>}</section>
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
        <p className="muted-copy">这些是你的计划字段，以后 AI 更新建议也不会覆盖。</p>
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
        {proposal.status === 'proposed' && !showAdoptionForm && <><button className="secondary-button" disabled={busy || !canAdopt} onClick={() => setShowAdoptionForm(true)}>{canAdopt ? '采纳为我的行动' : '等待重新核对'}</button>{canAdopt && <button className="text-button" disabled={busy} onClick={() => onDecide('dismiss')}>暂不采纳</button>}</>}
        {proposal.status === 'adopted' && <span className="proposal-adopted"><Check size={16} /> 已加入行动，后续 AI 更新不会重置进度</span>}
        {proposal.status === 'dismissed' && <button className="text-button" disabled={busy} onClick={() => onDecide('restore')}>恢复为待决定</button>}
      </div>
    </div>
  </article>;
}

export function MemberProfileV2({ snapshot, person, onSelectPerson, onOpenEvidence, onAddPerson, onEditPerson, onArchivedPeople, onAddNote, onExport, onImport, onExcludeDocument, onReincludeDocument, onDeleteDocument, onDeletedDocuments }: {
  snapshot: DashboardSnapshot;
  person: PersonSummary;
  onSelectPerson(id: string): void;
  onOpenEvidence(request: EvidenceRequest): void;
  onAddPerson(): void;
  onEditPerson(): void;
  onArchivedPeople(): void;
  onAddNote(): void;
  onExport(): void;
  onImport(): void;
  onExcludeDocument(document: InboxItem): void;
  onReincludeDocument(document: InboxItem): void;
  onDeleteDocument(document: InboxItem): void;
  onDeletedDocuments(): void;
}) {
  const [tab, setTab] = useState<MemberTab>('overview');
  const [overview, setOverview] = useState<MemberOverviewV2 | null>(null);
  const [assessment, setAssessment] = useState<MemberAssessmentSnapshotV3 | null>(null);
  const [systems, setSystems] = useState<BodySystemSummaryV2[]>([]);
  const [selectedSystem, setSelectedSystem] = useState<BodySystemId | null>(null);
  const [systemDetail, setSystemDetail] = useState<BodySystemDetailV2 | null>(null);
  const [selectedMetric, setSelectedMetric] = useState<MetricSeriesDetailV2 | null>(null);
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
  const [loadError, setLoadError] = useState(false);
  const [partialLoadError, setPartialLoadError] = useState(false);
  const metricRequestGeneration = useRef(0);

  useEffect(() => {
    let active = true;
    const bridge = window.healthDesktop;
    if (!bridge?.getMemberOverview || !bridge.listBodySystems || !bridge.listHealthEvents || !bridge.getLifestylePlan || !bridge.getConceptReview) {
      queueMicrotask(() => {
        if (!active) return;
        setLoadError(true);
        setLoading(false);
      });
      return () => { active = false; };
    }
    void Promise.allSettled([
      bridge.getMemberOverview(person.id),
      bridge.listBodySystems(person.id),
      bridge.listHealthEvents({ personId: person.id }),
      bridge.getLifestylePlan(person.id),
      bridge.getConceptReview(person.id),
      bridge.getMemberAssessment ? bridge.getMemberAssessment(person.id) : Promise.resolve({ ok: true as const, data: null })
    ]).then(([overviewSettled, systemsSettled, eventsSettled, planSettled, conceptSettled, assessmentSettled]) => {
      if (!active) return;
      const overviewResult = overviewSettled.status === 'fulfilled' ? overviewSettled.value : null;
      const systemsResult = systemsSettled.status === 'fulfilled' ? systemsSettled.value : null;
      const eventsResult = eventsSettled.status === 'fulfilled' ? eventsSettled.value : null;
      const planResult = planSettled.status === 'fulfilled' ? planSettled.value : null;
      const conceptResult = conceptSettled.status === 'fulfilled' ? conceptSettled.value : null;
      const assessmentResult = assessmentSettled.status === 'fulfilled' ? assessmentSettled.value : null;
      if (!overviewResult?.ok || !systemsResult?.ok || !eventsResult?.ok) {
        setLoadError(true);
        return;
      }
      setOverview(overviewResult.data);
      setSystems(systemsResult.data);
      setEvents(eventsResult.data);
      if (planResult?.ok) setPlan(planResult.data);
      if (conceptResult?.ok) setConceptReview(conceptResult.data);
      setAssessment(assessmentResult?.ok ? assessmentResult.data : null);
      setPartialLoadError(!planResult?.ok || !conceptResult?.ok || !assessmentResult?.ok);
      setLoadError(false);
      setSelectedSystem((current) => current && systemsResult.data.some((system) => system.id === current)
        ? current
        : systemsResult.data.find((system) => system.factCount > 0)?.id ?? systemsResult.data[0]?.id ?? null);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [person.id, person.dataRevision, refreshToken]);

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
    if (!bridge?.getBodySystemDetail) return;
    void bridge.getBodySystemDetail(person.id, selectedSystem).then((result) => {
      if (active && result?.ok) setSystemDetail(result.data);
    });
    return () => { active = false; };
  }, [person.id, person.dataRevision, selectedSystem]);

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
    if (!seriesId) { setSelectedMetric(null); return; }
    const bridge = window.healthDesktop;
    if (!bridge?.getMetricSeries) return;
    void bridge.getMetricSeries(person.id, seriesId).then((result) => {
      if (generation === metricRequestGeneration.current && result?.ok) setSelectedMetric(result.data);
    });
  };
  const chooseSystem = (systemId: BodySystemId) => {
    metricRequestGeneration.current += 1;
    setSelectedMetric(null);
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
    if (!assessment || !bridge?.adoptMemberAssessmentAction || adoptingAssessmentActionId) return;
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
  const tabs: Array<[MemberTab, string]> = [['overview', '健康总览'], ['body', '身体与指标'], ['timeline', '检查时间线'], ['guidance', '生活与行动'], ['sources', '原始资料']];
  const personDocuments = snapshot.inbox.filter((document) => document.personId === person.id);
  const filteredEvents = events.filter((event) => (
    (eventType === 'all' || event.type === eventType)
    && (eventSystem === 'all' || event.systemIds.includes(eventSystem))
  ));
  const eventFindings = selectedEvent?.findings ?? [];
  const attentionEventFindings = eventFindings.filter((finding) => ['high', 'low', 'positive'].includes(finding.abnormalFlag));
  const ordinaryEventFindings = eventFindings.filter((finding) => !['high', 'low', 'positive'].includes(finding.abnormalFlag));
  const eventFindingPreviewLimit = 18;
  const previewEventFindings = [
    ...attentionEventFindings,
    ...ordinaryEventFindings.slice(0, Math.max(0, eventFindingPreviewLimit - attentionEventFindings.length))
  ];
  const visibleEventFindings = showAllEventFindings ? eventFindings : previewEventFindings;

  return <div className="page-stack member-profile-v2">
    <MemberHeader snapshot={snapshot} person={person} onSelectPerson={onSelectPerson} onAddPerson={onAddPerson} onEditPerson={onEditPerson} onArchivedPeople={onArchivedPeople} onAddNote={onAddNote} onExport={onExport} />
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
    {partialLoadError && <div className="info-callout compact" role="status"><ShieldCheck size={18} /><div><strong>部分辅助内容暂时未读取</strong><p>身体与时间线仍可正常查看；生活方案或概念核对稍后重试即可。</p></div></div>}
    <div className="tabs member-tabs" role="tablist">{tabs.map(([id, label]) => <button role="tab" aria-selected={tab === id} className={tab === id ? 'is-active' : ''} key={id} onClick={() => setTab(id)}>{label}</button>)}</div>
    {(loading || (!loadError && overview?.personId !== person.id)) && <section className="panel table-empty"><LoaderCircle size={24} className="spin" /><strong>正在整理成员档案</strong><span>只读取本机已保存结果，不会发起新的模型任务。</span></section>}
    {!loading && loadError && <section className="panel personal-empty-state"><ShieldCheck size={28} /><div><span className="eyebrow">读取未完成</span><h2>暂时无法打开新版成员档案</h2><p>现有报告和事实没有丢失。可先切换页面后重试；打开页面本身不会调用模型。</p></div></section>}
    {!loading && overview?.personId === person.id && !loadError && overview && tab === 'overview' && <div className="member-v2-overview">
      <section className="panel member-health-headline"><div><span className="eyebrow">现在怎样</span><h2>{overview.headline}</h2><p>{overview.overview}</p><small>资料截至 {overview.latestClinicalDate ?? '日期待确认'}</small></div></section>
      {overview.unclassifiedFactCount > 0 && <div className="info-callout compact" role="status"><ShieldCheck size={18} /><div><strong>有 {overview.unclassifiedFactCount} 条来源事实尚未归入身体系统</strong><p>事实已保存；{assessment ? '成员总览已纳入这些资料，但身体系统卡片可能暂不显示。' : '成员总览整理完成后会纳入这些资料，身体系统卡片可能暂不显示。'}</p></div></div>}
      {overview.priorityIssues.length > 0 && <section className="panel result-first-section"><div className="panel__heading"><div><span className="eyebrow">最值得先看</span><h2>优先关注</h2></div></div><div className="priority-issue-list">{overview.priorityIssues.map((issue) => <button key={issue.id} onClick={() => { chooseSystem(issue.systemId); setTab('body'); }}><span><strong>{issue.title}</strong><p>{issue.explanation}</p>{issue.nextStep && <small>先做：{issue.nextStep}</small>}</span><ChevronRight size={18} /></button>)}</div></section>}
      {overview.importantChanges.length > 0 && <section className="panel result-first-section"><div className="panel__heading"><div><span className="eyebrow">和以前相比</span><h2>有意义的变化</h2></div></div><div className="important-change-list">{overview.importantChanges.map((change) => <button key={change.id} onClick={() => { chooseSystem(change.systemId); setTab('body'); }}><span><strong>{change.title}</strong><p>{change.meaning}</p></span><ChevronRight size={18} /></button>)}</div></section>}
      <section className="panel wide-panel"><div className="panel__heading"><div><span className="eyebrow">按身体查看</span><h2>有资料的身体系统</h2></div><StatusBadge tone="neutral">不计算健康总分</StatusBadge></div><div className="system-summary-grid">{systems.filter((system) => system.factCount > 0).map((system) => <button key={system.id} onClick={() => { chooseSystem(system.id); setTab('body'); }}><span className={`system-directory__symbol is-${system.status}`}>{systemSymbol[system.id]}</span><span><strong>{system.shortName}</strong><small>{system.summary}</small></span><StatusBadge tone={systemTone(system.status)}>{systemStatusLabel(system)}</StatusBadge><ChevronRight size={17} /></button>)}</div>{systems.some((system) => system.factCount === 0) && <details className="empty-system-disclosure"><summary>查看尚无相关检查的系统</summary><div>{systems.filter((system) => system.factCount === 0).map((system) => <button key={system.id} onClick={() => { chooseSystem(system.id); setTab('body'); }}>{system.shortName}<ChevronRight size={16} /></button>)}</div></details>}</section>
      <section className="panel"><div className="panel__heading"><h3>最近检查事件</h3><button className="text-button" onClick={() => setTab('timeline')}>查看全部</button></div>{overview.recentChanges.length > 0 ? <div className="recent-event-list">{overview.recentChanges.map((change) => <button key={change.id} onClick={() => setTab('timeline')}><CalendarClock size={18} /><span><strong>{change.title}</strong><small>{change.date ?? '日期待确认'} · {change.detail}</small></span><ChevronRight size={16} /></button>)}</div> : <p className="muted-copy">还没有可归入时间线的检查事件。</p>}</section>
      <section className="panel"><div className="panel__heading"><h3>接下来</h3><button className="text-button" onClick={() => setTab('guidance')}>生活与行动</button></div>{overview.nextActions.length > 0 ? <div className="recent-event-list">{overview.nextActions.map((action) => <div key={action.id}><Check size={17} /><span><strong>{action.title}</strong><small>{action.status}</small></span></div>)}</div> : <p className="muted-copy">目前没有待办事项。生活建议不会自动变成用户计划。</p>}</section>
    </div>}
    {!loading && tab === 'body' && <>
      {selectedEvent && <div className="context-return-bar"><span><strong>正在从检查事件查看身体系统</strong><small>{selectedEvent.time.displayLabel} · {selectedEvent.title}</small></span><button className="secondary-button" onClick={() => setTab('timeline')}>返回这次检查</button></div>}
      <div className="body-workspace"><aside className="panel"><div className="body-workspace__label"><span className="eyebrow">身体目录</span><strong>12 个系统</strong></div><SystemDirectory systems={systems} selected={selectedSystem} onSelect={chooseSystem} /></aside><main className="panel">{systemDetail && selectedSystem === systemDetail.registry.id ? <SystemDetail detail={systemDetail} assessment={assessment} search={search} onSearch={setSearch} selectedMetric={selectedMetric} onSelectMetric={chooseMetric} onOpenEvidence={onOpenEvidence} /> : <div className="table-empty"><LoaderCircle size={24} className="spin" /><strong>正在读取系统档案</strong></div>}</main></div>
      {conceptError && <div className="info-callout compact"><ShieldCheck size={18} /><div><strong>这次归类没有保存</strong><p>原始事实未改变，可以稍后重试。</p></div></div>}
      {conceptReview && <ConceptReviewPanel bundle={conceptReview} busyObservationId={conceptBusyId} onSave={saveConceptMapping} onUndo={undoConceptMapping} onOpenEvidence={onOpenEvidence} />}
    </>}
    {!loading && tab === 'timeline' && <section className="panel timeline-panel">{selectedEvent ? <div className="event-detail">
      <button className="text-button" onClick={() => { setSelectedEventId(null); setSelectedEvent(null); setShowAllEventFindings(false); }}>← 返回检查时间线</button>
      <div className="panel__heading"><div><span className="eyebrow">{selectedEvent.time.displayLabel}</span><h2>{selectedEvent.title}</h2></div><StatusBadge tone={selectedEvent.metadataStatus === 'unknown' ? 'neutral' : 'success'}>{selectedEvent.metadataStatus === 'unknown' ? '元数据待确认' : selectedEvent.metadataStatus === 'corrected' ? '本人已修正' : '已有来源日期'}</StatusBadge></div>
      <p className="body-copy">{selectedEvent.summary}</p>
      {selectedEvent.systemIds.length > 0 && <div className="event-system-links"><span><strong>这次检查涉及</strong><small>进入系统档案后，返回时仍会保留当前事件。</small></span><div>{selectedEvent.systemIds.map((systemId) => <button key={systemId} className="secondary-button" onClick={() => { chooseSystem(systemId); setTab('body'); }}>{systems.find((system) => system.id === systemId)?.shortName ?? systemId}<ChevronRight size={15} /></button>)}</div></div>}
      {selectedEvent.reportId && <div className="event-metadata-actions"><button className="secondary-button" onClick={() => { setEditingEventMetadata((value) => !value); setEventMetadataError(false); }} disabled={eventMetadataBusy}>{editingEventMetadata ? '收起修正' : '修正报告信息'}</button>{selectedEvent.metadataCanUndo && <button className="text-button" onClick={undoEventMetadata} disabled={eventMetadataBusy}>撤销上次修正</button>}</div>}
      {editingEventMetadata && <ReportMetadataEditor event={selectedEvent} busy={eventMetadataBusy} failed={eventMetadataError} onCancel={() => setEditingEventMetadata(false)} onSave={saveEventMetadata} />}
      <details className="event-organizer">
        <summary>这些报告是否属于同一次检查？</summary>
        <p>系统只有在机构、日期和明确的检查号或样本号一致时才会自动合并。这里的人工整理只改变时间线分组，不改报告原文和检查数值，并且可以撤销。</p>
        <div className="event-organizer__reports">
          {selectedEvent.reports.map((report) => <div key={report.reportId}><span><strong>{report.title}</strong><small>本事件中的来源报告</small></span>{selectedEvent.reports.length > 1 && <button className="text-button" onClick={() => splitReportFromEvent(report.reportId)} disabled={eventRelationBusy}>拆成单独事件</button>}</div>)}
        </div>
        {events.some((event) => event.id !== selectedEvent.id) && <div className="event-organizer__merge"><label>还属于哪个事件？<select value={mergeSourceEventId} onChange={(event) => setMergeSourceEventId(event.target.value)} disabled={eventRelationBusy}><option value="">选择另一条检查记录</option>{events.filter((event) => event.id !== selectedEvent.id).map((event) => <option key={event.id} value={event.id}>{event.time.displayLabel} · {event.title}</option>)}</select></label><button className="secondary-button" onClick={mergeEvent} disabled={!mergeSourceEventId || eventRelationBusy}>合并到当前事件</button></div>}
        {selectedEvent.relationCanUndo && selectedEvent.relationChangeId && <button className="text-button" onClick={undoEventRelation} disabled={eventRelationBusy}>撤销上次{selectedEvent.relationChangeAction === 'split' ? '拆分' : '合并'}</button>}
        {eventRelationError && <p role="alert" className="form-error">这次整理没有保存。资料和检查数值未改变，请返回时间线后重试。</p>}
      </details>
      {selectedEvent.findings.length > 0 && <section className="event-findings-section">
        <div className="system-section-heading"><div><h3>本次检查结果</h3><p>{selectedEvent.findings.length > eventFindingPreviewLimit && !showAllEventFindings ? `先显示 ${visibleEventFindings.length} 条，已包含全部原报告留意项。` : '保留报告中的原始结果和单位。'}</p></div><StatusBadge tone="neutral">{selectedEvent.findings.length} 条</StatusBadge></div>
        <div className="event-detail__facts">{visibleEventFindings.map((finding) => <div key={finding.id} className={['high', 'low', 'positive'].includes(finding.abnormalFlag) ? 'is-attention' : ''}><span>{finding.label}</span><strong>{finding.value}</strong>{['high', 'low', 'positive'].includes(finding.abnormalFlag) && <small>原报告标记需留意</small>}</div>)}</div>
        {selectedEvent.findings.length > previewEventFindings.length && <button className="secondary-button event-findings-toggle" onClick={() => setShowAllEventFindings((value) => !value)}>{showAllEventFindings ? '收起完整结果' : `查看全部 ${selectedEvent.findings.length} 条结果`}</button>}
      </section>}
      {selectedEvent.historicalReferences.length > 0 && <section className="historical-reference-section"><div className="system-section-heading"><div><h3>本报告引用的历史结果</h3><p>这些数值来自当前报告的历史对比栏，不表示当时在当前机构完成检查。</p></div><StatusBadge tone="info">历史引用</StatusBadge></div>{selectedEvent.historicalReferences.map((reference) => <article key={`${reference.sourceReportTitle}-${reference.time.value}`}><header><strong>{reference.time.displayLabel}</strong><small>由《{reference.sourceReportTitle}》引用</small></header><div className="event-detail__facts">{reference.findings.map((finding) => <div key={finding.id}><span>{finding.label}</span><strong>{finding.value}</strong><button className="evidence-link" onClick={() => onOpenEvidence(evidenceRequest(`${finding.label}历史依据`, finding.evidence))}>查看依据</button></div>)}</div></article>)}</section>}
      <div className="system-section-heading"><div><h3>来源与附件</h3><p>每条依据独立定位；文件名只出现在来源层。</p></div><StatusBadge tone="neutral">{selectedEvent.evidence.length} 条</StatusBadge></div>
      <div className="evidence-source-list">{selectedEvent.evidence.map((evidence, index) => <button key={`${evidence.id}-${index}`} className="evidence-link" onClick={() => onOpenEvidence(evidenceRequest(`${selectedEvent.title}依据 ${index + 1}`, evidence))}><FileCheck2 size={16} /> {evidence.label} · {evidence.locator ?? `依据 ${index + 1}`}</button>)}</div>
    </div> : <><div className="panel__heading"><div><span className="eyebrow">检查时间线</span><h2>按时间看每次检查</h2></div><StatusBadge tone="neutral">{filteredEvents.length} / {events.length} 次</StatusBadge></div><p className="body-copy">打开某次检查，可以查看当时发现了什么、涉及哪些身体系统，以及对应的原始依据。</p><div className="timeline-filters"><label>事件类型<select value={eventType} onChange={(event) => setEventType(event.target.value as HealthEventV2['type'] | 'all')}><option value="all">全部类型</option><option value="checkup">体检</option><option value="laboratory">检验</option><option value="imaging">影像</option><option value="outpatient">门诊</option><option value="inpatient">住院</option><option value="self_measurement">本人测量</option><option value="manual_note">本人补充</option><option value="other">其他</option></select></label><label>身体系统<select value={eventSystem} onChange={(event) => setEventSystem(event.target.value as BodySystemId | 'all')}><option value="all">全部系统</option>{systems.map((system) => <option key={system.id} value={system.id}>{system.shortName}</option>)}</select></label></div>{filteredEvents.length > 0 ? <div className="timeline-list">{filteredEvents.map((event) => <button key={event.id} onClick={() => chooseEvent(event.id)}><time>{event.time.displayLabel}</time><i /><span><StatusBadge tone={event.metadataStatus === 'unknown' ? 'neutral' : 'success'}>{event.type === 'checkup' ? '体检' : event.type === 'imaging' ? '影像' : event.type === 'laboratory' ? '检验' : '健康事件'}</StatusBadge><strong>{event.title}</strong><small>{event.summary}</small><em>{event.systemIds.length} 个身体系统 · {event.documentIds.length} 份来源文件</em></span><ChevronRight size={18} /></button>)}</div> : <div className="table-empty"><CalendarClock size={24} /><strong>{events.length > 0 ? '没有符合筛选条件的检查' : '还没有检查记录'}</strong><span>{events.length > 0 ? '可以调整检查类型或身体系统。' : '报告处理完成后会按检查时间显示在这里。'}</span></div>}</>}</section>}
    {!loading && tab === 'guidance' && assessment && <div className="guide-grid">
      <section className="panel guide-hero"><span className="eyebrow">生活与行动</span><h2>根据现有资料，先做这些事</h2><p>同一方向已合并为一项建议；建议不会自动变成已采纳计划。</p>
        {assessment.actions.length > 0 ? <div className="member-proposal-list">{assessment.actions.map((action, index) => {
          const adopted = plan?.adoptedActions.some((item) => item.assessmentDedupeKey === action.dedupeKey && item.status !== 'dismissed') ?? false;
          return <article key={action.id}>
            <div className="panel__heading"><div><span className="eyebrow">第 {index + 1} 项 · {action.kind === 'seek_care' ? '就医准备' : action.kind === 'test_followup' ? '复查' : action.kind === 'treatment_discussion' ? '治疗讨论' : '日常行动'}</span><h3>{action.title}</h3></div><StatusBadge tone={action.urgency === 'urgent' || action.urgency === 'emergency' ? 'warning' : 'info'}>{action.urgency === 'emergency' ? '尽快寻求急救' : action.urgency === 'urgent' ? '及时处理' : action.urgency === 'soon' ? '近期安排' : '按计划进行'}</StatusBadge></div>
            <p>{action.why}</p><dl><div><dt>第一步</dt><dd>{action.firstStep}</dd></div>{action.timing && <div><dt>何时</dt><dd>{action.timing}</dd></div>}{action.reviewPlan && <div><dt>何时回看</dt><dd>{action.reviewPlan}</dd></div>}</dl>{action.caution && <small>{action.caution}</small>}
            {adopted ? <p className="muted-copy">已加入后续事项</p> : <button className="secondary-button" onClick={() => adoptAssessmentAction(action.id)} disabled={adoptingAssessmentActionId !== null}>{adoptingAssessmentActionId === action.id ? '正在加入' : '加入后续事项'}</button>}
          </article>;
        })}</div> : <p className="muted-copy">本轮没有需要新增的统一行动；已有事实和判断仍可在健康总览查看。</p>}
        {assessmentAdoptionError && <p role="alert" className="form-error">这项行动暂时没有加入。若资料已更新，请刷新成员档案后重试；原有行动未改变。</p>}
      </section>
      {assessment.questions.length > 0 && <section className="panel"><div className="panel__heading"><h3>会改变判断的关键信息</h3></div><ul>{assessment.questions.map((question) => <li key={question.id}><strong>{question.question}</strong><p>{question.whyItMatters}</p></li>)}</ul></section>}
      <section className="panel"><div className="panel__heading"><h3>已采纳行动</h3><StatusBadge tone="neutral">{plan?.adoptedActions.length ?? 0} 项</StatusBadge></div>{plan?.adoptedActions.length ? plan.adoptedActions.map((action) => <div className="completed-item adopted-action-card" key={action.id}><Check size={16} /><div><strong>{action.title}</strong><span>{action.userGoal}</span><small>{action.selectedStartingOption} · {action.owner}</small>{action.progressNote && <small>备注：{action.progressNote}</small>}</div></div>) : <p className="muted-copy">还没有主动采纳的行动。</p>}</section>
    </div>}
    {!loading && tab === 'guidance' && !assessment && <div className="guide-grid">{plan && plan.proposals.length > 0 ? <>
      <section className="panel guide-hero"><span className="eyebrow">本周重点</span><h2>一份成员级生活方案</h2><p>相同方向已跨身体系统合并；建议不会自动变成你的计划，只有主动采纳后才进入行动层。</p>{plan.status === 'stale' && <div className="info-callout compact" role="status"><ShieldCheck size={18} /><div><strong>旧版建议已恢复展示</strong><p>内容仍可以阅读，但尚未按当前的来源和安全规则重新复核，所以暂时不能直接采纳。</p></div></div>}<div className="member-proposal-list">{plan.proposals.map((proposal, index) => <LifestyleProposalCard key={proposal.id} proposal={proposal} index={index} busy={adoptingProposalId !== null || decidingProposalId !== null} canAdopt={plan.status === 'current'} onAdopt={(adoption) => adoptProposal(proposal, adoption)} onDecide={(decision) => decideProposal(proposal.id, decision)} onOpenEvidence={onOpenEvidence} />)}</div></section>
      <section className="panel"><div className="panel__heading"><h3>已采纳行动</h3><StatusBadge tone="neutral">{plan.adoptedActions.length} 项</StatusBadge></div>{plan.adoptedActions.length > 0 ? plan.adoptedActions.map((action) => <div className="completed-item adopted-action-card" key={action.id}><Check size={16} /><div><strong>{action.title}</strong><span>{action.userGoal}</span><small>{action.selectedStartingOption} · {action.owner}{action.plannedTime ? ` · ${action.plannedTime}` : ''}{action.dueDate ? ` · ${action.dueDate} 回顾` : ''}</small>{action.progressNote && <small>备注：{action.progressNote}</small>}</div></div>) : <p className="muted-copy">还没有主动采纳的行动。</p>}</section>
    </> : <section className="panel personal-empty-state"><ShieldCheck size={28} /><div><span className="eyebrow">生活与行动</span><h2>目前还没有适合你的行动方案</h2><p>只有在个人资料依据和安全复核都足够时，这里才会给出具体做法；不会用通用模板冒充个性化建议。</p></div></section>}</div>}
    {!loading && tab === 'sources' && <section className="panel"><div className="panel__heading"><div><span className="eyebrow">原始资料</span><h2>报告只作为证据来源</h2></div><button className="primary-button" onClick={onImport}><Plus size={17} /> 添加资料</button></div><p className="body-copy">这里管理文件与来源；阅读健康状况请回到“身体与指标”或“检查时间线”。</p>{personDocuments.length > 0 ? <div className="source-document-list">{personDocuments.map((document) => <article key={document.id}><span className="file-icon"><FileText size={18} /></span><div><strong>{document.displayName}</strong><small>{document.format} · {document.sourceLabel}</small></div><StatusBadge tone={document.status === 'completed' ? 'success' : document.status === 'queued' ? 'info' : 'neutral'}>{document.status === 'completed' ? '已处理' : document.status === 'queued' ? '待处理' : document.status}</StatusBadge><button className="text-button" onClick={() => onOpenEvidence({ title: document.displayName, label: document.sourceLabel, quote: '正在读取受控来源片段…', meta: '界面不会获取本机文件路径。', documentId: document.id })}>查看原件</button>{document.status === 'ignored' ? <button className="text-button" onClick={() => onReincludeDocument(document)}>重新纳入</button> : <button className="text-button" onClick={() => onExcludeDocument(document)}>移出分析</button>}<button className="text-button is-danger" aria-label="删除本机档案" onClick={() => onDeleteDocument(document)}>删除</button></article>)}</div> : <div className="table-empty"><FileText size={24} /><strong>还没有原始资料</strong><span>添加报告后，文件会先保存在本机。</span></div>}<div className="dialog-actions"><button className="secondary-button" onClick={onDeletedDocuments}>查看已删除资料记录</button></div></section>}
  </div>;
}
