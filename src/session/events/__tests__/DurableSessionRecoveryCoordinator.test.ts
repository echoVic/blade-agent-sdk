import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CommandId,
  EventId,
  type EventSequence,
  InputId,
  PermissionRequestId,
  RequestId,
  SessionId,
  ToolAttemptId,
  ToolUseId,
  TurnId,
} from '../../../types/branded.js';
import type { JsonValue } from '../../../types/common.js';
import type { DurableEventStore } from '../DurableEventStore.js';
import { DurableSessionJournal } from '../DurableSessionJournal.js';
import {
  DurableSessionRecoveryCoordinator,
  DurableSessionRecoveryError,
} from '../DurableSessionRecoveryCoordinator.js';
import { JsonlDurableEventStore } from '../JsonlDurableEventStore.js';
import {
  type DurableEventAppendOptions,
  type DurableEventDraft,
  type DurableEventReadOptions,
  DurableEventType,
} from '../types.js';

const sessionId = SessionId('recovery-session');
const requestId = RequestId('recovery-request');
const inputId = InputId('recovery-input');
const turnId = TurnId('recovery-turn');
const toolAttemptId = ToolAttemptId('recovery-attempt');
const toolCallId = ToolUseId('recovery-call');
const permissionRequestId = PermissionRequestId('recovery-permission');
const rolloverRequestId = RequestId('rollover-request');
const rolloverInputId = InputId('rollover-input');

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

class StartToolBeforeRolloverStore implements DurableEventStore {
  private injected = false;

  constructor(private readonly delegate: DurableEventStore) {}

  async append(
    targetSessionId: SessionId,
    events: readonly DurableEventDraft[],
    options?: DurableEventAppendOptions,
  ) {
    if (
      !this.injected &&
      events.some(
        (event) =>
          event.type === DurableEventType.REQUEST_ACCEPTED && event.data.recovery !== undefined,
      )
    ) {
      this.injected = true;
      await this.delegate.append(
        targetSessionId,
        [
          {
            type: DurableEventType.TOOL_STARTED,
            commandId: CommandId('racing-tool-start'),
            requestId,
            turnId,
            toolAttemptId,
            data: {
              toolCallId,
              toolName: 'Deploy',
              input: { environment: 'production' },
              sideEffect: 'non_idempotent',
            },
          },
        ],
        options,
      );
    }
    return this.delegate.append(targetSessionId, events, options);
  }

  read(targetSessionId: SessionId, options?: DurableEventReadOptions) {
    return this.delegate.read(targetSessionId, options);
  }

  getHeadSequence(targetSessionId: SessionId): Promise<EventSequence | null> {
    return this.delegate.getHeadSequence(targetSessionId);
  }
}

async function createJournal(
  store: DurableEventStore,
  options: {
    input?: JsonValue;
    requestStarted?: boolean;
    sideEffect?: 'pure' | 'idempotent' | 'non_idempotent';
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
          input: options.input === undefined ? 'recover this request' : options.input,
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
                sideEffect: options.sideEffect ?? ('non_idempotent' as const),
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

  it('atomically rolls a recoverable turn into a new accepted request', async () => {
    const store = createStore();
    const journal = await createJournal(store, { requestStarted: true });
    await journal.commit({
      commandId: CommandId('start-turn'),
      events: [
        {
          type: DurableEventType.TURN_STARTED,
          requestId,
          turnId,
          data: { turn: 1, model: 'accepted-model' },
        },
      ],
    });
    const first = await DurableSessionRecoveryCoordinator.open(store, sessionId);
    const second = await DurableSessionRecoveryCoordinator.open(store, sessionId);
    const headBeforeMismatch = await store.getHeadSequence(sessionId);
    await expect(
      first.prepareTurnRecovery({
        commandId: CommandId('rollover-wrong-source'),
        requestId: RequestId('different-source-request'),
        turnId,
        recoveryRequestId: rolloverRequestId,
        recoveryInputId: rolloverInputId,
      }),
    ).rejects.toMatchObject({
      code: 'DURABLE_RECOVERY_TARGET_NOT_FOUND',
    });
    expect(await store.getHeadSequence(sessionId)).toBe(headBeforeMismatch);

    const command = {
      commandId: CommandId('rollover-turn'),
      requestId,
      turnId,
      recoveryRequestId: rolloverRequestId,
      recoveryInputId: rolloverInputId,
    };

    const results = await Promise.all([
      first.prepareTurnRecovery(command),
      second.prepareTurnRecovery(command),
    ]);
    const replayed = await first.prepareTurnRecovery(command);

    expect(results.map((result) => result.commit.status).sort()).toEqual([
      'committed',
      'reconciled',
    ]);
    expect(replayed.commit.status).toBe('replayed');
    expect(replayed.continuation).toContain('sourceTurnId');
    expect(replayed.projection.activeRequest).toMatchObject({
      requestId: rolloverRequestId,
      inputId: rolloverInputId,
      status: 'accepted',
      recovery: {
        requestId,
        turnId,
        turn: 1,
      },
    });
    expect(first.planResume()).toMatchObject({
      action: 'resume_accepted_request',
      request: {
        requestId: rolloverRequestId,
        inputId: rolloverInputId,
      },
    });
    expect((await store.read(sessionId)).events.map((event) => event.type).slice(-3)).toEqual([
      DurableEventType.TURN_ABORTED,
      DurableEventType.REQUEST_INTERRUPTED,
      DurableEventType.REQUEST_ACCEPTED,
    ]);
    await expect(
      first.prepareTurnRecovery({
        ...command,
        recoveryInputId: InputId('different-rollover-input'),
      }),
    ).rejects.toMatchObject({
      code: 'DURABLE_RECOVERY_INVALID_STATE',
    });
  });

  it('does not rebase rollover after a non-idempotent tool starts concurrently', async () => {
    const baseStore = createStore();
    const store = new StartToolBeforeRolloverStore(baseStore);
    const journal = await createJournal(store, { requestStarted: true });
    await journal.commit({
      commandId: CommandId('schedule-racing-tool'),
      events: [
        {
          type: DurableEventType.TURN_STARTED,
          requestId,
          turnId,
          data: { turn: 1, model: 'accepted-model' },
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
            sideEffect: 'non_idempotent',
            interruptBehavior: 'block',
          },
        },
      ],
    });
    const coordinator = await DurableSessionRecoveryCoordinator.open(store, sessionId);
    const command = {
      commandId: CommandId('raced-rollover'),
      requestId,
      turnId,
      recoveryRequestId: rolloverRequestId,
      recoveryInputId: rolloverInputId,
    };

    await expect(coordinator.prepareTurnRecovery(command)).rejects.toMatchObject({
      code: 'DURABLE_EVENT_SEQUENCE_CONFLICT',
    });
    await expect(coordinator.prepareTurnRecovery(command)).rejects.toMatchObject({
      code: 'DURABLE_RECOVERY_INVALID_STATE',
    });

    const events = (await baseStore.read(sessionId)).events;
    expect(events.at(-1)).toMatchObject({
      type: DurableEventType.TOOL_STARTED,
      data: {
        sideEffect: 'non_idempotent',
      },
    });
    expect(
      events.some(
        (event) =>
          event.type === DurableEventType.REQUEST_ACCEPTED && event.requestId === rolloverRequestId,
      ),
    ).toBe(false);
  });

  it('cancels retry-safe started tools before rolling over the turn', async () => {
    const store = createStore();
    const journal = await createJournal(store, { requestStarted: true });
    await journal.commit({
      commandId: CommandId('start-safe-tool'),
      events: [
        {
          type: DurableEventType.TURN_STARTED,
          requestId,
          turnId,
          data: { turn: 1, model: 'accepted-model' },
        },
        {
          type: DurableEventType.TOOL_SCHEDULED,
          requestId,
          turnId,
          toolAttemptId,
          data: {
            toolCallId,
            toolName: 'Read',
            input: { file_path: '/tmp/input' },
            sideEffect: 'pure',
            interruptBehavior: 'cancel',
          },
        },
        {
          type: DurableEventType.TOOL_STARTED,
          requestId,
          turnId,
          toolAttemptId,
          data: {
            toolCallId,
            toolName: 'Read',
            input: { file_path: '/tmp/input' },
            sideEffect: 'pure',
          },
        },
      ],
    });
    const coordinator = new DurableSessionRecoveryCoordinator(journal);

    const result = await coordinator.prepareTurnRecovery({
      commandId: CommandId('rollover-safe-tool'),
      requestId,
      turnId,
      recoveryRequestId: rolloverRequestId,
      recoveryInputId: rolloverInputId,
    });

    expect(result.commit.events.map((event) => event.type)).toEqual([
      DurableEventType.TOOL_CANCELLED,
      DurableEventType.TURN_ABORTED,
      DurableEventType.REQUEST_INTERRUPTED,
      DurableEventType.REQUEST_ACCEPTED,
    ]);
    expect(result.continuation).toContain('interrupted_before_trusted_completion');
    expect(result.continuation).toContain('"sideEffect": "pure"');
  });

  it('marks a scheduled non-idempotent tool as safe to execute for the first time', async () => {
    const store = createStore();
    const journal = await createJournal(store, { requestStarted: true });
    await journal.commit({
      commandId: CommandId('schedule-non-idempotent-tool'),
      events: [
        {
          type: DurableEventType.TURN_STARTED,
          requestId,
          turnId,
          data: { turn: 1, model: 'accepted-model' },
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
            sideEffect: 'non_idempotent',
            interruptBehavior: 'block',
          },
        },
      ],
    });

    const result = await new DurableSessionRecoveryCoordinator(journal).prepareTurnRecovery({
      commandId: CommandId('rollover-scheduled-non-idempotent-tool'),
      requestId,
      turnId,
      recoveryRequestId: rolloverRequestId,
      recoveryInputId: rolloverInputId,
    });

    expect(result.continuation).toContain('"status": "not_started"');
    expect(result.continuation).toContain('Operations marked not_started are safe to execute once');
    expect(result.continuation).not.toContain('"status": "interrupted_before_trusted_completion"');
  });

  it('preserves multimodal request parts in the recovery continuation', async () => {
    const store = createStore();
    const originalInput: JsonValue[] = [
      { type: 'text', text: 'Inspect this image' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } },
    ];
    const journal = await createJournal(store, {
      input: originalInput,
      requestStarted: true,
    });
    await journal.commit({
      commandId: CommandId('start-multimodal-turn'),
      events: [
        {
          type: DurableEventType.TURN_STARTED,
          requestId,
          turnId,
          data: { turn: 1, model: 'accepted-model' },
        },
      ],
    });
    const coordinator = new DurableSessionRecoveryCoordinator(journal);
    const command = {
      commandId: CommandId('rollover-multimodal-turn'),
      requestId,
      turnId,
      recoveryRequestId: rolloverRequestId,
      recoveryInputId: rolloverInputId,
    };

    const committed = await coordinator.prepareTurnRecovery(command);
    const replayed = await coordinator.prepareTurnRecovery(command);

    expect(committed.continuation).toEqual([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('"kind": "multimodal_content_parts"'),
      }),
      ...originalInput,
    ]);
    expect(replayed.continuation).toEqual(committed.continuation);
    expect(committed.projection.activeRequest?.input).toEqual(committed.continuation);
  });

  it('uses permission-updated input and conservative side effects in the continuation', async () => {
    const store = createStore();
    const journal = await createJournal(store, {
      requestStarted: true,
      sideEffect: 'pure',
      tool: 'pending_permission',
    });
    const coordinator = new DurableSessionRecoveryCoordinator(journal);
    await coordinator.resolvePermission({
      commandId: CommandId('allow-updated-tool'),
      permissionRequestId,
      decision: 'allow',
    });

    const result = await coordinator.prepareTurnRecovery({
      commandId: CommandId('rollover-allowed-tool'),
      requestId,
      turnId,
      recoveryRequestId: rolloverRequestId,
      recoveryInputId: rolloverInputId,
    });

    expect(result.continuation).toContain('"environment": "approved-production"');
    expect(result.continuation).not.toContain('"environment": "production"');
    expect(result.continuation).toContain('"sideEffect": "non_idempotent"');
    expect(result.continuation).toContain('"status": "not_started"');
  });

  it('replays rollover after cancelling a previously denied scheduled tool', async () => {
    const store = createStore();
    const journal = await createJournal(store, {
      requestStarted: true,
      tool: 'pending_permission',
    });
    await journal.commit({
      commandId: CommandId('resolve-denial-without-cancellation'),
      events: [
        {
          type: DurableEventType.PERMISSION_RESOLVED,
          requestId,
          turnId,
          toolAttemptId,
          data: {
            permissionRequestId,
            decision: 'deny',
          },
        },
      ],
    });
    const coordinator = new DurableSessionRecoveryCoordinator(journal);
    const command = {
      commandId: CommandId('rollover-denied-tool'),
      requestId,
      turnId,
      recoveryRequestId: rolloverRequestId,
      recoveryInputId: rolloverInputId,
    };

    const committed = await coordinator.prepareTurnRecovery(command);
    const replayed = await coordinator.prepareTurnRecovery(command);

    expect(committed.commit.events[0]).toMatchObject({
      type: DurableEventType.TOOL_CANCELLED,
      data: { reason: 'permission_denied' },
    });
    expect(replayed.commit.status).toBe('replayed');
  });

  it('carries a completed retry-safe tool result into the continuation', async () => {
    const store = createStore();
    const journal = await createJournal(store, { requestStarted: true });
    await journal.commit({
      commandId: CommandId('complete-safe-tool'),
      events: [
        {
          type: DurableEventType.TURN_STARTED,
          requestId,
          turnId,
          data: { turn: 1, model: 'accepted-model' },
        },
        {
          type: DurableEventType.TOOL_SCHEDULED,
          requestId,
          turnId,
          toolAttemptId,
          data: {
            toolCallId,
            toolName: 'Read',
            input: { file_path: '/tmp/input' },
            sideEffect: 'pure',
            interruptBehavior: 'cancel',
          },
        },
        {
          type: DurableEventType.TOOL_STARTED,
          requestId,
          turnId,
          toolAttemptId,
          data: {
            toolCallId,
            toolName: 'Read',
            input: { file_path: '/tmp/input' },
            sideEffect: 'pure',
          },
        },
        {
          type: DurableEventType.TOOL_COMPLETED,
          requestId,
          turnId,
          toolAttemptId,
          data: {
            toolCallId,
            toolName: 'Read',
            result: { content: 'durable result' },
          },
        },
      ],
    });

    const result = await new DurableSessionRecoveryCoordinator(journal).prepareTurnRecovery({
      commandId: CommandId('rollover-completed-safe-tool'),
      requestId,
      turnId,
      recoveryRequestId: rolloverRequestId,
      recoveryInputId: rolloverInputId,
    });

    expect(result.commit.events.map((event) => event.type)).toEqual([
      DurableEventType.TURN_ABORTED,
      DurableEventType.REQUEST_INTERRUPTED,
      DurableEventType.REQUEST_ACCEPTED,
    ]);
    expect(result.continuation).toContain('"status": "completed"');
    expect(result.continuation).toContain('"content": "durable result"');
  });

  it('bounds oversized tool state and marks every truncated value as incomplete', async () => {
    const store = createStore();
    const journal = await createJournal(store, { requestStarted: true });
    const oversized = 'x'.repeat(5_000);
    const failedAttemptId = ToolAttemptId('recovery-failed-attempt');
    const failedCallId = ToolUseId('recovery-failed-call');
    await journal.commit({
      commandId: CommandId('settle-oversized-tools'),
      events: [
        {
          type: DurableEventType.TURN_STARTED,
          requestId,
          turnId,
          data: { turn: 1, model: 'accepted-model' },
        },
        {
          type: DurableEventType.TOOL_SCHEDULED,
          requestId,
          turnId,
          toolAttemptId,
          data: {
            toolCallId,
            toolName: 'Read',
            input: { payload: oversized },
            sideEffect: 'pure',
            interruptBehavior: 'cancel',
          },
        },
        {
          type: DurableEventType.TOOL_STARTED,
          requestId,
          turnId,
          toolAttemptId,
          data: {
            toolCallId,
            toolName: 'Read',
            input: { payload: oversized },
            sideEffect: 'pure',
          },
        },
        {
          type: DurableEventType.TOOL_COMPLETED,
          requestId,
          turnId,
          toolAttemptId,
          data: {
            toolCallId,
            toolName: 'Read',
            result: { payload: oversized },
          },
        },
        {
          type: DurableEventType.TOOL_SCHEDULED,
          requestId,
          turnId,
          toolAttemptId: failedAttemptId,
          data: {
            toolCallId: failedCallId,
            toolName: 'Search',
            input: {},
            sideEffect: 'pure',
            interruptBehavior: 'cancel',
          },
        },
        {
          type: DurableEventType.TOOL_FAILED,
          requestId,
          turnId,
          toolAttemptId: failedAttemptId,
          data: {
            toolCallId: failedCallId,
            toolName: 'Search',
            error: { message: oversized },
          },
        },
      ],
    });

    const result = await new DurableSessionRecoveryCoordinator(journal).prepareTurnRecovery({
      commandId: CommandId('rollover-oversized-tools'),
      requestId,
      turnId,
      recoveryRequestId: rolloverRequestId,
      recoveryInputId: rolloverInputId,
    });

    expect(typeof result.continuation).toBe('string');
    if (typeof result.continuation !== 'string') {
      throw new Error('Expected a text recovery continuation');
    }
    expect(result.continuation.match(/"kind": "truncated_recovery_value"/g)).toHaveLength(3);
    expect(result.continuation).toContain('"complete": false');
    expect(result.continuation).toContain('"originalJsonCharacters":');
    expect(result.continuation).not.toContain(oversized);
    expect(result.continuation.length).toBeLessThan(14_000);
  });

  it.each([
    {
      outcome: {
        status: 'completed' as const,
        result: { deploymentId: 'dep-unsafe' },
      },
    },
    {
      outcome: {
        status: 'failed' as const,
        error: { message: 'remote outcome may be partial' },
      },
    },
    {
      outcome: {
        status: 'cancelled' as const,
      },
    },
  ])('refuses rollover after a non-idempotent $outcome.status', async ({ outcome }) => {
    const store = createStore();
    await createJournal(store, { requestStarted: true, tool: 'started' });
    const coordinator = await DurableSessionRecoveryCoordinator.open(store, sessionId);
    await coordinator.reconcileToolOutcome({
      commandId: CommandId(`settle-${outcome.status}`),
      toolAttemptId,
      outcome,
    });

    await expect(
      coordinator.prepareTurnRecovery({
        commandId: CommandId(`rollover-${outcome.status}`),
        requestId,
        turnId,
        recoveryRequestId: rolloverRequestId,
        recoveryInputId: rolloverInputId,
      }),
    ).rejects.toMatchObject({
      code: 'DURABLE_RECOVERY_UNSAFE_ROLLOVER',
    });
  });

  it('rejects a reused command that contains work after accepting the continuation', async () => {
    const store = createStore();
    const journal = await createJournal(store, { requestStarted: true });
    const commandId = CommandId('rollover-and-start');
    await journal.commit({
      commandId: CommandId('start-turn-before-rollover-and-start'),
      events: [
        {
          type: DurableEventType.TURN_STARTED,
          requestId,
          turnId,
          data: { turn: 1, model: 'accepted-model' },
        },
      ],
    });
    await journal.commit({
      commandId,
      events: [
        {
          type: DurableEventType.TURN_ABORTED,
          requestId,
          turnId,
          data: { turn: 1, reason: 'process_restart' },
        },
        {
          type: DurableEventType.REQUEST_INTERRUPTED,
          requestId,
          data: { reason: 'process_restart' },
        },
        {
          type: DurableEventType.REQUEST_ACCEPTED,
          requestId: rolloverRequestId,
          data: {
            inputId: rolloverInputId,
            input: 'continue',
            priority: 'next',
            maxTurns: 17,
            model: 'accepted-model',
            context: {},
            recovery: {
              requestId,
              turnId,
              turn: 1,
            },
          },
        },
        {
          type: DurableEventType.INPUT_APPLIED,
          requestId: rolloverRequestId,
          data: { inputId: rolloverInputId, priority: 'next' },
        },
        {
          type: DurableEventType.REQUEST_STARTED,
          requestId: rolloverRequestId,
          data: {},
        },
      ],
    });

    await expect(
      new DurableSessionRecoveryCoordinator(journal).prepareTurnRecovery({
        commandId,
        requestId,
        turnId,
        recoveryRequestId: rolloverRequestId,
        recoveryInputId: rolloverInputId,
      }),
    ).rejects.toMatchObject({
      code: 'DURABLE_RECOVERY_INVALID_STATE',
    });
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
