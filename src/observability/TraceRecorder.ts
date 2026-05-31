import { nanoid } from 'nanoid';
import type { SessionId } from '../types/branded.js';
import type { HookEvent } from '../types/constants.js';
import type { JsonValue } from '../types/common.js';
import type { TokenUsage } from '../types/common.js';
import type {
  AgentTrace,
  HookTraceCollector,
  ObservabilityOptions,
  TracePayloadSummary,
  TraceSpan,
  TraceSpanKind,
  TraceStatus,
} from './types.js';

function nowIso(): string {
  return new Date().toISOString();
}

function durationMs(startedAt: string, endedAt: string): number {
  return Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
}

function jsonSize(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return String(value).length;
  }
}

function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}

export class TraceRecorder implements HookTraceCollector {
  readonly trace: AgentTrace;
  private readonly spanStack = new Map<string, TraceSpan>();
  private readonly capturePayloads: boolean;
  private readonly rootSpanId: string;

  constructor(
    sessionId: SessionId,
    options: ObservabilityOptions | undefined,
    metadata: Record<string, JsonValue | undefined> = {},
  ) {
    const startedAt = nowIso();
    this.capturePayloads = options?.capturePayloads ?? false;
    this.trace = {
      id: `trace_${nanoid()}`,
      sessionId,
      status: 'running',
      startedAt,
      spans: [],
      events: [],
      metadata,
    };
    this.rootSpanId = this.startSpan('session', 'session.stream');
  }

  getTrace(): AgentTrace {
    return structuredClone(this.trace);
  }

  startSpan(
    kind: TraceSpanKind,
    name: string,
    attributes?: Record<string, unknown>,
    parentId = this.rootSpanId,
  ): string {
    const id = `${kind}_${nanoid()}`;
    const span: TraceSpan = {
      id,
      traceId: this.trace.id,
      parentId,
      kind,
      name,
      status: 'running',
      startedAt: nowIso(),
      attributes: attributes ? this.summarizeRecord(attributes) : undefined,
    };
    this.trace.spans.push(span);
    this.spanStack.set(id, span);
    return id;
  }

  endSpan(spanId: string, status: TraceStatus = 'success', attributes?: Record<string, unknown>): void {
    const span = this.spanStack.get(spanId);
    if (!span || span.endedAt) return;

    const endedAt = nowIso();
    span.status = status;
    span.endedAt = endedAt;
    span.durationMs = durationMs(span.startedAt, endedAt);
    if (attributes) {
      span.attributes = {
        ...span.attributes,
        ...this.summarizeRecord(attributes),
      };
    }
    this.spanStack.delete(spanId);
  }

  addEvent(type: string, data?: Record<string, unknown>, spanId?: string): void {
    this.trace.events.push({
      id: `event_${nanoid()}`,
      traceId: this.trace.id,
      spanId,
      type,
      timestamp: nowIso(),
      data: data ? this.summarizeRecord(data) : undefined,
    });
  }

  recordTurnStart(turn: number, maxTurns?: number): string {
    const spanId = this.startSpan('turn', `turn.${turn}`, { turn, maxTurns });
    this.addEvent('turn_start', { turn, maxTurns }, spanId);
    return spanId;
  }

  recordTurnEnd(spanId: string | undefined, turn: number): void {
    this.addEvent('turn_end', { turn }, spanId);
    if (spanId) this.endSpan(spanId);
  }

  recordToolStart(toolCallId: string, name: string, input: unknown): string {
    const spanId = this.startSpan('tool', name, { toolCallId, input });
    this.addEvent('tool_use', { toolCallId, name, input }, spanId);
    return spanId;
  }

  recordToolResult(
    spanId: string | undefined,
    toolCallId: string,
    name: string,
    output: unknown,
    isError?: boolean,
  ): void {
    this.addEvent('tool_result', { toolCallId, name, output, isError: isError ?? false }, spanId);
    if (spanId) this.endSpan(spanId, isError ? 'error' : 'success', { output });
  }

  recordUsage(usage: TokenUsage): void {
    this.addEvent('usage', { usage });
  }

  recordHookStart(event: HookEvent, payload: Record<string, unknown>): string {
    const spanId = this.startSpan('hook', event, { event, payload });
    this.addEvent('hook_start', { event, payload }, spanId);
    return spanId;
  }

  recordHookEnd(spanId: string, payload?: Record<string, unknown>): void {
    this.addEvent('hook_end', payload, spanId);
    this.endSpan(spanId, 'success', payload);
  }

  recordHookError(spanId: string, error: unknown): void {
    this.addEvent('hook_error', { error: this.errorMessage(error) }, spanId);
    this.endSpan(spanId, 'error', { error: this.errorMessage(error) });
  }

  finish(status: Exclude<TraceStatus, 'running'>, data?: Record<string, unknown>): AgentTrace {
    const endedAt = nowIso();
    for (const spanId of [...this.spanStack.keys()]) {
      this.endSpan(spanId, status);
    }
    this.trace.status = status;
    this.trace.endedAt = endedAt;
    this.trace.durationMs = durationMs(this.trace.startedAt, endedAt);
    if (data) this.addEvent(status === 'success' ? 'result' : 'error', data);
    return this.getTrace();
  }

  private summarizeRecord(record: Record<string, unknown>): Record<string, JsonValue | TracePayloadSummary | undefined> {
    return Object.fromEntries(
      Object.entries(record).map(([key, value]) => [key, this.summarizeValue(value)]),
    );
  }

  private summarizeValue(value: unknown): JsonValue | TracePayloadSummary {
    if (this.capturePayloads) {
      return {
        type: this.typeOf(value),
        preview: this.preview(value),
        length: typeof value === 'string' ? value.length : jsonSize(value),
        value: toJsonValue(value),
      };
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return {
        type: 'object',
        preview: '[redacted]',
        keys: Object.keys(value as Record<string, unknown>).slice(0, 20),
        length: jsonSize(value),
      };
    }

    return {
      type: this.typeOf(value),
      preview: '[redacted]',
      length: typeof value === 'string' ? value.length : jsonSize(value),
    };
  }

  private typeOf(value: unknown): string {
    if (Array.isArray(value)) return 'array';
    if (value === null) return 'null';
    return typeof value;
  }

  private preview(value: unknown): string {
    if (typeof value === 'string') return value.slice(0, 200);
    try {
      return JSON.stringify(value).slice(0, 200);
    } catch {
      return String(value).slice(0, 200);
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
