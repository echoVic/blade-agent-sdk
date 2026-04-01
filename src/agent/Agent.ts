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

import type { ContextManager } from '../context/ContextManager.js';
import {
  type InternalLogger,
  LogCategory,
  NOOP_LOGGER,
} from '../logging/Logger.js';
import { McpRegistry } from '../mcp/McpRegistry.js';
import { buildSystemPrompt } from '../prompts/index.js';
import {
  getContextCwd,
  type RuntimeContext,
} from '../runtime/index.js';
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
import {
  TokenBudget,
  type TokenBudgetConfig,
  type TokenBudgetSnapshot,
} from './TokenBudget.js';
import type {
  AgentEvent,
  AgentOptions,
  ChatContext,
  LoopOptions,
  LoopResult,
  UserMessageContent,
} from './types.js';

export interface AgentRuntimeDeps {
  executionPipeline?: ExecutionPipeline;
  contextManager?: ContextManager;
  defaultContext?: RuntimeContext;
  mcpRegistry?: McpRegistry;
  runtimeManaged?: boolean;
  logger?: InternalLogger;
}

export class Agent {
  private config: BladeConfig;
  private runtimeOptions: AgentOptions;
  private isInitialized = false;
  private executionPipeline: ExecutionPipeline;
  private readonly defaultContext: RuntimeContext;
  private readonly runtimeManaged: boolean;
  private readonly runtimeMcpRegistry?: McpRegistry;
  private readonly logger: InternalLogger;
  private readonly rootLogger: InternalLogger;
  private lastPreparedSkillCwd?: string;
  private tokenBudget?: TokenBudget;

  // 子模块
  private modelManager: ModelManager;
  private planExecutor: PlanExecutor;
  private loopRunner!: LoopRunner;

  constructor(
    config: BladeConfig,
    runtimeOptions: AgentOptions = {},
    deps: AgentRuntimeDeps = {},
  ) {
    this.config = config;
    this.runtimeOptions = runtimeOptions;
    this.rootLogger = deps.logger ?? NOOP_LOGGER;
    this.logger = this.rootLogger.child(LogCategory.AGENT);
    this.executionPipeline = deps.executionPipeline || this.createDefaultPipeline();
    this.defaultContext = deps.defaultContext ?? {};
    this.runtimeManaged = deps.runtimeManaged ?? false;
    this.runtimeMcpRegistry =
      deps.mcpRegistry || (!this.runtimeManaged ? new McpRegistry(config.storageRoot) : undefined);
    this.modelManager = new ModelManager(
      config,
      runtimeOptions.outputFormat,
      deps.contextManager,
      getContextCwd(this.defaultContext),
      this.rootLogger,
    );
    this.planExecutor = new PlanExecutor(config.language, this.rootLogger);
    this.tokenBudget = this.createTokenBudget(runtimeOptions.tokenBudget);
  }

  // ===== 静态工厂 =====

  static async create(
    config: BladeConfig,
    options: AgentOptions = {},
    deps: AgentRuntimeDeps = {},
  ): Promise<Agent> {
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

    const agent = new Agent(config, options, deps);
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

      await this.initializeSystemPrompt();

      if (!this.runtimeManaged) {
        await this.registerBuiltinTools();
      }

      await this.loadSubagents();
      await this.discoverSkills();

      const modelConfig = this.modelManager.resolveModelConfig(this.runtimeOptions.modelId);
      await this.modelManager.applyModelConfig(modelConfig, '🚀 使用模型:');
      const streamHandler = new StreamResponseHandler(
        () => this.modelManager.getChatService(),
        this.rootLogger,
      );
      const compactionHandler = new CompactionHandler(
        () => this.modelManager.getChatService(),
        () => this.modelManager.getContextManager(),
        this.rootLogger,
      );

      this.loopRunner = new LoopRunner(
        this.config,
        this.runtimeOptions,
        this.modelManager,
        this.executionPipeline,
        getContextCwd(this.defaultContext),
        this.rootLogger,
        streamHandler,
        compactionHandler,
        this.tokenBudget,
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
    context: ChatContext,
    options?: LoopOptions,
  ): Promise<string> {
    if (!this.isInitialized) throw new Error('Agent未初始化');

    const enhancedMessage = await this.prepareMessageForContext(message, context);

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

  public streamChat(
    message: UserMessageContent,
    context: ChatContext,
    options?: LoopOptions,
  ): AsyncGenerator<AgentEvent, LoopResult> {
    if (!this.isInitialized) throw new Error('Agent未初始化');

    const run = async () => {
      const enhancedMessage = await this.prepareMessageForContext(message, context);

      const loopOptions: LoopOptions = { signal: context.signal, ...options };

      if (context.permissionMode === 'plan') {
        const planStream = this.planExecutor.runPlanLoopStream(
          enhancedMessage, context, loopOptions,
          (msg, ctx, opts, sp) => this.loopRunner.executeWithAgentLoop(msg, ctx, opts, sp),
        );
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
          const newContext: ChatContext = { ...context, permissionMode: targetMode };
          const messageWithPlan = this.injectPlanContent(enhancedMessage, planContent);
          return {
            events,
            continuation: this.loopRunner.runLoopStream(messageWithPlan, newContext, loopOptions),
          };
        }
        return { events, result: planResult };
      }

      return { continuation: this.loopRunner.runLoopStream(enhancedMessage, context, loopOptions) };
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
      snapshot: context.snapshot,
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

  // ===== Getters =====

  public getChatService(): IChatService { return this.modelManager.getChatService(); }
  public getContextManager(): ContextManager | undefined {
    return this.modelManager.getContextManager();
  }
  public getAvailableTools(): Tool[] {
    return this.executionPipeline ? this.executionPipeline.getRegistry().getAll() : [];
  }
  public getToolRegistry(): ToolRegistry {
    return this.executionPipeline.getRegistry();
  }

  public getTokenBudgetSnapshot(): TokenBudgetSnapshot | undefined {
    return this.tokenBudget?.getSnapshot();
  }

  public getStats(): Record<string, unknown> {
    return {
      initialized: this.isInitialized,
      components: {
        chatService: this.modelManager.getChatService() ? 'ready' : 'not_loaded',
        contextManager: this.modelManager.getContextManager() ? 'ready' : 'not_loaded',
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
    this.logger.debug(`🔒 Applied tool whitelist: ${whitelist.join(', ')} (removed ${toolsToRemove.length} tools)`);
  }

  public clearSkillContext(): void {
    this.loopRunner.clearSkillContext();
  }

  public async setModel(model: string): Promise<void> {
    await this.modelManager.setModel(model);
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

  private createTokenBudget(config?: TokenBudgetConfig): TokenBudget | undefined {
    if (config === undefined) {
      return undefined;
    }

    return new TokenBudget(config);
  }

  private async executePlanApproval(
    enhancedMessage: UserMessageContent,
    context: ChatContext,
    loopOptions: LoopOptions,
    result: LoopResult,
  ): Promise<string> {
    const targetMode = result.metadata!.targetMode as PermissionMode;
    const planContent = result.metadata!.planContent as string | undefined;
    this.logger.debug(`🔄 Plan 模式已批准，切换到 ${targetMode} 模式并重新执行`);

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
      const projectPath = getContextCwd(this.defaultContext);
      const result = await buildSystemPrompt({
        projectPath,
        basePrompt: this.runtimeOptions.systemPrompt,
        append: this.runtimeOptions.appendSystemPrompt,
        includeEnvironment: false,
        language: this.config.language,
      });
      if (result.prompt) {
        this.log('系统提示配置验证成功');
        this.logger.debug(
          `[SystemPrompt] 可用来源: ${result.sources.filter((s) => s.loaded).map((s) => s.name).join(', ')}`
        );
      }
    } catch (error) {
      this.error('系统提示配置验证失败', error);
    }
  }

  private async registerBuiltinTools(): Promise<void> {
    const builtinTools = await getBuiltinTools({
      sessionId: 'default',
      configDir: this.config.storageRoot,
      mcpRegistry: this.runtimeMcpRegistry,
      includeMcpProtocolTools: false,
    });
    if (builtinTools.length === 0) {
      this.logger.debug('📦 No builtin tools available');
      return;
    }
    this.executionPipeline.getRegistry().registerAll(builtinTools);

    if (this.runtimeManaged || !this.runtimeMcpRegistry) {
      return;
    }

    const mcpServers: Record<string, McpServerConfig> = this.config.mcpServers || {};
    const targetServerNames = new Set<string>(Object.keys(mcpServers));
    for (const name of this.config.inProcessMcpServerNames || []) {
      targetServerNames.add(name);
    }
    if (targetServerNames.size === 0) {
      return;
    }

    for (const [name, config] of Object.entries(mcpServers)) {
      if (config.disabled) {
        continue;
      }
      try {
        await this.runtimeMcpRegistry.registerServer(name, config);
      } catch (error) {
        this.logger.warn(`⚠️  MCP server "${name}" connection failed:`, error);
      }
    }

    const mcpTools = await this.runtimeMcpRegistry.getAvailableToolsByServerNames(
      Array.from(targetServerNames),
    );
    for (const tool of mcpTools) {
      this.executionPipeline.getRegistry().registerMcpTool(tool);
    }
  }

  private async loadSubagents(): Promise<void> {
    subagentRegistry.setLogger(this.rootLogger);
    subagentRegistry.setProjectDir(getContextCwd(this.defaultContext));
    if (subagentRegistry.getAllNames().length > 0) {
      this.logger.debug(`📦 Subagents already loaded: ${subagentRegistry.getAllNames().join(', ')}`);
      return;
    }
    try {
      const loadedCount = subagentRegistry.loadFromStandardLocations();
      if (loadedCount > 0) {
        this.logger.debug(`✅ Loaded ${loadedCount} subagents: ${subagentRegistry.getAllNames().join(', ')}`);
      } else {
        this.logger.debug('📦 No subagents configured');
      }
    } catch (error) {
      this.logger.warn('Failed to load subagents:', error);
    }
  }

  private async discoverSkills(): Promise<void> {
    await this.discoverSkillsForCwd(
      getContextCwd(this.defaultContext),
    );
  }

  private async discoverSkillsForCwd(cwd?: string): Promise<void> {
    if (!cwd || this.lastPreparedSkillCwd === cwd) {
      return;
    }
    try {
      const result = await discoverSkills({ cwd });
      this.lastPreparedSkillCwd = cwd;
      if (result.skills.length > 0) {
        this.logger.debug(`✅ Discovered ${result.skills.length} skills: ${result.skills.map((s) => s.name).join(', ')}`);
      } else {
        this.logger.debug('📦 No skills configured');
      }
      for (const error of result.errors) {
        this.logger.warn(`⚠️  Skill loading error at ${error.path}: ${error.error}`);
      }
    } catch (error) {
      this.logger.warn('Failed to discover skills:', error);
    }
  }

  private getContextWorkingDirectory(context: ChatContext): string | undefined {
    return context.snapshot?.cwd || getContextCwd(this.defaultContext);
  }

  private createAttachmentHandler(context: ChatContext): AttachmentHandler | null {
    const cwd = this.getContextWorkingDirectory(context);
    if (!cwd) {
      return null;
    }
    return new AttachmentHandler(cwd, this.rootLogger);
  }

  private async prepareMessageForContext(
    message: UserMessageContent,
    context: ChatContext,
  ): Promise<UserMessageContent> {
    await this.discoverSkillsForCwd(this.getContextWorkingDirectory(context));
    const attachmentHandler = this.createAttachmentHandler(context);
    return attachmentHandler
      ? attachmentHandler.processAtMentionsForContent(message)
      : message;
  }

  private log(message: string, data?: unknown): void {
    this.logger.debug(`[MainAgent] ${message}`, data || '');
  }

  private error(message: string, error?: unknown): void {
    this.logger.error(`[MainAgent] ${message}`, error || '');
  }
}
