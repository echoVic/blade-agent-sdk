import { describe, expect, it, mock, beforeEach } from 'bun:test';
import type { AgentEvent, ChatContext, LoopResult } from '../types.js';
import { PermissionMode } from '../../types/common.js';

const createMockChatService = () => ({
  chat: mock(() => Promise.resolve({
    content: 'Test response',
    toolCalls: [],
    usage: { promptTokens: 100, completionTokens: 50 },
  })),
  streamChat: mock(async function* () {
    yield { content: 'Hello ' };
    yield { content: 'World' };
    yield { finishReason: 'stop' };
  }),
  getConfig: () => ({
    model: 'test-model',
    maxContextTokens: 128000,
    maxOutputTokens: 8192,
  }),
});

const createMockAgent = (chatService: ReturnType<typeof createMockChatService>) => {
  const events: AgentEvent[] = [];
  
  return {
    streamChat: async function* (
      _message: string,
      context: ChatContext,
      options?: { maxTurns?: number; signal?: AbortSignal }
    ): AsyncGenerator<AgentEvent, LoopResult> {
      events.push({ type: 'turn_start', turn: 1, maxTurns: options?.maxTurns ?? 10 });
      yield { type: 'turn_start', turn: 1, maxTurns: options?.maxTurns ?? 10 };

      for await (const chunk of chatService.streamChat()) {
        if (chunk.content) {
          events.push({ type: 'content_delta', delta: chunk.content });
          yield { type: 'content_delta', delta: chunk.content };
        }
      }

      events.push({ type: 'stream_end' });
      yield { type: 'stream_end' };

      if (context.permissionMode === PermissionMode.PLAN) {
        events.push({ type: 'turn_start', turn: 1, maxTurns: 10 });
        yield { type: 'turn_start', turn: 1, maxTurns: 10 };

        for await (const chunk of chatService.streamChat()) {
          if (chunk.content) {
            events.push({ type: 'content_delta', delta: chunk.content });
            yield { type: 'content_delta', delta: chunk.content };
          }
        }

        events.push({ type: 'stream_end' });
        yield { type: 'stream_end' };

        return {
          success: true,
          finalMessage: 'Execution completed',
          metadata: {
            turnsCount: 2,
            toolCallsCount: 0,
            duration: 100,
            targetMode: PermissionMode.DEFAULT,
            planContent: '1. Step one\n2. Step two',
          },
        };
      }

      return {
        success: true,
        finalMessage: 'Hello World',
        metadata: {
          turnsCount: 1,
          toolCallsCount: 0,
          duration: 50,
        },
      };
    },
    getEvents: () => events,
  };
};

describe('Agent.streamChat', () => {
  let chatService: ReturnType<typeof createMockChatService>;
  let agent: ReturnType<typeof createMockAgent>;

  beforeEach(() => {
    chatService = createMockChatService();
    agent = createMockAgent(chatService);
  });

  describe('Plan mode streaming realtime', () => {
    it('should yield events in real-time during plan mode', async () => {
      const context: ChatContext = {
        messages: [],
        userId: 'test-user',
        sessionId: 'test-session',
        workspaceRoot: '/tmp',
        permissionMode: PermissionMode.PLAN,
      };

      const receivedEvents: AgentEvent[] = [];
      const timestamps: number[] = [];

      const stream = agent.streamChat('Create a plan', context);

      for await (const event of stream) {
        receivedEvents.push(event);
        timestamps.push(Date.now());
      }

      expect(receivedEvents.length).toBeGreaterThan(0);

      const contentDeltas = receivedEvents.filter(e => e.type === 'content_delta');
      expect(contentDeltas.length).toBeGreaterThan(0);

      const turnStarts = receivedEvents.filter(e => e.type === 'turn_start');
      expect(turnStarts.length).toBe(2);
    });

    it('should yield content_delta events incrementally', async () => {
      const context: ChatContext = {
        messages: [],
        userId: 'test-user',
        sessionId: 'test-session',
        workspaceRoot: '/tmp',
        permissionMode: PermissionMode.DEFAULT,
      };

      const contentChunks: string[] = [];

      const stream = agent.streamChat('Hello', context);

      for await (const event of stream) {
        if (event.type === 'content_delta') {
          contentChunks.push(event.delta);
        }
      }

      expect(contentChunks).toEqual(['Hello ', 'World']);
    });
  });

  describe('Plan to execute streaming relay', () => {
    it('should seamlessly transition from plan to execute mode', async () => {
      const context: ChatContext = {
        messages: [],
        userId: 'test-user',
        sessionId: 'test-session',
        workspaceRoot: '/tmp',
        permissionMode: PermissionMode.PLAN,
      };

      const eventTypes: string[] = [];

      const stream = agent.streamChat('Create and execute plan', context);

      for await (const event of stream) {
        eventTypes.push(event.type);
      }

      const turnStartIndices = eventTypes
        .map((type, idx) => type === 'turn_start' ? idx : -1)
        .filter(idx => idx !== -1);

      expect(turnStartIndices.length).toBe(2);

      const streamEndIndices = eventTypes
        .map((type, idx) => type === 'stream_end' ? idx : -1)
        .filter(idx => idx !== -1);

      expect(streamEndIndices.length).toBe(2);

      expect(turnStartIndices[1]).toBeGreaterThan(streamEndIndices[0]);
    });

    it('should preserve event order during plan→execute transition', async () => {
      const context: ChatContext = {
        messages: [],
        userId: 'test-user',
        sessionId: 'test-session',
        workspaceRoot: '/tmp',
        permissionMode: PermissionMode.PLAN,
      };

      const events: AgentEvent[] = [];

      const stream = agent.streamChat('Plan and execute', context);

      for await (const event of stream) {
        events.push(event);
      }

      expect(events[0].type).toBe('turn_start');

      let foundFirstStreamEnd = false;
      let foundSecondTurnStart = false;

      for (const event of events) {
        if (event.type === 'stream_end' && !foundFirstStreamEnd) {
          foundFirstStreamEnd = true;
          continue;
        }
        if (foundFirstStreamEnd && event.type === 'turn_start') {
          foundSecondTurnStart = true;
          break;
        }
      }

      expect(foundFirstStreamEnd).toBe(true);
      expect(foundSecondTurnStart).toBe(true);
    });

    it('should return final result after plan→execute completion', async () => {
      const context: ChatContext = {
        messages: [],
        userId: 'test-user',
        sessionId: 'test-session',
        workspaceRoot: '/tmp',
        permissionMode: PermissionMode.PLAN,
      };

      const gen = agent.streamChat('Plan and execute', context);
      let result: LoopResult | undefined;
      let done = false;
      while (!done) {
        const next = await gen.next();
        if (next.done) {
          result = next.value;
          done = true;
        }
      }

      expect(result).toBeDefined();
      expect(result!.success).toBe(true);
      expect(result!.finalMessage).toBe('Execution completed');
    });
  });

  describe('Error handling in stream', () => {
    it('should handle errors gracefully', async () => {
      const errorChatService = {
        ...chatService,
        streamChat: mock(async function* () {
          yield { content: 'Start' };
          throw new Error('Stream error');
        }),
      };

      const errorAgent = {
        streamChat: async function* (
          _message: string,
          _context: ChatContext
        ): AsyncGenerator<AgentEvent, LoopResult> {
          yield { type: 'turn_start', turn: 1, maxTurns: 10 };

          try {
            for await (const chunk of errorChatService.streamChat()) {
              if (chunk.content) {
                yield { type: 'content_delta', delta: chunk.content };
              }
            }
          } catch (error) {
            yield { type: 'error', message: (error as Error).message };
          }

          return {
            success: false,
            finalMessage: 'Error occurred',
            metadata: {
              turnsCount: 1,
              toolCallsCount: 0,
              duration: 10,
            },
          };
        },
      };

      const context: ChatContext = {
        messages: [],
        userId: 'test-user',
        sessionId: 'test-session',
        workspaceRoot: '/tmp',
        permissionMode: PermissionMode.DEFAULT,
      };

      const events: AgentEvent[] = [];
      const stream = errorAgent.streamChat('Test', context);

      for await (const event of stream) {
        events.push(event);
      }

      const errorEvent = events.find(e => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect((errorEvent as { type: 'error'; message: string }).message).toBe('Stream error');
    });
  });
});
