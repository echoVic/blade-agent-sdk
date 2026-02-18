/**
 * Agent核心类 - 无状态设计
 *
 * 设计原则：
 * 1. Agent 本身不保存任何会话状态（sessionId, messages 等）
 * 2. 所有状态通过 context 参数传入
 * 3. Agent 实例可以每次命令创建，用完即弃
 * 4. 历史连续性由外部 SessionContext 保证
 *
 * 负责：LLM 交互、工具执行、循环检测
 */

import { nanoid } from 'nanoid';
import * as os from 'os';
import * as path from 'path';
import { CompactionService } from '../context/CompactionService.js';
import type { ContextManager } from '../context/ContextManager.js';
import { HookManager } from '../hooks/HookManager.js';
import { createLogger, LogCategory } from '../logging/Logger.js';
// import { streamDebug } from '../logging/StreamDebugLogger.js'; // removed: unused after loop extraction
import { McpRegistry } from '../mcp/McpRegistry.js';
import { buildSystemPrompt, createPlanModeReminder } from '../prompts/index.js';
import {
  type ChatResponse,
  createChatServiceAsync,
  type IChatService,
  type Message
} from '../services/ChatServiceInterface.js';
import { discoverSkills, injectSkillsMetadata } from '../skills/index.js';
import { getBuiltinTools } from '../tools/builtin/index.js';
import { agentLoop } from './AgentLoop.js';
import type { AgentLoopConfig } from './AgentLoop.js';
import type { AgentLoopEvent } from './AgentEvent.js';
// import type { TodoItem } from '../tools/builtin/todo/types.js'; // removed: unused after loop extraction
import { ExecutionPipeline } from '../tools/execution/ExecutionPipeline.js';
import { ToolRegistry } from '../tools/registry/ToolRegistry.js';
import type { Tool } from '../tools/types/index.js';
import {
  type BladeConfig,
  type JsonValue,
  type McpServerConfig,
  type ModelConfig,
  PermissionMode,
  type PermissionsConfig,
} from '../types/common.js';
import { getEnvironmentContext } from '../utils/environment.js';
import { isThinkingModel } from '../utils/modelDetection.js';
import { AttachmentHandler } from './AttachmentHandler.js';
import { CompactionHandler } from './CompactionHandler.js';
import { ExecutionEngine } from './ExecutionEngine.js';
import { StreamResponseHandler } from './StreamResponseHandler.js';
import { subagentRegistry } from './subagents/SubagentRegistry.js';
import type {
  AgentEvent,
  AgentOptions,
  AgentResponse,
  AgentTask,
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

// 创建 Agent 专用 Logger
const logger = createLogger(LogCategory.AGENT);

/**
 * Skill 执行上下文
 * 用于跟踪当前活动的 Skill 及其工具限制
 */
interface SkillExecutionContext {
  skillName: string;
  allowedTools?: string[];
  basePath: string;
}

export class Agent {
  private config: BladeConfig;
  private runtimeOptions: AgentOptions;
  private isInitialized = false;
  private activeTask?: AgentTask;
  private executionPipeline: ExecutionPipeline;
  // systemPrompt 已移除 - 改为从 context 参数传入（无状态设计）
  // sessionId 已移除 - 改为从 context 参数传入（无状态设计）

  // 核心组件
  private chatService!: IChatService;
  private executionEngine!: ExecutionEngine;
  private attachmentHandler?: AttachmentHandler;
  private streamHandler?: StreamResponseHandler;
  private compactionHandler?: CompactionHandler;

  // Skill 执行上下文（用于 allowed-tools 限制）
  private activeSkillContext?: SkillExecutionContext;

  // 当前模型的上下文窗口大小（用于 tokenUsage 上报）
  private currentModelMaxContextTokens!: number;
  private currentModelId?: string;

  constructor(
    config: BladeConfig,
    runtimeOptions: AgentOptions = {},
    executionPipeline?: ExecutionPipeline
  ) {
    this.config = config;
    this.runtimeOptions = runtimeOptions;
    this.executionPipeline = executionPipeline || this.createDefaultPipeline();
    // sessionId 不再存储在 Agent 内部，改为从 context 传入
  }

  /**
   * 创建默认的 ExecutionPipeline
   */
  private createDefaultPipeline(): ExecutionPipeline {
    const registry = new ToolRegistry();
    const permissions: PermissionsConfig = {
      ...this.config.permissions,
      ...this.runtimeOptions.permissions,
    };
    const permissionMode =
      this.runtimeOptions.permissionMode ??
      PermissionMode.DEFAULT;
    return new ExecutionPipeline(registry, {
      permissionConfig: permissions,
      permissionMode,
      maxHistorySize: 1000,
      canUseTool: this.runtimeOptions.canUseTool,
    });
  }

  private resolveModelConfig(requestedModelId?: string): ModelConfig {
    const modelId = requestedModelId && requestedModelId !== 'inherit' ? requestedModelId : undefined;
    const models = this.config.models || [];
    const currentModelId = this.config.currentModelId;
    const modelConfig = modelId 
      ? models.find(m => m.id === modelId)
      : models.find(m => m.id === currentModelId) || models[0];
    if (!modelConfig) {
      throw new Error(`❌ 模型配置未找到: ${modelId ?? 'current'}`);
    }
    return modelConfig;
  }

  private async applyModelConfig(modelConfig: ModelConfig, label: string): Promise<void> {
    this.log(`${label} ${modelConfig.name} (${modelConfig.model})`);

    const modelSupportsThinking = isThinkingModel(modelConfig);
    const thinkingModeEnabled = modelConfig.thinkingEnabled ?? false;
    const supportsThinking = modelSupportsThinking && thinkingModeEnabled;
    if (modelSupportsThinking && !thinkingModeEnabled) {
      this.log(`🧠 模型支持 Thinking，但用户未开启（按 Tab 开启）`);
    } else if (supportsThinking) {
      this.log(`🧠 Thinking 模式已启用，启用 reasoning_content 支持`);
    }

    const maxContextTokens = modelConfig.maxContextTokens ?? 128000;
    this.currentModelMaxContextTokens = maxContextTokens;

    this.chatService = await createChatServiceAsync({
      provider: modelConfig.provider,
      apiKey: modelConfig.apiKey || '',
      model: modelConfig.model,
      baseUrl: modelConfig.baseUrl || '',
      temperature: modelConfig.temperature ?? this.config.temperature,
      maxContextTokens: this.currentModelMaxContextTokens,
      supportsThinking,
      outputFormat: this.runtimeOptions.outputFormat,
    });

    const contextManager = this.executionEngine?.getContextManager();
    this.executionEngine = new ExecutionEngine(this.chatService, contextManager);
    this.currentModelId = modelConfig.id;
  }

  private async switchModelIfNeeded(modelId: string): Promise<void> {
    if (!modelId || modelId === this.currentModelId) return;
    const models = this.config.models || [];
    const modelConfig = models.find(m => m.id === modelId);
    if (!modelConfig) {
      this.log(`⚠️ 模型配置未找到: ${modelId}`);
      return;
    }
    await this.applyModelConfig(modelConfig, '🔁 切换模型');
  }

  /**
   * 快速创建并初始化 Agent 实例（静态工厂方法）
   * @param config - BladeConfig 配置对象
   * @param options - Agent 运行时选项
   */
  static async create(config: BladeConfig, options: AgentOptions = {}): Promise<Agent> {
    const models = config.models || [];
    if (models.length === 0) {
      throw new Error(
        '❌ 没有可用的模型配置\n\n' +
          '请先使用以下命令添加模型：\n' +
          '  /model add\n\n' +
          '或运行初始化向导：\n' +
          '  /init'
      );
    }

    const agent = new Agent(config, options);
    await agent.initialize();

    if (options.toolWhitelist && options.toolWhitelist.length > 0) {
      agent.applyToolWhitelist(options.toolWhitelist);
    }

    return agent;
  }

  /**
   * 初始化Agent
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      this.log('初始化Agent...');

      // 1. 初始化系统提示
      await this.initializeSystemPrompt();

      // 2. 注册内置工具
      await this.registerBuiltinTools();

      // 3. 加载 subagent 配置
      await this.loadSubagents();

      // 4. 发现并注册 Skills
      await this.discoverSkills();

      // 5. 初始化核心组件
      const modelConfig = this.resolveModelConfig(this.runtimeOptions.modelId);
      await this.applyModelConfig(modelConfig, '🚀 使用模型:');

      // 5. 初始化处理器（使用 getter 函数确保始终获取最新的 chatService）
      this.attachmentHandler = new AttachmentHandler(process.cwd());
      this.streamHandler = new StreamResponseHandler(() => this.chatService);
      this.compactionHandler = new CompactionHandler(
        () => this.chatService,
        () => this.executionEngine?.getContextManager()
      );

      this.isInitialized = true;
      this.log(
        `Agent初始化完成，已加载 ${this.executionPipeline.getRegistry().getAll().length} 个工具`
      );
    } catch (error) {
      this.error('Agent初始化失败', error);
      throw error;
    }
  }

  /**
   * 执行任务
   */
  public async executeTask(task: AgentTask): Promise<AgentResponse> {
    if (!this.isInitialized) {
      throw new Error('Agent未初始化');
    }

    this.activeTask = task;

    try {
      this.log(`开始执行任务: ${task.id}`);

      const response = await this.executionEngine.executeTask(task);

      this.activeTask = undefined;
      this.log(`任务执行完成: ${task.id}`);

      return response;
    } catch (error) {
      this.activeTask = undefined;
      this.error(`任务执行失败: ${task.id}`, error);
      throw error;
    }
  }

  /**
   * 简单聊天接口
   * @param message - 用户消息内容（支持纯文本或多模态）
   */
  public async chat(
    message: UserMessageContent,
    context?: ChatContext,
    options?: LoopOptions
  ): Promise<string> {
    if (!this.isInitialized) {
      throw new Error('Agent未初始化');
    }

    // ✨ 处理 @ 文件提及（在发送前预处理）
    // 支持纯文本和多模态消息
    const enhancedMessage = this.attachmentHandler
      ? await this.attachmentHandler.processAtMentionsForContent(message)
      : message;

    // 如果提供了 context，使用增强的工具调用流程
    if (context) {
      // 合并 signal 和 options
      const loopOptions: LoopOptions = {
        signal: context.signal,
        ...options,
      };

      let result: LoopResult;
      if (context.permissionMode === 'plan') {
        result = await this.runPlanLoop(enhancedMessage, context, loopOptions);
      } else {
        result = await this.runLoop(enhancedMessage, context, loopOptions);
      }

      if (!result.success) {
        if (result.error?.type === 'aborted' || result.metadata?.shouldExitLoop) {
          return '';
        }
        throw new Error(result.error?.message || '执行失败');
      }

      if (result.metadata?.targetMode && context.permissionMode === 'plan') {
        const targetMode = result.metadata.targetMode as PermissionMode;
        const planContent = result.metadata.planContent as string | undefined;
        logger.debug(`🔄 Plan 模式已批准，切换到 ${targetMode} 模式并重新执行`);

        const newContext: ChatContext = {
          ...context,
          permissionMode: targetMode,
        };

        let messageWithPlan: UserMessageContent = enhancedMessage;
        if (planContent) {
          const planSuffix = `

<approved-plan>
${planContent}
</approved-plan>

IMPORTANT: Execute according to the approved plan above. Follow the steps exactly as specified.`;

          if (typeof enhancedMessage === 'string') {
            messageWithPlan = enhancedMessage + planSuffix;
          } else {
            messageWithPlan = [...enhancedMessage, { type: 'text', text: planSuffix }];
          }
          logger.debug(`📋 已将 plan 内容注入到消息中 (${planContent.length} 字符)`);
        }

        return this.runLoop(messageWithPlan, newContext, loopOptions).then(
          (newResult) => {
            if (!newResult.success) {
              throw new Error(newResult.error?.message || '执行失败');
            }
            return newResult.finalMessage || '';
          }
        );
      }

      return result.finalMessage || '';
    }

    // 否则使用原有的简单流程（仅支持纯文本消息）
    // 多模态消息在简单流程中不支持，提取纯文本部分
    const textPrompt =
      typeof enhancedMessage === 'string'
        ? enhancedMessage
        : enhancedMessage
            .filter((p) => p.type === 'text')
            .map((p) => (p as { text: string }).text)
            .join('\n');

    const task: AgentTask = {
      id: this.generateTaskId(),
      type: 'simple',
      prompt: textPrompt,
    };

    const response = await this.executeTask(task);
    return response.content;
  }

  public streamChat(
    message: UserMessageContent,
    context?: ChatContext,
    options?: LoopOptions
  ): AsyncGenerator<AgentEvent, LoopResult> {
    if (!this.isInitialized) {
      throw new Error('Agent未初始化');
    }

    const run = async () => {
      const enhancedMessage = this.attachmentHandler
        ? await this.attachmentHandler.processAtMentionsForContent(message)
        : message;

      if (!context) {
        throw new Error('Context is required for streaming');
      }

      const loopOptions: LoopOptions = {
        signal: context.signal,
        ...options,
      };

      if (context.permissionMode === 'plan') {
        const planStream = this.runPlanLoopStream(enhancedMessage, context, loopOptions);
        let planResult: LoopResult | undefined;
        
        const events: AgentEvent[] = [];
        while (true) {
          const { value, done } = await planStream.next();
          if (done) {
            planResult = value;
            break;
          }
          events.push(value);
        }

        if (planResult?.metadata?.targetMode) {
          const targetMode = planResult.metadata.targetMode as PermissionMode;
          const planContent = planResult.metadata.planContent as string | undefined;

          const newContext: ChatContext = {
            ...context,
            permissionMode: targetMode,
          };

          let messageWithPlan: UserMessageContent = enhancedMessage;
          if (planContent) {
            const planSuffix = `

<approved-plan>
${planContent}
</approved-plan>

IMPORTANT: Execute according to the approved plan above. Follow the steps exactly as specified.`;

            if (typeof enhancedMessage === 'string') {
              messageWithPlan = enhancedMessage + planSuffix;
            } else {
              messageWithPlan = [...enhancedMessage, { type: 'text', text: planSuffix }];
            }
          }

          return {
            events,
            continuation: this.runLoopStream(messageWithPlan, newContext, loopOptions),
          };
        }

        return { events, result: planResult };
      }

      return { continuation: this.runLoopStream(enhancedMessage, context, loopOptions) };
    };

    const generator = run();

    const wrapper = async function* (): AsyncGenerator<AgentEvent, LoopResult> {
      const outcome = await generator;
      
      if ('events' in outcome && outcome.events) {
        for (const event of outcome.events) {
          yield event;
        }
      }

      if ('continuation' in outcome && outcome.continuation) {
        return yield* outcome.continuation;
      }

      return outcome.result!;
    };

    return wrapper();
  }

  /**
   * 运行 Plan 模式循环 - 专门处理 Plan 模式的逻辑
   * Plan 模式特点：只读调研、系统化研究方法论、最终输出实现计划
   */
  /**
   * Plan 模式入口 - 准备 Plan 专用配置后调用通用循环
   */
  private async runPlanLoop(
    message: UserMessageContent,
    context: ChatContext,
    options?: LoopOptions
  ): Promise<LoopResult> {
    logger.debug('🔵 Processing Plan mode message...');

    // Plan 模式差异 1: 使用统一入口构建 Plan 模式系统提示词
    const { prompt: systemPrompt } = await buildSystemPrompt({
      projectPath: process.cwd(),
      mode: PermissionMode.PLAN,
      includeEnvironment: true,
      language: this.config.language,
    });

    // Plan 模式差异 2: 在用户消息中注入 system-reminder
    // 处理多模态消息：提取文本部分添加 reminder
    let messageWithReminder: UserMessageContent;
    if (typeof message === 'string') {
      messageWithReminder = createPlanModeReminder(message);
    } else {
      // 多模态消息：在第一个文本部分前添加 reminder，或创建新的文本部分
      const textParts = message.filter((p) => p.type === 'text');
      if (textParts.length > 0) {
        const firstTextPart = textParts[0] as { type: 'text'; text: string };
        messageWithReminder = message.map((p) =>
          p === firstTextPart
            ? {
                type: 'text' as const,
                text: createPlanModeReminder(firstTextPart.text),
              }
            : p
        );
      } else {
        // 仅图片，添加空的 reminder
        messageWithReminder = [
          { type: 'text', text: createPlanModeReminder('') },
          ...message,
        ];
      }
    }

    // 调用通用循环，传入 Plan 模式专用配置
    // 注意：不再传递 isPlanMode 参数，executeLoop 会从 context.permissionMode 读取
    return this.executeLoop(messageWithReminder, context, options, systemPrompt);
  }

  private async *runPlanLoopStream(
    message: UserMessageContent,
    context: ChatContext,
    options?: LoopOptions
  ): AsyncGenerator<AgentEvent, LoopResult> {
    const { prompt: systemPrompt } = await buildSystemPrompt({
      projectPath: process.cwd(),
      mode: PermissionMode.PLAN,
      includeEnvironment: true,
      language: this.config.language,
    });

    let messageWithReminder: UserMessageContent;
    if (typeof message === 'string') {
      messageWithReminder = createPlanModeReminder(message);
    } else {
      const textParts = message.filter((p) => p.type === 'text');
      if (textParts.length > 0) {
        const firstTextPart = textParts[0] as { type: 'text'; text: string };
        messageWithReminder = message.map((p) =>
          p === firstTextPart
            ? {
                type: 'text' as const,
                text: createPlanModeReminder(firstTextPart.text),
              }
            : p
        );
      } else {
        messageWithReminder = [
          { type: 'text', text: createPlanModeReminder('') },
          ...message,
        ];
      }
    }

    return yield* this.executeWithAgentLoop(
      messageWithReminder,
      context,
      options,
      systemPrompt
    );
  }

  /**
   * 普通模式入口 - 准备普通模式配置后调用通用循环
   * 无状态设计：systemPrompt 从 context 传入，或按需动态构建
   */
  private async runLoop(
    message: UserMessageContent,
    context: ChatContext,
    options?: LoopOptions
  ): Promise<LoopResult> {
    logger.debug('💬 Processing enhanced chat message...');

    // 无状态设计：优先使用 context.systemPrompt，否则按需构建
    const basePrompt =
      context.systemPrompt ?? (await this.buildSystemPromptOnDemand());
    const envContext = getEnvironmentContext();
    const systemPrompt = basePrompt
      ? `${envContext}\n\n---\n\n${basePrompt}`
      : envContext;

    // 调用通用循环
    return this.executeLoop(message, context, options, systemPrompt);
  }

  private async *runLoopStream(
    message: UserMessageContent,
    context: ChatContext,
    options?: LoopOptions
  ): AsyncGenerator<AgentEvent, LoopResult> {
    const basePrompt =
      context.systemPrompt ?? (await this.buildSystemPromptOnDemand());
    const envContext = getEnvironmentContext();
    const systemPrompt = basePrompt
      ? `${envContext}\n\n---\n\n${basePrompt}`
      : envContext;

    return yield* this.executeWithAgentLoop(message, context, options, systemPrompt);
  }

  /**
   * 按需构建系统提示词（用于未传入 context.systemPrompt 的场景）
   */
  private async buildSystemPromptOnDemand(): Promise<string> {
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

  private async executeLoop(
    message: UserMessageContent,
    context: ChatContext,
    options?: LoopOptions,
    systemPrompt?: string
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

  /**
   * 使用新的 AgentLoop 执行循环（P0 重构）
   *
   * 准备工作（工具获取、消息构建）在此方法中完成，
   * 核心循环委托给 agentLoop，副作用通过 hooks 注入。
   */
  private async *executeWithAgentLoop(
    message: UserMessageContent,
    context: ChatContext,
    options?: LoopOptions,
    systemPrompt?: string
  ): AsyncGenerator<AgentEvent, LoopResult> {
    if (!this.isInitialized) {
      throw new Error('Agent未初始化');
    }

    // 1. 获取可用工具定义
    const registry = this.executionPipeline.getRegistry();
    const permissionMode = context.permissionMode as PermissionMode | undefined;
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
      const contextMgr = this.executionEngine?.getContextManager();
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
      logger.warn('[Agent] 保存用户消息失败:', error);
    }

    // 4. 计算 maxTurns
    const SAFETY_LIMIT = 100;
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
      ? SAFETY_LIMIT
      : Math.min(configuredMaxTurns, SAFETY_LIMIT);

    // 5. 构建 AgentLoop hooks
    const self = this;
    const loopConfig: AgentLoopConfig = {
      chatService: this.chatService,
      streamHandler: this.streamHandler,
      executionPipeline: this.executionPipeline,
      tools,
      messages,
      maxTurns,
      isYoloMode,
      signal: options?.signal,
      permissionMode,
      maxContextTokens: this.currentModelMaxContextTokens,
      executionContext: {
        sessionId: context.sessionId,
        userId: context.userId || 'default',
        workspaceRoot: context.workspaceRoot || process.cwd(),
        confirmationHandler: context.confirmationHandler,
      },

      // === Hooks: 副作用注入 ===

      async *onBeforeTurn(ctx) {
        if (!self.compactionHandler) return false;
        const compactionStream = self.compactionHandler.checkAndCompactInLoop(
          context, ctx.turn, ctx.lastPromptTokens
        );
        let didCompact = false;
        while (true) {
          const { value, done } = await compactionStream.next();
          if (done) { didCompact = value; break; }
          yield value as AgentLoopEvent;
        }
        return didCompact;
      },

      async onAssistantMessage(ctx) {
        try {
          const contextMgr = self.executionEngine?.getContextManager();
          if (contextMgr && context.sessionId && ctx.content.trim() !== '') {
            lastMessageUuid = await contextMgr.saveMessage(
              context.sessionId, 'assistant', ctx.content,
              lastMessageUuid, undefined, context.subagentInfo
            );
          }
        } catch (error) {
          logger.warn('[Agent] 保存助手消息失败:', error);
        }
      },

      async onBeforeToolExec(ctx) {
        try {
          const contextMgr = self.executionEngine?.getContextManager();
          if (contextMgr && context.sessionId) {
            return await contextMgr.saveToolUse(
              context.sessionId, ctx.toolCall.function.name,
              ctx.params as Record<string, unknown> & import('../types/common.js').JsonValue, lastMessageUuid, context.subagentInfo
            );
          }
        } catch (error) {
          logger.warn('[Agent] 保存工具调用失败:', error);
        }
        return null;
      },

      async onAfterToolExec(ctx) {
        const { toolCall, result, toolUseUuid } = ctx;

        // 保存工具结果到 JSONL
        try {
          const contextMgr = self.executionEngine?.getContextManager();
          if (contextMgr && context.sessionId) {
            const metadata = result.metadata && typeof result.metadata === 'object'
              ? (result.metadata as Record<string, unknown>) : undefined;
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
            lastMessageUuid = await contextMgr.saveToolResult(
              context.sessionId, toolCall.id, toolCall.function.name,
              result.success ? toJsonValue(result.llmContent) : null,
              toolUseUuid, result.success ? undefined : result.error?.message,
              context.subagentInfo, subagentRef
            );
          }
        } catch (err) {
          logger.warn('[Agent] 保存工具结果失败:', err);
        }

        // Skill 激活
        if (toolCall.function.name === 'Skill' && result.success && result.metadata) {
          const metadata = result.metadata as Record<string, unknown>;
          if (metadata.skillName) {
            self.activeSkillContext = {
              skillName: metadata.skillName as string,
              allowedTools: metadata.allowedTools as string[] | undefined,
              basePath: (metadata.basePath as string) || '',
            };
          }
        }

        // 模型切换
        const modelId = result.metadata?.modelId?.trim()
          || result.metadata?.model?.trim() || undefined;
        if (modelId) {
          await self.switchModelIfNeeded(modelId);
        }
      },

      async onComplete(ctx) {
        try {
          const contextMgr = self.executionEngine?.getContextManager();
          if (contextMgr && context.sessionId && ctx.content.trim() !== '') {
            lastMessageUuid = await contextMgr.saveMessage(
              context.sessionId, 'assistant', ctx.content,
              lastMessageUuid, undefined, context.subagentInfo
            );
          }
        } catch (error) {
          logger.warn('[Agent] 保存助手消息失败:', error);
        }
      },

      async onStopCheck(ctx) {
        try {
          const hookManager = HookManager.getInstance();
          const stopResult = await hookManager.executeStopHooks({
            projectDir: process.cwd(),
            sessionId: context.sessionId,
            permissionMode: context.permissionMode as PermissionMode,
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

      async onTurnLimitCompact(ctx) {
        try {
          const chatConfig = self.chatService.getConfig();
          const compactResult = await CompactionService.compact(
            context.messages,
            {
              trigger: 'auto',
              modelName: chatConfig.model,
              maxContextTokens: chatConfig.maxContextTokens ?? 128000,
              apiKey: chatConfig.apiKey,
              baseURL: chatConfig.baseUrl,
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

          // 保存压缩数据到 JSONL
          try {
            const contextMgr = self.executionEngine?.getContextManager();
            if (contextMgr && context.sessionId) {
              await contextMgr.saveCompaction(
                context.sessionId, compactResult.summary,
                { trigger: 'auto', preTokens: compactResult.preTokens,
                  postTokens: compactResult.postTokens, filesIncluded: compactResult.filesIncluded },
                null
              );
            }
          } catch (saveError) {
            logger.warn('[Agent] 保存压缩数据失败:', saveError);
          }

          return {
            success: true,
            compactedMessages: compactResult.compactedMessages,
            continueMessage,
          };
        } catch (compactError) {
          logger.error('[Agent] 压缩失败，使用降级策略:', compactError);
          // 降级：保留最近 80 条
          const recentMessages = context.messages.slice(-80);
          context.messages = recentMessages;
          return { success: true, compactedMessages: recentMessages };
        }
      },
    };

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
        // 转发事件（AgentLoopEvent 兼容 AgentEvent）
        yield value as AgentEvent;
      }

      if (!result) {
        throw new Error('AgentLoop ended without result');
      }

      // 更新 context.messages
      context.messages = messages.filter((m) => m.role !== 'system');

      return result;
    } catch (error) {
      if (error instanceof Error &&
        (error.name === 'AbortError' || error.message.includes('aborted'))) {
        return {
          success: false,
          error: { type: 'aborted', message: '任务已被用户中止' },
          metadata: { turnsCount: 0, toolCallsCount: 0, duration: Date.now() - Date.now() },
        };
      }
      logger.error('AgentLoop error:', error);
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

  /**
   * 运行 Agentic Loop（公共接口，用于子任务递归）
   */
  public async runAgenticLoop(
    message: string,
    context: ChatContext,
    options?: LoopOptions
  ): Promise<LoopResult> {
    if (!this.isInitialized) {
      throw new Error('Agent未初始化');
    }

    // 规范化上下文为 ChatContext
    // 🔧 修复：确保复制 systemPrompt、permissionMode 和 subagentInfo，避免子代理行为回归
    const chatContext: ChatContext = {
      messages: context.messages as Message[],
      userId: (context.userId as string) || 'subagent',
      sessionId: (context.sessionId as string) || `subagent_${Date.now()}`,
      workspaceRoot: (context.workspaceRoot as string) || process.cwd(),
      signal: context.signal,
      confirmationHandler: context.confirmationHandler,
      permissionMode: context.permissionMode, // 继承权限模式
      systemPrompt: context.systemPrompt, // 🆕 继承系统提示词（无状态设计关键）
      subagentInfo: context.subagentInfo, // 🆕 继承 subagent 信息（用于 JSONL 写入）
    };

    // 调用重构后的 runLoop
    return await this.runLoop(message, chatContext, options);
  }

  /**
   * 带系统提示的聊天接口
   */
  public async chatWithSystem(systemPrompt: string, message: string): Promise<string> {
    if (!this.isInitialized) {
      throw new Error('Agent未初始化');
    }

    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message },
    ];
    const response = await this.chatService.chat(messages);

    return response.content;
  }

  /**
   * 获取当前活动任务
   */
  public getActiveTask(): AgentTask | undefined {
    return this.activeTask;
  }

  /**
   * 获取Chat服务
   */
  public getChatService(): IChatService {
    return this.chatService;
  }

  /**
   * 获取上下文管理器 - 返回执行引擎的上下文管理功能
   */
  public getContextManager(): ContextManager | undefined {
    return this.executionEngine?.getContextManager();
  }

  /**
   * 获取Agent状态统计
   */
  public getStats(): Record<string, unknown> {
    return {
      initialized: this.isInitialized,
      activeTask: this.activeTask?.id,
      components: {
        chatService: this.chatService ? 'ready' : 'not_loaded',
        executionEngine: this.executionEngine ? 'ready' : 'not_loaded',
      },
    };
  }

  /**
   * 获取可用工具列表
   */
  public getAvailableTools(): Tool[] {
    return this.executionPipeline ? this.executionPipeline.getRegistry().getAll() : [];
  }

  /**
   * 获取工具注册表（用于子 Agent 工具隔离）
   */
  public getToolRegistry(): ToolRegistry {
    return this.executionPipeline.getRegistry();
  }

  /**
   * 应用工具白名单（仅保留指定工具）
   */
  public applyToolWhitelist(whitelist: string[]): void {
    const registry = this.executionPipeline.getRegistry();
    const allTools = registry.getAll();

    // 过滤掉不在白名单中的工具
    const toolsToRemove = allTools.filter((tool) => !whitelist.includes(tool.name));

    for (const tool of toolsToRemove) {
      registry.unregister(tool.name);
    }

    logger.debug(
      `🔒 Applied tool whitelist: ${whitelist.join(', ')} (removed ${toolsToRemove.length} tools)`
    );
  }

  /**
   * 获取工具统计信息
   */
  public getToolStats() {
    const tools = this.getAvailableTools();
    const toolsByKind = new Map<string, number>();

    tools.forEach((tool) => {
      const count = toolsByKind.get(tool.kind) || 0;
      toolsByKind.set(tool.kind, count + 1);
    });

    return {
      totalTools: tools.length,
      toolsByKind: Object.fromEntries(toolsByKind),
      toolNames: tools.map((t) => t.name),
    };
  }

  /**
   * 销毁Agent
   */
  public async destroy(): Promise<void> {
    this.log('销毁Agent...');

    try {
      this.isInitialized = false;
      this.log('Agent已销毁');
    } catch (error) {
      this.error('Agent销毁失败', error);
      throw error;
    }
  }

  /**
   * 生成任务ID
   */
  private generateTaskId(): string {
    return `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * 日志记录
   */
  private log(message: string, data?: unknown): void {
    logger.debug(`[MainAgent] ${message}`, data || '');
  }

  /**
   * 错误记录
   */
  private error(message: string, error?: unknown): void {
    logger.error(`[MainAgent] ${message}`, error || '');
  }

  /**
   * 初始化系统提示（无状态设计：仅验证配置，不存储状态）
   * 实际的 systemPrompt 在每次请求时通过 context.systemPrompt 传入或按需构建
   */
  private async initializeSystemPrompt(): Promise<void> {
    try {
      // 验证系统提示配置是否有效（预热构建，但不存储结果）
      const replacePrompt = this.runtimeOptions.systemPrompt;
      const appendPrompt = this.runtimeOptions.appendSystemPrompt;

      const result = await buildSystemPrompt({
        projectPath: process.cwd(),
        replaceDefault: replacePrompt,
        append: appendPrompt,
        includeEnvironment: false,
        language: this.config.language,
      });

      if (result.prompt) {
        this.log('系统提示配置验证成功');
        logger.debug(
          `[SystemPrompt] 可用来源: ${result.sources
            .filter((s) => s.loaded)
            .map((s) => s.name)
            .join(', ')}`
        );
      }
    } catch (error) {
      this.error('系统提示配置验证失败', error);
      // 系统提示失败不应该阻止 Agent 初始化
    }
  }

  /**
   * 获取系统提示（按需构建，无状态设计）
   * @deprecated 建议通过 context.systemPrompt 传入，或使用 buildSystemPromptOnDemand
   */
  public async getSystemPrompt(): Promise<string | undefined> {
    return this.buildSystemPromptOnDemand();
  }

  /**
   * 注册内置工具
   */
  private async registerBuiltinTools(): Promise<void> {
    try {
      // 使用默认 sessionId（因为注册时还没有会话上下文）
      const builtinTools = await getBuiltinTools({
        sessionId: 'default',
        configDir: path.join(os.homedir(), '.blade'),
      });
      logger.debug(`📦 Registering ${builtinTools.length} builtin tools...`);

      this.executionPipeline.getRegistry().registerAll(builtinTools);

      const registeredCount = this.executionPipeline.getRegistry().getAll().length;
      logger.debug(`✅ Builtin tools registered: ${registeredCount} tools`);
      logger.debug(
        `[Tools] ${this.executionPipeline
          .getRegistry()
          .getAll()
          .map((t) => t.name)
          .join(', ')}`
      );

      // 注册 MCP 工具
      await this.registerMcpTools();
    } catch (error) {
      logger.error('Failed to register builtin tools:', error);
      throw error;
    }
  }

  /**
   * 注册 MCP 工具
   */
  private async registerMcpTools(): Promise<void> {
    try {
      const mcpServers: Record<string, McpServerConfig> = this.config.mcpServers || {};
      const targetServerNames = new Set<string>(Object.keys(mcpServers));
      for (const name of this.config.inProcessMcpServerNames || []) {
        targetServerNames.add(name);
      }

      if (targetServerNames.size === 0) {
        logger.debug('📦 No MCP servers configured');
        return;
      }

      const registry = McpRegistry.getInstance();

      for (const [name, config] of Object.entries(mcpServers)) {
        if (config.disabled) {
          logger.debug(`⏭️ MCP server "${name}" is disabled, skipping`);
          continue;
        }
        try {
          logger.debug(`🔌 Connecting to MCP server: ${name}`);
          await registry.registerServer(name, config);
          logger.debug(`✅ MCP server "${name}" connected`);
        } catch (error) {
          logger.warn(`⚠️  MCP server "${name}" connection failed:`, error);
        }
      }

      const mcpTools = await registry.getAvailableToolsByServerNames(
        Array.from(targetServerNames)
      );

      if (mcpTools.length > 0) {
        this.executionPipeline.getRegistry().registerAll(mcpTools);
        logger.debug(`✅ Registered ${mcpTools.length} MCP tools`);
        logger.debug(`[MCP Tools] ${mcpTools.map((t) => t.name).join(', ')}`);
      } else {
        logger.debug('📦 No MCP tools available');
      }
    } catch (error) {
      logger.warn('Failed to register MCP tools:', error);
    }
  }

  /**
   * 加载 subagent 配置
   */
  private async loadSubagents(): Promise<void> {
    // 如果已经加载过，跳过（全局单例，只需加载一次）
    if (subagentRegistry.getAllNames().length > 0) {
      logger.debug(
        `📦 Subagents already loaded: ${subagentRegistry.getAllNames().join(', ')}`
      );
      return;
    }

    try {
      const loadedCount = subagentRegistry.loadFromStandardLocations();
      if (loadedCount > 0) {
        logger.debug(
          `✅ Loaded ${loadedCount} subagents: ${subagentRegistry.getAllNames().join(', ')}`
        );
      } else {
        logger.debug('📦 No subagents configured');
      }
    } catch (error) {
      logger.warn('Failed to load subagents:', error);
      // 不抛出错误，允许 Agent 继续初始化
    }
  }

  /**
   * 发现并注册 Skills
   * Skills 是动态 Prompt 扩展机制，允许 AI 根据用户请求自动调用专业能力
   */
  private async discoverSkills(): Promise<void> {
    try {
      const result = await discoverSkills({
        cwd: process.cwd(),
      });

      if (result.skills.length > 0) {
        logger.debug(
          `✅ Discovered ${result.skills.length} skills: ${result.skills.map((s) => s.name).join(', ')}`
        );
      } else {
        logger.debug('📦 No skills configured');
      }

      // 记录发现过程中的错误（不阻塞初始化）
      for (const error of result.errors) {
        logger.warn(`⚠️  Skill loading error at ${error.path}: ${error.error}`);
      }
    } catch (error) {
      logger.warn('Failed to discover skills:', error);
      // 不抛出错误，允许 Agent 继续初始化
    }
  }

  /**
   * 应用 Skill 的 allowed-tools 限制
   * 如果有活动的 Skill 且定义了 allowed-tools，则过滤可用工具列表
   *
   * @param tools - 原始工具列表
   * @returns 过滤后的工具列表
   */
  private applySkillToolRestrictions(
    tools: import('../tools/types/index.js').FunctionDeclaration[]
  ): import('../tools/types/index.js').FunctionDeclaration[] {
    // 如果没有活动的 Skill，或者 Skill 没有定义 allowed-tools，返回原始工具列表
    if (!this.activeSkillContext?.allowedTools) {
      return tools;
    }

    const allowedTools = this.activeSkillContext.allowedTools;
    logger.debug(`🔒 Applying Skill tool restrictions: ${allowedTools.join(', ')}`);

    // 过滤工具列表，只保留 allowed-tools 中指定的工具
    const filteredTools = tools.filter((tool) => {
      // 检查工具名称是否在 allowed-tools 列表中
      // 支持精确匹配和通配符模式（如 Bash(git:*)）
      return allowedTools.some((allowed) => {
        // 精确匹配
        if (allowed === tool.name) {
          return true;
        }

        // 通配符匹配：Bash(git:*) 匹配 Bash
        const match = allowed.match(/^(\w+)\(.*\)$/);
        if (match && match[1] === tool.name) {
          return true;
        }

        return false;
      });
    });

    logger.debug(
      `🔒 Filtered tools: ${filteredTools.map((t) => t.name).join(', ')} (${filteredTools.length}/${tools.length})`
    );

    return filteredTools;
  }

  /**
   * 清除 Skill 执行上下文
   * 当 Skill 执行完成或需要重置时调用
   */
  public clearSkillContext(): void {
    if (this.activeSkillContext) {
      logger.debug(`🎯 Skill "${this.activeSkillContext.skillName}" deactivated`);
      this.activeSkillContext = undefined;
    }
  }

}
