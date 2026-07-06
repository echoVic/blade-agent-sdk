export interface PackageLocalRuntimeSessionLifecycleStorePort<TMessage> {
  createSession(sessionId: string): Promise<void> | void;
  loadSession(sessionId: string): Promise<boolean> | boolean;
  loadMessages(sessionId: string): Promise<TMessage[]> | TMessage[];
}

export interface PackageLocalRuntimeSessionLifecycleOperations<TMessage> {
  ensureSessionCreated(): Promise<void>;
  ensureSessionLoaded(): Promise<void>;
  loadMessages(): Promise<TMessage[]>;
}

export interface PackageLocalRuntimeSessionLifecycleOperationsOptions<TMessage> {
  sessionId: string;
  sessionStore: PackageLocalRuntimeSessionLifecycleStorePort<TMessage>;
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
  };
}
