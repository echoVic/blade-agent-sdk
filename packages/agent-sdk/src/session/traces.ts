import { TraceRecorder } from '../observability/TraceRecorder.js';
import type { AgentTrace, ObservabilityOptions, TraceStatus } from '../observability/types.js';
import type { JsonValue } from '../types/common.js';
import type { SessionId, UserMessageContent } from './types.js';

export interface SessionTraceManagerOptions {
  sessionId: SessionId;
  observability?: ObservabilityOptions;
  metadata: Record<string, JsonValue | undefined>;
  onSinkError?: (error: unknown) => void;
}

export class SessionTraceManager {
  private readonly sessionId: SessionId;
  private readonly observability?: ObservabilityOptions;
  private readonly metadata: Record<string, JsonValue | undefined>;
  private readonly onSinkError?: (error: unknown) => void;
  private readonly traces: AgentTrace[] = [];

  constructor(options: SessionTraceManagerOptions) {
    this.sessionId = options.sessionId;
    this.observability = options.observability;
    this.metadata = options.metadata;
    this.onSinkError = options.onSinkError;
  }

  createRecorder(message: UserMessageContent): TraceRecorder | undefined {
    if (!this.observability?.enabled) {
      return undefined;
    }

    const recorder = new TraceRecorder(this.sessionId, this.observability, this.metadata);
    recorder.addEvent('user_prompt', { message });
    return recorder;
  }

  remember(trace: AgentTrace): void {
    this.traces.push(trace);
    const maxTraces = this.observability?.maxTraces ?? 20;
    while (this.traces.length > maxTraces) {
      this.traces.shift();
    }
  }

  getLastTrace(): AgentTrace | undefined {
    return this.traces.at(-1);
  }

  getTraces(): AgentTrace[] {
    return [...this.traces];
  }

  async notifySink(trace: AgentTrace): Promise<void> {
    try {
      await this.observability?.sink?.(trace);
    } catch (error) {
      this.onSinkError?.(error);
    }
  }
}

export interface SessionTraceFinalizer {
  finish(
    status: Exclude<TraceStatus, 'running'>,
    data?: Record<string, unknown>,
  ): Promise<AgentTrace | undefined>;
}

export function createSessionTraceFinalizer(
  recorder: TraceRecorder | undefined,
  manager: Pick<SessionTraceManager, 'remember' | 'notifySink'>,
): SessionTraceFinalizer {
  let finished = false;

  return {
    async finish(status, data) {
      if (!recorder || finished) {
        return undefined;
      }

      finished = true;
      try {
        const trace = recorder.finish(status, data);
        manager.remember(trace);
        await manager.notifySink(trace);
        return trace;
      } catch {
        return undefined;
      }
    },
  };
}
