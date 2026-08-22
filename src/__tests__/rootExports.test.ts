import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  DurableEventEnvelope,
  DurableEventOfType,
  DurableEventStore,
  DurableSessionRecoveryPlan,
  InputSubmission,
  PendingSessionInput,
  RuntimePatch,
  SessionTool,
  ToolCatalogEntry,
  ToolEffect,
  ToolEffectYield,
  ToolExecution,
  ToolExecutionUpdate,
  ToolMessage,
  ToolProgress,
  ToolYield,
} from '../index.js';
import {
  CommandId,
  collectToolExecution,
  completeToolExecution,
  createMemoryReadTool,
  createMemoryWriteTool,
  DurableEventType,
  DurableSessionProjector,
  EventId,
  EventSequence,
  FileSystemMemoryStore,
  InputId,
  InputPriority,
  JsonlDurableEventStore,
  MemoryManager,
  PermissionRequestId,
  projectDurableSession,
  RequestId,
  SessionInputError,
  SubagentExecutor,
  SubagentRegistry,
  ToolAttemptId,
  ToolCatalog,
  ToolErrorType,
  TurnId,
} from '../index.js';

describe('root exports', () => {
  it('exports the opt-in memory, catalog, and subagent primitives', () => {
    expect(MemoryManager).toBeDefined();
    expect(FileSystemMemoryStore).toBeDefined();
    expect(createMemoryReadTool).toBeDefined();
    expect(createMemoryWriteTool).toBeDefined();
    expect(SubagentRegistry).toBeDefined();
    expect(SubagentExecutor).toBeDefined();
    expect(ToolCatalog).toBeDefined();
    expect(collectToolExecution).toBeTypeOf('function');
    expect(completeToolExecution).toBeTypeOf('function');
    expect(InputPriority.NEXT).toBe('next');
    expect(InputId('input-1')).toBe('input-1');
    expect(RequestId('request-1')).toBe('request-1');
    expect(new SessionInputError('TEST', 'message')).toBeInstanceOf(Error);
    expect(ToolErrorType.INTERRUPTED).toBe('interrupted');
    expect(DurableEventType.REQUEST_ACCEPTED).toBe('request_accepted');
    expect(JsonlDurableEventStore).toBeDefined();
    expect(CommandId('command-1')).toBe('command-1');
    expect(EventId('event-1')).toBe('event-1');
    expect(EventSequence(1)).toBe(1);
    expect(ToolAttemptId('attempt-1')).toBe('attempt-1');
    expect(TurnId('turn-1')).toBe('turn-1');
    expect(PermissionRequestId('permission-1')).toBe('permission-1');
    expect(DurableSessionProjector).toBeDefined();
    expect(projectDurableSession([]).status).toBe('empty');
  });

  it('exports runtime tool contracts at the root entrypoint', () => {
    expectTypeOf<RuntimePatch['scope']>().toEqualTypeOf<'turn' | 'session'>();
    expectTypeOf<ToolEffect['type']>().toEqualTypeOf<
      'runtimePatch' | 'contextPatch' | 'newMessages' | 'permissionUpdates'
    >();
    expectTypeOf<ToolYield['kind']>().toEqualTypeOf<'progress' | 'message' | 'effect'>();
    expectTypeOf<ToolProgress['kind']>().toEqualTypeOf<'progress'>();
    expectTypeOf<ToolMessage['kind']>().toEqualTypeOf<'message'>();
    expectTypeOf<ToolEffectYield['kind']>().toEqualTypeOf<'effect'>();
    expectTypeOf<ToolExecution>().toMatchTypeOf<AsyncGenerator<ToolYield, unknown, void>>();
    expectTypeOf<InputSubmission['status']>().toEqualTypeOf<'started' | 'steered' | 'queued'>();
    expectTypeOf<PendingSessionInput['priority']>().toEqualTypeOf<'now' | 'next' | 'later'>();
    expectTypeOf<ReturnType<typeof createMemoryReadTool>>().toMatchTypeOf<SessionTool>();
    expectTypeOf<DurableEventEnvelope['sequence']>().toEqualTypeOf<EventSequence>();
    expectTypeOf<
      DurableEventOfType<typeof DurableEventType.REQUEST_ACCEPTED>['data']['inputId']
    >().toEqualTypeOf<InputId>();
    expectTypeOf<DurableSessionRecoveryPlan['action']>().toEqualTypeOf<
      'none' | 'resume_request' | 'resume_turn' | 'resolve_permissions' | 'reconcile_tool_outcomes'
    >();
    expectTypeOf<DurableEventStore['append']>().toBeFunction();
    expectTypeOf<ToolCatalogEntry['source']['kind']>().toEqualTypeOf<
      'builtin' | 'custom' | 'mcp' | 'session'
    >();
    expectTypeOf<ToolExecutionUpdate['type']>().toEqualTypeOf<
      | 'tool_ready'
      | 'tool_started'
      | 'tool_progress'
      | 'tool_message'
      | 'tool_runtime_patch'
      | 'tool_context_patch'
      | 'tool_new_messages'
      | 'tool_permission_updates'
      | 'tool_result'
      | 'tool_completed'
    >();
  });
});
