import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';

const require = createRequire(import.meta.url);
const publishablePackages = [
  {
    dir: 'packages/ai',
    name: '@blade-ai/ai',
    npmPlugin: ['@semantic-release/npm', { pkgRoot: 'packages/ai' }],
  },
  {
    dir: 'packages/agent',
    name: '@blade-ai/agent',
    npmPlugin: ['@semantic-release/npm', { pkgRoot: 'packages/agent' }],
  },
  {
    dir: 'packages/agent-sdk',
    name: '@blade-ai/agent-sdk',
    npmPlugin: ['@semantic-release/npm', { pkgRoot: 'packages/agent-sdk' }],
  },
];

function fail(message) {
  throw new Error(`[verify-release] ${message}`);
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

function assertDeepEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function verifyRootScripts() {
  const packageJson = readJson('package.json');
  const verifyScript = packageJson.scripts?.verify ?? '';

  if (packageJson.scripts?.['release:dry'] !== 'semantic-release --dry-run --no-ci') {
    fail('package.json must keep release:dry as semantic-release --dry-run --no-ci');
  }
  if ('release:legacy' in (packageJson.scripts ?? {})) {
    fail('package.json must not expose the retired release:legacy script');
  }
  if ('release:manual' in (packageJson.scripts ?? {})) {
    fail('package.json must not expose manual release script aliases');
  }
  if (JSON.stringify(packageJson.scripts ?? {}).includes('scripts/release.js')) {
    fail('package.json scripts must not reference scripts/release.js');
  }
  if (existsSync(resolve('scripts/release.js'))) {
    fail('scripts/release.js has been retired in favor of semantic-release');
  }
  if (existsSync(resolve('scripts/release-utils.js'))) {
    fail('scripts/release-utils.js must not remain after retiring the manual release script');
  }
  if (packageJson.scripts?.['verify:release'] !== 'node scripts/verify-release-config.mjs') {
    fail('package.json must expose verify:release');
  }
  if (packageJson.scripts?.['verify:published'] !== 'node scripts/verify-published.mjs') {
    fail('package.json must expose verify:published for post-publish checks');
  }
  if (!verifyScript.includes('pnpm run verify:packages && pnpm run verify:release && pnpm run test:unit')) {
    fail('package.json verify script must run verify:release after package verification and before tests');
  }
}

function verifySemanticReleaseConfig() {
  const config = require('../release.config.cjs');
  const expectedPlugins = [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    './scripts/semantic-release/monorepo-release-notes.cjs',
    './scripts/semantic-release/sync-workspace-versions.cjs',
    ...publishablePackages.map((pkg) => pkg.npmPlugin),
    '@semantic-release/github',
  ];

  assertDeepEqual(config.branches, ['main'], 'semantic-release branches');
  if (config.tagFormat !== 'v${version}') {
    fail('semantic-release tagFormat must be v${version}');
  }
  assertDeepEqual(config.plugins, expectedPlugins, 'semantic-release plugins');
}

function verifyPackageMetadata() {
  for (const pkg of publishablePackages) {
    const manifest = readJson(`${pkg.dir}/package.json`);
    const readme = readFileSync(resolve(pkg.dir, 'README.md'), 'utf8');

    if (manifest.name !== pkg.name) {
      fail(`${pkg.dir}/package.json name must be ${pkg.name}`);
    }
    if (manifest.private !== false) {
      fail(`${pkg.name} must be publishable`);
    }
    if (manifest.license !== 'MIT') {
      fail(`${pkg.name} must declare MIT license`);
    }
    assertDeepEqual(manifest.engines, { node: '>=22.14.0' }, `${pkg.name} engines`);
    assertDeepEqual(manifest.publishConfig, {
      access: 'public',
      provenance: true,
      registry: 'https://registry.npmjs.org/',
    }, `${pkg.name} publishConfig`);
    assertDeepEqual(manifest.repository, {
      type: 'git',
      url: 'https://github.com/echoVic/blade-agent-sdk',
    }, `${pkg.name} repository`);
    if (!readme.includes(pkg.name)) {
      fail(`${pkg.name} README must name the package`);
    }
  }
}

async function verifyPreparedReleaseManifestVersions() {
  const { syncWorkspaceVersions } = require('./semantic-release/sync-workspace-versions.cjs');
  const version = '123.45.67';
  const tempDir = mkdtempSync(join(tmpdir(), 'blade-release-manifests-'));

  try {
    for (const pkg of publishablePackages) {
      const sourceManifest = readFileSync(resolve(pkg.dir, 'package.json'), 'utf8');
      const targetManifest = join(tempDir, pkg.dir, 'package.json');
      mkdirSync(dirname(targetManifest), { recursive: true });
      writeFileSync(targetManifest, sourceManifest);
    }

    await syncWorkspaceVersions({
      cwd: tempDir,
      nextRelease: { version },
    });

    for (const pkg of publishablePackages) {
      const manifest = JSON.parse(readFileSync(join(tempDir, pkg.dir, 'package.json'), 'utf8'));
      const serializedManifest = JSON.stringify(manifest);

      if (manifest.version !== version) {
        fail(`${pkg.name} prepared manifest version must be ${version}`);
      }
      if (serializedManifest.includes('workspace:')) {
        fail(`${pkg.name} prepared manifest must not contain workspace: dependencies`);
      }
      if (serializedManifest.includes('0.0.0')) {
        fail(`${pkg.name} prepared manifest must not contain 0.0.0 placeholder versions`);
      }
      for (const dependencyBlock of [
        manifest.dependencies,
        manifest.peerDependencies,
        manifest.optionalDependencies,
      ]) {
        for (const [name, dependencyVersion] of Object.entries(dependencyBlock ?? {})) {
          if (publishablePackages.some((candidate) => candidate.name === name) && dependencyVersion !== version) {
            fail(`${pkg.name} prepared manifest dependency ${name} must be ${version}`);
          }
        }
      }
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function verifyReleaseWorkflow() {
  const workflow = parse(readFileSync(resolve('.github/workflows/release.yml'), 'utf8'));
  const steps = workflow.jobs?.release?.steps ?? [];
  const commands = steps.map((step) => step.run).filter(Boolean);
  const setupPnpmStep = steps.find((step) => step.uses?.startsWith('pnpm/action-setup@'));
  const setupNodeStep = steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
  const releaseStep = steps.find((step) => step.run?.includes('semantic-release'));

  assertDeepEqual(workflow.on?.push?.branches, ['main'], 'release workflow push branches');
  if (workflow.permissions?.['id-token'] !== 'write') {
    fail('release workflow must grant id-token: write for trusted publishing');
  }
  assertDeepEqual(commands, [
    'npm install -g npm@^11.5.1',
    'pnpm install --frozen-lockfile',
    'pnpm run verify',
    'pnpm exec semantic-release',
  ], 'release workflow commands');
  if (setupNodeStep?.with?.['registry-url'] !== 'https://registry.npmjs.org') {
    fail('release workflow setup-node must target the npm registry');
  }
  if (setupPnpmStep?.with?.version !== '11.7.0') {
    fail('release workflow must pin pnpm/action-setup to pnpm 11.7.0');
  }
  if (releaseStep?.env?.GITHUB_TOKEN !== '${{ secrets.GITHUB_TOKEN }}') {
    fail('release workflow must pass GITHUB_TOKEN to semantic-release');
  }
  if ('NPM_TOKEN' in (releaseStep?.env ?? {})) {
    fail('release workflow must not rely on a long-lived NPM_TOKEN');
  }
}

verifyRootScripts();
verifySemanticReleaseConfig();
verifyPackageMetadata();
await verifyPreparedReleaseManifestVersions();
verifyReleaseWorkflow();

console.log('release configuration verification passed');
