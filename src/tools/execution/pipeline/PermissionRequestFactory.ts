import type { PermissionMode } from '../../../types/constants.js';
import type { PermissionHandlerRequest } from '../../../types/permissions.js';
import type { ToolInvocation } from '../../core/ToolInvocation.js';
import type { ApprovalLedger } from './ApprovalLedger.js';
import type { PipelineExecutionState } from './state.js';

/**
 * Builds the request object handed to permission handlers.
 *
 * Handlers may mutate parameters while approving, so the same factory also
 * refreshes an existing request after the invocation has been rebuilt: the
 * handler always sees the paths, kind and metadata that were actually verified.
 */
export class PermissionRequestFactory {
  constructor(
    private readonly defaultPermissionMode: PermissionMode,
    private readonly ledger: ApprovalLedger,
  ) {}

  build(state: PipelineExecutionState): PermissionHandlerRequest {
    const invocation = requireInvocation(state);
    return {
      toolName: state.toolName,
      input: invocation.params,
      signal: state.context.signal || new AbortController().signal,
      permissionMode: state.context.permissionMode || this.defaultPermissionMode,
      sessionApproved: this.ledger.isApproved(invocation.permissionSignature),
      affectedPaths: [...invocation.affectedPaths],
      toolKind: invocation.behavior.kind,
      toolMeta: this.buildToolMeta(invocation),
    };
  }

  sync(request: PermissionHandlerRequest, state: PipelineExecutionState): void {
    const invocation = requireInvocation(state);
    request.input = invocation.params;
    request.affectedPaths = [...invocation.affectedPaths];
    request.toolKind = invocation.behavior.kind;
    request.toolMeta = this.buildToolMeta(invocation);
  }

  private buildToolMeta(invocation: ToolInvocation): PermissionHandlerRequest['toolMeta'] {
    return {
      sideEffect: invocation.behavior.sideEffect,
      isReadOnly: invocation.behavior.isReadOnly,
      isConcurrencySafe: invocation.behavior.isConcurrencySafe,
      isDestructive: invocation.behavior.isDestructive,
      signature: invocation.permissionSignature,
      description: invocation.description,
    };
  }
}

function requireInvocation(state: PipelineExecutionState): ToolInvocation {
  if (!state.invocation) {
    throw new Error(`Tool invocation '${state.toolName}' has not been prepared`);
  }
  return state.invocation;
}
