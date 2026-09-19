import { useEffect, useState } from 'react';
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
import { DEFAULT_AI_PREFERENCES } from '@contracts';
import type { ActionItem, AiModelOption, AiPreferences, AiReasoningEffort, CreateActionItemInput, CreateManualNoteInput, DashboardSnapshot, DeletedDocumentSummary, DiagnosticBundle, DisplayPreferences, ExportMemberSummaryInput, ImportFilesReceipt, InboxBindingSummary, InboxItem, JobSummary, ManualNote, Person, PersonSummary, ResolveReviewInput, ReviewIssue, UpdatePersonDisplayInput } from '@contracts';
import { createDemoSnapshot } from '../../../../../packages/test-fixtures/src/index.js';
import { StatusBadge, type Tone } from './components/StatusBadge.js';
import { TrendChart } from './components/TrendChart.js';

type Page = 'home' | 'people' | 'inbox' | 'processing' | 'actions' | 'settings';
type Evidence = {
  title: string;
  label: string;
  quote: string;
  meta: string;
  sourceSpanId?: string | null;
  documentId?: string | null;
  previewImageDataUrl?: string | null;
};
type DesktopBehavior = { stayInTray: boolean | null; openAtLogin: boolean; notificationsEnabled: boolean };
type RecoveryStatus = { pointCount: number; totalBytes: number; latestAt: string | null };

const navigation: Array<{ id: Page; label: string; icon: typeof Home }> = [
  { id: 'home', label: '家庭总览', icon: LayoutDashboard },
  { id: 'people', label: '成员档案', icon: UsersRound },
  { id: 'inbox', label: '报告收件箱', icon: Inbox },
  { id: 'processing', label: '处理中心', icon: Activity },
  { id: 'actions', label: '后续事项', icon: ListChecks },
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
  const model = preferences.modelId === 'gpt-5.6-sol' ? 'GPT-5.6-Sol' : preferences.modelId;
  return `${model} · ${reasoningEffortLabels[preferences.reasoningEffort]}推理`;
}

function importReceiptMessage(receipt: ImportFilesReceipt): string {
  const rejected = receipt.rejected.length;
  const base = `已保存 ${receipt.importedCount} 份资料到本机${receipt.duplicateCount ? `，跳过 ${receipt.duplicateCount} 份重复资料` : ''}${receipt.suppressedCount ? `，阻止 ${receipt.suppressedCount} 份已删除资料自动回灌` : ''}${rejected ? `，${rejected} 份未能导入` : ''}。`;
  const firstCode = receipt.rejected[0]?.code;
  if (firstCode === 'LEGACY_DOC_CONVERSION_REQUIRED') {
    return `${base} 旧版 .doc 的本机兼容组件尚未就绪，原文件已保留。可安装经过校验的兼容组件，或先另存为 .docx / 导出 PDF 后重新添加。`;
  }
  if (firstCode === 'LEGACY_DOC_TEXT_UNREADABLE') {
    return `${base} 旧版 .doc 没有可可靠读取的正文；原文件已保留，请用 Word 另存为 .docx 或导出 PDF 后重新添加。`;
  }
  if (firstCode === 'UNSUPPORTED_FORMAT' || firstCode === 'EXTENSION_NOT_ALLOWED' || firstCode === 'MAGIC_SIGNATURE_MISMATCH') {
    return `${base} 请确认文件是真实的 PDF、JPEG、PNG、HEIC/HEIF、DOCX 或 TXT，且扩展名与内容一致。`;
  }
  return base;
}

function personQuality(person: PersonSummary): { label: string; tone: Tone } {
  if (person.dataQuality === 'complete') return { label: '资料较完整', tone: 'success' };
  if (person.dataQuality === 'partial') return { label: '资料部分', tone: 'info' };
  return { label: '资料不足', tone: 'neutral' };
}

function inboxStatusPresentation(status: InboxItem['status']): { label: string; tone: Tone } {
  switch (status) {
    case 'queued': return { label: '尚未发送至 AI', tone: 'info' };
    case 'needs_review': return { label: '需要确认成员', tone: 'warning' };
    case 'duplicate': return { label: '重复资料', tone: 'neutral' };
    case 'blocked': return { label: '预处理失败', tone: 'alert' };
    case 'processing': return { label: '处理中', tone: 'info' };
    case 'completed': return { label: '已完成', tone: 'success' };
    case 'ignored': return { label: '已忽略', tone: 'neutral' };
    case 'stabilizing': return { label: '等待文件稳定', tone: 'neutral' };
    case 'discovered': return { label: '已发现', tone: 'neutral' };
  }
}

function Sidebar({ page, setPage, snapshot, onWorkspace }: {
  page: Page;
  setPage(page: Page): void;
  snapshot: DashboardSnapshot;
  onWorkspace(): void;
}) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand__mark"><HeartPulse size={22} strokeWidth={2.2} /></div>
        <div><strong>家庭健康</strong><span>本地看板</span></div>
      </div>

      <nav className="side-nav" aria-label="主导航">
        {navigation.map(({ id, label, icon: Icon }) => (
          <button key={id} className={page === id ? 'side-nav__item is-active' : 'side-nav__item'} onClick={() => setPage(id)}>
            <Icon size={19} />
            <span>{label}</span>
            {id === 'inbox' && snapshot.pendingInboxCount > 0 && <em>{snapshot.pendingInboxCount}</em>}
            {id === 'processing' && snapshot.jobs.some((job) => job.status === 'running') && <i aria-label="正在处理" />}
          </button>
        ))}
      </nav>

      <div className="sidebar__bottom">
        <div className="privacy-mini">
          <ShieldCheck size={18} />
          <div><strong>资料保存在本机</strong><span>发送前会检查授权范围</span></div>
        </div>
        <button className="workspace-switcher" onClick={onWorkspace}>
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
          {(snapshot.jobs.some((job) => ['running', 'waiting_user', 'failed'].includes(job.status)) || snapshot.reviews.some((review) => review.resolutionStatus === 'open')) && <i />}
        </button>
        <button className={accountPresentation.className} onClick={onLogin} title={snapshot.account.displayLabel ?? undefined}>
          <span className="ai-state__dot" />
          <span>{accountPresentation.label}</span>
          <ChevronDown size={15} />
        </button>
      </div>
    </header>
  );
}

function MetricStrip({ snapshot, onNavigate }: { snapshot: DashboardSnapshot; onNavigate(page: Page): void }) {
  const active = snapshot.jobs.find((job) => job.status === 'running');
  return (
    <div className="metric-strip">
      <button onClick={() => onNavigate('inbox')}>
        <span className="metric-strip__icon mint"><Inbox size={21} /></span>
        <span><strong>{snapshot.pendingInboxCount}</strong><small>份资料待处理</small></span>
        <ChevronRight size={17} />
      </button>
      <button onClick={() => onNavigate('processing')}>
        <span className="metric-strip__icon blue"><LoaderCircle size={21} className={active ? 'spin' : ''} /></span>
        <span><strong>{active ? '正在核对' : '没有运行任务'}</strong><small>{active?.statusText ?? '队列处于空闲状态'}</small></span>
        <ChevronRight size={17} />
      </button>
      <button onClick={() => onNavigate('actions')}>
        <span className="metric-strip__icon amber"><ListChecks size={21} /></span>
        <span><strong>{snapshot.actions.filter((item) => !['completed', 'dismissed'].includes(item.status)).length}</strong><small>项后续事项</small></span>
        <ChevronRight size={17} />
      </button>
      <button onClick={() => onNavigate('settings')}>
        <span className="metric-strip__icon warm"><CalendarClock size={21} /></span>
        <span><strong>{formatDateTime(snapshot.nextScheduledRun)}</strong><small>下次自动处理</small></span>
        <ChevronRight size={17} />
      </button>
    </div>
  );
}

function PersonCard({ person, selected, onClick }: { person: PersonSummary; selected: boolean; onClick(): void }) {
  const quality = personQuality(person);
  return (
    <button className={selected ? 'person-card is-selected' : 'person-card'} onClick={onClick}>
      <div className="person-card__top">
        <span className="avatar">{person.avatarInitial}</span>
        <span className="person-card__identity"><strong>{person.displayName}</strong><small>{person.relation}</small></span>
        <StatusBadge tone={quality.tone}>{quality.label}</StatusBadge>
      </div>
      <p>{person.changeSummary}</p>
      <div className="person-card__meta">
        <span>{person.freshnessLabel}</span>
        {person.attentionCount > 0 && <span className="attention-text">{person.attentionCount} 项需关注</span>}
      </div>
    </button>
  );
}

function HomePage({ snapshot, selectedPersonId, onSelectPerson, onNavigate, onOpenEvidence, onAddPerson }: {
  snapshot: DashboardSnapshot;
  selectedPersonId: string;
  onSelectPerson(id: string): void;
  onNavigate(page: Page): void;
  onOpenEvidence(evidence: Evidence): void;
  onAddPerson(): void;
}) {
  const selected = snapshot.persons.find((person) => person.id === selectedPersonId) ?? snapshot.persons[0];
  const selectedOrgans = snapshot.organs.filter((organ) => organ.personId === selected?.id);
  const primaryTrend = snapshot.trends.find((trend) => trend.personId === selected?.id);
  return (
    <div className="page-stack">
      <section className="welcome-row">
        <div>
          <span className="eyebrow">家庭总览</span>
          <h1>{new Date().getHours() < 12 ? '早上好' : new Date().getHours() < 18 ? '下午好' : '晚上好'}</h1>
          <p>这里汇总了家人最近的资料变化。已有档案离线也能查看。</p>
        </div>
        <button className="primary-button" onClick={() => onNavigate('inbox')}><Plus size={18} /> 添加健康资料</button>
      </section>

      <MetricStrip snapshot={snapshot} onNavigate={onNavigate} />

      <section className="section-block">
        <div className="section-heading">
          <div><h2>家庭成员</h2><p>点击成员查看身体和时间线</p></div>
          <button className="text-button" onClick={() => snapshot.workspaceMode === 'personal' ? onAddPerson() : onNavigate('people')}>管理成员 <ArrowRight size={16} /></button>
        </div>
        <div className="person-grid">
          {snapshot.persons.map((person) => <PersonCard key={person.id} person={person} selected={person.id === selectedPersonId} onClick={() => onSelectPerson(person.id)} />)}
          <button className="add-person-card" onClick={() => snapshot.workspaceMode === 'personal' ? onAddPerson() : onNavigate('people')}><Plus size={21} /><span>添加家庭成员</span></button>
        </div>
      </section>

      {selected && snapshot.workspaceMode === 'demo' && (
        <section className="dashboard-columns">
          <div className="panel organ-panel">
            <div className="panel__heading">
              <div><span className="eyebrow">{selected.displayName} · 身体概览</span><h2>有来源的身体信息</h2></div>
              <StatusBadge tone="info">截至 {selected.lastDocumentDate ?? '未知日期'}</StatusBadge>
            </div>
            <div className="organ-grid">
              {selectedOrgans.map((organ) => (
                <button key={organ.id} className="organ-row" onClick={() => onOpenEvidence({
                  title: `${organ.name}说明的依据`,
                  label: organ.evidenceDate ? `${organ.evidenceDate} 的虚构体检资料` : '资料不足',
                  quote: organ.summary,
                  meta: `${organ.metricCount} 项已记录指标 · ${organ.status === 'insufficient' ? '暂不作健康判断' : 'AI 整理，非医生审核'}`,
                  sourceSpanId: organ.evidenceSourceSpanId
                })}>
                  <span className={`organ-symbol organ-symbol--${organ.status}`}>{organIcon[organ.id]}</span>
                  <span><strong>{organ.name}</strong><small>{organ.summary}</small></span>
                  <StatusBadge tone={organ.status === 'attention' ? 'warning' : organ.status === 'stable' ? 'success' : 'neutral'}>
                    {organ.status === 'attention' ? '需关注' : organ.status === 'stable' ? '记录平稳' : '资料不足'}
                  </StatusBadge>
                  <ChevronRight size={17} />
                </button>
              ))}
            </div>
          </div>

          <aside className="right-stack">
            <div className="panel calm-note">
              <span className="eyebrow">本次变化</span>
              <h3>先关注两件事</h3>
              <ol>
                <li><span>1</span><div><strong>血脂记录较前升高</strong><p>这是趋势描述，不等于诊断。建议带着原报告咨询医生。</p></div></li>
                <li><span>2</span><div><strong>肝功能有一项轻度偏高</strong><p>需要结合近期饮酒、用药与医生意见核实。</p></div></li>
              </ol>
            </div>
            <div className="panel compact-actions">
              <div className="panel__heading"><h3>接下来</h3><button className="text-button" onClick={() => onNavigate('actions')}>查看全部</button></div>
              {snapshot.actions.filter((item) => item.personId === selected.id && item.status !== 'completed').slice(0, 2).map((item) => (
                <div key={item.id} className="mini-action"><span className="check-ring" /><div><strong>{item.title}</strong><small>{item.dueText ?? '没有固定日期'}</small></div></div>
              ))}
            </div>
          </aside>
        </section>
      )}

      {selected && snapshot.workspaceMode === 'personal' && (
        <section className="panel getting-started-panel">
          <span className="getting-started-panel__icon"><ShieldCheck size={24} /></span>
          <div>
            <span className="eyebrow">个人工作区已建立</span>
            <h2>{primaryTrend ? '报告事实已更新，健康解释仍待独立复核' : selected.documentCount > 0 ? '资料已保存在本机，等待处理' : '先添加一份健康资料'}</h2>
            <p>{primaryTrend
              ? '下方只展示报告中有来源、带日期且单位一致的数值记录，不把它们自动解释成诊断。'
              : selected.documentCount > 0
              ? '当前没有经过接纳的健康结论，因此不会显示虚构趋势或健康判断。连接 Codex 并授权后才能开始 AI 处理。'
              : '支持 PDF、图片、DOCX 和纯文本；旧版 .doc 会先由经校验的本机兼容组件转换。导入到本地与发送给 AI 是两件分开的事。'}</p>
          </div>
          <button className="primary-button" onClick={() => onNavigate('inbox')}><Plus size={18} /> 前往收件箱</button>
        </section>
      )}

      {primaryTrend && (
        <section className="panel trend-panel">
          <div className="panel__heading">
            <div><span className="eyebrow">可比较趋势</span><h2>{primaryTrend.name}</h2></div>
            <strong className="latest-value">{primaryTrend.points.at(-1)?.displayValue}<small>{primaryTrend.unit}</small></strong>
          </div>
          <div className="trend-panel__body">
            <TrendChart series={primaryTrend} onSelectPoint={(pointIndex) => {
              const point = primaryTrend.points[pointIndex];
              if (point) onOpenEvidence({ title: `${primaryTrend.name}原始依据`, label: point.sourceLabel, quote: `${primaryTrend.name} ${point.displayValue} ${primaryTrend.unit ?? ''}`, meta: `报告参考范围：${point.referenceLow ?? '未知'}–${point.referenceHigh ?? '未知'} ${primaryTrend.unit ?? ''}`, sourceSpanId: point.sourceSpanId, documentId: point.documentId });
            }} />
            <div className="trend-explanation"><StatusBadge tone="warning">报告标记偏高</StatusBadge><p>{primaryTrend.interpretation}</p><small>{primaryTrend.comparisonNote}</small></div>
          </div>
        </section>
      )}
    </div>
  );
}

function PeoplePage({ snapshot, selectedPersonId, onSelectPerson, onOpenEvidence, onAddPerson, onEditPerson, onArchivedPeople, onAddNote, onExport, onImport, onExcludeDocument, onReincludeDocument, onDeleteDocument, onDeletedDocuments }: {
  snapshot: DashboardSnapshot;
  selectedPersonId: string;
  onSelectPerson(id: string): void;
  onOpenEvidence(evidence: Evidence): void;
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
  const person = snapshot.persons.find((item) => item.id === selectedPersonId) ?? snapshot.persons[0];
  const [tab, setTab] = useState<'overview' | 'body' | 'metrics' | 'timeline' | 'guide' | 'documents'>('overview');
  const [metricVisibleCount, setMetricVisibleCount] = useState(12);
  if (!person) return <div className="page-stack"><section className="panel personal-empty-state"><Archive size={28} /><div><span className="eyebrow">成员档案</span><h1>当前没有显示中的成员</h1><p>你可以新增成员，或恢复已归档成员。归档不会删除原始报告和历史记录。</p><div className="button-row"><button className="primary-button" onClick={onAddPerson}><Plus size={17} /> 添加成员</button><button className="secondary-button" onClick={onArchivedPeople}><Archive size={17} /> 已归档成员</button></div></div></section></div>;
  const tabs = [
    ['overview', '概览'], ['body', '身体'], ['metrics', '指标'], ['timeline', '时间线'], ['guide', '生活指南'], ['documents', '资料']
  ] as const;
  const isDemo = snapshot.workspaceMode === 'demo';
  const personOrgans = snapshot.organs.filter((organ) => organ.personId === person.id);
  const personTrends = snapshot.trends.filter((trend) => trend.personId === person.id);
  const personGuidance = snapshot.guidance.filter((item) => item.personId === person.id);
  const hasAcceptedFacts = person.acceptedFactCount > 0;
  const personNotes = snapshot.notes.filter((note) => note.personId === person.id);
  const hasManualNotes = personNotes.length > 0;
  return (
    <div className="page-stack">
      <div className="member-header panel">
        <div className="member-header__identity"><span className="avatar avatar--large">{person.avatarInitial}</span><div><span className="eyebrow">成员档案</span><h1>{person.displayName}</h1><p>{person.relation} · {person.documentCount} 份资料 · {person.freshnessLabel}</p></div></div>
        <div className="member-header__actions">
          <select value={person.id} onChange={(event) => { setMetricVisibleCount(12); onSelectPerson(event.target.value); }} aria-label="切换成员">
            {snapshot.persons.map((item) => <option key={item.id} value={item.id}>{item.displayName} · {item.relation}</option>)}
          </select>
          {snapshot.workspaceMode === 'personal' && <button className="secondary-button" onClick={onEditPerson}>编辑成员</button>}
          {snapshot.workspaceMode === 'personal' && <button className="secondary-button" onClick={onAddPerson}><Plus size={17} /> 添加成员</button>}
          {snapshot.workspaceMode === 'personal' && <button className="secondary-button" onClick={onArchivedPeople}><Archive size={17} /> 已归档成员</button>}
          {snapshot.workspaceMode === 'personal' && <button className="secondary-button" onClick={onExport}><FileCheck2 size={17} /> 导出摘要</button>}
          {snapshot.workspaceMode === 'personal' && <button className="primary-button" onClick={onAddNote}><Plus size={17} /> 补充健康资料</button>}
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
              ? '文件已进入本地收件箱。连接 Codex、确认授权并完成事实核对后，这里才会出现身体、指标、时间线和生活指南。'
              : '请从报告收件箱导入资料。没有证据时，应用不会生成健康判断。'}</p>
          </div>
        </section>
      )}
      {!isDemo && (hasAcceptedFacts || hasManualNotes) && tab === 'overview' && (
        <div className="member-overview-grid">
          <section className="panel narrative-panel">
            <span className="eyebrow">{hasAcceptedFacts ? '已接纳的报告事实' : '本人补充资料'}</span>
            <h2>{hasAcceptedFacts ? (person.derivedStatus === 'current' ? (person.assessmentSummary ?? '分析说明已完成复核') : '事实已入库，分析说明仍待生成和复核') : '目前只有本人填写的健康资料'}</h2>
            <p>{hasAcceptedFacts ? (person.derivedStatus === 'current' ? '以下说明由 AI 根据已接纳事实整理并经过独立安全复核，不替代医生诊断。' : '这里先展示报告明确写出的值、日期和异常标记。应用不会仅凭这些记录自动作出诊断或治疗建议。') : '这些内容不是医院检验或医生诊断；后续如用于 AI 整理，仍会保留“本人自述”的来源。'}</p>
            <StatusBadge tone={person.derivedStatus === 'current' ? 'success' : 'info'}>{person.derivedStatus === 'current' ? '派生说明已复核' : person.derivedStatus === 'stale' ? '背景已变化，说明待更新' : person.freshnessLabel}</StatusBadge>
          </section>
          <section className="panel wide-panel">
            <div className="panel__heading"><div><span className="eyebrow">八大系统</span><h2>有来源的身体信息</h2></div><StatusBadge tone="neutral">不计算健康总分</StatusBadge></div>
            <div className="organ-card-grid">{personOrgans.map((organ) => <button key={organ.id} onClick={() => setTab('body')}><span className={`organ-symbol organ-symbol--${organ.status}`}>{organIcon[organ.id]}</span><strong>{organ.name}</strong><small>{organ.summary}</small><ChevronRight size={16} /></button>)}</div>
          </section>
          {hasManualNotes && <ManualNotesCard notes={personNotes} />}
        </div>
      )}
      {!isDemo && hasAcceptedFacts && tab === 'body' && <section className="panel"><div className="panel__heading"><div><span className="eyebrow">身体轴</span><h2>按器官系统阅读报告事实</h2></div></div><div className="organ-grid organ-grid--roomy">{personOrgans.map((organ) => <button key={organ.id} className="organ-row" disabled={!organ.evidenceSourceSpanId} onClick={() => onOpenEvidence({ title: `${organ.name}说明的依据`, label: organ.evidenceDate ?? '未知资料日期', quote: organ.summary, meta: `${organ.metricCount} 项相关记录`, sourceSpanId: organ.evidenceSourceSpanId })}><span className={`organ-symbol organ-symbol--${organ.status}`}>{organIcon[organ.id]}</span><span><strong>{organ.name}</strong><small>{organ.summary}</small></span><StatusBadge tone={organ.status === 'attention' ? 'warning' : organ.status === 'stable' ? 'success' : 'neutral'}>{organ.status === 'attention' ? '报告有标记' : organ.status === 'stable' ? '报告未标记异常' : '资料不足'}</StatusBadge></button>)}</div></section>}
      {!isDemo && hasAcceptedFacts && tab === 'metrics' && <section className="panel"><div className="panel__heading"><div><span className="eyebrow">指标轴</span><h2>带日期、同单位的记录</h2></div><StatusBadge tone="neutral">先显示 {Math.min(metricVisibleCount, personTrends.length)} / {personTrends.length} 项</StatusBadge></div>{personTrends.length > 0 ? personTrends.slice(0, metricVisibleCount).map((series) => <div key={series.id} className="metric-detail"><div><strong>{series.name}</strong><p>{series.interpretation}</p></div><TrendChart series={series} onSelectPoint={(index) => { const point = series.points[index]; if (point) onOpenEvidence({ title: series.name, label: point.sourceLabel, quote: `${series.name} ${point.displayValue} ${series.unit ?? ''}`, meta: `报告参考范围：${point.referenceLow ?? '未知'}–${point.referenceHigh ?? '未知'} ${series.unit ?? ''}`, sourceSpanId: point.sourceSpanId, documentId: point.documentId }); }} /></div>) : <div className="table-empty"><Activity size={24} /><strong>没有可连线的数值记录</strong><span>未知日期、定性结果或带比较符的数值不会被伪装成精确趋势。</span></div>}{personTrends.length > metricVisibleCount && <div className="dialog-actions"><button className="secondary-button" onClick={() => setMetricVisibleCount((count) => count + 12)}>再显示 {Math.min(12, personTrends.length - metricVisibleCount)} 项指标</button></div>}</section>}
      {!isDemo && hasAcceptedFacts && tab === 'guide' && personGuidance.length > 0 && <div className="guide-grid"><section className="panel guide-hero"><span className="eyebrow">日常生活指南 · 已复核</span><h2>从低风险、容易坚持的方向开始</h2><p>这些内容基于现有报告事实，不替代医生给出的个体化治疗。</p><div className="priority-list">{personGuidance.map((item, index) => <div key={item.id}><span>{index + 1}</span><p><strong>{item.title}</strong>{item.detail}</p></div>)}</div></section><section className="panel"><span className="eyebrow">证据边界</span><h3>每条建议都有本地事实依据</h3><p className="body-copy">共引用 {personGuidance.reduce((total, item) => total + item.evidenceCount, 0)} 条已接纳事实；标记为需要专业确认的内容仍应带着原报告咨询医生。</p><StatusBadge tone="info">一般教育内容</StatusBadge></section></div>}
      {!isDemo && hasAcceptedFacts && tab === 'guide' && personGuidance.length === 0 && <section className="panel personal-empty-state"><ShieldCheck size={28} /><div><span className="eyebrow">尚未生成这一层内容</span><h2>生活指南需要独立生成与安全复核</h2><p>已接纳的报告事实不会丢失；缺少对应投影时保持空白，不用演示数据替代。</p></div></section>}
      {!isDemo && tab === 'timeline' && <PersonalTimelineView key={`timeline-${person.id}`} snapshot={snapshot} personId={person.id} onOpenEvidence={onOpenEvidence} />}
      {!isDemo && tab === 'documents' && <PersonalDocumentsView key={`documents-${person.id}`} snapshot={snapshot} personId={person.id} onOpenEvidence={onOpenEvidence} onImport={onImport} onExclude={onExcludeDocument} onReinclude={onReincludeDocument} onDelete={onDeleteDocument} onDeletedDocuments={onDeletedDocuments} />}
      {isDemo && tab === 'overview' && (
        <div className="member-overview-grid">
          <section className="panel narrative-panel">
            <span className="eyebrow">综合说明 · AI 整理</span>
            <h2>最近资料里，最值得留意的是血脂变化</h2>
            <p>2024 至 2026 年的三次记录显示，低密度脂蛋白胆固醇从 3.6、3.9 到 4.2 mmol/L。本次报告参考上限为 3.4 mmol/L。这个变化值得在下次就诊时带上原报告咨询医生。</p>
            <button className="evidence-link" onClick={() => onOpenEvidence({ title: '综合说明的依据', label: '三次虚构年度体检报告', quote: 'LDL-C：3.6 → 3.9 → 4.2 mmol/L', meta: 'AI 根据已接纳事实整理；不是诊断或医生审核' })}><FileCheck2 size={17} /> 查看 3 条依据</button>
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
  return <section className="panel"><div className="panel__heading"><div><span className="eyebrow">原始资料</span><h2>资料与证据</h2></div><div className="button-row"><StatusBadge tone="neutral">显示 {Math.min(visibleCount, documents.length)} / {documents.length} 份</StatusBadge><button className="secondary-button" onClick={onDeletedDocuments}><Trash2 size={17} /> 已删除资料</button><button className="secondary-button" onClick={onImport}><Plus size={17} /> 添加资料</button></div></div>{documents.length > 0 ? <><div className="document-list">{visibleDocuments.map((document) => <article className="document-row" key={document.id}><button className="document-row__open" onClick={() => onOpenEvidence({ title: document.displayName, label: document.sourceLabel, quote: '正在读取这份资料的第一个受控片段…', meta: `${document.format} · 导入于 ${formatDateTime(document.discoveredAt)}`, documentId: document.id })}><span className="file-icon"><FileText size={20} /></span><span><strong>{document.displayName}</strong><small>{document.format} · {inboxStatusPresentation(document.status).label} · 导入于 {formatDateTime(document.discoveredAt)}</small>{document.issue && <small>{document.issue}</small>}</span><ChevronRight size={17} /></button><div className="button-row">{document.status === 'ignored' ? <button className="text-button" onClick={() => onReinclude(document)}><RefreshCw size={15} /> 重新纳入</button> : <button className="text-button" onClick={() => onExclude(document)}><Archive size={15} /> 移出分析</button>}<button className="text-button danger-text" onClick={() => onDelete(document)}><Trash2 size={15} /> 删除本机档案</button></div></article>)}</div>{documents.length > visibleCount && <div className="dialog-actions"><button className="secondary-button" onClick={() => setVisibleCount((count) => count + 50)}>再显示 {Math.min(50, documents.length - visibleCount)} 份资料</button></div>}</> : <div className="table-empty"><FileText size={24} /><strong>还没有原始资料</strong><span>添加后的原始字节会保存在本机不可变对象库中。</span></div>}</section>;
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

function InboxPage({ snapshot, onProcess, onImport, onDropFiles, onAssign, onIgnore, onOpenEvidence, onDirectories, onProcessingCenter }: { snapshot: DashboardSnapshot; onProcess(documentIds?: string[]): void; onImport(): void; onDropFiles(files: File[], personId: string | null): void; onAssign(documentIds: string[], personId: string): Promise<void>; onIgnore(documentIds: string[]): Promise<void>; onOpenEvidence(evidence: Evidence): void; onDirectories(): void; onProcessingCenter(): void }) {
  const [filter, setFilter] = useState<'all' | InboxItem['status']>('all');
  const [personFilter, setPersonFilter] = useState('all');
  const [dropPersonId, setDropPersonId] = useState<string>(snapshot.persons[0]?.id ?? '');
  const [assignPersonId, setAssignPersonId] = useState<string>(snapshot.persons[0]?.id ?? '');
  const [dragActive, setDragActive] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [visibleCount, setVisibleCount] = useState(50);
  const inboxItems = snapshot.inbox.filter((item) => !item.inProcessingCenter);
  const items = inboxItems.filter((item) => (filter === 'all' || item.status === filter)
    && (personFilter === 'all' || (personFilter === 'unassigned' ? item.personId === null : item.personId === personFilter)));
  const visibleItems = items.slice(0, visibleCount);
  const selected = inboxItems.filter((item) => selectedIds.includes(item.id));
  const readyInboxCount = inboxItems.filter((item) => item.status === 'queued' && item.personId !== null).length;
  const assignableIds = selected.filter((item) => item.status === 'needs_review' && item.personId === null).map((item) => item.id);
  const processableIds = selected.filter((item) => item.status === 'queued' && item.personId !== null).map((item) => item.id);
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
  return <div className="page-stack"><section className="page-title-row"><div><span className="eyebrow">报告收件箱</span><h1>这里只放还没开始处理的新资料</h1><p>一旦开始处理，资料会从收件箱移到处理中心；失败、重试和进度都在那里管理。</p></div><div className="button-row"><button className="secondary-button" onClick={onImport}><Plus size={17} /> 添加文件</button><button className="primary-button" disabled={readyInboxCount === 0} onClick={() => onProcess()}><Play size={17} /> 立即处理全部</button></div></section>{snapshot.workspaceMode === 'personal' && <section className={`panel drop-zone${dragActive ? ' is-dragging' : ''}`} onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }} onDragLeave={(event) => { if (event.currentTarget === event.target) setDragActive(false); }} onDrop={(event) => { event.preventDefault(); setDragActive(false); const files = Array.from(event.dataTransfer.files); if (files.length > 0) onDropFiles(files, dropPersonId || null); }}><div><FileText size={22} /><span><strong>拖入 PDF、图片、DOCX 或 TXT</strong><small>旧版 .doc 会保留原文件并提示先转换；任何资料都不会因为拖入就发送给 AI。最多一次 100 份，每份不超过 100MB。</small></span></div><label>归属成员<select value={dropPersonId} onChange={(event) => setDropPersonId(event.target.value)}><option value="">待确认</option>{snapshot.persons.map((person) => <option key={person.id} value={person.id}>{person.displayName} · {person.relation}</option>)}</select></label></section>}<section className="panel"><div className="toolbar inbox-toolbar"><div className="filter-tabs"><button className={filter === 'all' ? 'is-active' : ''} onClick={() => { setFilter('all'); setVisibleCount(50); }}>全部 {inboxItems.length}</button><button className={filter === 'queued' ? 'is-active' : ''} onClick={() => { setFilter('queued'); setVisibleCount(50); }}>待处理 {inboxItems.filter((item) => item.status === 'queued').length}</button><button className={filter === 'needs_review' ? 'is-active' : ''} onClick={() => { setFilter('needs_review'); setVisibleCount(50); }}>待归属 {inboxItems.filter((item) => item.status === 'needs_review').length}</button></div><label className="compact-select">成员<select aria-label="按成员筛选" value={personFilter} onChange={(event) => { setPersonFilter(event.target.value); setVisibleCount(50); }}><option value="all">全部成员</option><option value="unassigned">待归属</option>{snapshot.persons.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}</select></label></div>{selected.length > 0 && <div className="bulk-actions" role="group" aria-label="批量处理选中资料"><strong>已选 {selected.length} 份</strong><label>归属为<select aria-label="批量归属成员" value={assignPersonId} onChange={(event) => setAssignPersonId(event.target.value)}>{snapshot.persons.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}</select></label><button className="secondary-button" disabled={bulkBusy || assignableIds.length === 0 || !assignPersonId} onClick={() => void runBulk(() => onAssign(assignableIds, assignPersonId))}>分配待归属项{assignableIds.length ? ` (${assignableIds.length})` : ''}</button><button className="secondary-button" disabled={bulkBusy || ignorableIds.length === 0} onClick={() => void runBulk(() => onIgnore(ignorableIds))}>移出分析{ignorableIds.length ? ` (${ignorableIds.length})` : ''}</button><button className="primary-button" disabled={bulkBusy || processableIds.length === 0} onClick={() => onProcess(processableIds)}><Play size={16} /> 处理选中项{processableIds.length ? ` (${processableIds.length})` : ''}</button></div>}<div className="inbox-table"><div className="inbox-table__head inbox-table__head--selectable"><label className="select-cell"><input aria-label="选中当前筛选结果" type="checkbox" checked={allVisibleSelected} onChange={() => setSelectedIds((current) => allVisibleSelected ? current.filter((id) => !items.some((item) => item.id === id)) : [...new Set([...current, ...items.map((item) => item.id)])])} /></label><span>资料</span><span>成员</span><span>发现时间</span><span>状态</span><span /></div>{visibleItems.map((item) => <InboxRow key={item.id} item={item} selected={selectedIds.includes(item.id)} onToggle={() => toggleSelection(item.id)} onOpen={() => onOpenEvidence({ title: item.displayName, label: item.sourceLabel, quote: '正在读取受控来源片段…', meta: '界面不会获取本机文件路径。', documentId: item.id })} />)}</div>{items.length > visibleCount && <div className="dialog-actions"><button className="secondary-button" onClick={() => setVisibleCount((count) => count + 50)}>再显示 {Math.min(50, items.length - visibleCount)} 份资料</button></div>}{items.length === 0 && <div className="table-empty"><Inbox size={24} /><strong>{inboxItems.length === 0 ? '新资料已全部移交' : '没有符合条件的资料'}</strong><span>{inboxItems.length === 0 ? '处理中、已完成或失败的任务都去处理中心查看；原始资料仍保留在成员档案中。' : '可以更换状态或成员筛选。'}</span>{inboxItems.length === 0 && <button className="secondary-button" onClick={onProcessingCenter}>前往处理中心</button>}</div>}</section><div className="info-callout"><ShieldCheck size={20} /><div><strong>自动处理范围</strong><p>只处理已绑定成员且已授权的本地目录；公共待归属资料在确认前不会发送。</p></div><button className="text-button" onClick={onDirectories}>查看授权范围</button></div></div>;
}

function InboxRow({ item, selected, onToggle, onOpen }: { item: InboxItem; selected: boolean; onToggle(): void; onOpen(): void }) {
  const status = inboxStatusPresentation(item.status);
  return <div className="inbox-table__row inbox-table__row--selectable"><label className="select-cell"><input aria-label={`选中 ${item.displayName}`} type="checkbox" checked={selected} onChange={onToggle} /></label><span className="file-cell"><span className="file-icon"><FileText size={19} /></span><span><strong>{item.displayName}</strong><small>{item.format} · {item.sourceLabel}</small></span></span><span>{item.personLabel ?? <span className="attention-text">待确认</span>}</span><span>{formatDateTime(item.discoveredAt)}</span><span><StatusBadge tone={status.tone}>{status.label}</StatusBadge>{item.issue && <small className="row-note">{item.issue}</small>}</span><button className="icon-button" aria-label={`查看 ${item.displayName} 的来源`} onClick={onOpen}><FileText size={18} /></button></div>;
}

function ProcessingPage({ snapshot, onCancel, onRetry, onTogglePause, onDetails }: { snapshot: DashboardSnapshot; onCancel(job: JobSummary): void; onRetry(job: JobSummary): void; onTogglePause(): void; onDetails(job: JobSummary): void }) {
  return <div className="page-stack">
    <section className="page-title-row"><div><span className="eyebrow">处理中心</span><h1>每一步都能看懂、能恢复</h1><p>技术等待不会被误写成健康风险，已保存的事实不会因后续失败回滚。</p></div><button className="secondary-button" onClick={onTogglePause}>{snapshot.queuePaused ? <Play size={17} /> : <Pause size={17} />}{snapshot.queuePaused ? '继续队列' : '暂停队列'}</button></section>
    {snapshot.queuePaused && <div className="info-callout"><Pause size={20} /><div><strong>队列已暂停</strong><p>不会领取新的 AI 任务；正在进行的原子步骤会安全收口，日程设置和已保存资料不受影响。</p></div></div>}
    <div className="job-grid">{snapshot.jobs.map((job) => <article className="panel job-card" key={job.id}>
      <div className="job-card__top"><span className={`job-icon job-icon--${job.status}`}>{job.status === 'running' ? <LoaderCircle className="spin" size={21} /> : job.status === 'succeeded' ? <Check size={21} /> : <Clock3 size={21} />}</span><div><strong>{job.batchLabel}</strong><small>{job.personLabel ?? '待归属资料'} · {job.statusText}</small></div><StatusBadge tone={job.status === 'running' ? 'info' : job.status === 'succeeded' ? 'success' : 'warning'}>{job.status === 'running' ? '处理中' : job.status === 'succeeded' ? '已完成' : job.status === 'failed' ? '处理失败' : job.status === 'cancelled' ? '已停止' : job.status === 'waiting_user' ? '等待核对' : '等待处理'}</StatusBadge></div>
      <div className="progress-row"><div><i style={{ width: `${Math.round(job.completedUnits / job.totalUnits * 100)}%` }} /></div><span>{job.status === 'waiting_user' ? '已检查 ' : ''}{job.completedUnits}/{job.totalUnits}</span></div>
      <div className="job-card__footer"><span>最近更新：{formatDateTime(job.updatedAt)}</span><div>{job.canCancel && <button className="text-button" onClick={() => onCancel(job)}>停止</button>}{job.canRetry && <button className="text-button" onClick={() => onRetry(job)}><RefreshCw size={15} /> 重试</button>}<button className="text-button" onClick={() => onDetails(job)}>查看详情 <ChevronRight size={15} /></button></div></div>
    </article>)}</div>
    {snapshot.jobs.length === 0 && <section className="panel table-empty"><Clock3 size={24} /><strong>还没有处理任务</strong><span>导入资料后，可手动开始或等待已启用的每日检查。</span></section>}
    <section className="panel process-explainer"><span className="eyebrow">工作方式</span><h2>模型给候选，应用负责正式保存</h2><div className="process-flow"><span>本地预处理</span><ArrowRight /><span>提取</span><ArrowRight /><span>独立核对</span><ArrowRight /><span>规则接纳</span><ArrowRight /><span>增量更新</span></div><p>正常资料会自动完成。只有成员归属、关键数值冲突或安全问题需要你处理。</p></section>
  </div>;
}

const jobStageLabel: Record<JobSummary['stage'], string> = {
  normalize: '本地预处理',
  identify: '成员与资料识别',
  extract: '事实提取',
  review_facts: '独立事实核对',
  accept_facts: '规则接纳与发布事实',
  analyze: '综合说明',
  guidance: '生活指南',
  review_derived: '派生内容安全核对',
  publish: '发布说明'
};

function JobDetailDialog({ job, onClose }: { job: JobSummary; onClose(): void }) {
  const percentage = Math.round(job.completedUnits / job.totalUnits * 100);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="member-dialog job-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="job-detail-title"><header><div><span className="eyebrow">处理任务</span><h2 id="job-detail-title">{job.batchLabel}</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭任务详情"><X size={19} /></button></header><p>{job.personLabel ?? '这批资料尚未完成成员归属'}。这里显示可审查的处理阶段，不展示模型的内部推理。</p><dl className="detail-list"><div><dt>当前阶段</dt><dd>{jobStageLabel[job.stage]}</dd></div><div><dt>当前状态</dt><dd>{job.statusText}</dd></div><div><dt>完成进度</dt><dd>{job.completedUnits}/{job.totalUnits}（{percentage}%）</dd></div><div><dt>最近更新</dt><dd>{formatDateTime(job.updatedAt)}</dd></div></dl><div className="info-callout compact"><ShieldCheck size={18} /><div><strong>失败不会抹掉已保存事实</strong><p>派生说明未通过安全核对时，只阻止发布说明；已经接纳的报告事实仍保留。</p></div></div><div className="dialog-actions"><button className="primary-button" onClick={onClose}>知道了</button></div></section></div>;
}

function CancelJobDialog({ job, onClose, onConfirm }: { job: JobSummary; onClose(): void; onConfirm(): Promise<boolean> }) {
  const [busy, setBusy] = useState(false);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="member-dialog" role="dialog" aria-modal="true" aria-labelledby="cancel-job-title"><header><div><span className="eyebrow">停止任务</span><h2 id="cancel-job-title">停止这项处理？</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭停止任务确认"><X size={19} /></button></header><p>将中断本应用当前的 AI 处理。已经原子保存的报告事实会保留，尚未完成的分析不会冒充已完成。</p><div className="info-callout compact"><ShieldCheck size={18} /><div><strong>{job.personLabel ?? '当前资料'} · 已完成 {job.completedUnits}/{job.totalUnits}</strong><p>不会终止你在其他 Codex 客户端中的任务。</p></div></div><div className="dialog-actions"><button className="secondary-button" onClick={onClose}>继续处理</button><button className="primary-button" disabled={busy} onClick={async () => { setBusy(true); try { if (await onConfirm()) onClose(); } finally { setBusy(false); } }}>{busy ? <LoaderCircle size={18} className="spin" /> : <Pause size={18} />} 确认停止</button></div></section></div>;
}

const actionStatusOptions: Array<{ value: ActionItem['status']; label: string }> = [
  { value: 'proposed', label: '待讨论' },
  { value: 'discussed', label: '已讨论' },
  { value: 'planned', label: '已安排' },
  { value: 'completed', label: '已完成' },
  { value: 'dismissed', label: '不再处理' }
];

function ActionsPage({ snapshot, onCreate, onUpdate }: {
  snapshot: DashboardSnapshot;
  onCreate(): void;
  onUpdate(item: ActionItem, status: ActionItem['status']): void;
}) {
  const open = snapshot.actions.filter((item) => !['completed', 'dismissed'].includes(item.status));
  const done = snapshot.actions.filter((item) => item.status === 'completed');
  return <div className="page-stack"><section className="page-title-row"><div><span className="eyebrow">后续事项</span><h1>把“之后要做什么”单独留下</h1><p>医生原文、AI 提议和本人安排会明确区分；完成事项不会被下一次 AI 更新重新打开。</p></div><button className="primary-button" onClick={onCreate}><Plus size={17} /> 新建事项</button></section><div className="action-layout"><section className="panel"><div className="panel__heading"><h2>待处理</h2><StatusBadge tone="warning">{open.length} 项</StatusBadge></div>{open.length > 0 ? <div className="action-list">{open.map((item) => <ActionRow key={item.id} item={item} snapshot={snapshot} onUpdate={onUpdate} />)}</div> : <div className="table-empty action-empty"><Check size={24} /><strong>目前没有待处理事项</strong><span>可以把下次复查、就诊时要问的问题或自己的安排记在这里。</span></div>}</section><aside className="panel completed-panel"><div className="panel__heading"><h3>最近完成</h3><Archive size={18} /></div>{done.length > 0 ? done.map((item) => <div className="completed-item" key={item.id}><Check size={16} /><div><strong>{item.title}</strong><small>{item.evidenceLabel ?? '本人事项'}</small></div></div>) : <p className="muted-copy">还没有已完成事项。</p>}</aside></div></div>;
}

function ActionRow({ item, snapshot, onUpdate }: { item: ActionItem; snapshot: DashboardSnapshot; onUpdate(item: ActionItem, status: ActionItem['status']): void }) {
  const person = snapshot.persons.find((person) => person.id === item.personId);
  const origin = item.origin === 'clinician_document' ? ['报告中的医生意见', 'success'] : item.origin === 'ai_proposed' ? ['AI 提议，待咨询', 'info'] : ['本人安排', 'neutral'];
  return <div className="action-row"><button className="check-ring" aria-label={`完成 ${item.title}`} onClick={() => onUpdate(item, 'completed')} /><div className="action-row__body"><div><StatusBadge tone={origin[1] as Tone}>{origin[0]}</StatusBadge><span>{person?.displayName}</span></div><strong>{item.title}</strong>{item.detail && <p>{item.detail}</p>}<small>{item.dueDate ?? item.dueText ?? '没有固定日期'} · {item.evidenceLabel ?? '本人事项'}</small></div><label className="action-status"><span className="sr-only">更改 {item.title} 的状态</span><select aria-label={`更改 ${item.title} 的状态`} value={item.status} onChange={(event) => onUpdate(item, event.target.value as ActionItem['status'])}>{actionStatusOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label></div>;
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
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="member-dialog action-dialog" role="dialog" aria-modal="true" aria-labelledby="action-dialog-title"><header><div><span className="eyebrow">本人安排</span><h2 id="action-dialog-title">新建后续事项</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭新建事项"><X size={19} /></button></header><p>这是你自己记录的安排，不会被标成医生意见或 AI 结论。</p><label>家庭成员<select value={personId} onChange={(event) => setPersonId(event.target.value)}>{snapshot.persons.map((person) => <option key={person.id} value={person.id}>{person.displayName} · {person.relation}</option>)}</select></label><label>事项名称<input value={title} maxLength={160} autoComplete="off" placeholder="例如：下次就诊时询问 LDL 变化" onChange={(event) => setTitle(event.target.value)} /></label><label>补充说明（可选）<textarea value={detail} maxLength={1200} rows={3} placeholder="写下要带的资料或想确认的问题" onChange={(event) => setDetail(event.target.value)} /></label><div className="action-due-grid"><label>具体日期（可选）<input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></label><label>或者写时间说明<input value={dueText} maxLength={160} placeholder="例如：下次复诊时" onChange={(event) => setDueText(event.target.value)} /></label></div><div className="dialog-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!canSave || busy} onClick={async () => { setBusy(true); try { if (await onCreate({ personId, title: title.trim(), detail: detail.trim(), dueDate: dueDate || null, dueText: dueText.trim() || null })) onClose(); } finally { setBusy(false); } }}>{busy ? <LoaderCircle size={18} className="spin" /> : <Check size={18} />} 保存事项</button></div></section></div>;
}

function ManualNoteDialog({ snapshot, selectedPersonId, onClose, onCreate }: {
  snapshot: DashboardSnapshot;
  selectedPersonId: string;
  onClose(): void;
  onCreate(input: CreateManualNoteInput): Promise<boolean>;
}) {
  const [personId, setPersonId] = useState(selectedPersonId || snapshot.persons[0]?.id || '');
  const [kind, setKind] = useState<CreateManualNoteInput['kind']>('history');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [text, setText] = useState('');
  const [measurementName, setMeasurementName] = useState('');
  const [measurementValue, setMeasurementValue] = useState('');
  const [measurementUnit, setMeasurementUnit] = useState('');
  const [busy, setBusy] = useState(false);
  const person = snapshot.persons.find((item) => item.id === personId);
  const isMeasurement = kind === 'self_measurement';
  const canSave = Boolean(person && (isMeasurement ? measurementName.trim() && measurementValue.trim() : text.trim()));
  const save = async () => {
    if (!person) return false;
    const structuredFields = isMeasurement ? {
      measurementName: measurementName.trim(),
      value: measurementValue.trim(),
      unit: measurementUnit.trim()
    } : {};
    const immutableText = isMeasurement
      ? `${measurementName.trim()}：${measurementValue.trim()}${measurementUnit.trim() ? ` ${measurementUnit.trim()}` : ''}${text.trim() ? `；${text.trim()}` : ''}`
      : text.trim();
    return onCreate({ personId, kind, immutableText, effectiveDate: effectiveDate || null, structuredFields, expectedContextRevision: person.clinicalContextRevision });
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="member-dialog manual-note-dialog" role="dialog" aria-modal="true" aria-labelledby="manual-note-title"><header><div><span className="eyebrow">本人补充</span><h2 id="manual-note-title">补充健康资料</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭补充健康资料"><X size={19} /></button></header><p>原文会按你填写的内容保存在本机，并明确标为本人自述。这里不提供诊断或用药调整建议。</p><div className="action-due-grid"><label>家庭成员<select value={personId} onChange={(event) => setPersonId(event.target.value)}>{snapshot.persons.map((item) => <option key={item.id} value={item.id}>{item.displayName} · {item.relation}</option>)}</select></label><label>资料类型<select value={kind} onChange={(event) => setKind(event.target.value as CreateManualNoteInput['kind'])}><option value="history">既往情况</option><option value="allergy">过敏记录</option><option value="medication">用药记录</option><option value="self_measurement">本人自测</option><option value="free_text">补充说明</option></select></label></div><label>发生或测量日期（可选）<input type="date" value={effectiveDate} onChange={(event) => setEffectiveDate(event.target.value)} /></label>{isMeasurement ? <><div className="measurement-grid"><label>自测项目<input value={measurementName} maxLength={80} placeholder="例如：晨起血压" onChange={(event) => setMeasurementName(event.target.value)} /></label><label>结果<input value={measurementValue} maxLength={120} placeholder="例如：128/82" onChange={(event) => setMeasurementValue(event.target.value)} /></label><label>单位（可选）<input value={measurementUnit} maxLength={40} placeholder="例如：mmHg" onChange={(event) => setMeasurementUnit(event.target.value)} /></label></div><label>补充说明（可选）<textarea value={text} maxLength={4000} rows={3} placeholder="例如：在家静坐 5 分钟后测量" onChange={(event) => setText(event.target.value)} /></label></> : <label>你要记录的原文<textarea value={text} maxLength={4000} rows={5} placeholder={kind === 'medication' ? '例如：目前在使用……，名称和剂量以药盒或医生记录为准' : kind === 'allergy' ? '例如：本人记得对……出现过……，是否为过敏尚待医生确认' : '请按自己的原话填写'} onChange={(event) => setText(event.target.value)} /></label>}<div className="info-callout compact"><ShieldCheck size={18} /><div><strong>来源会一直保留为 user_reported</strong><p>自测结果不会混入医院检验；新增背景会让该成员旧的 AI 说明标记为待更新。</p></div></div><div className="dialog-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!canSave || busy} onClick={async () => { setBusy(true); try { if (await save()) onClose(); } finally { setBusy(false); } }}>{busy ? <LoaderCircle size={18} className="spin" /> : <Check size={18} />} 保存到本机</button></div></section></div>;
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
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="member-dialog export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-summary-title"><header><div><span className="eyebrow">本机资料摘要</span><h2 id="export-summary-title">导出成员摘要</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭导出摘要"><X size={19} /></button></header><p>摘要使用当前已保存内容和固定模板，不会为导出再次生成新的医疗解释。</p><div className="action-due-grid"><label>家庭成员<select value={personId} onChange={(event) => setPersonId(event.target.value)}>{snapshot.persons.map((person) => <option key={person.id} value={person.id}>{person.displayName} · {person.relation}</option>)}</select></label><label>导出格式<select value={format} onChange={(event) => setFormat(event.target.value as ExportMemberSummaryInput['format'])}><option value="pdf">PDF（适合打印）</option><option value="html">HTML（可用浏览器打开）</option><option value="json">JSON（结构化数据）</option></select></label></div><div className="action-due-grid"><label>开始日期（可选）<input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /></label><label>结束日期（可选）<input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></label></div>{!datesValid && <span className="field-error">结束日期不能早于开始日期。</span>}<div className="consent-facts"><span><FileCheck2 size={17} /> 包含所选成员的报告指标、本人补充、事项和已发布生活指南</span><span><ShieldCheck size={17} /> 默认不附原始报告，不包含其他家庭成员</span><span><Archive size={17} /> 文件只保存到你选择的本机位置，不会上传或代发</span></div><label className="check-label"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> 我已了解导出文件含个人健康信息，需要自行妥善保管</label><div className="dialog-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!personId || !confirmed || !datesValid || busy} onClick={async () => { setBusy(true); try { if (await onExport({ personId, format, dateFrom: dateFrom || null, dateTo: dateTo || null, confirmedPrivacyNotice: true })) onClose(); } finally { setBusy(false); } }}>{busy ? <LoaderCircle size={18} className="spin" /> : <FileCheck2 size={18} />} 选择保存位置</button></div></section></div>;
}

function SettingsPage({ snapshot, desktopBehavior, displayPreferences, aiPreferences, recoveryStatus, onAccount, onAi, onDirectories, onSchedule, onBackup, onDesktop, onDisplay, onPrivacy, onAbout }: { snapshot: DashboardSnapshot; desktopBehavior: DesktopBehavior; displayPreferences: DisplayPreferences; aiPreferences: AiPreferences; recoveryStatus: RecoveryStatus; onAccount(): void; onAi(): void; onDirectories(): void; onSchedule(): void; onBackup(): void; onDesktop(): void; onDisplay(): void; onPrivacy(): void; onAbout(): void }) {
  const accountText = snapshot.account.status === 'connected'
    ? `已连接${snapshot.account.displayLabel ? ` · ${snapshot.account.displayLabel}` : ''}`
    : snapshot.account.status === 'connecting' ? '请在官方浏览器页面完成登录'
      : snapshot.account.displayLabel ?? '尚未连接 Codex';
  const accountAction = snapshot.account.status === 'connected' ? '刷新状态' : snapshot.account.status === 'connecting' ? '等待完成' : '连接账户';
  const settings = [
    { icon: Sparkles, title: '账户与 AI', text: accountText, action: accountAction },
    { icon: Activity, title: 'AI 模型', text: `${modelPreferenceLabel(aiPreferences)} · 新任务生效`, action: '更改' },
    { icon: FolderHeart, title: '报告收件箱', text: snapshot.workspaceMode === 'personal' ? '只监控你明确授权的本机目录' : '个人工作区建立后可指定目录', action: '管理目录' },
    { icon: CalendarClock, title: '自动处理', text: snapshot.scheduleEnabled ? `每天 ${snapshot.scheduleLocalTime}（${snapshot.scheduleTimeZone}）· 下次 ${formatDateTime(snapshot.nextScheduledRun)}` : '尚未启用；不会自动发送资料', action: '调整时间' },
    { icon: Bell, title: '桌面行为', text: `${desktopBehavior.stayInTray === null ? '关闭窗口时询问是否驻留' : desktopBehavior.stayInTray ? '关闭后驻留后台' : '关闭窗口即退出'} · 处理通知：${desktopBehavior.notificationsEnabled ? '开启' : '关闭'}`, action: '更改' },
    { icon: Settings, title: '显示', text: `${displayPreferences.fontScale === 'large' ? '大字号' : '标准字号'} · ${displayPreferences.reduceMotion ? '减少动画' : '标准动画'} · ${displayPreferences.dateStyle === 'numeric' ? '数字日期' : '中文日期'}`, action: '更改' },
    { icon: ShieldCheck, title: '数据与隐私', text: '本机工作区 · 未启用产品遥测', action: '查看详情' },
    { icon: Archive, title: '备份与恢复', text: recoveryStatus.pointCount > 0 ? `${recoveryStatus.pointCount} 个本机恢复点 · ${formatBytes(recoveryStatus.totalBytes)} · 最近 ${formatDateTime(recoveryStatus.latestAt)}` : '尚无本机恢复点；首次正式写入前会自动创建', action: '创建加密备份' },
    { icon: CircleHelp, title: '关于与诊断', text: '版本、运行时、依赖许可与已知限制', action: '查看' }
  ];
  return <div className="page-stack"><section className="page-title-row"><div><span className="eyebrow">设置</span><h1>运行方式和资料边界</h1><p>退出 Codex 不会删除健康档案；更换账户或扩大目录范围需要重新确认。</p></div></section><section className="panel settings-list">{settings.map(({ icon: Icon, title, text, action }) => <button key={title} onClick={title === '账户与 AI' ? onAccount : title === 'AI 模型' ? onAi : title === '报告收件箱' ? onDirectories : title === '自动处理' ? onSchedule : title === '桌面行为' ? onDesktop : title === '显示' ? onDisplay : title === '数据与隐私' ? onPrivacy : title === '备份与恢复' ? onBackup : onAbout}><span className="settings-icon"><Icon size={20} /></span><span><strong>{title}</strong><small>{text}</small></span><span className="settings-action">{action}<ChevronRight size={16} /></span></button>)}</section><section className="panel boundary-card"><div><ShieldCheck size={24} /><span><h3>真实边界</h3><p>资料保存在当前 OS 用户目录；AI 处理会通过你的 Codex 账户发送必要内容给 OpenAI。这不是全程离线推理，也不等于医学审核。</p></span></div><button className="secondary-button" onClick={onPrivacy}>查看数据处理说明</button></section></div>;
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
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="member-dialog" role="dialog" aria-modal="true" aria-labelledby="ai-preferences-title"><header><div><span className="eyebrow">AI 模型</span><h2 id="ai-preferences-title">模型与推理强度</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭 AI 模型设置"><X size={19} /></button></header>{loading ? <div className="table-empty"><LoaderCircle size={24} className="spin" /><strong>正在读取当前账号可用模型</strong></div> : loadFailed ? <div className="info-callout compact"><CircleHelp size={18} /><div><strong>暂时无法读取模型列表</strong><p>请确认 Codex 已连接后重试。为避免保存无效组合，本次不会更改现有设置。</p></div></div> : <><label>模型<select aria-label="模型" value={modelId} onChange={(event) => { const next = models.find((model) => model.id === event.target.value); if (!next) return; setModelId(next.id); setReasoningEffort(next.defaultReasoningEffort); }}>{models.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}</select></label>{selectedModel?.description && <p>{selectedModel.description}</p>}<label>推理强度<select aria-label="推理强度" value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value as AiReasoningEffort)}>{selectedModel?.supportedReasoningEfforts.map((option) => <option key={option.reasoningEffort} value={option.reasoningEffort}>{reasoningEffortLabels[option.reasoningEffort]}</option>)}</select></label>{effortDescription && <p>{effortDescription}</p>}<div className="info-callout compact"><ShieldCheck size={18} /><div><strong>默认：GPT-5.6-Sol · 中等推理</strong><p>更高强度通常更慢并消耗更多额度。变更只影响之后新领取的任务；正在处理的任务会继续使用启动时冻结的设置。AI 结果仍会经过独立复核，也不等于医学审核。</p></div></div></>}<div className="dialog-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={loading || loadFailed || busy || !selectedModel} onClick={async () => { setBusy(true); try { if (await onSave({ modelId, reasoningEffort })) onClose(); } finally { setBusy(false); } }}>{busy ? <LoaderCircle size={18} className="spin" /> : <Check size={18} />} 保存设置</button></div></section></div>;
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
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="member-dialog" role="dialog" aria-modal="true" aria-labelledby="account-dialog-title"><header><div><span className="eyebrow">账户与 AI</span><h2 id="account-dialog-title">Codex 连接</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭账户设置"><X size={19} /></button></header><p>{connected ? `当前连接：${snapshot.account.displayLabel ?? 'ChatGPT Codex'}` : snapshot.account.status === 'connecting' ? '正在等待官方浏览器登录完成。' : '连接使用 Codex 管理的官方浏览器登录，不需要复制令牌或配置 API Key。'}</p><dl className="detail-list"><div><dt>连接状态</dt><dd>{connected ? '已连接' : snapshot.account.status === 'connecting' ? '等待登录' : '未连接'}</dd></div><div><dt>额度状态</dt><dd>{snapshot.account.quota.status === 'available' ? '可用' : snapshot.account.quota.status === 'low' ? '余额偏低' : snapshot.account.quota.status === 'exhausted' ? '已耗尽' : '未知，不会承诺免费或继续自动处理'}</dd></div><div><dt>私有运行时</dt><dd>{snapshot.account.runtimeVersion ?? '不可用'}</dd></div></dl>{connected && <><div className="info-callout compact"><ShieldCheck size={18} /><div><strong>退出不删除本机健康档案</strong><p>退出会暂停待发送任务，并撤回现有目录和手动批次的 AI 处理授权。之后即使连接另一个账户，也需要重新确认发送范围。</p></div></div><label className="check-label"><input type="checkbox" checked={confirmedLogout} onChange={(event) => setConfirmedLogout(event.target.checked)} /> 我确认退出 Codex，并暂停现有 AI 处理授权</label></>}<div className="dialog-actions"><button className="secondary-button" onClick={onClose}>关闭</button>{connected ? <><button className="secondary-button" disabled={busy} onClick={async () => { setBusy(true); try { await onRefresh(); } finally { setBusy(false); } }}><RefreshCw size={17} /> 刷新状态</button><button className="primary-button danger-button" disabled={!confirmedLogout || busy} onClick={async () => { setBusy(true); try { if (await onLogout()) onClose(); } finally { setBusy(false); } }}><X size={17} /> 退出 Codex</button></> : <button className="primary-button" disabled={snapshot.account.status === 'connecting'} onClick={onConnect}><Sparkles size={17} /> {snapshot.account.status === 'connecting' ? '等待登录完成' : '使用 ChatGPT 登录'}</button>}</div></section></div>;
}

function PrivacyDialog({ snapshot, onClose, onDirectories, onBackup, onNotice }: { snapshot: DashboardSnapshot; onClose(): void; onDirectories(): void; onBackup(): void; onNotice(message: string): void }) {
  const [cleanupConfirmed, setCleanupConfirmed] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="workspace-dialog privacy-dialog" role="dialog" aria-modal="true" aria-labelledby="privacy-dialog-title"><header><div><span className="eyebrow">数据与隐私</span><h2 id="privacy-dialog-title">哪些留在本机，哪些会发送</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭数据处理说明"><X size={19} /></button></header><div className="privacy-sections"><article><span className="settings-icon"><Archive size={19} /></span><div><strong>本机正式资料</strong><p>数据库、原始报告对象、用户补充、恢复点和导出文件保存在当前操作系统用户空间。Renderer 不会拿到真实文件路径。</p></div></article><article><span className="settings-icon"><Sparkles size={19} /></span><div><strong>OpenAI / Codex 处理</strong><p>只有手动确认，或目录已明确授权日程处理时，才发送所需报告内容。事实提取与核对不使用网页搜索；综合分析和安全复核可使用 Codex 内置 Web Search 查询通用医学背景。</p></div></article><article><span className="settings-icon"><CircleHelp size={19} /></span><div><strong>搜索词去标识化</strong><p>Web Search 搜索词不得包含姓名、完整日期、报告原文、本机路径、内部 ID 或可唯一识别个人的事实组合。搜索结果只能解释通用概念，不得替代或改写报告事实。</p></div></article><article><span className="settings-icon"><ShieldCheck size={19} /></span><div><strong>没有开发者遥测</strong><p>本版本没有把健康资料、操作统计或诊断日志上传到开发者服务器。系统通知也不会显示成员名、病名、指标或文件名。</p></div></article><article><span className="settings-icon"><CircleHelp size={19} /></span><div><strong>安全边界</strong><p>应用依赖当前操作系统账户保护，没有第二层 App 解锁。AI 整理不等于医生审核，也不会自动预约、发药或代发资料。</p></div></article></div><div className="info-callout compact"><ShieldCheck size={18} /><div><strong>{snapshot.workspaceMode === 'personal' ? '你可以随时撤回目录授权' : '演示空间不包含真实健康资料'}</strong><p>{snapshot.workspaceMode === 'personal' ? '停用目录会停止监控，并撤回该目录后续的自动 AI 处理授权；已保存的本机档案不会因此删除。' : '建立个人工作区后，导入本机与发送给 AI 仍会分开确认。'}</p></div></div><div className="retention-box"><div><strong>清理到期临时资料</strong><p>删除超过 7 天的本应用临时渲染目录，以及超过 30 天且没有开放核对事项的终结任务尝试记录。不会删除原始报告、正式事实、事项、审计、备份或其他 Codex 工作区；本应用 Codex 会话资料也不会自动删除。</p></div><label className="check-label"><input type="checkbox" checked={cleanupConfirmed} onChange={(event) => setCleanupConfirmed(event.target.checked)} /> 我已了解本次清理范围</label><button className="secondary-button" disabled={!cleanupConfirmed || cleanupBusy} onClick={async () => { setCleanupBusy(true); try { const result = await window.healthDesktop?.cleanupExpiredData(); if (result?.ok) { onNotice(`已清理 ${result.data.temporaryEntriesRemoved} 个临时目录和 ${result.data.terminalTaskAttemptsRemoved} 条到期任务尝试记录；正式健康档案未删除。`); setCleanupConfirmed(false); } else if (result) onNotice('到期临时资料没有清理成功，请稍后重试。'); } finally { setCleanupBusy(false); } }}>{cleanupBusy ? <LoaderCircle size={18} className="spin" /> : <Archive size={18} />} 执行受控清理</button></div><div className="dialog-actions"><button className="secondary-button" onClick={() => { onClose(); onDirectories(); }}>管理目录授权</button><button className="secondary-button" onClick={() => { onClose(); onBackup(); }}>备份与恢复</button><button className="primary-button" onClick={onClose}>完成</button></div></section></div>;
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
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="member-dialog about-dialog" role="dialog" aria-modal="true" aria-labelledby="about-dialog-title"><header><div><span className="eyebrow">关于与诊断</span><h2 id="about-dialog-title">家庭健康看板</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭关于信息"><X size={19} /></button></header><p>版本 0.1.0 · 本机 Beta 构建。下列诊断预览只有计数和运行状态，不包含报告正文、成员姓名、文件名、路径、凭据或登录链接。</p><dl className="detail-list"><div><dt>Codex 状态</dt><dd>{snapshot.account.status === 'connected' ? '已连接' : snapshot.account.status === 'connecting' ? '等待官方登录' : '未连接'}</dd></div><div><dt>锁定运行时</dt><dd>{diagnostic?.application.runtimeVersion ?? 'codex-cli 0.145.0'}</dd></div><div><dt>工作区计数</dt><dd>{diagnostic ? `${diagnostic.workspace.personCount} 位成员 · ${diagnostic.workspace.documentCount} 份资料 · ${diagnostic.taskSummary.total} 个任务` : '正在生成脱敏预览…'}</dd></div><div><dt>发行状态</dt><dd>未签名本机测试构建</dd></div></dl><div className="consent-facts"><span><FileCheck2 size={17} /> 关键依赖许可随应用附带在 THIRD_PARTY_NOTICES.md</span><span><ShieldCheck size={17} /> 当前只验证了 macOS arm64；x64、Windows、签名和公证仍需目标环境</span><span><CircleHelp size={17} /> 诊断文件只保存到你选择的本机位置，不自动上传或创建 Issue</span></div><div className="dialog-actions"><button className="secondary-button" disabled={!diagnostic || busy} onClick={async () => { setBusy(true); try { const result = await window.healthDesktop?.exportDiagnostic(); if (result?.ok && result.data) onNotice(`已保存 ${result.data.displayName}；它不包含健康正文或凭据。`); else if (result && !result.ok) onNotice('脱敏诊断信息没有保存，请稍后重试。'); } finally { setBusy(false); } }}>{busy ? <LoaderCircle size={18} className="spin" /> : <Archive size={18} />} 预览后保存诊断</button><button className="primary-button" onClick={onClose}>完成</button></div></section></div>;
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

function BackupDialog({ onClose, onNotice, onRestored }: { onClose(): void; onNotice(message: string): void; onRestored(snapshot: DashboardSnapshot): void }) {
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
      onNotice(`已创建 ${result.data.displayName}，包含 ${result.data.objectCount} 个原始资料对象。请妥善保存口令，应用无法替你找回。`);
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

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }}><section className="workspace-dialog backup-dialog" role="dialog" aria-modal="true" aria-labelledby="backup-dialog-title"><header><div><span className="eyebrow">备份与恢复</span><h2 id="backup-dialog-title">保护本机家庭健康档案</h2></div><button className="icon-button" disabled={busy} onClick={onClose} aria-label="关闭备份与恢复"><X size={19} /></button></header><div className="filter-tabs"><button disabled={busy} className={mode === 'create' ? 'is-active' : ''} onClick={() => { setMode('create'); setPassphrase(''); }}>创建备份</button><button disabled={busy} className={mode === 'restore' ? 'is-active' : ''} onClick={() => { setMode('restore'); setPassphrase(''); setConfirmation(''); }}>恢复备份</button></div>{mode === 'create' ? <><p className="dialog-intro">备份包含数据库和原始资料，并使用口令加密。口令不写入应用，也无法找回。</p><label>备份口令（至少 10 个字符）<input disabled={busy} type="password" autoComplete="new-password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} /></label><label>再次输入口令<input disabled={busy} type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>{confirmation && passphrase !== confirmation && <span className="field-error">两次口令不一致。</span>}<div className="dialog-actions"><button className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" disabled={busy || !createValid} onClick={() => void createBackup()}>{busy ? <LoaderCircle size={18} className="spin" /> : <Archive size={18} />} 选择位置并创建</button></div></> : <><p className="dialog-intro">恢复会在完整解密、数据库检查和对象哈希校验通过后，替换当前本机工作区。校验过程中可以安全停止。</p><button className="secondary-button" disabled={busy} onClick={() => void pickRestore()}><FileText size={17} /> {restoreSelection ? '重新选择备份' : '选择加密备份'}</button>{restoreSelection && <div className="info-callout compact"><Archive size={18} /><div><strong>{restoreSelection.displayName}</strong><p>尚未解密或改动当前工作区。</p></div></div>}<label>备份口令<input disabled={busy} type="password" autoComplete="current-password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} /></label><label className="check-label"><input disabled={busy} type="checkbox" checked={confirmedReplace} onChange={(event) => setConfirmedReplace(event.target.checked)} /> 我确认用所选备份替换当前本机工作区</label><div className="dialog-actions">{busy ? <button className="secondary-button" onClick={() => void cancelRestore()}><X size={17} /> 停止恢复</button> : <button className="secondary-button" onClick={onClose}>取消</button>}<button className="primary-button" disabled={busy || !restoreSelection || !passphrase || !confirmedReplace} onClick={() => void restoreBackup()}>{busy ? <LoaderCircle size={18} className="spin" /> : <RefreshCw size={18} />} 校验并恢复</button></div></>}</section></div>;
}

function ReviewBanner({ review, openCount, onOpen }: { review: ReviewIssue; openCount: number; onOpen(): void }) {
  return <button className="review-banner" onClick={onOpen}><span className="review-banner__icon"><CircleHelp size={21} /></span><span><strong>{review.title}</strong><small>{review.description}{openCount > 1 ? ` 当前共有 ${openCount} 项待核对。` : ''}</small></span><StatusBadge tone="warning">{openCount > 1 ? `待确认 ${openCount} 项` : '需要你的确认'}</StatusBadge><ChevronRight size={18} /></button>;
}

const reviewDiffFieldLabels: Record<ReviewIssue['candidateDiffs'][number]['fields'][number], string> = {
  presence: '是否存在这项',
  originalName: '报告项目名',
  standardNameCandidate: '标准项目名',
  value: '结果',
  unitRaw: '单位',
  referenceRangeRaw: '参考范围',
  reportedAbnormalFlag: '报告异常标记',
  specimen: '标本',
  method: '检验方法',
  bodySite: '检查部位',
  clinicalDate: '临床日期',
  issues: '数据问题'
};

type ReviewCandidate = ReviewIssue['candidateOptions'][number];
type ReviewDiffField = ReviewIssue['candidateDiffs'][number]['fields'][number];

function reviewCandidateFieldValue(candidate: ReviewCandidate | null | undefined, field: ReviewDiffField): string {
  if (!candidate) return field === 'presence' ? '未读取到这项' : '—';
  if (field === 'presence') return '读取到这项';
  if (field === 'value') return candidate.value.rawText ?? '未读出';
  if (field === 'issues') return candidate.issues.length > 0 ? '存在需要重新核对的数据问题' : '未发现数据问题';
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
      return <label key={field}>{label}<input value={candidate.value.rawText ?? ''} onChange={(event) => onChange((current) => ({ ...current, value: current.value.kind === 'numeric' ? { ...current.value, rawText: event.target.value, decimal: event.target.value } : { ...current.value, rawText: event.target.value } }))} /></label>;
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
    {included && !fields.includes('originalName') && <label>项目名<input value={candidate.originalName} onChange={(event) => onChange((current) => ({ ...current, originalName: event.target.value }))} /></label>}
    {included && editableFields.map(editor)}
    {fields.includes('issues') && <div className="info-callout compact"><RefreshCw size={18} /><div><strong>这项不能靠猜测修正</strong><p>请稍后让系统重新核对原始依据；未解决前不会写入健康档案。</p></div></div>}
  </div>;
}

function ReviewResolutionDialog({ review, snapshot, onClose, onEvidence, onResolve }: {
  review: ReviewIssue;
  snapshot: DashboardSnapshot;
  onClose(): void;
  onEvidence(): void;
  onResolve(input: ResolveReviewInput): Promise<boolean>;
}) {
  const [personId, setPersonId] = useState(snapshot.persons[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState(review.candidateOptions);
  const [excludedLocalKeys, setExcludedLocalKeys] = useState<Set<string>>(() => new Set());
  const isAssignment = review.kind === 'person_conflict' && review.personId === null;
  const isIdentityConfirmation = review.kind === 'person_conflict' && review.personId !== null && review.reportedName !== null;
  const targetPerson = isIdentityConfirmation
    ? snapshot.persons.find((person) => person.id === review.personId) ?? null
    : null;
  const isDerived = review.kind === 'derived_safety';
  const isFieldConflict = review.kind === 'field_conflict';
  const isLegacyFieldReview = isFieldConflict && candidates.length > 0 && review.candidateDiffs.length === 0;
  const differenceByLocalKey = new Map(review.candidateDiffs.map((difference) => [difference.localKey, difference]));
  const visibleCandidates = candidates
    .map((candidate, index) => ({ candidate, index, difference: differenceByLocalKey.get(candidate.localKey) }))
    .filter((item) => item.difference);
  const hasVisibleConflicts = isFieldConflict && !isLegacyFieldReview && visibleCandidates.length > 0;
  const resolvedCandidates = candidates.filter((candidate) => !excludedLocalKeys.has(candidate.localKey));
  const canCorrect = hasVisibleConflicts
    && review.candidateDiffs.every((difference) => !difference.fields.includes('issues'))
    && resolvedCandidates.every((candidate) => candidate.value.kind !== 'numeric' || /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(candidate.value.decimal));
  const updateCandidate = (index: number, updater: (candidate: (typeof candidates)[number]) => (typeof candidates)[number]) => {
    setCandidates((current) => current.map((candidate, candidateIndex) => candidateIndex === index ? updater(candidate) : candidate));
  };
  const canSubmit = !busy
    && (!isAssignment || Boolean(personId))
    && (!isIdentityConfirmation || Boolean(targetPerson))
    && (!isFieldConflict || isLegacyFieldReview || canCorrect);

  async function submitResolution() {
    setBusy(true);
    try {
      const resolution: ResolveReviewInput = isAssignment
        ? { action: 'assign_person', documentId: review.documentId, personId }
        : isIdentityConfirmation && targetPerson
          ? { action: 'confirm_identity', issueId: review.id, documentId: review.documentId, personId: targetPerson.id }
          : isLegacyFieldReview
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
          <div><span className="eyebrow">例外核对</span><h2 id="review-resolution-title">{review.title}</h2></div>
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
                <div><dt>报告姓名</dt><dd>{review.reportedName}</dd></div>
                <div><dt>将归入</dt><dd>{targetPerson.displayName}{targetPerson.relation ? ` · ${targetPerson.relation}` : ''}</dd></div>
              </dl>
              <div className="info-callout compact"><ShieldCheck size={18} /><div><strong>只确认这份报告的身份关系</strong><p>不会修改成员名称，也不是医学结论。确认后系统会重新核对报告，再保存有来源的事实。</p></div></div>
            </>
          ) : isLegacyFieldReview ? (
            <div className="info-callout compact"><RefreshCw size={18} /><div><strong>不需要逐项检查这 {candidates.length} 项内容</strong><p>旧版把标本、日期或证据摘录的写法差异也当成冲突。点击重新核对后，系统会用新规则再处理；只有数值、项目、单位等核心事实真正不一致时才会再次询问你。</p></div></div>
          ) : hasVisibleConflicts ? (
            <>
              <div className="info-callout compact"><CircleHelp size={18} /><div><strong>为什么需要确认</strong><p>两轮独立读取在下列核心字段上给出了不同结果。请只对照原始报告检查这些差异项；其余一致项目无需逐项确认。</p></div></div>
              <div className="manual-note-list review-difference-list">{visibleCandidates.map(({ candidate, index, difference }) => <article key={candidate.localKey}>
                <div className="review-difference-fields"><strong>两轮不一致：</strong><span>{difference!.fields.map((field) => reviewDiffFieldLabels[field]).join('、')}</span></div>
                {difference!.firstCandidate !== undefined && difference!.secondCandidate !== undefined && <div className="review-reading-grid">
                  <section><span>首次提取</span>{difference!.fields.map((field) => <div key={field}><small>{reviewDiffFieldLabels[field]}</small><strong>{reviewCandidateFieldValue(difference!.firstCandidate, field)}</strong></div>)}</section>
                  <section><span>独立复核</span>{difference!.fields.map((field) => <div key={field}><small>{reviewDiffFieldLabels[field]}</small><strong>{reviewCandidateFieldValue(difference!.secondCandidate, field)}</strong></div>)}</section>
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
            <div className="info-callout compact"><ShieldCheck size={18} /><div><strong>{isDerived ? '报告事实不会被删除' : '原始资料会继续保留'}</strong><p>{isDerived ? '只是不发布这次未通过安全复核的分析和生活指南。' : '选择仅归档后，这份资料不会进入趋势或后续分析。'}</p></div></div>
          )}
        </div>
        <div className="dialog-actions">
          <button className="secondary-button" onClick={onClose}>稍后处理</button>
          <button className="primary-button" disabled={!canSubmit} onClick={() => void submitResolution()}>
            {busy ? <LoaderCircle size={18} className="spin" /> : <Check size={18} />}
            {isAssignment ? '确认归属' : isIdentityConfirmation ? '确认是同一人' : isLegacyFieldReview ? '按新规则重新核对' : canCorrect ? '保存修正并纳入' : isDerived ? '保留事实，不发布说明' : '仅归档这份资料'}
          </button>
        </div>
      </section>
    </div>
  );
}

function EvidencePanel({ evidence, demo, onClose }: { evidence: Evidence | null; demo: boolean; onClose(): void }) {
  if (!evidence) return null;
  return <aside className="evidence-panel" aria-label="证据侧栏"><header><div><span className="eyebrow">证据与来源</span><h2>{evidence.title}</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭证据侧栏"><X size={19} /></button></header><div className="evidence-preview">{evidence.previewImageDataUrl ? <img src={evidence.previewImageDataUrl} alt={`${evidence.title}的受控预览`} /> : <div className="evidence-page"><span>{demo ? '虚构资料预览' : '来源摘录'}</span><p>……检验项目与结果……</p><mark>{evidence.quote}</mark><p>……报告其余内容……</p></div>}</div><div className="evidence-meta"><StatusBadge tone="info">来源定位</StatusBadge><strong>{evidence.label}</strong><p>{evidence.meta}</p></div><div className="evidence-note"><ShieldCheck size={18} /><p>界面只按对象 ID 读取资料，不向页面暴露本机文件路径。</p></div></aside>;
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
          <span className="avatar avatar--small">家</span><span><strong>我的个人工作区</strong><small>保存在本机应用数据目录，与演示资料隔离</small></span>{snapshot.workspaceMode === 'personal' && <Check size={18} />}
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
        <p>这里只建立本地成员档案，不会为家人创建 Codex 账号，也不会发送资料。</p>
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
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="member-dialog" role="dialog" aria-modal="true" aria-labelledby="member-edit-title"><header><div><span className="eyebrow">成员档案</span><h2 id="member-edit-title">编辑显示资料</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭成员编辑"><X size={19} /></button></header><p>修改称呼、关系或出生年份不会触发 AI 重算，也不会改变成员 ID、报告归属和历史记录。</p><label>称呼<input autoFocus value={displayName} maxLength={80} onChange={(event) => setDisplayName(event.target.value)} /></label><label>与我的关系<input value={relation} maxLength={40} onChange={(event) => setRelation(event.target.value)} /></label><label>出生年份（可选）<input inputMode="numeric" value={birthYear} onChange={(event) => setBirthYear(event.target.value.replace(/\D/g, '').slice(0, 4))} /></label>{!yearValid && <span className="field-error">请输入 1900 年至今年之间的年份。</span>}<div className="info-callout compact"><Archive size={18} /><div><strong>不再日常查看？可以归档</strong><p>归档会隐藏成员并撤回其目录授权，但不会删除报告、事实、事项或历史版本，之后可以恢复。</p></div></div><div className="dialog-actions"><button className="secondary-button" onClick={onArchive}><Archive size={17} /> 归档成员</button><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={submitting || !displayName.trim() || !relation.trim() || !yearValid} onClick={async () => { setSubmitting(true); try { if (await onSave({ personId: person.id, displayName, relation, birthYear: parsedBirthYear, expectedDisplayRevision: person.displayRevision })) onClose(); } finally { setSubmitting(false); } }}>{submitting ? <LoaderCircle size={18} className="spin" /> : <Check size={18} />} 保存显示资料</button></div></section></div>;
}

function ArchivePersonDialog({ person, onClose, onConfirm }: {
  person: PersonSummary;
  onClose(): void;
  onConfirm(): Promise<boolean>;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="member-dialog" role="dialog" aria-modal="true" aria-labelledby="archive-person-title"><header><div><span className="eyebrow">可撤销操作</span><h2 id="archive-person-title">归档 {person.displayName}？</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭归档成员确认"><X size={19} /></button></header><p>归档后，这位成员会从家庭总览和日常处理范围中隐藏。</p><div className="privacy-sections"><article><span className="settings-icon"><ShieldCheck size={19} /></span><div><strong>会撤回后续处理授权</strong><p>该成员的收件箱目录会停用，对应的日程 AI 授权会撤回；正在运行的任务必须先结束或停止。</p></div></article><article><span className="settings-icon"><Archive size={19} /></span><div><strong>不会删除历史资料</strong><p>原始报告、已接纳事实、本人补充、事项、审计和历史版本都会保留，恢复成员后可再次查看。</p></div></article></div><label className="check-label"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> 我了解归档范围，并确认归档这位成员</label><div className="dialog-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!confirmed || busy} onClick={async () => { setBusy(true); try { if (await onConfirm()) onClose(); } finally { setBusy(false); } }}>{busy ? <LoaderCircle size={18} className="spin" /> : <Archive size={18} />} 确认归档</button></div></section></div>;
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
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="member-dialog" role="dialog" aria-modal="true" aria-labelledby="exclude-document-title"><header><div><span className="eyebrow">资料范围</span><h2 id="exclude-document-title">将这份资料移出分析？</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭移出资料确认"><X size={19} /></button></header><p><strong>{document.displayName}</strong> 将不再进入趋势、身体视图或后续 AI 处理。</p><div className="privacy-sections"><article><span className="settings-icon"><Archive size={19} /></span><div><strong>立即停止作为健康依据</strong><p>与这份资料相关的当前派生说明会标记为待更新；如有未完成任务，需要先停止或等待完成。</p></div></article><article><span className="settings-icon"><ShieldCheck size={19} /></span><div><strong>保留可审计原件与抑制记录</strong><p>本机不可变对象、审计和既有恢复点仍可能包含这份资料；原文件留在收件箱时不会自动重复导入。你可以稍后“重新纳入”。</p></div></article></div><label className="check-label"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> 我了解这不是清除所有历史副本，并确认移出分析</label><div className="dialog-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!confirmed || busy} onClick={async () => { setBusy(true); try { if (await onConfirm()) onClose(); } finally { setBusy(false); } }}>{busy ? <LoaderCircle size={18} className="spin" /> : <Archive size={18} />} 确认移出</button></div></section></div>;
}

function DeleteDocumentDialog({ document, onClose, onConfirm }: {
  document: InboxItem;
  onClose(): void;
  onConfirm(): Promise<boolean>;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [acknowledgedCopies, setAcknowledgedCopies] = useState(false);
  const [busy, setBusy] = useState(false);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="member-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-document-title"><header><div><span className="eyebrow">不可撤销的当前档案变更</span><h2 id="delete-document-title">删除这份本机档案？</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭删除资料确认"><X size={19} /></button></header><p><strong>{document.displayName}</strong> 会从当前工作区删除。若你还需要副本，请先取消并导出成员摘要或创建加密备份。</p><div className="privacy-sections"><article><span className="settings-icon"><Trash2 size={19} /></span><div><strong>会删除当前档案及其依据链</strong><p>这份报告的来源定位、相关事实、派生说明和正式历史版本会从当前工作区移除。未完成任务必须先安全停止。</p></div></article><article><span className="settings-icon"><ShieldCheck size={19} /></span><div><strong>不会承诺擦除所有历史副本</strong><p>应用会保留导入抑制记录，避免收件箱原文件马上回灌。既有本机恢复点、你导出的加密备份、系统备份或云盘副本仍可能包含旧资料。</p></div></article></div><label className="check-label"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> 我确认删除当前工作区中的报告、事实、派生结果和相关历史版本</label><label className="check-label"><input type="checkbox" checked={acknowledgedCopies} onChange={(event) => setAcknowledgedCopies(event.target.checked)} /> 我了解恢复点或外部备份仍可能保留旧资料</label><div className="dialog-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button danger-button" disabled={!confirmed || !acknowledgedCopies || busy} onClick={async () => { setBusy(true); try { if (await onConfirm()) onClose(); } finally { setBusy(false); } }}>{busy ? <LoaderCircle size={18} className="spin" /> : <Trash2 size={18} />} 确认删除</button></div></section></div>;
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
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="workspace-dialog" role="dialog" aria-modal="true" aria-labelledby="deleted-documents-title"><header><div><span className="eyebrow">导入抑制记录</span><h2 id="deleted-documents-title">已删除资料</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭已删除资料"><X size={19} /></button></header><p>这里不恢复已删除内容；“重新允许导入”只移除抑制记录。之后需要重新选择文件，才会重新建立档案。</p>{loading ? <div className="table-empty"><LoaderCircle size={24} className="spin" /><strong>正在读取本机记录</strong></div> : items.length === 0 ? <div className="table-empty"><Trash2 size={24} /><strong>没有已删除资料记录</strong><span>从当前工作区删除报告后，会在这里保留防止自动回灌的记录。</span></div> : <div className="action-list">{items.map((item) => <div className="action-row" key={item.sourceHash}><span className="file-icon"><FileText size={18} /></span><div className="action-row__body"><strong>{item.displayName}</strong><small>删除于 {formatDateTime(item.deletedAt)}{item.rawObjectRetained ? ' · 原始对象仍被其他档案或恢复点引用' : ' · 当前对象库未保留原始文件'}</small></div><button className="secondary-button" disabled={releasingHash !== null} onClick={async () => { setReleasingHash(item.sourceHash); try { const result = await window.healthDesktop?.releaseDeletedDocument(item.sourceHash); if (result?.ok) { setItems((current) => current.filter((entry) => entry.sourceHash !== item.sourceHash)); onNotice('已重新允许导入；已删除内容没有自动恢复，请重新选择原文件。'); } else onNotice('没有成功解除导入抑制，请稍后重试。'); } finally { setReleasingHash(null); } }}>{releasingHash === item.sourceHash ? <LoaderCircle size={17} className="spin" /> : <RefreshCw size={17} />} 重新允许导入</button></div>)}</div>}<div className="dialog-actions"><button className="primary-button" onClick={onClose}>完成</button></div></section></div>;
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
            <p>{snapshot.account.status === 'connected' ? '这项授权绑定当前 Codex 账户、所选目录和成员；综合分析可用去标识化 Web Search 查询通用医学背景。停用目录会同时撤回。' : '当前未连接 Codex，因此只能先启用本地导入。连接后可重新授权自动处理。'}</p>
            <div className="dialog-actions"><button className="secondary-button" onClick={() => setSelection(null)}>取消</button><button className="primary-button" disabled={busy} onClick={() => void confirmDirectory()}>{busy ? <LoaderCircle size={18} className="spin" /> : <Check size={18} />} 确认启用</button></div>
          </div>
        )}
      </section>
    </div>
  );
}

function ProcessConsentDialog({ snapshot, documentIds, onClose, onConfirm, onLogin }: {
  snapshot: DashboardSnapshot;
  documentIds: string[] | null;
  onClose(): void;
  onConfirm(): Promise<boolean>;
  onLogin(): void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const selectedSet = documentIds ? new Set(documentIds) : null;
  const readyCount = snapshot.inbox.filter((item) => !item.inProcessingCenter && item.status === 'queued' && item.personId && (!selectedSet || selectedSet.has(item.id))).length;
  const derivedRefreshCount = documentIds ? 0 : snapshot.persons.filter((person) => person.acceptedFactCount > 0 && person.derivedStatus !== 'current').length;
  const processingCount = readyCount + derivedRefreshCount;
  const connected = snapshot.account.status === 'connected';
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="member-dialog process-consent-dialog" role="dialog" aria-modal="true" aria-labelledby="process-consent-title">
        <header><div><span className="eyebrow">本次手动处理</span><h2 id="process-consent-title">确认发送范围</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭处理确认"><X size={19} /></button></header>
        <p>将处理 {readyCount} 份{documentIds ? '选中的' : ''}已归属资料{derivedRefreshCount > 0 ? `，并为 ${derivedRefreshCount} 位成员刷新已过期的综合说明` : ''}。必要内容会发送给 <strong>OpenAI/Codex</strong>，原始资料仍保存在本机。</p>
        <div className="consent-facts"><span><ShieldCheck size={17} /> 不发送其他成员或未归属资料</span><span><FileCheck2 size={17} /> 事实和派生说明分别复核、分别入库</span><span><CircleHelp size={17} /> 综合分析可用去标识化 Web Search 查询通用医学背景</span><span><Sparkles size={17} /> 使用当前 Codex 账户额度，额度规则可能变化</span></div>
        <label className="check-label"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> 我确认本次接收方、用途和资料范围</label>
        {!connected && <div className="info-callout compact"><ShieldCheck size={18} /><div><strong>Codex 尚未连接</strong><p>先完成官方登录，才会建立本次处理授权和任务。</p></div></div>}
        <div className="dialog-actions">
          <button className="secondary-button" onClick={onClose}>取消</button>
          {!connected ? <button className="primary-button" onClick={onLogin}>连接 Codex</button> : <button className="primary-button" disabled={!confirmed || busy || processingCount === 0} onClick={async () => {
            setBusy(true);
            try { if (await onConfirm()) onClose(); }
            finally { setBusy(false); }
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
  const [evidence, setEvidence] = useState<Evidence | null>(null);
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
  const [processConsentOpen, setProcessConsentOpen] = useState(false);
  const [processDocumentIds, setProcessDocumentIds] = useState<string[] | null>(null);
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  const [cancelJob, setCancelJob] = useState<JobSummary | null>(null);
  const [backupDialogOpen, setBackupDialogOpen] = useState(false);
  const [reviewDialog, setReviewDialog] = useState<ReviewIssue | null>(null);
  const [desktopDialogOpen, setDesktopDialogOpen] = useState(false);
  const [displayDialogOpen, setDisplayDialogOpen] = useState(false);
  const [aiDialogOpen, setAiDialogOpen] = useState(false);
  const [accountDialogOpen, setAccountDialogOpen] = useState(false);
  const [actionDialogOpen, setActionDialogOpen] = useState(false);
  const [manualNoteDialogOpen, setManualNoteDialogOpen] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [privacyDialogOpen, setPrivacyDialogOpen] = useState(false);
  const [aboutDialogOpen, setAboutDialogOpen] = useState(false);
  const [jobDetail, setJobDetail] = useState<JobSummary | null>(null);
  const [desktopBehavior, setDesktopBehavior] = useState<DesktopBehavior>({ stayInTray: null, openAtLogin: false, notificationsEnabled: true });
  const [displayPreferences, setDisplayPreferences] = useState<DisplayPreferences>({ fontScale: 'standard', reduceMotion: false, dateStyle: 'friendly' });
  const [aiPreferences, setAiPreferences] = useState<AiPreferences>(DEFAULT_AI_PREFERENCES);
  const [recoveryStatus, setRecoveryStatus] = useState<RecoveryStatus>({ pointCount: 0, totalBytes: 0, latestAt: null });

  const modalOpen = workspaceDialogOpen || memberDialogOpen || memberEditDialogOpen || archivePerson !== null || archivedPeopleDialogOpen || documentToExclude !== null || documentToDelete !== null || deletedDocumentsDialogOpen || directoryDialogOpen || processConsentOpen
    || scheduleDialogOpen || backupDialogOpen || desktopDialogOpen || displayDialogOpen || aiDialogOpen || accountDialogOpen || actionDialogOpen || manualNoteDialogOpen || exportDialogOpen
    || privacyDialogOpen || aboutDialogOpen || reviewDialog !== null || cancelJob !== null || jobDetail !== null;

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
    const focusables = () => [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')]
      .filter((element) => element.offsetParent !== null);
    focusables()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setWorkspaceDialogOpen(false);
        setMemberDialogOpen(false);
        setMemberEditDialogOpen(false);
        setArchivePerson(null);
        setArchivedPeopleDialogOpen(false);
        setDocumentToExclude(null);
        setDocumentToDelete(null);
        setDeletedDocumentsDialogOpen(false);
        setDirectoryDialogOpen(false);
        setProcessConsentOpen(false);
        setProcessDocumentIds(null);
        setScheduleDialogOpen(false);
        setBackupDialogOpen(false);
        setDesktopDialogOpen(false);
        setDisplayDialogOpen(false);
        setAiDialogOpen(false);
        setAccountDialogOpen(false);
        setActionDialogOpen(false);
        setManualNoteDialogOpen(false);
        setExportDialogOpen(false);
        setPrivacyDialogOpen(false);
        setAboutDialogOpen(false);
        setReviewDialog(null);
        setCancelJob(null);
        setJobDetail(null);
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
  }, [modalOpen]);

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
      setPage('inbox');
      if (snapshot.workspaceMode === 'personal') setProcessConsentOpen(true);
    });
  }, [snapshot.workspaceMode]);

  useEffect(() => {
    if (!window.healthDesktop) return;
    return window.healthDesktop.onAccountStateChanged((account) => {
      setSnapshot((current) => ({ ...current, account }));
      if (account.status === 'connected') setToast('Codex 已连接，可以继续配置资料授权。');
      if (account.status === 'error' && account.displayLabel) setToast(account.displayLabel);
    });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const openReviews = snapshot.reviews.filter((review) => review.resolutionStatus === 'open');
  const openReview = openReviews[0];

  async function handleOpenEvidence(next: Evidence) {
    setEvidence(next);
    if (snapshot.workspaceMode !== 'personal' || !window.healthDesktop) return;
    const selector = next.sourceSpanId
      ? { sourceSpanId: next.sourceSpanId }
      : next.documentId ? { documentId: next.documentId } : null;
    if (!selector) return;
    const result = await window.healthDesktop.getEvidence(selector);
    if (!result.ok) {
      setToast('这条来源暂时无法安全预览；原始资料仍保存在本机。');
      return;
    }
    const preview = result.data;
    const readability = preview.readability === 'clear' ? '来源清晰' : preview.readability === 'partial' ? '需要结合原件核对' : '文字层不可读';
    setEvidence({
      title: next.title,
      label: `${preview.displayName} · ${preview.locator}`,
      quote: preview.quote ?? (preview.previewImageDataUrl ? '图片原件预览' : '这个片段没有可显示的文字摘录。'),
      meta: `${readability}${preview.conversionView ? ' · 旧版 Word 转换视图，分页可能与原件不同' : ''} · ${next.meta}`,
      sourceSpanId: preview.sourceSpanId,
      documentId: preview.documentId,
      previewImageDataUrl: preview.previewImageDataUrl
    });
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
      : input.action === 'confirm_identity' ? '身份关系已确认，任务将从事实提取重新核对并继续。'
      : input.action === 'retry_review' ? '已关闭旧版核对事项，报告正在按新规则重新核对。'
      : input.action === 'archive_only' ? '资料已仅归档，不会进入分析。'
      : input.action === 'accept_correction' ? '修正后的事实已保存，并保留原始证据链。'
      : '报告事实已保留，本次未通过复核的说明不会发布。');
    return true;
  }

  const content = (() => {
    switch (page) {
      case 'home': return <HomePage snapshot={snapshot} selectedPersonId={selectedPersonId} onSelectPerson={(id) => { setSelectedPersonId(id); setPage('people'); }} onNavigate={setPage} onOpenEvidence={(next) => void handleOpenEvidence(next)} onAddPerson={() => setMemberDialogOpen(true)} />;
      case 'people': return <PeoplePage snapshot={snapshot} selectedPersonId={selectedPersonId} onSelectPerson={setSelectedPersonId} onOpenEvidence={(next) => void handleOpenEvidence(next)} onAddPerson={() => setMemberDialogOpen(true)} onEditPerson={() => setMemberEditDialogOpen(true)} onArchivedPeople={() => setArchivedPeopleDialogOpen(true)} onAddNote={() => setManualNoteDialogOpen(true)} onExport={() => setExportDialogOpen(true)} onImport={() => void handleImport()} onExcludeDocument={setDocumentToExclude} onReincludeDocument={(document) => void handleSetDocumentIncluded(document, true)} onDeleteDocument={setDocumentToDelete} onDeletedDocuments={() => setDeletedDocumentsDialogOpen(true)} />;
      case 'inbox': return <InboxPage snapshot={snapshot} onProcess={(documentIds) => {
        setProcessDocumentIds(documentIds ?? null);
        if (snapshot.workspaceMode === 'personal') setProcessConsentOpen(true);
        else void handleProcessNow(documentIds);
      }} onImport={() => void handleImport()} onDropFiles={(files, personId) => void handleDroppedFiles(files, personId)} onAssign={handleBatchAssign} onIgnore={handleBatchIgnore} onOpenEvidence={(next) => void handleOpenEvidence(next)} onProcessingCenter={() => setPage('processing')} onDirectories={() => {
        if (snapshot.workspaceMode !== 'personal') setWorkspaceDialogOpen(true);
        else setDirectoryDialogOpen(true);
      }} />;
      case 'processing': return <ProcessingPage snapshot={snapshot} onCancel={setCancelJob} onRetry={(job) => void handleRetryJob(job)} onTogglePause={() => void handleToggleQueuePause()} onDetails={setJobDetail} />;
      case 'actions': return <ActionsPage snapshot={snapshot} onCreate={() => {
        if (snapshot.workspaceMode !== 'personal') setToast('演示工作区不会保存事项；请先建立或切换到个人工作区。');
        else setActionDialogOpen(true);
      }} onUpdate={(item, status) => void handleActionStatus(item, status)} />;
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

  async function handleProcessNow(documentIds?: string[]): Promise<boolean> {
    if (!window.healthDesktop) { setToast('演示模式不会发送资料。'); return false; }
    const result = await window.healthDesktop.processNow({ consentVersion: 1, confirmedDataRecipient: 'OpenAI/Codex', documentIds });
    if (result.ok) {
      setSnapshot(await window.healthDesktop.getSnapshot());
      setToast(result.revision === 0 ? '这批资料已经在处理中，没有重复创建任务。' : '本次授权已记录，正在通过 Codex 提取并独立复核资料。');
      return true;
    }
    setToast(snapshot.workspaceMode === 'demo'
      ? '这是演示工作区，不会把虚构资料发送给 AI。'
      : result.error.code === 'NO_READY_DOCUMENTS' ? '当前没有已归属、可处理的新资料。'
        : result.error.code === 'DOCUMENT_ALREADY_IN_PROCESSING' ? '这份资料已在处理中心，请在那里查看或重试。'
        : result.error.code === 'AUTH_REQUIRED' ? '请先连接 Codex，再确认本次发送范围。' : '暂时无法建立处理批次。');
    return false;
  }

  async function handleImport() {
    if (snapshot.workspaceMode !== 'personal') {
      setWorkspaceDialogOpen(true);
      setToast('请先建立或切换到个人工作区；演示资料与真实资料严格隔离。');
      return;
    }
    if (!window.healthDesktop) { setToast('请在桌面应用中添加资料。'); return; }
    const result = await window.healthDesktop.selectFiles(selectedPersonId || null);
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
    const result = await window.healthDesktop.importDroppedFiles(personId, files);
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
    setToast(importReceiptMessage(receipt));
  }

  async function handleCreateWorkspace(input: { workspaceName: string; primaryMemberName: string; relation: string }) {
    if (!window.healthDesktop) { setToast('请在桌面应用中建立个人工作区。'); return; }
    const result = await window.healthDesktop.createWorkspace(input);
    if (!result.ok) { setToast('建立个人工作区失败，请检查本机存储权限。'); return; }
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
      : '资料已移出处理与分析；原件、审计和既有恢复点可能仍保留，可随时重新纳入。');
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
      ? '已从当前工作区删除并阻止自动回灌；本机恢复点仍可能保留旧资料。'
      : '已从当前工作区和当前对象库删除，并保留防止自动回灌的记录。');
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
    setToast(result.data.running ? '已发送停止请求；正在确认当前 AI 处理已结束。' : '任务已停止；已保存的事实仍然保留。');
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
    setToast(['analyze', 'guidance', 'review_derived', 'publish'].includes(job.stage)
      ? '已从派生说明阶段重试，不会重新提取已保存的报告事实。'
      : '已重新核验原授权并排队重试。');
  }

  async function handleToggleQueuePause(): Promise<void> {
    if (!window.healthDesktop) return;
    const result = await window.healthDesktop.setQueuePaused(!snapshot.queuePaused);
    if (!result.ok) {
      setToast('队列状态没有更新，请稍后重试。');
      return;
    }
    setSnapshot(await window.healthDesktop.getSnapshot());
    setToast(result.data.paused ? '队列已暂停；不会领取新的 AI 任务。' : '队列已继续，将重新核验账户、额度和授权后处理。');
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
    setToast(`已设置为 ${modelPreferenceLabel(result.data)}；之后新启动的任务会使用这组设置。`);
    return true;
  }

  activeDateStyle = displayPreferences.dateStyle;
  const shellClasses = ['app-shell', evidence ? 'has-evidence' : '', displayPreferences.fontScale === 'large' ? 'font-large' : '', displayPreferences.reduceMotion ? 'reduce-motion' : ''].filter(Boolean).join(' ');

  return (
    <div className={shellClasses}>
      <Sidebar page={page} setPage={setPage} snapshot={snapshot} onWorkspace={() => setWorkspaceDialogOpen(true)} />
      <div className="app-main">
        <Topbar snapshot={snapshot} onLogin={() => void handleLogin()} onProcessing={() => setPage('processing')} />
        <main className="content-area">
          {openReview && page !== 'settings' && <ReviewBanner review={openReview} openCount={openReviews.length} onOpen={() => setReviewDialog(openReview)} />}
          {content}
        </main>
      </div>
      <EvidencePanel evidence={evidence} demo={snapshot.workspaceMode === 'demo'} onClose={() => setEvidence(null)} />
      {workspaceDialogOpen && <WorkspaceDialog snapshot={snapshot} onClose={() => setWorkspaceDialogOpen(false)} onCreate={handleCreateWorkspace} onSwitch={handleSwitchWorkspace} />}
      {memberDialogOpen && <MemberDialog onClose={() => setMemberDialogOpen(false)} onCreate={handleCreatePerson} />}
      {memberEditDialogOpen && snapshot.persons.find((person) => person.id === selectedPersonId) && <MemberEditDialog person={snapshot.persons.find((person) => person.id === selectedPersonId)!} onClose={() => setMemberEditDialogOpen(false)} onSave={handleUpdatePersonDisplay} onArchive={() => { const person = snapshot.persons.find((item) => item.id === selectedPersonId); if (person) { setMemberEditDialogOpen(false); setArchivePerson(person); } }} />}
      {archivePerson && <ArchivePersonDialog person={archivePerson} onClose={() => setArchivePerson(null)} onConfirm={handleArchivePerson} />}
      {archivedPeopleDialogOpen && <ArchivedPeopleDialog onClose={() => setArchivedPeopleDialogOpen(false)} onRestore={handleRestorePerson} onNotice={setToast} />}
      {documentToExclude && <ExcludeDocumentDialog document={documentToExclude} onClose={() => setDocumentToExclude(null)} onConfirm={() => handleSetDocumentIncluded(documentToExclude, false)} />}
      {documentToDelete && <DeleteDocumentDialog document={documentToDelete} onClose={() => setDocumentToDelete(null)} onConfirm={() => handleDeleteDocument(documentToDelete)} />}
      {deletedDocumentsDialogOpen && <DeletedDocumentsDialog onClose={() => setDeletedDocumentsDialogOpen(false)} onNotice={setToast} />}
      {directoryDialogOpen && <InboxDirectoriesDialog snapshot={snapshot} onClose={() => setDirectoryDialogOpen(false)} onNotice={setToast} />}
      {processConsentOpen && <ProcessConsentDialog snapshot={snapshot} documentIds={processDocumentIds} onClose={() => { setProcessConsentOpen(false); setProcessDocumentIds(null); }} onConfirm={() => handleProcessNow(processDocumentIds ?? undefined)} onLogin={() => void handleLogin()} />}
      {scheduleDialogOpen && <ScheduleDialog snapshot={snapshot} onClose={() => setScheduleDialogOpen(false)} onSave={handleScheduleSave} />}
      {cancelJob && <CancelJobDialog job={cancelJob} onClose={() => setCancelJob(null)} onConfirm={handleCancelJob} />}
      {backupDialogOpen && <BackupDialog onClose={() => setBackupDialogOpen(false)} onNotice={setToast} onRestored={(next) => { setSnapshot(next); setSelectedPersonId(next.persons[0]?.id ?? ''); setEvidence(null); }} />}
      {desktopDialogOpen && <DesktopBehaviorDialog behavior={desktopBehavior} onClose={() => setDesktopDialogOpen(false)} onSave={handleDesktopBehaviorSave} />}
      {displayDialogOpen && <DisplayPreferencesDialog preferences={displayPreferences} onClose={() => setDisplayDialogOpen(false)} onSave={handleDisplayPreferencesSave} />}
      {aiDialogOpen && <AiPreferencesDialog preferences={aiPreferences} onClose={() => setAiDialogOpen(false)} onSave={handleAiPreferencesSave} />}
      {accountDialogOpen && <AccountDialog snapshot={snapshot} onClose={() => setAccountDialogOpen(false)} onConnect={() => void handleLogin()} onRefresh={handleLogin} onLogout={handleLogout} />}
      {actionDialogOpen && <ActionDialog snapshot={snapshot} selectedPersonId={selectedPersonId} onClose={() => setActionDialogOpen(false)} onCreate={handleCreateAction} />}
      {manualNoteDialogOpen && <ManualNoteDialog snapshot={snapshot} selectedPersonId={selectedPersonId} onClose={() => setManualNoteDialogOpen(false)} onCreate={handleCreateManualNote} />}
      {exportDialogOpen && <ExportSummaryDialog snapshot={snapshot} selectedPersonId={selectedPersonId} onClose={() => setExportDialogOpen(false)} onExport={handleExportMemberSummary} />}
      {privacyDialogOpen && <PrivacyDialog snapshot={snapshot} onClose={() => setPrivacyDialogOpen(false)} onDirectories={() => {
        if (snapshot.workspaceMode !== 'personal') setWorkspaceDialogOpen(true);
        else setDirectoryDialogOpen(true);
      }} onBackup={() => {
        if (snapshot.workspaceMode !== 'personal') setWorkspaceDialogOpen(true);
        else setBackupDialogOpen(true);
      }} onNotice={setToast} />}
      {aboutDialogOpen && <AboutDialog snapshot={snapshot} onClose={() => setAboutDialogOpen(false)} onNotice={setToast} />}
      {jobDetail && <JobDetailDialog job={jobDetail} onClose={() => setJobDetail(null)} />}
      {reviewDialog && <ReviewResolutionDialog review={reviewDialog} snapshot={snapshot} onClose={() => setReviewDialog(null)} onEvidence={() => void handleOpenEvidence(snapshot.workspaceMode === 'demo'
        ? { title: reviewDialog.title, label: '门诊报告.docx · 标题块', quote: '姓名：林×（信息不完整）', meta: '文件夹归属与正文身份不能唯一匹配；确认前不会写入成员档案。' }
        : { title: reviewDialog.title, label: '本机导入资料', quote: '正在读取受控来源片段…', meta: reviewDialog.description, sourceSpanId: reviewDialog.evidenceRefs[0] ?? null, documentId: reviewDialog.documentId })} onResolve={handleResolveReview} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
