import {
  createSession,
  resumeSession,
} from './Session.js';
import type { SessionRuntimeFactory } from './factory.js';

let legacyRuntimeFactoryPromise: Promise<SessionRuntimeFactory> | null = null;

export interface DefaultSessionRuntimeFactoryOptions {
  loadLegacyRuntimeFactory?: () => Promise<SessionRuntimeFactory>;
}

async function loadDefaultLegacyRuntimeFactory(): Promise<SessionRuntimeFactory> {
  legacyRuntimeFactoryPromise ??= import('./legacySessionAdapter.js').then(
    ({ createLegacySessionRuntimeFactory }) => createLegacySessionRuntimeFactory(),
  );
  return legacyRuntimeFactoryPromise;
}

export function createDefaultSessionRuntimeFactory(
  options: DefaultSessionRuntimeFactoryOptions = {},
): SessionRuntimeFactory {
  const loadLegacyRuntimeFactory =
    options.loadLegacyRuntimeFactory ?? loadDefaultLegacyRuntimeFactory;

  return {
    async create(options) {
      const legacyRuntime = await loadLegacyRuntimeFactory();
      return createSession(legacyRuntime, options);
    },
    async resume(options) {
      const legacyRuntime = await loadLegacyRuntimeFactory();
      return resumeSession(legacyRuntime, options);
    },
  };
}
