/**
 * PlanExecutor — Plan 模式的 prompt 注入和循环管理
 *
 * 从 Agent.ts 拆分，职责单一：处理 Plan 模式的差异化逻辑
 */

import { createLogger, LogCategory } from '../logging/Logger.js';
import { buildSystemPrompt, createPlanModeReminder } from '../prompts/index.js';
import { PermissionMode } from '../types/common.js';
import type { AgentEvent, ChatContext, LoopOptions, LoopResult, UserMessageContent } from './types.js';

const logger = createLogger(LogCategory.AGENT);

type LoopExecutor = (
  message: UserMessageContent,
  context: ChatContext,
  options?: LoopOptions,
  systemPrompt?: string,
) => Promise<LoopResult>;

type StreamLoopExecutor = (
  message: UserMessageContent,
  context: ChatContext,
  options?: LoopOptions,
  systemPrompt?: string,
) => AsyncGenerator<AgentEvent, LoopResult>;

export class PlanExecutor {
  constructor(private language?: string) {}

  /**
   * 注入 Plan 模式 reminder 到消息中
   */
  injectPlanReminder(message: UserMessageContent): UserMessageContent {
    if (typeof message === 'string') {
      return createPlanModeReminder(message);
    }

    const textParts = message.filter((p) => p.type === 'text');
    if (textParts.length > 0) {
      const firstTextPart = textParts[0] as { type: 'text'; text: string };
      return message.map((p) =>
        p === firstTextPart
          ? { type: 'text' as const, text: createPlanModeReminder(firstTextPart.text) }
          : p
      );
    }

    return [
      { type: 'text', text: createPlanModeReminder('') },
      ...message,
    ];
  }

  /**
   * 构建 Plan 模式系统提示词
   */
  async buildPlanSystemPrompt(): Promise<string> {
    const { prompt } = await buildSystemPrompt({
      projectPath: process.cwd(),
      mode: PermissionMode.PLAN,
      includeEnvironment: true,
      language: this.language,
    });
    return prompt;
  }

  /**
   * Plan 模式入口（非流式）
   */
  async runPlanLoop(
    message: UserMessageContent,
    context: ChatContext,
    options: LoopOptions | undefined,
    executeLoop: LoopExecutor,
  ): Promise<LoopResult> {
    logger.debug('🔵 Processing Plan mode message...');
    const systemPrompt = await this.buildPlanSystemPrompt();
    const messageWithReminder = this.injectPlanReminder(message);
    return executeLoop(messageWithReminder, context, options, systemPrompt);
  }

  /**
   * Plan 模式入口（流式）
   */
  async *runPlanLoopStream(
    message: UserMessageContent,
    context: ChatContext,
    options: LoopOptions | undefined,
    executeStream: StreamLoopExecutor,
  ): AsyncGenerator<AgentEvent, LoopResult> {
    const systemPrompt = await this.buildPlanSystemPrompt();
    const messageWithReminder = this.injectPlanReminder(message);
    return yield* executeStream(messageWithReminder, context, options, systemPrompt);
  }
}
