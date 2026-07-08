import type { Message } from '@blade-ai/ai/chat';
import { buildAgentLoopEndEvent, type AgentLoopEndEvent } from './loopEvents.js';

export const AGENT_LOOP_TURN_SAFETY_LIMIT = 100;

export interface TurnLimitResponse {
  continue: boolean;
  reason?: string;
}

export interface TurnLimitStopResult {
  success: boolean;
  error?: {
    type: 'max_turns_exceeded';
    message: string;
    details?: unknown;
  };
  metadata?: {
    turnsCount: number;
    toolCallsCount: number;
    duration: number;
    tokensUsed?: number;
    configuredMaxTurns?: number;
    actualMaxTurns?: number;
  };
}

type TurnLimitReachedHandler = (data: { turnsCount: number }) => Promise<TurnLimitResponse>;
type TurnLimitCompactHandler = (ctx: {
  contextMessages: Message[];
}) => Promise<{
  success: boolean;
  compactedMessages?: Message[];
  continueMessage?: Message;
}>;

export type TurnLimitDecision =
  | { action: 'stop'; result: TurnLimitStopResult }
  | {
      action: 'compact_and_continue';
      compactedMessages?: Message[];
      continueMessage?: Message;
    };

export type TurnLimitStopDecision = Extract<TurnLimitDecision, { action: 'stop' }>;

export interface AgentLoopTurnLimitStopCompletion {
  action: 'stop';
  events: [AgentLoopEndEvent];
  result: TurnLimitStopResult;
}

export interface AgentLoopTurnLimitContinuation {
  shouldReplaceMessages: boolean;
  compactedMessages: Message[];
  appendMessages: Message[];
}

export type AgentLoopApplicableTurnLimitContinuation = AgentLoopTurnLimitContinuation & {
  shouldReplaceMessages: true;
};

export interface DecideTurnLimitInput {
  maxTurns: number;
  turnsCount: number;
  contextMessages: Message[];
  toolCallsCount: number;
  startTime: number;
  totalTokens: number;
  onTurnLimitReached?: TurnLimitReachedHandler;
  onTurnLimitCompact?: TurnLimitCompactHandler;
}

export interface BuildAgentLoopEffectiveMaxTurnsInput {
  maxTurns: number;
  isYoloMode: boolean;
}

export interface ShouldCheckAgentLoopTurnLimitInput {
  turnsCount: number;
  effectiveMaxTurns: number;
  isYoloMode: boolean;
}

export function buildAgentLoopEffectiveMaxTurns(
  input: BuildAgentLoopEffectiveMaxTurnsInput,
): number {
  return input.isYoloMode ? AGENT_LOOP_TURN_SAFETY_LIMIT : input.maxTurns;
}

export function shouldCheckAgentLoopTurnLimit(
  input: ShouldCheckAgentLoopTurnLimitInput,
): boolean {
  return input.turnsCount >= input.effectiveMaxTurns && !input.isYoloMode;
}

export function shouldStopAgentLoopForTurnLimitDecision(
  decision: TurnLimitDecision,
): decision is TurnLimitStopDecision {
  return decision.action === 'stop';
}

export function buildAgentLoopTurnLimitStopCompletion(
  decision: TurnLimitStopDecision,
): AgentLoopTurnLimitStopCompletion {
  return {
    action: 'stop',
    events: [buildAgentLoopEndEvent()],
    result: decision.result,
  };
}

export function buildAgentLoopTurnLimitContinuation(
  decision: TurnLimitDecision,
): AgentLoopTurnLimitContinuation {
  if (decision.action !== 'compact_and_continue' || !decision.compactedMessages) {
    return {
      shouldReplaceMessages: false,
      compactedMessages: [],
      appendMessages: [],
    };
  }

  return {
    shouldReplaceMessages: true,
    compactedMessages: decision.compactedMessages,
    appendMessages: decision.continueMessage ? [decision.continueMessage] : [],
  };
}

export function shouldApplyAgentLoopTurnLimitContinuation(
  continuation: AgentLoopTurnLimitContinuation,
): continuation is AgentLoopApplicableTurnLimitContinuation {
  return continuation.shouldReplaceMessages;
}

export async function decideTurnLimit(
  input: DecideTurnLimitInput,
): Promise<TurnLimitDecision> {
  const {
    maxTurns,
    turnsCount,
    contextMessages,
    toolCallsCount,
    startTime,
    totalTokens,
    onTurnLimitReached,
    onTurnLimitCompact,
  } = input;

  if (onTurnLimitReached) {
    const response = await onTurnLimitReached({ turnsCount });
    if (response?.continue) {
      if (!onTurnLimitCompact) {
        return { action: 'compact_and_continue' };
      }

      const compactResult = await onTurnLimitCompact({
        contextMessages,
      });

      if (compactResult.success && compactResult.compactedMessages) {
        return {
          action: 'compact_and_continue',
          compactedMessages: compactResult.compactedMessages,
          continueMessage: compactResult.continueMessage,
        };
      }

      return { action: 'compact_and_continue' };
    }

    return {
      action: 'stop',
      result: {
        success: true,
        metadata: {
          turnsCount,
          toolCallsCount,
          duration: Date.now() - startTime,
          tokensUsed: totalTokens,
          configuredMaxTurns: maxTurns,
          actualMaxTurns: maxTurns,
        },
      },
    };
  }

  return {
    action: 'stop',
    result: {
      success: false,
      error: {
        type: 'max_turns_exceeded',
        message: `达到最大轮次限制 (${maxTurns})`,
      },
      metadata: {
        turnsCount,
        toolCallsCount,
        duration: Date.now() - startTime,
        tokensUsed: totalTokens,
      },
    },
  };
}
