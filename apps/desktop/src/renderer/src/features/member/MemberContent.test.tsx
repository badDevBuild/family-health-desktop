// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BodySystemDetailV2, BodySystemSummaryV2, HealthEventV2, MemberAssessmentSnapshotV3, MemberOverviewV2 } from '@contracts';
import { bodySystemRegistry } from '@core';
import { createDemoSnapshot } from '../../../../../../../packages/test-fixtures/src/index.js';
import type { HealthDesktopBridge } from '../../../../preload/index.js';
import { MemberProfileV2 } from './MemberProfileV2.js';

afterEach(() => { cleanup(); delete window.healthDesktop; });

function mount({ empty = false, fail = false, legacy = false, staleAssessment = false, sourceProof = true, duplicatePriorityAction = false, timelineSources = false } = {}) {
  const snapshot = createDemoSnapshot();
  snapshot.workspaceMode = 'personal';
  const person = { ...snapshot.persons[0]!, id: 'content-person', displayName: '测试成员', acceptedFactCount: empty ? 0 : 3, derivedStatus: 'current' as const };
  snapshot.persons = [person];
  snapshot.inbox = empty ? [] : ['ignored', 'blocked', 'needs_review', 'processing', 'stabilizing', 'discovered'].map((status, index) => ({
    ...snapshot.inbox[0]!, id: `doc-${index}`, personId: person.id, displayName: `报告${index}`, status: status as typeof snapshot.inbox[number]['status']
  }));
  if (timelineSources) snapshot.inbox[0]!.displayName = '2024体检.pdf';
  const system = { id: 'cardiovascular', name: '心血管系统', shortName: '心血管', status: 'attention', factCount: 3,
    summary: '这次复查仍有需要留意的记录。', interpretationState: 'partial' } as BodySystemSummaryV2;
  const time = { value: '2024-05-01', endValue: null, precision: 'day', role: 'exam', source: 'explicit', displayLabel: '2024-05-01' } as const;
  const event: HealthEventV2 = { id: 'event-1', personId: person.id, type: 'checkup', title: '体检报告', time,
    summary: timelineSources ? '报告中另有历史对比结果，已与本次检查分开。' : '记录了当时的检查和医生建议。', systemIds: ['cardiovascular'], documentIds: ['doc-0'], factCount: 3, metadataStatus: 'unknown' };
  const evidence = { id: 'evidence-1', kind: 'clinical_finding' as const, observationId: null, eventId: event.id,
    documentId: 'doc-0', sourceSpanId: 'span-1', knowledgeId: null, label: '体检报告', locator: '第1页', quote: sourceProof ? '医生建议：三个月后复查。' : '检查结果已记录。' };
  const action = { id: 'action-1', dedupeKey: 'reported-plan', kind: 'documented_plan', title: '三个月后复查',
    why: '这是当时报告记载的安排。', firstStep: '按原报告安排复查。', timing: '三个月后', timingBasis: 'documented', reviewPlan: null,
    caution: null, urgency: 'routine', evidenceIds: ['evidence-1'], knowledgeSourceIds: [] };
  const assessment = {
    id: 'assessment-1', status: staleAssessment ? 'stale' : 'current', systems: [{ id: 'system:cardiovascular', systemId: system.id,
      headline: system.summary, summary: system.summary, claimIds: ['claim-1'], actionIds: ['action-1'], limitations: ['部分判断因证据不足暂未发布。', '未散瞳，不能据此确认屈光状态。'] }],
    claims: [{ id: 'claim-1', text: system.summary, rationale: '尚未提供这次检查时的用药记录。', materialUncertainty: '尚未提供这次检查时的用药记录。',
      evidenceIds: ['evidence-1'], knowledgeSourceIds: [], diagnosticStatus: null }], actions: [action], evidenceCatalog: [evidence],
    knowledgeSources: [], knowledgeVerifications: [], questions: [], presentation: { version: 'test', rebuiltNodeIds: ['system:cardiovascular'] }
  } as unknown as MemberAssessmentSnapshotV3;
  const detail = { personId: person.id, registry: bodySystemRegistry[0]!, summary: system, metrics: [],
    findings: [{ id: 'advice-1', title: '复查建议', value: '三个月后复查。', time, abnormalFlag: 'unknown', evidence: [evidence] }],
    relatedEventIds: [event.id], unmappedFactCount: 40, analysis: legacy ? {
      status: 'stale', review: { status: 'passed' }, scope: { clinicalAsOf: '2024-05-01' }, headline: '原报告记载了复查安排。',
      overview: '已接纳的事实进入新流程。原报告记载了复查安排。',
      keyPoints: [{ id: 'old-claim', text: '原报告记载了复查安排。', evidence: [evidence], limitations: ['独立复核未完成。', '检测条件不同，暂不能直接比较。'] }],
      conflicts: [], recommendations: [], discussionPoints: [{ text: '请与原就诊医生确认复查时间。', evidence: [evidence], source: 'clinician_reported' }],
      dataGaps: [{ text: '模型证据匹配未完成。', consequence: '尚未发布。' }], clinicallyImportantUnknowns: ['没有记录最近一次复查时间。']
    } : null } as unknown as BodySystemDetailV2;
  const overview: MemberOverviewV2 = { personId: person.id, generatedAt: '2026-09-21T00:00:00Z', dataQuality: 'partial',
    headline: empty ? '还没有健康资料' : '这次复查仍有需要留意的记录。', overview: empty ? '添加报告后可查看身体情况。' : '请结合原报告和检查条件理解。',
    latestClinicalDate: empty ? null : time.value, acceptedFactCount: person.acceptedFactCount, unclassifiedFactCount: 40,
    eventCount: empty ? 0 : 1, sourceUrgentNotices: [], currentSymptomNotices: [], attentionSystemIds: empty ? [] : ['cardiovascular'],
    systems: empty ? [] : [system], priorityIssues: duplicatePriorityAction ? [
      { id: 'first-issue', systemId: 'cardiovascular', title: '第一项需要留意', explanation: '第一项检查仍有疑问。', nextStep: '联系医生确认复查时间。' },
      { id: 'second-issue', systemId: 'cardiovascular', title: '第二项需要留意', explanation: '第二项检查也需要结合当前情况理解。', nextStep: '联系医生确认复查时间。', isHighPriority: true }
    ] : [], importantChanges: [], recentChanges: timelineSources ? [{
      id: event.id, title: event.title, detail: event.summary, date: time.value, systemId: 'cardiovascular', evidence: []
    }] : [],
    nextActions: empty ? [] : [{ id: 'next-action', title: '整理复查资料', status: 'planned' }] };
  window.healthDesktop = {
    getMemberOverview: async () => fail ? { ok: false, error: { code: 'TEMPORARY' } } : { ok: true, data: overview },
    listBodySystems: async () => ({ ok: true, data: empty ? [] : [system] }),
    listHealthEvents: async () => ({ ok: true, data: empty ? [] : [event] }),
    getLifestylePlan: async () => ({ ok: true, data: staleAssessment ? { status: 'current', proposals: [], adoptedActions: [
      { id: 'my-plan', title: '我自己的计划', userGoal: '我自己的计划', selectedStartingOption: '按自己已确定的时间继续。', status: 'in_progress', owner: '本人' }
    ] } : null }), getConceptReview: async () => ({ ok: true, data: null }),
    getMemberAssessment: async () => ({ ok: true, data: empty || legacy ? null : assessment }),
    getBodySystemDetail: async () => ({ ok: true, data: detail }), adoptMemberAssessmentAction: vi.fn(),
    getHealthEventDetail: async () => {
      const sources = Array.from({ length: 71 }, (_, index) => ({ ...evidence, id: `entry-${index}`, observationId: `result-${index}`,
        sourceSpanId: `span-${index}`, locator: index < 35 ? '第1页' : '第2页', quote: `原结果${index}` }));
      return { ok: true, data: { ...event, evidence: sources, metricSeriesIds: [], historicalReferences: [], reportId: null,
        reports: [{ reportId: 'report', documentId: 'doc-0', title: '2024体检.pdf' }],
        findings: sources.map((source, index) => ({ id: source.observationId!, label: `指标${index}`, value: String(index), abnormalFlag: 'normal' }))
      } };
    }
  } as unknown as HealthDesktopBridge;
  const open = vi.fn();
  render(<main className="content-area"><MemberProfileV2 snapshot={snapshot} person={person}
    onSelectPerson={vi.fn()} onOpenEvidence={open} onAddPerson={vi.fn()} onEditPerson={vi.fn()} onArchivedPeople={vi.fn()}
    onAddNote={vi.fn()} onExport={vi.fn()} onUploadReports={vi.fn()} onRefreshAssessment={vi.fn()} onExcludeDocument={vi.fn()}
    onReincludeDocument={vi.fn()} onDeleteDocument={vi.fn()} onDeletedDocuments={vi.fn()} /></main>);
  return { open };
}

describe('家庭成员内容', () => {
  it('跨主题的相同下一步各自保留，不因行动相同省略另一个健康关注点的安排', async () => {
    mount({ duplicatePriorityAction: true });
    await screen.findByRole('heading', { name: '这次复查仍有需要留意的记录。' });
    expect(screen.getAllByText('先做：联系医生确认复查时间。')).toHaveLength(2);
    expect(screen.getByText('第一项需要留意')).toBeTruthy();
    expect(screen.getByText('第二项需要留意')).toBeTruthy();
    expect(screen.getByText('第二项检查也需要结合当前情况理解。')).toBeTruthy();
  });

  it('高优先级主题始终显示自己的下一步，不被前面共用行动的普通主题省略', async () => {
    mount({ duplicatePriorityAction: true });
    await screen.findByRole('heading', { name: '这次复查仍有需要留意的记录。' });
    const importantCard = screen.getByRole('article', { name: '第二项需要留意' });
    expect(importantCard.closest('details')).toBeNull();
    expect(within(importantCard).getByText('先做：联系医生确认复查时间。')).toBeTruthy();
    const ordinaryCard = screen.getByRole('article', { name: '第一项需要留意' });
    expect(within(ordinaryCard).getByText('先做：联系医生确认复查时间。')).toBeTruthy();
  });

  it('检查结果各自可打开原文，附件按真实文件与页归并且不显示无含义序号', async () => {
    const { open } = mount({ timelineSources: true });
    await screen.findByRole('heading', { name: '这次复查仍有需要留意的记录。' });
    expect(screen.getByText('2024-05-01 · 原报告还含历史对比结果。')).toBeTruthy();
    expect(document.body.textContent).not.toContain('已与本次检查分开');
    const sectionStart = document.querySelector('.member-tab-section')!;
    expect(sectionStart).toBeTruthy();
    expect(sectionStart).not.toBe(screen.getByRole('tablist'));
    const contentArea = screen.getByRole('main');
    contentArea.scrollTop = 800;
    const sectionBounds = vi.fn(() => {
      // 新栏目已渲染；只改变内容区位置，不让浏览器滚动顶部栏等祖先。
      expect(sectionStart.querySelector('.timeline-panel')).toBeTruthy();
      expect(sectionStart.querySelector('.member-v2-overview')).toBeNull();
      return { top: -480 };
    });
    const scrollToSection = vi.fn();
    const scrollStickyTabs = vi.fn();
    Object.defineProperty(sectionStart, 'getBoundingClientRect', { value: sectionBounds });
    Object.defineProperty(contentArea, 'getBoundingClientRect', { value: () => ({ top: 120 }) });
    Object.defineProperty(sectionStart, 'scrollIntoView', { value: scrollToSection });
    Object.defineProperty(screen.getByRole('tablist'), 'scrollIntoView', { value: scrollStickyTabs });
    fireEvent.click(screen.getByRole('tab', { name: '检查时间线' }));
    expect(contentArea.scrollTop).toBe(200);
    expect(scrollToSection).not.toHaveBeenCalled();
    expect(scrollStickyTabs).not.toHaveBeenCalled();
    contentArea.scrollTop = 333;
    fireEvent.click(screen.getByRole('tab', { name: '检查时间线' }));
    expect(contentArea.scrollTop).toBe(333);
    expect(sectionBounds).toHaveBeenCalledTimes(1);
    expect(screen.getByText('原报告还含历史对比结果。')).toBeTruthy();
    expect(document.body.textContent).not.toContain('已与本次检查分开');
    fireEvent.click(screen.getByRole('button', { name: /体检报告/ }));
    await screen.findByRole('heading', { name: '体检报告' });
    const footer = document.querySelector('.event-detail > .evidence-source-list')!;
    expect(footer.querySelectorAll('button')).toHaveLength(2);
    expect(footer.textContent).toContain('2024体检.pdf · 第1页');
    expect(footer.textContent).toContain('2024体检.pdf · 第2页');
    expect(footer.textContent).not.toMatch(/依据 \d+/);
    fireEvent.click(screen.getByRole('button', { name: '查看指标0原文 · 第1页' }));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ sourceSpanId: 'span-0', documentId: 'doc-0', quote: '原结果0' }));
    fireEvent.click(screen.getByRole('button', { name: '查看全部 71 条结果' }));
    expect(screen.getAllByRole('button', { name: /查看指标\d+原文/ })).toHaveLength(71);
    expect(footer.querySelectorAll('button')).toHaveLength(2);
    expect(document.body.textContent).not.toContain('已与本次检查分开');
  });
  it('所有页签没有工程说明，医生旧计划标出来源日期，状态使用中文', async () => {
    mount();
    await screen.findByRole('heading', { name: '这次复查仍有需要留意的记录。' });
    expect(screen.getByText('已计划')).toBeTruthy();
    for (const name of ['健康总览', '身体与指标', '日常生活', '检查时间线', '原始资料']) {
      fireEvent.click(screen.getByRole('tab', { name }));
      if (name === '身体与指标') await screen.findByRole('heading', { name: '这次复查仍有需要留意的记录。' });
      expect(document.body.textContent).not.toMatch(/按新流程|调用模型|完整换行|词典|映射|已接纳|尚未发布|处理说明|不计算健康总分/);
    }
    expect(document.body.textContent).not.toMatch(/ignored|blocked|needs_review|processing|stabilizing|discovered/);
    expect(screen.getByText('已忽略')).toBeTruthy();
    expect(screen.getByText('暂时无法读取')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '日常生活' }));
    expect(screen.getByText(/报告中的医生建议/)).toBeTruthy();
    expect(screen.getByText(/2024-05-01.*体检报告/)).toBeTruthy();
    expect(screen.queryByText(/第 1 项 · 日常行动/)).toBeNull();
  });

  it('旧系统解读只呈现健康信息，仍保留临床限制和报告中的医生建议', async () => {
    mount({ legacy: true });
    await screen.findByRole('heading', { name: '这次复查仍有需要留意的记录。' });
    fireEvent.click(screen.getByRole('tab', { name: '身体与指标' }));
    await screen.findByRole('heading', { name: '原报告记载了复查安排。' });
    expect(document.body.textContent).not.toMatch(/已接纳|新流程|独立复核|证据匹配|尚未发布|成员级规则/);
    expect(screen.getByText('检测条件不同，暂不能直接比较。')).toBeTruthy();
    expect(screen.getByText('没有记录最近一次复查时间。')).toBeTruthy();
    expect(screen.getAllByText(/报告中的医生建议/).length).toBeGreaterThan(0);
    expect(document.body.textContent).toContain('2024-05-01');
    for (const name of ['健康总览', '身体与指标', '日常生活', '检查时间线', '原始资料']) {
      fireEvent.click(screen.getByRole('tab', { name }));
      expect(document.body.textContent).not.toMatch(/已接纳|新流程|独立复核|证据匹配|尚未发布|成员级规则|核验|词典/);
    }
  });

  it('此前资料的解读继续可读，但不能新增采纳；本人已有计划保持可见', async () => {
    mount({ staleAssessment: true });
    await screen.findByRole('heading', { name: '这次复查仍有需要留意的记录。' });
    fireEvent.click(screen.getByRole('tab', { name: '身体与指标' }));
    await screen.findByRole('heading', { name: '这次复查仍有需要留意的记录。' });
    expect(screen.getByText('这份解读仍可回看；更新后可将新的建议加入计划。')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '日常生活' }));
    const button = screen.getByRole('button', { name: '更新解读后可加入计划' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(window.healthDesktop!.adoptMemberAssessmentAction).not.toHaveBeenCalled();
    expect(screen.getByText('我自己的计划')).toBeTruthy();
    expect(screen.getByText('进度：进行中')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/版本|复核|pipeline|模型/);
  });

  it('缺少对应原文的行动不会仅凭类型就说成报告中的医生建议', async () => {
    mount({ sourceProof: false });
    await screen.findByRole('heading', { name: '这次复查仍有需要留意的记录。' });
    fireEvent.click(screen.getByRole('tab', { name: '日常生活' }));
    expect(screen.getByText('行动建议')).toBeTruthy();
    expect(screen.getByText('安排前请结合当前情况与医生确认。')).toBeTruthy();
    expect(screen.queryByText(/报告中的医生建议|报告中的安排/)).toBeNull();
  });

  it.each([
    ['健康总览', '还没有健康资料'], ['身体与指标', '还没有身体检查记录'], ['检查时间线', '还没有检查记录'],
    ['日常生活', '把健康建议放进每天的生活'], ['原始资料', '还没有原始资料']
  ])('没有资料时 %s 显示真实空状态', async (tab, text) => {
    mount({ empty: true });
    await screen.findByRole('heading', { name: '还没有健康资料' });
    fireEvent.click(screen.getByRole('tab', { name: tab }));
    expect(await screen.findByText(text)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/新流程|核验|词典|安全复核|通用模板|调用模型/);
  });

  it('读取失败说明恢复操作，不讲版本或模型任务', async () => {
    mount({ fail: true });
    expect(await screen.findByRole('heading', { name: '暂时无法打开成员档案' })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/新版|调用模型|发起新的模型任务/);
    expect(screen.getByText(/重新打开/)).toBeTruthy();
  });
});
