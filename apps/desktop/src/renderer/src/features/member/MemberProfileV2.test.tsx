// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdoptLifestyleProposalInput, DashboardSnapshot, HealthEventDetailV2, HealthEventV2, LifestylePlanV2, MemberOverviewV2 } from '@contracts';
import type { HealthDesktopBridge } from '../../../../preload/index.js';
import { createDemoSnapshot } from '../../../../../../../packages/test-fixtures/src/index.js';
import { MemberProfileV2, systemAnalysisHeading } from './MemberProfileV2.js';

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
  it('综合说明标题已包含要点时不重复展示整段文字', () => {
    expect(systemAnalysisHeading(
      '第一条事实。第二条趋势。',
      [{ text: '第一条事实' }, { text: '第二条趋势' }]
    )).toBe('这套资料目前说明什么');
    expect(systemAnalysisHeading('需要留意的血脂记录', [{ text: 'LDL-C 在原报告中标为偏高' }])).toBe('需要留意的血脂记录');
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
      personId: 'person-1', generatedAt: now, dataQuality: 'partial', headline: '已有检查记录',
      latestClinicalDate: '2026-09-11', acceptedFactCount: 3, eventCount: 2,
      attentionSystemIds: [], systems: [], recentChanges: [], nextActions: []
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
      personId: 'person-1', generatedAt: now, dataQuality: 'partial', headline: '已有检查记录',
      latestClinicalDate: '2026-09-11', acceptedFactCount: 1, eventCount: 1,
      attentionSystemIds: ['cardiovascular'], systems: [], recentChanges: [], nextActions: []
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
        generalKnowledgeEvidence: [{ id: 'knowledge-1', sourceTitle: '身体活动指南', sourceOrganization: '世界卫生组织', sourceUrl: 'https://www.who.int/example', reviewedAt: '2026-09-21', supportedScope: '逐步增加日常活动' }],
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
});
