import type { UserMessageContent } from '../agent/types.js';
import { SessionInputError } from '../errors/SessionInputError.js';
import { cloneContentPart } from '../services/messageUtils.js';
import type { InputId, RequestId } from '../types/identifiers.js';
import {
  InputPriority,
  type InputPriority as InputPriorityType,
  type PendingSessionInput,
} from './types.js';

export class SessionInputInbox {
  private readonly entries: PendingSessionInput[] = [];
  private readonly claimed = new Set<InputId>();
  private readonly committed = new Set<InputId>();
  private retainedBytes = 0;

  constructor(
    private readonly maxInputs = 32,
    private readonly maxBytes = 1024 * 1024,
  ) {}

  enqueue(entry: PendingSessionInput): void {
    this.reserve(entry);
    this.markCommitted(entry.inputId);
  }

  reserve(entry: PendingSessionInput): void {
    const bytes = retainedBytes(entry.content);
    if (this.entries.length >= this.maxInputs || this.retainedBytes + bytes > this.maxBytes) {
      throw new SessionInputError(
        'SESSION_INPUT_QUEUE_FULL',
        `Session input queue capacity exceeded (${this.maxInputs} inputs, ${this.maxBytes} bytes)`,
      );
    }
    this.entries.push(cloneEntry(entry));
    this.retainedBytes += bytes;
  }

  markCommitted(inputId: InputId): void {
    if (this.find(inputId)) this.committed.add(inputId);
  }

  restore(entries: readonly PendingSessionInput[]): number {
    for (const [index, entry] of entries.entries()) {
      try {
        this.enqueue({ ...entry, priority: InputPriority.LATER, targetRequestId: undefined });
      } catch (error) {
        if (error instanceof SessionInputError && error.code === 'SESSION_INPUT_QUEUE_FULL') {
          return entries.length - index;
        }
        throw error;
      }
    }
    return 0;
  }

  claimNextLater(requestId: RequestId): PendingSessionInput | undefined {
    const entry = this.entries.find(
      (candidate) =>
        candidate.priority === InputPriority.LATER &&
        candidate.targetRequestId === undefined &&
        this.committed.has(candidate.inputId),
    );
    if (!entry) return undefined;
    entry.targetRequestId = requestId;
    return cloneEntry(entry);
  }

  claimForRequest(
    requestId: RequestId,
    priorities: readonly InputPriorityType[],
    excludedInputId?: InputId,
  ): PendingSessionInput[] {
    const order = new Map(priorities.map((priority, index) => [priority, index]));
    const matches = this.entries
      .filter(
        (entry) =>
          entry.targetRequestId === requestId &&
          order.has(entry.priority) &&
          entry.inputId !== excludedInputId &&
          this.committed.has(entry.inputId) &&
          !this.claimed.has(entry.inputId),
      )
      .sort(
        (left, right) =>
          (order.get(left.priority) ?? Infinity) - (order.get(right.priority) ?? Infinity) ||
          left.acceptedAt - right.acceptedAt,
      );
    for (const entry of matches) this.claimed.add(entry.inputId);
    return matches.map(cloneEntry);
  }

  acknowledge(inputId: InputId): PendingSessionInput | undefined {
    this.claimed.delete(inputId);
    return this.remove(inputId);
  }

  releaseClaim(inputId: InputId): void {
    this.claimed.delete(inputId);
  }

  claimForCancellation(inputId: InputId): PendingSessionInput | undefined {
    if (this.claimed.has(inputId)) return undefined;
    const entry = this.find(inputId);
    if (!entry) return undefined;
    this.claimed.add(inputId);
    return cloneEntry(entry);
  }

  remove(inputId: InputId): PendingSessionInput | undefined {
    const index = this.entries.findIndex((entry) => entry.inputId === inputId);
    if (index < 0) return undefined;
    const [entry] = this.entries.splice(index, 1);
    if (!entry) return undefined;
    this.claimed.delete(inputId);
    this.committed.delete(inputId);
    this.retainedBytes -= retainedBytes(entry.content);
    return cloneEntry(entry);
  }

  releaseRequest(requestId: RequestId): void {
    for (const entry of this.entries) {
      if (entry.targetRequestId !== requestId) continue;
      entry.priority = InputPriority.LATER;
      entry.targetRequestId = undefined;
      this.claimed.delete(entry.inputId);
    }
  }

  retargetLater(inputId: InputId): PendingSessionInput | undefined {
    const entry = this.find(inputId);
    if (!entry) return undefined;
    entry.priority = InputPriority.LATER;
    entry.targetRequestId = undefined;
    this.claimed.delete(inputId);
    return cloneEntry(entry);
  }

  getAll(): PendingSessionInput[] {
    return this.entries.map(cloneEntry);
  }

  get size(): number {
    return this.entries.length;
  }

  private find(inputId: InputId): PendingSessionInput | undefined {
    return this.entries.find((entry) => entry.inputId === inputId);
  }
}

function cloneEntry(entry: PendingSessionInput): PendingSessionInput {
  return {
    ...entry,
    content:
      typeof entry.content === 'string' ? entry.content : entry.content.map(cloneContentPart),
  };
}

function retainedBytes(content: UserMessageContent): number {
  return new TextEncoder().encode(JSON.stringify(content)).byteLength;
}
