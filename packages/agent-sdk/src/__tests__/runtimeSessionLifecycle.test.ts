import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const runtimeSessionLifecycleModulePath =
  '../session/runtimeSessionLifecycle.js';
const runtimeSessionLifecycleSourcePath =
  'src/session/runtimeSessionLifecycle.ts';

describe('agent-sdk package-local runtime session lifecycle helpers', () => {
  it('creates, loads with fallback materialization, and reads messages without runtime state', async () => {
    expect(existsSync(runtimeSessionLifecycleSourcePath)).toBe(true);

    const { createPackageLocalRuntimeSessionLifecycleOperations } = await import(
      runtimeSessionLifecycleModulePath
    );
    const calls: string[] = [];
    const messages = [{ role: 'user', content: 'hello' }];
    const sessionStore = {
      createSession: vi.fn(async (sessionId: string) => {
        calls.push(`create:${sessionId}`);
      }),
      loadSession: vi.fn(async (sessionId: string) => {
        calls.push(`load:${sessionId}`);
        return sessionId === 'existing-session';
      }),
      loadMessages: vi.fn(async (sessionId: string) => {
        calls.push(`messages:${sessionId}`);
        return messages;
      }),
    };

    const operations = createPackageLocalRuntimeSessionLifecycleOperations({
      sessionId: 'session-1',
      sessionStore,
    });

    await operations.ensureSessionCreated();
    await operations.ensureSessionLoaded();
    await expect(operations.loadMessages()).resolves.toBe(messages);

    const resumedOperations = createPackageLocalRuntimeSessionLifecycleOperations({
      sessionId: 'existing-session',
      sessionStore,
    });

    await resumedOperations.ensureSessionLoaded();

    expect(calls).toEqual([
      'create:session-1',
      'load:session-1',
      'create:session-1',
      'messages:session-1',
      'load:existing-session',
    ]);
  });

  it('runs session start/end hooks and always closes runtime resources', async () => {
    const { createPackageLocalRuntimeSessionLifecycleOperations } = await import(
      runtimeSessionLifecycleModulePath
    );
    const hookRuntime = {
      runSessionStart: vi.fn(),
      runSessionEnd: vi.fn(),
    };
    const closeRuntimeResources = vi.fn();

    const operations = createPackageLocalRuntimeSessionLifecycleOperations({
      sessionId: 'session-1',
      sessionStore: {
        createSession: vi.fn(),
        loadSession: vi.fn(),
        loadMessages: vi.fn(),
      },
      hookRuntime,
      model: 'model-a',
      provider: 'openai-compatible',
      closeRuntimeResources,
    });

    await operations.runSessionStart(false);
    await operations.runSessionStart(true);
    await operations.close();

    expect(hookRuntime.runSessionStart).toHaveBeenNthCalledWith(1, {
      isResume: false,
      model: 'model-a',
      provider: 'openai-compatible',
    });
    expect(hookRuntime.runSessionStart).toHaveBeenNthCalledWith(2, {
      isResume: true,
      resumeSessionId: 'session-1',
      model: 'model-a',
      provider: 'openai-compatible',
    });
    expect(hookRuntime.runSessionEnd).toHaveBeenCalledWith({ reason: 'other' });
    expect(closeRuntimeResources).toHaveBeenCalledTimes(1);

    hookRuntime.runSessionEnd.mockRejectedValueOnce(new Error('hook failed'));
    await expect(operations.close()).rejects.toThrow('hook failed');
    expect(closeRuntimeResources).toHaveBeenCalledTimes(2);
  });
});
