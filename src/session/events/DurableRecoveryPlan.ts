import type {
  DurablePermissionProjection,
  DurableRequestProjection,
  DurableSessionProjection,
  DurableSessionRecoveryAction,
  DurableSessionRecoveryPlan,
  DurableToolAttemptProjection,
} from './DurableSessionState.js';

function permissionDecision(tool: DurableToolAttemptProjection): string | undefined {
  return tool.permission?.status === 'resolved' ? tool.permission.decision : undefined;
}

export function planDurableSessionRecovery(
  projection: DurableSessionProjection,
): DurableSessionRecoveryPlan {
  const request = projection.activeRequest;
  const turn = request?.activeTurn ?? null;
  const activeModelAttempt = turn?.activeModelAttempt ?? null;
  const tools = turn?.toolAttempts ?? [];
  const modelStatuses = new Map(
    (turn?.modelAttempts ?? []).map((attempt) => [attempt.modelAttemptId, attempt.status]),
  );
  const hasUnconfirmedModel = (tool: DurableToolAttemptProjection): boolean =>
    tool.modelAttemptId !== undefined && modelStatuses.get(tool.modelAttemptId) !== 'completed';
  const unknownToolAttempts = tools.filter(
    (tool) =>
      (tool.status === 'started' || tool.status === 'outcome_unknown') &&
      tool.sideEffect === 'non_idempotent',
  );
  const pendingPermissions: DurablePermissionProjection[] = tools.flatMap((tool) =>
    tool.permission?.status === 'pending' && !hasUnconfirmedModel(tool) ? [tool.permission] : [],
  );
  const retryableToolAttempts = tools.filter(
    (tool) =>
      !hasUnconfirmedModel(tool) &&
      ((tool.status === 'scheduled' &&
        tool.permission?.status !== 'pending' &&
        !['deny', 'cancel'].includes(permissionDecision(tool) ?? '')) ||
        ((tool.status === 'started' || tool.status === 'outcome_unknown') &&
          tool.sideEffect !== 'non_idempotent')),
  );
  const cancelableToolAttempts = tools.filter(
    (tool) =>
      (tool.status === 'scheduled' &&
        ['deny', 'cancel'].includes(permissionDecision(tool) ?? '')) ||
      (hasUnconfirmedModel(tool) &&
        (tool.status === 'scheduled' ||
          ((tool.status === 'started' || tool.status === 'outcome_unknown') &&
            tool.sideEffect !== 'non_idempotent'))),
  );

  const action: DurableSessionRecoveryAction = activeModelAttempt
    ? 'reconcile_model_outcome'
    : unknownToolAttempts.length
      ? 'reconcile_tool_outcomes'
      : pendingPermissions.length
        ? 'resolve_permissions'
        : turn
          ? 'resume_turn'
          : request?.status === 'accepted'
            ? request.appliedInputIds.length
              ? 'reconcile_request_inputs'
              : 'resume_request'
            : request?.pendingInputIds.length
              ? 'reconcile_request_inputs'
              : request?.lastTurn === 0
                ? request.appliedInputIds.length === 1 &&
                  request.appliedInputIds[0] === request.inputId
                  ? 'rollover_request'
                  : 'reconcile_request_inputs'
                : request
                  ? 'reconcile_request_outcome'
                  : 'none';

  return {
    action,
    requestId: request?.requestId ?? null,
    turnId: turn?.turnId ?? null,
    activeModelAttempt,
    retryableToolAttempts,
    cancelableToolAttempts,
    unknownToolAttempts,
    pendingPermissions,
  };
}

export type ResumableDurableRequest = DurableRequestProjection &
  Required<Pick<DurableRequestProjection, 'context' | 'maxTurns' | 'model'>>;

export function resumableDurableRequest(
  projection: DurableSessionProjection,
  plan: DurableSessionRecoveryPlan,
): ResumableDurableRequest | null {
  const request = projection.activeRequest;
  if (
    plan.action !== 'resume_request' ||
    request?.status !== 'accepted' ||
    request.appliedInputIds.length > 0 ||
    projection.appliedInputIds.includes(request.inputId) ||
    request.maxTurns === undefined ||
    request.model === undefined ||
    request.context === undefined
  ) {
    return null;
  }
  return {
    ...request,
    maxTurns: request.maxTurns,
    model: request.model,
    context: request.context,
  };
}
