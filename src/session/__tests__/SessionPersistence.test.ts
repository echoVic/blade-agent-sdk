import { existsSync, mkdtempSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PersistentStore } from '../../context/storage/PersistentStore.js';
import { getSessionFilePathFromStorageRoot } from '../../context/storage/pathUtils.js';
import type { ModelContent } from '../../model/message.js';
import { createSession, forkSession, resumeSession } from '../../node/index.js';
import { SessionId } from '../../types/identifiers.js';
import type { LogEntry } from '../../types/logging.js';
import {
  createSession as createServerSession,
  resumeSession as resumeServerSession,
} from '../Session.js';
import type { SessionRepository } from '../SessionRepository.js';
import { hasSessionPersistence } from '../SessionState.js';

function createWorkspaceRoot(): string {
  return mkdtempSync(join(tmpdir(), 'session-persistence-test-'));
}

function createOptions(workspaceRoot: string) {
  return {
    provider: { type: 'openai-compatible' as const, apiKey: 'test-key' },
    model: 'gpt-4o-mini',
    defaultContext: {
      capabilities: {
        filesystem: {
          roots: [workspaceRoot],
          cwd: workspaceRoot,
        },
      },
    },
    storagePath: workspaceRoot,
  };
}

describe('Session persistence', () => {
  it('requires the event Store to be configured explicitly', () => {
    const workspaceRoot = createWorkspaceRoot();
    const persistence = new PersistentStore(workspaceRoot);

    expect(
      hasSessionPersistence({
        ...createOptions(workspaceRoot),
        storagePath: undefined,
        sessionRepository: persistence,
      }),
    ).toBe(false);
    expect(
      hasSessionPersistence({
        ...createOptions(workspaceRoot),
        storagePath: undefined,
        sessionRepository: persistence,
        sessionEventStore: persistence,
      }),
    ).toBe(true);
  });

  it('requires an event writer when a read-only repository is configured', async () => {
    const repository: SessionRepository = {
      async initialize() {},
      async loadState() {
        return null;
      },
      async loadMessages() {
        return [];
      },
      async forkState() {
        return null;
      },
      async listSessions() {
        return [];
      },
      async getSessionSummary() {
        return null;
      },
      async deleteSession() {},
      async cleanupOldSessions() {},
      async getStorageStats() {
        return { totalSessions: 0, totalSize: 0 };
      },
      async checkStorageHealth() {
        return { isAvailable: true, canWrite: false };
      },
    };

    await expect(
      createServerSession({
        ...createOptions(createWorkspaceRoot()),
        storagePath: undefined,
        sessionRepository: repository,
      }),
    ).rejects.toMatchObject({
      code: 'CONFIG_ERROR',
    });
  });

  it('supports an injected repository without a local storage path', async () => {
    const repository = new PersistentStore(createWorkspaceRoot());
    const session = await createServerSession({
      ...createOptions(createWorkspaceRoot()),
      storagePath: undefined,
      sessionRepository: repository,
      sessionEventStore: repository,
    });
    await session.close();

    const resumed = await resumeServerSession({
      ...createOptions(createWorkspaceRoot()),
      sessionId: session.sessionId,
      storagePath: undefined,
      sessionRepository: repository,
      sessionEventStore: repository,
    });

    expect(resumed.sessionId).toBe(session.sessionId);
    await resumed.close();
  });

  it('rejects a server storagePath without an injected repository', async () => {
    await expect(createServerSession(createOptions(createWorkspaceRoot()))).rejects.toMatchObject({
      code: 'CONFIG_ERROR',
    });
  });

  it('should resume messages from the unified session store', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const persistentStore = new PersistentStore(workspaceRoot);

    const sessionId = SessionId('session-1');
    await persistentStore.saveMessage(sessionId, 'user', 'hello');
    const toolUse = await persistentStore.saveToolUse(sessionId, 'Read', {
      file_path: 'README.md',
    });
    const toolResultMessageId = await persistentStore.saveToolResult(
      sessionId,
      toolUse.toolCallId,
      'Read',
      'contents',
      toolUse.messageId,
    );
    const summaryId = await persistentStore.saveCompaction(
      sessionId,
      'Compacted summary',
      { trigger: 'auto', preTokens: 12 },
      toolResultMessageId,
    );

    const session = await resumeSession({
      sessionId,
      ...createOptions(workspaceRoot),
    });

    expect(session.messages).toHaveLength(4);
    expect(session.messages[0]?.role).toBe('user');
    expect(session.messages[1]?.role).toBe('assistant');
    expect(session.messages[2]?.role).toBe('tool');
    expect(session.messages[3]?.id).toBe(summaryId);
    expect(session.messages[3]?.role).toBe('system');

    await session.close();
  });

  it('should fork sessions using store-backed linear truncation', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const persistentStore = new PersistentStore(workspaceRoot);

    const sessionId = SessionId('session-2');
    const userMessageId = await persistentStore.saveMessage(sessionId, 'user', 'hello');
    const assistantMessageId = await persistentStore.saveMessage(
      sessionId,
      'assistant',
      'world',
      userMessageId,
    );
    await persistentStore.saveCompaction(
      sessionId,
      'Compacted summary',
      { trigger: 'manual', preTokens: 9 },
      assistantMessageId,
    );

    const forkedSession = await forkSession({
      sessionId,
      messageId: assistantMessageId,
      ...createOptions(workspaceRoot),
    });

    expect(forkedSession.messages.map((message) => message.id)).toEqual([
      userMessageId,
      assistantMessageId,
    ]);

    await forkedSession.close();
  });

  it('should forward internal logs through the injected logger interface', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const entries: LogEntry[] = [];

    const session = await createSession({
      ...createOptions(workspaceRoot),
      logger: {
        log: (entry) => {
          entries.push(entry);
        },
      },
    });

    expect(entries.length).toBeGreaterThan(0);
    const entry = entries[0];
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('Agent');
    expect(entry?.sessionId).toBe(session.sessionId);

    await session.close();
  });

  it('should isolate logger routing between concurrent sessions', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const entriesA: LogEntry[] = [];
    const entriesB: LogEntry[] = [];

    const sessionA = await createSession({
      ...createOptions(workspaceRoot),
      logger: {
        log: (entry) => {
          entriesA.push(entry);
        },
      },
    });
    const sessionB = await createSession({
      ...createOptions(workspaceRoot),
      logger: {
        log: (entry) => {
          entriesB.push(entry);
        },
      },
    });

    entriesA.length = 0;
    entriesB.length = 0;

    await sessionA.setModel('gpt-4.1');

    expect(entriesA.length).toBeGreaterThan(0);
    expect(entriesB).toHaveLength(0);
    expect(entriesA.every((entry) => entry.sessionId === sessionA.sessionId)).toBe(true);

    await sessionA.close();
    await sessionB.close();
  });

  it('should allow disabling disk-backed session persistence', async () => {
    const workspaceRoot = createWorkspaceRoot();

    const session = await createSession({
      ...createOptions(workspaceRoot),
      persistSession: false,
    });

    expect(existsSync(join(workspaceRoot, 'sessions'))).toBe(false);

    const forked = await session.fork();
    expect(forked.messages).toEqual([]);

    await forked.close();
    await session.close();
  });

  it('should reject resume and sessionId-based fork when persistence is disabled', async () => {
    const workspaceRoot = createWorkspaceRoot();

    await expect(
      resumeSession({
        sessionId: SessionId('session-disabled'),
        ...createOptions(workspaceRoot),
        persistSession: false,
      }),
    ).rejects.toThrow(/requires session persistence/i);

    await expect(
      forkSession({
        sessionId: SessionId('session-disabled'),
        ...createOptions(workspaceRoot),
        persistSession: false,
      }),
    ).rejects.toThrow(/requires session persistence/i);
  });

  it('should resume multimodal user messages with image parts intact', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const persistentStore = new PersistentStore(workspaceRoot);

    const sessionId = SessionId('session-multimodal');
    const content: ModelContent[] = [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,resume' } },
    ];

    await persistentStore.saveMessage(sessionId, 'user', content);

    const session = await resumeSession({
      sessionId,
      ...createOptions(workspaceRoot),
    });

    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]?.role).toBe('user');
    expect(session.messages[0]?.content).toEqual(content);

    await session.close();
  });

  it('fails closed instead of resuming from a partially projected corrupt transcript', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const persistentStore = new PersistentStore(workspaceRoot);
    const sessionId = SessionId('session-corrupt');
    await persistentStore.saveMessage(sessionId, 'user', 'preserve me');
    await appendFile(
      getSessionFilePathFromStorageRoot(workspaceRoot, sessionId),
      'not-json\n',
      'utf8',
    );

    await expect(
      resumeSession({
        sessionId,
        ...createOptions(workspaceRoot),
      }),
    ).rejects.toMatchObject({
      code: 'SESSION_JSONL_CORRUPT_LOG',
    });
  });
});
