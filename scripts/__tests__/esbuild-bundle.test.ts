import { describe, expect, it } from 'vitest';

describe('esbuild bundle helper', () => {
  it('retries once when the esbuild service stops', async () => {
    const { bundleWithEsbuildRetry } = await import('../esbuild-bundle.mjs');
    const calls: unknown[] = [];

    await bundleWithEsbuildRetry({ entryPoints: ['entry.ts'] }, {
      build: async (options: unknown) => {
        calls.push(options);
        if (calls.length === 1) {
          throw new Error('The service was stopped');
        }
        return { outputFiles: [] };
      },
    });

    expect(calls).toHaveLength(2);
  });

  it('retries once when the esbuild service is no longer running', async () => {
    const { bundleWithEsbuildRetry } = await import('../esbuild-bundle.mjs');
    const calls: unknown[] = [];

    await bundleWithEsbuildRetry({ entryPoints: ['entry.ts'] }, {
      build: async (options: unknown) => {
        calls.push(options);
        if (calls.length === 1) {
          throw new Error('The service is no longer running');
        }
        return { outputFiles: [] };
      },
    });

    expect(calls).toHaveLength(2);
  });

  it('does not retry unrelated esbuild errors', async () => {
    const { bundleWithEsbuildRetry } = await import('../esbuild-bundle.mjs');
    const calls: unknown[] = [];

    await expect(bundleWithEsbuildRetry({ entryPoints: ['entry.ts'] }, {
      build: async (options: unknown) => {
        calls.push(options);
        throw new Error('Could not resolve entry.ts');
      },
    })).rejects.toThrow('Could not resolve entry.ts');

    expect(calls).toHaveLength(1);
  });
});
