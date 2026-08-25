import type { UserMessageContent } from '../agent/types.js';
import { SessionInputError } from '../errors/SessionInputError.js';
import { cloneContentPart } from '../services/messageUtils.js';
import type { InputId, RequestId } from '../types/identifiers.js';
import {
  InputPriority,
  type InputPriority as InputPriorityType,
  type PendingSessionInput,
} from './types.js';

const DEFAULT_MAX_INPUTS = 32;
const DEFAULT_MAX_BYTES = 1024 * 1024;

export class SessionInputInbox {
  private readonly entries: PendingSessionInput[] = [];
  private readonly claimedInputIds = new Set<InputId>();
  private readonly committedInputIds = new Set<InputId>();
  private retainedBytes = 0;

  constructor(
    private readonly maxInputs = DEFAULT_MAX_INPUTS,
    private readonly maxBytes = DEFAULT_MAX_BYTES,
  ) {}

  enqueue(entry: PendingSessionInput): void {
    this.reserve(entry);
    this.markCommitted(entry.inputId);
  }

  reserve(entry: PendingSessionInput): void {
    const retainedBytes = getRetainedBytes(entry.content);
    if (
      this.entries.length >= this.maxInputs ||
      this.retainedBytes + retainedBytes > this.maxBytes
    ) {
      throw new SessionInputError(
        'SESSION_INPUT_QUEUE_FULL',
        `Session input queue capacity exceeded (${this.maxInputs} inputs, ${this.maxBytes} bytes)`,
      );
    }

    this.entries.push(cloneEntry(entry));
    this.retainedBytes += retainedBytes;
  }

  markCommitted(inputId: InputId): void {
    if (this.entries.some((entry) => entry.inputId === inputId)) {
      this.committedInputIds.add(inputId);
    }
  }

  /**
   * 从持久化历史恢复待处理输入。
   *
   * 逐条尝试入队；一旦达到 count/byte 上限即停止恢复剩余条目，而不是抛错。
   * 这样可避免容量超限时经由调用方的 try/catch 静默丢弃全部待处理输入。
   *
   * @returns 未能恢复（被丢弃）的条目数量，供调用方记录告警。
   */
  restore(entries: readonly PendingSessionInput[]): number {
    let dropped = 0;
    for (const [index, entry] of entries.entries()) {
      try {
        this.enqueue({
          ...entry,
          priority: InputPriority.LATER,
          targetRequestId: undefined,
        });
      } catch (error) {
        if (error instanceof SessionInputError && error.code === 'SESSION_INPUT_QUEUE_FULL') {
          dropped = entries.length - index;
          break;
        }
        throw error;
      }
    }
    return dropped;
  }

  claimNextLater(requestId: RequestId): PendingSessionInput | undefined {
    const entry = this.entries.find(
      (candidate) =>
        candidate.priority === InputPriority.LATER &&
        candidate.targetRequestId === undefined &&
        // 与 claimForRequest 保持一致：仅领取已持久化提交的输入，
        // 避免领取 reserve() 之后尚未 markCommitted 的条目。
        this.committedInputIds.has(candidate.inputId),
    );
    if (!entry) {
      return undefined;
    }

    entry.targetRequestId = requestId;
    return cloneEntry(entry);
  }

  claimForRequest(
    requestId: RequestId,
    priorities: readonly InputPriorityType[],
    excludedInputId?: InputId,
  ): PendingSessionInput[] {
    const priorityOrder = new Map(priorities.map((priority, index) => [priority, index]));
    const matched = this.entries
      .filter(
        (entry) =>
          entry.targetRequestId === requestId &&
          priorityOrder.has(entry.priority) &&
          entry.inputId !== excludedInputId &&
          this.committedInputIds.has(entry.inputId) &&
          !this.claimedInputIds.has(entry.inputId),
      )
      .sort(
        (left, right) =>
          (priorityOrder.get(left.priority) ?? Number.MAX_SAFE_INTEGER) -
            (priorityOrder.get(right.priority) ?? Number.MAX_SAFE_INTEGER) ||
          left.acceptedAt - right.acceptedAt,
      );

    for (const entry of matched) {
      this.claimedInputIds.add(entry.inputId);
    }
    return matched.map(cloneEntry);
  }

  acknowledge(inputId: InputId): PendingSessionInput | undefined {
    this.claimedInputIds.delete(inputId);
    return this.remove(inputId);
  }

  releaseClaim(inputId: InputId): void {
    this.claimedInputIds.delete(inputId);
  }

  claimForCancellation(inputId: InputId): PendingSessionInput | undefined {
    if (this.claimedInputIds.has(inputId)) {
      return undefined;
    }
    const entry = this.entries.find((candidate) => candidate.inputId === inputId);
    if (!entry) {
      return undefined;
    }
    this.claimedInputIds.add(inputId);
    return cloneEntry(entry);
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
    this.claimedInputIds.delete(inputId);
    this.committedInputIds.delete(inputId);
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
      this.claimedInputIds.delete(entry.inputId);
    }
  }

  retargetLater(inputId: InputId): PendingSessionInput | undefined {
    const entry = this.entries.find((candidate) => candidate.inputId === inputId);
    if (!entry) {
      return undefined;
    }
    entry.priority = InputPriority.LATER;
    entry.targetRequestId = undefined;
    this.claimedInputIds.delete(inputId);
    return cloneEntry(entry);
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
    content:
      typeof entry.content === 'string' ? entry.content : entry.content.map(cloneContentPart),
  };
}

function getRetainedBytes(content: UserMessageContent): number {
  return new TextEncoder().encode(JSON.stringify(content)).byteLength;
}
