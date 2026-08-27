import type { ConversationMessage } from '../../model/conversation.js';
import type { LoopResult, TurnLimitResponse } from '../types.js';

type TurnLimitReachedHandler = (data: { turnsCount: number }) => Promise<TurnLimitResponse>;
type TurnLimitCompactHandler = (ctx: { contextMessages: ConversationMessage[] }) => Promise<{
  success: boolean;
  compactedMessages?: ConversationMessage[];
  continueMessage?: ConversationMessage;
}>;

export type TurnLimitDecision =
  | { action: 'stop'; result: LoopResult }
  | {
      action: 'compact_and_continue';
      compactedMessages?: ConversationMessage[];
      continueMessage?: ConversationMessage;
    };

interface DecideTurnLimitInput {
  maxTurns: number;
  turnsCount: number;
  totalTurnsCount: number;
  contextMessages: ConversationMessage[];
  toolCallsCount: number;
  startTime: number;
  totalTokens: number;
  onTurnLimitReached?: TurnLimitReachedHandler;
  onTurnLimitCompact?: TurnLimitCompactHandler;
}

export async function decideTurnLimit(input: DecideTurnLimitInput): Promise<TurnLimitDecision> {
  const {
    maxTurns,
    turnsCount,
    totalTurnsCount,
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
          turnsCount: totalTurnsCount,
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
        turnsCount: totalTurnsCount,
        toolCallsCount,
        duration: Date.now() - startTime,
        tokensUsed: totalTokens,
      },
    },
  };
}
