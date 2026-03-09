/**
 * LoopRunner — 核心循环编排 + hooks 构建
 *
 * 从 Agent.ts 拆分，职责：
 * - 构建 AgentLoopConfig（工具、消息、hooks）
 * - 执行 agentLoop 并转发事件
 * - 普通模式的 systemPrompt 构建
 */

import { CompactionService } from '../context/CompactionService.js';
import { HookManager } from '../hooks/HookManager.js';
import { createLogger, LogCategory } from '../logging/Logger.js';
import { buildSystemPrompt } from '../prompts/index.js';
import type { Message } from '../services/ChatServiceInterface.js';
import { injectSkillsMetadata } from '../skills/index.js';
import type { ExecutionPipeline } from '../tools/execution/ExecutionPipeline.js';
import type { FunctionDeclaration } from '../tools/types/index.js';
import {
  type BladeConfig,
  type JsonValue,
  PermissionMode,
} from '../types/common.js';
import { getEnvironmentContext } from '../utils/environment.js';
import type { AgentEvent } from './AgentEvent.js';
import type { AgentLoopConfig } from './AgentLoop.js';
import { agentLoop } from './AgentLoop.js';
import type { CompactionHandler } from './CompactionHandler.js';
import { AGENT_TURN_SAFETY_LIMIT } from './constants.js';
import type { ModelManager } from './ModelManager.js';
import type { StreamResponseHandler } from './StreamResponseHandler.js';
import type {
  AgentOptions,
  ChatContext,
  LoopOptions,
  LoopResult,
  UserMessageContent,
} from './types.js';

function toJsonValue(value: string | object): JsonValue {
  if (typeof value === 'string') return value;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}

const logger = createLogger(LogCategory.AGENT);

/**
 * Skill 执行上下文
 */
interface SkillExecutionContext {
  skillName: string;
  allowedTools?: string[];
  basePath: string;
}

export class LoopRunner {
  private activeSkillContext?: SkillExecutionContext;

  constructor(
    private config: BladeConfig,
    private runtimeOptions: AgentOptions,
    private modelManager: ModelManager,
    private executionPipeline: ExecutionPipeline,
    private streamHandler?: StreamResponseHandler,
    private compactionHandler?: CompactionHandler,
  ) {}

  // ===== 普通模式入口 =====

  async runLoop(
    message: UserMessageContent,
    context: ChatContext,
    options?: LoopOptions,
  ): Promise<LoopResult> {
    logger.debug('💬 Processing enhanced chat message...');
    const systemPrompt = await this.buildNormalSystemPrompt(context);
    return this.executeLoop(message, context, options, systemPrompt);
  }

  async *runLoopStream(
    message: UserMessageContent,
    context: ChatContext,
    options?: LoopOptions,
  ): AsyncGenerator<AgentEvent, LoopResult> {
    const systemPrompt = await this.buildNormalSystemPrompt(context);
    return yield* this.executeWithAgentLoop(message, context, options, systemPrompt);
  }

  // ===== 通用循环入口（供 PlanExecutor 和普通模式共用） =====

  async executeLoop(
    message: UserMessageContent,
    context: ChatContext,
    options?: LoopOptions,
    systemPrompt?: string,
  ): Promise<LoopResult> {
    const stream = this.executeWithAgentLoop(message, context, options, systemPrompt);
    let result: LoopResult | undefined;

    while (true) {
      const { value, done } = await stream.next();
      if (done) {
        result = value;
        break;
      }
    }

    return result!;
  }

  async *executeWithAgentLoop(
    message: UserMessageContent,
    context: ChatContext,
    options?: LoopOptions,
    systemPrompt?: string,
  ): AsyncGenerator<AgentEvent, LoopResult> {
    // 1. 获取可用工具定义
    const registry = this.executionPipeline.getRegistry();
    const permissionMode = context.permissionMode;
    let rawTools = registry.getFunctionDeclarationsByMode(permissionMode);
    rawTools = injectSkillsMetadata(rawTools);
    const tools = this.applySkillToolRestrictions(rawTools);

    // 2. 构建消息历史
    const needsSystemPrompt =
      context.messages.length === 0 ||
      !context.messages.some((msg) => msg.role === 'system');

    const messages: Message[] = [];

    if (needsSystemPrompt && systemPrompt) {
      messages.push({
        role: 'system',
        content: [
          {
            type: 'text',
            text: systemPrompt,
            providerOptions: {
              anthropic: { cacheControl: { type: 'ephemeral' } },
            },
          },
        ],
      });
    }

    messages.push(...context.messages, { role: 'user', content: message });

    // 3. 保存用户消息到 JSONL
    let lastMessageUuid: string | null = null;
    try {
      const contextMgr = this.modelManager.getContextManager();
      const textContent =
        typeof message === 'string'
          ? message
          : message
              .filter((p) => p.type === 'text')
              .map((p) => (p as { text: string }).text)
              .join('\n');
      if (contextMgr && context.sessionId && textContent.trim() !== '') {
        lastMessageUuid = await contextMgr.saveMessage(
          context.sessionId, 'user', textContent, null, undefined, context.subagentInfo
        );
      }
    } catch (error) {
      logger.warn('[LoopRunner] 保存用户消息失败:', error);
    }

    // 4. 计算 maxTurns
    const isYoloMode = context.permissionMode === PermissionMode.YOLO;
    const configuredMaxTurns =
      this.runtimeOptions.maxTurns ?? options?.maxTurns ?? this.config.maxTurns ?? -1;

    if (configuredMaxTurns === 0) {
      return {
        success: false,
        error: { type: 'chat_disabled', message: '对话功能已被禁用 (maxTurns=0)' },
        metadata: { turnsCount: 0, toolCallsCount: 0, duration: 0 },
      };
    }

    const maxTurns = configuredMaxTurns === -1
      ? AGENT_TURN_SAFETY_LIMIT
      : Math.min(configuredMaxTurns, AGENT_TURN_SAFETY_LIMIT);

    // 5. 构建 AgentLoop hooks + config
    const loopConfig = this.buildLoopConfig(
      context, options, messages, tools, maxTurns, isYoloMode, permissionMode,
      () => lastMessageUuid,
      (uuid: string | null) => { lastMessageUuid = uuid; },
    );

    // 6. 运行 AgentLoop
    try {
      const loop = agentLoop(loopConfig);
      let result: LoopResult | undefined;

      while (true) {
        const { value, done } = await loop.next();
        if (done) {
          result = value;
          break;
        }
        yield value;
      }

      if (!result) {
        throw new Error('AgentLoop ended without result');
      }

      context.messages = messages.filter((m) => m.role !== 'system');
      return result;
    } catch (error) {
      if (error instanceof Error &&
        (error.name === 'AbortError' || error.message.includes('aborted'))) {
        return {
          success: false,
          error: { type: 'aborted', message: '任务已被用户中止' },
          metadata: { turnsCount: 0, toolCallsCount: 0, duration: 0 },
        };
      }
      logger.error('[LoopRunner] AgentLoop error:', error);
      return {
        success: false,
        error: {
          type: 'api_error',
          message: `处理消息时发生错误: ${error instanceof Error ? error.message : '未知错误'}`,
          details: error,
        },
        metadata: { turnsCount: 0, toolCallsCount: 0, duration: 0 },
      };
    }
  }

  // ===== SystemPrompt =====

  private async buildNormalSystemPrompt(context: ChatContext): Promise<string> {
    const basePrompt =
      context.systemPrompt ?? (await this.buildSystemPromptOnDemand());
    const envContext = getEnvironmentContext();
    return basePrompt
      ? `${envContext}\n\n---\n\n${basePrompt}`
      : envContext;
  }

  async buildSystemPromptOnDemand(): Promise<string> {
    const replacePrompt = this.runtimeOptions.systemPrompt;
    const appendPrompt = this.runtimeOptions.appendSystemPrompt;

    const result = await buildSystemPrompt({
      projectPath: process.cwd(),
      replaceDefault: replacePrompt,
      append: appendPrompt,
      includeEnvironment: false,
      language: this.config.language,
    });

    return result.prompt;
  }

  // ===== Skill 工具限制 =====

  get skillContext(): SkillExecutionContext | undefined {
    return this.activeSkillContext;
  }

  setSkillContext(ctx: SkillExecutionContext | undefined): void {
    this.activeSkillContext = ctx;
  }

  clearSkillContext(): void {
    if (this.activeSkillContext) {
      logger.debug(`🎯 Skill "${this.activeSkillContext.skillName}" deactivated`);
      this.activeSkillContext = undefined;
    }
  }

  private applySkillToolRestrictions(
    tools: FunctionDeclaration[]
  ): FunctionDeclaration[] {
    if (!this.activeSkillContext?.allowedTools) {
      return tools;
    }

    const allowedTools = this.activeSkillContext.allowedTools;
    logger.debug(`🔒 Applying Skill tool restrictions: ${allowedTools.join(', ')}`);

    const filteredTools = tools.filter((tool) => {
      return allowedTools.some((allowed) => {
        if (allowed === tool.name) return true;
        const match = allowed.match(/^(\w+)\(.*\)$/);
        if (match && match[1] === tool.name) return true;
        return false;
      });
    });

    logger.debug(
      `🔒 Filtered tools: ${filteredTools.map((t) => t.name).join(', ')} (${filteredTools.length}/${tools.length})`
    );

    return filteredTools;
  }

  // ===== AgentLoopConfig 构建 =====

  private buildLoopConfig(
    context: ChatContext,
    options: LoopOptions | undefined,
    messages: Message[],
    tools: FunctionDeclaration[],
    maxTurns: number,
    isYoloMode: boolean,
    permissionMode: PermissionMode | undefined,
    getLastUuid: () => string | null,
    setLastUuid: (uuid: string | null) => void,
  ): AgentLoopConfig {
    const self = this;
    const chatService = this.modelManager.getChatService();

    return {
      chatService,
      streamHandler: this.streamHandler,
      executionPipeline: this.executionPipeline,
      tools,
      messages,
      maxTurns,
      isYoloMode,
      signal: options?.signal,
      permissionMode,
      maxContextTokens: this.modelManager.getMaxContextTokens(),
      executionContext: {
        sessionId: context.sessionId,
        userId: context.userId || 'default',
        workspaceRoot: context.workspaceRoot || process.cwd(),
        confirmationHandler: context.confirmationHandler,
      },

      // === Hooks ===

      async *onBeforeTurn(ctx) {
        if (!self.compactionHandler) return false;
        const compactionStream = self.compactionHandler.checkAndCompactInLoop(
          context, ctx.turn, ctx.lastPromptTokens
        );
        let didCompact = false;
        while (true) {
          const { value, done } = await compactionStream.next();
          if (done) { didCompact = value; break; }
          yield value;
        }
        return didCompact;
      },

      async onAssistantMessage(ctx) {
        try {
          const contextMgr = self.modelManager.getContextManager();
          if (contextMgr && context.sessionId && ctx.content.trim() !== '') {
            const uuid = await contextMgr.saveMessage(
              context.sessionId, 'assistant', ctx.content,
              getLastUuid(), undefined, context.subagentInfo
            );
            setLastUuid(uuid);
          }
        } catch (error) {
          logger.warn('[LoopRunner] 保存助手消息失败:', error);
        }
      },

      async onBeforeToolExec(ctx) {
        try {
          const contextMgr = self.modelManager.getContextManager();
          if (contextMgr && context.sessionId) {
            return await contextMgr.saveToolUse(
              context.sessionId, ctx.toolCall.function.name,
              ctx.params as Record<string, unknown> & import('../types/common.js').JsonValue,
              getLastUuid(), context.subagentInfo
            );
          }
        } catch (error) {
          logger.warn('[LoopRunner] 保存工具调用失败:', error);
        }
        return null;
      },

      async onAfterToolExec(ctx) {
        const { toolCall, result, toolUseUuid } = ctx;

        // 保存工具结果到 JSONL
        try {
          const contextMgr = self.modelManager.getContextManager();
          if (contextMgr && context.sessionId) {
            const metadata = result.metadata;
            const isSubagentStatus = (v: unknown): v is 'running' | 'completed' | 'failed' | 'cancelled' =>
              v === 'running' || v === 'completed' || v === 'failed' || v === 'cancelled';
            const subagentStatus = isSubagentStatus(metadata?.subagentStatus)
              ? metadata.subagentStatus : 'completed';
            const subagentRef = metadata && typeof metadata.subagentSessionId === 'string'
              ? {
                  subagentSessionId: metadata.subagentSessionId,
                  subagentType: typeof metadata.subagentType === 'string'
                    ? metadata.subagentType : toolCall.function.name,
                  subagentStatus,
                  subagentSummary: typeof metadata.subagentSummary === 'string'
                    ? metadata.subagentSummary : undefined,
                }
              : undefined;
            const uuid = await contextMgr.saveToolResult(
              context.sessionId, toolCall.id, toolCall.function.name,
              result.success ? toJsonValue(result.llmContent) : null,
              toolUseUuid, result.success ? undefined : result.error?.message,
              context.subagentInfo, subagentRef
            );
            setLastUuid(uuid);
          }
        } catch (err) {
          logger.warn('[LoopRunner] 保存工具结果失败:', err);
        }

        // Skill 激活
        if (toolCall.function.name === 'Skill' && result.success && result.metadata) {
          const md = result.metadata;
          if (md.skillName && typeof md.skillName === 'string') {
            self.activeSkillContext = {
              skillName: md.skillName,
              allowedTools: Array.isArray(md.allowedTools) ? md.allowedTools as string[] : undefined,
              basePath: typeof md.basePath === 'string' ? md.basePath : '',
            };
          }
        }

        // 模型切换
        const modelId = result.metadata?.modelId?.trim()
          || result.metadata?.model?.trim() || undefined;
        if (modelId) {
          await self.modelManager.switchModelIfNeeded(modelId);
        }
      },

      async onComplete(ctx) {
        try {
          const contextMgr = self.modelManager.getContextManager();
          if (contextMgr && context.sessionId && ctx.content.trim() !== '') {
            const uuid = await contextMgr.saveMessage(
              context.sessionId, 'assistant', ctx.content,
              getLastUuid(), undefined, context.subagentInfo
            );
            setLastUuid(uuid);
          }
        } catch (error) {
          logger.warn('[LoopRunner] 保存助手消息失败:', error);
        }
      },

      async onStopCheck(ctx) {
        try {
          const hookManager = HookManager.getInstance();
          const stopResult = await hookManager.executeStopHooks({
            projectDir: process.cwd(),
            sessionId: context.sessionId,
            permissionMode: context.permissionMode ?? PermissionMode.DEFAULT,
            reason: ctx.content,
            abortSignal: options?.signal,
          });
          return {
            shouldStop: stopResult.shouldStop,
            continueReason: stopResult.continueReason,
            warning: stopResult.warning,
          };
        } catch {
          return { shouldStop: true };
        }
      },

      onTurnLimitReached: options?.onTurnLimitReached,

      async onTurnLimitCompact(_ctx) {
        try {
          const cs = chatService.getConfig();
          const compactResult = await CompactionService.compact(
            context.messages,
            {
              trigger: 'auto',
              modelName: cs.model,
              maxContextTokens: cs.maxContextTokens ?? 128000,
              apiKey: cs.apiKey,
              baseURL: cs.baseUrl,
            }
          );
          context.messages = compactResult.compactedMessages;
          const continueMessage: Message = {
            role: 'user',
            content: 'This session is being continued from a previous conversation. '
              + 'The conversation is summarized above.\n\n'
              + 'Please continue the conversation from where we left it off without asking the user any further questions. '
              + 'Continue with the last task that you were asked to work on.',
          };
          context.messages.push(continueMessage);

          try {
            const contextMgr = self.modelManager.getContextManager();
            if (contextMgr && context.sessionId) {
              await contextMgr.saveCompaction(
                context.sessionId, compactResult.summary,
                { trigger: 'auto', preTokens: compactResult.preTokens,
                  postTokens: compactResult.postTokens, filesIncluded: compactResult.filesIncluded },
                null
              );
            }
          } catch (saveError) {
            logger.warn('[LoopRunner] 保存压缩数据失败:', saveError);
          }

          return {
            success: true,
            compactedMessages: compactResult.compactedMessages,
            continueMessage,
          };
        } catch (compactError) {
          logger.error('[LoopRunner] 压缩失败，使用降级策略:', compactError);
          const recentMessages = context.messages.slice(-80);
          context.messages = recentMessages;
          return { success: true, compactedMessages: recentMessages };
        }
      },
    };
  }
}
