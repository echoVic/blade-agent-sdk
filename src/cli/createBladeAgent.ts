import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DIRECTORY = 'blade-agent';
const DEFAULT_PRESET: CreateBladeAgentPreset = 'local';
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
  readonly dependencies?: Readonly<Record<string, string>>;
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
  script?: 'smoke' | 'start',
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

export async function startBladeAgent(
  project: Pick<CreateBladeAgentResult, 'directory' | 'packageManager'>,
): Promise<void> {
  const [command, args] = commandFor(project.packageManager, 'start');
  await runProcess(command, args, { cwd: project.directory });
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
    ...[
      'RepositoryState.mjs',
      'RepositoryTools.mjs',
      'RepositoryDemoProvider.mjs',
      'RepositorySessionRunner.mjs',
      'RepositoryRecovery.mjs',
      'RepositoryReconcile.mjs',
      'RepositoryTerminalOutcome.mjs',
      'worker.mjs',
      'smoke.mjs',
      'fixture/src/greeting.sh',
      'fixture/test/greeting.test.sh',
    ].map((file) => ({ source: `production-stack/${file}`, target: `src/${file}` })),
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
    ['web-agent-server/DemoProvider.mjs', 'src/DemoProvider.mjs'],
    ['web-agent-server/smoke.mjs', 'src/smoke.mjs'],
  ] as const) {
    await copyFile(sourceRoot, directory, file[0], file[1]);
  }
  const serverSource = await readFile(join(sourceRoot, 'web-agent-server/server.mjs'), 'utf8');
  for (const marker of ['const webRoot = root;', 'const projectRoot = root;']) {
    if (!serverSource.includes(marker)) {
      throw new Error(`Web template marker is missing: ${marker}`);
    }
  }
  const server = serverSource
    .replace('const webRoot = root;', "const webRoot = join(root, '../web');")
    .replace('const projectRoot = root;', "const projectRoot = join(root, '..');");
  await writeFile(join(directory, 'src/server.mjs'), server);
  await writeFile(
    join(directory, '.env.example'),
    'OPENAI_API_KEY=\nOPENAI_MODEL=gpt-5-mini\nOPENAI_BASE_URL=\n',
  );
}

async function copyTemplate(directory: string, preset: CreateBladeAgentPreset): Promise<void> {
  const sourceRoot = join(PACKAGE_ROOT, 'examples');
  if (preset === 'local') {
    const localSource = await readFile(join(sourceRoot, 'local-cli-agent/index.mjs'), 'utf8');
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
    ...(preset === 'web' ? { open: readDependency(manifest.dependencies, 'open') } : {}),
    // JsonlSessionRepository uses a cross-process advisory file lock that requires this
    // native module; it is only an optional SDK peer because most hosts do not persist
    // Sessions to JSONL, but the web starter always does.
    ...(preset === 'web'
      ? {
          'fs-native-extensions': readDependency(manifest.peerDependencies, 'fs-native-extensions'),
        }
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

This preset uses \`@blade-ai/agent-sdk/advanced\` with an in-memory Session and no
PostgreSQL or Docker. Move to the \`web\` or \`production\` preset when the
Agent must serve remote clients.
`;
}

function webReadme(name: string, run: string): string {
  return `# ${name}

Generated by \`create-blade-agent --preset web\`. Requires Node.js 22.14 or later.

## First run

\`\`\`bash
${run} start
\`\`\`

The server asks once for an OpenAI-compatible API key (press Enter to run the
built-in scripted demo instead), saves it to \`.env\`, and opens the browser.
Then:

1. Ask: **Analyze this project's dependency risks**. Watch the Agent think, run
   Glob, Read and Bash, and stream a report.
2. While it is working, type **Focus on security issues** and press Enter. The
   instruction is inserted with priority \`now\`. If Bash is mid-command when it
   lands, that command is genuinely interrupted: the Agent retries it once,
   then runs a security scan and says in its report that the check was
   interrupted and retried.
3. Stop the server with Ctrl+C, run \`${run} start\` again, refresh the page and
   ask **Continue the analysis**. The session, its history and event cursor
   come back from disk.

Every tool card shows the exact arguments the Agent passed it — the glob
pattern, the file path, the shell command — so the card is evidence of what
actually ran, not just a status dot. Keep that in mind before you screen-share
this page.

## Configuration

| Setting | Meaning |
|---|---|
| \`OPENAI_API_KEY\` | Enables a real model. Without it the scripted demo runs the same tools. |
| \`OPENAI_BASE_URL\` | Any OpenAI-compatible endpoint (DeepSeek, Qwen, GLM, local servers). |
| \`OPENAI_MODEL\` | Model id, default \`gpt-5-mini\`. |
| \`--root <dir>\` | Analyze another repository: \`${run} start -- --root ../my-app\`. |
| \`--data-dir <dir>\` | Where sessions live, default \`.blade/\`. |
| \`--no-open\` | Do not open the browser. |

Tools: Read, Glob, Grep and Bash, scoped to the workspace root. A server-hosted
Session does not register these by default; \`src/server.mjs\` opts in with
\`builtinTools: true\` and scopes them with \`allowedTools\`, \`permissions\`,
\`sandbox\` and \`defaultContext.capabilities.filesystem\`. When an OS sandbox is
available (macOS seatbelt, Linux bubblewrap) Bash runs inside it and is
auto-approved; otherwise every command appears as an approval card in the
browser. Destructive commands always ask.

Persistence: \`.blade/server/server-store.jsonl\` (session records, event log,
approvals) and \`.blade/sessions/\` (transcripts). Delete \`.blade/\` to start
clean.

## Acceptance check

\`\`\`bash
${run} smoke
\`\`\`

Runs the nine steps above non-interactively with the scripted demo in under two
minutes: tools, mid-run steering that interrupts and retries a shell command, a
simulated restart and a continued session.

The request traverses:

\`\`\`text
Browser AgentClient
→ AgentServer (JsonlAgentServerStore)
→ in-process Session (JsonlSessionRepository)
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

Open the printed URL and ask: "Fix the greeting to say Hello, Blade! and run the tests."
Review the proposed file change and choose **Approve once** or **Deny**.
The Agent reads and edits a disposable Git repository and runs its shell tests
inside Docker. The request traverses:

\`\`\`text
Browser AgentClient
→ AgentServer
→ PostgreSQL route queue
→ AgentWorker + SDK Session
→ Docker repository tools
→ PostgreSQL event log
→ SSE
\`\`\`

Run the non-interactive five-minute acceptance check with:

\`\`\`bash
${run} smoke
\`\`\`

Without an API key, a deterministic model adapter exercises the same real tool
loop. Set \`OPENAI_API_KEY\` and optionally \`OPENAI_MODEL\` for model-driven tasks.
The smoke always uses the deterministic adapter and checks write approval,
SIGKILL recovery after a saved edit, SSE reconnection, a second turn, denial,
and cancellation.

This fixture permits reading two files, editing \`src/greeting.sh\`, and running a
fixed test command. Extend \`RepositoryTools.mjs\` to support your repository.
Changes live in isolated Docker workspaces; checkpoints, transcripts and
approvals survive Worker restarts during this run. Stopping the launcher removes
its temporary PostgreSQL data and checkpoints. This is a single API process
example, not an API failover or arbitrary tool exactly-once guarantee.
Unknown interrupted test outcomes require reconciliation before retry.

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
    'node_modules/\n.blade/\n.data/\n.generated/\n.env\n*.log\n',
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
