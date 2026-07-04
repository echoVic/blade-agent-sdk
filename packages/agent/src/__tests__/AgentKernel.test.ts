import type { ModelPort, ModelRequest, ModelResponse } from '@blade-ai/ai';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentKernel,
  type AgentHookPort,
  type AgentPermissionPort,
  type AgentStoreAppendContext,
  type AgentStorePort,
  type AgentToolPort,
  type AgentTraceEvent,
  type AgentTracePort,
} from '../index.js';

describe('AgentKernel', () => {
  it('runs a no-tool turn through the model port and emits result events', async () => {
    const generate = vi.fn(async (_request: ModelRequest): Promise<ModelResponse> => ({
      content: 'Hello from Blade',
      usage: {
        promptTokens: 3,
        completionTokens: 4,
        totalTokens: 7,
      },
      finishReason: 'stop',
    }));
    const model: ModelPort = {
      generate,
      stream: async function* () {},
    };

    const kernel = new AgentKernel({ model });

    const events = [];
    for await (const event of kernel.runTurn({ input: 'Say hello' })) {
      events.push(event);
    }

    expect(generate).toHaveBeenCalledWith({
      messages: [{ role: 'user', content: 'Say hello' }],
      signal: undefined,
    });
    expect(events).toEqual([
      { type: 'content', delta: 'Hello from Blade' },
      {
        type: 'usage',
        usage: {
          promptTokens: 3,
          completionTokens: 4,
          totalTokens: 7,
        },
      },
      { type: 'result', content: 'Hello from Blade', finishReason: 'stop' },
    ]);
  });

  it('applies model request defaults to generated model requests', async () => {
    const generate = vi.fn(async (_request: ModelRequest): Promise<ModelResponse> => ({
      content: 'Configured answer',
      finishReason: 'stop',
    }));
    const model: ModelPort = {
      generate,
      stream: async function* () {},
    };
    const providerOptions = {
      openai: {
        reasoningEffort: 'low',
      },
    };
    const kernel = new AgentKernel({
      model,
      modelRequestDefaults: {
        model: 'gpt-5',
        maxOutputTokens: 4096,
        maxContextTokens: 32000,
        temperature: 0.2,
        providerOptions,
      },
    });

    for await (const _event of kernel.runTurn({ input: 'Use configured model' })) {
      // Drain the turn.
    }

    expect(generate).toHaveBeenCalledWith({
      model: 'gpt-5',
      maxOutputTokens: 4096,
      maxContextTokens: 32000,
      temperature: 0.2,
      providerOptions,
      messages: [{ role: 'user', content: 'Use configured model' }],
      signal: undefined,
    });
  });

  it('executes model tool calls and follows up with tool results', async () => {
    const generate = vi.fn(async (_request: ModelRequest): Promise<ModelResponse> => {
      if (generate.mock.calls.length === 1) {
        return {
          content: '',
          toolCalls: [
            {
              id: 'call_search',
              name: 'Search',
              input: { q: 'blade' },
            },
          ],
          finishReason: 'tool-calls',
        };
      }

      return {
        content: 'Found Blade docs',
        usage: {
          promptTokens: 8,
          completionTokens: 5,
          totalTokens: 13,
        },
        finishReason: 'stop',
      };
    });
    const model: ModelPort = {
      generate,
      stream: async function* () {},
    };
    const execute = vi.fn(async () => ({
      id: 'call_search',
      name: 'Search',
      output: 'Blade docs result',
    }));
    const tools: AgentToolPort = {
      list: async () => [],
      execute,
    };

    const kernel = new AgentKernel({ model, tools });

    const events = [];
    for await (const event of kernel.runTurn({ input: 'Find Blade docs' })) {
      events.push(event);
    }

    expect(execute).toHaveBeenCalledWith(
      { id: 'call_search', name: 'Search', input: { q: 'blade' } },
      undefined,
    );
    expect(generate).toHaveBeenNthCalledWith(2, {
      messages: [
        { role: 'user', content: 'Find Blade docs' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_search', name: 'Search', input: { q: 'blade' } }],
        },
        {
          role: 'tool',
          content: 'Blade docs result',
          name: 'Search',
          toolCallId: 'call_search',
        },
      ],
      signal: undefined,
    });
    expect(events).toEqual([
      { type: 'tool_use', toolCall: { id: 'call_search', name: 'Search', input: { q: 'blade' } } },
      { type: 'tool_result', result: { id: 'call_search', name: 'Search', output: 'Blade docs result' } },
      { type: 'content', delta: 'Found Blade docs' },
      {
        type: 'usage',
        usage: {
          promptTokens: 8,
          completionTokens: 5,
          totalTokens: 13,
        },
      },
      { type: 'result', content: 'Found Blade docs', finishReason: 'stop' },
    ]);
  });

  it('emits permission update effects from tool results before the tool result event', async () => {
    const generate = vi.fn(async (_request: ModelRequest): Promise<ModelResponse> => {
      if (generate.mock.calls.length === 1) {
        return {
          content: '',
          toolCalls: [
            {
              id: 'call_search',
              name: 'Search',
              input: { q: 'blade' },
            },
          ],
          finishReason: 'tool-calls',
        };
      }

      return {
        content: 'Permission updated',
        finishReason: 'stop',
      };
    });
    const model: ModelPort = {
      generate,
      stream: async function* () {},
    };
    const tools: AgentToolPort = {
      list: async () => [],
      execute: async () => ({
        id: 'call_search',
        name: 'Search',
        output: 'Blade docs result',
        effects: [
          {
            type: 'permissionUpdates',
            updates: [
              {
                type: 'addRules',
                behavior: 'allow',
                rules: [{ toolName: 'Search', ruleContent: 'q=blade' }],
              },
            ],
          },
        ],
      }),
    };

    const kernel = new AgentKernel({ model, tools });

    const events = [];
    for await (const event of kernel.runTurn({ input: 'Find Blade docs' })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'tool_use', toolCall: { id: 'call_search', name: 'Search', input: { q: 'blade' } } },
      {
        type: 'tool_permission_updates',
        toolCall: { id: 'call_search', name: 'Search', input: { q: 'blade' } },
        updates: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: 'Search', ruleContent: 'q=blade' }],
          },
        ],
      },
      {
        type: 'tool_result',
        result: {
          id: 'call_search',
          name: 'Search',
          output: 'Blade docs result',
          effects: [
            {
              type: 'permissionUpdates',
              updates: [
                {
                  type: 'addRules',
                  behavior: 'allow',
                  rules: [{ toolName: 'Search', ruleContent: 'q=blade' }],
                },
              ],
            },
          ],
        },
      },
      { type: 'content', delta: 'Permission updated' },
      { type: 'result', content: 'Permission updated', finishReason: 'stop' },
    ]);
  });

  it('checks permission before executing an allowed tool call', async () => {
    const generate = vi.fn(async (_request: ModelRequest): Promise<ModelResponse> => {
      if (generate.mock.calls.length === 1) {
        return {
          content: '',
          toolCalls: [{ id: 'call_search', name: 'Search', input: { q: 'blade' } }],
          finishReason: 'tool-calls',
        };
      }

      return { content: 'Allowed result', finishReason: 'stop' };
    });
    const model: ModelPort = {
      generate,
      stream: async function* () {},
    };
    const execute = vi.fn(async () => ({
      id: 'call_search',
      name: 'Search',
      output: 'Blade docs result',
    }));
    const tools: AgentToolPort = {
      list: async () => [],
      execute,
    };
    const checkToolCall = vi.fn(async () => ({ behavior: 'allow' as const }));
    const permissions: AgentPermissionPort = { checkToolCall };

    const kernel = new AgentKernel({ model, tools, permissions });

    const events = [];
    for await (const event of kernel.runTurn({ input: 'Find Blade docs' })) {
      events.push(event);
    }

    expect(checkToolCall).toHaveBeenCalledWith(
      { id: 'call_search', name: 'Search', input: { q: 'blade' } },
      { messages: [{ role: 'user', content: 'Find Blade docs' }] },
      undefined,
    );
    expect(execute).toHaveBeenCalledWith(
      { id: 'call_search', name: 'Search', input: { q: 'blade' } },
      undefined,
    );
    expect(events).toContainEqual({ type: 'content', delta: 'Allowed result' });
  });

  it('does not execute denied tool calls and feeds the denial back to the model', async () => {
    const generate = vi.fn(async (_request: ModelRequest): Promise<ModelResponse> => {
      if (generate.mock.calls.length === 1) {
        return {
          content: '',
          toolCalls: [{ id: 'call_search', name: 'Search', input: { q: 'blade' } }],
          finishReason: 'tool-calls',
        };
      }

      return { content: 'I cannot search because permission was denied.', finishReason: 'stop' };
    });
    const model: ModelPort = {
      generate,
      stream: async function* () {},
    };
    const execute = vi.fn(async () => ({
      id: 'call_search',
      name: 'Search',
      output: 'should not run',
    }));
    const tools: AgentToolPort = {
      list: async () => [],
      execute,
    };
    const permissions: AgentPermissionPort = {
      checkToolCall: async () => ({ behavior: 'deny', message: 'Search is disabled' }),
    };

    const kernel = new AgentKernel({ model, tools, permissions });

    const events = [];
    for await (const event of kernel.runTurn({ input: 'Find Blade docs' })) {
      events.push(event);
    }

    expect(execute).not.toHaveBeenCalled();
    expect(generate).toHaveBeenNthCalledWith(2, {
      messages: [
        { role: 'user', content: 'Find Blade docs' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_search', name: 'Search', input: { q: 'blade' } }],
        },
        {
          role: 'tool',
          content: 'Search is disabled',
          name: 'Search',
          toolCallId: 'call_search',
        },
      ],
      signal: undefined,
    });
    expect(events).toEqual([
      { type: 'tool_use', toolCall: { id: 'call_search', name: 'Search', input: { q: 'blade' } } },
      {
        type: 'tool_result',
        result: { id: 'call_search', name: 'Search', output: 'Search is disabled', isError: true },
      },
      { type: 'content', delta: 'I cannot search because permission was denied.' },
      { type: 'result', content: 'I cannot search because permission was denied.', finishReason: 'stop' },
    ]);
  });

  it('records trace events for model, tool, usage, and result activity', async () => {
    const generate = vi.fn(async (_request: ModelRequest): Promise<ModelResponse> => {
      if (generate.mock.calls.length === 1) {
        return {
          content: '',
          toolCalls: [{ id: 'call_search', name: 'Search', input: { q: 'blade' } }],
          finishReason: 'tool-calls',
        };
      }

      return {
        content: 'Found traced docs',
        usage: {
          promptTokens: 8,
          completionTokens: 6,
          totalTokens: 14,
        },
        finishReason: 'stop',
      };
    });
    const model: ModelPort = {
      generate,
      stream: async function* () {},
    };
    const tools: AgentToolPort = {
      list: async () => [],
      execute: async () => ({
        id: 'call_search',
        name: 'Search',
        output: 'Blade docs result',
      }),
    };
    const traceEvents: AgentTraceEvent[] = [];
    const trace: AgentTracePort = {
      record: (event) => {
        traceEvents.push(event);
      },
    };

    const kernel = new AgentKernel({ model, tools, trace });

    for await (const _event of kernel.runTurn({ input: 'Find Blade docs' })) {
      // Drain the turn.
    }

    expect(traceEvents).toEqual([
      { type: 'turn_start', input: 'Find Blade docs' },
      { type: 'model_request', messages: [{ role: 'user', content: 'Find Blade docs' }] },
      {
        type: 'model_response',
        finishReason: 'tool-calls',
        content: '',
        toolCalls: [{ id: 'call_search', name: 'Search', input: { q: 'blade' } }],
      },
      { type: 'tool_call_start', toolCall: { id: 'call_search', name: 'Search', input: { q: 'blade' } } },
      {
        type: 'tool_call_end',
        toolCall: { id: 'call_search', name: 'Search', input: { q: 'blade' } },
        result: { id: 'call_search', name: 'Search', output: 'Blade docs result' },
      },
      {
        type: 'model_request',
        messages: [
          { role: 'user', content: 'Find Blade docs' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_search', name: 'Search', input: { q: 'blade' } }],
          },
          {
            role: 'tool',
            content: 'Blade docs result',
            name: 'Search',
            toolCallId: 'call_search',
          },
        ],
      },
      {
        type: 'model_response',
        finishReason: 'stop',
        content: 'Found traced docs',
        usage: {
          promptTokens: 8,
          completionTokens: 6,
          totalTokens: 14,
        },
      },
      {
        type: 'usage',
        usage: {
          promptTokens: 8,
          completionTokens: 6,
          totalTokens: 14,
        },
      },
      { type: 'turn_end', content: 'Found traced docs', finishReason: 'stop' },
    ]);
  });

  it('emits a controlled error event without calling the model when the turn is already aborted', async () => {
    const generate = vi.fn(async (_request: ModelRequest): Promise<ModelResponse> => ({
      content: 'should not run',
      finishReason: 'stop',
    }));
    const model: ModelPort = {
      generate,
      stream: async function* () {},
    };
    const controller = new AbortController();
    controller.abort('user cancelled');
    const kernel = new AgentKernel({ model });

    const events = [];
    for await (const event of kernel.runTurn({
      input: 'Do not start',
      signal: controller.signal,
    })) {
      events.push(event);
    }

    expect(generate).not.toHaveBeenCalled();
    expect(events).toEqual([
      { type: 'error', code: 'ABORTED', message: 'Operation aborted' },
    ]);
  });

  it('continues tool-call iterations until the model returns a final response', async () => {
    const generate = vi.fn(async (_request: ModelRequest): Promise<ModelResponse> => {
      if (generate.mock.calls.length === 1) {
        return {
          content: '',
          toolCalls: [{ id: 'call_search', name: 'Search', input: { q: 'blade' } }],
          finishReason: 'tool-calls',
        };
      }
      if (generate.mock.calls.length === 2) {
        return {
          content: '',
          toolCalls: [{ id: 'call_read', name: 'Read', input: { path: 'docs.md' } }],
          finishReason: 'tool-calls',
        };
      }

      return {
        content: 'Found and read Blade docs',
        finishReason: 'stop',
      };
    });
    const model: ModelPort = {
      generate,
      stream: async function* () {},
    };
    const execute = vi.fn(async (toolCall) => ({
      id: toolCall.id,
      name: toolCall.name,
      output: `${toolCall.name} result`,
    }));
    const tools: AgentToolPort = {
      list: async () => [],
      execute,
    };

    const kernel = new AgentKernel({ model, tools });

    const events = [];
    for await (const event of kernel.runTurn({ input: 'Find then read Blade docs' })) {
      events.push(event);
    }

    expect(generate).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenNthCalledWith(
      1,
      { id: 'call_search', name: 'Search', input: { q: 'blade' } },
      undefined,
    );
    expect(execute).toHaveBeenNthCalledWith(
      2,
      { id: 'call_read', name: 'Read', input: { path: 'docs.md' } },
      undefined,
    );
    expect(events).toEqual([
      { type: 'tool_use', toolCall: { id: 'call_search', name: 'Search', input: { q: 'blade' } } },
      { type: 'tool_result', result: { id: 'call_search', name: 'Search', output: 'Search result' } },
      { type: 'tool_use', toolCall: { id: 'call_read', name: 'Read', input: { path: 'docs.md' } } },
      { type: 'tool_result', result: { id: 'call_read', name: 'Read', output: 'Read result' } },
      { type: 'content', delta: 'Found and read Blade docs' },
      { type: 'result', content: 'Found and read Blade docs', finishReason: 'stop' },
    ]);
  });

  it('stops tool-call iterations with a controlled error when maxSteps is exceeded', async () => {
    const generate = vi.fn(async (_request: ModelRequest): Promise<ModelResponse> => ({
      content: '',
      toolCalls: [{ id: `call_${generate.mock.calls.length}`, name: 'Search', input: {} }],
      finishReason: 'tool-calls',
    }));
    const model: ModelPort = {
      generate,
      stream: async function* () {},
    };
    const execute = vi.fn(async (toolCall) => ({
      id: toolCall.id,
      name: toolCall.name,
      output: 'looping',
    }));
    const tools: AgentToolPort = {
      list: async () => [],
      execute,
    };
    const kernel = new AgentKernel({ model, tools });

    const events = [];
    for await (const event of kernel.runTurn({ input: 'Loop forever', maxSteps: 2 })) {
      events.push(event);
    }

    expect(generate).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      { type: 'tool_use', toolCall: { id: 'call_1', name: 'Search', input: {} } },
      { type: 'tool_result', result: { id: 'call_1', name: 'Search', output: 'looping' } },
      {
        type: 'error',
        code: 'MAX_STEPS_EXCEEDED',
        message: 'Agent turn exceeded maxSteps',
      },
    ]);
  });

  it('appends user and final assistant messages through the store port for a no-tool turn', async () => {
    const generate = vi.fn(async (_request: ModelRequest): Promise<ModelResponse> => ({
      content: 'Stored answer',
      reasoningContent: 'Short thought',
      finishReason: 'stop',
    }));
    const model: ModelPort = {
      generate,
      stream: async function* () {},
    };
    const appended: Array<{ message: Parameters<AgentStorePort['appendMessage']>[0]; context: AgentStoreAppendContext }> = [];
    const store: AgentStorePort = {
      appendMessage: async (message, context) => {
        appended.push({ message, context });
      },
    };

    const kernel = new AgentKernel({ model, store });

    for await (const _event of kernel.runTurn({ input: 'Persist this', turnId: 'turn_1' })) {
      // Drain the turn.
    }

    expect(appended).toEqual([
      {
        message: { role: 'user', content: 'Persist this' },
        context: { turnId: 'turn_1', source: 'input', step: 0 },
      },
      {
        message: { role: 'assistant', content: 'Stored answer', reasoningContent: 'Short thought' },
        context: { turnId: 'turn_1', source: 'model', step: 1 },
      },
    ]);
  });

  it('appends assistant tool-call and tool-result messages through the store port', async () => {
    const generate = vi.fn(async (_request: ModelRequest): Promise<ModelResponse> => {
      if (generate.mock.calls.length === 1) {
        return {
          content: '',
          toolCalls: [{ id: 'call_search', name: 'Search', input: { q: 'blade' } }],
          finishReason: 'tool-calls',
        };
      }

      return {
        content: 'Stored tool answer',
        finishReason: 'stop',
      };
    });
    const model: ModelPort = {
      generate,
      stream: async function* () {},
    };
    const tools: AgentToolPort = {
      list: async () => [],
      execute: async () => ({
        id: 'call_search',
        name: 'Search',
        output: 'Stored tool result',
      }),
    };
    const appended: Array<{ message: Parameters<AgentStorePort['appendMessage']>[0]; context: AgentStoreAppendContext }> = [];
    const store: AgentStorePort = {
      appendMessage: (message, context) => {
        appended.push({ message, context });
      },
    };
    const kernel = new AgentKernel({ model, tools, store });

    for await (const _event of kernel.runTurn({ input: 'Persist tool turn', turnId: 'turn_tool' })) {
      // Drain the turn.
    }

    expect(appended).toEqual([
      {
        message: { role: 'user', content: 'Persist tool turn' },
        context: { turnId: 'turn_tool', source: 'input', step: 0 },
      },
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_search', name: 'Search', input: { q: 'blade' } }],
        },
        context: { turnId: 'turn_tool', source: 'model', step: 1 },
      },
      {
        message: {
          role: 'tool',
          content: 'Stored tool result',
          name: 'Search',
          toolCallId: 'call_search',
        },
        context: { turnId: 'turn_tool', source: 'tool', step: 1 },
      },
      {
        message: { role: 'assistant', content: 'Stored tool answer' },
        context: { turnId: 'turn_tool', source: 'model', step: 2 },
      },
    ]);
  });

  it('runs model lifecycle hooks that can rewrite requests and observe responses', async () => {
    const generate = vi.fn(async (_request: ModelRequest): Promise<ModelResponse> => ({
      content: 'Hooked answer',
      finishReason: 'stop',
    }));
    const model: ModelPort = {
      generate,
      stream: async function* () {},
    };
    const afterModelResponses: Parameters<NonNullable<AgentHookPort['afterModel']>>[0][] = [];
    const hooks: AgentHookPort = {
      beforeModel: async (request, context) => {
        expect(context).toEqual({
          turnId: 'turn_hook',
          step: 1,
          messages: [{ role: 'user', content: 'Original prompt' }],
        });
        return {
          ...request,
          messages: [{ role: 'user', content: 'Rewritten prompt' }],
        };
      },
      afterModel: (response, context) => {
        expect(context).toEqual({
          turnId: 'turn_hook',
          step: 1,
          messages: [{ role: 'user', content: 'Rewritten prompt' }],
        });
        afterModelResponses.push(response);
      },
    };
    const kernel = new AgentKernel({ model, hooks });

    const events = [];
    for await (const event of kernel.runTurn({ input: 'Original prompt', turnId: 'turn_hook' })) {
      events.push(event);
    }

    expect(generate).toHaveBeenCalledWith({
      messages: [{ role: 'user', content: 'Rewritten prompt' }],
      signal: undefined,
    });
    expect(afterModelResponses).toEqual([
      { content: 'Hooked answer', finishReason: 'stop' },
    ]);
    expect(events).toContainEqual({ type: 'content', delta: 'Hooked answer' });
  });
});
