export enum ToolKind {
  ReadOnly = 'readonly',
  Write = 'write',
  Execute = 'execute',
}

export interface ToolBehavior {
  kind: ToolKind;
  isReadOnly: boolean;
  isConcurrencySafe: boolean;
  isDestructive: boolean;
  interruptBehavior: 'cancel' | 'block';
}

export function isReadOnlyKind(kind: ToolKind): boolean {
  return kind === ToolKind.ReadOnly;
}

export function createToolBehavior(
  kind: ToolKind,
  overrides: Partial<ToolBehavior> = {},
): ToolBehavior {
  return {
    kind,
    isReadOnly: overrides.isReadOnly ?? isReadOnlyKind(kind),
    isConcurrencySafe: overrides.isConcurrencySafe ?? isReadOnlyKind(kind),
    isDestructive: overrides.isDestructive ?? false,
    interruptBehavior: overrides.interruptBehavior ?? 'cancel',
  };
}

export function getStaticToolBehavior(tool: {
  kind?: ToolKind;
  isReadOnly?: boolean;
  isConcurrencySafe?: boolean;
  isDestructive?: boolean;
  interruptBehavior?: 'cancel' | 'block';
}): ToolBehavior {
  return createToolBehavior(tool.kind ?? ToolKind.Execute, {
    isReadOnly: tool.isReadOnly,
    isConcurrencySafe: tool.isConcurrencySafe,
    isDestructive: tool.isDestructive,
    interruptBehavior: tool.interruptBehavior,
  });
}

export function resolveToolBehaviorHint(tool: {
  kind?: ToolKind;
  isReadOnly?: boolean;
  isConcurrencySafe?: boolean;
  isDestructive?: boolean;
  interruptBehavior?: 'cancel' | 'block';
  getBehaviorHint?: () => Partial<ToolBehavior> | ToolBehavior;
}): ToolBehavior {
  const staticBehavior = getStaticToolBehavior(tool);
  if (!tool.getBehaviorHint) {
    return staticBehavior;
  }

  return {
    ...staticBehavior,
    ...tool.getBehaviorHint(),
  };
}

export function resolveToolBehavior<TParams>(
  tool: {
    kind?: ToolKind;
    isReadOnly?: boolean;
    isConcurrencySafe?: boolean;
    isDestructive?: boolean;
    interruptBehavior?: 'cancel' | 'block';
    resolveBehavior?: (params: TParams) => Partial<ToolBehavior> | ToolBehavior;
  },
  params: TParams,
): ToolBehavior {
  const staticBehavior = getStaticToolBehavior(tool);
  if (!tool.resolveBehavior) {
    return staticBehavior;
  }

  return {
    ...staticBehavior,
    ...tool.resolveBehavior(params),
  };
}

export function resolveToolBehaviorSafely<TParams>(
  tool:
    | {
        kind?: ToolKind;
        isReadOnly?: boolean;
        isConcurrencySafe?: boolean;
        isDestructive?: boolean;
        interruptBehavior?: 'cancel' | 'block';
        resolveBehavior?: (params: TParams) => Partial<ToolBehavior> | ToolBehavior;
      }
    | undefined,
  params: TParams,
): ToolBehavior | undefined {
  if (!tool) {
    return undefined;
  }

  try {
    return resolveToolBehavior(tool, params);
  } catch {
    return getStaticToolBehavior(tool);
  }
}
