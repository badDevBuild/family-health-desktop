// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DashboardSnapshot } from '@contracts';
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
    ...overrides
  } as unknown as HealthDesktopBridge;
  window.healthDesktop = bridge;
  return bridge;
}

afterEach(() => {
  cleanup();
  delete window.healthDesktop;
});

describe('App member display editing', () => {
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
      sourceLabel: '手动导入', sentToAi: false, aiTransmissionStatus: 'not_sent', issue: null
    }];
    installBridge(snapshot);
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '成员档案' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: '测试成员' })).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: '资料' }));
    fireEvent.click(await screen.findByRole('button', { name: '删除本机档案' }));

    expect(await screen.findByRole('dialog', { name: '删除这份本机档案？' })).toBeTruthy();
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

    await waitFor(() => expect(importDroppedFiles).toHaveBeenCalledWith('personal-person-1', [file]));
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

    await waitFor(() => expect(importDroppedFiles).toHaveBeenCalledWith('personal-person-1', [file]));
    expect(await screen.findByText(/旧版 \.doc 的本机兼容组件尚未就绪，原文件已保留/)).toBeTruthy();
    expect(screen.getByText(/先另存为 \.docx \/ 导出 PDF 后重新添加/)).toBeTruthy();
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

  it('filters the inbox and limits manual processing consent to selected ready documents', async () => {
    const snapshot = createPersonalSnapshot();
    snapshot.account = {
      ...snapshot.account,
      status: 'connected',
      displayLabel: 'masked@example.com',
      quota: { ...snapshot.account.quota, status: 'available' }
    };
    snapshot.inbox = [
      { id: 'ready-1', displayName: '选中的报告.txt', discoveredAt: '2026-09-18T00:00:00.000Z', personId: 'personal-person-1', personLabel: '测试成员', status: 'queued', format: '纯文本', sourceLabel: '手动导入', sentToAi: false, aiTransmissionStatus: 'not_sent', issue: null },
      { id: 'unassigned-1', displayName: '待归属.txt', discoveredAt: '2026-09-18T00:00:01.000Z', personId: null, personLabel: null, status: 'needs_review', format: '纯文本', sourceLabel: '手动导入', sentToAi: false, aiTransmissionStatus: 'not_sent', issue: '待确认' }
    ];
    const processNow = vi.fn(async () => ({ ok: true as const, data: { batchId: 'batch-1' }, revision: 1 }));
    installBridge(snapshot, { processNow });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '报告收件箱' }));
    fireEvent.change(screen.getByRole('combobox', { name: '按成员筛选' }), { target: { value: 'personal-person-1' } });
    expect(screen.queryByText('待归属.txt')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: '选中 选中的报告.txt' }));
    fireEvent.click(screen.getByRole('button', { name: /处理选中项/ }));
    expect(await screen.findByText(/1 份选中的已归属资料/)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: /我确认本次接收方/ }));
    fireEvent.click(screen.getByRole('button', { name: '授权并开始' }));

    await waitFor(() => expect(processNow).toHaveBeenCalledWith({ consentVersion: 1, confirmedDataRecipient: 'OpenAI/Codex', documentIds: ['ready-1'] }));
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

  it('defaults to Sol medium and only offers reasoning efforts supported by the selected model', async () => {
    const updateAiPreferences = vi.fn(async () => ({
      ok: true as const,
      data: { modelId: 'gpt-5.6-terra', reasoningEffort: 'high' as const }
    }));
    installBridge(createPersonalSnapshot(), {
      getAiSettings: async () => ({
        ok: true,
        data: {
          preferences: { modelId: 'gpt-5.6-sol', reasoningEffort: 'medium' },
          models: [
            { id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', description: 'Sol', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '快速' }, { reasoningEffort: 'medium', description: '平衡' }], defaultReasoningEffort: 'low', isDefault: true },
            { id: 'gpt-5.6-terra', displayName: 'GPT-5.6-Terra', description: 'Terra', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '平衡' }, { reasoningEffort: 'high', description: '深入' }], defaultReasoningEffort: 'medium', isDefault: false }
          ]
        }
      }),
      updateAiPreferences
    });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    fireEvent.click(await screen.findByRole('button', { name: /AI 模型/ }));
    expect(await screen.findByRole('dialog', { name: '模型与推理强度' })).toBeTruthy();
    expect((screen.getByLabelText('模型') as HTMLSelectElement).value).toBe('gpt-5.6-sol');
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
