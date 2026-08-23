import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CommandId,
  EventId,
  EventSequence,
  InputId,
  RequestId,
  SessionId,
  TurnId,
} from '../../../types/branded.js';
import { DurableEventSequenceConflictError, DurableEventStoreError } from '../DurableEventStore.js';
import { JsonlDurableEventStore } from '../JsonlDurableEventStore.js';
import { DURABLE_EVENT_LOG_FORMAT } from '../schemas.js';
import { DURABLE_EVENT_SCHEMA_VERSION, DurableEventType } from '../types.js';

const sourceTypeScriptLoaderPath = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'sourceTypeScriptLoader.mjs',
);
const storeWriterPath = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'jsonlStoreWriter.ts',
);

interface ReadyChildProcess {
  child: ChildProcessWithoutNullStreams;
  output: () => string;
  waitForOutput: (marker: string) => Promise<void>;
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
  const waitForOutput = async (marker: string): Promise<void> => {
    if (stdout.includes(marker)) {
      return;
    }
    await new Promise<void>((resolveReady, rejectReady) => {
      const onData = (): void => {
        if (stdout.includes(marker)) {
          child.stdout.off('data', onData);
          child.off('exit', onExit);
          resolveReady();
        }
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        child.stdout.off('data', onData);
        rejectReady(
          new Error(
            `${description} exited before emitting ${JSON.stringify(marker)} ` +
              `(${code ?? signal}): ${stderr}`,
          ),
        );
      };
      child.stdout.on('data', onData);
      child.once('exit', onExit);
    });
  };
  await waitForOutput(readyMarker);
  return {
    child,
    output: () => stdout,
    waitForOutput,
  };
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

function parseStoreWriterResult(process: ReadyChildProcess): StoreWriterResult {
  const output = process.output();
  const resultLine = output.trim().split('\n').at(-1);
  if (!resultLine) {
    throw new Error(`Store writer produced no result: ${output}`);
  }
  return JSON.parse(resultLine) as StoreWriterResult;
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
      sourceTypeScriptLoaderPath,
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

async function waitForChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
  if (code !== 0) {
    throw new Error(`Child process exited with ${code ?? signal}`);
  }
}

async function terminateChild(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exit = once(child, 'exit');
  child.kill(signal);
  await exit;
}

describe('JsonlDurableEventStore', () => {
  let storageRoot: string;
  let nextEventId: number;
  let store: JsonlDurableEventStore;
  const childProcesses: ChildProcessWithoutNullStreams[] = [];
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
    await Promise.all(
      childProcesses.splice(0).map(async (child) => {
        if (child.exitCode === null && child.signalCode === null) {
          await terminateChild(child, 'SIGTERM');
        }
      }),
    );
    await Promise.all(
      filesystemAliases.splice(0).map((alias) => rm(alias, { recursive: true, force: true })),
    );
    await rm(storageRoot, { recursive: true, force: true });
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

  it('waits for a lock held by another process before appending', async () => {
    const sessionId = SessionId('session-cross-process-lock');
    const filePath = store.getFilePath(sessionId);
    const holder = await startStoreLockHolder(storageRoot, sessionId, 'holder', 200);
    childProcesses.push(holder.child);
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
    await waitForChild(holder.child);
    await expect(stat(`${filePath}.lock`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('allows exactly one expected-head writer across independent Store processes', async () => {
    const sessionId = SessionId('session-cross-process-cas');
    const first = await startStoreWriter(storageRoot, sessionId, 'first');
    childProcesses.push(first.child);
    const second = await startStoreWriter(storageRoot, sessionId, 'second');
    childProcesses.push(second.child);
    first.child.stdin.end('go\n');
    second.child.stdin.end('go\n');
    await Promise.all([waitForChild(first.child), waitForChild(second.child)]);

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

  it('bounds process-local lock queues by the same timeout', async () => {
    const sessionId = SessionId('session-local-lock-timeout');
    const holder = await startStoreLockHolder(storageRoot, sessionId, 'holder', 300);
    childProcesses.push(holder.child);
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
      childProcesses.push(direct.child);
      const aliased = await startStoreWriter(aliasRoot, sessionId, 'aliased');
      childProcesses.push(aliased.child);
      direct.child.stdin.end('go\n');
      aliased.child.stdin.end('go\n');
      await Promise.all([waitForChild(direct.child), waitForChild(aliased.child)]);

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
    childProcesses.push(holder.child);
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

    await waitForChild(holder.child);
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

  it('reclaims a stale lock left by a crashed process', async () => {
    const sessionId = SessionId('session-stale-process-lock');
    const filePath = store.getFilePath(sessionId);
    const holder = await startStoreLockHolder(storageRoot, sessionId, 'holder', 10_000);
    childProcesses.push(holder.child);
    await terminateChild(holder.child, 'SIGKILL');
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(`${filePath}.lock`, staleTime, staleTime);
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
    await expect(stat(`${filePath}.lock`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

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
    childProcesses.push(writer.child);
    writer.child.stdin.end('go\n');
    await waitForChild(writer.child);

    expect(parseStoreWriterResult(writer)).toMatchObject({
      status: 'fulfilled',
      lastSequence: 1,
    });
  });

  it('fails an immediate lock attempt when another Store process owns the lock', async () => {
    const sessionId = SessionId('session-immediate-lock-held');
    const holder = await startStoreLockHolder(storageRoot, sessionId, 'holder', 300);
    childProcesses.push(holder.child);
    const contender = await startStoreWriter(storageRoot, sessionId, 'contender', {
      lockTimeoutMs: 0,
    });
    childProcesses.push(contender.child);
    contender.child.stdin.end('go\n');
    await waitForChild(contender.child);

    expect(parseStoreWriterResult(contender)).toMatchObject({
      status: 'rejected',
      code: 'DURABLE_EVENT_LOCK_TIMEOUT',
    });
    await waitForChild(holder.child);
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

  it('persists files with owner-only permissions', async () => {
    const sessionId = SessionId('session-permissions');
    await store.append(sessionId, [{ type: DurableEventType.SESSION_CREATED, data: {} }]);

    const mode = (await stat(store.getFilePath(sessionId))).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
