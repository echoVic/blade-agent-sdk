import { describe, expect, it } from 'vitest';
import { normalizeSearchText, scoreToolSearchMatch, searchTools } from '../toolSearch.js';

describe('toolSearch shim (root)', () => {
  it('re-exports normalizeSearchText from @blade-ai/agent-sdk/tools', () => {
    expect(typeof normalizeSearchText).toBe('function');
    expect(normalizeSearchText('  HELLO   World  ')).toBe('hello world');
  });

  it('re-exports scoreToolSearchMatch from @blade-ai/agent-sdk/tools', () => {
    expect(typeof scoreToolSearchMatch).toBe('function');
  });

  it('re-exports searchTools from @blade-ai/agent-sdk/tools', () => {
    expect(typeof searchTools).toBe('function');
    // empty query should return empty array
    expect(searchTools([], 'test')).toEqual([]);
  });
});
