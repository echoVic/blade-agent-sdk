import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';

const require = createRequire(import.meta.url);
const requiredKeywords = ['agent', 'sdk', 'llm'];
const mitPermissionGrant = 'Permission is hereby granted, free of charge';
const workspaceManifestPaths = [
  'package.json',
  'packages/ai/package.json',
  'packages/agent/package.json',
  'packages/agent-sdk/package.json',
];
const dependencySections = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];
const trustedPublishingNpmCliCommand = 'npm install -g npm@11.5.1 --ignore-scripts';
const exactVersionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z-.]+)?$/;
const allowedDependencyBuildScripts = {
  '@vscode/ripgrep': true,
  esbuild: true,
  'node-pty': true,
};
const publishablePackages = [
  {
    dir: 'packages/ai',
    name: '@blade-ai/ai',
    description: 'Provider-agnostic AI model interfaces for Blade Agent',
    author: 'echoVic',
    publishFiles: ['dist', 'LICENSE', 'README.md'],
    npmPlugin: ['@semantic-release/npm', { pkgRoot: 'packages/ai' }],
    installCommand: 'pnpm add @blade-ai/ai',
    importSnippet: "import { createOpenAICompatibleModelPort } from '@blade-ai/ai';",
  },
  {
    dir: 'packages/agent',
    name: '@blade-ai/agent',
    description: 'Runtime-independent Blade Agent kernel contracts',
    author: 'echoVic',
    publishFiles: ['dist', 'LICENSE', 'README.md'],
    npmPlugin: ['@semantic-release/npm', { pkgRoot: 'packages/agent' }],
    installCommand: 'pnpm add @blade-ai/agent',
    importSnippet: "import { AgentKernel } from '@blade-ai/agent';",
  },
  {
    dir: 'packages/agent-sdk',
    name: '@blade-ai/agent-sdk',
    description: 'Session-first Blade Agent SDK',
    author: 'echoVic',
    publishFiles: ['dist', 'vendor/ripgrep/**', 'LICENSE', 'README.md'],
    npmPlugin: ['@semantic-release/npm', { pkgRoot: 'packages/agent-sdk' }],
    installCommand: 'pnpm add @blade-ai/agent-sdk',
    importSnippet: "import { createSession } from '@blade-ai/agent-sdk';",
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

function verifyRootPackagePublishSafety() {
  const packageJson = readJson('package.json');
  const config = require('../release.config.cjs');

  if (packageJson.private !== true) {
    fail('root package.json must remain private');
  }
  if ('publishConfig' in packageJson) {
    fail('root package.json must not declare publishConfig');
  }
  if ('files' in packageJson) {
    fail('root package.json must not declare published files');
  }
  for (const plugin of config.plugins ?? []) {
    const isNpmPlugin = Array.isArray(plugin) ? plugin[0] === '@semantic-release/npm' : plugin === '@semantic-release/npm';
    const pkgRoot = Array.isArray(plugin) ? plugin[1]?.pkgRoot : undefined;

    if (isNpmPlugin && (pkgRoot === undefined || pkgRoot === '.')) {
      fail('semantic-release must not publish the workspace root package');
    }
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
    const license = readFileSync(resolve(pkg.dir, 'LICENSE'), 'utf8');

    if (manifest.name !== pkg.name) {
      fail(`${pkg.dir}/package.json name must be ${pkg.name}`);
    }
    if (manifest.private !== false) {
      fail(`${pkg.name} must be publishable`);
    }
    if (manifest.description !== pkg.description) {
      fail(`${pkg.name} must declare package description`);
    }
    if (manifest.author !== pkg.author) {
      fail(`${pkg.name} must declare package author`);
    }
    if (manifest.type !== 'module') {
      fail(`${pkg.name} must be ESM-only`);
    }
    if (manifest.sideEffects !== false) {
      fail(`${pkg.name} must declare sideEffects false`);
    }
    assertDeepEqual(manifest.files, pkg.publishFiles, `${pkg.name} published files`);
    if (manifest.license !== 'MIT') {
      fail(`${pkg.name} must declare MIT license`);
    }
    if (!license.includes(mitPermissionGrant)) {
      fail(`${pkg.name} LICENSE must include the MIT permission grant`);
    }
    if (manifest.homepage !== 'https://github.com/echoVic/blade-agent-sdk#readme') {
      fail(`${pkg.name} must declare the project homepage`);
    }
    assertDeepEqual(manifest.bugs, {
      url: 'https://github.com/echoVic/blade-agent-sdk/issues',
    }, `${pkg.name} bugs`);
    for (const keyword of requiredKeywords) {
      if (!manifest.keywords?.includes(keyword)) {
        fail(`${pkg.name} keywords must include ${keyword}`);
      }
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
    if (!readme.includes(pkg.installCommand)) {
      fail(`${pkg.name} README must document direct installation`);
    }
    if (!readme.includes(pkg.importSnippet)) {
      fail(`${pkg.name} README must document direct import usage`);
    }
  }
}

function verifyExactDirectDependencyVersions() {
  for (const manifestPath of workspaceManifestPaths) {
    const manifest = readJson(manifestPath);
    for (const section of dependencySections) {
      for (const [dependencyName, dependencyVersion] of Object.entries(manifest[section] ?? {})) {
        const version = String(dependencyVersion);
        const isWorkspaceInternal = version === 'workspace:*' && dependencyName.startsWith('@blade-ai/');
        if (!isWorkspaceInternal && !exactVersionPattern.test(version)) {
          fail(`${manifestPath} ${section}.${dependencyName} must use an exact dependency version, got ${version}`);
        }
      }
    }
  }
}

function verifyPnpmWorkspaceSupplyChainPolicy() {
  const workspace = parse(readFileSync(resolve('pnpm-workspace.yaml'), 'utf8'));

  assertDeepEqual(
    workspace.allowBuilds,
    allowedDependencyBuildScripts,
    'pnpm-workspace.yaml allowBuilds must stay limited to approved dependency build scripts',
  );
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
      if ('private' in manifest) {
        fail(`${pkg.name} prepared manifest must not contain private metadata`);
      }
      if ('devDependencies' in manifest) {
        fail(`${pkg.name} prepared manifest must not contain devDependencies`);
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
  const checkoutStep = steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  const setupPnpmStep = steps.find((step) => step.uses?.startsWith('pnpm/action-setup@'));
  const setupNodeStep = steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
  const releaseStep = steps.find((step) => step.run?.includes('semantic-release'));
  const releaseStepIndex = steps.findIndex((step) => step.run?.includes('semantic-release'));
  const captureTagStep = steps.find((step) => step.name === 'Capture latest release tag');
  const captureTagStepIndex = steps.indexOf(captureTagStep);
  const postPublishStep = steps.find((step) => step.name === 'Verify published artifacts');
  const postPublishStepIndex = steps.indexOf(postPublishStep);
  const trustedPublishingNpmCliStep = commands.find((command) => command.startsWith('npm install -g npm@'));

  assertDeepEqual(workflow.on?.push?.branches, ['main'], 'release workflow push branches');
  assertDeepEqual(workflow.concurrency, {
    group: 'release-main',
    'cancel-in-progress': false,
  }, 'release workflow concurrency');
  if (workflow.permissions?.['id-token'] !== 'write') {
    fail('release workflow must grant id-token: write for trusted publishing');
  }
  if (workflow.concurrency?.group !== 'release-main') {
    fail('release workflow must serialize main-branch publishing jobs');
  }
  if (workflow.concurrency?.['cancel-in-progress'] !== false) {
    fail('release workflow must not cancel an in-flight publish');
  }
  if (checkoutStep?.with?.['fetch-depth'] !== 0) {
    fail('release workflow checkout must fetch full git history');
  }
  if (!trustedPublishingNpmCliStep?.includes('--ignore-scripts')) {
    fail('release workflow trusted-publishing npm CLI upgrade must ignore lifecycle scripts');
  }
  if (trustedPublishingNpmCliStep !== trustedPublishingNpmCliCommand) {
    fail('release workflow must pin the trusted-publishing npm CLI to npm@11.5.1');
  }
  assertDeepEqual(commands, [
    trustedPublishingNpmCliCommand,
    'pnpm install --frozen-lockfile --ignore-scripts',
    'pnpm run verify',
    captureTagStep?.run,
    'pnpm exec semantic-release',
    postPublishStep?.run,
  ], 'release workflow commands');
  if (setupNodeStep?.with?.['registry-url'] !== 'https://registry.npmjs.org') {
    fail('release workflow setup-node must target the npm registry');
  }
  if (setupNodeStep?.with?.['node-version'] !== '22.14') {
    fail('release workflow Node version must match the package engine floor');
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
  if (captureTagStepIndex >= releaseStepIndex || captureTagStepIndex < 0) {
    fail('release workflow must capture the previous release tag before semantic-release');
  }
  if (!captureTagStep?.run?.includes('PREVIOUS_RELEASE_TAG=')) {
    fail('release workflow must export PREVIOUS_RELEASE_TAG before semantic-release');
  }
  if (!captureTagStep?.run?.includes('$GITHUB_ENV')) {
    fail('release workflow must persist PREVIOUS_RELEASE_TAG through GITHUB_ENV');
  }
  if (postPublishStepIndex <= releaseStepIndex) {
    fail('release workflow must verify published artifacts after semantic-release');
  }
  if (!postPublishStep?.run?.includes('git fetch --tags --force')) {
    fail('post-publish verification must refresh release tags');
  }
  if (!postPublishStep?.run?.includes("git describe --tags --abbrev=0 --match 'v*'")) {
    fail('post-publish verification must discover the latest v* release tag');
  }
  if (!postPublishStep?.run?.includes('pnpm run verify:published -- --version "$published_version"')) {
    fail('post-publish verification must run verify:published for the discovered version');
  }
  if (!postPublishStep?.run?.includes('$PREVIOUS_RELEASE_TAG')) {
    fail('post-publish verification must compare against the pre-release tag');
  }
  if (!postPublishStep?.run?.includes('[ "$published_version" = "$PREVIOUS_RELEASE_TAG" ]')) {
    fail('post-publish verification must skip when semantic-release created no new tag');
  }
  if (postPublishStep?.env?.GH_TOKEN !== '${{ secrets.GITHUB_TOKEN }}') {
    fail('post-publish verification must pass GH_TOKEN for gh release checks');
  }
}

function verifyCiWorkflow() {
  const workflow = parse(readFileSync(resolve('.github/workflows/ci.yml'), 'utf8'));
  const verifyJob = workflow.jobs?.verify;
  const steps = verifyJob?.steps ?? [];
  const commands = steps.map((step) => step.run).filter(Boolean);
  const setupPnpmStep = steps.find((step) => step.uses?.startsWith('pnpm/action-setup@'));

  assertDeepEqual(verifyJob?.strategy?.matrix?.['node-version'], ['22'], 'ci workflow node versions');
  assertDeepEqual(commands, [
    'pnpm install --frozen-lockfile --ignore-scripts',
    'pnpm run verify',
  ], 'ci workflow commands');
  if (setupPnpmStep?.with?.version !== '11.7.0') {
    fail('ci workflow must pin pnpm/action-setup to pnpm 11.7.0');
  }
  if (!verifyJob?.strategy?.matrix?.['node-version']?.includes('22')) {
    fail('ci workflow must run on Node 22');
  }
}

function verifyWorkflowDependencyInstalls() {
  const workflowPaths = [
    '.github/workflows/ci.yml',
    '.github/workflows/release.yml',
    '.github/workflows/deploy-docs.yml',
  ];

  for (const workflowPath of workflowPaths) {
    const workflow = parse(readFileSync(resolve(workflowPath), 'utf8'));
    const jobs = Object.values(workflow.jobs ?? {});
    const installCommands = [];
    for (const job of jobs) {
      for (const step of job.steps ?? []) {
        if (typeof step.run === 'string' && step.run.startsWith('pnpm install')) {
          installCommands.push(step.run);
        }
      }
    }

    if (installCommands.length === 0) {
      fail(`${workflowPath} must include a pnpm install dependency step`);
    }
    for (const command of installCommands) {
      if (!command.includes('--frozen-lockfile') || !command.includes('--ignore-scripts')) {
        fail(`${workflowPath} workflow dependency install commands must ignore lifecycle scripts and use the frozen lockfile`);
      }
    }
  }
}

verifyRootPackagePublishSafety();
verifyRootScripts();
verifySemanticReleaseConfig();
verifyPackageMetadata();
verifyExactDirectDependencyVersions();
verifyPnpmWorkspaceSupplyChainPolicy();
await verifyPreparedReleaseManifestVersions();
verifyReleaseWorkflow();
verifyCiWorkflow();
verifyWorkflowDependencyInstalls();

console.log('release configuration verification passed');
