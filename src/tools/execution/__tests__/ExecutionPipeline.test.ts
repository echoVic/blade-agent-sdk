import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import { ToolRegistry } from '../../registry/ToolRegistry.js';
import { PermissionMode } from '../../../types/common.js';
import type { Tool } from '../../types/index.js';
import { ToolKind } from '../../types/ToolTypes.js';
import { ExecutionPipeline } from '../ExecutionPipeline.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function registerTool(registry: ToolRegistry, tool: Tool<{ id: string }>): void {
  registry.register(tool as unknown as Tool);
}

describe('ExecutionPipeline', () => {
  it('limits readonly concurrency and preserves result order', async () => {
    const registry = new ToolRegistry();
    let activeCount = 0;
    let maxActiveCount = 0;

    registerTool(
      registry,
      createTool({
        name: 'ReadTool',
        displayName: 'Read Tool',
        kind: ToolKind.ReadOnly,
        description: { short: 'Read tool' },
        schema: z.object({ id: z.string() }),
        execute: async ({ id }) => {
          activeCount += 1;
          maxActiveCount = Math.max(maxActiveCount, activeCount);
          await sleep(30);
          activeCount -= 1;
          return {
            success: true,
            llmContent: `read:${id}`,
            displayContent: `read:${id}`,
          };
        },
      })
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
      maxConcurrency: 2,
    });

    const results = await pipeline.executeAll([
      { toolName: 'ReadTool', params: { id: '1' }, context: {} },
      { toolName: 'ReadTool', params: { id: '2' }, context: {} },
      { toolName: 'ReadTool', params: { id: '3' }, context: {} },
    ]);

    expect(maxActiveCount).toBe(2);
    expect(results.map((result) => result.llmContent)).toEqual([
      'read:1',
      'read:2',
      'read:3',
    ]);
  });

  it('serializes write and execute tools even when they are concurrency safe', async () => {
    const registry = new ToolRegistry();
    let activeCount = 0;
    let maxActiveCount = 0;

    registerTool(
      registry,
      createTool({
        name: 'WriteTool',
        displayName: 'Write Tool',
        kind: ToolKind.Write,
        isConcurrencySafe: true,
        description: { short: 'Write tool' },
        schema: z.object({ id: z.string() }),
        execute: async ({ id }) => {
          activeCount += 1;
          maxActiveCount = Math.max(maxActiveCount, activeCount);
          await sleep(20);
          activeCount -= 1;
          return {
            success: true,
            llmContent: `write:${id}`,
            displayContent: `write:${id}`,
          };
        },
      })
    );

    registerTool(
      registry,
      createTool({
        name: 'ExecTool',
        displayName: 'Exec Tool',
        kind: ToolKind.Execute,
        isConcurrencySafe: true,
        description: { short: 'Exec tool' },
        schema: z.object({ id: z.string() }),
        execute: async ({ id }) => {
          activeCount += 1;
          maxActiveCount = Math.max(maxActiveCount, activeCount);
          await sleep(20);
          activeCount -= 1;
          return {
            success: true,
            llmContent: `exec:${id}`,
            displayContent: `exec:${id}`,
          };
        },
      })
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
      maxConcurrency: 10,
    });

    const results = await pipeline.executeAll([
      { toolName: 'WriteTool', params: { id: '1' }, context: {} },
      { toolName: 'ExecTool', params: { id: '2' }, context: {} },
      { toolName: 'WriteTool', params: { id: '3' }, context: {} },
    ]);

    expect(maxActiveCount).toBe(1);
    expect(results.map((result) => result.llmContent)).toEqual([
      'write:1',
      'exec:2',
      'write:3',
    ]);
  });

  it('partitions non-concurrency-safe readonly tools into serial batches', () => {
    const registry = new ToolRegistry();

    registerTool(
      registry,
      createTool({
        name: 'ReadSafe',
        displayName: 'Read Safe',
        kind: ToolKind.ReadOnly,
        isConcurrencySafe: true,
        description: { short: 'Safe readonly tool' },
        schema: z.object({ id: z.string() }),
        execute: async ({ id }) => ({
          success: true,
          llmContent: `safe:${id}`,
          displayContent: `safe:${id}`,
        }),
      })
    );

    registerTool(
      registry,
      createTool({
        name: 'ReadUnsafe',
        displayName: 'Read Unsafe',
        kind: ToolKind.ReadOnly,
        isConcurrencySafe: false,
        description: { short: 'Unsafe readonly tool' },
        schema: z.object({ id: z.string() }),
        execute: async ({ id }) => ({
          success: true,
          llmContent: `unsafe:${id}`,
          displayContent: `unsafe:${id}`,
        }),
      })
    );

    const pipeline = new ExecutionPipeline(registry, {
      permissionMode: PermissionMode.YOLO,
    });

    const batches = (
      pipeline as unknown as {
        partitionToolCalls: (
          requests: Array<{ toolName: string; params: Record<string, unknown>; context: object }>
        ) => Array<{ mode: 'parallel' | 'serial'; requests: Array<{ toolName: string }> }>;
      }
    ).partitionToolCalls([
      { toolName: 'ReadSafe', params: { id: '1' }, context: {} },
      { toolName: 'ReadUnsafe', params: { id: '2' }, context: {} },
      { toolName: 'ReadSafe', params: { id: '3' }, context: {} },
    ]);

    expect(
      batches.map((batch) => ({
        mode: batch.mode,
        toolNames: batch.requests.map((request) => request.toolName),
      }))
    ).toEqual([
      { mode: 'parallel', toolNames: ['ReadSafe'] },
      { mode: 'serial', toolNames: ['ReadUnsafe'] },
      { mode: 'parallel', toolNames: ['ReadSafe'] },
    ]);
  });
});
