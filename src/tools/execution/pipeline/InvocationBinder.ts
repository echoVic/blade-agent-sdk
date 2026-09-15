import { resolveBehavior } from '../../behavior.js';
import type { ToolInvocation } from '../../types/tool.js';
import type { PipelineExecutionState } from './state.js';
import { buildPermissionSignature, toParamsRecord } from './state.js';
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

  rebuild(state: PipelineExecutionState): ToolInvocation {
    const invocation = state.tool.build(state.params);
    state.invocation = invocation;
    this.sync(state, invocation);
    return invocation;
  }

  sync(state: PipelineExecutionState, invocation: ToolInvocation): void {
    state.params = toParamsRecord(invocation.params, state.params);
    state.resolvedBehavior = resolveBehavior(state.tool, invocation.params);
    state.affectedPaths = invocation.getAffectedPaths() || [];
    state.permissionSignature = buildPermissionSignature(
      state.tool.name,
      toParamsRecord(invocation.params, state.params),
      state.tool,
    );
  }

  /**
   * Re-run validation against the current invocation. A rejected validation
   * leaves the previous state untouched so callers can report the error.
   */
  async revalidate(
    state: PipelineExecutionState,
  ): Promise<Awaited<ReturnType<NonNullable<ToolInvocation['validate']>>>> {
    const invocation = state.invocation;
    if (!invocation?.validate) {
      return undefined;
    }
    const toolContext = getToolContext(state.tool, state.context);
    const validationError = await this.guard.awaitPermissionCallback(
      () => invocation.validate?.(toolContext),
      state.context.signal,
    );
    if (!validationError) {
      this.sync(state, invocation);
    }
    return validationError;
  }
}
