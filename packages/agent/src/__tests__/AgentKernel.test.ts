import type { ModelPort, ModelRequest, ModelResponse } from '@blade-ai/ai';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentKernel,
  type AgentPermissionPort,
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
});
