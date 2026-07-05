import { createKernelStreamTurnBridge, type KernelStreamBridgeRuntime } from './kernelStreamBridge.js';
import {
  createPackageLocalSessionRuntimeFactory,
  type PackageLocalSessionRuntimeContext,
} from './packageLocalRuntimeFactory.js';
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
  return createPackageLocalSessionRuntimeFactory({
    createSessionId: options.createSessionId,
    createTurnId: options.createTurnId,
    cleanup: options.cleanup,
    createStreamTurn(context) {
      return createKernelStreamTurnBridge({
        context: {
          sessionId: context.sessionId,
          options: context.options,
        },
        runtime: options.createRuntime(context),
      });
    },
  });
}
