import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { bundleWithEsbuildRetry } from './esbuild-bundle.mjs';

const execFileAsync = promisify(execFile);

const defaultRepo = 'echoVic/blade-agent-sdk';
const publishablePackages = [
  '@blade-ai/ai',
  '@blade-ai/agent',
  '@blade-ai/agent-sdk',
];
const browserDisallowedMarkers = [
  'node:',
  'child_process',
  'undici',
  '@modelcontextprotocol',
  'node-pty',
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

  for (const packageName of publishablePackages) {
    const metadata = await verifyNpmPackage({ packageName, version });
    verifyNpmPackageProvenance({ packageName, version, metadata });
  }
  await verifyPublishedInstallSmoke({ version });

  return releaseUrl;
}

async function verifyPublishedInstallSmoke({ version }) {
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

assertRuntimeExport(ai, 'createOpenAICompatibleModelPort');
assertRuntimeExport(aiOpenAICompatible, 'createOpenAICompatibleModelPort');
assertRuntimeExport(aiRetry, 'DEFAULT_RETRY_CONFIG');
assertRuntimeExport(agent, 'AgentKernel');
assertRuntimeExport(agentKernel, 'AgentKernel');
assertRuntimeExport(agentSdk, 'createSession');
assertRuntimeExport(agentSdk, 'defineTool');
assertRuntimeExport(agentSdkBrowser, 'PermissionMode');
assertRuntimeExport(agentSdkCore, 'PermissionMode');
assertRuntimeExport(agentSdkLocal, 'getBuiltinTools');
assertRuntimeExport(agentSdkServer, 'createSession');
assertRuntimeExport(agentSdkSession, 'createSession');
assertRuntimeExport(agentSdkTools, 'ToolKind');

if (Object.keys(agentProtocol).length !== 0) {
  throw new Error('@blade-ai/agent/protocol should remain type-only at runtime');
}
`,
    );
    await run(process.execPath, [runtimeSmokePath], { cwd: consumerDir });
    await verifyPublishedTypesSmoke({ consumerDir });
    await verifyPublishedCoreDeclarationBoundary({ consumerDir });
    await verifyPublishedBrowserBundleSmoke({ consumerDir });
    console.log(`[verify-published] temporary consumer smoke passed: ${npmInstallCommandLabel}`);
  } finally {
    await rm(consumerDir, { recursive: true, force: true });
  }
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
import type { ISession as ServerSession } from '@blade-ai/agent-sdk/server';
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
