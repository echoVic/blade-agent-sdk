/**
 * Agent核心类 - Facade 设计
 *
 * 设计原则：
 * 1. Agent 本身不保存任何会话状态（sessionId, messages 等）
 * 2. 所有状态通过 context 参数传入
 * 3. Agent 实例可以每次命令创建，用完即弃
 * 4. 历史连续性由外部 SessionContext 保证
 *
 * 职责：组装子模块 + 暴露公共 API
 * 实际逻辑委托给：ModelManager, PlanExecutor, LoopRunner
 */

import * as os from 'os';
import * as path from 'path';
import type { ContextManager } from '../context/ContextManager.js';
import { createLogger, LogCategory } from '../logging/Logger.js';
import { McpRegistry } from '../mcp/McpRegistry.js';
import { buildSystemPrompt } from '../prompts/index.js';
import {
  type IChatService,
  type Message,
} from '../services/ChatServiceInterface.js';
import { discoverSkills } from '../skills/index.js';
import { getBuiltinTools } from '../tools/builtin/index.js';
import { ExecutionPipeline } from '../tools/execution/ExecutionPipeline.js';
import { ToolRegistry } from '../tools/registry/ToolRegistry.js';
import type { Tool } from '../tools/types/index.js';
import {
  type BladeConfig,
  type McpServerConfig,
  PermissionMode,
  type PermissionsConfig,
} from '../types/common.js';
import { AttachmentHandler } from './AttachmentHandler.js';
import { CompactionHandler } from './CompactionHandler.js';
import { LoopRunner } from './LoopRunner.js';
import { ModelManager } from './ModelManager.js';
import { PlanExecutor } from './PlanExecutor.js';
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

const logger = createLogger(LogCategory.AGENT);

export class Agent {
  private config: BladeConfig;
  private runtimeOptions: AgentOptions;
  private isInitialized = false;
  private activeTask?: AgentTask;
  private executionPipeline: ExecutionPipeline;

  // 子模块
  private modelManager: ModelManager;
  private planExecutor: PlanExecutor;
  private loopRunner!: LoopRunner;
  private attachmentHandler?: AttachmentHandler;
  private mcpRegistry: McpRegistry;

  constructor(
    config: BladeConfig,
    runtimeOptions: AgentOptions = {},
    executionPipeline?: ExecutionPipeline,
  ) {
    this.config = config;
    this.runtimeOptions = runtimeOptions;
    this.executionPipeline = executionPipeline || this.createDefaultPipeline();
    this.modelManager = new ModelManager(config, runtimeOptions.outputFormat);
    this.planExecutor = new PlanExecutor(config.language);
    this.mcpRegistry = new McpRegistry();
  }

  // ===== 静态工厂 =====

  static async create(config: BladeConfig, options: AgentOptions = {}): Promise<Agent> {
    const models = config.models || [];
    if (models.length === 0) {
      throw new Error(
        '❌ 没有可用的模型配置\n\n'
          + '请先使用以下命令添加模型：\n'
          + '  /model add\n\n'
          + '或运行初始化向导：\n'
          + '  /init'
      );
    }

    const agent = new Agent(config, options);
    await agent.initialize();

    if (options.toolWhitelist && options.toolWhitelist.length > 0) {
      agent.applyToolWhitelist(options.toolWhitelist);
    }

    return agent;
  }

  // ===== 初始化 =====

  public async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      this.log('初始化Agent...');

      // 1. 验证系统提示配置
      await this.initializeSystemPrompt();

      // 2. 注册内置工具
      await this.registerBuiltinTools();

      // 3. 加载 subagent 配置
      await this.loadSubagents();

      // 4. 发现并注册 Skills
      await this.discoverSkills();

      // 5. 初始化模型
      const modelConfig = this.modelManager.resolveModelConfig(this.runtimeOptions.modelId);
      await this.modelManager.applyModelConfig(modelConfig, '🚀 使用模型:');

      // 6. 初始化处理器
      this.attachmentHandler = new AttachmentHandler(process.cwd());
      const streamHandler = new StreamResponseHandler(
        () => this.modelManager.getChatService()
      );
      const compactionHandler = new CompactionHandler(
        () => this.modelManager.getChatService(),
        () => this.modelManager.getExecutionEngine()?.getContextManager()
      );

      // 7. 组装 LoopRunner
      this.loopRunner = new LoopRunner(
        this.config,
        this.runtimeOptions,
        this.modelManager,
        this.executionPipeline,
        streamHandler,
        compactionHandler,
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

  // ===== 公共聊天接口 =====

  public async chat(
    message: UserMessageContent,
    context?: ChatContext,
    options?: LoopOptions,
  ): Promise<string> {
    if (!this.isInitialized) throw new Error('Agent未初始化');

    const enhancedMessage = this.attachmentHandler
      ? await this.attachmentHandler.processAtMentionsForContent(message)
      : message;

    if (context) {
      const loopOptions: LoopOptions = { signal: context.signal, ...options };

      let result: LoopResult;
      if (context.permissionMode === 'plan') {
        result = await this.planExecutor.runPlanLoop(
          enhancedMessage, context, loopOptions,
          (msg, ctx, opts, sp) => this.loopRunner.executeLoop(msg, ctx, opts, sp),
        );
      } else {
        result = await this.loopRunner.runLoop(enhancedMessage, context, loopOptions);
      }

      if (!result.success) {
        if (result.error?.type === 'aborted' || result.metadata?.shouldExitLoop) return '';
        throw new Error(result.error?.message || '执行失败');
      }

      if (result.metadata?.targetMode && context.permissionMode === 'plan') {
        return this.executePlanApproval(enhancedMessage, context, loopOptions, result);
      }

      return result.finalMessage || '';
    }

    // 简单流程
    const textPrompt = typeof enhancedMessage === 'string'
      ? enhancedMessage
      : enhancedMessage
          .filter((p) => p.type === 'text')
          .map((p) => (p as { text: string }).text)
          .join('\n');

    const task: AgentTask = { id: this.generateTaskId(), type: 'simple', prompt: textPrompt };
    const response = await this.executeTask(task);
    return response.content;
  }

  public streamChat(
    message: UserMessageContent,
    context?: ChatContext,
    options?: LoopOptions,
  ): AsyncGenerator<AgentEvent, LoopResult> {
    if (!this.isInitialized) throw new Error('Agent未初始化');

    const self = this;
    const run = async () => {
      const enhancedMessage = self.attachmentHandler
        ? await self.attachmentHandler.processAtMentionsForContent(message)
        : message;

      if (!context) throw new Error('Context is required for streaming');

      const loopOptions: LoopOptions = { signal: context.signal, ...options };

      if (context.permissionMode === 'plan') {
        const planStream = self.planExecutor.runPlanLoopStream(
          enhancedMessage, context, loopOptions,
          (msg, ctx, opts, sp) => self.loopRunner.executeWithAgentLoop(msg, ctx, opts, sp),
        );
        let planResult: LoopResult | undefined;
        const events: AgentEvent[] = [];
        while (true) {
          const { value, done } = await planStream.next();
          if (done) { planResult = value; break; }
          events.push(value);
        }

        if (planResult?.metadata?.targetMode) {
          const targetMode = planResult.metadata.targetMode as PermissionMode;
          const planContent = planResult.metadata.planContent as string | undefined;
          const newContext: ChatContext = { ...context, permissionMode: targetMode };
          const messageWithPlan = self.injectPlanContent(enhancedMessage, planContent);
          return {
            events,
            continuation: self.loopRunner.runLoopStream(messageWithPlan, newContext, loopOptions),
          };
        }
        return { events, result: planResult };
      }

      return { continuation: self.loopRunner.runLoopStream(enhancedMessage, context, loopOptions) };
    };

    const generator = run();
    const wrapper = async function* (): AsyncGenerator<AgentEvent, LoopResult> {
      const outcome = await generator;
      if ('events' in outcome && outcome.events) {
        for (const event of outcome.events) yield event;
      }
      if ('continuation' in outcome && outcome.continuation) {
        return yield* outcome.continuation;
      }
      return outcome.result!;
    };
    return wrapper();
  }

  public async runAgenticLoop(
    message: string,
    context: ChatContext,
    options?: LoopOptions,
  ): Promise<LoopResult> {
    if (!this.isInitialized) throw new Error('Agent未初始化');

    const chatContext: ChatContext = {
      messages: context.messages,
      userId: context.userId || 'subagent',
      sessionId: context.sessionId || `subagent_${Date.now()}`,
      workspaceRoot: context.workspaceRoot || process.cwd(),
      signal: context.signal,
      confirmationHandler: context.confirmationHandler,
      permissionMode: context.permissionMode,
      systemPrompt: context.systemPrompt,
      subagentInfo: context.subagentInfo,
    };

    return await this.loopRunner.runLoop(message, chatContext, options);
  }

  public async chatWithSystem(systemPrompt: string, message: string): Promise<string> {
    if (!this.isInitialized) throw new Error('Agent未初始化');
    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message },
    ];
    const response = await this.modelManager.getChatService().chat(messages);
    return response.content;
  }

  // ===== 任务执行 =====

  public async executeTask(task: AgentTask): Promise<AgentResponse> {
    if (!this.isInitialized) throw new Error('Agent未初始化');
    this.activeTask = task;
    try {
      this.log(`开始执行任务: ${task.id}`);
      const response = await this.modelManager.getExecutionEngine().executeTask(task);
      this.activeTask = undefined;
      this.log(`任务执行完成: ${task.id}`);
      return response;
    } catch (error) {
      this.activeTask = undefined;
      this.error(`任务执行失败: ${task.id}`, error);
      throw error;
    }
  }

  // ===== Getters =====

  public getActiveTask(): AgentTask | undefined { return this.activeTask; }
  public getChatService(): IChatService { return this.modelManager.getChatService(); }
  public getContextManager(): ContextManager | undefined {
    return this.modelManager.getExecutionEngine()?.getContextManager();
  }
  public getAvailableTools(): Tool[] {
    return this.executionPipeline ? this.executionPipeline.getRegistry().getAll() : [];
  }
  public getToolRegistry(): ToolRegistry {
    return this.executionPipeline.getRegistry();
  }

  public getStats(): Record<string, unknown> {
    return {
      initialized: this.isInitialized,
      activeTask: this.activeTask?.id,
      components: {
        chatService: this.modelManager.getChatService() ? 'ready' : 'not_loaded',
        executionEngine: this.modelManager.getExecutionEngine() ? 'ready' : 'not_loaded',
      },
    };
  }

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

  public applyToolWhitelist(whitelist: string[]): void {
    const registry = this.executionPipeline.getRegistry();
    const allTools = registry.getAll();
    const toolsToRemove = allTools.filter((tool) => !whitelist.includes(tool.name));
    for (const tool of toolsToRemove) registry.unregister(tool.name);
    logger.debug(`🔒 Applied tool whitelist: ${whitelist.join(', ')} (removed ${toolsToRemove.length} tools)`);
  }

  public clearSkillContext(): void {
    this.loopRunner.clearSkillContext();
  }

  /** @deprecated 建议通过 context.systemPrompt 传入 */
  public async getSystemPrompt(): Promise<string | undefined> {
    return this.loopRunner.buildSystemPromptOnDemand();
  }

  public async destroy(): Promise<void> {
    this.log('销毁Agent...');
    this.isInitialized = false;
    this.log('Agent已销毁');
  }

  // ===== Private Helpers =====

  private createDefaultPipeline(): ExecutionPipeline {
    const registry = new ToolRegistry();
    const permissions: PermissionsConfig = {
      ...this.config.permissions,
      ...this.runtimeOptions.permissions,
    };
    const permissionMode = this.runtimeOptions.permissionMode ?? PermissionMode.DEFAULT;
    return new ExecutionPipeline(registry, {
      permissionConfig: permissions,
      permissionMode,
      maxHistorySize: 1000,
      canUseTool: this.runtimeOptions.canUseTool,
    });
  }

  private async executePlanApproval(
    enhancedMessage: UserMessageContent,
    context: ChatContext,
    loopOptions: LoopOptions,
    result: LoopResult,
  ): Promise<string> {
    const targetMode = result.metadata!.targetMode as PermissionMode;
    const planContent = result.metadata!.planContent as string | undefined;
    logger.debug(`🔄 Plan 模式已批准，切换到 ${targetMode} 模式并重新执行`);

    const newContext: ChatContext = { ...context, permissionMode: targetMode };
    const messageWithPlan = this.injectPlanContent(enhancedMessage, planContent);

    const newResult = await this.loopRunner.runLoop(messageWithPlan, newContext, loopOptions);
    if (!newResult.success) throw new Error(newResult.error?.message || '执行失败');
    return newResult.finalMessage || '';
  }

  private injectPlanContent(
    message: UserMessageContent,
    planContent?: string,
  ): UserMessageContent {
    if (!planContent) return message;
    const planSuffix = `\n\n<approved-plan>\n${planContent}\n</approved-plan>\n\nIMPORTANT: Execute according to the approved plan above. Follow the steps exactly as specified.`;
    if (typeof message === 'string') return message + planSuffix;
    return [...message, { type: 'text', text: planSuffix }];
  }

  private async initializeSystemPrompt(): Promise<void> {
    try {
      const result = await buildSystemPrompt({
        projectPath: process.cwd(),
        replaceDefault: this.runtimeOptions.systemPrompt,
        append: this.runtimeOptions.appendSystemPrompt,
        includeEnvironment: false,
        language: this.config.language,
      });
      if (result.prompt) {
        this.log('系统提示配置验证成功');
        logger.debug(
          `[SystemPrompt] 可用来源: ${result.sources.filter((s) => s.loaded).map((s) => s.name).join(', ')}`
        );
      }
    } catch (error) {
      this.error('系统提示配置验证失败', error);
    }
  }

  private async registerBuiltinTools(): Promise<void> {
    try {
      const builtinTools = await getBuiltinTools({
        sessionId: 'default',
        configDir: path.join(os.homedir(), '.blade'),
        mcpRegistry: this.mcpRegistry,
      });
      logger.debug(`📦 Registering ${builtinTools.length} builtin tools...`);
      this.executionPipeline.getRegistry().registerAll(builtinTools);
      const registeredCount = this.executionPipeline.getRegistry().getAll().length;
      logger.debug(`✅ Builtin tools registered: ${registeredCount} tools`);
      logger.debug(
        `[Tools] ${this.executionPipeline.getRegistry().getAll().map((t) => t.name).join(', ')}`
      );
      await this.registerMcpTools();
    } catch (error) {
      logger.error('Failed to register builtin tools:', error);
      throw error;
    }
  }

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
      const registry = this.mcpRegistry;
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
      const mcpTools = await registry.getAvailableToolsByServerNames(Array.from(targetServerNames));
      if (mcpTools.length > 0) {
        this.executionPipeline.getRegistry().registerAll(mcpTools);
        logger.debug(`✅ Registered ${mcpTools.length} MCP tools`);
      } else {
        logger.debug('📦 No MCP tools available');
      }
    } catch (error) {
      logger.warn('Failed to register MCP tools:', error);
    }
  }

  private async loadSubagents(): Promise<void> {
    if (subagentRegistry.getAllNames().length > 0) {
      logger.debug(`📦 Subagents already loaded: ${subagentRegistry.getAllNames().join(', ')}`);
      return;
    }
    try {
      const loadedCount = subagentRegistry.loadFromStandardLocations();
      if (loadedCount > 0) {
        logger.debug(`✅ Loaded ${loadedCount} subagents: ${subagentRegistry.getAllNames().join(', ')}`);
      } else {
        logger.debug('📦 No subagents configured');
      }
    } catch (error) {
      logger.warn('Failed to load subagents:', error);
    }
  }

  private async discoverSkills(): Promise<void> {
    try {
      const result = await discoverSkills({ cwd: process.cwd() });
      if (result.skills.length > 0) {
        logger.debug(`✅ Discovered ${result.skills.length} skills: ${result.skills.map((s) => s.name).join(', ')}`);
      } else {
        logger.debug('📦 No skills configured');
      }
      for (const error of result.errors) {
        logger.warn(`⚠️  Skill loading error at ${error.path}: ${error.error}`);
      }
    } catch (error) {
      logger.warn('Failed to discover skills:', error);
    }
  }

  private generateTaskId(): string {
    return `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  private log(message: string, data?: unknown): void {
    logger.debug(`[MainAgent] ${message}`, data || '');
  }

  private error(message: string, error?: unknown): void {
    logger.error(`[MainAgent] ${message}`, error || '');
  }
}
