import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  assertVersionAdvance,
  compareVersions,
  parseReleaseTag,
} from '../release-from-tag.mjs';

describe('release tag parsing', () => {
  it('accepts a v-prefixed three-part version and normalizes it', () => {
    expect(parseReleaseTag('v7.4.2')).toEqual({ version: '7.4.2', parts: [7, 4, 2] });
    expect(parseReleaseTag(' v10.0.15 ')).toEqual({ version: '10.0.15', parts: [10, 0, 15] });
    expect(parseReleaseTag('v07.04.02').version).toBe('7.4.2');
  });

  it('rejects anything that is not a plain release tag', () => {
    for (const tag of ['7.4.2', 'v7.4', 'v7.4.2-beta.1', 'v7.4.2+build', 'latest', '', undefined]) {
      expect(() => parseReleaseTag(tag as string), String(tag)).toThrow(
        'Release tag must look like v<major>.<minor>.<patch>',
      );
    }
  });
});

describe('release version ordering', () => {
  it('orders versions numerically rather than lexically', () => {
    expect(compareVersions('7.10.0', '7.9.9')).toBe(1);
    expect(compareVersions('7.4.2', '7.4.10')).toBe(-1);
    expect(compareVersions('8.0.0', '7.99.99')).toBe(1);
    expect(compareVersions('7.4.2', '7.4.2')).toBe(0);
  });

  it('requires the tag to move forward and refuses to re-release a version', () => {
    expect(() => assertVersionAdvance('7.4.1', '7.4.2')).not.toThrow();
    expect(() => assertVersionAdvance('7.4.1', '8.0.0')).not.toThrow();
    expect(() => assertVersionAdvance('7.4.1', '7.4.1')).toThrow(
      'must be greater than the current package version 7.4.1',
    );
    expect(() => assertVersionAdvance('7.4.1', '7.4.0')).toThrow(
      'must be greater than the current package version 7.4.1',
    );
  });
});

describe('tag-driven version ownership', () => {
  it('keeps no commit-type release rules anywhere in the repository', () => {
    expect(existsSync(resolve('release.config.cjs'))).toBe(false);
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
    const scripts = JSON.stringify(packageJson.scripts);
    const devDependencies = JSON.stringify(packageJson.devDependencies ?? {});

    expect(scripts).not.toContain('semantic-release');
    expect(devDependencies).not.toContain('semantic-release');
    expect(packageJson.scripts.release).toBe('node scripts/release-from-tag.mjs');
  });

  it('aligns the package version with the newest changelog entry', () => {
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
    const changelog = readFileSync(resolve('CHANGELOG.md'), 'utf8');
    const latestVersion = /^## \[([^\]]+)\]/m.exec(changelog)?.[1];

    expect(packageJson.version).toBe(latestVersion);
  });
});

describe('release workflow', () => {
  const workflow = () => parse(readFileSync(resolve('.github/workflows/release.yml'), 'utf8'));

  it('publishes only when a release tag is pushed', () => {
    expect(workflow().on.push).toEqual({ tags: ['v*'] });
    expect(workflow().on.push.branches).toBeUndefined();
    expect(workflow().on.workflow_dispatch.inputs.tag.required).toBe(true);
  });

  it('grants the permissions the publish path needs', () => {
    expect(workflow().permissions).toMatchObject({
      contents: 'write',
      issues: 'write',
      'pull-requests': 'write',
      'id-token': 'write',
    });
  });

  it('verifies the package, then publishes the pushed tag from its own tree', () => {
    const steps = workflow().jobs.release.steps;
    const commands = steps.map((step: { run?: string }) => step.run).filter(Boolean);
    const setupNode = steps.find((step: { uses?: string }) =>
      step.uses?.startsWith('actions/setup-node@'));
    const releaseStep = steps.at(-1);

    expect(commands).toEqual([
      'npm install -g npm@^11.5.1',
      'pnpm install --frozen-lockfile',
      [
        'docker pull alpine:3.22',
        `echo "TEST_DOCKER_IMAGE=$(docker image inspect --format '{{index .RepoDigests 0}}' alpine:3.22)" >> "$GITHUB_ENV"`,
        '',
      ].join('\n'),
      'pnpm run changelog:check',
      'pnpm run lint',
      'pnpm run type-check',
      'pnpm run build',
      [
        'node scripts/verify-entrypoints.mjs',
        'node scripts/verify-minimal-install.mjs',
        '',
      ].join('\n'),
      'pnpm run verify:create-agent',
      'pnpm run verify:production-example',
      'pnpm run verify:runtime-regression',
      'pnpm run docs:build',
      'pnpm run test',
      'node scripts/release-from-tag.mjs --tag "${{ inputs.tag || github.ref_name }}"',
    ]);
    expect(setupNode.with).toMatchObject({ 'node-version': '22.14' });
    expect(releaseStep.name).toBe('Release');
    expect(releaseStep.env).toMatchObject({
      GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
      GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
    });
  });
});
