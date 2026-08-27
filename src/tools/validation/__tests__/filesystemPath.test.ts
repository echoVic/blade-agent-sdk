import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContextSnapshot } from '../../../runtime/index.js';
import { SessionId } from '../../../types/identifiers.js';
import { resolveAuthorizedFilesystemPath } from '../filesystemPath.js';

describe('resolveAuthorizedFilesystemPath', () => {
  let tempRoot: string;
  let workspaceRoot: string;
  let outsideRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'blade-filesystem-path-'));
    workspaceRoot = join(tempRoot, 'workspace');
    outsideRoot = join(tempRoot, 'outside');
    await mkdir(workspaceRoot);
    await mkdir(outsideRoot);
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  function snapshot() {
    return createContextSnapshot(SessionId('filesystem-path-session'), 'turn-1', {
      capabilities: {
        filesystem: {
          roots: [workspaceRoot],
          cwd: workspaceRoot,
        },
      },
    });
  }

  it('resolves existing and missing paths within an authorized root', async () => {
    const existing = join(workspaceRoot, 'existing.txt');
    await writeFile(existing, 'ok');

    await expect(resolveAuthorizedFilesystemPath(existing, snapshot())).resolves.toBe(
      await realpath(existing),
    );
    await expect(
      resolveAuthorizedFilesystemPath('new/nested.txt', snapshot(), {
        allowMissing: true,
      }),
    ).resolves.toBe(join(await realpath(workspaceRoot), 'new', 'nested.txt'));
  });

  it('rejects direct paths and symlink aliases outside authorized roots', async () => {
    const outsideFile = join(outsideRoot, 'secret.json');
    const alias = join(workspaceRoot, 'safe.json');
    await writeFile(outsideFile, '{"secret":true}');
    await symlink(outsideFile, alias);

    await expect(resolveAuthorizedFilesystemPath(outsideFile, snapshot())).rejects.toThrow(
      'outside authorized roots',
    );
    await expect(resolveAuthorizedFilesystemPath(alias, snapshot())).rejects.toThrow(
      'outside authorized roots',
    );
  });

  it('rejects missing paths below a symlinked directory outside authorized roots', async () => {
    const alias = join(workspaceRoot, 'linked');
    await symlink(outsideRoot, alias);

    await expect(
      resolveAuthorizedFilesystemPath(join(alias, 'new.txt'), snapshot(), {
        allowMissing: true,
      }),
    ).rejects.toThrow('outside authorized roots');
  });

  it('rejects writes through a dangling symlink', async () => {
    const alias = join(workspaceRoot, 'dangling.txt');
    await symlink(join(outsideRoot, 'missing.txt'), alias);

    await expect(
      resolveAuthorizedFilesystemPath(alias, snapshot(), {
        allowMissing: true,
      }),
    ).rejects.toThrow('unresolved symbolic link');
  });
});
