import {
  createSession as createLegacySession,
  forkSession as forkLegacySession,
  prompt as promptLegacyPrompt,
  resumeSession as resumeLegacySession,
} from '../../../../src/session/Session.js';
import type { SessionRuntimeFactory } from './factory.js';
import type {
  ISession,
  PromptResult,
} from './types.js';

export function createLegacySessionRuntimeFactory(): SessionRuntimeFactory {
  return {
    async create(options) {
      return await createLegacySession(options as never) as unknown as ISession;
    },
    async resume(options) {
      return await resumeLegacySession(options as never) as unknown as ISession;
    },
    async fork(options) {
      return await forkLegacySession(options as never) as unknown as ISession;
    },
    async prompt(message, options) {
      return await promptLegacyPrompt(
        message as never,
        options as never,
      ) as unknown as PromptResult;
    },
  };
}
