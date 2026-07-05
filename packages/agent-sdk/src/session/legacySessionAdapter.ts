import {
  createSession as createLegacySession,
  resumeSession as resumeLegacySession,
} from '../../../../src/session/Session.js';
import type { SessionRuntimeFactory } from './factory.js';
import type {
  ISession,
} from './types.js';

export function createLegacySessionRuntimeFactory(): SessionRuntimeFactory {
  return {
    async create(options) {
      return await createLegacySession(options as never) as unknown as ISession;
    },
    async resume(options) {
      return await resumeLegacySession(options as never) as unknown as ISession;
    },
  };
}
