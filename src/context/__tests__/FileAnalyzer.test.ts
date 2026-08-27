import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFilesContent } from '../FileAnalyzer.js';

describe('FileAnalyzer.readFilesContent', () => {
  let tempRoot: string;
  let workspaceRoot: string;
  let outsideRoot: string;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'blade-file-analyzer-'));
    workspaceRoot = join(tempRoot, 'workspace');
    outsideRoot = join(tempRoot, 'outside');
    await mkdir(workspaceRoot);
    await mkdir(outsideRoot);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    warn.mockRestore();
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('reads only files within the authorized filesystem roots', async () => {
    const allowed = join(workspaceRoot, 'allowed.ts');
    const denied = join(outsideRoot, 'denied.ts');
    await writeFile(allowed, 'allowed');
    await writeFile(denied, 'denied');

    const result = await readFilesContent([allowed, denied], {
      filesystemScope: {
        filesystemRoots: [workspaceRoot],
        cwd: workspaceRoot,
      },
    });

    expect(result).toEqual([
      expect.objectContaining({
        path: await realpath(allowed),
        content: 'allowed',
      }),
    ]);
  });

  it('does not read files when no filesystem scope is provided', async () => {
    const filePath = join(workspaceRoot, 'unscoped.ts');
    await writeFile(filePath, 'must-not-be-read');

    await expect(readFilesContent([filePath])).resolves.toEqual([]);
  });

  it('does not implicitly include sensitive files', async () => {
    const sensitive = join(workspaceRoot, 'credentials.json');
    await writeFile(sensitive, '{"token":"secret"}');

    await expect(
      readFilesContent([sensitive], {
        filesystemScope: {
          filesystemRoots: [workspaceRoot],
          cwd: workspaceRoot,
        },
      }),
    ).resolves.toEqual([]);
  });

  it('bounds both individual and aggregate file content', async () => {
    const files = await Promise.all(
      Array.from({ length: 5 }, async (_, index) => {
        const filePath = join(workspaceRoot, `large-${index}.txt`);
        await writeFile(filePath, 'x'.repeat(70 * 1024));
        return filePath;
      }),
    );

    const result = await readFilesContent(files, {
      filesystemScope: {
        filesystemRoots: [workspaceRoot],
        cwd: workspaceRoot,
      },
    });

    expect(result).toHaveLength(4);
    expect(result.every((file) => file.truncated)).toBe(true);
    expect(
      result.reduce((total, file) => total + Buffer.byteLength(file.content), 0),
    ).toBeLessThanOrEqual(256 * 1024);
  });
});
