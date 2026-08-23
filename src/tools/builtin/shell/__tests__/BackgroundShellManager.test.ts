import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContextSnapshot } from '../../../../runtime/index.js';
import { SessionId } from '../../../../types/branded.js';
import { collectToolExecution } from '../../../types/index.js';
import { BackgroundShellManager } from '../BackgroundShellManager.js';
import { bashTool } from '../bash.js';

describe('BackgroundShellManager handoff admission', () => {
  const manager = BackgroundShellManager.getInstance();

  beforeEach(() => {
    manager.killAll();
  });

  afterEach(() => {
    manager.killAll();
  });

  it('tracks live processes by Session and keeps killed processes active until exit', async () => {
    const firstSession = SessionId('handoff-shell-session');
    const secondSession = SessionId('other-shell-session');
    manager.openSession(firstSession);
    manager.openSession(secondSession);

    const processInfo = manager.startBackgroundProcess({
      command: 'sleep 30',
      sessionId: firstSession,
      cwd: tmpdir(),
    });

    expect(manager.getActiveProcessIds(firstSession)).toEqual([processInfo.id]);
    expect(manager.getActiveProcessIds(secondSession)).toEqual([]);
    manager.sealSessionForHandoff(firstSession);
    expect(() =>
      manager.startBackgroundProcess({
        command: 'true',
        sessionId: firstSession,
        cwd: tmpdir(),
      }),
    ).toThrow(/admission is closed/);

    expect(manager.kill(processInfo.id)).toMatchObject({
      success: true,
      status: 'killed',
    });
    expect(manager.getActiveProcessIds(firstSession)).toEqual([processInfo.id]);
    await vi.waitFor(
      () => expect(manager.getActiveProcessIds(firstSession)).toEqual([]),
      { timeout: 2_000 },
    );

    expect(() =>
      manager.startBackgroundProcess({
        command: 'true',
        sessionId: secondSession,
        cwd: tmpdir(),
      }),
    ).not.toThrow();
  });

  it('attributes Bash background processes to the calling Session', async () => {
    const rootSessionId = SessionId('bash-tool-root-session');
    const childSessionId = SessionId('bash-tool-child-session');
    manager.openSession(rootSessionId);
    const invocation = bashTool.build({
      command: 'sleep 30',
      timeout: 30_000,
      run_in_background: true,
    });

    const result = await collectToolExecution(
      invocation.execute(new AbortController().signal, {
        sessionId: childSessionId,
        backgroundAgentManager: {
          getOwnerSessionId: () => rootSessionId,
        } as never,
        contextSnapshot: createContextSnapshot(childSessionId, 'shell-turn', {
          capabilities: {
            filesystem: {
              roots: [tmpdir()],
              cwd: tmpdir(),
            },
          },
        }),
      }),
    );

    expect(result.status).toBe('success');
    const [shellId] = manager.getActiveProcessIds(rootSessionId);
    expect(shellId).toMatch(/^bash_/);
    expect(manager.getActiveProcessIds(childSessionId)).toEqual([]);
    if (shellId) {
      manager.kill(shellId);
    }
    await vi.waitFor(
      () => expect(manager.getActiveProcessIds(rootSessionId)).toEqual([]),
      { timeout: 2_000 },
    );
  });
});
