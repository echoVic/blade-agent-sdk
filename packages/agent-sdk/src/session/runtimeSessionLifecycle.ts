import type { PackageLocalRuntimeHookRuntimePort } from './runtimeHooks.js';

export interface PackageLocalRuntimeSessionLifecycleStorePort<TMessage> {
  createSession(sessionId: string): Promise<void> | void;
  loadSession(sessionId: string): Promise<boolean> | boolean;
  loadMessages(sessionId: string): Promise<TMessage[]> | TMessage[];
}

export interface PackageLocalRuntimeSessionLifecycleOperations<TMessage> {
  ensureSessionCreated(): Promise<void>;
  ensureSessionLoaded(): Promise<void>;
  loadMessages(): Promise<TMessage[]>;
  runSessionStart(isResume: boolean): Promise<void>;
  close(): Promise<void>;
}

export interface PackageLocalRuntimeSessionLifecycleOperationsOptions<TMessage> {
  sessionId: string;
  sessionStore: PackageLocalRuntimeSessionLifecycleStorePort<TMessage>;
  hookRuntime?: PackageLocalRuntimeHookRuntimePort;
  model?: string;
  provider?: string;
  closeRuntimeResources?(): Promise<void> | void;
}

export function createPackageLocalRuntimeSessionLifecycleOperations<TMessage>(
  options: PackageLocalRuntimeSessionLifecycleOperationsOptions<TMessage>,
): PackageLocalRuntimeSessionLifecycleOperations<TMessage> {
  return {
    async ensureSessionCreated() {
      await options.sessionStore.createSession(options.sessionId);
    },
    async ensureSessionLoaded() {
      const loaded = await options.sessionStore.loadSession(options.sessionId);
      if (!loaded) {
        await options.sessionStore.createSession(options.sessionId);
      }
    },
    async loadMessages() {
      return options.sessionStore.loadMessages(options.sessionId);
    },
    async runSessionStart(isResume) {
      await options.hookRuntime?.runSessionStart?.({
        isResume,
        ...(isResume ? { resumeSessionId: options.sessionId } : {}),
        model: options.model ?? '',
        provider: options.provider ?? '',
      });
    },
    async close() {
      try {
        await options.hookRuntime?.runSessionEnd?.({ reason: 'other' });
      } finally {
        await options.closeRuntimeResources?.();
      }
    },
  };
}
