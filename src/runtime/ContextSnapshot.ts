import type { SandboxSettings } from '../sandbox/config.js';
import { type SessionId, TurnId } from '../types/identifiers.js';
import type { JsonObject } from '../types/json.js';
import type { RuntimeContext } from './RuntimeContext.js';

export interface ContextSnapshot {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly context: RuntimeContext;
  readonly filesystemRoots: string[];
  readonly cwd: string | undefined;
  readonly environment: Record<string, string>;
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
          roots:
            overrideCapabilities?.filesystem?.roots ?? baseCapabilities?.filesystem?.roots ?? [],
        }
      : undefined;

  return {
    ...defaultContext,
    ...turnContext,
    capabilities: {
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
    filesystemRoots: [...filesystemRoots],
    cwd: context.capabilities?.filesystem?.cwd,
    environment: { ...(context.environment ?? {}) },
    sandbox: context.capabilities?.sandbox
      ? structuredClone(context.capabilities.sandbox)
      : undefined,
  };
}
