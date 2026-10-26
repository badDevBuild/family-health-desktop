// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BodySystemSummaryV2, DashboardSnapshot, MemberAssessmentSnapshotV3, MemberOverviewV2, ReviewIssue } from '@contracts';
import type { HealthDesktopBridge } from '../../preload/index.js';
import { createDemoSnapshot } from '../../../../../packages/test-fixtures/src/index.js';
import App from './App.js';

function createPersonalSnapshot(): DashboardSnapshot {
  const demo = createDemoSnapshot();
  return {
    ...demo,
    workspaceMode: 'personal',
    workspaceName: '我的家庭健康档案',
    persons: [{
      ...demo.persons[0]!,
      id: 'personal-person-1',
      displayName: '测试成员',
      documentCount: 0,
      acceptedFactCount: 0,
      attentionCount: 0,
      freshnessLabel: '尚未导入资料'
    }],
    organs: [],
    trends: [],
    timeline: [],
    guidance: [],
    inbox: [],
    jobs: [],
    reviews: [],
    actions: [],
    notes: [],
    pendingInboxCount: 0,
    openReviewCount: 0
  };
}

function installBridge(snapshot: DashboardSnapshot, overrides: Partial<HealthDesktopBridge> = {}): HealthDesktopBridge {
  const noopSubscription = () => () => undefined;
  const bridge = {
    getSnapshot: async () => snapshot,
    getBootstrap: async () => ({
      platform: 'darwin',
      versions: { app: '0.1.0', electron: '38', chrome: '140', node: '22' },
      desktopBehavior: { stayInTray: null, openAtLogin: false, notificationsEnabled: true },
      displayPreferences: { fontScale: 'standard' as const, reduceMotion: false, dateStyle: 'friendly' as const },
      aiPreferences: { modelId: 'gpt-5.6-sol', reasoningEffort: 'medium' as const },
      recoveryStatus: { pointCount: 0, totalBytes: 0, latestAt: null }
    }),
    onSnapshotChanged: noopSubscription,
    onTrayProcessRequested: noopSubscription,
    onAccountStateChanged: noopSubscription,
    rebuildProcessing: vi.fn(async () => ({ ok: false as const, error: { code: 'UNAVAILABLE', messageKey: 'test', retryable: false, correlationId: 'test' } })),
    ...overrides
  } as unknown as HealthDesktopBridge;
  window.healthDesktop = bridge;
  return bridge;
}

afterEach(() => {
  cleanup();
  delete window.healthDesktop;
});

describe('无开放事项的历史日期维护', () => {
  it('只在可选维护列出日期线索，确认后仅发送选择的报告', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.account = { ...snapshot.account, status: 'connected', displayLabel: 'synthetic-date@example.test' };
    snapshot.inbox = ['first', 'second'].map(id => ({ id, displayName: `合成日期${id}.pdf`,
      discoveredAt: '2026-01-01T00:00:00Z', personId: 'personal-person-1', personLabel: '测试成员',
      status: 'completed' as const, format: 'PDF', sourceLabel: '手动导入', sentToAi: true,
      aiTransmissionStatus: 'completed' as const, inProcessingCenter: true, issue: null,
      acceptedFactCount: 3, dateBindingReviewCount: 2 }));
    const processNow = vi.fn<HealthDesktopBridge['processNow']>().mockResolvedValue({ ok: true, data: { batchId: 'synthetic-date-batch' } });
    installBridge(snapshot, { processNow }); render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '处理中心' }));
    expect(snapshot.reviews).toHaveLength(0);
    expect(processNow).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('可选维护：重新核对报告'));
    await screen.findByRole('group', { name: '选择可选维护报告' });
    fireEvent.click(screen.getByRole('checkbox', { name: '选择维护报告：合成日期first.pdf' }));
    fireEvent.click(screen.getByRole('button', { name: '重新核对所选报告（1）' }));
    const dialog = screen.getByRole('dialog', { name: '确认发送范围' });
    expect(within(dialog).getByText(/有待核实内容或日期对应/)).toBeTruthy();
    expect(within(dialog).queryByText('合成日期second.pdf')).toBeNull();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '我确认本次接收方、用途和资料范围' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '授权并开始' }));
    await waitFor(() => expect(processNow).toHaveBeenCalledExactlyOnceWith({ documentIds: ['first'],
      consentVersion: 1, confirmedDataRecipient: 'OpenAI/Codex' }));
  });
});

describe('指定成员综合的可选维护入口', () => {
  function assessmentSnapshot(): DashboardSnapshot {
    const snapshot = createPersonalSnapshot();
    snapshot.account = { ...snapshot.account, status: 'connected', displayLabel: '合成账户' };
    snapshot.persons[0] = { ...snapshot.persons[0]!, acceptedFactCount: 3, derivedStatus: 'current', dataRevision: 'a'.repeat(64) };
    snapshot.persons.push({ ...snapshot.persons[0]!, id: 'second-person', displayName: '另一位家人',
      derivedStatus: 'stale', assessmentRefreshStatus: 'optional_rules', dataRevision: 'b'.repeat(64) });
    return snapshot;
  }

  async function openMemberManagement() {
    fireEvent.click(await screen.findByRole('button', { name: '成员档案' }));
    fireEvent.change(screen.getByRole('combobox', { name: '切换成员' }), { target: { value: 'second-person' } });
    expect(await screen.findByRole('heading', { name: '另一位家人' })).toBeTruthy();
    fireEvent.click(screen.getByText('更多管理'));
  }

  it('仅为当前选定成员打开授权窗；勾选前不发送，确认后只提交该成员及已确认版本', async () => {
    const snapshot = assessmentSnapshot();
    const processNow = vi.fn<HealthDesktopBridge['processNow']>().mockResolvedValue({ ok: true,
      data: { batchId: 'assessment-only-batch' }, revision: 1 });
    installBridge(snapshot, { processNow });
    render(<App />);
    await openMemberManagement();
    fireEvent.click(screen.getByRole('button', { name: '仅更新健康解读' }));
    const dialog = screen.getByRole('dialog', { name: '确认发送范围' });
    expect(within(dialog).getByText('仅更新成员综合')).toBeTruthy();
    expect(within(dialog).getByText('另一位家人')).toBeTruthy();
    expect(within(dialog).queryByText('测试成员')).toBeNull();
    expect(within(dialog).getByText(/已完成的报告不会重新上传或提取，也不会重新读取原文件/)).toBeTruthy();
    expect(within(dialog).getByText(/不读取新报告，不处理其他成员/)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: '授权并开始' }).hasAttribute('disabled')).toBe(true);
    expect(processNow).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('checkbox', { name: '我确认本次接收方、用途和资料范围' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '授权并开始' }));
    await waitFor(() => expect(processNow).toHaveBeenCalledExactlyOnceWith({
      consentVersion: 1, confirmedDataRecipient: 'OpenAI/Codex',
      assessmentPersonId: 'second-person', expectedAssessmentDataRevision: 'b'.repeat(64)
    }));
    expect(processNow.mock.calls[0]![0]).not.toHaveProperty('documentIds');
    expect(processNow.mock.calls[0]![0]).not.toHaveProperty('purpose');
  });

  it('同成员有活动任务时不能再建综合', async () => {
    const snapshot = assessmentSnapshot();
    snapshot.jobs = [{ ...createDemoSnapshot().jobs[0]!, personLabel: '另一位家人', status: 'running', stage: 'extract' }];
    const processNow = vi.fn<HealthDesktopBridge['processNow']>();
    installBridge(snapshot, { processNow });
    render(<App />);
    await openMemberManagement();
    const button = screen.getByRole('button', { name: '仅更新健康解读' });
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.click(button);
    expect(screen.queryByRole('dialog', { name: '确认发送范围' })).toBeNull();
    expect(processNow).not.toHaveBeenCalled();
  });

  it('其他成员正在处理报告，不阻止为选定成员单独确认综合', async () => {
    const snapshot = assessmentSnapshot();
    snapshot.jobs = [{ ...createDemoSnapshot().jobs[0]!, personLabel: '测试成员', status: 'running', stage: 'extract' }];
    const processNow = vi.fn<HealthDesktopBridge['processNow']>();
    installBridge(snapshot, { processNow });
    render(<App />);
    await openMemberManagement();
    const button = screen.getByRole('button', { name: '仅更新健康解读' });
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);
    const dialog = screen.getByRole('dialog', { name: '确认发送范围' });
    expect(within(dialog).getByText('另一位家人')).toBeTruthy();
    expect(within(dialog).queryByText('测试成员')).toBeNull();
    expect(processNow).not.toHaveBeenCalled();
  });

  it('确认期间成员资料版本变化会撤销勾选，不会按旧范围发送', async () => {
    const snapshot = assessmentSnapshot();
    let publish!: (next: DashboardSnapshot) => void;
    const processNow = vi.fn<HealthDesktopBridge['processNow']>();
    installBridge(snapshot, { processNow, onSnapshotChanged: (listener) => { publish = listener; return () => undefined; } });
    render(<App />);
    await openMemberManagement();
    fireEvent.click(screen.getByRole('button', { name: '仅更新健康解读' }));
    const dialog = screen.getByRole('dialog', { name: '确认发送范围' });
    const checkbox = within(dialog).getByRole('checkbox', { name: '我确认本次接收方、用途和资料范围' }) as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
    const updated = structuredClone(snapshot);
    updated.persons[1]!.dataRevision = 'c'.repeat(64);
    act(() => publish(updated));
    expect(checkbox.checked).toBe(false);
    expect(within(dialog).getByRole('button', { name: '授权并开始' }).hasAttribute('disabled')).toBe(true);
    expect(processNow).not.toHaveBeenCalled();
  });

  it('确认期间同成员新任务开始时撤销授权，不会重复提交', async () => {
    const snapshot = assessmentSnapshot();
    let publish!: (next: DashboardSnapshot) => void;
    const processNow = vi.fn<HealthDesktopBridge['processNow']>();
    installBridge(snapshot, { processNow, onSnapshotChanged: (listener) => { publish = listener; return () => undefined; } });
    render(<App />);
    await openMemberManagement();
    fireEvent.click(screen.getByRole('button', { name: '仅更新健康解读' }));
    const dialog = screen.getByRole('dialog', { name: '确认发送范围' });
    const checkbox = within(dialog).getByRole('checkbox', { name: '我确认本次接收方、用途和资料范围' }) as HTMLInputElement;
    fireEvent.click(checkbox);
    const busy = structuredClone(snapshot);
    busy.jobs = [{ ...createDemoSnapshot().jobs[0]!, personLabel: '另一位家人', status: 'running', stage: 'extract' }];
    act(() => publish(busy));
    expect(checkbox.checked).toBe(false);
    expect(within(dialog).getByText(/这位成员已有处理任务/)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: '授权并开始' }).hasAttribute('disabled')).toBe(true);
    expect(processNow).not.toHaveBeenCalled();
  });
});

describe('可选局部报告维护', () => {
  function maintenanceSnapshot(): DashboardSnapshot {
    const snapshot = createPersonalSnapshot();
    snapshot.account = { ...snapshot.account, status: 'connected', displayLabel: '合成账户' };
    snapshot.persons[0] = { ...snapshot.persons[0]!, acceptedFactCount: 2, derivedStatus: 'current', dataRevision: 'a'.repeat(64) };
    snapshot.persons.push({ ...snapshot.persons[0]!, id: 'maintenance-person-2', displayName: '另一位家人' });
    snapshot.inbox = ['first', 'second', 'untouched'].map((id, index) => {
      const person = snapshot.persons[index === 1 ? 1 : 0]!;
      return { id, displayName: `合成维护${id}.pdf`, personId: person.id, personLabel: person.displayName,
        discoveredAt: '2026-01-01T00:00:00Z', status: 'completed', format: 'PDF', sourceLabel: '手动导入',
        sentToAi: true, aiTransmissionStatus: 'completed', inProcessingCenter: false, acceptedFactCount: 1, issue: null };
    });
    snapshot.reviews = snapshot.inbox.map((document) => ({ id: `maintenance-${document.id}`, documentId: document.id,
      personId: document.personId, kind: 'coverage_gap', severity: 'warning', title: '部分内容尚未核实',
      description: '可靠结果已保存，未核实内容仍不进入分析。', evidenceRefs: [], candidateOptions: [], candidateDiffs: [],
      reportedName: null, reasonCodes: ['source_binding_unresolved'], resolutionStatus: 'open' }));
    // 同份报告的多个说明不能变成多份发送范围。
    snapshot.reviews.push({ ...snapshot.reviews[0]!, id: 'maintenance-first-extra' });
    return snapshot;
  }

  async function openMaintenance() {
    fireEvent.click(await screen.findByRole('button', { name: '处理中心' }));
    fireEvent.click(screen.getByText('可选维护：重新核对报告'));
    return screen.findByRole('group', { name: '选择可选维护报告' });
  }

  it('问题页补读绑定发送范围，切换范围撤销确认且不会悄悄降级为整份重读', async () => {
    const snapshot = maintenanceSnapshot();
    snapshot.reviews[0]!.readingAudit = { version: 1, totalCandidates: 2, savedCandidates: 1, emptyCandidates: 0,
      pending: [{ localKey: 'unresolved', originalName: '合成待核对项目', reasonCodes: ['source_binding_unresolved'] }],
      historicalReadingCount: 0, unrepresentedSourceCount: 1, pageGapCount: 1 };
    const processNow = vi.fn<HealthDesktopBridge['processNow']>().mockResolvedValue({ ok: true, data: { batchId: 'page-supplement' }, revision: 1 });
    installBridge(snapshot, { processNow });
    render(<App />);
    const choices = await openMaintenance();
    fireEvent.click(within(choices).getByRole('checkbox', { name: '选择维护报告：合成维护first.pdf' }));
    fireEvent.click(screen.getByRole('button', { name: '重新核对所选报告（1）' }));
    const dialog = screen.getByRole('dialog', { name: '确认发送范围' });
    const confirmation = within(dialog).getByRole('checkbox', { name: '我确认本次接收方、用途和资料范围' });
    fireEvent.click(confirmation);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '只补读问题页（保留其他页结果）' }));
    expect((confirmation as HTMLInputElement).checked).toBe(false);
    expect(within(dialog).getByText(/无法确定问题页时会停止，不会自动改成整份重读/)).toBeTruthy();
    expect(processNow).not.toHaveBeenCalled();
    fireEvent.click(confirmation);
    fireEvent.click(within(dialog).getByRole('button', { name: '授权并开始' }));
    await waitFor(() => expect(processNow).toHaveBeenCalledExactlyOnceWith({ documentIds: ['first'],
      readingScope: 'unresolved_pages', consentVersion: 1, confirmedDataRecipient: 'OpenAI/Codex' }));
  });

  it('默认折叠且不发请求；跨成员只重读勾选并去重的报告，复用一次范围授权', async () => {
    const snapshot = maintenanceSnapshot();
    snapshot.reviews[0]!.reasonCodes = ['prior_unresolved_source_not_reconciled'];
    const processNow = vi.fn<HealthDesktopBridge['processNow']>().mockResolvedValue({ ok: true, data: { batchId: 'maintenance-batch' }, revision: 1 });
    installBridge(snapshot, { processNow });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '处理中心' }));
    expect(screen.queryByRole('group', { name: '选择可选维护报告' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('以前未能核实的内容，本次仍缺少足够来源证明已解决；原件和已保存结果保留')).toBeTruthy();
    expect(processNow).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('可选维护：重新核对报告'));
    const choices = await screen.findByRole('group', { name: '选择可选维护报告' });
    expect(within(choices).getAllByRole('checkbox')).toHaveLength(3);
    expect(within(choices).getAllByRole('checkbox').every((input) => !(input as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByRole('button', { name: '重新核对所选报告（0）' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(within(choices).getByRole('checkbox', { name: '选择维护报告：合成维护first.pdf' }));
    fireEvent.click(within(choices).getByRole('checkbox', { name: '选择维护报告：合成维护second.pdf' }));
    fireEvent.click(screen.getByRole('button', { name: '重新核对所选报告（2）' }));
    const dialog = screen.getByRole('dialog', { name: '确认发送范围' });
    expect(within(dialog).getAllByRole('checkbox', { name: /^选择重新核对报告/ })).toHaveLength(2);
    expect(within(dialog).queryByText('合成维护untouched.pdf')).toBeNull();
    expect(within(dialog).getByText(/已有报告结果会保留/)).toBeTruthy();
    expect(processNow).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '我确认本次接收方、用途和资料范围' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '授权并开始' }));
    await waitFor(() => expect(processNow).toHaveBeenCalledExactlyOnceWith({ documentIds: ['first', 'second'],
      consentVersion: 1, confirmedDataRecipient: 'OpenAI/Codex' }));
    expect(processNow.mock.calls[0]![0]).not.toHaveProperty('purpose');
    expect(processNow.mock.calls[0]![0]).not.toHaveProperty('assessmentPersonId');
  });

  it('六加三份中无候选的metadata日期提示同样可选，纯轮询时间变化不撤回一次授权', async () => {
    const snapshot = maintenanceSnapshot();
    snapshot.inbox = Array.from({ length: 9 }, (_, index) => {
      const person = snapshot.persons[index < 6 ? 0 : 1]!;
      return { ...snapshot.inbox[0]!, id: `nine-${index}`, displayName: `合成九份${index}.pdf`, personId: person.id, personLabel: person.displayName };
    });
    snapshot.reviews = snapshot.inbox.map((document, index) => ({ ...snapshot.reviews[0]!, id: `nine-review-${index}`,
      documentId: document.id, personId: document.personId,
      reasonCodes: [index < 3 ? 'report_metadata_date_role_unverified' : 'source_binding_unresolved'] }));
    let publish!: (next: DashboardSnapshot) => void;
    const processNow = vi.fn<HealthDesktopBridge['processNow']>().mockResolvedValue({ ok: true, data: { batchId: 'nine-maintenance-batch' }, revision: 1 });
    installBridge(snapshot, { processNow, onSnapshotChanged: (listener) => { publish = listener; return () => undefined; } });
    render(<App />);
    const choices = await openMaintenance();
    expect(within(choices).getAllByRole('checkbox')).toHaveLength(9);
    for (const checkbox of within(choices).getAllByRole('checkbox')) fireEvent.click(checkbox);
    const polled = structuredClone(snapshot);
    polled.generatedAt = '2026-10-17T10:00:01Z';
    polled.account.lastCheckedAt = polled.generatedAt;
    act(() => publish(polled));
    expect(screen.getByRole('button', { name: '重新核对所选报告（9）' }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '重新核对所选报告（9）' }));
    const dialog = screen.getByRole('dialog', { name: '确认发送范围' });
    const confirmation = within(dialog).getByRole('checkbox', { name: '我确认本次接收方、用途和资料范围' });
    fireEvent.click(confirmation);
    act(() => publish({ ...structuredClone(polled), generatedAt: '2026-10-17T10:00:02Z' }));
    expect((confirmation as HTMLInputElement).checked).toBe(true);
    expect(within(dialog).getByRole('button', { name: '授权并开始' }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: '授权并开始' }));
    await waitFor(() => expect(processNow).toHaveBeenCalledExactlyOnceWith({ documentIds: snapshot.inbox.map((document) => document.id),
      consentVersion: 1, confirmedDataRecipient: 'OpenAI/Codex' }));
  });

  it('身份、覆盖保护、归档或未归属成员不进入维护选择，活跃队列也不提供重读入口', async () => {
    const snapshot = maintenanceSnapshot();
    snapshot.reviews.push({ ...snapshot.reviews[0]!, id: 'protected', kind: 'overwrite_protected' });
    snapshot.inbox[1]!.personId = 'archived-person';
    snapshot.reviews[1]!.personId = 'archived-person';
    snapshot.inbox[2]!.personId = null;
    snapshot.reviews[2]!.personId = null;
    const processNow = vi.fn();
    let publish!: (next: DashboardSnapshot) => void;
    installBridge(snapshot, { processNow, onSnapshotChanged: (listener) => { publish = listener; return () => undefined; } });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '处理中心' }));
    expect(screen.queryByText('可选维护：重新核对报告')).toBeNull();
    const busy = maintenanceSnapshot();
    busy.jobs = [{ ...createDemoSnapshot().jobs[0]!, status: 'running', stage: 'extract' }];
    act(() => publish(busy));
    expect(screen.queryByText('可选维护：重新核对报告')).toBeNull();
    expect(processNow).not.toHaveBeenCalled();
  });

  it('上传时明确选择成员的两份旧姓名冲突和一份身份来源不足可一起重读，无需确认同名', async () => {
    const snapshot = maintenanceSnapshot();
    const person = snapshot.persons[0]!;
    snapshot.inbox = ['identity-first', 'identity-second', 'subject-unproven'].map((id, index) => ({ ...snapshot.inbox[0]!,
      id, displayName: `合成已选成员${index + 1}.pdf`, personId: person.id, personLabel: person.displayName,
      personAssignmentBasis: index === 1 ? 'identity_confirmed' : 'user_selected', status: 'needs_review', acceptedFactCount: 0 }));
    snapshot.reviews = snapshot.inbox.map((document, index) => ({ ...snapshot.reviews[0]!, id: `old-identity-${index}`,
      documentId: document.id, personId: document.personId, kind: index < 2 ? 'person_conflict' : 'coverage_gap',
      severity: 'blocking', title: '旧版姓名核对', description: '旧版要求再次确认同名。',
      reasonCodes: [index < 2 ? 'PERSON_IDENTITY_NOT_CONFIRMED' : 'DIRECT_ORIGINAL_IDENTITY_UNPROVEN'] }));
    snapshot.reviews.push({ ...snapshot.reviews[0]!, id: 'independent-source-warning', kind: 'coverage_gap', severity: 'warning',
      title: '来源说明保留', description: '独立的普通来源说明。', reasonCodes: ['source_binding_unresolved'] });
    const before = JSON.stringify(snapshot);
    const processNow = vi.fn<HealthDesktopBridge['processNow']>().mockResolvedValue({ ok: true, data: { batchId: 'identity-maintenance-batch' }, revision: 1 });
    const resolveReview = vi.fn<HealthDesktopBridge['resolveReview']>();
    installBridge(snapshot, { processNow, resolveReview });
    render(<App />);
    const choices = await openMaintenance();
    expect(within(choices).getAllByRole('checkbox')).toHaveLength(3);
    expect(screen.queryByRole('region', { name: '资料处理说明' })).toBeNull();
    expect(screen.queryByRole('button', { name: /确认同一人|保存别名/ })).toBeNull();
    expect(screen.getAllByText('无需再次确认同名，重新整理会沿用上传时选择的成员；报告内容仍按原件核实。')).toHaveLength(3);
    for (const checkbox of within(choices).getAllByRole('checkbox')) fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: '重新核对所选报告（3）' }));
    const dialog = screen.getByRole('dialog', { name: '确认发送范围' });
    expect(within(dialog).getAllByRole('checkbox', { name: /^选择重新核对报告/ })).toHaveLength(3);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '我确认本次接收方、用途和资料范围' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '授权并开始' }));
    await waitFor(() => expect(processNow).toHaveBeenCalledExactlyOnceWith({ documentIds: snapshot.inbox.map((item) => item.id),
      consentVersion: 1, confirmedDataRecipient: 'OpenAI/Codex' }));
    expect(resolveReview).not.toHaveBeenCalled();
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it.each([undefined, 'folder_binding', 'legacy'] as const)('旧身份事项在归属依据 %s 时仍留说明，不提供错误恢复入口', async (personAssignmentBasis) => {
    const snapshot = maintenanceSnapshot();
    snapshot.inbox = [{ ...snapshot.inbox[0]!, personAssignmentBasis, status: 'needs_review', acceptedFactCount: 0 }];
    snapshot.reviews = [{ ...snapshot.reviews[0]!, kind: 'coverage_gap', severity: 'blocking', reasonCodes: ['DIRECT_ORIGINAL_IDENTITY_UNPROVEN'] }];
    const processNow = vi.fn();
    installBridge(snapshot, { processNow });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '处理中心' }));
    expect(screen.queryByText('可选维护：重新核对报告')).toBeNull();
    expect(screen.getByRole('region', { name: '资料处理说明' })).toBeTruthy();
    expect(processNow).not.toHaveBeenCalled();
  });

  it('明确选择的旧姓名事项若混合未知原因或提交隔离仍不进入维护选择', async () => {
    const snapshot = maintenanceSnapshot();
    snapshot.inbox = snapshot.inbox.slice(0, 2).map((document) => ({ ...document, personAssignmentBasis: 'user_selected', status: 'needs_review' }));
    snapshot.reviews = snapshot.inbox.map((document, index) => ({ ...snapshot.reviews[0]!, id: `unrecoverable-${index}`,
      documentId: document.id, personId: document.personId, kind: 'person_conflict', severity: 'blocking',
      reasonCodes: index === 0 ? ['PERSON_IDENTITY_NOT_CONFIRMED', 'unknown_reason'] : ['COMMITTED_PERSON_IDENTITY_CONFLICT'] }));
    const processNow = vi.fn();
    installBridge(snapshot, { processNow });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '处理中心' }));
    expect(screen.queryByText('可选维护：重新核对报告')).toBeNull();
    expect(screen.getByRole('region', { name: '资料处理说明' })).toBeTruthy();
    expect(processNow).not.toHaveBeenCalled();
  });

  it.each(['blocking', 'candidate_diff'] as const)('同报告还有独立%s时，不借旧身份恢复绕过其他门禁', async (scenario) => {
    const snapshot = maintenanceSnapshot();
    snapshot.inbox = [{ ...snapshot.inbox[0]!, personAssignmentBasis: 'user_selected', status: 'needs_review' }];
    snapshot.reviews = [{ ...snapshot.reviews[0]!, kind: 'person_conflict', severity: 'blocking', reasonCodes: ['PERSON_IDENTITY_NOT_CONFIRMED'] },
      { ...snapshot.reviews[0]!, id: 'independent-protection', severity: scenario === 'blocking' ? 'blocking' : 'warning',
        ...(scenario === 'candidate_diff' ? { candidateDiffs: [{ localKey: 'synthetic-value', itemName: '合成项目', fields: ['value'] }] } : {}) }];
    const processNow = vi.fn();
    installBridge(snapshot, { processNow });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '处理中心' }));
    expect(screen.queryByText('可选维护：重新核对报告')).toBeNull();
    expect(screen.getByRole('region', { name: '资料处理说明' })).toBeTruthy();
    expect(processNow).not.toHaveBeenCalled();
  });

  it('一次确认中可继续缩小为单份，发送回执未返回时重复点击不重复建批次', async () => {
    const snapshot = maintenanceSnapshot();
    let finish!: (value: Awaited<ReturnType<HealthDesktopBridge['processNow']>>) => void;
    const processNow = vi.fn<HealthDesktopBridge['processNow']>(() => new Promise((resolve) => { finish = resolve; }));
    installBridge(snapshot, { processNow });
    render(<App />);
    const choices = await openMaintenance();
    for (const name of ['first', 'second']) fireEvent.click(within(choices).getByRole('checkbox', { name: `选择维护报告：合成维护${name}.pdf` }));
    fireEvent.click(screen.getByRole('button', { name: '重新核对所选报告（2）' }));
    const dialog = screen.getByRole('dialog', { name: '确认发送范围' });
    const confirmation = within(dialog).getByRole('checkbox', { name: '我确认本次接收方、用途和资料范围' });
    fireEvent.click(confirmation);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '选择重新核对报告：合成维护second.pdf' }));
    expect((confirmation as HTMLInputElement).checked).toBe(false);
    fireEvent.click(confirmation);
    const submit = within(dialog).getByRole('button', { name: '授权并开始' });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(processNow).toHaveBeenCalledExactlyOnceWith({ documentIds: ['first'], consentVersion: 1, confirmedDataRecipient: 'OpenAI/Codex' });
    expect(submit.hasAttribute('disabled')).toBe(true);
    await act(async () => finish({ ok: true, data: { batchId: 'single-maintenance-batch' }, revision: 1 }));
    expect(screen.queryByRole('dialog', { name: '确认发送范围' })).toBeNull();
  });

  it('维护范围变更清空选择，确认页中的资料变化也撤销发送授权', async () => {
    const snapshot = maintenanceSnapshot();
    let publish!: (next: DashboardSnapshot) => void;
    const processNow = vi.fn();
    installBridge(snapshot, { processNow, onSnapshotChanged: (listener) => { publish = listener; return () => undefined; } });
    render(<App />);
    const choices = await openMaintenance();
    fireEvent.click(within(choices).getByRole('checkbox', { name: '选择维护报告：合成维护first.pdf' }));
    const changed = structuredClone(snapshot);
    changed.inbox[0]!.displayName = '合成新名称.pdf';
    act(() => publish(changed));
    expect((screen.getByRole('checkbox', { name: '选择维护报告：合成新名称.pdf' }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole('button', { name: '重新核对所选报告（0）' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: '选择维护报告：合成新名称.pdf' }));
    fireEvent.click(screen.getByRole('button', { name: '重新核对所选报告（1）' }));
    const dialog = screen.getByRole('dialog', { name: '确认发送范围' });
    const confirmation = within(dialog).getByRole('checkbox', { name: '我确认本次接收方、用途和资料范围' });
    fireEvent.click(confirmation);
    expect(within(dialog).getByRole('button', { name: '授权并开始' }).hasAttribute('disabled')).toBe(false);
    const updated = structuredClone(changed);
    updated.persons[0]!.dataRevision = 'b'.repeat(64);
    act(() => publish(updated));
    expect((confirmation as HTMLInputElement).checked).toBe(false);
    expect(within(dialog).getByRole('button', { name: '授权并开始' }).hasAttribute('disabled')).toBe(true);
    const reassigned = structuredClone(updated);
    reassigned.inbox[0]!.personId = updated.persons[1]!.id;
    act(() => publish(reassigned));
    expect(within(dialog).getByRole('checkbox', { name: '选择重新核对报告：合成新名称.pdf' }).hasAttribute('disabled')).toBe(true);
    act(() => publish(updated));
    expect((confirmation as HTMLInputElement).checked).toBe(false);
    expect(processNow).not.toHaveBeenCalled();
  });
});

describe('本次重读版本与已接纳结果的说明', () => {
  function readingSnapshot(reasonCodes: string[], acceptedFactCount = 8): DashboardSnapshot {
    const snapshot = createPersonalSnapshot();
    snapshot.persons[0]!.acceptedFactCount = acceptedFactCount;
    snapshot.inbox = [{ id: 'reading-document', displayName: '合成重读说明.txt', personId: snapshot.persons[0]!.id,
      personLabel: '测试成员', discoveredAt: '2026-01-01T00:00:00Z', status: 'completed', format: '纯文本',
      sourceLabel: '手动导入', sentToAi: true, aiTransmissionStatus: 'completed', inProcessingCenter: false,
      acceptedFactCount, issue: null }];
    const base: ReviewIssue['candidateOptions'][number] = { localKey: 'reading-1', originalName: '合成同项结果',
      standardNameCandidate: null, value: { kind: 'text', rawText: '合成正常' }, unitRaw: null, referenceRangeRaw: null,
      reportedAbnormalFlag: null, specimen: null, method: null, bodySite: null, clinicalDate: null,
      evidence: [{ sourceSpanId: 'reading-span', quote: '合成同项结果：合成正常' }], issues: [] };
    snapshot.reviews = [{ id: 'reading-review', documentId: 'reading-document', personId: snapshot.persons[0]!.id,
      kind: 'field_conflict', severity: 'warning', title: '旧版未纳入说明',
      description: '这些项目未用于健康分析，不代表它们的结果正常。', evidenceRefs: ['reading-span'],
      candidateOptions: [base, { ...base, localKey: 'reading-2', value: { kind: 'qualitative', rawText: '合成正常', category: 'normal' } }],
      candidateDiffs: [], reportedName: null, reasonCodes, resolutionStatus: 'open' }];
    return snapshot;
  }

  it.each(['source_refinement_medical_fields_changed', 'same_source_finding_semantic_conflict:clinicalContext'])(
    '%s不能把整份历史读取版本当本次遗漏或断言全部已有同项', async (reason) => {
      const snapshot = readingSnapshot([reason]);
      const before = JSON.stringify(snapshot);
      const processNow = vi.fn();
      const resolveReview = vi.fn();
      const getEvidence = vi.fn<HealthDesktopBridge['getEvidence']>().mockResolvedValue({ ok: true, data: {
        sourceSpanId: 'reading-span', documentId: 'reading-document', displayName: '合成重读说明.txt', mediaType: 'text/plain',
        locator: '第 1 行', quote: '合成同项结果：合成正常', readability: 'clear', conversionView: false, previewImageDataUrl: null } });
      installBridge(snapshot, { processNow, resolveReview, getEvidence });
      render(<App />);
      fireEvent.click(await screen.findByRole('button', { name: '处理中心' }));
      const boundary = screen.getByRole('region', { name: '报告结果边界' });
      expect(within(boundary).getByRole('heading', { name: '1 份资料有需说明的内容' })).toBeTruthy();
      expect(within(boundary).getByText('历史读取版本（2 条待对账记录）')).toBeTruthy();
      expect(within(boundary).getByText(/这份旧记录尚无逐次完整性对账/)).toBeTruthy();
      expect(within(boundary).queryByText(/2 条本次读取记录未采用/)).toBeNull();
      expect(within(boundary).queryByText(/已接纳的同项结果仍以正式版本参与分析/)).toBeNull();
      expect(within(boundary).queryByText('这些项目未用于健康分析，不代表它们的结果正常。')).toBeNull();
      expect(within(boundary).queryByText(/这些读取结果尚未作为已确认的检查结果进入健康分析/)).toBeNull();
      fireEvent.click(within(boundary).getByRole('button', { name: '查看合成重读说明.txt的依据' }));
      const evidence = await screen.findByRole('complementary', { name: '证据侧栏' });
      expect(within(evidence).getByText('这份报告的读取完整性与历史说明')).toBeTruthy();
      expect(within(evidence).getByText(/这份旧记录尚无逐次完整性对账/)).toBeTruthy();
      expect(within(evidence).queryByText('这些项目未用于健康分析，不代表它们的结果正常。')).toBeNull();
      expect(processNow).not.toHaveBeenCalled();
      expect(resolveReview).not.toHaveBeenCalled();
      expect(JSON.stringify(snapshot)).toBe(before);
    });

  it.each([0, 8])('真实新unknown即使同报告有%s条已接纳事实，也不被说成已有同项已参与分析', async (acceptedFactCount) => {
    const snapshot = readingSnapshot(['value_unknown', 'source_span_missing'], acceptedFactCount);
    const review = snapshot.reviews[0]!;
    review.candidateOptions = [{ ...review.candidateOptions[0]!, value: { kind: 'unknown', rawText: null, reason: 'unreadable' }, evidence: [] }];
    const processNow = vi.fn();
    installBridge(snapshot, { processNow });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '处理中心' }));
    const boundary = screen.getByRole('region', { name: '报告结果边界' });
    expect(within(boundary).getByText(/未知内容不会被当作正常结果/)).toBeTruthy();
    expect(within(boundary).getByText('未能从现有原件确认可用的检查结果，不能把未知当作正常')).toBeTruthy();
    expect(within(boundary).queryByText(/重读版本未替换已有结果/)).toBeNull();
    expect(within(boundary).queryByText(/已接纳的同项结果仍以正式版本参与分析/)).toBeNull();
    expect(within(boundary).queryByText('已有正式结果保留') !== null).toBe(acceptedFactCount > 0);
    expect(processNow).not.toHaveBeenCalled();
  });

  it('逐次对账与历史版本分开，混合原因不被整组解释为已有正式同项', async () => {
    const snapshot = readingSnapshot(['same_source_finding_semantic_conflict', 'value_unknown']);
    snapshot.reviews[0]!.readingAudit = { version: 1, totalCandidates: 7, savedCandidates: 4, emptyCandidates: 1,
      pending: [{ localKey: 'p1', originalName: '合成未知项目', reasonCodes: ['value_unknown'] },
        { localKey: 'p2', originalName: '合成来源项目', reasonCodes: ['source_binding_requires_unique_mapping'] }],
      historicalReadingCount: 200, unrepresentedSourceCount: 1, pageGapCount: 1 };
    const processNow = vi.fn(); installBridge(snapshot, { processNow }); render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '处理中心' }));
    const boundary = screen.getByRole('region', { name: '报告结果边界' });
    expect(within(boundary).getByText(/最近一次读取共 7 条内容：4 条已保存或对应到已有结果，1 条原件未提供结果，2 条暂未纳入/)).toBeTruthy();
    expect(within(boundary).getByText('历史读取版本（200 条待对账记录）')).toBeTruthy();
    expect(within(boundary).getByText(/合成未知项目：未能从现有原件/)).toBeTruthy();
    expect(within(boundary).getByText(/另有 1 处可读结果摘录尚未完整对应到条目/)).toBeTruthy();
    expect(within(boundary).queryByText(/200 条本次/)).toBeNull();
    expect(processNow).not.toHaveBeenCalled();
  });
});

describe('家庭卡片身体地图的投影版本', () => {
  const systems = (attention = false): BodySystemSummaryV2[] => [{
    id: 'hepatobiliary', name: '合成肝胆系统', shortName: '合成肝胆', status: attention ? 'attention' : 'no_signal_in_scope',
    summary: '合成检查说明', factCount: 3, metricCount: 1, attentionCount: attention ? 1 : 0,
    latestDate: '2026-01-01', analysisStatus: 'current', topics: []
  }];
  function snapshotWithFacts() {
    const snapshot = createPersonalSnapshot();
    snapshot.persons[0] = { ...snapshot.persons[0]!, acceptedFactCount: 3, derivedStatus: 'current',
      dataRevision: 'a'.repeat(64), changeSummary: '合成整体说明', assessmentSummary: '合成范围说明。' };
    return snapshot;
  }
  function mount(snapshot: DashboardSnapshot, listBodySystems: HealthDesktopBridge['listBodySystems'],
    getMemberOverview?: HealthDesktopBridge['getMemberOverview']) {
    let publish: (next: DashboardSnapshot) => void = () => undefined;
    installBridge(snapshot, { ...(getMemberOverview ? { getMemberOverview: async (personId: string) => personId === snapshot.persons[0]!.id
      ? getMemberOverview(personId) : { ok: false as const, error: { code: 'NOT_FOUND', messageKey: 'test', retryable: false, correlationId: 'test' } } } : {}),
    listBodySystems: async (personId) => personId === snapshot.persons[0]!.id
      ? listBodySystems(personId) : { ok: true, data: [] },
    onSnapshotChanged: (listener) => { publish = listener; return () => undefined; } });
    render(<App />);
    return (next: DashboardSnapshot) => act(() => publish(next));
  }

  function overviewWithTopic(snapshot: DashboardSnapshot, title: string): MemberOverviewV2 {
    return { personId: snapshot.persons[0]!.id, generatedAt: '2026-10-16T00:00:00Z', dataQuality: 'partial',
      headline: snapshot.persons[0]!.changeSummary, overview: snapshot.persons[0]!.assessmentSummary!,
      latestClinicalDate: null, acceptedFactCount: 3, unclassifiedFactCount: 0, eventCount: 1,
      sourceUrgentNotices: [], currentSymptomNotices: [], attentionSystemIds: [], systems: [],
      priorityIssues: [{ id: 'reading-topic', title, explanation: '右眼和左眼来自不同日期的记录。',
        readingContext: ['本次未散瞳，不能据此确认屈光状态。'], nextStep: null, systemId: 'sensory_oral' }],
      importantChanges: [], recentChanges: [], nextActions: [] };
  }

  function snapshotWithLongOverview() {
    const snapshot = snapshotWithFacts();
    snapshot.persons[0] = { ...snapshot.persons[0]!, changeSummary: '整体情况：4项重点，涉及3个身体系统',
      assessmentSummary: '整体检查的完整解释及适用条件。'.repeat(40) + '不能据此判断未检查的部分。' };
    return snapshot;
  }

  it('家庭长总述收起时只读加载同成员重点，完整条件同屏，展开后保留全部原文', async () => {
    const snapshot = snapshotWithLongOverview();
    const read = vi.fn<HealthDesktopBridge['getMemberOverview']>()
      .mockResolvedValue({ ok: true, data: overviewWithTopic(snapshot, '左右眼的检查需要分别理解') });
    mount(snapshot, async () => ({ ok: true, data: [] }), read);
    const preview = await screen.findByRole('region', { name: '已发布的重点主题' });
    expect(within(preview).getByText('左右眼的检查需要分别理解')).toBeTruthy();
    expect(within(preview).getByText('本次未散瞳，不能据此确认屈光状态。')).toBeTruthy();
    expect(read).toHaveBeenCalledExactlyOnceWith(snapshot.persons[0]!.id);
    expect(screen.queryByText(snapshot.persons[0]!.assessmentSummary!)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开完整整体情况' }));
    expect(screen.queryByRole('region', { name: '已发布的重点主题' })).toBeNull();
    expect(screen.getByText(snapshot.persons[0]!.assessmentSummary!)).toBeTruthy();
    expect(read).toHaveBeenCalledTimes(1);
    expect(window.healthDesktop!.rebuildProcessing).not.toHaveBeenCalled();
  });

  it('家庭重点请求跨版本迟到不会覆盖新主题，清零后不恢复旧主题', async () => {
    const snapshot = snapshotWithLongOverview();
    let resolveOlder!: (result: Awaited<ReturnType<HealthDesktopBridge['getMemberOverview']>>) => void;
    let resolveLatest!: (result: Awaited<ReturnType<HealthDesktopBridge['getMemberOverview']>>) => void;
    const read = vi.fn<HealthDesktopBridge['getMemberOverview']>()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOlder = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveLatest = resolve; }));
    const publish = mount(snapshot, async () => ({ ok: true, data: [] }), read);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    const next = structuredClone(snapshot);
    next.persons[0]!.dataRevision = 'b'.repeat(64);
    publish(next);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await act(async () => resolveLatest({ ok: true, data: overviewWithTopic(next, '新版本的完整主题') }));
    expect(screen.getByText('新版本的完整主题')).toBeTruthy();
    await act(async () => resolveOlder({ ok: true, data: overviewWithTopic(snapshot, '迟到的旧主题') }));
    expect(screen.queryByText('迟到的旧主题')).toBeNull();
    const cleared = structuredClone(next);
    cleared.persons[0]!.acceptedFactCount = 0;
    publish(cleared);
    expect(screen.queryByRole('region', { name: '已发布的重点主题' })).toBeNull();
    await act(async () => undefined);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('家庭主题读取失败或返回别的成员时，不混入错误主题也不恢复旧主题', async () => {
    const snapshot = snapshotWithLongOverview();
    const foreign = { ...overviewWithTopic(snapshot, '其他成员的主题'), personId: 'not-this-person' };
    const read = vi.fn<HealthDesktopBridge['getMemberOverview']>()
      .mockResolvedValueOnce({ ok: true, data: overviewWithTopic(snapshot, '原主题') })
      .mockRejectedValueOnce(new Error('synthetic reading failure'))
      .mockResolvedValueOnce({ ok: true, data: foreign });
    const publish = mount(snapshot, async () => ({ ok: true, data: [] }), read);
    await screen.findByText('原主题');
    const newer = structuredClone(snapshot);
    newer.persons[0]!.displayRevision += 1;
    publish(newer);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await act(async () => undefined);
    expect(screen.queryByRole('region', { name: '已发布的重点主题' })).toBeNull();
    const latest = structuredClone(newer);
    latest.persons[0]!.clinicalContextRevision += 1;
    publish(latest);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    await act(async () => undefined);
    expect(screen.queryByRole('region', { name: '已发布的重点主题' })).toBeNull();
    expect(screen.queryByText('其他成员的主题')).toBeNull();
  });

  it.each(['headline', 'overview', 'acceptedFactCount'] as const)('同成员的%s属于另一个投影时不混入主题', async (field) => {
    const snapshot = snapshotWithLongOverview();
    const otherProjection = overviewWithTopic(snapshot, '不能混入的另一版主题');
    if (field === 'acceptedFactCount') otherProjection.acceptedFactCount += 1;
    else otherProjection[field] += '新版内容';
    const read = vi.fn<HealthDesktopBridge['getMemberOverview']>().mockResolvedValue({ ok: true, data: otherProjection });
    mount(snapshot, async () => ({ ok: true, data: [] }), read);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await act(async () => undefined);
    expect(screen.queryByText('不能混入的另一版主题')).toBeNull();
    expect(screen.queryByRole('region', { name: '已发布的重点主题' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开完整整体情况' }));
    expect(screen.getByText(snapshot.persons[0]!.assessmentSummary!)).toBeTruthy();
    expect(window.healthDesktop!.rebuildProcessing).not.toHaveBeenCalled();
  });

  it('重建后零事实立即隐藏并清除旧地图，不再显示旧正常分组', async () => {
    const snapshot = snapshotWithFacts();
    const read = vi.fn<HealthDesktopBridge['listBodySystems']>().mockResolvedValue({ ok: true, data: systems() });
    const publish = mount(snapshot, read);
    await screen.findByRole('region', { name: '本次未提示问题' });
    const cleared = structuredClone(snapshot);
    cleared.persons[0] = { ...cleared.persons[0]!, acceptedFactCount: 0, dataRevision: 'b'.repeat(64) };
    publish(cleared);
    expect(screen.queryByRole('region', { name: '身体情况速览' })).toBeNull();
    await act(async () => undefined);
    expect(read).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('合成肝胆')).toBeNull();
  });

  it('相同事实数量的修正会失效旧地图，较早请求晚返回不能覆盖较新的结果', async () => {
    const snapshot = snapshotWithFacts();
    let resolveOlder!: (value: Awaited<ReturnType<HealthDesktopBridge['listBodySystems']>>) => void;
    let resolveLatest!: (value: Awaited<ReturnType<HealthDesktopBridge['listBodySystems']>>) => void;
    const read = vi.fn<HealthDesktopBridge['listBodySystems']>()
      .mockResolvedValueOnce({ ok: true, data: systems() })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOlder = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveLatest = resolve; }));
    const publish = mount(snapshot, read);
    await screen.findByRole('region', { name: '本次未提示问题' });
    const corrected = structuredClone(snapshot);
    corrected.persons[0]!.dataRevision = 'b'.repeat(64);
    publish(corrected);
    expect(screen.queryByRole('region', { name: '身体情况速览' })).toBeNull();
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    const newest = structuredClone(corrected);
    newest.persons[0]!.dataRevision = 'c'.repeat(64);
    publish(newest);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    await act(async () => resolveLatest({ ok: true, data: systems(true) }));
    expect(screen.getByRole('region', { name: '值得留意' }).textContent).toContain('合成肝胆');
    await act(async () => resolveOlder({ ok: true, data: systems() }));
    expect(screen.queryByRole('region', { name: '本次未提示问题' })).toBeNull();
    expect(screen.getByRole('region', { name: '值得留意' }).textContent).toContain('合成肝胆');
  });

  it('零事实期间的旧异步结果不能重新出现，恢复相同版本也等待新请求', async () => {
    const snapshot = snapshotWithFacts();
    let resolveOlder!: (value: Awaited<ReturnType<HealthDesktopBridge['listBodySystems']>>) => void;
    let resolveLatest!: (value: Awaited<ReturnType<HealthDesktopBridge['listBodySystems']>>) => void;
    const read = vi.fn<HealthDesktopBridge['listBodySystems']>()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOlder = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveLatest = resolve; }));
    const publish = mount(snapshot, read);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    const cleared = structuredClone(snapshot);
    cleared.persons[0]!.acceptedFactCount = 0;
    publish(cleared);
    await act(async () => resolveOlder({ ok: true, data: systems() }));
    expect(screen.queryByRole('region', { name: '身体情况速览' })).toBeNull();
    publish(snapshot);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('region', { name: '身体情况速览' })).toBeNull();
    await act(async () => resolveLatest({ ok: true, data: systems(true) }));
    expect(screen.getByRole('region', { name: '值得留意' })).toBeTruthy();
  });

  it.each(['displayRevision', 'clinicalContextRevision'] as const)('%s 变化也重读地图，失败不保留旧分组', async (revision) => {
    const snapshot = snapshotWithFacts();
    const read = vi.fn<HealthDesktopBridge['listBodySystems']>()
      .mockResolvedValueOnce({ ok: true, data: systems() }).mockRejectedValueOnce(new Error('synthetic read failure'));
    const publish = mount(snapshot, read);
    await screen.findByRole('region', { name: '本次未提示问题' });
    const changed = structuredClone(snapshot);
    changed.persons[0]![revision] += 1;
    publish(changed);
    expect(screen.queryByRole('region', { name: '身体情况速览' })).toBeNull();
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await act(async () => undefined);
    expect(screen.queryByRole('region', { name: '身体情况速览' })).toBeNull();
  });
});

describe('App 单报告自动日期纠错入口', () => {
  function dateCorrectionSnapshot(): DashboardSnapshot {
    const snapshot = createPersonalSnapshot();
    snapshot.account = { ...snapshot.account, status: 'connected', displayLabel: '合成日期账户' };
    snapshot.persons[0] = { ...snapshot.persons[0]!, documentCount: 2, acceptedFactCount: 4,
      dataRevision: 'a'.repeat(64), derivedStatus: 'current' };
    snapshot.inbox = ['target', 'other'].map((key) => ({ id: `date-${key}`, displayName: key === 'target' ? '合成目标报告.pdf' : '合成其他报告.pdf',
      personId: snapshot.persons[0]!.id, personLabel: snapshot.persons[0]!.displayName,
      discoveredAt: '2026-01-01T00:00:00Z', status: 'completed', format: 'PDF', sourceLabel: '合成导入',
      sentToAi: true, aiTransmissionStatus: 'completed', inProcessingCenter: false, acceptedFactCount: 2, issue: null }));
    return snapshot;
  }

  async function openDateCorrection(snapshot: DashboardSnapshot, overrides: Partial<HealthDesktopBridge>) {
    installBridge(snapshot, overrides);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '成员档案' }));
    fireEvent.click(await screen.findByRole('tab', { name: '原始资料' }));
    fireEvent.click(await screen.findByRole('button', { name: '让模型核实并修正日期：合成目标报告.pdf' }));
    return screen.getByRole('dialog', { name: '让模型核实并修正日期' });
  }

  function confirmDateCorrection(dialog: HTMLElement) {
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: '授权并核实日期' }));
  }

  it('从对应报告行正式提交单份日期纠错，既不处理其他报告也不混用综合用途', async () => {
    const snapshot = dateCorrectionSnapshot();
    const processNow = vi.fn<HealthDesktopBridge['processNow']>().mockResolvedValue({ ok: true, data: { batchId: 'synthetic-date-correction' }, revision: 1 });
    const dialog = await openDateCorrection(snapshot, { processNow });
    expect(dialog.textContent).toContain('合成目标报告.pdf');
    expect(dialog.textContent).not.toContain('合成其他报告.pdf');
    confirmDateCorrection(dialog);
    await waitFor(() => expect(processNow).toHaveBeenCalledExactlyOnceWith({ purpose: 'date_correction', dateCorrectionDocumentId: 'date-target',
      expectedDateCorrectionDataRevision: 'a'.repeat(64), consentVersion: 1, confirmedDataRecipient: 'OpenAI/Codex' }));
    expect(processNow.mock.calls[0]![0]).not.toHaveProperty('documentIds');
    expect(processNow.mock.calls[0]![0]).not.toHaveProperty('assessmentPersonId');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '让模型核实并修正日期' })).toBeNull());
  });

  it.each([false, true])('范围过期时刷新快照、撤回授权且不自动重试，刷新失败=%s', async (refreshFails) => {
    const snapshot = dateCorrectionSnapshot();
    const changed = structuredClone(snapshot);
    changed.persons[0]!.dataRevision = 'b'.repeat(64);
    let publishSnapshot: (next: DashboardSnapshot) => void = () => undefined;
    const getSnapshot = vi.fn<HealthDesktopBridge['getSnapshot']>().mockResolvedValueOnce(snapshot);
    if (refreshFails) getSnapshot.mockRejectedValueOnce(new Error('synthetic refresh failure'));
    else getSnapshot.mockResolvedValueOnce(changed);
    getSnapshot.mockResolvedValue(changed);
    const processNow = vi.fn<HealthDesktopBridge['processNow']>()
      .mockResolvedValueOnce({ ok: false, error: { code: 'DATE_CORRECTION_SCOPE_CHANGED', messageKey: 'synthetic.scope', retryable: false, correlationId: 'synthetic' } })
      .mockResolvedValue({ ok: true, data: { batchId: 'synthetic-date-reconfirmed' }, revision: 1 });
    const dialog = await openDateCorrection(snapshot, { processNow, getSnapshot,
      onSnapshotChanged: (listener) => { publishSnapshot = listener; return () => undefined; } });
    confirmDateCorrection(dialog);
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toContain('本次授权已撤回'));
    expect(getSnapshot).toHaveBeenCalledTimes(2);
    expect(processNow).toHaveBeenCalledTimes(1);
    const checkbox = within(dialog).getByRole('checkbox') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(refreshFails);
    if (refreshFails) act(() => publishSnapshot(changed));
    expect(checkbox.disabled).toBe(false);
    expect(checkbox.checked).toBe(false);
    confirmDateCorrection(dialog);
    await waitFor(() => expect(processNow).toHaveBeenCalledTimes(2));
    expect(processNow.mock.calls[1]![0]).toEqual({ purpose: 'date_correction', dateCorrectionDocumentId: 'date-target',
      expectedDateCorrectionDataRevision: 'b'.repeat(64), consentVersion: 1, confirmedDataRecipient: 'OpenAI/Codex' });
  });

  it('等待回执时 Escape 和重复点击都不会退出或重复建任务', async () => {
    let finish: (value: Awaited<ReturnType<HealthDesktopBridge['processNow']>>) => void = () => undefined;
    const processNow = vi.fn<HealthDesktopBridge['processNow']>(() => new Promise((resolve) => { finish = resolve; }));
    const dialog = await openDateCorrection(dateCorrectionSnapshot(), { processNow });
    confirmDateCorrection(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: '授权并核实日期' }));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: '让模型核实并修正日期' })).toBe(dialog);
    expect(processNow).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ok: false, error: { code: 'SYNTHETIC_FAILED', messageKey: 'synthetic.failed', retryable: true, correlationId: 'synthetic' } }));
    expect(within(dialog).getByRole('alert').textContent).toContain('不会自动重试');
    expect((within(dialog).getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect(processNow).toHaveBeenCalledTimes(1);
  });
});

describe('App 上传后自动整理', () => {
  it('切换到新成员后直接上传到该成员，手动补充保持独立', async () => {
    const snapshot = createPersonalSnapshot();
    const person = { ...snapshot.persons[0]!, id: 'new-member', displayName: '新添加的家人', relation: '家人',
      documentCount: 0, acceptedFactCount: 0, memberOverview: null };
    snapshot.persons.push(person);
    const selectFiles = vi.fn<HealthDesktopBridge['selectFiles']>().mockResolvedValue({ ok: true, data: {
      selectedCount: 0, importedCount: 0, duplicateCount: 0, suppressedCount: 0, rejected: []
    } });
    installBridge(snapshot, { selectFiles });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '成员档案' }));
    fireEvent.change(screen.getByRole('combobox', { name: '切换成员' }), { target: { value: person.id } });
    fireEvent.click(screen.getByRole('button', { name: '上传报告' }));
    await waitFor(() => expect(selectFiles).toHaveBeenCalledExactlyOnceWith(person.id, true));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '手动补充' }));
    const dialog = await screen.findByRole('dialog', { name: '手动补充健康信息' });
    expect((within(dialog).getByRole('combobox', { name: '家庭成员' }) as HTMLSelectElement).value).toBe(person.id);
    expect(selectFiles).toHaveBeenCalledTimes(1);
  });

  it('收件箱明确选择的成员失效时回到仅保存原件，不转给其他成员', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.persons.push({ ...snapshot.persons[0]!, id: 'other-member', displayName: '其他成员' });
    let publish!: (next: DashboardSnapshot) => void;
    const selectFiles = vi.fn<HealthDesktopBridge['selectFiles']>().mockResolvedValue({ ok: true, data: {
      selectedCount: 0, importedCount: 0, duplicateCount: 0, suppressedCount: 0, rejected: []
    } });
    installBridge(snapshot, { selectFiles, onSnapshotChanged: (listener) => { publish = listener; return () => undefined; } });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '报告收件箱' }));
    fireEvent.change(screen.getByRole('combobox', { name: '归属成员' }), { target: { value: 'other-member' } });
    const next = structuredClone(snapshot);
    next.persons = next.persons.filter((person) => person.id !== 'other-member');
    act(() => publish(next));
    expect((screen.getByRole('combobox', { name: '归属成员' }) as HTMLSelectElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: '选择文件并保存' }));
    await waitFor(() => expect(selectFiles).toHaveBeenCalledExactlyOnceWith(null, true));
  });

  it('选择文件即请求自动整理，精确处理范围交给主进程，不再二次发起任务', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.account = { ...snapshot.account, status: 'connected' };
    const selectFiles = vi.fn<HealthDesktopBridge['selectFiles']>().mockResolvedValue({ ok: true, data: {
      selectedCount: 2, importedCount: 1, duplicateCount: 1, suppressedCount: 0, rejected: [],
      processing: { status: 'queued', batchId: 'synthetic-upload-batch' }
    } });
    const processNow = vi.fn<HealthDesktopBridge['processNow']>();
    let publish: (next: DashboardSnapshot) => void = () => undefined;
    installBridge(snapshot, { selectFiles, processNow, onSnapshotChanged: (listener) => { publish = listener; return () => undefined; } });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '报告收件箱' }));
    expect(screen.getByText('上传后由 OpenAI/Codex 自动整理报告并生成健康看板。')).toBeTruthy();
    const disclosure = screen.getByText('将使用本次原件、该成员必要的既有记录和本人补充信息；不会自动修改本人计划。');
    expect(disclosure.compareDocumentPosition(screen.getByRole('button', { name: '上传并整理' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '上传并整理' }));
    await waitFor(() => expect(selectFiles).toHaveBeenCalledExactlyOnceWith('personal-person-1', true));
    expect(await screen.findByText(/正在自动整理报告，完成后会更新健康看板/)).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '确认发送范围' })).toBeNull();
    const next = structuredClone(snapshot);
    next.inbox = [{ id: 'not-from-this-upload', displayName: '其他历史资料.pdf', personId: 'personal-person-1',
      personLabel: '测试成员', discoveredAt: '2026-01-01T00:00:00Z', status: 'queued', format: 'PDF',
      sourceLabel: '手动导入', sentToAi: false, aiTransmissionStatus: 'not_sent', inProcessingCenter: false, issue: null }];
    act(() => publish(next));
    act(() => publish(structuredClone(next)));
    expect(processNow).not.toHaveBeenCalled();
  });

  it.each(['another-member', ''])('文件选择与拖入使用同一个上传归属范围：%s', async (target) => {
    const snapshot = createPersonalSnapshot();
    snapshot.persons.push({ ...snapshot.persons[0]!, id: 'another-member', displayName: '另一位成员' });
    const selectFiles = vi.fn<HealthDesktopBridge['selectFiles']>().mockResolvedValue({ ok: true, data: {
      selectedCount: 0, importedCount: 0, duplicateCount: 0, suppressedCount: 0, rejected: []
    } });
    installBridge(snapshot, { selectFiles });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '报告收件箱' }));
    fireEvent.change(screen.getByRole('combobox', { name: '归属成员' }), { target: { value: target } });
    expect(screen.getByText(target ? '本次选择的文件都会放入另一位成员的档案，以你选择的成员为准。' : '可以先保存文件，选择成员后再自动整理。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: target ? '上传并整理' : '选择文件并保存' }));
    await waitFor(() => expect(selectFiles).toHaveBeenCalledExactlyOnceWith(target || null, true));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('拖入文件即请求自动整理，不根据刷新后的收件箱推测本次资料范围', async () => {
    const snapshot = createPersonalSnapshot();
    const importDroppedFiles = vi.fn<HealthDesktopBridge['importDroppedFiles']>().mockResolvedValue({ ok: true, data: {
      selectedCount: 1, importedCount: 1, duplicateCount: 0, suppressedCount: 0, rejected: [],
      processing: { status: 'queued', batchId: 'synthetic-drop-batch' }
    } });
    const processNow = vi.fn();
    installBridge(snapshot, { importDroppedFiles, processNow });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '报告收件箱' }));
    const file = new File(['synthetic report'], 'synthetic.pdf', { type: 'application/pdf' });
    fireEvent.drop(screen.getByText('拖入 PDF、图片、DOCX 或 TXT').closest('section')!, { dataTransfer: { files: [file] } });
    await waitFor(() => expect(importDroppedFiles).toHaveBeenCalledExactlyOnceWith('personal-person-1', [file], true));
    expect(await screen.findByText(/正在自动整理报告/)).toBeTruthy();
    expect(processNow).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: '确认发送范围' })).toBeNull();
  });

  it('暂未连接时保留后台等待回执，重复快照不会要求再次授权或重复发送', async () => {
    const snapshot = createPersonalSnapshot();
    const selectFiles = vi.fn<HealthDesktopBridge['selectFiles']>().mockResolvedValue({ ok: true, data: {
      selectedCount: 1, importedCount: 1, duplicateCount: 0, suppressedCount: 0, rejected: [],
      processing: { status: 'waiting_connection' }
    } });
    const processNow = vi.fn();
    installBridge(snapshot, { selectFiles, processNow });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '报告收件箱' }));
    fireEvent.click(screen.getByRole('button', { name: '上传并整理' }));
    expect(await screen.findByText(/连接 Codex 后会自动继续/)).toBeTruthy();
    expect(processNow).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: '确认发送范围' })).toBeNull();
  });

  it('用户取消文件选择后不创建任务，也不跳转到处理中', async () => {
    const selectFiles = vi.fn<HealthDesktopBridge['selectFiles']>().mockResolvedValue({ ok: true, data: {
      selectedCount: 0, importedCount: 0, duplicateCount: 0, suppressedCount: 0, rejected: []
    } });
    const processNow = vi.fn();
    installBridge(createPersonalSnapshot(), { selectFiles, processNow });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '报告收件箱' }));
    fireEvent.click(screen.getByRole('button', { name: '上传并整理' }));
    await waitFor(() => expect(selectFiles).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('heading', { name: '上传报告，查看健康看板' })).toBeTruthy();
    expect(processNow).not.toHaveBeenCalled();
  });

  it('来源或身份有问题时仅展示说明和原件入口，不要求批准、改数值或重新核对', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.persons[0]!.documentCount = 2;
    snapshot.inbox = ['source', 'identity'].map((id) => ({ id, displayName: `合成${id}.pdf`,
      personId: 'personal-person-1', personLabel: '测试成员', discoveredAt: '2026-01-01T00:00:00Z',
      status: 'needs_review' as const, format: 'PDF', sourceLabel: '手动导入', sentToAi: true,
      aiTransmissionStatus: 'completed' as const, inProcessingCenter: true, issue: null }));
    snapshot.reviews = snapshot.inbox.map((document, index) => ({ id: `review-${index}`, documentId: document.id,
      personId: document.personId, kind: index === 0 ? 'coverage_gap' as const : 'person_conflict' as const,
      severity: 'blocking' as const, title: '合成读取问题', description: '部分原文暂未可靠对应。',
      evidenceRefs: [], candidateOptions: [], candidateDiffs: [], reportedName: null,
      reasonCodes: index === 0 ? ['direct_original_evidence_role_mismatch'] : ['PERSON_IDENTITY_NOT_CONFIRMED'],
      resolutionStatus: 'open' as const }));
    const processNow = vi.fn();
    const resolveReview = vi.fn();
    installBridge(snapshot, { processNow, resolveReview });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '处理中心' }));
    expect(screen.getByRole('region', { name: '报告结果边界' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '查看合成source.pdf的依据' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /重新核对/ })).toBeNull();
    expect(screen.queryByText('需要你的确认')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(resolveReview).not.toHaveBeenCalled();
    expect(processNow).not.toHaveBeenCalled();
  });

  it('健康解读与生活建议缺少内容时仅说明自动整理状态，不要求用户刷新', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.persons[0] = { ...snapshot.persons[0]!, acceptedFactCount: 3, derivedStatus: 'stale',
      assessmentRefreshStatus: 'required', dataRevision: 'a'.repeat(64) };
    const processNow = vi.fn();
    installBridge(snapshot, { processNow });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '成员档案' }));
    expect(await screen.findByText('健康解读暂未更新')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '更新健康解读' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: '日常生活' }));
    expect(screen.queryByRole('button', { name: '更新日常建议' })).toBeNull();
    expect(screen.queryByRole('dialog', { name: '确认发送范围' })).toBeNull();
    expect(processNow).not.toHaveBeenCalled();
  });
});

describe('App 收件箱核对原因', () => {
  it.each(['field_conflict', 'coverage_gap', 'overwrite_protected', null] as const)('已归属的%s核对不冒充成员归属问题，缺少类型时保持中性', async (kind) => {
    const snapshot = createPersonalSnapshot();
    snapshot.inbox = [{ id: 'source-check', displayName: '合成来源待核对.pdf', personId: 'personal-person-1',
      personLabel: '测试成员', acceptedFactCount: 0, discoveredAt: '2026-01-01T00:00:00Z',
      status: 'needs_review', format: 'PDF', sourceLabel: '手动导入', sentToAi: true,
      aiTransmissionStatus: 'not_sent', inProcessingCenter: false,
      issue: '未可靠确认所属成员；确认前不会发送AI。' }];
    if (kind !== null) snapshot.reviews = [{ id: 'source-review', documentId: 'source-check',
      personId: 'personal-person-1', kind, severity: 'warning', title: '合成来源核对',
      description: '原件内容尚未可靠确认，已归属成员不变。', evidenceRefs: [], candidateOptions: [],
      candidateDiffs: [], reportedName: null, reasonCodes: ['synthetic_source_issue'], resolutionStatus: 'open' }];
    const resolveReview = vi.fn<HealthDesktopBridge['resolveReview']>();
    installBridge(snapshot, { resolveReview });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '报告收件箱' }));
    expect(screen.getByRole('button', { name: '处理说明 1' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '待归属 1' })).toBeNull();
    const row = screen.getByText('合成来源待核对.pdf').closest('.inbox-table__row') as HTMLElement;
    expect(within(row).getByText('测试成员')).toBeTruthy();
    expect(within(row).getByText('部分内容未纳入')).toBeTruthy();
    expect(within(row).queryByText('待确认归属')).toBeNull();
    expect(row.textContent).not.toContain('未可靠确认所属成员');
    expect(row.textContent).not.toContain('确认前不会发送AI');
    fireEvent.click(screen.getByRole('button', { name: '处理说明 1' }));
    expect(screen.getByText('合成来源待核对.pdf')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: '选中 合成来源待核对.pdf' }));
    const assign = screen.getByRole('button', { name: '分配待归属项' });
    expect(assign.hasAttribute('disabled')).toBe(true);
    fireEvent.click(assign);
    expect(resolveReview).not.toHaveBeenCalled();
  });

  it('真正未归属的需核对资料仍可启用人工批量归属，不把来源核对当作重新分配', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.inbox = [{ id: 'unassigned-check', displayName: '合成未归属报告.pdf', personId: null,
      personLabel: null, acceptedFactCount: 0, discoveredAt: '2026-01-01T00:00:00Z',
      status: 'needs_review', format: 'PDF', sourceLabel: '手动导入', sentToAi: false,
      aiTransmissionStatus: 'not_sent', inProcessingCenter: false, issue: null }];
    const resolveReview = vi.fn<HealthDesktopBridge['resolveReview']>();
    installBridge(snapshot, { resolveReview });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '报告收件箱' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '选中 合成未归属报告.pdf' }));
    expect(screen.getByRole('button', { name: '分配待归属项 (1)' }).hasAttribute('disabled')).toBe(false);
    expect(resolveReview).not.toHaveBeenCalled();
  });

  it('已读来源问题从新收件箱与角标移走，零接纳原因保留为只读说明且不要求重核', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.account = { ...snapshot.account, status: 'connected' };
    snapshot.persons[0] = { ...snapshot.persons[0]!, acceptedFactCount: 5, derivedStatus: 'current' };
    snapshot.persons.push({ ...snapshot.persons[0]!, id: 'other-person', displayName: '另一位家人', derivedStatus: 'stale', assessmentRefreshStatus: 'optional_rules' });
    snapshot.inbox = [snapshot.persons[0]!, snapshot.persons[1]!].map((person, index) => ({
      id: `read-source-${index}`, displayName: `合成已读来源${index}.pdf`, personId: person.id, personLabel: person.displayName,
      acceptedFactCount: 0, discoveredAt: '2026-01-01T00:00:00Z', status: 'needs_review', format: 'PDF', sourceLabel: '手动导入',
      sentToAi: true, aiTransmissionStatus: 'completed', inProcessingCenter: false, issue: '原件已保留。'
    }));
    snapshot.pendingInboxCount = 2;
    snapshot.reviews = snapshot.inbox.map((document, index) => ({ id: `read-review-${index}`, documentId: document.id,
      personId: document.personId, kind: 'coverage_gap', severity: 'blocking', title: '来源需核验',
      description: '原件已读完；没有可靠来源的结果未纳入。', evidenceRefs: [], candidateOptions: [], candidateDiffs: [],
      reportedName: null, reasonCodes: [index === 0 ? 'direct_original_evidence_role_mismatch' : 'value_unknown'], resolutionStatus: 'open' }));
    const processNow = vi.fn(async () => ({ ok: true as const, data: { batchId: 'single-source-rerun' }, revision: 1 }));
    installBridge(snapshot, { processNow });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '报告收件箱' }));
    expect(screen.getByRole('button', { name: '报告收件箱' }).querySelector('em')).toBeNull();
    expect(screen.getByRole('button', { name: '处理说明 0' })).toBeTruthy();
    expect(screen.queryByText('合成已读来源0.pdf')).toBeNull();
    expect(screen.queryByText('合成已读来源1.pdf')).toBeNull();
    expect(screen.getByText('暂无待处理的新资料')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '前往处理中心' }));
    const sourceScope = screen.getByRole('article', { name: '测试成员的报告结果边界' });
    expect(within(sourceScope).getByRole('heading', { name: '1 份资料暂无可用结果' })).toBeTruthy();
    expect(sourceScope.textContent).toContain('结果与原件位置的绑定尚未通过核验');
    expect(sourceScope.textContent).not.toContain('其他报告结果已保存');
    expect(sourceScope.textContent).not.toContain('这些资料已读完');
    expect(within(sourceScope).getByText('暂无检查结果纳入分析').className).toContain('status-badge--info');
    expect(screen.getByText(/未能从现有原件确认可用的检查结果/)).toBeTruthy();
    expect(within(sourceScope).queryByRole('button', { name: /重新核对/ })).toBeNull();
    expect(within(sourceScope).getByRole('button', { name: '查看合成已读来源0.pdf的依据' })).toBeTruthy();
    expect(processNow).not.toHaveBeenCalled();
    expect(snapshot.reviews.every((review) => review.resolutionStatus === 'open')).toBe(true);
  });

  it('真实person_conflict仍明确提示归属待确认，不因已有personId被伪装成普通来源核对', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.inbox = [{ id: 'identity-check', displayName: '合成身份待核对.pdf', personId: 'personal-person-1',
      personLabel: '测试成员', acceptedFactCount: 0, discoveredAt: '2026-01-01T00:00:00Z',
      status: 'needs_review', format: 'PDF', sourceLabel: '手动导入', sentToAi: false,
      aiTransmissionStatus: 'not_sent', inProcessingCenter: false,
      issue: '未可靠确认所属成员；确认前不会发送AI。' }];
    snapshot.reviews = [{ id: 'identity-review', documentId: 'identity-check', personId: 'personal-person-1',
      kind: 'person_conflict', severity: 'blocking', title: '确认报告所属成员', description: '报告身份与当前成员存在冲突。',
      evidenceRefs: [], candidateOptions: [], candidateDiffs: [], reportedName: null,
      reasonCodes: ['synthetic_person_conflict'], resolutionStatus: 'open' }];
    installBridge(snapshot);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '报告收件箱' }));
    const row = screen.getByText('合成身份待核对.pdf').closest('.inbox-table__row') as HTMLElement;
    expect(within(row).getByText('暂未纳入成员')).toBeTruthy();
    expect(row.textContent).not.toContain('确认前不会发送AI');
  });

  it.each(['person_conflict', 'PERSON_CODE', 'unassigned'] as const)('读取已完成但仍有%s归属问题时，不被来源核查迁移隐藏', async (caseId) => {
    const snapshot = createPersonalSnapshot();
    snapshot.inbox = [{ id: 'identity-completed', displayName: '合成归属仍待确认.pdf',
      personId: caseId === 'unassigned' ? null : 'personal-person-1', personLabel: caseId === 'unassigned' ? null : '测试成员',
      acceptedFactCount: 0, discoveredAt: '2026-01-01T00:00:00Z', status: 'needs_review', format: 'PDF',
      sourceLabel: '手动导入', sentToAi: true, aiTransmissionStatus: 'completed', inProcessingCenter: false, issue: null }];
    snapshot.reviews = [{ id: 'identity-completed-review', documentId: 'identity-completed', personId: snapshot.inbox[0]!.personId,
      kind: caseId === 'person_conflict' ? 'person_conflict' : 'coverage_gap', severity: 'blocking',
      title: '合成归属核对', description: '核对成员后再继续。', evidenceRefs: [], candidateOptions: [], candidateDiffs: [], reportedName: null,
      reasonCodes: caseId === 'PERSON_CODE' ? ['PERSON_IDENTITY_NOT_CONFIRMED'] : [], resolutionStatus: 'open' }];
    installBridge(snapshot);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '报告收件箱' }));
    expect(screen.getByText('合成归属仍待确认.pdf')).toBeTruthy();
    expect(screen.getByRole('button', { name: '处理说明 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '报告收件箱' }).querySelector('em')).toBeNull();
    expect(screen.queryByRole('button', { name: '立即处理全部' })).toBeNull();
  });

  it.each(['value_difference', 'overwrite_protected', 'derived_safety'] as const)('同一报告混有来源核查和%s时，仍在收件箱保留可见的需核对项', async (caseId) => {
    const snapshot = createPersonalSnapshot();
    snapshot.inbox = [{ id: 'mixed-review', displayName: '合成混合核对.pdf', personId: 'personal-person-1', personLabel: '测试成员',
      acceptedFactCount: 0, discoveredAt: '2026-01-01T00:00:00Z', status: 'needs_review', format: 'PDF',
      sourceLabel: '手动导入', sentToAi: true, aiTransmissionStatus: 'completed', inProcessingCenter: false, issue: null }];
    const sourceReview: DashboardSnapshot['reviews'][number] = { id: 'mixed-source-review', documentId: 'mixed-review',
      personId: 'personal-person-1', kind: 'coverage_gap', severity: 'warning', title: '合成来源核查', description: '原件来源尚未对应。',
      evidenceRefs: [], candidateOptions: [], candidateDiffs: [], reportedName: null, reasonCodes: [], resolutionStatus: 'open' };
    snapshot.reviews = [sourceReview, { ...sourceReview, id: 'mixed-other-review', severity: 'blocking',
      kind: caseId === 'value_difference' ? 'field_conflict' : caseId, title: '合成仍需选择的事项',
      candidateDiffs: caseId === 'value_difference' ? [{ localKey: 'synthetic-item', itemName: '合成项目', fields: ['value'] }] : [] }];
    installBridge(snapshot);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '报告收件箱' }));
    expect(screen.getByText('合成混合核对.pdf')).toBeTruthy();
    expect(screen.getByRole('button', { name: '处理说明 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '报告收件箱' }).querySelector('em')).toBeNull();
    expect(screen.queryByRole('button', { name: '立即处理全部' })).toBeNull();
    expect(snapshot.reviews.every((review) => review.resolutionStatus === 'open')).toBe(true);
  });
});

describe('App report-result rebuild', () => {
  const syntheticRebuildSource = { documentId: 'rebuild-document', personId: 'personal-person-1',
    sourceObjectId: '10000000-0000-4000-8000-000000000011', sha256: 'a'.repeat(64) };
  function rebuildSnapshot(): DashboardSnapshot {
    const snapshot = createPersonalSnapshot();
    snapshot.account = { ...snapshot.account, status: 'connected', displayLabel: 'masked@example.invalid' };
    snapshot.persons[0]!.documentCount = 1;
    snapshot.persons[0]!.acceptedFactCount = 8;
    snapshot.inbox = [{
      id: 'rebuild-document', displayName: '合成报告.pdf', discoveredAt: '2026-10-12T00:00:00.000Z',
      personId: snapshot.persons[0]!.id, personLabel: '测试成员', status: 'completed', format: 'PDF',
      sourceLabel: '手动导入', sentToAi: true, aiTransmissionStatus: 'completed', inProcessingCenter: false, issue: null
    }];
    snapshot.processingRebuildSources = [{ ...syntheticRebuildSource }];
    return snapshot;
  }

  async function openRebuild() {
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    fireEvent.click(await screen.findByRole('button', { name: /备份与恢复/ }));
    fireEvent.click(await screen.findByRole('button', { name: '按新流程重建报告结果' }));
    return screen.findByRole('dialog', { name: '按新流程重建报告结果' });
  }

  function confirmRebuild() {
    fireEvent.click(screen.getByRole('checkbox', { name: /我确认清理旧报告结果/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /我授权将上述报告/ }));
  }

  it('指定一位成员重建时明确显示范围，只提交该成员并重新确认清空和发送', async () => {
    const snapshot = rebuildSnapshot();
    const other = { ...snapshot.persons[0]!, id: 'rebuild-other-person', displayName: '另一位合成成员' };
    snapshot.persons.push(other);
    snapshot.inbox.push({ ...snapshot.inbox[0]!, id: 'other-document', personId: other.id, displayName: '另一位报告.pdf' });
    snapshot.processingRebuildSources!.push({ ...syntheticRebuildSource, documentId: 'other-document', personId: other.id,
      sourceObjectId: '10000000-0000-4000-8000-000000000012', sha256: 'b'.repeat(64) });
    const rebuildProcessing = vi.fn<HealthDesktopBridge['rebuildProcessing']>().mockResolvedValue({ ok: true, data: {
      rebuildId: '94087c50-f8bf-40fc-9b22-672dcff12013', batchId: '97c144da-e304-4cb9-afbd-df44773b9156',
      documentCount: 1, personCount: 1, recoveryPointCreated: true
    } });
    installBridge(snapshot, { rebuildProcessing }); render(<App />);
    const dialog = await openRebuild(); confirmRebuild();
    const submit = screen.getByRole('button', { name: '备份并开始重建' });
    expect(submit.hasAttribute('disabled')).toBe(false);
    fireEvent.change(screen.getByLabelText('重建范围'), { target: { value: other.id } });
    expect(submit.hasAttribute('disabled')).toBe(true);
    expect(dialog.textContent).toContain('本次范围：另一位合成成员 · 1 位成员 · 1 份报告');
    expect(dialog.textContent).toContain('其他成员的原件、结果、补充信息和计划都不会改变');
    expect(screen.getByLabelText('对应成员').querySelectorAll('option')).toHaveLength(2);
    fireEvent.click(screen.getByRole('checkbox', { name: '同时清空本人补充和全部计划，仅保留原件和成员' }));
    expect(dialog.textContent).toContain('只清理所选成员的本人补充信息');
    confirmRebuild(); fireEvent.click(submit);
    await waitFor(() => expect(rebuildProcessing).toHaveBeenCalledWith({ consentVersion: 1,
      confirmedRebuildReportResults: true, personIds: [other.id],
      expectedSources: snapshot.processingRebuildSources!.filter((source) => source.personId === other.id),
      clearPersonalData: true, confirmedClearPersonalData: true }));
  });

  it('完整说明保留、清理和发送范围，必须分别确认后才调用正常重建入口', async () => {
    const rebuildProcessing = vi.fn<HealthDesktopBridge['rebuildProcessing']>().mockResolvedValue({ ok: true, data: {
      rebuildId: '94087c50-f8bf-40fc-9b22-672dcff12013', batchId: '97c144da-e304-4cb9-afbd-df44773b9156',
      documentCount: 26, personCount: 1, recoveryPointCreated: true
    } });
    const processNow = vi.fn();
    installBridge(rebuildSnapshot(), { rebuildProcessing, processNow });
    render(<App />);
    const dialog = await openRebuild();
    expect(dialog.textContent).toContain('忽略、排除、已删除的报告及已归档成员不在本次范围内');
    expect(dialog.textContent).toContain('以前人工确认过的报告数值也会清理，只保留在恢复点中');
    expect(dialog.textContent).toContain('已经保存的个人行动计划');
    expect(dialog.textContent).toContain('敏感内容可能进入搜索服务');
    expect(dialog.querySelector('.rebuild-body')).toBeTruthy();
    const submit = screen.getByRole('button', { name: '备份并开始重建' });
    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /我确认清理旧报告结果/ }));
    expect(submit.hasAttribute('disabled')).toBe(true);
    expect(rebuildProcessing).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: /我授权将上述报告/ }));
    fireEvent.click(submit);
    await waitFor(() => expect(rebuildProcessing).toHaveBeenCalledWith({ consentVersion: 1, confirmedRebuildReportResults: true,
      expectedSources: [syntheticRebuildSource] }));
    expect(processNow).not.toHaveBeenCalled();
    expect(await screen.findByText(/开始为 1 位成员重建 26 份报告/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: '资料处理进度' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '按新流程重建报告结果' })).toBeNull();
  });

  it('备份校验失败保留确认页，显示原因而不进入处理中心', async () => {
    const rebuildProcessing = vi.fn<HealthDesktopBridge['rebuildProcessing']>().mockResolvedValue({ ok: false, error: {
      code: 'PROCESSING_REBUILD_BACKUP_CHANGED', messageKey: 'processing.rebuild_failed', retryable: true, correlationId: 'test'
    } });
    installBridge(rebuildSnapshot(), { rebuildProcessing });
    render(<App />);
    await openRebuild();
    confirmRebuild();
    fireEvent.click(screen.getByRole('button', { name: '备份并开始重建' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '恢复备份未通过校验，尚未清理旧结果。请稍后再试。');
    expect(screen.getByRole('dialog', { name: '按新流程重建报告结果' })).toBeTruthy();
    expect(rebuildProcessing).toHaveBeenCalledTimes(1);
  });

  it('本机空间不足显示释放空间与检查断点，不自动再次重建', async () => {
    const rebuildProcessing = vi.fn<HealthDesktopBridge['rebuildProcessing']>().mockResolvedValue({ ok: false, error: {
      code: 'LOCAL_STORAGE_FULL', messageKey: 'processing.rebuild_failed', retryable: false, correlationId: 'test'
    } });
    installBridge(rebuildSnapshot(), { rebuildProcessing }); render(<App />);
    await openRebuild(); confirmRebuild();
    fireEvent.click(screen.getByRole('button', { name: '备份并开始重建' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent',
      '本机磁盘空间不足，本次重建未能完成。请释放空间后，先查看处理中心和本机恢复点确认进度，再继续；无需重新上传原件。');
    expect(screen.getByRole('dialog', { name: '按新流程重建报告结果' })).toBeTruthy();
    expect(rebuildProcessing).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/模型暂时繁忙|稍后自动重试/)).toBeNull();
  });

  it('仅保留原件和成员必须显式选择，切换清空范围后重新确认才发送双强确认字段', async () => {
    const rebuildProcessing = vi.fn<HealthDesktopBridge['rebuildProcessing']>().mockResolvedValue({ ok: true, data: {
      rebuildId: '94087c50-f8bf-40fc-9b22-672dcff12013', batchId: '97c144da-e304-4cb9-afbd-df44773b9156',
      documentCount: 26, personCount: 1, recoveryPointCreated: true
    } });
    installBridge(rebuildSnapshot(), { rebuildProcessing }); render(<App />);
    const dialog = await openRebuild(); confirmRebuild();
    const submit = screen.getByRole('button', { name: '备份并开始重建' });
    expect(submit.hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name: '同时清空本人补充和全部计划，仅保留原件和成员' }));
    expect(submit.hasAttribute('disabled')).toBe(true);
    expect(dialog.textContent).toContain('只保留原始报告文件、成员资料和已确认的姓名别名');
    expect(dialog.textContent).toContain('所有个人计划，以及旧任务、发送回执和通知也会清空');
    expect(dialog.textContent).toContain('不使用本机 OCR 识别');
    expect(dialog.textContent).not.toContain('原始报告文件、成员资料、已确认的姓名别名、本人补充信息');
    fireEvent.click(screen.getByRole('checkbox', { name: /我确认清理旧报告结果、本人补充/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /我授权将上述报告发送/ }));
    fireEvent.click(submit);
    await waitFor(() => expect(rebuildProcessing).toHaveBeenCalledWith({ consentVersion: 1, confirmedRebuildReportResults: true,
      expectedSources: [syntheticRebuildSource], clearPersonalData: true, confirmedClearPersonalData: true }));
  });

  it('只有用户填写并确认的同人别名才加入重建授权，不预填或猜测报告姓名', async () => {
    const rebuildProcessing = vi.fn<HealthDesktopBridge['rebuildProcessing']>().mockResolvedValue({ ok: true, data: {
      rebuildId: '94087c50-f8bf-40fc-9b22-672dcff12013', batchId: '97c144da-e304-4cb9-afbd-df44773b9156',
      documentCount: 1, personCount: 1, recoveryPointCreated: true
    } });
    installBridge(rebuildSnapshot(), { rebuildProcessing });
    render(<App />);
    await openRebuild();
    const alias = screen.getByLabelText('报告里的昵称或曾用名') as HTMLInputElement;
    expect(alias.value).toBe('');
    expect((screen.getByLabelText('对应成员') as HTMLSelectElement).value).toBe('personal-person-1');
    fireEvent.change(alias, { target: { value: '  合成昵称  ' } });
    expect(screen.getByText(/提交即确认“合成昵称”与所选成员是同一人/)).toBeTruthy();
    confirmRebuild();
    fireEvent.click(screen.getByRole('button', { name: '备份并开始重建' }));
    await waitFor(() => expect(rebuildProcessing).toHaveBeenCalledWith({ consentVersion: 1, confirmedRebuildReportResults: true,
      expectedSources: [syntheticRebuildSource], confirmedPersonAliases: [{ personId: 'personal-person-1', reportedName: '合成昵称' }] }));
  });

  it.each(['running', 'queued', 'retry_wait'] as const)('有 %s 任务时，即使勾选确认也不能重建', async (status) => {
    const snapshot = rebuildSnapshot();
    snapshot.jobs = [{ ...createDemoSnapshot().jobs[0]!, status }];
    const rebuildProcessing = vi.fn();
    installBridge(snapshot, { rebuildProcessing });
    render(<App />);
    await openRebuild();
    confirmRebuild();
    expect(screen.getByText('有任务正在处理或等待开始，请先在处理中心停止这些任务。')).toBeTruthy();
    const submit = screen.getByRole('button', { name: '备份并开始重建' });
    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.click(submit);
    expect(rebuildProcessing).not.toHaveBeenCalled();
  });

  it('未连接 Codex 时不能提交，旧的等待确认任务不被误当作运行任务', async () => {
    const snapshot = rebuildSnapshot();
    snapshot.account.status = 'disconnected';
    snapshot.jobs = [{ ...createDemoSnapshot().jobs[0]!, status: 'waiting_user' }];
    const rebuildProcessing = vi.fn();
    installBridge(snapshot, { rebuildProcessing });
    render(<App />);
    await openRebuild();
    confirmRebuild();
    expect(screen.getByText('请先连接 Codex，再开始重建。')).toBeTruthy();
    expect(screen.queryByText('有任务正在处理或等待开始，请先在处理中心停止这些任务。')).toBeNull();
    expect(screen.getByRole('button', { name: '备份并开始重建' }).hasAttribute('disabled')).toBe(true);
    expect(rebuildProcessing).not.toHaveBeenCalled();
  });

  it('已连接且旧任务只是等待确认时，可以由正常重建事务结束旧任务并从头处理', async () => {
    const snapshot = rebuildSnapshot();
    snapshot.jobs = [{ ...createDemoSnapshot().jobs[0]!, status: 'waiting_user' }];
    installBridge(snapshot);
    render(<App />);
    await openRebuild();
    confirmRebuild();
    expect(screen.getByRole('button', { name: '备份并开始重建' }).hasAttribute('disabled')).toBe(false);
  });

  it('没有已归属的报告时不允许提交', async () => {
    const snapshot = rebuildSnapshot();
    snapshot.inbox[0]!.personId = null;
    snapshot.processingRebuildSources = [];
    const rebuildProcessing = vi.fn();
    installBridge(snapshot, { rebuildProcessing });
    render(<App />);
    await openRebuild();
    confirmRebuild();
    expect(screen.getByText('当前没有已归属的报告可重建。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '备份并开始重建' }).hasAttribute('disabled')).toBe(true);
    expect(rebuildProcessing).not.toHaveBeenCalled();
  });

  it('缺少主进程原件范围时不能由收件箱猜测发送范围，也不能提交', async () => {
    const snapshot = rebuildSnapshot();
    delete snapshot.processingRebuildSources;
    const rebuildProcessing = vi.fn();
    installBridge(snapshot, { rebuildProcessing }); render(<App />);
    await openRebuild(); confirmRebuild();
    expect(screen.getByText('当前报告范围未完成载入，请关闭此页并刷新工作区后再确认。')).toBeTruthy();
    const submit = screen.getByRole('button', { name: '备份并开始重建' });
    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.click(submit);
    expect(rebuildProcessing).not.toHaveBeenCalled();
  });

  it.each(['added', 'removed', 'person', 'source', 'hash', 'unavailable'] as const)(
    '确认后原件集合或身份变化时清除两项确认，不沿用旧授权：%s', async (change) => {
      const snapshot = rebuildSnapshot();
      let publishSnapshot!: (next: DashboardSnapshot) => void;
      const rebuildProcessing = vi.fn<HealthDesktopBridge['rebuildProcessing']>().mockResolvedValue({ ok: true, data: {
        rebuildId: '94087c50-f8bf-40fc-9b22-672dcff12013', batchId: '97c144da-e304-4cb9-afbd-df44773b9156',
        documentCount: 2, personCount: 1, recoveryPointCreated: true
      } });
      installBridge(snapshot, { rebuildProcessing,
        onSnapshotChanged: (listener) => { publishSnapshot = listener; return () => undefined; } });
      render(<App />);
      const dialog = await openRebuild(); confirmRebuild();
      const submit = within(dialog).getByRole('button', { name: '备份并开始重建' });
      expect(submit.hasAttribute('disabled')).toBe(false);
      const changed = structuredClone(snapshot);
      if (change === 'added') changed.processingRebuildSources!.push({ ...syntheticRebuildSource,
        documentId: 'new-document', sourceObjectId: '10000000-0000-4000-8000-000000000012', sha256: 'b'.repeat(64) });
      if (change === 'removed') changed.processingRebuildSources = [];
      if (change === 'person') changed.processingRebuildSources![0]!.personId = 'another-person';
      if (change === 'source') changed.processingRebuildSources![0]!.sourceObjectId = '10000000-0000-4000-8000-000000000012';
      if (change === 'hash') changed.processingRebuildSources![0]!.sha256 = 'b'.repeat(64);
      if (change === 'unavailable') delete changed.processingRebuildSources;
      act(() => publishSnapshot(changed));
      expect((within(dialog).getByRole('checkbox', { name: /我确认清理旧报告结果/ }) as HTMLInputElement).checked).toBe(false);
      expect((within(dialog).getByRole('checkbox', { name: /我授权将上述报告/ }) as HTMLInputElement).checked).toBe(false);
      expect(submit.hasAttribute('disabled')).toBe(true);
      fireEvent.click(submit); expect(rebuildProcessing).not.toHaveBeenCalled();
      if (change === 'added') {
        expect(dialog.textContent).toContain('本次范围：所有成员 · 1 位成员 · 2 份报告');
        confirmRebuild(); fireEvent.click(submit);
        await waitFor(() => expect(rebuildProcessing).toHaveBeenCalledExactlyOnceWith({ consentVersion: 1,
          confirmedRebuildReportResults: true, expectedSources: [...changed.processingRebuildSources!]
            .sort((first, second) => first.documentId.localeCompare(second.documentId)) }));
      }
    }
  );

  it('快照重发或原件顺序变化不撤销确认，选择单人时也不借别人的新增报告扩大范围', async () => {
    const snapshot = rebuildSnapshot();
    const other = { ...snapshot.persons[0]!, id: 'rebuild-other-person', displayName: '另一位合成成员' };
    snapshot.persons.push(other);
    snapshot.processingRebuildSources!.push({ ...syntheticRebuildSource, documentId: 'other-document', personId: other.id });
    let publishSnapshot!: (next: DashboardSnapshot) => void;
    const rebuildProcessing = vi.fn<HealthDesktopBridge['rebuildProcessing']>().mockResolvedValue({ ok: true, data: {
      rebuildId: '94087c50-f8bf-40fc-9b22-672dcff12013', batchId: '97c144da-e304-4cb9-afbd-df44773b9156',
      documentCount: 1, personCount: 1, recoveryPointCreated: true
    } });
    installBridge(snapshot, { rebuildProcessing,
      onSnapshotChanged: (listener) => { publishSnapshot = listener; return () => undefined; } });
    render(<App />);
    await openRebuild(); confirmRebuild();
    const reordered = structuredClone(snapshot); reordered.processingRebuildSources!.reverse();
    act(() => publishSnapshot(reordered));
    const clear = screen.getByRole('checkbox', { name: /我确认清理旧报告结果/ }) as HTMLInputElement;
    const send = screen.getByRole('checkbox', { name: /我授权将上述报告/ }) as HTMLInputElement;
    expect(clear.checked).toBe(true); expect(send.checked).toBe(true);
    fireEvent.change(screen.getByLabelText('重建范围'), { target: { value: snapshot.persons[0]!.id } });
    confirmRebuild();
    const expandedOther = structuredClone(reordered);
    expandedOther.processingRebuildSources!.push({ ...syntheticRebuildSource, documentId: 'other-new-document', personId: other.id });
    act(() => publishSnapshot(expandedOther));
    expect(clear.checked).toBe(true); expect(send.checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '备份并开始重建' }));
    await waitFor(() => expect(rebuildProcessing).toHaveBeenCalledExactlyOnceWith({ consentVersion: 1,
      confirmedRebuildReportResults: true, personIds: [snapshot.persons[0]!.id], expectedSources: [syntheticRebuildSource] }));
  });

  it('后端发现预览范围过期时撤回双确认，不自动重新提交', async () => {
    const rebuildProcessing = vi.fn<HealthDesktopBridge['rebuildProcessing']>().mockResolvedValue({ ok: false, error: {
      code: 'PROCESSING_REBUILD_SOURCE_SCOPE_CHANGED', messageKey: 'processing.rebuild_failed', retryable: false, correlationId: 'test'
    } });
    installBridge(rebuildSnapshot(), { rebuildProcessing }); render(<App />);
    await openRebuild(); confirmRebuild();
    fireEvent.click(screen.getByRole('button', { name: '备份并开始重建' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '报告范围或原文件发生变化，本次没有开始重建。请重新打开此页面确认。');
    expect((screen.getByRole('checkbox', { name: /我确认清理旧报告结果/ }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('checkbox', { name: /我授权将上述报告/ }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole('button', { name: '备份并开始重建' }).hasAttribute('disabled')).toBe(true);
    expect(rebuildProcessing).toHaveBeenCalledTimes(1);
  });

  it('演示工作区不能打开真实报告重建入口', async () => {
    const snapshot = createDemoSnapshot();
    const rebuildProcessing = vi.fn();
    installBridge(snapshot, { rebuildProcessing });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    fireEvent.click(await screen.findByRole('button', { name: /备份与恢复/ }));
    expect(screen.queryByRole('button', { name: '按新流程重建报告结果' })).toBeNull();
    expect(screen.getByText('请先建立或切换到个人工作区。')).toBeTruthy();
    expect(rebuildProcessing).not.toHaveBeenCalled();
  });

  it.each([
    { source: '旧版', reasons: ['metadata_date_evidence_not_proven', 'metadata_date_not_in_evidence', 'metadata_date_role_mismatch'],
      labels: ['日期引用无法核验', '日期与原报告不一致', '将签发等日期误作检查日期'] },
    { source: 'direct原始', reasons: ['report_metadata_date_evidence_unverified', 'report_metadata_date_role_unverified', 'report_metadata_date_conflict'],
      labels: ['日期引用无法核验', '日期的检查或签发用途尚未核验', '日期信息存在不同版本，尚未核验'] }
  ])('$source报告元数据的日期原因只显示在工作记录，不把可靠检查事实说成整份处理失败', async ({ reasons, labels }) => {
    const snapshot = rebuildSnapshot();
    snapshot.reviews = [{ id: 'metadata-limitation', personId: snapshot.persons[0]!.id, documentId: 'rebuild-document',
      kind: 'field_conflict', severity: 'warning', title: '报告日期尚未核验', description: '其他有来源事实已保存。',
      evidenceRefs: [], candidateOptions: [], candidateDiffs: [], reportedName: null,
      reasonCodes: reasons, resolutionStatus: 'open' }];
    const processNow = vi.fn();
    installBridge(snapshot, { processNow });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '处理中心' }));
    expect(screen.getByRole('heading', { name: '1 份资料的报告日期尚未核验' })).toBeTruthy();
    for (const label of labels) expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByText(/有可靠来源的检查结果已经保存/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /有部分项目未纳入本次结果/ })).toBeNull();
    expect(processNow).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '家庭总览' }));
    expect(screen.queryByRole('region', { name: '报告结果边界' })).toBeNull();
  });

  it('准备恢复点期间不可重复提交、按 Esc 或关闭确认页', async () => {
    let finish!: (value: Awaited<ReturnType<HealthDesktopBridge['rebuildProcessing']>>) => void;
    const rebuildProcessing = vi.fn(() => new Promise<Awaited<ReturnType<HealthDesktopBridge['rebuildProcessing']>>>((resolve) => { finish = resolve; }));
    installBridge(rebuildSnapshot(), { rebuildProcessing });
    render(<App />);
    const dialog = await openRebuild();
    confirmRebuild();
    const submit = screen.getByRole('button', { name: '备份并开始重建' });
    fireEvent.click(submit);
    expect(dialog.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('button', { name: '关闭重建确认' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(submit);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: '按新流程重建报告结果' })).toBeTruthy();
    expect(rebuildProcessing).toHaveBeenCalledTimes(1);
    finish({ ok: false, error: { code: 'PROCESSING_REBUILD_HAS_ACTIVE_JOB', messageKey: 'processing.rebuild_failed', retryable: false, correlationId: 'test' } });
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '有任务正在处理或等待开始。请先在处理中心停止这些任务，再重建。');
  });

  it('未收到后台回执时不声称数据未改变，也不允许立即重复提交', async () => {
    const rebuildProcessing = vi.fn<HealthDesktopBridge['rebuildProcessing']>().mockRejectedValue(new Error('disconnected'));
    installBridge(rebuildSnapshot(), { rebuildProcessing });
    render(<App />);
    await openRebuild();
    confirmRebuild();
    fireEvent.click(screen.getByRole('button', { name: '备份并开始重建' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '暂时未收到重建回执。请先查看处理中心，确认是否已开始，不要重复提交。');
    expect(screen.getByRole('button', { name: '备份并开始重建' }).hasAttribute('disabled')).toBe(true);
    expect(rebuildProcessing).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '关闭并查看处理中心' }));
    expect(screen.getByRole('heading', { name: '资料处理进度' })).toBeTruthy();
  });
});

describe('App member display editing', () => {
  it('采纳事项可取消或保存个人日程，原建议时间和来源不被覆盖', async () => {
    const snapshot = createPersonalSnapshot();
    const action = { id: 'schedule-action', personId: snapshot.persons[0]!.id, title: '复查甲状腺功能', detail: '按原报告安排复查。',
      origin: 'clinician_document' as const, status: 'planned' as const, dueDate: null, dueText: '3个月后', userScheduleText: null,
      evidenceLabel: '合成医嘱 · 2026-08-28', userRevision: 1, updatedAt: '2026-10-10T00:00:00Z', evidenceRefs: [{
        id: 'plan-source', kind: 'observation' as const, observationId: 'fact', eventId: 'event', documentId: 'source-doc', sourceSpanId: 'source-span', knowledgeId: null,
        label: '门诊医嘱', locator: '第1页', quote: '医生建议：3个月后复查甲状腺功能。'
      }] };
    snapshot.actions = [action];
    const updateActionSchedule = vi.fn<HealthDesktopBridge['updateActionSchedule']>().mockImplementation(async (input) => ({ ok: true, data: {
      ...action, dueDate: input.dueDate, userScheduleText: input.userScheduleText, userRevision: 2
    } }));
    const getEvidence = vi.fn<HealthDesktopBridge['getEvidence']>().mockResolvedValue({ ok: false, error: { code: 'UNAVAILABLE', messageKey: 'test', retryable: false, correlationId: 'test' } });
    installBridge(snapshot, { updateActionSchedule, getEvidence });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '后续事项' }));
    fireEvent.click(screen.getByRole('button', { name: '安排时间：复查甲状腺功能' }));
    let dialog = screen.getByRole('dialog', { name: '安排时间' });
    fireEvent.change(within(dialog).getByLabelText('我设定的日期（可选）'), { target: { value: '2026-11-28' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(updateActionSchedule).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '安排时间：复查甲状腺功能' }));
    dialog = screen.getByRole('dialog', { name: '安排时间' });
    expect((within(dialog).getByLabelText('我设定的日期（可选）') as HTMLInputElement).value).toBe('');
    fireEvent.change(within(dialog).getByLabelText('我设定的日期（可选）'), { target: { value: '2026-11-28' } });
    fireEvent.change(within(dialog).getByLabelText('我的时间说明（可选）'), { target: { value: '上午已预约' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存我的安排' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '安排时间' })).toBeNull());
    expect(updateActionSchedule).toHaveBeenCalledWith({ personId: action.personId, actionId: action.id, dueDate: '2026-11-28', userScheduleText: '上午已预约', expectedRevision: 1 });
    expect(screen.getByText('我的安排：2026-11-28 · 上午已预约')).toBeTruthy();
    expect(screen.getByText('原建议时间：3个月后')).toBeTruthy();
    const planning = screen.getByText('我的安排：2026-11-28 · 上午已预约').parentElement!;
    expect(planning.className).toBe('action-row__planning');
    expect([...planning.children].map((child) => child.tagName)).toEqual(['P', 'P', 'P']);
    expect([...planning.children].map((child) => child.textContent)).toEqual([
      '我的安排：2026-11-28 · 上午已预约', '原建议时间：3个月后', '合成医嘱 · 2026-08-28'
    ]);
    fireEvent.click(screen.getByRole('button', { name: '门诊医嘱 · 第1页' }));
    expect(getEvidence).toHaveBeenCalledWith({ sourceSpanId: 'source-span' });
    expect(action.dueText).toBe('3个月后');
  });

  it('医生安排没有原时间要求时，个人安排、报告来源和安排按钮仍各自独立成行', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.actions = [{
      id: 'separate-plan-lines', personId: snapshot.persons[0]!.id, title: '报告中的医生建议',
      detail: '由家长陪同到眼科进一步检查。', origin: 'clinician_document', status: 'planned',
      dueDate: '2026-10-15', userScheduleText: '家长陪同；以预约时间为准', dueText: null,
      evidenceLabel: '2026-09-12 · 合成眼科报告 · 报告中的医生建议', userRevision: 2,
      updatedAt: '2026-10-10T00:00:00Z'
    }];
    installBridge(snapshot);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '后续事项' }));
    const schedule = screen.getByText('我的安排：2026-10-15 · 家长陪同；以预约时间为准');
    const source = screen.getByText('2026-09-12 · 合成眼科报告 · 报告中的医生建议');
    const planning = schedule.parentElement!;
    expect(schedule.tagName).toBe('P');
    expect(source.tagName).toBe('P');
    expect(source.parentElement).toBe(planning);
    expect(planning.className).toBe('action-row__planning');
    expect([...planning.children]).toEqual([schedule, source]);
    const button = screen.getByRole('button', { name: '安排时间：报告中的医生建议' });
    expect(button.parentElement?.className).toBe('action-row__controls');
    expect(planning.nextElementSibling).toBe(button.parentElement);
    expect(planning.contains(button)).toBe(false);
    fireEvent.click(button);
    expect(screen.getByRole('dialog', { name: '安排时间' })).toBeTruthy();
  });

  it('日程冲突保存失败仍保留编辑内容和原建议，允许关闭后重试', async () => {
    const snapshot = createPersonalSnapshot();
    const action = { id: 'schedule-conflict', personId: snapshot.persons[0]!.id, title: '安排复诊', detail: '', origin: 'ai_proposed' as const,
      status: 'planned' as const, dueDate: null, dueText: '近期', evidenceLabel: null, userRevision: 1, updatedAt: '2026-10-10T00:00:00Z' };
    snapshot.actions = [action];
    installBridge(snapshot, { updateActionSchedule: vi.fn().mockResolvedValue({ ok: false, error: { code: 'REVISION_CONFLICT', messageKey: 'test', retryable: true, correlationId: 'test' } }) });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '后续事项' }));
    fireEvent.click(screen.getByRole('button', { name: '安排时间：安排复诊' }));
    const dialog = screen.getByRole('dialog', { name: '安排时间' });
    fireEvent.change(within(dialog).getByLabelText('我的时间说明（可选）'), { target: { value: '下周一' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存我的安排' }));
    expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', '这次安排没有保存。事项可能已更新，请关闭后重新打开再试。');
    expect((within(dialog).getByLabelText('我的时间说明（可选）') as HTMLInputElement).value).toBe('下周一');
  });

  it.each([
    { label: '只改日期', date: '2026-10-19', text: '每周一晚饭后' },
    { label: '只改文字', date: '2026-10-12', text: '周末上午回顾' },
    { label: '清空', date: '', text: '' }
  ])('旧采纳安排预填完整，$label后只保存用户选择的日期与说明', async ({ date, text }) => {
    const snapshot = createPersonalSnapshot();
    const action = { id: 'legacy-schedule', personId: snapshot.persons[0]!.id, title: '饭后散步', detail: '先从楼下走一圈。',
      origin: 'ai_proposed' as const, status: 'planned' as const, dueDate: '2026-10-12', dueText: '由我决定开始时间',
      userScheduleText: '每周一晚饭后', evidenceLabel: null, userRevision: 4, updatedAt: '2026-10-10T00:00:00Z' };
    snapshot.actions = [action];
    const updateActionSchedule = vi.fn<HealthDesktopBridge['updateActionSchedule']>().mockImplementation(async (input) => ({
      ok: true, data: { ...action, dueDate: input.dueDate, userScheduleText: input.userScheduleText, userRevision: 5 }
    }));
    installBridge(snapshot, { updateActionSchedule });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '后续事项' }));
    fireEvent.click(screen.getByRole('button', { name: '安排时间：饭后散步' }));
    const dialog = screen.getByRole('dialog', { name: '安排时间' });
    const dateInput = within(dialog).getByLabelText('我设定的日期（可选）') as HTMLInputElement;
    const textInput = within(dialog).getByLabelText('我的时间说明（可选）') as HTMLInputElement;
    expect(dateInput.value).toBe('2026-10-12');
    expect(textInput.value).toBe('每周一晚饭后');
    expect(within(dialog).getByText(/可以填写行动日或回顾日/)).toBeTruthy();
    fireEvent.change(dateInput, { target: { value: date } });
    fireEvent.change(textInput, { target: { value: text } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存我的安排' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '安排时间' })).toBeNull());
    expect(updateActionSchedule).toHaveBeenCalledWith({ personId: action.personId, actionId: action.id,
      dueDate: date || null, userScheduleText: text || null, expectedRevision: 4 });
    if (!date && !text) expect(screen.getByText('我的安排：尚未设置时间')).toBeTruthy();
  });

  it('旧180字安排可只改日期，201字在界面拒绝且原文字不被截断', async () => {
    const snapshot = createPersonalSnapshot();
    const originalText = '安排'.repeat(90);
    const action = { id: 'legacy-long-schedule', personId: snapshot.persons[0]!.id, title: '旧计划', detail: '保留原有做法。',
      origin: 'ai_proposed' as const, status: 'planned' as const, dueDate: '2026-10-12', dueText: '由我决定开始时间',
      userScheduleText: originalText, evidenceLabel: null, userRevision: 1, updatedAt: '2026-10-10T00:00:00Z' };
    snapshot.actions = [action];
    const updateActionSchedule = vi.fn<HealthDesktopBridge['updateActionSchedule']>().mockImplementation(async (input) => ({
      ok: true, data: { ...action, dueDate: input.dueDate, userScheduleText: input.userScheduleText, userRevision: 2 }
    }));
    installBridge(snapshot, { updateActionSchedule });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '后续事项' }));
    fireEvent.click(screen.getByRole('button', { name: '安排时间：旧计划' }));
    const dialog = screen.getByRole('dialog', { name: '安排时间' });
    const textInput = within(dialog).getByLabelText('我的时间说明（可选）') as HTMLInputElement;
    const saveButton = within(dialog).getByRole('button', { name: '保存我的安排' }) as HTMLButtonElement;
    expect(textInput.value).toBe(originalText);
    expect(textInput.maxLength).toBe(200);
    fireEvent.change(textInput, { target: { value: '长'.repeat(201) } });
    expect(saveButton.disabled).toBe(true);
    expect(within(dialog).getByRole('alert').textContent).toContain('时间说明不要超过 200 字');
    expect(updateActionSchedule).not.toHaveBeenCalled();
    fireEvent.change(textInput, { target: { value: originalText } });
    fireEvent.change(within(dialog).getByLabelText('我设定的日期（可选）'), { target: { value: '2026-10-19' } });
    expect(saveButton.disabled).toBe(false);
    fireEvent.click(saveButton);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '安排时间' })).toBeNull());
    expect(updateActionSchedule).toHaveBeenCalledWith({ personId: action.personId, actionId: action.id,
      dueDate: '2026-10-19', userScheduleText: originalText, expectedRevision: 1 });
  });

  it('最近完成按真实完成时间排列并标明家人，不用更新时间冒充完成日', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.persons.push({ ...snapshot.persons[0]!, id: 'personal-person-2', displayName: '另一位家人' });
    const base = { title: '复查血脂', detail: '', origin: 'user_created' as const, status: 'completed' as const,
      dueDate: null, dueText: null, evidenceLabel: null, userRevision: 1, updatedAt: '2099-01-01T00:00:00Z' };
    snapshot.actions = [
      { ...base, id: 'unknown-completion', personId: snapshot.persons[0]!.id },
      { ...base, id: 'older-completion', personId: snapshot.persons[0]!.id, completedAt: '2026-10-01T00:00:00Z' },
      { ...base, id: 'latest-completion', personId: snapshot.persons[1]!.id, completedAt: '2026-10-09T00:00:00Z' }
    ];
    installBridge(snapshot);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '后续事项' }));
    const rows = document.querySelectorAll('.completed-panel .completed-item');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain('另一位家人 · 完成于');
    expect(rows[1]!.textContent).toContain('测试成员 · 完成于');
    expect(rows[2]!.textContent).toContain('测试成员');
    expect(rows[2]!.textContent).not.toContain('完成于');
    expect(document.querySelector('.completed-panel')!.textContent).not.toContain('2099');
  });

  it('补充健康问题只预填问题，答案由本人填写并保存到正确成员，不自动发起分析', async () => {
    const snapshot = createPersonalSnapshot();
    const person = snapshot.persons[0]!;
    const question = '最近有没有新的检查结果？';
    const assessment = { id: 'question-snapshot', status: 'current', systems: [], claims: [], actions: [],
      questions: [{ id: 'question-followup', question, whyItMatters: '较新的结果会影响对目前情况的理解。' }],
      evidenceCatalog: [], knowledgeSources: [] } as unknown as MemberAssessmentSnapshotV3;
    const createManualNote = vi.fn<HealthDesktopBridge['createManualNote']>().mockImplementation(async (input) => ({
      ok: true, data: { id: 'manual-answer', personId: input.personId, kind: input.kind,
        immutableText: input.immutableText, effectiveDate: input.effectiveDate, structuredFields: input.structuredFields,
        sourceKind: 'user_reported', revision: 1, recordedAt: '2026-10-10T00:00:00Z' }
    }));
    const processNow = vi.fn();
    installBridge(snapshot, {
      getMemberAssessment: async () => ({ ok: true, data: assessment }),
      getMemberOverview: async () => ({ ok: true, data: { personId: person.id, generatedAt: '2026-10-10T00:00:00Z',
        dataQuality: 'partial', headline: '健康概况', overview: '请结合检查条件理解报告。', latestClinicalDate: null,
        acceptedFactCount: 0, unclassifiedFactCount: 0, eventCount: 0, sourceUrgentNotices: [], currentSymptomNotices: [],
        attentionSystemIds: [], systems: [], priorityIssues: [], importantChanges: [], recentChanges: [], nextActions: [] } }),
      listBodySystems: async () => ({ ok: true, data: [] }),
      listHealthEvents: async () => ({ ok: true, data: [] }),
      getLifestylePlan: async () => ({ ok: true, data: { personId: person.id, status: 'unavailable', dataQuality: 'insufficient',
        updatedAt: null, priorities: [], proposals: [], adoptedActions: [] } }),
      getConceptReview: async () => ({ ok: true, data: { personId: person.id, dictionaryVersion: 'synthetic', catalog: [], items: [] } }),
      createManualNote,
      processNow
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '成员档案' }));
    await screen.findByRole('heading', { name: '健康概况' });
    fireEvent.click(screen.getByRole('tab', { name: '日常生活' }));
    fireEvent.click(screen.getByRole('button', { name: `补充这项信息：${question}` }));
    const dialog = await screen.findByRole('dialog', { name: '手动补充健康信息' });
    const answer = within(dialog).getByRole('textbox', { name: '你的回答' }) as HTMLTextAreaElement;
    expect(within(dialog).getByText(question)).toBeTruthy();
    expect(answer.value).toBe('');
    expect((within(dialog).getByRole('combobox', { name: '家庭成员' }) as HTMLSelectElement).disabled).toBe(true);
    expect((within(dialog).getByRole('combobox', { name: '资料类型' }) as HTMLSelectElement).value).toBe('free_text');
    expect((within(dialog).getByRole('button', { name: '保存到本机' }) as HTMLButtonElement).disabled).toBe(true);
    expect(createManualNote).not.toHaveBeenCalled();
    fireEvent.change(answer, { target: { value: '最近没有新增报告，不确定下次复查日期。' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存到本机' }));
    await waitFor(() => expect(createManualNote).toHaveBeenCalledExactlyOnceWith({
      personId: person.id, kind: 'free_text', immutableText: `补充问题：${question}\n本人回答：最近没有新增报告，不确定下次复查日期。`,
      effectiveDate: null, structuredFields: { questionId: 'question-followup', assessmentSnapshotId: 'question-snapshot' },
      expectedContextRevision: person.clinicalContextRevision
    }));
    expect(processNow).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '手动补充健康信息' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '手动补充' }));
    const blankDialog = await screen.findByRole('dialog', { name: '手动补充健康信息' });
    expect(within(blankDialog).queryByText(question)).toBeNull();
    expect((within(blankDialog).getByRole('textbox', { name: '你要记录的原文' }) as HTMLTextAreaElement).value).toBe('');
    expect((within(blankDialog).getByRole('combobox', { name: '家庭成员' }) as HTMLSelectElement).disabled).toBe(false);
  });

  it('身份问题留在处理记录，不在首页和成员阅读中要求再次确认', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.persons.push({ ...snapshot.persons[0]!, id: 'personal-person-2', displayName: '另一位家人' });
    snapshot.reviews = snapshot.persons.map((person, index) => ({
      id: `identity-${index}`, personId: person.id, documentId: `document-${index}`,
      kind: 'person_conflict', severity: 'blocking', title: '确认报告属于谁',
      description: '旧流程要求再次确认。', evidenceRefs: [], candidateOptions: [],
      candidateDiffs: [], reportedName: '合成报告姓名', reasonCodes: [], resolutionStatus: 'open'
    }));
    const resolveReview = vi.fn<HealthDesktopBridge['resolveReview']>();
    installBridge(snapshot, { resolveReview });
    render(<App />);
    await screen.findByText('测试成员');
    expect(screen.queryByRole('button', { name: '查看需要确认的资料' })).toBeNull();
    expect(screen.getByRole('button', { name: '查看处理通知与任务' }).querySelector('i')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '成员档案' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '处理中心' }));
    const notes = screen.getByRole('region', { name: '资料处理说明' });
    expect(within(notes).getAllByText(/身份信息与当前成员尚未可靠对应/)).toHaveLength(2);
    expect(notes.textContent).toContain('其他资料继续整理');
    expect(screen.queryByText('旧流程要求再次确认。')).toBeNull();
    expect(resolveReview).not.toHaveBeenCalled();
  });

  it('普通未读清资料显示结果边界，不强迫用户确认，也不隐藏零接纳的报告', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.inbox = [{ id: 'unresolved-report', displayName: '合成未读清报告.txt', personId: snapshot.persons[0]!.id,
      personLabel: '测试成员', discoveredAt: '2026-09-18T00:00:00Z', status: 'needs_review', format: '纯文本',
      sourceLabel: '手动导入', sentToAi: true, aiTransmissionStatus: 'completed', inProcessingCenter: true, issue: null }];
    snapshot.reviews = [{ id: 'unresolved-content', personId: snapshot.persons[0]!.id, documentId: 'unresolved-report',
      kind: 'field_conflict', severity: 'blocking', title: '部分内容尚未读清', description: '没有可靠对应的结果，未作为正常结果。',
      evidenceRefs: [], candidateOptions: [], candidateDiffs: [], reportedName: null,
      reasonCodes: ['SOURCE_BINDING_UNRESOLVED'], resolutionStatus: 'open' }];
    snapshot.openReviewCount = 1;
    installBridge(snapshot);
    render(<App />);
    await screen.findByText('测试成员');
    expect(screen.queryByRole('button', { name: '查看需要确认的资料' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '处理中心' }));
    const boundary = await screen.findByRole('region', { name: '报告结果边界' });
    expect(within(boundary).getByText('合成未读清报告.txt')).toBeTruthy();
    expect(within(boundary).getByRole('button', { name: '查看合成未读清报告.txt的依据' })).toBeTruthy();
    expect(within(boundary).queryByRole('button', { name: /重新核对/ })).toBeNull();
    expect(screen.queryByText('需要你的确认')).toBeNull();
  });

  it.each([
    { status: 'failed' as const, canRetry: false, expected: false },
    { status: 'failed' as const, canRetry: true, expected: true },
    { status: 'completed_with_issues' as const, canRetry: true, expected: false },
    { status: 'waiting_auth' as const, canRetry: false, expected: true }
  ])('通知只提醒当前需要处理的任务：$status / 可重试 $canRetry', async ({ status, canRetry, expected }) => {
    const snapshot = createPersonalSnapshot();
    snapshot.jobs = [{ ...createDemoSnapshot().jobs[0]!, status, canRetry, canCancel: false }];
    installBridge(snapshot);
    render(<App />);
    await screen.findByText('测试成员');
    expect(screen.getByRole('button', { name: '查看处理通知与任务' }).querySelector('i') !== null).toBe(expected);
  });

  it('后续事项只整理 AI 标题，已投影的行动条件和本人填写内容仍保留', async () => {
    const snapshot = createPersonalSnapshot();
    const title = '经模型核对，继续记录血压。';
    const userDetail = '我的备注：模型复核前我已经预约；未散瞳，不能据此确认屈光状态。';
    const action = { id: 'old-ai-action', personId: snapshot.persons[0]!.id, title,
      detail: userDetail, origin: 'ai_proposed' as const, status: 'planned' as const,
      dueDate: null, dueText: '本人约定：等模型复核后再讨论', evidenceLabel: null, userRevision: 1,
      updatedAt: '2026-09-18T00:00:00Z' };
    snapshot.actions = [action, { ...action, id: 'my-action', title: '本人安排：模型复核后再联系医生', origin: 'user_created' }];
    installBridge(snapshot);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '后续事项' }));
    expect(screen.getByText('继续记录血压。')).toBeTruthy();
    expect(screen.getByText('本人安排：模型复核后再联系医生')).toBeTruthy();
    expect(screen.getAllByText(userDetail)).toHaveLength(2);
    expect(screen.getAllByText(/本人约定：等模型复核后再讨论/)).toHaveLength(2);
    expect(screen.queryByText(title)).toBeNull();
    expect(action.title).toBe(title);
  });

  it('切换主页面后从顶部开始，同页重复点击不改变阅读位置', async () => {
    installBridge(createPersonalSnapshot());
    render(<App />);
    const contentArea = screen.getByRole('main');
    const processing = await screen.findByRole('button', { name: '处理中心' });
    contentArea.scrollTop = 400;
    fireEvent.click(processing);
    expect(contentArea.scrollTop).toBe(0);
    contentArea.scrollTop = 200;
    fireEvent.click(processing);
    expect(contentArea.scrollTop).toBe(200);
    fireEvent.click(screen.getByRole('button', { name: '报告收件箱' }));
    expect(contentArea.scrollTop).toBe(0);
  });

  it('资料已处理但综合失败时，任务详情不把资料数量显示成整体完成百分比', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.jobs = [{
      ...createDemoSnapshot().jobs[0]!, stage: 'analyze', status: 'failed', statusText: '处理失败',
      completedUnits: 6, totalUnits: 6, canCancel: false, canRetry: true
    }];
    installBridge(snapshot);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '处理中心' }));
    fireEvent.click(screen.getByRole('button', { name: '查看详情' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('已处理资料')).toBeTruthy();
    expect(within(dialog).getByText('6/6 份')).toBeTruthy();
    expect(within(dialog).getByText('处理失败')).toBeTruthy();
    expect(within(dialog).queryByText(/100%/)).toBeNull();
  });

  it.each([
    { status: 'published' as const, reasonCode: null, label: '本任务已发布综合解读' },
    { status: 'rejected' as const, reasonCode: 'validation_failed' as const, label: '综合解读未更新' },
    { status: 'skipped_no_data' as const, reasonCode: 'no_accepted_facts' as const, label: '尚无可用于综合解读的资料' },
    { status: 'reused_current' as const, reasonCode: null, label: '本任务已复用匹配的综合解读' }
  ])('报告完成数与综合$status分开显示，详情不把历史发布冒充当前最新', async ({ status, reasonCode, label }) => {
    const snapshot = createPersonalSnapshot();
    snapshot.jobs = [{ ...createDemoSnapshot().jobs[0]!, stage: 'publish', status: 'completed_with_issues',
      completedUnits: 1, totalUnits: 1, canCancel: false, canRetry: true,
      assessmentOutcome: { status, reasonCode, attemptId: 'synthetic-assessment-attempt',
        snapshotId: status === 'published' || status === 'reused_current' ? 'synthetic-assessment-snapshot' : null,
        inputSignature: 'a'.repeat(64), factRevision: 3, contextRevision: 1,
        reviewScopeSignature: 'b'.repeat(64), updatedAt: '2026-01-02T00:00:00.000Z' } }];
    const processNow = vi.fn();
    const retryJob = vi.fn();
    installBridge(snapshot, { processNow, retryJob });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '处理中心' }));
    expect(within(screen.getByRole('region', { name: '本次成员综合结果' })).getByText(label)).toBeTruthy();
    if (status === 'published' || status === 'reused_current') {
      expect(screen.getByText('健康看板已更新').className).toContain('badge--success');
      expect(screen.queryByText('部分完成')).toBeNull();
    }
    fireEvent.click(screen.getByRole('button', { name: '查看详情' }));
    const dialog = await screen.findByRole('dialog');
    const result = within(dialog).getByRole('region', { name: '本次成员综合结果' });
    expect(within(result).getByText(label)).toBeTruthy();
    expect(within(dialog).getByText('1/1 份')).toBeTruthy();
    if (status === 'published' || status === 'reused_current') {
      expect(within(result).getByText(/对应本任务处理时的资料范围/)).toBeTruthy();
      expect(within(result).queryByText(/当前最新/)).toBeNull();
    } else if (status === 'rejected') {
      expect(within(result).getByText(/未通过依据校验/)).toBeTruthy();
      expect(within(result).queryByText(/网络|繁忙|等待连接/)).toBeNull();
    }
    expect(within(result).queryByText('synthetic-assessment-attempt')).toBeNull();
    expect(within(result).queryByText('a'.repeat(64))).toBeNull();
    expect(processNow).not.toHaveBeenCalled();
    expect(retryJob).not.toHaveBeenCalled();
  });

  it('真实发送范围暂停不冒充内容已整理，也不触发新的处理', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.jobs = [{ ...createDemoSnapshot().jobs[0]!, stage: 'extract', status: 'waiting_user',
      completedUnits: 1, totalUnits: 2, statusText: '当前发送范围不可用，原件和已有结果已保存',
      canCancel: true, canRetry: false, assessmentOutcome: { status: 'published', reasonCode: null,
        snapshotId: 'synthetic-old-snapshot', inputSignature: 'a'.repeat(64), factRevision: 1, contextRevision: 0,
        reviewScopeSignature: 'b'.repeat(64), attemptId: 'synthetic-old-attempt', updatedAt: '2026-01-01T00:00:00Z' } }];
    const processNow = vi.fn();
    const retryJob = vi.fn();
    installBridge(snapshot, { processNow, retryJob });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '处理中心' }));
    expect(screen.getByText('发送范围暂不可用').className).toContain('badge--warning');
    expect(screen.queryByText('已整理，部分内容未纳入')).toBeNull();
    expect(screen.queryByRole('region', { name: '本次成员综合结果' })).toBeNull();
    expect(screen.queryByRole('button', { name: /批准|确认|重试/ })).toBeNull();
    expect(processNow).not.toHaveBeenCalled();
    expect(retryJob).not.toHaveBeenCalled();
  });

  it('旧任务缺独立综合回执时，不从publish阶段和完成份数猜测成功', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.jobs = [{ ...createDemoSnapshot().jobs[0]!, stage: 'publish', status: 'completed_with_issues',
      completedUnits: 2, totalUnits: 2, assessmentOutcome: undefined }];
    installBridge(snapshot);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '处理中心' }));
    expect(screen.queryByRole('region', { name: '本次成员综合结果' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看详情' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('2/2 份')).toBeTruthy();
    expect(within(dialog).queryByRole('region', { name: '本次成员综合结果' })).toBeNull();
  });

  it('清理说明明确最小完成凭据保留但会话和详细用量清除，查看不会自动清理', async () => {
    const cleanupExpiredData = vi.fn();
    installBridge(createPersonalSnapshot(), { cleanupExpiredData });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    fireEvent.click(screen.getByRole('button', { name: '查看数据处理说明' }));
    const dialog = await screen.findByRole('dialog', { name: '哪些留在本机，哪些会发送' });
    expect(within(dialog).getByText(/最小完成凭据会保留，但不含会话编号、模型配置和详细调用用量/)).toBeTruthy();
    expect(within(dialog).getByText(/选择成员后上传资料，即启动本次自动整理/)).toBeTruthy();
    expect(dialog.textContent).not.toContain('只有手动确认');
    expect(within(dialog).getByRole('button', { name: '清理临时资料' }).hasAttribute('disabled')).toBe(true);
    expect(cleanupExpiredData).not.toHaveBeenCalled();
  });

  it('等待中的任务不显示残留旧综合终态，回执后打开的详情实时显示安全失败原因', async () => {
    const snapshot = createPersonalSnapshot();
    const oldOutcome = { status: 'published' as const, reasonCode: null,
      attemptId: 'synthetic-old-attempt', snapshotId: 'synthetic-old-snapshot', inputSignature: 'a'.repeat(64),
      factRevision: 2, contextRevision: 1, reviewScopeSignature: 'b'.repeat(64), updatedAt: '2026-01-01T00:00:00.000Z' };
    const initial = { ...createDemoSnapshot().jobs[0]!, status: 'running' as const,
      stage: 'analyze' as const, completedUnits: 2, totalUnits: 2, assessmentOutcome: oldOutcome };
    snapshot.jobs = [initial];
    let emitSnapshot!: (next: DashboardSnapshot) => void;
    const processNow = vi.fn();
    const retryJob = vi.fn();
    installBridge(snapshot, { processNow, retryJob, onSnapshotChanged: (listener) => {
      emitSnapshot = listener;
      return () => undefined;
    } });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /^处理中心/ }));
    expect(screen.queryByRole('region', { name: '本次成员综合结果' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看详情' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('region', { name: '本次成员综合结果' })).toBeNull();
    act(() => emitSnapshot({ ...snapshot, jobs: [{ ...initial, status: 'completed_with_issues',
      assessmentOutcome: { ...oldOutcome, status: 'rejected', reasonCode: 'schema_invalid',
        snapshotId: null, attemptId: 'synthetic-new-attempt' } }] }));
    const result = within(dialog).getByRole('region', { name: '本次成员综合结果' });
    expect(within(result).getByText('综合解读未更新')).toBeTruthy();
    expect(within(result).getByText(/返回格式未通过检查/)).toBeTruthy();
    expect(within(result).queryByText(/已发布|最新结果/)).toBeNull();
    expect(processNow).not.toHaveBeenCalled();
    expect(retryJob).not.toHaveBeenCalled();
  });

  it('打开的任务详情随快照更新阶段、份数、时间和失败状态，不触发处理操作', async () => {
    const snapshot = createPersonalSnapshot();
    const initial = { ...createDemoSnapshot().jobs[0]!, stage: 'extract' as const,
      status: 'running' as const, statusText: '正在读取报告', completedUnits: 0, totalUnits: 25,
      updatedAt: '2026-01-01T00:01:00Z' };
    snapshot.jobs = [initial];
    let emitSnapshot!: (next: DashboardSnapshot) => void;
    const processNow = vi.fn();
    const retryJob = vi.fn();
    const cancelJob = vi.fn();
    installBridge(snapshot, { onSnapshotChanged: (listener) => {
      emitSnapshot = listener;
      return () => undefined;
    }, processNow, retryJob, cancelJob });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /^处理中心/ }));
    fireEvent.click(screen.getByRole('button', { name: '查看详情' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('正在读取报告')).toBeTruthy();
    expect(within(dialog).getByText('0/25 份')).toBeTruthy();
    const originalTime = within(dialog).getByText('最近更新').nextElementSibling!.textContent;

    const updated = { ...initial, stage: 'review_facts' as const, statusText: '正在核对报告结果',
      completedUnits: 3, updatedAt: '2026-01-02T00:02:00Z' };
    act(() => emitSnapshot({ ...snapshot, jobs: [updated] }));
    expect(within(dialog).getByText('核对报告结果')).toBeTruthy();
    expect(within(dialog).getByText('正在核对报告结果')).toBeTruthy();
    expect(within(dialog).getByText('3/25 份')).toBeTruthy();
    expect(within(dialog).getByText('最近更新').nextElementSibling!.textContent).not.toBe(originalTime);
    const progressTime = within(dialog).getByText('最近更新').nextElementSibling!.textContent;
    expect(within(dialog).queryByText('正在读取报告')).toBeNull();

    act(() => emitSnapshot({ ...snapshot, jobs: [{ ...updated, status: 'failed',
      statusText: '本次读取未完成，已有报告结果会保留', canCancel: false, canRetry: true,
      updatedAt: '2026-01-03T00:03:00Z' }] }));
    expect(within(dialog).getByText('本次读取未完成，已有报告结果会保留')).toBeTruthy();
    expect(within(dialog).queryByText('正在核对报告结果')).toBeNull();
    expect(within(dialog).getByText('最近更新').nextElementSibling!.textContent).not.toBe(progressTime);
    expect(processNow).not.toHaveBeenCalled();
    expect(retryJob).not.toHaveBeenCalled();
    expect(cancelJob).not.toHaveBeenCalled();
  });

  it('所选任务从快照消失后关闭详情，同 ID 再出现也不恢复旧选择', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.jobs = [{ ...createDemoSnapshot().jobs[0]!, statusText: '合成旧任务正在处理' }];
    let emitSnapshot!: (next: DashboardSnapshot) => void;
    installBridge(snapshot, { onSnapshotChanged: (listener) => {
      emitSnapshot = listener;
      return () => undefined;
    } });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /^处理中心/ }));
    fireEvent.click(screen.getByRole('button', { name: '查看详情' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    act(() => emitSnapshot({ ...snapshot, jobs: [] }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('合成旧任务正在处理')).toBeNull();
    act(() => emitSnapshot(snapshot));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each(['mode', 'name'] as const)('工作区 $0 改变后不显示同 ID 的其他工作区任务，也不恢复旧详情', async (change) => {
    const snapshot = createPersonalSnapshot();
    snapshot.jobs = [{ ...createDemoSnapshot().jobs[0]!, statusText: '合成个人工作区任务' }];
    let emitSnapshot!: (next: DashboardSnapshot) => void;
    installBridge(snapshot, { onSnapshotChanged: (listener) => {
      emitSnapshot = listener;
      return () => undefined;
    } });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /^处理中心/ }));
    fireEvent.click(screen.getByRole('button', { name: '查看详情' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    const differentWorkspace = { ...snapshot,
      workspaceMode: change === 'mode' ? 'demo' as const : snapshot.workspaceMode,
      workspaceName: change === 'name' ? '另一份合成家庭档案' : snapshot.workspaceName,
      jobs: [{ ...snapshot.jobs[0]!, statusText: '同 ID 的其他工作区任务' }] };
    act(() => emitSnapshot(differentWorkspace));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('合成个人工作区任务')).toBeNull();
    act(() => emitSnapshot(snapshot));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('综合阶段旧任务重试时不承诺跳过尚未保存的报告', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.jobs = [{ ...createDemoSnapshot().jobs[0]!, stage: 'analyze', status: 'failed',
      statusText: '处理失败', completedUnits: 6, totalUnits: 6, canCancel: false, canRetry: true }];
    const retryJob = vi.fn(async (jobId: string) => ({ ok: true as const, data: { jobId } }));
    installBridge(snapshot, { retryJob });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '处理中心' }));
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('已按保存进度排队重试；尚未处理的报告会继续处理，已保存的报告结果会保留。')).toBeTruthy();
    expect(retryJob).toHaveBeenCalledWith(snapshot.jobs[0]!.id);
    expect(screen.queryByText(/已从派生说明阶段重试/)).toBeNull();
  });

  it('模型繁忙等待采用普通信息提示，显示自动重试说明且允许停止', async () => {
    const snapshot = createPersonalSnapshot();
    const statusText = '模型暂时繁忙，稍后自动重试（第 1/2 次）；已保存的报告结果会保留';
    snapshot.jobs = [{ ...createDemoSnapshot().jobs[0]!, stage: 'analyze', status: 'retry_wait',
      statusText, completedUnits: 22, totalUnits: 22, canCancel: true, canRetry: false }];
    installBridge(snapshot);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '处理中心' }));
    expect(screen.getByText('正在自动恢复').className).toContain('badge--info');
    expect(screen.getByRole('button', { name: '停止' }).hasAttribute('disabled')).toBe(false);
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看详情' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(statusText)).toBeTruthy();
    expect(within(dialog).getByText('22/22 份')).toBeTruthy();
    expect(within(dialog).queryByText(/需要你的确认|HTTP|CODEX_/)).toBeNull();
  });

  it('繁忙自动重试耗尽后说明原因，手动继续仍走原任务入口而非重新提取', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.jobs = [{ ...createDemoSnapshot().jobs[0]!, stage: 'analyze', status: 'failed',
      statusText: '模型仍然繁忙，已完成 2 次自动重试；可稍后继续综合，已有报告结果会保留',
      completedUnits: 22, totalUnits: 22, canCancel: false, canRetry: true }];
    const retryJob = vi.fn(async (jobId: string) => ({ ok: true as const, data: { jobId } }));
    const processNow = vi.fn();
    installBridge(snapshot, { retryJob, processNow });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '处理中心' }));
    expect(screen.getByText(/模型仍然繁忙，已完成 2 次自动重试/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(retryJob).toHaveBeenCalledWith(snapshot.jobs[0]!.id));
    expect(processNow).not.toHaveBeenCalled();
  });

  it('磁盘空间不足明确说明原因，手动重试保留进度且不另建批次', async () => {
    const snapshot = createPersonalSnapshot();
    const statusText = '本机磁盘空间不足；原件和已完成结果保留。请释放空间后重试，将从保存的进度继续';
    snapshot.jobs = [{ ...createDemoSnapshot().jobs[0]!, stage: 'extract', status: 'failed',
      statusText, completedUnits: 4, totalUnits: 8, canCancel: false, canRetry: true }];
    const retryJob = vi.fn(async (jobId: string) => ({ ok: true as const, data: { jobId } }));
    const processNow = vi.fn();
    installBridge(snapshot, { retryJob, processNow }); render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '处理中心' }));
    expect(screen.getByText(new RegExp(statusText))).toBeTruthy();
    expect(screen.queryByText(/模型暂时繁忙|稍后自动重试/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(retryJob).toHaveBeenCalledWith(snapshot.jobs[0]!.id));
    expect(processNow).not.toHaveBeenCalled();
  });

  it('明确额度等待允许用户主动按断点继续，不新建处理范围或宣称自动重试', async () => {
    const snapshot = createPersonalSnapshot();
    const statusText = '服务已返回用量上限，等待额度恢复；已保存结果保留';
    snapshot.jobs = [{ ...createDemoSnapshot().jobs[0]!, stage: 'extract', status: 'waiting_quota',
      statusText, completedUnits: 7, totalUnits: 9, canCancel: true, canRetry: true }];
    const retryJob = vi.fn(async (jobId: string) => ({ ok: true as const, data: { jobId } }));
    const processNow = vi.fn();
    installBridge(snapshot, { retryJob, processNow });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '处理中心' }));
    expect(screen.getByText(new RegExp(statusText))).toBeTruthy();
    expect(screen.queryByText(/稍后自动重试/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(retryJob).toHaveBeenCalledWith(snapshot.jobs[0]!.id));
    expect(processNow).not.toHaveBeenCalled();
  });

  it('家庭总览只作为成员入口，不用任意一项指标冒充全人结论', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.persons[0]!.documentCount = 1;
    snapshot.persons[0]!.acceptedFactCount = 3;
    snapshot.persons[0]!.derivedStatus = 'current';
    snapshot.persons[0]!.changeSummary = '血脂比上次降低，仍需留意体重变化。';
    snapshot.persons[0]!.assessmentSummary = '血脂较前下降，体重仍需继续关注。现有肝功能与空腹血糖在本次报告参考范围内，不能据此概括未检查的身体情况。';
    snapshot.persons[0]!.lastDocumentDate = '2025-12-24';
    snapshot.trends = [{
      ...createDemoSnapshot().trends[0]!,
      personId: snapshot.persons[0]!.id,
      points: createDemoSnapshot().trends[0]!.points.map((point, index, points) => (
        index === points.length - 1 ? { ...point, abnormalFlag: 'normal' as const } : point
      ))
    }];
    installBridge(snapshot);
    render(<App />);

    expect(await screen.findByRole('button', { name: /测试成员.*查看健康解读/ })).toBeTruthy();
    expect(screen.queryByText('最近一次：报告未标记异常')).toBeNull();
    expect(screen.queryByText(/可比较趋势/)).toBeNull();
    expect(screen.getByText('血脂比上次降低，仍需留意体重变化。')).toBeTruthy();
    expect(screen.getByText('整体健康情况')).toBeTruthy();
    expect(screen.getByText(snapshot.persons[0]!.assessmentSummary!)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '收起完整整体情况' }));
    expect(screen.queryByText(snapshot.persons[0]!.assessmentSummary!)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开完整整体情况' }));
    expect(screen.getByText(snapshot.persons[0]!.assessmentSummary!)).toBeTruthy();
    expect(screen.getByText('最近检查：2025-12-24')).toBeTruthy();
  });

  it('家庭卡片长说明按需展开，完整保留条件且展开不跳转成员页', async () => {
    const snapshot = createPersonalSnapshot();
    const summary = '低密度脂蛋白胆固醇较前升高，饮食调整可以作为当前的起点。'.repeat(10)
      + '现有血压、血糖及肝功能在本次报告参考范围内。'.repeat(5)
      + '只有两次记录，不能把前后差异当作长期趋势，也不能据此概括没有检查的身体情况。';
    snapshot.persons[0]!.derivedStatus = 'current';
    snapshot.persons[0]!.changeSummary = '胆固醇升高值得处理，其他已有检查未提示明显问题。';
    snapshot.persons[0]!.assessmentSummary = summary;
    installBridge(snapshot);
    render(<App />);
    const expand = await screen.findByRole('button', { name: '展开完整整体情况' });
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(summary)).toBeNull();
    fireEvent.click(expand);
    expect(screen.getByText(summary)).toBeTruthy();
    expect(screen.queryByRole('tab', { name: '健康总览' })).toBeNull();
    const collapse = screen.getByRole('button', { name: '收起完整整体情况' });
    expect(collapse.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(collapse);
    expect(screen.queryByText(summary)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '测试成员，查看健康解读' }));
    expect(await screen.findByRole('tab', { name: '健康总览' })).toBeTruthy();
  });

  it.each([
    { status: 'current', refreshStatus: 'none', notice: null },
    { status: 'stale', refreshStatus: 'optional_rules', notice: '已发布解读基于此前规则，仍对应当前资料；可选择按新规则更新。' },
    { status: 'stale', refreshStatus: 'required', notice: '此前已发布解读，需结合当前资料更新。' }
  ] as const)('家庭卡片保留已有解读，并区分资料变化与可选规则升级：$refreshStatus', async ({ status, refreshStatus, notice }) => {
    const snapshot = createPersonalSnapshot();
    snapshot.persons[0] = { ...snapshot.persons[0]!, acceptedFactCount: 3, derivedStatus: status,
      assessmentRefreshStatus: refreshStatus,
      changeSummary: '合成既有整体结论', assessmentSummary: '合成既有正文，仍需结合当时检查条件理解。' };
    const processNow = vi.fn();
    installBridge(snapshot, { processNow }); render(<App />);
    await screen.findByText('合成既有整体结论');
    expect(screen.getByText(snapshot.persons[0]!.assessmentSummary!)).toBeTruthy();
    if (notice) expect(screen.getByText(notice)).toBeTruthy();
    else expect(screen.queryByText(/需结合当前资料更新|已发布解读基于此前规则/)).toBeNull();
    if (refreshStatus === 'optional_rules') expect(screen.queryByText(/健康解读待更新|需结合当前资料更新/)).toBeNull();
    expect(processNow).not.toHaveBeenCalled();
  });

  it('家庭卡片中性标题也能展开完整说明，不把长正文或被截断的预览塞满首屏', async () => {
    const snapshot = createPersonalSnapshot();
    const summary = '现有检查涉及心血管、内分泌和肝胆，说明只反映这些检查覆盖的范围。'
      + '胆固醇较前升高，血糖及肝功能在本次参考范围内，仍需结合症状和既往背景理解。'.repeat(8);
    snapshot.persons[0]!.derivedStatus = 'current';
    snapshot.persons[0]!.changeSummary = '整体健康情况';
    snapshot.persons[0]!.assessmentSummary = summary;
    installBridge(snapshot);
    render(<App />);
    const expand = await screen.findByRole('button', { name: '展开完整整体情况' });
    expect(screen.queryByText(summary)).toBeNull();
    fireEvent.click(expand);
    expect(screen.getByText(summary)).toBeTruthy();
    expect(screen.getByRole('button', { name: '收起完整整体情况' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('家庭整体概况的HTTPS引用显示完整标签而非Markdown，不新增可执行链接且保留限制', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.persons[0]!.derivedStatus = 'current';
    snapshot.persons[0]!.changeSummary = '了解肝酶、甲状腺和血脂结果';
    snapshot.persons[0]!.assessmentSummary = '需结合症状理解，参考[医学资料A](https://example.com/source)。只有旧记录，不能说明现在。<script>alert(1)</script>';
    installBridge(snapshot);
    render(<App />);
    const shown = '需结合症状理解，参考医学资料A。只有旧记录，不能说明现在。<script>alert(1)</script>';
    expect(await screen.findByText(shown)).toBeTruthy();
    expect(screen.queryByRole('link', { name: '医学资料A' })).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.queryByText(snapshot.persons[0]!.assessmentSummary!)).toBeNull();
  });

  it('原始资料预览失败时保留重试入口，不一直显示读取中或虚构原文', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.inbox = [{
      id: 'preview-1', displayName: '虚构报告.txt', discoveredAt: '2026-09-18T00:00:00.000Z',
      personId: 'personal-person-1', personLabel: '测试成员', status: 'queued', format: '纯文本',
      sourceLabel: '手动导入', sentToAi: false, aiTransmissionStatus: 'not_sent', inProcessingCenter: false, issue: null
    }];
    const getEvidence = vi.fn().mockResolvedValueOnce({ ok: false, error: { code: 'not_found', message: 'missing' } }).mockResolvedValueOnce({
      ok: true, data: { displayName: '虚构报告.txt', locator: '第 1 页', quote: '原文：血糖 5.2 mmol/L', sourceSpanId: 'span-1', documentId: 'preview-1', previewImageDataUrl: null, readability: 'clear', conversionView: false }
    });
    installBridge(snapshot, { getEvidence });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '报告收件箱' }));
    fireEvent.click(await screen.findByRole('button', { name: '查看 虚构报告.txt 的来源' }));
    expect(await screen.findByText('暂时无法打开预览')).toBeTruthy();
    expect(screen.queryByText('……检验项目与结果……')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试预览' }));
    expect(await screen.findByText('原文：血糖 5.2 mmol/L')).toBeTruthy();
    expect(screen.queryByText('暂时无法打开预览')).toBeNull();
    expect(getEvidence).toHaveBeenCalledTimes(2);
  });

  it('原始资料请求抛错后可重试，关闭侧栏不会被迟到的结果重新打开', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.inbox = [{
      id: 'preview-2', displayName: '虚构资料.txt', discoveredAt: '2026-09-18T00:00:00.000Z',
      personId: 'personal-person-1', personLabel: '测试成员', status: 'queued', format: '纯文本',
      sourceLabel: '手动导入', sentToAi: false, aiTransmissionStatus: 'not_sent', inProcessingCenter: false, issue: null
    }];
    let finish: (value: unknown) => void = () => undefined;
    const getEvidence = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    installBridge(snapshot, { getEvidence });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '报告收件箱' }));
    fireEvent.click(await screen.findByRole('button', { name: '查看 虚构资料.txt 的来源' }));
    expect(await screen.findByText('暂时无法打开预览')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重试预览' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭证据侧栏' }));
    finish({ ok: true, data: { displayName: '虚构资料.txt', locator: '第 1 页', quote: '迟到的原文', sourceSpanId: 'span-2', documentId: 'preview-2', previewImageDataUrl: null, readability: 'clear', conversionView: false } });
    await waitFor(() => expect(screen.queryByLabelText('证据侧栏')).toBeNull());
    expect(screen.queryByText('迟到的原文')).toBeNull();
  });

  it('证据侧栏支持 Escape 关闭并把键盘焦点还给原按钮', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '成员档案' }));
    const trigger = await screen.findByRole('button', { name: /心血管/ });
    fireEvent.click(trigger);
    const evidenceTrigger = await screen.findByRole('button', { name: /心血管/ });
    evidenceTrigger.focus();
    fireEvent.click(evidenceTrigger);

    const closeButton = await screen.findByRole('button', { name: '关闭证据侧栏' });
    await waitFor(() => expect(document.activeElement).toBe(closeButton));
    fireEvent.keyDown(closeButton, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByLabelText('证据侧栏')).toBeNull());
    expect(document.activeElement).toBe(evidenceTrigger);
  });

  it('reconciles the demo selection with the loaded personal workspace before opening the editor', async () => {
    installBridge(createPersonalSnapshot());
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '成员档案' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: '测试成员' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '编辑成员' }));

    expect(await screen.findByRole('dialog', { name: '编辑显示资料' })).toBeTruthy();
    expect(screen.getByDisplayValue('测试成员')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '归档成员' }));
    expect(await screen.findByRole('dialog', { name: '归档 测试成员？' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '确认归档' }).hasAttribute('disabled')).toBe(true);
  });

  it('requires both irreversible-delete acknowledgements before report deletion', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.persons[0]!.documentCount = 1;
    snapshot.inbox = [{
      id: 'document-1', displayName: '纯虚构报告.txt', discoveredAt: '2026-09-18T00:00:00.000Z',
      personId: 'personal-person-1', personLabel: '测试成员', status: 'completed', format: '纯文本',
      sourceLabel: '手动导入', sentToAi: false, aiTransmissionStatus: 'not_sent', inProcessingCenter: true, issue: null
    }];
    installBridge(snapshot);
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '成员档案' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: '测试成员' })).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: '原始资料' }));
    fireEvent.click(await screen.findByRole('button', { name: '删除本机档案' }));

    expect(await screen.findByRole('dialog', { name: '删除这份本机档案？' })).toBeTruthy();
    expect(screen.getByText(/该成员全部旧版 AI 综合及由它采纳的后续事项/)).toBeTruthy();
    expect(screen.getByText(/你自己创建的事项保留/)).toBeTruthy();
    const confirm = screen.getByRole('button', { name: '确认删除' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    const acknowledgements = screen.getAllByRole('checkbox');
    fireEvent.click(acknowledgements[0]!);
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.click(acknowledgements[1]!);
    expect(confirm.hasAttribute('disabled')).toBe(false);
  });

  it('imports dropped local files only after the renderer passes File objects to the preload bridge', async () => {
    const importDroppedFiles = vi.fn(async () => ({
      ok: true as const,
      data: { selectedCount: 1, importedCount: 1, duplicateCount: 0, suppressedCount: 0, rejected: [] }
    }));
    installBridge(createPersonalSnapshot(), { importDroppedFiles });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '报告收件箱' }));
    const dropZone = await screen.findByText('拖入 PDF、图片、DOCX 或 TXT');
    const file = new File(['synthetic health fixture'], 'fixture.txt', { type: 'text/plain' });
    fireEvent.drop(dropZone.closest('section')!, { dataTransfer: { files: [file] } });

    await waitFor(() => expect(importDroppedFiles).toHaveBeenCalledWith('personal-person-1', [file], true));
    expect(await screen.findByText('已保存 1 份资料到本机。')).toBeTruthy();
  });

  it('explains that legacy DOC stays local when the verified converter is unavailable', async () => {
    const importDroppedFiles = vi.fn(async () => ({
      ok: true as const,
      data: {
        selectedCount: 1,
        importedCount: 0,
        duplicateCount: 0,
        suppressedCount: 0,
        rejected: [{ displayName: '旧版虚构报告.doc', code: 'LEGACY_DOC_CONVERSION_REQUIRED' }]
      }
    }));
    installBridge(createPersonalSnapshot(), { importDroppedFiles });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '报告收件箱' }));
    const dropZone = await screen.findByText('拖入 PDF、图片、DOCX 或 TXT');
    const file = new File(['synthetic legacy word fixture'], '旧版虚构报告.doc', { type: 'application/msword' });
    fireEvent.drop(dropZone.closest('section')!, { dataTransfer: { files: [file] } });

    await waitFor(() => expect(importDroppedFiles).toHaveBeenCalledWith('personal-person-1', [file], true));
    expect(await screen.findByText(/暂时无法读取旧版 \.doc，原文件已保留/)).toBeTruthy();
    expect(screen.getByText(/另存为 \.docx 或导出 PDF 后重新添加/)).toBeTruthy();
  });

  it('progressively renders large inbox lists instead of mounting every row at once', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.inbox = Array.from({ length: 55 }, (_, index) => ({
      id: `document-${index + 1}`,
      displayName: `合成报告${index + 1}.txt`,
      discoveredAt: '2026-09-18T00:00:00.000Z',
      personId: 'personal-person-1',
      personLabel: '测试成员',
      status: 'queued' as const,
      format: '纯文本',
      sourceLabel: '手动导入',
      sentToAi: false,
      aiTransmissionStatus: 'not_sent',
      inProcessingCenter: false,
      issue: null
    }));
    installBridge(snapshot);
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '报告收件箱' }));
    expect(await screen.findByText('合成报告50.txt')).toBeTruthy();
    expect(screen.queryByText('合成报告51.txt')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '再显示 5 份资料' }));
    expect(await screen.findByText('合成报告55.txt')).toBeTruthy();
  });

  it('资料进入处理中心后从收件箱移走，并给出明确去向', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.inbox = [{
      id: 'processing-document', displayName: '处理中报告.pdf', discoveredAt: '2026-09-18T00:00:00.000Z',
      personId: 'personal-person-1', personLabel: '测试成员', status: 'queued', format: 'PDF', sourceLabel: '手动导入',
      sentToAi: true, aiTransmissionStatus: 'unknown', inProcessingCenter: true, issue: null
    }];
    installBridge(snapshot);
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '报告收件箱' }));
    expect(screen.queryByText('处理中报告.pdf')).toBeNull();
    expect(screen.getByText('暂无待处理的新资料')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '立即处理全部' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '前往处理中心' }));
    expect(await screen.findByRole('heading', { name: '资料处理进度' })).toBeTruthy();
  });

  it('已完成资料不再回到只用于接收新资料的收件箱', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.inbox = [{
      id: 'completed-document', displayName: '已完成报告.pdf', discoveredAt: '2026-09-18T00:00:00.000Z',
      personId: 'personal-person-1', personLabel: '测试成员', status: 'completed', format: 'PDF', sourceLabel: '手动导入',
      sentToAi: true, aiTransmissionStatus: 'completed', inProcessingCenter: false, issue: null
    }];
    installBridge(snapshot);
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '报告收件箱' }));
    expect(screen.queryByText('已完成报告.pdf')).toBeNull();
    expect(screen.getByText('暂无待处理的新资料')).toBeTruthy();
  });

  it('旧资料缺少新版综合时保留报告结果，不在阅读时另发资料或强制二次批准', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.persons[0] = { ...snapshot.persons[0]!, documentCount: 10, acceptedFactCount: 361, derivedStatus: 'stale' };
    const processNow = vi.fn<HealthDesktopBridge['processNow']>();
    installBridge(snapshot, { processNow });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '成员档案' }));
    expect(await screen.findByRole('heading', { name: '测试成员' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '更新健康解读' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '报告收件箱' }));
    expect(screen.getByText('1 位成员的健康解读待更新')).toBeTruthy();
    expect(screen.getByText(/报告结果已保存，现有内容仍可查看/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '查看范围并刷新' })).toBeNull();
    expect(processNow).not.toHaveBeenCalled();
  });

  it('规则升级只作说明，不冒充新资料待处理，不在查看时发送任何成员资料', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.persons[0] = { ...snapshot.persons[0]!, documentCount: 2, acceptedFactCount: 8,
      derivedStatus: 'stale', assessmentRefreshStatus: 'optional_rules' };
    snapshot.persons.push({ ...snapshot.persons[0]!, id: 'optional-other', displayName: '另一位家人' });
    const processNow = vi.fn<HealthDesktopBridge['processNow']>();
    installBridge(snapshot, { processNow });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '报告收件箱' }));
    expect(screen.queryByText(/位成员的健康解读待更新/)).toBeNull();
    const notice = screen.getByRole('region', { name: '可选的解读规则更新' });
    expect(notice.textContent).toContain('现有解读仍可阅读');
    expect(notice.textContent).toContain('2 位成员');
    expect(within(notice).queryByRole('button')).toBeNull();
    expect(processNow).not.toHaveBeenCalled();
  });

  it('新数据待更新与可选规则升级分开说明，不把阅读动作作为新的发送授权', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.persons[0] = { ...snapshot.persons[0]!, acceptedFactCount: 8, derivedStatus: 'stale', assessmentRefreshStatus: 'required' };
    snapshot.persons.push({ ...snapshot.persons[0]!, id: 'optional-other', displayName: '另一位家人', assessmentRefreshStatus: 'optional_rules' });
    const processNow = vi.fn<HealthDesktopBridge['processNow']>();
    installBridge(snapshot, { processNow });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '报告收件箱' }));
    expect(screen.getByText('1 位成员的健康解读待更新')).toBeTruthy();
    expect(screen.queryByText('2 位成员的健康解读待更新')).toBeNull();
    expect(screen.queryByRole('button', { name: '查看范围并刷新' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(processNow).not.toHaveBeenCalled();
  });

  it('新报告已属于当前成员时收件箱不再提供第二个批量处理或授权入口', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.persons[0] = { ...snapshot.persons[0]!, acceptedFactCount: 3, derivedStatus: 'stale' };
    snapshot.inbox = [{
      id: 'new-document', displayName: '新资料.txt', discoveredAt: '2026-09-18T00:00:00Z',
      personId: 'personal-person-1', personLabel: '测试成员', status: 'queued', format: '纯文本',
      sourceLabel: '手动导入', sentToAi: false, aiTransmissionStatus: 'not_sent', inProcessingCenter: false, issue: null
    }];
    const processNow = vi.fn<HealthDesktopBridge['processNow']>();
    installBridge(snapshot, { processNow });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '报告收件箱' }));
    expect(screen.getByText('新资料.txt')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '立即处理全部' })).toBeNull();
    expect(screen.queryByRole('button', { name: '查看范围并刷新' })).toBeNull();
    expect(processNow).not.toHaveBeenCalled();
  });

  it('成员综合已有进行中的任务时，不再提示重复刷新', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.persons[0]!.acceptedFactCount = 3;
    snapshot.persons[0]!.derivedStatus = 'stale';
    snapshot.inbox = [];
    snapshot.jobs = [{
      id: 'active-refresh', batchLabel: '刷新综合', personLabel: '测试成员', stage: 'analyze', status: 'queued',
      completedUnits: 0, totalUnits: 1, statusText: '等待处理', systemOutcomes: [],
      updatedAt: '2026-09-18T00:00:00.000Z', canCancel: true, canRetry: false
    }];
    installBridge(snapshot);
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '成员档案' }));
    expect(screen.queryByRole('button', { name: '查看范围并刷新综合' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '报告收件箱' }));
    expect(screen.queryByRole('button', { name: '查看范围并刷新' })).toBeNull();
  });

  it('不可重试且已被新任务替代的失败记录不再冒充当前待办', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.jobs = [{
      id: 'superseded-job', batchLabel: '旧处理任务', personLabel: '测试成员', stage: 'extract', status: 'failed',
      completedUnits: 0, totalUnits: 1, statusText: '已有较新的处理任务，请使用上方任务继续',
      systemOutcomes: [], updatedAt: '2026-09-18T00:00:00.000Z', canCancel: false, canRetry: false
    }];
    installBridge(snapshot);
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '处理中心' }));
    expect(screen.queryByText('每块提取一次')).toBeNull();
    expect(screen.queryByText('成员综合一次')).toBeNull();
    expect(screen.queryByText('独立核对')).toBeNull();
    expect(screen.queryByRole('heading', { name: '正在处理与需要关注' })).toBeNull();
    expect(screen.getByRole('heading', { name: '最近记录' })).toBeTruthy();
    expect(screen.getByText('旧处理任务')).toBeTruthy();
  });

  it('部分完成任务在详情中说清哪个系统失败以及未覆盖范围', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.jobs = [{
      id: 'partial-job', batchLabel: '部分完成任务', personLabel: '测试成员', stage: 'publish', status: 'completed_with_issues',
      completedUnits: 1, totalUnits: 1, statusText: '事实已保存，部分系统说明未通过',
      systemOutcomes: [
        { systemId: 'cardiovascular', status: 'rejected', reason: 'evidence_mismatch', inputSignature: null, updatedAt: '2026-09-18T00:00:00.000Z' },
        { systemId: 'endocrine_metabolic', status: 'published', reason: null, inputSignature: 'a'.repeat(64), updatedAt: '2026-09-18T00:00:00.000Z' },
        { systemId: 'renal_urinary', status: 'out_of_scope', reason: 'system_analysis_phase_one', inputSignature: null, updatedAt: '2026-09-18T00:00:00.000Z' }
      ],
      updatedAt: '2026-09-18T00:00:00.000Z', canCancel: false, canRetry: true
    }];
    installBridge(snapshot);
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '处理中心' }));
    fireEvent.click(screen.getByRole('button', { name: '查看详情' }));
    expect(await screen.findByRole('heading', { name: '部分完成任务' })).toBeTruthy();
    expect(screen.getByText('心血管')).toBeTruthy();
    expect(screen.getByText('解读暂未完成')).toBeTruthy();
    expect(screen.getByText('其他 1 个系统')).toBeTruthy();
    expect(screen.getByText(/报告结果仍可查看，这部分解读暂未发布/)).toBeTruthy();
  });

  it('已完成但有内容说明的任务只进入最近记录，不要求重试或亮通知点', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.jobs = [{
      id: 'finished-with-limitations', batchLabel: '已完成的报告整理', personLabel: '测试成员',
      stage: 'publish', status: 'completed_with_issues', completedUnits: 2, totalUnits: 2,
      statusText: '报告结果已保存，部分内容未采用', systemOutcomes: [],
      updatedAt: '2026-09-18T00:00:00.000Z', canCancel: false, canRetry: true
    }];
    const retryJob = vi.fn<HealthDesktopBridge['retryJob']>();
    installBridge(snapshot, { retryJob });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '处理中心' }));
    expect(screen.getByRole('button', { name: '查看处理通知与任务' }).querySelector('i')).toBeNull();
    expect(screen.queryByRole('heading', { name: '正在处理与需要关注' })).toBeNull();
    expect(screen.getByRole('heading', { name: '最近记录' })).toBeTruthy();
    expect(screen.getByText('已完成的报告整理')).toBeTruthy();
    expect(screen.getByText(/报告结果已保存，部分内容未采用/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看详情' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '已完成的报告整理' })).toBeTruthy();
    expect(retryJob).not.toHaveBeenCalled();
  });

  it.each(['person_conflict', 'PERSON_IDENTITY_NOT_CONFIRMED', 'known_member', 'unassigned', 'reporter_name', 'historical_alias'] as const)(
    '身份问题 %s 只解释未纳入，不暗中认领、改归成员或要求批准', async (scenario) => {
      const snapshot = createPersonalSnapshot();
      snapshot.inbox = [{ id: 'identity-document', displayName: '合成身份来源.pdf',
        personId: scenario === 'unassigned' ? null : snapshot.persons[0]!.id,
        personLabel: scenario === 'unassigned' ? null : '测试成员', discoveredAt: '2026-09-18T00:00:00Z',
        status: 'needs_review', format: 'PDF', sourceLabel: '手动导入', sentToAi: true,
        aiTransmissionStatus: 'completed', inProcessingCenter: true, issue: null }];
      snapshot.reviews = [{ id: 'identity-review', documentId: 'identity-document', personId: snapshot.inbox[0]!.personId,
        kind: scenario === 'PERSON_IDENTITY_NOT_CONFIRMED' ? 'coverage_gap' : 'person_conflict',
        severity: 'blocking', title: '请再次确认资料属于谁', description: '旧流程要求人工改归或批准。',
        evidenceRefs: ['identity-span'], candidateOptions: [], candidateDiffs: [], reportedName: '合成来源姓名',
        reasonCodes: scenario === 'PERSON_IDENTITY_NOT_CONFIRMED' ? ['PERSON_IDENTITY_NOT_CONFIRMED'] : [],
        resolutionStatus: 'open' }];
      const before = JSON.stringify(snapshot);
      const resolveReview = vi.fn<HealthDesktopBridge['resolveReview']>();
      const processNow = vi.fn<HealthDesktopBridge['processNow']>();
      installBridge(snapshot, { resolveReview, processNow });
      render(<App />);
      fireEvent.click(await screen.findByRole('button', { name: '处理中心' }));
      const notes = screen.getByRole('region', { name: '资料处理说明' });
      expect(within(notes).getByText('合成身份来源.pdf')).toBeTruthy();
      expect(within(notes).getByText(/本份资料暂未纳入其健康分析；其他资料继续整理/)).toBeTruthy();
      expect(within(notes).getByRole('button', { name: '查看合成身份来源.pdf的依据' })).toBeTruthy();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.queryByRole('button', { name: /确认同一人|保存修正|重新识别|批准/ })).toBeNull();
      expect(screen.queryByText('旧流程要求人工改归或批准。')).toBeNull();
      expect(resolveReview).not.toHaveBeenCalled();
      expect(processNow).not.toHaveBeenCalled();
      expect(JSON.stringify(snapshot)).toBe(before);
    });

  it('旧版 77 条未采用记录只作说明，不让用户逐项编辑或再次批准', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.account = { ...snapshot.account, status: 'connected', displayLabel: 'fixture@example.test' };
    snapshot.inbox = [{ id: 'legacy-document-1', displayName: '合成旧版报告.txt', personId: snapshot.persons[0]!.id,
      personLabel: '测试成员', discoveredAt: '2026-09-18T00:00:00Z', status: 'needs_review', format: '纯文本',
      sourceLabel: '手动导入', sentToAi: true, aiTransmissionStatus: 'completed', inProcessingCenter: true, issue: null }];
    const candidateOptions = Array.from({ length: 77 }, (_, index) => ({
      localKey: `legacy-${index + 1}`,
      originalName: `虚构项目 ${index + 1}`,
      standardNameCandidate: null,
      value: { kind: 'numeric' as const, rawText: String(index + 1), decimal: String(index + 1), comparator: 'eq' as const },
      unitRaw: null,
      referenceRangeRaw: null,
      reportedAbnormalFlag: null,
      specimen: null,
      method: null,
      bodySite: null,
      clinicalDate: null,
      evidence: [{ sourceSpanId: 'legacy-span', quote: String(index + 1) }],
      issues: []
    }));
    snapshot.reviews = [{
      id: 'legacy-review-1', personId: 'personal-person-1', documentId: 'legacy-document-1',
      kind: 'field_conflict', severity: 'blocking', title: '按新规则重新核对这份报告',
      description: '这项核对由旧版逐字段完全一致规则产生。', evidenceRefs: ['legacy-span'],
      candidateOptions, candidateDiffs: [], reportedName: null, reasonCodes: [], resolutionStatus: 'open'
    }];
    snapshot.openReviewCount = 1;
    const resolveReview = vi.fn(async () => ({ ok: true as const, data: { action: 'retry_review' as const } }));
    const processNow = vi.fn(async () => ({ ok: true as const, data: { batchId: 'synthetic-batch', jobIds: ['synthetic-job'] } }));
    installBridge(snapshot, { resolveReview, processNow });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '处理中心' }));
    expect(screen.queryByText('需要你的确认')).toBeNull();
    expect(screen.queryByDisplayValue('虚构项目 1')).toBeNull();
    const boundaries = screen.getByRole('region', { name: '报告结果边界' });
    expect(within(boundaries).getByText('1 份资料有需说明的内容')).toBeTruthy();
    expect(within(boundaries).getByText('历史读取版本（77 条待对账记录）')).toBeTruthy();
    expect(within(boundaries).queryByText('1 份资料共 77 条读取结果未纳入本次结果')).toBeNull();
    expect(within(boundaries).getByRole('button', { name: '查看合成旧版报告.txt的依据' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: /重新核对这份报告/ })).toBeNull();
    expect(processNow).not.toHaveBeenCalled();
    expect(resolveReview).not.toHaveBeenCalled();
  });

  it('部分发布 warning 不在每次打开时占据页面顶部，处理中心和原始依据仍可查看', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.persons[0]!.documentCount = 1;
    snapshot.account = { ...snapshot.account, status: 'connected', displayLabel: 'masked@example.invalid' };
    snapshot.inbox = [{
      id: 'partial-document', displayName: '部分发布资料.txt', discoveredAt: '2026-09-18T00:00:00.000Z',
      personId: 'personal-person-1', personLabel: '测试成员', status: 'completed', format: '纯文本',
      sourceLabel: '手动导入', sentToAi: true, aiTransmissionStatus: 'acknowledged', inProcessingCenter: true, issue: null
    }];
    snapshot.reviews = [{
      id: 'partial-publish-warning', personId: 'personal-person-1', documentId: 'partial-document',
      kind: 'field_conflict', severity: 'warning', title: '1 个项目未纳入本次结果',
      description: '其他有可靠依据的报告事实已经保存；这部分因依据不足未纳入。未纳入只表示暂时无法可靠确认，不等于结果正常。',
      evidenceRefs: ['partial-span'], candidateOptions: [], candidateDiffs: [],
      reportedName: null, reasonCodes: ['numeric_value_not_in_evidence'], resolutionStatus: 'open'
    }];
    snapshot.openReviewCount = 0;
    const getEvidence = vi.fn(async () => ({
      ok: true as const,
      data: {
        sourceSpanId: 'partial-span', documentId: 'partial-document', displayName: '部分发布资料.txt',
        mediaType: 'text/plain', locator: '第 1 行', quote: '项目甲 1.0 mmol/L', readability: 'clear' as const,
        conversionView: false, previewImageDataUrl: null
      }
    }));
    const processNow = vi.fn(async () => ({ ok: true as const, data: { batchId: 'repair-batch' }, revision: 1 }));
    installBridge(snapshot, { getEvidence, processNow });
    render(<App />);

    await screen.findByRole('button', { name: '处理中心' });
    expect(screen.queryByText('1 个项目未纳入本次结果')).toBeNull();
    expect(screen.queryByText('需要你的确认')).toBeNull();
    expect(screen.queryByRole('button', { name: '重新读取报告' })).toBeNull();
    expect(screen.getByRole('button', { name: '查看处理通知与任务' }).querySelector('i')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '处理中心' }));
    const boundaries = await screen.findByRole('region', { name: '报告结果边界' });
    expect(within(boundaries).getByText(/暂不能确定真正未纳入的独立项目数/)).toBeTruthy();
    fireEvent.click(within(boundaries).getByRole('button', { name: '查看部分发布资料.txt的依据' }));
    const evidence = await screen.findByLabelText('证据侧栏');
    expect(within(evidence).getByText('这份报告的读取完整性与历史说明')).toBeTruthy();
    expect(within(evidence).getByText(/已有可靠结果继续参与分析/)).toBeTruthy();
    expect(getEvidence).toHaveBeenCalledWith({ sourceSpanId: 'partial-span' });
    fireEvent.click(screen.getByRole('button', { name: '关闭证据侧栏' }));
    expect(within(boundaries).queryByRole('button', { name: /重新核对/ })).toBeNull();
    expect(processNow).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '家庭总览' }));
    expect(screen.queryByRole('region', { name: '报告结果边界' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '处理中心' }));
    expect(screen.getByRole('region', { name: '报告结果边界' })).toBeTruthy();
  });

  it('多份报告边界汇总读取结果记录数，不把它称为检查项目数或异常数，并能分别查看依据', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.inbox = ['first', 'second'].map((name) => ({
      id: `${name}-document`, displayName: `${name}.txt`, discoveredAt: '2026-09-18T00:00:00.000Z',
      personId: 'personal-person-1', personLabel: '测试成员', status: 'completed' as const, format: '纯文本',
      sourceLabel: '手动导入', sentToAi: true, aiTransmissionStatus: 'acknowledged' as const, inProcessingCenter: true, issue: null
    }));
    const candidate = {
      localKey: 'same-item', originalName: '虚构项目', standardNameCandidate: '虚构项目',
      value: { kind: 'numeric' as const, rawText: '1', decimal: '1', comparator: 'eq' as const },
      unitRaw: null, referenceRangeRaw: null, reportedAbnormalFlag: null,
      specimen: null, method: null, bodySite: null, clinicalDate: '2026-09-24',
      evidence: [{ sourceSpanId: 'first-span', quote: '虚构项目 1' }], issues: []
    };
    snapshot.reviews = [
      {
        id: 'first-limitation', personId: 'personal-person-1', documentId: 'first-document',
        kind: 'field_conflict', severity: 'warning', title: '2 个项目未纳入本次结果',
        description: '第一份资料有部分项目依据不足。', evidenceRefs: ['first-span'],
        candidateOptions: [candidate, {
          ...candidate, originalName: '另一项目',
          value: { kind: 'numeric' as const, rawText: '2', decimal: '2', comparator: 'eq' as const },
          evidence: [{ sourceSpanId: 'first-span', quote: '另一项目 2' }]
        }], candidateDiffs: [], reportedName: null,
        reasonCodes: ['evidence_mismatch'], resolutionStatus: 'open'
      },
      {
        id: 'second-limitation', personId: 'personal-person-1', documentId: 'second-document',
        kind: 'field_conflict', severity: 'warning', title: '1 个项目未纳入本次结果',
        description: '第二份资料有部分项目依据不足。', evidenceRefs: ['second-span'],
        candidateOptions: [{ ...candidate, evidence: [{ sourceSpanId: 'second-span', quote: '虚构项目 1' }] }],
        candidateDiffs: [], reportedName: null, reasonCodes: ['evidence_mismatch'], resolutionStatus: 'open'
      }
    ];
    const getEvidence = vi.fn(async () => ({
      ok: true as const,
      data: {
        sourceSpanId: 'first-span', documentId: 'first-document', displayName: '虚构资料.txt',
        mediaType: 'text/plain', locator: '第 1 行', quote: '虚构项目 1',
        readability: 'clear' as const, conversionView: false, previewImageDataUrl: null
      }
    }));
    installBridge(snapshot, { getEvidence });
    render(<App />);

    expect(screen.queryByText('2 份资料共 3 条读取结果未纳入本次结果')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: '处理中心' }));
    const boundaries = await screen.findByRole('region', { name: '报告结果边界' });
    expect(within(boundaries).getByText('2 份资料有需说明的内容')).toBeTruthy();
    expect(within(boundaries).getByText('历史读取版本（2 条待对账记录）')).toBeTruthy();
    expect(within(boundaries).getByText('历史读取版本（1 条待对账记录）')).toBeTruthy();
    expect(within(boundaries).getAllByText(/暂不能确定真正未纳入的独立项目数/)).toHaveLength(2);
    expect(within(boundaries).queryByText('2 份资料共 3 个项目未纳入本次结果')).toBeNull();
    expect(within(boundaries).getAllByText('查看本轮结果、未纳入原因与历史版本')).toHaveLength(2);
    fireEvent.click(within(boundaries).getByRole('button', { name: '查看first.txt的依据' }));
    await waitFor(() => expect(getEvidence).toHaveBeenCalledWith({ sourceSpanId: 'first-span' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭证据侧栏' }));
    fireEvent.click(within(boundaries).getByRole('button', { name: '查看second.txt的依据' }));
    await waitFor(() => expect(getEvidence).toHaveBeenCalledWith({ sourceSpanId: 'second-span' }));
  });

  it.each([
    { field: 'value', code: 'FACT_ADJUDICATION_UNRESOLVED' },
    { field: 'reportedAbnormalFlag', code: 'ABNORMAL_FLAG_ADJUDICATION_UNCLEAR' },
    { field: 'reportedAbnormalFlag', code: 'INDEPENDENT_REVIEW_MISMATCH' },
    { field: 'issues', code: 'clinical_date_not_in_evidence' }
  ])('未解决的 $field 差异仅做说明，不让用户编辑原值、符号或日期', async ({ field, code }) => {
    const snapshot = createPersonalSnapshot();
    const candidate = {
      localKey: 'synthetic-result', originalName: '合成结果', standardNameCandidate: null,
      value: { kind: 'numeric' as const, rawText: '<0.01', decimal: '0.01', comparator: 'lt' as const },
      unitRaw: 'ng/mL', referenceRangeRaw: null, reportedAbnormalFlag: null,
      specimen: null, method: null, bodySite: null, clinicalDate: null,
      evidence: [{ sourceSpanId: 'synthetic-result-span', quote: '合成结果 <0.01 ng/mL' }], issues: []
    };
    snapshot.inbox = [{ id: 'conflict-document', displayName: '合成差异来源.pdf', personId: snapshot.persons[0]!.id,
      personLabel: '测试成员', discoveredAt: '2026-09-18T00:00:00Z', status: 'needs_review', format: 'PDF',
      sourceLabel: '手动导入', sentToAi: true, aiTransmissionStatus: 'completed', inProcessingCenter: true, issue: null }];
    snapshot.reviews = [{ id: 'conflict-review', personId: snapshot.persons[0]!.id, documentId: 'conflict-document',
      kind: 'field_conflict', severity: 'blocking', title: '请确认核心差异', description: '旧版要求手工修改候选。',
      evidenceRefs: ['synthetic-result-span'], candidateOptions: [candidate], candidateDiffs: [{
        localKey: candidate.localKey, itemName: candidate.originalName, fields: [field as 'value' | 'reportedAbnormalFlag' | 'issues'],
        firstCandidate: candidate, secondCandidate: candidate
      }], reportedName: null, reasonCodes: [code], resolutionStatus: 'open' }];
    const before = JSON.stringify(snapshot.reviews);
    const resolveReview = vi.fn<HealthDesktopBridge['resolveReview']>();
    const processNow = vi.fn<HealthDesktopBridge['processNow']>();
    installBridge(snapshot, { resolveReview, processNow });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '处理中心' }));
    const notes = screen.getByRole('region', { name: '资料处理说明' });
    expect(notes.textContent).toContain('部分结果或来源尚未可靠对应');
    expect(within(notes).getByRole('button', { name: '查看合成差异来源.pdf的依据' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByDisplayValue('<0.01')).toBeNull();
    expect(screen.queryByRole('button', { name: /保存修正|重新核对|重新读取|授权并开始/ })).toBeNull();
    expect(resolveReview).not.toHaveBeenCalled();
    expect(processNow).not.toHaveBeenCalled();
    expect(JSON.stringify(snapshot.reviews)).toBe(before);
  });

  it('requires explicit confirmation before logout and keeps the local workspace visible', async () => {
    const connected = createPersonalSnapshot();
    connected.account = {
      ...connected.account,
      status: 'connected',
      displayLabel: 'masked@example.com',
      quota: { ...connected.account.quota, status: 'available', primaryUsedPercent: 12 }
    };
    const disconnected = {
      ...connected.account,
      status: 'disconnected' as const,
      displayLabel: null,
      quota: { ...connected.account.quota, status: 'unknown' as const, primaryUsedPercent: null }
    };
    const logoutAccount = vi.fn(async () => ({ ok: true as const, data: disconnected }));
    installBridge(connected, { logoutAccount });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    fireEvent.click(await screen.findByRole('button', { name: /账户与 AI/ }));
    expect(await screen.findByRole('dialog', { name: 'Codex 连接' })).toBeTruthy();
    const logout = screen.getByRole('button', { name: '退出 Codex' });
    expect(logout.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /我确认退出 Codex/ }));
    expect(logout.hasAttribute('disabled')).toBe(false);
    fireEvent.click(logout);

    await waitFor(() => expect(logoutAccount).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('button', { name: 'Codex 待连接' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '成员档案' }));
    expect(await screen.findByRole('heading', { name: '测试成员' })).toBeTruthy();
  });

  it('filters inbox management selection without starting another processing or consent workflow', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.account = {
      ...snapshot.account,
      status: 'connected',
      displayLabel: 'masked@example.com',
      quota: { ...snapshot.account.quota, status: 'available' }
    };
    snapshot.inbox = [
      { id: 'ready-1', displayName: '选中的报告.txt', discoveredAt: '2026-09-18T00:00:00.000Z', personId: 'personal-person-1', personLabel: '测试成员', status: 'queued', format: '纯文本', sourceLabel: '手动导入', sentToAi: false, aiTransmissionStatus: 'not_sent', inProcessingCenter: false, issue: null },
      { id: 'unassigned-1', displayName: '待归属.txt', discoveredAt: '2026-09-18T00:00:01.000Z', personId: null, personLabel: null, status: 'needs_review', format: '纯文本', sourceLabel: '手动导入', sentToAi: false, aiTransmissionStatus: 'not_sent', inProcessingCenter: false, issue: '待确认' }
    ];
    const processNow = vi.fn(async () => ({ ok: true as const, data: { batchId: 'batch-1' }, revision: 1 }));
    installBridge(snapshot, { processNow });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '报告收件箱' }));
    fireEvent.change(screen.getByRole('combobox', { name: '按成员筛选' }), { target: { value: 'personal-person-1' } });
    expect(screen.queryByText('待归属.txt')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: '选中 选中的报告.txt' }));
    expect(screen.queryByRole('button', { name: /处理选中项|立即处理全部/ })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(processNow).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(await screen.findByRole('button', { name: /数据与隐私/ }));
    expect(await screen.findByRole('dialog', { name: '哪些留在本机，哪些会发送' })).toBeTruthy();
    expect(screen.getByText(/查询词目前无法由应用在发送前逐条拦截/)).toBeTruthy();
  });

  it('persists display preferences and applies the accessibility classes immediately', async () => {
    const updateDisplayPreferences = vi.fn(async () => ({
      ok: true as const,
      data: { fontScale: 'large' as const, reduceMotion: true, dateStyle: 'numeric' as const }
    }));
    installBridge(createPersonalSnapshot(), { updateDisplayPreferences });
    const { container } = render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    fireEvent.click(await screen.findByRole('button', { name: /显示/ }));
    expect(await screen.findByRole('dialog', { name: '阅读偏好' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('字号'), { target: { value: 'large' } });
    fireEvent.change(screen.getByLabelText('日期显示'), { target: { value: 'numeric' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '减少界面动画' }));
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));

    await waitFor(() => expect(updateDisplayPreferences).toHaveBeenCalledWith({ fontScale: 'large', reduceMotion: true, dateStyle: 'numeric' }));
    await waitFor(() => expect(container.querySelector('.app-shell')?.className).toContain('font-large'));
    expect(container.querySelector('.app-shell')?.className).toContain('reduce-motion');
  });

  it('分析报告默认 GPT-6.1 Sol medium，手动选择时只提供模型支持的推理强度', async () => {
    const updateAiPreferences = vi.fn(async () => ({
      ok: true as const,
      data: { modelId: 'gpt-5.6-terra', reasoningEffort: 'high' as const }
    }));
    installBridge(createPersonalSnapshot(), {
      getAiSettings: async () => ({
        ok: true,
        data: {
          preferences: { modelId: 'gpt-6.1-sol', reasoningEffort: 'medium' },
          models: [
            { id: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', description: 'Sol', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '快速' }, { reasoningEffort: 'medium', description: '平衡' }], defaultReasoningEffort: 'medium', isDefault: true },
            { id: 'gpt-5.6-terra', displayName: 'GPT-5.6-Terra', description: 'Terra', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '平衡' }, { reasoningEffort: 'high', description: '深入' }], defaultReasoningEffort: 'medium', isDefault: false }
          ]
        }
      }),
      updateAiPreferences
    });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    fireEvent.click(await screen.findByRole('button', { name: /分析报告模型/ }));
    expect(await screen.findByRole('dialog', { name: '模型与推理强度' })).toBeTruthy();
    expect(screen.getByText(/报告原件固定由 GPT-6.1-Sol \/ medium 直接阅读/)).toBeTruthy();
    expect((screen.getByLabelText('模型') as HTMLSelectElement).value).toBe('gpt-6.1-sol');
    expect((screen.getByLabelText('推理强度') as HTMLSelectElement).value).toBe('medium');
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'gpt-5.6-terra' } });
    expect((screen.getByLabelText('推理强度') as HTMLSelectElement).value).toBe('medium');
    fireEvent.change(screen.getByLabelText('推理强度'), { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));

    await waitFor(() => expect(updateAiPreferences).toHaveBeenCalledWith({ modelId: 'gpt-5.6-terra', reasoningEffort: 'high' }));
  });

  it('persists the notification preference with the desktop behavior settings', async () => {
    const updateDesktopBehavior = vi.fn(async (input: { stayInTray: boolean; openAtLogin: boolean; notificationsEnabled: boolean }) => ({ ok: true as const, data: input }));
    installBridge(createPersonalSnapshot(), { updateDesktopBehavior });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    fireEvent.click(await screen.findByRole('button', { name: /桌面行为/ }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /处理完成或需要确认时显示系统通知/ }));
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));

    await waitFor(() => expect(updateDesktopBehavior).toHaveBeenCalledWith({ stayInTray: true, openAtLogin: false, notificationsEnabled: false }));
  });

  it('allows an in-progress backup restore to be stopped without closing the dialog early', async () => {
    let finishRestore!: (value: Awaited<ReturnType<HealthDesktopBridge['restoreBackup']>>) => void;
    const restoreBackup = vi.fn(() => new Promise<Awaited<ReturnType<HealthDesktopBridge['restoreBackup']>>>((resolve) => { finishRestore = resolve; }));
    const cancelRestore = vi.fn(async () => {
      finishRestore({
        ok: false as const,
        error: { code: 'BACKUP_RESTORE_CANCELLED', messageKey: 'backup.restore_failed', retryable: true, correlationId: 'test-correlation' }
      });
      return { ok: true as const, data: { cancelled: true } };
    });
    installBridge(createPersonalSnapshot(), {
      pickRestoreBackup: async () => ({ ok: true, data: { selectionId: 'selection-1', displayName: '纯虚构备份.fhbackup' } }),
      restoreBackup,
      cancelRestore
    });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    fireEvent.click(await screen.findByRole('button', { name: /备份与恢复/ }));
    fireEvent.click(await screen.findByRole('button', { name: '恢复备份' }));
    fireEvent.click(screen.getByRole('button', { name: '选择加密备份' }));
    expect(await screen.findByText('纯虚构备份.fhbackup')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('备份口令'), { target: { value: 'correct horse battery staple' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /我确认用所选备份替换/ }));
    fireEvent.click(screen.getByRole('button', { name: '校验并恢复' }));
    fireEvent.click(await screen.findByRole('button', { name: '停止恢复' }));

    await waitFor(() => expect(cancelRestore).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('恢复已停止；当前工作区保持不变。')).toBeTruthy());
    expect(screen.getByRole('dialog', { name: '保护本机家庭健康档案' })).toBeTruthy();
  });
});
