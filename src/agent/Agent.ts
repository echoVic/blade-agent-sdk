import type { ContextManager } from '../context/ContextManager.js';
import { AbortError } from '../errors/AbortError.js';
import { ConfigError } from '../errors/ConfigError.js';
import type { HookRuntime } from '../hooks/HookRuntime.js';
import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../logging/Logger.js';
import type { McpServerConfig } from '../mcp/config.js';
import { McpRegistry } from '../mcp/McpRegistry.js';
import type { ModelMiddleware } from '../middleware/ModelMiddleware.js';
import type { ToolMiddleware } from '../middleware/ToolMiddleware.js';
import { buildSystemPrompt, createPlanModeReminder } from '../prompts/index.js';
import { getContextCwd, type RuntimeContext } from '../runtime/index.js';
import type { ProviderRegistry } from '../services/ProviderRegistry.js';
import { getSkillRegistry } from '../skills/index.js';
import type { SkillRegistry } from '../skills/SkillRegistry.js';
import { getBuiltinTools } from '../tools/builtin/index.js';
import { ExecutionPipeline } from '../tools/execution/ExecutionPipeline.js';
import { ToolExposurePlanner } from '../tools/exposure/ToolExposurePlanner.js';
import { BUILTIN_TOOL_SOURCE, ToolRegistry } from '../tools/registry/ToolRegistry.js';
import type { ToolServices } from '../tools/services.js';
import { PermissionMode } from '../types/constants.js';
import type { PermissionsConfig } from '../types/permissions.js';
import type { AgentEvent } from './AgentEvent.js';
import { AttachmentHandler } from './AttachmentHandler.js';
import { CompactionHandler } from './CompactionHandler.js';
import type { BladeConfig } from './config.js';
import { RECONCILED_INITIAL_INPUT } from './InitialInputPreparation.js';
import { LoopRunner } from './LoopRunner.js';
import { ModelManager } from './ModelManager.js';
import { AgentSessionStore } from './subagents/AgentSessionStore.js';
import { BackgroundAgentManager } from './subagents/BackgroundAgentManager.js';
import { SubagentRegistry } from './subagents/SubagentRegistry.js';
import { TokenBudget, type TokenBudgetConfig } from './TokenBudget.js';
import type {
  AgentExecutionContext,
  AgentRuntimeOptions,
  IBackgroundAgentManager,
  LoopOptions,
  LoopResult,
  UserMessageContent,
} from './types.js';
import { isPlanApprovalResult } from './types.js';

export interface AgentRuntimeDeps {
  executionPipeline?: ExecutionPipeline;
  contextManager?: ContextManager;
  defaultContext?: RuntimeContext;
  mcpRegistry?: McpRegistry;
  subagentRegistry?: SubagentRegistry;
  backgroundAgentManager?: IBackgroundAgentManager;
  hookRuntime?: HookRuntime;
  providerRegistry?: ProviderRegistry;
  modelMiddleware?: readonly ModelMiddleware[];
  toolMiddleware?: readonly ToolMiddleware[];
  skillRegistry?: SkillRegistry;
  runtimeManaged?: boolean;
  logger?: InternalLogger;
}

interface PreparedContext {
  enhancedMessage: UserMessageContent;
  context: AgentExecutionContext;
  loopOptions: LoopOptions;
}

export class Agent {
  private config: BladeConfig;
  private runtimeOptions: AgentRuntimeOptions;
  private isInitialized = false;
  private executionPipeline: ExecutionPipeline;
  private readonly defaultContext: RuntimeContext;
  private readonly runtimeManaged: boolean;
  private readonly runtimeMcpRegistry?: McpRegistry;
  private readonly ownsRuntimeMcpRegistry: boolean;
  private readonly subagentRegistry: SubagentRegistry;
  private readonly backgroundAgentManager: IBackgroundAgentManager;
  private readonly ownedBackgroundAgentManager?: BackgroundAgentManager;
  private readonly hookRuntime?: HookRuntime;
  private readonly localDiscovery: boolean;
  private readonly skillsEnabled: boolean;
  private readonly skillRegistry: SkillRegistry;
  private readonly logger: InternalLogger;
  private readonly rootLogger: InternalLogger;
  private readonly lifecycleController = new AbortController();
  private readonly activeStreams = new Set<AsyncGenerator<AgentEvent, LoopResult>>();
  private lastPreparedSkillCwd?: string | null;
  private tokenBudget?: TokenBudget;
  private isDestroyed = false;
  private destroyPromise?: Promise<void>;

  private modelManager: ModelManager;
  private loopRunner?: LoopRunner;

  constructor(
    config: BladeConfig,
    runtimeOptions: AgentRuntimeOptions = {},
    deps: AgentRuntimeDeps = {},
  ) {
    this.config = config;
    this.runtimeOptions = runtimeOptions;
    this.rootLogger = deps.logger ?? NOOP_LOGGER;
    this.logger = this.rootLogger.child(LogCategory.AGENT);
    this.defaultContext = deps.defaultContext ?? {};
    this.runtimeManaged = deps.runtimeManaged ?? false;
    this.localDiscovery = runtimeOptions.localDiscovery ?? true;
    this.skillsEnabled = this.localDiscovery || deps.skillRegistry !== undefined;
    const defaultSkillCwd = getContextCwd(this.defaultContext);
    this.skillRegistry =
      deps.skillRegistry ??
      getSkillRegistry(defaultSkillCwd ? { cwd: defaultSkillCwd } : undefined);
    this.ownsRuntimeMcpRegistry = deps.mcpRegistry === undefined && !this.runtimeManaged;
    this.runtimeMcpRegistry =
      deps.mcpRegistry ?? (!this.runtimeManaged ? new McpRegistry(config.storageRoot) : undefined);
    this.subagentRegistry =
      deps.subagentRegistry ??
      new SubagentRegistry(this.rootLogger, getContextCwd(this.defaultContext));
    if (deps.backgroundAgentManager) {
      this.backgroundAgentManager = deps.backgroundAgentManager;
    } else {
      this.ownedBackgroundAgentManager = BackgroundAgentManager.create(
        this.rootLogger,
        AgentSessionStore.create(),
        undefined,
        {
          model: deps.modelMiddleware,
          tool: deps.toolMiddleware,
        },
        deps.providerRegistry,
      );
      this.backgroundAgentManager = this.ownedBackgroundAgentManager;
    }
    this.hookRuntime = deps.hookRuntime;
    this.executionPipeline =
      deps.executionPipeline || this.createDefaultPipeline(deps.toolMiddleware);
    this.modelManager = new ModelManager(
      config,
      runtimeOptions.outputFormat,
      deps.contextManager,
      getContextCwd(this.defaultContext),
      this.rootLogger,
      deps.modelMiddleware,
      deps.providerRegistry,
    );
    this.tokenBudget = this.createTokenBudget(runtimeOptions.tokenBudget);
  }

  static async create(
    config: BladeConfig,
    options: AgentRuntimeOptions = {},
    deps: AgentRuntimeDeps = {},
  ): Promise<Agent> {
    const models = config.models || [];
    if (models.length === 0) {
      throw new ConfigError(
        'No model configuration found. Provide at least one entry in config.models.',
      );
    }

    const agent = new Agent(config, options, deps);
    try {
      await agent.initialize();

      if (options.toolWhitelist && options.toolWhitelist.length > 0) {
        agent.applyToolWhitelist(options.toolWhitelist);
      }

      return agent;
    } catch (error) {
      try {
        await agent.destroy();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Agent initialization failed and cleanup was incomplete',
        );
      }
      throw error;
    }
  }

  public async initialize(): Promise<void> {
    if (this.isDestroyed) {
      throw new Error('Agent has been destroyed and cannot be initialized again.');
    }
    if (this.isInitialized) return;

    try {
      if (!this.runtimeManaged) {
        await this.registerBuiltinTools();
      }

      if (this.localDiscovery) {
        await this.loadSubagents();
      }
      if (this.skillsEnabled) {
        await this.discoverSkills();
      }

      const modelConfig = this.modelManager.resolveModelConfig(this.runtimeOptions.modelId);
      await this.modelManager.applyModelConfig(modelConfig, '🚀 使用模型:');
      const compactionHandler = new CompactionHandler(
        () => this.modelManager.getModelService(),
        () => this.modelManager.getContextManager(),
        this.rootLogger,
        () => this.modelManager.getProviderRegistry(),
      );

      this.loopRunner = new LoopRunner(
        this.config,
        this.runtimeOptions,
        this.modelManager,
        this.executionPipeline,
        getContextCwd(this.defaultContext),
        this.rootLogger,
        true,
        compactionHandler,
        this.tokenBudget,
        this.hookRuntime,
        this.skillRegistry,
      );

      this.isInitialized = true;
    } catch (error) {
      this.logger.error('Agent初始化失败', error);
      throw error;
    }
  }

  public streamChat(
    message: UserMessageContent,
    context: AgentExecutionContext,
    options?: LoopOptions,
  ): AsyncGenerator<AgentEvent, LoopResult> {
    this.assertInitialized();
    const self = this;
    let stream: AsyncGenerator<AgentEvent, LoopResult> | undefined;

    const wrapper = async function* (): AsyncGenerator<AgentEvent, LoopResult> {
      try {
        const prepared = await self.prepareContext(message, context, options);
        return yield* self.streamWithPlanSupport(prepared);
      } finally {
        if (stream) {
          self.activeStreams.delete(stream);
        }
      }
    };
    const createdStream = wrapper();
    stream = createdStream;
    this.activeStreams.add(createdStream);
    return createdStream;
  }

  private applyToolWhitelist(whitelist: string[]): void {
    this.assertInitialized();
    const registry = this.executionPipeline.getRegistry();
    const allTools = registry.getAll();
    const toolsToRemove = allTools.filter((tool) => !whitelist.includes(tool.name));
    for (const tool of toolsToRemove) registry.unregister(tool.name);
  }

  public async setModel(model: string): Promise<void> {
    this.assertInitialized();
    await this.modelManager.setModel(model);
  }

  public destroy(): Promise<void> {
    if (this.destroyPromise) {
      return this.destroyPromise;
    }

    const destroyPromise = this.destroyInternal();
    this.destroyPromise = destroyPromise;
    void destroyPromise.catch(() => {
      if (this.destroyPromise === destroyPromise) {
        this.destroyPromise = undefined;
      }
    });
    return destroyPromise;
  }

  private assertInitialized(): void {
    if (this.isDestroyed) {
      throw new Error('Agent has been destroyed.');
    }
    if (!this.isInitialized) {
      throw new Error('Agent is not initialized. Call initialize() before using this method.');
    }
  }

  private getLoopRunner(): LoopRunner {
    this.assertInitialized();
    const loopRunner = this.loopRunner;
    if (!loopRunner) {
      throw new Error('Agent is not initialized. Call initialize() before using this method.');
    }
    return loopRunner;
  }

  private withLifecycleSignal(signal?: AbortSignal): AbortSignal {
    return signal
      ? AbortSignal.any([signal, this.lifecycleController.signal])
      : this.lifecycleController.signal;
  }

  private async destroyInternal(): Promise<void> {
    this.isDestroyed = true;
    this.isInitialized = false;
    this.lifecycleController.abort(new AbortError('Agent was destroyed'));

    const streams = [...this.activeStreams];
    const foregroundResults = await Promise.allSettled([
      ...streams.map(async (stream) => {
        try {
          await stream.return(undefined as never);
        } finally {
          this.activeStreams.delete(stream);
        }
      }),
    ]);
    const cleanupOperations: Promise<unknown>[] = [];
    if (this.ownedBackgroundAgentManager) {
      cleanupOperations.push(this.ownedBackgroundAgentManager.sealCancelAndWait());
    }
    if (this.ownsRuntimeMcpRegistry && this.runtimeMcpRegistry) {
      cleanupOperations.push(this.runtimeMcpRegistry.disconnectAll());
    }
    const cleanupResults = await Promise.allSettled(cleanupOperations);

    this.loopRunner = undefined;
    this.lastPreparedSkillCwd = undefined;

    const errors = [...foregroundResults, ...cleanupResults].flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Agent destruction failed');
    }
  }

  private createDefaultPipeline(middleware: readonly ToolMiddleware[] = []): ExecutionPipeline {
    const services: ToolServices = {
      subagentRegistry: this.subagentRegistry,
      skillRegistry: this.skillRegistry,
      backgroundAgentManager: this.backgroundAgentManager,
      ...(this.runtimeMcpRegistry ? { mcpRegistry: this.runtimeMcpRegistry } : {}),
    };
    const registry = new ToolRegistry(services);
    services.discoverableCatalog = new ToolExposurePlanner(registry);
    const permissions: PermissionsConfig = {
      ...this.config.permissions,
      ...this.runtimeOptions.permissions,
    };
    const permissionMode = this.runtimeOptions.permissionMode ?? PermissionMode.DEFAULT;
    return new ExecutionPipeline(registry, {
      permissionConfig: permissions,
      permissionMode,
      maxHistorySize: 1000,
      permissionHandler: this.runtimeOptions.permissionHandler,
      toolTimeoutMs: this.config.toolTimeoutMs,
      middleware,
    });
  }

  private withBackgroundAgentManager(context: AgentExecutionContext): AgentExecutionContext {
    if (context.backgroundAgentManager) {
      return context;
    }

    return {
      ...context,
      backgroundAgentManager: this.backgroundAgentManager,
    };
  }

  private createTokenBudget(config?: TokenBudgetConfig): TokenBudget | undefined {
    if (config === undefined) {
      return undefined;
    }

    return new TokenBudget(config);
  }

  private async prepareContext(
    message: UserMessageContent,
    context: AgentExecutionContext,
    options?: LoopOptions,
  ): Promise<PreparedContext> {
    this.assertInitialized();

    const ctx = this.withBackgroundAgentManager(context);
    let enhancedMessage: UserMessageContent;
    if (options?.initialInputPreparation === RECONCILED_INITIAL_INPUT) {
      if (this.skillsEnabled) {
        await this.discoverSkillsForCwd(this.getContextWorkingDirectory(ctx));
      }
      enhancedMessage = message;
    } else if (this.skillsEnabled) {
      enhancedMessage = await this.prepareMessageForContext(message, ctx);
    } else {
      enhancedMessage = message;
    }
    const loopOptions: LoopOptions = {
      ...options,
      signal: this.withLifecycleSignal(options?.signal ?? ctx.signal),
      prepareInput: (input) =>
        this.skillsEnabled ? this.prepareMessageForContext(input, ctx) : Promise.resolve(input),
    };

    return { enhancedMessage, context: ctx, loopOptions };
  }

  private async *streamWithPlanSupport(
    prepared: PreparedContext,
  ): AsyncGenerator<AgentEvent, LoopResult> {
    const { enhancedMessage, context, loopOptions } = prepared;
    const loopRunner = this.getLoopRunner();

    if (context.permissionMode === 'plan') {
      const plan = await this.preparePlan(enhancedMessage, context);
      const planResult = yield* loopRunner.executeWithAgentLoop(
        plan.message,
        context,
        loopOptions,
        plan.systemPrompt,
      );

      if (isPlanApprovalResult(planResult)) {
        const targetMode = planResult.metadata.targetMode;
        const planContent = planResult.metadata.planContent;
        const newContext: AgentExecutionContext = { ...context, permissionMode: targetMode };
        const messageWithPlan = this.injectPlanContent(enhancedMessage, planContent);
        return yield* loopRunner.runLoopStream(messageWithPlan, newContext, loopOptions);
      }

      return planResult;
    }

    return yield* loopRunner.runLoopStream(enhancedMessage, context, loopOptions);
  }

  private async preparePlan(
    message: UserMessageContent,
    context: AgentExecutionContext,
  ): Promise<{ message: UserMessageContent; systemPrompt: string }> {
    const { prompt } = await buildSystemPrompt({
      projectPath: context.snapshot?.cwd,
      mode: PermissionMode.PLAN,
      includeEnvironment: context.omitEnvironment !== true,
      includeSkills: this.skillsEnabled,
      skillRegistry: this.skillRegistry,
      language: this.config.language,
    });
    if (typeof message === 'string') {
      return { message: createPlanModeReminder(message), systemPrompt: prompt };
    }
    const index = message.findIndex((part) => part.type === 'text');
    const reminder = createPlanModeReminder(
      index >= 0 && message[index]?.type === 'text' ? message[index].text : '',
    );
    const prepared =
      index >= 0
        ? message.map((part, partIndex) =>
            partIndex === index ? { type: 'text' as const, text: reminder } : part,
          )
        : [{ type: 'text' as const, text: reminder }, ...message];
    return { message: prepared, systemPrompt: prompt };
  }

  private injectPlanContent(message: UserMessageContent, planContent?: string): UserMessageContent {
    if (!planContent) return message;
    const planSuffix = `\n\n<approved-plan>\n${planContent}\n</approved-plan>\n\nIMPORTANT: Execute according to the approved plan above. Follow the steps exactly as specified.`;
    if (typeof message === 'string') return message + planSuffix;
    return [...message, { type: 'text', text: planSuffix }];
  }

  private async registerBuiltinTools(): Promise<void> {
    const builtinTools = await getBuiltinTools({
      mcpRegistry: this.runtimeMcpRegistry,
      includeMcpProtocolTools: false,
    });
    if (builtinTools.length === 0) return;
    this.executionPipeline.getRegistry().registerAll(builtinTools, BUILTIN_TOOL_SOURCE);

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

    const mcpTools = await this.runtimeMcpRegistry.getAvailableToolEntriesByServerNames(
      Array.from(targetServerNames),
    );
    for (const { tool, serverName } of mcpTools) {
      this.executionPipeline.getRegistry().registerMcpTool(tool, {
        kind: 'mcp',
        trustLevel: 'remote',
        sourceId: serverName,
        serverName,
      });
    }
  }

  private async loadSubagents(): Promise<void> {
    this.subagentRegistry.setLogger(this.rootLogger);
    this.subagentRegistry.setProjectDir(getContextCwd(this.defaultContext));
    if (this.subagentRegistry.getAllNames().length > 0) return;
    try {
      this.subagentRegistry.loadFromStandardLocations(
        getContextCwd(this.defaultContext),
        this.config.storageRoot,
      );
    } catch (error) {
      this.logger.warn('Failed to load subagents:', error);
    }
  }

  private async discoverSkills(): Promise<void> {
    await this.discoverSkillsForCwd(getContextCwd(this.defaultContext));
  }

  private async discoverSkillsForCwd(cwd?: string): Promise<void> {
    const registryCwd = cwd ?? null;
    if (this.lastPreparedSkillCwd === registryCwd) {
      return;
    }
    try {
      const result = await this.skillRegistry.initialize(cwd ? { cwd } : undefined);
      this.lastPreparedSkillCwd = registryCwd;
      for (const error of result.errors) {
        this.logger.warn(`⚠️  Skill loading error at ${error.path}: ${error.error}`);
      }
    } catch (error) {
      this.logger.warn('Failed to discover skills:', error);
    }
  }

  private getContextWorkingDirectory(context: AgentExecutionContext): string | undefined {
    return context.snapshot?.cwd || getContextCwd(this.defaultContext);
  }

  private createAttachmentHandler(context: AgentExecutionContext): AttachmentHandler | null {
    const cwd = this.getContextWorkingDirectory(context);
    if (!cwd) {
      return null;
    }
    return new AttachmentHandler(cwd, this.rootLogger);
  }

  private async prepareMessageForContext(
    message: UserMessageContent,
    context: AgentExecutionContext,
  ): Promise<UserMessageContent> {
    await this.discoverSkillsForCwd(this.getContextWorkingDirectory(context));
    if (!this.localDiscovery) {
      return message;
    }
    const attachmentHandler = this.createAttachmentHandler(context);
    return attachmentHandler ? attachmentHandler.processAtMentionsForContent(message) : message;
  }
}
