import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CommandId,
  EventId,
  InputId,
  PermissionRequestId,
  RequestId,
  SessionId,
  ToolAttemptId,
  ToolUseId,
  TurnId,
} from '../../../types/branded.js';
import { DurableSessionJournal } from '../DurableSessionJournal.js';
import {
  DurableSessionRecoveryCoordinator,
  DurableSessionRecoveryError,
} from '../DurableSessionRecoveryCoordinator.js';
import { JsonlDurableEventStore } from '../JsonlDurableEventStore.js';
import { DurableEventType } from '../types.js';

const sessionId = SessionId('recovery-session');
const requestId = RequestId('recovery-request');
const inputId = InputId('recovery-input');
const turnId = TurnId('recovery-turn');
const toolAttemptId = ToolAttemptId('recovery-attempt');
const toolCallId = ToolUseId('recovery-call');
const permissionRequestId = PermissionRequestId('recovery-permission');

const roots: string[] = [];

function createStore(): JsonlDurableEventStore {
  const root = mkdtempSync(join(tmpdir(), 'durable-recovery-coordinator-'));
  roots.push(root);
  let eventId = 0;
  return new JsonlDurableEventStore(root, {
    clock: () => new Date('2026-08-22T12:00:00.000Z'),
    eventIdFactory: () => EventId(`recovery-event-${++eventId}`),
  });
}

async function createJournal(
  store: JsonlDurableEventStore,
  options: {
    requestStarted?: boolean;
    tool?: 'none' | 'pending_permission' | 'started';
  } = {},
): Promise<DurableSessionJournal> {
  const journal = await DurableSessionJournal.open(store, sessionId);
  await journal.commit({
    commandId: CommandId('bootstrap'),
    events: [
      {
        type: DurableEventType.SESSION_CREATED,
        data: { source: 'create' },
      },
      {
        type: DurableEventType.REQUEST_ACCEPTED,
        requestId,
        data: {
          inputId,
          input: 'recover this request',
          priority: 'next',
          maxTurns: 17,
          model: 'accepted-model',
          context: {
            id: 'accepted-context',
            environment: { RECOVERED: 'yes' },
          },
        },
      },
      ...(options.requestStarted
        ? ([
            {
              type: DurableEventType.INPUT_APPLIED,
              requestId,
              data: { inputId, priority: 'next' as const },
            },
            {
              type: DurableEventType.REQUEST_STARTED,
              requestId,
              data: {},
            },
          ] as const)
        : []),
      ...(options.tool && options.tool !== 'none'
        ? ([
            {
              type: DurableEventType.TURN_STARTED,
              requestId,
              turnId,
              data: { turn: 1, model: 'test-model' },
            },
            {
              type: DurableEventType.TOOL_SCHEDULED,
              requestId,
              turnId,
              toolAttemptId,
              data: {
                toolCallId,
                toolName: 'Deploy',
                input: { environment: 'production' },
                sideEffect: 'non_idempotent' as const,
                interruptBehavior: 'block' as const,
              },
            },
            ...(options.tool === 'pending_permission'
              ? ([
                  {
                    type: DurableEventType.PERMISSION_REQUESTED,
                    requestId,
                    turnId,
                    toolAttemptId,
                    data: {
                      permissionRequestId,
                      toolCallId,
                      toolName: 'Deploy',
                      input: { environment: 'approved-production' },
                      message: 'Allow deployment?',
                    },
                  },
                ] as const)
              : ([
                  {
                    type: DurableEventType.TOOL_STARTED,
                    requestId,
                    turnId,
                    toolAttemptId,
                    data: {
                      toolCallId,
                      toolName: 'Deploy',
                      input: { environment: 'production' },
                      sideEffect: 'non_idempotent' as const,
                    },
                  },
                ] as const)),
          ] as const)
        : []),
    ],
  });
  return journal;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('DurableSessionRecoveryCoordinator', () => {
  it('only auto-resumes an accepted request that never crossed the start boundary', async () => {
    const store = createStore();
    const accepted = new DurableSessionRecoveryCoordinator(await createJournal(store)).planResume();

    expect(accepted).toMatchObject({
      action: 'resume_accepted_request',
      request: {
        requestId,
        inputId,
        input: 'recover this request',
        maxTurns: 17,
        model: 'accepted-model',
        context: {
          id: 'accepted-context',
          environment: { RECOVERED: 'yes' },
        },
      },
    });

    const legacyStore = createStore();
    const legacyJournal = await DurableSessionJournal.open(legacyStore, sessionId);
    await legacyJournal.commit({
      commandId: CommandId('legacy-bootstrap'),
      events: [
        {
          type: DurableEventType.SESSION_CREATED,
          data: { source: 'create' },
        },
        {
          type: DurableEventType.REQUEST_ACCEPTED,
          requestId,
          data: {
            inputId,
            input: 'missing execution snapshot',
            priority: 'next',
          },
        },
      ],
    });
    expect(new DurableSessionRecoveryCoordinator(legacyJournal).planResume()).toMatchObject({
      action: 'recovery_required',
      recoveryPlan: {
        action: 'resume_request',
      },
    });

    const runningStore = createStore();
    const running = new DurableSessionRecoveryCoordinator(
      await createJournal(runningStore, { requestStarted: true }),
    ).planResume();
    expect(running).toMatchObject({
      action: 'recovery_required',
      recoveryPlan: {
        action: 'resume_request',
        requestId,
      },
    });

    const unknownStore = createStore();
    const unknown = new DurableSessionRecoveryCoordinator(
      await createJournal(unknownStore, { requestStarted: true, tool: 'started' }),
    ).planResume();
    expect(unknown).toMatchObject({
      action: 'recovery_required',
      recoveryPlan: {
        action: 'reconcile_tool_outcomes',
        unknownToolAttempts: [
          {
            toolAttemptId,
            sideEffect: 'non_idempotent',
            status: 'started',
          },
        ],
      },
    });
  });

  it('reconciles an unknown tool outcome idempotently across coordinator instances', async () => {
    const store = createStore();
    await createJournal(store, { requestStarted: true, tool: 'started' });
    const first = await DurableSessionRecoveryCoordinator.open(store, sessionId);
    const second = await DurableSessionRecoveryCoordinator.open(store, sessionId);
    const command = {
      commandId: CommandId('reconcile-deployment'),
      toolAttemptId,
      outcome: {
        status: 'completed' as const,
        result: { deploymentId: 'dep-123' },
      },
    };

    const results = await Promise.all([
      first.reconcileToolOutcome(command),
      second.reconcileToolOutcome(command),
    ]);

    expect(results.map((result) => result.commit.status).sort()).toEqual([
      'committed',
      'reconciled',
    ]);
    expect(results.every((result) => result.recoveryPlan.action === 'resume_turn')).toBe(true);
    expect(
      (await store.read(sessionId)).events.filter(
        (event) => event.type === DurableEventType.TOOL_COMPLETED,
      ),
    ).toHaveLength(1);
    await expect(
      first.reconcileToolOutcome({
        ...command,
        outcome: {
          status: 'completed',
          result: { deploymentId: 'different-deployment' },
        },
      }),
    ).rejects.toThrow(/different events/);
  });

  it.each([
    {
      outcome: {
        status: 'failed' as const,
        error: { message: 'Deployment status is unknown', code: 'REMOTE_UNAVAILABLE' },
      },
      eventType: DurableEventType.TOOL_FAILED,
      status: 'failed',
    },
    {
      outcome: { status: 'cancelled' as const },
      eventType: DurableEventType.TOOL_CANCELLED,
      status: 'cancelled',
    },
  ])('reconciles a started tool as $status', async ({ outcome, eventType, status }) => {
    const store = createStore();
    await createJournal(store, { requestStarted: true, tool: 'started' });
    const coordinator = await DurableSessionRecoveryCoordinator.open(store, sessionId);

    const result = await coordinator.reconcileToolOutcome({
      commandId: CommandId(`reconcile-${status}`),
      toolAttemptId,
      outcome,
    });

    expect(result.commit.events).toEqual([
      expect.objectContaining({
        type: eventType,
        toolAttemptId,
      }),
    ]);
    expect(result.projection.activeRequest?.activeTurn?.toolAttempts[0]?.status).toBe(status);
  });

  it.each([
    {
      decision: 'allow' as const,
      eventTypes: [DurableEventType.PERMISSION_RESOLVED],
      toolStatus: 'scheduled',
    },
    {
      decision: 'deny' as const,
      eventTypes: [DurableEventType.PERMISSION_RESOLVED, DurableEventType.TOOL_CANCELLED],
      toolStatus: 'cancelled',
    },
    {
      decision: 'cancel' as const,
      eventTypes: [DurableEventType.PERMISSION_RESOLVED, DurableEventType.TOOL_CANCELLED],
      toolStatus: 'cancelled',
    },
  ])('resolves a pending permission with $decision in one command', async ({
    decision,
    eventTypes,
    toolStatus,
  }) => {
    const store = createStore();
    await createJournal(store, { requestStarted: true, tool: 'pending_permission' });
    const coordinator = await DurableSessionRecoveryCoordinator.open(store, sessionId);
    const command = {
      commandId: CommandId(`permission-${decision}`),
      permissionRequestId,
      decision,
      message: `Permission ${decision}`,
    };

    const first = await coordinator.resolvePermission(command);
    const replayed = await coordinator.resolvePermission(command);

    expect(first.commit.status).toBe('committed');
    expect(first.commit.events.map((event) => event.type)).toEqual(eventTypes);
    expect(replayed.commit.status).toBe('replayed');
    expect(first.projection.activeRequest?.activeTurn?.toolAttempts[0]).toMatchObject({
      status: toolStatus,
      permission: {
        status: 'resolved',
        decision,
        message: `Permission ${decision}`,
      },
    });
  });

  it('persists a recovered tool start before the caller may run its side effect', async () => {
    const store = createStore();
    await createJournal(store, { requestStarted: true, tool: 'pending_permission' });
    const coordinator = await DurableSessionRecoveryCoordinator.open(store, sessionId);

    await expect(
      coordinator.startToolAttempt({
        commandId: CommandId('start-before-permission'),
        toolAttemptId,
      }),
    ).rejects.toMatchObject({
      code: 'DURABLE_RECOVERY_INVALID_STATE',
      message: expect.stringContaining('unresolved permission'),
    });

    await coordinator.resolvePermission({
      commandId: CommandId('allow-deployment'),
      permissionRequestId,
      decision: 'allow',
    });
    const command = {
      commandId: CommandId('start-deployment'),
      toolAttemptId,
    };
    const started = await coordinator.startToolAttempt(command);
    const replayed = await coordinator.startToolAttempt(command);

    expect(started.commit.status).toBe('committed');
    expect(replayed.commit.status).toBe('replayed');
    expect(started.recoveryPlan).toMatchObject({
      action: 'reconcile_tool_outcomes',
      unknownToolAttempts: [
        {
          toolAttemptId,
          input: { environment: 'approved-production' },
          sideEffect: 'non_idempotent',
          status: 'started',
        },
      ],
    });
    expect(
      (await store.read(sessionId)).events.filter(
        (event) => event.type === DurableEventType.TOOL_STARTED,
      ),
    ).toHaveLength(1);
  });

  it('fails closed when a reconciliation target is not active', async () => {
    const store = createStore();
    await createJournal(store);
    const coordinator = await DurableSessionRecoveryCoordinator.open(store, sessionId);

    await expect(
      coordinator.reconcileToolOutcome({
        commandId: CommandId('missing-tool'),
        toolAttemptId,
        outcome: { status: 'cancelled' },
      }),
    ).rejects.toBeInstanceOf(DurableSessionRecoveryError);
  });
});
