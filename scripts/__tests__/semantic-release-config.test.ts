import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const require = createRequire(import.meta.url);

describe('semantic-release configuration', () => {
  it('publishes only from main with v-prefixed tags', () => {
    const config = require('../../release.config.cjs');

    expect(config.branches).toEqual(['main']);
    expect(config.tagFormat).toBe('v${version}');
  });

  it('updates bilingual changelogs and commits release metadata before publishing', () => {
    const config = require('../../release.config.cjs');

    expect(config.plugins).toEqual([
      '@semantic-release/commit-analyzer',
      '@semantic-release/release-notes-generator',
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
          message:
            'chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}',
        },
      ],
      '@semantic-release/github',
    ]);
  });
});

describe('package provenance metadata', () => {
  it('declares the GitHub repository URL expected by npm provenance', () => {
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));

    expect(packageJson.repository).toEqual({
      type: 'git',
      url: 'https://github.com/echoVic/blade-agent-sdk',
    });
  });

  it('uses the latest released version and a single release entry point', () => {
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));

    expect(packageJson.version).toBe('3.0.0');
    expect(packageJson.scripts.release).toBe('semantic-release');
    expect(packageJson.scripts).not.toHaveProperty('release:legacy');
  });
});

describe('release workflow', () => {
  it('runs after pushes to main and grants the release permissions', () => {
    const workflow = parse(
      readFileSync(resolve('.github/workflows/release.yml'), 'utf8')
    );

    expect(workflow.on.push.branches).toEqual(['main']);
    expect(workflow.permissions).toMatchObject({
      contents: 'write',
      issues: 'write',
      'pull-requests': 'write',
      'id-token': 'write',
    });
  });

  it('verifies the package before running semantic-release with trusted publishing', () => {
    const workflow = parse(
      readFileSync(resolve('.github/workflows/release.yml'), 'utf8')
    );
    const steps = workflow.jobs.release.steps;
    const commands = steps.map((step: { run?: string }) => step.run).filter(Boolean);
    const setupNodeStep = steps.find((step: { uses?: string }) =>
      step.uses?.startsWith('actions/setup-node@')
    );
    const releaseStep = steps.find((step: { run?: string }) =>
      step.run?.includes('semantic-release')
    );

    expect(commands).toEqual([
      'npm install -g npm@^11.5.1',
      'pnpm install --frozen-lockfile',
      'pnpm run changelog:check',
      'pnpm run lint',
      'pnpm run type-check',
      'pnpm run build',
      'pnpm run docs:build',
      'pnpm run test',
      'pnpm exec semantic-release',
    ]);
    expect(setupNodeStep.with).toMatchObject({
      'node-version': '22.14',
      'registry-url': 'https://registry.npmjs.org',
    });
    expect(releaseStep.env).toMatchObject({
      GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
    });
    expect(releaseStep.env).not.toHaveProperty('NPM_TOKEN');
    expect(releaseStep.env).not.toHaveProperty('NPM_CONFIG_PROVENANCE');
  });
});

describe('pull request workflow', () => {
  it('checks changed release fragments and builds the documentation', () => {
    const workflow = parse(
      readFileSync(resolve('.github/workflows/ci.yml'), 'utf8')
    );
    const steps = workflow.jobs.verify.steps;
    const checkout = steps.find((step: { uses?: string }) =>
      step.uses?.startsWith('actions/checkout@')
    );
    const commands = steps
      .map((step: { run?: string }) => step.run)
      .filter(Boolean);

    expect(checkout.with).toMatchObject({ 'fetch-depth': 0 });
    expect(commands).toContain('pnpm run changelog:check');
    expect(commands).toContain(
      'pnpm run changelog:check -- --base "${{ github.event.pull_request.base.sha }}"'
    );
    expect(commands).toContain('pnpm run docs:build');
  });
});
