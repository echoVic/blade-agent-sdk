import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CommandId,
  EventId,
  EventSequence,
  ExecutionLeaseId,
  FencingToken,
  InputId,
  RequestId,
  SessionId,
  TurnId,
  WorkerId,
} from '../../../types/branded.js';
import { DurableEventSequenceConflictError, DurableEventStoreError } from '../DurableEventStore.js';
import { DurableExecutionLeaseError } from '../DurableExecutionLeaseStore.js';
import { JsonlDurableEventStore } from '../JsonlDurableEventStore.js';
import { DURABLE_EVENT_LOG_FORMAT } from '../schemas.js';
import { DURABLE_EVENT_SCHEMA_VERSION, DurableEventType } from '../types.js';

const sourceTypeScriptLoaderUrl = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sourceTypeScriptLoader.mjs'),
).href;
const storeWriterPath = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'jsonlStoreWriter.ts',
);
const leaseWorkerPath = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'jsonlLeaseWorker.ts',
);

interface ReadyChildProcess {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<ChildCloseResult>;
  description: string;
  output: () => string;
  waitForOutput: (marker: string) => Promise<void>;
}

interface ChildCloseResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: Error;
}

const CHILD_PROCESS_WAIT_TIMEOUT_MS = 15_000;
const CHILD_PROCESS_TERMINATE_TIMEOUT_MS = 2_000;
const childProcesses = new Set<ReadyChildProcess>();

async function waitWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function spawnReadyChild(
  args: readonly string[],
  readyMarker: string,
  description: string,
): Promise<ReadyChildProcess> {
  const child = spawn(process.execPath, args);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  let spawnError: Error | undefined;
  child.once('error', (error) => {
    spawnError = error;
  });
  const closed = new Promise<ChildCloseResult>((resolveClose) => {
    child.once('close', (code, signal) => {
      resolveClose({ code, signal, spawnError });
    });
  });
  const waitForOutput = async (marker: string): Promise<void> => {
    if (stdout.includes(marker)) {
      return;
    }
    await waitWithTimeout(
      new Promise<void>((resolveReady, rejectReady) => {
        const onData = (): void => {
          if (stdout.includes(marker)) {
            child.stdout.off('data', onData);
            child.off('close', onClose);
            resolveReady();
          }
        };
        const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
          child.stdout.off('data', onData);
          rejectReady(
            new Error(
              `${description} exited before emitting ${JSON.stringify(marker)} ` +
                `(${code ?? signal}): ${stderr}`,
            ),
          );
        };
        child.stdout.on('data', onData);
        child.once('close', onClose);
      }),
      CHILD_PROCESS_WAIT_TIMEOUT_MS,
      `${description} timed out waiting for ${JSON.stringify(marker)}`,
    );
  };
  const readyChild = {
    child,
    closed,
    description,
    output: () => stdout,
    waitForOutput,
  };
  childProcesses.add(readyChild);
  await waitForOutput(readyMarker);
  return readyChild;
}

interface StoreWriterOptions {
  holdMs?: number;
  lockTimeoutMs?: number;
}

interface StoreWriterResult {
  status: 'fulfilled' | 'rejected';
  lastSequence?: number;
  code?: string;
  expectedSequence?: number | null;
  actualSequence?: number | null;
}

interface LeaseWorkerResult {
  status: 'fulfilled' | 'rejected';
  workerId?: string;
  leaseId?: string;
  fencingToken?: number;
  code?: string;
}

function parseStoreWriterResult(process: ReadyChildProcess): StoreWriterResult {
  const output = process.output();
  const resultLine = output.trim().split('\n').at(-1);
  if (!resultLine) {
    throw new Error(`Store writer produced no result: ${output}`);
  }
  return JSON.parse(resultLine) as StoreWriterResult;
}

function parseLeaseWorkerResult(process: ReadyChildProcess): LeaseWorkerResult {
  const output = process.output();
  const resultLine = output.trim().split('\n').at(-1);
  if (!resultLine) {
    throw new Error(`Lease worker produced no result: ${output}`);
  }
  return JSON.parse(resultLine) as LeaseWorkerResult;
}

async function startStoreWriter(
  storageRoot: string,
  sessionId: SessionId,
  writerId: string,
  options: StoreWriterOptions = {},
): Promise<ReadyChildProcess> {
  return spawnReadyChild(
    [
      '--no-warnings',
      '--experimental-transform-types',
      '--loader',
      sourceTypeScriptLoaderUrl,
      storeWriterPath,
      storageRoot,
      sessionId,
      writerId,
      String(options.holdMs ?? 0),
      String(options.lockTimeoutMs ?? 10_000),
    ],
    'ready\n',
    'Store writer',
  );
}

async function startLeaseWorker(
  storageRoot: string,
  sessionId: SessionId,
  workerId: string,
  leaseId: string,
): Promise<ReadyChildProcess> {
  return spawnReadyChild(
    [
      '--no-warnings',
      '--experimental-transform-types',
      '--loader',
      sourceTypeScriptLoaderUrl,
      leaseWorkerPath,
      storageRoot,
      sessionId,
      workerId,
      leaseId,
    ],
    'ready\n',
    'Lease worker',
  );
}

async function startStoreLockHolder(
  storageRoot: string,
  sessionId: SessionId,
  writerId: string,
  holdMs: number,
): Promise<ReadyChildProcess> {
  const process = await startStoreWriter(storageRoot, sessionId, writerId, { holdMs });
  process.child.stdin.end('go\n');
  await process.waitForOutput('locked\n');
  return process;
}

async function waitForChild(process: ReadyChildProcess): Promise<void> {
  const { code, signal, spawnError } = await waitWithTimeout(
    process.closed,
    CHILD_PROCESS_WAIT_TIMEOUT_MS,
    `${process.description} timed out while exiting; output: ${process.output()}`,
  );
  if (spawnError) {
    throw spawnError;
  }
  if (code !== 0) {
    throw new Error(`${process.description} exited with ${code ?? signal}`);
  }
}

async function terminateChild(process: ReadyChildProcess, signal: NodeJS.Signals): Promise<void> {
  const { child } = process;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill(signal);
  }
  try {
    await waitWithTimeout(
      process.closed,
      CHILD_PROCESS_TERMINATE_TIMEOUT_MS,
      `${process.description} ignored ${signal}`,
    );
  } catch (error) {
    if (signal === 'SIGKILL' || child.exitCode !== null || child.signalCode !== null) {
      throw error;
    }
    child.kill('SIGKILL');
    await waitWithTimeout(
      process.closed,
      CHILD_PROCESS_TERMINATE_TIMEOUT_MS,
      `${process.description} did not close after SIGKILL`,
    );
  }
}

describe('JsonlDurableEventStore', () => {
  let storageRoot: string;
  let nextEventId: number;
  let store: JsonlDurableEventStore;
  const filesystemAliases: string[] = [];

  beforeEach(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'durable-event-store-'));
    nextEventId = 0;
    store = new JsonlDurableEventStore(storageRoot, {
      clock: () => new Date('2026-08-22T12:00:00.000Z'),
      eventIdFactory: () => EventId(`event-${++nextEventId}`),
    });
  });

  afterEach(async () => {
    const trackedChildren = [...childProcesses];
    childProcesses.clear();
    const terminationResults = await Promise.allSettled(
      trackedChildren.map((process) => terminateChild(process, 'SIGTERM')),
    );
    await Promise.all(
      filesystemAliases.splice(0).map((alias) => rm(alias, { recursive: true, force: true })),
    );
    await rm(storageRoot, { recursive: true, force: true });
    const terminationFailure = terminationResults.find((result) => result.status === 'rejected');
    if (terminationFailure?.status === 'rejected') {
      throw terminationFailure.reason;
    }
  });

  it('returns an empty page for a new session', async () => {
    const sessionId = SessionId('session-empty');

    await expect(store.getHeadSequence(sessionId)).resolves.toBeNull();
    await expect(store.read(sessionId)).resolves.toEqual({
      events: [],
      headSequence: null,
      nextCursor: null,
      hasMore: false,
    });
  });

  it('assigns contiguous sequences and resumes them after reopening', async () => {
    const sessionId = SessionId('session-sequences');
    const first = await store.append(
      sessionId,
      [
        {
          type: DurableEventType.REQUEST_ACCEPTED,
          requestId: RequestId('request-1'),
          commandId: CommandId('command-1'),
          data: {
            inputId: InputId('input-1'),
            input: 'hello',
            priority: 'next',
          },
        },
        {
          type: DurableEventType.REQUEST_STARTED,
          requestId: RequestId('request-1'),
          data: {},
        },
      ],
      { expectedLastSequence: null },
    );

    expect(first.previousSequence).toBeNull();
    expect(first.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(first.lastSequence).toBe(2);

    const reopened = new JsonlDurableEventStore(storageRoot, {
      clock: () => new Date('2026-08-22T12:00:01.000Z'),
      eventIdFactory: () => EventId('event-3'),
    });
    const second = await reopened.append(
      sessionId,
      [
        {
          type: DurableEventType.TURN_STARTED,
          requestId: RequestId('request-1'),
          turnId: TurnId('turn-1'),
          data: { turn: 1 },
        },
      ],
      { expectedLastSequence: EventSequence(2) },
    );

    expect(second.events[0]?.sequence).toBe(3);
    expect(await reopened.getHeadSequence(sessionId)).toBe(3);
    expect((await reopened.read(sessionId)).events.map((event) => event.eventId)).toEqual([
      'event-1',
      'event-2',
      'event-3',
    ]);
  });

  it('reads schema-v2 batches and appends new schema-v3 events', async () => {
    const sessionId = SessionId('session-schema-upgrade');
    const filePath = store.getFilePath(sessionId);
    const timestamp = '2026-08-22T12:00:00.000Z';
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      `${JSON.stringify({
        format: DURABLE_EVENT_LOG_FORMAT,
        schemaVersion: 2,
        sessionId,
        firstSequence: 1,
        lastSequence: 1,
        events: [
          {
            schemaVersion: 2,
            eventId: 'legacy-event',
            sequence: 1,
            sessionId,
            type: DurableEventType.SESSION_CREATED,
            data: { source: 'create' },
            recordedAt: timestamp,
            occurredAt: timestamp,
          },
        ],
      })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );

    expect((await store.read(sessionId)).events[0]?.schemaVersion).toBe(2);
    const appended = await store.append(
      sessionId,
      [
        {
          type: DurableEventType.REQUEST_ACCEPTED,
          requestId: RequestId('schema-v3-request'),
          commandId: CommandId('schema-v3-command'),
          data: {
            inputId: InputId('schema-v3-input'),
            input: 'continue',
            priority: 'next',
          },
        },
      ],
      { expectedLastSequence: EventSequence(1) },
    );

    expect(appended.events[0]?.schemaVersion).toBe(3);
    expect((await store.read(sessionId)).events.map((event) => event.schemaVersion)).toEqual([
      2, 3,
    ]);

    await appendFile(
      filePath,
      `${JSON.stringify({
        format: DURABLE_EVENT_LOG_FORMAT,
        schemaVersion: 2,
        sessionId,
        firstSequence: 3,
        lastSequence: 3,
        events: [
          {
            schemaVersion: 2,
            eventId: 'downgraded-event',
            sequence: 3,
            sessionId,
            type: DurableEventType.REQUEST_STARTED,
            requestId: RequestId('schema-v3-request'),
            data: {},
            recordedAt: timestamp,
            occurredAt: timestamp,
          },
        ],
      })}\n`,
    );
    await expect(store.read(sessionId)).rejects.toMatchObject({
      code: 'DURABLE_EVENT_CORRUPT_LOG',
      message: expect.stringContaining('schema regressed'),
    });
  });

  it('reads exclusive cursor pages without gaps', async () => {
    const sessionId = SessionId('session-pagination');
    const requestId = RequestId('request-pagination');
    await store.append(sessionId, [
      { type: DurableEventType.SESSION_CREATED, data: {} },
      {
        type: DurableEventType.REQUEST_ACCEPTED,
        requestId,
        commandId: CommandId('command-pagination'),
        data: {
          inputId: InputId('input-pagination'),
          input: 'hello',
          priority: 'next',
        },
      },
      { type: DurableEventType.REQUEST_STARTED, requestId, data: {} },
    ]);

    const firstPage = await store.read(sessionId, { limit: 2 });
    expect(firstPage.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(firstPage.nextCursor).toBe(2);
    expect(firstPage.headSequence).toBe(3);
    expect(firstPage.hasMore).toBe(true);

    const secondPage = await store.read(sessionId, {
      after: firstPage.nextCursor ?? undefined,
      limit: 2,
    });
    expect(secondPage.events.map((event) => event.sequence)).toEqual([3]);
    expect(secondPage.nextCursor).toBe(3);
    expect(secondPage.hasMore).toBe(false);
  });

  it('allows only one concurrent compare-and-append writer', async () => {
    const sessionId = SessionId('session-conflict');
    await store.append(sessionId, [{ type: DurableEventType.SESSION_CREATED, data: {} }], {
      expectedLastSequence: null,
    });
    const competingStore = new JsonlDurableEventStore(storageRoot, {
      eventIdFactory: () => EventId('competing-event'),
    });

    const results = await Promise.allSettled([
      competingStore.append(
        sessionId,
        [
          {
            type: DurableEventType.REQUEST_ACCEPTED,
            requestId: RequestId('request-a'),
            commandId: CommandId('command-a'),
            data: { inputId: InputId('input-a'), input: 'a', priority: 'next' },
          },
        ],
        { expectedLastSequence: EventSequence(1) },
      ),
      store.append(
        sessionId,
        [
          {
            type: DurableEventType.REQUEST_ACCEPTED,
            requestId: RequestId('request-b'),
            commandId: CommandId('command-b'),
            data: { inputId: InputId('input-b'), input: 'b', priority: 'next' },
          },
        ],
        { expectedLastSequence: EventSequence(1) },
      ),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({
        expectedSequence: 1,
        actualSequence: 2,
      }),
    });
    if (rejected?.status === 'rejected') {
      expect(rejected.reason).toBeInstanceOf(DurableEventSequenceConflictError);
    }
    expect(await store.getHeadSequence(sessionId)).toBe(2);
  });

  it('fences event appends with a monotonic execution lease', async () => {
    const sessionId = SessionId('session-execution-lease');
    const firstLeaseId = ExecutionLeaseId('lease-first');
    const secondLeaseId = ExecutionLeaseId('lease-second');
    let now = Date.parse('2026-08-22T12:00:00.000Z');
    const leaseStore = new JsonlDurableEventStore(storageRoot, {
      clock: () => new Date(now),
      eventIdFactory: () => EventId(`lease-event-${++nextEventId}`),
    });

    await expect(leaseStore.requiresExecutionLease(sessionId)).resolves.toBe(false);
    const firstLease = await leaseStore.acquireExecutionLease(sessionId, {
      leaseId: firstLeaseId,
      ownerId: WorkerId('worker-first'),
      ttlMs: 1_000,
    });
    expect(firstLease).toMatchObject({
      sessionId,
      leaseId: firstLeaseId,
      ownerId: 'worker-first',
      fencingToken: 1,
      acquiredAt: '2026-08-22T12:00:00.000Z',
      renewedAt: '2026-08-22T12:00:00.000Z',
      expiresAt: '2026-08-22T12:00:01.000Z',
    });
    await expect(leaseStore.requiresExecutionLease(sessionId)).resolves.toBe(true);
    if (process.platform !== 'win32') {
      expect((await stat(leaseStore.getExecutionLeaseFilePath(sessionId))).mode & 0o777).toBe(0o600);
    }
    await expect(
      leaseStore.acquireExecutionLease(sessionId, {
        leaseId: secondLeaseId,
        ownerId: WorkerId('worker-second'),
        ttlMs: 1_000,
      }),
    ).rejects.toMatchObject({
      code: 'DURABLE_EXECUTION_LEASE_CONFLICT',
      activeLease: firstLease,
    });
    await expect(
      leaseStore.append(sessionId, [{ type: DurableEventType.SESSION_CREATED, data: {} }], {
        expectedLastSequence: null,
      }),
    ).rejects.toMatchObject({
      code: 'DURABLE_EXECUTION_LEASE_REQUIRED',
    });
    await leaseStore.append(sessionId, [{ type: DurableEventType.SESSION_CREATED, data: {} }], {
      expectedLastSequence: null,
      executionFence: firstLease,
    });

    now += 1_001;
    await expect(
      leaseStore.append(
        sessionId,
        [
          {
            type: DurableEventType.REQUEST_ACCEPTED,
            requestId: RequestId('unfenced-expired-request'),
            commandId: CommandId('unfenced-expired-command'),
            data: {
              inputId: InputId('unfenced-expired-input'),
              input: 'unfenced after expiry',
              priority: 'next',
            },
          },
        ],
        { expectedLastSequence: EventSequence(1) },
      ),
    ).rejects.toMatchObject({
      code: 'DURABLE_EXECUTION_LEASE_REQUIRED',
    });
    const secondLease = await leaseStore.acquireExecutionLease(sessionId, {
      leaseId: secondLeaseId,
      ownerId: WorkerId('worker-second'),
      ttlMs: 1_000,
    });
    expect(secondLease.fencingToken).toBe(FencingToken(2));
    await expect(
      leaseStore.append(
        sessionId,
        [
          {
            type: DurableEventType.REQUEST_ACCEPTED,
            requestId: RequestId('stale-request'),
            commandId: CommandId('stale-command'),
            data: {
              inputId: InputId('stale-input'),
              input: 'stale',
              priority: 'next',
            },
          },
        ],
        {
          expectedLastSequence: EventSequence(1),
          executionFence: firstLease,
        },
      ),
    ).rejects.toMatchObject({
      code: 'DURABLE_EXECUTION_LEASE_LOST',
      fencingToken: 1,
      activeLease: secondLease,
    });
    await leaseStore.append(
      sessionId,
      [
        {
          type: DurableEventType.REQUEST_ACCEPTED,
          requestId: RequestId('current-request'),
          commandId: CommandId('current-command'),
          data: {
            inputId: InputId('current-input'),
            input: 'current',
            priority: 'next',
          },
        },
      ],
      {
        expectedLastSequence: EventSequence(1),
        executionFence: secondLease,
      },
    );

    await leaseStore.releaseExecutionLease(secondLease);
    await expect(leaseStore.releaseExecutionLease(secondLease)).resolves.toBeUndefined();
    await expect(leaseStore.assertExecutionLease(secondLease)).rejects.toMatchObject({
      code: 'DURABLE_EXECUTION_LEASE_LOST',
    });
    await expect(leaseStore.requiresExecutionLease(sessionId)).resolves.toBe(true);
    await expect(
      leaseStore.append(
        sessionId,
        [
          {
            type: DurableEventType.REQUEST_ACCEPTED,
            requestId: RequestId('unfenced-released-request'),
            commandId: CommandId('unfenced-released-command'),
            data: {
              inputId: InputId('unfenced-released-input'),
              input: 'unfenced after release',
              priority: 'next',
            },
          },
        ],
        { expectedLastSequence: EventSequence(2) },
      ),
    ).rejects.toMatchObject({
      code: 'DURABLE_EXECUTION_LEASE_REQUIRED',
    });
  });

  it('renews an execution lease without changing its fencing token', async () => {
    const sessionId = SessionId('session-lease-renewal');
    let now = Date.parse('2026-08-22T12:00:00.000Z');
    const leaseStore = new JsonlDurableEventStore(storageRoot, {
      clock: () => new Date(now),
    });
    const lease = await leaseStore.acquireExecutionLease(sessionId, {
      leaseId: ExecutionLeaseId('lease-renewal'),
      ownerId: WorkerId('worker-renewal'),
      ttlMs: 1_000,
    });

    now += 400;
    const renewed = await leaseStore.renewExecutionLease(lease, 1_000);

    expect(renewed.fencingToken).toBe(lease.fencingToken);
    expect(renewed.acquiredAt).toBe(lease.acquiredAt);
    expect(renewed.renewedAt).toBe('2026-08-22T12:00:00.400Z');
    expect(renewed.expiresAt).toBe('2026-08-22T12:00:01.400Z');
    await expect(leaseStore.assertExecutionLease(renewed)).resolves.toBeUndefined();
  });

  it('fails closed on corrupt execution lease state', async () => {
    const sessionId = SessionId('session-corrupt-lease');
    const filePath = store.getExecutionLeaseFilePath(sessionId);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, '{"format":"blade.durable-execution-lease"}\n');

    await expect(
      store.acquireExecutionLease(sessionId, {
        leaseId: ExecutionLeaseId('lease-corrupt'),
        ownerId: WorkerId('worker-corrupt'),
        ttlMs: 1_000,
      }),
    ).rejects.toBeInstanceOf(DurableExecutionLeaseError);
    await expect(
      store.append(sessionId, [{ type: DurableEventType.SESSION_CREATED, data: {} }]),
    ).rejects.toMatchObject({
      code: 'DURABLE_EXECUTION_LEASE_CORRUPT',
    });
  });

  it('waits for a lock held by another process before appending', async () => {
    const sessionId = SessionId('session-cross-process-lock');
    const filePath = store.getFilePath(sessionId);
    const holder = await startStoreLockHolder(storageRoot, sessionId, 'holder', 200);
    let settled = false;

    const append = store
      .append(sessionId, [{ type: DurableEventType.SESSION_CREATED, data: {} }], {
        expectedLastSequence: EventSequence(1),
      })
      .finally(() => {
        settled = true;
      });
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 75));
    expect(settled).toBe(false);

    await expect(append).resolves.toMatchObject({
      previousSequence: 1,
      lastSequence: 2,
    });
    await waitForChild(holder);
    expect((await stat(`${filePath}.lock`)).isFile()).toBe(true);
  });

  it('allows exactly one expected-head writer across independent Store processes', async () => {
    const sessionId = SessionId('session-cross-process-cas');
    const first = await startStoreWriter(storageRoot, sessionId, 'first');
    const second = await startStoreWriter(storageRoot, sessionId, 'second');
    first.child.stdin.end('go\n');
    second.child.stdin.end('go\n');
    await Promise.all([waitForChild(first), waitForChild(second)]);

    const results = [first, second].map(parseStoreWriterResult);
    expect(results.filter((result) => result.status === 'fulfilled')).toEqual([
      expect.objectContaining({ lastSequence: 1 }),
    ]);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({
        code: 'DURABLE_EVENT_SEQUENCE_CONFLICT',
        expectedSequence: null,
        actualSequence: 1,
      }),
    ]);
    await expect(store.read(sessionId)).resolves.toMatchObject({
      events: [expect.objectContaining({ sequence: 1 })],
      headSequence: 1,
    });
  });

  it('grants execution ownership to only one independent Store process', async () => {
    const sessionId = SessionId('session-cross-process-lease');
    const first = await startLeaseWorker(storageRoot, sessionId, 'worker-first', 'lease-first');
    const second = await startLeaseWorker(storageRoot, sessionId, 'worker-second', 'lease-second');
    first.child.stdin.end('go\n');
    second.child.stdin.end('go\n');
    await Promise.all([waitForChild(first), waitForChild(second)]);

    const results = [first, second].map(parseLeaseWorkerResult);
    expect(results.filter((result) => result.status === 'fulfilled')).toEqual([
      expect.objectContaining({ fencingToken: 1 }),
    ]);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({
        code: 'DURABLE_EXECUTION_LEASE_CONFLICT',
      }),
    ]);

    const unfencedWriter = await startStoreWriter(storageRoot, sessionId, 'unfenced-after-lease');
    unfencedWriter.child.stdin.end('go\n');
    await waitForChild(unfencedWriter);
    expect(parseStoreWriterResult(unfencedWriter)).toMatchObject({
      status: 'rejected',
      code: 'DURABLE_EXECUTION_LEASE_REQUIRED',
    });
  });

  it('bounds process-local lock queues by the same timeout', async () => {
    const sessionId = SessionId('session-local-lock-timeout');
    await startStoreLockHolder(storageRoot, sessionId, 'holder', 300);
    const patientAppend = store.append(
      sessionId,
      [{ type: DurableEventType.SESSION_CREATED, data: {} }],
      { expectedLastSequence: EventSequence(1) },
    );
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
    const impatientStore = new JsonlDurableEventStore(storageRoot, {
      lockTimeoutMs: 50,
    });

    await expect(impatientStore.read(sessionId)).rejects.toMatchObject({
      code: 'DURABLE_EVENT_LOCK_TIMEOUT',
    });
    await expect(patientAppend).resolves.toMatchObject({
      lastSequence: 2,
    });
  });

  it.skipIf(process.platform === 'win32')(
    'canonicalizes symlink aliases before locking',
    async () => {
      const aliasRoot = `${storageRoot}-alias`;
      await symlink(storageRoot, aliasRoot, 'dir');
      filesystemAliases.push(aliasRoot);
      const sessionId = SessionId('session-symlink-alias');
      const direct = await startStoreWriter(storageRoot, sessionId, 'direct');
      const aliased = await startStoreWriter(aliasRoot, sessionId, 'aliased');
      direct.child.stdin.end('go\n');
      aliased.child.stdin.end('go\n');
      await Promise.all([waitForChild(direct), waitForChild(aliased)]);

      const results = [direct, aliased].map(parseStoreWriterResult);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toEqual([
        expect.objectContaining({
          code: 'DURABLE_EVENT_SEQUENCE_CONFLICT',
        }),
      ]);
    },
  );

  it('fails closed on lock timeout and succeeds after the owner releases it', async () => {
    const sessionId = SessionId('session-lock-timeout');
    const holder = await startStoreLockHolder(storageRoot, sessionId, 'holder', 500);
    const impatientStore = new JsonlDurableEventStore(storageRoot, {
      lockTimeoutMs: 50,
    });

    await expect(
      impatientStore.append(sessionId, [{ type: DurableEventType.SESSION_CREATED, data: {} }], {
        expectedLastSequence: EventSequence(1),
      }),
    ).rejects.toMatchObject({
      code: 'DURABLE_EVENT_LOCK_TIMEOUT',
    });
    await expect(impatientStore.read(sessionId)).rejects.toMatchObject({
      code: 'DURABLE_EVENT_LOCK_TIMEOUT',
    });
    await expect(impatientStore.getHeadSequence(sessionId)).rejects.toMatchObject({
      code: 'DURABLE_EVENT_LOCK_TIMEOUT',
    });

    await waitForChild(holder);
    await expect(
      impatientStore.append(sessionId, [{ type: DurableEventType.SESSION_CREATED, data: {} }], {
        expectedLastSequence: EventSequence(1),
      }),
    ).resolves.toMatchObject({
      lastSequence: 2,
    });
    await expect(impatientStore.read(sessionId)).resolves.toMatchObject({
      headSequence: 2,
    });
    await expect(impatientStore.getHeadSequence(sessionId)).resolves.toBe(2);
  });

  it('recovers immediately after the lock-owning process crashes', async () => {
    const sessionId = SessionId('session-crashed-process-lock');
    const filePath = store.getFilePath(sessionId);
    const holder = await startStoreLockHolder(storageRoot, sessionId, 'holder', 10_000);
    await terminateChild(holder, 'SIGKILL');
    const recoveringStore = new JsonlDurableEventStore(storageRoot, {
      lockTimeoutMs: 500,
    });

    await expect(
      recoveringStore.append(sessionId, [{ type: DurableEventType.SESSION_CREATED, data: {} }], {
        expectedLastSequence: null,
      }),
    ).resolves.toMatchObject({
      lastSequence: 1,
    });
    expect((await stat(`${filePath}.lock`)).isFile()).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'does not reclaim a lock from a paused live process',
    async () => {
      const sessionId = SessionId('session-paused-process-lock');
      const holder = await startStoreLockHolder(storageRoot, sessionId, 'holder', 10_000);
      holder.child.kill('SIGSTOP');
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
      const contender = new JsonlDurableEventStore(storageRoot, {
        lockTimeoutMs: 100,
      });

      await expect(contender.read(sessionId)).rejects.toMatchObject({
        code: 'DURABLE_EVENT_LOCK_TIMEOUT',
      });
      await terminateChild(holder, 'SIGKILL');
    },
  );

  it('rejects invalid lock timeout options', () => {
    expect(() => new JsonlDurableEventStore(storageRoot, { lockTimeoutMs: -1 })).toThrow(
      /lockTimeoutMs/,
    );
    expect(() => new JsonlDurableEventStore(storageRoot, { lockTimeoutMs: 1.5 })).toThrow(
      /lockTimeoutMs/,
    );
  });

  it('allows an immediate lock attempt when lockTimeoutMs is zero', async () => {
    const writer = await startStoreWriter(
      storageRoot,
      SessionId('session-immediate-lock'),
      'immediate',
      { lockTimeoutMs: 0 },
    );
    writer.child.stdin.end('go\n');
    await waitForChild(writer);

    expect(parseStoreWriterResult(writer)).toMatchObject({
      status: 'fulfilled',
      lastSequence: 1,
    });
  });

  it('fails an immediate lock attempt when another Store process owns the lock', async () => {
    const sessionId = SessionId('session-immediate-lock-held');
    const holder = await startStoreLockHolder(storageRoot, sessionId, 'holder', 10_000);
    const contender = await startStoreWriter(storageRoot, sessionId, 'contender', {
      lockTimeoutMs: 0,
    });
    contender.child.stdin.end('go\n');
    await waitForChild(contender);

    expect(parseStoreWriterResult(contender)).toMatchObject({
      status: 'rejected',
      code: 'DURABLE_EVENT_LOCK_TIMEOUT',
    });
    await terminateChild(holder, 'SIGKILL');
  });

  it('rejects duplicate event IDs across append batches', async () => {
    const sessionId = SessionId('session-duplicate-event-id');
    const duplicateStore = new JsonlDurableEventStore(storageRoot, {
      eventIdFactory: () => EventId('duplicate-event'),
    });
    await duplicateStore.append(sessionId, [{ type: DurableEventType.SESSION_CREATED, data: {} }]);

    await expect(
      duplicateStore.append(sessionId, [
        {
          type: DurableEventType.REQUEST_ACCEPTED,
          requestId: RequestId('request-duplicate'),
          commandId: CommandId('command-duplicate'),
          data: {
            inputId: InputId('input-duplicate'),
            input: 'hello',
            priority: 'next',
          },
        },
      ]),
    ).rejects.toMatchObject({
      code: 'DURABLE_EVENT_INVALID_APPEND',
    });
    expect(await duplicateStore.getHeadSequence(sessionId)).toBe(1);
  });

  it('ignores and truncates an incomplete trailing batch after a crash', async () => {
    const sessionId = SessionId('session-torn-tail');
    await store.append(sessionId, [{ type: DurableEventType.SESSION_CREATED, data: {} }]);
    const filePath = store.getFilePath(sessionId);
    await appendFile(filePath, '{"format":"blade.durable-events"');

    const reopened = new JsonlDurableEventStore(storageRoot, {
      clock: () => new Date('2026-08-22T12:00:01.000Z'),
      eventIdFactory: () => EventId('event-after-crash'),
    });
    expect((await reopened.read(sessionId)).events).toHaveLength(1);

    await reopened.append(
      sessionId,
      [
        {
          type: DurableEventType.REQUEST_ACCEPTED,
          requestId: RequestId('request-after-crash'),
          commandId: CommandId('command-after-crash'),
          data: {
            inputId: InputId('input-after-crash'),
            input: 'hello',
            priority: 'next',
          },
        },
      ],
      { expectedLastSequence: EventSequence(1) },
    );

    expect((await reopened.read(sessionId)).events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(await readFile(filePath, 'utf8')).not.toContain(
      '{"format":"blade.durable-events"{"format"',
    );
  });

  it('rejects a corrupt committed batch', async () => {
    const sessionId = SessionId('session-corrupt');
    await store.append(sessionId, [{ type: DurableEventType.SESSION_CREATED, data: {} }]);
    await appendFile(store.getFilePath(sessionId), '{"invalid":true}\n');

    await expect(store.read(sessionId)).rejects.toMatchObject({
      code: 'DURABLE_EVENT_CORRUPT_LOG',
    });
  });

  it('rejects non-contiguous committed sequences', async () => {
    const sessionId = SessionId('session-sequence-gap');
    await store.append(sessionId, [{ type: DurableEventType.SESSION_CREATED, data: {} }]);
    const timestamp = '2026-08-22T12:00:01.000Z';
    await appendFile(
      store.getFilePath(sessionId),
      `${JSON.stringify({
        format: DURABLE_EVENT_LOG_FORMAT,
        schemaVersion: DURABLE_EVENT_SCHEMA_VERSION,
        sessionId,
        firstSequence: 3,
        lastSequence: 3,
        events: [
          {
            schemaVersion: DURABLE_EVENT_SCHEMA_VERSION,
            eventId: 'event-gap',
            sequence: 3,
            sessionId,
            type: DurableEventType.REQUEST_ACCEPTED,
            commandId: 'command-gap',
            requestId: 'request-gap',
            data: {
              inputId: 'input-gap',
              input: 'hello',
              priority: 'next',
            },
            recordedAt: timestamp,
            occurredAt: timestamp,
          },
        ],
      })}\n`,
    );

    await expect(store.read(sessionId)).rejects.toMatchObject({
      code: 'DURABLE_EVENT_CORRUPT_LOG',
    });
  });

  it('rejects invalid appends before creating a log', async () => {
    const sessionId = SessionId('session-invalid');

    await expect(store.append(sessionId, [])).rejects.toBeInstanceOf(DurableEventStoreError);
    await expect(
      store.append(sessionId, [
        {
          type: DurableEventType.REQUEST_ACCEPTED,
          data: { invalid: undefined },
        },
      ] as never),
    ).rejects.toMatchObject({
      code: 'DURABLE_EVENT_INVALID_APPEND',
    });
    await expect(
      store.append(sessionId, [
        {
          type: DurableEventType.REQUEST_ACCEPTED,
          data: { invalid: Number.POSITIVE_INFINITY },
        },
      ] as never),
    ).rejects.toMatchObject({
      code: 'DURABLE_EVENT_INVALID_APPEND',
    });
    await expect(stat(store.getFilePath(sessionId))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects invalid and future cursors', async () => {
    const sessionId = SessionId('session-cursor');
    await store.append(sessionId, [{ type: DurableEventType.SESSION_CREATED, data: {} }]);

    await expect(store.read(sessionId, { after: EventSequence(2) })).rejects.toMatchObject({
      code: 'DURABLE_EVENT_INVALID_CURSOR',
    });
    await expect(store.read(sessionId, { limit: 0 })).rejects.toMatchObject({
      code: 'DURABLE_EVENT_INVALID_CURSOR',
    });
  });

  it('isolates session files and keeps encoded IDs within the store directory', async () => {
    const firstSession = SessionId('../../first/session');
    const secondSession = SessionId('second-session');
    await store.append(firstSession, [
      { type: DurableEventType.SESSION_CREATED, data: { source: 'create' } },
    ]);
    await store.append(secondSession, [
      { type: DurableEventType.SESSION_CREATED, data: { source: 'resume' } },
    ]);

    expect(resolve(dirname(store.getFilePath(firstSession)))).toBe(
      resolve(storageRoot, 'durable-events'),
    );
    expect(store.getFilePath(firstSession)).not.toBe(store.getFilePath(secondSession));
    expect((await store.read(firstSession)).events[0]?.data).toEqual({
      source: 'create',
    });
    expect((await store.read(secondSession)).events[0]?.data).toEqual({
      source: 'resume',
    });
  });

  it('returns defensive copies of appended and loaded event data', async () => {
    const sessionId = SessionId('session-clones');
    const data = { nested: { value: 'original' } };
    const appended = await store.append(sessionId, [
      {
        type: DurableEventType.REQUEST_COMPLETED,
        requestId: RequestId('request-clones'),
        data: { output: data },
      },
    ]);

    data.nested.value = 'mutated-input';
    const appendedEvent = appended.events[0];
    if (appendedEvent?.type !== DurableEventType.REQUEST_COMPLETED) {
      throw new Error('Expected request_completed event');
    }
    (appendedEvent.data.output as { nested: { value: string } }).nested.value = 'mutated-result';

    expect((await store.read(sessionId)).events[0]?.data).toEqual({
      output: { nested: { value: 'original' } },
    });
  });

  it.skipIf(process.platform === 'win32')(
    'persists files with owner-only permissions',
    async () => {
      const sessionId = SessionId('session-permissions');
      await store.append(sessionId, [{ type: DurableEventType.SESSION_CREATED, data: {} }]);

      const filePath = store.getFilePath(sessionId);
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
      expect((await stat(`${filePath}.lock`)).mode & 0o777).toBe(0o600);
    },
  );
});
