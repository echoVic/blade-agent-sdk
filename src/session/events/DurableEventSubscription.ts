import { AbortError } from '../../errors/AbortError.js';
import { SdkError } from '../../errors/SdkError.js';
import { EventId, EventSequence, type SessionId } from '../../types/branded.js';
import {
  type DurableEventStore,
  type DurableEventStoreOperation,
  DurableEventStoreTimeoutError,
} from './DurableEventStore.js';
import {
  awaitDurableStoreOperation,
  resolveDurableStoreTimeoutMs,
} from './DurableStoreOperation.js';
import { parseDurableEventEnvelope } from './schemas.js';
import { type DurableEventEnvelope, type DurableEventPage, DurableEventType } from './types.js';

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const MAX_POLL_INTERVAL_MS = 60_000;
const SUBSCRIPTION_CLOSED = Symbol('durable-event-subscription-closed');

export const DURABLE_EVENT_CURSOR_VERSION = 1 as const;

export interface DurableEventCursor {
  readonly version: typeof DURABLE_EVENT_CURSOR_VERSION;
  readonly sessionId: SessionId;
  readonly sequence: EventSequence;
  readonly eventId: EventId;
}

export interface DurableEventSubscriptionOptions {
  /** Exclusive cursor. Omit to replay from the beginning. */
  readonly after?: DurableEventCursor | null;
  /** Maximum number of events buffered from one Store read. */
  readonly pageSize?: number;
  /** Delay between empty reads while following live events. */
  readonly pollIntervalMs?: number;
  /** Stop after replay reaches the head captured when the subscription opens. */
  readonly follow?: boolean;
  /** Maximum wall-clock duration of one Store call. Defaults to 15000ms. */
  readonly storeTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type DurableEventSubscriptionMessage =
  | {
      readonly type: 'event';
      readonly event: DurableEventEnvelope;
      readonly cursor: DurableEventCursor;
      readonly phase: 'replay' | 'live';
    }
  | {
      readonly type: 'caught_up';
      readonly cursor: DurableEventCursor | null;
      readonly headSequence: EventSequence | null;
    };

export type DurableEventSubscriptionErrorCode =
  | 'DURABLE_EVENT_SUBSCRIPTION_INVALID_CURSOR'
  | 'DURABLE_EVENT_SUBSCRIPTION_INVALID_OPTIONS'
  | 'DURABLE_EVENT_SUBSCRIPTION_INVALID_PAGE'
  | 'DURABLE_EVENT_SUBSCRIPTION_NOT_CONFIGURED'
  | 'DURABLE_EVENT_SUBSCRIPTION_STALE_CURSOR';

export class DurableEventSubscriptionError extends SdkError {
  // biome-ignore lint/complexity/noUselessConstructor: narrows the public error-code contract
  constructor(
    code: DurableEventSubscriptionErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(code, message, options);
  }
}

/** Creates a reconnect cursor for an event after the consumer has processed it. */
export function durableEventCursor(event: DurableEventEnvelope): DurableEventCursor {
  return {
    version: DURABLE_EVENT_CURSOR_VERSION,
    sessionId: event.sessionId,
    sequence: event.sequence,
    eventId: event.eventId,
  };
}

/** Parses an untrusted serialized cursor using the strict wire contract. */
export function parseDurableEventCursor(value: unknown): DurableEventCursor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DurableEventSubscriptionError(
      'DURABLE_EVENT_SUBSCRIPTION_INVALID_CURSOR',
      'A durable event cursor must be an object',
    );
  }
  const cursor = value as Record<string, unknown>;
  const keys = Object.keys(cursor).sort();
  if (
    keys.length !== 4 ||
    keys[0] !== 'eventId' ||
    keys[1] !== 'sequence' ||
    keys[2] !== 'sessionId' ||
    keys[3] !== 'version' ||
    cursor.version !== DURABLE_EVENT_CURSOR_VERSION ||
    typeof cursor.sessionId !== 'string' ||
    cursor.sessionId.length === 0 ||
    !Number.isSafeInteger(cursor.sequence) ||
    (cursor.sequence as number) <= 0 ||
    typeof cursor.eventId !== 'string' ||
    cursor.eventId.length === 0
  ) {
    throw new DurableEventSubscriptionError(
      'DURABLE_EVENT_SUBSCRIPTION_INVALID_CURSOR',
      'Durable event cursor fields are invalid',
    );
  }
  return {
    version: DURABLE_EVENT_CURSOR_VERSION,
    sessionId: cursor.sessionId as SessionId,
    sequence: EventSequence(cursor.sequence as number),
    eventId: EventId(cursor.eventId),
  };
}

function abortError(signal: AbortSignal): AbortError {
  return new AbortError('Durable event subscription aborted', {
    cause: signal.reason,
  });
}

/**
 * Pull-based durable event stream with replay and reconnect semantics.
 *
 * The subscription only reads another page when the consumer requests another
 * item, so Store reads and memory use remain bounded by pageSize.
 */
export class DurableEventSubscription
  implements AsyncIterableIterator<DurableEventSubscriptionMessage>, AsyncDisposable
{
  private readonly pageSize: number;
  private readonly pollIntervalMs: number;
  private readonly follow: boolean;
  private readonly storeTimeoutMs: number;
  private readonly signal: AbortSignal | undefined;
  private readonly closeController = new AbortController();
  private readonly storeSignal: AbortSignal;
  private readonly replayHead: EventSequence | null;
  private cursor: DurableEventCursor | null;
  private headSequence: EventSequence | null;
  private readonly buffer: DurableEventEnvelope[] = [];
  private operationTail: Promise<void> = Promise.resolve();
  private wakeWaiter: (() => void) | null = null;
  private caughtUp = false;
  private terminalSeen = false;
  private closed = false;

  private constructor(
    private readonly store: DurableEventStore,
    readonly sessionId: SessionId,
    options: Required<
      Pick<
        DurableEventSubscriptionOptions,
        'pageSize' | 'pollIntervalMs' | 'follow' | 'storeTimeoutMs'
      >
    > &
      Pick<DurableEventSubscriptionOptions, 'signal'>,
    cursor: DurableEventCursor | null,
    replayHead: EventSequence | null,
    terminalSeen: boolean,
  ) {
    this.pageSize = options.pageSize;
    this.pollIntervalMs = options.pollIntervalMs;
    this.follow = options.follow;
    this.storeTimeoutMs = options.storeTimeoutMs;
    this.signal = options.signal;
    this.storeSignal = options.signal
      ? AbortSignal.any([options.signal, this.closeController.signal])
      : this.closeController.signal;
    this.cursor = cursor;
    this.replayHead = replayHead;
    this.headSequence = replayHead;
    this.terminalSeen = terminalSeen;
  }

  /** Opens a subscription and validates its reconnect cursor against canonical storage. */
  static async open(
    store: DurableEventStore,
    sessionId: SessionId,
    options: DurableEventSubscriptionOptions = {},
  ): Promise<DurableEventSubscription> {
    const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    let storeTimeoutMs: number;
    try {
      storeTimeoutMs = resolveDurableStoreTimeoutMs(
        options.storeTimeoutMs,
        undefined,
        'DurableEventSubscription storeTimeoutMs',
      );
    } catch (cause) {
      throw new DurableEventSubscriptionError(
        'DURABLE_EVENT_SUBSCRIPTION_INVALID_OPTIONS',
        'Durable event subscription storeTimeoutMs is invalid',
        { cause },
      );
    }
    if (!Number.isSafeInteger(pageSize) || pageSize <= 0 || pageSize > MAX_PAGE_SIZE) {
      throw new DurableEventSubscriptionError(
        'DURABLE_EVENT_SUBSCRIPTION_INVALID_OPTIONS',
        `Durable event subscription pageSize must be between 1 and ${MAX_PAGE_SIZE}`,
      );
    }
    if (
      !Number.isSafeInteger(pollIntervalMs) ||
      pollIntervalMs <= 0 ||
      pollIntervalMs > MAX_POLL_INTERVAL_MS
    ) {
      throw new DurableEventSubscriptionError(
        'DURABLE_EVENT_SUBSCRIPTION_INVALID_OPTIONS',
        `Durable event subscription pollIntervalMs must be between 1 and ${MAX_POLL_INTERVAL_MS}`,
      );
    }
    if (options.signal?.aborted) {
      throw abortError(options.signal);
    }

    const cursor = options.after ? parseDurableEventCursor(options.after) : null;
    if (cursor && cursor.sessionId !== sessionId) {
      throw new DurableEventSubscriptionError(
        'DURABLE_EVENT_SUBSCRIPTION_INVALID_CURSOR',
        `Durable event cursor belongs to Session ${cursor.sessionId}, not ${sessionId}`,
      );
    }

    const runStoreOperation = async <T>(
      operation: DurableEventStoreOperation,
      execute: (signal: AbortSignal) => PromiseLike<T>,
    ): Promise<T> => {
      try {
        return await awaitDurableStoreOperation(
          {
            timeoutMs: storeTimeoutMs,
            signal: options.signal,
            createTimeoutError: () =>
              new DurableEventStoreTimeoutError(operation, sessionId, storeTimeoutMs),
          },
          execute,
        );
      } catch (error) {
        if (!(error instanceof DurableEventStoreTimeoutError) && options.signal?.aborted) {
          throw abortError(options.signal);
        }
        throw error;
      }
    };
    const replayHead = await runStoreOperation('get_head_sequence', (signal) =>
      store.getHeadSequence(sessionId, { signal }),
    );
    if (replayHead !== null && (!Number.isSafeInteger(replayHead) || replayHead <= 0)) {
      throw new DurableEventSubscriptionError(
        'DURABLE_EVENT_SUBSCRIPTION_INVALID_PAGE',
        `Durable Event Store returned invalid head sequence ${String(replayHead)}`,
      );
    }
    let terminalSeen = false;
    if (cursor) {
      if (replayHead === null || cursor.sequence > replayHead) {
        throw new DurableEventSubscriptionError(
          'DURABLE_EVENT_SUBSCRIPTION_STALE_CURSOR',
          `Durable event cursor ${cursor.sequence} is ahead of Session head ${String(replayHead)}`,
        );
      }
      const previousSequence = Number(cursor.sequence) - 1;
      const anchor = await runStoreOperation('read', (signal) =>
        store.read(sessionId, {
          ...(previousSequence > 0 ? { after: EventSequence(previousSequence) } : {}),
          limit: 1,
          signal,
        }),
      );
      if (anchor.events.length !== 1) {
        throw new DurableEventSubscriptionError(
          'DURABLE_EVENT_SUBSCRIPTION_STALE_CURSOR',
          `Durable event cursor ${cursor.sequence} could not be resolved uniquely`,
        );
      }
      let event: DurableEventEnvelope | undefined;
      try {
        event = anchor.events[0] ? parseDurableEventEnvelope(anchor.events[0]) : undefined;
      } catch (cause) {
        throw new DurableEventSubscriptionError(
          'DURABLE_EVENT_SUBSCRIPTION_STALE_CURSOR',
          `Durable event cursor ${cursor.sequence} points to an invalid event`,
          { cause },
        );
      }
      if (
        !event ||
        event.sessionId !== sessionId ||
        event.sequence !== cursor.sequence ||
        event.eventId !== cursor.eventId
      ) {
        throw new DurableEventSubscriptionError(
          'DURABLE_EVENT_SUBSCRIPTION_STALE_CURSOR',
          `Durable event cursor ${cursor.sequence} no longer matches the canonical log`,
        );
      }
      terminalSeen = event.type === DurableEventType.SESSION_CLOSED;
      if (terminalSeen && cursor.sequence !== replayHead) {
        throw new DurableEventSubscriptionError(
          'DURABLE_EVENT_SUBSCRIPTION_INVALID_PAGE',
          'Durable Event Store contains events after session_closed',
        );
      }
    }
    if (options.signal?.aborted) {
      throw abortError(options.signal);
    }

    return new DurableEventSubscription(
      store,
      sessionId,
      {
        pageSize,
        pollIntervalMs,
        follow: options.follow ?? true,
        storeTimeoutMs,
        signal: options.signal,
      },
      cursor,
      replayHead,
      terminalSeen,
    );
  }

  /** Returns the cursor for the most recently delivered event. */
  getCursor(): DurableEventCursor | null {
    return this.cursor ? { ...this.cursor } : null;
  }

  /** Returns the most recent Store head observed by this subscription. */
  getHeadSequence(): EventSequence | null {
    return this.headSequence;
  }

  /** Reports whether the subscription has reached a terminal local state. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Delivers the next event or replay barrier without prefetching beyond one page. */
  next(): Promise<IteratorResult<DurableEventSubscriptionMessage, undefined>> {
    const result = this.operationTail.then(
      () => this.nextExclusive(),
      () => this.nextExclusive(),
    );
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Stops the subscription and releases any pending wait. */
  async return(): Promise<IteratorResult<DurableEventSubscriptionMessage, undefined>> {
    this.close();
    return { done: true, value: undefined };
  }

  /** Stops the subscription and propagates the supplied consumer error. */
  async throw(
    error?: unknown,
  ): Promise<IteratorResult<DurableEventSubscriptionMessage, undefined>> {
    this.close();
    throw error;
  }

  /** Returns this stateful subscription as its own async iterator. */
  [Symbol.asyncIterator](): AsyncIterableIterator<DurableEventSubscriptionMessage> {
    return this;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.close();
  }

  /** Stops the subscription without treating cancellation as an error. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeController.abort(SUBSCRIPTION_CLOSED);
    this.buffer.length = 0;
    this.wakeWaiter?.();
    this.wakeWaiter = null;
  }

  private async nextExclusive(): Promise<
    IteratorResult<DurableEventSubscriptionMessage, undefined>
  > {
    try {
      while (true) {
        this.throwIfAborted();
        if (this.closed) {
          return { done: true, value: undefined };
        }
        const event = this.buffer.shift();
        if (event) {
          const cursor = durableEventCursor(event);
          this.cursor = cursor;
          if (event.type === DurableEventType.SESSION_CLOSED) {
            this.terminalSeen = true;
          }
          return {
            done: false,
            value: {
              type: 'event',
              event,
              cursor,
              phase:
                this.replayHead !== null && event.sequence <= this.replayHead ? 'replay' : 'live',
            },
          };
        }

        if (!this.caughtUp && this.reachedReplayHead()) {
          this.caughtUp = true;
          return {
            done: false,
            value: {
              type: 'caught_up',
              cursor: this.getCursor(),
              headSequence: this.replayHead,
            },
          };
        }
        if (this.terminalSeen || (!this.follow && this.caughtUp)) {
          this.close();
          return { done: true, value: undefined };
        }

        const page = await this.runStoreOperation('read', (signal) =>
          this.store.read(this.sessionId, {
            ...(this.cursor ? { after: this.cursor.sequence } : {}),
            limit: this.pageSize,
            signal,
          }),
        );
        this.throwIfAborted();
        if (this.closed) {
          return { done: true, value: undefined };
        }
        const events = this.validatePage(page);
        this.headSequence = page.headSequence;
        this.buffer.push(
          ...events.filter(
            (candidate) =>
              this.caughtUp || this.replayHead === null || candidate.sequence <= this.replayHead,
          ),
        );
        if (this.buffer.length > 0) {
          continue;
        }
        if (!this.caughtUp && this.reachedReplayHead()) {
          continue;
        }
        if (!this.follow) {
          this.close();
          return { done: true, value: undefined };
        }
        await this.waitForPoll();
      }
    } catch (error) {
      this.close();
      if (error === SUBSCRIPTION_CLOSED) {
        return { done: true, value: undefined };
      }
      throw error;
    }
  }

  private reachedReplayHead(): boolean {
    if (this.replayHead === null) {
      return true;
    }
    return Number(this.cursor?.sequence ?? 0) >= Number(this.replayHead);
  }

  private async runStoreOperation<T>(
    operation: DurableEventStoreOperation,
    execute: (signal: AbortSignal) => PromiseLike<T>,
  ): Promise<T> {
    try {
      return await awaitDurableStoreOperation(
        {
          timeoutMs: this.storeTimeoutMs,
          signal: this.storeSignal,
          createTimeoutError: () =>
            new DurableEventStoreTimeoutError(operation, this.sessionId, this.storeTimeoutMs),
        },
        execute,
      );
    } catch (error) {
      if (!(error instanceof DurableEventStoreTimeoutError) && this.signal?.aborted) {
        throw abortError(this.signal);
      }
      throw error;
    }
  }

  private validatePage(page: DurableEventPage): DurableEventEnvelope[] {
    const currentSequence = Number(this.cursor?.sequence ?? 0);
    const expectedFirstSequence = currentSequence + 1;
    if (
      (page.headSequence !== null &&
        (!Number.isSafeInteger(page.headSequence) || page.headSequence <= 0)) ||
      (page.nextCursor !== null && (!Number.isSafeInteger(page.nextCursor) || page.nextCursor < 0))
    ) {
      throw new DurableEventSubscriptionError(
        'DURABLE_EVENT_SUBSCRIPTION_INVALID_PAGE',
        'Durable Event Store returned invalid subscription sequence metadata',
      );
    }
    let events: DurableEventEnvelope[];
    try {
      events = page.events.map(parseDurableEventEnvelope);
    } catch (cause) {
      throw new DurableEventSubscriptionError(
        'DURABLE_EVENT_SUBSCRIPTION_INVALID_PAGE',
        'Durable Event Store returned an invalid subscription event',
        { cause },
      );
    }
    if (events.length > this.pageSize) {
      throw new DurableEventSubscriptionError(
        'DURABLE_EVENT_SUBSCRIPTION_INVALID_PAGE',
        `Durable Event Store exceeded subscription pageSize ${this.pageSize}`,
      );
    }
    const first = events[0];
    const last = events.at(-1);

    if (!first) {
      if (Number(page.headSequence ?? 0) < currentSequence) {
        throw new DurableEventSubscriptionError(
          'DURABLE_EVENT_SUBSCRIPTION_STALE_CURSOR',
          `Durable event cursor ${currentSequence} is ahead of Session head ${String(page.headSequence)}`,
        );
      }
      if (
        page.hasMore ||
        page.nextCursor !== (this.cursor?.sequence ?? null) ||
        Number(page.headSequence ?? 0) > currentSequence
      ) {
        throw new DurableEventSubscriptionError(
          'DURABLE_EVENT_SUBSCRIPTION_INVALID_PAGE',
          'Durable Event Store returned an inconsistent empty subscription page',
        );
      }
      return events;
    }

    if (first.sequence !== expectedFirstSequence) {
      throw new DurableEventSubscriptionError(
        'DURABLE_EVENT_SUBSCRIPTION_STALE_CURSOR',
        `Expected durable event sequence ${expectedFirstSequence}, received ${first.sequence}`,
      );
    }
    for (const [index, event] of events.entries()) {
      if (
        event.sessionId !== this.sessionId ||
        Number(event.sequence) !== expectedFirstSequence + index
      ) {
        throw new DurableEventSubscriptionError(
          'DURABLE_EVENT_SUBSCRIPTION_INVALID_PAGE',
          'Durable Event Store returned a non-contiguous subscription page',
        );
      }
    }
    if (
      !last ||
      page.nextCursor !== last.sequence ||
      page.headSequence === null ||
      page.headSequence < last.sequence ||
      page.hasMore !== last.sequence < page.headSequence
    ) {
      throw new DurableEventSubscriptionError(
        'DURABLE_EVENT_SUBSCRIPTION_INVALID_PAGE',
        'Durable Event Store returned inconsistent subscription cursor metadata',
      );
    }
    const closeIndex = events.findIndex((event) => event.type === DurableEventType.SESSION_CLOSED);
    if (closeIndex !== -1 && (closeIndex !== events.length - 1 || page.hasMore)) {
      throw new DurableEventSubscriptionError(
        'DURABLE_EVENT_SUBSCRIPTION_INVALID_PAGE',
        'Durable Event Store returned events after session_closed',
      );
    }
    return events;
  }

  private throwIfAborted(): void {
    if (this.signal?.aborted) {
      throw abortError(this.signal);
    }
  }

  private async waitForPoll(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.signal?.removeEventListener('abort', onAbort);
        if (this.wakeWaiter === wake) {
          this.wakeWaiter = null;
        }
        callback();
      };
      const wake = () => finish(resolve);
      const onAbort = () => finish(() => reject(abortError(this.signal as AbortSignal)));
      const timer = setTimeout(wake, this.pollIntervalMs);
      this.wakeWaiter = wake;
      this.signal?.addEventListener('abort', onAbort, { once: true });
      if (this.closed) {
        wake();
      } else if (this.signal?.aborted) {
        onAbort();
      }
    });
  }
}
