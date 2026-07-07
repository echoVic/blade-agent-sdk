import type { AgentStreamEvent } from '@blade-ai/agent';
import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { BladeConfig } from '../types/common.js';

const runtimeTurnModulePath = '../session/runtimeTurn.js';
const runtimeTurnSourcePath = 'src/session/runtimeTurn.ts';

describe('agent-sdk package-local runtime turn operations', () => {
  it('bundles trace runtime and kernel turn streaming around one trace manager', async () => {
    expect(existsSync(runtimeTurnSourcePath)).toBe(true);

    const { createPackageLocalRuntimeTurnOperations } = await import(runtimeTurnModulePath);
    const model = {
      generate: vi.fn(),
      stream: vi.fn(),
    };
    const bladeConfig: BladeConfig = {
      models: [],
      currentModelId: 'default-model',
    };
    const kernelModelResolver = {
      resolve: vi.fn(() => ({
        model,
        modelRequestDefaults: {
          maxContextTokens: 512,
        },
      })),
    };
    const createAgentKernel = vi.fn((_kernelOptions, _kernelModel) => ({
      async *runTurn() {
        yield { type: 'content', delta: 'hi' } satisfies AgentStreamEvent;
        yield {
          type: 'usage',
          usage: {
            promptTokens: 2,
            completionTokens: 3,
            totalTokens: 5,
          },
        } satisfies AgentStreamEvent;
        yield { type: 'result', content: 'hi' } satisfies AgentStreamEvent;
      },
    }));

    const operations = createPackageLocalRuntimeTurnOperations({
      sessionId: 'session-turn',
      observability: {
        enabled: true,
      },
      model: 'glm-5.2',
      providerType: 'openai-compatible',
      logger: {
        warn: vi.fn(),
      },
      bladeConfig,
      hookRuntime: {
        enable: vi.fn(),
        setTraceCollector: vi.fn(),
      },
      kernelModelResolver,
      createAgentKernel,
    });

    const messages = [];
    for await (const message of operations.kernelTurnStream.stream({
      input: 'hello turn',
      modelId: 'glm-5.2',
    })) {
      messages.push(message);
    }

    expect(messages).toContainEqual({
      type: 'usage',
      usage: {
        inputTokens: 2,
        outputTokens: 3,
        totalTokens: 5,
        maxContextTokens: 512,
      },
      sessionId: 'session-turn',
    });
    expect(
      operations.traceOperations
        .getLastTrace()
        ?.events.map((event: { type: string }) => event.type),
    ).toContain('user_prompt');
    expect(operations.traceOperations.getLastTrace()?.metadata).toEqual({
      model: 'glm-5.2',
      provider: 'openai-compatible',
      permissionMode: 'default',
    });
    expect(createAgentKernel).toHaveBeenCalledWith(
      expect.objectContaining({
        input: 'hello turn',
        modelId: 'glm-5.2',
        traceRecorder: expect.any(Object),
      }),
      {
        model,
        modelRequestDefaults: {
          maxContextTokens: 512,
        },
      },
    );
  });
});
