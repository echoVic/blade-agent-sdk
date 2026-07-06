import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const noopModulePath = '../../packages/agent-sdk/src/session/runtimeNoopPorts.js';
const noopSourcePath = 'packages/agent-sdk/src/session/runtimeNoopPorts.ts';

describe('agent-sdk package-local runtime noop ports', () => {
  it('provides inert default ports outside the session runtime class', async () => {
    expect(existsSync(noopSourcePath)).toBe(true);

    const { createPackageLocalRuntimeNoopPorts } = await import(noopModulePath);
    const ports = createPackageLocalRuntimeNoopPorts();

    await expect(ports.sessionStore.loadSession('missing-session')).resolves.toBe(false);
    await expect(ports.sessionStore.loadMessages('missing-session')).resolves.toEqual([]);
    await expect(ports.mcpRegistry.getCapabilities()).resolves.toEqual([]);

    const toolPort = ports.kernelPortFactory.createToolPort({
      toolCatalog: ports.toolCatalog,
      executionPipeline: undefined,
      createExecutionContext: () => ({}) as never,
    });

    await expect(toolPort.list()).resolves.toEqual([]);
    await expect(
      toolPort.execute({
        id: 'call-1',
        name: 'missing',
        input: {},
      }),
    ).resolves.toEqual({
      id: 'call-1',
      name: 'missing',
      output: '',
      isError: true,
    });

    expect(() => ports.kernelFactory.create({ model: {} as never }).runTurn({} as never)).toThrow(
      'Package-local agent kernel factory port is required to run a turn',
    );
    expect(() =>
      ports.kernelModelResolver.resolve({
        bladeConfig: {} as never,
      }),
    ).toThrow('Package-local kernel model resolver port is required to create a kernel');
  });

  it('resolves injected runtime ports with noop fallbacks outside the runtime class', async () => {
    const { resolvePackageLocalRuntimePorts } = await import(noopModulePath);
    const injectedSessionStore = {
      createSession: async () => undefined,
      loadSession: async () => true,
      loadMessages: async () => [],
      appendMessage: () => undefined,
      forkState: async () => null,
      writeForkState: async () => null,
    };
    const injectedHookRuntime = {
      enable() {},
      setTraceCollector() {},
    };

    const ports = resolvePackageLocalRuntimePorts({
      sessionStore: injectedSessionStore,
      hookRuntime: injectedHookRuntime,
    });

    expect(ports.sessionStore).toBe(injectedSessionStore);
    expect(ports.hookRuntime).toBe(injectedHookRuntime);
    expect(ports.hookManager).toBe(injectedHookRuntime);
    await expect(ports.mcpRegistry.getCapabilities()).resolves.toEqual([]);
  });
});
