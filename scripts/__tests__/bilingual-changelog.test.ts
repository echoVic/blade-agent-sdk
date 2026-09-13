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

import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const changelog = require('../bilingual-changelog.cjs');
const {
  changelogHasVersion,
  hasReleasableCommit,
  isReleasableCommit,
  prependRelease,
  readFragments,
  readReleaseFragments,
  removeConsumedFragments,
  renderBilingualNotes,
  renderRelease,
  verifyRange,
} = changelog;
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

    expect(renderRelease('3.1.0', '2026-08-22', 'en', fragments)).toBe(
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
    expect(renderRelease('3.1.0', '2026-08-22', 'zh-CN', fragments)).toContain(
      '- 新增会话转向。',
    );
  });

  it('renders both languages into the release notes', () => {
    const directory = createTemporaryDirectory();
    writeFragment(directory, 'add-steering.json', {
      type: 'feature',
      en: 'Add session steering.',
      'zh-CN': '新增会话转向。',
    });

    const notes = renderBilingualNotes('3.1.0', '2026-08-22', readFragments(directory));

    expect(notes.indexOf('### Features')).toBeLessThan(notes.indexOf('### 新功能'));
    expect(notes).toContain('- Add session steering.');
    expect(notes).toContain('- 新增会话转向。');
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

  it('requires at least one fragment before a release can render notes', () => {
    const directory = createTemporaryDirectory();

    expect(() => readReleaseFragments(directory)).toThrow(
      'requires at least one bilingual',
    );
  });

  it('prepends the release to both changelogs and removes the consumed fragments', () => {
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

    const fragments = readReleaseFragments(directory);
    for (const locale of Object.keys(changelog.CHANGELOGS)) {
      prependRelease(directory, locale, renderRelease('3.1.0', '2026-08-23', locale, fragments));
    }
    removeConsumedFragments(directory, fragments);

    expect(readFileSync(join(directory, 'CHANGELOG.md'), 'utf8')).toContain('## [3.1.0]');
    expect(readFileSync(join(directory, 'CHANGELOG.zh-CN.md'), 'utf8')).toContain('## [3.1.0]');
    expect(changelogHasVersion(directory, '3.1.0')).toBe(true);
    expect(readFragments(directory)).toEqual([]);
  });

  it('refuses to record the same version twice', () => {
    const directory = createTemporaryDirectory();
    writeFileSync(
      join(directory, 'CHANGELOG.md'),
      '# Changelog\n\nAll notable changes.\n\n## [3.1.0] - 2026-08-23\n',
    );

    expect(() => prependRelease(directory, 'en', '## [3.1.0] - 2026-08-23'))
      .toThrow('already contains ## [3.1.0]');
    expect(changelogHasVersion(directory, '3.1.0')).toBe(true);
  });
});

describe('releasable commit classification', () => {
  it('owes a fragment for releasable conventional types and breaking markers', () => {
    for (const message of [
      'fix(server): repair a route',
      'feat: add a capability',
      'refactor(release): move version ownership',
      'docs: correct a shipped claim',
      'perf(runtime): bound a queue',
      'build: ship the release script',
      'fix(api)!: replace the contract',
      'chore: tidy up\n\nBREAKING CHANGE: the field is gone',
      'Revert "feat: add a capability"',
    ]) {
      expect(isReleasableCommit(message), message).toBe(true);
    }
  });

  it('does not owe a fragment for commits the project never releases', () => {
    for (const message of [
      'chore: tidy the repo',
      'test: add coverage',
      'ci: cache the pnpm store',
      'chore(release): 3.1.0 [skip ci]',
    ]) {
      expect(isReleasableCommit(message), message).toBe(false);
    }
  });

  it('only treats a standalone BREAKING CHANGE footer as breaking', () => {
    expect(isReleasableCommit('chore: note that xBREAKING CHANGE:y is a token')).toBe(false);
    expect(isReleasableCommit('chore: note\n\nBREAKING CHANGE: the field is gone')).toBe(true);
    expect(isReleasableCommit('chore: note\n\nBREAKING-CHANGE: the field is gone')).toBe(true);
  });
});

describe('pull request fragment requirement', () => {
  it('requires a changed fragment for releasable commits', () => {
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

    expect(() => verifyRange(directory, base)).toThrow(
      'require a bilingual .changes/*.json fragment',
    );

    writeFragment(directory, 'repair-behavior.json', {
      type: 'fix',
      en: 'Repair behavior.',
      'zh-CN': '修复行为。',
    });
    commitAll(directory, 'docs: add changelog fragment');

    expect(() => verifyRange(directory, base)).not.toThrow();
  });

  it('recognizes breaking-change bang headers as releasable', () => {
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

    expect(() => verifyRange(directory, base)).toThrow(
      'require a bilingual .changes/*.json fragment',
    );
  });

  it('does not require a fragment for non-releasable commits', () => {
    const directory = createTemporaryDirectory();
    initializeRepository(directory);
    writeFileSync(join(directory, 'README.md'), '# Test\n');
    commitAll(directory, 'chore: initialize');
    const base = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: directory,
      encoding: 'utf8',
    }).trim();

    writeFileSync(join(directory, 'README.md'), '# Updated test\n');
    commitAll(directory, 'chore: tidy the CI cache');

    expect(() => verifyRange(directory, base)).not.toThrow();
  });

  it.each(['docs: update guide', 'refactor: split a module', 'perf: bound a queue'])(
    'requires a fragment for %s, which still ships a release',
    (message) => {
      const directory = createTemporaryDirectory();
      initializeRepository(directory);
      writeFileSync(join(directory, 'README.md'), '# Test\n');
      commitAll(directory, 'chore: initialize');
      const base = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: directory,
        encoding: 'utf8',
      }).trim();

      writeFileSync(join(directory, 'README.md'), `# ${message}\n`);
      commitAll(directory, message);

      expect(hasReleasableCommit(directory, base)).toBe(true);
      expect(() => verifyRange(directory, base)).toThrow(
        'require a bilingual .changes/*.json fragment',
      );
    },
  );
});
