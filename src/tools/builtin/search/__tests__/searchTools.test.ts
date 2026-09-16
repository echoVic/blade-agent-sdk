import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createContextSnapshot } from '../../../../runtime/index.js';
import { SessionId } from '../../../../types/identifiers.js';
import { collectToolExecution } from '../../../types/result.js';
import { globTool } from '../glob.js';
import { grepTool } from '../grep.js';

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
