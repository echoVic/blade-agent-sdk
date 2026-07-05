import type { PendingTurnBuffer } from './pendingTurn.js';
import type { TurnAbortController } from './turnAbort.js';

export interface SessionLifecycleStateOptions {
  pendingTurns: Pick<PendingTurnBuffer, 'clear'>;
  turnAbort: Pick<TurnAbortController, 'abort'>;
}

export type SessionCloseCleanup = () => Promise<void> | void;

export class SessionLifecycleState {
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private readonly pendingTurns: Pick<PendingTurnBuffer, 'clear'>;
  private readonly turnAbort: Pick<TurnAbortController, 'abort'>;

  constructor(options: SessionLifecycleStateOptions) {
    this.pendingTurns = options.pendingTurns;
    this.turnAbort = options.turnAbort;
  }

  isClosed(): boolean {
    return this.closed;
  }

  assertOpen(): void {
    if (this.closed) {
      throw new Error('Session is closed');
    }
  }

  abort(): void {
    this.turnAbort.abort();
  }

  close(cleanup?: SessionCloseCleanup): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }

    this.closed = true;
    this.pendingTurns.clear();
    this.abort();

    this.closePromise = Promise.resolve()
      .then(() => cleanup?.())
      .then(() => undefined);
    return this.closePromise;
  }
}
