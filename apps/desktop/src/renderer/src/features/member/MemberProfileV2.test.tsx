// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdoptLifestyleProposalInput, BodySystemDetailV2, BodySystemSummaryV2, DashboardSnapshot, HealthAction, HealthEventDetailV2, HealthEventV2, InboxItem, LifestylePlanV2, MemberAssessmentSnapshotV3, MemberOverviewV2, ReviewIssue } from '@contracts';
import { bodySystemRegistry } from '@core';
import type { HealthDesktopBridge } from '../../../../preload/index.js';
import { createDemoSnapshot } from '../../../../../../../packages/test-fixtures/src/index.js';
import { assessmentKnowledgeStatusLabel, MemberAssessmentSystemCard, MemberProfileV2, systemAnalysisHeading, systemStatusLabel } from './MemberProfileV2.js';

const now = '2026-09-21T00:00:00.000Z';
const eventTime = (value: string) => ({
  value,
  endValue: null,
  precision: 'day' as const,
  role: 'exam' as const,
  source: 'explicit' as const,
  displayLabel: value
});

function healthEvent(id: string, title: string, date: string, documentIds: string[]): HealthEventV2 {
  return {
    id,
    personId: 'person-1',
    type: 'checkup',
    title,
    time: eventTime(date),
    summary: `${documentIds.length} 份报告`,
    systemIds: ['cardiovascular'],
    documentIds,
    factCount: documentIds.length,
    metadataStatus: 'inferred'
  };
}

afterEach(() => {
  cleanup();
  delete window.healthDesktop;
});

describe('成员内容的局部读取与保守去重', () => {
  const failure = { ok: false, error: { code: 'SYNTHETIC_READ_FAILURE', messageKey: 'synthetic_read_failure', retryable: true,
    correlationId: 'synthetic-read-failure' } } as const;

  function mount(overrides: Partial<HealthDesktopBridge> = {}) {
    const snapshot = createDemoSnapshot();
    snapshot.workspaceMode = 'personal';
    snapshot.jobs = [];
    const person = { ...snapshot.persons[0]!, id: 'load-person', acceptedFactCount: 3, derivedStatus: 'current' as const };
    snapshot.persons = [person];
    const summary = { id: 'cardiovascular', name: '心血管系统', shortName: '心血管', status: 'attention', factCount: 3,
      summary: '合成报告中的结果可查看。' } as BodySystemSummaryV2;
    const event = { ...healthEvent('load-event', '合成检查记录', '2026-09-17', ['load-doc']), personId: person.id };
    const overview: MemberOverviewV2 = { personId: person.id, generatedAt: now, dataQuality: 'partial', headline: '合成健康概况',
      overview: '请结合报告的检查条件理解。', latestClinicalDate: '2026-09-17', acceptedFactCount: 3, unclassifiedFactCount: 0,
      eventCount: 1, sourceUrgentNotices: [], currentSymptomNotices: [], attentionSystemIds: ['cardiovascular'], systems: [summary],
      priorityIssues: [], importantChanges: [], recentChanges: [], nextActions: [] };
    const detail: BodySystemDetailV2 = { personId: person.id, registry: bodySystemRegistry[0]!, summary, analysis: null, metrics: [],
      findings: [], relatedEventIds: [event.id], unmappedFactCount: 0 };
    const bridge = {
      getMemberOverview: vi.fn(async () => ({ ok: true, data: overview })),
      listBodySystems: vi.fn(async () => ({ ok: true, data: [summary] })),
      listHealthEvents: vi.fn(async () => ({ ok: true, data: [event] })),
      getLifestylePlan: vi.fn(async () => ({ ok: true, data: null })),
      getConceptReview: vi.fn(async () => ({ ok: true, data: null })),
      getMemberAssessment: vi.fn(async () => ({ ok: true, data: null })),
      getBodySystemDetail: vi.fn(async () => ({ ok: true, data: detail })),
      ...overrides
    } as unknown as HealthDesktopBridge;
    window.healthDesktop = bridge;
    const props = { snapshot, person, onSelectPerson: vi.fn(), onOpenEvidence: vi.fn(), onAddPerson: vi.fn(), onEditPerson: vi.fn(),
      onArchivedPeople: vi.fn(), onAddNote: vi.fn(), onExport: vi.fn(), onUploadReports: vi.fn(), onRefreshAssessment: vi.fn(),
      onExcludeDocument: vi.fn(), onReincludeDocument: vi.fn(), onDeleteDocument: vi.fn(), onDeletedDocuments: vi.fn() };
    const view = render(<MemberProfileV2 {...props} />);
    return { bridge, overview, detail, summary, event, props, view };
  }

  it('更多管理中的仅更新解读是可选入口，阅读成员档案不会触发它', async () => {
    const { props } = mount();
    await screen.findByRole('heading', { name: '合成健康概况' });
    expect(props.onRefreshAssessment).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('更多管理'));
    fireEvent.click(screen.getByRole('button', { name: '仅更新健康解读' }));
    expect(props.onRefreshAssessment).toHaveBeenCalledTimes(1);
  });

  it('档案首页明确区分当前成员的报告上传和手动补充，上传只传当前成员 ID', async () => {
    const { props } = mount();
    await screen.findByRole('heading', { name: '合成健康概况' });
    const upload = screen.getByRole('button', { name: '上传报告' });
    const note = screen.getByRole('button', { name: '手动补充' });
    expect(upload.getAttribute('aria-describedby')).toBe('member-report-upload-description');
    expect(screen.getByText(`上传 PDF、图片等文件，整理到${props.person.displayName}的档案。`)).toBeTruthy();
    expect(note.getAttribute('aria-describedby')).toBe('member-manual-note-description');
    expect(screen.getByText('填写症状、用药、自测结果和生活情况。')).toBeTruthy();
    fireEvent.click(upload);
    expect(props.onUploadReports).toHaveBeenCalledExactlyOnceWith(props.person.id);
    expect(props.onAddNote).not.toHaveBeenCalled();
    fireEvent.click(note);
    expect(props.onAddNote).toHaveBeenCalledExactlyOnceWith();
    expect(props.onUploadReports).toHaveBeenCalledTimes(1);
  });

  it('新增后无资料的成员仍可直接上传，切换成员后所有报告入口绑定新成员', async () => {
    const { props, overview, view } = mount();
    await screen.findByRole('heading', { name: '合成健康概况' });
    const newPerson = { ...props.person, id: 'new-empty-person', displayName: '新成员', acceptedFactCount: 0 };
    overview.personId = newPerson.id;
    overview.acceptedFactCount = 0;
    view.rerender(<MemberProfileV2 {...props} person={newPerson} snapshot={{ ...props.snapshot, persons: [newPerson] }} />);
    fireEvent.click(screen.getByRole('button', { name: '上传报告' }));
    expect(props.onUploadReports).toHaveBeenLastCalledWith(newPerson.id);
    expect(screen.getByText('上传 PDF、图片等文件，整理到新成员的档案。')).toBeTruthy();
    await screen.findByRole('heading', { name: '合成健康概况' });
    fireEvent.click(screen.getByRole('tab', { name: '原始资料' }));
    const sourceSection = screen.getByRole('heading', { name: '报告与原始资料' }).closest('section')!;
    fireEvent.click(within(sourceSection).getByRole('button', { name: '上传报告' }));
    expect(props.onUploadReports).toHaveBeenCalledTimes(2);
    expect(props.onUploadReports).toHaveBeenLastCalledWith(newPerson.id);
    expect(props.onAddNote).not.toHaveBeenCalled();
    expect(props.onRefreshAssessment).not.toHaveBeenCalled();
  });

  it.each([
    { kind: 'source', label: '部分内容未纳入' },
    { kind: 'zero', label: '已读完，暂无可用结果' },
    { kind: 'identity', label: '暂未纳入成员' },
    { kind: 'legacy', label: '部分内容未纳入' }
  ] as const)('原始资料的 $kind 与收件箱共用状态，不要求用户再次核对或批准', async ({ kind, label }) => {
    const { props, view, bridge } = mount();
    const document: InboxItem = { id: 'synthetic-source-document', displayName: '合成来源报告.pdf',
      discoveredAt: now, personId: props.person.id, personLabel: '合成成员',
      status: kind === 'zero' ? 'completed' : 'needs_review', format: 'PDF', sourceLabel: '合成来源',
      sentToAi: true, aiTransmissionStatus: kind === 'legacy' ? 'unknown' : 'completed',
      inProcessingCenter: true, issue: null,
      ...(kind === 'legacy' ? {} : { acceptedFactCount: kind === 'source' ? 2 : 0 }) };
    const review: ReviewIssue = { id: 'synthetic-source-review', documentId: document.id, personId: props.person.id,
      kind: kind === 'identity' ? 'person_conflict' : 'coverage_gap', severity: 'warning',
      title: '合成来源说明', description: '合成资料范围', evidenceRefs: [], candidateOptions: [], candidateDiffs: [],
      reportedName: null, reasonCodes: [], resolutionStatus: 'open' };
    props.snapshot.inbox = [document];
    props.snapshot.reviews = kind === 'zero' ? [] : [review];
    view.rerender(<MemberProfileV2 {...props} />);
    await screen.findByRole('heading', { name: '合成健康概况' });
    fireEvent.click(screen.getByRole('tab', { name: '原始资料' }));
    const row = screen.getByText('合成来源报告.pdf').closest('article')!;
    expect(within(row).getByText(label).className).toContain('badge--info');
    expect(within(row).queryByText('需要核对')).toBeNull();
    expect(within(row).queryByRole('button', { name: /核对|批准|确认/ })).toBeNull();
    expect(props.onRefreshAssessment).not.toHaveBeenCalled();
    expect(bridge.getMemberAssessment).toHaveBeenCalledTimes(1);
    expect(props.snapshot.inbox[0]).toBe(document);
  });

  it('成员整体概况按需展开完整原文，末尾否定和检查条件不被截掉', async () => {
    const { overview, bridge } = mount();
    const full = '心血管的现有检查需要结合测量背景理解。'.repeat(20)
      + '\n内分泌结果只反映当时检查。\n本次未散瞳，不能据此确认屈光状态，也不能说明未检查的身体情况。';
    overview.headline = '整体情况：先了解心血管、内分泌 / 代谢';
    overview.overview = full;
    await screen.findByRole('heading', { name: overview.headline });
    expect(screen.queryByText(full)).toBeNull();
    const expand = screen.getByRole('button', { name: '展开完整整体情况' });
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(expand);
    expect(screen.getByText(full.replace(/\s+/gu, ' '))).toBeTruthy();
    expect(screen.getByRole('button', { name: '收起完整整体情况' }).getAttribute('aria-expanded')).toBe('true');
    expect(bridge.getMemberAssessment).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '收起完整整体情况' }));
    expect(screen.queryByText(full.replace(/\s+/gu, ' '))).toBeNull();
    expect(screen.getByRole('tab', { name: '健康总览' }).getAttribute('aria-selected')).toBe('true');
  });

  it('成员中性概况标题和短正文仍有完整展开入口，不靠自动截句生成预览', async () => {
    const { overview } = mount();
    overview.headline = '整体健康情况';
    overview.overview = '只有2025年记录，不能代表现在；本次未散瞳，不能据此确认屈光状态。';
    await screen.findByRole('heading', { name: overview.headline });
    expect(screen.getByText(overview.overview)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '收起完整整体情况' }));
    expect(screen.queryByText(overview.overview)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开完整整体情况' }));
    expect(screen.getByText(overview.overview)).toBeTruthy();
  });

  it('长整体说明收起时首屏保留具体主题与完整适用条件，不只剩计数和地图', async () => {
    const { overview, props } = mount();
    overview.headline = '整体情况：4项重点，涉及3个身体系统';
    overview.overview = '所有检查的完整解释及条件。'.repeat(40) + '不能据此概括尚未检查的部分。';
    const context = '只有去年的检查，本次未散瞳，不能据此说明左眼现在正常。';
    overview.priorityIssues = [{ id: 'reading-topic', title: '左右眼的检查需要分别理解',
      explanation: '左眼和右眼来自不同日期的检查。', readingContext: [context],
      systemId: 'sensory_oral', nextStep: null }];
    const hero = (await screen.findByRole('heading', { name: overview.headline })).closest('section')!;
    const preview = within(hero).getByRole('region', { name: '已发布的重点主题' });
    expect(within(preview).getByText('左右眼的检查需要分别理解')).toBeTruthy();
    expect(within(preview).getByText(context)).toBeTruthy();
    expect(within(hero).queryByText(overview.overview)).toBeNull();
    fireEvent.click(within(hero).getByRole('button', { name: '展开完整整体情况' }));
    expect(within(hero).queryByRole('region', { name: '已发布的重点主题' })).toBeNull();
    expect(within(hero).getByText(overview.overview)).toBeTruthy();
    fireEvent.click(within(hero).getByRole('button', { name: '收起完整整体情况' }));
    fireEvent.click(within(hero).getByRole('button', { name: '查看完整解读：左右眼的检查需要分别理解' }));
    expect(screen.getByRole('tab', { name: '身体与指标' }).getAttribute('aria-selected')).toBe('true');
    expect(props.onRefreshAssessment).not.toHaveBeenCalled();
  });

  it.each(['stable', 'attention', 'building'] as const)('无相关事实时，%s 图标和目录标签都保持中性', async (status) => {
    const { summary } = mount();
    summary.factCount = 0;
    summary.status = status;
    await screen.findByRole('heading', { name: '合成健康概况' });
    expect(screen.getByRole('region', { name: '尚无相关检查' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '身体与指标' }));
    const directory = screen.getByRole('navigation', { name: '身体系统目录' });
    expect(within(directory).getByText('尚无相关检查')).toBeTruthy();
    expect(directory.querySelector('.system-directory__symbol')?.className).toBe('system-directory__symbol is-reading-neutral');
    await waitFor(() => expect(document.querySelector('.system-detail__hero .system-directory__symbol')?.className)
      .toBe('system-directory__symbol is-reading-neutral'));
  });

  it('有记录但无完整判断时，总览、目录和详情图标使用同一中性范围', async () => {
    const { summary } = mount();
    summary.status = 'building';
    summary.interpretationState = 'partial';
    await screen.findByRole('heading', { name: '合成健康概况' });
    expect(screen.getByRole('region', { name: '已有检查记录' })).toBeTruthy();
    const summaryCard = document.querySelector('.system-summary-grid > button');
    expect(summaryCard?.querySelector('.system-directory__symbol')?.className).toBe('system-directory__symbol is-reading-neutral');
    expect(summaryCard?.textContent).toContain('已有检查记录');
    fireEvent.click(screen.getByRole('tab', { name: '身体与指标' }));
    const directory = screen.getByRole('navigation', { name: '身体系统目录' });
    expect(within(directory).getByText('已有检查记录')).toBeTruthy();
    expect(directory.querySelector('.system-directory__symbol')?.className).toBe('system-directory__symbol is-reading-neutral');
    await waitFor(() => expect(document.querySelector('.system-detail__hero .system-directory__symbol')?.className)
      .toBe('system-directory__symbol is-reading-neutral'));
  });

  it.each(['optional_rules', 'required'] as const)('旧解读可读，区分规则升级和资料变更且保留计划边界：%s', async (refreshStatus) => {
    const assessment = { id: 'old-rules-assessment', status: 'stale', generatedAt: '2026-10-12T13:00:00Z', systems: [], claims: [], questions: [],
      evidenceCatalog: [], knowledgeSources: [], actions: [{ id: 'old-action', dedupeKey: 'old-action', kind: 'habit',
        title: '按实际情况安排散步', why: '从能坚持的活动开始。', firstStep: '选择舒适的活动时段。',
        urgency: 'routine', evidenceIds: [], knowledgeSourceIds: [], lifestyleDomain: 'activity', lifestyleBasis: 'personalized' }]
    } as unknown as MemberAssessmentSnapshotV3;
    const { props, view } = mount({ getMemberAssessment: async () => ({ ok: true, data: assessment }) });
    const person = { ...props.person, derivedStatus: 'stale' as const, assessmentRefreshStatus: refreshStatus };
    view.rerender(<MemberProfileV2 {...props} person={person} snapshot={{ ...props.snapshot, persons: [person] }} />);
    await screen.findByRole('heading', { name: '合成健康概况' });
    expect(screen.getByText(refreshStatus === 'optional_rules' ? '现有健康解读可继续查看' : '健康解读暂未更新')).toBeTruthy();
    if (refreshStatus === 'optional_rules') {
      expect(screen.queryByText(/健康解读待更新|健康解读暂未更新|需结合当前资料更新/)).toBeNull();
      expect(screen.getByText(/现有解读仍对应当前资料。后续上传的资料会按新版规则自动整理/)).toBeTruthy();
      expect(screen.getByText('已发布整体解读')).toBeTruthy();
      expect(screen.getByText('已发布解读 · 2026-10-12，基于此前规则，仍对应当前资料；可选择按新规则更新。')).toBeTruthy();
    } else {
      expect(screen.queryByText('现有健康解读可继续查看')).toBeNull();
      expect(screen.getByText('此前整体解读')).toBeTruthy();
      expect(screen.getByText('已发布解读 · 2026-10-12，需结合当前资料更新。')).toBeTruthy();
    }
    expect(screen.getByText('请结合报告的检查条件理解。')).toBeTruthy();
    const collapse = screen.getByRole('button', { name: '收起完整整体情况' });
    expect(collapse.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(collapse);
    expect(screen.queryByText('请结合报告的检查条件理解。')).toBeNull();
    const expand = screen.getByRole('button', { name: '展开完整整体情况' });
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(expand);
    expect(screen.getByText('请结合报告的检查条件理解。')).toBeTruthy();
    expect(screen.queryByText('现在怎样')).toBeNull();
    expect(props.onRefreshAssessment).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('tab', { name: '日常生活' }));
    expect(screen.getByRole('button', { name: '更新解读后可加入计划' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByText(/这些建议基于此前资料/)).toBeNull();
    expect(screen.queryByRole('button', { name: '按新规则更新解读' })).toBeNull();
    expect(props.onRefreshAssessment).not.toHaveBeenCalled();
  });

  it('成员整体概况只将支持的HTTPS引用投影为完整标签，不执行HTML或新增任意URL入口', async () => {
    const { overview } = mount();
    overview.overview = '参见[检查条件](https://example.com/conditions)，本次未散瞳，不能据此确认屈光状态。<img src=x onerror=alert(1)>[其他资料](javascript:alert(1))';
    await screen.findByRole('heading', { name: overview.headline });
    expect(screen.getByText('参见检查条件，本次未散瞳，不能据此确认屈光状态。<img src=x onerror=alert(1)>[其他资料](javascript:alert(1))')).toBeTruthy();
    expect(screen.queryByRole('link', { name: '检查条件' })).toBeNull();
    expect(document.querySelector('img')).toBeNull();
  });

  it('优先关注的解释与安排显示完整引用标签，不泄露链接语法或新增链接入口', async () => {
    const { overview } = mount();
    const explanation = '左眼 0.8、右眼 1.0，参见[检查条件](https://example.com/conditions)；未散瞳，不能确认屈光状态。';
    overview.priorityIssues = [{ id: 'linked-priority', title: '分别理解两眼结果', explanation, systemId: 'sensory_oral',
      nextStep: '结合[当时检查背景](https://example.com/background)理解，未检查时不要补造结果。',
      relatedExplanations: [{ id: 'related-limit', title: '结果的适用条件', systemId: 'sensory_oral',
        explanation: '参见[完整限制](https://example.com/limits)，只有旧记录，不能说明现在。' }],
      additionalNextSteps: ['按[既有约定](https://example.com/plan)安排；如有不适则提前就诊。'] }];
    await screen.findByRole('heading', { name: overview.headline });
    const card = screen.getByRole('article', { name: '分别理解两眼结果' });
    expect(within(card).getByText('左眼 0.8、右眼 1.0，参见检查条件；未散瞳，不能确认屈光状态。')).toBeTruthy();
    expect(within(card).getByText('先做：结合当时检查背景理解，未检查时不要补造结果。')).toBeTruthy();
    fireEvent.click(within(card).getByText('查看相关解释与其他安排'));
    expect(within(card).getByText('参见完整限制，只有旧记录，不能说明现在。')).toBeTruthy();
    expect(within(card).getByText('按既有约定安排；如有不适则提前就诊。')).toBeTruthy();
    expect(within(card).queryAllByRole('link')).toHaveLength(0);
    expect(card.textContent).not.toContain('https://');
    expect(overview.priorityIssues[0]!.explanation).toBe(explanation);
  });

  it('报告文字和原始依据不经过派生引用整理，打开来源仍带完整原句', async () => {
    const { detail, props } = mount();
    const original = '报告原话：[检查说明](https://example.com/original)，左侧未见异常，结果 <0.1。';
    detail.findings = [{ id: 'original-finding', title: '原报告文字', value: original, time: eventTime('2026-09-17'),
      abnormalFlag: 'unknown', evidence: [{ id: 'original-reference', kind: 'observation', observationId: 'original-finding',
        eventId: 'load-event', documentId: 'load-doc', sourceSpanId: 'original-span', knowledgeId: null, label: '原报告',
        locator: '第1页', quote: original }] }];
    await screen.findByRole('heading', { name: '合成健康概况' });
    fireEvent.click(screen.getByRole('tab', { name: '身体与指标' }));
    expect(await screen.findByText(original)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '查看依据' }));
    expect(props.onOpenEvidence).toHaveBeenCalledWith(expect.objectContaining({ quote: original, sourceSpanId: 'original-span' }));
    expect(detail.findings[0]!.value).toBe(original);
  });

  it('本人计划的链接语法、目标、具体安排和备注保持纯文本原样，不受派生正文整理影响', async () => {
    const title = '本人安排：[原计划](https://example.com/own-plan)';
    const userGoal = '本人目标：[保留目标](https://example.com/goal)，没有不适时照常。';
    const selectedStartingOption = '本人选择：[原做法](https://example.com/option)，如有不适就停止。';
    const progressNote = '本人备注：![未作图片处理](https://example.com/image)<img src=x onerror=alert(1)>';
    const plan: LifestylePlanV2 = { personId: 'load-person', status: 'stale', dataQuality: 'partial', updatedAt: now,
      priorities: [], proposals: [], adoptedActions: [{ id: 'user-markdown-plan', proposalId: null, title, userGoal,
        selectedStartingOption, progressNote, owner: '本人', plannedTime: null, dueDate: null, status: 'planned', updatedAt: now }] };
    mount({ getLifestylePlan: async () => ({ ok: true, data: plan }) });
    await screen.findByRole('heading', { name: '合成健康概况' });
    fireEvent.click(screen.getByRole('tab', { name: '日常生活' }));
    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByText(userGoal)).toBeTruthy();
    expect(screen.getByText(selectedStartingOption)).toBeTruthy();
    expect(screen.getByText(`备注：${progressNote}`)).toBeTruthy();
    expect(screen.queryByRole('link', { name: '原计划' })).toBeNull();
    expect(document.querySelector('img')).toBeNull();
    expect(plan.adoptedActions[0]!.progressNote).toBe(progressNote);
  });

  it.each(['user_created', 'clinician_document', 'ai_proposed', null] as const)('无综合时的接下来标题按真实来源分流：%s', async (origin) => {
    const title = '参照[既有安排](https://example.com/plan)，没有不适时无需自行提前。';
    const { overview, props, view } = mount();
    overview.nextActions = [{ id: 'origin-aware-action', title, status: 'planned' }];
    const actions = origin ? [...props.snapshot.actions, { id: 'origin-aware-action', personId: props.person.id, title,
      detail: title, origin, status: 'planned' as const, dueDate: null, dueText: null, evidenceLabel: null, userRevision: 1, updatedAt: now }]
      : props.snapshot.actions;
    view.rerender(<MemberProfileV2 {...props} snapshot={{ ...props.snapshot, actions }} />);
    await screen.findByRole('heading', { name: '合成健康概况' });
    const next = screen.getByRole('heading', { name: '接下来' }).closest('section')!;
    expect(within(next).getByText(origin === 'ai_proposed' ? '参照既有安排，没有不适时无需自行提前。' : title)).toBeTruthy();
    expect(within(next).queryAllByRole('link')).toHaveLength(0);
    expect(overview.nextActions[0]!.title).toBe(title);
  });

  it.each(['身体系统', '日常生活'] as const)('%s保留原句绑定的医生指示，派生解释仍仅显示引用标签', async (surface) => {
    const firstStep = '参照[报告原安排](https://example.com/original)，若持续不适请三天内复查；没有不适时无需自行提前。';
    const action: HealthAction = { id: 'bound-instruction', dedupeKey: 'bound-instruction', kind: 'documented_plan',
      sourceInstructionObservationId: 'original-instruction', title: '报告中的医生安排',
      why: '参见[适用条件](https://example.com/conditions)，只有旧记录，不能说明现在。', firstStep,
      systemIds: ['cardiovascular'], claimIds: [], timing: null, timingBasis: 'none', reviewPlan: null, caution: null,
      urgency: 'routine', evidenceIds: [], knowledgeSourceIds: [] };
    const assessment = { id: 'instruction-assessment', status: 'current',
      systems: [{ systemId: 'cardiovascular', headline: '按检查条件理解', summary: '', claimIds: [], actionIds: [action.id], limitations: [] }],
      claims: [], actions: [action], questions: [], evidenceCatalog: [], knowledgeSources: [], knowledgeVerifications: [],
      validationMode: 'local_and_focused_review', reviewedTargetIds: [], heldTargetIds: [] } as unknown as MemberAssessmentSnapshotV3;
    if (surface === '身体系统') render(<MemberAssessmentSystemCard assessment={assessment} systemId="cardiovascular" factCount={1} onOpenEvidence={vi.fn()} />);
    else {
      mount({ getMemberAssessment: async () => ({ ok: true, data: assessment }) });
      await screen.findByRole('heading', { name: '合成健康概况' });
      fireEvent.click(screen.getByRole('tab', { name: '日常生活' }));
    }
    expect(screen.getByText(firstStep)).toBeTruthy();
    expect(screen.getByText('参见适用条件，只有旧记录，不能说明现在。')).toBeTruthy();
    expect(screen.queryByRole('link', { name: '报告原安排' })).toBeNull();
    expect(action.firstStep).toBe(firstStep);
  });

  it('日常生活按五个主题读具体建议，通用建议有标记，复查单列，时间线与原始资料排在末尾', async () => {
    const action = (id: string, title: string, domain: HealthAction['lifestyleDomain'], basis: HealthAction['lifestyleBasis']): HealthAction => ({
      id, dedupeKey: id, kind: 'habit', title, why: `${title}的相关原因。`, firstStep: `${title}的具体做法。`,
      systemIds: [], claimIds: [], timing: '按实际情况安排。', timingBasis: 'practical_trial', reviewPlan: null,
      caution: `${title}的个人限制。`, urgency: 'routine', evidenceIds: [], knowledgeSourceIds: [], lifestyleDomain: domain, lifestyleBasis: basis
    });
    const actions = [action('meal', '调整三餐搭配', 'diet', 'personalized'), action('move', '找到能持续的活动', 'activity', 'personalized'),
      action('sleep', '安排睡眠休息', 'sleep', 'general'), action('supp', '先查看现有补充剂', 'supplements', 'personalized'),
      action('habit', '记录身体变化', 'daily_routine', 'personalized'),
      { ...action('medical', '整理报告准备复诊', undefined, undefined), kind: 'seek_care' as const }];
    const assessment = { id: 'daily-assessment', status: 'current', systems: [], claims: [], actions, questions: [],
      evidenceCatalog: [], knowledgeSources: [] } as unknown as MemberAssessmentSnapshotV3;
    mount({ getMemberAssessment: async () => ({ ok: true, data: assessment }) });
    await screen.findByRole('heading', { name: '合成健康概况' });
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['健康总览', '身体与指标', '日常生活', '检查时间线', '原始资料']);
    fireEvent.click(screen.getByRole('tab', { name: '日常生活' }));
    const regions = ['饮食与摄入', '运动与活动', '睡眠与休息', '营养补充与保健品', '日常习惯与自我观察'];
    for (const [index, name] of regions.entries()) {
      const region = screen.getByRole('region', { name });
      expect(within(region).getByRole('heading', { name: actions[index]!.title })).toBeTruthy();
      expect(within(region).getByText(actions[index]!.firstStep)).toBeTruthy();
      expect(within(region).getByText(actions[index]!.caution!)).toBeTruthy();
    }
    expect(within(screen.getByRole('region', { name: '睡眠与休息' })).getByText('通用建议')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: '睡眠与休息' })).queryByText('结合你的情况')).toBeNull();
    const medical = screen.getByRole('heading', { name: '需要与医生一起安排的事' }).closest('section')!;
    expect(within(medical).getByRole('heading', { name: '整理报告准备复诊' })).toBeTruthy();
    expect(screen.getAllByRole('heading', { name: '调整三餐搭配' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: '更新日常建议' })).toBeNull();
  });

  it('历史建议缺少睡眠与补充剂时温和说明，不强制用户点击更新，保留本人已有安排', async () => {
    const assessment = { id: 'old-daily', status: 'current', systems: [], claims: [], questions: [], evidenceCatalog: [], knowledgeSources: [],
      actions: [{ id: 'old-meal', dedupeKey: 'old-meal', kind: 'habit', title: '晚餐增加蔬菜', why: '从现有晚餐习惯开始。',
        firstStep: '记录晚餐的实际搭配。', urgency: 'routine', evidenceIds: [], knowledgeSourceIds: [] }]
    } as unknown as MemberAssessmentSnapshotV3;
    const plan: LifestylePlanV2 = { personId: 'load-person', status: 'stale', dataQuality: 'partial', updatedAt: now, priorities: [], proposals: [],
      adoptedActions: [{ id: 'own-habit', proposalId: null, title: '本人晚饭后散步', userGoal: '保持现有活动', selectedStartingOption: '由家人陪同散步',
        plannedTime: '周三晚饭后', owner: '家人', progressNote: '膝盖不适时休息', status: 'planned', dueDate: '2026-10-15', updatedAt: now }] };
    const { props } = mount({ getMemberAssessment: async () => ({ ok: true, data: assessment }), getLifestylePlan: async () => ({ ok: true, data: plan }) });
    await screen.findByRole('heading', { name: '合成健康概况' });
    fireEvent.click(screen.getByRole('tab', { name: '日常生活' }));
    expect(within(screen.getByRole('region', { name: '睡眠与休息' })).getByText('目前还没有这一部分的建议。')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: '营养补充与保健品' })).getByText('目前还没有这一部分的建议。')).toBeTruthy();
    expect(screen.getByText('本人晚饭后散步')).toBeTruthy();
    expect(screen.getByText('我设定的日期：2026-10-15')).toBeTruthy();
    expect(screen.getByText('备注：膝盖不适时休息')).toBeTruthy();
    expect(props.onRefreshAssessment).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '更新日常建议' })).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('方面本次暂未发布可采用的建议');
    expect(screen.getByRole('status').textContent).toContain('不需要重复确认或重新上传');
    expect(screen.getByRole('status').textContent).not.toContain('资料整理完成后会自动更新健康看板');
    expect(props.onRefreshAssessment).not.toHaveBeenCalled();
    expect(assessment.actions[0]!.lifestyleBasis).toBeUndefined();
  });

  it.each([false, true])('已有解读=%s 时只整理提案标题，本人填写的目标和进度原样保留', async (hasAssessment) => {
    const title = '经模型核对，继续记录血压。';
    const userGoal = '我的目标是等模型复核后带上既往报告。';
    const selectedStartingOption = '本人选定：模型复核前也先记录，未散瞳，不能据此确认屈光状态。';
    const plannedTime = '等模型复核后讨论时间';
    const owner = '模型复核时由本人联系';
    const progressNote = '已按原计划开始，不等模型复核。';
    const adopted = { id: 'stored-adoption', proposalId: 'stored-proposal', title, userGoal, selectedStartingOption,
      plannedTime, owner, progressNote, status: 'in_progress' as const, dueDate: null, updatedAt: now };
    const plan: LifestylePlanV2 = { personId: 'load-person', status: 'stale', dataQuality: 'partial', updatedAt: now,
      priorities: [], proposals: [], adoptedActions: [adopted, { ...adopted, id: 'user-action', proposalId: null,
        title: '本人安排：等模型复核后再讨论', userGoal: '本人安排：等模型复核后再讨论' },
      { ...adopted, id: 'report-action', proposalId: null, assessmentDedupeKey: 'report-linked',
        title: '经模型核对，原报告记载的安排。', userGoal: '经模型核对，原报告记载的安排。',
        selectedStartingOption: '原报告中的安排保持原样。', owner: '本人', plannedTime: null, progressNote: null, status: 'planned' }] };
    const assessment = hasAssessment ? { status: 'current', systems: [], claims: [], actions: [], questions: [],
      evidenceCatalog: [], knowledgeSources: [] } as unknown as MemberAssessmentSnapshotV3 : null;
    mount({ getLifestylePlan: async () => ({ ok: true, data: plan }),
      getMemberAssessment: async () => ({ ok: true, data: assessment }) });
    await screen.findByRole('heading', { name: '合成健康概况' });
    fireEvent.click(screen.getByRole('tab', { name: '日常生活' }));
    expect(screen.getByText('继续记录血压。')).toBeTruthy();
    expect(screen.queryByText(title)).toBeNull();
    expect(screen.getByText('本人安排：等模型复核后再讨论')).toBeTruthy();
    expect(screen.getByText('经模型核对，原报告记载的安排。')).toBeTruthy();
    expect(screen.getByText(userGoal)).toBeTruthy();
    expect(screen.getAllByText(selectedStartingOption)).toHaveLength(2);
    expect(screen.getAllByText(`备注：${progressNote}`)).toHaveLength(2);
    expect(screen.getAllByText(`负责人：${owner}`)).toHaveLength(2);
    expect(screen.getAllByText(`我的安排：${plannedTime}`)).toHaveLength(2);
    expect(screen.getAllByText('进度：进行中')).toHaveLength(2);
    expect(adopted.title).toBe(title);
    expect(adopted.progressNote).toBe(progressNote);
  });

  it.each([
    ['planned', true, '已计划'], ['in_progress', true, '进行中'], ['completed', true, '已完成'],
    ['dismissed', true, '已取消'], ['planned', false, '尚未加入计划']
  ] as const)('总览按稳定关联显示实际计划状态 %s（匹配=%s），不按医生建议的同名标题猜测', async (status, matched, label) => {
    const overview: MemberOverviewV2 = { personId: 'load-person', generatedAt: now, dataQuality: 'partial',
      headline: '合成健康概况', overview: '报告结果可供查看。', latestClinicalDate: '2026-09-17', acceptedFactCount: 1,
      unclassifiedFactCount: 0, eventCount: 1, sourceUrgentNotices: [], currentSymptomNotices: [], attentionSystemIds: [],
      systems: [], priorityIssues: [], importantChanges: [], recentChanges: [],
      nextActions: [{ id: 'report-action', title: '报告中的医生建议', status: '建议，尚未加入我的计划' }] };
    const assessment = { status: 'current', systems: [], claims: [], questions: [], evidenceCatalog: [], knowledgeSources: [],
      actions: [{ id: 'report-action', dedupeKey: 'report-source-a', title: '报告中的医生建议' }]
    } as unknown as MemberAssessmentSnapshotV3;
    const plan: LifestylePlanV2 = { personId: 'load-person', status: 'unavailable', dataQuality: 'partial', updatedAt: now,
      priorities: [], proposals: [], adoptedActions: [{ id: 'saved-action', proposalId: null,
        assessmentDedupeKey: matched ? 'report-source-a' : 'different-report-source', title: '报告中的医生建议',
        userGoal: '本人决定就诊', selectedStartingOption: '按预约安排', plannedTime: null, owner: '本人', progressNote: null,
        status, dueDate: null, updatedAt: now }] };
    const { props, view } = mount({ getMemberOverview: async () => ({ ok: true, data: overview }),
      getMemberAssessment: async () => ({ ok: true, data: assessment }), getLifestylePlan: async () => ({ ok: true, data: plan }) });
    expect(await screen.findByText(label)).toBeTruthy();
    if (matched) expect(screen.queryByText('尚未加入计划')).toBeNull();
    expect(overview.nextActions[0]!.status).toBe('建议，尚未加入我的计划');
    if (status === 'planned' && matched) {
      const refreshedSnapshot = { ...props.snapshot, actions: [{ id: 'saved-action', personId: props.person.id,
        title: '报告中的医生建议', detail: '按预约安排', origin: 'clinician_document' as const, status: 'completed' as const,
        dueDate: '2026-10-15', dueText: null, evidenceLabel: null, userRevision: 2, updatedAt: now }] };
      view.rerender(<MemberProfileV2 {...props} snapshot={refreshedSnapshot} />);
      expect(screen.getByText('已完成')).toBeTruthy();
      expect(screen.queryByText('已计划')).toBeNull();
      expect(props.onRefreshAssessment).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['exact-id', 'planned', '已计划'], ['exact-id', 'paused', '已暂停'], ['exact-id', 'completed', '已完成'],
    ['dedupe-key', 'in_progress', '进行中'], ['same-title-only', 'planned', null],
    ['exact-id', 'dismissed', null], ['other-person', 'planned', null]
  ] as const)('生活建议按同成员原项 ID 或稳定键显示已有计划 %s / %s，不覆盖本人内容', async (match, status, label) => {
    const action: HealthAction = { id: 'existing-action', dedupeKey: 'seated-activity', kind: 'habit', lifestyleDomain: 'activity',
      lifestyleBasis: 'personalized', title: '保留坐位舒缓活动', why: '双膝疼痛限制连续步行，已有坐位活动符合本人耐受。',
      firstStep: '保留晚饭后坐位舒缓活动8分钟，膝痛就停下，不跑步。', timing: '晚饭后', timingBasis: 'practical_trial',
      reviewPlan: null, caution: null, urgency: 'routine', systemIds: [], claimIds: [], evidenceIds: [], knowledgeSourceIds: [] };
    const assessment = { id: 'assessment-current', personId: 'load-person', status: 'current', systems: [], claims: [], questions: [],
      evidenceCatalog: [], knowledgeSources: [], actions: [action] } as unknown as MemberAssessmentSnapshotV3;
    const adopted: LifestylePlanV2['adoptedActions'][number] = {
      id: match === 'exact-id' || match === 'other-person' ? action.id : 'saved-action', proposalId: null,
      assessmentDedupeKey: match === 'dedupe-key' ? action.dedupeKey : null, title: action.title,
      userGoal: '保留本人已有安排', selectedStartingOption: '每天晚饭后坐位舒缓活动8分钟；膝痛就停止。',
      plannedTime: '每天晚饭后', owner: '本人', progressNote: '本人已做三天，膝部没有加重。', status, dueDate: null, updatedAt: now
    };
    const plan: LifestylePlanV2 = { personId: match === 'other-person' ? 'another-person' : 'load-person', status: 'unavailable',
      dataQuality: 'partial', updatedAt: now, priorities: [], proposals: [], adoptedActions: [adopted] };
    const adoptMemberAssessmentAction = vi.fn();
    mount({ getMemberAssessment: async () => ({ ok: true, data: assessment }),
      getLifestylePlan: async () => ({ ok: true, data: plan }), adoptMemberAssessmentAction });
    await screen.findByRole('heading', { name: '合成健康概况' });
    fireEvent.click(screen.getByRole('tab', { name: '日常生活' }));
    const candidate = document.querySelector('.assessment-action-card')!;
    if (label) {
      expect(within(candidate as HTMLElement).getByText(`已加入后续事项 · ${label}`)).toBeTruthy();
      expect(within(candidate as HTMLElement).queryByRole('button', { name: '加入后续事项' })).toBeNull();
    } else {
      expect(within(candidate as HTMLElement).getByRole('button', { name: '加入后续事项' })).toBeTruthy();
      expect(within(candidate as HTMLElement).queryByText(/已加入后续事项/)).toBeNull();
    }
    expect(screen.getByText(adopted.selectedStartingOption!)).toBeTruthy();
    expect(screen.getByText(`备注：${adopted.progressNote}`)).toBeTruthy();
    expect(adopted.status).toBe(status);
    expect(adopted.assessmentDedupeKey).toBe(match === 'dedupe-key' ? action.dedupeKey : null);
    expect(adoptMemberAssessmentAction).not.toHaveBeenCalled();
  });

  it('补充问题打开带问题上下文的本人补充入口，不代填答案或自动更新分析', async () => {
    const question = '最近有没有新的检查结果？';
    const assessment = { id: 'question-snapshot', status: 'current', systems: [], claims: [], actions: [],
      questions: [{ id: 'question-followup', question, whyItMatters: '较新的结果会影响对目前情况的理解。' }],
      evidenceCatalog: [], knowledgeSources: [] } as unknown as MemberAssessmentSnapshotV3;
    const { props } = mount({ getMemberAssessment: async () => ({ ok: true, data: assessment }) });
    await screen.findByRole('heading', { name: '合成健康概况' });
    fireEvent.click(screen.getByRole('tab', { name: '日常生活' }));
    expect(props.onAddNote).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: `补充这项信息：${question}` }));
    expect(props.onAddNote).toHaveBeenCalledExactlyOnceWith({ questionId: 'question-followup', snapshotId: 'question-snapshot', question });
    expect(props.onRefreshAssessment).not.toHaveBeenCalled();
    expect(assessment.questions[0]).not.toHaveProperty('answer');
    props.onAddNote.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '手动补充' }));
    expect(props.onAddNote).toHaveBeenCalledExactlyOnceWith();
  });

  it.each([false, true])('已有解读=%s 时区分原建议时间、本人安排及我设定的日期，缺值不补造', async (hasAssessment) => {
    const action = { id: 'dated-action', proposalId: null, title: '晚饭后散步', userGoal: '保持适量活动',
      selectedStartingOption: '按自己可承受的程度开始', plannedTime: '周二晚饭后', owner: '本人', progressNote: null,
      reportTiming: '每周分次活动；如果不适就停止。',
      status: 'planned' as const, dueDate: '2026-11-03', updatedAt: now };
    const plan: LifestylePlanV2 = { personId: 'load-person', status: 'current', dataQuality: 'partial', updatedAt: now,
      priorities: [], proposals: [], adoptedActions: [action, { ...action, id: 'without-review', title: '保留现有活动', reportTiming: null, dueDate: null },
        { ...action, id: 'without-timing', title: '查看现有计划', reportTiming: undefined, plannedTime: null, dueDate: null }] };
    const assessment = hasAssessment ? { status: 'current', systems: [], claims: [], actions: [], questions: [],
      evidenceCatalog: [], knowledgeSources: [] } as unknown as MemberAssessmentSnapshotV3 : null;
    mount({ getLifestylePlan: async () => ({ ok: true, data: plan }), getMemberAssessment: async () => ({ ok: true, data: assessment }) });
    await screen.findByRole('heading', { name: '合成健康概况' });
    fireEvent.click(screen.getByRole('tab', { name: '日常生活' }));
    expect(screen.getByText('我设定的日期：2026-11-03')).toBeTruthy();
    expect(screen.getAllByText('负责人：本人')).toHaveLength(3);
    expect(screen.getAllByText('我的安排：周二晚饭后')).toHaveLength(2);
    expect(screen.getByText('原建议时间：每周分次活动；如果不适就停止。')).toBeTruthy();
    expect(screen.getAllByText(/原建议时间：/)).toHaveLength(1);
    expect(screen.getAllByText(/我的安排：/)).toHaveLength(2);
    expect(screen.getAllByText(/我设定的日期：/)).toHaveLength(1);
    expect(action.plannedTime).toBe('周二晚饭后');
    expect(action.dueDate).toBe('2026-11-03');
    expect(action.reportTiming).toBe('每周分次活动；如果不适就停止。');
  });

  it.each(['body', 'guidance'] as const)('在%s中的医生建议可查看自身的全部原始依据，不借用其他判断的引用', async (tab) => {
    const action = { id: 'reported-action', dedupeKey: 'reported-action', kind: 'documented_plan', title: '报告中的医生建议',
      why: '请结合家庭血压记录复诊。', firstStep: '记录家庭血压，复诊时带给医生。', timing: null, reviewPlan: null, caution: null,
      urgency: 'routine', timingBasis: 'none', evidenceIds: ['source-a', 'source-b', 'source-a'], knowledgeSourceIds: ['knowledge-a'] };
    const assessment = { status: 'current', claims: [], questions: [], actions: [action], knowledgeVerifications: [],
      systems: [{ id: 'cardio', systemId: 'cardiovascular', headline: '现有血压记录可供复诊参考。', summary: '', claimIds: [], actionIds: [action.id], limitations: [] }],
      evidenceCatalog: [
        { id: 'source-a', label: '复诊报告', locator: '第 2 页', sourceSpanId: 'span-a', documentId: 'doc-a', quote: '记录家庭血压。' },
        { id: 'source-b', label: '复診附件', locator: '第 3 页', sourceSpanId: 'span-b', documentId: 'doc-b', quote: '复诊时带给医生。' },
        { id: 'unrelated', label: '另一份报告', locator: '第 1 页', sourceSpanId: 'span-other', documentId: 'doc-other', quote: '其他内容。' }
      ], knowledgeSources: [{ id: 'knowledge-a', title: '家庭测量通用资料', url: 'https://example.com/home-bp' }]
    } as unknown as MemberAssessmentSnapshotV3;
    const { props } = mount({ getMemberAssessment: async () => ({ ok: true, data: assessment }) });
    await screen.findByRole('heading', { name: '合成健康概况' });
    fireEvent.click(screen.getByRole('tab', { name: tab === 'body' ? '身体与指标' : '日常生活' }));
    await screen.findByRole('heading', { name: action.title });
    const sources = screen.getByText('查看建议依据（2处）').closest('details')!;
    expect(sources.open).toBe(false);
    fireEvent.click(screen.getByText('查看建议依据（2处）'));
    expect(screen.queryByRole('button', { name: /查看建议依据：另一份报告/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看建议依据：复诊报告 · 第 2 页' }));
    expect(props.onOpenEvidence).toHaveBeenLastCalledWith(expect.objectContaining({ title: '建议依据', documentId: 'doc-a', sourceSpanId: 'span-a', quote: '记录家庭血压。' }));
    fireEvent.click(screen.getByRole('button', { name: '查看建议依据：复診附件 · 第 3 页' }));
    expect(props.onOpenEvidence).toHaveBeenLastCalledWith(expect.objectContaining({ documentId: 'doc-b', sourceSpanId: 'span-b', quote: '复诊时带给医生。' }));
    expect(screen.getByText('家庭测量通用资料').closest('a')?.href).toBe('https://example.com/home-bp');
    expect(action.evidenceIds).toEqual(['source-a', 'source-b', 'source-a']);
  });

  it('首屏保留全部高影响关注项和三个普通主题，其余可展开而非删除', async () => {
    const { overview } = mount();
    const ordinary = Array.from({ length: 5 }, (_, index) => ({ id: `ordinary-${index}`, title: `普通主题${index + 1}`,
      explanation: `普通主题${index + 1}的具体解释。`, nextStep: '带上相关报告咨询医生。', systemId: 'cardiovascular' as const }));
    const highPriority = Array.from({ length: 4 }, (_, index) => ({ id: `important-${index}`, title: `及时处理主题${index + 1}`,
      explanation: `如果出现合成症状${index + 1}，请按报告的及时就医要求处理。`, nextStep: '带上相关报告咨询医生。', systemId: 'cardiovascular' as const, isHighPriority: true }));
    overview.priorityIssues = [...ordinary, ...highPriority];
    await screen.findByRole('heading', { name: '合成健康概况' });
    const section = screen.getByRole('heading', { name: '优先关注' }).closest('section')!;
    const firstScreenList = section.querySelector(':scope > .priority-issue-list')! as HTMLElement;
    expect(within(firstScreenList).getAllByRole('article')).toHaveLength(7);
    for (const issue of highPriority) {
      const card = within(firstScreenList).getByRole('article', { name: issue.title });
      expect(within(card).getByText(issue.explanation)).toBeTruthy();
      expect(within(card).getByText(`先做：${issue.nextStep}`)).toBeTruthy();
    }
    expect(within(firstScreenList).queryByRole('article', { name: '普通主题4' })).toBeNull();
    const disclosure = within(section).getByText('查看其他关注事项（2项）');
    expect(disclosure.closest('details')?.open).toBe(false);
    fireEvent.click(disclosure);
    expect(within(section).getAllByRole('article')).toHaveLength(9);
    expect(within(section).getAllByText('先做：带上相关报告咨询医生。')).toHaveLength(9);
    expect(overview.priorityIssues).toHaveLength(9);
  });

  it('同主题解释和额外行动按需展开，保留左右侧、条件与时限完整句子', async () => {
    const { overview } = mount();
    const extraStep = '若右眼仍有不适，请在三天内复诊；左眼按原约定三个月后复查。';
    overview.priorityIssues = [{ id: 'eye-topic', title: '分别留意两眼的变化', explanation: '左眼检查条件尚不完整。',
      nextStep: '带上左右眼报告咨询医生。', systemId: 'cardiovascular', relatedExplanations: [
        { id: 'right-eye', title: '右眼结果的参考范围', explanation: '右眼未散瞳，不能直接与散瞳后的结果比较。', systemId: 'sensory_oral' }
      ], additionalNextSteps: ['带上左右眼报告咨询医生。', extraStep, extraStep] }];
    await screen.findByRole('heading', { name: '合成健康概况' });
    const section = screen.getByRole('heading', { name: '优先关注' }).closest('section')!;
    expect(within(section).getAllByRole('article')).toHaveLength(1);
    const article = within(section).getByRole('article', { name: '分别留意两眼的变化' });
    const disclosure = within(article).getByText('查看相关解释与其他安排');
    expect(disclosure.closest('details')?.open).toBe(false);
    expect(article.querySelector('button details')).toBeNull();
    fireEvent.click(disclosure);
    expect(screen.getByRole('tab', { name: '健康总览' }).getAttribute('aria-selected')).toBe('true');
    expect(within(article).getByText('右眼未散瞳，不能直接与散瞳后的结果比较。')).toBeTruthy();
    expect(within(article).getAllByText(extraStep)).toHaveLength(1);
    expect(within(article).getAllByText(/带上左右眼报告咨询医生/)).toHaveLength(1);
    fireEvent.click(within(article).getByRole('button', { name: '分别留意两眼的变化' }));
    expect(screen.getByRole('tab', { name: '身体与指标' }).getAttribute('aria-selected')).toBe('true');
    expect(overview.priorityIssues[0]!.additionalNextSteps).toEqual(['带上左右眼报告咨询医生。', extraStep, extraStep]);
  });

  it.each([
    ['other', '检查'], ['laboratory', '检验'], ['imaging', '影像'], ['checkup', '体检'],
    ['outpatient', '门诊'], ['inpatient', '住院'], ['self_measurement', '本人测量'], ['manual_note', '本人补充']
  ] as const)('时间线按明确事件类型显示标签：%s', async (type, label) => {
    const event = { ...healthEvent('typed-event', type === 'other' ? '儿童眼科检查报告' : '合成分类记录', '2026-09-12', ['typed-doc']),
      personId: 'load-person', type };
    mount({ listHealthEvents: async () => ({ ok: true, data: [event] }) });
    await screen.findByRole('heading', { name: '合成健康概况' });
    fireEvent.click(screen.getByRole('tab', { name: '检查时间线' }));
    const row = screen.getByRole('button', { name: new RegExp(event.title) });
    expect(within(row).getByText(label, { exact: true })).toBeTruthy();
    if (type === 'other') expect(within(row).queryByText('检验', { exact: true })).toBeNull();
  });

  it('检查日期未记录只说明缺少日期，详情不展示录入修正状态，也不补造日期', async () => {
    const event: HealthEventV2 = { ...healthEvent('undated-event', '合成未注明日期报告', '', ['undated-doc']), personId: 'load-person',
      time: { value: null, endValue: null, precision: 'unknown', role: 'exam', source: 'unknown', displayLabel: '报告日期待确认' },
      metadataStatus: 'unknown' };
    const detail = { ...event, reportId: 'undated-report', organization: null, department: null,
      reports: [], findings: [], historicalReferences: [], evidence: [], metadataCanUndo: false, relationCanUndo: false } as unknown as HealthEventDetailV2;
    mount({ listHealthEvents: async () => ({ ok: true, data: [event] }), getHealthEventDetail: async () => ({ ok: true, data: detail }) });
    await screen.findByRole('heading', { name: '合成健康概况' });
    fireEvent.click(screen.getByRole('tab', { name: '检查时间线' }));
    fireEvent.click(screen.getByRole('button', { name: /合成未注明日期报告/ }));
    await screen.findByRole('heading', { name: '合成未注明日期报告' });
    expect(screen.getByText('检查日期未记录')).toBeTruthy();
    expect(screen.queryByText(/报告日期待确认|本人已修正|报告日期已记录|检查日期或机构待确认/)).toBeNull();
    expect(detail.time.value).toBeNull();
    expect(screen.getByRole('button', { name: '修正报告信息' })).toBeTruthy();
  });

  it.each(['single', 'no-other-reports', 'no-current-reports', 'unavailable-controls'] as const)('没有可操作的报告整理时不向成员发出确认问句：%s', async (mode) => {
    const event = { ...healthEvent('organize-current', '当前检查', '2026-09-17', ['current-doc']), personId: 'load-person' };
    const other = { ...healthEvent('organize-other', '其他检查', '2026-09-18', mode === 'no-other-reports' ? [] : ['other-doc']), personId: 'load-person' };
    const detail = { ...event, reports: mode === 'no-current-reports' ? [] : [{ reportId: 'current-report', documentId: 'current-doc', title: '当前报告' }],
      evidence: [], findings: [], historicalReferences: [], metricSeriesIds: [], metadataCanUndo: false, relationCanUndo: false } as unknown as HealthEventDetailV2;
    const merge = vi.fn();
    mount({ listHealthEvents: async () => ({ ok: true, data: mode === 'single' ? [event] : [event, other] }),
      getHealthEventDetail: async () => ({ ok: true, data: detail }),
      ...(mode === 'unavailable-controls' ? {} : { mergeHealthEvents: merge }) });
    await screen.findByRole('heading', { name: '合成健康概况' });
    fireEvent.click(screen.getByRole('tab', { name: '检查时间线' }));
    fireEvent.click(screen.getByRole('button', { name: /当前检查/ }));
    await screen.findByRole('heading', { name: '当前检查' });
    expect(screen.queryByText('整理这次检查的报告（可选）')).toBeNull();
    expect(screen.queryByText('这些报告是否属于同一次检查？')).toBeNull();
    expect(document.querySelector('.event-organizer')).toBeNull();
    expect(merge).not.toHaveBeenCalled();
  });

  it.each(['split', 'undo'] as const)('没有其他检查候选时仍保留可执行的%s整理入口', async (mode) => {
    const event = { ...healthEvent('organize-current', '当前检查', '2026-09-17', ['current-doc']), personId: 'load-person' };
    const reports = [{ reportId: 'current-report', documentId: 'current-doc', title: '当前报告' }];
    const detail = { ...event, reports: mode === 'split' ? [...reports, { reportId: 'second-report', documentId: 'second-doc', title: '第二份报告' }] : reports,
      evidence: [], findings: [], historicalReferences: [], metricSeriesIds: [], metadataCanUndo: false,
      relationCanUndo: mode === 'undo', relationChangeId: mode === 'undo' ? 'relation-1' : null, relationChangeAction: 'merge' } as unknown as HealthEventDetailV2;
    mount({ listHealthEvents: async () => ({ ok: true, data: [event] }), getHealthEventDetail: async () => ({ ok: true, data: detail }),
      splitHealthEvent: vi.fn(), undoHealthEventRelation: vi.fn() });
    await screen.findByRole('heading', { name: '合成健康概况' });
    fireEvent.click(screen.getByRole('tab', { name: '检查时间线' }));
    fireEvent.click(screen.getByRole('button', { name: /当前检查/ }));
    await screen.findByRole('heading', { name: '当前检查' });
    const organizer = screen.getByText('整理这次检查的报告（可选）').closest('details')!;
    expect(organizer.open).toBe(false);
    fireEvent.click(screen.getByText('整理这次检查的报告（可选）'));
    expect(screen.queryByLabelText('另一条属于同次检查的记录')).toBeNull();
    if (mode === 'split') expect(screen.getAllByRole('button', { name: '拆成单独事件' })).toHaveLength(2);
    else expect(screen.getByRole('button', { name: '撤销上次合并' })).toBeTruthy();
  });

  it.each(['range', 'unknown', 'unavailable'] as const)('最近检查复用时间线日期范围，不把第一天当成整份资料的唯一日期：%s', async (mode) => {
    const event = { ...healthEvent('range-event', '多次检查汇总', '2026-07-20', ['range-doc']), personId: 'load-person',
      time: mode === 'unknown'
        ? { value: null, endValue: null, precision: 'unknown' as const, role: 'exam' as const, source: 'unknown' as const, displayLabel: '报告日期待确认' }
        : { ...eventTime('2026-07-20'), endValue: '2026-09-15', displayLabel: '2026-07-20 至 2026-09-15' } };
    const { overview } = mount({ listHealthEvents: async () => mode === 'unavailable' ? failure : ({ ok: true, data: [event] }) });
    overview.recentChanges = [{ id: event.id, title: event.title, detail: '两次检查结果。', date: '2026-07-20', systemId: null, evidence: [] }];
    await screen.findByRole('heading', { name: '合成健康概况' });
    const recent = screen.getByRole('heading', { name: '最近检查事件' }).closest('section')!;
    const date = mode === 'range' ? '2026-07-20 至 2026-09-15' : mode === 'unknown' ? '检查日期未记录' : '2026-07-20';
    expect(within(recent).getByText(`${date} · 两次检查结果。`)).toBeTruthy();
    expect(event.time.value).toBe(mode === 'unknown' ? null : '2026-07-20');
    expect(overview.recentChanges[0]!.date).toBe('2026-07-20');
  });

  it('同一文件按每项原日期展示多次检查，未知日期和医生建议不套用事件日期', async () => {
    const event: HealthEventV2 = { ...healthEvent('multiple-dates', '多次检查汇总', '2026-07-20', ['multi-doc']), personId: 'load-person',
      time: { ...eventTime('2026-07-20'), endValue: '2026-09-15', displayLabel: '2026-07-20 至 2026-09-15' } };
    const detail: HealthEventDetailV2 = { ...event, evidence: [], metricSeriesIds: [], reports: [], metadataRevision: 1,
      historicalReferences: [], findings: [
        { id: 'july-ldl', label: 'LDL', value: '2.4 mmol/L', time: eventTime('2026-07-20'), abnormalFlag: 'normal' },
        { id: 'sept-ldl', label: 'LDL', value: '3.5 mmol/L', time: eventTime('2026-09-15'), abnormalFlag: 'high' },
        { id: 'sept-advice', label: '医生建议', value: '请结合家庭记录复诊。', time: eventTime('2026-09-15'), abnormalFlag: 'unknown' },
        { id: 'undated', label: '年龄', value: '38岁', abnormalFlag: 'unknown',
          time: { value: null, endValue: null, precision: 'unknown', role: 'unknown', source: 'unknown', displayLabel: '检查日期未记录' } }
      ] };
    mount({ listHealthEvents: async () => ({ ok: true, data: [event] }), getHealthEventDetail: async () => ({ ok: true, data: detail }) });
    await screen.findByRole('heading', { name: '合成健康概况' });
    fireEvent.click(screen.getByRole('tab', { name: '检查时间线' }));
    expect(screen.getByText('2026-07-20 至 2026-09-15')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /多次检查汇总/ }));
    const july = await screen.findByRole('region', { name: '检查结果 · 2026-07-20' });
    const september = screen.getByRole('region', { name: '检查结果 · 2026-09-15' });
    expect(within(july).getByText('2.4 mmol/L')).toBeTruthy();
    expect(within(july).queryByText('3.5 mmol/L')).toBeNull();
    expect(within(september).getByText('3.5 mmol/L')).toBeTruthy();
    expect(within(september).getByText('报告中的医生建议 · 2026-09-15')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: '检查结果 · 检查日期未记录' })).getByText('38岁')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '本报告引用的历史结果' })).toBeNull();
    expect(detail.findings.map((finding) => finding.time.value)).toEqual(['2026-07-20', '2026-09-15', '2026-09-15', null]);
  });

  it('总览读取失败仍显示成功读到的身体和时间线，重试只请求总览', async () => {
    const getMemberOverview = vi.fn<HealthDesktopBridge['getMemberOverview']>().mockResolvedValue(failure);
    const { bridge, overview } = mount({ getMemberOverview });
    await screen.findByRole('heading', { name: '暂时无法打开成员档案' });
    fireEvent.click(screen.getByRole('tab', { name: '身体与指标' }));
    expect(await screen.findByRole('heading', { name: '心血管' })).toBeTruthy();
    expect(screen.queryByText('还没有身体检查记录')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: '检查时间线' }));
    expect(screen.getByRole('button', { name: /合成检查记录/ })).toBeTruthy();
    expect(screen.queryByText('还没有检查记录')).toBeNull();
    getMemberOverview.mockResolvedValue({ ok: true, data: overview });
    fireEvent.click(screen.getByRole('tab', { name: '健康总览' }));
    fireEvent.click(screen.getByRole('button', { name: '重试健康总览' }));
    await screen.findByRole('heading', { name: '合成健康概况' });
    expect(getMemberOverview).toHaveBeenCalledTimes(2);
    expect(bridge.listBodySystems).toHaveBeenCalledTimes(1);
    expect(bridge.listHealthEvents).toHaveBeenCalledTimes(1);
  });

  it('身体详情失败结束加载并可在本系统重试，不重读其他栏目', async () => {
    const getBodySystemDetail = vi.fn<HealthDesktopBridge['getBodySystemDetail']>().mockResolvedValue(failure);
    const { bridge, detail } = mount({ getBodySystemDetail });
    await screen.findByRole('heading', { name: '合成健康概况' });
    fireEvent.click(screen.getByRole('tab', { name: '身体与指标' }));
    await screen.findByText('暂时无法打开身体检查记录');
    expect(screen.queryByText('正在打开身体检查记录')).toBeNull();
    getBodySystemDetail.mockResolvedValue({ ok: true, data: detail });
    fireEvent.click(screen.getByRole('button', { name: '重试身体检查记录' }));
    await screen.findByRole('heading', { name: '心血管' });
    expect(getBodySystemDetail).toHaveBeenCalledTimes(2);
    expect(bridge.getMemberOverview).toHaveBeenCalledTimes(1);
  });

  it('生活计划读取失败不宣称没有建议或计划，重试成功为空才显示空状态', async () => {
    const getLifestylePlan = vi.fn<HealthDesktopBridge['getLifestylePlan']>().mockRejectedValue(new Error('SYNTHETIC_READ_FAILURE'));
    const { bridge, props } = mount({ getLifestylePlan });
    await screen.findByRole('heading', { name: '合成健康概况' });
    fireEvent.click(screen.getByRole('tab', { name: '日常生活' }));
    expect(screen.getByRole('heading', { name: '暂时无法打开日常生活' })).toBeTruthy();
    expect(screen.queryByText('目前还没有适合你的行动方案')).toBeNull();
    expect(screen.queryByText('还没有主动采纳的行动。')).toBeNull();
    getLifestylePlan.mockResolvedValue({ ok: true, data: { personId: props.person.id, status: 'unavailable',
      dataQuality: 'insufficient', updatedAt: null, priorities: [], proposals: [], adoptedActions: [] } });
    fireEvent.click(screen.getByRole('button', { name: '重试日常生活' }));
    await screen.findByRole('heading', { name: '把健康建议放进每天的生活' });
    expect(getLifestylePlan).toHaveBeenCalledTimes(2);
    expect(bridge.getMemberAssessment).toHaveBeenCalledTimes(1);
  });

  it.each(['systems', 'events'] as const)('%s 读取失败不显示无资料，成功的健康概况仍保留', async (region) => {
    const read = vi.fn().mockResolvedValue(failure);
    const { summary, event } = mount(region === 'systems' ? { listBodySystems: read } : { listHealthEvents: read });
    await screen.findByRole('heading', { name: '合成健康概况' });
    fireEvent.click(screen.getByRole('tab', { name: region === 'systems' ? '身体与指标' : '检查时间线' }));
    expect(screen.getByRole('heading', { name: region === 'systems' ? '暂时无法打开身体目录' : '暂时无法打开检查时间线' })).toBeTruthy();
    expect(screen.queryByText(region === 'systems' ? '还没有身体检查记录' : '还没有检查记录')).toBeNull();
    read.mockResolvedValue({ ok: true, data: region === 'systems' ? [summary] : [event] });
    fireEvent.click(screen.getByRole('button', { name: region === 'systems' ? '重试身体目录' : '重试检查时间线' }));
    if (region === 'systems') await screen.findByRole('heading', { name: '心血管' });
    else await screen.findByRole('button', { name: /合成检查记录/ });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('局部重试的迟到旧结果不会覆盖资料版本切换后的内容', async () => {
    let resolveOld!: (value: { ok: true; data: MemberOverviewV2 }) => void;
    const getMemberOverview = vi.fn<HealthDesktopBridge['getMemberOverview']>().mockResolvedValueOnce(failure)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    const { props, view, overview } = mount({ getMemberOverview });
    await screen.findByRole('button', { name: '重试健康总览' });
    fireEvent.click(screen.getByRole('button', { name: '重试健康总览' }));
    getMemberOverview.mockResolvedValue({ ok: true, data: { ...overview, headline: '新资料的健康概况' } });
    view.rerender(<MemberProfileV2 {...props} person={{ ...props.person, dataRevision: 'new-fixture-revision' }} />);
    await screen.findByRole('heading', { name: '新资料的健康概况' });
    await act(async () => { resolveOld({ ok: true, data: { ...overview, headline: '迟到的旧资料概况' } }); });
    expect(screen.queryByText('迟到的旧资料概况')).toBeNull();
    expect(screen.getByRole('heading', { name: '新资料的健康概况' })).toBeTruthy();
  });

  it('身体正文保留不同小数值和相反解释，不因标题去重丢失', () => {
    const assessment = { systems: [{ systemId: 'cardiovascular', headline: '合成指标 5.2。', summary: '不符合参考条件。',
      claimIds: ['first', 'second', 'third'], actionIds: [], limitations: [] }], claims: [
      { id: 'first', text: '合成指标 5.2。', rationale: '', materialUncertainty: null, diagnosticStatus: null, evidenceIds: [], knowledgeSourceIds: [] },
      { id: 'second', text: '合成指标 52。', rationale: '', materialUncertainty: null, diagnosticStatus: null, evidenceIds: [], knowledgeSourceIds: [] },
      { id: 'third', text: '符合参考条件。', rationale: '', materialUncertainty: null, diagnosticStatus: null, evidenceIds: [], knowledgeSourceIds: [] }
    ], actions: [], evidenceCatalog: [], knowledgeSources: [] } as unknown as MemberAssessmentSnapshotV3;
    render(<MemberAssessmentSystemCard assessment={assessment} systemId="cardiovascular" factCount={3} onOpenEvidence={vi.fn()} />);
    expect(screen.getAllByText('合成指标 5.2。')).toHaveLength(1);
    expect(screen.getByText('合成指标 52。')).toBeTruthy();
    expect(screen.getByText('不符合参考条件。')).toBeTruthy();
    expect(screen.getByText('符合参考条件。')).toBeTruthy();
  });

  it('前后判断和其限制一起显示，不把不能判断隐藏成一个好坏标签', () => {
    const assessment = { systems: [{ systemId: 'cardiovascular', headline: '合成检查', summary: '已有记录。',
      claimIds: ['compare'], actionIds: [], limitations: [] }], claims: [
      { id: 'compare', text: '同一主题包含不同方法的记录。', rationale: '', materialUncertainty: null,
        diagnosticStatus: null, evidenceIds: [], knowledgeSourceIds: [], changeAssessment: { direction: 'uncertain',
          summary: '暂不能判断是否比以前改善。', reason: '前后方法不同，尚无可比测量。' } }
    ], actions: [], evidenceCatalog: [], knowledgeSources: [] } as unknown as MemberAssessmentSnapshotV3;
    render(<MemberAssessmentSystemCard assessment={assessment} systemId="cardiovascular" factCount={2} onOpenEvidence={vi.fn()} />);
    expect(screen.getByText('和以前相比 · 暂不能判断变化')).toBeTruthy();
    expect(screen.getByText('前后方法不同，尚无可比测量。')).toBeTruthy();
  });
});

describe('MemberProfileV2 event organization', () => {
  it('检查发现、理解依据和限制分层阅读，完整数值、左右侧、否定和时限不会被摘要替代', () => {
    const text = '左眼未散瞳结果为 0.8，右眼为 1.0；不能据此确认屈光状态。';
    const rationale = '两眼结果的检查条件相同，但未散瞳结果不能与散瞳后的结果直接比较。';
    const condition = '若出现持续不适，请在三天内就诊；没有症状时按原约定复查。';
    const assessment = { status: 'current', systems: [{ id: 'system:cardiovascular', systemId: 'cardiovascular', headline: '按原检查条件理解结果',
      summary: '', claimIds: ['source-claim'], actionIds: [], limitations: [] }],
      claims: [{ id: 'source-claim', kind: 'source_fact', title: '合成检查记录', text, rationale, materialUncertainty: condition,
        evidenceIds: [], knowledgeSourceIds: [], diagnosticStatus: null }], actions: [], evidenceCatalog: [], knowledgeSources: []
    } as unknown as MemberAssessmentSnapshotV3;
    render(<MemberAssessmentSystemCard assessment={assessment} systemId="cardiovascular" factCount={2} onOpenEvidence={vi.fn()} />);
    expect(screen.getByText('报告中的发现')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '合成检查记录' })).toBeTruthy();
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.getByText(rationale).parentElement?.textContent).toContain('如何理解');
    expect(screen.getByText(condition).parentElement?.textContent).toContain('理解时别忽略');
    expect(screen.getByText(condition).closest('details')).toBeNull();
    expect(document.body.textContent).toContain('可能的解释不等于已经确定的原因');
  });

  it('局部隔离不再把软件处理状态显示成健康判断或无检查', () => {
    const summary = { status: 'building', factCount: 8, interpretationState: 'partial' } as BodySystemSummaryV2;
    expect(systemStatusLabel(summary)).toBe('已有检查记录');
    expect(systemStatusLabel({ ...summary, status: 'attention', interpretationState: 'unavailable' })).toBe('建议关注');
    expect(systemStatusLabel({ ...summary, status: 'insufficient', interpretationState: 'complete' })).toBe('已有检查记录');
    expect(systemStatusLabel({ ...summary, factCount: 0, status: 'insufficient', interpretationState: 'complete' })).toBe('尚无相关检查');
  });

  it('身体卡片首先展示具体情况，条件只出现一次且原文入口保留', () => {
    const assessment = {
      systems: [{ id: 'system:cardiovascular', systemId: 'cardiovascular',
        headline: '合成项目有变化，尚不能单凭这一项确定原因。', summary: '合成检查条件尚不完整。',
        claimIds: ['claim-1'], actionIds: [], limitations: ['部分判断因证据不足暂未发布。'] }],
      claims: [{ id: 'claim-1', text: '合成项目有变化，尚不能单凭这一项确定原因。', rationale: '报告原文记载。',
        materialUncertainty: '合成检查条件尚不完整。', evidenceIds: ['evidence-1'], knowledgeSourceIds: [], diagnosticStatus: null }],
      actions: [], evidenceCatalog: [{ id: 'evidence-1', label: '合成来源', quote: '合成原文', locator: '第 1 页', sourceSpanId: 'span-1', documentId: 'doc-1' }],
      knowledgeSources: [], presentation: { version: 'result-summary-v1', rebuiltNodeIds: ['system:cardiovascular'] }
    } as unknown as MemberAssessmentSnapshotV3;
    const onOpenEvidence = vi.fn();
    const view = render(<MemberAssessmentSystemCard assessment={assessment} systemId="cardiovascular" factCount={8} onOpenEvidence={onOpenEvidence} />);
    expect(screen.getByRole('heading', { name: '合成项目有变化，尚不能单凭这一项确定原因。' })).toBeTruthy();
    expect(document.querySelector('.system-analysis-overview')?.textContent).toBe('合成检查条件尚不完整。');
    expect(screen.getAllByText('合成项目有变化，尚不能单凭这一项确定原因。')).toHaveLength(1);
    expect(screen.getAllByText('合成检查条件尚不完整。')).toHaveLength(1);
    expect(screen.queryByText('部分判断仍需核实')).toBeNull();
    expect(screen.queryByText(/处理说明|部分判断因证据不足暂未发布/)).toBeNull();
    expect(document.querySelector('.analysis-boundaries')).toBeNull();
    expect(document.querySelector('.system-analysis-points')).toBeNull();
    expect(screen.queryByRole('heading', { name: '相关结果与说明' })).toBeNull();
    expect(screen.getByRole('button', { name: '查看原始依据' }).closest('.analysis-explanation')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看原始依据' }));
    expect(onOpenEvidence).toHaveBeenCalledWith(expect.objectContaining({ sourceSpanId: 'span-1', documentId: 'doc-1' }));
    const empty = { ...assessment, claims: [], systems: [{ ...assessment.systems[0]!, claimIds: [] }] };
    view.rerender(<MemberAssessmentSystemCard assessment={empty} systemId="cardiovascular" factCount={8} onOpenEvidence={onOpenEvidence} />);
    expect(screen.getByRole('heading', { name: '合成项目有变化，尚不能单凭这一项确定原因。' })).toBeTruthy();
    expect(screen.queryByText('尚无相关检查')).toBeNull();
    view.rerender(<MemberAssessmentSystemCard assessment={{ ...empty, systems: [{ ...empty.systems[0]!, headline: '', summary: '' }] }} systemId="cardiovascular" factCount={8} onOpenEvidence={onOpenEvidence} />);
    expect(screen.getByRole('heading', { name: '已有相关检查记录' })).toBeTruthy();
    expect(screen.getByText('检查与报告')).toBeTruthy();
    expect(screen.queryByText('这部分身体情况')).toBeNull();
  });

  it('移到标题的判断仍保留全部原始引用和医学来源，不产生只有按钮的空白卡片', () => {
    const headline = '同一次检查的相关结果需要一起理解。';
    const assessment = {
      systems: [{ id: 'system:cardiovascular', systemId: 'cardiovascular', headline, summary: headline, claimIds: ['first'], actionIds: [], limitations: [] }],
      claims: [{ id: 'first', text: headline, rationale: headline, materialUncertainty: null, evidenceIds: ['ref-1', 'ref-2'], knowledgeSourceIds: ['medical-1'], diagnosticStatus: 'likely' }],
      actions: [], evidenceCatalog: [
        { id: 'ref-1', label: '体检报告', locator: '第1页', quote: '第一项原文。', documentId: 'report-1', sourceSpanId: 'span-1' },
        { id: 'ref-2', label: '体检报告', locator: '第2页', quote: '第二项原文。', documentId: 'report-1', sourceSpanId: 'span-2' }
      ], knowledgeSources: [{ id: 'medical-1', title: '医学资料A', url: 'https://example.com/source' }], knowledgeVerifications: []
    } as unknown as MemberAssessmentSnapshotV3;
    const open = vi.fn();
    render(<MemberAssessmentSystemCard assessment={assessment} systemId="cardiovascular" factCount={2} onOpenEvidence={open} />);
    expect(screen.getAllByText(headline)).toHaveLength(1);
    expect(screen.getByText('结合报告的参考解释')).toBeTruthy();
    expect(document.querySelector('.system-analysis-points')).toBeNull();
    expect(screen.queryByRole('heading', { name: '相关结果与说明' })).toBeNull();
    expect(screen.getByText('医学资料A').closest('a')?.href).toBe('https://example.com/source');
    const originalSources = screen.getByText('查看原始依据（2处）').closest('details')!;
    expect(originalSources.open).toBe(false);
    fireEvent.click(screen.getByText('查看原始依据（2处）'));
    const sourceButtons = screen.getAllByRole('button', { name: /查看原始依据/ });
    expect(sourceButtons).toHaveLength(2);
    for (const button of sourceButtons) fireEvent.click(button);
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ sourceSpanId: 'span-1', documentId: 'report-1', quote: '第一项原文。' }));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ sourceSpanId: 'span-2', documentId: 'report-1', quote: '第二项原文。' }));
  });

  it.each([12, 14])('%i处原始依据默认折叠，展开保留同文件和未知页码的全部真实引用', (count) => {
    const text = '已有检查结果需要结合检查条件理解。';
    const refs = Array.from({ length: count }, (_, index) => ({ id: `ref-${index}`, label: '同一体检报告', documentId: 'same-report',
      sourceSpanId: `original-span-${index}`, locator: index === 0 ? '第2页' : null, quote: `报告原文${index}，检查条件尚不完整。` }));
    const assessment = { systems: [{ id: 'system:cardiovascular', systemId: 'cardiovascular', headline: text, summary: text,
      claimIds: ['claim'], actionIds: [], limitations: [] }],
      claims: [{ id: 'claim', text, rationale: text, materialUncertainty: null, diagnosticStatus: null,
        evidenceIds: refs.map((ref) => ref.id), knowledgeSourceIds: ['medical'] }],
      evidenceCatalog: refs, actions: [], knowledgeVerifications: [], knowledgeSources: [{ id: 'medical', title: '医学资料B', url: 'https://example.com/medical' }]
    } as unknown as MemberAssessmentSnapshotV3;
    const open = vi.fn();
    render(<MemberAssessmentSystemCard assessment={assessment} systemId="cardiovascular" factCount={count} onOpenEvidence={open} />);
    const summary = screen.getByText(`查看原始依据（${count}处）`);
    const disclosure = summary.closest('details')!;
    expect(disclosure.open).toBe(false);
    expect(disclosure.contains(screen.getByText('查看医学知识来源'))).toBe(false);
    expect(screen.getByText('医学资料B').closest('a')?.href).toBe('https://example.com/medical');
    fireEvent.click(summary);
    expect(disclosure.open).toBe(true);
    const links = screen.getAllByRole('button', { name: /查看原始依据/ });
    expect(links).toHaveLength(count);
    expect(disclosure.textContent).not.toMatch(/第1页|第3页|页码待补/);
    for (const link of links) fireEvent.click(link);
    expect(open).toHaveBeenCalledTimes(count);
    for (const ref of refs) expect(open).toHaveBeenCalledWith(expect.objectContaining({
      sourceSpanId: ref.sourceSpanId, documentId: ref.documentId, quote: ref.quote, meta: ref.locator ?? '原始资料'
    }));
    expect(refs.filter((ref) => ref.locator === null)).toHaveLength(count - 1);
  });

  it('新版建议只在本人点击后加入行动，刷新后显示已加入', async () => {
    const snapshot = createDemoSnapshot() as DashboardSnapshot;
    snapshot.workspaceMode = 'personal';
    snapshot.persons = [{ ...snapshot.persons[0]!, id: 'person-1', displayName: '测试成员', relation: '本人' }];
    const overview: MemberOverviewV2 = {
      personId: 'person-1', generatedAt: now, dataQuality: 'partial', headline: '已有检查记录', overview: '已有检查记录。',
      latestClinicalDate: '2026-09-21', acceptedFactCount: 1, unclassifiedFactCount: 0, eventCount: 1,
      sourceUrgentNotices: [], currentSymptomNotices: [], attentionSystemIds: [], systems: [],
      priorityIssues: [], importantChanges: [], recentChanges: [],
      nextActions: [{ id: 'action-1', title: '复核血脂', status: '建议，尚未加入我的计划' }]
    };
    const assessment = {
      id: 'assessment-1', personId: 'person-1', systems: [], claims: [], questions: [],
      actions: [{ id: 'action-1', dedupeKey: 'lipid-followup', kind: 'test_followup', title: '复核血脂',
        why: '只有一次记录。', firstStep: '整理过去报告。', timing: '下次就诊', reviewPlan: null,
        caution: null, urgency: 'routine' }]
    } as unknown as MemberAssessmentSnapshotV3;
    let adopted = false;
    const adoptMemberAssessmentAction = vi.fn(async () => { adopted = true; return { ok: true as const, data: { id: 'adopted-1' } }; });
    window.healthDesktop = {
      getMemberOverview: async () => ({ ok: true, data: overview }),
      listBodySystems: async () => ({ ok: true, data: [] }),
      listHealthEvents: async () => ({ ok: true, data: [] }),
      getLifestylePlan: async () => ({ ok: true, data: {
        personId: 'person-1', status: 'unavailable', dataQuality: 'partial', updatedAt: now,
        priorities: [], proposals: [], adoptedActions: adopted ? [{
          id: 'adopted-1', proposalId: null, assessmentDedupeKey: 'lipid-followup', title: '复核血脂',
          userGoal: '复核血脂', selectedStartingOption: '整理过去报告。', plannedTime: '下次就诊',
          owner: '本人', progressNote: null, status: 'planned', dueDate: null, updatedAt: now
        }] : []
      } }),
      getConceptReview: async () => ({ ok: true, data: { personId: 'person-1', dictionaryVersion: 'test', catalog: [], items: [] } }),
      getMemberAssessment: async () => ({ ok: true, data: assessment }),
      adoptMemberAssessmentAction
    } as unknown as HealthDesktopBridge;
    render(<MemberProfileV2
      snapshot={snapshot} person={snapshot.persons[0]!}
      onSelectPerson={vi.fn()} onOpenEvidence={vi.fn()} onAddPerson={vi.fn()} onEditPerson={vi.fn()}
      onArchivedPeople={vi.fn()} onAddNote={vi.fn()} onExport={vi.fn()} onUploadReports={vi.fn()} onRefreshAssessment={vi.fn()}
      onExcludeDocument={vi.fn()} onReincludeDocument={vi.fn()} onDeleteDocument={vi.fn()} onDeletedDocuments={vi.fn()}
    />);
    expect(await screen.findByText('尚未加入计划')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '日常生活' }));
    expect(screen.getByRole('button', { name: '加入后续事项' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '加入后续事项' }).closest('.assessment-action-card')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '加入后续事项' }));
    await waitFor(() => expect(adoptMemberAssessmentAction).toHaveBeenCalledWith({
      personId: 'person-1', snapshotId: 'assessment-1', actionId: 'action-1'
    }));
    expect(await screen.findByText('已加入后续事项 · 已计划')).toBeTruthy();
    const adoptedCard = document.querySelector('.adopted-action-card');
    expect(adoptedCard?.querySelector('.adopted-action-card__detail')?.textContent).toBe('整理过去报告。');
    expect(adoptedCard?.querySelector('span')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: '健康总览' }));
    expect(screen.getByText('已计划')).toBeTruthy();
    expect(screen.queryByText('尚未加入计划')).toBeNull();
  });
  it('模型给出的网址在页面上不能显示成应用已核验', () => {
    expect(assessmentKnowledgeStatusLabel('model_cited')).toBe('AI 提供的医学资料');
    expect(assessmentKnowledgeStatusLabel(undefined)).toBe('AI 提供的医学资料');
    expect(assessmentKnowledgeStatusLabel('catalog_curated')).toBe('通用医学资料');
  });

  it.each([
    ['documented', '报告记录的诊断'], ['criteria_met', '符合参考条件，仍需医生确认'],
    ['likely', '结合报告的参考解释'], ['possible', '一种可能的解释，需医生确认'], ['undetermined', '目前还不能确定']
  ])('首条判断成为标题后，%s 的医学确定程度仍然可见且不是新确诊', (status, label) => {
    const text = '这项检查需要结合其他结果理解。';
    const assessment = { systems: [{ id: 'system:cardiovascular', systemId: 'cardiovascular', headline: text, summary: text,
      claimIds: ['claim-1'], actionIds: [], limitations: [] }],
      claims: [{ id: 'claim-1', text, rationale: text, materialUncertainty: '没有记录这次检查时是否用药。',
        diagnosticStatus: status, evidenceIds: [], knowledgeSourceIds: [] }],
      actions: [], evidenceCatalog: [], knowledgeSources: [], knowledgeVerifications: []
    } as unknown as MemberAssessmentSnapshotV3;
    render(<MemberAssessmentSystemCard assessment={assessment} systemId="cardiovascular" factCount={1} onOpenEvidence={vi.fn()} />);
    expect(screen.getAllByText(text)).toHaveLength(1);
    expect(screen.getAllByText(label)).toHaveLength(1);
    expect(screen.getByText(label).closest('.panel__heading')?.querySelector('h3')?.textContent).toBe(text);
    expect(screen.getByText(/没有记录这次检查时是否用药/)).toBeTruthy();
    if (status !== 'documented') expect(screen.queryByText('报告记录的诊断')).toBeNull();
  });

  it('综合说明标题已包含要点时不重复展示整段文字', () => {
    expect(systemAnalysisHeading(
      '第一条事实。第二条趋势。',
      [{ text: '第一条事实' }, { text: '第二条趋势' }]
    )).toBe('这套资料目前说明什么');
    expect(systemAnalysisHeading('需要留意的血脂记录', [{ text: 'LDL-C 在原报告中标为偏高' }])).toBe('需要留意的血脂记录');
  });

  it('辅助读模型失败时仍展示核心档案，无关快照刷新不重置页面', async () => {
    const snapshot = createDemoSnapshot() as DashboardSnapshot;
    snapshot.workspaceMode = 'personal';
    snapshot.persons = [{ ...snapshot.persons[0]!, id: 'person-1', displayName: '测试成员', relation: '本人' }];
    const overview: MemberOverviewV2 = {
      personId: 'person-1', generatedAt: now, dataQuality: 'partial', headline: '核心档案仍可读', overview: '核心档案的简要说明。',
      latestClinicalDate: '2026-09-21', acceptedFactCount: 1, unclassifiedFactCount: 1, eventCount: 1,
      sourceUrgentNotices: [{ id: 'source-urgent:test', documentId: 'document-test', sourceSpanId: 'span-test',
        clinicalDate: '2026-09-21', instructionLevel: 'critical_result', itemName: '项目甲', sourceLabel: '合成报告',
        sourceExcerpt: '项目甲 1.0，报告原文标注危急值' }],
      currentSymptomNotices: [{ id: 'current-symptom:test', noteId: 'note-test', recordedAt: now,
        sourceLabel: '本人今天补充', sourceExcerpt: '我现在持续胸痛并伴冷汗' }],
      attentionSystemIds: [], systems: [], priorityIssues: [], importantChanges: [], recentChanges: [], nextActions: []
    };
    const getMemberOverview = vi.fn(async () => ({ ok: true as const, data: overview }));
    const listBodySystems = vi.fn(async () => ({ ok: true as const, data: [] }));
    const listHealthEvents = vi.fn(async () => ({ ok: true as const, data: [] }));
    window.healthDesktop = {
      getMemberOverview,
      listBodySystems,
      listHealthEvents,
      getLifestylePlan: vi.fn(async () => { throw new Error('PLAN_TEMPORARILY_UNAVAILABLE'); }),
      getConceptReview: vi.fn(async () => { throw new Error('CONCEPT_TEMPORARILY_UNAVAILABLE'); })
    } as unknown as HealthDesktopBridge;
    const commonProps = {
      onSelectPerson: vi.fn(), onOpenEvidence: vi.fn(), onAddPerson: vi.fn(), onEditPerson: vi.fn(),
      onArchivedPeople: vi.fn(), onAddNote: vi.fn(), onExport: vi.fn(), onUploadReports: vi.fn(), onRefreshAssessment: vi.fn(),
      onExcludeDocument: vi.fn(), onReincludeDocument: vi.fn(), onDeleteDocument: vi.fn(), onDeletedDocuments: vi.fn()
    };
    const view = render(<MemberProfileV2 snapshot={snapshot} person={snapshot.persons[0]!} {...commonProps} />);
    expect(await screen.findByRole('heading', { name: '核心档案仍可读' })).toBeTruthy();
    expect(screen.getByRole('alert', { name: '报告原文的及时处理提示' })).toBeTruthy();
    expect(screen.getByRole('alert', { name: '本人今天记录的症状提示' })).toBeTruthy();
    expect(screen.queryByText('有 1 条来源事实尚未归入身体系统')).toBeNull();
    expect(screen.getByText(/请立即拨打 120/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '查看原文' }));
    expect(commonProps.onOpenEvidence).toHaveBeenCalledWith(expect.objectContaining({
      documentId: 'document-test', sourceSpanId: 'span-test'
    }));
    expect(screen.getByText('部分内容暂时无法打开')).toBeTruthy();
    expect(screen.queryByText('暂时无法打开新版成员档案')).toBeNull();

    const backgroundSnapshot = { ...snapshot, generatedAt: '2026-09-21T00:05:00.000Z' };
    view.rerender(<MemberProfileV2 snapshot={backgroundSnapshot} person={backgroundSnapshot.persons[0]!} {...commonProps} />);
    await waitFor(() => expect(getMemberOverview).toHaveBeenCalledTimes(1));
    expect(listBodySystems).toHaveBeenCalledTimes(1);
    expect(listHealthEvents).toHaveBeenCalledTimes(1);
  });

  it('用白话说明分组规则，并允许把另一事件合并到当前事件', async () => {
    const snapshot = createDemoSnapshot() as DashboardSnapshot;
    snapshot.workspaceMode = 'personal';
    snapshot.persons = [{
      ...snapshot.persons[0]!,
      id: 'person-1',
      displayName: '测试成员',
      relation: '本人'
    }];
    const current = healthEvent('event-current', '2026 年体检', '2026-09-10', ['document-a', 'document-b']);
    const other = healthEvent('event-other', '门诊检验', '2026-09-11', ['document-c']);
    const overview: MemberOverviewV2 = {
      personId: 'person-1', generatedAt: now, dataQuality: 'partial', headline: '已有检查记录', overview: '已有检查记录的简要说明。',
      latestClinicalDate: '2026-09-11', acceptedFactCount: 3, unclassifiedFactCount: 0, eventCount: 2, sourceUrgentNotices: [], currentSymptomNotices: [],
      attentionSystemIds: [], systems: [], priorityIssues: [], importantChanges: [], recentChanges: [], nextActions: []
    };
    const detail: HealthEventDetailV2 = {
      ...current,
      evidence: [], metricSeriesIds: [], findings: [
        ...Array.from({ length: 19 }, (_, index) => ({
          id: `finding-normal-${index + 1}`,
          label: `普通项目${index + 1}`,
          value: `${index + 1}`,
          time: eventTime('2026-09-10'),
          abnormalFlag: 'normal' as const
        })),
        { id: 'finding-attention', label: '报告留意项目', value: '偏高', time: eventTime('2026-09-10'), abnormalFlag: 'high' as const }
      ], historicalReferences: [{
        time: { ...eventTime('2024-09-01'), role: 'measurement' },
        sourceReportTitle: '体检总表',
        findings: [{
          id: 'historical-ldl', label: '低密度脂蛋白胆固醇', value: '3.1 mmol/L',
          evidence: {
            id: 'historical-evidence', kind: 'observation', observationId: 'historical-ldl',
            eventId: current.id, documentId: 'document-a', sourceSpanId: 'span-history', knowledgeId: null,
            label: '体检总表', locator: null, quote: '2024-09-01 LDL-C 3.1'
          }
        }]
      }], metadataRevision: 1,
      reportId: 'report-a', metadataCanUndo: false,
      reports: [
        { reportId: 'report-a', documentId: 'document-a', title: '体检总表' },
        { reportId: 'report-b', documentId: 'document-b', title: '检验明细' }
      ],
      relationChangeId: null, relationChangeAction: null, relationCanUndo: false
    };
    const mergeHealthEvents = vi.fn(async () => ({
      ok: true as const,
      data: { changeId: 'change-1', eventIds: [current.id, other.id], reportIds: ['report-c'], factRevision: 2, canUndo: true }
    }));
    window.healthDesktop = {
      getMemberOverview: async () => ({ ok: true, data: overview }),
      listBodySystems: async () => ({ ok: true, data: [] }),
      listHealthEvents: async () => ({ ok: true, data: [current, other] }),
      getLifestylePlan: async () => ({ ok: true, data: { personId: 'person-1', status: 'unavailable', dataQuality: 'insufficient', updatedAt: null, priorities: [], proposals: [], adoptedActions: [] } }),
      getConceptReview: async () => ({ ok: true, data: { personId: 'person-1', dictionaryVersion: 'test', catalog: [], items: [] } }),
      getHealthEventDetail: async () => ({ ok: true, data: detail }),
      mergeHealthEvents,
      splitHealthEvent: vi.fn()
    } as unknown as HealthDesktopBridge;

    render(<MemberProfileV2
      snapshot={snapshot}
      person={snapshot.persons[0]!}
      onSelectPerson={vi.fn()} onOpenEvidence={vi.fn()} onAddPerson={vi.fn()} onEditPerson={vi.fn()}
      onArchivedPeople={vi.fn()} onAddNote={vi.fn()} onExport={vi.fn()} onUploadReports={vi.fn()} onRefreshAssessment={vi.fn()}
      onExcludeDocument={vi.fn()} onReincludeDocument={vi.fn()} onDeleteDocument={vi.fn()} onDeletedDocuments={vi.fn()}
    />);

    fireEvent.click(await screen.findByRole('tab', { name: '检查时间线' }));
    fireEvent.click(await screen.findByRole('button', { name: /2026 年体检/ }));
    expect(await screen.findByText('整理这次检查的报告（可选）')).toBeTruthy();
    expect(screen.queryByText('这些报告是否属于同一次检查？')).toBeNull();
    fireEvent.click(screen.getByText('整理这次检查的报告（可选）'));
    expect(screen.getByText('报告留意项目')).toBeTruthy();
    expect(screen.queryByText('普通项目19')).toBeNull();
    expect(screen.getByText(/已包含全部原报告留意项/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '查看全部 20 条结果' }));
    expect(screen.getByText('普通项目19')).toBeTruthy();
    expect(screen.getByRole('button', { name: '收起完整结果' })).toBeTruthy();
    expect(screen.getByText(/只改变时间线分组，不改报告原文和检查数值/)).toBeTruthy();
    expect(screen.getByText(/不表示当时在当前机构完成检查/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '拆成单独事件' })).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: /心血管/ }));
    expect(await screen.findByText('正在从检查事件查看身体系统')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '返回这次检查' }));
    expect(await screen.findByRole('heading', { name: '2026 年体检' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('另一条属于同次检查的记录'), { target: { value: other.id } });
    fireEvent.click(screen.getByRole('button', { name: '合并到这次检查' }));
    await waitFor(() => expect(mergeHealthEvents).toHaveBeenCalledWith({
      personId: 'person-1', targetEventId: current.id, sourceEventId: other.id,
      reason: '本人确认这些报告属于同一次检查'
    }));
  });

  it('展开后说清目标、条件和两类依据，并允许暂不采纳后恢复', async () => {
    const snapshot = createDemoSnapshot() as DashboardSnapshot;
    snapshot.workspaceMode = 'personal';
    snapshot.persons = [{ ...snapshot.persons[0]!, id: 'person-1', displayName: '测试成员', relation: '本人' }];
    const overview: MemberOverviewV2 = {
      personId: 'person-1', generatedAt: now, dataQuality: 'partial', headline: '已有检查记录', overview: '已有检查记录的简要说明。',
      latestClinicalDate: '2026-09-11', acceptedFactCount: 1, unclassifiedFactCount: 0, eventCount: 1, sourceUrgentNotices: [], currentSymptomNotices: [],
      attentionSystemIds: ['cardiovascular'], systems: [], priorityIssues: [], importantChanges: [], recentChanges: [], nextActions: []
    };
    const plan: LifestylePlanV2 = {
      personId: 'person-1', status: 'current', dataQuality: 'partial', updatedAt: now,
      priorities: [],
      proposals: [{
        id: 'proposal-1', category: 'exercise', title: '从可承受的活动开始',
        goal: '建立可持续的日常活动习惯', rationale: '本人希望逐步增加活动，但尚未记录运动能力。',
        detail: '根据当天状态选择一个轻量起点。', steps: ['先记录一周可用时间', '选一次轻量活动'],
        startingOptions: ['餐后慢走10分钟'], scheduleSuggestion: '从每周1至2次开始', trackingSuggestion: '只记录是否完成和身体感受',
        constraints: ['如出现不适就停止'], uncertainties: ['当前活动能力未记录'], consultProfessional: true,
        status: 'proposed',
        evidence: [{ id: 'observation-1', kind: 'observation', observationId: 'observation-1', eventId: null, knowledgeId: null, label: '体重 91 kg', quote: '体重 91 kg', locator: '第 1 页', sourceSpanId: 'span-1', documentId: 'document-1' }],
        generalKnowledgeEvidence: [{ id: 'knowledge-1', sourceTitle: '身体活动指南', sourceOrganization: '世界卫生组织', sourceUrl: 'https://www.who.int/example', reviewedAt: '2026-09-21', supportedScope: '逐步增加日常活动', verificationStatus: 'unverified_model_candidate' }],
        sourceKind: 'ai_proposed', relatedSystemIds: ['cardiovascular']
      }],
      adoptedActions: []
    };
    const setLifestyleProposalDecision = vi.fn()
      .mockResolvedValueOnce({ ok: true, data: { proposalId: 'proposal-1', status: 'dismissed', updatedAt: now } })
      .mockResolvedValueOnce({ ok: true, data: { proposalId: 'proposal-1', status: 'proposed', updatedAt: now } });
    const adoptLifestyleProposal = vi.fn(async (input: AdoptLifestyleProposalInput) => ({ ok: true as const, data: {
      id: 'action-1', proposalId: 'proposal-1', title: '从可承受的活动开始',
      userGoal: input.userGoal, selectedStartingOption: input.selectedStartingOption,
      plannedTime: input.plannedTime, owner: input.owner, progressNote: input.progressNote,
      status: 'planned' as const, dueDate: input.dueDate, updatedAt: now
    } }));
    window.healthDesktop = {
      getMemberOverview: async () => ({ ok: true, data: overview }),
      listBodySystems: async () => ({ ok: true, data: [] }),
      listHealthEvents: async () => ({ ok: true, data: [] }),
      getLifestylePlan: async () => ({ ok: true, data: plan }),
      getConceptReview: async () => ({ ok: true, data: { personId: 'person-1', dictionaryVersion: 'test', catalog: [], items: [] } }),
      setLifestyleProposalDecision,
      adoptLifestyleProposal
    } as unknown as HealthDesktopBridge;

    render(<MemberProfileV2
      snapshot={snapshot} person={snapshot.persons[0]!}
      onSelectPerson={vi.fn()} onOpenEvidence={vi.fn()} onAddPerson={vi.fn()} onEditPerson={vi.fn()}
      onArchivedPeople={vi.fn()} onAddNote={vi.fn()} onExport={vi.fn()} onUploadReports={vi.fn()} onRefreshAssessment={vi.fn()}
      onExcludeDocument={vi.fn()} onReincludeDocument={vi.fn()} onDeleteDocument={vi.fn()} onDeletedDocuments={vi.fn()}
    />);

    fireEvent.click(await screen.findByRole('tab', { name: '日常生活' }));
    expect(await screen.findByText('建立可持续的日常活动习惯')).toBeTruthy();
    expect(screen.getByText('AI 整理建议 · 活动')).toBeTruthy();
    fireEvent.click(screen.getByText('查看怎么开始、依据与限制'));
    expect(screen.getByText('餐后慢走10分钟')).toBeTruthy();
    expect(screen.getByText('如出现不适就停止')).toBeTruthy();
    expect(screen.getByRole('link', { name: /身体活动指南/ }).getAttribute('href')).toBe('https://www.who.int/example');

    fireEvent.click(screen.getByRole('button', { name: '暂不采纳' }));
    await waitFor(() => expect(setLifestyleProposalDecision).toHaveBeenCalledWith({ personId: 'person-1', proposalId: 'proposal-1', decision: 'dismiss' }));
    fireEvent.click(await screen.findByRole('button', { name: '恢复为待决定' }));
    await waitFor(() => expect(setLifestyleProposalDecision).toHaveBeenLastCalledWith({ personId: 'person-1', proposalId: 'proposal-1', decision: 'restore' }));
    fireEvent.click(await screen.findByRole('button', { name: '采纳为我的行动' }));
    expect(screen.getByText('按自己的时间和身体情况安排。')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('计划时间'), { target: { value: '周末早上' } });
    fireEvent.change(screen.getByLabelText('起始备注（可选）'), { target: { value: '先观察膝盖感受' } });
    fireEvent.click(screen.getByRole('button', { name: '确认加入行动' }));
    await waitFor(() => expect(adoptLifestyleProposal).toHaveBeenCalledWith({
      personId: 'person-1', proposalId: 'proposal-1', userGoal: '建立可持续的日常活动习惯',
      selectedStartingOption: '餐后慢走10分钟', plannedTime: '周末早上', owner: '本人',
      progressNote: '先观察膝盖感受', dueDate: null
    }));
    expect(await screen.findByText(/先观察膝盖感受/)).toBeTruthy();
  });

  it('旧版生活建议恢复显示时说清待复核，且不提供采纳或忽略操作', async () => {
    const snapshot = createDemoSnapshot() as DashboardSnapshot;
    snapshot.workspaceMode = 'personal';
    snapshot.persons = [{ ...snapshot.persons[0]!, id: 'person-1', displayName: '测试成员', relation: '本人' }];
    const overview: MemberOverviewV2 = {
      personId: 'person-1', generatedAt: now, dataQuality: 'partial', headline: '旧记录恢复中', overview: '旧记录仍可阅读。',
      latestClinicalDate: '2026-09-11', acceptedFactCount: 1, unclassifiedFactCount: 0, eventCount: 1, sourceUrgentNotices: [], currentSymptomNotices: [],
      attentionSystemIds: [], systems: [], priorityIssues: [], importantChanges: [], recentChanges: [], nextActions: []
    };
    const plan: LifestylePlanV2 = {
      personId: 'person-1', status: 'stale', dataQuality: 'partial', updatedAt: now, priorities: [],
      proposals: [{
        id: 'legacy-proposal', category: 'diet', title: '饮食记录建议', goal: '了解平时的饮食组成',
        rationale: '尚未记录平时的饮食组成。', detail: '记录每餐组成。', steps: ['记录每餐组成。'],
        startingOptions: ['晚饭先拍照记录'], scheduleSuggestion: null, trackingSuggestion: '只记录自己实际吃了什么。',
        constraints: [], uncertainties: ['尚未按新规则复核。', '尚未记录当前饮食量。'], consultProfessional: false,
        status: 'proposed', evidence: [], generalKnowledgeEvidence: [], sourceKind: 'ai_proposed', relatedSystemIds: []
      }],
      adoptedActions: [{
        id: 'legacy-adoption', proposalId: 'legacy-proposal', assessmentDedupeKey: null,
        title: '本人已做的准备', userGoal: '整理资料', selectedStartingOption: '整理既往报告',
        plannedTime: null, owner: '本人', progressNote: '已整理', status: 'completed',
        dueDate: null, updatedAt: now
      }]
    };
    window.healthDesktop = {
      getMemberOverview: async () => ({ ok: true, data: overview }),
      listBodySystems: async () => ({ ok: true, data: [] }),
      listHealthEvents: async () => ({ ok: true, data: [] }),
      getLifestylePlan: async () => ({ ok: true, data: plan }),
      getConceptReview: async () => ({ ok: true, data: { personId: 'person-1', dictionaryVersion: 'test', catalog: [], items: [] } })
    } as unknown as HealthDesktopBridge;

    render(<MemberProfileV2
      snapshot={snapshot} person={snapshot.persons[0]!}
      onSelectPerson={vi.fn()} onOpenEvidence={vi.fn()} onAddPerson={vi.fn()} onEditPerson={vi.fn()}
      onArchivedPeople={vi.fn()} onAddNote={vi.fn()} onExport={vi.fn()} onUploadReports={vi.fn()} onRefreshAssessment={vi.fn()}
      onExcludeDocument={vi.fn()} onReincludeDocument={vi.fn()} onDeleteDocument={vi.fn()} onDeletedDocuments={vi.fn()}
    />);
    fireEvent.click(await screen.findByRole('tab', { name: '日常生活' }));
    expect(await screen.findByRole('heading', { name: '此前的生活建议' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '饮食记录建议' })).toBeTruthy();
    expect(screen.queryByText(/旧版|新规则|安全复核|行动层/)).toBeNull();
    expect(screen.getByText('进度：已完成')).toBeTruthy();
    expect((screen.getByRole('button', { name: '更新解读后可加入计划' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: '暂不采纳' })).toBeNull();
  });

  it.each(['unavailable', 'stale'] as const)('新解读不可用且没有候选建议时，%s 状态仍显示本人已有计划', async (status) => {
    const snapshot = createDemoSnapshot() as DashboardSnapshot;
    snapshot.workspaceMode = 'personal';
    snapshot.persons = [{ ...snapshot.persons[0]!, id: 'person-1', displayName: '测试成员', relation: '本人' }];
    const overview: MemberOverviewV2 = {
      personId: 'person-1', generatedAt: now, dataQuality: 'partial', headline: '现有检查记录', overview: '可以继续查看报告结果。',
      latestClinicalDate: '2026-09-11', acceptedFactCount: 1, unclassifiedFactCount: 0, eventCount: 1,
      sourceUrgentNotices: [], currentSymptomNotices: [], attentionSystemIds: [], systems: [],
      priorityIssues: [], importantChanges: [], recentChanges: [], nextActions: []
    };
    const plan: LifestylePlanV2 = {
      personId: 'person-1', status, dataQuality: 'partial', updatedAt: now, priorities: [], proposals: [],
      adoptedActions: [{ id: 'own-plan', proposalId: null, assessmentDedupeKey: 'own-plan',
        title: '本人已安排的复查', userGoal: '查看新的检查结果', selectedStartingOption: '带上既往报告前往门诊',
        plannedTime: '下周二', owner: '本人', progressNote: '预约已确认', status: 'planned', dueDate: null, updatedAt: now }]
    };
    window.healthDesktop = {
      getMemberOverview: async () => ({ ok: true, data: overview }),
      getMemberAssessment: async () => ({ ok: true, data: null }),
      listBodySystems: async () => ({ ok: true, data: [] }), listHealthEvents: async () => ({ ok: true, data: [] }),
      getLifestylePlan: async () => ({ ok: true, data: plan }),
      getConceptReview: async () => ({ ok: true, data: { personId: 'person-1', dictionaryVersion: 'test', catalog: [], items: [] } })
    } as unknown as HealthDesktopBridge;
    render(<MemberProfileV2 snapshot={snapshot} person={snapshot.persons[0]!}
      onSelectPerson={vi.fn()} onOpenEvidence={vi.fn()} onAddPerson={vi.fn()} onEditPerson={vi.fn()}
      onArchivedPeople={vi.fn()} onAddNote={vi.fn()} onExport={vi.fn()} onUploadReports={vi.fn()} onRefreshAssessment={vi.fn()}
      onExcludeDocument={vi.fn()} onReincludeDocument={vi.fn()} onDeleteDocument={vi.fn()} onDeletedDocuments={vi.fn()} />);
    fireEvent.click(await screen.findByRole('tab', { name: '日常生活' }));
    expect(await screen.findByRole('heading', { name: '暂时没有新的行动建议' })).toBeTruthy();
    expect(screen.getByText('本人已安排的复查')).toBeTruthy();
    expect(screen.getByText('带上既往报告前往门诊')).toBeTruthy();
    expect(screen.getByText('进度：已计划')).toBeTruthy();
    expect(screen.getByText('负责人：本人')).toBeTruthy();
    expect(screen.getByText('我的安排：下周二')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '加入后续事项' })).toBeNull();
    expect(screen.queryByRole('button', { name: '采纳为我的行动' })).toBeNull();
  });
});
