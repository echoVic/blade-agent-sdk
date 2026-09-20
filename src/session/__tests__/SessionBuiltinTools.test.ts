import { mkdtempSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { NOOP_LOGGER } from '../../logging/Logger.js';
import type { ModelServiceConfig } from '../../model/config.js';
import type { ModelMessage } from '../../model/message.js';
import type { ModelResponse, ModelService } from '../../model/service.js';
import type { RuntimeContext } from '../../runtime/index.js';
import { ProviderRegistry } from '../../services/ProviderRegistry.js';
import { FileAccessTracker } from '../../tools/builtin/file/FileAccessTracker.js';
import { FileLockManager } from '../../tools/execution/FileLockManager.js';
import { PermissionMode } from '../../types/constants.js';
import { SessionId } from '../../types/identifiers.js';
import { createSession } from '../Session.js';
import { NODE_SESSION_HOST, SERVER_SESSION_HOST } from '../SessionHostProfile.js';
import { SessionRuntime } from '../SessionRuntime.js';
import type { SessionOptions } from '../types.js';

function createOptions(overrides: Partial<SessionOptions> = {}): SessionOptions {
  return {
    provider: { type: 'openai-compatible', apiKey: 'test-key' },
    model: 'gpt-4o-mini',
    ...overrides,
  };
}

function createFilesystemContext(workspaceRoot: string): RuntimeContext {
  return {
    capabilities: {
      filesystem: {
        roots: [workspaceRoot],
        cwd: workspaceRoot,
      },
    },
  };
}

describe('SessionOptions.builtinTools', () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'session-builtin-tools-'));
    FileAccessTracker.resetInstance();
    FileLockManager.resetInstance();
  });

  it('registers the built-ins for a server host that opts in', async () => {
    const runtime = new SessionRuntime(
      SessionId('server-opt-in'),
      createOptions({ builtinTools: true }),
      { models: [] },
      PermissionMode.DEFAULT,
      createFilesystemContext(workspaceRoot),
      NOOP_LOGGER,
      SERVER_SESSION_HOST,
    );

    await runtime.initialize();
    try {
      expect(runtime.getToolRegistry().get('Read')).toBeDefined();
      expect(runtime.getToolRegistry().get('Glob')).toBeDefined();
      expect(runtime.getToolRegistry().get('Grep')).toBeDefined();
      expect(runtime.getToolRegistry().get('Bash')).toBeDefined();
    } finally {
      await runtime.close();
    }
  });

  it('keeps server sessions without the opt-in free of built-ins', async () => {
    const runtime = new SessionRuntime(
      SessionId('server-default'),
      createOptions(),
      { models: [] },
      PermissionMode.DEFAULT,
      createFilesystemContext(workspaceRoot),
      NOOP_LOGGER,
      SERVER_SESSION_HOST,
    );

    await runtime.initialize();
    try {
      expect(runtime.getToolRegistry().get('Read')).toBeUndefined();
      expect(runtime.getToolRegistry().get('Glob')).toBeUndefined();
      expect(runtime.getToolRegistry().get('Grep')).toBeUndefined();
      expect(runtime.getToolRegistry().get('Bash')).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });

  it('keeps registering the built-ins for a node host by default', async () => {
    const runtime = new SessionRuntime(
      SessionId('node-default'),
      createOptions(),
      { models: [] },
      PermissionMode.DEFAULT,
      createFilesystemContext(workspaceRoot),
      NOOP_LOGGER,
      NODE_SESSION_HOST,
    );

    await runtime.initialize();
    try {
      expect(runtime.getToolRegistry().get('Read')).toBeDefined();
      expect(runtime.getToolRegistry().get('Glob')).toBeDefined();
      expect(runtime.getToolRegistry().get('Grep')).toBeDefined();
      expect(runtime.getToolRegistry().get('Bash')).toBeDefined();
    } finally {
      await runtime.close();
    }
  });

  it('lets a node host opt out of the built-ins', async () => {
    const runtime = new SessionRuntime(
      SessionId('node-opt-out'),
      createOptions({ builtinTools: false }),
      { models: [] },
      PermissionMode.DEFAULT,
      createFilesystemContext(workspaceRoot),
      NOOP_LOGGER,
      NODE_SESSION_HOST,
    );

    await runtime.initialize();
    try {
      expect(runtime.getToolRegistry().get('Read')).toBeUndefined();
      expect(runtime.getToolRegistry().get('Glob')).toBeUndefined();
      expect(runtime.getToolRegistry().get('Grep')).toBeUndefined();
      expect(runtime.getToolRegistry().get('Bash')).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });

  it('still applies allowedTools when a server host opts in', async () => {
    const runtime = new SessionRuntime(
      SessionId('server-allowed-tools'),
      createOptions({ builtinTools: true, allowedTools: ['Read'] }),
      { models: [] },
      PermissionMode.DEFAULT,
      createFilesystemContext(workspaceRoot),
      NOOP_LOGGER,
      SERVER_SESSION_HOST,
    );

    await runtime.initialize();
    try {
      expect(runtime.getToolRegistry().get('Read')).toBeDefined();
      expect(runtime.getToolRegistry().get('Bash')).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });
});

function globOnceService(config: ModelServiceConfig): ModelService {
  const next = (messages: readonly ModelMessage[]): ModelResponse =>
    messages.some((message) => message.role === 'tool')
      ? { content: 'done' }
      : {
          content: '',
          toolCalls: [
            {
              id: 'call-glob',
              type: 'function',
              function: { name: 'Glob', arguments: JSON.stringify({ pattern: '*' }) },
            },
          ],
        };
  return {
    async chat(messages) {
      return next(messages);
    },
    async sideQuery() {
      return { content: '' };
    },
    async *streamChat(messages) {
      const response = next(messages);
      yield response;
      yield { finishReason: response.toolCalls ? 'tool_calls' : 'stop' };
    },
    getConfig() {
      return config;
    },
    updateConfig() {},
  };
}

describe('Session with a server-hosted opt-in', () => {
  it('runs Glob through a server-hosted Session that opted into the built-in tools', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'session-builtin-tools-behavioral-'));
    await writeFile(join(workspaceRoot, 'notes.txt'), 'hello from glob\n');

    const session = await createSession({
      provider: { type: 'glob-once' },
      providerRegistry: new ProviderRegistry([
        { type: 'glob-once', create: (config) => globOnceService({ ...config }) },
      ]),
      model: 'glob-once',
      builtinTools: true,
      allowedTools: ['Glob'],
      persistSession: false,
      defaultContext: {
        capabilities: { filesystem: { roots: [workspaceRoot], cwd: workspaceRoot } },
      },
    });

    const toolResults: Array<{ name: string; isError?: boolean }> = [];
    try {
      await session.send('find files');
      for await (const event of session.stream()) {
        if (event.type === 'tool_result') {
          toolResults.push({ name: event.name, isError: event.isError });
        }
        if (event.type === 'result' || event.type === 'error') break;
      }
    } finally {
      await session.close();
    }

    const globResult = toolResults.find((result) => result.name === 'Glob');
    expect(globResult).toBeDefined();
    expect(globResult?.isError).toBeFalsy();
  });
});
