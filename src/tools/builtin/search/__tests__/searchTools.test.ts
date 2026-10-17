import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createContextSnapshot } from '../../../../runtime/index.js';
import { SessionId } from '../../../../types/identifiers.js';
import { collectToolExecution } from '../../../types/result.js';
import { globTool } from '../glob.js';
import { grepTool } from '../grep.js';
import { runGlob } from '../searchRunner.js';

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
