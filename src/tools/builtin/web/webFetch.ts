import Type from 'typebox';
import { getErrorMessage, getErrorName } from '../../../utils/errorUtils.js';
import { toJsonValue } from '../../../utils/jsonValue.js';
import { ToolKind } from '../../behavior.js';
import { createTool } from '../../core/createTool.js';
import type { WebFetchMetadata } from '../../types/metadata.js';
import { ToolErrorType } from '../../types/result.js';
import { ToolSchemas } from '../../validation/toolSchemas.js';
import {
  fetchJina,
  fetchWeb,
  type WebFetchSecurityPolicy,
  type WebResponse,
} from './webRequest.js';

export { assertWebFetchUrl, type WebFetchSecurityPolicy } from './webRequest.js';

export const webFetchTool = createTool({
  name: 'WebFetch',
  group: 'web',
  displayName: 'Web Fetch',
  kind: ToolKind.Execute,
  sideEffect: 'non_idempotent',
  interruptBehavior: 'cancel',
  schema: Type.Object({
    url: Type.String({ format: 'url', description: 'URL to request' }),
    method: Type.Enum(['GET', 'POST', 'PUT', 'DELETE', 'HEAD'], {
      default: 'GET',
      description: 'HTTP method',
    }),
    extract_content: ToolSchemas.flag({
      defaultValue: false,
      description: 'Use Jina Reader to extract clean Markdown content',
    }),
    jina_options: Type.Optional(
      Type.Object({
        with_generated_alt: ToolSchemas.flag({
          defaultValue: false,
          description: 'Generate alt text for images',
        }),
        with_links_summary: ToolSchemas.flag({
          defaultValue: false,
          description: 'Include a summary of links',
        }),
        wait_for_selector: Type.Optional(
          Type.String({ description: 'Wait for this CSS selector to load' }),
        ),
      }),
    ),
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    body: Type.Optional(Type.String({ description: 'Request body' })),
    timeout: ToolSchemas.timeout(1000, 120_000, 30_000),
    follow_redirects: ToolSchemas.flag({
      defaultValue: true,
      description: 'Follow redirects',
    }),
    max_redirects: Type.Integer({
      minimum: 0,
      maximum: 10,
      default: 5,
      description: 'Maximum redirect hops',
    }),
    return_headers: ToolSchemas.flag({
      defaultValue: false,
      description: 'Return response headers',
    }),
  }),
  resolveBehavior: (params) => {
    const method = params?.method ?? 'GET';
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
  description: {
    short: 'Fetch content from an HTTP(S) URL',
    long: 'Performs a guarded web request, follows validated redirects, and can extract Markdown through Jina Reader.',
    usageNotes: [
      'Prefer an MCP-provided web fetch tool when one is available',
      'Private network targets and unsafe redirect destinations are blocked by default',
    ],
  },
  async *execute(params, context) {
    const {
      url,
      method,
      extract_content: extractContent,
      jina_options: jinaOptions,
      headers = {},
      body,
      timeout,
      follow_redirects: followRedirects,
      max_redirects: maxRedirects,
      return_headers: returnHeaders,
    } = params;
    const signal = context.signal ?? new AbortController().signal;
    const securityPolicy: WebFetchSecurityPolicy = context.bladeConfig?.webFetch ?? {};

    try {
      let response: WebResponse | undefined;
      if (extractContent) {
        yield {
          kind: 'progress',
          message: `Extracting content with Jina Reader: ${url}`,
          data: toJsonValue({ url, strategy: 'jina' }),
        };
        try {
          response = await timed(() =>
            fetchJina({
              url,
              headers: jinaHeaders(jinaOptions),
              timeout,
              signal,
              securityPolicy,
            }),
          );
        } catch {
          yield { kind: 'message', content: { summary: 'Jina Reader failed; fetching directly' } };
        }
      }

      if (!response) {
        yield {
          kind: 'progress',
          message: `Sending ${method} request to: ${url}`,
          data: toJsonValue({ method, url, strategy: 'direct' }),
        };
        response = await timed(() =>
          fetchWeb({
            url,
            method,
            headers,
            body,
            timeout,
            followRedirects,
            maxRedirects,
            signal,
            securityPolicy,
          }),
        );
      }

      if (!returnHeaders) delete response.headers;
      const metadata = responseMetadata(url, method, response);
      if (response.status >= 400) {
        const message = `HTTP error ${response.status}: ${response.status_text}`;
        return {
          status: 'error',
          model: message,
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message,
            details: { ...metadata, response_body: response.body },
          },
          metadata: { ...metadata, summary: requestSummary(url, method, response.status) },
        };
      }
      return {
        status: 'success',
        model: toJsonValue(response),
        metadata: { ...metadata, summary: requestSummary(url, method, response.status) },
      };
    } catch (error) {
      const aborted = getErrorName(error) === 'AbortError';
      return {
        status: 'error',
        model: aborted ? 'Request aborted' : `Network request failed: ${getErrorMessage(error)}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: aborted ? '操作被中止' : getErrorMessage(error),
          details: error,
        },
        metadata: { summary: requestSummary(url, method, aborted ? 'aborted' : 'error') },
      };
    }
  },
  preparePermissionMatcher: ({ url }) => {
    try {
      const rule = `domain:${new URL(url).hostname}`;
      return { signatureContent: rule, abstractRule: rule };
    } catch {
      return { signatureContent: url, abstractRule: '*' };
    }
  },
});

async function timed(operation: () => Promise<WebResponse>): Promise<WebResponse> {
  const started = Date.now();
  const response = await operation();
  response.response_time = Date.now() - started;
  return response;
}

function responseMetadata(url: string, method: string, response: WebResponse): WebFetchMetadata {
  return {
    url,
    method,
    status: response.status,
    response_time: response.response_time,
    content_length: Buffer.byteLength(response.body, 'utf8'),
    redirected: response.redirected ?? false,
    redirect_count: response.redirect_count ?? 0,
    final_url: response.url,
    content_type: response.content_type,
    redirect_chain: response.redirect_chain,
    body_dropped: response.body_dropped,
  };
}

function requestSummary(url: string, method: string, outcome: number | string): string {
  try {
    return `${method} ${new URL(url).hostname} - ${outcome}`;
  } catch {
    return `${method} ${url} - ${outcome}`;
  }
}

function jinaHeaders(options?: {
  with_generated_alt?: boolean;
  with_links_summary?: boolean;
  wait_for_selector?: string;
}): Record<string, string> {
  return {
    'User-Agent': 'Blade-AI/1.0',
    Accept: 'text/markdown',
    ...(options?.with_generated_alt ? { 'X-With-Generated-Alt': 'true' } : {}),
    ...(options?.with_links_summary ? { 'X-With-Links-Summary': 'true' } : {}),
    ...(options?.wait_for_selector ? { 'X-Wait-For-Selector': options.wait_for_selector } : {}),
  };
}
