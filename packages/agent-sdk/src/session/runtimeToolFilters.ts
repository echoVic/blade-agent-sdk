export interface PackageLocalRuntimeToolFilterable {
  name: string;
}

export interface PackageLocalRuntimeToolFilterOptions {
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
}

export function filterPackageLocalRuntimeTools<TTool extends PackageLocalRuntimeToolFilterable>(
  tools: readonly TTool[],
  options: PackageLocalRuntimeToolFilterOptions,
): TTool[] {
  const allowedTools = options.allowedTools;
  const disallowedTools = new Set(options.disallowedTools ?? []);

  return tools.filter((tool) => {
    if (allowedTools !== undefined && !allowedTools.includes(tool.name)) {
      return false;
    }
    return !disallowedTools.has(tool.name);
  });
}
