import type { SessionId } from '../types/identifiers.js';
import type { AgentLogger, LogEntry, LogLevelName } from '../types/logging.js';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export enum LogCategory {
  AGENT = 'Agent',
  UI = 'UI',
  TOOL = 'Tool',
  SERVICE = 'Service',
  CONFIG = 'Config',
  CONTEXT = 'Context',
  EXECUTION = 'Execution',
  LOOP = 'Loop',
  CHAT = 'Chat',
  GENERAL = 'General',
  PROMPTS = 'Prompts',
}

export interface InternalLogger {
  child(category: LogCategory): InternalLogger;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

class NoopLogger implements InternalLogger {
  child(_category: LogCategory): InternalLogger {
    return this;
  }

  debug(..._args: unknown[]): void {}
  info(..._args: unknown[]): void {}
  warn(..._args: unknown[]): void {}
  error(..._args: unknown[]): void {}
}

class SessionLoggerAdapter implements InternalLogger {
  constructor(
    private readonly target: AgentLogger | null,
    private readonly sessionId?: SessionId,
    private readonly category: LogCategory = LogCategory.GENERAL,
  ) {}

  child(category: LogCategory): InternalLogger {
    return new SessionLoggerAdapter(this.target, this.sessionId, category);
  }

  debug(...args: unknown[]): void {
    this.emit(LogLevel.DEBUG, args);
  }

  info(...args: unknown[]): void {
    this.emit(LogLevel.INFO, args);
  }

  warn(...args: unknown[]): void {
    this.emit(LogLevel.WARN, args);
  }

  error(...args: unknown[]): void {
    this.emit(LogLevel.ERROR, args);
  }

  private emit(level: LogLevel, args: unknown[]): void {
    if (!this.target) {
      return;
    }

    const entry: LogEntry = {
      level: LogLevel[level].toLowerCase() as LogLevelName,
      category: this.category,
      message: args
        .map((arg) => (typeof arg === 'object' ? JSON.stringify(arg) : String(arg)))
        .join(' '),
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      args,
    };

    try {
      this.target.log(entry);
    } catch {
      // User logger failures must not affect SDK execution.
    }
  }
}

export function createRootLogger(
  logger?: AgentLogger | null,
  sessionId?: SessionId,
): InternalLogger {
  return new SessionLoggerAdapter(logger ?? null, sessionId);
}

export const NOOP_LOGGER: InternalLogger = new NoopLogger();
