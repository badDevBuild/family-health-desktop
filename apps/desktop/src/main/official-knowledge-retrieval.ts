import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { MemberAssessmentCandidateV3 } from '@contracts';
import type { AssessmentKnowledgeRetrievalDiagnostic } from '@storage';
import { officialKnowledgeText, type OfficialContentScope } from './official-knowledge-content.js';

export const OFFICIAL_KNOWLEDGE_RETRIEVAL_VERSION = 'official-https-content-v2';
const MAX_SOURCES = 3;
const MAX_REDIRECTS = 3;
const SOURCE_TIMEOUT_MS = 8_000;
const MAX_BYTES = 128 * 1024;
const CACHE_MAX_AGE_MS = 24 * 60 * 60_000;

// 只读取明确的官方公共知识页，不把任意模型网址变成网络访问权限。
const OFFICIAL_DOMAINS = ['nhc.gov.cn', 'chinacdc.cn', 'who.int', 'cdc.gov', 'nih.gov',
  'nice.org.uk', 'nhs.uk', 'rcog.org.uk', 'uspreventiveservicestaskforce.org', 'acog.org', 'aao.org', 'auanet.org',
  'thyroid.org', 'aasld.org', 'easl.eu', 'acc.org', 'heart.org', 'diabetes.org', 'niddk.nih.gov',
  'cancer.gov', 'radiologyinfo.org', 'kidney.org', 'pubs.rsna.org', 'aapos.org'];

export type OfficialKnowledgeFailureCode = 'url_not_allowed' | 'dns_not_public' | 'dns_unavailable'
  | 'proxy_unavailable' | 'proxy_unsupported'
  | 'network_unavailable' | 'timed_out' | 'redirect_limit' | 'redirect_missing'
  | 'http_unavailable' | 'content_unsupported' | 'content_too_large' | 'content_empty' | 'source_limit';

class RetrievalFailure extends Error {
  constructor(readonly code: OfficialKnowledgeFailureCode) { super(code); }
}

export interface OfficialKnowledgeReceipt {
  sourceId: string;
  url: string;
  finalUrl: string;
  content: string;
  contentType: string;
  contentFormat: 'static_text';
  contentScope: OfficialContentScope;
  contentHash: string;
  bodyHash: string;
  checkedAt: string;
  toolReceiptId: string;
  retrievalVersion: typeof OFFICIAL_KNOWLEDGE_RETRIEVAL_VERSION;
}

interface PinnedAddress { address: string; family: 4 | 6 }
interface ResponseContent {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Uint8Array;
}

/** 测试替身只替代 DNS/传输；网址、地址、大小、跳转和时间门禁仍由产品代码执行。 */
export interface OfficialKnowledgeTransport {
  /** 只能由桌面主进程读取系统代理配置注入，不能由模型或来源资料提供。 */
  resolveSystemProxy?: (url: string) => Promise<string>;
  lookup: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  request: (url: URL, address: PinnedAddress, signal: AbortSignal) => Promise<ResponseContent>;
  requestViaProxy?: (url: URL, proxy: URL, signal: AbortSignal) => Promise<ResponseContent>;
}

export interface OfficialKnowledgeRetrievalOptions {
  assertActive: () => void;
  signal?: AbortSignal;
  now?: () => Date;
  transport?: OfficialKnowledgeTransport;
  cacheRead?: (key: string) => Promise<OfficialKnowledgeReceipt | null>;
  cacheSave?: (key: string, receipt: OfficialKnowledgeReceipt) => Promise<void>;
  onDiagnostic?: (diagnostic: Omit<AssessmentKnowledgeRetrievalDiagnostic, 'inputSignature'>) => void | Promise<void>;
}

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

function allowedUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new RetrievalFailure('url_not_allowed'); }
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password
    || url.search || isIP(url.hostname.replace(/^\[|\]$/g, '')) || url.hostname.endsWith('.')
    || !OFFICIAL_DOMAINS.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) {
    throw new RetrievalFailure('url_not_allowed');
  }
  url.hash = '';
  return url;
}

const nonPublicV4 = new BlockList();
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) {
  nonPublicV4.addSubnet(network, prefix, 'ipv4');
}
const publicV6 = new BlockList(); publicV6.addSubnet('2000::', 3, 'ipv6');
const nonPublicV6 = new BlockList();
nonPublicV6.addSubnet('2001::', 23, 'ipv6');
nonPublicV6.addSubnet('2001:db8::', 32, 'ipv6');
nonPublicV6.addSubnet('2002::', 16, 'ipv6');

function publicAddress(address: string): PinnedAddress | null {
  if (address.includes('%')) return null;
  const family = isIP(address);
  if (family === 4 && !nonPublicV4.check(address, 'ipv4')) return { address, family: 4 };
  if (family === 6 && publicV6.check(address, 'ipv6') && !nonPublicV6.check(address, 'ipv6')) return { address, family: 6 };
  return null;
}

function header(headers: ResponseContent['headers'], key: string): string | null {
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === key)?.[1];
  return typeof entry === 'string' ? entry : null;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void promise.then((result) => { signal.removeEventListener('abort', abort); resolve(result); },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

/** 只选择系统明确给出的第一条路径，不因代理失败偷偷降级直连或尝试模型提供的代理。 */
function systemProxyRoute(value: string): URL | null {
  const first = value.split(';')[0]?.trim();
  if (first === 'DIRECT') return null;
  const match = /^(PROXY|HTTPS)\s+([a-z0-9.-]+|\[[a-f0-9:]+\]):([0-9]{1,5})$/i.exec(first ?? '');
  if (!match || Number(match[3]) < 1 || Number(match[3]) > 65535) throw new RetrievalFailure('proxy_unsupported');
  try { return new URL(`${match[1]!.toUpperCase() === 'HTTPS' ? 'https' : 'http'}://${match[2]}:${match[3]}`); }
  catch { throw new RetrievalFailure('proxy_unsupported'); }
}

function requestContent(url: URL, signal: AbortSignal, address?: PinnedAddress, proxy?: URL): Promise<ResponseContent> {
  // CONNECT 的目标始终是已核查的官方域名:443；代理只来自系统设置。目标 TLS 证书仍须匹配该域名。
  // 不携带 Cookie、登录凭证或患者内容，不放行 Fake-IP；它只在显式代理路径由代理远端解析。
  const agent = proxy ? new HttpsProxyAgent(proxy, { signal, rejectUnauthorized: true }) : undefined;
  return new Promise<ResponseContent>((resolve, reject) => {
    // TLS SNI/Host 仍为官方域名，只有 TCP 地址被固定为刚验证过的公共 DNS 结果。
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (!address) { callback(new Error('PINNED_ADDRESS_REQUIRED'), '', 0); return; }
      if (options.all) callback(null, [{ address: address.address, family: address.family }]);
      else callback(null, address.address, address.family);
    };
    const request = httpsRequest(url, { method: 'GET', signal, rejectUnauthorized: true,
      ...(agent ? { agent } : { lookup: pinnedLookup }),
      headers: { Accept: 'text/html,application/xhtml+xml,text/plain', 'Accept-Encoding': 'identity',
        'User-Agent': 'FamilyHealth-KnowledgeReader/1' } }, (response) => {
      const status = response.statusCode ?? 0;
      const headers = response.headers;
      if (status < 200 || status >= 300) {
        response.destroy(); resolve({ status, headers, body: new Uint8Array() }); return;
      }
      const length = Number(header(headers, 'content-length'));
      if (Number.isFinite(length) && length > MAX_BYTES) {
        response.destroy(); reject(new RetrievalFailure('content_too_large')); return;
      }
      const chunks: Buffer[] = []; let total = 0;
      response.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_BYTES) { response.destroy(); reject(new RetrievalFailure('content_too_large')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ status, headers, body: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    request.on('error', reject); request.end();
  }).finally(() => agent?.destroy());
}

export function createOfficialKnowledgeTransport(resolveSystemProxy?: (url: string) => Promise<string>): OfficialKnowledgeTransport {
  return { lookup: (hostname) => dnsLookup(hostname, { all: true, verbatim: true }),
    request: (url, address, signal) => requestContent(url, signal, address),
    ...(resolveSystemProxy ? { resolveSystemProxy,
      requestViaProxy: (url: URL, proxy: URL, signal: AbortSignal) => requestContent(url, signal, undefined, proxy) } : {}) };
}
const defaultTransport = createOfficialKnowledgeTransport();

function validCached(receipt: OfficialKnowledgeReceipt, url: string, now: Date): boolean {
  try {
    const age = now.getTime() - new Date(receipt.checkedAt).getTime();
    return receipt.retrievalVersion === OFFICIAL_KNOWLEDGE_RETRIEVAL_VERSION && receipt.url === url
      && receipt.contentFormat === 'static_text' && ['main', 'article', 'body', 'plain'].includes(receipt.contentScope)
      && allowedUrl(receipt.finalUrl).href === receipt.finalUrl && receipt.content.trim().length > 0
      && Buffer.byteLength(receipt.content) <= MAX_BYTES && receipt.contentHash === hash(receipt.content)
      && /^[a-f0-9]{64}$/.test(receipt.bodyHash) && receipt.toolReceiptId === receiptId(receipt)
      && Number.isFinite(age) && age >= -5 * 60_000 && age <= CACHE_MAX_AGE_MS;
  } catch { return false; }
}

function receiptId(receipt: Pick<OfficialKnowledgeReceipt, 'url' | 'finalUrl' | 'contentHash' | 'bodyHash' | 'checkedAt' | 'contentFormat' | 'contentScope'>): string {
  return `${OFFICIAL_KNOWLEDGE_RETRIEVAL_VERSION}:${hash(JSON.stringify({ url: receipt.url, finalUrl: receipt.finalUrl,
    contentHash: receipt.contentHash, bodyHash: receipt.bodyHash, checkedAt: receipt.checkedAt,
    contentFormat: receipt.contentFormat, contentScope: receipt.contentScope }))}`;
}

async function readSource(sourceId: string, requested: URL, options: OfficialKnowledgeRetrievalOptions): Promise<OfficialKnowledgeReceipt> {
  const transport = options.transport ?? defaultTransport;
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason ?? new Error('JOB_CANCELLED'));
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new RetrievalFailure('timed_out')), SOURCE_TIMEOUT_MS);
  try {
    let url = requested;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      options.assertActive();
      if (controller.signal.aborted) throw controller.signal.reason;
      let proxy: URL | null = null;
      if (transport.resolveSystemProxy) {
        let route: string;
        try { route = await abortable(transport.resolveSystemProxy(url.href), controller.signal); }
        catch {
          if (controller.signal.aborted) throw controller.signal.reason;
          throw new RetrievalFailure('proxy_unavailable');
        }
        options.assertActive();
        proxy = systemProxyRoute(route);
      }
      let address: PinnedAddress | undefined;
      if (proxy && !transport.requestViaProxy) throw new RetrievalFailure('proxy_unsupported');
      if (!proxy) {
        let addresses: Array<{ address: string; family: number }>;
        try { addresses = await abortable(transport.lookup(url.hostname), controller.signal); }
        catch {
          if (controller.signal.aborted) throw controller.signal.reason;
          throw new RetrievalFailure('dns_unavailable');
        }
        options.assertActive();
        // 直连仍逐跳固定公共地址；没有明确代理时 Fake-IP、内网与混合答复全部拒绝。
        const publicAddresses = addresses.map((entry) => publicAddress(entry.address));
        if (addresses.length === 0 || publicAddresses.some((entry) => !entry)
          || addresses.some((entry, index) => entry.family !== publicAddresses[index]?.family)) throw new RetrievalFailure('dns_not_public');
        address = publicAddresses[0]!;
      }
      let response: ResponseContent;
      if (controller.signal.aborted) throw controller.signal.reason;
      try { response = await abortable(proxy ? transport.requestViaProxy!(url, proxy, controller.signal)
        : transport.request(url, address!, controller.signal), controller.signal); }
      catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (error instanceof RetrievalFailure) throw error;
        throw new RetrievalFailure('network_unavailable');
      }
      options.assertActive();
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirects === MAX_REDIRECTS) throw new RetrievalFailure('redirect_limit');
        const location = header(response.headers, 'location');
        if (!location) throw new RetrievalFailure('redirect_missing');
        try { url = allowedUrl(new URL(location, url).href); }
        catch { throw new RetrievalFailure('url_not_allowed'); }
        continue;
      }
      if (response.status < 200 || response.status >= 300) throw new RetrievalFailure('http_unavailable');
      if (response.body.byteLength > MAX_BYTES) throw new RetrievalFailure('content_too_large');
      const contentType = header(response.headers, 'content-type') ?? '';
      if (!/^(?:text\/(?:html|plain)|application\/xhtml\+xml)(?:\s*;|$)/i.test(contentType)
        || !['', 'identity'].includes((header(response.headers, 'content-encoding') ?? '').toLowerCase())) {
        throw new RetrievalFailure('content_unsupported');
      }
      const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1] ?? 'utf-8';
      let decoded: string;
      try { decoded = new TextDecoder(charset, { fatal: true }).decode(response.body); }
      catch { throw new RetrievalFailure('content_unsupported'); }
      // 解码后的文本也受硬限，避免多字节转换放大传入模型的上下文。
      if (Buffer.byteLength(decoded) > MAX_BYTES) throw new RetrievalFailure('content_too_large');
      const { content, contentScope } = officialKnowledgeText(decoded, contentType);
      if (!content.trim()) throw new RetrievalFailure('content_empty');
      if (Buffer.byteLength(content) > MAX_BYTES) throw new RetrievalFailure('content_too_large');
      const receipt: Omit<OfficialKnowledgeReceipt, 'toolReceiptId'> = { sourceId, url: requested.href, finalUrl: url.href, content, contentType,
        contentFormat: 'static_text', contentScope,
        contentHash: hash(content), bodyHash: hash(response.body), checkedAt: (options.now ?? (() => new Date()))().toISOString(),
        retrievalVersion: OFFICIAL_KNOWLEDGE_RETRIEVAL_VERSION };
      return { ...receipt, toolReceiptId: receiptId(receipt) };
    }
    throw new RetrievalFailure('redirect_limit');
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
}

/** 正文仅是待核验的外部材料；HTTP 成功不证明指南支持某个医学主张。 */
export async function retrieveOfficialKnowledgeSources(sources: readonly { sourceId: string; url: string }[],
  options: OfficialKnowledgeRetrievalOptions): Promise<{
    retrieved: OfficialKnowledgeReceipt[];
    failures: Array<{ sourceId: string; code: OfficialKnowledgeFailureCode }>;
  }> {
  const retrieved: OfficialKnowledgeReceipt[] = []; const failures: Array<{ sourceId: string; code: OfficialKnowledgeFailureCode }> = [];
  let count = 0;
  const inRun = new Map<string, OfficialKnowledgeReceipt>();
  const failedInRun = new Map<string, OfficialKnowledgeFailureCode>();
  const record = async (sourceId: string, code: OfficialKnowledgeFailureCode | null, checkedAt?: string) => {
    options.assertActive();
    await options.onDiagnostic?.({ retrievalVersion: OFFICIAL_KNOWLEDGE_RETRIEVAL_VERSION,
      outcomes: [{ sourceKey: hash(sourceId), status: code === null ? 'retrieved' : 'failed', code,
        checkedAt: checkedAt ?? (options.now ?? (() => new Date()))().toISOString() }] });
  };
  for (const source of sources) {
    options.assertActive();
    if (options.signal?.aborted) throw options.signal.reason;
    let url: URL;
    try { url = allowedUrl(source.url); }
    catch { failures.push({ sourceId: source.sourceId, code: 'url_not_allowed' }); await record(source.sourceId, 'url_not_allowed'); continue; }
    const previous = inRun.get(url.href);
    if (previous) { retrieved.push({ ...previous, sourceId: source.sourceId }); await record(source.sourceId, null, previous.checkedAt); continue; }
    const previousFailure = failedInRun.get(url.href);
    if (previousFailure) { failures.push({ sourceId: source.sourceId, code: previousFailure }); await record(source.sourceId, previousFailure); continue; }
    if (count++ >= MAX_SOURCES) { failures.push({ sourceId: source.sourceId, code: 'source_limit' }); await record(source.sourceId, 'source_limit'); continue; }
    const cacheKey = hash(JSON.stringify({ version: OFFICIAL_KNOWLEDGE_RETRIEVAL_VERSION, url: url.href }));
    const cached = await options.cacheRead?.(cacheKey);
    options.assertActive();
    if (cached && validCached(cached, url.href, (options.now ?? (() => new Date()))())) {
      const result = { ...cached, sourceId: source.sourceId }; inRun.set(url.href, result); retrieved.push(result);
      await record(source.sourceId, null, result.checkedAt); continue;
    }
    let receipt: OfficialKnowledgeReceipt;
    try { receipt = await readSource(source.sourceId, url, options); }
    catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (!(error instanceof RetrievalFailure)) throw error;
      failedInRun.set(url.href, error.code);
      failures.push({ sourceId: source.sourceId, code: error.code }); await record(source.sourceId, error.code); continue;
    }
    options.assertActive();
    await options.cacheSave?.(cacheKey, receipt);
    options.assertActive();
    inRun.set(url.href, receipt); retrieved.push(receipt);
    await record(source.sourceId, null, receipt.checkedAt);
  }
  return { retrieved, failures };
}

export function resolveAssessmentKnowledgeContent(candidate: Pick<MemberAssessmentCandidateV3,
  'claims' | 'actions' | 'knowledgeSources'>, options: OfficialKnowledgeRetrievalOptions) {
  const used = new Set([...candidate.claims.flatMap((claim) => [...claim.knowledgeSourceIds,
    ...(claim.criteriaBasis ? [claim.criteriaBasis.sourceId] : [])]), ...candidate.actions.flatMap((action) => action.knowledgeSourceIds)]);
  // 有限读取名额优先给真正影响期限、标准或高影响内容的引用，不按病名/网址标题猜重要性。
  const priority = new Set([...candidate.claims.flatMap((claim) => [
    ...(claim.criteriaBasis ? [claim.criteriaBasis.sourceId] : []),
    ...(claim.consequenceLevel === 'high' ? claim.knowledgeSourceIds : [])]),
  ...candidate.actions.filter((action) => action.timingBasis === 'guideline' || action.urgency !== 'routine')
    .flatMap((action) => action.knowledgeSourceIds)]);
  return retrieveOfficialKnowledgeSources(candidate.knowledgeSources.filter((source) => used.has(source.id) && source.url)
    .sort((a, b) => Number(priority.has(b.id)) - Number(priority.has(a.id)))
    .map((source) => ({ sourceId: source.id, url: source.url! })), options);
}
