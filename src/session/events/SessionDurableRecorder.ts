import { Mutex } from 'async-mutex';
import { nanoid } from 'nanoid';
import type { AgentEvent } from '../../agent/AgentEvent.js';
import type {
  ModelExecutionLifecycle,
  ModelRequestLifecycle,
} from '../../agent/ModelExecutionLifecycle.js';
import type { InputApplicationLifecycle, UserMessageContent } from '../../agent/types.js';
import type { ModelIdentity } from '../../model/identity.js';
import type {
  ToolExecutionLifecycle,
  ToolExecutionStartedLifecycle,
  ToolInvocationLifecycle,
  ToolPermissionResolution,
  ToolScheduledLifecycle,
  ToolSettledLifecycle,
} from '../../tools/types/execution.js';
import { ToolErrorType } from '../../tools/types/result.js';
import {
  CommandId,
  type EventId,
  type InputId,
  ModelAttemptId,
  PermissionRequestId,
  type RequestId,
  ToolAttemptId,
  type ToolUseId,
  TurnId,
} from '../../types/identifiers.js';
import type { JsonObject, JsonValue } from '../../types/json.js';
import { toJsonValue } from '../../utils/jsonValue.js';
import {
  DurableSessionRecoveryRequiredError,
  SessionDurableRecorderError,
} from './DurableRecorderErrors.js';
import {
  type DurableRequestFinish,
  durableRequestFinishFromLoopResult,
  toDurableEventError,
  toDurableModelResponse,
} from './DurableRecorderPayload.js';
import type {
  DurableCommandCommitOptions,
  DurableCommandCommitResult,
  DurableCommandEventDraft,
  DurableSessionJournal,
} from './DurableSessionJournal.js';
import type {
  DurableRequestProjection,
  DurableToolAttemptProjection,
  DurableTurnProjection,
} from './DurableSessionProjector.js';
import {
  modelTerminalEvent,
  requestTerminalEvent,
  toolTerminalEvent,
} from './DurableTerminalEvents.js';
import { DurableEventType, type DurableToolCancelReason } from './types.js';

export type { DurableRequestFinish };
export {
  DurableSessionRecoveryRequiredError,
  durableRequestFinishFromLoopResult,
  SessionDurableRecorderError,
};

type ActiveModelAttempt = { modelAttemptId: ModelAttemptId; turnId: TurnId };

function isOpenTool(tool: DurableToolAttemptProjection): boolean {
  return (
    tool.status === 'scheduled' || tool.status === 'started' || tool.status === 'outcome_unknown'
  );
}

export class SessionDurableRecorder
  implements ToolExecutionLifecycle, InputApplicationLifecycle, ModelExecutionLifecycle
{
  private readonly pendingToolCalls = new Set<ToolUseId>();
  private boundaryFailed = false;
  private boundaryFailure: unknown;
  private ignoredTurnEnd: number | null = null;
  private handoffRequested = false;
  private completedTurnObserved = false;
  private readonly handoffMutex = new Mutex();

  constructor(
    private readonly journal: DurableSessionJournal,
    readonly requestId: RequestId,
    private readonly model: string,
  ) {}

  assertHandoffReady(): void {
    this.assertBoundaryHealthy();
  }

  beginHandoff(): boolean {
    this.assertBoundaryHealthy();
    if (!this.getRequest()) {
      return false;
    }
    this.handoffRequested = true;
    return true;
  }

  isHandoffRequested(): boolean {
    return this.handoffRequested;
  }

  async finalizeHandoff(): Promise<void> {
    await this.handoffMutex.runExclusive(() => this.finalizeHandoffExclusive());
  }

  private async finalizeHandoffExclusive(): Promise<void> {
    this.assertBoundaryHealthy();
    if (!this.handoffRequested) {
      return;
    }
    const request = this.getRequest();
    if (!request) {
      return;
    }
    const turn = request.activeTurn;
    if (!turn) {
      if (
        this.completedTurnObserved &&
        request.status === 'running' &&
        request.pendingInputIds.length === 0
      ) {
        await this.startTurn(request.lastTurn + 1);
      }
      return;
    }

    const drafts: DurableCommandEventDraft[] = [];
    if (turn.activeModelAttempt) {
      drafts.push({
        type: DurableEventType.MODEL_REQUEST_ABORTED,
        requestId: this.requestId,
        turnId: turn.turnId,
        modelAttemptId: turn.activeModelAttempt.modelAttemptId,
        data: { reason: 'process_restart' },
      });
    }

    for (const tool of turn.toolAttempts) {
      if (!isOpenTool(tool) || tool.status === 'outcome_unknown') {
        continue;
      }
      if (tool.status === 'started') {
        drafts.push({
          type: DurableEventType.TOOL_OUTCOME_UNKNOWN,
          requestId: this.requestId,
          turnId: turn.turnId,
          toolAttemptId: tool.toolAttemptId,
          data: {
            toolCallId: tool.toolCallId,
            toolName: tool.toolName,
            reason: 'process_restart',
          },
        });
        continue;
      }
      if (tool.permission?.status === 'pending') {
        drafts.push({
          type: DurableEventType.PERMISSION_RESOLVED,
          requestId: this.requestId,
          turnId: turn.turnId,
          toolAttemptId: tool.toolAttemptId,
          data: {
            permissionRequestId: tool.permission.permissionRequestId,
            decision: 'cancel',
            message: 'Worker handoff ended permission resolution',
          },
        });
      }
      drafts.push({
        type: DurableEventType.TOOL_CANCELLED,
        requestId: this.requestId,
        turnId: turn.turnId,
        toolAttemptId: tool.toolAttemptId,
        data: {
          toolCallId: tool.toolCallId,
          toolName: tool.toolName,
          reason: 'process_restart',
        },
      });
    }

    if (drafts.length === 0) return;
    await this.commitAtCurrentHead(drafts);
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
    await this.commitAtCurrentHead([
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
    const request = this.requireRequest();
    if (request.status === 'running') {
      throw new SessionDurableRecorderError(`Request ${this.requestId} was already started`);
    }
    await this.commitAtCurrentHead([
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
  }

  async onInputApplying(input: {
    readonly inputId: InputId;
    readonly priority: 'now' | 'next';
  }): Promise<void> {
    this.assertNewWorkAllowed();
    const request = this.requireRequest();
    if (request.status !== 'running') {
      throw new SessionDurableRecorderError(`Request ${this.requestId} has not started`);
    }
    if (request.activeTurn) {
      throw new SessionDurableRecorderError(
        `Input ${input.inputId} cannot be prepared while turn ${request.activeTurn.turnId} is active`,
      );
    }
    if (request.pendingInputIds.includes(input.inputId)) return;

    await this.commitAtCurrentHead([
      {
        type: DurableEventType.INPUT_APPLIED,
        requestId: this.requestId,
        data: {
          inputId: input.inputId,
          priority: input.priority,
        },
      },
    ]);
  }

  async recordAgentEvent(event: AgentEvent): Promise<void> {
    this.requireRequest();
    switch (event.type) {
      case 'turn_start':
        if (this.handoffRequested) {
          return;
        }
        await this.startTurn(event.turn);
        return;
      case 'turn_end':
        if (this.handoffRequested) {
          return;
        }
        if (this.ignoredTurnEnd === event.turn) {
          this.ignoredTurnEnd = null;
          return;
        }
        await this.completeTurn(event.turn, event.hasToolCalls);
        return;
      case 'turn_interrupted':
        if (this.handoffRequested) {
          return;
        }
        if (!(await this.abortTurn(event.turn, 'request_interrupted'))) {
          throw new SessionDurableRecorderError(
            `Turn ${this.getRequest()?.activeTurn?.turnId ?? event.turn} has a tool outcome that requires reconciliation`,
          );
        }
        this.ignoredTurnEnd = event.turn;
        return;
      case 'input_applied': {
        if (!this.requireRequest().pendingInputIds.includes(event.inputId)) {
          throw new SessionDurableRecorderError(
            `Input ${event.inputId} was not persisted before preparation`,
          );
        }
        return;
      }
      default:
        return;
    }
  }

  async onModelRequestStarting(input: {
    readonly turn: number;
    readonly model: string;
    readonly modelIdentity?: ModelIdentity;
    readonly streaming: boolean;
  }): Promise<ModelRequestLifecycle> {
    this.assertNewWorkAllowed();
    const turn = this.requireTurnNumber(input.turn);
    if (turn.activeModelAttempt) {
      throw new SessionDurableRecorderError(
        `Model attempt ${turn.activeModelAttempt.modelAttemptId} is still active`,
      );
    }
    const attempt: ActiveModelAttempt = {
      modelAttemptId: ModelAttemptId(nanoid()),
      turnId: turn.turnId,
    };
    await this.commitAtCurrentHead([
      {
        type: DurableEventType.MODEL_REQUEST_STARTED,
        requestId: this.requestId,
        turnId: turn.turnId,
        modelAttemptId: attempt.modelAttemptId,
        data: {
          model: input.model,
          ...(input.modelIdentity ? { modelIdentity: input.modelIdentity } : {}),
          streaming: input.streaming,
        },
      },
    ]);

    return {
      modelAttemptId: attempt.modelAttemptId,
      onCompleted: (response) =>
        this.recordModelOutcome(
          attempt,
          modelTerminalEvent(
            { requestId: this.requestId, ...attempt },
            { status: 'completed', response: toDurableModelResponse(response) },
          ),
        ),
      onFailed: (error) =>
        this.recordModelOutcome(
          attempt,
          modelTerminalEvent(
            { requestId: this.requestId, ...attempt },
            { status: 'failed', error: toDurableEventError(error, 'Model request failed') },
          ),
        ),
      onAborted: (reason) =>
        this.recordModelOutcome(
          attempt,
          modelTerminalEvent(
            { requestId: this.requestId, ...attempt },
            { status: 'aborted', reason },
          ),
        ),
    };
  }

  async finish(finish: DurableRequestFinish): Promise<boolean> {
    const request = this.requireRequest();
    if (this.handoffRequested && finish.status === 'interrupted') {
      return true;
    }
    if (request.activeTurn) {
      if (finish.status === 'completed') {
        throw new SessionDurableRecorderError(
          `Request ${this.requestId} completed while turn ${request.activeTurn.turnId} was still active`,
        );
      }
      const reason = finish.status === 'interrupted' ? 'request_interrupted' : 'error';
      if (!(await this.abortTurn(request.activeTurn.turn, reason))) {
        return false;
      }
    }

    const outcome =
      finish.status === 'failed'
        ? ({
            status: 'failed',
            error: toDurableEventError(finish.error, 'Request failed'),
          } as const)
        : finish.status === 'completed'
          ? {
              ...finish,
              ...(finish.usage
                ? {
                    usage: {
                      inputTokens: finish.usage.inputTokens,
                      outputTokens: finish.usage.outputTokens,
                      totalTokens: finish.usage.totalTokens,
                    },
                  }
                : {}),
            }
          : finish;
    await this.commitAtCurrentHead([
      requestTerminalEvent(this.requestId, this.requireLastBoundaryEventId(), outcome),
    ]);
    return true;
  }

  async onToolScheduled(event: ToolScheduledLifecycle): Promise<ToolInvocationLifecycle> {
    this.assertNewWorkAllowed();
    const turn = this.requireActiveTurn();
    if (
      !event.modelAttemptId ||
      event.modelAttemptId !== turn.modelAttempts.at(-1)?.modelAttemptId
    ) {
      throw new SessionDurableRecorderError(
        `Tool call ${event.toolCallId} does not belong to the current model attempt`,
      );
    }
    if (
      this.pendingToolCalls.has(event.toolCallId) ||
      turn.toolAttempts.some((tool) => tool.toolCallId === event.toolCallId)
    ) {
      throw new SessionDurableRecorderError(
        `Tool call ${event.toolCallId} was already scheduled in turn ${turn.turnId}`,
      );
    }
    const toolAttemptId = ToolAttemptId(nanoid());
    this.pendingToolCalls.add(event.toolCallId);
    try {
      await this.commit([
        {
          type: DurableEventType.TOOL_SCHEDULED,
          requestId: this.requestId,
          turnId: turn.turnId,
          modelAttemptId: event.modelAttemptId,
          toolAttemptId,
          data: {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            modelInput: event.modelInput,
            input: event.input,
            sideEffect: event.sideEffect,
            interruptBehavior: event.interruptBehavior,
          },
        },
      ]);
    } finally {
      this.pendingToolCalls.delete(event.toolCallId);
    }

    return {
      onPermissionRequested: (details, input) =>
        this.recordPermissionRequested(toolAttemptId, details.message, input),
      onPermissionResolved: (resolution) =>
        this.recordPermissionResolved(toolAttemptId, resolution),
      onExecutionStarted: (event) => this.recordToolStarted(toolAttemptId, event),
    };
  }

  async onToolSettled(event: ToolSettledLifecycle): Promise<void> {
    const turn = this.requireActiveTurn();
    const tool = turn.toolAttempts.find((candidate) => candidate.toolCallId === event.toolCallId);
    if (!tool || tool.toolName !== event.toolName) {
      throw new SessionDurableRecorderError(
        `No scheduled tool matches ${event.toolName} (${event.toolCallId})`,
      );
    }
    if (!isOpenTool(tool)) {
      throw new SessionDurableRecorderError(`Tool call ${event.toolCallId} was already settled`);
    }
    if (this.handoffRequested && tool.status === 'scheduled') {
      return;
    }

    if (this.handoffRequested && tool.status === 'started' && event.result.status === 'error') {
      await this.recordToolOutcomeUnknown(tool.toolAttemptId, 'process_restart');
    } else if (event.result.status === 'success') {
      if (tool.status !== 'started') {
        throw new SessionDurableRecorderError(
          `Successful tool ${event.toolCallId} never crossed the execution boundary`,
        );
      }
      await this.commit([
        toolTerminalEvent(this.toolScope(turn, tool), {
          status: 'completed',
          result: event.result.model,
        }),
      ]);
    } else if (
      tool.permission?.status === 'resolved' &&
      (tool.permission.decision === 'deny' || tool.permission.decision === 'cancel')
    ) {
      await this.recordToolCancelled(
        tool.toolAttemptId,
        tool.permission.decision === 'deny' ? 'permission_denied' : 'permission_cancelled',
      );
    } else if (event.result.error.type === ToolErrorType.INTERRUPTED) {
      await this.recordToolCancelled(tool.toolAttemptId, 'request_interrupted');
    } else {
      await this.commit([
        toolTerminalEvent(this.toolScope(turn, tool), {
          status: 'failed',
          error: {
            message: event.result.error.message,
            ...(event.result.error.code ? { code: event.result.error.code } : {}),
          },
        }),
      ]);
    }
  }

  private async startTurn(turn: number): Promise<void> {
    const request = this.requireRequest();
    if (request.activeTurn) {
      throw new SessionDurableRecorderError(`Turn ${request.activeTurn.turnId} is still active`);
    }
    const turnId = TurnId(nanoid());
    await this.commitAtCurrentHead([
      {
        type: DurableEventType.TURN_STARTED,
        requestId: this.requestId,
        turnId,
        data: {
          turn,
          model: this.model,
        },
      },
    ]);
  }

  private async completeTurn(turn: number, hasToolCalls: boolean): Promise<void> {
    const activeTurn = this.requireTurnNumber(turn);
    this.assertNoActiveModelAttempt(activeTurn);
    await this.commitAtCurrentHead([
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
    this.completedTurnObserved = true;
  }

  private async abortTurn(turn: number, reason: 'request_interrupted' | 'error'): Promise<boolean> {
    const activeTurn = this.requireTurnNumber(turn);
    this.assertNoActiveModelAttempt(activeTurn);
    const drafts: DurableCommandEventDraft[] = [];
    let hasUnknownOutcome = false;

    for (const tool of activeTurn.toolAttempts) {
      if (!isOpenTool(tool)) {
        continue;
      }
      if (tool.status === 'started') {
        hasUnknownOutcome = true;
        continue;
      }
      if (tool.permission?.status === 'pending') {
        drafts.push({
          type: DurableEventType.PERMISSION_RESOLVED,
          requestId: this.requestId,
          turnId: activeTurn.turnId,
          toolAttemptId: tool.toolAttemptId,
          data: {
            permissionRequestId: tool.permission.permissionRequestId,
            decision: 'cancel',
            message: 'Request ended before permission resolution',
          },
        });
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
      });
    }

    if (drafts.length > 0) {
      await this.commitAtCurrentHead(drafts);
    }
    if (hasUnknownOutcome) {
      return false;
    }
    await this.commitAtCurrentHead([
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
    return true;
  }

  private async recordModelOutcome(
    attempt: ActiveModelAttempt,
    event: DurableCommandEventDraft,
  ): Promise<void> {
    await this.handoffMutex.runExclusive(async () => {
      if (this.handoffRequested && !this.isActiveModelAttempt(attempt)) return;
      this.requireModelAttempt(attempt);
      await this.commitRebasableRequestBoundary([event]);
    });
  }

  private async recordPermissionRequested(
    toolAttemptId: ToolAttemptId,
    message: string,
    input: JsonValue,
  ): Promise<PermissionRequestId> {
    this.assertNewWorkAllowed();
    const { turn, tool } = this.requireToolAttempt(toolAttemptId);
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
    return permissionRequestId;
  }

  private async recordPermissionResolved(
    toolAttemptId: ToolAttemptId,
    resolution: ToolPermissionResolution,
  ): Promise<void> {
    const { turn, tool } = this.requireToolAttempt(toolAttemptId);
    if (tool.permission?.permissionRequestId !== resolution.permissionRequestId) {
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
  }

  private async recordToolStarted(
    toolAttemptId: ToolAttemptId,
    event: ToolExecutionStartedLifecycle,
  ): Promise<void> {
    this.assertNewWorkAllowed();
    const { turn, tool } = this.requireToolAttempt(toolAttemptId);
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
  }

  private async recordToolCancelled(
    toolAttemptId: ToolAttemptId,
    reason: DurableToolCancelReason,
  ): Promise<void> {
    const { turn, tool } = this.requireToolAttempt(toolAttemptId);
    await this.commit([
      toolTerminalEvent(this.toolScope(turn, tool), { status: 'cancelled', reason }),
    ]);
  }

  private async recordToolOutcomeUnknown(
    toolAttemptId: ToolAttemptId,
    reason: 'process_restart' | 'commit_outcome_unknown',
  ): Promise<void> {
    const { turn, tool } = this.requireToolAttempt(toolAttemptId);
    await this.commitAtCurrentHead([
      toolTerminalEvent(this.toolScope(turn, tool), { status: 'outcome_unknown', reason }),
    ]);
  }

  private assertNewWorkAllowed(): void {
    if (this.handoffRequested) {
      throw new SessionDurableRecorderError(
        `Request ${this.requestId} is suspended for worker handoff`,
      );
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
    const eventId = this.journal.getProjection().lastEventId;
    if (!eventId) {
      throw new SessionDurableRecorderError(`Request ${this.requestId} has no durable boundary`);
    }
    return eventId;
  }

  private getRequest(): DurableRequestProjection | null {
    const request = this.journal.getProjection().activeRequest;
    return request?.requestId === this.requestId ? request : null;
  }

  private requireRequest(): DurableRequestProjection {
    this.assertBoundaryHealthy();
    const request = this.getRequest();
    if (!request) {
      throw new SessionDurableRecorderError(`Request ${this.requestId} is already terminal`);
    }
    return request;
  }

  private requireActiveTurn(): DurableTurnProjection {
    const turn = this.requireRequest().activeTurn;
    if (!turn) {
      throw new SessionDurableRecorderError(`Request ${this.requestId} has no active turn`);
    }
    return turn;
  }

  private requireTurnNumber(turn: number): DurableTurnProjection {
    const activeTurn = this.requireActiveTurn();
    if (activeTurn.turn !== turn) {
      throw new SessionDurableRecorderError(
        `Expected active turn ${activeTurn.turn}, received ${turn}`,
      );
    }
    return activeTurn;
  }

  private requireModelAttempt(attempt: ActiveModelAttempt): void {
    if (!this.isActiveModelAttempt(attempt)) {
      throw new SessionDurableRecorderError(
        `No active model attempt matches ${attempt.modelAttemptId}`,
      );
    }
  }

  private isActiveModelAttempt(attempt: ActiveModelAttempt): boolean {
    const active = this.getRequest()?.activeTurn?.activeModelAttempt;
    return (
      active?.modelAttemptId === attempt.modelAttemptId &&
      this.getRequest()?.activeTurn?.turnId === attempt.turnId
    );
  }

  private assertNoActiveModelAttempt(turn: DurableTurnProjection): void {
    if (turn.activeModelAttempt) {
      throw new SessionDurableRecorderError(
        `Model attempt ${turn.activeModelAttempt.modelAttemptId} is still active`,
      );
    }
  }

  private requireToolAttempt(toolAttemptId: ToolAttemptId): {
    turn: DurableTurnProjection;
    tool: DurableToolAttemptProjection;
  } {
    const turn = this.requireActiveTurn();
    const tool = turn.toolAttempts.find((candidate) => candidate.toolAttemptId === toolAttemptId);
    if (!tool) {
      throw new SessionDurableRecorderError(`No active tool attempt matches ${toolAttemptId}`);
    }
    return { turn, tool };
  }

  private toolScope(turn: DurableTurnProjection, tool: DurableToolAttemptProjection) {
    return {
      requestId: this.requestId,
      turnId: turn.turnId,
      toolAttemptId: tool.toolAttemptId,
      toolCallId: tool.toolCallId,
      toolName: tool.toolName,
    };
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
    return commit;
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
