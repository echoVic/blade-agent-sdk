import type {
  SessionRunner,
  SessionRunnerContext,
  SessionRunResult,
} from '../advanced/SessionRunner.js';
import type { AgentServerEvent } from '../protocol/index.js';
import { resumeSession } from '../session/Session.js';
import type { SessionHandoffResult, SessionOptions, SessionStreamEvent } from '../session/types.js';
import type { RequestId, SessionId } from '../types/identifiers.js';
import type { JsonObject } from '../types/json.js';
import { getErrorCode, getErrorMessage } from '../utils/errorUtils.js';

export interface SdkSessionRunnerOptionsContext {
  readonly tenantId: string;
  readonly sessionId: SessionId;
  readonly routeMetadata: JsonObject;
  readonly executionHost: SessionRunnerContext['executionHost'];
}

export interface SdkSessionRunnerOptions {
  readonly resolveSessionOptions: (
    context: SdkSessionRunnerOptionsContext,
  ) => SessionOptions | Promise<SessionOptions>;
  readonly publish?: (
    tenantId: string,
    sessionId: SessionId,
    type: AgentServerEvent['type'],
    data: AgentServerEvent['data'],
    requestId?: RequestId,
  ) => Promise<void>;
}

function requestIdOf(event: SessionStreamEvent): RequestId | undefined {
  return 'requestId' in event ? event.requestId : undefined;
}

function handoffMetadata(existing: JsonObject, handoff: SessionHandoffResult): JsonObject {
  return {
    ...existing,
    durableHandoff: {
      headSequence: handoff.headSequence,
      recoveryAction: handoff.recoveryPlan.action,
    },
  };
}

/**
 * Runs an SDK Session from an existing durable request.
 *
 * Control-plane code accepts and persists input before enqueueing the route.
 * The runner resumes that request under the worker's fencing token, streams
 * events, and detaches the Session again before releasing the route lease.
 */
export class SdkSessionRunner implements SessionRunner {
  readonly managesLease = true;

  constructor(private readonly options: SdkSessionRunnerOptions) {}

  async run(context: SessionRunnerContext): Promise<SessionRunResult> {
    const { route, lease } = context.claim;
    const tenantStore = context.store.forTenant(route.tenantId);
    const configured = await this.options.resolveSessionOptions({
      tenantId: route.tenantId,
      sessionId: route.sessionId,
      routeMetadata: route.metadata,
      executionHost: context.executionHost,
    });
    if (
      configured.sessionRepository ||
      configured.sessionEventStore ||
      configured.durableEventStore ||
      configured.durableExecutionLeaseStore ||
      configured.executionLease
    ) {
      throw new TypeError('SdkSessionRunner owns Session persistence and execution lease options');
    }

    const session = await resumeSession({
      ...configured,
      sessionId: route.sessionId,
      sessionRepository: tenantStore,
      sessionEventStore: tenantStore,
      durableEventStore: tenantStore,
      durableExecutionLeaseStore: tenantStore,
      executionLease: {
        ownerId: lease.ownerId,
        leaseId: lease.leaseId,
        ttlMs: Math.max(2, Date.parse(lease.expiresAt) - Date.now()),
      },
    });
    let handoff: Promise<SessionHandoffResult> | undefined;
    const beginHandoff = (): Promise<SessionHandoffResult> => {
      handoff ??= session.suspendForHandoff();
      return handoff;
    };
    const onAbort = (): void => {
      void beginHandoff().catch(() => undefined);
    };
    context.signal.addEventListener('abort', onAbort, { once: true });
    if (context.signal.aborted) {
      onAbort();
    }
    try {
      await context.transition('running', route.metadata);
      let activeRequestId = session.getDurableProjection()?.activeRequest?.requestId;
      let terminal: Extract<SessionStreamEvent, { type: 'result' }> | undefined;
      for await (const event of session.stream()) {
        activeRequestId = requestIdOf(event) ?? activeRequestId;
        if (event.type === 'result') {
          // Defer the terminal result: publishing it while the route still reads
          // `running` would let a client observe a finished request and be refused
          // when it immediately sends the next input. The Worker settles the route
          // first, then runs `finalize`, which publishes this event.
          terminal = event;
          continue;
        }
        await this.options.publish?.(
          route.tenantId,
          route.sessionId,
          'session.stream',
          event,
          activeRequestId,
        );
      }
      const detached = await beginHandoff();
      const metadata = handoffMetadata(route.metadata, detached);
      if (context.signal.aborted) {
        return { status: 'suspended', metadata };
      }
      const publishTerminal = terminal
        ? () =>
            this.options.publish?.(
              route.tenantId,
              route.sessionId,
              'session.stream',
              terminal,
              activeRequestId,
            )
        : undefined;
      if (!terminal || terminal.subtype === 'error') {
        return {
          status: 'failed',
          failure: {
            message: terminal?.error ?? 'Session stream ended without a terminal result',
          },
          ...(publishTerminal
            ? {
                finalize: async () => {
                  await publishTerminal();
                },
              }
            : {}),
          metadata,
        };
      }
      return {
        status: 'idle',
        ...(publishTerminal
          ? {
              finalize: async () => {
                await publishTerminal();
              },
            }
          : {}),
        metadata,
      };
    } catch (error) {
      if (context.signal.aborted) {
        const detached = await beginHandoff();
        return {
          status: 'suspended',
          metadata: handoffMetadata(route.metadata, detached),
        };
      }
      const detached = await beginHandoff();
      const code = getErrorCode(error);
      return {
        status: 'failed',
        failure: {
          message: getErrorMessage(error),
          ...(code ? { code } : {}),
        },
        metadata: handoffMetadata(route.metadata, detached),
      };
    } finally {
      context.signal.removeEventListener('abort', onAbort);
    }
  }
}
