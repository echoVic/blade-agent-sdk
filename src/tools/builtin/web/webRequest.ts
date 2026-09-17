import { lookup } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { LRUCache } from 'lru-cache';
import { Agent, type Dispatcher, ProxyAgent } from 'undici';
import { getErrorMessage, getErrorName } from '../../../utils/errorUtils.js';

export interface WebFetchSecurityPolicy {
  readonly allowedHosts?: readonly string[];
  readonly blockedHosts?: readonly string[];
  readonly allowPrivateNetwork?: boolean;
}

export interface WebResponse {
  status: number;
  status_text: string;
  headers?: Record<string, string>;
  body: string;
  url: string;
  redirected?: boolean;
  redirect_count?: number;
  redirect_chain?: string[];
  content_type?: string;
  body_dropped?: boolean;
  response_time: number;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  display_url: string;
  source: string;
}

interface SearchProvider {
  name: string;
  buildUrl(query: string): string;
  parse(data: unknown): WebSearchResult[];
}

const PRIVATE_NETWORKS = new BlockList();
const PRIVATE_RANGES = {
  ipv4: [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ],
  ipv6: [
    ['::', 128],
    ['::1', 128],
    ['::ffff:0:0', 96],
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['2001::', 23],
    ['2002::', 16],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
  ],
} as const;
for (const family of ['ipv4', 'ipv6'] as const) {
  for (const [network, prefix] of PRIVATE_RANGES[family]) {
    PRIVATE_NETWORKS.addSubnet(network, prefix, family);
  }
}

export function assertWebFetchUrl(rawUrl: string, policy: WebFetchSecurityPolicy = {}): URL {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`WebFetch only supports HTTP(S) URLs, received ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error('WebFetch URLs must not contain embedded credentials');
  }

  const hostname = normalizeHostname(url.hostname);
  const localName =
    hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local');
  if (localName && !policy.allowPrivateNetwork) {
    throw new Error(`WebFetch blocked local hostname: ${hostname}`);
  }
  if (policy.blockedHosts?.some((pattern) => matchesHost(hostname, pattern))) {
    throw new Error(`WebFetch blocked host by policy: ${hostname}`);
  }
  if (
    policy.allowedHosts &&
    !policy.allowedHosts.some((pattern) => matchesHost(hostname, pattern))
  ) {
    throw new Error(`WebFetch host is not in the allowlist: ${hostname}`);
  }
  if (!policy.allowPrivateNetwork && isIP(hostname)) assertPublicAddress(hostname);
  return url;
}

export async function requestWithTimeout(
  url: string,
  init: RequestInit,
  timeout: number,
  signal?: AbortSignal,
  dispatcher?: Dispatcher,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit & { dispatcher?: Dispatcher });
  } catch (error) {
    if (getErrorName(error) === 'AbortError') {
      const aborted = new Error('Request aborted or timed out', { cause: error });
      aborted.name = 'AbortError';
      throw aborted;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export async function fetchWeb(options: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeout: number;
  followRedirects: boolean;
  maxRedirects: number;
  signal?: AbortSignal;
  securityPolicy?: WebFetchSecurityPolicy;
}): Promise<WebResponse> {
  const policy = options.securityPolicy ?? {};
  const dispatcher = createSafeDispatcher(policy);
  let url = options.url;
  let method = options.method;
  let body = options.body;
  let headers: Record<string, string> = { 'User-Agent': 'Blade-AI/1.0', ...options.headers };
  let bodyDropped = false;
  const redirectChain: string[] = [];

  try {
    for (let redirects = 0; ; redirects++) {
      assertWebFetchUrl(url, policy);
      const requestHeaders = { ...headers };
      if (body && !['GET', 'HEAD'].includes(method) && !hasHeader(requestHeaders, 'content-type')) {
        requestHeaders['Content-Type'] = 'application/json';
      }
      const response = await requestWithTimeout(
        url,
        {
          method,
          headers: requestHeaders,
          body: body && !['GET', 'HEAD'].includes(method) ? body : undefined,
          redirect: 'manual',
        },
        options.timeout,
        options.signal,
        dispatcher,
      );
      const location = response.headers.get('location');
      const redirect = response.status >= 300 && response.status < 400;
      if (redirect && options.followRedirects) {
        if (!location) throw new Error(`HTTP ${response.status} redirect is missing Location`);
        if (redirects >= options.maxRedirects) {
          throw new Error(`Exceeded maximum redirects (${options.maxRedirects})`);
        }
        const nextUrl = new URL(location, url).toString();
        assertWebFetchUrl(nextUrl, policy);
        redirectChain.push(`${response.status} → ${nextUrl}`);
        await response.body?.cancel();
        if (new URL(nextUrl).origin !== new URL(url).origin) {
          headers = stripCredentialHeaders(headers);
        }
        if (
          response.status === 303 ||
          ([301, 302].includes(response.status) && !['GET', 'HEAD'].includes(method))
        ) {
          bodyDropped ||= body !== undefined;
          method = 'GET';
          body = undefined;
        }
        url = nextUrl;
        continue;
      }
      const responseHeaders = headersToObject(response.headers);
      return {
        status: response.status,
        status_text: response.statusText,
        headers: responseHeaders,
        body: await response.text(),
        url: response.url || url,
        redirected: redirectChain.length > 0,
        redirect_count: redirectChain.length,
        redirect_chain: redirectChain,
        content_type: responseHeaders['content-type'],
        body_dropped: bodyDropped || undefined,
        response_time: 0,
      };
    }
  } finally {
    await dispatcher.close();
  }
}

export async function fetchJina(options: {
  url: string;
  headers: Record<string, string>;
  timeout: number;
  signal?: AbortSignal;
  securityPolicy?: WebFetchSecurityPolicy;
}): Promise<WebResponse> {
  assertWebFetchUrl(options.url, options.securityPolicy);
  const dispatcher = createSafeDispatcher(options.securityPolicy ?? {});
  try {
    const response = await requestWithTimeout(
      `https://r.jina.ai/${encodeURIComponent(options.url)}`,
      { method: 'GET', headers: options.headers },
      options.timeout,
      options.signal,
      dispatcher,
    );
    if (!response.ok)
      throw new Error(`Jina Reader error: ${response.status} ${response.statusText}`);
    const parsed = parseJina(await response.text());
    return {
      status: response.status,
      status_text: response.statusText,
      headers: headersToObject(response.headers),
      body: `${parsed.title ? `# ${parsed.title}\n\n` : ''}${parsed.url ? `**Source**: ${parsed.url}\n\n` : ''}---\n\n${parsed.content}`,
      url: parsed.url || options.url,
      redirected: false,
      redirect_count: 0,
      content_type: 'text/markdown',
      response_time: 0,
    };
  } finally {
    await dispatcher.close();
  }
}

const searchCache = new LRUCache<string, WebSearchResult[]>({ max: 100, ttl: 3_600_000 });

export async function searchWeb(
  query: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<{ results: WebSearchResult[]; provider: string }> {
  const dispatcher = createProxyDispatcher();
  const errors: string[] = [];
  try {
    for (const provider of SEARCH_PROVIDERS) {
      signal?.throwIfAborted();
      const cacheKey = `${provider.name}:${query.trim().toLowerCase()}`;
      const cached = searchCache.get(cacheKey);
      if (cached) return { results: cached, provider: `${provider.name} (cached)` };
      try {
        const response = await requestWithRetry(
          provider.buildUrl(query),
          {
            method: 'GET',
            headers: { Accept: 'application/json', 'User-Agent': 'Blade-AI-WebSearch/1.0' },
          },
          timeout,
          signal,
          dispatcher,
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const results = provider.parse(await response.json());
        if (results.length > 0) searchCache.set(cacheKey, results);
        return { results, provider: provider.name };
      } catch (error) {
        if (signal?.aborted) throw error;
        errors.push(`${provider.name}: ${getErrorMessage(error)}`);
      }
    }
  } finally {
    await dispatcher?.close();
  }
  throw new Error(`All search providers failed:\n${errors.join('\n')}`);
}

function createSafeDispatcher(policy: WebFetchSecurityPolicy): Agent {
  const secureLookup: LookupFunction = (hostname, options, callback) => {
    lookup(hostname, { ...options, all: true }, (error, addresses) => {
      try {
        if (error) throw error;
        if (addresses.length === 0) throw new Error(`WebFetch could not resolve host: ${hostname}`);
        if (!policy.allowPrivateNetwork) {
          for (const address of addresses) assertPublicAddress(address.address);
        }
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      } catch (lookupError) {
        callback(
          lookupError instanceof Error ? lookupError : new Error(String(lookupError)),
          [],
          0,
        );
      }
    });
  };
  return new Agent({ connect: { lookup: secureLookup } });
}

function createProxyDispatcher(): ProxyAgent | undefined {
  const proxy =
    process.env.HTTPS_PROXY ??
    process.env.HTTP_PROXY ??
    process.env.https_proxy ??
    process.env.http_proxy;
  if (!proxy) return undefined;
  try {
    return new ProxyAgent(proxy);
  } catch {
    return undefined;
  }
}

async function requestWithRetry(
  url: string,
  init: RequestInit,
  timeout: number,
  signal?: AbortSignal,
  dispatcher?: Dispatcher,
): Promise<Response> {
  let failure: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await requestWithTimeout(url, init, timeout, signal, dispatcher);
    } catch (error) {
      if (signal?.aborted) throw error;
      failure = error;
      if (attempt < 2) await delay(1000 * 2 ** attempt, signal);
    }
  }
  throw failure;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(resolvePromise, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function normalizeHostname(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
}

function matchesHost(hostname: string, pattern: string): boolean {
  const normalized = normalizeHostname(pattern);
  return normalized.startsWith('*.')
    ? hostname.endsWith(normalized.slice(1))
    : hostname === normalized;
}

function assertPublicAddress(address: string): void {
  const family = isIP(address);
  if (!family || PRIVATE_NETWORKS.check(address, family === 4 ? 'ipv4' : 'ipv6')) {
    throw new Error(`WebFetch blocked non-public network address: ${address}`);
  }
}

function stripCredentialHeaders(headers: Record<string, string>): Record<string, string> {
  const privateHeaders = new Set(['authorization', 'proxy-authorization', 'cookie', 'host']);
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !privateHeaders.has(name.toLowerCase())),
  );
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((header) => header.toLowerCase() === name);
}

function headersToObject(headers: Headers): Record<string, string> {
  return Object.fromEntries([...headers].map(([name, value]) => [name.toLowerCase(), value]));
}

function parseJina(text: string): { title: string; url: string; content: string } {
  const title = /^Title: (.*)$/m.exec(text)?.[1]?.trim() ?? '';
  const url = /^URL Source: (.*)$/m.exec(text)?.[1]?.trim() ?? '';
  const content = text.split(/^Markdown Content:\s*$/m)[1]?.trim() ?? text.trim();
  return { title, url, content };
}

function formatUrl(url: string): Pick<WebSearchResult, 'display_url' | 'source'> {
  try {
    const parsed = new URL(url);
    return {
      display_url: `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`,
      source: parsed.hostname.toLowerCase(),
    };
  } catch {
    return { display_url: url, source: '' };
  }
}

function result(title: string, url: string, snippet?: string): WebSearchResult {
  return { title, url, snippet: snippet || title, ...formatUrl(url) };
}

function parseDuckDuckGo(data: unknown): WebSearchResult[] {
  if (!data || typeof data !== 'object') return [];
  const response = data as {
    Results?: Array<{ FirstURL?: string; Text?: string }>;
    RelatedTopics?: Array<{ FirstURL?: string; Text?: string; Topics?: unknown[] }>;
  };
  const entries = [...(response.Results ?? []), ...flattenTopics(response.RelatedTopics ?? [])];
  return entries.flatMap((entry) => {
    if (!entry.FirstURL || !entry.Text) return [];
    const text = decodeEntities(entry.Text).trim();
    const [title, ...snippet] = text.split(' - ');
    return [result(title, entry.FirstURL, snippet.join(' - ') || text)];
  });
}

function flattenTopics(
  topics: Array<{ FirstURL?: string; Text?: string; Topics?: unknown[] }>,
): Array<{ FirstURL?: string; Text?: string }> {
  return topics.flatMap((topic) =>
    topic.Topics
      ? flattenTopics(
          topic.Topics.filter(
            (entry): entry is { FirstURL?: string; Text?: string; Topics?: unknown[] } =>
              typeof entry === 'object' && entry !== null,
          ),
        )
      : [topic],
  );
}

function parseSearXng(data: unknown): WebSearchResult[] {
  if (!data || typeof data !== 'object') return [];
  const items = (data as { results?: unknown[] }).results;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const { title, url, content } = item as { title?: unknown; url?: unknown; content?: unknown };
    return typeof title === 'string' && typeof url === 'string'
      ? [result(title, url, typeof content === 'string' ? content : title)]
      : [];
  });
}

function decodeEntities(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

const SEARCH_PROVIDERS: SearchProvider[] = [
  {
    name: 'DuckDuckGo',
    buildUrl(query) {
      const url = new URL('https://duckduckgo.com/');
      Object.entries({
        q: query,
        format: 'json',
        no_html: '1',
        skip_disambig: '1',
        t: 'blade-code',
        kl: 'us-en',
      }).forEach(([name, value]) => {
        url.searchParams.set(name, value);
      });
      return url.toString();
    },
    parse: parseDuckDuckGo,
  },
  ...['searx.be', 'search.ononoki.org', 'searx.tiekoetter.com', 'searx.work'].map(
    (hostname): SearchProvider => ({
      name: `SearXNG(${hostname})`,
      buildUrl(query) {
        const url = new URL(`https://${hostname}/search`);
        url.searchParams.set('q', query);
        url.searchParams.set('format', 'json');
        url.searchParams.set('categories', 'general');
        return url.toString();
      },
      parse: parseSearXng,
    }),
  ),
];

export const searchProviderCount = SEARCH_PROVIDERS.length;
