const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const FRAGMENT_DIRECTORY = '.changes';
const FRAGMENT_README = 'README.md';
const FRAGMENT_FILE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*\.json$/;
const CHANGELOGS = {
  en: {
    file: 'CHANGELOG.md',
    title: '# Changelog',
    intro: 'All notable changes to `@blade-ai/agent-sdk` are documented here.',
    sections: {
      breaking: 'Breaking Changes',
      feature: 'Features',
      fix: 'Fixes',
      performance: 'Performance',
      refactor: 'Refactoring',
      docs: 'Documentation',
    },
  },
  'zh-CN': {
    file: 'CHANGELOG.zh-CN.md',
    title: '# 更新日志',
    intro: '`@blade-ai/agent-sdk` 的所有重要变更都记录在此。',
    sections: {
      breaking: '破坏性变更',
      feature: '新功能',
      fix: '修复',
      performance: '性能优化',
      refactor: '重构',
      docs: '文档',
    },
  },
};
const TYPE_ORDER = ['breaking', 'feature', 'fix', 'performance', 'refactor', 'docs'];
/**
 * Commit types that require a changelog fragment. This decides only whether a
 * pull request owes a fragment; the released version number comes from the tag
 * the maintainer pushes, never from the commit type.
 */
const RELEASABLE_COMMIT_TYPES = new Set(['feat', 'fix', 'perf', 'refactor', 'docs', 'build']);
const CONVENTIONAL_HEADER = /^([a-z]+)(?:\([^)]*\))?(!)?:\s+\S/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/m;

function getFragmentPaths(cwd) {
  const directory = path.join(cwd, FRAGMENT_DIRECTORY);
  if (!fs.existsSync(directory)) {
    return [];
  }
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && entry.name !== FRAGMENT_README && entry.name.endsWith('.json'),
    )
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

function readFragments(cwd) {
  return getFragmentPaths(cwd).map((file) => {
    const filename = path.basename(file);
    if (!FRAGMENT_FILE_PATTERN.test(filename)) {
      throw new Error(
        `Invalid changelog fragment ${path.relative(cwd, file)}: filename must use kebab-case`,
      );
    }

    let fragment;
    try {
      fragment = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(`Invalid changelog fragment ${path.relative(cwd, file)}: ${error.message}`);
    }

    if (!fragment || Array.isArray(fragment) || typeof fragment !== 'object') {
      throw new Error(
        `Invalid changelog fragment ${path.relative(cwd, file)}: ` +
          'content must be a JSON object',
      );
    }
    if (!TYPE_ORDER.includes(fragment.type)) {
      throw new Error(
        `Invalid changelog fragment ${path.relative(cwd, file)}: ` +
          `type must be one of ${TYPE_ORDER.join(', ')}`,
      );
    }
    for (const locale of Object.keys(CHANGELOGS)) {
      if (typeof fragment[locale] !== 'string' || fragment[locale].trim() === '') {
        throw new Error(
          `Invalid changelog fragment ${path.relative(cwd, file)}: ` +
            `${locale} must be a non-empty string`,
        );
      }
    }

    return {
      file,
      filename,
      type: fragment.type,
      en: fragment.en.trim(),
      'zh-CN': fragment['zh-CN'].trim(),
    };
  });
}

/** Fragments for a release: at least one is required to render the notes. */
function readReleaseFragments(cwd) {
  const fragments = readFragments(cwd);
  if (fragments.length === 0) {
    throw new Error('A release requires at least one bilingual .changes/*.json fragment');
  }
  return fragments;
}

function renderRelease(version, date, locale, fragments) {
  const config = CHANGELOGS[locale];
  const lines = [`## [${version}] - ${date}`];
  for (const type of TYPE_ORDER) {
    const entries = fragments.filter((fragment) => fragment.type === type);
    if (entries.length === 0) {
      continue;
    }
    lines.push('', `### ${config.sections[type]}`, '');
    for (const fragment of entries) {
      lines.push(`- ${fragment[locale]}`);
    }
  }
  return lines.join('\n');
}

/** Release notes for the GitHub release: both languages, English first. */
function renderBilingualNotes(version, date, fragments) {
  return [
    renderRelease(version, date, 'en', fragments),
    '---',
    renderRelease(version, date, 'zh-CN', fragments),
  ].join('\n\n');
}

function changelogHasVersion(cwd, version) {
  const heading = `## [${version}]`;
  return Object.keys(CHANGELOGS).some((locale) => {
    const file = path.join(cwd, CHANGELOGS[locale].file);
    return fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(heading);
  });
}

function prependRelease(cwd, locale, release) {
  const config = CHANGELOGS[locale];
  const file = path.join(cwd, config.file);
  const initial = `${config.title}\n\n${config.intro}\n`;
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : initial;
  const versionHeading = release.split('\n', 1)[0];
  if (existing.includes(`${versionHeading}\n`) || existing.trimEnd().endsWith(versionHeading)) {
    throw new Error(`${config.file} already contains ${versionHeading}`);
  }

  const firstRelease = existing.search(/^## \[/m);
  const prefix =
    firstRelease === -1 ? existing.trimEnd() : existing.slice(0, firstRelease).trimEnd();
  const history = firstRelease === -1 ? '' : existing.slice(firstRelease).trimStart();
  const content = [prefix, release, history].filter(Boolean).join('\n\n');
  fs.writeFileSync(file, `${content.trimEnd()}\n`);
}

/** Delete the fragments consumed by a release; missing files mean already consumed. */
function removeConsumedFragments(cwd, fragments) {
  for (const fragment of fragments) {
    const file = path.isAbsolute(fragment.file) ? fragment.file : path.join(cwd, fragment.file);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }
}

function getChangedFragmentPaths(cwd, base) {
  const output = execFileSync(
    'git',
    [
      'diff',
      '--name-only',
      '--diff-filter=ACMR',
      `${base}...HEAD`,
      '--',
      `${FRAGMENT_DIRECTORY}/*.json`,
    ],
    { cwd, encoding: 'utf8' },
  );
  return output
    .split('\n')
    .map((file) => file.trim())
    .filter(Boolean);
}

function getCommitMessages(cwd, base) {
  const messages = execFileSync('git', ['log', '--format=%B%x00', `${base}..HEAD`], {
    cwd,
    encoding: 'utf8',
  });
  return messages
    .split('\0')
    .map((message) => message.trim())
    .filter(Boolean);
}

/**
 * Whether a commit owes a changelog fragment: a releasable conventional type, a
 * breaking marker, or a revert.
 */
function isReleasableCommit(message) {
  const [header = ''] = message.split('\n', 1);
  if (/^revert\b/i.test(header.trim())) {
    return true;
  }
  if (BREAKING_FOOTER.test(message)) {
    return true;
  }
  const match = CONVENTIONAL_HEADER.exec(header.trim());
  if (!match) {
    return false;
  }
  return match[2] === '!' || RELEASABLE_COMMIT_TYPES.has(match[1]);
}

function hasReleasableCommit(cwd, base) {
  return getCommitMessages(cwd, base).some(isReleasableCommit);
}

function verifyRange(cwd, base) {
  if (!hasReleasableCommit(cwd, base)) {
    return;
  }
  if (getChangedFragmentPaths(cwd, base).length === 0) {
    throw new Error(
      `Releasable commits since ${base} require a bilingual .changes/*.json fragment`,
    );
  }
}

function runCli(cwd, args) {
  const fragments = readFragments(cwd);
  const baseIndex = args.indexOf('--base');
  if (baseIndex !== -1) {
    const base = args[baseIndex + 1];
    if (!base) {
      throw new Error('--base requires a Git revision');
    }
    verifyRange(cwd, base);
  }
  process.stdout.write(`Validated ${fragments.length} bilingual changelog fragment(s)\n`);
}

if (require.main === module) {
  try {
    runCli(process.cwd(), process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  CHANGELOGS,
  TYPE_ORDER,
  changelogHasVersion,
  getChangedFragmentPaths,
  getCommitMessages,
  getFragmentPaths,
  hasReleasableCommit,
  isReleasableCommit,
  prependRelease,
  readFragments,
  readReleaseFragments,
  removeConsumedFragments,
  renderBilingualNotes,
  renderRelease,
  verifyRange,
};
