import { nanoid } from 'nanoid';
import { buildBladeConfig } from './config.js';
import { createPackageLocalAgentKernelFactory } from './kernelFactory.js';
import { createPackageLocalKernelModelResolver } from './kernelModelResolver.js';
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
  const defaultKernelFactory = createPackageLocalAgentKernelFactory();
  const defaultKernelModelResolver = createPackageLocalKernelModelResolver();

  return createPackageLocalKernelSessionRuntimeFactory({
    createSessionId: options.createSessionId ?? nanoid,
    createTurnId: options.createTurnId ?? nanoid,
    createRuntime(context) {
      const runtimePorts = resolveRuntimePorts(options.runtime, context);
      const runtime = new PackageLocalSessionRuntime({
        sessionId: context.sessionId,
        options: context.options,
        bladeConfig: buildBladeConfig(context.options),
        defaultContext: context.options.defaultContext ?? {},
        ...runtimePorts,
        kernelFactory: runtimePorts.kernelFactory ?? defaultKernelFactory,
        kernelModelResolver: runtimePorts.kernelModelResolver ?? defaultKernelModelResolver,
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
