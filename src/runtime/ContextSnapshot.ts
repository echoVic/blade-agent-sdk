import type { SessionId } from '../types/branded.js';
import type { JsonObject } from '../types/common.js';
import type { RuntimeContext } from './RuntimeContext.js';

export interface ContextSnapshot {
  readonly sessionId: SessionId;
  readonly turnId: string;
  readonly context: RuntimeContext;
  readonly filesystemRoots: string[];
  /**
   * Convenience accessor derived from context.capabilities.filesystem.cwd.
   */
  readonly cwd: string | undefined;
  readonly environment: Record<string, string>;
}

export function hasFilesystemCapability(snapshot?: ContextSnapshot): boolean {
  return (snapshot?.filesystemRoots.length ?? 0) > 0;
}

function mergeStringRecords(
  base?: Record<string, string>,
  override?: Record<string, string>,
): Record<string, string> | undefined {
  if (!base && !override) {
    return undefined;
  }
  return {
    ...(base ?? {}),
    ...(override ?? {}),
  };
}

function mergeUnknownRecords(
  base?: JsonObject,
  override?: JsonObject,
): JsonObject | undefined {
  if (!base && !override) {
    return undefined;
  }
  return {
    ...(base ?? {}),
    ...(override ?? {}),
  };
}

export function mergeContext(
  defaultContext: RuntimeContext = {},
  turnContext?: RuntimeContext,
): RuntimeContext {
  const baseCapabilities = defaultContext.capabilities;
  const overrideCapabilities = turnContext?.capabilities;

  const filesystem =
    baseCapabilities?.filesystem || overrideCapabilities?.filesystem
      ? {
          ...(baseCapabilities?.filesystem ?? {}),
          ...(overrideCapabilities?.filesystem ?? {}),
          // Turn-scoped filesystem roots are intentionally replace-only.
          // This keeps the current turn's accessible roots explicit rather than additive.
          roots:
            overrideCapabilities?.filesystem?.roots
            ?? baseCapabilities?.filesystem?.roots
            ?? [],
        }
      : undefined;

  return {
    ...defaultContext,
    ...turnContext,
    capabilities: {
      // Non-filesystem facets currently use shallow whole-facet override.
      // Omitting a facet in turnContext preserves the default facet, while
      // providing the same facet replaces its object as a unit.
      ...(baseCapabilities ?? {}),
      ...(overrideCapabilities ?? {}),
      ...(filesystem ? { filesystem } : {}),
    },
    environment: mergeStringRecords(
      defaultContext.environment,
      turnContext?.environment,
    ),
    metadata: mergeUnknownRecords(
      defaultContext.metadata,
      turnContext?.metadata,
    ),
  };
}

export function createContextSnapshot(
  sessionId: SessionId,
  turnId: string,
  defaultContext: RuntimeContext = {},
  turnContext?: RuntimeContext,
): ContextSnapshot {
  const context = mergeContext(defaultContext, turnContext);
  const filesystemRoots = context.capabilities?.filesystem?.roots ?? [];
  return {
    sessionId,
    turnId,
    context,
    filesystemRoots,
    cwd: context.capabilities?.filesystem?.cwd,
    environment: context.environment ?? {},
  };
}
