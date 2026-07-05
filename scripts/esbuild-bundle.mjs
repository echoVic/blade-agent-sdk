import { build as bundleWithEsbuild, stop as stopEsbuildService } from 'esbuild';

function isServiceStoppedError(error) {
  return error instanceof Error && (
    error.message.includes('The service was stopped')
    || error.message.includes('The service is no longer running')
  );
}

export async function bundleWithEsbuildRetry(options, config = {}) {
  const build = config.build ?? bundleWithEsbuild;
  const resetService = config.resetService ?? stopEsbuildService;
  const retries = config.retries ?? 2;
  let attempt = 0;

  resetService();
  while (true) {
    try {
      return await build(options);
    } catch (error) {
      if (attempt >= retries || !isServiceStoppedError(error)) {
        throw error;
      }
      attempt += 1;
      resetService();
      config.onRetry?.(error, attempt);
    }
  }
}
