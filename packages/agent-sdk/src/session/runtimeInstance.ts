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
import type {
  PackageLocalRuntimeHookOperations,
  PackageLocalRuntimeHookManagerPort,
  PackageLocalRuntimeHookRuntimePort,
} from './runtimeHooks.js';
import {
  createPackageLocalRuntimeExecutionPipelineOperations,
  type PackageLocalRuntimeExecutionPipelineOperations,
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
  createPackageLocalRuntimeKernelTurnStreamOperations,
  type PackageLocalRuntimeAgentKernelOptions,
  type PackageLocalRuntimeAgentKernelStreamOptions,
  type PackageLocalRuntimeKernelTurnStreamOperations,
} from './runtimeKernelTurnStream.js';
import type {
  PackageLocalRuntimeKernelModelResolverPort,
} from './runtimeKernelModels.js';
import {
  getPackageLocalRuntimeContextCwd,
  resolvePackageLocalRuntimeStorageRoot,
} from './runtimeContext.js';
import {
  createPackageLocalRuntimeWorkspaceOperations,
  type PackageLocalRuntimeWorkspaceOperations,
} from './runtimeWorkspace.js';
import {
  createPackageLocalRuntimeSessionLifecycleOperations,
  type PackageLocalRuntimeSessionLifecycleOperations,
} from './runtimeSessionLifecycle.js';
import type {
  PackageLocalRuntimeMcpServerConfigOperations,
  PackageLocalRuntimeMcpServerRegistrationOperations,
  PackageLocalRuntimeMcpServerLifecycleOperations,
} from './runtimeMcpServers.js';
import type {
  PackageLocalRuntimeMcpCapabilityOperations,
  PackageLocalRuntimeMcpServerCapability,
} from './runtimeMcpCapabilities.js';
import type {
  PackageLocalRuntimeMcpToolRefreshOperations,
  PackageLocalRuntimeMcpTool,
} from './runtimeMcpTools.js';
import { createPackageLocalRuntimeMcpOperations } from './runtimeMcp.js';
import { resolvePackageLocalRuntimePorts } from './runtimeNoopPorts.js';
import {
  createPackageLocalRuntimeSubagentOperations,
  type PackageLocalRuntimeSubagentOperations,
} from './runtimeSubagents.js';
import type { PackageLocalRuntimeToolFilterOperations } from './runtimeToolFilters.js';
import type {
  PackageLocalRuntimeToolRegistrationOperations,
  PackageLocalRuntimeSessionToolRegistrationOperations,
} from './runtimeToolRegistration.js';
import { createPackageLocalRuntimeToolOperations } from './runtimeTools.js';
import type {
  PackageLocalRuntimePermissionHookPort,
  PackageLocalRuntimePermissionOperations,
} from './runtimePermissions.js';
import { createPackageLocalRuntimeGuardOperations } from './runtimeGuards.js';
import {
  createPackageLocalRuntimeTraceRuntime,
  type PackageLocalRuntimeTraceOperations,
} from './runtimeTraceManager.js';
import {
  createPackageLocalRuntimeForkOperations,
  type PackageLocalRuntimeForkOperations,
} from './runtimeForking.js';
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
  private readonly workspaceOperations: PackageLocalRuntimeWorkspaceOperations;
  private readonly mcpCapabilityOperations: PackageLocalRuntimeMcpCapabilityOperations;
  private readonly mcpServerConfigOperations: PackageLocalRuntimeMcpServerConfigOperations;
  private readonly mcpServerRegistrationOperations: PackageLocalRuntimeMcpServerRegistrationOperations;
  private readonly mcpServerLifecycleOperations: PackageLocalRuntimeMcpServerLifecycleOperations;
  private readonly mcpToolRefreshOperations: PackageLocalRuntimeMcpToolRefreshOperations;
  private readonly executionPipelineOperations: PackageLocalRuntimeExecutionPipelineOperations;
  private readonly agentRuntimeDepsOperations: PackageLocalAgentRuntimeDepsOperations;
  private readonly kernelPortOperations: PackageLocalRuntimeKernelPortOperations;
  private readonly agentKernelOperations: PackageLocalRuntimeAgentKernelOperations;
  private readonly kernelTurnStreamOperations: PackageLocalRuntimeKernelTurnStreamOperations;
  private readonly toolRegistrationOperations: PackageLocalRuntimeToolRegistrationOperations<
    PackageLocalRuntimeNamedTool,
    PackageLocalRuntimeToolSource
  >;
  private readonly sessionToolRegistrationOperations: PackageLocalRuntimeSessionToolRegistrationOperations;
  private readonly toolFilterOperations: PackageLocalRuntimeToolFilterOperations;
  private readonly permissionOperations: PackageLocalRuntimePermissionOperations;
  private readonly hookOperations: PackageLocalRuntimeHookOperations;
  private readonly subagentOperations: PackageLocalRuntimeSubagentOperations;
  private readonly traceOperations: PackageLocalRuntimeTraceOperations;
  private readonly forkOperations: PackageLocalRuntimeForkOperations;
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
    const runtimePorts = resolvePackageLocalRuntimePorts(options);
    this.sessionStore = runtimePorts.sessionStore;
    this.workspace = runtimePorts.workspace;
    this.mcpRegistry = runtimePorts.mcpRegistry;
    this.toolCatalog = runtimePorts.toolCatalog;
    this.logger = runtimePorts.logger;
    this.customToolFactory = options.customToolFactory;
    this.builtinToolProvider = options.builtinToolProvider;
    this.subagentRegistry = runtimePorts.subagentRegistry;
    this.permissionHooks = runtimePorts.permissionHooks;
    this.hookRuntime = runtimePorts.hookRuntime;
    this.hookManager = runtimePorts.hookManager;
    this.backgroundAgentManager = runtimePorts.backgroundAgentManager;
    this.executionPipelineFactory = runtimePorts.executionPipelineFactory;
    this.kernelPortFactory = runtimePorts.kernelPortFactory;
    this.kernelFactory = runtimePorts.kernelFactory;
    this.kernelModelResolver = runtimePorts.kernelModelResolver;
    this.sessionLifecycleOperations = createPackageLocalRuntimeSessionLifecycleOperations({
      sessionId: this.sessionId,
      sessionStore: this.sessionStore,
    });
    this.workspaceOperations = createPackageLocalRuntimeWorkspaceOperations({
      workspace: this.workspace,
    });
    const mcpOperations = createPackageLocalRuntimeMcpOperations({
      mcpRegistry: this.mcpRegistry,
      configuredServers: this.options.mcpServers,
      logger: this.logger,
      toolCatalog: this.toolCatalog,
      filterTools: (tools) => this.filterTools(tools),
      refreshMcpTools: (serverNames) => this.refreshMcpTools(serverNames),
    });
    this.mcpCapabilityOperations = mcpOperations.capabilities;
    const mcpServerOperations = mcpOperations.servers;
    this.mcpServerConfigOperations = mcpServerOperations.config;
    this.mcpServerRegistrationOperations = mcpServerOperations.registration;
    this.mcpServerLifecycleOperations = mcpServerOperations.lifecycle;
    this.mcpToolRefreshOperations = mcpOperations.tools;
    this.executionPipelineOperations = createPackageLocalRuntimeExecutionPipelineOperations({
      bladeConfig: this.bladeConfig,
      permissionMode: this.options.permissionMode,
      createPermissionHandler: () => this.createPermissionHandler(),
      logger: this.logger,
      toolCatalog: this.toolCatalog,
      executionPipelineFactory: this.executionPipelineFactory,
    });
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
    const toolOperations = createPackageLocalRuntimeToolOperations({
      allowedTools: this.options.allowedTools,
      disallowedTools: this.options.disallowedTools,
      definitions: this.options.tools,
      customToolFactory: this.customToolFactory,
      sessionId: this.sessionId,
      storageRoot: this.storageRoot,
      mcpRegistry: this.mcpRegistry,
      builtinToolProvider: this.builtinToolProvider,
      toolCatalog: this.toolCatalog,
      registerTools: (tools, source) => {
        this.registerTools(tools, source);
      },
    });
    this.toolRegistrationOperations = toolOperations.registration;
    this.sessionToolRegistrationOperations = toolOperations.sessionRegistration;
    this.toolFilterOperations = toolOperations.filter;
    const guardOperations = createPackageLocalRuntimeGuardOperations({
      hooks: this.hookCallbacks,
      hookManager: this.hookManager,
      permissionHooks: this.permissionHooks,
      permissionHandler: this.options.permissionHandler,
      canUseTool: this.options.canUseTool,
    });
    this.permissionOperations = guardOperations.permissions;
    this.hookOperations = guardOperations.hooks;
    this.subagentOperations = createPackageLocalRuntimeSubagentOperations({
      subagentRegistry: this.subagentRegistry,
      logger: this.logger,
      projectPath: this.projectPath,
      storageRoot: this.storageRoot,
      agents: this.options.agents,
    });
    this.forkOperations = createPackageLocalRuntimeForkOperations({
      sessionId: this.sessionId,
      options: this.options,
      sessionStore: this.sessionStore,
      createForkSessionId: options.createForkSessionId,
      createForkSession: options.createForkSession,
    });
    const traceRuntime = createPackageLocalRuntimeTraceRuntime({
      sessionId: this.sessionId,
      observability: options.options.observability,
      model: options.options.model,
      providerType: options.options.provider.type,
      permissionMode: options.options.permissionMode,
      logger: this.logger,
    });
    this.traceManager = traceRuntime.traceManager;
    this.kernelTurnStreamOperations = createPackageLocalRuntimeKernelTurnStreamOperations({
      sessionId: this.sessionId,
      bladeConfig: this.bladeConfig,
      traceManager: this.traceManager,
      hookRuntime: this.hookRuntime,
      kernelModelResolver: this.kernelModelResolver,
      createAgentKernel: this.agentKernelOperations.createFromResolved,
    });
    this.traceOperations = traceRuntime.traceOperations;
  }

  getConfiguredMcpServers(): Record<string, McpServerConfig | SdkMcpServerHandle> {
    return this.mcpServerConfigOperations.getConfigured();
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
    this.workspaceOperations.prepareTurn(snapshot);
  }

  async close(): Promise<void> {
    await this.mcpServerLifecycleOperations.close();
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
    return this.forkOperations.fork(options);
  }

  getLastTrace(): AgentTrace | undefined {
    return this.traceOperations.getLastTrace();
  }

  getTraces(): AgentTrace[] {
    return this.traceOperations.getTraces();
  }

  async mcpConnect(serverName: string): Promise<void> {
    await this.mcpServerLifecycleOperations.connect(serverName);
  }

  async mcpDisconnect(serverName: string): Promise<void> {
    await this.mcpServerLifecycleOperations.disconnect(serverName);
  }

  async mcpReconnect(serverName: string): Promise<void> {
    await this.mcpServerLifecycleOperations.reconnect(serverName);
  }

  async registerConfiguredMcpServers(): Promise<void> {
    await this.mcpServerRegistrationOperations.registerConfigured();
  }

  async refreshMcpTools(serverNames: string[]): Promise<void> {
    await this.mcpToolRefreshOperations.refresh(serverNames);
  }

  filterTools<TTool extends PackageLocalRuntimeNamedTool>(tools: TTool[]): TTool[] {
    return this.toolFilterOperations.filter(tools);
  }

  registerTools<TTool extends PackageLocalRuntimeNamedTool>(
    tools: TTool[],
    source: PackageLocalRuntimeToolSource,
  ): void {
    this.toolRegistrationOperations.registerTools(tools, source);
  }

  registerCustomTools(): void {
    this.sessionToolRegistrationOperations.registerCustomTools();
  }

  async registerBuiltinTools(): Promise<void> {
    await this.sessionToolRegistrationOperations.registerBuiltinTools();
  }

  initializeSubagents(): void {
    this.subagentOperations.initialize();
  }

  createPermissionHandler(): PermissionHandler | undefined {
    return this.permissionOperations.createPermissionHandler();
  }

  initializeHooks(): void {
    this.hookOperations.initialize();
  }

  createExecutionPipeline(): unknown {
    return this.executionPipelineOperations.get();
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
    yield* this.kernelTurnStreamOperations.stream(options);
  }

}
