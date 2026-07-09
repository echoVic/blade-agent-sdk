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
