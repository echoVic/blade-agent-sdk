import type { ToolUseId } from '../../types/identifiers.js';
import { assertToolMatchesModel } from './DurableModelReducer.js';
import { invalid, requireTool, requireTurn } from './DurableReducerContext.js';
import type {
  DurableSessionState,
  DurableToolAttemptProjection,
  MutableTurnProjection,
} from './DurableSessionState.js';
import {
  type DurableEventEnvelope,
  DurableEventType,
  type DurablePermissionDecision,
} from './types.js';

type Event<T extends DurableEventType> = DurableEventEnvelope<T>;

export function reduceToolEvent(state: DurableSessionState, event: DurableEventEnvelope): void {
  switch (event.type) {
    case DurableEventType.TOOL_SCHEDULED:
      scheduleTool(state, event);
      return;
    case DurableEventType.PERMISSION_REQUESTED:
      requestPermission(state, event);
      return;
    case DurableEventType.PERMISSION_RESOLVED:
      resolvePermission(state, event);
      return;
    case DurableEventType.TOOL_STARTED:
      startTool(state, event);
      return;
    case DurableEventType.TOOL_COMPLETED:
      completeTool(state, event);
      return;
    case DurableEventType.TOOL_FAILED:
      failTool(state, event);
      return;
    case DurableEventType.TOOL_CANCELLED:
      cancelTool(state, event);
      return;
    case DurableEventType.TOOL_OUTCOME_UNKNOWN:
      markOutcomeUnknown(state, event);
      return;
  }
}

export function assertTurnCanEnd(event: DurableEventEnvelope, turn: MutableTurnProjection): void {
  if (turn.activeModelAttempt) {
    invalid(event, `Model attempt ${turn.activeModelAttempt.modelAttemptId} is not terminal`);
  }
  const unfinished = turn.toolAttempts.find(
    (tool) =>
      tool.status === 'scheduled' ||
      tool.status === 'started' ||
      tool.status === 'outcome_unknown' ||
      tool.permission?.status === 'pending',
  );
  if (unfinished) invalid(event, `Tool attempt ${unfinished.toolAttemptId} is not terminal`);
}

export function hasCrossedNonIdempotentBoundary(tool: DurableToolAttemptProjection): boolean {
  return (
    tool.sideEffect === 'non_idempotent' &&
    (tool.status === 'completed' ||
      tool.status === 'failed' ||
      (tool.status === 'cancelled' && tool.executionStarted))
  );
}

function scheduleTool(
  state: DurableSessionState,
  event: Event<typeof DurableEventType.TOOL_SCHEDULED>,
): void {
  const turn = requireTurn(state, event);
  if (state.seenToolAttemptIds.has(event.toolAttemptId)) {
    invalid(event, `Tool attempt ID ${event.toolAttemptId} was already used`);
  }
  if (turn.toolAttempts.some((tool) => tool.toolCallId === event.data.toolCallId)) {
    invalid(event, `Tool call ID ${event.data.toolCallId} was already scheduled`);
  }
  assertToolMatchesModel(
    event,
    turn,
    event.data.toolCallId,
    event.data.toolName,
    event.modelAttemptId,
    event.data.modelInput,
  );
  state.seenToolAttemptIds.add(event.toolAttemptId);
  turn.toolAttempts.push({
    toolAttemptId: event.toolAttemptId,
    toolCallId: event.data.toolCallId,
    toolName: event.data.toolName,
    ...(event.modelAttemptId ? { modelAttemptId: event.modelAttemptId } : {}),
    ...(event.data.modelInput !== undefined ? { modelInput: event.data.modelInput } : {}),
    input: event.data.input,
    sideEffect: event.data.sideEffect,
    interruptBehavior: event.data.interruptBehavior,
    executionStarted: false,
    status: 'scheduled',
    permission: null,
  });
}

function requestPermission(
  state: DurableSessionState,
  event: Event<typeof DurableEventType.PERMISSION_REQUESTED>,
): void {
  const tool = requireTool(state, event);
  assertToolIdentity(event, tool, event.data);
  if (tool.status !== 'scheduled')
    invalid(event, `Tool attempt ${tool.toolAttemptId} already started`);
  if (tool.permission) {
    invalid(event, `Tool attempt ${tool.toolAttemptId} already has a permission decision`);
  }
  if (state.seenPermissionRequestIds.has(event.data.permissionRequestId)) {
    invalid(event, `Permission request ID ${event.data.permissionRequestId} was already used`);
  }
  state.seenPermissionRequestIds.add(event.data.permissionRequestId);
  tool.permission = {
    permissionRequestId: event.data.permissionRequestId,
    input: event.data.input,
    status: 'pending',
    ...(event.data.message !== undefined ? { message: event.data.message } : {}),
  };
}

function resolvePermission(
  state: DurableSessionState,
  event: Event<typeof DurableEventType.PERMISSION_RESOLVED>,
): void {
  const tool = requireTool(state, event);
  const permission = tool.permission;
  if (
    !permission ||
    permission.status !== 'pending' ||
    permission.permissionRequestId !== event.data.permissionRequestId
  ) {
    invalid(event, `No pending permission matches ${event.data.permissionRequestId}`);
  }
  permission.status = 'resolved';
  permission.decision = event.data.decision;
  if (event.data.message !== undefined) permission.message = event.data.message;
}

function startTool(
  state: DurableSessionState,
  event: Event<typeof DurableEventType.TOOL_STARTED>,
): void {
  const tool = requireTool(state, event);
  assertToolIdentity(event, tool, event.data);
  if (tool.status !== 'scheduled') {
    invalid(event, `Tool attempt ${tool.toolAttemptId} is ${tool.status}, not scheduled`);
  }
  assertNoPendingPermission(event, tool);
  if (permissionDecision(tool) && permissionDecision(tool) !== 'allow') {
    invalid(event, `Tool attempt ${tool.toolAttemptId} did not receive permission`);
  }
  tool.input = event.data.input;
  tool.sideEffect = event.data.sideEffect;
  tool.executionStarted = true;
  tool.status = 'started';
}

function completeTool(
  state: DurableSessionState,
  event: Event<typeof DurableEventType.TOOL_COMPLETED>,
): void {
  const tool = requireTool(state, event);
  assertToolIdentity(event, tool, event.data);
  if (tool.status !== 'started' && tool.status !== 'outcome_unknown') {
    invalid(event, `Tool attempt ${tool.toolAttemptId} cannot complete from ${tool.status}`);
  }
  tool.status = 'completed';
  tool.result = event.data.result;
  delete tool.unknownReason;
}

function failTool(
  state: DurableSessionState,
  event: Event<typeof DurableEventType.TOOL_FAILED>,
): void {
  const tool = requireTool(state, event);
  assertToolIdentity(event, tool, event.data);
  assertTerminalTransition(event, tool, 'fail');
  assertNoPendingPermission(event, tool);
  if (tool.status === 'scheduled' && permissionDecision(tool) !== 'allow' && tool.permission) {
    invalid(event, `Tool attempt ${tool.toolAttemptId} must be cancelled after permission denial`);
  }
  tool.status = 'failed';
  tool.error = event.data.error;
  delete tool.unknownReason;
}

function cancelTool(
  state: DurableSessionState,
  event: Event<typeof DurableEventType.TOOL_CANCELLED>,
): void {
  const tool = requireTool(state, event);
  assertToolIdentity(event, tool, event.data);
  assertTerminalTransition(event, tool, 'be cancelled');
  assertNoPendingPermission(event, tool);
  const decision = permissionDecision(tool);
  if (event.data.reason === 'permission_denied' && decision !== 'deny') {
    invalid(event, `Tool attempt ${tool.toolAttemptId} has no denied permission`);
  }
  if (event.data.reason === 'permission_cancelled' && decision !== 'cancel') {
    invalid(event, `Tool attempt ${tool.toolAttemptId} has no cancelled permission`);
  }
  tool.status = 'cancelled';
  tool.cancelReason = event.data.reason;
  delete tool.unknownReason;
}

function markOutcomeUnknown(
  state: DurableSessionState,
  event: Event<typeof DurableEventType.TOOL_OUTCOME_UNKNOWN>,
): void {
  const tool = requireTool(state, event);
  assertToolIdentity(event, tool, event.data);
  if (tool.status !== 'started') {
    invalid(event, `Tool attempt ${tool.toolAttemptId} cannot become unknown from ${tool.status}`);
  }
  tool.status = 'outcome_unknown';
  tool.unknownReason = event.data.reason;
}

function assertTerminalTransition(
  event: DurableEventEnvelope,
  tool: DurableToolAttemptProjection,
  action: string,
): void {
  if (!['scheduled', 'started', 'outcome_unknown'].includes(tool.status)) {
    invalid(event, `Tool attempt ${tool.toolAttemptId} cannot ${action} from ${tool.status}`);
  }
}

function assertToolIdentity(
  event: DurableEventEnvelope,
  tool: DurableToolAttemptProjection,
  identity: { toolCallId: ToolUseId; toolName: string },
): void {
  if (tool.toolCallId !== identity.toolCallId || tool.toolName !== identity.toolName) {
    invalid(event, `Tool identity does not match attempt ${tool.toolAttemptId}`);
  }
}

function assertNoPendingPermission(
  event: DurableEventEnvelope,
  tool: DurableToolAttemptProjection,
): void {
  if (tool.permission?.status === 'pending') {
    invalid(event, `Tool attempt ${tool.toolAttemptId} has an unresolved permission request`);
  }
}

function permissionDecision(
  tool: DurableToolAttemptProjection,
): DurablePermissionDecision | undefined {
  return tool.permission?.status === 'resolved' ? tool.permission.decision : undefined;
}
