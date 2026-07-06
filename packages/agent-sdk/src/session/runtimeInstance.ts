import type { ModelMessage } from '@blade-ai/ai';
import type {
  AgentStoreAppendContext,
  AgentHookPort,
  AgentStorePort,
  AgentToolCall,
  AgentToolPort,
  AgentTracePort,
} from '@blade-ai/agent';
import type { ContextSnapshot, RuntimeContext } from '../runtime/types.js';
import type { SubagentConfig } from '../subagents/types.js';
import { HookEvent } from '../types/constants.js';
import type { BladeConfig, McpServerConfig } from '../types/common.js';
import type { PermissionHandler } from '../types/permissions.js';
import type { TraceRecorder } from '../observability/TraceRecorder.js';
import type { AgentTrace } from '../observability/types.js';
import type { ExecutionContext } from '../tools/types/index.js';
import type {
  McpToolInfo,
  McpServerStatus,
  SdkMcpServerHandle,
  ForkSessionOptions,
  ISession,
  SessionHookEvent,
  SessionId,
  SessionMessage,
  SessionOptions,
  HookCallback,
  StreamMessage,
} from './types.js';
import {
  initializePackageLocalRuntimeHooks,
  type PackageLocalRuntimeHookManagerPort,
  type PackageLocalRuntimeHookRuntimePort,
} from './runtimeHooks.js';
import {
  createPackageLocalRuntimeExecutionPipelineCache,
  createPackageLocalRuntimeExecutionPipeline,
  type PackageLocalRuntimeExecutionPipelineCache,
  type PackageLocalRuntimeExecutionPipelineFactoryPort,
} from './runtimeExecutionPipeline.js';
import {
  createPackageLocalRuntimeAgentKernelOperations,
  type PackageLocalRuntimeAgentKernelOperations,
  type PackageLocalRuntimeAgentKernelFactoryPort,
  type PackageLocalRuntimeAgentKernelPort,
} from './runtimeAgentKernels.js';
import {
  createPackageLocalAgentRuntimeDepsOperations,
  type PackageLocalAgentRuntimeDeps,
  type PackageLocalAgentRuntimeDepsOperations,
  type PackageLocalRuntimeBackgroundAgentManagerPort,
} from './runtimeAgentDeps.js';
import {
  createPackageLocalRuntimeKernelPortOperations,
  type PackageLocalRuntimeKernelPortFactoryPort,
  type PackageLocalRuntimeKernelPortOperations,
} from './runtimeKernelPorts.js';
import {
  streamPackageLocalRuntimeAgentKernelTurn,
  type PackageLocalRuntimeAgentKernelOptions,
  type PackageLocalRuntimeAgentKernelStreamOptions,
} from './runtimeKernelTurnStream.js';
import type {
  PackageLocalRuntimeKernelModelResolverPort,
} from './runtimeKernelModels.js';
import {
  getPackageLocalRuntimeContextCwd,
  resolvePackageLocalRuntimeStorageRoot,
} from './runtimeContext.js';
import { preparePackageLocalRuntimeWorkspaceTurn } from './runtimeWorkspace.js';
import {
  createPackageLocalRuntimeSessionLifecycleOperations,
  type PackageLocalRuntimeSessionLifecycleOperations,
} from './runtimeSessionLifecycle.js';
import {
  closePackageLocalRuntimeMcpServers,
  connectPackageLocalRuntimeMcpServer,
  disconnectPackageLocalRuntimeMcpServer,
  reconnectPackageLocalRuntimeMcpServer,
  registerPackageLocalConfiguredMcpServers,
} from './runtimeMcpServers.js';
import {
  createPackageLocalRuntimeMcpCapabilityOperations,
  type PackageLocalRuntimeMcpCapabilityOperations,
  type PackageLocalRuntimeMcpServerCapability,
} from './runtimeMcpCapabilities.js';
import {
  refreshPackageLocalRuntimeMcpTools,
  type PackageLocalRuntimeMcpTool,
} from './runtimeMcpTools.js';
import { createPackageLocalRuntimeNoopPorts } from './runtimeNoopPorts.js';
import { initializePackageLocalRuntimeSubagents } from './runtimeSubagents.js';
import { filterPackageLocalRuntimeTools } from './runtimeToolFilters.js';
import {
  createPackageLocalRuntimeToolRegistrationOperations,
  registerPackageLocalRuntimeBuiltinTools,
  registerPackageLocalRuntimeCustomTools,
  type PackageLocalRuntimeToolRegistrationOperations,
} from './runtimeToolRegistration.js';
import {
  createPackageLocalRuntimePermissionHandler,
  type PackageLocalRuntimePermissionHookPort,
} from './runtimePermissions.js';
import {
  createPackageLocalRuntimeTraceManager,
} from './runtimeTraceManager.js';
import { forkPackageLocalRuntimeSession } from './runtimeForking.js';
import type { SessionTraceManager } from './traces.js';
import type { SessionSnapshot } from './store.js';

export type { PackageLocalRuntimeKernelStreamProjectionOptions } from './kernelStreamProjection.js';
export {
  getPackageLocalRuntimeContextCwd,
  resolvePackageLocalRuntimeStorageRoot,
} from './runtimeContext.js';
export { isPackageLocalSdkMcpServerHandle } from './runtimeMcpServers.js';
export type {
  PackageLocalRuntimeKernelModelResolverPort,
  PackageLocalRuntimeKernelModelResolveOptions,
  PackageLocalRuntimeResolvedKernelModel,
} from './runtimeKernelModels.js';
export type {
  PackageLocalAgentRuntimeDeps,
  PackageLocalRuntimeBackgroundAgentManagerPort,
} from './runtimeAgentDeps.js';
export type {
  PackageLocalRuntimeKernelHookPortCreateOptions,
  PackageLocalRuntimeKernelPortFactoryPort,
  PackageLocalRuntimeKernelStorePortCreateOptions,
  PackageLocalRuntimeKernelToolPortCreateOptions,
  PackageLocalRuntimeKernelTracePortCreateOptions,
} from './runtimeKernelPorts.js';
export type {
  PackageLocalRuntimeHookManagerPort,
  PackageLocalRuntimeHookRuntimePort,
} from './runtimeHooks.js';
export type {
  PackageLocalRuntimeExecutionPipelineCreateOptions,
  PackageLocalRuntimeExecutionPipelineFactoryPort,
} from './runtimeExecutionPipeline.js';
export type {
  PackageLocalRuntimeAgentKernelFactoryPort,
  PackageLocalRuntimeAgentKernelPort,
  PackageLocalRuntimeAgentKernelTurn,
} from './runtimeAgentKernels.js';

export interface PackageLocalSessionRuntimeOptions {
  sessionId: SessionId;
  options: SessionOptions;
  bladeConfig: BladeConfig;
  defaultContext: RuntimeContext;
  sessionStore?: PackageLocalRuntimeSessionStorePort;
  workspace?: PackageLocalRuntimeWorkspacePort;
  mcpRegistry?: PackageLocalRuntimeMcpRegistryPort;
  toolCatalog?: PackageLocalRuntimeToolCatalogPort;
  logger?: PackageLocalRuntimeLoggerPort;
  customToolFactory?: PackageLocalRuntimeCustomToolFactoryPort;
  builtinToolProvider?: PackageLocalRuntimeBuiltinToolProviderPort;
  subagentRegistry?: PackageLocalRuntimeSubagentRegistryPort;
  permissionHooks?: PackageLocalRuntimePermissionHookPort;
  hookManager?: PackageLocalRuntimeHookManagerPort;
  hookRuntime?: PackageLocalRuntimeHookRuntimePort;
  backgroundAgentManager?: PackageLocalRuntimeBackgroundAgentManagerPort;
  executionPipelineFactory?: PackageLocalRuntimeExecutionPipelineFactoryPort;
  kernelPortFactory?: PackageLocalRuntimeKernelPortFactoryPort;
  kernelFactory?: PackageLocalRuntimeAgentKernelFactoryPort;
  kernelModelResolver?: PackageLocalRuntimeKernelModelResolverPort;
  createForkSessionId?: () => SessionId;
  createForkSession?: (
    sessionId: SessionId,
    options: SessionOptions,
  ) => Promise<ISession> | ISession;
}

export interface PackageLocalRuntimeSessionStorePort {
  createSession(sessionId: SessionId): Promise<void>;
  loadSession(sessionId: SessionId): Promise<boolean>;
  loadMessages(sessionId: SessionId): Promise<SessionMessage[]>;
  appendMessage(
    sessionId: SessionId,
    message: ModelMessage,
    context: AgentStoreAppendContext,
  ): Promise<void> | void;
  forkState(
    sessionId: SessionId,
    options?: ForkSessionOptions,
  ): Promise<SessionSnapshot | null>;
  writeForkState(
    forkedSessionId: SessionId,
    snapshot: SessionSnapshot | null,
  ): Promise<SessionSnapshot | null>;
}

export interface PackageLocalRuntimeWorkspacePort {
  updateWorkspace(update: PackageLocalRuntimeWorkspaceUpdate): void;
}

export interface PackageLocalRuntimeWorkspaceUpdate {
  projectPath: string | undefined;
  environment: Record<string, string>;
}

export interface PackageLocalRuntimeMcpRegistryPort {
  disconnectAll(): Promise<void>;
  getCapabilities(): Promise<PackageLocalRuntimeMcpServerCapability[]>;
  registerInProcessServer?(
    serverName: string,
    config: SdkMcpServerHandle,
  ): Promise<void>;
  registerServer?(serverName: string, config: McpServerConfig): Promise<void>;
  ensureServerRegistered?(
    serverName: string,
    config: McpServerConfig | SdkMcpServerHandle,
  ): Promise<void>;
  connectServer?(serverName: string): Promise<void>;
  disconnectServer?(serverName: string): Promise<void>;
  reconnectServer?(serverName: string): Promise<void>;
  getAvailableToolsByServerNames?(
    serverNames: string[],
  ): Promise<PackageLocalRuntimeMcpTool[]>;
}

export interface PackageLocalRuntimeToolCatalogPort {
  registerAll<TTool extends PackageLocalRuntimeNamedTool>(
    tools: TTool[],
    source: PackageLocalRuntimeToolSource,
  ): void;
  registerMcpTool<TTool extends PackageLocalRuntimeMcpTool>(
    tool: TTool,
    source: PackageLocalRuntimeToolSource,
  ): void;
  removeMcpTools(serverName: string): number;
}

export type PackageLocalRuntimeToolSourceKind = 'builtin' | 'custom' | 'mcp' | 'session';
export type PackageLocalRuntimeToolTrustLevel = 'trusted' | 'workspace' | 'remote';

export interface PackageLocalRuntimeToolSource {
  kind: PackageLocalRuntimeToolSourceKind;
  trustLevel: PackageLocalRuntimeToolTrustLevel;
  sourceId: string;
}

export interface PackageLocalRuntimeLoggerPort {
  child?(category: unknown): PackageLocalRuntimeLoggerPort;
  debug?(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

export type PackageLocalRuntimeToolDefinition = NonNullable<SessionOptions['tools']>[number];
export type PackageLocalRuntimeAgentDefinition = NonNullable<SessionOptions['agents']>[string];

export interface PackageLocalRuntimeCustomToolFactoryPort {
  fromDefinition(definition: PackageLocalRuntimeToolDefinition): PackageLocalRuntimeNamedTool;
}

export interface PackageLocalRuntimeBuiltinToolContext {
  sessionId: SessionId;
  configDir: string | undefined;
  mcpRegistry: PackageLocalRuntimeMcpRegistryPort;
  includeMcpProtocolTools: boolean;
}

export interface PackageLocalRuntimeBuiltinToolProviderPort {
  getTools(context: PackageLocalRuntimeBuiltinToolContext): Promise<PackageLocalRuntimeNamedTool[]>;
}

export interface PackageLocalRuntimeSubagentRegistryPort {
  setLogger(logger: PackageLocalRuntimeLoggerPort): void;
  setProjectDir(projectDir?: string): void;
  loadFromStandardLocations(projectDir?: string, storageRoot?: string): number | undefined;
  register(config: SubagentConfig, options?: { override?: boolean }): void;
}

export type {
  PackageLocalRuntimePermissionHookPort,
  PackageLocalRuntimePermissionHookResult,
} from './runtimePermissions.js';

export interface PackageLocalRuntimeNamedTool {
  name: string;
}

export class PackageLocalSessionRuntime {
  readonly sessionId: SessionId;
  readonly options: SessionOptions;
  readonly bladeConfig: BladeConfig;
  readonly defaultContext: RuntimeContext;
  readonly storageRoot?: string;
  readonly projectPath?: string;
  readonly hookCallbacks: Partial<Record<SessionHookEvent, HookCallback[]>>;
  readonly sessionStore: PackageLocalRuntimeSessionStorePort;
  readonly workspace: PackageLocalRuntimeWorkspacePort;
  readonly mcpRegistry: PackageLocalRuntimeMcpRegistryPort;
  readonly toolCatalog: PackageLocalRuntimeToolCatalogPort;
  readonly logger: PackageLocalRuntimeLoggerPort;
  readonly customToolFactory?: PackageLocalRuntimeCustomToolFactoryPort;
  readonly builtinToolProvider?: PackageLocalRuntimeBuiltinToolProviderPort;
  readonly subagentRegistry: PackageLocalRuntimeSubagentRegistryPort;
  readonly permissionHooks: PackageLocalRuntimePermissionHookPort;
  readonly hookManager: PackageLocalRuntimeHookManagerPort;
  readonly hookRuntime: PackageLocalRuntimeHookRuntimePort;
  readonly backgroundAgentManager: PackageLocalRuntimeBackgroundAgentManagerPort;
  readonly executionPipelineFactory: PackageLocalRuntimeExecutionPipelineFactoryPort;
  readonly kernelPortFactory: PackageLocalRuntimeKernelPortFactoryPort;
  readonly kernelFactory: PackageLocalRuntimeAgentKernelFactoryPort;
  readonly kernelModelResolver: PackageLocalRuntimeKernelModelResolverPort;
  private readonly sessionLifecycleOperations: PackageLocalRuntimeSessionLifecycleOperations<SessionMessage>;
  private readonly mcpCapabilityOperations: PackageLocalRuntimeMcpCapabilityOperations;
  private readonly executionPipelineCache: PackageLocalRuntimeExecutionPipelineCache;
  private readonly agentRuntimeDepsOperations: PackageLocalAgentRuntimeDepsOperations;
  private readonly kernelPortOperations: PackageLocalRuntimeKernelPortOperations;
  private readonly agentKernelOperations: PackageLocalRuntimeAgentKernelOperations;
  private readonly toolRegistrationOperations: PackageLocalRuntimeToolRegistrationOperations<
    PackageLocalRuntimeNamedTool,
    PackageLocalRuntimeToolSource
  >;
  private readonly createForkSessionId?: () => SessionId;
  private readonly createForkSession?: (
    sessionId: SessionId,
    options: SessionOptions,
  ) => Promise<ISession> | ISession;
  private readonly traceManager: SessionTraceManager;

  constructor(options: PackageLocalSessionRuntimeOptions) {
    this.sessionId = options.sessionId;
    this.options = options.options;
    this.bladeConfig = options.bladeConfig;
    this.defaultContext = options.defaultContext;
    this.storageRoot =
      options.bladeConfig.storageRoot ??
      resolvePackageLocalRuntimeStorageRoot(options.options.storagePath);
    this.projectPath = getPackageLocalRuntimeContextCwd(options.defaultContext);
    this.hookCallbacks = options.options.hooks ?? {};
    const noopPorts = createPackageLocalRuntimeNoopPorts();
    this.sessionStore = options.sessionStore ?? noopPorts.sessionStore;
    this.workspace = options.workspace ?? noopPorts.workspace;
    this.mcpRegistry = options.mcpRegistry ?? noopPorts.mcpRegistry;
    this.toolCatalog = options.toolCatalog ?? noopPorts.toolCatalog;
    this.logger = options.logger ?? noopPorts.logger;
    this.customToolFactory = options.customToolFactory;
    this.builtinToolProvider = options.builtinToolProvider;
    this.subagentRegistry = options.subagentRegistry ?? noopPorts.subagentRegistry;
    this.permissionHooks = options.permissionHooks ?? noopPorts.permissionHooks;
    this.hookRuntime = options.hookRuntime ?? noopPorts.hookRuntime;
    this.hookManager = options.hookManager ?? this.hookRuntime;
    this.backgroundAgentManager = options.backgroundAgentManager ?? noopPorts.backgroundAgentManager;
    this.executionPipelineFactory =
      options.executionPipelineFactory ?? noopPorts.executionPipelineFactory;
    this.kernelPortFactory = options.kernelPortFactory ?? noopPorts.kernelPortFactory;
    this.kernelFactory = options.kernelFactory ?? noopPorts.kernelFactory;
    this.kernelModelResolver = options.kernelModelResolver ?? noopPorts.kernelModelResolver;
    this.sessionLifecycleOperations = createPackageLocalRuntimeSessionLifecycleOperations({
      sessionId: this.sessionId,
      sessionStore: this.sessionStore,
    });
    this.mcpCapabilityOperations = createPackageLocalRuntimeMcpCapabilityOperations({
      mcpRegistry: this.mcpRegistry,
    });
    this.executionPipelineCache = createPackageLocalRuntimeExecutionPipelineCache(() =>
      createPackageLocalRuntimeExecutionPipeline({
        bladeConfig: this.bladeConfig,
        permissionMode: this.options.permissionMode,
        permissionHandler: this.createPermissionHandler(),
        logger: this.logger,
        toolCatalog: this.toolCatalog,
        executionPipelineFactory: this.executionPipelineFactory,
      }),
    );
    this.agentRuntimeDepsOperations = createPackageLocalAgentRuntimeDepsOperations({
      createExecutionPipeline: () => this.createExecutionPipeline(),
      defaultContext: this.defaultContext,
      mcpRegistry: this.mcpRegistry,
      subagentRegistry: this.subagentRegistry,
      backgroundAgentManager: this.backgroundAgentManager,
      hookRuntime: this.hookRuntime,
      logger: this.logger,
    });
    this.kernelPortOperations = createPackageLocalRuntimeKernelPortOperations({
      kernelPortFactory: this.kernelPortFactory,
      toolCatalog: this.toolCatalog,
      createExecutionPipeline: () => this.createExecutionPipeline(),
      sessionId: this.sessionId,
      sessionStore: this.sessionStore,
      hookRuntime: this.hookRuntime,
    });
    this.agentKernelOperations = createPackageLocalRuntimeAgentKernelOperations({
      bladeConfig: this.bladeConfig,
      kernelModelResolver: this.kernelModelResolver,
      kernelFactory: this.kernelFactory,
      getStorePort: () => this.getKernelStorePort(),
      getHookPort: () => this.getKernelHookPort(),
      getTracePort: (recorder, maxContextTokens) =>
        this.getKernelTracePort(recorder, maxContextTokens),
      getToolPort: (createExecutionContext) => this.getKernelToolPort(createExecutionContext),
    });
    this.toolRegistrationOperations = createPackageLocalRuntimeToolRegistrationOperations({
      filterTools: (tools) => this.filterTools(tools),
      toolCatalog: this.toolCatalog,
    });
    this.createForkSessionId = options.createForkSessionId;
    this.createForkSession = options.createForkSession;
    this.traceManager = createPackageLocalRuntimeTraceManager({
      sessionId: this.sessionId,
      observability: options.options.observability,
      model: options.options.model,
      providerType: options.options.provider.type,
      permissionMode: options.options.permissionMode,
      logger: this.logger,
    });
  }

  getConfiguredMcpServers(): Record<string, McpServerConfig | SdkMcpServerHandle> {
    return this.options.mcpServers ?? {};
  }

  async ensureSessionCreated(): Promise<void> {
    await this.sessionLifecycleOperations.ensureSessionCreated();
  }

  async ensureSessionLoaded(): Promise<void> {
    await this.sessionLifecycleOperations.ensureSessionLoaded();
  }

  async loadMessages(): Promise<SessionMessage[]> {
    return this.sessionLifecycleOperations.loadMessages();
  }

  prepareTurn(snapshot: ContextSnapshot): void {
    preparePackageLocalRuntimeWorkspaceTurn({
      workspace: this.workspace,
      snapshot,
    });
  }

  async close(): Promise<void> {
    await closePackageLocalRuntimeMcpServers({
      mcpRegistry: this.mcpRegistry,
    });
  }

  async mcpCapabilities(): Promise<PackageLocalRuntimeMcpServerCapability[]> {
    return this.mcpCapabilityOperations.getCapabilities();
  }

  async mcpServerStatus(): Promise<McpServerStatus[]> {
    return this.mcpCapabilityOperations.getServerStatus();
  }

  async mcpListTools(): Promise<McpToolInfo[]> {
    return this.mcpCapabilityOperations.listTools();
  }

  async fork(options?: ForkSessionOptions): Promise<ISession> {
    return forkPackageLocalRuntimeSession({
      sessionId: this.sessionId,
      options: this.options,
      forkOptions: options,
      sessionStore: this.sessionStore,
      createForkSessionId: this.createForkSessionId,
      createForkSession: this.createForkSession,
    });
  }

  getLastTrace(): AgentTrace | undefined {
    return this.traceManager.getLastTrace();
  }

  getTraces(): AgentTrace[] {
    return this.traceManager.getTraces();
  }

  async mcpConnect(serverName: string): Promise<void> {
    await connectPackageLocalRuntimeMcpServer({
      serverName,
      configuredServers: this.options.mcpServers,
      mcpRegistry: this.mcpRegistry,
      refreshMcpTools: (serverNames) => this.refreshMcpTools(serverNames),
    });
  }

  async mcpDisconnect(serverName: string): Promise<void> {
    await disconnectPackageLocalRuntimeMcpServer({
      serverName,
      mcpRegistry: this.mcpRegistry,
      refreshMcpTools: (serverNames) => this.refreshMcpTools(serverNames),
    });
  }

  async mcpReconnect(serverName: string): Promise<void> {
    await reconnectPackageLocalRuntimeMcpServer({
      serverName,
      configuredServers: this.options.mcpServers,
      mcpRegistry: this.mcpRegistry,
      refreshMcpTools: (serverNames) => this.refreshMcpTools(serverNames),
    });
  }

  async registerConfiguredMcpServers(): Promise<void> {
    await registerPackageLocalConfiguredMcpServers({
      configuredServers: this.options.mcpServers,
      mcpRegistry: this.mcpRegistry,
      logger: this.logger,
      refreshMcpTools: (serverNames) => this.refreshMcpTools(serverNames),
    });
  }

  async refreshMcpTools(serverNames: string[]): Promise<void> {
    await refreshPackageLocalRuntimeMcpTools({
      serverNames,
      mcpRegistry: this.mcpRegistry,
      toolCatalog: this.toolCatalog,
      filterTools: (tools) => this.filterTools(tools),
    });
  }

  filterTools<TTool extends PackageLocalRuntimeNamedTool>(tools: TTool[]): TTool[] {
    return filterPackageLocalRuntimeTools(tools, {
      allowedTools: this.options.allowedTools,
      disallowedTools: this.options.disallowedTools,
    });
  }

  registerTools<TTool extends PackageLocalRuntimeNamedTool>(
    tools: TTool[],
    source: PackageLocalRuntimeToolSource,
  ): void {
    this.toolRegistrationOperations.registerTools(tools, source);
  }

  registerCustomTools(): void {
    registerPackageLocalRuntimeCustomTools({
      definitions: this.options.tools,
      customToolFactory: this.customToolFactory,
      registerTools: (tools, source) => {
        this.registerTools(tools, source);
      },
    });
  }

  async registerBuiltinTools(): Promise<void> {
    await registerPackageLocalRuntimeBuiltinTools({
      sessionId: this.sessionId,
      storageRoot: this.storageRoot,
      mcpRegistry: this.mcpRegistry,
      builtinToolProvider: this.builtinToolProvider,
      registerTools: (tools, source) => {
        this.registerTools(tools, source);
      },
    });
  }

  initializeSubagents(): void {
    initializePackageLocalRuntimeSubagents({
      subagentRegistry: this.subagentRegistry,
      logger: this.logger,
      projectPath: this.projectPath,
      storageRoot: this.storageRoot,
      agents: this.options.agents,
    });
  }

  createPermissionHandler(): PermissionHandler | undefined {
    return createPackageLocalRuntimePermissionHandler({
      hasPermissionCallbacks: (this.hookCallbacks[HookEvent.PermissionRequest]?.length ?? 0) > 0,
      permissionHooks: this.permissionHooks,
      permissionHandler: this.options.permissionHandler,
      canUseTool: this.options.canUseTool,
    });
  }

  initializeHooks(): void {
    initializePackageLocalRuntimeHooks({
      hookManager: this.hookManager,
      hooks: this.hookCallbacks,
    });
  }

  createExecutionPipeline(): unknown {
    return this.executionPipelineCache.get();
  }

  getAgentRuntimeDeps(): PackageLocalAgentRuntimeDeps {
    return this.agentRuntimeDepsOperations.get();
  }

  getKernelToolPort(
    createExecutionContext: (
      toolCall: AgentToolCall,
      signal?: AbortSignal,
    ) => ExecutionContext,
  ): AgentToolPort {
    return this.kernelPortOperations.createToolPort(createExecutionContext);
  }

  getKernelStorePort(): AgentStorePort {
    return this.kernelPortOperations.createStorePort();
  }

  getKernelTracePort(recorder: TraceRecorder, maxContextTokens?: number): AgentTracePort {
    return this.kernelPortOperations.createTracePort(recorder, maxContextTokens);
  }

  getKernelHookPort(): AgentHookPort {
    return this.kernelPortOperations.createHookPort();
  }

  createAgentKernel(
    options: PackageLocalRuntimeAgentKernelOptions = {},
  ): PackageLocalRuntimeAgentKernelPort {
    return this.agentKernelOperations.createFromOptions(options);
  }

  async *streamAgentKernelTurn(
    options: PackageLocalRuntimeAgentKernelStreamOptions,
  ): AsyncGenerator<StreamMessage> {
    yield* streamPackageLocalRuntimeAgentKernelTurn({
      sessionId: this.sessionId,
      streamOptions: options,
      bladeConfig: this.bladeConfig,
      traceManager: this.traceManager,
      hookRuntime: this.hookRuntime,
      kernelModelResolver: this.kernelModelResolver,
      createAgentKernel: this.agentKernelOperations.createFromResolved,
    });
  }

}
