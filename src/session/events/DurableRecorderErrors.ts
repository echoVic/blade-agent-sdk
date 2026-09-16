import { SdkError } from '../../errors/SdkError.js';
import type { DurableSessionRecoveryPlan } from './DurableSessionProjector.js';

export class SessionDurableRecorderError extends SdkError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('DURABLE_SESSION_RECORDER_INVALID_STATE', message, options);
  }
}

export class DurableSessionRecoveryRequiredError extends SdkError {
  readonly recoveryPlan: DurableSessionRecoveryPlan;

  constructor(recoveryPlan: DurableSessionRecoveryPlan) {
    super(
      'DURABLE_SESSION_RECOVERY_REQUIRED',
      `Session recovery requires action: ${recoveryPlan.action}`,
    );
    this.recoveryPlan = structuredClone(recoveryPlan);
  }
}
