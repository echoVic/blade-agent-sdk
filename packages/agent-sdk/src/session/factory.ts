import type {
  ISession,
  ResumeOptions,
  SessionOptions,
} from './types.js';

export interface SessionRuntimeFactory {
  create(options: SessionOptions): Promise<ISession>;
  resume(options: ResumeOptions): Promise<ISession>;
}
