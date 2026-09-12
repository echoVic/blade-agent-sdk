import { isSteeringInterruptSignal } from '../../../types/abort.js';
import { ToolErrorType, type ToolResult } from '../../types/result.js';
import { createAbortedResult } from './results.js';

/**
 * Map an abort signal to the canonical cancellation result.
 *
 * A steering interrupt (new user input) is reported as INTERRUPTED so the loop
 * can continue with the new instruction; any other cancellation ends the task.
 */
export function createSignalAbortResult(signal: AbortSignal | undefined): ToolResult {
  const isInterrupt = Boolean(signal && isSteeringInterruptSignal(signal));
  return createAbortedResult(isInterrupt ? '工具执行被新的用户输入中断' : '任务已被用户中止', {
    errorType: isInterrupt ? ToolErrorType.INTERRUPTED : ToolErrorType.EXECUTION_ERROR,
  });
}
