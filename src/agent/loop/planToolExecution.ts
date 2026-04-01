import { PermissionMode, type PermissionMode as PermissionModeValue } from '../../types/common.js';
import type { FunctionToolCall } from './types.js';

type ToolRegistryLike = {
  get(name: string): { kind?: string } | undefined;
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
    if (registry.get(call.function.name)?.kind === 'readonly') {
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
