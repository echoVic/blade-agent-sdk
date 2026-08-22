import { describe, expect, it, vi } from 'vitest';
import { createContextSnapshot } from '../../../runtime/index.js';
import { completeToolExecution } from '../../../tools/types/index.js';
import { SessionId } from '../../../types/branded.js';
import { executeToolCalls } from '../executeToolCalls.js';

describe('executeToolCalls', () => {
  it('submits parallel calls without an additional batch limit and preserves result order', async () => {
    let releaseExecutions!: () => void;
    const executionGate = new Promise<void>((resolve) => {
      releaseExecutions = resolve;
    });
    const started: string[] = [];
    const calls = Array.from({ length: 12 }, (_, index) => ({
      id: `tool-${index}`,
      type: 'function' as const,
      function: {
        name: `Read${index}`,
        arguments: '{}',
      },
    }));

    const execution = executeToolCalls({
      plan: {
        mode: 'parallel',
        calls,
      },
      executionPipeline: {
        execute: vi.fn(async function* (toolName: string) {
          started.push(toolName);
          yield { kind: 'progress', data: { toolName } };
          await executionGate;
          return {
            status: 'success',
            model: toolName,
          };
        }),
        getRegistry: () => ({
          get: () => undefined,
        }),
      } as never,
      executionContext: {
        sessionId: SessionId('session-parallel'),
        userId: 'user-1',
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(calls.map((call) => call.function.name));

    releaseExecutions();
    const results = await execution;
    expect(results.map((result) => result.toolCall.function.name)).toEqual(
      calls.map((call) => call.function.name),
    );
  });

  it('should forward the turn-scoped context snapshot into tool execution', async () => {
    const execute = vi.fn(() => completeToolExecution({
      status: 'success',
      model: 'ok',
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
        sessionId: SessionId('session-1'),
        userId: 'user-1',
        contextSnapshot: createContextSnapshot(SessionId('session-1'), 'turn-1', {
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

  it('should propagate an already-aborted request signal to block-interrupt tools', async () => {
    const controller = new AbortController();
    controller.abort();

    const execute = vi.fn(() => completeToolExecution({
      status: 'success',
      model: 'ok',
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
        sessionId: SessionId('session-1'),
        userId: 'user-1',
      },
      signal: controller.signal,
    });

    expect(execute).toHaveBeenCalledWith(
      'BlockTool',
      {},
      expect.objectContaining({
        signal: expect.objectContaining({
          aborted: true,
        }),
      }),
    );
  });

  it('returns model-facing content when tool arguments are invalid JSON', async () => {
    const execute = vi.fn(() => completeToolExecution({
      status: 'success',
      model: 'unexpected',
    }));

    const [outcome] = await executeToolCalls({
      plan: {
        mode: 'serial',
        calls: [
          {
            id: 'tool-invalid-json',
            type: 'function',
            function: {
              name: 'Read',
              arguments: '{',
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
        sessionId: SessionId('session-invalid-json'),
        userId: 'user-1',
      },
    });

    expect(execute).not.toHaveBeenCalled();
    expect(outcome.result.status).toBe('error');
    expect(outcome.result.model).toContain('Tool execution failed:');
    expect(outcome.result.model).toContain('JSON');
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
        execute: vi.fn(async function* () {
          yield {
            kind: 'progress',
            message: 'Scanning',
          };
          yield {
            kind: 'message',
            content: { summary: 'Scan complete' },
          };
          yield {
            kind: 'effect',
            effect: {
              type: 'runtimePatch',
              patch: {
                scope: 'turn',
                source: 'tool',
                toolDiscovery: {
                  discover: ['Read'],
                },
              },
            },
          };
          yield {
            kind: 'effect',
            effect: {
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
          };
          yield {
            kind: 'effect',
            effect: {
              type: 'newMessages',
              messages: [{ role: 'assistant', content: 'injected' }],
            },
          };
          yield {
            kind: 'effect',
            effect: {
              type: 'permissionUpdates',
              updates: [
                {
                  type: 'addRules',
                  behavior: 'allow',
                  rules: [{ toolName: 'Read', ruleContent: 'sig:read' }],
                },
              ],
            },
          };
          return {
            status: 'success',
            model: 'ok',
          };
        }),
        getRegistry: () => ({
          get: () => undefined,
        }),
      } as never,
      executionContext: {
        sessionId: SessionId('session-1'),
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
              updates.push(`progress:${update.progress.message}`);
              break;
            case 'tool_message':
              updates.push(`message:${update.content.summary}`);
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
