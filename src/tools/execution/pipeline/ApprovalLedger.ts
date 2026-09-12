import type { InternalLogger } from '../../../logging/Logger.js';
import type { PermissionUpdate } from '../../../types/permissions.js';
import { DenialTracker } from '../DenialTracker.js';

/**
 * Session-scoped approval memory shared by the authorization and confirmation
 * stages.
 *
 * The ledger is the only writer of session approvals: rules learned from
 * permission effects, remembered "allow for this session" decisions, and
 * denial bookkeeping all land here so both stages observe the same state.
 */
export class ApprovalLedger {
  private readonly sessionApprovals = new Set<string>();
  private readonly denialTracker = new DenialTracker();

  constructor(private readonly logger: InternalLogger) {}

  isApproved(signature: string | undefined): boolean {
    return Boolean(signature && this.sessionApprovals.has(signature));
  }

  approve(signature: string | undefined): void {
    if (signature) {
      this.sessionApprovals.add(signature);
    }
  }

  getDenialTracker(): DenialTracker {
    return this.denialTracker;
  }

  recordDenial(signature: string | undefined, toolName: string, message: string): void {
    if (signature) {
      this.denialTracker.record(signature, toolName, message);
    }
  }

  applyPermissionUpdates(updates: PermissionUpdate[]): void {
    for (const update of updates) {
      switch (update.type) {
        case 'addRules':
          for (const rule of update.rules) {
            const ruleStr = rule.ruleContent
              ? `${rule.toolName}:${rule.ruleContent}`
              : rule.toolName;
            if (update.behavior === 'allow') {
              this.sessionApprovals.add(ruleStr);
            }
            this.logger.debug(`Permission rule added: ${ruleStr} -> ${update.behavior}`);
          }
          break;
        case 'removeRules':
          for (const rule of update.rules) {
            const ruleStr = rule.ruleContent
              ? `${rule.toolName}:${rule.ruleContent}`
              : rule.toolName;
            this.sessionApprovals.delete(ruleStr);
            this.logger.debug(`Permission rule removed: ${ruleStr}`);
          }
          break;
      }
    }
  }
}
