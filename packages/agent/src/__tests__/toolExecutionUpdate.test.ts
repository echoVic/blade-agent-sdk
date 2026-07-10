import { describe, expectTypeOf, it } from 'vitest';
import type {
  AgentFunctionToolCall,
  AgentLoopToolExecutionOutcome,
  AgentToolExecutionOutcome,
  AgentToolExecutionUpdate,
  AgentToolExecutionUpdatePayloads,
} from '../loop/index.js';

declare module '../loop/toolUpdateToAgentEvent.js' {
  interface AgentLoopToolExecutionOutcome {
    compatibilityMarker?: 'agent-loop';
  }
}

interface CustomToolCall {
  id?: string;
  type: 'function';
  function: {
    name: 'search';
    arguments: string;
  };
}

interface CustomResult {
  matches: number;
}

interface CustomPayloads extends AgentToolExecutionUpdatePayloads {
  params: { query: string };
  runtimePatch: { cwd: string };
  contextPatch: { locale: string };
  newMessages: readonly [{ role: 'tool'; content: string }];
  permissionUpdates: readonly [{ capability: string }];
}

describe('tool execution update contracts', () => {
  it('preserves the legacy loop outcome as an augmentable interface', () => {
    expectTypeOf<AgentLoopToolExecutionOutcome['compatibilityMarker']>().toEqualTypeOf<
      'agent-loop' | undefined
    >();
  });

  it('defaults to the agent function call and unknown runtime payloads', () => {
    expectTypeOf<AgentToolExecutionOutcome['toolCall']>().toEqualTypeOf<
      AgentFunctionToolCall
    >();
    expectTypeOf<AgentToolExecutionOutcome['result']>().toEqualTypeOf<unknown>();
    expectTypeOf<
      Extract<AgentToolExecutionUpdate, { type: 'tool_started' }>['params']
    >().toEqualTypeOf<unknown>();
    expectTypeOf<
      Extract<AgentToolExecutionUpdate, { type: 'tool_runtime_patch' }>['patch']
    >().toEqualTypeOf<unknown>();
    expectTypeOf<
      Extract<AgentToolExecutionUpdate, { type: 'tool_new_messages' }>['messages']
    >().toEqualTypeOf<unknown>();
  });

  it('specializes tool calls, results, and runtime payloads independently', () => {
    type Outcome = AgentToolExecutionOutcome<CustomToolCall, CustomResult>;
    type Update = AgentToolExecutionUpdate<CustomToolCall, CustomResult, CustomPayloads>;

    expectTypeOf<Outcome['toolCall']>().toEqualTypeOf<CustomToolCall>();
    expectTypeOf<Outcome['result']>().toEqualTypeOf<CustomResult>();
    expectTypeOf<
      Extract<Update, { type: 'tool_started' }>['params']
    >().toEqualTypeOf<{ query: string }>();
    expectTypeOf<
      Extract<Update, { type: 'tool_runtime_patch' }>['patch']
    >().toEqualTypeOf<{ cwd: string }>();
    expectTypeOf<
      Extract<Update, { type: 'tool_context_patch' }>['patch']
    >().toEqualTypeOf<{ locale: string }>();
    expectTypeOf<
      Extract<Update, { type: 'tool_new_messages' }>['messages']
    >().toEqualTypeOf<readonly [{ role: 'tool'; content: string }]>();
    expectTypeOf<
      Extract<Update, { type: 'tool_permission_updates' }>['updates']
    >().toEqualTypeOf<readonly [{ capability: string }]>();
    expectTypeOf<
      Extract<Update, { type: 'tool_result' }>['outcome']
    >().toEqualTypeOf<Outcome>();
  });
});
