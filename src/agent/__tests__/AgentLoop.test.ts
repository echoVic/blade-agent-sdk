import { describe, expect, it, mock } from 'bun:test';
import type { Message } from '../../services/ChatServiceInterface.js';
import type { ToolResult } from '../../tools/types/index.js';
import type { AgentEvent } from '../AgentEvent.js';
import type { AgentLoopConfig } from '../AgentLoop.js';
import { agentLoop } from '../AgentLoop.js';
import type { LoopResult } from '../types.js';

// ===== Mock Factories =====

function createMockExecutionPipeline(results?: Record<string, ToolResult>) {
  return {
    getRegistry: () => ({
      get: (name: string) => ({ kind: 'execute', name }),
    }),
    execute: mock(async (toolName: string, _params: unknown, _ctx: unknown) => {
      if (results && results[toolName]) return results[toolName];
      return {
        success: true,
        llmContent: `Result of ${toolName}`,
        displayContent: `Result of ${toolName}`,
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
  return {
    chat: mock(async () => {
      const resp = responses[callIndex] || responses[responses.length - 1];
      callIndex++;
      return {
        content: resp.content,
        toolCalls: resp.toolCalls || [],
        reasoningContent: resp.reasoningContent,
        usage: resp.usage || { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      };
    }),
    getConfig: () => ({
      model: 'test-model',
      maxContextTokens: 128000,
    }),
  } as unknown as AgentLoopConfig['chatService'];
}

function baseConfig(overrides: Partial<AgentLoopConfig> = {}): AgentLoopConfig {
  return {
    chatService: createMockChatService([{ content: 'Hello!' }]),
    executionPipeline: createMockExecutionPipeline(),
    tools: [],
    messages: [{ role: 'user', content: 'Hi' }],
    maxTurns: 10,
    isYoloMode: false,
    maxContextTokens: 128000,
    executionContext: {
      sessionId: 'test-session',
      userId: 'test-user',
      workspaceRoot: '/tmp/test',
    },
    ...overrides,
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
      const config = baseConfig({ chatService });
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
      const config = baseConfig({ chatService });
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
      const config = baseConfig({ chatService });
      const { events, result } = await collectEvents(agentLoop(config));

      expect(result.success).toBe(true);
      expect(result.metadata?.toolCallsCount).toBe(2);

      const toolStarts = events.filter((e) => e.type === 'tool_start');
      expect(toolStarts.length).toBe(2);
    });

    it('should handle tool execution failure gracefully', async () => {
      const pipeline = createMockExecutionPipeline();
      (pipeline.execute as ReturnType<typeof mock>).mockImplementation(async () => {
        throw new Error('Permission denied');
      });

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
      const config = baseConfig({ chatService, executionPipeline: pipeline });
      const { result } = await collectEvents(agentLoop(config));

      // Loop should continue after tool failure and eventually complete
      expect(result.success).toBe(true);
      expect(result.metadata?.toolCallsCount).toBe(1);
    });

    it('should exit loop when tool sets shouldExitLoop', async () => {
      const pipeline = createMockExecutionPipeline({
        ExitTool: {
          success: true,
          llmContent: 'Exiting',
          displayContent: 'Exiting',
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
      const config = baseConfig({ chatService, executionPipeline: pipeline });
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
      (pipeline.execute as ReturnType<typeof mock>).mockImplementation(async () => {
        // Abort during tool execution
        controller.abort();
        return { success: true, llmContent: 'ok', displayContent: 'ok' } as ToolResult;
      });

      const config = baseConfig({
        chatService,
        executionPipeline: pipeline,
        signal: controller.signal,
      });
      const { result } = await collectEvents(agentLoop(config));

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('aborted');
    });
  });

  describe('turn limits', () => {
    it('should stop at maxTurns when no handler', async () => {
      // Create a chat service that always returns tool calls
      let callCount = 0;
      const chatService = {
        chat: mock(async () => {
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
      } as unknown as AgentLoopConfig['chatService'];

      const config = baseConfig({ chatService, maxTurns: 3 });
      const { result } = await collectEvents(agentLoop(config));

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('max_turns_exceeded');
    });

    it('should continue when onTurnLimitReached returns continue', async () => {
      let callCount = 0;
      const chatService = {
        chat: mock(async () => {
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
      } as unknown as AgentLoopConfig['chatService'];

      const config = baseConfig({
        chatService,
        maxTurns: 2,
        onTurnLimitReached: async () => ({ continue: true }),
        onTurnLimitCompact: async () => ({
          success: true,
          compactedMessages: [{ role: 'user' as const, content: 'Continue' }],
        }),
      });
      const { result } = await collectEvents(agentLoop(config));

      expect(result.success).toBe(true);
      expect(result.finalMessage).toBe('Final answer');
    });
  });

  describe('hooks', () => {
    it('should call onAssistantMessage hook', async () => {
      const onAssistantMessage = mock(async () => {});
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

      const config = baseConfig({ chatService, onAssistantMessage });
      await collectEvents(agentLoop(config));

      expect(onAssistantMessage).toHaveBeenCalled();
      const firstCall = (onAssistantMessage.mock.calls as unknown as Array<[{ content: string; turn: number }]>)[0][0];
      expect(firstCall.content).toBe('Using tool');
      expect(firstCall.turn).toBe(1);
    });

    it('should call onBeforeToolExec and onAfterToolExec hooks', async () => {
      const onBeforeToolExec = mock(async () => 'uuid-123');
      const onAfterToolExec = mock(async () => {});

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

      const config = baseConfig({ chatService, onBeforeToolExec, onAfterToolExec });
      await collectEvents(agentLoop(config));

      expect(onBeforeToolExec).toHaveBeenCalledTimes(1);
      expect(onAfterToolExec).toHaveBeenCalledTimes(1);

      const afterCtx = (onAfterToolExec.mock.calls as unknown as Array<[{
        toolCall: { function: { name: string } };
        toolUseUuid: string | null;
      }]>)[0][0];
      expect(afterCtx.toolCall.function.name).toBe('ReadFile');
      expect(afterCtx.toolUseUuid).toBe('uuid-123');
    });

    it('should call onComplete hook on normal finish', async () => {
      const onComplete = mock(async () => {});
      const config = baseConfig({ onComplete });
      await collectEvents(agentLoop(config));

      expect(onComplete).toHaveBeenCalledTimes(1);
      const ctx = (onComplete.mock.calls as unknown as Array<[{ content: string; turn: number }]>)[0][0];
      expect(ctx.content).toBe('Hello!');
      expect(ctx.turn).toBe(1);
    });

    it('should call onStopCheck hook and continue if shouldStop=false', async () => {
      let stopCheckCount = 0;
      const onStopCheck = mock(async () => {
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

      const config = baseConfig({ chatService, onStopCheck });
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

      const config = baseConfig({ chatService });
      const { result } = await collectEvents(agentLoop(config));

      expect(result.success).toBe(true);
      expect(result.metadata?.turnsCount).toBe(2);
    });

    it('should retry when response has incomplete intent pattern', async () => {
      const chatService = createMockChatService([
        { content: 'Let me first check the file...' },
        { content: 'The file contains valid code.' },
      ]);

      const config = baseConfig({ chatService });
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

      const config = baseConfig({ chatService });
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

      const config = baseConfig({ chatService });
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

      const config = baseConfig({ chatService, messages });
      await collectEvents(agentLoop(config));

      // Messages should contain: user, assistant (with tool_calls), tool result
      const toolMsg = messages.find((m) => m.role === 'tool');
      expect(toolMsg).toBeDefined();
      expect((toolMsg as Message & { name?: string }).name).toBe('ReadFile');
    });
  });
});
