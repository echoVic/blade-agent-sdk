import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const defaultRepo = 'echoVic/blade-agent-sdk';
const publishablePackages = [
  '@blade-ai/ai',
  '@blade-ai/agent',
  '@blade-ai/agent-sdk',
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
    '--json',
  ]);
  const publishedVersion = JSON.parse(stdout);

  if (publishedVersion !== version) {
    throw new Error(`${packageName} version mismatch: expected ${version}, got ${publishedVersion}`);
  }
}

async function verifyPublishedOnce({ repo, version }) {
  const releaseUrl = await verifyGithubRelease({ repo, version });

  for (const packageName of publishablePackages) {
    await verifyNpmPackage({ packageName, version });
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
import * as agentSdkCore from '@blade-ai/agent-sdk/core';
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
assertRuntimeExport(agentSdkCore, 'PermissionMode');
assertRuntimeExport(agentSdkSession, 'createSession');
assertRuntimeExport(agentSdkTools, 'ToolKind');

if (Object.keys(agentProtocol).length !== 0) {
  throw new Error('@blade-ai/agent/protocol should remain type-only at runtime');
}
`,
    );
    await run(process.execPath, [runtimeSmokePath], { cwd: consumerDir });
    await verifyPublishedTypesSmoke({ consumerDir });
    console.log(`[verify-published] temporary consumer smoke passed: ${npmInstallCommandLabel}`);
  } finally {
    await rm(consumerDir, { recursive: true, force: true });
  }
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
        noEmit: true,
      },
      include: ['consumer-types.ts'],
    }, null, 2),
  );
  await writeFile(
    join(consumerDir, 'consumer-types.ts'),
    `import type { ModelPort } from '@blade-ai/ai';
import type { ModelRequest } from '@blade-ai/ai';
import type { AgentKernelOptions } from '@blade-ai/agent';
import type { SessionOptions } from '@blade-ai/agent-sdk';
import type { StreamMessage } from '@blade-ai/agent-sdk';
import type { ToolDefinition } from '@blade-ai/agent-sdk';

const modelPort: ModelPort = {
  async generate(request: ModelRequest) {
    return {
      content: request.messages.at(-1)?.content?.toString() ?? '',
    };
  },
};

const kernelOptions: AgentKernelOptions = {
  model: modelPort,
  maxSteps: 2,
};

const sessionOptions: SessionOptions = {
  model: 'glm-5.2',
  provider: 'openai-compatible',
  allowedTools: [],
  temperature: 0.2,
  maxOutputTokens: 128,
};

const streamMessage: StreamMessage = {
  type: 'content',
  content: 'ok',
};

const toolDefinition: ToolDefinition = {
  name: 'noop',
  description: 'No-op tool',
  parameters: {
    type: 'object',
    properties: {},
  },
};

void kernelOptions;
void sessionOptions;
void streamMessage;
void toolDefinition;
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
  }
}

main().catch((error) => {
  console.error(`[verify-published] ${error.message}`);
  process.exitCode = 1;
});
