import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  FunctionToolCall,
  ToolEffect,
  ToolExecutionOutcome,
  ToolExecutionOutcomeOf,
  ToolExecutionUpdate,
  ToolExecutionUpdateOf,
  ToolResult,
} from '../tools/index.js';
import type { JsonObject } from '../types/common.js';

declare module '../tools/types/index.js' {
  interface ToolExecutionOutcome {
    compatibilityMarker?: 'agent-sdk';
  }
}

type LegacyToolExecutionUpdate =
  | { type: 'tool_ready'; toolCall: FunctionToolCall }
  | {
      type: 'tool_started';
      toolCall: FunctionToolCall;
      params: JsonObject;
      toolUseUuid: string | null;
    }
  | { type: 'tool_progress'; toolCall: FunctionToolCall; message: string }
  | { type: 'tool_message'; toolCall: FunctionToolCall; message: string }
  | {
      type: 'tool_runtime_patch';
      toolCall: FunctionToolCall;
      patch: Extract<ToolEffect, { type: 'runtimePatch' }>['patch'];
    }
  | {
      type: 'tool_context_patch';
      toolCall: FunctionToolCall;
      patch: Extract<ToolEffect, { type: 'contextPatch' }>['patch'];
    }
  | {
      type: 'tool_new_messages';
      toolCall: FunctionToolCall;
      messages: Extract<ToolEffect, { type: 'newMessages' }>['messages'];
    }
  | {
      type: 'tool_permission_updates';
      toolCall: FunctionToolCall;
      updates: Extract<ToolEffect, { type: 'permissionUpdates' }>['updates'];
    }
  | { type: 'tool_result'; outcome: ToolExecutionOutcome }
  | { type: 'tool_completed'; outcome: ToolExecutionOutcome };

type RequiredIdToolCall = FunctionToolCall & { id: string };

// @ts-expect-error SDK specializations must remain function-tool-call shaped.
type _InvalidToolExecutionUpdate = ToolExecutionUpdateOf<string>;

describe('SDK tool execution update contracts', () => {
  it('preserves the legacy outcome interface and complete update union', () => {
    expectTypeOf<ToolExecutionOutcome['compatibilityMarker']>().toEqualTypeOf<
      'agent-sdk' | undefined
    >();
    expectTypeOf<ToolExecutionUpdate>().toEqualTypeOf<LegacyToolExecutionUpdate>();
    expectTypeOf<LegacyToolExecutionUpdate>().toEqualTypeOf<ToolExecutionUpdate>();
    expectTypeOf<ToolExecutionOutcomeOf<RequiredIdToolCall>['toolCall']>().toEqualTypeOf<
      RequiredIdToolCall
    >();
  });

  it('keeps optional-id function tool calls in the default public update type', () => {
    const toolCall: FunctionToolCall = {
      type: 'function',
      function: {
        name: 'search',
        arguments: '{}',
      },
    };
    const update: ToolExecutionUpdate = {
      type: 'tool_ready',
      toolCall,
    };

    expect(update.toolCall).not.toHaveProperty('id');
    expectTypeOf<ToolExecutionOutcome['toolCall']>().toEqualTypeOf<FunctionToolCall>();
    expectTypeOf<ToolExecutionOutcome['result']>().toEqualTypeOf<ToolResult>();
    expectTypeOf(update.toolCall).toEqualTypeOf<FunctionToolCall>();
    expectTypeOf<
      Extract<ToolExecutionUpdate, { type: 'tool_runtime_patch' }>['patch']
    >().toEqualTypeOf<Extract<ToolEffect, { type: 'runtimePatch' }>['patch']>();
    expectTypeOf<
      Extract<ToolExecutionUpdate, { type: 'tool_context_patch' }>['patch']
    >().toEqualTypeOf<Extract<ToolEffect, { type: 'contextPatch' }>['patch']>();
    expectTypeOf<
      Extract<ToolExecutionUpdate, { type: 'tool_new_messages' }>['messages']
    >().toEqualTypeOf<Extract<ToolEffect, { type: 'newMessages' }>['messages']>();
    expectTypeOf<
      Extract<ToolExecutionUpdate, { type: 'tool_permission_updates' }>['updates']
    >().toEqualTypeOf<Extract<ToolEffect, { type: 'permissionUpdates' }>['updates']>();
  });
});
