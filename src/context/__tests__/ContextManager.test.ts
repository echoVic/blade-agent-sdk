import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlSessionStore } from '../../session/SessionStore.js';
import { PersistentStore } from '../storage/PersistentStore.js';
import { ContextManager } from '../ContextManager.js';

function createWorkspaceRoot(): string {
  return mkdtempSync(join(tmpdir(), 'context-manager-test-'));
}

describe('ContextManager', () => {
  it('should hydrate conversation history from the unified session store', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const persistentStore = new PersistentStore(workspaceRoot);
    const sessionStore = new JsonlSessionStore(workspaceRoot);
    const contextManager = new ContextManager({ projectPath: workspaceRoot });

    const sessionId = 'session-1';
    await persistentStore.saveMessage(sessionId, 'user', 'hello');
    const toolCallId = await persistentStore.saveToolUse(sessionId, 'Read', { file_path: 'README.md' });
    await persistentStore.saveToolResult(
      sessionId,
      toolCallId,
      'Read',
      'file contents',
      toolCallId,
    );
    await persistentStore.saveCompaction(
      sessionId,
      'Compacted summary',
      { trigger: 'auto', preTokens: 42, postTokens: 20 },
      toolCallId,
    );

    await contextManager.initialize();
    const loaded = await contextManager.loadSession(sessionId);
    const state = await sessionStore.loadState(sessionId);
    const formatted = await contextManager.getFormattedContext();

    expect(loaded).toBe(true);
    expect(state).not.toBeNull();
    expect(formatted.context.layers.conversation.messages.map((message) => message.id)).toEqual(
      state!.messageIds,
    );
    expect(formatted.context.layers.conversation.summary).toBe('Compacted summary');
    expect(formatted.context.layers.tool.recentCalls).toHaveLength(1);
    expect(formatted.context.layers.tool.recentCalls[0]?.status).toBe('success');
  });
});
