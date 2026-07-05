import { createLegacyStreamTurnBridge, type LegacyStreamBridgeDriver } from './legacyStreamBridge.js';
import {
  createPackageLocalSessionRuntimeFactory,
  type PackageLocalSessionRuntimeContext,
} from './packageLocalRuntimeFactory.js';
import type { SessionRuntimeFactory } from './factory.js';
import type { SessionId } from './types.js';

export interface PackageLocalLegacySessionRuntimeFactoryOptions {
  createSessionId: () => SessionId;
  createTurnId: () => string;
  createDriver: (context: PackageLocalSessionRuntimeContext) => LegacyStreamBridgeDriver;
  cleanup?: (context: PackageLocalSessionRuntimeContext) => Promise<void> | void;
}

export function createPackageLocalLegacySessionRuntimeFactory(
  options: PackageLocalLegacySessionRuntimeFactoryOptions,
): SessionRuntimeFactory {
  return createPackageLocalSessionRuntimeFactory({
    createSessionId: options.createSessionId,
    createTurnId: options.createTurnId,
    cleanup: options.cleanup,
    createStreamTurn(context) {
      return createLegacyStreamTurnBridge({
        context: {
          sessionId: context.sessionId,
          options: context.options,
        },
        driver: options.createDriver(context),
      });
    },
  });
}
