import type { JsonObject } from '../../types/common.js';
import { PermissionMode, type PermissionMode as PermissionModeValue } from '../../types/common.js';
import {
  resolveToolBehaviorSafely,
  type ToolBehavior,
} from '../../tools/types/ToolTypes.js';
import type { FunctionToolCall } from './types.js';

type ToolRegistryLike = {
  get(
    name: string
  ):
    | {
        kind?: string;
        isReadOnly?: boolean;
        isConcurrencySafe?: boolean;
        isDestructive?: boolean;
        resolveBehavior?: (params: JsonObject) => ToolBehavior;
      }
    | undefined;
};

export interface ToolExecutionPlan {
  mode: 'parallel' | 'serial' | 'mixed';
  calls: FunctionToolCall[];
  groups?: FunctionToolCall[][];
}

export function planToolExecution(
  calls: FunctionToolCall[],
  registry: ToolRegistryLike,
  permissionMode?: PermissionModeValue,
): ToolExecutionPlan {
  if (calls.length === 1 || permissionMode === PermissionMode.PLAN) {
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

  const readonlyCalls: FunctionToolCall[] = [];
  const nonReadonlyCalls: FunctionToolCall[] = [];

  for (const call of calls) {
    const tool = registry.get(call.function.name);
    const parsedArgs = parseToolArguments(call.function.arguments);
    const behavior = parsedArgs
      ? resolveToolBehaviorSafely(tool as Parameters<typeof resolveToolBehaviorSafely>[0], parsedArgs)
      : undefined;

    if (
      (behavior?.isReadOnly && behavior.isConcurrencySafe) ||
      (!behavior && tool?.kind === 'readonly' && tool?.isConcurrencySafe !== false)
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

  const groups: FunctionToolCall[][] = [
    readonlyCalls,
    ...nonReadonlyCalls.map((call) => [call]),
  ];

  return {
    mode: 'mixed',
    calls: [...readonlyCalls, ...nonReadonlyCalls],
    groups,
  };
}

function parseToolArguments(argumentsText: string): JsonObject | undefined {
  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as JsonObject
      : undefined;
  } catch {
    return undefined;
  }
}
