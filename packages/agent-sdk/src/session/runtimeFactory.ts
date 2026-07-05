import {
  createSession,
  resumeSession,
} from './Session.js';
import type { SessionRuntimeFactory } from './factory.js';

let legacyRuntimeFactoryPromise: Promise<SessionRuntimeFactory> | null = null;

export interface DefaultSessionRuntimeFactoryOptions {
  loadKernelRuntimeFactory?: () => Promise<SessionRuntimeFactory>;
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
  const loadRuntimeFactory =
    options.loadKernelRuntimeFactory ??
    options.loadLegacyRuntimeFactory ??
    loadDefaultLegacyRuntimeFactory;

  return {
    async create(options) {
      const runtime = await loadRuntimeFactory();
      return createSession(runtime, options);
    },
    async resume(options) {
      const runtime = await loadRuntimeFactory();
      return resumeSession(runtime, options);
    },
  };
}
