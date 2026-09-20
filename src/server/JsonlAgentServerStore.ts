import { existsSync } from 'node:fs';
import { type FileHandle, mkdir, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import { createRootLogger, type InternalLogger } from '../logging/Logger.js';
import type { AgentCommandResult, AgentEventPage, AgentServerEvent } from '../protocol/index.js';
import type { CommandId, ExecutionLeaseId, SessionId } from '../types/identifiers.js';
import type { JsonObject } from '../types/json.js';
import type { AgentLogger } from '../types/logging.js';
import {
  type AgentCommandClaim,
  type AgentServerSessionRecord,
  type AgentServerStore,
  type AgentServerStoreJournalEntry,
  InMemoryAgentServerStore,
} from './AgentServerStore.js';
import { RuntimeStoreError } from './RuntimeStore.js';

const JOURNAL_FILE = 'server-store.jsonl';
const LOCK_FILE = 'server-store.lock';
const JOURNAL_VERSION = 1;
const ENTRY_KINDS: ReadonlySet<string> = new Set(['session', 'event', 'event_key', 'lease']);

export interface JsonlAgentServerStoreOptions {
  /** Directory that owns `server-store.jsonl`; created when missing. */
  readonly directory: string;
  readonly maxEventsPerSession?: number;
  readonly now?: () => number;
  readonly logger?: AgentLogger;
}

type JournalLine = AgentServerStoreJournalEntry & { readonly v: number };

function serialize(entry: AgentServerStoreJournalEntry): string {
  return `${JSON.stringify({ v: JOURNAL_VERSION, ...entry })}\n`;
}

function isJournalLine(value: unknown): value is JournalLine {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { v?: unknown }).v === JOURNAL_VERSION &&
    ENTRY_KINDS.has(String((value as { kind?: unknown }).kind))
  );
}

/**
 * Single-process `AgentServerStore` that journals every change to one JSONL
 * file and replays it on start. It keeps the in-memory store's semantics
 * (idempotent appends, retention, fail-closed sealed leases) and adds restart
 * durability for one server process. Multi-instance deployments still need
 * the PostgreSQL store.
 */
export class JsonlAgentServerStore implements AgentServerStore {
  private readonly directory: string;
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly logger: InternalLogger;
  private readonly inner: InMemoryAgentServerStore;
  private handle: FileHandle | undefined;
  private lockHandle: FileHandle | undefined;
  private queue: Promise<void> = Promise.resolve();
  private state: 'new' | 'ready' | 'closed' = 'new';

  constructor(options: JsonlAgentServerStoreOptions) {
    this.directory = options.directory;
    this.filePath = join(options.directory, JOURNAL_FILE);
    this.lockPath = join(options.directory, LOCK_FILE);
    this.logger = createRootLogger(options.logger ?? null);
    this.inner = new InMemoryAgentServerStore({
      ...(options.maxEventsPerSession !== undefined
        ? { maxEventsPerSession: options.maxEventsPerSession }
        : {}),
      ...(options.now ? { now: options.now } : {}),
      journal: { append: (entry) => this.write(entry) },
    });
  }

  /**
   * Claims `server-store.lock`, replays the journal, rewrites it compacted,
   * then opens it for appends. The lock is exclusive for the store's
   * lifetime: it guards against a second process starting on the same
   * `directory` and silently truncating this one's journal out from under it.
   */
  async initialize(): Promise<void> {
    if (this.state === 'ready') {
      return;
    }
    if (this.state === 'closed') {
      throw new Error('JsonlAgentServerStore is closed');
    }
    await mkdir(this.directory, { recursive: true });
    this.lockHandle = await this.acquireLock();
    if (existsSync(this.filePath)) {
      this.inner.restore(this.parse(await readFile(this.filePath, 'utf8')));
    }
    await writeFileAtomic(this.filePath, this.inner.snapshot().map(serialize).join(''));
    this.handle = await open(this.filePath, 'a');
    this.state = 'ready';
  }

  async close(): Promise<void> {
    if (this.state !== 'ready') {
      this.state = 'closed';
      return;
    }
    this.state = 'closed';
    await this.queue;
    const handle = this.handle;
    this.handle = undefined;
    await handle?.close();
    await this.releaseLock();
  }

  /**
   * `wx` fails with `EEXIST` when the lock file already exists, so creation
   * itself is the exclusive claim -- no separate check-then-create race.
   */
  private async acquireLock(): Promise<FileHandle> {
    try {
      return await open(this.lockPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new RuntimeStoreError(
          'RUNTIME_STORE_LOCKED',
          `${this.lockPath} already exists. Another process may be using ` +
            `${this.directory} as a JsonlAgentServerStore directory, and starting a ` +
            'second one here would corrupt its journal. If no other process is ' +
            `running, this lock is stale: delete ${this.lockPath} and start again.`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  private async releaseLock(): Promise<void> {
    const lockHandle = this.lockHandle;
    this.lockHandle = undefined;
    if (!lockHandle) {
      return;
    }
    await lockHandle.close();
    await rm(this.lockPath, { force: true });
  }

  async healthCheck(): Promise<{ ready: boolean; details?: JsonObject }> {
    const inner = await this.inner.healthCheck();
    return {
      ready: inner.ready && this.state === 'ready',
      details: { ...(inner.details ?? {}), directory: this.directory, state: this.state },
    };
  }

  async claimCommand(
    tenantId: string,
    commandId: CommandId,
    commandFingerprint: string,
    ttlMs: number,
  ): Promise<AgentCommandClaim> {
    this.assertReady();
    return this.inner.claimCommand(tenantId, commandId, commandFingerprint, ttlMs);
  }

  async sealCommand(
    tenantId: string,
    commandId: CommandId,
    leaseId: ExecutionLeaseId,
  ): Promise<void> {
    this.assertReady();
    return this.inner.sealCommand(tenantId, commandId, leaseId);
  }

  async completeCommand(
    tenantId: string,
    commandId: CommandId,
    leaseId: ExecutionLeaseId,
    result: AgentCommandResult,
  ): Promise<void> {
    this.assertReady();
    return this.inner.completeCommand(tenantId, commandId, leaseId, result);
  }

  async releaseCommand(
    tenantId: string,
    commandId: CommandId,
    leaseId: ExecutionLeaseId,
  ): Promise<void> {
    this.assertReady();
    return this.inner.releaseCommand(tenantId, commandId, leaseId);
  }

  async abandonCommand(tenantId: string, commandId: CommandId, reason: string): Promise<boolean> {
    this.assertReady();
    return this.inner.abandonCommand(tenantId, commandId, reason);
  }

  async putSession(record: AgentServerSessionRecord): Promise<void> {
    this.assertReady();
    return this.inner.putSession(record);
  }

  async getSession(
    tenantId: string,
    sessionId: SessionId,
  ): Promise<AgentServerSessionRecord | null> {
    this.assertReady();
    return this.inner.getSession(tenantId, sessionId);
  }

  async listSessions(
    tenantId: string,
    options?: { cursor?: string; limit?: number },
  ): Promise<{ sessions: AgentServerSessionRecord[]; nextCursor?: string }> {
    this.assertReady();
    return this.inner.listSessions(tenantId, options);
  }

  async appendEvent(
    tenantId: string,
    sessionId: SessionId,
    event: Omit<AgentServerEvent, 'eventId' | 'sequence'>,
    options?: { readonly idempotencyKey?: string },
  ): Promise<AgentServerEvent> {
    this.assertReady();
    return this.inner.appendEvent(tenantId, sessionId, event, options);
  }

  async getEventByIdempotencyKey(
    tenantId: string,
    sessionId: SessionId,
    idempotencyKey: string,
  ): Promise<AgentServerEvent | null> {
    this.assertReady();
    return this.inner.getEventByIdempotencyKey(tenantId, sessionId, idempotencyKey);
  }

  async readEvents(
    tenantId: string,
    sessionId: SessionId,
    options?: { after?: number; limit?: number },
  ): Promise<AgentEventPage> {
    this.assertReady();
    return this.inner.readEvents(tenantId, sessionId, options);
  }

  async getLatestEventSequence(tenantId: string, sessionId: SessionId): Promise<number | null> {
    this.assertReady();
    return this.inner.getLatestEventSequence(tenantId, sessionId);
  }

  async getEventStreamRange(
    tenantId: string,
    sessionId: SessionId,
  ): Promise<{ readonly firstSequence: number; readonly headSequence: number } | null> {
    this.assertReady();
    return this.inner.getEventStreamRange(tenantId, sessionId);
  }

  async waitForEvents(
    tenantId: string,
    sessionId: SessionId,
    after: number,
    signal?: AbortSignal,
  ): Promise<void> {
    this.assertReady();
    return this.inner.waitForEvents(tenantId, sessionId, after, signal);
  }

  /** Test hook: drop retained events without touching the idempotency records. */
  async trimAgentEventsForTesting(tenantId: string, sessionId: SessionId): Promise<void> {
    this.assertReady();
    return this.inner.trimAgentEventsForTesting(tenantId, sessionId);
  }

  private assertReady(): void {
    if (this.state === 'new') {
      throw new Error('JsonlAgentServerStore.initialize() must be awaited before use');
    }
    if (this.state === 'closed') {
      throw new Error('JsonlAgentServerStore is closed');
    }
  }

  private write(entry: AgentServerStoreJournalEntry): Promise<void> {
    const handle = this.handle;
    if (!handle || this.state !== 'ready') {
      return Promise.reject(new Error('JsonlAgentServerStore is closed'));
    }
    const line = serialize(entry);
    const next = this.queue.then(async () => {
      // `appendFile` loops until every byte is written; a bare `write()` is one
      // `write(2)` call and can return fewer `bytesWritten` than given, leaving
      // a half-line that corrupts the journal for every reader after it.
      await handle.appendFile(line);
    });
    // Keep the chain alive after a failure so later writes and close() still drain.
    this.queue = next.catch(() => undefined);
    return next;
  }

  private parse(text: string): AgentServerStoreJournalEntry[] {
    const hasTrailingNewline = text.endsWith('\n');
    const lines = text.split('\n');
    if (hasTrailingNewline) {
      lines.pop();
    }
    const entries: AgentServerStoreJournalEntry[] = [];
    lines.forEach((line, index) => {
      if (line === '') {
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        if (index === lines.length - 1 && !hasTrailingNewline) {
          this.logger.warn(
            `[JsonlAgentServerStore] dropping the truncated last line of ${this.filePath}`,
          );
          return;
        }
        throw this.corrupt(index + 1, 'is not valid JSON', error);
      }
      if (!isJournalLine(parsed)) {
        throw this.corrupt(index + 1, 'is not a known journal entry');
      }
      // `v` stays on the object; restore() only reads `kind` and the payload fields.
      entries.push(parsed as AgentServerStoreJournalEntry);
    });
    return entries;
  }

  private corrupt(line: number, reason: string, cause?: unknown): RuntimeStoreError {
    return new RuntimeStoreError(
      'RUNTIME_STORE_CORRUPT_JOURNAL',
      `${this.filePath}:${line} ${reason}. Delete the directory to start from an empty store.`,
      cause === undefined ? undefined : { cause },
    );
  }
}
