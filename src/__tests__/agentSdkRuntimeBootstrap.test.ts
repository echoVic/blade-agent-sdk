import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeContext } from '../../packages/agent-sdk/src/runtime/types.js';
import type { BladeConfig } from '../../packages/agent-sdk/src/types/common.js';
import type { SessionOptions } from '../../packages/agent-sdk/src/session/types.js';
import { HookEvent } from '../../packages/agent-sdk/src/types/constants.js';

const bootstrapModulePath = '../../packages/agent-sdk/src/session/runtimeBootstrap.js';
const bootstrapSourcePath = 'packages/agent-sdk/src/session/runtimeBootstrap.ts';

describe('agent-sdk package-local runtime bootstrap helpers', () => {
  it('derives initial state and resolved runtime ports without constructing a session runtime', async () => {
    expect(existsSync(bootstrapSourcePath)).toBe(true);

    const { createPackageLocalRuntimeBootstrap } = await import(bootstrapModulePath);
    const hooks = {
      [HookEvent.UserPromptSubmit]: [vi.fn()],
    };
    const sessionStore = {
      createSession: async () => undefined,
      loadSession: async () => true,
      loadMessages: async () => [],
      appendMessage: () => undefined,
      forkState: async () => null,
      writeForkState: async () => null,
    };
    const options: SessionOptions = {
      provider: {
        type: 'openai-compatible',
        apiKey: 'test-key',
      },
      model: 'model-a',
      storagePath: '/workspace/.blade/sessions',
      hooks,
    };
    const bladeConfig: BladeConfig = {
      models: [],
      currentModelId: 'default',
      permissions: {
        allow: [],
        deny: [],
      },
    };
    const defaultContext: RuntimeContext = {
      capabilities: {
        filesystem: {
          roots: ['/workspace'],
          cwd: '/workspace/project',
        },
      },
    };

    const bootstrap = createPackageLocalRuntimeBootstrap({
      sessionId: 'session-1',
      options,
      bladeConfig,
      defaultContext,
      sessionStore,
    });

    expect(bootstrap.initialState).toEqual({
      storageRoot: '/workspace/.blade',
      projectPath: '/workspace/project',
      hookCallbacks: hooks,
    });
    expect(bootstrap.ports.sessionStore).toBe(sessionStore);
    await expect(bootstrap.ports.mcpRegistry.getCapabilities()).resolves.toEqual([]);
  });
});
