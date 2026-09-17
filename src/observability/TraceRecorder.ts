import { nanoid } from 'nanoid';
import type { TokenUsage } from '../model/usage.js';
import type { HookEvent } from '../types/constants.js';
import {
  type SessionId,
  SpanId,
  type ToolUseId,
  TraceEventId,
  TraceId,
} from '../types/identifiers.js';
import type { JsonValue } from '../types/json.js';
import type {
  AgentTrace,
  HookTraceCollector,
  ObservabilityOptions,
  TracePayloadSummary,
  TraceSpan,
  TraceSpanKind,
  TraceStatus,
} from './types.js';

const now = (): string => new Date().toISOString();
const duration = (start: string, end: string): number =>
  Math.max(0, Date.parse(end) - Date.parse(start));

function jsonSize(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return String(value).length;
  }
}

function jsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}

export class TraceRecorder implements HookTraceCollector {
  readonly trace: AgentTrace;
  private readonly openSpans = new Map<SpanId, TraceSpan>();
  private readonly capturePayloads: boolean;
  private readonly rootSpanId: SpanId;

  constructor(
    sessionId: SessionId,
    options?: ObservabilityOptions,
    metadata: Record<string, JsonValue | undefined> = {},
  ) {
    const startedAt = now();
    this.capturePayloads = options?.capturePayloads ?? false;
    this.trace = {
      id: TraceId(`trace_${nanoid()}`),
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
  ): SpanId {
    const id = SpanId(`${kind}_${nanoid()}`);
    const span: TraceSpan = {
      id,
      traceId: this.trace.id,
      parentId,
      kind,
      name,
      status: 'running',
      startedAt: now(),
      attributes: attributes ? this.summarize(attributes) : undefined,
    };
    this.trace.spans.push(span);
    this.openSpans.set(id, span);
    return id;
  }

  endSpan(
    spanId: SpanId,
    status: TraceStatus = 'success',
    attributes?: Record<string, unknown>,
  ): void {
    const span = this.openSpans.get(spanId);
    if (!span || span.endedAt) return;
    span.endedAt = now();
    span.durationMs = duration(span.startedAt, span.endedAt);
    span.status = status;
    if (attributes) span.attributes = { ...span.attributes, ...this.summarize(attributes) };
    this.openSpans.delete(spanId);
  }

  addEvent(type: string, data?: Record<string, unknown>, spanId?: SpanId): void {
    this.trace.events.push({
      id: TraceEventId(`event_${nanoid()}`),
      traceId: this.trace.id,
      spanId,
      type,
      timestamp: now(),
      data: data ? this.summarize(data) : undefined,
    });
  }

  recordTurnStart(turn: number, maxTurns?: number): SpanId {
    const span = this.startSpan('turn', `turn.${turn}`, { turn, maxTurns });
    this.addEvent('turn_start', { turn, maxTurns }, span);
    return span;
  }

  recordTurnEnd(span: SpanId | undefined, turn: number): void {
    this.addEvent('turn_end', { turn }, span);
    if (span) this.endSpan(span);
  }

  recordToolStart(toolCallId: ToolUseId, name: string, input: unknown): SpanId {
    const span = this.startSpan('tool', name, { toolCallId, input });
    this.addEvent('tool_use', { toolCallId, name, input }, span);
    return span;
  }

  recordToolResult(
    span: SpanId | undefined,
    toolCallId: ToolUseId,
    name: string,
    output: unknown,
    isError = false,
  ): void {
    this.addEvent('tool_result', { toolCallId, name, output, isError }, span);
    if (span) this.endSpan(span, isError ? 'error' : 'success', { output });
  }

  recordUsage(usage: TokenUsage): void {
    this.addEvent('usage', { usage });
  }

  recordHookStart(event: HookEvent, payload: Record<string, unknown>): SpanId {
    const span = this.startSpan('hook', event, { event, payload });
    this.addEvent('hook_start', { event, payload }, span);
    return span;
  }

  recordHookEnd(span: SpanId, payload?: Record<string, unknown>): void {
    this.addEvent('hook_end', payload, span);
    this.endSpan(span, 'success', payload);
  }

  recordHookError(span: SpanId, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.addEvent('hook_error', { error: message }, span);
    this.endSpan(span, 'error', { error: message });
  }

  finish(status: Exclude<TraceStatus, 'running'>, data?: Record<string, unknown>): AgentTrace {
    const endedAt = now();
    for (const span of [...this.openSpans.keys()]) this.endSpan(span, status);
    Object.assign(this.trace, {
      status,
      endedAt,
      durationMs: duration(this.trace.startedAt, endedAt),
    });
    if (data) this.addEvent(status === 'success' ? 'result' : 'error', data);
    return this.getTrace();
  }

  private summarize(
    record: Record<string, unknown>,
  ): Record<string, JsonValue | TracePayloadSummary | undefined> {
    return Object.fromEntries(
      Object.entries(record).map(([key, value]) => [key, this.summarizeValue(value)]),
    );
  }

  private summarizeValue(value: unknown): TracePayloadSummary {
    const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    const length = typeof value === 'string' ? value.length : jsonSize(value);
    if (this.capturePayloads) {
      const serialized = typeof value === 'string' ? value : JSON.stringify(value);
      return { type, preview: serialized.slice(0, 200), length, value: jsonValue(value) };
    }
    return {
      type,
      preview: '[redacted]',
      length,
      ...(value && typeof value === 'object' && !Array.isArray(value)
        ? { keys: Object.keys(value).slice(0, 20) }
        : {}),
    };
  }
}
