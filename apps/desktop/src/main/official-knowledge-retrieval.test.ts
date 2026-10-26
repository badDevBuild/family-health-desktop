import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAssessmentKnowledgeContent, retrieveOfficialKnowledgeSources, type OfficialKnowledgeReceipt, type OfficialKnowledgeTransport } from './official-knowledge-retrieval.js';

const content = '<html><body>Fictional public guidance for source retrieval tests only.</body></html>';
const body = Buffer.from(content);
const readableContent = 'Fictional public guidance for source retrieval tests only.';
const source = { sourceId: 'synthetic-source', url: 'https://www.who.int/public-guidance' };
function fixture() {
  const lookup = vi.fn<OfficialKnowledgeTransport['lookup']>(async () => [{ address: '8.8.8.8', family: 4 }]);
  const request = vi.fn<OfficialKnowledgeTransport['request']>(async () => ({ status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' }, body }));
  return { lookup, request, options: { assertActive: vi.fn(), now: () => new Date('2026-09-22T00:00:00Z'),
    transport: { lookup, request } } };
}
afterEach(() => vi.useRealTimers());

describe('官方公共知识正文的受控读取', () => {
  it('系统明确代理时通过域名隧道读取，不能连接本机 Fake-IP 作为目标地址', async () => {
    const f = fixture();
    f.lookup.mockResolvedValue([{ address: '198.18.1.10', family: 4 }]);
    const resolveSystemProxy = vi.fn(async () => 'PROXY 127.0.0.1:7897; DIRECT');
    const requestViaProxy = vi.fn<NonNullable<OfficialKnowledgeTransport['requestViaProxy']>>(async () => ({
      status: 200, headers: { 'content-type': 'text/html' }, body }));
    const result = await retrieveOfficialKnowledgeSources([source], { ...f.options,
      transport: { ...f.options.transport, resolveSystemProxy, requestViaProxy } });
    expect(result.retrieved).toHaveLength(1);
    expect(resolveSystemProxy).toHaveBeenCalledWith(source.url);
    expect(requestViaProxy.mock.calls[0]?.[0].href).toBe(source.url);
    expect(requestViaProxy.mock.calls[0]?.[1].href).toBe('http://127.0.0.1:7897/');
    expect(f.lookup).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
    requestViaProxy.mockRejectedValue(new Error('proxy failed with private details'));
    expect((await retrieveOfficialKnowledgeSources([source], { ...f.options,
      transport: { ...f.options.transport, resolveSystemProxy, requestViaProxy } })).failures[0]?.code).toBe('network_unavailable');
    expect(f.request).not.toHaveBeenCalled();
  });

  it('DIRECT 与代理后的 DIRECT 跳转仍执行公共 DNS 校验', async () => {
    const f = fixture();
    f.lookup.mockResolvedValue([{ address: '198.18.1.10', family: 4 }]);
    const resolveSystemProxy = vi.fn().mockResolvedValueOnce('HTTPS proxy.example:443').mockResolvedValue('DIRECT');
    const requestViaProxy = vi.fn<NonNullable<OfficialKnowledgeTransport['requestViaProxy']>>(async () => ({ status: 302, headers: { location: '/next' }, body: Buffer.alloc(0) }));
    const result = await retrieveOfficialKnowledgeSources([source], { ...f.options,
      transport: { ...f.options.transport, resolveSystemProxy, requestViaProxy } });
    expect(result.failures[0]?.code).toBe('dns_not_public'); expect(f.request).not.toHaveBeenCalled();
    expect(requestViaProxy).toHaveBeenCalledTimes(1);
    expect(requestViaProxy.mock.calls[0]?.[1].href).toBe('https://proxy.example/');
  });

  it.each(['', 'SOCKS5 127.0.0.1:1080', 'PROXY user:secret@localhost:8080', 'PROXY localhost:0',
    'PROXY localhost:65536', 'PROXY localhost:8080/path', 'PROXY localhost:8080?q=x'])(
    '不支持或含凭证的系统代理明确停止，不偷偷直连 %s', async (route) => {
      const f = fixture(); const requestViaProxy = vi.fn();
      const result = await retrieveOfficialKnowledgeSources([source], { ...f.options,
        transport: { ...f.options.transport, resolveSystemProxy: async () => route, requestViaProxy } });
      expect(result.failures[0]?.code).toBe('proxy_unsupported');
      expect(f.lookup).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled(); expect(requestViaProxy).not.toHaveBeenCalled();
    });

  it('代理路径也逐跳校验目标，内网跳转不进入代理解析', async () => {
    const f = fixture(); const resolveSystemProxy = vi.fn(async () => 'PROXY 127.0.0.1:7897');
    const requestViaProxy = vi.fn(async () => ({ status: 302, headers: { location: 'https://127.0.0.1/private' }, body: Buffer.alloc(0) }));
    const result = await retrieveOfficialKnowledgeSources([source], { ...f.options,
      transport: { ...f.options.transport, resolveSystemProxy, requestViaProxy } });
    expect(result.failures[0]?.code).toBe('url_not_allowed');
    expect(resolveSystemProxy).toHaveBeenCalledTimes(1); expect(requestViaProxy).toHaveBeenCalledTimes(1);
  });

  it('系统代理查询失败、超时或撤权，不启动 HTTP，也不伪造读取成功', async () => {
    const f = fixture(); const requestViaProxy = vi.fn();
    const transport = { ...f.options.transport, resolveSystemProxy: vi.fn(async (): Promise<string> => { throw new Error('private'); }), requestViaProxy };
    expect((await retrieveOfficialKnowledgeSources([source], { ...f.options, transport })).failures[0]?.code).toBe('proxy_unavailable');
    vi.useFakeTimers(); transport.resolveSystemProxy.mockImplementation(() => new Promise(() => undefined));
    const timed = retrieveOfficialKnowledgeSources([source], { ...f.options, transport });
    await vi.advanceTimersByTimeAsync(8001);
    expect((await timed).failures[0]?.code).toBe('timed_out');
    let active = true;
    transport.resolveSystemProxy.mockImplementation(async () => { active = false; return 'PROXY 127.0.0.1:7897'; });
    await expect(retrieveOfficialKnowledgeSources([source], { ...f.options, transport,
      assertActive: () => { if (!active) throw new Error('CONSENT_REVOKED'); } })).rejects.toThrow('CONSENT_REVOKED');
    expect(requestViaProxy).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
  });

  it('实际正文超过旧原码窗口仍保留，并分别记录原始字节和静态正文哈希', async () => {
    const f = fixture();
    const html = `<head><script>${'metadata'.repeat(4000)}</script></head><main>Complete fictional condition.</main>`;
    f.request.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(html) });
    const receipt = (await retrieveOfficialKnowledgeSources([source], f.options)).retrieved[0]!;
    expect(receipt.content).toBe('Complete fictional condition.'); expect(receipt.contentScope).toBe('main');
    expect(receipt.bodyHash).toBe(createHash('sha256').update(html).digest('hex'));
    expect(receipt.bodyHash).not.toBe(receipt.contentHash);
  });

  it('每个结果立刻留下无网址正文的诊断，不依赖后续模型或任务成功', async () => {
    const f = fixture();
    const onDiagnostic = vi.fn();
    f.lookup.mockRejectedValueOnce(new Error('private-network-error-detail'));
    await retrieveOfficialKnowledgeSources([source, { sourceId: 'synthetic-bad', url: 'https://not-approved.example/private' },
      { sourceId: 'synthetic-ok', url: 'https://www.who.int/another' }], { ...f.options, onDiagnostic });
    expect(onDiagnostic.mock.calls.map(([item]) => item.outcomes[0].code)).toEqual(['dns_unavailable', 'url_not_allowed', null]);
    expect(onDiagnostic.mock.calls[0]![0].outcomes[0].sourceKey).toBe(createHash('sha256').update(source.sourceId).digest('hex'));
    const saved = JSON.stringify(onDiagnostic.mock.calls);
    for (const privateValue of [source.url, source.sourceId, content, 'private-network-error-detail']) expect(saved).not.toContain(privateValue);
  });

  it('诊断持久化的存储满或撤权错误不伪装成公共网页失败', async () => {
    const f = fixture();
    const onDiagnostic = vi.fn(() => { throw new Error('SQLITE_FULL'); });
    await expect(retrieveOfficialKnowledgeSources([source], { ...f.options, onDiagnostic })).rejects.toThrow('SQLITE_FULL');
  });

  it('有限名额先读取实际期限依赖，不能被前三条一般书目占满', async () => {
    const f = fixture();
    const sources = [0, 1, 2, 3].map((index) => ({ id: `source-${index}`, title: '合成公共资料',
      organization: null, url: `https://www.who.int/public-${index}`, origin: 'retrieved' as const, supports: '合成范围' }));
    const result = await resolveAssessmentKnowledgeContent({ claims: [], knowledgeSources: sources,
      actions: sources.map((entry, index) => ({ id: `action-${index}`, dedupeKey: `synthetic-${index}`, systemIds: [], claimIds: [],
        kind: 'test_followup', title: '合成行动', why: '合成理由', firstStep: '合成步骤', timing: null,
        timingBasis: index === 3 ? 'guideline' : 'none', reviewPlan: null, caution: null, urgency: 'routine',
        evidenceIds: [], knowledgeSourceIds: [entry.id] })) }, f.options);
    expect(f.request.mock.calls[0]?.[0].pathname).toBe('/public-3');
    expect(result.retrieved.map((entry) => entry.sourceId)).toEqual(['source-3', 'source-0', 'source-1']);
    expect(result.failures).toEqual([{ sourceId: 'source-2', code: 'source_limit' }]);
  });
  it('固定公共 DNS 地址，保留实际正文、原始字节哈希和读取回执；成功不宣称医学支持', async () => {
    const f = fixture(); const result = await retrieveOfficialKnowledgeSources([source], f.options);
    expect(f.lookup).toHaveBeenCalledWith('www.who.int');
    expect(f.request.mock.calls[0]?.[0].href).toBe(source.url);
    expect(f.request.mock.calls[0]?.[1]).toEqual({ address: '8.8.8.8', family: 4 });
    expect(result.failures).toEqual([]);
    expect(result.retrieved[0]).toMatchObject({ sourceId: source.sourceId, url: source.url, finalUrl: source.url, content: readableContent,
      contentFormat: 'static_text', contentScope: 'body', contentHash: createHash('sha256').update(readableContent).digest('hex'),
      bodyHash: createHash('sha256').update(body).digest('hex'), checkedAt: '2026-09-22T00:00:00.000Z' });
    expect(result.retrieved[0]?.toolReceiptId).toMatch(/^official-https-content-v2:[a-f0-9]{64}$/);
    expect(result.retrieved[0]).not.toHaveProperty('supports');
  });

  it.each(['http://www.who.int/a', 'https://user:secret@www.who.int/a', 'https://www.who.int/a?q=private',
    'https://127.0.0.1/a', 'https://[::1]/a', 'https://www.who.int.attacker.example/a',
    'https://attackerwho.int/a', 'https://www.who.int:8080/a', 'https://www.who.int./a'])(
    '拒绝未经授权的网址且不启动 DNS %s', async (url) => {
    const f = fixture(); const result = await retrieveOfficialKnowledgeSources([{ ...source, url }], f.options);
    expect(result.failures).toEqual([{ sourceId: source.sourceId, code: 'url_not_allowed' }]);
    expect(f.lookup).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
  });

  it.each(['cancer.gov', 'radiologyinfo.org', 'kidney.org', 'pubs.rsna.org', 'aapos.org'])(
    '国家医学与专业组织来源 %s 明确允许，但相似后缀不能冒充', async (domain) => {
      const f = fixture();
      expect((await retrieveOfficialKnowledgeSources([{ ...source, url: `https://${domain}/public-guidance` }], f.options)).retrieved)
        .toHaveLength(1);
      const after = f.lookup.mock.calls.length;
      const result = await retrieveOfficialKnowledgeSources([
        { sourceId: 'suffix', url: `https://${domain}.attacker.example/a` },
        { sourceId: 'prefix', url: `https://attacker${domain}/a` }
      ], f.options);
      expect(result.failures.map((entry) => entry.code)).toEqual(['url_not_allowed', 'url_not_allowed']);
      expect(f.lookup).toHaveBeenCalledTimes(after);
    });

  it.each(['127.0.0.1', '10.2.3.4', '100.64.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1',
    '192.0.2.1', '198.18.0.1', '224.1.1.1', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fc00::1',
    '2001:db8::1', '2002:7f00:1::1', '2001:4860::1%en0'])('拒绝非公共 DNS 答复 %s', async (address) => {
    const f = fixture(); f.lookup.mockResolvedValue([{ address, family: address.includes(':') ? 6 : 4 }]);
    const result = await retrieveOfficialKnowledgeSources([source], f.options);
    expect(result.failures[0]?.code).toBe('dns_not_public'); expect(f.request).not.toHaveBeenCalled();
  });

  it('公共和内网地址混合时整个答复拒绝，IPv6 合法公共地址可固定使用', async () => {
    const f = fixture(); f.lookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }, { address: '10.1.1.1', family: 4 }]);
    expect((await retrieveOfficialKnowledgeSources([source], f.options)).failures[0]?.code).toBe('dns_not_public');
    f.lookup.mockResolvedValue([{ address: '2606:4700::1111', family: 6 }]);
    expect((await retrieveOfficialKnowledgeSources([source], f.options)).retrieved).toHaveLength(1);
    expect(f.request.mock.calls[0]?.[1]).toEqual({ address: '2606:4700::1111', family: 6 });
  });

  it('每次跳转都重新核查域名和 DNS，阻止重绑定到内网', async () => {
    const f = fixture(); f.request.mockResolvedValueOnce({ status: 302, headers: { location: '/next' }, body: Buffer.alloc(0) });
    f.lookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    expect((await retrieveOfficialKnowledgeSources([source], f.options)).failures[0]?.code).toBe('dns_not_public');
    expect(f.request).toHaveBeenCalledTimes(1);
    f.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    f.request.mockResolvedValue({ status: 302, headers: { location: 'https://attacker.example/a' }, body: Buffer.alloc(0) });
    expect((await retrieveOfficialKnowledgeSources([source], f.options)).failures[0]?.code).toBe('url_not_allowed');
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it('最多三个跳转、三个独立网址，不因来源别名重复发送', async () => {
    const f = fixture(); f.request.mockResolvedValue({ status: 302, headers: { location: '/next' }, body: Buffer.alloc(0) });
    expect((await retrieveOfficialKnowledgeSources([source], f.options)).failures[0]?.code).toBe('redirect_limit');
    expect(f.request).toHaveBeenCalledTimes(4);
    const next = fixture();
    const result = await retrieveOfficialKnowledgeSources([source, { ...source, sourceId: 'alias' },
      { sourceId: 'b', url: 'https://www.cdc.gov/a' }, { sourceId: 'c', url: 'https://www.nih.gov/a' },
      { sourceId: 'd', url: 'https://www.nice.org.uk/a' }], next.options);
    expect(next.request).toHaveBeenCalledTimes(3); expect(result.retrieved).toHaveLength(4);
    expect(result.failures).toEqual([{ sourceId: 'd', code: 'source_limit' }]);
  });

  it('同一失败网址的多个来源 ID 只尝试一次，其他独立来源继续', async () => {
    const f = fixture(); f.request.mockRejectedValueOnce(new Error('private network error must not leak'));
    const result = await retrieveOfficialKnowledgeSources([source, { ...source, sourceId: 'alias' },
      { sourceId: 'next', url: 'https://www.cdc.gov/a' }], f.options);
    expect(result.failures).toEqual([{ sourceId: source.sourceId, code: 'network_unavailable' },
      { sourceId: 'alias', code: 'network_unavailable' }]);
    expect(result.retrieved).toHaveLength(1); expect(f.request).toHaveBeenCalledTimes(2);
  });

  it.each([
    { status: 500, headers: {}, body, code: 'http_unavailable' },
    { status: 200, headers: { 'content-type': 'application/pdf' }, body, code: 'content_unsupported' },
    { status: 200, headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' }, body, code: 'content_unsupported' },
    { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.alloc(128 * 1024 + 1), code: 'content_too_large' },
    { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('  '), code: 'content_empty' }
  ])('正文限制 $code 不伪造成功回执', async ({ code, ...response }) => {
    const f = fixture(); f.request.mockResolvedValue(response);
    const result = await retrieveOfficialKnowledgeSources([source], f.options);
    expect(result.retrieved).toEqual([]); expect(result.failures[0]?.code).toBe(code);
  });

  it('DNS 不响应也在单源八秒内结束，取消后不开始发送', async () => {
    vi.useFakeTimers(); const f = fixture(); f.lookup.mockImplementation(() => new Promise(() => {}));
    const pending = retrieveOfficialKnowledgeSources([source], f.options);
    await vi.advanceTimersByTimeAsync(8_000);
    expect((await pending).failures[0]?.code).toBe('timed_out'); expect(f.request).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const controller = new AbortController(); controller.abort(new Error('JOB_CANCELLED'));
    await expect(retrieveOfficialKnowledgeSources([source], { ...f.options, signal: controller.signal })).rejects.toThrow('JOB_CANCELLED');
    expect(f.lookup).toHaveBeenCalledTimes(1);
  });

  it('读取期间任务失效不持久化、不发送后续请求，不把取消混同网络失败', async () => {
    const f = fixture(); let active = true;
    f.lookup.mockImplementation(async () => { active = false; return [{ address: '8.8.8.8', family: 4 }]; });
    const cacheSave = vi.fn();
    await expect(retrieveOfficialKnowledgeSources([source], { ...f.options, cacheSave,
      assertActive: () => { if (!active) throw new Error('CONSENT_REVOKED'); } })).rejects.toThrow('CONSENT_REVOKED');
    expect(cacheSave).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
  });

  it('只复用完整、未过期、哈希与回执一致的真实读取缓存；缓存写满不得伪装网络失败', async () => {
    const f = fixture(); const cache = new Map<string, OfficialKnowledgeReceipt>();
    const options = { ...f.options, cacheRead: async (key: string) => cache.get(key) ?? null,
      cacheSave: async (key: string, receipt: OfficialKnowledgeReceipt) => { cache.set(key, receipt); } };
    const first = await retrieveOfficialKnowledgeSources([source], options);
    const cached = await retrieveOfficialKnowledgeSources([{ ...source, sourceId: 'alias' }], options);
    expect(cached.retrieved[0]?.sourceId).toBe('alias');
    expect(cached.retrieved[0]?.toolReceiptId).toBe(first.retrieved[0]?.toolReceiptId); expect(f.request).toHaveBeenCalledTimes(1);
    const key = [...cache.keys()][0]!; cache.set(key, { ...cache.get(key)!, content: 'tampered' });
    await retrieveOfficialKnowledgeSources([source], options); expect(f.request).toHaveBeenCalledTimes(2);
    await retrieveOfficialKnowledgeSources([source], { ...options, now: () => new Date('2026-09-24T00:00:00Z') });
    expect(f.request).toHaveBeenCalledTimes(3);
    await expect(retrieveOfficialKnowledgeSources([{ ...source, url: 'https://www.cdc.gov/new' }], {
      ...f.options, cacheSave: async () => { throw new Error('LOCAL_STORAGE_FULL'); }
    })).rejects.toThrow('LOCAL_STORAGE_FULL');
  });
});
