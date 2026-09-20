import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  assertBuiltArtifactsCarryVersion,
  assertCheckoutMatchesTag,
  assertVersionAdvance,
  compareVersions,
  parseReleaseTag,
} from '../release-from-tag.mjs';

const workflow = () => parse(readFileSync(resolve('.github/workflows/release.yml'), 'utf8'));

/**
 * The release workflow stamps the tag version into package.json *before* it
 * builds, so between the stamp and the release commit the manifest is one release
 * ahead of the newest changelog entry. Pending fragments are what makes that state
 * legitimate; a manifest ahead of the changelog with nothing pending, or behind
 * it, is a broken repository.
 */
function assertManifestMatchesChangelog(
  packageVersion: string,
  latestChangelog: string | undefined,
  pendingFragments: number,
): void {
  if (packageVersion === latestChangelog) {
    return;
  }
  expect(
    packageVersion.localeCompare(latestChangelog ?? '', undefined, { numeric: true }),
  ).toBeGreaterThan(0);
  expect(pendingFragments).toBeGreaterThan(0);
}

function countPendingFragments(): number {
  const directory = resolve('.changes');
  return existsSync(directory)
    ? readdirSync(directory).filter((name) => name.endsWith('.json')).length
    : 0;
}

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

describe('published source identity', () => {
  it('refuses to publish a tree that is not the tagged commit', () => {
    const tag = 'v7.4.4';
    const tagged = 'a'.repeat(40);
    expect(() => assertCheckoutMatchesTag(tagged, tagged, tag)).not.toThrow();
    expect(() => assertCheckoutMatchesTag('b'.repeat(40), tagged, tag)).toThrow(
      `Checked out ${'b'.repeat(40)} but ${tag} points at ${tagged}`,
    );
  });

  it('checks out the tag a manual run names', () => {
    const checkout = workflow().jobs.release.steps.find((step: { uses?: string }) =>
      step.uses?.startsWith('actions/checkout@'),
    );

    expect(checkout.with).toMatchObject({
      ref: '$' + '{{ inputs.tag || github.ref }}',
      'fetch-depth': 0,
    });
  });

  it('verifies the checkout inside the release script before publishing', () => {
    const script = readFileSync(resolve('scripts/release-from-tag.mjs'), 'utf8');
    const main = script.slice(script.indexOf('async function main()'));

    // The guard runs against HEAD inside main(), before anything is published.
    expect(main).toContain("assertCheckoutMatchesTag(git(['rev-parse', 'HEAD']), tagCommit, tag)");
    expect(main.indexOf('assertCheckoutMatchesTag(')).toBeLessThan(
      main.indexOf('await publishPackage('),
    );
  });
});

describe('built artifact identity', () => {
  function withDist(layout: Record<string, string>, run: (directory: string) => void): void {
    const directory = mkdtempSync(join(tmpdir(), 'blade-dist-'));
    try {
      for (const [file, content] of Object.entries(layout)) {
        mkdirSync(join(directory, file, '..'), { recursive: true });
        writeFileSync(join(directory, file), content);
      }
      run(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it('accepts a build whose bundle inlines the released version', () => {
    withDist(
      { 'dist/chunk-abc.js': '{name:"@blade-ai/agent-sdk",version:"7.4.4"}' },
      (directory) => {
        expect(() => assertBuiltArtifactsCarryVersion(directory, '7.4.4')).not.toThrow();
      },
    );
  });

  it('rejects a build that carries the previous version', () => {
    // The exact failure this guards: build first, stamp second.
    withDist(
      { 'dist/chunk-abc.js': '{name:"@blade-ai/agent-sdk",version:"7.4.3"}' },
      (directory) => {
        expect(() => assertBuiltArtifactsCarryVersion(directory, '7.4.4')).toThrow(
          'does not carry version 7.4.4',
        );
      },
    );
  });

  it('rejects a missing build instead of publishing an unverified artifact', () => {
    withDist({}, (directory) => {
      expect(() => assertBuiltArtifactsCarryVersion(join(directory, 'dist'), '7.4.4')).toThrow(
        'dist/ is missing',
      );
    });
  });

  it('stamps the version before the build in the release workflow', () => {
    const steps = workflow().jobs.release.steps as { name?: string; run?: string }[];
    const stampIndex = steps.findIndex((step) => step.run?.includes('--stamp-only'));
    const buildIndex = steps.findIndex((step) => step.run === 'pnpm run build');

    expect(stampIndex).toBeGreaterThan(-1);
    expect(stampIndex).toBeLessThan(buildIndex);
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

    assertManifestMatchesChangelog(packageJson.version, latestVersion, countPendingFragments());
  });

  it('accepts a stamped manifest that the release commit has not recorded yet', () => {
    // Exactly the state the release workflow runs its tests in.
    expect(() => assertManifestMatchesChangelog('7.4.4', '7.4.3', 1)).not.toThrow();
  });

  it('rejects a manifest that is behind the changelog', () => {
    expect(() => assertManifestMatchesChangelog('7.4.2', '7.4.3', 1)).toThrow();
  });

  it('rejects a manifest that is ahead of the changelog with nothing pending', () => {
    expect(() => assertManifestMatchesChangelog('7.4.4', '7.4.3', 0)).toThrow();
  });
});

describe('release workflow', () => {
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
      step.uses?.startsWith('actions/setup-node@'),
    );
    const releaseStep = steps.at(-1);

    expect(commands).toEqual([
      'npm install -g npm@^11.5.1',
      'pnpm install --frozen-lockfile',
      'sudo apt-get update && sudo apt-get install --yes ripgrep',
      'node scripts/release-from-tag.mjs --stamp-only --tag "$' +
        '{{ inputs.tag || github.ref_name }}"',
      [
        'docker pull alpine:3.22',
        `echo "TEST_DOCKER_IMAGE=$(docker image inspect --format '{{index .RepoDigests 0}}' alpine:3.22)" >> "$GITHUB_ENV"`,
        '',
      ].join('\n'),
      'pnpm run changelog:check',
      'pnpm run lint',
      'pnpm run type-check',
      'pnpm run build',
      ['node scripts/verify-entrypoints.mjs', 'node scripts/verify-minimal-install.mjs', ''].join(
        '\n',
      ),
      'pnpm run verify:create-agent',
      'pnpm run verify:production-example',
      'pnpm run verify:runtime-regression',
      'pnpm run docs:build',
      'pnpm run test',
      'node scripts/release-from-tag.mjs --tag "$' + '{{ inputs.tag || github.ref_name }}"',
    ]);
    expect(setupNode.with).toMatchObject({ 'node-version': '22.14' });
    expect(releaseStep.name).toBe('Release');
    expect(releaseStep.env).toMatchObject({
      GITHUB_TOKEN: '$' + '{{ secrets.GITHUB_TOKEN }}',
      GH_TOKEN: '$' + '{{ secrets.GITHUB_TOKEN }}',
    });
  });
});
