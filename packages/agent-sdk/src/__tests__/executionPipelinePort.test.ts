import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTool, ToolKind } from '../tools/index.js';
import { ToolRegistry } from '../tools/index.js';
import { ExecutionPipeline } from '../local/executionPipeline.js';
import { PermissionMode } from '../types/common.js';

/**
 * Slice #342 — ExecutionPipeline ported into @blade-ai/agent-sdk/local.
 *
 * The tool execution pipeline (registry lookup, permission resolution with
 * confirmation flows, pre/post hook application, effect normalization,
 * execution history, timeouts, per-kind concurrency, result artifacts) was
 * the largest remaining root file (1468L); root src/tools/execution/
 * ExecutionPipeline.ts is now a re-export shim.
 */

function createPipeline(registry: ToolRegistry): ExecutionPipeline {
  return new ExecutionPipeline(registry, {
    permissionMode: PermissionMode.YOLO,
  });
}

describe('ExecutionPipeline (package local)', () => {
  it('executes a registered tool through the pipeline', async () => {
    const registry = new ToolRegistry();
    registry.register(
      createTool({
        name: 'Echo',
        displayName: 'Echo',
        kind: ToolKind.ReadOnly,
        description: { short: 'Echo input' },
        schema: z.object({ text: z.string() }),
        execute: async ({ text }) => ({ success: true, llmContent: text }),
      }),
    );
    const pipeline = createPipeline(registry);

    const result = await pipeline.execute('Echo', { text: 'hello' }, {});
    expect(result).toMatchObject({ success: true, llmContent: 'hello' });
  });

  it('returns a failure result for unknown tools', async () => {
    const pipeline = createPipeline(new ToolRegistry());
    const result = await pipeline.execute('Missing', {}, {});
    expect(result.success).toBe(false);
  });

  it('records execution history entries', async () => {
    const registry = new ToolRegistry();
    registry.register(
      createTool({
        name: 'Noop',
        displayName: 'Noop',
        kind: ToolKind.ReadOnly,
        description: { short: 'noop' },
        schema: z.object({}),
        execute: async () => ({ success: true, llmContent: 'ok' }),
      }),
    );
    const pipeline = createPipeline(registry);

    await pipeline.execute('Noop', {}, {});
    const history = pipeline.getExecutionHistory();
    expect(history.length).toBe(1);
    expect(history[0]?.toolName).toBe('Noop');
    expect(history[0]?.result.success).toBe(true);
  });
});
