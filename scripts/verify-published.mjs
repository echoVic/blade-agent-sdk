import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import ssri from 'ssri';
import {
  agentSdkCoreDeclarationBrowserSafeRules,
  agentSdkEagerLegacySessionRuntimeClosureRules,
  agentSdkLocalAdapterBoundaryRules,
  agentSdkPermissionDeclarationBoundaryRules,
  agentSdkRootDeclarationEntryOwnershipRules,
  agentSdkRootPublicDeclarationBoundaryRules,
  agentSdkRootSubagentCompatibilityBoundaryRules,
  agentSdkServerFacadeBoundaryRules,
  agentSdkSessionConfigDeclarationBoundaryRules,
  agentSdkSessionEntrySessionBoundaryRules,
  agentSdkSessionFactoryDeclarationBoundaryRules,
  agentSdkSessionPublicDeclarationBoundaryRules,
  agentSdkSessionStoreDeclarationBoundaryRules,
  agentSdkToolsEntryBoundaryRules,
  toInstalledForbiddenFileRules,
} from './agent-sdk-boundary-rules.mjs';
import { bundleWithEsbuildRetry } from './esbuild-bundle.mjs';
import { isExactDependencyVersion } from './dependency-version-rules.mjs';
import {
  allowedPublicExportConditions,
  getManifestRootExportConditions,
  isBrowserConditionBeforeImport,
  isExactPackageJsonManifestExport,
  isTypesConditionFirst,
  verifyExportSubpathShape,
} from './package-export-rules.mjs';
import {
  createAgentPublicTypeImportBlock,
  createAiPublicTypeImportBlock,
  createSdkPublicTypeImportBlock,
} from './public-type-contracts.mjs';

const execFileAsync = promisify(execFile);

const defaultRepo = 'echoVic/blade-agent-sdk';
const publishablePackages = [
  '@blade-ai/ai',
  '@blade-ai/agent',
  '@blade-ai/agent-sdk',
];
const dependencySections = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
];
const nodeBuiltinModules = new Set(builtinModules);
const expectedPublishedPackageMetadata = {
  author: 'echoVic',
  type: 'module',
  sideEffects: false,
  license: 'MIT',
  engines: { node: '>=22.14.0' },
  homepage: 'https://github.com/echoVic/blade-agent-sdk#readme',
  bugs: {
    url: 'https://github.com/echoVic/blade-agent-sdk/issues',
  },
  repository: {
    type: 'git',
    url: 'https://github.com/echoVic/blade-agent-sdk',
  },
};
const expectedPublishedSdkBrowserExports = {
  '.': './dist/browser/index.js',
  './server': './dist/browser/server-only-stub.js',
  './session': './dist/browser/server-only-stub.js',
  './session/internal': './dist/browser/server-only-stub.js',
  './local': './dist/browser/server-only-stub.js',
};
const publishedSdkBrowserSafeEntries = [
  'node_modules/@blade-ai/agent-sdk/dist/browser/index.js',
  'node_modules/@blade-ai/agent-sdk/dist/core/index.js',
];
const publishedManifestRequirements = [
  {
    packageName: '@blade-ai/ai',
    manifestPath: 'node_modules/@blade-ai/ai/package.json',
    description: 'Provider-agnostic AI model interfaces for Blade Agent',
    maxInstalledBytes: 256 * 1024,
    ...expectedPublishedPackageMetadata,
    repository: {
      ...expectedPublishedPackageMetadata.repository,
      directory: 'packages/ai',
    },
  },
  {
    packageName: '@blade-ai/agent',
    manifestPath: 'node_modules/@blade-ai/agent/package.json',
    description: 'Runtime-independent Blade Agent kernel contracts',
    maxInstalledBytes: 128 * 1024,
    ...expectedPublishedPackageMetadata,
    repository: {
      ...expectedPublishedPackageMetadata.repository,
      directory: 'packages/agent',
    },
  },
  {
    packageName: '@blade-ai/agent-sdk',
    manifestPath: 'node_modules/@blade-ai/agent-sdk/package.json',
    description: 'Session-first Blade Agent SDK',
    maxInstalledBytes: 1024 * 1024,
    ...expectedPublishedPackageMetadata,
    repository: {
      ...expectedPublishedPackageMetadata.repository,
      directory: 'packages/agent-sdk',
    },
  },
];
const publishedReadmeRequirements = [
  {
    packageName: '@blade-ai/ai',
    readmePath: 'node_modules/@blade-ai/ai/README.md',
    sourceReadmePath: 'packages/ai/README.md',
    installCommand: 'pnpm add @blade-ai/ai',
    importSnippet: "import { createOpenAICompatibleModelPort } from '@blade-ai/ai';",
  },
  {
    packageName: '@blade-ai/agent',
    readmePath: 'node_modules/@blade-ai/agent/README.md',
    sourceReadmePath: 'packages/agent/README.md',
    installCommand: 'pnpm add @blade-ai/agent',
    importSnippet: "import { AgentKernel } from '@blade-ai/agent';",
  },
  {
    packageName: '@blade-ai/agent-sdk',
    readmePath: 'node_modules/@blade-ai/agent-sdk/README.md',
    sourceReadmePath: 'packages/agent-sdk/README.md',
    installCommand: 'pnpm add @blade-ai/agent-sdk',
    importSnippet: "import { createSession } from '@blade-ai/agent-sdk';",
  },
];
const browserDisallowedMarkers = [
  'node:',
  'child_process',
  'undici',
  '@modelcontextprotocol',
  'node-pty',
];
const forbiddenPackageLifecycleScripts = new Set([
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepublish',
  'prepublishOnly',
]);
const requiredPackageKeywords = ['agent', 'sdk', 'llm'];
const mitPermissionGrant = 'Permission is hereby granted, free of charge';
const publishedLicenseRequirements = [
  {
    packageName: '@blade-ai/ai',
    licensePath: 'node_modules/@blade-ai/ai/LICENSE',
  },
  {
    packageName: '@blade-ai/agent',
    licensePath: 'node_modules/@blade-ai/agent/LICENSE',
  },
  {
    packageName: '@blade-ai/agent-sdk',
    licensePath: 'node_modules/@blade-ai/agent-sdk/LICENSE',
  },
];

function parseArgs(argv) {
  const options = {
    repo: defaultRepo,
    timeoutMs: 300000,
    intervalMs: 10000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === '--version') {
      options.version = value;
      index += 1;
    } else if (arg === '--repo') {
      options.repo = value;
      index += 1;
    } else if (arg === '--timeout-ms') {
      options.timeoutMs = Number(value);
      index += 1;
    } else if (arg === '--interval-ms') {
      options.intervalMs = Number(value);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function usage() {
  return [
    'Usage: pnpm run verify:published -- --version <version>',
    '',
    'Options:',
    '  --version <version>     Published version to verify, with or without a leading v.',
    `  --repo <owner/name>     GitHub repository. Defaults to ${defaultRepo}.`,
    '  --timeout-ms <ms>      Total polling time. Defaults to 300000.',
    '  --interval-ms <ms>     Polling interval. Defaults to 10000.',
  ].join('\n');
}

function normalizeVersion(version) {
  if (!version) {
    throw new Error('Missing required --version argument');
  }
  return version.startsWith('v') ? version.slice(1) : version;
}

async function run(command, args, options = {}) {
  const { stdout } = await execFileAsync(command, args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    ...options,
  });
  return stdout.trim();
}

async function verifyGithubRelease({ repo, version }) {
  const tag = `v${version}`;
  const stdout = await run('gh', [
    'release',
    'view',
    tag,
    '--repo',
    repo,
    '--json',
    'tagName,url',
  ]);
  const release = JSON.parse(stdout);

  if (release.tagName !== tag) {
    throw new Error(`GitHub Release tag mismatch: expected ${tag}, got ${release.tagName}`);
  }
  return release.url;
}

async function verifyNpmPackage({ packageName, version }) {
  const stdout = await run('npm', [
    'view',
    `${packageName}@${version}`,
    'version',
    'dist',
    '--json',
  ]);
  const metadata = JSON.parse(stdout);
  const publishedVersion = metadata.version;

  if (publishedVersion !== version) {
    throw new Error(`${packageName} version mismatch: expected ${version}, got ${publishedVersion}`);
  }
  return metadata;
}

async function verifyNpmLatestDistTag({ packageName, version }) {
  const stdout = await run('npm', [
    'view',
    packageName,
    'dist-tags',
    '--json',
  ]);
  const distTags = JSON.parse(stdout);

  if (distTags.latest !== version) {
    throw new Error(`${packageName} npm latest dist-tag mismatch: expected ${version}, got ${distTags.latest}`);
  }
}

function verifyNpmPackageTarballIntegrity({ packageName, version, metadata }) {
  if (!metadata.dist || typeof metadata.dist !== 'object') {
    throw new Error(`${packageName}@${version} missing npm dist metadata`);
  }

  const tarball = metadata.dist.tarball;
  const integrity = metadata.dist.integrity;
  const shasum = metadata.dist.shasum;

  if (typeof tarball !== 'string' || tarball.length === 0) {
    throw new Error(`${packageName}@${version} missing registry tarball URL`);
  }
  if (typeof integrity !== 'string' || integrity.length === 0) {
    throw new Error(`${packageName}@${version} missing registry tarball integrity`);
  }
  if (typeof shasum !== 'string' || shasum.length === 0) {
    throw new Error(`${packageName}@${version} missing registry tarball shasum`);
  }
  if (ssri.parse(integrity).toString().length === 0) {
    throw new Error(`${packageName}@${version} registry tarball integrity is not valid SRI`);
  }
}

function verifyNpmPackageProvenance({ packageName, version, metadata }) {
  const expectedPredicateType = 'https://slsa.dev/provenance/v1';
  const provenancePredicateType = metadata?.dist?.attestations?.provenance?.predicateType;

  if (provenancePredicateType !== expectedPredicateType) {
    throw new Error([
      `${packageName}@${version} missing npm provenance attestation`,
      `expected dist.attestations.provenance.predicateType to be ${expectedPredicateType}`,
    ].join(': '));
  }
}

async function verifyPublishedOnce({ repo, version }) {
  const releaseUrl = await verifyGithubRelease({ repo, version });
  const packageMetadataByName = new Map();

  for (const packageName of publishablePackages) {
    await verifyNpmLatestDistTag({ packageName, version });
    const metadata = await verifyNpmPackage({ packageName, version });
    verifyNpmPackageTarballIntegrity({ packageName, version, metadata });
    verifyNpmPackageProvenance({ packageName, version, metadata });
    packageMetadataByName.set(packageName, metadata);
  }
  await verifyPublishedInstallSmoke({ version, packageMetadataByName });

  return releaseUrl;
}

async function verifyPublishedInstallSmoke({ version, packageMetadataByName }) {
  const consumerDir = await mkdtemp(join(tmpdir(), 'blade-published-consumer-'));
  const packageSpecs = [
    `@blade-ai/ai@${version}`,
    `@blade-ai/agent@${version}`,
    `@blade-ai/agent-sdk@${version}`,
    'typescript@6.0.3',
    'esbuild@0.28.1',
  ];
  const npmInstallCommandLabel = `npm install ${packageSpecs.join(' ')}`;

  try {
    await writeFile(
      join(consumerDir, 'package.json'),
      JSON.stringify({
        private: true,
        type: 'module',
      }, null, 2),
    );
    await run('npm', [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      ...packageSpecs,
    ], { cwd: consumerDir });

    await verifyPublishedPackageLockfileTarballs({ consumerDir, packageMetadataByName });
    await verifyPublishedPackageManifests({ consumerDir, version });
    await verifyPublishedPackageFileScope({ consumerDir });
    await verifyPublishedLicenseArtifacts({ consumerDir });
    await verifyPublishedReadmes({ consumerDir });

    const runtimeSmokePath = join(consumerDir, 'consumer-runtime.mjs');
    await writeFile(
      runtimeSmokePath,
      `import aiPackage from '@blade-ai/ai/package.json' with { type: 'json' };
import agentPackage from '@blade-ai/agent/package.json' with { type: 'json' };
import agentSdkPackage from '@blade-ai/agent-sdk/package.json' with { type: 'json' };
import * as ai from '@blade-ai/ai';
import * as aiChat from '@blade-ai/ai/chat';
import * as aiDeepseek from '@blade-ai/ai/deepseek';
import * as aiModel from '@blade-ai/ai/model';
import * as aiOpenAICompatible from '@blade-ai/ai/providers/openai-compatible';
import * as aiVercel from '@blade-ai/ai/providers/vercel';
import * as aiRetry from '@blade-ai/ai/retry';
import * as agent from '@blade-ai/agent';
import * as agentBudget from '@blade-ai/agent/budget';
import * as agentEpoch from '@blade-ai/agent/epoch';
import * as agentKernel from '@blade-ai/agent/kernel';
import * as agentLoop from '@blade-ai/agent/loop';
import * as agentPorts from '@blade-ai/agent/ports';
import * as agentProtocol from '@blade-ai/agent/protocol';
import * as agentRecovery from '@blade-ai/agent/recovery';
import * as agentState from '@blade-ai/agent/state';
import * as agentTracing from '@blade-ai/agent/tracing';
import * as agentSdk from '@blade-ai/agent-sdk';
import * as agentSdkBrowser from '@blade-ai/agent-sdk/browser';
import * as agentSdkCore from '@blade-ai/agent-sdk/core';
import * as agentSdkLocal from '@blade-ai/agent-sdk/local';
import * as agentSdkServer from '@blade-ai/agent-sdk/server';
import * as agentSdkSession from '@blade-ai/agent-sdk/session';
import * as agentSdkTools from '@blade-ai/agent-sdk/tools';

function assertRuntimeExport(module, name) {
  if (!(name in module)) {
    throw new Error(\`Missing runtime export \${name}\`);
  }
}

function assertNoRuntimeExport(module, name) {
  if (name in module) {
    throw new Error(\`Unexpected runtime export \${name}\`);
  }
}

function assertPackageName(manifest, name) {
  if (manifest.name !== name) {
    throw new Error(\`Expected package metadata for \${name}, received \${manifest.name}\`);
  }
}

function assertRuntimeExportParity(leftModule, rightModule, leftName, rightName) {
  const leftKeys = Object.keys(leftModule).sort();
  const rightKeys = Object.keys(rightModule).sort();
  const missingFromRight = leftKeys.filter((key) => !rightKeys.includes(key));
  const extraInRight = rightKeys.filter((key) => !leftKeys.includes(key));

  if (missingFromRight.length > 0 || extraInRight.length > 0) {
    throw new Error([
      \`Runtime export mismatch between \${leftName} and \${rightName}\`,
      missingFromRight.length > 0 ? \`missing from \${rightName}: \${missingFromRight.join(', ')}\` : undefined,
      extraInRight.length > 0 ? \`extra in \${rightName}: \${extraInRight.join(', ')}\` : undefined,
    ].filter(Boolean).join('; '));
  }
}

assertPackageName(aiPackage, '@blade-ai/ai');
assertPackageName(agentPackage, '@blade-ai/agent');
assertPackageName(agentSdkPackage, '@blade-ai/agent-sdk');
assertRuntimeExport(ai, 'createOpenAICompatibleModelPort');
assertRuntimeExport(aiDeepseek, 'normalizeDeepSeekModel');
assertRuntimeExport(aiOpenAICompatible, 'createOpenAICompatibleModelPort');
assertRuntimeExport(aiRetry, 'DEFAULT_RETRY_CONFIG');
assertRuntimeExport(aiRetry, 'withRetry');
assertRuntimeExport(aiVercel, 'createVercelModelPort');
assertRuntimeExport(agent, 'AgentKernel');
assertRuntimeExport(agent, 'ExecutionEpoch');
assertRuntimeExport(agentBudget, 'TokenBudget');
const totalOnlyBudget = new agentBudget.TokenBudget({
  maxTotalTokens: 100,
  warningThresholdPercent: 0.5,
});
totalOnlyBudget.record({ totalTokens: 75 });
if (totalOnlyBudget.getSnapshot().totalTokens !== 75 || !totalOnlyBudget.isWarning()) {
  throw new Error('@blade-ai/agent/budget total-only usage returned an unexpected result');
}
assertRuntimeExport(agentEpoch, 'ExecutionEpoch');
assertRuntimeExport(agentKernel, 'AgentKernel');
assertRuntimeExport(agentLoop, 'AsyncEventQueue');
assertRuntimeExport(agentLoop, 'decideNoToolTurn');
assertRuntimeExport(agentLoop, 'decideTurnLimit');
assertRuntimeExport(agentLoop, 'planToolExecution');
assertRuntimeExport(agentLoop, 'resolveToolInterruptBehavior');
assertRuntimeExport(agentLoop, 'createInterruptAwareAbortSignal');
assertRuntimeExport(agentLoop, 'toolUpdateToAgentEvent');
assertRuntimeExport(agentLoop, 'RETRY_PROMPT');
assertRuntimeExport(agentLoop, 'ToolKind');
assertRuntimeExport(agentRecovery, 'isOverflowRecoverable');
if (!agentRecovery.isOverflowRecoverable(new Error('context_length_exceeded'))) {
  throw new Error('@blade-ai/agent/recovery overflow guard returned an unexpected result');
}
assertRuntimeExport(agentState, 'isValidSystemSource');
assertRuntimeExport(agentState, 'VALID_SYSTEM_SOURCES');
assertRuntimeExport(agentState, 'modelResponseToAssistantMessage');
assertRuntimeExport(agentState, 'toolResultToToolMessage');
if (!agentState.isValidSystemSource('catalog') || agentState.isValidSystemSource('unknown')) {
  throw new Error('@blade-ai/agent/state system source guard returned an unexpected result');
}
if (agentState.modelResponseToAssistantMessage({ content: 'ok' }).role !== 'assistant') {
  throw new Error('@blade-ai/agent/state assistant message projection returned an unexpected result');
}
if (agentState.toolResultToToolMessage(
  { id: 'call_read', name: 'Read', output: { ok: true } },
  { id: 'fallback', name: 'Fallback' },
).toolCallId !== 'call_read') {
  throw new Error('@blade-ai/agent/state tool message projection returned an unexpected result');
}
assertRuntimeExport(agentTracing, 'createBufferedAgentTracePort');
const agentTrace = agentTracing.createBufferedAgentTracePort({ maxEvents: 1 });
agentTrace.record({ type: 'turn_start', input: 'published trace smoke' });
agentTrace.record({ type: 'turn_end', content: 'ok', finishReason: 'stop' });
if (agentTrace.getEvents().length !== 1 || agentTrace.getEvents()[0]?.type !== 'turn_end') {
  throw new Error('@blade-ai/agent/tracing buffered trace port returned an unexpected result');
}
assertRuntimeExport(agentSdk, 'createSession');
assertRuntimeExport(agentSdk, 'defineTool');
assertNoRuntimeExport(agentSdk, 'getBuiltinTools');
assertNoRuntimeExport(agentSdk, 'createSdkMcpServer');
assertNoRuntimeExport(agentSdk, 'FileSystemMemoryStore');
assertNoRuntimeExport(agentSdk, 'SandboxExecutor');
assertNoRuntimeExport(agentSdk, 'normalizeDeepSeekModel');
assertNoRuntimeExport(agentSdk, 'calculateDeepSeekCost');
assertNoRuntimeExport(agentSdk, 'DeepSeekCostTracker');
assertNoRuntimeExport(agentSdk, 'DEEPSEEK_DEFAULT_MODEL');
assertRuntimeExport(agentSdkBrowser, 'PermissionMode');
assertRuntimeExport(agentSdkCore, 'PermissionMode');
assertRuntimeExport(agentSdkLocal, 'getBuiltinTools');
assertRuntimeExport(agentSdkServer, 'createSession');
assertRuntimeExport(agentSdkServer, 'subagentRegistry');
assertRuntimeExportParity(agentSdk, agentSdkServer, 'root', 'server');
assertRuntimeExport(agentSdkSession, 'createSession');
assertRuntimeExport(agentSdkTools, 'ToolKind');

if (Object.keys(aiChat).length !== 0) {
  throw new Error('@blade-ai/ai/chat should remain type-only at runtime');
}
if (Object.keys(aiModel).length !== 0) {
  throw new Error('@blade-ai/ai/model should remain type-only at runtime');
}
if (Object.keys(agentProtocol).length !== 0) {
  throw new Error('@blade-ai/agent/protocol should remain type-only at runtime');
}
if (Object.keys(agentPorts).length !== 0) {
  throw new Error('@blade-ai/agent/ports should remain type-only at runtime');
}
`,
    );
    await run(process.execPath, [runtimeSmokePath], { cwd: consumerDir });
    await verifyPublishedTypesSmoke({ consumerDir });
    await verifyPublishedRootDeclarationBoundary({ consumerDir });
    await verifyPublishedRootSubagentCompatibilityBoundary({ consumerDir });
    await verifyPublishedServerEntryBoundary({ consumerDir });
    await verifyPublishedServerDeclarationParity({ consumerDir });
    await verifyPublishedCoreDeclarationBoundary({ consumerDir });
    await verifyPublishedSessionPublicDeclarationBoundary({ consumerDir });
    await verifyPublishedSessionEntrySessionBoundary({ consumerDir });
    await verifyPublishedNoEagerLegacySessionRuntime({ consumerDir });
    await verifyPublishedSessionFactoryDeclarationBoundary({ consumerDir });
    await verifyPublishedSessionConfigDeclarationBoundary({ consumerDir });
    await verifyPublishedSessionStoreDeclarationBoundary({ consumerDir });
    await verifyPublishedToolsEntryBoundary({ consumerDir });
    await verifyPublishedLocalAdapterBoundary({ consumerDir });
    await verifyPublishedPermissionDeclarationBoundary({ consumerDir });
    await verifyPublishedSdkBrowserSafeStaticClosures({ consumerDir });
    await verifyPublishedBrowserBundleSmoke({ consumerDir });
    await verifyPublishedAgentBrowserBundleSmoke({ consumerDir });
    console.log(`[verify-published] temporary consumer smoke passed: ${npmInstallCommandLabel}`);
  } finally {
    await rm(consumerDir, { recursive: true, force: true });
  }
}

async function verifyPublishedPackageLockfileTarballs({ consumerDir, packageMetadataByName }) {
  const lockfile = JSON.parse(await readFile(join(consumerDir, 'package-lock.json'), 'utf8'));

  for (const packageName of publishablePackages) {
    const lockfileEntry = lockfile.packages?.[`node_modules/${packageName}`];
    const metadata = packageMetadataByName.get(packageName);

    if (!lockfileEntry) {
      throw new Error(`${packageName} missing from published temporary consumer package-lock.json`);
    }
    if (!metadata) {
      throw new Error(`${packageName} missing registry metadata for package-lock verification`);
    }
    if (lockfileEntry.resolved !== metadata.dist.tarball) {
      throw new Error(
        `${packageName} package-lock resolved tarball mismatch: expected ${metadata.dist.tarball}, got ${lockfileEntry.resolved}`,
      );
    }

    const installedIntegrity = ssri.parse(lockfileEntry.integrity).toString();
    const registryIntegrity = ssri.parse(metadata.dist.integrity).toString();
    if (installedIntegrity !== registryIntegrity) {
      throw new Error(
        `${packageName} package-lock integrity mismatch: expected ${registryIntegrity}, got ${installedIntegrity}`,
      );
    }
  }
  console.log('[verify-published] temporary consumer package-lock tarball integrity passed');
}

function collectDeclarationExports(source) {
  const strippedSource = source
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/\/\/.*$/gm, '');
  const exportNames = new Set();
  const namedExportPattern = /\bexport\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+["'][^"']+["']/g;

  for (const match of strippedSource.matchAll(namedExportPattern)) {
    for (const rawSpecifier of match[1].split(',')) {
      const specifier = rawSpecifier.trim();
      if (!specifier) continue;
      const withoutTypeModifier = specifier.replace(/^type\s+/, '').trim();
      const aliased = withoutTypeModifier.match(/\bas\s+([A-Za-z_$][\w$]*)$/);
      const exportedName = aliased?.[1] ?? withoutTypeModifier.match(/^([A-Za-z_$][\w$]*)/)?.[1];
      if (exportedName) {
        exportNames.add(exportedName);
      }
    }
  }

  return [...exportNames].sort();
}

function assertDeclarationExportParity(leftSource, rightSource, leftName, rightName) {
  const leftExports = collectDeclarationExports(leftSource);
  const rightExports = collectDeclarationExports(rightSource);
  const missingFromRight = leftExports.filter((name) => !rightExports.includes(name));
  const extraInRight = rightExports.filter((name) => !leftExports.includes(name));

  if (missingFromRight.length > 0 || extraInRight.length > 0) {
    throw new Error([
      `Declaration export mismatch between ${leftName} and ${rightName}`,
      missingFromRight.length > 0 ? `missing from ${rightName}: ${missingFromRight.join(', ')}` : undefined,
      extraInRight.length > 0 ? `extra in ${rightName}: ${extraInRight.join(', ')}` : undefined,
    ].filter(Boolean).join('; '));
  }
}

async function verifyPublishedServerDeclarationParity({ consumerDir }) {
  const rootDeclaration = await readFile(
    join(consumerDir, 'node_modules/@blade-ai/agent-sdk/dist/index.d.ts'),
    'utf8',
  );
  const serverDeclaration = await readFile(
    join(consumerDir, 'node_modules/@blade-ai/agent-sdk/dist/server/index.d.ts'),
    'utf8',
  );

  assertDeclarationExportParity(rootDeclaration, serverDeclaration, 'root', 'server');
}

async function verifyPublishedPackageManifests({ consumerDir, version }) {
  for (const requirement of publishedManifestRequirements) {
    const packageDir = join(consumerDir, dirname(requirement.manifestPath));
    const installedFiles = await listInstalledPackageFiles(packageDir);
    const manifest = JSON.parse(
      await readFile(join(consumerDir, requirement.manifestPath), 'utf8'),
    );
    const serializedManifest = JSON.stringify(manifest);

    if (manifest.name !== requirement.packageName) {
      throw new Error(`${requirement.packageName} installed manifest name mismatch: ${manifest.name}`);
    }
    if (manifest.version !== version) {
      throw new Error(
        `${requirement.packageName} installed manifest version mismatch: expected ${version}, got ${manifest.version}`,
      );
    }
    if ('private' in manifest) {
      throw new Error(`${requirement.packageName} installed manifest must not contain private metadata`);
    }
    if ('devDependencies' in manifest) {
      throw new Error(`${requirement.packageName} installed manifest must not contain devDependencies`);
    }
    assertNoPackageLifecycleScripts(requirement.packageName, manifest, 'installed manifest');
    if (serializedManifest.includes('workspace:')) {
      throw new Error(`${requirement.packageName} installed manifest must not contain workspace: dependencies`);
    }
    if (serializedManifest.includes('0.0.0')) {
      throw new Error(`${requirement.packageName} installed manifest must not contain 0.0.0 placeholder versions`);
    }
    verifyPublishedManifestDependencyVersions(requirement.packageName, manifest, version);
    verifyPublishedPackageMetadata(requirement, manifest);
    assertNoCliProductManifest(requirement.packageName, manifest);
    assertPublishedManifestTarget({
      packageName: requirement.packageName,
      label: 'main',
      target: manifest.main,
    });
    assertManifestTargetExtension({
      packageName: requirement.packageName,
      label: 'main',
      condition: 'import',
      target: manifest.main,
    });
    assertPublishedManifestTargetExists({
      packageName: requirement.packageName,
      label: 'main',
      target: manifest.main,
      installedFiles,
    });
    assertPublishedManifestTarget({
      packageName: requirement.packageName,
      label: 'types',
      target: manifest.types,
    });
    assertManifestTargetExtension({
      packageName: requirement.packageName,
      label: 'types',
      condition: 'types',
      target: manifest.types,
    });
    assertPublishedManifestTargetExists({
      packageName: requirement.packageName,
      label: 'types',
      target: manifest.types,
      installedFiles,
    });
    verifyPublishedManifestExports({
      packageName: requirement.packageName,
      manifest,
      installedFiles,
    });
    verifyPublishedSdkBrowserExportConditions(requirement.packageName, manifest);
    await verifyPublishedRuntimeExternalDependencies({
      packageName: requirement.packageName,
      packageDir,
      manifest,
    });
    await verifyPublishedRuntimeRelativeImports({
      packageName: requirement.packageName,
      packageDir,
    });
    await verifyPublishedDeclarationRelativeReferences({
      packageName: requirement.packageName,
      packageDir,
    });
    await verifyPublishedDeclarationExternalDependencies({
      packageName: requirement.packageName,
      packageDir,
      manifest,
    });

  }
  console.log('[verify-published] temporary consumer published package manifests passed');
}

async function verifyPublishedRuntimeExternalDependencies({ packageName, packageDir, manifest }) {
  const declaredDependencies = getDeclaredRuntimeDependencies(manifest);

  for (const dependencyName of await collectRuntimeExternalImports(packageDir)) {
    if (dependencyName === manifest.name || declaredDependencies.has(dependencyName)) {
      continue;
    }
    throw new Error(
      `${packageName} installed runtime import is not declared in package dependencies: ${dependencyName}`,
    );
  }
}

async function verifyPublishedRuntimeRelativeImports({ packageName, packageDir }) {
  for (const filePath of await listRuntimeJavaScriptFiles(packageDir)) {
    const source = await readFile(filePath, 'utf8');
    for (const specifier of collectImportSpecifiers(source)) {
      if (!specifier.startsWith('.')) continue;
      const resolvedImport = await resolveRuntimeRelativeImport(filePath, specifier);
      if (!resolvedImport) {
        throw new Error(
          `${packageName} installed runtime relative import does not resolve: ${relativePackagePath(packageDir, filePath)} -> ${specifier}`,
        );
      }
      if (!isInsideDirectory(resolvedImport, packageDir)) {
        throw new Error(
          `${packageName} installed runtime relative import escapes the package: ${relativePackagePath(packageDir, filePath)} -> ${specifier}`,
        );
      }
    }
  }
}

async function verifyPublishedDeclarationRelativeReferences({ packageName, packageDir }) {
  for (const filePath of await listDeclarationFiles(packageDir)) {
    const source = await readFile(filePath, 'utf8');
    for (const specifier of collectDeclarationRelativeSpecifiers(source)) {
      const resolvedReference = await resolveDeclarationRelativeReference(filePath, specifier);
      if (!resolvedReference) {
        throw new Error(
          `${packageName} installed declaration relative reference does not resolve: ${relativePackagePath(packageDir, filePath)} -> ${specifier}`,
        );
      }
      if (!isInsideDirectory(resolvedReference, packageDir)) {
        throw new Error(
          `${packageName} installed declaration relative reference escapes the package: ${relativePackagePath(packageDir, filePath)} -> ${specifier}`,
        );
      }
    }
  }
}

async function verifyPublishedDeclarationExternalDependencies({ packageName, packageDir, manifest }) {
  const declaredDependencies = getDeclaredRuntimeDependencies(manifest);

  for (const dependencyName of await collectDeclarationExternalReferences(packageDir)) {
    if (dependencyName === manifest.name || isDeclaredDeclarationDependency(dependencyName, declaredDependencies)) {
      continue;
    }
    throw new Error(
      `${packageName} installed declaration reference is not declared in package dependencies: ${dependencyName}`,
    );
  }
}

function verifyPublishedManifestDependencyVersions(packageName, manifest, version) {
  for (const section of dependencySections) {
    for (const [dependencyName, dependencyVersion] of Object.entries(manifest[section] ?? {})) {
      const installedVersion = String(dependencyVersion);
      if (publishablePackages.includes(dependencyName)) {
        if (installedVersion !== version) {
          throw new Error(
            `${packageName} internal dependency ${dependencyName} must match published version ${version}, got ${installedVersion}`,
          );
        }
        continue;
      }
      if (!isExactDependencyVersion(installedVersion)) {
        throw new Error(
          `${packageName} installed manifest dependency ${section}.${dependencyName} must use an exact dependency version, got ${installedVersion}`,
        );
      }
    }
  }
}

function getDeclaredRuntimeDependencies(manifest) {
  return new Set(
    dependencySections.flatMap((section) => Object.keys(manifest[section] ?? {})),
  );
}

async function collectRuntimeExternalImports(packageDir) {
  const dependencies = new Set();

  for (const filePath of await listRuntimeJavaScriptFiles(packageDir)) {
    const source = await readFile(filePath, 'utf8');
    for (const specifier of collectImportSpecifiers(source)) {
      const dependencyName = getExternalPackageName(specifier);
      if (dependencyName) {
        dependencies.add(dependencyName);
      }
    }
  }

  return dependencies;
}

async function collectDeclarationExternalReferences(packageDir) {
  const dependencies = new Set();

  for (const filePath of await listDeclarationFiles(packageDir)) {
    const source = await readFile(filePath, 'utf8');
    for (const specifier of collectDeclarationSpecifiers(source)) {
      const dependencyName = getExternalPackageName(specifier);
      if (dependencyName) {
        dependencies.add(dependencyName);
      }
    }
  }

  return dependencies;
}

function isDeclaredDeclarationDependency(dependencyName, declaredDependencies) {
  return declarationDependencyCandidateNames(dependencyName).some((candidateName) =>
    declaredDependencies.has(candidateName),
  );
}

function declarationDependencyCandidateNames(dependencyName) {
  if (dependencyName.startsWith('@')) {
    const [scope, name] = dependencyName.slice(1).split('/');
    return [dependencyName, `@types/${scope}__${name}`];
  }
  return [dependencyName, `@types/${dependencyName}`];
}

async function listRuntimeJavaScriptFiles(packageDir) {
  return (await run('find', [join(packageDir, 'dist'), '-type', 'f', '-name', '*.js']))
    .split('\n')
    .filter(Boolean);
}

async function listDeclarationFiles(packageDir) {
  return (await run('find', [join(packageDir, 'dist'), '-type', 'f', '-name', '*.d.ts']))
    .split('\n')
    .filter(Boolean);
}

function collectImportSpecifiers(source) {
  const specifiers = new Set();
  const patterns = [
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*(?:[\w*{}\s,]+from\s*)["']([^"']+)["']/g,
    /\bexport\s*(?:[\w*{}\s,]+from\s*|\*\s+from\s*)["']([^"']+)["']/g,
    /\bexport\s+\*\s+as\s+\w+\s+from\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.add(match[1]);
    }
  }

  return specifiers;
}

function collectDeclarationRelativeSpecifiers(source) {
  const specifiers = collectDeclarationSpecifiers(source);

  return [...specifiers].filter((specifier) => specifier.startsWith('.'));
}

function collectDeclarationSpecifiers(source) {
  const specifiers = collectImportSpecifiers(source);
  const referencePathPattern = /\/\/\/\s*<reference\s+path=["']([^"']+)["']\s*\/>/g;
  const referenceTypesPattern = /\/\/\/\s*<reference\s+types=["']([^"']+)["']\s*\/>/g;

  for (const match of source.matchAll(referencePathPattern)) {
    specifiers.add(match[1]);
  }
  for (const match of source.matchAll(referenceTypesPattern)) {
    specifiers.add(match[1]);
  }

  return specifiers;
}

function getExternalPackageName(specifier) {
  if (
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('data:') ||
    specifier.startsWith('file:')
  ) {
    return null;
  }

  const normalizedSpecifier = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
  if (specifier.startsWith('node:') || nodeBuiltinModules.has(normalizedSpecifier)) {
    return null;
  }

  if (normalizedSpecifier.startsWith('@')) {
    return normalizedSpecifier.split('/').slice(0, 2).join('/');
  }
  return normalizedSpecifier.split('/')[0];
}

async function resolveRuntimeRelativeImport(fromFile, specifier) {
  const candidate = resolve(dirname(fromFile), specifier);
  const candidates = [
    candidate,
    `${candidate}.js`,
    join(candidate, 'index.js'),
  ];

  for (const filePath of candidates) {
    if (!filePath.endsWith('.js')) continue;
    try {
      const fileStat = await stat(filePath);
      if (fileStat.isFile()) return filePath;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

async function resolveDeclarationRelativeReference(fromFile, specifier) {
  const candidate = resolve(dirname(fromFile), specifier);
  const candidates = [
    candidate.endsWith('.js') ? `${candidate.slice(0, -3)}.d.ts` : candidate,
    candidate.endsWith('.d.ts') ? candidate : `${candidate}.d.ts`,
    join(candidate, 'index.d.ts'),
  ];

  for (const filePath of candidates) {
    if (!filePath.endsWith('.d.ts')) continue;
    try {
      const fileStat = await stat(filePath);
      if (fileStat.isFile()) return filePath;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function relativePackagePath(packageDir, filePath) {
  return filePath.slice(`${packageDir}/`.length);
}

function isInsideDirectory(filePath, directory) {
  const resolvedFilePath = resolve(filePath);
  const resolvedDirectory = resolve(directory);
  return resolvedFilePath === resolvedDirectory || resolvedFilePath.startsWith(`${resolvedDirectory}/`);
}

function assertNoPackageLifecycleScripts(packageName, manifest, label) {
  for (const scriptName of Object.keys(manifest.scripts ?? {})) {
    if (forbiddenPackageLifecycleScripts.has(scriptName)) {
      throw new Error(`${packageName} ${label} must not define npm lifecycle script "${scriptName}"`);
    }
  }
}

function verifyPublishedPackageMetadata(requirement, manifest) {
  const metadataRules = [
    {
      field: 'description',
      expected: requirement.description,
      message: 'installed manifest description mismatch',
    },
    {
      field: 'author',
      expected: requirement.author,
      message: 'installed manifest author mismatch',
    },
    {
      field: 'type',
      expected: requirement.type,
      message: 'installed manifest type module mismatch',
    },
    {
      field: 'sideEffects',
      expected: requirement.sideEffects,
      message: 'installed manifest sideEffects mismatch',
    },
    {
      field: 'license',
      expected: requirement.license,
      message: 'installed manifest license mismatch',
    },
    {
      field: 'engines',
      expected: requirement.engines,
      message: 'installed manifest node engine mismatch',
    },
    {
      field: 'homepage',
      expected: requirement.homepage,
      message: 'installed manifest homepage mismatch',
    },
    {
      field: 'bugs',
      expected: requirement.bugs,
      message: 'installed manifest bugs mismatch',
    },
    {
      field: 'repository',
      expected: requirement.repository,
      message: 'installed manifest repository mismatch',
    },
  ];

  for (const rule of metadataRules) {
    const actual = manifest[rule.field];
    if (JSON.stringify(actual) !== JSON.stringify(rule.expected)) {
      throw new Error(
        `${requirement.packageName} ${rule.message}: expected ${JSON.stringify(rule.expected)}, got ${JSON.stringify(actual)}`,
      );
    }
  }

  for (const keyword of requiredPackageKeywords) {
    if (!manifest.keywords?.includes(keyword)) {
      throw new Error(`${requirement.packageName} installed manifest keywords must include ${keyword}`);
    }
  }
}

function assertNoCliProductManifest(packageName, manifest) {
  if (manifest.bin !== undefined) {
    throw new Error(`${packageName} manifest must not publish a bin field; CLI product capabilities belong in a separate package`);
  }
  if (manifest.exports && typeof manifest.exports === 'object' && './cli' in manifest.exports) {
    throw new Error(`${packageName} manifest must not publish a ./cli export; CLI product capabilities belong in a separate package`);
  }
  if (Array.isArray(manifest.keywords) && manifest.keywords.includes('cli')) {
    throw new Error(`${packageName} manifest must not publish CLI product keyword "cli"; CLI product capabilities belong in a separate package`);
  }
}

async function verifyPublishedPackageFileScope({ consumerDir }) {
  for (const requirement of publishedManifestRequirements) {
    const packageDir = join(consumerDir, dirname(requirement.manifestPath));
    const installedBytes = await calculateDirectorySizeBytes(packageDir);
    if (installedBytes > requirement.maxInstalledBytes) {
      throw new Error(
        `${requirement.packageName} installed package exceeds size budget: ${installedBytes} bytes > ${requirement.maxInstalledBytes} bytes`,
      );
    }

    const files = (await run('find', [packageDir, '-type', 'f']))
      .split('\n')
      .filter(Boolean)
      .map((filePath) => relative(packageDir, filePath))
      .map((filePath) => filePath.replaceAll('\\', '/'));

    const declarationMapEntry = files.find((filePath) => filePath.endsWith('.d.ts.map'));
    if (declarationMapEntry) {
      throw new Error(
        `${requirement.packageName} installed package includes a declaration map: ${declarationMapEntry}`,
      );
    }

    const sourceMapEntry = files.find((filePath) => filePath.endsWith('.js.map'));
    if (sourceMapEntry) {
      throw new Error(
        `${requirement.packageName} installed package includes a JavaScript source map: ${sourceMapEntry}`,
      );
    }

    const testEntry = files.find((filePath) =>
      filePath.includes('/__tests__/') || /\.(test|spec)\.[cm]?[jt]s$/.test(filePath)
    );
    if (testEntry) {
      throw new Error(`${requirement.packageName} installed package includes a test file: ${testEntry}`);
    }

    const sourceEntry = files.find((filePath) => filePath.includes('/src/') || filePath.startsWith('src/'));
    if (sourceEntry) {
      throw new Error(`${requirement.packageName} installed package includes source files: ${sourceEntry}`);
    }

    const typescriptArtifactEntry = files.find(
      (filePath) => isTypeScriptSourceArtifact(filePath) || isTypeScriptBuildConfigArtifact(filePath),
    );
    if (typescriptArtifactEntry) {
      throw new Error(
        `${requirement.packageName} installed package includes TypeScript source artifacts: ${typescriptArtifactEntry}`,
      );
    }

    for (const filePath of files) {
      assertAllowedPackageArtifact(requirement.packageName, filePath);
    }

    assertNoCliProductFiles(requirement.packageName, files);
  }
  console.log('[verify-published] temporary consumer published package file scope passed');
}

function isTypeScriptSourceArtifact(filePath) {
  return /\.(?:ts|tsx|mts|cts)$/.test(filePath) && !/\.d\.[cm]?ts$/.test(filePath);
}

function isTypeScriptBuildConfigArtifact(filePath) {
  const fileName = filePath.split('/').at(-1) ?? filePath;
  return /^tsconfig(?:\.[^/]+)?\.json$/.test(fileName) || /^tsup\.config\.[cm]?[jt]s$/.test(fileName);
}

function assertAllowedPackageArtifact(packageName, filePath) {
  const alwaysAllowed = new Set(['package.json', 'README.md', 'LICENSE']);
  if (alwaysAllowed.has(filePath) || filePath.startsWith('dist/')) return;
  if (packageName === '@blade-ai/agent-sdk' && filePath.startsWith('vendor/ripgrep/')) return;

  throw new Error(`${packageName} installed package includes an unexpected package artifact: ${filePath}`);
}

async function calculateDirectorySizeBytes(directory) {
  const files = (await run('find', [directory, '-type', 'f']))
    .split('\n')
    .filter(Boolean);
  let totalBytes = 0;

  for (const filePath of files) {
    totalBytes += (await stat(filePath)).size;
  }
  return totalBytes;
}

function assertNoCliProductFiles(packageName, files) {
  const cliFile = files.find((filePath) => filePath.startsWith('dist/cli/'));
  if (cliFile) {
    throw new Error(`${packageName} installed package includes CLI product files: ${cliFile}`);
  }
}

function assertPublishedManifestTarget({ packageName, label, target }) {
  if (typeof target !== 'string') return;
  if (target === './package.json') return;

  if (!target.startsWith('./')) {
    throw new Error(`${packageName} ${label} installed manifest target must stay package-relative: ${target}`);
  }
  if (target.startsWith('../') || target.includes('/../')) {
    throw new Error(`${packageName} ${label} installed manifest target must not escape the package: ${target}`);
  }
  if (target.includes('/src/') || target.startsWith('./src/')) {
    throw new Error(`${packageName} ${label} installed manifest target must not point at source files: ${target}`);
  }
  if (!target.startsWith('./dist/')) {
    throw new Error(`${packageName} ${label} installed manifest target must point at ./dist/: ${target}`);
  }
}

function assertManifestTargetExtension({ packageName, label, condition, target }) {
  if (typeof target !== 'string') return;
  if (target === './package.json') return;

  if (condition === 'types' && !target.endsWith('.d.ts')) {
    throw new Error(`${packageName} ${label} target ${target} must point at a .d.ts declaration artifact`);
  }
  if ((condition === 'import' || condition === 'browser') && !target.endsWith('.js')) {
    throw new Error(`${packageName} ${label} target ${target} must point at a .js runtime artifact`);
  }
}

async function listInstalledPackageFiles(packageDir) {
  const files = (await run('find', [packageDir, '-type', 'f']))
    .split('\n')
    .filter(Boolean)
    .map((filePath) => relative(packageDir, filePath))
    .map((filePath) => filePath.replaceAll('\\', '/'));
  return new Set(files);
}

function assertPublishedManifestTargetExists({ packageName, label, target, installedFiles }) {
  if (typeof target !== 'string') return;
  const normalizedTarget = target.startsWith('./') ? target.slice(2) : target;
  if (!installedFiles.has(normalizedTarget)) {
    throw new Error(`${packageName} ${label} installed manifest target does not exist in the package: ${target}`);
  }
}

function assertManifestExportSubpathShape({ packageName, exportName, label }) {
  const violation = verifyExportSubpathShape({
    prefix: `${packageName} ${label}`,
    subpath: exportName,
  });
  if (violation) {
    throw new Error(violation);
  }
}

function assertManifestTypesConditionFirst({ packageName, exportName, exportValue, label }) {
  if (!isTypesConditionFirst(exportValue)) {
    throw new Error(`${packageName} ${label} export ${exportName} must declare the types condition first`);
  }
}

function assertManifestExportConditionsAllowed({ packageName, exportName, exportValue, label }) {
  for (const condition of Object.keys(exportValue)) {
    if (!allowedPublicExportConditions.has(condition)) {
      throw new Error(`${packageName} ${label} export ${exportName} condition "${condition}" is not allowed`);
    }
  }
}

function assertManifestBrowserConditionBeforeImport({ packageName, exportName, exportValue, label }) {
  if (!isBrowserConditionBeforeImport(exportValue)) {
    throw new Error(`${packageName} ${label} export ${exportName} must declare the browser condition before import`);
  }
}

function verifyPublishedManifestExports({ packageName, manifest, installedFiles }) {
  const exportsMap = manifest.exports;
  const rootExport = getManifestRootExportConditions(exportsMap);
  if (!rootExport) {
    throw new Error(`${packageName} installed manifest exports must declare a root "." condition object`);
  }
  if (typeof manifest.main === 'string' && typeof rootExport.import === 'string' && manifest.main !== rootExport.import) {
    throw new Error(
      `${packageName} main target "${manifest.main}" must match root export import target "${rootExport.import}"`,
    );
  }
  if (typeof manifest.types === 'string' && typeof rootExport.types === 'string' && manifest.types !== rootExport.types) {
    throw new Error(
      `${packageName} types target "${manifest.types}" must match root export types target "${rootExport.types}"`,
    );
  }
  if (!exportsMap || typeof exportsMap !== 'object') return;
  if (!isExactPackageJsonManifestExport('./package.json', exportsMap['./package.json'])) {
    throw new Error(`${packageName} installed manifest metadata export must be exactly {"default":"./package.json"}`);
  }

  for (const [exportName, exportValue] of Object.entries(exportsMap)) {
    assertManifestExportSubpathShape({
      packageName,
      exportName,
      label: 'installed manifest',
    });
    if (isExactPackageJsonManifestExport(exportName, exportValue)) continue;
    if (typeof exportValue === 'string') {
      throw new Error(
        `${packageName} installed manifest export ${exportName} must declare paired types and import conditions`,
      );
    }
    if (!exportValue || typeof exportValue !== 'object' || Array.isArray(exportValue)) {
      throw new Error(
        `${packageName} installed manifest export ${exportName} must declare paired types and import conditions`,
      );
    }
    if (typeof exportValue.types !== 'string' || typeof exportValue.import !== 'string') {
      throw new Error(
        `${packageName} installed manifest export ${exportName} must declare paired types and import conditions`,
      );
    }
    assertManifestTypesConditionFirst({
      packageName,
      exportName,
      exportValue,
      label: 'installed manifest',
    });
    assertManifestExportConditionsAllowed({
      packageName,
      exportName,
      exportValue,
      label: 'installed manifest',
    });
    assertManifestBrowserConditionBeforeImport({
      packageName,
      exportName,
      exportValue,
      label: 'installed manifest',
    });

    for (const [condition, target] of Object.entries(exportValue)) {
      assertPublishedManifestTarget({
        packageName,
        label: `exports.${exportName}.${condition}`,
        target,
      });
      assertManifestTargetExtension({
        packageName,
        label: `exports.${exportName}.${condition}`,
        condition,
        target,
      });
      assertPublishedManifestTargetExists({
        packageName,
        label: `exports.${exportName}.${condition}`,
        target,
        installedFiles,
      });
      continue;
    }
  }
}

function verifyPublishedSdkBrowserExportConditions(packageName, manifest) {
  if (packageName !== '@blade-ai/agent-sdk') return;
  const exportsMap = manifest.exports;
  if (!exportsMap || typeof exportsMap !== 'object') {
    throw new Error('@blade-ai/agent-sdk published SDK export map is missing');
  }

  for (const [exportName, expectedBrowserTarget] of Object.entries(expectedPublishedSdkBrowserExports)) {
    const exportValue = exportsMap[exportName];
    if (!exportValue || typeof exportValue !== 'object') {
      throw new Error(`@blade-ai/agent-sdk published SDK export ${exportName} must be an export condition object`);
    }
    if (exportValue.browser !== expectedBrowserTarget) {
      throw new Error(
        `@blade-ai/agent-sdk published SDK export ${exportName} browser condition mismatch: expected ${expectedBrowserTarget}, got ${exportValue.browser}`,
      );
    }
    if (typeof exportValue.import !== 'string') {
      throw new Error(
        `@blade-ai/agent-sdk published SDK export ${exportName} must keep an import condition alongside the browser condition`,
      );
    }
  }
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function resolvePublishedRelativeImport(fromFile, specifier, packageDir) {
  if (!specifier.startsWith('.')) return null;

  const candidate = resolve(dirname(fromFile), specifier);
  const candidates = [
    candidate,
    `${candidate}.js`,
    join(candidate, 'index.js'),
  ];
  let resolved;
  for (const filePath of candidates) {
    if (await pathExists(filePath)) {
      resolved = filePath;
      break;
    }
  }
  if (!resolved) return null;

  const packageRelativePath = relative(packageDir, resolved);
  if (packageRelativePath.startsWith('..')) {
    throw new Error(`Published import escapes package directory: ${fromFile} -> ${specifier}`);
  }
  return resolved;
}

async function collectPublishedStaticImports(entryFile, packageDir, seen = new Set()) {
  if (seen.has(entryFile)) return seen;
  seen.add(entryFile);

  const source = await readFile(entryFile, 'utf8');
  const staticImportPattern = /\b(?:import|export)\s+(?:[\w*{}\s,]+from\s*)?["']([^"']+)["']/g;
  for (const match of source.matchAll(staticImportPattern)) {
    const child = await resolvePublishedRelativeImport(entryFile, match[1], packageDir);
    if (child) {
      await collectPublishedStaticImports(child, packageDir, seen);
    }
  }
  return seen;
}

async function verifyPublishedSdkBrowserSafeStaticClosures({ consumerDir }) {
  const packageDir = join(consumerDir, 'node_modules/@blade-ai/agent-sdk');

  for (const entry of publishedSdkBrowserSafeEntries) {
    const entryFile = join(consumerDir, entry);
    if (!(await pathExists(entryFile))) {
      throw new Error(`@blade-ai/agent-sdk published SDK browser-safe static import closure entry is missing: ${entry}`);
    }

    for (const filePath of await collectPublishedStaticImports(entryFile, packageDir)) {
      await assertNoBrowserDisallowedMarkers(filePath, 'published SDK browser-safe static import closure');
    }
  }
}

async function verifyPublishedReadmes({ consumerDir }) {
  for (const requirement of publishedReadmeRequirements) {
    const sourceReadme = await readFile(resolve(requirement.sourceReadmePath), 'utf8');
    const readme = await readFile(join(consumerDir, requirement.readmePath), 'utf8');

    if (!readme.includes(requirement.packageName)) {
      throw new Error(`${requirement.packageName} published README must name the package`);
    }
    if (!readme.includes(requirement.installCommand)) {
      throw new Error(`${requirement.packageName} published README must document direct installation`);
    }
    if (!readme.includes(requirement.importSnippet)) {
      throw new Error(`${requirement.packageName} published README must document direct import usage`);
    }
    if (readme !== sourceReadme) {
      throw new Error(`${requirement.packageName} published README must match the package README exactly`);
    }
  }
  console.log('[verify-published] temporary consumer published package READMEs passed');
}

async function verifyPublishedLicenseArtifacts({ consumerDir }) {
  const rootLicense = await readFile(resolve('LICENSE'), 'utf8');
  for (const requirement of publishedLicenseRequirements) {
    const license = await readFile(join(consumerDir, requirement.licensePath), 'utf8');

    if (!license.includes(mitPermissionGrant)) {
      throw new Error(`${requirement.packageName} published LICENSE must include the MIT permission grant`);
    }
    if (license !== rootLicense) {
      throw new Error(`${requirement.packageName} published LICENSE must match the root LICENSE exactly`);
    }
  }
  console.log('[verify-published] temporary consumer published package license artifacts passed');
}

async function verifyPublishedCoreDeclarationBoundary({ consumerDir }) {
  const rules = toInstalledForbiddenFileRules(
    join(consumerDir, 'node_modules/@blade-ai/agent-sdk'),
    agentSdkCoreDeclarationBrowserSafeRules,
  );

  for (const rule of rules) {
    const source = await readFile(rule.path, 'utf8');
    if (source.includes(rule.forbidden)) {
      throw new Error(`${rule.path}: ${rule.message}`);
    }
  }
}

async function verifyPublishedSessionPublicDeclarationBoundary({ consumerDir }) {
  const rules = toInstalledForbiddenFileRules(
    join(consumerDir, 'node_modules/@blade-ai/agent-sdk'),
    agentSdkSessionPublicDeclarationBoundaryRules,
  );

  for (const rule of rules) {
    const source = await readFile(rule.path, 'utf8');
    if (source.includes(rule.forbidden)) {
      throw new Error(`${rule.path}: ${rule.message}`);
    }
  }
}

async function verifyPublishedSessionFactoryDeclarationBoundary({ consumerDir }) {
  const rules = toInstalledForbiddenFileRules(
    join(consumerDir, 'node_modules/@blade-ai/agent-sdk'),
    agentSdkSessionFactoryDeclarationBoundaryRules,
  );

  for (const rule of rules) {
    const source = await readFile(rule.path, 'utf8');
    if (source.includes(rule.forbidden)) {
      throw new Error(`${rule.path}: ${rule.message}`);
    }
  }
}

async function verifyPublishedSessionEntrySessionBoundary({ consumerDir }) {
  const rules = toInstalledForbiddenFileRules(
    join(consumerDir, 'node_modules/@blade-ai/agent-sdk'),
    agentSdkSessionEntrySessionBoundaryRules,
  );

  for (const rule of rules) {
    const source = await readFile(rule.path, 'utf8');
    if (source.includes(rule.forbidden)) {
      throw new Error(`${rule.path}: ${rule.message}`);
    }
  }
}

async function verifyPublishedNoEagerLegacySessionRuntime({ consumerDir }) {
  const packageDir = join(consumerDir, 'node_modules/@blade-ai/agent-sdk');
  const sessionEntry = join(packageDir, 'dist/session/index.js');

  if (!(await pathExists(sessionEntry))) {
    throw new Error('@blade-ai/agent-sdk published session entry is missing: dist/session/index.js');
  }

  for (const filePath of await collectPublishedStaticImports(sessionEntry, packageDir)) {
    const source = await readFile(filePath, 'utf8');
    const relativeFilePath = relative(consumerDir, filePath).replaceAll('\\', '/');
    for (const rule of agentSdkEagerLegacySessionRuntimeClosureRules) {
      if (source.includes(rule.forbidden)) {
        throw new Error(
          `@blade-ai/agent-sdk ${relativeFilePath}: public session entry eagerly includes legacy root session runtime marker ${rule.forbidden}`,
        );
      }
    }
  }
}

async function verifyPublishedSessionConfigDeclarationBoundary({ consumerDir }) {
  const rules = toInstalledForbiddenFileRules(
    join(consumerDir, 'node_modules/@blade-ai/agent-sdk'),
    agentSdkSessionConfigDeclarationBoundaryRules,
  );

  for (const rule of rules) {
    const source = await readFile(rule.path, 'utf8');
    if (source.includes(rule.forbidden)) {
      throw new Error(`${rule.path}: ${rule.message}`);
    }
  }
}

async function verifyPublishedSessionStoreDeclarationBoundary({ consumerDir }) {
  const rules = toInstalledForbiddenFileRules(
    join(consumerDir, 'node_modules/@blade-ai/agent-sdk'),
    agentSdkSessionStoreDeclarationBoundaryRules,
  );

  for (const rule of rules) {
    const source = await readFile(rule.path, 'utf8');
    if (source.includes(rule.forbidden)) {
      throw new Error(`${rule.path}: ${rule.message}`);
    }
  }
}

async function verifyPublishedToolsEntryBoundary({ consumerDir }) {
  const rules = toInstalledForbiddenFileRules(
    join(consumerDir, 'node_modules/@blade-ai/agent-sdk'),
    agentSdkToolsEntryBoundaryRules,
  );

  for (const rule of rules) {
    const source = await readFile(rule.path, 'utf8');
    if (source.includes(rule.forbidden)) {
      throw new Error(`${rule.path}: ${rule.message}`);
    }
  }
}

async function verifyPublishedLocalAdapterBoundary({ consumerDir }) {
  const rules = toInstalledForbiddenFileRules(
    join(consumerDir, 'node_modules/@blade-ai/agent-sdk'),
    agentSdkLocalAdapterBoundaryRules,
  );

  for (const rule of rules) {
    const source = await readFile(rule.path, 'utf8');
    if (source.includes(rule.forbidden)) {
      throw new Error(`${rule.path}: ${rule.message}`);
    }
  }
}

async function verifyPublishedPermissionDeclarationBoundary({ consumerDir }) {
  const rules = toInstalledForbiddenFileRules(
    join(consumerDir, 'node_modules/@blade-ai/agent-sdk'),
    agentSdkPermissionDeclarationBoundaryRules,
  );

  for (const rule of rules) {
    const source = await readFile(rule.path, 'utf8');
    if (source.includes(rule.forbidden)) {
      throw new Error(`${rule.path}: ${rule.message}`);
    }
  }
}

async function verifyPublishedRootSubagentCompatibilityBoundary({ consumerDir }) {
  const rules = toInstalledForbiddenFileRules(
    join(consumerDir, 'node_modules/@blade-ai/agent-sdk'),
    agentSdkRootSubagentCompatibilityBoundaryRules,
  );

  for (const rule of rules) {
    const source = await readFile(rule.path, 'utf8');
    if (source.includes(rule.forbidden)) {
      throw new Error(`${rule.path}: ${rule.message}`);
    }
  }
}

async function verifyPublishedRootDeclarationBoundary({ consumerDir }) {
  const rules = toInstalledForbiddenFileRules(
    join(consumerDir, 'node_modules/@blade-ai/agent-sdk'),
    [
      ...agentSdkRootDeclarationEntryOwnershipRules,
      ...agentSdkRootPublicDeclarationBoundaryRules,
    ].map((rule) => ({
      file: 'dist/index.d.ts',
      forbidden: rule.forbidden,
      message: `published ${rule.message}`,
    })),
  );

  for (const rule of rules) {
    const source = await readFile(rule.path, 'utf8');
    if (source.includes(rule.forbidden)) {
      throw new Error(`${rule.path}: ${rule.message}`);
    }
  }
}

async function verifyPublishedServerEntryBoundary({ consumerDir }) {
  const rules = toInstalledForbiddenFileRules(
    join(consumerDir, 'node_modules/@blade-ai/agent-sdk'),
    agentSdkServerFacadeBoundaryRules,
  );

  for (const rule of rules) {
    const source = await readFile(rule.path, 'utf8');
    if (source.includes(rule.forbidden)) {
      throw new Error(`${rule.file}: ${rule.message}`);
    }
  }
}

async function assertNoBrowserDisallowedMarkers(filePath, context = 'Published browser bundle') {
  const source = await readFile(filePath, 'utf8');
  for (const marker of browserDisallowedMarkers) {
    if (source.includes(marker)) {
      throw new Error(`${context} includes Node-only marker ${marker}: ${filePath}`);
    }
  }
}

async function verifyPublishedBrowserBundleSmoke({ consumerDir }) {
  const entryPath = join(consumerDir, 'consumer-browser-entry.ts');
  const bundlePath = join(consumerDir, 'consumer-browser-bundle.mjs');

  await writeFile(
    entryPath,
    `import * as rootBrowserFacade from '@blade-ai/agent-sdk';
import { createSession as rootCreateSession, PermissionMode } from '@blade-ai/agent-sdk';
import { createSession as browserCreateSession, PermissionMode as BrowserPermissionMode, StreamMessageType as BrowserStreamMessageType } from '@blade-ai/agent-sdk/browser';
import { PermissionMode as CorePermissionMode } from '@blade-ai/agent-sdk/core';
import { createSession as serverCreateSession } from '@blade-ai/agent-sdk/server';
import { resumeSession } from '@blade-ai/agent-sdk/session';
import { createSession as internalCreateSession } from '@blade-ai/agent-sdk/session/internal';
import { getBuiltinTools } from '@blade-ai/agent-sdk/local';
import { defineTool, ToolKind } from '@blade-ai/agent-sdk/tools';

function assertServerOnly(action, expected) {
  try {
    action();
  } catch (error) {
    if (!String(error.message).includes(expected)) {
      throw error;
    }
    console.log(error.message);
    return;
  }
  throw new Error(\`Expected server-only stub for \${expected}\`);
}

const noopTool = defineTool({
  name: 'noop',
  description: 'Browser-safe tool contract smoke',
  parameters: {
    type: 'object',
    properties: {},
  },
  async execute() {
    return 'ok';
  },
});

console.log(PermissionMode.DEFAULT, BrowserPermissionMode.DEFAULT, CorePermissionMode.DEFAULT, BrowserStreamMessageType.CONTENT, ToolKind.READ, noopTool.name);
for (const exportName of ['getBuiltinTools', 'createSdkMcpServer', 'FileSystemMemoryStore', 'MemoryManager', 'createMemoryReadTool', 'createMemoryWriteTool', 'tool']) {
  if (Object.hasOwn(rootBrowserFacade, exportName)) {
    throw new Error(\`Unexpected browser root local-only export \${exportName}\`);
  }
}
console.log('browser root local-only exports absent');
assertServerOnly(() => rootCreateSession({}), 'server-only for createSession');
assertServerOnly(() => browserCreateSession({}), 'server-only for createSession');
console.log('server-only for browser createSession');
assertServerOnly(() => serverCreateSession({}), 'server-only for createSession');
assertServerOnly(() => internalCreateSession({}), 'server-only for createSession');
console.log('server-only for internal createSession');
assertServerOnly(() => resumeSession('session-id'), 'server-only for resumeSession');
assertServerOnly(() => getBuiltinTools(), 'server-only for getBuiltinTools');
`,
  );

  const esbuild = await import(pathToFileURL(join(consumerDir, 'node_modules/esbuild/lib/main.js')).href);
  try {
    await bundleWithEsbuildRetry({
      entryPoints: [entryPath],
      bundle: true,
      platform: 'browser',
      conditions: ['browser'],
      format: 'esm',
      outfile: bundlePath,
      absWorkingDir: consumerDir,
      logLevel: 'silent',
    }, {
      build: esbuild.build,
      resetService: esbuild.stop,
    });
  } finally {
    esbuild.stop();
  }
  await assertNoBrowserDisallowedMarkers(bundlePath);
  const output = await run(process.execPath, [bundlePath], { cwd: consumerDir });
  for (const expected of [
    'server-only for createSession',
    'server-only for browser createSession',
    'server-only for internal createSession',
    'server-only for resumeSession',
    'server-only for getBuiltinTools',
    'browser root local-only exports absent',
  ]) {
    if (!output.includes(expected)) {
      throw new Error(`Published browser bundle smoke missing expected output: ${expected}`);
    }
  }
  console.log('[verify-published] temporary consumer browser bundle smoke passed');
}

async function verifyPublishedAgentBrowserBundleSmoke({ consumerDir }) {
  const entryPath = join(consumerDir, 'consumer-agent-browser-entry.ts');
  const bundlePath = join(consumerDir, 'consumer-agent-browser-bundle.js');

  await writeFile(
    entryPath,
    [
      "import { AgentKernel } from '@blade-ai/agent';",
      "import { TokenBudget } from '@blade-ai/agent/budget';",
      "import { ExecutionEpoch } from '@blade-ai/agent/epoch';",
      "import { AgentKernel as AgentKernelFromSubpath } from '@blade-ai/agent/kernel';",
      "import { AsyncEventQueue, createInterruptAwareAbortSignal, decideNoToolTurn, decideTurnLimit, planToolExecution, resolveToolInterruptBehavior, toolUpdateToAgentEvent, ToolKind } from '@blade-ai/agent/loop';",
      "import { isOverflowRecoverable } from '@blade-ai/agent/recovery';",
      "import { VALID_SYSTEM_SOURCES, isValidSystemSource, modelResponseToAssistantMessage, toolResultToToolMessage } from '@blade-ai/agent/state';",
      "import { createBufferedAgentTracePort } from '@blade-ai/agent/tracing';",
      'const fakeModel = {',
      '  async generate() {',
      "    return { content: 'ok', finishReason: 'stop' };",
      '  },',
      '  async *stream() {',
      "    yield { type: 'done', response: { content: 'ok', finishReason: 'stop' } };",
      '  },',
      '};',
      'const budget = new TokenBudget({ maxTotalTokens: 10 });',
      'const epoch = new ExecutionEpoch();',
      'const kernel = new AgentKernel({ model: fakeModel });',
      'const queue = new AsyncEventQueue();',
      "queue.enqueue('event');",
      'queue.close();',
      'const kernelFromSubpath = new AgentKernelFromSubpath({ model: fakeModel });',
      "const decision = await decideNoToolTurn('All done', [], 1);",
      "const turnLimit = await decideTurnLimit({ maxTurns: 1, turnsCount: 1, contextMessages: [], toolCallsCount: 0, startTime: Date.now(), totalTokens: 0 });",
      "const toolPlan = planToolExecution([{ id: 'read-1', type: 'function', function: { name: 'Read', arguments: '{}' } }], { get: () => ({ kind: ToolKind.ReadOnly }) });",
      "const interruptBehavior = resolveToolInterruptBehavior({ get: () => ({ kind: ToolKind.Execute, interruptBehavior: 'cancel' }) }, 'Bash', {});",
      "const interruptSignal = createInterruptAwareAbortSignal({ interruptBehavior });",
      'interruptSignal.cleanup();',
      "const toolEvent = toolUpdateToAgentEvent({ type: 'tool_ready', toolCall: { id: 'read-1', type: 'function', function: { name: 'Read', arguments: '{}' } } }, { get: () => ({ kind: ToolKind.ReadOnly }) });",
      "const overflow = isOverflowRecoverable(new Error('context_length_exceeded'));",
      "const systemSource = VALID_SYSTEM_SOURCES[0];",
      'const isSystemSource = isValidSystemSource(systemSource);',
      "const assistantMessage = modelResponseToAssistantMessage({ content: 'ok' });",
      "const toolMessage = toolResultToToolMessage({ id: 'call_read', name: 'Read', output: 'ok' }, { id: 'fallback', name: 'Fallback' });",
      'const trace = createBufferedAgentTracePort({ maxEvents: 1 });',
      "trace.record({ type: 'turn_start', input: 'browser trace smoke' });",
      "trace.record({ type: 'turn_end', content: 'ok', finishReason: 'stop' });",
      'const traceEvent = trace.getEvents()[0];',
      "console.log('agent browser bundle', kernel.constructor.name, kernelFromSubpath.constructor.name, budget.constructor.name, epoch.constructor.name, queue.constructor.name, decision.action, turnLimit.action, toolPlan.mode, interruptBehavior, toolEvent?.type, overflow, systemSource, isSystemSource, assistantMessage.role, toolMessage.role, traceEvent?.type);",
    ].join('\n'),
  );

  const esbuild = await import(pathToFileURL(join(consumerDir, 'node_modules/esbuild/lib/main.js')).href);
  try {
    await bundleWithEsbuildRetry({
      entryPoints: [entryPath],
      bundle: true,
      platform: 'browser',
      conditions: ['browser'],
      format: 'esm',
      outfile: bundlePath,
      absWorkingDir: consumerDir,
      logLevel: 'silent',
    }, {
      build: esbuild.build,
      resetService: esbuild.stop,
    });
  } finally {
    esbuild.stop();
  }

  await assertNoBrowserDisallowedMarkers(bundlePath);
  const output = await run(process.execPath, [bundlePath], { cwd: consumerDir });
  if (!output.includes('agent browser bundle')) {
    throw new Error('Published agent browser bundle smoke did not execute');
  }
  if (!output.includes('AgentKernel AgentKernel TokenBudget _ExecutionEpoch AsyncEventQueue')) {
    throw new Error('Published agent browser bundle core runtime smoke did not execute');
  }
  if (!output.includes('finish stop serial cancel tool_start true')) {
    throw new Error('Published agent browser bundle loop/recovery smoke did not execute');
  }
  if (!output.includes('catalog true')) {
    throw new Error('Published agent browser bundle system-source smoke did not execute');
  }
  if (!output.includes('assistant tool')) {
    throw new Error('Published agent browser bundle message projection smoke did not execute');
  }
  if (!output.includes('turn_end')) {
    throw new Error('Published agent browser bundle tracing smoke did not execute');
  }
  console.log('[verify-published] temporary consumer agent browser bundle smoke passed');
}

async function verifyPublishedTypesSmoke({ consumerDir }) {
  await writeFile(
    join(consumerDir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        target: 'ES2022',
        strict: true,
        skipLibCheck: false,
        lib: ['ES2022', 'DOM', 'ESNext.Disposable'],
        noEmit: true,
      },
      include: ['consumer-types.ts'],
    }, null, 2),
  );
  await writeFile(
    join(consumerDir, 'consumer-types.ts'),
    `${createAiPublicTypeImportBlock('publishedConsumer')}
import { DEFAULT_RETRY_CONFIG, isRetryableError, withRetry } from '@blade-ai/ai/retry';
import { calculateDeepSeekCost, normalizeDeepSeekModel } from '@blade-ai/ai/deepseek';
import { createOpenAICompatibleModelPort } from '@blade-ai/ai/providers/openai-compatible';
import { createVercelModelPort } from '@blade-ai/ai/providers/vercel';
import { ExecutionEpoch } from '@blade-ai/agent/epoch';
import type {
  TokenBudgetConfig,
  TokenBudgetSnapshot,
} from '@blade-ai/agent/budget';
${createAgentPublicTypeImportBlock('publishedConsumer')}
import {
  AsyncEventQueue,
  createInterruptAwareAbortSignal,
  decideNoToolTurn,
  decideTurnLimit,
  planToolExecution,
  resolveToolInterruptBehavior,
  toolUpdateToAgentEvent,
  ToolKind as AgentLoopToolKind,
} from '@blade-ai/agent/loop';
import type {
  AgentFunctionToolCall,
  AgentLoopToolEvent,
  AgentLoopToolExecutionUpdate,
  ToolBehavior as AgentLoopToolBehavior,
  ToolExecutionPlan,
  ToolInterruptBehavior,
} from '@blade-ai/agent/loop';
import { isOverflowRecoverable } from '@blade-ai/agent/recovery';
import type {
  AgentToolCallIdentity,
  AgentStoreAppendContext,
  AgentStorePort,
  SystemSource,
} from '@blade-ai/agent/state';
import {
  isValidSystemSource,
  modelResponseToAssistantMessage,
  toolResultToToolMessage,
} from '@blade-ai/agent/state';
import type {
  AgentTracePort,
  BufferedAgentTracePort,
  BufferedAgentTracePortOptions,
} from '@blade-ai/agent/tracing';
import { createBufferedAgentTracePort } from '@blade-ai/agent/tracing';
${createSdkPublicTypeImportBlock('publishedConsumer')}
import { PermissionMode as BrowserPermissionMode } from '@blade-ai/agent-sdk/browser';
import { subagentRegistry } from '@blade-ai/agent-sdk/server';
import { PermissionMode as CorePermissionMode } from '@blade-ai/agent-sdk/core';

const modelPort: ModelPort = {
  async generate(request: ModelRequest): Promise<ModelResponse> {
    return {
      content: request.messages.at(-1)?.content?.toString() ?? '',
    };
  },

  async *stream(): AsyncIterable<ModelStreamEvent> {
    yield {
      type: 'done',
      response: { content: 'ok' },
      finishReason: 'stop',
    };
  },
};

const modelSubpathResponse: ModelSubpathResponse = {
  content: 'ok',
};

const openaiCompatibleOptions: OpenAICompatibleModelPortOptions = {
  apiKey: 'test-key',
  baseUrl: 'https://example.test/v1',
  model: 'glm-5.2',
};
const compatibleModelFromSubpath: ModelPort = createOpenAICompatibleModelPort(openaiCompatibleOptions);

const vercelOptions: VercelLanguageModelOptions = {
  provider: 'openai-compatible',
  providerId: 'glm',
  apiKey: 'test-key',
  baseUrl: 'https://example.test/v1',
  model: 'glm-5.2',
};
const vercelModel: ModelPort = createVercelModelPort(vercelOptions);

const deepseekOptions: DeepSeekProviderOptions = {
  thinking: { type: 'enabled' },
  strictTools: true,
};
const normalizedDeepSeekModel: string = normalizeDeepSeekModel('deepseek-chat');
const deepseekCost: DeepSeekCostBreakdown | undefined = calculateDeepSeekCost({
  promptTokens: 1,
  completionTokens: 1,
  totalTokens: 2,
}, normalizedDeepSeekModel);

const chatConfig: ChatConfig = {
  provider: 'openai-compatible',
  apiKey: 'test-key',
  baseUrl: 'https://example.test/v1',
  model: 'glm-5.2',
};
const chatMessage: ChatMessage = { role: 'user', content: 'hello' };
const chatUsage: ChatUsageInfo = {
  promptTokens: 1,
  completionTokens: 1,
  totalTokens: 2,
};
const totalOnlyChatUsage: ChatUsageInfo = {
  totalTokens: 2,
};
const chatResponse: ChatResponse = {
  content: 'ok',
  usage: chatUsage,
};
const chatStreamChunk: ChatStreamChunk = {
  content: 'ok',
  usage: chatUsage,
};

const modelSubpathMessage: ModelMessage = { role: 'user', content: 'hello' };
const modelSubpathUsage: ModelSubpathUsageInfo = {
  promptTokens: 1,
  completionTokens: 1,
  totalTokens: 2,
};
const totalOnlyModelUsage: ModelSubpathUsageInfo = {
  totalTokens: 2,
};
const modelSubpathRequest: ModelSubpathRequest = {
  messages: [modelSubpathMessage],
};
const modelSubpathStreamEvent: ModelSubpathStreamEvent = {
  type: 'done',
  response: modelSubpathResponse,
  finishReason: 'stop',
};

const retrySource: QuerySource = 'main_thread';
const retryConfig: RetryConfig = {
  ...DEFAULT_RETRY_CONFIG,
  querySource: retrySource,
};
const retryContext: RetryContext = {};
const retryEvent: RetryEvent = {
  type: 'retry_attempt',
  attempt: 1,
  maxRetries: retryConfig.maxRetries,
  delayMs: 0,
  error: { message: 'retry me', status: 503 },
  querySource: retrySource,
};
const withRetryRef: typeof withRetry = withRetry;
const retryableNetworkError: boolean = isRetryableError({ status: 503 });

const kernelOptions: AgentKernelOptions = {
  model: modelPort,
  maxSteps: 2,
};
const executionEpoch = new ExecutionEpoch();
executionEpoch.invalidate();
const executionEpochIsInvalid: boolean = !executionEpoch.isValid;
const tokenBudgetConfig: TokenBudgetConfig = { maxTotalTokens: 100 };
const tokenBudgetSnapshot: TokenBudgetSnapshot = {
  totalInputTokens: 1,
  totalBillableInputTokens: 1,
  totalOutputTokens: 1,
  totalCacheWriteTokens: 0,
  totalCacheReadTokens: 0,
  totalCacheMissTokens: 1,
  totalTokens: 2,
  estimatedCost: 0,
  budgetRemaining: 98,
  budgetPercent: 0.02,
};

const turnInput: AgentTurnInput = {
  input: 'hello',
};
const agentProtocolEvent: AgentStreamEvent = {
  type: 'result',
  content: 'ok',
};

const toolPort: AgentToolPort = {
  async list() {
    return [];
  },
  async execute(toolCall: AgentToolCall) {
    return {
      id: toolCall.id,
      name: toolCall.name,
      output: 'ok',
    };
  },
};
const agentStoreAppendContext: AgentStoreAppendContext = {
  source: 'input',
  step: 0,
};
const agentStorePort: AgentStorePort = {
  appendMessage() {},
};
const queue = new AsyncEventQueue<string>();
queue.enqueue('turn_start');
queue.close();
const noToolDecision = await decideNoToolTurn('All done', [], 1);
const turnLimitDecision = await decideTurnLimit({
  maxTurns: 1,
  turnsCount: 1,
  contextMessages: [],
  toolCallsCount: 0,
  startTime: Date.now(),
  totalTokens: 0,
});
const plannedToolCall: AgentFunctionToolCall = {
  id: 'read-1',
  type: 'function',
  function: { name: 'Read', arguments: '{}' },
};
const readonlyToolBehavior: Partial<AgentLoopToolBehavior> = {
  kind: AgentLoopToolKind.ReadOnly,
  isReadOnly: true,
  isConcurrencySafe: true,
};
const toolExecutionPlan: ToolExecutionPlan = planToolExecution(
  [plannedToolCall],
  { get: () => ({ kind: AgentLoopToolKind.ReadOnly, resolveBehavior: () => readonlyToolBehavior }) },
);
const toolInterruptBehavior: ToolInterruptBehavior = resolveToolInterruptBehavior(
  { get: () => ({ kind: AgentLoopToolKind.Execute, interruptBehavior: 'cancel' }) },
  'Bash',
  {},
);
const interruptSignal = createInterruptAwareAbortSignal({
  interruptBehavior: toolInterruptBehavior,
});
interruptSignal.cleanup();
const toolExecutionUpdate: AgentLoopToolExecutionUpdate = {
  type: 'tool_ready',
  toolCall: plannedToolCall,
};
const toolAgentEvent: AgentLoopToolEvent | null = toolUpdateToAgentEvent(
  toolExecutionUpdate,
  { get: () => ({ kind: AgentLoopToolKind.ReadOnly }) },
);
const overflowIsRecoverable: boolean = isOverflowRecoverable(
  new Error('context_length_exceeded'),
);
const systemSource: SystemSource = 'catalog';
const isCatalogSystemSource: boolean = isValidSystemSource(systemSource);
const assistantMessageProjection = modelResponseToAssistantMessage({ content: 'hello' });
const toolMessageProjection = toolResultToToolMessage(
  { id: 'call_echo', name: 'Echo', output: 'hello' },
  { id: 'fallback_echo', name: 'FallbackEcho' },
);
const toolCallIdentity: AgentToolCallIdentity = {
  id: 'call_echo',
  name: 'Echo',
};
const agentTraceEvent: AgentTraceEvent = {
  type: 'turn_end',
  content: 'ok',
  finishReason: 'stop',
};
const agentTracePort: AgentTracePort = {
  record() {},
};
const bufferedAgentTracePortOptions: BufferedAgentTracePortOptions = {
  maxEvents: 1,
};
const bufferedAgentTracePort: BufferedAgentTracePort = createBufferedAgentTracePort(
  bufferedAgentTracePortOptions,
);
bufferedAgentTracePort.record(agentTraceEvent);

const sessionOptions: SessionOptions = {
  model: 'glm-5.2',
  provider: {
    type: 'openai-compatible',
    apiKey: 'test-key',
    baseUrl: 'https://example.test/v1',
  },
  allowedTools: [],
  temperature: 0.2,
  maxOutputTokens: 128,
  maxContextTokens: 128000,
  providerOptions: {
    openai: { reasoningEffort: 'low' },
  },
  thinkingEnabled: true,
  thinkingBudget: 1024,
  tokenBudget: {
    maxTotalTokens: 100000,
    warningThresholdPercent: 80,
    costPerInputToken: 0.0000001,
    costPerOutputToken: 0.0000002,
    costPerCacheWriteToken: 0.00000005,
    costPerCacheReadToken: 0.00000001,
  },
};

const streamMessage: StreamMessage = {
  type: 'content',
  delta: 'ok',
  sessionId: 'session-id',
};

const toolDefinition: ToolDefinition<{ text?: string }, string> = {
  name: 'noop',
  description: 'No-op tool',
  parameters: {
    type: 'object',
    properties: {},
  },
  async execute(input) {
    const data = input.text ?? 'ok';
    return {
      success: true,
      data,
      llmContent: data,
    };
  },
};
const subpathToolDefinition: SubpathToolDefinition<{ text?: string }, string> = toolDefinition;
const sessionRef: ISession | null = null;
const serverSessionRef: ServerSession | null = sessionRef;
const serverPermissionConfig: ServerPermissionsConfig = {
  allow: ['read'],
};
const serverPermissionMode: ClaudeCodePermissionMode = 'default';
const serverSubagentFrontmatter: SubagentFrontmatter = {
  name: 'reviewer',
  description: 'Reviews code',
};
const serverSubagentRunner: SubagentExecutionRunner = async () => ({
  success: true,
  message: 'ok',
});
const serverSubagentRegistryRef: typeof subagentRegistry = subagentRegistry;
const builtinToolsOptions: BuiltinToolsOptions = {};
const permissionMode: PermissionMode = CorePermissionMode.DEFAULT;
const browserStreamMessage: BrowserStreamMessage = streamMessage;
const browserPermissionMode: BrowserPermissionMode = BrowserPermissionMode.DEFAULT;
const runtimeContext: RuntimeContext = {};

void modelSubpathResponse;
void openaiCompatibleOptions;
void compatibleModelFromSubpath;
void vercelOptions;
void vercelModel;
void deepseekOptions;
void normalizedDeepSeekModel;
void deepseekCost;
void chatConfig;
void chatMessage;
void chatResponse;
void chatStreamChunk;
void totalOnlyChatUsage;
void modelSubpathRequest;
void modelSubpathStreamEvent;
void totalOnlyModelUsage;
void retryConfig;
void retryContext;
void retryEvent;
void withRetryRef;
void retryableNetworkError;
void kernelOptions;
void executionEpochIsInvalid;
void queue;
void noToolDecision;
void turnLimitDecision;
void toolExecutionPlan;
void interruptSignal;
void toolAgentEvent;
void overflowIsRecoverable;
void tokenBudgetConfig;
void tokenBudgetSnapshot;
void turnInput;
void agentProtocolEvent;
void toolPort;
void agentStoreAppendContext;
void agentStorePort;
void isCatalogSystemSource;
void assistantMessageProjection;
void toolMessageProjection;
void toolCallIdentity;
void agentTraceEvent;
void agentTracePort;
void bufferedAgentTracePortOptions;
void bufferedAgentTracePort;
void sessionOptions;
void streamMessage;
void toolDefinition;
void subpathToolDefinition;
void sessionRef;
void serverSessionRef;
void serverPermissionConfig;
void serverPermissionMode;
void serverSubagentFrontmatter;
void serverSubagentRunner;
void serverSubagentRegistryRef;
void builtinToolsOptions;
void permissionMode;
void browserStreamMessage;
void browserPermissionMode;
void runtimeContext;
`,
  );
  await run('npx', ['tsc', '--noEmit'], { cwd: consumerDir });
  console.log('[verify-published] temporary consumer TypeScript public declarations passed');
}

async function verifyPublishedWithPolling(options) {
  const startedAt = Date.now();
  let lastError;

  while (Date.now() - startedAt <= options.timeoutMs) {
    try {
      return await verifyPublishedOnce(options);
    } catch (error) {
      lastError = error;
      const elapsedMs = Date.now() - startedAt;

      if (elapsedMs + options.intervalMs > options.timeoutMs) {
        break;
      }
      console.log(`[verify-published] Waiting for release propagation: ${error.message}`);
      await delay(options.intervalMs);
    }
  }

  throw new Error(`Timed out waiting for published artifacts: ${lastError?.message ?? 'unknown error'}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(usage());
    return;
  }

  const version = normalizeVersion(options.version);
  const releaseUrl = await verifyPublishedWithPolling({
    repo: options.repo,
    version,
    timeoutMs: options.timeoutMs,
    intervalMs: options.intervalMs,
  });

  console.log(`[verify-published] GitHub Release visible: ${releaseUrl}`);
  for (const packageName of publishablePackages) {
    console.log(`[verify-published] npm package visible: ${packageName}@${version}`);
    console.log(`[verify-published] npm provenance attestation visible: ${packageName}@${version}`);
  }
}

main().catch((error) => {
  console.error(`[verify-published] ${error.message}`);
  process.exitCode = 1;
});
