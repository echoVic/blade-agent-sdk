import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageSpecs = [
  {
    name: '@blade-ai/ai',
    dir: 'packages/ai',
    requiredFiles: [
      'package/README.md',
      'package/dist/index.js',
      'package/dist/index.d.ts',
      'package/dist/chat/index.js',
      'package/dist/model/index.d.ts',
    ],
    imports: [
      '@blade-ai/ai',
      '@blade-ai/ai/chat',
      '@blade-ai/ai/model',
      '@blade-ai/ai/retry',
    ],
  },
  {
    name: '@blade-ai/agent',
    dir: 'packages/agent',
    requiredFiles: [
      'package/README.md',
      'package/dist/index.js',
      'package/dist/index.d.ts',
      'package/dist/kernel/AgentKernel.js',
      'package/dist/kernel/AgentKernel.d.ts',
      'package/dist/protocol/index.js',
      'package/dist/protocol/index.d.ts',
      'package/dist/ports/index.js',
      'package/dist/ports/index.d.ts',
      'package/dist/state/index.js',
      'package/dist/state/index.d.ts',
      'package/dist/tracing/index.js',
      'package/dist/tracing/index.d.ts',
    ],
    imports: [
      '@blade-ai/agent',
      '@blade-ai/agent/kernel',
      '@blade-ai/agent/protocol',
      '@blade-ai/agent/ports',
      '@blade-ai/agent/state',
      '@blade-ai/agent/tracing',
    ],
  },
  {
    name: '@blade-ai/agent-sdk',
    dir: 'packages/agent-sdk',
    requiredFiles: [
      'package/README.md',
      'package/dist/index.js',
      'package/dist/index.d.ts',
      'package/dist/session/index.js',
      'package/dist/session/index.d.ts',
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
    ],
    forbiddenFileContents: [
      {
        file: 'package/dist/session/index.d.ts',
        forbidden: './Session.js',
        message: 'session declarations must be emitted from package-local session entry source',
      },
      {
        file: 'package/dist/session/types.d.ts',
        forbidden: "runtime?: 'kernel' | 'legacy'",
        message: 'session declarations must not expose retired legacy stream runtime options',
      },
      {
        file: 'package/dist/session/types.d.ts',
        forbidden: 'experimentalKernel',
        message: 'session declarations must not expose retired experimental kernel flags',
      },
      {
        file: 'package/dist/session/types.d.ts',
        forbidden: 'legacyStream',
        message: 'session declarations must not expose retired legacy stream helpers',
      },
      {
        file: 'package/dist/session/types.d.ts',
        forbidden: 'packageLocalLegacy',
        message: 'session declarations must not expose retired package-local legacy runtime helpers',
      },
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
      {
        file: 'package/dist/session/factory.d.ts',
        forbidden: 'fork(options',
        message: 'session runtime factory declarations must expose only create/resume primitives',
      },
      {
        file: 'package/dist/session/factory.d.ts',
        forbidden: 'prompt(message',
        message: 'session runtime factory declarations must expose only create/resume primitives',
      },
      {
        file: 'package/dist/session/config.d.ts',
        forbidden: './Session.js',
        message: 'session config declarations must be emitted from package-local session config source',
      },
      {
        file: 'package/dist/session/config.d.ts',
        forbidden: '../../../../src/types/common',
        message: 'session config declarations must use package-local core config types',
      },
      {
        file: 'package/dist/session/store.d.ts',
        forbidden: '../context/storage',
        message: 'session store declarations must be emitted from package-local session store source',
      },
      {
        file: 'package/dist/session/store.d.ts',
        forbidden: './SessionStore.js',
        message: 'session store declarations must not point back at legacy root session store',
      },
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
      {
        file: 'package/dist/index.d.ts',
        forbidden: './agent/loop/runToolCall.js',
        message: 'root declarations must be emitted from package-local root entry source',
      },
      {
        file: 'package/dist/index.d.ts',
        forbidden: './tools/core/createTool.js',
        message: 'root declarations must be emitted from package-local root entry source',
      },
      {
        file: 'package/dist/index.d.ts',
        forbidden: './tools/catalog/index.js',
        message: 'root declarations must be emitted from package-local root entry source',
      },
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
      {
        file: 'package/dist/index.d.ts',
        forbidden: 'public-index.js',
        message: 'root declarations must reference final public entrypoints, not overlay sources',
      },
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

  const testEntry = entries.find((entry) =>
    entry.includes('/__tests__/') || /\.(test|spec)\.[cm]?[jt]s$/.test(entry)
  );
  if (testEntry) {
    throw new Error(`${spec.name} tarball includes a test file: ${testEntry}`);
  }
}

function verifyPackedManifest(spec, tarballPath, tempDir) {
  const extractDir = join(tempDir, `extract-${spec.name.replaceAll(/[^a-z0-9]+/gi, '-')}`);
  run('mkdir', ['-p', extractDir]);
  run('tar', ['-xzf', tarballPath, '-C', extractDir]);
  const manifestPath = join(extractDir, 'package/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  if (manifest.name !== spec.name) {
    throw new Error(`Packed manifest name mismatch for ${spec.name}: ${manifest.name}`);
  }
  const serialized = JSON.stringify(manifest);
  if (serialized.includes('workspace:')) {
    throw new Error(`${spec.name} packed manifest still contains workspace protocol dependencies`);
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
  const staticImportPattern = /\bimport\s+(?:[\w*{}\s,]+from\s*)?["']([^"']+)["']/g;
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
  const imports = packageSpecs.flatMap((spec) => spec.imports);
  const script = imports.map((specifier) => `await import(${JSON.stringify(specifier)});`).join('\n');
  run(process.execPath, ['--input-type=module', '-e', script], {
    cwd: consumerDir,
  });
}

const tempDir = mkdtempSync(join(tmpdir(), 'blade-verify-packages-'));
try {
  const packDir = join(tempDir, 'packs');
  run('mkdir', ['-p', packDir]);

  const tarballs = new Map();
  for (const spec of packageSpecs) {
    const tarballPath = packPackage(spec, packDir);
    verifyTarballContents(spec, tarballPath);
    verifyPackedManifest(spec, tarballPath, tempDir);
    verifyForbiddenFileContents(spec, tarballPath, tempDir);
    verifyNoEagerLegacySessionRuntime(spec, tarballPath, tempDir);
    tarballs.set(spec.name, tarballPath);
  }

  const consumerDir = installConsumer(tarballs, tempDir);
  verifyConsumerImports(consumerDir);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log('package verification passed');
