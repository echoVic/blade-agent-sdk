const parserOpts = {
  breakingHeaderPattern: /^(\w*)(?:\((.*)\))?!: (.*)$/,
  breakingHeaderCorrespondence: ['type', 'scope', 'subject'],
};

// A commit type alone sets the version: feat is a minor, `!` or BREAKING CHANGE a
// major, and everything the project treats as releasable ships a patch. This
// mirrors the fragment types so a docs-only or refactor-only change still
// releases, which the fragment-driven version used to provide.
//
// Order matters: the first matching rule wins, so `breaking` must be tested
// before any type rule or a BREAKING CHANGE commit would be downgraded to patch.
const releaseRules = [
  { breaking: true, release: 'major' },
  { revert: true, release: 'patch' },
  { type: 'docs', release: 'patch' },
  { type: 'refactor', release: 'patch' },
  { type: 'performance', release: 'patch' },
  { type: 'build', release: 'patch' },
];

module.exports = {
  branches: ['main'],
  tagFormat: 'v${version}',
  plugins: [
    ['@semantic-release/commit-analyzer', { parserOpts, releaseRules }],
    ['@semantic-release/release-notes-generator', { parserOpts }],
    './scripts/semantic-release-bilingual-changelog.cjs',
    '@semantic-release/npm',
    [
      '@semantic-release/git',
      {
        assets: [
          'package.json',
          'CHANGELOG.md',
          'CHANGELOG.zh-CN.md',
        ],
        message: 'chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}',
      },
    ],
    '@semantic-release/github',
  ],
};
