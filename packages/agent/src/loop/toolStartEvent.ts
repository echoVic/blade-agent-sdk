import type { AgentFunctionToolCall, ToolExecutionPlan } from './planToolExecution.js';
import {
  isToolKind,
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

export interface AgentLoopToolStartEventsExecutionPipelineInput<
  TExecutionPipeline extends { getRegistry(): ToolExecutionRegistryLike },
> {
  plan: ToolExecutionPlan;
  executionPipeline: TExecutionPipeline;
}

export function buildAgentLoopToolStartEventsInput(
  input: AgentLoopToolStartEventsInput,
): AgentLoopToolStartEventsInput {
  return {
    plan: input.plan,
    registry: input.registry,
  };
}

export function buildAgentLoopToolStartEventsInputFromExecutionPipeline<
  TExecutionPipeline extends { getRegistry(): ToolExecutionRegistryLike },
>(
  input: AgentLoopToolStartEventsExecutionPipelineInput<TExecutionPipeline>,
): AgentLoopToolStartEventsInput {
  return buildAgentLoopToolStartEventsInput({
    plan: input.plan,
    registry: input.executionPipeline.getRegistry(),
  });
}

export function buildAgentLoopToolStartEvent(
  input: AgentLoopToolStartEventInput,
): AgentLoopToolStartEvent {
  const toolDef = input.registry.get(input.toolCall.function.name);

  return {
    type: 'tool_start',
    toolCall: input.toolCall,
    toolKind: isToolKind(toolDef?.kind) ? toolDef.kind : undefined,
  };
}

export function buildAgentLoopToolStartEvents(
  input: AgentLoopToolStartEventsInput,
): AgentLoopToolStartEvent[] {
  return input.plan.calls.map((toolCall) =>
    buildAgentLoopToolStartEvent({ toolCall, registry: input.registry }),
  );
}
