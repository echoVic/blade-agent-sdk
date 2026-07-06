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
  projectPackageLocalRuntimeAgentKernelPorts,
} from '../../packages/agent-sdk/src/session/runtimeAgentKernels.js';
import type {
  PackageLocalRuntimeAgentKernelFactoryPort,
  PackageLocalRuntimeResolvedKernelModel,
} from '../../packages/agent-sdk/src/session/runtimeAgentKernels.js';
import type { TraceRecorder } from '../../packages/agent-sdk/src/observability/TraceRecorder.js';

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

    const created = createPackageLocalRuntimeAgentKernel({
      options: {
        maxSteps: 7,
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
});
