import type { AgentTraceEvent, AgentTracePort } from '@blade-ai/agent/tracing';
import type { TraceRecorder } from '../observability/TraceRecorder.js';
import type { TokenUsage } from '../types/common.js';

export interface KernelTracePortOptions {
  recorder: TraceRecorder;
  maxContextTokens?: number;
}

export function createKernelTracePort(options: KernelTracePortOptions): AgentTracePort {
  const toolSpans = new Map<string, string>();
  let turnSpanId: string | undefined;

  return {
    record(event) {
      switch (event.type) {
        case 'turn_start':
          turnSpanId = options.recorder.startSpan('turn', 'kernel.turn', {
            input: event.input,
          });
          options.recorder.addEvent('turn_start', { input: event.input }, turnSpanId);
          break;
        case 'model_request':
          options.recorder.addEvent('model_request', { messages: event.messages }, turnSpanId);
          break;
        case 'model_response':
          options.recorder.addEvent('model_response', {
            content: event.content,
            finishReason: event.finishReason,
            toolCalls: event.toolCalls,
            usage: event.usage,
          }, turnSpanId);
          break;
        case 'tool_call_start': {
          const spanId = options.recorder.recordToolStart(
            event.toolCall.id,
            event.toolCall.name,
            event.toolCall.input,
          );
          toolSpans.set(event.toolCall.id, spanId);
          break;
        }
        case 'tool_call_end':
          options.recorder.recordToolResult(
            toolSpans.get(event.toolCall.id),
            event.toolCall.id,
            event.toolCall.name,
            event.result.output,
            event.result.isError,
          );
          toolSpans.delete(event.toolCall.id);
          break;
        case 'tool_permission_updates':
          options.recorder.addEvent('tool_permission_updates', {
            toolCallId: event.toolCall.id,
            name: event.toolCall.name,
            updates: event.updates,
          }, toolSpans.get(event.toolCall.id));
          break;
        case 'usage':
          options.recorder.recordUsage(toTokenUsage(
            event.usage,
            options.maxContextTokens ?? 0,
          ));
          break;
        case 'turn_end':
          options.recorder.addEvent('turn_end', {
            content: event.content,
            finishReason: event.finishReason,
          }, turnSpanId);
          if (turnSpanId) {
            options.recorder.endSpan(turnSpanId);
            turnSpanId = undefined;
          }
          break;
      }
    },
  };
}

function toTokenUsage(
  eventUsage: Extract<AgentTraceEvent, { type: 'usage' }>['usage'],
  maxContextTokens: number,
): TokenUsage {
  return {
    inputTokens: eventUsage.promptTokens ?? 0,
    outputTokens: eventUsage.completionTokens ?? 0,
    totalTokens: eventUsage.totalTokens,
    maxContextTokens,
  };
}
