import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const require = createRequire(import.meta.url);

describe('semantic-release configuration', () => {
  it('publishes only from main with v-prefixed tags', () => {
    const config = require('../../release.config.cjs');

    expect(config.branches).toEqual(['main']);
    expect(config.tagFormat).toBe('v${version}');
  });

  it('analyzes conventional commits, synchronizes workspace manifests, publishes all packages, then creates GitHub notes', () => {
    const config = require('../../release.config.cjs');

    expect(config.plugins).toEqual([
      '@semantic-release/commit-analyzer',
      '@semantic-release/release-notes-generator',
      './scripts/semantic-release/sync-workspace-versions.cjs',
      ['@semantic-release/npm', { pkgRoot: 'packages/ai' }],
      ['@semantic-release/npm', { pkgRoot: 'packages/agent' }],
      ['@semantic-release/npm', { pkgRoot: 'packages/agent-sdk' }],
      '@semantic-release/github',
    ]);
  });
});

describe('package provenance metadata', () => {
  it('declares the GitHub repository URL and public npm publish config on every publishable package', () => {
    const packagePaths = [
      'packages/ai/package.json',
      'packages/agent/package.json',
      'packages/agent-sdk/package.json',
    ];

    for (const packagePath of packagePaths) {
      const packageJson = JSON.parse(readFileSync(resolve(packagePath), 'utf8'));

      expect(packageJson.private).toBe(false);
      expect(packageJson.repository).toEqual({
        type: 'git',
        url: 'https://github.com/echoVic/blade-agent-sdk',
      });
      expect(packageJson.publishConfig).toEqual({
        access: 'public',
        registry: 'https://registry.npmjs.org/',
      });
    }
  });
});

describe('release scripts', () => {
  it('keeps a semantic-release dry-run command for tokened release rehearsal without publishing', () => {
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));

    expect(packageJson.scripts['release:dry']).toBe('semantic-release --dry-run --no-ci');
  });

  it('documents the GitHub token requirement for semantic-release dry runs', () => {
    const readme = readFileSync(resolve('README.md'), 'utf8');

    expect(readme).toContain('GITHUB_TOKEN');
    expect(readme).toContain('GH_TOKEN');
    expect(readme).toContain('@blade-ai/ai');
    expect(readme).toContain('@blade-ai/agent');
    expect(readme).toContain('@blade-ai/agent-sdk');
  });

  it('synchronizes workspace package versions and internal dependencies before npm publish', async () => {
    const { syncWorkspaceVersions } = require('../../scripts/semantic-release/sync-workspace-versions.cjs');
    const cwd = mkdtempSync(join(tmpdir(), 'blade-release-sync-'));
    const packages = ['ai', 'agent', 'agent-sdk'];

    for (const packageName of packages) {
      const packageDir = join(cwd, 'packages', packageName);
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(
        join(packageDir, 'package.json'),
        JSON.stringify({
          name: `@blade-ai/${packageName}`,
          version: '0.0.0',
          dependencies: packageName === 'ai'
            ? { zod: '^3.25.0' }
            : { '@blade-ai/ai': 'workspace:*' },
          optionalDependencies: packageName === 'agent-sdk'
            ? { '@blade-ai/agent': 'workspace:*' }
            : undefined,
        }, null, 2),
      );
    }

    await syncWorkspaceVersions({
      cwd,
      nextRelease: { version: '2.3.4' },
    });

    for (const packageName of packages) {
      const manifest = JSON.parse(
        readFileSync(join(cwd, 'packages', packageName, 'package.json'), 'utf8'),
      );
      expect(manifest.version).toBe('2.3.4');
      expect(JSON.stringify(manifest)).not.toContain('workspace:');
      if (packageName === 'agent') {
        expect(manifest.dependencies['@blade-ai/ai']).toBe('2.3.4');
      }
      if (packageName === 'agent-sdk') {
        expect(manifest.dependencies['@blade-ai/ai']).toBe('2.3.4');
        expect(manifest.optionalDependencies['@blade-ai/agent']).toBe('2.3.4');
      }
    }
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
      'pnpm run verify',
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
