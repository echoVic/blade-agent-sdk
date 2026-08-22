import { describe, expect, it, type Mock, vi } from 'vitest';
import type { Message } from '../../services/ChatServiceInterface.js';
import { CannotRetryError } from '../../services/RetryPolicy.js';
import { ActiveRequestController } from '../../session/ActiveRequestController.js';
import { SessionInputInbox } from '../../session/SessionInputInbox.js';
import {
  completeToolExecution,
  type ToolEffect,
  type ToolResult,
} from '../../tools/types/index.js';
import {
  InputId,
  RequestId,
  SessionId,
} from '../../types/branded.js';
import type { AgentEvent } from '../AgentEvent.js';
import type { AgentLoopConfig } from '../AgentLoop.js';
import { agentLoop } from '../AgentLoop.js';
import { ConversationState } from '../state/ConversationState.js';
import type { TurnState } from '../state/TurnState.js';
import type { LoopResult } from '../types.js';

// ===== Mock Factories =====

type MockToolResult = ToolResult & { testEffects?: ToolEffect[] };

function createMockExecutionPipeline(results?: Record<string, MockToolResult>) {
  return {
    getRegistry: () => ({
      get: (name: string) => ({ kind: 'execute', name }),
    }),
    execute: vi.fn(async function* (toolName: string) {
      const configured = results?.[toolName];
      if (configured) {
        for (const effect of configured.testEffects ?? []) {
          yield { kind: 'effect' as const, effect };
        }
        const { testEffects: _, ...result } = configured;
        return result;
      }
      return {
        status: 'success',
        model: `Result of ${toolName}`,
      } as ToolResult;
    }),
  } as unknown as AgentLoopConfig['executionPipeline'];
}

function createMockChatService(responses: Array<{
  content: string;
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  reasoningContent?: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}>) {
  let callIndex = 0;
  const chatFn = vi.fn(async () => {
    const resp = responses[callIndex] || responses[responses.length - 1];
    callIndex++;
    return {
      content: resp.content,
      toolCalls: resp.toolCalls || [],
      reasoningContent: resp.reasoningContent,
      usage: resp.usage || { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    };
  });
  return {
    chat: chatFn,
    chatWithRetryEvents: vi.fn(async function* (...args: Parameters<typeof chatFn>) {
      yield* [] as never[];
      return await chatFn(...args);
    }),
    getConfig: () => ({
      model: 'test-model',
      maxContextTokens: 128000,
    }),
  } as unknown as TurnState['chatService'];
}

type BaseConfigOverrides = Partial<Omit<AgentLoopConfig, 'prepareTurnState' | 'conversationState' | 'hooks'>> & {
  prepareTurnState?: AgentLoopConfig['prepareTurnState'];
  turnState?: Partial<Omit<TurnState, 'turn' | 'messages'>>;
  messages?: Message[];
  // Legacy flat hooks (translated to grouped shape below)
  onBeforeTurn?: NonNullable<NonNullable<AgentLoopConfig['hooks']>['turn']>['beforeTurn'];
  onInputApply?: NonNullable<NonNullable<AgentLoopConfig['hooks']>['input']>['apply'];
  onTurnLimitReached?: NonNullable<NonNullable<AgentLoopConfig['hooks']>['turn']>['onTurnLimitReached'];
  onTurnLimitCompact?: NonNullable<NonNullable<AgentLoopConfig['hooks']>['turn']>['onTurnLimitCompact'];
  onBeforeToolExec?: NonNullable<NonNullable<AgentLoopConfig['hooks']>['tool']>['beforeExec'];
  onAfterToolExec?: NonNullable<NonNullable<AgentLoopConfig['hooks']>['tool']>['afterExec'];
  onAfterToolExecEpochDiscard?: NonNullable<NonNullable<AgentLoopConfig['hooks']>['tool']>['afterExecEpochDiscard'];
  onToolExecutionUpdate?: NonNullable<NonNullable<AgentLoopConfig['hooks']>['tool']>['onUpdate'];
  onAssistantMessage?: NonNullable<NonNullable<AgentLoopConfig['hooks']>['message']>['onAssistant'];
  onComplete?: NonNullable<NonNullable<AgentLoopConfig['hooks']>['message']>['onComplete'];
  onReactiveCompact?: NonNullable<NonNullable<AgentLoopConfig['hooks']>['recovery']>['reactiveCompact'];
  onRecoveryStateChange?: NonNullable<NonNullable<AgentLoopConfig['hooks']>['recovery']>['onStateChange'];
  onStopCheck?: NonNullable<NonNullable<AgentLoopConfig['hooks']>['stop']>['check'];
};

function baseConfig(overrides: BaseConfigOverrides = {}): AgentLoopConfig {
  const {
    prepareTurnState,
    turnState,
    messages = [{ role: 'user', content: 'Hi' }],
    executionPipeline = createMockExecutionPipeline(),
    maxTurns = 10,
    isYoloMode = false,
    onBeforeTurn,
    onInputApply,
    onTurnLimitReached,
    onTurnLimitCompact,
    onBeforeToolExec,
    onAfterToolExec,
    onAfterToolExecEpochDiscard,
    onToolExecutionUpdate,
    onAssistantMessage,
    onComplete,
    onReactiveCompact,
    onRecoveryStateChange,
    onStopCheck,
    ...rest
  } = overrides;

  const convState = new ConversationState(null, [], messages[messages.length - 1] || { role: 'user', content: 'Hi' });
  // Add all messages except the last (user message) as context
  if (messages.length > 1) {
    for (let i = 0; i < messages.length - 1; i++) {
      convState.append(messages[i]);
    }
  }

  const defaultTurnState: Omit<TurnState, 'turn' | 'messages'> = {
    tools: [],
    chatService: createMockChatService([{ content: 'Hello!' }]),
    maxContextTokens: 128000,
    permissionMode: undefined,
    executionContext: {
      sessionId: SessionId('test-session'),
      userId: 'test-user',
    },
  };

  const hooks: NonNullable<AgentLoopConfig['hooks']> = {
    input: {
      apply: onInputApply,
    },
    turn: {
      beforeTurn: onBeforeTurn,
      onTurnLimitReached,
      onTurnLimitCompact,
    },
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
    recovery: {
      reactiveCompact: onReactiveCompact,
      onStateChange: onRecoveryStateChange,
    },
    stop: {
      check: onStopCheck,
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
    hooks,
    ...rest,
  };
}

async function collectEvents(
  gen: AsyncGenerator<AgentEvent, LoopResult>
): Promise<{ events: AgentEvent[]; result: LoopResult }> {
  const events: AgentEvent[] = [];
  while (true) {
    const { value, done } = await gen.next();
    if (done) return { events, result: value };
    events.push(value);
  }
}

// ===== Tests =====

describe('agentLoop', () => {
  describe('basic flow', () => {
    it('should complete with no tool calls', async () => {
      const config = baseConfig();
      const { events, result } = await collectEvents(agentLoop(config));

      expect(result.success).toBe(true);
      expect(result.finalMessage).toBe('Hello!');
      expect(result.metadata?.turnsCount).toBe(1);
      expect(result.metadata?.toolCallsCount).toBe(0);

      const types = events.map((e) => e.type);
      expect(types).toContain('agent_start');
      expect(types).toContain('turn_start');
      expect(types).toContain('turn_end');
      expect(types).toContain('agent_end');
      expect(types).toContain('token_usage');
    });

    it('should emit stream_end when content is present', async () => {
      const config = baseConfig();
      const { events } = await collectEvents(agentLoop(config));

      expect(events.some((e) => e.type === 'stream_end')).toBe(true);
    });

    it('should include token usage info', async () => {
      const chatService = createMockChatService([{
        content: 'Done',
        usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
      }]);
      const config = baseConfig({ turnState: { chatService } });
      const { events } = await collectEvents(agentLoop(config));

      const usageEvent = events.find((e) => e.type === 'token_usage');
      expect(usageEvent).toBeDefined();
      if (usageEvent?.type === 'token_usage') {
        expect(usageEvent.usage.inputTokens).toBe(200);
        expect(usageEvent.usage.outputTokens).toBe(100);
      }
    });
  });

  describe('tool execution', () => {
    it('should execute tools and continue loop', async () => {
      const chatService = createMockChatService([
        {
          content: 'Let me read the file',
          toolCalls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'ReadFile', arguments: '{"path":"test.ts"}' },
          }],
        },
        { content: 'Here is the file content.' },
      ]);
      const config = baseConfig({ turnState: { chatService } });
      const { events, result } = await collectEvents(agentLoop(config));

      expect(result.success).toBe(true);
      expect(result.metadata?.turnsCount).toBe(2);
      expect(result.metadata?.toolCallsCount).toBe(1);

      const types = events.map((e) => e.type);
      expect(types).toContain('tool_start');
      expect(types).toContain('tool_result');
    });

    it('should handle multiple tool calls in one turn', async () => {
      const chatService = createMockChatService([
        {
          content: 'Reading two files',
          toolCalls: [
            { id: 'call_1', type: 'function', function: { name: 'ReadFile', arguments: '{"path":"a.ts"}' } },
            { id: 'call_2', type: 'function', function: { name: 'ReadFile', arguments: '{"path":"b.ts"}' } },
          ],
        },
        { content: 'Both files read.' },
      ]);
      const config = baseConfig({ turnState: { chatService } });
      const { events, result } = await collectEvents(agentLoop(config));

      expect(result.success).toBe(true);
      expect(result.metadata?.toolCallsCount).toBe(2);

      const toolStarts = events.filter((e) => e.type === 'tool_start');
      expect(toolStarts.length).toBe(2);
    });

    it('should execute multiple tool calls in parallel', async () => {
      let executeCount = 0;
      let releaseFirstExecution!: () => void;
      const firstExecutionGate = new Promise<void>((resolve) => {
        releaseFirstExecution = resolve;
      });

      const pipeline = {
        getRegistry: () => ({
          get: (_name: string) => ({ kind: 'readonly', name: _name }),
        }),
        execute: vi.fn(async function* (toolName: string) {
        executeCount++;
        yield { kind: 'progress', data: { toolName } };
        if (toolName === 'ReadA') {
          await firstExecutionGate;
        }
        return {
          status: 'success',
          model: `Result of ${toolName}`,
        } as ToolResult;
      }),
      } as unknown as AgentLoopConfig['executionPipeline'];

      const chatService = createMockChatService([
        {
          content: 'Reading two files',
          toolCalls: [
            { id: 'call_1', type: 'function', function: { name: 'ReadA', arguments: '{}' } },
            { id: 'call_2', type: 'function', function: { name: 'ReadB', arguments: '{}' } },
          ],
        },
        { content: 'Both files read.' },
      ]);

      const loopPromise = collectEvents(agentLoop(baseConfig({
        executionPipeline: pipeline,
        turnState: { chatService },
      })));

      // Allow enough microtask ticks for the async generator + tool execution to start
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(executeCount).toBe(2);
      releaseFirstExecution();

      const { result } = await loopPromise;
      expect(result.success).toBe(true);
    });

    it('should handle tool execution failure gracefully', async () => {
      const pipeline = createMockExecutionPipeline();
      (pipeline.execute as Mock).mockImplementation(
        // biome-ignore lint/correctness/useYield: exercises a terminal execution failure
        async function* () {
          throw new Error('Permission denied');
        },
      );

      const chatService = createMockChatService([
        {
          content: 'Writing file',
          toolCalls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'WriteFile', arguments: '{"path":"x.ts","content":""}' },
          }],
        },
        { content: 'Failed to write.' },
      ]);
      const config = baseConfig({ executionPipeline: pipeline, turnState: { chatService } });
      const { result } = await collectEvents(agentLoop(config));

      // Loop should continue after tool failure and eventually complete
      expect(result.success).toBe(true);
      expect(result.metadata?.toolCallsCount).toBe(1);
    });

    it('should exit loop when tool sets shouldExitLoop', async () => {
      const pipeline = createMockExecutionPipeline({
        ExitTool: {
          status: 'success',
          model: 'Exiting',
          metadata: { shouldExitLoop: true },
        },
      });

      const chatService = createMockChatService([{
        content: 'Exiting now',
        toolCalls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'ExitTool', arguments: '{}' },
        }],
      }]);
      const config = baseConfig({ executionPipeline: pipeline, turnState: { chatService } });
      const { result } = await collectEvents(agentLoop(config));

      expect(result.success).toBe(true);
      expect(result.metadata?.shouldExitLoop).toBe(true);
    });
  });

  describe('abort handling', () => {
    it('should abort when signal is triggered', async () => {
      const controller = new AbortController();
      // Abort immediately
      controller.abort();

      const config = baseConfig({ signal: controller.signal });
      const { result } = await collectEvents(agentLoop(config));

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('aborted');
    });

    it('should abort mid-loop when signal fires', async () => {
      const controller = new AbortController();
      const chatService = createMockChatService([
        {
          content: 'Working...',
          toolCalls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'SlowTool', arguments: '{}' },
          }],
        },
        { content: 'Done' },
      ]);

      const pipeline = createMockExecutionPipeline();
      (pipeline.execute as Mock).mockImplementation(() => {
        // Abort during tool execution
        controller.abort();
        return completeToolExecution({ status: 'success', model: 'ok' });
      });

      const config = baseConfig({
        executionPipeline: pipeline,
        signal: controller.signal,
        turnState: { chatService },
      });
      const { result } = await collectEvents(agentLoop(config));

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('aborted');
    });
  });

  describe('recoverable overflow recovery', () => {
    it('retries the turn after a context length error and reactive compaction succeeds', async () => {
      const contextError = new Error('maximum context length exceeded');
      const chatFn = vi.fn()
        .mockRejectedValueOnce(contextError)
        .mockResolvedValueOnce({
          content: 'Recovered answer',
          toolCalls: [],
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        });
      const onReactiveCompact = vi.fn(async function* () {
        yield* [] as never[];
        return true;
      });

      const chatService = {
        chat: chatFn,
        chatWithRetryEvents: vi.fn(async function* (...args: Parameters<typeof chatFn>) {
          yield* [] as never[];
          return await chatFn(...args);
        }),
        getConfig: () => ({ model: 'test-model', maxContextTokens: 128000 }),
      } as unknown as TurnState['chatService'];

      const { events, result } = await collectEvents(agentLoop(baseConfig({
        onReactiveCompact,
        turnState: { chatService },
      })));

      expect(result.success).toBe(true);
      expect(result.finalMessage).toBe('Recovered answer');
      expect(chatFn).toHaveBeenCalledTimes(2);
      expect(onReactiveCompact).toHaveBeenCalledTimes(1);
      // turn_retry replaces the old "fake turn_end" — turnsCount stays 1, only one real turn_end
      const turnStartEvents = events.filter((e) => e.type === 'turn_start');
      expect(turnStartEvents).toHaveLength(1);
      const turnEndEvents = events.filter((e) => e.type === 'turn_end');
      expect(turnEndEvents).toHaveLength(1);
      expect(events.some((e) => e.type === 'turn_retry' && e.turn === 1 && e.reason === 'reactive_compact')).toBe(true);
    });

    it('retries the turn after a CannotRetryError wrapping overflow and reactive compaction succeeds', async () => {
      const overflowError = new Error(
        'input length and `max_tokens` exceed context limit: 199000 + 20000 > 200000',
      );
      const wrappedError = new CannotRetryError(overflowError, { maxTokensOverride: 3000 });
      const chatFn = vi.fn()
        .mockRejectedValueOnce(wrappedError)
        .mockResolvedValueOnce({
          content: 'Recovered from wrapped overflow',
          toolCalls: [],
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        });
      const onReactiveCompact = vi.fn(async function* () {
        yield* [] as never[];
        return true;
      });

      const chatService = {
        chat: chatFn,
        chatWithRetryEvents: vi.fn(async function* (...args: Parameters<typeof chatFn>) {
          yield* [] as never[];
          return await chatFn(...args);
        }),
        getConfig: () => ({ model: 'test-model', maxContextTokens: 128000 }),
      } as unknown as TurnState['chatService'];

      const { result } = await collectEvents(agentLoop(baseConfig({
        onReactiveCompact,
        turnState: { chatService },
      })));

      expect(result.success).toBe(true);
      expect(result.finalMessage).toBe('Recovered from wrapped overflow');
      expect(chatFn).toHaveBeenCalledTimes(2);
      expect(onReactiveCompact).toHaveBeenCalledTimes(1);
    });

    it('surfaces the error after a second overflow on the same turn', async () => {
      const overflowError = new Error('maximum context length exceeded');
      const chatFn = vi.fn()
        .mockRejectedValueOnce(overflowError)
        .mockRejectedValueOnce(overflowError)
        .mockResolvedValueOnce({
          content: 'Should not reach a third attempt',
          toolCalls: [],
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        });
      const onReactiveCompact = vi.fn(async function* () {
        yield* [] as never[];
        return true;
      });

      const chatService = {
        chat: chatFn,
        chatWithRetryEvents: vi.fn(async function* (...args: Parameters<typeof chatFn>) {
          yield* [] as never[];
          return await chatFn(...args);
        }),
        getConfig: () => ({ model: 'test-model', maxContextTokens: 128000 }),
      } as unknown as TurnState['chatService'];

      await expect(collectEvents(agentLoop(baseConfig({
        onReactiveCompact,
        turnState: { chatService },
      })))).rejects.toThrow('maximum context length exceeded');
      expect(chatFn).toHaveBeenCalledTimes(2);
      expect(onReactiveCompact).toHaveBeenCalledTimes(1);
    });

    it('does not trigger reactive compaction for unrelated errors', async () => {
      const chatFn = vi.fn().mockRejectedValue(new Error('Permission denied'));
      const onReactiveCompact = vi.fn(async function* () {
        yield* [] as never[];
        return true;
      });

      const chatService = {
        chat: chatFn,
        chatWithRetryEvents: vi.fn(async function* (...args: Parameters<typeof chatFn>) {
          yield* [] as never[];
          return await chatFn(...args);
        }),
        getConfig: () => ({ model: 'test-model', maxContextTokens: 128000 }),
      } as unknown as TurnState['chatService'];

      await expect(collectEvents(agentLoop(baseConfig({
        onReactiveCompact,
        turnState: { chatService },
      })))).rejects.toThrow('Permission denied');
      expect(onReactiveCompact).not.toHaveBeenCalled();
    });

    it('reports recovery state transitions while withholding and retrying a turn', async () => {
      const overflowError = new Error('maximum context length exceeded');
      const chatFn = vi.fn()
        .mockRejectedValueOnce(overflowError)
        .mockResolvedValueOnce({
          content: 'Recovered answer',
          toolCalls: [],
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        });
      const onReactiveCompact = vi.fn(async function* () {
        yield* [] as never[];
        return true;
      });
      const onRecoveryStateChange = vi.fn();

      const chatService = {
        chat: chatFn,
        chatWithRetryEvents: vi.fn(async function* (...args: Parameters<typeof chatFn>) {
          yield* [] as never[];
          return await chatFn(...args);
        }),
        getConfig: () => ({ model: 'test-model', maxContextTokens: 128000 }),
      } as unknown as TurnState['chatService'];

      const { result } = await collectEvents(agentLoop(baseConfig({
        onReactiveCompact,
        onRecoveryStateChange,
        turnState: { chatService },
      })));

      expect(result.success).toBe(true);
      expect(onRecoveryStateChange).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          turn: 1,
          phase: 'started',
          reason: 'context_overflow',
          attempt: 1,
        }),
      );
      expect(onRecoveryStateChange).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          turn: 1,
          phase: 'retrying',
          reason: 'reactive_compact_retry',
          attempt: 1,
        }),
      );
      expect(onRecoveryStateChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          turn: 1,
          phase: 'reset',
          attempt: 0,
        }),
      );
    });

    it('reports recovery exhaustion when the retry still overflows', async () => {
      const overflowError = new Error('maximum context length exceeded');
      const chatFn = vi.fn()
        .mockRejectedValueOnce(overflowError)
        .mockRejectedValueOnce(overflowError);
      const onReactiveCompact = vi.fn(async function* () {
        yield* [] as never[];
        return true;
      });
      const onRecoveryStateChange = vi.fn();

      const chatService = {
        chat: chatFn,
        chatWithRetryEvents: vi.fn(async function* (...args: Parameters<typeof chatFn>) {
          yield* [] as never[];
          return await chatFn(...args);
        }),
        getConfig: () => ({ model: 'test-model', maxContextTokens: 128000 }),
      } as unknown as TurnState['chatService'];

      await expect(collectEvents(agentLoop(baseConfig({
        onReactiveCompact,
        onRecoveryStateChange,
        turnState: { chatService },
      })))).rejects.toThrow('maximum context length exceeded');

      expect(onRecoveryStateChange).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          turn: 1,
          phase: 'started',
          reason: 'context_overflow',
          attempt: 1,
        }),
      );
      expect(onRecoveryStateChange).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          turn: 1,
          phase: 'retrying',
          reason: 'reactive_compact_retry',
          attempt: 1,
        }),
      );
      expect(onRecoveryStateChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          turn: 1,
          phase: 'failed',
          reason: 'recovery_exhausted',
          attempt: 1,
        }),
      );
    });
  });

  describe('turn limits', () => {
    it('should stop at maxTurns when no handler', async () => {
      // Create a chat service that always returns tool calls
      let callCount = 0;
      const chatService = {
        chat: vi.fn(async () => {
          callCount++;
          return {
            content: `Turn ${callCount}`,
            toolCalls: [{
              id: `call_${callCount}`,
              type: 'function' as const,
              function: { name: 'ReadFile', arguments: '{}' },
            }],
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          };
        }),
        getConfig: () => ({ model: 'test', maxContextTokens: 128000 }),
      } as unknown as TurnState['chatService'];

      const config = baseConfig({ maxTurns: 3, turnState: { chatService } });
      const { result } = await collectEvents(agentLoop(config));

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('max_turns_exceeded');
    });

    it('should continue when onTurnLimitReached returns continue', async () => {
      let callCount = 0;
      const chatService = {
        chat: vi.fn(async () => {
          callCount++;
          if (callCount <= 2) {
            return {
              content: `Turn ${callCount}`,
              toolCalls: [{
                id: `call_${callCount}`,
                type: 'function' as const,
                function: { name: 'ReadFile', arguments: '{}' },
              }],
              usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
            };
          }
          return { content: 'Final answer', toolCalls: [], usage: { totalTokens: 150 } };
        }),
        getConfig: () => ({ model: 'test', maxContextTokens: 128000 }),
      } as unknown as TurnState['chatService'];

      const config = baseConfig({
        maxTurns: 2,
        onTurnLimitReached: async () => ({ continue: true }),
        onTurnLimitCompact: async () => ({
          success: true,
          compactedMessages: [{ role: 'user' as const, content: 'Continue' }],
        }),
        turnState: { chatService },
      });
      const { result } = await collectEvents(agentLoop(config));

      expect(result.success).toBe(true);
      expect(result.finalMessage).toBe('Final answer');
    });
  });

  describe('hooks', () => {
    it('should call onAssistantMessage hook', async () => {
      const onAssistantMessage = vi.fn(async () => {});
      const chatService = createMockChatService([
        {
          content: 'Using tool',
          toolCalls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'ReadFile', arguments: '{}' },
          }],
        },
        { content: 'Done' },
      ]);

      const config = baseConfig({ onAssistantMessage, turnState: { chatService } });
      await collectEvents(agentLoop(config));

      expect(onAssistantMessage).toHaveBeenCalled();
      const firstCall = (onAssistantMessage.mock.calls as unknown as [{ content: string; turn: number }][])[0][0];
      expect(firstCall.content).toBe('Using tool');
      expect(firstCall.turn).toBe(1);
    });

    it('should call onBeforeToolExec and onAfterToolExec hooks', async () => {
      const onBeforeToolExec = vi.fn(async () => 'uuid-123');
      const onAfterToolExec = vi.fn(async () => {});

      const chatService = createMockChatService([
        {
          content: 'Reading',
          toolCalls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'ReadFile', arguments: '{"path":"test.ts"}' },
          }],
        },
        { content: 'Done' },
      ]);

      const config = baseConfig({ onBeforeToolExec, onAfterToolExec, turnState: { chatService } });
      await collectEvents(agentLoop(config));

      expect(onBeforeToolExec).toHaveBeenCalledTimes(1);
      expect(onAfterToolExec).toHaveBeenCalledTimes(1);

      const afterCtx = (onAfterToolExec.mock.calls as unknown as [{
        toolCall: { function: { name: string } };
        toolUseUuid: string | null;
      }][])[0][0];
      expect(afterCtx.toolCall.function.name).toBe('ReadFile');
      expect(afterCtx.toolUseUuid).toBe('uuid-123');
    });

    it('should call onComplete hook on normal finish', async () => {
      const onComplete = vi.fn(async () => {});
      const config = baseConfig({ onComplete });
      await collectEvents(agentLoop(config));

      expect(onComplete).toHaveBeenCalledTimes(1);
      const ctx = (onComplete.mock.calls as unknown as [{ content: string; turn: number }][])[0][0];
      expect(ctx.content).toBe('Hello!');
      expect(ctx.turn).toBe(1);
    });

    it('should call onStopCheck hook and continue if shouldStop=false', async () => {
      let stopCheckCount = 0;
      const onStopCheck = vi.fn(async () => {
        stopCheckCount++;
        if (stopCheckCount === 1) {
          return { shouldStop: false, continueReason: 'Keep going' };
        }
        return { shouldStop: true };
      });

      const chatService = createMockChatService([
        { content: 'First response' },
        { content: 'Second response' },
      ]);

      const config = baseConfig({ onStopCheck, turnState: { chatService } });
      const { result } = await collectEvents(agentLoop(config));

      expect(result.success).toBe(true);
      expect(onStopCheck).toHaveBeenCalledTimes(2);
    });
  });

  describe('incomplete intent detection', () => {
    it('should retry when response ends with colon', async () => {
      const chatService = createMockChatService([
        { content: '让我来检查一下：' },
        { content: 'Here is the result.' },
      ]);

      const config = baseConfig({ turnState: { chatService } });
      const { result } = await collectEvents(agentLoop(config));

      expect(result.success).toBe(true);
      expect(result.metadata?.turnsCount).toBe(2);
    });

    it('should retry when response has incomplete intent pattern', async () => {
      const chatService = createMockChatService([
        { content: 'Let me first check the file...' },
        { content: 'The file contains valid code.' },
      ]);

      const config = baseConfig({ turnState: { chatService } });
      const { result } = await collectEvents(agentLoop(config));

      expect(result.success).toBe(true);
      expect(result.metadata?.turnsCount).toBe(2);
    });

    it('should not retry more than 2 times', async () => {
      const chatService = createMockChatService([
        { content: '让我先查看：' },
        { content: '让我来检查：' },
        { content: '让我开始修复：' },
      ]);

      const config = baseConfig({ turnState: { chatService } });
      const { result } = await collectEvents(agentLoop(config));

      // Should stop after 2 retries (3rd incomplete intent is accepted as final)
      expect(result.success).toBe(true);
    });
  });

  describe('thinking content', () => {
    it('should emit thinking event', async () => {
      const chatService = createMockChatService([{
        content: 'Answer',
        reasoningContent: 'Let me think about this...',
      }]);

      const config = baseConfig({ turnState: { chatService } });
      const { events } = await collectEvents(agentLoop(config));

      const thinkingEvent = events.find((e) => e.type === 'thinking');
      expect(thinkingEvent).toBeDefined();
      if (thinkingEvent?.type === 'thinking') {
        expect(thinkingEvent.content).toBe('Let me think about this...');
      }
    });
  });

  describe('message history', () => {
    it('should add tool results to messages', async () => {
      const messages: Message[] = [{ role: 'user' as const, content: 'Read test.ts' }];
      const chatService = createMockChatService([
        {
          content: 'Reading',
          toolCalls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'ReadFile', arguments: '{"path":"test.ts"}' },
          }],
        },
        { content: 'Done' },
      ]);

      const config = baseConfig({ messages, turnState: { chatService } });
      await collectEvents(agentLoop(config));

      // Messages are now tracked in ConversationState, not the original array
      const allMessages = config.conversationState.toArray() as Message[];
      const toolMsg = allMessages.find((m) => m.role === 'tool');
      expect(toolMsg).toBeDefined();
      expect((toolMsg as Message & { name?: string }).name).toBe('ReadFile');
    });

    it('should append yielded newMessages after the tool result message', async () => {
      const messages: Message[] = [{ role: 'user' as const, content: 'Do the thing' }];
      const chatService = createMockChatService([
        {
          content: 'Working',
          toolCalls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'Skill', arguments: '{}' },
          }],
        },
        { content: 'Done' },
      ]);

      const executionPipeline = createMockExecutionPipeline({
        Skill: {
          status: 'success',
          model: 'tool-body',
          testEffects: [
            {
              type: 'newMessages',
              messages: [
                { role: 'assistant', content: 'Injected assistant context' },
                { role: 'system', content: 'Injected system context' },
              ],
            },
          ],
        },
      });

      const config = baseConfig({
        messages,
        executionPipeline,
        turnState: { chatService },
      });
      await collectEvents(agentLoop(config));

      // Messages are now tracked in ConversationState, not the original array
      const allMessages = config.conversationState.toArray() as Message[];
      const toolIndex = allMessages.findIndex((message) => message.role === 'tool');
      expect(toolIndex).toBeGreaterThan(-1);
      expect(allMessages[toolIndex + 1]).toEqual(
        expect.objectContaining({
          role: 'assistant',
          content: 'Injected assistant context',
        }),
      );
      // system newMessages now get _systemSource metadata injected
      expect(allMessages[toolIndex + 2]).toEqual(
        expect.objectContaining({
          role: 'system',
          content: 'Injected system context',
          metadata: expect.objectContaining({ _systemSource: 'tool_injection' }),
        }),
      );
    });

    it('applies next-priority input before completing a no-tool response', async () => {
      const inbox = new SessionInputInbox();
      const requestId = RequestId('request-steer-no-tool');
      const runControl = new ActiveRequestController(
        requestId,
        undefined,
        inbox,
        InputId('initial-input'),
      );
      const chatService = createMockChatService([
        { content: 'First answer' },
        { content: 'Steered answer' },
      ]);
      let stopChecks = 0;
      const config = baseConfig({
        runControl,
        turnState: { chatService },
        onInputApply: async ({ input }) => ({
          role: 'user',
          content: input.content,
        }),
        onStopCheck: async () => {
          stopChecks += 1;
          if (stopChecks === 1) {
            inbox.enqueue({
              inputId: InputId('steer-1'),
              content: 'Change direction',
              priority: 'next',
              targetRequestId: requestId,
              acceptedAt: 1,
            });
          }
          return { shouldStop: true };
        },
      });

      const { events, result } = await collectEvents(agentLoop(config));

      expect(result.success).toBe(true);
      expect(events).toContainEqual({
        type: 'input_applied',
        inputId: 'steer-1',
        requestId,
        priority: 'next',
        turn: 2,
      });
      const secondRequestMessages = (
        chatService.chat as unknown as Mock
      ).mock.calls[1]?.[0] as Message[];
      expect(secondRequestMessages.slice(-2)).toEqual([
        expect.objectContaining({
          role: 'assistant',
          content: 'First answer',
        }),
        expect.objectContaining({
          role: 'user',
          content: 'Change direction',
        }),
      ]);
      expect(inbox.size).toBe(0);
    });

    it('applies next-priority input after a complete tool-result batch', async () => {
      const inbox = new SessionInputInbox();
      const requestId = RequestId('request-steer-tool');
      const runControl = new ActiveRequestController(
        requestId,
        undefined,
        inbox,
        InputId('initial-input'),
      );
      const chatService = createMockChatService([
        {
          content: 'Inspecting',
          toolCalls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'ReadFile', arguments: '{}' },
          }],
        },
        { content: 'Done' },
      ]);
      const config = baseConfig({
        runControl,
        turnState: { chatService },
        onInputApply: async ({ input }) => ({
          role: 'user',
          content: input.content,
        }),
        onAfterToolExec: async () => {
          inbox.enqueue({
            inputId: InputId('steer-1'),
            content: 'Inspect the tests too',
            priority: 'next',
            targetRequestId: requestId,
            acceptedAt: 1,
          });
        },
      });

      await collectEvents(agentLoop(config));

      const secondRequestMessages = (
        chatService.chat as unknown as Mock
      ).mock.calls[1]?.[0] as Message[];
      expect(secondRequestMessages.slice(-3).map((message) => message.role)).toEqual([
        'assistant',
        'tool',
        'user',
      ]);
      expect(secondRequestMessages.at(-1)?.content).toBe('Inspect the tests too');
      expect(inbox.size).toBe(0);
    });

    it('interrupts the current model step and applies now-priority input', async () => {
      let resolveStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        resolveStarted = resolve;
      });
      let requestCount = 0;
      const chat = vi.fn(async (
        _messages: readonly Message[],
        _tools: unknown,
        signal?: AbortSignal,
      ) => {
        requestCount += 1;
        if (requestCount === 1) {
          resolveStarted();
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => reject(signal.reason),
              { once: true },
            );
          });
        }
        return {
          content: 'Redirected answer',
          toolCalls: [],
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        };
      });
      const chatService = {
        chat,
        chatWithRetryEvents: vi.fn(async function* (
          ...args: Parameters<typeof chat>
        ) {
          yield* [] as never[];
          return await chat(...args);
        }),
        getConfig: () => ({
          model: 'test-model',
          maxContextTokens: 128000,
        }),
      } as unknown as TurnState['chatService'];
      const inbox = new SessionInputInbox();
      const requestId = RequestId('request-interrupt-model');
      const runControl = new ActiveRequestController(
        requestId,
        undefined,
        inbox,
        InputId('initial-input'),
      );
      const onAssistantMessage = vi.fn(async () => {});
      const config = baseConfig({
        runControl,
        turnState: { chatService },
        onAssistantMessage,
        onInputApply: async ({ input }) => ({
          role: 'user',
          content: input.content,
        }),
      });

      const execution = collectEvents(agentLoop(config));
      await started;
      inbox.enqueue({
        inputId: InputId('steer-now'),
        content: 'Stop and use the other approach',
        priority: 'now',
        targetRequestId: requestId,
        acceptedAt: 1,
      });
      runControl.interruptStep(InputId('steer-now'));

      const { events, result } = await execution;

      expect(result.success).toBe(true);
      expect(events).toContainEqual({
        type: 'turn_interrupted',
        inputId: 'steer-now',
        requestId,
        turn: 1,
      });
      expect(events).toContainEqual({
        type: 'input_applied',
        inputId: 'steer-now',
        requestId,
        priority: 'now',
        turn: 2,
      });
      const secondRequestMessages = chat.mock.calls[1]?.[0] as Message[];
      expect(secondRequestMessages.at(-1)?.content).toBe(
        'Stop and use the other approach',
      );
      expect(onAssistantMessage).toHaveBeenCalledTimes(1);
      expect(onAssistantMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'Redirected answer',
          turn: 2,
        }),
      );
    });

    it('closes interrupted tool calls before applying now-priority input', async () => {
      let resolveToolStarted!: () => void;
      const toolStarted = new Promise<void>((resolve) => {
        resolveToolStarted = resolve;
      });
      const inbox = new SessionInputInbox();
      const requestId = RequestId('request-interrupt-tool');
      const runControl = new ActiveRequestController(
        requestId,
        undefined,
        inbox,
        InputId('initial-input'),
      );
      const executionPipeline = {
        getRegistry: () => ({
          get: (name: string) => ({
            kind: 'execute',
            name,
            interruptBehavior: 'cancel',
          }),
        }),
        execute: vi.fn(async function* (
          _toolName: string,
          _params: unknown,
          context: { signal?: AbortSignal },
        ) {
          resolveToolStarted();
          await new Promise<void>((resolve) => {
            if (context.signal?.aborted) {
              resolve();
              return;
            }
            context.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            });
          });
          return {
            status: 'error',
            model: 'interrupted',
            error: {
              type: 'interrupted',
              message: 'interrupted',
            },
          };
        }),
      } as unknown as AgentLoopConfig['executionPipeline'];
      const chatService = createMockChatService([
        {
          content: 'Running tool',
          toolCalls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'CancelableTool', arguments: '{}' },
          }],
        },
        { content: 'Redirected answer' },
      ]);
      const config = baseConfig({
        runControl,
        executionPipeline,
        turnState: { chatService },
        onInputApply: async ({ input }) => ({
          role: 'user',
          content: input.content,
        }),
      });

      const execution = collectEvents(agentLoop(config));
      await toolStarted;
      inbox.enqueue({
        inputId: InputId('steer-now'),
        content: 'Use a different tool',
        priority: 'now',
        targetRequestId: requestId,
        acceptedAt: 1,
      });
      runControl.interruptStep(InputId('steer-now'));

      const { events, result } = await execution;

      expect(result.success).toBe(true);
      const toolResultIndex = events.findIndex(
        (event) => event.type === 'tool_result',
      );
      const inputAppliedIndex = events.findIndex(
        (event) => event.type === 'input_applied',
      );
      expect(toolResultIndex).toBeGreaterThan(-1);
      expect(inputAppliedIndex).toBeGreaterThan(toolResultIndex);
      const interruptedToolResult = events[toolResultIndex];
      expect(interruptedToolResult).toMatchObject({
        type: 'tool_result',
        result: {
          status: 'error',
          error: {
            type: 'interrupted',
          },
        },
      });
      const secondRequestMessages = (
        chatService.chat as unknown as Mock
      ).mock.calls[1]?.[0] as Message[];
      expect(secondRequestMessages.slice(-3).map((message) => message.role)).toEqual([
        'assistant',
        'tool',
        'user',
      ]);
    });

    it('releases only unapplied inputs when steering application fails', async () => {
      const inbox = new SessionInputInbox();
      const requestId = RequestId('request-apply-failure');
      const runControl = new ActiveRequestController(
        requestId,
        undefined,
        inbox,
        InputId('initial-input'),
      );
      for (const [index, inputId] of [
        'steer-first',
        'steer-failing',
        'steer-remaining',
      ].entries()) {
        inbox.enqueue({
          inputId: InputId(inputId),
          content: inputId,
          priority: 'next',
          targetRequestId: requestId,
          acceptedAt: index,
        });
      }
      const applyAttempts: string[] = [];
      const config = baseConfig({
        runControl,
        onInputApply: async ({ input }) => {
          applyAttempts.push(input.inputId);
          if (input.inputId === 'steer-failing') {
            throw new Error('input hook failed');
          }
          return {
            role: 'user',
            content: input.content,
          };
        },
      });

      await expect(collectEvents(agentLoop(config))).rejects.toThrow(
        'input hook failed',
      );

      expect(applyAttempts).toEqual(['steer-first', 'steer-failing']);
      expect(inbox.getAll().map((input) => input.inputId)).toEqual([
        'steer-failing',
        'steer-remaining',
      ]);
      expect(
        runControl.claimSteeringInputs().map((input) => input.inputId),
      ).toEqual([
        'steer-failing',
        'steer-remaining',
      ]);
    });
  });
});
