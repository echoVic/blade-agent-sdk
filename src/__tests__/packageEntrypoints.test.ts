import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(readFileSync('package.json', 'utf-8')) as {
  exports: Record<string, unknown>;
  scripts: Record<string, string>;
};

describe('package entrypoints', () => {
  it('declares server-first root and explicit subpath exports', () => {
    expect(packageJson.exports).toMatchObject({
      '.': {
        types: './dist/index.d.ts',
        browser: './dist/browser/index.js',
        import: './dist/index.js',
      },
      './core': {
        types: './dist/core/index.d.ts',
        import: './dist/core/index.js',
      },
      './browser': {
        types: './dist/browser/index.d.ts',
        import: './dist/browser/index.js',
      },
      './server': {
        types: './dist/server/index.d.ts',
        browser: './dist/browser/server-only-stub.js',
        import: './dist/server/index.js',
      },
      './session': {
        types: './dist/session/index.d.ts',
        browser: './dist/browser/server-only-stub.js',
        import: './dist/session/index.js',
      },
      './tools': {
        types: './dist/tools/index.d.ts',
        import: './dist/tools/index.js',
      },
      './local': {
        types: './dist/local/index.d.ts',
        browser: './dist/browser/server-only-stub.js',
        import: './dist/local/index.js',
      },
    });
  });

  it('has source modules for every public subpath entry', () => {
    for (const file of [
      'src/core/index.ts',
      'src/browser/index.ts',
      'src/browser/server-only-stub.ts',
      'src/server/index.ts',
      'src/tools/index.ts',
      'src/local/index.ts',
      'src/session/index.ts',
    ]) {
      expect(existsSync(join(process.cwd(), file)), file).toBe(true);
    }
  });

  it('declares the browser/server entrypoint verification script', () => {
    expect(packageJson.scripts['verify:entrypoints']).toBe(
      'pnpm run build && pnpm --filter @blade-ai/agent-sdk run build && node scripts/verify-entrypoints.mjs',
    );
    expect(existsSync(join(process.cwd(), 'scripts/verify-entrypoints.mjs'))).toBe(true);
  });

  it('runs the browser bundle check through the esbuild JS API', () => {
    const verifier = readFileSync('scripts/verify-entrypoints.mjs', 'utf-8');
    const helper = readFileSync('scripts/esbuild-bundle.mjs', 'utf-8');

    expect(verifier).toContain("import { bundleWithEsbuildRetry } from './esbuild-bundle.mjs';");
    expect(verifier).toContain('await bundleWithEsbuildRetry({');
    expect(helper).toContain("import { build as bundleWithEsbuild, stop as stopEsbuildService } from 'esbuild';");
    expect(helper).toContain('const resetService = config.resetService ?? stopEsbuildService;');
    expect(helper).toContain('resetService();');
    expect(helper).toContain('The service was stopped');
    expect(verifier).not.toContain("'pnpm', [\n    'exec',\n    'esbuild'");
    expect(verifier).not.toContain("resolve(repoRoot, 'node_modules/.bin/esbuild')");
  });

  it('declares production verification scripts for package and release gates', () => {
    expect(packageJson.scripts).toMatchObject({
      verify: 'pnpm run lint && pnpm run type-check && pnpm -r run type-check && pnpm run verify:examples && pnpm run verify:boundaries && pnpm run docs:build && pnpm run verify:entrypoints && pnpm run verify:packages && pnpm run verify:release && pnpm run test:unit && pnpm run test:integration',
      'verify:examples': 'tsc -p examples/tsconfig.json --noEmit',
      'verify:packages': 'pnpm --filter @blade-ai/ai run build && pnpm --filter @blade-ai/agent run build && pnpm --filter @blade-ai/agent-sdk run build && node scripts/verify-packages.mjs',
      'verify:release': 'node scripts/verify-release-config.mjs',
      'test:unit': 'vitest run --exclude "src/__tests__/integration.test.ts" --exclude "src/__tests__/*.live.test.ts" --exclude "src/services/__tests__/*.live.test.ts" --exclude "src/services/__tests__/deepseek-deep.live.test.ts"',
      'test:integration': 'vitest run src/__tests__/integration.test.ts',
    });
    expect(existsSync(join(process.cwd(), 'scripts/verify-packages.mjs'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'scripts/verify-release-config.mjs'))).toBe(true);
  });

  it('throws clear errors from browser runtime stubs', async () => {
    const browser = await import('../browser/index.js');
    const serverOnly = await import('../browser/server-only-stub.js');

    expect(browser.PermissionMode.DEFAULT).toBe('default');
    expect(() => browser.createSession({} as never)).toThrow(/server-only.*createSession/);
    expect(() => serverOnly.getBuiltinTools()).toThrow(/server-only.*getBuiltinTools/);
  });

  it('keeps browser-safe source entries away from Node-only and server runtime imports', () => {
    const disallowedPatterns = [
      /node:/,
      /child_process/,
      /undici/,
      /node-pty/,
      /@modelcontextprotocol/,
      /\.\.\/session\/index\.js/,
      /\.\.\/server\//,
      /\.\.\/local\//,
      /\.\.\/tools\/builtin\//,
    ];

    for (const file of [
      'src/core/index.ts',
      'src/browser/index.ts',
      'src/browser/server-only-stub.ts',
    ]) {
      const source = readFileSync(file, 'utf-8');
      for (const pattern of disallowedPatterns) {
        expect(source, `${file} should not match ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
