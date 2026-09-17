import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionCheckpointId, ExecutionId } from '../../types/identifiers.js';
import { DockerExecutionHost } from '../DockerExecutionHost.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const image = `example.invalid/agent@sha256:${'a'.repeat(64)}`;
const resources = {
  cpus: 0.5,
  memoryBytes: 64 * 1024 * 1024,
  diskBytes: 8 * 1024 * 1024,
  pids: 16,
  runtimeMs: 30_000,
  maxOutputBytes: 8 * 1024,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  host: DockerExecutionHost;
  root: string;
  log: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'blade-docker-host-'));
  roots.push(root);
  const log = join(root, 'runtime.jsonl');
  const runtime = join(root, 'runtime.mjs');
  const simulatedWorkspace = join(root, 'container-workspace');
  await mkdir(simulatedWorkspace);
  await writeFile(join(simulatedWorkspace, 'checkpoint.txt'), 'checkpoint');
  await writeFile(
    runtime,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'exec' && args.includes('hang')) {
  setTimeout(() => undefined, 60_000);
} else if (args[0] === 'exec' && args.includes('tar') && args.includes('-xf')) {
  const result = spawnSync('tar', ['-xf', '-', '-C', ${JSON.stringify(simulatedWorkspace)}], {
    input: readFileSync(0),
  });
  process.exitCode = result.status ?? 1;
} else if (args[0] === 'exec' && args.includes('tar') && args.includes('-cf')) {
  const result = spawnSync('tar', ['-cf', '-', '-C', ${JSON.stringify(simulatedWorkspace)}, '.']);
  if (result.stdout) process.stdout.write(result.stdout);
  process.exitCode = result.status ?? 1;
}
`,
  );
  await chmod(runtime, 0o755);
  return {
    host: new DockerExecutionHost({
      runtimeBinary: runtime,
      rootDirectory: join(root, 'executions'),
      checkpointDirectory: join(root, 'checkpoints'),
    }),
    root,
    log,
  };
}

async function provision(
  host: DockerExecutionHost,
  executionId: string,
  workspace: { kind: 'empty' } | { kind: 'git-worktree'; repositoryPath: string; revision: string },
) {
  return host.provision({
    executionId: ExecutionId(executionId),
    image,
    workspace,
    resources,
    network: { mode: 'none' },
  });
}

describe('DockerExecutionHost', () => {
  it.runIf(process.env.TEST_DOCKER_IMAGE)(
    'round-trips files through a real tmpfs checkpoint',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'blade-docker-checkpoint-'));
      roots.push(root);
      const repository = join(root, 'repository');
      await mkdir(repository);
      await writeFile(join(repository, 'fixture.txt'), 'checkpoint-content\n');
      await execFileAsync('git', ['init', '--quiet', repository]);
      await execFileAsync('git', ['-C', repository, 'add', '.']);
      await execFileAsync('git', [
        '-C',
        repository,
        '-c',
        'user.name=Blade Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--quiet',
        '-m',
        'fixture',
      ]);
      const { stdout } = await execFileAsync('git', ['-C', repository, 'rev-parse', 'HEAD']);
      const host = new DockerExecutionHost({
        rootDirectory: join(root, 'executions'),
        checkpointDirectory: join(root, 'checkpoints'),
      });
      const source = await host.provision({
        executionId: ExecutionId('native-checkpoint-source'),
        image: process.env.TEST_DOCKER_IMAGE as string,
        workspace: { kind: 'git-worktree', repositoryPath: repository, revision: stdout.trim() },
        resources,
        network: { mode: 'none' },
      });
      const checkpoint = await host.checkpoint(source.executionId);
      await host.terminate(source.executionId);
      const restored = await host.restore({
        checkpointId: checkpoint.checkpointId,
        executionId: ExecutionId('native-checkpoint-restored'),
      });
      try {
        const result = await host.exec(restored.executionId, {
          command: 'cat',
          args: ['fixture.txt'],
        });
        expect(result).toMatchObject({ exitCode: 0, stdout: 'checkpoint-content\n' });
      } finally {
        await host.terminate(restored.executionId);
      }
    },
  );

  it('imports a Git revision into a bounded tmpfs workspace', async () => {
    const { host, root, log } = await fixture();
    const repository = join(root, 'repository');
    await mkdir(repository);
    await execFileAsync('git', ['init', '--quiet', repository]);
    await writeFile(join(repository, 'README.md'), 'fixture\n');
    await execFileAsync('git', ['-C', repository, 'add', '.']);
    await execFileAsync('git', [
      '-C',
      repository,
      '-c',
      'user.name=Blade Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ]);
    const { stdout } = await execFileAsync('git', ['-C', repository, 'rev-parse', 'HEAD']);

    await provision(host, 'git-source', {
      kind: 'git-worktree',
      repositoryPath: repository,
      revision: stdout.trim(),
    });

    const calls = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    const create = calls.find(([command]) => command === 'create');
    expect(create).toContain('--tmpfs');
    expect(create).toContain(
      `/workspace:rw,nosuid,nodev,noexec,size=${resources.diskBytes},uid=65532,gid=65532,mode=0700`,
    );
    expect(create?.some((value) => value.startsWith('type=bind'))).toBe(false);
    expect(calls.some(([command, flag]) => command === 'exec' && flag === '-i')).toBe(true);
  });

  it('terminates the execution when a command times out', async () => {
    const { host, log } = await fixture();
    const handle = await provision(host, 'timeout', { kind: 'empty' });

    await expect(
      host.exec(handle.executionId, { command: 'hang', timeoutMs: 10 }),
    ).rejects.toMatchObject({ code: 'EXECUTION_TIMEOUT' });

    const calls = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    expect(calls.some(([command, flag]) => command === 'rm' && flag === '-f')).toBe(true);
    await expect(host.exec(handle.executionId, { command: 'true' })).rejects.toMatchObject({
      code: 'EXECUTION_NOT_FOUND',
    });
  });

  it('rejects a malformed checkpoint manifest', async () => {
    const { host, root } = await fixture();
    const checkpointId = ExecutionCheckpointId('checkpoint-invalid');
    const directory = join(root, 'checkpoints', checkpointId);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'manifest.json'), '{}');

    await expect(host.restore({ checkpointId })).rejects.toMatchObject({
      code: 'EXECUTION_CHECKPOINT_INVALID',
    });
  });

  it('records checkpoint size and restores its workspace', async () => {
    const { host, log } = await fixture();
    const handle = await provision(host, 'checkpoint-source', { kind: 'empty' });

    const checkpoint = await host.checkpoint(handle.executionId, { requestId: 'request-1' });
    const restored = await host.restore({
      checkpointId: checkpoint.checkpointId,
      executionId: ExecutionId('checkpoint-restored'),
    });

    expect(checkpoint.sizeBytes).toBeGreaterThan(0);
    expect(checkpoint.metadata).toEqual({ requestId: 'request-1' });
    expect(restored.metadata).toEqual({ requestId: 'request-1' });
    const calls = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    expect(
      calls.some(
        ([command, flag, , , , , container]) =>
          command === 'exec' &&
          flag === '-i' &&
          container === 'blade-execution-checkpoint-restored',
      ),
    ).toBe(true);
  });

  it('removes local ownership when reclaiming an execution', async () => {
    const { host } = await fixture();
    const handle = await provision(host, 'reclaim', { kind: 'empty' });

    await host.reclaim(handle.executionId);

    await expect(host.exec(handle.executionId, { command: 'true' })).rejects.toMatchObject({
      code: 'EXECUTION_NOT_FOUND',
    });
  });
});
