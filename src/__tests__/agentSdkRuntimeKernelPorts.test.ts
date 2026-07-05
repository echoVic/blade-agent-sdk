import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const kernelPortsModulePath = '../../packages/agent-sdk/src/session/runtimeKernelPorts.js';
const kernelPortsSourcePath = 'packages/agent-sdk/src/session/runtimeKernelPorts.ts';

describe('agent-sdk package-local runtime kernel port helpers', () => {
  it('creates kernel ports through a package-local factory without runtime state', async () => {
    expect(existsSync(kernelPortsSourcePath)).toBe(true);

    const {
      createPackageLocalRuntimeKernelHookPort,
      createPackageLocalRuntimeKernelStorePort,
      createPackageLocalRuntimeKernelToolPort,
      createPackageLocalRuntimeKernelTracePort,
    } = await import(kernelPortsModulePath);
    const toolPort = { type: 'tool-port' };
    const storePort = { type: 'store-port' };
    const tracePort = { type: 'trace-port' };
    const hookPort = { type: 'hook-port' };
    const factory = {
      createToolPort: vi.fn(() => toolPort),
      createStorePort: vi.fn(() => storePort),
      createTracePort: vi.fn(() => tracePort),
      createHookPort: vi.fn(() => hookPort),
    };
    const toolCatalog = { registerAll: vi.fn() };
    const executionPipeline = { id: 'pipeline' };
    const createExecutionContext = vi.fn(() => ({}));
    const sessionStore = { loadMessages: vi.fn() };
    const recorder = { startSpan: vi.fn() };
    const hookRuntime = { enable: vi.fn() };

    expect(
      createPackageLocalRuntimeKernelToolPort({
        kernelPortFactory: factory,
        toolCatalog,
        executionPipeline,
        createExecutionContext,
      }),
    ).toBe(toolPort);
    expect(
      createPackageLocalRuntimeKernelStorePort({
        kernelPortFactory: factory,
        sessionId: 'session-1',
        sessionStore,
      }),
    ).toBe(storePort);
    expect(
      createPackageLocalRuntimeKernelTracePort({
        kernelPortFactory: factory,
        recorder,
        maxContextTokens: 4096,
      }),
    ).toBe(tracePort);
    expect(
      createPackageLocalRuntimeKernelHookPort({
        kernelPortFactory: factory,
        hookRuntime,
      }),
    ).toBe(hookPort);

    expect(factory.createToolPort).toHaveBeenCalledWith({
      toolCatalog,
      executionPipeline,
      createExecutionContext,
    });
    expect(factory.createStorePort).toHaveBeenCalledWith({
      sessionId: 'session-1',
      sessionStore,
    });
    expect(factory.createTracePort).toHaveBeenCalledWith({
      recorder,
      maxContextTokens: 4096,
    });
    expect(factory.createHookPort).toHaveBeenCalledWith({ hookRuntime });
  });
});
