import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../../services/ChatServiceInterface.js';
import type { ToolResult } from '../../tools/types/index.js';
import type { AgentEvent } from '../AgentEvent.js';
import type { AgentLoopConfig } from '../AgentLoop.js';
import { agentLoop } from '../AgentLoop.js';
import type { LoopResult } from '../types.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function baseConfig(overrides: Partial<AgentLoopConfig> = {}): AgentLoopConfig {
  return {
    chatService: {
      chat: vi.fn(),
      streamChat: vi.fn(),
      getConfig: () => ({
        model: 'test-model',
        maxContextTokens: 128000,
      }),
    } as unknown as AgentLoopConfig['chatService'],
    executionPipeline: {
      getRegistry: () => ({
        get: (name: string) => ({ kind: 'execute', name }),
      }),
      execute: vi.fn(),
    } as unknown as AgentLoopConfig['executionPipeline'],
    tools: [{ name: 'ReadFile', description: 'read', parameters: {} }],
    messages: [{ role: 'user', content: 'Hi' }] as Message[],
    maxTurns: 5,
    isYoloMode: false,
    maxContextTokens: 128000,
    executionContext: {
      sessionId: 'session-1',
      userId: 'user-1',
    },
    ...overrides,
  };
}

async function collectEvents(
  gen: AsyncGenerator<AgentEvent, LoopResult>,
): Promise<{ events: AgentEvent[]; result: LoopResult }> {
  const events: AgentEvent[] = [];
  while (true) {
    const { value, done } = await gen.next();
    if (done) {
      return { events, result: value };
    }
    events.push(value);
  }
}

describe('agentLoop streaming integration', () => {
  it('uses StreamingToolExecutor when streamHandler and tools are present, yielding streaming tool events without double-calling onAfterToolExec', async () => {
    const toolGate = deferred<ToolResult>();
    const streamChat = vi.fn(async function* () {
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
    });
    const execute = vi.fn(async () => toolGate.promise);
    const streamResponse = vi.fn(async function* () {
      throw new Error('streamResponse should not be used when tools are present');
    });
    const onAfterToolExec = vi.fn();

    const loopPromise = collectEvents(
      agentLoop(
        baseConfig({
          chatService: {
            chat: vi.fn(),
            streamChat,
            getConfig: () => ({
              model: 'test-model',
              maxContextTokens: 128000,
            }),
          } as unknown as AgentLoopConfig['chatService'],
          streamHandler: {
            streamResponse,
          } as never,
          executionPipeline: {
            getRegistry: () => ({
              get: (name: string) => ({ kind: 'execute', name }),
            }),
            execute,
          } as unknown as AgentLoopConfig['executionPipeline'],
          onAfterToolExec,
        }),
      ),
    );

    toolGate.resolve({
      success: true,
      llmContent: 'exit now',
      displayContent: 'exit now',
      metadata: { shouldExitLoop: true },
    });

    const { events, result } = await loopPromise;

    expect(streamResponse).not.toHaveBeenCalled();
    expect(streamChat).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.finalMessage).toBe('exit now');
    expect(onAfterToolExec).toHaveBeenCalledTimes(1);

    const eventTypes = events.map((event) => event.type);
    expect(eventTypes.filter((type) => type === 'stream_end')).toHaveLength(1);
    expect(eventTypes).toContain('tool_start');
    expect(eventTypes).toContain('tool_result');

    const toolStartIndex = eventTypes.indexOf('tool_start');
    const streamEndIndex = eventTypes.indexOf('stream_end');
    const toolResultIndex = eventTypes.indexOf('tool_result');

    expect(toolStartIndex).toBeLessThan(streamEndIndex);
    expect(streamEndIndex).toBeLessThan(toolResultIndex);
  });

  it('keeps the non-streaming path unchanged when no streamHandler is provided', async () => {
    const chat = vi.fn()
      .mockResolvedValueOnce({
        content: 'need a tool',
        toolCalls: [
          {
            id: 'tool-1',
            type: 'function',
            function: {
              name: 'ReadFile',
              arguments: '{}',
            },
          },
        ],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      })
      .mockResolvedValueOnce({
        content: 'done',
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });
    const streamChat = vi.fn();
    const execute = vi.fn(async () => ({
      success: true,
      llmContent: 'tool output',
      displayContent: 'tool output',
    }));

    const { result } = await collectEvents(
      agentLoop(
        baseConfig({
          chatService: {
            chat,
            streamChat,
            getConfig: () => ({
              model: 'test-model',
              maxContextTokens: 128000,
            }),
          } as unknown as AgentLoopConfig['chatService'],
          executionPipeline: {
            getRegistry: () => ({
              get: (name: string) => ({ kind: 'execute', name }),
            }),
            execute,
          } as unknown as AgentLoopConfig['executionPipeline'],
        }),
      ),
    );

    expect(result.success).toBe(true);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(streamChat).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
