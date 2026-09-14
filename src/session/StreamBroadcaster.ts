import type { AgentEvent } from '../agent/AgentEvent.js';
import type { TokenUsage } from '../model/usage.js';
import type { TraceRecorder } from '../observability/index.js';
import { type SessionId, type SpanId, ToolUseId } from '../types/identifiers.js';
import type { JsonValue } from '../types/json.js';
import type { SessionStreamEvent, ToolExecutionRecord } from './types.js';

const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  maxContextTokens: 0,
};

export interface StreamBroadcasterOptions {
  sessionId: SessionId;
  includeThinking?: boolean;
  traceRecorder?: TraceRecorder;
}

export interface StreamSummary {
  toolCalls: ToolExecutionRecord[];
  usage: TokenUsage;
}

/**
 * Owns the internal AgentEvent to public SessionStreamEvent projection.
 *
 * Events that are meaningful only inside the Agent loop intentionally project
 * to null. The broadcaster also keeps the per-request usage and tool summary
 * used by higher-level prompt helpers and observability.
 */
export class StreamBroadcaster {
  private readonly toolCalls: ToolExecutionRecord[] = [];
  private readonly turnSpans = new Map<number, SpanId>();
  private readonly toolSpans = new Map<string, SpanId>();
  private usage: TokenUsage = { ...EMPTY_USAGE };

  constructor(private readonly options: StreamBroadcasterOptions) {}

  project(event: AgentEvent): SessionStreamEvent | null {
    const { sessionId, traceRecorder } = this.options;

    switch (event.type) {
      case 'turn_start': {
        const spanId = traceRecorder?.recordTurnStart(event.turn, event.maxTurns);
        if (spanId) {
          this.turnSpans.set(event.turn, spanId);
        }
        return { type: 'turn_start', turn: event.turn, sessionId };
      }
      case 'turn_end':
        traceRecorder?.recordTurnEnd(this.turnSpans.get(event.turn), event.turn);
        this.turnSpans.delete(event.turn);
        return { type: 'turn_end', turn: event.turn, sessionId };
      case 'turn_interrupted':
        traceRecorder?.addEvent('turn_interrupted', {
          inputId: event.inputId,
          requestId: event.requestId,
          turn: event.turn,
        });
        return { ...event, sessionId };
      case 'input_applied':
        traceRecorder?.addEvent('input_applied', {
          inputId: event.inputId,
          requestId: event.requestId,
          priority: event.priority,
          turn: event.turn,
        });
        return { ...event, sessionId };
      case 'content_delta':
        traceRecorder?.addEvent('content_delta', { delta: event.delta });
        return { type: 'content', delta: event.delta, sessionId };
      case 'thinking_delta':
        traceRecorder?.addEvent('thinking_delta', { delta: event.delta });
        return this.options.includeThinking
          ? { type: 'thinking', delta: event.delta, sessionId }
          : null;
      case 'content':
        traceRecorder?.addEvent('content', { content: event.content });
        return { type: 'content', delta: event.content, sessionId };
      case 'thinking':
        traceRecorder?.addEvent('thinking', { content: event.content });
        return this.options.includeThinking
          ? { type: 'thinking', delta: event.content, sessionId }
          : null;
      case 'tool_start':
        return this.projectToolStart(event, sessionId, traceRecorder);
      case 'tool_progress':
        if (event.toolCall.type !== 'function') return null;
        traceRecorder?.addEvent(
          'tool_progress',
          {
            toolCallId: event.toolCall.id,
            name: event.toolCall.function.name,
            progress: event.progress,
          },
          this.toolSpans.get(event.toolCall.id),
        );
        return {
          type: 'tool_progress',
          id: ToolUseId(event.toolCall.id),
          name: event.toolCall.function.name,
          progress: event.progress,
          sessionId,
        };
      case 'tool_message':
        if (event.toolCall.type !== 'function') return null;
        traceRecorder?.addEvent(
          'tool_message',
          {
            toolCallId: event.toolCall.id,
            name: event.toolCall.function.name,
            content: event.content,
          },
          this.toolSpans.get(event.toolCall.id),
        );
        return {
          type: 'tool_message',
          id: ToolUseId(event.toolCall.id),
          name: event.toolCall.function.name,
          content: event.content,
          sessionId,
        };
      case 'tool_runtime_patch':
        if (event.toolCall.type !== 'function') return null;
        traceRecorder?.addEvent(
          'tool_runtime_patch',
          {
            toolCallId: event.toolCall.id,
            name: event.toolCall.function.name,
            patch: event.patch,
          },
          this.toolSpans.get(event.toolCall.id),
        );
        return {
          type: 'tool_runtime_patch',
          id: ToolUseId(event.toolCall.id),
          name: event.toolCall.function.name,
          patch: event.patch,
          sessionId,
        };
      case 'tool_context_patch':
        if (event.toolCall.type !== 'function') return null;
        traceRecorder?.addEvent(
          'tool_context_patch',
          {
            toolCallId: event.toolCall.id,
            name: event.toolCall.function.name,
            patch: event.patch,
          },
          this.toolSpans.get(event.toolCall.id),
        );
        return {
          type: 'tool_context_patch',
          id: ToolUseId(event.toolCall.id),
          name: event.toolCall.function.name,
          patch: event.patch,
          sessionId,
        };
      case 'tool_new_messages':
        if (event.toolCall.type !== 'function') return null;
        traceRecorder?.addEvent(
          'tool_new_messages',
          {
            toolCallId: event.toolCall.id,
            name: event.toolCall.function.name,
            messages: event.messages,
          },
          this.toolSpans.get(event.toolCall.id),
        );
        return {
          type: 'tool_new_messages',
          id: ToolUseId(event.toolCall.id),
          name: event.toolCall.function.name,
          messages: event.messages,
          sessionId,
        };
      case 'tool_permission_updates':
        if (event.toolCall.type !== 'function') return null;
        traceRecorder?.addEvent(
          'tool_permission_updates',
          {
            toolCallId: event.toolCall.id,
            name: event.toolCall.function.name,
            updates: event.updates,
          },
          this.toolSpans.get(event.toolCall.id),
        );
        return {
          type: 'tool_permission_updates',
          id: ToolUseId(event.toolCall.id),
          name: event.toolCall.function.name,
          updates: event.updates,
          sessionId,
        };
      case 'tool_result':
        return this.projectToolResult(event, sessionId, traceRecorder);
      case 'token_usage':
        this.usage = {
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          totalTokens: event.usage.totalTokens,
          maxContextTokens: event.usage.maxContextTokens,
        };
        traceRecorder?.recordUsage(this.usage);
        return null;
      case 'agent_start':
      case 'agent_end':
      case 'turn_retry':
      case 'stream_end':
      case 'budget_warning':
      case 'compacting':
      case 'todo_update':
      case 'api_retry':
      case 'model_fallback':
      case 'recovery':
      case 'error':
        return null;
    }
  }

  summary(): StreamSummary {
    return {
      toolCalls: this.toolCalls.map((toolCall) => ({ ...toolCall })),
      usage: { ...this.usage },
    };
  }

  private projectToolStart(
    event: Extract<AgentEvent, { type: 'tool_start' }>,
    sessionId: SessionId,
    traceRecorder?: TraceRecorder,
  ): SessionStreamEvent | null {
    if (event.toolCall.type !== 'function') return null;
    const input = safeParseJson(event.toolCall.function.arguments);
    this.toolCalls.push({
      id: ToolUseId(event.toolCall.id),
      name: event.toolCall.function.name,
      input,
      output: '',
      duration: 0,
    });
    const spanId = traceRecorder?.recordToolStart(
      ToolUseId(event.toolCall.id),
      event.toolCall.function.name,
      input,
    );
    if (spanId) {
      this.toolSpans.set(event.toolCall.id, spanId);
    }
    return {
      type: 'tool_use',
      id: ToolUseId(event.toolCall.id),
      name: event.toolCall.function.name,
      input,
      sessionId,
    };
  }

  private projectToolResult(
    event: Extract<AgentEvent, { type: 'tool_result' }>,
    sessionId: SessionId,
    traceRecorder?: TraceRecorder,
  ): SessionStreamEvent | null {
    if (event.toolCall.type !== 'function') return null;
    const record = this.toolCalls.find((toolCall) => toolCall.id === event.toolCall.id);
    if (record) {
      record.output = event.result.model;
      record.isError = event.result.status === 'error';
    }
    traceRecorder?.recordToolResult(
      this.toolSpans.get(event.toolCall.id),
      ToolUseId(event.toolCall.id),
      event.toolCall.function.name,
      event.result.model,
      event.result.status === 'error',
    );
    this.toolSpans.delete(event.toolCall.id);
    return {
      type: 'tool_result',
      id: ToolUseId(event.toolCall.id),
      name: event.toolCall.function.name,
      output: event.result.model,
      display: event.result.display,
      isError: event.result.status === 'error',
      sessionId,
    };
  }
}

function safeParseJson(value: string): JsonValue {
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return value;
  }
}
