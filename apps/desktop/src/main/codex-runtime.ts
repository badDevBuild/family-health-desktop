import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync } from 'node:fs';
import { aiModelOptionSchema, aiReasoningEffortSchema, type AccountState, type AiModelOption, type AiPreferences } from '@contracts';
import { spawnCodexAppServer, type CodexRpcClient } from '@codex';

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
  type: string;
  text?: string;
  phase?: string | null;
}

interface TurnCompleted {
  threadId: string;
  turn: { id: string; status: string; items: TurnItem[]; error: unknown };
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
    timeoutMs?: number;
  }): Promise<{ threadId: string; turnId: string; output: T }> {
    await this.start();
    if (!this.client) throw new Error('CODEX_RUNTIME_UNAVAILABLE');
    if (this.state.status !== 'connected') throw new Error('CODEX_AUTH_REQUIRED');
    if (this.activeTurn) throw new Error('CODEX_CONCURRENCY_LIMIT');
    const thread = await this.client.request<{ thread: { id: string } }>('thread/start', {
      cwd: this.options.workingDirectory,
      model: input.aiPreferences.modelId,
      runtimeWorkspaceRoots: [],
      approvalPolicy: 'never',
      sandbox: 'read-only',
      developerInstructions: 'Return only data matching the supplied output schema. Do not call tools, access files, or provide diagnosis or prescriptions.',
      config: {
        web_search: 'disabled',
        tools: { web_search: false, view_image: false }
      },
      ephemeral: true,
      historyMode: 'paginated',
      environments: [],
      dynamicTools: [],
      selectedCapabilityRoots: []
    });
    const completion = this.waitForTurn(thread.thread.id, input.timeoutMs ?? this.options.requestTimeoutMs ?? 120_000);
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
        outputSchema: input.outputSchema
      });
    } catch (error) {
      completion.cancel();
      throw error;
    }
    this.activeTurn = { threadId: thread.thread.id, turnId: started.turn.id };
    completion.setTurnId(started.turn.id);
    try {
      const notification = await completion.promise;
      if (notification.turn.status !== 'completed') throw new Error(`CODEX_TURN_${notification.turn.status.toUpperCase()}`);
      const message = [...notification.turn.items].reverse().find((item) => item.type === 'agentMessage' && item.phase === 'final_answer')
        ?? [...notification.turn.items].reverse().find((item) => item.type === 'agentMessage');
      if (!message?.text) throw new Error('CODEX_STRUCTURED_OUTPUT_MISSING');
      return { threadId: notification.threadId, turnId: notification.turn.id, output: JSON.parse(message.text) as T };
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

  private waitForTurn(threadId: string, timeoutMs: number): { promise: Promise<TurnCompleted>; setTurnId(turnId: string): void; cancel(): void } {
    let expectedTurnId: string | null = null;
    let earlyCompletion: TurnCompleted | null = null;
    let resolvePromise!: (value: TurnCompleted) => void;
    let rejectPromise!: (error: Error) => void;
    let cleanupExternal: () => void = () => undefined;
    if (!this.client) {
      return {
        promise: Promise.reject(new Error('CODEX_RUNTIME_UNAVAILABLE')),
        setTurnId: () => undefined,
        cancel: () => undefined
      };
    }
    const client = this.client;
    const promise = new Promise<TurnCompleted>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
      const onCompleted = (notification: TurnCompleted) => {
        if (notification.threadId !== threadId) return;
        if (expectedTurnId === null) { earlyCompletion = notification; return; }
        if (notification.turn.id !== expectedTurnId) return;
        cleanup();
        resolve(notification);
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
        client.off('processExit', onExit);
      };
      cleanupExternal = cleanup;
      client.on('turn/completed', onCompleted);
      client.on('processExit', onExit);
    });
    return {
      promise,
      setTurnId: (turnId) => {
        expectedTurnId = turnId;
        if (earlyCompletion?.turn.id === turnId) {
          cleanupExternal();
          resolvePromise(earlyCompletion);
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
