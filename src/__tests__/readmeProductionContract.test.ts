import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('README production contract', () => {
  const readme = readFileSync('README.md', 'utf8');

  it('presents the Pi-style three-package architecture as installable public packages', () => {
    expect(readme).toContain('npm install @blade-ai/ai @blade-ai/agent @blade-ai/agent-sdk');
    expect(readme).toContain('import { createOpenAICompatibleModelPort } from \'@blade-ai/ai\'');
    expect(readme).toContain('import { AgentKernel } from \'@blade-ai/agent\'');
    expect(readme).toContain('import { createSession } from \'@blade-ai/agent-sdk\'');
  });

  it('documents the production verification and release smoke chain from the root entry', () => {
    expect(readme).toContain('pnpm run verify');
    expect(readme).toContain('pnpm run verify:packages');
    expect(readme).toContain('pnpm run verify:entrypoints');
    expect(readme).toContain('pnpm run test:integration:live');
    expect(readme).toContain('pnpm run test:live:session-glm');
    expect(readme).toContain('pnpm run release:dry');
    expect(readme).toContain('packed tarball');
    expect(readme).toContain('temporary consumer');
    expect(readme).toContain('INTEGRATION_LIVE=1');
  });

  it('distinguishes CLI-process embedding from a CLI product package', () => {
    const packageReadme = readFileSync('packages/agent-sdk/README.md', 'utf8');
    const apiReference = readFileSync('docs/api-reference.md', 'utf8');
    const checklist = readFileSync('docs/production-checklist.md', 'utf8');

    for (const doc of [readme, packageReadme, apiReference, checklist]) {
      expect(doc).toContain('CLI process embedding');
      expect(doc).toContain('does not publish a CLI product');
      expect(doc).toContain('@blade-ai/agent-sdk/cli');
    }
  });
});
