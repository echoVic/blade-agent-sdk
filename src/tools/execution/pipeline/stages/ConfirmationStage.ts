import type { InternalLogger } from '../../../../logging/Logger.js';
import type { PermissionMode } from '../../../../types/constants.js';
import type { PermissionRequestId } from '../../../../types/identifiers.js';
import {
  createModePermissionHandler,
  type PermissionHandler,
} from '../../../../types/permissions.js';
import { getErrorMessage } from '../../../../utils/errorUtils.js';
import type { ConfirmationDetails } from '../../../types/execution.js';
import { validationErrorToToolResult } from '../../../types/result.js';
import type { ApprovalLedger } from '../ApprovalLedger.js';
import { extractRisksFromPermissionCheck, generatePreviewForTool } from '../confirmationPreview.js';
import type { InvocationBinder } from '../InvocationBinder.js';
import type { PermissionDecisionApplier } from '../PermissionDecisionApplier.js';
import type { PermissionRequestFactory } from '../PermissionRequestFactory.js';
import { createAbortedResult } from '../results.js';
import { getConfirmationReason, type PipelineExecutionState, samePaths } from '../state.js';
import { isTerminalCleanupFailure, type TerminalCleanupGuard } from '../TerminalCleanupGuard.js';

export interface ConfirmationStageOptions {
  permissionMode: PermissionMode;
  permissionHandler?: PermissionHandler;
}

/**
 * Confirmation stage: the user-facing half of authorization.
 *
 * Configured permission handlers run in order and may rewrite input; the
 * rewritten paths are re-checked against the paths that were authorized, so a
 * handler cannot widen its own authority. Only if confirmation is still pending
 * does the stage fall back to the legacy ConfirmationHandler flow.
 */
export class ConfirmationStage {
  private readonly permissionHandlers: PermissionHandler[];

  constructor(
    private readonly guard: TerminalCleanupGuard,
    private readonly binder: InvocationBinder,
    private readonly requests: PermissionRequestFactory,
    private readonly decisions: PermissionDecisionApplier,
    private readonly ledger: ApprovalLedger,
    private readonly logger: InternalLogger,
    options: ConfirmationStageOptions,
  ) {
    this.permissionHandlers = [
      ...(options.permissionHandler ? [options.permissionHandler] : []),
      createModePermissionHandler(options.permissionMode),
    ];
  }

  async resolve(state: PipelineExecutionState): Promise<void> {
    if (!state.invocation) {
      state.result = createAbortedResult(
        'Pre-confirmation stage failed; cannot request user approval',
      );
      return;
    }

    if (this.permissionHandlers.length > 0) {
      for (const permissionHandler of this.permissionHandlers) {
        const invocation = state.invocation;
        if (!invocation) {
          state.result = createAbortedResult(
            'Pre-confirmation stage failed; cannot request user approval',
          );
          return;
        }
        const previousAffectedPaths = [...invocation.affectedPaths];
        const request = this.requests.build(state);
        const result = await this.guard.awaitPermissionCallback(
          () => permissionHandler(request),
          state.context.signal,
        );
        this.decisions.apply(result, state);
        if (state.result) {
          return;
        }
        try {
          if ((result.behavior === 'allow' || result.behavior === 'ask') && result.updatedInput) {
            this.binder.rebuild(state, {
              ...invocation.params,
              ...result.updatedInput,
            });
            const validationError = await this.binder.revalidate(state);
            if (validationError) {
              state.result = validationErrorToToolResult(validationError);
              return;
            }
          }
          const updatedInvocation = state.invocation;
          if (
            !updatedInvocation ||
            !samePaths(previousAffectedPaths, updatedInvocation.affectedPaths)
          ) {
            state.result = createAbortedResult(
              'Permission handlers cannot change filesystem paths after path authorization',
            );
            return;
          }
          this.requests.sync(request, state);
        } catch (error) {
          state.result = createAbortedResult(
            `Permission handler updated parameters are invalid: ${getErrorMessage(error)}`,
          );
          return;
        }
      }
      if (!state.needsConfirmation) {
        return;
      }
    } else if (!state.needsConfirmation) {
      return;
    }

    await this.requestUserConfirmation(state);
  }

  private async requestUserConfirmation(state: PipelineExecutionState): Promise<void> {
    const invocation = state.invocation;
    if (!invocation) {
      state.result = createAbortedResult(
        'Pre-confirmation stage failed; cannot request user approval',
      );
      return;
    }

    let permissionRequestId: PermissionRequestId | undefined;
    let resolutionAttempted = false;
    try {
      const description = invocation.description;
      const confirmationTitle =
        description && description !== `执行工具: ${state.tool.name}`
          ? `权限确认: ${description}`
          : `权限确认: ${invocation.permissionSignature}`;

      const confirmationDetails: ConfirmationDetails = {
        toolName: state.tool.name,
        args: structuredClone(invocation.params),
        title: confirmationTitle,
        message: getConfirmationReason(state) || '此操作需要用户确认',
        abortSignal: state.context.signal,
        kind: invocation.behavior.kind,
        details: generatePreviewForTool(state.tool.name, invocation.params),
        risks: extractRisksFromPermissionCheck(
          state.tool,
          invocation.params,
          state.permissionCheckResult,
        ),
        affectedFiles: [...invocation.affectedPaths],
      };

      this.logger.warn(`工具 "${state.tool.name}" 需要用户确认: ${confirmationDetails.title}`);

      const confirmationHandler = state.context.confirmationHandler;
      if (confirmationHandler) {
        permissionRequestId = await state.context.toolInvocationLifecycle?.onPermissionRequested?.(
          confirmationDetails,
          structuredClone(invocation.params),
        );
        this.logger.info(`[ExecutionPipeline] Requesting confirmation for ${state.tool.name}`);
        const response = await this.guard.awaitPermissionCallback(
          () =>
            confirmationHandler.requestConfirmation({
              ...confirmationDetails,
              ...(permissionRequestId ? { permissionRequestId } : {}),
            }),
          state.context.signal,
        );
        this.logger.info(
          `[ExecutionPipeline] Confirmation response: approved=${response.approved}`,
        );
        if (permissionRequestId) {
          resolutionAttempted = true;
          await state.context.toolInvocationLifecycle?.onPermissionResolved?.({
            permissionRequestId,
            decision: response.approved ? 'allow' : 'deny',
            ...(response.reason ? { message: response.reason } : {}),
          });
        }

        if (!response.approved) {
          const reason = response.reason || 'User rejected';
          this.ledger.recordDenial(invocation.permissionSignature, state.tool.name, reason);
          state.result = createAbortedResult(`User rejected execution: ${reason}`, {
            shouldExitLoop: true,
          });
          return;
        }

        if ((response.scope || 'once') === 'session') {
          this.ledger.approve(invocation.permissionSignature);
        }
        state.needsConfirmation = false;
      } else {
        this.logger.warn('No ConfirmationHandler; auto-approving tool execution');
        state.needsConfirmation = false;
      }
    } catch (error) {
      let failure = error;
      if (permissionRequestId && !resolutionAttempted) {
        try {
          resolutionAttempted = true;
          await state.context.toolInvocationLifecycle?.onPermissionResolved?.({
            permissionRequestId,
            decision: 'cancel',
            message: getErrorMessage(error),
          });
        } catch (resolutionError) {
          failure = new AggregateError(
            [error, resolutionError],
            'Permission handling and durable resolution both failed',
          );
        }
      }
      if (isTerminalCleanupFailure(failure)) {
        throw failure;
      }
      if (state.context.signal?.aborted) {
        throw failure;
      }
      state.result = createAbortedResult(`User confirmation failed: ${getErrorMessage(failure)}`);
    }
  }
}
