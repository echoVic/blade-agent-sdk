import type { ModelPort } from '@blade-ai/ai';
import type { AgentHookPort, AgentToolPort } from '@blade-ai/agent/ports';
import type { AgentStorePort } from '@blade-ai/agent/state';
import type { AgentTracePort } from '@blade-ai/agent/tracing';
import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { TraceRecorder } from '../observability/TraceRecorder.js';
import type { PackageLocalRuntimeAgentKernelFactoryPort } from '../session/runtimeAgentKernels.js';
import type { PackageLocalRuntimeKernelModelResolverPort } from '../session/runtimeKernelModels.js';
import type { PackageLocalRuntimeKernelPortFactoryPort } from '../session/runtimeKernelPorts.js';
import type { BladeConfig } from '../types/common.js';

const runtimeKernelModulePath = '../session/runtimeKernel.js';
const runtimeKernelSourcePath = 'src/session/runtimeKernel.ts';

const modelPort: ModelPort = {
  async generate() {
    return { content: 'ok' };
  },
  async *stream() {},
};

const storePort: AgentStorePort = {
  appendMessage: vi.fn(),
};

const hookPort: AgentHookPort = {};

const tracePort: AgentTracePort = {
  record: vi.fn(),
};

const toolPort: AgentToolPort = {
  async list() {
    return [];
  },
  async execute(toolCall) {
    return {
      id: toolCall.id,
      name: toolCall.name,
      output: '',
    };
  },
};

describe('agent-sdk package-local runtime kernel operations', () => {
  it('bundles kernel port and agent kernel operations behind injected ports', async () => {
    expect(existsSync(runtimeKernelSourcePath)).toBe(true);

    const { createPackageLocalRuntimeKernelOperations } = await import(runtimeKernelModulePath);
    const kernel = {
      async *runTurn() {},
    };
    const bladeConfig: BladeConfig = {
      models: [],
      currentModelId: 'primary',
    };
    const kernelFactory: PackageLocalRuntimeAgentKernelFactoryPort = {
      create: vi.fn(() => kernel),
    };
    const kernelModelResolver: PackageLocalRuntimeKernelModelResolverPort = {
      resolve: vi.fn(() => ({
        model: modelPort,
        modelRequestDefaults: {
          model: 'glm-5.2',
          maxContextTokens: 8192,
        },
      })),
    };
    const kernelPortFactory: PackageLocalRuntimeKernelPortFactoryPort = {
      createToolPort: vi.fn(() => toolPort),
      createStorePort: vi.fn(() => storePort),
      createTracePort: vi.fn(() => tracePort),
      createHookPort: vi.fn(() => hookPort),
    };
    const toolCatalog = { registerAll: vi.fn() };
    const executionPipeline = { id: 'pipeline' };
    const createExecutionPipeline = vi.fn(() => executionPipeline);
    const sessionStore = { appendMessage: vi.fn() };
    const hookRuntime = { run: vi.fn() };
    const traceRecorder = { startSpan: vi.fn() } as unknown as TraceRecorder;
    const createExecutionContext = vi.fn();

    const operations = createPackageLocalRuntimeKernelOperations({
      bladeConfig,
      kernelModelResolver,
      kernelFactory,
      kernelPortFactory,
      toolCatalog,
      createExecutionPipeline,
      sessionId: 'session-1',
      sessionStore,
      hookRuntime,
    });

    expect(operations.ports.createStorePort()).toBe(storePort);
    expect(operations.ports.createHookPort()).toBe(hookPort);
    expect(operations.ports.createTracePort(traceRecorder, 4096)).toBe(tracePort);
    expect(createExecutionPipeline).not.toHaveBeenCalled();

    expect(
      operations.agentKernel.createFromOptions({
        modelId: 'secondary',
        traceRecorder,
        createExecutionContext,
        maxSteps: 5,
      }),
    ).toBe(kernel);

    expect(createExecutionPipeline).toHaveBeenCalledOnce();
    expect(kernelModelResolver.resolve).toHaveBeenCalledWith({
      bladeConfig,
      modelId: 'secondary',
    });
    expect(kernelPortFactory.createStorePort).toHaveBeenCalledWith({
      sessionId: 'session-1',
      sessionStore,
    });
    expect(kernelPortFactory.createHookPort).toHaveBeenCalledWith({ hookRuntime });
    expect(kernelPortFactory.createTracePort).toHaveBeenLastCalledWith({
      recorder: traceRecorder,
      maxContextTokens: 8192,
    });
    expect(kernelPortFactory.createToolPort).toHaveBeenCalledWith({
      toolCatalog,
      executionPipeline,
      createExecutionContext,
    });
    expect(kernelFactory.create).toHaveBeenCalledWith({
      model: modelPort,
      modelRequestDefaults: {
        model: 'glm-5.2',
        maxContextTokens: 8192,
      },
      store: storePort,
      hooks: hookPort,
      trace: tracePort,
      tools: toolPort,
      maxSteps: 5,
    });
  });
});
