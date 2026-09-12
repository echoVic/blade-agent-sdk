import type { PermissionMode } from '../../../types/constants.js';
import type { PermissionHandlerRequest } from '../../../types/permissions.js';
import { isReadOnlyKind, ToolKind } from '../../types/kind.js';
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

  build(state: PipelineExecutionState, affectedPaths: string[]): PermissionHandlerRequest {
    const resolvedBehavior = state.resolvedBehavior;
    const toolKind = resolvedBehavior?.kind ?? state.tool.kind ?? ToolKind.Execute;
    const invocationDescription = state.invocation?.getDescription();

    return {
      toolName: state.toolName,
      input: state.params,
      signal: state.context.signal || new AbortController().signal,
      permissionMode: state.context.permissionMode || this.defaultPermissionMode,
      sessionApproved: this.ledger.isApproved(state.permissionSignature),
      affectedPaths,
      toolKind,
      toolMeta: this.buildToolMeta(state, toolKind, invocationDescription),
    };
  }

  sync(request: PermissionHandlerRequest, state: PipelineExecutionState): void {
    const resolvedBehavior = state.resolvedBehavior;
    const toolKind = resolvedBehavior?.kind ?? state.tool.kind ?? ToolKind.Execute;
    request.input = state.params;
    request.affectedPaths = state.affectedPaths;
    request.toolKind = toolKind;
    request.toolMeta = this.buildToolMeta(state, toolKind, state.invocation?.getDescription());
  }

  private buildToolMeta(
    state: PipelineExecutionState,
    toolKind: ToolKind,
    description: string | undefined,
  ): PermissionHandlerRequest['toolMeta'] {
    const resolvedBehavior = state.resolvedBehavior;
    return {
      sideEffect: resolvedBehavior?.sideEffect ?? state.tool.sideEffect,
      isReadOnly: resolvedBehavior?.isReadOnly ?? isReadOnlyKind(toolKind),
      isConcurrencySafe: resolvedBehavior?.isConcurrencySafe ?? isReadOnlyKind(toolKind),
      isDestructive: resolvedBehavior?.isDestructive ?? false,
      signature: state.permissionSignature,
      description,
    };
  }
}
