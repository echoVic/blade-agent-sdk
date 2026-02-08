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
import { streamDebug } from '../logging/StreamDebugLogger.js';
import { McpRegistry } from '../mcp/McpRegistry.js';
import { buildSystemPrompt, createPlanModeReminder } from '../prompts/index.js';
import {
  createChatServiceAsync,
  type IChatService,
  type Message
} from '../services/ChatServiceInterface.js';
import { discoverSkills, injectSkillsMetadata } from '../skills/index.js';
import { getBuiltinTools } from '../tools/builtin/index.js';
import type { TodoItem } from '../tools/builtin/todo/types.js';
import { ExecutionPipeline } from '../tools/execution/ExecutionPipeline.js';
import { ToolRegistry } from '../tools/registry/ToolRegistry.js';
import { type Tool, ToolErrorType, type ToolResult } from '../tools/types/index.js';
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

    const maxContextTokens = modelConfig.maxTokens ?? 128000;
    this.currentModelMaxContextTokens = maxContextTokens;

    this.chatService = await createChatServiceAsync({
      provider: modelConfig.provider,
      apiKey: modelConfig.apiKey || '',
      model: modelConfig.model,
      baseUrl: modelConfig.baseUrl || '',
      temperature: modelConfig.temperature ?? this.config.temperature,
      maxContextTokens: this.currentModelMaxContextTokens,
      supportsThinking,
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

  /**
   * 核心执行循环 - 所有模式共享的通用循环逻辑
   * 持续执行 LLM → 工具 → 结果注入 直到任务完成或达到限制
   *
   * @param message - 用户消息（可能已被 Plan 模式注入 system-reminder）
   * @param context - 聊天上下文（包含 permissionMode，用于决定工具暴露策略）
   * @param options - 循环选项
   * @param systemPrompt - 系统提示词（Plan 模式和普通模式使用不同的提示词）
   */
  private async executeLoop(
    message: UserMessageContent,
    context: ChatContext,
    options?: LoopOptions,
    systemPrompt?: string
  ): Promise<LoopResult> {
    if (!this.isInitialized) {
      throw new Error('Agent未初始化');
    }

    const startTime = Date.now();

    try {
      // 1. 获取可用工具定义
      // 根据 permissionMode 决定工具暴露策略（单一信息源：ToolRegistry.getFunctionDeclarationsByMode）
      const registry = this.executionPipeline.getRegistry();
      const permissionMode = context.permissionMode as PermissionMode | undefined;
      let rawTools = registry.getFunctionDeclarationsByMode(permissionMode);
      // 注入 Skills 元数据到 Skill 工具的 <available_skills> 占位符
      rawTools = injectSkillsMetadata(rawTools);
      // 应用 Skill 的 allowed-tools 限制（如果有活动的 Skill）
      const tools = this.applySkillToolRestrictions(rawTools);
      const isPlanMode = permissionMode === PermissionMode.PLAN;

      if (isPlanMode) {
        const readOnlyTools = registry.getReadOnlyTools();
        logger.debug(
          `🔒 Plan mode: 使用只读工具 (${readOnlyTools.length} 个): ${readOnlyTools.map((t) => t.name).join(', ')}`
        );
      }

      // 2. 构建消息历史
      const needsSystemPrompt =
        context.messages.length === 0 ||
        !context.messages.some((msg) => msg.role === 'system');

      const messages: Message[] = [];

      // 注入系统提示词（由调用方决定使用哪个提示词）
      // 🆕 为 Anthropic 模型启用 Prompt Caching（成本降低 90%，延迟降低 85%）
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

      // 添加历史消息和当前用户消息
      messages.push(...context.messages, { role: 'user', content: message });

      // === 保存用户消息到 JSONL ===
      let lastMessageUuid: string | null = null; // 追踪上一条消息的 UUID,用于建立消息链
      try {
        const contextMgr = this.executionEngine?.getContextManager();
        // 提取纯文本内容用于保存（多模态消息只保存文本部分）
        const textContent =
          typeof message === 'string'
            ? message
            : message
                .filter((p) => p.type === 'text')
                .map((p) => (p as { text: string }).text)
                .join('\n');
        // 🔧 修复：过滤空用户消息（与助手消息保持一致）
        if (contextMgr && context.sessionId && textContent.trim() !== '') {
          lastMessageUuid = await contextMgr.saveMessage(
            context.sessionId,
            'user',
            textContent,
            null,
            undefined,
            context.subagentInfo
          );
        } else if (textContent.trim() === '') {
          logger.debug('[Agent] 跳过保存空用户消息');
        }
      } catch (error) {
        logger.warn('[Agent] 保存用户消息失败:', error);
        // 不阻塞主流程
      }

      // === Agentic Loop: 循环调用直到任务完成 ===
      const SAFETY_LIMIT = 100; // 安全上限（100 轮后询问用户）
      const isYoloMode = context.permissionMode === PermissionMode.YOLO; // YOLO 模式不限制
      // 优先级: runtimeOptions (CLI参数) > options (chat调用参数) > config (配置文件) > 默认值(-1)
      const configuredMaxTurns =
        this.runtimeOptions.maxTurns ?? options?.maxTurns ?? this.config.maxTurns ?? -1;

      // 特殊值处理：maxTurns = 0 完全禁用对话功能
      if (configuredMaxTurns === 0) {
        return {
          success: false,
          error: {
            type: 'chat_disabled',
            message:
              '对话功能已被禁用 (maxTurns=0)。如需启用，请调整配置：\n' +
              '  • CLI 参数: blade --max-turns -1\n' +
              '  • 配置文件: ~/.blade/config.json 中设置 "maxTurns": -1\n' +
              '  • 环境变量: export BLADE_MAX_TURNS=-1',
          },
          metadata: {
            turnsCount: 0,
            toolCallsCount: 0,
            duration: 0,
          },
        };
      }

      // 应用安全上限：-1 表示无限制，但仍受 SAFETY_LIMIT 保护（YOLO 模式除外）
      const maxTurns =
        configuredMaxTurns === -1
          ? SAFETY_LIMIT
          : Math.min(configuredMaxTurns, SAFETY_LIMIT);

      // 调试日志
      if (this.config.debug) {
        logger.debug(
          `[MaxTurns] runtimeOptions: ${this.runtimeOptions.maxTurns}, options: ${options?.maxTurns}, config: ${this.config.maxTurns}, 最终: ${configuredMaxTurns} → ${maxTurns}, YOLO: ${isYoloMode}`
        );
      }

      let turnsCount = 0;
      const allToolResults: ToolResult[] = [];
      let totalTokens = 0; //- 累计 token 使用量
      let lastPromptTokens: number | undefined; // 上一轮 LLM 返回的真实 prompt tokens

      // Agentic Loop: 循环调用直到任务完成
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // === 1. 检查中断信号 ===
        if (options?.signal?.aborted) {
          return {
            success: false,
            error: {
              type: 'aborted',
              message: '任务已被用户中止',
            },
            metadata: {
              turnsCount,
              toolCallsCount: allToolResults.length,
              duration: Date.now() - startTime,
            },
          };
        }

        // === 2. 每轮循环前检查并压缩上下文 ===
        // 📊 记录压缩前的状态，用于判断是否需要重建 messages
        const preCompactLength = context.messages.length;

        // 传递实际要发送给 LLM 的 messages 数组（包含 system prompt）
        // checkAndCompactInLoop 返回是否发生了压缩
        // 🆕 传入上一轮 LLM 返回的真实 prompt tokens（比估算更准确）
        const didCompact = this.compactionHandler
          ? await this.compactionHandler.checkAndCompactInLoop(
              context,
              turnsCount,
              lastPromptTokens, // 首轮为 undefined，使用估算；后续轮次使用真实值
              options?.onCompacting
            )
          : false;

        // 🔧 关键修复：如果发生了压缩，必须重建 messages 数组
        // 即使长度相同但内容不同的压缩场景也能正确处理
        if (didCompact) {
          logger.debug(
            `[Agent] [轮次 ${turnsCount}] 检测到压缩发生，重建 messages 数组 (${preCompactLength} → ${context.messages.length} 条历史消息)`
          );

          // 找到 messages 中非历史部分的起始位置
          // messages 结构: [system?, ...context.messages(旧), user当前消息?, assistant?, tool?...]
          const systemMsgCount = needsSystemPrompt && systemPrompt ? 1 : 0;
          const historyEndIdx = systemMsgCount + preCompactLength;

          // 保留非历史部分（当前轮次新增的消息）
          const systemMessages = messages.slice(0, systemMsgCount);
          const newMessages = messages.slice(historyEndIdx); // 当前轮次新增的 user/assistant/tool

          // 重建：system + 压缩后的历史 + 当前轮次新增
          messages.length = 0; // 清空原数组
          messages.push(...systemMessages, ...context.messages, ...newMessages);

          logger.debug(
            `[Agent] [轮次 ${turnsCount}] messages 重建完成: ${systemMessages.length} system + ${context.messages.length} 历史 + ${newMessages.length} 新增 = ${messages.length} 总计`
          );
        }

        // === 3. 轮次计数 ===
        turnsCount++;
        logger.debug(`🔄 [轮次 ${turnsCount}/${maxTurns}] 调用 LLM...`);

        // 再次检查 abort 信号（在调用 LLM 前）
        if (options?.signal?.aborted) {
          return {
            success: false,
            error: {
              type: 'aborted',
              message: '任务已被用户中止',
            },
            metadata: {
              turnsCount: turnsCount - 1, // 这一轮还没开始
              toolCallsCount: allToolResults.length,
              duration: Date.now() - startTime,
            },
          };
        }

        // 触发轮次开始事件 (供 UI 显示进度)
        options?.onTurnStart?.({ turn: turnsCount, maxTurns });

        // 🔍 调试：打印发送给 LLM 的消息
        logger.debug('\n========== 发送给 LLM ==========');
        logger.debug('轮次:', turnsCount + 1);
        logger.debug('消息数量:', messages.length);
        logger.debug('最后 3 条消息:');
        messages.slice(-3).forEach((msg, idx) => {
          logger.debug(
            `  [${idx}] ${msg.role}:`,
            typeof msg.content === 'string'
              ? msg.content.substring(0, 100) + (msg.content.length > 100 ? '...' : '')
              : JSON.stringify(msg.content).substring(0, 100)
          );
          if (msg.tool_calls) {
            logger.debug(
              '    tool_calls:',
              msg.tool_calls
                .map((tc) => ('function' in tc ? tc.function.name : tc.type))
                .join(', ')
            );
          }
        });
        logger.debug('可用工具数量:', tools.length);
        logger.debug('================================\n');

        // 3. 调用 ChatService（流式或非流式）
        // 默认启用流式，除非显式设置 stream: false
        const isStreamEnabled = options?.stream !== false;
        const turnResult = isStreamEnabled && this.streamHandler
          ? await this.streamHandler.processStreamResponse(messages, tools, options)
          : await this.chatService.chat(messages, tools, options?.signal);

        streamDebug('executeLoop', 'after processStreamResponse/chat', {
          isStreamEnabled,
          turnResultContentLen: turnResult.content?.length ?? 0,
          turnResultToolCallsLen: turnResult.toolCalls?.length ?? 0,
          hasReasoningContent: !!turnResult.reasoningContent,
        });

        // 累加 token 使用量，并保存真实的 prompt tokens 用于下一轮压缩检查
        if (turnResult.usage) {
          if (turnResult.usage.totalTokens) {
            totalTokens += turnResult.usage.totalTokens;
          }
          // 保存真实的 prompt tokens，用于下一轮循环的压缩检查（比估算更准确）
          lastPromptTokens = turnResult.usage.promptTokens;
          logger.debug(
            `[Agent] LLM usage: prompt=${lastPromptTokens}, completion=${turnResult.usage.completionTokens}, total=${turnResult.usage.totalTokens}`
          );

          // 通知 UI 更新 token 使用量
          if (options?.onTokenUsage) {
            options.onTokenUsage({
              inputTokens: turnResult.usage.promptTokens ?? 0,
              outputTokens: turnResult.usage.completionTokens ?? 0,
              totalTokens,
              maxContextTokens: this.currentModelMaxContextTokens,
            });
          }
        }

        // 检查 abort 信号（LLM 调用后）
        if (options?.signal?.aborted) {
          return {
            success: false,
            error: {
              type: 'aborted',
              message: '任务已被用户中止',
            },
            metadata: {
              turnsCount: turnsCount - 1,
              toolCallsCount: allToolResults.length,
              duration: Date.now() - startTime,
            },
          };
        }

        // 🔍 调试：打印模型返回
        logger.debug('\n========== LLM 返回 ==========');
        logger.debug('Content:', turnResult.content);
        logger.debug('Tool Calls:', JSON.stringify(turnResult.toolCalls, null, 2));
        logger.debug('当前权限模式:', context.permissionMode);
        logger.debug('================================\n');

        // 🆕 如果 LLM 返回了 thinking 内容（DeepSeek R1 等），通知 UI
        // 流式模式下，增量已通过 onThinkingDelta 发送，这里发送完整内容用于兼容
        // 非流式模式下，这是唯一的通知途径
        // 注意：检查 abort 状态，避免取消后仍然触发回调
        if (
          turnResult.reasoningContent &&
          options?.onThinking &&
          !options.signal?.aborted
        ) {
          options.onThinking(turnResult.reasoningContent);
        }

        // 🆕 如果 LLM 返回了 content，通知 UI
        // 流式模式下：增量已通过 onContentDelta 发送，调用 onStreamEnd 标记结束
        // 非流式模式下：调用 onContent 发送完整内容
        // 注意：检查 abort 状态，避免取消后仍然触发回调
        if (
          turnResult.content &&
          turnResult.content.trim() &&
          !options?.signal?.aborted
        ) {
          if (isStreamEnabled) {
            streamDebug('executeLoop', 'calling onStreamEnd (stream mode)', {
              contentLen: turnResult.content.length,
            });
            options?.onStreamEnd?.();
          } else if (options?.onContent) {
            streamDebug('executeLoop', 'calling onContent (non-stream mode)', {
              contentLen: turnResult.content.length,
            });
            options.onContent(turnResult.content);
          }
        }

        // 4. 检查是否需要工具调用（任务完成条件）
        if (!turnResult.toolCalls || turnResult.toolCalls.length === 0) {
          // === 检测"意图未完成"模式 ===
          // 某些模型（如 qwen）会说"让我来..."但不实际调用工具
          const INCOMPLETE_INTENT_PATTERNS = [
            /：\s*$/, // 中文冒号结尾
            /:\s*$/, // 英文冒号结尾
            /\.\.\.\s*$/, // 省略号结尾
            /让我(先|来|开始|查看|检查|修复)/, // 中文意图词
            /Let me (first|start|check|look|fix)/i, // 英文意图词
          ];

          const content = turnResult.content || '';
          const isIncompleteIntent = INCOMPLETE_INTENT_PATTERNS.some((p) =>
            p.test(content)
          );

          // 统计最近的重试消息数量（避免无限循环）
          const RETRY_PROMPT = '请执行你提到的操作，不要只是描述。';
          const recentRetries = messages
            .slice(-10)
            .filter((m) => m.role === 'user' && m.content === RETRY_PROMPT).length;

          if (isIncompleteIntent && recentRetries < 2) {
            logger.debug(
              `⚠️ 检测到意图未完成（重试 ${recentRetries + 1}/2）: "${content.slice(-50)}"`
            );

            // 追加提示消息，要求 LLM 执行操作
            messages.push({
              role: 'user',
              content: RETRY_PROMPT,
            });

            // 继续循环，不返回
            continue;
          }

          logger.debug('✅ 任务完成 - LLM 未请求工具调用');

          // === 执行 Stop Hook ===
          // Stop hook 可以阻止 Agent 停止，强制继续执行
          try {
            const hookManager = HookManager.getInstance();
            const stopResult = await hookManager.executeStopHooks({
              projectDir: process.cwd(),
              sessionId: context.sessionId,
              permissionMode: context.permissionMode as PermissionMode,
              reason: turnResult.content,
              abortSignal: options?.signal,
            });

            // 如果 hook 返回 shouldStop: false，继续执行
            if (!stopResult.shouldStop) {
              logger.debug(
                `🔄 Stop hook 阻止停止，继续执行: ${stopResult.continueReason || '(无原因)'}`
              );

              // 将 continueReason 注入到消息中
              const continueMessage = stopResult.continueReason
                ? `\n\n<system-reminder>\n${stopResult.continueReason}\n</system-reminder>`
                : '\n\n<system-reminder>\nPlease continue the conversation from where we left it off without asking the user any further questions. Continue with the last task that you were asked to work on.\n</system-reminder>';

              messages.push({
                role: 'user',
                content: continueMessage,
              });

              // 继续循环
              continue;
            }

            // 如果有警告，记录日志
            if (stopResult.warning) {
              logger.warn(`[Agent] Stop hook warning: ${stopResult.warning}`);
            }
          } catch (hookError) {
            // Hook 执行失败不应阻止正常退出
            logger.warn('[Agent] Stop hook execution failed:', hookError);
          }

          // === 保存助手最终响应到 JSONL ===
          try {
            const contextMgr = this.executionEngine?.getContextManager();
            if (contextMgr && context.sessionId && turnResult.content) {
              // 🆕 跳过空内容或纯空格的消息
              if (turnResult.content.trim() !== '') {
                lastMessageUuid = await contextMgr.saveMessage(
                  context.sessionId,
                  'assistant',
                  turnResult.content,
                  lastMessageUuid,
                  undefined,
                  context.subagentInfo
                );
              } else {
                logger.debug('[Agent] 跳过保存空响应（任务完成时）');
              }
            }
          } catch (error) {
            logger.warn('[Agent] 保存助手消息失败:', error);
          }

          return {
            success: true,
            finalMessage: turnResult.content,
            metadata: {
              turnsCount,
              toolCallsCount: allToolResults.length,
              duration: Date.now() - startTime,
              tokensUsed: totalTokens,
            },
          };
        }

        // 5. 添加 LLM 的响应到消息历史（包含 tool_calls 和 reasoningContent）
        messages.push({
          role: 'assistant',
          content: turnResult.content || '',
          reasoningContent: turnResult.reasoningContent, // ✅ 保存 thinking 推理内容
          tool_calls: turnResult.toolCalls,
        });

        // === 保存助手的工具调用请求到 JSONL ===
        try {
          const contextMgr = this.executionEngine?.getContextManager();
          if (contextMgr && context.sessionId && turnResult.content) {
            // 🆕 跳过空内容或纯空格的消息
            if (turnResult.content.trim() !== '') {
              // 保存助手消息（包含工具调用意图）
              lastMessageUuid = await contextMgr.saveMessage(
                context.sessionId,
                'assistant',
                turnResult.content,
                lastMessageUuid,
                undefined,
                context.subagentInfo
              );
            } else {
              logger.debug('[Agent] 跳过保存空响应（工具调用时）');
            }
          }
        } catch (error) {
          logger.warn('[Agent] 保存助手工具调用消息失败:', error);
        }

        // 6. 并行执行所有工具调用（Claude Code 风格）
        // LLM 被提示只把无依赖的工具放在同一响应中，因此可以安全地并行执行

        // 在执行前检查取消信号
        if (options?.signal?.aborted) {
          logger.info(
            '[Agent] Aborting before tool execution due to signal.aborted=true'
          );
          return {
            success: false,
            error: {
              type: 'aborted',
              message: '任务已被用户中止',
            },
            metadata: {
              turnsCount,
              toolCallsCount: allToolResults.length,
              duration: Date.now() - startTime,
            },
          };
        }

        // 过滤出有效的函数调用
        const functionCalls = turnResult.toolCalls.filter(
          (tc) => tc.type === 'function'
        );

        // 触发所有工具开始回调（并行执行前）
        if (options?.onToolStart && !options.signal?.aborted) {
          for (const toolCall of functionCalls) {
            const toolDef = this.executionPipeline
              .getRegistry()
              .get(toolCall.function.name);
            const toolKind = toolDef?.kind as
              | 'readonly'
              | 'write'
              | 'execute'
              | undefined;
            options.onToolStart(toolCall, toolKind);
          }
        }

        // 定义单个工具执行的 Promise
        const executeToolCall = async (
          toolCall: (typeof functionCalls)[0]
        ): Promise<{
          toolCall: typeof toolCall;
          result: ToolResult;
          toolUseUuid: string | null;
          error?: Error;
        }> => {
          try {
            // 解析工具参数
            const params = JSON.parse(toolCall.function.arguments);
            if (
              toolCall.function.name === 'Task' &&
              (typeof params.subagent_session_id !== 'string' ||
                params.subagent_session_id.length === 0)
            ) {
              params.subagent_session_id =
                typeof params.resume === 'string' && params.resume.length > 0
                  ? params.resume
                  : nanoid();
            }

            // 智能修复: 如果 todos 参数被错误地序列化为字符串,自动解析
            if (params.todos && typeof params.todos === 'string') {
              try {
                params.todos = JSON.parse(params.todos);
                this.log('[Agent] 自动修复了字符串化的 todos 参数');
              } catch {
                this.error('[Agent] todos 参数格式异常,将由验证层处理');
              }
            }

            // === 保存工具调用到 JSONL (tool_use) ===
            let toolUseUuid: string | null = null;
            try {
              const contextMgr = this.executionEngine?.getContextManager();
              if (contextMgr && context.sessionId) {
                toolUseUuid = await contextMgr.saveToolUse(
                  context.sessionId,
                  toolCall.function.name,
                  params,
                  lastMessageUuid,
                  context.subagentInfo
                );
              }
            } catch (error) {
              logger.warn('[Agent] 保存工具调用失败:', error);
            }

            // 使用 ExecutionPipeline 执行工具
            const signalToUse = options?.signal;
            if (!signalToUse) {
              logger.error(
                '[Agent] Missing signal in tool execution, this should not happen'
              );
            }

            logger.debug(
              '[Agent] Passing confirmationHandler to ExecutionPipeline.execute:',
              {
                toolName: toolCall.function.name,
                hasHandler: !!context.confirmationHandler,
                hasMethod: !!context.confirmationHandler?.requestConfirmation,
                methodType: typeof context.confirmationHandler?.requestConfirmation,
              }
            );

            const result = await this.executionPipeline.execute(
              toolCall.function.name,
              params,
              {
                sessionId: context.sessionId,
                userId: context.userId || 'default',
                workspaceRoot: context.workspaceRoot || process.cwd(),
                signal: signalToUse,
                confirmationHandler: context.confirmationHandler,
                permissionMode: context.permissionMode,
              }
            );

            // 🔍 调试日志
            logger.debug('\n========== 工具执行结果 ==========');
            logger.debug('工具名称:', toolCall.function.name);
            logger.debug('成功:', result.success);
            logger.debug('LLM Content:', result.llmContent);
            logger.debug('Display Content:', result.displayContent);
            if (result.error) {
              logger.debug('错误:', result.error);
            }
            logger.debug('==================================\n');

            return { toolCall, result, toolUseUuid };
          } catch (error) {
            logger.error(`Tool execution failed for ${toolCall.function.name}:`, error);
            return {
              toolCall,
              result: {
                success: false,
                llmContent: '',
                displayContent: '',
                error: {
                  type: ToolErrorType.EXECUTION_ERROR,
                  message: error instanceof Error ? error.message : 'Unknown error',
                },
              },
              toolUseUuid: null,
              error: error instanceof Error ? error : new Error('Unknown error'),
            };
          }
        };

        // 🚀 并行执行所有工具调用
        logger.info(`[Agent] Executing ${functionCalls.length} tool calls in parallel`);
        const executionResults = await Promise.all(functionCalls.map(executeToolCall));

        // 按顺序处理执行结果（保持与原始 tool_calls 顺序一致）
        for (const { toolCall, result, toolUseUuid } of executionResults) {
          allToolResults.push(result);

          // 检查是否应该退出循环
          if (result.metadata?.shouldExitLoop) {
            logger.debug('🚪 检测到退出循环标记，结束 Agent 循环');
            const finalMessage =
              typeof result.llmContent === 'string' ? result.llmContent : '循环已退出';

            return {
              success: result.success,
              finalMessage,
              metadata: {
                turnsCount,
                toolCallsCount: allToolResults.length,
                duration: Date.now() - startTime,
                shouldExitLoop: true,
                targetMode: result.metadata?.targetMode,
              },
            };
          }

          // 调用 onToolResult 回调
          if (options?.onToolResult && !options.signal?.aborted) {
            logger.debug('[Agent] Calling onToolResult:', {
              toolName: toolCall.function.name,
              hasCallback: true,
              resultSuccess: result.success,
              resultKeys: Object.keys(result),
              hasMetadata: !!result.metadata,
              metadataKeys: result.metadata ? Object.keys(result.metadata) : [],
              hasSummary: !!result.metadata?.summary,
              summary: result.metadata?.summary,
            });
            try {
              await options.onToolResult(toolCall, result);
              logger.debug('[Agent] onToolResult callback completed successfully');
            } catch (err) {
              logger.error('[Agent] onToolResult callback error:', err);
            }
          }

          // === 保存工具结果到 JSONL (tool_result) ===
          try {
            const contextMgr = this.executionEngine?.getContextManager();
            if (contextMgr && context.sessionId) {
              const metadata =
                result.metadata && typeof result.metadata === 'object'
                  ? (result.metadata as Record<string, unknown>)
                  : undefined;
              const isSubagentStatus = (
                value: unknown
              ): value is 'running' | 'completed' | 'failed' | 'cancelled' =>
                value === 'running' ||
                value === 'completed' ||
                value === 'failed' ||
                value === 'cancelled';
              const subagentStatus = isSubagentStatus(metadata?.subagentStatus)
                ? metadata.subagentStatus
                : 'completed';
              const subagentRef =
                metadata && typeof metadata.subagentSessionId === 'string'
                  ? {
                      subagentSessionId: metadata.subagentSessionId,
                      subagentType:
                        typeof metadata.subagentType === 'string'
                          ? metadata.subagentType
                          : toolCall.function.name,
                      subagentStatus,
                      subagentSummary:
                        typeof metadata.subagentSummary === 'string'
                          ? metadata.subagentSummary
                          : undefined,
                    }
                  : undefined;
              lastMessageUuid = await contextMgr.saveToolResult(
                context.sessionId,
                toolCall.id,
                toolCall.function.name,
                result.success ? toJsonValue(result.llmContent) : null,
                toolUseUuid,
                result.success ? undefined : result.error?.message,
                context.subagentInfo,
                subagentRef
              );
            }
          } catch (err) {
            logger.warn('[Agent] 保存工具结果失败:', err);
          }

          if (
            toolCall.function.name === 'TodoWrite' &&
            result.success &&
            result.llmContent
          ) {
            const content =
              typeof result.llmContent === 'object' ? result.llmContent : {};
            const todos = Array.isArray(content)
              ? content
              : ((content as Record<string, unknown>).todos as unknown[]) || [];
            const typedTodos = todos as TodoItem[];
            options?.onTodoUpdate?.(typedTodos);
          }

          // 如果是 Skill 工具，设置执行上下文
          if (toolCall.function.name === 'Skill' && result.success && result.metadata) {
            const metadata = result.metadata as Record<string, unknown>;
            if (metadata.skillName) {
              this.activeSkillContext = {
                skillName: metadata.skillName as string,
                allowedTools: metadata.allowedTools as string[] | undefined,
                basePath: (metadata.basePath as string) || '',
              };
              logger.debug(
                `🎯 Skill "${this.activeSkillContext.skillName}" activated` +
                  (this.activeSkillContext.allowedTools
                    ? ` with allowed tools: ${this.activeSkillContext.allowedTools.join(', ')}`
                    : '')
              );
            }
          }

          const modelId =
            result.metadata?.modelId?.trim() ||
            result.metadata?.model?.trim() ||
            undefined;
          if (modelId) {
            await this.switchModelIfNeeded(modelId);
          }

          // 添加工具执行结果到消息历史
          let toolResultContent = result.success
            ? result.llmContent || result.displayContent || ''
            : result.error?.message || '执行失败';

          if (typeof toolResultContent === 'object' && toolResultContent !== null) {
            toolResultContent = JSON.stringify(toolResultContent, null, 2);
          }

          const finalContent =
            typeof toolResultContent === 'string'
              ? toolResultContent
              : JSON.stringify(toolResultContent);

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: finalContent,
          });
        }

        // 检查工具执行后的中断信号
        if (options?.signal?.aborted) {
          return {
            success: false,
            error: {
              type: 'aborted',
              message: '任务已被用户中止',
            },
            metadata: {
              turnsCount,
              toolCallsCount: allToolResults.length,
              duration: Date.now() - startTime,
            },
          };
        }

        // === 7. 检查轮次上限（非 YOLO 模式） ===
        if (turnsCount >= maxTurns && !isYoloMode) {
          logger.info(`⚠️ 达到轮次上限 ${maxTurns} 轮，等待用户确认...`);

          if (options?.onTurnLimitReached) {
            // 交互模式：询问用户
            const response = await options.onTurnLimitReached({ turnsCount });

            if (response?.continue) {
              // 用户选择继续，先压缩上下文
              logger.info('✅ 用户选择继续，压缩上下文...');

              try {
                const chatConfig = this.chatService.getConfig();
                const compactResult = await CompactionService.compact(
                  context.messages,
                  {
                    trigger: 'auto',
                    modelName: chatConfig.model,
                    maxContextTokens:
                      chatConfig.maxContextTokens ?? 128000,
                    apiKey: chatConfig.apiKey,
                    baseURL: chatConfig.baseUrl,
                    actualPreTokens: lastPromptTokens,
                  }
                );

                // 更新 context.messages 为压缩后的消息
                context.messages = compactResult.compactedMessages;

                // 重建 messages 数组
                const systemMsg = messages.find((m) => m.role === 'system');
                messages.length = 0;
                if (systemMsg) {
                  messages.push(systemMsg);
                }
                messages.push(...context.messages);

                // 添加继续执行的指令
                const continueMessage: Message = {
                  role: 'user',
                  content:
                    'This session is being continued from a previous conversation. ' +
                    'The conversation is summarized above.\n\n' +
                    'Please continue the conversation from where we left it off without asking the user any further questions. ' +
                    'Continue with the last task that you were asked to work on.',
                };
                messages.push(continueMessage);
                context.messages.push(continueMessage);

                // 保存压缩数据到 JSONL
                try {
                  const contextMgr = this.executionEngine?.getContextManager();
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
              } catch (compactError) {
                // 压缩失败时的降级处理
                logger.error('[Agent] 压缩失败，使用降级策略:', compactError);

                const systemMsg = messages.find((m) => m.role === 'system');
                const recentMessages = messages.slice(-80);
                messages.length = 0;
                if (systemMsg && !recentMessages.some((m) => m.role === 'system')) {
                  messages.push(systemMsg);
                }
                messages.push(...recentMessages);
                context.messages = messages.filter((m) => m.role !== 'system');

                logger.warn(`⚠️ 降级压缩完成，保留 ${messages.length} 条消息`);
              }

              turnsCount = 0;
              continue; // 继续循环
            }

            // 用户选择停止
            return {
              success: true,
              finalMessage: response?.reason || '已达到对话轮次上限，用户选择停止',
              metadata: {
                turnsCount,
                toolCallsCount: allToolResults.length,
                duration: Date.now() - startTime,
                tokensUsed: totalTokens,
              },
            };
          }

          // 非交互模式：直接停止
          return {
            success: false,
            error: {
              type: 'max_turns_exceeded',
              message: `已达到轮次上限 (${maxTurns} 轮)。使用 --permission-mode yolo 跳过此限制。`,
            },
            metadata: {
              turnsCount,
              toolCallsCount: allToolResults.length,
              duration: Date.now() - startTime,
              tokensUsed: totalTokens,
            },
          };
        }

        // 继续下一轮循环...
      }
    } catch (error) {
      // 检查是否是用户主动中止
      if (
        error instanceof Error &&
        (error.name === 'AbortError' || error.message.includes('aborted'))
      ) {
        return {
          success: false,
          error: {
            type: 'aborted',
            message: '任务已被用户中止',
          },
          metadata: {
            turnsCount: 0,
            toolCallsCount: 0,
            duration: Date.now() - startTime,
          },
        };
      }

      logger.error('Enhanced chat processing error:', error);
      return {
        success: false,
        error: {
          type: 'api_error',
          message: `处理消息时发生错误: ${error instanceof Error ? error.message : '未知错误'}`,
          details: error,
        },
        metadata: {
          turnsCount: 0,
          toolCallsCount: 0,
          duration: Date.now() - startTime,
        },
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

      if (Object.keys(mcpServers).length === 0) {
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

      const mcpTools = await registry.getAvailableTools();

      if (mcpTools.length > 0) {
        this.executionPipeline.getRegistry().registerAll(mcpTools);
        logger.debug(`✅ Registered ${mcpTools.length} MCP tools`);
        logger.debug(`[MCP Tools] ${mcpTools.map((t) => t.name).join(', ')}`);
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
