import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexRuntimeManager } from './codex-runtime.js';

class FakeClient extends EventEmitter {
  requests: Array<{ method: string; params: unknown }> = [];
  authenticated = false;
  async initialize() { return {}; }
  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === 'account/read') return { account: this.authenticated ? { type: 'chatgpt', email: 'masked@example.com', planType: 'plus' } : null, requiresOpenaiAuth: true } as T;
    if (method === 'account/rateLimits/read') return { rateLimits: { primary: { usedPercent: 32, resetsAt: 2_000_000_000 }, secondary: null } } as T;
    if (method === 'account/login/start') return { type: 'chatgpt', loginId: 'login-1', authUrl: 'https://chatgpt.com/auth' } as T;
    if (method === 'account/logout') { this.authenticated = false; return {} as T; }
    if (method === 'thread/start') return { thread: { id: 'thread-1' } } as T;
    if (method === 'turn/start') {
      queueMicrotask(() => this.emit('turn/completed', {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'completed', error: null, items: [{ type: 'agentMessage', phase: 'final_answer', text: '{"ok":true}' }] }
      }));
      return { turn: { id: 'turn-1' } } as T;
    }
    return {} as T;
  }
  shutdown() {}
}

const roots: string[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'codex-runtime-test-'));
  roots.push(root);
  const executable = join(root, 'codex');
  writeFileSync(executable, '#!/bin/sh\n', { mode: 0o700 });
  const client = new FakeClient();
  const manager = new CodexRuntimeManager({
    executable,
    runtimeVersion: 'test',
    codexHome: join(root, 'codex-home'),
    workingDirectory: join(root, 'runtime-work'),
    now: () => new Date('2026-09-18T00:00:00Z'),
    createClient: () => client
  });
  return { manager, client };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('CodexRuntimeManager', () => {
  it('使用私有目录初始化且未认证时保持 disconnected', async () => {
    const { manager } = setup();
    await manager.start();
    expect(manager.getState()).toMatchObject({ status: 'disconnected', runtimeVersion: 'test' });
    manager.shutdown();
  });

  it('只返回官方浏览器登录 URL，不接触令牌', async () => {
    const { manager, client } = setup();
    await manager.start();
    await expect(manager.startChatGptLogin()).resolves.toEqual({ loginId: 'login-1', authUrl: 'https://chatgpt.com/auth' });
    expect(client.requests.find((request) => request.method === 'account/login/start')?.params).toMatchObject({ type: 'chatgpt', useHostedLoginSuccessPage: true });
    manager.shutdown();
  });

  it('退出只调用私有运行时账户并回到 disconnected', async () => {
    const { manager, client } = setup();
    client.authenticated = true;
    await manager.start();
    expect(manager.getState().status).toBe('connected');
    await expect(manager.logout()).resolves.toMatchObject({ status: 'disconnected', displayLabel: null });
    expect(client.requests.some((request) => request.method === 'account/logout')).toBe(true);
    manager.shutdown();
  });

  it('结构化任务强制无工具、无网络、只读沙箱', async () => {
    const { manager, client } = setup();
    client.authenticated = true;
    await manager.start();
    const result = await manager.runStructuredTurn<{ ok: boolean }>({
      prompt: '只处理纯虚构资料',
      imagePaths: ['/isolated/fixture.png'],
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
    });
    expect(result.output).toEqual({ ok: true });
    const threadStart = client.requests.find((request) => request.method === 'thread/start');
    const turnStart = client.requests.find((request) => request.method === 'turn/start');
    expect(threadStart?.params).toMatchObject({ approvalPolicy: 'never', sandbox: 'read-only', environments: [], dynamicTools: [] });
    expect(turnStart?.params).toMatchObject({
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      environments: [],
      input: [
        { type: 'text', text: '只处理纯虚构资料' },
        { type: 'localImage', path: '/isolated/fixture.png', detail: 'original' }
      ]
    });
    manager.shutdown();
  });

  it('运行时文件缺失时明确报错', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-runtime-missing-'));
    roots.push(root);
    mkdirSync(root, { recursive: true });
    const manager = new CodexRuntimeManager({ executable: join(root, 'missing'), runtimeVersion: null, codexHome: join(root, 'home'), workingDirectory: join(root, 'work') });
    await expect(manager.start()).rejects.toThrow('CODEX_RUNTIME_UNAVAILABLE');
    expect(manager.getState()).toMatchObject({ status: 'error', displayLabel: 'Codex 运行时未安装' });
  });
});
