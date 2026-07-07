import type { AgentStreamEvent } from '@blade-ai/agent';
import { describe, expect, it, vi } from 'vitest';
import type { TraceRecorder } from '../observability/TraceRecorder.js';
import {
  createPackageLocalRuntimeKernelTurnStreamOperations,
  streamPackageLocalAgentKernelTurn,
  streamPackageLocalRuntimeAgentKernelTurn,
} from '../session/runtimeKernelTurnStream.js';

describe('agent-sdk package-local kernel turn stream helper', () => {
  it('projects kernel events and finalizes successful traces with retained usage', async () => {
    const usage = {
      promptTokens: 3,
      completionTokens: 5,
      totalTokens: 8,
    };
    const events: AgentStreamEvent[] = [
      { type: 'content', delta: 'hello' },
      { type: 'usage', usage },
      { type: 'result', content: 'hello' },
    ];
    const trace = { id: 'trace-1' };
    const traceRecorder = {
      finish: vi.fn(() => trace),
    } as unknown as TraceRecorder;
    const traceManager = {
      remember: vi.fn(),
      notifySink: vi.fn(async () => undefined),
    };
    const hookRuntime = {
      enable: vi.fn(),
      setTraceCollector: vi.fn(),
    };

    const messages = [];
    for await (const message of streamPackageLocalAgentKernelTurn({
      sessionId: 'session-1',
      streamOptions: {
        input: 'hi',
      },
      kernel: {
        async *runTurn() {
          yield* events;
        },
      },
      traceRecorder,
      traceManager,
      hookRuntime,
      maxContextTokens: 99,
    })) {
      messages.push(message);
    }

    expect(messages).toEqual([
      { type: 'turn_start', turn: 1, sessionId: 'session-1' },
      { type: 'content', delta: 'hello', sessionId: 'session-1' },
      {
        type: 'usage',
        usage: {
          inputTokens: 3,
          outputTokens: 5,
          totalTokens: 8,
          maxContextTokens: 99,
        },
        sessionId: 'session-1',
      },
      { type: 'turn_end', turn: 1, sessionId: 'session-1' },
      {
        type: 'result',
        subtype: 'success',
        content: 'hello',
        sessionId: 'session-1',
      },
    ]);
    expect(traceRecorder.finish).toHaveBeenCalledWith('success', {
      content: 'hello',
      usage,
    });
    expect(traceManager.remember).toHaveBeenCalledWith(trace);
    expect(traceManager.notifySink).toHaveBeenCalledWith(trace);
    expect(hookRuntime.setTraceCollector).toHaveBeenNthCalledWith(1, traceRecorder);
    expect(hookRuntime.setTraceCollector).toHaveBeenLastCalledWith(undefined);
  });

  it('reports successful kernel results through TaskCompleted hooks', async () => {
    const runTaskCompleted = vi.fn(async (_payload: unknown) => undefined);
    const traceRecorder = {
      finish: vi.fn(() => ({ id: 'trace-task' })),
    } as unknown as TraceRecorder;

    const messages = [];
    for await (const message of streamPackageLocalAgentKernelTurn({
      sessionId: 'session-task',
      streamOptions: {
        input: 'summarize the repo',
        turnId: 'turn-task',
      },
      kernel: {
        async *runTurn() {
          yield { type: 'result', content: 'repo summary' } satisfies AgentStreamEvent;
        },
      },
      traceRecorder,
      traceManager: {
        remember: vi.fn(),
        notifySink: vi.fn(async () => undefined),
      },
      hookRuntime: {
        enable: vi.fn(),
        setTraceCollector: vi.fn(),
        runTaskCompleted,
      },
      maxContextTokens: 99,
    })) {
      messages.push(message);
    }

    expect(messages).toContainEqual({
      type: 'result',
      subtype: 'success',
      content: 'repo summary',
      sessionId: 'session-task',
    });
    expect(runTaskCompleted).toHaveBeenCalledWith({
      taskId: 'turn-task',
      taskDescription: 'summarize the repo',
      resultSummary: 'repo summary',
      success: true,
      abortSignal: undefined,
    });
  });

  it('preserves successful kernel results when TaskCompleted hooks throw', async () => {
    const trace = { id: 'trace-task-hook-failure' };
    const traceRecorder = {
      finish: vi.fn(() => trace),
    } as unknown as TraceRecorder;
    const traceManager = {
      remember: vi.fn(),
      notifySink: vi.fn(async () => undefined),
    };
    const runTaskCompleted = vi.fn(async () => {
      throw new Error('task hook failed after success');
    });

    const messages = [];
    for await (const message of streamPackageLocalAgentKernelTurn({
      sessionId: 'session-task-hook-failure',
      streamOptions: {
        input: 'summarize the repo',
        turnId: 'turn-task-hook-failure',
      },
      kernel: {
        async *runTurn() {
          yield { type: 'result', content: 'repo summary' } satisfies AgentStreamEvent;
        },
      },
      traceRecorder,
      traceManager,
      hookRuntime: {
        enable: vi.fn(),
        setTraceCollector: vi.fn(),
        runTaskCompleted,
      },
      maxContextTokens: 99,
    })) {
      messages.push(message);
    }

    expect(messages).toContainEqual({
      type: 'result',
      subtype: 'success',
      content: 'repo summary',
      sessionId: 'session-task-hook-failure',
    });
    expect(traceRecorder.finish).toHaveBeenCalledWith('success', {
      content: 'repo summary',
      usage: undefined,
    });
    expect(traceManager.remember).toHaveBeenCalledWith(trace);
    expect(traceManager.notifySink).toHaveBeenCalledWith(trace);
    expect(runTaskCompleted).toHaveBeenCalledWith({
      taskId: 'turn-task-hook-failure',
      taskDescription: 'summarize the repo',
      resultSummary: 'repo summary',
      success: true,
      abortSignal: undefined,
    });
  });

  it('records swallowed TaskCompleted hook failures on the trace', async () => {
    const trace = { id: 'trace-task-hook-suppressed' };
    const traceRecorder = {
      addEvent: vi.fn(),
      finish: vi.fn(() => trace),
    } as unknown as TraceRecorder;
    const runTaskCompleted = vi.fn(async () => {
      throw new Error('task hook failed but result is valid');
    });

    const messages = [];
    for await (const message of streamPackageLocalAgentKernelTurn({
      sessionId: 'session-task-hook-suppressed',
      streamOptions: {
        input: 'summarize the repo',
        turnId: 'turn-task-hook-suppressed',
      },
      kernel: {
        async *runTurn() {
          yield { type: 'result', content: 'repo summary' } satisfies AgentStreamEvent;
        },
      },
      traceRecorder,
      traceManager: {
        remember: vi.fn(),
        notifySink: vi.fn(async () => undefined),
      },
      hookRuntime: {
        enable: vi.fn(),
        setTraceCollector: vi.fn(),
        runTaskCompleted,
      },
      maxContextTokens: 99,
    })) {
      messages.push(message);
    }

    expect(messages).toContainEqual({
      type: 'result',
      subtype: 'success',
      content: 'repo summary',
      sessionId: 'session-task-hook-suppressed',
    });
    expect(traceRecorder.addEvent).toHaveBeenCalledWith('hook_error', {
      event: 'TaskCompleted',
      error: 'task hook failed but result is valid',
      suppressed: true,
    });
  });

  it('preserves successful kernel results when suppressed hook trace recording throws', async () => {
    const trace = { id: 'trace-task-hook-trace-failure' };
    const traceRecorder = {
      addEvent: vi.fn(() => {
        throw new Error('trace event write failed');
      }),
      finish: vi.fn(() => trace),
    } as unknown as TraceRecorder;
    const traceManager = {
      remember: vi.fn(),
      notifySink: vi.fn(async () => undefined),
    };
    const runTaskCompleted = vi.fn(async () => {
      throw new Error('task hook failed before trace write');
    });

    const messages = [];
    for await (const message of streamPackageLocalAgentKernelTurn({
      sessionId: 'session-task-hook-trace-failure',
      streamOptions: {
        input: 'summarize the repo',
        turnId: 'turn-task-hook-trace-failure',
      },
      kernel: {
        async *runTurn() {
          yield { type: 'result', content: 'repo summary' } satisfies AgentStreamEvent;
        },
      },
      traceRecorder,
      traceManager,
      hookRuntime: {
        enable: vi.fn(),
        setTraceCollector: vi.fn(),
        runTaskCompleted,
      },
      maxContextTokens: 99,
    })) {
      messages.push(message);
    }

    expect(messages).toContainEqual({
      type: 'result',
      subtype: 'success',
      content: 'repo summary',
      sessionId: 'session-task-hook-trace-failure',
    });
    expect(traceRecorder.finish).toHaveBeenCalledWith('success', {
      content: 'repo summary',
      usage: undefined,
    });
    expect(traceManager.remember).toHaveBeenCalledWith(trace);
    expect(traceManager.notifySink).toHaveBeenCalledWith(trace);
  });

  it('reports kernel error events through TaskCompleted hooks', async () => {
    const abortController = new AbortController();
    const runTaskCompleted = vi.fn(async (_payload: unknown) => undefined);
    const traceRecorder = {
      finish: vi.fn(() => ({ id: 'trace-task-error' })),
    } as unknown as TraceRecorder;

    const messages = [];
    for await (const message of streamPackageLocalAgentKernelTurn({
      sessionId: 'session-task-error',
      streamOptions: {
        input: 'fail the repo summary',
        turnId: 'turn-task-error',
        signal: abortController.signal,
      },
      kernel: {
        async *runTurn() {
          yield {
            type: 'error',
            message: 'model failed',
            code: 'MODEL_FAILED',
          } satisfies AgentStreamEvent;
        },
      },
      traceRecorder,
      traceManager: {
        remember: vi.fn(),
        notifySink: vi.fn(async () => undefined),
      },
      hookRuntime: {
        enable: vi.fn(),
        setTraceCollector: vi.fn(),
        runTaskCompleted,
      },
      maxContextTokens: 99,
    })) {
      messages.push(message);
    }

    expect(messages).toContainEqual({
      type: 'error',
      message: 'model failed',
      code: 'MODEL_FAILED',
      sessionId: 'session-task-error',
    });
    expect(runTaskCompleted).toHaveBeenCalledWith({
      taskId: 'turn-task-error',
      taskDescription: 'fail the repo summary',
      resultSummary: 'model failed',
      success: false,
      abortSignal: abortController.signal,
    });
  });

  it('preserves kernel error events when TaskCompleted hooks throw', async () => {
    const trace = { id: 'trace-error-hook-failure' };
    const traceRecorder = {
      finish: vi.fn(() => trace),
    } as unknown as TraceRecorder;
    const traceManager = {
      remember: vi.fn(),
      notifySink: vi.fn(async () => undefined),
    };
    const runTaskCompleted = vi.fn(async () => {
      throw new Error('task hook failed after error event');
    });

    const messages = [];
    for await (const message of streamPackageLocalAgentKernelTurn({
      sessionId: 'session-error-hook-failure',
      streamOptions: {
        input: 'fail the repo summary',
        turnId: 'turn-error-hook-failure',
      },
      kernel: {
        async *runTurn() {
          yield {
            type: 'error',
            message: 'model failed',
            code: 'MODEL_FAILED',
          } satisfies AgentStreamEvent;
        },
      },
      traceRecorder,
      traceManager,
      hookRuntime: {
        enable: vi.fn(),
        setTraceCollector: vi.fn(),
        runTaskCompleted,
      },
      maxContextTokens: 99,
    })) {
      messages.push(message);
    }

    expect(messages).toContainEqual({
      type: 'error',
      message: 'model failed',
      code: 'MODEL_FAILED',
      sessionId: 'session-error-hook-failure',
    });
    expect(traceRecorder.finish).toHaveBeenCalledWith('error', {
      error: 'model failed',
      code: 'MODEL_FAILED',
    });
    expect(traceManager.remember).toHaveBeenCalledWith(trace);
    expect(traceManager.notifySink).toHaveBeenCalledWith(trace);
    expect(runTaskCompleted).toHaveBeenCalledWith({
      taskId: 'turn-error-hook-failure',
      taskDescription: 'fail the repo summary',
      resultSummary: 'model failed',
      success: false,
      abortSignal: undefined,
    });
  });

  it('finalizes thrown stream errors and rethrows them', async () => {
    const error = new Error('stream failed');
    const trace = { id: 'trace-2' };
    const traceRecorder = {
      finish: vi.fn(() => trace),
    } as unknown as TraceRecorder;
    const runTaskCompleted = vi.fn(async (_payload: unknown) => undefined);
    let activeCollector: unknown;

    const stream = streamPackageLocalAgentKernelTurn({
      sessionId: 'session-1',
      streamOptions: {
        input: 'hi',
        turnId: 'turn-1',
      },
      kernel: {
        async *runTurn(turn) {
          expect(turn).toEqual({
            input: 'hi',
            turnId: 'turn-1',
            signal: undefined,
          });
          yield { type: 'content', delta: 'before failure' };
          throw error;
        },
      },
      traceRecorder,
      traceManager: {
        remember: vi.fn(),
        notifySink: vi.fn(async () => undefined),
      },
      hookRuntime: {
        enable: vi.fn(),
        setTraceCollector: vi.fn((collector) => {
          activeCollector = collector;
        }),
        runTaskCompleted: vi.fn(async (payload) => {
          expect(activeCollector).toBe(traceRecorder);
          await runTaskCompleted(payload);
        }),
      },
      maxContextTokens: 99,
    });

    await expect(async () => {
      for await (const _message of stream) {
        // drain
      }
    }).rejects.toThrow(error);
    expect(traceRecorder.finish).toHaveBeenCalledWith('error', {
      error: 'stream failed',
    });
    expect(runTaskCompleted).toHaveBeenCalledWith({
      taskId: 'turn-1',
      taskDescription: 'hi',
      resultSummary: 'stream failed',
      success: false,
      abortSignal: undefined,
    });
    expect(activeCollector).toBeUndefined();
  });

  it('preserves thrown stream errors when TaskCompleted failure hooks throw', async () => {
    const streamError = new Error('stream failed first');
    const hookError = new Error('task hook failed later');
    const trace = { id: 'trace-hook-failure' };
    const traceRecorder = {
      finish: vi.fn(() => trace),
    } as unknown as TraceRecorder;
    const traceManager = {
      remember: vi.fn(),
      notifySink: vi.fn(async () => undefined),
    };
    let activeCollector: unknown;

    const stream = streamPackageLocalAgentKernelTurn({
      sessionId: 'session-hook-failure',
      streamOptions: {
        input: 'summarize before failure',
        turnId: 'turn-hook-failure',
      },
      kernel: {
        async *runTurn() {
          yield { type: 'content', delta: 'before failure' } satisfies AgentStreamEvent;
          throw streamError;
        },
      },
      traceRecorder,
      traceManager,
      hookRuntime: {
        enable: vi.fn(),
        setTraceCollector: vi.fn((collector) => {
          activeCollector = collector;
        }),
        runTaskCompleted: vi.fn(async () => {
          expect(activeCollector).toBe(traceRecorder);
          throw hookError;
        }),
      },
      maxContextTokens: 99,
    });

    await expect(async () => {
      for await (const _message of stream) {
        // drain
      }
    }).rejects.toThrow(streamError);
    expect(traceRecorder.finish).toHaveBeenCalledWith('error', {
      error: 'stream failed first',
    });
    expect(traceManager.remember).toHaveBeenCalledWith(trace);
    expect(traceManager.notifySink).toHaveBeenCalledWith(trace);
    expect(activeCollector).toBeUndefined();
  });

  it('resolves the kernel model, creates a trace recorder, and delegates the kernel stream', async () => {
    const model = {
      generate: vi.fn(),
      stream: vi.fn(),
    };
    const trace = { id: 'trace-3' };
    const traceRecorder = {
      finish: vi.fn(() => trace),
    } as unknown as TraceRecorder;
    const traceManager = {
      createRecorder: vi.fn(() => traceRecorder),
      remember: vi.fn(),
      notifySink: vi.fn(async () => undefined),
    };
    const kernelModelResolver = {
      resolve: vi.fn(() => ({
        model,
        modelRequestDefaults: {
          maxContextTokens: 42,
        },
      })),
    };
    const createAgentKernel = vi.fn((_kernelOptions, _kernelModel) => ({
      async *runTurn() {
        yield {
          type: 'usage',
          usage: {
            promptTokens: 2,
            completionTokens: 4,
            totalTokens: 6,
          },
        } satisfies AgentStreamEvent;
        yield { type: 'result', content: 'done' } satisfies AgentStreamEvent;
      },
    }));

    const messages = [];
    for await (const message of streamPackageLocalRuntimeAgentKernelTurn({
      sessionId: 'session-1',
      streamOptions: {
        input: 'hello',
        modelId: 'glm-5.2',
      },
      bladeConfig: {
        models: [],
        currentModelId: 'default-model',
      },
      traceManager,
      hookRuntime: {
        enable: vi.fn(),
        setTraceCollector: vi.fn(),
      },
      kernelModelResolver,
      createAgentKernel,
    })) {
      messages.push(message);
    }

    expect(kernelModelResolver.resolve).toHaveBeenCalledWith({
      bladeConfig: {
        models: [],
        currentModelId: 'default-model',
      },
      modelId: 'glm-5.2',
    });
    expect(traceManager.createRecorder).toHaveBeenCalledWith('hello');
    expect(createAgentKernel).toHaveBeenCalledWith(
      {
        input: 'hello',
        modelId: 'glm-5.2',
        traceRecorder,
      },
      {
        model,
        modelRequestDefaults: {
          maxContextTokens: 42,
        },
      },
    );
    expect(messages).toContainEqual({
      type: 'usage',
      usage: {
        inputTokens: 2,
        outputTokens: 4,
        totalTokens: 6,
        maxContextTokens: 42,
      },
      sessionId: 'session-1',
    });
    expect(traceRecorder.finish).toHaveBeenCalledWith('success', {
      content: 'done',
      usage: {
        promptTokens: 2,
        completionTokens: 4,
        totalTokens: 6,
      },
    });
  });

  it('creates stream operations that delegate runtime turn streaming through injected ports', async () => {
    const model = {
      generate: vi.fn(),
      stream: vi.fn(),
    };
    const traceRecorder = {
      finish: vi.fn(() => ({ id: 'trace-4' })),
    } as unknown as TraceRecorder;
    const traceManager = {
      createRecorder: vi.fn(() => traceRecorder),
      remember: vi.fn(),
      notifySink: vi.fn(async () => undefined),
    };
    const kernelModelResolver = {
      resolve: vi.fn(() => ({
        model,
        modelRequestDefaults: {
          maxContextTokens: 24,
        },
      })),
    };
    const createAgentKernel = vi.fn((_kernelOptions, _kernelModel) => ({
      async *runTurn() {
        yield { type: 'content', delta: 'hi' } satisfies AgentStreamEvent;
        yield { type: 'result', content: 'hi' } satisfies AgentStreamEvent;
      },
    }));
    const operations = createPackageLocalRuntimeKernelTurnStreamOperations({
      sessionId: 'session-ops',
      bladeConfig: {
        models: [],
        currentModelId: 'default-model',
      },
      traceManager,
      hookRuntime: {
        enable: vi.fn(),
        setTraceCollector: vi.fn(),
      },
      kernelModelResolver,
      createAgentKernel,
    });

    const messages = [];
    for await (const message of operations.stream({
      input: 'hello operations',
      modelId: 'glm-5.2',
    })) {
      messages.push(message);
    }

    expect(traceManager.createRecorder).toHaveBeenCalledWith('hello operations');
    expect(kernelModelResolver.resolve).toHaveBeenCalledWith({
      bladeConfig: {
        models: [],
        currentModelId: 'default-model',
      },
      modelId: 'glm-5.2',
    });
    expect(createAgentKernel).toHaveBeenCalledWith(
      {
        input: 'hello operations',
        modelId: 'glm-5.2',
        traceRecorder,
      },
      {
        model,
        modelRequestDefaults: {
          maxContextTokens: 24,
        },
      },
    );
    expect(messages).toContainEqual({
      type: 'content',
      delta: 'hi',
      sessionId: 'session-ops',
    });
    expect(traceRecorder.finish).toHaveBeenCalledWith('success', {
      content: 'hi',
      usage: undefined,
    });
  });
});
