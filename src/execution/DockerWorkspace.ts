import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { runCheckedProcess, runProcessToFile } from './DockerProcessRunner.js';
import type { ExecutionProvisionRequest } from './ExecutionHost.js';
import { ExecutionHostError } from './ExecutionHost.js';

type GitWorkspace = Extract<ExecutionProvisionRequest['workspace'], { kind: 'git-worktree' }>;

export class DockerWorkspace {
  constructor(
    private readonly runtime: string,
    private readonly stagingRoot: string,
    private readonly user: string,
  ) {}

  async importGit(
    container: string,
    source: GitWorkspace,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const repository = await realpath(source.repositoryPath);
    await this.withArchive('git-archive-', async (archive) => {
      await runCheckedProcess(
        'git',
        ['-C', repository, 'archive', '--format=tar', `--output=${archive}`, source.revision],
        processOptions(signal),
      );
      await this.loadArchive(container, archive, maxBytes, signal);
    });
  }

  async copyToContainer(
    container: string,
    source: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.withArchive('restore-archive-', async (archive) => {
      await runCheckedProcess('tar', ['-C', source, '-cf', archive, '.'], processOptions(signal));
      await this.loadArchive(container, archive, maxBytes, signal);
    });
  }

  async exportFromContainer(
    container: string,
    destination: string,
    maxBytes: number,
  ): Promise<void> {
    await mkdir(destination, { recursive: true, mode: 0o700 });
    await this.withArchive('checkpoint-archive-', async (archive) => {
      const exported = await runProcessToFile(
        this.runtime,
        ['exec', '--user', this.user, container, 'tar', '-cf', '-', '-C', '/workspace', '.'],
        archive,
        {
          ...processOptions(),
          maxBytes: Math.min(Number.MAX_SAFE_INTEGER, maxBytes + 16 * 1024 * 1024),
        },
      );
      if (exported.exitCode !== 0) {
        throw new ExecutionHostError(
          'EXECUTION_RUNTIME_ERROR',
          exported.stderr || 'Could not export the container workspace',
        );
      }
      await runCheckedProcess('tar', ['-C', destination, '-xf', archive], processOptions());
    });
  }

  async directorySize(path: string): Promise<number> {
    const details = await lstat(path);
    if (!details.isDirectory()) return details.size;
    const sizes = await Promise.all(
      (await readdir(path)).map((entry) => this.directorySize(join(path, entry))),
    );
    return sizes.reduce((total, size) => total + size, 0);
  }

  private async loadArchive(
    container: string,
    archive: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if ((await stat(archive)).size > maxBytes) {
      throw new ExecutionHostError(
        'EXECUTION_RESOURCE_LIMIT',
        'Workspace archive exceeds the execution disk limit',
      );
    }
    await runCheckedProcess(
      this.runtime,
      [
        'exec',
        '-i',
        '--user',
        this.user,
        '--workdir',
        '/workspace',
        container,
        'tar',
        '-xf',
        '-',
        '-C',
        '/workspace',
      ],
      { ...processOptions(signal), stdin: await readFile(archive) },
    );
  }

  private async withArchive(
    prefix: string,
    operation: (archive: string) => Promise<void>,
  ): Promise<void> {
    const directory = await mkdtemp(join(this.stagingRoot, prefix));
    try {
      await operation(join(directory, 'workspace.tar'));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function processOptions(signal?: AbortSignal) {
  return { timeoutMs: 60_000, maxBytes: 1024 * 1024, signal };
}
