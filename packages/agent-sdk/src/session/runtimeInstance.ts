import type { ModelMessage, ModelPort } from '@blade-ai/ai';
import type {
  AgentKernelOptions,
  AgentModelRequestDefaults,
  AgentStoreAppendContext,
  AgentHookPort,
  AgentStorePort,
  AgentStreamEvent,
  AgentToolCall,
  AgentToolPort,
  AgentTracePort,
} from '@blade-ai/agent';
import type { ContextSnapshot, RuntimeContext } from '../runtime/types.js';
import type { SubagentConfig } from '../subagents/types.js';
import { HookEvent } from '../types/constants.js';
import {
  PermissionMode,
  type BladeConfig,
  type McpServerConfig,
} from '../types/common.js';
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
  projectPackageLocalKernelEventToStreamMessages,
} from './kernelStreamProjection.js';
import {
  initializePackageLocalRuntimeHooks,
  type PackageLocalRuntimeHookManagerPort,
  type PackageLocalRuntimeHookRuntimePort,
} from './runtimeHooks.js';
import {
  createPackageLocalRuntimeExecutionPipeline,
  type PackageLocalRuntimeExecutionPipelineFactoryPort,
} from './runtimeExecutionPipeline.js';
import {
  resolvePackageLocalRuntimeKernelModel,
  type PackageLocalRuntimeKernelModelResolverPort,
  type PackageLocalRuntimeResolvedKernelModel,
} from './runtimeKernelModels.js';
import {
  getPackageLocalRuntimeContextCwd,
  resolvePackageLocalRuntimeStorageRoot,
} from './runtimeContext.js';
import {
  callPackageLocalMcpRegistryAction,
  isPackageLocalSdkMcpServerHandle,
  registerPackageLocalInProcessMcpServer,
  registerPackageLocalRemoteMcpServer,
} from './runtimeMcpServers.js';
import { getPackageLocalMcpToolSourceId } from './runtimeMcpTools.js';
import { createPackageLocalRuntimeNoopPorts } from './runtimeNoopPorts.js';
import { packageLocalSubagentConfigFromDefinition } from './runtimeSubagents.js';
import { filterPackageLocalRuntimeTools } from './runtimeToolFilters.js';
import {
  createPackageLocalRuntimePermissionHandler,
  type PackageLocalRuntimePermissionHookPort,
} from './runtimePermissions.js';
import { createSessionTraceFinalizer, SessionTraceManager } from './traces.js';
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
  PackageLocalRuntimeHookManagerPort,
  PackageLocalRuntimeHookRuntimePort,
} from './runtimeHooks.js';
export type {
  PackageLocalRuntimeExecutionPipelineCreateOptions,
  PackageLocalRuntimeExecutionPipelineFactoryPort,
} from './runtimeExecutionPipeline.js';

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

export interface PackageLocalRuntimeBackgroundAgentManagerPort {
  [operation: string]: unknown;
}

export interface PackageLocalRuntimeKernelToolPortCreateOptions {
  toolCatalog: PackageLocalRuntimeToolCatalogPort;
  executionPipeline: unknown;
  createExecutionContext: (
    toolCall: AgentToolCall,
    signal?: AbortSignal,
  ) => ExecutionContext;
}

export interface PackageLocalRuntimeKernelStorePortCreateOptions {
  sessionId: SessionId;
  sessionStore: PackageLocalRuntimeSessionStorePort;
}

export interface PackageLocalRuntimeKernelTracePortCreateOptions {
  recorder: TraceRecorder;
  maxContextTokens?: number;
}

export interface PackageLocalRuntimeKernelHookPortCreateOptions {
  hookRuntime: PackageLocalRuntimeHookRuntimePort;
}

export interface PackageLocalRuntimeKernelPortFactoryPort {
  createToolPort(options: PackageLocalRuntimeKernelToolPortCreateOptions): AgentToolPort;
  createStorePort(options: PackageLocalRuntimeKernelStorePortCreateOptions): AgentStorePort;
  createTracePort(options: PackageLocalRuntimeKernelTracePortCreateOptions): AgentTracePort;
  createHookPort(options: PackageLocalRuntimeKernelHookPortCreateOptions): AgentHookPort;
}

export interface PackageLocalRuntimeAgentKernelOptions {
  model?: ModelPort;
  modelId?: string;
  modelRequestDefaults?: AgentModelRequestDefaults;
  traceRecorder?: TraceRecorder;
  createExecutionContext?: (
    toolCall: AgentToolCall,
    signal?: AbortSignal,
  ) => ExecutionContext;
  maxSteps?: number;
}

export interface PackageLocalRuntimeAgentKernelStreamOptions
  extends PackageLocalRuntimeAgentKernelOptions {
  input: string;
  turnId?: string;
  signal?: AbortSignal;
  includeThinking?: boolean;
}

export interface PackageLocalRuntimeAgentKernelTurn {
  input: string;
  turnId?: string;
  signal?: AbortSignal;
}

export interface PackageLocalRuntimeAgentKernelPort {
  runTurn(turn: PackageLocalRuntimeAgentKernelTurn): AsyncIterable<AgentStreamEvent>;
}

export interface PackageLocalRuntimeAgentKernelFactoryPort {
  create(options: AgentKernelOptions): PackageLocalRuntimeAgentKernelPort;
}

export interface PackageLocalAgentRuntimeDeps {
  executionPipeline: unknown;
  defaultContext: RuntimeContext;
  mcpRegistry: PackageLocalRuntimeMcpRegistryPort;
  subagentRegistry: PackageLocalRuntimeSubagentRegistryPort;
  backgroundAgentManager: PackageLocalRuntimeBackgroundAgentManagerPort;
  hookRuntime: PackageLocalRuntimeHookRuntimePort;
  runtimeManaged: true;
  logger: PackageLocalRuntimeLoggerPort;
}

export interface PackageLocalRuntimeMcpToolCapability {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface PackageLocalRuntimeMcpServerCapability {
  name: string;
  status: 'connected' | 'disconnected' | 'connecting' | 'error';
  connectedAt?: Date;
  error?: string;
  auth: {
    enabled: boolean;
    provider?: string;
  };
  health: {
    enabled: boolean;
    status: 'healthy' | 'degraded' | 'unhealthy' | 'checking' | 'disabled' | 'unknown';
  };
  tools: PackageLocalRuntimeMcpToolCapability[];
}

export interface PackageLocalRuntimeNamedTool {
  name: string;
}

export interface PackageLocalRuntimeMcpTool extends PackageLocalRuntimeNamedTool {
  tags?: readonly string[];
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
  private readonly createForkSessionId?: () => SessionId;
  private readonly createForkSession?: (
    sessionId: SessionId,
    options: SessionOptions,
  ) => Promise<ISession> | ISession;
  private readonly traceManager: SessionTraceManager;
  private executionPipelineCreated = false;
  private executionPipeline: unknown;

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
    this.createForkSessionId = options.createForkSessionId;
    this.createForkSession = options.createForkSession;
    this.traceManager = new SessionTraceManager({
      sessionId: this.sessionId,
      observability: options.options.observability,
      metadata: {
        model: options.options.model,
        provider: options.options.provider.type,
        permissionMode: options.options.permissionMode ?? PermissionMode.DEFAULT,
      },
      onSinkError: (error) =>
        this.logger.warn('[PackageLocalSessionRuntime] Observability trace sink failed:', error),
    });
  }

  getConfiguredMcpServers(): Record<string, McpServerConfig | SdkMcpServerHandle> {
    return this.options.mcpServers ?? {};
  }

  async ensureSessionCreated(): Promise<void> {
    await this.sessionStore.createSession(this.sessionId);
  }

  async ensureSessionLoaded(): Promise<void> {
    const loaded = await this.sessionStore.loadSession(this.sessionId);
    if (!loaded) {
      await this.sessionStore.createSession(this.sessionId);
    }
  }

  async loadMessages(): Promise<SessionMessage[]> {
    return this.sessionStore.loadMessages(this.sessionId);
  }

  prepareTurn(snapshot: ContextSnapshot): void {
    this.workspace.updateWorkspace({
      projectPath: snapshot.cwd,
      environment: {
        ...snapshot.environment,
        ...(snapshot.cwd ? { cwd: snapshot.cwd } : {}),
      },
    });
  }

  async close(): Promise<void> {
    await this.mcpRegistry.disconnectAll();
  }

  async mcpCapabilities(): Promise<PackageLocalRuntimeMcpServerCapability[]> {
    return this.mcpRegistry.getCapabilities();
  }

  async mcpServerStatus(): Promise<McpServerStatus[]> {
    return (await this.mcpCapabilities()).map((capability) => ({
      name: capability.name,
      status: capability.status,
      toolCount: capability.tools.length,
      tools: capability.tools.map((tool) => tool.name),
      connectedAt: capability.connectedAt,
      error: capability.error,
    }));
  }

  async mcpListTools(): Promise<McpToolInfo[]> {
    return (await this.mcpCapabilities()).flatMap((capability) =>
      capability.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        serverName: capability.name,
      })),
    );
  }

  async fork(options?: ForkSessionOptions): Promise<ISession> {
    if (!this.createForkSessionId || !this.createForkSession) {
      throw new Error('Fork runtime is not configured for this session.');
    }

    const snapshot = await this.sessionStore.forkState(this.sessionId, options);
    if (!snapshot) {
      throw new Error(`Session "${this.sessionId}" was not found for fork.`);
    }

    const forkedSessionId = this.createForkSessionId();
    const writtenSnapshot = await this.sessionStore.writeForkState(forkedSessionId, snapshot);
    if (!writtenSnapshot) {
      throw new Error(`Session "${this.sessionId}" could not be materialized for fork.`);
    }

    return this.createForkSession(forkedSessionId, this.options);
  }

  getLastTrace(): AgentTrace | undefined {
    return this.traceManager.getLastTrace();
  }

  getTraces(): AgentTrace[] {
    return this.traceManager.getTraces();
  }

  async mcpConnect(serverName: string): Promise<void> {
    await this.ensureMcpServerRegistered(serverName);
    await callPackageLocalMcpRegistryAction(this.mcpRegistry, 'connectServer', serverName);
    await this.refreshMcpTools([serverName]);
  }

  async mcpDisconnect(serverName: string): Promise<void> {
    await callPackageLocalMcpRegistryAction(this.mcpRegistry, 'disconnectServer', serverName);
    await this.refreshMcpTools([serverName]);
  }

  async mcpReconnect(serverName: string): Promise<void> {
    await this.ensureMcpServerRegistered(serverName);
    await callPackageLocalMcpRegistryAction(this.mcpRegistry, 'reconnectServer', serverName);
    await this.refreshMcpTools([serverName]);
  }

  async registerConfiguredMcpServers(): Promise<void> {
    const configuredServers = this.options.mcpServers;
    if (!configuredServers) {
      return;
    }

    for (const [serverName, config] of Object.entries(configuredServers)) {
      if (isPackageLocalSdkMcpServerHandle(config)) {
        await registerPackageLocalInProcessMcpServer(this.mcpRegistry, serverName, config);
        continue;
      }

      if (config.disabled) {
        continue;
      }

      try {
        await registerPackageLocalRemoteMcpServer(this.mcpRegistry, serverName, config);
      } catch (error) {
        this.logger.warn(
          `[PackageLocalSessionRuntime] Failed to register MCP server ${serverName}:`,
          error,
        );
      }
    }

    await this.refreshMcpTools(Object.keys(configuredServers));
  }

  private async ensureMcpServerRegistered(serverName: string): Promise<void> {
    const config = this.options.mcpServers?.[serverName];
    if (!config) {
      throw new Error(`MCP server "${serverName}" not found in configuration`);
    }

    await this.mcpRegistry.ensureServerRegistered?.(serverName, config);
  }

  async refreshMcpTools(serverNames: string[]): Promise<void> {
    for (const serverName of serverNames) {
      this.toolCatalog.removeMcpTools(serverName);
    }

    const availableTools =
      (await this.mcpRegistry.getAvailableToolsByServerNames?.(serverNames)) ?? [];
    for (const tool of this.filterTools(availableTools)) {
      this.toolCatalog.registerMcpTool(tool, {
        kind: 'mcp',
        trustLevel: 'remote',
        sourceId: getPackageLocalMcpToolSourceId(tool),
      });
    }
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
    const filteredTools = this.filterTools(tools);
    if (filteredTools.length === 0) {
      return;
    }

    this.toolCatalog.registerAll(filteredTools, source);
  }

  registerCustomTools(): void {
    const definitions = this.options.tools ?? [];
    if (definitions.length === 0) {
      return;
    }

    if (!this.customToolFactory) {
      throw new Error('Package-local custom tool factory port is required to register tools');
    }

    const customToolFactory = this.customToolFactory;
    const tools = definitions.map((definition) => customToolFactory.fromDefinition(definition));
    this.registerTools(tools, {
      kind: 'custom',
      trustLevel: 'workspace',
      sourceId: 'session',
    });
  }

  async registerBuiltinTools(): Promise<void> {
    const tools = await this.builtinToolProvider?.getTools({
      sessionId: this.sessionId,
      configDir: this.storageRoot,
      mcpRegistry: this.mcpRegistry,
      includeMcpProtocolTools: false,
    });

    this.registerTools(tools ?? [], {
      kind: 'builtin',
      trustLevel: 'trusted',
      sourceId: 'builtin',
    });
  }

  initializeSubagents(): void {
    this.subagentRegistry.setLogger(this.logger);
    this.subagentRegistry.setProjectDir(this.projectPath);
    this.subagentRegistry.loadFromStandardLocations(this.projectPath, this.storageRoot);

    for (const [name, definition] of Object.entries(this.options.agents ?? {})) {
      this.subagentRegistry.register(packageLocalSubagentConfigFromDefinition(name, definition), {
        override: true,
      });
    }
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
    if (this.executionPipelineCreated) {
      return this.executionPipeline;
    }

    this.executionPipeline = createPackageLocalRuntimeExecutionPipeline({
      bladeConfig: this.bladeConfig,
      permissionMode: this.options.permissionMode,
      permissionHandler: this.createPermissionHandler(),
      logger: this.logger,
      toolCatalog: this.toolCatalog,
      executionPipelineFactory: this.executionPipelineFactory,
    });
    this.executionPipelineCreated = true;
    return this.executionPipeline;
  }

  getAgentRuntimeDeps(): PackageLocalAgentRuntimeDeps {
    return {
      executionPipeline: this.createExecutionPipeline(),
      defaultContext: this.defaultContext,
      mcpRegistry: this.mcpRegistry,
      subagentRegistry: this.subagentRegistry,
      backgroundAgentManager: this.backgroundAgentManager,
      hookRuntime: this.hookRuntime,
      runtimeManaged: true,
      logger: this.logger,
    };
  }

  getKernelToolPort(
    createExecutionContext: (
      toolCall: AgentToolCall,
      signal?: AbortSignal,
    ) => ExecutionContext,
  ): AgentToolPort {
    return this.kernelPortFactory.createToolPort({
      toolCatalog: this.toolCatalog,
      executionPipeline: this.createExecutionPipeline(),
      createExecutionContext,
    });
  }

  getKernelStorePort(): AgentStorePort {
    return this.kernelPortFactory.createStorePort({
      sessionId: this.sessionId,
      sessionStore: this.sessionStore,
    });
  }

  getKernelTracePort(recorder: TraceRecorder, maxContextTokens?: number): AgentTracePort {
    return this.kernelPortFactory.createTracePort({
      recorder,
      maxContextTokens,
    });
  }

  getKernelHookPort(): AgentHookPort {
    return this.kernelPortFactory.createHookPort({
      hookRuntime: this.hookRuntime,
    });
  }

  createAgentKernel(
    options: PackageLocalRuntimeAgentKernelOptions = {},
  ): PackageLocalRuntimeAgentKernelPort {
    const kernelModel = resolvePackageLocalRuntimeKernelModel({
      options,
      bladeConfig: this.bladeConfig,
      kernelModelResolver: this.kernelModelResolver,
    });
    return this.createAgentKernelFromResolved(options, kernelModel);
  }

  private createAgentKernelFromResolved(
    options: PackageLocalRuntimeAgentKernelOptions,
    kernelModel: PackageLocalRuntimeResolvedKernelModel,
  ): PackageLocalRuntimeAgentKernelPort {
    return this.kernelFactory.create({
      model: kernelModel.model,
      ...(kernelModel.modelRequestDefaults
        ? { modelRequestDefaults: kernelModel.modelRequestDefaults }
        : {}),
      store: this.getKernelStorePort(),
      hooks: this.getKernelHookPort(),
      ...(options.traceRecorder
        ? {
            trace: this.getKernelTracePort(
              options.traceRecorder,
              kernelModel.modelRequestDefaults?.maxContextTokens,
            ),
          }
        : {}),
      ...(options.createExecutionContext
        ? { tools: this.getKernelToolPort(options.createExecutionContext) }
        : {}),
      ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
    });
  }

  async *streamAgentKernelTurn(
    options: PackageLocalRuntimeAgentKernelStreamOptions,
  ): AsyncGenerator<StreamMessage> {
    const kernelModel = resolvePackageLocalRuntimeKernelModel({
      options,
      bladeConfig: this.bladeConfig,
      kernelModelResolver: this.kernelModelResolver,
    });
    const traceRecorder = options.traceRecorder ?? this.traceManager.createRecorder(options.input);
    const traceFinalizer = createSessionTraceFinalizer(traceRecorder, this.traceManager);
    const kernel = this.createAgentKernelFromResolved(
      {
        ...options,
        ...(traceRecorder ? { traceRecorder } : {}),
      },
      kernelModel,
    );
    const maxContextTokens = kernelModel.modelRequestDefaults?.maxContextTokens ?? 0;
    let usage: unknown;

    yield { type: 'turn_start', turn: 1, sessionId: this.sessionId };

    try {
      this.hookRuntime.setTraceCollector?.(traceRecorder);
      for await (const event of kernel.runTurn({
        input: options.input,
        turnId: options.turnId,
        signal: options.signal,
      })) {
        if (event.type === 'usage') {
          usage = event.usage;
        }
        yield* projectPackageLocalKernelEventToStreamMessages(event, {
          sessionId: this.sessionId,
          maxContextTokens,
          includeThinking: options.includeThinking ?? false,
        });
        if (event.type === 'result') {
          await traceFinalizer.finish('success', {
            content: event.content,
            usage,
          });
        } else if (event.type === 'error') {
          await traceFinalizer.finish('error', {
            error: event.message,
            code: event.code,
          });
        }
      }
    } catch (error) {
      await traceFinalizer.finish('error', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.hookRuntime.setTraceCollector?.(undefined);
    }
  }

}
