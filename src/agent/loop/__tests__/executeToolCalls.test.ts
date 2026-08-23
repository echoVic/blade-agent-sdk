import { describe, expect, it, vi } from 'vitest';
import { createContextSnapshot } from '../../../runtime/index.js';
import { completeToolExecution, type ExecutionContext } from '../../../tools/types/index.js';
import { ModelAttemptId, SessionId } from '../../../types/branded.js';
import type { JsonObject } from '../../../types/common.js';
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
    const execute = vi.fn(() =>
      completeToolExecution({
        status: 'success',
        model: 'ok',
      }),
    );

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

    const execute = vi.fn(() =>
      completeToolExecution({
        status: 'success',
        model: 'ok',
      }),
    );

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
    const execute = vi.fn(() =>
      completeToolExecution({
        status: 'success',
        model: 'unexpected',
      }),
    );
    const onToolScheduled = vi.fn(async () => undefined);

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
        lifecycle: {
          onToolScheduled,
        },
      },
    });

    expect(execute).not.toHaveBeenCalled();
    expect(onToolScheduled).not.toHaveBeenCalled();
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

  it('awaits durable schedule and settlement around tool execution', async () => {
    const lifecycle: string[] = [];

    const [outcome] = await executeToolCalls({
      plan: {
        mode: 'serial',
        calls: [
          {
            id: 'tool-lifecycle',
            type: 'function',
            function: {
              name: 'Write',
              arguments: '{"value":"ok"}',
            },
          },
        ],
      },
      executionPipeline: {
        // biome-ignore lint/correctness/useYield: test double returns a terminal generator result
        execute: vi.fn(async function* (
          _toolName: string,
          _params: JsonObject,
          context: ExecutionContext,
        ) {
          lifecycle.push(`pipeline:${String(_params.value)}`);
          await context.toolInvocationLifecycle?.onExecutionStarted?.({
            input: _params,
            sideEffect: 'idempotent',
          });
          lifecycle.push('side-effect');
          return {
            status: 'success',
            model: 'ok',
          };
        }),
        getRegistry: () => ({
          get: () => ({
            kind: 'write',
            sideEffect: 'idempotent',
            interruptBehavior: 'block',
          }),
        }),
      } as never,
      executionContext: {
        sessionId: SessionId('session-lifecycle'),
        userId: 'user-1',
        lifecycle: {
          onToolScheduled: async ({
            toolCallId,
            modelInput,
            input,
            sideEffect,
            interruptBehavior,
          }) => {
            lifecycle.push(
              `scheduled:${toolCallId}:${String(modelInput.value)}:${String(input.value)}:${sideEffect}:${interruptBehavior}`,
            );
            input.value = 'mutated';
            return {
              onExecutionStarted: async () => {
                lifecycle.push('execution-started');
              },
            };
          },
          onToolSettled: async ({ result }) => {
            lifecycle.push(`settled:${result.status}`);
          },
        },
      },
      hooks: {
        onUpdate: (update) => {
          lifecycle.push(`update:${update.type}`);
        },
      },
    });

    expect(outcome.result.status).toBe('success');
    expect(lifecycle).toEqual([
      'scheduled:tool-lifecycle:ok:ok:idempotent:block',
      'update:tool_ready',
      'update:tool_started',
      'pipeline:ok',
      'execution-started',
      'side-effect',
      'settled:success',
      'update:tool_result',
      'update:tool_completed',
    ]);
  });

  it('preserves model arguments separately from repaired execution input', async () => {
    const execute = vi.fn(() =>
      completeToolExecution({
        status: 'success',
        model: 'ok',
      }),
    );
    const onToolScheduled = vi.fn(async () => undefined);

    await executeToolCalls({
      plan: {
        mode: 'serial',
        calls: [
          {
            id: 'task-with-repaired-input',
            type: 'function',
            function: {
              name: 'Task',
              arguments: '{"description":"inspect"}',
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
        sessionId: SessionId('session-repaired-input'),
        userId: 'user-1',
        modelAttemptId: ModelAttemptId('model-attempt-repaired-input'),
        lifecycle: {
          onToolScheduled,
        },
      },
    });

    expect(onToolScheduled).toHaveBeenCalledWith({
      toolCallId: 'task-with-repaired-input',
      toolName: 'Task',
      modelAttemptId: 'model-attempt-repaired-input',
      modelInput: { description: 'inspect' },
      input: {
        description: 'inspect',
        subagent_session_id: expect.any(String),
      },
      sideEffect: 'non_idempotent',
      interruptBehavior: 'cancel',
    });
    expect(execute).toHaveBeenCalledWith(
      'Task',
      {
        description: 'inspect',
        subagent_session_id: expect.any(String),
      },
      expect.any(Object),
    );
  });

  it('does not enter the execution pipeline when durable scheduling fails', async () => {
    const execute = vi.fn(() =>
      completeToolExecution({
        status: 'success',
        model: 'unexpected',
      }),
    );
    const onToolSettled = vi.fn(async () => {});

    await expect(
      executeToolCalls({
        plan: {
          mode: 'serial',
          calls: [
            {
              id: 'tool-schedule-failure',
              type: 'function',
              function: {
                name: 'Write',
                arguments: '{}',
              },
            },
          ],
        },
        executionPipeline: {
          execute,
          getRegistry: () => ({
            get: () => ({ kind: 'write', interruptBehavior: 'block' }),
          }),
        } as never,
        executionContext: {
          sessionId: SessionId('session-lifecycle'),
          userId: 'user-1',
          lifecycle: {
            onToolScheduled: async () => {
              throw new Error('schedule write failed');
            },
            onToolSettled,
          },
        },
      }),
    ).rejects.toThrow('schedule write failed');

    expect(execute).not.toHaveBeenCalled();
    expect(onToolSettled).not.toHaveBeenCalled();
  });

  it('does not publish a tool result when durable settlement fails', async () => {
    const updates: string[] = [];

    await expect(
      executeToolCalls({
        plan: {
          mode: 'serial',
          calls: [
            {
              id: 'tool-settle-failure',
              type: 'function',
              function: {
                name: 'Write',
                arguments: '{}',
              },
            },
          ],
        },
        executionPipeline: {
          execute: vi.fn(() =>
            completeToolExecution({
              status: 'success',
              model: 'done',
            }),
          ),
          getRegistry: () => ({
            get: () => ({ kind: 'write', interruptBehavior: 'block' }),
          }),
        } as never,
        executionContext: {
          sessionId: SessionId('session-lifecycle'),
          userId: 'user-1',
          lifecycle: {
            onToolScheduled: async () => undefined,
            onToolSettled: async () => {
              throw new Error('settlement write failed');
            },
          },
        },
        hooks: {
          onUpdate: (update) => {
            updates.push(update.type);
          },
        },
      }),
    ).rejects.toThrow('settlement write failed');

    expect(updates).toEqual(['tool_ready', 'tool_started']);
  });
});
