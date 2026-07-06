import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const runtimeSessionLifecycleModulePath =
  '../../packages/agent-sdk/src/session/runtimeSessionLifecycle.js';
const runtimeSessionLifecycleSourcePath =
  'packages/agent-sdk/src/session/runtimeSessionLifecycle.ts';

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
});
