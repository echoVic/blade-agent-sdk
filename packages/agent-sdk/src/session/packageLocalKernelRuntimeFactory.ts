import { createKernelStreamTurnBridge, type KernelStreamBridgeRuntime } from './kernelStreamBridge.js';
import {
  createPackageLocalSessionRuntimeFactory,
  type PackageLocalSessionRuntimeContext,
} from './packageLocalRuntimeFactory.js';
import type { PackageLocalSessionRuntimePort } from './sessionInstance.js';
import type { SessionRuntimeFactory } from './factory.js';
import type { SessionId } from './types.js';

export interface PackageLocalKernelSessionRuntimeFactoryOptions {
  createSessionId: () => SessionId;
  createTurnId: () => string;
  createRuntime: (context: PackageLocalSessionRuntimeContext) => KernelStreamBridgeRuntime;
  cleanup?: (context: PackageLocalSessionRuntimeContext) => Promise<void> | void;
}

export function createPackageLocalKernelSessionRuntimeFactory(
  options: PackageLocalKernelSessionRuntimeFactoryOptions,
): SessionRuntimeFactory {
  const runtimes = new WeakMap<PackageLocalSessionRuntimeContext, KernelStreamBridgeRuntime>();

  function getRuntime(context: PackageLocalSessionRuntimeContext): KernelStreamBridgeRuntime {
    const existing = runtimes.get(context);
    if (existing) {
      return existing;
    }
    const runtime = options.createRuntime(context);
    runtimes.set(context, runtime);
    return runtime;
  }

  return createPackageLocalSessionRuntimeFactory({
    createSessionId: options.createSessionId,
    createTurnId: options.createTurnId,
    async cleanup(context) {
      await options.cleanup?.(context);
      runtimes.delete(context);
    },
    createSessionRuntimePort(context) {
      return getRuntime(context) as KernelStreamBridgeRuntime & PackageLocalSessionRuntimePort;
    },
    createStreamTurn(context) {
      return createKernelStreamTurnBridge({
        context: {
          sessionId: context.sessionId,
          options: context.options,
        },
        runtime: getRuntime(context),
      });
    },
  });
}
