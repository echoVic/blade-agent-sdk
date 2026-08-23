import type {
  AgentRunControl,
  AgentSteeringInput,
} from '../agent/AgentRunControl.js';
import type { SteeringInterruptReason } from '../types/abort.js';
import type { InputId, RequestId } from '../types/branded.js';
import { InputPriority } from './types.js';
import type { SessionInputInbox } from './SessionInputInbox.js';

export type RequestAbortReason =
  | { kind: 'user_abort' }
  | { kind: 'session_close' }
  | { kind: 'session_handoff' }
  | { kind: 'external_abort'; cause?: unknown };

export class ActiveRequestController implements AgentRunControl {
  private readonly requestController = new AbortController();
  private stepController = new AbortController();
  private externalSignalCleanup?: () => void;
  private sealed = false;

  constructor(
    readonly requestId: RequestId,
    externalSignal?: AbortSignal,
    private readonly inputInbox?: SessionInputInbox,
    private readonly initialInputId?: InputId,
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

  get steeringSignal(): AbortSignal {
    return this.stepController.signal;
  }

  get stepSignal(): AbortSignal {
    return AbortSignal.any([
      this.requestController.signal,
      this.stepController.signal,
    ]);
  }

  get isSealed(): boolean {
    return this.sealed;
  }

  isInitialInput(inputId: InputId): boolean {
    return this.initialInputId === inputId;
  }

  abortRequest(reason: RequestAbortReason): void {
    if (!this.requestController.signal.aborted) {
      this.requestController.abort(reason);
    }
  }

  interruptStep(inputId: InputId): void {
    if (!this.stepController.signal.aborted) {
      const reason: SteeringInterruptReason = {
        kind: 'steering',
        inputId,
      };
      this.stepController.abort(reason);
    }
  }

  advanceStep(): void {
    this.stepController = new AbortController();
  }

  claimSteeringInputs(options: {
    includeNow?: boolean;
    sealIfEmpty?: boolean;
  } = {}): AgentSteeringInput[] {
    const priorities = options.includeNow
      ? [InputPriority.NOW, InputPriority.NEXT]
      : [InputPriority.NEXT];
    const inputs = this.inputInbox?.claimForRequest(
      this.requestId,
      priorities,
      this.initialInputId,
    ) ?? [];
    if (options.sealIfEmpty && inputs.length === 0) {
      this.sealed = true;
    }
    return inputs.flatMap((input) =>
      input.priority === InputPriority.LATER
        ? []
        : [input as AgentSteeringInput]);
  }

  acknowledgeInput(inputId: InputId): void {
    this.inputInbox?.acknowledge(inputId);
  }

  releaseInput(inputId: InputId): void {
    this.inputInbox?.releaseClaim(inputId);
  }

  seal(): void {
    this.sealed = true;
  }

  dispose(): void {
    this.externalSignalCleanup?.();
    this.externalSignalCleanup = undefined;
  }
}
