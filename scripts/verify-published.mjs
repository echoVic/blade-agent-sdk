import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import ssri from 'ssri';
import { bundleWithEsbuildRetry } from './esbuild-bundle.mjs';

const execFileAsync = promisify(execFile);

const defaultRepo = 'echoVic/blade-agent-sdk';
const publishablePackages = [
  '@blade-ai/ai',
  '@blade-ai/agent',
  '@blade-ai/agent-sdk',
];
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
  './local': './dist/browser/server-only-stub.js',
};
const publishedManifestRequirements = [
  {
    packageName: '@blade-ai/ai',
    manifestPath: 'node_modules/@blade-ai/ai/package.json',
    description: 'Provider-agnostic AI model interfaces for Blade Agent',
    maxInstalledBytes: 256 * 1024,
    ...expectedPublishedPackageMetadata,
  },
  {
    packageName: '@blade-ai/agent',
    manifestPath: 'node_modules/@blade-ai/agent/package.json',
    description: 'Runtime-independent Blade Agent kernel contracts',
    maxInstalledBytes: 128 * 1024,
    ...expectedPublishedPackageMetadata,
  },
  {
    packageName: '@blade-ai/agent-sdk',
    manifestPath: 'node_modules/@blade-ai/agent-sdk/package.json',
    description: 'Session-first Blade Agent SDK',
    maxInstalledBytes: 1024 * 1024,
    ...expectedPublishedPackageMetadata,
  },
];
const publishedReadmeRequirements = [
  {
    packageName: '@blade-ai/ai',
    readmePath: 'node_modules/@blade-ai/ai/README.md',
    installCommand: 'pnpm add @blade-ai/ai',
    importSnippet: "import { createOpenAICompatibleModelPort } from '@blade-ai/ai';",
  },
  {
    packageName: '@blade-ai/agent',
    readmePath: 'node_modules/@blade-ai/agent/README.md',
    installCommand: 'pnpm add @blade-ai/agent',
    importSnippet: "import { AgentKernel } from '@blade-ai/agent';",
  },
  {
    packageName: '@blade-ai/agent-sdk',
    readmePath: 'node_modules/@blade-ai/agent-sdk/README.md',
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
    'typescript@^6.0.3',
    'esbuild@^0.28.1',
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
      `import * as ai from '@blade-ai/ai';
import * as aiOpenAICompatible from '@blade-ai/ai/providers/openai-compatible';
import * as aiRetry from '@blade-ai/ai/retry';
import * as agent from '@blade-ai/agent';
import * as agentKernel from '@blade-ai/agent/kernel';
import * as agentProtocol from '@blade-ai/agent/protocol';
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

assertRuntimeExport(ai, 'createOpenAICompatibleModelPort');
assertRuntimeExport(aiOpenAICompatible, 'createOpenAICompatibleModelPort');
assertRuntimeExport(aiRetry, 'DEFAULT_RETRY_CONFIG');
assertRuntimeExport(agent, 'AgentKernel');
assertRuntimeExport(agentKernel, 'AgentKernel');
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

if (Object.keys(agentProtocol).length !== 0) {
  throw new Error('@blade-ai/agent/protocol should remain type-only at runtime');
}
`,
    );
    await run(process.execPath, [runtimeSmokePath], { cwd: consumerDir });
    await verifyPublishedTypesSmoke({ consumerDir });
    await verifyPublishedRootDeclarationBoundary({ consumerDir });
    await verifyPublishedServerEntryBoundary({ consumerDir });
    await verifyPublishedServerDeclarationParity({ consumerDir });
    await verifyPublishedCoreDeclarationBoundary({ consumerDir });
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
    if (serializedManifest.includes('workspace:')) {
      throw new Error(`${requirement.packageName} installed manifest must not contain workspace: dependencies`);
    }
    if (serializedManifest.includes('0.0.0')) {
      throw new Error(`${requirement.packageName} installed manifest must not contain 0.0.0 placeholder versions`);
    }
    verifyPublishedPackageMetadata(requirement, manifest);
    assertNoCliProductManifest(requirement.packageName, manifest);
    assertPublishedManifestTarget({
      packageName: requirement.packageName,
      label: 'main',
      target: manifest.main,
    });
    assertPublishedManifestTarget({
      packageName: requirement.packageName,
      label: 'types',
      target: manifest.types,
    });
    verifyPublishedManifestExports({
      packageName: requirement.packageName,
      exportsMap: manifest.exports,
    });
    verifyPublishedSdkBrowserExportConditions(requirement.packageName, manifest);

    for (const dependencyBlock of [
      manifest.dependencies,
      manifest.peerDependencies,
      manifest.optionalDependencies,
    ]) {
      for (const [dependencyName, dependencyVersion] of Object.entries(dependencyBlock ?? {})) {
        if (publishablePackages.includes(dependencyName) && dependencyVersion !== version) {
          throw new Error(
            `${requirement.packageName} internal dependency ${dependencyName} must match published version ${version}, got ${dependencyVersion}`,
          );
        }
      }
    }
  }
  console.log('[verify-published] temporary consumer published package manifests passed');
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

function verifyPublishedManifestExports({ packageName, exportsMap }) {
  if (!exportsMap || typeof exportsMap !== 'object') return;

  for (const [exportName, exportValue] of Object.entries(exportsMap)) {
    if (typeof exportValue === 'string') {
      assertPublishedManifestTarget({
        packageName,
        label: `exports.${exportName}`,
        target: exportValue,
      });
      continue;
    }
    if (!exportValue || typeof exportValue !== 'object') continue;

    for (const [condition, target] of Object.entries(exportValue)) {
      assertPublishedManifestTarget({
        packageName,
        label: `exports.${exportName}.${condition}`,
        target,
      });
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

async function verifyPublishedReadmes({ consumerDir }) {
  for (const requirement of publishedReadmeRequirements) {
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
  }
  console.log('[verify-published] temporary consumer published package READMEs passed');
}

async function verifyPublishedLicenseArtifacts({ consumerDir }) {
  for (const requirement of publishedLicenseRequirements) {
    const license = await readFile(join(consumerDir, requirement.licensePath), 'utf8');

    if (!license.includes(mitPermissionGrant)) {
      throw new Error(`${requirement.packageName} published LICENSE must include the MIT permission grant`);
    }
  }
  console.log('[verify-published] temporary consumer published package license artifacts passed');
}

async function verifyPublishedCoreDeclarationBoundary({ consumerDir }) {
  const declarationPath = join(
    consumerDir,
    'node_modules/@blade-ai/agent-sdk/dist/core/index.d.ts',
  );
  const declarationSource = await readFile(declarationPath, 'utf8');
  const forbiddenCoreDeclarations = [
    {
      forbidden: 'createSession',
      message: 'published core declarations must stay browser-safe and not expose server-only session APIs',
    },
    {
      forbidden: 'resumeSession',
      message: 'published core declarations must stay browser-safe and not expose server-only session APIs',
    },
    {
      forbidden: 'forkSession',
      message: 'published core declarations must stay browser-safe and not expose server-only session APIs',
    },
    {
      forbidden: 'getBuiltinTools',
      message: 'published core declarations must stay browser-safe and not expose Node-local tool APIs',
    },
    {
      forbidden: 'createSdkMcpServer',
      message: 'published core declarations must stay browser-safe and not expose Node-local MCP APIs',
    },
  ];

  for (const rule of forbiddenCoreDeclarations) {
    if (declarationSource.includes(rule.forbidden)) {
      throw new Error(`${declarationPath}: ${rule.message}`);
    }
  }
}

async function verifyPublishedRootDeclarationBoundary({ consumerDir }) {
  const declarationPath = join(
    consumerDir,
    'node_modules/@blade-ai/agent-sdk/dist/index.d.ts',
  );
  const declarationSource = await readFile(declarationPath, 'utf8');
  const forbiddenRootDeclarations = [
    {
      forbidden: 'getBuiltinTools',
      message: 'published root declarations must keep Node-local builtin tools behind @blade-ai/agent-sdk/local',
    },
    {
      forbidden: 'createSdkMcpServer',
      message: 'published root declarations must keep Node-local MCP helpers behind @blade-ai/agent-sdk/local',
    },
    {
      forbidden: 'FileSystemMemoryStore',
      message: 'published root declarations must keep filesystem memory adapters behind @blade-ai/agent-sdk/local',
    },
    {
      forbidden: 'SandboxExecutor',
      message: 'published root declarations must keep sandbox adapters behind @blade-ai/agent-sdk/local',
    },
    {
      forbidden: 'normalizeDeepSeekModel',
      message: 'published root declarations must keep provider-specific DeepSeek helpers in @blade-ai/ai/deepseek',
    },
    {
      forbidden: 'calculateDeepSeekCost',
      message: 'published root declarations must keep provider-specific DeepSeek helpers in @blade-ai/ai/deepseek',
    },
    {
      forbidden: 'DeepSeekCostTracker',
      message: 'published root declarations must keep provider-specific DeepSeek helpers in @blade-ai/ai/deepseek',
    },
    {
      forbidden: 'DEEPSEEK_DEFAULT_MODEL',
      message: 'published root declarations must keep provider-specific DeepSeek helpers in @blade-ai/ai/deepseek',
    },
  ];

  for (const rule of forbiddenRootDeclarations) {
    if (declarationSource.includes(rule.forbidden)) {
      throw new Error(`${declarationPath}: ${rule.message}`);
    }
  }
}

async function verifyPublishedServerEntryBoundary({ consumerDir }) {
  const rules = [
    {
      file: 'package/dist/server/index.js',
      path: join(consumerDir, 'node_modules/@blade-ai/agent-sdk/dist/server/index.js'),
      forbidden: '../index.js',
      message: 'server runtime entry must be an explicit package-local facade',
    },
    {
      file: 'package/dist/server/index.d.ts',
      path: join(consumerDir, 'node_modules/@blade-ai/agent-sdk/dist/server/index.d.ts'),
      forbidden: '../index.js',
      message: 'server declarations must be an explicit package-local facade',
    },
  ];

  for (const rule of rules) {
    const source = await readFile(rule.path, 'utf8');
    if (source.includes(rule.forbidden)) {
      throw new Error(`${rule.file}: ${rule.message}`);
    }
  }
}

async function assertNoBrowserDisallowedMarkers(bundlePath) {
  const source = await readFile(bundlePath, 'utf8');
  for (const marker of browserDisallowedMarkers) {
    if (source.includes(marker)) {
      throw new Error(`Published browser bundle includes Node-only marker: ${marker}`);
    }
  }
}

async function verifyPublishedBrowserBundleSmoke({ consumerDir }) {
  const entryPath = join(consumerDir, 'consumer-browser-entry.ts');
  const bundlePath = join(consumerDir, 'consumer-browser-bundle.mjs');

  await writeFile(
    entryPath,
    `import { createSession as rootCreateSession, PermissionMode } from '@blade-ai/agent-sdk';
import { PermissionMode as CorePermissionMode } from '@blade-ai/agent-sdk/core';
import { createSession as serverCreateSession } from '@blade-ai/agent-sdk/server';
import { resumeSession } from '@blade-ai/agent-sdk/session';
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

console.log(PermissionMode.DEFAULT, CorePermissionMode.DEFAULT, ToolKind.READ, noopTool.name);
assertServerOnly(() => rootCreateSession({}), 'server-only for createSession');
assertServerOnly(() => serverCreateSession({}), 'server-only for createSession');
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
    'server-only for resumeSession',
    'server-only for getBuiltinTools',
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
      "import { AgentKernel as AgentKernelFromSubpath } from '@blade-ai/agent/kernel';",
      'const fakeModel = {',
      '  async generate() {',
      "    return { content: 'ok', finishReason: 'stop' };",
      '  },',
      '  async *stream() {',
      "    yield { type: 'done', response: { content: 'ok', finishReason: 'stop' } };",
      '  },',
      '};',
      'const kernel = new AgentKernel({ model: fakeModel });',
      'const kernelFromSubpath = new AgentKernelFromSubpath({ model: fakeModel });',
      "console.log('agent browser bundle', kernel.constructor.name, kernelFromSubpath.constructor.name);",
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
    `import type { ModelPort } from '@blade-ai/ai';
import type { ModelRequest } from '@blade-ai/ai';
import type { ModelResponse, ModelStreamEvent } from '@blade-ai/ai';
import type { ModelResponse as ModelSubpathResponse } from '@blade-ai/ai/model';
import type { OpenAICompatibleModelPortOptions } from '@blade-ai/ai/providers/openai-compatible';
import type { AgentKernelOptions } from '@blade-ai/agent';
import type { AgentTurnInput } from '@blade-ai/agent/kernel';
import type { AgentToolPort } from '@blade-ai/agent/ports';
import type { AgentToolCall } from '@blade-ai/agent/protocol';
import type { SessionOptions } from '@blade-ai/agent-sdk';
import type { StreamMessage } from '@blade-ai/agent-sdk';
import type { ToolDefinition } from '@blade-ai/agent-sdk';
import type { StreamMessage as BrowserStreamMessage } from '@blade-ai/agent-sdk/browser';
import { PermissionMode as BrowserPermissionMode } from '@blade-ai/agent-sdk/browser';
import type { ISession } from '@blade-ai/agent-sdk/session';
import type {
  ClaudeCodePermissionMode,
  ISession as ServerSession,
  PermissionsConfig as ServerPermissionsConfig,
  SubagentExecutionRunner,
  SubagentFrontmatter,
} from '@blade-ai/agent-sdk/server';
import { subagentRegistry } from '@blade-ai/agent-sdk/server';
import type { ToolDefinition as SubpathToolDefinition } from '@blade-ai/agent-sdk/tools';
import type { BuiltinToolsOptions } from '@blade-ai/agent-sdk/local';
import type { PermissionMode, RuntimeContext } from '@blade-ai/agent-sdk/core';
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

const kernelOptions: AgentKernelOptions = {
  model: modelPort,
  maxSteps: 2,
};

const turnInput: AgentTurnInput = {
  input: 'hello',
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
void kernelOptions;
void turnInput;
void toolPort;
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
