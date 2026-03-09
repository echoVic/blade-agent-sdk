import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersistentStore } from '../../context/storage/PersistentStore.js';
import { forkSession, resumeSession } from '../Session.js';

function createWorkspaceRoot(): string {
  return mkdtempSync(join(tmpdir(), 'session-persistence-test-'));
}

function createOptions(workspaceRoot: string) {
  return {
    provider: { type: 'openai-compatible' as const, apiKey: 'test-key' },
    model: 'gpt-4o-mini',
    cwd: workspaceRoot,
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
});
