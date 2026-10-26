import { randomUUID } from 'node:crypto';
import { processNowInputSchema, type AccountState, type Result } from '@contracts';
import type { PersonalWorkspaceService } from './workspace-service.js';

type ProcessingWorkspace = Pick<PersonalWorkspaceService, 'processNow' | 'store'>;

/** 正式 IPC 与测试共用同一个入口，禁止在入口重建一份不完整的发送参数白名单。 */
export function createProcessNowHandler<Event>(dependencies: {
  validateSender: (event: Event) => void;
  getWorkspace: () => ProcessingWorkspace | null;
  isRebuildRunning: () => boolean;
  currentAccountState: () => AccountState;
  ensureRecoveryPointBeforeWrite: () => Promise<void>;
  runAvailableJobs: (workspace: ProcessingWorkspace) => void;
}) {
  return async (event: Event, rawInput: unknown): Promise<Result<{ batchId: string }>> => {
    dependencies.validateSender(event);
    const workspace = dependencies.getWorkspace();
    if (!workspace) {
      return { ok: false, error: { code: 'DEMO_MODE', messageKey: 'demo.process_disabled', retryable: false, correlationId: randomUUID() } };
    }
    try {
      if (dependencies.isRebuildRunning()) throw new Error('PROCESSING_REBUILD_BUSY');
      const input = processNowInputSchema.parse(rawInput);
      const account = dependencies.currentAccountState();
      await dependencies.ensureRecoveryPointBeforeWrite();
      // 备份等待期间切换工作区或账户，不能把旧确认交给新工作区执行。
      if (dependencies.getWorkspace() !== workspace || dependencies.isRebuildRunning()) {
        throw new Error('PROCESSING_SCOPE_CHANGED');
      }
      const accountState = dependencies.currentAccountState();
      if (accountState.status !== account.status || accountState.displayLabel !== account.displayLabel) {
        throw new Error('AUTH_REQUIRED');
      }
      // 契约已严格验证接收方；其余参数完整透传，包括问题页、仅综合和日期纠错范围。
      const { confirmedDataRecipient: _recipient, ...request } = input;
      const result = workspace.processNow({ ...request, accountState });
      dependencies.runAvailableJobs(workspace);
      return { ok: true, data: { batchId: result.batchId }, revision: result.idempotent ? 0 : 1 };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'PROCESS_FAILED';
      return { ok: false, error: { code,
        messageKey: code === 'NO_READY_DOCUMENTS' || code === 'DOCUMENT_ALREADY_IN_PROCESSING'
          ? 'jobs.no_ready_documents' : code === 'AUTH_REQUIRED' ? 'jobs.auth_required' : 'jobs.process_failed',
        retryable: code === 'AUTH_REQUIRED', ...(code === 'AUTH_REQUIRED' ? { action: 'login' as const } : {}),
        correlationId: randomUUID() } };
    }
  };
}
