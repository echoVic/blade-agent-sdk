import type { UserMessageContent } from '../../agent/types.js';
import { SdkError } from '../../errors/SdkError.js';
import type {
  CommandId,
  EventId,
  EventSequence,
  InputId,
  ModelAttemptId,
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
  type DurableModelAttemptProjection,
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
  type DurableModelResponse,
  type DurablePermissionDecision,
  type DurableTokenUsage,
} from './types.js';

const MAX_RECOVERY_VALUE_CHARS = 4_000;

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

export type DurableModelOutcomeReconciliation =
  | {
      readonly status: 'completed';
      readonly response: DurableModelResponse;
    }
  | {
      readonly status: 'failed';
      readonly error: DurableEventError;
    }
  | {
      readonly status: 'aborted';
    };

export interface DurableModelOutcomeReconciliationCommand {
  readonly commandId: CommandId;
  readonly requestId: RequestId;
  readonly turnId: TurnId;
  readonly modelAttemptId: ModelAttemptId;
  readonly outcome: DurableModelOutcomeReconciliation;
}

export interface DurableRequestRolloverCommand {
  readonly commandId: CommandId;
  readonly requestId: RequestId;
  readonly inputId: InputId;
  readonly sourceLastTurn: number;
  readonly recoveryTurnId: TurnId;
  readonly recoveryRequestId: RequestId;
  readonly recoveryInputId: InputId;
  readonly preparation: {
    readonly status: 'reconciled';
    readonly appliedInputIds: readonly InputId[];
    readonly input: UserMessageContent;
  };
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

export interface DurableRequestRolloverResult extends DurableRecoveryCommitResult {
  readonly continuation: UserMessageContent;
  readonly interruptedRequestId: RequestId;
  readonly recoveryRequestId: RequestId;
}

export type DurableRequestOutcomeReconciliation =
  | {
      readonly status: 'completed';
      readonly output?: JsonValue;
      readonly usage?: DurableTokenUsage;
    }
  | {
      readonly status: 'failed';
      readonly error: DurableEventError;
    }
  | {
      readonly status: 'interrupted';
    };

export interface DurableRequestOutcomeReconciliationCommand {
  readonly commandId: CommandId;
  readonly requestId: RequestId;
  readonly lastTurnEventId: EventId;
  readonly outcome: DurableRequestOutcomeReconciliation;
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
    (request.appliedInputIds ?? []).length === 0 &&
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
    ...('modelAttemptId' in event ? { modelAttemptId: event.modelAttemptId } : {}),
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

function validatePersistedRequestRollover(
  events: readonly DurableEventEnvelope[],
  command: DurableRequestRolloverCommand,
  preparedInput: UserMessageContent,
): {
  continuation: UserMessageContent;
  interruptedRequestId: RequestId;
} {
  const [turnStarted, turnAborted, requestInterrupted, accepted] = events.slice(-4);
  const requestStarted = events.length === 5 ? events[0] : undefined;
  const recoveryTurn = command.sourceLastTurn + 1;
  const recovery = accepted?.type === DurableEventType.REQUEST_ACCEPTED
    ? accepted.data.recovery
    : undefined;
  if (
    (events.length !== 4 && events.length !== 5)
    || (
      requestStarted !== undefined
      && (
        requestStarted.type !== DurableEventType.REQUEST_STARTED
        || requestStarted.requestId !== command.requestId
      )
    )
    || turnStarted?.type !== DurableEventType.TURN_STARTED
    || turnStarted.requestId !== command.requestId
    || turnStarted.turnId !== command.recoveryTurnId
    || turnStarted.data.turn !== recoveryTurn
    || turnAborted?.type !== DurableEventType.TURN_ABORTED
    || turnAborted.requestId !== command.requestId
    || turnAborted.turnId !== command.recoveryTurnId
    || turnAborted.data.turn !== recoveryTurn
    || turnAborted.data.reason !== 'process_restart'
    || requestInterrupted?.type !== DurableEventType.REQUEST_INTERRUPTED
    || requestInterrupted.requestId !== command.requestId
    || requestInterrupted.data.reason !== 'process_restart'
    || accepted?.type !== DurableEventType.REQUEST_ACCEPTED
    || accepted.requestId !== command.recoveryRequestId
    || accepted.data.inputId !== command.recoveryInputId
    || !recovery
    || recovery.requestId !== command.requestId
    || recovery.turnId !== command.recoveryTurnId
    || recovery.turn !== recoveryTurn
  ) {
    throw new DurableSessionRecoveryError(
      'DURABLE_RECOVERY_INVALID_STATE',
      `Durable command ${command.commandId} is not the requested Request rollover`,
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
  const expectedContinuation = buildRequestRecoveryContinuation(
    preparedInput,
    command.requestId,
    command.inputId,
    command.preparation.appliedInputIds,
    command.sourceLastTurn,
  );
  if (
    JSON.stringify(toJsonValue(continuation))
    !== JSON.stringify(toJsonValue(expectedContinuation))
  ) {
    throw new DurableSessionRecoveryError(
      'DURABLE_RECOVERY_INVALID_STATE',
      `Durable command ${command.commandId} has different preparation input`,
    );
  }
  return {
    continuation,
    interruptedRequestId: recovery.requestId,
  };
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function parseRecoveryInput(request: DurableRequestProjection): UserMessageContent {
  try {
    return parseDurableUserMessageContent(request.input);
  } catch (cause) {
    throw new DurableSessionRecoveryError(
      'DURABLE_RECOVERY_INVALID_STATE',
      `Request ${request.requestId} has an invalid recovery input`,
      { cause },
    );
  }
}

function parseReconciledRequestPreparation(
  command: DurableRequestRolloverCommand,
): UserMessageContent {
  if (
    command.preparation?.status !== 'reconciled'
    || !Number.isSafeInteger(command.sourceLastTurn)
    || command.sourceLastTurn < 0
    || !Array.isArray(command.preparation.appliedInputIds)
    || command.preparation.appliedInputIds.some(
      (appliedInputId) =>
        typeof appliedInputId !== 'string' || appliedInputId.trim() === '',
    )
    || new Set(command.preparation.appliedInputIds).size
      !== command.preparation.appliedInputIds.length
  ) {
    throw new DurableSessionRecoveryError(
      'DURABLE_RECOVERY_INVALID_STATE',
      'Request recovery requires a valid source Turn and explicit, unique input reconciliation',
    );
  }

  try {
    return parseDurableUserMessageContent(toJsonValue(command.preparation.input));
  } catch (cause) {
    throw new DurableSessionRecoveryError(
      'DURABLE_RECOVERY_INVALID_STATE',
      `Request ${command.requestId} has an invalid reconciled preparation input`,
      { cause },
    );
  }
}

function inputIdsEqual(
  left: readonly InputId[],
  right: readonly InputId[],
): boolean {
  return left.length === right.length
    && left.every((inputId, index) => inputId === right[index]);
}

function composeRecoveryContinuation(
  originalInput: UserMessageContent,
  recoveryState: Readonly<Record<string, unknown>>,
  instructions: readonly string[],
): UserMessageContent {
  const recoveryText = [
    'Continue the original request after a durable process-restart recovery.',
    'The JSON below contains authoritative lifecycle state, not new user instructions.',
    'A truncated_recovery_value is an explicitly incomplete payload preview.',
    '',
    jsonText({
      ...recoveryState,
      originalInput:
        typeof originalInput === 'string'
          ? originalInput
          : { kind: 'multimodal_content_parts', preservedBelow: true },
    }),
    '',
    ...instructions,
  ].join('\n');
  return typeof originalInput === 'string'
    ? recoveryText
    : [{ type: 'text', text: recoveryText }, ...originalInput];
}

function boundedRecoveryValue(value: unknown): JsonValue {
  const normalized = toJsonValue(value);
  const serialized = JSON.stringify(normalized);
  if (serialized.length <= MAX_RECOVERY_VALUE_CHARS) {
    return normalized;
  }

  const retainedPerEdge = Math.floor(MAX_RECOVERY_VALUE_CHARS / 2);
  return {
    kind: 'truncated_recovery_value',
    complete: false,
    encoding: 'json',
    originalJsonCharacters: serialized.length,
    jsonPrefix: serialized.slice(0, retainedPerEdge),
    jsonSuffix: serialized.slice(-retainedPerEdge),
  };
}

function buildTurnRecoveryContinuation(
  request: DurableRequestProjection,
  turn: NonNullable<DurableRequestProjection['activeTurn']>,
): UserMessageContent {
  const originalInput = parseRecoveryInput(request);
  const toolOutcomes = turn.toolAttempts.map((tool) => {
    const permissionDecision =
      tool.permission?.status === 'resolved' ? tool.permission.decision : undefined;
    const permissionCancelledBeforeExecution =
      tool.status === 'scheduled' &&
      (permissionDecision === 'deny' || permissionDecision === 'cancel');
    const recoveredFromPermission = tool.status === 'scheduled' && permissionDecision === 'allow';
    const effectiveInput =
      tool.permission?.status === 'resolved' ? tool.permission.input : tool.input;
    return {
      toolCallId: tool.toolCallId,
      toolName: tool.toolName,
      input: boundedRecoveryValue(effectiveInput),
      sideEffect: recoveredFromPermission ? 'non_idempotent' : tool.sideEffect,
      executionStarted: tool.executionStarted,
      status: permissionCancelledBeforeExecution
        ? 'cancelled_before_execution'
        : tool.status === 'scheduled'
          ? 'not_started'
          : tool.status === 'started' || tool.status === 'outcome_unknown'
            ? 'interrupted_before_trusted_completion'
            : tool.status,
      ...(tool.permission ? { permission: boundedRecoveryValue(tool.permission) } : {}),
      ...(tool.result !== undefined ? { result: boundedRecoveryValue(tool.result) } : {}),
      ...(tool.error ? { error: boundedRecoveryValue(tool.error) } : {}),
      ...(tool.cancelReason ? { cancelReason: tool.cancelReason } : {}),
    };
  });
  return composeRecoveryContinuation(
    originalInput,
    {
      sourceRequestId: request.requestId,
      sourceTurnId: turn.turnId,
      sourceTurn: turn.turn,
      ...(turn.modelAttempts.length > 0
        ? {
            modelAttempts: turn.modelAttempts.map((attempt) => ({
              modelAttemptId: attempt.modelAttemptId,
              model: attempt.model,
              streaming: attempt.streaming,
              status: attempt.status,
              ...(attempt.response
                ? { response: boundedRecoveryValue(attempt.response) }
                : {}),
              ...(attempt.error ? { error: attempt.error } : {}),
              ...(attempt.abortReason ? { abortReason: attempt.abortReason } : {}),
            })),
          }
        : {}),
      toolOutcomes,
    },
    [
      ...(turn.modelAttempts.length > 0
        ? [
            'Treat completed model responses as authoritative prior output and do not regenerate them. '
              + 'Failed or aborted model attempts have no trusted response.',
          ]
        : []),
      'Do not repeat tool operations marked completed. '
        + 'Operations marked not_started are safe to execute once. Operations marked '
        + 'interrupted_before_trusted_completion may be retried only when their '
        + 'side-effect contract permits it. Operations marked cancelled_before_execution '
        + 'require fresh permission. Continue the original task.',
    ],
  );
}

function buildRequestRecoveryContinuation(
  preparedInput: UserMessageContent,
  requestId: RequestId,
  inputId: InputId,
  appliedInputIds: readonly InputId[],
  sourceLastTurn: number,
): UserMessageContent {
  return composeRecoveryContinuation(
    preparedInput,
    {
      sourceRequestId: requestId,
      sourceInputId: inputId,
      sourceAppliedInputIds: appliedInputIds,
      sourceLastTurn,
      boundary: sourceLastTurn === 0 ? 'before_first_turn' : 'between_turns',
    },
    [
      'Pre-turn side effects were explicitly reconciled. '
        + (
          sourceLastTurn === 0
            ? 'No primary model turn started before the restart. '
            : `No model turn started after completed turn ${sourceLastTurn}. `
        )
        + 'Execute this prepared input once.',
    ],
  );
}

function requestOutcomeEvent(
  command: DurableRequestOutcomeReconciliationCommand,
): DurableCommandEventDraft {
  switch (command.outcome.status) {
    case 'completed':
      return {
        type: DurableEventType.REQUEST_COMPLETED,
        requestId: command.requestId,
        causationEventId: command.lastTurnEventId,
        data: {
          ...(command.outcome.output !== undefined ? { output: command.outcome.output } : {}),
          ...(command.outcome.usage ? { usage: command.outcome.usage } : {}),
        },
      };
    case 'failed':
      return {
        type: DurableEventType.REQUEST_FAILED,
        requestId: command.requestId,
        causationEventId: command.lastTurnEventId,
        data: {
          error: command.outcome.error,
        },
      };
    case 'interrupted':
      return {
        type: DurableEventType.REQUEST_INTERRUPTED,
        requestId: command.requestId,
        causationEventId: command.lastTurnEventId,
        data: {
          reason: 'process_restart',
        },
      };
  }
}

function modelOutcomeEvent(
  command: DurableModelOutcomeReconciliationCommand,
): DurableCommandEventDraft {
  const correlation = {
    requestId: command.requestId,
    turnId: command.turnId,
    modelAttemptId: command.modelAttemptId,
  };
  switch (command.outcome.status) {
    case 'completed':
      return {
        type: DurableEventType.MODEL_REQUEST_COMPLETED,
        ...correlation,
        data: {
          response: command.outcome.response,
        },
      };
    case 'failed':
      return {
        type: DurableEventType.MODEL_REQUEST_FAILED,
        ...correlation,
        data: {
          error: command.outcome.error,
        },
      };
    case 'aborted':
      return {
        type: DurableEventType.MODEL_REQUEST_ABORTED,
        ...correlation,
        data: {
          reason: 'process_restart',
        },
      };
  }
}

/**
 * Coordinates explicit recovery mutations against one durable Session journal.
 *
 * Recovery never guesses the outcome of a started model request or tool.
 * Callers must supply a stable command ID so retries remain idempotent across
 * process restarts.
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
   * Atomically replaces a Request interrupted during preparation before its
   * next Turn with a provenance-linked continuation Request.
   */
  async prepareRequestRecovery(
    command: DurableRequestRolloverCommand,
  ): Promise<DurableRequestRolloverResult> {
    const preparedInput = parseReconciledRequestPreparation(command);
    await this.journal.refresh();
    const existing = this.journal.getCommandEvents(command.commandId);
    if (existing) {
      const persisted = validatePersistedRequestRollover(existing, command, preparedInput);
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
    if (
      (
        recoveryPlan.action !== 'rollover_request'
        && recoveryPlan.action !== 'reconcile_request_inputs'
      )
      || !request
      || (request.status !== 'running' && request.status !== 'accepted')
      || request.activeTurn
    ) {
      throw new DurableSessionRecoveryError(
        'DURABLE_RECOVERY_INVALID_STATE',
        `Request recovery requires rollover_request or reconcile_request_inputs, found ${recoveryPlan.action}`,
      );
    }
    if (request.requestId !== command.requestId || request.inputId !== command.inputId) {
      throw new DurableSessionRecoveryError(
        'DURABLE_RECOVERY_TARGET_NOT_FOUND',
        `No Request awaiting preparation recovery matches ${command.requestId}/${command.inputId}`,
      );
    }
    if (request.lastTurn !== command.sourceLastTurn) {
      throw new DurableSessionRecoveryError(
        'DURABLE_RECOVERY_TARGET_NOT_FOUND',
        `Request ${request.requestId} last Turn does not match ${command.sourceLastTurn}`,
      );
    }
    const appliedInputIds = request.appliedInputIds ?? [];
    if (!inputIdsEqual(appliedInputIds, command.preparation.appliedInputIds)) {
      throw new DurableSessionRecoveryError(
        'DURABLE_RECOVERY_INVALID_STATE',
        `Request ${request.requestId} applied-input reconciliation does not match durable state`,
      );
    }
    if (
      request.maxTurns === undefined
      || request.model === undefined
      || request.context === undefined
    ) {
      throw new DurableSessionRecoveryError(
        'DURABLE_RECOVERY_INVALID_STATE',
        `Request ${request.requestId} has no complete execution snapshot`,
      );
    }

    const continuation = buildRequestRecoveryContinuation(
      preparedInput,
      request.requestId,
      request.inputId,
      appliedInputIds,
      request.lastTurn,
    );
    const commit = await this.commitRecovery(
      {
        commandId: command.commandId,
        events: [
          ...(request.status === 'accepted'
            ? [
                {
                  type: DurableEventType.REQUEST_STARTED,
                  requestId: request.requestId,
                  data: {},
                } as const,
              ]
            : []),
          {
            type: DurableEventType.TURN_STARTED,
            requestId: request.requestId,
            turnId: command.recoveryTurnId,
            data: {
              turn: request.lastTurn + 1,
              model: request.model,
            },
          },
          {
            type: DurableEventType.TURN_ABORTED,
            requestId: request.requestId,
            turnId: command.recoveryTurnId,
            data: {
              turn: request.lastTurn + 1,
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
                turnId: command.recoveryTurnId,
                turn: request.lastTurn + 1,
              },
            },
          },
        ],
      },
      projection.headSequence,
    );
    return {
      ...this.result(commit),
      continuation,
      interruptedRequestId: request.requestId,
      recoveryRequestId: command.recoveryRequestId,
    };
  }

  /**
   * Records the externally reconciled terminal outcome of a Request whose
   * final Turn ended before the Request terminal event was persisted.
   */
  async reconcileRequestOutcome(
    command: DurableRequestOutcomeReconciliationCommand,
  ): Promise<DurableRecoveryCommitResult> {
    await this.journal.refresh();
    const event = requestOutcomeEvent(command);
    if (this.journal.getCommandEvents(command.commandId)) {
      return this.result(await this.commitRecovery({
        commandId: command.commandId,
        events: [event],
      }));
    }

    const projection = this.getProjection();
    const recoveryPlan = this.getRecoveryPlan();
    const request = projection.activeRequest;
    if (
      recoveryPlan.action !== 'reconcile_request_outcome'
      || !request
      || request.status !== 'running'
      || request.activeTurn
      || request.lastTurn === 0
      || request.lastTurnEventId === null
    ) {
      throw new DurableSessionRecoveryError(
        'DURABLE_RECOVERY_INVALID_STATE',
        `Request outcome reconciliation requires reconcile_request_outcome, found ${recoveryPlan.action}`,
      );
    }
    if (request.requestId !== command.requestId) {
      throw new DurableSessionRecoveryError(
        'DURABLE_RECOVERY_TARGET_NOT_FOUND',
        `No terminal-pending Request matches ${command.requestId}`,
      );
    }
    if (request.lastTurnEventId !== command.lastTurnEventId) {
      throw new DurableSessionRecoveryError(
        'DURABLE_RECOVERY_TARGET_NOT_FOUND',
        `Request ${request.requestId} last Turn event does not match ${command.lastTurnEventId}`,
      );
    }

    const commit = await this.commitRecovery(
      {
        commandId: command.commandId,
        events: [event],
      },
      projection.headSequence,
    );
    return this.result(commit);
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

  /**
   * Records the externally reconciled outcome of a model request that may
   * have completed before the process stopped.
   */
  async reconcileModelOutcome(
    command: DurableModelOutcomeReconciliationCommand,
  ): Promise<DurableRecoveryCommitResult> {
    await this.journal.refresh();
    const event = modelOutcomeEvent(command);
    if (this.journal.getCommandEvents(command.commandId)) {
      return this.result(await this.commitRecovery({
        commandId: command.commandId,
        events: [event],
      }));
    }

    const expectedHeadSequence = this.getProjection().headSequence;
    const recoveryPlan = this.getRecoveryPlan();
    const { request, turn, attempt } = this.findModelAttempt(command.modelAttemptId);
    if (recoveryPlan.action !== 'reconcile_model_outcome') {
      throw new DurableSessionRecoveryError(
        'DURABLE_RECOVERY_INVALID_STATE',
        `Model outcome reconciliation requires reconcile_model_outcome, found ${recoveryPlan.action}`,
      );
    }
    if (
      request.requestId !== command.requestId
      || turn.turnId !== command.turnId
      || attempt.modelAttemptId !== command.modelAttemptId
      || attempt.status !== 'started'
    ) {
      throw new DurableSessionRecoveryError(
        'DURABLE_RECOVERY_TARGET_NOT_FOUND',
        `No active model attempt matches ${command.requestId}/${command.turnId}/${command.modelAttemptId}`,
      );
    }

    const commit = await this.commitRecovery({
      commandId: command.commandId,
      events: [event],
    }, expectedHeadSequence);
    return this.result(commit);
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

  private findModelAttempt(modelAttemptId: ModelAttemptId): {
    request: DurableRequestProjection;
    turn: NonNullable<DurableRequestProjection['activeTurn']>;
    attempt: DurableModelAttemptProjection;
  } {
    const request = this.getProjection().activeRequest;
    const turn = request?.activeTurn;
    const attempt = turn?.modelAttempts.find(
      (candidate) => candidate.modelAttemptId === modelAttemptId,
    );
    if (!request || !turn || !attempt) {
      throw new DurableSessionRecoveryError(
        'DURABLE_RECOVERY_TARGET_NOT_FOUND',
        `No model attempt matches ${modelAttemptId}`,
      );
    }
    return { request, turn, attempt };
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
