import type { Message } from '../../services/ChatServiceInterface.js';
import type { LoopResult, TurnLimitResponse } from '../types.js';

type TurnLimitReachedHandler = (data: { turnsCount: number }) => Promise<TurnLimitResponse>;
type TurnLimitCompactHandler = (ctx: {
  contextMessages: Message[];
}) => Promise<{
  success: boolean;
  compactedMessages?: Message[];
  continueMessage?: Message;
}>;

export type TurnLimitDecision =
  | { action: 'stop'; result: LoopResult }
  | {
      action: 'compact_and_continue';
      compactedMessages?: Message[];
      continueMessage?: Message;
    };

interface DecideTurnLimitInput {
  maxTurns: number;
  turnsCount: number;
  contextMessages: Message[];
  toolCallsCount: number;
  startTime: number;
  totalTokens: number;
  onTurnLimitReached?: TurnLimitReachedHandler;
  onTurnLimitCompact?: TurnLimitCompactHandler;
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
