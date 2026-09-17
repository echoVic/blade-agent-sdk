import Type from 'typebox';
import { getErrorMessage } from '../../../utils/errorUtils.js';
import { toJsonValue } from '../../../utils/jsonValue.js';
import { ToolKind } from '../../behavior.js';
import { createTool } from '../../core/createTool.js';
import type { WebSearchMetadata } from '../../types/metadata.js';
import { ToolErrorType } from '../../types/result.js';
import { searchProviderCount, searchWeb, type WebSearchResult } from './webRequest.js';

export type { WebSearchResult } from './webRequest.js';

const SEARCH_TIMEOUT = 15_000;
const MAX_RESULTS = 8;

export const webSearchTool = createTool({
  name: 'WebSearch',
  group: 'web',
  displayName: 'Web Search',
  kind: ToolKind.ReadOnly,
  sideEffect: 'pure',
  interruptBehavior: 'cancel',
  schema: Type.Object({
    query: Type.String({ minLength: 2, description: 'Search query' }),
    allowed_domains: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        description: 'Return results only from these domains',
      }),
    ),
    blocked_domains: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        description: 'Exclude results from these domains',
      }),
    ),
  }),
  description: {
    short: 'Search the web and use current results to inform responses',
    long: 'Uses DuckDuckGo and SearXNG with automatic fallback, retry, proxy support, and domain filtering.',
    important: [
      'Include a Sources section with relevant result URLs in the final response',
      'Use the current year in queries for recent information',
    ],
  },
  async *execute(params, context) {
    const { query } = params;
    const allowedDomains = normalizeDomains(params.allowed_domains);
    const blockedDomains = normalizeDomains(params.blocked_domains);
    const signal = context.signal ?? new AbortController().signal;
    yield {
      kind: 'progress',
      message: `Searching: "${query}"`,
      data: { query, providerCount: searchProviderCount },
    };

    try {
      const { results, provider } = await searchWeb(query, SEARCH_TIMEOUT, signal);
      yield { kind: 'message', content: { summary: `Search completed with ${provider}` } };
      const filtered = filterDomains(results, allowedDomains, blockedDomains);
      const limited = filtered.slice(0, MAX_RESULTS);
      const fetchedAt = new Date().toISOString();
      const payload = {
        query,
        results: limited,
        provider,
        total_results: filtered.length,
        fetched_at: fetchedAt,
      };
      const metadata: WebSearchMetadata = {
        query,
        provider,
        fetched_at: fetchedAt,
        total_results: filtered.length,
        returned_results: limited.length,
        allowed_domains: allowedDomains,
        blocked_domains: blockedDomains,
        summary: `搜索 "${query}": ${limited.length} 条结果`,
      };
      return { status: 'success', model: toJsonValue(payload), metadata };
    } catch (error) {
      return {
        status: 'error',
        model: `WebSearch call failed: ${getErrorMessage(error)}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: getErrorMessage(error),
          details: { query, allowedDomains, blockedDomains },
        },
      };
    }
  },
  preparePermissionMatcher: ({ query }) => ({
    signatureContent: `search:${query.trim().toLowerCase().slice(0, 80)}`,
    abstractRule: 'search:*',
  }),
});

function normalizeDomains(domains?: string[]): string[] {
  return domains?.map((domain) => domain.trim().toLowerCase()).filter(Boolean) ?? [];
}

function filterDomains(
  results: WebSearchResult[],
  allowed: string[],
  blocked: string[],
): WebSearchResult[] {
  return results.filter(({ url }) => {
    let hostname: string;
    try {
      hostname = new URL(url).hostname.toLowerCase();
    } catch {
      return false;
    }
    const matches = (domain: string) => hostname === domain || hostname.endsWith(`.${domain}`);
    return !blocked.some(matches) && (allowed.length === 0 || allowed.some(matches));
  });
}
