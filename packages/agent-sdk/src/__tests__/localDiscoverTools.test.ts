import { describe, expect, it } from 'vitest';
import { getBuiltinTools } from '../local/builtin-tools.js';
import { discoverToolsTool } from '../local/system/discoverTools.js';
import { ToolKind } from '../tools/types/ToolKind.js';

describe('agent-sdk local discover tools', () => {
  it('includes the DiscoverTools tool in the builtin tools provider', async () => {
    const tools = await getBuiltinTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('DiscoverTools');
  });

  it('exports a default discoverToolsTool instance', () => {
    expect(discoverToolsTool.name).toBe('DiscoverTools');
    expect(discoverToolsTool.displayName).toBe('Discover Tools');
    expect(discoverToolsTool.kind).toBe(ToolKind.ReadOnly);
  });

  it('DiscoverTools tool accepts valid build params', () => {
    const invocation = discoverToolsTool.build({
      query: 'heavy',
    });
    expect(invocation).toBeDefined();
    expect(typeof invocation.execute).toBe('function');
  });

  it('returns error when no registry is provided', async () => {
    const invocation = discoverToolsTool.build({ query: 'test' });
    const result = await invocation.execute(
      new AbortController().signal,
      undefined,
      {},
    );
    expect(result.success).toBe(false);
    expect(String(result.llmContent)).toContain('unavailable');
  });
});
