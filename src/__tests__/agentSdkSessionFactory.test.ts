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
  it('routes create and resume through the package-local session factory', async () => {
    const calls: string[] = [];
    let createCalls = 0;
    const fakePromptSession = createFakeSession('prompted');
    fakePromptSession.send = async (message) => {
      calls.push(`send:${message}`);
    };
    fakePromptSession.stream = async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        content: 'factory prompt',
        sessionId: 'prompted',
      };
    };
    const restore = setSessionRuntimeFactory({
      async create(receivedOptions) {
        calls.push(`create:${receivedOptions.model}`);
        createCalls += 1;
        return createCalls === 1 ? createFakeSession('created') : fakePromptSession;
      },
      async resume(receivedOptions) {
        calls.push(`resume:${receivedOptions.sessionId}`);
        return createFakeSession(`resumed:${receivedOptions.sessionId}`);
      },
      async fork(receivedOptions) {
        throw new Error(`runtime fork should not be called for ${receivedOptions.sessionId}`);
      },
      async prompt(_message: UserMessageContent, _receivedOptions) {
        throw new Error('runtime prompt should not be called');
      },
    });

    try {
      await expect(createSession(options)).resolves.toMatchObject({ sessionId: 'created' });
      await expect(resumeSession({ ...options, sessionId: 'old' })).resolves.toMatchObject({
        sessionId: 'resumed:old',
      });
      await expect(forkSession({ ...options, sessionId: 'old', messageId: 'm1' })).resolves.toMatchObject({
        sessionId: 'forked:resumed:old',
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
      'resume:old',
      'create:test-model',
      'send:hello',
    ]);
  });

  it('implements prompt from package-local session lifecycle instead of delegating to runtime prompt', async () => {
    const calls: string[] = [];
    const fakeSession = createFakeSession('created');
    fakeSession.send = async (message) => {
      calls.push(`send:${message}`);
    };
    fakeSession.stream = async function* () {
      calls.push('stream');
      yield { type: 'turn_start', turn: 1, sessionId: 'created' };
      yield { type: 'content', delta: 'hello ', sessionId: 'created' };
      yield {
        type: 'tool_use',
        id: 'tool-1',
        name: 'lookup',
        input: { query: 'blade' },
        sessionId: 'created',
      };
      yield {
        type: 'tool_result',
        id: 'tool-1',
        name: 'lookup',
        output: 'found',
        sessionId: 'created',
      };
      yield {
        type: 'usage',
        usage: {
          inputTokens: 2,
          outputTokens: 3,
          totalTokens: 5,
          maxContextTokens: 128000,
        },
        sessionId: 'created',
      };
      yield { type: 'result', subtype: 'success', content: 'hello world', sessionId: 'created' };
    };
    fakeSession.close = async () => {
      calls.push('close');
    };

    const restore = setSessionRuntimeFactory({
      async create(receivedOptions) {
        calls.push(`create:${receivedOptions.model}`);
        return fakeSession;
      },
      async resume() {
        throw new Error('resume should not be called');
      },
      async fork() {
        throw new Error('fork should not be called');
      },
      async prompt() {
        throw new Error('runtime prompt should not be called');
      },
    });

    try {
      await expect(prompt('hello', options)).resolves.toMatchObject({
        result: 'hello world',
        toolCalls: [
          {
            id: 'tool-1',
            name: 'lookup',
            input: { query: 'blade' },
            output: 'found',
          },
        ],
        usage: {
          inputTokens: 2,
          outputTokens: 3,
          totalTokens: 5,
          maxContextTokens: 128000,
        },
        turnsCount: 1,
      });
    } finally {
      restore();
    }

    expect(calls).toEqual(['create:test-model', 'send:hello', 'stream', 'close']);
  });

  it('implements forkSession from package-local resume and live session fork lifecycle', async () => {
    const calls: string[] = [];
    const sourceSession = createFakeSession('source');
    const forkedSession = createFakeSession('forked:source');
    sourceSession.fork = async (forkOptions) => {
      calls.push(`session-fork:${forkOptions?.messageId ?? ''}`);
      return forkedSession;
    };
    sourceSession.close = async () => {
      calls.push('source-close');
    };

    const restore = setSessionRuntimeFactory({
      async create() {
        throw new Error('create should not be called');
      },
      async resume(receivedOptions) {
        calls.push(`resume:${receivedOptions.sessionId}`);
        return sourceSession;
      },
      async fork() {
        throw new Error('runtime fork should not be called');
      },
      async prompt() {
        throw new Error('prompt should not be called');
      },
    });

    try {
      await expect(
        forkSession({ ...options, sessionId: 'old', messageId: 'm1' }),
      ).resolves.toBe(forkedSession);
    } finally {
      restore();
    }

    expect(calls).toEqual(['resume:old', 'session-fork:m1', 'source-close']);
  });
});
