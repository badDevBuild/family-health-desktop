import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CodexRpcClient, redactSensitiveLog, type JsonRpcTransport } from './index.js';

function createHarness() {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  let terminated = false;
  const transport: JsonRpcTransport = {
    input: toServer,
    output: fromServer,
    terminate: () => { terminated = true; }
  };
  const client = new CodexRpcClient(transport, { requestTimeoutMs: 100 });
  return { client, toServer, fromServer, terminated: () => terminated };
}

describe('Codex RPC framing', () => {
  it('能把拆分的响应帧关联到请求', async () => {
    const harness = createHarness();
    const request = harness.client.request<{ ok: boolean }>('account/read', {});
    const written = harness.toServer.read()?.toString() ?? '';
    const id = JSON.parse(written.trim()).id;
    const response = JSON.stringify({ id, result: { ok: true } });
    harness.fromServer.write(response.slice(0, 6));
    harness.fromServer.write(`${response.slice(6)}\n`);
    await expect(request).resolves.toEqual({ ok: true });
  });

  it('默认拒绝服务端工具与权限请求', async () => {
    const harness = createHarness();
    harness.fromServer.write(`${JSON.stringify({ id: 77, method: 'item/commandExecution/requestApproval', params: {} })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    const reply = JSON.parse((harness.toServer.read()?.toString() ?? '').trim());
    expect(reply.id).toBe(77);
    expect(reply.error.message).toBe('REQUEST_DENIED_BY_HEALTH_APP');
  });

  it('拒绝没有换行且超过预算的 RPC 帧', async () => {
    const toServer = new PassThrough();
    const fromServer = new PassThrough();
    let terminated = false;
    const client = new CodexRpcClient({
      input: toServer,
      output: fromServer,
      terminate: () => { terminated = true; }
    }, { maxFrameBytes: 32 });
    const protocolErrors: Error[] = [];
    client.on('protocolError', (error) => protocolErrors.push(error));
    fromServer.write('x'.repeat(33));
    await new Promise((resolve) => setImmediate(resolve));
    expect(protocolErrors[0]?.message).toBe('CODEX_RPC_FRAME_TOO_LARGE');
    expect(terminated).toBe(true);
  });

  it('日志脱敏认证信息', () => {
    expect(redactSensitiveLog('Authorization: Bearer abc.def.ghi')).not.toContain('abc.def.ghi');
  });
});
