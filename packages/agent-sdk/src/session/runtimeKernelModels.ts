import type { ModelPort } from '@blade-ai/ai';
import type { AgentModelRequestDefaults } from '@blade-ai/agent/kernel';
import type { BladeConfig } from '../types/common.js';

export interface PackageLocalRuntimeKernelModelOptions {
  model?: ModelPort;
  modelId?: string;
  modelRequestDefaults?: AgentModelRequestDefaults;
}

export interface PackageLocalRuntimeResolvedKernelModel {
  model: ModelPort;
  modelRequestDefaults?: AgentModelRequestDefaults;
}

export interface PackageLocalRuntimeKernelModelResolveOptions {
  bladeConfig: BladeConfig;
  modelId?: string;
}

export interface PackageLocalRuntimeKernelModelResolverPort {
  resolve(
    options: PackageLocalRuntimeKernelModelResolveOptions,
  ): PackageLocalRuntimeResolvedKernelModel;
}

export interface PackageLocalRuntimeKernelModelResolutionOptions {
  options: PackageLocalRuntimeKernelModelOptions;
  bladeConfig: BladeConfig;
  kernelModelResolver: PackageLocalRuntimeKernelModelResolverPort;
}

export function resolvePackageLocalRuntimeKernelModel(
  resolution: PackageLocalRuntimeKernelModelResolutionOptions,
): PackageLocalRuntimeResolvedKernelModel {
  if (resolution.options.model) {
    return {
      model: resolution.options.model,
      ...(resolution.options.modelRequestDefaults
        ? { modelRequestDefaults: resolution.options.modelRequestDefaults }
        : {}),
    };
  }

  return resolution.kernelModelResolver.resolve({
    bladeConfig: resolution.bladeConfig,
    modelId: resolution.options.modelId,
  });
}
