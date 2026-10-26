import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync } from 'node:fs';
import { aiModelOptionSchema, aiReasoningEffortSchema, runtimeTurnRecoverySchema,
  type RuntimeTurnRecovery, type RuntimeRecoveryDiagnostic, type AccountState, type AiModelOption, type AiPreferences } from '@contracts';
import { spawnCodexAppServer, type CodexRpcClient, type RpcRecoveryOptions } from '@codex';
import { stableHash } from '@core';
import { createHealthThreadStartParams } from './codex-thread-config.js';
import { HEALTH_MODEL_TURN_MAX_DURATION_MS, HEALTH_MODEL_TURN_TIMEOUT_MS,
  HEALTH_CONNECTION_RECOVERY_TIMEOUT_MS, HEALTH_CONNECTION_RECOVERY_RETRY_LIMIT, HEALTH_STARTUP_RECEIPT_GRACE_MS } from './ai-runtime-policy.js';
import { restoreCodexOptionalFields, toCodexOutputSchema } from './structured-output-schema.js';
import { createCodexTurnFailure, getCodexTurnFailureDetails } from './codex-turn-failure.js';
import { FairModelTurnScheduler, MAX_MODEL_TURN_CONCURRENCY, type ModelTurnRelease } from './model-turn-scheduler.js';
import type { ReasoningTextDeltaNotification } from '../../../../schemas/codex/0.145.0/ts/v2/ReasoningTextDeltaNotification.js';
import type { ReasoningSummaryTextDeltaNotification } from '../../../../schemas/codex/0.145.0/ts/v2/ReasoningSummaryTextDeltaNotification.js';

interface RuntimeClient extends EventEmitter {
  initialize(): Promise<unknown>;
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  requestWithRecovery?<T = unknown>(method: string, params: unknown, recovery: RpcRecoveryOptions, timeoutMs?: number): Promise<T>;
  shutdown(): void;
}

interface RuntimeOptions {
  executable: string | null;
  runtimeVersion: string | null;
  codexHome: string;
  workingDirectory: string;
  now?: () => Date;
  requestTimeoutMs?: number;
  startupRequestTimeoutMs?: number;
  createClient?: (options: { executable: string; codexHome: string; cwd: string }) => RuntimeClient;
  /** 可降低上限用于受限设备/隔离测试；生产默认自动从 4 路逐步提升到 10 路。 */
  maximumConcurrentTurns?: number;
}

interface AccountReadResponse {
  account: null | { type: 'apiKey' } | { type: 'chatgpt'; email: string | null; planType: string } | { type: 'amazonBedrock'; usesCodexManagedCredentials: boolean };
  requiresOpenaiAuth: boolean;
}

interface RateWindow {
  usedPercent: number;
  resetsAt: number | null;
}

interface RateLimitResponse {
  rateLimits?: { primary?: RateWindow | null; secondary?: RateWindow | null } | null;
}

interface LoginResponse {
  type: 'apiKey' | 'chatgpt' | 'chatgptDeviceCode' | 'chatgptAuthTokens' | 'amazonBedrock';
  loginId?: string;
  authUrl?: string;
  verificationUrl?: string;
  userCode?: string;
}

interface TurnItem {
  id?: string;
  type: string;
  text?: string;
  phase?: string | null;
  action?: { type?: string } | null;
}

interface TurnCompleted {
  threadId: string;
  turn: { id: string; status: string; items: TurnItem[]; error: unknown };
}

interface ItemLifecycleNotification {
  threadId: string;
  turnId: string;
  item: TurnItem;
}

interface AgentMessageDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

// 与仓库 v2/ErrorNotification 字段对齐；原始 error 仅交给安全错误分类，不持久化。
interface ErrorNotification { threadId: string; turnId: string; willRetry: boolean; error: unknown }

interface CompletedTurnCapture {
  notification: TurnCompleted;
  completedMessages: TurnItem[];
  streamedMessages: TurnItem[];
  completedWebSearchItems: TurnItem[];
  tokenUsage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | null;
}

interface ActiveStructuredRun {
  client: RuntimeClient | null;
  threadId: string | null;
  turn: { threadId: string; turnId: string } | null;
  fingerprint: string | null;
  interruptPromise: Promise<void> | null;
  scope: StructuredTurnScope | null;
  cancel(reason?: Error): void;
}

export interface StructuredTurnScope { jobId: string; attemptId: string }

export interface RuntimeTurnRecoveryHooks {
  read(): RuntimeTurnRecovery | null;
  save(state: RuntimeTurnRecovery): void;
  diagnostic(event: RuntimeRecoveryDiagnostic): void;
  lateReceipt?(threadId: string, turnId: string): void;
}

export const CODEX_MAX_CONCURRENT_STRUCTURED_TURNS = MAX_MODEL_TURN_CONCURRENCY;

export interface TurnMetrics {
  /** 历史兼容总耗时；只有 timingVersion=2 的 modelDurationMs 才表示真实模型阶段。 */
  durationMs: number;
  timingVersion?: 2;
  queueWaitMs?: number;
  runtimeSetupMs?: number;
  modelDurationMs?: number;
  totalDurationMs?: number;
  modelStartedAt?: string;
  webSearches: number;
  webPageOpens: number;
  webPageFinds: number;
  webSearchOtherActions: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
}

function webSearchMetrics(capture: CompletedTurnCapture): Pick<TurnMetrics,
  'webSearches' | 'webPageOpens' | 'webPageFinds' | 'webSearchOtherActions'> {
  // 完成通知和 item/completed 可能重复携带同一工具条目，只按 ID 计一次。
  const items = new Map<string, TurnItem>();
  for (const item of [...capture.notification.turn.items, ...capture.completedWebSearchItems]) {
    if (item.type === 'webSearch' && item.id) items.set(item.id, item);
  }
  const result = { webSearches: 0, webPageOpens: 0, webPageFinds: 0, webSearchOtherActions: 0 };
  for (const item of items.values()) {
    switch (item.action?.type) {
      case 'search': result.webSearches += 1; break;
      case 'openPage': result.webPageOpens += 1; break;
      case 'findInPage': result.webPageFinds += 1; break;
      default: result.webSearchOtherActions += 1;
    }
  }
  return result;
}

function latestAgentMessage(items: TurnItem[], phase: 'final_answer' | 'unphased'): TurnItem | undefined {
  return [...items].reverse().find((item) => item.type === 'agentMessage' && Boolean(item.text)
    && (phase === 'final_answer' ? item.phase === 'final_answer' : item.phase == null));
}

interface RuntimeModel {
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
  defaultReasoningEffort: string;
  inputModalities: string[];
  isDefault: boolean;
}

interface ModelListResponse {
  data: RuntimeModel[];
  nextCursor: string | null;
}

function initialState(runtimeVersion: string | null, available: boolean): AccountState {
  return {
    status: available ? 'disconnected' : 'error',
    displayLabel: available ? null : 'Codex 运行时未安装',
    quota: { status: 'unknown', primaryUsedPercent: null, secondaryUsedPercent: null, resetsAt: null },
    runtimeVersion,
    lastCheckedAt: null
  };
}

function quotaState(response: RateLimitResponse | null): AccountState['quota'] {
  const window = (value: RateWindow | null | undefined): RateWindow | null => {
    if (!value || !Number.isFinite(value.usedPercent) || value.usedPercent < 0 || value.usedPercent > 100) return null;
    const reset = typeof value.resetsAt === 'number' && Number.isFinite(value.resetsAt)
      && Number.isFinite(new Date(value.resetsAt * 1_000).getTime()) ? value.resetsAt : null;
    return { usedPercent: value.usedPercent, resetsAt: reset };
  };
  const primary = window(response?.rateLimits?.primary);
  const secondary = window(response?.rateLimits?.secondary);
  const used = [primary?.usedPercent, secondary?.usedPercent].filter((value): value is number => typeof value === 'number');
  const status = used.length === 0 ? 'unknown' : used.some((value) => value >= 100) ? 'exhausted' : used.some((value) => value >= 80) ? 'low' : 'available';
  const resetSeconds = [primary?.resetsAt, secondary?.resetsAt].filter((value): value is number => typeof value === 'number').sort((a, b) => a - b)[0];
  return {
    status,
    primaryUsedPercent: primary?.usedPercent ?? null,
    secondaryUsedPercent: secondary?.usedPercent ?? null,
    resetsAt: resetSeconds === undefined ? null : new Date(resetSeconds * 1_000).toISOString()
  };
}

/** 通知只作刷新信号；稳定键仅驻留当前连接内存，不进入账户状态或日志。 */
function rateLimitUpdateKey(notification: unknown): string {
  try {
    return JSON.stringify(notification, (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) : value) ?? 'unavailable';
  } catch { return 'unavailable'; }
}

export class CodexRuntimeManager extends EventEmitter {
  private client: RuntimeClient | null = null;
  private startPromise: Promise<void> | null = null;
  private state: AccountState;
  private readonly now: () => Date;
  private readonly createClient: NonNullable<RuntimeOptions['createClient']>;
  // 在初始化前占位；每次操作只删除自己的 token，旧回执不能释放另一份资料的并行名额。
  private readonly activeRuns = new Map<symbol, ActiveStructuredRun>();
  private readonly turnScheduler: FairModelTurnScheduler;
  private pendingLoginId: string | null = null;
  private loginTimer: NodeJS.Timeout | null = null;
  private accountReadInFlight: { client: RuntimeClient; promise: Promise<AccountState> } | null = null;
  private rateLimitUpdateGeneration = 0;
  private rateLimitRefreshBurst: { client: RuntimeClient; keys: Set<string>; dirty: boolean } | null = null;

  constructor(private readonly options: RuntimeOptions) {
    super();
    this.now = options.now ?? (() => new Date());
    this.turnScheduler = new FairModelTurnScheduler(options.maximumConcurrentTurns ?? CODEX_MAX_CONCURRENT_STRUCTURED_TURNS);
    this.createClient = options.createClient ?? ((input) => spawnCodexAppServer(input).client);
    this.state = initialState(options.runtimeVersion, Boolean(options.executable && existsSync(options.executable)));
  }

  getState(): AccountState {
    return structuredClone(this.state);
  }

  getModelConcurrencyState(): ReturnType<FairModelTurnScheduler['getState']> {
    return this.turnScheduler.getState();
  }

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.client) return;
    const starting = this.startInternal();
    this.startPromise = starting;
    try {
      await starting;
    } finally {
      if (this.startPromise === starting) this.startPromise = null;
    }
  }

  async refreshAccount(): Promise<AccountState> {
    await this.start();
    if (!this.client) throw new Error('CODEX_RUNTIME_UNAVAILABLE');
    return this.readAccountForClient(this.client);
  }

  private readAccountForClient(client: RuntimeClient): Promise<AccountState> {
    if (this.client !== client) return Promise.reject(new Error('CODEX_RUNTIME_EXITED'));
    if (this.accountReadInFlight?.client === client) return this.accountReadInFlight.promise;
    // 先登记共享 promise 再发送 RPC，读取过程中同步到达的通知也不能递归发起新读取。
    const promise = Promise.resolve().then(() => this.performAccountReadForClient(client)).catch((error: unknown) => {
      if (this.client === client) this.setState({ ...this.state, quota: quotaState(null), lastCheckedAt: this.now().toISOString() });
      throw error;
    });
    const flight = { client, promise };
    this.accountReadInFlight = flight;
    const clear = () => { if (this.accountReadInFlight === flight) this.accountReadInFlight = null; };
    void promise.then(clear, clear);
    return promise;
  }

  private async performAccountReadForClient(client: RuntimeClient): Promise<AccountState> {
    if (this.client !== client) throw new Error('CODEX_RUNTIME_EXITED');
    const rateLimitGeneration = this.rateLimitUpdateGeneration;
    const account = await client.request<AccountReadResponse>('account/read', { refreshToken: false });
    if (this.client !== client) throw new Error('CODEX_RUNTIME_EXITED');
    let rates: RateLimitResponse | null = null;
    if (account.account) {
      try {
        rates = await client.request<RateLimitResponse>('account/rateLimits/read');
      } catch {
        rates = null;
      }
    }
    if (this.client !== client) throw new Error('CODEX_RUNTIME_EXITED');
    const displayLabel = account.account?.type === 'chatgpt'
      ? account.account.email ?? `ChatGPT ${account.account.planType}`
      : account.account?.type === 'apiKey' ? 'OpenAI API Key' : account.account?.type === 'amazonBedrock' ? 'Amazon Bedrock' : null;
    this.setState({
      status: account.account ? 'connected' : 'disconnected',
      displayLabel,
      // 该 RPC 启动后若已有新额度信号，旧快照不能被当成通知之后的 fresh available。
      quota: rateLimitGeneration === this.rateLimitUpdateGeneration ? quotaState(rates) : quotaState(null),
      runtimeVersion: this.options.runtimeVersion,
      lastCheckedAt: this.now().toISOString()
    });
    return this.getState();
  }

  private refreshRateLimitsAfterNotification(client: RuntimeClient, notification: unknown): void {
    if (this.client !== client) return;
    const key = rateLimitUpdateKey(notification);
    const running = this.rateLimitRefreshBurst;
    if (running?.client === client) {
      if (running.keys.has(key)) return;
      running.keys.add(key);
      running.dirty = true;
      this.rateLimitUpdateGeneration += 1;
      return;
    }
    this.rateLimitUpdateGeneration += 1;
    const burst = { client, keys: new Set([key]), dirty: false };
    this.rateLimitRefreshBurst = burst;
    void Promise.resolve().then(async () => {
      // 不能把通知前已经开始的 RPC 当成本次 fresh；等旧读结束后再读取。
      const earlierRead = this.accountReadInFlight;
      if (earlierRead?.client === client) await earlierRead.promise.catch(() => undefined);
      // 一个通知 burst 最多两次 fresh 读取；新变化仅获得一次有限尾随，避免回路。
      for (let read = 0; read < 2 && this.client === client; read += 1) {
        burst.dirty = false;
        await this.readAccountForClient(client).catch(() => undefined);
        if (!burst.dirty) break;
      }
      if (burst.dirty && this.client === client) {
        this.setState({ ...this.state, quota: quotaState(null), lastCheckedAt: this.now().toISOString() });
      }
    }).finally(() => {
      // 去重只限这次 burst，未来相同的 sparse 信号仍可启动新的 fresh 读取。
      if (this.rateLimitRefreshBurst === burst) this.rateLimitRefreshBurst = null;
    });
  }

  async startChatGptLogin(): Promise<{ loginId: string; authUrl: string }> {
    await this.start();
    if (!this.client) throw new Error('CODEX_RUNTIME_UNAVAILABLE');
    const client = this.client;
    this.setState({ ...this.state, status: 'connecting', lastCheckedAt: this.now().toISOString() });
    let response: LoginResponse;
    try {
      response = await client.request<LoginResponse>('account/login/start', {
        type: 'chatgpt',
        useHostedLoginSuccessPage: true,
        appBrand: 'chatgpt'
      });
    } catch (error) {
      if (this.client === client) this.setState({ ...this.state, status: 'error', displayLabel: '无法启动登录流程' });
      throw error;
    }
    if (this.client !== client) throw new Error('CODEX_RUNTIME_EXITED');
    if (response.type !== 'chatgpt' || !response.loginId || !response.authUrl) {
      this.setState({ ...this.state, status: 'error', displayLabel: '登录流程不可用' });
      throw new Error('CODEX_LOGIN_RESPONSE_INVALID');
    }
    this.setPendingLogin(response.loginId);
    return { loginId: response.loginId, authUrl: response.authUrl };
  }

  async cancelLogin(loginId: string): Promise<void> {
    if (!this.client) return;
    const client = this.client;
    await client.request('account/login/cancel', { loginId });
    if (this.client !== client) throw new Error('CODEX_RUNTIME_EXITED');
    if (this.pendingLoginId === loginId) this.clearPendingLogin();
    await this.refreshAccount();
  }

  async logout(): Promise<AccountState> {
    await this.start();
    if (!this.client) throw new Error('CODEX_RUNTIME_UNAVAILABLE');
    const client = this.client;
    this.clearPendingLogin();
    await client.request('account/logout');
    if (this.client !== client) throw new Error('CODEX_RUNTIME_EXITED');
    return this.refreshAccount();
  }

  async listModels(): Promise<AiModelOption[]> {
    await this.start();
    if (!this.client) throw new Error('CODEX_RUNTIME_UNAVAILABLE');
    const models: RuntimeModel[] = [];
    let cursor: string | null = null;
    do {
      const response: ModelListResponse = await this.client.request<ModelListResponse>('model/list', {
        cursor,
        limit: 100,
        includeHidden: false
      });
      models.push(...response.data);
      cursor = response.nextCursor;
    } while (cursor);

    return models.flatMap((model) => {
      if (model.hidden || !model.inputModalities.includes('text') || !model.inputModalities.includes('image')) return [];
      const supportedReasoningEfforts = model.supportedReasoningEfforts.flatMap((option) => {
        const parsed = aiReasoningEffortSchema.safeParse(option.reasoningEffort);
        return parsed.success ? [{ reasoningEffort: parsed.data, description: option.description }] : [];
      });
      if (supportedReasoningEfforts.length === 0) return [];
      const defaultEffort = aiReasoningEffortSchema.safeParse(model.defaultReasoningEffort);
      return [aiModelOptionSchema.parse({
        id: model.model,
        displayName: model.displayName,
        description: model.description,
        supportedReasoningEfforts,
        defaultReasoningEffort: defaultEffort.success && supportedReasoningEfforts.some((item) => item.reasoningEffort === defaultEffort.data)
          ? defaultEffort.data
          : supportedReasoningEfforts[0]!.reasoningEffort,
        isDefault: model.isDefault
      })];
    });
  }

  async runStructuredTurn<T>(input: {
    prompt: string;
    imagePaths?: string[];
    outputSchema: Record<string, unknown>;
    aiPreferences: AiPreferences;
    allowWebSearch?: boolean;
    timeoutMs?: number;
    expectedAccountFingerprint?: string;
    runScope?: StructuredTurnScope;
    /** 获得名额之后、实际发送之前重验授权和任务状态；不将此回调传给模型。 */
    assertExecutionActive?: () => void;
    /** 只控制新发送，不丢弃另一任务已成功返回、仍有效的结果。 */
    assertRequestAllowed?: () => void;
    /** 名额交给下一位之前同步通知执行器，限流/写满不能让等待者抢先发送。 */
    onRequestFailure?: (error: unknown) => void;
    recovery?: RuntimeTurnRecoveryHooks;
  }): Promise<{ threadId: string; turnId: string; output: T; metrics: TurnMetrics }> {
    const startedAtMs = Date.now();
    let cancelled: Error | null = null;
    let completion: ReturnType<CodexRuntimeManager['waitForTurn']> | null = null;
    let releasePermit: ModelTurnRelease | null = null;
    let permitGrantedAtMs: number;
    let modelStartedAtMs: number;
    let successfullyCompleted = false;
    const controller = new AbortController();
    // 整次操作在初始化和首个 RPC 前就占有独立取消引用；旧操作只能清自己的代际。
    const cancelRun = (reason?: Error) => {
      if (cancelled) return;
      cancelled ??= reason ?? new Error('CODEX_RUNTIME_EXITED');
      controller.abort(cancelled);
      completion?.cancel(cancelled);
      // 连接退出由进程关闭终止全部轮次，不向已退出的连接追加 RPC。
      if (run.client && run.turn && cancelled.message !== 'CODEX_RUNTIME_EXITED') {
        run.interruptPromise = run.client.request('turn/interrupt', run.turn).then(() => undefined, () => undefined);
      }
    };
    const token = Symbol('structured-turn');
    const run: ActiveStructuredRun = { client: null, threadId: null, turn: null,
      fingerprint: input.expectedAccountFingerprint ?? (this.state.status === 'connected' && this.state.displayLabel
        ? stableHash({ provider: 'codex-chatgpt', displayLabel: this.state.displayLabel }) : null),
      interruptPromise: null, scope: input.runScope ?? null, cancel: cancelRun };
    this.activeRuns.set(token, run);
    try {
    releasePermit = await this.turnScheduler.acquire(input.runScope?.jobId ?? 'unscoped', controller.signal);
    permitGrantedAtMs = Date.now();
    if (cancelled) throw cancelled;
    input.assertExecutionActive?.();
    input.assertRequestAllowed?.();
    await this.start();
    if (cancelled) throw cancelled;
    if (!this.client) throw new Error('CODEX_RUNTIME_UNAVAILABLE');
    const client = this.client;
    run.client = client;
    this.assertExpectedAccountFingerprint(input.expectedAccountFingerprint);
    if (this.state.status !== 'connected') throw new Error('CODEX_AUTH_REQUIRED');
    // 即使旧调用未传冻结键，也把本轮绑定到开始时实际连接的帐号。
    run.fingerprint = input.expectedAccountFingerprint
      ?? stableHash({ provider: 'codex-chatgpt', displayLabel: this.state.displayLabel });
    const allowWebSearch = input.allowWebSearch === true;
    input.assertExecutionActive?.();
    input.assertRequestAllowed?.();
    let recoveryState = input.recovery?.read() ?? null;
    const persist = (next: RuntimeTurnRecovery) => {
      input.assertExecutionActive?.();
      const checked = runtimeTurnRecoverySchema.parse(next);
      input.recovery?.save(checked); recoveryState = checked;
    };
    const diagnostic = (event: RuntimeRecoveryDiagnostic) => {
      // 诊断不替代正常授权和接纳事务；关闭/撤权后不能靠迟到日志写生产库。
      try { input.assertExecutionActive?.(); input.recovery?.diagnostic(event); } catch { /* 保留原始执行/传输错误。 */ }
    };
    const startup = <R>(method: 'thread/start' | 'turn/start', params: unknown,
      extra: Pick<RpcRecoveryOptions, 'receiptFromNotification' | 'onLateResult'> = {}): Promise<R> => {
      const recovery: RpcRecoveryOptions = { lateReplyMs: HEALTH_STARTUP_RECEIPT_GRACE_MS,
        signal: controller.signal, ...extra, onLifecycle: event => {
          if (event.phase === 'sent') { input.assertExecutionActive?.(); input.assertRequestAllowed?.(); }
          diagnostic({ kind: `startup_${event.phase}`, method, requestId: event.requestId,
            elapsedMs: Math.min(event.elapsedMs, 86_400_000), count: 0,
            threadId: recoveryState?.threadId ?? null, turnId: recoveryState?.turnId ?? null, failureCode: null });
        } };
      return client.requestWithRecovery
        ? client.requestWithRecovery<R>(method, params, recovery, this.options.startupRequestTimeoutMs)
        : client.request<R>(method, params, this.options.startupRequestTimeoutMs);
    };
    // 不明发送状态只能读取原 thread 核实；重启或普通重试不能自动变成新 turn/start。
    const resuming = recoveryState !== null && (['turn_starting', 'turn_running'].includes(recoveryState.phase)
      || recoveryState.phase === 'turn_terminal' && recoveryState.terminalStatus === 'completed');
    let threadId: string;
    if (resuming) threadId = recoveryState!.threadId!;
    else {
      if ((recoveryState?.threadStarts ?? 0) >= 3 || (recoveryState?.turnStarts ?? 0) >= 3) throw new Error('CODEX_START_RECOVERY_EXHAUSTED');
      persist({ version: 1, phase: 'thread_starting', threadStarts: (recoveryState?.threadStarts ?? 0) + 1,
        turnStarts: recoveryState?.turnStarts ?? 0, threadId: null, turnId: null,
        turnStartedAt: recoveryState?.turnStartedAt ?? null, terminalStatus: null,
        connectionErrorCount: recoveryState?.connectionErrorCount ?? 0, connectionRecoveryStartedAt: null });
      const thread = await startup<{ thread: { id: string } }>('thread/start', createHealthThreadStartParams({
        workingDirectory: this.options.workingDirectory, aiPreferences: input.aiPreferences, allowWebSearch }));
      if (!thread?.thread?.id) throw new Error('CODEX_START_RECEIPT_INVALID');
      threadId = thread.thread.id;
      persist({ ...recoveryState!, phase: 'thread_ready', threadId });
    }
    if (cancelled) throw cancelled;
    if (this.client !== client) throw new Error('CODEX_RUNTIME_EXITED');
    run.threadId = threadId;
    await this.verifyExpectedAccountFingerprint(run.fingerprint, client);
    if (cancelled) throw cancelled;
    input.assertExecutionActive?.();
    input.assertRequestAllowed?.();
    completion = this.waitForTurn(
      threadId,
      input.timeoutMs ?? this.options.requestTimeoutMs ?? HEALTH_MODEL_TURN_TIMEOUT_MS,
      { initial: resuming ? recoveryState : null, diagnostic,
        saveConnection: fields => { if (recoveryState) persist({ ...recoveryState, ...fields }); } }
    );
    // turn/start 回执之前也可能先收到终态，不让早到的拒绝变成未处理 Promise。
    void completion.promise.catch(() => undefined);
    let started: { turn: { id: string } };
    try {
      // 本次耗时不重复计算旧尝试；绝对截止时间仍由持久 turnStartedAt 约束。
      modelStartedAtMs = Date.now();
      if (resuming) {
        diagnostic({ kind: 'state_probe', method: 'thread/read', requestId: null, elapsedMs: 0, count: 0,
          threadId, turnId: recoveryState!.turnId, failureCode: null });
        let turn: TurnCompleted['turn'] | undefined;
        try {
          // 独立新建的 thread 只能拥有本请求这一轮；不从相似正文或其他 thread 猜结果。
          const read = await client.request<{ thread: { id: string; turns?: TurnCompleted['turn'][] } }>('thread/read', { threadId, includeTurns: true });
          const turns = read?.thread?.id === threadId ? read.thread.turns : undefined;
          if (Array.isArray(turns) && turns.length === 1
            && (!recoveryState!.turnId || turns[0]!.id === recoveryState!.turnId)) turn = turns[0];
        } catch { /* ephemeral 已丢失或回执不可读不能证明请求未被服务接受。 */ }
        if (!turn?.id || !Array.isArray(turn.items) || !['inProgress','completed','failed','interrupted'].includes(turn.status)) {
          diagnostic({ kind: 'state_unknown', method: 'thread/read', requestId: null, elapsedMs: 0, count: 0,
            threadId, turnId: recoveryState!.turnId, failureCode: null });
          throw new Error('CODEX_START_STATE_UNKNOWN');
        }
        started = { turn: { id: turn.id } };
        completion.setTurnId(turn.id);
        if (turn.status !== 'inProgress') completion.acceptSnapshot({ threadId, turn });
      } else {
      persist({ ...recoveryState!, phase: 'turn_starting', turnStarts: recoveryState!.turnStarts + 1,
        turnStartedAt: new Date(modelStartedAtMs).toISOString(), connectionErrorCount: 0, connectionRecoveryStartedAt: null });
      const receiptFromNotification: RpcRecoveryOptions['receiptFromNotification'] = (method, params) => {
        const value = params as { threadId?: string; turn?: { id?: string; status?: string } } | null;
        return ['turn/started','turn/completed'].includes(method) && value?.threadId === threadId
          && typeof value.turn?.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(value.turn.id)
          ? { turn: { id: value.turn.id } } : undefined;
      };
      started = await startup<{ turn: { id: string } }>('turn/start', {
        threadId,
        model: input.aiPreferences.modelId,
        effort: input.aiPreferences.reasoningEffort,
        input: [
          { type: 'text', text: input.prompt, text_elements: [] },
          ...(input.imagePaths ?? []).map((path) => ({ type: 'localImage', path, detail: 'original' }))
        ],
        cwd: this.options.workingDirectory,
        runtimeWorkspaceRoots: [],
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        environments: [],
        outputSchema: toCodexOutputSchema(input.outputSchema)
      }, { receiptFromNotification, onLateResult: result => {
        const value = result as { turn?: { id?: string } } | null;
        if (typeof value?.turn?.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(value.turn.id)) return;
        const adopted = [...this.activeRuns.values()].some(active => active !== run && active.client === client && active.threadId === threadId);
        if (adopted) return;
        if (cancelled) void client.request('turn/interrupt', { threadId, turnId: value.turn.id }).catch(() => undefined);
        else if (this.client === client && this.state.status === 'connected'
          && stableHash({ provider: 'codex-chatgpt', displayLabel: this.state.displayLabel }) === run.fingerprint) {
          // 超时不是用户取消。只补齐已发送请求的收据，不静默丢掉已开始的工作，也不接受医疗结果。
          input.recovery?.lateReceipt?.(threadId, value.turn.id);
        }
      } });
      }
      if (cancelled || this.client !== client) {
        const error = cancelled ?? new Error('CODEX_RUNTIME_EXITED');
        completion.cancel(error);
        completion.setTurnId(started.turn.id);
        throw error;
      }
    } catch (error) {
      completion.cancel();
      throw error;
    }
    run.turn = { threadId, turnId: started.turn.id };
    persist({ ...recoveryState!, phase: 'turn_running', turnId: started.turn.id, terminalStatus: null });
    completion.setTurnId(started.turn.id);
      const capture = await completion.promise;
      const modelFinishedAtMs = Date.now();
      await this.verifyExpectedAccountFingerprint(run.fingerprint, client);
      if (cancelled) throw cancelled;
      input.assertExecutionActive?.();
      const notification = capture.notification;
      if (['completed','failed','interrupted'].includes(notification.turn.status)) persist({ ...recoveryState!,
        phase: 'turn_terminal', terminalStatus: notification.turn.status as 'completed' | 'failed' | 'interrupted' });
      if (notification.turn.status !== 'completed') throw createCodexTurnFailure({
        threadId: notification.threadId, turnId: notification.turn.id,
        status: notification.turn.status, error: notification.turn.error
      });
      // 正式完成条目优先于未完增量；旧过程消息不能盖过另一来源的完整最终输出。
      const message = latestAgentMessage(notification.turn.items, 'final_answer')
        ?? latestAgentMessage(capture.completedMessages, 'final_answer')
        // 兼容旧协议无phase的正式完成条目，不把明确commentary或无阶段partial流冒充最终结果。
        ?? latestAgentMessage(notification.turn.items, 'unphased')
        ?? latestAgentMessage(capture.completedMessages, 'unphased')
        // 完成条目缺失时，只用已有final_answer阶段证据的增量；不拼不同item，不按JSON长相猜测。
        ?? latestAgentMessage(capture.streamedMessages, 'final_answer');
      if (!message?.text) throw new Error('CODEX_STRUCTURED_OUTPUT_MISSING');
      let parsedOutput: unknown;
      try {
        parsedOutput = JSON.parse(message.text);
      } catch {
        // 仅把明确的模型返回格式错误交给有限恢复；不泄露正文，也不吞其他执行错误。
        throw new Error('CODEX_STRUCTURED_OUTPUT_INVALID');
      }
      successfullyCompleted = true;
      return {
        threadId: notification.threadId, turnId: notification.turn.id,
        output: restoreCodexOptionalFields(parsedOutput, input.outputSchema) as T,
        metrics: {
          durationMs: Math.max(0, Date.now() - startedAtMs),
          timingVersion: 2,
          queueWaitMs: Math.max(0, permitGrantedAtMs - startedAtMs),
          runtimeSetupMs: Math.max(0, modelStartedAtMs - permitGrantedAtMs),
          modelDurationMs: Math.max(0, modelFinishedAtMs - modelStartedAtMs),
          totalDurationMs: Math.max(0, Date.now() - startedAtMs),
          modelStartedAt: new Date(modelStartedAtMs).toISOString(),
          ...webSearchMetrics(capture),
          inputTokens: capture.tokenUsage?.inputTokens ?? null,
          outputTokens: capture.tokenUsage?.outputTokens ?? null,
          cachedInputTokens: capture.tokenUsage?.cachedInputTokens ?? null
        }
      };
    } catch (error) {
      const failure = getCodexTurnFailureDetails(error);
      if (failure?.modelBusy || failure?.httpStatus === 429
        || ['CODEX_QUOTA_EXHAUSTED', 'CODEX_RATE_LIMITED', 'CODEX_REQUEST_LIMITED_UNKNOWN'].includes(failure?.code ?? '')) {
        this.turnScheduler.noteSaturation();
      }
      input.onRequestFailure?.(error);
      throw error;
    } finally {
      completion?.cancel();
      this.activeRuns.delete(token);
      releasePermit?.(successfullyCompleted ? 'success' : undefined);
    }
  }

  async interruptActiveTurn(scope?: { jobId: string; attemptId?: string }): Promise<void> {
    // 单任务取消包括尚未取得名额的请求；退出/注销未传范围时才取消全部。
    const runs = [...this.activeRuns.values()].filter((run) => !scope || (run.scope?.jobId === scope.jobId
      && (scope.attemptId === undefined || run.scope.attemptId === scope.attemptId)));
    for (const run of runs) run.cancel(run.turn
      ? createCodexTurnFailure({ ...run.turn, status: 'interrupted', error: null })
      : new Error('CODEX_TURN_INTERRUPTED'));
    await Promise.all(runs.map((run) => run.interruptPromise));
  }

  shutdown(): void {
    this.clearPendingLogin();
    for (const run of this.activeRuns.values()) run.cancel(new Error('CODEX_RUNTIME_EXITED'));
    this.turnScheduler.resetCooldown();
    const client = this.client;
    this.client = null;
    this.startPromise = null;
    this.accountReadInFlight = null;
    this.rateLimitRefreshBurst = null;
    this.rateLimitUpdateGeneration = 0;
    this.activeRuns.clear();
    client?.shutdown();
  }

  private async startInternal(): Promise<void> {
    if (!this.options.executable || !existsSync(this.options.executable)) {
      this.setState(initialState(this.options.runtimeVersion, false));
      throw new Error('CODEX_RUNTIME_UNAVAILABLE');
    }
    mkdirSync(this.options.codexHome, { recursive: true, mode: 0o700 });
    mkdirSync(this.options.workingDirectory, { recursive: true, mode: 0o700 });
    const client = this.createClient({ executable: this.options.executable, codexHome: this.options.codexHome, cwd: this.options.workingDirectory });
    // 每条模型轮次各有生命周期监听器，加上连接自身监听器；只提高到有界并发所需容量。
    if (client.getMaxListeners() !== 0) client.setMaxListeners(Math.max(client.getMaxListeners(),
      CODEX_MAX_CONCURRENT_STRUCTURED_TURNS + 4));
    this.client = client;
    this.rateLimitRefreshBurst = null;
    this.rateLimitUpdateGeneration = 0;
    client.on('account/login/completed', (notification: { loginId?: string | null; success?: boolean; error?: string | null }) => {
      if (this.client !== client) return;
      if (!this.pendingLoginId || (notification.loginId && notification.loginId !== this.pendingLoginId)) return;
      this.clearPendingLogin();
      if (notification.success) void this.refreshAccount().catch(() => {
        if (this.client === client) this.setState({ ...this.state, status: 'error', displayLabel: '账户状态读取失败' });
      });
      else this.setState({ ...this.state, status: 'error', displayLabel: notification.error ?? '登录未完成' });
    });
    client.on('account/updated', () => {
      if (this.client !== client) return;
      void this.refreshAccount().catch(() => undefined);
    });
    client.on('account/rateLimits/updated', (notification: unknown) => {
      // rolling 通知可缺窗口或带 null，不能用它覆盖完整额度；沿正常同账户路径 fresh read。
      this.refreshRateLimitsAfterNotification(client, notification);
    });
    client.on('processExit', () => {
      if (this.client !== client) return;
      for (const run of this.activeRuns.values()) run.cancel(new Error('CODEX_RUNTIME_EXITED'));
      this.turnScheduler.resetCooldown();
      this.client = null;
      this.setState({ ...this.state, status: 'error', displayLabel: 'Codex 运行时已退出' });
    });
    client.on('processError', () => {
      if (this.client !== client) return;
      for (const run of this.activeRuns.values()) run.cancel(new Error('CODEX_RUNTIME_EXITED'));
      this.turnScheduler.resetCooldown();
      this.client = null;
      this.setState({ ...this.state, status: 'error', displayLabel: 'Codex 运行时启动失败' });
    });
    await client.initialize();
    if (this.client !== client) throw new Error('CODEX_RUNTIME_EXITED');
    await this.readAccountForClient(client);
  }

  private waitForTurn(threadId: string, timeoutMs: number, recovery?: {
    initial: RuntimeTurnRecovery | null;
    diagnostic(event: RuntimeRecoveryDiagnostic): void;
    saveConnection(fields: Pick<RuntimeTurnRecovery, 'connectionErrorCount' | 'connectionRecoveryStartedAt'>): void;
  }): {
    promise: Promise<CompletedTurnCapture>; setTurnId(turnId: string): void; cancel(reason?: Error): void;
    acceptSnapshot(notification: TurnCompleted): void
  } {
    let expectedTurnId: string | null = null;
    let settled = false;
    const startedAtMs = Date.now();
    const earlyCompletions = new Map<string, TurnCompleted>();
    const earlyErrors = new Map<string, Error>();
    const earlyProgressAt = new Map<string, number>();
    const lifecycleProgress = new Set<string>();
    let resolvePromise!: (value: CompletedTurnCapture) => void;
    let cleanupExternal: () => void = () => undefined;
    let rejectExternal: (error: Error) => void = () => undefined;
    let applyEarlyProgress: (time: number) => void = () => undefined;
    let applyConnectionRecovery: () => void = () => undefined;
    let applyAbsoluteDeadline: () => void = () => undefined;
    let acceptSnapshot: (notification: TurnCompleted) => void = () => undefined;
    const connectionRecoveries = new Map<string, { startedAt: number; retries: number; error: Error }>();
    const connectionTotals = new Map<string, number>();
    if (recovery?.initial?.turnId) {
      connectionTotals.set(recovery.initial.turnId, recovery.initial.connectionErrorCount);
      if (recovery.initial.connectionRecoveryStartedAt) connectionRecoveries.set(recovery.initial.turnId, {
        startedAt: Date.parse(recovery.initial.connectionRecoveryStartedAt), retries: recovery.initial.connectionErrorCount,
        error: createCodexTurnFailure({ threadId, turnId: recovery.initial.turnId, status: 'failed',
          error: { codexErrorInfo: 'responseStreamDisconnected' } }) });
    }
    const completedMessages = new Map<string, Map<string, TurnItem>>();
    const completedWebSearchItems = new Map<string, Map<string, TurnItem>>();
    const tokenUsageByTurn = new Map<string, CompletedTurnCapture['tokenUsage']>();
    const streamedMessageText = new Map<string, Map<string, string>>();
    const streamedMessagePhase = new Map<string, Map<string, string | null>>();
    const streamedMessageOrder = new Map<string, string[]>();
    if (!this.client) {
      return {
        promise: Promise.reject(new Error('CODEX_RUNTIME_UNAVAILABLE')),
        setTurnId: () => undefined,
        cancel: () => undefined,
        acceptSnapshot: () => undefined
      };
    }
    const client = this.client;
    const captureFor = (notification: TurnCompleted): CompletedTurnCapture => {
      const turnId = notification.turn.id;
      const completed = [...(completedMessages.get(turnId)?.values() ?? [])];
      const textByItem = streamedMessageText.get(turnId);
      const phaseByItem = streamedMessagePhase.get(turnId);
      const streamed = (streamedMessageOrder.get(turnId) ?? []).flatMap((itemId) => {
        const text = textByItem?.get(itemId);
        return text ? [{ id: itemId, type: 'agentMessage', phase: phaseByItem?.get(itemId) ?? null, text }] : [];
      });
      return { notification, completedMessages: completed, streamedMessages: streamed,
        completedWebSearchItems: [...(completedWebSearchItems.get(turnId)?.values() ?? [])],
        tokenUsage: tokenUsageByTurn.get(turnId) ?? null };
    };
    const promise = new Promise<CompletedTurnCapture>((resolve, reject) => {
      resolvePromise = resolve;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      let absoluteTimer: ReturnType<typeof setTimeout> | null = null;
      let connectionTimer: ReturnType<typeof setTimeout> | null = null;
      const matches = (eventThreadId: string, turnId: string) => !settled && eventThreadId === threadId
        && typeof turnId === 'string' && turnId.length > 0 && (expectedTurnId === null || turnId === expectedTurnId);
      const fail = (error: Error, interrupt = false) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (interrupt && expectedTurnId) void client.request('turn/interrupt', { threadId, turnId: expectedTurnId }).catch(() => undefined);
        reject(error);
      };
      const traceConnection = (kind: RuntimeRecoveryDiagnostic['kind'], turnId: string | null, failureCode: RuntimeRecoveryDiagnostic['failureCode'] = null) => {
        recovery?.diagnostic({ kind, method: 'error', requestId: null, elapsedMs: Math.min(Math.max(0, Date.now() - startedAtMs), 86_400_000),
          count: turnId ? connectionTotals.get(turnId) ?? 0 : 0, threadId, turnId, failureCode });
      };
      const persistConnection = (turnId: string) => {
        try { recovery?.saveConnection({ connectionErrorCount: connectionTotals.get(turnId) ?? 0,
          connectionRecoveryStartedAt: connectionRecoveries.has(turnId)
            ? new Date(connectionRecoveries.get(turnId)!.startedAt).toISOString() : null }); }
        catch (error) { fail(error instanceof Error ? error : new Error('RUNTIME_RECOVERY_WRITE_FAILED'), true); }
      };
      const timeout = () => fail(expectedTurnId
        ? createCodexTurnFailure({ threadId, turnId: expectedTurnId, status: 'timeout', error: null })
        : new Error('CODEX_TURN_TIMEOUT'), true);
      const armIdleAt = (progressAtMs: number) => {
        if (settled) return;
        if (idleTimer !== null) clearTimeout(idleTimer);
        const remaining = progressAtMs + timeoutMs - Date.now();
        if (remaining <= 0) { timeout(); return; }
        idleTimer = setTimeout(timeout, remaining);
      };
      const noteProgress = (turnId: string) => {
        const arrivedAt = Date.now();
        // turn/start 的 RPC 回执可晚于流事件。先留真实到达时刻，确认 ID 后才用于延时。
        if (expectedTurnId === null) earlyProgressAt.set(turnId, arrivedAt);
        else armIdleAt(arrivedAt);
      };
      const armConnectionRecovery = () => {
        if (connectionTimer !== null) clearTimeout(connectionTimer);
        connectionTimer = null;
        const recovery = expectedTurnId ? connectionRecoveries.get(expectedTurnId) : null;
        if (settled || !recovery) return;
        const remaining = recovery.startedAt + HEALTH_CONNECTION_RECOVERY_TIMEOUT_MS - Date.now();
        if (remaining <= 0 || recovery.retries >= HEALTH_CONNECTION_RECOVERY_RETRY_LIMIT) {
          traceConnection('connection_budget_exhausted', expectedTurnId, 'CODEX_CONNECTION_FAILED');
          fail(recovery.error, true); return;
        }
        connectionTimer = setTimeout(() => {
          traceConnection('connection_budget_exhausted', expectedTurnId, 'CODEX_CONNECTION_FAILED'); fail(recovery.error, true);
        }, remaining);
      };
      const noteContentProgress = (turnId: string, text: unknown) => {
        // 新建 reasoning/item、重复重连及 token 计费通知不证明连接已恢复。
        if (typeof text !== 'string' || !text.trim()) return;
        const resumed = connectionRecoveries.delete(turnId);
        if (resumed) { persistConnection(turnId); traceConnection('connection_content_resumed', turnId); }
        if (expectedTurnId === turnId) armConnectionRecovery();
      };
      const noteLifecycle = (notification: ItemLifecycleNotification, phase: 'started' | 'completed') => {
        if (!matches(notification.threadId, notification.turnId) || typeof notification.item?.id !== 'string'
          || notification.item.id.length === 0
          || !['agentMessage', 'reasoning', 'webSearch', 'contextCompaction'].includes(notification.item.type)) return;
        const key = `${notification.turnId}:${notification.item.id}:${phase}`;
        if (lifecycleProgress.has(key)) return;
        lifecycleProgress.add(key);
        noteProgress(notification.turnId);
      };
      const rememberMessageOrder = (turnId: string, itemId: string) => {
        const order = streamedMessageOrder.get(turnId) ?? [];
        if (!order.includes(itemId)) order.push(itemId);
        streamedMessageOrder.set(turnId, order);
      };
      const onItemStarted = (notification: ItemLifecycleNotification) => {
        noteLifecycle(notification, 'started');
        if (!matches(notification.threadId, notification.turnId) || typeof notification.item?.id !== 'string'
          || notification.item.id.length === 0 || notification.item.type !== 'agentMessage') return;
        const phases = streamedMessagePhase.get(notification.turnId) ?? new Map<string, string | null>();
        phases.set(notification.item.id, notification.item.phase ?? null);
        streamedMessagePhase.set(notification.turnId, phases);
        rememberMessageOrder(notification.turnId, notification.item.id);
      };
      const onItemCompleted = (notification: ItemLifecycleNotification) => {
        noteLifecycle(notification, 'completed');
        if (!matches(notification.threadId, notification.turnId) || typeof notification.item?.id !== 'string'
          || notification.item.id.length === 0) return;
        if (notification.item.type === 'webSearch') {
          const items = completedWebSearchItems.get(notification.turnId) ?? new Map<string, TurnItem>();
          items.set(notification.item.id, notification.item);
          completedWebSearchItems.set(notification.turnId, items);
          return;
        }
        if (notification.item.type !== 'agentMessage') return;
        noteContentProgress(notification.turnId, notification.item.text);
        const messages = completedMessages.get(notification.turnId) ?? new Map<string, TurnItem>();
        messages.set(notification.item.id, notification.item);
        completedMessages.set(notification.turnId, messages);
        const phases = streamedMessagePhase.get(notification.turnId) ?? new Map<string, string | null>();
        phases.set(notification.item.id, notification.item.phase ?? null);
        streamedMessagePhase.set(notification.turnId, phases);
        rememberMessageOrder(notification.turnId, notification.item.id);
      };
      const onAgentMessageDelta = (notification: AgentMessageDeltaNotification) => {
        if (!matches(notification.threadId, notification.turnId) || typeof notification.itemId !== 'string'
          || !notification.itemId.length || typeof notification.delta !== 'string' || !notification.delta.length) return;
        noteProgress(notification.turnId);
        noteContentProgress(notification.turnId, notification.delta);
        const messages = streamedMessageText.get(notification.turnId) ?? new Map<string, string>();
        messages.set(notification.itemId, `${messages.get(notification.itemId) ?? ''}${notification.delta}`);
        streamedMessageText.set(notification.turnId, messages);
        rememberMessageOrder(notification.turnId, notification.itemId);
      };
      const onReasoningTextDelta = (notification: ReasoningTextDeltaNotification) => {
        if (matches(notification.threadId, notification.turnId) && typeof notification.itemId === 'string'
          && notification.itemId.length > 0 && typeof notification.delta === 'string' && notification.delta.length > 0
          && Number.isInteger(notification.contentIndex) && notification.contentIndex >= 0) {
          noteProgress(notification.turnId); noteContentProgress(notification.turnId, notification.delta);
        }
      };
      const onReasoningSummaryDelta = (notification: ReasoningSummaryTextDeltaNotification) => {
        if (matches(notification.threadId, notification.turnId) && typeof notification.itemId === 'string'
          && notification.itemId.length > 0 && typeof notification.delta === 'string' && notification.delta.length > 0
          && Number.isInteger(notification.summaryIndex) && notification.summaryIndex >= 0) {
          noteProgress(notification.turnId); noteContentProgress(notification.turnId, notification.delta);
        }
      };
      const onTokenUsageUpdated = (notification: {
        threadId: string; turnId: string;
        tokenUsage?: { total?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } };
      }) => {
        if (!matches(notification.threadId, notification.turnId)) return;
        // 每次调用新建 thread；total 含本轮搜索前后所有模型响应，last 只含最后一次响应。
        const total = notification.tokenUsage?.total;
        if (!total || !Number.isFinite(total.inputTokens) || !Number.isFinite(total.outputTokens)
          || !Number.isFinite(total.cachedInputTokens) || total.inputTokens! < 0
          || total.outputTokens! < 0 || total.cachedInputTokens! < 0) return;
        tokenUsageByTurn.set(notification.turnId, {
          inputTokens: total.inputTokens!, outputTokens: total.outputTokens!, cachedInputTokens: total.cachedInputTokens!
        });
      };
      const onCompleted = (notification: TurnCompleted) => {
        if (!notification.turn || !matches(notification.threadId, notification.turn.id)) return;
        if (expectedTurnId === null) { earlyCompletions.set(notification.turn.id, notification); return; }
        const capture = captureFor(notification);
        settled = true;
        cleanup();
        resolve(capture);
      };
      const onServerError = (notification: ErrorNotification | null) => {
        if (!notification || !matches(notification.threadId, notification.turnId)) {
          // 仅记“未关联”，不能把其他任务的正文或标识拼进本任务诊断。
          if (!settled) traceConnection('connection_ignored_unmatched', null);
          return;
        }
        const error = createCodexTurnFailure({ threadId, turnId: notification.turnId, status: 'failed', error: notification.error });
        if (notification.willRetry === true) {
          if (error.details.code !== 'CODEX_CONNECTION_FAILED') {
            traceConnection('connection_ignored_unclassified', notification.turnId,
              ['CODEX_QUOTA_EXHAUSTED','CODEX_RATE_LIMITED','CODEX_REQUEST_LIMITED_UNKNOWN','CODEX_MODEL_BUSY'].includes(error.details.code)
                ? error.details.code as RuntimeRecoveryDiagnostic['failureCode'] : 'OTHER');
            // 认证、额度和明确限流不能被运行时的 willRetry 包装为无限连接恢复。
            if (['CODEX_QUOTA_EXHAUSTED','CODEX_RATE_LIMITED','CODEX_REQUEST_LIMITED_UNKNOWN'].includes(error.details.code)
              || error.details.httpStatus === 401 || error.details.httpStatus === 403) fail(error, true);
            return;
          }
          const previous = connectionRecoveries.get(notification.turnId);
          const total = (connectionTotals.get(notification.turnId) ?? 0) + 1;
          connectionTotals.set(notification.turnId, total);
          connectionRecoveries.set(notification.turnId, { startedAt: previous?.startedAt ?? Date.now(),
            retries: total, error });
          persistConnection(notification.turnId); traceConnection('connection_retry', notification.turnId, 'CODEX_CONNECTION_FAILED');
          armConnectionRecovery();
          return;
        }
        if (notification.willRetry !== false) return;
        if (expectedTurnId === null) earlyErrors.set(notification.turnId, error);
        else fail(error);
      };
      const onExit = () => fail(new Error('CODEX_RUNTIME_EXITED'));
      const onProcessError = () => fail(new Error('CODEX_RUNTIME_EXITED'));
      const cleanup = () => {
        if (idleTimer !== null) clearTimeout(idleTimer);
        if (absoluteTimer !== null) clearTimeout(absoluteTimer);
        if (connectionTimer !== null) clearTimeout(connectionTimer);
        connectionTimer = null;
        idleTimer = absoluteTimer = null;
        client.off('turn/completed', onCompleted);
        client.off('item/started', onItemStarted);
        client.off('item/completed', onItemCompleted);
        client.off('item/agentMessage/delta', onAgentMessageDelta);
        client.off('item/reasoning/textDelta', onReasoningTextDelta);
        client.off('item/reasoning/summaryTextDelta', onReasoningSummaryDelta);
        client.off('thread/tokenUsage/updated', onTokenUsageUpdated);
        client.off('serverError', onServerError);
        client.off('processExit', onExit);
        client.off('processError', onProcessError);
      };
      cleanupExternal = cleanup;
      acceptSnapshot = onCompleted;
      rejectExternal = fail;
      applyEarlyProgress = armIdleAt;
      applyConnectionRecovery = armConnectionRecovery;
      client.on('turn/completed', onCompleted);
      client.on('item/started', onItemStarted);
      client.on('item/completed', onItemCompleted);
      client.on('item/agentMessage/delta', onAgentMessageDelta);
      client.on('item/reasoning/textDelta', onReasoningTextDelta);
      client.on('item/reasoning/summaryTextDelta', onReasoningSummaryDelta);
      client.on('thread/tokenUsage/updated', onTokenUsageUpdated);
      client.on('serverError', onServerError);
      client.on('processExit', onExit);
      client.on('processError', onProcessError);
      applyAbsoluteDeadline = () => {
        if (absoluteTimer !== null || settled) return;
        const originalStartedAt = recovery?.initial?.turnStartedAt ? Date.parse(recovery.initial.turnStartedAt) : startedAtMs;
        absoluteTimer = setTimeout(timeout, Math.max(0, originalStartedAt + HEALTH_MODEL_TURN_MAX_DURATION_MS - Date.now()));
      };
      // 先读取已发送轮次的真实状态：已完成回包即使隔天恢复也可复用；仍在运行才沿用原截止时间。
      if (!recovery?.initial) applyAbsoluteDeadline();
      armIdleAt(startedAtMs);
    });
    return {
      promise,
      setTurnId: (turnId) => {
        if (expectedTurnId === turnId) return;
        if (settled) {
          // 在等待已结束后才到达的 turn/start 不能复活，也不能留下仍在后台输出的轮次。
          void client.request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
          return;
        }
        expectedTurnId = turnId;
        applyAbsoluteDeadline();
        applyConnectionRecovery();
        if (settled) return;
        const earlyError = earlyErrors.get(turnId);
        const earlyCompletion = earlyCompletions.get(turnId);
        if (earlyError) rejectExternal(earlyError);
        else if (earlyCompletion) {
          const capture = captureFor(earlyCompletion);
          settled = true;
          cleanupExternal();
          resolvePromise(capture);
        } else if (earlyProgressAt.has(turnId)) applyEarlyProgress(earlyProgressAt.get(turnId)!);
        earlyCompletions.clear(); earlyErrors.clear(); earlyProgressAt.clear();
      },
      acceptSnapshot,
      cancel: (reason) => {
        if (reason) rejectExternal(reason);
        else { settled = true; cleanupExternal(); }
      }
    };
  }

  private setState(next: AccountState): void {
    const changedAccount = this.state.status === 'connected'
      && (next.status !== 'connected' || next.displayLabel !== this.state.displayLabel);
    this.state = next;
    for (const run of this.activeRuns.values()) {
      if (run.fingerprint && !this.matchesAccountFingerprint(run.fingerprint)) run.cancel(new Error('JOB_AUTH_ACCOUNT_CHANGED'));
    }
    if (changedAccount) this.turnScheduler.resetCooldown();
    this.emit('stateChanged', this.getState());
  }

  private matchesAccountFingerprint(expected: string): boolean {
    return this.state.status === 'connected' && stableHash({ provider: 'codex-chatgpt', displayLabel: this.state.displayLabel }) === expected;
  }

  private assertExpectedAccountFingerprint(expected: string | undefined): void {
    if (expected !== undefined && !this.matchesAccountFingerprint(expected)) throw new Error('JOB_AUTH_ACCOUNT_CHANGED');
  }

  private async verifyExpectedAccountFingerprint(expected: string | undefined, client: RuntimeClient): Promise<void> {
    if (expected === undefined) return;
    // 帐号更新通知的读取可能晚于 thread/turn 回执；未确认当前帐号前不发送资料或接纳结果。
    if (this.accountReadInFlight?.client === client) await this.accountReadInFlight.promise;
    if (this.client !== client) throw new Error('CODEX_RUNTIME_EXITED');
    this.assertExpectedAccountFingerprint(expected);
  }

  private setPendingLogin(loginId: string): void {
    this.clearPendingLogin();
    this.pendingLoginId = loginId;
    this.loginTimer = setTimeout(() => {
      if (this.pendingLoginId !== loginId) return;
      this.pendingLoginId = null;
      this.loginTimer = null;
      this.setState({ ...this.state, status: 'error', displayLabel: '登录已超时，请重试' });
      void this.client?.request('account/login/cancel', { loginId }).catch(() => undefined);
    }, 10 * 60_000);
  }

  private clearPendingLogin(): void {
    if (this.loginTimer) clearTimeout(this.loginTimer);
    this.loginTimer = null;
    this.pendingLoginId = null;
  }
}

export type { CodexRpcClient };
