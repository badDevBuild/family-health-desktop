// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdoptLifestyleProposalInput, DashboardSnapshot, HealthEventDetailV2, HealthEventV2, LifestylePlanV2, MemberAssessmentSnapshotV3, MemberOverviewV2 } from '@contracts';
import type { HealthDesktopBridge } from '../../../../preload/index.js';
import { createDemoSnapshot } from '../../../../../../../packages/test-fixtures/src/index.js';
import { assessmentKnowledgeStatusLabel, MemberProfileV2, systemAnalysisHeading } from './MemberProfileV2.js';

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

describe('MemberProfileV2 event organization', () => {
  it('新版建议只在本人点击后加入行动，刷新后显示已加入', async () => {
    const snapshot = createDemoSnapshot() as DashboardSnapshot;
    snapshot.workspaceMode = 'personal';
    snapshot.persons = [{ ...snapshot.persons[0]!, id: 'person-1', displayName: '测试成员', relation: '本人' }];
    const overview: MemberOverviewV2 = {
      personId: 'person-1', generatedAt: now, dataQuality: 'partial', headline: '已有检查记录', overview: '已有检查记录。',
      latestClinicalDate: '2026-09-21', acceptedFactCount: 1, unclassifiedFactCount: 0, eventCount: 1,
      sourceUrgentNotices: [], currentSymptomNotices: [], attentionSystemIds: [], systems: [],
      priorityIssues: [], importantChanges: [], recentChanges: [], nextActions: []
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
      onArchivedPeople={vi.fn()} onAddNote={vi.fn()} onExport={vi.fn()} onImport={vi.fn()}
      onExcludeDocument={vi.fn()} onReincludeDocument={vi.fn()} onDeleteDocument={vi.fn()} onDeletedDocuments={vi.fn()}
    />);
    fireEvent.click(await screen.findByRole('tab', { name: '生活与行动' }));
    expect(screen.getByRole('button', { name: '加入后续事项' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '加入后续事项' }).closest('.assessment-action-card')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '加入后续事项' }));
    await waitFor(() => expect(adoptMemberAssessmentAction).toHaveBeenCalledWith({
      personId: 'person-1', snapshotId: 'assessment-1', actionId: 'action-1'
    }));
    expect(await screen.findByText('已加入后续事项')).toBeTruthy();
  });
  it('模型给出的网址在页面上不能显示成应用已核验', () => {
    expect(assessmentKnowledgeStatusLabel('model_cited')).toBe('AI 提供的网址；应用尚未核对正文');
    expect(assessmentKnowledgeStatusLabel(undefined)).toBe('AI 提供的网址；应用尚未核对正文');
    expect(assessmentKnowledgeStatusLabel('catalog_curated')).toBe('应用收录的知识条目');
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
      onArchivedPeople: vi.fn(), onAddNote: vi.fn(), onExport: vi.fn(), onImport: vi.fn(),
      onExcludeDocument: vi.fn(), onReincludeDocument: vi.fn(), onDeleteDocument: vi.fn(), onDeletedDocuments: vi.fn()
    };
    const view = render(<MemberProfileV2 snapshot={snapshot} person={snapshot.persons[0]!} {...commonProps} />);
    expect(await screen.findByRole('heading', { name: '核心档案仍可读' })).toBeTruthy();
    expect(screen.getByRole('alert', { name: '报告原文的及时处理提示' })).toBeTruthy();
    expect(screen.getByRole('alert', { name: '本人今天记录的症状提示' })).toBeTruthy();
    expect(screen.getByText('有 1 条来源事实尚未归入身体系统')).toBeTruthy();
    expect(screen.getByText(/请立即拨打 120/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '查看原文' }));
    expect(commonProps.onOpenEvidence).toHaveBeenCalledWith(expect.objectContaining({
      documentId: 'document-test', sourceSpanId: 'span-test'
    }));
    expect(screen.getByText('部分辅助内容暂时未读取')).toBeTruthy();
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
          abnormalFlag: 'normal' as const
        })),
        { id: 'finding-attention', label: '报告留意项目', value: '偏高', abnormalFlag: 'high' as const }
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
      mergeHealthEvents
    } as unknown as HealthDesktopBridge;

    render(<MemberProfileV2
      snapshot={snapshot}
      person={snapshot.persons[0]!}
      onSelectPerson={vi.fn()} onOpenEvidence={vi.fn()} onAddPerson={vi.fn()} onEditPerson={vi.fn()}
      onArchivedPeople={vi.fn()} onAddNote={vi.fn()} onExport={vi.fn()} onImport={vi.fn()}
      onExcludeDocument={vi.fn()} onReincludeDocument={vi.fn()} onDeleteDocument={vi.fn()} onDeletedDocuments={vi.fn()}
    />);

    fireEvent.click(await screen.findByRole('tab', { name: '检查时间线' }));
    fireEvent.click(await screen.findByRole('button', { name: /2026 年体检/ }));
    expect(await screen.findByText('这些报告是否属于同一次检查？')).toBeTruthy();
    expect(screen.getByText('报告留意项目')).toBeTruthy();
    expect(screen.queryByText('普通项目19')).toBeNull();
    expect(screen.getByText(/已包含全部原报告留意项/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '查看全部 20 条结果' }));
    expect(screen.getByText('普通项目19')).toBeTruthy();
    expect(screen.getByRole('button', { name: '收起完整结果' })).toBeTruthy();
    expect(screen.getByText(/只改变时间线分组，不改报告原文和检查数值/)).toBeTruthy();
    expect(screen.getByText(/不表示当时在当前机构完成检查/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '拆成单独事件' })).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: /cardiovascular/ }));
    expect(await screen.findByText('正在从检查事件查看身体系统')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '返回这次检查' }));
    expect(await screen.findByRole('heading', { name: '2026 年体检' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('还属于哪个事件？'), { target: { value: other.id } });
    fireEvent.click(screen.getByRole('button', { name: '合并到当前事件' }));
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
      onArchivedPeople={vi.fn()} onAddNote={vi.fn()} onExport={vi.fn()} onImport={vi.fn()}
      onExcludeDocument={vi.fn()} onReincludeDocument={vi.fn()} onDeleteDocument={vi.fn()} onDeletedDocuments={vi.fn()}
    />);

    fireEvent.click(await screen.findByRole('tab', { name: '生活与行动' }));
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
    expect(screen.getByText('这些是你的计划字段，以后 AI 更新建议也不会覆盖。')).toBeTruthy();
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
        id: 'legacy-proposal', category: 'diet', title: '旧版饮食建议', goal: '旧版饮食建议',
        rationale: '这是升级前已保存的内容。', detail: '保留原内容供阅读。', steps: ['保留原内容供阅读。'],
        startingOptions: ['等待新版复核'], scheduleSuggestion: null, trackingSuggestion: '暂不创建跟进行动。',
        constraints: ['不能直接采纳。'], uncertainties: ['尚未按新规则复核。'], consultProfessional: false,
        status: 'proposed', evidence: [], generalKnowledgeEvidence: [], sourceKind: 'ai_proposed', relatedSystemIds: []
      }],
      adoptedActions: []
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
      onArchivedPeople={vi.fn()} onAddNote={vi.fn()} onExport={vi.fn()} onImport={vi.fn()}
      onExcludeDocument={vi.fn()} onReincludeDocument={vi.fn()} onDeleteDocument={vi.fn()} onDeletedDocuments={vi.fn()}
    />);
    fireEvent.click(await screen.findByRole('tab', { name: '生活与行动' }));
    expect(await screen.findByText('旧版建议已恢复展示')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '旧版饮食建议' })).toBeTruthy();
    expect((screen.getByRole('button', { name: '等待重新核对' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: '暂不采纳' })).toBeNull();
  });
});
