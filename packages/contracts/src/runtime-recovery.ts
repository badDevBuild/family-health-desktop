import { z } from 'zod';

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/);
/** 仅保存恢复所需回执、有限预算和固定诊断，不包含提示词、模型正文、路径或账户明文。 */
export const runtimeTurnRecoverySchema = z.object({
  version: z.literal(1),
  phase: z.enum(['thread_starting', 'thread_ready', 'turn_starting', 'turn_running', 'turn_terminal']),
  threadStarts: z.number().int().min(1).max(3),
  turnStarts: z.number().int().min(0).max(3),
  threadId: identifier.nullable(),
  turnId: identifier.nullable(),
  turnStartedAt: z.string().datetime().nullable(),
  terminalStatus: z.enum(['completed', 'failed', 'interrupted']).nullable(),
  connectionErrorCount: z.number().int().min(0).max(1000),
  connectionRecoveryStartedAt: z.string().datetime().nullable()
}).strict().refine(state => (!['thread_ready', 'turn_starting', 'turn_running', 'turn_terminal'].includes(state.phase) || state.threadId !== null)
  && (!['turn_running', 'turn_terminal'].includes(state.phase) || state.turnId !== null)
  && (state.phase !== 'turn_terminal' || state.terminalStatus !== null)
  && (state.turnStarts === 0 || state.turnStartedAt !== null), 'RUNTIME_RECOVERY_STATE_INVALID');
export type RuntimeTurnRecovery = z.infer<typeof runtimeTurnRecoverySchema>;

export const runtimeRecoveryDiagnosticSchema = z.object({
  kind: z.enum(['startup_sent', 'startup_reply', 'startup_error_reply', 'startup_waiting_late_reply',
    'startup_event_receipt', 'startup_unknown', 'startup_cancelled', 'startup_late_reply',
    'connection_retry', 'connection_content_resumed', 'connection_ignored_unmatched',
    'connection_ignored_unclassified', 'connection_budget_exhausted', 'state_probe', 'state_unknown']),
  method: z.enum(['thread/start', 'turn/start', 'thread/read', 'error']).nullable(),
  requestId: z.number().int().positive().nullable(),
  elapsedMs: z.number().int().min(0).max(86_400_000),
  count: z.number().int().min(0).max(1000),
  threadId: identifier.nullable(),
  turnId: identifier.nullable(),
  failureCode: z.enum(['CODEX_CONNECTION_FAILED', 'CODEX_QUOTA_EXHAUSTED', 'CODEX_RATE_LIMITED',
    'CODEX_REQUEST_LIMITED_UNKNOWN', 'CODEX_MODEL_BUSY', 'OTHER']).nullable()
}).strict();
export type RuntimeRecoveryDiagnostic = z.infer<typeof runtimeRecoveryDiagnosticSchema>;
