import { nanoid } from 'nanoid';
import type { AgentEvent, TokenUsageInfo } from '../../agent/AgentEvent.js';
import type {
  ModelExecutionLifecycle,
  ModelRequestAbortReason,
  ModelRequestLifecycle,
} from '../../agent/ModelExecutionLifecycle.js';
import type {
  InputApplicationLifecycle,
  LoopResult,
  UserMessageContent,
} from '../../agent/types.js';
import { SdkError } from '../../errors/SdkError.js';
import type {
  ToolExecutionLifecycle,
  ToolExecutionStartedLifecycle,
  ToolInvocationLifecycle,
  ToolPermissionResolution,
  ToolScheduledLifecycle,
  ToolSettledLifecycle,
} from '../../tools/types/ExecutionTypes.js';
import { ToolErrorType } from '../../tools/types/ToolResult.js';
import {
  CommandId,
  type EventId,
  type InputId,
  ModelAttemptId,
  PermissionRequestId,
  type RequestId,
  ToolAttemptId,
  ToolUseId,
  TurnId,
} from '../../types/branded.js';
import type { JsonObject, JsonValue } from '../../types/common.js';
import { toJsonValue } from '../../utils/jsonValue.js';
import type {
  DurableCommandCommitOptions,
  DurableCommandCommitResult,
  DurableSessionJournal,
} from './DurableSessionJournal.js';
import type { DurableSessionRecoveryPlan } from './DurableSessionProjector.js';
import {
  type DurableEventError,
  DurableEventType,
  type DurableModelResponse,
  type DurableRequestInterruptReason,
  type DurableToolCancelReason,
} from './types.js';

type ActiveToolStatus = 'scheduled' | 'started' | 'settled';

interface ActiveTool {
  toolAttemptId: ToolAttemptId;
  toolCallId: ToolUseId;
  toolName: string;
  status: ActiveToolStatus;
  permissionRequestId?: PermissionRequestId;
  permissionDecision?: ToolPermissionResolution['decision'];
}

interface ActiveTurn {
  turnId: TurnId;
  turn: number;
  modelAttemptId: ModelAttemptId | null;
  tools: Map<ToolUseId, ActiveTool>;
}

interface ActiveModelAttempt {
  modelAttemptId: ModelAttemptId;
  turnId: TurnId;
}

function toDurableEventError(error: unknown, fallbackMessage: string): DurableEventError {
  const record =
    typeof error === 'object' && error !== null
      ? error as Record<string, unknown>
      : undefined;
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof record?.message === 'string'
        ? record.message
        : String(error);
  return {
    message: rawMessage.trim() === '' ? fallbackMessage : rawMessage,
    ...(typeof record?.code === 'string' && record.code.trim() !== ''
      ? { code: record.code }
      : {}),
    ...(typeof record?.retryable === 'boolean'
      ? { retryable: record.retryable }
      : {}),
  };
}

export type DurableRequestFinish =
  | {
      status: 'completed';
      output?: JsonValue;
      usage?: TokenUsageInfo;
    }
  | {
      status: 'failed';
      error: unknown;
    }
  | {
      status: 'interrupted';
      reason: DurableRequestInterruptReason;
      byInputId?: InputId;
    };

export class SessionDurableRecorderError extends SdkError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('DURABLE_SESSION_RECORDER_INVALID_STATE', message, options);
  }
}

export class DurableSessionRecoveryRequiredError extends SdkError {
  readonly recoveryPlan: DurableSessionRecoveryPlan;

  constructor(recoveryPlan: DurableSessionRecoveryPlan) {
    super(
      'DURABLE_SESSION_RECOVERY_REQUIRED',
      `Session recovery requires action: ${recoveryPlan.action}`,
    );
    this.recoveryPlan = structuredClone(recoveryPlan);
  }
}

export class SessionDurableRecorder implements
  ToolExecutionLifecycle,
  InputApplicationLifecycle,
  ModelExecutionLifecycle
{
  private activeTurn: ActiveTurn | null = null;
  private activeModelAttempt: ActiveModelAttempt | null = null;
  private readonly persistedInputApplications = new Map<InputId, 'now' | 'next'>();
  private lastBoundaryEventId: EventId | null = null;
  private boundaryFailed = false;
  private boundaryFailure: unknown;
  private ignoredTurnEnd: number | null = null;
  private requestStarted = false;
  private requestFinished = false;

  constructor(
    private readonly journal: DurableSessionJournal,
    readonly requestId: RequestId,
    private readonly model: string,
  ) {
    const projection = journal.getProjection();
    const request = projection.activeRequest;
    if (request?.requestId === requestId && request.activeTurn === null) {
      this.lastBoundaryEventId = projection.lastEventId;
      this.requestStarted = request.status === 'running';
    }
  }

  async recordAccepted(
    inputId: InputId,
    input: UserMessageContent,
    priority: 'next' | 'later' = 'next',
    execution: {
      readonly maxTurns?: number;
      readonly context?: JsonObject;
    } = {},
  ): Promise<void> {
    await this.commitRequestBoundary([
      {
        type: DurableEventType.REQUEST_ACCEPTED,
        requestId: this.requestId,
        data: {
          inputId,
          input: toJsonValue(input),
          priority,
          ...(execution.maxTurns !== undefined ? { maxTurns: execution.maxTurns } : {}),
          model: this.model,
          ...(execution.context ? { context: execution.context } : {}),
        },
      },
    ]);
  }

  async recordStarted(inputId: InputId, priority: 'next' | 'later' = 'next'): Promise<void> {
    this.assertRequestOpen();
    if (this.requestStarted) {
      throw new SessionDurableRecorderError(`Request ${this.requestId} was already started`);
    }
    await this.commitRequestBoundary([
      {
        type: DurableEventType.INPUT_APPLIED,
        requestId: this.requestId,
        data: {
          inputId,
          priority: priority === 'later' ? 'next' : priority,
        },
      },
      {
        type: DurableEventType.REQUEST_STARTED,
        requestId: this.requestId,
        data: {},
      },
    ]);
    this.requestStarted = true;
  }

  async onInputApplying(
    input: { readonly inputId: InputId; readonly priority: 'now' | 'next' },
  ): Promise<void> {
    this.assertRequestOpen();
    if (!this.requestStarted) {
      throw new SessionDurableRecorderError(`Request ${this.requestId} has not started`);
    }
    if (this.activeTurn) {
      throw new SessionDurableRecorderError(
        `Input ${input.inputId} cannot be prepared while turn ${this.activeTurn.turnId} is active`,
      );
    }
    const existingPriority = this.persistedInputApplications.get(input.inputId);
    if (existingPriority) {
      if (existingPriority !== input.priority) {
        throw new SessionDurableRecorderError(
          `Input ${input.inputId} changed priority during durable application`,
        );
      }
      return;
    }

    await this.commitRequestBoundary([
      {
        type: DurableEventType.INPUT_APPLIED,
        requestId: this.requestId,
        data: {
          inputId: input.inputId,
          priority: input.priority,
        },
      },
    ]);
    this.persistedInputApplications.set(input.inputId, input.priority);
  }

  async recordAgentEvent(event: AgentEvent): Promise<void> {
    this.assertRequestOpen();
    switch (event.type) {
      case 'turn_start':
        await this.startTurn(event.turn);
        return;
      case 'turn_end':
        if (this.ignoredTurnEnd === event.turn) {
          this.ignoredTurnEnd = null;
          return;
        }
        await this.completeTurn(event.turn, event.hasToolCalls);
        return;
      case 'turn_interrupted':
        if (!await this.abortTurn(event.turn, 'request_interrupted')) {
          throw new SessionDurableRecorderError(
            `Turn ${this.activeTurn?.turnId ?? event.turn} has a tool outcome that requires reconciliation`,
          );
        }
        this.ignoredTurnEnd = event.turn;
        return;
      case 'input_applied':
        {
          const persistedPriority = this.persistedInputApplications.get(event.inputId);
          if (!persistedPriority) {
            throw new SessionDurableRecorderError(
              `Input ${event.inputId} was not persisted before preparation`,
            );
          }
          if (persistedPriority !== event.priority) {
            throw new SessionDurableRecorderError(
              `Input ${event.inputId} changed priority after durable application`,
            );
          }
          this.persistedInputApplications.delete(event.inputId);
          return;
        }
      default:
        return;
    }
  }

  async onModelRequestStarting(input: {
    readonly turn: number;
    readonly model: string;
    readonly streaming: boolean;
  }): Promise<ModelRequestLifecycle> {
    const turn = this.requireTurnNumber(input.turn);
    if (this.activeModelAttempt) {
      throw new SessionDurableRecorderError(
        `Model attempt ${this.activeModelAttempt.modelAttemptId} is still active`,
      );
    }
    const attempt: ActiveModelAttempt = {
      modelAttemptId: ModelAttemptId(nanoid()),
      turnId: turn.turnId,
    };
    this.activeModelAttempt = attempt;
    try {
      await this.commitRequestBoundary([
        {
          type: DurableEventType.MODEL_REQUEST_STARTED,
          requestId: this.requestId,
          turnId: turn.turnId,
          modelAttemptId: attempt.modelAttemptId,
          data: {
            model: input.model,
            streaming: input.streaming,
          },
        },
      ]);
    } catch (error) {
      if (this.activeModelAttempt === attempt) {
        this.activeModelAttempt = null;
      }
      throw error;
    }
    turn.modelAttemptId = attempt.modelAttemptId;

    return {
      modelAttemptId: attempt.modelAttemptId,
      onCompleted: (response) => this.completeModelRequest(attempt, response),
      onFailed: (error) => this.failModelRequest(attempt, error),
      onAborted: (reason) => this.abortModelRequest(attempt, reason),
    };
  }

  async finish(finish: DurableRequestFinish): Promise<boolean> {
    this.assertRequestOpen();
    if (this.activeTurn) {
      if (finish.status === 'completed') {
        throw new SessionDurableRecorderError(
          `Request ${this.requestId} completed while turn ${this.activeTurn.turnId} was still active`,
        );
      }
      const reason = finish.status === 'interrupted' ? 'request_interrupted' : 'error';
      if (!(await this.abortTurn(this.activeTurn.turn, reason))) {
        return false;
      }
    }

    const causationEventId = this.requireLastBoundaryEventId();
    switch (finish.status) {
      case 'completed':
        await this.commitAtCurrentHead([
          {
            type: DurableEventType.REQUEST_COMPLETED,
            requestId: this.requestId,
            causationEventId,
            data: {
              ...(finish.output !== undefined ? { output: finish.output } : {}),
              ...(finish.usage
                ? {
                    usage: {
                      inputTokens: finish.usage.inputTokens,
                      outputTokens: finish.usage.outputTokens,
                      totalTokens: finish.usage.totalTokens,
                    },
                  }
                : {}),
            },
          },
        ]);
        break;
      case 'failed':
        await this.commitAtCurrentHead([
          {
            type: DurableEventType.REQUEST_FAILED,
            requestId: this.requestId,
            causationEventId,
            data: {
              error: toDurableEventError(finish.error, 'Request failed'),
            },
          },
        ]);
        break;
      case 'interrupted':
        await this.commitAtCurrentHead([
          {
            type: DurableEventType.REQUEST_INTERRUPTED,
            requestId: this.requestId,
            causationEventId,
            data: {
              reason: finish.reason,
              ...(finish.byInputId ? { byInputId: finish.byInputId } : {}),
            },
          },
        ]);
        break;
    }
    this.requestFinished = true;
    return true;
  }

  async onToolScheduled(event: ToolScheduledLifecycle): Promise<ToolInvocationLifecycle> {
    const turn = this.requireActiveTurn();
    if (!event.modelAttemptId || event.modelAttemptId !== turn.modelAttemptId) {
      throw new SessionDurableRecorderError(
        `Tool call ${event.toolCallId} does not belong to the current model attempt`,
      );
    }
    if (turn.tools.has(event.toolCallId)) {
      throw new SessionDurableRecorderError(
        `Tool call ${event.toolCallId} was already scheduled in turn ${turn.turnId}`,
      );
    }
    const tool: ActiveTool = {
      toolAttemptId: ToolAttemptId(nanoid()),
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      status: 'scheduled',
    };
    turn.tools.set(tool.toolCallId, tool);
    try {
      await this.commit([
        {
          type: DurableEventType.TOOL_SCHEDULED,
          requestId: this.requestId,
          turnId: turn.turnId,
          modelAttemptId: event.modelAttemptId,
          toolAttemptId: tool.toolAttemptId,
          data: {
            toolCallId: tool.toolCallId,
            toolName: tool.toolName,
            modelInput: event.modelInput,
            input: event.input,
            sideEffect: event.sideEffect,
            interruptBehavior: event.interruptBehavior,
          },
        },
      ]);
    } catch (error) {
      if (turn.tools.get(tool.toolCallId) === tool) {
        turn.tools.delete(tool.toolCallId);
      }
      throw error;
    }

    return {
      onPermissionRequested: (details, input) =>
        this.recordPermissionRequested(tool, details.message, input),
      onPermissionResolved: (resolution) => this.recordPermissionResolved(tool, resolution),
      onExecutionStarted: (event) => this.recordToolStarted(tool, event),
    };
  }

  async onToolSettled(event: ToolSettledLifecycle): Promise<void> {
    const turn = this.requireActiveTurn();
    const tool = turn.tools.get(event.toolCallId);
    if (!tool || tool.toolName !== event.toolName) {
      throw new SessionDurableRecorderError(
        `No scheduled tool matches ${event.toolName} (${event.toolCallId})`,
      );
    }
    if (tool.status === 'settled') {
      throw new SessionDurableRecorderError(`Tool call ${event.toolCallId} was already settled`);
    }

    if (event.result.status === 'success') {
      if (tool.status !== 'started') {
        throw new SessionDurableRecorderError(
          `Successful tool ${event.toolCallId} never crossed the execution boundary`,
        );
      }
      await this.commit([
        {
          type: DurableEventType.TOOL_COMPLETED,
          requestId: this.requestId,
          turnId: turn.turnId,
          toolAttemptId: tool.toolAttemptId,
          data: {
            toolCallId: tool.toolCallId,
            toolName: tool.toolName,
            result: event.result.model,
          },
        },
      ]);
    } else if (tool.permissionDecision === 'deny' || tool.permissionDecision === 'cancel') {
      await this.recordToolCancelled(
        tool,
        tool.permissionDecision === 'deny' ? 'permission_denied' : 'permission_cancelled',
      );
    } else if (event.result.error.type === ToolErrorType.INTERRUPTED) {
      await this.recordToolCancelled(tool, 'request_interrupted');
    } else {
      await this.commit([
        {
          type: DurableEventType.TOOL_FAILED,
          requestId: this.requestId,
          turnId: turn.turnId,
          toolAttemptId: tool.toolAttemptId,
          data: {
            toolCallId: tool.toolCallId,
            toolName: tool.toolName,
            error: {
              message: event.result.error.message,
              ...(event.result.error.code ? { code: event.result.error.code } : {}),
            },
          },
        },
      ]);
    }
    tool.status = 'settled';
  }

  private async startTurn(turn: number): Promise<void> {
    if (this.activeTurn) {
      throw new SessionDurableRecorderError(`Turn ${this.activeTurn.turnId} is still active`);
    }
    const activeTurn: ActiveTurn = {
      turnId: TurnId(nanoid()),
      turn,
      modelAttemptId: null,
      tools: new Map(),
    };
    await this.commitRequestBoundary([
      {
        type: DurableEventType.TURN_STARTED,
        requestId: this.requestId,
        turnId: activeTurn.turnId,
        data: {
          turn,
          model: this.model,
        },
      },
    ]);
    this.activeTurn = activeTurn;
  }

  private async completeTurn(turn: number, hasToolCalls: boolean): Promise<void> {
    const activeTurn = this.requireTurnNumber(turn);
    this.assertNoActiveModelAttempt(activeTurn);
    await this.commitRequestBoundary([
      {
        type: DurableEventType.TURN_COMPLETED,
        requestId: this.requestId,
        turnId: activeTurn.turnId,
        data: {
          turn,
          hasToolCalls,
        },
      },
    ]);
    this.activeTurn = null;
  }

  private async abortTurn(turn: number, reason: 'request_interrupted' | 'error'): Promise<boolean> {
    const activeTurn = this.requireTurnNumber(turn);
    this.assertNoActiveModelAttempt(activeTurn);
    const drafts = [];
    const cancelledPermissions: ActiveTool[] = [];
    const settledTools: ActiveTool[] = [];
    let hasUnknownOutcome = false;

    for (const tool of activeTurn.tools.values()) {
      if (tool.status === 'settled') {
        continue;
      }
      if (tool.status === 'started') {
        hasUnknownOutcome = true;
        continue;
      }
      if (tool.permissionRequestId && !tool.permissionDecision) {
        drafts.push({
          type: DurableEventType.PERMISSION_RESOLVED,
          requestId: this.requestId,
          turnId: activeTurn.turnId,
          toolAttemptId: tool.toolAttemptId,
          data: {
            permissionRequestId: tool.permissionRequestId,
            decision: 'cancel',
            message: 'Request ended before permission resolution',
          },
        } as const);
        cancelledPermissions.push(tool);
      }
      drafts.push({
        type: DurableEventType.TOOL_CANCELLED,
        requestId: this.requestId,
        turnId: activeTurn.turnId,
        toolAttemptId: tool.toolAttemptId,
        data: {
          toolCallId: tool.toolCallId,
          toolName: tool.toolName,
          reason: reason === 'request_interrupted' ? 'request_interrupted' : 'cascade_abort',
        },
      } as const);
      settledTools.push(tool);
    }

    if (drafts.length > 0) {
      await this.commitAtCurrentHead(drafts);
      for (const tool of cancelledPermissions) {
        tool.permissionDecision = 'cancel';
      }
      for (const tool of settledTools) {
        tool.status = 'settled';
      }
    }
    if (hasUnknownOutcome) {
      return false;
    }
    await this.commitRequestBoundary([
      {
        type: DurableEventType.TURN_ABORTED,
        requestId: this.requestId,
        turnId: activeTurn.turnId,
        data: {
          turn,
          reason,
        },
      },
    ]);
    this.activeTurn = null;
    return true;
  }

  private async completeModelRequest(
    attempt: ActiveModelAttempt,
    response: Parameters<ModelRequestLifecycle['onCompleted']>[0],
  ): Promise<void> {
    this.requireModelAttempt(attempt);
    await this.commitRebasableRequestBoundary([
      {
        type: DurableEventType.MODEL_REQUEST_COMPLETED,
        requestId: this.requestId,
        turnId: attempt.turnId,
        modelAttemptId: attempt.modelAttemptId,
        data: {
          response: this.toDurableModelResponse(response),
        },
      },
    ]);
    this.activeModelAttempt = null;
  }

  private async failModelRequest(
    attempt: ActiveModelAttempt,
    error: unknown,
  ): Promise<void> {
    this.requireModelAttempt(attempt);
    await this.commitRebasableRequestBoundary([
      {
        type: DurableEventType.MODEL_REQUEST_FAILED,
        requestId: this.requestId,
        turnId: attempt.turnId,
        modelAttemptId: attempt.modelAttemptId,
        data: {
          error: toDurableEventError(error, 'Model request failed'),
        },
      },
    ]);
    this.activeModelAttempt = null;
  }

  private async abortModelRequest(
    attempt: ActiveModelAttempt,
    reason: ModelRequestAbortReason,
  ): Promise<void> {
    this.requireModelAttempt(attempt);
    await this.commitRebasableRequestBoundary([
      {
        type: DurableEventType.MODEL_REQUEST_ABORTED,
        requestId: this.requestId,
        turnId: attempt.turnId,
        modelAttemptId: attempt.modelAttemptId,
        data: { reason },
      },
    ]);
    this.activeModelAttempt = null;
  }

  private toDurableModelResponse(
    response: Parameters<ModelRequestLifecycle['onCompleted']>[0],
  ): DurableModelResponse {
    return {
      content: response.content,
      ...(response.reasoningContent !== undefined
        ? { reasoningContent: response.reasoningContent }
        : {}),
      ...(response.toolCalls && response.toolCalls.length > 0
        ? {
            toolCalls: response.toolCalls.map((toolCall) => ({
              id: ToolUseId(toolCall.id),
              name: toolCall.function.name,
              arguments: toolCall.function.arguments,
            })),
          }
        : {}),
      ...(response.usage
        ? {
            usage: {
              promptTokens: response.usage.promptTokens,
              completionTokens: response.usage.completionTokens,
              totalTokens: response.usage.totalTokens,
              ...(response.usage.reasoningTokens !== undefined
                ? { reasoningTokens: response.usage.reasoningTokens }
                : {}),
              ...(response.usage.cacheCreationInputTokens !== undefined
                ? { cacheCreationInputTokens: response.usage.cacheCreationInputTokens }
                : {}),
              ...(response.usage.cacheReadInputTokens !== undefined
                ? { cacheReadInputTokens: response.usage.cacheReadInputTokens }
                : {}),
              ...(response.usage.cacheMissInputTokens !== undefined
                ? { cacheMissInputTokens: response.usage.cacheMissInputTokens }
                : {}),
              ...(response.usage.billableInputTokens !== undefined
                ? { billableInputTokens: response.usage.billableInputTokens }
                : {}),
            },
          }
        : {}),
    };
  }

  private async recordPermissionRequested(
    tool: ActiveTool,
    message: string,
    input: JsonValue,
  ): Promise<PermissionRequestId> {
    const turn = this.requireActiveTurn();
    const permissionRequestId = PermissionRequestId(nanoid());
    await this.commit([
      {
        type: DurableEventType.PERMISSION_REQUESTED,
        requestId: this.requestId,
        turnId: turn.turnId,
        toolAttemptId: tool.toolAttemptId,
        data: {
          permissionRequestId,
          toolCallId: tool.toolCallId,
          toolName: tool.toolName,
          input,
          message,
        },
      },
    ]);
    tool.permissionRequestId = permissionRequestId;
    return permissionRequestId;
  }

  private async recordPermissionResolved(
    tool: ActiveTool,
    resolution: ToolPermissionResolution,
  ): Promise<void> {
    const turn = this.requireActiveTurn();
    if (tool.permissionRequestId !== resolution.permissionRequestId) {
      throw new SessionDurableRecorderError(
        `Permission ${resolution.permissionRequestId} does not match tool ${tool.toolCallId}`,
      );
    }
    await this.commit([
      {
        type: DurableEventType.PERMISSION_RESOLVED,
        requestId: this.requestId,
        turnId: turn.turnId,
        toolAttemptId: tool.toolAttemptId,
        data: resolution,
      },
    ]);
    tool.permissionDecision = resolution.decision;
  }

  private async recordToolStarted(
    tool: ActiveTool,
    event: ToolExecutionStartedLifecycle,
  ): Promise<void> {
    const turn = this.requireActiveTurn();
    await this.commit([
      {
        type: DurableEventType.TOOL_STARTED,
        requestId: this.requestId,
        turnId: turn.turnId,
        toolAttemptId: tool.toolAttemptId,
        data: {
          toolCallId: tool.toolCallId,
          toolName: tool.toolName,
          input: event.input,
          sideEffect: event.sideEffect,
        },
      },
    ]);
    tool.status = 'started';
  }

  private async recordToolCancelled(
    tool: ActiveTool,
    reason: DurableToolCancelReason,
  ): Promise<void> {
    const turn = this.requireActiveTurn();
    await this.commit([
      {
        type: DurableEventType.TOOL_CANCELLED,
        requestId: this.requestId,
        turnId: turn.turnId,
        toolAttemptId: tool.toolAttemptId,
        data: {
          toolCallId: tool.toolCallId,
          toolName: tool.toolName,
          reason,
        },
      },
    ]);
  }

  private assertRequestOpen(): void {
    this.assertBoundaryHealthy();
    if (this.requestFinished) {
      throw new SessionDurableRecorderError(`Request ${this.requestId} is already terminal`);
    }
  }

  private assertBoundaryHealthy(): void {
    if (this.boundaryFailed) {
      throw new SessionDurableRecorderError(
        `Request ${this.requestId} recorder is fenced after a durable boundary failure`,
        { cause: this.boundaryFailure },
      );
    }
  }

  private requireLastBoundaryEventId(): EventId {
    if (!this.lastBoundaryEventId) {
      throw new SessionDurableRecorderError(
        `Request ${this.requestId} has no durable boundary`,
      );
    }
    return this.lastBoundaryEventId;
  }

  private requireActiveTurn(): ActiveTurn {
    this.assertRequestOpen();
    if (!this.activeTurn) {
      throw new SessionDurableRecorderError(`Request ${this.requestId} has no active turn`);
    }
    return this.activeTurn;
  }

  private requireTurnNumber(turn: number): ActiveTurn {
    const activeTurn = this.requireActiveTurn();
    if (activeTurn.turn !== turn) {
      throw new SessionDurableRecorderError(
        `Expected active turn ${activeTurn.turn}, received ${turn}`,
      );
    }
    return activeTurn;
  }

  private requireModelAttempt(attempt: ActiveModelAttempt): void {
    this.assertRequestOpen();
    if (
      this.activeModelAttempt !== attempt
      || this.activeTurn?.turnId !== attempt.turnId
    ) {
      throw new SessionDurableRecorderError(
        `No active model attempt matches ${attempt.modelAttemptId}`,
      );
    }
  }

  private assertNoActiveModelAttempt(turn: ActiveTurn): void {
    if (this.activeModelAttempt?.turnId === turn.turnId) {
      throw new SessionDurableRecorderError(
        `Model attempt ${this.activeModelAttempt.modelAttemptId} is still active`,
      );
    }
  }

  private async commit(
    events: Parameters<DurableSessionJournal['commit']>[0]['events'],
    options: DurableCommandCommitOptions = {},
  ): Promise<DurableCommandCommitResult> {
    return this.journal.commit(
      {
        commandId: CommandId(nanoid()),
        events,
      },
      options,
    );
  }

  private async commitRequestBoundary(
    events: Parameters<DurableSessionJournal['commit']>[0]['events'],
  ): Promise<DurableCommandCommitResult> {
    const commit = await this.commitAtCurrentHead(events);
    this.updateLastBoundary(commit);
    return commit;
  }

  private async commitRebasableRequestBoundary(
    events: Parameters<DurableSessionJournal['commit']>[0]['events'],
  ): Promise<DurableCommandCommitResult> {
    this.assertBoundaryHealthy();
    let commit: DurableCommandCommitResult;
    try {
      commit = await this.commit(events);
    } catch (error) {
      this.boundaryFailed = true;
      this.boundaryFailure = error;
      throw error;
    }
    this.updateLastBoundary(commit);
    return commit;
  }

  private updateLastBoundary(commit: DurableCommandCommitResult): void {
    const boundary = commit.events.at(-1);
    if (!boundary) {
      throw new SessionDurableRecorderError(
        `Request ${this.requestId} boundary commit returned no events`,
      );
    }
    this.lastBoundaryEventId = boundary.eventId;
  }

  private async commitAtCurrentHead(
    events: Parameters<DurableSessionJournal['commit']>[0]['events'],
  ): Promise<DurableCommandCommitResult> {
    this.assertBoundaryHealthy();
    const expectedHeadSequence = this.journal.getProjection().headSequence;
    try {
      return await this.commit(events, { expectedHeadSequence });
    } catch (error) {
      this.boundaryFailed = true;
      this.boundaryFailure = error;
      throw error;
    }
  }
}

export function durableRequestFinishFromLoopResult(
  result: LoopResult,
  usage: TokenUsageInfo,
  interruptionReason: DurableRequestInterruptReason = 'user_abort',
): DurableRequestFinish {
  if (result.error?.type === 'aborted') {
    return {
      status: 'interrupted',
      reason: interruptionReason,
    };
  }
  if (!result.success && !result.metadata?.shouldExitLoop) {
    return {
      status: 'failed',
      error: result.error?.message ?? 'Agent request failed',
    };
  }
  return {
    status: 'completed',
    output: result.finalMessage ?? '',
    usage,
  };
}
