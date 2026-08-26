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
const presetContracts = {
  local: {
    budgetMs: 60 * 1_000,
    expectedOutput: 'Local Agent received: minimal local starter smoke',
    files: ['README.md', 'src/index.mjs'],
    dependencies: ['@blade-ai/agent-sdk'],
  },
  web: {
    budgetMs: 2 * 60 * 1_000,
    expectedOutput: 'AgentServer received: minimal web starter smoke',
    files: ['README.md', 'src/server.mjs', 'web/index.html', 'web/client.js'],
    dependencies: ['@blade-ai/agent-sdk', 'esbuild'],
  },
  production: {
    budgetMs: 5 * 60 * 1_000,
    expectedOutput: 'Docker worker received: single-command production path',
    files: [
      'compose.yaml',
      'README.md',
      'src/server.mjs',
      'src/QueuedSessionExecutor.mjs',
      'src/DockerPromptRunner.mjs',
      'web/index.html',
      'web/client.js',
    ],
    dependencies: ['@blade-ai/agent-sdk', 'esbuild', 'pg'],
  },
};

async function run(command, args, cwd, timeout = 5 * 60 * 1_000) {
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

async function verifyProject(directory, preset, tarball) {
  const contract = presetContracts[preset];
  const manifest = JSON.parse(
    await readFile(join(directory, 'package.json'), 'utf8'),
  );
  if (manifest.dependencies?.['@blade-ai/agent-sdk'] !== `file:${tarball}`) {
    throw new Error(`${preset} project did not use the requested SDK package`);
  }
  const dependencyNames = Object.keys(manifest.dependencies ?? {}).sort();
  if (JSON.stringify(dependencyNames) !== JSON.stringify(contract.dependencies)) {
    throw new Error(
      `${preset} dependencies were ${JSON.stringify(dependencyNames)}; `
      + `expected ${JSON.stringify(contract.dependencies)}`,
    );
  }
  for (const path of contract.files) {
    await readFile(join(directory, path));
  }
}

async function verifyPreset(preset, tarball) {
  const contract = presetContracts[preset];
  const directory = join(temporaryRoot, `${preset}-agent`);
  const startedAt = performance.now();
  const result = await run(
    'npm',
    [
      'exec',
      '--',
      'create-blade-agent',
      directory,
      '--preset',
      preset,
      '--package-manager',
      'npm',
      '--sdk-version',
      `file:${tarball}`,
      '--verify',
    ],
    launcherDirectory,
    contract.budgetMs + 15_000,
  );
  const elapsedMs = Math.round((performance.now() - startedAt) * 100) / 100;
  if (elapsedMs > contract.budgetMs) {
    throw new Error(
      `${preset} first result took ${elapsedMs}ms; budget is ${contract.budgetMs}ms`,
    );
  }
  if (
    !result.stdout.includes(contract.expectedOutput)
    || !result.stdout.includes(`Verified ${preset} first result`)
  ) {
    throw new Error(`${preset} smoke output was incomplete:\n${result.stdout}`);
  }
  await verifyProject(directory, preset, tarball);
  await run(
    'npm',
    ['audit', '--omit=dev', '--audit-level', 'low'],
    directory,
  );
  return {
    preset,
    elapsedMs,
    budgetMs: contract.budgetMs,
  };
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
  const help = (
    await run(
      'npm',
      ['exec', '--', 'create-blade-agent', '--help'],
      launcherDirectory,
    )
  ).stdout;
  if (!help.includes('--preset <local|web|production>')) {
    throw new Error(`Installed CLI help did not document presets:\n${help}`);
  }
  let unsupportedPresetError;
  try {
    await run(
      'npm',
      [
        'exec',
        '--',
        'create-blade-agent',
        '--preset',
        'edge',
        '--skip-install',
      ],
      launcherDirectory,
    );
  } catch (error) {
    unsupportedPresetError = error;
  }
  if (
    !(unsupportedPresetError instanceof Error)
    || !unsupportedPresetError.message.includes('Unsupported starter preset: edge')
  ) {
    throw new Error('Installed CLI accepted an unsupported starter preset');
  }

  const filesOnlyDirectory = join(temporaryRoot, 'files-only-agent');
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
  await verifyProject(filesOnlyDirectory, 'production', tarball);

  const results = [];
  for (const preset of ['local', 'web', 'production']) {
    results.push(await verifyPreset(preset, tarball));
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        status: 'ok',
        presets: results,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
