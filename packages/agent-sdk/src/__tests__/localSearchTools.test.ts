import { describe, expect, it } from 'vitest';
import { getBuiltinTools } from '../local/builtin-tools.js';
import { createGrepTool, grepTool } from '../local/search/grep.js';
import { ToolKind } from '../tools/types/ToolKind.js';

describe('agent-sdk local search tools', () => {
  it('includes the Grep tool in the builtin tools provider', async () => {
    const tools = await getBuiltinTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toContain('Grep');
  });

  it('creates a Grep tool via factory function', () => {
    const tool = createGrepTool();
    expect(tool.name).toBe('Grep');
    expect(tool.kind).toBe(ToolKind.ReadOnly);
  });

  it('exports a default grepTool instance', () => {
    expect(grepTool.name).toBe('Grep');
    expect(grepTool.displayName).toBe('内容搜索');
  });

  it('default grepTool instance is readonly', () => {
    expect(grepTool.kind).toBe(ToolKind.ReadOnly);
    expect(grepTool.isReadOnly).toBe(true);
  });

  it('grep tool accepts valid build params', () => {
    const tool = createGrepTool();
    const invocation = tool.build({
      pattern: 'test',
      path: '/tmp',
      output_mode: 'files_with_matches',
      '-n': true,
      multiline: false,
    });
    expect(invocation).toBeDefined();
    expect(typeof invocation.execute).toBe('function');
  });
});
