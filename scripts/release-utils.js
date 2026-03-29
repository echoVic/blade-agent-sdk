export function getPublishEnv(defaultCacheDir, env = process.env) {
  return {
    ...env,
    NPM_CONFIG_CACHE: env.NPM_CONFIG_CACHE || defaultCacheDir,
  };
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
