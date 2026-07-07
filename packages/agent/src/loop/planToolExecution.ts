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

export interface AgentFunctionToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export type ToolExecutionPermissionMode = 'default' | 'autoEdit' | 'yolo' | 'plan';

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

export interface ToolExecutionPlan {
  mode: 'parallel' | 'serial' | 'mixed';
  calls: AgentFunctionToolCall[];
  groups?: AgentFunctionToolCall[][];
}

export function planToolExecution(
  calls: AgentFunctionToolCall[],
  registry: ToolExecutionRegistryLike,
  permissionMode?: ToolExecutionPermissionMode,
): ToolExecutionPlan {
  if (calls.length === 1 || permissionMode === 'plan') {
    return {
      mode: 'serial',
      calls,
    };
  }

  if (calls.length === 0) {
    return {
      mode: 'parallel',
      calls,
    };
  }

  const readonlyCalls: AgentFunctionToolCall[] = [];
  const nonReadonlyCalls: AgentFunctionToolCall[] = [];

  for (const call of calls) {
    const tool = registry.get(call.function.name);
    const parsedArgs = parseToolArguments(call.function.arguments);
    const behavior = parsedArgs ? resolveToolBehaviorSafely(tool, parsedArgs) : undefined;

    if (
      (behavior?.isReadOnly && behavior.isConcurrencySafe) ||
      (!behavior && tool?.kind === ToolKind.ReadOnly && tool?.isConcurrencySafe !== false)
    ) {
      readonlyCalls.push(call);
      continue;
    }

    nonReadonlyCalls.push(call);
  }

  if (nonReadonlyCalls.length === 0) {
    return {
      mode: 'parallel',
      calls,
    };
  }

  if (readonlyCalls.length === 0) {
    return {
      mode: 'serial',
      calls,
    };
  }

  const groups: AgentFunctionToolCall[][] = [
    readonlyCalls,
    ...nonReadonlyCalls.map((call) => [call]),
  ];

  return {
    mode: 'mixed',
    calls: [...readonlyCalls, ...nonReadonlyCalls],
    groups,
  };
}

function isReadOnlyKind(kind: ToolKind | string | undefined): boolean {
  return kind === ToolKind.ReadOnly;
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

function getStaticToolBehavior(tool: ToolExecutionRegistryEntry): ToolBehavior {
  return createToolBehavior(tool.kind, {
    isReadOnly: tool.isReadOnly,
    isConcurrencySafe: tool.isConcurrencySafe,
    isDestructive: tool.isDestructive,
    interruptBehavior: tool.interruptBehavior,
  });
}

function resolveToolBehaviorSafely(
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

function isToolKind(kind: ToolKind | string | undefined): kind is ToolKind {
  return kind === ToolKind.ReadOnly || kind === ToolKind.Write || kind === ToolKind.Execute;
}

function parseToolArguments(argumentsText: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : undefined;
  } catch {
    return undefined;
  }
}
