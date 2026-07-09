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
