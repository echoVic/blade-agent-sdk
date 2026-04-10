/**
 * LoopRunner — 核心循环编排 + hooks 构建
 *
 * 从 Agent.ts 拆分，职责：
 * - 构建 AgentLoopConfig（工具、消息、hooks）
 * - 执行 agentLoop 并转发事件
 * - 普通模式的 systemPrompt 构建
 *
 * 运行时补丁管理委托给 RuntimePatchManager
 * Hooks 构建委托给 LoopHookBuilder（buildLoopConfig）
 */

import type { HookRuntime } from '../hooks/HookRuntime.js';
import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../logging/Logger.js';
import { buildSystemPrompt } from '../prompts/index.js';
import type { Message } from '../services/ChatServiceInterface.js';
import type { SkillActivationContext } from '../skills/index.js';
import { injectSkillsMetadata } from '../skills/index.js';
import {
  ToolExposurePlanner,
} from '../tools/exposure/index.js';
import { ToolCatalog } from '../tools/catalog/index.js';
import type { ExecutionPipeline } from '../tools/execution/ExecutionPipeline.js';
import {
  type BladeConfig,
  PermissionMode,
} from '../types/common.js';
import { getEnvironmentContext } from '../utils/environment.js';
import type { AgentEvent } from './AgentEvent.js';
import { agentLoop } from './AgentLoop.js';
import type { CompactionHandler } from './CompactionHandler.js';
import { AGENT_TURN_SAFETY_LIMIT } from './constants.js';
import type { ModelManager } from './ModelManager.js';
import { RuntimePatchManager } from './RuntimePatchManager.js';
import { LoopState } from './state/LoopState.js';
import { ConversationState } from './state/ConversationState.js';
import { isValidSystemSource } from './state/systemSource.js';
import type { LoopSkillState } from './state/TurnState.js';
import type { StreamResponseHandler } from './StreamResponseHandler.js';
import type { TokenBudget } from './TokenBudget.js';
import type {
  AgentOptions,
  ChatContext,
  LoopOptions,
  LoopResult,
  UserMessageContent,
} from './types.js';
import { buildLoopConfig } from './LoopHookBuilder.js';

// ===== Module-level helpers =====

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function syncContextMessages(context: ChatContext, convState: ConversationState): void {
  context.messages = convState.getContextMessages();
}

function hasPersistableUserContent(message: UserMessageContent): boolean {
  if (typeof message === 'string') {
    return message.trim() !== '';
  }

  return message.some((part) => part.type === 'image_url' || part.text.trim() !== '');
}

export class LoopRunner {
  readonly runtimePatchManager: RuntimePatchManager;
  private readonly logger: InternalLogger;

  constructor(
    private config: BladeConfig,
    private runtimeOptions: AgentOptions,
    private modelManager: ModelManager,
    private executionPipeline: ExecutionPipeline,
    private defaultProjectPath?: string,
    logger?: InternalLogger,
    private streamHandler?: StreamResponseHandler,
    private compactionHandler?: CompactionHandler,
    private tokenBudget?: TokenBudget,
    private hookRuntime?: HookRuntime,
  ) {
    this.logger = (logger ?? NOOP_LOGGER).child(LogCategory.AGENT);
    this.runtimePatchManager = new RuntimePatchManager(hookRuntime, this.logger);
  }

  // ===== 普通模式入口 =====

  async runLoop(
    message: UserMessageContent,
    context: ChatContext,
    options?: LoopOptions,
  ): Promise<LoopResult> {
    this.logger.debug('💬 Processing enhanced chat message...');
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

    if (!result) {
      throw new Error('LoopRunner.executeLoop ended without a result');
    }

    return result;
  }

  async *executeWithAgentLoop(
    message: UserMessageContent,
    context: ChatContext,
    options?: LoopOptions,
    systemPrompt?: string,
  ): AsyncGenerator<AgentEvent, LoopResult> {
    // 1. 构建消息历史 — 入口归一化 + ConversationState 构造
    const rootPromptMessage: Message | null = systemPrompt
      ? {
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
        }
      : null;

    // 删除 _systemSource 不在受控枚举内的 system 消息（旧根 prompt、外部任意标记等）
    const contextMessages = context.messages.filter((m) => {
      if (m.role !== 'system') return true;
      const source = isRecord(m.metadata) ? m.metadata._systemSource : undefined;
      return isValidSystemSource(source);
    });

    const conversationState = new ConversationState(
      rootPromptMessage,
      contextMessages,
      { role: 'user', content: message },
    );

    const permissionMode = context.permissionMode;
    const loopState = this.createLoopState(context, conversationState, permissionMode);

    // 2. 保存用户消息到 JSONL
    let lastMessageUuid: string | null = null;
    try {
      const contextMgr = this.modelManager.getContextManager();
      if (contextMgr && context.sessionId && hasPersistableUserContent(message)) {
        lastMessageUuid = await contextMgr.saveMessage(
          context.sessionId, 'user', message, null, undefined, context.subagentInfo
        );
      }
    } catch (error) {
      this.logger.warn('[LoopRunner] 保存用户消息失败:', error);
    }

    // 3. 计算 maxTurns
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

    // 4. 构建 AgentLoop hooks + config
    const loopConfig = buildLoopConfig({
      context,
      options,
      loopState,
      maxTurns,
      isYoloMode,
      getLastUuid: () => lastMessageUuid,
      setLastUuid: (uuid: string | null) => { lastMessageUuid = uuid; },
      streamHandler: this.streamHandler,
      executionPipeline: this.executionPipeline,
      logger: this.logger,
      tokenBudget: this.tokenBudget,
      compactionHandler: this.compactionHandler,
      hookRuntime: this.hookRuntime,
      modelManager: this.modelManager,
      runtimePatchManager: this.runtimePatchManager,
      defaultProjectPath: this.defaultProjectPath,
    });

    // 5. 运行 AgentLoop
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

      syncContextMessages(context, loopState.conversationState);
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
      this.logger.error('[LoopRunner] AgentLoop error:', error);
      return {
        success: false,
        error: {
          type: 'api_error',
          message: `处理消息时发生错误: ${error instanceof Error ? error.message : '未知错误'}`,
          details: error,
        },
        metadata: { turnsCount: 0, toolCallsCount: 0, duration: 0 },
      };
    } finally {
      this.runtimePatchManager.clearTurnScopedRuntimeState();
    }
  }

  // ===== SystemPrompt =====

  private async buildNormalSystemPrompt(context: ChatContext): Promise<string> {
    const basePrompt = context.systemPrompt
      ? this.runtimePatchManager.appendRuntimeSystemPrompt(context.systemPrompt)
      : await this.buildSystemPromptOnDemand(context);
    const envContext = getEnvironmentContext(context.snapshot?.cwd ?? this.defaultProjectPath);
    if (context.omitEnvironment) {
      return basePrompt;
    }
    return basePrompt
      ? `${envContext}\n\n---\n\n${basePrompt}`
      : envContext;
  }

  async buildSystemPromptOnDemand(context?: ChatContext): Promise<string> {
    const replacePrompt = this.runtimeOptions.systemPrompt;
    const appendPrompt = this.runtimePatchManager.getEffectiveSystemPromptAppend(
      this.runtimeOptions.appendSystemPrompt,
    );
    const projectPath = context?.snapshot?.cwd ?? this.defaultProjectPath;
    const skillActivationContext = this.runtimePatchManager.createSkillActivationContext(
      projectPath,
      context?.messages ?? [],
    );

    const result = await buildSystemPrompt({
      projectPath,
      basePrompt: replacePrompt,
      append: appendPrompt,
      includeEnvironment: false,
      language: this.config.language,
      skillActivationContext,
    });

    return result.prompt;
  }

  // ===== Skill 工具限制 (delegate to RuntimePatchManager) =====

  get skillContext(): LoopSkillState | undefined {
    return this.runtimePatchManager.skillContext;
  }

  setSkillContext(ctx: LoopSkillState | undefined): void {
    this.runtimePatchManager.setSkillContext(ctx);
  }

  clearSkillContext(): void {
    this.runtimePatchManager.clearSkillContext();
  }

  getRuntimePatchApplications() {
    return this.runtimePatchManager.getRuntimePatchApplications();
  }

  // ===== LoopState 创建 =====

  private createLoopState(
    context: ChatContext,
    conversationState: ConversationState,
    permissionMode: PermissionMode | undefined,
  ): LoopState {
    const rpm = this.runtimePatchManager;
    const catalog = this.executionPipeline.getCatalog();
    const exposureCatalog = catalog ?? this.executionPipeline.getRegistry();
    const registry = this.executionPipeline.getRegistry();
    const exposurePlanner = new ToolExposurePlanner(exposureCatalog);
    const effectiveSnapshot = rpm.buildRuntimeContextSnapshot(
      context.sessionId,
      context.snapshot,
    );
    const initialActivationCwd = effectiveSnapshot?.cwd ?? this.defaultProjectPath;
    const initialMessages = conversationState.toArray() as Message[];
    const initialSkillActivationContext = rpm.createSkillActivationContext(
      initialActivationCwd,
      initialMessages,
    );
    let cachedSkillActivationContext = initialSkillActivationContext;
    let cachedSkillActivationMessageCount = initialMessages.length;
    let cachedSkillActivationCwd = initialActivationCwd;
    let loopState: LoopState;

    const resolveSkillActivationContext = (): SkillActivationContext => {
      const cwd = loopState.executionContext.contextSnapshot?.cwd ?? this.defaultProjectPath;
      const currentMessageCount = loopState.conversationState.length;
      if (
        cachedSkillActivationContext
        && cachedSkillActivationMessageCount === currentMessageCount
        && cachedSkillActivationCwd === cwd
      ) {
        return cachedSkillActivationContext;
      }

      cachedSkillActivationContext = rpm.createSkillActivationContext(
        cwd,
        loopState.conversationState.toArray() as Message[],
      );
      cachedSkillActivationMessageCount = currentMessageCount;
      cachedSkillActivationCwd = cwd;
      return cachedSkillActivationContext;
    };

    loopState = new LoopState({
      conversationState,
      permissionMode,
      executionContext: {
        sessionId: context.sessionId,
        userId: context.userId || 'default',
        contextSnapshot: effectiveSnapshot,
        skillActivationPaths: initialSkillActivationContext.referencedPaths,
        confirmationHandler: context.confirmationHandler,
        bladeConfig: this.config,
        backgroundAgentManager: context.backgroundAgentManager,
        toolCatalog: catalog instanceof ToolCatalog
          ? catalog
          : undefined,
        toolRegistry: registry,
        discoveredTools: Array.from(rpm.discoveredTools ?? []),
      },
      baseContextSnapshot: context.snapshot,
      initialActiveSkill: rpm.skillContext,
      resolveTools: () => {
        const skillActivationContext = resolveSkillActivationContext();
        loopState.executionContext.skillActivationPaths = skillActivationContext.referencedPaths;
        loopState.executionContext.discoveredTools = Array.from(rpm.discoveredTools ?? []);
        const runtimeToolPolicy = rpm.runtimeToolPolicySnapshot
          ?? (rpm.skillContext
            ? {
                allow: rpm.skillContext.allowedTools,
                deny: rpm.skillContext.deniedTools,
                scope: rpm.skillContext.scope ?? 'session',
              }
            : undefined);
        const rawExposurePlan = exposurePlanner.plan({
          permissionMode,
          runtimeToolPolicy,
          discoveredTools: rpm.discoveredTools,
          sourcePolicy: this.runtimeOptions.toolSourcePolicy,
        });
        rpm.syncDiscoverableToolsCatalogMessage(loopState.conversationState, rawExposurePlan.discoverableTools);
        let rawTools = rawExposurePlan.declarations;
        rawTools = injectSkillsMetadata(
          rawTools,
          skillActivationContext,
        );
        return rawTools;
      },
      resolveChatService: () => this.modelManager.getChatService(),
      resolveMaxContextTokens: () => this.modelManager.getMaxContextTokens(),
    });
    return loopState;
  }
}
