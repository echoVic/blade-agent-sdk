import type { SessionRuntimeFactory } from './factory.js';
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
  return runtime.resume(options);
}

export async function forkSession(
  runtime: SessionRuntimeFactory,
  options: ForkOptions,
): Promise<ISession> {
  return runtime.fork(options);
}

export async function prompt(
  runtime: SessionRuntimeFactory,
  message: UserMessageContent,
  options: SessionOptions,
): Promise<PromptResult> {
  return runtime.prompt(message, options);
}
