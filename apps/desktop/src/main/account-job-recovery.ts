import type { AccountState } from '@contracts';
import type { WorkspaceStore } from '@storage';
import { stableHash } from '@core';

// 恢复点等异步工作完成后再读当前账户，不使用事件触发时可能已经过期的额度快照。
// 存储层另行保护明确的服务额度失败：通用账户额度可用不能证明该请求范围已恢复。
export function requeueCurrentAccountWaitingJobs(
  store: WorkspaceStore,
  getAccountState: () => AccountState
): number {
  const state = getAccountState();
  if (state.status !== 'connected' || !state.displayLabel) return 0;
  const accountFingerprint = stableHash({ provider: 'codex-chatgpt', displayLabel: state.displayLabel });
  let count = store.bindPendingAutomaticUploads(accountFingerprint);
  count += store.requeueWaitingJobs('waiting_auth', accountFingerprint);
  if (state.quota.status === 'available' || state.quota.status === 'low') {
    count += store.requeueWaitingJobs('waiting_quota', accountFingerprint);
  }
  return count;
}
