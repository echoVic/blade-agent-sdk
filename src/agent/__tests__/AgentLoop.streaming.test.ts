import { describe, expect, it, vi } from 'vitest';
import type { ModelMessage } from '../../model/message.js';
import type { ToolResult } from '../../tools/types/result.js';
import { completeToolExecution } from '../../tools/types/result.js';
import { SessionId } from '../../types/identifiers.js';
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

type BaseConfigOverrides = Partial<
  Omit<AgentLoopConfig, 'prepareTurnState' | 'conversationState' | 'hooks'>
> & {
  prepareTurnState?: AgentLoopConfig['prepareTurnState'];
  turnState?: Partial<Omit<TurnState, 'turn' | 'messages'>>;
  messages?: ModelMessage[];
  onBeforeToolExec?: NonNullable<NonNullable<AgentLoopConfig['hooks']>['tool']>['beforeExec'];
  onAfterToolExec?: NonNullable<NonNullable<AgentLoopConfig['hooks']>['tool']>['afterExec'];
  onAfterToolExecEpochDiscard?: NonNullable<
    NonNullable<AgentLoopConfig['hooks']>['tool']
  >['afterExecEpochDiscard'];
  onToolExecutionUpdate?: NonNullable<NonNullable<AgentLoopConfig['hooks']>['tool']>['onUpdate'];
  onAssistantMessage?: NonNullable<NonNullable<AgentLoopConfig['hooks']>['message']>['onAssistant'];
  onComplete?: NonNullable<NonNullable<AgentLoopConfig['hooks']>['message']>['onComplete'];
};

function baseConfig(overrides: BaseConfigOverrides = {}): AgentLoopConfig {
  const {
    prepareTurnState,
    turnState,
    messages = [{ role: 'user', content: 'Hi' }] as ModelMessage[],
    executionPipeline = {
      getRegistry: () => ({
        get: (name: string) => ({ kind: 'execute', name }),
      }),
      execute: vi.fn(),
    } as unknown as AgentLoopConfig['executionPipeline'],
    maxTurns = 5,
    isYoloMode = false,
    onBeforeToolExec,
    onAfterToolExec,
    onAfterToolExecEpochDiscard,
    onToolExecutionUpdate,
    onAssistantMessage,
    onComplete,
    ...rest
  } = overrides;

  const convState = new ConversationState(
    null,
    [],
    messages[messages.length - 1] || { role: 'user', content: 'Hi' },
  );
  if (messages.length > 1) {
    for (let i = 0; i < messages.length - 1; i++) {
      convState.append(messages[i]);
    }
  }

  const defaultTurnState: Omit<TurnState, 'turn' | 'messages'> = {
    tools: [{ name: 'ReadFile', description: 'read', parameters: {} }],
    modelService: {
      chat: vi.fn(),
      streamChat: vi.fn(),
      getConfig: () => ({
        model: 'test-model',
        maxContextTokens: 128000,
      }),
    } as unknown as TurnState['modelService'],
    maxContextTokens: 128000,
    permissionMode: undefined,
    executionContext: {
      sessionId: SessionId('session-1'),
      userId: 'user-1',
    },
  };

  const hooks: NonNullable<AgentLoopConfig['hooks']> = {
    tool: {
      beforeExec: onBeforeToolExec,
      afterExec: onAfterToolExec,
      afterExecEpochDiscard: onAfterToolExecEpochDiscard,
      onUpdate: onToolExecutionUpdate,
    },
    message: {
      onAssistant: onAssistantMessage,
      onComplete,
    },
  };

  return {
    executionPipeline,
    conversationState: convState,
    maxTurns,
    isYoloMode,
    prepareTurnState:
      prepareTurnState ??
      ((turn) => ({
        turn,
        messages: convState.toArray() as ModelMessage[],
        ...defaultTurnState,
        ...turnState,
      })),
    hooks,
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
  it('uses StreamingToolExecutor when streaming=true and tools are present, yielding streaming tool events without double-calling onAfterToolExec', async () => {
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
    const execute = vi.fn(async function* () {
      yield { kind: 'progress', message: 'loading' };
      yield {
        kind: 'message',
        content: { summary: 'partial output' },
      };
      yield {
        kind: 'effect',
        effect: {
          type: 'runtimePatch',
          patch: {
            scope: 'turn',
            source: 'tool',
            systemPromptAppend: 'extra',
          },
        },
      };
      return await toolGate.promise;
    });
    const streamResponse = vi.fn(async function* () {
      yield* [] as never[];
      throw new Error('streamResponse should not be used when tools are present');
    });
    void streamResponse;
    const hookOrder: string[] = [];
    const onAssistantMessage = vi.fn(async () => {
      hookOrder.push('assistant');
    });
    const onAfterToolExec = vi.fn(async () => {
      hookOrder.push('tool-result');
    });

    const loopPromise = collectEvents(
      agentLoop(
        baseConfig({
          streaming: true,
          executionPipeline: {
            getRegistry: () => ({
              get: (name: string) => ({ kind: 'execute', name }),
            }),
            execute,
          } as unknown as AgentLoopConfig['executionPipeline'],
          onAssistantMessage,
          onAfterToolExec,
          turnState: {
            modelService: {
              chat: vi.fn(),
              streamChat,
              getConfig: () => ({
                model: 'test-model',
                maxContextTokens: 128000,
              }),
            } as unknown as TurnState['modelService'],
          },
        }),
      ),
    );

    toolGate.resolve({
      status: 'success',
      model: 'exit now',
      metadata: { shouldExitLoop: true },
    });

    const { events, result } = await loopPromise;

    expect(streamChat).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.finalMessage).toBe('exit now');
    expect(onAfterToolExec).toHaveBeenCalledTimes(1);
    expect(hookOrder).toEqual(['assistant', 'tool-result']);

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

  it('keeps the non-streaming path unchanged when streaming=false', async () => {
    const chat = vi
      .fn()
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
    const execute = vi.fn(() =>
      completeToolExecution({
        status: 'success',
        model: 'tool output',
      }),
    );

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
            modelService: {
              chat,
              streamChat,
              getConfig: () => ({
                model: 'test-model',
                maxContextTokens: 128000,
              }),
            } as unknown as TurnState['modelService'],
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
