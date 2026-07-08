import type { Message } from '@blade-ai/ai/chat';
import {
  buildAgentLoopTurnEndEvent,
  type AgentLoopTurnEndEvent,
} from './loopEvents.js';

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

export interface AgentLoopNoToolStopHooksInput {
  check?: StopCheck;
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
