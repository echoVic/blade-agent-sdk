import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSession,
  resetSessionRuntimeFactory,
  setSessionRuntimeFactory,
} from '../session/index.js';
import * as browserEntry from '../browser/index.js';
import type { RuntimeContext } from '../core/index.js';
import type {
  ISession,
  SessionMessage,
  StreamMessage,
} from '../session/index.js';

function createFakeSession(sessionId = 'pkg-session'): ISession {
  const messages: SessionMessage[] = [];
  let defaultContext: RuntimeContext = {};

  return {
    sessionId,
    messages,
    isClosed: false,
    async send(message) {
      messages.push({ role: 'user', content: message });
    },
    async *stream(): AsyncGenerator<StreamMessage> {
      yield {
        type: 'result',
        subtype: 'success',
        content: '',
        sessionId,
      };
    },
    async close() {},
    abort() {},
    getDefaultContext() {
      return defaultContext;
    },
    setDefaultContext(context) {
      defaultContext = context;
    },
    setPermissionMode() {},
    async setModel() {},
    setMaxTurns() {},
    async supportedModels() {
      return [];
    },
    async mcpServerStatus() {
      return [];
    },
    async mcpConnect() {},
    async mcpDisconnect() {},
    async mcpReconnect() {},
    async mcpListTools() {
      return [];
    },
    async fork() {
      return createFakeSession(`${sessionId}-fork`);
    },
    getLastTrace() {
      return undefined;
    },
    getTraces() {
      return [];
    },
    async [Symbol.asyncDispose]() {
      await this.close();
    },
  };
}

describe('agent-sdk package-local public facades', () => {
  afterEach(() => {
    resetSessionRuntimeFactory();
  });

  it('keeps createSession session-first while routing through the package-local runtime factory', async () => {
    const create = vi.fn(async () => createFakeSession());
    setSessionRuntimeFactory({
      create,
      resume: vi.fn(),
    });

    const session = await createSession({
      provider: { type: 'openai-compatible', apiKey: 'test-key', baseUrl: 'https://example.test/v1' },
      model: 'glm-5.2',
      allowedTools: [],
    });

    expect(session.sessionId).toBe('pkg-session');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'glm-5.2',
        allowedTools: [],
      }),
    );
  });

  it('keeps browser entrypoints as browser-safe contracts with clear server-only stubs', () => {
    expect(browserEntry.PermissionMode.DEFAULT).toBe('default');
    expect(() => browserEntry.createSession({} as never)).toThrow(/server-only.*createSession/);
  });
});
