import { describe, expect, it } from 'vitest';
import {
  createSession,
  forkSession,
  prompt,
  resumeSession,
  setSessionRuntimeFactory,
} from '../../packages/agent-sdk/src/session/index.js';
import type {
  ISession,
  PromptResult,
  SessionOptions,
  UserMessageContent,
} from '../../packages/agent-sdk/src/session/index.js';

const options: SessionOptions = {
  provider: {
    type: 'openai-compatible',
    apiKey: 'test-key',
    baseUrl: 'https://example.com/v1',
  },
  model: 'test-model',
};

function createFakeSession(id: string): ISession {
  return {
    sessionId: id,
    messages: [],
    isClosed: false,
    send: async () => {},
    stream: async function* () {},
    close: async () => {},
    abort: () => {},
    getDefaultContext: () => ({}),
    setDefaultContext: () => {},
    setPermissionMode: () => {},
    setModel: async () => {},
    setMaxTurns: () => {},
    supportedModels: async () => [],
    mcpServerStatus: async () => [],
    mcpConnect: async () => {},
    mcpDisconnect: async () => {},
    mcpReconnect: async () => {},
    mcpListTools: async () => [],
    fork: async () => createFakeSession(`forked:${id}`),
    getLastTrace: () => undefined,
    getTraces: () => [],
    [Symbol.asyncDispose]: async () => {},
  };
}

describe('agent-sdk session runtime factory', () => {
  it('routes create, resume, fork, and prompt through package-local session factory', async () => {
    const calls: string[] = [];
    const restore = setSessionRuntimeFactory({
      async create(receivedOptions) {
        calls.push(`create:${receivedOptions.model}`);
        return createFakeSession('created');
      },
      async resume(receivedOptions) {
        calls.push(`resume:${receivedOptions.sessionId}`);
        return createFakeSession(`resumed:${receivedOptions.sessionId}`);
      },
      async fork(receivedOptions) {
        calls.push(`fork:${receivedOptions.sessionId}:${receivedOptions.messageId ?? ''}`);
        return createFakeSession(`forked:${receivedOptions.sessionId}`);
      },
      async prompt(message: UserMessageContent, receivedOptions) {
        calls.push(`prompt:${receivedOptions.model}:${message}`);
        return {
          result: 'factory prompt',
          toolCalls: [],
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            maxContextTokens: 0,
          },
          duration: 0,
          turnsCount: 0,
        } satisfies PromptResult;
      },
    });

    try {
      await expect(createSession(options)).resolves.toMatchObject({ sessionId: 'created' });
      await expect(resumeSession({ ...options, sessionId: 'old' })).resolves.toMatchObject({
        sessionId: 'resumed:old',
      });
      await expect(forkSession({ ...options, sessionId: 'old', messageId: 'm1' })).resolves.toMatchObject({
        sessionId: 'forked:old',
      });
      await expect(prompt('hello', options)).resolves.toMatchObject({
        result: 'factory prompt',
      });
    } finally {
      restore();
    }

    expect(calls).toEqual([
      'create:test-model',
      'resume:old',
      'fork:old:m1',
      'prompt:test-model:hello',
    ]);
  });
});
