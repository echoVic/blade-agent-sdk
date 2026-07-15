import { describe, expect, it } from 'vitest';
import { getBuiltinTools } from '../local/builtin-tools.js';
import { webFetchTool, webSearchTool } from '../local/web/index.js';
import { SearchCache, getSearchCache } from '../local/web/SearchCache.js';
import { getAllProviders, getProviderCount } from '../local/web/searchProviders.js';
import { ToolKind } from '../tools/types/ToolKind.js';

describe('agent-sdk local web tools', () => {
  it('includes WebFetch and WebSearch in default builtin tools', async () => {
    const tools = await getBuiltinTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('WebFetch');
    expect(names).toContain('WebSearch');
  });

  it('webFetchTool has correct metadata', () => {
    expect(webFetchTool.name).toBe('WebFetch');
    expect(webFetchTool.kind).toBe(ToolKind.ReadOnly);
  });

  it('webSearchTool has correct metadata', () => {
    expect(webSearchTool.name).toBe('WebSearch');
    expect(webSearchTool.kind).toBe(ToolKind.ReadOnly);
  });

  it('WebFetch accepts valid build params', () => {
    const invocation = webFetchTool.build({
      url: 'https://example.com',
      timeout: 15000,
      method: 'GET',
      extract_content: true,
      follow_redirects: true,
      max_redirects: 5,
      return_headers: false,
    });
    expect(invocation).toBeDefined();
    expect(typeof invocation.execute).toBe('function');
  });

  it('WebSearch accepts valid build params', () => {
    const invocation = webSearchTool.build({ query: 'test' });
    expect(invocation).toBeDefined();
    expect(typeof invocation.execute).toBe('function');
  });

  it('SearchCache getSearchCache returns singleton', () => {
    const cache1 = getSearchCache();
    const cache2 = getSearchCache();
    expect(cache1).toBe(cache2);
    expect(cache1).toBeInstanceOf(SearchCache);
  });

  it('SearchCache can set and get', () => {
    const cache = new SearchCache({ enabled: true });
    const results = [
      { title: 'Test', url: 'https://example.com', snippet: 'desc', display_url: 'example.com', source: 'example.com' },
    ];
    cache.set('test-provider', 'test query', results);
    const cached = cache.get('test-provider', 'test query');
    expect(cached).toEqual(results);
  });

  it('getAllProviders returns configured providers', () => {
    const providers = getAllProviders();
    expect(providers.length).toBeGreaterThanOrEqual(2); // Exa + DuckDuckGo minimum
    expect(getProviderCount()).toBeGreaterThanOrEqual(2);
    expect(providers[0].name).toBe('Exa');
  });
});
