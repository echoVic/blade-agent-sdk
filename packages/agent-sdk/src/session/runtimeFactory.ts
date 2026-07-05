import {
  createSession,
  resumeSession,
} from './Session.js';
import type { SessionRuntimeFactory } from './factory.js';
import { createLegacySessionRuntimeFactory } from './legacySessionAdapter.js';

export function createDefaultSessionRuntimeFactory(): SessionRuntimeFactory {
  const legacyRuntime = createLegacySessionRuntimeFactory();

  return {
    async create(options) {
      return createSession(legacyRuntime, options);
    },
    async resume(options) {
      return resumeSession(legacyRuntime, options);
    },
  };
}
