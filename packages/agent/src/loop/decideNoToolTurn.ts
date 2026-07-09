import type { Message } from '@blade-ai/ai/chat';
import {
  buildAgentLoopTurnEndEvent,
  type AgentLoopEndEvent,
  type AgentLoopTurnEndEvent,
} from './loopEvents.js';
import {
  emitAgentLoopResponseEventsFromTurnResult,
  type AgentLoopResponseEvent,
} from './responseEvents.js';
import {
  type AgentLoopSuccessResult,
  buildAgentLoopNoToolSuccessDecision,
  buildAgentLoopNoToolSuccessDecisionInputFromLoopState,
  type AgentLoopNoToolSuccessDecision,
  type AgentLoopNoToolSuccessTimingSource,
  type AgentLoopNoToolSuccessTokenBudgetLike,
  type AgentLoopNoToolSuccessTokenUsageTrackerLike,
  type AgentLoopNoToolSuccessToolResultTrackerLike,
} from './loopResult.js';

const INCOMPLETE_INTENT_PATTERNS = [
  /：\s*$/,
  /:\s*$/,
  /\.\.\.\s*$/,
  /让我(先|来|开始|查看|检查|修复)/,
  /Let me (first|start|check|look|fix)/i,
];

export const RETRY_PROMPT = '请执行你提到的操作，不要只是描述。';
export const DEFAULT_CONTINUE_REMINDER =
  '\n\n<system-reminder>\n'
  + 'Please continue the conversation from where we left it off without asking the user any further questions. '
  + 'Continue with the last task that you were asked to work on.\n'
  + '</system-reminder>';

export type StopCheck = (ctx: {
  content: string;
  turn: number;
}) => Promise<{ shouldStop: boolean; continueReason?: string; warning?: string }>;

export type NoToolTurnDecision =
  | { action: 'retry'; message: Message }
  | { action: 'continue_with_reminder'; message: Message; warning?: string }
  | { action: 'finish' };

export type NoToolTurnContinuationDecision = Extract<NoToolTurnDecision, { message: Message }>;

export interface AgentLoopNoToolContentInput {
  content?: string;
}

export interface AgentLoopNoToolDecisionInput {
  content: string;
  messages: readonly Message[];
  turn: number;
  onStopCheck?: StopCheck;
}

export interface AgentLoopNoToolConversationLike {
  toArray(): readonly Message[];
}

export interface AgentLoopNoToolDecisionConversationInput {
  content: string;
  conversation: AgentLoopNoToolConversationLike;
  turn: number;
  check?: StopCheck;
}

export interface AgentLoopNoToolDecisionHookContainerInput {
  content: string;
  conversation: AgentLoopNoToolConversationLike;
  turn: number;
  hooks?: AgentLoopNoToolStopHookContainer | null;
}

export interface AgentLoopNoToolStopHooksInput {
  check?: StopCheck;
}

export interface AgentLoopNoToolStopHookContainer {
  stop?: {
    check?: StopCheck;
  } | null;
}

export interface AgentLoopNoToolStopHooks {
  onStopCheck?: StopCheck;
}

export interface AgentLoopNoToolContinuationInput {
  decision: NoToolTurnContinuationDecision;
  turn: number;
}

export interface AgentLoopNoToolCompletePayloadInput {
  content: string;
  turn: number;
}

export interface AgentLoopNoToolCompletePayload {
  content: string;
  turn: number;
}

export interface AgentLoopNoToolCompleteHookContainer {
  message?: {
    onComplete?: (payload: AgentLoopNoToolCompletePayload) => Promise<void> | void;
  } | null;
}

export interface AgentLoopNoToolContinuation {
  action: 'continue';
  message: Message;
  warning?: string;
  events: [AgentLoopTurnEndEvent];
}

export interface AgentLoopNoToolContinuationConversationLike {
  append(...messages: Message[]): void;
}

export interface ApplyAgentLoopNoToolContinuationInput {
  conversation: AgentLoopNoToolContinuationConversationLike;
  continuation: AgentLoopNoToolContinuation;
}

export interface RunAgentLoopNoToolCompleteHookInput
  extends AgentLoopNoToolCompletePayloadInput {
  hooks?: AgentLoopNoToolCompleteHookContainer | null;
}

export interface AgentLoopToolCallResponseLike {
  toolCalls?: readonly unknown[];
}

export interface AgentLoopNoToolTurnResponseLike {
  content?: string;
}

export interface HandleAgentLoopNoToolTurnInput<TSnapshot = unknown> {
  response: AgentLoopNoToolTurnResponseLike;
  conversation: AgentLoopNoToolConversationLike & AgentLoopNoToolContinuationConversationLike;
  turn: number;
  hooks?: (AgentLoopNoToolStopHookContainer & AgentLoopNoToolCompleteHookContainer) | null;
  loopClock: AgentLoopNoToolSuccessTimingSource;
  toolResultTracker: AgentLoopNoToolSuccessToolResultTrackerLike;
  tokenUsageTracker: AgentLoopNoToolSuccessTokenUsageTrackerLike;
  tokenBudget?: AgentLoopNoToolSuccessTokenBudgetLike<TSnapshot>;
}

export interface HandleAgentLoopResponseNoToolGateInput<
  TSnapshot = unknown,
  StreamingExecutionResult = unknown,
> extends HandleAgentLoopNoToolTurnInput<TSnapshot> {
  response: AgentLoopNoToolTurnResponseLike &
    AgentLoopToolCallResponseLike & {
      reasoningContent?: string;
    };
  signal?: AbortSignal;
  streamingExecutionResults: readonly StreamingExecutionResult[] | undefined;
}

export type AgentLoopNoToolTurnHandling =
  | {
      action: 'continue';
      content: string;
      decision: NoToolTurnContinuationDecision;
      continuation: AgentLoopNoToolContinuation;
    }
  | {
      action: 'finish';
      content: string;
      decision: Extract<NoToolTurnDecision, { action: 'finish' }>;
      completionPayload: AgentLoopNoToolCompletePayload;
      successDecision: AgentLoopNoToolSuccessDecision;
    };

export type AgentLoopNoToolTurnEvent = AgentLoopTurnEndEvent | AgentLoopEndEvent;

export type AgentLoopNoToolTurnEmissionHandling =
  | {
      action: 'continue';
    }
  | {
      action: 'finish';
      result: AgentLoopSuccessResult;
    };

export type AgentLoopResponseNoToolGateEvent =
  | AgentLoopResponseEvent
  | AgentLoopNoToolTurnEvent;

export type AgentLoopResponseNoToolGateHandling =
  | {
      action: 'continue_tool';
    }
  | {
      action: 'continue_loop';
    }
  | {
      action: 'finish';
      result: AgentLoopSuccessResult;
    };

export function shouldHandleAgentLoopNoToolTurn(
  response: AgentLoopToolCallResponseLike,
): boolean {
  return !response.toolCalls || response.toolCalls.length === 0;
}

export function buildAgentLoopNoToolContent(input: AgentLoopNoToolContentInput): string {
  return input.content || '';
}

export function buildAgentLoopNoToolDecisionInput(
  input: AgentLoopNoToolDecisionInput,
): AgentLoopNoToolDecisionInput {
  return {
    content: input.content,
    messages: input.messages,
    turn: input.turn,
    onStopCheck: input.onStopCheck,
  };
}

export function buildAgentLoopNoToolDecisionInputFromConversation(
  input: AgentLoopNoToolDecisionConversationInput,
): AgentLoopNoToolDecisionInput {
  return buildAgentLoopNoToolDecisionInput({
    content: input.content,
    messages: input.conversation.toArray(),
    turn: input.turn,
    ...buildAgentLoopNoToolStopHooksInput({ check: input.check }),
  });
}

export function buildAgentLoopNoToolDecisionInputFromHookContainer(
  input: AgentLoopNoToolDecisionHookContainerInput,
): AgentLoopNoToolDecisionInput {
  return buildAgentLoopNoToolDecisionInputFromConversation({
    content: input.content,
    conversation: input.conversation,
    turn: input.turn,
    check: input.hooks?.stop?.check,
  });
}

export function buildAgentLoopNoToolStopHooksInput(
  input: AgentLoopNoToolStopHooksInput,
): AgentLoopNoToolStopHooks {
  return {
    onStopCheck: input.check,
  };
}

export function shouldContinueAgentLoopAfterNoToolDecision(
  decision: NoToolTurnDecision,
): decision is NoToolTurnContinuationDecision {
  return decision.action === 'retry' || decision.action === 'continue_with_reminder';
}

export function buildAgentLoopNoToolContinuation(
  input: AgentLoopNoToolContinuationInput,
): AgentLoopNoToolContinuation {
  return {
    action: 'continue',
    message: input.decision.message,
    warning: input.decision.action === 'continue_with_reminder' ? input.decision.warning : undefined,
    events: [buildAgentLoopTurnEndEvent({ turn: input.turn, hasToolCalls: false })],
  };
}

export function applyAgentLoopNoToolContinuation(
  input: ApplyAgentLoopNoToolContinuationInput,
): AgentLoopNoToolContinuation {
  input.conversation.append(input.continuation.message);
  return input.continuation;
}

export function buildAgentLoopNoToolCompletePayload(
  input: AgentLoopNoToolCompletePayloadInput,
): AgentLoopNoToolCompletePayload {
  return {
    content: input.content,
    turn: input.turn,
  };
}

export async function runAgentLoopNoToolCompleteHook(
  input: RunAgentLoopNoToolCompleteHookInput,
): Promise<AgentLoopNoToolCompletePayload> {
  const payload = buildAgentLoopNoToolCompletePayload(input);
  await input.hooks?.message?.onComplete?.(payload);
  return payload;
}

export async function handleAgentLoopNoToolTurn(
  input: HandleAgentLoopNoToolTurnInput,
): Promise<AgentLoopNoToolTurnHandling> {
  const content = buildAgentLoopNoToolContent({ content: input.response.content });
  const decision = await decideAgentLoopNoToolTurn(
    buildAgentLoopNoToolDecisionInputFromHookContainer({
      content,
      conversation: input.conversation,
      turn: input.turn,
      hooks: input.hooks,
    }),
  );

  if (shouldContinueAgentLoopAfterNoToolDecision(decision)) {
    return {
      action: 'continue',
      content,
      decision,
      continuation: applyAgentLoopNoToolContinuation({
        conversation: input.conversation,
        continuation: buildAgentLoopNoToolContinuation({
          decision,
          turn: input.turn,
        }),
      }),
    };
  }

  const completionPayload = await runAgentLoopNoToolCompleteHook({
    content,
    turn: input.turn,
    hooks: input.hooks,
  });

  return {
    action: 'finish',
    content,
    decision,
    completionPayload,
    successDecision: buildAgentLoopNoToolSuccessDecision(
      buildAgentLoopNoToolSuccessDecisionInputFromLoopState({
        finalMessage: content,
        loopClock: input.loopClock,
        turnsCount: input.turn,
        toolResultTracker: input.toolResultTracker,
        tokenUsageTracker: input.tokenUsageTracker,
        tokenBudget: input.tokenBudget,
      }),
    ),
  };
}

export async function* handleAgentLoopNoToolTurnWithEmissions(
  input: HandleAgentLoopNoToolTurnInput,
): AsyncGenerator<AgentLoopNoToolTurnEvent, AgentLoopNoToolTurnEmissionHandling> {
  const handling = await handleAgentLoopNoToolTurn(input);
  if (handling.action === 'continue') {
    for (const event of handling.continuation.events) {
      yield event;
    }
    return { action: 'continue' };
  }

  for (const event of handling.successDecision.events) {
    yield event;
  }
  return {
    action: 'finish',
    result: handling.successDecision.result,
  };
}

export async function* handleAgentLoopResponseNoToolGateWithEmissions<
  TSnapshot = unknown,
  StreamingExecutionResult = unknown,
>(
  input: HandleAgentLoopResponseNoToolGateInput<TSnapshot, StreamingExecutionResult>,
): AsyncGenerator<AgentLoopResponseNoToolGateEvent, AgentLoopResponseNoToolGateHandling> {
  yield* emitAgentLoopResponseEventsFromTurnResult({
    response: input.response,
    signal: input.signal,
    streamingExecutionResults: input.streamingExecutionResults,
  });

  if (!shouldHandleAgentLoopNoToolTurn(input.response)) {
    return { action: 'continue_tool' };
  }

  const noToolHandling = yield* handleAgentLoopNoToolTurnWithEmissions(input);
  if (noToolHandling.action === 'continue') {
    return { action: 'continue_loop' };
  }

  return noToolHandling;
}

function isIncompleteIntent(content: string): boolean {
  return INCOMPLETE_INTENT_PATTERNS.some((pattern) => pattern.test(content));
}

function countRecentRetries(messages: readonly Message[]): number {
  return messages
    .slice(-10)
    .filter((message) => message.role === 'user' && message.content === RETRY_PROMPT)
    .length;
}

export async function decideNoToolTurn(
  content: string,
  messages: readonly Message[],
  turn: number,
  onStopCheck?: StopCheck,
): Promise<NoToolTurnDecision> {
  if (isIncompleteIntent(content) && countRecentRetries(messages) < 2) {
    return {
      action: 'retry',
      message: { role: 'user', content: RETRY_PROMPT },
    };
  }

  if (!onStopCheck) {
    return { action: 'finish' };
  }

  const stopResult = await onStopCheck({ content, turn });
  if (stopResult.shouldStop) {
    return { action: 'finish' };
  }

  const reminder = stopResult.continueReason
    ? `\n\n<system-reminder>\n${stopResult.continueReason}\n</system-reminder>`
    : DEFAULT_CONTINUE_REMINDER;

  return {
    action: 'continue_with_reminder',
    message: { role: 'user', content: reminder },
    warning: stopResult.warning,
  };
}

export async function decideAgentLoopNoToolTurn(
  input: AgentLoopNoToolDecisionInput,
): Promise<NoToolTurnDecision> {
  return decideNoToolTurn(input.content, input.messages, input.turn, input.onStopCheck);
}
