import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tryLock, unlock } from 'fs-native-extensions';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionId } from '../../../types/branded.js';
import type { SessionEvent } from '../../types.js';
import { JSONLStore } from '../JSONLStore.js';
import { PersistentStore } from '../PersistentStore.js';

const temporaryRoots: string[] = [];
const lockHolderPath = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'advisoryLockHolder.mjs',
);

async function withTimeout<T>(
  promise: Promise<T>,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), 5_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function createStore(options?: { lockTimeoutMs?: number }): Promise<{
  filePath: string;
  store: JSONLStore;
}> {
  const root = await mkdtemp(join(tmpdir(), 'session-jsonl-store-'));
  temporaryRoots.push(root);
  const filePath = join(root, 'sessions', 'session.jsonl');
  return {
    filePath,
    store: new JSONLStore(filePath, options),
  };
}

function event(
  id: string,
  sessionId = SessionId('session'),
): SessionEvent {
  return {
    id,
    sessionId,
    timestamp: '2026-08-23T00:00:00.000Z',
    type: 'session_updated',
    version: '1.0.0',
    data: { title: id },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe('JSONLStore', () => {
  it('serializes concurrent appends across independent Store instances', async () => {
    const { filePath, store } = await createStore();
    const otherStore = new JSONLStore(filePath);
    const entries = Array.from({ length: 100 }, (_, index) => event(`event-${index}`));

    await Promise.all(
      entries.map((entry, index) =>
        (index % 2 === 0 ? store : otherStore).append(entry),
      ),
    );

    const persisted = await store.readAll();
    expect(persisted).toHaveLength(entries.length);
    expect(new Set(persisted.map((entry) => entry.id))).toEqual(
      new Set(entries.map((entry) => entry.id)),
    );
  });

  it('appends an initialization record exactly once across Store instances', async () => {
    const { filePath } = await createStore();
    const stores = Array.from({ length: 20 }, () => new JSONLStore(filePath));

    const results = await Promise.all(
      stores.map((store, index) => store.appendIfEmpty(event(`initializer-${index}`))),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    await expect(stores[0]?.readAll()).resolves.toHaveLength(1);
  });

  it('initializes a Session transcript exactly once across PersistentStore instances', async () => {
    const root = await mkdtemp(join(tmpdir(), 'persistent-store-init-'));
    temporaryRoots.push(root);
    const sessionId = SessionId('shared-session');
    const stores = Array.from({ length: 20 }, () => new PersistentStore(root));

    await Promise.all(stores.map((store) => store.createSession(sessionId)));

    const transcript = new JSONLStore(
      join(root, 'sessions', `${sessionId}.jsonl`),
    );
    const entries = await transcript.readAll();
    expect(entries.filter((entry) => entry.type === 'session_created')).toHaveLength(1);
  });

  it('ignores an uncommitted crash tail and truncates it before the next append', async () => {
    const { filePath, store } = await createStore();
    await store.append(event('before'));
    await appendFile(filePath, '{"id":"torn"', 'utf8');

    await expect(store.readAll()).resolves.toEqual([event('before')]);

    await store.append(event('after'));

    const content = await readFile(filePath, 'utf8');
    expect(content).not.toContain('"torn"');
    await expect(store.readAll()).resolves.toEqual([
      event('before'),
      event('after'),
    ]);
  });

  it('fails closed when a committed record is corrupt', async () => {
    const { filePath, store } = await createStore();
    await store.append(event('valid'));
    await appendFile(filePath, 'not-json\n', 'utf8');

    await expect(store.readAll()).rejects.toMatchObject({
      code: 'SESSION_JSONL_CORRUPT_LOG',
      message: expect.stringContaining('line 2'),
    });
  });

  it('fails closed when a committed record is not a Session event', async () => {
    const { filePath, store } = await createStore();
    await store.append(event('valid'));
    await appendFile(
      filePath,
      `${JSON.stringify({
        id: 'foreign',
        sessionId: 'session',
        timestamp: '2026-08-23T00:00:00.000Z',
        type: 'foreign_event',
        version: '1.0.0',
        data: {},
      })}\n`,
      'utf8',
    );

    await expect(store.readAll()).rejects.toMatchObject({
      code: 'SESSION_JSONL_CORRUPT_LOG',
      message: expect.stringContaining('line 2'),
    });
  });

  it('fails closed when a committed event has an invalid payload', async () => {
    const { filePath, store } = await createStore();
    await store.append(event('valid'));
    await appendFile(
      filePath,
      `${JSON.stringify({
        id: 'invalid-message',
        sessionId: 'session',
        timestamp: '2026-08-23T00:00:00.000Z',
        type: 'message_created',
        version: '1.0.0',
        data: {},
      })}\n`,
      'utf8',
    );

    await expect(store.readAll()).rejects.toMatchObject({
      code: 'SESSION_JSONL_CORRUPT_LOG',
      message: expect.stringContaining('line 2'),
    });
  });

  it('fails closed when a committed record contains invalid UTF-8', async () => {
    const { filePath, store } = await createStore();
    await store.append(event('valid'));
    await appendFile(
      filePath,
      Buffer.concat([
        Buffer.from('{"id":"'),
        Buffer.from([0xe2, 0x82]),
        Buffer.from('"}\n'),
      ]),
    );

    await expect(store.readAll()).rejects.toMatchObject({
      code: 'SESSION_JSONL_CORRUPT_LOG',
      message: expect.stringContaining('invalid UTF-8'),
    });
  });

  it.each([
    [
      'a duplicate event ID',
      event('first'),
    ],
    [
      'a different Session ID',
      event('second', SessionId('other-session')),
    ],
  ])('fails closed when the log contains %s', async (_description, invalidEvent) => {
    const { filePath, store } = await createStore();
    await store.append(event('first'));
    await appendFile(filePath, `${JSON.stringify(invalidEvent)}\n`, 'utf8');

    await expect(store.readAll()).rejects.toMatchObject({
      code: 'SESSION_JSONL_CORRUPT_LOG',
      message: expect.stringContaining('line 2'),
    });
  });

  it('fails closed when the transcript path cannot be read', async () => {
    const { filePath, store } = await createStore();
    await mkdir(filePath, { recursive: true });

    await expect(store.readAll()).rejects.toMatchObject({
      code: 'SESSION_JSONL_READ_FAILED',
    });
  });

  it('awaits asynchronous stream callbacks in file order', async () => {
    const { store } = await createStore();
    await store.appendBatch([event('first'), event('second')]);
    const observed: string[] = [];

    await store.readStream(async (entry) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      observed.push(entry.id);
    });

    expect(observed).toEqual(['first', 'second']);
  });

  it('fails immediately when another owner holds the process lock', async () => {
    const { filePath } = await createStore();
    await mkdir(dirname(filePath), { recursive: true });
    const lockFile = await open(`${filePath}.lock`, 'a+', 0o600);
    expect(tryLock(lockFile.fd)).toBe(true);

    try {
      const store = new JSONLStore(filePath, { lockTimeoutMs: 0 });
      await expect(store.append(event('blocked'))).rejects.toMatchObject({
        code: 'SESSION_JSONL_LOCK_TIMEOUT',
      });
    } finally {
      unlock(lockFile.fd);
      await lockFile.close();
    }
  });

  it('honors a lock held by an independent Node.js process', async () => {
    const { filePath } = await createStore();
    await mkdir(dirname(filePath), { recursive: true });
    const child = spawn(process.execPath, [
      lockHolderPath,
      `${filePath}.lock`,
      '500',
    ]);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stderr = '';
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const closed = once(child, 'close');

    try {
      const [ready] = await withTimeout(
        once(child.stdout, 'data'),
        'Lock holder did not become ready',
      );
      expect(String(ready)).toContain('locked');

      const store = new JSONLStore(filePath, { lockTimeoutMs: 25 });
      await expect(store.append(event('blocked'))).rejects.toMatchObject({
        code: 'SESSION_JSONL_LOCK_TIMEOUT',
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
      }
      const [code, signal] = await withTimeout(
        closed,
        `Lock holder did not exit: ${stderr}`,
      );
      expect(code ?? signal).not.toBeNull();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'creates transcript and sidecar files with owner-only permissions',
    async () => {
      const { filePath, store } = await createStore();
      await store.append(event('private'));

      expect((await stat(dirname(filePath))).mode & 0o777).toBe(0o700);
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
      expect((await stat(`${filePath}.lock`)).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'keeps the Session directory private when a health check creates it first',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'persistent-store-health-'));
      temporaryRoots.push(root);
      const store = new PersistentStore(root);

      await expect(store.checkStorageHealth()).resolves.toMatchObject({
        isAvailable: true,
        canWrite: true,
      });

      expect((await stat(join(root, 'sessions'))).mode & 0o777).toBe(0o700);
    },
  );

  it('treats a missing transcript as an empty store', async () => {
    const { store } = await createStore();
    await expect(store.readAll()).resolves.toEqual([]);
    await expect(store.getStats()).resolves.toEqual({
      exists: false,
      size: 0,
      lineCount: 0,
    });
  });

  it('distinguishes an existing empty transcript from a missing file', async () => {
    const { filePath, store } = await createStore();
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, '');

    await expect(store.getStats()).resolves.toEqual({
      exists: true,
      size: 0,
      lineCount: 0,
    });
  });

  it('does not overwrite a non-empty transcript with appendIfEmpty', async () => {
    const { store } = await createStore();
    await store.append(event('existing'));

    await expect(store.appendIfEmpty(event('replacement'))).resolves.toBe(false);
    await expect(store.readAll()).resolves.toEqual([event('existing')]);
  });
});
