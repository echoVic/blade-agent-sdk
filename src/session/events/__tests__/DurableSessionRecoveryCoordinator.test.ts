import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CommandId,
  EventId,
  InputId,
  ModelAttemptId,
  PermissionRequestId,
  RequestId,
  SessionId,
  ToolAttemptId,
  ToolUseId,
  TurnId,
} from '../../../types/identifiers.js';
import { DurableSessionJournal } from '../DurableSessionJournal.js';
import { DurableSessionRecoveryCoordinator } from '../DurableSessionRecoveryCoordinator.js';
import { JsonlDurableEventStore } from '../JsonlDurableEventStore.js';
import { type DurableEventDraft, DurableEventType } from '../types.js';

const sessionId = SessionId('recovery-session');
const requestId = RequestId('source-request');
const inputId = InputId('source-input');
const turnId = TurnId('source-turn');
const modelAttemptId = ModelAttemptId('model-attempt');
const toolAttemptId = ToolAttemptId('tool-attempt');
const toolCallId = ToolUseId('tool-call');
const permissionRequestId = PermissionRequestId('permission-request');
const recoveryRequestId = RequestId('recovery-request');
const recoveryInputId = InputId('recovery-input');
const recoveryTurnId = TurnId('recovery-turn');
const roots: string[] = [];

function startedRequest(): DurableEventDraft[] {
  return [
    {
      type: DurableEventType.INPUT_APPLIED,
      requestId,
      data: { inputId, priority: 'next' },
    },
    {
      type: DurableEventType.REQUEST_STARTED,
      requestId,
      data: {},
    },
  ];
}

function startedTurn(): DurableEventDraft[] {
  return [
    ...startedRequest(),
    {
      type: DurableEventType.TURN_STARTED,
      requestId,
      turnId,
      data: { turn: 1, model: 'test-model' },
    },
  ];
}

function completedModelWithTool(): DurableEventDraft[] {
  return [
    {
      type: DurableEventType.MODEL_REQUEST_STARTED,
      requestId,
      turnId,
      modelAttemptId,
      data: { model: 'test-model', streaming: false },
    },
    {
      type: DurableEventType.MODEL_REQUEST_COMPLETED,
      requestId,
      turnId,
      modelAttemptId,
      data: {
        response: {
          content: '',
          toolCalls: [
            {
              id: toolCallId,
              name: 'Deploy',
              arguments: '{"environment":"production"}',
            },
          ],
        },
      },
    },
  ];
}

function scheduledTool(
  sideEffect: 'pure' | 'idempotent' | 'non_idempotent' = 'non_idempotent',
): DurableEventDraft {
  return {
    type: DurableEventType.TOOL_SCHEDULED,
    requestId,
    turnId,
    modelAttemptId,
    toolAttemptId,
    data: {
      toolCallId,
      toolName: 'Deploy',
      modelInput: { environment: 'production' },
      input: { environment: 'production' },
      sideEffect,
      interruptBehavior: 'block',
    },
  };
}

async function createCoordinator(
  tail: readonly DurableEventDraft[] = [],
): Promise<DurableSessionRecoveryCoordinator> {
  const root = await mkdtemp(join(tmpdir(), 'durable-recovery-'));
  roots.push(root);
  let nextEventId = 0;
  const store = new JsonlDurableEventStore(root, {
    clock: () => new Date('2026-09-16T12:00:00.000Z'),
    eventIdFactory: () => EventId(`event-${++nextEventId}`),
  });
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
          input: 'Finish the deployment',
          priority: 'next',
          maxTurns: 8,
          model: 'test-model',
          context: { id: 'runtime-context' },
        },
      },
      ...tail,
    ],
  });
  return new DurableSessionRecoveryCoordinator(journal);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('DurableSessionRecoveryCoordinator', () => {
  it('auto-resumes only an untouched accepted request', async () => {
    const accepted = await createCoordinator();
    const running = await createCoordinator(startedRequest());

    expect(accepted.planResume()).toMatchObject({
      action: 'resume_accepted_request',
      request: {
        requestId,
        inputId,
        maxTurns: 8,
        model: 'test-model',
      },
    });
    expect(running.planResume()).toMatchObject({
      action: 'recovery_required',
      recoveryPlan: { action: 'rollover_request' },
    });
  });

  it('rolls over a pre-turn request and replays the journal command authoritatively', async () => {
    const coordinator = await createCoordinator(startedRequest());
    const command = {
      commandId: CommandId('request-rollover'),
      requestId,
      inputId,
      sourceLastTurn: 0,
      recoveryTurnId,
      recoveryRequestId,
      recoveryInputId,
      preparation: {
        status: 'reconciled' as const,
        appliedInputIds: [inputId],
        input: 'Prepared source request',
      },
    };

    await expect(
      coordinator.prepareRequestRecovery({ ...command, sourceLastTurn: 1 }),
    ).rejects.toMatchObject({
      code: 'DURABLE_RECOVERY_TARGET_NOT_FOUND',
    });

    const committed = await coordinator.prepareRequestRecovery(command);
    const replayed = await coordinator.prepareRequestRecovery(command);

    expect(committed.commit.events.map((event) => event.type)).toEqual([
      DurableEventType.TURN_STARTED,
      DurableEventType.TURN_ABORTED,
      DurableEventType.REQUEST_INTERRUPTED,
      DurableEventType.REQUEST_ACCEPTED,
    ]);
    expect(replayed.commit.status).toBe('replayed');
    expect(replayed.continuation).toBe(committed.continuation);
    expect(replayed.projection.activeRequest).toMatchObject({
      requestId: recoveryRequestId,
      recoveryKind: 'pre_turn_request',
    });
  });

  it('reconciles a model outcome and rejects a stale attempt', async () => {
    const coordinator = await createCoordinator([
      ...startedTurn(),
      {
        type: DurableEventType.MODEL_REQUEST_STARTED,
        requestId,
        turnId,
        modelAttemptId,
        data: { model: 'test-model', streaming: true },
      },
    ]);

    await expect(
      coordinator.reconcileModelOutcome({
        commandId: CommandId('stale-model'),
        requestId,
        turnId,
        modelAttemptId: ModelAttemptId('stale-attempt'),
        outcome: { status: 'aborted' },
      }),
    ).rejects.toMatchObject({
      code: 'DURABLE_RECOVERY_TARGET_NOT_FOUND',
    });

    const command = {
      commandId: CommandId('model-outcome'),
      requestId,
      turnId,
      modelAttemptId,
      outcome: {
        status: 'completed' as const,
        response: { content: 'Provider response' },
      },
    };
    const committed = await coordinator.reconcileModelOutcome(command);
    const replayed = await coordinator.reconcileModelOutcome(command);

    expect(committed.recoveryPlan.action).toBe('resume_turn');
    expect(committed.projection.activeRequest?.activeTurn?.modelAttempts[0]).toMatchObject({
      status: 'completed',
      response: { content: 'Provider response' },
    });
    expect(replayed.commit.status).toBe('replayed');
  });

  it('resolves permission before starting and reconciling a tool', async () => {
    const coordinator = await createCoordinator([
      ...startedTurn(),
      ...completedModelWithTool(),
      scheduledTool('pure'),
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
    ]);

    await coordinator.resolvePermission({
      commandId: CommandId('allow-tool'),
      permissionRequestId,
      decision: 'allow',
    });
    const started = await coordinator.startToolAttempt({
      commandId: CommandId('start-tool'),
      toolAttemptId,
    });
    const command = {
      commandId: CommandId('tool-outcome'),
      toolAttemptId,
      outcome: {
        status: 'completed' as const,
        result: { deploymentId: 'dep-123' },
      },
    };
    const completed = await coordinator.reconcileToolOutcome(command);
    const replayed = await coordinator.reconcileToolOutcome(command);

    expect(started.recoveryPlan.action).toBe('reconcile_tool_outcomes');
    expect(completed.recoveryPlan.action).toBe('resume_turn');
    expect(completed.projection.activeRequest?.activeTurn?.toolAttempts[0]).toMatchObject({
      status: 'completed',
      input: { environment: 'approved-production' },
      result: { deploymentId: 'dep-123' },
    });
    expect(replayed.commit.status).toBe('replayed');
  });

  it('preserves completed tool results in a turn recovery continuation', async () => {
    const coordinator = await createCoordinator([
      ...startedTurn(),
      ...completedModelWithTool(),
      scheduledTool(),
      {
        type: DurableEventType.TOOL_STARTED,
        requestId,
        turnId,
        toolAttemptId,
        data: {
          toolCallId,
          toolName: 'Deploy',
          input: { environment: 'production' },
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
          toolName: 'Deploy',
          result: { deploymentId: 'dep-123' },
        },
      },
    ]);

    const result = await coordinator.prepareTurnRecovery({
      commandId: CommandId('turn-rollover'),
      requestId,
      turnId,
      recoveryRequestId,
      recoveryInputId,
    });

    expect(result.continuation).toContain('"status": "completed"');
    expect(result.continuation).toContain('"deploymentId": "dep-123"');
    expect(result.projection.activeRequest).toMatchObject({
      requestId: recoveryRequestId,
      recoveryKind: 'turn',
    });
  });
});
