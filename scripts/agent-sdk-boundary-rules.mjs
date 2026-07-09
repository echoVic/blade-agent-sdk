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
