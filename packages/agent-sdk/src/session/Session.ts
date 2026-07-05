import type { SessionRuntimeFactory } from './factory.js';
import { PromptStreamAccumulator } from './promptStreamAccumulator.js';
import type {
  ForkOptions,
  ISession,
  PromptResult,
  ResumeOptions,
  SessionOptions,
  UserMessageContent,
} from './types.js';

export async function createSession(
  runtime: SessionRuntimeFactory,
  options: SessionOptions,
): Promise<ISession> {
  return runtime.create(options);
}

export async function resumeSession(
  runtime: SessionRuntimeFactory,
  options: ResumeOptions,
): Promise<ISession> {
  if (options.persistSession === false) {
    throw new Error(
      'resumeSession() requires session persistence. Remove persistSession: false or use createSession().',
    );
  }
  return runtime.resume(options);
}

export async function forkSession(
  runtime: SessionRuntimeFactory,
  options: ForkOptions,
): Promise<ISession> {
  if (options.persistSession === false) {
    throw new Error(
      'forkSession() requires session persistence. Remove persistSession: false and call session.fork() on a live session instead.',
    );
  }
  const { messageId } = options;
  const sourceSession = await runtime.resume(options);

  try {
    return await sourceSession.fork({ messageId });
  } finally {
    await sourceSession.close();
  }
}

export async function prompt(
  runtime: SessionRuntimeFactory,
  message: UserMessageContent,
  options: SessionOptions,
): Promise<PromptResult> {
  const startTime = Date.now();
  const session = await runtime.create(options);
  const accumulator = new PromptStreamAccumulator();

  try {
    await session.send(message);

    for await (const streamMessage of session.stream()) {
      accumulator.accept(streamMessage);
    }

    return accumulator.build({ duration: Date.now() - startTime });
  } finally {
    await session.close();
  }
}
