export const agentSdkRootDeclarationEntryOwnershipRules = [
  {
    forbidden: './agent/loop/runToolCall.js',
    message: 'root declarations must be emitted from package-local root entry source',
  },
  {
    forbidden: './tools/core/createTool.js',
    message: 'root declarations must be emitted from package-local root entry source',
  },
  {
    forbidden: './tools/catalog/index.js',
    message: 'root declarations must be emitted from package-local root entry source',
  },
  {
    forbidden: 'public-index.js',
    message: 'root declarations must reference final public entrypoints, not overlay sources',
  },
];

export const agentSdkRootPublicDeclarationBoundaryRules = [
  {
    forbidden: 'getBuiltinTools',
    message: 'root declarations must keep Node-local builtin tools behind @blade-ai/agent-sdk/local',
  },
  {
    forbidden: 'createSdkMcpServer',
    message: 'root declarations must keep Node-local MCP helpers behind @blade-ai/agent-sdk/local',
  },
  {
    forbidden: 'FileSystemMemoryStore',
    message: 'root declarations must keep filesystem memory adapters behind @blade-ai/agent-sdk/local',
  },
  {
    forbidden: 'SandboxExecutor',
    message: 'root declarations must keep sandbox adapters behind @blade-ai/agent-sdk/local',
  },
  {
    forbidden: 'normalizeDeepSeekModel',
    message: 'root declarations must keep provider-specific DeepSeek helpers in @blade-ai/ai/deepseek',
  },
  {
    forbidden: 'calculateDeepSeekCost',
    message: 'root declarations must keep provider-specific DeepSeek helpers in @blade-ai/ai/deepseek',
  },
  {
    forbidden: 'DeepSeekCostTracker',
    message: 'root declarations must keep provider-specific DeepSeek helpers in @blade-ai/ai/deepseek',
  },
  {
    forbidden: 'DEEPSEEK_DEFAULT_MODEL',
    message: 'root declarations must keep provider-specific DeepSeek helpers in @blade-ai/ai/deepseek',
  },
];

export const agentSdkRootSubagentCompatibilityBoundaryRules = [
  {
    file: 'dist/index.js',
    forbidden: 'src/agent/subagents',
    message: 'root runtime must use package-local subagent compatibility exports',
  },
  {
    file: 'dist/index.d.ts',
    forbidden: '../agent/subagents',
    message: 'root declarations must use package-local subagent compatibility exports',
  },
];

export const agentSdkServerFacadeBoundaryRules = [
  {
    file: 'dist/server/index.js',
    forbidden: '../index.js',
    message: 'server runtime entry must be an explicit package-local facade',
    boundary: 'server runtime facade boundary',
  },
  {
    file: 'dist/server/index.d.ts',
    forbidden: '../index.js',
    message: 'server declarations must be an explicit package-local facade',
    boundary: 'server declaration facade boundary',
  },
];

export const agentSdkCoreDeclarationBrowserSafeRules = [
  {
    file: 'dist/core/index.d.ts',
    forbidden: 'createSession',
    message: 'core declarations must stay browser-safe and not expose server-only session APIs',
  },
  {
    file: 'dist/core/index.d.ts',
    forbidden: 'resumeSession',
    message: 'core declarations must stay browser-safe and not expose server-only session APIs',
  },
  {
    file: 'dist/core/index.d.ts',
    forbidden: 'forkSession',
    message: 'core declarations must stay browser-safe and not expose server-only session APIs',
  },
  {
    file: 'dist/core/index.d.ts',
    forbidden: 'getBuiltinTools',
    message: 'core declarations must stay browser-safe and not expose Node-local tool APIs',
  },
  {
    file: 'dist/core/index.d.ts',
    forbidden: 'createSdkMcpServer',
    message: 'core declarations must stay browser-safe and not expose Node-local MCP APIs',
  },
];

export const agentSdkSessionPublicDeclarationBoundaryRules = [
  {
    file: 'dist/session/types.d.ts',
    forbidden: "runtime?: 'kernel' | 'legacy'",
    message: 'session declarations must not expose retired legacy stream runtime options',
  },
  {
    file: 'dist/session/types.d.ts',
    forbidden: 'experimentalKernel',
    message: 'session declarations must not expose retired experimental kernel flags',
  },
  {
    file: 'dist/session/types.d.ts',
    forbidden: 'legacyStream',
    message: 'session declarations must not expose retired legacy stream helpers',
  },
  {
    file: 'dist/session/types.d.ts',
    forbidden: 'packageLocalLegacy',
    message: 'session declarations must not expose retired package-local legacy runtime helpers',
  },
  {
    file: 'dist/session/types.d.ts',
    forbidden: "from '@blade-ai/agent'",
    message: 'session budget declarations must use the explicit @blade-ai/agent/budget subpath',
  },
  {
    file: 'dist/session/types.d.ts',
    forbidden: 'AgentTokenBudgetSnapshot',
    message: 'session budget declarations must expose TokenBudgetSnapshot from @blade-ai/agent/budget',
  },
];

export const agentSdkSessionEntrySessionBoundaryRules = [
  {
    file: 'dist/session/index.d.ts',
    forbidden: './Session.js',
    message: 'session declarations must be emitted from package-local session entry source',
  },
  {
    file: 'dist/session/index.js',
    forbidden: '../../../../src/session/Session',
    message: 'session runtime entry must not import the legacy root Session directly',
  },
  {
    file: 'dist/session/index.js',
    forbidden: 'from"../../../../src/session/Session',
    message: 'session runtime entry must not import the legacy root Session directly',
  },
  {
    file: 'dist/session/index.js',
    forbidden: 'from "../../../../src/session/Session',
    message: 'session runtime entry must not import the legacy root Session directly',
  },
  {
    file: 'dist/session/Session.d.ts',
    forbidden: '../../../../src/session/Session',
    message: 'package-local Session declarations must expose local session contracts only',
  },
];

export const agentSdkSessionFactoryDeclarationBoundaryRules = [
  {
    file: 'dist/session/factory.d.ts',
    forbidden: 'fork(options',
    message: 'session runtime factory declarations must expose only create/resume primitives',
  },
  {
    file: 'dist/session/factory.d.ts',
    forbidden: 'prompt(message',
    message: 'session runtime factory declarations must expose only create/resume primitives',
  },
];

export const agentSdkSessionConfigDeclarationBoundaryRules = [
  {
    file: 'dist/session/config.d.ts',
    forbidden: './Session.js',
    message: 'session config declarations must be emitted from package-local session config source',
  },
  {
    file: 'dist/session/config.d.ts',
    forbidden: '../../../../src/types/common',
    message: 'session config declarations must use package-local core config types',
  },
];

export const agentSdkSessionStoreDeclarationBoundaryRules = [
  {
    file: 'dist/session/store.d.ts',
    forbidden: '../context/storage',
    message: 'session store declarations must be emitted from package-local session store source',
  },
  {
    file: 'dist/session/store.d.ts',
    forbidden: './SessionStore.js',
    message: 'session store declarations must not point back at legacy root session store',
  },
];

export const agentSdkToolsEntryBoundaryRules = [
  {
    file: 'dist/tools/index.d.ts',
    forbidden: './core/createTool.js',
    message: 'tools declarations must be emitted from package-local tools entry source',
  },
  {
    file: 'dist/tools/index.d.ts',
    forbidden: './catalog/index.js',
    message: 'tools declarations must be emitted from package-local tools entry source',
  },
  {
    file: 'dist/tools/index.d.ts',
    forbidden: '../core/createTool.js',
    message: 'tools declarations must be emitted from package-local tools entry source',
  },
  {
    file: 'dist/tools/index.d.ts',
    forbidden: '../catalog/ToolCatalog.js',
    message: 'tools declarations must be emitted from package-local tools entry source',
  },
  {
    file: 'dist/tools/index.js',
    forbidden: 'src/tools/core/createTool',
    message: 'tools runtime must be emitted from package-local tools source',
  },
  {
    file: 'dist/tools/index.js',
    forbidden: 'src/tools/catalog/ToolCatalog',
    message: 'tools runtime must be emitted from package-local tools source',
  },
];

export const agentSdkLocalAdapterBoundaryRules = [
  {
    file: 'dist/local/index.d.ts',
    forbidden: '../mcp/index.js',
    message: 'local declarations must be emitted from package-local local entry source',
  },
  {
    file: 'dist/local/index.d.ts',
    forbidden: '../memory/index.js',
    message: 'local declarations must be emitted from package-local local entry source',
  },
  {
    file: 'dist/local/index.d.ts',
    forbidden: '../sandbox/index.js',
    message: 'local declarations must be emitted from package-local local entry source',
  },
  {
    file: 'dist/local/index.d.ts',
    forbidden: '../tools/builtin',
    message: 'local declarations must be emitted from package-local local entry source',
  },
  {
    file: 'dist/local/index.d.ts',
    forbidden: 'createSdkMcpServer(...args: unknown[])',
    message: 'local MCP declarations must use package-local MCP API',
  },
  {
    file: 'dist/local/index.d.ts',
    forbidden: 'tool(...args: unknown[])',
    message: 'local MCP declarations must use package-local MCP API',
  },
  {
    file: 'dist/local/index.d.ts',
    forbidden: 'constructor(...args: unknown[]): SandboxExecutor',
    message: 'local sandbox declarations must use package-local sandbox API',
  },
  {
    file: 'dist/local/index.d.ts',
    forbidden: 'constructor(...args: unknown[]): SandboxService',
    message: 'local sandbox declarations must use package-local sandbox API',
  },
  {
    file: 'dist/local/index.d.ts',
    forbidden: 'getBuiltinTools(...args: unknown[])',
    message: 'local builtin tool declarations must use package-local builtin tool API',
  },
  {
    file: 'dist/local/index.d.ts',
    forbidden: 'read(id: string)',
    message: 'local memory declarations must use package-local memory API',
  },
  {
    file: 'dist/local/index.d.ts',
    forbidden: 'write(input: MemoryInput)',
    message: 'local memory declarations must use package-local memory API',
  },
  {
    file: 'dist/local/index.d.ts',
    forbidden: 'delete(id: string): Promise<boolean>',
    message: 'local memory declarations must use package-local memory API',
  },
  {
    file: 'dist/local/index.js',
    forbidden: 'src/mcp',
    message: 'local runtime entry must route through package-local local adapters',
  },
  {
    file: 'dist/local/index.js',
    forbidden: 'src/memory',
    message: 'local runtime entry must route through package-local local adapters',
  },
  {
    file: 'dist/local/index.js',
    forbidden: 'src/sandbox',
    message: 'local runtime entry must route through package-local local adapters',
  },
  {
    file: 'dist/local/index.js',
    forbidden: 'src/tools/builtin',
    message: 'local runtime entry must route through package-local local adapters',
  },
  {
    file: 'dist/local/index.js',
    forbidden: 'src/tools/builtin/memory',
    message: 'local memory tools must route through package-local local adapters',
  },
];

export const agentSdkPermissionDeclarationBoundaryRules = [
  {
    file: 'dist/types/permissions.d.ts',
    forbidden: 'SensitiveFileDetector',
    message: 'permission declarations must be emitted from package-local permission source',
  },
  {
    file: 'dist/types/permissions.d.ts',
    forbidden: './ToolEffects.js',
    message: 'permission declarations must use package-local tool contracts',
  },
];

export function toLocalForbiddenDeclarationRules(rules) {
  return rules.map((rule) => ({
    forbidden: rule.forbidden,
    message: `local ${rule.message}`,
  }));
}

export function toPackedForbiddenFileContents(file, rules) {
  return rules.map((rule) => ({
    file,
    forbidden: rule.forbidden,
    message: rule.message,
  }));
}

export function toPackedForbiddenFileRules(rules) {
  return rules.map((rule) => ({
    file: `package/${rule.file}`,
    forbidden: rule.forbidden,
    message: rule.message,
  }));
}

export function toInstalledForbiddenFileRules(packageRoot, rules) {
  const normalizedPackageRoot = packageRoot.replace(/\/$/, '');
  return rules.map((rule) => ({
    file: `package/${rule.file}`,
    path: `${normalizedPackageRoot}/${rule.file}`,
    forbidden: rule.forbidden,
    message: rule.message,
  }));
}
