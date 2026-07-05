import { build as bundleWithEsbuild } from 'esbuild';

function isServiceStoppedError(error) {
  return error instanceof Error && (
    error.message.includes('The service was stopped')
    || error.message.includes('The service is no longer running')
  );
}

export async function bundleWithEsbuildRetry(options, config = {}) {
  const build = config.build ?? bundleWithEsbuild;
  const retries = config.retries ?? 1;
  let attempt = 0;

  while (true) {
    try {
      return await build(options);
    } catch (error) {
      if (attempt >= retries || !isServiceStoppedError(error)) {
        throw error;
      }
      attempt += 1;
      config.onRetry?.(error, attempt);
    }
  }
}
