import { describe, expect, it, vi } from 'vitest';
import type { ChatResponse, StreamChunk } from '../../services/ChatServiceInterface.js';
import { ActiveRequestController } from '../../session/ActiveRequestController.js';
import type { ToolExecution, ToolResult } from '../../tools/types/index.js';
import {
  InputId,
  RequestId,
  SessionId,
} from '../../types/branded.js';
import { PermissionMode } from '../../types/common.js';
import { StreamingToolExecutor } from '../StreamingToolExecutor.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function createExecutor(options: {
  streamChat: (
    messages?: unknown,
    tools?: unknown,
    signal?: AbortSignal,
  ) => AsyncGenerator<StreamChunk, void, unknown>;
  fallbackChat?: () => Promise<ChatResponse>;
  execute?: (
    toolName: string,
    params: unknown,
    context?: unknown,
  ) => Promise<ToolResult> | ToolExecution;
  toolKinds?: Record<string, 'readonly' | 'write' | 'execute'>;
  toolInterruptBehaviors?: Record<string, 'cancel' | 'block'>;
}) {
  const execute = vi.fn(
    options.execute
      ?? (async (toolName: string) => ({
        status: 'success',
        model: `result:${toolName}`,
      })),
  );

  const chatService = {
    streamChat: vi.fn(options.streamChat),
    chat: vi.fn(options.fallbackChat ?? (async () => ({ content: '', toolCalls: [] }))),
    getConfig: () => ({
      model: 'test-model',
      maxContextTokens: 128000,
    }),
  };

  const executionPipeline = {
    getRegistry: () => ({
      get: (name: string) => ({
        kind: options.toolKinds?.[name] ?? 'execute',
        interruptBehavior: options.toolInterruptBehaviors?.[name] ?? 'cancel',
      }),
    }),
    execute,
  };

  const executor = new StreamingToolExecutor(
    () => chatService as never,
  );

  return { executor, chatService, executionPipeline, execute };
}

describe('StreamingToolExecutor', () => {
  it('dispatches a tool as soon as arguments become parseable, forwards deltas, and emits stream_end before tool completion', async () => {
    const finishGate = deferred<void>();
    const toolGate = deferred<ToolResult>();
    const order: string[] = [];

    const { executor, execute } = createExecutor({
      streamChat: async function* () {
        yield { content: 'Hello ' };
        yield { reasoningContent: 'Thinking...' };
        yield {
          toolCalls: [
            {
              index: 0,
              id: 'tool-1',
              function: {
                name: 'ReadFile',
                arguments: '{"path":',
              },
            },
          ],
        };
        yield {
          toolCalls: [
            {
              index: 0,
              function: {
                arguments: '"a.txt"}',
              },
            },
          ],
        };
        await finishGate.promise;
        yield { finishReason: 'tool_calls' };
      },
      execute: async () => toolGate.promise,
    });

    const promise = executor.collectAndExecute(
      [{ role: 'user', content: 'read a file' }],
      [{ name: 'ReadFile', description: 'reads', parameters: {} }],
      undefined,
      {
        executionPipeline: executionPipelineFromMock(execute),
        executionContext: {
          sessionId: SessionId('session-1'),
          userId: 'user-1',
        },
        onContentDelta: (delta) => {
          order.push(`content:${delta}`);
        },
        onThinkingDelta: (delta) => {
          order.push(`thinking:${delta}`);
        },
        onStreamEnd: () => {
          order.push('stream_end');
        },
        onToolReady: (toolCall) => {
          order.push(`ready:${toolCall.function.name}`);
        },
        onAfterToolExec: ({ toolCall }) => {
          order.push(`after:${toolCall.function.name}`);
        },
        onToolComplete: (toolCall) => {
          order.push(`complete:${toolCall.function.name}`);
        },
      },
    );

    await tick();
    await tick();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(order).toContain('content:Hello ');
    expect(order).toContain('thinking:Thinking...');
    expect(order).toContain('ready:ReadFile');
    expect(order).not.toContain('stream_end');

    finishGate.resolve();
    await tick();

    expect(order).toContain('stream_end');
    expect(order).not.toContain('complete:ReadFile');

    toolGate.resolve({
      status: 'success',
      model: 'file contents',
    });

    const { executionResults } = await promise;

    expect(executionResults).toHaveLength(1);
    expect(order.indexOf('stream_end')).toBeLessThan(order.indexOf('after:ReadFile'));
    expect(order.indexOf('after:ReadFile')).toBeLessThan(order.indexOf('complete:ReadFile'));
  });

  it('defers streaming tool calls and executes them serially in plan mode', async () => {
    const finishGate = deferred<void>();
    const firstToolGate = deferred<ToolResult>();
    const started: string[] = [];

    const { executor, execute } = createExecutor({
      streamChat: async function* () {
        yield {
          toolCalls: [
            {
              index: 0,
              id: 'tool-1',
              function: {
                name: 'ReadA',
                arguments: '{}',
              },
            },
            {
              index: 1,
              id: 'tool-2',
              function: {
                name: 'ReadB',
                arguments: '{}',
              },
            },
          ],
        };
        await finishGate.promise;
        yield { finishReason: 'tool_calls' };
      },
      execute: async (toolName: string) => {
        started.push(toolName);
        if (toolName === 'ReadA') {
          return firstToolGate.promise;
        }
        return {
          status: 'success',
          model: toolName,
        };
      },
    });

    const execution = executor.collectAndExecute(
      [{ role: 'user', content: 'inspect files' }],
      [
        { name: 'ReadA', description: 'read a', parameters: {} },
        { name: 'ReadB', description: 'read b', parameters: {} },
      ],
      undefined,
      {
        executionPipeline: executionPipelineFromMock(execute),
        executionContext: {
          sessionId: SessionId('session-plan'),
          userId: 'user-1',
        },
        permissionMode: PermissionMode.PLAN,
      },
    );

    await tick();
    expect(started).toEqual([]);

    finishGate.resolve();
    await tick();
    expect(started).toEqual(['ReadA']);

    firstToolGate.resolve({
      status: 'success',
      model: 'ReadA',
    });

    const { executionResults } = await execution;
    expect(started).toEqual(['ReadA', 'ReadB']);
    expect(executionResults.map(({ toolCall }) => toolCall.function.name)).toEqual([
      'ReadA',
      'ReadB',
    ]);
  });

  it('emits unified tool execution updates while preserving legacy callbacks', async () => {
    const updates: string[] = [];

    const { executor, execute } = createExecutor({
      streamChat: async function* () {
        yield {
          toolCalls: [
            {
              index: 0,
              id: 'tool-1',
              function: {
                name: 'ReadFile',
                arguments: '{}',
              },
            },
          ],
        };
        yield { finishReason: 'tool_calls' };
      },
    });

    const { executionResults } = await executor.collectAndExecute(
      [{ role: 'user', content: 'read a file' }],
      [{ name: 'ReadFile', description: 'reads', parameters: {} }],
      undefined,
      {
        executionPipeline: executionPipelineFromMock(execute),
        executionContext: {
          sessionId: SessionId('session-1'),
          userId: 'user-1',
        },
        onToolExecutionUpdate: async (update) => {
          if (update.type === 'tool_ready') {
            updates.push(`update:ready:${update.toolCall.function.name}`);
          }
          if (update.type === 'tool_started') {
            updates.push(`update:started:${update.toolCall.function.name}`);
          }
          if (update.type === 'tool_result') {
            updates.push(`update:result:${update.outcome.toolCall.function.name}`);
          }
          if (update.type === 'tool_completed') {
            updates.push(`update:completed:${update.outcome.toolCall.function.name}`);
          }
        },
        onToolReady: (toolCall) => {
          updates.push(`legacy:ready:${toolCall.function.name}`);
        },
        onAfterToolExec: ({ toolCall }) => {
          updates.push(`legacy:after:${toolCall.function.name}`);
        },
        onToolComplete: (toolCall) => {
          updates.push(`legacy:complete:${toolCall.function.name}`);
        },
      },
    );

    expect(executionResults).toHaveLength(1);
    expect(updates).toEqual([
      'update:ready:ReadFile',
      'legacy:ready:ReadFile',
      'update:started:ReadFile',
      'update:result:ReadFile',
      'legacy:after:ReadFile',
      'update:completed:ReadFile',
      'legacy:complete:ReadFile',
    ]);
  });

  it('forwards progress, output messages, and effects through the unified execution stream', async () => {
    const updates: string[] = [];

    const { executor, execute } = createExecutor({
      streamChat: async function* () {
        yield {
          toolCalls: [
            {
              index: 0,
              id: 'tool-1',
              function: {
                name: 'ReadFile',
                arguments: '{}',
              },
            },
          ],
        };
        yield { finishReason: 'tool_calls' };
      },
      async *execute() {
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
                discover: ['ReadFile'],
              },
            },
          },
        };
        return {
          status: 'success',
          model: 'done',
        };
      },
    });

    await executor.collectAndExecute(
      [{ role: 'user', content: 'read a file' }],
      [{ name: 'ReadFile', description: 'reads', parameters: {} }],
      undefined,
      {
        executionPipeline: executionPipelineFromMock(execute),
        executionContext: {
          sessionId: SessionId('session-1'),
          userId: 'user-1',
        },
        onToolExecutionUpdate: async (update) => {
          if (update.type === 'tool_progress') {
            updates.push(`progress:${update.progress.message}`);
          }
          if (update.type === 'tool_message') {
            updates.push(`message:${update.content.summary}`);
          }
          if (update.type === 'tool_runtime_patch') {
            updates.push('runtimePatch');
          }
          if (update.type === 'tool_result') {
            updates.push(`result:${update.outcome.toolCall.function.name}`);
          }
        },
      },
    );

    expect(updates).toEqual([
      'progress:Scanning',
      'message:Scan complete',
      'runtimePatch',
      'result:ReadFile',
    ]);
  });

  it('buffers results by tool_call index even when tools finish out of order and fires onAfterToolExec per-tool immediately', async () => {
    const slowGate = deferred<ToolResult>();
    const fastGate = deferred<ToolResult>();
    const onAfterOrder: string[] = [];
    const onCompleteOrder: string[] = [];
    let settled = false;

    const { executor, execute } = createExecutor({
      streamChat: async function* () {
        yield {
          toolCalls: [
            {
              index: 0,
              id: 'tool-slow',
              function: {
                name: 'SlowTool',
                arguments: '{}',
              },
            },
            {
              index: 1,
              id: 'tool-fast',
              function: {
                name: 'FastTool',
                arguments: '{}',
              },
            },
          ],
        };
        yield { finishReason: 'tool_calls' };
      },
      execute: async (toolName: string) => {
        if (toolName === 'SlowTool') {
          return slowGate.promise;
        }
        return fastGate.promise;
      },
    });

    const promise = executor
      .collectAndExecute(
        [{ role: 'user', content: 'run tools' }],
        [
          { name: 'SlowTool', description: 'slow', parameters: {} },
          { name: 'FastTool', description: 'fast', parameters: {} },
        ],
        undefined,
        {
          executionPipeline: executionPipelineFromMock(execute),
          executionContext: {
            sessionId: SessionId('session-1'),
            userId: 'user-1',
          },
          onAfterToolExec: ({ toolCall }) => {
            onAfterOrder.push(toolCall.function.name);
          },
          onToolComplete: (toolCall) => {
            onCompleteOrder.push(toolCall.function.name);
          },
        },
      )
      .finally(() => {
        settled = true;
      });

    await tick();
    expect(execute).toHaveBeenCalledTimes(2);

    fastGate.resolve({
      status: 'success',
      model: 'fast done',
    });
    await tick();

    expect(onAfterOrder).toEqual(['FastTool']);
    expect(onCompleteOrder).toEqual(['FastTool']);
    expect(settled).toBe(false);

    slowGate.resolve({
      status: 'success',
      model: 'slow done',
    });

    const { executionResults } = await promise;

    expect(executionResults.map(({ toolCall }) => toolCall.function.name)).toEqual([
      'SlowTool',
      'FastTool',
    ]);
    expect(onAfterOrder).toEqual(['FastTool', 'SlowTool']);
    expect(onCompleteOrder).toEqual(['FastTool', 'SlowTool']);
  });

  it('cascades a Bash failure to pending sibling tools', async () => {
    const bashFinished = deferred<void>();
    const onComplete = vi.fn();
    const onAfter = vi.fn();

    const { executor, execute } = createExecutor({
      streamChat: async function* () {
        yield {
          toolCalls: [
            {
              index: 0,
              id: 'bash-1',
              function: {
                name: 'Bash',
                arguments: '{"command":"exit 1"}',
              },
            },
          ],
        };
        await bashFinished.promise;
        yield {
          toolCalls: [
            {
              index: 1,
              id: 'read-1',
              function: {
                name: 'ReadFile',
                arguments: '{"path":"later"',
              },
            },
          ],
        };
        yield { finishReason: 'tool_calls' };
      },
      execute: async (toolName: string) => {
        if (toolName === 'Bash') {
          bashFinished.resolve();
          return {
            status: 'error',
            model: '',
            error: {
              type: 'execution_error',
              message: 'bash failed',
            },
          } as ToolResult;
        }

        throw new Error('ReadFile should have been cancelled');
      },
    });

    const { executionResults } = await executor.collectAndExecute(
      [{ role: 'user', content: 'run bash then read' }],
      [
        { name: 'Bash', description: 'bash', parameters: {} },
        { name: 'ReadFile', description: 'read', parameters: {} },
      ],
      undefined,
      {
        executionPipeline: executionPipelineFromMock(execute),
        executionContext: {
          sessionId: SessionId('session-1'),
          userId: 'user-1',
        },
        onAfterToolExec: onAfter,
        onToolComplete: onComplete,
      },
    );

    expect(executionResults).toHaveLength(2);
    expect(executionResults[0].toolCall.function.name).toBe('Bash');
    expect(executionResults[0].result.status).toBe('error');
    expect(executionResults[1].toolCall.function.name).toBe('ReadFile');
    expect(executionResults[1].result.status).toBe('error');
    expect(executionResults[1].result.error?.message).toBe('Cancelled due to sibling Bash failure');
    expect(onAfter).toHaveBeenCalledTimes(2);
    expect(onComplete).toHaveBeenCalledTimes(2);
  });

  it('falls back to the wrapped handler when streaming is not supported and uses the planned serial execution strategy', async () => {
    const firstToolGate = deferred<ToolResult>();
    const started: string[] = [];
    const onReady = vi.fn();

    const { executor, chatService, execute } = createExecutor({
      // biome-ignore lint/correctness/useYield: throws before yielding
      streamChat: async function* () {
        throw new Error('stream not supported');
      },
      fallbackChat: async () => ({
        content: '',
        toolCalls: [
          {
            id: 'tool-1',
            type: 'function',
            function: {
              name: 'WriteA',
              arguments: '{}',
            },
          },
          {
            id: 'tool-2',
            type: 'function',
            function: {
              name: 'WriteB',
              arguments: '{}',
            },
          },
        ],
      }),
      execute: async (toolName: string) => {
        started.push(toolName);
        if (toolName === 'WriteA') {
          return firstToolGate.promise;
        }
        return {
          status: 'success',
          model: 'b',
        };
      },
    });

    const promise = executor.collectAndExecute(
      [{ role: 'user', content: 'write files' }],
      [
        { name: 'WriteA', description: 'a', parameters: {} },
        { name: 'WriteB', description: 'b', parameters: {} },
      ],
      undefined,
      {
        executionPipeline: executionPipelineFromMock(execute),
        executionContext: {
          sessionId: SessionId('session-1'),
          userId: 'user-1',
        },
        permissionMode: PermissionMode.PLAN,
        onToolReady: onReady,
      },
    );

    await tick();

    expect(chatService.chat).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(started).toEqual(['WriteA']);

    firstToolGate.resolve({
      status: 'success',
      model: 'a',
    });

    const { executionResults } = await promise;

    expect(started).toEqual(['WriteA', 'WriteB']);
    expect(onReady).toHaveBeenCalledTimes(2);
    expect(executionResults.map(({ toolCall }) => toolCall.function.name)).toEqual([
      'WriteA',
      'WriteB',
    ]);
  });

  it('falls back to the wrapped handler when the stream returns zero chunks', async () => {
    const { executor, chatService, execute } = createExecutor({
      streamChat: async function* () {},
      fallbackChat: async () => ({
        content: 'fallback content',
        toolCalls: [],
      }),
      execute: async () => {
        throw new Error('no tools should execute');
      },
    });

    const result = await executor.collectAndExecute(
      [{ role: 'user', content: 'say hi' }],
      [{ name: 'ReadFile', description: 'read', parameters: {} }],
      undefined,
      {
        executionPipeline: executionPipelineFromMock(execute),
        executionContext: {
          sessionId: SessionId('session-1'),
          userId: 'user-1',
        },
      },
    );

    expect(chatService.chat).toHaveBeenCalledTimes(1);
    expect(result.chatResponse.content).toBe('fallback content');
    expect(result.executionResults).toEqual([]);
  });

  it('propagates context-length errors directly when no tools were dispatched', async () => {
    const { executor, chatService, execute } = createExecutor({
      // biome-ignore lint/correctness/useYield: throws before yielding
      streamChat: async function* () {
        throw new Error('maximum context length exceeded');
      },
      execute: async () => {
        throw new Error('should not execute a tool');
      },
    });

    await expect(
      executor.collectAndExecute(
        [{ role: 'user', content: 'large prompt' }],
        [{ name: 'ReadFile', description: 'read', parameters: {} }],
        undefined,
        {
          executionPipeline: executionPipelineFromMock(execute),
          executionContext: {
            sessionId: SessionId('session-1'),
            userId: 'user-1',
          },
        },
      ),
    ).rejects.toThrow('maximum context length exceeded');

    expect(chatService.chat).not.toHaveBeenCalled();
  });

  it('waits for in-flight tools before rethrowing a context-length error after dispatch', async () => {
    const toolGate = deferred<ToolResult>();
    let settled = false;
    const onAfter = vi.fn();

    const { executor, execute } = createExecutor({
      streamChat: async function* () {
        yield {
          toolCalls: [
            {
              index: 0,
              id: 'tool-1',
              function: {
                name: 'ReadFile',
                arguments: '{}',
              },
            },
          ],
        };
        throw new Error('maximum context length exceeded');
      },
      execute: async () => toolGate.promise,
    });

    const promise = executor
      .collectAndExecute(
        [{ role: 'user', content: 'run then fail' }],
        [{ name: 'ReadFile', description: 'read', parameters: {} }],
        undefined,
        {
          executionPipeline: executionPipelineFromMock(execute),
          executionContext: {
            sessionId: SessionId('session-1'),
            userId: 'user-1',
          },
          onAfterToolExec: onAfter,
        },
      )
      .finally(() => {
        settled = true;
      });

    await tick();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    toolGate.resolve({
      status: 'success',
      model: 'done',
    });

    await expect(promise).rejects.toThrow('maximum context length exceeded');
    expect(onAfter).toHaveBeenCalledTimes(1);
  });

  it('lets block-interrupt tools finish after a steering interrupt', async () => {
    const toolGate = deferred<ToolResult>();
    const runControl = new ActiveRequestController(RequestId('request-blocking'));
    let settled = false;

    const { executor, execute } = createExecutor({
      streamChat: async function* () {
        yield {
          toolCalls: [
            {
              index: 0,
              id: 'tool-1',
              function: {
                name: 'BlockingTool',
                arguments: '{}',
              },
            },
          ],
        };
        while (!runControl.stepSignal.aborted) {
          await tick();
        }
      },
      execute: async () => toolGate.promise,
      toolInterruptBehaviors: {
        BlockingTool: 'block',
      },
    });

    const promise = executor
      .collectAndExecute(
        [{ role: 'user', content: 'run blocking tool' }],
        [{ name: 'BlockingTool', description: 'block', parameters: {} }],
        runControl.stepSignal,
        {
          executionPipeline: executionPipelineFromMock(execute, {
            BlockingTool: { interruptBehavior: 'block' },
          }),
          executionContext: {
            sessionId: SessionId('session-1'),
            userId: 'user-1',
          },
          requestSignal: runControl.requestSignal,
          steeringSignal: runControl.steeringSignal,
        },
      )
      .finally(() => {
        settled = true;
      });

    await tick();
    await tick();
    expect(execute).toHaveBeenCalledTimes(1);

    runControl.interruptStep(InputId('input-now'));
    await tick();

    expect(settled).toBe(false);

    toolGate.resolve({
      status: 'success',
      model: 'finished',
    });

    const result = await promise;
    expect(result.executionResults).toHaveLength(1);
    expect(result.executionResults[0].result.status).toBe('success');
  });

  it('cancels cancel-interrupt tools and marks their result as interrupted', async () => {
    const toolStarted = deferred<void>();
    const runControl = new ActiveRequestController(RequestId('request-cancel'));
    const { executor, execute } = createExecutor({
      streamChat: async function* () {
        yield {
          toolCalls: [
            {
              index: 0,
              id: 'tool-1',
              function: {
                name: 'CancelableTool',
                arguments: '{}',
              },
            },
          ],
        };
        while (!runControl.stepSignal.aborted) {
          await tick();
        }
      },
      execute: async (_toolName, _params, context) => {
        const signal = (context as { signal?: AbortSignal } | undefined)?.signal;
        toolStarted.resolve();
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new Error('cancelled')),
            { once: true },
          );
        });
        return {
          status: 'success',
          model: 'unexpected',
        };
      },
      toolInterruptBehaviors: {
        CancelableTool: 'cancel',
      },
    });

    const promise = executor.collectAndExecute(
      [{ role: 'user', content: 'run cancelable tool' }],
      [{ name: 'CancelableTool', description: 'cancel', parameters: {} }],
      runControl.stepSignal,
      {
        executionPipeline: executionPipelineFromMock(execute, {
          CancelableTool: { interruptBehavior: 'cancel' },
        }),
        executionContext: {
          sessionId: SessionId('session-1'),
          userId: 'user-1',
        },
        requestSignal: runControl.requestSignal,
        steeringSignal: runControl.steeringSignal,
      },
    );
    await toolStarted.promise;

    runControl.interruptStep(InputId('input-now'));
    const result = await promise;

    expect(result.executionResults).toHaveLength(1);
    expect(result.executionResults[0].result).toMatchObject({
      status: 'error',
      error: {
        type: 'interrupted',
        message: 'cancelled',
      },
    });
  });

  it('forwards skillActivationPaths through the streaming execution path', async () => {
    const execute = vi.fn(async (
      _toolName: string,
      _params: unknown,
      context?: unknown,
    ): Promise<ToolResult> => ({
      status: 'success',
      model: 'done',
      metadata: {
        observedSkillActivationPaths: (context as { skillActivationPaths?: string[] } | undefined)?.skillActivationPaths,
      },
    }));

    const { executor } = createExecutor({
      streamChat: async function* () {
        yield {
          toolCalls: [
            {
              index: 0,
              id: 'tool-1',
              function: {
                name: 'ReadFile',
                arguments: '{}',
              },
            },
          ],
        };
        yield { finishReason: 'tool_calls' };
      },
      execute,
    });

    const result = await executor.collectAndExecute(
      [{ role: 'user', content: 'read file' }],
      [{ name: 'ReadFile', description: 'read', parameters: {} }],
      undefined,
      {
        executionPipeline: executionPipelineFromMock(execute),
        executionContext: {
          sessionId: SessionId('session-1'),
          userId: 'user-1',
          skillActivationPaths: ['/workspace/src/index.ts'],
        },
      },
    );

    expect(result.executionResults).toHaveLength(1);
    expect(result.executionResults[0].result.metadata).toMatchObject({
      observedSkillActivationPaths: ['/workspace/src/index.ts'],
    });
  });

  it('synthesizes terminal tool results when steering interrupts model streaming', async () => {
    const streamStarted = deferred<void>();
    const runControl = new ActiveRequestController(
      RequestId('request-1'),
    );
    const { executor, execute } = createExecutor({
      streamChat: async function* (_messages, _tools, signal) {
        yield {
          toolCalls: [
            {
              index: 0,
              id: 'tool-1',
              function: {
                name: 'ReadA',
                arguments: '{"path":"a"}',
              },
            },
            {
              index: 1,
              id: 'tool-2',
              function: {
                name: 'ReadB',
                arguments: '{"path":"b"}',
              },
            },
          ],
        };
        streamStarted.resolve();
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(signal.reason),
            { once: true },
          );
        });
      },
    });

    const execution = executor.collectAndExecute(
      [{ role: 'user', content: 'inspect files' }],
      [
        { name: 'ReadA', description: 'read a', parameters: {} },
        { name: 'ReadB', description: 'read b', parameters: {} },
      ],
      runControl.stepSignal,
      {
        executionPipeline: executionPipelineFromMock(execute),
        executionContext: {
          sessionId: SessionId('session-1'),
          userId: 'user-1',
        },
        requestSignal: runControl.requestSignal,
        steeringSignal: runControl.steeringSignal,
        permissionMode: PermissionMode.PLAN,
      },
    );
    await streamStarted.promise;
    runControl.interruptStep(InputId('input-now'));

    const result = await execution;

    expect(execute).not.toHaveBeenCalled();
    expect(result.chatResponse.toolCalls).toHaveLength(2);
    expect(result.executionResults).toHaveLength(2);
    expect(result.executionResults.map((outcome) => outcome.result)).toEqual([
      expect.objectContaining({
        status: 'error',
        error: expect.objectContaining({ type: 'interrupted' }),
      }),
      expect.objectContaining({
        status: 'error',
        error: expect.objectContaining({ type: 'interrupted' }),
      }),
    ]);
  });
});

function executionPipelineFromMock(
  execute: ReturnType<typeof vi.fn>,
  toolConfigs?: Record<string, { kind?: 'readonly' | 'write' | 'execute'; interruptBehavior?: 'cancel' | 'block' }>,
) {
  return {
    getRegistry: () => ({
      get: (name: string) => ({
        kind: toolConfigs?.[name]?.kind ?? 'execute',
        interruptBehavior: toolConfigs?.[name]?.interruptBehavior ?? 'cancel',
      }),
    }),
    execute: (...args: [string, unknown, unknown?]) => {
      const result = execute(...args);
      return isToolExecution(result)
        ? result
        : completeAsyncToolExecution(result as Promise<ToolResult>);
    },
  } as never;
}

// biome-ignore lint/correctness/useYield: adapts promise-based test gates, not production tools
async function* completeAsyncToolExecution(
  result: Promise<ToolResult>,
): ToolExecution {
  return await result;
}

function isToolExecution(value: unknown): value is ToolExecution {
  return typeof value === 'object'
    && value !== null
    && Symbol.asyncIterator in value;
}
