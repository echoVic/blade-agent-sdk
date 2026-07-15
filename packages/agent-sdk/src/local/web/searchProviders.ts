/**
 * Search provider definitions and implementations.
 *
 * WebSearchResult is defined here (not in webSearch.ts) to break the circular
 * dependency between webSearch.ts and SearchCache.ts.
 */

import { type Dispatcher, ProxyAgent } from 'undici';

function getErrorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  return 'UnknownError';
}

// ---------------------------------------------------------------------------
// Shared types (moved here to break circular dep with SearchCache)
// ---------------------------------------------------------------------------

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  display_url: string;
  source: string;
}

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type JsonObject = { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// SearchProvider interface
// ---------------------------------------------------------------------------

export interface SearchProvider {
  name: string;
  endpoint: string;
  method?: 'GET' | 'POST';
  buildUrl: (query: string) => string;
  buildBody?: (query: string) => JsonObject;
  parseResponse: (data: JsonValue) => WebSearchResult[];
  getHeaders: () => Record<string, string>;
  searchFn?: (query: string) => Promise<WebSearchResult[]>;
}

// ---------------------------------------------------------------------------
// DuckDuckGo provider
// ---------------------------------------------------------------------------

interface DuckDuckGoResult {
  FirstURL?: string;
  Text?: string;
  Result?: string;
}

interface DuckDuckGoTopic extends DuckDuckGoResult {
  Topics?: DuckDuckGoTopic[];
}

interface DuckDuckGoResponse {
  Results?: DuckDuckGoResult[];
  RelatedTopics?: DuckDuckGoTopic[];
}

function isDuckDuckGoResponse(data: unknown): data is DuckDuckGoResponse {
  return Boolean(data && typeof data === 'object');
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractTitleAndSnippet(rawText: string): { title: string; snippet: string } {
  const decoded = decodeHtmlEntities(rawText).trim();
  if (!decoded.includes(' - ')) {
    return { title: decoded, snippet: decoded };
  }
  const [maybeTitle, ...rest] = decoded.split(' - ');
  const title = maybeTitle.trim();
  const snippet = rest.join(' - ').trim() || decoded;
  return { title, snippet };
}

function formatDisplayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.hostname}${path}`;
  } catch {
    return url;
  }
}

function extractHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function mapDuckDuckGoResult(entry: DuckDuckGoResult): WebSearchResult | null {
  if (!entry.FirstURL || !entry.Text) return null;
  const { title, snippet } = extractTitleAndSnippet(entry.Text);
  return {
    title,
    snippet,
    url: entry.FirstURL,
    display_url: formatDisplayUrl(entry.FirstURL),
    source: extractHostname(entry.FirstURL),
  };
}

function flattenTopics(topics: DuckDuckGoTopic[]): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  for (const topic of topics) {
    if (topic.Topics && topic.Topics.length > 0) {
      results.push(...flattenTopics(topic.Topics));
      continue;
    }
    if (topic.FirstURL && topic.Text) {
      const { title, snippet } = extractTitleAndSnippet(topic.Text);
      results.push({
        title,
        snippet,
        url: topic.FirstURL,
        display_url: formatDisplayUrl(topic.FirstURL),
        source: extractHostname(topic.FirstURL),
      });
    }
  }
  return results;
}

function transformDuckDuckGoResponse(data: JsonValue): WebSearchResult[] {
  if (!isDuckDuckGoResponse(data)) return [];
  const response = data as DuckDuckGoResponse;
  const directResults = (response.Results ?? [])
    .map(mapDuckDuckGoResult)
    .filter((entry): entry is WebSearchResult => entry !== null);
  const relatedResults = flattenTopics(response.RelatedTopics ?? []);
  return [...directResults, ...relatedResults];
}

const duckDuckGoProvider: SearchProvider = {
  name: 'DuckDuckGo',
  endpoint: 'https://api.duckduckgo.com/',
  method: 'GET',
  buildUrl: (query: string) =>
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
  parseResponse: transformDuckDuckGoResponse,
  getHeaders: () => ({ 'User-Agent': 'BladeAgentSDK/1.0' }),
};

// ---------------------------------------------------------------------------
// SearXNG provider
// ---------------------------------------------------------------------------

const SEARXNG_INSTANCES = [
  'https://searx.be/',
  'https://search.hbubli.cc/',
  'https://paulgo.io/',
  'https://search.sapti.me/',
];

function createSearXNGProvider(instanceUrl: string): SearchProvider {
  return {
    name: `SearXNG (${instanceUrl.replace('https://', '')})`,
    endpoint: instanceUrl,
    method: 'GET',
    buildUrl: (query: string) =>
      `${instanceUrl}search?q=${encodeURIComponent(query)}&format=json&categories=general&language=auto&time_range=&safesearch=0&theme=simple`,
    parseResponse: (data: JsonValue) => {
      const response = data as { results?: Array<{ title?: string; url?: string; content?: string }> };
      const results = response?.results ?? [];
      return results
        .filter((r) => r.title && r.url)
        .map((r) => ({
          title: r.title!,
          url: r.url!,
          snippet: r.content ?? r.title!,
          display_url: formatDisplayUrl(r.url!),
          source: extractHostname(r.url!),
        }));
    },
    getHeaders: () => ({ 'User-Agent': 'BladeAgentSDK/1.0' }),
  };
}

// ---------------------------------------------------------------------------
// Exa MCP provider
// ---------------------------------------------------------------------------

const EXA_MCP_CONFIG = {
  BASE_URL: 'https://mcp.exa.ai',
  ENDPOINT: '/api/mcp',
  DEFAULT_NUM_RESULTS: 5,
  TIMEOUT: 15000,
};

interface McpSearchRequest {
  jsonrpc: string;
  id: number;
  method: string;
  params: {
    name: string;
    arguments: {
      query: string;
      type: string;
      numResults: number;
      contextMaxCharacters: number;
    };
  };
}

interface McpSearchResponse {
  result?: {
    content?: Array<{
      type: string;
      text: string;
    }>;
  };
}

function parseExaMcpResponse(text: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const lines = text.split('\n');
  let currentResult: Partial<{ title: string; url: string; snippet: string }> = {};

  for (const line of lines) {
    if (line.startsWith('Title: ')) {
      if (currentResult.title && currentResult.url) {
        results.push({
          title: currentResult.title,
          url: currentResult.url,
          snippet: currentResult.snippet || currentResult.title,
          display_url: formatDisplayUrl(currentResult.url),
          source: extractHostname(currentResult.url),
        });
      }
      currentResult = { title: line.substring(7).trim() };
    } else if (line.startsWith('URL: ')) {
      currentResult.url = line.substring(5).trim();
    } else if (line.startsWith('Text: ')) {
      const cleanText = line.substring(6).trim()
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      currentResult.snippet = cleanText.substring(0, 300);
    }
  }

  if (currentResult.title && currentResult.url) {
    results.push({
      title: currentResult.title,
      url: currentResult.url,
      snippet: currentResult.snippet || currentResult.title,
      display_url: formatDisplayUrl(currentResult.url),
      source: extractHostname(currentResult.url),
    });
  }

  return results;
}

function createExaProvider(): SearchProvider {
  return {
    name: 'Exa',
    endpoint: `${EXA_MCP_CONFIG.BASE_URL}${EXA_MCP_CONFIG.ENDPOINT}`,
    searchFn: async (query: string): Promise<WebSearchResult[]> => {
      const searchRequest: McpSearchRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'web_search_exa',
          arguments: {
            query,
            type: 'auto',
            numResults: EXA_MCP_CONFIG.DEFAULT_NUM_RESULTS,
            contextMaxCharacters: 10000,
          },
        },
      };

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), EXA_MCP_CONFIG.TIMEOUT);

      try {
        const response = await fetch(
          `${EXA_MCP_CONFIG.BASE_URL}${EXA_MCP_CONFIG.ENDPOINT}`,
          {
            method: 'POST',
            headers: {
              accept: 'application/json, text/event-stream',
              'content-type': 'application/json',
            },
            body: JSON.stringify(searchRequest),
            signal: controller.signal,
          }
        );

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`MCP error (${response.status})`);
        }

        const responseText = await response.text();
        for (const line of responseText.split('\n')) {
          if (line.startsWith('data: ')) {
            const data: McpSearchResponse = JSON.parse(line.substring(6));
            if (data.result?.content && data.result.content.length > 0) {
              return parseExaMcpResponse(data.result.content[0].text);
            }
          }
        }

        throw new Error('No search results found');
      } catch (error) {
        clearTimeout(timeoutId);
        if (getErrorName(error) === 'AbortError') {
          throw new Error('MCP request timed out');
        }
        throw error;
      }
    },
    buildUrl: () => `${EXA_MCP_CONFIG.BASE_URL}${EXA_MCP_CONFIG.ENDPOINT}`,
    parseResponse: () => [],
    getHeaders: () => ({}),
  };
}

// ---------------------------------------------------------------------------
// Provider management
// ---------------------------------------------------------------------------

export function getAllProviders(): SearchProvider[] {
  const providers: SearchProvider[] = [];
  providers.push(createExaProvider());
  providers.push(duckDuckGoProvider);
  providers.push(...SEARXNG_INSTANCES.map(createSearXNGProvider));
  return providers;
}

export function getProviderCount(): number {
  return 1 + 1 + SEARXNG_INSTANCES.length;
}
