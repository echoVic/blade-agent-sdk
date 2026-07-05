import { basename, dirname } from 'node:path';
import type { ContextSnapshot, RuntimeContext } from '../runtime/types.js';
import type { BladeConfig, McpServerConfig } from '../types/common.js';
import type {
  McpToolInfo,
  McpServerStatus,
  SdkMcpServerHandle,
  SessionHookEvent,
  SessionId,
  SessionOptions,
  HookCallback,
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
  warn(...args: unknown[]): void;
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

function packageLocalServerNameFromTool(tool: PackageLocalRuntimeMcpTool): string {
  const taggedServer = tool.tags?.find((tag) => tag === tag.toLowerCase() && tag.length > 0);
  if (taggedServer) {
    return taggedServer;
  }

  const match = tool.name.match(/^mcp__([^_]+)__/);
  return match?.[1] ?? 'mcp';
}
