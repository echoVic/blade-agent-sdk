import { execFile } from 'node:child_process';
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

async function run(command, args) {
  const { stdout } = await execFileAsync(command, args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
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

  return releaseUrl;
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
