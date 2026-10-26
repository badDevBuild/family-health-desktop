import { describe, expect, it, vi } from 'vitest';
import type { AccountState, ProcessNowInput } from '@contracts';
import type { PersonalWorkspaceService } from './workspace-service.js';
import { createProcessNowHandler } from './process-now-ipc.js';

const account: AccountState = { status: 'connected', displayLabel: 'synthetic-scope@example.test',
  quota: { status: 'available', primaryUsedPercent: 0, secondaryUsedPercent: null, resetsAt: null },
  runtimeVersion: 'synthetic', lastCheckedAt: '2026-01-03T00:00:00Z' };
const request = { consentVersion: 1, confirmedDataRecipient: 'OpenAI/Codex' } as const;

function fixture() {
  const processNow = vi.fn<PersonalWorkspaceService['processNow']>().mockReturnValue({ batchId: 'synthetic-batch', idempotent: false });
  const workspace = { processNow, store: {} as PersonalWorkspaceService['store'] };
  const dependencies = { validateSender: vi.fn(), getWorkspace: vi.fn(() => workspace as typeof workspace | null),
    isRebuildRunning: vi.fn(() => false), currentAccountState: vi.fn(() => account),
    ensureRecoveryPointBeforeWrite: vi.fn(async () => undefined), runAvailableJobs: vi.fn() };
  return { ...dependencies, processNow, workspace, handler: createProcessNowHandler(dependencies) };
}

describe('正式手动处理 IPC 范围传递', () => {
  const cases: ProcessNowInput[] = [
    request,
    { ...request, documentIds: ['synthetic-doc'] },
    { ...request, documentIds: ['synthetic-doc'], readingScope: 'unresolved_pages' },
    { ...request, assessmentPersonId: 'synthetic-person', expectedAssessmentDataRevision: 'a'.repeat(64) },
    { ...request, purpose: 'date_correction', dateCorrectionDocumentId: 'synthetic-doc', expectedDateCorrectionDataRevision: 'b'.repeat(64) }
  ];
  it.each(cases)('完整保留契约范围 %#，验证接收方后才排队', async input => {
    const f = fixture();
    expect(await f.handler('synthetic-sender', input)).toEqual({ ok: true, data: { batchId: 'synthetic-batch' }, revision: 1 });
    const { confirmedDataRecipient: _recipient, ...scope } = input;
    expect(f.processNow).toHaveBeenCalledExactlyOnceWith({ ...scope, accountState: account });
    expect(f.runAvailableJobs).toHaveBeenCalledExactlyOnceWith(f.workspace);
    expect(f.ensureRecoveryPointBeforeWrite.mock.invocationCallOrder[0]).toBeLessThan(f.processNow.mock.invocationCallOrder[0]!);
  });
  it.each([
    { ...request, readingScope: 'unresolved_pages' },
    { ...request, readingScope: 'full_report', documentIds: ['synthetic-doc'] },
    { ...request, readingScope: 'unresolved_pages', documentIds: ['synthetic-doc'], assessmentPersonId: 'synthetic-person' },
    { ...request, readingScope: 'unresolved_pages', documentIds: ['synthetic-doc'], injectedPageNumbers: [1] },
    { ...request, documentIds: ['synthetic-doc'], confirmedDataRecipient: 'unapproved-recipient' }
  ])('无效范围不触发排队，也不降级为默认读取 %#', async input => {
    const f = fixture();
    expect(await f.handler('synthetic-sender', input)).toMatchObject({ ok: false });
    expect(f.processNow).not.toHaveBeenCalled();
    expect(f.runAvailableJobs).not.toHaveBeenCalled();
    expect(f.ensureRecoveryPointBeforeWrite).not.toHaveBeenCalled();
  });
  it('无法冻结问题页时保留原错误，不改用整份请求重试', async () => {
    const f = fixture();
    f.processNow.mockImplementation(() => { throw new Error('REPORT_SUPPLEMENT_SCOPE_UNAVAILABLE'); });
    expect(await f.handler(null, { ...request, documentIds: ['synthetic-doc'], readingScope: 'unresolved_pages' }))
      .toMatchObject({ ok: false, error: { code: 'REPORT_SUPPLEMENT_SCOPE_UNAVAILABLE', retryable: false } });
    expect(f.processNow).toHaveBeenCalledTimes(1); expect(f.runAvailableJobs).not.toHaveBeenCalled();
  });
  it.each(['workspace', 'account', 'rebuild', 'backup'] as const)('等待备份期间发生%s变化不能发送', async change => {
    const f = fixture();
    f.ensureRecoveryPointBeforeWrite.mockImplementation(async () => {
      if (change === 'workspace') f.getWorkspace.mockReturnValue(null);
      if (change === 'account') f.currentAccountState.mockReturnValue({ ...account, displayLabel: 'other@example.test' });
      if (change === 'rebuild') f.isRebuildRunning.mockReturnValue(true);
      if (change === 'backup') throw new Error('BACKUP_FAILED');
    });
    expect(await f.handler(null, { ...request, documentIds: ['synthetic-doc'], readingScope: 'unresolved_pages' })).toMatchObject({ ok: false });
    expect(f.processNow).not.toHaveBeenCalled(); expect(f.runAvailableJobs).not.toHaveBeenCalled();
  });
  it('非信任发送者和演示工作区不能调用正式服务', async () => {
    const f = fixture();
    f.validateSender.mockImplementationOnce(() => { throw new Error('UNTRUSTED_SENDER'); });
    await expect(f.handler(null, request)).rejects.toThrow('UNTRUSTED_SENDER');
    f.getWorkspace.mockReturnValue(null);
    expect(await f.handler(null, request)).toMatchObject({ ok: false, error: { code: 'DEMO_MODE' } });
    expect(f.processNow).not.toHaveBeenCalled(); expect(f.runAvailableJobs).not.toHaveBeenCalled();
  });
});
