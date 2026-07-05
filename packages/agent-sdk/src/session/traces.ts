import { TraceRecorder } from '../observability/TraceRecorder.js';
import type { AgentTrace, ObservabilityOptions } from '../observability/types.js';
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
