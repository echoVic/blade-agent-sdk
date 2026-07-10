import type { ToolRegistry } from '../../tools/registry/ToolRegistry.js';
import type { ToolResult } from '../../tools/types/index.js';
import type { AgentEvent } from '../AgentEvent.js';
import type { ToolExecutionUpdate } from './runToolCall.js';
import {
  type AgentFunctionToolCall as FunctionToolCall,
  buildAgentLoopToolResultEvent as buildPackageAgentLoopToolResultEvent,
  toolUpdateToAgentEvent as mapToolUpdateToAgentEvent,
} from '@blade-ai/agent/loop';

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
