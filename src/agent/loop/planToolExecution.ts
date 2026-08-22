import { PermissionMode, type PermissionMode as PermissionModeValue } from '../../types/common.js';
import type { FunctionToolCall } from './types.js';

export interface ToolExecutionPlan {
  mode: 'parallel' | 'serial';
  calls: FunctionToolCall[];
}

/**
 * Applies turn-level ordering constraints only. Resource concurrency limits
 * are enforced centrally by ConcurrencyScheduler inside ExecutionPipeline.
 */
export function planToolExecution(
  calls: FunctionToolCall[],
  permissionMode?: PermissionModeValue,
): ToolExecutionPlan {
  if (calls.length === 1 || permissionMode === PermissionMode.PLAN) {
    return {
      mode: 'serial',
      calls,
    };
  }

  return {
    mode: 'parallel',
    calls,
  };
}
