import { describe, expect, it, vi } from 'vitest';
import {
  createPackageLocalRuntimeTraceOperations,
  createPackageLocalRuntimeTraceManager,
  createPackageLocalRuntimeTraceRuntime,
} from '../../packages/agent-sdk/src/session/runtimeTraceManager.js';
import type { AgentTrace } from '../../packages/agent-sdk/src/observability/types.js';
import { PermissionMode } from '../../packages/agent-sdk/src/types/common.js';

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

  it('creates reusable trace access operations without session runtime state', () => {
    const firstTrace: AgentTrace = {
      id: 'trace-1',
      sessionId: 'session-1',
      status: 'success',
      startedAt: '2026-07-06T00:00:00.000Z',
      spans: [],
      events: [],
    };
    const lastTrace: AgentTrace = {
      id: 'trace-2',
      sessionId: 'session-1',
      status: 'success',
      startedAt: '2026-07-06T00:00:01.000Z',
      spans: [],
      events: [],
    };
    const traces = [firstTrace, lastTrace];
    const traceManager = {
      getLastTrace: vi.fn(() => lastTrace),
      getTraces: vi.fn(() => traces),
    };

    const operations = createPackageLocalRuntimeTraceOperations({
      traceManager,
    });

    expect(operations.getLastTrace()).toBe(lastTrace);
    expect(operations.getTraces()).toBe(traces);
    expect(traceManager.getLastTrace).toHaveBeenCalledOnce();
    expect(traceManager.getTraces).toHaveBeenCalledOnce();
  });

  it('creates trace runtime bundle with manager and access operations', () => {
    const runtime = createPackageLocalRuntimeTraceRuntime({
      sessionId: 'session-runtime',
      observability: {
        enabled: true,
      },
      model: 'glm-5.2',
      providerType: 'openai-compatible',
      permissionMode: PermissionMode.AUTO_EDIT,
      logger: {
        warn: vi.fn(),
      },
    });

    const trace = runtime.traceManager.createRecorder('bundle prompt')?.finish('success');
    if (!trace) {
      throw new Error('expected trace');
    }
    runtime.traceManager.remember(trace);

    expect(trace?.metadata).toEqual({
      model: 'glm-5.2',
      provider: 'openai-compatible',
      permissionMode: PermissionMode.AUTO_EDIT,
    });
    expect(runtime.traceOperations.getLastTrace()).toBe(trace);
    expect(runtime.traceOperations.getTraces()).toEqual([trace]);
  });
});
