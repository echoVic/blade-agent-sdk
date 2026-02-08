import { CompactionService } from '../context/CompactionService.js';
import type { ContextManager } from '../context/ContextManager.js';
import { createLogger, LogCategory } from '../logging/Logger.js';
import type { IChatService, Message } from '../services/ChatServiceInterface.js';
import type { ChatContext } from './types.js';

const logger = createLogger(LogCategory.AGENT);

export type CompactionEvent = { type: 'compacting'; isCompacting: boolean };

export class CompactionHandler {
  constructor(
    private getChatService: () => IChatService,
    private getContextManager: () => ContextManager | undefined
  ) {}

  async *checkAndCompactInLoop(
    context: ChatContext,
    currentTurn: number,
    actualPromptTokens?: number
  ): AsyncGenerator<CompactionEvent, boolean> {
    if (actualPromptTokens === undefined) {
      logger.debug(`[Agent] [轮次 ${currentTurn}] 压缩检查: 跳过（无历史 usage 数据）`);
      return false;
    }

    const chatService = this.getChatService();
    const chatConfig = chatService.getConfig();
    const modelName = chatConfig.model;
    const maxContextTokens = chatConfig.maxContextTokens ?? 128000;
    const maxOutputTokens = chatConfig.maxOutputTokens ?? 8192;

    const availableForInput = maxContextTokens - maxOutputTokens;
    const threshold = Math.floor(availableForInput * 0.8);

    logger.debug(`[Agent] [轮次 ${currentTurn}] 压缩检查:`, {
      promptTokens: actualPromptTokens,
      maxContextTokens,
      maxOutputTokens,
      availableForInput,
      threshold,
      shouldCompact: actualPromptTokens >= threshold,
    });

    if (actualPromptTokens < threshold) {
      return false;
    }

    const compactLogPrefix =
      currentTurn === 0
        ? '[Agent] 触发自动压缩'
        : `[Agent] [轮次 ${currentTurn}] 触发循环内自动压缩`;
    logger.debug(compactLogPrefix);

    yield { type: 'compacting', isCompacting: true };

    try {
      const result = await CompactionService.compact(context.messages, {
        trigger: 'auto',
        modelName,
        maxContextTokens,
        apiKey: chatConfig.apiKey,
        baseURL: chatConfig.baseUrl,
        actualPreTokens: actualPromptTokens,
      });

      if (result.success) {
        context.messages = result.compactedMessages;

        logger.debug(
          `[Agent] [轮次 ${currentTurn}] 压缩完成: ${result.preTokens} → ${result.postTokens} tokens (-${((1 - result.postTokens / result.preTokens) * 100).toFixed(1)}%)`
        );
      } else {
        context.messages = result.compactedMessages;

        logger.warn(
          `[Agent] [轮次 ${currentTurn}] 压缩使用降级策略: ${result.preTokens} → ${result.postTokens} tokens`
        );
      }

      try {
        const contextMgr = this.getContextManager();
        if (contextMgr && context.sessionId) {
          await contextMgr.saveCompaction(
            context.sessionId,
            result.summary,
            {
              trigger: 'auto',
              preTokens: result.preTokens,
              postTokens: result.postTokens,
              filesIncluded: result.filesIncluded,
            },
            null
          );
          logger.debug(`[Agent] [轮次 ${currentTurn}] 压缩数据已保存到 JSONL`);
        }
      } catch (saveError) {
        logger.warn(`[Agent] [轮次 ${currentTurn}] 保存压缩数据失败:`, saveError);
      }

      yield { type: 'compacting', isCompacting: false };

      return true;
    } catch (error) {
      yield { type: 'compacting', isCompacting: false };

      logger.error(`[Agent] [轮次 ${currentTurn}] 压缩失败，继续执行`, error);
      return false;
    }
  }

  async compactOnTurnLimit(
    context: ChatContext,
    messages: Message[],
    lastPromptTokens?: number
  ): Promise<{ success: boolean; messages: Message[] }> {
    try {
      const chatService = this.getChatService();
      const chatConfig = chatService.getConfig();
      const compactResult = await CompactionService.compact(context.messages, {
        trigger: 'auto',
        modelName: chatConfig.model,
        maxContextTokens: chatConfig.maxContextTokens ?? 128000,
        apiKey: chatConfig.apiKey,
        baseURL: chatConfig.baseUrl,
        actualPreTokens: lastPromptTokens,
      });

      context.messages = compactResult.compactedMessages;

      const systemMsg = messages.find((m) => m.role === 'system');
      const newMessages: Message[] = [];
      if (systemMsg) {
        newMessages.push(systemMsg);
      }
      newMessages.push(...context.messages);

      const continueMessage: Message = {
        role: 'user',
        content:
          'This session is being continued from a previous conversation. ' +
          'The conversation is summarized above.\n\n' +
          'Please continue the conversation from where we left it off without asking the user any further questions. ' +
          'Continue with the last task that you were asked to work on.',
      };
      newMessages.push(continueMessage);
      context.messages.push(continueMessage);

      try {
        const contextMgr = this.getContextManager();
        if (contextMgr && context.sessionId) {
          await contextMgr.saveCompaction(
            context.sessionId,
            compactResult.summary,
            {
              trigger: 'auto',
              preTokens: compactResult.preTokens,
              postTokens: compactResult.postTokens,
              filesIncluded: compactResult.filesIncluded,
            },
            null
          );
        }
      } catch (saveError) {
        logger.warn('[Agent] 保存压缩数据失败:', saveError);
      }

      logger.info(
        `✅ 上下文已压缩 (${compactResult.preTokens} → ${compactResult.postTokens} tokens)，重置轮次计数`
      );

      return { success: true, messages: newMessages };
    } catch (compactError) {
      logger.error('[Agent] 压缩失败，使用降级策略:', compactError);

      const systemMsg = messages.find((m) => m.role === 'system');
      const recentMessages = messages.slice(-80);
      const newMessages: Message[] = [];
      if (systemMsg && !recentMessages.some((m) => m.role === 'system')) {
        newMessages.push(systemMsg);
      }
      newMessages.push(...recentMessages);
      context.messages = newMessages.filter((m) => m.role !== 'system');

      logger.warn(`⚠️ 降级压缩完成，保留 ${newMessages.length} 条消息`);

      return { success: false, messages: newMessages };
    }
  }
}
