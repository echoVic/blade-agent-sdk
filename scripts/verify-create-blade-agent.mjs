import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '..');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'create-blade-agent-'));
const launcherDirectory = join(temporaryRoot, 'launcher');
const filesOnlyDirectory = join(temporaryRoot, 'files-only-agent');
const projectDirectory = join(temporaryRoot, 'generated-agent');
const budgetMs = 5 * 60 * 1_000;
const startedAt = performance.now();

async function run(command, args, cwd, timeout = budgetMs) {
  try {
    return await execFileAsync(command, args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout,
    });
  } catch (error) {
    throw new Error(
      [
        `Command failed: ${command} ${args.join(' ')}`,
        error instanceof Error ? error.message : String(error),
        typeof error === 'object' && error !== null && 'stdout' in error
          ? String(error.stdout).trim()
          : '',
        typeof error === 'object' && error !== null && 'stderr' in error
          ? String(error.stderr).trim()
          : '',
      ].filter(Boolean).join('\n'),
    );
  }
}

try {
  const packed = JSON.parse(
    (
      await run(
        'npm',
        ['pack', '--json', '--pack-destination', temporaryRoot],
        repoRoot,
      )
    ).stdout,
  );
  const tarball = join(temporaryRoot, packed[0].filename);
  await mkdir(launcherDirectory);
  await writeFile(
    join(launcherDirectory, 'package.json'),
    '{"private":true,"type":"module"}\n',
  );
  await run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      tarball,
    ],
    launcherDirectory,
  );
  const expectedVersion = JSON.parse(
    await readFile(join(repoRoot, 'package.json'), 'utf8'),
  ).version;
  const installedVersion = (
    await run(
      'npm',
      ['exec', '--', 'create-blade-agent', '--version'],
      launcherDirectory,
    )
  ).stdout.trim();
  if (installedVersion !== expectedVersion) {
    throw new Error(
      `Installed create-blade-agent reported ${installedVersion}; expected ${expectedVersion}`,
    );
  }
  const filesOnly = await run(
    'npm',
    [
      'exec',
      '--',
      'create-blade-agent',
      filesOnlyDirectory,
      '--package-manager',
      'npm',
      '--sdk-version',
      `file:${tarball}`,
      '--skip-install',
    ],
    launcherDirectory,
  );
  if (
    !filesOnly.stdout.includes('npm install')
    || !filesOnly.stdout.includes('npm run start')
  ) {
    throw new Error(`Files-only next steps were incomplete:\n${filesOnly.stdout}`);
  }
  const remainingMs = Math.max(
    1,
    Math.floor(budgetMs - (performance.now() - startedAt)),
  );
  const result = await run(
    'npm',
    [
      'exec',
      '--',
      'create-blade-agent',
      projectDirectory,
      '--package-manager',
      'npm',
      '--sdk-version',
      `file:${tarball}`,
      '--verify',
    ],
    launcherDirectory,
    remainingMs,
  );

  const manifest = JSON.parse(
    await readFile(join(projectDirectory, 'package.json'), 'utf8'),
  );
  if (manifest.dependencies?.['@blade-ai/agent-sdk'] !== `file:${tarball}`) {
    throw new Error('Generated project did not use the requested SDK package');
  }
  for (const path of [
    'compose.yaml',
    'README.md',
    'src/server.mjs',
    'src/QueuedSessionExecutor.mjs',
    'src/DockerPromptRunner.mjs',
    'web/index.html',
    'web/client.js',
  ]) {
    await readFile(join(projectDirectory, path));
  }
  if (!result.stdout.includes('Docker worker received: single-command production path')) {
    throw new Error(`Generated smoke output was incomplete:\n${result.stdout}`);
  }
  await run(
    'npm',
    ['audit', '--omit=dev', '--audit-level', 'low'],
    projectDirectory,
  );
  const elapsedMs = Math.round((performance.now() - startedAt) * 100) / 100;
  if (elapsedMs > budgetMs) {
    throw new Error(`Generated first result took ${elapsedMs}ms; budget is ${budgetMs}ms`);
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        status: 'ok',
        elapsedMs,
        budgetMs,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
