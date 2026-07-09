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
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/traceRecorder.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/sessionTraceManager.test.ts'))).toBe(true);
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
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeHooks.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeToolRegistration.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeTools.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeWorkspace.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimePermissions.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeMcp.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeMcpCapabilities.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeMcpServers.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeMcpTools.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeAgentKernels.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeInstance.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/packageLocalRuntimeFactory.test.ts'))).toBe(
      true,
    );
    expect(
      existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/packageLocalKernelRuntimeFactory.test.ts')),
    ).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/defaultKernelRuntimeFactory.test.ts'))).toBe(
      true,
    );
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeKernelTurnStream.test.ts'))).toBe(
      true,
    );
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeSubagents.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/runtimeTurn.test.ts'))).toBe(true);
  });

  it('keeps agent-sdk session helper tests package-local', () => {
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/sessionContent.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/sessionConfig.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/sessionPendingTurn.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/sessionLifecycleState.test.ts'))).toBe(
      true,
    );
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/sessionTurnAbort.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/sessionTurnController.test.ts'))).toBe(
      true,
    );
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/packageLocalSession.test.ts'))).toBe(
      true,
    );
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/defaultSessionFactory.test.ts'))).toBe(
      true,
    );
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/sessionFactory.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/sessionStore.test.ts'))).toBe(true);
  });

  it('keeps agent-sdk public entry facade tests package-local', () => {
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/permissionEntry.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/subagentsEntry.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/toolsEntry.test.ts'))).toBe(true);
  });

  it('keeps agent-sdk local adapter tests package-local', () => {
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/localEntry.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/localMcp.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/localMemory.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/localMemoryTools.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/localSandbox.test.ts'))).toBe(true);
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
    expect(verifier).toContain('browserBundleOutput');
    expect(verifier).toContain("from '@blade-ai/ai';");
    expect(verifier).toContain("from '@blade-ai/ai/chat';");
    expect(verifier).toContain("from '@blade-ai/ai/model';");
    expect(verifier).toContain("from '@blade-ai/ai/deepseek';");
    expect(verifier).toContain("from '@blade-ai/ai/providers/openai-compatible';");
    expect(verifier).toContain("from '@blade-ai/ai/providers/vercel';");
    expect(verifier).toContain("from '@blade-ai/ai/retry';");
    expect(verifier).toContain('local ai chat runtime empty');
    expect(verifier).toContain('local ai model runtime empty');
    expect(verifier).toContain('local ai provider runtime exports');
    expect(verifier).toContain("from '@blade-ai/ai/package.json' with { type: 'json' };");
    expect(verifier).toContain("from '@blade-ai/agent/package.json' with { type: 'json' };");
    expect(verifier).toContain("from '@blade-ai/agent-sdk/package.json' with { type: 'json' };");
    expect(verifier).toContain('local package metadata @blade-ai/ai @blade-ai/agent @blade-ai/agent-sdk');
    expect(verifier).toContain('declaration-entry.ts');
    expect(verifier).toContain('declaration-tsconfig.json');
    expect(verifier).toContain("import type { ModelPort } from '@blade-ai/ai/model';");
    expect(verifier).toContain("import type { ChatConfig } from '@blade-ai/ai/chat';");
    expect(verifier).toContain("import type { OpenAICompatibleModelPortOptions } from '@blade-ai/ai/providers/openai-compatible';");
    expect(verifier).toContain("import type { VercelLanguageModelOptions } from '@blade-ai/ai/providers/vercel';");
    expect(verifier).toContain("import type { RetryConfig } from '@blade-ai/ai/retry';");
    expect(verifier).toContain("import type { AgentKernelOptions } from '@blade-ai/agent';");
    expect(verifier).toContain("import type { AgentToolPort } from '@blade-ai/agent/ports';");
    expect(verifier).toContain("import type { AgentToolCall } from '@blade-ai/agent/protocol';");
    expect(verifier).toContain("import type { AgentTraceEvent } from '@blade-ai/agent/tracing';");
    expect(verifier).toContain("import type { SessionOptions, StreamMessage } from '@blade-ai/agent-sdk';");
    expect(verifier).toContain("import type { ISession } from '@blade-ai/agent-sdk/session';");
    expect(verifier).toContain("import type { ToolDefinition } from '@blade-ai/agent-sdk/tools';");
    expect(verifier).toContain("import type { RuntimeContext } from '@blade-ai/agent-sdk/core';");
    expect(verifier).toContain('local declaration consumer type-check passed');
    expect(verifier).toContain('local root server runtime export parity');
    expect(verifier).toContain('Runtime export mismatch between local root and local server');
    expect(verifier).toContain('missing from local server');
    expect(verifier).toContain('extra in local server');
    expect(verifier).toContain('local root server declaration export parity');
    expect(verifier).toContain('Declaration export mismatch between local root and local server');
    expect(verifier).toContain('declarations missing from local server');
    expect(verifier).toContain('declarations extra in local server');
    expect(verifier).toContain('local core declarations must stay browser-safe and not expose server-only session APIs');
    expect(verifier).toContain('local core declarations must stay browser-safe and not expose Node-local tool APIs');
    expect(verifier).toContain('local core declarations must stay browser-safe and not expose Node-local MCP APIs');
    expect(verifier).toContain('local core declaration browser-safe boundary passed');
    expect(verifier).toContain('local root declarations must keep Node-local builtin tools behind @blade-ai/agent-sdk/local');
    expect(verifier).toContain('local root declarations must keep Node-local MCP helpers behind @blade-ai/agent-sdk/local');
    expect(verifier).toContain('local root declarations must keep filesystem memory adapters behind @blade-ai/agent-sdk/local');
    expect(verifier).toContain('local root declarations must keep sandbox adapters behind @blade-ai/agent-sdk/local');
    expect(verifier).toContain('local root declarations must keep provider-specific DeepSeek helpers in @blade-ai/ai/deepseek');
    expect(verifier).toContain('local root declaration public boundary passed');
    expect(verifier).toContain("from '@blade-ai/agent-sdk/browser';");
    expect(verifier).toContain("from '@blade-ai/agent-sdk/session/internal';");
    expect(verifier).toContain('server-only for bundled createSession');
    expect(verifier).toContain('server-only for bundled resumeSession');
    expect(verifier).toContain('server-only for bundled getBuiltinTools');
    expect(verifier).toContain("from '@blade-ai/agent';");
    expect(verifier).toContain("from '@blade-ai/agent/kernel';");
    expect(verifier).toContain("from '@blade-ai/agent/loop';");
    expect(verifier).toContain("from '@blade-ai/agent/protocol';");
    expect(verifier).toContain("from '@blade-ai/agent/ports';");
    expect(verifier).toContain("from '@blade-ai/agent/state';");
    expect(verifier).toContain("console.log('local agent browser bundle'");
    expect(verifier).toContain('local agent protocol runtime empty');
    expect(verifier).toContain('local agent ports runtime empty');
    expect(verifier).toContain('local agent browser bundle core runtime smoke did not execute');
    expect(verifier).toContain('local agent browser bundle loop/recovery smoke did not execute');
    expect(verifier).toContain('local agent browser bundle message projection smoke did not execute');
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
