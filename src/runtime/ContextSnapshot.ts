import type { SandboxSettings } from '../sandbox/config.js';
import { type SessionId, TurnId } from '../types/identifiers.js';
import type { JsonObject } from '../types/json.js';
import type { RuntimeContext } from './RuntimeContext.js';

export interface ContextSnapshot {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly context: RuntimeContext;
  readonly filesystemRoots: string[];
  /**
   * Convenience accessor derived from context.capabilities.filesystem.cwd.
   */
  readonly cwd: string | undefined;
  readonly environment: Record<string, string>;
  /**
   * Effective sandbox policy for this turn, or undefined when the Session declares
   * none. Tools read this instead of a process-wide setting.
   */
  readonly sandbox?: SandboxSettings;
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

function mergeUnknownRecords(base?: JsonObject, override?: JsonObject): JsonObject | undefined {
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
            overrideCapabilities?.filesystem?.roots ?? baseCapabilities?.filesystem?.roots ?? [],
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
    environment: mergeStringRecords(defaultContext.environment, turnContext?.environment),
    metadata: mergeUnknownRecords(defaultContext.metadata, turnContext?.metadata),
  };
}

export function createContextSnapshot(
  sessionId: SessionId,
  turnId: TurnId | string,
  defaultContext: RuntimeContext = {},
  turnContext?: RuntimeContext,
): ContextSnapshot {
  const context = mergeContext(defaultContext, turnContext);
  const filesystemRoots = context.capabilities?.filesystem?.roots ?? [];
  return {
    sessionId,
    turnId: TurnId(turnId),
    context,
    // Copies, never references: a caller that mutates its configuration array must
    // not retroactively change a snapshot that was already handed to a tool.
    filesystemRoots: [...filesystemRoots],
    cwd: context.capabilities?.filesystem?.cwd,
    environment: { ...(context.environment ?? {}) },
    sandbox: snapshotSandboxSettings(context.capabilities?.sandbox),
  };
}

/**
 * Sandbox policy is copied deeply enough that later mutation of the source object
 * (or its arrays) cannot change an existing snapshot's behaviour.
 */
function snapshotSandboxSettings(settings?: SandboxSettings): SandboxSettings | undefined {
  if (!settings) {
    return undefined;
  }
  return {
    ...settings,
    ...(settings.excludedCommands ? { excludedCommands: [...settings.excludedCommands] } : {}),
    ...(settings.ignoreViolations
      ? {
          ignoreViolations: {
            ...(settings.ignoreViolations.file
              ? { file: [...settings.ignoreViolations.file] }
              : {}),
            ...(settings.ignoreViolations.network
              ? { network: [...settings.ignoreViolations.network] }
              : {}),
          },
        }
      : {}),
    ...(settings.network
      ? {
          network: {
            ...settings.network,
            ...(settings.network.allowUnixSockets
              ? { allowUnixSockets: [...settings.network.allowUnixSockets] }
              : {}),
          },
        }
      : {}),
  };
}
