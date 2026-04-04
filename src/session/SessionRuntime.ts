import { basename, dirname } from 'node:path';
import type { AgentRuntimeDeps } from '../agent/Agent.js';
import { BackgroundAgentManager } from '../agent/subagents/BackgroundAgentManager.js';
import { SubagentRegistry } from '../agent/subagents/SubagentRegistry.js';
import { ContextManager } from '../context/ContextManager.js';
import { HookManager } from '../hooks/HookManager.js';
import { HookRuntime } from '../hooks/HookRuntime.js';
import type { InternalLogger } from '../logging/Logger.js';
import { LogCategory } from '../logging/Logger.js';
import { projectMcpCapabilities, type McpServerCapability } from '../mcp/McpCapabilityProjector.js';
import { McpRegistry } from '../mcp/McpRegistry.js';
import type { SdkMcpServerHandle } from '../mcp/SdkMcpServer.js';
import { getSandboxExecutor } from '../sandbox/SandboxExecutor.js';
import { getSandboxService } from '../sandbox/SandboxService.js';
import { FileAccessTracker } from '../tools/builtin/file/FileAccessTracker.js';
import { getBuiltinTools } from '../tools/builtin/index.js';
import { toolFromDefinition } from '../tools/core/createTool.js';
import {
  ExecutionPipeline,
  type ExecutionPipelineHooks,
} from '../tools/execution/ExecutionPipeline.js';
import { FileLockManager } from '../tools/execution/FileLockManager.js';
import { ToolRegistry } from '../tools/registry/ToolRegistry.js';
import type { Tool } from '../tools/types/index.js';
import type { BladeConfig, McpServerConfig, PermissionsConfig } from '../types/common.js';
import { PermissionMode } from '../types/common.js';
import { HookEvent } from '../types/constants.js';
import type { CanUseTool, PermissionResult } from '../types/permissions.js';
import type { ContextSnapshot, RuntimeContext } from '../runtime/index.js';
import {
  getContextCwd,
} from '../runtime/index.js';
import type {
  AgentDefinition,
  HookCallback,
  McpServerStatus,
  McpToolInfo,
  SessionOptions,
} from './types.js';

function isSdkMcpServerHandle(
  config: McpServerConfig | SdkMcpServerHandle
): config is SdkMcpServerHandle {
  return 'createClientTransport' in config && 'server' in config;
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
  private readonly contextManager: ContextManager;
  private readonly executionPipeline: ExecutionPipeline;
  private readonly backgroundAgentManager: BackgroundAgentManager;
  private readonly hookCallbacks: Partial<Record<HookEvent, HookCallback[]>>;
  private readonly hookRuntime: HookRuntime;
  private readonly rootLogger: InternalLogger;
  private readonly logger: InternalLogger;
  private initialized = false;

  constructor(
    private readonly sessionId: string,
    private readonly options: SessionOptions,
    private readonly bladeConfig: BladeConfig,
    private readonly permissionMode: PermissionMode,
    private readonly defaultContext: RuntimeContext,
    logger: InternalLogger,
  ) {
    this.rootLogger = logger;
    this.logger = logger.child(LogCategory.AGENT);
    this.storageRoot = bladeConfig.storageRoot ?? resolveStorageRoot(options.storagePath);
    this.mcpRegistry = new McpRegistry(this.storageRoot);
    this.subagentRegistry = new SubagentRegistry(this.rootLogger, getContextCwd(defaultContext));
    this.backgroundAgentManager = BackgroundAgentManager.getInstance(this.rootLogger);
    this.contextManager = new ContextManager({
      storage: {
        maxMemorySize: 1000,
        persistentPath: options.storagePath,
        persistenceEnabled: options.persistSession ?? true,
        cacheSize: 100,
        compressionEnabled: true,
      },
      projectPath: getContextCwd(defaultContext),
    });
    this.hookCallbacks = options.hooks || {};
    this.hookRuntime = new HookRuntime({
      sessionId,
      permissionMode,
      callbacks: this.hookCallbacks,
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

  getBackgroundAgentManager(): BackgroundAgentManager {
    return this.backgroundAgentManager;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (this.options.sandbox) {
      getSandboxExecutor(this.rootLogger);
      getSandboxService().configure(this.options.sandbox);
    }

    this.initializeSubagents();
    await this.contextManager.initialize();
    FileAccessTracker.getInstance(this.rootLogger);
    FileLockManager.getInstance(this.rootLogger);
    this.initializeHooks();
    await this.registerBuiltinTools();
    this.registerCustomTools();
    await this.registerConfiguredMcpServers();

    this.initialized = true;
  }

  async ensureSessionCreated(): Promise<void> {
    await this.contextManager.createSession(undefined, {}, { sessionId: this.sessionId });
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

  async close(): Promise<void> {
    await this.mcpRegistry.disconnectAll();
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
      canUseTool: this.createCanUseTool(),
      hooks: this.createExecutionPipelineHooks(),
      logger: this.rootLogger,
    });
  }

  private initializeHooks(): void {
    const hookManager = HookManager.getInstance();
    if (this.options.hooks && Object.keys(this.options.hooks).length > 0) {
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
    this.registerTools(builtinTools);
  }

  private initializeSubagents(): void {
    this.subagentRegistry.setLogger(this.rootLogger);
    this.subagentRegistry.setProjectDir(getContextCwd(this.defaultContext));
    this.subagentRegistry.loadFromStandardLocations(
      getContextCwd(this.defaultContext),
      this.storageRoot,
    );

    for (const [name, definition] of Object.entries(this.options.agents ?? {})) {
      this.subagentRegistry.register(toSubagentConfig(name, definition), { override: true });
    }
  }

  private registerCustomTools(): void {
    if (!this.options.tools || this.options.tools.length === 0) {
      return;
    }
    const tools = this.options.tools.map((tool) => toolFromDefinition(tool));
    this.registerTools(tools);
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
      this.toolRegistry.registerMcpTool(tool);
    }
  }

  private registerTools<TParams>(tools: Tool<TParams>[]): void {
    const filteredTools = this.filterTools(tools);
    if (filteredTools.length === 0) {
      return;
    }
    this.toolRegistry.registerAll(filteredTools as Tool[]);
  }

  private filterTools<TParams>(tools: Tool<TParams>[]): Tool<TParams>[] {
    const allowedTools = this.options.allowedTools;
    const disallowedTools = new Set(this.options.disallowedTools || []);

    return tools.filter((tool) => {
      if (allowedTools && allowedTools.length > 0 && !allowedTools.includes(tool.name)) {
        return false;
      }
      return !disallowedTools.has(tool.name);
    });
  }

  private createCanUseTool(): CanUseTool | undefined {
    const hasPermissionCallbacks =
      (this.hookCallbacks[HookEvent.PermissionRequest]?.length ?? 0) > 0;
    const hasProjectDir = Boolean(getContextCwd(this.defaultContext));
    const baseCanUseTool = this.options.canUseTool;

    if (!hasPermissionCallbacks && !baseCanUseTool && !hasProjectDir) {
      return undefined;
    }

    return async (toolName, input, options) => {
      const hookResult = await this.hookRuntime.applyPermissionRequestHooks(
        toolName,
        input,
        options,
      );
      Object.assign(input, hookResult.updatedInput);
      if (hookResult.decision) {
        return hookResult.decision;
      }

      if (baseCanUseTool) {
        return baseCanUseTool(toolName, input, options);
      }

      return { behavior: 'ask' } satisfies PermissionResult;
    };
  }

  private createExecutionPipelineHooks(): ExecutionPipelineHooks | undefined {
    return this.hookRuntime.createExecutionPipelineHooks();
  }
}
