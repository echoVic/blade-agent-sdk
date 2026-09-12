import { createHash } from 'node:crypto';
import {
  CommandId,
  DurableSessionRecoveryCoordinator,
  InputId,
  RequestId,
  TurnId,
} from '@blade-ai/agent-sdk/core';

function identity(...parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

/** Reconcile only known safe boundaries, under the successor's execution lease. */
export async function recoverRepositorySession({
  tenantStore, sessionId, lease, requestPermission, signal,
}) {
  const recovery = await DurableSessionRecoveryCoordinator.open(tenantStore, sessionId, {
    executionLease: lease,
  });
  for (let step = 0; step < 32; step += 1) {
    signal.throwIfAborted();
    const plan = await recovery.refresh();
    const request = recovery.getProjection().activeRequest;
    if (plan.action === 'none' || plan.action === 'resume_request') return;
    const turn = request?.activeTurn;
    if (plan.action === 'reconcile_model_outcome') {
      // The old worker has lost its fence. A model result never acknowledged in
      // the journal cannot authorize tool execution; discard that attempt.
      await recovery.reconcileModelOutcome({
        commandId: CommandId(identity('model-aborted', plan.activeModelAttempt.modelAttemptId)),
        requestId: request.requestId,
        turnId: turn.turnId,
        modelAttemptId: plan.activeModelAttempt.modelAttemptId,
        outcome: { status: 'aborted' },
      });
      continue;
    }
    if (plan.action === 'reconcile_tool_outcomes') {
      throw new Error(`Manual reconciliation required: unknown non-idempotent tool outcome (${plan.unknownToolAttempts.map((tool) => tool.toolName).join(', ')}). The worker will not repeat it.`);
    }
    if (plan.action === 'resolve_permissions') {
      for (const permission of plan.pendingPermissions) {
        const tool = turn.toolAttempts.find((candidate) => candidate.permission?.permissionRequestId === permission.permissionRequestId);
        const answer = await requestPermission({
          permissionRequestId: permission.permissionRequestId,
          toolName: tool.toolName,
          args: permission.input,
          title: 'Resume a repository change',
          message: 'The previous worker stopped while waiting for this approval.',
          affectedFiles: typeof permission.input?.path === 'string' ? [permission.input.path] : [],
          abortSignal: signal,
        });
        await recovery.resolvePermission({
          commandId: CommandId(identity('permission', permission.permissionRequestId)),
          permissionRequestId: permission.permissionRequestId,
          decision: answer.approved ? 'allow' : 'deny',
          message: answer.reason ?? 'Repository approval recovered from durable storage',
        });
      }
      continue;
    }
    if (plan.action === 'resume_turn') {
      const token = identity('recover-turn', request.requestId, turn.turnId);
      // prepareTurnRecovery refuses an already-crossed non-idempotent boundary.
      // RepoWrite is a full replacement and its checkpoint is committed before
      // success. The continuation therefore reads the restored workspace first.
      await recovery.prepareTurnRecovery({
        commandId: CommandId(token),
        requestId: request.requestId,
        turnId: turn.turnId,
        recoveryRequestId: RequestId(`recovery-${token}`),
        recoveryInputId: InputId(`recovery-input-${token}`),
      });
      continue;
    }
    if (plan.action === 'rollover_request') {
      const token = identity('recover-input', request.requestId, request.lastTurn);
      await recovery.prepareRequestRecovery({
        commandId: CommandId(token),
        requestId: request.requestId,
        inputId: request.inputId,
        sourceLastTurn: request.lastTurn,
        recoveryTurnId: TurnId(`recovery-turn-${token}`),
        recoveryRequestId: RequestId(`recovery-${token}`),
        recoveryInputId: InputId(`recovery-input-${token}`),
        preparation: {
          status: 'reconciled',
          appliedInputIds: request.appliedInputIds,
          input: request.input,
        },
      });
      continue;
    }
    throw new Error(`Manual reconciliation required for durable recovery action ${plan.action}; no work was replayed.`);
  }
  throw new Error('Repository recovery exceeded its bounded transition limit');
}
