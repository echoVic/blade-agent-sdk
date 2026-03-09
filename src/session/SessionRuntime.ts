import * as os from 'os';
import * as path from 'path';
import type { AgentRuntimeDeps } from '../agent/Agent.js';
import { ContextManager } from '../context/ContextManager.js';
import { HookManager } from '../hooks/HookManager.js';
import type { InternalLogger } from '../logging/Logger.js';
import { LogCategory } from '../logging/Logger.js';
import { McpRegistry } from '../mcp/McpRegistry.js';
import type { SdkMcpServerHandle } from '../mcp/SdkMcpServer.js';
import { McpConnectionStatus } from '../mcp/types.js';
import { getSandboxExecutor } from '../sandbox/SandboxExecutor.js';
import { getSandboxService } from '../sandbox/SandboxService.js';
import { FileAccessTracker } from '../tools/builtin/file/FileAccessTracker.js';
import { getBuiltinTools } from '../tools/builtin/index.js';
import { toolFromDefinition } from '../tools/core/createTool.js';
import {
  ExecutionPipeline,
  type ExecutionPipelineHookResult,
  type ExecutionPipelineHooks,
} from '../tools/execution/ExecutionPipeline.js';
import { FileLockManager } from '../tools/execution/FileLockManager.js';
import { ToolRegistry } from '../tools/registry/ToolRegistry.js';
import type { Tool } from '../tools/types/index.js';
import type { BladeConfig, McpServerConfig, PermissionsConfig } from '../types/common.js';
import { PermissionMode } from '../types/common.js';
import { HookEvent } from '../types/constants.js';
import type { CanUseTool, PermissionResult } from '../types/permissions.js';
import type { HookCallback, HookInput, HookOutput, McpServerStatus, McpToolInfo, SessionOptions } from './types.js';

function isSdkMcpServerHandle(
  config: McpServerConfig | SdkMcpServerHandle
): config is SdkMcpServerHandle {
  return 'createClientTransport' in config && 'server' in config;
}

function getToolDescription(tool: Tool): string {
  return typeof tool.description === 'string'
    ? tool.description
    : tool.description.short;
}

export class SessionRuntime {
  private readonly mcpRegistry = new McpRegistry();
  private readonly toolRegistry = new ToolRegistry();
  private readonly contextManager: ContextManager;
  private readonly executionPipeline: ExecutionPipeline;
  private readonly hookCallbacks: Partial<Record<HookEvent, HookCallback[]>>;
  private readonly rootLogger: InternalLogger;
  private readonly logger: InternalLogger;
  private initialized = false;

  constructor(
    private readonly sessionId: string,
    private readonly options: SessionOptions,
    private readonly bladeConfig: BladeConfig,
    private readonly permissionMode: PermissionMode,
    private readonly workspaceRoot: string,
    logger: InternalLogger,
  ) {
    this.rootLogger = logger;
    this.logger = logger.child(LogCategory.AGENT);
    this.contextManager = new ContextManager({ projectPath: workspaceRoot });
    this.hookCallbacks = options.hooks || {};
    this.executionPipeline = this.createExecutionPipeline();
  }

  getAgentRuntimeDeps(): AgentRuntimeDeps {
    return {
      executionPipeline: this.executionPipeline,
      contextManager: this.contextManager,
      workspaceRoot: this.workspaceRoot,
      mcpRegistry: this.mcpRegistry,
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

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (this.options.sandbox) {
      getSandboxExecutor(this.rootLogger);
      getSandboxService().configure(this.options.sandbox);
    }

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

  async close(): Promise<void> {
    await this.mcpRegistry.disconnectAll();
  }

  async mcpServerStatus(): Promise<McpServerStatus[]> {
    const statuses: McpServerStatus[] = [];
    for (const [name, serverInfo] of this.mcpRegistry.getAllServers()) {
      const statusMap: Record<McpConnectionStatus, McpServerStatus['status']> = {
        [McpConnectionStatus.CONNECTED]: 'connected',
        [McpConnectionStatus.DISCONNECTED]: 'disconnected',
        [McpConnectionStatus.CONNECTING]: 'connecting',
        [McpConnectionStatus.ERROR]: 'error',
      };
      statuses.push({
        name,
        status: statusMap[serverInfo.status],
        toolCount: serverInfo.tools.length,
        tools: serverInfo.tools.map((tool) => tool.name),
        connectedAt: serverInfo.connectedAt,
        error: serverInfo.lastError?.message,
      });
    }
    return statuses;
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
    return this.toolRegistry.getMcpTools().map((tool) => ({
      name: tool.name,
      description: getToolDescription(tool),
      serverName: tool.tags.find((tag) => tag !== 'mcp' && tag !== 'external') || 'unknown',
    }));
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
      configDir: path.join(os.homedir(), '.blade'),
      mcpRegistry: this.mcpRegistry,
      includeMcpProtocolTools: false,
    });
    this.registerTools(builtinTools);
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
    const permissionHooks = this.hookCallbacks[HookEvent.PermissionRequest];
    const baseCanUseTool = this.options.canUseTool;

    if ((!permissionHooks || permissionHooks.length === 0) && !baseCanUseTool) {
      return undefined;
    }

    return async (toolName, input, options) => {
      if (permissionHooks && permissionHooks.length > 0) {
        for (const hook of permissionHooks) {
          const result = await this.executeHook(hook, HookEvent.PermissionRequest, {
            toolName,
            toolInput: input,
            affectedPaths: options.affectedPaths,
            toolKind: options.toolKind,
          });

          if (result.modifiedInput && this.isRecord(result.modifiedInput)) {
            Object.assign(input, result.modifiedInput);
          }

          if (result.action === 'abort' || result.action === 'skip') {
            return {
              behavior: 'deny',
              message: result.reason || `Tool "${toolName}" was blocked by hook`,
              interrupt: result.action === 'abort',
            } satisfies PermissionResult;
          }
        }
      }

      if (baseCanUseTool) {
        return baseCanUseTool(toolName, input, options);
      }

      return { behavior: 'ask' } satisfies PermissionResult;
    };
  }

  private createExecutionPipelineHooks(): ExecutionPipelineHooks | undefined {
    const hasPreToolHooks = (this.hookCallbacks[HookEvent.PreToolUse]?.length || 0) > 0;
    const hasPostToolHooks = (this.hookCallbacks[HookEvent.PostToolUse]?.length || 0) > 0;
    const hasPostToolFailureHooks =
      (this.hookCallbacks[HookEvent.PostToolUseFailure]?.length || 0) > 0;

    if (!hasPreToolHooks && !hasPostToolHooks && !hasPostToolFailureHooks) {
      return undefined;
    }

    return {
      beforeExecute: async ({ toolName, params }) => {
        const hooks = this.hookCallbacks[HookEvent.PreToolUse];
        if (!hooks || hooks.length === 0) {
          return undefined;
        }

        let nextParams: Record<string, unknown> = params;
        for (const hook of hooks) {
          const result = await this.executeHook(hook, HookEvent.PreToolUse, {
            toolName,
            toolInput: nextParams,
          });

          if (result.action === 'abort' || result.action === 'skip') {
            return {
              action: result.action,
              reason: result.reason,
            } satisfies ExecutionPipelineHookResult;
          }

          if (result.modifiedInput && this.isRecord(result.modifiedInput)) {
            nextParams = { ...nextParams, ...result.modifiedInput };
          }
        }

        if (nextParams !== params) {
          return { modifiedInput: nextParams } satisfies ExecutionPipelineHookResult;
        }
        return undefined;
      },
      afterExecute: async ({ toolName, params, result }) => {
        const event = result.success ? HookEvent.PostToolUse : HookEvent.PostToolUseFailure;
        const hooks = this.hookCallbacks[event];
        if (!hooks || hooks.length === 0) {
          return undefined;
        }

        let nextOutput: unknown = result.llmContent;
        for (const hook of hooks) {
          const hookResult = await this.executeHook(hook, event, {
            toolName,
            toolInput: params,
            toolOutput: nextOutput,
            error: result.success
              ? undefined
              : new Error(result.error?.message || `Tool "${toolName}" failed`),
          });

          if (hookResult.action === 'abort' || hookResult.action === 'skip') {
            return {
              action: hookResult.action,
              reason: hookResult.reason,
            } satisfies ExecutionPipelineHookResult;
          }

          if (hookResult.modifiedOutput !== undefined) {
            nextOutput = hookResult.modifiedOutput;
          }
        }

        if (nextOutput !== result.llmContent) {
          return { modifiedOutput: nextOutput } satisfies ExecutionPipelineHookResult;
        }
        return undefined;
      },
    };
  }

  private async executeHook(
    hook: HookCallback,
    event: HookEvent,
    payload: Record<string, unknown>,
  ): Promise<HookOutput> {
    const input: HookInput = {
      event,
      sessionId: this.sessionId,
      ...payload,
    };
    return hook(input);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
