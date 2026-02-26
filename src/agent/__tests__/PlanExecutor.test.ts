import { describe, expect, it, mock } from 'bun:test';
import { PlanExecutor } from '../PlanExecutor.js';
import type { LoopResult, ChatContext, UserMessageContent } from '../types.js';

// ===== Helpers =====

function createContext(overrides: Partial<ChatContext> = {}): ChatContext {
  return {
    messages: [],
    userId: 'test-user',
    sessionId: 'test-session',
    workspaceRoot: '/tmp/test',
    permissionMode: 'plan',
    ...overrides,
  } as ChatContext;
}

function successResult(msg = 'done'): LoopResult {
  return {
    success: true,
    finalMessage: msg,
    metadata: { turnsCount: 1, toolCallsCount: 0, duration: 100 },
  };
}

// ===== Tests =====

describe('PlanExecutor', () => {
  describe('injectPlanReminder', () => {
    it('should inject reminder into string message', () => {
      const pe = new PlanExecutor();
      const result = pe.injectPlanReminder('analyze this code');
      expect(typeof result).toBe('string');
      expect(result as string).toContain('analyze this code');
    });

    it('should inject reminder into multimodal message with text', () => {
      const pe = new PlanExecutor();
      const message: UserMessageContent = [
        { type: 'text', text: 'check this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
      ];
      const result = pe.injectPlanReminder(message);
      expect(Array.isArray(result)).toBe(true);
      const parts = result as Array<{ type: string; text?: string }>;
      const textPart = parts.find(p => p.type === 'text');
      expect(textPart?.text).toContain('check this');
    });

    it('should handle image-only multimodal message', () => {
      const pe = new PlanExecutor();
      const message: UserMessageContent = [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
      ];
      const result = pe.injectPlanReminder(message);
      expect(Array.isArray(result)).toBe(true);
      const parts = result as Array<{ type: string }>;
      // Should prepend a text part
      expect(parts[0].type).toBe('text');
      expect(parts.length).toBe(2);
    });
  });

  describe('runPlanLoop', () => {
    it('should call executeLoop with plan system prompt and reminder', async () => {
      const pe = new PlanExecutor('zh');
      const context = createContext();
      const executeLoop = mock(async () => successResult());

      const result = await pe.runPlanLoop('do something', context, undefined, executeLoop);

      expect(result.success).toBe(true);
      expect(executeLoop).toHaveBeenCalledTimes(1);

      // First arg should be the reminder-injected message
      const calls = executeLoop.mock.calls as unknown as Array<[UserMessageContent, ChatContext, unknown, string]>;
      const injectedMessage = calls[0][0];
      expect(typeof injectedMessage).toBe('string');
      expect(injectedMessage as string).toContain('do something');

      // Fourth arg should be the plan system prompt
      const systemPrompt = calls[0][3];
      expect(typeof systemPrompt).toBe('string');
      expect((systemPrompt as string).length).toBeGreaterThan(0);
    });

    it('should pass through loop options', async () => {
      const pe = new PlanExecutor();
      const context = createContext();
      const controller = new AbortController();
      const loopOptions = { signal: controller.signal };
      const executeLoop = mock(async () => successResult());

      await pe.runPlanLoop('test', context, loopOptions, executeLoop);

      const calls = executeLoop.mock.calls as unknown as Array<[unknown, unknown, typeof loopOptions]>;
      expect(calls[0][2]).toBe(loopOptions);
    });
  });

  describe('runPlanLoopStream', () => {
    it('should yield events from stream executor', async () => {
      const pe = new PlanExecutor();
      const context = createContext();

      async function* mockStreamExecutor(): AsyncGenerator<any, LoopResult> {
        yield { type: 'agent_start' };
        yield { type: 'turn_start', turn: 1 };
        return successResult();
      }

      const executeStream = mock((..._args: unknown[]) => mockStreamExecutor());
      const stream = pe.runPlanLoopStream('test', context, undefined, executeStream as any);

      const events: unknown[] = [];
      let result: LoopResult | undefined;
      while (true) {
        const { value, done } = await stream.next();
        if (done) { result = value; break; }
        events.push(value);
      }

      expect(events.length).toBe(2);
      expect(result?.success).toBe(true);
      expect(executeStream).toHaveBeenCalledTimes(1);
    });
  });
});
