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
          'item/reasoning/summaryTextDelta',
          'item/reasoning/summaryPartAdded'
        ]
      }
    });
    this.notify('initialized');
    return response;
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = this.requestTimeoutMs): Promise<T> {
    if (this.closed) return Promise.reject(new Error('CODEX_RPC_CLOSED'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CODEX_RPC_TIMEOUT:${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      this.write({ method, id, params });
    });
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
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if ('error' in message) {
        const rpcError = message.error as JsonRpcErrorShape;
        pending.reject(new Error(`CODEX_RPC_ERROR:${rpcError?.code ?? 'unknown'}:${rpcError?.message ?? 'unknown'}`));
      } else {
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
      this.emit('notification', { method: message.method, params: message.params });
      this.emit(message.method, message.params);
      return;
    }

    this.emit('protocolError', new Error('CODEX_RPC_UNKNOWN_MESSAGE'));
  }

  private close(reason: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
    this.emit('closed', reason);
  }
}

export function spawnCodexAppServer(options: {
  executable: string;
  codexHome: string;
  cwd: string;
  inheritedPath?: string;
}): { client: CodexRpcClient; process: ChildProcessWithoutNullStreams } {
  const child = spawn(options.executable, [
    'app-server',
    '--stdio',
    '--strict-config',
    '-c', 'web_search="disabled"',
    '--disable', 'standalone_web_search',
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
