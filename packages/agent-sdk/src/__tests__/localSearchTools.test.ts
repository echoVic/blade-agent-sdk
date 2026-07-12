import { describe, expect, it } from 'vitest';
import { getBuiltinTools } from '../local/builtin-tools.js';
import { createGrepTool, grepTool } from '../local/search/grep.js';
import { createGlobTool, globTool } from '../local/search/glob.js';
import { ToolKind } from '../tools/types/ToolKind.js';

describe('agent-sdk local search tools', () => {
  // --- Grep ---
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

  // --- Glob ---
  it('includes the Glob tool in the builtin tools provider', async () => {
    const tools = await getBuiltinTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toContain('Glob');
  });

  it('creates a Glob tool via factory function', () => {
    const tool = createGlobTool();
    expect(tool.name).toBe('Glob');
    expect(tool.kind).toBe(ToolKind.ReadOnly);
  });

  it('exports a default globTool instance', () => {
    expect(globTool.name).toBe('Glob');
    expect(globTool.displayName).toBe('File Pattern Match');
  });

  it('default globTool instance is readonly', () => {
    expect(globTool.kind).toBe(ToolKind.ReadOnly);
    expect(globTool.isReadOnly).toBe(true);
  });

  it('glob tool accepts valid build params', () => {
    const tool = createGlobTool();
    const invocation = tool.build({
      pattern: '**/*.ts',
      path: '/tmp',
      max_results: 10,
      include_directories: false,
      case_sensitive: false,
    });
    expect(invocation).toBeDefined();
    expect(typeof invocation.execute).toBe('function');
  });
});
