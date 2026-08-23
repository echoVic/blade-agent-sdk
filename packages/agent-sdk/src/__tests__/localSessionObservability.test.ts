import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelResponse } from '@blade-ai/ai';
import { describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '../tools/types/index.js';
import { HookEvent } from '../types/constants.js';

const kernelModelGenerate = vi.fn(async (): Promise<ModelResponse> => ({
  content: 'secret answer',
  usage: {
    promptTokens: 11,
    completionTokens: 7,
    totalTokens: 18,
  },
  finishReason: 'stop',
}));

const createAgent = vi.fn(async () => ({
  async *streamChat() {},
  async setModel() {},
}));

vi.mock('../session/agent.js', () => ({
  Agent: {
    create: createAgent,
  },
}));

vi.mock('@blade-ai/ai/providers/vercel', () => ({
  createVercelModelPort: vi.fn(() => ({
    generate: kernelModelGenerate,
    stream: async function* () {},
  })),
}));

const { createSession } = await import('../session/internal.js');

function queueSecretToolRoundTrip(): void {
  kernelModelGenerate.mockReset();
  kernelModelGenerate
    .mockResolvedValueOnce({
      content: '',
      toolCalls: [
        {
          id: 'tool-1',
          name: 'SecretTool',
          input: { token: 'secret-token', count: 3 },
        },
      ],
      finishReason: 'tool-calls',
    })
    .mockResolvedValueOnce({
      content: 'secret answer',
      usage: {
        promptTokens: 11,
        completionTokens: 7,
        totalTokens: 18,
      },
      finishReason: 'stop',
    });
}

const secretTool: ToolDefinition<{ token: string; count: number }> = {
  name: 'SecretTool',
  description: 'Return a secret tool output',
  parameters: {
    type: 'object',
    properties: {
      token: { type: 'string' },
      count: { type: 'number' },
    },
    required: ['token', 'count'],
  },
  async execute() {
    return {
      success: true,
      llmContent: 'secret tool output',
    };
  },
};

describe('Session observability', () => {
  it('records a safe trace without capturing prompt or tool payloads by default', async () => {
    queueSecretToolRoundTrip();
    const storagePath = mkdtempSync(join(tmpdir(), 'session-observability-safe-'));
    const session = await createSession({
      provider: { type: 'openai-compatible', apiKey: 'test-key' },
      model: 'gpt-4o-mini',
      storagePath,
      allowedTools: ['SecretTool'],
      tools: [secretTool as never],
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
      expect.arrayContaining(['model_request', 'model_response', 'tool_result', 'usage', 'result']),
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
    queueSecretToolRoundTrip();
    const storagePath = mkdtempSync(join(tmpdir(), 'session-observability-payloads-'));
    const session = await createSession({
      provider: { type: 'openai-compatible', apiKey: 'test-key' },
      model: 'gpt-4o-mini',
      storagePath,
      allowedTools: ['SecretTool'],
      tools: [secretTool as never],
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
