import type { InputId, RequestId } from '../types/branded.js';

export type RequestAbortReason =
  | { kind: 'user_abort' }
  | { kind: 'session_close' }
  | { kind: 'external_abort'; cause?: unknown };

export interface SteeringInterruptReason {
  kind: 'steering';
  inputId: InputId;
}

export class ActiveRequestController {
  private readonly requestController = new AbortController();
  private stepController = new AbortController();
  private externalSignalCleanup?: () => void;

  constructor(
    readonly requestId: RequestId,
    externalSignal?: AbortSignal,
  ) {
    if (!externalSignal) {
      return;
    }

    if (externalSignal.aborted) {
      this.abortRequest({
        kind: 'external_abort',
        cause: externalSignal.reason,
      });
      return;
    }

    const handleExternalAbort = () => {
      this.abortRequest({
        kind: 'external_abort',
        cause: externalSignal.reason,
      });
    };
    externalSignal.addEventListener('abort', handleExternalAbort, { once: true });
    this.externalSignalCleanup = () => {
      externalSignal.removeEventListener('abort', handleExternalAbort);
    };
  }

  get requestSignal(): AbortSignal {
    return this.requestController.signal;
  }

  get stepSignal(): AbortSignal {
    return AbortSignal.any([
      this.requestController.signal,
      this.stepController.signal,
    ]);
  }

  abortRequest(reason: RequestAbortReason): void {
    if (!this.requestController.signal.aborted) {
      this.requestController.abort(reason);
    }
  }

  interruptStep(reason: SteeringInterruptReason): void {
    if (!this.stepController.signal.aborted) {
      this.stepController.abort(reason);
    }
  }

  advanceStep(): void {
    this.stepController = new AbortController();
  }

  dispose(): void {
    this.externalSignalCleanup?.();
    this.externalSignalCleanup = undefined;
  }
}
