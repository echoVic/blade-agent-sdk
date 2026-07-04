const publishedPackages = [
  {
    name: '@blade-ai/ai',
    description: 'Provider-agnostic model runtime',
  },
  {
    name: '@blade-ai/agent',
    description: 'Runtime-independent agent kernel',
  },
  {
    name: '@blade-ai/agent-sdk',
    description: 'Session-first product SDK',
  },
];

async function generateMonorepoReleaseNotes(context) {
  const version = context?.nextRelease?.version;
  if (!version) {
    throw new Error('monorepo-release-notes requires context.nextRelease.version');
  }

  const packageLines = publishedPackages.map(
    ({ name, description }) => `- \`${name}@${version}\` - ${description}`,
  );

  return [
    '## Published packages',
    '',
    ...packageLines,
    '',
    'Session-first install:',
    '',
    '```bash',
    `pnpm add @blade-ai/agent-sdk@${version}`,
    '```',
  ].join('\n');
}

module.exports = {
  generateNotes: (_, context) => generateMonorepoReleaseNotes(context),
  generateMonorepoReleaseNotes,
};
