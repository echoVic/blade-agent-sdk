import type { UserMessageContent } from '../agent/types.js';
import { SessionInputError } from '../errors/SessionInputError.js';
import { cloneContentPart } from '../services/messageUtils.js';
import type { InputId, RequestId } from '../types/branded.js';
import {
  InputPriority,
  type InputPriority as InputPriorityType,
  type PendingSessionInput,
} from './types.js';

const DEFAULT_MAX_INPUTS = 32;
const DEFAULT_MAX_BYTES = 1024 * 1024;

export class SessionInputInbox {
  private readonly entries: PendingSessionInput[] = [];
  private retainedBytes = 0;

  constructor(
    private readonly maxInputs = DEFAULT_MAX_INPUTS,
    private readonly maxBytes = DEFAULT_MAX_BYTES,
  ) {}

  enqueue(entry: PendingSessionInput): void {
    const retainedBytes = getRetainedBytes(entry.content);
    if (
      this.entries.length >= this.maxInputs
      || this.retainedBytes + retainedBytes > this.maxBytes
    ) {
      throw new SessionInputError(
        'SESSION_INPUT_QUEUE_FULL',
        `Session input queue capacity exceeded (${this.maxInputs} inputs, ${this.maxBytes} bytes)`,
      );
    }

    this.entries.push(cloneEntry(entry));
    this.retainedBytes += retainedBytes;
  }

  restore(entries: readonly PendingSessionInput[]): void {
    for (const entry of entries) {
      this.enqueue({
        ...entry,
        priority: InputPriority.LATER,
        targetRequestId: undefined,
      });
    }
  }

  claimNextLater(requestId: RequestId): PendingSessionInput | undefined {
    const entry = this.entries.find(
      (candidate) =>
        candidate.priority === InputPriority.LATER
        && candidate.targetRequestId === undefined,
    );
    if (!entry) {
      return undefined;
    }

    entry.targetRequestId = requestId;
    return cloneEntry(entry);
  }

  takeForRequest(
    requestId: RequestId,
    priorities: readonly InputPriorityType[],
  ): PendingSessionInput[] {
    const priorityOrder = new Map(
      priorities.map((priority, index) => [priority, index]),
    );
    const matched = this.entries
      .filter(
        (entry) =>
          entry.targetRequestId === requestId
          && priorityOrder.has(entry.priority),
      )
      .sort(
        (left, right) =>
          (priorityOrder.get(left.priority) ?? Number.MAX_SAFE_INTEGER)
          - (priorityOrder.get(right.priority) ?? Number.MAX_SAFE_INTEGER)
          || left.acceptedAt - right.acceptedAt,
      );

    for (const entry of matched) {
      this.remove(entry.inputId);
    }
    return matched.map(cloneEntry);
  }

  remove(inputId: InputId): PendingSessionInput | undefined {
    const index = this.entries.findIndex((entry) => entry.inputId === inputId);
    if (index === -1) {
      return undefined;
    }

    const [entry] = this.entries.splice(index, 1);
    if (!entry) {
      return undefined;
    }
    this.retainedBytes -= getRetainedBytes(entry.content);
    return cloneEntry(entry);
  }

  releaseRequest(requestId: RequestId): void {
    for (const entry of this.entries) {
      if (entry.targetRequestId !== requestId) {
        continue;
      }
      entry.priority = InputPriority.LATER;
      entry.targetRequestId = undefined;
    }
  }

  getAll(): PendingSessionInput[] {
    return this.entries.map(cloneEntry);
  }

  get size(): number {
    return this.entries.length;
  }
}

function cloneEntry(entry: PendingSessionInput): PendingSessionInput {
  return {
    ...entry,
    content: typeof entry.content === 'string'
      ? entry.content
      : entry.content.map(cloneContentPart),
  };
}

function getRetainedBytes(content: UserMessageContent): number {
  return new TextEncoder().encode(JSON.stringify(content)).byteLength;
}
