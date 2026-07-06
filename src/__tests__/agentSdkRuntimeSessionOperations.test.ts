import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const runtimeSessionOperationsModulePath =
  '../../packages/agent-sdk/src/session/runtimeSessionOperations.js';
const runtimeSessionOperationsSourcePath =
  'packages/agent-sdk/src/session/runtimeSessionOperations.ts';

describe('agent-sdk package-local runtime session operations', () => {
  it('bundles session lifecycle and workspace turn operations behind injected ports', async () => {
    expect(existsSync(runtimeSessionOperationsSourcePath)).toBe(true);

    const { createPackageLocalRuntimeSessionOperations } = await import(
      runtimeSessionOperationsModulePath
    );
    const calls: unknown[] = [];
    const operations = createPackageLocalRuntimeSessionOperations({
      sessionId: 'session-1',
      sessionStore: {
        createSession(sessionId: string) {
          calls.push(['create', sessionId]);
        },
        loadSession(sessionId: string) {
          calls.push(['load', sessionId]);
          return false;
        },
        loadMessages(sessionId: string) {
          calls.push(['messages', sessionId]);
          return [{ role: 'user', content: 'hello' }];
        },
      },
      workspace: {
        updateWorkspace(update: unknown) {
          calls.push(['workspace', update]);
        },
      },
    });

    await operations.lifecycle.ensureSessionCreated();
    await operations.lifecycle.ensureSessionLoaded();
    await expect(operations.lifecycle.loadMessages()).resolves.toEqual([
      { role: 'user', content: 'hello' },
    ]);
    operations.workspace.prepareTurn({
      cwd: '/workspace/project',
      environment: {
        NODE_ENV: 'test',
      },
      files: [],
    });

    expect(calls).toEqual([
      ['create', 'session-1'],
      ['load', 'session-1'],
      ['create', 'session-1'],
      ['messages', 'session-1'],
      [
        'workspace',
        {
          projectPath: '/workspace/project',
          environment: {
            NODE_ENV: 'test',
            cwd: '/workspace/project',
          },
        },
      ],
    ]);
  });
});
