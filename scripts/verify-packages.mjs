import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import {
  agentSdkCoreDeclarationBrowserSafeRules,
  agentSdkRootDeclarationEntryOwnershipRules,
  agentSdkRootPublicDeclarationBoundaryRules,
  agentSdkServerFacadeBoundaryRules,
  agentSdkSessionConfigDeclarationBoundaryRules,
  agentSdkSessionFactoryDeclarationBoundaryRules,
  agentSdkSessionPublicDeclarationBoundaryRules,
  agentSdkSessionStoreDeclarationBoundaryRules,
  toPackedForbiddenFileContents,
  toPackedForbiddenFileRules,
} from './agent-sdk-boundary-rules.mjs';
import { bundleWithEsbuildRetry } from './esbuild-bundle.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const browserDisallowedMarkers = [
  'node:',
  'child_process',
  'undici',
  '@modelcontextprotocol',
  'node-pty',
];
const requiredPackageKeywords = ['agent', 'sdk', 'llm'];
const mitPermissionGrant = 'Permission is hereby granted, free of charge';
const dependencySections = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
];
const nodeBuiltinModules = new Set(builtinModules);
const exactVersionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z-.]+)?$/;
const allowedPublicExportConditions = new Set(['types', 'browser', 'import']);
const forbiddenPackageLifecycleScripts = new Set([
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepublish',
  'prepublishOnly',
]);
const expectedPackedPackageMetadata = {
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
const expectedPackedSdkBrowserExports = {
  '.': './dist/browser/index.js',
  './server': './dist/browser/server-only-stub.js',
  './session': './dist/browser/server-only-stub.js',
  './session/internal': './dist/browser/server-only-stub.js',
  './local': './dist/browser/server-only-stub.js',
};
const packedSdkBrowserSafeEntries = [
  'package/dist/browser/index.js',
  'package/dist/core/index.js',
];
const packedReadmeRequirements = [
  {
    packageName: '@blade-ai/ai',
    readmePath: 'package/README.md',
    sourceReadmePath: 'packages/ai/README.md',
    installCommand: 'pnpm add @blade-ai/ai',
    importSnippet: "import { createOpenAICompatibleModelPort } from '@blade-ai/ai';",
  },
  {
    packageName: '@blade-ai/agent',
    readmePath: 'package/README.md',
    sourceReadmePath: 'packages/agent/README.md',
    installCommand: 'pnpm add @blade-ai/agent',
    importSnippet: "import { AgentKernel } from '@blade-ai/agent';",
  },
  {
    packageName: '@blade-ai/agent-sdk',
    readmePath: 'package/README.md',
    sourceReadmePath: 'packages/agent-sdk/README.md',
    installCommand: 'pnpm add @blade-ai/agent-sdk',
    importSnippet: "import { createSession } from '@blade-ai/agent-sdk';",
  },
];
const packageSpecs = [
  {
    name: '@blade-ai/ai',
    dir: 'packages/ai',
    expectedDescription: 'Provider-agnostic AI model interfaces for Blade Agent',
    maxPackedBytes: 128 * 1024,
    requiredFiles: [
      'package/README.md',
      'package/LICENSE',
      'package/dist/index.js',
      'package/dist/index.d.ts',
      'package/dist/chat/index.js',
      'package/dist/deepseek/index.d.ts',
      'package/dist/model/index.d.ts',
      'package/dist/providers/openai-compatible/index.js',
      'package/dist/providers/openai-compatible/index.d.ts',
      'package/dist/providers/vercel/index.js',
      'package/dist/providers/vercel/index.d.ts',
    ],
    imports: [
      '@blade-ai/ai',
      '@blade-ai/ai/chat',
      '@blade-ai/ai/deepseek',
      '@blade-ai/ai/model',
      '@blade-ai/ai/providers/openai-compatible',
      '@blade-ai/ai/providers/vercel',
      '@blade-ai/ai/retry',
    ],
  },
  {
    name: '@blade-ai/agent',
    dir: 'packages/agent',
    expectedDescription: 'Runtime-independent Blade Agent kernel contracts',
    maxPackedBytes: 64 * 1024,
    requiredFiles: [
      'package/README.md',
      'package/LICENSE',
      'package/dist/index.js',
      'package/dist/index.d.ts',
      'package/dist/budget/TokenBudget.js',
      'package/dist/budget/TokenBudget.d.ts',
      'package/dist/epoch/ExecutionEpoch.js',
      'package/dist/epoch/ExecutionEpoch.d.ts',
      'package/dist/kernel/AgentKernel.js',
      'package/dist/kernel/AgentKernel.d.ts',
      'package/dist/loop/index.js',
      'package/dist/loop/index.d.ts',
      'package/dist/protocol/index.js',
      'package/dist/protocol/index.d.ts',
      'package/dist/ports/index.js',
      'package/dist/ports/index.d.ts',
      'package/dist/recovery/index.js',
      'package/dist/recovery/index.d.ts',
      'package/dist/state/index.js',
      'package/dist/state/index.d.ts',
      'package/dist/tracing/index.js',
      'package/dist/tracing/index.d.ts',
    ],
    imports: [
      '@blade-ai/agent',
      '@blade-ai/agent/budget',
      '@blade-ai/agent/epoch',
      '@blade-ai/agent/kernel',
      '@blade-ai/agent/loop',
      '@blade-ai/agent/protocol',
      '@blade-ai/agent/ports',
      '@blade-ai/agent/recovery',
      '@blade-ai/agent/state',
      '@blade-ai/agent/tracing',
    ],
  },
  {
    name: '@blade-ai/agent-sdk',
    dir: 'packages/agent-sdk',
    expectedDescription: 'Session-first Blade Agent SDK',
    maxPackedBytes: 256 * 1024,
    requiredFiles: [
      'package/README.md',
      'package/LICENSE',
      'package/dist/index.js',
      'package/dist/index.d.ts',
      'package/dist/session/index.js',
      'package/dist/session/index.d.ts',
      'package/dist/session/internal.js',
      'package/dist/session/internal.d.ts',
      'package/dist/session/types.d.ts',
      'package/dist/session/Session.d.ts',
      'package/dist/session/config.d.ts',
      'package/dist/session/factory.d.ts',
      'package/dist/session/store.d.ts',
      'package/dist/browser/index.js',
      'package/dist/browser/server-only-stub.js',
      'package/dist/core/index.d.ts',
      'package/dist/local/index.d.ts',
      'package/dist/tools/index.js',
      'package/dist/types/permissions.d.ts',
    ],
    forbiddenFiles: [
      'package/dist/core/index.d.ts.map',
      'package/dist/index.d.ts.map',
      'package/dist/local/index.d.ts.map',
      'package/dist/session/index.d.ts.map',
      'package/dist/tools/index.d.ts.map',
      'package/dist/types/permissions.d.ts.map',
      'package/dist/agent/Agent.d.ts',
      'package/dist/context/ContextManager.d.ts',
      'package/dist/mcp/McpRegistry.d.ts',
    ],
    forbiddenFileContents: [
      {
        file: 'package/dist/session/index.d.ts',
        forbidden: './Session.js',
        message: 'session declarations must be emitted from package-local session entry source',
      },
      ...toPackedForbiddenFileRules(agentSdkSessionPublicDeclarationBoundaryRules),
      {
        file: 'package/dist/session/index.js',
        forbidden: '../../../../src/session/Session',
        message: 'session runtime entry must not import the legacy root Session directly',
      },
      {
        file: 'package/dist/session/index.js',
        forbidden: 'from"../../../../src/session/Session',
        message: 'session runtime entry must not import the legacy root Session directly',
      },
      {
        file: 'package/dist/session/index.js',
        forbidden: 'from "../../../../src/session/Session',
        message: 'session runtime entry must not import the legacy root Session directly',
      },
      {
        file: 'package/dist/session/Session.d.ts',
        forbidden: '../../../../src/session/Session',
        message: 'package-local Session declarations must expose local session contracts only',
      },
      ...toPackedForbiddenFileRules(agentSdkSessionFactoryDeclarationBoundaryRules),
      ...toPackedForbiddenFileRules(agentSdkSessionConfigDeclarationBoundaryRules),
      ...toPackedForbiddenFileRules(agentSdkSessionStoreDeclarationBoundaryRules),
      {
        file: 'package/dist/tools/index.d.ts',
        forbidden: './core/createTool.js',
        message: 'tools declarations must be emitted from package-local tools entry source',
      },
      {
        file: 'package/dist/tools/index.d.ts',
        forbidden: './catalog/index.js',
        message: 'tools declarations must be emitted from package-local tools entry source',
      },
      {
        file: 'package/dist/tools/index.js',
        forbidden: 'src/tools/core/createTool',
        message: 'tools runtime must be emitted from package-local tools source',
      },
      {
        file: 'package/dist/tools/index.js',
        forbidden: 'src/tools/catalog/ToolCatalog',
        message: 'tools runtime must be emitted from package-local tools source',
      },
      {
        file: 'package/dist/tools/index.d.ts',
        forbidden: '../core/createTool.js',
        message: 'tools declarations must be emitted from package-local tools entry source',
      },
      {
        file: 'package/dist/tools/index.d.ts',
        forbidden: '../catalog/ToolCatalog.js',
        message: 'tools declarations must be emitted from package-local tools entry source',
      },
      ...toPackedForbiddenFileContents('package/dist/index.d.ts', agentSdkRootDeclarationEntryOwnershipRules),
      {
        file: 'package/dist/index.js',
        forbidden: 'src/agent/subagents',
        message: 'root runtime must use package-local subagent compatibility exports',
      },
      {
        file: 'package/dist/index.d.ts',
        forbidden: '../agent/subagents',
        message: 'root declarations must use package-local subagent compatibility exports',
      },
      ...toPackedForbiddenFileContents('package/dist/index.d.ts', agentSdkRootPublicDeclarationBoundaryRules),
      ...toPackedForbiddenFileRules(agentSdkServerFacadeBoundaryRules),
      ...toPackedForbiddenFileRules(agentSdkCoreDeclarationBrowserSafeRules),
      {
        file: 'package/dist/local/index.d.ts',
        forbidden: '../mcp/index.js',
        message: 'local declarations must be emitted from package-local local entry source',
      },
      {
        file: 'package/dist/local/index.d.ts',
        forbidden: 'createSdkMcpServer(...args: unknown[])',
        message: 'local MCP declarations must use package-local MCP API',
      },
      {
        file: 'package/dist/local/index.d.ts',
        forbidden: 'tool(...args: unknown[])',
        message: 'local MCP declarations must use package-local MCP API',
      },
      {
        file: 'package/dist/local/index.d.ts',
        forbidden: '../memory/index.js',
        message: 'local declarations must be emitted from package-local local entry source',
      },
      {
        file: 'package/dist/local/index.d.ts',
        forbidden: '../sandbox/index.js',
        message: 'local declarations must be emitted from package-local local entry source',
      },
      {
        file: 'package/dist/local/index.d.ts',
        forbidden: 'constructor(...args: unknown[]): SandboxExecutor',
        message: 'local sandbox declarations must use package-local sandbox API',
      },
      {
        file: 'package/dist/local/index.d.ts',
        forbidden: 'constructor(...args: unknown[]): SandboxService',
        message: 'local sandbox declarations must use package-local sandbox API',
      },
      {
        file: 'package/dist/local/index.d.ts',
        forbidden: '../tools/builtin',
        message: 'local declarations must be emitted from package-local local entry source',
      },
      {
        file: 'package/dist/local/index.d.ts',
        forbidden: 'getBuiltinTools(...args: unknown[])',
        message: 'local builtin tool declarations must use package-local builtin tool API',
      },
      {
        file: 'package/dist/local/index.d.ts',
        forbidden: 'read(id: string)',
        message: 'local memory declarations must use package-local memory API',
      },
      {
        file: 'package/dist/local/index.d.ts',
        forbidden: 'write(input: MemoryInput)',
        message: 'local memory declarations must use package-local memory API',
      },
      {
        file: 'package/dist/local/index.d.ts',
        forbidden: 'delete(id: string): Promise<boolean>',
        message: 'local memory declarations must use package-local memory API',
      },
      {
        file: 'package/dist/local/index.js',
        forbidden: 'src/mcp',
        message: 'local runtime entry must route through package-local local adapters',
      },
      {
        file: 'package/dist/local/index.js',
        forbidden: 'src/memory',
        message: 'local runtime entry must route through package-local local adapters',
      },
      {
        file: 'package/dist/local/index.js',
        forbidden: 'src/sandbox',
        message: 'local runtime entry must route through package-local local adapters',
      },
      {
        file: 'package/dist/local/index.js',
        forbidden: 'src/tools/builtin',
        message: 'local runtime entry must route through package-local local adapters',
      },
      {
        file: 'package/dist/local/index.js',
        forbidden: 'src/tools/builtin/memory',
        message: 'local memory tools must route through package-local local adapters',
      },
      {
        file: 'package/dist/types/permissions.d.ts',
        forbidden: 'SensitiveFileDetector',
        message: 'permission declarations must be emitted from package-local permission source',
      },
      {
        file: 'package/dist/types/permissions.d.ts',
        forbidden: './ToolEffects.js',
        message: 'permission declarations must use package-local tool contracts',
      },
    ],
    imports: [
      '@blade-ai/agent-sdk',
      '@blade-ai/agent-sdk/core',
      '@blade-ai/agent-sdk/browser',
      '@blade-ai/agent-sdk/server',
      '@blade-ai/agent-sdk/session',
      '@blade-ai/agent-sdk/session/internal',
      '@blade-ai/agent-sdk/tools',
      '@blade-ai/agent-sdk/local',
    ],
  },
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  if (result.status !== 0) {
    throw new Error([
      `Command failed: ${command} ${args.join(' ')}`,
      result.stdout.trim(),
      result.stderr.trim(),
    ].filter(Boolean).join('\n'));
  }
  return result.stdout.trim();
}

function packPackage(spec, outputDir) {
  const output = run('pnpm', [
    '--dir',
    spec.dir,
    'pack',
    '--pack-destination',
    outputDir,
  ]);
  const tarballName = output.split('\n').at(-1)?.trim();
  if (!tarballName) {
    throw new Error(`Unable to resolve tarball name for ${spec.name} from:\n${output}`);
  }
  const tarballPath = resolve(outputDir, tarballName);
  if (!existsSync(tarballPath)) {
    throw new Error(`Packed tarball does not exist for ${spec.name}: ${tarballPath}`);
  }
  return tarballPath;
}

function verifyPackedArtifactSize(spec, tarballPath) {
  if (!spec.maxPackedBytes) return;

  const sizeBytes = statSync(tarballPath).size;
  if (sizeBytes > spec.maxPackedBytes) {
    throw new Error(
      `${spec.name} packed tarball exceeds size budget: ${sizeBytes} bytes > ${spec.maxPackedBytes} bytes`,
    );
  }
}

function listTarball(tarballPath) {
  return run('tar', ['-tf', tarballPath]).split('\n').filter(Boolean);
}

function verifyTarballContents(spec, tarballPath) {
  const entries = listTarball(tarballPath);
  for (const file of spec.requiredFiles) {
    if (!entries.includes(file)) {
      throw new Error(`${spec.name} tarball is missing required file: ${file}`);
    }
  }

  for (const file of spec.forbiddenFiles ?? []) {
    if (entries.includes(file)) {
      throw new Error(`${spec.name} tarball includes forbidden file: ${file}`);
    }
  }

  const declarationMapEntry = entries.find((entry) => entry.endsWith('.d.ts.map'));
  if (declarationMapEntry) {
    throw new Error(`${spec.name} tarball includes a declaration map: ${declarationMapEntry}`);
  }

  const sourceMapEntry = entries.find((entry) => entry.endsWith('.js.map'));
  if (sourceMapEntry) {
    throw new Error(`${spec.name} tarball includes a JavaScript source map: ${sourceMapEntry}`);
  }

  const testEntry = entries.find((entry) =>
    entry.includes('/__tests__/') || /\.(test|spec)\.[cm]?[jt]s$/.test(entry)
  );
  if (testEntry) {
    throw new Error(`${spec.name} tarball includes a test file: ${testEntry}`);
  }

  const sourceEntry = entries.find((entry) => entry.includes('/src/') || entry.startsWith('package/src/'));
  if (sourceEntry) {
    throw new Error(`${spec.name} tarball includes source files: ${sourceEntry}`);
  }

  const typescriptArtifactEntry = entries.find(
    (entry) => isTypeScriptSourceArtifact(entry) || isTypeScriptBuildConfigArtifact(entry),
  );
  if (typescriptArtifactEntry) {
    throw new Error(`${spec.name} tarball includes TypeScript source artifacts: ${typescriptArtifactEntry}`);
  }

  for (const entry of entries) {
    assertAllowedPackageArtifact(spec.name, entry);
  }

  assertNoCliProductFiles(spec.name, entries);
}

function isTypeScriptSourceArtifact(entry) {
  return /\.(?:ts|tsx|mts|cts)$/.test(entry) && !/\.d\.[cm]?ts$/.test(entry);
}

function isTypeScriptBuildConfigArtifact(entry) {
  const normalized = entry.startsWith('package/') ? entry.slice('package/'.length) : entry;
  const fileName = normalized.split('/').at(-1) ?? normalized;
  return /^tsconfig(?:\.[^/]+)?\.json$/.test(fileName) || /^tsup\.config\.[cm]?[jt]s$/.test(fileName);
}

function assertAllowedPackageArtifact(packageName, entry) {
  const alwaysAllowed = new Set([
    'package',
    'package/',
    'package/package.json',
    'package/README.md',
    'package/LICENSE',
    'package/dist',
    'package/dist/',
  ]);
  if (alwaysAllowed.has(entry) || entry.startsWith('package/dist/')) return;
  if (
    packageName === '@blade-ai/agent-sdk' &&
    (entry === 'package/vendor' ||
      entry === 'package/vendor/' ||
      entry === 'package/vendor/ripgrep' ||
      entry === 'package/vendor/ripgrep/' ||
      entry.startsWith('package/vendor/ripgrep/'))
  ) {
    return;
  }

  throw new Error(`${packageName} tarball includes an unexpected package artifact: ${entry}`);
}

function assertNoCliProductFiles(packageName, entries) {
  const cliEntry = entries.find((entry) => entry.startsWith('package/dist/cli/'));
  if (cliEntry) {
    throw new Error(`${packageName} tarball includes CLI product files: ${cliEntry}`);
  }
}

function verifyPackedReadmes(spec, tarballPath, tempDir) {
  const requirement = packedReadmeRequirements.find((item) => item.packageName === spec.name);
  if (!requirement) return;

  const extractDir = join(tempDir, `readme-${spec.name.replaceAll(/[^a-z0-9]+/gi, '-')}`);
  run('mkdir', ['-p', extractDir]);
  run('tar', ['-xzf', tarballPath, '-C', extractDir, requirement.readmePath]);
  const sourceReadme = readFileSync(resolve(repoRoot, requirement.sourceReadmePath), 'utf8');
  const readme = readFileSync(join(extractDir, requirement.readmePath), 'utf8');

  if (!readme.includes(requirement.packageName)) {
    throw new Error(`${spec.name} packed README must name the package`);
  }
  if (!readme.includes(requirement.installCommand)) {
    throw new Error(`${spec.name} packed README must document direct installation`);
  }
  if (!readme.includes(requirement.importSnippet)) {
    throw new Error(`${spec.name} packed README must document direct import usage`);
  }
  if (readme !== sourceReadme) {
    throw new Error(`${spec.name} packed README must match the package README exactly`);
  }
}

function verifyPackedLicenseArtifacts(spec, tarballPath, tempDir) {
  const extractDir = join(tempDir, `license-${spec.name.replaceAll(/[^a-z0-9]+/gi, '-')}`);
  run('mkdir', ['-p', extractDir]);
  run('tar', ['-xzf', tarballPath, '-C', extractDir, 'package/LICENSE']);
  const rootLicense = readFileSync(resolve(repoRoot, 'LICENSE'), 'utf8');
  const license = readFileSync(join(extractDir, 'package/LICENSE'), 'utf8');

  if (!license.includes(mitPermissionGrant)) {
    throw new Error(`${spec.name} packed LICENSE must include the MIT permission grant`);
  }
  if (license !== rootLicense) {
    throw new Error(`${spec.name} packed LICENSE must match the root LICENSE exactly`);
  }
}

function verifyPackedManifest(spec, tarballPath, tempDir) {
  const extractDir = join(tempDir, `extract-${spec.name.replaceAll(/[^a-z0-9]+/gi, '-')}`);
  run('mkdir', ['-p', extractDir]);
  run('tar', ['-xzf', tarballPath, '-C', extractDir]);
  const tarballEntries = new Set(listTarball(tarballPath));
  const manifestPath = join(extractDir, 'package/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  if (manifest.name !== spec.name) {
    throw new Error(`Packed manifest name mismatch for ${spec.name}: ${manifest.name}`);
  }
  const serialized = JSON.stringify(manifest);
  if ('private' in manifest) {
    throw new Error(`${spec.name} packed manifest must not contain private metadata`);
  }
  if ('devDependencies' in manifest) {
    throw new Error(`${spec.name} packed manifest must not contain devDependencies`);
  }
  assertNoPackageLifecycleScripts(spec.name, manifest, 'packed manifest');
  if (serialized.includes('workspace:')) {
    throw new Error(`${spec.name} packed manifest still contains workspace protocol dependencies`);
  }
  verifyPackedManifestDependencyVersions(spec.name, manifest);
  verifyPackedPackageMetadata(spec, manifest);
  assertNoCliProductManifest(spec.name, manifest);
  assertPackedManifestTarget({
    packageName: spec.name,
    label: 'main',
    target: manifest.main,
  });
  assertManifestTargetExtension({
    packageName: spec.name,
    label: 'main',
    condition: 'import',
    target: manifest.main,
  });
  assertPackedManifestTargetExists({
    packageName: spec.name,
    label: 'main',
    target: manifest.main,
    tarballEntries,
  });
  assertPackedManifestTarget({
    packageName: spec.name,
    label: 'types',
    target: manifest.types,
  });
  assertManifestTargetExtension({
    packageName: spec.name,
    label: 'types',
    condition: 'types',
    target: manifest.types,
  });
  assertPackedManifestTargetExists({
    packageName: spec.name,
    label: 'types',
    target: manifest.types,
    tarballEntries,
  });
  verifyPackedManifestExports({
    packageName: spec.name,
    manifest,
    tarballEntries,
  });
  verifyPackedSdkBrowserExportConditions(spec.name, manifest);
}

function verifyPackedRuntimeExternalDependencies(spec, tarballPath, tempDir) {
  const extractDir = join(tempDir, `runtime-deps-${spec.name.replaceAll(/[^a-z0-9]+/gi, '-')}`);
  run('mkdir', ['-p', extractDir]);
  run('tar', ['-xzf', tarballPath, '-C', extractDir]);
  const packageDir = join(extractDir, 'package');
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  const declaredDependencies = getDeclaredRuntimeDependencies(manifest);

  for (const dependencyName of collectRuntimeExternalImports(packageDir)) {
    if (dependencyName === manifest.name || declaredDependencies.has(dependencyName)) {
      continue;
    }
    throw new Error(
      `${spec.name} packed runtime import is not declared in package dependencies: ${dependencyName}`,
    );
  }
}

function verifyPackedRuntimeRelativeImports(spec, tarballPath, tempDir) {
  const extractDir = join(tempDir, `runtime-relative-${spec.name.replaceAll(/[^a-z0-9]+/gi, '-')}`);
  run('mkdir', ['-p', extractDir]);
  run('tar', ['-xzf', tarballPath, '-C', extractDir]);
  const packageDir = join(extractDir, 'package');

  for (const filePath of listRuntimeJavaScriptFiles(packageDir)) {
    const source = readFileSync(filePath, 'utf8');
    for (const specifier of collectImportSpecifiers(source)) {
      if (!specifier.startsWith('.')) continue;
      const resolvedImport = resolveRuntimeRelativeImport(filePath, specifier);
      if (!resolvedImport) {
        throw new Error(
          `${spec.name} packed runtime relative import does not resolve: ${relativePackagePath(packageDir, filePath)} -> ${specifier}`,
        );
      }
      if (!isInsideDirectory(resolvedImport, packageDir)) {
        throw new Error(
          `${spec.name} packed runtime relative import escapes the package: ${relativePackagePath(packageDir, filePath)} -> ${specifier}`,
        );
      }
    }
  }
}

function verifyPackedDeclarationRelativeReferences(spec, tarballPath, tempDir) {
  const extractDir = join(tempDir, `declaration-relative-${spec.name.replaceAll(/[^a-z0-9]+/gi, '-')}`);
  run('mkdir', ['-p', extractDir]);
  run('tar', ['-xzf', tarballPath, '-C', extractDir]);
  const packageDir = join(extractDir, 'package');

  for (const filePath of listDeclarationFiles(packageDir)) {
    const source = readFileSync(filePath, 'utf8');
    for (const specifier of collectDeclarationRelativeSpecifiers(source)) {
      const resolvedReference = resolveDeclarationRelativeReference(filePath, specifier);
      if (!resolvedReference) {
        throw new Error(
          `${spec.name} packed declaration relative reference does not resolve: ${relativePackagePath(packageDir, filePath)} -> ${specifier}`,
        );
      }
      if (!isInsideDirectory(resolvedReference, packageDir)) {
        throw new Error(
          `${spec.name} packed declaration relative reference escapes the package: ${relativePackagePath(packageDir, filePath)} -> ${specifier}`,
        );
      }
    }
  }
}

function verifyPackedDeclarationExternalDependencies(spec, tarballPath, tempDir) {
  const extractDir = join(tempDir, `declaration-external-${spec.name.replaceAll(/[^a-z0-9]+/gi, '-')}`);
  run('mkdir', ['-p', extractDir]);
  run('tar', ['-xzf', tarballPath, '-C', extractDir]);
  const packageDir = join(extractDir, 'package');
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  const declaredDependencies = getDeclaredRuntimeDependencies(manifest);

  for (const dependencyName of collectDeclarationExternalReferences(packageDir)) {
    if (dependencyName === manifest.name || isDeclaredDeclarationDependency(dependencyName, declaredDependencies)) {
      continue;
    }
    throw new Error(
      `${spec.name} packed declaration reference is not declared in package dependencies: ${dependencyName}`,
    );
  }
}

function verifyPackedManifestDependencyVersions(packageName, manifest) {
  for (const section of dependencySections) {
    for (const [dependencyName, dependencyVersion] of Object.entries(manifest[section] ?? {})) {
      const version = String(dependencyVersion);
      const isInternalDependency = dependencyName.startsWith('@blade-ai/');
      if (isInternalDependency) {
        if (version !== '0.0.0' && !exactVersionPattern.test(version)) {
          throw new Error(
            `${packageName} packed manifest internal dependency ${section}.${dependencyName} must use 0.0.0 during local pack or an exact dependency version, got ${version}`,
          );
        }
        continue;
      }
      if (version === '0.0.0') {
        throw new Error(
          `${packageName} packed manifest must not contain 0.0.0 placeholder versions in ${section}.${dependencyName}`,
        );
      }
      if (!exactVersionPattern.test(version)) {
        throw new Error(
          `${packageName} packed manifest dependency ${section}.${dependencyName} must use an exact dependency version, got ${version}`,
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

function collectRuntimeExternalImports(packageDir) {
  const dependencies = new Set();

  for (const filePath of listRuntimeJavaScriptFiles(packageDir)) {
    const source = readFileSync(filePath, 'utf8');
    for (const specifier of collectImportSpecifiers(source)) {
      const dependencyName = getExternalPackageName(specifier);
      if (dependencyName) {
        dependencies.add(dependencyName);
      }
    }
  }

  return dependencies;
}

function collectDeclarationExternalReferences(packageDir) {
  const dependencies = new Set();

  for (const filePath of listDeclarationFiles(packageDir)) {
    const source = readFileSync(filePath, 'utf8');
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

function listRuntimeJavaScriptFiles(packageDir) {
  return run('find', [join(packageDir, 'dist'), '-type', 'f', '-name', '*.js'])
    .split('\n')
    .filter(Boolean);
}

function listDeclarationFiles(packageDir) {
  return run('find', [join(packageDir, 'dist'), '-type', 'f', '-name', '*.d.ts'])
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

function resolveRuntimeRelativeImport(fromFile, specifier) {
  const candidate = resolve(dirname(fromFile), specifier);
  const candidates = [
    candidate,
    `${candidate}.js`,
    join(candidate, 'index.js'),
  ];
  return candidates.find((filePath) => filePath.endsWith('.js') && existsSync(filePath) && statSync(filePath).isFile()) ?? null;
}

function resolveDeclarationRelativeReference(fromFile, specifier) {
  const candidate = resolve(dirname(fromFile), specifier);
  const candidates = [
    candidate.endsWith('.js') ? `${candidate.slice(0, -3)}.d.ts` : candidate,
    candidate.endsWith('.d.ts') ? candidate : `${candidate}.d.ts`,
    join(candidate, 'index.d.ts'),
  ];
  return candidates.find((filePath) => filePath.endsWith('.d.ts') && existsSync(filePath) && statSync(filePath).isFile()) ?? null;
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

function verifyPackedPackageMetadata(spec, manifest) {
  const metadataRules = [
    {
      field: 'description',
      expected: spec.expectedDescription,
      message: 'packed manifest description mismatch',
    },
    {
      field: 'author',
      expected: expectedPackedPackageMetadata.author,
      message: 'packed manifest author mismatch',
    },
    {
      field: 'type',
      expected: expectedPackedPackageMetadata.type,
      message: 'packed manifest type module mismatch',
    },
    {
      field: 'sideEffects',
      expected: expectedPackedPackageMetadata.sideEffects,
      message: 'packed manifest sideEffects mismatch',
    },
    {
      field: 'license',
      expected: expectedPackedPackageMetadata.license,
      message: 'packed manifest license mismatch',
    },
    {
      field: 'engines',
      expected: expectedPackedPackageMetadata.engines,
      message: 'packed manifest node engine mismatch',
    },
    {
      field: 'homepage',
      expected: expectedPackedPackageMetadata.homepage,
      message: 'packed manifest homepage mismatch',
    },
    {
      field: 'bugs',
      expected: expectedPackedPackageMetadata.bugs,
      message: 'packed manifest bugs mismatch',
    },
    {
      field: 'repository',
      expected: {
        ...expectedPackedPackageMetadata.repository,
        directory: spec.dir,
      },
      message: 'packed manifest repository mismatch',
    },
  ];

  for (const rule of metadataRules) {
    const actual = manifest[rule.field];
    if (JSON.stringify(actual) !== JSON.stringify(rule.expected)) {
      throw new Error(
        `${spec.name} ${rule.message}: expected ${JSON.stringify(rule.expected)}, got ${JSON.stringify(actual)}`,
      );
    }
  }

  for (const keyword of requiredPackageKeywords) {
    if (!manifest.keywords?.includes(keyword)) {
      throw new Error(`${spec.name} packed manifest keywords must include ${keyword}`);
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

function assertPackedManifestTarget({ packageName, label, target }) {
  if (typeof target !== 'string') return;
  if (target === './package.json') return;

  if (!target.startsWith('./')) {
    throw new Error(`${packageName} ${label} packed manifest target must stay package-relative: ${target}`);
  }
  if (target.startsWith('../') || target.includes('/../')) {
    throw new Error(`${packageName} ${label} packed manifest target must not escape the package: ${target}`);
  }
  if (target.includes('/src/') || target.startsWith('./src/')) {
    throw new Error(`${packageName} ${label} packed manifest target must not point at source files: ${target}`);
  }
  if (!target.startsWith('./dist/')) {
    throw new Error(`${packageName} ${label} packed manifest target must point at ./dist/: ${target}`);
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

function assertPackedManifestTargetExists({ packageName, label, target, tarballEntries }) {
  if (typeof target !== 'string') return;
  const normalizedTarget = target.startsWith('./') ? target.slice(2) : target;
  if (!tarballEntries.has(`package/${normalizedTarget}`)) {
    throw new Error(`${packageName} ${label} packed manifest target does not exist in the tarball: ${target}`);
  }
}

function assertManifestExportSubpathShape({ packageName, exportName, label }) {
  if (exportName !== '.' && !exportName.startsWith('./')) {
    throw new Error(`${packageName} ${label} export subpath "${exportName}" must be "." or start with "./"`);
  }
  if (exportName.split('/').includes('..')) {
    throw new Error(`${packageName} ${label} export subpath "${exportName}" must not contain parent directory segments`);
  }
}

function getManifestRootExportConditions(exportsMap) {
  if (!exportsMap || typeof exportsMap !== 'object' || Array.isArray(exportsMap)) {
    return null;
  }
  const rootExport = exportsMap['.'];
  if (!rootExport || typeof rootExport !== 'object' || Array.isArray(rootExport)) {
    return null;
  }
  return rootExport;
}

function isExactPackageJsonManifestExport(exportName, exportValue) {
  return (
    exportName === './package.json' &&
    exportValue &&
    typeof exportValue === 'object' &&
    !Array.isArray(exportValue) &&
    Object.keys(exportValue).length === 1 &&
    exportValue.default === './package.json'
  );
}

function assertManifestTypesConditionFirst({ packageName, exportName, exportValue, label }) {
  if (Object.keys(exportValue).at(0) !== 'types') {
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
  const conditions = Object.keys(exportValue);
  const browserIndex = conditions.indexOf('browser');
  const importIndex = conditions.indexOf('import');
  if (browserIndex !== -1 && importIndex !== -1 && browserIndex > importIndex) {
    throw new Error(`${packageName} ${label} export ${exportName} must declare the browser condition before import`);
  }
}

function verifyPackedManifestExports({ packageName, manifest, tarballEntries }) {
  const exportsMap = manifest.exports;
  const rootExport = getManifestRootExportConditions(exportsMap);
  if (!rootExport) {
    throw new Error(`${packageName} packed manifest exports must declare a root "." condition object`);
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
    throw new Error(`${packageName} packed manifest metadata export must be exactly {"default":"./package.json"}`);
  }

  for (const [exportName, exportValue] of Object.entries(exportsMap)) {
    assertManifestExportSubpathShape({
      packageName,
      exportName,
      label: 'packed manifest',
    });
    if (isExactPackageJsonManifestExport(exportName, exportValue)) continue;
    if (typeof exportValue === 'string') {
      throw new Error(
        `${packageName} packed manifest export ${exportName} must declare paired types and import conditions`,
      );
    }
    if (!exportValue || typeof exportValue !== 'object' || Array.isArray(exportValue)) {
      throw new Error(
        `${packageName} packed manifest export ${exportName} must declare paired types and import conditions`,
      );
    }
    if (typeof exportValue.types !== 'string' || typeof exportValue.import !== 'string') {
      throw new Error(
        `${packageName} packed manifest export ${exportName} must declare paired types and import conditions`,
      );
    }
    assertManifestTypesConditionFirst({
      packageName,
      exportName,
      exportValue,
      label: 'packed manifest',
    });
    assertManifestExportConditionsAllowed({
      packageName,
      exportName,
      exportValue,
      label: 'packed manifest',
    });
    assertManifestBrowserConditionBeforeImport({
      packageName,
      exportName,
      exportValue,
      label: 'packed manifest',
    });

    for (const [condition, target] of Object.entries(exportValue)) {
      assertPackedManifestTarget({
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
      assertPackedManifestTargetExists({
        packageName,
        label: `exports.${exportName}.${condition}`,
        target,
        tarballEntries,
      });
      continue;
    }
  }
}

function verifyPackedSdkBrowserExportConditions(packageName, manifest) {
  if (packageName !== '@blade-ai/agent-sdk') return;
  const exportsMap = manifest.exports;
  if (!exportsMap || typeof exportsMap !== 'object') {
    throw new Error('@blade-ai/agent-sdk packed SDK export map is missing');
  }

  for (const [exportName, expectedBrowserTarget] of Object.entries(expectedPackedSdkBrowserExports)) {
    const exportValue = exportsMap[exportName];
    if (!exportValue || typeof exportValue !== 'object') {
      throw new Error(`@blade-ai/agent-sdk packed SDK export ${exportName} must be an export condition object`);
    }
    if (exportValue.browser !== expectedBrowserTarget) {
      throw new Error(
        `@blade-ai/agent-sdk packed SDK export ${exportName} browser condition mismatch: expected ${expectedBrowserTarget}, got ${exportValue.browser}`,
      );
    }
    if (typeof exportValue.import !== 'string') {
      throw new Error(
        `@blade-ai/agent-sdk packed SDK export ${exportName} must keep an import condition alongside the browser condition`,
      );
    }
  }
}

function verifyForbiddenFileContents(spec, tarballPath, tempDir) {
  for (const rule of spec.forbiddenFileContents ?? []) {
    const extractDir = join(
      tempDir,
      `content-${spec.name.replaceAll(/[^a-z0-9]+/gi, '-')}-${rule.file.replaceAll(/[^a-z0-9]+/gi, '-')}`,
    );
    run('mkdir', ['-p', extractDir]);
    run('tar', ['-xzf', tarballPath, '-C', extractDir, rule.file]);
    const filePath = join(extractDir, rule.file);
    const source = readFileSync(filePath, 'utf8');
    if (source.includes(rule.forbidden)) {
      throw new Error(`${spec.name} ${rule.file}: ${rule.message}`);
    }
  }
}

function resolvePackedRelativeImport(fromFile, specifier, packageDir) {
  if (!specifier.startsWith('.')) return null;

  const candidate = resolve(dirname(fromFile), specifier);
  const candidates = [
    candidate,
    `${candidate}.js`,
    join(candidate, 'index.js'),
  ];
  const resolved = candidates.find((file) => existsSync(file));
  if (!resolved) return null;
  if (!resolved.startsWith(packageDir)) {
    throw new Error(`Packed import escapes package directory: ${fromFile} -> ${specifier}`);
  }
  return resolved;
}

function collectPackedStaticImports(entryFile, packageDir, seen = new Set()) {
  if (seen.has(entryFile)) return seen;
  seen.add(entryFile);

  const source = readFileSync(entryFile, 'utf8');
  const staticImportPattern = /\b(?:import|export)\s+(?:[\w*{}\s,]+from\s*)?["']([^"']+)["']/g;
  for (const match of source.matchAll(staticImportPattern)) {
    const child = resolvePackedRelativeImport(entryFile, match[1], packageDir);
    if (child) {
      collectPackedStaticImports(child, packageDir, seen);
    }
  }
  return seen;
}

function verifyNoEagerLegacySessionRuntime(spec, tarballPath, tempDir) {
  if (spec.name !== '@blade-ai/agent-sdk') return;

  const extractDir = join(tempDir, 'eager-session-runtime');
  const packageDir = join(extractDir, 'package');
  const sessionEntry = 'package/dist/session/index.js';
  run('mkdir', ['-p', extractDir]);
  run('tar', ['-xzf', tarballPath, '-C', extractDir]);

  const eagerFiles = collectPackedStaticImports(join(extractDir, sessionEntry), packageDir);
  const forbiddenMarkers = [
    '../../src/session/Session.ts',
    '../../src/session/SessionRuntime.ts',
    '../../src/session/SessionStore.ts',
  ];

  for (const filePath of eagerFiles) {
    const source = readFileSync(filePath, 'utf8');
    const relativeFilePath = filePath.slice(`${extractDir}/`.length);
    for (const marker of forbiddenMarkers) {
      if (source.includes(marker)) {
        throw new Error(
          `${spec.name} ${relativeFilePath}: public session entry eagerly includes legacy root session runtime marker ${marker}`,
        );
      }
    }
  }
}

function installConsumer(tarballs, tempDir) {
  const consumerDir = join(tempDir, 'consumer');
  run('mkdir', ['-p', consumerDir]);
  const localTarballDependencies = Object.fromEntries(
    packageSpecs.map((spec) => [spec.name, `file:${tarballs.get(spec.name)}`]),
  );
  writeFileSync(
    join(consumerDir, 'package.json'),
    JSON.stringify({
      type: 'module',
      private: true,
      dependencies: localTarballDependencies,
    }, null, 2),
  );
  writeFileSync(
    join(consumerDir, 'pnpm-workspace.yaml'),
    stringify({
      overrides: localTarballDependencies,
    }),
  );
  run('pnpm', ['install', '--ignore-scripts', '--config.dedupe-peer-dependents=false'], {
    cwd: consumerDir,
  });
  return consumerDir;
}

function verifyConsumerImports(consumerDir) {
  const runtimeSmokePath = join(consumerDir, 'consumer-runtime.mjs');
  writeFileSync(
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
import * as agentProtocol from '@blade-ai/agent/protocol';
import * as agentPorts from '@blade-ai/agent/ports';
import * as agentRecovery from '@blade-ai/agent/recovery';
import * as agentState from '@blade-ai/agent/state';
import * as agentTracing from '@blade-ai/agent/tracing';
import * as agentSdk from '@blade-ai/agent-sdk';
import * as agentSdkCore from '@blade-ai/agent-sdk/core';
import * as agentSdkBrowser from '@blade-ai/agent-sdk/browser';
import * as agentSdkServer from '@blade-ai/agent-sdk/server';
import * as agentSdkSession from '@blade-ai/agent-sdk/session';
import * as agentSdkTools from '@blade-ai/agent-sdk/tools';
import * as agentSdkLocal from '@blade-ai/agent-sdk/local';

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

function assertPackageName(manifest, name) {
  if (manifest.name !== name) {
    throw new Error(\`Expected package metadata for \${name}, received \${manifest.name}\`);
  }
}

assertPackageName(aiPackage, '@blade-ai/ai');
assertPackageName(agentPackage, '@blade-ai/agent');
assertPackageName(agentSdkPackage, '@blade-ai/agent-sdk');
assertRuntimeExport(ai, 'createOpenAICompatibleModelPort');
assertRuntimeExport(aiDeepseek, 'normalizeDeepSeekModel');
assertRuntimeExport(aiOpenAICompatible, 'createOpenAICompatibleModelPort');
assertRuntimeExport(aiVercel, 'createVercelModelPort');
assertRuntimeExport(aiRetry, 'DEFAULT_RETRY_CONFIG');
assertRuntimeExport(aiRetry, 'withRetry');
assertRuntimeExport(agent, 'AgentKernel');
assertRuntimeExport(agent, 'TokenBudget');
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
agentTrace.record({ type: 'turn_start', input: 'packed trace smoke' });
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
assertRuntimeExport(agentSdkCore, 'PermissionMode');
assertRuntimeExport(agentSdkBrowser, 'PermissionMode');
assertRuntimeExport(agentSdkServer, 'createSession');
assertRuntimeExport(agentSdkServer, 'subagentRegistry');
assertRuntimeExportParity(agentSdk, agentSdkServer, 'root', 'server');
assertRuntimeExport(agentSdkSession, 'createSession');
assertRuntimeExport(agentSdkSession, 'resumeSession');
assertRuntimeExport(agentSdkTools, 'ToolKind');
assertRuntimeExport(agentSdkLocal, 'getBuiltinTools');

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
  run(process.execPath, [runtimeSmokePath], { cwd: consumerDir });
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

function verifyServerDeclarationParity(consumerDir) {
  const rootDeclaration = readFileSync(
    join(consumerDir, 'node_modules/@blade-ai/agent-sdk/dist/index.d.ts'),
    'utf8',
  );
  const serverDeclaration = readFileSync(
    join(consumerDir, 'node_modules/@blade-ai/agent-sdk/dist/server/index.d.ts'),
    'utf8',
  );

  assertDeclarationExportParity(rootDeclaration, serverDeclaration, 'root', 'server');
}

function verifyConsumerTypes(consumerDir) {
  writeFileSync(
    join(consumerDir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        lib: ['ES2022', 'DOM'],
      },
      include: ['consumer-types.ts'],
    }, null, 2),
  );

  writeFileSync(
    join(consumerDir, 'consumer-types.ts'),
    `import type { ModelPort, ModelRequest, ModelResponse, ModelStreamEvent } from '@blade-ai/ai';
import { createOpenAICompatibleModelPort } from '@blade-ai/ai';
import type {
  ChatConfig,
  ChatResponse,
  Message as ChatMessage,
  StreamChunk as ChatStreamChunk,
  UsageInfo as ChatUsageInfo,
} from '@blade-ai/ai/chat';
import type {
  ModelMessage,
  ModelRequest as ModelSubpathRequest,
  ModelResponse as ModelSubpathResponse,
  ModelStreamEvent as ModelSubpathStreamEvent,
  UsageInfo as ModelSubpathUsageInfo,
} from '@blade-ai/ai/model';
import type {
  QuerySource,
  RetryConfig,
  RetryContext,
  RetryEvent,
} from '@blade-ai/ai/retry';
import { DEFAULT_RETRY_CONFIG, isRetryableError, withRetry } from '@blade-ai/ai/retry';
import type { DeepSeekCostBreakdown, DeepSeekProviderOptions } from '@blade-ai/ai/deepseek';
import { calculateDeepSeekCost, normalizeDeepSeekModel } from '@blade-ai/ai/deepseek';
import type { OpenAICompatibleModelPortOptions } from '@blade-ai/ai/providers/openai-compatible';
import { createOpenAICompatibleModelPort as createCompatibleModelPortFromSubpath } from '@blade-ai/ai/providers/openai-compatible';
import type { VercelLanguageModelOptions } from '@blade-ai/ai/providers/vercel';
import { createVercelModelPort } from '@blade-ai/ai/providers/vercel';
import type { AgentStreamEvent } from '@blade-ai/agent';
import { AgentKernel } from '@blade-ai/agent';
import type {
  TokenBudgetConfig,
  TokenBudgetSnapshot,
} from '@blade-ai/agent/budget';
import { ExecutionEpoch } from '@blade-ai/agent/epoch';
import type {
  AgentKernelOptions,
  AgentTurnInput,
} from '@blade-ai/agent/kernel';
import { AgentKernel as AgentKernelFromSubpath } from '@blade-ai/agent/kernel';
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
import type {
  AgentStreamEvent as AgentProtocolStreamEvent,
  AgentToolCall,
  AgentToolResult,
} from '@blade-ai/agent/protocol';
import type {
  AgentHookPort,
  AgentPermissionPort,
  AgentToolPort,
} from '@blade-ai/agent/ports';
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
  AgentTraceEvent,
  AgentTracePort,
  BufferedAgentTracePort,
  BufferedAgentTracePortOptions,
} from '@blade-ai/agent/tracing';
import { createBufferedAgentTracePort } from '@blade-ai/agent/tracing';
import type { SessionOptions, StreamMessage } from '@blade-ai/agent-sdk';
import { createSession, defineTool, ToolKind } from '@blade-ai/agent-sdk';
import type {
  JsonObject as CoreJsonObject,
  PermissionHandler,
  RuntimeContext,
  StreamMessage as CoreStreamMessage,
  ToolDefinition as CoreToolDefinition,
} from '@blade-ai/agent-sdk/core';
import {
  createModePermissionHandler,
  PermissionDecision,
  PermissionMode as CorePermissionMode,
  StreamMessageType as CoreStreamMessageType,
  ToolKind as CoreToolKind,
} from '@blade-ai/agent-sdk/core';
import type {
  ISession as SubpathSession,
  ResumeOptions,
  SessionOptions as SubpathSessionOptions,
} from '@blade-ai/agent-sdk/session';
import {
  createSession as createSessionFromSessionSubpath,
  resumeSession as resumeSessionFromSessionSubpath,
} from '@blade-ai/agent-sdk/session';
import type {
  ToolDefinition as ToolsToolDefinition,
  ToolResult as ToolsToolResult,
} from '@blade-ai/agent-sdk/tools';
import {
  defineTool as defineToolFromToolsSubpath,
  ToolKind as ToolsToolKind,
} from '@blade-ai/agent-sdk/tools';
import type { BuiltinToolsOptions } from '@blade-ai/agent-sdk/local';
import { getBuiltinTools } from '@blade-ai/agent-sdk/local';
import type {
  ClaudeCodePermissionMode,
  ISession as ServerSession,
  PermissionsConfig as ServerPermissionsConfig,
  SubagentExecutionRunner,
  SubagentFrontmatter,
} from '@blade-ai/agent-sdk/server';
import {
  createSession as createSessionFromServerSubpath,
  subagentRegistry,
} from '@blade-ai/agent-sdk/server';
import type { StreamMessage as BrowserStreamMessage } from '@blade-ai/agent-sdk/browser';
import {
  PermissionMode as BrowserPermissionMode,
  createSession as createBrowserSession,
} from '@blade-ai/agent-sdk/browser';

const compatibleOptions: OpenAICompatibleModelPortOptions = {
  apiKey: 'test-key',
  baseUrl: 'https://example.test/v1',
  model: 'glm-5.2',
};
const model = createOpenAICompatibleModelPort(compatibleOptions);
const compatibleModelFromSubpath: ModelPort = createCompatibleModelPortFromSubpath(compatibleOptions);

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

const request: ModelRequest = {
  messages: [{ role: 'user', content: 'hello' }],
  temperature: 0.2,
  maxOutputTokens: 128,
};
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
const modelSubpathResponse: ModelSubpathResponse = {
  content: 'ok',
  usage: modelSubpathUsage,
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

async function useModelPort(): Promise<ModelResponse> {
  return await model.generate(request);
}

const fakeModel: ModelPort = {
  async generate(): Promise<ModelResponse> {
    return {
      content: 'ok',
      finishReason: 'stop',
      usage: {
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      },
    };
  },

  async *stream(): AsyncIterable<ModelStreamEvent> {
    yield {
      type: 'done',
      response: { content: 'ok', finishReason: 'stop' },
      finishReason: 'stop',
    };
  },
};

const kernel = new AgentKernel({ model: fakeModel, modelCallMode: 'stream' });
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
const executionEpoch = new ExecutionEpoch();
executionEpoch.invalidate();
const executionEpochIsInvalid: boolean = !executionEpoch.isValid;
const overflowIsRecoverable: boolean = isOverflowRecoverable(
  new Error('context_length_exceeded'),
);
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
const agentKernelOptions: AgentKernelOptions = { model: fakeModel };
const kernelFromSubpath: AgentKernel = new AgentKernelFromSubpath(agentKernelOptions);
const agentTurnInput: AgentTurnInput = { input: 'hello', turnId: 'turn-id' };
const agentToolCall: AgentToolCall = {
  id: 'tool-call-id',
  name: 'echo',
  input: { text: 'hello' },
};
const agentToolResult: AgentToolResult = {
  id: agentToolCall.id,
  name: agentToolCall.name,
  output: 'hello',
};
const agentProtocolEvent: AgentProtocolStreamEvent = {
  type: 'tool_result',
  result: agentToolResult,
};
const agentToolPort: AgentToolPort = {
  async list() {
    return [];
  },
  async execute(toolCall) {
    return {
      id: toolCall.id,
      name: toolCall.name,
      output: 'ok',
    };
  },
};
const agentPermissionPort: AgentPermissionPort = {
  checkToolCall() {
    return { behavior: 'allow' };
  },
};
const agentHookPort: AgentHookPort = {};
const agentStoreContext: AgentStoreAppendContext = {
  source: 'input',
  step: 0,
  turnId: 'turn-id',
};
const agentStorePort: AgentStorePort = {
  appendMessage() {},
};
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
  type: 'turn_start',
  input: 'hello',
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

async function useKernel(): Promise<void> {
  for await (const event of kernel.runTurn({ input: 'hello' })) {
    const typedEvent: AgentStreamEvent = event;
    if (typedEvent.type === 'result') {
      typedEvent.content satisfies string;
    }
  }
}

const echoTool = defineTool({
  name: 'echo',
  description: 'Echo input',
  kind: ToolKind.ReadOnly,
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string' },
    },
    required: ['text'],
  },
  async execute(input: { text: string }) {
    return {
      success: true,
      data: input.text,
      llmContent: input.text,
    };
  },
});

const sessionOptions: SessionOptions = {
  provider: {
    type: 'openai-compatible',
    apiKey: 'test-key',
    baseUrl: 'https://example.test/v1',
  },
  model: 'glm-5.2',
  allowedTools: [],
  tools: [echoTool],
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

const coreJson: CoreJsonObject = { ok: true };
const runtimeContext: RuntimeContext = {
  capabilities: {
    filesystem: {
      roots: ['/tmp/project'],
      cwd: '/tmp/project',
    },
  },
  metadata: coreJson,
};
const coreStreamMessage: CoreStreamMessage = {
  type: CoreStreamMessageType.CONTENT,
  delta: 'ok',
  sessionId: 'session-id',
};
const coreToolDefinition: CoreToolDefinition<{ text: string }, string> = echoTool;
const corePermissionHandler: PermissionHandler = createModePermissionHandler(CorePermissionMode.DEFAULT);
const coreDecision = PermissionDecision.ALLOW;
const coreToolKind = CoreToolKind.ReadOnly;

const sessionOptionsFromSubpath: SubpathSessionOptions = sessionOptions;
const resumeOptions: ResumeOptions = {
  ...sessionOptionsFromSubpath,
  sessionId: 'session-id',
};
const createSessionFromSessionSubpathRef: typeof createSession = createSessionFromSessionSubpath;
const resumeSessionFromSessionSubpathRef: (options: ResumeOptions) => Promise<SubpathSession> =
  resumeSessionFromSessionSubpath;
const createSessionFromServerSubpathRef: typeof createSession = createSessionFromServerSubpath;
const serverSessionRef: ServerSession | null = null;
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

const toolsResult: ToolsToolResult<string> = {
  success: true,
  data: 'ok',
  llmContent: 'ok',
};
const toolsTool: ToolsToolDefinition<{ text: string }, string> = defineToolFromToolsSubpath({
  name: 'typed_echo',
  description: 'Typed echo input',
  kind: ToolsToolKind.ReadOnly,
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  async execute(input: { text: string }) {
    return toolsResult;
  },
});

const builtinOptions: BuiltinToolsOptions = {};
const getBuiltinToolsRef: typeof getBuiltinTools = getBuiltinTools;

const browserStreamMessage: BrowserStreamMessage = coreStreamMessage;
const browserMode: BrowserPermissionMode = BrowserPermissionMode.DEFAULT;
const browserCreateSessionRef: typeof createBrowserSession = createBrowserSession;

async function useSession(): Promise<void> {
  const session = await createSession(sessionOptions);
  await session.send('hello');
  for await (const event of session.stream()) {
    const typedEvent: StreamMessage = event;
    if (typedEvent.type === 'content') {
      typedEvent.delta satisfies string;
    }
  }
  session.close();
}

void useModelPort;
void compatibleModelFromSubpath;
void vercelModel;
void chatConfig;
void chatMessage;
void totalOnlyChatUsage;
void chatResponse;
void chatStreamChunk;
void modelSubpathRequest;
void totalOnlyModelUsage;
void modelSubpathStreamEvent;
void retryContext;
void retryEvent;
void withRetryRef;
void retryableNetworkError;
void deepseekOptions;
void deepseekCost;
void useKernel;
void queue;
void noToolDecision;
void turnLimitDecision;
void toolExecutionPlan;
void interruptSignal;
void toolAgentEvent;
void executionEpochIsInvalid;
void overflowIsRecoverable;
void tokenBudgetConfig;
void tokenBudgetSnapshot;
void kernelFromSubpath;
void agentTurnInput;
void agentProtocolEvent;
void agentToolPort;
void agentPermissionPort;
void agentHookPort;
void agentStoreContext;
void agentStorePort;
void isCatalogSystemSource;
void assistantMessageProjection;
void toolMessageProjection;
void toolCallIdentity;
void agentTraceEvent;
void agentTracePort;
void bufferedAgentTracePortOptions;
void bufferedAgentTracePort;
void runtimeContext;
void coreToolDefinition;
void corePermissionHandler;
void coreDecision;
void coreToolKind;
void resumeOptions;
void createSessionFromSessionSubpathRef;
void resumeSessionFromSessionSubpathRef;
void createSessionFromServerSubpathRef;
void serverSessionRef;
void serverPermissionConfig;
void serverPermissionMode;
void serverSubagentFrontmatter;
void serverSubagentRunner;
void serverSubagentRegistryRef;
void toolsTool;
void builtinOptions;
void getBuiltinToolsRef;
void browserStreamMessage;
void browserMode;
void browserCreateSessionRef;
void useSession;
`,
  );

  run(resolve(repoRoot, 'node_modules/.bin/tsc'), ['--noEmit', '-p', 'tsconfig.json'], {
    cwd: consumerDir,
  });
}

function verifyPackedSdkBrowserSafeStaticClosures(spec, tarballPath, tempDir) {
  if (spec.name !== '@blade-ai/agent-sdk') return;

  const extractDir = join(tempDir, 'sdk-browser-safe-static-closure');
  const packageDir = join(extractDir, 'package');
  run('mkdir', ['-p', extractDir]);
  run('tar', ['-xzf', tarballPath, '-C', extractDir]);

  for (const entry of packedSdkBrowserSafeEntries) {
    const entryFile = join(extractDir, entry);
    if (!existsSync(entryFile)) {
      throw new Error(`${spec.name} packed SDK browser-safe static import closure entry is missing: ${entry}`);
    }

    for (const filePath of collectPackedStaticImports(entryFile, packageDir)) {
      assertNoBrowserDisallowedMarkers(filePath, 'packed SDK browser-safe static import closure');
    }
  }
}

function assertNoBrowserDisallowedMarkers(filePath, context = 'Browser bundle') {
  const source = readFileSync(filePath, 'utf8');
  for (const marker of browserDisallowedMarkers) {
    if (source.includes(marker)) {
      throw new Error(`${context} includes Node-only marker ${marker}: ${filePath}`);
    }
  }
}

async function verifyConsumerBrowserBundle(consumerDir) {
  const entry = join(consumerDir, 'consumer-browser-entry.ts');
  const output = join(consumerDir, 'consumer-browser-bundle.js');
  writeFileSync(
    entry,
    [
      "import { createSession, PermissionMode } from '@blade-ai/agent-sdk';",
      "import { createSession as createBrowserSession, PermissionMode as BrowserPermissionMode, StreamMessageType as BrowserStreamMessageType } from '@blade-ai/agent-sdk/browser';",
      "import { StreamMessageType } from '@blade-ai/agent-sdk/core';",
      "import { ToolKind } from '@blade-ai/agent-sdk/tools';",
      "import { resumeSession } from '@blade-ai/agent-sdk/session';",
      "import { createSession as createInternalSession } from '@blade-ai/agent-sdk/session/internal';",
      "import { createSession as createServerSession } from '@blade-ai/agent-sdk/server';",
      "import { getBuiltinTools } from '@blade-ai/agent-sdk/local';",
      "console.log(PermissionMode.DEFAULT, BrowserPermissionMode.DEFAULT, StreamMessageType.CONTENT, BrowserStreamMessageType.CONTENT, ToolKind.ReadOnly);",
      "try { createSession({} as never); } catch (error) { console.log((error as Error).message); }",
      "try { createBrowserSession({} as never); } catch (error) { console.log(`server-only for browser createSession: ${(error as Error).message}`); }",
      "try { resumeSession('session-id' as never); } catch (error) { console.log((error as Error).message); }",
      "try { createInternalSession({} as never); } catch (error) { console.log(`server-only for internal createSession: ${(error as Error).message}`); }",
      "try { createServerSession({} as never); } catch (error) { console.log((error as Error).message); }",
      "try { getBuiltinTools(); } catch (error) { console.log((error as Error).message); }",
    ].join('\n'),
  );

  await bundleWithEsbuildRetry({
    entryPoints: [entry],
    bundle: true,
    platform: 'browser',
    conditions: ['browser'],
    format: 'esm',
    outfile: output,
    absWorkingDir: consumerDir,
    logLevel: 'silent',
  });

  const browserRunOutput = run(process.execPath, [output], { cwd: consumerDir });
  if (!browserRunOutput.includes('server-only for createSession')) {
    throw new Error('Browser bundle does not include the createSession server-only stub message');
  }
  if (!browserRunOutput.includes('server-only for browser createSession')) {
    throw new Error('Browser bundle does not include the browser createSession server-only stub message');
  }
  if (!browserRunOutput.includes('server-only for internal createSession')) {
    throw new Error('Browser bundle does not include the internal createSession server-only stub message');
  }
  if (!browserRunOutput.includes('server-only for resumeSession')) {
    throw new Error('Browser bundle does not include the resumeSession server-only stub message');
  }
  if (!browserRunOutput.includes('server-only for getBuiltinTools')) {
    throw new Error('Browser bundle does not include the getBuiltinTools server-only stub message');
  }
  assertNoBrowserDisallowedMarkers(output);
}

async function verifyAgentBrowserBundle(consumerDir) {
  const entry = join(consumerDir, 'consumer-agent-browser-entry.ts');
  const agentBundleOutput = join(consumerDir, 'consumer-agent-browser-bundle.js');
  writeFileSync(
    entry,
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
      'const kernel = new AgentKernel({ model: fakeModel });',
      'const budget = new TokenBudget({ maxTotalTokens: 10 });',
      'const epoch = new ExecutionEpoch();',
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

  await bundleWithEsbuildRetry({
    entryPoints: [entry],
    bundle: true,
    platform: 'browser',
    conditions: ['browser'],
    format: 'esm',
    outfile: agentBundleOutput,
    absWorkingDir: consumerDir,
    logLevel: 'silent',
  });

  const browserRunOutput = run(process.execPath, [agentBundleOutput], { cwd: consumerDir });
  if (!browserRunOutput.includes('agent browser bundle')) {
    throw new Error('Agent browser bundle smoke did not execute');
  }
  if (!browserRunOutput.includes('AgentKernel AgentKernel TokenBudget _ExecutionEpoch AsyncEventQueue')) {
    throw new Error('Agent browser bundle core runtime smoke did not execute');
  }
  if (!browserRunOutput.includes('finish stop serial cancel tool_start true')) {
    throw new Error('Agent browser bundle loop/recovery smoke did not execute');
  }
  if (!browserRunOutput.includes('catalog true')) {
    throw new Error('Agent browser bundle system-source smoke did not execute');
  }
  if (!browserRunOutput.includes('assistant tool')) {
    throw new Error('Agent browser bundle message projection smoke did not execute');
  }
  if (!browserRunOutput.includes('turn_end')) {
    throw new Error('Agent browser bundle tracing smoke did not execute');
  }
  assertNoBrowserDisallowedMarkers(agentBundleOutput);
}

const tempDir = mkdtempSync(join(tmpdir(), 'blade-verify-packages-'));
try {
  const packDir = join(tempDir, 'packs');
  run('mkdir', ['-p', packDir]);

  const tarballs = new Map();
  for (const spec of packageSpecs) {
    const tarballPath = packPackage(spec, packDir);
    verifyPackedArtifactSize(spec, tarballPath);
    verifyTarballContents(spec, tarballPath);
    verifyPackedReadmes(spec, tarballPath, tempDir);
    verifyPackedLicenseArtifacts(spec, tarballPath, tempDir);
    verifyPackedManifest(spec, tarballPath, tempDir);
    verifyPackedRuntimeExternalDependencies(spec, tarballPath, tempDir);
    verifyPackedRuntimeRelativeImports(spec, tarballPath, tempDir);
    verifyPackedDeclarationRelativeReferences(spec, tarballPath, tempDir);
    verifyPackedDeclarationExternalDependencies(spec, tarballPath, tempDir);
    verifyForbiddenFileContents(spec, tarballPath, tempDir);
    verifyNoEagerLegacySessionRuntime(spec, tarballPath, tempDir);
    verifyPackedSdkBrowserSafeStaticClosures(spec, tarballPath, tempDir);
    tarballs.set(spec.name, tarballPath);
  }

  const consumerDir = installConsumer(tarballs, tempDir);
  verifyConsumerImports(consumerDir);
  verifyServerDeclarationParity(consumerDir);
  verifyConsumerTypes(consumerDir);
  await verifyConsumerBrowserBundle(consumerDir);
  await verifyAgentBrowserBundle(consumerDir);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log('package verification passed');
