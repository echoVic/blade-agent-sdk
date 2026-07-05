import type { ContextSnapshot } from '../runtime/types.js';
import type { SendOptions, UserMessageContent } from './types.js';

export interface PendingTurn {
  message: UserMessageContent;
  sendOptions: SendOptions | null;
  snapshot: ContextSnapshot;
}

export class PendingTurnBuffer {
  private pending: PendingTurn | null = null;

  hasPending(): boolean {
    return this.pending !== null;
  }

  enqueue(turn: PendingTurn): void {
    if (this.pending !== null) {
      throw new Error(
        'Cannot send a new message while a previous message is pending. Call stream() first.',
      );
    }

    this.pending = turn;
  }

  take(): PendingTurn {
    if (this.pending === null) {
      throw new Error('No pending message. Call send() before stream().');
    }

    const turn = this.pending;
    this.pending = null;
    return turn;
  }

  clear(): void {
    this.pending = null;
  }
}
