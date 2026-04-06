import { CompactionService } from '../context/CompactionService.js';
import type { ContextManager } from '../context/ContextManager.js';
import { softCompact } from '../context/strategies/SoftCompactionStrategy.js';
import { TokenCounter } from '../context/TokenCounter.js';
import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../logging/Logger.js';
import type { IChatService, Message } from '../services/ChatServiceInterface.js';
import { cloneMessage } from '../services/messageUtils.js';
import type { CompactingEvent } from './AgentEvent.js';
import type { ChatContext } from './types.js';

export class CompactionHandler {
  private readonly logger: InternalLogger;

  constructor(
    private getChatService: () => IChatService,
    private getContextManager: () => ContextManager | undefined,
    logger?: InternalLogger,
  ) {
    this.logger = (logger ?? NOOP_LOGGER).child(LogCategory.AGENT);
  }

  async *checkAndCompactInLoop(
    context: ChatContext,
    currentTurn: number,
    actualPromptTokens?: number
  ): AsyncGenerator<CompactingEvent, boolean> {
    if (actualPromptTokens === undefined) {
      this.logger.debug(`[Agent] [轮次 ${currentTurn}] 压缩检查: 跳过（无历史 usage 数据）`);
      return false;
    }

    const chatService = this.getChatService();
    const chatConfig = chatService.getConfig();
    const modelName = chatConfig.model;
    const maxContextTokens = chatConfig.maxContextTokens ?? 128000;
    const maxOutputTokens = chatConfig.maxOutputTokens ?? 8192;

    const availableForInput = maxContextTokens - maxOutputTokens;
    const softThreshold = Math.floor(availableForInput * 0.6);
    const threshold = Math.floor(availableForInput * 0.8);
    const emergencyThreshold = Math.floor(availableForInput * 0.95);
    let effectivePromptTokens = actualPromptTokens;

    this.logger.debug(`[Agent] [轮次 ${currentTurn}] 压缩检查:`, {
      promptTokens: actualPromptTokens,
      maxContextTokens,
      maxOutputTokens,
      availableForInput,
      softThreshold,
      threshold,
      emergencyThreshold,
      shouldCompact: actualPromptTokens >= softThreshold,
    });

    if (actualPromptTokens < softThreshold) {
      return false;
    }

    const microcompactResult = CompactionService.microcompact(context.messages, {
      preserveRecentToolMessages: 1,
      minToolContentLength: 1500,
      previewLength: 160,
    });
    if (microcompactResult.skippedNonStringToolMessages > 0) {
      this.logger.debug(
        `[Agent] [轮次 ${currentTurn}] microcompact 跳过 ${microcompactResult.skippedNonStringToolMessages} 条非字符串 tool message`,
      );
    }
    if (microcompactResult.replacedCount > 0) {
      context.messages = microcompactResult.messages;
      effectivePromptTokens = TokenCounter.countTokens(context.messages, modelName);
      this.logger.debug(
        `[Agent] [轮次 ${currentTurn}] microcompact 完成: 替换 ${microcompactResult.replacedCount} 条工具结果, 节省 ${microcompactResult.savedChars} 字符, 估算 tokens ${actualPromptTokens} → ${effectivePromptTokens}`,
      );

      if (effectivePromptTokens < threshold) {
        return true;
      }
    }

    // Tier 3: Emergency — keep only system message + recent messages
    if (effectivePromptTokens >= emergencyThreshold) {
      this.logger.warn(`[Agent] [轮次 ${currentTurn}] 紧急压缩触发 (${effectivePromptTokens} tokens >= 95%)`);
      yield { type: 'compacting', isCompacting: true };

      const systemMsg = context.messages.find((m) => m.role === 'system');
      const recentMessages = context.messages.slice(-40);
      const newMessages: Message[] = [];
      if (systemMsg && !recentMessages.includes(systemMsg)) {
        newMessages.push(systemMsg);
      }
      newMessages.push(...recentMessages);
      context.messages = newMessages;

      yield { type: 'compacting', isCompacting: false };
      return true;
    }

    // Tier 2: LLM-based compaction (existing logic)
    if (effectivePromptTokens >= threshold) {
      const compactLogPrefix =
        currentTurn === 0
          ? '[Agent] 触发自动压缩'
          : `[Agent] [轮次 ${currentTurn}] 触发循环内自动压缩`;
      this.logger.debug(compactLogPrefix);

      yield { type: 'compacting', isCompacting: true };

      try {
        const result = await CompactionService.compact(context.messages, {
          trigger: 'auto',
          provider: chatConfig.provider,
          modelName,
          maxContextTokens,
          apiKey: chatConfig.apiKey,
          baseURL: chatConfig.baseUrl,
          customHeaders: chatConfig.customHeaders,
          actualPreTokens: actualPromptTokens,
          projectDir: context.snapshot?.cwd,
        });

        if (result.success) {
          context.messages = result.compactedMessages;

          this.logger.debug(
            `[Agent] [轮次 ${currentTurn}] 压缩完成: ${result.preTokens} → ${result.postTokens} tokens (-${((1 - result.postTokens / result.preTokens) * 100).toFixed(1)}%)`
          );
        } else {
          context.messages = result.compactedMessages;

          this.logger.warn(
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
            this.logger.debug(`[Agent] [轮次 ${currentTurn}] 压缩数据已保存到 JSONL`);
          }
        } catch (saveError) {
          this.logger.warn(`[Agent] [轮次 ${currentTurn}] 保存压缩数据失败:`, saveError);
        }

        yield { type: 'compacting', isCompacting: false };

        return true;
      } catch (error) {
        yield { type: 'compacting', isCompacting: false };

        this.logger.error(`[Agent] [轮次 ${currentTurn}] 压缩失败，继续执行`, error);
        return false;
      }
    }

    // Tier 1: Soft compaction — truncate large tool outputs, no LLM call
    const softResult = softCompact(context.messages);
    if (softResult.truncatedCount > 0) {
      context.messages = softResult.messages;
      this.logger.debug(
        `[Agent] [轮次 ${currentTurn}] 软压缩完成: 截断 ${softResult.truncatedCount} 条工具结果, 节省 ${softResult.savedChars} 字符`
      );
    }
    return false;
  }

  async *reactiveCompact(
    context: ChatContext,
  ): AsyncGenerator<CompactingEvent, boolean> {
    this.logger.warn('[Agent] 反应式压缩触发 (context length error)');
    yield { type: 'compacting', isCompacting: true };
    const originalMessages = context.messages.map(cloneMessage);
    let workingMessages = originalMessages.map(cloneMessage);

    try {
      // Step 1: Aggressive soft compaction first
      const microcompactResult = CompactionService.microcompact(workingMessages, {
        preserveRecentToolMessages: 1,
        minToolContentLength: 1000,
        previewLength: 120,
      });
      if (microcompactResult.skippedNonStringToolMessages > 0) {
        this.logger.debug(
          `[Agent] reactive microcompact 跳过 ${microcompactResult.skippedNonStringToolMessages} 条非字符串 tool message`,
        );
      }
      if (microcompactResult.replacedCount > 0) {
        workingMessages = microcompactResult.messages;
        const postMicrocompactTokens = TokenCounter.countTokens(
          workingMessages,
          this.getChatService().getConfig().model,
        );
        this.logger.debug(
          `[Agent] reactive microcompact: 替换 ${microcompactResult.replacedCount} 条, 估算 tokens → ${postMicrocompactTokens}`,
        );

        const maxOutputTokens = this.getChatService().getConfig().maxOutputTokens ?? 8192;
        const availableForInput =
          (this.getChatService().getConfig().maxContextTokens ?? 128000) - maxOutputTokens;
        if (postMicrocompactTokens < availableForInput) {
          context.messages = workingMessages;
          yield { type: 'compacting', isCompacting: false };
          return true;
        }
      }

      // Step 1.5: Aggressive soft compaction first
      const softResult = softCompact(workingMessages, { maxToolResultLength: 500 });
      if (softResult.truncatedCount > 0) {
        workingMessages = softResult.messages;
        this.logger.debug(
          `[Agent] 反应式软压缩: 截断 ${softResult.truncatedCount} 条, 节省 ${softResult.savedChars} 字符`
        );
      }

      // Step 2: LLM-based compaction
      const chatService = this.getChatService();
      const chatConfig = chatService.getConfig();
      const result = await CompactionService.compact(workingMessages, {
        trigger: 'auto',
        provider: chatConfig.provider,
        modelName: chatConfig.model,
        maxContextTokens: chatConfig.maxContextTokens ?? 128000,
        apiKey: chatConfig.apiKey,
        baseURL: chatConfig.baseUrl,
        customHeaders: chatConfig.customHeaders,
        projectDir: context.snapshot?.cwd,
      });

      context.messages = result.compactedMessages;

      // Save to JSONL
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
            null,
          );
        }
      } catch (saveError) {
        this.logger.warn('[Agent] 保存反应式压缩数据失败:', saveError);
      }

      yield { type: 'compacting', isCompacting: false };
      return true;
    } catch (error) {
      // Fallback: emergency truncation
      this.logger.error('[Agent] 反应式压缩失败，使用紧急截断:', error);
      const systemMsg = originalMessages.find((m) => m.role === 'system');
      const recentMessages = originalMessages.slice(-40);
      const newMessages: Message[] = [];
      if (systemMsg && !recentMessages.includes(systemMsg)) {
        newMessages.push(systemMsg);
      }
      newMessages.push(...recentMessages);
      context.messages = newMessages;

      yield { type: 'compacting', isCompacting: false };
      return true;
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
        provider: chatConfig.provider,
        modelName: chatConfig.model,
        maxContextTokens: chatConfig.maxContextTokens ?? 128000,
        apiKey: chatConfig.apiKey,
        baseURL: chatConfig.baseUrl,
        customHeaders: chatConfig.customHeaders,
        actualPreTokens: lastPromptTokens,
        projectDir: context.snapshot?.cwd,
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
          this.logger.warn('[Agent] 保存压缩数据失败:', saveError);
      }

      this.logger.info(
        `✅ 上下文已压缩 (${compactResult.preTokens} → ${compactResult.postTokens} tokens)，重置轮次计数`
      );

      return { success: true, messages: newMessages };
    } catch (compactError) {
      this.logger.error('[Agent] 压缩失败，使用降级策略:', compactError);

      const systemMsg = messages.find((m) => m.role === 'system');
      const recentMessages = messages.slice(-80);
      const newMessages: Message[] = [];
      if (systemMsg && !recentMessages.some((m) => m.role === 'system')) {
        newMessages.push(systemMsg);
      }
      newMessages.push(...recentMessages);
      context.messages = newMessages.filter((m) => m.role !== 'system');

      this.logger.warn(`⚠️ 降级压缩完成，保留 ${newMessages.length} 条消息`);

      return { success: false, messages: newMessages };
    }
  }
}
