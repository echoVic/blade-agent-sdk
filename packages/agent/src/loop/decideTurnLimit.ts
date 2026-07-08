import type { Message } from '@blade-ai/ai/chat';

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
