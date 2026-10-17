import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createContextSnapshot } from '../../../../runtime/index.js';
import { SessionId } from '../../../../types/identifiers.js';
import { collectToolExecution } from '../../../types/result.js';
import { globTool } from '../glob.js';
import { grepTool } from '../grep.js';
import { runGlob } from '../searchRunner.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, lstat: vi.fn(original.lstat) };
});
const { lstat: realLstat } =
  await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

describe('search tools', () => {
  let root: string;
  let contextSnapshot: ReturnType<typeof createContextSnapshot>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'blade-search-'));
    await mkdir(join(root, 'src'));
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'src', 'match.ts'), 'first\nNeedle here\nlast\n');
    await writeFile(join(root, 'src', 'other.js'), 'no match\n');
    await writeFile(join(root, 'node_modules', 'ignored.ts'), 'Needle\n');
    contextSnapshot = createContextSnapshot(SessionId('search-session'), 'turn-1', {
      capabilities: { filesystem: { roots: [root], cwd: root } },
    });
  });

  afterEach(async () => {
    vi.mocked(lstat).mockReset().mockImplementation(realLstat);
    await rm(root, { force: true, recursive: true });
  });

  test('glob returns relative paths and excludes default ignored directories', async () => {
    const result = await collectToolExecution(
      globTool.execute(
        {
          pattern: '**/*.ts',
          max_results: 10,
          include_directories: false,
          case_sensitive: false,
        },
        { contextSnapshot },
      ),
    );

    expect(result.status).toBe('success');
    expect(result.metadata?.matches).toEqual([
      expect.objectContaining({ relative_path: 'src/match.ts', is_directory: false }),
    ]);
  });

  async function search(pattern: string, includeDirectories = false, caseSensitive = true) {
    return runGlob(root, pattern, {
      maxResults: 100,
      includeDirectories,
      caseSensitive,
      signal: new AbortController().signal,
    });
  }

  test('reports directory matches without a trailing slash or expanding their contents', async () => {
    expect((await search('src', true)).matches).toEqual([
      {
        path: join(root, 'src'),
        relative_path: 'src',
        is_directory: true,
        modified: expect.any(String),
      },
    ]);
    expect((await search('src')).matches).toEqual([]);
  });

  test('matches case insensitively only when requested', async () => {
    expect((await search('src/*.TS', false, false)).matches).toEqual([
      expect.objectContaining({
        relative_path: 'src/match.ts',
        size: 23,
        modified: expect.any(String),
      }),
    ]);
    expect((await search('src/*.TS')).matches).toEqual([]);
  });

  test('includes dotfiles, respects gitignore, and never traverses symlinked directories', async () => {
    await writeFile(join(root, '.hidden.ts'), 'hidden');
    await writeFile(join(root, '.gitignore'), 'src/other.js\n');
    await symlink(join(root, 'src'), join(root, 'linked'), 'dir');
    const paths = (await search('**/*')).matches.map((match) => match.relative_path);
    expect(paths).toContain('.hidden.ts');
    expect(paths).toContain('src/match.ts');
    expect(paths).not.toContain('src/other.js');
    expect(
      paths.some((path) => path.startsWith('node_modules/') || path.startsWith('linked/')),
    ).toBe(false);
  });

  test.skipIf(process.platform === 'win32')(
    'preserves literal backslashes in POSIX filenames',
    async () => {
      await writeFile(join(root, 'src', 'back\\slash.ts'), 'literal');
      expect((await search('**/*.ts')).matches).toContainEqual(
        expect.objectContaining({
          relative_path: 'src/back\\slash.ts',
          path: join(root, 'src', 'back\\slash.ts'),
          size: 7,
        }),
      );
    },
  );

  test.each(['ENOENT', 'ENOTDIR'])('skips a match lost before lstat: %s', async (code) => {
    await writeFile(join(root, 'src', 'vanished.ts'), 'gone');
    vi.mocked(lstat).mockImplementation(((entry) => {
      if (String(entry).endsWith('vanished.ts'))
        return Promise.reject(Object.assign(new Error('gone'), { code }));
      return realLstat(entry);
    }) as typeof lstat);
    expect((await search('src/*.ts')).matches.map((match) => match.relative_path)).toEqual([
      'src/match.ts',
    ]);
  });

  test('propagates lstat permission failures', async () => {
    const failure = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    vi.mocked(lstat).mockRejectedValueOnce(failure);
    await expect(search('src/*.ts')).rejects.toBe(failure);
  });

  test('stats matches concurrently with at most 64 in flight', async () => {
    await Promise.all(
      Array.from({ length: 130 }, (_, index) => writeFile(join(root, 'src', `${index}.ts`), 'x')),
    );
    let active = 0;
    let peak = 0;
    vi.mocked(lstat).mockImplementation((async (entry) => {
      active++;
      peak = Math.max(peak, active);
      try {
        return await realLstat(entry);
      } finally {
        active--;
      }
    }) as typeof lstat);
    const result = await search('src/*.ts');
    expect(result.matches).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(64);
  });

  test.skipIf(process.platform === 'win32')(
    'lists an explicitly named symlink base without traversing nested symlinks',
    async () => {
      await symlink(join(root, 'src'), join(root, 'linkdir'), 'dir');
      await symlink(join(root, 'src'), join(root, 'src', 'nested-link'), 'dir');
      expect(
        (await search('linkdir/**')).matches.map((match) => match.relative_path).sort(),
      ).toEqual(['linkdir/match.ts', 'linkdir/other.js']);
    },
  );

  test('grep returns matching content with line numbers', async () => {
    const result = await collectToolExecution(
      grepTool.execute(
        {
          pattern: 'needle',
          output_mode: 'content',
          '-i': true,
          '-n': true,
          multiline: false,
        },
        { contextSnapshot },
      ),
    );

    expect(result.status).toBe('success');
    expect(result.model).toEqual([
      expect.objectContaining({
        file_path: expect.stringContaining('src/match.ts'),
        line_number: 2,
        content: 'Needle here',
      }),
    ]);
    expect(result.metadata?.strategy).toBe('ripgrep');
  });
});
