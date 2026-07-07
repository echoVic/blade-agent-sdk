import type { ModelPort } from '@blade-ai/ai';
import type { AgentModelRequestDefaults } from '@blade-ai/agent';
import { describe, expect, it, vi } from 'vitest';
import { resolvePackageLocalRuntimeKernelModel } from '../session/runtimeKernelModels.js';
import type { PackageLocalRuntimeKernelModelResolverPort } from '../session/runtimeKernelModels.js';
import type { BladeConfig } from '../types/common.js';

const modelPort: ModelPort = {
  async generate() {
    return { content: 'ok' };
  },
  async *stream() {},
};

const resolverModelPort: ModelPort = {
  async generate() {
    return { content: 'resolved' };
  },
  async *stream() {},
};

const bladeConfig: BladeConfig = {
  currentModelId: 'primary',
  temperature: 0.7,
  models: [
    {
      id: 'primary',
      name: 'Primary',
      provider: 'openai-compatible',
      model: 'glm-5.2',
      apiKey: 'test-key',
    },
  ],
};

describe('agent-sdk package-local runtime kernel model helpers', () => {
  it('uses an injected model and request defaults without calling the resolver', () => {
    const modelRequestDefaults: AgentModelRequestDefaults = {
      model: 'injected',
      temperature: 0.2,
      maxOutputTokens: 1024,
    };
    const resolver: PackageLocalRuntimeKernelModelResolverPort = {
      resolve: vi.fn(() => {
        throw new Error('resolver should not be called');
      }),
    };

    const resolved = resolvePackageLocalRuntimeKernelModel({
      options: {
        model: modelPort,
        modelRequestDefaults,
      },
      bladeConfig,
      kernelModelResolver: resolver,
    });

    expect(resolved).toEqual({
      model: modelPort,
      modelRequestDefaults,
    });
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('resolves a configured model when no model is injected', () => {
    const resolverResult = {
      model: resolverModelPort,
      modelRequestDefaults: {
        model: 'glm-5.2',
        maxContextTokens: 128000,
      },
    };
    const resolver: PackageLocalRuntimeKernelModelResolverPort = {
      resolve: vi.fn(() => resolverResult),
    };

    const resolved = resolvePackageLocalRuntimeKernelModel({
      options: {
        modelId: 'primary',
      },
      bladeConfig,
      kernelModelResolver: resolver,
    });

    expect(resolved).toBe(resolverResult);
    expect(resolver.resolve).toHaveBeenCalledWith({
      bladeConfig,
      modelId: 'primary',
    });
  });
});
