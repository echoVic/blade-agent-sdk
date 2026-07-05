import { describe, expect, it, vi } from 'vitest';
import {
  createPackageLocalRuntimeTraceManager,
} from '../../packages/agent-sdk/src/session/runtimeTraceManager.js';

describe('agent-sdk package-local runtime trace manager helper', () => {
  it('creates session trace metadata from runtime model, provider, and default permission mode', () => {
    const manager = createPackageLocalRuntimeTraceManager({
      sessionId: 'session-1',
      observability: {
        enabled: true,
        capturePayloads: true,
      },
      model: 'glm-5.2',
      providerType: 'openai-compatible',
      logger: {
        warn: vi.fn(),
      },
    });

    const trace = manager.createRecorder('visible prompt')?.finish('success');

    expect(trace?.metadata).toEqual({
      model: 'glm-5.2',
      provider: 'openai-compatible',
      permissionMode: 'default',
    });
    expect(trace?.events.map((event) => event.type)).toContain('user_prompt');
  });

  it('logs sink failures through the runtime logger', async () => {
    const logger = {
      warn: vi.fn(),
    };
    const manager = createPackageLocalRuntimeTraceManager({
      sessionId: 'session-1',
      observability: {
        enabled: true,
        sink: async () => {
          throw new Error('sink failed');
        },
      },
      model: 'glm-5.2',
      providerType: 'openai-compatible',
      permissionMode: 'plan',
      logger,
    });
    const trace = manager.createRecorder('prompt')?.finish('success');
    if (!trace) {
      throw new Error('expected trace');
    }

    await manager.notifySink(trace);

    expect(logger.warn).toHaveBeenCalledWith(
      '[PackageLocalSessionRuntime] Observability trace sink failed:',
      expect.any(Error),
    );
  });
});
