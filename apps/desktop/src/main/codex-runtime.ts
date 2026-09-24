import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync } from 'node:fs';
import { aiModelOptionSchema, aiReasoningEffortSchema, type AccountState, type AiModelOption, type AiPreferences } from '@contracts';
import { spawnCodexAppServer, type CodexRpcClient } from '@codex';
import { createHealthThreadStartParams } from './codex-thread-config.js';
import { HEALTH_MODEL_TURN_TIMEOUT_MS } from './ai-runtime-policy.js';
import { restoreCodexOptionalFields, toCodexOutputSchema } from './structured-output-schema.js';

interface RuntimeClient extends EventEmitter {
  initialize(): Promise<unknown>;
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  shutdown(): void;
}

interface RuntimeOptions {
  executable: string | null;
  runtimeVersion: string | null;
  codexHome: string;
  workingDirectory: string;
  now?: () => Date;
  requestTimeoutMs?: number;
  createClient?: (options: { executable: string; codexHome: string; cwd: string }) => RuntimeClient;
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
  rateLimits: { primary: RateWindow | null; secondary: RateWindow | null };
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

interface CompletedTurnCapture {
  notification: TurnCompleted;
  completedMessages: TurnItem[];
  streamedMessages: TurnItem[];
  completedWebSearchItems: TurnItem[];
  tokenUsage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | null;
}

export interface TurnMetrics {
  durationMs: number;
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

function latestAgentMessage(items: TurnItem[]): TurnItem | undefined {
  return [...items].reverse().find((item) => item.type === 'agentMessage' && item.phase === 'final_answer' && Boolean(item.text))
    ?? [...items].reverse().find((item) => item.type === 'agentMessage' && Boolean(item.text));
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function turnFailureCode(notification: TurnCompleted): string {
  const outer = recordValue(notification.turn.error);
  const detail = recordValue(outer?.error) ?? outer;
  const serviceCode = typeof detail?.code === 'string' ? detail.code : null;
  const message = typeof detail?.message === 'string' ? detail.message : '';
  const codexErrorInfo = typeof detail?.codexErrorInfo === 'string' ? detail.codexErrorInfo : '';
  if (/contextwindowexceeded/i.test(codexErrorInfo) || /context.window.exceeded/i.test(message)) {
    return 'CODEX_CONTEXT_WINDOW_EXCEEDED';
  }
  if (serviceCode === 'invalid_json_schema' || message.includes('Invalid schema for response_format')) {
    return 'CODEX_OUTPUT_SCHEMA_INVALID';
  }
  if (/connection reset|failed to connect|stream disconnected/i.test(message)) {
    return 'CODEX_CONNECTION_FAILED';
  }
  return `CODEX_TURN_${notification.turn.status.toUpperCase()}`;
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
  const primary = response?.rateLimits.primary ?? null;
  const secondary = response?.rateLimits.secondary ?? null;
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

export class CodexRuntimeManager extends EventEmitter {
  private client: RuntimeClient | null = null;
  private startPromise: Promise<void> | null = null;
  private state: AccountState;
  private readonly now: () => Date;
  private readonly createClient: NonNullable<RuntimeOptions['createClient']>;
  private activeTurn: { threadId: string; turnId: string } | null = null;
  private pendingLoginId: string | null = null;
  private loginTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: RuntimeOptions) {
    super();
    this.now = options.now ?? (() => new Date());
    this.createClient = options.createClient ?? ((input) => spawnCodexAppServer(input).client);
    this.state = initialState(options.runtimeVersion, Boolean(options.executable && existsSync(options.executable)));
  }

  getState(): AccountState {
    return structuredClone(this.state);
  }

  async start(): Promise<void> {
    if (this.client) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async refreshAccount(): Promise<AccountState> {
    await this.start();
    if (!this.client) throw new Error('CODEX_RUNTIME_UNAVAILABLE');
    const account = await this.client.request<AccountReadResponse>('account/read', { refreshToken: false });
    let rates: RateLimitResponse | null = null;
    if (account.account) {
      try {
        rates = await this.client.request<RateLimitResponse>('account/rateLimits/read');
      } catch {
        rates = null;
      }
    }
    const displayLabel = account.account?.type === 'chatgpt'
      ? account.account.email ?? `ChatGPT ${account.account.planType}`
      : account.account?.type === 'apiKey' ? 'OpenAI API Key' : account.account?.type === 'amazonBedrock' ? 'Amazon Bedrock' : null;
    this.setState({
      status: account.account ? 'connected' : 'disconnected',
      displayLabel,
      quota: quotaState(rates),
      runtimeVersion: this.options.runtimeVersion,
      lastCheckedAt: this.now().toISOString()
    });
    return this.getState();
  }

  async startChatGptLogin(): Promise<{ loginId: string; authUrl: string }> {
    await this.start();
    if (!this.client) throw new Error('CODEX_RUNTIME_UNAVAILABLE');
    this.setState({ ...this.state, status: 'connecting', lastCheckedAt: this.now().toISOString() });
    let response: LoginResponse;
    try {
      response = await this.client.request<LoginResponse>('account/login/start', {
        type: 'chatgpt',
        useHostedLoginSuccessPage: true,
        appBrand: 'chatgpt'
      });
    } catch (error) {
      this.setState({ ...this.state, status: 'error', displayLabel: '无法启动登录流程' });
      throw error;
    }
    if (response.type !== 'chatgpt' || !response.loginId || !response.authUrl) {
      this.setState({ ...this.state, status: 'error', displayLabel: '登录流程不可用' });
      throw new Error('CODEX_LOGIN_RESPONSE_INVALID');
    }
    this.setPendingLogin(response.loginId);
    return { loginId: response.loginId, authUrl: response.authUrl };
  }

  async cancelLogin(loginId: string): Promise<void> {
    if (!this.client) return;
    await this.client.request('account/login/cancel', { loginId });
    if (this.pendingLoginId === loginId) this.clearPendingLogin();
    await this.refreshAccount();
  }

  async logout(): Promise<AccountState> {
    await this.start();
    if (!this.client) throw new Error('CODEX_RUNTIME_UNAVAILABLE');
    this.clearPendingLogin();
    await this.client.request('account/logout');
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
  }): Promise<{ threadId: string; turnId: string; output: T; metrics: TurnMetrics }> {
    const startedAtMs = Date.now();
    await this.start();
    if (!this.client) throw new Error('CODEX_RUNTIME_UNAVAILABLE');
    if (this.state.status !== 'connected') throw new Error('CODEX_AUTH_REQUIRED');
    if (this.activeTurn) throw new Error('CODEX_CONCURRENCY_LIMIT');
    const allowWebSearch = input.allowWebSearch === true;
    const thread = await this.client.request<{ thread: { id: string } }>('thread/start', createHealthThreadStartParams({
      workingDirectory: this.options.workingDirectory,
      aiPreferences: input.aiPreferences,
      allowWebSearch
    }));
    const completion = this.waitForTurn(
      thread.thread.id,
      input.timeoutMs ?? this.options.requestTimeoutMs ?? HEALTH_MODEL_TURN_TIMEOUT_MS
    );
    let started: { turn: { id: string } };
    try {
      started = await this.client.request<{ turn: { id: string } }>('turn/start', {
        threadId: thread.thread.id,
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
      });
    } catch (error) {
      completion.cancel();
      throw error;
    }
    this.activeTurn = { threadId: thread.thread.id, turnId: started.turn.id };
    completion.setTurnId(started.turn.id);
    try {
      const capture = await completion.promise;
      const notification = capture.notification;
      if (notification.turn.status !== 'completed') throw new Error(turnFailureCode(notification));
      const message = latestAgentMessage(capture.completedMessages)
        ?? latestAgentMessage(notification.turn.items)
        ?? latestAgentMessage(capture.streamedMessages);
      if (!message?.text) throw new Error('CODEX_STRUCTURED_OUTPUT_MISSING');
      return {
        threadId: notification.threadId, turnId: notification.turn.id,
        output: restoreCodexOptionalFields(JSON.parse(message.text), input.outputSchema) as T,
        metrics: {
          durationMs: Math.max(0, Date.now() - startedAtMs),
          ...webSearchMetrics(capture),
          inputTokens: capture.tokenUsage?.inputTokens ?? null,
          outputTokens: capture.tokenUsage?.outputTokens ?? null,
          cachedInputTokens: capture.tokenUsage?.cachedInputTokens ?? null
        }
      };
    } finally {
      this.activeTurn = null;
    }
  }

  async interruptActiveTurn(): Promise<void> {
    if (!this.client || !this.activeTurn) return;
    await this.client.request('turn/interrupt', this.activeTurn);
  }

  shutdown(): void {
    this.clearPendingLogin();
    this.client?.shutdown();
    this.client = null;
    this.activeTurn = null;
  }

  private async startInternal(): Promise<void> {
    if (!this.options.executable || !existsSync(this.options.executable)) {
      this.setState(initialState(this.options.runtimeVersion, false));
      throw new Error('CODEX_RUNTIME_UNAVAILABLE');
    }
    mkdirSync(this.options.codexHome, { recursive: true, mode: 0o700 });
    mkdirSync(this.options.workingDirectory, { recursive: true, mode: 0o700 });
    const client = this.createClient({ executable: this.options.executable, codexHome: this.options.codexHome, cwd: this.options.workingDirectory });
    this.client = client;
    client.on('account/login/completed', (notification: { loginId?: string | null; success?: boolean; error?: string | null }) => {
      if (!this.pendingLoginId || (notification.loginId && notification.loginId !== this.pendingLoginId)) return;
      this.clearPendingLogin();
      if (notification.success) void this.refreshAccount().catch(() => this.setState({ ...this.state, status: 'error', displayLabel: '账户状态读取失败' }));
      else this.setState({ ...this.state, status: 'error', displayLabel: notification.error ?? '登录未完成' });
    });
    client.on('account/updated', () => {
      void this.refreshAccount().catch(() => undefined);
    });
    client.on('processExit', () => {
      this.client = null;
      this.setState({ ...this.state, status: 'error', displayLabel: 'Codex 运行时已退出' });
    });
    client.on('processError', () => {
      this.client = null;
      this.setState({ ...this.state, status: 'error', displayLabel: 'Codex 运行时启动失败' });
    });
    await client.initialize();
    await this.refreshAccount();
  }

  private waitForTurn(threadId: string, timeoutMs: number): { promise: Promise<CompletedTurnCapture>; setTurnId(turnId: string): void; cancel(): void } {
    let expectedTurnId: string | null = null;
    let earlyCompletion: TurnCompleted | null = null;
    let resolvePromise!: (value: CompletedTurnCapture) => void;
    let rejectPromise!: (error: Error) => void;
    let cleanupExternal: () => void = () => undefined;
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
        cancel: () => undefined
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
      rejectPromise = reject;
      const rememberMessageOrder = (turnId: string, itemId: string) => {
        const order = streamedMessageOrder.get(turnId) ?? [];
        if (!order.includes(itemId)) order.push(itemId);
        streamedMessageOrder.set(turnId, order);
      };
      const onItemStarted = (notification: ItemLifecycleNotification) => {
        if (notification.threadId !== threadId || notification.item.type !== 'agentMessage' || !notification.item.id) return;
        const phases = streamedMessagePhase.get(notification.turnId) ?? new Map<string, string | null>();
        phases.set(notification.item.id, notification.item.phase ?? null);
        streamedMessagePhase.set(notification.turnId, phases);
        rememberMessageOrder(notification.turnId, notification.item.id);
      };
      const onItemCompleted = (notification: ItemLifecycleNotification) => {
        if (notification.threadId !== threadId || !notification.item.id) return;
        if (notification.item.type === 'webSearch') {
          const items = completedWebSearchItems.get(notification.turnId) ?? new Map<string, TurnItem>();
          items.set(notification.item.id, notification.item);
          completedWebSearchItems.set(notification.turnId, items);
          return;
        }
        if (notification.item.type !== 'agentMessage') return;
        const messages = completedMessages.get(notification.turnId) ?? new Map<string, TurnItem>();
        messages.set(notification.item.id, notification.item);
        completedMessages.set(notification.turnId, messages);
        const phases = streamedMessagePhase.get(notification.turnId) ?? new Map<string, string | null>();
        phases.set(notification.item.id, notification.item.phase ?? null);
        streamedMessagePhase.set(notification.turnId, phases);
        rememberMessageOrder(notification.turnId, notification.item.id);
      };
      const onAgentMessageDelta = (notification: AgentMessageDeltaNotification) => {
        if (notification.threadId !== threadId || typeof notification.delta !== 'string') return;
        const messages = streamedMessageText.get(notification.turnId) ?? new Map<string, string>();
        messages.set(notification.itemId, `${messages.get(notification.itemId) ?? ''}${notification.delta}`);
        streamedMessageText.set(notification.turnId, messages);
        rememberMessageOrder(notification.turnId, notification.itemId);
      };
      const onTokenUsageUpdated = (notification: {
        threadId: string; turnId: string;
        tokenUsage?: { total?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } };
      }) => {
        if (notification.threadId !== threadId) return;
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
        if (notification.threadId !== threadId) return;
        if (expectedTurnId === null) { earlyCompletion = notification; return; }
        if (notification.turn.id !== expectedTurnId) return;
        cleanup();
        resolve(captureFor(notification));
      };
      const onExit = () => {
        cleanup();
        reject(new Error('CODEX_RUNTIME_EXITED'));
      };
      const timer = setTimeout(() => {
        cleanup();
        if (expectedTurnId) void client.request('turn/interrupt', { threadId, turnId: expectedTurnId }).catch(() => undefined);
        reject(new Error('CODEX_TURN_TIMEOUT'));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        client.off('turn/completed', onCompleted);
        client.off('item/started', onItemStarted);
        client.off('item/completed', onItemCompleted);
        client.off('item/agentMessage/delta', onAgentMessageDelta);
        client.off('thread/tokenUsage/updated', onTokenUsageUpdated);
        client.off('processExit', onExit);
      };
      cleanupExternal = cleanup;
      client.on('turn/completed', onCompleted);
      client.on('item/started', onItemStarted);
      client.on('item/completed', onItemCompleted);
      client.on('item/agentMessage/delta', onAgentMessageDelta);
      client.on('thread/tokenUsage/updated', onTokenUsageUpdated);
      client.on('processExit', onExit);
    });
    return {
      promise,
      setTurnId: (turnId) => {
        expectedTurnId = turnId;
        if (earlyCompletion?.turn.id === turnId) {
          cleanupExternal();
          resolvePromise(captureFor(earlyCompletion));
        } else if (earlyCompletion) {
          cleanupExternal();
          rejectPromise(new Error('CODEX_TURN_ID_MISMATCH'));
        }
      },
      cancel: cleanupExternal
    };
  }

  private setState(next: AccountState): void {
    this.state = next;
    this.emit('stateChanged', this.getState());
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
