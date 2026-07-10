import { describe, expect, it, vi } from 'vitest';
import type { ContextSnapshot } from '../runtime/types.js';
import {
  executePackageLocalToolCalls,
  type PackageLocalToolExecutionPipelinePort,
} from '../session/runtimeToolExecution.js';
import type { ToolResult } from '../tools/types/index.js';

function snapshot(): ContextSnapshot {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    context: {
      capabilities: {
        filesystem: {
          roots: ['/snapshot-root'],
          cwd: '/snapshot-root',
        },
      },
    },
    filesystemRoots: ['/snapshot-root'],
    cwd: '/snapshot-root',
    environment: {},
  };
}

describe('agent-sdk package-local runtime tool execution', () => {
  it('preserves adapter-defined execution context extensions', async () => {
    const adapterCapability = { source: 'root-adapter' };
    const executionContext = {
      sessionId: 'session-1',
      userId: 'user-1',
      adapterCapability,
    } as const;
    const execute = vi.fn(async (_toolName, _params, context) => ({
      success: true as const,
      llmContent: String(
        (context as typeof executionContext).adapterCapability.source,
      ),
    }));

    const [outcome] = await executePackageLocalToolCalls({
      plan: {
        mode: 'serial',
        calls: [{
          id: 'tool-1',
          type: 'function',
          function: { name: 'Read', arguments: '{}' },
        }],
      },
      executionPipeline: {
        execute,
        getRegistry: () => ({ get: () => undefined }),
      },
      executionContext,
    });

    expect(execute).toHaveBeenCalledWith(
      'Read',
      {},
      expect.objectContaining({ adapterCapability }),
    );
    expect(outcome.result).toMatchObject({
      success: true,
      llmContent: 'root-adapter',
    });
  });

  it('forwards the turn-scoped context snapshot into tool execution', async () => {
    const execute = vi.fn(async () => ({
      success: true as const,
      llmContent: 'ok',
    }));
    const pipeline: PackageLocalToolExecutionPipelinePort = {
      execute,
      getRegistry: () => ({ get: () => undefined }),
    };

    await executePackageLocalToolCalls({
      plan: {
        mode: 'serial',
        calls: [
          {
            id: 'tool-1',
            type: 'function',
            function: {
              name: 'Read',
              arguments: JSON.stringify({ file_path: '/tmp/file.txt' }),
            },
          },
        ],
      },
      executionPipeline: pipeline,
      executionContext: {
        sessionId: 'session-1',
        userId: 'user-1',
        contextSnapshot: snapshot(),
      },
    });

    expect(execute).toHaveBeenCalledWith(
      'Read',
      { file_path: '/tmp/file.txt' },
      expect.objectContaining({
        contextSnapshot: expect.objectContaining({
          cwd: '/snapshot-root',
          filesystemRoots: ['/snapshot-root'],
        }),
      }),
    );
  });

  it('ignores an already-aborted outer signal for block-interrupt tools', async () => {
    const controller = new AbortController();
    controller.abort();
    const execute = vi.fn(async () => ({
      success: true as const,
      llmContent: 'ok',
    }));

    await executePackageLocalToolCalls({
      plan: {
        mode: 'serial',
        calls: [
          {
            id: 'tool-1',
            type: 'function',
            function: {
              name: 'BlockTool',
              arguments: '{}',
            },
          },
        ],
      },
      executionPipeline: {
        execute,
        getRegistry: () => ({
          get: () => ({ kind: 'execute', interruptBehavior: 'block' }),
        }),
      },
      executionContext: {
        sessionId: 'session-1',
        userId: 'user-1',
      },
      signal: controller.signal,
    });

    expect(execute).toHaveBeenCalledWith(
      'BlockTool',
      {},
      expect.objectContaining({
        signal: expect.objectContaining({
          aborted: false,
        }),
      }),
    );
  });

  it('emits a unified ready-progress-message-effect-result-completed update sequence', async () => {
    const updates: string[] = [];

    await executePackageLocalToolCalls({
      plan: {
        mode: 'serial',
        calls: [
          {
            id: 'tool-1',
            type: 'function',
            function: {
              name: 'Read',
              arguments: JSON.stringify({ file_path: '/tmp/file.txt' }),
            },
          },
        ],
      },
      executionPipeline: {
        execute: vi.fn(async (_toolName, _params, context): Promise<ToolResult> => {
          await context.onProgress?.('Scanning');
          await context.updateOutput?.('Scan complete');
          return {
            success: true as const,
            llmContent: 'ok',
            effects: [
              {
                type: 'runtimePatch' as const,
                patch: {
                  scope: 'turn' as const,
                  source: 'tool' as const,
                  toolDiscovery: {
                    discover: ['Read'],
                  },
                },
              },
              {
                type: 'contextPatch' as const,
                patch: {
                  scope: 'turn' as const,
                  context: {
                    metadata: {
                      key: 'value',
                    },
                  },
                },
              },
              {
                type: 'newMessages' as const,
                messages: [{ role: 'assistant' as const, content: 'injected' }],
              },
              {
                type: 'permissionUpdates' as const,
                updates: [
                  {
                    type: 'addRules' as const,
                    behavior: 'allow' as const,
                    rules: [{ toolName: 'Read', ruleContent: 'sig:read' }],
                  },
                ],
              },
            ],
          };
        }),
        getRegistry: () => ({ get: () => undefined }),
      },
      executionContext: {
        sessionId: 'session-1',
        userId: 'user-1',
      },
      hooks: {
        onUpdate: async (update) => {
          switch (update.type) {
            case 'tool_ready':
              updates.push(`ready:${update.toolCall.function.name}`);
              break;
            case 'tool_started':
              updates.push(`started:${update.toolCall.function.name}`);
              break;
            case 'tool_progress':
              updates.push(`progress:${update.message}`);
              break;
            case 'tool_message':
              updates.push(`message:${update.message}`);
              break;
            case 'tool_runtime_patch':
              updates.push('runtimePatch');
              break;
            case 'tool_context_patch':
              updates.push('contextPatch');
              break;
            case 'tool_new_messages':
              updates.push(`newMessages:${update.messages.length}`);
              break;
            case 'tool_permission_updates':
              updates.push(`permissionUpdates:${update.updates.length}`);
              break;
            case 'tool_result':
              updates.push(`result:${update.outcome.toolCall.function.name}`);
              break;
            case 'tool_completed':
              updates.push(`completed:${update.outcome.toolCall.function.name}`);
              break;
          }
        },
      },
    });

    expect(updates).toEqual([
      'ready:Read',
      'started:Read',
      'progress:Scanning',
      'message:Scan complete',
      'runtimePatch',
      'contextPatch',
      'newMessages:1',
      'permissionUpdates:1',
      'result:Read',
      'completed:Read',
    ]);
  });
});
