import type { InternalLogger } from '../../../logging/Logger.js';
import type { PermissionResult } from '../../../types/permissions.js';
import { normalizePermissionEffects } from '../../types/effects.js';
import type { ApprovalLedger } from './ApprovalLedger.js';
import { createAbortedResult } from './results.js';
import {
  addConfirmationReason,
  getConfirmationReason,
  hasToolRequestedConfirmation,
  type PipelineExecutionState,
} from './state.js';

/**
 * Translates a permission-handler decision into pipeline state.
 *
 * Both the path-safety handler (authorization stage) and the configured
 * permission handlers (confirmation stage) go through this single applier, so
 * "allow with updates", "deny" and "ask" mean the same thing at every boundary.
 */
export class PermissionDecisionApplier {
  constructor(
    private readonly ledger: ApprovalLedger,
    private readonly logger: InternalLogger,
  ) {}

  apply(result: PermissionResult, state: PipelineExecutionState): void {
    switch (result.behavior) {
      case 'allow':
        for (const effect of normalizePermissionEffects(result)) {
          if (effect.type === 'permissionUpdates') {
            this.ledger.applyPermissionUpdates(effect.updates);
          }
        }
        if (this.ledger.isApproved(state.invocation?.permissionSignature)) {
          state.needsConfirmation = false;
          state.confirmationReasons = [];
        }
        if (!hasToolRequestedConfirmation(state) && !getConfirmationReason(state)) {
          state.needsConfirmation = false;
        }
        this.logger.debug(`permissionHandler allowed: ${state.toolName}`);
        break;

      case 'deny':
        this.ledger.recordDenial(
          state.invocation?.permissionSignature,
          state.toolName,
          result.message || 'Denied by permissionHandler',
        );
        state.result = createAbortedResult(result.message, {
          shouldExitLoop: result.interrupt,
        });
        break;

      case 'ask':
        state.needsConfirmation = true;
        addConfirmationReason(state, 'handler', result.message);
        break;
    }
  }
}
