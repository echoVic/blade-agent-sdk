import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  AgentMiddlewareConfig,
  AgentPlugin,
  ConfirmationDetails,
  ConfirmationHandler,
  DurableAcceptedRequestRecovery,
  DurableCommandCommitOptions,
  DurableCommandEventDraft,
  DurableEventCursor,
  DurableEventEnvelope,
  DurableEventOfType,
  DurableEventStore,
  DurableEventSubscriptionMessage,
  DurableEventSubscriptionOptions,
  DurableExecutionFence,
  DurableExecutionLeaseOptions,
  DurableExecutionLeaseSnapshot,
  DurableExecutionLeaseStore,
  DurableModelAttemptProjection,
  DurableModelOutcomeReconciliationCommand,
  DurableRequestOutcomeReconciliationCommand,
  DurableRequestRecoveryKind,
  DurableRequestRecoveryOrigin,
  DurableRequestRolloverCommand,
  DurableRequestRolloverResult,
  DurableSessionCommand,
  DurableSessionProjection,
  DurableSessionRecoveryPlan,
  DurableSessionResumeDecision,
  DurableToolOutcomeReconciliationCommand,
  DurableToolStartCommand,
  DurableTurnRecoveryCommand,
  DurableTurnRecoveryResult,
  ExecutionContext,
  InputSubmission,
  ISession,
  ModelIdentity,
  PendingSessionInput,
  RuntimePatch,
  SessionHandoffErrorCode,
  SessionHandoffResult,
  SessionOptions,
  SessionTool,
  ToolCatalogEntry,
  ToolEffect,
  ToolEffectYield,
  ToolExecution,
  ToolExecutionLifecycle,
  ToolExecutionStartedLifecycle,
  ToolExecutionUpdate,
  ToolInvocationLifecycle,
  ToolMiddleware,
  ToolMessage,
  ToolPermissionResolution,
  ToolProgress,
  ToolResult,
  ToolScheduledLifecycle,
  ToolSettledLifecycle,
  ToolYield,
} from '../index.js';
import {
  CommandId,
  collectToolExecution,
  completeToolExecution,
  composeMiddleware,
  createMemoryReadTool,
  createMemoryWriteTool,
  DEFAULT_DURABLE_STORE_TIMEOUT_MS,
  DURABLE_EVENT_CURSOR_VERSION,
  DURABLE_EVENT_SCHEMA_VERSION,
  DURABLE_EXECUTION_LEASE_FORMAT,
  DurableCommandConflictError,
  DurableCommandOutcomeUnknownError,
  DurableEventSubscription,
  DurableEventSubscriptionError,
  DurableEventStoreTimeoutError,
  DurableEventType,
  DurableExecutionLease,
  DurableExecutionLeaseError,
  DurableExecutionLeaseTimeoutError,
  DurableSessionJournal,
  DurableSessionProjector,
  DurableSessionRecoveryCoordinator,
  DurableSessionRecoveryError,
  DurableSessionRecoveryRequiredError,
  definePlugin,
  durableEventCursor,
  EventId,
  EventSequence,
  ExecutionLeaseId,
  FencingToken,
  FileSystemMemoryStore,
  HookEvent,
  HookTimeoutError,
  InputId,
  InputPriority,
  JsonlDurableEventStore,
  MemoryManager,
  ModelAttemptId,
  ModelTimeoutError,
  PermissionRequestId,
  projectDurableSession,
  RequestId,
  SessionId,
  SessionDurableRecorderError,
  SessionHandoffError,
  SessionInputError,
  SubagentExecutor,
  SubagentRegistry,
  ToolAttemptId,
  ToolCatalog,
  ToolErrorType,
  ToolSideEffect,
  TurnId,
  WorkerId,
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
    expect(composeMiddleware).toBeTypeOf('function');
    expect(definePlugin({ name: 'test' })).toEqual({ name: 'test' });
    expect(new ModelTimeoutError('MODEL_REQUEST_TIMEOUT', 1000)).toMatchObject({
      code: 'MODEL_REQUEST_TIMEOUT',
      timeoutMs: 1000,
    });
    expect(new HookTimeoutError(HookEvent.PreToolUse, 1000)).toMatchObject({
      code: 'HOOK_TIMEOUT',
      event: HookEvent.PreToolUse,
      timeoutMs: 1000,
    });
    expect(InputPriority.NEXT).toBe('next');
    expect(InputId('input-1')).toBe('input-1');
    expect(RequestId('request-1')).toBe('request-1');
    expect(new SessionInputError('TEST', 'message')).toBeInstanceOf(Error);
    expect(ToolErrorType.INTERRUPTED).toBe('interrupted');
    expect(ToolSideEffect.NON_IDEMPOTENT).toBe('non_idempotent');
    expect(DURABLE_EVENT_SCHEMA_VERSION).toBe(3);
    expect(DURABLE_EVENT_CURSOR_VERSION).toBe(1);
    expect(DurableEventType.REQUEST_ACCEPTED).toBe('request_accepted');
    expect(DurableEventType.MODEL_REQUEST_STARTED).toBe('model_request_started');
    expect(DurableEventSubscription.open).toBeTypeOf('function');
    expect(DurableEventSubscriptionError).toBeDefined();
    expect(DEFAULT_DURABLE_STORE_TIMEOUT_MS).toBe(15_000);
    expect(
      new DurableEventStoreTimeoutError(
        'read',
        SessionId('timeout-session'),
        100,
      ),
    ).toMatchObject({
      code: 'DURABLE_EVENT_IO_TIMEOUT',
      operation: 'read',
      timeoutMs: 100,
    });
    expect(durableEventCursor).toBeTypeOf('function');
    expect(JsonlDurableEventStore).toBeDefined();
    expect(CommandId('command-1')).toBe('command-1');
    expect(EventId('event-1')).toBe('event-1');
    expect(EventSequence(1)).toBe(1);
    expect(ModelAttemptId('model-attempt-1')).toBe('model-attempt-1');
    expect(ToolAttemptId('attempt-1')).toBe('attempt-1');
    expect(TurnId('turn-1')).toBe('turn-1');
    expect(PermissionRequestId('permission-1')).toBe('permission-1');
    expect(DurableCommandConflictError).toBeDefined();
    expect(DurableCommandOutcomeUnknownError).toBeDefined();
    expect(DurableExecutionLease.acquire).toBeTypeOf('function');
    expect(DurableExecutionLease.prototype.runFenced).toBeTypeOf('function');
    expect(DurableExecutionLeaseError).toBeDefined();
    expect(
      new DurableExecutionLeaseTimeoutError('renew', 100, {
        sessionId: SessionId('timeout-session'),
      }),
    ).toMatchObject({
      code: 'DURABLE_EXECUTION_LEASE_TIMEOUT',
      operation: 'renew',
      timeoutMs: 100,
    });
    expect(DURABLE_EXECUTION_LEASE_FORMAT).toBe('blade.durable-execution-lease');
    expect(ExecutionLeaseId('lease-1')).toBe('lease-1');
    expect(FencingToken(1)).toBe(1);
    expect(WorkerId('worker-1')).toBe('worker-1');
    expect(DurableSessionJournal.open).toBeTypeOf('function');
    expect(DurableSessionProjector).toBeDefined();
    expect(DurableSessionRecoveryCoordinator.open).toBeTypeOf('function');
    expect(DurableSessionRecoveryError).toBeDefined();
    expect(DurableSessionRecoveryRequiredError).toBeDefined();
    expect(SessionDurableRecorderError).toBeDefined();
    expect(projectDurableSession([]).status).toBe('empty');
  });

  it('exports runtime tool contracts at the root entrypoint', () => {
    expectTypeOf<AgentPlugin['middleware']>().toEqualTypeOf<AgentMiddlewareConfig | undefined>();
    expectTypeOf<
      NonNullable<AgentMiddlewareConfig['tool']>[number]
    >().toEqualTypeOf<ToolMiddleware>();
    expectTypeOf<RuntimePatch['scope']>().toEqualTypeOf<'turn' | 'session'>();
    expectTypeOf<ToolEffect['type']>().toEqualTypeOf<
      'runtimePatch' | 'contextPatch' | 'newMessages' | 'permissionUpdates'
    >();
    expectTypeOf<ToolYield['kind']>().toEqualTypeOf<'progress' | 'message' | 'effect'>();
    expectTypeOf<ToolProgress['kind']>().toEqualTypeOf<'progress'>();
    expectTypeOf<ToolMessage['kind']>().toEqualTypeOf<'message'>();
    expectTypeOf<ToolEffectYield['kind']>().toEqualTypeOf<'effect'>();
    expectTypeOf<ToolExecution>().toMatchTypeOf<AsyncGenerator<ToolYield, unknown, void>>();
    expectTypeOf<NonNullable<ToolExecutionLifecycle['onToolScheduled']>>().toBeFunction();
    expectTypeOf<ToolExecutionStartedLifecycle['sideEffect']>().toEqualTypeOf<
      'pure' | 'idempotent' | 'non_idempotent'
    >();
    expectTypeOf<NonNullable<ToolInvocationLifecycle['onExecutionStarted']>>().toBeFunction();
    expectTypeOf<ToolPermissionResolution['decision']>().toEqualTypeOf<
      'allow' | 'deny' | 'cancel'
    >();
    expectTypeOf<ConfirmationDetails['abortSignal']>().toEqualTypeOf<
      AbortSignal | undefined
    >();
    expectTypeOf<ConfirmationHandler['requestConfirmation']>().toBeFunction();
    expectTypeOf<ToolScheduledLifecycle['interruptBehavior']>().toEqualTypeOf<'block' | 'cancel'>();
    expectTypeOf<ToolScheduledLifecycle['sideEffect']>().toEqualTypeOf<
      'pure' | 'idempotent' | 'non_idempotent'
    >();
    expectTypeOf<ToolSettledLifecycle['result']>().toEqualTypeOf<ToolResult>();
    expectTypeOf<InputSubmission['status']>().toEqualTypeOf<'started' | 'steered' | 'queued'>();
    expectTypeOf<PendingSessionInput['priority']>().toEqualTypeOf<'now' | 'next' | 'later'>();
    expectTypeOf<ModelIdentity['api']>().toEqualTypeOf<
      'anthropic' | 'openai' | 'azure-openai' | 'gemini' | 'deepseek' | 'openai-compatible'
    >();
    expectTypeOf<ReturnType<typeof createMemoryReadTool>>().toMatchTypeOf<SessionTool>();
    expectTypeOf<DurableEventEnvelope['sequence']>().toEqualTypeOf<EventSequence>();
    expectTypeOf<DurableEventCursor['eventId']>().toEqualTypeOf<EventId>();
    expectTypeOf<DurableEventSubscriptionMessage['type']>().toEqualTypeOf<'event' | 'caught_up'>();
    expectTypeOf<DurableEventSubscriptionOptions['follow']>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<SessionOptions['durableStoreTimeoutMs']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<
      DurableEventOfType<typeof DurableEventType.REQUEST_ACCEPTED>['data']['inputId']
    >().toEqualTypeOf<InputId>();
    expectTypeOf<
      DurableSessionCommand['events'][number]
    >().toEqualTypeOf<DurableCommandEventDraft>();
    expectTypeOf<DurableSessionRecoveryPlan['action']>().toEqualTypeOf<
      | 'none'
      | 'resume_request'
      | 'rollover_request'
      | 'resume_turn'
      | 'resolve_permissions'
      | 'reconcile_tool_outcomes'
      | 'reconcile_model_outcome'
      | 'reconcile_request_inputs'
      | 'reconcile_request_outcome'
    >();
    expectTypeOf<DurableSessionResumeDecision['action']>().toEqualTypeOf<
      'ready' | 'resume_accepted_request' | 'recovery_required'
    >();
    expectTypeOf<DurableAcceptedRequestRecovery['model']>().toEqualTypeOf<string>();
    expectTypeOf<DurableRequestRecoveryOrigin['turnId']>().toEqualTypeOf<TurnId>();
    expectTypeOf<DurableRequestRecoveryKind>().toEqualTypeOf<'turn' | 'pre_turn_request'>();
    expectTypeOf<DurableModelAttemptProjection['modelAttemptId']>().toEqualTypeOf<
      ReturnType<typeof ModelAttemptId>
    >();
    expectTypeOf<DurableModelAttemptProjection['provider']>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<DurableModelOutcomeReconciliationCommand['modelAttemptId']>().toEqualTypeOf<
      ReturnType<typeof ModelAttemptId>
    >();
    expectTypeOf<DurableRequestRolloverCommand['inputId']>().toEqualTypeOf<InputId>();
    expectTypeOf<DurableRequestRolloverCommand['sourceLastTurn']>().toEqualTypeOf<number>();
    expectTypeOf<DurableRequestRolloverCommand['recoveryTurnId']>().toEqualTypeOf<TurnId>();
    expectTypeOf<DurableRequestRolloverCommand['preparation']['appliedInputIds']>().toEqualTypeOf<
      readonly InputId[]
    >();
    expectTypeOf<DurableRequestRolloverResult['recoveryRequestId']>().toEqualTypeOf<RequestId>();
    expectTypeOf<DurableSessionProjection['reconciledInputIds']>().toEqualTypeOf<
      readonly InputId[] | undefined
    >();
    expectTypeOf<
      DurableRequestOutcomeReconciliationCommand['requestId']
    >().toEqualTypeOf<RequestId>();
    expectTypeOf<
      DurableRequestOutcomeReconciliationCommand['lastTurnEventId']
    >().toEqualTypeOf<EventId>();
    expectTypeOf<
      DurableToolOutcomeReconciliationCommand['toolAttemptId']
    >().toEqualTypeOf<ToolAttemptId>();
    expectTypeOf<DurableToolStartCommand['commandId']>().toEqualTypeOf<CommandId>();
    expectTypeOf<DurableTurnRecoveryCommand['recoveryInputId']>().toEqualTypeOf<InputId>();
    expectTypeOf<DurableTurnRecoveryCommand['turnId']>().toEqualTypeOf<TurnId>();
    expectTypeOf<DurableTurnRecoveryResult['recoveryRequestId']>().toEqualTypeOf<RequestId>();
    expectTypeOf<DurableCommandCommitOptions['expectedHeadSequence']>().toEqualTypeOf<
      EventSequence | null | undefined
    >();
    expectTypeOf<DurableEventStore['append']>().toBeFunction();
    expectTypeOf<DurableExecutionLeaseStore['acquireExecutionLease']>().toBeFunction();
    expectTypeOf<DurableExecutionLeaseStore['withExecutionLease']>().toBeFunction();
    expectTypeOf<DurableExecutionFence['fencingToken']>().toEqualTypeOf<
      ReturnType<typeof FencingToken>
    >();
    expectTypeOf<DurableExecutionLeaseSnapshot['ownerId']>().toEqualTypeOf<
      ReturnType<typeof WorkerId>
    >();
    expectTypeOf<DurableExecutionLeaseOptions['leaseId']>().toEqualTypeOf<
      ReturnType<typeof ExecutionLeaseId> | undefined
    >();
    expectTypeOf<SessionOptions['durableEventStore']>().toEqualTypeOf<
      DurableEventStore | undefined
    >();
    expectTypeOf<SessionOptions['executionLease']>().toEqualTypeOf<
      DurableExecutionLeaseOptions | undefined
    >();
    expectTypeOf<ExecutionContext['executionFence']>().toEqualTypeOf<
      DurableExecutionFence | undefined
    >();
    expectTypeOf<
      ReturnType<ISession['getExecutionLease']>
    >().toEqualTypeOf<DurableExecutionLeaseSnapshot | null>();
    expectTypeOf<ReturnType<ISession['abort']>>().toEqualTypeOf<Promise<void>>();
    expectTypeOf<ReturnType<ISession['suspendForHandoff']>>().toEqualTypeOf<
      Promise<SessionHandoffResult>
    >();
    expectTypeOf<SessionHandoffResult['headSequence']>().toEqualTypeOf<EventSequence>();
    expectTypeOf<SessionHandoffErrorCode>().toEqualTypeOf<
      | 'SESSION_HANDOFF_NOT_CONFIGURED'
      | 'SESSION_HANDOFF_ACTIVE_WORK'
      | 'SESSION_HANDOFF_UNAVAILABLE'
    >();
    expect(SessionHandoffError).toBeDefined();
    expectTypeOf<ReturnType<ISession['subscribeDurableEvents']>>().toEqualTypeOf<
      Promise<DurableEventSubscription>
    >();
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
