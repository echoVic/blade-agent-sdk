import { getAbortSignalReason } from '../../../../utils/abortPromise.js';
import { getErrorMessage } from '../../../../utils/errorUtils.js';
import type { PermissionMode } from '../../../../types/constants.js';
import {
  createPathSafetyPermissionHandler,
  createRuleBasedPermissionHandler,
  type PermissionHandler,
  type PermissionsConfig,
} from '../../../../types/permissions.js';
import { validationErrorToToolResult } from '../../../types/result.js';
import type { ApprovalLedger } from '../ApprovalLedger.js';
import type { InvocationBinder } from '../InvocationBinder.js';
import type { PermissionDecisionApplier } from '../PermissionDecisionApplier.js';
import type { PermissionRequestFactory } from '../PermissionRequestFactory.js';
import { createAbortedResult } from '../results.js';
import { addConfirmationReason, type PipelineExecutionState } from '../state.js';
import { isTerminalCleanupFailure, type TerminalCleanupGuard } from '../TerminalCleanupGuard.js';
import { getToolContext } from '../toolContext.js';

export interface AuthorizationStageOptions {
  permissionConfig: PermissionsConfig;
  defaultPermissionMode: PermissionMode;
}

/**
 * Authorization stage: input validation, tool-level permission checks, rule
 * matching and path safety.
 *
 * The tool's own `checkPermissions` runs first and outranks rule-based policy;
 * if it rewrites the input, the rewritten invocation is re-validated before any
 * rule or path decision is made. The stage never asks the user: it only decides
 * whether the execution may continue and whether confirmation is still needed.
 */
export class AuthorizationStage {
  private readonly ruleHandler: PermissionHandler;
  private readonly pathSafetyHandler: PermissionHandler;

  constructor(
    private readonly guard: TerminalCleanupGuard,
    private readonly binder: InvocationBinder,
    private readonly requests: PermissionRequestFactory,
    private readonly decisions: PermissionDecisionApplier,
    private readonly ledger: ApprovalLedger,
    options: AuthorizationStageOptions,
  ) {
    this.ruleHandler = createRuleBasedPermissionHandler(options.permissionConfig);
    this.pathSafetyHandler = createPathSafetyPermissionHandler({
      explicitAllowRules: options.permissionConfig.allow,
    });
  }

  async authorize(state: PipelineExecutionState): Promise<void> {
    try {
      this.binder.rebuild(state);
      const toolContext = getToolContext(state.tool, state.context, state.services);

      const validationError = await this.binder.revalidate(state);
      if (validationError) {
        state.result = validationErrorToToolResult(validationError);
        return;
      }
      const invocation = state.invocation;
      if (!invocation) {
        throw new Error(`Failed to prepare invocation for tool: ${state.tool.name}`);
      }

      const toolPermissionResult = state.tool.checkPermissions
        ? await this.guard.awaitPermissionCallback(
            () => state.tool.checkPermissions?.(invocation.params, toolContext),
            state.context.signal,
          )
        : undefined;
      const toolPermissionUpdatedInput =
        toolPermissionResult?.behavior === 'allow' ? toolPermissionResult.updatedInput : undefined;

      if (toolPermissionUpdatedInput) {
        this.binder.rebuild(state, {
          ...invocation.params,
          ...toolPermissionUpdatedInput,
        });
        const updatedValidationError = await this.binder.revalidate(state);
        if (updatedValidationError) {
          state.result = validationErrorToToolResult(updatedValidationError);
          return;
        }
      }

      if (toolPermissionResult?.behavior === 'deny') {
        state.result = createAbortedResult(toolPermissionResult.message, {
          shouldExitLoop: toolPermissionResult.interrupt,
        });
        return;
      }

      if (toolPermissionResult?.behavior === 'ask') {
        state.needsConfirmation = true;
        addConfirmationReason(state, 'tool', toolPermissionResult.message);
      }

      // The binder keeps `permissionSignature` in step with the rebuilt invocation.
      let checkResult = await this.guard.awaitPermissionCallback(
        () => this.ruleHandler(this.requests.build(state)),
        state.context.signal,
      );

      const hasRememberedApproval = this.ledger.isApproved(state.invocation?.permissionSignature);
      if (hasRememberedApproval) {
        state.needsConfirmation = false;
        checkResult = {
          behavior: 'allow',
        };
      }

      state.permissionCheckResult = {
        reason: hasRememberedApproval
          ? 'User already allowed this operation in this session'
          : checkResult.behavior === 'allow'
            ? undefined
            : checkResult.message,
      };

      switch (checkResult.behavior) {
        case 'deny':
          state.result = createAbortedResult(
            checkResult.message ||
              `Tool invocation "${state.tool.name}" was denied by permission rules`,
          );
          return;
        case 'ask':
          if (this.ledger.isApproved(state.invocation?.permissionSignature)) {
            state.needsConfirmation = false;
          } else {
            state.needsConfirmation = true;
            addConfirmationReason(state, 'rule', checkResult.message);
          }
          break;
        case 'allow':
          break;
      }

      const pathSafetyResult = await this.guard.awaitPermissionCallback(
        () => this.pathSafetyHandler(this.requests.build(state)),
        state.context.signal,
      );
      this.decisions.apply(pathSafetyResult, state);
    } catch (error) {
      if (isTerminalCleanupFailure(error)) {
        throw error;
      }
      if (state.context.signal?.aborted) {
        throw getAbortSignalReason(state.context.signal);
      }
      state.result = createAbortedResult(`Permission check failed: ${getErrorMessage(error)}`);
    }
  }
}
