import {
  createSession,
  resumeSession,
} from './Session.js';
import {
  createDefaultKernelSessionRuntimeFactory,
  type DefaultKernelSessionRuntimeFactoryOptions,
} from './defaultKernelRuntimeFactory.js';
import type { SessionRuntimeFactory } from './factory.js';

export interface DefaultSessionRuntimeFactoryOptions
  extends DefaultKernelSessionRuntimeFactoryOptions {
  loadKernelRuntimeFactory?: () => Promise<SessionRuntimeFactory>;
}

export function createDefaultSessionRuntimeFactory(
  options: DefaultSessionRuntimeFactoryOptions = {},
): SessionRuntimeFactory {
  const { loadKernelRuntimeFactory, ...kernelRuntimeOptions } = options;
  const runtimeFactory =
    loadKernelRuntimeFactory === undefined
      ? createDefaultKernelSessionRuntimeFactory(kernelRuntimeOptions)
      : undefined;
  const runtimeFactoryPromise = loadKernelRuntimeFactory?.();

  async function resolveRuntimeFactory(): Promise<SessionRuntimeFactory> {
    if (runtimeFactory) {
      return runtimeFactory;
    }
    if (runtimeFactoryPromise) {
      return runtimeFactoryPromise;
    }
    throw new Error('Kernel session runtime factory could not be resolved.');
  }

  return {
    async create(options) {
      const runtime = await resolveRuntimeFactory();
      return createSession(runtime, options);
    },
    async resume(options) {
      const runtime = await resolveRuntimeFactory();
      return resumeSession(runtime, options);
    },
  };
}
