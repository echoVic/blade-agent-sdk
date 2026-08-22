export enum ToolKind {
  ReadOnly = 'readonly',
  Write = 'write',
  Execute = 'execute',
}

export const ToolSideEffect = {
  PURE: 'pure',
  IDEMPOTENT: 'idempotent',
  NON_IDEMPOTENT: 'non_idempotent',
} as const;

export type ToolSideEffect = (typeof ToolSideEffect)[keyof typeof ToolSideEffect];

export function isToolSideEffect(value: unknown): value is ToolSideEffect {
  return Object.values(ToolSideEffect).includes(value as ToolSideEffect);
}

export interface ToolBehavior {
  kind: ToolKind;
  sideEffect: ToolSideEffect;
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
  sideEffect: ToolSideEffect,
  overrides: Partial<ToolBehavior> = {},
): ToolBehavior {
  if (!isToolSideEffect(sideEffect)) {
    throw new TypeError(
      'Tool sideEffect must be pure, idempotent, or non_idempotent',
    );
  }
  return {
    kind,
    sideEffect,
    isReadOnly: overrides.isReadOnly ?? isReadOnlyKind(kind),
    isConcurrencySafe: overrides.isConcurrencySafe ?? isReadOnlyKind(kind),
    isDestructive: overrides.isDestructive ?? false,
    interruptBehavior: overrides.interruptBehavior ?? 'block',
  };
}

export function getStaticToolBehavior(tool: {
  kind?: ToolKind;
  sideEffect?: ToolSideEffect;
  isReadOnly?: boolean;
  isConcurrencySafe?: boolean;
  isDestructive?: boolean;
  interruptBehavior?: 'cancel' | 'block';
}): ToolBehavior {
  return createToolBehavior(
    tool.kind ?? ToolKind.Execute,
    tool.sideEffect ?? ToolSideEffect.NON_IDEMPOTENT,
    {
      isReadOnly: tool.isReadOnly,
      isConcurrencySafe: tool.isConcurrencySafe,
      isDestructive: tool.isDestructive,
      interruptBehavior: tool.interruptBehavior,
    },
  );
}

export function resolveToolBehaviorHint(tool: {
  kind?: ToolKind;
  sideEffect?: ToolSideEffect;
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

  const behavior = {
    ...staticBehavior,
    ...tool.getBehaviorHint(),
  };
  if (!isToolSideEffect(behavior.sideEffect)) {
    throw new TypeError(
      'Resolved tool sideEffect must be pure, idempotent, or non_idempotent',
    );
  }
  return behavior;
}

export function resolveToolBehavior<TParams>(
  tool: {
    kind?: ToolKind;
    sideEffect?: ToolSideEffect;
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

  const behavior = {
    ...staticBehavior,
    ...tool.resolveBehavior(params),
  };
  if (!isToolSideEffect(behavior.sideEffect)) {
    throw new TypeError(
      'Resolved tool sideEffect must be pure, idempotent, or non_idempotent',
    );
  }
  return behavior;
}

export function resolveToolBehaviorSafely<TParams>(
  tool:
    | {
        kind?: ToolKind;
        sideEffect?: ToolSideEffect;
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
