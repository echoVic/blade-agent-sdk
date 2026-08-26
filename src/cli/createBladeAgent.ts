import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DIRECTORY = 'blade-agent';
const FIRST_SUCCESS_BUDGET_MS = 5 * 60 * 1_000;
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export type CreateBladeAgentPackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface CreateBladeAgentOptions {
  readonly directory?: string;
  readonly cwd?: string;
  readonly packageManager?: CreateBladeAgentPackageManager;
  readonly sdkSpecifier?: string;
  readonly skipInstall?: boolean;
  readonly verify?: boolean;
}

export interface CreateBladeAgentResult {
  readonly directory: string;
  readonly packageManager: CreateBladeAgentPackageManager;
  readonly installed: boolean;
  readonly verified: boolean;
  readonly elapsedMs: number;
}

interface PackageManifest {
  readonly version: string;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

interface ProcessOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
}

function remainingFirstSuccessBudget(startedAt: number): number {
  const remainingMs = Math.floor(FIRST_SUCCESS_BUDGET_MS - (performance.now() - startedAt));
  if (remainingMs <= 0) {
    throw new Error('Project setup exceeded the five-minute first-success budget');
  }
  return remainingMs;
}

function detectPackageManager(
  userAgent = process.env.npm_config_user_agent,
): CreateBladeAgentPackageManager {
  const name = userAgent?.split('/')[0];
  return name === 'pnpm' || name === 'yarn' || name === 'bun' ? name : 'npm';
}

function packageName(directory: string): string {
  const normalized = basename(directory)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');
  return normalized || DEFAULT_DIRECTORY;
}

async function assertEmptyDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const entries = await readdir(directory);
  if (entries.length > 0) {
    throw new Error(`Target directory is not empty: ${directory}`);
  }
}

function commandFor(
  packageManager: CreateBladeAgentPackageManager,
  script?: 'smoke',
): readonly [string, readonly string[]] {
  if (!script) {
    return [packageManager, ['install']];
  }
  if (packageManager === 'yarn') {
    return [packageManager, [script]];
  }
  return [packageManager, ['run', script]];
}

async function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessOptions,
): Promise<void> {
  const signal =
    options.timeoutMs === undefined
      ? undefined
      : AbortSignal.timeout(Math.max(1, options.timeoutMs));
  await new Promise<void>((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: 'inherit',
      ...(signal ? { signal } : {}),
    });
    child.once('error', rejectProcess);
    child.once('exit', (code, childSignal) => {
      if (code === 0) {
        resolveProcess();
        return;
      }
      rejectProcess(
        new Error(
          `${command} ${args.join(' ')} exited with ${
            childSignal ? `signal ${childSignal}` : `code ${code ?? 'unknown'}`
          }`,
        ),
      );
    });
  });
}

async function readManifest(): Promise<PackageManifest> {
  return JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as PackageManifest;
}

export async function getBladeAgentSdkVersion(): Promise<string> {
  return (await readManifest()).version;
}

async function copyTemplate(directory: string): Promise<void> {
  const sourceRoot = join(PACKAGE_ROOT, 'examples');
  const files = [
    {
      source: 'production-stack/QueuedSessionExecutor.mjs',
      target: 'src/QueuedSessionExecutor.mjs',
    },
    {
      source: 'production-stack/DockerPromptRunner.mjs',
      target: 'src/DockerPromptRunner.mjs',
    },
    {
      source: 'production-stack/compose.yaml',
      target: 'compose.yaml',
    },
    {
      source: 'web-agent-server/index.html',
      target: 'web/index.html',
    },
    {
      source: 'web-agent-server/client.js',
      target: 'web/client.js',
    },
  ] as const;

  for (const file of files) {
    const target = join(directory, file.target);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(join(sourceRoot, file.source)));
  }

  const runnerSource = await readFile(join(sourceRoot, 'production-stack/run.mjs'), 'utf8');
  for (const marker of [
    "const webRoot = join(root, '../web-agent-server');",
    "const composeFile = join(root, 'compose.yaml');",
  ]) {
    if (!runnerSource.includes(marker)) {
      throw new Error(`Production template marker is missing: ${marker}`);
    }
  }
  const runner = runnerSource
    .replace(
      "const webRoot = join(root, '../web-agent-server');",
      "const webRoot = join(root, '../web');",
    )
    .replace(
      "const composeFile = join(root, 'compose.yaml');",
      "const composeFile = join(root, '../compose.yaml');",
    );
  await writeFile(join(directory, 'src/server.mjs'), runner);
}

function readDependency(
  dependencies: Readonly<Record<string, string>> | undefined,
  name: string,
): string {
  const version = dependencies?.[name];
  if (!version) {
    throw new Error(`Package manifest does not declare ${name}`);
  }
  return version;
}

function readme(name: string, packageManager: CreateBladeAgentPackageManager): string {
  const run = packageManager === 'yarn' ? 'yarn' : `${packageManager} run`;
  return `# ${name}

Generated by \`create-blade-agent\`.

Requires Node.js 22.14 or later and Docker with the Compose plugin.

## Run

\`\`\`bash
${run} start
\`\`\`

Open the printed URL and send a prompt. The request traverses:

\`\`\`text
Browser AgentClient
→ AgentServer
→ PostgreSQL route queue
→ AgentWorker
→ DockerExecutionHost
→ PostgreSQL event log
→ SSE
\`\`\`

Run the non-interactive five-minute acceptance check with:

\`\`\`bash
${run} smoke
\`\`\`

Runtime probes are available at \`/v1/runtime/healthz\`,
\`/v1/runtime/readyz\`, and \`/v1/runtime/metrics\`. The metrics endpoint uses
\`Authorization: Bearer local-demo\`.

This scaffold is configured for local evaluation. Replace the demo
authentication callbacks and PostgreSQL credentials before exposing it on a
network.
`;
}

export async function createBladeAgent(
  options: CreateBladeAgentOptions = {},
): Promise<CreateBladeAgentResult> {
  if (options.skipInstall && options.verify) {
    throw new Error('--verify cannot be combined with --skip-install');
  }
  const startedAt = performance.now();
  const cwd = resolve(options.cwd ?? process.cwd());
  const directory = resolve(cwd, options.directory ?? DEFAULT_DIRECTORY);
  const packageManager = options.packageManager ?? detectPackageManager();
  const manifest = await readManifest();
  const sdkSpecifier = options.sdkSpecifier ?? manifest.version;
  if (!sdkSpecifier.trim()) {
    throw new TypeError('sdkSpecifier must not be empty');
  }

  await assertEmptyDirectory(directory);
  await copyTemplate(directory);
  const name = packageName(directory);
  await writeFile(
    join(directory, 'package.json'),
    `${JSON.stringify(
      {
        name,
        version: '0.1.0',
        private: true,
        type: 'module',
        engines: {
          node: '>=22.14.0',
        },
        scripts: {
          start: 'node src/server.mjs',
          smoke: 'node src/server.mjs --smoke',
        },
        dependencies: {
          '@blade-ai/agent-sdk': sdkSpecifier,
          esbuild: readDependency(manifest.devDependencies, 'esbuild'),
          pg: readDependency(manifest.peerDependencies, 'pg'),
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(directory, '.gitignore'), 'node_modules/\n.generated/\n.env\n*.log\n');
  await writeFile(join(directory, 'README.md'), readme(name, packageManager));

  if (!options.skipInstall) {
    const [command, args] = commandFor(packageManager);
    await runProcess(command, args, {
      cwd: directory,
      ...(options.verify
        ? { timeoutMs: remainingFirstSuccessBudget(startedAt) }
        : {}),
    });
  }
  if (options.verify) {
    const [command, args] = commandFor(packageManager, 'smoke');
    await runProcess(command, args, {
      cwd: directory,
      timeoutMs: remainingFirstSuccessBudget(startedAt),
    });
  }

  return {
    directory,
    packageManager,
    installed: !options.skipInstall,
    verified: options.verify ?? false,
    elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
  };
}
