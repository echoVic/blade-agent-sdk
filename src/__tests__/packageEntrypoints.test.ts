import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as packageRootEntry from '../../packages/agent-sdk/src/index.js';
import * as packageServerEntry from '../../packages/agent-sdk/src/server/index.js';

const rootPackageJson = JSON.parse(readFileSync('package.json', 'utf-8')) as {
  scripts: Record<string, string>;
};

const sdkPackageJson = JSON.parse(readFileSync('packages/agent-sdk/package.json', 'utf-8')) as {
  exports: Record<string, unknown>;
  scripts: Record<string, string>;
};

describe('package entrypoints', () => {
  it('declares server-first root and explicit subpath exports', () => {
    expect(sdkPackageJson.exports).toMatchObject({
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
      'packages/agent-sdk/src/core/index.ts',
      'packages/agent-sdk/src/browser/index.ts',
      'packages/agent-sdk/src/browser/server-only-stub.ts',
      'packages/agent-sdk/src/server/index.ts',
      'packages/agent-sdk/src/tools/index.ts',
      'packages/agent-sdk/src/local/index.ts',
      'packages/agent-sdk/src/session/index.ts',
    ]) {
      expect(existsSync(join(process.cwd(), file)), file).toBe(true);
    }
  });

  it('keeps security-sensitive agent-sdk runtime tests package-local', () => {
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/publicFacades.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeToolFilters.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeTraceManager.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeKernelModels.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeKernelTraceFinalization.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeAgentDeps.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeKernelPorts.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeExecutionPipeline.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeExecution.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeKernel.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeKernelTracePort.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeKernelFactory.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeKernelModelResolver.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeKernelStreamBridge.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeKernelStreamProjection.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimePromptStreamAccumulator.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeContext.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeControls.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeGuards.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeState.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeCapabilities.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeConnectionOperations.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeSessionCapabilities.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeNoopPorts.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimePortProjection.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeBootstrap.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeSessionLifecycle.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeSessionOperations.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeForking.test.ts'))).toBe(true);
  });

  it('keeps the server entry as an explicit facade instead of a root wildcard forwarder', () => {
    const source = readFileSync('packages/agent-sdk/src/server/index.ts', 'utf-8');

    expect(source).not.toContain("export * from '../index.js'");
    expect(source).toContain("from '../session/index.js'");
    expect(source).toContain("from '../core/index.js'");
    expect(source).toContain("from '../tools/index.js'");
    expect(source).toContain("from '../subagents/index.js'");
  });

  it('keeps root and server runtime facade value exports aligned', () => {
    expect(packageRootEntry).toHaveProperty('subagentRegistry');
    expect(packageServerEntry).toHaveProperty('subagentRegistry');
    expect(Object.keys(packageServerEntry).sort()).toEqual(Object.keys(packageRootEntry).sort());
  });

  it('declares the browser/server entrypoint verification script', () => {
    expect(rootPackageJson.scripts['verify:entrypoints']).toBe(
      'pnpm --filter @blade-ai/agent-sdk run build && node scripts/verify-entrypoints.mjs',
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
    expect(rootPackageJson.scripts).toMatchObject({
      verify: 'pnpm run lint && pnpm run type-check && pnpm -r run type-check && pnpm run verify:examples && pnpm run verify:boundaries && pnpm run docs:build && pnpm run verify:entrypoints && pnpm run verify:packages && pnpm run verify:release && pnpm run test:unit && pnpm run test:packages && pnpm run test:integration',
      'verify:examples': 'tsc -p examples/tsconfig.json --noEmit',
      'verify:packages': 'pnpm --filter @blade-ai/ai run build && pnpm --filter @blade-ai/agent run build && pnpm --filter @blade-ai/agent-sdk run build && node scripts/verify-packages.mjs',
      'verify:release': 'node scripts/verify-release-config.mjs',
      'test:packages': 'pnpm --filter @blade-ai/ai exec vitest run && pnpm --filter @blade-ai/agent exec vitest run && pnpm --filter @blade-ai/agent-sdk exec vitest run',
      'test:unit': 'vitest run --exclude "src/__tests__/integration.test.ts" --exclude "src/__tests__/*.live.test.ts" --exclude "src/services/__tests__/*.live.test.ts" --exclude "src/services/__tests__/deepseek-deep.live.test.ts"',
      'test:integration': 'vitest run src/__tests__/integration.test.ts',
    });
    expect(existsSync(join(process.cwd(), 'scripts/verify-packages.mjs'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'scripts/verify-release-config.mjs'))).toBe(true);
    expect(rootPackageJson.scripts.verify).toContain('pnpm run verify:entrypoints');
    expect(rootPackageJson.scripts.verify).toContain('pnpm run test:packages');
    expect(rootPackageJson.scripts['test:packages']).not.toContain('--passWithNoTests');
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
      'packages/agent-sdk/src/core/index.ts',
      'packages/agent-sdk/src/browser/index.ts',
      'packages/agent-sdk/src/browser/server-only-stub.ts',
    ]) {
      const source = readFileSync(file, 'utf-8');
      for (const pattern of disallowedPatterns) {
        expect(source, `${file} should not match ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
