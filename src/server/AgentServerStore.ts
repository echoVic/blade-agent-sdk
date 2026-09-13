import { nanoid } from 'nanoid';
import type {
  AgentCommandResult,
  AgentEventPage,
  AgentServerEvent,
  AgentSessionDescriptor,
} from '../protocol/index.js';
import { AGENT_PROTOCOL_VERSION } from '../protocol/index.js';
import {
  type CommandId,
  EventId,
  EventSequence,
  ExecutionLeaseId,
  type SessionId,
} from '../types/identifiers.js';
import type { JsonObject } from '../types/json.js';

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
   */
  appendEvent(
    tenantId: string,
    sessionId: SessionId,
    event: Omit<AgentServerEvent, 'eventId' | 'sequence'>,
    options?: { readonly idempotencyKey?: string },
  ): Promise<AgentServerEvent>;
  /**
   * The event stored under an idempotency key, or null when nothing was appended
   * with it. An indexed lookup, so a reconciler can report whether it published a
   * terminal result without scanning the log.
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
  waitForEvents?(
    tenantId: string,
    sessionId: SessionId,
    after: number,
    signal?: AbortSignal,
  ): Promise<void>;
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

export interface InMemoryAgentServerStoreOptions {
  maxEventsPerSession?: number;
  now?: () => number;
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
  private readonly now: () => number;

  constructor(options: InMemoryAgentServerStoreOptions = {}) {
    this.maxEventsPerSession = options.maxEventsPerSession ?? 1000;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.maxEventsPerSession) || this.maxEventsPerSession < 1) {
      throw new RangeError('maxEventsPerSession must be a positive safe integer');
    }
  }

  async healthCheck(): Promise<{ ready: boolean }> {
    return { ready: true };
  }

  async claimCommand(
    tenantId: string,
    commandId: CommandId,
    commandFingerprint: string,
    ttlMs: number,
  ): Promise<AgentCommandClaim> {
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
    return { status: 'claimed', leaseId };
  }

  async completeCommand(
    tenantId: string,
    commandId: CommandId,
    leaseId: ExecutionLeaseId,
    result: AgentCommandResult,
  ): Promise<void> {
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
  }

  async sealCommand(
    tenantId: string,
    commandId: CommandId,
    leaseId: ExecutionLeaseId,
  ): Promise<void> {
    const key = scopedKey(tenantId, commandId);
    const current = this.commandLeases.get(key);
    if (!current || current.leaseId !== leaseId || current.result) {
      throw new Error(`Command lease ${commandId}/${leaseId} is no longer active`);
    }
    current.expiresAt = Number.POSITIVE_INFINITY;
    current.sealed = true;
  }

  async releaseCommand(
    tenantId: string,
    commandId: CommandId,
    leaseId: ExecutionLeaseId,
  ): Promise<void> {
    const key = scopedKey(tenantId, commandId);
    const current = this.commandLeases.get(key);
    if (current?.leaseId === leaseId && !current.sealed && !current.result) {
      this.commandLeases.delete(key);
    }
  }

  async abandonCommand(tenantId: string, commandId: CommandId, reason: string): Promise<boolean> {
    if (!reason.trim()) {
      throw new RangeError('An abandoned command requires a reason');
    }
    const key = scopedKey(tenantId, commandId);
    const current = this.commandLeases.get(key);
    // Already abandoned: report "nothing changed" so repeated sweeps are no-ops and
    // the first reason stays the recorded one.
    if (!current?.sealed || current.result || current.abandonReason) {
      return false;
    }
    this.commandLeases.set(key, { ...current, abandonReason: reason });
    return true;
  }

  async putSession(record: AgentServerSessionRecord): Promise<void> {
    this.sessions.set(scopedKey(record.tenantId, record.sessionId), structuredClone(record));
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
    const key = scopedKey(tenantId, sessionId);
    const log = this.getOrCreateEventLog(key);
    if (options.idempotencyKey !== undefined) {
      const existing = log.events.find(
        (candidate) => candidate.eventId === options.idempotencyKey,
      );
      if (existing) {
        return structuredClone(existing);
      }
    }
    const stored = {
      ...event,
      protocolVersion: AGENT_PROTOCOL_VERSION,
      eventId: options.idempotencyKey === undefined
        ? EventId(nanoid())
        : EventId(options.idempotencyKey),
      sequence: EventSequence(log.nextSequence++),
    } as AgentServerEvent;
    log.events.push(structuredClone(stored));
    if (log.events.length > this.maxEventsPerSession) {
      const removeCount = log.events.length - this.maxEventsPerSession;
      log.events.splice(0, removeCount);
      log.firstSequence += removeCount;
    }
    for (const wake of log.waiters) {
      wake();
    }
    log.waiters.clear();
    return structuredClone(stored);
  }

  async getEventByIdempotencyKey(
    tenantId: string,
    sessionId: SessionId,
    idempotencyKey: string,
  ): Promise<AgentServerEvent | null> {
    const log = this.eventLogs.get(scopedKey(tenantId, sessionId));
    const existing = log?.events.find((candidate) => candidate.eventId === idempotencyKey);
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
