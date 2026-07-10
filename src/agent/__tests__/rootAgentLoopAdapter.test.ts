import { describe, expect, it, vi } from 'vitest';
import { ExecutionEpoch } from '@blade-ai/agent/epoch';
import type { InternalLogger } from '../../logging/Logger.js';
import type { ExecutionPipeline } from '../../tools/execution/ExecutionPipeline.js';
import { SessionId } from '../../types/branded.js';
import type { TurnState } from '../state/TurnState.js';
import type { RunTurnInput } from '../loop/adapterContracts.js';
import { createRootRunTurn } from '../loop/rootAgentLoopAdapter.js';

function executionPipeline(): ExecutionPipeline {
  const registry = { get: vi.fn() };
  return {
    execute: vi.fn(),
    getRegistry: vi.fn(() => registry),
  } as unknown as ExecutionPipeline;
}

function turnState(sessionId: string): TurnState {
  return {
    turn: 1,
    messages: [],
    tools: [{
      name: 'Read',
      description: 'Read a file',
      parameters: { type: 'object', properties: {} },
    }],
    chatService: {
      chat: vi.fn(),
      sideQuery: vi.fn(),
      streamChat: vi.fn(),
      getConfig: vi.fn(),
      updateConfig: vi.fn(),
    },
    maxContextTokens: 128000,
    executionContext: {
      sessionId: SessionId(sessionId),
      userId: `user-${sessionId}`,
    },
  };
}

async function collect<TEvent, TOutcome>(
  stream: AsyncGenerator<TEvent, TOutcome>,
): Promise<{ events: TEvent[]; outcome: TOutcome }> {
  const events: TEvent[] = [];
  while (true) {
    const next = await stream.next();
    if (next.done) return { events, outcome: next.value };
    events.push(next.value);
  }
}

describe('createRootRunTurn', () => {
  it('adapts input and forwards package-local events and outcome', async () => {
    type PackageLocalRunTurn = NonNullable<Parameters<typeof createRootRunTurn>[0]>;
    let received: unknown;
    const call = {
      id: 'tool-1',
      type: 'function' as const,
      function: { name: 'Read', arguments: '{}' },
    };
    const packageLocalRunTurn: PackageLocalRunTurn = async function* (input) {
      received = input;
      yield { type: 'content_delta', delta: 'hello' };
      yield {
        type: 'tool_result',
        toolCall: call,
        result: { success: true, llmContent: 'tool-result' },
      };
      return {
        chatResponse: { content: 'done' },
        streamingExecutionResults: [{
          toolCall: call,
          result: { success: true, llmContent: 'tool-result' },
          toolUseUuid: null,
        }],
      };
    };
    const rootPipeline = executionPipeline();
    const onUpdate = vi.fn();
    const hooks: RunTurnInput['toolHooks'] = { onUpdate };
    const logger = { warn: vi.fn(), error: vi.fn() } as unknown as InternalLogger;
    const input: RunTurnInput = {
      turnState: turnState('session-one'),
      messages: [{ role: 'user', content: 'hello' }],
      executionPipeline: rootPipeline,
      streaming: true,
      signal: new AbortController().signal,
      epoch: new ExecutionEpoch(),
      executionContext: {
        sessionId: SessionId('session-one'),
        userId: 'user-one',
      },
      permissionMode: 'autoEdit',
      toolHooks: hooks,
      logger,
    };

    const result = await collect(createRootRunTurn(packageLocalRunTurn)(input));
    const adaptedInput = received as {
      turnState: Pick<TurnState, 'chatService' | 'tools'>;
      toolHooks: RunTurnInput['toolHooks'];
      logger?: InternalLogger;
      executionPipeline: unknown;
      executionContext: unknown;
    };

    expect(result.events).toEqual([
      { type: 'content_delta', delta: 'hello' },
      {
        type: 'tool_result',
        toolCall: call,
        result: { success: true, llmContent: 'tool-result' },
      },
    ]);
    expect(result.outcome).toEqual({
      chatResponse: { content: 'done' },
      streamingExecutionResults: [{
        toolCall: call,
        result: { success: true, llmContent: 'tool-result' },
        toolUseUuid: null,
      }],
    });
    expect(adaptedInput.turnState).toEqual({
      chatService: input.turnState.chatService,
      tools: input.turnState.tools,
    });
    expect(adaptedInput.toolHooks).toBe(hooks);
    expect(adaptedInput.logger).toBe(logger);
    expect(adaptedInput.executionPipeline).toBe(rootPipeline);
    expect(adaptedInput.executionContext).toBe(input.executionContext);
    await adaptedInput.toolHooks.onUpdate?.({
      type: 'tool_progress',
      toolCall: call,
      message: 'working',
    });
    expect(onUpdate).toHaveBeenCalledWith({
      type: 'tool_progress',
      toolCall: call,
      message: 'working',
    });
  });

  it('keeps concurrent turn session inputs isolated', async () => {
    type PackageLocalRunTurn = NonNullable<Parameters<typeof createRootRunTurn>[0]>;
    const seen = new Map<string, string>();
    const packageLocalRunTurn: PackageLocalRunTurn = async function* (input) {
      await Promise.resolve();
      seen.set(input.messages[0]?.content as string, input.executionContext.sessionId);
      yield { type: 'stream_end' };
      return { chatResponse: { content: input.executionContext.sessionId } };
    };
    const runTurn = createRootRunTurn(packageLocalRunTurn);
    const makeInput = (sessionId: string): RunTurnInput => ({
      turnState: turnState(sessionId),
      messages: [{ role: 'user', content: sessionId }],
      executionPipeline: executionPipeline(),
      epoch: new ExecutionEpoch(),
      executionContext: {
        sessionId: SessionId(sessionId),
        userId: `user-${sessionId}`,
      },
      toolHooks: {},
    });

    const [first, second] = await Promise.all([
      collect(runTurn(makeInput('session-first'))),
      collect(runTurn(makeInput('session-second'))),
    ]);

    expect(first.outcome.chatResponse.content).toBe('session-first');
    expect(second.outcome.chatResponse.content).toBe('session-second');
    expect(Object.fromEntries(seen)).toEqual({
      'session-first': 'session-first',
      'session-second': 'session-second',
    });
  });
});
