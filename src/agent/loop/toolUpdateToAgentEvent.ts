import type { ToolRegistry } from '../../tools/registry/ToolRegistry.js';
import type { AgentEvent } from '../AgentEvent.js';
import type { ToolExecutionUpdate } from './runToolCall.js';
import { toolUpdateToAgentEvent as mapToolUpdateToAgentEvent } from '../../../packages/agent/src/loop/toolUpdateToAgentEvent.js';

export function toolUpdateToAgentEvent(
  update: ToolExecutionUpdate,
  registry: ToolRegistry,
): AgentEvent | null {
  return mapToolUpdateToAgentEvent(update, registry) as AgentEvent | null;
}
