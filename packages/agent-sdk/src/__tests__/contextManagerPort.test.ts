import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ContextManager } from '../local/contextManager.js';
import { PersistentStore } from '../local/persistentStore.js';
import { SessionId } from '../local/branded.js';

/**
 * Slice #341 — ContextManager ported into @blade-ai/agent-sdk/local.
 *
 * The unified context manager (memory + persistent project store + session
 * store + cache + compressor + filter, session lifecycle, tool/workspace
 * state, formatted context, search, stats, cleanup) was the last real
 * context-core file; root src/context/ContextManager.ts is now a re-export
 * shim.
 */

function createWorkspaceRoot(): string {
  return mkdtempSync(join(tmpdir(), 'local-context-manager-'));
}

function createContextManager(workspaceRoot: string): ContextManager {
  return new ContextManager({
    storage: {
      maxMemorySize: 1000,
      cacheSize: 100,
      compressionEnabled: true,
      persistentPath: workspaceRoot,
    },
    projectPath: workspaceRoot,
  });
}

describe('ContextManager (package local)', () => {
  it('initializes and creates sessions with generated ids', async () => {
    const manager = createContextManager(createWorkspaceRoot());
    await manager.initialize();

    const sessionId = await manager.createSession();
    expect(typeof sessionId).toBe('string');
    expect(sessionId.length).toBeGreaterThan(0);
  });

  it('hydrates conversation history from the unified session store', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const persistentStore = new PersistentStore(workspaceRoot);
    await persistentStore.initialize();

    const sessionId = SessionId('cm-session');
    await persistentStore.createSession(sessionId);
    await persistentStore.saveMessage(sessionId, 'user', 'hello context manager');
    const toolCallId = await persistentStore.saveToolUse(sessionId, 'Read', {
      file_path: 'README.md',
    });
    await persistentStore.saveToolResult(sessionId, toolCallId, 'Read', 'file contents', toolCallId);

    const manager = createContextManager(workspaceRoot);
    await manager.initialize();
    const loaded = await manager.loadSession(sessionId);
    expect(loaded).toBe(true);

    const formatted = await manager.getFormattedContext();
    const messages = formatted.context.layers.conversation.messages;
    expect(messages.length).toBeGreaterThan(0);
    expect(JSON.stringify(messages)).toContain('hello context manager');
  });

  it('searches persisted sessions', async () => {
    const workspaceRoot = createWorkspaceRoot();
    const persistentStore = new PersistentStore(workspaceRoot);
    await persistentStore.initialize();
    await persistentStore.createSession(SessionId('cm-search'));
    await persistentStore.saveMessage(SessionId('cm-search'), 'user', 'remember the banana protocol');

    const manager = createContextManager(workspaceRoot);
    await manager.initialize();
    const results = await manager.searchSessions('banana');
    expect(Array.isArray(results)).toBe(true);
  });

  it('cleans up gracefully', async () => {
    const manager = createContextManager(createWorkspaceRoot());
    await manager.initialize();
    await manager.createSession(SessionId('cm-cleanup'));

    await expect(manager.cleanup()).resolves.toBeUndefined();
  });
});
