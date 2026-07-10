import { AgentKernel } from '@blade-ai/agent/kernel';
import type { PackageLocalRuntimeAgentKernelFactoryPort } from './runtimeAgentKernels.js';

export function createPackageLocalAgentKernelFactory(): PackageLocalRuntimeAgentKernelFactoryPort {
  return {
    create(options) {
      return new AgentKernel(options);
    },
  };
}
