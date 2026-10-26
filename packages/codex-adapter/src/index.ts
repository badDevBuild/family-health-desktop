import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

export interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  method: string;
  startedAt: number;
  recovery?: RpcRecoveryOptions;
  removeAbort?: () => void;
}

export interface RpcLifecycleEvent {
  requestId: number;
  method: string;
  phase: 'sent' | 'reply' | 'error_reply' | 'waiting_late_reply' | 'event_receipt' | 'unknown' | 'cancelled' | 'late_reply';
  elapsedMs: number;
}

export interface RpcRecoveryOptions {
  /** 同一个 RPC 的有限回执等待窗口；绝不重新发送请求。 */
  lateReplyMs: number;
  signal?: AbortSignal;
  onLifecycle?: (event: RpcLifecycleEvent) => void;
  /** 仅由拥有独立 thread 的调用方提供可关联的正式 turn 事件。 */
  receiptFromNotification?: (method: string, params: unknown) => unknown | undefined;
  /** 取消或最终超时后迟到的已接受回执只用于目标轮次清理，不能重启任务。 */
  onLateResult?: (result: unknown) => void;
}

interface RetiredRequest {
  pending: PendingRequest;
  timer: NodeJS.Timeout;
}

export interface JsonRpcTransport {
  input: Writable;
  output: Readable;
  error?: Readable;
  terminate(): void;
}

export type ServerRequestHandler = (method: string, params: unknown) => Promise<unknown>;

export class CodexRpcClient extends EventEmitter {
  private nextId = 1;
  private buffer = '';
  private closed = false;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly retired = new Map<number, RetiredRequest>();
  private readonly requestTimeoutMs: number;
  private readonly serverRequestHandler: ServerRequestHandler;
  private readonly maxFrameBytes: number;

  constructor(private readonly transport: JsonRpcTransport, options: {
    requestTimeoutMs?: number;
    maxFrameBytes?: number;
    serverRequestHandler?: ServerRequestHandler;
  } = {}) {
    super();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
    this.maxFrameBytes = options.maxFrameBytes ?? 8 * 1024 * 1024;
    this.serverRequestHandler = options.serverRequestHandler ?? defaultDenyServerRequest;
    transport.output.setEncoding('utf8');
    transport.output.on('data', (chunk: string) => this.onData(chunk));
    transport.output.on('end', () => this.close(new Error('CODEX_STDOUT_CLOSED')));
    transport.output.on('error', (error) => this.close(error));
    transport.error?.setEncoding('utf8');
    transport.error?.on('data', (chunk: string) => this.emit('stderr', redactSensitiveLog(chunk)));
  }

  async initialize(): Promise<unknown> {
    const response = await this.request('initialize', {
      clientInfo: { name: 'family-health-dashboard', title: '家庭健康看板', version: '0.1.0' },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: false,
        optOutNotificationMethods: [
          'item/reasoning/textDelta',
          'item/reasoning/summaryPartAdded'
        ]
      }
    });
    this.notify('initialized');
    return response;
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = this.requestTimeoutMs): Promise<T> {
    return this.sendRequest(method, params, timeoutMs);
  }

  requestWithRecovery<T = unknown>(method: string, params: unknown, recovery: RpcRecoveryOptions,
    timeoutMs = this.requestTimeoutMs): Promise<T> {
    if (!['thread/start', 'turn/start'].includes(method) || !Number.isSafeInteger(recovery.lateReplyMs)
      || recovery.lateReplyMs < 0 || recovery.lateReplyMs > 120_000) return Promise.reject(new Error('CODEX_RPC_RECOVERY_OPTIONS_INVALID'));
    return this.sendRequest(method, params, timeoutMs, recovery);
  }

  private sendRequest<T>(method: string, params: unknown, timeoutMs: number, recovery?: RpcRecoveryOptions): Promise<T> {
    if (this.closed) return Promise.reject(new Error('CODEX_RPC_CLOSED'));
    if (recovery?.signal?.aborted) return Promise.reject(recovery.signal.reason ?? new Error('CODEX_RPC_CANCELLED'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        if (recovery?.lateReplyMs) {
          this.reportLifecycle(id, pending, 'waiting_late_reply');
          pending.timer = setTimeout(() => this.expireRequest(id), recovery.lateReplyMs);
        } else this.expireRequest(id);
      }, timeoutMs);
      const pending: PendingRequest = { resolve: (value) => resolve(value as T), reject, timer,
        method, startedAt: Date.now(), ...(recovery ? { recovery } : {}) };
      this.pending.set(id, pending);
      const onAbort = () => this.expireRequest(id, recovery?.signal?.reason ?? new Error('CODEX_RPC_CANCELLED'));
      recovery?.signal?.addEventListener('abort', onAbort, { once: true });
      pending.removeAbort = () => recovery?.signal?.removeEventListener('abort', onAbort);
      // 调用方先持久化发送意图；失败时不能仍把健康资料发出去。
      try {
        recovery?.onLifecycle?.({ requestId: id, method, phase: 'sent', elapsedMs: 0 });
        if (recovery?.signal?.aborted) throw recovery.signal.reason ?? new Error('CODEX_RPC_CANCELLED');
        this.write({ method, id, params });
      } catch (error) {
        this.pending.delete(id); clearTimeout(timer); pending.removeAbort();
        reject(error instanceof Error ? error : new Error('CODEX_RPC_SEND_FAILED'));
      }
    });
  }

  private reportLifecycle(id: number, pending: PendingRequest, phase: RpcLifecycleEvent['phase']): void {
    const event: RpcLifecycleEvent = { requestId: id, method: pending.method, phase,
      elapsedMs: Math.max(0, Date.now() - pending.startedAt) };
    // 回执到达之后的诊断写入失败不丢弃有效回包；接纳仍受外层持久化门禁保护。
    try { pending.recovery?.onLifecycle?.(event); } catch { this.emit('recoveryDiagnosticFailed', { requestId: id, phase }); }
  }

  private expireRequest(id: number, cancelled?: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id); clearTimeout(pending.timer); pending.removeAbort?.();
    this.reportLifecycle(id, pending, cancelled ? 'cancelled' : 'unknown');
    if (pending.recovery?.onLateResult) {
      // 有界墓碑只保留关联信息和清理回调，不保存请求正文或重发许可。
      const timer = setTimeout(() => this.retired.delete(id), 120_000);
      timer.unref();
      this.retired.set(id, { pending, timer });
    }
    pending.reject(cancelled ?? new Error(`CODEX_RPC_TIMEOUT:${pending.method}`));
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) throw new Error('CODEX_RPC_CLOSED');
    this.write(params === undefined ? { method } : { method, params });
  }

  shutdown(): void {
    this.close(new Error('CODEX_RPC_SHUTDOWN'));
    this.transport.terminate();
  }

  fail(reason: Error): void {
    this.close(reason);
  }

  private write(message: object): void {
    this.transport.input.write(`${JSON.stringify(message)}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, 'utf8') > this.maxFrameBytes && !this.buffer.includes('\n')) {
      const error = new Error('CODEX_RPC_FRAME_TOO_LARGE');
      this.emit('protocolError', error);
      this.close(error);
      this.transport.terminate();
      return;
    }
    while (true) {
      const newlineIndex = this.buffer.indexOf('\n');
      if (newlineIndex < 0) return;
      if (Buffer.byteLength(this.buffer.slice(0, newlineIndex), 'utf8') > this.maxFrameBytes) {
        const error = new Error('CODEX_RPC_FRAME_TOO_LARGE');
        this.emit('protocolError', error);
        this.close(error);
        this.transport.terminate();
        return;
      }
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line) as Record<string, unknown>;
        void this.onMessage(message);
      } catch {
        this.emit('protocolError', new Error('CODEX_RPC_INVALID_JSON'));
      }
    }
  }

  private async onMessage(message: Record<string, unknown>): Promise<void> {
    if (typeof message.id === 'number' && ('result' in message || 'error' in message) && !('method' in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        const retired = this.retired.get(message.id);
        if (retired) {
          clearTimeout(retired.timer); this.retired.delete(message.id);
          this.reportLifecycle(message.id, retired.pending, 'late_reply');
          if ('result' in message) try { retired.pending.recovery?.onLateResult?.(message.result); } catch { /* 清理回调不能打断其他请求。 */ }
        }
        return;
      }
      clearTimeout(pending.timer);
      pending.removeAbort?.();
      this.pending.delete(message.id);
      if ('error' in message) {
        this.reportLifecycle(message.id, pending, 'error_reply');
        const rpcError = message.error as JsonRpcErrorShape;
        pending.reject(new Error(`CODEX_RPC_ERROR:${rpcError?.code ?? 'unknown'}:${rpcError?.message ?? 'unknown'}`));
      } else {
        this.reportLifecycle(message.id, pending, 'reply');
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method === 'string' && typeof message.id === 'number') {
      try {
        const result = await this.serverRequestHandler(message.method, message.params);
        this.write({ id: message.id, result });
      } catch (error) {
        this.write({
          id: message.id,
          error: { code: -32001, message: error instanceof Error ? error.message : 'REQUEST_DENIED' }
        });
      }
      return;
    }

    if (typeof message.method === 'string') {
      for (const [id, pending] of this.pending) {
        const result = pending.recovery?.receiptFromNotification?.(message.method, message.params);
        if (result === undefined) continue;
        clearTimeout(pending.timer); pending.removeAbort?.(); this.pending.delete(id);
        this.reportLifecycle(id, pending, 'event_receipt');
        pending.resolve(result);
      }
      for (const [id, retired] of this.retired) {
        const result = retired.pending.recovery?.receiptFromNotification?.(message.method, message.params);
        if (result === undefined) continue;
        clearTimeout(retired.timer); this.retired.delete(id);
        try { retired.pending.recovery?.onLateResult?.(result); } catch { /* 清理回调不能打断其他请求。 */ }
      }
      this.emit('notification', { method: message.method, params: message.params });
      // App Server 的 `error` 是普通通知；Node EventEmitter 会把同名事件当作未捕获异常。
      this.emit(message.method === 'error' ? 'serverError' : message.method, message.params);
      return;
    }

    this.emit('protocolError', new Error('CODEX_RPC_UNKNOWN_MESSAGE'));
  }

  private close(reason: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.removeAbort?.();
      pending.reject(reason);
    }
    this.pending.clear();
    for (const retired of this.retired.values()) clearTimeout(retired.timer);
    this.retired.clear();
    this.emit('closed', reason);
  }
}

export function spawnCodexAppServer(options: {
  executable: string;
  codexHome: string;
  cwd: string;
  inheritedPath?: string;
  /** 仅供使用已有用户配置的合成评测；正式应用始终使用严格配置。 */
  strictConfig?: boolean;
}): { client: CodexRpcClient; process: ChildProcessWithoutNullStreams } {
  const child = spawn(options.executable, [
    'app-server',
    '--stdio',
    ...(options.strictConfig === false ? [] : ['--strict-config']),
    '-c', 'web_search="disabled"',
    '--disable', 'shell_tool',
    '--disable', 'unified_exec',
    '--disable', 'browser_use',
    '--disable', 'computer_use',
    '--disable', 'in_app_browser',
    '--disable', 'image_generation',
    '--disable', 'multi_agent',
    '--disable', 'memories',
    '--disable', 'workspace_dependencies',
    '--disable', 'apps',
    '--disable', 'plugins'
  ], {
    shell: false,
    cwd: options.cwd,
    env: {
      HOME: process.env.HOME,
      PATH: options.inheritedPath ?? process.env.PATH,
      CODEX_HOME: options.codexHome,
      LANG: process.env.LANG ?? 'zh_CN.UTF-8',
      NO_COLOR: '1'
    }
  });
  const transport: JsonRpcTransport = {
    input: child.stdin,
    output: child.stdout,
    error: child.stderr,
    terminate: () => child.kill('SIGTERM')
  };
  const client = new CodexRpcClient(transport);
  child.on('error', (error) => {
    client.fail(error);
    client.emit('processError', error);
  });
  child.on('exit', (code, signal) => client.emit('processExit', { code, signal }));
  return { client, process: child };
}

export async function defaultDenyServerRequest(method: string): Promise<unknown> {
  const normalized = method.toLowerCase();
  if (normalized.includes('approval') || normalized.includes('permissions') || normalized.includes('exec') || normalized.includes('filechange') || normalized.includes('tool')) {
    throw new Error('REQUEST_DENIED_BY_HEALTH_APP');
  }
  throw new Error('UNSUPPORTED_SERVER_REQUEST');
}

export function redactSensitiveLog(input: string): string {
  return input
    .replace(/https:\/\/[^\s"']+[?&](?:code|token|state)=[^\s"']+/gi, '[REDACTED_AUTH_URL]')
    .replace(/(?:access|refresh|id)[_-]?token["'\s:=]+[^\s,"']+/gi, '[REDACTED_TOKEN]')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]');
}
