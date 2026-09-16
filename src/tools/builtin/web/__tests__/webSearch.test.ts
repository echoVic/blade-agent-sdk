import { afterEach, describe, expect, test, vi } from 'vitest';
import { collectToolExecution } from '../../../types/result.js';
import { webSearchTool } from '../webSearch.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WebSearch Tool', () => {
  test('uses the shared provider pipeline and applies domain filters', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            Results: [
              { FirstURL: 'https://docs.example.com/guide', Text: 'Guide - Useful result' },
              { FirstURL: 'https://blocked.test/page', Text: 'Blocked - Ignore this' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    const result = await collectToolExecution(
      webSearchTool.execute({
        query: `shared-pipeline-${Date.now()}`,
        allowed_domains: ['example.com'],
      }),
    );

    expect(result.status).toBe('success');
    expect(result.metadata).toEqual(
      expect.objectContaining({
        provider: 'DuckDuckGo',
        total_results: 1,
        returned_results: 1,
      }),
    );
    expect(result.model).toEqual(
      expect.objectContaining({
        results: [
          expect.objectContaining({
            title: 'Guide',
            url: 'https://docs.example.com/guide',
          }),
        ],
      }),
    );
  });
});
