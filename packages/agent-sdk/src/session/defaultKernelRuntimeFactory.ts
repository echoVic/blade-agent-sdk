import { nanoid } from 'nanoid';
import { buildBladeConfig } from './config.js';
import { createPackageLocalKernelSessionRuntimeFactory } from './packageLocalKernelRuntimeFactory.js';
import {
  PackageLocalSessionRuntime,
  type PackageLocalSessionRuntimeOptions,
} from './runtimeInstance.js';
import type { SessionRuntimeFactory } from './factory.js';
import type { SessionId } from './types.js';
import type { PackageLocalSessionRuntimeContext } from './packageLocalRuntimeFactory.js';

export type DefaultKernelRuntimePorts = Omit<
  PackageLocalSessionRuntimeOptions,
  'sessionId' | 'options' | 'bladeConfig' | 'defaultContext'
>;

export interface DefaultKernelSessionRuntimeFactoryOptions {
  createSessionId?: () => SessionId;
  createTurnId?: () => string;
  runtime?:
    | DefaultKernelRuntimePorts
    | ((context: PackageLocalSessionRuntimeContext) => DefaultKernelRuntimePorts);
}

function resolveRuntimePorts(
  runtime: DefaultKernelSessionRuntimeFactoryOptions['runtime'],
  context: PackageLocalSessionRuntimeContext,
): DefaultKernelRuntimePorts {
  return typeof runtime === 'function' ? runtime(context) : (runtime ?? {});
}

export function createDefaultKernelSessionRuntimeFactory(
  options: DefaultKernelSessionRuntimeFactoryOptions = {},
): SessionRuntimeFactory {
  const runtimes = new WeakMap<PackageLocalSessionRuntimeContext, PackageLocalSessionRuntime>();

  return createPackageLocalKernelSessionRuntimeFactory({
    createSessionId: options.createSessionId ?? nanoid,
    createTurnId: options.createTurnId ?? nanoid,
    createRuntime(context) {
      const runtime = new PackageLocalSessionRuntime({
        sessionId: context.sessionId,
        options: context.options,
        bladeConfig: buildBladeConfig(context.options),
        defaultContext: context.options.defaultContext ?? {},
        ...resolveRuntimePorts(options.runtime, context),
      });
      runtimes.set(context, runtime);
      return runtime;
    },
    async cleanup(context) {
      await runtimes.get(context)?.close();
      runtimes.delete(context);
    },
  });
}
