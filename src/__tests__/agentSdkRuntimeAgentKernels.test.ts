import type { ModelPort } from '@blade-ai/ai';
import type {
  AgentHookPort,
  AgentStorePort,
  AgentToolPort,
  AgentTracePort,
} from '@blade-ai/agent';
import { describe, expect, it, vi } from 'vitest';
import {
  createPackageLocalRuntimeAgentKernel,
  createPackageLocalRuntimeAgentKernelFromResolved,
  createPackageLocalRuntimeAgentKernelFromOptions,
  createPackageLocalRuntimeAgentKernelOperations,
  createPackageLocalRuntimeResolvedAgentKernelCreator,
  projectPackageLocalRuntimeAgentKernelPorts,
} from '../../packages/agent-sdk/src/session/runtimeAgentKernels.js';
import type {
  PackageLocalRuntimeAgentKernelFactoryPort,
  PackageLocalRuntimeResolvedKernelModel,
} from '../../packages/agent-sdk/src/session/runtimeAgentKernels.js';
import type { PackageLocalRuntimeKernelModelResolverPort } from '../../packages/agent-sdk/src/session/runtimeKernelModels.js';
import type { TraceRecorder } from '../../packages/agent-sdk/src/observability/TraceRecorder.js';
import type { BladeConfig } from '../../packages/agent-sdk/src/types/common.js';

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

describe('agent-sdk package-local runtime agent kernel helpers', () => {
  it('creates a minimal agent kernel from the resolved model and required ports', () => {
    const kernel = {
      async *runTurn() {},
    };
    const kernelFactory: PackageLocalRuntimeAgentKernelFactoryPort = {
      create: vi.fn(() => kernel),
    };

    const created = createPackageLocalRuntimeAgentKernel({
      options: {},
      kernelModel: {
        model: modelPort,
      },
      kernelFactory,
      ports: {
        store: storePort,
        hooks: hookPort,
      },
    });

    expect(created).toBe(kernel);
    expect(kernelFactory.create).toHaveBeenCalledWith({
      model: modelPort,
      store: storePort,
      hooks: hookPort,
    });
  });

  it('forwards optional model defaults, trace, tools, and max steps', () => {
    const kernel = {
      async *runTurn() {},
    };
    const kernelFactory: PackageLocalRuntimeAgentKernelFactoryPort = {
      create: vi.fn(() => kernel),
    };
    const kernelModel: PackageLocalRuntimeResolvedKernelModel = {
      model: modelPort,
      modelRequestDefaults: {
        model: 'glm-5.2',
        temperature: 0.2,
        maxContextTokens: 128000,
      },
    };
    const tokenBudget = {
      record: vi.fn(),
      isWarning: vi.fn(() => false),
      isApproachingLimit: vi.fn(() => false),
      isExhausted: vi.fn(() => false),
      getSnapshot: vi.fn(),
    };

    const created = createPackageLocalRuntimeAgentKernel({
      options: {
        maxSteps: 7,
        tokenBudget,
      },
      kernelModel,
      kernelFactory,
      ports: {
        store: storePort,
        hooks: hookPort,
        trace: tracePort,
        tools: toolPort,
      },
    });

    expect(created).toBe(kernel);
    expect(kernelFactory.create).toHaveBeenCalledWith({
      model: modelPort,
      modelRequestDefaults: {
        model: 'glm-5.2',
        temperature: 0.2,
        maxContextTokens: 128000,
      },
      store: storePort,
      hooks: hookPort,
      trace: tracePort,
      tools: toolPort,
      tokenBudget,
      maxSteps: 7,
    });
  });

  it('projects required and optional kernel ports without runtime state', () => {
    const getStorePort = vi.fn(() => storePort);
    const getHookPort = vi.fn(() => hookPort);
    const getTracePort = vi.fn(() => tracePort);
    const getToolPort = vi.fn(() => toolPort);
    const createExecutionContext = vi.fn();
    const traceRecorder = { startSpan: vi.fn() } as unknown as TraceRecorder;
    const kernelModel: PackageLocalRuntimeResolvedKernelModel = {
      model: modelPort,
      modelRequestDefaults: {
        maxContextTokens: 4096,
      },
    };

    expect(
      projectPackageLocalRuntimeAgentKernelPorts({
        options: {},
        kernelModel,
        getStorePort,
        getHookPort,
        getTracePort,
        getToolPort,
      }),
    ).toEqual({
      store: storePort,
      hooks: hookPort,
    });

    expect(
      projectPackageLocalRuntimeAgentKernelPorts({
        options: {
          traceRecorder,
          createExecutionContext,
        },
        kernelModel,
        getStorePort,
        getHookPort,
        getTracePort,
        getToolPort,
      }),
    ).toEqual({
      store: storePort,
      hooks: hookPort,
      trace: tracePort,
      tools: toolPort,
    });

    expect(getTracePort).toHaveBeenCalledWith(traceRecorder, 4096);
    expect(getToolPort).toHaveBeenCalledWith(createExecutionContext);
  });

  it('creates a resolved agent kernel through projected ports without runtime state', () => {
    const kernel = {
      async *runTurn() {},
    };
    const kernelFactory: PackageLocalRuntimeAgentKernelFactoryPort = {
      create: vi.fn(() => kernel),
    };
    const getStorePort = vi.fn(() => storePort);
    const getHookPort = vi.fn(() => hookPort);
    const getTracePort = vi.fn(() => tracePort);
    const getToolPort = vi.fn(() => toolPort);
    const createExecutionContext = vi.fn();
    const traceRecorder = { startSpan: vi.fn() } as unknown as TraceRecorder;
    const kernelModel: PackageLocalRuntimeResolvedKernelModel = {
      model: modelPort,
      modelRequestDefaults: {
        model: 'glm-5.2',
        maxContextTokens: 8192,
      },
    };

    const created = createPackageLocalRuntimeAgentKernelFromResolved({
      options: {
        traceRecorder,
        createExecutionContext,
        maxSteps: 5,
      },
      kernelModel,
      kernelFactory,
      getStorePort,
      getHookPort,
      getTracePort,
      getToolPort,
    });

    expect(created).toBe(kernel);
    expect(getTracePort).toHaveBeenCalledWith(traceRecorder, 8192);
    expect(getToolPort).toHaveBeenCalledWith(createExecutionContext);
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

  it('resolves kernel models before creating agent kernels without runtime state', () => {
    const kernel = {
      async *runTurn() {},
    };
    const kernelFactory: PackageLocalRuntimeAgentKernelFactoryPort = {
      create: vi.fn(() => kernel),
    };
    const bladeConfig: BladeConfig = {
      models: [],
      currentModelId: 'primary',
    };
    const resolvedKernelModel: PackageLocalRuntimeResolvedKernelModel = {
      model: modelPort,
      modelRequestDefaults: {
        model: 'glm-5.2',
        maxContextTokens: 16384,
      },
    };
    const kernelModelResolver: PackageLocalRuntimeKernelModelResolverPort = {
      resolve: vi.fn(() => resolvedKernelModel),
    };
    const getStorePort = vi.fn(() => storePort);
    const getHookPort = vi.fn(() => hookPort);
    const getTracePort = vi.fn(() => tracePort);
    const getToolPort = vi.fn(() => toolPort);
    const createExecutionContext = vi.fn();
    const traceRecorder = { startSpan: vi.fn() } as unknown as TraceRecorder;

    const created = createPackageLocalRuntimeAgentKernelFromOptions({
      options: {
        modelId: 'secondary',
        traceRecorder,
        createExecutionContext,
        maxSteps: 9,
      },
      bladeConfig,
      kernelModelResolver,
      kernelFactory,
      getStorePort,
      getHookPort,
      getTracePort,
      getToolPort,
    });

    expect(created).toBe(kernel);
    expect(kernelModelResolver.resolve).toHaveBeenCalledWith({
      bladeConfig,
      modelId: 'secondary',
    });
    expect(getTracePort).toHaveBeenCalledWith(traceRecorder, 16384);
    expect(getToolPort).toHaveBeenCalledWith(createExecutionContext);
    expect(kernelFactory.create).toHaveBeenCalledWith({
      model: modelPort,
      modelRequestDefaults: {
        model: 'glm-5.2',
        maxContextTokens: 16384,
      },
      store: storePort,
      hooks: hookPort,
      trace: tracePort,
      tools: toolPort,
      maxSteps: 9,
    });
  });

  it('creates a reusable resolved kernel creator without runtime state', () => {
    const kernel = {
      async *runTurn() {},
    };
    const kernelFactory: PackageLocalRuntimeAgentKernelFactoryPort = {
      create: vi.fn(() => kernel),
    };
    const getStorePort = vi.fn(() => storePort);
    const getHookPort = vi.fn(() => hookPort);
    const getTracePort = vi.fn(() => tracePort);
    const getToolPort = vi.fn(() => toolPort);
    const createExecutionContext = vi.fn();
    const traceRecorder = { startSpan: vi.fn() } as unknown as TraceRecorder;
    const kernelModel: PackageLocalRuntimeResolvedKernelModel = {
      model: modelPort,
      modelRequestDefaults: {
        model: 'glm-5.2',
        maxContextTokens: 32768,
      },
    };

    const createResolvedKernel = createPackageLocalRuntimeResolvedAgentKernelCreator({
      kernelFactory,
      getStorePort,
      getHookPort,
      getTracePort,
      getToolPort,
    });

    const created = createResolvedKernel(
      {
        traceRecorder,
        createExecutionContext,
        maxSteps: 3,
      },
      kernelModel,
    );

    expect(created).toBe(kernel);
    expect(getTracePort).toHaveBeenCalledWith(traceRecorder, 32768);
    expect(getToolPort).toHaveBeenCalledWith(createExecutionContext);
    expect(kernelFactory.create).toHaveBeenCalledWith({
      model: modelPort,
      modelRequestDefaults: {
        model: 'glm-5.2',
        maxContextTokens: 32768,
      },
      store: storePort,
      hooks: hookPort,
      trace: tracePort,
      tools: toolPort,
      maxSteps: 3,
    });
  });

  it('creates options-level and resolved kernel operations from shared ports', () => {
    const kernel = {
      async *runTurn() {},
    };
    const kernelFactory: PackageLocalRuntimeAgentKernelFactoryPort = {
      create: vi.fn(() => kernel),
    };
    const bladeConfig: BladeConfig = {
      models: [],
      currentModelId: 'primary',
    };
    const resolvedKernelModel: PackageLocalRuntimeResolvedKernelModel = {
      model: modelPort,
      modelRequestDefaults: {
        model: 'glm-5.2',
        maxContextTokens: 65536,
      },
    };
    const kernelModelResolver: PackageLocalRuntimeKernelModelResolverPort = {
      resolve: vi.fn(() => resolvedKernelModel),
    };
    const getStorePort = vi.fn(() => storePort);
    const getHookPort = vi.fn(() => hookPort);
    const getTracePort = vi.fn(() => tracePort);
    const getToolPort = vi.fn(() => toolPort);
    const createExecutionContext = vi.fn();
    const traceRecorder = { startSpan: vi.fn() } as unknown as TraceRecorder;

    const operations = createPackageLocalRuntimeAgentKernelOperations({
      bladeConfig,
      kernelModelResolver,
      kernelFactory,
      getStorePort,
      getHookPort,
      getTracePort,
      getToolPort,
    });

    expect(
      operations.createFromOptions({
        modelId: 'secondary',
        maxSteps: 4,
      }),
    ).toBe(kernel);
    expect(kernelModelResolver.resolve).toHaveBeenCalledWith({
      bladeConfig,
      modelId: 'secondary',
    });

    expect(
      operations.createFromResolved(
        {
          traceRecorder,
          createExecutionContext,
          maxSteps: 6,
        },
        resolvedKernelModel,
      ),
    ).toBe(kernel);

    expect(getTracePort).toHaveBeenCalledWith(traceRecorder, 65536);
    expect(getToolPort).toHaveBeenCalledWith(createExecutionContext);
    expect(kernelFactory.create).toHaveBeenLastCalledWith({
      model: modelPort,
      modelRequestDefaults: {
        model: 'glm-5.2',
        maxContextTokens: 65536,
      },
      store: storePort,
      hooks: hookPort,
      trace: tracePort,
      tools: toolPort,
      maxSteps: 6,
    });
  });
});
