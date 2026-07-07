import type {
  AgentHookPort,
  AgentStorePort,
  AgentToolCall,
  AgentToolPort,
  AgentTracePort,
} from '@blade-ai/agent';
import type { ContextSnapshot, RuntimeContext } from '../runtime/types.js';
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
  PackageLocalSessionRuntimeOptions,
  PackageLocalRuntimeBuiltinToolProviderPort,
  PackageLocalRuntimeCustomToolFactoryPort,
  PackageLocalRuntimeLoggerPort,
  PackageLocalRuntimeMcpRegistryPort,
  PackageLocalRuntimeNamedTool,
  PackageLocalRuntimeSessionStorePort,
  PackageLocalRuntimeSubagentRegistryPort,
  PackageLocalRuntimeToolCatalogPort,
  PackageLocalRuntimeToolSource,
  PackageLocalRuntimeWorkspacePort,
} from './runtimePorts.js';
import type {
  PackageLocalRuntimeHookManagerPort,
  PackageLocalRuntimeHookRuntimePort,
} from './runtimeHooks.js';
import type {
  PackageLocalRuntimeExecutionPipelineFactoryPort,
} from './runtimeExecutionPipeline.js';
import {
  createPackageLocalRuntimeExecutionOperations,
  type PackageLocalRuntimeExecutionOperations,
} from './runtimeExecution.js';
import type {
  PackageLocalRuntimeAgentKernelFactoryPort,
  PackageLocalRuntimeAgentKernelPort,
} from './runtimeAgentKernels.js';
import type {
  PackageLocalAgentRuntimeDeps,
  PackageLocalRuntimeBackgroundAgentManagerPort,
} from './runtimeAgentDeps.js';
import type {
  PackageLocalRuntimeKernelPortFactoryPort,
} from './runtimeKernelPorts.js';
import {
  createPackageLocalRuntimeKernelOperations,
  type PackageLocalRuntimeKernelOperations,
} from './runtimeKernel.js';
import type {
  PackageLocalRuntimeAgentKernelOptions,
  PackageLocalRuntimeAgentKernelStreamOptions,
} from './runtimeKernelTurnStream.js';
import type {
  PackageLocalRuntimeKernelModelResolverPort,
} from './runtimeKernelModels.js';
import { createPackageLocalRuntimeBootstrap } from './runtimeBootstrap.js';
import { projectPackageLocalRuntimePortFields } from './runtimePortProjection.js';
import type { PackageLocalRuntimeMcpServerCapability } from './runtimeMcpCapabilities.js';
import {
  createPackageLocalRuntimeConnectionOperations,
  type PackageLocalRuntimeConnectionOperations,
} from './runtimeConnectionOperations.js';
import {
  createPackageLocalRuntimeToolOperations,
  type PackageLocalRuntimeToolOperations,
} from './runtimeTools.js';
import type {
  PackageLocalRuntimePermissionHookPort,
} from './runtimePermissions.js';
import {
  createPackageLocalRuntimeGuardOperations,
  type PackageLocalRuntimeGuardOperations,
} from './runtimeGuards.js';
import {
  createPackageLocalRuntimeTurnOperations,
  type PackageLocalRuntimeTurnOperations,
} from './runtimeTurn.js';
import {
  createPackageLocalRuntimeSessionCapabilityOperations,
  type PackageLocalRuntimeSessionCapabilityOperations,
} from './runtimeSessionCapabilities.js';
import {
  createPackageLocalRuntimeCapabilityOperations,
  type PackageLocalRuntimeCapabilityOperations,
} from './runtimeCapabilities.js';
import {
  createPackageLocalRuntimeControlOperations,
  type PackageLocalRuntimeControlOperations,
} from './runtimeControls.js';

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
export type {
  PackageLocalRuntimeAgentDefinition,
  PackageLocalRuntimeBuiltinToolContext,
  PackageLocalRuntimeBuiltinToolProviderPort,
  PackageLocalRuntimeCustomToolFactoryPort,
  PackageLocalRuntimeLoggerPort,
  PackageLocalRuntimeMcpRegistryPort,
  PackageLocalRuntimeNamedTool,
  PackageLocalRuntimePermissionHookPort,
  PackageLocalRuntimePermissionHookResult,
  PackageLocalRuntimeSessionStorePort,
  PackageLocalRuntimeSubagentRegistryPort,
  PackageLocalRuntimeToolCatalogPort,
  PackageLocalRuntimeToolDefinition,
  PackageLocalRuntimeToolSource,
  PackageLocalRuntimeToolSourceKind,
  PackageLocalRuntimeToolTrustLevel,
  PackageLocalRuntimeWorkspacePort,
  PackageLocalRuntimeWorkspaceUpdate,
  PackageLocalSessionRuntimeOptions,
} from './runtimePorts.js';

export class PackageLocalSessionRuntime {
  readonly sessionId: SessionId;
  readonly options: SessionOptions;
  readonly bladeConfig: BladeConfig;
  defaultContext: RuntimeContext;
  readonly storageRoot?: string;
  projectPath?: string;
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
  private readonly connectionOperations: PackageLocalRuntimeConnectionOperations<SessionMessage>;
  private readonly executionOperations: PackageLocalRuntimeExecutionOperations;
  private readonly kernelOperations: PackageLocalRuntimeKernelOperations;
  private readonly turnOperations: PackageLocalRuntimeTurnOperations;
  private readonly toolOperations: PackageLocalRuntimeToolOperations<
    PackageLocalRuntimeNamedTool,
    PackageLocalRuntimeToolSource
  >;
  private readonly guardOperations: PackageLocalRuntimeGuardOperations;
  private readonly sessionCapabilityOperations: PackageLocalRuntimeSessionCapabilityOperations;
  private readonly capabilityOperations: PackageLocalRuntimeCapabilityOperations;
  private readonly controlOperations: PackageLocalRuntimeControlOperations;

  constructor(options: PackageLocalSessionRuntimeOptions) {
    this.sessionId = options.sessionId;
    this.options = options.options;
    this.bladeConfig = options.bladeConfig;
    this.defaultContext = options.defaultContext;
    const bootstrap = createPackageLocalRuntimeBootstrap(options);
    this.storageRoot = bootstrap.initialState.storageRoot;
    this.projectPath = bootstrap.initialState.projectPath;
    this.hookCallbacks = bootstrap.initialState.hookCallbacks;
    const runtimePortFields = projectPackageLocalRuntimePortFields({
      ports: bootstrap.ports,
      options,
    });
    this.sessionStore = runtimePortFields.sessionStore;
    this.workspace = runtimePortFields.workspace;
    this.mcpRegistry = runtimePortFields.mcpRegistry;
    this.toolCatalog = runtimePortFields.toolCatalog;
    this.logger = runtimePortFields.logger;
    this.customToolFactory = runtimePortFields.customToolFactory;
    this.builtinToolProvider = runtimePortFields.builtinToolProvider;
    this.subagentRegistry = runtimePortFields.subagentRegistry;
    this.permissionHooks = runtimePortFields.permissionHooks;
    this.hookRuntime = runtimePortFields.hookRuntime;
    this.hookManager = runtimePortFields.hookManager;
    this.backgroundAgentManager = runtimePortFields.backgroundAgentManager;
    this.executionPipelineFactory = runtimePortFields.executionPipelineFactory;
    this.kernelPortFactory = runtimePortFields.kernelPortFactory;
    this.kernelFactory = runtimePortFields.kernelFactory;
    this.kernelModelResolver = runtimePortFields.kernelModelResolver;
    this.connectionOperations = createPackageLocalRuntimeConnectionOperations({
      sessionId: this.sessionId,
      sessionStore: this.sessionStore,
      workspace: this.workspace,
      hookRuntime: this.hookRuntime,
      model: this.options.model,
      provider: this.options.provider.type,
      mcpRegistry: this.mcpRegistry,
      configuredServers: this.options.mcpServers,
      logger: this.logger,
      toolCatalog: this.toolCatalog,
      filterTools: (tools) => this.filterTools(tools),
      refreshMcpTools: (serverNames) => this.refreshMcpTools(serverNames),
    });
    this.executionOperations = createPackageLocalRuntimeExecutionOperations({
      bladeConfig: this.bladeConfig,
      permissionMode: this.options.permissionMode,
      getPermissionMode: () => this.options.permissionMode,
      createPermissionHandler: () => this.createPermissionHandler(),
      logger: this.logger,
      toolCatalog: this.toolCatalog,
      executionPipelineFactory: this.executionPipelineFactory,
      defaultContext: this.defaultContext,
      getDefaultContext: () => this.defaultContext,
      mcpRegistry: this.mcpRegistry,
      subagentRegistry: this.subagentRegistry,
      backgroundAgentManager: this.backgroundAgentManager,
      hookRuntime: this.hookRuntime,
    });
    this.kernelOperations = createPackageLocalRuntimeKernelOperations({
      bladeConfig: this.bladeConfig,
      kernelModelResolver: this.kernelModelResolver,
      kernelFactory: this.kernelFactory,
      kernelPortFactory: this.kernelPortFactory,
      toolCatalog: this.toolCatalog,
      createExecutionPipeline: () => this.createExecutionPipeline(),
      sessionId: this.sessionId,
      sessionStore: this.sessionStore,
      hookRuntime: this.hookRuntime,
    });
    this.toolOperations = createPackageLocalRuntimeToolOperations({
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
    this.guardOperations = createPackageLocalRuntimeGuardOperations({
      hooks: this.hookCallbacks,
      hookManager: this.hookManager,
      permissionHooks: this.permissionHooks,
      permissionHandler: this.options.permissionHandler,
      canUseTool: this.options.canUseTool,
    });
    this.sessionCapabilityOperations = createPackageLocalRuntimeSessionCapabilityOperations({
      sessionId: this.sessionId,
      options: this.options,
      sessionStore: this.sessionStore,
      createForkSessionId: options.createForkSessionId,
      createForkSession: options.createForkSession,
      subagentRegistry: this.subagentRegistry,
      logger: this.logger,
      projectPath: this.projectPath,
      getProjectPath: () => this.projectPath,
      storageRoot: this.storageRoot,
    });
    this.turnOperations = createPackageLocalRuntimeTurnOperations({
      sessionId: this.sessionId,
      observability: options.options.observability,
      model: options.options.model,
      providerType: options.options.provider.type,
      permissionMode: options.options.permissionMode,
      logger: this.logger,
      bladeConfig: this.bladeConfig,
      hookRuntime: this.hookRuntime,
      kernelModelResolver: this.kernelModelResolver,
      createAgentKernel: this.kernelOperations.agentKernel.createFromResolved,
    });
    this.capabilityOperations = createPackageLocalRuntimeCapabilityOperations({
      registerConfiguredMcpServers: () => this.registerConfiguredMcpServers(),
      registerCustomTools: () => this.registerCustomTools(),
      registerBuiltinTools: () => this.registerBuiltinTools(),
      initializeSubagents: () => this.initializeSubagents(),
      initializeHooks: () => this.initializeHooks(),
    });
    this.controlOperations = createPackageLocalRuntimeControlOperations({
      options: this.options,
      bladeConfig: this.bladeConfig,
      setDefaultContext: (context) => {
        this.defaultContext = context;
      },
      setProjectPath: (projectPath) => {
        this.projectPath = projectPath;
      },
      resetExecutionPipeline: () => this.executionOperations.pipeline.reset(),
      markSubagentLocationsDirty: () =>
        this.capabilityOperations.initialization.markSubagentLocationsDirty(),
    });
  }

  getConfiguredMcpServers(): Record<string, McpServerConfig | SdkMcpServerHandle> {
    return this.connectionOperations.mcp.servers.config.getConfigured();
  }

  async ensureSessionCreated(): Promise<void> {
    await this.connectionOperations.session.lifecycle.ensureSessionCreated();
  }

  async ensureSessionLoaded(): Promise<void> {
    await this.connectionOperations.session.lifecycle.ensureSessionLoaded();
  }

  async loadMessages(): Promise<SessionMessage[]> {
    return this.connectionOperations.session.lifecycle.loadMessages();
  }

  async runSessionStart(isResume: boolean): Promise<void> {
    await this.connectionOperations.session.lifecycle.runSessionStart(isResume);
  }

  prepareTurn(snapshot: ContextSnapshot): void {
    this.connectionOperations.session.workspace.prepareTurn(snapshot);
  }

  async close(): Promise<void> {
    await this.connectionOperations.session.lifecycle.close();
  }

  async mcpCapabilities(): Promise<PackageLocalRuntimeMcpServerCapability[]> {
    return this.connectionOperations.mcp.capabilities.getCapabilities();
  }

  async mcpServerStatus(): Promise<McpServerStatus[]> {
    return this.connectionOperations.mcp.capabilities.getServerStatus();
  }

  async mcpListTools(): Promise<McpToolInfo[]> {
    return this.connectionOperations.mcp.capabilities.listTools();
  }

  setDefaultContext(context: RuntimeContext): void {
    this.controlOperations.setDefaultContext(context);
  }

  setPermissionMode(mode: Parameters<ISession['setPermissionMode']>[0]): void {
    this.controlOperations.setPermissionMode(mode);
  }

  async setModel(model: Parameters<ISession['setModel']>[0]): Promise<void> {
    await this.controlOperations.setModel(model);
  }

  setMaxTurns(maxTurns: Parameters<ISession['setMaxTurns']>[0]): void {
    this.controlOperations.setMaxTurns(maxTurns);
  }

  async fork(options?: ForkSessionOptions): Promise<ISession> {
    return this.sessionCapabilityOperations.fork.fork(options);
  }

  getLastTrace(): AgentTrace | undefined {
    return this.turnOperations.traceOperations.getLastTrace();
  }

  getTraces(): AgentTrace[] {
    return this.turnOperations.traceOperations.getTraces();
  }

  async mcpConnect(serverName: string): Promise<void> {
    await this.connectionOperations.mcp.servers.lifecycle.connect(serverName);
  }

  async mcpDisconnect(serverName: string): Promise<void> {
    await this.connectionOperations.mcp.servers.lifecycle.disconnect(serverName);
  }

  async mcpReconnect(serverName: string): Promise<void> {
    await this.connectionOperations.mcp.servers.lifecycle.reconnect(serverName);
  }

  async registerConfiguredMcpServers(): Promise<void> {
    await this.connectionOperations.mcp.servers.registration.registerConfigured();
  }

  async ensureRuntimeCapabilitiesInitialized(): Promise<void> {
    await this.capabilityOperations.initialization.ensureInitialized();
  }

  async refreshMcpTools(serverNames: string[]): Promise<void> {
    await this.connectionOperations.mcp.tools.refresh(serverNames);
  }

  filterTools<TTool extends PackageLocalRuntimeNamedTool>(tools: TTool[]): TTool[] {
    return this.toolOperations.filter.filter(tools);
  }

  registerTools<TTool extends PackageLocalRuntimeNamedTool>(
    tools: TTool[],
    source: PackageLocalRuntimeToolSource,
  ): void {
    this.toolOperations.registration.registerTools(tools, source);
  }

  registerCustomTools(): void {
    this.toolOperations.sessionRegistration.registerCustomTools();
  }

  async registerBuiltinTools(): Promise<void> {
    await this.toolOperations.sessionRegistration.registerBuiltinTools();
  }

  initializeSubagents(): void {
    this.sessionCapabilityOperations.subagents.initialize();
  }

  createPermissionHandler(): PermissionHandler | undefined {
    return this.guardOperations.permissions.createPermissionHandler();
  }

  initializeHooks(): void {
    this.guardOperations.hooks.initialize();
  }

  createExecutionPipeline(): unknown {
    return this.executionOperations.pipeline.get();
  }

  getAgentRuntimeDeps(): PackageLocalAgentRuntimeDeps {
    return this.executionOperations.agentDeps.get();
  }

  getKernelToolPort(
    createExecutionContext: (
      toolCall: AgentToolCall,
      signal?: AbortSignal,
    ) => ExecutionContext,
  ): AgentToolPort {
    return this.kernelOperations.ports.createToolPort(createExecutionContext);
  }

  getKernelStorePort(): AgentStorePort {
    return this.kernelOperations.ports.createStorePort();
  }

  getKernelTracePort(recorder: TraceRecorder, maxContextTokens?: number): AgentTracePort {
    return this.kernelOperations.ports.createTracePort(recorder, maxContextTokens);
  }

  getKernelHookPort(): AgentHookPort {
    return this.kernelOperations.ports.createHookPort();
  }

  createAgentKernel(
    options: PackageLocalRuntimeAgentKernelOptions = {},
  ): PackageLocalRuntimeAgentKernelPort {
    return this.kernelOperations.agentKernel.createFromOptions(options);
  }

  async *streamAgentKernelTurn(
    options: PackageLocalRuntimeAgentKernelStreamOptions,
  ): AsyncGenerator<StreamMessage> {
    yield* this.turnOperations.kernelTurnStream.stream(options);
  }

}
