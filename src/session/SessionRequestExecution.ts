import type { LoopResult, UserMessageContent } from '../agent/types.js';
import type { HookRuntime } from '../hooks/HookRuntime.js';
import type { AgentTrace, TraceRecorder } from '../observability/index.js';
import type { RequestId } from '../types/identifiers.js';
import type { ActiveRequestController } from './ActiveRequestController.js';
import type {
  DurableRequestFinish,
  SessionDurableRecorder,
} from './events/SessionDurableRecorder.js';
import { SessionDurableRecorderError } from './events/SessionDurableRecorder.js';
import type { SessionDurability } from './SessionDurability.js';
import type { SessionRequestCoordinator } from './SessionRequestCoordinator.js';
import type { SessionState, SessionStreamExecution } from './SessionState.js';

export interface ClaimedSessionRequest {
  requestId: RequestId;
  input: Extract<SessionState['executionState'], { phase: 'pending' }>['input'];
  message: UserMessageContent;
  options: Extract<SessionState['executionState'], { phase: 'pending' }>['options'];
  snapshot: Extract<SessionState['executionState'], { phase: 'pending' }>['snapshot'];
  controller: ActiveRequestController;
  durableRecorder: SessionDurableRecorder | null;
  initialInputPreparation: Extract<
    SessionState['executionState'],
    { phase: 'pending' }
  >['initialInputPreparation'];
}

export type RequestFailure =
  | { action: 'ignore' }
  | { action: 'throw'; error: unknown }
  | { action: 'emit'; message: string };

function combined(current: unknown, next: unknown, message: string): unknown {
  return current === undefined ? next : new AggregateError([current, next], message);
}

export class SessionRequestExecution {
  private durableFinishAttempted = false;
  private durableFinishCommitted: boolean;
  private traceFinished = false;
  private readonly traceRecorder?: TraceRecorder;

  constructor(
    private readonly state: SessionState,
    private readonly durability: SessionDurability,
    private readonly requests: SessionRequestCoordinator,
    readonly claimed: ClaimedSessionRequest,
    private readonly execution: SessionStreamExecution,
    private readonly hookRuntime: HookRuntime,
  ) {
    this.durableFinishCommitted = !claimed.durableRecorder;
    this.traceRecorder = state.createTraceRecorder(claimed.message);
    hookRuntime.setTraceCollector(this.traceRecorder);
  }

  get signal(): AbortSignal {
    return this.claimed.controller.requestSignal;
  }

  get recorder(): SessionDurableRecorder | null {
    return this.claimed.durableRecorder;
  }

  get trace(): TraceRecorder | undefined {
    return this.traceRecorder;
  }

  get handingOff(): boolean {
    return this.recorder?.isHandoffRequested() === true;
  }

  async finishDurable(finish: DurableRequestFinish): Promise<void> {
    if (!this.recorder || this.durableFinishAttempted) return;
    this.durableFinishAttempted = true;
    if (!(await this.recorder.finish(finish))) {
      throw new SessionDurableRecorderError(
        `Request ${this.claimed.requestId} has a tool outcome that requires reconciliation`,
      );
    }
    this.durableFinishCommitted = true;
  }

  async finishTrace(
    status: 'success' | 'error' | 'aborted',
    data?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.traceRecorder || this.traceFinished) return;
    this.traceFinished = true;
    const trace: AgentTrace = this.traceRecorder.finish(status, data);
    this.state.rememberTrace(trace);
    await this.state.notifyTraceSink(trace);
  }

  async handleFailure(error: unknown, phase: 'setup' | 'execution'): Promise<RequestFailure> {
    const leaseFailure = this.state.executionLeaseFailure;
    const aborted = this.signal.aborted;
    let terminalError = error;
    if (!this.handingOff && !leaseFailure && !this.durableFinishAttempted) {
      try {
        await this.finishDurable(
          aborted
            ? {
                status: 'interrupted',
                reason: this.durability.interruptReason(this.claimed.controller),
              }
            : { status: 'failed', error },
        );
      } catch (durableError) {
        terminalError = combined(
          terminalError,
          durableError,
          `Request ${phase} and durable finalization both failed`,
        );
      }
    }

    try {
      await this.finishTrace(this.handingOff || leaseFailure || aborted ? 'aborted' : 'error', {
        ...this.failureTraceData(terminalError),
      });
    } catch (traceError) {
      terminalError = combined(
        terminalError,
        traceError,
        `Request ${phase} and trace finalization both failed`,
      );
    }

    if (this.handingOff) return { action: 'ignore' };
    if (leaseFailure) return { action: 'throw', error: leaseFailure };
    if (this.recorder && !this.durableFinishCommitted) {
      return { action: 'throw', error: terminalError };
    }
    if (aborted) return { action: 'ignore' };
    return {
      action: 'emit',
      message: terminalError instanceof Error ? terminalError.message : String(terminalError),
    };
  }

  async cleanup(
    stream: AsyncGenerator<unknown, LoopResult> | undefined,
    streamCompleted: boolean,
  ): Promise<void> {
    let error: unknown;
    if (stream && !streamCompleted) {
      this.claimed.controller.abortRequest({ kind: 'user_abort' });
      try {
        await stream.return(undefined as never);
      } catch (closeError) {
        error = closeError;
      }
      try {
        await this.finishTrace('aborted', {
          reason: this.durability.interruptReason(this.claimed.controller),
        });
      } catch (traceError) {
        error = combined(error, traceError, 'Agent stream and trace cleanup both failed');
      }
      if (!this.handingOff && !this.state.executionLeaseFailure && !this.durableFinishAttempted) {
        try {
          await this.finishDurable({
            status: 'interrupted',
            reason: this.durability.interruptReason(this.claimed.controller),
          });
        } catch (durableError) {
          error = combined(error, durableError, 'Agent stream and durable cleanup both failed');
        }
      }
    }

    this.hookRuntime.setTraceCollector(undefined);
    this.signal.removeEventListener('abort', this.releaseBackpressure);
    this.claimed.controller.dispose();
    await this.requests.finishRequest(this.claimed.requestId);
    if (
      this.state.executionState.phase === 'closed' &&
      this.state.executionState.disposition === 'terminal'
    ) {
      await this.durability.closeSession();
    }
    if (error !== undefined) throw error;
  }

  readonly releaseBackpressure = (): void => {
    this.execution.releaseBackpressure();
  };

  installAbortListener(): void {
    if (this.signal.aborted) {
      this.releaseBackpressure();
    } else {
      this.signal.addEventListener('abort', this.releaseBackpressure, { once: true });
    }
  }

  private failureTraceData(error: unknown): Record<string, unknown> {
    if (this.handingOff) return { reason: 'session_handoff' };
    if (this.state.executionLeaseFailure) return { reason: 'process_restart' };
    if (this.signal.aborted) {
      return { reason: this.durability.interruptReason(this.claimed.controller) };
    }
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
