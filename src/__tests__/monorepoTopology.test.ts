import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackageJson {
  name?: string;
  private?: boolean;
  main?: string;
  types?: string;
  workspaces?: unknown;
  exports?: Record<string, unknown>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  compilerOptions?: {
    rootDir?: string;
    declarationMap?: boolean;
    paths?: Record<string, string[]>;
  };
  files?: string[];
  include?: string[];
  exclude?: string[];
  publishConfig?: Record<string, unknown>;
}

function readJson(path: string): PackageJson {
  return JSON.parse(readFileSync(path, 'utf-8')) as PackageJson;
}

describe('monorepo topology', () => {
  it('declares packages workspace and keeps root as a private orchestrator', () => {
    const root = readJson('package.json');
    const workspace = readFileSync('pnpm-workspace.yaml', 'utf-8');

    expect(root.private).toBe(true);
    expect(root.main).toBeUndefined();
    expect(root.types).toBeUndefined();
    expect(root.exports).toBeUndefined();
    expect(root.files).toBeUndefined();
    expect(root.publishConfig).toBeUndefined();
    expect(root.dependencies).toBeUndefined();
    expect(root.optionalDependencies).toBeUndefined();
    expect(workspace).toContain('packages:');
    expect(workspace).toContain("'packages/*'");
  });

  it('keeps root build orchestration out of root dist output', () => {
    const root = readJson('package.json');

    expect(root.scripts?.build).toBe('pnpm --filter @blade-ai/agent-sdk run build');
    expect(root.scripts?.build).not.toContain('tsup');
    expect(root.scripts?.build).not.toContain('tsconfig.build.json');
  });

  it('does not keep obsolete root package build configs', () => {
    expect(existsSync('tsup.config.ts')).toBe(false);
    expect(existsSync('tsconfig.build.json')).toBe(false);
  });

  it('contains ai, agent, and agent-sdk packages with source entrypoints', () => {
    const expectedPackages = [
      ['packages/ai', '@blade-ai/ai'],
      ['packages/agent', '@blade-ai/agent'],
      ['packages/agent-sdk', '@blade-ai/agent-sdk'],
    ] as const;

    for (const [dir, name] of expectedPackages) {
      expect(existsSync(join(dir, 'package.json')), `${dir}/package.json`).toBe(true);
      expect(existsSync(join(dir, 'src/index.ts')), `${dir}/src/index.ts`).toBe(true);
      expect(readJson(join(dir, 'package.json')).name).toBe(name);
    }
  });

  it('exposes package metadata subpaths for every publishable package', () => {
    for (const [dir, packageJsonPath] of [
      ['packages/ai', './package.json'],
      ['packages/agent', './package.json'],
      ['packages/agent-sdk', './package.json'],
    ] as const) {
      const pkg = readJson(join(dir, 'package.json'));

      expect(pkg.exports?.['./package.json'], `${dir} ./package.json export`).toEqual({
        default: packageJsonPath,
      });
    }
  });

  it('makes agent-sdk depend on ai and agent through workspace protocol', () => {
    const sdk = readJson('packages/agent-sdk/package.json');

    expect(sdk.dependencies).toMatchObject({
      '@blade-ai/agent': 'workspace:*',
      '@blade-ai/ai': 'workspace:*',
    });
  });

  it('keeps package builds isolated from the root package config', () => {
    for (const dir of ['packages/ai', 'packages/agent', 'packages/agent-sdk']) {
      const pkg = readJson(join(dir, 'package.json'));

      expect(existsSync(join(dir, 'tsup.config.ts')), `${dir}/tsup.config.ts`).toBe(true);
      expect(existsSync(join(dir, 'tsconfig.build.json')), `${dir}/tsconfig.build.json`).toBe(true);
      expect(pkg.scripts?.build).toContain('tsup --config tsup.config.ts');
      expect(pkg.scripts?.build).toContain('tsc -p tsconfig.build.json');
    }
  });

  it('emits agent-sdk build declarations from package-local source only', () => {
    const buildConfig = readJson('packages/agent-sdk/tsconfig.build.json');

    expect(buildConfig.compilerOptions?.rootDir).toBe('./src');
    expect(buildConfig.include).toEqual(['src/**/*']);
    expect(buildConfig.compilerOptions?.paths).toMatchObject({
      '@blade-ai/agent': ['../agent/dist/index.d.ts'],
      '@blade-ai/agent/budget': ['../agent/dist/budget/TokenBudget.d.ts'],
      '@blade-ai/ai': ['../ai/dist/index.d.ts'],
      '@blade-ai/ai/deepseek': ['../ai/dist/deepseek/index.d.ts'],
      '@blade-ai/ai/providers/vercel': ['../ai/dist/providers/vercel/index.d.ts'],
    });
    expect(JSON.stringify(buildConfig.compilerOptions?.paths)).not.toContain('@/*');
    expect(JSON.stringify(buildConfig)).not.toContain('../../src');
  });

  it('overlays package-local public declarations for agent-sdk', () => {
    const sdk = readJson('packages/agent-sdk/package.json');
    const publicDts = readJson('packages/agent-sdk/tsconfig.public-dts.json');
    const overlayScript = readFileSync('packages/agent-sdk/scripts/overlay-public-dts.mjs', 'utf-8');

    expect(existsSync('packages/agent-sdk/tsconfig.public-dts.json')).toBe(true);
    expect(existsSync('packages/agent-sdk/scripts/overlay-public-dts.mjs')).toBe(true);
    expect(sdk.scripts?.build).toContain('tsc -p tsconfig.public-dts.json');
    expect(sdk.scripts?.build).toContain('node scripts/overlay-public-dts.mjs');
    expect(publicDts.files).toContain('src/core/index.ts');
    expect(publicDts.files).toContain('src/types/permissions.ts');
    expect(publicDts.files).toContain('src/session/store.ts');
    expect(overlayScript).toContain('local/public-index.d.ts');
    expect(overlayScript).toContain('public-index.js');
    expect(overlayScript).toContain('types/permissions.d.ts.map');
  });

  it('emits agent-sdk public declarations from built package declarations', () => {
    const publicDts = readJson('packages/agent-sdk/tsconfig.public-dts.json');

    expect(publicDts.compilerOptions?.paths).toMatchObject({
      '@blade-ai/agent': ['../agent/dist/index.d.ts'],
      '@blade-ai/agent/budget': ['../agent/dist/budget/TokenBudget.d.ts'],
      '@blade-ai/ai': ['../ai/dist/index.d.ts'],
      '@blade-ai/ai/deepseek': ['../ai/dist/deepseek/index.d.ts'],
    });
    expect(JSON.stringify(publicDts.compilerOptions?.paths)).not.toContain('../../src');
    expect(JSON.stringify(publicDts.compilerOptions?.paths)).not.toContain('../ai/src');
    expect(JSON.stringify(publicDts.compilerOptions?.paths)).not.toContain('../agent/src');
  });

  it('builds the publishable agent-sdk package from its own package manifest', () => {
    const config = readFileSync('packages/agent-sdk/tsup.config.ts', 'utf-8');

    expect(config).toContain("readFileSync('./package.json'");
    expect(config).not.toContain("readFileSync('../../package.json'");
  });

  it('builds the publishable agent-sdk package from package-local source entries', () => {
    const config = readFileSync('packages/agent-sdk/tsup.config.ts', 'utf-8');

    for (const entry of [
      'index',
      'browser/index',
      'browser/server-only-stub',
      'core/index',
      'local/index',
      'server/index',
      'session/index',
      'tools/index',
    ]) {
      const expectedEntry = entry.includes('/')
        ? `'${entry}': 'src/${entry}.ts'`
        : `${entry}: 'src/${entry}.ts'`;
      expect(config, `${entry} should be built from packages/agent-sdk/src`).toContain(
        expectedEntry,
      );
      expect(existsSync(join('packages/agent-sdk/src', `${entry}.ts`)), `${entry}.ts`).toBe(true);
    }

    expect(config).not.toContain('../../src/');
  });

  it('owns browser-safe agent-sdk public entry source inside the package', () => {
    for (const file of [
      'packages/agent-sdk/src/browser/index.ts',
      'packages/agent-sdk/src/browser/server-only-stub.ts',
      'packages/agent-sdk/src/core/index.ts',
    ]) {
      const source = readFileSync(file, 'utf-8');

      expect(source, `${file} should not be a root source wildcard forwarder`).not.toMatch(
        /export \* from ['"]\.\.\/\.\.\/\.\.\/\.\.\/src\//,
      );
    }
  });

  it('owns core json, constant, and permission contracts inside agent-sdk', () => {
    for (const file of [
      'packages/agent-sdk/src/types/common.ts',
      'packages/agent-sdk/src/types/constants.ts',
      'packages/agent-sdk/src/types/permissions.ts',
    ]) {
      expect(existsSync(file), file).toBe(true);
    }

    const coreSource = readFileSync('packages/agent-sdk/src/core/index.ts', 'utf-8');

    expect(coreSource).not.toContain('../../../../src/types/common.js');
    expect(coreSource).not.toContain('../../../../src/types/constants.js');
    expect(coreSource).not.toContain('../../../../src/types/permissions.js');
  });

  it('owns core tool kind and behavior contracts inside agent-sdk', () => {
    expect(existsSync('packages/agent-sdk/src/tools/types/ToolKind.ts')).toBe(true);

    const coreSource = readFileSync('packages/agent-sdk/src/core/index.ts', 'utf-8');
    const permissionsSource = readFileSync('packages/agent-sdk/src/types/permissions.ts', 'utf-8');

    expect(coreSource).not.toContain('../../../../src/tools/types/ToolKind.js');
    expect(permissionsSource).not.toContain('../../../../src/tools/types/ToolKind.js');
  });

  it('owns core tool contracts inside agent-sdk', () => {
    expect(existsSync('packages/agent-sdk/src/tools/types/index.ts')).toBe(true);

    const coreSource = readFileSync('packages/agent-sdk/src/core/index.ts', 'utf-8');
    const permissionsSource = readFileSync('packages/agent-sdk/src/types/permissions.ts', 'utf-8');

    expect(coreSource).not.toContain('../../../../src/tools/types/index.js');
    expect(permissionsSource).not.toContain('../../../../src/tools/types/index.js');
  });

  it('owns the public tools entry source inside agent-sdk', () => {
    const toolsSource = readFileSync('packages/agent-sdk/src/tools/index.ts', 'utf-8');

    expect(toolsSource).not.toContain("export * from '../../../../src/tools/index.js'");
    expect(toolsSource).not.toContain("../../../../src/tools/catalog/ToolCatalog.js");
    expect(toolsSource).not.toContain("../../../../src/tools/core/createTool.js");
    expect(toolsSource).toContain("from './types/index.js'");
    expect(toolsSource).toContain("from './types/ToolKind.js'");
    expect(existsSync('packages/agent-sdk/src/tools/public-index.ts')).toBe(true);
  });

  it('owns node adapter public entry sources inside agent-sdk', () => {
    const serverSource = readFileSync('packages/agent-sdk/src/server/index.ts', 'utf-8');
    const localSource = readFileSync('packages/agent-sdk/src/local/index.ts', 'utf-8');
    const localMemorySource = readFileSync('packages/agent-sdk/src/local/memory.ts', 'utf-8');
    const localMcpSource = readFileSync('packages/agent-sdk/src/local/mcp.ts', 'utf-8');
    const localBuiltinToolsSource = readFileSync(
      'packages/agent-sdk/src/local/builtin-tools.ts',
      'utf-8',
    );
    const localSandboxSource = readFileSync('packages/agent-sdk/src/local/sandbox.ts', 'utf-8');

    expect(serverSource).not.toContain("export * from '../../../../src/server/index.js'");
    expect(serverSource).not.toContain("from '../index.js'");
    expect(serverSource).toContain("from '../session/index.js'");
    expect(serverSource).toContain("from '../core/index.js'");
    expect(serverSource).toContain("from '../tools/index.js'");
    expect(serverSource).toContain("from '../subagents/index.js'");
    expect(localSource).not.toContain("export * from '../../../../src/local/index.js'");
    expect(localSource).not.toContain("../../../../src/");
    expect(localMcpSource).not.toContain('../../../../src/mcp');
    expect(localMemorySource).not.toContain("../../../../src/memory");
    expect(localBuiltinToolsSource).not.toContain('../../../../src/tools/builtin');
    expect(localBuiltinToolsSource).not.toContain('../../../../src/tools/builtin/memory');
    expect(localSandboxSource).not.toContain('../../../../src/sandbox');
    for (const file of [
      'packages/agent-sdk/src/local/mcp.ts',
      'packages/agent-sdk/src/local/memory.ts',
      'packages/agent-sdk/src/local/memoryRead.ts',
      'packages/agent-sdk/src/local/memoryWrite.ts',
      'packages/agent-sdk/src/local/sandbox.ts',
      'packages/agent-sdk/src/local/builtin-tools.ts',
    ]) {
      expect(existsSync(file), file).toBe(true);
    }
    expect(localSource).toContain('createSdkMcpServer');
    expect(localSource).toContain('getBuiltinTools');
    expect(localSource).toContain('SandboxService');
  });

  it('owns the session-first root public entry source inside agent-sdk', () => {
    const rootSource = readFileSync('packages/agent-sdk/src/index.ts', 'utf-8');

    expect(rootSource).not.toContain("export * from '../../../src/index.js'");
    expect(rootSource).not.toContain("../../../src/agent/subagents");
    expect(rootSource).toContain("from './session/index.js'");
    expect(rootSource).toContain("from './tools/index.js'");
    expect(rootSource).toContain("from './core/index.js'");
  });

  it('owns root subagent compatibility exports inside agent-sdk', () => {
    const rootSource = readFileSync('packages/agent-sdk/src/index.ts', 'utf-8');

    for (const file of [
      'packages/agent-sdk/src/subagents/index.ts',
      'packages/agent-sdk/src/subagents/SubagentExecutor.ts',
      'packages/agent-sdk/src/subagents/SubagentRegistry.ts',
      'packages/agent-sdk/src/subagents/types.ts',
    ]) {
      expect(existsSync(file), file).toBe(true);
    }

    expect(rootSource).toContain("from './subagents/index.js'");
  });

  it('owns permission handler runtime factories inside agent-sdk', () => {
    const rootSource = readFileSync('packages/agent-sdk/src/index.ts', 'utf-8');
    const permissionsSource = readFileSync('packages/agent-sdk/src/types/permissions.ts', 'utf-8');

    expect(rootSource).not.toContain("from '../../../src/types/permissions.js'");
    expect(permissionsSource).toContain('createPermissionHandlerFromCanUseTool');
    expect(permissionsSource).toContain('createModePermissionHandler');
    expect(permissionsSource).toContain('createRuleBasedPermissionHandler');
    expect(permissionsSource).toContain('createPathSafetyPermissionHandler');
    expect(permissionsSource).toContain('createCompositePermissionHandler');
  });

  it('organizes the agent package around kernel, budget, loop, protocol, ports, recovery, state, and tracing modules', () => {
    for (const file of [
      'packages/agent/src/kernel/AgentKernel.ts',
      'packages/agent/src/budget/TokenBudget.ts',
      'packages/agent/src/epoch/ExecutionEpoch.ts',
      'packages/agent/src/loop/index.ts',
      'packages/agent/src/loop/AsyncEventQueue.ts',
      'packages/agent/src/loop/decideNoToolTurn.ts',
      'packages/agent/src/loop/decideTurnLimit.ts',
      'packages/agent/src/loop/planToolExecution.ts',
      'packages/agent/src/protocol/index.ts',
      'packages/agent/src/ports/index.ts',
      'packages/agent/src/recovery/index.ts',
      'packages/agent/src/recovery/isOverflowRecoverable.ts',
      'packages/agent/src/state/index.ts',
      'packages/agent/src/state/systemSource.ts',
      'packages/agent/src/tracing/index.ts',
    ]) {
      expect(existsSync(file), file).toBe(true);
    }

    const agentIndexSource = readFileSync('packages/agent/src/index.ts', 'utf-8');
    const agentLoopSource = readFileSync('packages/agent/src/loop/index.ts', 'utf-8');
    const agentRecoverySource = readFileSync('packages/agent/src/recovery/index.ts', 'utf-8');
    const agentStateSource = readFileSync('packages/agent/src/state/index.ts', 'utf-8');

    expect(agentIndexSource).not.toContain('class AgentKernel');
    expect(agentLoopSource).toContain("from './AsyncEventQueue.js'");
    expect(agentLoopSource).toContain("from './decideNoToolTurn.js'");
    expect(agentLoopSource).toContain("from './decideTurnLimit.js'");
    expect(agentLoopSource).toContain("from './planToolExecution.js'");
    expect(agentRecoverySource).toContain("from './isOverflowRecoverable.js'");
    expect(agentStateSource).toContain("from './systemSource.js'");
  });

  it('publishes agent kernel modules as explicit subpath exports', () => {
    const agentPackage = readJson('packages/agent/package.json');
    const agentBuildConfig = readFileSync('packages/agent/tsup.config.ts', 'utf-8');

    expect(agentPackage.exports).toMatchObject({
      './kernel': {
        types: './dist/kernel/AgentKernel.d.ts',
        import: './dist/kernel/AgentKernel.js',
      },
      './loop': {
        types: './dist/loop/index.d.ts',
        import: './dist/loop/index.js',
      },
      './budget': {
        types: './dist/budget/TokenBudget.d.ts',
        import: './dist/budget/TokenBudget.js',
      },
      './epoch': {
        types: './dist/epoch/ExecutionEpoch.d.ts',
        import: './dist/epoch/ExecutionEpoch.js',
      },
      './protocol': {
        types: './dist/protocol/index.d.ts',
        import: './dist/protocol/index.js',
      },
      './ports': {
        types: './dist/ports/index.d.ts',
        import: './dist/ports/index.js',
      },
      './recovery': {
        types: './dist/recovery/index.d.ts',
        import: './dist/recovery/index.js',
      },
      './state': {
        types: './dist/state/index.d.ts',
        import: './dist/state/index.js',
      },
      './tracing': {
        types: './dist/tracing/index.d.ts',
        import: './dist/tracing/index.js',
      },
    });
    expect(agentBuildConfig).toContain('kernel/AgentKernel');
    expect(agentBuildConfig).toContain('loop/index');
    expect(agentBuildConfig).toContain('budget/TokenBudget');
    expect(agentBuildConfig).toContain('epoch/ExecutionEpoch');
    expect(agentBuildConfig).toContain('protocol/index');
    expect(agentBuildConfig).toContain('ports/index');
    expect(agentBuildConfig).toContain('recovery/index');
    expect(agentBuildConfig).toContain('state/index');
    expect(agentBuildConfig).toContain('tracing/index');
  });

  it('owns core observability contracts inside agent-sdk', () => {
    expect(existsSync('packages/agent-sdk/src/observability/types.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/observability/TraceRecorder.ts')).toBe(true);

    const coreSource = readFileSync('packages/agent-sdk/src/core/index.ts', 'utf-8');
    const traceRecorderSource = readFileSync(
      'packages/agent-sdk/src/observability/TraceRecorder.ts',
      'utf-8',
    );

    expect(coreSource).not.toContain('../../../../src/observability/index.js');
    expect(traceRecorderSource).not.toContain('../../../../src/');
    expect(traceRecorderSource).toContain("from './types.js'");
  });

  it('owns core runtime contracts inside agent-sdk', () => {
    expect(existsSync('packages/agent-sdk/src/runtime/types.ts')).toBe(true);

    const coreSource = readFileSync('packages/agent-sdk/src/core/index.ts', 'utf-8');

    expect(coreSource).not.toContain('../../../../src/runtime/index.js');
  });

  it('owns core session stream contracts inside agent-sdk', () => {
    expect(existsSync('packages/agent-sdk/src/session/types.ts')).toBe(true);

    const coreSource = readFileSync('packages/agent-sdk/src/core/index.ts', 'utf-8');

    expect(coreSource).not.toContain('../../../../src/session/types.js');
  });

  it('owns the public session entry source inside agent-sdk', () => {
    const sessionSource = readFileSync('packages/agent-sdk/src/session/index.ts', 'utf-8');
    const sessionConfigSource = readFileSync('packages/agent-sdk/src/session/config.ts', 'utf-8');
    const sessionRuntimeFactorySource = readFileSync(
      'packages/agent-sdk/src/session/runtimeFactory.ts',
      'utf-8',
    );
    const sessionContentSource = readFileSync('packages/agent-sdk/src/session/content.ts', 'utf-8');
    const sessionPendingTurnSource = readFileSync(
      'packages/agent-sdk/src/session/pendingTurn.ts',
      'utf-8',
    );
    const sessionTurnAbortSource = readFileSync(
      'packages/agent-sdk/src/session/turnAbort.ts',
      'utf-8',
    );
    const sessionTurnSource = readFileSync('packages/agent-sdk/src/session/turn.ts', 'utf-8');
    const sessionPromptAccumulatorSource = readFileSync(
      'packages/agent-sdk/src/session/promptStreamAccumulator.ts',
      'utf-8',
    );
    const sessionCleanupSource = readFileSync('packages/agent-sdk/src/session/cleanup.ts', 'utf-8');
    const sessionLifecycleStateSource = readFileSync(
      'packages/agent-sdk/src/session/lifecycle.ts',
      'utf-8',
    );
    const sessionTracesSource = readFileSync('packages/agent-sdk/src/session/traces.ts', 'utf-8');
    const sessionKernelStreamBridgeSource = readFileSync(
      'packages/agent-sdk/src/session/kernelStreamBridge.ts',
      'utf-8',
    );
    const sessionKernelStreamProjectionSource = existsSync(
      'packages/agent-sdk/src/session/kernelStreamProjection.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/kernelStreamProjection.ts', 'utf-8')
      : '';
    const sessionInstanceSource = readFileSync(
      'packages/agent-sdk/src/session/sessionInstance.ts',
      'utf-8',
    );
    const packageLocalRuntimeFactorySource = readFileSync(
      'packages/agent-sdk/src/session/packageLocalRuntimeFactory.ts',
      'utf-8',
    );
    const packageLocalKernelRuntimeFactorySource = readFileSync(
      'packages/agent-sdk/src/session/packageLocalKernelRuntimeFactory.ts',
      'utf-8',
    );
    const defaultKernelRuntimeFactorySource = readFileSync(
      'packages/agent-sdk/src/session/defaultKernelRuntimeFactory.ts',
      'utf-8',
    );
    const kernelModelResolverSource = readFileSync(
      'packages/agent-sdk/src/session/kernelModelResolver.ts',
      'utf-8',
    );
    const kernelFactorySource = readFileSync(
      'packages/agent-sdk/src/session/kernelFactory.ts',
      'utf-8',
    );
    const packageLocalRuntimeInstanceSource = readFileSync(
      'packages/agent-sdk/src/session/runtimeInstance.ts',
      'utf-8',
    );
    const runtimePortsSource = existsSync('packages/agent-sdk/src/session/runtimePorts.ts')
      ? readFileSync('packages/agent-sdk/src/session/runtimePorts.ts', 'utf-8')
      : '';
    const runtimeStateSource = existsSync('packages/agent-sdk/src/session/runtimeState.ts')
      ? readFileSync('packages/agent-sdk/src/session/runtimeState.ts', 'utf-8')
      : '';
    const kernelStreamBridgeSource = readFileSync(
      'packages/agent-sdk/src/session/kernelStreamBridge.ts',
      'utf-8',
    );
    const runtimeMcpToolsSource = existsSync('packages/agent-sdk/src/session/runtimeMcpTools.ts')
      ? readFileSync('packages/agent-sdk/src/session/runtimeMcpTools.ts', 'utf-8')
      : '';
    const runtimeMcpSource = existsSync('packages/agent-sdk/src/session/runtimeMcp.ts')
      ? readFileSync('packages/agent-sdk/src/session/runtimeMcp.ts', 'utf-8')
      : '';
    const runtimeMcpServersSource = existsSync(
      'packages/agent-sdk/src/session/runtimeMcpServers.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimeMcpServers.ts', 'utf-8')
      : '';
    const runtimeSessionLifecycleSource = existsSync(
      'packages/agent-sdk/src/session/runtimeSessionLifecycle.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimeSessionLifecycle.ts', 'utf-8')
      : '';
    const runtimeSessionOperationsSource = existsSync(
      'packages/agent-sdk/src/session/runtimeSessionOperations.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimeSessionOperations.ts', 'utf-8')
      : '';
    const runtimeSessionCapabilitiesSource = existsSync(
      'packages/agent-sdk/src/session/runtimeSessionCapabilities.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimeSessionCapabilities.ts', 'utf-8')
      : '';
    const runtimeCapabilitiesSource = existsSync(
      'packages/agent-sdk/src/session/runtimeCapabilities.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimeCapabilities.ts', 'utf-8')
      : '';
    const runtimeControlsSource = existsSync('packages/agent-sdk/src/session/runtimeControls.ts')
      ? readFileSync('packages/agent-sdk/src/session/runtimeControls.ts', 'utf-8')
      : '';
    const runtimeMcpCapabilitiesSource = existsSync(
      'packages/agent-sdk/src/session/runtimeMcpCapabilities.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimeMcpCapabilities.ts', 'utf-8')
      : '';
    const runtimeForkingSource = existsSync('packages/agent-sdk/src/session/runtimeForking.ts')
      ? readFileSync('packages/agent-sdk/src/session/runtimeForking.ts', 'utf-8')
      : '';
    const runtimeToolFiltersSource = existsSync(
      'packages/agent-sdk/src/session/runtimeToolFilters.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimeToolFilters.ts', 'utf-8')
      : '';
    const runtimeToolRegistrationSource = existsSync(
      'packages/agent-sdk/src/session/runtimeToolRegistration.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimeToolRegistration.ts', 'utf-8')
      : '';
    const runtimeToolsSource = existsSync('packages/agent-sdk/src/session/runtimeTools.ts')
      ? readFileSync('packages/agent-sdk/src/session/runtimeTools.ts', 'utf-8')
      : '';
    const runtimePermissionsSource = existsSync(
      'packages/agent-sdk/src/session/runtimePermissions.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimePermissions.ts', 'utf-8')
      : '';
    const runtimeHooksSource = existsSync('packages/agent-sdk/src/session/runtimeHooks.ts')
      ? readFileSync('packages/agent-sdk/src/session/runtimeHooks.ts', 'utf-8')
      : '';
    const runtimeGuardsSource = existsSync('packages/agent-sdk/src/session/runtimeGuards.ts')
      ? readFileSync('packages/agent-sdk/src/session/runtimeGuards.ts', 'utf-8')
      : '';
    const runtimeTraceManagerSource = existsSync(
      'packages/agent-sdk/src/session/runtimeTraceManager.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimeTraceManager.ts', 'utf-8')
      : '';
    const runtimeExecutionPipelineSource = existsSync(
      'packages/agent-sdk/src/session/runtimeExecutionPipeline.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimeExecutionPipeline.ts', 'utf-8')
      : '';
    const runtimeExecutionSource = existsSync(
      'packages/agent-sdk/src/session/runtimeExecution.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimeExecution.ts', 'utf-8')
      : '';
    const runtimeAgentKernelsSource = existsSync(
      'packages/agent-sdk/src/session/runtimeAgentKernels.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimeAgentKernels.ts', 'utf-8')
      : '';
    const runtimeKernelPortsSource = existsSync(
      'packages/agent-sdk/src/session/runtimeKernelPorts.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimeKernelPorts.ts', 'utf-8')
      : '';
    const runtimeKernelSource = existsSync('packages/agent-sdk/src/session/runtimeKernel.ts')
      ? readFileSync('packages/agent-sdk/src/session/runtimeKernel.ts', 'utf-8')
      : '';
    const runtimeAgentDepsSource = existsSync(
      'packages/agent-sdk/src/session/runtimeAgentDeps.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimeAgentDeps.ts', 'utf-8')
      : '';
    const runtimeKernelTraceFinalizationSource = existsSync(
      'packages/agent-sdk/src/session/runtimeKernelTraceFinalization.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimeKernelTraceFinalization.ts', 'utf-8')
      : '';
    const runtimeKernelTurnStreamSource = existsSync(
      'packages/agent-sdk/src/session/runtimeKernelTurnStream.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimeKernelTurnStream.ts', 'utf-8')
      : '';
    const runtimeTurnSource = existsSync('packages/agent-sdk/src/session/runtimeTurn.ts')
      ? readFileSync('packages/agent-sdk/src/session/runtimeTurn.ts', 'utf-8')
      : '';
    const runtimeKernelModelsSource = existsSync(
      'packages/agent-sdk/src/session/runtimeKernelModels.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimeKernelModels.ts', 'utf-8')
      : '';
    const runtimeNoopPortsSource = existsSync('packages/agent-sdk/src/session/runtimeNoopPorts.ts')
      ? readFileSync('packages/agent-sdk/src/session/runtimeNoopPorts.ts', 'utf-8')
      : '';
    const runtimeBootstrapSource = existsSync('packages/agent-sdk/src/session/runtimeBootstrap.ts')
      ? readFileSync('packages/agent-sdk/src/session/runtimeBootstrap.ts', 'utf-8')
      : '';
    const runtimePortProjectionSource = existsSync(
      'packages/agent-sdk/src/session/runtimePortProjection.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimePortProjection.ts', 'utf-8')
      : '';
    const runtimeConnectionOperationsSource = existsSync(
      'packages/agent-sdk/src/session/runtimeConnectionOperations.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimeConnectionOperations.ts', 'utf-8')
      : '';
    const runtimeSubagentsSource = existsSync('packages/agent-sdk/src/session/runtimeSubagents.ts')
      ? readFileSync('packages/agent-sdk/src/session/runtimeSubagents.ts', 'utf-8')
      : '';
    const runtimeContextSource = existsSync('packages/agent-sdk/src/session/runtimeContext.ts')
      ? readFileSync('packages/agent-sdk/src/session/runtimeContext.ts', 'utf-8')
      : '';
    const runtimeWorkspaceSource = existsSync('packages/agent-sdk/src/session/runtimeWorkspace.ts')
      ? readFileSync('packages/agent-sdk/src/session/runtimeWorkspace.ts', 'utf-8')
      : '';
    const sessionFactorySource = readFileSync('packages/agent-sdk/src/session/factory.ts', 'utf-8');
    const sessionLifecycleSource = readFileSync('packages/agent-sdk/src/session/Session.ts', 'utf-8');
    const sessionStoreSource = readFileSync('packages/agent-sdk/src/session/store.ts', 'utf-8');
    const sessionTypesSource = readFileSync('packages/agent-sdk/src/session/types.ts', 'utf-8');

    expect(sessionSource).not.toContain("export * from '../../../../src/session/index.js'");
    expect(sessionSource).not.toContain("../../../../src/session/Session.js");
    expect(existsSync('packages/agent-sdk/src/session/Session.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/legacySessionAdapter.ts')).toBe(false);
    expect(existsSync('packages/agent-sdk/src/session/config.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/content.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/pendingTurn.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/turnAbort.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/turn.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/promptStreamAccumulator.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/cleanup.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/lifecycle.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/traces.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/legacyStreamEvents.ts')).toBe(false);
    expect(existsSync('packages/agent-sdk/src/session/taskCompleted.ts')).toBe(false);
    expect(existsSync('packages/agent-sdk/src/session/streamCompletion.ts')).toBe(false);
    expect(existsSync('packages/agent-sdk/src/session/promptSubmit.ts')).toBe(false);
    expect(existsSync('packages/agent-sdk/src/session/legacyStreamRunner.ts')).toBe(false);
    expect(existsSync('packages/agent-sdk/src/session/legacyStreamBridge.ts')).toBe(false);
    expect(existsSync('packages/agent-sdk/src/session/packageLocalLegacyRuntimeFactory.ts')).toBe(false);
    expect(existsSync('packages/agent-sdk/src/session/sessionInstance.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/runtimeInstance.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/packageLocalRuntimeFactory.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/store.ts')).toBe(true);
    expect(sessionContentSource).not.toContain('../../../../src/');
    expect(sessionPendingTurnSource).not.toContain('../../../../src/');
    expect(sessionTurnAbortSource).not.toContain('../../../../src/');
    expect(sessionTurnSource).not.toContain('../../../../src/');
    expect(sessionTurnSource).toContain('createSessionContextSnapshot');
    expect(sessionTurnSource).toContain('class SessionTurnController');
    expect(sessionPromptAccumulatorSource).not.toContain('../../../../src/');
    expect(sessionCleanupSource).not.toContain('../../../../src/');
    expect(sessionLifecycleStateSource).not.toContain('../../../../src/');
    expect(sessionTracesSource).not.toContain('../../../../src/');
    expect(sessionTracesSource).toContain('../observability/TraceRecorder.js');
    expect(sessionTracesSource).toContain('createSessionTraceFinalizer');
    expect(existsSync('packages/agent-sdk/src/session/kernelStreamBridge.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/kernelStreamProjection.ts')).toBe(true);
    expect(sessionKernelStreamBridgeSource).not.toContain('../../../../src/');
    expect(sessionKernelStreamBridgeSource).toContain('createKernelStreamTurnBridge');
    expect(sessionKernelStreamBridgeSource).toContain('streamAgentKernelTurn');
    expect(sessionKernelStreamBridgeSource).toContain('getUserMessageText');
    expect(sessionKernelStreamProjectionSource).not.toContain('../../../../src/');
    expect(sessionKernelStreamProjectionSource).toContain(
      'projectPackageLocalKernelEventToStreamMessages',
    );
    expect(sessionInstanceSource).not.toContain('../../../../src/');
    expect(sessionInstanceSource).toContain('class PackageLocalSession');
    expect(sessionInstanceSource).not.toContain('PackageLocalSessionDelegate');
    expect(sessionInstanceSource).not.toContain('delegate?:');
    expect(sessionInstanceSource).not.toContain('this.delegate');
    expect(existsSync('packages/agent-sdk/src/session/legacySessionDelegate.ts')).toBe(false);
    expect(packageLocalRuntimeFactorySource).not.toContain('../../../../src/');
    expect(packageLocalRuntimeFactorySource).toContain('createPackageLocalSessionRuntimeFactory');
    expect(packageLocalRuntimeInstanceSource).not.toContain('../../../../src/');
    expect(packageLocalRuntimeInstanceSource).toContain('class PackageLocalSessionRuntime');
    expect(existsSync('packages/agent-sdk/src/session/runtimePorts.ts')).toBe(true);
    expect(runtimePortsSource).not.toContain('../../../../src/');
    expect(runtimePortsSource).toContain('interface PackageLocalSessionRuntimeOptions');
    expect(runtimePortsSource).toContain('interface PackageLocalRuntimeMcpRegistryPort');
    expect(runtimePortsSource).toContain('interface PackageLocalRuntimeToolCatalogPort');
    expect(runtimePortsSource).toContain('interface PackageLocalRuntimeSubagentRegistryPort');
    expect(packageLocalRuntimeInstanceSource).toContain("from './runtimePorts.js'");
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'export interface PackageLocalRuntimeSessionStorePort',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'export interface PackageLocalRuntimeMcpRegistryPort',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'export interface PackageLocalRuntimeToolCatalogPort',
    );
    expect(existsSync('packages/agent-sdk/src/session/runtimeNoopPorts.ts')).toBe(true);
    expect(runtimeNoopPortsSource).not.toContain('../../../../src/');
    expect(runtimeNoopPortsSource).toContain('createPackageLocalRuntimeNoopPorts');
    expect(runtimeNoopPortsSource).toContain('resolvePackageLocalRuntimePorts');
    expect(existsSync('packages/agent-sdk/src/session/runtimeBootstrap.ts')).toBe(true);
    expect(runtimeBootstrapSource).not.toContain('../../../../src/');
    expect(runtimeBootstrapSource).toContain('createPackageLocalRuntimeBootstrap');
    expect(runtimeBootstrapSource).toContain('createPackageLocalRuntimeInitialState');
    expect(runtimeBootstrapSource).toContain('resolvePackageLocalRuntimePorts');
    expect(packageLocalRuntimeInstanceSource).toContain('createPackageLocalRuntimeBootstrap');
    expect(packageLocalRuntimeInstanceSource).not.toContain('resolvePackageLocalRuntimePorts');
    expect(existsSync('packages/agent-sdk/src/session/runtimePortProjection.ts')).toBe(true);
    expect(runtimePortProjectionSource).not.toContain('../../../../src/');
    expect(runtimePortProjectionSource).toContain('projectPackageLocalRuntimePortFields');
    expect(packageLocalRuntimeInstanceSource).toContain('projectPackageLocalRuntimePortFields');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'this.sessionStore = runtimePorts.sessionStore',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'this.kernelModelResolver = runtimePorts.kernelModelResolver',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('const noopPorts');
    expect(packageLocalRuntimeInstanceSource).not.toContain('?? noopPorts.');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'this.hookManager = options.hookManager ?? this.hookRuntime',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('function createNoopRuntime');
    expect(existsSync('packages/agent-sdk/src/session/runtimeState.ts')).toBe(true);
    expect(runtimeStateSource).not.toContain('../../../../src/');
    expect(runtimeStateSource).toContain('createPackageLocalRuntimeInitialState');
    expect(runtimeStateSource).toContain('resolvePackageLocalRuntimeStorageRoot');
    expect(runtimeStateSource).toContain('getPackageLocalRuntimeContextCwd');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeInitialState',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'resolvePackageLocalRuntimeStorageRoot(options.options.storagePath)',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'getPackageLocalRuntimeContextCwd(options.defaultContext)',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'this.hookCallbacks = options.options.hooks ?? {}',
    );
    expect(existsSync('packages/agent-sdk/src/session/runtimeConnectionOperations.ts')).toBe(true);
    expect(runtimeConnectionOperationsSource).not.toContain('../../../../src/');
    expect(runtimeConnectionOperationsSource).toContain(
      'createPackageLocalRuntimeConnectionOperations',
    );
    expect(runtimeConnectionOperationsSource).toContain(
      'createPackageLocalRuntimeSessionOperations',
    );
    expect(runtimeConnectionOperationsSource).toContain(
      'createPackageLocalRuntimeMcpOperations',
    );
    expect(packageLocalRuntimeInstanceSource).toContain(
      'createPackageLocalRuntimeConnectionOperations',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeSessionOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeMcpOperations({',
    );
    expect(existsSync('packages/agent-sdk/src/session/runtimeContext.ts')).toBe(true);
    expect(runtimeContextSource).not.toContain('../../../../src/');
    expect(runtimeContextSource).toContain('resolvePackageLocalRuntimeStorageRoot');
    expect(runtimeContextSource).toContain('getPackageLocalRuntimeContextCwd');
    expect(packageLocalRuntimeInstanceSource).not.toContain('function getRuntimeContextCwd');
    expect(packageLocalRuntimeInstanceSource).toContain('isPackageLocalSdkMcpServerHandle');
    expect(existsSync('packages/agent-sdk/src/session/runtimeMcpServers.ts')).toBe(true);
    expect(runtimeMcpServersSource).not.toContain('../../../../src/');
    expect(runtimeMcpServersSource).toContain('isPackageLocalSdkMcpServerHandle');
    expect(runtimeMcpServersSource).toContain('callPackageLocalMcpRegistryAction');
    expect(runtimeMcpServersSource).toContain('registerPackageLocalInProcessMcpServer');
    expect(runtimeMcpServersSource).toContain('registerPackageLocalRemoteMcpServer');
    expect(runtimeMcpServersSource).toContain('registerPackageLocalConfiguredMcpServers');
    expect(runtimeMcpServersSource).toContain(
      'createPackageLocalRuntimeMcpServerConfigOperations',
    );
    expect(runtimeMcpServersSource).toContain(
      'createPackageLocalRuntimeMcpServerOperations',
    );
    expect(existsSync('packages/agent-sdk/src/session/runtimeMcp.ts')).toBe(true);
    expect(runtimeMcpSource).not.toContain('../../../../src/');
    expect(runtimeMcpSource).toContain('createPackageLocalRuntimeMcpOperations');
    expect(runtimeMcpSource).toContain('createPackageLocalRuntimeMcpCapabilityOperations');
    expect(runtimeMcpSource).toContain('createPackageLocalRuntimeMcpServerOperations');
    expect(runtimeMcpSource).toContain('createPackageLocalRuntimeMcpToolRefreshOperations');
    expect(packageLocalRuntimeInstanceSource).toContain(
      'private readonly connectionOperations: PackageLocalRuntimeConnectionOperations<SessionMessage>',
    );
    expect(runtimeConnectionOperationsSource).toContain(
      'createPackageLocalRuntimeMcpOperations',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeMcpOperations',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('connectionOperations.mcp.capabilities');
    expect(packageLocalRuntimeInstanceSource).toContain('connectionOperations.mcp.servers');
    expect(packageLocalRuntimeInstanceSource).toContain('connectionOperations.mcp.tools');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'private readonly mcpOperations',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('mcpCapabilityOperations');
    expect(packageLocalRuntimeInstanceSource).not.toContain('mcpServerConfigOperations');
    expect(packageLocalRuntimeInstanceSource).not.toContain('mcpServerRegistrationOperations');
    expect(packageLocalRuntimeInstanceSource).not.toContain('mcpServerLifecycleOperations');
    expect(packageLocalRuntimeInstanceSource).not.toContain('mcpToolRefreshOperations');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeMcpCapabilityOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeMcpServerOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeMcpServerConfigOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('this.options.mcpServers ?? {}');
    expect(runtimeMcpServersSource).toContain(
      'createPackageLocalRuntimeMcpServerRegistrationOperations',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeMcpServerRegistrationOperations({',
    );
    expect(runtimeMcpServersSource).toContain('ensurePackageLocalMcpServerRegistered');
    expect(runtimeMcpServersSource).toContain('closePackageLocalRuntimeMcpServers');
    expect(runtimeMcpServersSource).toContain('connectPackageLocalRuntimeMcpServer');
    expect(runtimeMcpServersSource).toContain('disconnectPackageLocalRuntimeMcpServer');
    expect(runtimeMcpServersSource).toContain('reconnectPackageLocalRuntimeMcpServer');
    expect(runtimeMcpServersSource).toContain(
      'createPackageLocalRuntimeMcpServerLifecycleOperations',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('this.connectionOperations.mcp.servers.lifecycle');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeMcpServerLifecycleOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'connectPackageLocalRuntimeMcpServer({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'disconnectPackageLocalRuntimeMcpServer({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'reconnectPackageLocalRuntimeMcpServer({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'function isPackageLocalSdkMcpServerHandle',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('ensureSessionCreated');
    expect(packageLocalRuntimeInstanceSource).toContain('ensureSessionLoaded');
    expect(existsSync('packages/agent-sdk/src/session/runtimeSessionLifecycle.ts')).toBe(true);
    expect(runtimeSessionLifecycleSource).not.toContain('../../../../src/');
    expect(runtimeSessionLifecycleSource).toContain(
      'createPackageLocalRuntimeSessionLifecycleOperations',
    );
    expect(runtimeSessionLifecycleSource).toContain('runSessionStart(isResume)');
    expect(runtimeSessionLifecycleSource).toContain('closeRuntimeResources');
    expect(packageLocalRuntimeInstanceSource).not.toContain('this.hookRuntime.runSessionStart');
    expect(packageLocalRuntimeInstanceSource).not.toContain('this.hookRuntime.runSessionEnd');
    expect(existsSync('packages/agent-sdk/src/session/runtimeSessionOperations.ts')).toBe(true);
    expect(runtimeSessionOperationsSource).not.toContain('../../../../src/');
    expect(runtimeSessionOperationsSource).toContain(
      'createPackageLocalRuntimeSessionOperations',
    );
    expect(runtimeSessionOperationsSource).toContain(
      'createPackageLocalRuntimeSessionLifecycleOperations',
    );
    expect(runtimeSessionOperationsSource).toContain(
      'createPackageLocalRuntimeWorkspaceOperations',
    );
    expect(runtimeConnectionOperationsSource).toContain(
      'createPackageLocalRuntimeSessionOperations',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeSessionOperations',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('connectionOperations.session.lifecycle');
    expect(packageLocalRuntimeInstanceSource).toContain('connectionOperations.session.workspace');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'private readonly sessionOperations',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('sessionLifecycleOperations');
    expect(packageLocalRuntimeInstanceSource).not.toContain('workspaceOperations');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeSessionLifecycleOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeSessionStorePort');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'const loaded = await this.sessionStore.loadSession(this.sessionId)',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'return this.sessionStore.loadMessages(this.sessionId)',
    );
    expect(existsSync('packages/agent-sdk/src/session/runtimeForking.ts')).toBe(true);
    expect(runtimeForkingSource).not.toContain('../../../../src/');
    expect(runtimeForkingSource).toContain('forkPackageLocalRuntimeSession');
    expect(runtimeForkingSource).toContain('createPackageLocalRuntimeForkOperations');
    expect(existsSync('packages/agent-sdk/src/session/runtimeSessionCapabilities.ts')).toBe(true);
    expect(runtimeSessionCapabilitiesSource).not.toContain('../../../../src/');
    expect(runtimeSessionCapabilitiesSource).toContain(
      'createPackageLocalRuntimeSessionCapabilityOperations',
    );
    expect(runtimeSessionCapabilitiesSource).toContain(
      'createPackageLocalRuntimeSubagentOperations',
    );
    expect(runtimeSessionCapabilitiesSource).toContain('createPackageLocalRuntimeForkOperations');
    expect(packageLocalRuntimeInstanceSource).toContain(
      'createPackageLocalRuntimeSessionCapabilityOperations',
    );
    expect(packageLocalRuntimeInstanceSource).toContain(
      'private readonly sessionCapabilityOperations: PackageLocalRuntimeSessionCapabilityOperations',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('sessionCapabilityOperations.subagents');
    expect(packageLocalRuntimeInstanceSource).toContain('sessionCapabilityOperations.fork');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'private readonly subagentOperations',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('private readonly forkOperations');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeForkOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'forkPackageLocalRuntimeSession({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'this.sessionStore.forkState(this.sessionId, options)',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'this.sessionStore.writeForkState(forkedSessionId, snapshot)',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('this.createForkSessionId()');
    expect(packageLocalRuntimeInstanceSource).toContain('prepareTurn');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeWorkspacePort');
    expect(existsSync('packages/agent-sdk/src/session/runtimeWorkspace.ts')).toBe(true);
    expect(runtimeWorkspaceSource).not.toContain('../../../../src/');
    expect(runtimeWorkspaceSource).toContain('preparePackageLocalRuntimeWorkspaceTurn');
    expect(runtimeWorkspaceSource).toContain(
      'createPackageLocalRuntimeWorkspaceOperations',
    );
    expect(packageLocalRuntimeInstanceSource).toContain(
      'this.connectionOperations.session.workspace.prepareTurn',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeWorkspaceOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'preparePackageLocalRuntimeWorkspaceTurn({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('this.workspace.updateWorkspace({');
    expect(packageLocalRuntimeInstanceSource).not.toContain('...snapshot.environment');
    expect(packageLocalRuntimeInstanceSource).toContain('close');
    expect(runtimePortsSource).toContain('PackageLocalRuntimeMcpRegistryPort');
    expect(runtimeMcpServersSource).toContain('closePackageLocalRuntimeMcpServers');
    expect(packageLocalRuntimeInstanceSource).not.toContain('closePackageLocalRuntimeMcpServers({');
    expect(packageLocalRuntimeInstanceSource).not.toContain('this.mcpRegistry.disconnectAll()');
    expect(packageLocalRuntimeInstanceSource).toContain('mcpCapabilities');
    expect(packageLocalRuntimeInstanceSource).toContain('mcpServerStatus');
    expect(packageLocalRuntimeInstanceSource).toContain('mcpListTools');
    expect(packageLocalRuntimeInstanceSource).toContain('mcpConnect');
    expect(packageLocalRuntimeInstanceSource).toContain('mcpDisconnect');
    expect(packageLocalRuntimeInstanceSource).toContain('mcpReconnect');
    expect(runtimePortsSource).toContain('ensureServerRegistered');
    expect(packageLocalRuntimeInstanceSource).not.toContain('ensurePackageLocalMcpServerRegistered');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      "callPackageLocalMcpRegistryAction(this.mcpRegistry, 'connectServer', serverName)",
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      "callPackageLocalMcpRegistryAction(this.mcpRegistry, 'disconnectServer', serverName)",
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      "callPackageLocalMcpRegistryAction(this.mcpRegistry, 'reconnectServer', serverName)",
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('private async ensureMcpServerRegistered');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeMcpServerCapability');
    expect(existsSync('packages/agent-sdk/src/session/runtimeMcpCapabilities.ts')).toBe(true);
    expect(runtimeMcpCapabilitiesSource).not.toContain('../../../../src/');
    expect(runtimeMcpCapabilitiesSource).toContain(
      'projectPackageLocalRuntimeMcpServerStatus',
    );
    expect(runtimeMcpCapabilitiesSource).toContain('listPackageLocalRuntimeMcpTools');
    expect(runtimeMcpCapabilitiesSource).toContain(
      'createPackageLocalRuntimeMcpCapabilityOperations',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('connectionOperations.mcp.capabilities');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeMcpCapabilityOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'projectPackageLocalRuntimeMcpServerStatus',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('listPackageLocalRuntimeMcpTools');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'return this.mcpRegistry.getCapabilities()',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'projectPackageLocalRuntimeMcpServerStatus(await this.mcpCapabilities())',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'listPackageLocalRuntimeMcpTools(await this.mcpCapabilities())',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'capability.tools.map((tool) => tool.name)',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('.flatMap((capability)');
    expect(packageLocalRuntimeInstanceSource).toContain('filterTools');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeNamedTool');
    expect(existsSync('packages/agent-sdk/src/session/runtimeToolFilters.ts')).toBe(true);
    expect(runtimeToolFiltersSource).not.toContain('../../../../src/');
    expect(runtimeToolFiltersSource).toContain('filterPackageLocalRuntimeTools');
    expect(runtimeToolFiltersSource).toContain(
      'createPackageLocalRuntimeToolFilterOperations',
    );
    expect(existsSync('packages/agent-sdk/src/session/runtimeTools.ts')).toBe(true);
    expect(runtimeToolsSource).not.toContain('../../../../src/');
    expect(runtimeToolsSource).toContain('createPackageLocalRuntimeToolOperations');
    expect(runtimeToolsSource).toContain('createPackageLocalRuntimeToolFilterOperations');
    expect(runtimeToolsSource).toContain('createPackageLocalRuntimeToolRegistrationOperations');
    expect(runtimeToolsSource).toContain(
      'createPackageLocalRuntimeSessionToolRegistrationOperations',
    );
    expect(runtimeToolFiltersSource).toContain('allowedTools !== undefined');
    expect(packageLocalRuntimeInstanceSource).toContain(
      'private readonly toolOperations: PackageLocalRuntimeToolOperations',
    );
    expect(packageLocalRuntimeInstanceSource).toContain(
      'createPackageLocalRuntimeToolOperations',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeToolFilterOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'filterPackageLocalRuntimeTools(tools, {',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('allowedTools !== undefined');
    expect(packageLocalRuntimeInstanceSource).toContain('registerTools');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeToolCatalogPort');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeToolSource');
    expect(packageLocalRuntimeInstanceSource).toContain('registerConfiguredMcpServers');
    expect(runtimePortsSource).toContain('registerInProcessServer');
    expect(runtimePortsSource).toContain('registerServer');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'registerPackageLocalConfiguredMcpServers({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('private async callMcpRegistryMethod');
    expect(packageLocalRuntimeInstanceSource).not.toContain('private async registerInProcessMcpServer');
    expect(packageLocalRuntimeInstanceSource).not.toContain('private async registerRemoteMcpServer');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeLoggerPort');
    expect(packageLocalRuntimeInstanceSource).toContain('refreshMcpTools');
    expect(packageLocalRuntimeInstanceSource).toContain('this.connectionOperations.mcp.servers.registration');
    expect(packageLocalRuntimeInstanceSource).not.toContain('Object.entries(configuredServers)');
    expect(packageLocalRuntimeInstanceSource).not.toContain('if (config.disabled)');
    expect(runtimePortsSource).toContain('getAvailableToolsByServerNames');
    expect(runtimePortsSource).toContain('registerMcpTool');
    expect(runtimePortsSource).toContain('removeMcpTools');
    expect(existsSync('packages/agent-sdk/src/session/runtimeMcpTools.ts')).toBe(true);
    expect(runtimeMcpToolsSource).not.toContain('../../../../src/');
    expect(runtimeMcpToolsSource).toContain('getPackageLocalMcpToolSourceId');
    expect(runtimeMcpToolsSource).toContain('refreshPackageLocalRuntimeMcpTools');
    expect(runtimeMcpToolsSource).toContain('createPackageLocalRuntimeMcpToolRefreshOperations');
    expect(packageLocalRuntimeInstanceSource).toContain('this.connectionOperations.mcp.tools');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeMcpToolRefreshOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('getPackageLocalMcpToolSourceId');
    expect(packageLocalRuntimeInstanceSource).not.toContain('refreshPackageLocalRuntimeMcpTools({');
    expect(packageLocalRuntimeInstanceSource).not.toContain('removeMcpTools(serverName);');
    expect(packageLocalRuntimeInstanceSource).not.toContain('registerMcpTool(tool,');
    expect(packageLocalRuntimeInstanceSource).not.toContain('function packageLocalServerNameFromTool');
    expect(existsSync('packages/agent-sdk/src/session/runtimeToolRegistration.ts')).toBe(true);
    expect(runtimeToolRegistrationSource).not.toContain('../../../../src/');
    expect(runtimeToolRegistrationSource).toContain('registerPackageLocalRuntimeCustomTools');
    expect(runtimeToolRegistrationSource).toContain('registerPackageLocalRuntimeBuiltinTools');
    expect(runtimeToolRegistrationSource).toContain(
      'createPackageLocalRuntimeToolRegistrationOperations',
    );
    expect(runtimeToolRegistrationSource).toContain(
      'createPackageLocalRuntimeSessionToolRegistrationOperations',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeToolRegistrationOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeSessionToolRegistrationOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('toolOperations.registration');
    expect(packageLocalRuntimeInstanceSource).toContain('toolOperations.sessionRegistration');
    expect(packageLocalRuntimeInstanceSource).toContain('toolOperations.filter');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'private readonly toolRegistrationOperations',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'private readonly sessionToolRegistrationOperations',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'private readonly toolFilterOperations',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'registerPackageLocalRuntimeCustomTools({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'registerPackageLocalRuntimeBuiltinTools({',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('registerCustomTools');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeCustomToolFactoryPort');
    expect(packageLocalRuntimeInstanceSource).not.toContain('filteredTools.length === 0');
    expect(packageLocalRuntimeInstanceSource).not.toContain('this.toolCatalog.registerAll');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      "throw new Error('Package-local custom tool factory port is required to register tools')",
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'definitions.map((definition) => customToolFactory.fromDefinition(definition))',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('registerBuiltinTools');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeBuiltinToolProviderPort');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeBuiltinToolContext');
    expect(packageLocalRuntimeInstanceSource).not.toContain('includeMcpProtocolTools: false');
    expect(packageLocalRuntimeInstanceSource).not.toContain('builtinToolProvider?.getTools');
    expect(packageLocalRuntimeInstanceSource).toContain('initializeSubagents');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeSubagentRegistryPort');
    expect(existsSync('packages/agent-sdk/src/session/runtimeSubagents.ts')).toBe(true);
    expect(runtimeSubagentsSource).not.toContain('../../../../src/');
    expect(runtimeSubagentsSource).toContain('packageLocalSubagentConfigFromDefinition');
    expect(runtimeSubagentsSource).toContain('initializePackageLocalRuntimeSubagents');
    expect(runtimeSubagentsSource).toContain('createPackageLocalRuntimeSubagentOperations');
    expect(packageLocalRuntimeInstanceSource).not.toContain('packageLocalSubagentConfigFromDefinition');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeSubagentOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('sessionCapabilityOperations.subagents');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'initializePackageLocalRuntimeSubagents({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'function packageLocalSubagentConfigFromDefinition',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'this.subagentRegistry.setLogger(this.logger)',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'Object.entries(this.options.agents ?? {})',
    );
    expect(existsSync('packages/agent-sdk/src/session/runtimeCapabilities.ts')).toBe(true);
    expect(runtimeCapabilitiesSource).not.toContain('../../../../src/');
    expect(runtimeCapabilitiesSource).toContain(
      'createPackageLocalRuntimeCapabilityInitializationOperations',
    );
    expect(runtimeCapabilitiesSource).toContain(
      'createPackageLocalRuntimeCapabilityStartupOperations',
    );
    expect(runtimeCapabilitiesSource).toContain(
      'createPackageLocalRuntimeCapabilityOperations',
    );
    expect(runtimeCapabilitiesSource).toContain(
      'runtimeCapabilitiesInitialization',
    );
    expect(runtimeCapabilitiesSource).toContain('subagentLocationsNeedRefresh');
    expect(packageLocalRuntimeInstanceSource).toContain(
      'createPackageLocalRuntimeCapabilityOperations',
    );
    expect(packageLocalRuntimeInstanceSource).toContain(
      'private readonly capabilityOperations: PackageLocalRuntimeCapabilityOperations',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('capabilityOperations.initialization');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'private readonly capabilityInitializationOperations',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('capabilityStartupOperations');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeCapabilityInitializationOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeCapabilityStartupOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'private async initializeRuntimeCapabilities',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'private runtimeCapabilitiesInitialization',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'private runtimeCapabilitiesInitialized',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'private subagentLocationsNeedRefresh',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'this.runtimeCapabilitiesInitialization ??=',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'this.subagentLocationsNeedRefresh = true',
    );
    expect(existsSync('packages/agent-sdk/src/session/runtimeControls.ts')).toBe(true);
    expect(runtimeControlsSource).not.toContain('../../../../src/');
    expect(runtimeControlsSource).toContain('createPackageLocalRuntimeControlOperations');
    expect(runtimeControlsSource).toContain('buildSessionModelConfig');
    expect(runtimeControlsSource).toContain('getPackageLocalRuntimeContextCwd');
    expect(packageLocalRuntimeInstanceSource).toContain('controlOperations');
    expect(packageLocalRuntimeInstanceSource).not.toContain('buildSessionModelConfig');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'this.bladeConfig.models = [modelConfig]',
    );
    expect(runtimeControlsSource).toContain('options.resetExecutionPipeline();');
    expect(packageLocalRuntimeInstanceSource).toContain(
      'resetExecutionPipeline: () => this.executionOperations.pipeline.reset()',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'this.options.maxTurns = maxTurns',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('createPermissionHandler');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimePermissionHookPort');
    expect(existsSync('packages/agent-sdk/src/session/runtimePermissions.ts')).toBe(true);
    expect(runtimePermissionsSource).not.toContain('../../../../src/');
    expect(runtimePermissionsSource).toContain('createPackageLocalRuntimePermissionHandler');
    expect(runtimePermissionsSource).toContain('createPackageLocalRuntimePermissionOperations');
    expect(runtimePermissionsSource).toContain('createPermissionHandlerFromCanUseTool');
    expect(runtimePermissionsSource).toContain('createCompositePermissionHandler');
    expect(existsSync('packages/agent-sdk/src/session/runtimeGuards.ts')).toBe(true);
    expect(runtimeGuardsSource).not.toContain('../../../../src/');
    expect(runtimeGuardsSource).toContain('createPackageLocalRuntimeGuardOperations');
    expect(runtimeGuardsSource).toContain('createPackageLocalRuntimePermissionOperations');
    expect(runtimeGuardsSource).toContain('createPackageLocalRuntimeHookOperations');
    expect(packageLocalRuntimeInstanceSource).toContain(
      'createPackageLocalRuntimeGuardOperations',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('guardOperations.permissions');
    expect(packageLocalRuntimeInstanceSource).toContain(
      'private readonly guardOperations: PackageLocalRuntimeGuardOperations',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'private readonly permissionOperations',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'private readonly hookOperations',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimePermissionHandler({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimePermissionOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('HookEvent.PermissionRequest');
    expect(packageLocalRuntimeInstanceSource).not.toContain('createPermissionHandlerFromCanUseTool');
    expect(packageLocalRuntimeInstanceSource).not.toContain('createCompositePermissionHandler');
    expect(packageLocalRuntimeInstanceSource).toContain('initializeHooks');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeHookManagerPort');
    expect(existsSync('packages/agent-sdk/src/session/runtimeHooks.ts')).toBe(true);
    expect(runtimeHooksSource).not.toContain('../../../../src/');
    expect(runtimeHooksSource).toContain('initializePackageLocalRuntimeHooks');
    expect(runtimeHooksSource).toContain('createPackageLocalRuntimeHookOperations');
    expect(runtimeHooksSource).toContain('streamWithPackageLocalRuntimeTraceCollector');
    expect(packageLocalRuntimeInstanceSource).toContain('guardOperations.hooks');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeHookOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('initializePackageLocalRuntimeHooks({');
    expect(packageLocalRuntimeInstanceSource).not.toContain('this.hookManager.enable()');
    expect(packageLocalRuntimeInstanceSource).not.toContain('Object.keys(this.options.hooks');
    expect(packageLocalRuntimeInstanceSource).not.toContain('this.hookRuntime.setTraceCollector');
    expect(existsSync('packages/agent-sdk/src/session/runtimeTraceManager.ts')).toBe(true);
    expect(runtimeTraceManagerSource).not.toContain('../../../../src/');
    expect(runtimeTraceManagerSource).toContain('createPackageLocalRuntimeTraceManager');
    expect(runtimeTraceManagerSource).toContain('createPackageLocalRuntimeTraceOperations');
    expect(runtimeTraceManagerSource).toContain('createPackageLocalRuntimeTraceRuntime');
    expect(runtimeTraceManagerSource).toContain('new SessionTraceManager({');
    expect(existsSync('packages/agent-sdk/src/session/runtimeTurn.ts')).toBe(true);
    expect(runtimeTurnSource).not.toContain('../../../../src/');
    expect(runtimeTurnSource).toContain('createPackageLocalRuntimeTurnOperations');
    expect(runtimeTurnSource).toContain('createPackageLocalRuntimeTraceRuntime');
    expect(runtimeTurnSource).toContain('createPackageLocalRuntimeKernelTurnStreamOperations');
    expect(packageLocalRuntimeInstanceSource).toContain('createPackageLocalRuntimeTurnOperations');
    expect(packageLocalRuntimeInstanceSource).toContain(
      'private readonly turnOperations: PackageLocalRuntimeTurnOperations',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('turnOperations.kernelTurnStream');
    expect(packageLocalRuntimeInstanceSource).toContain('turnOperations.traceOperations');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'private readonly traceManager',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'private readonly traceOperations',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'private readonly kernelTurnStreamOperations',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeTraceRuntime({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeTraceManager({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeTraceOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('new SessionTraceManager({');
    expect(packageLocalRuntimeInstanceSource).not.toContain('this.traceManager.getLastTrace()');
    expect(packageLocalRuntimeInstanceSource).not.toContain('this.traceManager.getTraces()');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'permissionMode: options.options.permissionMode ?? PermissionMode.DEFAULT',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('Observability trace sink failed');
    expect(packageLocalRuntimeInstanceSource).toContain('createExecutionPipeline');
    expect(packageLocalRuntimeInstanceSource).toContain(
      'PackageLocalRuntimeExecutionPipelineFactoryPort',
    );
    expect(existsSync('packages/agent-sdk/src/session/runtimeExecutionPipeline.ts')).toBe(true);
    expect(runtimeExecutionPipelineSource).not.toContain('../../../../src/');
    expect(runtimeExecutionPipelineSource).toContain('createPackageLocalRuntimeExecutionPipeline');
    expect(runtimeExecutionPipelineSource).toContain(
      'createPackageLocalRuntimeExecutionPipelineCache',
    );
    expect(runtimeExecutionPipelineSource).toContain(
      'createPackageLocalRuntimeExecutionPipelineOperations',
    );
    expect(existsSync('packages/agent-sdk/src/session/runtimeExecution.ts')).toBe(true);
    expect(runtimeExecutionSource).not.toContain('../../../../src/');
    expect(runtimeExecutionSource).toContain('createPackageLocalRuntimeExecutionOperations');
    expect(runtimeExecutionSource).toContain(
      'createPackageLocalRuntimeExecutionPipelineOperations',
    );
    expect(runtimeExecutionSource).toContain('createPackageLocalAgentRuntimeDepsOperations');
    expect(packageLocalRuntimeInstanceSource).toContain(
      'createPackageLocalRuntimeExecutionOperations',
    );
    expect(packageLocalRuntimeInstanceSource).toContain(
      'private readonly executionOperations: PackageLocalRuntimeExecutionOperations',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('executionOperations.pipeline');
    expect(packageLocalRuntimeInstanceSource).toContain('executionOperations.agentDeps');
    expect(packageLocalRuntimeInstanceSource).not.toContain('executionPipelineOperations');
    expect(packageLocalRuntimeInstanceSource).not.toContain('agentRuntimeDepsOperations');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeExecutionPipelineOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeExecutionPipeline({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeExecutionPipelineCache',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('private executionPipelineCreated');
    expect(packageLocalRuntimeInstanceSource).not.toContain('private executionPipeline: unknown');
    expect(packageLocalRuntimeInstanceSource).not.toContain('allow: []');
    expect(packageLocalRuntimeInstanceSource).not.toContain('maxHistorySize: 1000');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'this.executionPipelineFactory.create({',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('getAgentRuntimeDeps');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalAgentRuntimeDeps');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeBackgroundAgentManagerPort');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeHookRuntimePort');
    expect(existsSync('packages/agent-sdk/src/session/runtimeAgentDeps.ts')).toBe(true);
    expect(runtimeAgentDepsSource).not.toContain('../../../../src/');
    expect(runtimeAgentDepsSource).toContain('createPackageLocalAgentRuntimeDeps');
    expect(runtimeAgentDepsSource).toContain('createPackageLocalAgentRuntimeDepsOperations');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalAgentRuntimeDepsOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('createPackageLocalAgentRuntimeDeps({');
    expect(packageLocalRuntimeInstanceSource).not.toContain('runtimeManaged: true');
    expect(packageLocalRuntimeInstanceSource).toContain('getKernelToolPort');
    expect(packageLocalRuntimeInstanceSource).toContain('getKernelStorePort');
    expect(packageLocalRuntimeInstanceSource).toContain('getKernelTracePort');
    expect(packageLocalRuntimeInstanceSource).toContain('getKernelHookPort');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeKernelPortFactoryPort');
    expect(existsSync('packages/agent-sdk/src/session/runtimeKernelPorts.ts')).toBe(true);
    expect(runtimeKernelPortsSource).not.toContain('../../../../src/');
    expect(runtimeKernelPortsSource).toContain('createPackageLocalRuntimeKernelToolPort');
    expect(runtimeKernelPortsSource).toContain('createPackageLocalRuntimeKernelStorePort');
    expect(runtimeKernelPortsSource).toContain('createPackageLocalRuntimeKernelTracePort');
    expect(runtimeKernelPortsSource).toContain('createPackageLocalRuntimeKernelHookPort');
    expect(runtimeKernelPortsSource).toContain('createPackageLocalRuntimeKernelPortOperations');
    expect(existsSync('packages/agent-sdk/src/session/runtimeKernel.ts')).toBe(true);
    expect(runtimeKernelSource).not.toContain('../../../../src/');
    expect(runtimeKernelSource).toContain('createPackageLocalRuntimeKernelOperations');
    expect(runtimeKernelSource).toContain('createPackageLocalRuntimeKernelPortOperations');
    expect(runtimeKernelSource).toContain('createPackageLocalRuntimeAgentKernelOperations');
    expect(packageLocalRuntimeInstanceSource).toContain(
      'createPackageLocalRuntimeKernelOperations',
    );
    expect(packageLocalRuntimeInstanceSource).toContain(
      'private readonly kernelOperations: PackageLocalRuntimeKernelOperations',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('kernelOperations.ports');
    expect(packageLocalRuntimeInstanceSource).toContain('kernelOperations.agentKernel');
    expect(packageLocalRuntimeInstanceSource).not.toContain('kernelPortOperations');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeKernelPortOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeKernelToolPort',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeKernelStorePort',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeKernelTracePort',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeKernelHookPort',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('this.kernelPortFactory.createToolPort({');
    expect(packageLocalRuntimeInstanceSource).not.toContain('this.kernelPortFactory.createStorePort({');
    expect(packageLocalRuntimeInstanceSource).not.toContain('this.kernelPortFactory.createTracePort({');
    expect(packageLocalRuntimeInstanceSource).not.toContain('this.kernelPortFactory.createHookPort({');
    expect(packageLocalRuntimeInstanceSource).toContain('createAgentKernel');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeAgentKernelFactoryPort');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeKernelModelResolverPort');
    expect(existsSync('packages/agent-sdk/src/session/runtimeAgentKernels.ts')).toBe(true);
    expect(runtimeAgentKernelsSource).not.toContain('../../../../src/');
    expect(runtimeAgentKernelsSource).toContain('createPackageLocalRuntimeAgentKernel');
    expect(runtimeAgentKernelsSource).toContain('projectPackageLocalRuntimeAgentKernelPorts');
    expect(runtimeAgentKernelsSource).toContain(
      'createPackageLocalRuntimeAgentKernelFromResolved',
    );
    expect(runtimeAgentKernelsSource).toContain(
      'createPackageLocalRuntimeAgentKernelFromOptions',
    );
    expect(runtimeAgentKernelsSource).toContain(
      'createPackageLocalRuntimeResolvedAgentKernelCreator',
    );
    expect(runtimeAgentKernelsSource).toContain(
      'createPackageLocalRuntimeAgentKernelOperations',
    );
    expect(runtimeAgentKernelsSource).toContain('resolvePackageLocalRuntimeKernelModel');
    expect(packageLocalRuntimeInstanceSource).not.toContain('agentKernelOperations');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeAgentKernelOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeAgentKernelFromOptions',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeResolvedAgentKernelCreator',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('private createAgentKernelFromResolved');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeAgentKernelFromResolved',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('resolvePackageLocalRuntimeKernelModel');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'projectPackageLocalRuntimeAgentKernelPorts',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeAgentKernel({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('store: this.getKernelStorePort()');
    expect(packageLocalRuntimeInstanceSource).not.toContain('hooks: this.getKernelHookPort()');
    expect(packageLocalRuntimeInstanceSource).not.toContain('trace: this.getKernelTracePort');
    expect(packageLocalRuntimeInstanceSource).not.toContain('tools: this.getKernelToolPort');
    expect(packageLocalRuntimeInstanceSource).not.toContain('this.kernelFactory.create({');
    expect(packageLocalRuntimeInstanceSource).not.toContain('? { modelRequestDefaults:');
    expect(existsSync('packages/agent-sdk/src/session/runtimeKernelModels.ts')).toBe(true);
    expect(runtimeKernelModelsSource).not.toContain('../../../../src/');
    expect(runtimeKernelModelsSource).toContain('resolvePackageLocalRuntimeKernelModel');
    expect(packageLocalRuntimeInstanceSource).not.toContain('resolvePackageLocalRuntimeKernelModel');
    expect(packageLocalRuntimeInstanceSource).not.toContain('private resolveAgentKernelModel');
    expect(packageLocalRuntimeInstanceSource).toContain('streamAgentKernelTurn');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeAgentKernelPort');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeAgentKernelStreamOptions');
    expect(existsSync('packages/agent-sdk/src/session/runtimeKernelTraceFinalization.ts')).toBe(
      true,
    );
    expect(runtimeKernelTraceFinalizationSource).not.toContain('../../../../src/');
    expect(runtimeKernelTraceFinalizationSource).toContain(
      'updatePackageLocalKernelTraceFinalization',
    );
    expect(runtimeKernelTraceFinalizationSource).toContain('finishPackageLocalKernelTraceError');
    expect(runtimeKernelTurnStreamSource).toContain(
      'updatePackageLocalKernelTraceFinalization',
    );
    expect(runtimeKernelTurnStreamSource).toContain('finishPackageLocalKernelTraceError');
    expect(packageLocalRuntimeInstanceSource).not.toContain("event.type === 'usage'");
    expect(packageLocalRuntimeInstanceSource).not.toContain("traceFinalizer.finish('success'");
    expect(packageLocalRuntimeInstanceSource).not.toContain("traceFinalizer.finish('error'");
    expect(existsSync('packages/agent-sdk/src/session/runtimeKernelTurnStream.ts')).toBe(true);
    expect(runtimeKernelTurnStreamSource).not.toContain('../../../../src/');
    expect(runtimeKernelTurnStreamSource).toContain('streamPackageLocalAgentKernelTurn');
    expect(runtimeKernelTurnStreamSource).toContain('streamPackageLocalRuntimeAgentKernelTurn');
    expect(runtimeKernelTurnStreamSource).toContain(
      'createPackageLocalRuntimeKernelTurnStreamOperations',
    );
    expect(runtimeKernelTurnStreamSource).toContain('resolvePackageLocalRuntimeKernelModel');
    expect(runtimeKernelTurnStreamSource).toContain('PackageLocalRuntimeAgentKernelStreamOptions');
    expect(runtimeKernelTurnStreamSource).toContain('streamWithPackageLocalRuntimeTraceCollector');
    expect(runtimeKernelTurnStreamSource).toContain('projectPackageLocalKernelEventToStreamMessages');
    expect(packageLocalRuntimeInstanceSource).toContain('turnOperations.kernelTurnStream');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeKernelTurnStreamOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'streamPackageLocalRuntimeAgentKernelTurn({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'this.traceManager.createRecorder(options.input)',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('const kernel =');
    expect(packageLocalRuntimeInstanceSource).not.toContain('const maxContextTokens =');
    expect(packageLocalRuntimeInstanceSource).not.toContain('kernel.runTurn({');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'streamWithPackageLocalRuntimeTraceCollector({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'projectPackageLocalKernelEventToStreamMessages(event',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('createSessionTraceFinalizer');
    expect(kernelStreamBridgeSource).not.toContain("from './runtimeInstance.js'");
    expect(packageLocalRuntimeInstanceSource).toContain(
      'PackageLocalRuntimeKernelStreamProjectionOptions',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('toPackageLocalSessionUsage');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'toPackageLocalSessionPermissionUpdates',
    );
    expect(existsSync('packages/agent-sdk/src/session/packageLocalKernelRuntimeFactory.ts')).toBe(
      true,
    );
    expect(packageLocalKernelRuntimeFactorySource).not.toContain('../../../../src/');
    expect(packageLocalKernelRuntimeFactorySource).toContain(
      'createPackageLocalKernelSessionRuntimeFactory',
    );
    expect(packageLocalKernelRuntimeFactorySource).toContain('createPackageLocalSessionRuntimeFactory');
    expect(packageLocalKernelRuntimeFactorySource).toContain('createKernelStreamTurnBridge');
    expect(existsSync('packages/agent-sdk/src/session/defaultKernelRuntimeFactory.ts')).toBe(
      true,
    );
    expect(defaultKernelRuntimeFactorySource).not.toContain('../../../../src/');
    expect(defaultKernelRuntimeFactorySource).toContain('createDefaultKernelSessionRuntimeFactory');
    expect(defaultKernelRuntimeFactorySource).toContain('createPackageLocalKernelSessionRuntimeFactory');
    expect(defaultKernelRuntimeFactorySource).toContain('PackageLocalSessionRuntime');
    expect(defaultKernelRuntimeFactorySource).toContain('buildBladeConfig');
    expect(defaultKernelRuntimeFactorySource).toContain('createPackageLocalKernelModelResolver');
    expect(defaultKernelRuntimeFactorySource).toContain('createPackageLocalAgentKernelFactory');
    expect(existsSync('packages/agent-sdk/src/session/kernelModelResolver.ts')).toBe(true);
    expect(kernelModelResolverSource).not.toContain('../../../../src/');
    expect(kernelModelResolverSource).toContain('createPackageLocalKernelModelResolver');
    expect(kernelModelResolverSource).toContain('@blade-ai/ai/providers/vercel');
    expect(kernelModelResolverSource).toContain('PackageLocalRuntimeKernelModelResolverPort');
    expect(existsSync('packages/agent-sdk/src/session/kernelFactory.ts')).toBe(true);
    expect(kernelFactorySource).not.toContain('../../../../src/');
    expect(kernelFactorySource).toContain('createPackageLocalAgentKernelFactory');
    expect(kernelFactorySource).toContain("from '@blade-ai/agent'");
    expect(kernelFactorySource).toContain('AgentKernel');
    expect(kernelFactorySource).toContain('PackageLocalRuntimeAgentKernelFactoryPort');
    expect(sessionRuntimeFactorySource).not.toContain('../../../../src/session/Session.js');
    expect(sessionRuntimeFactorySource).toContain('interface DefaultSessionRuntimeFactoryOptions');
    expect(sessionRuntimeFactorySource).toContain('loadKernelRuntimeFactory');
    expect(sessionRuntimeFactorySource).toContain('createDefaultKernelSessionRuntimeFactory');
    expect(sessionRuntimeFactorySource).not.toContain('loadLegacyRuntimeFactory');
    expect(sessionRuntimeFactorySource).not.toContain('loadDefaultLegacyRuntimeFactory');
    expect(sessionRuntimeFactorySource).toContain("from './Session.js'");
    expect(sessionRuntimeFactorySource).not.toContain('legacySessionAdapter');
    expect(sessionFactorySource).not.toContain('fork(options');
    expect(sessionFactorySource).not.toContain('prompt(message');
    expect(sessionRuntimeFactorySource).not.toContain('forkSession');
    expect(sessionRuntimeFactorySource).not.toContain('prompt');
    expect(sessionSource).toContain('createSession as runCreateLifecycle');
    expect(sessionSource).toContain('resumeSession as runResumeLifecycle');
    expect(sessionSource).not.toContain('return sessionRuntimeFactory.create(options)');
    expect(sessionSource).not.toContain('return sessionRuntimeFactory.resume(options)');
    expect(sessionSource).not.toContain('resumeSession() requires session persistence');
    expect(sessionSource).not.toContain('forkSession() requires session persistence');
    expect(sessionLifecycleSource).toContain('resumeSession() requires session persistence');
    expect(sessionLifecycleSource).toContain('forkSession() requires session persistence');
    expect(sessionLifecycleSource).toContain('new PromptStreamAccumulator()');
    expect(sessionLifecycleSource).toContain('closeSessionAfterLifecycle');
    expect(sessionLifecycleSource).not.toContain('../../../../src/session/Session.js');
    expect(sessionConfigSource).not.toContain('../../../../src/session/Session');
    expect(sessionConfigSource).not.toContain('../../../../src/types/common');
    expect(sessionStoreSource).not.toContain('../../../../src/session/SessionStore');
    expect(sessionStoreSource).not.toContain('../../../../src/context/storage');
    expect(sessionSource).toContain("from './types.js'");
    expect(sessionSource).toContain('createDefaultSessionRuntimeFactory');
    expect(sessionTypesSource).toContain("from '@blade-ai/agent/budget'");
    expect(sessionTypesSource).not.toContain("from '@blade-ai/agent';");
    expect(sessionTypesSource).not.toContain('AgentTokenBudgetSnapshot');
  });

  it('resolves workspace packages from source during type checking', () => {
    const agentTsconfig = readJson('packages/agent/tsconfig.json');
    const sdkTsconfig = readJson('packages/agent-sdk/tsconfig.json');

    expect(agentTsconfig.compilerOptions?.paths).toMatchObject({
      '@blade-ai/ai': ['../ai/src/index.ts'],
    });
    expect(sdkTsconfig.compilerOptions?.paths).toMatchObject({
      '@blade-ai/agent': ['../agent/src/index.ts'],
      '@blade-ai/agent/budget': ['../agent/src/budget/TokenBudget.ts'],
      '@blade-ai/agent/epoch': ['../agent/src/epoch/ExecutionEpoch.ts'],
      '@blade-ai/ai': ['../ai/src/index.ts'],
    });
    expect(sdkTsconfig.compilerOptions?.paths).not.toHaveProperty('@/*');
    expect(sdkTsconfig.include).toEqual(['src/**/*']);
  });

  it('excludes test declarations from package build output', () => {
    for (const dir of ['packages/ai', 'packages/agent', 'packages/agent-sdk']) {
      const buildConfig = readJson(join(dir, 'tsconfig.build.json'));

      expect(buildConfig.exclude).toEqual(
        expect.arrayContaining(['**/*.test.ts', '**/*.spec.ts', '**/__tests__/**']),
      );
    }
  });

  it('does not emit declaration maps from publishable package builds', () => {
    for (const dir of ['packages/ai', 'packages/agent', 'packages/agent-sdk']) {
      const buildConfig = readJson(join(dir, 'tsconfig.build.json'));

      expect(buildConfig.compilerOptions?.declarationMap).toBe(false);
    }
  });

  it('does not emit JavaScript source maps from publishable package builds', () => {
    for (const dir of ['packages/ai', 'packages/agent', 'packages/agent-sdk']) {
      const tsupConfig = readFileSync(join(dir, 'tsup.config.ts'), 'utf-8');

      expect(tsupConfig).toContain('sourcemap: false');
      expect(tsupConfig).not.toContain('sourcemap: true');
    }
  });

  it('declares a package boundary verifier for production architecture gates', () => {
    const root = readJson('package.json');

    expect(root.scripts?.['verify:boundaries']).toBe('node scripts/verify-package-boundaries.mjs');
    expect(existsSync(join('scripts', 'verify-package-boundaries.mjs'))).toBe(true);
  });

  it('fresh-builds every publishable package before package verification', () => {
    const root = readJson('package.json');
    const packageVerifierSource = readFileSync('scripts/verify-packages.mjs', 'utf-8');

    expect(root.scripts?.['verify:packages']).toContain('pnpm --filter @blade-ai/ai run build');
    expect(root.scripts?.['verify:packages']).toContain('pnpm --filter @blade-ai/agent run build');
    expect(root.scripts?.['verify:packages']).toContain(
      'pnpm --filter @blade-ai/agent-sdk run build',
    );
    expect(root.scripts?.['verify:packages']).toContain('node scripts/verify-packages.mjs');
    expect(packageVerifierSource).toContain('package/dist/session/factory.d.ts');
    expect(packageVerifierSource).toContain('fork(options');
    expect(packageVerifierSource).toContain('prompt(message');
    expect(packageVerifierSource).toContain('verifyNoEagerLegacySessionRuntime');
    expect(packageVerifierSource).toContain('collectPackedStaticImports');
    expect(packageVerifierSource).toContain('package/dist/session/index.js');
    expect(packageVerifierSource).toContain("runtime?: 'kernel' | 'legacy'");
    expect(packageVerifierSource).toContain('experimentalKernel');
    expect(packageVerifierSource).toContain('legacyStream');
    expect(packageVerifierSource).toContain('packageLocalLegacy');
    expect(packageVerifierSource).toContain('package/dist/agent/Agent.d.ts');
    expect(packageVerifierSource).toContain('package/dist/context/ContextManager.d.ts');
    expect(packageVerifierSource).toContain('package/dist/mcp/McpRegistry.d.ts');
    expect(packageVerifierSource).toContain("entry.endsWith('.d.ts.map')");
    expect(packageVerifierSource).toContain("entry.endsWith('.js.map')");
  });

  it('keeps the root session stream contract kernel-only', () => {
    const rootSessionTypes = readFileSync('src/session/types.ts', 'utf-8');
    const rootSessionRuntime = readFileSync('src/session/Session.ts', 'utf-8');

    expect(rootSessionTypes).toContain('includeThinking?: boolean');
    expect(rootSessionTypes).not.toContain("runtime?: 'kernel' | 'legacy'");
    expect(rootSessionTypes).not.toContain('experimentalKernel');
    expect(rootSessionRuntime).not.toContain("runtime === 'legacy'");
    expect(rootSessionRuntime).not.toContain("runtime === 'kernel'");
    expect(rootSessionRuntime).not.toContain('experimentalKernel');
  });
});
