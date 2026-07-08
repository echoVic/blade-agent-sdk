import type { ToolRegistry } from '../../tools/registry/ToolRegistry.js';
import type { ToolResult } from '../../tools/types/index.js';
import type { AgentEvent } from '../AgentEvent.js';
import type { ToolExecutionUpdate } from './runToolCall.js';
import type { FunctionToolCall } from './types.js';
import {
  buildAgentLoopToolResultEvent as buildPackageAgentLoopToolResultEvent,
  toolUpdateToAgentEvent as mapToolUpdateToAgentEvent,
} from '../../../packages/agent/src/loop/toolUpdateToAgentEvent.js';

export function toolUpdateToAgentEvent(
  update: ToolExecutionUpdate,
  registry: ToolRegistry,
): AgentEvent | null {
  return mapToolUpdateToAgentEvent(update, registry) as AgentEvent | null;
}

export function buildAgentLoopToolResultEvent(input: {
  toolCall: FunctionToolCall;
  result: ToolResult;
}): AgentEvent {
  return buildPackageAgentLoopToolResultEvent(input) as AgentEvent;
}
