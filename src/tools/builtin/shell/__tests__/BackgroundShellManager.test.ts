import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContextSnapshot } from '../../../../runtime/index.js';
import { ExecutionLeaseId, FencingToken, SessionId } from '../../../../types/identifiers.js';
import { collectToolExecution } from '../../../types/result.js';
import { BackgroundShellManager } from '../BackgroundShellManager.js';
import { bashTool } from '../bash.js';

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ESRCH'
    );
  }
}

describe('BackgroundShellManager handoff admission', () => {
  const manager = BackgroundShellManager.getInstance();
  const originalHostSecret = process.env.BLADE_TEST_HOST_SECRET;

  beforeEach(() => {
    manager.killAll();
  });

  afterEach(() => {
    manager.killAll();
    if (originalHostSecret === undefined) {
      delete process.env.BLADE_TEST_HOST_SECRET;
    } else {
      process.env.BLADE_TEST_HOST_SECRET = originalHostSecret;
    }
  });

  it('exposes only explicit runtime and invocation environment variables', async () => {
    process.env.BLADE_TEST_HOST_SECRET = 'host-secret';
    const processInfo = manager.startBackgroundProcess({
      command: 'printf "%s|%s|%s" "$BLADE_TEST_HOST_SECRET" "$RUNTIME_ONLY" "$COMMAND_ONLY"',
      sessionId: SessionId('background-environment-session'),
      cwd: tmpdir(),
      runtimeEnvironment: {
        RUNTIME_ONLY: 'runtime',
      },
      env: {
        COMMAND_ONLY: 'command',
      },
    });

    await vi.waitFor(() => {
      expect(manager.getProcess(processInfo.id)?.status).not.toBe('running');
    });

    expect(manager.consumeOutput(processInfo.id)?.stdout).toBe('|runtime|command');
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
    if (process.platform !== 'win32') {
      expect(manager.getActiveProcessIds(firstSession)).toEqual([processInfo.id]);
    }
    await vi.waitFor(() => expect(manager.getActiveProcessIds(firstSession)).toEqual([]), {
      timeout: 2_000,
    });

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
    const executionFence = {
      leaseId: ExecutionLeaseId('bash-tool-lease'),
      fencingToken: FencingToken(3),
    };
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
        executionFence,
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
    expect(shellId ? manager.getProcess(shellId)?.executionFence : undefined).toEqual(
      executionFence,
    );
    expect(manager.getActiveProcessIds(childSessionId)).toEqual([]);
    if (shellId) {
      manager.kill(shellId);
    }
    await vi.waitFor(() => expect(manager.getActiveProcessIds(rootSessionId)).toEqual([]), {
      timeout: 2_000,
    });
  });

  it('seals a Session and terminates all of its shells after ownership loss', async () => {
    const lostSessionId = SessionId('lost-shell-session');
    const otherSessionId = SessionId('unrelated-shell-session');
    manager.openSession(lostSessionId);
    manager.openSession(otherSessionId);
    const first = manager.startBackgroundProcess({
      command: 'sleep 30',
      sessionId: lostSessionId,
      cwd: tmpdir(),
    });
    const second = manager.startBackgroundProcess({
      command: 'sleep 30',
      sessionId: lostSessionId,
      cwd: tmpdir(),
    });
    const unrelated = manager.startBackgroundProcess({
      command: 'sleep 30',
      sessionId: otherSessionId,
      cwd: tmpdir(),
    });

    await expect(manager.terminateSession(lostSessionId)).resolves.toEqual([first.id, second.id]);
    expect(() =>
      manager.startBackgroundProcess({
        command: 'true',
        sessionId: lostSessionId,
        cwd: tmpdir(),
      }),
    ).toThrow(/admission is closed/);
    expect(manager.getActiveProcessIds(lostSessionId)).toEqual([]);
    expect(manager.getActiveProcessIds(otherSessionId)).toEqual([unrelated.id]);
  });

  it('revokes only shells owned by the stale execution fence', async () => {
    const sessionId = SessionId('fenced-shell-session');
    const staleFence = {
      leaseId: ExecutionLeaseId('stale-shell-lease'),
      fencingToken: FencingToken(1),
    };
    const currentFence = {
      leaseId: ExecutionLeaseId('current-shell-lease'),
      fencingToken: FencingToken(2),
    };
    manager.openSession(sessionId);
    const stale = manager.startBackgroundProcess({
      command: 'sleep 30',
      sessionId,
      cwd: tmpdir(),
      executionFence: staleFence,
    });
    const current = manager.startBackgroundProcess({
      command: 'sleep 30',
      sessionId,
      cwd: tmpdir(),
      executionFence: currentFence,
    });

    await expect(manager.terminateExecutionFence(sessionId, staleFence)).resolves.toEqual([
      stale.id,
    ]);
    expect(manager.getActiveProcessIds(sessionId)).toEqual([current.id]);
    expect(() =>
      manager.startBackgroundProcess({
        command: 'true',
        sessionId,
        cwd: tmpdir(),
        executionFence: staleFence,
      }),
    ).toThrow(/admission is closed/);
    expect(() =>
      manager.startBackgroundProcess({
        command: 'true',
        sessionId,
        cwd: tmpdir(),
        executionFence: currentFence,
      }),
    ).not.toThrow();
  });

  it.skipIf(process.platform === 'win32')(
    'terminates the complete process group before releasing ownership',
    async () => {
      const sessionId = SessionId('process-tree-shell-session');
      const executionFence = {
        leaseId: ExecutionLeaseId('process-tree-shell-lease'),
        fencingToken: FencingToken(1),
      };
      const root = await mkdtemp(join(tmpdir(), 'blade-shell-tree-'));
      const childPidPath = join(root, 'child.pid');
      manager.openSession(sessionId);
      const shell = manager.startBackgroundProcess({
        command: `sleep 30 >/dev/null 2>&1 & echo $! > ${JSON.stringify(childPidPath)}; wait`,
        sessionId,
        cwd: root,
        executionFence,
      });
      let childPid = 0;
      await vi.waitFor(async () => {
        childPid = Number((await readFile(childPidPath, 'utf8')).trim());
        expect(Number.isSafeInteger(childPid) && childPid > 0).toBe(true);
      });

      try {
        await expect(
          manager.terminateExecutionFence(sessionId, executionFence, 500),
        ).resolves.toEqual([shell.id]);
        await vi.waitFor(() => expect(isProcessAlive(childPid)).toBe(false), {
          timeout: 2_000,
        });
      } finally {
        if (isProcessAlive(childPid)) {
          process.kill(childPid, 'SIGKILL');
        }
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
