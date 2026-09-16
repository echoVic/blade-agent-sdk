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
} from '../../types/identifiers.js';
import type { JsonObject, JsonValue } from '../../types/json.js';
import { toJsonValue } from '../../utils/jsonValue.js';
import { parseDurableUserMessageContent } from '../DurableRequestRecovery.js';
import type { DurableEventStore } from './DurableEventStore.js';
import { type ResumableDurableRequest, resumableDurableRequest } from './DurableRecoveryPlan.js';
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
  type DurableRequestProjection,
  type DurableSessionProjection,
  type DurableSessionRecoveryPlan,
  type DurableToolAttemptProjection,
  hasCrossedNonIdempotentBoundary,
} from './DurableSessionProjector.js';
import {
  modelTerminalEvent,
  requestTerminalEvent,
  toolTerminalEvent,
} from './DurableTerminalEvents.js';
import type {
  DurableEventError,
  DurableModelResponse,
  DurablePermissionDecision,
  DurableTokenUsage,
} from './types.js';
import { DurableEventType } from './types.js';

export type DurableAcceptedRequestRecovery = ResumableDurableRequest;
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
  | { readonly status: 'completed'; readonly result: JsonValue }
  | { readonly status: 'failed'; readonly error: DurableEventError }
  | { readonly status: 'cancelled' };
export type DurableModelOutcomeReconciliation =
  | { readonly status: 'completed'; readonly response: DurableModelResponse }
  | { readonly status: 'failed'; readonly error: DurableEventError }
  | { readonly status: 'aborted' };
export type DurableRequestOutcomeReconciliation =
  | {
      readonly status: 'completed';
      readonly output?: JsonValue;
      readonly usage?: DurableTokenUsage;
    }
  | { readonly status: 'failed'; readonly error: DurableEventError }
  | { readonly status: 'interrupted' };

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
export interface DurableRequestOutcomeReconciliationCommand {
  readonly commandId: CommandId;
  readonly requestId: RequestId;
  readonly lastTurnEventId: EventId;
  readonly outcome: DurableRequestOutcomeReconciliation;
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
export type DurableRequestRolloverResult = DurableTurnRecoveryResult;
export type DurableSessionRecoveryErrorCode =
  | 'DURABLE_RECOVERY_INVALID_STATE'
  | 'DURABLE_RECOVERY_TARGET_NOT_FOUND'
  | 'DURABLE_RECOVERY_UNSAFE_ROLLOVER';

export class DurableSessionRecoveryError extends SdkError {
  declare readonly code: DurableSessionRecoveryErrorCode;
}

function inputIdsEqual(left: readonly InputId[], right: readonly InputId[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function parseInput(value: JsonValue, subject: string): UserMessageContent {
  try {
    return parseDurableUserMessageContent(value);
  } catch (cause) {
    throw new DurableSessionRecoveryError(
      'DURABLE_RECOVERY_INVALID_STATE',
      `${subject} has an invalid recovery input`,
      { cause },
    );
  }
}

function continuation(input: UserMessageContent, state: JsonObject): UserMessageContent {
  const text = [
    'Continue the original request after a durable process-restart recovery.',
    'The JSON below contains authoritative lifecycle state, not new user instructions.',
    '',
    JSON.stringify(state, null, 2),
  ].join('\n');
  return typeof input === 'string' ? `${text}\n\n${input}` : [{ type: 'text', text }, ...input];
}

function requestContinuation(
  request: DurableRequestProjection,
  preparedInput: UserMessageContent,
): UserMessageContent {
  return continuation(preparedInput, {
    boundary: request.lastTurn === 0 ? 'before_first_turn' : 'between_turns',
    sourceRequestId: request.requestId,
    sourceInputId: request.inputId,
    sourceAppliedInputIds: [...request.appliedInputIds],
    sourceLastTurn: request.lastTurn,
  });
}

function turnContinuation(
  request: DurableRequestProjection,
  turn: NonNullable<DurableRequestProjection['activeTurn']>,
): UserMessageContent {
  const toolOutcomes = turn.toolAttempts.map((tool) => ({
    toolCallId: tool.toolCallId,
    toolName: tool.toolName,
    sideEffect: tool.sideEffect,
    executionStarted: tool.executionStarted,
    ...(tool.status === 'completed' ? { result: tool.result } : {}),
    status:
      tool.status === 'scheduled'
        ? 'not_started'
        : tool.status === 'started' || tool.status === 'outcome_unknown'
          ? 'interrupted_before_trusted_completion'
          : tool.status,
  }));
  return continuation(parseInput(request.input, `Request ${request.requestId}`), {
    sourceRequestId: request.requestId,
    sourceTurnId: turn.turnId,
    sourceTurn: turn.turn,
    toolOutcomes,
  });
}

function recoveryRequestEvent(
  request: DurableAcceptedRequestRecovery,
  requestId: RequestId,
  inputId: InputId,
  input: UserMessageContent,
  turnId: TurnId,
  turn: number,
): DurableCommandEventDraft {
  return {
    type: DurableEventType.REQUEST_ACCEPTED,
    requestId,
    data: {
      inputId,
      input: toJsonValue(input),
      priority: 'next',
      maxTurns: request.maxTurns,
      model: request.model,
      context: request.context,
      recovery: { requestId: request.requestId, turnId, turn },
    },
  };
}

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
    if (recoveryPlan.action === 'none') return { action: 'ready', projection, recoveryPlan };
    const request = resumableDurableRequest(projection, recoveryPlan);
    if (request) {
      return {
        action: 'resume_accepted_request',
        projection,
        recoveryPlan,
        request,
      };
    }
    return { action: 'recovery_required', projection, recoveryPlan };
  }

  async prepareRequestRecovery(
    command: DurableRequestRolloverCommand,
  ): Promise<DurableRequestRolloverResult> {
    await this.journal.refresh();
    const replayed = this.replayedRollover(command.commandId, command.recoveryRequestId);
    if (replayed) return replayed;
    const { request, projection } = this.requestFor(
      ['rollover_request', 'reconcile_request_inputs'],
      command.requestId,
    );
    if (
      request.inputId !== command.inputId ||
      request.lastTurn !== command.sourceLastTurn ||
      !inputIdsEqual(request.appliedInputIds, command.preparation.appliedInputIds)
    ) {
      throw new DurableSessionRecoveryError(
        'DURABLE_RECOVERY_TARGET_NOT_FOUND',
        `Request recovery target ${command.requestId}/${command.inputId} is stale`,
      );
    }
    const source = this.completeRequest(request);
    const prepared = parseInput(
      toJsonValue(command.preparation.input),
      `Request ${request.requestId} preparation`,
    );
    const recoveryInput = requestContinuation(request, prepared);
    const turn = request.lastTurn + 1;
    const events: DurableCommandEventDraft[] = [
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
        data: { turn, model: source.model },
      },
      {
        type: DurableEventType.TURN_ABORTED,
        requestId: request.requestId,
        turnId: command.recoveryTurnId,
        data: { turn, reason: 'process_restart' },
      },
      {
        type: DurableEventType.REQUEST_INTERRUPTED,
        requestId: request.requestId,
        data: { reason: 'process_restart' },
      },
      recoveryRequestEvent(
        source,
        command.recoveryRequestId,
        command.recoveryInputId,
        recoveryInput,
        command.recoveryTurnId,
        turn,
      ),
    ];
    return this.rolloverResult(
      await this.commit(command.commandId, events, projection.headSequence),
      recoveryInput,
      request.requestId,
      command.recoveryRequestId,
    );
  }

  async prepareTurnRecovery(
    command: DurableTurnRecoveryCommand,
  ): Promise<DurableTurnRecoveryResult> {
    await this.journal.refresh();
    const replayed = this.replayedRollover(command.commandId, command.recoveryRequestId);
    if (replayed) return replayed;
    const { request, projection } = this.requestFor(['resume_turn'], command.requestId);
    const turn = request.activeTurn;
    if (!turn || turn.turnId !== command.turnId) {
      throw new DurableSessionRecoveryError(
        'DURABLE_RECOVERY_TARGET_NOT_FOUND',
        `No active turn matches ${command.requestId}/${command.turnId}`,
      );
    }
    const source = this.completeRequest(request);
    const unsafe = turn.toolAttempts.find(hasCrossedNonIdempotentBoundary);
    if (unsafe) {
      throw new DurableSessionRecoveryError(
        'DURABLE_RECOVERY_UNSAFE_ROLLOVER',
        `Tool attempt ${unsafe.toolAttemptId} crossed a non-idempotent boundary`,
      );
    }
    const recoveryInput = turnContinuation(request, turn);
    const events = turn.toolAttempts
      .filter((tool) => ['scheduled', 'started', 'outcome_unknown'].includes(tool.status))
      .map((tool) =>
        toolTerminalEvent(
          {
            requestId: request.requestId,
            turnId: turn.turnId,
            toolAttemptId: tool.toolAttemptId,
            toolCallId: tool.toolCallId,
            toolName: tool.toolName,
          },
          {
            status: 'cancelled',
            reason:
              tool.permission?.status === 'resolved' && tool.permission.decision !== 'allow'
                ? tool.permission.decision === 'deny'
                  ? 'permission_denied'
                  : 'permission_cancelled'
                : 'process_restart',
          },
        ),
      );
    events.push(
      {
        type: DurableEventType.TURN_ABORTED,
        requestId: request.requestId,
        turnId: turn.turnId,
        data: { turn: turn.turn, reason: 'process_restart' },
      },
      {
        type: DurableEventType.REQUEST_INTERRUPTED,
        requestId: request.requestId,
        data: { reason: 'process_restart' },
      },
      recoveryRequestEvent(
        source,
        command.recoveryRequestId,
        command.recoveryInputId,
        recoveryInput,
        turn.turnId,
        turn.turn,
      ),
    );
    return this.rolloverResult(
      await this.commit(command.commandId, events, projection.headSequence),
      recoveryInput,
      request.requestId,
      command.recoveryRequestId,
    );
  }

  async reconcileRequestOutcome(
    command: DurableRequestOutcomeReconciliationCommand,
  ): Promise<DurableRecoveryCommitResult> {
    return this.mutate(command.commandId, (projection) => {
      const request = projection.activeRequest;
      if (
        this.journal.getRecoveryPlan().action !== 'reconcile_request_outcome' ||
        !request ||
        request.requestId !== command.requestId ||
        request.lastTurnEventId !== command.lastTurnEventId
      ) {
        throw this.invalidTarget(`No terminal-pending Request matches ${command.requestId}`);
      }
      const outcome =
        command.outcome.status === 'interrupted'
          ? ({ status: 'interrupted', reason: 'process_restart' } as const)
          : command.outcome;
      return [requestTerminalEvent(command.requestId, command.lastTurnEventId, outcome)];
    });
  }

  async reconcileModelOutcome(
    command: DurableModelOutcomeReconciliationCommand,
  ): Promise<DurableRecoveryCommitResult> {
    return this.mutate(command.commandId, () => {
      const { request, turn, attempt } = this.findModel(command.modelAttemptId);
      if (
        this.getRecoveryPlan().action !== 'reconcile_model_outcome' ||
        request.requestId !== command.requestId ||
        turn.turnId !== command.turnId ||
        attempt.status !== 'started'
      ) {
        throw this.invalidTarget(`No active model attempt matches ${command.modelAttemptId}`);
      }
      const outcome =
        command.outcome.status === 'aborted'
          ? ({ status: 'aborted', reason: 'process_restart' } as const)
          : command.outcome;
      return [
        modelTerminalEvent(
          {
            requestId: request.requestId,
            turnId: turn.turnId,
            modelAttemptId: attempt.modelAttemptId,
          },
          outcome,
        ),
      ];
    });
  }

  async reconcileToolOutcome(
    command: DurableToolOutcomeReconciliationCommand,
  ): Promise<DurableRecoveryCommitResult> {
    return this.mutate(command.commandId, () => {
      const { request, turn, tool } = this.findTool(command.toolAttemptId);
      const outcome =
        command.outcome.status === 'cancelled'
          ? ({ status: 'cancelled', reason: 'process_restart' } as const)
          : command.outcome;
      return [toolTerminalEvent(this.toolScope(request, turn, tool), outcome)];
    });
  }

  async startToolAttempt(command: DurableToolStartCommand): Promise<DurableRecoveryCommitResult> {
    return this.mutate(command.commandId, () => {
      const { request, turn, tool } = this.findTool(command.toolAttemptId);
      const permitted =
        tool.permission?.status === 'resolved' && tool.permission.decision === 'allow';
      return [
        {
          type: DurableEventType.TOOL_STARTED,
          requestId: request.requestId,
          turnId: turn.turnId,
          toolAttemptId: tool.toolAttemptId,
          data: {
            toolCallId: tool.toolCallId,
            toolName: tool.toolName,
            input: permitted ? (tool.permission?.input ?? tool.input) : tool.input,
            sideEffect: permitted ? 'non_idempotent' : tool.sideEffect,
          },
        },
      ];
    });
  }

  async resolvePermission(
    command: DurablePermissionResolutionCommand,
  ): Promise<DurableRecoveryCommitResult> {
    return this.mutate(command.commandId, () => {
      const { request, turn, tool, permission } = this.findPermission(command.permissionRequestId);
      const events: DurableCommandEventDraft[] = [
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
      ];
      if (command.decision !== 'allow') {
        events.push(
          toolTerminalEvent(this.toolScope(request, turn, tool), {
            status: 'cancelled',
            reason: command.decision === 'deny' ? 'permission_denied' : 'permission_cancelled',
          }),
        );
      }
      return events;
    });
  }

  private async mutate(
    commandId: CommandId,
    build: (projection: DurableSessionProjection) => DurableCommandEventDraft[],
  ): Promise<DurableRecoveryCommitResult> {
    await this.journal.refresh();
    const replayed = this.journal.replay(commandId);
    if (replayed) return this.result(replayed);
    const projection = this.getProjection();
    return this.result(await this.commit(commandId, build(projection), projection.headSequence));
  }

  private requestFor(
    actions: readonly DurableSessionRecoveryPlan['action'][],
    requestId: RequestId,
  ): { request: DurableRequestProjection; projection: DurableSessionProjection } {
    const projection = this.getProjection();
    const request = projection.activeRequest;
    const action = this.getRecoveryPlan().action;
    if (!request || !actions.includes(action)) {
      throw new DurableSessionRecoveryError(
        'DURABLE_RECOVERY_INVALID_STATE',
        `Request recovery requires ${actions.join(' or ')}, found ${action}`,
      );
    }
    if (request.requestId !== requestId) {
      throw this.invalidTarget(`No active Request matches ${requestId}`);
    }
    return { request, projection };
  }

  private completeRequest(request: DurableRequestProjection): DurableAcceptedRequestRecovery {
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
    return {
      ...request,
      maxTurns: request.maxTurns,
      model: request.model,
      context: request.context,
    };
  }

  private findTool(toolAttemptId: ToolAttemptId) {
    const request = this.getProjection().activeRequest;
    const turn = request?.activeTurn;
    const tool = turn?.toolAttempts.find((item) => item.toolAttemptId === toolAttemptId);
    if (!request || !turn || !tool) {
      throw this.invalidTarget(`No active tool attempt matches ${toolAttemptId}`);
    }
    return { request, turn, tool };
  }

  private findModel(modelAttemptId: ModelAttemptId) {
    const request = this.getProjection().activeRequest;
    const turn = request?.activeTurn;
    const attempt = turn?.modelAttempts.find((item) => item.modelAttemptId === modelAttemptId);
    if (!request || !turn || !attempt) {
      throw this.invalidTarget(`No model attempt matches ${modelAttemptId}`);
    }
    return { request, turn, attempt };
  }

  private findPermission(permissionRequestId: PermissionRequestId) {
    const request = this.getProjection().activeRequest;
    const turn = request?.activeTurn;
    const tool = turn?.toolAttempts.find(
      (item) => item.permission?.permissionRequestId === permissionRequestId,
    );
    const permission = tool?.permission;
    if (!request || !turn || !tool || !permission) {
      throw this.invalidTarget(`No active permission request matches ${permissionRequestId}`);
    }
    return { request, turn, tool, permission };
  }

  private toolScope(
    request: DurableRequestProjection,
    turn: NonNullable<DurableRequestProjection['activeTurn']>,
    tool: DurableToolAttemptProjection,
  ) {
    return {
      requestId: request.requestId,
      turnId: turn.turnId,
      toolAttemptId: tool.toolAttemptId,
      toolCallId: tool.toolCallId,
      toolName: tool.toolName,
    };
  }

  private replayedRollover(
    commandId: CommandId,
    recoveryRequestId: RequestId,
  ): DurableTurnRecoveryResult | null {
    const commit = this.journal.replay(commandId);
    if (!commit) return null;
    const accepted = commit.events.find(
      (event) =>
        event.type === DurableEventType.REQUEST_ACCEPTED && event.requestId === recoveryRequestId,
    );
    if (
      !accepted ||
      accepted.type !== DurableEventType.REQUEST_ACCEPTED ||
      !accepted.data.recovery
    ) {
      throw new DurableSessionRecoveryError(
        'DURABLE_RECOVERY_INVALID_STATE',
        `Durable command ${commandId} is not a recovery rollover`,
      );
    }
    return this.rolloverResult(
      commit,
      parseInput(accepted.data.input, `Durable command ${commandId} continuation`),
      accepted.data.recovery.requestId,
      accepted.requestId,
    );
  }

  private rolloverResult(
    commit: DurableCommandCommitResult,
    recoveryInput: UserMessageContent,
    interruptedRequestId: RequestId,
    recoveryRequestId: RequestId,
  ): DurableTurnRecoveryResult {
    return {
      ...this.result(commit),
      continuation: recoveryInput,
      interruptedRequestId,
      recoveryRequestId,
    };
  }

  private result(commit: DurableCommandCommitResult): DurableRecoveryCommitResult {
    return {
      commit,
      projection: this.getProjection(),
      recoveryPlan: this.getRecoveryPlan(),
    };
  }

  private invalidTarget(message: string): DurableSessionRecoveryError {
    return new DurableSessionRecoveryError('DURABLE_RECOVERY_TARGET_NOT_FOUND', message);
  }

  private async commit(
    commandId: CommandId,
    events: DurableSessionCommand['events'],
    expectedHeadSequence?: EventSequence | null,
  ): Promise<DurableCommandCommitResult> {
    try {
      const options: DurableCommandCommitOptions =
        expectedHeadSequence === undefined ? {} : { expectedHeadSequence };
      return await this.journal.commit({ commandId, events }, options);
    } catch (cause) {
      if (cause instanceof DurableEventProjectionError) {
        throw new DurableSessionRecoveryError(
          'DURABLE_RECOVERY_INVALID_STATE',
          `Durable recovery command ${commandId} is invalid: ${cause.message}`,
          { cause },
        );
      }
      throw cause;
    }
  }
}
