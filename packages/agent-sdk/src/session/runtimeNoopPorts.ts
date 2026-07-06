import { createPackageLocalKernelTracePort } from './kernelTracePort.js';
import type {
  PackageLocalRuntimeAgentKernelFactoryPort,
  PackageLocalRuntimeBackgroundAgentManagerPort,
  PackageLocalRuntimeExecutionPipelineFactoryPort,
  PackageLocalRuntimeHookManagerPort,
  PackageLocalRuntimeHookRuntimePort,
  PackageLocalRuntimeKernelModelResolverPort,
  PackageLocalRuntimeKernelPortFactoryPort,
  PackageLocalRuntimeLoggerPort,
  PackageLocalRuntimeMcpRegistryPort,
  PackageLocalRuntimePermissionHookPort,
  PackageLocalRuntimeSessionStorePort,
  PackageLocalRuntimeSubagentRegistryPort,
  PackageLocalRuntimeToolCatalogPort,
  PackageLocalRuntimeWorkspacePort,
} from './runtimeInstance.js';

export interface PackageLocalRuntimeNoopPorts {
  sessionStore: PackageLocalRuntimeSessionStorePort;
  workspace: PackageLocalRuntimeWorkspacePort;
  mcpRegistry: PackageLocalRuntimeMcpRegistryPort;
  toolCatalog: PackageLocalRuntimeToolCatalogPort;
  logger: PackageLocalRuntimeLoggerPort;
  subagentRegistry: PackageLocalRuntimeSubagentRegistryPort;
  permissionHooks: PackageLocalRuntimePermissionHookPort;
  hookRuntime: PackageLocalRuntimeHookRuntimePort;
  backgroundAgentManager: PackageLocalRuntimeBackgroundAgentManagerPort;
  executionPipelineFactory: PackageLocalRuntimeExecutionPipelineFactoryPort;
  kernelPortFactory: PackageLocalRuntimeKernelPortFactoryPort;
  kernelFactory: PackageLocalRuntimeAgentKernelFactoryPort;
  kernelModelResolver: PackageLocalRuntimeKernelModelResolverPort;
}

export interface PackageLocalRuntimePortResolutionOptions {
  sessionStore?: PackageLocalRuntimeSessionStorePort;
  workspace?: PackageLocalRuntimeWorkspacePort;
  mcpRegistry?: PackageLocalRuntimeMcpRegistryPort;
  toolCatalog?: PackageLocalRuntimeToolCatalogPort;
  logger?: PackageLocalRuntimeLoggerPort;
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

export interface PackageLocalRuntimeResolvedPorts extends PackageLocalRuntimeNoopPorts {
  hookManager: PackageLocalRuntimeHookManagerPort;
}

export function createPackageLocalRuntimeNoopPorts(): PackageLocalRuntimeNoopPorts {
  return {
    sessionStore: createNoopRuntimeSessionStore(),
    workspace: createNoopRuntimeWorkspace(),
    mcpRegistry: createNoopRuntimeMcpRegistry(),
    toolCatalog: createNoopRuntimeToolCatalog(),
    logger: createNoopRuntimeLogger(),
    subagentRegistry: createNoopRuntimeSubagentRegistry(),
    permissionHooks: createNoopRuntimePermissionHooks(),
    hookRuntime: createNoopRuntimeHookRuntime(),
    backgroundAgentManager: createNoopRuntimeBackgroundAgentManager(),
    executionPipelineFactory: createNoopRuntimeExecutionPipelineFactory(),
    kernelPortFactory: createNoopRuntimeKernelPortFactory(),
    kernelFactory: createNoopRuntimeAgentKernelFactory(),
    kernelModelResolver: createNoopRuntimeKernelModelResolver(),
  };
}

export function resolvePackageLocalRuntimePorts(
  options: PackageLocalRuntimePortResolutionOptions,
): PackageLocalRuntimeResolvedPorts {
  const noopPorts = createPackageLocalRuntimeNoopPorts();
  const hookRuntime = options.hookRuntime ?? noopPorts.hookRuntime;

  return {
    sessionStore: options.sessionStore ?? noopPorts.sessionStore,
    workspace: options.workspace ?? noopPorts.workspace,
    mcpRegistry: options.mcpRegistry ?? noopPorts.mcpRegistry,
    toolCatalog: options.toolCatalog ?? noopPorts.toolCatalog,
    logger: options.logger ?? noopPorts.logger,
    subagentRegistry: options.subagentRegistry ?? noopPorts.subagentRegistry,
    permissionHooks: options.permissionHooks ?? noopPorts.permissionHooks,
    hookRuntime,
    hookManager: options.hookManager ?? hookRuntime,
    backgroundAgentManager:
      options.backgroundAgentManager ?? noopPorts.backgroundAgentManager,
    executionPipelineFactory:
      options.executionPipelineFactory ?? noopPorts.executionPipelineFactory,
    kernelPortFactory: options.kernelPortFactory ?? noopPorts.kernelPortFactory,
    kernelFactory: options.kernelFactory ?? noopPorts.kernelFactory,
    kernelModelResolver: options.kernelModelResolver ?? noopPorts.kernelModelResolver,
  };
}

function createNoopRuntimeSessionStore(): PackageLocalRuntimeSessionStorePort {
  return {
    async createSession() {},
    async loadSession() {
      return false;
    },
    async loadMessages() {
      return [];
    },
    appendMessage() {},
    async forkState() {
      return null;
    },
    async writeForkState() {
      return null;
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
    createStorePort(options) {
      return {
        appendMessage(message, context) {
          return options.sessionStore.appendMessage(options.sessionId, message, context);
        },
      };
    },
    createTracePort(options) {
      return createPackageLocalKernelTracePort(options);
    },
    createHookPort(options) {
      return options.hookRuntime.createAgentHookPort?.() ?? {};
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
