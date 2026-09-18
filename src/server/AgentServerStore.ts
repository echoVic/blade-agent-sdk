import { nanoid } from 'nanoid';
import type {
  AgentCommandResult,
  AgentEventPage,
  AgentServerEvent,
  AgentSessionDescriptor,
} from '../protocol/index.js';
import { AGENT_PROTOCOL_VERSION } from '../protocol/index.js';
import {
  CommandId,
  EventId,
  EventSequence,
  ExecutionLeaseId,
  SessionId,
} from '../types/identifiers.js';
import type { JsonObject } from '../types/json.js';
import { RuntimeStoreError } from './RuntimeStore.js';

export interface AgentServerSessionRecord extends AgentSessionDescriptor {
  readonly tenantId: string;
  readonly createdBy: string;
}

export type AgentCommandClaim =
  | {
      readonly status: 'claimed';
      readonly leaseId: ExecutionLeaseId;
    }
  | {
      readonly status: 'completed';
      readonly result: AgentCommandResult;
    }
  | {
      readonly status: 'in_progress';
      readonly retryAfterMs: number;
    }
  /**
   * A command sealed before crossing a side-effect boundary was abandoned instead
   * of completed, so the same `commandId` must never re-execute it. This is the
   * terminal escape hatch from `in_progress`: without it a command whose process
   * died after sealing stays unanswered forever.
   */
  | {
      readonly status: 'abandoned';
      readonly reason: string;
    }
  | {
      readonly status: 'conflict';
    };

export interface AgentServerStore {
  healthCheck(): Promise<{ readonly ready: boolean; readonly details?: JsonObject }>;
  claimCommand(
    tenantId: string,
    commandId: CommandId,
    commandFingerprint: string,
    ttlMs: number,
  ): Promise<AgentCommandClaim>;
  /**
   * Makes a claimed command non-expiring before it crosses a side-effect
   * boundary. A failed completion then remains fail-closed instead of replaying.
   */
  sealCommand(tenantId: string, commandId: CommandId, leaseId: ExecutionLeaseId): Promise<void>;
  completeCommand(
    tenantId: string,
    commandId: CommandId,
    leaseId: ExecutionLeaseId,
    result: AgentCommandResult,
  ): Promise<void>;
  releaseCommand(tenantId: string, commandId: CommandId, leaseId: ExecutionLeaseId): Promise<void>;
  /**
   * Resolve a sealed command that will never complete. Callers must be certain the
   * side effect is not going to be reported later, because the resolution is
   * terminal: the command can no longer be claimed or completed.
   */
  abandonCommand(tenantId: string, commandId: CommandId, reason: string): Promise<boolean>;
  putSession(record: AgentServerSessionRecord): Promise<void>;
  getSession(tenantId: string, sessionId: SessionId): Promise<AgentServerSessionRecord | null>;
  listSessions(
    tenantId: string,
    options?: { cursor?: string; limit?: number },
  ): Promise<{ sessions: AgentServerSessionRecord[]; nextCursor?: string }>;
  /**
   * Append one Session event to the `agent` stream.
   *
   * With `options.idempotencyKey`, the append is idempotent at the storage level:
   * a second call with the same key stores nothing and returns the event the first
   * call stored. That is what lets a Worker and a reconciler publish the same
   * terminal result without a read-then-append race and without scanning the log.
   *
   * The key's record is kept for the Session's lifetime and is therefore *not*
   * trimmed with the event log: a repeat after retention has dropped the original
   * event must still be recognised, or a retry that outlives the retention window
   * would publish the result a second time.
   */
  appendEvent(
    tenantId: string,
    sessionId: SessionId,
    event: Omit<AgentServerEvent, 'eventId' | 'sequence'>,
    options?: { readonly idempotencyKey?: string },
  ): Promise<AgentServerEvent>;
  /**
   * The event stored under an idempotency key, or null when nothing was appended
   * with it. An indexed lookup that survives event retention, so a reconciler can
   * report whether it published a terminal result without scanning the log.
   */
  getEventByIdempotencyKey?(
    tenantId: string,
    sessionId: SessionId,
    idempotencyKey: string,
  ): Promise<AgentServerEvent | null>;
  readEvents(
    tenantId: string,
    sessionId: SessionId,
    options?: { after?: number; limit?: number },
  ): Promise<AgentEventPage>;
  /**
   * The highest committed event sequence for a Session, or null when the log is
   * empty. A recovery snapshot reads this *before* loading the session state, so
   * the cursor it reports can never be ahead of the messages in that snapshot.
   */
  getLatestEventSequence?(tenantId: string, sessionId: SessionId): Promise<number | null>;
  /**
   * The sequence range a Session's event log still retains. A recovery cursor has
   * to be clamped into this range: below it the client would be told to replay
   * events that no longer exist, and above it the cursor would skip events.
   */
  getEventStreamRange?(
    tenantId: string,
    sessionId: SessionId,
  ): Promise<{ readonly firstSequence: number; readonly headSequence: number } | null>;
  waitForEvents?(
    tenantId: string,
    sessionId: SessionId,
    after: number,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface CommandLeaseSnapshot {
  readonly leaseId: ExecutionLeaseId;
  readonly commandFingerprint: string;
  /** Milliseconds since the epoch, or null for a lease that never expires. */
  readonly expiresAt: number | null;
  readonly sealed: boolean;
  readonly result?: AgentCommandResult;
  readonly abandonReason?: string;
}

/**
 * One durable state change. A journal receives these in commit order and a
 * restore replays them in the same order; `event_key` only appears in snapshots,
 * for idempotency records whose event has already left the retained log.
 */
export type AgentServerStoreJournalEntry =
  | { readonly kind: 'session'; readonly record: AgentServerSessionRecord }
  | {
      readonly kind: 'event';
      readonly tenantId: string;
      readonly sessionId: SessionId;
      readonly event: AgentServerEvent;
      readonly idempotencyKey?: string;
    }
  | {
      readonly kind: 'event_key';
      readonly tenantId: string;
      readonly sessionId: SessionId;
      readonly idempotencyKey: string;
      readonly event: AgentServerEvent;
    }
  | {
      readonly kind: 'lease';
      readonly tenantId: string;
      readonly commandId: CommandId;
      readonly lease: CommandLeaseSnapshot | null;
    };

export interface AgentServerStoreJournal {
  append(entry: AgentServerStoreJournalEntry): Promise<void>;
}

interface CommandLease {
  leaseId: ExecutionLeaseId;
  commandFingerprint: string;
  expiresAt: number;
  sealed: boolean;
  result?: AgentCommandResult;
  abandonReason?: string;
}

interface EventLog {
  firstSequence: number;
  nextSequence: number;
  events: AgentServerEvent[];
  waiters: Set<() => void>;
}

function scopedKey(tenantId: string, id: string): string {
  return JSON.stringify([tenantId, id]);
}

function parseScopedKey(key: string): { tenantId: string; id: string } {
  const [tenantId, id] = JSON.parse(key) as [string, string];
  return { tenantId, id };
}

function toLeaseSnapshot(lease: CommandLease): CommandLeaseSnapshot {
  return {
    leaseId: lease.leaseId,
    commandFingerprint: lease.commandFingerprint,
    expiresAt: Number.isFinite(lease.expiresAt) ? lease.expiresAt : null,
    sealed: lease.sealed,
    ...(lease.result ? { result: structuredClone(lease.result) } : {}),
    ...(lease.abandonReason ? { abandonReason: lease.abandonReason } : {}),
  };
}

function fromLeaseSnapshot(snapshot: CommandLeaseSnapshot): CommandLease {
  return {
    leaseId: snapshot.leaseId,
    commandFingerprint: snapshot.commandFingerprint,
    expiresAt: snapshot.expiresAt ?? Number.POSITIVE_INFINITY,
    sealed: snapshot.sealed,
    ...(snapshot.result ? { result: structuredClone(snapshot.result) } : {}),
    ...(snapshot.abandonReason ? { abandonReason: snapshot.abandonReason } : {}),
  };
}

export interface InMemoryAgentServerStoreOptions {
  maxEventsPerSession?: number;
  now?: () => number;
  /**
   * Receives every committed change after it is applied in memory and before the
   * mutating call resolves. A rejected append marks the store failed: further
   * mutations reject with `RUNTIME_STORE_JOURNAL_FAILED` and `healthCheck()`
   * reports not ready, so memory can never run ahead of the journal by more than
   * the one write that was reported as failed.
   */
  journal?: AgentServerStoreJournal;
}

/**
 * Process-local reference implementation. Production deployments with more
 * than one server instance should provide a shared implementation.
 */
export class InMemoryAgentServerStore implements AgentServerStore {
  private readonly commandLeases = new Map<string, CommandLease>();
  private readonly sessions = new Map<string, AgentServerSessionRecord>();
  private readonly eventLogs = new Map<string, EventLog>();
  private readonly maxEventsPerSession: number;
  /**
   * Idempotency records, kept outside the (trimmable) event logs so a retry that
   * outlives retention is still recognised.
   */
  private readonly eventKeys = new Map<string, Map<string, AgentServerEvent>>();
  private readonly now: () => number;
  private readonly journal: AgentServerStoreJournal | undefined;
  private journalFailure: unknown;

  constructor(options: InMemoryAgentServerStoreOptions = {}) {
    this.maxEventsPerSession = options.maxEventsPerSession ?? 1000;
    this.now = options.now ?? Date.now;
    this.journal = options.journal;
    if (!Number.isSafeInteger(this.maxEventsPerSession) || this.maxEventsPerSession < 1) {
      throw new RangeError('maxEventsPerSession must be a positive safe integer');
    }
  }

  async healthCheck(): Promise<{ ready: boolean; details?: JsonObject }> {
    return this.journalFailure === undefined
      ? { ready: true }
      : { ready: false, details: { reason: 'journal write failed' } };
  }

  /**
   * Load previously journaled entries. Only valid on a store without state, so a
   * restart can never mix a replay with live writes.
   */
  restore(entries: Iterable<AgentServerStoreJournalEntry>): void {
    if (
      this.sessions.size > 0 ||
      this.eventLogs.size > 0 ||
      this.commandLeases.size > 0 ||
      this.eventKeys.size > 0
    ) {
      throw new Error('restore() requires an empty store');
    }
    for (const entry of entries) {
      switch (entry.kind) {
        case 'session':
          this.sessions.set(
            scopedKey(entry.record.tenantId, entry.record.sessionId),
            structuredClone(entry.record),
          );
          break;
        case 'event':
          this.restoreEvent(entry.tenantId, entry.sessionId, entry.event, entry.idempotencyKey);
          break;
        case 'event_key':
          this.rememberEventKey(
            scopedKey(entry.tenantId, entry.sessionId),
            entry.idempotencyKey,
            entry.event,
          );
          break;
        case 'lease': {
          const key = scopedKey(entry.tenantId, entry.commandId);
          if (entry.lease) {
            this.commandLeases.set(key, fromLeaseSnapshot(entry.lease));
          } else {
            this.commandLeases.delete(key);
          }
          break;
        }
      }
    }
  }

  /** Every entry needed to rebuild the current state with `restore()`. */
  snapshot(): AgentServerStoreJournalEntry[] {
    const entries: AgentServerStoreJournalEntry[] = [];
    for (const record of this.sessions.values()) {
      entries.push({ kind: 'session', record: structuredClone(record) });
    }
    const scopes = new Set([...this.eventLogs.keys(), ...this.eventKeys.keys()]);
    for (const key of scopes) {
      const { tenantId, id } = parseScopedKey(key);
      const sessionId = SessionId(id);
      const keys = this.eventKeys.get(key) ?? new Map<string, AgentServerEvent>();
      const keyByEventId = new Map(
        [...keys].map(([idempotencyKey, event]) => [event.eventId, idempotencyKey] as const),
      );
      const retained = new Set<string>();
      for (const event of this.eventLogs.get(key)?.events ?? []) {
        retained.add(event.eventId);
        const idempotencyKey = keyByEventId.get(event.eventId);
        entries.push({
          kind: 'event',
          tenantId,
          sessionId,
          event: structuredClone(event),
          ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        });
      }
      for (const [idempotencyKey, event] of keys) {
        if (!retained.has(event.eventId)) {
          entries.push({
            kind: 'event_key',
            tenantId,
            sessionId,
            idempotencyKey,
            event: structuredClone(event),
          });
        }
      }
    }
    for (const [key, lease] of this.commandLeases) {
      const { tenantId, id } = parseScopedKey(key);
      entries.push({
        kind: 'lease',
        tenantId,
        commandId: CommandId(id),
        lease: toLeaseSnapshot(lease),
      });
    }
    return entries;
  }

  async claimCommand(
    tenantId: string,
    commandId: CommandId,
    commandFingerprint: string,
    ttlMs: number,
  ): Promise<AgentCommandClaim> {
    this.assertWritable();
    const key = scopedKey(tenantId, commandId);
    const existing = this.commandLeases.get(key);
    const now = this.now();
    if (existing && existing.commandFingerprint !== commandFingerprint) {
      return { status: 'conflict' };
    }
    if (existing?.result) {
      return { status: 'completed', result: structuredClone(existing.result) };
    }
    if (existing?.abandonReason) {
      return { status: 'abandoned', reason: existing.abandonReason };
    }
    if (existing && existing.expiresAt > now) {
      return {
        status: 'in_progress',
        retryAfterMs: Number.isFinite(existing.expiresAt)
          ? Math.max(1, existing.expiresAt - now)
          : 1000,
      };
    }

    const leaseId = ExecutionLeaseId(nanoid());
    this.commandLeases.set(key, {
      leaseId,
      commandFingerprint,
      expiresAt: now + ttlMs,
      sealed: false,
    });
    await this.recordLease(tenantId, commandId);
    return { status: 'claimed', leaseId };
  }

  async completeCommand(
    tenantId: string,
    commandId: CommandId,
    leaseId: ExecutionLeaseId,
    result: AgentCommandResult,
  ): Promise<void> {
    this.assertWritable();
    const key = scopedKey(tenantId, commandId);
    const current = this.commandLeases.get(key);
    if (!current || current.leaseId !== leaseId) {
      throw new Error(`Command lease ${commandId}/${leaseId} is no longer active`);
    }
    this.commandLeases.set(key, {
      ...current,
      expiresAt: Number.POSITIVE_INFINITY,
      sealed: true,
      result: structuredClone(result),
    });
    await this.recordLease(tenantId, commandId);
  }

  async sealCommand(
    tenantId: string,
    commandId: CommandId,
    leaseId: ExecutionLeaseId,
  ): Promise<void> {
    this.assertWritable();
    const key = scopedKey(tenantId, commandId);
    const current = this.commandLeases.get(key);
    if (!current || current.leaseId !== leaseId || current.result) {
      throw new Error(`Command lease ${commandId}/${leaseId} is no longer active`);
    }
    current.expiresAt = Number.POSITIVE_INFINITY;
    current.sealed = true;
    await this.recordLease(tenantId, commandId);
  }

  async releaseCommand(
    tenantId: string,
    commandId: CommandId,
    leaseId: ExecutionLeaseId,
  ): Promise<void> {
    this.assertWritable();
    const key = scopedKey(tenantId, commandId);
    const current = this.commandLeases.get(key);
    if (current?.leaseId === leaseId && !current.sealed && !current.result) {
      this.commandLeases.delete(key);
      await this.recordLease(tenantId, commandId);
    }
  }

  async abandonCommand(tenantId: string, commandId: CommandId, reason: string): Promise<boolean> {
    if (!reason.trim()) {
      throw new RangeError('An abandoned command requires a reason');
    }
    this.assertWritable();
    const key = scopedKey(tenantId, commandId);
    const current = this.commandLeases.get(key);
    // Already abandoned: report "nothing changed" so repeated sweeps are no-ops and
    // the first reason stays the recorded one.
    if (!current?.sealed || current.result || current.abandonReason) {
      return false;
    }
    this.commandLeases.set(key, { ...current, abandonReason: reason });
    await this.recordLease(tenantId, commandId);
    return true;
  }

  async putSession(record: AgentServerSessionRecord): Promise<void> {
    this.assertWritable();
    this.sessions.set(scopedKey(record.tenantId, record.sessionId), structuredClone(record));
    await this.record({ kind: 'session', record: structuredClone(record) });
  }

  async getSession(
    tenantId: string,
    sessionId: SessionId,
  ): Promise<AgentServerSessionRecord | null> {
    const record = this.sessions.get(scopedKey(tenantId, sessionId));
    return record ? structuredClone(record) : null;
  }

  async listSessions(
    tenantId: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<{ sessions: AgentServerSessionRecord[]; nextCursor?: string }> {
    const limit = options.limit ?? 50;
    const offset = options.cursor ? Number.parseInt(options.cursor, 10) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new RangeError('Session list cursor is invalid');
    }
    const sessions = Array.from(this.sessions.values())
      .filter((record) => record.tenantId === tenantId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const page = sessions.slice(offset, offset + limit).map((record) => structuredClone(record));
    const nextOffset = offset + page.length;
    return {
      sessions: page,
      ...(nextOffset < sessions.length ? { nextCursor: String(nextOffset) } : {}),
    };
  }

  async appendEvent(
    tenantId: string,
    sessionId: SessionId,
    event: Omit<AgentServerEvent, 'eventId' | 'sequence'>,
    options: { readonly idempotencyKey?: string } = {},
  ): Promise<AgentServerEvent> {
    if (event.sessionId !== sessionId) {
      throw new RangeError('Event Session does not match the target event log');
    }
    this.assertWritable();
    const key = scopedKey(tenantId, sessionId);
    const log = this.getOrCreateEventLog(key);
    if (options.idempotencyKey !== undefined) {
      // Checked synchronously and without awaiting anything: an `await` here would
      // yield between the check and the write, letting a concurrent append with the
      // same key pass its own check and store a second event.
      const existing = this.readIdempotencyRecord(key, options.idempotencyKey);
      if (existing) {
        return existing;
      }
    }
    const stored = {
      ...event,
      protocolVersion: AGENT_PROTOCOL_VERSION,
      eventId: EventId(nanoid()),
      sequence: EventSequence(log.nextSequence++),
    } as AgentServerEvent;
    if (options.idempotencyKey !== undefined) {
      // Deep copy at the write boundary: the log stores a clone, and the key record
      // must be isolated from the caller's object in the same way, or a later
      // mutation of `event.data` would change one and not the other.
      this.rememberEventKey(key, options.idempotencyKey, stored);
    }
    this.appendToLog(log, stored);
    try {
      await this.record({
        kind: 'event',
        tenantId,
        sessionId,
        event: structuredClone(stored),
        ...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
      });
    } finally {
      for (const wake of log.waiters) {
        wake();
      }
      log.waiters.clear();
    }
    return structuredClone(stored);
  }

  /** Test hook: drop retained events without touching the idempotency records. */
  async trimAgentEventsForTesting(tenantId: string, sessionId: SessionId): Promise<void> {
    this.eventLogs.delete(scopedKey(tenantId, sessionId));
  }

  async getEventStreamRange(
    tenantId: string,
    sessionId: SessionId,
  ): Promise<{ firstSequence: number; headSequence: number } | null> {
    const log = this.eventLogs.get(scopedKey(tenantId, sessionId));
    if (!log || log.nextSequence <= log.firstSequence) {
      return null;
    }
    return { firstSequence: log.firstSequence, headSequence: log.nextSequence - 1 };
  }

  async getEventByIdempotencyKey(
    tenantId: string,
    sessionId: SessionId,
    idempotencyKey: string,
  ): Promise<AgentServerEvent | null> {
    return this.readIdempotencyRecord(scopedKey(tenantId, sessionId), idempotencyKey);
  }

  private readIdempotencyRecord(key: string, idempotencyKey: string): AgentServerEvent | null {
    const existing = this.eventKeys.get(key)?.get(idempotencyKey);
    return existing ? structuredClone(existing) : null;
  }

  async readEvents(
    tenantId: string,
    sessionId: SessionId,
    options: { after?: number; limit?: number } = {},
  ): Promise<AgentEventPage> {
    const after = options.after ?? 0;
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new RangeError('Event cursor is invalid');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new RangeError('Event page limit must be between 1 and 1000');
    }
    const log = this.eventLogs.get(scopedKey(tenantId, sessionId));
    if (!log) {
      if (after > 0) {
        throw new RangeError('Event cursor is ahead of the session head');
      }
      return {
        events: [],
        nextCursor: null,
        hasMore: false,
      };
    }
    if (after < log.firstSequence - 1) {
      throw new RangeError('Event cursor is stale');
    }
    if (after >= log.nextSequence) {
      throw new RangeError('Event cursor is ahead of the session head');
    }

    const events = log.events
      .filter((event) => event.sequence > after)
      .slice(0, limit)
      .map((event) => structuredClone(event));
    const last = events.at(-1);
    return {
      events,
      nextCursor: last
        ? {
            protocolVersion: AGENT_PROTOCOL_VERSION,
            sessionId,
            sequence: last.sequence,
            eventId: last.eventId,
          }
        : null,
      hasMore: last !== undefined && log.events.some((event) => event.sequence > last.sequence),
    };
  }

  async getLatestEventSequence(tenantId: string, sessionId: SessionId): Promise<number | null> {
    const log = this.eventLogs.get(scopedKey(tenantId, sessionId));
    if (!log || log.events.length === 0) {
      return null;
    }
    return log.nextSequence - 1;
  }

  async waitForEvents(
    tenantId: string,
    sessionId: SessionId,
    after: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const log = this.getOrCreateEventLog(scopedKey(tenantId, sessionId));
    if (log.events.some((event) => event.sequence > after) || signal?.aborted) {
      return;
    }
    await new Promise<void>((resolve) => {
      const wake = () => {
        signal?.removeEventListener('abort', wake);
        log.waiters.delete(wake);
        resolve();
      };
      log.waiters.add(wake);
      signal?.addEventListener('abort', wake, { once: true });
    });
  }

  private assertWritable(): void {
    if (this.journalFailure !== undefined) {
      throw new RuntimeStoreError(
        'RUNTIME_STORE_JOURNAL_FAILED',
        'The store journal failed earlier; restart the process to replay the journal',
        { cause: this.journalFailure },
      );
    }
  }

  private async record(entry: AgentServerStoreJournalEntry): Promise<void> {
    if (!this.journal) {
      return;
    }
    try {
      await this.journal.append(entry);
    } catch (error) {
      this.journalFailure = error;
      throw error;
    }
  }

  private recordLease(tenantId: string, commandId: CommandId): Promise<void> {
    const lease = this.commandLeases.get(scopedKey(tenantId, commandId));
    return this.record({
      kind: 'lease',
      tenantId,
      commandId,
      lease: lease ? toLeaseSnapshot(lease) : null,
    });
  }

  private rememberEventKey(key: string, idempotencyKey: string, event: AgentServerEvent): void {
    const keys = this.eventKeys.get(key) ?? new Map<string, AgentServerEvent>();
    keys.set(idempotencyKey, structuredClone(event));
    this.eventKeys.set(key, keys);
  }

  private restoreEvent(
    tenantId: string,
    sessionId: SessionId,
    event: AgentServerEvent,
    idempotencyKey?: string,
  ): void {
    const key = scopedKey(tenantId, sessionId);
    const log = this.getOrCreateEventLog(key);
    if (event.sequence < log.nextSequence) {
      throw new RangeError(`Journal event ${event.eventId} is out of order for ${sessionId}`);
    }
    if (log.events.length === 0) {
      log.firstSequence = event.sequence;
    }
    log.nextSequence = event.sequence + 1;
    if (idempotencyKey !== undefined) {
      this.rememberEventKey(key, idempotencyKey, event);
    }
    this.appendToLog(log, event);
  }

  private appendToLog(log: EventLog, event: AgentServerEvent): void {
    log.events.push(structuredClone(event));
    if (log.events.length > this.maxEventsPerSession) {
      const removeCount = log.events.length - this.maxEventsPerSession;
      log.events.splice(0, removeCount);
      log.firstSequence += removeCount;
    }
  }

  private getOrCreateEventLog(key: string): EventLog {
    const existing = this.eventLogs.get(key);
    if (existing) {
      return existing;
    }
    const created: EventLog = {
      firstSequence: 1,
      nextSequence: 1,
      events: [],
      waiters: new Set(),
    };
    this.eventLogs.set(key, created);
    return created;
  }
}
