export type LogLevelName = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevelName;
  category: string;
  message: string;
  timestamp: string;
  sessionId?: string;
  args?: unknown[];
}

export interface AgentLogger {
  log(entry: LogEntry): void;
}
