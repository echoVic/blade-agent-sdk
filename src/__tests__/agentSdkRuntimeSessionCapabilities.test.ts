import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const runtimeSessionCapabilitiesModulePath =
  '../../packages/agent-sdk/src/session/runtimeSessionCapabilities.js';
const runtimeSessionCapabilitiesSourcePath =
  'packages/agent-sdk/src/session/runtimeSessionCapabilities.ts';

describe('agent-sdk package-local runtime session capability operations', () => {
  it('bundles subagent initialization and session forking around session options', async () => {
    expect(existsSync(runtimeSessionCapabilitiesSourcePath)).toBe(true);

    const { createPackageLocalRuntimeSessionCapabilityOperations } = await import(
      runtimeSessionCapabilitiesModulePath
    );
    const registry = {
      setLogger: vi.fn(),
      setProjectDir: vi.fn(),
      loadFromStandardLocations: vi.fn(),
      register: vi.fn(),
    };
    const logger = { warn: vi.fn() };
    const snapshot = {
      sessionId: 'session-1',
      messages: [],
      metadata: {},
    };
    const materializedSnapshot = {
      ...snapshot,
      sessionId: 'fork-1',
    };
    const forkedSession = { id: 'fork-1' };
    const sessionStore = {
      forkState: vi.fn(async () => snapshot),
      writeForkState: vi.fn(async () => materializedSnapshot),
    };
    const createForkSessionId = vi.fn(() => 'fork-1');
    const createForkSession = vi.fn(async () => forkedSession);
    const options = {
      provider: {
        type: 'openai-compatible' as const,
      },
      agents: {
        reviewer: {
          name: 'reviewer',
          description: 'Reviews code',
          systemPrompt: 'Review carefully',
          allowedTools: ['read'],
        },
      },
    };

    const operations = createPackageLocalRuntimeSessionCapabilityOperations({
      sessionId: 'session-1',
      options,
      sessionStore,
      createForkSessionId,
      createForkSession,
      subagentRegistry: registry,
      logger,
      projectPath: '/workspace/project',
      storageRoot: '/workspace/.blade',
    });

    operations.subagents.initialize();
    const result = await operations.fork.fork({ fromMessageId: 'message-1' });

    expect(registry.setLogger).toHaveBeenCalledWith(logger);
    expect(registry.setProjectDir).toHaveBeenCalledWith('/workspace/project');
    expect(registry.loadFromStandardLocations).toHaveBeenCalledWith(
      '/workspace/project',
      '/workspace/.blade',
    );
    expect(registry.register).toHaveBeenCalledWith(
      {
        name: 'reviewer',
        description: 'Reviews code',
        systemPrompt: 'Review carefully',
        tools: ['read'],
        model: 'inherit',
        source: 'session',
      },
      { override: true },
    );
    expect(sessionStore.forkState).toHaveBeenCalledWith('session-1', {
      fromMessageId: 'message-1',
    });
    expect(sessionStore.writeForkState).toHaveBeenCalledWith('fork-1', snapshot);
    expect(createForkSession).toHaveBeenCalledWith('fork-1', options);
    expect(result).toBe(forkedSession);
  });
});
