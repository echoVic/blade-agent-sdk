import { mkdtempSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PersistentStore } from '../../context/storage/PersistentStore.js';
import { getSessionFilePathFromStorageRoot } from '../../context/storage/pathUtils.js';
import type { ModelContent } from '../../model/message.js';
import { InputId, RequestId, SessionId, ToolUseId } from '../../types/identifiers.js';
import { NoopSessionRepository } from '../SessionRepository.js';
import { ProjectedSessionRepository } from '../SessionStore.js';

function root(): string {
  return mkdtempSync(join(tmpdir(), 'session-store-test-'));
}

describe('SessionStore', () => {
  it('uses the shared projection writer for the no-op repository', () => {
    expect(Object.getPrototypeOf(NoopSessionRepository.prototype)).toBe(
      ProjectedSessionRepository.prototype,
    );
  });

  it('keeps message and provider tool-call identities distinct', async () => {
    const store = new NoopSessionRepository();
    const tool = await store.saveToolUse(
      SessionId('noop'),
      'Search',
      {},
      null,
      undefined,
      ToolUseId('call'),
    );
    const resultId = await store.saveToolResult(
      SessionId('noop'),
      tool.toolCallId,
      'Search',
      'result',
    );
    expect(tool.messageId).not.toBe(tool.toolCallId);
    expect(resultId).not.toBe(tool.toolCallId);
  });

  it('projects messages, tools, summaries, and explicit subagent references', async () => {
    const store = new PersistentStore(root());
    const sessionId = SessionId('projection');
    const user = await store.saveMessage(sessionId, 'user', 'hello');
    const tool = await store.saveToolUse(
      sessionId,
      'Task',
      { description: 'inspect' },
      user,
      undefined,
      ToolUseId('call-task'),
    );
    const result = await store.saveToolResult(
      sessionId,
      tool.toolCallId,
      'Task',
      { status: 'done' },
      tool.messageId,
      undefined,
      undefined,
      {
        subagentSessionId: SessionId('child'),
        subagentType: 'research',
        subagentStatus: 'completed',
        subagentSummary: 'done',
      },
    );
    await store.saveCompaction(
      sessionId,
      'summary',
      { trigger: 'manual', preTokens: 100, postTokens: 20 },
      result,
    );

    const state = await store.loadState(sessionId);
    expect(state?.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'system',
    ]);
    expect(state?.toolCalls).toMatchObject([{ id: 'call-task', status: 'success' }]);
    expect(state?.subagentRefs).toMatchObject([{ childSessionId: 'child', status: 'completed' }]);
    expect(state?.summary).toBe('summary');
  });

  it('projects only pending inputs', async () => {
    const store = new PersistentStore(root());
    const sessionId = SessionId('inputs');
    await store.saveInputEnqueued(sessionId, {
      inputId: InputId('first'),
      content: 'first',
      priority: 'next',
      acceptedAt: 1,
    });
    await store.saveInputEnqueued(sessionId, {
      inputId: InputId('second'),
      content: 'second',
      priority: 'later',
      acceptedAt: 2,
    });
    await store.saveAppliedInputMessage(sessionId, InputId('first'), RequestId('request'), 'first');
    expect((await store.loadState(sessionId))?.pendingInputs).toMatchObject([
      { inputId: 'second' },
    ]);
  });

  it('preserves reasoning, tool calls, multimodal content, and fork boundaries', async () => {
    const store = new PersistentStore(root());
    const sessionId = SessionId('rich');
    const image: ModelContent[] = [
      { type: 'text', text: 'describe' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
    ];
    const first = await store.saveMessage(sessionId, 'user', image);
    const second = await store.saveMessage(sessionId, 'assistant', '', first, {
      reasoningContent: 'inspect',
      toolCalls: [
        {
          id: 'call-search',
          type: 'function',
          function: { name: 'Search', arguments: '{}' },
        },
      ],
    });
    await store.saveCompaction(sessionId, 'summary', { trigger: 'auto', preTokens: 10 }, second);

    expect((await store.loadState(sessionId))?.messages[0]?.content).toEqual(image);
    expect(await store.forkState(sessionId, { messageId: second })).toMatchObject({
      messageIds: [first, second],
      summary: undefined,
    });
  });

  it('rejects a projection stored under another Session ID', async () => {
    const storageRoot = root();
    const sessionId = SessionId('expected');
    await new PersistentStore(storageRoot).initialize();
    await writeFile(
      getSessionFilePathFromStorageRoot(storageRoot, sessionId),
      `${JSON.stringify({ sessionId: 'other', messages: [], timeline: [] })}\n`,
      'utf8',
    );
    await expect(new PersistentStore(storageRoot).loadState(sessionId)).rejects.toMatchObject({
      code: 'SESSION_JSONL_CORRUPT_LOG',
    });
  });
});
