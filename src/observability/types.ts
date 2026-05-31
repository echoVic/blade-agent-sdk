import type { HookEvent } from '../types/constants.js';
import type { JsonValue } from '../types/common.js';

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
  id: string;
  traceId: string;
  spanId?: string;
  type: string;
  timestamp: string;
  data?: Record<string, JsonValue | TracePayloadSummary | undefined>;
}

export interface TraceSpan {
  id: string;
  traceId: string;
  parentId?: string;
  kind: TraceSpanKind;
  name: string;
  status: TraceStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  attributes?: Record<string, JsonValue | TracePayloadSummary | undefined>;
}

export interface AgentTrace {
  id: string;
  sessionId: string;
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
  recordHookStart(event: HookEvent, payload: Record<string, unknown>): string;
  recordHookEnd(spanId: string, payload?: Record<string, unknown>): void;
  recordHookError(spanId: string, error: unknown): void;
}
