import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const temporaryRoot = mkdtempSync(
  join(tmpdir(), 'blade-minimal-install-'),
);

function run(command, args, cwd = repoRoot) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `Command failed: ${command} ${args.join(' ')}`,
        result.stdout.trim(),
        result.stderr.trim(),
      ].filter(Boolean).join('\n'),
    );
  }
  return result.stdout.trim();
}

try {
  const packed = JSON.parse(
    run('npm', ['pack', '--json', '--pack-destination', temporaryRoot]),
  );
  const tarball = join(temporaryRoot, packed[0].filename);
  const consumer = join(temporaryRoot, 'consumer');
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
  );
  run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      tarball,
    ],
    consumer,
  );

  const output = run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      [
        "const root = await import('@blade-ai/agent-sdk');",
        "const server = await import('@blade-ai/agent-sdk/server');",
        "const node = await import('@blade-ai/agent-sdk/node');",
        "console.log(typeof root.createSession, typeof server.AgentWorker, typeof node.DockerExecutionHost);",
        "try { await root.createSession({ provider: { type: 'anthropic', apiKey: 'test' }, model: 'test', persistSession: false }); } catch (error) { console.log(error.message); }",
      ].join(' '),
    ],
    consumer,
  );
  if (
    !output.startsWith('function function function\n')
    || !output.includes(
      'Built-in provider "anthropic" requires the optional package "@ai-sdk/anthropic"',
    )
  ) {
    throw new Error(`Unexpected minimal import result: ${output}`);
  }

  for (const packageName of [
    'pg',
    'koffi',
    'fs-native-extensions',
    '@vscode/ripgrep',
    '@ai-sdk/anthropic',
    '@ai-sdk/azure',
    '@ai-sdk/deepseek',
    '@ai-sdk/google',
    'node-pty',
  ]) {
    if (existsSync(join(consumer, 'node_modules', ...packageName.split('/')))) {
      throw new Error(`Minimal install unexpectedly included ${packageName}`);
    }
  }

  const manifest = JSON.parse(
    readFileSync(
      join(consumer, 'node_modules/@blade-ai/agent-sdk/package.json'),
      'utf8',
    ),
  );
  for (const packageName of [
    'pg',
    'koffi',
    'fs-native-extensions',
    '@vscode/ripgrep',
    '@opentelemetry/api',
    '@ai-sdk/anthropic',
    '@ai-sdk/azure',
    '@ai-sdk/deepseek',
    '@ai-sdk/google',
  ]) {
    if (
      manifest.dependencies?.[packageName]
      || manifest.optionalDependencies?.[packageName]
      || !manifest.peerDependenciesMeta?.[packageName]?.optional
    ) {
      throw new Error(`${packageName} must remain an optional peer`);
    }
  }
  if (
    manifest.dependencies?.['node-pty']
    || manifest.optionalDependencies?.['node-pty']
    || manifest.peerDependencies?.['node-pty']
  ) {
    throw new Error('node-pty must not be part of the published dependency graph');
  }
  process.stdout.write('minimal install verification passed\n');
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
