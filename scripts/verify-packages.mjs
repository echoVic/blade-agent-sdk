import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { bundleWithEsbuildRetry } from './esbuild-bundle.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const browserDisallowedMarkers = [
  'node:',
  'child_process',
  'undici',
  '@modelcontextprotocol',
  'node-pty',
];
const packageSpecs = [
  {
    name: '@blade-ai/ai',
    dir: 'packages/ai',
    requiredFiles: [
      'package/README.md',
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
import * as agentKernel from '@blade-ai/agent/kernel';
import * as agentProtocol from '@blade-ai/agent/protocol';
import * as agentPorts from '@blade-ai/agent/ports';
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
assertRuntimeExport(agentKernel, 'AgentKernel');
assertRuntimeExport(agentSdk, 'createSession');
assertRuntimeExport(agentSdk, 'defineTool');
assertRuntimeExport(agentSdkCore, 'PermissionMode');
assertRuntimeExport(agentSdkBrowser, 'PermissionMode');
assertRuntimeExport(agentSdkServer, 'createSession');
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
if (Object.keys(agentState).length !== 0) {
  throw new Error('@blade-ai/agent/state should remain type-only at runtime');
}
if (Object.keys(agentTracing).length !== 0) {
  throw new Error('@blade-ai/agent/tracing should remain type-only at runtime');
}
`,
  );
  run(process.execPath, [runtimeSmokePath], { cwd: consumerDir });
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
  AgentKernelOptions,
  AgentTurnInput,
} from '@blade-ai/agent/kernel';
import { AgentKernel as AgentKernelFromSubpath } from '@blade-ai/agent/kernel';
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
import type {
  AgentStoreAppendContext,
  AgentStorePort,
} from '@blade-ai/agent/state';
import type {
  AgentTraceEvent,
  AgentTracePort,
} from '@blade-ai/agent/tracing';
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
import { createSession as createSessionFromServerSubpath } from '@blade-ai/agent-sdk/server';
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
const agentTraceEvent: AgentTraceEvent = {
  type: 'turn_start',
  input: 'hello',
};
const agentTracePort: AgentTracePort = {
  record() {},
};

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
void chatResponse;
void chatStreamChunk;
void modelSubpathRequest;
void modelSubpathStreamEvent;
void retryContext;
void retryEvent;
void withRetryRef;
void retryableNetworkError;
void deepseekOptions;
void deepseekCost;
void useKernel;
void kernelFromSubpath;
void agentTurnInput;
void agentProtocolEvent;
void agentToolPort;
void agentPermissionPort;
void agentHookPort;
void agentStoreContext;
void agentStorePort;
void agentTraceEvent;
void agentTracePort;
void runtimeContext;
void coreToolDefinition;
void corePermissionHandler;
void coreDecision;
void coreToolKind;
void resumeOptions;
void createSessionFromSessionSubpathRef;
void resumeSessionFromSessionSubpathRef;
void createSessionFromServerSubpathRef;
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

function assertNoBrowserDisallowedMarkers(filePath) {
  const source = readFileSync(filePath, 'utf8');
  for (const marker of browserDisallowedMarkers) {
    if (source.includes(marker)) {
      throw new Error(`Browser bundle includes Node-only marker ${marker}: ${filePath}`);
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
      "import { StreamMessageType } from '@blade-ai/agent-sdk/core';",
      "import { ToolKind } from '@blade-ai/agent-sdk/tools';",
      "import { resumeSession } from '@blade-ai/agent-sdk/session';",
      "import { createSession as createServerSession } from '@blade-ai/agent-sdk/server';",
      "import { getBuiltinTools } from '@blade-ai/agent-sdk/local';",
      "console.log(PermissionMode.DEFAULT, StreamMessageType.CONTENT, ToolKind.ReadOnly);",
      "try { createSession({} as never); } catch (error) { console.log((error as Error).message); }",
      "try { resumeSession('session-id' as never); } catch (error) { console.log((error as Error).message); }",
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
  assertNoBrowserDisallowedMarkers(agentBundleOutput);
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
  verifyConsumerTypes(consumerDir);
  await verifyConsumerBrowserBundle(consumerDir);
  await verifyAgentBrowserBundle(consumerDir);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log('package verification passed');
