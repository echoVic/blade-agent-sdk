import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as packageRootEntry from '@blade-ai/agent-sdk';
import * as packageServerEntry from '@blade-ai/agent-sdk/server';
import { describe, expect, it } from 'vitest';

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
        browser: './dist/core/index.js',
        import: './dist/core/index.js',
      },
      './browser': {
        types: './dist/browser/index.d.ts',
        browser: './dist/browser/index.js',
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
        browser: './dist/tools/index.js',
        import: './dist/tools/index.js',
      },
      './errors': {
        types: './dist/errors/index.d.ts',
        browser: './dist/errors/index.js',
        import: './dist/errors/index.js',
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
      'packages/agent-sdk/src/errors/index.ts',
      'packages/agent-sdk/src/local/index.ts',
      'packages/agent-sdk/src/session/index.ts',
    ]) {
      expect(existsSync(join(process.cwd(), file)), file).toBe(true);
    }
  });

  it('keeps agent-sdk public error hierarchy package-local', () => {
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/__tests__/errorsEntry.test.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/errors/SdkError.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/errors/AbortError.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/errors/ConfigError.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/errors/PermissionDeniedError.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'packages/agent-sdk/src/errors/ToolExecutionError.ts'))).toBe(true);
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

  it('shares root declaration ownership rules across local packed and published verifiers', () => {
    const sharedRulesPath = 'scripts/agent-sdk-boundary-rules.mjs';

    expect(existsSync(join(process.cwd(), sharedRulesPath)), sharedRulesPath).toBe(true);

    const sharedRules = readFileSync(sharedRulesPath, 'utf-8');
    const entrypointVerifier = readFileSync('scripts/verify-entrypoints.mjs', 'utf-8');
    const packageVerifier = readFileSync('scripts/verify-packages.mjs', 'utf-8');
    const publishedVerifier = readFileSync('scripts/verify-published.mjs', 'utf-8');

    expect(sharedRules).toContain('agentSdkRootDeclarationEntryOwnershipRules');
    expect(sharedRules).toContain('./agent/loop/runToolCall.js');
    expect(sharedRules).toContain('./tools/core/createTool.js');
    expect(sharedRules).toContain('./tools/catalog/index.js');
    expect(sharedRules).toContain('public-index.js');
    expect(entrypointVerifier).toContain("from './agent-sdk-boundary-rules.mjs';");
    expect(entrypointVerifier).toContain('agentSdkRootDeclarationEntryOwnershipRules');
    expect(entrypointVerifier).toContain('toLocalForbiddenDeclarationRules');
    expect(entrypointVerifier).toContain(
      'toLocalForbiddenDeclarationRules(agentSdkRootDeclarationEntryOwnershipRules)',
    );
    expect(packageVerifier).toContain("from './agent-sdk-boundary-rules.mjs';");
    expect(packageVerifier).toContain('agentSdkRootDeclarationEntryOwnershipRules');
    expect(packageVerifier).toContain('toPackedForbiddenFileContents');
    expect(packageVerifier).toContain(
      "toPackedForbiddenFileContents('package/dist/index.d.ts', agentSdkRootDeclarationEntryOwnershipRules)",
    );
    expect(publishedVerifier).toContain('agentSdkRootDeclarationEntryOwnershipRules');
    expect(publishedVerifier).toContain('toInstalledForbiddenFileRules(');
  });

  it('shares root public declaration boundary rules across local packed and published verifiers', () => {
    const sharedRulesPath = 'scripts/agent-sdk-boundary-rules.mjs';

    expect(existsSync(join(process.cwd(), sharedRulesPath)), sharedRulesPath).toBe(true);

    const sharedRules = readFileSync(sharedRulesPath, 'utf-8');
    const entrypointVerifier = readFileSync('scripts/verify-entrypoints.mjs', 'utf-8');
    const packageVerifier = readFileSync('scripts/verify-packages.mjs', 'utf-8');
    const publishedVerifier = readFileSync('scripts/verify-published.mjs', 'utf-8');

    expect(sharedRules).toContain('agentSdkRootPublicDeclarationBoundaryRules');
    expect(sharedRules).toContain('getBuiltinTools');
    expect(sharedRules).toContain('createSdkMcpServer');
    expect(sharedRules).toContain('FileSystemMemoryStore');
    expect(sharedRules).toContain('SandboxExecutor');
    expect(sharedRules).toContain('normalizeDeepSeekModel');
    expect(sharedRules).toContain('calculateDeepSeekCost');
    expect(sharedRules).toContain('DeepSeekCostTracker');
    expect(sharedRules).toContain('DEEPSEEK_DEFAULT_MODEL');
    expect(entrypointVerifier).toContain(
      'toLocalForbiddenDeclarationRules(agentSdkRootPublicDeclarationBoundaryRules)',
    );
    expect(packageVerifier).toContain(
      "toPackedForbiddenFileContents('package/dist/index.d.ts', agentSdkRootPublicDeclarationBoundaryRules)",
    );
    expect(publishedVerifier).toContain('toInstalledForbiddenFileRules(');
    expect(publishedVerifier).toContain('agentSdkRootPublicDeclarationBoundaryRules');
    expect(publishedVerifier).not.toContain('forbiddenRootDeclarations');
  });

  it('shares root subagent compatibility boundary rules across local packed and published verifiers', () => {
    const sharedRulesPath = 'scripts/agent-sdk-boundary-rules.mjs';

    expect(existsSync(join(process.cwd(), sharedRulesPath)), sharedRulesPath).toBe(true);

    const sharedRules = readFileSync(sharedRulesPath, 'utf-8');
    const entrypointVerifier = readFileSync('scripts/verify-entrypoints.mjs', 'utf-8');
    const packageVerifier = readFileSync('scripts/verify-packages.mjs', 'utf-8');
    const publishedVerifier = readFileSync('scripts/verify-published.mjs', 'utf-8');

    expect(sharedRules).toContain('agentSdkRootSubagentCompatibilityBoundaryRules');
    expect(sharedRules).toContain('dist/index.js');
    expect(sharedRules).toContain('dist/index.d.ts');
    expect(sharedRules).toContain('src/agent/subagents');
    expect(sharedRules).toContain('../agent/subagents');
    expect(sharedRules).toContain('root runtime must use package-local subagent compatibility exports');
    expect(sharedRules).toContain('root declarations must use package-local subagent compatibility exports');
    expect(entrypointVerifier).toContain('agentSdkRootSubagentCompatibilityBoundaryRules');
    expect(entrypointVerifier).toContain("rule.file === 'dist/index.js'");
    expect(entrypointVerifier).toContain("rule.file === 'dist/index.d.ts'");
    expect(packageVerifier).toContain('toPackedForbiddenFileRules(agentSdkRootSubagentCompatibilityBoundaryRules)');
    expect(publishedVerifier).toContain('verifyPublishedRootSubagentCompatibilityBoundary');
    expect(publishedVerifier).toContain('agentSdkRootSubagentCompatibilityBoundaryRules');
  });

  it('shares server facade boundary rules across local packed and published verifiers', () => {
    const sharedRulesPath = 'scripts/agent-sdk-boundary-rules.mjs';

    expect(existsSync(join(process.cwd(), sharedRulesPath)), sharedRulesPath).toBe(true);

    const sharedRules = readFileSync(sharedRulesPath, 'utf-8');
    const entrypointVerifier = readFileSync('scripts/verify-entrypoints.mjs', 'utf-8');
    const packageVerifier = readFileSync('scripts/verify-packages.mjs', 'utf-8');
    const publishedVerifier = readFileSync('scripts/verify-published.mjs', 'utf-8');

    expect(sharedRules).toContain('agentSdkServerFacadeBoundaryRules');
    expect(sharedRules).toContain('dist/server/index.js');
    expect(sharedRules).toContain('dist/server/index.d.ts');
    expect(sharedRules).toContain('../index.js');
    expect(sharedRules).toContain('server runtime entry must be an explicit package-local facade');
    expect(sharedRules).toContain('server declarations must be an explicit package-local facade');
    expect(entrypointVerifier).toContain('agentSdkServerFacadeBoundaryRules');
    expect(entrypointVerifier).toContain('toLocalForbiddenDeclarationRules([rule])');
    expect(packageVerifier).toContain('toPackedForbiddenFileRules(agentSdkServerFacadeBoundaryRules)');
    expect(publishedVerifier).toContain('toInstalledForbiddenFileRules(');
    expect(publishedVerifier).toContain('agentSdkServerFacadeBoundaryRules');
  });

  it('shares browser-safe core declaration boundary rules across local packed and published verifiers', () => {
    const sharedRulesPath = 'scripts/agent-sdk-boundary-rules.mjs';

    expect(existsSync(join(process.cwd(), sharedRulesPath)), sharedRulesPath).toBe(true);

    const sharedRules = readFileSync(sharedRulesPath, 'utf-8');
    const entrypointVerifier = readFileSync('scripts/verify-entrypoints.mjs', 'utf-8');
    const packageVerifier = readFileSync('scripts/verify-packages.mjs', 'utf-8');
    const publishedVerifier = readFileSync('scripts/verify-published.mjs', 'utf-8');

    expect(sharedRules).toContain('agentSdkCoreDeclarationBrowserSafeRules');
    expect(sharedRules).toContain('dist/core/index.d.ts');
    expect(sharedRules).toContain('createSession');
    expect(sharedRules).toContain('resumeSession');
    expect(sharedRules).toContain('forkSession');
    expect(sharedRules).toContain('getBuiltinTools');
    expect(sharedRules).toContain('createSdkMcpServer');
    expect(sharedRules).toContain('core declarations must stay browser-safe');
    expect(entrypointVerifier).toContain('agentSdkCoreDeclarationBrowserSafeRules');
    expect(packageVerifier).toContain('toPackedForbiddenFileRules(agentSdkCoreDeclarationBrowserSafeRules)');
    expect(publishedVerifier).toContain('toInstalledForbiddenFileRules(');
    expect(publishedVerifier).toContain('agentSdkCoreDeclarationBrowserSafeRules');
  });

  it('shares session public declaration boundary rules across local packed and published verifiers', () => {
    const sharedRulesPath = 'scripts/agent-sdk-boundary-rules.mjs';

    expect(existsSync(join(process.cwd(), sharedRulesPath)), sharedRulesPath).toBe(true);

    const sharedRules = readFileSync(sharedRulesPath, 'utf-8');
    const entrypointVerifier = readFileSync('scripts/verify-entrypoints.mjs', 'utf-8');
    const packageVerifier = readFileSync('scripts/verify-packages.mjs', 'utf-8');
    const publishedVerifier = readFileSync('scripts/verify-published.mjs', 'utf-8');

    expect(sharedRules).toContain('agentSdkSessionPublicDeclarationBoundaryRules');
    expect(sharedRules).toContain('dist/session/types.d.ts');
    expect(sharedRules).toContain("runtime?: 'kernel' | 'legacy'");
    expect(sharedRules).toContain('experimentalKernel');
    expect(sharedRules).toContain('legacyStream');
    expect(sharedRules).toContain('packageLocalLegacy');
    expect(sharedRules).toContain("from '@blade-ai/agent'");
    expect(sharedRules).toContain('AgentTokenBudgetSnapshot');
    expect(sharedRules).toContain('session declarations must not expose retired legacy stream runtime options');
    expect(entrypointVerifier).toContain('agentSdkSessionPublicDeclarationBoundaryRules');
    expect(packageVerifier).toContain('toPackedForbiddenFileRules(agentSdkSessionPublicDeclarationBoundaryRules)');
    expect(publishedVerifier).toContain('verifyPublishedSessionPublicDeclarationBoundary');
    expect(publishedVerifier).toContain('agentSdkSessionPublicDeclarationBoundaryRules');
  });

  it('shares session entry Session boundary rules across local packed and published verifiers', () => {
    const sharedRulesPath = 'scripts/agent-sdk-boundary-rules.mjs';

    expect(existsSync(join(process.cwd(), sharedRulesPath)), sharedRulesPath).toBe(true);

    const sharedRules = readFileSync(sharedRulesPath, 'utf-8');
    const entrypointVerifier = readFileSync('scripts/verify-entrypoints.mjs', 'utf-8');
    const packageVerifier = readFileSync('scripts/verify-packages.mjs', 'utf-8');
    const publishedVerifier = readFileSync('scripts/verify-published.mjs', 'utf-8');

    expect(sharedRules).toContain('agentSdkSessionEntrySessionBoundaryRules');
    expect(sharedRules).toContain('dist/session/index.d.ts');
    expect(sharedRules).toContain('dist/session/index.js');
    expect(sharedRules).toContain('dist/session/Session.d.ts');
    expect(sharedRules).toContain('./Session.js');
    expect(sharedRules).toContain('../../../../src/session/Session');
    expect(sharedRules).toContain('from"../../../../src/session/Session');
    expect(sharedRules).toContain('from "../../../../src/session/Session');
    expect(sharedRules).toContain('session declarations must be emitted from package-local session entry source');
    expect(sharedRules).toContain('session runtime entry must not import the legacy root Session directly');
    expect(sharedRules).toContain('package-local Session declarations must expose local session contracts only');
    expect(entrypointVerifier).toContain('agentSdkSessionEntrySessionBoundaryRules');
    expect(entrypointVerifier).toContain("rule.file === 'dist/session/index.d.ts'");
    expect(entrypointVerifier).toContain("rule.file === 'dist/session/index.js'");
    expect(entrypointVerifier).toContain("rule.file === 'dist/session/Session.d.ts'");
    expect(packageVerifier).toContain('toPackedForbiddenFileRules(agentSdkSessionEntrySessionBoundaryRules)');
    expect(publishedVerifier).toContain('verifyPublishedSessionEntrySessionBoundary');
    expect(publishedVerifier).toContain('agentSdkSessionEntrySessionBoundaryRules');
  });

  it('shares eager legacy session runtime closure rules across local packed and published verifiers', () => {
    const sharedRulesPath = 'scripts/agent-sdk-boundary-rules.mjs';

    expect(existsSync(join(process.cwd(), sharedRulesPath)), sharedRulesPath).toBe(true);

    const sharedRules = readFileSync(sharedRulesPath, 'utf-8');
    const entrypointVerifier = readFileSync('scripts/verify-entrypoints.mjs', 'utf-8');
    const packageVerifier = readFileSync('scripts/verify-packages.mjs', 'utf-8');
    const publishedVerifier = readFileSync('scripts/verify-published.mjs', 'utf-8');

    expect(sharedRules).toContain('agentSdkEagerLegacySessionRuntimeClosureRules');
    expect(sharedRules).toContain('../../src/session/Session.ts');
    expect(sharedRules).toContain('../../src/session/SessionRuntime.ts');
    expect(sharedRules).toContain('../../src/session/SessionStore.ts');
    expect(sharedRules).toContain('public session entry must not eagerly include legacy root session runtime');
    expect(entrypointVerifier).toContain('agentSdkEagerLegacySessionRuntimeClosureRules');
    expect(entrypointVerifier).toContain('verifyLocalNoEagerLegacySessionRuntime');
    expect(entrypointVerifier).toContain('for (const rule of agentSdkEagerLegacySessionRuntimeClosureRules)');
    expect(packageVerifier).toContain('agentSdkEagerLegacySessionRuntimeClosureRules');
    expect(packageVerifier).not.toContain('const forbiddenMarkers = [');
    expect(packageVerifier).toContain('for (const rule of agentSdkEagerLegacySessionRuntimeClosureRules)');
    expect(packageVerifier).toContain('public session entry eagerly includes legacy root session runtime marker');
    expect(packageVerifier).toContain('rule.forbidden');
    expect(publishedVerifier).toContain('agentSdkEagerLegacySessionRuntimeClosureRules');
    expect(publishedVerifier).toContain('verifyPublishedNoEagerLegacySessionRuntime');
    expect(publishedVerifier).toContain('for (const rule of agentSdkEagerLegacySessionRuntimeClosureRules)');
  });

  it('shares session factory declaration boundary rules across local packed and published verifiers', () => {
    const sharedRulesPath = 'scripts/agent-sdk-boundary-rules.mjs';

    expect(existsSync(join(process.cwd(), sharedRulesPath)), sharedRulesPath).toBe(true);

    const sharedRules = readFileSync(sharedRulesPath, 'utf-8');
    const entrypointVerifier = readFileSync('scripts/verify-entrypoints.mjs', 'utf-8');
    const packageVerifier = readFileSync('scripts/verify-packages.mjs', 'utf-8');
    const publishedVerifier = readFileSync('scripts/verify-published.mjs', 'utf-8');

    expect(sharedRules).toContain('agentSdkSessionFactoryDeclarationBoundaryRules');
    expect(sharedRules).toContain('dist/session/factory.d.ts');
    expect(sharedRules).toContain('fork(options');
    expect(sharedRules).toContain('prompt(message');
    expect(sharedRules).toContain('session runtime factory declarations must expose only create/resume primitives');
    expect(entrypointVerifier).toContain('agentSdkSessionFactoryDeclarationBoundaryRules');
    expect(entrypointVerifier).toContain('toLocalForbiddenDeclarationRules(agentSdkSessionFactoryDeclarationBoundaryRules)');
    expect(packageVerifier).toContain('toPackedForbiddenFileRules(agentSdkSessionFactoryDeclarationBoundaryRules)');
    expect(publishedVerifier).toContain('verifyPublishedSessionFactoryDeclarationBoundary');
    expect(publishedVerifier).toContain('agentSdkSessionFactoryDeclarationBoundaryRules');
  });

  it('shares session config declaration boundary rules across local packed and published verifiers', () => {
    const sharedRulesPath = 'scripts/agent-sdk-boundary-rules.mjs';

    expect(existsSync(join(process.cwd(), sharedRulesPath)), sharedRulesPath).toBe(true);

    const sharedRules = readFileSync(sharedRulesPath, 'utf-8');
    const entrypointVerifier = readFileSync('scripts/verify-entrypoints.mjs', 'utf-8');
    const packageVerifier = readFileSync('scripts/verify-packages.mjs', 'utf-8');
    const publishedVerifier = readFileSync('scripts/verify-published.mjs', 'utf-8');

    expect(sharedRules).toContain('agentSdkSessionConfigDeclarationBoundaryRules');
    expect(sharedRules).toContain('dist/session/config.d.ts');
    expect(sharedRules).toContain('./Session.js');
    expect(sharedRules).toContain('../../../../src/types/common');
    expect(sharedRules).toContain('session config declarations must be emitted from package-local session config source');
    expect(sharedRules).toContain('session config declarations must use package-local core config types');
    expect(entrypointVerifier).toContain('agentSdkSessionConfigDeclarationBoundaryRules');
    expect(entrypointVerifier).toContain('toLocalForbiddenDeclarationRules(agentSdkSessionConfigDeclarationBoundaryRules)');
    expect(packageVerifier).toContain('toPackedForbiddenFileRules(agentSdkSessionConfigDeclarationBoundaryRules)');
    expect(publishedVerifier).toContain('verifyPublishedSessionConfigDeclarationBoundary');
    expect(publishedVerifier).toContain('agentSdkSessionConfigDeclarationBoundaryRules');
  });

  it('shares session store declaration boundary rules across local packed and published verifiers', () => {
    const sharedRulesPath = 'scripts/agent-sdk-boundary-rules.mjs';

    expect(existsSync(join(process.cwd(), sharedRulesPath)), sharedRulesPath).toBe(true);

    const sharedRules = readFileSync(sharedRulesPath, 'utf-8');
    const entrypointVerifier = readFileSync('scripts/verify-entrypoints.mjs', 'utf-8');
    const packageVerifier = readFileSync('scripts/verify-packages.mjs', 'utf-8');
    const publishedVerifier = readFileSync('scripts/verify-published.mjs', 'utf-8');

    expect(sharedRules).toContain('agentSdkSessionStoreDeclarationBoundaryRules');
    expect(sharedRules).toContain('dist/session/store.d.ts');
    expect(sharedRules).toContain('../context/storage');
    expect(sharedRules).toContain('./SessionStore.js');
    expect(sharedRules).toContain('session store declarations must be emitted from package-local session store source');
    expect(sharedRules).toContain('session store declarations must not point back at legacy root session store');
    expect(entrypointVerifier).toContain('agentSdkSessionStoreDeclarationBoundaryRules');
    expect(entrypointVerifier).toContain('toLocalForbiddenDeclarationRules(agentSdkSessionStoreDeclarationBoundaryRules)');
    expect(packageVerifier).toContain('toPackedForbiddenFileRules(agentSdkSessionStoreDeclarationBoundaryRules)');
    expect(publishedVerifier).toContain('verifyPublishedSessionStoreDeclarationBoundary');
    expect(publishedVerifier).toContain('agentSdkSessionStoreDeclarationBoundaryRules');
  });

  it('shares tools entry boundary rules across local packed and published verifiers', () => {
    const sharedRulesPath = 'scripts/agent-sdk-boundary-rules.mjs';

    expect(existsSync(join(process.cwd(), sharedRulesPath)), sharedRulesPath).toBe(true);

    const sharedRules = readFileSync(sharedRulesPath, 'utf-8');
    const entrypointVerifier = readFileSync('scripts/verify-entrypoints.mjs', 'utf-8');
    const packageVerifier = readFileSync('scripts/verify-packages.mjs', 'utf-8');
    const publishedVerifier = readFileSync('scripts/verify-published.mjs', 'utf-8');

    expect(sharedRules).toContain('agentSdkToolsEntryBoundaryRules');
    expect(sharedRules).toContain('dist/tools/index.d.ts');
    expect(sharedRules).toContain('dist/tools/index.js');
    expect(sharedRules).toContain('./core/createTool.js');
    expect(sharedRules).toContain('./catalog/index.js');
    expect(sharedRules).toContain('../core/createTool.js');
    expect(sharedRules).toContain('../catalog/ToolCatalog.js');
    expect(sharedRules).toContain('src/tools/core/createTool');
    expect(sharedRules).toContain('src/tools/catalog/ToolCatalog');
    expect(sharedRules).toContain('tools declarations must be emitted from package-local tools entry source');
    expect(sharedRules).toContain('tools runtime must be emitted from package-local tools source');
    expect(entrypointVerifier).toContain('agentSdkToolsEntryBoundaryRules');
    expect(entrypointVerifier).toContain("rule.file === 'dist/tools/index.d.ts'");
    expect(entrypointVerifier).toContain("rule.file === 'dist/tools/index.js'");
    expect(packageVerifier).toContain('toPackedForbiddenFileRules(agentSdkToolsEntryBoundaryRules)');
    expect(publishedVerifier).toContain('verifyPublishedToolsEntryBoundary');
    expect(publishedVerifier).toContain('agentSdkToolsEntryBoundaryRules');
  });

  it('shares local adapter boundary rules across local packed and published verifiers', () => {
    const sharedRulesPath = 'scripts/agent-sdk-boundary-rules.mjs';

    expect(existsSync(join(process.cwd(), sharedRulesPath)), sharedRulesPath).toBe(true);

    const sharedRules = readFileSync(sharedRulesPath, 'utf-8');
    const entrypointVerifier = readFileSync('scripts/verify-entrypoints.mjs', 'utf-8');
    const packageVerifier = readFileSync('scripts/verify-packages.mjs', 'utf-8');
    const publishedVerifier = readFileSync('scripts/verify-published.mjs', 'utf-8');

    expect(sharedRules).toContain('agentSdkLocalAdapterBoundaryRules');
    expect(sharedRules).toContain('dist/local/index.d.ts');
    expect(sharedRules).toContain('dist/local/index.js');
    expect(sharedRules).toContain('../mcp/index.js');
    expect(sharedRules).toContain('../memory/index.js');
    expect(sharedRules).toContain('../sandbox/index.js');
    expect(sharedRules).toContain('../tools/builtin');
    expect(sharedRules).toContain('createSdkMcpServer(...args: unknown[])');
    expect(sharedRules).toContain('tool(...args: unknown[])');
    expect(sharedRules).toContain('constructor(...args: unknown[]): SandboxExecutor');
    expect(sharedRules).toContain('constructor(...args: unknown[]): SandboxService');
    expect(sharedRules).toContain('getBuiltinTools(...args: unknown[])');
    expect(sharedRules).toContain('read(id: string)');
    expect(sharedRules).toContain('write(input: MemoryInput)');
    expect(sharedRules).toContain('delete(id: string): Promise<boolean>');
    expect(sharedRules).toContain('src/mcp');
    expect(sharedRules).toContain('src/memory');
    expect(sharedRules).toContain('src/sandbox');
    expect(sharedRules).toContain('src/tools/builtin');
    expect(sharedRules).toContain('src/tools/builtin/memory');
    expect(sharedRules).toContain('local declarations must be emitted from package-local local entry source');
    expect(sharedRules).toContain('local runtime entry must route through package-local local adapters');
    expect(entrypointVerifier).toContain('agentSdkLocalAdapterBoundaryRules');
    expect(entrypointVerifier).toContain("rule.file === 'dist/local/index.d.ts'");
    expect(entrypointVerifier).toContain("rule.file === 'dist/local/index.js'");
    expect(packageVerifier).toContain('toPackedForbiddenFileRules(agentSdkLocalAdapterBoundaryRules)');
    expect(publishedVerifier).toContain('verifyPublishedLocalAdapterBoundary');
    expect(publishedVerifier).toContain('agentSdkLocalAdapterBoundaryRules');
  });

  it('shares permission declaration boundary rules across local packed and published verifiers', () => {
    const sharedRulesPath = 'scripts/agent-sdk-boundary-rules.mjs';

    expect(existsSync(join(process.cwd(), sharedRulesPath)), sharedRulesPath).toBe(true);

    const sharedRules = readFileSync(sharedRulesPath, 'utf-8');
    const entrypointVerifier = readFileSync('scripts/verify-entrypoints.mjs', 'utf-8');
    const packageVerifier = readFileSync('scripts/verify-packages.mjs', 'utf-8');
    const publishedVerifier = readFileSync('scripts/verify-published.mjs', 'utf-8');

    expect(sharedRules).toContain('agentSdkPermissionDeclarationBoundaryRules');
    expect(sharedRules).toContain('dist/types/permissions.d.ts');
    expect(sharedRules).toContain('SensitiveFileDetector');
    expect(sharedRules).toContain('./ToolEffects.js');
    expect(sharedRules).toContain('permission declarations must be emitted from package-local permission source');
    expect(sharedRules).toContain('permission declarations must use package-local tool contracts');
    expect(entrypointVerifier).toContain('agentSdkPermissionDeclarationBoundaryRules');
    expect(entrypointVerifier).toContain(
      'toLocalForbiddenDeclarationRules(agentSdkPermissionDeclarationBoundaryRules)',
    );
    expect(packageVerifier).toContain('toPackedForbiddenFileRules(agentSdkPermissionDeclarationBoundaryRules)');
    expect(publishedVerifier).toContain('verifyPublishedPermissionDeclarationBoundary');
    expect(publishedVerifier).toContain('agentSdkPermissionDeclarationBoundaryRules');
  });

  it('runs the browser bundle check through the esbuild JS API', () => {
    const verifier = readFileSync('scripts/verify-entrypoints.mjs', 'utf-8');
    const helper = readFileSync('scripts/esbuild-bundle.mjs', 'utf-8');
    const publicTypeContracts = readFileSync('scripts/public-type-contracts.mjs', 'utf-8');

    expect(verifier).toContain("import { bundleWithEsbuildRetry } from './esbuild-bundle.mjs';");
    expect(verifier).toContain('await bundleWithEsbuildRetry({');
    expect(helper).toContain("import { build as bundleWithEsbuild, stop as stopEsbuildService } from 'esbuild';");
    expect(helper).toContain('const resetService = config.resetService ?? stopEsbuildService;');
    expect(helper).toContain('resetService();');
    expect(helper).toContain('The service was stopped');
    expect(verifier).toContain('browserBundleOutput');
    expect(verifier).toContain("from '@blade-ai/agent-sdk/errors';");
    expect(verifier).toContain("import { ToolCatalog, ToolKind, defineTool } from '@blade-ai/agent-sdk/tools';");
    expect(verifier).toContain('browser-safe sdk error true CONFIG_ERROR');
    expect(verifier).toContain('browser-safe sdk tool');
    expect(verifier).toContain("verifyBrowserSafeDist('dist/errors/index.js')");
    expect(verifier).toContain("verifyBrowserSafeDist('dist/tools/index.js')");
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
    expect(publicTypeContracts).toContain(
      "import type { ModelPort, ModelRequest, ModelResponse, ModelStreamEvent, UsageInfo as ModelUsageInfo } from '@blade-ai/ai/model';",
    );
    expect(publicTypeContracts).toContain(
      "import type { ChatConfig, ChatResponse, Message as ChatMessage, StreamChunk as ChatStreamChunk, UsageInfo as ChatUsageInfo } from '@blade-ai/ai/chat';",
    );
    expect(publicTypeContracts).toContain(
      "import type { OpenAICompatibleModelPortOptions } from '@blade-ai/ai/providers/openai-compatible';",
    );
    expect(publicTypeContracts).toContain(
      "import type { VercelLanguageModelOptions } from '@blade-ai/ai/providers/vercel';",
    );
    expect(publicTypeContracts).toContain("import type { RetryConfig } from '@blade-ai/ai/retry';");
    expect(publicTypeContracts).toContain(
      "import type { AgentKernelOptions, AgentTurnInput } from '@blade-ai/agent/kernel';",
    );
    expect(publicTypeContracts).not.toContain("import type { AgentKernelOptions } from '@blade-ai/agent';");
    expect(publicTypeContracts).toContain(
      "import type { AgentStreamEvent } from '@blade-ai/agent/protocol';",
    );
    expect(publicTypeContracts).toContain("import type { AgentToolPort } from '@blade-ai/agent/ports';");
    expect(publicTypeContracts).toContain(
      "import type { AgentToolCall, AgentToolResult } from '@blade-ai/agent/protocol';",
    );
    expect(publicTypeContracts).toContain(
      "import type { AgentTraceEvent, AgentTracePort, BufferedAgentTracePort, BufferedAgentTracePortOptions } from '@blade-ai/agent/tracing';",
    );
    expect(publicTypeContracts).toContain("import type { SessionOptions, StreamMessage } from '@blade-ai/agent-sdk';");
    expect(publicTypeContracts).toContain("import type { ISession } from '@blade-ai/agent-sdk/session';");
    expect(publicTypeContracts).toContain("import type { ToolDefinition } from '@blade-ai/agent-sdk/tools';");
    expect(publicTypeContracts).toContain("import type { RuntimeContext } from '@blade-ai/agent-sdk/core';");
    expect(verifier).toContain('const sdkErrorOptions: SdkErrorOptions');
    expect(verifier).toContain('local declaration consumer type-check passed');
    expect(verifier).toContain('local root server runtime export parity');
    expect(verifier).toContain('Runtime export mismatch between local root and local server');
    expect(verifier).toContain('missing from local server');
    expect(verifier).toContain('extra in local server');
    expect(verifier).toContain('local root server declaration export parity');
    expect(verifier).toContain('Declaration export mismatch between local root and local server');
    expect(verifier).toContain('declarations missing from local server');
    expect(verifier).toContain('declarations extra in local server');
    expect(verifier).toContain('local browser root local-only export boundary passed');
    expect(verifier).toContain("assertNoRuntimeExport(browserRootModule, 'getBuiltinTools')");
    expect(verifier).toContain("assertNoRuntimeExport(browserRootModule, 'createSdkMcpServer')");
    expect(verifier).toContain('toLocalForbiddenDeclarationRules(agentSdkCoreDeclarationBrowserSafeRules)');
    expect(verifier).toContain('local core declaration browser-safe boundary passed');
    expect(verifier).toContain('toLocalForbiddenDeclarationRules(agentSdkRootPublicDeclarationBoundaryRules)');
    expect(verifier).toContain('local root declaration public boundary passed');
    expect(verifier).toContain('toLocalForbiddenDeclarationRules(agentSdkRootDeclarationEntryOwnershipRules)');
    expect(verifier).toContain('local root declaration entry ownership boundary passed');
    expect(verifier).toContain('agentSdkRootSubagentCompatibilityBoundaryRules');
    expect(verifier).toContain("rule.file === 'dist/index.js'");
    expect(verifier).toContain("rule.file === 'dist/index.d.ts'");
    expect(verifier).toContain('local root subagent compatibility boundary passed');
    expect(verifier).toContain('toLocalForbiddenDeclarationRules(agentSdkSessionPublicDeclarationBoundaryRules)');
    expect(verifier).toContain('local session declaration public boundary passed');
    expect(verifier).toContain('agentSdkSessionEntrySessionBoundaryRules');
    expect(verifier).toContain("rule.file === 'dist/session/index.d.ts'");
    expect(verifier).toContain("rule.file === 'dist/session/index.js'");
    expect(verifier).toContain("rule.file === 'dist/session/Session.d.ts'");
    expect(verifier).toContain('local session entry Session boundary passed');
    expect(verifier).toContain('toLocalForbiddenDeclarationRules(agentSdkSessionFactoryDeclarationBoundaryRules)');
    expect(verifier).toContain('local session factory declaration boundary passed');
    expect(verifier).toContain('toLocalForbiddenDeclarationRules(agentSdkSessionConfigDeclarationBoundaryRules)');
    expect(verifier).toContain('local session config declaration boundary passed');
    expect(verifier).toContain('toLocalForbiddenDeclarationRules(agentSdkSessionStoreDeclarationBoundaryRules)');
    expect(verifier).toContain('local session store declaration boundary passed');
    expect(verifier).toContain('agentSdkToolsEntryBoundaryRules');
    expect(verifier).toContain("rule.file === 'dist/tools/index.d.ts'");
    expect(verifier).toContain("rule.file === 'dist/tools/index.js'");
    expect(verifier).toContain('local tools entry boundary passed');
    expect(verifier).toContain('agentSdkLocalAdapterBoundaryRules');
    expect(verifier).toContain("rule.file === 'dist/local/index.d.ts'");
    expect(verifier).toContain("rule.file === 'dist/local/index.js'");
    expect(verifier).toContain('local adapter entry boundary passed');
    expect(verifier).toContain('toLocalForbiddenDeclarationRules(agentSdkPermissionDeclarationBoundaryRules)');
    expect(verifier).toContain('local permission declaration boundary passed');
    expect(verifier).toContain('for (const rule of agentSdkServerFacadeBoundaryRules)');
    expect(verifier).toContain('toLocalForbiddenDeclarationRules([rule])');
    expect(verifier).toContain('local server facade boundary passed');
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

  it('centralizes agent public type contract imports across entrypoint verifiers', () => {
    const helperPath = 'scripts/public-type-contracts.mjs';
    const localVerifier = readFileSync('scripts/verify-entrypoints.mjs', 'utf-8');
    const packageVerifier = readFileSync('scripts/verify-packages.mjs', 'utf-8');
    const publishedVerifier = readFileSync('scripts/verify-published.mjs', 'utf-8');

    expect(existsSync(helperPath)).toBe(true);
    const helper = readFileSync(helperPath, 'utf-8');

    expect(localVerifier).toContain("from './public-type-contracts.mjs';");
    expect(localVerifier).toContain('createAgentPublicTypeImportLines');
    expect(packageVerifier).toContain("from './public-type-contracts.mjs';");
    expect(packageVerifier).toContain('createAgentPublicTypeImportBlock');
    expect(publishedVerifier).toContain("from './public-type-contracts.mjs';");
    expect(publishedVerifier).toContain('createAgentPublicTypeImportBlock');
    expect(localVerifier).toContain("...createAgentPublicTypeImportLines('localDeclaration')");
    expect(packageVerifier).toContain("$" + "{createAgentPublicTypeImportBlock('packedConsumer')}");
    expect(publishedVerifier).toContain("$" + "{createAgentPublicTypeImportBlock('publishedConsumer')}");

    expect(helper).toContain('localDeclaration');
    expect(helper).toContain('packedConsumer');
    expect(helper).toContain('publishedConsumer');
    expect(helper).toContain("import type { AgentKernelOptions, AgentTurnInput } from '@blade-ai/agent/kernel';");
    expect(helper).toContain("import type { AgentStreamEvent } from '@blade-ai/agent/protocol';");
    expect(helper).toContain(
      "import type { AgentToolCall, AgentToolResult } from '@blade-ai/agent/protocol';",
    );
    expect(helper).toContain(
      "import type { AgentTraceEvent, AgentTracePort, BufferedAgentTracePort, BufferedAgentTracePortOptions } from '@blade-ai/agent/tracing';",
    );
    expect(localVerifier).toContain('const agentToolResult: AgentToolResult');
    expect(localVerifier).toContain('const agentTurnInput: AgentTurnInput');
    expect(localVerifier).toContain('const bufferedAgentTracePort: BufferedAgentTracePort');
    expect(helper).not.toContain("from '@blade-ai/agent';");
  });

  it('centralizes ai public type contract imports across entrypoint verifiers', () => {
    const helperPath = 'scripts/public-type-contracts.mjs';
    const localVerifier = readFileSync('scripts/verify-entrypoints.mjs', 'utf-8');
    const packageVerifier = readFileSync('scripts/verify-packages.mjs', 'utf-8');
    const publishedVerifier = readFileSync('scripts/verify-published.mjs', 'utf-8');
    const helper = readFileSync(helperPath, 'utf-8');

    expect(localVerifier).toContain("from './public-type-contracts.mjs';");
    expect(localVerifier).toContain('createAiPublicTypeImportLines');
    expect(packageVerifier).toContain("from './public-type-contracts.mjs';");
    expect(packageVerifier).toContain('createAiPublicTypeImportBlock');
    expect(publishedVerifier).toContain("from './public-type-contracts.mjs';");
    expect(publishedVerifier).toContain('createAiPublicTypeImportBlock');
    expect(localVerifier).toContain("...createAiPublicTypeImportLines('localDeclaration')");
    expect(packageVerifier).toContain("$" + "{createAiPublicTypeImportBlock('packedConsumer')}");
    expect(publishedVerifier).toContain("$" + "{createAiPublicTypeImportBlock('publishedConsumer')}");

    expect(helper).toContain('aiPublicTypeImportContracts');
    expect(helper).toContain(
      "import type { ModelPort, ModelRequest, ModelResponse, ModelStreamEvent, UsageInfo as ModelUsageInfo } from '@blade-ai/ai/model';",
    );
    expect(localVerifier).toContain('const modelRequest: ModelRequest');
    expect(localVerifier).toContain('const modelStreamEvent: ModelStreamEvent');
    expect(helper).toContain(
      "import type { ChatConfig, ChatResponse, Message as ChatMessage, StreamChunk as ChatStreamChunk, UsageInfo as ChatUsageInfo } from '@blade-ai/ai/chat';",
    );
    expect(localVerifier).toContain('const chatMessage: ChatMessage');
    expect(localVerifier).toContain('const chatStreamChunk: ChatStreamChunk');
    expect(helper).toContain("import type { RetryConfig } from '@blade-ai/ai/retry';");
    expect(helper).toContain(
      "import type { OpenAICompatibleModelPortOptions } from '@blade-ai/ai/providers/openai-compatible';",
    );
    expect(helper).toContain("import type { VercelLanguageModelOptions } from '@blade-ai/ai/providers/vercel';");
    expect(helper).toContain("import type { DeepSeekCostBreakdown, DeepSeekProviderOptions }");
    expect(helper).toContain("from '@blade-ai/ai/deepseek';");
  });

  it('centralizes agent-sdk public type contract imports across entrypoint verifiers', () => {
    const helperPath = 'scripts/public-type-contracts.mjs';
    const localVerifier = readFileSync('scripts/verify-entrypoints.mjs', 'utf-8');
    const packageVerifier = readFileSync('scripts/verify-packages.mjs', 'utf-8');
    const publishedVerifier = readFileSync('scripts/verify-published.mjs', 'utf-8');
    const helper = readFileSync(helperPath, 'utf-8');

    expect(localVerifier).toContain('createSdkPublicTypeImportLines');
    expect(packageVerifier).toContain('createSdkPublicTypeImportBlock');
    expect(publishedVerifier).toContain('createSdkPublicTypeImportBlock');
    expect(localVerifier).toContain("...createSdkPublicTypeImportLines('localDeclaration')");
    expect(packageVerifier).toContain("$" + "{createSdkPublicTypeImportBlock('packedConsumer')}");
    expect(publishedVerifier).toContain("$" + "{createSdkPublicTypeImportBlock('publishedConsumer')}");

    expect(helper).toContain('sdkPublicTypeImportContracts');
    expect(helper).toContain("import type { SessionOptions, StreamMessage } from '@blade-ai/agent-sdk';");
    expect(helper).toContain("import type { RuntimeContext } from '@blade-ai/agent-sdk/core';");
    expect(helper).toContain("import type { ISession } from '@blade-ai/agent-sdk/session';");
    expect(helper).toContain("import type { ToolDefinition } from '@blade-ai/agent-sdk/tools';");
    expect(helper).toContain("import type { BuiltinToolsOptions } from '@blade-ai/agent-sdk/local';");
    expect(helper).toContain("ClaudeCodePermissionMode");
    expect(helper).toContain("SubagentExecutionRunner");
    expect(helper).toContain("StreamMessage as BrowserStreamMessage");
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
