import type { JsonObject } from '@blade-ai/ai';

export const ToolKind = {
  ReadOnly: 'readonly',
  Write: 'write',
  Execute: 'execute',
} as const;

export type ToolKind = (typeof ToolKind)[keyof typeof ToolKind];

export type ToolInterruptBehavior = 'cancel' | 'block';

export interface ToolBehavior {
  kind: ToolKind;
  isReadOnly: boolean;
  isConcurrencySafe: boolean;
  isDestructive: boolean;
  interruptBehavior: ToolInterruptBehavior;
}

export type ToolExecutionRegistryEntry = {
  kind?: ToolKind | string;
  isReadOnly?: boolean;
  isConcurrencySafe?: boolean;
  isDestructive?: boolean;
  interruptBehavior?: ToolInterruptBehavior;
  resolveBehavior?: (params: JsonObject) => Partial<ToolBehavior> | ToolBehavior;
};

export type ToolExecutionRegistryLike = {
  get(name: string): ToolExecutionRegistryEntry | undefined;
};

export function resolveToolBehaviorSafely(
  tool: ToolExecutionRegistryEntry | undefined,
  params: JsonObject,
): ToolBehavior | undefined {
  if (!tool) {
    return undefined;
  }

  const staticBehavior = getStaticToolBehavior(tool);
  if (!tool.resolveBehavior) {
    return staticBehavior;
  }

  try {
    return {
      ...staticBehavior,
      ...tool.resolveBehavior(params),
    };
  } catch {
    return staticBehavior;
  }
}

function getStaticToolBehavior(tool: ToolExecutionRegistryEntry): ToolBehavior {
  return createToolBehavior(tool.kind, {
    isReadOnly: tool.isReadOnly,
    isConcurrencySafe: tool.isConcurrencySafe,
    isDestructive: tool.isDestructive,
    interruptBehavior: tool.interruptBehavior,
  });
}

function createToolBehavior(
  kind: ToolKind | string | undefined,
  overrides: Partial<ToolBehavior> = {},
): ToolBehavior {
  const resolvedKind = isToolKind(kind) ? kind : ToolKind.Execute;
  return {
    kind: resolvedKind,
    isReadOnly: overrides.isReadOnly ?? isReadOnlyKind(resolvedKind),
    isConcurrencySafe: overrides.isConcurrencySafe ?? isReadOnlyKind(resolvedKind),
    isDestructive: overrides.isDestructive ?? false,
    interruptBehavior: overrides.interruptBehavior ?? 'cancel',
  };
}

function isReadOnlyKind(kind: ToolKind | string | undefined): boolean {
  return kind === ToolKind.ReadOnly;
}

function isToolKind(kind: ToolKind | string | undefined): kind is ToolKind {
  return kind === ToolKind.ReadOnly || kind === ToolKind.Write || kind === ToolKind.Execute;
}
