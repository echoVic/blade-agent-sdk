import type { ModelToolCall } from '../../model/message.js';
import type { PermissionMode as PermissionModeValue } from '../../types/constants.js';
import { PermissionMode } from '../../types/constants.js';

export interface ToolExecutionPlan {
  mode: 'parallel' | 'serial';
  calls: ModelToolCall[];
}

/**
 * Applies turn-level ordering constraints only. Resource concurrency limits
 * are enforced centrally by ConcurrencyScheduler inside ExecutionPipeline.
 */
export function planToolExecution(
  calls: ModelToolCall[],
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
