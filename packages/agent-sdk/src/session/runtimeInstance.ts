import { basename, dirname } from 'node:path';
import type { ModelPort } from '@blade-ai/ai';
import type {
  AgentKernelOptions,
  AgentModelRequestDefaults,
  AgentHookPort,
  AgentPermissionUpdate,
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
  type JsonObject,
  type McpServerConfig,
  type PermissionsConfig,
  type TokenUsage,
} from '../types/common.js';
import {
  createCompositePermissionHandler,
  createPermissionHandlerFromCanUseTool,
  type PermissionHandler,
  type PermissionUpdate,
  type PermissionResult,
} from '../types/permissions.js';
import type { TraceRecorder } from '../observability/TraceRecorder.js';
import type { ToolKind } from '../tools/types/ToolKind.js';
import type { ExecutionContext } from '../tools/types/index.js';
import type {
  McpToolInfo,
  McpServerStatus,
  SdkMcpServerHandle,
  SessionHookEvent,
  SessionId,
  SessionOptions,
  HookCallback,
  StreamMessage,
} from './types.js';

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
}

export interface PackageLocalRuntimeSessionStorePort {
  createSession(sessionId: SessionId): Promise<void>;
  loadSession(sessionId: SessionId): Promise<boolean>;
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

export interface PackageLocalRuntimePermissionHookResult {
  updatedInput: JsonObject;
  decision?: PermissionResult;
}

export interface PackageLocalRuntimePermissionHookPort {
  applyPermissionRequestHooks(
    toolName: string,
    input: JsonObject,
    options: {
      affectedPaths?: string[];
      toolKind?: ToolKind;
      abortSignal?: AbortSignal;
    },
  ): Promise<PackageLocalRuntimePermissionHookResult>;
}

export interface PackageLocalRuntimeHookManagerPort {
  enable(): void;
}

export interface PackageLocalRuntimeHookRuntimePort extends PackageLocalRuntimeHookManagerPort {
  setTraceCollector?(collector: unknown): void;
}

export interface PackageLocalRuntimeBackgroundAgentManagerPort {
  [operation: string]: unknown;
}

export interface PackageLocalRuntimeExecutionPipelineCreateOptions {
  permissionConfig: Required<PermissionsConfig>;
  permissionMode: PermissionMode;
  maxHistorySize: number;
  permissionHandler: PermissionHandler | undefined;
  logger: PackageLocalRuntimeLoggerPort;
  toolCatalog: PackageLocalRuntimeToolCatalogPort;
}

export interface PackageLocalRuntimeExecutionPipelineFactoryPort {
  create(options: PackageLocalRuntimeExecutionPipelineCreateOptions): unknown;
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

export interface PackageLocalRuntimeResolvedKernelModel {
  model: ModelPort;
  modelRequestDefaults?: AgentModelRequestDefaults;
}

export interface PackageLocalRuntimeKernelModelResolveOptions {
  bladeConfig: BladeConfig;
  modelId?: string;
}

export interface PackageLocalRuntimeKernelModelResolverPort {
  resolve(options: PackageLocalRuntimeKernelModelResolveOptions): PackageLocalRuntimeResolvedKernelModel;
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

export interface PackageLocalRuntimeKernelStreamProjectionOptions {
  maxContextTokens: number;
  includeThinking: boolean;
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

export function packageLocalSubagentConfigFromDefinition(
  name: string,
  definition: PackageLocalRuntimeAgentDefinition,
): SubagentConfig {
  return {
    name: definition.name || name,
    description: definition.description,
    systemPrompt: definition.systemPrompt,
    tools: definition.allowedTools,
    model: definition.model ?? 'inherit',
    source: 'session',
  };
}

export function resolvePackageLocalRuntimeStorageRoot(
  storagePath?: string,
): string | undefined {
  if (!storagePath) {
    return undefined;
  }

  return basename(storagePath) === 'sessions' ? dirname(storagePath) : storagePath;
}

export function isPackageLocalSdkMcpServerHandle(
  config: unknown,
): config is SdkMcpServerHandle {
  return (
    typeof config === 'object' &&
    config !== null &&
    'createClientTransport' in config &&
    'server' in config
  );
}

function getRuntimeContextCwd(context: RuntimeContext): string | undefined {
  return typeof context.capabilities?.filesystem?.cwd === 'string'
    ? context.capabilities.filesystem.cwd
    : typeof context.environment?.cwd === 'string'
      ? context.environment.cwd
      : undefined;
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
    this.projectPath = getRuntimeContextCwd(options.defaultContext);
    this.hookCallbacks = options.options.hooks ?? {};
    this.sessionStore = options.sessionStore ?? createNoopRuntimeSessionStore();
    this.workspace = options.workspace ?? createNoopRuntimeWorkspace();
    this.mcpRegistry = options.mcpRegistry ?? createNoopRuntimeMcpRegistry();
    this.toolCatalog = options.toolCatalog ?? createNoopRuntimeToolCatalog();
    this.logger = options.logger ?? createNoopRuntimeLogger();
    this.customToolFactory = options.customToolFactory;
    this.builtinToolProvider = options.builtinToolProvider;
    this.subagentRegistry = options.subagentRegistry ?? createNoopRuntimeSubagentRegistry();
    this.permissionHooks = options.permissionHooks ?? createNoopRuntimePermissionHooks();
    this.hookRuntime = options.hookRuntime ?? createNoopRuntimeHookRuntime();
    this.hookManager = options.hookManager ?? this.hookRuntime;
    this.backgroundAgentManager =
      options.backgroundAgentManager ?? createNoopRuntimeBackgroundAgentManager();
    this.executionPipelineFactory =
      options.executionPipelineFactory ?? createNoopRuntimeExecutionPipelineFactory();
    this.kernelPortFactory = options.kernelPortFactory ?? createNoopRuntimeKernelPortFactory();
    this.kernelFactory = options.kernelFactory ?? createNoopRuntimeAgentKernelFactory();
    this.kernelModelResolver =
      options.kernelModelResolver ?? createNoopRuntimeKernelModelResolver();
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

  async mcpConnect(serverName: string): Promise<void> {
    await this.ensureMcpServerRegistered(serverName);
    await this.callMcpRegistryMethod('connectServer', serverName);
    await this.refreshMcpTools([serverName]);
  }

  async mcpDisconnect(serverName: string): Promise<void> {
    await this.callMcpRegistryMethod('disconnectServer', serverName);
    await this.refreshMcpTools([serverName]);
  }

  async mcpReconnect(serverName: string): Promise<void> {
    await this.ensureMcpServerRegistered(serverName);
    await this.callMcpRegistryMethod('reconnectServer', serverName);
    await this.refreshMcpTools([serverName]);
  }

  async registerConfiguredMcpServers(): Promise<void> {
    const configuredServers = this.options.mcpServers;
    if (!configuredServers) {
      return;
    }

    for (const [serverName, config] of Object.entries(configuredServers)) {
      if (isPackageLocalSdkMcpServerHandle(config)) {
        await this.registerInProcessMcpServer(serverName, config);
        continue;
      }

      if (config.disabled) {
        continue;
      }

      try {
        await this.registerRemoteMcpServer(serverName, config);
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
        sourceId: packageLocalServerNameFromTool(tool),
      });
    }
  }

  private async callMcpRegistryMethod(
    method: 'connectServer' | 'disconnectServer' | 'reconnectServer',
    serverName: string,
  ): Promise<void> {
    const action = this.mcpRegistry[method];
    if (!action) {
      throw new Error(`Package-local MCP registry port does not implement ${method}`);
    }
    await action.call(this.mcpRegistry, serverName);
  }

  private async registerInProcessMcpServer(
    serverName: string,
    config: SdkMcpServerHandle,
  ): Promise<void> {
    const action = this.mcpRegistry.registerInProcessServer;
    if (!action) {
      throw new Error('Package-local MCP registry port does not implement registerInProcessServer');
    }
    await action.call(this.mcpRegistry, serverName, config);
  }

  private async registerRemoteMcpServer(
    serverName: string,
    config: McpServerConfig,
  ): Promise<void> {
    const action = this.mcpRegistry.registerServer;
    if (!action) {
      throw new Error('Package-local MCP registry port does not implement registerServer');
    }
    await action.call(this.mcpRegistry, serverName, config);
  }

  filterTools<TTool extends PackageLocalRuntimeNamedTool>(tools: TTool[]): TTool[] {
    const allowedTools = this.options.allowedTools;
    const disallowedTools = new Set(this.options.disallowedTools ?? []);

    return tools.filter((tool) => {
      if (allowedTools !== undefined && !allowedTools.includes(tool.name)) {
        return false;
      }
      return !disallowedTools.has(tool.name);
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
    const hasPermissionCallbacks =
      (this.hookCallbacks[HookEvent.PermissionRequest]?.length ?? 0) > 0;
    const basePermissionHandler =
      this.options.permissionHandler ??
      (this.options.canUseTool
        ? createPermissionHandlerFromCanUseTool(this.options.canUseTool)
        : undefined);

    if (!hasPermissionCallbacks && !basePermissionHandler) {
      return undefined;
    }

    const hookPermissionHandler = hasPermissionCallbacks
      ? (async (request) => {
          const hookResult = await this.permissionHooks.applyPermissionRequestHooks(
            request.toolName,
            request.input,
            {
              affectedPaths: request.affectedPaths,
              toolKind: request.toolKind,
              abortSignal: request.signal,
            },
          );
          Object.assign(request.input, hookResult.updatedInput);
          if (hookResult.decision) {
            return hookResult.decision;
          }

          return {
            behavior: 'allow',
            updatedInput: hookResult.updatedInput,
          } satisfies PermissionResult;
        }) satisfies PermissionHandler
      : undefined;

    return createCompositePermissionHandler([
      hookPermissionHandler,
      basePermissionHandler,
      async () => ({ behavior: 'ask' }) satisfies PermissionResult,
    ]);
  }

  initializeHooks(): void {
    if (this.options.hooks && Object.keys(this.options.hooks).length > 0) {
      this.hookManager.enable();
    }
  }

  createExecutionPipeline(): unknown {
    if (this.executionPipelineCreated) {
      return this.executionPipeline;
    }

    const permissionConfig: Required<PermissionsConfig> = {
      allow: [],
      ask: [],
      deny: [],
      ...this.bladeConfig.permissions,
    };

    this.executionPipeline = this.executionPipelineFactory.create({
      permissionConfig,
      permissionMode: this.options.permissionMode ?? PermissionMode.DEFAULT,
      maxHistorySize: 1000,
      permissionHandler: this.createPermissionHandler(),
      logger: this.logger,
      toolCatalog: this.toolCatalog,
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
    const kernelModel = this.resolveAgentKernelModel(options);
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
    const kernelModel = this.resolveAgentKernelModel(options);
    const kernel = this.createAgentKernelFromResolved(options, kernelModel);
    const maxContextTokens = kernelModel.modelRequestDefaults?.maxContextTokens ?? 0;

    yield { type: 'turn_start', turn: 1, sessionId: this.sessionId };

    for await (const event of kernel.runTurn({
      input: options.input,
      turnId: options.turnId,
      signal: options.signal,
    })) {
      yield* this.projectKernelEventToStreamMessages(event, {
        maxContextTokens,
        includeThinking: options.includeThinking ?? false,
      });
    }
  }

  projectKernelEventToStreamMessages(
    event: AgentStreamEvent,
    options: PackageLocalRuntimeKernelStreamProjectionOptions,
  ): StreamMessage[] {
    switch (event.type) {
      case 'content':
        return [{ type: 'content', delta: event.delta, sessionId: this.sessionId }];
      case 'thinking':
        return options.includeThinking
          ? [{ type: 'thinking', delta: event.delta, sessionId: this.sessionId }]
          : [];
      case 'tool_use':
        return [
          {
            type: 'tool_use',
            id: event.toolCall.id,
            name: event.toolCall.name,
            input: event.toolCall.input,
            sessionId: this.sessionId,
          },
        ];
      case 'tool_result':
        return [
          {
            type: 'tool_result',
            id: event.result.id,
            name: event.result.name,
            output: event.result.output,
            ...(event.result.isError ? { isError: true } : {}),
            sessionId: this.sessionId,
          },
        ];
      case 'tool_permission_updates':
        return [
          {
            type: 'tool_permission_updates',
            id: event.toolCall.id,
            name: event.toolCall.name,
            updates: toPackageLocalSessionPermissionUpdates(event.updates),
            sessionId: this.sessionId,
          },
        ];
      case 'usage':
        return [
          {
            type: 'usage',
            usage: toPackageLocalSessionUsage(event.usage, options.maxContextTokens),
            sessionId: this.sessionId,
          },
        ];
      case 'result':
        return [
          { type: 'turn_end', turn: 1, sessionId: this.sessionId },
          {
            type: 'result',
            subtype: 'success',
            content: event.content,
            sessionId: this.sessionId,
          },
        ];
      case 'error':
        return [
          {
            type: 'error',
            message: event.message,
            ...(event.code ? { code: event.code } : {}),
            sessionId: this.sessionId,
          },
        ];
      default:
        return [];
    }
  }

  private resolveAgentKernelModel(
    options: PackageLocalRuntimeAgentKernelOptions,
  ): PackageLocalRuntimeResolvedKernelModel {
    if (options.model) {
      return {
        model: options.model,
        ...(options.modelRequestDefaults
          ? { modelRequestDefaults: options.modelRequestDefaults }
          : {}),
      };
    }

    return this.kernelModelResolver.resolve({
      bladeConfig: this.bladeConfig,
      modelId: options.modelId,
    });
  }
}

function createNoopRuntimeSessionStore(): PackageLocalRuntimeSessionStorePort {
  return {
    async createSession() {},
    async loadSession() {
      return false;
    },
  };
}

function createNoopRuntimeWorkspace(): PackageLocalRuntimeWorkspacePort {
  return {
    updateWorkspace() {},
  };
}

function createNoopRuntimeMcpRegistry(): PackageLocalRuntimeMcpRegistryPort {
  return {
    async disconnectAll() {},
    async getCapabilities() {
      return [];
    },
    async registerInProcessServer() {},
    async registerServer() {},
    async ensureServerRegistered() {},
    async connectServer() {},
    async disconnectServer() {},
    async reconnectServer() {},
    async getAvailableToolsByServerNames() {
      return [];
    },
  };
}

function createNoopRuntimeToolCatalog(): PackageLocalRuntimeToolCatalogPort {
  return {
    registerAll() {},
    registerMcpTool() {},
    removeMcpTools() {
      return 0;
    },
  };
}

function createNoopRuntimeLogger(): PackageLocalRuntimeLoggerPort {
  return {
    warn() {},
  };
}

function createNoopRuntimeSubagentRegistry(): PackageLocalRuntimeSubagentRegistryPort {
  return {
    setLogger() {},
    setProjectDir() {},
    loadFromStandardLocations() {
      return 0;
    },
    register() {},
  };
}

function createNoopRuntimePermissionHooks(): PackageLocalRuntimePermissionHookPort {
  return {
    async applyPermissionRequestHooks(_toolName, input) {
      return { updatedInput: input };
    },
  };
}

function createNoopRuntimeHookRuntime(): PackageLocalRuntimeHookRuntimePort {
  return {
    enable() {},
    setTraceCollector() {},
  };
}

function createNoopRuntimeBackgroundAgentManager(): PackageLocalRuntimeBackgroundAgentManagerPort {
  return {};
}

function createNoopRuntimeExecutionPipelineFactory(): PackageLocalRuntimeExecutionPipelineFactoryPort {
  return {
    create() {
      return undefined;
    },
  };
}

function createNoopRuntimeKernelPortFactory(): PackageLocalRuntimeKernelPortFactoryPort {
  return {
    createToolPort() {
      return {
        async list() {
          return [];
        },
        async execute(toolCall) {
          return {
            id: toolCall.id,
            name: toolCall.name,
            output: '',
            isError: true,
          };
        },
      };
    },
    createStorePort() {
      return {
        appendMessage() {},
      };
    },
    createTracePort() {
      return {
        record() {},
      };
    },
    createHookPort() {
      return {};
    },
  };
}

function createNoopRuntimeAgentKernelFactory(): PackageLocalRuntimeAgentKernelFactoryPort {
  return {
    create() {
      return {
        runTurn() {
          throw new Error('Package-local agent kernel factory port is required to run a turn');
        },
      };
    },
  };
}

function createNoopRuntimeKernelModelResolver(): PackageLocalRuntimeKernelModelResolverPort {
  return {
    resolve() {
      throw new Error('Package-local kernel model resolver port is required to create a kernel');
    },
  };
}

function packageLocalServerNameFromTool(tool: PackageLocalRuntimeMcpTool): string {
  const taggedServer = tool.tags?.find((tag) => tag === tag.toLowerCase() && tag.length > 0);
  if (taggedServer) {
    return taggedServer;
  }

  const match = tool.name.match(/^mcp__([^_]+)__/);
  return match?.[1] ?? 'mcp';
}

function toPackageLocalSessionUsage(
  usage: Extract<AgentStreamEvent, { type: 'usage' }>['usage'],
  maxContextTokens: number,
): TokenUsage {
  return {
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    maxContextTokens,
    ...(usage.cacheReadInputTokens !== undefined
      ? { cacheReadInputTokens: usage.cacheReadInputTokens }
      : {}),
    ...(usage.cacheMissInputTokens !== undefined
      ? { cacheMissInputTokens: usage.cacheMissInputTokens }
      : {}),
    ...(usage.billableInputTokens !== undefined
      ? { billableInputTokens: usage.billableInputTokens }
      : {}),
    ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
  };
}

function toPackageLocalSessionPermissionUpdates(
  updates: readonly AgentPermissionUpdate[],
): PermissionUpdate[] {
  return updates.map((update) => {
    const rules = update.rules.map((rule) => ({
      toolName: rule.toolName,
      ...(rule.ruleContent !== undefined ? { ruleContent: rule.ruleContent } : {}),
    }));

    return update.type === 'addRules'
      ? {
          type: 'addRules' as const,
          behavior: update.behavior,
          rules,
        }
      : {
          type: 'removeRules' as const,
          rules,
        };
  });
}
