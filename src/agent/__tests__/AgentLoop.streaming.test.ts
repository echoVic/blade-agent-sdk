import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../../services/ChatServiceInterface.js';
import type { ToolResult } from '../../tools/types/index.js';
import type { AgentEvent } from '../AgentEvent.js';
import type { AgentLoopConfig } from '../AgentLoop.js';
import { agentLoop } from '../AgentLoop.js';
import { ConversationState } from '../state/ConversationState.js';
import type { TurnState } from '../state/TurnState.js';
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

type BaseConfigOverrides = Partial<Omit<AgentLoopConfig, 'prepareTurnState' | 'conversationState'>> & {
  prepareTurnState?: AgentLoopConfig['prepareTurnState'];
  turnState?: Partial<Omit<TurnState, 'turn' | 'messages'>>;
  messages?: Message[];
};

function baseConfig(overrides: BaseConfigOverrides = {}): AgentLoopConfig {
  const {
    prepareTurnState,
    turnState,
    messages = [{ role: 'user', content: 'Hi' }] as Message[],
    executionPipeline = {
      getRegistry: () => ({
        get: (name: string) => ({ kind: 'execute', name }),
      }),
      execute: vi.fn(),
    } as unknown as AgentLoopConfig['executionPipeline'],
    maxTurns = 5,
    isYoloMode = false,
    ...rest
  } = overrides;

  const convState = new ConversationState(null, [], messages[messages.length - 1] || { role: 'user', content: 'Hi' });
  if (messages.length > 1) {
    for (let i = 0; i < messages.length - 1; i++) {
      convState.append(messages[i]);
    }
  }

  const defaultTurnState: Omit<TurnState, 'turn' | 'messages'> = {
    tools: [{ name: 'ReadFile', description: 'read', parameters: {} }],
    chatService: {
      chat: vi.fn(),
      streamChat: vi.fn(),
      getConfig: () => ({
        model: 'test-model',
        maxContextTokens: 128000,
      }),
    } as unknown as TurnState['chatService'],
    maxContextTokens: 128000,
    permissionMode: undefined,
    executionContext: {
      sessionId: 'session-1',
      userId: 'user-1',
    },
  };

  return {
    executionPipeline,
    conversationState: convState,
    maxTurns,
    isYoloMode,
    prepareTurnState: prepareTurnState ?? ((turn) => ({
      turn,
      messages: convState.toArray() as Message[],
      ...defaultTurnState,
      ...turnState,
    })),
    ...rest,
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
    const execute = vi.fn(async (
      _toolName: string,
      _params: Record<string, unknown>,
      context?: {
        onProgress?: (message: string) => void;
        updateOutput?: (message: string) => void;
      },
    ) => {
      context?.onProgress?.('loading');
      context?.updateOutput?.('partial output');
      return toolGate.promise;
    });
    const streamResponse = vi.fn(async function* () {
      yield* [] as never[];
      throw new Error('streamResponse should not be used when tools are present');
    });
    const onAfterToolExec = vi.fn();

    const loopPromise = collectEvents(
      agentLoop(
        baseConfig({
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
          turnState: {
            chatService: {
              chat: vi.fn(),
              streamChat,
              getConfig: () => ({
                model: 'test-model',
                maxContextTokens: 128000,
              }),
            } as unknown as TurnState['chatService'],
          },
        }),
      ),
    );

    toolGate.resolve({
      success: true,
      llmContent: 'exit now',
      metadata: { shouldExitLoop: true },
      effects: [
        {
          type: 'runtimePatch',
          patch: {
            scope: 'turn',
            source: 'tool',
            systemPromptAppend: 'extra',
          },
        },
      ],
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
    expect(eventTypes).toContain('tool_progress');
    expect(eventTypes).toContain('tool_message');
    expect(eventTypes).toContain('tool_runtime_patch');
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
    }));

    const { result } = await collectEvents(
      agentLoop(
        baseConfig({
          executionPipeline: {
            getRegistry: () => ({
              get: (name: string) => ({ kind: 'execute', name }),
            }),
            execute,
          } as unknown as AgentLoopConfig['executionPipeline'],
          turnState: {
            chatService: {
              chat,
              streamChat,
              getConfig: () => ({
                model: 'test-model',
                maxContextTokens: 128000,
              }),
            } as unknown as TurnState['chatService'],
          },
        }),
      ),
    );

    expect(result.success).toBe(true);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(streamChat).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
