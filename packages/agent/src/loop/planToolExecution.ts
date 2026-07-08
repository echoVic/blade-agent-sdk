import type { JsonObject } from '@blade-ai/ai';
import {
  resolveToolBehaviorSafely,
  ToolKind,
  type ToolBehavior,
  type ToolExecutionRegistryEntry,
  type ToolExecutionRegistryLike,
  type ToolInterruptBehavior,
} from './toolBehavior.js';

export {
  ToolKind,
  type ToolBehavior,
  type ToolExecutionRegistryEntry,
  type ToolExecutionRegistryLike,
  type ToolInterruptBehavior,
};

export interface AgentFunctionToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface AgentToolCallCandidate {
  id?: unknown;
  type?: unknown;
  function?: unknown;
}

export type ToolExecutionPermissionMode = 'default' | 'autoEdit' | 'yolo' | 'plan';

export interface ToolExecutionPlan {
  mode: 'parallel' | 'serial' | 'mixed';
  calls: AgentFunctionToolCall[];
  groups?: AgentFunctionToolCall[][];
}

export function shouldRunAgentLoopNonStreamingToolExecution<TExecutionResult>(
  executionResults: readonly TExecutionResult[] | undefined,
): executionResults is undefined {
  return executionResults === undefined;
}

function isAgentFunctionToolCall(call: unknown): call is AgentFunctionToolCall {
  if (!call || typeof call !== 'object') {
    return false;
  }

  const candidate = call as AgentToolCallCandidate;
  if (typeof candidate.id !== 'string' || candidate.type !== 'function') {
    return false;
  }

  if (!candidate.function || typeof candidate.function !== 'object') {
    return false;
  }

  const functionCall = candidate.function as { name?: unknown; arguments?: unknown };
  return typeof functionCall.name === 'string' && typeof functionCall.arguments === 'string';
}

export function selectAgentFunctionToolCalls(
  calls: readonly unknown[] | undefined,
): AgentFunctionToolCall[] {
  return (calls ?? []).filter(isAgentFunctionToolCall);
}

export function planToolExecution(
  calls: AgentFunctionToolCall[],
  registry: ToolExecutionRegistryLike,
  permissionMode?: ToolExecutionPermissionMode,
): ToolExecutionPlan {
  if (calls.length === 1 || permissionMode === 'plan') {
    return {
      mode: 'serial',
      calls,
    };
  }

  if (calls.length === 0) {
    return {
      mode: 'parallel',
      calls,
    };
  }

  const readonlyCalls: AgentFunctionToolCall[] = [];
  const nonReadonlyCalls: AgentFunctionToolCall[] = [];

  for (const call of calls) {
    const tool = registry.get(call.function.name);
    const parsedArgs = parseToolArguments(call.function.arguments);
    const behavior = parsedArgs ? resolveToolBehaviorSafely(tool, parsedArgs) : undefined;

    if (
      (behavior?.isReadOnly && behavior.isConcurrencySafe) ||
      (!behavior && tool?.kind === ToolKind.ReadOnly && tool?.isConcurrencySafe !== false)
    ) {
      readonlyCalls.push(call);
      continue;
    }

    nonReadonlyCalls.push(call);
  }

  if (nonReadonlyCalls.length === 0) {
    return {
      mode: 'parallel',
      calls,
    };
  }

  if (readonlyCalls.length === 0) {
    return {
      mode: 'serial',
      calls,
    };
  }

  const groups: AgentFunctionToolCall[][] = [
    readonlyCalls,
    ...nonReadonlyCalls.map((call) => [call]),
  ];

  return {
    mode: 'mixed',
    calls: [...readonlyCalls, ...nonReadonlyCalls],
    groups,
  };
}

function parseToolArguments(argumentsText: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : undefined;
  } catch {
    return undefined;
  }
}
