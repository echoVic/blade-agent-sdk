import {
  createSession,
  resumeSession,
} from './Session.js';
import type { SessionRuntimeFactory } from './factory.js';

let legacyRuntimeFactoryPromise: Promise<SessionRuntimeFactory> | null = null;

async function loadLegacyRuntimeFactory(): Promise<SessionRuntimeFactory> {
  legacyRuntimeFactoryPromise ??= import('./legacySessionAdapter.js').then(
    ({ createLegacySessionRuntimeFactory }) => createLegacySessionRuntimeFactory(),
  );
  return legacyRuntimeFactoryPromise;
}

export function createDefaultSessionRuntimeFactory(): SessionRuntimeFactory {
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
