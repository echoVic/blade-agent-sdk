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
const TYPE_ORDER = [
  'breaking',
  'feature',
  'fix',
  'performance',
  'refactor',
  'docs',
];
const RELEASE_TYPE_BY_FRAGMENT = {
  breaking: 'major',
  feature: 'minor',
  fix: 'patch',
  performance: 'patch',
  refactor: 'patch',
  docs: 'patch',
};
const RELEASE_TYPE_RANK = {
  patch: 1,
  minor: 2,
  major: 3,
};
const COMMIT_ANALYZER_OPTIONS = {
  parserOpts: {
    breakingHeaderPattern: /^(\w*)(?:\((.*)\))?!: (.*)$/,
    breakingHeaderCorrespondence: ['type', 'scope', 'subject'],
  },
};

function getFragmentPaths(cwd) {
  const directory = path.join(cwd, FRAGMENT_DIRECTORY);
  if (!fs.existsSync(directory)) {
    return [];
  }
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) =>
      entry.isFile()
      && entry.name !== FRAGMENT_README
      && entry.name.endsWith('.json'))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

function readFragments(cwd) {
  return getFragmentPaths(cwd).map((file) => {
    const filename = path.basename(file);
    if (!FRAGMENT_FILE_PATTERN.test(filename)) {
      throw new Error(
        `Invalid changelog fragment ${path.relative(cwd, file)}: `
        + 'filename must use kebab-case',
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
        `Invalid changelog fragment ${path.relative(cwd, file)}: `
        + 'content must be a JSON object',
      );
    }
    if (!TYPE_ORDER.includes(fragment.type)) {
      throw new Error(
        `Invalid changelog fragment ${path.relative(cwd, file)}: `
        + `type must be one of ${TYPE_ORDER.join(', ')}`,
      );
    }
    for (const locale of Object.keys(CHANGELOGS)) {
      if (typeof fragment[locale] !== 'string' || fragment[locale].trim() === '') {
        throw new Error(
          `Invalid changelog fragment ${path.relative(cwd, file)}: `
          + `${locale} must be a non-empty string`,
        );
      }
    }

    return {
      file,
      type: fragment.type,
      en: fragment.en.trim(),
      'zh-CN': fragment['zh-CN'].trim(),
    };
  });
}

function releaseTypeFromFragments(fragments) {
  let releaseType = null;
  for (const fragment of fragments) {
    const candidate = RELEASE_TYPE_BY_FRAGMENT[fragment.type];
    if (
      candidate
      && (!releaseType || RELEASE_TYPE_RANK[candidate] > RELEASE_TYPE_RANK[releaseType])
    ) {
      releaseType = candidate;
    }
  }
  return releaseType;
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
  const prefix = firstRelease === -1 ? existing.trimEnd() : existing.slice(0, firstRelease).trimEnd();
  const history = firstRelease === -1 ? '' : existing.slice(firstRelease).trimStart();
  const content = [
    prefix,
    release,
    history,
  ].filter(Boolean).join('\n\n');
  fs.writeFileSync(file, `${content.trimEnd()}\n`);
}

function stageFragmentDeletions(cwd, fragments) {
  for (const fragment of fragments) {
    fs.unlinkSync(fragment.file);
  }
  execFileSync('git', ['add', '--update', '--', FRAGMENT_DIRECTORY], {
    cwd,
    stdio: 'pipe',
  });
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
  const messages = execFileSync(
    'git',
    ['log', '--format=%B%x00', `${base}..HEAD`],
    { cwd, encoding: 'utf8' },
  );
  return messages
    .split('\0')
    .map((message) => message.trim())
    .filter(Boolean);
}

async function hasReleasableCommit(cwd, base) {
  const { analyzeCommits } = await import('@semantic-release/commit-analyzer');
  const commits = getCommitMessages(cwd, base).map((message, index) => ({
    hash: `range-${index}`,
    message,
  }));
  const releaseType = await analyzeCommits(
    COMMIT_ANALYZER_OPTIONS,
    {
      commits,
      cwd,
      logger: { log() {} },
    },
  );
  return releaseType !== null;
}

async function analyzeCommits(_pluginConfig, context) {
  const fragments = readFragments(context.cwd);
  const releaseType = releaseTypeFromFragments(fragments);
  if (releaseType) {
    context.logger.log(
      `Selected ${releaseType} release from ${fragments.length} bilingual changelog fragment(s)`,
    );
  }
  return releaseType;
}

async function verifyRange(cwd, base) {
  if (!await hasReleasableCommit(cwd, base)) {
    return;
  }
  if (getChangedFragmentPaths(cwd, base).length === 0) {
    throw new Error(
      `Releasable commits since ${base} require a bilingual .changes/*.json fragment`,
    );
  }
}

async function verifyConditions(_pluginConfig, context) {
  readFragments(context.cwd);
}

async function prepare(_pluginConfig, context) {
  const fragments = readFragments(context.cwd);
  if (fragments.length === 0) {
    throw new Error(
      'A releasable change requires at least one bilingual .changes/*.json fragment',
    );
  }

  const version = context.nextRelease.version;
  const date = new Date().toISOString().slice(0, 10);
  for (const locale of Object.keys(CHANGELOGS)) {
    prependRelease(
      context.cwd,
      locale,
      renderRelease(version, date, locale, fragments),
    );
  }
  stageFragmentDeletions(context.cwd, fragments);
  context.logger.log(
    `Updated bilingual changelogs for ${version} from ${fragments.length} fragment(s)`,
  );
}

async function runCli(cwd, args) {
  const fragments = readFragments(cwd);
  const baseIndex = args.indexOf('--base');
  if (baseIndex !== -1) {
    const base = args[baseIndex + 1];
    if (!base) {
      throw new Error('--base requires a Git revision');
    }
    await verifyRange(cwd, base);
  }
  process.stdout.write(
    `Validated ${fragments.length} bilingual changelog fragment(s)\n`,
  );
}

if (require.main === module) {
  runCli(process.cwd(), process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  analyzeCommits,
  verifyConditions,
  prepare,
  _internals: {
    getFragmentPaths,
    getChangedFragmentPaths,
    getCommitMessages,
    hasReleasableCommit,
    prependRelease,
    readFragments,
    releaseTypeFromFragments,
    renderRelease,
    stageFragmentDeletions,
    verifyRange,
  },
};
