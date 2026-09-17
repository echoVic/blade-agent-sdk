import type { HookRuntime } from '../hooks/HookRuntime.js';
import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../logging/Logger.js';
import type { ConversationMessage } from '../model/conversation.js';
import { buildSystemPrompt } from '../prompts/index.js';
import {
  isExecutionLeaseFailure,
  runWithExecutionLeaseBoundary,
} from '../session/events/DurableExecutionLeaseStore.js';
import type { SkillActivationContext } from '../skills/index.js';
import { injectSkillsMetadata } from '../skills/index.js';
import type { SkillRegistry } from '../skills/SkillRegistry.js';
import type { ExecutionPipeline } from '../tools/execution/ExecutionPipeline.js';
import { ToolExposurePlanner } from '../tools/exposure/index.js';
import { PermissionMode } from '../types/constants.js';
import type { MessageId } from '../types/identifiers.js';
import { getEnvironmentContext } from '../utils/environment.js';
import type { AgentEvent } from './AgentEvent.js';
import { agentLoop } from './AgentLoop.js';
import type { CompactionHandler } from './CompactionHandler.js';
import type { BladeConfig } from './config.js';
import { AGENT_TURN_SAFETY_LIMIT } from './constants.js';
import { buildLoopConfig } from './LoopHookBuilder.js';
import type { ModelManager } from './ModelManager.js';
import { RuntimePatchManager } from './RuntimePatchManager.js';
import { ConversationState } from './state/ConversationState.js';
import { LoopState } from './state/LoopState.js';
import { isValidSystemSource } from './state/systemSource.js';
import type { LoopSkillState } from './state/TurnState.js';
import type { TokenBudget } from './TokenBudget.js';
import type {
  AgentExecutionContext,
  AgentRuntimeOptions,
  LoopOptions,
  LoopResult,
  UserMessageContent,
} from './types.js';

function syncContextMessages(context: AgentExecutionContext, convState: ConversationState): void {
  context.messages = convState.getContextMessages();
}

function hasPersistableUserContent(message: UserMessageContent): boolean {
  if (typeof message === 'string') {
    return message.trim() !== '';
  }

  return message.some((part) => part.type !== 'text' || part.text.trim() !== '');
}

export class LoopRunner {
  readonly runtimePatchManager: RuntimePatchManager;
  private readonly logger: InternalLogger;

  constructor(
    private config: BladeConfig,
    private runtimeOptions: AgentRuntimeOptions,
    private modelManager: ModelManager,
    private executionPipeline: ExecutionPipeline,
    private defaultProjectPath?: string,
    logger?: InternalLogger,
    private streaming?: boolean,
    private compactionHandler?: CompactionHandler,
    private tokenBudget?: TokenBudget,
    private hookRuntime?: HookRuntime,
    private skillRegistry?: SkillRegistry,
  ) {
    this.logger = (logger ?? NOOP_LOGGER).child(LogCategory.AGENT);
    this.runtimePatchManager = new RuntimePatchManager(hookRuntime, this.logger);
  }

  async runLoop(
    message: UserMessageContent,
    context: AgentExecutionContext,
    options?: LoopOptions,
  ): Promise<LoopResult> {
    const stream = this.runLoopStream(message, context, options);
    while (true) {
      const next = await stream.next();
      if (next.done) return next.value;
    }
  }

  async *runLoopStream(
    message: UserMessageContent,
    context: AgentExecutionContext,
    options?: LoopOptions,
  ): AsyncGenerator<AgentEvent, LoopResult> {
    const systemPrompt = await this.buildNormalSystemPrompt(context);
    return yield* this.executeWithAgentLoop(message, context, options, systemPrompt);
  }

  async *executeWithAgentLoop(
    message: UserMessageContent,
    context: AgentExecutionContext,
    options?: LoopOptions,
    systemPrompt?: string,
  ): AsyncGenerator<AgentEvent, LoopResult> {
    const requestSignal = options?.signal ?? context.signal;
    if (requestSignal?.aborted && isExecutionLeaseFailure(requestSignal.reason)) {
      throw requestSignal.reason;
    }

    const conversationState = this.createConversation(message, context, systemPrompt);

    const permissionMode = context.permissionMode;
    const loopState = this.createLoopState(
      context,
      conversationState,
      permissionMode,
      options?.toolExecutionLifecycle,
    );

    let lastMessageUuid = await this.persistInitialMessage(message, context, options);

    const isYoloMode = context.permissionMode === PermissionMode.YOLO;
    const configuredMaxTurns =
      options?.maxTurns ?? this.runtimeOptions.maxTurns ?? this.config.maxTurns ?? -1;

    if (configuredMaxTurns === 0) {
      return {
        success: false,
        error: { type: 'chat_disabled', message: '对话功能已被禁用 (maxTurns=0)' },
        metadata: { turnsCount: 0, toolCallsCount: 0, duration: 0 },
      };
    }

    const maxTurns =
      configuredMaxTurns === -1
        ? AGENT_TURN_SAFETY_LIMIT
        : Math.min(configuredMaxTurns, AGENT_TURN_SAFETY_LIMIT);

    const loopConfig = buildLoopConfig({
      context,
      options,
      loopState,
      maxTurns,
      isYoloMode,
      getLastUuid: () => lastMessageUuid,
      setLastUuid: (uuid: MessageId | null) => {
        lastMessageUuid = uuid;
      },
      streaming: this.streaming,
      executionPipeline: this.executionPipeline,
      logger: this.logger,
      tokenBudget: this.tokenBudget,
      compactionHandler: this.compactionHandler,
      hookRuntime: this.hookRuntime,
      modelManager: this.modelManager,
      runtimePatchManager: this.runtimePatchManager,
      defaultProjectPath: this.defaultProjectPath,
      runControl: options?.runControl,
    });

    try {
      const result = yield* agentLoop(loopConfig);

      syncContextMessages(context, loopState.conversationState);
      return result;
    } catch (error) {
      if (isExecutionLeaseFailure(error)) {
        throw error;
      }
      if (isExecutionLeaseFailure(requestSignal?.reason)) {
        throw requestSignal.reason;
      }
      if (
        error instanceof Error &&
        (error.name === 'AbortError' || error.message.includes('aborted'))
      ) {
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

  private createConversation(
    message: UserMessageContent,
    context: AgentExecutionContext,
    systemPrompt?: string,
  ): ConversationState {
    const root: ConversationMessage | null = systemPrompt
      ? {
          role: 'system',
          content: [
            {
              type: 'text',
              text: systemPrompt,
              providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
            },
          ],
        }
      : null;
    const messages = context.messages.filter(
      (entry) => entry.role !== 'system' || isValidSystemSource(entry.provenance?.source),
    );
    return new ConversationState(root, messages, { role: 'user', content: message });
  }

  private async persistInitialMessage(
    message: UserMessageContent,
    context: AgentExecutionContext,
    options?: LoopOptions,
  ): Promise<MessageId | null> {
    const signal = options?.signal ?? context.signal;
    const manager = this.modelManager.getContextManager();
    if (signal?.aborted || !manager || !context.sessionId) return null;
    const application = options?.inputApplication;
    if (!application && !hasPersistableUserContent(message)) return null;
    try {
      return await runWithExecutionLeaseBoundary(
        {
          signal,
          assertExecutionLease: context.assertExecutionLease,
          runWithExecutionLease: context.runWithExecutionLease,
        },
        () =>
          application
            ? manager.saveAppliedInputMessage(
                context.sessionId,
                application.inputId,
                application.requestId,
                message,
                null,
                context.subagentInfo,
              )
            : manager.saveMessage(
                context.sessionId,
                'user',
                message,
                null,
                undefined,
                context.subagentInfo,
              ),
      );
    } catch (error) {
      if (signal?.aborted || isExecutionLeaseFailure(error)) throw error;
      this.logger.warn('[LoopRunner] Failed to persist the initial user message:', error);
      return null;
    }
  }

  private async buildNormalSystemPrompt(context: AgentExecutionContext): Promise<string> {
    const basePrompt = context.systemPrompt
      ? this.runtimePatchManager.appendRuntimeSystemPrompt(context.systemPrompt)
      : await this.buildSystemPromptOnDemand(context);
    const envContext = getEnvironmentContext(context.snapshot?.cwd ?? this.defaultProjectPath);
    if (context.omitEnvironment) {
      return basePrompt;
    }
    return basePrompt ? `${envContext}\n\n---\n\n${basePrompt}` : envContext;
  }

  async buildSystemPromptOnDemand(context?: AgentExecutionContext): Promise<string> {
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
      includeSkills: this.runtimeOptions.localDiscovery !== false,
      language: this.config.language,
      skillActivationContext,
      skillRegistry: this.skillRegistry,
    });

    return result.prompt;
  }

  get skillContext(): LoopSkillState | undefined {
    return this.runtimePatchManager.skillContext;
  }

  setSkillContext(context: LoopSkillState | undefined): void {
    this.runtimePatchManager.setSkillContext(context);
  }

  clearSkillContext(): void {
    this.runtimePatchManager.clearSkillContext();
  }

  // ===== Skill 工具限制 (delegate to RuntimePatchManager) =====

  private createLoopState(
    context: AgentExecutionContext,
    conversationState: ConversationState,
    permissionMode: PermissionMode | undefined,
    toolExecutionLifecycle: LoopOptions['toolExecutionLifecycle'],
  ): LoopState {
    const rpm = this.runtimePatchManager;
    const exposurePlanner = new ToolExposurePlanner(
      this.executionPipeline.getRegistry(),
      () => rpm.discoveredTools ?? new Set(),
    );
    const effectiveSnapshot = rpm.buildRuntimeContextSnapshot(context.sessionId, context.snapshot);
    const initialActivationCwd = effectiveSnapshot?.cwd ?? this.defaultProjectPath;
    const initialMessages = conversationState.toArray();
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
        cachedSkillActivationContext &&
        cachedSkillActivationMessageCount === currentMessageCount &&
        cachedSkillActivationCwd === cwd
      ) {
        return cachedSkillActivationContext;
      }

      cachedSkillActivationContext = rpm.createSkillActivationContext(
        cwd,
        loopState.conversationState.toArray(),
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
        executionFence: context.executionFence,
        assertExecutionLease: context.assertExecutionLease,
        runWithExecutionLease: context.runWithExecutionLease,
        discoverableCatalog: exposurePlanner,
        skillRegistry: this.skillRegistry,
        lifecycle: toolExecutionLifecycle,
      },
      baseContextSnapshot: context.snapshot,
      initialActiveSkill: rpm.skillContext,
      resolveTools: () => {
        const skillActivationContext = resolveSkillActivationContext();
        loopState.executionContext.skillActivationPaths = skillActivationContext.referencedPaths;
        const runtimeToolPolicy =
          rpm.runtimeToolPolicySnapshot ??
          (rpm.skillContext
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
        rpm.syncDiscoverableToolsCatalogMessage(
          loopState.conversationState,
          rawExposurePlan.discoverableTools,
        );
        let rawTools = rawExposurePlan.declarations;
        rawTools = injectSkillsMetadata(
          rawTools,
          skillActivationContext,
          loopState.executionContext.contextSnapshot?.cwd ?? this.defaultProjectPath,
          this.skillRegistry,
        );
        return rawTools;
      },
      resolveModelService: () => this.modelManager.getModelService(),
      resolveMaxContextTokens: () => this.modelManager.getMaxContextTokens(),
    });
    return loopState;
  }
}
