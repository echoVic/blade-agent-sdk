import { nanoid } from 'nanoid';
import type {
  AgentCommandResult,
  AgentEventPage,
  AgentServerEvent,
  AgentSessionDescriptor,
} from '../protocol/index.js';
import { AGENT_PROTOCOL_VERSION } from '../protocol/index.js';
import { EventId, type SessionId } from '../types/branded.js';
import type { JsonObject } from '../types/common.js';

export interface AgentServerSessionRecord extends AgentSessionDescriptor {
  readonly tenantId: string;
  readonly createdBy: string;
}

export type AgentCommandClaim =
  | {
      readonly status: 'claimed';
      readonly leaseId: string;
    }
  | {
      readonly status: 'completed';
      readonly result: AgentCommandResult;
    }
  | {
      readonly status: 'in_progress';
      readonly retryAfterMs: number;
    }
  | {
      readonly status: 'conflict';
    };

export interface AgentServerStore {
  healthCheck(): Promise<{ readonly ready: boolean; readonly details?: JsonObject }>;
  claimCommand(
    tenantId: string,
    commandId: string,
    commandFingerprint: string,
    ttlMs: number,
  ): Promise<AgentCommandClaim>;
  /**
   * Makes a claimed command non-expiring before it crosses a side-effect
   * boundary. A failed completion then remains fail-closed instead of replaying.
   */
  sealCommand(
    tenantId: string,
    commandId: string,
    leaseId: string,
  ): Promise<void>;
  completeCommand(
    tenantId: string,
    commandId: string,
    leaseId: string,
    result: AgentCommandResult,
  ): Promise<void>;
  releaseCommand(
    tenantId: string,
    commandId: string,
    leaseId: string,
  ): Promise<void>;
  putSession(record: AgentServerSessionRecord): Promise<void>;
  getSession(
    tenantId: string,
    sessionId: SessionId,
  ): Promise<AgentServerSessionRecord | null>;
  listSessions(
    tenantId: string,
    options?: { cursor?: string; limit?: number },
  ): Promise<{ sessions: AgentServerSessionRecord[]; nextCursor?: string }>;
  appendEvent(
    tenantId: string,
    sessionId: SessionId,
    event: Omit<AgentServerEvent, 'eventId' | 'sequence'>,
  ): Promise<AgentServerEvent>;
  readEvents(
    tenantId: string,
    sessionId: SessionId,
    options?: { after?: number; limit?: number },
  ): Promise<AgentEventPage>;
  waitForEvents?(
    tenantId: string,
    sessionId: SessionId,
    after: number,
    signal?: AbortSignal,
  ): Promise<void>;
}

interface CommandLease {
  leaseId: string;
  commandFingerprint: string;
  expiresAt: number;
  sealed: boolean;
  result?: AgentCommandResult;
}

interface EventLog {
  firstSequence: number;
  nextSequence: number;
  events: AgentServerEvent[];
  waiters: Set<() => void>;
}

function scopedKey(tenantId: string, id: string): string {
  return `${tenantId}\0${id}`;
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
    if (
      !Number.isSafeInteger(this.maxEventsPerSession) ||
      this.maxEventsPerSession < 1
    ) {
      throw new RangeError('maxEventsPerSession must be a positive safe integer');
    }
  }

  async healthCheck(): Promise<{ ready: boolean }> {
    return { ready: true };
  }

  async claimCommand(
    tenantId: string,
    commandId: string,
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
    if (existing && existing.expiresAt > now) {
      return {
        status: 'in_progress',
        retryAfterMs: Number.isFinite(existing.expiresAt)
          ? Math.max(1, existing.expiresAt - now)
          : 1000,
      };
    }

    const leaseId = nanoid();
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
    commandId: string,
    leaseId: string,
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
    commandId: string,
    leaseId: string,
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
    commandId: string,
    leaseId: string,
  ): Promise<void> {
    const key = scopedKey(tenantId, commandId);
    const current = this.commandLeases.get(key);
    if (current?.leaseId === leaseId && !current.sealed && !current.result) {
      this.commandLeases.delete(key);
    }
  }

  async putSession(record: AgentServerSessionRecord): Promise<void> {
    this.sessions.set(
      scopedKey(record.tenantId, record.sessionId),
      structuredClone(record),
    );
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
    const page = sessions.slice(offset, offset + limit).map((record) =>
      structuredClone(record));
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
  ): Promise<AgentServerEvent> {
    if (event.sessionId !== sessionId) {
      throw new RangeError('Event Session does not match the target event log');
    }
    const key = scopedKey(tenantId, sessionId);
    const log = this.getOrCreateEventLog(key);
    const stored = {
      ...event,
      protocolVersion: AGENT_PROTOCOL_VERSION,
      eventId: EventId(nanoid()),
      sequence: log.nextSequence++,
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
      hasMore:
        last !== undefined &&
        log.events.some((event) => event.sequence > last.sequence),
    };
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
