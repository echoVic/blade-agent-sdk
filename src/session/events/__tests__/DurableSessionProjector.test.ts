import { describe, expect, it } from 'vitest';
import {
  CommandId,
  EventId,
  EventSequence,
  InputId,
  PermissionRequestId,
  RequestId,
  SessionId,
  ToolAttemptId,
  ToolUseId,
  TurnId,
} from '../../../types/branded.js';
import {
  DurableEventProjectionError,
  DurableSessionProjector,
  planDurableSessionRecovery,
  projectDurableSession,
} from '../DurableSessionProjector.js';
import { parseDurableEventEnvelope } from '../schemas.js';
import {
  DURABLE_EVENT_SCHEMA_VERSION,
  type DurableEventDraft,
  type DurableEventEnvelope,
  DurableEventType,
} from '../types.js';

const sessionId = SessionId('session-1');
const requestId = RequestId('request-1');
const commandId = CommandId('command-1');
const initialInputId = InputId('input-1');
const turnId = TurnId('turn-1');
const toolAttemptId = ToolAttemptId('attempt-1');
const toolCallId = ToolUseId('call-1');
const permissionRequestId = PermissionRequestId('permission-1');
const recoveryRequestId = RequestId('request-recovery');
const recoveryInputId = InputId('input-recovery');
const recoveryCommandId = CommandId('recovery-command');
const timestamp = '2026-08-22T12:00:00.000Z';

function envelopes(
  drafts: readonly DurableEventDraft[],
  options: {
    session?: SessionId;
    eventIdForIndex?: (index: number) => EventId;
  } = {},
): DurableEventEnvelope[] {
  return drafts.map((draft, index) =>
    parseDurableEventEnvelope({
      ...draft,
      schemaVersion: DURABLE_EVENT_SCHEMA_VERSION,
      eventId: options.eventIdForIndex?.(index) ?? EventId(`event-${index + 1}`),
      sequence: EventSequence(index + 1),
      sessionId: options.session ?? sessionId,
      recordedAt: timestamp,
      occurredAt: draft.occurredAt ?? timestamp,
    }),
  );
}

function requestPrefix(): DurableEventDraft[] {
  return [
    {
      type: DurableEventType.SESSION_CREATED,
      data: { source: 'create' },
    },
    {
      type: DurableEventType.REQUEST_ACCEPTED,
      requestId,
      commandId,
      data: {
        inputId: initialInputId,
        input: 'Build the feature',
        priority: 'next',
      },
    },
    {
      type: DurableEventType.INPUT_APPLIED,
      requestId,
      data: {
        inputId: initialInputId,
        priority: 'next',
      },
    },
    {
      type: DurableEventType.REQUEST_STARTED,
      requestId,
      data: {},
    },
  ];
}

function turnPrefix(): DurableEventDraft[] {
  return [
    ...requestPrefix(),
    {
      type: DurableEventType.TURN_STARTED,
      requestId,
      turnId,
      data: { turn: 1, model: 'claude-sonnet' },
    },
  ];
}

function toolScheduled(
  sideEffect: 'pure' | 'idempotent' | 'non_idempotent' = 'non_idempotent',
): DurableEventDraft {
  return {
    type: DurableEventType.TOOL_SCHEDULED,
    requestId,
    turnId,
    toolAttemptId,
    data: {
      toolCallId,
      toolName: 'Write',
      input: { file_path: '/tmp/file' },
      sideEffect,
      interruptBehavior: 'block',
    },
  };
}

function permissionRequested(): DurableEventDraft {
  return {
    type: DurableEventType.PERMISSION_REQUESTED,
    requestId,
    turnId,
    toolAttemptId,
    data: {
      permissionRequestId,
      toolCallId,
      toolName: 'Write',
      input: { file_path: '/tmp/file' },
      message: 'Allow write?',
    },
  };
}

function project(drafts: readonly DurableEventDraft[]) {
  return projectDurableSession(envelopes(drafts));
}

describe('DurableSessionProjector', () => {
  it('projects a complete session lifecycle', () => {
    const projection = project([
      ...turnPrefix(),
      toolScheduled(),
      permissionRequested(),
      {
        type: DurableEventType.PERMISSION_RESOLVED,
        requestId,
        turnId,
        toolAttemptId,
        data: { permissionRequestId, decision: 'allow' },
      },
      {
        type: DurableEventType.TOOL_STARTED,
        requestId,
        turnId,
        toolAttemptId,
        data: {
          toolCallId,
          toolName: 'Write',
          input: { file_path: '/tmp/file' },
          sideEffect: 'non_idempotent',
        },
      },
      {
        type: DurableEventType.TOOL_COMPLETED,
        requestId,
        turnId,
        toolAttemptId,
        data: {
          toolCallId,
          toolName: 'Write',
          result: { changed: true },
        },
      },
      {
        type: DurableEventType.TURN_COMPLETED,
        requestId,
        turnId,
        data: { turn: 1, hasToolCalls: true },
      },
      {
        type: DurableEventType.REQUEST_COMPLETED,
        requestId,
        data: {
          output: 'done',
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        },
      },
      {
        type: DurableEventType.SESSION_CLOSED,
        data: { reason: 'completed' },
      },
    ]);

    expect(projection).toMatchObject({
      sessionId,
      status: 'closed',
      headSequence: 13,
      lastEventId: 'event-13',
      closeReason: 'completed',
      activeRequest: null,
      appliedInputIds: [initialInputId],
      acceptedCommandIds: [commandId],
    });
    expect(planDurableSessionRecovery(projection).action).toBe('none');
  });

  it('projects cursor pages incrementally without changing the result', () => {
    const events = envelopes(turnPrefix());
    const projector = new DurableSessionProjector();

    projector.apply(events.slice(0, 2));
    projector.apply(events.slice(2));

    expect(projector.snapshot()).toEqual(projectDurableSession(events));
    expect(projector.recoveryPlan()).toMatchObject({
      action: 'resume_turn',
      requestId,
      turnId,
    });
  });

  it('returns defensive snapshots that cannot mutate projector state', () => {
    const projector = new DurableSessionProjector().apply(
      envelopes([...turnPrefix(), toolScheduled()]),
    );
    const first = projector.snapshot();
    const tool = first.activeRequest?.activeTurn?.toolAttempts[0];
    if (
      !tool ||
      typeof tool.input !== 'object' ||
      tool.input === null ||
      Array.isArray(tool.input)
    ) {
      throw new Error('Expected object tool input');
    }
    (tool.input as { file_path: string }).file_path = '/mutated';

    expect(projector.snapshot().activeRequest?.activeTurn?.toolAttempts[0]?.input).toEqual({
      file_path: '/tmp/file',
    });
  });

  it('previews drafts on an isolated fork without mutating canonical state', () => {
    const projector = new DurableSessionProjector().apply(envelopes(requestPrefix().slice(0, 2)));

    const preview = projector.preview(sessionId, [
      {
        type: DurableEventType.REQUEST_STARTED,
        requestId,
        data: {},
      },
    ]);

    expect(preview.activeRequest?.status).toBe('running');
    expect(preview.headSequence).toBe(3);
    expect(projector.snapshot().activeRequest?.status).toBe('accepted');
    expect(projector.snapshot().headSequence).toBe(2);
  });

  it('rejects an invalid preview without poisoning the canonical projector', () => {
    const projector = new DurableSessionProjector().apply(envelopes(requestPrefix().slice(0, 2)));

    expect(() =>
      projector.preview(sessionId, [
        {
          type: DurableEventType.TURN_STARTED,
          requestId,
          turnId,
          data: { turn: 1 },
        },
      ]),
    ).toThrow(/has not started/);

    expect(projector.snapshot().activeRequest?.status).toBe('accepted');
  });

  it('requires latest-boundary causation for new standalone Request terminal writes', () => {
    const projector = new DurableSessionProjector().apply(
      envelopes([
        ...turnPrefix(),
        {
          type: DurableEventType.TURN_COMPLETED,
          requestId,
          turnId,
          data: { turn: 1, hasToolCalls: false },
        },
      ]),
    );
    const lastTurnEventId = projector.snapshot().activeRequest?.lastTurnEventId;
    if (!lastTurnEventId) {
      throw new Error('Expected terminal Turn event');
    }

    expect(() =>
      projector.preview(sessionId, [
        {
          type: DurableEventType.REQUEST_COMPLETED,
          requestId,
          data: {},
        },
      ]),
    ).toThrow(/requires latest-boundary causation/);
    expect(
      projector.preview(sessionId, [
        {
          type: DurableEventType.REQUEST_COMPLETED,
          requestId,
          causationEventId: lastTurnEventId,
          data: {},
        },
      ]).activeRequest,
    ).toBeNull();
  });

  it('rejects last-Turn causation after an input application advances the boundary', () => {
    const projector = new DurableSessionProjector().apply(
      envelopes([
        ...turnPrefix(),
        {
          type: DurableEventType.TURN_COMPLETED,
          requestId,
          turnId,
          data: { turn: 1, hasToolCalls: false },
        },
        {
          type: DurableEventType.INPUT_APPLIED,
          requestId,
          data: {
            inputId: InputId('latest-boundary-input'),
            priority: 'next',
          },
        },
      ]),
    );
    const projection = projector.snapshot();
    const lastTurnEventId = projection.activeRequest?.lastTurnEventId;
    const lastBoundaryEventId = projection.lastEventId;
    if (!lastTurnEventId || !lastBoundaryEventId) {
      throw new Error('Expected Turn and input boundary events');
    }

    expect(() =>
      projector.preview(sessionId, [
        {
          type: DurableEventType.REQUEST_FAILED,
          requestId,
          causationEventId: lastTurnEventId,
          data: { error: { message: 'stale completion' } },
        },
      ]),
    ).toThrow(/requires latest-boundary causation/);
    expect(
      projector.preview(sessionId, [
        {
          type: DurableEventType.REQUEST_FAILED,
          requestId,
          causationEventId: lastBoundaryEventId,
          data: { error: { message: 'preparation failed' } },
        },
      ]).activeRequest,
    ).toBeNull();
  });

  it('rejects new input application while a Turn is active', () => {
    const projector = new DurableSessionProjector().apply(envelopes(turnPrefix()));

    expect(() =>
      projector.preview(sessionId, [
        {
          type: DurableEventType.INPUT_APPLIED,
          requestId,
          turnId,
          data: {
            inputId: InputId('new-active-turn-input'),
            priority: 'next',
          },
        },
      ]),
    ).toThrow(/requires a completed or aborted Turn/);
  });

  it('distinguishes accepted, pre-turn, post-turn, and active-turn recovery', () => {
    const accepted = project([
      requestPrefix()[0] as DurableEventDraft,
      {
        type: DurableEventType.REQUEST_ACCEPTED,
        requestId,
        commandId,
        data: {
          inputId: initialInputId,
          input: 'Build the feature',
          priority: 'next',
          maxTurns: 12,
          model: 'request-model',
          context: { id: 'request-context' },
        },
      },
    ]);
    expect(accepted.activeRequest).toMatchObject({
      acceptedAt: timestamp,
      maxTurns: 12,
      model: 'request-model',
      context: { id: 'request-context' },
    });
    expect(planDurableSessionRecovery(accepted)).toMatchObject({
      action: 'resume_request',
      requestId,
      turnId: null,
    });

    const acceptedWithAppliedInput = project([
      ...requestPrefix().slice(0, 2),
      {
        type: DurableEventType.INPUT_APPLIED,
        requestId,
        data: {
          inputId: InputId('accepted-steering-input'),
          priority: 'next',
        },
      },
    ]);
    expect(planDurableSessionRecovery(acceptedWithAppliedInput)).toMatchObject({
      action: 'reconcile_request_inputs',
      requestId,
      turnId: null,
    });

    const startedWithoutTurn = project(requestPrefix());
    expect(planDurableSessionRecovery(startedWithoutTurn)).toMatchObject({
      action: 'rollover_request',
      requestId,
      turnId: null,
    });

    const startedWithoutAppliedInput = project([
      ...requestPrefix().slice(0, 2),
      {
        type: DurableEventType.REQUEST_STARTED,
        requestId,
        data: {},
      },
    ]);
    expect(planDurableSessionRecovery(startedWithoutAppliedInput)).toMatchObject({
      action: 'reconcile_request_inputs',
      requestId,
      turnId: null,
    });

    const startedWithSteeringInput = project([
      ...requestPrefix(),
      {
        type: DurableEventType.INPUT_APPLIED,
        requestId,
        data: {
          inputId: InputId('steering-input'),
          priority: 'next',
        },
      },
    ]);
    expect(planDurableSessionRecovery(startedWithSteeringInput)).toMatchObject({
      action: 'reconcile_request_inputs',
      requestId,
      turnId: null,
    });

    const activeTurn = project(turnPrefix());
    expect(planDurableSessionRecovery(activeTurn)).toMatchObject({
      action: 'resume_turn',
      requestId,
      turnId,
      retryableToolAttempts: [],
      unknownToolAttempts: [],
    });

    const completedTurn = project([
      ...turnPrefix(),
      {
        type: DurableEventType.TURN_COMPLETED,
        requestId,
        turnId,
        data: { turn: 1, hasToolCalls: false },
      },
    ]);
    expect(planDurableSessionRecovery(completedTurn)).toMatchObject({
      action: 'reconcile_request_outcome',
      requestId,
      turnId: null,
    });

    const betweenTurnsInput = project([
      ...turnPrefix(),
      {
        type: DurableEventType.TURN_COMPLETED,
        requestId,
        turnId,
        data: { turn: 1, hasToolCalls: false },
      },
      {
        type: DurableEventType.INPUT_APPLIED,
        requestId,
        data: {
          inputId: InputId('between-turns-input'),
          priority: 'next',
        },
      },
    ]);
    expect(planDurableSessionRecovery(betweenTurnsInput)).toMatchObject({
      action: 'reconcile_request_inputs',
      requestId,
      turnId: null,
    });

    const legacyPreparedBeforeTurnEnd = project([
      ...turnPrefix(),
      {
        type: DurableEventType.INPUT_APPLIED,
        requestId,
        turnId,
        data: {
          inputId: InputId('legacy-between-turns-input'),
          priority: 'next',
        },
      },
      {
        type: DurableEventType.TURN_COMPLETED,
        requestId,
        turnId,
        data: { turn: 1, hasToolCalls: false },
      },
    ]);
    expect(planDurableSessionRecovery(legacyPreparedBeforeTurnEnd)).toMatchObject({
      action: 'reconcile_request_inputs',
      requestId,
      turnId: null,
    });
  });

  it('validates and projects canonical pre-turn Request recovery provenance', () => {
    const requestRecoveryCommandId = CommandId('request-recovery-command');
    const requestRecoveryTurnId = TurnId('request-recovery-turn');
    const recovered = project([
      ...requestPrefix(),
      {
        type: DurableEventType.TURN_STARTED,
        requestId,
        turnId: requestRecoveryTurnId,
        commandId: requestRecoveryCommandId,
        data: { turn: 1, model: 'request-model' },
      },
      {
        type: DurableEventType.TURN_ABORTED,
        requestId,
        turnId: requestRecoveryTurnId,
        commandId: requestRecoveryCommandId,
        data: { turn: 1, reason: 'process_restart' },
      },
      {
        type: DurableEventType.REQUEST_INTERRUPTED,
        requestId,
        commandId: requestRecoveryCommandId,
        data: { reason: 'process_restart' },
      },
      {
        type: DurableEventType.REQUEST_ACCEPTED,
        requestId: recoveryRequestId,
        commandId: requestRecoveryCommandId,
        data: {
          inputId: recoveryInputId,
          input: 'continue',
          priority: 'next',
          recovery: {
            requestId,
            turnId: requestRecoveryTurnId,
            turn: 1,
          },
        },
      },
    ]);

    expect(recovered.activeRequest).toMatchObject({
      requestId: recoveryRequestId,
      recovery: {
        requestId,
        turnId: requestRecoveryTurnId,
        turn: 1,
      },
      recoveryKind: 'pre_turn_request',
      reconciledInputIds: [initialInputId],
    });
    expect(recovered.reconciledInputIds).toEqual([initialInputId]);

    const steeringInputId = InputId('steering-input');
    const reconciled = project([
      ...requestPrefix(),
      {
        type: DurableEventType.INPUT_APPLIED,
        requestId,
        data: {
          inputId: steeringInputId,
          priority: 'next',
        },
      },
      {
        type: DurableEventType.TURN_STARTED,
        requestId,
        turnId: requestRecoveryTurnId,
        commandId: requestRecoveryCommandId,
        data: { turn: 1, model: 'request-model' },
      },
      {
        type: DurableEventType.TURN_ABORTED,
        requestId,
        turnId: requestRecoveryTurnId,
        commandId: requestRecoveryCommandId,
        data: { turn: 1, reason: 'process_restart' },
      },
      {
        type: DurableEventType.REQUEST_INTERRUPTED,
        requestId,
        commandId: requestRecoveryCommandId,
        data: { reason: 'process_restart' },
      },
      {
        type: DurableEventType.REQUEST_ACCEPTED,
        requestId: recoveryRequestId,
        commandId: requestRecoveryCommandId,
        data: {
          inputId: recoveryInputId,
          input: 'continue',
          priority: 'next',
          recovery: {
            requestId,
            turnId: requestRecoveryTurnId,
            turn: 1,
          },
        },
      },
    ]);
    expect(reconciled.activeRequest).toMatchObject({
      recoveryKind: 'pre_turn_request',
      reconciledInputIds: [initialInputId, steeringInputId],
    });
    expect(reconciled.reconciledInputIds).toEqual([initialInputId, steeringInputId]);
  });

  it('validates and projects canonical turn recovery provenance', () => {
    const recovered = project([
      ...turnPrefix(),
      {
        type: DurableEventType.TURN_ABORTED,
        requestId,
        turnId,
        commandId: recoveryCommandId,
        data: { turn: 1, reason: 'process_restart' },
      },
      {
        type: DurableEventType.REQUEST_INTERRUPTED,
        requestId,
        commandId: recoveryCommandId,
        data: { reason: 'process_restart' },
      },
      {
        type: DurableEventType.REQUEST_ACCEPTED,
        requestId: recoveryRequestId,
        commandId: recoveryCommandId,
        data: {
          inputId: recoveryInputId,
          input: 'continue',
          priority: 'next',
          maxTurns: 12,
          model: 'request-model',
          context: {},
          recovery: {
            requestId,
            turnId,
            turn: 1,
          },
        },
      },
    ]);

    expect(recovered.activeRequest).toMatchObject({
      requestId: recoveryRequestId,
      recovery: {
        requestId,
        turnId,
        turn: 1,
      },
    });

    expect(() =>
      project([
        {
          type: DurableEventType.SESSION_CREATED,
          data: { source: 'create' },
        },
        {
          type: DurableEventType.REQUEST_ACCEPTED,
          requestId: recoveryRequestId,
          commandId: CommandId('invalid-recovery'),
          data: {
            inputId: recoveryInputId,
            input: 'continue',
            priority: 'next',
            recovery: {
              requestId,
              turnId,
              turn: 1,
            },
          },
        },
      ]),
    ).toThrow(/not an atomic canonical rollover/);

    expect(() =>
      project([
        ...turnPrefix(),
        {
          type: DurableEventType.TURN_ABORTED,
          requestId,
          turnId,
          commandId: CommandId('terminate-old-request'),
          data: { turn: 1, reason: 'process_restart' },
        },
        {
          type: DurableEventType.REQUEST_INTERRUPTED,
          requestId,
          commandId: CommandId('terminate-old-request'),
          data: { reason: 'process_restart' },
        },
        {
          type: DurableEventType.REQUEST_ACCEPTED,
          requestId: recoveryRequestId,
          commandId: recoveryCommandId,
          data: {
            inputId: recoveryInputId,
            input: 'continue',
            priority: 'next',
            recovery: {
              requestId,
              turnId,
              turn: 1,
            },
          },
        },
      ]),
    ).toThrow(/not an atomic canonical rollover/);
  });

  it('rejects a recovery request that bypasses a non-idempotent execution boundary', () => {
    expect(() =>
      project([
        ...turnPrefix(),
        toolScheduled('non_idempotent'),
        {
          type: DurableEventType.TOOL_STARTED,
          requestId,
          turnId,
          toolAttemptId,
          data: {
            toolCallId,
            toolName: 'Write',
            input: { file_path: '/tmp/file' },
            sideEffect: 'non_idempotent',
          },
        },
        {
          type: DurableEventType.TOOL_CANCELLED,
          requestId,
          turnId,
          toolAttemptId,
          commandId: recoveryCommandId,
          data: {
            toolCallId,
            toolName: 'Write',
            reason: 'process_restart',
          },
        },
        {
          type: DurableEventType.TURN_ABORTED,
          requestId,
          turnId,
          commandId: recoveryCommandId,
          data: { turn: 1, reason: 'process_restart' },
        },
        {
          type: DurableEventType.REQUEST_INTERRUPTED,
          requestId,
          commandId: recoveryCommandId,
          data: { reason: 'process_restart' },
        },
        {
          type: DurableEventType.REQUEST_ACCEPTED,
          requestId: recoveryRequestId,
          commandId: recoveryCommandId,
          data: {
            inputId: recoveryInputId,
            input: 'continue',
            priority: 'next',
            recovery: {
              requestId,
              turnId,
              turn: 1,
            },
          },
        },
      ]),
    ).toThrow(/crossed non-idempotent tool attempt/);
  });

  it('classifies scheduled tools as retryable before execution starts', () => {
    const projection = project([...turnPrefix(), toolScheduled()]);
    const recovery = planDurableSessionRecovery(projection);

    expect(recovery.action).toBe('resume_turn');
    expect(recovery.retryableToolAttempts).toHaveLength(1);
    expect(recovery.retryableToolAttempts[0]).toMatchObject({
      toolAttemptId,
      toolCallId,
      executionStarted: false,
      status: 'scheduled',
    });
    expect(recovery.unknownToolAttempts).toEqual([]);
  });

  it('prioritizes unresolved permissions over retrying a scheduled tool', () => {
    const projection = project([...turnPrefix(), toolScheduled(), permissionRequested()]);
    const recovery = planDurableSessionRecovery(projection);

    expect(recovery.action).toBe('resolve_permissions');
    expect(recovery.pendingPermissions).toEqual([
      expect.objectContaining({
        permissionRequestId,
        input: { file_path: '/tmp/file' },
        status: 'pending',
      }),
    ]);
    expect(recovery.retryableToolAttempts).toEqual([]);
  });

  it('classifies denied scheduled tools for terminal cancellation', () => {
    const projection = project([
      ...turnPrefix(),
      toolScheduled(),
      permissionRequested(),
      {
        type: DurableEventType.PERMISSION_RESOLVED,
        requestId,
        turnId,
        toolAttemptId,
        data: {
          permissionRequestId,
          decision: 'deny',
          message: 'Rejected by operator',
        },
      },
    ]);
    const recovery = planDurableSessionRecovery(projection);

    expect(recovery.action).toBe('resume_turn');
    expect(recovery.cancelableToolAttempts).toEqual([
      expect.objectContaining({
        toolAttemptId,
        status: 'scheduled',
      }),
    ]);
    expect(recovery.retryableToolAttempts).toEqual([]);
  });

  it('requires reconciliation for a started tool until its outcome is resolved', () => {
    const started = [
      ...turnPrefix(),
      toolScheduled(),
      {
        type: DurableEventType.TOOL_STARTED,
        requestId,
        turnId,
        toolAttemptId,
        data: {
          toolCallId,
          toolName: 'Write',
          input: { file_path: '/tmp/file' },
          sideEffect: 'non_idempotent',
        },
      },
    ] satisfies DurableEventDraft[];

    const beforeClassification = planDurableSessionRecovery(project(started));
    expect(beforeClassification.action).toBe('reconcile_tool_outcomes');
    expect(beforeClassification.unknownToolAttempts[0]?.status).toBe('started');

    const classified = [
      ...started,
      {
        type: DurableEventType.TOOL_OUTCOME_UNKNOWN,
        requestId,
        turnId,
        toolAttemptId,
        data: {
          toolCallId,
          toolName: 'Write',
          reason: 'process_restart',
        },
      },
    ] satisfies DurableEventDraft[];
    expect(planDurableSessionRecovery(project(classified))).toMatchObject({
      action: 'reconcile_tool_outcomes',
      unknownToolAttempts: [
        expect.objectContaining({
          status: 'outcome_unknown',
          unknownReason: 'process_restart',
        }),
      ],
    });

    const reconciled = project([
      ...classified,
      {
        type: DurableEventType.TOOL_COMPLETED,
        requestId,
        turnId,
        toolAttemptId,
        data: { toolCallId, toolName: 'Write', result: 'verified externally' },
      },
    ]);
    expect(planDurableSessionRecovery(reconciled)).toMatchObject({
      action: 'resume_turn',
      unknownToolAttempts: [],
    });
  });

  it.each(['pure', 'idempotent'] as const)(
    'classifies a started %s tool as replayable',
    (sideEffect) => {
      const projection = project([
        ...turnPrefix(),
        toolScheduled('non_idempotent'),
        {
          type: DurableEventType.TOOL_STARTED,
          requestId,
          turnId,
          toolAttemptId,
          data: {
            toolCallId,
            toolName: 'Write',
            input: { file_path: '/tmp/final-file' },
            sideEffect,
          },
        },
      ]);

      expect(planDurableSessionRecovery(projection)).toMatchObject({
        action: 'resume_turn',
        retryableToolAttempts: [
          expect.objectContaining({
            executionStarted: true,
            status: 'started',
            input: { file_path: '/tmp/final-file' },
            sideEffect,
          }),
        ],
        unknownToolAttempts: [],
      });
    },
  );

  it('projects every non-success terminal lifecycle variant', () => {
    const failedRequest = project([
      ...requestPrefix(),
      {
        type: DurableEventType.REQUEST_FAILED,
        requestId,
        data: { error: { message: 'provider unavailable', retryable: true } },
      },
    ]);
    expect(failedRequest.activeRequest).toBeNull();

    const interruptedRequest = project([
      ...requestPrefix().slice(0, 2),
      {
        type: DurableEventType.REQUEST_INTERRUPTED,
        requestId,
        data: { reason: 'user_abort' },
      },
    ]);
    expect(interruptedRequest.activeRequest).toBeNull();

    const abortedTurn = project([
      ...turnPrefix(),
      {
        type: DurableEventType.TURN_ABORTED,
        requestId,
        turnId,
        data: { turn: 1, reason: 'error' },
      },
    ]);
    expect(abortedTurn.activeRequest?.activeTurn).toBeNull();

    const failedTool = project([
      ...turnPrefix(),
      toolScheduled(),
      {
        type: DurableEventType.TOOL_FAILED,
        requestId,
        turnId,
        toolAttemptId,
        data: {
          toolCallId,
          toolName: 'Write',
          error: { message: 'validation failed' },
        },
      },
    ]);
    expect(failedTool.activeRequest?.activeTurn?.toolAttempts[0]?.status).toBe('failed');

    const cancelledTool = project([
      ...turnPrefix(),
      toolScheduled(),
      {
        type: DurableEventType.TOOL_CANCELLED,
        requestId,
        turnId,
        toolAttemptId,
        data: {
          toolCallId,
          toolName: 'Write',
          reason: 'cascade_abort',
        },
      },
    ]);
    expect(cancelledTool.activeRequest?.activeTurn?.toolAttempts[0]).toMatchObject({
      status: 'cancelled',
      cancelReason: 'cascade_abort',
    });
  });

  it.each([
    {
      name: 'event before session creation',
      drafts: requestPrefix().slice(1, 2),
      message: /Expected an open session/,
    },
    {
      name: 'duplicate session creation',
      drafts: [requestPrefix()[0], requestPrefix()[0]],
      message: /already created/,
    },
    {
      name: 'overlapping requests',
      drafts: [
        ...requestPrefix().slice(0, 2),
        {
          type: DurableEventType.REQUEST_ACCEPTED,
          requestId: RequestId('request-2'),
          commandId: CommandId('command-2'),
          data: {
            inputId: InputId('input-2'),
            input: 'second',
            priority: 'next',
          },
        },
      ],
      message: /still active/,
    },
    {
      name: 'turn before request start',
      drafts: [
        ...requestPrefix().slice(0, 2),
        {
          type: DurableEventType.TURN_STARTED,
          requestId,
          turnId,
          data: { turn: 1 },
        },
      ],
      message: /has not started/,
    },
    {
      name: 'non-contiguous turn number',
      drafts: [
        ...requestPrefix(),
        {
          type: DurableEventType.TURN_STARTED,
          requestId,
          turnId,
          data: { turn: 2 },
        },
      ],
      message: /Expected turn number 1/,
    },
    {
      name: 'tool start before scheduling',
      drafts: [
        ...turnPrefix(),
        {
          type: DurableEventType.TOOL_STARTED,
          requestId,
          turnId,
          toolAttemptId,
          data: {
            toolCallId,
            toolName: 'Write',
            input: {},
            sideEffect: 'non_idempotent',
          },
        },
      ],
      message: /No tool attempt matches/,
    },
    {
      name: 'tool start while permission is unresolved',
      drafts: [
        ...turnPrefix(),
        toolScheduled(),
        permissionRequested(),
        {
          type: DurableEventType.TOOL_STARTED,
          requestId,
          turnId,
          toolAttemptId,
          data: {
            toolCallId,
            toolName: 'Write',
            input: { file_path: '/tmp/file' },
            sideEffect: 'non_idempotent',
          },
        },
      ],
      message: /unresolved permission/,
    },
    {
      name: 'turn completion with unfinished tool',
      drafts: [
        ...turnPrefix(),
        toolScheduled(),
        {
          type: DurableEventType.TURN_COMPLETED,
          requestId,
          turnId,
          data: { turn: 1, hasToolCalls: true },
        },
      ],
      message: /is not terminal/,
    },
    {
      name: 'request completion with active turn',
      drafts: [
        ...turnPrefix(),
        {
          type: DurableEventType.REQUEST_COMPLETED,
          requestId,
          data: {},
        },
      ],
      message: /is still active/,
    },
    {
      name: 'session close with active request',
      drafts: [
        ...requestPrefix().slice(0, 2),
        {
          type: DurableEventType.SESSION_CLOSED,
          data: { reason: 'shutdown' },
        },
      ],
      message: /is still active/,
    },
    {
      name: 'tool identity mismatch',
      drafts: [
        ...turnPrefix(),
        toolScheduled(),
        {
          type: DurableEventType.TOOL_STARTED,
          requestId,
          turnId,
          toolAttemptId,
          data: {
            toolCallId: ToolUseId('different-call'),
            toolName: 'Write',
            input: { file_path: '/tmp/file' },
            sideEffect: 'non_idempotent',
          },
        },
      ],
      message: /identity does not match/,
    },
    {
      name: 'duplicate input application',
      drafts: [
        ...requestPrefix(),
        {
          type: DurableEventType.INPUT_APPLIED,
          requestId,
          data: {
            inputId: initialInputId,
            priority: 'next',
          },
        },
      ],
      message: /Input ID input-1 was already applied/,
    },
    {
      name: 'request terminal event with stale Turn causation',
      drafts: [
        ...turnPrefix(),
        {
          type: DurableEventType.TURN_COMPLETED,
          requestId,
          turnId,
          data: { turn: 1, hasToolCalls: false },
        },
        {
          type: DurableEventType.REQUEST_COMPLETED,
          requestId,
          causationEventId: EventId('event-1'),
          data: {},
        },
      ],
      message: /does not match the latest boundary/,
    },
    {
      name: 'input application scoped to a stale Turn',
      drafts: [
        ...turnPrefix(),
        {
          type: DurableEventType.INPUT_APPLIED,
          requestId,
          turnId: TurnId('stale-turn'),
          data: {
            inputId: InputId('steering-input'),
            priority: 'next',
          },
        },
      ],
      message: /No active turn matches stale-turn/,
    },
    {
      name: 'accepted request reuses a steering input ID',
      drafts: [
        ...requestPrefix(),
        {
          type: DurableEventType.INPUT_APPLIED,
          requestId,
          data: {
            inputId: InputId('steering-input'),
            priority: 'next',
          },
        },
        {
          type: DurableEventType.REQUEST_COMPLETED,
          requestId,
          data: {},
        },
        {
          type: DurableEventType.REQUEST_ACCEPTED,
          requestId: RequestId('request-2'),
          commandId: CommandId('command-2'),
          data: {
            inputId: InputId('steering-input'),
            input: 'second',
            priority: 'next',
          },
        },
      ],
      message: /Input ID steering-input was already applied/,
    },
    {
      name: 'steering input reuses an accepted Request input ID',
      drafts: [
        ...requestPrefix().slice(0, 2),
        {
          type: DurableEventType.REQUEST_INTERRUPTED,
          requestId,
          data: { reason: 'user_abort' },
        },
        {
          type: DurableEventType.REQUEST_ACCEPTED,
          requestId: RequestId('request-2'),
          commandId: CommandId('command-2'),
          data: {
            inputId: InputId('input-2'),
            input: 'second',
            priority: 'next',
          },
        },
        {
          type: DurableEventType.INPUT_APPLIED,
          requestId: RequestId('request-2'),
          data: {
            inputId: initialInputId,
            priority: 'next',
          },
        },
      ],
      message: /Input ID input-1 was already used by another Request/,
    },
  ] as const)('rejects $name', ({ drafts, message }) => {
    expect(() => project(drafts as readonly DurableEventDraft[])).toThrow(message);
  });

  it('rejects duplicate command IDs after the first request terminates', () => {
    expect(() =>
      project([
        ...requestPrefix(),
        {
          type: DurableEventType.REQUEST_COMPLETED,
          requestId,
          data: {},
        },
        {
          type: DurableEventType.REQUEST_ACCEPTED,
          requestId: RequestId('request-2'),
          commandId,
          data: {
            inputId: InputId('input-2'),
            input: 'second',
            priority: 'next',
          },
        },
      ]),
    ).toThrow(/Command ID command-1 was already accepted/);
  });

  it.each([
    {
      name: 'request ID',
      drafts: [
        ...requestPrefix(),
        {
          type: DurableEventType.REQUEST_COMPLETED,
          requestId,
          data: {},
        },
        {
          type: DurableEventType.REQUEST_ACCEPTED,
          requestId,
          commandId: CommandId('command-2'),
          data: {
            inputId: InputId('input-2'),
            input: 'second',
            priority: 'next',
          },
        },
      ],
      message: /Request ID request-1 was already used/,
    },
    {
      name: 'input ID',
      drafts: [
        ...requestPrefix(),
        {
          type: DurableEventType.REQUEST_COMPLETED,
          requestId,
          data: {},
        },
        {
          type: DurableEventType.REQUEST_ACCEPTED,
          requestId: RequestId('request-2'),
          commandId: CommandId('command-2'),
          data: {
            inputId: initialInputId,
            input: 'second',
            priority: 'next',
          },
        },
      ],
      message: /Input ID input-1 was already accepted/,
    },
    {
      name: 'turn ID',
      drafts: [
        ...turnPrefix(),
        {
          type: DurableEventType.TURN_COMPLETED,
          requestId,
          turnId,
          data: { turn: 1, hasToolCalls: false },
        },
        {
          type: DurableEventType.TURN_STARTED,
          requestId,
          turnId,
          data: { turn: 2 },
        },
      ],
      message: /Turn ID turn-1 was already used/,
    },
    {
      name: 'tool attempt ID',
      drafts: [
        ...turnPrefix(),
        toolScheduled(),
        {
          type: DurableEventType.TOOL_FAILED,
          requestId,
          turnId,
          toolAttemptId,
          data: {
            toolCallId,
            toolName: 'Write',
            error: { message: 'validation failed' },
          },
        },
        toolScheduled(),
      ],
      message: /Tool attempt ID attempt-1 was already used/,
    },
    {
      name: 'permission request ID',
      drafts: [
        ...turnPrefix(),
        toolScheduled(),
        permissionRequested(),
        {
          type: DurableEventType.PERMISSION_RESOLVED,
          requestId,
          turnId,
          toolAttemptId,
          data: { permissionRequestId, decision: 'allow' },
        },
        {
          type: DurableEventType.TOOL_STARTED,
          requestId,
          turnId,
          toolAttemptId,
          data: {
            toolCallId,
            toolName: 'Write',
            input: { file_path: '/tmp/file' },
            sideEffect: 'non_idempotent',
          },
        },
        {
          type: DurableEventType.TOOL_COMPLETED,
          requestId,
          turnId,
          toolAttemptId,
          data: { toolCallId, toolName: 'Write', result: 'done' },
        },
        {
          type: DurableEventType.TOOL_SCHEDULED,
          requestId,
          turnId,
          toolAttemptId: ToolAttemptId('attempt-2'),
          data: {
            toolCallId: ToolUseId('call-2'),
            toolName: 'Read',
            input: { file_path: '/tmp/file' },
            sideEffect: 'pure',
            interruptBehavior: 'cancel',
          },
        },
        {
          type: DurableEventType.PERMISSION_REQUESTED,
          requestId,
          turnId,
          toolAttemptId: ToolAttemptId('attempt-2'),
          data: {
            permissionRequestId,
            toolCallId: ToolUseId('call-2'),
            toolName: 'Read',
            input: { file_path: '/tmp/file' },
          },
        },
      ],
      message: /Permission request ID permission-1 was already used/,
    },
  ] as const)('rejects reused $name values', ({ drafts, message }) => {
    expect(() => project(drafts as readonly DurableEventDraft[])).toThrow(message);
  });

  it('rejects sequence gaps, duplicate event IDs, future causation, and mixed sessions', () => {
    const valid = envelopes(requestPrefix().slice(0, 2));

    expect(() =>
      projectDurableSession([
        valid[0] as DurableEventEnvelope,
        {
          ...valid[1],
          sequence: EventSequence(3),
        } as DurableEventEnvelope,
      ]),
    ).toThrow(/Expected sequence 2/);

    expect(() =>
      projectDurableSession(
        envelopes(requestPrefix().slice(0, 2), {
          eventIdForIndex: () => EventId('duplicate'),
        }),
      ),
    ).toThrow(/already used/);

    expect(() =>
      projectDurableSession([
        {
          ...valid[0],
          causationEventId: EventId('future-event'),
        } as DurableEventEnvelope,
      ]),
    ).toThrow(/has not been observed/);

    expect(() =>
      projectDurableSession([
        valid[0] as DurableEventEnvelope,
        {
          ...valid[1],
          sessionId: SessionId('session-2'),
        } as DurableEventEnvelope,
      ]),
    ).toThrow(/Expected session session-1/);
  });

  it('wraps malformed envelopes in a projection error', () => {
    const malformed = [
      {
        type: DurableEventType.SESSION_CREATED,
        data: { unknown: true },
      } as unknown as DurableEventEnvelope,
    ];
    expect(() => projectDurableSession(malformed)).toThrow(DurableEventProjectionError);
  });

  it('stays failed after observing an invalid event', () => {
    const projector = new DurableSessionProjector();
    expect(() =>
      projector.apply([
        {
          type: DurableEventType.SESSION_CREATED,
          data: { unknown: true },
        } as unknown as DurableEventEnvelope,
      ]),
    ).toThrow(DurableEventProjectionError);

    expect(() => projector.snapshot()).toThrow(DurableEventProjectionError);
    expect(() =>
      projector.apply(
        envelopes([
          {
            type: DurableEventType.SESSION_CREATED,
            data: {},
          },
        ]),
      ),
    ).toThrow(DurableEventProjectionError);
  });
});
