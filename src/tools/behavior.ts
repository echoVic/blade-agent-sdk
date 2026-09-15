export const ToolKind = {
  ReadOnly: 'readonly',
  Write: 'write',
  Execute: 'execute',
} as const;

export type ToolKind = (typeof ToolKind)[keyof typeof ToolKind];

export const ToolSideEffect = {
  PURE: 'pure',
  IDEMPOTENT: 'idempotent',
  NON_IDEMPOTENT: 'non_idempotent',
} as const;

export type ToolSideEffect = (typeof ToolSideEffect)[keyof typeof ToolSideEffect];

export interface ToolBehavior {
  kind: ToolKind;
  sideEffect: ToolSideEffect;
  isReadOnly: boolean;
  isConcurrencySafe: boolean;
  isDestructive: boolean;
  interruptBehavior: 'cancel' | 'block';
}

export interface ToolBehaviorSource<TParams = unknown> {
  kind?: ToolKind;
  sideEffect?: ToolSideEffect;
  isReadOnly?: boolean;
  isConcurrencySafe?: boolean;
  isDestructive?: boolean;
  interruptBehavior?: 'cancel' | 'block';
  resolveBehavior?: (params?: TParams) => Partial<ToolBehavior> | ToolBehavior;
}

interface PreparedToolBehaviorSource<TParams = unknown> {
  readonly staticBehavior: ToolBehavior;
  prepare(params: TParams): { readonly behavior: ToolBehavior };
}

export function isToolSideEffect(value: unknown): value is ToolSideEffect {
  return (
    value === ToolSideEffect.PURE ||
    value === ToolSideEffect.IDEMPOTENT ||
    value === ToolSideEffect.NON_IDEMPOTENT
  );
}

/**
 * Resolves the behavior used to plan or execute a tool call.
 *
 * Without params, the callback returns the planning-time behavior. With params,
 * it returns invocation-specific behavior. Callback failures fall back to the
 * static declaration because callers may use unvalidated model input.
 */
export function resolveBehavior<TParams>(
  source: ToolBehaviorSource<TParams> | PreparedToolBehaviorSource<TParams>,
  params?: TParams,
): ToolBehavior;
export function resolveBehavior<TParams>(
  source: ToolBehaviorSource<TParams> | PreparedToolBehaviorSource<TParams> | undefined,
  params?: TParams,
): ToolBehavior | undefined;
export function resolveBehavior<TParams>(
  source: ToolBehaviorSource<TParams> | PreparedToolBehaviorSource<TParams> | undefined,
  params?: TParams,
): ToolBehavior | undefined {
  if (!source) {
    return undefined;
  }
  if ('staticBehavior' in source) {
    if (params === undefined) {
      return source.staticBehavior;
    }
    try {
      return source.prepare(params).behavior;
    } catch {
      return source.staticBehavior;
    }
  }

  let resolved: Partial<ToolBehavior> = {};
  try {
    const candidate = source.resolveBehavior?.(params) ?? {};
    if (candidate.sideEffect !== undefined && !isToolSideEffect(candidate.sideEffect)) {
      throw new TypeError('Resolved tool sideEffect is invalid');
    }
    resolved = candidate;
  } catch {
    // Planning and interruption checks must remain fail-closed on invalid input.
  }

  const kind = resolved.kind ?? source.kind ?? ToolKind.Execute;
  const sideEffect = resolved.sideEffect ?? source.sideEffect ?? ToolSideEffect.NON_IDEMPOTENT;
  if (!isToolSideEffect(sideEffect)) {
    throw new TypeError('Tool sideEffect must be pure, idempotent, or non_idempotent');
  }

  return {
    kind,
    sideEffect,
    isReadOnly: resolved.isReadOnly ?? source.isReadOnly ?? kind === ToolKind.ReadOnly,
    isConcurrencySafe:
      resolved.isConcurrencySafe ?? source.isConcurrencySafe ?? kind === ToolKind.ReadOnly,
    isDestructive: resolved.isDestructive ?? source.isDestructive ?? false,
    interruptBehavior: resolved.interruptBehavior ?? source.interruptBehavior ?? 'block',
  };
}
