import type { UserMessageContent } from '../../agent/types.js';
import { SdkError } from '../../errors/SdkError.js';
import type {
  CommandId,
  EventSequence,
  InputId,
  PermissionRequestId,
  RequestId,
  SessionId,
  ToolAttemptId,
  TurnId,
} from '../../types/branded.js';
import type { JsonObject, JsonValue } from '../../types/common.js';
import { toJsonValue } from '../../utils/jsonValue.js';
import { parseDurableUserMessageContent } from '../DurableRequestRecovery.js';
import type { DurableEventStore } from './DurableEventStore.js';
import {
  type DurableCommandCommitOptions,
  type DurableCommandCommitResult,
  type DurableCommandEventDraft,
  type DurableSessionCommand,
  DurableSessionJournal,
  type DurableSessionJournalOptions,
} from './DurableSessionJournal.js';
import {
  DurableEventProjectionError,
  type DurablePermissionProjection,
  type DurableRequestProjection,
  type DurableSessionProjection,
  type DurableSessionRecoveryPlan,
  type DurableToolAttemptProjection,
  hasCrossedNonIdempotentBoundary,
} from './DurableSessionProjector.js';
import {
  type DurableEventEnvelope,
  type DurableEventError,
  DurableEventType,
  type DurablePermissionDecision,
} from './types.js';

export type DurableAcceptedRequestRecovery = DurableRequestProjection & {
  readonly maxTurns: number;
  readonly model: string;
  readonly context: JsonObject;
};

export type DurableSessionResumeDecision =
  | {
      readonly action: 'ready';
      readonly projection: DurableSessionProjection;
      readonly recoveryPlan: DurableSessionRecoveryPlan;
    }
  | {
      readonly action: 'resume_accepted_request';
      readonly projection: DurableSessionProjection;
      readonly recoveryPlan: DurableSessionRecoveryPlan;
      readonly request: DurableAcceptedRequestRecovery;
    }
  | {
      readonly action: 'recovery_required';
      readonly projection: DurableSessionProjection;
      readonly recoveryPlan: DurableSessionRecoveryPlan;
    };

export type DurableToolOutcomeReconciliation =
  | {
      readonly status: 'completed';
      readonly result: JsonValue;
    }
  | {
      readonly status: 'failed';
      readonly error: DurableEventError;
    }
  | {
      readonly status: 'cancelled';
    };

export interface DurableToolOutcomeReconciliationCommand {
  readonly commandId: CommandId;
  readonly toolAttemptId: ToolAttemptId;
  readonly outcome: DurableToolOutcomeReconciliation;
}

export interface DurableToolStartCommand {
  readonly commandId: CommandId;
  readonly toolAttemptId: ToolAttemptId;
}

export interface DurablePermissionResolutionCommand {
  readonly commandId: CommandId;
  readonly permissionRequestId: PermissionRequestId;
  readonly decision: DurablePermissionDecision;
  readonly message?: string;
}

export interface DurableTurnRecoveryCommand {
  readonly commandId: CommandId;
  readonly requestId: RequestId;
  readonly turnId: TurnId;
  readonly recoveryRequestId: RequestId;
  readonly recoveryInputId: InputId;
}

export interface DurableRecoveryCommitResult {
  readonly commit: DurableCommandCommitResult;
  readonly projection: DurableSessionProjection;
  readonly recoveryPlan: DurableSessionRecoveryPlan;
}

export interface DurableTurnRecoveryResult extends DurableRecoveryCommitResult {
  readonly continuation: UserMessageContent;
  readonly interruptedRequestId: RequestId;
  readonly recoveryRequestId: RequestId;
}

export type DurableSessionRecoveryErrorCode =
  | 'DURABLE_RECOVERY_INVALID_STATE'
  | 'DURABLE_RECOVERY_TARGET_NOT_FOUND'
  | 'DURABLE_RECOVERY_UNSAFE_ROLLOVER';

export class DurableSessionRecoveryError extends SdkError {
  // biome-ignore lint/complexity/noUselessConstructor: narrows the public error-code contract
  constructor(
    code: DurableSessionRecoveryErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(code, message, options);
  }
}

function isAcceptedRequestRecovery(
  request: DurableRequestProjection | null,
  projection: DurableSessionProjection,
  recoveryPlan: DurableSessionRecoveryPlan,
): request is DurableAcceptedRequestRecovery {
  return (
    recoveryPlan.action === 'resume_request' &&
    request?.status === 'accepted' &&
    request.activeTurn === null &&
    !projection.appliedInputIds.includes(request.inputId) &&
    request.maxTurns !== undefined &&
    request.model !== undefined &&
    request.context !== undefined
  );
}

function eventToCommandDraft(event: DurableEventEnvelope): DurableCommandEventDraft {
  return {
    type: event.type,
    data: event.data,
    occurredAt: event.occurredAt,
    ...('requestId' in event ? { requestId: event.requestId } : {}),
    ...('turnId' in event ? { turnId: event.turnId } : {}),
    ...('toolAttemptId' in event ? { toolAttemptId: event.toolAttemptId } : {}),
    ...(event.causationEventId ? { causationEventId: event.causationEventId } : {}),
  } as DurableCommandEventDraft;
}

function validatePersistedTurnRecovery(
  events: readonly DurableEventEnvelope[],
  command: DurableTurnRecoveryCommand,
): {
  continuation: UserMessageContent;
  interruptedRequestId: RequestId;
} {
  const accepted = events.at(-1);
  if (
    accepted?.type !== DurableEventType.REQUEST_ACCEPTED ||
    accepted.requestId !== command.recoveryRequestId ||
    accepted.data.inputId !== command.recoveryInputId ||
    !accepted.data.recovery ||
    accepted.data.recovery.requestId !== command.requestId ||
    accepted.data.recovery.turnId !== command.turnId
  ) {
    throw new DurableSessionRecoveryError(
      'DURABLE_RECOVERY_INVALID_STATE',
      `Durable command ${command.commandId} is not the requested turn recovery`,
    );
  }
  const origin = accepted.data.recovery;
  const turnAborted = events.at(-3);
  const requestInterrupted = events.at(-2);
  const cancellationsAreCanonical = events
    .slice(0, -3)
    .every(
      (event) =>
        event.type === DurableEventType.TOOL_CANCELLED &&
        event.requestId === origin.requestId &&
        event.turnId === origin.turnId &&
        (event.data.reason === 'process_restart' ||
          event.data.reason === 'permission_denied' ||
          event.data.reason === 'permission_cancelled'),
    );
  if (
    !turnAborted ||
    turnAborted.type !== DurableEventType.TURN_ABORTED ||
    turnAborted.requestId !== origin.requestId ||
    turnAborted.turnId !== origin.turnId ||
    turnAborted.data.turn !== origin.turn ||
    turnAborted.data.reason !== 'process_restart' ||
    !requestInterrupted ||
    requestInterrupted.type !== DurableEventType.REQUEST_INTERRUPTED ||
    requestInterrupted.requestId !== origin.requestId ||
    requestInterrupted.data.reason !== 'process_restart' ||
    !cancellationsAreCanonical
  ) {
    throw new DurableSessionRecoveryError(
      'DURABLE_RECOVERY_INVALID_STATE',
      `Durable command ${command.commandId} is not the requested turn recovery`,
    );
  }
  let continuation: UserMessageContent;
  try {
    continuation = parseDurableUserMessageContent(accepted.data.input);
  } catch (cause) {
    throw new DurableSessionRecoveryError(
      'DURABLE_RECOVERY_INVALID_STATE',
      `Durable command ${command.commandId} has an invalid recovery continuation`,
      { cause },
    );
  }
  return {
    continuation,
    interruptedRequestId: origin.requestId,
  };
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function buildTurnRecoveryContinuation(
  request: DurableRequestProjection,
  turn: NonNullable<DurableRequestProjection['activeTurn']>,
): UserMessageContent {
  let originalInput: UserMessageContent;
  try {
    originalInput = parseDurableUserMessageContent(request.input);
  } catch (cause) {
    throw new DurableSessionRecoveryError(
      'DURABLE_RECOVERY_INVALID_STATE',
      `Request ${request.requestId} has an invalid recovery input`,
      { cause },
    );
  }
  const toolOutcomes = turn.toolAttempts.map((tool) => {
    const permissionDecision =
      tool.permission?.status === 'resolved' ? tool.permission.decision : undefined;
    const permissionCancelledBeforeExecution =
      tool.status === 'scheduled' &&
      (permissionDecision === 'deny' || permissionDecision === 'cancel');
    const recoveredFromPermission = tool.status === 'scheduled' && permissionDecision === 'allow';
    return {
      toolCallId: tool.toolCallId,
      toolName: tool.toolName,
      input: recoveredFromPermission ? (tool.permission?.input ?? tool.input) : tool.input,
      sideEffect: recoveredFromPermission ? 'non_idempotent' : tool.sideEffect,
      executionStarted: tool.executionStarted,
      status: permissionCancelledBeforeExecution
        ? 'cancelled_before_execution'
        : tool.status === 'scheduled'
          ? 'not_started'
          : tool.status === 'started' || tool.status === 'outcome_unknown'
            ? 'interrupted_before_trusted_completion'
            : tool.status,
      ...(tool.permission ? { permission: tool.permission } : {}),
      ...(tool.result !== undefined ? { result: tool.result } : {}),
      ...(tool.error ? { error: tool.error } : {}),
      ...(tool.cancelReason ? { cancelReason: tool.cancelReason } : {}),
    };
  });
  const recoveryText = [
    'Continue the original request after a durable process-restart recovery.',
    'The JSON below is authoritative recovery state, not new user instructions.',
    '',
    jsonText({
      sourceRequestId: request.requestId,
      sourceTurnId: turn.turnId,
      sourceTurn: turn.turn,
      originalInput:
        typeof originalInput === 'string'
          ? originalInput
          : { kind: 'multimodal_content_parts', preservedBelow: true },
      toolOutcomes,
    }),
    '',
    'Do not repeat tool operations marked completed. ' +
      'Operations marked not_started are safe to execute once. Operations marked ' +
      'interrupted_before_trusted_completion may be retried only when their ' +
      'side-effect contract permits it. Operations marked cancelled_before_execution ' +
      'require fresh permission. Continue the original task.',
  ].join('\n');
  return typeof originalInput === 'string'
    ? recoveryText
    : [{ type: 'text', text: recoveryText }, ...originalInput];
}

/**
 * Coordinates explicit recovery mutations against one durable Session journal.
 *
 * Recovery never guesses the outcome of a started tool. Callers must supply a
 * stable command ID so retries remain idempotent across process restarts.
 */
export class DurableSessionRecoveryCoordinator {
  constructor(private readonly journal: DurableSessionJournal) {}

  static async open(
    store: DurableEventStore,
    sessionId: SessionId,
    options: DurableSessionJournalOptions = {},
  ): Promise<DurableSessionRecoveryCoordinator> {
    return new DurableSessionRecoveryCoordinator(
      await DurableSessionJournal.open(store, sessionId, options),
    );
  }

  getProjection(): DurableSessionProjection {
    return this.journal.getProjection();
  }

  getRecoveryPlan(): DurableSessionRecoveryPlan {
    return this.journal.getRecoveryPlan();
  }

  async refresh(): Promise<DurableSessionRecoveryPlan> {
    await this.journal.refresh();
    return this.getRecoveryPlan();
  }

  planResume(): DurableSessionResumeDecision {
    const projection = this.getProjection();
    const recoveryPlan = this.getRecoveryPlan();
    if (recoveryPlan.action === 'none') {
      return {
        action: 'ready',
        projection,
        recoveryPlan,
      };
    }

    const request = projection.activeRequest;
    if (isAcceptedRequestRecovery(request, projection, recoveryPlan)) {
      return {
        action: 'resume_accepted_request',
        projection,
        recoveryPlan,
        request,
      };
    }

    return {
      action: 'recovery_required',
      projection,
      recoveryPlan,
    };
  }

  /**
   * Atomically terminates a retry-safe active Turn and accepts its durable
   * continuation as a new Request.
   */
  async prepareTurnRecovery(
    command: DurableTurnRecoveryCommand,
  ): Promise<DurableTurnRecoveryResult> {
    await this.journal.refresh();
    const existing = this.journal.getCommandEvents(command.commandId);
    if (existing) {
      const persisted = validatePersistedTurnRecovery(existing, command);
      const commit = await this.commitRecovery({
        commandId: command.commandId,
        events: existing.map(eventToCommandDraft),
      });
      return {
        ...this.result(commit),
        continuation: persisted.continuation,
        interruptedRequestId: persisted.interruptedRequestId,
        recoveryRequestId: command.recoveryRequestId,
      };
    }

    const projection = this.getProjection();
    const recoveryPlan = this.getRecoveryPlan();
    const request = projection.activeRequest;
    const turn = request?.activeTurn;
    if (recoveryPlan.action !== 'resume_turn' || !request || !turn) {
      throw new DurableSessionRecoveryError(
        'DURABLE_RECOVERY_INVALID_STATE',
        `Turn recovery requires resume_turn, found ${recoveryPlan.action}`,
      );
    }
    if (request.requestId !== command.requestId || turn.turnId !== command.turnId) {
      throw new DurableSessionRecoveryError(
        'DURABLE_RECOVERY_TARGET_NOT_FOUND',
        `No active turn matches ${command.requestId}/${command.turnId}`,
      );
    }
    if (
      request.maxTurns === undefined ||
      request.model === undefined ||
      request.context === undefined
    ) {
      throw new DurableSessionRecoveryError(
        'DURABLE_RECOVERY_INVALID_STATE',
        `Request ${request.requestId} has no complete execution snapshot`,
      );
    }
    const unsafeTool = turn.toolAttempts.find(hasCrossedNonIdempotentBoundary);
    if (unsafeTool) {
      throw new DurableSessionRecoveryError(
        'DURABLE_RECOVERY_UNSAFE_ROLLOVER',
        `Tool attempt ${unsafeTool.toolAttemptId} crossed a non-idempotent boundary`,
      );
    }

    const continuation = buildTurnRecoveryContinuation(request, turn);
    const events: DurableCommandEventDraft[] = [];
    for (const tool of turn.toolAttempts) {
      if (
        tool.status !== 'scheduled' &&
        tool.status !== 'started' &&
        tool.status !== 'outcome_unknown'
      ) {
        continue;
      }
      const permissionDecision =
        tool.permission?.status === 'resolved' ? tool.permission.decision : undefined;
      events.push({
        type: DurableEventType.TOOL_CANCELLED,
        requestId: request.requestId,
        turnId: turn.turnId,
        toolAttemptId: tool.toolAttemptId,
        data: {
          toolCallId: tool.toolCallId,
          toolName: tool.toolName,
          reason:
            permissionDecision === 'deny'
              ? 'permission_denied'
              : permissionDecision === 'cancel'
                ? 'permission_cancelled'
                : 'process_restart',
        },
      });
    }
    events.push(
      {
        type: DurableEventType.TURN_ABORTED,
        requestId: request.requestId,
        turnId: turn.turnId,
        data: {
          turn: turn.turn,
          reason: 'process_restart',
        },
      },
      {
        type: DurableEventType.REQUEST_INTERRUPTED,
        requestId: request.requestId,
        data: {
          reason: 'process_restart',
        },
      },
      {
        type: DurableEventType.REQUEST_ACCEPTED,
        requestId: command.recoveryRequestId,
        data: {
          inputId: command.recoveryInputId,
          input: toJsonValue(continuation),
          priority: 'next',
          maxTurns: request.maxTurns,
          model: request.model,
          context: request.context,
          recovery: {
            requestId: request.requestId,
            turnId: turn.turnId,
            turn: turn.turn,
          },
        },
      },
    );

    const commit = await this.commitRecovery({
      commandId: command.commandId,
      events,
    }, projection.headSequence);
    return {
      ...this.result(commit),
      continuation,
      interruptedRequestId: request.requestId,
      recoveryRequestId: command.recoveryRequestId,
    };
  }

  async reconcileToolOutcome(
    command: DurableToolOutcomeReconciliationCommand,
  ): Promise<DurableRecoveryCommitResult> {
    await this.journal.refresh();
    const expectedHeadSequence = this.getProjection().headSequence;
    const { request, turn, tool } = this.findToolAttempt(command.toolAttemptId);
    const event = (() => {
      const correlation = {
        requestId: request.requestId,
        turnId: turn.turnId,
        toolAttemptId: tool.toolAttemptId,
      };
      const identity = {
        toolCallId: tool.toolCallId,
        toolName: tool.toolName,
      };
      switch (command.outcome.status) {
        case 'completed':
          return {
            type: DurableEventType.TOOL_COMPLETED,
            ...correlation,
            data: {
              ...identity,
              result: command.outcome.result,
            },
          } as const;
        case 'failed':
          return {
            type: DurableEventType.TOOL_FAILED,
            ...correlation,
            data: {
              ...identity,
              error: command.outcome.error,
            },
          } as const;
        case 'cancelled':
          return {
            type: DurableEventType.TOOL_CANCELLED,
            ...correlation,
            data: {
              ...identity,
              reason: 'process_restart',
            },
          } as const;
      }
    })();

    const commit = await this.commitRecovery({
      commandId: command.commandId,
      events: [event],
    }, expectedHeadSequence);
    return this.result(commit);
  }

  async startToolAttempt(command: DurableToolStartCommand): Promise<DurableRecoveryCommitResult> {
    await this.journal.refresh();
    const expectedHeadSequence = this.getProjection().headSequence;
    const { request, turn, tool } = this.findToolAttempt(command.toolAttemptId);
    const recoveredFromPermission =
      tool.permission?.status === 'resolved' && tool.permission.decision === 'allow';
    const commit = await this.commitRecovery({
      commandId: command.commandId,
      events: [
        {
          type: DurableEventType.TOOL_STARTED,
          requestId: request.requestId,
          turnId: turn.turnId,
          toolAttemptId: tool.toolAttemptId,
          data: {
            toolCallId: tool.toolCallId,
            toolName: tool.toolName,
            input: recoveredFromPermission ? (tool.permission?.input ?? tool.input) : tool.input,
            // A permission round-trip may have changed input after scheduling.
            // Without the live Tool resolver, only the most conservative
            // classification is safe across the restart boundary.
            sideEffect: recoveredFromPermission ? 'non_idempotent' : tool.sideEffect,
          },
        },
      ],
    }, expectedHeadSequence);
    return this.result(commit);
  }

  async resolvePermission(
    command: DurablePermissionResolutionCommand,
  ): Promise<DurableRecoveryCommitResult> {
    await this.journal.refresh();
    const expectedHeadSequence = this.getProjection().headSequence;
    const { request, turn, tool, permission } = this.findPermission(command.permissionRequestId);
    const events = [
      {
        type: DurableEventType.PERMISSION_RESOLVED,
        requestId: request.requestId,
        turnId: turn.turnId,
        toolAttemptId: tool.toolAttemptId,
        data: {
          permissionRequestId: permission.permissionRequestId,
          decision: command.decision,
          ...(command.message !== undefined ? { message: command.message } : {}),
        },
      },
      ...(command.decision === 'allow'
        ? []
        : [
            {
              type: DurableEventType.TOOL_CANCELLED,
              requestId: request.requestId,
              turnId: turn.turnId,
              toolAttemptId: tool.toolAttemptId,
              data: {
                toolCallId: tool.toolCallId,
                toolName: tool.toolName,
                reason:
                  command.decision === 'deny'
                    ? ('permission_denied' as const)
                    : ('permission_cancelled' as const),
              },
            } as const,
          ]),
    ];

    const commit = await this.commitRecovery({
      commandId: command.commandId,
      events,
    }, expectedHeadSequence);
    return this.result(commit);
  }

  private findToolAttempt(toolAttemptId: ToolAttemptId): {
    request: DurableRequestProjection;
    turn: NonNullable<DurableRequestProjection['activeTurn']>;
    tool: DurableToolAttemptProjection;
  } {
    const request = this.getProjection().activeRequest;
    const turn = request?.activeTurn;
    const tool = turn?.toolAttempts.find((candidate) => candidate.toolAttemptId === toolAttemptId);
    if (!request || !turn || !tool) {
      throw new DurableSessionRecoveryError(
        'DURABLE_RECOVERY_TARGET_NOT_FOUND',
        `No active tool attempt matches ${toolAttemptId}`,
      );
    }
    return { request, turn, tool };
  }

  private findPermission(permissionRequestId: PermissionRequestId): {
    request: DurableRequestProjection;
    turn: NonNullable<DurableRequestProjection['activeTurn']>;
    tool: DurableToolAttemptProjection;
    permission: DurablePermissionProjection;
  } {
    const request = this.getProjection().activeRequest;
    const turn = request?.activeTurn;
    const tool = turn?.toolAttempts.find(
      (candidate) => candidate.permission?.permissionRequestId === permissionRequestId,
    );
    const permission = tool?.permission;
    if (!request || !turn || !tool || !permission) {
      throw new DurableSessionRecoveryError(
        'DURABLE_RECOVERY_TARGET_NOT_FOUND',
        `No active permission request matches ${permissionRequestId}`,
      );
    }
    return { request, turn, tool, permission };
  }

  private result(commit: DurableCommandCommitResult): DurableRecoveryCommitResult {
    return {
      commit,
      projection: this.getProjection(),
      recoveryPlan: this.getRecoveryPlan(),
    };
  }

  private async commitRecovery(
    command: DurableSessionCommand,
    expectedHeadSequence?: EventSequence | null,
  ): Promise<DurableCommandCommitResult> {
    try {
      const options: DurableCommandCommitOptions = expectedHeadSequence === undefined
        ? {}
        : { expectedHeadSequence };
      return await this.journal.commit(command, options);
    } catch (cause) {
      if (cause instanceof DurableEventProjectionError) {
        throw new DurableSessionRecoveryError(
          'DURABLE_RECOVERY_INVALID_STATE',
          `Durable recovery command ${command.commandId} is invalid: ${cause.message}`,
          { cause },
        );
      }
      throw cause;
    }
  }
}
