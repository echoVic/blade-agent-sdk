import type { AgentFunctionToolCall, ToolExecutionPlan } from './planToolExecution.js';
import {
  ToolKind,
  type ToolExecutionRegistryLike,
  type ToolKind as ToolKindType,
} from './toolBehavior.js';

export interface AgentLoopToolStartEvent {
  type: 'tool_start';
  toolCall: AgentFunctionToolCall;
  toolKind?: ToolKindType;
}

export interface AgentLoopToolStartEventInput {
  toolCall: AgentFunctionToolCall;
  registry: ToolExecutionRegistryLike;
}

export interface AgentLoopToolStartEventsInput {
  plan: ToolExecutionPlan;
  registry: ToolExecutionRegistryLike;
}

export function buildAgentLoopToolStartEvent(
  input: AgentLoopToolStartEventInput,
): AgentLoopToolStartEvent {
  const toolDef = input.registry.get(input.toolCall.function.name);

  return {
    type: 'tool_start',
    toolCall: input.toolCall,
    toolKind: isPublicToolKind(toolDef?.kind) ? toolDef.kind : undefined,
  };
}

export function buildAgentLoopToolStartEvents(
  input: AgentLoopToolStartEventsInput,
): AgentLoopToolStartEvent[] {
  return input.plan.calls.map((toolCall) =>
    buildAgentLoopToolStartEvent({ toolCall, registry: input.registry }),
  );
}

function isPublicToolKind(kind: string | undefined): kind is ToolKindType {
  return kind === ToolKind.ReadOnly || kind === ToolKind.Write || kind === ToolKind.Execute;
}
