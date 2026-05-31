import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HookEvent } from '../../types/constants.js';

const createAgent = vi.fn(async () => ({
  async *streamChat(): AsyncGenerator<unknown, unknown, unknown> {
    yield { type: 'turn_start', turn: 1, maxTurns: 10 };
    yield { type: 'content_delta', delta: 'secret answer' };
    yield {
      type: 'tool_start',
      toolCall: {
        id: 'tool-1',
        type: 'function',
        function: {
          name: 'SecretTool',
          arguments: JSON.stringify({ token: 'secret-token', count: 3 }),
        },
      },
    };
    yield {
      type: 'tool_result',
      toolCall: {
        id: 'tool-1',
        type: 'function',
        function: {
          name: 'SecretTool',
          arguments: JSON.stringify({ token: 'secret-token', count: 3 }),
        },
      },
      result: {
        success: true,
        llmContent: 'secret tool output',
      },
    };
    yield {
      type: 'token_usage',
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
        maxContextTokens: 128000,
      },
    };
    yield { type: 'turn_end', turn: 1, hasToolCalls: true };
    return {
      success: true,
      finalMessage: 'secret answer',
      metadata: {
        turnsCount: 1,
        toolCallsCount: 1,
        duration: 42,
      },
    };
  },
  async setModel() {},
}));

vi.mock('../../agent/Agent.js', () => ({
  Agent: {
    create: createAgent,
  },
}));

const { createSession } = await import('../Session.js');

describe('Session observability', () => {
  it('records a safe trace without capturing prompt or tool payloads by default', async () => {
    const storagePath = mkdtempSync(join(tmpdir(), 'session-observability-safe-'));
    const session = await createSession({
      provider: { type: 'openai-compatible', apiKey: 'test-key' },
      model: 'gpt-4o-mini',
      storagePath,
      observability: { enabled: true },
    });

    await session.send('prompt contains secret-prompt');
    for await (const _event of session.stream()) {
      // Drain stream.
    }

    const trace = session.getLastTrace();
    expect(trace).toBeDefined();
    expect(trace?.status).toBe('success');
    expect(trace?.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['content_delta', 'usage', 'result']),
    );
    expect(trace?.spans.some((span) => span.kind === 'tool' && span.name === 'SecretTool')).toBe(true);

    const serialized = JSON.stringify(trace);
    expect(serialized).not.toContain('secret-prompt');
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('secret tool output');
    expect(serialized).not.toContain('secret answer');
    expect(serialized).toContain('"preview":"[redacted]"');

    await session.close();
  });

  it('records full payloads when capturePayloads is explicitly enabled', async () => {
    const storagePath = mkdtempSync(join(tmpdir(), 'session-observability-payloads-'));
    const session = await createSession({
      provider: { type: 'openai-compatible', apiKey: 'test-key' },
      model: 'gpt-4o-mini',
      storagePath,
      observability: {
        enabled: true,
        capturePayloads: true,
      },
    });

    await session.send('prompt contains visible-prompt');
    for await (const _event of session.stream()) {
      // Drain stream.
    }

    const trace = session.getLastTrace();
    const serialized = JSON.stringify(trace);
    expect(serialized).toContain('visible-prompt');
    expect(serialized).toContain('secret-token');
    expect(serialized).toContain('secret tool output');
    expect(serialized).toContain('secret answer');

    await session.close();
  });

  it('records hook spans during prompt submission', async () => {
    const storagePath = mkdtempSync(join(tmpdir(), 'session-observability-hooks-'));
    const session = await createSession({
      provider: { type: 'openai-compatible', apiKey: 'test-key' },
      model: 'gpt-4o-mini',
      storagePath,
      hooks: {
        [HookEvent.UserPromptSubmit]: [
          async () => ({
            action: 'continue',
            modifiedInput: { userPrompt: 'hook-updated prompt' },
          }),
        ],
      },
      observability: { enabled: true },
    });

    await session.send('original prompt');
    for await (const _event of session.stream()) {
      // Drain stream.
    }

    const trace = session.getLastTrace();
    expect(trace?.spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'hook',
          name: HookEvent.UserPromptSubmit,
          status: 'success',
        }),
      ]),
    );
    expect(trace?.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['hook_start', 'hook_end']),
    );

    await session.close();
  });
});
