import type { HookEvent } from '../types/constants.js';
import type { SessionId, SpanId, TraceEventId, TraceId } from '../types/identifiers.js';
import type { JsonValue } from '../types/json.js';

export type TraceStatus = 'running' | 'success' | 'error' | 'aborted';
export type TraceSpanKind = 'session' | 'turn' | 'tool' | 'hook';

export interface TracePayloadSummary {
  type: string;
  preview: string;
  length?: number;
  keys?: string[];
  value?: JsonValue;
}

export interface TraceEvent {
  id: TraceEventId;
  traceId: TraceId;
  spanId?: SpanId;
  type: string;
  timestamp: string;
  data?: Record<string, JsonValue | TracePayloadSummary | undefined>;
}

export interface TraceSpan {
  id: SpanId;
  traceId: TraceId;
  parentId?: SpanId;
  kind: TraceSpanKind;
  name: string;
  status: TraceStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  attributes?: Record<string, JsonValue | TracePayloadSummary | undefined>;
}

export interface AgentTrace {
  id: TraceId;
  sessionId: SessionId;
  status: TraceStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  spans: TraceSpan[];
  events: TraceEvent[];
  metadata?: Record<string, JsonValue | undefined>;
}

export type TraceSink = (trace: AgentTrace) => void | Promise<void>;

export interface ObservabilityOptions {
  enabled?: boolean;
  capturePayloads?: boolean;
  maxTraces?: number;
  sink?: TraceSink;
}

export interface HookTraceCollector {
  recordHookStart(event: HookEvent, payload: Record<string, unknown>): SpanId;
  recordHookEnd(spanId: SpanId, payload?: Record<string, unknown>): void;
  recordHookError(spanId: SpanId, error: unknown): void;
}
