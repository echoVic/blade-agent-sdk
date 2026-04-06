import { describe, expect, it, vi } from 'vitest';
import { createContextSnapshot } from '../../../runtime/index.js';
import { executeToolCalls } from '../executeToolCalls.js';

describe('executeToolCalls', () => {
  it('should forward the turn-scoped context snapshot into tool execution', async () => {
    const execute = vi.fn(async () => ({
      success: true,
      llmContent: 'ok',
      displayContent: 'ok',
    }));

    await executeToolCalls({
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
        execute,
        getRegistry: () => ({
          get: () => undefined,
        }),
      } as never,
      executionContext: {
        sessionId: 'session-1',
        userId: 'user-1',
        contextSnapshot: createContextSnapshot('session-1', 'turn-1', {
          capabilities: {
            filesystem: {
              roots: ['/snapshot-root'],
              cwd: '/snapshot-root',
            },
          },
        }),
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

  it('should ignore an already-aborted outer signal for block-interrupt tools', async () => {
    const controller = new AbortController();
    controller.abort();

    const execute = vi.fn(async () => ({
      success: true,
      llmContent: 'ok',
      displayContent: 'ok',
    }));

    await executeToolCalls({
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
      } as never,
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

  it('emits a unified ready-progress-message-effect-result-completed update sequence for each tool call', async () => {
    const updates: string[] = [];

    await executeToolCalls({
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
        execute: vi.fn(async (_toolName, _params, context) => {
          await context?.onProgress?.('Scanning');
          await context?.updateOutput?.('Scan complete');
          return {
            success: true,
            llmContent: 'ok',
            displayContent: 'ok',
            effects: [
              {
                type: 'runtimePatch',
                patch: {
                  scope: 'turn',
                  source: 'tool',
                  toolDiscovery: {
                    discover: ['Read'],
                  },
                },
              },
              {
                type: 'contextPatch',
                patch: {
                  scope: 'turn',
                  context: {
                    metadata: {
                      key: 'value',
                    },
                  },
                },
              },
              {
                type: 'newMessages',
                messages: [{ role: 'assistant', content: 'injected' }],
              },
              {
                type: 'permissionUpdates',
                updates: [
                  {
                    type: 'addRules',
                    behavior: 'allow',
                    rules: [{ toolName: 'Read', ruleContent: 'sig:read' }],
                  },
                ],
              },
            ],
          };
        }),
        getRegistry: () => ({
          get: () => undefined,
        }),
      } as never,
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
