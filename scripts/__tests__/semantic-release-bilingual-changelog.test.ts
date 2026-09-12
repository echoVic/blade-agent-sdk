import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const plugin = require('../semantic-release-bilingual-changelog.cjs');
const {
  readFragments,
  renderRelease,
  verifyRange,
} = plugin._internals;
const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'blade-changelog-'));
  temporaryDirectories.push(directory);
  return directory;
}

function initializeRepository(directory: string): void {
  execFileSync('git', ['init'], { cwd: directory });
  execFileSync('git', ['config', 'user.email', 'release-test@example.com'], {
    cwd: directory,
  });
  execFileSync('git', ['config', 'user.name', 'Release Test'], {
    cwd: directory,
  });
}

function commitAll(directory: string, message: string): void {
  execFileSync('git', ['add', '.'], { cwd: directory });
  execFileSync('git', ['commit', '-m', message], { cwd: directory });
}

function writeFragment(
  directory: string,
  filename: string,
  fragment: Record<string, string>,
): void {
  mkdirSync(join(directory, '.changes'), { recursive: true });
  writeFileSync(
    join(directory, '.changes', filename),
    `${JSON.stringify(fragment, null, 2)}\n`,
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('bilingual changelog fragments', () => {
  it('validates and renders entries in a stable section order', () => {
    const directory = createTemporaryDirectory();
    writeFragment(directory, 'fix-session.json', {
      type: 'fix',
      en: 'Fix session recovery.',
      'zh-CN': '修复会话恢复。',
    });
    writeFragment(directory, 'add-steering.json', {
      type: 'feature',
      en: 'Add session steering.',
      'zh-CN': '新增会话转向。',
    });

    const fragments = readFragments(directory);
    const release = renderRelease('3.1.0', '2026-08-22', 'en', fragments);

    expect(release).toBe(
      [
        '## [3.1.0] - 2026-08-22',
        '',
        '### Features',
        '',
        '- Add session steering.',
        '',
        '### Fixes',
        '',
        '- Fix session recovery.',
      ].join('\n'),
    );
  });

  it('leaves the release level to the tag history instead of the fragments', async () => {
    const directory = createTemporaryDirectory();
    writeFragment(directory, 'repair-runtime.json', {
      type: 'fix',
      en: 'Repair runtime behavior.',
      'zh-CN': '修复运行时行为。',
    });
    writeFragment(directory, 'break-tool-contract.json', {
      type: 'breaking',
      en: 'Require a tool contract.',
      'zh-CN': '要求工具契约。',
    });
    const logger = { log: vi.fn() };

    // Even a breaking fragment must not vote: conventional commits and the latest
    // v* tag decide the version.
    await expect(plugin.analyzeCommits({}, {
      cwd: directory,
      logger,
    })).resolves.toBeNull();
    expect(logger.log).toHaveBeenCalledWith(
      'Version comes from the tag history; 2 bilingual changelog fragment(s) will render the notes',
    );
  });

  it('rejects malformed content and non-kebab-case filenames', () => {
    const directory = createTemporaryDirectory();
    writeFragment(directory, 'Invalid_Name.json', {
      type: 'feature',
      en: 'Add a feature.',
      'zh-CN': '新增功能。',
    });

    expect(() => readFragments(directory)).toThrow('filename must use kebab-case');

    rmSync(join(directory, '.changes', 'Invalid_Name.json'));
    writeFragment(directory, 'missing-translation.json', {
      type: 'feature',
      en: 'Add a feature.',
    });

    expect(() => readFragments(directory)).toThrow(
      'zh-CN must be a non-empty string',
    );
  });

  it('updates both changelogs and stages consumed fragment deletion', async () => {
    const directory = createTemporaryDirectory();
    initializeRepository(directory);
    writeFileSync(
      join(directory, 'CHANGELOG.md'),
      '# Changelog\n\nAll notable changes.\n\n## [3.0.0] - 2026-08-22\n',
    );
    writeFileSync(
      join(directory, 'CHANGELOG.zh-CN.md'),
      '# 更新日志\n\n所有重要变更。\n\n## [3.0.0] - 2026-08-22\n',
    );
    writeFragment(directory, 'session-steering.json', {
      type: 'feature',
      en: 'Add session steering.',
      'zh-CN': '新增会话转向。',
    });
    commitAll(directory, 'chore: initialize release files');

    const logger = { log: vi.fn() };
    await plugin.prepare(
      {},
      {
        cwd: directory,
        logger,
        nextRelease: { version: '3.1.0' },
      },
    );

    expect(readFileSync(join(directory, 'CHANGELOG.md'), 'utf8')).toContain(
      '## [3.1.0]',
    );
    expect(
      readFileSync(join(directory, 'CHANGELOG.zh-CN.md'), 'utf8'),
    ).toContain('## [3.1.0]');
    expect(
      execFileSync('git', ['diff', '--cached', '--name-status'], {
        cwd: directory,
        encoding: 'utf8',
      }),
    ).toContain('D\t.changes/session-steering.json');
    expect(logger.log).toHaveBeenCalledOnce();
  });

  it('rejects a releasable prepare step without fragments', async () => {
    const directory = createTemporaryDirectory();

    await expect(
      plugin.prepare(
        {},
        {
          cwd: directory,
          logger: { log: vi.fn() },
          nextRelease: { version: '3.1.0' },
        },
      ),
    ).rejects.toThrow('requires at least one bilingual');
  });
});

describe('release level ownership', () => {
  // Mirrors semantic-release's analyzeCommits postprocess: the highest release
  // type across plugins wins, and a null vote cannot lower or raise it.
  function resolveReleaseType(results: (string | null)[]): string | undefined {
    const ordered = ['major', 'minor', 'patch'];
    return ordered[
      results.reduce((highest, result) => {
        const index = result === null ? -1 : ordered.indexOf(result);
        return index > highest ? index : highest;
      }, -1)
    ];
  }

  it('cannot override the commit-derived release type', async () => {
    const directory = createTemporaryDirectory();
    writeFragment(directory, 'rewrite-message-envelope.json', {
      type: 'fix',
      en: 'Replace the message envelope.',
      'zh-CN': '替换消息封装。',
    });

    const pluginVote = await plugin.analyzeCommits({}, {
      cwd: directory,
      logger: { log() {} },
    });

    expect(pluginVote).toBeNull();
    // commit-analyzer's verdict survives the null vote from this plugin.
    expect(resolveReleaseType(['patch', pluginVote])).toBe('patch');
    expect(resolveReleaseType(['major', pluginVote])).toBe('major');
    // A breaking fragment no longer forces a major on its own.
    expect(resolveReleaseType([pluginVote])).toBeUndefined();
  });
});

describe('pull request fragment requirement', () => {
  it('requires a changed fragment for releasable commits', async () => {
    const directory = createTemporaryDirectory();
    initializeRepository(directory);
    writeFileSync(join(directory, 'README.md'), '# Test\n');
    commitAll(directory, 'chore: initialize');
    const base = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: directory,
      encoding: 'utf8',
    }).trim();

    writeFileSync(join(directory, 'fix.txt'), 'fixed\n');
    commitAll(directory, 'fix: repair behavior');

    await expect(verifyRange(directory, base)).rejects.toThrow(
      'require a bilingual .changes/*.json fragment',
    );

    writeFragment(directory, 'repair-behavior.json', {
      type: 'fix',
      en: 'Repair behavior.',
      'zh-CN': '修复行为。',
    });
    commitAll(directory, 'docs: add changelog fragment');

    await expect(verifyRange(directory, base)).resolves.toBeUndefined();
  });

  it('recognizes breaking-change bang headers as releasable', async () => {
    const directory = createTemporaryDirectory();
    initializeRepository(directory);
    writeFileSync(join(directory, 'README.md'), '# Test\n');
    commitAll(directory, 'chore: initialize');
    const base = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: directory,
      encoding: 'utf8',
    }).trim();

    writeFileSync(join(directory, 'api.ts'), 'export const version = 2;\n');
    commitAll(directory, 'feat(api)!: replace the contract');

    await expect(verifyRange(directory, base)).rejects.toThrow(
      'require a bilingual .changes/*.json fragment',
    );
  });

  it('does not require a fragment for non-releasable commits', async () => {
    const directory = createTemporaryDirectory();
    initializeRepository(directory);
    writeFileSync(join(directory, 'README.md'), '# Test\n');
    commitAll(directory, 'chore: initialize');
    const base = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: directory,
      encoding: 'utf8',
    }).trim();

    writeFileSync(join(directory, 'README.md'), '# Updated test\n');
    commitAll(directory, 'docs: update guide');

    await expect(verifyRange(directory, base)).resolves.toBeUndefined();
  });
});
