import { describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistentStore } from '../../context/storage/PersistentStore.js';
import { createSession, forkSession, resumeSession } from '../Session.js';

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
  it('should resume messages from the unified session store', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const persistentStore = new PersistentStore(workspaceRoot);

    const sessionId = 'session-1';
    await persistentStore.saveMessage(sessionId, 'user', 'hello');
    const toolCallId = await persistentStore.saveToolUse(sessionId, 'Read', { file_path: 'README.md' });
    await persistentStore.saveToolResult(sessionId, toolCallId, 'Read', 'contents', toolCallId);
    const summaryId = await persistentStore.saveCompaction(
      sessionId,
      'Compacted summary',
      { trigger: 'auto', preTokens: 12 },
      toolCallId,
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

    session.close();
  });

  it('should fork sessions using store-backed linear truncation', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const persistentStore = new PersistentStore(workspaceRoot);

    const sessionId = 'session-2';
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

    forkedSession.close();
  });

  it('should forward internal logs through the injected logger interface', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const log = mock(() => {});

    const session = await createSession({
      ...createOptions(workspaceRoot),
      logger: { log },
    });

    expect(log).toHaveBeenCalled();
    const calls = log.mock.calls as unknown[][];
    const firstCall = calls[0];
    expect(firstCall).toBeDefined();
    const entry = firstCall[0] as {
      category: string;
      sessionId?: string;
    };
    expect(entry.category).toBe('Agent');
    expect(entry.sessionId).toBe(session.sessionId);

    session.close();
  });

  it('should isolate logger routing between concurrent sessions', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const logA = mock(() => {});
    const logB = mock(() => {});

    const sessionA = await createSession({
      ...createOptions(workspaceRoot),
      logger: { log: logA },
    });
    const sessionB = await createSession({
      ...createOptions(workspaceRoot),
      logger: { log: logB },
    });

    logA.mockClear();
    logB.mockClear();

    await sessionA.setModel('gpt-4.1');

    expect(logA).toHaveBeenCalled();
    expect(logB).not.toHaveBeenCalled();

    sessionA.close();
    sessionB.close();
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

    forked.close();
    session.close();
  });

  it('should reject resume and sessionId-based fork when persistence is disabled', async () => {
    const workspaceRoot = createWorkspaceRoot();

    await expect(resumeSession({
      sessionId: 'session-disabled',
      ...createOptions(workspaceRoot),
      persistSession: false,
    })).rejects.toThrow(/requires session persistence/i);

    await expect(forkSession({
      sessionId: 'session-disabled',
      ...createOptions(workspaceRoot),
      persistSession: false,
    })).rejects.toThrow(/requires session persistence/i);
  });
});
