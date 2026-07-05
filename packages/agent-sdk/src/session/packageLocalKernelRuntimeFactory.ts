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
  createRuntime: (context: PackageLocalSessionRuntimeContext) => PackageLocalKernelSessionRuntime;
  cleanup?: (context: PackageLocalSessionRuntimeContext) => Promise<void> | void;
}

export interface PackageLocalKernelSessionRuntime extends KernelStreamBridgeRuntime {
  ensureSessionCreated?: () => Promise<void> | void;
  ensureSessionLoaded?: () => Promise<void> | void;
}

export function createPackageLocalKernelSessionRuntimeFactory(
  options: PackageLocalKernelSessionRuntimeFactoryOptions,
): SessionRuntimeFactory {
  const runtimes = new WeakMap<PackageLocalSessionRuntimeContext, PackageLocalKernelSessionRuntime>();

  function getRuntime(context: PackageLocalSessionRuntimeContext): PackageLocalKernelSessionRuntime {
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
    async initialize(context) {
      const runtime = getRuntime(context);
      if (context.isResume) {
        await runtime.ensureSessionLoaded?.();
        return;
      }
      await runtime.ensureSessionCreated?.();
    },
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
