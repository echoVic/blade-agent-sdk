import type { AgentId } from '../types/identifiers.js';
import { SdkError } from './SdkError.js';

export type SessionHandoffErrorCode =
  | 'SESSION_HANDOFF_NOT_CONFIGURED'
  | 'SESSION_HANDOFF_ACTIVE_WORK'
  | 'SESSION_HANDOFF_UNAVAILABLE';

export class SessionHandoffError extends SdkError {
  readonly activeSubagentIds: readonly AgentId[];
  readonly activeShellIds: readonly string[];

  constructor(
    code: SessionHandoffErrorCode,
    message: string,
    options: {
      activeSubagentIds?: readonly AgentId[];
      activeShellIds?: readonly string[];
      cause?: unknown;
    } = {},
  ) {
    super(code, message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.activeSubagentIds = [...(options.activeSubagentIds ?? [])];
    this.activeShellIds = [...(options.activeShellIds ?? [])];
  }
}
