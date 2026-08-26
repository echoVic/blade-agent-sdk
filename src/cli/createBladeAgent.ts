import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DIRECTORY = 'blade-agent';
const DEFAULT_PRESET: CreateBladeAgentPreset = 'production';
const FIRST_SUCCESS_BUDGET_MS: Readonly<Record<CreateBladeAgentPreset, number>> = {
  local: 60 * 1_000,
  web: 2 * 60 * 1_000,
  production: 5 * 60 * 1_000,
};
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export type CreateBladeAgentPackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';
export type CreateBladeAgentPreset = 'local' | 'web' | 'production';

export interface CreateBladeAgentOptions {
  readonly directory?: string;
  readonly cwd?: string;
  readonly packageManager?: CreateBladeAgentPackageManager;
  readonly preset?: CreateBladeAgentPreset;
  readonly sdkSpecifier?: string;
  readonly skipInstall?: boolean;
  readonly verify?: boolean;
}

export interface CreateBladeAgentResult {
  readonly directory: string;
  readonly packageManager: CreateBladeAgentPackageManager;
  readonly preset: CreateBladeAgentPreset;
  readonly installed: boolean;
  readonly verified: boolean;
  readonly budgetMs: number;
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

function remainingFirstSuccessBudget(startedAt: number, preset: CreateBladeAgentPreset): number {
  const budgetMs = FIRST_SUCCESS_BUDGET_MS[preset];
  const remainingMs = Math.floor(budgetMs - (performance.now() - startedAt));
  if (remainingMs <= 0) {
    throw new Error(`${preset} project setup exceeded its ${budgetMs}ms first-success budget`);
  }
  return remainingMs;
}

function detectPackageManager(
  userAgent = process.env.npm_config_user_agent,
): CreateBladeAgentPackageManager {
  const name = userAgent?.split('/')[0];
  return name === 'pnpm' || name === 'yarn' || name === 'bun' ? name : 'npm';
}

function resolvePreset(preset: CreateBladeAgentPreset | undefined): CreateBladeAgentPreset {
  const value = preset ?? DEFAULT_PRESET;
  if (value === 'local' || value === 'web' || value === 'production') {
    return value;
  }
  throw new TypeError(`Unsupported starter preset: ${String(value)}`);
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

async function copyFile(sourceRoot: string, directory: string, source: string, target: string) {
  const destination = join(directory, target);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, await readFile(join(sourceRoot, source)));
}

async function copyProductionTemplate(sourceRoot: string, directory: string): Promise<void> {
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
    await copyFile(sourceRoot, directory, file.source, file.target);
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

async function copyWebTemplate(sourceRoot: string, directory: string): Promise<void> {
  for (const file of [
    ['web-agent-server/index.html', 'web/index.html'],
    ['web-agent-server/client.js', 'web/client.js'],
  ] as const) {
    await copyFile(sourceRoot, directory, file[0], file[1]);
  }
  const serverSource = await readFile(join(sourceRoot, 'web-agent-server/server.mjs'), 'utf8');
  for (const marker of ['const webRoot = root;', "const generated = join(root, '.generated');"]) {
    if (!serverSource.includes(marker)) {
      throw new Error(`Web template marker is missing: ${marker}`);
    }
  }
  const server = serverSource
    .replace('const webRoot = root;', "const webRoot = join(root, '../web');")
    .replace(
      "const generated = join(root, '.generated');",
      "const generated = join(root, '../.generated');",
    );
  await mkdir(join(directory, 'src'), { recursive: true });
  await writeFile(join(directory, 'src/server.mjs'), server);
}

async function copyTemplate(directory: string, preset: CreateBladeAgentPreset): Promise<void> {
  const sourceRoot = join(PACKAGE_ROOT, 'examples');
  if (preset === 'local') {
    const localSource = await readFile(
      join(sourceRoot, 'local-cli-agent/index.mjs'),
      'utf8',
    );
    const marker = 'const persistSession = true;';
    if (!localSource.includes(marker)) {
      throw new Error(`Local template marker is missing: ${marker}`);
    }
    await mkdir(join(directory, 'src'), { recursive: true });
    await writeFile(
      join(directory, 'src/index.mjs'),
      localSource.replace(marker, 'const persistSession = false;'),
    );
    return;
  }
  if (preset === 'web') {
    await copyWebTemplate(sourceRoot, directory);
    return;
  }
  await copyProductionTemplate(sourceRoot, directory);
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

function scripts(preset: CreateBladeAgentPreset): Readonly<Record<string, string>> {
  if (preset === 'local') {
    return {
      start: 'node src/index.mjs',
      smoke: 'node src/index.mjs --smoke',
    };
  }
  return {
    start: 'node src/server.mjs',
    smoke: 'node src/server.mjs --smoke',
  };
}

function dependencies(
  preset: CreateBladeAgentPreset,
  manifest: PackageManifest,
  sdkSpecifier: string,
): Readonly<Record<string, string>> {
  return {
    '@blade-ai/agent-sdk': sdkSpecifier,
    ...(preset === 'web' || preset === 'production'
      ? { esbuild: readDependency(manifest.devDependencies, 'esbuild') }
      : {}),
    ...(preset === 'production' ? { pg: readDependency(manifest.peerDependencies, 'pg') } : {}),
  };
}

function localReadme(name: string, run: string): string {
  return `# ${name}

Generated by \`create-blade-agent --preset local\`.

Requires Node.js 22.14 or later. Run with OpenAI:

\`\`\`bash
OPENAI_API_KEY=... ${run} start -- "Summarize this repository"
\`\`\`

Run the offline first-result check:

\`\`\`bash
${run} smoke
\`\`\`

This preset uses \`@blade-ai/agent-sdk/node\` with an in-memory Session and no
PostgreSQL or Docker. Move to the \`web\` or \`production\` preset when the
Agent must serve remote clients.
`;
}

function webReadme(name: string, run: string): string {
  return `# ${name}

Generated by \`create-blade-agent --preset web\`.

Requires Node.js 22.14 or later.

## Run

\`\`\`bash
${run} start
\`\`\`

Open the printed URL and send a prompt. Without \`OPENAI_API_KEY\`, the server
uses a deterministic local provider. Set \`OPENAI_API_KEY\` and optionally
\`OPENAI_MODEL\` to use OpenAI.

Run the non-interactive two-minute acceptance check with:

\`\`\`bash
${run} smoke
\`\`\`

The request traverses:

\`\`\`text
Browser AgentClient
→ AgentServer
→ in-process Session
→ SSE
\`\`\`

This scaffold is for local development. Replace the demo authentication
callback before exposing it on a network.
`;
}

function productionReadme(name: string, run: string): string {
  return `# ${name}

Generated by \`create-blade-agent --preset production\`.

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

function readme(
  name: string,
  packageManager: CreateBladeAgentPackageManager,
  preset: CreateBladeAgentPreset,
): string {
  const run = packageManager === 'yarn' ? 'yarn' : `${packageManager} run`;
  if (preset === 'local') {
    return localReadme(name, run);
  }
  if (preset === 'web') {
    return webReadme(name, run);
  }
  return productionReadme(name, run);
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
  const preset = resolvePreset(options.preset);
  const manifest = await readManifest();
  const sdkSpecifier = options.sdkSpecifier ?? manifest.version;
  if (!sdkSpecifier.trim()) {
    throw new TypeError('sdkSpecifier must not be empty');
  }

  await assertEmptyDirectory(directory);
  await copyTemplate(directory, preset);
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
        scripts: scripts(preset),
        dependencies: dependencies(preset, manifest, sdkSpecifier),
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(directory, '.gitignore'),
    'node_modules/\n.data/\n.generated/\n.env\n*.log\n',
  );
  await writeFile(join(directory, 'README.md'), readme(name, packageManager, preset));

  if (!options.skipInstall) {
    const [command, args] = commandFor(packageManager);
    await runProcess(command, args, {
      cwd: directory,
      ...(options.verify ? { timeoutMs: remainingFirstSuccessBudget(startedAt, preset) } : {}),
    });
  }
  if (options.verify) {
    const [command, args] = commandFor(packageManager, 'smoke');
    await runProcess(command, args, {
      cwd: directory,
      timeoutMs: remainingFirstSuccessBudget(startedAt, preset),
    });
  }

  return {
    directory,
    packageManager,
    preset,
    installed: !options.skipInstall,
    verified: options.verify ?? false,
    budgetMs: FIRST_SUCCESS_BUDGET_MS[preset],
    elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
  };
}
