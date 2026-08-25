import { execFile } from 'node:child_process';
import {
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { ExecutionId } from '../../types/identifiers.js';
import { EphemeralCredentialBroker } from '../CredentialBroker.js';
import { DockerExecutionHost } from '../DockerExecutionHost.js';
import type {
  ExecutionEgressController,
  ExecutionNetworkPolicy,
  ExecutionResourceLimits,
} from '../ExecutionHost.js';

const execFileAsync = promisify(execFile);
const image = process.env.TEST_DOCKER_IMAGE;
const describeDocker = image ? describe : describe.skip;

const defaultResources: ExecutionResourceLimits = {
  cpus: 0.5,
  memoryBytes: 64 * 1024 * 1024,
  diskBytes: 16 * 1024 * 1024,
  pids: 64,
  runtimeMs: 30_000,
  maxOutputBytes: 1024 * 1024,
};

async function docker(args: readonly string[]): Promise<string> {
  const result = await execFileAsync('docker', [...args], {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function dockerObjectExists(
  kind: 'container' | 'network' | 'volume',
  name: string,
): Promise<boolean> {
  try {
    await docker([kind, 'inspect', name]);
    return true;
  } catch {
    return false;
  }
}

async function executionWorkspaceVolume(
  executionId: ReturnType<typeof ExecutionId>,
): Promise<string> {
  const inspection = JSON.parse(
    await docker(['inspect', `blade-execution-${executionId}`]),
  )[0];
  const workspaceMount = inspection.Mounts.find(
    (mount: { Destination: string }) =>
      mount.Destination === '/workspace',
  );
  if (!workspaceMount?.Name) {
    throw new Error(`Execution ${executionId} has no workspace volume`);
  }
  return workspaceMount.Name;
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms`);
}

describeDocker('DockerExecutionHost integration', () => {
  let testRoot: string;
  let host: DockerExecutionHost | undefined;
  const executionIds = new Set<ReturnType<typeof ExecutionId>>();
  const networkNames = new Set<string>();
  const volumeNames = new Set<string>();

  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'blade-docker-host-test-'));
  });

  afterEach(async () => {
    if (host) {
      await Promise.allSettled(
        [...executionIds].map((executionId) => host?.terminate(executionId)),
      );
    }
    await Promise.allSettled(
      [...networkNames].map((networkName) =>
        docker(['network', 'rm', networkName])),
    );
    await Promise.allSettled(
      [...volumeNames].map((volumeName) =>
        docker(['volume', 'rm', volumeName])),
    );
    executionIds.clear();
    networkNames.clear();
    volumeNames.clear();
    await rm(testRoot, { recursive: true, force: true });
  });

  it('provisions an isolated worktree, checkpoints it, and restores it', async () => {
    if (!image) {
      throw new Error('TEST_DOCKER_IMAGE is required');
    }
    const repositoryPath = join(testRoot, 'repository');
    await execFileAsync('git', ['init', '--initial-branch', 'main', repositoryPath]);
    await writeFile(join(repositoryPath, 'README.md'), 'seed\n', 'utf8');
    await execFileAsync('git', ['-C', repositoryPath, 'add', 'README.md']);
    await execFileAsync('git', [
      '-C',
      repositoryPath,
      '-c',
      'user.name=Blade Test',
      '-c',
      'user.email=blade@example.invalid',
      'commit',
      '-m',
      'seed',
    ]);

    host = new DockerExecutionHost({
      rootDirectory: join(testRoot, 'host'),
    });
    const sourceExecutionId = ExecutionId('docker-lifecycle-source');
    executionIds.add(sourceExecutionId);
    const source = await host.provision({
      executionId: sourceExecutionId,
      image,
      workspace: {
        kind: 'git-worktree',
        repositoryPath,
        revision: 'HEAD',
      },
      resources: defaultResources,
      network: { mode: 'none' },
      metadata: { purpose: 'integration-test' },
    });

    expect(source).toMatchObject({
      executionId: sourceExecutionId,
      state: 'provisioned',
      network: { mode: 'none' },
      metadata: { purpose: 'integration-test' },
    });
    const inspection = JSON.parse(
      await docker(['inspect', `blade-execution-${sourceExecutionId}`]),
    )[0];
    expect(inspection).toMatchObject({
      Config: {
        Entrypoint: ['/bin/sh'],
        User: '65532:65532',
      },
      HostConfig: {
        AutoRemove: true,
        Memory: defaultResources.memoryBytes,
        MemorySwap: defaultResources.memoryBytes,
        PidsLimit: defaultResources.pids,
        ReadonlyRootfs: true,
        NetworkMode: 'none',
        ShmSize: Math.floor(defaultResources.diskBytes / 20),
      },
    });
    expect(inspection.HostConfig.NanoCpus).toBe(500_000_000);
    expect(inspection.HostConfig.CapDrop).toContain('ALL');
    expect(inspection.HostConfig.CapAdd ?? []).toEqual([]);
    expect(inspection.HostConfig.SecurityOpt).toContain('no-new-privileges');
    const workspaceMount = inspection.Mounts.find(
      (mount: { Destination: string }) =>
        mount.Destination === '/workspace',
    );
    expect(workspaceMount).toMatchObject({
      Type: 'volume',
      RW: true,
    });
    volumeNames.add(workspaceMount.Name);
    const volumeInspection = JSON.parse(
      await docker(['volume', 'inspect', workspaceMount.Name]),
    )[0];
    expect(volumeInspection).toMatchObject({
      Driver: 'local',
      Labels: {
        'com.docker.volume.anonymous': '',
      },
      Options: {
        device: 'tmpfs',
        type: 'tmpfs',
      },
    });
    expect(volumeInspection.Options.o).toContain(
      `size=${
        defaultResources.diskBytes
        - Math.floor(defaultResources.diskBytes / 10)
        - Math.floor(defaultResources.diskBytes / 20)
      }`,
    );

    await expect(host.exec(sourceExecutionId, {
      command: '/bin/sh',
      args: ['-c', 'cat README.md; test ! -e .git'],
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'seed\n',
    });
    await expect(host.exec(sourceExecutionId, {
      command: '/bin/sh',
      args: ['-c', 'printf checkpoint > state.txt'],
    })).resolves.toMatchObject({ exitCode: 0 });
    const checkpoint = await host.checkpoint(sourceExecutionId, {
      stage: 'before-mutation',
    });
    expect(checkpoint.checkpointId).toMatch(/^checkpoint-/);
    await expect(host.exec(sourceExecutionId, {
      command: '/bin/sh',
      args: ['-c', 'printf mutated > state.txt'],
    })).resolves.toMatchObject({ exitCode: 0 });

    const restoredExecutionId = ExecutionId('docker-lifecycle-restored');
    executionIds.add(restoredExecutionId);
    await host.restore({
      checkpointId: checkpoint.checkpointId,
      executionId: restoredExecutionId,
    });
    const restoredVolumeName = await executionWorkspaceVolume(
      restoredExecutionId,
    );
    volumeNames.add(restoredVolumeName);
    await expect(host.exec(restoredExecutionId, {
      command: 'cat',
      args: ['state.txt'],
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'checkpoint',
    });

    const diskResult = await host.exec(restoredExecutionId, {
      command: '/bin/sh',
      args: [
        '-c',
        'dd if=/dev/zero of=/workspace/too-large bs=1048576 count=32 2>/dev/null',
      ],
    });
    expect(diskResult.exitCode).not.toBe(0);

    const worktrees = await execFileAsync(
      'git',
      ['-C', repositoryPath, 'worktree', 'list', '--porcelain'],
      { encoding: 'utf8' },
    );
    expect(worktrees.stdout).not.toContain('/execution-');

    await host.terminate(sourceExecutionId);
    await host.terminate(restoredExecutionId);
    expect(await dockerObjectExists(
      'container',
      `blade-execution-${sourceExecutionId}`,
    )).toBe(false);
    expect(await dockerObjectExists(
      'container',
      `blade-execution-${restoredExecutionId}`,
    )).toBe(false);
    expect(await dockerObjectExists('volume', workspaceMount.Name)).toBe(false);
    expect(await dockerObjectExists('volume', restoredVolumeName)).toBe(false);
  }, 60_000);

  it('injects credentials for one command without persisting or disclosing them', async () => {
    if (!image) {
      throw new Error('TEST_DOCKER_IMAGE is required');
    }
    const revoke = vi.fn(async () => undefined);
    const secret = 'integration-ephemeral-secret';
    const broker = new EphemeralCredentialBroker({
      test: {
        environmentVariable: 'BLADE_EPHEMERAL_TOKEN',
        async issue(context) {
          return {
            value: secret,
            expiresAt: new Date(
              Date.parse(context.expiresBy) - 1,
            ).toISOString(),
            revoke,
          };
        },
      },
    });
    host = new DockerExecutionHost({
      rootDirectory: join(testRoot, 'host'),
      credentialBroker: broker,
    });
    const executionId = ExecutionId('docker-credential');
    executionIds.add(executionId);
    await host.provision({
      executionId,
      image,
      workspace: { kind: 'empty' },
      resources: defaultResources,
      network: { mode: 'none' },
    });
    volumeNames.add(await executionWorkspaceVolume(executionId));

    const result = await host.exec(executionId, {
      command: '/bin/sh',
      args: [
        '-c',
        'printf "%s" "$BLADE_EPHEMERAL_TOKEN"; printf "%s" "$BLADE_EPHEMERAL_TOKEN" >&2',
      ],
      credentials: [{
        name: 'test',
        audience: 'integration.example.invalid',
      }],
    });
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: '[REDACTED]',
      stderr: '[REDACTED]',
    });
    expect(revoke).toHaveBeenCalledTimes(1);

    const inspection = JSON.parse(
      await docker(['inspect', `blade-execution-${executionId}`]),
    )[0];
    const persistedEnvironment = inspection.Config.Env.join('\n');
    expect(persistedEnvironment).not.toContain('BLADE_EPHEMERAL_TOKEN');
    expect(persistedEnvironment).not.toContain(secret);
    await expect(host.exec(executionId, {
      command: 'printenv',
      args: ['BLADE_EPHEMERAL_TOKEN'],
    })).resolves.toMatchObject({
      exitCode: 1,
      stdout: '',
    });
  }, 60_000);

  it.each([
    ['timeout', 1024 * 1024],
    ['output', 1_024],
  ] as const)(
    'destroys the complete container after an %s limit violation',
    async (failure, maxOutputBytes) => {
      if (!image) {
        throw new Error('TEST_DOCKER_IMAGE is required');
      }
      host = new DockerExecutionHost({
        rootDirectory: join(testRoot, 'host'),
      });
      const executionId = ExecutionId(`docker-${failure}-limit`);
      executionIds.add(executionId);
      await host.provision({
        executionId,
        image,
        workspace: { kind: 'empty' },
        resources: {
          ...defaultResources,
          maxOutputBytes,
        },
        network: { mode: 'none' },
      });
      const volumeName = await executionWorkspaceVolume(executionId);
      volumeNames.add(volumeName);

      const operation = failure === 'timeout'
        ? host.exec(executionId, {
            command: 'sleep',
            args: ['5'],
            timeoutMs: 100,
          })
        : host.exec(executionId, {
            command: '/bin/sh',
            args: ['-c', 'yes x | head -c 65536'],
          });
      await expect(operation).rejects.toMatchObject({
        code: failure === 'timeout'
          ? 'EXECUTION_TIMEOUT'
          : 'EXECUTION_OUTPUT_LIMIT',
      });
      expect(await dockerObjectExists(
        'container',
        `blade-execution-${executionId}`,
      )).toBe(false);
      expect(await dockerObjectExists('volume', volumeName)).toBe(false);
    },
    60_000,
  );

  it('destroys its container and workspace when the execution lifetime expires', async () => {
    if (!image) {
      throw new Error('TEST_DOCKER_IMAGE is required');
    }
    host = new DockerExecutionHost({
      rootDirectory: join(testRoot, 'host'),
    });
    const execution = await host.provision({
      image,
      workspace: { kind: 'empty' },
      resources: {
        ...defaultResources,
        runtimeMs: 300,
      },
      network: { mode: 'none' },
    });
    const executionId = execution.executionId;
    executionIds.add(executionId);
    expect(executionId).toMatch(/^exec-/);
    const volumeName = await executionWorkspaceVolume(executionId);
    volumeNames.add(volumeName);

    await waitFor(async () =>
      !(await dockerObjectExists(
        'container',
        `blade-execution-${executionId}`,
      )));
    await waitFor(async () =>
      !(await dockerObjectExists('volume', volumeName)));
    const expiredError = await host.exec(executionId, {
      command: 'true',
    }).catch((error: unknown) => error);
    expect([
      'EXECUTION_TIMEOUT',
      'EXECUTION_NOT_FOUND',
    ]).toContain((expiredError as { code?: string }).code);
    await expect(host.exec(executionId, {
      command: 'true',
    })).rejects.toMatchObject({
      code: 'EXECUTION_NOT_FOUND',
    });
  }, 60_000);

  it('delegates an allowlist to an isolated egress network and releases it', async () => {
    if (!image) {
      throw new Error('TEST_DOCKER_IMAGE is required');
    }
    const networkName = `blade-egress-${process.pid}-${Date.now()}`;
    networkNames.add(networkName);
    const provision = vi.fn(async (
      _executionId: ReturnType<typeof ExecutionId>,
      _policy: Extract<ExecutionNetworkPolicy, { mode: 'proxy' }>,
    ) => {
      await docker(['network', 'create', '--internal', networkName]);
      return {
        networkName,
        environment: {
          HTTPS_PROXY: 'http://proxy.invalid:8080',
        },
      };
    });
    const release = vi.fn(async () => {
      await docker(['network', 'rm', networkName]);
      networkNames.delete(networkName);
    });
    const egressController: ExecutionEgressController = {
      provision,
      release,
    };
    host = new DockerExecutionHost({
      rootDirectory: join(testRoot, 'host'),
      egressController,
    });
    const executionId = ExecutionId('docker-egress');
    executionIds.add(executionId);
    await host.provision({
      executionId,
      image,
      workspace: { kind: 'empty' },
      resources: defaultResources,
      network: {
        mode: 'proxy',
        allowedHosts: ['api.example.com'],
      },
    });
    volumeNames.add(await executionWorkspaceVolume(executionId));

    expect(provision).toHaveBeenCalledWith(
      executionId,
      {
        mode: 'proxy',
        allowedHosts: ['api.example.com'],
      },
      undefined,
    );
    const inspection = JSON.parse(
      await docker(['inspect', `blade-execution-${executionId}`]),
    )[0];
    expect(inspection.HostConfig.NetworkMode).toBe(networkName);
    await expect(host.exec(executionId, {
      command: '/bin/sh',
      args: ['-c', 'printf "%s" "$HTTPS_PROXY"'],
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'http://proxy.invalid:8080',
    });

    await host.terminate(executionId);
    expect(release).toHaveBeenCalledTimes(1);
    expect(await dockerObjectExists('network', networkName)).toBe(false);
  }, 60_000);
});
