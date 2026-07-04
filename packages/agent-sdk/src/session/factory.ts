import type {
  ForkOptions,
  ISession,
  PromptResult,
  ResumeOptions,
  SessionOptions,
  UserMessageContent,
} from './types.js';

export interface SessionRuntimeFactory {
  create(options: SessionOptions): Promise<ISession>;
  resume(options: ResumeOptions): Promise<ISession>;
  fork(options: ForkOptions): Promise<ISession>;
  prompt(message: UserMessageContent, options: SessionOptions): Promise<PromptResult>;
}
