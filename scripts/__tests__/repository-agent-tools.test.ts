import { execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectToolExecution } from '../../src/tools/types/result.js';
import { createSession } from '../../src/session/Session.js';
import {
  CORRECTED_GREETING,
  createRepositoryTools,
  GREETING_PATH,
  GREETING_TEST,
  ORIGINAL_GREETING,
  TEST_PATH,
} from '../../examples/production-stack/RepositoryTools.mjs';
import { createRepositorySessionOptions } from '../../examples/production-stack/RepositoryDemoProvider.mjs';

const execFileAsync = promisify(execFile);
const fixture = resolve('examples/production-stack/fixture');
const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * Feed a fixture command its stdin. A command that exits without reading its
 * input closes the pipe first, so the write must not surface as an unhandled
 * stream error while the caller asserts the resulting exit code.
 */
function feedStdin(
  pending: Promise<unknown> & { child: ChildProcess },
  stdin: string,
): void {
  const stream = pending.child.stdin;
  if (stream === null) {
    return;
  }
  stream.on('error', () => {
    // The exit code already reports a command that stopped reading stdin.
  });
  stream.end(stdin);
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'blade-repository-tools-'));
  directories.push(directory);
  await cp(fixture, directory, { recursive: true });
  const checkpoint = vi.fn(async () => undefined);
  const host = {
    exec: vi.fn(async (_executionId, request) => {
      // Run the same fixed programs against a disposable fixture for fast tests.
      // Production supplies DockerExecutionHost instead of this process adapter.
      const child = execFileAsync(request.command, request.args, {
        cwd: directory,
        signal: request.signal,
        timeout: request.timeoutMs,
        encoding: 'utf8',
        maxBuffer: 64 * 1024,
      });
      feedStdin(child, request.stdin ?? '');
      try {
        const result = await child;
        return { ...result, exitCode: 0 };
      } catch (error) {
        if (typeof error.code !== 'number') throw error;
        return { stdout: error.stdout, stderr: error.stderr, exitCode: error.code };
      }
    }),
  };
  const getHandle = vi.fn(async (signal) => {
    signal?.throwIfAborted();
    return { executionId: 'fixture-execution' };
  });
  const tools = createRepositoryTools({ host, getHandle, checkpoint });
  const invoke = async (name, input, context = {}) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Unknown test tool ${name}`);
    return collectToolExecution(tool.execute(input, context));
  };
  return { directory, host, getHandle, checkpoint, tools, invoke };
}

const writeInput = {
  file_path: GREETING_PATH,
  expected_content: ORIGINAL_GREETING,
  content: CORRECTED_GREETING,
};

describe('repository fixture tools', () => {
  it('ships a failing fixture and accepts a real alternative fix before running the trusted tests', async () => {
    const { invoke, directory, checkpoint, tools } = await setup();
    expect(await readFile(join(directory, GREETING_PATH), 'utf8')).toBe(ORIGINAL_GREETING);
    expect(await readFile(join(directory, TEST_PATH), 'utf8')).toBe(GREETING_TEST);
    expect((await invoke('RepoRunTests', {})).model).toMatchObject({ passed: false, exitCode: 1 });
    const alternative = '#!/bin/sh\nset -eu\nname=${1:-World}\nprintf "Hello, %s!\\n" "$name"\n';
    const written = await invoke('RepoWrite', { ...writeInput, content: alternative });
    expect(written.model).toMatchObject({ changed: true, after: alternative });
    expect(checkpoint).toHaveBeenCalledWith({
      executionId: 'fixture-execution', path: GREETING_PATH, content: alternative, toolName: 'RepoWrite', signal: undefined,
    });
    expect((await invoke('RepoRunTests', {})).model).toMatchObject({
      passed: true,
      exitCode: 0,
      stdout: 'PASS greeting: Hello, Blade!\nPASS default greeting: Hello, World!\n',
    });
    expect(tools.find((tool) => tool.name === 'RepoRunTests').sideEffect).toBe('non_idempotent');
  });

  it('rejects paths, commands, and oversized or binary writes before reaching the host', async () => {
    const { invoke, host, getHandle } = await setup();
    for (const input of [
      { file_path: '../src/greeting.sh' },
      { file_path: '/workspace/src/greeting.sh' },
      { file_path: 'src/../src/greeting.sh' },
      { file_path: `${GREETING_PATH}; touch injected` },
      { file_path: GREETING_PATH, command: 'id' },
    ]) expect((await invoke('RepoRead', input)).status).toBe('error');
    for (const input of [
      { ...writeInput, file_path: TEST_PATH },
      { ...writeInput, content: '\0' },
      { ...writeInput, content: '字'.repeat(6_000) },
      { ...writeInput, expected_content: '\0' },
      { ...writeInput, content: null },
      { ...writeInput, command: 'id' },
    ]) expect((await invoke('RepoWrite', input)).status).toBe('error');
    expect((await invoke('RepoRunTests', { command: 'id' })).status).toBe('error');
    expect(host.exec).not.toHaveBeenCalled();
    expect(getHandle).not.toHaveBeenCalled();
  });

  it('checks expected content byte-for-byte and makes a retry idempotent', async () => {
    const { invoke, directory, checkpoint, host } = await setup();
    const stale = await invoke('RepoWrite', { ...writeInput, expected_content: ORIGINAL_GREETING.trimEnd() });
    expect(stale.status).toBe('error');
    expect(await readFile(join(directory, GREETING_PATH), 'utf8')).toBe(ORIGINAL_GREETING);
    expect(checkpoint).not.toHaveBeenCalled();
    expect((await invoke('RepoWrite', writeInput)).model).toMatchObject({ changed: true });
    expect((await invoke('RepoWrite', writeInput)).model).toMatchObject({ changed: false });
    expect(await readFile(join(directory, GREETING_PATH), 'utf8')).toBe(CORRECTED_GREETING);
    expect(checkpoint).toHaveBeenCalledTimes(2);
    for (const [, request] of host.exec.mock.calls) {
      expect(request.command).toBe('/bin/sh');
      expect(request.args.slice(0, 1)).toEqual(['-c']);
      expect(request.stdin).toBe(CORRECTED_GREETING);
      expect(request.args[1]).not.toContain(CORRECTED_GREETING);
    }
  });

  it('does not report success before checkpoint commits and supports retry after checkpoint failure', async () => {
    const { invoke, checkpoint, directory } = await setup();
    checkpoint.mockRejectedValueOnce(new Error('checkpoint unavailable'));
    await expect(invoke('RepoWrite', writeInput)).rejects.toThrow('checkpoint unavailable');
    expect(await readFile(join(directory, GREETING_PATH), 'utf8')).toBe(CORRECTED_GREETING);
    expect((await invoke('RepoWrite', writeInput)).model).toMatchObject({ changed: false });
    expect(checkpoint).toHaveBeenCalledTimes(2);
  });

  it('refuses symlinked files and source directories, and never executes modified tests', async () => {
    const { invoke, directory, checkpoint } = await setup();
    await rm(join(directory, GREETING_PATH));
    await symlink('../test/greeting.test.sh', join(directory, GREETING_PATH));
    expect((await invoke('RepoRead', { file_path: GREETING_PATH })).status).toBe('error');
    expect((await invoke('RepoWrite', writeInput)).status).toBe('error');
    expect((await invoke('RepoRunTests', {})).status).toBe('error');
    expect(checkpoint).not.toHaveBeenCalled();
    await rm(join(directory, 'src'), { recursive: true });
    await symlink('test', join(directory, 'src'));
    expect((await invoke('RepoRead', { file_path: GREETING_PATH })).status).toBe('error');
    await rm(join(directory, 'src'));
    await cp(join(fixture, 'src'), join(directory, 'src'), { recursive: true });
    await writeFile(join(directory, TEST_PATH), 'touch test-should-not-run\n');
    expect((await invoke('RepoRunTests', {})).status).toBe('error');
    await expect(readFile(join(directory, 'test-should-not-run'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('honors an already aborted tool signal before provisioning or executing', async () => {
    const { invoke, getHandle, host } = await setup();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(invoke('RepoRead', { file_path: GREETING_PATH }, { signal: controller.signal })).rejects.toThrow('cancelled');
    expect(getHandle).not.toHaveBeenCalled();
    expect(host.exec).not.toHaveBeenCalled();
  });
});

describe('repository demo provider through the actual SDK loop', () => {
  it.each([true, false])('requires approval before the write (approved=%s)', async (approved) => {
    const { tools, directory, checkpoint } = await setup();
    const confirmations = vi.fn(async () => {
      expect(await readFile(join(directory, GREETING_PATH), 'utf8')).toBe(ORIGINAL_GREETING);
      expect(checkpoint).not.toHaveBeenCalled();
      return { approved, reason: approved ? 'Approved for test' : 'Denied for test' };
    });
    const session = await createSession(createRepositorySessionOptions({
      smoke: true,
      tools,
      confirmationHandler: { requestConfirmation: confirmations },
    }));
    try {
      await session.send('Fix the greeting and run its tests.');
      const events = [];
      for await (const event of session.stream()) events.push(event);
      const toolNames = events.filter((event) => event.type === 'tool_use').map((event) => event.name);
      const result = events.findLast((event) => event.type === 'result');
      expect(confirmations).toHaveBeenCalledTimes(1);
      expect(toolNames).toEqual(approved ? ['RepoRead', 'RepoWrite', 'RepoRunTests'] : ['RepoRead', 'RepoWrite']);
      expect(result?.content).toContain(approved ? 'Tests passed (exit 0)' : 'No file changes were applied');
      expect(await readFile(join(directory, GREETING_PATH), 'utf8')).toBe(approved ? CORRECTED_GREETING : ORIGINAL_GREETING);
      expect(checkpoint).toHaveBeenCalledTimes(approved ? 1 : 0);
    } finally {
      await session.close();
    }
  });

  it('reads an already recovered correction and tests it without another write or approval', async () => {
    const { tools, directory, checkpoint } = await setup();
    await writeFile(join(directory, GREETING_PATH), CORRECTED_GREETING);
    const requestConfirmation = vi.fn(async () => ({ approved: false }));
    const session = await createSession(createRepositorySessionOptions({
      smoke: true, tools, confirmationHandler: { requestConfirmation },
    }));
    try {
      await session.send('Continue the greeting task after recovering the workspace.');
      const events = [];
      for await (const event of session.stream()) events.push(event);
      expect(events.filter((event) => event.type === 'tool_use').map((event) => event.name)).toEqual(['RepoRead', 'RepoRunTests']);
      expect(events.findLast((event) => event.type === 'result')?.content).toContain('Tests passed (exit 0)');
      expect(requestConfirmation).not.toHaveBeenCalled();
      expect(checkpoint).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
  });

  it('uses a real configured provider normally and always stays offline in smoke mode', () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-provider-key');
    vi.stubEnv('OPENAI_MODEL', 'test-model');
    const configured = createRepositorySessionOptions();
    expect(configured.provider).toEqual({ type: 'openai', apiKey: 'test-provider-key' });
    expect(configured.model).toBe('test-model');
    const smoke = createRepositorySessionOptions({ smoke: true });
    expect(smoke.provider).toEqual({ type: 'repository-demo' });
    expect(smoke.providerRegistry).toBeDefined();
    vi.stubEnv('OPENAI_API_KEY', '');
    expect(createRepositorySessionOptions().provider.type).toBe('repository-demo');
  });
});
