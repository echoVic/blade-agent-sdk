import type { AgentRunControl, AgentSteeringInput } from '../agent/AgentRunControl.js';
import type { SteeringInterruptReason } from '../types/abort.js';
import type { InputId, RequestId } from '../types/identifiers.js';
import type { SessionInputInbox } from './SessionInputInbox.js';
import { InputPriority } from './types.js';

export type RequestAbortReason =
  | { kind: 'user_abort' | 'session_close' | 'session_handoff' }
  | { kind: 'execution_lease_lost'; cause: unknown }
  | { kind: 'external_abort'; cause?: unknown };

export class ActiveRequestController implements AgentRunControl {
  private readonly requestController = new AbortController();
  private stepController = new AbortController();
  private externalSignalCleanup?: () => void;
  private sealed = false;

  constructor(
    readonly requestId: RequestId,
    externalSignal?: AbortSignal,
    private readonly inbox?: SessionInputInbox,
    private readonly initialInputId?: InputId,
  ) {
    if (!externalSignal) return;
    const abort = () => this.abortRequest({ kind: 'external_abort', cause: externalSignal.reason });
    if (externalSignal.aborted) abort();
    else {
      externalSignal.addEventListener('abort', abort, { once: true });
      this.externalSignalCleanup = () => externalSignal.removeEventListener('abort', abort);
    }
  }

  get requestSignal(): AbortSignal {
    return this.requestController.signal;
  }

  get steeringSignal(): AbortSignal {
    return this.stepController.signal;
  }

  get stepSignal(): AbortSignal {
    return AbortSignal.any([this.requestSignal, this.steeringSignal]);
  }

  get isSealed(): boolean {
    return this.sealed;
  }

  isInitialInput(inputId: InputId): boolean {
    return this.initialInputId === inputId;
  }

  abortRequest(reason: RequestAbortReason): void {
    if (!this.requestSignal.aborted) this.requestController.abort(reason);
  }

  interruptStep(inputId: InputId): void {
    if (this.steeringSignal.aborted) return;
    const reason: SteeringInterruptReason = { kind: 'steering', inputId };
    this.stepController.abort(reason);
  }

  advanceStep(): void {
    this.stepController = new AbortController();
  }

  claimSteeringInputs(
    options: { includeNow?: boolean; sealIfEmpty?: boolean } = {},
  ): AgentSteeringInput[] {
    const priorities = options.includeNow
      ? [InputPriority.NOW, InputPriority.NEXT]
      : [InputPriority.NEXT];
    const inputs =
      this.inbox?.claimForRequest(this.requestId, priorities, this.initialInputId) ?? [];
    if (options.sealIfEmpty && inputs.length === 0) this.sealed = true;
    return inputs.filter(
      (input): input is AgentSteeringInput => input.priority !== InputPriority.LATER,
    );
  }

  acknowledgeInput(inputId: InputId): void {
    this.inbox?.acknowledge(inputId);
  }

  releaseInput(inputId: InputId): void {
    this.inbox?.releaseClaim(inputId);
  }

  seal(): void {
    this.sealed = true;
  }

  dispose(): void {
    this.externalSignalCleanup?.();
    this.externalSignalCleanup = undefined;
  }
}
