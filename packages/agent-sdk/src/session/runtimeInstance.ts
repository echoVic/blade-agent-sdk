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
  PackageLocalRuntimeHookOperations,
  PackageLocalRuntimeHookManagerPort,
  PackageLocalRuntimeHookRuntimePort,
} from './runtimeHooks.js';
import type {
  PackageLocalRuntimeExecutionPipelineOperations,
  PackageLocalRuntimeExecutionPipelineFactoryPort,
} from './runtimeExecutionPipeline.js';
import { createPackageLocalRuntimeExecutionOperations } from './runtimeExecution.js';
import type {
  PackageLocalRuntimeAgentKernelOperations,
  PackageLocalRuntimeAgentKernelFactoryPort,
  PackageLocalRuntimeAgentKernelPort,
} from './runtimeAgentKernels.js';
import type {
  PackageLocalAgentRuntimeDeps,
  PackageLocalAgentRuntimeDepsOperations,
  PackageLocalRuntimeBackgroundAgentManagerPort,
} from './runtimeAgentDeps.js';
import type {
  PackageLocalRuntimeKernelPortFactoryPort,
  PackageLocalRuntimeKernelPortOperations,
} from './runtimeKernelPorts.js';
import { createPackageLocalRuntimeKernelOperations } from './runtimeKernel.js';
import type {
  PackageLocalRuntimeAgentKernelOptions,
  PackageLocalRuntimeAgentKernelStreamOptions,
  PackageLocalRuntimeKernelTurnStreamOperations,
} from './runtimeKernelTurnStream.js';
import type {
  PackageLocalRuntimeKernelModelResolverPort,
} from './runtimeKernelModels.js';
import { createPackageLocalRuntimeInitialState } from './runtimeState.js';
import type { PackageLocalRuntimeWorkspaceOperations } from './runtimeWorkspace.js';
import type { PackageLocalRuntimeSessionLifecycleOperations } from './runtimeSessionLifecycle.js';
import { createPackageLocalRuntimeSessionOperations } from './runtimeSessionOperations.js';
import type { PackageLocalRuntimeMcpServerCapability } from './runtimeMcpCapabilities.js';
import {
  createPackageLocalRuntimeMcpOperations,
  type PackageLocalRuntimeMcpOperations,
} from './runtimeMcp.js';
import { resolvePackageLocalRuntimePorts } from './runtimeNoopPorts.js';
import type { PackageLocalRuntimeSubagentOperations } from './runtimeSubagents.js';
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
import type {
  PackageLocalRuntimeTraceOperations,
} from './runtimeTraceManager.js';
import { createPackageLocalRuntimeTurnOperations } from './runtimeTurn.js';
import type { PackageLocalRuntimeForkOperations } from './runtimeForking.js';
import { createPackageLocalRuntimeSessionCapabilityOperations } from './runtimeSessionCapabilities.js';
import {
  createPackageLocalRuntimeCapabilityOperations,
  type PackageLocalRuntimeCapabilityInitializationOperations,
} from './runtimeCapabilities.js';
import {
  createPackageLocalRuntimeControlOperations,
  type PackageLocalRuntimeControlOperations,
} from './runtimeControls.js';
import type { SessionTraceManager } from './traces.js';

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
  private readonly sessionLifecycleOperations: PackageLocalRuntimeSessionLifecycleOperations<SessionMessage>;
  private readonly workspaceOperations: PackageLocalRuntimeWorkspaceOperations;
  private readonly mcpOperations: PackageLocalRuntimeMcpOperations;
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
  private readonly capabilityInitializationOperations: PackageLocalRuntimeCapabilityInitializationOperations;
  private readonly controlOperations: PackageLocalRuntimeControlOperations;

  constructor(options: PackageLocalSessionRuntimeOptions) {
    this.sessionId = options.sessionId;
    this.options = options.options;
    this.bladeConfig = options.bladeConfig;
    this.defaultContext = options.defaultContext;
    const initialState = createPackageLocalRuntimeInitialState({
      options: options.options,
      bladeConfig: options.bladeConfig,
      defaultContext: options.defaultContext,
    });
    this.storageRoot = initialState.storageRoot;
    this.projectPath = initialState.projectPath;
    this.hookCallbacks = initialState.hookCallbacks;
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
    const sessionOperations = createPackageLocalRuntimeSessionOperations({
      sessionId: this.sessionId,
      sessionStore: this.sessionStore,
      workspace: this.workspace,
      hookRuntime: this.hookRuntime,
      model: this.options.model,
      provider: this.options.provider.type,
      closeRuntimeResources: () => this.mcpOperations.servers.lifecycle.close(),
    });
    this.sessionLifecycleOperations = sessionOperations.lifecycle;
    this.workspaceOperations = sessionOperations.workspace;
    this.mcpOperations = createPackageLocalRuntimeMcpOperations({
      mcpRegistry: this.mcpRegistry,
      configuredServers: this.options.mcpServers,
      logger: this.logger,
      toolCatalog: this.toolCatalog,
      filterTools: (tools) => this.filterTools(tools),
      refreshMcpTools: (serverNames) => this.refreshMcpTools(serverNames),
    });
    const executionOperations = createPackageLocalRuntimeExecutionOperations({
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
    this.executionPipelineOperations = executionOperations.pipeline;
    this.agentRuntimeDepsOperations = executionOperations.agentDeps;
    const kernelOperations = createPackageLocalRuntimeKernelOperations({
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
    this.kernelPortOperations = kernelOperations.ports;
    this.agentKernelOperations = kernelOperations.agentKernel;
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
    const sessionCapabilityOperations = createPackageLocalRuntimeSessionCapabilityOperations({
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
    this.subagentOperations = sessionCapabilityOperations.subagents;
    this.forkOperations = sessionCapabilityOperations.fork;
    const turnOperations = createPackageLocalRuntimeTurnOperations({
      sessionId: this.sessionId,
      observability: options.options.observability,
      model: options.options.model,
      providerType: options.options.provider.type,
      permissionMode: options.options.permissionMode,
      logger: this.logger,
      bladeConfig: this.bladeConfig,
      hookRuntime: this.hookRuntime,
      kernelModelResolver: this.kernelModelResolver,
      createAgentKernel: this.agentKernelOperations.createFromResolved,
    });
    this.traceManager = turnOperations.traceManager;
    this.kernelTurnStreamOperations = turnOperations.kernelTurnStream;
    this.traceOperations = turnOperations.traceOperations;
    const capabilityOperations = createPackageLocalRuntimeCapabilityOperations({
      registerConfiguredMcpServers: () => this.registerConfiguredMcpServers(),
      registerCustomTools: () => this.registerCustomTools(),
      registerBuiltinTools: () => this.registerBuiltinTools(),
      initializeSubagents: () => this.initializeSubagents(),
      initializeHooks: () => this.initializeHooks(),
    });
    this.capabilityInitializationOperations = capabilityOperations.initialization;
    this.controlOperations = createPackageLocalRuntimeControlOperations({
      options: this.options,
      bladeConfig: this.bladeConfig,
      setDefaultContext: (context) => {
        this.defaultContext = context;
      },
      setProjectPath: (projectPath) => {
        this.projectPath = projectPath;
      },
      resetExecutionPipeline: () => this.executionPipelineOperations.reset(),
      markSubagentLocationsDirty: () =>
        this.capabilityInitializationOperations.markSubagentLocationsDirty(),
    });
  }

  getConfiguredMcpServers(): Record<string, McpServerConfig | SdkMcpServerHandle> {
    return this.mcpOperations.servers.config.getConfigured();
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

  async runSessionStart(isResume: boolean): Promise<void> {
    await this.sessionLifecycleOperations.runSessionStart(isResume);
  }

  prepareTurn(snapshot: ContextSnapshot): void {
    this.workspaceOperations.prepareTurn(snapshot);
  }

  async close(): Promise<void> {
    await this.sessionLifecycleOperations.close();
  }

  async mcpCapabilities(): Promise<PackageLocalRuntimeMcpServerCapability[]> {
    return this.mcpOperations.capabilities.getCapabilities();
  }

  async mcpServerStatus(): Promise<McpServerStatus[]> {
    return this.mcpOperations.capabilities.getServerStatus();
  }

  async mcpListTools(): Promise<McpToolInfo[]> {
    return this.mcpOperations.capabilities.listTools();
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
    return this.forkOperations.fork(options);
  }

  getLastTrace(): AgentTrace | undefined {
    return this.traceOperations.getLastTrace();
  }

  getTraces(): AgentTrace[] {
    return this.traceOperations.getTraces();
  }

  async mcpConnect(serverName: string): Promise<void> {
    await this.mcpOperations.servers.lifecycle.connect(serverName);
  }

  async mcpDisconnect(serverName: string): Promise<void> {
    await this.mcpOperations.servers.lifecycle.disconnect(serverName);
  }

  async mcpReconnect(serverName: string): Promise<void> {
    await this.mcpOperations.servers.lifecycle.reconnect(serverName);
  }

  async registerConfiguredMcpServers(): Promise<void> {
    await this.mcpOperations.servers.registration.registerConfigured();
  }

  async ensureRuntimeCapabilitiesInitialized(): Promise<void> {
    await this.capabilityInitializationOperations.ensureInitialized();
  }

  async refreshMcpTools(serverNames: string[]): Promise<void> {
    await this.mcpOperations.tools.refresh(serverNames);
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
