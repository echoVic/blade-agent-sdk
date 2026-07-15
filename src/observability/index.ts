// Already migrated to @blade-ai/agent-sdk/local
export type {
  AgentTrace,
  HookTraceCollector,
  ObservabilityOptions,
  TraceEvent,
  TracePayloadSummary,
  TraceSink,
  TraceSpan,
  TraceSpanKind,
  TraceStatus,
} from '@blade-ai/agent-sdk/local';

// Still root-only — not yet migrated
export { TraceRecorder } from './TraceRecorder.js';
