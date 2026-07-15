/** Minimal InternalLogger interface — structurally compatible with root Logger. */
export interface InternalLogger {
  child(category: any): InternalLogger;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** LogCategory values — match the root enum values exactly. */
export const LogCategory = {
  AGENT: 'Agent',
  UI: 'UI',
  TOOL: 'Tool',
  SERVICE: 'Service',
  CONFIG: 'Config',
  CONTEXT: 'Context',
  EXECUTION: 'Execution',
  LOOP: 'Loop',
  CHAT: 'Chat',
  GENERAL: 'General',
  PROMPTS: 'Prompts',
} as const;

export type LogCategory = (typeof LogCategory)[keyof typeof LogCategory];

class NoopLogger implements InternalLogger {
  child(_category: any): InternalLogger {
    return this;
  }

  debug(..._args: unknown[]): void {}
  info(..._args: unknown[]): void {}
  warn(..._args: unknown[]): void {}
  error(..._args: unknown[]): void {}
}

export const NOOP_LOGGER: InternalLogger = new NoopLogger();
