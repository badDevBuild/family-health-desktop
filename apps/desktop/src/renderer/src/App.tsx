import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Archive,
  ArrowRight,
  Bell,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  FileCheck2,
  FileText,
  FolderHeart,
  HeartPulse,
  Home,
  Inbox,
  LayoutDashboard,
  ListChecks,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  UsersRound,
  X
} from 'lucide-react';
import { DEFAULT_AI_PREFERENCES, updateActionScheduleInputSchema } from '@contracts';
import type { UpdateActionScheduleInput } from '@contracts';
import type { ProcessingRebuildReceipt } from '@contracts';
import type { ActionItem, AiModelOption, AiPreferences, AiReasoningEffort, BodySystemSummaryV2, CreateActionItemInput, CreateManualNoteInput, DashboardSnapshot, DeletedDocumentSummary, DiagnosticBundle, DisplayPreferences, ExportMemberSummaryInput, ImportFilesReceipt, InboxBindingSummary, InboxItem, JobSummary, ManualNote, MemberOverviewV2, Person, PersonSummary, ResolveReviewInput, ReviewIssue, UpdatePersonDisplayInput } from '@contracts';
import { createDemoSnapshot } from '../../../../../packages/test-fixtures/src/index.js';
import { StatusBadge, type Tone } from './components/StatusBadge.js';
import { TrendChart } from './components/TrendChart.js';
import { MemberProfileV2 } from './features/member/MemberProfileV2.js';
import { ReportUploadPanel } from './ReportUploadPanel.js';
import { ReadingHealthMap } from './features/member/ReadingHealthMap.js';
import { ReadingPriorityPreview } from './features/member/ReadingPriorityPreview.js';
import { DateCorrectionConsentDialog, type DateCorrectionConsentResult } from './DateCorrectionConsentDialog.js';
import { assessmentOverviewText } from './features/member/assessment-overview-text.js';
import { savedActionTitle, type MemberQuestionPrompt } from './features/member/member-content.js';
import { isSourceRepairReview, isUserAssignedIdentityRepairDocument, isUserAssignedIdentityRepairReview, jobProcessingPresentation, reportProcessingPresentation } from './processing-presentation.js';

type Page = 'home' | 'people' | 'inbox' | 'processing' | 'actions' | 'settings';
type Evidence = {
  title: string;
  label: string;
  quote: string;
  meta: string;
  sourceSpanId?: string | null;
  documentId?: string | null;
  previewImageDataUrl?: string | null;
  previewState?: 'loading' | 'ready' | 'unavailable';
};
type DesktopBehavior = { stayInTray: boolean | null; openAtLogin: boolean; notificationsEnabled: boolean };
type RecoveryStatus = { pointCount: number; totalBytes: number; latestAt: string | null };
type ManualProcessRequest = { kind: 'documents'; documentIds: string[] | null }
  | { kind: 'assessment'; personId: string }
  | { kind: 'date_correction'; documentId: string };

const navigation: Array<{ id: Page; label: string; icon: typeof Home }> = [
  { id: 'home', label: '家庭总览', icon: LayoutDashboard },
  { id: 'people', label: '成员档案', icon: UsersRound },
  { id: 'actions', label: '后续事项', icon: ListChecks },
  { id: 'inbox', label: '报告收件箱', icon: Inbox },
  { id: 'processing', label: '处理中心', icon: Activity },
  { id: 'settings', label: '设置', icon: Settings }
];

const organIcon: Record<string, string> = {
  cardiovascular: '♥', metabolic: '◒', hepatobiliary: '◇', renal: '◉',
  digestive: '≈', hematology: '✦', respiratory: '∞', sensory: '◎'
};

let activeDateStyle: DisplayPreferences['dateStyle'] = 'friendly';

function formatDateTime(value: string | null): string {
  if (!value) return '尚未安排';
  return new Intl.DateTimeFormat('zh-CN', activeDateStyle === 'numeric'
    ? { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
    : { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

const reasoningEffortLabels: Record<AiReasoningEffort, string> = {
  low: '低', medium: '中等', high: '高', xhigh: '很高', max: '最高'
};

function modelPreferenceLabel(preferences: AiPreferences): string {
  const model = preferences.modelId === 'gpt-6.1-sol' ? 'GPT-6.1-Sol'
    : preferences.modelId === 'gpt-6-sol' ? 'GPT-6-Sol'
    : preferences.modelId === 'gpt-5.6-sol' ? 'GPT-5.6-Sol' : preferences.modelId;
  return `${model} · ${reasoningEffortLabels[preferences.reasoningEffort]}推理`;
}

function importReceiptMessage(receipt: ImportFilesReceipt): string {
  const rejected = receipt.rejected.length;
  const base = `已保存 ${receipt.importedCount} 份资料到本机${receipt.duplicateCount ? `，跳过 ${receipt.duplicateCount} 份重复资料` : ''}${receipt.suppressedCount ? `，跳过 ${receipt.suppressedCount} 份曾删除的资料` : ''}${rejected ? `，${rejected} 份未能导入` : ''}。`;
  const firstCode = receipt.rejected[0]?.code;
  if (firstCode === 'LEGACY_DOC_CONVERSION_REQUIRED') {
    return `${base} 暂时无法读取旧版 .doc，原文件已保留。请用 Word 另存为 .docx 或导出 PDF 后重新添加。`;
  }
  if (firstCode === 'LEGACY_DOC_TEXT_UNREADABLE') {
    return `${base} 旧版 .doc 没有可可靠读取的正文；原文件已保留，请用 Word 另存为 .docx 或导出 PDF 后重新添加。`;
  }
  if (firstCode === 'UNSUPPORTED_FORMAT' || firstCode === 'EXTENSION_NOT_ALLOWED' || firstCode === 'MAGIC_SIGNATURE_MISMATCH') {
    return `${base} 请确认文件是真实的 PDF、JPEG、PNG、HEIC/HEIF、DOCX 或 TXT，且扩展名与内容一致。`;
  }
  return receipt.processing?.status === 'queued' ? `${base} 正在自动整理报告，完成后会更新健康看板。`
    : receipt.processing?.status === 'waiting_connection' ? `${base} 已保存整理进度，连接 Codex 后会自动继续。`
    : base;
}

function isInboxIntakeItem(item: InboxItem, reviews: ReviewIssue[]): boolean {
  const openReviews = reviews.filter((review) => review.documentId === item.id && review.resolutionStatus === 'open');
  const sourceReviewCompleted = item.status === 'needs_review' && item.aiTransmissionStatus === 'completed'
    && item.personId !== null && openReviews.length > 0 && openReviews.every((review) => isReadOnlyResultLimitation(review, item, openReviews));
  // 兼容旧快照：来源事项与可按用户选择恢复的旧姓名门禁归处理中心；未知归属仍保留。
  return !item.inProcessingCenter && ['discovered', 'stabilizing', 'queued', 'needs_review'].includes(item.status)
    && !sourceReviewCompleted;
}

function Sidebar({ page, setPage, snapshot, onWorkspace }: {
  page: Page;
  setPage(page: Page): void;
  snapshot: DashboardSnapshot;
  onWorkspace(): void;
}) {
  const pendingInboxCount = snapshot.inbox.filter((item) => isInboxIntakeItem(item, snapshot.reviews)
    && item.status === 'queued').length;
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand__mark"><HeartPulse size={22} strokeWidth={2.2} /></div>
        <div><strong>家庭健康</strong><span>本地看板</span></div>
      </div>

      <nav className="side-nav" aria-label="主导航">
        {navigation.map(({ id, label, icon: Icon }) => (
          <button key={id} className={page === id ? 'side-nav__item is-active' : 'side-nav__item'} aria-label={label} aria-current={page === id ? 'page' : undefined} title={label} onClick={() => setPage(id)}>
            <Icon size={19} aria-hidden="true" />
            <span>{label}</span>
            {id === 'inbox' && pendingInboxCount > 0 && <em aria-hidden="true">{pendingInboxCount}</em>}
            {id === 'processing' && snapshot.jobs.some((job) => job.status === 'running') && <i aria-label="正在处理" />}
          </button>
        ))}
      </nav>

      <div className="sidebar__bottom">
        <div className="privacy-mini">
          <ShieldCheck size={18} />
          <div><strong>资料保存在本机</strong><span>发送前会检查授权范围</span></div>
        </div>
        <button className="workspace-switcher" aria-label={`切换工作区：${snapshot.workspaceName}`} onClick={onWorkspace}>
          <span className="avatar avatar--small">{snapshot.workspaceMode === 'demo' ? '演' : (snapshot.persons[0]?.avatarInitial ?? '家')}</span>
          <span><strong>{snapshot.workspaceName}</strong><small>{snapshot.workspaceMode === 'demo' ? '虚构演示空间' : '本机个人工作区'}</small></span>
          <ChevronDown size={16} />
        </button>
      </div>
    </aside>
  );
}

function Topbar({ snapshot, onLogin, onProcessing }: { snapshot: DashboardSnapshot; onLogin(): void; onProcessing(): void }) {
  const accountPresentation = snapshot.account.status === 'connected'
    ? { label: 'Codex 已连接', className: 'ai-state is-connected' }
    : snapshot.account.status === 'connecting'
      ? { label: '正在连接 Codex', className: 'ai-state is-connecting' }
      : snapshot.account.status === 'expired'
        ? { label: 'Codex 需重连', className: 'ai-state is-error' }
        : snapshot.account.status === 'error'
          ? { label: 'Codex 不可用', className: 'ai-state is-error' }
          : { label: 'Codex 待连接', className: 'ai-state' };
  return (
    <header className="topbar">
      <div className={snapshot.workspaceMode === 'demo' ? 'demo-banner' : 'demo-banner is-personal'}>
        {snapshot.workspaceMode === 'demo' ? <Sparkles size={15} /> : <ShieldCheck size={15} />}
        {snapshot.workspaceMode === 'demo' ? '纯虚构演示资料' : '本机个人工作区'}
      </div>
      <div className="topbar__actions">
        <button className="icon-button" aria-label="查看处理通知与任务" onClick={onProcessing}>
          <Bell size={19} />
          {snapshot.jobs.some((job) => ['running', 'waiting_auth', 'waiting_quota'].includes(job.status)
            || (job.canRetry && job.status === 'failed')) && <i />}
        </button>
        <button className={accountPresentation.className} aria-label={accountPresentation.label} onClick={onLogin} title={snapshot.account.displayLabel ?? undefined}>
          <span className="ai-state__dot" />
          <span>{accountPresentation.label}</span>
          <ChevronDown size={15} />
        </button>
      </div>
    </header>
  );
}

function PersonCard({ person, selected, onClick }: { person: PersonSummary; selected: boolean; onClick(): void }) {
  const headline = person.derivedStatus === 'current' || person.assessmentSummary !== null
    ? assessmentOverviewText(person.changeSummary)
    : person.acceptedFactCount > 0 ? '报告结果已整理，可查看检查结果；健康解读待更新。'
      : person.documentCount > 0 ? '资料已保存，处理完成后可查看健康解读。' : '还没有健康资料，可先添加一份报告。';
  const summary = assessmentOverviewText(person.assessmentSummary);
  const [expanded, setExpanded] = useState(() => summary.length <= 320);
  // 每次真实投影变化都是独立请求代次；相同事实数量也可能有修正或新解读。
  const readingRequest = useMemo(() => ({
    personId: person.id, factCount: person.acceptedFactCount, dataRevision: person.dataRevision,
    displayRevision: person.displayRevision, clinicalContextRevision: person.clinicalContextRevision,
    derivedStatus: person.derivedStatus, headline: person.changeSummary, summary: person.assessmentSummary
  }), [person.id, person.acceptedFactCount, person.dataRevision, person.displayRevision,
    person.clinicalContextRevision, person.derivedStatus, person.changeSummary, person.assessmentSummary]);
  const [systemReading, setSystemReading] = useState<{ request: typeof readingRequest; systems: BodySystemSummaryV2[] } | null>(null);
  const [priorityReading, setPriorityReading] = useState<{ request: typeof readingRequest; issues: MemberOverviewV2['priorityIssues'] } | null>(null);
  useEffect(() => {
    const read = window.healthDesktop?.listBodySystems;
    let active = true;
    // 仅读取已存在的身体投影；进入家庭总览不会触发模型。
    void Promise.resolve().then(() => active && read && readingRequest.factCount > 0 ? read(readingRequest.personId) : null)
      .then((result) => {
        if (active) setSystemReading(result?.ok ? { request: readingRequest, systems: result.data } : null);
      }).catch(() => {
        // 清除失效投影；读取失败仍保留整体正文，不用旧地图或猜测填充。
        if (active) setSystemReading(null);
      });
    return () => { active = false; };
  }, [readingRequest]);
  useEffect(() => {
    const read = window.healthDesktop?.getMemberOverview;
    let active = true;
    // 读取同一成员当前已发布主题，不从长正文截句，也不启动综合或重核。
    void Promise.resolve().then(() => active && read && readingRequest.factCount > 0 ? read(readingRequest.personId) : null)
      .then((result) => {
        // 同成员也可能刚发布新版；标题、完整总述和事实数量必须与卡片当前投影一致。
        if (active) setPriorityReading(result?.ok && result.data.personId === readingRequest.personId
          && result.data.acceptedFactCount === readingRequest.factCount
          && assessmentOverviewText(result.data.headline) === assessmentOverviewText(readingRequest.headline)
          && assessmentOverviewText(result.data.overview) === assessmentOverviewText(readingRequest.summary)
          ? { request: readingRequest, issues: result.data.priorityIssues } : null);
      }).catch(() => { if (active) setPriorityReading(null); });
    return () => { active = false; };
  }, [readingRequest]);
  const hasSummary = summary.length > 0 && summary !== headline;
  return (
    <article className={selected ? 'person-card is-selected' : 'person-card'}>
      <button className="person-card__entry" onClick={onClick} aria-label={`${person.displayName}，查看健康解读`}>
        <span className="person-card__top">
        <span className="avatar">{person.avatarInitial}</span>
        <span className="person-card__identity"><strong>{person.displayName}</strong><small>{person.relation}</small></span>
        <ChevronRight size={18} />
        </span>
        <span className="person-card__health"><span className="eyebrow">整体健康情况</span><strong>{headline || '可查看已有报告结果。'}</strong></span>
      </button>
      {hasSummary && !expanded && person.acceptedFactCount > 0 && priorityReading?.request === readingRequest
        && <ReadingPriorityPreview issues={priorityReading.issues} onOpenOverview={onClick} />}
      {hasSummary && expanded && <p className="person-card__summary">{summary}</p>}
      {hasSummary && <button className="person-card__expand" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? '收起完整整体情况' : '展开完整整体情况'} <ChevronDown size={16} /></button>}
      {person.acceptedFactCount > 0 && systemReading?.request === readingRequest && <ReadingHealthMap systems={systemReading.systems} compact />}
      {person.lastDocumentDate && <small className="person-card__date">最近检查：{person.lastDocumentDate}</small>}
      {person.derivedStatus === 'stale' && <small className="person-card__date">{person.assessmentRefreshStatus === 'optional_rules'
        ? '已发布解读基于此前规则，仍对应当前资料；可选择按新规则更新。'
        : person.assessmentSummary !== null ? '此前已发布解读，需结合当前资料更新。' : '此前的健康解读，可更新后继续安排下一步。'}</small>}
      <button className="person-card__cta" onClick={onClick}>查看健康解读 <ArrowRight size={16} /></button>
    </article>
  );
}

function HomePage({ snapshot, selectedPersonId, onSelectPerson, onNavigate, onAddPerson }: {
  snapshot: DashboardSnapshot;
  selectedPersonId: string;
  onSelectPerson(id: string): void;
  onNavigate(page: Page): void;
  onAddPerson(): void;
}) {
  const selected = snapshot.persons.find((person) => person.id === selectedPersonId) ?? snapshot.persons[0];
  return (
    <div className="page-stack family-overview">
      <section className="welcome-row">
        <div>
          <span className="eyebrow">{new Date().getHours() < 12 ? '早上好' : new Date().getHours() < 18 ? '下午好' : '晚上好'}</span>
          <h1>家人的健康档案</h1>
          <p>选择一位家人，直接查看身体情况和下一步。</p>
        </div>
        <button className="primary-button" onClick={() => onNavigate('inbox')}><Plus size={18} /> 添加健康资料</button>
      </section>

      <section className="section-block">
        <div className="section-heading">
          <div><h2>家庭成员</h2></div>
          <button className="text-button" onClick={() => snapshot.workspaceMode === 'personal' ? onAddPerson() : onNavigate('people')}>添加成员 <ArrowRight size={16} /></button>
        </div>
        <div className="person-grid">
          {snapshot.persons.map((person) => <PersonCard key={person.id} person={person} selected={person.id === selectedPersonId} onClick={() => onSelectPerson(person.id)} />)}
          <button className="add-person-card" onClick={() => snapshot.workspaceMode === 'personal' ? onAddPerson() : onNavigate('people')}><Plus size={21} /><span>添加家庭成员</span></button>
        </div>
      </section>

      {selected && snapshot.workspaceMode === 'personal' && selected.documentCount === 0 && (
        <section className="panel getting-started-panel">
          <span className="getting-started-panel__icon"><ShieldCheck size={24} /></span>
          <div>
            <span className="eyebrow">从第一份资料开始</span>
            <h2>为 {selected.displayName} 添加一份健康资料</h2>
            <p>支持 PDF、图片、DOCX 和纯文本。上传后由 OpenAI/Codex 自动整理报告并生成健康看板。</p>
          </div>
          <button className="primary-button" onClick={() => onNavigate('inbox')}><Plus size={18} /> 前往收件箱</button>
        </section>
      )}

    </div>
  );
}

function PeoplePage({ snapshot, selectedPersonId, onSelectPerson, onOpenEvidence, onAddPerson, onEditPerson, onArchivedPeople, onAddNote, onExport, onImport, onUploadReports, onRefreshAssessment, onCorrectDocumentDate, onExcludeDocument, onReincludeDocument, onDeleteDocument, onDeletedDocuments }: {
  snapshot: DashboardSnapshot;
  selectedPersonId: string;
  onSelectPerson(id: string): void;
  onOpenEvidence(evidence: Evidence): void;
  onAddPerson(): void;
  onEditPerson(): void;
  onArchivedPeople(): void;
  onAddNote(question?: MemberQuestionPrompt): void;
  onExport(): void;
  onImport(): void;
  onUploadReports(personId: string): void;
  onRefreshAssessment(personId: string): void;
  onCorrectDocumentDate(document: InboxItem): void;
  onExcludeDocument(document: InboxItem): void;
  onReincludeDocument(document: InboxItem): void;
  onDeleteDocument(document: InboxItem): void;
  onDeletedDocuments(): void;
}) {
  const person = snapshot.persons.find((item) => item.id === selectedPersonId) ?? snapshot.persons[0];
  const [tab, setTab] = useState<'overview' | 'body' | 'metrics' | 'timeline' | 'guide' | 'documents'>('overview');
  const [metricVisibleCount, setMetricVisibleCount] = useState(12);
  if (!person) return <div className="page-stack"><section className="panel personal-empty-state"><Archive size={28} /><div><span className="eyebrow">成员档案</span><h1>当前没有显示中的成员</h1><p>你可以新增成员，或恢复已归档成员。归档不会删除原始报告和历史记录。</p><div className="button-row"><button className="primary-button" onClick={onAddPerson}><Plus size={17} /> 添加成员</button><button className="secondary-button" onClick={onArchivedPeople}><Archive size={17} /> 已归档成员</button></div></div></section></div>;
  if (snapshot.workspaceMode === 'personal') return <MemberProfileV2
    key={person.id}
    snapshot={snapshot}
    person={person}
    onSelectPerson={(id) => { setMetricVisibleCount(12); onSelectPerson(id); }}
    onOpenEvidence={onOpenEvidence}
    onAddPerson={onAddPerson}
    onEditPerson={onEditPerson}
    onArchivedPeople={onArchivedPeople}
    onAddNote={onAddNote}
    onExport={onExport}
    onUploadReports={onUploadReports}
    onRefreshAssessment={() => onRefreshAssessment(person.id)}
    onCorrectDocumentDate={onCorrectDocumentDate}
    onExcludeDocument={onExcludeDocument}
    onReincludeDocument={onReincludeDocument}
    onDeleteDocument={onDeleteDocument}
    onDeletedDocuments={onDeletedDocuments}
  />;
  const tabs = [
    ['overview', '概览'], ['body', '身体'], ['metrics', '指标'], ['timeline', '时间线'], ['guide', '生活指南'], ['documents', '资料']
  ] as const;
  const isDemo = snapshot.workspaceMode === 'demo';
  const personOrgans = snapshot.organs.filter((organ) => organ.personId === person.id);
  const personTrends = snapshot.trends.filter((trend) => trend.personId === person.id);
  const comparableTrends = personTrends.filter((trend) => trend.points.length >= 2 && trend.name !== '年龄');
  const singleRecordTrends = personTrends.filter((trend) => trend.points.length === 1 && trend.name !== '年龄');
  const personGuidance = snapshot.guidance.filter((item) => item.personId === person.id);
  const hasAcceptedFacts = person.acceptedFactCount > 0;
  const personNotes = snapshot.notes.filter((note) => note.personId === person.id);
  const hasManualNotes = personNotes.length > 0;
  return (
    <div className="page-stack">
      <div className="member-header panel">
        <div className="member-header__identity"><span className="avatar avatar--large">{person.avatarInitial}</span><div><span className="eyebrow">成员档案</span><h1>{person.displayName}</h1><p>{person.relation} · {person.documentCount} 份资料 · {person.freshnessLabel}</p></div></div>
        <div className="member-header__controls">
          <select value={person.id} onChange={(event) => { setMetricVisibleCount(12); onSelectPerson(event.target.value); }} aria-label="切换成员">
            {snapshot.persons.map((item) => <option key={item.id} value={item.id}>{item.displayName} · {item.relation}</option>)}
          </select>
        </div>
      </div>
      <div className="tabs" role="tablist">
        {tabs.map(([id, label]) => <button role="tab" aria-selected={tab === id} className={tab === id ? 'is-active' : ''} key={id} onClick={() => setTab(id)}>{label}</button>)}
      </div>
      {!isDemo && !hasAcceptedFacts && !hasManualNotes && tab !== 'documents' && (
        <section className="panel personal-empty-state">
          <ShieldCheck size={28} />
          <div>
            <span className="eyebrow">真实个人档案</span>
            <h2>{person.documentCount > 0 ? '已导入资料，尚未形成分析结果' : '还没有健康资料'}</h2>
            <p>{person.documentCount > 0
              ? '资料已保存在报告收件箱。连接 Codex，在收件箱确认发送范围并开始整理后，可在这里查看检查结果和健康解读。'
              : '请从报告收件箱导入资料。添加报告后即可整理检查结果和健康解读。'}</p>
          </div>
        </section>
      )}
      {!isDemo && (hasAcceptedFacts || hasManualNotes) && tab === 'overview' && (
        <div className="member-overview-grid">
          <section className="panel narrative-panel">
            <span className="eyebrow">{hasAcceptedFacts ? '报告结果' : '本人补充资料'}</span>
            <h2>{hasAcceptedFacts ? (person.derivedStatus === 'current' ? (person.assessmentSummary ?? '已有报告结果与健康解读') : '已有报告结果可查看') : '目前只有本人填写的健康资料'}</h2>
            <p>{hasAcceptedFacts ? (person.derivedStatus === 'current' ? '以下健康解读根据报告结果整理，不能替代医生面诊。' : '这里先展示报告明确写出的值、日期和异常标记。应用不会仅凭这些记录自动作出诊断或治疗建议。') : '这些内容不是医院检验或医生诊断；后续如用于 AI 整理，仍会保留“本人自述”的来源。'}</p>
            <StatusBadge tone={person.derivedStatus === 'current' ? 'success' : 'info'}>{person.derivedStatus === 'current' ? '健康解读' : '健康解读待更新'}</StatusBadge>
          </section>
          <section className="panel wide-panel">
            <div className="panel__heading"><div><span className="eyebrow">八大系统</span><h2>有来源的身体信息</h2></div><StatusBadge tone="neutral">不计算健康总分</StatusBadge></div>
            <div className="organ-card-grid">{personOrgans.map((organ) => <button key={organ.id} onClick={() => setTab('body')}><span className={`organ-symbol organ-symbol--${organ.status}`}>{organIcon[organ.id]}</span><strong>{organ.name}</strong><small>{organ.summary}</small><ChevronRight size={16} /></button>)}</div>
          </section>
          {hasManualNotes && <ManualNotesCard notes={personNotes} />}
        </div>
      )}
      {!isDemo && hasAcceptedFacts && tab === 'body' && <section className="panel"><div className="panel__heading"><div><span className="eyebrow">身体轴</span><h2>按器官系统阅读报告事实</h2></div></div><div className="organ-grid organ-grid--roomy">{personOrgans.map((organ) => <button key={organ.id} className="organ-row" disabled={!organ.evidenceSourceSpanId} onClick={() => onOpenEvidence({ title: `${organ.name}说明的依据`, label: organ.evidenceDate ?? '未知资料日期', quote: organ.summary, meta: `${organ.metricCount} 项相关记录`, sourceSpanId: organ.evidenceSourceSpanId })}><span className={`organ-symbol organ-symbol--${organ.status}`}>{organIcon[organ.id]}</span><span><strong>{organ.name}</strong><small>{organ.summary}</small></span><StatusBadge tone={organ.status === 'attention' ? 'warning' : organ.status === 'stable' ? 'success' : 'neutral'}>{organ.status === 'attention' ? '有需关注记录' : organ.status === 'stable' ? '本次未标记异常' : '资料不足'}</StatusBadge></button>)}</div></section>}
      {!isDemo && hasAcceptedFacts && tab === 'metrics' && <div className="metric-page-stack">
        <section className="panel"><div className="panel__heading"><div><span className="eyebrow">可比较趋势</span><h2>至少有两次同口径记录</h2></div><StatusBadge tone="neutral">{comparableTrends.length} 项</StatusBadge></div>{comparableTrends.length > 0 ? comparableTrends.map((series) => <div key={series.id} className="metric-detail"><div><strong>{series.name}</strong><p>{series.interpretation}</p></div><TrendChart series={series} onSelectPoint={(index) => { const point = series.points[index]; if (point) onOpenEvidence({ title: series.name, label: point.sourceLabel, quote: `${series.name} ${point.displayValue} ${series.unit ?? ''}`, meta: `报告参考范围：${point.referenceLow ?? '未知'}–${point.referenceHigh ?? '未知'} ${series.unit ?? ''}`, sourceSpanId: point.sourceSpanId, documentId: point.documentId }); }} /></div>) : <div className="table-empty compact-empty"><Activity size={24} /><strong>暂时没有可靠趋势</strong><span>需要至少两次带日期、同单位的数值记录才会画线。</span></div>}</section>
        {singleRecordTrends.length > 0 && <section className="panel"><div className="panel__heading"><div><span className="eyebrow">单次记录</span><h2>先看结果，不伪装成趋势</h2></div><StatusBadge tone="neutral">显示 {Math.min(metricVisibleCount, singleRecordTrends.length)} / {singleRecordTrends.length} 项</StatusBadge></div><div className="single-metric-grid">{singleRecordTrends.slice(0, metricVisibleCount).map((series) => { const point = series.points[0]!; return <button key={series.id} onClick={() => onOpenEvidence({ title: series.name, label: point.sourceLabel, quote: `${series.name} ${point.displayValue} ${series.unit ?? ''}`, meta: series.interpretation, sourceSpanId: point.sourceSpanId, documentId: point.documentId })}><span><strong>{series.name}</strong><small>{series.interpretation}</small></span><b>{point.displayValue}<small>{series.unit ?? ''}</small></b><ChevronRight size={16} /></button>; })}</div>{singleRecordTrends.length > metricVisibleCount && <div className="dialog-actions"><button className="secondary-button" onClick={() => setMetricVisibleCount((count) => count + 24)}>再显示 {Math.min(24, singleRecordTrends.length - metricVisibleCount)} 项</button></div>}</section>}
      </div>}
      {!isDemo && hasAcceptedFacts && tab === 'guide' && personGuidance.length > 0 && <div className="guide-grid"><section className="panel guide-hero"><span className="eyebrow">日常生活指南</span><h2>从低风险、容易坚持的方向开始</h2><p>这些内容基于现有报告事实，不替代医生给出的个体化治疗。</p><div className="priority-list">{personGuidance.map((item, index) => <div key={item.id}><span>{index + 1}</span><p><strong>{item.title}</strong>{item.detail}</p></div>)}</div></section><section className="panel"><span className="eyebrow">建议的依据与适用范围</span><h3>结合报告理解建议</h3><p className="body-copy">共引用 {personGuidance.reduce((total, item) => total + item.evidenceCount, 0)} 条报告结果；标记为需要专业确认的内容仍应带着原报告咨询医生。</p><StatusBadge tone="info">一般教育内容</StatusBadge></section></div>}
      {!isDemo && hasAcceptedFacts && tab === 'guide' && personGuidance.length === 0 && <section className="panel personal-empty-state"><ShieldCheck size={28} /><div><span className="eyebrow">尚未生成这一层内容</span><h2>生活指南尚未生成</h2><p>报告结果不会丢失；缺少对应投影时保持空白，不用演示数据替代。</p></div></section>}
      {!isDemo && tab === 'timeline' && <PersonalTimelineView key={`timeline-${person.id}`} snapshot={snapshot} personId={person.id} onOpenEvidence={onOpenEvidence} />}
      {!isDemo && tab === 'documents' && <PersonalDocumentsView key={`documents-${person.id}`} snapshot={snapshot} personId={person.id} onOpenEvidence={onOpenEvidence} onImport={onImport} onExclude={onExcludeDocument} onReinclude={onReincludeDocument} onDelete={onDeleteDocument} onDeletedDocuments={onDeletedDocuments} />}
      {isDemo && tab === 'overview' && (
        <div className="member-overview-grid">
          <section className="panel narrative-panel">
            <span className="eyebrow">综合说明 · AI 整理</span>
            <h2>最近资料里，最值得留意的是血脂变化</h2>
            <p>2024 至 2026 年的三次记录显示，低密度脂蛋白胆固醇从 3.6、3.9 到 4.2 mmol/L。本次报告参考上限为 3.4 mmol/L。这个变化值得在下次就诊时带上原报告咨询医生。</p>
            <button className="evidence-link" onClick={() => onOpenEvidence({ title: '综合说明的依据', label: '三次虚构年度体检报告', quote: 'LDL-C：3.6 → 3.9 → 4.2 mmol/L', meta: '根据报告结果整理，供理解身体情况时参考' })}><FileCheck2 size={17} /> 查看 3 条依据</button>
          </section>
          <section className="panel coverage-panel">
            <span className="eyebrow">资料覆盖</span><h2>{person.documentCount} 份资料</h2>
            <div className="coverage-list"><span><i style={{ width: '82%' }} />体检与检验</span><span><i style={{ width: '54%' }} />影像文字报告</span><span><i style={{ width: '35%' }} />就医与自述</span></div>
            <p>资料覆盖只表示已有记录范围，不代表健康程度。</p>
          </section>
          <section className="panel wide-panel"><div className="panel__heading"><div><span className="eyebrow">八大系统</span><h2>身体信息</h2></div><StatusBadge tone="neutral">不计算健康总分</StatusBadge></div><div className="organ-card-grid">{personOrgans.map((organ) => <button key={organ.id} onClick={() => setTab('body')}><span className={`organ-symbol organ-symbol--${organ.status}`}>{organIcon[organ.id]}</span><strong>{organ.name}</strong><small>{organ.status === 'attention' ? '有记录需关注' : organ.status === 'stable' ? '现有记录平稳' : '资料不足'}</small><ChevronRight size={16} /></button>)}</div></section>
        </div>
      )}
      {isDemo && tab === 'body' && <section className="panel"><div className="panel__heading"><div><span className="eyebrow">身体轴</span><h2>按器官系统阅读</h2></div></div><div className="organ-grid organ-grid--roomy">{personOrgans.map((organ) => <button key={organ.id} className="organ-row" onClick={() => onOpenEvidence({ title: organ.name, label: organ.evidenceDate ?? '未知资料日期', quote: organ.summary, meta: `${organ.metricCount} 项相关记录` })}><span className={`organ-symbol organ-symbol--${organ.status}`}>{organIcon[organ.id]}</span><span><strong>{organ.name}</strong><small>{organ.summary}</small></span><ChevronRight size={18} /></button>)}</div></section>}
      {isDemo && tab === 'metrics' && <section className="panel"><div className="panel__heading"><div><span className="eyebrow">指标轴</span><h2>可以比较的趋势</h2></div></div>{personTrends.map((series) => <div key={series.id} className="metric-detail"><div><strong>{series.name}</strong><p>{series.interpretation}</p></div><TrendChart series={series} onSelectPoint={(index) => { const point = series.points[index]; if (point) onOpenEvidence({ title: series.name, label: point.sourceLabel, quote: `${point.displayValue} ${series.unit ?? ''}`, meta: series.comparisonNote }); }} /></div>)}</section>}
      {isDemo && tab === 'timeline' && <TimelineView onOpenEvidence={onOpenEvidence} />}
      {isDemo && tab === 'guide' && <GuideView />}
      {isDemo && tab === 'documents' && <DocumentsView onOpenEvidence={onOpenEvidence} />}
    </div>
  );
}

const manualNoteLabels: Record<ManualNote['kind'], string> = {
  history: '既往情况',
  allergy: '过敏记录',
  medication: '用药记录',
  self_measurement: '本人自测',
  goal: '生活目标',
  constraint: '身体或时间限制',
  free_text: '补充说明'
};

function ManualNotesCard({ notes }: { notes: ManualNote[] }) {
  return <section className="panel wide-panel"><div className="panel__heading"><div><span className="eyebrow">本人补充</span><h2>用户填写的健康资料</h2></div><StatusBadge tone="info">不是医院检验</StatusBadge></div><div className="manual-note-list">{notes.map((note) => <article key={note.id}><div><StatusBadge tone="neutral">{manualNoteLabels[note.kind]}</StatusBadge><time>{note.effectiveDate ?? '日期未知'}</time></div><strong>{note.immutableText}</strong>{note.kind === 'self_measurement' && <small>{note.structuredFields.measurementName}：{note.structuredFields.value}{note.structuredFields.unit ? ` ${note.structuredFields.unit}` : ''}</small>}</article>)}</div></section>;
}

function TimelineView({ onOpenEvidence }: { onOpenEvidence(evidence: Evidence): void }) {
  const events = [
    { date: '2026-09-12', title: '年度健康体检', type: '体检', text: '新增 42 项检验记录与 3 项报告结论', source: '2026年度体检.pdf' },
    { date: '2026-08-20', title: '家庭血压记录', type: '本人补充', text: '连续 7 天早晚自测，作为咨询参考', source: '用户记录' },
    { date: '2025-08-06', title: '年度健康体检', type: '体检', text: '新增 38 项检验记录', source: '2025年度体检.pdf' }
  ];
  return <section className="panel timeline-panel"><div className="panel__heading"><div><span className="eyebrow">时间轴</span><h2>健康事件</h2></div></div><div className="timeline-list">{events.map((event) => <button key={`${event.date}-${event.title}`} onClick={() => onOpenEvidence({ title: event.title, label: event.source, quote: event.text, meta: `${event.date} · ${event.type}` })}><time>{event.date}</time><i /><span><StatusBadge tone={event.type === '本人补充' ? 'info' : 'success'}>{event.type}</StatusBadge><strong>{event.title}</strong><small>{event.text}</small></span><ChevronRight size={17} /></button>)}</div></section>;
}

function PersonalTimelineView({ snapshot, personId, onOpenEvidence }: {
  snapshot: DashboardSnapshot;
  personId: string;
  onOpenEvidence(evidence: Evidence): void;
}) {
  const [visibleCount, setVisibleCount] = useState(50);
  const events = snapshot.timeline.filter((event) => event.personId === personId);
  const visibleEvents = events.slice(0, visibleCount);
  return <section className="panel timeline-panel"><div className="panel__heading"><div><span className="eyebrow">时间轴</span><h2>报告与本人补充记录</h2></div><StatusBadge tone="neutral">先显示 {Math.min(visibleCount, events.length)} / {events.length} 条</StatusBadge></div>{events.length > 0 ? <><div className="timeline-list">{visibleEvents.map((event) => <button key={event.id} onClick={() => onOpenEvidence({ title: event.title, label: event.sourceLabel, quote: event.summary, meta: `${event.dateLabel} · ${event.type === 'manual_note' ? '本人补充' : '报告记录'}`, sourceSpanId: event.sourceSpanId, documentId: event.documentId })}><time>{event.dateLabel}</time><i /><span><StatusBadge tone={event.type === 'manual_note' ? 'info' : 'success'}>{event.type === 'manual_note' ? '本人补充' : '报告记录'}</StatusBadge><strong>{event.title}</strong><small>{event.summary}</small></span><ChevronRight size={17} /></button>)}</div>{events.length > visibleCount && <div className="dialog-actions"><button className="secondary-button" onClick={() => setVisibleCount((count) => count + 50)}>再显示 {Math.min(50, events.length - visibleCount)} 条记录</button></div>}</> : <div className="table-empty"><Clock3 size={24} /><strong>还没有时间线记录</strong><span>未知日期会单独显示，不会使用导入时间代替临床日期。</span></div>}</section>;
}

function PersonalDocumentsView({ snapshot, personId, onOpenEvidence, onImport, onExclude, onReinclude, onDelete, onDeletedDocuments }: {
  snapshot: DashboardSnapshot;
  personId: string;
  onOpenEvidence(evidence: Evidence): void;
  onImport(): void;
  onExclude(document: InboxItem): void;
  onReinclude(document: InboxItem): void;
  onDelete(document: InboxItem): void;
  onDeletedDocuments(): void;
}) {
  const [visibleCount, setVisibleCount] = useState(50);
  const documents = snapshot.inbox.filter((item) => item.personId === personId);
  const visibleDocuments = documents.slice(0, visibleCount);
  return <section className="panel"><div className="panel__heading"><div><span className="eyebrow">原始资料</span><h2>资料与证据</h2><p>上传后由 OpenAI/Codex 自动整理报告并生成健康看板，使用本次原件、该成员必要的既有记录和本人补充信息。</p></div><div className="button-row"><StatusBadge tone="neutral">显示 {Math.min(visibleCount, documents.length)} / {documents.length} 份</StatusBadge><button className="secondary-button" onClick={onDeletedDocuments}><Trash2 size={17} /> 已删除资料</button><button className="secondary-button" onClick={onImport}><Plus size={17} /> 添加资料</button></div></div>{documents.length > 0 ? <><div className="document-list">{visibleDocuments.map((document) => <article className="document-row" key={document.id}><button className="document-row__open" onClick={() => onOpenEvidence({ title: document.displayName, label: document.sourceLabel, quote: '正在打开原始资料…', meta: `${document.format} · 导入于 ${formatDateTime(document.discoveredAt)}`, documentId: document.id })}><span className="file-icon"><FileText size={20} /></span><span><strong>{document.displayName}</strong><small>{document.format} · {reportProcessingPresentation(document, snapshot.reviews).label} · 导入于 {formatDateTime(document.discoveredAt)}</small>{document.issue && <small>{document.issue}</small>}</span><ChevronRight size={17} /></button><div className="button-row">{document.status === 'ignored' ? <button className="text-button" onClick={() => onReinclude(document)}><RefreshCw size={15} /> 重新纳入</button> : <button className="text-button" onClick={() => onExclude(document)}><Archive size={15} /> 移出分析</button>}<button className="text-button danger-text" onClick={() => onDelete(document)}><Trash2 size={15} /> 删除本机档案</button></div></article>)}</div>{documents.length > visibleCount && <div className="dialog-actions"><button className="secondary-button" onClick={() => setVisibleCount((count) => count + 50)}>再显示 {Math.min(50, documents.length - visibleCount)} 份资料</button></div>}</> : <div className="table-empty"><FileText size={24} /><strong>还没有原始资料</strong><span>添加后的原始报告会保存在本机。</span></div>}</section>;
}

function GuideView() {
  return <div className="guide-grid"><section className="panel guide-hero"><span className="eyebrow">日常生活指南</span><h2>从容易坚持的两件事开始</h2><p>这些是基于现有资料的一般生活建议，不替代医生给出的个体化治疗。</p><div className="priority-list"><div><span>1</span><p><strong>每周快走 4 次</strong>每次 30–40 分钟，感觉微喘但仍能说完整句子。</p></div><div><span>2</span><p><strong>主食不用戒，份量稍减</strong>每餐先保证蔬菜和蛋白质，再按饥饿感调整主食。</p></div></div></section><section className="panel"><span className="eyebrow">为什么这样建议</span><h3>依据与边界</h3><p className="body-copy">结合近三次血脂记录和现有体重资料，规律活动与饮食结构是低风险的起点。若正在治疗或运动时不适，请先咨询医生。</p><StatusBadge tone="info">一般教育内容</StatusBadge></section></div>;
}

function DocumentsView({ onOpenEvidence }: { onOpenEvidence(evidence: Evidence): void }) {
  const docs: ReadonlyArray<readonly [string, string, string]> = [
    ['2026年度体检.pdf', '2026-09-12', '12 页 · 已完成'],
    ['2025年度体检.pdf', '2025-08-06', '10 页 · 已完成'],
    ['家庭血压记录.txt', '2026-08-20', '本人补充 · 已归档']
  ];
  return <section className="panel"><div className="panel__heading"><div><span className="eyebrow">原始资料</span><h2>资料与证据</h2></div><StatusBadge tone="warning">纯虚构资料</StatusBadge></div><div className="document-list">{docs.map(([name, date, status]) => <button key={name} onClick={() => onOpenEvidence({ title: name, label: status, quote: '安全预览会在这里按页或文档块显示。演示模式不包含真实文件。', meta: `${date} · 虚构资料` })}><span className="file-icon"><FileText size={20} /></span><span><strong>{name}</strong><small>{date} · {status}</small></span><ChevronRight size={17} /></button>)}</div></section>;
}

function manualProcessingScope(snapshot: DashboardSnapshot, documentIds?: string[] | null) {
  const selectedIds = documentIds ? new Set(documentIds) : null;
  const activePersonIds = new Set(snapshot.persons.map((person) => person.id));
  const readyDocuments = snapshot.inbox.filter((item) => !item.inProcessingCenter && item.status === 'queued'
    && item.personId !== null && activePersonIds.has(item.personId) && (!selectedIds || selectedIds.has(item.id)));
  const blockedDocumentIds = new Set(snapshot.reviews.filter((review) => review.resolutionStatus === 'open'
    && (review.kind === 'overwrite_protected'
      || review.kind === 'person_conflict' && !isReadOnlyResultLimitation(review, snapshot.inbox.find((item) => item.id === review.documentId), snapshot.reviews)
      || !isReadOnlyResultLimitation(review, snapshot.inbox.find((item) => item.id === review.documentId), snapshot.reviews) && review.severity === 'blocking'))
    .map((review) => review.documentId));
  // 与后台局部重核门禁一致：活跃队列未结束时不另建重读范围；最终资格仍由存储事务复查。
  const repairQueueBusy = snapshot.jobs.some((job) => ['queued', 'running', 'waiting_auth', 'waiting_quota', 'retry_wait'].includes(job.status)
    || job.status === 'waiting_user' && job.completedUnits < job.totalUnits);
  const repairDocuments = selectedIds && !repairQueueBusy ? [...new Map(snapshot.inbox.filter((item) => selectedIds.has(item.id)
    && item.personId !== null && activePersonIds.has(item.personId) && !blockedDocumentIds.has(item.id)
    && (item.status === 'completed' && (item.dateBindingReviewCount ?? 0) > 0
      && !snapshot.reviews.some(review => review.documentId === item.id && review.resolutionStatus === 'open'
        && (review.severity === 'blocking' || review.kind === 'person_conflict' || review.kind === 'overwrite_protected'
          || review.candidateDiffs.length > 0 || review.reasonCodes.some(code => code.startsWith('PERSON_')
            || code === 'DIRECT_ORIGINAL_IDENTITY_UNPROVEN')))
      || snapshot.reviews.some((review) => review.documentId === item.id && review.personId === item.personId
      && review.resolutionStatus === 'open' && isReadOnlyResultLimitation(review, item, snapshot.reviews)
      && (item.status === 'completed' && review.severity === 'warning'
        || item.status === 'needs_review' && review.severity === 'blocking'))))
    .map((document) => [document.id, document])).values()] : [];
  const readyPersonIds = new Set(readyDocuments.map((item) => item.personId));
  const activePersonLabels = new Set(snapshot.jobs.filter((job) => ['queued', 'running', 'waiting_auth', 'waiting_quota', 'waiting_user', 'retry_wait'].includes(job.status))
    .map((job) => job.personLabel).filter((label): label is string => label !== null));
  const refreshPersons = documentIds ? [] : snapshot.persons.filter((person) => person.acceptedFactCount > 0
    && (person.assessmentRefreshStatus === 'required' || (person.assessmentRefreshStatus === undefined && person.derivedStatus !== 'current')) && !readyPersonIds.has(person.id)
    && !activePersonLabels.has(person.displayName));
  return { readyDocuments, repairDocuments, refreshPersons };
}

function InboxRefreshPrompt({ snapshot }: { snapshot: DashboardSnapshot; onRefresh(): void; onOptionalRefresh(personId: string): void }) {
  const { readyDocuments, refreshPersons } = manualProcessingScope(snapshot);
  const activeLabels = new Set(snapshot.jobs.filter((job) => ['queued', 'running', 'waiting_auth', 'waiting_quota', 'waiting_user', 'retry_wait'].includes(job.status)).map((job) => job.personLabel));
  const newReportPersonIds = new Set(readyDocuments.map((item) => item.personId));
  const optionalPersons = snapshot.persons.filter((person) => person.acceptedFactCount > 0
    && person.assessmentRefreshStatus === 'optional_rules' && !activeLabels.has(person.displayName) && !newReportPersonIds.has(person.id));
  if (snapshot.workspaceMode !== 'personal') return null;
  return <>{refreshPersons.length > 0 && <section className="info-callout assessment-refresh-callout" role="status">
    <RefreshCw size={20} aria-hidden="true" />
    <div><strong>{refreshPersons.length} 位成员的健康解读待更新</strong><p>报告结果已保存，现有内容仍可查看。后续上传资料会自动整理并更新健康看板。</p></div>

  </section>}{optionalPersons.length > 0 && <section className="info-callout assessment-refresh-callout" aria-label="可选的解读规则更新">
    <FileCheck2 size={20} aria-hidden="true" />
    <div><strong>现有解读可继续查看</strong><p>现有解读仍可阅读。{optionalPersons.length} 位成员的后续资料会按新版规则自动整理。</p></div>
  </section>}</>;
}

function InboxPage({ snapshot, selectedPersonId, onImport, onDropFiles, onAssign, onIgnore, onOpenEvidence, onDirectories, onProcessingCenter }: { snapshot: DashboardSnapshot; selectedPersonId: string; onProcess(documentIds?: string[]): void; onImport(personId: string | null): void; onDropFiles(files: File[], personId: string | null): void; onAssign(documentIds: string[], personId: string): Promise<void>; onIgnore(documentIds: string[]): Promise<void>; onOpenEvidence(evidence: Evidence): void; onDirectories(): void; onProcessingCenter(): void }) {
  const [filter, setFilter] = useState<'all' | InboxItem['status']>('all');
  const [personFilter, setPersonFilter] = useState('all');
  const [uploadSelection, setUploadSelection] = useState<string | null>(null);
  const dropPersonId = uploadSelection === null
    ? (snapshot.persons.find((person) => person.id === selectedPersonId) ?? snapshot.persons[0])?.id ?? ''
    : snapshot.persons.some((person) => person.id === uploadSelection) ? uploadSelection : '';
  const [assignPersonId, setAssignPersonId] = useState<string>(snapshot.persons[0]?.id ?? '');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [visibleCount, setVisibleCount] = useState(50);
  const inboxItems = snapshot.inbox.filter((item) => isInboxIntakeItem(item, snapshot.reviews));
  const items = inboxItems.filter((item) => (filter === 'all' || item.status === filter)
    && (personFilter === 'all' || (personFilter === 'unassigned' ? item.personId === null : item.personId === personFilter)));
  const visibleItems = items.slice(0, visibleCount);
  const selected = inboxItems.filter((item) => selectedIds.includes(item.id));
  const assignableIds = selected.filter((item) => item.status === 'needs_review' && item.personId === null).map((item) => item.id);
  const ignorableIds = selected.filter((item) => item.status !== 'ignored').map((item) => item.id);
  const allVisibleSelected = items.length > 0 && items.every((item) => selectedIds.includes(item.id));

  function toggleSelection(documentId: string) {
    setSelectedIds((current) => current.includes(documentId) ? current.filter((id) => id !== documentId) : [...current, documentId]);
  }

  async function runBulk(action: () => Promise<void>) {
    setBulkBusy(true);
    try { await action(); setSelectedIds([]); }
    finally { setBulkBusy(false); }
  }
  return <div className="page-stack">
    <section className="page-title-row"><div><span className="eyebrow">报告收件箱</span><h1>上传报告，查看健康看板</h1><p>上传后由 OpenAI/Codex 自动整理报告并生成健康看板。</p><p>将使用本次原件、该成员必要的既有记录和本人补充信息；不会自动修改本人计划。</p></div></section>
    {snapshot.workspaceMode === 'personal'
      ? <ReportUploadPanel persons={snapshot.persons} personId={dropPersonId} onSelectPerson={setUploadSelection} onImport={onImport} onDropFiles={onDropFiles} />
      : <button className="secondary-button" onClick={() => onImport(null)}><Plus size={17} /> 上传并整理</button>}
    <section className="panel"><div className="toolbar inbox-toolbar"><div className="filter-tabs"><button className={filter === 'all' ? 'is-active' : ''} onClick={() => { setFilter('all'); setVisibleCount(50); }}>全部 {inboxItems.length}</button><button className={filter === 'queued' ? 'is-active' : ''} onClick={() => { setFilter('queued'); setVisibleCount(50); }}>待处理 {inboxItems.filter((item) => item.status === 'queued').length}</button><button className={filter === 'needs_review' ? 'is-active' : ''} onClick={() => { setFilter('needs_review'); setVisibleCount(50); }}>处理说明 {inboxItems.filter((item) => item.status === 'needs_review').length}</button></div><label className="compact-select">成员<select aria-label="按成员筛选" value={personFilter} onChange={(event) => { setPersonFilter(event.target.value); setVisibleCount(50); }}><option value="all">全部成员</option><option value="unassigned">待归属</option>{snapshot.persons.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}</select></label></div>{selected.length > 0 && <div className="bulk-actions" role="group" aria-label="批量处理选中资料"><strong>已选 {selected.length} 份</strong><label>归属为<select aria-label="批量归属成员" value={assignPersonId} onChange={(event) => setAssignPersonId(event.target.value)}>{snapshot.persons.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}</select></label><button className="secondary-button" disabled={bulkBusy || assignableIds.length === 0 || !assignPersonId} onClick={() => void runBulk(() => onAssign(assignableIds, assignPersonId))}>分配待归属项{assignableIds.length ? ` (${assignableIds.length})` : ''}</button><button className="secondary-button" disabled={bulkBusy || ignorableIds.length === 0} onClick={() => void runBulk(() => onIgnore(ignorableIds))}>移出分析{ignorableIds.length ? ` (${ignorableIds.length})` : ''}</button></div>}<div className="inbox-table"><div className="inbox-table__head inbox-table__head--selectable"><label className="select-cell"><input aria-label="选中当前筛选结果" type="checkbox" checked={allVisibleSelected} onChange={() => setSelectedIds((current) => allVisibleSelected ? current.filter((id) => !items.some((item) => item.id === id)) : [...new Set([...current, ...items.map((item) => item.id)])])} /></label><span>资料</span><span>成员</span><span>发现时间</span><span>状态</span><span /></div>{visibleItems.map((item) => <InboxRow key={item.id} item={item} reviews={snapshot.reviews} selected={selectedIds.includes(item.id)} onToggle={() => toggleSelection(item.id)} onOpen={() => onOpenEvidence({ title: item.displayName, label: item.sourceLabel, quote: '正在打开原始资料…', meta: '原始资料保存在本机。', documentId: item.id })} />)}</div>{items.length > visibleCount && <div className="dialog-actions"><button className="secondary-button" onClick={() => setVisibleCount((count) => count + 50)}>再显示 {Math.min(50, items.length - visibleCount)} 份资料</button></div>}{items.length === 0 && <div className="table-empty"><Inbox size={24} /><strong>{inboxItems.length === 0 ? '暂无待处理的新资料' : '没有符合条件的资料'}</strong><span>{inboxItems.length === 0 ? '已有报告可在成员档案中查看，处理进度可前往处理中心。' : '可以更换状态或成员筛选。'}</span>{inboxItems.length === 0 && <button className="secondary-button" onClick={onProcessingCenter}>前往处理中心</button>}</div>}</section><div className="info-callout"><ShieldCheck size={20} /><div><strong>自动整理</strong><p>上传时选择成员，之后会自动完成读取与健康解读。无法可靠采用的内容会在结果中说明。</p></div><button className="text-button" onClick={onDirectories}>查看授权范围</button></div></div>;
}

function InboxRow({ item, reviews, selected, onToggle, onOpen }: { item: InboxItem; reviews: ReviewIssue[]; selected: boolean; onToggle(): void; onOpen(): void }) {
  const status = reportProcessingPresentation(item, reviews);
  return <div className="inbox-table__row inbox-table__row--selectable"><label className="select-cell"><input aria-label={`选中 ${item.displayName}`} type="checkbox" checked={selected} onChange={onToggle} /></label><span className="file-cell"><span className="file-icon"><FileText size={19} /></span><span><strong>{item.displayName}</strong><small>{item.format} · {item.sourceLabel}</small></span></span><span>{item.personLabel ?? <span className="attention-text">待归属</span>}</span><span>{formatDateTime(item.discoveredAt)}</span><span><StatusBadge tone={status.tone}>{status.label}</StatusBadge>{status.issue && <small className="row-note" style={item.status === 'needs_review' ? { fontSize: 16, color: 'var(--warm-600)' } : undefined}>{status.issue}</small>}</span><button className="icon-button" aria-label={`查看 ${item.displayName} 的来源`} onClick={onOpen}><FileText size={18} /></button></div>;
}

function JobAssessmentOutcome({ job }: { job: JobSummary }) {
  // 旧任务没有独立回执时保持未知，不能从阶段名称或已读份数猜测发布成功。
  const outcome = job.assessmentOutcome;
  if (!outcome || ['queued', 'running', 'retry_wait', 'waiting_auth', 'waiting_quota', 'waiting_user'].includes(job.status)) return null;
  const statusLabels: Record<NonNullable<JobSummary['assessmentOutcome']>['status'], string> = {
    published: '本任务已发布综合解读', rejected: '综合解读未更新',
    skipped_no_data: '尚无可用于综合解读的资料', reused_current: '本任务已复用匹配的综合解读'
  };
  const reasonLabels: Record<NonNullable<NonNullable<JobSummary['assessmentOutcome']>['reasonCode']>, string> = {
    no_accepted_facts: '尚无已接纳的报告结果或个人补充信息，本次没有生成综合解读。',
    validation_failed: '部分解读内容未通过依据校验，未发布新的综合解读；已保存的报告结果不受影响。',
    schema_invalid: '本次解读的返回格式未通过检查，未发布新的综合解读；已保存的报告结果不受影响。',
    scope_mismatch: '本次解读与授权的资料范围不一致，未发布新的综合解读；已保存的报告结果不受影响。',
    coverage_incomplete: '本次解读未完整覆盖要求核实的内容，未发布新的综合解读；已保存的报告结果不受影响。',
    focused_review_failed: '本次解读未通过重点复核，未发布新的综合解读；已保存的报告结果不受影响。',
    publication_failed: '本次解读未能完成保存，已保存的报告结果不受影响。',
    unknown: '本次没有发布新的综合解读，具体原因尚未明确；已保存的报告结果不受影响。'
  };
  const description = outcome.status === 'published' || outcome.status === 'reused_current'
    ? '对应本任务处理时的资料范围；后续新增或修正资料后，健康解读可能需要再次更新。'
    : reasonLabels[outcome.reasonCode ?? 'unknown'];
  return <section className="info-callout compact" aria-label="本次成员综合结果">{outcome.status === 'published' || outcome.status === 'reused_current' ? <ShieldCheck size={18} /> : <Clock3 size={18} />}<div><strong style={{ fontSize: 16 }}>{statusLabels[outcome.status]}</strong><p style={{ fontSize: 16 }}>{description}</p></div></section>;
}

function ProcessingPage({ snapshot, resultLimitations, onOpenLimitationEvidence, onRepairReports, onCancel, onRetry, onTogglePause, onDetails }: { snapshot: DashboardSnapshot; resultLimitations: ReviewIssue[]; onOpenLimitationEvidence(review: ReviewIssue): void; onRepairReports(documentIds: string[]): void; onCancel(job: JobSummary): void; onRetry(job: JobSummary): void; onTogglePause(): void; onDetails(job: JobSummary): void }) {
  const isCurrentJob = (job: JobSummary) => job.status !== 'succeeded'
    && job.status !== 'cancelled'
    && job.status !== 'completed_with_issues'
    && (job.status !== 'failed' || job.canRetry);
  const currentJobs = snapshot.jobs.filter(isCurrentJob);
  const processingNotes = snapshot.reviews.filter((review) => review.resolutionStatus === 'open'
    && !isReadOnlyResultLimitation(review, snapshot.inbox.find((item) => item.id === review.documentId), snapshot.reviews));
  const historyJobs = snapshot.jobs.filter((job) => !isCurrentJob(job));
  const renderJob = (job: JobSummary, compact = false) => {
    const presentation = jobProcessingPresentation(job);
    return <article className={`panel job-card${compact ? ' job-card--history' : ''}`} key={job.id}>
    <div className="job-card__top"><span className={`job-icon job-icon--${job.status}`}>{job.status === 'running' ? <LoaderCircle className="spin" size={21} /> : presentation.tone === 'success' ? <Check size={21} /> : <Clock3 size={21} />}</span><div><strong>{job.batchLabel}</strong><small>{job.personLabel ?? '待归属资料'} · {job.statusText}</small></div><StatusBadge tone={presentation.tone}>{presentation.label}</StatusBadge></div>
    {!compact && <div className="progress-row"><div><i style={{ width: `${Math.round(job.completedUnits / job.totalUnits * 100)}%` }} /></div><span>{job.completedUnits}/{job.totalUnits}</span></div>}
    <JobAssessmentOutcome job={job} />
    <div className="job-card__footer"><span>最近更新：{formatDateTime(job.updatedAt)}</span><div>{job.canCancel && <button className="text-button" onClick={() => onCancel(job)}>停止</button>}{job.canRetry && job.status !== 'completed_with_issues' && <button className="text-button" onClick={() => onRetry(job)}><RefreshCw size={15} /> 重试</button>}<button className="text-button" onClick={() => onDetails(job)}>查看详情 <ChevronRight size={15} /></button></div></div>
  </article>;
  };
  return <div className="page-stack">
    <section className="page-title-row"><div><span className="eyebrow">处理中心</span><h1>资料处理进度</h1><p>上传后会自动完成整理与健康解读；部分内容无法采用时会在这里说明。</p></div><button className="secondary-button" onClick={onTogglePause}>{snapshot.queuePaused ? <Play size={17} /> : <Pause size={17} />}{snapshot.queuePaused ? '继续队列' : '暂停队列'}</button></section>
    {snapshot.queuePaused && <div className="info-callout"><Pause size={20} /><div><strong>队列已暂停</strong><p>暂停后不再开始新任务；正在保存的结果和已有资料会保留。</p></div></div>}

    {currentJobs.length > 0 && <section className="section-block"><div className="section-heading"><div><h2>正在处理与需要关注</h2><p>系统自动整理资料并更新看板；登录或发送范围不可用时，会说明暂停原因。</p></div><StatusBadge tone="neutral">{currentJobs.length} 项</StatusBadge></div><div className="job-grid">{currentJobs.map((job) => renderJob(job))}</div></section>}
    {(resultLimitations.length > 0 || snapshot.inbox.some(item => (item.dateBindingReviewCount ?? 0) > 0)) && <ResultLimitationsPanel snapshot={snapshot} reviews={resultLimitations} onEvidence={onOpenLimitationEvidence} onRepairReports={onRepairReports} />}
    {processingNotes.length > 0 && <ProcessingNotesPanel snapshot={snapshot} reviews={processingNotes} onEvidence={onOpenLimitationEvidence} />}
    {historyJobs.length > 0 && <section className="section-block"><div className="section-heading"><div><h2>最近记录</h2><p>查看之前的处理结果。</p></div><StatusBadge tone="neutral">{historyJobs.length} 项</StatusBadge></div><div className="job-history-list">{historyJobs.map((job) => renderJob(job, true))}</div></section>}
    {snapshot.jobs.length === 0 && <section className="panel table-empty"><Clock3 size={24} /><strong>还没有处理任务</strong><span>上传资料后会自动整理，完成后可查看健康看板。</span></section>}

  </div>;
}

const jobStageLabel: Record<JobSummary['stage'], string> = {
  normalize: '准备报告',
  identify: '确认资料归属',
  extract: '读取报告结果',
  review_facts: '核对报告结果',
  accept_facts: '保存报告结果',
  analyze: '健康解读',
  guidance: '生活指南',
  review_derived: '检查解读内容',
  system_analysis: '整理各身体系统情况',
  system_review: '检查各系统解读',
  publish: '更新健康解读'
};

function JobDetailDialog({ job, onClose }: { job: JobSummary; onClose(): void }) {
  const systemNames: Record<string, string> = {
    cardiovascular: '心血管', endocrine_metabolic: '内分泌 / 代谢', hepatobiliary: '肝胆',
    renal_urinary: '肾脏 / 泌尿', digestive: '消化', respiratory: '肺 / 呼吸',
    hematology_immune: '血液 / 免疫', musculoskeletal: '肌肉 / 骨骼', neurological: '神经',
    sensory_oral: '眼耳鼻喉 / 口腔', reproductive: '生殖', dermatological: '皮肤'
  };
  const outcomeLabels: Record<JobSummary['systemOutcomes'][number]['status'], string> = {
    published: '解读已更新', rejected: '解读暂未完成', skipped_no_data: '暂无直接资料',
    skipped_cache: '已使用最新结果', out_of_scope: '本轮未处理'
  };
  const visibleOutcomes = job.systemOutcomes.filter((outcome) => outcome.status !== 'out_of_scope');
  const outOfScopeCount = job.systemOutcomes.length - visibleOutcomes.length;
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="member-dialog job-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="job-detail-title">
      <header><div><span className="eyebrow">处理任务</span><h2 id="job-detail-title">{job.batchLabel}</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭任务详情"><X size={19} /></button></header>
      <p>{job.personLabel ?? '这批资料尚未完成成员归属'}。可在这里查看进度；完成后到成员档案查看健康解读。</p>
      <JobAssessmentOutcome job={job} />
      <dl className="detail-list"><div><dt>当前阶段</dt><dd>{jobStageLabel[job.stage]}</dd></div><div><dt>当前状态</dt><dd>{job.statusText}</dd></div><div><dt>已处理资料</dt><dd>{job.completedUnits}/{job.totalUnits} 份</dd></div><div><dt>最近更新</dt><dd>{formatDateTime(job.updatedAt)}</dd></div></dl>
      {job.systemOutcomes.length > 0 && <section className="job-system-outcomes" aria-label="按身体系统处理结果"><h3>各身体系统结果</h3>{visibleOutcomes.map((outcome) => <div key={outcome.systemId}><strong>{systemNames[outcome.systemId] ?? outcome.systemId}</strong><span>{outcomeLabels[outcome.status]}</span>{outcome.reason && outcome.status === 'rejected' && <small>报告结果仍可查看，这部分解读暂未发布。</small>}</div>)}{outOfScopeCount > 0 && <div><strong>其他 {outOfScopeCount} 个系统</strong><span>报告结果已保存，健康解读待更新</span></div>}</section>}
      <div className="info-callout compact"><ShieldCheck size={18} /><div><strong>已有报告结果会保留</strong><p>健康解读尚未完成时，仍可查看已经保存的报告结果。</p></div></div>
      <div className="dialog-actions"><button className="primary-button" onClick={onClose}>知道了</button></div>
    </section>
  </div>;
}

function CancelJobDialog({ job, onClose, onConfirm }: { job: JobSummary; onClose(): void; onConfirm(): Promise<boolean> }) {
  const [busy, setBusy] = useState(false);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="member-dialog" role="dialog" aria-modal="true" aria-labelledby="cancel-job-title"><header><div><span className="eyebrow">停止任务</span><h2 id="cancel-job-title">停止这项处理？</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭停止任务确认"><X size={19} /></button></header><p>将停止本应用当前的处理。已保存的报告结果会保留，未完成的健康解读不会发布。</p><div className="info-callout compact"><ShieldCheck size={18} /><div><strong>{job.personLabel ?? '当前资料'} · 已完成 {job.completedUnits}/{job.totalUnits}</strong><p>只停止这项资料处理，你仍可查看已有健康档案。</p></div></div><div className="dialog-actions"><button className="secondary-button" onClick={onClose}>继续处理</button><button className="primary-button" disabled={busy} onClick={async () => { setBusy(true); try { if (await onConfirm()) onClose(); } finally { setBusy(false); } }}>{busy ? <LoaderCircle size={18} className="spin" /> : <Pause size={18} />} 确认停止</button></div></section></div>;
}

const actionStatusOptions: Array<{ value: ActionItem['status']; label: string }> = [
  { value: 'proposed', label: '待讨论' },
  { value: 'discussed', label: '已讨论' },
  { value: 'planned', label: '已安排' },
  { value: 'in_progress', label: '进行中' },
  { value: 'paused', label: '已暂停' },
  { value: 'completed', label: '已完成' },
  { value: 'dismissed', label: '不再处理' }
];

function ActionsPage({ snapshot, onCreate, onUpdate, onSchedule, onOpenEvidence }: {
  snapshot: DashboardSnapshot;
  onCreate(): void;
  onUpdate(item: ActionItem, status: ActionItem['status']): void;
  onSchedule(item: ActionItem): void;
  onOpenEvidence(evidence: Evidence): void;
}) {
  const open = snapshot.actions.filter((item) => !['completed', 'dismissed'].includes(item.status));
  const done = snapshot.actions.filter((item) => item.status === 'completed')
    .map((item) => ({ ...item, title: savedActionTitle(item.title, item.origin) }))
    .sort((left, right) => (right.completedAt ?? '').localeCompare(left.completedAt ?? ''));
  return <div className="page-stack"><section className="page-title-row"><div><span className="eyebrow">后续事项</span><h1>记下复查和日常安排</h1><p>记录复查、就诊时要问的问题和日常安排，完成后勾选即可。</p></div><button className="primary-button" onClick={onCreate}><Plus size={17} /> 新建事项</button></section><div className="action-layout"><section className="panel"><div className="panel__heading"><h2>待处理</h2><StatusBadge tone="warning">{open.length} 项</StatusBadge></div>{open.length > 0 ? <div className="action-list">{open.map((item) => <ActionRow key={item.id} item={item} snapshot={snapshot} onUpdate={onUpdate} onSchedule={onSchedule} onOpenEvidence={onOpenEvidence} />)}</div> : <div className="table-empty action-empty"><Check size={24} /><strong>目前没有待处理事项</strong><span>可以把下次复查、就诊时要问的问题或自己的安排记在这里。</span></div>}</section><aside className="panel completed-panel"><div className="panel__heading"><h3>最近完成</h3><Archive size={18} /></div>{done.length > 0 ? done.map((item) => <div className="completed-item" key={item.id}><Check size={16} /><div><strong>{item.title}</strong><small>{snapshot.persons.find((person) => person.id === item.personId)?.displayName ?? '成员已不可见'}{item.completedAt ? ` · 完成于 ${formatDateTime(item.completedAt)}` : ''}</small><small>{item.evidenceLabel ?? '本人事项'}</small></div></div>) : <p className="muted-copy">还没有已完成事项。</p>}</aside></div></div>;
}

function ActionRow({ item: originalItem, snapshot, onUpdate, onSchedule, onOpenEvidence }: { item: ActionItem; snapshot: DashboardSnapshot; onUpdate(item: ActionItem, status: ActionItem['status']): void; onSchedule(item: ActionItem): void; onOpenEvidence(evidence: Evidence): void }) {
  // 正文在服务读取时按真实来源整理；其中本人填写的内容不能再次统一清理。
  const item = { ...originalItem, title: savedActionTitle(originalItem.title, originalItem.origin) };
  const person = snapshot.persons.find((person) => person.id === item.personId);
  const origin = item.origin === 'clinician_document' ? ['报告中的医生意见', 'success'] : item.origin === 'ai_proposed' ? ['健康解读中的建议', 'info'] : ['本人安排', 'neutral'];
  return <div className="action-row"><button className="check-ring" aria-label={`完成 ${item.title}`} onClick={() => onUpdate(item, 'completed')} /><div className="action-row__body"><div><StatusBadge tone={origin[1] as Tone}>{origin[0]}</StatusBadge><span>{person?.displayName}</span></div><strong>{item.title}</strong>{item.detail && <p>{item.detail}</p>}
    <div className="action-row__planning">
      <p>我的安排：{[item.dueDate, item.userScheduleText].filter(Boolean).join(' · ') || '尚未设置时间'}</p>
      {item.dueText && <p>{item.origin === 'user_created' ? '原先记录' : '原建议时间'}：{item.dueText}</p>}
      <p>{item.evidenceLabel ?? '本人事项'}</p>
    </div>
    <div className="action-row__controls"><button className="text-button" aria-label={`安排时间：${item.title}`} onClick={() => onSchedule(originalItem)}><CalendarClock size={16} /> 安排时间</button></div>
    {(item.evidenceRefs ?? []).filter((source) => source.documentId || source.sourceSpanId).length > 0 && <details className="evidence-disclosure"><summary>查看建议依据</summary>{item.evidenceRefs!.filter((source) => source.documentId || source.sourceSpanId).map((source) => <button key={source.id} className="evidence-link" onClick={() => onOpenEvidence({ title: `${item.title}的依据`, label: source.label, quote: source.quote ?? '', meta: source.locator ?? '原始资料', sourceSpanId: source.sourceSpanId, documentId: source.documentId })}>{source.label}{source.locator ? ` · ${source.locator}` : ''}</button>)}</details>}
    </div><label className="action-status"><span className="sr-only">更改 {item.title} 的状态</span><select aria-label={`更改 ${item.title} 的状态`} value={item.status} onChange={(event) => onUpdate(item, event.target.value as ActionItem['status'])}>{actionStatusOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label></div>;
}

function ActionScheduleDialog({ item, personName, onClose, onSave }: { item: ActionItem; personName: string; onClose(): void; onSave(input: UpdateActionScheduleInput): Promise<boolean> }) {
  const [dueDate, setDueDate] = useState(item.dueDate ?? '');
  const [userScheduleText, setUserScheduleText] = useState(item.userScheduleText ?? '');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const input = { personId: item.personId, actionId: item.id, dueDate: dueDate || null, userScheduleText: userScheduleText.trim() || null, expectedRevision: item.userRevision };
  const valid = updateActionScheduleInputSchema.safeParse(input).success;
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }}><section className="member-dialog action-dialog" role="dialog" aria-modal="true" aria-labelledby="action-schedule-title"><header><div><span className="eyebrow">{personName} · 我的安排</span><h2 id="action-schedule-title">安排时间</h2></div><button className="icon-button" disabled={busy} onClick={onClose} aria-label="关闭时间安排"><X size={19} /></button></header><strong>{savedActionTitle(item.title, item.origin)}</strong><p>按自己的实际情况安排。这里只保存你的计划，不改原报告或建议中的时间要求。</p>{item.dueText && <div className="info-callout compact"><CalendarClock size={18} /><div><strong>{item.origin === 'user_created' ? '原先记录' : '原建议时间'}</strong><p>{item.dueText}</p></div></div>}<label>我设定的日期（可选）<input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></label><label>我的时间说明（可选）<input value={userScheduleText} maxLength={200} onChange={(event) => setUserScheduleText(event.target.value)} placeholder="例如：周一上午预约后再确认" /></label><p className="muted-copy">可以填写行动日或回顾日，并在说明中注明用途。两项都留空，可以清除自己的时间安排；原建议仍保留。</p>{!valid && <p role="alert">请填写有效日期，时间说明不要超过 200 字。</p>}{failed && <p role="alert">这次安排没有保存。事项可能已更新，请关闭后重新打开再试。</p>}<div className="dialog-actions"><button className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" disabled={!valid || busy} onClick={async () => { setBusy(true); setFailed(false); try { if (await onSave(input)) onClose(); else setFailed(true); } catch { setFailed(true); } finally { setBusy(false); } }}>{busy ? '正在保存' : '保存我的安排'}</button></div></section></div>;
}

function ActionDialog({ snapshot, selectedPersonId, onClose, onCreate }: {
  snapshot: DashboardSnapshot;
  selectedPersonId: string;
  onClose(): void;
  onCreate(input: CreateActionItemInput): Promise<boolean>;
}) {
  const [personId, setPersonId] = useState(selectedPersonId || snapshot.persons[0]?.id || '');
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [dueText, setDueText] = useState('');
  const [busy, setBusy] = useState(false);
  const canSave = Boolean(personId && title.trim());
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="member-dialog action-dialog" role="dialog" aria-modal="true" aria-labelledby="action-dialog-title"><header><div><span className="eyebrow">本人安排</span><h2 id="action-dialog-title">新建后续事项</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭新建事项"><X size={19} /></button></header><p>写下要做的事，可以补充日期、要带的资料或想问医生的问题。</p><label>家庭成员<select value={personId} onChange={(event) => setPersonId(event.target.value)}>{snapshot.persons.map((person) => <option key={person.id} value={person.id}>{person.displayName} · {person.relation}</option>)}</select></label><label>事项名称<input value={title} maxLength={160} autoComplete="off" placeholder="例如：下次就诊时询问血脂变化" onChange={(event) => setTitle(event.target.value)} /></label><label>补充说明（可选）<textarea value={detail} maxLength={1200} rows={3} placeholder="写下要带的资料或想确认的问题" onChange={(event) => setDetail(event.target.value)} /></label><div className="action-due-grid"><label>具体日期（可选）<input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></label><label>或者写时间说明<input value={dueText} maxLength={160} placeholder="例如：下次复诊时" onChange={(event) => setDueText(event.target.value)} /></label></div><div className="dialog-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!canSave || busy} onClick={async () => { setBusy(true); try { if (await onCreate({ personId, title: title.trim(), detail: detail.trim(), dueDate: dueDate || null, dueText: dueText.trim() || null })) onClose(); } finally { setBusy(false); } }}>{busy ? <LoaderCircle size={18} className="spin" /> : <Check size={18} />} 保存事项</button></div></section></div>;
}

function ManualNoteDialog({ snapshot, selectedPersonId, question, onClose, onCreate }: {
  snapshot: DashboardSnapshot;
  selectedPersonId: string;
  question: MemberQuestionPrompt | null;
  onClose(): void;
  onCreate(input: CreateManualNoteInput): Promise<boolean>;
}) {
  const [personId, setPersonId] = useState(selectedPersonId || snapshot.persons[0]?.id || '');
  const [kind, setKind] = useState<CreateManualNoteInput['kind']>(question ? 'free_text' : 'history');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [text, setText] = useState('');
  const [measurementName, setMeasurementName] = useState('');
  const [measurementValue, setMeasurementValue] = useState('');
  const [measurementUnit, setMeasurementUnit] = useState('');
  const [busy, setBusy] = useState(false);
  const person = snapshot.persons.find((item) => item.id === personId);
  const isMeasurement = kind === 'self_measurement';
  const questionPrefix = question ? `补充问题：${question.question}\n本人回答：` : '';
  const answerMaxLength = Math.max(0, 4000 - questionPrefix.length);
  const canSave = Boolean(person && (isMeasurement ? measurementName.trim() && measurementValue.trim()
    : text.trim() && questionPrefix.length + text.trim().length <= 4000));
  const save = async () => {
    if (!person) return false;
    const structuredFields: Record<string, string> = isMeasurement ? {
      measurementName: measurementName.trim(),
      value: measurementValue.trim(),
      unit: measurementUnit.trim()
    } : question ? { questionId: question.questionId, assessmentSnapshotId: question.snapshotId } : {};
    const immutableText = isMeasurement
      ? `${measurementName.trim()}：${measurementValue.trim()}${measurementUnit.trim() ? ` ${measurementUnit.trim()}` : ''}${text.trim() ? `；${text.trim()}` : ''}`
      : `${questionPrefix}${text.trim()}`;
    return onCreate({ personId, kind, immutableText, effectiveDate: effectiveDate || null, structuredFields, expectedContextRevision: person.clinicalContextRevision });
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="member-dialog manual-note-dialog" role="dialog" aria-modal="true" aria-labelledby="manual-note-title"><header><div><span className="eyebrow">本人补充</span><h2 id="manual-note-title">手动补充健康信息</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭手动补充健康信息"><X size={19} /></button></header><p>补充症状、用药、自测结果或生活习惯，帮助理解报告。填写的内容会保存在本机，并标注为本人自述。</p>{question && <div className="info-callout compact"><CircleHelp size={18} /><div><strong>补充这项信息</strong><p>{question.question}</p></div></div>}<div className="action-due-grid"><label>家庭成员<select disabled={Boolean(question)} value={personId} onChange={(event) => setPersonId(event.target.value)}>{snapshot.persons.map((item) => <option key={item.id} value={item.id}>{item.displayName} · {item.relation}</option>)}</select></label><label>资料类型<select disabled={Boolean(question)} value={kind} onChange={(event) => setKind(event.target.value as CreateManualNoteInput['kind'])}><option value="history">既往情况</option><option value="allergy">过敏记录</option><option value="medication">用药记录</option><option value="self_measurement">本人自测</option><option value="goal">生活目标</option><option value="constraint">身体或时间限制</option><option value="free_text">补充说明</option></select></label></div><label>发生或测量日期（可选）<input type="date" value={effectiveDate} onChange={(event) => setEffectiveDate(event.target.value)} /></label>{isMeasurement ? <><div className="measurement-grid"><label>自测项目<input value={measurementName} maxLength={80} placeholder="例如：晨起血压" onChange={(event) => setMeasurementName(event.target.value)} /></label><label>结果<input value={measurementValue} maxLength={120} placeholder="例如：128/82" onChange={(event) => setMeasurementValue(event.target.value)} /></label><label>单位（可选）<input value={measurementUnit} maxLength={40} placeholder="例如：mmHg" onChange={(event) => setMeasurementUnit(event.target.value)} /></label></div><label>补充说明（可选）<textarea value={text} maxLength={4000} rows={3} placeholder="例如：在家静坐 5 分钟后测量" onChange={(event) => setText(event.target.value)} /></label></> : <label>{question ? '你的回答' : '你要记录的原文'}<textarea value={text} maxLength={answerMaxLength} rows={5} placeholder={question ? '请填写你的实际情况；不确定的地方可以直接说明' : kind === 'medication' ? '例如：目前在使用……，名称和剂量以药盒或医生记录为准' : kind === 'allergy' ? '例如：本人记得对……出现过……，是否为过敏尚待医生确认' : kind === 'goal' ? '例如：希望先把每周能做到的日常活动稳定下来' : kind === 'constraint' ? '例如：膝盖不适，暂时不适合跑跳；工作日只有晚饭后有空' : '请按自己的原话填写'} onChange={(event) => setText(event.target.value)} /></label>}<div className="info-callout compact"><ShieldCheck size={18} /><div><strong>会标注为本人自述</strong><p>自测结果会与医院检查分开显示。生活目标和身体限制会帮助调整建议；保存后可更新健康解读，让它结合这些新情况。</p></div></div><div className="dialog-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!canSave || busy} onClick={async () => { setBusy(true); try { if (await save()) onClose(); } finally { setBusy(false); } }}>{busy ? <LoaderCircle size={18} className="spin" /> : <Check size={18} />} 保存到本机</button></div></section></div>;
}

function ExportSummaryDialog({ snapshot, selectedPersonId, onClose, onExport }: {
  snapshot: DashboardSnapshot;
  selectedPersonId: string;
  onClose(): void;
  onExport(input: ExportMemberSummaryInput): Promise<boolean>;
}) {
  const [personId, setPersonId] = useState(selectedPersonId || snapshot.persons[0]?.id || '');
  const [format, setFormat] = useState<ExportMemberSummaryInput['format']>('pdf');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const datesValid = !dateFrom || !dateTo || dateFrom <= dateTo;
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="member-dialog export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-summary-title"><header><div><span className="eyebrow">本机资料摘要</span><h2 id="export-summary-title">导出成员摘要</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭导出摘要"><X size={19} /></button></header><p>导出已保存的检查结果、健康解读和安排，便于自己保存或就诊时携带。</p><div className="action-due-grid"><label>家庭成员<select value={personId} onChange={(event) => setPersonId(event.target.value)}>{snapshot.persons.map((person) => <option key={person.id} value={person.id}>{person.displayName} · {person.relation}</option>)}</select></label><label>导出格式<select value={format} onChange={(event) => setFormat(event.target.value as ExportMemberSummaryInput['format'])}><option value="pdf">PDF（适合打印）</option><option value="html">HTML（可用浏览器打开）</option><option value="json">JSON（结构化数据）</option></select></label></div><div className="action-due-grid"><label>开始日期（可选）<input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /></label><label>结束日期（可选）<input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></label></div>{!datesValid && <span className="field-error">结束日期不能早于开始日期。</span>}<div className="consent-facts"><span><FileCheck2 size={17} /> 包含所选成员的报告指标、本人补充、事项和已发布生活指南</span><span><ShieldCheck size={17} /> 默认不附原始报告，不包含其他家庭成员</span><span><Archive size={17} /> 文件只保存到你选择的本机位置，不会上传或代发</span></div><label className="check-label"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> 我已了解导出文件含个人健康信息，需要自行妥善保管</label><div className="dialog-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!personId || !confirmed || !datesValid || busy} onClick={async () => { setBusy(true); try { if (await onExport({ personId, format, dateFrom: dateFrom || null, dateTo: dateTo || null, confirmedPrivacyNotice: true })) onClose(); } finally { setBusy(false); } }}>{busy ? <LoaderCircle size={18} className="spin" /> : <FileCheck2 size={18} />} 选择保存位置</button></div></section></div>;
}

function SettingsPage({ snapshot, desktopBehavior, displayPreferences, aiPreferences, recoveryStatus, onAccount, onAi, onDirectories, onSchedule, onBackup, onDesktop, onDisplay, onPrivacy, onAbout }: { snapshot: DashboardSnapshot; desktopBehavior: DesktopBehavior; displayPreferences: DisplayPreferences; aiPreferences: AiPreferences; recoveryStatus: RecoveryStatus; onAccount(): void; onAi(): void; onDirectories(): void; onSchedule(): void; onBackup(): void; onDesktop(): void; onDisplay(): void; onPrivacy(): void; onAbout(): void }) {
  const accountText = snapshot.account.status === 'connected'
    ? `已连接${snapshot.account.displayLabel ? ` · ${snapshot.account.displayLabel}` : ''}`
    : snapshot.account.status === 'connecting' ? '请在官方浏览器页面完成登录'
      : snapshot.account.displayLabel ?? '尚未连接 Codex';
  const accountAction = snapshot.account.status === 'connected' ? '刷新状态' : snapshot.account.status === 'connecting' ? '等待完成' : '连接账户';
  const settings = [
    { icon: Sparkles, title: '账户与 AI', text: accountText, action: accountAction },
    { icon: Activity, title: '分析报告模型', text: `${modelPreferenceLabel(aiPreferences)} · 新分析生效`, action: '更改' },
    { icon: FolderHeart, title: '报告收件箱', text: snapshot.workspaceMode === 'personal' ? '只监控你明确授权的本机目录' : '个人工作区建立后可指定目录', action: '管理目录' },
    { icon: CalendarClock, title: '自动处理', text: snapshot.scheduleEnabled ? `每天 ${snapshot.scheduleLocalTime}（${snapshot.scheduleTimeZone}）· 下次 ${formatDateTime(snapshot.nextScheduledRun)}` : '尚未启用；不会自动发送资料', action: '调整时间' },
    { icon: Bell, title: '桌面行为', text: `${desktopBehavior.stayInTray === null ? '关闭窗口时询问是否驻留' : desktopBehavior.stayInTray ? '关闭后驻留后台' : '关闭窗口即退出'} · 处理通知：${desktopBehavior.notificationsEnabled ? '开启' : '关闭'}`, action: '更改' },
    { icon: Settings, title: '显示', text: `${displayPreferences.fontScale === 'large' ? '大字号' : '标准字号'} · ${displayPreferences.reduceMotion ? '减少动画' : '标准动画'} · ${displayPreferences.dateStyle === 'numeric' ? '数字日期' : '中文日期'}`, action: '更改' },
    { icon: ShieldCheck, title: '数据与隐私', text: '资料保存在本机，不上传给应用开发者', action: '查看详情' },
    { icon: Archive, title: '备份与恢复', text: recoveryStatus.pointCount > 0 ? `${recoveryStatus.pointCount} 个本机恢复点 · ${formatBytes(recoveryStatus.totalBytes)} · 最近 ${formatDateTime(recoveryStatus.latestAt)}` : '尚无自动备份；保存首份健康资料前会自动创建', action: '创建加密备份' },
    { icon: CircleHelp, title: '关于与诊断', text: '版本、运行时、依赖许可与已知限制', action: '查看' }
  ];
  return <div className="page-stack"><section className="page-title-row"><div><span className="eyebrow">设置</span><h1>应用与隐私设置</h1><p>退出 Codex 不会删除健康档案；更换账户或扩大目录范围需要重新确认。</p></div></section><section className="panel settings-list">{settings.map(({ icon: Icon, title, text, action }) => <button key={title} onClick={title === '账户与 AI' ? onAccount : title === '分析报告模型' ? onAi : title === '报告收件箱' ? onDirectories : title === '自动处理' ? onSchedule : title === '桌面行为' ? onDesktop : title === '显示' ? onDisplay : title === '数据与隐私' ? onPrivacy : title === '备份与恢复' ? onBackup : onAbout}><span className="settings-icon"><Icon size={20} /></span><span><strong>{title}</strong><small>{text}</small></span><span className="settings-action">{action}<ChevronRight size={16} /></span></button>)}</section><section className="panel boundary-card"><div><ShieldCheck size={24} /><span><h3>资料与健康解读</h3><p>资料保存在这台电脑。授权 AI 整理时，必要内容会通过你的 Codex 账户发送给 OpenAI；健康解读不能代替医生面诊。</p></span></div><button className="secondary-button" onClick={onPrivacy}>查看数据处理说明</button></section></div>;
}

function AiPreferencesDialog({ preferences, onClose, onSave }: { preferences: AiPreferences; onClose(): void; onSave(input: AiPreferences): Promise<boolean> }) {
  const [models, setModels] = useState<AiModelOption[]>([]);
  const [modelId, setModelId] = useState(preferences.modelId);
  const [reasoningEffort, setReasoningEffort] = useState<AiReasoningEffort>(preferences.reasoningEffort);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void window.healthDesktop?.getAiSettings().then((result) => {
      if (!active) return;
      if (!result.ok || result.data.models.length === 0) {
        setLoadFailed(true);
        return;
      }
      setModels(result.data.models);
      setModelId(result.data.preferences.modelId);
      setReasoningEffort(result.data.preferences.reasoningEffort);
    }).catch(() => { if (active) setLoadFailed(true); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  const selectedModel = models.find((model) => model.id === modelId) ?? null;
  const effortDescription = selectedModel?.supportedReasoningEfforts.find((item) => item.reasoningEffort === reasoningEffort)?.description ?? '';
return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="member-dialog" role="dialog" aria-modal="true" aria-labelledby="ai-preferences-title"><header><div><span className="eyebrow">分析报告模型</span><h2 id="ai-preferences-title">模型与推理强度</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭 AI 模型设置"><X size={19} /></button></header>{loading ? <div className="table-empty"><LoaderCircle size={24} className="spin" /><strong>正在读取当前账号可用模型</strong></div> : loadFailed ? <div className="info-callout compact"><CircleHelp size={18} /><div><strong>暂时无法读取模型列表</strong><p>请确认 Codex 已连接后重试。为避免保存无效组合，本次不会更改现有设置。</p></div></div> : <><label>模型<select aria-label="模型" value={modelId} onChange={(event) => { const next = models.find((model) => model.id === event.target.value); if (!next) return; setModelId(next.id); setReasoningEffort(next.defaultReasoningEffort); }}>{models.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}</select></label>{selectedModel?.description && <p>{selectedModel.description}</p>}<label>推理强度<select aria-label="推理强度" value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value as AiReasoningEffort)}>{selectedModel?.supportedReasoningEfforts.map((option) => <option key={option.reasoningEffort} value={option.reasoningEffort}>{reasoningEffortLabels[option.reasoningEffort]}</option>)}</select></label>{effortDescription && <p>{effortDescription}</p>}<div className="info-callout compact"><ShieldCheck size={18} /><div><strong>默认：GPT-6.1-Sol · 中等推理</strong><p>此设置用于之后新生成的健康解读。报告原件固定由 GPT-6.1-Sol / medium 直接阅读，不使用本机 OCR 识别；已有结果不会自动重跑，正在处理的任务保持原设置。</p></div></div></>}<div className="dialog-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={loading || loadFailed || busy || !selectedModel} onClick={async () => { setBusy(true); try { if (await onSave({ modelId, reasoningEffort })) onClose(); } finally { setBusy(false); } }}>{busy ? <LoaderCircle size={18} className="spin" /> : <Check size={18} />} 保存设置</button></div></section></div>;
}

function AccountDialog({ snapshot, onClose, onConnect, onRefresh, onLogout }: {
  snapshot: DashboardSnapshot;
  onClose(): void;
  onConnect(): void;
  onRefresh(): Promise<void>;
  onLogout(): Promise<boolean>;
}) {
  const [confirmedLogout, setConfirmedLogout] = useState(false);
  const [busy, setBusy] = useState(false);
  const connected = snapshot.account.status === 'connected';
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="member-dialog" role="dialog" aria-modal="true" aria-labelledby="account-dialog-title"><header><div><span className="eyebrow">账户与 AI</span><h2 id="account-dialog-title">Codex 连接</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭账户设置"><X size={19} /></button></header><p>{connected ? `当前连接：${snapshot.account.displayLabel ?? 'ChatGPT Codex'}` : snapshot.account.status === 'connecting' ? '正在等待官方浏览器登录完成。' : '连接使用 Codex 管理的官方浏览器登录，不需要复制令牌或配置 API Key。'}</p><dl className="detail-list"><div><dt>连接状态</dt><dd>{connected ? '已连接' : snapshot.account.status === 'connecting' ? '等待登录' : '未连接'}</dd></div><div><dt>额度状态</dt><dd>{snapshot.account.quota.status === 'available' ? '可用' : snapshot.account.quota.status === 'low' ? '余额偏低' : snapshot.account.quota.status === 'exhausted' ? '已耗尽' : '暂时无法查询，请刷新连接状态'}</dd></div></dl>{connected && <><div className="info-callout compact"><ShieldCheck size={18} /><div><strong>退出不删除本机健康档案</strong><p>退出会暂停待发送任务，并撤回现有目录和手动批次的 AI 处理授权。之后即使连接另一个账户，也需要重新确认发送范围。</p></div></div><label className="check-label"><input type="checkbox" checked={confirmedLogout} onChange={(event) => setConfirmedLogout(event.target.checked)} /> 我确认退出 Codex，并暂停现有 AI 处理授权</label></>}<div className="dialog-actions"><button className="secondary-button" onClick={onClose}>关闭</button>{connected ? <><button className="secondary-button" disabled={busy} onClick={async () => { setBusy(true); try { await onRefresh(); } finally { setBusy(false); } }}><RefreshCw size={17} /> 刷新状态</button><button className="primary-button danger-button" disabled={!confirmedLogout || busy} onClick={async () => { setBusy(true); try { if (await onLogout()) onClose(); } finally { setBusy(false); } }}><X size={17} /> 退出 Codex</button></> : <button className="primary-button" disabled={snapshot.account.status === 'connecting'} onClick={onConnect}><Sparkles size={17} /> {snapshot.account.status === 'connecting' ? '等待登录完成' : '使用 ChatGPT 登录'}</button>}</div></section></div>;
}

function PrivacyDialog({ snapshot, onClose, onDirectories, onBackup, onNotice }: { snapshot: DashboardSnapshot; onClose(): void; onDirectories(): void; onBackup(): void; onNotice(message: string): void }) {
  const [cleanupConfirmed, setCleanupConfirmed] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="workspace-dialog privacy-dialog" role="dialog" aria-modal="true" aria-labelledby="privacy-dialog-title"><header><div><span className="eyebrow">数据与隐私</span><h2 id="privacy-dialog-title">哪些留在本机，哪些会发送</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭数据处理说明"><X size={19} /></button></header><div className="privacy-sections"><article><span className="settings-icon"><Archive size={19} /></span><div><strong>本机正式资料</strong><p>原始报告、检查结果、本人补充、备份和导出文件保存在这台电脑。请妥善保护电脑账户和导出文件。</p></div></article><article><span className="settings-icon"><Sparkles size={19} /></span><div><strong>OpenAI / Codex 处理</strong><p>选择成员后上传资料，即启动本次自动整理；上传区域会说明发送给 OpenAI/Codex 的内容。已授权目录按既定范围自动处理，无需逐阶段确认。读取报告时不使用网页搜索；生成健康解读时可能联网查询通用医学资料。</p></div></article><article><span className="settings-icon"><CircleHelp size={19} /></span><div><strong>搜索词的实际边界</strong><p>我们要求模型只搜索不含姓名、完整日期、报告原文、路径或可识别事实组合的通用医学问题。但内置 Web Search 的查询词目前无法由应用在发送前逐条拦截；若模型违反要求，敏感内容可能进入搜索服务。搜索结果不能替代或改写报告事实。</p></div></article><article><span className="settings-icon"><ShieldCheck size={19} /></span><div><strong>资料不会发送给应用开发者</strong><p>本版本没有把健康资料、操作统计或诊断日志上传到开发者服务器。系统通知也不会显示成员名、病名、指标或文件名。</p></div></article><article><span className="settings-icon"><CircleHelp size={19} /></span><div><strong>使用与隐私提醒</strong><p>应用依赖当前操作系统账户保护，没有第二层 App 解锁。AI 整理不等于医生审核，也不会自动预约、发药或代发资料。</p></div></article></div><div className="info-callout compact"><ShieldCheck size={18} /><div><strong>{snapshot.workspaceMode === 'personal' ? '你可以随时撤回目录授权' : '演示空间不包含真实健康资料'}</strong><p>{snapshot.workspaceMode === 'personal' ? '停用目录会停止监控，并撤回该目录后续的自动 AI 处理授权；已保存的本机档案不会因此删除。' : '建立个人工作区后，上传区域会说明发送范围；选择文件或拖入资料会启动自动整理。'}</p></div></div><div className="retention-box"><div><strong>清理到期临时资料</strong><p>清理超过 7 天的临时预览，以及超过 30 天且没有待核对事项的已结束处理记录。用于说明任务最终结果的最小完成凭据会保留，但不含会话编号、模型配置和详细调用用量。不会删除原始报告、检查结果、后续事项、授权记录或备份；Codex 会话不会自动删除。</p></div><label className="check-label"><input type="checkbox" checked={cleanupConfirmed} onChange={(event) => setCleanupConfirmed(event.target.checked)} /> 我已了解本次清理范围</label><button className="secondary-button" disabled={!cleanupConfirmed || cleanupBusy} onClick={async () => { setCleanupBusy(true); try { const result = await window.healthDesktop?.cleanupExpiredData(); if (result?.ok) { onNotice(`已清理 ${result.data.temporaryEntriesRemoved} 份临时资料和 ${result.data.terminalTaskAttemptsRemoved} 条到期处理记录；健康档案未删除。`); setCleanupConfirmed(false); } else if (result) onNotice('到期临时资料没有清理成功，请稍后重试。'); } finally { setCleanupBusy(false); } }}>{cleanupBusy ? <LoaderCircle size={18} className="spin" /> : <Archive size={18} />} 清理临时资料</button></div><div className="dialog-actions"><button className="secondary-button" onClick={() => { onClose(); onDirectories(); }}>管理目录授权</button><button className="secondary-button" onClick={() => { onClose(); onBackup(); }}>备份与恢复</button><button className="primary-button" onClick={onClose}>完成</button></div></section></div>;
}

function AboutDialog({ snapshot, onClose, onNotice }: { snapshot: DashboardSnapshot; onClose(): void; onNotice(message: string): void }) {
  const [diagnostic, setDiagnostic] = useState<DiagnosticBundle | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void window.healthDesktop?.getDiagnosticPreview().then((result) => {
      if (active && result.ok) setDiagnostic(result.data);
    });
    return () => { active = false; };
  }, []);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="member-dialog about-dialog" role="dialog" aria-modal="true" aria-labelledby="about-dialog-title"><header><div><span className="eyebrow">关于与诊断</span><h2 id="about-dialog-title">家庭健康看板</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭关于信息"><X size={19} /></button></header><p>版本 0.1.0 · 本机 Beta 构建。下列诊断预览只有计数和运行状态，不包含报告正文、成员姓名、文件名、路径、凭据或登录链接。</p><dl className="detail-list"><div><dt>Codex 状态</dt><dd>{snapshot.account.status === 'connected' ? '已连接' : snapshot.account.status === 'connecting' ? '等待官方登录' : '未连接'}</dd></div><div><dt>连接组件版本</dt><dd>{diagnostic?.application.runtimeVersion ?? 'codex-cli 0.160.1'}</dd></div><div><dt>工作区计数</dt><dd>{diagnostic ? `${diagnostic.workspace.personCount} 位成员 · ${diagnostic.workspace.documentCount} 份资料 · ${diagnostic.taskSummary.total} 个任务` : '正在生成脱敏预览…'}</dd></div><div><dt>发行状态</dt><dd>未签名本机测试构建</dd></div></dl><div className="consent-facts"><span><FileCheck2 size={17} /> 关键依赖许可随应用附带在 THIRD_PARTY_NOTICES.md</span><span><ShieldCheck size={17} /> 当前只验证了 macOS arm64；x64、Windows、签名和公证仍需目标环境</span><span><CircleHelp size={17} /> 诊断文件只保存到你选择的本机位置，不自动上传或创建 Issue</span></div><div className="dialog-actions"><button className="secondary-button" disabled={!diagnostic || busy} onClick={async () => { setBusy(true); try { const result = await window.healthDesktop?.exportDiagnostic(); if (result?.ok && result.data) onNotice(`已保存 ${result.data.displayName}；它不包含健康正文或凭据。`); else if (result && !result.ok) onNotice('脱敏诊断信息没有保存，请稍后重试。'); } finally { setBusy(false); } }}>{busy ? <LoaderCircle size={18} className="spin" /> : <Archive size={18} />} 预览后保存诊断</button><button className="primary-button" onClick={onClose}>完成</button></div></section></div>;
}

function DesktopBehaviorDialog({ behavior, onClose, onSave }: { behavior: DesktopBehavior; onClose(): void; onSave(input: { stayInTray: boolean; openAtLogin: boolean; notificationsEnabled: boolean }): Promise<boolean> }) {
  const [stayInTray, setStayInTray] = useState(behavior.stayInTray ?? true);
  const [openAtLogin, setOpenAtLogin] = useState(behavior.openAtLogin);
  const [notificationsEnabled, setNotificationsEnabled] = useState(behavior.notificationsEnabled);
  const [busy, setBusy] = useState(false);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="member-dialog" role="dialog" aria-modal="true" aria-labelledby="desktop-behavior-title"><header><div><span className="eyebrow">桌面行为</span><h2 id="desktop-behavior-title">窗口、启动与通知</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭桌面行为设置"><X size={19} /></button></header><label className="check-label"><input type="checkbox" checked={stayInTray} onChange={(event) => setStayInTray(event.target.checked)} /> 关闭窗口后驻留菜单栏 / 系统托盘</label><label className="check-label"><input type="checkbox" checked={openAtLogin} onChange={(event) => setOpenAtLogin(event.target.checked)} /> 登录电脑后自动启动</label><label className="check-label"><input type="checkbox" checked={notificationsEnabled} onChange={(event) => setNotificationsEnabled(event.target.checked)} /> 处理完成或需要确认时显示系统通知</label><div className="info-callout compact"><Bell size={18} /><div><strong>通知不会显示健康内容</strong><p>系统通知只说明任务状态，不包含成员名、病名、指标或报告文件名；睡眠、关机或退出应用时不会处理。</p></div></div><div className="dialog-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={busy} onClick={async () => { setBusy(true); try { if (await onSave({ stayInTray, openAtLogin, notificationsEnabled })) onClose(); } finally { setBusy(false); } }}>{busy ? <LoaderCircle size={18} className="spin" /> : <Check size={18} />} 保存设置</button></div></section></div>;
}

function DisplayPreferencesDialog({ preferences, onClose, onSave }: { preferences: DisplayPreferences; onClose(): void; onSave(input: DisplayPreferences): Promise<boolean> }) {
  const [fontScale, setFontScale] = useState<DisplayPreferences['fontScale']>(preferences.fontScale);
  const [reduceMotion, setReduceMotion] = useState(preferences.reduceMotion);
  const [dateStyle, setDateStyle] = useState<DisplayPreferences['dateStyle']>(preferences.dateStyle);
  const [busy, setBusy] = useState(false);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="member-dialog" role="dialog" aria-modal="true" aria-labelledby="display-preferences-title"><header><div><span className="eyebrow">显示</span><h2 id="display-preferences-title">阅读偏好</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭显示设置"><X size={19} /></button></header><label>字号<select value={fontScale} onChange={(event) => setFontScale(event.target.value as DisplayPreferences['fontScale'])}><option value="standard">标准字号</option><option value="large">大字号</option></select></label><label>日期显示<select value={dateStyle} onChange={(event) => setDateStyle(event.target.value as DisplayPreferences['dateStyle'])}><option value="friendly">中文日期（9月18日 08:30）</option><option value="numeric">数字日期（2026/09/18 08:30）</option></select></label><label className="check-label"><input type="checkbox" checked={reduceMotion} onChange={(event) => setReduceMotion(event.target.checked)} /> 减少界面动画</label><div className="info-callout compact"><Settings size={18} /><div><strong>只影响这台电脑上的阅读方式</strong><p>不会改变报告、分析结论或其他家庭成员的数据。</p></div></div><div className="dialog-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={busy} onClick={async () => { setBusy(true); try { if (await onSave({ fontScale, reduceMotion, dateStyle })) onClose(); } finally { setBusy(false); } }}>{busy ? <LoaderCircle size={18} className="spin" /> : <Check size={18} />} 保存设置</button></div></section></div>;
}

function ScheduleDialog({ snapshot, onClose, onSave }: {
  snapshot: DashboardSnapshot;
  onClose(): void;
  onSave(input: { enabled: boolean; localTime: string; expectedRevision: number }): Promise<boolean>;
}) {
  const [enabled, setEnabled] = useState(snapshot.scheduleEnabled);
  const [localTime, setLocalTime] = useState(snapshot.scheduleLocalTime);
  const [busy, setBusy] = useState(false);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="member-dialog schedule-dialog" role="dialog" aria-modal="true" aria-labelledby="schedule-dialog-title"><header><div><span className="eyebrow">自动处理</span><h2 id="schedule-dialog-title">设置每日检查时间</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭自动处理设置"><X size={19} /></button></header><p>只处理已明确授权“日程 AI 处理”的收件箱资料，并继续使用授权时绑定的 Codex 账户。</p><label className="check-label"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> 启用每日自动检查</label><label>本机时间<input type="time" value={localTime} disabled={!enabled} onChange={(event) => setLocalTime(event.target.value)} /></label><div className="info-callout compact"><CalendarClock size={18} /><div><strong>不会唤醒已经关机或睡眠的电脑</strong><p>应用运行时会按 {snapshot.scheduleTimeZone} 检查；若错过时间，会在恢复运行后补查一次。没有新资料时不会调用模型。</p></div></div><div className="dialog-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={busy || !/^([01]\d|2[0-3]):[0-5]\d$/.test(localTime)} onClick={async () => { setBusy(true); try { if (await onSave({ enabled, localTime, expectedRevision: snapshot.scheduleRevision })) onClose(); } finally { setBusy(false); } }}>{busy ? <LoaderCircle size={18} className="spin" /> : <Check size={18} />} 保存设置</button></div></section></div>;
}

function BackupDialog({ onClose, onNotice, onRestored, onRebuild }: { onClose(): void; onNotice(message: string): void; onRestored(snapshot: DashboardSnapshot): void; onRebuild(): void }) {
  const [mode, setMode] = useState<'create' | 'restore'>('create');
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [restoreSelection, setRestoreSelection] = useState<{ selectionId: string; displayName: string } | null>(null);
  const [confirmedReplace, setConfirmedReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const createValid = passphrase.length >= 10 && passphrase === confirmation;

  async function createBackup() {
    if (!window.healthDesktop || !createValid) return;
    setBusy(true);
    try {
      const result = await window.healthDesktop.createBackup(passphrase);
      if (!result.ok) {
        onNotice('加密备份没有创建成功；原工作区没有改变。');
        return;
      }
      if (!result.data) return;
      setPassphrase('');
      setConfirmation('');
      onNotice(`已创建 ${result.data.displayName}，包含 ${result.data.objectCount} 个原始资料文件。请妥善保存口令，应用无法替你找回。`);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  async function pickRestore() {
    const result = await window.healthDesktop?.pickRestoreBackup();
    if (result?.ok && result.data) setRestoreSelection(result.data);
  }

  async function restoreBackup() {
    if (!window.healthDesktop || !restoreSelection || !passphrase || !confirmedReplace) return;
    setBusy(true);
    try {
      const result = await window.healthDesktop.restoreBackup({
        selectionId: restoreSelection.selectionId,
        passphrase,
        confirmedReplaceWorkspace: true
      });
      if (!result.ok) {
        onNotice(result.error.code === 'BACKUP_RESTORE_CANCELLED'
          ? '恢复已停止；当前工作区保持不变。'
          : result.error.code === 'BACKUP_PASSPHRASE_OR_INTEGRITY_INVALID'
          ? '口令不正确或备份已损坏；当前工作区保持不变。'
          : result.error.code === 'RESTORE_ACTIVE_JOB'
            ? '请先停止正在运行的处理任务，再恢复备份。'
            : '备份没有恢复成功；当前工作区保持不变。');
        return;
      }
      onRestored(result.data);
      setPassphrase('');
      onNotice('备份已校验并恢复，当前显示的是恢复后的本机工作区。');
      onClose();
    } finally {
      setBusy(false);
    }
  }

  async function cancelRestore() {
    await window.healthDesktop?.cancelRestore();
  }

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }}><section className="workspace-dialog backup-dialog" role="dialog" aria-modal="true" aria-labelledby="backup-dialog-title"><header><div><span className="eyebrow">备份与恢复</span><h2 id="backup-dialog-title">保护本机家庭健康档案</h2></div><button className="icon-button" disabled={busy} onClick={onClose} aria-label="关闭备份与恢复"><X size={19} /></button></header><div className="rebuild-entry"><div><strong>用新流程重新整理全部报告</strong><p>保留原始资料和成员，从头生成报告结果与健康解读。可选择是否同时清空本人补充和计划；开始前会说明范围并创建可恢复备份。</p></div><button className="secondary-button" disabled={busy} onClick={onRebuild}><RefreshCw size={18} /> 按新流程重建报告结果</button></div><div className="filter-tabs"><button disabled={busy} className={mode === 'create' ? 'is-active' : ''} onClick={() => { setMode('create'); setPassphrase(''); }}>创建备份</button><button disabled={busy} className={mode === 'restore' ? 'is-active' : ''} onClick={() => { setMode('restore'); setPassphrase(''); setConfirmation(''); }}>恢复备份</button></div>{mode === 'create' ? <><p className="dialog-intro">备份包含健康档案和原始报告，并使用口令加密。请妥善保管口令，应用无法替你找回。</p><label>备份口令（至少 10 个字符）<input disabled={busy} type="password" autoComplete="new-password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} /></label><label>再次输入口令<input disabled={busy} type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>{confirmation && passphrase !== confirmation && <span className="field-error">两次口令不一致。</span>}<div className="dialog-actions"><button className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" disabled={busy || !createValid} onClick={() => void createBackup()}>{busy ? <LoaderCircle size={18} className="spin" /> : <Archive size={18} />} 选择位置并创建</button></div></> : <><p className="dialog-intro">恢复将用备份中的档案替换当前档案。应用会先检查备份是否完整；检查期间可以停止，当前档案不会改变。</p><button className="secondary-button" disabled={busy} onClick={() => void pickRestore()}><FileText size={17} /> {restoreSelection ? '重新选择备份' : '选择加密备份'}</button>{restoreSelection && <div className="info-callout compact"><Archive size={18} /><div><strong>{restoreSelection.displayName}</strong><p>尚未解密或改动当前工作区。</p></div></div>}<label>备份口令<input disabled={busy} type="password" autoComplete="current-password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} /></label><label className="check-label"><input disabled={busy} type="checkbox" checked={confirmedReplace} onChange={(event) => setConfirmedReplace(event.target.checked)} /> 我确认用所选备份替换当前本机工作区</label><div className="dialog-actions">{busy ? <button className="secondary-button" onClick={() => void cancelRestore()}><X size={17} /> 停止恢复</button> : <button className="secondary-button" onClick={onClose}>取消</button>}<button className="primary-button" disabled={busy || !restoreSelection || !passphrase || !confirmedReplace} onClick={() => void restoreBackup()}>{busy ? <LoaderCircle size={18} className="spin" /> : <RefreshCw size={18} />} 校验并恢复</button></div></>}</section></div>;
}

function ProcessingRebuildDialog({ snapshot, onClose, onStarted, onInspect }: {
  snapshot: DashboardSnapshot;
  onClose(): void;
  onStarted(receipt: ProcessingRebuildReceipt): void;
  onInspect(): void;
}) {
  const [confirmedClear, setConfirmedClear] = useState(false);
  const [clearPersonalData, setClearPersonalData] = useState(false);
  const [confirmedSend, setConfirmedSend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receiptUncertain, setReceiptUncertain] = useState(false);
  const [scopePersonId, setScopePersonId] = useState('');
  const [aliasPersonId, setAliasPersonId] = useState(snapshot.persons.length === 1 ? snapshot.persons[0]!.id : '');
  const [reportedAlias, setReportedAlias] = useState('');
  const activeJob = snapshot.jobs.some((job) => ['queued', 'running', 'retry_wait'].includes(job.status));
  const connected = snapshot.account.status === 'connected';
  const personalWorkspace = snapshot.workspaceMode === 'personal';
  const scopedPersons = snapshot.persons.filter((person) => !scopePersonId || person.id === scopePersonId);
  const sourcePreviewReady = snapshot.processingRebuildSources !== undefined;
  const scopedSources = (snapshot.processingRebuildSources ?? []).filter((source) =>
    !scopePersonId || source.personId === scopePersonId).map((source) => ({
    documentId: source.documentId, personId: source.personId, sourceObjectId: source.sourceObjectId, sha256: source.sha256
  })).sort((first, second) => first.documentId.localeCompare(second.documentId));
  const scopeSignature = JSON.stringify({ scopePersonId, sources: sourcePreviewReady ? scopedSources : null });
  const [previousScopeSignature, setPreviousScopeSignature] = useState(scopeSignature);
  // 确认绑定到当前预览的原件四元组；新导入、归属或原件变化不能沿用旧勾选。
  if (previousScopeSignature !== scopeSignature) {
    setPreviousScopeSignature(scopeSignature);
    setConfirmedClear(false); setConfirmedSend(false);
  }
  const hasAssignedReports = scopedSources.length > 0;
  const scopeLabel = scopePersonId ? scopedPersons[0]?.displayName ?? '所选成员' : '所有成员';
  const aliasName = reportedAlias.trim();
  const validAlias = aliasName.length === 0 || scopedPersons.some((person) => person.id === aliasPersonId);
  const canStart = Boolean(window.healthDesktop) && personalWorkspace && connected && !activeJob
    && sourcePreviewReady && hasAssignedReports && validAlias;

  async function startRebuild() {
    if (!window.healthDesktop || !canStart || busy || receiptUncertain || !confirmedClear || !confirmedSend) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.healthDesktop.rebuildProcessing({ consentVersion: 1, confirmedRebuildReportResults: true,
        expectedSources: scopedSources,
        ...(scopePersonId ? { personIds: [scopePersonId] } : {}),
        ...(clearPersonalData ? { clearPersonalData: true, confirmedClearPersonalData: true } : {}),
        ...(aliasName ? { confirmedPersonAliases: [{ personId: aliasPersonId, reportedName: aliasName }] } : {}) });
      if (!result.ok) {
        if (['PROCESSING_REBUILD_SOURCE_SCOPE_CHANGED', 'PROCESSING_REBUILD_PERSON_SCOPE_INVALID'].includes(result.error.code)) {
          setConfirmedClear(false); setConfirmedSend(false);
        }
        setError(result.error.code === 'LOCAL_STORAGE_FULL'
          ? '本机磁盘空间不足，本次重建未能完成。请释放空间后，先查看处理中心和本机恢复点确认进度，再继续；无需重新上传原件。'
          : result.error.code === 'PROCESSING_REBUILD_HAS_ACTIVE_JOB'
          ? '有任务正在处理或等待开始。请先在处理中心停止这些任务，再重建。'
          : ['PROCESSING_REBUILD_AUTH_REQUIRED', 'AUTH_REQUIRED'].includes(result.error.code)
            ? 'Codex 连接或授权已变化，请重新连接后再确认。'
            : result.error.code === 'NO_READY_DOCUMENTS'
              ? '没有已归属且纳入分析的可重建报告，请先检查资料范围。'
              : ['PROCESSING_REBUILD_BACKUP_REQUIRED', 'PROCESSING_REBUILD_BACKUP_CHANGED'].includes(result.error.code)
                ? '恢复备份未通过校验，尚未清理旧结果。请稍后再试。'
                : result.error.code === 'PERSON_NAME_ALIAS_CONFLICT'
                  ? '这个报告别名已属于另一位成员。旧结果尚未清理，请检查别名对应的人。'
                  : result.error.code === 'PROCESSING_REBUILD_ALIAS_SCOPE_INVALID'
                    ? '别名对应成员不在本次报告范围内。旧结果尚未清理，请修正或清空别名。'
                : ['PROCESSING_REBUILD_SOURCE_SCOPE_CHANGED', 'PROCESSING_REBUILD_PERSON_SCOPE_INVALID'].includes(result.error.code)
                  ? '报告范围或原文件发生变化，本次没有开始重建。请重新打开此页面确认。'
                  : '暂时无法开始重建，请查看处理中心与本机恢复点后再试。原始报告不会被删除。');
        return;
      }
      onStarted(result.data);
      onClose();
    } catch {
      // 连接中断时不猜测后台是否已经完成事务，先让用户检查任务回执。
      setReceiptUncertain(true);
      setError('暂时未收到重建回执。请先查看处理中心，确认是否已开始，不要重复提交。');
    } finally {
      setBusy(false);
    }
  }

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
    if (!busy && event.target === event.currentTarget) onClose();
  }}>
    <section className="workspace-dialog processing-rebuild-dialog" role="dialog" aria-modal="true" aria-busy={busy} aria-labelledby="processing-rebuild-title">
      <header><div><span className="eyebrow">重新整理报告</span><h2 id="processing-rebuild-title">按新流程重建报告结果</h2></div><button className="icon-button" disabled={busy} onClick={onClose} aria-label="关闭重建确认"><X size={19} /></button></header>
      <div className="rebuild-body">
        <label className="rebuild-field">重建范围<select disabled={busy} value={scopePersonId} onChange={(event) => {
          const next = event.target.value;
          setScopePersonId(next); setAliasPersonId(next); setReportedAlias('');
          setConfirmedClear(false); setConfirmedSend(false);
        }}><option value="">所有成员</option>{snapshot.persons.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}</select></label>
        <p role="status">本次范围：{scopeLabel} · {scopedPersons.length} 位成员 · {scopedSources.length} 份报告。{scopePersonId ? '其他成员的原件、结果、补充信息和计划都不会改变。' : '如只需重建一位家人的资料，请先选择该成员。'}</p>
        <p>重新处理当前已归属、且纳入健康分析的全部报告，然后按成员生成整体健康解读和日常建议。忽略、排除、已删除的报告及已归档成员不在本次范围内。</p>
        <article className="rebuild-boundary"><h3>这些内容会保留</h3><p>{clearPersonalData ? '只保留原始报告文件、成员资料和已确认的姓名别名。当前模型设置与本机恢复点保留。' : '原始报告文件、成员资料、已确认的姓名别名、本人补充信息、手写记录，以及已经保存的个人行动计划。'}</p></article>
        <article className="rebuild-boundary"><h3>这些结果会从头生成</h3><p>旧报告的提取事实、日期归属、健康解读、未采纳建议与报告核对记录会清理。以前人工确认过的报告数值也会清理，只保留在恢复点中；新流程不会沿用它们。</p>{clearPersonalData && <p>{scopePersonId ? '只清理所选成员的本人补充信息、手写记录、已采纳建议、个人计划、旧任务及发送回执；其他成员和无法单独归属的家庭记录保留。' : '本人补充信息、手写记录、已采纳建议、所有个人计划，以及旧任务、发送回执和通知也会清空，不会沿用到新的综合分析。'}</p>}</article>
        <label className="check-label"><input disabled={busy} type="checkbox" checked={clearPersonalData} onChange={(event) => { setClearPersonalData(event.target.checked); setConfirmedClear(false); setConfirmedSend(false); }} /> 同时清空本人补充和全部计划，仅保留原件和成员</label>
        <div className="info-callout compact"><ShieldCheck size={20} /><div><strong>先校验恢复备份，再清理旧结果</strong><p>应用会自动创建并校验本机恢复点。备份失败就不清理；重建过程中可以在处理中心查看进度。</p></div></div>
        <article className="rebuild-boundary"><h3>本次发送给 OpenAI / Codex</h3><p>原始报告将直接交给 GPT-6.1-Sol / medium 阅读，不使用本机 OCR 识别或文字匹配来裁定报告内容。应用只准备完整页面、检查结构并保存结果，不需要重新上传文件。{clearPersonalData ? '综合分析只使用这轮重新接纳的事实，不沿用旧本人补充和计划。' : '按成员综合时还会使用已接纳事实和必要的本人补充。'}</p><p>读取报告不使用网页搜索。成员综合保留现有联网搜索设置；搜索词目前不能在发送前逐条拦截，模型若未遵守去标识化要求，敏感内容可能进入搜索服务。</p></article>
        <article className="rebuild-boundary"><h3>已确认的报告别名（可选）</h3><p>如果报告用了昵称或曾用名，可在这里确认它属于谁。空着也能重建；不要填写尚未确认的姓名。</p><label className="rebuild-field">对应成员<select disabled={busy} value={aliasPersonId} onChange={(event) => setAliasPersonId(event.target.value)}><option value="">请选择对应成员</option>{scopedPersons.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}</select></label><label className="rebuild-field">报告里的昵称或曾用名<input disabled={busy} type="text" autoComplete="off" maxLength={80} value={reportedAlias} onChange={(event) => setReportedAlias(event.target.value)} /></label>{aliasName && <p>{validAlias ? `提交即确认“${aliasName}”与所选成员是同一人。该确认只保存在本机，供以后识别同名报告使用。` : '请明确选择这个报告别名对应的成员。'}</p>}</article>
        <label className="check-label"><input disabled={busy} type="checkbox" checked={confirmedClear} onChange={(event) => setConfirmedClear(event.target.checked)} /> {clearPersonalData ? '我确认清理旧报告结果、本人补充、手写记录和全部计划，只保留原件、成员及本机恢复点' : '我确认清理旧报告结果，包括以前人工核对的值，并保留本机恢复点'}</label>
        <label className="check-label"><input disabled={busy} type="checkbox" checked={confirmedSend} onChange={(event) => setConfirmedSend(event.target.checked)} /> 我授权将上述报告{clearPersonalData ? '' : '与必要本人补充'}发送给 OpenAI/Codex 直接阅读原件并重新综合，已了解搜索风险</label>
        {!personalWorkspace && <p className="field-error" role="status">演示工作区不能重建真实报告，请切换到个人工作区。</p>}
        {!connected && <p className="field-error" role="status">请先连接 Codex，再开始重建。</p>}
        {activeJob && <p className="field-error" role="status">有任务正在处理或等待开始，请先在处理中心停止这些任务。</p>}
        {!sourcePreviewReady ? <p className="field-error" role="status">当前报告范围未完成载入，请关闭此页并刷新工作区后再确认。</p>
          : !hasAssignedReports && <p className="field-error" role="status">当前没有已归属的报告可重建。</p>}
        {error && <p className="field-error" role="alert">{error}</p>}
        {busy && <p role="status">正在核验原始资料并创建恢复点，请保持应用打开。收到回执后会进入处理中心。</p>}
      </div>
      <div className="dialog-actions"><button className="secondary-button" disabled={busy} onClick={() => { onClose(); if (receiptUncertain) onInspect(); }}>{receiptUncertain ? '关闭并查看处理中心' : '取消'}</button><button className="primary-button" disabled={busy || receiptUncertain || !canStart || !confirmedClear || !confirmedSend} onClick={() => void startRebuild()}>{busy ? <LoaderCircle size={18} className="spin" /> : <RefreshCw size={18} />} 备份并开始重建</button></div>
    </section>
  </div>;
}

function isReadOnlyResultLimitation(review: ReviewIssue, item: InboxItem | undefined, reviews: ReviewIssue[]): boolean {
  return isSourceRepairReview(review) || isUserAssignedIdentityRepairReview(review, item)
    && isUserAssignedIdentityRepairDocument(item, reviews);
}

// 处理原因只在工作记录里解释，不拿它代替健康情况或可靠报告事实。
const reportReviewReasonLabels: Record<string, string> = {
  metadata_date_evidence_not_proven: '日期引用无法核验',
  metadata_date_not_in_evidence: '日期与原报告不一致',
  metadata_date_role_mismatch: '将签发等日期误作检查日期',
  report_metadata_date_evidence_unverified: '日期引用无法核验',
  report_metadata_date_role_unverified: '日期的检查或签发用途尚未核验',
  report_metadata_date_conflict: '日期信息存在不同版本，尚未核验',
  numeric_value_not_in_evidence: '结果数值与本机读取的来源尚未对上',
  text_value_not_in_evidence: '文字结果与本机读取的来源尚未对上',
  text_result_not_in_evidence: '文字结果与本机读取的来源尚未对上',
  unit_not_bound_to_item: '单位还没有可靠对应到这项结果',
  source_span_missing: '引用的原始位置没有找到',
  missing_evidence: '这项结果缺少可核验的来源',
  evidence_missing: '这项结果缺少可核验的来源',
  evidence_mismatch: '结果和来源的对应关系还未确认',
  local_visual_recognition_failed: '本机文字识别未完成；不等于原件不可读',
  LOCAL_VISUAL_RECOGNITION_FAILED: '本机文字识别未完成；不等于原件不可读',
  LOCAL_VISUAL_TIMEOUT: '本机文字识别等待超时',
  LOCAL_VISUAL_OUTPUT_LIMIT_EXCEEDED: '本机文字识别输出超过本次读取容量',
  LOCAL_VISUAL_RECEIPT_INVALID: '本机文字识别的返回格式无效',
  EXTRACTION_REPAIR_SCHEMA_INVALID: '自动修复的返回格式不能安全使用',
  EXTRACTION_REPAIR_SCOPE_INVALID: '自动修复改动了本次范围外的内容',
  DIRECT_ORIGINAL_NO_ACCEPTABLE_FACTS: '尚无检查结果通过来源核验，原件已保留',
  direct_original_evidence_role_mismatch: '结果与原件位置的绑定尚未通过核验，不表示原件中的结果有误',
  direct_original_binding_not_attached: '读取结果没有可靠关联到原件中的对应位置',
  same_source_finding_batch_conflict: '同一处原件被关联到不同结果，尚未确认各自对应关系',
  source_refinement_medical_fields_changed: '本次重读的结果或检验条件与已有结果不同，未替换已有结果',
  same_source_finding_semantic_conflict: '同一处原文出现不同的读取版本，未替换已有结果',
  prior_unresolved_source_not_reconciled: '以前未能核实的内容，本次仍缺少足够来源证明已解决；原件和已保存结果保留',
  value_unknown: '未能从现有原件确认可用的检查结果，不能把未知当作正常',
  direct_original_readable_source_not_accounted: '原件中已读到结果摘录，但尚未完整对应到检查条目',
  reading_candidate_not_accounted: '读取条目尚未完成保存对账，暂不纳入分析'
};

function ReadingAuditDetails({ review }: { review: ReviewIssue }) {
  const audit = review.readingAudit;
  const historicalCount = audit?.historicalReadingCount ?? distinctLimitationCandidates([review]).length;
  return <div className="body-copy" style={{ fontSize: 16 }}>
    {audit ? <>
      {audit.ledger?.scope === 'selected_pages' && <p>本次仅补读 {audit.ledger.pages.length} 页。以下是这些问题页的对账，不代表重新读取了整份报告；其余页的已保存结果和历史说明保留。</p>}
      {!audit.ledger && <p>这次旧版本只保留了聚合对账；未提供结果的条目和逐页盘点不完整，不能据此保证没有漏项。</p>}
      <p>最近一次读取共 {audit.totalCandidates} 条内容：{audit.savedCandidates} 条已保存或对应到已有结果，{audit.emptyCandidates} 条原件未提供结果，{audit.pending.length} 条暂未纳入。读取条目不等于独立检查项目数。</p>
      {audit.pending.length > 0 && <ul>{audit.pending.map((item, index) => <li key={`${item.localKey}:${index}`}>
        {item.originalName}：{[...new Set(item.reasonCodes.map((code) => reportReviewReasonLabels[code.split(':')[0]!] ?? '来源或内容尚未可靠核实'))].join('；')}
      </li>)}</ul>}
      {audit.unrepresentedSourceCount > 0 && <p>另有 {audit.unrepresentedSourceCount} 处可读结果摘录尚未完整对应到条目，不能视为已全部整理。</p>}
      {audit.pageGapCount > 0 && <p>{audit.pageGapCount} 页仍有读取或内容对应说明，请结合原件查看。</p>}
    </> : <p>这份旧记录尚无逐次完整性对账，暂不能确定真正未纳入的独立项目数。已有可靠结果继续参与分析。</p>}
    {historicalCount > 0 && <details><summary>历史读取版本（{historicalCount} 条待对账记录）</summary>
      <p>包含历次读取留下的版本，不是“本次遗漏 {historicalCount} 项”。部分可能已有正式结果，未证明对应关系前仍保留审计记录；不会据此强行合并或改写结果。</p>
    </details>}
  </div>;
}

function distinctLimitationCandidates(reviews: ReviewIssue[]): ReviewIssue['candidateOptions'] {
  const seen = new Set<string>();
  return reviews.flatMap((review) => review.candidateOptions.filter((candidate) => {
    // 旧资料可能复用 localKey；同 key 但项目、值或来源不同的候选不能被合并隐藏。
    const key = `${review.documentId}:${JSON.stringify(candidate)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
}

function ProcessingNotesPanel({ snapshot, reviews, onEvidence }: {
  snapshot: DashboardSnapshot;
  reviews: ReviewIssue[];
  onEvidence(review: ReviewIssue): void;
}) {
  return <section className="panel" aria-label="资料处理说明">
    <div className="panel__heading"><div><span className="eyebrow">资料处理说明</span><h2>部分内容暂未纳入</h2></div><StatusBadge tone="info">原件和已有结果保留</StatusBadge></div>
    <p className="body-copy">无需确认或批准。可靠结果会继续整理，无法可靠采用的内容会留在这里说明，不会当作正常结果。</p>
    <div className="document-list">{reviews.map((review) => {
      const documentName = snapshot.inbox.find((item) => item.id === review.documentId)?.displayName ?? '本机报告';
      const identityIssue = review.kind === 'person_conflict'
        || review.reasonCodes.some((code) => code.startsWith('PERSON_') || code === 'DIRECT_ORIGINAL_IDENTITY_UNPROVEN');
      const explanation = identityIssue
        ? '报告中的身份信息与当前成员尚未可靠对应，本份资料暂未纳入其健康分析；其他资料继续整理。'
        : review.kind === 'derived_safety'
          ? '部分解读暂未显示；已保存的报告结果和其他解读仍可查看。'
          : '部分结果或来源尚未可靠对应，暂未纳入本次解读；已保存的可靠结果会保留。';
      return <article className="document-row" key={review.id}><div><strong>{documentName}</strong><p className="body-copy">{explanation}</p></div>
        <button className="text-button" aria-label={`查看${documentName}的依据`} onClick={() => onEvidence(review)}><FileCheck2 size={17} /> 查看依据</button>
      </article>;
    })}</div>
  </section>;
}

function ResultLimitationsPanel({ snapshot, reviews, onEvidence, onRepairReports }: {
  snapshot: DashboardSnapshot;
  reviews: ReviewIssue[];
  onEvidence(review: ReviewIssue): void;
  onRepairReports(documentIds: string[]): void;
}) {
  const repairDocuments = snapshot.workspaceMode === 'personal'
    ? manualProcessingScope(snapshot, [...new Set([...reviews.map((review) => review.documentId),
      ...snapshot.inbox.filter(item => (item.dateBindingReviewCount ?? 0) > 0).map(item => item.id)])]).repairDocuments : [];
  const repairScopeSignature = JSON.stringify(repairDocuments.map((document) => [document.id, document.personId,
    document.displayName, snapshot.persons.find((person) => person.id === document.personId)?.dataRevision,
    snapshot.reviews.filter((review) => review.documentId === document.id && review.resolutionStatus === 'open')])
    .sort(([left], [right]) => String(left).localeCompare(String(right))));
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [previousScopeSignature, setPreviousScopeSignature] = useState(repairScopeSignature);
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  if (previousScopeSignature !== repairScopeSignature) {
    // 新增、移除、改归或结果变化都要求重新选择，不能因资料恢复原状复活旧选择。
    setPreviousScopeSignature(repairScopeSignature);
    if (selectedIds.length > 0) setSelectedIds([]);
  }
  const selectedDocuments = repairDocuments.filter((document) => selectedIds.includes(document.id));
  const groups = new Map<string, { personLabel: string; reviews: ReviewIssue[] }>();
  for (const review of reviews) {
    const document = snapshot.inbox.find((item) => item.id === review.documentId);
    const personId = document?.personId ?? review.personId;
    const personLabel = snapshot.persons.find((person) => person.id === personId)?.displayName
      ?? document?.personLabel ?? '待归属资料';
    const key = personId ?? 'unassigned';
    const group = groups.get(key) ?? { personLabel, reviews: [] };
    group.reviews.push(review);
    groups.set(key, group);
  }
  return <section className="section-block" aria-label="报告结果边界">{[...groups].map(([personId, group]) => {
    const documentIds = [...new Set(group.reviews.map((item) => item.documentId))];
    const documentCount = documentIds.length;
    const metadataDatesOnly = group.reviews.every((review) => review.candidateOptions.length === 0
      && review.reasonCodes.length > 0 && review.reasonCodes.every((code) => code.startsWith('metadata_date_')
        || code.startsWith('report_metadata_date_')));
    const allKnownZero = documentIds.every((id) => snapshot.inbox.find((item) => item.id === id)?.acceptedFactCount === 0);
    return <article className="panel" aria-label={`${group.personLabel}的报告结果边界`} key={personId}>
    <h3>{group.personLabel}</h3>
    <div className="panel__heading"><div><span className="eyebrow">报告结果说明</span><h2>{allKnownZero ? `${documentCount} 份资料暂无可用结果` : metadataDatesOnly ? `${documentCount} 份资料的报告日期尚未核验` : `${documentCount} 份资料有需说明的内容`}</h2></div><StatusBadge tone="info">{allKnownZero ? '暂无检查结果纳入分析' : '已有正式结果保留'}</StatusBadge></div>
    {allKnownZero && <p className="body-copy" style={{ fontSize: 16 }}>这些资料尚未提供可用于健康分析的检查结果；原件仍在，不代表检查结果正常，无需你确认。</p>}
    <p className="body-copy" style={{ fontSize: 16 }}>{metadataDatesOnly ? '有可靠来源的检查结果已经保存。这部分尚未核验的日期没有作为正式报告日期发布；签发日期不会自动当作检查日期。' : '可靠结果已保存。下面分别说明最近一次读取和历史版本；不把历次记录相加当作遗漏项目或异常数。无需逐条确认，未知内容不会被当作正常结果。'}</p>
    <div className="document-list">{group.reviews.map((review) => {
      const document = snapshot.inbox.find((item) => item.id === review.documentId);
      const documentName = document?.displayName ?? '本机报告';
      const reasonLabels = [...new Set(review.reasonCodes.flatMap((rawCode) => {
        const code = rawCode.split(':')[0]!;
        return reportReviewReasonLabels[code] ? [reportReviewReasonLabels[code]!] : [];
      }))];
      const noAcceptedResults = document?.acceptedFactCount === 0;
      const selectedIdentity = isUserAssignedIdentityRepairReview(review, document);
      return <article className="document-row" key={review.id}>
        <div><strong>{documentName}</strong><p style={{ fontSize: 16 }}>{selectedIdentity ? '上传时已选择成员，旧版姓名校验曾阻止整理。' : noAcceptedResults ? '暂无可用结果' : review.readingAudit ? `最近一次读取：${review.readingAudit.pending.length} 条内容暂未纳入` : '保留历史读取说明，实际未纳入项目数尚未确认'}</p>
          {selectedIdentity && <p className="body-copy" style={{ fontSize: 16 }}>无需再次确认同名，重新整理会沿用上传时选择的成员；报告内容仍按原件核实。</p>}
          {reasonLabels.length > 0 && <ul className="body-copy" style={{ fontSize: 16 }}>{reasonLabels.map((label) => <li key={label}>{label}</li>)}</ul>}
          <details><summary>查看本轮结果、未纳入原因与历史版本</summary><ReadingAuditDetails review={review} /></details>
        </div>
        <div className="button-row"><button className="text-button" aria-label={`查看${documentName}的依据`} onClick={() => onEvidence(review)}><FileCheck2 size={17} /> 查看依据</button></div>
      </article>;
    })}</div>
  </article>;
  })}{repairDocuments.length > 0 && <details className="panel" aria-label="可选报告维护"
    open={maintenanceOpen} onToggle={(event) => setMaintenanceOpen(event.currentTarget.open)}>
    <summary style={{ minHeight: 44, fontSize: 16, cursor: 'pointer' }}>可选维护：重新核对报告</summary>
    {maintenanceOpen && <>
    <p className="body-copy" style={{ fontSize: 16 }}>无需逐条批准检查结果。若希望模型再读一次，可选择报告；已有可靠结果会保留，仍无法核实的内容不会当作正常结果。上传资料后的自动整理不受影响。</p>
    <div className="document-list" role="group" aria-label="选择可选维护报告">{repairDocuments.map((document) => <label className="check-label" key={document.id}
      style={{ minHeight: 44, fontSize: 16 }}>
      <input type="checkbox" aria-label={`选择维护报告：${document.displayName}`} checked={selectedIds.includes(document.id)}
        onChange={(event) => setSelectedIds((current) => event.target.checked ? [...new Set([...current, document.id])]
          : current.filter((id) => id !== document.id))} />
      <span><strong>{document.displayName}</strong><small>{snapshot.persons.find((person) => person.id === document.personId)?.displayName}{(document.dateBindingReviewCount ?? 0) > 0 ? ' · 部分结果尚未对应单项日期' : ''}</small></span>
    </label>)}</div>
    <div className="dialog-actions"><button className="secondary-button" style={{ minHeight: 44, fontSize: 16 }} disabled={selectedDocuments.length === 0}
      onClick={() => { if (selectedDocuments.length > 0) onRepairReports(selectedDocuments.map((document) => document.id)); }}>
      <RefreshCw size={17} /> 重新核对所选报告（{selectedDocuments.length}）</button></div>
    </>}
  </details>}</section>;
}

const reviewDiffFieldLabels: Record<ReviewIssue['candidateDiffs'][number]['fields'][number], string> = {
  presence: '是否存在这项',
  originalName: '报告项目名',
  standardNameCandidate: '常用项目名',
  value: '结果',
  unitRaw: '单位',
  referenceRangeRaw: '参考范围',
  reportedAbnormalFlag: '报告明确写出的异常说明（没有则留空）',
  specimen: '标本',
  method: '检验方法',
  bodySite: '检查部位',
  clinicalDate: '检查日期',
  issues: '待确认内容'
};

type ReviewCandidate = ReviewIssue['candidateOptions'][number];
type ReviewDiffField = ReviewIssue['candidateDiffs'][number]['fields'][number];

const comparatorSymbols = { eq: '=', lt: '<', lte: '≤', gt: '>', gte: '≥' } as const;

function numericRawText(comparator: keyof typeof comparatorSymbols, decimal: string): string {
  return `${comparator === 'eq' ? '' : comparatorSymbols[comparator]}${decimal}`;
}

function reviewCandidateFieldValue(candidate: ReviewCandidate | null | undefined, field: ReviewDiffField): string {
  if (!candidate) return field === 'presence' ? '未读取到这项' : '—';
  if (field === 'presence') return '读取到这项';
  if (field === 'value') return candidate.value.rawText ?? '未读出';
  if (field === 'issues') return candidate.issues.length > 0 ? '这部分原文还不清楚' : '已读清';
  const value = candidate[field];
  return typeof value === 'string' && value.trim() ? value : '未填写';
}

function ReviewDifferenceEditor({ candidate, fields, included, onIncludedChange, onChange }: {
  candidate: ReviewCandidate;
  fields: ReviewDiffField[];
  included: boolean;
  onIncludedChange(included: boolean): void;
  onChange(updater: (candidate: ReviewCandidate) => ReviewCandidate): void;
}) {
  const editableFields = fields.filter((field) => field !== 'presence' && field !== 'issues');
  const editor = (field: ReviewDiffField) => {
    const label = reviewDiffFieldLabels[field];
    if (field === 'value') {
      if (candidate.value.kind === 'numeric') {
        return <div className="review-numeric-editor" key={field}>
          <label>比较符<select aria-label={`${candidate.originalName}比较符`} value={candidate.value.comparator} onChange={(event) => onChange((current) => {
            if (current.value.kind !== 'numeric') return current;
            const comparator = event.target.value as keyof typeof comparatorSymbols;
            return { ...current, value: { ...current.value, comparator, rawText: numericRawText(comparator, current.value.decimal) } };
          })}><option value="eq">= 等于</option><option value="lt">&lt; 小于</option><option value="lte">≤ 小于等于</option><option value="gt">&gt; 大于</option><option value="gte">≥ 大于等于</option></select></label>
          <label>{label}<input inputMode="decimal" value={candidate.value.decimal} onChange={(event) => onChange((current) => {
            if (current.value.kind !== 'numeric') return current;
            const decimal = event.target.value.trim();
            return { ...current, value: { ...current.value, decimal, rawText: numericRawText(current.value.comparator, decimal) } };
          })} /></label>
        </div>;
      }
      return <label key={field}>{label}<input value={candidate.value.rawText ?? ''} onChange={(event) => onChange((current) => ({ ...current, value: { ...current.value, rawText: event.target.value } }))} /></label>;
    }
    if (field === 'clinicalDate') {
      return <label key={field}>{label}<input type="date" value={candidate.clinicalDate ?? ''} onChange={(event) => onChange((current) => ({ ...current, clinicalDate: event.target.value || null }))} /></label>;
    }
    if (field === 'originalName') {
      return <label key={field}>{label}<input value={candidate.originalName} onChange={(event) => onChange((current) => ({ ...current, originalName: event.target.value }))} /></label>;
    }
    if (field === 'standardNameCandidate') {
      return <label key={field}>{label}<input value={candidate.standardNameCandidate ?? ''} onChange={(event) => onChange((current) => ({ ...current, standardNameCandidate: event.target.value || null }))} /></label>;
    }
    if (field === 'unitRaw' || field === 'referenceRangeRaw' || field === 'reportedAbnormalFlag'
      || field === 'specimen' || field === 'method' || field === 'bodySite') {
      return <label key={field}>{label}<input value={candidate[field] ?? ''} onChange={(event) => onChange((current) => ({ ...current, [field]: event.target.value || null }))} /></label>;
    }
    return null;
  };
  return <div className="review-correction-fields">
    {fields.includes('presence') && <label className="review-presence-choice"><input type="checkbox" checked={included} onChange={(event) => onIncludedChange(event.target.checked)} /> 原报告中确实有这一项，应纳入健康档案</label>}
    {fields.includes('issues') && <label className="review-presence-choice"><input type="checkbox" checked={!included} onChange={(event) => onIncludedChange(!event.target.checked)} /> 这一项证据还不够清楚，本次先不写入档案</label>}
    {included && !fields.includes('originalName') && <label>项目名<input value={candidate.originalName} onChange={(event) => onChange((current) => ({ ...current, originalName: event.target.value }))} /></label>}
    {included && editableFields.map(editor)}
    {fields.includes('issues') && <div className="info-callout compact"><ShieldCheck size={18} /><div><strong>不会因为这一项卡住整份报告</strong><p>保持勾选即会排除这一项，其他已核实的项目仍可正常入库。</p></div></div>}
  </div>;
}

function ReviewResolutionDialog({ review, snapshot, onClose, onEvidence, onResolve, onCreateMember }: {
  review: ReviewIssue;
  snapshot: DashboardSnapshot;
  onClose(): void;
  onEvidence(): void;
  onResolve(input: ResolveReviewInput): Promise<boolean>;
  onCreateMember(): void;
}) {
  const [personId, setPersonId] = useState(snapshot.persons[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState(review.candidateOptions);
  const [identityResolution, setIdentityResolution] = useState<'retry_review' | 'confirm_identity' | 'reassign_person' | 'archive_only' | null>(null);
  const [archiveConfirmed, setArchiveConfirmed] = useState(false);
  const [excludedLocalKeys, setExcludedLocalKeys] = useState<Set<string>>(() => new Set(
    review.candidateDiffs.filter((difference) => difference.fields.includes('issues')).map((difference) => difference.localKey)
  ));
  const isAssignment = review.kind === 'person_conflict' && review.personId === null;
  const isIdentityConfirmation = review.kind === 'person_conflict' && review.personId !== null && review.reportedName !== null;
  const isCommittedIdentityConflict = isIdentityConfirmation
    && review.reasonCodes.includes('COMMITTED_PERSON_IDENTITY_CONFLICT');
  const targetPerson = isIdentityConfirmation
    ? snapshot.persons.find((person) => person.id === review.personId) ?? null
    : null;
  const otherPeople = isIdentityConfirmation
    ? snapshot.persons.filter((person) => person.id !== review.personId)
    : [];
  const [reassignPersonId, setReassignPersonId] = useState('');
  const isDerived = review.kind === 'derived_safety';
  const isFieldConflict = review.kind === 'field_conflict';
  const isLegacyFieldReview = review.severity === 'blocking'
    && isFieldConflict
    && candidates.length > 0
    && (review.candidateDiffs.length === 0 || review.reasonCodes.includes('INDEPENDENT_REVIEW_MISMATCH'));
  const differenceByLocalKey = new Map(review.candidateDiffs.map((difference) => [difference.localKey, difference]));
  const visibleCandidates = candidates
    .map((candidate, index) => ({ candidate, index, difference: differenceByLocalKey.get(candidate.localKey) }))
    .filter((item) => item.difference);
  const hasVisibleConflicts = isFieldConflict && !isLegacyFieldReview && visibleCandidates.length > 0;
  const isAbnormalFlagOnlyReview = hasVisibleConflicts
    && review.candidateDiffs.every((difference) => difference.fields.length === 1 && difference.fields[0] === 'reportedAbnormalFlag');
  const canRetryAbnormalFlagReview = isAbnormalFlagOnlyReview
    && !review.reasonCodes.includes('ABNORMAL_FLAG_ADJUDICATION_UNCLEAR');
  const canRetryEvidenceBindingReview = hasVisibleConflicts
    && review.candidateDiffs.every((difference) => difference.fields.length === 1 && difference.fields[0] === 'issues');
  const canRetryModelReview = canRetryAbnormalFlagReview || canRetryEvidenceBindingReview;
  const resolvedCandidates = candidates.filter((candidate) => !excludedLocalKeys.has(candidate.localKey));
  const canCorrect = hasVisibleConflicts
    && resolvedCandidates.length > 0
    && review.candidateDiffs.every((difference) => difference.fields.includes('issues')
      ? excludedLocalKeys.has(difference.localKey)
      : !excludedLocalKeys.has(difference.localKey) || difference.fields.includes('presence'))
    && resolvedCandidates.every((candidate) => candidate.value.kind !== 'numeric' || /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(candidate.value.decimal));
  const updateCandidate = (index: number, updater: (candidate: (typeof candidates)[number]) => (typeof candidates)[number]) => {
    setCandidates((current) => current.map((candidate, candidateIndex) => candidateIndex === index ? updater(candidate) : candidate));
  };
  const canSubmit = !busy
    && (!isAssignment || Boolean(personId))
    && (!isIdentityConfirmation || (Boolean(targetPerson)
      && ((!isCommittedIdentityConflict && identityResolution === 'retry_review') || identityResolution === 'confirm_identity'
        || (!isCommittedIdentityConflict && identityResolution === 'reassign_person' && Boolean(reassignPersonId))
        || (identityResolution === 'archive_only' && archiveConfirmed))))
    && (!isFieldConflict || isLegacyFieldReview || canRetryModelReview || canCorrect);

  async function submitResolution() {
    setBusy(true);
    try {
      const resolution: ResolveReviewInput = isAssignment
        ? { action: 'assign_person', documentId: review.documentId, personId }
        : isIdentityConfirmation && targetPerson
          ? identityResolution === 'retry_review'
            ? { action: 'retry_review', issueId: review.id, documentId: review.documentId }
            : identityResolution === 'reassign_person'
            ? { action: 'reassign_person', issueId: review.id, documentId: review.documentId, personId: reassignPersonId }
            : identityResolution === 'archive_only'
              ? { action: 'archive_only', issueId: review.id, documentId: review.documentId }
              : { action: 'confirm_identity', issueId: review.id, documentId: review.documentId, personId: targetPerson.id }
          : isLegacyFieldReview || canRetryModelReview
            ? { action: 'retry_review', issueId: review.id, documentId: review.documentId }
          : canCorrect
            ? { action: 'accept_correction', issueId: review.id, documentId: review.documentId, candidates: resolvedCandidates }
            : { action: isDerived ? 'dismiss_derived' : 'archive_only', issueId: review.id, documentId: review.documentId };
      const ok = await onResolve(resolution);
      if (ok) onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="member-dialog review-resolution-dialog" role="dialog" aria-modal="true" aria-labelledby="review-resolution-title">
        <header>
          <div><span className="eyebrow">确认报告内容</span><h2 id="review-resolution-title">{review.title}</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="关闭例外核对"><X size={19} /></button>
        </header>
        <div className="review-resolution-scroll">
          <p className="review-resolution-intro">{review.description}</p>
          <button className="evidence-link" onClick={onEvidence}><FileCheck2 size={17} /> 查看原始依据</button>
          {isAssignment ? (
            <label>这份资料属于
              <select value={personId} onChange={(event) => setPersonId(event.target.value)}>
                {snapshot.persons.map((person) => <option key={person.id} value={person.id}>{person.displayName} · {person.relation}</option>)}
              </select>
            </label>
          ) : isIdentityConfirmation && targetPerson ? (
            <>
              <dl className="identity-confirmation">
                <div><dt>识别到的姓名</dt><dd>{review.reportedName}</dd></div>
                <div><dt>当前归属</dt><dd>{targetPerson.displayName}{targetPerson.relation ? ` · ${targetPerson.relation}` : ''}</dd></div>
              </dl>
              {isCommittedIdentityConflict && <div className="info-callout compact"><ShieldCheck size={18} /><div><strong>这份报告的已有结果暂不参与分析</strong><p>这份报告曾经入档，但重新核对时发现身份不一致。原始报告和检查结果仍保存在本机；确认属于这位成员后才恢复用于分析。</p></div></div>}
              <div className="identity-resolution-options" role="group" aria-label="选择这份报告的处理方式">
                {!isCommittedIdentityConflict && <button type="button" className={`identity-resolution-option${identityResolution === 'retry_review' ? ' is-active' : ''}`} aria-pressed={identityResolution === 'retry_review'} onClick={() => { setIdentityResolution('retry_review'); setArchiveConfirmed(false); }}>
                  <RefreshCw size={21} /><span><strong>姓名识别有误，重新核对</strong><small>如果图片写的是报告者、审核人或检验者，而不是受检者，让应用按身份字段重新识别。</small></span>{identityResolution === 'retry_review' && <Check size={20} />}
                </button>}
                <button type="button" className={`identity-resolution-option${identityResolution === 'confirm_identity' ? ' is-active' : ''}`} aria-pressed={identityResolution === 'confirm_identity'} onClick={() => { setIdentityResolution('confirm_identity'); setArchiveConfirmed(false); }}>
                  <ShieldCheck size={21} /><span><strong>是同一人</strong><small>{isCommittedIdentityConflict ? '将这份报告已有的检查结果恢复用于当前成员的健康解读，并继续整理其余项目。' : '报告姓名与当前成员指的是同一个人。确认后会继续整理这份报告。'}</small></span>{identityResolution === 'confirm_identity' && <Check size={20} />}
                </button>
                {!isCommittedIdentityConflict && <button type="button" className={`identity-resolution-option${identityResolution === 'reassign_person' ? ' is-active' : ''}`} aria-pressed={identityResolution === 'reassign_person'} onClick={() => { setIdentityResolution('reassign_person'); setReassignPersonId(''); setArchiveConfirmed(false); }}>
                  <UsersRound size={21} /><span><strong>属于另一位成员</strong><small>{otherPeople.length > 0 ? '从其他现有成员中选择正确归属。' : '目前没有其他可选成员，需要先创建成员。'}</small></span>{identityResolution === 'reassign_person' && <Check size={20} />}
                </button>}
                <button type="button" className={`identity-resolution-option${identityResolution === 'archive_only' ? ' is-active' : ''}`} aria-pressed={identityResolution === 'archive_only'} onClick={() => setIdentityResolution('archive_only')}>
                  <Archive size={21} /><span><strong>不纳入任何成员</strong><small>{isCommittedIdentityConflict ? '保留原始报告，已保存的检查结果不再用于当前成员分析；若属于其他人，请为正确成员重新添加并授权。' : '保留本机原始报告，但不将它加入任何家人的健康分析。'}</small></span>{identityResolution === 'archive_only' && <Check size={20} />}
                </button>
              </div>
              {identityResolution === 'retry_review' && <div className="info-callout compact"><RefreshCw size={18} /><div><strong>重新识别报告中的人物角色</strong><p>这不会确认两个人是同一人。应用会重新读取原始报告；如果报告确实写了另一位受检者，仍会暂停等待核对。</p></div></div>}
              {identityResolution === 'confirm_identity' && <div className="info-callout compact"><ShieldCheck size={18} /><div><strong>只确认这份报告的身份关系</strong><p>{isCommittedIdentityConflict ? '不会修改已保存的检查结果或成员名称。确认后恢复使用这份报告，并继续整理其余项目。' : '确认后，这份报告会继续归入当前成员的档案；成员名称不会改变。'}</p></div></div>}
              {identityResolution === 'reassign_person' && (otherPeople.length > 0 ? <>
                <label className="identity-resolution-select">选择另一位成员
                  <select aria-label="选择另一位成员" value={reassignPersonId} onChange={(event) => setReassignPersonId(event.target.value)}>
                    <option value="" disabled>请选择成员</option>
                    {otherPeople.map((person) => <option key={person.id} value={person.id}>{person.displayName}{person.relation ? ` · ${person.relation}` : ''}</option>)}
                  </select>
                </label>
                <div className="info-callout compact"><ShieldCheck size={18} /><div><strong>改归后不会自动继续发送</strong><p>资料会进入所选成员的待处理队列。你需要针对这位成员重新确认接收方、用途和资料范围，再开始处理。</p></div></div>
              </> : <div className="identity-resolution-empty">
                <div className="info-callout compact"><UsersRound size={18} /><div><strong>请先创建正确的家庭成员</strong><p>先填写这位家人的基本资料，再将报告归入对方的档案。</p></div></div>
                <button type="button" className="secondary-button" onClick={onCreateMember}><Plus size={17} /> 先创建成员</button>
              </div>)}
              {identityResolution === 'archive_only' && <>
                <div className="info-callout compact"><Archive size={18} /><div><strong>这份资料不会进入任何成员档案</strong><p>{isCommittedIdentityConflict ? '已有检查结果不再用于当前成员的健康解读，原始报告仍保留在本机。若属于其他成员，请为正确成员重新添加并授权。' : '这份报告不会加入成员档案或参与分析。此前已授权发送的内容不能通过此操作撤回。'}</p></div></div>
                <label className="identity-archive-confirm"><input type="checkbox" checked={archiveConfirmed} onChange={(event) => setArchiveConfirmed(event.target.checked)} /> 我确认不把这份资料纳入任何成员</label>
              </>}
            </>
          ) : isLegacyFieldReview ? (
            <div className="info-callout compact"><RefreshCw size={18} /><div><strong>不需要逐项检查这 {candidates.length} 项内容</strong><p>可先重新读取整份报告。只有仍看不清的项目或结果才会请你确认，其余内容会继续整理。</p></div></div>
          ) : hasVisibleConflicts ? (
            <>
              <div className="info-callout compact"><CircleHelp size={18} /><div><strong>{canRetryEvidenceBindingReview ? '不需要你逐项确认' : canRetryAbnormalFlagReview ? '可以重新读取报告符号' : isAbnormalFlagOnlyReview ? '需要确认报告符号的含义' : '为什么需要确认'}</strong><p>{canRetryEvidenceBindingReview ? '这些项目的日期或对应原文还不清楚。可先重新读取报告；只有仍不清楚的内容才会请你确认。' : canRetryAbnormalFlagReview ? '可重新读取符号所在的表头和说明，判断它表示前后变化还是结果异常。只有仍不清楚的内容才会请你确认。' : isAbnormalFlagOnlyReview ? '请查看符号所在的栏目。如果符号位于“趋势”列，下面保持空白；只有报告明确写出偏高、偏低、阳性或阴性时才填写。' : '这些项目读到了不同的可能结果。请对照原始报告确认正确内容，其余项目无需逐项检查。'}</p></div></div>
              <div className="manual-note-list review-difference-list">{visibleCandidates.map(({ candidate, index, difference }) => <article key={candidate.localKey}>
                <div className="review-difference-fields"><strong>需要确认的内容：</strong><span>{difference!.fields.map((field) => reviewDiffFieldLabels[field]).join('、')}</span></div>
                {difference!.firstCandidate !== undefined && difference!.secondCandidate !== undefined && <div className="review-reading-grid">
                  <section><span>可能结果一</span>{difference!.fields.map((field) => <div key={field}><small>{reviewDiffFieldLabels[field]}</small><strong>{reviewCandidateFieldValue(difference!.firstCandidate, field)}</strong></div>)}</section>
                  <section><span>可能结果二</span>{difference!.fields.map((field) => <div key={field}><small>{reviewDiffFieldLabels[field]}</small><strong>{reviewCandidateFieldValue(difference!.secondCandidate, field)}</strong></div>)}</section>
                </div>}
                <div className="review-final-choice"><strong>确认后的正确内容</strong><small>只需修改上方标出的差异字段</small></div>
                <ReviewDifferenceEditor
                  candidate={candidate}
                  fields={difference!.fields}
                  included={!excludedLocalKeys.has(candidate.localKey)}
                  onIncludedChange={(included) => setExcludedLocalKeys((current) => {
                    const next = new Set(current);
                    if (included) next.delete(candidate.localKey); else next.add(candidate.localKey);
                    return next;
                  })}
                  onChange={(updater) => updateCandidate(index, updater)}
                />
              </article>)}</div>
            </>
          ) : (
            <div className="info-callout compact"><ShieldCheck size={18} /><div><strong>{isDerived ? '报告结果会保留' : '原始资料会继续保留'}</strong><p>{isDerived ? '这次健康解读暂不采用，已有报告结果仍可查看。' : '选择仅归档后，这份资料不会进入趋势或后续分析。'}</p></div></div>
          )}
        </div>
        <div className="dialog-actions">
          <button className="secondary-button" onClick={onClose}>稍后处理</button>
          <button className="primary-button" disabled={!canSubmit} onClick={() => void submitResolution()}>
            {busy ? <LoaderCircle size={18} className="spin" /> : <Check size={18} />}
            {isAssignment ? '确认归属' : isIdentityConfirmation
              ? identityResolution === 'retry_review' ? '重新核对姓名'
                : identityResolution === 'confirm_identity' ? '确认是同一人'
                : identityResolution === 'reassign_person' ? '确认改归成员'
                  : identityResolution === 'archive_only' ? '确认不纳入'
                    : '请选择处理方式'
              : isLegacyFieldReview ? '重新读取报告' : canRetryEvidenceBindingReview ? '重新读取报告' : canRetryAbnormalFlagReview ? '重新读取符号' : canCorrect ? '保存修正并纳入' : isDerived ? '保留报告结果' : '仅归档这份资料'}
          </button>
        </div>
      </section>
    </div>
  );
}

function EvidencePanel({ evidence, demo, resultLimitations, onClose, onRetry }: { evidence: Evidence | null; demo: boolean; resultLimitations: ReviewIssue[]; onClose(): void; onRetry(): void }) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (evidence) closeButtonRef.current?.focus();
  }, [evidence]);
  if (!evidence) return null;
  const sourceLimitations = resultLimitations.filter((review) => review.documentId === evidence.documentId);
  return <aside className="evidence-panel" aria-label="证据侧栏" onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } }}>
    <header><div><span className="eyebrow">原始资料</span><h2>{evidence.title}</h2></div><button ref={closeButtonRef} className="icon-button" onClick={onClose} aria-label="关闭证据侧栏"><X size={19} /></button></header>
    <div className="evidence-preview">
      {sourceLimitations.length > 0 && <details className="analysis-boundaries"><summary>这份报告的读取完整性与历史说明</summary>{sourceLimitations.map((review) => <ReadingAuditDetails key={review.id} review={review} />)}</details>}
      {evidence.previewState === 'loading' ? <div className="table-empty" role="status"><LoaderCircle size={24} className="spin" /><strong>正在打开原始资料…</strong></div>
        : evidence.previewState === 'unavailable' ? <div className="table-empty" role="status"><FileText size={24} /><strong>暂时无法打开预览</strong><span>原始报告仍保存在本机，可稍后重试。</span><button className="secondary-button" onClick={onRetry}><RefreshCw size={17} /> 重试预览</button></div>
          : evidence.previewImageDataUrl ? <img src={evidence.previewImageDataUrl} alt={`${evidence.title}的原始资料预览`} />
            : <div className="evidence-page"><span>{demo ? '虚构资料摘录' : '原文摘录'}</span>{evidence.quote && <mark>{evidence.quote}</mark>}</div>}
    </div>
    <div className="evidence-meta"><StatusBadge tone="info">来源位置</StatusBadge><strong>{evidence.label}</strong>{evidence.meta && <p>{evidence.meta}</p>}</div>
  </aside>;
}

function WorkspaceDialog({ snapshot, onClose, onCreate, onSwitch }: {
  snapshot: DashboardSnapshot;
  onClose(): void;
  onCreate(input: { workspaceName: string; primaryMemberName: string; relation: string }): Promise<void>;
  onSwitch(mode: 'demo' | 'personal'): Promise<void>;
}) {
  const [workspaceName, setWorkspaceName] = useState('我的家庭健康档案');
  const [memberName, setMemberName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="workspace-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-dialog-title">
        <header>
          <div><span className="eyebrow">工作区</span><h2 id="workspace-dialog-title">选择要查看的档案</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="关闭工作区选择"><X size={19} /></button>
        </header>
        <button className={snapshot.workspaceMode === 'demo' ? 'workspace-choice is-active' : 'workspace-choice'} onClick={() => void onSwitch('demo')}>
          <span className="avatar avatar--small">演</span><span><strong>林家的健康档案</strong><small>纯虚构、离线可读，不会进入真实工作区</small></span>{snapshot.workspaceMode === 'demo' && <Check size={18} />}
        </button>
        <button className={snapshot.workspaceMode === 'personal' ? 'workspace-choice is-active' : 'workspace-choice'} onClick={() => void onSwitch('personal')}>
          <span className="avatar avatar--small">家</span><span><strong>我的个人工作区</strong><small>保存在这台电脑，与演示资料分开</small></span>{snapshot.workspaceMode === 'personal' && <Check size={18} />}
        </button>
        <div className="workspace-create">
          <div><span className="eyebrow">首次使用</span><h3>建立本机家庭档案</h3><p>现在只创建本地空间和第一位成员，不会登录或发送任何健康资料。</p></div>
          <label>档案名称<input value={workspaceName} maxLength={80} onChange={(event) => setWorkspaceName(event.target.value)} /></label>
          <label>第一位成员<input value={memberName} maxLength={80} onChange={(event) => setMemberName(event.target.value)} /></label>
          <button className="primary-button" disabled={submitting || !workspaceName.trim() || !memberName.trim()} onClick={async () => {
            setSubmitting(true);
            try { await onCreate({ workspaceName, primaryMemberName: memberName, relation: '本人' }); }
            finally { setSubmitting(false); }
          }}>{submitting ? <LoaderCircle size={18} className="spin" /> : <Plus size={18} />} 建立档案</button>
        </div>
      </section>
    </div>
  );
}

function MemberDialog({ onClose, onCreate }: {
  onClose(): void;
  onCreate(input: { displayName: string; relation: string; birthYear: number | null }): Promise<void>;
}) {
  const [displayName, setDisplayName] = useState('');
  const [relation, setRelation] = useState('家庭成员');
  const [birthYear, setBirthYear] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const parsedBirthYear = birthYear.trim() ? Number(birthYear) : null;
  const yearValid = parsedBirthYear === null || (Number.isInteger(parsedBirthYear) && parsedBirthYear >= 1900 && parsedBirthYear <= new Date().getFullYear());
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="member-dialog" role="dialog" aria-modal="true" aria-labelledby="member-dialog-title">
        <header><div><span className="eyebrow">家庭成员</span><h2 id="member-dialog-title">添加成员</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭添加成员"><X size={19} /></button></header>
        <p>填写家人的称呼和关系，之后可为这位家人添加报告。成员资料保存在本机。</p>
        <label>称呼<input autoFocus value={displayName} maxLength={80} onChange={(event) => setDisplayName(event.target.value)} placeholder="例如：妈妈" /></label>
        <label>与我的关系<input value={relation} maxLength={40} onChange={(event) => setRelation(event.target.value)} /></label>
        <label>出生年份（可选）<input inputMode="numeric" value={birthYear} onChange={(event) => setBirthYear(event.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="例如：1962" /></label>
        {!yearValid && <span className="field-error">请输入 1900 年至今年之间的年份。</span>}
        <div className="dialog-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={submitting || !displayName.trim() || !relation.trim() || !yearValid} onClick={async () => {
          setSubmitting(true);
          try { await onCreate({ displayName, relation, birthYear: parsedBirthYear }); }
          finally { setSubmitting(false); }
        }}>{submitting ? <LoaderCircle size={18} className="spin" /> : <Plus size={18} />} 添加成员</button></div>
      </section>
    </div>
  );
}

function MemberEditDialog({ person, onClose, onSave, onArchive }: {
  person: PersonSummary;
  onClose(): void;
  onSave(input: UpdatePersonDisplayInput): Promise<boolean>;
  onArchive(): void;
}) {
  const [displayName, setDisplayName] = useState(person.displayName);
  const [relation, setRelation] = useState(person.relation);
  const [birthYear, setBirthYear] = useState(person.birthYear?.toString() ?? '');
  const [submitting, setSubmitting] = useState(false);
  const parsedBirthYear = birthYear.trim() ? Number(birthYear) : null;
  const yearValid = parsedBirthYear === null || (Number.isInteger(parsedBirthYear) && parsedBirthYear >= 1900 && parsedBirthYear <= new Date().getFullYear());
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="member-dialog" role="dialog" aria-modal="true" aria-labelledby="member-edit-title"><header><div><span className="eyebrow">成员档案</span><h2 id="member-edit-title">编辑显示资料</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭成员编辑"><X size={19} /></button></header><p>称呼和关系只改变显示。如果修改出生年份，已有检查结果不变，需要用到年龄的健康解读会更新。</p><label>称呼<input autoFocus value={displayName} maxLength={80} onChange={(event) => setDisplayName(event.target.value)} /></label><label>与我的关系<input value={relation} maxLength={40} onChange={(event) => setRelation(event.target.value)} /></label><label>出生年份（可选）<input inputMode="numeric" value={birthYear} onChange={(event) => setBirthYear(event.target.value.replace(/\D/g, '').slice(0, 4))} /></label>{!yearValid && <span className="field-error">请输入 1900 年至今年之间的年份。</span>}<div className="info-callout compact"><Archive size={18} /><div><strong>不再日常查看？可以归档</strong><p>归档会隐藏成员并撤回其目录授权，但不会删除报告、检查结果、后续事项或历史版本，之后可以恢复。</p></div></div><div className="dialog-actions"><button className="secondary-button" onClick={onArchive}><Archive size={17} /> 归档成员</button><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={submitting || !displayName.trim() || !relation.trim() || !yearValid} onClick={async () => { setSubmitting(true); try { if (await onSave({ personId: person.id, displayName, relation, birthYear: parsedBirthYear, expectedDisplayRevision: person.displayRevision })) onClose(); } finally { setSubmitting(false); } }}>{submitting ? <LoaderCircle size={18} className="spin" /> : <Check size={18} />} 保存显示资料</button></div></section></div>;
}

function ArchivePersonDialog({ person, onClose, onConfirm }: {
  person: PersonSummary;
  onClose(): void;
  onConfirm(): Promise<boolean>;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="member-dialog" role="dialog" aria-modal="true" aria-labelledby="archive-person-title"><header><div><span className="eyebrow">可撤销操作</span><h2 id="archive-person-title">归档 {person.displayName}？</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭归档成员确认"><X size={19} /></button></header><p>归档后，这位成员会从家庭总览和日常处理范围中隐藏。</p><div className="privacy-sections"><article><span className="settings-icon"><ShieldCheck size={19} /></span><div><strong>会撤回后续处理授权</strong><p>该成员的收件箱目录会停用，对应的日程 AI 授权会撤回；正在运行的任务必须先结束或停止。</p></div></article><article><span className="settings-icon"><Archive size={19} /></span><div><strong>不会删除历史资料</strong><p>原始报告、检查结果、本人补充和后续事项都会保留，恢复成员后可再次查看。</p></div></article></div><label className="check-label"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> 我了解归档范围，并确认归档这位成员</label><div className="dialog-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!confirmed || busy} onClick={async () => { setBusy(true); try { if (await onConfirm()) onClose(); } finally { setBusy(false); } }}>{busy ? <LoaderCircle size={18} className="spin" /> : <Archive size={18} />} 确认归档</button></div></section></div>;
}

function ArchivedPeopleDialog({ onClose, onRestore, onNotice }: {
  onClose(): void;
  onRestore(person: Person): Promise<boolean>;
  onNotice(message: string): void;
}) {
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void window.healthDesktop?.listArchivedPeople().then((result) => {
      if (!active) return;
      if (result.ok) setPeople(result.data);
      else onNotice('无法读取已归档成员，请稍后重试。');
      setLoading(false);
    });
    return () => { active = false; };
  }, [onNotice]);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="workspace-dialog" role="dialog" aria-modal="true" aria-labelledby="archived-people-title"><header><div><span className="eyebrow">成员档案</span><h2 id="archived-people-title">已归档成员</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭已归档成员"><X size={19} /></button></header><p>恢复只会让成员重新显示；此前撤回的目录和 AI 授权不会自动恢复，需要你重新确认。</p>{loading ? <div className="table-empty"><LoaderCircle size={24} className="spin" /><strong>正在读取本机档案</strong></div> : people.length === 0 ? <div className="table-empty"><Archive size={24} /><strong>没有已归档成员</strong><span>归档成员后会显示在这里。</span></div> : <div className="action-list">{people.map((person) => <div className="action-row" key={person.id}><span className="avatar avatar--small">{Array.from(person.displayName)[0] ?? '家'}</span><div className="action-row__body"><strong>{person.displayName}</strong><small>{person.relation ?? '家庭成员'}{person.birthYear ? ` · ${person.birthYear} 年出生` : ''} · 归档于 {person.archivedAt ? formatDateTime(person.archivedAt) : '未知时间'}</small></div><button className="secondary-button" disabled={restoringId !== null} onClick={async () => { setRestoringId(person.id); try { if (await onRestore(person)) setPeople((current) => current.filter((item) => item.id !== person.id)); } finally { setRestoringId(null); } }}>{restoringId === person.id ? <LoaderCircle size={17} className="spin" /> : <RefreshCw size={17} />} 恢复显示</button></div>)}</div>}<div className="dialog-actions"><button className="primary-button" onClick={onClose}>完成</button></div></section></div>;
}

function ExcludeDocumentDialog({ document, onClose, onConfirm }: {
  document: InboxItem;
  onClose(): void;
  onConfirm(): Promise<boolean>;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="member-dialog" role="dialog" aria-modal="true" aria-labelledby="exclude-document-title"><header><div><span className="eyebrow">资料范围</span><h2 id="exclude-document-title">将这份资料移出分析？</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭移出资料确认"><X size={19} /></button></header><p><strong>{document.displayName}</strong> 将不再进入趋势、身体视图或后续 AI 处理。</p><div className="privacy-sections"><article><span className="settings-icon"><Archive size={19} /></span><div><strong>立即停止作为健康依据</strong><p>相关健康解读将需要更新；如有未完成的处理，需要先停止或等待完成。</p></div></article><article><span className="settings-icon"><ShieldCheck size={19} /></span><div><strong>原始报告仍保存在本机</strong><p>原始报告和之前的备份仍可能保留这份资料。即使原文件仍在收件箱，也不会自动重复添加；需要时可以“重新纳入”。</p></div></article></div><label className="check-label"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> 我了解这不是清除所有历史副本，并确认移出分析</label><div className="dialog-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!confirmed || busy} onClick={async () => { setBusy(true); try { if (await onConfirm()) onClose(); } finally { setBusy(false); } }}>{busy ? <LoaderCircle size={18} className="spin" /> : <Archive size={18} />} 确认移出</button></div></section></div>;
}

function DeleteDocumentDialog({ document, onClose, onConfirm }: {
  document: InboxItem;
  onClose(): void;
  onConfirm(): Promise<boolean>;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [acknowledgedCopies, setAcknowledgedCopies] = useState(false);
  const [busy, setBusy] = useState(false);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="member-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-document-title"><header><div><span className="eyebrow">删除本机档案</span><h2 id="delete-document-title">删除这份本机档案？</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭删除资料确认"><X size={19} /></button></header><p><strong>{document.displayName}</strong> 会从当前工作区删除。若你还需要副本，请先取消并导出成员摘要或创建加密备份。</p><div className="privacy-sections"><article><span className="settings-icon"><Trash2 size={19} /></span><div><strong>会删除这份报告及相关健康结果</strong><p>这份报告、对应检查结果、健康解读和它们的历史版本会从当前档案移除。为了不留下对已删除报告的引用，该成员全部旧版 AI 综合及由它采纳的后续事项也会从当前工作区清除；你自己创建的事项保留。未完成任务必须先安全停止。</p></div></article><article><span className="settings-icon"><ShieldCheck size={19} /></span><div><strong>不会承诺擦除所有历史副本</strong><p>应用会记住这份资料已被删除，避免自动从收件箱再次添加。既有本机恢复点、你导出的加密备份、系统备份或云盘副本仍可能包含旧资料。</p></div></article></div><label className="check-label"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> 我确认删除报告、该成员旧 AI 综合及其采纳的后续事项</label><label className="check-label"><input type="checkbox" checked={acknowledgedCopies} onChange={(event) => setAcknowledgedCopies(event.target.checked)} /> 我了解恢复点或外部备份仍可能保留旧资料</label><div className="dialog-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button danger-button" disabled={!confirmed || !acknowledgedCopies || busy} onClick={async () => { setBusy(true); try { if (await onConfirm()) onClose(); } finally { setBusy(false); } }}>{busy ? <LoaderCircle size={18} className="spin" /> : <Trash2 size={18} />} 确认删除</button></div></section></div>;
}

function DeletedDocumentsDialog({ onClose, onNotice }: { onClose(): void; onNotice(message: string): void }) {
  const [items, setItems] = useState<DeletedDocumentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [releasingHash, setReleasingHash] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void window.healthDesktop?.listDeletedDocuments().then((result) => {
      if (!active) return;
      if (result.ok) setItems(result.data);
      else onNotice('无法读取已删除资料记录，请稍后重试。');
      setLoading(false);
    });
    return () => { active = false; };
  }, [onNotice]);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="workspace-dialog" role="dialog" aria-modal="true" aria-labelledby="deleted-documents-title"><header><div><span className="eyebrow">已删除的报告</span><h2 id="deleted-documents-title">已删除资料</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭已删除资料"><X size={19} /></button></header><p>“重新允许导入”后，你可以再次选择原文件添加。已删除的内容不会自动恢复。</p>{loading ? <div className="table-empty"><LoaderCircle size={24} className="spin" /><strong>正在读取本机记录</strong></div> : items.length === 0 ? <div className="table-empty"><Trash2 size={24} /><strong>没有已删除资料记录</strong><span>这里会列出已删除的报告，避免它们被自动再次添加。</span></div> : <div className="action-list">{items.map((item) => <div className="action-row" key={item.sourceHash}><span className="file-icon"><FileText size={18} /></span><div className="action-row__body"><strong>{item.displayName}</strong><small>删除于 {formatDateTime(item.deletedAt)}{item.rawObjectRetained ? ' · 原始文件仍由其他档案或备份保留' : ' · 当前档案中已无原始文件'}</small></div><button className="secondary-button" disabled={releasingHash !== null} onClick={async () => { setReleasingHash(item.sourceHash); try { const result = await window.healthDesktop?.releaseDeletedDocument(item.sourceHash); if (result?.ok) { setItems((current) => current.filter((entry) => entry.sourceHash !== item.sourceHash)); onNotice('已重新允许导入；已删除内容没有自动恢复，请重新选择原文件。'); } else onNotice('暂时无法重新允许导入，请稍后重试。'); } finally { setReleasingHash(null); } }}>{releasingHash === item.sourceHash ? <LoaderCircle size={17} className="spin" /> : <RefreshCw size={17} />} 重新允许导入</button></div>)}</div>}<div className="dialog-actions"><button className="primary-button" onClick={onClose}>完成</button></div></section></div>;
}

function InboxDirectoriesDialog({ snapshot, onClose, onNotice }: {
  snapshot: DashboardSnapshot;
  onClose(): void;
  onNotice(message: string): void;
}) {
  const [bindings, setBindings] = useState<InboxBindingSummary[]>([]);
  const [selection, setSelection] = useState<{ selectionId: string; displayName: string } | null>(null);
  const [personId, setPersonId] = useState<string | null>(snapshot.persons[0]?.id ?? null);
  const [recursive, setRecursive] = useState(true);
  const [allowAi, setAllowAi] = useState(false);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const result = await window.healthDesktop?.listInboxDirectories();
    if (result?.ok) setBindings(result.data);
  }

  useEffect(() => {
    let active = true;
    void window.healthDesktop?.listInboxDirectories().then((result) => {
      if (active && result.ok) setBindings(result.data);
    });
    return () => { active = false; };
  }, []);

  async function pickDirectory() {
    if (!window.healthDesktop) return;
    const result = await window.healthDesktop.pickInboxDirectory();
    if (!result.ok) {
      onNotice(result.error.code === 'INBOX_OVERLAPS_FORBIDDEN_ROOT'
        ? '这个目录与应用数据或程序目录重叠，请选择单独的报告目录。'
        : '无法使用这个目录，请换一个本机目录。');
      return;
    }
    if (result.data) setSelection(result.data);
  }

  async function confirmDirectory() {
    if (!window.healthDesktop || !selection) return;
    setBusy(true);
    try {
      const result = await window.healthDesktop.confirmInboxDirectory({
        selectionId: selection.selectionId,
        personId,
        recursive,
        allowScheduledAiProcessing: allowAi,
        consentVersion: 1,
        confirmedDataRecipient: 'OpenAI/Codex'
      });
      if (!result.ok) {
        onNotice(result.error.code === 'ACCOUNT_REQUIRED_FOR_AI_CONSENT'
          ? '要允许自动 AI 处理，请先连接 Codex；也可以先只启用本地收件箱。'
          : '保存目录设置失败，请重新选择目录。');
        return;
      }
      setSelection(null);
      setAllowAi(false);
      await refresh();
      onNotice(result.data.aiProcessingAuthorized
        ? '收件箱已启用；新资料稳定后会先导入本机，并按此授权进入日程处理。'
        : '收件箱已启用；新资料只会导入本机，不会自动发送给 AI。');
    } finally {
      setBusy(false);
    }
  }

  async function disableDirectory(bindingId: string) {
    const result = await window.healthDesktop?.disableInboxDirectory(bindingId);
    if (result?.ok) {
      await refresh();
      onNotice('已停止监控该目录，并撤回它对应的自动处理授权。');
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="workspace-dialog inbox-directory-dialog" role="dialog" aria-modal="true" aria-labelledby="inbox-directory-title">
        <header><div><span className="eyebrow">报告收件箱</span><h2 id="inbox-directory-title">管理本机目录</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭报告收件箱设置"><X size={19} /></button></header>
        <p className="dialog-intro">应用只监控你明确选择的目录。导入本机和发送给 AI 是两项独立授权。</p>
        <div className="binding-list">
          {bindings.filter((binding) => binding.enabled).map((binding) => (
            <div className="binding-row" key={binding.id}>
              <span className="settings-icon"><FolderHeart size={18} /></span>
              <span><strong>{binding.displayName}</strong><small>{binding.personLabel ?? '公共待归属'} · {binding.recursive ? '包含子目录' : '仅当前目录'} · {binding.aiProcessingAuthorized ? '允许日程 AI 处理' : '仅导入本机'}</small></span>
              <button className="text-button" onClick={() => void disableDirectory(binding.id)}>停用</button>
            </div>
          ))}
          {bindings.every((binding) => !binding.enabled) && <div className="binding-empty"><FolderHeart size={22} /><span>尚未指定报告目录</span></div>}
        </div>
        {!selection ? (
          <button className="secondary-button" onClick={() => void pickDirectory()}><Plus size={17} /> 选择本机目录</button>
        ) : (
          <div className="directory-consent">
            <div><span className="eyebrow">待添加目录</span><h3>{selection.displayName}</h3></div>
            <label>资料默认归属<select value={personId ?? ''} onChange={(event) => setPersonId(event.target.value || null)}><option value="">公共待归属</option>{snapshot.persons.map((person) => <option key={person.id} value={person.id}>{person.displayName} · {person.relation}</option>)}</select></label>
            <label className="check-label"><input type="checkbox" checked={recursive} onChange={(event) => setRecursive(event.target.checked)} /> 包含子目录中的资料</label>
            <label className="check-label"><input type="checkbox" checked={allowAi} disabled={snapshot.account.status !== 'connected'} onChange={(event) => setAllowAi(event.target.checked)} /> 允许日程任务把必要内容发送给 OpenAI/Codex 处理</label>
            {snapshot.account.status === 'connected' && <p>联网搜索可能误带入健康信息，应用目前无法在发送前阻止。启用 AI 处理前，请确认你接受这项风险。</p>}
            <p>{snapshot.account.status === 'connected' ? '这项授权绑定当前 Codex 账户、所选目录和成员；综合分析会带入该成员已有的相关检查结果和必要的本人补充，并可能使用内置 Web Search。应用要求只搜索通用医学问题，但目前无法在发送前逐条检查真实搜索词；停用目录会撤回后续授权。' : '当前未连接 Codex，因此只能先启用本地导入。连接后可重新授权自动处理。'}</p>
            <div className="dialog-actions"><button className="secondary-button" onClick={() => setSelection(null)}>取消</button><button className="primary-button" disabled={busy} onClick={() => void confirmDirectory()}>{busy ? <LoaderCircle size={18} className="spin" /> : <Check size={18} />} 确认启用</button></div>
          </div>
        )}
      </section>
    </div>
  );
}

type ProcessConsentResult = boolean | 'assessment_scope_changed';
type ProcessConsentDialogProps = {
  snapshot: DashboardSnapshot;
  documentIds: string[] | null;
  assessmentPersonId?: string;
  onClose(): void;
  onConfirm(documentIds?: string[], assessmentPersonId?: string, expectedAssessmentDataRevision?: string, readingScope?: 'unresolved_pages'): Promise<ProcessConsentResult>;
  onLogin(): void;
};

export function ProcessConsentDialog(props: ProcessConsentDialogProps) {
  // 确认窗的入口和目标在打开时固定；后台更新或其他入口不能把本次成员综合改成报告处理。
  const [request] = useState(() => props.assessmentPersonId === undefined
    ? { kind: 'documents' as const, documentIds: props.documentIds }
    : { kind: 'assessment' as const, personId: props.assessmentPersonId, conflictingScope: props.documentIds !== null });
  return request.kind === 'assessment'
    ? <AssessmentProcessConsentDialog {...props} personId={request.personId} conflictingScope={request.conflictingScope} />
    : <DocumentProcessConsentDialog {...props} documentIds={request.documentIds} />;
}

function AssessmentProcessConsentDialog({ snapshot, personId, conflictingScope, onClose, onConfirm, onLogin }: ProcessConsentDialogProps & {
  personId: string;
  conflictingScope: boolean;
}) {
  const [target] = useState(() => {
    const person = snapshot.persons.find((member) => member.id === personId);
    return { personId, personLabel: person?.displayName ?? '无法确认的成员',
      valid: !conflictingScope && personId.length > 0 && !/\s/u.test(personId) && Boolean(person?.displayName.trim())
        && (person?.acceptedFactCount ?? 0) > 0 && /^[a-f0-9]{64}$/.test(person?.dataRevision ?? '') && snapshot.workspaceMode === 'personal',
      workspaceMode: snapshot.workspaceMode, workspaceName: snapshot.workspaceName };
  });
  const person = snapshot.persons.find((member) => member.id === target.personId);
  const memberJobActive = snapshot.jobs.some((job) => job.personLabel === target.personLabel
    && ['queued', 'running', 'waiting_auth', 'waiting_quota', 'waiting_user', 'retry_wait'].includes(job.status));
  const validTarget = target.valid && Boolean(person?.displayName.trim()) && (person?.acceptedFactCount ?? 0) > 0
    && /^[a-f0-9]{64}$/.test(person?.dataRevision ?? '')
    && target.workspaceMode === snapshot.workspaceMode && target.workspaceName === snapshot.workspaceName && !memberJobActive;
  const scopeSignature = JSON.stringify({ personId: target.personId, validTarget,
    dataRevision: person?.dataRevision, clinicalContextRevision: person?.clinicalContextRevision,
    displayName: person?.displayName, accountStatus: snapshot.account.status, accountLabel: snapshot.account.displayLabel });
  const [confirmedScope, setConfirmedScope] = useState<{ signature: string; dataRevision: string } | null>(null);
  const [previousScopeSignature, setPreviousScopeSignature] = useState(scopeSignature);
  const [busy, setBusy] = useState(false);
  const [submissionError, setSubmissionError] = useState(false);
  const [rejectedRevision, setRejectedRevision] = useState<string | null>(null);
  const submissionPending = useRef(false);
  if (previousScopeSignature !== scopeSignature) {
    setPreviousScopeSignature(scopeSignature);
    if (confirmedScope !== null) setConfirmedScope(null);
  }
  const confirmed = confirmedScope?.signature === scopeSignature;
  const awaitingFreshSnapshot = rejectedRevision !== null && person?.dataRevision === rejectedRevision;
  const connected = snapshot.account.status === 'connected';
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }}>
    <section className="member-dialog process-consent-dialog" role="dialog" aria-modal="true" aria-busy={busy} aria-labelledby="process-consent-title">
      <header><div><span className="eyebrow">仅更新成员综合</span><h2 id="process-consent-title">确认发送范围</h2></div><button className="icon-button" style={{ minWidth: 44, minHeight: 44 }} disabled={busy} onClick={onClose} aria-label="关闭处理确认"><X size={19} /></button></header>
      <p style={{ fontSize: 16 }}>本次仅为 <strong>{target.personLabel}</strong> 更新健康解读和日常建议。</p>
      <p style={{ fontSize: 16 }}>将使用这位成员<strong>已经保存的检查事实、必要的报告原句和本人补充</strong>，发送给 <strong>OpenAI/Codex</strong> 生成综合说明。</p>
      <p style={{ fontSize: 16 }}>本次不处理新资料。已完成的报告不会重新上传或提取，也不会重新读取原文件；不读取新报告，不处理其他成员。</p>
      {memberJobActive ? <p role="alert" style={{ fontSize: 16 }}>这位成员已有处理任务，完成后可再更新健康解读；本次不会重复建立任务。</p>
        : !validTarget && <p role="alert" style={{ fontSize: 16 }}>无法核验原先选择的成员或其已有检查事实，不能开始。请取消后重新打开；不会改为处理其他成员或全部资料。</p>}
      <p style={{ fontSize: 16 }}>综合分析可能联网搜索。健康信息可能被误带入搜索查询，应用目前无法在发送前阻止；授权前请确认你接受这项风险。</p>
      <div className="consent-facts" style={{ fontSize: 16 }}><span><ShieldCheck size={17} /> 仅使用上述成员已有的资料</span><span><FileCheck2 size={17} /> 收件箱中的待处理报告不在本次范围</span><span><FileCheck2 size={17} /> 报告结果与健康解读分别保存</span><span><Sparkles size={17} /> 使用当前 Codex 账户额度，额度规则可能变化</span></div>
      <label className="check-label" style={{ fontSize: 16 }}><input type="checkbox" checked={confirmed} disabled={busy || !validTarget || awaitingFreshSnapshot}
        onChange={(event) => {
          setConfirmedScope(event.target.checked && validTarget && !awaitingFreshSnapshot && person
            ? { signature: scopeSignature, dataRevision: person.dataRevision } : null);
          setSubmissionError(false);
          if (!awaitingFreshSnapshot) setRejectedRevision(null);
        }} /> 我确认本次接收方、用途和资料范围</label>
      {!connected && <div className="info-callout compact"><ShieldCheck size={18} /><div><strong>Codex 尚未连接</strong><p>先完成官方登录，才会建立本次处理授权和任务。</p></div></div>}
      {submissionError && <p className="form-error" role="alert">暂时无法建立这位成员的综合任务。可以重试，或取消后重新打开。</p>}
      {rejectedRevision !== null && <p className="form-error" role="alert">这位成员的已有资料已变化，本次授权已撤回。{awaitingFreshSnapshot ? '请等待档案刷新，或取消后重新打开，再确认当前资料。' : '请重新确认当前资料后再开始。'}</p>}
      <div className="dialog-actions"><button className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
        {!connected ? <button className="primary-button" onClick={onLogin}>连接 Codex</button> : <button className="primary-button" disabled={!confirmed || busy || !validTarget || awaitingFreshSnapshot} onClick={async () => {
          if (submissionPending.current || !confirmed || !validTarget || awaitingFreshSnapshot || !confirmedScope) return;
          const confirmedRevision = confirmedScope.dataRevision;
          submissionPending.current = true;
          setBusy(true);
          setSubmissionError(false);
          try {
            const result = await onConfirm(undefined, target.personId, confirmedRevision);
            if (result === true) onClose();
            else if (result === 'assessment_scope_changed') {
              setConfirmedScope(null);
              setRejectedRevision(confirmedRevision);
            } else setSubmissionError(true);
          } catch { setSubmissionError(true); }
          finally { submissionPending.current = false; setBusy(false); }
        }}>{busy ? <LoaderCircle size={18} className="spin" /> : <Play size={18} />} 授权并开始</button>}
      </div>
    </section>
  </div>;
}

function DocumentProcessConsentDialog({ snapshot, documentIds, onClose, onConfirm, onLogin }: ProcessConsentDialogProps) {
  const [supplementOnly, setSupplementOnly] = useState(false);
  // 只捕获这次入口已经明确给出的成员与资料；后续快照变化不能把新资料扩进授权集合。
  const [initialScope] = useState(() => {
    if (documentIds === null) return null;
    const scope = manualProcessingScope(snapshot, documentIds);
    const eligible = new Map([...scope.readyDocuments, ...scope.repairDocuments].map((document) => [document.id, document]));
    const requested = [...new Set(documentIds)];
    const documents = requested.flatMap((id) => {
      const document = eligible.get(id);
      const person = snapshot.persons.find((member) => member.id === document?.personId);
      return document?.displayName.trim() && person ? [{ id: document.id, personId: person.id,
        displayName: document.displayName, personLabel: person.displayName }] : [];
    });
    return { hasRepairDocuments: scope.repairDocuments.length > 0, documents,
      requestedDocumentCount: requested.length, unresolvedDocumentCount: requested.length - documents.length };
  });
  const [selectedDocumentIds, setSelectedDocumentIds] = useState(() => initialScope?.documents.map((document) => document.id) ?? []);
  const [confirmedScope, setConfirmedScope] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submissionPending = useRef(false);
  const initialIds = initialScope?.documents.map((document) => document.id) ?? null;
  const availableScope = manualProcessingScope(snapshot, initialIds);
  const availableDocuments = new Map([...availableScope.readyDocuments, ...availableScope.repairDocuments]
    .filter((document) => !initialScope || initialScope.documents.some((initial) => initial.id === document.id
      && initial.personId === document.personId && document.displayName.trim()
      && snapshot.persons.some((person) => person.id === document.personId))).map((document) => [document.id, document]));
  const selectedScope = initialScope === null ? null : initialScope.documents
    .filter((document) => selectedDocumentIds.includes(document.id) && availableDocuments.has(document.id)).map((document) => document.id);
  const { readyDocuments, repairDocuments, refreshPersons } = manualProcessingScope(snapshot, selectedScope);
  const readyCount = readyDocuments.length;
  const repairCount = repairDocuments.length;
  const repairPersonLabels = [...new Set(repairDocuments.map((document) => document.personLabel)
    .filter((label): label is string => label !== null))];
  const derivedRefreshCount = refreshPersons.length;
  const processingCount = readyCount + repairCount + derivedRefreshCount;
  const unresolvedScope = (initialScope?.unresolvedDocumentCount ?? 0) > 0;
  // 授权绑定实际发送集合，快照中归属或可处理范围变化也会立即使旧勾选失效。
  const supplementAvailable = repairCount > 0 && readyCount === 0 && derivedRefreshCount === 0
    && repairDocuments.every(document => (document.acceptedFactCount ?? 0) > 0
      && snapshot.reviews.some(review => review.documentId === document.id && review.readingAudit
        && review.resolutionStatus === 'open'));
  const scopedSupplement = supplementAvailable && supplementOnly;
  const scopeSignature = JSON.stringify({ selectedScope, scopedSupplement,
    ready: readyDocuments.map((document) => [document.id, document.personId]).sort(([left], [right]) => left!.localeCompare(right!)),
    repairs: repairDocuments.map((document) => [document.id, document.personId, document.displayName,
      snapshot.persons.find((person) => person.id === document.personId)?.dataRevision,
      snapshot.reviews.filter((review) => review.documentId === document.id && review.resolutionStatus === 'open')])
      .sort(([left], [right]) => String(left).localeCompare(String(right))),
    refreshPersons: refreshPersons.map((person) => person.id).sort() });
  const [previousScopeSignature, setPreviousScopeSignature] = useState(scopeSignature);
  if (previousScopeSignature !== scopeSignature) {
    // 同组件在提交渲染前调整授权；归属改回也不能复活旧勾选，轮询的新对象引用不影响选择。
    setPreviousScopeSignature(scopeSignature);
    if (confirmedScope !== null) setConfirmedScope(null);
  }
  const confirmed = confirmedScope === scopeSignature;
  const connected = snapshot.account.status === 'connected';
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }}>
      <section className="member-dialog process-consent-dialog" role="dialog" aria-modal="true" aria-busy={busy} aria-labelledby="process-consent-title">
        <header><div><span className="eyebrow">本次手动处理</span><h2 id="process-consent-title">确认发送范围</h2></div><button className="icon-button" style={{ minWidth: 44, minHeight: 44 }} disabled={busy} onClick={onClose} aria-label="关闭处理确认"><X size={19} /></button></header>
        {unresolvedScope && <p role="alert" style={{ fontSize: 16 }}>本次有 {initialScope!.unresolvedDocumentCount} 份资料无法核验文件、成员或可处理范围，不能开始。请取消后重新选择；不会改为处理全部资料。</p>}
        {initialScope?.hasRepairDocuments && <div className="rebuild-body" role="group" aria-label="选择本次重新核对的报告">
          <div className="rebuild-boundary">
            <h3>选择本次重新核对的报告</h3>
            <p role="status">已选择 {selectedScope?.length ?? 0} / {initialScope.requestedDocumentCount} 份。</p>
            <p>取消勾选只跳过本次重核，不删除原件，也不改变资料归属或分析范围。</p>
            {initialScope.documents.map((document) => {
              const available = availableDocuments.has(document.id);
              return <label className="check-label" key={document.id}>
                <input type="checkbox" aria-label={`选择重新核对报告：${document.displayName}`}
                  disabled={busy || !available} checked={available && selectedDocumentIds.includes(document.id)}
                  onChange={() => {
                    if (busy || !available) return;
                    setSelectedDocumentIds((current) => current.includes(document.id)
                      ? current.filter((id) => id !== document.id) : [...current, document.id]);
                    setConfirmedScope(null);
                  }} />
                <span><strong>{document.displayName}</strong><br />{document.personLabel ?? '已归属成员'}{!available && ' · 当前不在可处理范围'}</span>
              </label>;
            })}
          </div>
        </div>}
        {repairCount > 0 && <p style={{ fontSize: 16 }}>本次成员：{repairPersonLabels.join('、') || '已归属成员'}。</p>}
        {supplementAvailable && <label className="check-label" style={{ minHeight: 44, fontSize: 16 }}>
          <input type="checkbox" checked={supplementOnly} disabled={busy} onChange={event => { setSupplementOnly(event.target.checked); setConfirmedScope(null); }} />
          只补读问题页（保留其他页结果）
        </label>}
        {repairCount > 0 ? <p style={{ fontSize: 16 }}>将重新核对 {repairCount} 份有待核实内容或日期对应的报告。{scopedSupplement ? '应用只发送现有问题引用所对应的完整原页；无法确定问题页时会停止，不会自动改成整份重读。' : '应用会重读整份报告；'}原始报告的必要内容可能再次发送给 <strong>OpenAI/Codex</strong>。已有报告结果会保留，确认清楚的新内容会补充到档案。成员综合会复用<strong>该成员已有的相关检查结果和必要的本人补充</strong>，原始资料仍保存在本机。</p> : <p style={{ fontSize: 16 }}>{readyCount > 0 ? `将处理 ${readyCount} 份${documentIds ? '选中的' : ''}已归属新资料` : '本次不处理新资料'}{derivedRefreshCount > 0 ? `，并为 ${refreshPersons.map((person) => person.displayName).join('、')}刷新综合说明` : ''}。{readyCount === 0 ? '已完成的报告不会重新上传或提取；' : '新资料会先提取；'}成员综合会复用<strong>该成员已有的相关检查结果和必要的本人补充</strong>。这些必要内容会发送给 <strong>OpenAI/Codex</strong>，原始资料仍保存在本机。</p>}
        <p style={{ fontSize: 16 }}>综合分析可能联网搜索。健康信息可能被误带入搜索查询，应用目前无法在发送前阻止；授权前请确认你接受这项风险。</p>
        <div className="consent-facts" style={{ fontSize: 16 }}><span><ShieldCheck size={17} /> 不发送未归属资料或本次范围外的成员资料</span><span><FileCheck2 size={17} /> 历史检查结果只使用上述成员的资料</span><span><FileCheck2 size={17} /> 报告结果与健康解读分别保存</span><span><Sparkles size={17} /> 使用当前 Codex 账户额度，额度规则可能变化</span></div>
        <label className="check-label" style={{ fontSize: 16 }}><input type="checkbox" checked={confirmed} disabled={busy || processingCount === 0 || unresolvedScope}
          onChange={(event) => setConfirmedScope(event.target.checked ? scopeSignature : null)} /> 我确认本次接收方、用途和资料范围</label>
        {!connected && <div className="info-callout compact"><ShieldCheck size={18} /><div><strong>Codex 尚未连接</strong><p>先完成官方登录，才会建立本次处理授权和任务。</p></div></div>}
        <div className="dialog-actions">
          <button className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
          {!connected ? <button className="primary-button" onClick={onLogin}>连接 Codex</button> : <button className="primary-button" disabled={!confirmed || busy || processingCount === 0 || unresolvedScope} onClick={async () => {
            if (submissionPending.current || !confirmed || processingCount === 0 || selectedScope?.length === 0 || unresolvedScope) return;
            submissionPending.current = true;
            setBusy(true);
            try { if (await (scopedSupplement ? onConfirm(selectedScope ?? undefined, undefined, undefined, 'unresolved_pages')
              : onConfirm(selectedScope ?? undefined)) === true) onClose(); }
            finally { submissionPending.current = false; setBusy(false); }
          }}>{busy ? <LoaderCircle size={18} className="spin" /> : <Play size={18} />} 授权并开始</button>}
        </div>
      </section>
    </div>
  );
}

export default function App() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(() => createDemoSnapshot(new Date()));
  const [page, setPage] = useState<Page>('home');
  const [selectedPersonId, setSelectedPersonId] = useState(snapshot.persons[0]?.id ?? '');
  const contentAreaRef = useRef<HTMLElement | null>(null);
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const evidenceReturnFocusRef = useRef<HTMLElement | null>(null);
  const evidenceRequestRef = useRef(0);
  const evidenceWasOpenRef = useRef(false);
  const [toast, setToast] = useState<string | null>(null);
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [memberDialogOpen, setMemberDialogOpen] = useState(false);
  const [memberEditDialogOpen, setMemberEditDialogOpen] = useState(false);
  const [archivePerson, setArchivePerson] = useState<PersonSummary | null>(null);
  const [archivedPeopleDialogOpen, setArchivedPeopleDialogOpen] = useState(false);
  const [documentToExclude, setDocumentToExclude] = useState<InboxItem | null>(null);
  const [documentToDelete, setDocumentToDelete] = useState<InboxItem | null>(null);
  const [deletedDocumentsDialogOpen, setDeletedDocumentsDialogOpen] = useState(false);
  const [directoryDialogOpen, setDirectoryDialogOpen] = useState(false);
  const [processRequest, setProcessRequest] = useState<ManualProcessRequest | null>(null);
  const processConsentOpen = processRequest !== null;
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  const [cancelJob, setCancelJob] = useState<JobSummary | null>(null);
  const [backupDialogOpen, setBackupDialogOpen] = useState(false);
  const [processingRebuildDialogOpen, setProcessingRebuildDialogOpen] = useState(false);
  const [reviewDialog, setReviewDialog] = useState<ReviewIssue | null>(null);
  const [desktopDialogOpen, setDesktopDialogOpen] = useState(false);
  const [displayDialogOpen, setDisplayDialogOpen] = useState(false);
  const [aiDialogOpen, setAiDialogOpen] = useState(false);
  const [accountDialogOpen, setAccountDialogOpen] = useState(false);
  const [actionDialogOpen, setActionDialogOpen] = useState(false);
  const [actionToSchedule, setActionToSchedule] = useState<ActionItem | null>(null);
  const [manualNoteDialogOpen, setManualNoteDialogOpen] = useState(false);
  const [manualNoteQuestion, setManualNoteQuestion] = useState<MemberQuestionPrompt | null>(null);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [privacyDialogOpen, setPrivacyDialogOpen] = useState(false);
  const [aboutDialogOpen, setAboutDialogOpen] = useState(false);
  const [jobDetailSelection, setJobDetailSelection] = useState<{
    jobId: string;
    workspaceMode: DashboardSnapshot['workspaceMode'];
    workspaceName: string;
  } | null>(null);
  // 详情只保存选择；进度、状态和时间始终读取当前工作区的最新快照。
  const jobDetail = jobDetailSelection?.workspaceMode === snapshot.workspaceMode
    && jobDetailSelection.workspaceName === snapshot.workspaceName
    ? snapshot.jobs.find((job) => job.id === jobDetailSelection.jobId) ?? null
    : null;
  // 快照删除任务或切换工作区时撤销选择，避免之后同 ID 出现时自动重开。
  if (jobDetailSelection !== null && jobDetail === null) setJobDetailSelection(null);
  const [desktopBehavior, setDesktopBehavior] = useState<DesktopBehavior>({ stayInTray: null, openAtLogin: false, notificationsEnabled: true });
  const [displayPreferences, setDisplayPreferences] = useState<DisplayPreferences>({ fontScale: 'standard', reduceMotion: false, dateStyle: 'friendly' });
  const [aiPreferences, setAiPreferences] = useState<AiPreferences>(DEFAULT_AI_PREFERENCES);
  const [recoveryStatus, setRecoveryStatus] = useState<RecoveryStatus>({ pointCount: 0, totalBytes: 0, latestAt: null });

  useLayoutEffect(() => {
    // 切换页面或成员后从新内容开头阅读；后台资料更新不打断当前阅读位置。
    if (contentAreaRef.current) contentAreaRef.current.scrollTop = 0;
  }, [page, selectedPersonId]);

  const modalOpen = workspaceDialogOpen || memberDialogOpen || memberEditDialogOpen || archivePerson !== null || archivedPeopleDialogOpen || documentToExclude !== null || documentToDelete !== null || deletedDocumentsDialogOpen || directoryDialogOpen || processConsentOpen
    || scheduleDialogOpen || backupDialogOpen || processingRebuildDialogOpen || desktopDialogOpen || displayDialogOpen || aiDialogOpen || accountDialogOpen || actionDialogOpen || manualNoteDialogOpen || exportDialogOpen
    || privacyDialogOpen || aboutDialogOpen || reviewDialog !== null || cancelJob !== null || jobDetail !== null || actionToSchedule !== null;

  useEffect(() => {
    if (!modalOpen) return;
    const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
    const dialog = dialogs.at(-1);
    if (!dialog) return;
    const backdrop = dialog.closest<HTMLElement>('.modal-backdrop');
    const shell = document.querySelector<HTMLElement>('.app-shell');
    const background = shell && backdrop
      ? [...shell.children].filter((child): child is HTMLElement => child instanceof HTMLElement && child !== backdrop)
      : [];
    for (const element of background) element.inert = true;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = () => [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')]
      .filter((element) => element.offsetParent !== null);
    focusables()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        // 恢复点与清理是一个受保护的操作，等待回执时不能用 Esc 隐藏确认页。
        if (dialog.classList.contains('processing-rebuild-dialog') && dialog.getAttribute('aria-busy') === 'true') return;
        // 发送回执未返回前保留同一个确认页；每次按键读取当前忙碌状态，避免旧闭包提前卸载。
        if (processConsentOpen && dialog.classList.contains('process-consent-dialog') && dialog.getAttribute('aria-busy') === 'true') return;
        setWorkspaceDialogOpen(false);
        setMemberDialogOpen(false);
        setMemberEditDialogOpen(false);
        setArchivePerson(null);
        setArchivedPeopleDialogOpen(false);
        setDocumentToExclude(null);
        setDocumentToDelete(null);
        setDeletedDocumentsDialogOpen(false);
        setDirectoryDialogOpen(false);
        setProcessRequest(null);
        setScheduleDialogOpen(false);
        setBackupDialogOpen(false);
        setProcessingRebuildDialogOpen(false);
        setDesktopDialogOpen(false);
        setDisplayDialogOpen(false);
        setAiDialogOpen(false);
        setAccountDialogOpen(false);
        setActionDialogOpen(false);
        setActionToSchedule(null);
        setManualNoteDialogOpen(false);
        setExportDialogOpen(false);
        setPrivacyDialogOpen(false);
        setAboutDialogOpen(false);
        setReviewDialog(null);
        setCancelJob(null);
        setJobDetailSelection(null);
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0]!;
      const last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      for (const element of background) element.inert = false;
      previousFocus?.focus();
    };
  }, [modalOpen, processingRebuildDialogOpen, processConsentOpen]);

  useEffect(() => {
    if (!window.healthDesktop) return;
    void Promise.all([window.healthDesktop.getSnapshot(), window.healthDesktop.getBootstrap()]).then(([next, bootstrap]) => {
      setSnapshot(next);
      setDesktopBehavior(bootstrap.desktopBehavior);
      setDisplayPreferences(bootstrap.displayPreferences);
      setAiPreferences(bootstrap.aiPreferences);
      setRecoveryStatus(bootstrap.recoveryStatus);
      setSelectedPersonId((current) => next.persons.some((person) => person.id === current) ? current : next.persons[0]?.id ?? '');
    }).catch(() => setToast('无法读取本地工作区，已显示虚构演示资料。'));
  }, []);

  useEffect(() => {
    if (!window.healthDesktop) return;
    return window.healthDesktop.onSnapshotChanged((next) => {
      setSnapshot(next);
      setSelectedPersonId((current) => next.persons.some((person) => person.id === current) ? current : next.persons[0]?.id ?? '');
    });
  }, []);

  useEffect(() => {
    if (!window.healthDesktop) return;
    return window.healthDesktop.onTrayProcessRequested(() => {
      setPage('processing');
    });
  }, [snapshot.workspaceMode]);

  useEffect(() => {
    if (!window.healthDesktop) return;
    return window.healthDesktop.onAccountStateChanged((account) => {
      setSnapshot((current) => ({ ...current, account }));
      if (account.status === 'connected') setToast('Codex 已连接，可以上传资料并自动整理。');
      if (account.status === 'error' && account.displayLabel) setToast(account.displayLabel);
    });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const isOpen = evidence !== null;
    if (!isOpen && evidenceWasOpenRef.current) {
      evidenceReturnFocusRef.current?.focus();
      evidenceReturnFocusRef.current = null;
    }
    evidenceWasOpenRef.current = isOpen;
  }, [evidence]);

  const blockedDocumentIds = new Set(snapshot.reviews.filter((review) => review.resolutionStatus === 'open'
    && review.severity === 'blocking' && !isReadOnlyResultLimitation(review, snapshot.inbox.find((item) => item.id === review.documentId), snapshot.reviews))
    .map((review) => review.documentId));
  const resultLimitations = snapshot.reviews.filter((review) => review.resolutionStatus === 'open'
    && isReadOnlyResultLimitation(review, snapshot.inbox.find((item) => item.id === review.documentId), snapshot.reviews) && review.personId !== null
    && !blockedDocumentIds.has(review.documentId)
    && snapshot.inbox.some((item) => item.id === review.documentId && ['completed', 'needs_review'].includes(item.status)));

  function handleOpenLimitationEvidence(review: ReviewIssue): void {
    void handleOpenEvidence({
      title: review.title,
      label: '本机导入资料',
      quote: '查看报告的读取完整性、未纳入原因与原始依据。',
      meta: '已有可靠结果继续保留。历史读取版本不等于当前遗漏项目，也不能据此认定所有内容已有正式结果。',
      sourceSpanId: review.evidenceRefs[0] ?? null,
      documentId: review.documentId
    });
  }

  async function handleOpenEvidence(next: Evidence) {
    if (!evidence && document.activeElement instanceof HTMLElement) evidenceReturnFocusRef.current = document.activeElement;
    const requestId = ++evidenceRequestRef.current;
    if (snapshot.workspaceMode !== 'personal' || !window.healthDesktop) { setEvidence(next); return; }
    const selector = next.sourceSpanId
      ? { sourceSpanId: next.sourceSpanId }
      : next.documentId ? { documentId: next.documentId } : null;
    setEvidence({ ...next, previewImageDataUrl: null, previewState: selector ? 'loading' : 'unavailable' });
    if (!selector) return;
    // 切换来源或关闭侧栏后，旧请求不能覆盖当前查看内容。
    const applyCurrent = (update: Evidence) => {
      if (requestId === evidenceRequestRef.current) setEvidence((current) => current ? update : null);
    };
    try {
      const result = await window.healthDesktop.getEvidence(selector);
      if (!result.ok) { applyCurrent({ ...next, previewState: 'unavailable', previewImageDataUrl: null }); return; }
      const preview = result.data;
      applyCurrent({
        title: next.title,
        label: `${preview.displayName} · ${preview.locator}`,
        quote: preview.quote ?? (preview.previewImageDataUrl ? '' : '原报告未提供可显示的文字摘录。'),
        meta: preview.conversionView ? 'Word 转换预览的分页可能与原文件不同。' : '',
        sourceSpanId: preview.sourceSpanId,
        documentId: preview.documentId,
        previewImageDataUrl: preview.previewImageDataUrl,
        previewState: 'ready'
      });
    } catch {
      applyCurrent({ ...next, previewState: 'unavailable', previewImageDataUrl: null });
    }
  }

  async function handleResolveReview(input: ResolveReviewInput): Promise<boolean> {
    if (!window.healthDesktop) return false;
    const result = await window.healthDesktop.resolveReview(input);
    if (!result.ok) {
      setToast('这项核对没有保存，请重新查看当前状态。');
      return false;
    }
    const next = await window.healthDesktop.getSnapshot();
    setSnapshot(next);
    setToast(input.action === 'assign_person'
      ? '成员归属已确认，资料已进入待处理队列。'
      : input.action === 'confirm_identity'
        ? snapshot?.reviews.some((issue) => issue.id === input.issueId
          && issue.reasonCodes.includes('COMMITTED_PERSON_IDENTITY_CONFLICT'))
          ? '身份关系已确认，已有检查结果已恢复用于分析；其余未纳入项目仍可继续核对。'
          : '已确认这份报告属于当前成员，正在继续整理报告。'
      : input.action === 'retry_review'
        ? snapshot?.reviews.some((issue) => issue.id === input.issueId && issue.kind === 'person_conflict')
          ? '正在重新识别报告中的人物角色；若仍有受检者身份冲突，会再次提示你。'
          : '正在重新读取报告；仍看不清的内容会请你确认。'
      : input.action === 'reassign_person' ? '已改归到另一位成员；请针对新成员重新授权后，再开始处理。'
      : input.action === 'archive_only' ? '资料已归档，不会进入任何成员档案或后续分析；此前已发送的内容不能通过归档撤回。'
      : input.action === 'accept_correction' ? '修正后的检查结果已保存，可随时查看对应原报告。'
      : '报告结果已保留，这次健康解读暂不采用。');
    return true;
  }

  const content = (() => {
    switch (page) {
      case 'home': return <HomePage snapshot={snapshot} selectedPersonId={selectedPersonId} onSelectPerson={(id) => { setSelectedPersonId(id); setPage('people'); }} onNavigate={setPage} onAddPerson={() => setMemberDialogOpen(true)} />;
      case 'people': return <PeoplePage snapshot={snapshot} selectedPersonId={selectedPersonId} onSelectPerson={setSelectedPersonId} onOpenEvidence={(next) => void handleOpenEvidence(next)} onAddPerson={() => setMemberDialogOpen(true)} onEditPerson={() => setMemberEditDialogOpen(true)} onArchivedPeople={() => setArchivedPeopleDialogOpen(true)} onAddNote={(question) => { setManualNoteQuestion(question ?? null); setManualNoteDialogOpen(true); }} onExport={() => setExportDialogOpen(true)} onImport={() => void handleImport()} onUploadReports={(personId) => void handleImport(personId)} onRefreshAssessment={(personId) => void handleRefreshAssessment(personId)} onCorrectDocumentDate={(document) => setProcessRequest((current) => current ?? { kind: 'date_correction', documentId: document.id })} onExcludeDocument={setDocumentToExclude} onReincludeDocument={(document) => void handleSetDocumentIncluded(document, true)} onDeleteDocument={setDocumentToDelete} onDeletedDocuments={() => setDeletedDocumentsDialogOpen(true)} />;
      case 'inbox': return <><InboxRefreshPrompt snapshot={snapshot} onRefresh={() => undefined} onOptionalRefresh={() => undefined} /><InboxPage snapshot={snapshot} selectedPersonId={selectedPersonId} onProcess={(documentIds) => {
        if (snapshot.workspaceMode !== 'personal') void handleProcessNow(documentIds);
      }} onImport={(personId) => void handleImport(personId)} onDropFiles={(files, personId) => void handleDroppedFiles(files, personId)} onAssign={handleBatchAssign} onIgnore={handleBatchIgnore} onOpenEvidence={(next) => void handleOpenEvidence(next)} onProcessingCenter={() => setPage('processing')} onDirectories={() => {
        if (snapshot.workspaceMode !== 'personal') setWorkspaceDialogOpen(true);
        else setDirectoryDialogOpen(true);
      }} /></>;
      case 'processing': return <ProcessingPage snapshot={snapshot} resultLimitations={resultLimitations} onOpenLimitationEvidence={handleOpenLimitationEvidence} onRepairReports={(documentIds) => {
        const selected = [...new Set(documentIds)];
        const { repairDocuments } = manualProcessingScope(snapshot, selected);
        if (snapshot.workspaceMode !== 'personal' || selected.length === 0 || repairDocuments.length !== selected.length) {
          setToast('可重新核对的报告范围已变化，请重新选择。');
          return;
        }
        setProcessRequest((current) => current ?? { kind: 'documents', documentIds: selected });
      }} onCancel={setCancelJob} onRetry={(job) => void handleRetryJob(job)} onTogglePause={() => void handleToggleQueuePause()} onDetails={(job) => setJobDetailSelection({ jobId: job.id, workspaceMode: snapshot.workspaceMode, workspaceName: snapshot.workspaceName })} />;
      case 'actions': return <ActionsPage snapshot={snapshot} onCreate={() => {
        if (snapshot.workspaceMode !== 'personal') setToast('演示工作区不会保存事项；请先建立或切换到个人工作区。');
        else setActionDialogOpen(true);
      }} onUpdate={(item, status) => void handleActionStatus(item, status)} onSchedule={(item) => {
        if (snapshot.workspaceMode !== 'personal') setToast('演示工作区不会保存时间安排。');
        else setActionToSchedule(item);
      }} onOpenEvidence={(request) => void handleOpenEvidence(request)} />;
      case 'settings': return <SettingsPage snapshot={snapshot} desktopBehavior={desktopBehavior} displayPreferences={displayPreferences} aiPreferences={aiPreferences} recoveryStatus={recoveryStatus} onAccount={() => setAccountDialogOpen(true)} onAi={() => setAiDialogOpen(true)} onDirectories={() => {
        if (snapshot.workspaceMode !== 'personal') {
          setWorkspaceDialogOpen(true);
          setToast('请先建立或切换到个人工作区。');
        } else setDirectoryDialogOpen(true);
      }} onSchedule={() => {
        if (snapshot.workspaceMode !== 'personal') {
          setWorkspaceDialogOpen(true);
          setToast('请先建立或切换到个人工作区。');
        } else setScheduleDialogOpen(true);
      }} onDesktop={() => setDesktopDialogOpen(true)} onDisplay={() => setDisplayDialogOpen(true)} onPrivacy={() => setPrivacyDialogOpen(true)} onAbout={() => setAboutDialogOpen(true)} onBackup={() => {
        if (snapshot.workspaceMode !== 'personal') {
          setWorkspaceDialogOpen(true);
          setToast('请先建立或切换到个人工作区。');
        } else setBackupDialogOpen(true);
      }} />;
    }
  })();

  function handleRefreshAssessment(personId: string): void {
    const person = snapshot.persons.find((item) => item.id === personId);
    if (snapshot.workspaceMode !== 'personal' || !person || person.acceptedFactCount <= 0
      || !/^[a-f0-9]{64}$/.test(person.dataRevision)) {
      setToast('这位成员的资料范围暂时无法确认，请刷新档案后再试。');
      return;
    }
    if (snapshot.jobs.some((job) => job.personLabel === person.displayName
      && ['queued', 'running', 'waiting_auth', 'waiting_quota', 'waiting_user', 'retry_wait'].includes(job.status))) {
      setToast('这位成员已有处理任务，请等待完成后再更新健康解读。');
      return;
    }
    // 这里只打开冻结成员范围的确认窗；勾选授权前绝不调用处理接口。
    setProcessRequest((current) => current ?? { kind: 'assessment', personId });
  }

  async function handleProcessNow(documentIds?: string[], assessmentPersonId?: string, expectedAssessmentDataRevision?: string, readingScope?: 'unresolved_pages'): Promise<ProcessConsentResult> {
    if (!window.healthDesktop) { setToast('演示模式不会发送资料。'); return false; }
    const assessmentOnly = assessmentPersonId !== undefined;
    if (assessmentOnly && (documentIds !== undefined || !assessmentPersonId || /\s/u.test(assessmentPersonId) || snapshot.workspaceMode !== 'personal'
      || !expectedAssessmentDataRevision || !/^[a-f0-9]{64}$/.test(expectedAssessmentDataRevision)
      || !snapshot.persons.some((person) => person.id === assessmentPersonId && person.acceptedFactCount > 0))) {
      setToast('无法核验本次成员综合范围，请取消后重新打开。'); return false;
    }
    if (!assessmentOnly && expectedAssessmentDataRevision !== undefined) {
      setToast('无法核验本次处理范围，请取消后重新打开。'); return false;
    }
    if (assessmentOnly && snapshot.persons.find((person) => person.id === assessmentPersonId)?.dataRevision !== expectedAssessmentDataRevision) {
      setToast('档案刚有更新，已保存的结果仍可查看。'); return 'assessment_scope_changed';
    }
    if (assessmentOnly && snapshot.jobs.some((job) => job.personLabel === snapshot.persons.find((person) => person.id === assessmentPersonId)?.displayName
      && ['queued', 'running', 'waiting_auth', 'waiting_quota', 'waiting_user', 'retry_wait'].includes(job.status))) {
      setToast('这位成员已有处理任务，请等待完成后再更新健康解读。'); return false;
    }
    if (documentIds?.length === 0) { setToast('请至少选择一份本次要处理的报告。'); return false; }
    const { readyDocuments, repairDocuments } = manualProcessingScope(snapshot, assessmentOnly ? [] : documentIds);
    const refreshOnly = readyDocuments.length === 0 && repairDocuments.length === 0;
    let result;
    try {
      result = await window.healthDesktop.processNow({ consentVersion: 1, confirmedDataRecipient: 'OpenAI/Codex',
        ...(assessmentOnly ? { assessmentPersonId, expectedAssessmentDataRevision } : { documentIds, ...(readingScope ? { readingScope } : {}) }) });
    } catch {
      setToast('暂时无法建立处理批次，请稍后重试。'); return false;
    }
    if (result.ok) {
      try { setSnapshot(await window.healthDesktop.getSnapshot()); }
      catch { setToast('处理任务已建立；暂时无法刷新本机档案，请稍后查看处理中心。'); return true; }
      setToast(result.revision === 0 ? '这批资料已经在处理中，没有重复创建任务。'
        : repairDocuments.length > 0 ? readingScope ? '正在补读问题页；其他页和已有正确结果保留。' : '正在重读整份报告并核对未纳入项目；已有报告结果会保留。'
        : refreshOnly ? '正在更新健康解读；会使用已有检查结果，旧报告不会重新上传或读取。'
          : '正在读取新报告，随后会为对应成员更新健康解读。');
      return true;
    }
    if (assessmentOnly && result.error.code === 'ASSESSMENT_SCOPE_CHANGED') {
      try { setSnapshot(await window.healthDesktop.getSnapshot()); }
      catch { /* 保留旧快照，由确认窗阻止再次授权旧资料版本。 */ }
      setToast('档案刚有更新，本次未重复建立任务，已有结果仍可查看。');
      return 'assessment_scope_changed';
    }
    setToast(snapshot.workspaceMode === 'demo'
      ? '这是演示工作区，不会把虚构资料发送给 AI。'
      : result.error.code === 'NO_READY_DOCUMENTS' ? '当前没有已归属、可处理的新资料。'
        : result.error.code.startsWith('REPORT_SUPPLEMENT_') ? '暂时无法可靠确定问题页范围，未发送资料，也没有改成整份重读；请保留现有结果。'
        : result.error.code === 'DOCUMENT_ALREADY_IN_PROCESSING' ? '这份资料已在处理中心，请在那里查看或重试。'
        : result.error.code === 'AUTH_REQUIRED' ? '连接 Codex 后会继续整理已上传的资料。' : '暂时无法建立处理批次。');
    return false;
  }

  async function handleDateCorrection(documentId: string, expectedDataRevision: string): Promise<DateCorrectionConsentResult> {
    if (!window.healthDesktop || snapshot.workspaceMode !== 'personal') return false;
    const document = snapshot.inbox.find((item) => item.id === documentId);
    const person = snapshot.persons.find((item) => item.id === document?.personId);
    if (!document || document.status !== 'completed' || document.inProcessingCenter || !person
      || !/^[a-f0-9]{64}$/.test(expectedDataRevision)) return false;
    const refreshScope = async (): Promise<'date_correction_scope_changed'> => {
      try { setSnapshot(await window.healthDesktop!.getSnapshot()); }
      catch { /* 旧资料版本不能重新授权；等待新快照或关闭后重开。 */ }
      setToast('这份报告或成员资料已变化，本次未建立日期核实任务。请重新确认当前资料。');
      return 'date_correction_scope_changed';
    };
    if (person.dataRevision !== expectedDataRevision) return refreshScope();
    try {
      const result = await window.healthDesktop.processNow({ purpose: 'date_correction', dateCorrectionDocumentId: documentId,
        expectedDateCorrectionDataRevision: expectedDataRevision, consentVersion: 1, confirmedDataRecipient: 'OpenAI/Codex' });
      if (!result.ok) {
        if (result.error.code === 'DATE_CORRECTION_SCOPE_CHANGED') return refreshScope();
        setToast(result.error.code === 'DOCUMENT_ALREADY_IN_PROCESSING' ? '这份报告正在处理中，请在处理中心查看。'
          : result.error.code === 'AUTH_REQUIRED' ? '请先连接 Codex，再确认本次日期核实授权。'
            : '暂时无法建立这份报告的日期核实任务，原有资料仍保留。');
        return false;
      }
      setToast(result.revision === 0 ? '这份报告的日期核实已在处理中，没有重复创建任务。'
        : '已开始核实这一份报告的日期，旧版本、其他检查事实和已有计划会保留。');
      try { setSnapshot(await window.healthDesktop.getSnapshot()); }
      catch { setToast('日期核实任务已建立；暂时无法刷新档案，请稍后查看处理中心。'); }
      return true;
    } catch {
      setToast('暂时无法建立日期核实任务，不会自动重试。');
      return false;
    }
  }

  async function handleImport(personId: string | null = selectedPersonId || null) {
    if (snapshot.workspaceMode !== 'personal') {
      setWorkspaceDialogOpen(true);
      setToast('请先建立或切换到个人工作区；演示资料与真实资料严格隔离。');
      return;
    }
    if (!window.healthDesktop) { setToast('请在桌面应用中添加资料。'); return; }
    const result = await window.healthDesktop.selectFiles(personId, true);
    if (!result.ok) { setToast('未能导入资料，请稍后重试。'); return; }
    if (result.data.selectedCount === 0) return;
    await applyImportReceipt(result.data);
  }

  async function handleBatchAssign(documentIds: string[], personId: string): Promise<void> {
    const bridge = window.healthDesktop;
    if (!bridge || documentIds.length === 0) return;
    let completed = 0;
    for (const documentId of documentIds) {
      const result = await bridge.resolveReview({ action: 'assign_person', documentId, personId });
      if (!result.ok) break;
      completed += 1;
    }
    setSnapshot(await bridge.getSnapshot());
    setToast(completed === documentIds.length
      ? `已确认 ${completed} 份资料的成员归属；它们已进入待处理队列。`
      : `已确认 ${completed} 份；剩余资料的状态已变化，请核对后重试。`);
  }

  async function handleBatchIgnore(documentIds: string[]): Promise<void> {
    const bridge = window.healthDesktop;
    if (!bridge || documentIds.length === 0) return;
    let completed = 0;
    for (const documentId of documentIds) {
      const result = await bridge.setDocumentIncluded({ documentId, included: false, confirmedExclusion: true });
      if (!result.ok) break;
      completed += 1;
    }
    setSnapshot(await bridge.getSnapshot());
    setToast(completed === documentIds.length
      ? `已将 ${completed} 份资料移出处理与分析；原件和操作记录仍保留。`
      : `已移出 ${completed} 份；其他资料可能正在处理，未被改动。`);
  }

  async function handleDroppedFiles(files: File[], personId: string | null) {
    if (snapshot.workspaceMode !== 'personal' || !window.healthDesktop) {
      setToast('请先建立个人工作区，再拖入本机资料。');
      return;
    }
    const result = await window.healthDesktop.importDroppedFiles(personId, files, true);
    if (!result.ok) {
      setToast('拖入的资料未能导入；请确认文件仍在本机且没有超过 100MB。');
      return;
    }
    await applyImportReceipt(result.data);
  }

  async function applyImportReceipt(receipt: ImportFilesReceipt) {
    const bridge = window.healthDesktop;
    if (!bridge) return;
    setSnapshot(await bridge.getSnapshot());
    if (receipt.processing?.status === 'queued') setPage('processing');
    setToast(importReceiptMessage(receipt));
  }

  async function handleCreateWorkspace(input: { workspaceName: string; primaryMemberName: string; relation: string }) {
    if (!window.healthDesktop) { setToast('请在桌面应用中建立个人工作区。'); return; }
    const result = await window.healthDesktop.createWorkspace(input);
    if (!result.ok) { setToast('建立个人工作区失败，请检查本机存储权限。'); return; }
    setJobDetailSelection(null);
    setSnapshot(result.data);
    setRecoveryStatus((await window.healthDesktop.getBootstrap()).recoveryStatus);
    setSelectedPersonId(result.data.persons[0]?.id ?? '');
    setWorkspaceDialogOpen(false);
    setPage('home');
    setToast('个人工作区已建立。当前没有任何资料发送给 AI。');
  }

  async function handleSwitchWorkspace(mode: 'demo' | 'personal') {
    if (!window.healthDesktop) return;
    const result = await window.healthDesktop.switchWorkspace(mode);
    if (!result.ok) {
      setToast('个人工作区尚未建立，请先填写下方信息。');
      return;
    }
    setJobDetailSelection(null);
    setSnapshot(result.data);
    if (mode === 'personal') setRecoveryStatus((await window.healthDesktop.getBootstrap()).recoveryStatus);
    setSelectedPersonId(result.data.persons[0]?.id ?? '');
    setEvidence(null);
    setWorkspaceDialogOpen(false);
    setPage('home');
  }

  async function handleCreatePerson(input: { displayName: string; relation: string; birthYear: number | null }) {
    if (!window.healthDesktop) return;
    const result = await window.healthDesktop.createPerson(input);
    if (!result.ok) { setToast('添加成员失败，请稍后重试。'); return; }
    setSnapshot(result.data.snapshot);
    setSelectedPersonId(result.data.personId);
    setMemberDialogOpen(false);
    setPage('people');
    setToast('成员已保存在本机，还没有任何资料发送给 AI。');
  }

  async function handleUpdatePersonDisplay(input: UpdatePersonDisplayInput): Promise<boolean> {
    if (!window.healthDesktop) return false;
    const result = await window.healthDesktop.updatePersonDisplay(input);
    if (!result.ok) {
      setSnapshot(await window.healthDesktop.getSnapshot());
      setToast(result.error.code.startsWith('REVISION_CONFLICT') ? '成员显示资料已在别处更新，已刷新到最新状态。' : '成员显示资料没有保存，请稍后重试。');
      return false;
    }
    setSnapshot(result.data);
    setToast('成员显示资料已更新；报告归属和健康分析没有重算。');
    return true;
  }

  async function handleArchivePerson(): Promise<boolean> {
    if (!window.healthDesktop || !archivePerson) return false;
    const result = await window.healthDesktop.archivePerson({
      personId: archivePerson.id,
      expectedDisplayRevision: archivePerson.displayRevision,
      confirmedArchive: true
    });
    if (!result.ok) {
      setSnapshot(await window.healthDesktop.getSnapshot());
      setToast(result.error.code === 'PERSON_HAS_RUNNING_JOB'
        ? '这位成员仍有正在运行的任务，请先在处理中心安全停止或等待完成。'
        : result.error.code.startsWith('REVISION_CONFLICT') ? '成员档案已在别处更新，已刷新到最新状态。' : '成员没有归档成功，请稍后重试。');
      return false;
    }
    setSnapshot(result.data);
    setSelectedPersonId(result.data.persons[0]?.id ?? '');
    setArchivePerson(null);
    setToast('成员已归档；原始报告和历史记录仍保存在本机，目录与 AI 授权已撤回。');
    return true;
  }

  async function handleRestorePerson(person: Person): Promise<boolean> {
    if (!window.healthDesktop) return false;
    const result = await window.healthDesktop.restorePerson({ personId: person.id, expectedDisplayRevision: person.displayRevision });
    if (!result.ok) {
      setToast(result.error.code.startsWith('REVISION_CONFLICT') ? '归档状态已变化，请重新打开列表。' : '成员没有恢复成功，请稍后重试。');
      return false;
    }
    setSnapshot(result.data.snapshot);
    setSelectedPersonId(result.data.person.id);
    setToast('成员已恢复显示；此前撤回的目录与 AI 授权没有自动恢复。');
    return true;
  }

  async function handleSetDocumentIncluded(document: InboxItem, included: boolean): Promise<boolean> {
    if (!window.healthDesktop) return false;
    const result = await window.healthDesktop.setDocumentIncluded(included
      ? { documentId: document.id, included: true }
      : { documentId: document.id, included: false, confirmedExclusion: true });
    if (!result.ok) {
      setToast(result.error.code === 'DOCUMENT_HAS_ACTIVE_JOB'
        ? '这份资料仍属于未完成任务，请先在处理中心安全停止或等待完成。'
        : '资料范围没有更新，请稍后重试。');
      return false;
    }
    setSnapshot(result.data);
    if (!included) setDocumentToExclude(null);
    setToast(included
      ? '资料已重新纳入本机档案并进入待处理队列；不会在未授权时自动发送。'
      : '资料已移出分析；原始报告和之前的备份仍可能保留，需要时可重新纳入。');
    return true;
  }

  async function handleDeleteDocument(document: InboxItem): Promise<boolean> {
    if (!window.healthDesktop) return false;
    const result = await window.healthDesktop.deleteDocument({
      documentId: document.id,
      confirmedDelete: true,
      acknowledgedRecoveryCopies: true
    });
    if (!result.ok) {
      setToast(result.error.code === 'DOCUMENT_HAS_ACTIVE_JOB'
        ? '这份资料仍属于未完成任务，请先在处理中心安全停止或等待完成。'
        : '没有完成删除；当前档案保持不变，请稍后重试。');
      return false;
    }
    setSnapshot(result.data.snapshot);
    setEvidence(null);
    setDocumentToDelete(null);
    setToast(result.data.receipt.retainedByRecoveryPoint
      ? '已从当前档案删除，不会自动再次添加；之前的本机备份仍可能保留旧资料。'
      : '已从当前档案删除，不会自动再次添加；你导出的备份仍可能保留旧资料。');
    return true;
  }

  async function handleLogin() {
    if (!window.healthDesktop) { setToast('请在桌面应用中连接 Codex。'); return; }
    if (snapshot.account.status === 'connecting') {
      setToast('登录仍在等待浏览器完成；完成后这里会自动更新。');
      return;
    }
    if (snapshot.account.status === 'connected') {
      const refreshed = await window.healthDesktop.refreshAccount();
      if (refreshed.ok) {
        setSnapshot((current) => ({ ...current, account: refreshed.data }));
        setToast('账户与额度状态已刷新。');
      } else {
        setToast('暂时无法刷新 Codex 状态，本地健康档案仍可正常查看。');
      }
      return;
    }
    const result = await window.healthDesktop.startLogin();
    if (result.ok) {
      setToast('已在浏览器打开 Codex 官方登录流程；完成后这里会自动更新。');
      return;
    }
    setToast(result.error.code === 'CODEX_RUNTIME_UNAVAILABLE'
      ? '当前构建尚未捆绑 Codex 运行时；本地档案仍可使用，AI 处理暂不可用。'
      : '无法启动 Codex 官方登录流程，请稍后重试。');
  }

  async function handleLogout(): Promise<boolean> {
    if (!window.healthDesktop) return false;
    const result = await window.healthDesktop.logoutAccount();
    if (!result.ok) {
      setToast(result.error.code === 'ACCOUNT_HAS_RUNNING_JOB'
        ? '仍有正在运行的处理任务，请先在处理中心安全停止或等待完成。'
        : 'Codex 没有退出成功；本机健康档案没有变化。');
      return false;
    }
    const next = await window.healthDesktop.getSnapshot();
    setSnapshot({ ...next, account: result.data });
    setToast('已退出 Codex；本机健康档案仍可查看，待发送任务和 AI 授权已暂停。');
    return true;
  }

  async function handleCreateAction(input: CreateActionItemInput): Promise<boolean> {
    if (!window.healthDesktop || snapshot.workspaceMode !== 'personal') return false;
    const result = await window.healthDesktop.createAction(input);
    if (!result.ok) {
      setToast('事项没有保存，请重新查看本机工作区后再试。');
      return false;
    }
    setSnapshot(await window.healthDesktop.getSnapshot());
    setToast('事项已保存在本机，并明确标记为“本人安排”。');
    return true;
  }

  async function handleCreateManualNote(input: CreateManualNoteInput): Promise<boolean> {
    if (!window.healthDesktop || snapshot.workspaceMode !== 'personal') return false;
    const result = await window.healthDesktop.createManualNote(input);
    if (!result.ok) {
      setSnapshot(await window.healthDesktop.getSnapshot());
      setToast(result.error.code.startsWith('REVISION_CONFLICT') ? '成员背景已在别处更新，已刷新到最新状态，请重新填写。' : '补充资料没有保存，请稍后重试。');
      return false;
    }
    setSnapshot(await window.healthDesktop.getSnapshot());
    setToast('补充资料已保存在本机，并标记为“本人自述”。');
    return true;
  }

  async function handleExportMemberSummary(input: ExportMemberSummaryInput): Promise<boolean> {
    if (!window.healthDesktop || snapshot.workspaceMode !== 'personal') return false;
    const result = await window.healthDesktop.exportMemberSummary(input);
    if (!result.ok) {
      setToast('资料摘要没有导出，请检查保存位置后再试。');
      return false;
    }
    if (result.data) setToast(`已导出 ${result.data.displayName}；文件只保存在你选择的本机位置。`);
    return true;
  }

  async function handleActionStatus(item: ActionItem, status: ActionItem['status']) {
    if (!window.healthDesktop) { setToast('演示模式不会保存事项状态。'); return; }
    const result = await window.healthDesktop.setActionStatus({ actionId: item.id, status, expectedRevision: item.userRevision });
    if (!result.ok) {
      setSnapshot(await window.healthDesktop.getSnapshot());
      setToast(result.error.code === 'ACTION_REVISION_CONFLICT' ? '这项安排已在别处更新，已为你刷新到最新状态。' : '事项状态没有保存，请稍后重试。');
      return;
    }
    setSnapshot((current) => ({ ...current, actions: current.actions.map((action) => action.id === item.id ? result.data : action) }));
    setToast(status === 'completed' ? '事项已标记为完成。这个状态不会变成“医生已确认”。' : '事项状态已保存在本机。');
  }

  async function handleActionSchedule(input: UpdateActionScheduleInput): Promise<boolean> {
    if (!window.healthDesktop?.updateActionSchedule) return false;
    const result = await window.healthDesktop.updateActionSchedule(input);
    if (!result.ok) {
      setSnapshot(await window.healthDesktop.getSnapshot());
      return false;
    }
    setSnapshot((current) => ({ ...current, actions: current.actions.map((action) => action.id === input.actionId ? result.data : action) }));
    setToast('你的时间安排已保存，原建议没有改变。');
    return true;
  }

  async function handleScheduleSave(input: { enabled: boolean; localTime: string; expectedRevision: number }): Promise<boolean> {
    if (!window.healthDesktop) return false;
    const result = await window.healthDesktop.updateSchedule(input);
    if (!result.ok) {
      setToast(result.error.code.startsWith('REVISION_CONFLICT') ? '设置已在别处更新，请重新打开后再保存。' : '自动处理设置没有保存，请稍后重试。');
      return false;
    }
    setSnapshot(result.data);
    setToast(input.enabled ? `已启用每日 ${input.localTime} 自动检查。` : '已关闭自动检查；现有本机资料不会被自动发送。');
    return true;
  }

  async function handleCancelJob(): Promise<boolean> {
    if (!window.healthDesktop || !cancelJob) return false;
    const result = await window.healthDesktop.cancelJob(cancelJob.id);
    if (!result.ok) {
      setToast('任务没有停止，请重新查看当前状态。');
      return false;
    }
    setSnapshot(await window.healthDesktop.getSnapshot());
    setToast(result.data.running ? '已发送停止请求；正在确认当前 AI 处理已结束。' : '任务已停止；已保存的报告结果仍然保留。');
    return true;
  }

  async function handleRetryJob(job: JobSummary): Promise<void> {
    if (!window.healthDesktop) return;
    const result = await window.healthDesktop.retryJob(job.id);
    if (!result.ok) {
      setToast('这项任务当前不能重试；请刷新后查看等待原因。');
      return;
    }
    setSnapshot(await window.healthDesktop.getSnapshot());
    setToast('已按保存进度排队重试；尚未处理的报告会继续处理，已保存的报告结果会保留。');
  }

  async function handleToggleQueuePause(): Promise<void> {
    if (!window.healthDesktop) return;
    const result = await window.healthDesktop.setQueuePaused(!snapshot.queuePaused);
    if (!result.ok) {
      setToast('队列状态没有更新，请稍后重试。');
      return;
    }
    setSnapshot(await window.healthDesktop.getSnapshot());
    setToast(result.data.paused ? '队列已暂停；不会开始新的资料处理。' : '队列已继续，将处理已授权的资料。');
  }

  async function handleDesktopBehaviorSave(input: { stayInTray: boolean; openAtLogin: boolean; notificationsEnabled: boolean }): Promise<boolean> {
    if (!window.healthDesktop) return false;
    const result = await window.healthDesktop.updateDesktopBehavior(input);
    if (!result.ok) {
      setToast('桌面行为设置没有保存，请稍后重试。');
      return false;
    }
    setDesktopBehavior(result.data);
    setToast(input.stayInTray ? '关闭窗口后会驻留后台；可从菜单栏或托盘真正退出。' : '关闭窗口会真正退出，不会继续自动检查。');
    return true;
  }

  async function handleDisplayPreferencesSave(input: DisplayPreferences): Promise<boolean> {
    if (!window.healthDesktop) return false;
    const result = await window.healthDesktop.updateDisplayPreferences(input);
    if (!result.ok) {
      setToast('显示设置没有保存，请稍后重试。');
      return false;
    }
    setDisplayPreferences(result.data);
    setToast('显示设置已保存在这台电脑上。');
    return true;
  }

  async function handleAiPreferencesSave(input: AiPreferences): Promise<boolean> {
    if (!window.healthDesktop) return false;
    const result = await window.healthDesktop.updateAiPreferences(input);
    if (!result.ok) {
      setToast('AI 模型设置没有保存；请刷新 Codex 连接后重试。');
      return false;
    }
    setAiPreferences(result.data);
    setToast(`分析报告已设置为 ${modelPreferenceLabel(result.data)}；之后新启动的综合分析会使用这组设置。`);
    return true;
  }

  activeDateStyle = displayPreferences.dateStyle;
  const shellClasses = ['app-shell', evidence ? 'has-evidence' : '', displayPreferences.fontScale === 'large' ? 'font-large' : '', displayPreferences.reduceMotion ? 'reduce-motion' : ''].filter(Boolean).join(' ');

  return (
    <div className={shellClasses}>
      <Sidebar page={page} setPage={setPage} snapshot={snapshot} onWorkspace={() => setWorkspaceDialogOpen(true)} />
      <div className="app-main">
        <Topbar snapshot={snapshot} onLogin={() => void handleLogin()} onProcessing={() => setPage('processing')} />
        <main className="content-area" ref={contentAreaRef}>

          {content}
        </main>
      </div>
      <EvidencePanel evidence={evidence} demo={snapshot.workspaceMode === 'demo'} resultLimitations={resultLimitations} onClose={() => { evidenceRequestRef.current += 1; setEvidence(null); }} onRetry={() => { if (evidence) void handleOpenEvidence(evidence); }} />
      {workspaceDialogOpen && <WorkspaceDialog snapshot={snapshot} onClose={() => setWorkspaceDialogOpen(false)} onCreate={handleCreateWorkspace} onSwitch={handleSwitchWorkspace} />}
      {memberDialogOpen && <MemberDialog onClose={() => setMemberDialogOpen(false)} onCreate={handleCreatePerson} />}
      {memberEditDialogOpen && snapshot.persons.find((person) => person.id === selectedPersonId) && <MemberEditDialog person={snapshot.persons.find((person) => person.id === selectedPersonId)!} onClose={() => setMemberEditDialogOpen(false)} onSave={handleUpdatePersonDisplay} onArchive={() => { const person = snapshot.persons.find((item) => item.id === selectedPersonId); if (person) { setMemberEditDialogOpen(false); setArchivePerson(person); } }} />}
      {archivePerson && <ArchivePersonDialog person={archivePerson} onClose={() => setArchivePerson(null)} onConfirm={handleArchivePerson} />}
      {archivedPeopleDialogOpen && <ArchivedPeopleDialog onClose={() => setArchivedPeopleDialogOpen(false)} onRestore={handleRestorePerson} onNotice={setToast} />}
      {documentToExclude && <ExcludeDocumentDialog document={documentToExclude} onClose={() => setDocumentToExclude(null)} onConfirm={() => handleSetDocumentIncluded(documentToExclude, false)} />}
      {documentToDelete && <DeleteDocumentDialog document={documentToDelete} onClose={() => setDocumentToDelete(null)} onConfirm={() => handleDeleteDocument(documentToDelete)} />}
      {deletedDocumentsDialogOpen && <DeletedDocumentsDialog onClose={() => setDeletedDocumentsDialogOpen(false)} onNotice={setToast} />}
      {directoryDialogOpen && <InboxDirectoriesDialog snapshot={snapshot} onClose={() => setDirectoryDialogOpen(false)} onNotice={setToast} />}
      {processRequest?.kind === 'date_correction'
        ? <DateCorrectionConsentDialog snapshot={snapshot} documentId={processRequest.documentId} onClose={() => setProcessRequest(null)} onConfirm={handleDateCorrection} onLogin={() => void handleLogin()} />
        : processRequest && <ProcessConsentDialog snapshot={snapshot} documentIds={processRequest.kind === 'documents' ? processRequest.documentIds : null} {...(processRequest.kind === 'assessment' ? { assessmentPersonId: processRequest.personId } : {})} onClose={() => setProcessRequest(null)} onConfirm={handleProcessNow} onLogin={() => void handleLogin()} />}
      {scheduleDialogOpen && <ScheduleDialog snapshot={snapshot} onClose={() => setScheduleDialogOpen(false)} onSave={handleScheduleSave} />}
      {cancelJob && <CancelJobDialog job={cancelJob} onClose={() => setCancelJob(null)} onConfirm={handleCancelJob} />}
      {backupDialogOpen && <BackupDialog onClose={() => setBackupDialogOpen(false)} onNotice={setToast} onRestored={(next) => { setSnapshot(next); setSelectedPersonId(next.persons[0]?.id ?? ''); setEvidence(null); }} onRebuild={() => { setBackupDialogOpen(false); setProcessingRebuildDialogOpen(true); }} />}
      {processingRebuildDialogOpen && <ProcessingRebuildDialog snapshot={snapshot} onClose={() => setProcessingRebuildDialogOpen(false)} onInspect={() => setPage('processing')} onStarted={(receipt) => {
        setPage('processing');
        setEvidence(null);
        setToast(`已校验本机恢复备份，开始为 ${receipt.personCount} 位成员重建 ${receipt.documentCount} 份报告。原始文件和成员已保留。`);
        void window.healthDesktop?.getSnapshot().then(setSnapshot).catch(() => setToast('重建已开始；处理中心暂未刷新，请稍后查看。'));
        void window.healthDesktop?.getBootstrap().then((bootstrap) => setRecoveryStatus(bootstrap.recoveryStatus)).catch(() => undefined);
      }} />}
      {desktopDialogOpen && <DesktopBehaviorDialog behavior={desktopBehavior} onClose={() => setDesktopDialogOpen(false)} onSave={handleDesktopBehaviorSave} />}
      {displayDialogOpen && <DisplayPreferencesDialog preferences={displayPreferences} onClose={() => setDisplayDialogOpen(false)} onSave={handleDisplayPreferencesSave} />}
      {aiDialogOpen && <AiPreferencesDialog preferences={aiPreferences} onClose={() => setAiDialogOpen(false)} onSave={handleAiPreferencesSave} />}
      {accountDialogOpen && <AccountDialog snapshot={snapshot} onClose={() => setAccountDialogOpen(false)} onConnect={() => void handleLogin()} onRefresh={handleLogin} onLogout={handleLogout} />}
      {actionDialogOpen && <ActionDialog snapshot={snapshot} selectedPersonId={selectedPersonId} onClose={() => setActionDialogOpen(false)} onCreate={handleCreateAction} />}
      {actionToSchedule && <ActionScheduleDialog item={actionToSchedule} personName={snapshot.persons.find((person) => person.id === actionToSchedule.personId)?.displayName ?? '这位成员'} onClose={() => setActionToSchedule(null)} onSave={handleActionSchedule} />}
      {manualNoteDialogOpen && <ManualNoteDialog snapshot={snapshot} selectedPersonId={selectedPersonId} question={manualNoteQuestion} onClose={() => setManualNoteDialogOpen(false)} onCreate={handleCreateManualNote} />}
      {exportDialogOpen && <ExportSummaryDialog snapshot={snapshot} selectedPersonId={selectedPersonId} onClose={() => setExportDialogOpen(false)} onExport={handleExportMemberSummary} />}
      {privacyDialogOpen && <PrivacyDialog snapshot={snapshot} onClose={() => setPrivacyDialogOpen(false)} onDirectories={() => {
        if (snapshot.workspaceMode !== 'personal') setWorkspaceDialogOpen(true);
        else setDirectoryDialogOpen(true);
      }} onBackup={() => {
        if (snapshot.workspaceMode !== 'personal') setWorkspaceDialogOpen(true);
        else setBackupDialogOpen(true);
      }} onNotice={setToast} />}
      {aboutDialogOpen && <AboutDialog snapshot={snapshot} onClose={() => setAboutDialogOpen(false)} onNotice={setToast} />}
      {jobDetail && <JobDetailDialog job={jobDetail} onClose={() => setJobDetailSelection(null)} />}
      {reviewDialog && <ReviewResolutionDialog review={reviewDialog} snapshot={snapshot} onClose={() => setReviewDialog(null)} onCreateMember={() => { setReviewDialog(null); setMemberDialogOpen(true); }} onEvidence={() => void handleOpenEvidence(snapshot.workspaceMode === 'demo'
        ? { title: reviewDialog.title, label: '门诊报告.docx · 标题块', quote: '姓名：林×（信息不完整）', meta: '文件夹归属与正文身份不能唯一匹配；确认前不会写入成员档案。' }
        : { title: reviewDialog.title, label: '本机导入资料', quote: '正在打开原始资料…', meta: reviewDialog.description, sourceSpanId: reviewDialog.evidenceRefs[0] ?? null, documentId: reviewDialog.documentId })} onResolve={handleResolveReview} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
