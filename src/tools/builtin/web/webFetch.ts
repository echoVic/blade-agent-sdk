import { lookup } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Agent as UndiciAgent } from 'undici';
import { z } from 'zod';
import { getErrorMessage, getErrorName } from '../../../utils/errorUtils.js';
import { toJsonValue } from '../../../utils/jsonValue.js';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext } from '../../types/execution.js';
import { ToolKind } from '../../types/kind.js';
import type { WebFetchMetadata } from '../../types/metadata.js';
import { ToolErrorType } from '../../types/result.js';
import { lazySchema } from '../../validation/lazySchema.js';
import { ToolSchemas } from '../../validation/zodSchemas.js';

/**
 * Web response result shape
 */
interface WebResponse {
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

export interface WebFetchSecurityPolicy {
  /**
   * Restricts requests to these hosts. Entries are exact hostnames unless they
   * start with `*.`, in which case subdomains are included.
   */
  readonly allowedHosts?: readonly string[];
  /** Hosts denied in addition to the built-in local-network restrictions. */
  readonly blockedHosts?: readonly string[];
  /** Explicit escape hatch for trusted, local-only deployments. */
  readonly allowPrivateNetwork?: boolean;
}

const PRIVATE_NETWORKS = new BlockList();
for (const [network, prefix] of [
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
] as const) {
  PRIVATE_NETWORKS.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
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
] as const) {
  PRIVATE_NETWORKS.addSubnet(network, prefix, 'ipv6');
}

function normalizeHostname(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
}

function matchesHost(hostname: string, pattern: string): boolean {
  const normalizedPattern = normalizeHostname(pattern);
  if (normalizedPattern.startsWith('*.')) {
    const suffix = normalizedPattern.slice(2);
    return hostname.endsWith(`.${suffix}`) && hostname.length > suffix.length + 1;
  }
  return hostname === normalizedPattern;
}

function assertPublicAddress(address: string): void {
  const family = isIP(address);
  if (family === 0 || PRIVATE_NETWORKS.check(address, family === 4 ? 'ipv4' : 'ipv6')) {
    throw new Error(`WebFetch blocked non-public network address: ${address}`);
  }
}

export function assertWebFetchUrl(rawUrl: string, policy: WebFetchSecurityPolicy = {}): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`WebFetch only supports HTTP(S) URLs, received ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error('WebFetch URLs must not contain embedded credentials');
  }

  const hostname = normalizeHostname(url.hostname);
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    if (!policy.allowPrivateNetwork) {
      throw new Error(`WebFetch blocked local hostname: ${hostname}`);
    }
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
  if (!policy.allowPrivateNetwork && isIP(hostname) !== 0) {
    assertPublicAddress(hostname);
  }
  return url;
}

function createSafeDispatcher(policy: WebFetchSecurityPolicy): UndiciAgent {
  const secureLookup: LookupFunction = (hostname, options, callback) => {
    lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        callback(error, [], 0);
        return;
      }
      try {
        if (!policy.allowPrivateNetwork) {
          for (const address of addresses) {
            assertPublicAddress(address.address);
          }
        }
        if (addresses.length === 0) {
          throw new Error(`WebFetch could not resolve host: ${hostname}`);
        }
        if (options.all) {
          callback(null, addresses);
        } else {
          const selected = addresses[0];
          callback(null, selected.address, selected.family);
        }
      } catch (lookupError) {
        callback(
          lookupError instanceof Error ? lookupError : new Error(String(lookupError)),
          [],
          0,
        );
      }
    });
  };
  return new UndiciAgent({
    connect: {
      lookup: secureLookup,
    },
  });
}

/**
 * WebFetchTool - Web content fetcher
 * Uses the newer Zod validation design
 */
export const webFetchTool = createTool({
  name: 'WebFetch',
  displayName: 'Web Fetch',
  kind: ToolKind.Execute,
  sideEffect: 'non_idempotent',
  interruptBehavior: 'cancel',

  // Zod Schema 定义
  schema: lazySchema(() =>
    z.object({
      url: z.string().url().describe('URL to request'),
      method: z
        .enum(['GET', 'POST', 'PUT', 'DELETE', 'HEAD'])
        .default('GET')
        .describe('HTTP method'),
      extract_content: ToolSchemas.flag({
        defaultValue: false,
        description:
          'Use Jina Reader to extract clean content in Markdown format. Removes HTML clutter, scripts, and styling, returning only the main content.',
      }),
      jina_options: z
        .object({
          with_generated_alt: ToolSchemas.flag({
            defaultValue: false,
            description: 'Generate alt text for images',
          }),
          with_links_summary: ToolSchemas.flag({
            defaultValue: false,
            description: 'Include summary of all links',
          }),
          wait_for_selector: z
            .string()
            .optional()
            .describe('Wait for specific CSS selector to load'),
        })
        .optional()
        .describe('Jina Reader advanced options (only used when extract_content is true)'),
      headers: z.record(z.string()).optional().describe('Request headers (optional)'),
      body: z.string().optional().describe('Request body (optional)'),
      timeout: ToolSchemas.timeout(1000, 120000, 30000),
      follow_redirects: ToolSchemas.flag({
        defaultValue: true,
        description: 'Follow redirects',
      }),
      max_redirects: z.number().int().min(0).max(10).default(5).describe('Maximum redirect hops'),
      return_headers: ToolSchemas.flag({
        defaultValue: false,
        description: 'Return response headers',
      }),
    }),
  ),

  resolveBehaviorHint: () => ({
    kind: ToolKind.ReadOnly,
    sideEffect: 'pure',
    isReadOnly: true,
    isConcurrencySafe: true,
    isDestructive: false,
  }),

  resolveBehavior: ({ method }) => {
    const isReadOnly = method === 'GET' || method === 'HEAD';
    return {
      kind: isReadOnly ? ToolKind.ReadOnly : ToolKind.Execute,
      sideEffect: isReadOnly
        ? 'pure'
        : method === 'PUT' || method === 'DELETE'
          ? 'idempotent'
          : 'non_idempotent',
      isReadOnly,
      isConcurrencySafe: isReadOnly,
      isDestructive: method === 'DELETE',
    };
  },

  // 工具描述（对齐 Claude Code 官方）
  description: {
    short: 'Fetches content from a specified URL and processes it using an AI model',
    long: `
- Fetches content from a specified URL and processes it using an AI model
- Takes a URL and a prompt as input
- Fetches the URL content, converts HTML to markdown
- Processes the content with the prompt using a small, fast model
- Returns the model's response about the content
- Use this tool when you need to retrieve and analyze web content

Usage notes:
  - IMPORTANT: If an MCP-provided web fetch tool is available, prefer using that tool instead of this one, as it may have fewer restrictions. All MCP-provided tools start with "mcp__".
  - The URL must be a fully-formed valid URL
  - HTTP URLs will be automatically upgraded to HTTPS
  - The prompt should describe what information you want to extract from the page
  - This tool is read-only and does not modify any files
  - Results may be summarized if the content is very large
  - Includes a self-cleaning 15-minute cache for faster responses when repeatedly accessing the same URL
  - When a URL redirects to a different host, the tool will inform you and provide the redirect URL in a special format. You should then make a new WebFetch request with the redirect URL to fetch the content.
`,
  },

  // 执行函数
  async *execute(params, context: ExecutionContext) {
    const {
      url,
      method = 'GET',
      extract_content = false,
      jina_options,
      headers = {},
      body,
      timeout = 30000,
      follow_redirects = true,
      max_redirects = 5,
      return_headers = false,
    } = params;
    const signal = context.signal ?? new AbortController().signal;
      const securityPolicy = context.bladeConfig?.webFetch ?? {};

    try {
      // 如果启用内容提取，使用 Jina Reader
      if (extract_content) {
        try {
          yield {
            kind: 'progress',
            message: `使用 Jina Reader 提取内容: ${url}`,
            data: toJsonValue({ url, strategy: 'jina' }),
          };
          const startTime = Date.now();
          const response = await fetchWithJinaReader({
            url,
            jinaOptions: jina_options,
            timeout,
            signal,
              securityPolicy,
          });
          yield {
            kind: 'message',
            content: {
              summary: `Jina Reader 成功提取内容 (${response.body.length} 字符)`,
            },
          };

          const responseTime = Date.now() - startTime;
          response.response_time = responseTime;

          // 如果不需要返回头部信息，删除它们
          if (!return_headers) {
            delete response.headers;
          }

          const metadata: WebFetchMetadata = {
            url,
            method: 'GET',
            status: response.status,
            response_time: responseTime,
            content_length: Buffer.byteLength(response.body || '', 'utf8'),
            redirected: response.redirected || false,
            redirect_count: response.redirect_count ?? 0,
            final_url: response.url,
            content_type: response.content_type,
            redirect_chain: response.redirect_chain,
          };

          return {
            status: 'success',
            model: toJsonValue(response),
            metadata: {
              ...metadata,
              summary: `GET ${new URL(url).hostname} - ${response.status}`,
            },
          };
        } catch {
          // Jina Reader 失败，回退到直接获取
          yield {
            kind: 'message',
            content: { summary: 'Jina Reader 失败，使用标准方式获取' },
          };
          // 继续执行下面的标准逻辑
        }
      }

      // 标准获取逻辑
      yield {
        kind: 'progress',
        message: `发送 ${method} 请求到: ${url}`,
        data: toJsonValue({ method, url, strategy: 'direct' }),
      };

      const startTime = Date.now();
      const response = await performRequest({
        url,
        method,
        headers,
        body,
        timeout,
        follow_redirects,
        max_redirects,
        signal,
          securityPolicy,
      });

      const responseTime = Date.now() - startTime;
      response.response_time = responseTime;

      // 如果不需要返回头部信息，删除它们
      if (!return_headers) {
        delete response.headers;
      }

      const metadata: WebFetchMetadata = {
        url,
        method,
        status: response.status,
        response_time: responseTime,
        content_length: Buffer.byteLength(response.body || '', 'utf8'),
        redirected: response.redirected || false,
        redirect_count: response.redirect_count ?? 0,
        final_url: response.url,
        content_type: response.content_type,
        redirect_chain: response.redirect_chain,
          body_dropped: response.body_dropped,
      };

      // HTTP错误状态码处理
      if (response.status >= 400) {
        return {
          status: 'error',
          model: `HTTP error ${response.status}: ${response.status_text}`,
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: `HTTP error ${response.status}: ${response.status_text}`,
            details: {
              ...metadata,
              response_body: response.body,
            },
          },
          metadata: {
            ...metadata,
            summary: `${method} ${new URL(url).hostname} - ${response.status}`,
          },
        };
      }

      return {
        status: 'success',
        model: toJsonValue(response),
        metadata: {
          ...metadata,
          summary: `${method} ${new URL(url).hostname} - ${response.status}`,
        },
      };
    } catch (error: unknown) {
      if (getErrorName(error) === 'AbortError') {
        return {
          status: 'error',
          model: 'Request aborted',
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: '操作被中止',
          },
          metadata: {
            summary: `${method} ${new URL(url).hostname} - aborted`,
          },
        };
      }

      const message = getErrorMessage(error);
      return {
        status: 'error',
        model: `Network request failed: ${message}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message,
          details: error,
        },
        metadata: {
          summary: `${method} ${new URL(url).hostname} - error`,
        },
      };
    }
  },

  version: '2.0.0',
  category: '网络工具',
  tags: ['web', 'http', 'fetch', 'request', 'api'],

  preparePermissionMatcher: (params) => {
    let signatureContent: string;
    try {
      const urlObj = new URL(params.url);
      signatureContent = `domain:${urlObj.hostname}`;
    } catch {
      signatureContent = params.url;
    }

    try {
      const urlObj = new URL(params.url);
      return {
        signatureContent,
        abstractRule: `domain:${urlObj.hostname}`,
      };
    } catch {
      return {
        signatureContent,
        abstractRule: '*',
      };
    }
  },
});

/**
 * 执行请求
 */
async function performRequest(options: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeout: number;
  follow_redirects: boolean;
  max_redirects: number;
  signal?: AbortSignal;
  securityPolicy?: WebFetchSecurityPolicy;
}): Promise<WebResponse> {
  const {
    url,
    method,
    headers,
    body,
    timeout,
    follow_redirects,
    max_redirects,
    signal,
    securityPolicy = {},
  } = options;

  const normalizedHeaders: Record<string, string> = {
    'User-Agent': 'Blade-AI/1.0',
    ...headers,
  };

  let currentUrl = url;
  let currentHeaders = normalizedHeaders;
  let currentMethod = method;
  let currentBody = body;
  let redirects = 0;
  let bodyDropped = false;
  const redirectChain: string[] = [];
  const dispatcher = createSafeDispatcher(securityPolicy);

  try {
  while (true) {
      assertWebFetchUrl(currentUrl, securityPolicy);
      const requestHeaders = { ...currentHeaders };
    if (
      currentBody &&
      currentMethod !== 'GET' &&
      currentMethod !== 'HEAD' &&
      !hasHeader(requestHeaders, 'content-type')
    ) {
      requestHeaders['Content-Type'] = 'application/json';
    }

    const response = await fetchWithTimeout(
      currentUrl,
      {
        method: currentMethod,
        headers: requestHeaders,
        body:
          currentBody && currentMethod !== 'GET' && currentMethod !== 'HEAD'
            ? currentBody
            : undefined,
        redirect: 'manual',
      },
      timeout,
      signal,
        dispatcher,
    );

    const location = response.headers.get('location');
    const isRedirectStatus = response.status >= 300 && response.status < 400;
    const shouldFollow =
      follow_redirects && isRedirectStatus && location && redirects < max_redirects;

    if (isRedirectStatus && follow_redirects && !location) {
      throw new Error(`收到状态码 ${response.status} 但响应缺少 Location 头`);
    }

    if (isRedirectStatus && follow_redirects && redirects >= max_redirects) {
      throw new Error(`超过最大重定向次数 (${max_redirects})`);
    }

    if (shouldFollow && location) {
      redirects++;
      const nextUrl = resolveRedirectUrl(location, currentUrl);
        assertWebFetchUrl(nextUrl, securityPolicy);
      redirectChain.push(`${response.status} → ${nextUrl}`);
        await response.body?.cancel();
        if (new URL(nextUrl).origin !== new URL(currentUrl).origin) {
          currentHeaders = Object.fromEntries(
            Object.entries(currentHeaders).filter(
              ([name]) =>
                !['authorization', 'proxy-authorization', 'cookie', 'host'].includes(
                  name.toLowerCase(),
                ),
            ),
          );
        }

      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) &&
          currentMethod !== 'GET' &&
          currentMethod !== 'HEAD')
      ) {
          bodyDropped ||= currentBody !== undefined;
        currentMethod = 'GET';
        currentBody = undefined;
      }

      currentUrl = nextUrl;
      continue;
    }

    const responseBody = await response.text();
    const responseHeaders = headersToObject(response.headers);

    return {
      status: response.status,
      status_text: response.statusText,
      headers: responseHeaders,
      body: responseBody,
      url: response.url || currentUrl,
      redirected: redirects > 0,
      redirect_count: redirects,
      redirect_chain: redirectChain,
      content_type: responseHeaders['content-type'],
        body_dropped: bodyDropped || undefined,
      response_time: 0, // 将在外部设置
    };
  }
  } finally {
    await dispatcher.close();
  }
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeout: number,
  externalSignal?: AbortSignal,
  dispatcher?: UndiciAgent,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const abortListener = () => controller.abort();
  externalSignal?.addEventListener('abort', abortListener);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit & { dispatcher?: UndiciAgent });
  } catch (error: unknown) {
    if (getErrorName(error) === 'AbortError') {
      const wrapped = new Error('请求被中止或超时', { cause: error });
      wrapped.name = 'AbortError';
      throw wrapped;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abortListener);
  }
}

function resolveRedirectUrl(location: string, baseUrl: string): string {
  try {
    return new URL(location, baseUrl).toString();
  } catch {
    return location;
  }
}

function headersToObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = value;
  });
  return result;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lowered = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lowered);
}

// ============================================================================
// Jina Reader Integration
// ============================================================================

/**
 * Jina Reader 响应格式
 */
interface JinaReaderResponse {
  title: string;
  sourceUrl: string;
  content: string;
}

/**
 * 使用 Jina Reader 提取网页内容
 */
async function fetchWithJinaReader(options: {
  url: string;
  jinaOptions?: {
    with_generated_alt?: boolean;
    with_links_summary?: boolean;
    wait_for_selector?: string;
  };
  timeout: number;
  signal?: AbortSignal;
  securityPolicy?: WebFetchSecurityPolicy;
}): Promise<WebResponse> {
  const { url, jinaOptions, timeout, signal, securityPolicy = {} } = options;
  assertWebFetchUrl(url, securityPolicy);

  // 构建 Jina Reader URL
  const jinaUrl = `https://r.jina.ai/${encodeURIComponent(url)}`;

  // 构建请求头
  const headers: Record<string, string> = {
    'User-Agent': 'Blade-AI/1.0',
    Accept: 'text/markdown',
  };

  if (jinaOptions?.with_generated_alt) {
    headers['X-With-Generated-Alt'] = 'true';
  }
  if (jinaOptions?.with_links_summary) {
    headers['X-With-Links-Summary'] = 'true';
  }
  if (jinaOptions?.wait_for_selector) {
    headers['X-Wait-For-Selector'] = jinaOptions.wait_for_selector;
  }

  const dispatcher = createSafeDispatcher(securityPolicy);
  let response: Response;
  let markdownContent: string;
  try {
    response = await fetchWithTimeout(
    jinaUrl,
    {
      method: 'GET',
      headers,
    },
    timeout,
    signal,
      dispatcher,
  );

  if (!response.ok) {
    throw new Error(`Jina Reader error: ${response.status} ${response.statusText}`);
  }

    markdownContent = await response.text();
  } finally {
    await dispatcher.close();
  }

  // 解析 Jina Reader 响应
  const parsed = parseJinaResponse(markdownContent);

  // 返回标准 WebResponse 格式
  return {
    status: response.status,
    status_text: response.statusText,
    headers: headersToObject(response.headers),
    body: formatJinaContent(parsed),
    url: parsed.sourceUrl || url,
    redirected: false,
    redirect_count: 0,
    content_type: 'text/markdown',
    response_time: 0, // 将在外部设置
  };
}

/**
 * 解析 Jina Reader 响应
 */
function parseJinaResponse(text: string): JinaReaderResponse {
  const lines = text.split('\n');
  let title = '';
  let sourceUrl = '';
  let contentStartIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('Title: ')) {
      title = line.substring(7).trim();
    } else if (line.startsWith('URL Source: ')) {
      sourceUrl = line.substring(12).trim();
    } else if (line.startsWith('Markdown Content:')) {
      contentStartIndex = i + 1;
      break;
    }
  }

  const content = lines.slice(contentStartIndex).join('\n').trim();

  return {
    title: title || 'Untitled',
    sourceUrl: sourceUrl || '',
    content: content || text, // 回退到全文
  };
}

/**
 * 格式化 Jina 提取的内容
 */
function formatJinaContent(parsed: JinaReaderResponse): string {
  let formatted = '';

  if (parsed.title) {
    formatted += `# ${parsed.title}\n\n`;
  }

  if (parsed.sourceUrl) {
    formatted += `**Source**: ${parsed.sourceUrl}\n\n`;
  }

  formatted += '---\n\n';
  formatted += parsed.content;

  return formatted;
}
