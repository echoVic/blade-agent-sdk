import { setTimeout as delay } from 'node:timers/promises';
import {
  DurableExecutionLease,
  ExecutionCheckpointId,
  ExecutionId,
} from '@blade-ai/agent-sdk/core';
import { resumeSession } from '@blade-ai/agent-sdk/server';
import { createRepositorySessionOptions } from './RepositoryDemoProvider.mjs';
import { createRepositoryTools } from './RepositoryTools.mjs';
import { recoverRepositorySession } from './RepositoryRecovery.mjs';

const REPOSITORY_KEY = 'bladeRepository';

/** A real SDK Session, with model calls on the worker and tools in Docker. */
function buildTerminalOutcome({ sessionId, cancelled, succeeded, terminal, errorMessage }) {
  return terminal && !cancelled ? terminal : {
    type: 'result', subtype: succeeded ? 'success' : 'error',
    sessionId, content: cancelled ? 'Request cancelled.' : '',
    ...(succeeded ? {} : { error: errorMessage ?? 'Session ended without a terminal result' }),
  };
}

export class RepositorySessionRunner {
  managesLease = true;

  constructor({ state, repositoryConfig, smoke = false, publish }) {
    this.state = state;
    this.repositoryConfig = repositoryConfig;
    this.smoke = smoke;
    this.publish = publish;
  }

  async run(context) {
    const { route, lease: claimedLease } = context.claim;
    const { tenantId, sessionId } = route;
    const logicalRequestId = route.metadata.bladeQueuedRequest?.requestId;
    if (!logicalRequestId) throw new Error('Repository route has no accepted SDK request');
    if (!context.executionHost) throw new Error('Repository tools require a Docker ExecutionHost');
    const host = context.executionHost;
    const tenantStore = context.store.forTenant(tenantId);
    const leaseOptions = {
      ownerId: claimedLease.ownerId,
      leaseId: claimedLease.leaseId,
      ttlMs: Math.max(2, Date.parse(claimedLease.expiresAt) - Date.now()),
    };
    let metadata = structuredClone(route.metadata);
    let handle;
    let session;
    let recoveryLease;
    let handoff;
    let cancellation;
    let cancelled = false;
    let terminal;
    let terminalError;
    const localController = new AbortController();
    const localSignal = AbortSignal.any([context.signal, localController.signal]);
    const emit = (type, data) => this.publish(tenantId, sessionId, type, data, logicalRequestId);
    const transition = async (state, patch = {}) => {
      metadata = { ...metadata, ...patch };
      const updated = await context.transition(state, metadata);
      metadata = updated.metadata;
    };
    const beginHandoff = () => {
      handoff ??= session.suspendForHandoff();
      return handoff;
    };
    const onShutdown = () => {
      if (session && !cancelled) void beginHandoff().catch(() => undefined);
    };
    context.signal.addEventListener('abort', onShutdown, { once: true });

    const requestPermission = async (details) => {
      const signal = details.abortSignal
        ? AbortSignal.any([localSignal, details.abortSignal]) : localSignal;
      signal.throwIfAborted();
      const permissionRequestId = details.permissionRequestId;
      if (!permissionRequestId) throw new Error('Repository approval requires a durable permission ID');
      const request = {
        permissionRequestId,
        toolName: details.toolName,
        input: details.args ?? {},
        title: 'Review file change',
        message: 'Replace src/greeting.sh in this session’s isolated repository, then run its tests.',
        kind: details.kind ?? 'edit',
        affectedPaths: details.affectedFiles ?? [],
        risks: [],
      };
      await this.state.requestPermission({ sessionId, requestId: logicalRequestId, permissionRequestId, request });
      await transition('waiting_approval');
      await emit('permission.requested', request);
      for (;;) {
        signal.throwIfAborted();
        if (await this.state.isCancelled(sessionId, logicalRequestId)) {
          cancelled = true;
          return { approved: false, scope: 'once', reason: 'Request cancelled' };
        }
        const record = await this.state.getPermission(sessionId, permissionRequestId);
        if (record?.status === 'resolved' && record.decision) {
          await transition('running');
          return { ...record.decision, scope: 'once' };
        }
        await delay(100, undefined, { signal });
      }
    };

    // Cleanup failure must not be silent: the cancellation acknowledgement reads
    // this fact, so swallowing it would confirm a stop that never happened.
    let cleanupFailure;
    const cleanup = async () => {
      localController.abort();
      context.signal.removeEventListener('abort', onShutdown);
      if (!handle) return;
      try {
        await host.terminate(handle.executionId);
      } catch (error) {
        cleanupFailure = error instanceof Error ? error.message : String(error);
        throw error;
      }
    };
    const recordCleanup = async () => {
      await this.state.recordCancellationCleanup(sessionId, logicalRequestId, {
        succeeded: cleanupFailure === undefined,
        detail: cleanupFailure,
      }).catch(() => undefined);
    };

    try {
      recoveryLease = await DurableExecutionLease.acquire(tenantStore, sessionId, leaseOptions);
      await transition('running');
      const saved = metadata[REPOSITORY_KEY];
      if (saved?.executionId) {
        // Fenced ownership is established before reclaiming the predecessor's
        // resources. Reclaiming by identity is a host capability, so this runner
        // never names a container or assumes a backend.
        await host.reclaim(ExecutionId(saved.executionId));
      }
      handle = saved?.checkpointId
        ? await host.restore({ checkpointId: ExecutionCheckpointId(saved.checkpointId), signal: localSignal })
        : await host.provision({
          image: this.repositoryConfig.image,
          workspace: {
            kind: 'git-worktree',
            repositoryPath: this.repositoryConfig.repositoryPath,
            revision: this.repositoryConfig.revision,
          },
          resources: {
            cpus: 0.5, memoryBytes: 128 * 1024 * 1024,
            diskBytes: 32 * 1024 * 1024, pids: 64,
            runtimeMs: 10 * 60_000, maxOutputBytes: 64 * 1024,
          },
          network: { mode: 'none' },
          signal: localSignal,
        });
      await transition('running', {
        [REPOSITORY_KEY]: { ...saved, executionId: handle.executionId },
      });
      await this.state.update(sessionId, {
        executionId: handle.executionId,
        ...(saved?.checkpointId ? { checkpointId: saved.checkpointId, recovered: true } : {}),
      });
      await recoverRepositorySession({
        tenantStore, sessionId, lease: recoveryLease,
        requestPermission, signal: localSignal,
      });
      // Transfer local heartbeat ownership to Session without releasing the
      // Store claim. resumeSession adopts the exact same owner/lease identity.
      recoveryLease.abandon(new Error('Execution lease heartbeat transferred to SDK Session'));
      recoveryLease = undefined;

      const checkpoint = async ({ executionId, path, signal }) => {
        const checkpointSignal = signal ? AbortSignal.any([localSignal, signal]) : localSignal;
        checkpointSignal.throwIfAborted();
        if (executionId !== handle.executionId) throw new Error('Checkpoint target is not the active workspace');
        const savedCheckpoint = await host.checkpoint(executionId, { sessionId, requestId: logicalRequestId, path });
        const shouldCrash = this.smoke && metadata.bladeQueuedRequest?.crashAfterWrite === true
          && !metadata[REPOSITORY_KEY]?.crashCheckpointCommitted;
        await transition('running', {
          [REPOSITORY_KEY]: {
            ...metadata[REPOSITORY_KEY],
            executionId,
            checkpointId: savedCheckpoint.checkpointId,
            checkpointRequestId: logicalRequestId,
            ...(shouldCrash ? { crashCheckpointCommitted: true } : {}),
          },
        });
        await this.state.update(sessionId, { checkpointId: savedCheckpoint.checkpointId, changedPath: path });
        // The checkpoint is published in the route metadata above and in
        // repository_state here; the caller reads that durable state instead of
        // receiving a notification it would have to cache.
        if (shouldCrash) {
          // This is the real fault boundary: file and checkpoint are committed,
          // but the SDK has not yet recorded the idempotent tool's result.
          await delay(10 * 60_000, undefined, { signal: checkpointSignal });
          throw new Error('The checkpoint fault injection was not triggered');
        }
      };
      const tools = createRepositoryTools({
        host, getHandle: async () => handle, checkpoint,
        repositoryConfig: this.repositoryConfig, signal: localSignal,
      });
      session = await resumeSession({
        ...createRepositorySessionOptions({
          smoke: this.smoke, tools,
          confirmationHandlerFactory: () => ({ requestConfirmation: requestPermission }),
        }),
        sessionId,
        sessionRepository: tenantStore,
        sessionEventStore: tenantStore,
        durableEventStore: tenantStore,
        executionLease: leaseOptions,
      });
      if (context.signal.aborted) onShutdown();
      const watchCancellation = async () => {
        while (!localSignal.aborted) {
          if (await this.state.isCancelled(sessionId, logicalRequestId)) {
            cancelled = true;
            await session.abort();
            return;
          }
          await delay(100, undefined, { signal: localSignal });
        }
      };
      cancellation = watchCancellation();
      void cancellation.catch(() => undefined);
      if (await this.state.isCancelled(sessionId, logicalRequestId)) {
        cancelled = true;
        await session.abort();
      } else {
        for await (const event of session.stream()) {
          // Publish the terminal only after AgentWorker has settled the route.
          if (event.type === 'result') terminal = event;
          else if (event.type === 'error') terminalError = event.message;
          else await emit('session.stream', event);
        }
      }
      if (cancelled) await cancellation;
      const detached = await beginHandoff();
      metadata = { ...metadata, durableHandoff: {
        headSequence: detached.headSequence, recoveryAction: detached.recoveryPlan.action,
      } };
      await cleanup();
      await recordCleanup();
      await cancellation?.catch((error) => { if (!localSignal.aborted) throw error; });
      if (context.signal.aborted && !cancelled) {
        return { status: 'suspended', metadata };
      }
      const errorMessage = terminalError ?? terminal?.error;
      const succeeded = cancelled || terminal?.subtype === 'success';
      const outcomeData = buildTerminalOutcome({
        sessionId, cancelled, succeeded, terminal, errorMessage,
      });
      // Recorded before returning, so the route cannot settle without a durable
      // copy of the result. A crash between settling and publishing leaves this
      // record for the launcher's startup reconciliation.
      await this.state.recordOutcomePending({
        sessionId,
        requestId: logicalRequestId,
        event: { data: outcomeData },
      });
      return {
        // A failed request still leaves this conversation ready for another
        // input. Unsafe recovery failures below leave the route failed instead.
        status: 'idle', metadata,
        finalize: async () => {
          await this.state.retirePermissions(sessionId, logicalRequestId);
          await this.state.update(sessionId, { lastRequestId: logicalRequestId,
            lastStatus: cancelled ? 'cancelled' : succeeded ? 'completed' : 'failed' });
          if (cancelled) await this.state.markCancelled(sessionId, logicalRequestId);
          const pending = await this.state.getUnpublishedOutcome(sessionId, logicalRequestId);
          if (!pending) return;
          await emit('session.stream', outcomeData);
          await this.state.markOutcomePublished(sessionId, logicalRequestId);
        },
      };
    } catch (error) {
      if (session) await beginHandoff().catch(() => undefined);
      if (recoveryLease) await recoveryLease.release().catch(() => undefined);
      await cleanup().catch(() => undefined);
      await recordCleanup();
      if (context.signal.aborted && !cancelled) {
        return { status: 'suspended', metadata };
      }
      const message = error instanceof Error ? error.message : String(error);
      const failureOutcome = { type: 'result', subtype: 'error', error: message, sessionId };
      await this.state.recordOutcomePending({
        sessionId,
        requestId: logicalRequestId,
        event: { data: failureOutcome },
      });
      return {
        status: 'failed', metadata, failure: { message },
        finalize: async () => {
          await this.state.retirePermissions(sessionId, logicalRequestId);
          await this.state.update(sessionId, { lastStatus: 'failed', error: message });
          const pending = await this.state.getUnpublishedOutcome(sessionId, logicalRequestId);
          if (!pending) return;
          await emit('session.stream', failureOutcome);
          await this.state.markOutcomePublished(sessionId, logicalRequestId);
        },
      };
    }
  }
}
