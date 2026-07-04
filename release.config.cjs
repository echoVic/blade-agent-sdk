module.exports = {
  branches: ['main'],
  tagFormat: 'v${version}',
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    './scripts/semantic-release/sync-workspace-versions.cjs',
    ['@semantic-release/npm', { pkgRoot: 'packages/ai' }],
    ['@semantic-release/npm', { pkgRoot: 'packages/agent' }],
    ['@semantic-release/npm', { pkgRoot: 'packages/agent-sdk' }],
    '@semantic-release/github',
  ],
};
