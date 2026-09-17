import type { JsonObject } from '../../../types/json.js';
import type { ToolInvocation } from '../../core/ToolInvocation.js';
import type { ToolValidationError } from '../../types/result.js';
import type { PipelineExecutionState } from './state.js';
import type { TerminalCleanupGuard } from './TerminalCleanupGuard.js';
import { getToolContext } from './toolContext.js';

/**
 * Keeps `state` in sync with the tool's invocation object.
 *
 * Rebuilding an invocation may rewrite parameters (schema defaults,
 * permission-handler updates), so the resolved behavior, affected paths and
 * permission signature must be recomputed together. Every stage that mutates
 * parameters goes through this binder rather than editing the state directly.
 */
export class InvocationBinder {
  constructor(private readonly guard: TerminalCleanupGuard) {}

  rebuild(state: PipelineExecutionState, input: JsonObject = state.params): ToolInvocation {
    const invocation = state.tool.prepare(input);
    state.invocation = invocation;
    state.params = invocation.params;
    return invocation;
  }

  /**
   * Runs semantic validation on a mutable clone, then prepares a fresh frozen
   * invocation so normalizers cannot mutate an existing snapshot.
   */
  async revalidate(state: PipelineExecutionState): Promise<ToolValidationError | undefined> {
    const invocation = state.invocation;
    if (!invocation || !state.tool.validate) {
      return undefined;
    }
    const toolContext = getToolContext(state.tool, state.context, state.services);
    const outcome = await this.guard.awaitPermissionCallback(
      () => state.tool.validate?.(invocation.params, toolContext),
      state.context.signal,
    );
    if (!outcome) {
      return undefined;
    }
    if (outcome.error) {
      return outcome.error;
    }
    this.rebuild(state, outcome.params);
    return undefined;
  }
}
