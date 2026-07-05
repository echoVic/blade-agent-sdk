import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackageJson {
  name?: string;
  private?: boolean;
  workspaces?: unknown;
  exports?: Record<string, unknown>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  compilerOptions?: {
    paths?: Record<string, string[]>;
  };
  files?: string[];
  exclude?: string[];
}

function readJson(path: string): PackageJson {
  return JSON.parse(readFileSync(path, 'utf-8')) as PackageJson;
}

describe('monorepo topology', () => {
  it('declares packages workspace and keeps root as a private orchestrator', () => {
    const root = readJson('package.json');
    const workspace = readFileSync('pnpm-workspace.yaml', 'utf-8');

    expect(root.private).toBe(true);
    expect(workspace).toContain('packages:');
    expect(workspace).toContain("'packages/*'");
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
    expect(serverSource).toContain("from '../index.js'");
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

  it('organizes the agent package around kernel, protocol, ports, state, and tracing modules', () => {
    for (const file of [
      'packages/agent/src/kernel/AgentKernel.ts',
      'packages/agent/src/protocol/index.ts',
      'packages/agent/src/ports/index.ts',
      'packages/agent/src/state/index.ts',
      'packages/agent/src/tracing/index.ts',
    ]) {
      expect(existsSync(file), file).toBe(true);
    }

    const agentIndexSource = readFileSync('packages/agent/src/index.ts', 'utf-8');

    expect(agentIndexSource).not.toContain('class AgentKernel');
  });

  it('publishes agent kernel modules as explicit subpath exports', () => {
    const agentPackage = readJson('packages/agent/package.json');
    const agentBuildConfig = readFileSync('packages/agent/tsup.config.ts', 'utf-8');

    expect(agentPackage.exports).toMatchObject({
      './kernel': {
        types: './dist/kernel/AgentKernel.d.ts',
        import: './dist/kernel/AgentKernel.js',
      },
      './protocol': {
        types: './dist/protocol/index.d.ts',
        import: './dist/protocol/index.js',
      },
      './ports': {
        types: './dist/ports/index.d.ts',
        import: './dist/ports/index.js',
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
    expect(agentBuildConfig).toContain('protocol/index');
    expect(agentBuildConfig).toContain('ports/index');
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
    const legacyStreamEventsSource = readFileSync(
      'packages/agent-sdk/src/session/legacyStreamEvents.ts',
      'utf-8',
    );
    const sessionTaskCompletedSource = readFileSync(
      'packages/agent-sdk/src/session/taskCompleted.ts',
      'utf-8',
    );
    const sessionStreamCompletionSource = readFileSync(
      'packages/agent-sdk/src/session/streamCompletion.ts',
      'utf-8',
    );
    const sessionPromptSubmitSource = readFileSync(
      'packages/agent-sdk/src/session/promptSubmit.ts',
      'utf-8',
    );
    const sessionLegacyStreamRunnerSource = readFileSync(
      'packages/agent-sdk/src/session/legacyStreamRunner.ts',
      'utf-8',
    );
    const sessionLegacyStreamBridgeSource = readFileSync(
      'packages/agent-sdk/src/session/legacyStreamBridge.ts',
      'utf-8',
    );
    const sessionKernelStreamBridgeSource = readFileSync(
      'packages/agent-sdk/src/session/kernelStreamBridge.ts',
      'utf-8',
    );
    const sessionInstanceSource = readFileSync(
      'packages/agent-sdk/src/session/sessionInstance.ts',
      'utf-8',
    );
    const legacySessionDelegateSource = readFileSync(
      'packages/agent-sdk/src/session/legacySessionDelegate.ts',
      'utf-8',
    );
    const packageLocalRuntimeFactorySource = readFileSync(
      'packages/agent-sdk/src/session/packageLocalRuntimeFactory.ts',
      'utf-8',
    );
    const packageLocalLegacyRuntimeFactorySource = readFileSync(
      'packages/agent-sdk/src/session/packageLocalLegacyRuntimeFactory.ts',
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
    const sessionFactorySource = readFileSync('packages/agent-sdk/src/session/factory.ts', 'utf-8');
    const sessionLifecycleSource = readFileSync('packages/agent-sdk/src/session/Session.ts', 'utf-8');
    const legacySessionAdapterSource = readFileSync(
      'packages/agent-sdk/src/session/legacySessionAdapter.ts',
      'utf-8',
    );
    const sessionStoreSource = readFileSync('packages/agent-sdk/src/session/store.ts', 'utf-8');

    expect(sessionSource).not.toContain("export * from '../../../../src/session/index.js'");
    expect(sessionSource).not.toContain("../../../../src/session/Session.js");
    expect(existsSync('packages/agent-sdk/src/session/Session.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/legacySessionAdapter.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/config.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/content.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/pendingTurn.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/turnAbort.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/turn.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/promptStreamAccumulator.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/cleanup.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/lifecycle.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/traces.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/legacyStreamEvents.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/taskCompleted.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/streamCompletion.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/promptSubmit.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/legacyStreamRunner.ts')).toBe(true);
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
    expect(legacyStreamEventsSource).not.toContain('../../../../src/');
    expect(legacyStreamEventsSource).toContain('class LegacyStreamEventProjector');
    expect(sessionTaskCompletedSource).not.toContain('../../../../src/');
    expect(sessionTaskCompletedSource).toContain('reportSessionTaskCompleted');
    expect(sessionStreamCompletionSource).not.toContain('../../../../src/');
    expect(sessionStreamCompletionSource).toContain('completeSessionStreamResult');
    expect(sessionPromptSubmitSource).not.toContain('../../../../src/');
    expect(sessionPromptSubmitSource).toContain('applySessionPromptSubmit');
    expect(sessionLegacyStreamRunnerSource).not.toContain('../../../../src/');
    expect(sessionLegacyStreamRunnerSource).toContain('runLegacySessionStreamTurn');
    expect(existsSync('packages/agent-sdk/src/session/legacyStreamBridge.ts')).toBe(true);
    expect(sessionLegacyStreamBridgeSource).not.toContain('../../../../src/');
    expect(sessionLegacyStreamBridgeSource).toContain('createLegacyStreamTurnBridge');
    expect(sessionLegacyStreamBridgeSource).toContain('runLegacySessionStreamTurn');
    expect(existsSync('packages/agent-sdk/src/session/kernelStreamBridge.ts')).toBe(true);
    expect(sessionKernelStreamBridgeSource).not.toContain('../../../../src/');
    expect(sessionKernelStreamBridgeSource).toContain('createKernelStreamTurnBridge');
    expect(sessionKernelStreamBridgeSource).toContain('streamAgentKernelTurn');
    expect(sessionKernelStreamBridgeSource).toContain('getUserMessageText');
    expect(sessionInstanceSource).not.toContain('../../../../src/');
    expect(sessionInstanceSource).toContain('class PackageLocalSession');
    expect(sessionInstanceSource).toContain('interface PackageLocalSessionDelegate');
    expect(sessionInstanceSource).toContain('this.delegate?.fork');
    expect(sessionInstanceSource).toContain('this.delegate?.mcpConnect');
    expect(sessionInstanceSource).toContain('this.delegate?.getTraces');
    expect(existsSync('packages/agent-sdk/src/session/legacySessionDelegate.ts')).toBe(true);
    expect(legacySessionDelegateSource).not.toContain('../../../../src/');
    expect(legacySessionDelegateSource).toContain('createLegacyDelegateSession');
    expect(legacySessionDelegateSource).toContain('new PackageLocalSession');
    expect(packageLocalRuntimeFactorySource).not.toContain('../../../../src/');
    expect(packageLocalRuntimeFactorySource).toContain('createPackageLocalSessionRuntimeFactory');
    expect(packageLocalRuntimeInstanceSource).not.toContain('../../../../src/');
    expect(packageLocalRuntimeInstanceSource).toContain('class PackageLocalSessionRuntime');
    expect(packageLocalRuntimeInstanceSource).toContain('resolvePackageLocalRuntimeStorageRoot');
    expect(packageLocalRuntimeInstanceSource).toContain('isPackageLocalSdkMcpServerHandle');
    expect(packageLocalRuntimeInstanceSource).toContain('ensureSessionCreated');
    expect(packageLocalRuntimeInstanceSource).toContain('ensureSessionLoaded');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeSessionStorePort');
    expect(packageLocalRuntimeInstanceSource).toContain('prepareTurn');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeWorkspacePort');
    expect(packageLocalRuntimeInstanceSource).toContain('close');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeMcpRegistryPort');
    expect(packageLocalRuntimeInstanceSource).toContain('mcpCapabilities');
    expect(packageLocalRuntimeInstanceSource).toContain('mcpServerStatus');
    expect(packageLocalRuntimeInstanceSource).toContain('mcpListTools');
    expect(packageLocalRuntimeInstanceSource).toContain('mcpConnect');
    expect(packageLocalRuntimeInstanceSource).toContain('mcpDisconnect');
    expect(packageLocalRuntimeInstanceSource).toContain('mcpReconnect');
    expect(packageLocalRuntimeInstanceSource).toContain('ensureServerRegistered');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeMcpServerCapability');
    expect(packageLocalRuntimeInstanceSource).toContain('filterTools');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeNamedTool');
    expect(packageLocalRuntimeInstanceSource).toContain('allowedTools !== undefined');
    expect(packageLocalRuntimeInstanceSource).toContain('registerTools');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeToolCatalogPort');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeToolSource');
    expect(packageLocalRuntimeInstanceSource).toContain('registerConfiguredMcpServers');
    expect(packageLocalRuntimeInstanceSource).toContain('registerInProcessServer');
    expect(packageLocalRuntimeInstanceSource).toContain('registerServer');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeLoggerPort');
    expect(packageLocalRuntimeInstanceSource).toContain('refreshMcpTools');
    expect(packageLocalRuntimeInstanceSource).toContain('getAvailableToolsByServerNames');
    expect(packageLocalRuntimeInstanceSource).toContain('registerMcpTool');
    expect(packageLocalRuntimeInstanceSource).toContain('removeMcpTools');
    expect(packageLocalRuntimeInstanceSource).toContain('packageLocalServerNameFromTool');
    expect(packageLocalRuntimeInstanceSource).toContain('registerCustomTools');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeCustomToolFactoryPort');
    expect(packageLocalRuntimeInstanceSource).toContain('registerBuiltinTools');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeBuiltinToolProviderPort');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeBuiltinToolContext');
    expect(packageLocalRuntimeInstanceSource).toContain('initializeSubagents');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeSubagentRegistryPort');
    expect(packageLocalRuntimeInstanceSource).toContain('packageLocalSubagentConfigFromDefinition');
    expect(packageLocalRuntimeInstanceSource).toContain('createPermissionHandler');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimePermissionHookPort');
    expect(packageLocalRuntimeInstanceSource).toContain('createPermissionHandlerFromCanUseTool');
    expect(packageLocalRuntimeInstanceSource).toContain('createCompositePermissionHandler');
    expect(packageLocalRuntimeInstanceSource).toContain('initializeHooks');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeHookManagerPort');
    expect(packageLocalRuntimeInstanceSource).toContain('createExecutionPipeline');
    expect(packageLocalRuntimeInstanceSource).toContain(
      'PackageLocalRuntimeExecutionPipelineFactoryPort',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('getAgentRuntimeDeps');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalAgentRuntimeDeps');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeBackgroundAgentManagerPort');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeHookRuntimePort');
    expect(packageLocalRuntimeInstanceSource).toContain('getKernelToolPort');
    expect(packageLocalRuntimeInstanceSource).toContain('getKernelStorePort');
    expect(packageLocalRuntimeInstanceSource).toContain('getKernelTracePort');
    expect(packageLocalRuntimeInstanceSource).toContain('getKernelHookPort');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeKernelPortFactoryPort');
    expect(packageLocalRuntimeInstanceSource).toContain('createAgentKernel');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeAgentKernelFactoryPort');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeKernelModelResolverPort');
    expect(packageLocalRuntimeInstanceSource).toContain('streamAgentKernelTurn');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeAgentKernelPort');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeAgentKernelStreamOptions');
    expect(packageLocalRuntimeInstanceSource).toContain('projectKernelEventToStreamMessages');
    expect(packageLocalRuntimeInstanceSource).toContain(
      'PackageLocalRuntimeKernelStreamProjectionOptions',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('toPackageLocalSessionUsage');
    expect(packageLocalRuntimeInstanceSource).toContain('toPackageLocalSessionPermissionUpdates');
    expect(existsSync('packages/agent-sdk/src/session/packageLocalLegacyRuntimeFactory.ts')).toBe(
      true,
    );
    expect(packageLocalLegacyRuntimeFactorySource).not.toContain('../../../../src/');
    expect(packageLocalLegacyRuntimeFactorySource).toContain(
      'createPackageLocalLegacySessionRuntimeFactory',
    );
    expect(packageLocalLegacyRuntimeFactorySource).toContain('createPackageLocalSessionRuntimeFactory');
    expect(packageLocalLegacyRuntimeFactorySource).toContain('createLegacyStreamTurnBridge');
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
    const legacySessionAdapterRootImports = [
      ...legacySessionAdapterSource.matchAll(/from ['"](\.\.\/\.\.\/\.\.\/\.\.\/src\/[^'"]+)['"]/g),
    ].map((match) => match[1]);
    expect(legacySessionAdapterRootImports).toEqual([]);
    expect(legacySessionAdapterSource).toContain("import('../../../../src/session/Session.js')");
    expect(legacySessionAdapterSource).toContain('interface LegacySessionModulePort');
    expect(legacySessionAdapterSource).toContain('loadLegacySessionModule');
    expect(legacySessionAdapterSource).not.toContain("typeof import('../../../../src/session/Session.js')");
    expect(legacySessionAdapterSource).not.toContain("Parameters<LegacySessionModule['createSession']>");
    expect(legacySessionAdapterSource).not.toContain('forkSession as forkLegacy');
    expect(legacySessionAdapterSource).not.toContain('prompt as promptLegacy');
    expect(legacySessionAdapterSource).toContain('createLegacyDelegateSession');
    expect(legacySessionAdapterSource).not.toContain('as never');
    expect(legacySessionAdapterSource).not.toContain('as unknown as ISession');
    expect(sessionConfigSource).not.toContain('../../../../src/session/Session');
    expect(sessionConfigSource).not.toContain('../../../../src/types/common');
    expect(sessionStoreSource).not.toContain('../../../../src/session/SessionStore');
    expect(sessionStoreSource).not.toContain('../../../../src/context/storage');
    expect(sessionSource).toContain("from './types.js'");
    expect(sessionSource).toContain('createDefaultSessionRuntimeFactory');
  });

  it('resolves workspace packages from source during type checking', () => {
    const agentTsconfig = readJson('packages/agent/tsconfig.json');
    const sdkTsconfig = readJson('packages/agent-sdk/tsconfig.json');

    expect(agentTsconfig.compilerOptions?.paths).toMatchObject({
      '@blade-ai/ai': ['../ai/src/index.ts'],
    });
    expect(sdkTsconfig.compilerOptions?.paths).toMatchObject({
      '@blade-ai/agent': ['../agent/src/index.ts'],
      '@blade-ai/ai': ['../ai/src/index.ts'],
    });
  });

  it('excludes test declarations from package build output', () => {
    for (const dir of ['packages/ai', 'packages/agent', 'packages/agent-sdk']) {
      const buildConfig = readJson(join(dir, 'tsconfig.build.json'));

      expect(buildConfig.exclude).toEqual(
        expect.arrayContaining(['**/*.test.ts', '**/*.spec.ts', '**/__tests__/**']),
      );
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
  });
});
