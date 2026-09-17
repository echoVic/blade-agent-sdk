import { CompactionService } from '../context/CompactionService.js';
import type { ContextManager } from '../context/ContextManager.js';
import { softCompact } from '../context/strategies/SoftCompactionStrategy.js';
import { TokenCounter } from '../context/TokenCounter.js';
import { ProviderRegistryError } from '../errors/ProviderRegistryError.js';
import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../logging/Logger.js';
import type { ModelService } from '../model/service.js';
import { cloneMessage } from '../services/messageUtils.js';
import type { ProviderRegistry } from '../services/ProviderRegistry.js';
import {
  isExecutionLeaseFailure,
  runWithExecutionLeaseBoundary,
} from '../session/events/DurableExecutionLeaseStore.js';
import type { SessionId } from '../types/identifiers.js';
import type { CompactingEvent } from './AgentEvent.js';
import type { ConversationState } from './state/ConversationState.js';

export interface CompactionRuntimeContext {
  sessionId: SessionId;
  projectDir?: string;
  filesystemRoots?: readonly string[];
  signal?: AbortSignal;
  assertExecutionLease?: () => Promise<void>;
  runWithExecutionLease?: <T>(operation: () => Promise<T>) => Promise<T>;
}

export class CompactionHandler {
  private readonly logger: InternalLogger;

  constructor(
    private getModelService: () => ModelService,
    private getContextManager: () => ContextManager | undefined,
    logger?: InternalLogger,
    private getProviderRegistry: () => ProviderRegistry | undefined = () => undefined,
  ) {
    this.logger = (logger ?? NOOP_LOGGER).child(LogCategory.AGENT);
  }

  async *checkAndCompactInLoop(
    convState: ConversationState,
    runtimeCtx: CompactionRuntimeContext,
    currentTurn: number,
    actualPromptTokens?: number,
  ): AsyncGenerator<CompactingEvent, boolean> {
    if (actualPromptTokens === undefined) {
      this.logger.debug(`[Agent] [轮次 ${currentTurn}] 压缩检查: 跳过（无历史 usage 数据）`);
      return false;
    }

    const modelService = this.getModelService();
    const modelConfig = modelService.getConfig();
    const modelName = modelConfig.model;
    const maxContextTokens = modelConfig.maxContextTokens ?? 128000;
    const maxOutputTokens = modelConfig.maxOutputTokens ?? 8192;

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

    const microcompactResult = CompactionService.microcompact(convState.getContextMessages(), {
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
      convState.replaceContent(microcompactResult.messages);
      effectivePromptTokens = TokenCounter.countTokens(convState.getContextMessages(), modelName);
      this.logger.debug(
        `[Agent] [轮次 ${currentTurn}] microcompact 完成: 替换 ${microcompactResult.replacedCount} 条工具结果, 节省 ${microcompactResult.savedChars} 字符, 估算 tokens ${actualPromptTokens} → ${effectivePromptTokens}`,
      );

      if (effectivePromptTokens < threshold) {
        return true;
      }
    }

    // Tier 3: Emergency — keep only system message + recent messages
    if (effectivePromptTokens >= emergencyThreshold) {
      this.logger.warn(
        `[Agent] [轮次 ${currentTurn}] 紧急压缩触发 (${effectivePromptTokens} tokens >= 95%)`,
      );
      yield { type: 'compacting', isCompacting: true };

      const recentMessages = convState.getContextMessages().slice(-40);
      convState.replaceContent(recentMessages);

      yield { type: 'compacting', isCompacting: false };
      return true;
    }

    if (effectivePromptTokens >= threshold) {
      return yield* this.compactWithModel(convState, runtimeCtx, currentTurn, actualPromptTokens);
    }

    // Tier 1: Soft compaction — truncate large tool outputs, no LLM call
    const softResult = softCompact(convState.getContextMessages());
    if (softResult.truncatedCount > 0) {
      convState.replaceContent(softResult.messages);
      this.logger.debug(
        `[Agent] [轮次 ${currentTurn}] 软压缩完成: 截断 ${softResult.truncatedCount} 条工具结果, 节省 ${softResult.savedChars} 字符`,
      );
    }
    return false;
  }

  private async *compactWithModel(
    convState: ConversationState,
    runtimeCtx: CompactionRuntimeContext,
    currentTurn: number,
    actualPromptTokens: number,
  ): AsyncGenerator<CompactingEvent, boolean> {
    this.logger.debug(
      currentTurn === 0
        ? '[Agent] 触发自动压缩'
        : `[Agent] [轮次 ${currentTurn}] 触发循环内自动压缩`,
    );
    yield { type: 'compacting', isCompacting: true };
    await runtimeCtx.assertExecutionLease?.();
    try {
      const config = this.getModelService().getConfig();
      const result = await CompactionService.compact(convState.getContextMessages(), {
        trigger: 'auto',
        provider: config.provider,
        providerId: config.providerId,
        providerRegistry: this.getProviderRegistry(),
        modelName: config.model,
        maxContextTokens: config.maxContextTokens ?? 128000,
        apiKey: config.apiKey,
        baseURL: config.baseUrl,
        customHeaders: config.customHeaders,
        actualPreTokens: actualPromptTokens,
        projectDir: runtimeCtx.projectDir,
        filesystemRoots: runtimeCtx.filesystemRoots,
        signal: runtimeCtx.signal,
        assertExecutionLease: runtimeCtx.assertExecutionLease,
      });
      runtimeCtx.signal?.throwIfAborted();
      await runtimeCtx.assertExecutionLease?.();
      convState.replaceContent(result.compactedMessages);
      const message = `${result.preTokens} → ${result.postTokens} tokens`;
      if (result.success) this.logger.debug(`[Agent] [轮次 ${currentTurn}] 压缩完成: ${message}`);
      else this.logger.warn(`[Agent] [轮次 ${currentTurn}] 压缩使用降级策略: ${message}`);
      await this.saveCompaction(runtimeCtx, result, currentTurn);
      yield { type: 'compacting', isCompacting: false };
      return true;
    } catch (error) {
      if (
        runtimeCtx.signal?.aborted ||
        isExecutionLeaseFailure(error) ||
        error instanceof ProviderRegistryError
      ) {
        throw error;
      }
      yield { type: 'compacting', isCompacting: false };
      this.logger.error(`[Agent] [轮次 ${currentTurn}] 压缩失败，继续执行`, error);
      return false;
    }
  }

  async *reactiveCompact(
    convState: ConversationState,
    runtimeCtx: CompactionRuntimeContext,
  ): AsyncGenerator<CompactingEvent, boolean> {
    this.logger.warn('[Agent] 反应式压缩触发 (context length error)');
    await runtimeCtx.assertExecutionLease?.();
    yield { type: 'compacting', isCompacting: true };
    const originalMessages = convState.getContextMessages().map(cloneMessage);
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
          this.getModelService().getConfig().model,
        );
        this.logger.debug(
          `[Agent] reactive microcompact: 替换 ${microcompactResult.replacedCount} 条, 估算 tokens → ${postMicrocompactTokens}`,
        );

        const maxOutputTokens = this.getModelService().getConfig().maxOutputTokens ?? 8192;
        const availableForInput =
          (this.getModelService().getConfig().maxContextTokens ?? 128000) - maxOutputTokens;
        if (postMicrocompactTokens < availableForInput) {
          convState.replaceContent(workingMessages);
          yield { type: 'compacting', isCompacting: false };
          return true;
        }
      }

      // Step 1.5: Aggressive soft compaction first
      const softResult = softCompact(workingMessages, { maxToolResultLength: 500 });
      if (softResult.truncatedCount > 0) {
        workingMessages = softResult.messages;
        this.logger.debug(
          `[Agent] 反应式软压缩: 截断 ${softResult.truncatedCount} 条, 节省 ${softResult.savedChars} 字符`,
        );
      }

      // Step 2: LLM-based compaction
      const modelService = this.getModelService();
      const modelConfig = modelService.getConfig();
      const result = await CompactionService.compact(workingMessages, {
        trigger: 'auto',
        provider: modelConfig.provider,
        providerId: modelConfig.providerId,
        providerRegistry: this.getProviderRegistry(),
        modelName: modelConfig.model,
        maxContextTokens: modelConfig.maxContextTokens ?? 128000,
        apiKey: modelConfig.apiKey,
        baseURL: modelConfig.baseUrl,
        customHeaders: modelConfig.customHeaders,
        projectDir: runtimeCtx.projectDir,
        filesystemRoots: runtimeCtx.filesystemRoots,
        signal: runtimeCtx.signal,
        assertExecutionLease: runtimeCtx.assertExecutionLease,
      });
      runtimeCtx.signal?.throwIfAborted();
      await runtimeCtx.assertExecutionLease?.();

      convState.replaceContent(result.compactedMessages);

      await this.saveCompaction(runtimeCtx, result);

      yield { type: 'compacting', isCompacting: false };
      return true;
    } catch (error) {
      if (
        runtimeCtx.signal?.aborted ||
        isExecutionLeaseFailure(error) ||
        error instanceof ProviderRegistryError
      ) {
        throw error;
      }
      // Fallback: emergency truncation
      this.logger.error('[Agent] 反应式压缩失败，使用紧急截断:', error);
      const recentMessages = originalMessages.slice(-40);
      convState.replaceContent(recentMessages);

      yield { type: 'compacting', isCompacting: false };
      return true;
    }
  }

  private async saveCompaction(
    runtimeCtx: CompactionRuntimeContext,
    result: {
      summary: string;
      preTokens: number;
      postTokens: number;
      filesIncluded: string[];
    },
    currentTurn?: number,
  ): Promise<void> {
    try {
      const manager = this.getContextManager();
      if (!manager) return;
      await runWithExecutionLeaseBoundary(runtimeCtx, () =>
        manager.saveCompaction(
          runtimeCtx.sessionId,
          result.summary,
          {
            trigger: 'auto',
            preTokens: result.preTokens,
            postTokens: result.postTokens,
            filesIncluded: result.filesIncluded,
          },
          null,
        ),
      );
      if (currentTurn !== undefined) {
        this.logger.debug(`[Agent] [轮次 ${currentTurn}] 压缩数据已保存到 JSONL`);
      }
    } catch (error) {
      if (runtimeCtx.signal?.aborted || isExecutionLeaseFailure(error)) throw error;
      this.logger.warn('[Agent] 保存压缩数据失败:', error);
    }
  }
}
