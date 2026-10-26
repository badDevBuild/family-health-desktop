import { EventEmitter } from 'node:events';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { RequestOptions } from 'node:https';
import { afterEach, describe, expect, it, vi } from 'vitest';

const network = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('node:https', () => ({ request: network.request }));
import { createOfficialKnowledgeTransport, retrieveOfficialKnowledgeSources } from './official-knowledge-retrieval.js';

afterEach(() => vi.restoreAllMocks());

describe('系统代理 HTTPS 实际传输配置', () => {
  it.each([false, true])('代理 CONNECT 保留目标证书验证且无凭证；TLS 失败=%s 时不产生回执', async (failTls) => {
    let options: RequestOptions | undefined;
    const destroyed = vi.spyOn(HttpsProxyAgent.prototype, 'destroy');
    network.request.mockImplementation((_url: URL, config: RequestOptions, callback: (response: unknown) => void) => {
      options = config;
      const request = new EventEmitter() as EventEmitter & { end: () => void };
      request.end = () => queueMicrotask(() => {
        if (failTls) { request.emit('error', new Error('ERR_TLS_CERT_ALTNAME_INVALID')); return; }
        const response = Object.assign(new EventEmitter(), { statusCode: 200,
          headers: { 'content-type': 'text/plain' }, destroy: vi.fn() });
        callback(response);
        response.emit('data', Buffer.from('Fictional public source.')); response.emit('end');
      });
      return request;
    });
    const result = await retrieveOfficialKnowledgeSources([{ sourceId: 'synthetic', url: 'https://www.who.int/guide' }], {
      assertActive() {}, transport: createOfficialKnowledgeTransport(async () => 'PROXY 127.0.0.1:7897') });
    expect(options).toMatchObject({ method: 'GET', rejectUnauthorized: true, signal: expect.any(AbortSignal),
      headers: { Accept: 'text/html,application/xhtml+xml,text/plain', 'Accept-Encoding': 'identity' } });
    expect(options?.agent).toBeInstanceOf(HttpsProxyAgent);
    const agent = options!.agent as HttpsProxyAgent<string>;
    expect(agent.proxy.href).toBe('http://127.0.0.1:7897/');
    expect(options?.headers).not.toHaveProperty('Cookie'); expect(options?.headers).not.toHaveProperty('Authorization');
    expect(options).not.toHaveProperty('checkServerIdentity');
    expect(destroyed).toHaveBeenCalledOnce();
    if (failTls) {
      expect(result.retrieved).toEqual([]); expect(result.failures[0]?.code).toBe('network_unavailable');
    } else expect(result.retrieved[0]?.content).toBe('Fictional public source.');
  });
});
