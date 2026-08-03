import { describe, expect, it, vi } from 'vitest';
import { SessionId } from '../local/branded.js';
import { createKernelStreamTurnBridge } from '../session/kernelStreamBridge.js';
import type { ActiveSessionTurn } from '../session/turn.js';
import type { PackageLocalSessionStreamContext } from '../session/sessionInstance.js';
import type { SessionOptions, StreamMessage } from '../session/types.js';

const sessionOptions: SessionOptions = {
  provider: {
    type: 'openai-compatible',
    apiKey: 'test-key',
    baseUrl: 'https://example.com/v1',
  },
  model: 'test-model',
  maxTurns: 9,
};

async function collect(stream: AsyncGenerator<StreamMessage>): Promise<StreamMessage[]> {
  const messages: StreamMessage[] = [];
  for await (const message of stream) {
    messages.push(message);
  }
  return messages;
}

describe('agent-sdk kernel stream bridge', () => {
  it('adapts package-local turns into runtime kernel streams', async () => {
    const controller = new AbortController();
    const turn: ActiveSessionTurn = {
      message: [
        { type: 'text', text: 'first' },
        { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
        { type: 'text', text: 'second' },
      ],
      sendOptions: {
        signal: controller.signal,
        maxTurns: 4,
      },
      snapshot: {
        sessionId: SessionId('session-1'),
        turnId: 'turn-1',
        context: {},
        filesystemRoots: ['/workspace'],
        cwd: '/workspace/project',
        environment: {
          NODE_ENV: 'test',
        },
      },
      signal: controller.signal,
      cleanup: vi.fn(),
    };
    const context: PackageLocalSessionStreamContext = {
      sessionId: SessionId('session-1'),
      options: sessionOptions,
    };
    const emittedMessages: StreamMessage[] = [
      { type: 'turn_start', turn: 1, sessionId: SessionId('session-1') },
      { type: 'content', delta: 'done', sessionId: SessionId('session-1') },
      { type: 'result', subtype: 'success', content: 'done', sessionId: SessionId('session-1') },
    ];
    const prepareTurn = vi.fn();
    const streamAgentKernelTurn = vi.fn(async function* (options) {
      expect(options.input).toBe('first\nsecond');
      expect(options.turnId).toBe('turn-1');
      expect(options.signal).toBe(controller.signal);
      expect(options.includeThinking).toBe(true);
      expect(options.maxSteps).toBe(4);
      expect(options.createExecutionContext({ id: 'call-1', name: 'Read', input: {} })).toEqual({
        sessionId: SessionId('session-1'),
        contextSnapshot: turn.snapshot,
        signal: undefined,
      });
      for (const message of emittedMessages) {
        yield message;
      }
    });
    const bridge = createKernelStreamTurnBridge({
      context,
      runtime: {
        prepareTurn,
        streamAgentKernelTurn,
      },
    });

    await expect(collect(bridge(turn, { includeThinking: true }, context))).resolves.toEqual(
      emittedMessages,
    );
    expect(prepareTurn).toHaveBeenCalledWith(turn.snapshot);
    expect(streamAgentKernelTurn).toHaveBeenCalledTimes(1);
  });
});
