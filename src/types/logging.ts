import type { SessionId } from './identifiers.js';

export type LogLevelName = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevelName;
  category: string;
  message: string;
  timestamp: string;
  sessionId?: SessionId;
  args?: unknown[];
}

export interface AgentLogger {
  log(entry: LogEntry): void;
}
