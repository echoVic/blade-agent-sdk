import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PersistentStore } from '../../context/storage/PersistentStore.js';
import { InputId, RequestId, SessionId } from '../../types/identifiers.js';
import type { SessionPersistence } from '../SessionRepository.js';

interface RepositoryFixture {
  readonly repository: SessionPersistence;
}

function sessionPersistenceContract(name: string, createFixture: () => RepositoryFixture): void {
  describe(`${name} SessionPersistence conformance`, () => {
    it('uses one backend for append operations and read projections', async () => {
      const { repository } = createFixture();
      const sessionId = SessionId('contract-session');
      await repository.initialize();
      await repository.createSession(sessionId);
      await repository.saveMessage(sessionId, 'user', 'hello');
      const tool = await repository.saveToolUse(sessionId, 'Search', { query: 'blade' });
      await repository.saveToolResult(
        sessionId,
        tool.toolCallId,
        'Search',
        { matches: 1 },
        tool.messageId,
      );
      await repository.saveCompaction(sessionId, 'summary', {
        trigger: 'manual',
        preTokens: 100,
        postTokens: 20,
      });

      const state = await repository.loadState(sessionId);
      expect(state).toMatchObject({
        sessionId,
        summary: 'summary',
      });
      expect(state?.messages.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'tool',
        'system',
      ]);
      await expect(repository.loadMessages(sessionId)).resolves.toEqual(state?.messages);
      await expect(repository.forkState(sessionId)).resolves.toMatchObject({
        sessionId,
        messages: state?.messages,
      });
      await expect(repository.listSessions()).resolves.toContain(sessionId);
      await expect(repository.getSessionSummary(sessionId)).resolves.toMatchObject({
        sessionId,
      });
    });

    it('projects pending input state deterministically', async () => {
      const { repository } = createFixture();
      const sessionId = SessionId('pending-session');
      const inputId = InputId('input-1');
      await repository.initialize();
      await repository.saveInputEnqueued(sessionId, {
        inputId,
        content: 'later',
        priority: 'later',
        acceptedAt: 1,
      });
      expect((await repository.loadState(sessionId))?.pendingInputs).toHaveLength(1);
      await repository.saveAppliedInputMessage(sessionId, inputId, RequestId('request-1'), 'later');
      expect((await repository.loadState(sessionId))?.pendingInputs).toEqual([]);
    });

    it('reports health and supports deletion', async () => {
      const { repository } = createFixture();
      const sessionId = SessionId('delete-session');
      await repository.initialize();
      await repository.createSession(sessionId);
      await expect(repository.checkStorageHealth()).resolves.toMatchObject({
        isAvailable: true,
        canWrite: true,
      });
      await repository.deleteSession(sessionId);
      await expect(repository.loadState(sessionId)).resolves.toBeNull();
    });
  });
}

sessionPersistenceContract('JSONL', () => ({
  repository: new PersistentStore(mkdtempSync(join(tmpdir(), 'session-repository-contract-'))),
}));
