import {
  createSession as createLegacySession,
  resumeSession as resumeLegacySession,
} from '../../../../src/session/Session.js';
import type { SessionRuntimeFactory } from './factory.js';
import type {
  ISession,
  PromptResult,
  SessionOptions,
  UserMessageContent,
} from './types.js';
import {
  forkSession as runForkLifecycle,
  prompt as runPromptLifecycle,
} from './Session.js';

export function createLegacySessionRuntimeFactory(): SessionRuntimeFactory {
  const runtime: SessionRuntimeFactory = {
    async create(options) {
      return await createLegacySession(options as never) as unknown as ISession;
    },
    async resume(options) {
      return await resumeLegacySession(options as never) as unknown as ISession;
    },
    async fork(options) {
      return runForkLifecycle(runtime, options);
    },
    async prompt(message, options) {
      return runPromptLifecycle(
        runtime,
        message as UserMessageContent,
        options as SessionOptions,
      ) as Promise<PromptResult>;
    },
  };
  return runtime;
}
