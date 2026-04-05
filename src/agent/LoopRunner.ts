/**
 * LoopRunner — 核心循环编排 + hooks 构建
 *
 * 从 Agent.ts 拆分，职责：
 * - 构建 AgentLoopConfig（工具、消息、hooks）
 * - 执行 agentLoop 并转发事件
 * - 普通模式的 systemPrompt 构建
 */

import { CompactionService } from '../context/CompactionService.js';
import { analyzeFiles } from '../context/FileAnalyzer.js';
import type { HookRuntime } from '../hooks/HookRuntime.js';
import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../logging/Logger.js';
import { buildSystemPrompt } from '../prompts/index.js';
import { createContextSnapshot, type ContextSnapshot, type RuntimePatch } from '../runtime/index.js';
import type { Message } from '../services/ChatServiceInterface.js';
import { injectSkillsMetadata, type SkillActivationContext } from '../skills/index.js';
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
import { LoopState } from './state/LoopState.js';
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

function toJsonValue(value: string | object): JsonValue {
  if (typeof value === 'string') return value;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}

function syncContextMessages(context: ChatContext, messages: Message[]): void {
  context.messages = messages.filter((message) => message.role !== 'system');
}

function hasPersistableUserContent(message: UserMessageContent): boolean {
  if (typeof message === 'string') {
    return message.trim() !== '';
  }

  return message.some((part) => part.type === 'image_url' || part.text.trim() !== '');
}

export class LoopRunner {
  private runtimeSkillState?: LoopSkillState;
  private runtimeToolPolicy?: {
    allow?: string[];
    deny?: string[];
    scope: 'turn' | 'session';
  };
  private runtimeSystemPromptAppend?: {
    value: string;
    scope: 'turn' | 'session';
  };
  private runtimeEnvironmentOverlay?: {
    values: Record<string, string>;
    scope: 'turn' | 'session';
  };
  private runtimeHookRegistrations: Array<{ registrationId: string; scope: 'turn' | 'session' }> = [];
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
    // 1. 构建消息历史
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
    const permissionMode = context.permissionMode;
    const loopState = this.createLoopState(context, messages, permissionMode);

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
    const loopConfig = this.buildLoopConfig(
      context, options, loopState, maxTurns, isYoloMode,
      () => lastMessageUuid,
      (uuid: string | null) => { lastMessageUuid = uuid; },
    );

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

      syncContextMessages(context, loopState.messages);
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
      this.clearTurnScopedRuntimeState();
    }
  }

  // ===== SystemPrompt =====

  private async buildNormalSystemPrompt(context: ChatContext): Promise<string> {
    const basePrompt = context.systemPrompt
      ? this.appendRuntimeSystemPrompt(context.systemPrompt)
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
    const appendPrompt = this.getEffectiveSystemPromptAppend();
    // Undefined projectPath is intentional for context-free turns: it disables
    // filesystem-derived prompt sources such as BLADE.md instead of falling
    // back to an implicit process cwd.
    const projectPath = context?.snapshot?.cwd ?? this.defaultProjectPath;
    const skillActivationContext = this.createSkillActivationContext(
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

  // ===== Skill 工具限制 =====

  get skillContext(): LoopSkillState | undefined {
    return this.runtimeSkillState;
  }

  setSkillContext(ctx: LoopSkillState | undefined): void {
    this.runtimeSkillState = ctx;
    this.runtimeToolPolicy = ctx
      ? {
          allow: ctx.allowedTools,
          deny: ctx.deniedTools,
          scope: ctx.scope ?? 'session',
        }
      : undefined;
  }

  clearSkillContext(): void {
    if (this.runtimeSkillState) {
      this.logger.debug(`🎯 Skill "${this.runtimeSkillState.skillName}" deactivated`);
      this.runtimeSkillState = undefined;
    }
    this.runtimeToolPolicy = undefined;
  }

  private applySkillToolRestrictions(
    tools: FunctionDeclaration[]
  ): FunctionDeclaration[] {
    const allowedTools = this.runtimeToolPolicy?.allow ?? this.runtimeSkillState?.allowedTools;
    const deniedTools = new Set(this.runtimeToolPolicy?.deny ?? this.runtimeSkillState?.deniedTools ?? []);
    if (!allowedTools && deniedTools.size === 0) {
      return tools;
    }

    if (allowedTools) {
      this.logger.debug(`🔒 Applying Skill tool restrictions: ${allowedTools.join(', ')}`);
    }

    const filteredTools = tools.filter((tool) => {
      if (deniedTools.has(tool.name)) {
        return false;
      }
      if (!allowedTools) {
        return true;
      }
      return allowedTools.some((allowed) => {
        if (allowed === tool.name) return true;
        const match = allowed.match(/^(\w+)\(.*\)$/);
        if (match && match[1] === tool.name) return true;
        return false;
      });
    });

    this.logger.debug(
      `🔒 Filtered tools: ${filteredTools.map((t) => t.name).join(', ')} (${filteredTools.length}/${tools.length})`
    );

    return filteredTools;
  }

  private deriveRuntimePatch(
    toolName: string,
    result: { success: boolean; metadata?: Record<string, unknown>; runtimePatch?: RuntimePatch },
  ): RuntimePatch | undefined {
    if (!result.success) {
      return undefined;
    }

    if (result.runtimePatch) {
      return result.runtimePatch;
    }

    if (toolName !== 'Skill') {
      return undefined;
    }

    const metadata = result.metadata;
    if (!metadata) {
      return undefined;
    }

    const runtimeEffects = metadata.runtimeEffects && typeof metadata.runtimeEffects === 'object'
      ? metadata.runtimeEffects as {
          allowedTools?: string[];
          deniedTools?: string[];
          modelId?: string;
          activeScope?: 'turn' | 'session';
        }
      : undefined;

    const modelId = typeof metadata.modelId === 'string'
      ? metadata.modelId
      : typeof metadata.model === 'string'
        ? metadata.model
        : runtimeEffects?.modelId;

    const allow = Array.isArray(runtimeEffects?.allowedTools)
      ? runtimeEffects.allowedTools
      : Array.isArray(metadata.allowedTools)
        ? metadata.allowedTools as string[]
        : undefined;
    const deny = Array.isArray(runtimeEffects?.deniedTools)
      ? runtimeEffects.deniedTools
      : undefined;

    if (!metadata.skillName && !modelId && !allow && !deny) {
      return undefined;
    }

    return {
      scope: runtimeEffects?.activeScope ?? 'session',
      source: metadata.skillName ? 'skill' : 'tool',
      skill: typeof metadata.skillName === 'string'
        ? {
            id: typeof metadata.skillId === 'string' ? metadata.skillId : metadata.skillName,
            name: metadata.skillName,
            basePath: typeof metadata.basePath === 'string' ? metadata.basePath : '',
          }
        : undefined,
      toolPolicy: allow || deny ? { allow, deny } : undefined,
      modelOverride: modelId ? { modelId } : undefined,
    };
  }

  private applyRuntimePatch(patch: RuntimePatch, loopState: LoopState): void {
    if (patch.toolPolicy) {
      this.runtimeToolPolicy = {
        allow: patch.toolPolicy.allow,
        deny: patch.toolPolicy.deny,
        scope: patch.scope,
      };
    } else if (patch.skill) {
      this.runtimeToolPolicy = undefined;
    }

    this.applyRuntimePromptOverlay(patch);
    this.applyRuntimeEnvironmentOverlay(patch);
    loopState.setContextSnapshot(
      this.buildRuntimeContextSnapshot(
        loopState.executionContext.sessionId,
        loopState.getBaseContextSnapshot(),
      ),
    );

    if (patch.hooks && patch.hooks.length > 0 && this.hookRuntime) {
      const registrationIds = this.hookRuntime.registerRuntimeHooks(patch.hooks);
      this.runtimeHookRegistrations.push(
        ...registrationIds.map((registrationId) => ({
          registrationId,
          scope: patch.scope,
        })),
      );
    }

    if (patch.skill) {
      const nextSkillContext: LoopSkillState = {
        skillId: patch.skill.id,
        skillName: patch.skill.name,
        allowedTools: patch.toolPolicy?.allow,
        deniedTools: patch.toolPolicy?.deny,
        basePath: patch.skill.basePath,
        scope: patch.scope,
      };
      this.runtimeSkillState = nextSkillContext;
      loopState.setActiveSkill(nextSkillContext);
      loopState.setTransitionReason('skill_activated');
    }
  }

  private clearTurnScopedRuntimeState(): void {
    if (this.runtimeToolPolicy?.scope === 'turn') {
      this.runtimeToolPolicy = undefined;
    }
    if (this.runtimeSkillState?.scope === 'turn') {
      this.runtimeSkillState = undefined;
    }
    if (this.runtimeSystemPromptAppend?.scope === 'turn') {
      this.runtimeSystemPromptAppend = undefined;
    }
    if (this.runtimeEnvironmentOverlay?.scope === 'turn') {
      this.runtimeEnvironmentOverlay = undefined;
    }
    if (this.hookRuntime && this.runtimeHookRegistrations.length > 0) {
      const turnScopedRegistrations = this.runtimeHookRegistrations
        .filter((registration) => registration.scope === 'turn')
        .map((registration) => registration.registrationId);
      if (turnScopedRegistrations.length > 0) {
        this.hookRuntime.unregisterRuntimeHooks(turnScopedRegistrations);
        this.runtimeHookRegistrations = this.runtimeHookRegistrations
          .filter((registration) => registration.scope !== 'turn');
      }
    }
  }

  private createLoopState(
    context: ChatContext,
    messages: Message[],
    permissionMode: PermissionMode | undefined,
  ): LoopState {
    const registry = this.executionPipeline.getRegistry();
    const effectiveSnapshot = this.buildRuntimeContextSnapshot(
      context.sessionId,
      context.snapshot,
    );
    const initialActivationCwd = effectiveSnapshot?.cwd ?? this.defaultProjectPath;
    const initialSkillActivationContext = this.createSkillActivationContext(
      initialActivationCwd,
      messages,
    );
    let cachedSkillActivationContext = initialSkillActivationContext;
    let cachedSkillActivationMessageCount = messages.length;
    let cachedSkillActivationCwd = initialActivationCwd;
    let loopState: LoopState;

    const resolveSkillActivationContext = (): SkillActivationContext => {
      const cwd = loopState.executionContext.contextSnapshot?.cwd ?? this.defaultProjectPath;
      const currentMessageCount = loopState.messages.length;
      if (
        cachedSkillActivationContext
        && cachedSkillActivationMessageCount === currentMessageCount
        && cachedSkillActivationCwd === cwd
      ) {
        return cachedSkillActivationContext;
      }

      cachedSkillActivationContext = this.createSkillActivationContext(
        cwd,
        loopState.messages,
      );
      cachedSkillActivationMessageCount = currentMessageCount;
      cachedSkillActivationCwd = cwd;
      return cachedSkillActivationContext;
    };

    loopState = new LoopState({
      messages,
      permissionMode,
      executionContext: {
        sessionId: context.sessionId,
        userId: context.userId || 'default',
        contextSnapshot: effectiveSnapshot,
        skillActivationPaths: initialSkillActivationContext.referencedPaths,
        confirmationHandler: context.confirmationHandler,
        backgroundAgentManager: context.backgroundAgentManager,
      },
      baseContextSnapshot: context.snapshot,
      initialActiveSkill: this.runtimeSkillState,
      resolveTools: () => {
        const skillActivationContext = resolveSkillActivationContext();
        loopState.executionContext.skillActivationPaths = skillActivationContext.referencedPaths;
        let rawTools = registry.getFunctionDeclarationsByMode(permissionMode);
        rawTools = injectSkillsMetadata(
          rawTools,
          skillActivationContext,
        );
        return this.applySkillToolRestrictions(rawTools);
      },
      resolveChatService: () => this.modelManager.getChatService(),
      resolveMaxContextTokens: () => this.modelManager.getMaxContextTokens(),
    });
    return loopState;
  }

  private getEffectiveSystemPromptAppend(): string | undefined {
    const segments = [
      this.runtimeOptions.appendSystemPrompt?.trim(),
      this.runtimeSystemPromptAppend?.value?.trim(),
    ].filter((segment): segment is string => Boolean(segment));

    if (segments.length === 0) {
      return undefined;
    }

    return segments.join('\n\n---\n\n');
  }

  private appendRuntimeSystemPrompt(prompt: string): string {
    const runtimeAppend = this.runtimeSystemPromptAppend?.value?.trim();
    if (!runtimeAppend) {
      return prompt;
    }

    return prompt.trim()
      ? `${prompt}\n\n---\n\n${runtimeAppend}`
      : runtimeAppend;
  }

  private createSkillActivationContext(
    cwd: string | undefined,
    messages: Message[],
  ): SkillActivationContext {
    return {
      cwd,
      referencedPaths: analyzeFiles(messages).map((reference) => reference.path),
    };
  }

  private buildRuntimeContextSnapshot(
    sessionId: string,
    snapshot?: ContextSnapshot,
  ): ContextSnapshot | undefined {
    if (!this.runtimeEnvironmentOverlay) {
      return snapshot;
    }

    if (!snapshot) {
      return createContextSnapshot(sessionId, 'runtime-overlay', {
        environment: this.runtimeEnvironmentOverlay.values,
      });
    }

    return createContextSnapshot(
      snapshot.sessionId,
      snapshot.turnId,
      snapshot.context,
      { environment: this.runtimeEnvironmentOverlay.values },
    );
  }

  private applyRuntimePromptOverlay(patch: RuntimePatch): void {
    const value = patch.systemPromptAppend?.trim();
    if (value) {
      this.runtimeSystemPromptAppend = {
        value,
        scope: patch.scope,
      };
      return;
    }

    if (patch.skill) {
      this.runtimeSystemPromptAppend = undefined;
    }
  }

  private applyRuntimeEnvironmentOverlay(patch: RuntimePatch): void {
    const nextEnvironment = patch.environment
      ? Object.fromEntries(
          Object.entries(patch.environment)
            .filter(([, value]) => typeof value === 'string')
            .map(([key, value]) => [key, value.trim()]),
        )
      : undefined;

    if (nextEnvironment && Object.keys(nextEnvironment).length > 0) {
      this.runtimeEnvironmentOverlay = {
        values: nextEnvironment,
        scope: patch.scope,
      };
      return;
    }

    if (patch.skill) {
      this.runtimeEnvironmentOverlay = undefined;
    }
  }

  // ===== AgentLoopConfig 构建 =====

  private buildLoopConfig(
    context: ChatContext,
    options: LoopOptions | undefined,
    loopState: LoopState,
    maxTurns: number,
    isYoloMode: boolean,
    getLastUuid: () => string | null,
    setLastUuid: (uuid: string | null) => void,
  ): AgentLoopConfig {
    const self = this;

    return {
      streamHandler: this.streamHandler,
      executionPipeline: this.executionPipeline,
      logger: this.logger,
      messages: loopState.messages,
      maxTurns,
      isYoloMode,
      signal: options?.signal,
      tokenBudget: this.tokenBudget,
      prepareTurnState: (turn) => loopState.buildTurnState(turn),

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

      onReactiveCompact: self.compactionHandler
        ? async function* () {
            const compactStream = self.compactionHandler?.reactiveCompact(context);
            if (!compactStream) {
              return false;
            }
            let result = false;
            while (true) {
              const { value, done } = await compactStream.next();
              if (done) { result = value; break; }
              yield value;
            }
            return result;
          }
        : undefined,

      onRecoveryStateChange(recovery) {
        if (recovery.phase === 'started') {
          loopState.startRecovery(recovery.reason ?? 'recovery_started');
          return;
        }

        if (recovery.phase === 'retrying') {
          loopState.markRecoveryRetry(recovery.reason ?? 'recovery_retry');
          return;
        }

        if (recovery.phase === 'failed') {
          loopState.failRecovery(recovery.reason ?? 'recovery_failed');
          return;
        }

        loopState.resetRecovery();
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
          self.logger.warn('[LoopRunner] 保存助手消息失败:', error);
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
          self.logger.warn('[LoopRunner] 保存工具调用失败:', error);
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
          self.logger.warn('[LoopRunner] 保存工具结果失败:', err);
        }

        const runtimePatch = self.deriveRuntimePatch(toolCall.function.name, {
          success: result.success,
          metadata: result.metadata,
          runtimePatch: result.runtimePatch,
        });
        if (runtimePatch) {
          self.applyRuntimePatch(runtimePatch, loopState);
        }

        const modelId = runtimePatch?.modelOverride?.modelId?.trim() || undefined;
        if (modelId) {
          await self.modelManager.switchModelIfNeeded(modelId);
          loopState.setTransitionReason('model_switched');
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
          self.logger.warn('[LoopRunner] 保存助手消息失败:', error);
        }
      },

      async onStopCheck(ctx) {
        try {
          if (!self.hookRuntime) {
            return { shouldStop: true };
          }
          const stopResult = await self.hookRuntime.executeStopCheck({
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
          const cs = loopState.getChatService().getConfig();
          const compactResult = await CompactionService.compact(
            context.messages,
            {
              trigger: 'auto',
              provider: cs.provider,
              modelName: cs.model,
              maxContextTokens: cs.maxContextTokens ?? 128000,
              apiKey: cs.apiKey,
              baseURL: cs.baseUrl,
              customHeaders: cs.customHeaders,
              projectDir: context.snapshot?.cwd ?? self.defaultProjectPath,
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
            self.logger.warn('[LoopRunner] 保存压缩数据失败:', saveError);
          }

          return {
            success: true,
            compactedMessages: compactResult.compactedMessages,
            continueMessage,
          };
        } catch (compactError) {
          self.logger.error('[LoopRunner] 压缩失败，使用降级策略:', compactError);
          const recentMessages = context.messages.slice(-80);
          context.messages = recentMessages;
          return { success: true, compactedMessages: recentMessages };
        }
      },
    };
  }
}
