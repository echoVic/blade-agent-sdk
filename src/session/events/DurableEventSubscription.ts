import { z } from 'zod';
import { AbortError } from '../../errors/AbortError.js';
import { SdkError } from '../../errors/SdkError.js';
import { EventId, EventSequence, SessionId } from '../../types/identifiers.js';
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
  readonly after?: DurableEventCursor | null;
  readonly pageSize?: number;
  readonly pollIntervalMs?: number;
  readonly follow?: boolean;
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
  declare readonly code: DurableEventSubscriptionErrorCode;
}

const CursorSchema = z
  .object({
    version: z.literal(DURABLE_EVENT_CURSOR_VERSION),
    sessionId: z.string().min(1),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    eventId: z.string().min(1),
  })
  .strict();

export function durableEventCursor(event: DurableEventEnvelope): DurableEventCursor {
  return {
    version: DURABLE_EVENT_CURSOR_VERSION,
    sessionId: event.sessionId,
    sequence: event.sequence,
    eventId: event.eventId,
  };
}

export function parseDurableEventCursor(value: unknown): DurableEventCursor {
  const parsed = CursorSchema.safeParse(value);
  if (!parsed.success) {
    throw new DurableEventSubscriptionError(
      'DURABLE_EVENT_SUBSCRIPTION_INVALID_CURSOR',
      'Durable event cursor fields are invalid',
      { cause: parsed.error },
    );
  }
  return {
    ...parsed.data,
    sessionId: SessionId(parsed.data.sessionId),
    sequence: EventSequence(parsed.data.sequence),
    eventId: EventId(parsed.data.eventId),
  };
}

function abortError(signal: AbortSignal): AbortError {
  return new AbortError('Durable event subscription aborted', { cause: signal.reason });
}

async function runStoreOperation<T>(
  sessionId: SessionId,
  operation: DurableEventStoreOperation,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  externalSignal: AbortSignal | undefined,
  execute: (signal: AbortSignal) => PromiseLike<T>,
): Promise<T> {
  try {
    return await awaitDurableStoreOperation(
      {
        timeoutMs,
        signal,
        createTimeoutError: () =>
          new DurableEventStoreTimeoutError(operation, sessionId, timeoutMs),
      },
      execute,
    );
  } catch (error) {
    if (!(error instanceof DurableEventStoreTimeoutError) && externalSignal?.aborted) {
      throw abortError(externalSignal);
    }
    throw error;
  }
}

function integerOption(value: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new DurableEventSubscriptionError(
      'DURABLE_EVENT_SUBSCRIPTION_INVALID_OPTIONS',
      `Durable event subscription ${name} must be between 1 and ${max}`,
    );
  }
  return value;
}

interface SubscriptionConfig {
  pageSize: number;
  pollIntervalMs: number;
  follow: boolean;
  storeTimeoutMs: number;
  signal?: AbortSignal;
}

export class DurableEventSubscription
  implements AsyncIterableIterator<DurableEventSubscriptionMessage>, AsyncDisposable
{
  private readonly closeController = new AbortController();
  private readonly storeSignal: AbortSignal;
  private readonly buffer: DurableEventEnvelope[] = [];
  private tail: Promise<void> = Promise.resolve();
  private cursor: DurableEventCursor | null;
  private headSequence: EventSequence | null;
  private caughtUp = false;
  private terminalSeen: boolean;
  private closed = false;

  private constructor(
    private readonly store: DurableEventStore,
    readonly sessionId: SessionId,
    private readonly config: SubscriptionConfig,
    cursor: DurableEventCursor | null,
    private readonly replayHead: EventSequence | null,
    terminalSeen: boolean,
  ) {
    this.cursor = cursor;
    this.headSequence = replayHead;
    this.terminalSeen = terminalSeen;
    this.storeSignal = config.signal
      ? AbortSignal.any([config.signal, this.closeController.signal])
      : this.closeController.signal;
  }

  static async open(
    store: DurableEventStore,
    sessionId: SessionId,
    options: DurableEventSubscriptionOptions = {},
  ): Promise<DurableEventSubscription> {
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
    const config: SubscriptionConfig = {
      pageSize: integerOption(options.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, 'pageSize'),
      pollIntervalMs: integerOption(
        options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
        MAX_POLL_INTERVAL_MS,
        'pollIntervalMs',
      ),
      follow: options.follow ?? true,
      storeTimeoutMs,
      signal: options.signal,
    };
    if (options.signal?.aborted) throw abortError(options.signal);
    const cursor = options.after ? parseDurableEventCursor(options.after) : null;
    if (cursor && cursor.sessionId !== sessionId) {
      throw new DurableEventSubscriptionError(
        'DURABLE_EVENT_SUBSCRIPTION_INVALID_CURSOR',
        `Durable event cursor belongs to Session ${cursor.sessionId}, not ${sessionId}`,
      );
    }
    const run = <T>(
      operation: DurableEventStoreOperation,
      execute: (signal: AbortSignal) => PromiseLike<T>,
    ) =>
      runStoreOperation(
        sessionId,
        operation,
        storeTimeoutMs,
        options.signal,
        options.signal,
        execute,
      );
    const replayHead = await run('get_head_sequence', (signal) =>
      store.getHeadSequence(sessionId, { signal }),
    );
    if (replayHead !== null && (!Number.isSafeInteger(replayHead) || replayHead <= 0)) {
      throw new DurableEventSubscriptionError(
        'DURABLE_EVENT_SUBSCRIPTION_INVALID_PAGE',
        `Durable Event Store returned invalid head sequence ${String(replayHead)}`,
      );
    }
    const terminalSeen = cursor
      ? await DurableEventSubscription.validateCursor(store, sessionId, cursor, replayHead, run)
      : false;
    if (options.signal?.aborted) throw abortError(options.signal);
    return new DurableEventSubscription(store, sessionId, config, cursor, replayHead, terminalSeen);
  }

  private static async validateCursor(
    store: DurableEventStore,
    sessionId: SessionId,
    cursor: DurableEventCursor,
    head: EventSequence | null,
    run: <T>(
      operation: DurableEventStoreOperation,
      execute: (signal: AbortSignal) => PromiseLike<T>,
    ) => Promise<T>,
  ): Promise<boolean> {
    if (head === null || cursor.sequence > head) {
      throw new DurableEventSubscriptionError(
        'DURABLE_EVENT_SUBSCRIPTION_STALE_CURSOR',
        `Durable event cursor ${cursor.sequence} is ahead of Session head ${String(head)}`,
      );
    }
    const previous = Number(cursor.sequence) - 1;
    const page = await run('read', (signal) =>
      store.read(sessionId, {
        ...(previous > 0 ? { after: EventSequence(previous) } : {}),
        limit: 1,
        signal,
      }),
    );
    let event: DurableEventEnvelope | undefined;
    try {
      event = page.events[0] ? parseDurableEventEnvelope(page.events[0]) : undefined;
    } catch (cause) {
      throw new DurableEventSubscriptionError(
        'DURABLE_EVENT_SUBSCRIPTION_STALE_CURSOR',
        `Durable event cursor ${cursor.sequence} points to an invalid event`,
        { cause },
      );
    }
    if (
      page.events.length !== 1 ||
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
    const terminal = event.type === DurableEventType.SESSION_CLOSED;
    if (terminal && cursor.sequence !== head) {
      throw new DurableEventSubscriptionError(
        'DURABLE_EVENT_SUBSCRIPTION_INVALID_PAGE',
        'Durable Event Store contains events after session_closed',
      );
    }
    return terminal;
  }

  getCursor(): DurableEventCursor | null {
    return this.cursor ? { ...this.cursor } : null;
  }

  getHeadSequence(): EventSequence | null {
    return this.headSequence;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  next(): Promise<IteratorResult<DurableEventSubscriptionMessage, undefined>> {
    const result = this.tail.then(
      () => this.nextExclusive(),
      () => this.nextExclusive(),
    );
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async return(): Promise<IteratorResult<DurableEventSubscriptionMessage, undefined>> {
    this.close();
    return { done: true, value: undefined };
  }

  async throw(
    error?: unknown,
  ): Promise<IteratorResult<DurableEventSubscriptionMessage, undefined>> {
    this.close();
    throw error;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<DurableEventSubscriptionMessage> {
    return this;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.buffer.length = 0;
    this.closeController.abort(SUBSCRIPTION_CLOSED);
  }

  private async nextExclusive(): Promise<
    IteratorResult<DurableEventSubscriptionMessage, undefined>
  > {
    try {
      while (!this.closed) {
        this.throwIfAborted();
        const event = this.buffer.shift();
        if (event) return { done: false, value: this.deliver(event) };
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
        if (this.terminalSeen || (!this.config.follow && this.caughtUp)) break;
        const page = await this.readPage();
        if (this.closed) break;
        const events = this.validatePage(page);
        this.headSequence = page.headSequence;
        this.buffer.push(
          ...events.filter(
            (event) =>
              this.caughtUp || this.replayHead === null || event.sequence <= this.replayHead,
          ),
        );
        if (
          this.buffer.length === 0 &&
          (this.caughtUp || !this.reachedReplayHead()) &&
          this.config.follow
        ) {
          await this.waitForPoll();
        }
      }
      this.close();
      return { done: true, value: undefined };
    } catch (error) {
      const closed = this.closed;
      this.close();
      if (closed || error === SUBSCRIPTION_CLOSED) {
        return { done: true, value: undefined };
      }
      throw error;
    }
  }

  private deliver(event: DurableEventEnvelope): DurableEventSubscriptionMessage {
    const cursor = durableEventCursor(event);
    this.cursor = cursor;
    this.terminalSeen ||= event.type === DurableEventType.SESSION_CLOSED;
    return {
      type: 'event',
      event,
      cursor,
      phase: this.replayHead !== null && event.sequence <= this.replayHead ? 'replay' : 'live',
    };
  }

  private readPage(): Promise<DurableEventPage> {
    return runStoreOperation(
      this.sessionId,
      'read',
      this.config.storeTimeoutMs,
      this.storeSignal,
      this.config.signal,
      (signal) =>
        this.store.read(this.sessionId, {
          ...(this.cursor ? { after: this.cursor.sequence } : {}),
          limit: this.config.pageSize,
          signal,
        }),
    );
  }

  private reachedReplayHead(): boolean {
    return this.replayHead === null || Number(this.cursor?.sequence ?? 0) >= this.replayHead;
  }

  private validatePage(page: DurableEventPage): DurableEventEnvelope[] {
    const current = Number(this.cursor?.sequence ?? 0);
    if (
      (page.headSequence !== null &&
        (!Number.isSafeInteger(page.headSequence) || page.headSequence <= 0)) ||
      (page.nextCursor !== null && (!Number.isSafeInteger(page.nextCursor) || page.nextCursor < 0))
    ) {
      throw this.invalidPage('invalid subscription sequence metadata');
    }
    let events: DurableEventEnvelope[];
    try {
      events = page.events.map(parseDurableEventEnvelope);
    } catch (cause) {
      throw this.invalidPage('an invalid subscription event', cause);
    }
    if (events.length > this.config.pageSize) {
      throw this.invalidPage(`more than pageSize ${this.config.pageSize} events`);
    }
    const first = events[0];
    const last = events.at(-1);
    if (!first) {
      if (Number(page.headSequence ?? 0) < current) {
        throw new DurableEventSubscriptionError(
          'DURABLE_EVENT_SUBSCRIPTION_STALE_CURSOR',
          `Durable event cursor ${current} is ahead of Session head ${String(page.headSequence)}`,
        );
      }
      if (
        page.hasMore ||
        page.nextCursor !== (this.cursor?.sequence ?? null) ||
        Number(page.headSequence ?? 0) > current
      ) {
        throw this.invalidPage('an inconsistent empty subscription page');
      }
      return events;
    }
    if (first.sequence !== current + 1) {
      throw new DurableEventSubscriptionError(
        'DURABLE_EVENT_SUBSCRIPTION_STALE_CURSOR',
        `Expected durable event sequence ${current + 1}, received ${first.sequence}`,
      );
    }
    if (
      events.some(
        (event, index) =>
          event.sessionId !== this.sessionId || Number(event.sequence) !== current + index + 1,
      )
    ) {
      throw this.invalidPage('a non-contiguous subscription page');
    }
    if (
      !last ||
      page.nextCursor !== last.sequence ||
      page.headSequence === null ||
      page.headSequence < last.sequence ||
      page.hasMore !== last.sequence < page.headSequence
    ) {
      throw this.invalidPage('inconsistent subscription cursor metadata');
    }
    const closeIndex = events.findIndex((event) => event.type === DurableEventType.SESSION_CLOSED);
    if (closeIndex !== -1 && (closeIndex !== events.length - 1 || page.hasMore)) {
      throw this.invalidPage('events after session_closed');
    }
    return events;
  }

  private invalidPage(message: string, cause?: unknown): DurableEventSubscriptionError {
    return new DurableEventSubscriptionError(
      'DURABLE_EVENT_SUBSCRIPTION_INVALID_PAGE',
      `Durable Event Store returned ${message}`,
      cause === undefined ? undefined : { cause },
    );
  }

  private throwIfAborted(): void {
    if (this.config.signal?.aborted) throw abortError(this.config.signal);
  }

  private async waitForPoll(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error): void => {
        clearTimeout(timer);
        this.config.signal?.removeEventListener('abort', onAbort);
        this.closeController.signal.removeEventListener('abort', onClose);
        error ? reject(error) : resolve();
      };
      const onAbort = () => finish(abortError(this.config.signal as AbortSignal));
      const onClose = () => finish();
      const timer = setTimeout(onClose, this.config.pollIntervalMs);
      this.config.signal?.addEventListener('abort', onAbort, { once: true });
      this.closeController.signal.addEventListener('abort', onClose, { once: true });
      if (this.closed) onClose();
      else if (this.config.signal?.aborted) onAbort();
    });
  }
}
