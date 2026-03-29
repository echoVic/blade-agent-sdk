import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * Build the env object for `pnpm publish`.
 *
 * Auth resolution order:
 *   1. NPM_TOKEN        – set explicitly (common in CI secrets / local .zshrc)
 *   2. NODE_AUTH_TOKEN  – written by actions/setup-node in GitHub Actions
 *
 * When a token is found we write a throwaway .npmrc into the npm cache dir and
 * point NPM_CONFIG_USERCONFIG at it.  This is more portable than env-var key
 * names that contain slashes (e.g. NPM_CONFIG_//registry…).
 */
export function getPublishEnv(cacheDir, env = process.env) {
  const token = env.NPM_TOKEN || env.NODE_AUTH_TOKEN;

  const result = {
    ...env,
    NPM_CONFIG_CACHE: env.NPM_CONFIG_CACHE || cacheDir,
  };

  if (token) {
    mkdirSync(cacheDir, { recursive: true });
    const npmrcPath = join(cacheDir, 'publish.npmrc');
    writeFileSync(
      npmrcPath,
      `//registry.npmjs.org/:_authToken=${token}\n`,
      { mode: 0o600 }
    );
    result.NPM_CONFIG_USERCONFIG = npmrcPath;
  }

  return result;
}

function normalizeCommandOutput(output) {
  if (typeof output === 'string') {
    return output.trim();
  }
  if (Buffer.isBuffer(output)) {
    return output.toString('utf8').trim();
  }
  return '';
}

export function buildCommandFailureMessage(command, error) {
  const message =
    typeof error?.message === 'string'
      ? error.message
      : error instanceof Error
        ? error.message
        : `Command failed: ${command}`;
  const stderr = normalizeCommandOutput(error?.stderr);
  const stdout = normalizeCommandOutput(error?.stdout);

  const details = [stderr, stdout].filter(Boolean).join('\n');
  if (!details) {
    return message;
  }

  return `${message}\n${details}`;
}
