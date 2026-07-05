import type { TraceRecorder } from '../observability/TraceRecorder.js';
import type { RuntimeContextPatch, RuntimePatch } from '../runtime/types.js';
import type { TokenUsage } from '../types/common.js';
import type {
  SessionId,
  SessionMessage,
  StreamMessage,
  ToolCallRecord,
} from './types.js';
import { parseJsonOrString } from './content.js';

interface LegacyFunctionToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface LegacyNonFunctionToolCall {
  id?: string;
  type: string;
}

type LegacyToolCall = LegacyFunctionToolCall | LegacyNonFunctionToolCall;

interface LegacyToolResult {
  success: boolean;
  llmContent: string | object;
}

export type LegacyStreamAgentEvent =
  | { type: 'turn_start'; turn: number; maxTurns?: number }
  | { type: 'turn_end'; turn: number }
  | { type: 'content_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'content'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_start'; toolCall: LegacyToolCall }
  | { type: 'tool_progress'; toolCall: LegacyToolCall; message: string }
  | { type: 'tool_message'; toolCall: LegacyToolCall; message: string }
  | { type: 'tool_runtime_patch'; toolCall: LegacyToolCall; patch: RuntimePatch }
  | { type: 'tool_context_patch'; toolCall: LegacyToolCall; patch: RuntimeContextPatch }
  | { type: 'tool_new_messages'; toolCall: LegacyToolCall; messages: SessionMessage[] }
  | {
      type: 'tool_permission_updates';
      toolCall: LegacyToolCall;
      updates: Extract<StreamMessage, { type: 'tool_permission_updates' }>['updates'];
    }
  | { type: 'tool_result'; toolCall: LegacyToolCall; result: LegacyToolResult }
  | { type: 'token_usage'; usage: TokenUsage };

export interface LegacyStreamEventProjectorOptions {
  sessionId: SessionId;
  includeThinking?: boolean;
  traceRecorder?: TraceRecorder;
}

function isFunctionToolCall(toolCall: LegacyToolCall): toolCall is LegacyFunctionToolCall {
  return toolCall.type === 'function';
}

function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    maxContextTokens: 0,
  };
}

export class LegacyStreamEventProjector {
  private readonly sessionId: SessionId;
  private readonly includeThinking: boolean;
  private readonly traceRecorder?: TraceRecorder;
  private readonly turnSpans = new Map<number, string>();
  private readonly toolSpans = new Map<string, string>();
  private readonly toolCalls: ToolCallRecord[] = [];
  private usage = emptyUsage();

  constructor(options: LegacyStreamEventProjectorOptions) {
    this.sessionId = options.sessionId;
    this.includeThinking = options.includeThinking ?? false;
    this.traceRecorder = options.traceRecorder;
  }

  project(event: LegacyStreamAgentEvent): StreamMessage | undefined {
    switch (event.type) {
      case 'turn_start':
        return this.projectTurnStart(event);
      case 'turn_end':
        return this.projectTurnEnd(event);
      case 'content_delta':
        this.traceRecorder?.addEvent('content_delta', { delta: event.delta });
        return { type: 'content', delta: event.delta, sessionId: this.sessionId };
      case 'thinking_delta':
        this.traceRecorder?.addEvent('thinking_delta', { delta: event.delta });
        return this.includeThinking
          ? { type: 'thinking', delta: event.delta, sessionId: this.sessionId }
          : undefined;
      case 'content':
        this.traceRecorder?.addEvent('content', { content: event.content });
        return { type: 'content', delta: event.content, sessionId: this.sessionId };
      case 'thinking':
        this.traceRecorder?.addEvent('thinking', { content: event.content });
        return this.includeThinking
          ? { type: 'thinking', delta: event.content, sessionId: this.sessionId }
          : undefined;
      case 'tool_start':
        return this.projectToolStart(event.toolCall);
      case 'tool_progress':
        return this.projectToolMessageLike('tool_progress', event.toolCall, {
          message: event.message,
        });
      case 'tool_message':
        return this.projectToolMessageLike('tool_message', event.toolCall, {
          message: event.message,
        });
      case 'tool_runtime_patch':
        return this.projectToolMessageLike('tool_runtime_patch', event.toolCall, {
          patch: event.patch,
        });
      case 'tool_context_patch':
        return this.projectToolMessageLike('tool_context_patch', event.toolCall, {
          patch: event.patch,
        });
      case 'tool_new_messages':
        return this.projectToolMessageLike('tool_new_messages', event.toolCall, {
          messages: event.messages,
        });
      case 'tool_permission_updates':
        return this.projectToolMessageLike('tool_permission_updates', event.toolCall, {
          updates: event.updates,
        });
      case 'tool_result':
        return this.projectToolResult(event.toolCall, event.result);
      case 'token_usage':
        this.usage = {
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          totalTokens: event.usage.totalTokens,
          maxContextTokens: event.usage.maxContextTokens,
        };
        this.traceRecorder?.recordUsage(this.usage);
        return undefined;
      default:
        return undefined;
    }
  }

  getUsage(): TokenUsage {
    return { ...this.usage };
  }

  getToolCalls(): ToolCallRecord[] {
    return this.toolCalls.map((toolCall) => ({ ...toolCall }));
  }

  private projectTurnStart(event: { turn: number; maxTurns?: number }): StreamMessage {
    const spanId = this.traceRecorder?.recordTurnStart(event.turn, event.maxTurns);
    if (spanId) {
      this.turnSpans.set(event.turn, spanId);
    }
    return { type: 'turn_start', turn: event.turn, sessionId: this.sessionId };
  }

  private projectTurnEnd(event: { turn: number }): StreamMessage {
    this.traceRecorder?.recordTurnEnd(this.turnSpans.get(event.turn), event.turn);
    this.turnSpans.delete(event.turn);
    return { type: 'turn_end', turn: event.turn, sessionId: this.sessionId };
  }

  private projectToolStart(toolCall: LegacyToolCall): StreamMessage | undefined {
    if (!isFunctionToolCall(toolCall)) {
      return undefined;
    }

    const input = parseJsonOrString(toolCall.function.arguments);
    this.toolCalls.push({
      id: toolCall.id,
      name: toolCall.function.name,
      input,
      output: '',
      duration: 0,
    });
    const spanId = this.traceRecorder?.recordToolStart(
      toolCall.id,
      toolCall.function.name,
      input,
    );
    if (spanId) {
      this.toolSpans.set(toolCall.id, spanId);
    }
    return {
      type: 'tool_use',
      id: toolCall.id,
      name: toolCall.function.name,
      input,
      sessionId: this.sessionId,
    };
  }

  private projectToolMessageLike(
    type:
      | 'tool_progress'
      | 'tool_message'
      | 'tool_runtime_patch'
      | 'tool_context_patch'
      | 'tool_new_messages'
      | 'tool_permission_updates',
    toolCall: LegacyToolCall,
    payload: Record<string, unknown>,
  ): StreamMessage | undefined {
    if (!isFunctionToolCall(toolCall)) {
      return undefined;
    }

    this.traceRecorder?.addEvent(
      type,
      {
        toolCallId: toolCall.id,
        name: toolCall.function.name,
        ...payload,
      },
      this.toolSpans.get(toolCall.id),
    );
    return {
      type,
      id: toolCall.id,
      name: toolCall.function.name,
      ...payload,
      sessionId: this.sessionId,
    } as StreamMessage;
  }

  private projectToolResult(
    toolCall: LegacyToolCall,
    result: LegacyToolResult,
  ): StreamMessage | undefined {
    if (!isFunctionToolCall(toolCall)) {
      return undefined;
    }

    const record = this.toolCalls.find((candidate) => candidate.id === toolCall.id);
    if (record) {
      record.output = result.llmContent;
      record.isError = !result.success;
    }
    this.traceRecorder?.recordToolResult(
      this.toolSpans.get(toolCall.id),
      toolCall.id,
      toolCall.function.name,
      result.llmContent,
      !result.success,
    );
    this.toolSpans.delete(toolCall.id);
    return {
      type: 'tool_result',
      id: toolCall.id,
      name: toolCall.function.name,
      output: result.llmContent,
      isError: !result.success,
      sessionId: this.sessionId,
    };
  }
}
