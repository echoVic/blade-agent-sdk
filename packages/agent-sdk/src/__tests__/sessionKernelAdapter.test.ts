import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTool, ToolErrorType, ToolKind } from '../tools/index.js';
import { createKernelToolPort } from '../local/SessionKernelAdapter.js';
import type { ExecutionPipelineLike, ToolRegistryLike } from '../local/kernelAdapterTypes.js';
import { SessionId } from '../local/branded.js';
import { ToolRegistry } from '../tools/index.js';

/**
 * Slice #336 — SessionKernelAdapter ported into @blade-ai/agent-sdk/local.
 *
 * The adapter (formerly root src/session/SessionKernelAdapter.ts) adapts a
 * session tool registry + execution pipeline to the @blade-ai/agent kernel's
 * AgentToolPort. The phantom ExecutionPipelineLike/ToolRegistryLike interfaces
 * are aligned to the REAL pipeline/registry APIs (3-arg execute returning
 * ToolResult; get + getAll), so both the root ExecutionPipeline and the
 * package ToolRegistry satisfy them structurally.
 */

function createStubPipeline(handler: ExecutionPipelineLike['execute']): ExecutionPipelineLike {
  return { execute: handler };
}

describe('SessionKernelAdapter (package local)', () => {
  it('lists tool declarations from the registry', async () => {
    const registry = new ToolRegistry();
    registry.register(
      createTool({
        name: 'Lookup',
        displayName: 'Lookup',
        kind: ToolKind.ReadOnly,
        description: { short: 'Look up a value' },
        schema: z.object({ q: z.string() }),
        execute: async ({ q }) => ({ success: true, llmContent: { found: q } }),
      }),
    );
    const toolPort = createKernelToolPort({
      registry,
      pipeline: createStubPipeline(async () => ({
        success: true,
        llmContent: 'unused',
      })),
      createExecutionContext: () => ({ sessionId: SessionId('adapter-session') }),
    });

    await expect(toolPort.list()).resolves.toEqual([
      expect.objectContaining({
        name: 'Lookup',
        description: 'Look up a value',
      }),
    ]);
  });

  it('executes tools through the pipeline with the created execution context', async () => {
    const registry: ToolRegistryLike = {
      get: () => undefined,
      getAll: () => [],
    };
    const pipeline = createStubPipeline(async (toolName, params, context) => {
      const ctx = context as { sessionId?: string; signal?: AbortSignal };
      return {
        success: true,
        llmContent: { toolName, ...(params as Record<string, unknown>), sessionId: ctx.sessionId },
      };
    });
    const toolPort = createKernelToolPort({
      registry,
      pipeline,
      createExecutionContext: () => ({ sessionId: SessionId('adapter-exec') }),
    });

    const result = await toolPort.execute(
      { id: 'call-1', name: 'Echo', input: { text: 'hi' } },
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      id: 'call-1',
      name: 'Echo',
      output: { toolName: 'Echo', text: 'hi', sessionId: 'adapter-exec' },
    });
    expect(result.isError).toBeUndefined();
  });

  it('flags failed tool results as errors', async () => {
    const registry: ToolRegistryLike = {
      get: () => undefined,
      getAll: () => [],
    };
    const pipeline = createStubPipeline(async () => ({
      success: false,
      error: { type: ToolErrorType.EXECUTION_ERROR, message: 'boom' },
      llmContent: 'boom',
    }));
    const toolPort = createKernelToolPort({
      registry,
      pipeline,
      createExecutionContext: () => ({}),
    });

    const result = await toolPort.execute(
      { id: 'call-2', name: 'Fail', input: {} },
      undefined,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toBe('boom');
  });
});
