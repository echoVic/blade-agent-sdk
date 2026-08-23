import type { AgentToolCall } from '@blade-ai/agent/protocol';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTool } from '../tools/core/createTool.js';
import { ExecutionPipeline } from '../local/executionPipeline.js';
import { ToolRegistry } from '../tools/registry/ToolRegistry.js';
import type { Tool } from '../tools/types/index.js';
import { ToolKind } from '../tools/types/ToolKind.js';
import { PermissionMode } from '../types/common.js';
import { createKernelToolPort } from '../local/SessionKernelAdapter.js';

function registerTool<TParams>(registry: ToolRegistry, tool: Tool<TParams>): void {
  registry.register(tool as unknown as Tool);
}

describe('SessionKernelAdapter', () => {
  it('adapts the session tool registry and execution pipeline to AgentToolPort', async () => {
    const registry = new ToolRegistry();
    registerTool(
      registry,
      createTool({
        name: 'Lookup',
        displayName: 'Lookup',
        kind: ToolKind.ReadOnly,
        description: { short: 'Look up a value' },
        schema: z.object({ q: z.string() }),
        execute: async ({ q }) => ({
          success: true,
          llmContent: { found: q },
        }),
      }),
    );
    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
    });
    const toolPort = createKernelToolPort({
      registry,
      pipeline,
      createExecutionContext: () => ({ userId: 'sdk-user' }),
    });

    await expect(toolPort.list()).resolves.toEqual([
      expect.objectContaining({
        name: 'Lookup',
        description: 'Look up a value',
        parameters: expect.objectContaining({
          type: 'object',
          properties: expect.objectContaining({
            q: expect.objectContaining({ type: 'string' }),
          }),
        }),
      }),
    ]);

    const result = await toolPort.execute({
      id: 'call_lookup',
      name: 'Lookup',
      input: { q: 'blade' },
    } satisfies AgentToolCall);

    expect(result).toEqual({
      id: 'call_lookup',
      name: 'Lookup',
      output: { found: 'blade' },
    });
  });

  it('marks failed pipeline results as kernel tool errors', async () => {
    const registry = new ToolRegistry();
    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
    });
    const toolPort = createKernelToolPort({
      registry,
      pipeline,
      createExecutionContext: () => ({}),
    });

    await expect(toolPort.execute({
      id: 'call_missing',
      name: 'MissingTool',
      input: {},
    })).resolves.toEqual({
      id: 'call_missing',
      name: 'MissingTool',
      output: 'Tool execution failed: Tool "MissingTool" not found',
      isError: true,
    });
  });
});
