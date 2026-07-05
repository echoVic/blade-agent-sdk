import type { ContextSnapshot, RuntimeContext } from '../runtime/types.js';
import type { JsonObject } from '../types/common.js';
import type { SessionLifecycleState } from './lifecycle.js';
import type { PendingTurn, PendingTurnBuffer } from './pendingTurn.js';
import type { ActiveTurnAbort, TurnAbortController } from './turnAbort.js';
import type { SendOptions, SessionId, UserMessageContent } from './types.js';

export interface ActiveSessionTurn extends PendingTurn, ActiveTurnAbort {}

export interface SessionTurnControllerOptions {
  sessionId: SessionId;
  pendingTurns: Pick<PendingTurnBuffer, 'enqueue' | 'take'>;
  turnAbort: Pick<TurnAbortController, 'start'>;
  lifecycle: Pick<SessionLifecycleState, 'assertOpen'>;
  getDefaultContext: () => RuntimeContext;
  createTurnId: () => string;
}

function mergeStringRecords(
  base?: Record<string, string>,
  override?: Record<string, string>,
): Record<string, string> | undefined {
  if (!base && !override) {
    return undefined;
  }
  return {
    ...(base ?? {}),
    ...(override ?? {}),
  };
}

function mergeJsonObjects(base?: JsonObject, override?: JsonObject): JsonObject | undefined {
  if (!base && !override) {
    return undefined;
  }
  return {
    ...(base ?? {}),
    ...(override ?? {}),
  };
}

export function mergeRuntimeContext(
  defaultContext: RuntimeContext = {},
  turnContext?: RuntimeContext,
): RuntimeContext {
  const baseCapabilities = defaultContext.capabilities;
  const overrideCapabilities = turnContext?.capabilities;

  const filesystem =
    baseCapabilities?.filesystem || overrideCapabilities?.filesystem
      ? {
          ...(baseCapabilities?.filesystem ?? {}),
          ...(overrideCapabilities?.filesystem ?? {}),
          roots:
            overrideCapabilities?.filesystem?.roots ??
            baseCapabilities?.filesystem?.roots ??
            [],
        }
      : undefined;

  return {
    ...defaultContext,
    ...turnContext,
    capabilities: {
      ...(baseCapabilities ?? {}),
      ...(overrideCapabilities ?? {}),
      ...(filesystem ? { filesystem } : {}),
    },
    environment: mergeStringRecords(defaultContext.environment, turnContext?.environment),
    metadata: mergeJsonObjects(defaultContext.metadata, turnContext?.metadata),
  };
}

export function createSessionContextSnapshot(
  sessionId: SessionId,
  turnId: string,
  defaultContext: RuntimeContext = {},
  turnContext?: RuntimeContext,
): ContextSnapshot {
  const context = mergeRuntimeContext(defaultContext, turnContext);
  const filesystemRoots = context.capabilities?.filesystem?.roots ?? [];
  return {
    sessionId,
    turnId,
    context,
    filesystemRoots,
    cwd: context.capabilities?.filesystem?.cwd,
    environment: context.environment ?? {},
  };
}

export class SessionTurnController {
  private readonly sessionId: SessionId;
  private readonly pendingTurns: Pick<PendingTurnBuffer, 'enqueue' | 'take'>;
  private readonly turnAbort: Pick<TurnAbortController, 'start'>;
  private readonly lifecycle: Pick<SessionLifecycleState, 'assertOpen'>;
  private readonly getDefaultContext: () => RuntimeContext;
  private readonly createTurnId: () => string;

  constructor(options: SessionTurnControllerOptions) {
    this.sessionId = options.sessionId;
    this.pendingTurns = options.pendingTurns;
    this.turnAbort = options.turnAbort;
    this.lifecycle = options.lifecycle;
    this.getDefaultContext = options.getDefaultContext;
    this.createTurnId = options.createTurnId;
  }

  send(message: UserMessageContent, options?: SendOptions): void {
    this.lifecycle.assertOpen();
    this.pendingTurns.enqueue({
      message,
      sendOptions: options ?? null,
      snapshot: createSessionContextSnapshot(
        this.sessionId,
        this.createTurnId(),
        this.getDefaultContext(),
        options?.context,
      ),
    });
  }

  beginStreamTurn(): ActiveSessionTurn {
    this.lifecycle.assertOpen();
    const turn = this.pendingTurns.take();
    const activeTurn = this.turnAbort.start(turn.sendOptions?.signal);

    return {
      ...turn,
      ...activeTurn,
    };
  }
}
