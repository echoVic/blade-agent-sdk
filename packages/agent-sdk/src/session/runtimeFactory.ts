import {
  createSession as createRootSession,
  forkSession as forkRootSession,
  prompt as promptRootSession,
  resumeSession as resumeRootSession,
} from '../../../../src/session/Session.js';
import type {
  ISession,
  PromptResult,
} from './types.js';
import type { SessionRuntimeFactory } from './factory.js';

export function createDefaultSessionRuntimeFactory(): SessionRuntimeFactory {
  return {
    async create(options) {
      return await createRootSession(options as never) as unknown as ISession;
    },
    async resume(options) {
      return await resumeRootSession(options as never) as unknown as ISession;
    },
    async fork(options) {
      return await forkRootSession(options as never) as unknown as ISession;
    },
    async prompt(message, options) {
      return await promptRootSession(
        message as never,
        options as never,
      ) as unknown as PromptResult;
    },
  };
}
