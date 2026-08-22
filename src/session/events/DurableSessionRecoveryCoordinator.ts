import { SdkError } from '../../errors/SdkError.js';
import type {
  CommandId,
  PermissionRequestId,
  SessionId,
  ToolAttemptId,
} from '../../types/branded.js';
import type { ToolSideEffect } from '../../tools/types/ToolKind.js';
import type { JsonObject, JsonValue } from '../../types/common.js';
import type { DurableEventStore } from './DurableEventStore.js';
import {
  type DurableCommandCommitResult,
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
} from './DurableSessionProjector.js';
import {
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
  readonly input: JsonObject;
  readonly sideEffect: ToolSideEffect;
}

export interface DurablePermissionResolutionCommand {
  readonly commandId: CommandId;
  readonly permissionRequestId: PermissionRequestId;
  readonly decision: DurablePermissionDecision;
  readonly message?: string;
}

export interface DurableRecoveryCommitResult {
  readonly commit: DurableCommandCommitResult;
  readonly projection: DurableSessionProjection;
  readonly recoveryPlan: DurableSessionRecoveryPlan;
}

export type DurableSessionRecoveryErrorCode =
  | 'DURABLE_RECOVERY_INVALID_STATE'
  | 'DURABLE_RECOVERY_TARGET_NOT_FOUND';

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

  async reconcileToolOutcome(
    command: DurableToolOutcomeReconciliationCommand,
  ): Promise<DurableRecoveryCommitResult> {
    await this.journal.refresh();
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
    });
    return this.result(commit);
  }

  async startToolAttempt(command: DurableToolStartCommand): Promise<DurableRecoveryCommitResult> {
    await this.journal.refresh();
    const { request, turn, tool } = this.findToolAttempt(command.toolAttemptId);
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
            input: command.input,
            sideEffect: command.sideEffect,
          },
        },
      ],
    });
    return this.result(commit);
  }

  async resolvePermission(
    command: DurablePermissionResolutionCommand,
  ): Promise<DurableRecoveryCommitResult> {
    await this.journal.refresh();
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
    });
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
  ): Promise<DurableCommandCommitResult> {
    try {
      return await this.journal.commit(command);
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
