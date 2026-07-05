import { createPackageLocalKernelTracePort } from './kernelTracePort.js';
import type {
  PackageLocalRuntimeAgentKernelFactoryPort,
  PackageLocalRuntimeBackgroundAgentManagerPort,
  PackageLocalRuntimeExecutionPipelineFactoryPort,
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
