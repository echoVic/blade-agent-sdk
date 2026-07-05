import { nanoid } from 'nanoid';
import { buildBladeConfig } from './config.js';
import { createPackageLocalAgentKernelFactory } from './kernelFactory.js';
import { createPackageLocalKernelModelResolver } from './kernelModelResolver.js';
import { createPackageLocalKernelSessionRuntimeFactory } from './packageLocalKernelRuntimeFactory.js';
import {
  PackageLocalSessionRuntime,
  type PackageLocalSessionRuntimeOptions,
  type PackageLocalRuntimeSessionStorePort,
} from './runtimeInstance.js';
import { JsonlSessionStore } from './store.js';
import type { SessionRuntimeFactory } from './factory.js';
import type { SessionId, SessionOptions } from './types.js';
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

function createJsonlRuntimeSessionStore(
  options: SessionOptions,
): PackageLocalRuntimeSessionStorePort | undefined {
  if (options.persistSession === false || !options.storagePath) {
    return undefined;
  }

  const store = new JsonlSessionStore(options.storagePath);
  return {
    async createSession(sessionId) {
      await store.createSession(sessionId);
    },
    async loadSession(sessionId) {
      return (await store.loadState(sessionId)) !== null;
    },
    async loadMessages(sessionId) {
      return store.loadMessages(sessionId);
    },
    async appendMessage(sessionId, message, context) {
      await store.appendMessage(sessionId, message, context);
    },
    async forkState(sessionId, forkOptions) {
      return store.forkState(sessionId, forkOptions);
    },
    async writeForkState(forkedSessionId, snapshot) {
      return store.writeForkState(forkedSessionId, snapshot);
    },
  };
}

export function createDefaultKernelSessionRuntimeFactory(
  options: DefaultKernelSessionRuntimeFactoryOptions = {},
): SessionRuntimeFactory {
  const runtimes = new WeakMap<PackageLocalSessionRuntimeContext, PackageLocalSessionRuntime>();
  const createSessionId = options.createSessionId ?? nanoid;
  const defaultKernelFactory = createPackageLocalAgentKernelFactory();
  const defaultKernelModelResolver = createPackageLocalKernelModelResolver();
  let runtimeFactory: SessionRuntimeFactory;

  runtimeFactory = createPackageLocalKernelSessionRuntimeFactory({
    createSessionId,
    createTurnId: options.createTurnId ?? nanoid,
    createRuntime(context) {
      const runtimePorts = resolveRuntimePorts(options.runtime, context);
      const runtime = new PackageLocalSessionRuntime({
        sessionId: context.sessionId,
        options: context.options,
        bladeConfig: buildBladeConfig(context.options),
        defaultContext: context.options.defaultContext ?? {},
        sessionStore:
          runtimePorts.sessionStore ?? createJsonlRuntimeSessionStore(context.options),
        ...runtimePorts,
        kernelFactory: runtimePorts.kernelFactory ?? defaultKernelFactory,
        kernelModelResolver: runtimePorts.kernelModelResolver ?? defaultKernelModelResolver,
        createForkSessionId: createSessionId,
        createForkSession(sessionId, sessionOptions) {
          return runtimeFactory.resume({ ...sessionOptions, sessionId });
        },
      });
      runtimes.set(context, runtime);
      return runtime;
    },
    async cleanup(context) {
      await runtimes.get(context)?.close();
      runtimes.delete(context);
    },
  });

  return runtimeFactory;
}
