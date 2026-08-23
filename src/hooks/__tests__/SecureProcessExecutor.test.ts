import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionId } from '../../types/branded.js';
import { PermissionMode } from '../../types/common.js';
import { HookEvent } from '../../types/constants.js';
import { signalProcessTree } from '../../tools/builtin/shell/processTree.js';
import { DEFAULT_HOOK_CONFIG } from '../HookConfig.js';
import { SecureProcessExecutor } from '../SecureProcessExecutor.js';
import type { HookExecutionContext, HookInput } from '../types/HookTypes.js';
import { HookProcessContainmentError } from '../WindowsProcessJob.js';

const roots: string[] = [];
const processGroups = new Set<number>();

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function quoteShellArgument(value: string): string {
  if (process.platform === 'win32') {
    return `"${value.replaceAll('"', '\\"')}"`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function createInput(projectDir: string, payloadSize = 0): HookInput {
  return {
    hook_event_name: HookEvent.PreToolUse,
    hook_execution_id: 'hook-execution-1',
    timestamp: new Date().toISOString(),
    project_dir: projectDir,
    session_id: 'session-hook-process',
    permission_mode: PermissionMode.DEFAULT,
    tool_name: 'TestTool',
    tool_use_id: 'tool-use-1',
    tool_input: payloadSize > 0 ? { payload: 'x'.repeat(payloadSize) } : {},
  };
}

function createContext(projectDir: string, abortSignal?: AbortSignal): HookExecutionContext {
  return {
    projectDir,
    sessionId: SessionId('session-hook-process'),
    permissionMode: PermissionMode.DEFAULT,
    config: DEFAULT_HOOK_CONFIG,
    abortSignal,
  };
}

async function createProcessTreeFixture(
  root: string,
  parentExits = false,
  markerDelayMs = 500,
): Promise<{
  command: string;
  markerPath: string;
  readyPath: string;
}> {
  const childPath = join(root, 'child.mjs');
  const parentPath = join(root, 'parent.mjs');
  const markerPath = join(root, 'grandchild-survived');
  const readyPath = join(root, 'parent-ready');
  await writeFile(
    childPath,
    [
      "import { writeFileSync } from 'node:fs';",
      "process.on('SIGTERM', () => {});",
      'setTimeout(() => {',
      "  writeFileSync(process.argv[2], 'survived');",
      '  process.exit(0);',
      '}, Number(process.argv[3]));',
    ].join('\n'),
  );
  await writeFile(
    parentPath,
    [
      "import { spawn } from 'node:child_process';",
      "import { execFileSync } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      "const parentExits = process.argv[5] === 'exit';",
      'const child = spawn(process.execPath, [process.argv[2], process.argv[3], process.argv[6]], {',
      "  stdio: 'ignore',",
      '});',
      "const groupPid = process.platform === 'win32'",
      '  ? process.pid',
      "  : Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());",
      'writeFileSync(process.argv[4], JSON.stringify({ groupPid, parentPid: process.pid, childPid: child.pid }));',
      'if (parentExits) {',
      '  process.exit(0);',
      '}',
      "process.on('SIGTERM', () => {});",
      'setInterval(() => {}, 1_000);',
    ].join('\n'),
  );
  return {
    command: [
      quoteShellArgument(process.execPath),
      quoteShellArgument(parentPath),
      quoteShellArgument(childPath),
      quoteShellArgument(markerPath),
      quoteShellArgument(readyPath),
      quoteShellArgument(parentExits ? 'exit' : 'wait'),
      quoteShellArgument(String(markerDelayMs)),
    ].join(' '),
    markerPath,
    readyPath,
  };
}

afterEach(async () => {
  for (const pid of processGroups) {
    try {
      signalProcessTree(pid, 'SIGKILL');
    } catch {
      // The process group was already reaped.
    }
  }
  processGroups.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('SecureProcessExecutor', () => {
  it('rejects an invalid process termination grace period', () => {
    expect(() => new SecureProcessExecutor(0)).toThrow(
      'Hook process termination grace must be a positive safe integer',
    );
  });

  it('preserves normal completion and removes the abort listener', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hook-complete-'));
    roots.push(root);
    const controller = new AbortController();
    const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener');
    const executor = new SecureProcessExecutor(50);

    const result = await executor.execute(
      `${quoteShellArgument(process.execPath)} -e ${quoteShellArgument(
        "process.stdout.write('ok')",
      )}`,
      createInput(root),
      createContext(root, controller.signal),
      5_000,
    );

    expect(result).toEqual({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    });
    expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('preserves a successful exit when the hook closes stdin early', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hook-stdin-close-'));
    roots.push(root);
    const executor = new SecureProcessExecutor(50);

    const result = await executor.execute(
      `${quoteShellArgument(process.execPath)} -e ${quoteShellArgument(
        "require('node:fs').closeSync(0); process.stdout.write('ok'); setTimeout(() => process.exit(0), 50)",
      )}`,
      createInput(root, 96 * 1024),
      createContext(root),
      5_000,
    );

    expect(result).toEqual({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    });
  });

  it('does not spawn a command for an already-aborted hook', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hook-pre-abort-'));
    roots.push(root);
    const markerPath = join(root, 'should-not-exist');
    const controller = new AbortController();
    controller.abort(new Error('request cancelled'));
    const executor = new SecureProcessExecutor(50);

    const result = await executor.execute(
      `${quoteShellArgument(process.execPath)} -e ${quoteShellArgument(
        `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'spawned')`,
      )}`,
      createInput(root),
      createContext(root, controller.signal),
      5_000,
    );

    expect(result).toMatchObject({
      exitCode: 1,
      timedOut: false,
      stderr: 'Hook cancelled by abort signal',
    });
    expect(await pathExists(markerPath)).toBe(false);
  });

  it.each([
    { mode: 'abort' as const, expectedTimeout: false },
    { mode: 'timeout' as const, expectedTimeout: true },
  ])('terminates and reaps the hook process tree on $mode', async ({ mode, expectedTimeout }) => {
    const root = await mkdtemp(join(tmpdir(), `hook-${mode}-tree-`));
    roots.push(root);
    const fixture = await createProcessTreeFixture(
      root,
      false,
      mode === 'timeout' && process.platform === 'win32' ? 5_000 : 500,
    );
    const controller = new AbortController();
    const executor = new SecureProcessExecutor(50);
    const execution = executor.execute(
      fixture.command,
      createInput(root),
      createContext(root, controller.signal),
      mode === 'timeout'
        ? process.platform === 'win32'
          ? 2_000
          : 200
        : 5_000,
    );

    await vi.waitFor(
      async () => {
        expect(await pathExists(fixture.readyPath)).toBe(true);
      },
      { timeout: 5_000 },
    );
    const { groupPid, childPid } = JSON.parse(await readFile(fixture.readyPath, 'utf8')) as {
      groupPid: number;
      childPid: number;
    };
    expect(groupPid).toBeGreaterThan(0);
    expect(groupPid).not.toBe(process.pid);
    processGroups.add(groupPid);
    if (mode === 'abort') {
      controller.abort(new Error('request cancelled'));
    }

    await expect(execution).resolves.toMatchObject({
      exitCode: expectedTimeout ? 124 : 1,
      timedOut: expectedTimeout,
    });
    await new Promise((resolve) => setTimeout(resolve, 550));

    expect(await pathExists(fixture.markerPath)).toBe(false);
    await vi.waitFor(
      () => {
        expect(() => process.kill(childPid, 0)).toThrow();
      },
      { timeout: 2_000 },
    );
    processGroups.delete(groupPid);
  });

  it(
    'reaps descendants after the hook command parent has exited',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'hook-exited-parent-'));
      roots.push(root);
      const fixture = await createProcessTreeFixture(root, true);
      const executor = new SecureProcessExecutor(50);
      const execution = executor.execute(
        fixture.command,
        createInput(root),
        createContext(root),
        5_000,
      );

      await vi.waitFor(
        async () => {
          expect(await pathExists(fixture.readyPath)).toBe(true);
        },
        { timeout: 2_000 },
      );
      const { groupPid, parentPid, childPid } = JSON.parse(
        await readFile(fixture.readyPath, 'utf8'),
      ) as { groupPid: number; parentPid: number; childPid: number };
      processGroups.add(groupPid);
      processGroups.add(childPid);
      await vi.waitFor(
        () => {
          expect(() => process.kill(parentPid, 0)).toThrow();
        },
        { timeout: 2_000 },
      );

      await expect(execution).resolves.toMatchObject({
        exitCode: 0,
        timedOut: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 550));

      expect(await pathExists(fixture.markerPath)).toBe(false);
      await vi.waitFor(
        () => {
          expect(() => process.kill(childPid, 0)).toThrow();
        },
        { timeout: 2_000 },
      );
      processGroups.delete(groupPid);
      processGroups.delete(childPid);
    },
  );

  it.runIf(process.platform === 'win32')(
    'fails closed when the contained wrapper cannot spawn',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'hook-invalid-cwd-'));
      roots.push(root);
      const executor = new SecureProcessExecutor(50);

      await expect(
        executor.execute(
          'echo should-not-run',
          createInput(root),
          createContext(join(root, 'missing')),
          5_000,
        ),
      ).rejects.toBeInstanceOf(HookProcessContainmentError);
    },
  );
});
