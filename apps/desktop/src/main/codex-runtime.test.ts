import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexRuntimeManager } from './codex-runtime.js';

class FakeClient extends EventEmitter {
  requests: Array<{ method: string; params: unknown }> = [];
  authenticated = false;
  turnNotifications: Array<{ method: string; params: unknown }> | null = null;
  turnCompletion = {
    threadId: 'thread-1',
    turn: { id: 'turn-1', status: 'completed', error: null as unknown, items: [{ type: 'agentMessage', phase: 'final_answer', text: '{"ok":true}' }] }
  };
  async initialize() { return {}; }
  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === 'account/read') return { account: this.authenticated ? { type: 'chatgpt', email: 'masked@example.com', planType: 'plus' } : null, requiresOpenaiAuth: true } as T;
    if (method === 'account/rateLimits/read') return { rateLimits: { primary: { usedPercent: 32, resetsAt: 2_000_000_000 }, secondary: null } } as T;
    if (method === 'account/login/start') return { type: 'chatgpt', loginId: 'login-1', authUrl: 'https://chatgpt.com/auth' } as T;
    if (method === 'account/logout') { this.authenticated = false; return {} as T; }
    if (method === 'model/list') return {
      data: [{
        id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', description: '测试模型', hidden: false,
        supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '快速' }, { reasoningEffort: 'medium', description: '平衡' }],
        defaultReasoningEffort: 'low', inputModalities: ['text', 'image'], isDefault: true
      }], nextCursor: null
    } as T;
    if (method === 'thread/start') return { thread: { id: 'thread-1' } } as T;
    if (method === 'turn/start') {
      queueMicrotask(() => {
        if (this.turnNotifications) {
          for (const notification of this.turnNotifications) this.emit(notification.method, notification.params);
        } else {
          this.emit('turn/completed', this.turnCompletion);
        }
      });
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

  it('事实提取关闭 Web Search，并保持命令网络与本机工具不可用', async () => {
    const { manager, client } = setup();
    client.authenticated = true;
    await manager.start();
    const result = await manager.runStructuredTurn<{ ok: boolean }>({
      prompt: '只处理纯虚构资料',
      imagePaths: ['/isolated/fixture.png'],
      aiPreferences: { modelId: 'gpt-5.6-sol', reasoningEffort: 'medium' },
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
    });
    expect(result.output).toEqual({ ok: true });
    const threadStart = client.requests.find((request) => request.method === 'thread/start');
    const turnStart = client.requests.find((request) => request.method === 'turn/start');
    expect(threadStart?.params).toMatchObject({
      model: 'gpt-5.6-sol', approvalPolicy: 'never', sandbox: 'read-only', environments: [], dynamicTools: [],
      config: { web_search: 'disabled' }
    });
    expect((threadStart?.params as { config?: Record<string, unknown> }).config).not.toHaveProperty('tools');
    expect(turnStart?.params).toMatchObject({
      model: 'gpt-5.6-sol',
      effort: 'medium',
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

  it('向 Codex 发送结构化输出前把嵌套 oneOf 转为 anyOf', async () => {
    const { manager, client } = setup();
    client.authenticated = true;
    await manager.start();
    await manager.runStructuredTurn<{ ok: boolean }>({
      prompt: '只处理纯虚构资料',
      aiPreferences: { modelId: 'gpt-5.6-sol', reasoningEffort: 'medium' },
      outputSchema: {
        type: 'object',
        properties: { value: { oneOf: [{ type: 'string' }, { type: 'null' }] } },
        required: ['value'],
        additionalProperties: false
      }
    });
    const turnStart = client.requests.find((request) => request.method === 'turn/start');
    const sentSchema = (turnStart?.params as { outputSchema?: Record<string, unknown> }).outputSchema;
    expect(sentSchema).toMatchObject({
      properties: { value: { anyOf: [{ type: 'string' }, { type: 'null' }] } }
    });
    expect(JSON.stringify(sentSchema)).not.toContain('oneOf');
    manager.shutdown();
  });

  it('完成通知不携带条目时，从 item/completed 接收权威结构化输出', async () => {
    const { manager, client } = setup();
    client.authenticated = true;
    client.turnNotifications = [
      {
        method: 'item/completed',
        params: {
          threadId: 'thread-1', turnId: 'turn-1', completedAtMs: 1,
          item: { id: 'item-1', type: 'agentMessage', phase: 'final_answer', text: '{"ok":true}' }
        }
      },
      {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'completed', error: null, items: [], itemsView: 'notLoaded' }
        }
      }
    ];
    await manager.start();
    await expect(manager.runStructuredTurn<{ ok: boolean }>({
      prompt: '只处理纯虚构资料',
      aiPreferences: { modelId: 'gpt-5.6-sol', reasoningEffort: 'medium' },
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
    })).resolves.toMatchObject({ output: { ok: true } });
    manager.shutdown();
  });

  it('item/completed 缺失时可从按顺序接收的消息增量恢复输出', async () => {
    const { manager, client } = setup();
    client.authenticated = true;
    client.turnNotifications = [
      {
        method: 'item/started',
        params: {
          threadId: 'thread-1', turnId: 'turn-1', startedAtMs: 1,
          item: { id: 'item-1', type: 'agentMessage', phase: 'final_answer', text: '' }
        }
      },
      { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: '{"ok":' } },
      { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'true}' } },
      {
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'completed', error: null, items: [], itemsView: 'notLoaded' }
        }
      }
    ];
    await manager.start();
    await expect(manager.runStructuredTurn<{ ok: boolean }>({
      prompt: '只处理纯虚构资料',
      aiPreferences: { modelId: 'gpt-5.6-sol', reasoningEffort: 'medium' },
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
    })).resolves.toMatchObject({ output: { ok: true } });
    manager.shutdown();
  });

  it('保留结构化输出服务端错误的稳定错误码', async () => {
    const { manager, client } = setup();
    client.authenticated = true;
    client.turnCompletion = {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1', status: 'failed', items: [],
        error: { error: { code: 'invalid_json_schema', message: 'Invalid schema for response_format' } }
      }
    };
    await manager.start();
    await expect(manager.runStructuredTurn({
      prompt: '只处理纯虚构资料',
      aiPreferences: { modelId: 'gpt-5.6-sol', reasoningEffort: 'medium' },
      outputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }
    })).rejects.toThrow('CODEX_OUTPUT_SCHEMA_INVALID');
    manager.shutdown();
  });

  it('派生分析只开启内置实时 Web Search，命令网络仍保持关闭', async () => {
    const { manager, client } = setup();
    client.authenticated = true;
    await manager.start();
    await manager.runStructuredTurn<{ ok: boolean }>({
      prompt: '只处理纯虚构、去标识化资料',
      aiPreferences: { modelId: 'gpt-5.6-sol', reasoningEffort: 'medium' },
      allowWebSearch: true,
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
    });
    const threadStart = client.requests.find((request) => request.method === 'thread/start');
    const turnStart = client.requests.find((request) => request.method === 'turn/start');
    expect(threadStart?.params).toMatchObject({
      config: { web_search: 'live' },
      developerInstructions: expect.stringContaining('去标识化')
    });
    expect((threadStart?.params as { config?: Record<string, unknown> }).config).not.toHaveProperty('tools');
    expect(turnStart?.params).toMatchObject({ sandboxPolicy: { type: 'readOnly', networkAccess: false } });
    manager.shutdown();
  });

  it('从当前 Codex 账户读取支持图像的模型与推理强度', async () => {
    const { manager } = setup();
    await expect(manager.listModels()).resolves.toEqual([{
      id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', description: '测试模型',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: '快速' },
        { reasoningEffort: 'medium', description: '平衡' }
      ],
      defaultReasoningEffort: 'low', isDefault: true
    }]);
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
