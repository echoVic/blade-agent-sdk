import { nanoid } from 'nanoid';
import type { AgentEvent, TokenUsageInfo } from '../../agent/AgentEvent.js';
import type { LoopResult, UserMessageContent } from '../../agent/types.js';
import { SdkError } from '../../errors/SdkError.js';
import type {
  ToolExecutionStartedLifecycle,
  ToolExecutionLifecycle,
  ToolInvocationLifecycle,
  ToolPermissionResolution,
  ToolScheduledLifecycle,
  ToolSettledLifecycle,
} from '../../tools/types/ExecutionTypes.js';
import { ToolErrorType } from '../../tools/types/ToolResult.js';
import {
  CommandId,
  type InputId,
  PermissionRequestId,
  type RequestId,
  ToolAttemptId,
  type ToolUseId,
  TurnId,
} from '../../types/branded.js';
import type { JsonValue } from '../../types/common.js';
import { toJsonValue } from '../../utils/jsonValue.js';
import type { DurableSessionJournal } from './DurableSessionJournal.js';
import type { DurableSessionRecoveryPlan } from './DurableSessionProjector.js';
import {
  DurableEventType,
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
  tools: Map<ToolUseId, ActiveTool>;
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

export class SessionDurableRecorder implements ToolExecutionLifecycle {
  private activeTurn: ActiveTurn | null = null;
  private ignoredTurnEnd: number | null = null;
  private requestStarted = false;
  private requestFinished = false;

  constructor(
    private readonly journal: DurableSessionJournal,
    readonly requestId: RequestId,
    private readonly model: string,
  ) {}

  async recordAccepted(
    inputId: InputId,
    input: UserMessageContent,
    priority: 'next' | 'later' = 'next',
  ): Promise<void> {
    await this.commit([
      {
        type: DurableEventType.REQUEST_ACCEPTED,
        requestId: this.requestId,
        data: {
          inputId,
          input: toJsonValue(input),
          priority,
        },
      },
    ]);
  }

  async recordStarted(inputId: InputId, priority: 'next' | 'later' = 'next'): Promise<void> {
    this.assertRequestOpen();
    if (this.requestStarted) {
      throw new SessionDurableRecorderError(`Request ${this.requestId} was already started`);
    }
    await this.commit([
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
        await this.commit([
          {
            type: DurableEventType.INPUT_APPLIED,
            requestId: this.requestId,
            ...(this.activeTurn ? { turnId: this.activeTurn.turnId } : {}),
            data: {
              inputId: event.inputId,
              priority: event.priority,
            },
          },
        ]);
        return;
      default:
        return;
    }
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

    switch (finish.status) {
      case 'completed':
        await this.commit([
          {
            type: DurableEventType.REQUEST_COMPLETED,
            requestId: this.requestId,
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
        await this.commit([
          {
            type: DurableEventType.REQUEST_FAILED,
            requestId: this.requestId,
            data: {
              error: {
                message:
                  finish.error instanceof Error ? finish.error.message : String(finish.error),
              },
            },
          },
        ]);
        break;
      case 'interrupted':
        await this.commit([
          {
            type: DurableEventType.REQUEST_INTERRUPTED,
            requestId: this.requestId,
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
          toolAttemptId: tool.toolAttemptId,
          data: {
            toolCallId: tool.toolCallId,
            toolName: tool.toolName,
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
      tools: new Map(),
    };
    await this.commit([
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
    await this.commit([
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
      await this.commit(drafts);
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
    await this.commit([
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
    if (this.requestFinished) {
      throw new SessionDurableRecorderError(`Request ${this.requestId} is already terminal`);
    }
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

  private async commit(
    events: Parameters<DurableSessionJournal['commit']>[0]['events'],
  ): Promise<void> {
    await this.journal.commit({
      commandId: CommandId(nanoid()),
      events,
    });
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
