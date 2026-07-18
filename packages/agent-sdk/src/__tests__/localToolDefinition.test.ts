import { describe, expect, it } from 'vitest';

// Type-only imports — verify that these types are exported from the module
import type {
  Tool,
  ToolConfig,
  ToolDefinition,
  ToolDescription,
  ToolInvocation,
  ToolSchema,
  ToolDescriptionResolver,
} from '../tools/types/ToolDefinition.js';

describe('ToolDefinition types (agent-sdk)', () => {
  it('exports Tool type that accepts generic params', () => {
    // Type-check: ToolConfig with any schema should compile
    const toolConfig: Partial<ToolConfig> = {
      name: 'test',
      displayName: 'Test',
      kind: 'execute' as any,
      description: { short: 'A test tool' },
      schema: (() => ({} as any)) as any,
      execute: async () => ({ success: true, llmContent: 'ok' }),
    };
    expect(toolConfig.name).toBe('test');
    expect(toolConfig.execute).toBeDefined();
  });

  it('exports ToolDescriptionResolver type', () => {
    const resolver: ToolDescriptionResolver<{ path: string }> = (params) => {
      return { short: `Read ${params?.path ?? 'unknown'}` };
    };
    const desc = resolver({ path: '/test' });
    expect(desc.short).toBe('Read /test');
  });

  it('exports ToolInvocation type', () => {
    const inv: Partial<ToolInvocation> = {
      toolName: 'test',
      params: {},
      getDescription: () => 'test tool',
      getAffectedPaths: () => [],
      execute: async () => ({ success: true, llmContent: 'ok' }),
    };
    expect(inv.toolName).toBe('test');
    expect(inv.execute).toBeDefined();
  });
});
