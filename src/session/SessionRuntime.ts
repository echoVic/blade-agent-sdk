import { basename, dirname } from 'node:path';
import type { AgentRuntimeDeps } from '../agent/Agent.js';
import { AgentSessionStore } from '../agent/subagents/AgentSessionStore.js';
import { BackgroundAgentManager } from '../agent/subagents/BackgroundAgentManager.js';
import { SubagentRegistry } from '../agent/subagents/SubagentRegistry.js';
import { ContextManager } from '../context/ContextManager.js';
import { HookManager } from '../hooks/HookManager.js';
import { HookRuntime } from '../hooks/HookRuntime.js';
import type { InternalLogger } from '../logging/Logger.js';
import { LogCategory } from '../logging/Logger.js';
import { PluginHost } from '../middleware/PluginHost.js';
import { projectMcpCapabilities, type McpServerCapability } from '../mcp/McpCapabilityProjector.js';
import { McpRegistry } from '../mcp/McpRegistry.js';
import type { SdkMcpServerHandle } from '../mcp/SdkMcpServer.js';
import type { ContextSnapshot, RuntimeContext } from '../runtime/index.js';
import {
  getContextCwd,
} from '../runtime/index.js';
import { getSandboxExecutor } from '../sandbox/SandboxExecutor.js';
import { getSandboxService } from '../sandbox/SandboxService.js';
import type { DurableExecutionFence } from './events/DurableExecutionLeaseStore.js';
import { NODE_SESSION_HOST, type SessionHostProfile } from './SessionHostProfile.js';
import type {
  SessionEventStore,
  SessionRepository,
} from './SessionRepository.js';
import { getBuiltinTools } from '../tools/builtin/index.js';
import { BackgroundShellManager } from '../tools/builtin/shell/BackgroundShellManager.js';
import { ToolCatalog } from '../tools/catalog/ToolCatalog.js';
import { toolFromDefinition } from '../tools/core/createTool.js';
import { ExecutionPipeline } from '../tools/execution/ExecutionPipeline.js';
import { ToolRegistry } from '../tools/registry/ToolRegistry.js';
import type { Tool } from '../tools/types/index.js';
import type { BladeConfig, McpServerConfig, PermissionsConfig } from '../types/common.js';
import type { PermissionMode } from '../types/common.js';
import { HookEvent } from '../types/constants.js';
import type { AgentId, SessionId } from '../types/branded.js';
import {
  createCompositePermissionHandler,
  createPermissionHandlerFromCanUseTool,
  type PermissionHandler,
  type PermissionResult,
} from '../types/permissions.js';
import type {
  AgentDefinition,
  HookCallback,
  McpServerStatus,
  McpToolInfo,
  SessionOptions,
  SessionTool,
} from './types.js';

function isSdkMcpServerHandle(
  config: McpServerConfig | SdkMcpServerHandle
): config is SdkMcpServerHandle {
  return 'createClientTransport' in config && 'server' in config;
}

function isRuntimeTool(tool: SessionTool): tool is Exclude<
  SessionTool,
  { parameters: unknown }
> {
  const candidate = tool as {
    build?: unknown;
    execute?: unknown;
    getFunctionDeclaration?: unknown;
  };
  return typeof candidate.build === 'function'
    && typeof candidate.execute === 'function'
    && typeof candidate.getFunctionDeclaration === 'function';
}

function toRuntimeTool(tool: SessionTool): Tool {
  // Registry dispatch validates parameters before invoking the concrete Tool.
  // Erase its invariant parameter type only at this heterogeneous boundary.
  return (
    isRuntimeTool(tool)
      ? tool
      : toolFromDefinition(tool)
  ) as unknown as Tool;
}

function resolveStorageRoot(storagePath?: string): string | undefined {
  if (!storagePath) {
    return undefined;
  }

  return basename(storagePath) === 'sessions'
    ? dirname(storagePath)
    : storagePath;
}

function toSubagentConfig(name: string, definition: AgentDefinition) {
  return {
    name: definition.name || name,
    description: definition.description,
    systemPrompt: definition.systemPrompt,
    tools: definition.allowedTools,
    model: definition.model ?? 'inherit',
    source: 'session' as const,
  };
}

export class SessionRuntime {
  private readonly storageRoot?: string;
  private readonly mcpRegistry: McpRegistry;
  private readonly subagentRegistry: SubagentRegistry;
  private readonly toolRegistry = new ToolRegistry();
  private readonly toolCatalog = new ToolCatalog(this.toolRegistry);
  private readonly contextManager: ContextManager;
  private readonly executionPipeline: ExecutionPipeline;
  private readonly backgroundAgentManager: BackgroundAgentManager;
  private readonly hookCallbacks: Partial<Record<HookEvent, HookCallback[]>>;
  private readonly hookRuntime: HookRuntime;
  private readonly pluginHost: PluginHost;
  private readonly rootLogger: InternalLogger;
  private readonly logger: InternalLogger;
  private initialized = false;

  constructor(
    private readonly sessionId: SessionId,
    private readonly options: SessionOptions,
    private readonly bladeConfig: BladeConfig,
    private readonly permissionMode: PermissionMode,
    private readonly defaultContext: RuntimeContext,
    logger: InternalLogger,
    private readonly hostProfile: SessionHostProfile = NODE_SESSION_HOST,
    sessionRepository?: SessionRepository,
    sessionEventStore?: SessionEventStore,
  ) {
    this.rootLogger = logger;
    this.logger = logger.child(LogCategory.AGENT);
    this.storageRoot = bladeConfig.storageRoot ?? resolveStorageRoot(options.storagePath);
    this.mcpRegistry = new McpRegistry(this.storageRoot);
    this.subagentRegistry = new SubagentRegistry(this.rootLogger, getContextCwd(defaultContext));
    this.pluginHost = new PluginHost({
      middleware: options.middleware,
      plugins: options.plugins,
    });
    const sessionStore = AgentSessionStore.create(this.storageRoot, this.rootLogger);
    this.backgroundAgentManager = BackgroundAgentManager.create(
      this.rootLogger,
      sessionStore,
      this.sessionId,
      {
        model: this.pluginHost.getModelMiddleware(),
        tool: this.pluginHost.getToolMiddleware(),
      },
      options.providerRegistry,
    );
    this.contextManager = new ContextManager(
      {
        storage: {
          maxMemorySize: 1000,
          persistentPath: options.storagePath,
          persistenceEnabled:
            options.persistSession !== false
            && sessionRepository !== undefined
            && sessionEventStore !== undefined,
          cacheSize: 100,
          compressionEnabled: true,
        },
        projectPath: getContextCwd(defaultContext),
      },
      sessionRepository,
      sessionEventStore,
    );
    this.hookCallbacks = this.pluginHost.mergeHooks(options.hooks);
    this.hookRuntime = new HookRuntime({
      sessionId,
      permissionMode,
      callbacks: this.hookCallbacks,
      hookTimeoutMs: options.hookTimeoutMs,
      sessionEndHookTimeoutMs: options.sessionEndHookTimeoutMs,
      resolveProjectDir: () => getContextCwd(this.defaultContext),
    });
    this.executionPipeline = this.createExecutionPipeline();
  }

  getAgentRuntimeDeps(): AgentRuntimeDeps {
    return {
      executionPipeline: this.executionPipeline,
      contextManager: this.contextManager,
      defaultContext: this.defaultContext,
      mcpRegistry: this.mcpRegistry,
      subagentRegistry: this.subagentRegistry,
      backgroundAgentManager: this.backgroundAgentManager,
      hookRuntime: this.hookRuntime,
      providerRegistry: this.options.providerRegistry,
      modelMiddleware: this.pluginHost.getModelMiddleware(),
      toolMiddleware: this.pluginHost.getToolMiddleware(),
      runtimeManaged: true,
      logger: this.rootLogger,
    };
  }

  getBladeConfig(): BladeConfig {
    return this.bladeConfig;
  }

  getHookCallbacks(): Partial<Record<HookEvent, HookCallback[]>> {
    return this.hookCallbacks;
  }

  getHookRuntime(): HookRuntime {
    return this.hookRuntime;
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  getToolCatalog(): ToolCatalog {
    return this.toolCatalog;
  }

  getBackgroundAgentManager(): BackgroundAgentManager {
    return this.backgroundAgentManager;
  }

  sealBackgroundWorkForHandoff(executionFence?: DurableExecutionFence): {
    activeSubagentIds: readonly AgentId[];
    activeShellIds: readonly string[];
  } {
    const activeSubagentIds = this.backgroundAgentManager.getActiveAgentIds();
    const shellManager =
      this.hostProfile === NODE_SESSION_HOST
        ? BackgroundShellManager.getInstance()
        : undefined;
    const activeShellIds =
      shellManager?.getActiveProcessIds(this.sessionId, executionFence) ?? [];
    if (activeSubagentIds.length === 0 && activeShellIds.length === 0) {
      this.backgroundAgentManager.sealForHandoff();
      if (shellManager && executionFence) {
        shellManager.sealExecutionFence(this.sessionId, executionFence);
      } else if (shellManager) {
        shellManager.sealSessionForHandoff(this.sessionId);
      }
    }
    return { activeSubagentIds, activeShellIds };
  }

  stopBackgroundWorkAfterLeaseLoss(executionFence: DurableExecutionFence): void {
    this.backgroundAgentManager.sealAndCancelAll();
    if (this.hostProfile === NODE_SESSION_HOST) {
      BackgroundShellManager.getInstance().killExecutionFence(
        this.sessionId,
        executionFence,
      );
    }
  }

  getContextManager(): ContextManager {
    return this.contextManager;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (this.hostProfile === NODE_SESSION_HOST) {
      BackgroundShellManager.getInstance().openSession(this.sessionId);
      if (this.options.sandbox) {
        getSandboxExecutor(this.rootLogger);
        getSandboxService().configure(this.options.sandbox);
      }
    }

    this.initializeSubagents();
    await this.contextManager.initialize();
    this.initializeHooks();
    if (this.hostProfile === NODE_SESSION_HOST) {
      await this.registerBuiltinTools();
    }
    this.registerCustomTools();
    this.registerPluginTools();
    await this.registerConfiguredMcpServers();

    this.initialized = true;
  }

  async ensureSessionCreated(): Promise<void> {
    await this.contextManager.createSession(undefined, {}, { sessionId: this.sessionId });
  }

  async ensureSessionLoaded(): Promise<void> {
    const loaded = await this.contextManager.loadSession(this.sessionId);
    if (!loaded) {
      await this.contextManager.createSession(undefined, {}, { sessionId: this.sessionId });
    }
  }

  prepareTurn(snapshot: ContextSnapshot): void {
    this.contextManager.updateWorkspace({
      projectPath: snapshot.cwd,
      environment: {
        ...snapshot.environment,
        ...(snapshot.cwd ? { cwd: snapshot.cwd } : {}),
      },
    });
  }

  assertNoPendingCleanup(
    options: { includeTerminalFailures?: boolean } = {},
  ): void {
    const errors = options.includeTerminalFailures === false
      ? []
      : this.getTerminalCleanupFailures();
    if (this.executionPipeline.hasPendingExecutionCleanup()) {
      errors.push(
        new Error(
          `Session runtime ${this.sessionId} still has a tool execution cleaning up`,
        ),
      );
    }
    if (this.executionPipeline.hasPendingPermissionCleanup()) {
      errors.push(
        new Error(
          `Session runtime ${this.sessionId} still has a permission callback cleaning up`,
        ),
      );
    }
    if (this.hookRuntime.hasPendingCallbackCleanup()) {
      errors.push(
        new Error(
          `Session runtime ${this.sessionId} still has an inline hook callback cleaning up`,
        ),
      );
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, `Session runtime ${this.sessionId} cleanup is pending`);
    }
  }

  private getTerminalCleanupFailures(): Error[] {
    const terminalCleanupFailure =
      this.executionPipeline.getTerminalCleanupFailure();
    const hookContainmentFailure =
      this.hookRuntime.getTerminalContainmentFailure();
    return Array.from(new Set([
      terminalCleanupFailure,
      hookContainmentFailure,
    ]))
      .filter((error) => error !== undefined)
      .map((error) =>
        error instanceof Error ? error : new Error(String(error)));
  }

  async close(executionFence?: DurableExecutionFence): Promise<void> {
    this.assertNoPendingCleanup({ includeTerminalFailures: false });
    const errors: unknown[] = this.getTerminalCleanupFailures();
    const shutdownOperations: Promise<unknown>[] = [
      this.backgroundAgentManager.sealCancelAndWait(),
    ];
    if (this.hostProfile === NODE_SESSION_HOST) {
      const shellManager = BackgroundShellManager.getInstance();
      shutdownOperations.push(
        executionFence
          ? shellManager.terminateExecutionFence(this.sessionId, executionFence)
          : shellManager.terminateSession(this.sessionId),
      );
    }
    const shutdownResults = await Promise.allSettled(shutdownOperations);
    errors.push(...shutdownResults.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    ));
    try {
      await this.mcpRegistry.disconnectAll();
    } catch (error) {
      errors.push(error);
    }
    try {
      this.assertNoPendingCleanup({ includeTerminalFailures: false });
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, `Session runtime ${this.sessionId} close failed`);
    }
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

  async mcpConnect(serverName: string): Promise<void> {
    await this.ensureServerRegistered(serverName);
    await this.mcpRegistry.connectServer(serverName);
    await this.refreshMcpTools([serverName]);
  }

  async mcpDisconnect(serverName: string): Promise<void> {
    await this.mcpRegistry.disconnectServer(serverName);
    await this.refreshMcpTools([serverName]);
  }

  async mcpReconnect(serverName: string): Promise<void> {
    await this.ensureServerRegistered(serverName);
    await this.mcpRegistry.reconnectServer(serverName);
    await this.refreshMcpTools([serverName]);
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

  async mcpCapabilities(): Promise<McpServerCapability[]> {
    return projectMcpCapabilities(this.mcpRegistry);
  }

  private createExecutionPipeline(): ExecutionPipeline {
    const permissionConfig: PermissionsConfig = {
      allow: [],
      ask: [],
      deny: [],
      ...this.bladeConfig.permissions,
    };

    return new ExecutionPipeline(this.toolRegistry, {
      permissionConfig,
      permissionMode: this.permissionMode,
      maxHistorySize: 1000,
      permissionHandler: this.createPermissionHandler(),
      hookRuntime: this.hookRuntime,
      toolTimeoutMs: this.bladeConfig.toolTimeoutMs,
      middleware: this.pluginHost.getToolMiddleware(),
      logger: this.rootLogger,
      toolCatalog: this.toolCatalog,
    });
  }

  private initializeHooks(): void {
    const hookManager = HookManager.getInstance();
    if (Object.keys(this.hookCallbacks).length > 0) {
      hookManager.enable();
    }
  }

  private async registerBuiltinTools(): Promise<void> {
    const builtinTools = await getBuiltinTools({
      sessionId: this.sessionId,
      configDir: this.storageRoot,
      mcpRegistry: this.mcpRegistry,
      includeMcpProtocolTools: false,
      subagentRegistry: this.subagentRegistry,
    });
    const filteredTools = this.filterTools(builtinTools);
    if (filteredTools.length === 0) {
      return;
    }
    this.toolCatalog.registerAll(filteredTools as Tool[], {
      kind: 'builtin',
      trustLevel: 'trusted',
      sourceId: 'builtin',
    });
  }

  private initializeSubagents(): void {
    this.subagentRegistry.setLogger(this.rootLogger);
    this.subagentRegistry.setProjectDir(getContextCwd(this.defaultContext));
    if (this.hostProfile === NODE_SESSION_HOST) {
      this.subagentRegistry.loadFromStandardLocations(
        getContextCwd(this.defaultContext),
        this.storageRoot,
      );
    }

    for (const [name, definition] of Object.entries(this.options.agents ?? {})) {
      this.subagentRegistry.register(toSubagentConfig(name, definition), { override: true });
    }
  }

  private registerCustomTools(): void {
    if (!this.options.tools || this.options.tools.length === 0) {
      return;
    }
    const tools = this.options.tools.map(toRuntimeTool);
    this.registerTools(tools);
  }

  private registerPluginTools(): void {
    const registrations = this.pluginHost.getTools();
    for (const { pluginName, tool } of registrations) {
      const filteredTools = this.filterTools([toRuntimeTool(tool)]);
      if (filteredTools.length === 0) {
        continue;
      }
      this.toolCatalog.registerAll(filteredTools, {
        kind: 'custom',
        trustLevel: 'workspace',
        sourceId: `plugin:${pluginName}`,
      });
    }
  }

  private async registerConfiguredMcpServers(): Promise<void> {
    if (!this.options.mcpServers) {
      return;
    }

    for (const [name, config] of Object.entries(this.options.mcpServers)) {
      if (isSdkMcpServerHandle(config)) {
        await this.mcpRegistry.registerInProcessServer(name, config);
        continue;
      }
      if (config.disabled) {
        continue;
      }
      try {
        await this.mcpRegistry.registerServer(name, config);
      } catch (error) {
        this.logger.warn(`[SessionRuntime] Failed to register MCP server ${name}:`, error);
      }
    }

    await this.refreshMcpTools(Object.keys(this.options.mcpServers));
  }

  private async ensureServerRegistered(serverName: string): Promise<void> {
    const serverInfo = this.mcpRegistry.getServerStatus(serverName);
    if (serverInfo) {
      return;
    }

    const config = this.options.mcpServers?.[serverName];
    if (!config) {
      throw new Error(`MCP server "${serverName}" not found in configuration`);
    }

    if (isSdkMcpServerHandle(config)) {
      await this.mcpRegistry.registerInProcessServer(serverName, config);
      return;
    }

    await this.mcpRegistry.registerServer(serverName, config);
  }

  private async refreshMcpTools(serverNames: string[]): Promise<void> {
    for (const serverName of serverNames) {
      this.toolRegistry.removeMcpTools(serverName);
    }

    const availableTools = await this.mcpRegistry.getAvailableToolsByServerNames(serverNames);
    for (const tool of this.filterTools(availableTools)) {
      this.toolCatalog.registerMcpTool(tool, {
        kind: 'mcp',
        trustLevel: 'remote',
        sourceId: serverNameFromTool(tool),
      });
    }
  }

  private registerTools<TParams>(tools: Tool<TParams>[]): void {
    const filteredTools = this.filterTools(tools);
    if (filteredTools.length === 0) {
      return;
    }
    this.toolCatalog.registerAll(filteredTools as unknown as Tool[], {
      kind: 'custom',
      trustLevel: 'workspace',
      sourceId: 'session',
    });
  }

  private filterTools<TParams>(tools: Tool<TParams>[]): Tool<TParams>[] {
    const allowedTools = this.options.allowedTools;
    const disallowedTools = new Set(this.options.disallowedTools || []);

    return tools.filter((tool) => {
      if (allowedTools !== undefined && !allowedTools.includes(tool.name)) {
        return false;
      }
      return !disallowedTools.has(tool.name);
    });
  }

  private createPermissionHandler(): PermissionHandler | undefined {
    const hasPermissionCallbacks =
      (this.hookCallbacks[HookEvent.PermissionRequest]?.length ?? 0) > 0;
    const basePermissionHandler = this.options.permissionHandler
      ?? (this.options.canUseTool
        ? createPermissionHandlerFromCanUseTool(this.options.canUseTool)
        : undefined);

    if (!hasPermissionCallbacks && !basePermissionHandler) {
      return undefined;
    }

    const hookPermissionHandler = hasPermissionCallbacks
      ? (async (request) => {
          const hookResult = await this.hookRuntime.applyPermissionRequestHooks(
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
      async () => ({ behavior: 'ask' } satisfies PermissionResult),
    ]);
  }
}

function serverNameFromTool(tool: Tool): string {
  const taggedServer = tool.tags.find((tag) => tag === tag.toLowerCase() && tag.length > 0);
  if (taggedServer) {
    return taggedServer;
  }

  const match = tool.name.match(/^mcp__([^_]+)__/);
  return match?.[1] ?? 'mcp';
}
