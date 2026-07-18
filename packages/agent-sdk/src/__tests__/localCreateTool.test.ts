import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTool } from '../tools/core/createTool.js';
import type { Tool, ToolConfig } from '../tools/types/index.js';

// Helper: minimal execution context for testing
const mockCtx: import('../tools/types/ExecutionTypes.js').ExecutionContext = {
  contextSnapshot: undefined as unknown as any,
};

describe('createTool (agent-sdk)', () => {
  function makeConfig(): ToolConfig<z.ZodObject<{ path: z.ZodString }>> {
    return {
      name: 'test_tool',
      displayName: 'Test Tool',
      kind: 'Read' as any,
      description: { short: 'A test tool for reading files' },
      schema: z.object({ path: z.string() }),
      execute: async ({ path }) => ({
        success: true,
        llmContent: `Read file at ${path}`,
      }),
    };
  }

  it('creates a Tool from valid config', () => {
    const tool = createTool(makeConfig());
    expect(tool).toBeDefined();
    expect(tool.name).toBe('test_tool');
    expect(tool.displayName).toBe('Test Tool');
    expect(tool.kind).toBe('Read');
  });

  it('exposes a FunctionDeclaration for LLM consumption', () => {
    const tool = createTool(makeConfig());
    const decl = tool.getFunctionDeclaration();
    expect(decl.name).toBe('test_tool');
    expect(decl.description).toContain('A test tool');
    expect(decl.parameters).toHaveProperty('type', 'object');
    expect(decl.parameters).toHaveProperty('properties');
  });

  it('describes itself', () => {
    const tool = createTool(makeConfig());
    const desc = tool.describe({ path: '/tmp/file' });
    expect(desc.short).toBe('A test tool for reading files');
  });

  it('builds an invocation that can be executed', async () => {
    const tool = createTool(makeConfig());
    const inv = tool.build({ path: '/tmp/test' });
    expect(inv.toolName).toBe('test_tool');
    expect(inv.params.path).toBe('/tmp/test');

    const result = await inv.execute(new AbortController().signal);
    expect(result.success).toBe(true);
    expect(result.llmContent).toContain('Read file');
  });

  it('executes directly via Tool.execute', async () => {
    const tool = createTool(makeConfig());
    const result = await tool.execute({ path: '/tmp/direct' });
    expect(result.success).toBe(true);
    expect(result.llmContent).toContain('/tmp/direct');
  });

  it('handles errors gracefully in execute', async () => {
    const config = makeConfig();
    config.execute = async () => {
      throw new Error('Tool execution failed');
    };
    const tool = createTool(config);
    await expect(tool.execute({ path: '/tmp/fail' })).rejects.toThrow();
  });
});
