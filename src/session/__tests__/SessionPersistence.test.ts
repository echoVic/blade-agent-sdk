import { describe, expect, it } from 'vitest';
import type { LogEntry } from '../../types/logging.js';
import { existsSync, mkdtempSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSONLStore } from '../../context/storage/JSONLStore.js';
import { getSessionFilePathFromStorageRoot } from '../../context/storage/pathUtils.js';
import { PersistentStore } from '../../context/storage/PersistentStore.js';
import type { SessionEvent } from '../../context/types.js';
import type { ContentPart } from '../../services/ChatServiceInterface.js';
import { createSession, forkSession, resumeSession } from '../../node/index.js';
import {
  createSession as createServerSession,
  resumeSession as resumeServerSession,
} from '../Session.js';
import { MessageId, SessionId } from '../../types/branded.js';

function createWorkspaceRoot(): string {
  return mkdtempSync(join(tmpdir(), 'session-persistence-test-'));
}

function sessionEvent<T extends SessionEvent['type']>(
  sessionId: SessionId,
  timestamp: string,
  id: string,
  type: T,
  data: Extract<SessionEvent, { type: T }>['data'],
): Extract<SessionEvent, { type: T }> {
  return { id, sessionId, timestamp, type, version: '1.1.2', data } as Extract<
    SessionEvent,
    { type: T }
  >;
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
  it('supports an injected repository without a local storage path', async () => {
    const repository = new PersistentStore(createWorkspaceRoot());
    const session = await createServerSession({
      ...createOptions(createWorkspaceRoot()),
      storagePath: undefined,
      sessionRepository: repository,
    });
    await session.close();

    const resumed = await resumeServerSession({
      ...createOptions(createWorkspaceRoot()),
      sessionId: session.sessionId,
      storagePath: undefined,
      sessionRepository: repository,
    });

    expect(resumed.sessionId).toBe(session.sessionId);
    await resumed.close();
  });

  it('rejects a server storagePath without an injected repository', async () => {
    await expect(
      createServerSession(createOptions(createWorkspaceRoot())),
    ).rejects.toMatchObject({
      code: 'CONFIG_ERROR',
    });
  });

  it('should resume messages from the unified session store', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const persistentStore = new PersistentStore(workspaceRoot);

    const sessionId = SessionId('session-1');
    await persistentStore.saveMessage(sessionId, 'user', 'hello');
    const toolUse = await persistentStore.saveToolUse(sessionId, 'Read', { file_path: 'README.md' });
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

  it('should resume provider-compatible history from a legacy collided ledger', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const sessionId = SessionId('legacy-collided-session');
    const now = new Date().toISOString();
    const entries = [
      sessionEvent(sessionId, now, 'session', 'session_created', {
        sessionId,
        rootId: sessionId,
        status: 'running',
        createdAt: now,
        updatedAt: now,
      }),
      sessionEvent(sessionId, now, 'user', 'message_created', {
        messageId: MessageId('user-1'),
        role: 'user',
        createdAt: now,
      }),
      sessionEvent(sessionId, now, 'user-text', 'part_created', {
        partId: 'user-text',
        messageId: MessageId('user-1'),
        partType: 'text',
        payload: { text: 'run two tools' },
        createdAt: now,
      }),
      sessionEvent(sessionId, now, 'first-call', 'part_created', {
        partId: 'call-first',
        messageId: MessageId('user-1'),
        partType: 'tool_call',
        payload: { toolCallId: 'call-first', toolName: 'Search', input: { query: 'first' } },
        createdAt: now,
      }),
      sessionEvent(sessionId, now, 'first-result', 'part_created', {
        partId: 'call-first',
        messageId: MessageId('call-first'),
        partType: 'tool_result',
        payload: { toolCallId: 'call-first', toolName: 'Search', output: 'first result' },
        createdAt: now,
      }),
      sessionEvent(sessionId, now, 'second-call', 'part_created', {
        partId: 'call-second',
        messageId: MessageId('call-first'),
        partType: 'tool_call',
        payload: { toolCallId: 'call-second', toolName: 'Search', input: { query: 'second' } },
        createdAt: now,
      }),
      sessionEvent(sessionId, now, 'second-result', 'part_created', {
        partId: 'call-second',
        messageId: MessageId('call-second'),
        partType: 'tool_result',
        payload: { toolCallId: 'call-second', toolName: 'Search', output: 'second result' },
        createdAt: now,
      }),
      sessionEvent(sessionId, now, 'final', 'message_created', {
        messageId: MessageId('assistant-final'),
        role: 'assistant',
        parentMessageId: 'call-second',
        createdAt: now,
      }),
      sessionEvent(sessionId, now, 'final-text', 'part_created', {
        partId: 'final-text',
        messageId: MessageId('assistant-final'),
        partType: 'text',
        payload: { text: 'done' },
        createdAt: now,
      }),
    ];
    await new JSONLStore(getSessionFilePathFromStorageRoot(workspaceRoot, sessionId))
      .appendBatch(entries);

    const session = await resumeSession({
      sessionId,
      ...createOptions(workspaceRoot),
    });

    expect(session.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(session.messages.filter((message) => message.role === 'tool').map(
      (message) => message.tool_call_id,
    )).toEqual(['call-first', 'call-second']);

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

    await expect(resumeSession({
      sessionId: SessionId('session-disabled'),
      ...createOptions(workspaceRoot),
      persistSession: false,
    })).rejects.toThrow(/requires session persistence/i);

    await expect(forkSession({
      sessionId: SessionId('session-disabled'),
      ...createOptions(workspaceRoot),
      persistSession: false,
    })).rejects.toThrow(/requires session persistence/i);
  });

  it('should resume multimodal user messages with image parts intact', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const persistentStore = new PersistentStore(workspaceRoot);

    const sessionId = SessionId('session-multimodal');
    const content: ContentPart[] = [
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

    await expect(resumeSession({
      sessionId,
      ...createOptions(workspaceRoot),
    })).rejects.toMatchObject({
      code: 'SESSION_JSONL_CORRUPT_LOG',
    });
  });
});
