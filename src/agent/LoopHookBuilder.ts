import { CompactionService } from '../context/CompactionService.js';
import type { ContextManager } from '../context/ContextManager.js';
import { ProviderRegistryError } from '../errors/ProviderRegistryError.js';
import { SdkError } from '../errors/SdkError.js';
import type { HookRuntime } from '../hooks/HookRuntime.js';
import type { InternalLogger } from '../logging/Logger.js';
import type { ConversationMessage } from '../model/conversation.js';
import type { ModelIdentity } from '../model/identity.js';
import type { ModelMessage, ModelToolCall } from '../model/message.js';
import {
  isExecutionLeaseFailure,
  runWithExecutionLeaseBoundary,
} from '../session/events/DurableExecutionLeaseStore.js';
import type { SessionRepositorySubagentRef } from '../session/SessionRepository.js';
import type { ExecutionPipeline } from '../tools/execution/ExecutionPipeline.js';
import type { ToolEffect } from '../tools/types/effects.js';
import type { ToolResult } from '../tools/types/result.js';
import {
  type MessageId,
  SessionId,
  type SessionId as SessionIdType,
  ToolUseId,
} from '../types/identifiers.js';
import type { AgentEvent } from './AgentEvent.js';
import type { AgentLoopConfig, AgentLoopHooks } from './AgentLoop.js';
import type { AgentRunControl, AgentSteeringInput } from './AgentRunControl.js';
import type { CompactionHandler, CompactionRuntimeContext } from './CompactionHandler.js';
import type { ModelManager } from './ModelManager.js';
import type { RuntimePatchManager } from './RuntimePatchManager.js';
import type { LoopState } from './state/LoopState.js';
import type { TokenBudget } from './TokenBudget.js';
import type { AgentExecutionContext, LoopOptions } from './types.js';

export interface LoopHookBuilderDeps {
  context: AgentExecutionContext;
  options: LoopOptions | undefined;
  loopState: LoopState;
  maxTurns: number;
  isYoloMode: boolean;
  getLastUuid: () => MessageId | null;
  setLastUuid: (uuid: MessageId | null) => void;
  streaming?: boolean;
  executionPipeline: ExecutionPipeline;
  logger: InternalLogger;
  tokenBudget?: TokenBudget;
  compactionHandler?: CompactionHandler;
  hookRuntime?: HookRuntime;
  modelManager: ModelManager;
  runtimePatchManager: RuntimePatchManager;
  defaultProjectPath?: string;
  runControl?: AgentRunControl;
}

async function persistTranscript<T>(
  deps: LoopHookBuilderDeps,
  callback: (manager: ContextManager, sessionId: SessionIdType) => Promise<T>,
): Promise<T | undefined> {
  const signal = deps.options?.signal ?? deps.context.signal;
  try {
    signal?.throwIfAborted();
    const manager = deps.modelManager.getContextManager();
    if (!manager || !deps.context.sessionId) return undefined;
    return await runWithExecutionLeaseBoundary(
      {
        signal,
        assertExecutionLease: deps.context.assertExecutionLease,
        runWithExecutionLease: deps.context.runWithExecutionLease,
      },
      () => callback(manager, deps.context.sessionId),
    );
  } catch (error) {
    if (signal?.aborted || isExecutionLeaseFailure(error)) throw error;
    deps.logger.warn('[AgentLoop] Transcript persistence failed:', error);
    const manager = deps.modelManager.getContextManager();
    if (manager && deps.context.sessionId) {
      await manager
        .recordHistoryWriteFailure(
          deps.context.sessionId,
          error instanceof Error ? error.message : String(error),
          deps.runControl?.requestId ? { requestId: deps.runControl.requestId } : undefined,
        )
        .catch(() => undefined);
    }
    return undefined;
  }
}

function subagentReference(
  toolCall: ModelToolCall,
  result: ToolResult,
): SessionRepositorySubagentRef | undefined {
  const metadata = result.metadata;
  if (!metadata || typeof metadata.subagentSessionId !== 'string') return undefined;
  const status = metadata.subagentStatus;
  return {
    subagentSessionId: SessionId(metadata.subagentSessionId),
    subagentType:
      typeof metadata.subagentType === 'string' ? metadata.subagentType : toolCall.function.name,
    subagentStatus:
      status === 'running' ||
      status === 'completed' ||
      status === 'failed' ||
      status === 'cancelled'
        ? status
        : ('completed' as const),
    subagentSummary:
      typeof metadata.subagentSummary === 'string' ? metadata.subagentSummary : undefined,
  };
}

class LoopConfigBuilder {
  private progressTools = 0;
  private pendingToolResults = 0;
  private pendingMessages: ConversationMessage[] = [];
  private assistantMessageId: MessageId | null = null;

  constructor(private readonly deps: LoopHookBuilderDeps) {}

  build(): AgentLoopConfig {
    const { deps } = this;
    const inputLifecycle = deps.options?.inputApplicationLifecycle;
    const hooks: AgentLoopHooks = {
      input: {
        beforeApply: inputLifecycle
          ? ({ input }) => inputLifecycle.onInputApplying(input)
          : undefined,
        apply: ({ input }) => this.applyInput(input),
      },
      turn: {
        beforeTurn: deps.compactionHandler ? (context) => this.beforeTurn(context) : undefined,
        onTurnLimitReached: deps.options?.onTurnLimitReached,
        onTurnLimitCompact: () => this.compactAtTurnLimit(),
      },
      tool: {
        afterExec: (context) => this.afterTool(context),
      },
      message: {
        onAssistant: (context) => this.saveAssistant(context),
      },
      recovery: {
        reactiveCompact: deps.compactionHandler ? () => this.reactiveCompact() : undefined,
      },
    };
    const signal = deps.options?.signal ?? deps.context.signal;
    return {
      streaming: deps.streaming,
      executionPipeline: deps.executionPipeline,
      runControl: deps.runControl,
      logger: deps.logger,
      conversationState: deps.loopState.conversationState,
      maxTurns: deps.maxTurns,
      isYoloMode: deps.isYoloMode,
      signal,
      tokenBudget: deps.tokenBudget,
      modelExecutionLifecycle: deps.options?.modelExecutionLifecycle,
      initialInputPreparation: deps.options?.initialInputPreparation,
      prepareTurnState: (turn) => deps.loopState.buildTurnState(turn),
      hooks,
    };
  }

  private async applyInput(input: AgentSteeringInput): Promise<ConversationMessage> {
    const { deps } = this;
    const runControl = deps.runControl;
    if (!runControl) {
      throw new SdkError(
        'AGENT_RUN_CONTROL_MISSING',
        'Cannot apply steering input without an active run controller',
      );
    }
    const signal = deps.options?.signal ?? deps.context.signal;
    const submitted = deps.hookRuntime
      ? await deps.hookRuntime.applyUserPromptSubmit(input.content, { abortSignal: signal })
      : input.content;
    const content = deps.options?.prepareInput
      ? await deps.options.prepareInput(submitted)
      : submitted;
    signal?.throwIfAborted();
    await deps.context.assertExecutionLease?.();
    const id = await persistTranscript(deps, (manager, sessionId) =>
      manager.saveAppliedInputMessage(
        sessionId,
        input.inputId,
        runControl.requestId,
        content,
        deps.getLastUuid(),
        deps.context.subagentInfo,
      ),
    );
    if (id) deps.setLastUuid(id);
    return {
      id,
      role: 'user',
      content,
      correlation: { inputId: input.inputId, requestId: runControl.requestId },
      extensions: { inputPriority: input.priority },
    };
  }

  private beforeTurn(context: {
    turn: number;
    lastPromptTokens?: number;
  }): AsyncGenerator<AgentEvent, boolean> {
    const handler = this.deps.compactionHandler;
    if (!handler) throw new Error('Compaction handler is not configured');
    return handler.checkAndCompactInLoop(
      this.deps.loopState.conversationState,
      this.compactionContext(),
      context.turn,
      context.lastPromptTokens,
    );
  }

  private async compactAtTurnLimit() {
    const { deps } = this;
    await deps.context.assertExecutionLease?.();
    try {
      const config = deps.loopState.getModelService().getConfig();
      const result = await CompactionService.compact(
        deps.loopState.conversationState.getContextMessages(),
        {
          trigger: 'auto',
          provider: config.provider,
          providerId: config.providerId,
          providerRegistry: deps.modelManager.getProviderRegistry(),
          modelName: config.model,
          maxContextTokens: config.maxContextTokens ?? 128000,
          apiKey: config.apiKey,
          baseURL: config.baseUrl,
          customHeaders: config.customHeaders,
          projectDir: deps.context.snapshot?.cwd ?? deps.defaultProjectPath,
          filesystemRoots: deps.context.snapshot?.filesystemRoots,
          signal: deps.options?.signal ?? deps.context.signal,
          assertExecutionLease: deps.context.assertExecutionLease,
        },
      );
      await this.saveCompaction(result);
      const continueMessage: ModelMessage = {
        role: 'user',
        content:
          'This session is being continued from a previous conversation. ' +
          'The conversation is summarized above.\n\n' +
          'Please continue the last requested task without asking another question.',
      };
      return {
        success: true,
        compactedMessages: result.compactedMessages,
        continueMessage,
      };
    } catch (error) {
      const signal = deps.options?.signal ?? deps.context.signal;
      if (
        signal?.aborted ||
        isExecutionLeaseFailure(error) ||
        error instanceof ProviderRegistryError
      ) {
        throw error;
      }
      deps.logger.error('[AgentLoop] Turn-limit compaction failed; keeping recent history:', error);
      return {
        success: true,
        compactedMessages: deps.loopState.conversationState.getContextMessages().slice(-80),
      };
    }
  }

  private async saveCompaction(result: {
    summary: string;
    preTokens: number;
    postTokens: number;
    filesIncluded: string[];
  }): Promise<void> {
    await persistTranscript(this.deps, (manager, sessionId) =>
      manager.saveCompaction(
        sessionId,
        result.summary,
        {
          trigger: 'auto',
          preTokens: result.preTokens,
          postTokens: result.postTokens,
          filesIncluded: result.filesIncluded,
        },
        null,
      ),
    );
  }

  private async afterTool(context: {
    toolCall: ModelToolCall;
    result: ToolResult;
    effects: ToolEffect[];
    toolMessageId: MessageId | null;
  }): Promise<void> {
    const { toolCall, result, effects, toolMessageId } = context;
    this.pendingMessages.push(
      ...effects.flatMap((effect) => (effect.type === 'newMessages' ? effect.messages : [])),
    );
    await this.saveToolResult(toolCall, result);
    this.pendingToolResults = Math.max(0, this.pendingToolResults - 1);
    if (this.pendingToolResults === 0) await this.saveInjectedMessages();
    await this.applyToolEffects(toolCall, result, effects, toolMessageId);
    await this.reportProgress(toolCall.function.name);
  }

  private async saveToolResult(toolCall: ModelToolCall, result: ToolResult): Promise<void> {
    await persistTranscript(this.deps, async (manager, sessionId) => {
      const id = await manager.saveToolResult(
        sessionId,
        ToolUseId(toolCall.id),
        toolCall.function.name,
        result.status === 'success' ? result.model : null,
        this.deps.getLastUuid(),
        result.status === 'success' ? undefined : result.error.message,
        this.deps.context.subagentInfo,
        subagentReference(toolCall, result),
      );
      this.deps.setLastUuid(id);
    });
  }

  private async saveInjectedMessages(): Promise<void> {
    if (this.pendingMessages.length === 0) return;
    const messages = this.pendingMessages;
    this.pendingMessages = [];
    await persistTranscript(this.deps, async (manager, sessionId) => {
      for (const message of messages) {
        const provenance =
          message.role === 'system' ? { source: 'tool_injection' as const } : message.provenance;
        const metadata =
          message.providerOptions || provenance || message.correlation || message.extensions
            ? {
                providerOptions: message.providerOptions,
                provenance,
                correlation: message.correlation,
                extensions: message.extensions,
              }
            : undefined;
        const id = await manager.saveMessage(
          sessionId,
          message.role,
          message.content,
          this.deps.getLastUuid(),
          metadata,
          this.deps.context.subagentInfo,
        );
        this.deps.setLastUuid(id);
      }
    });
  }

  private async applyToolEffects(
    toolCall: ModelToolCall,
    result: ToolResult,
    effects: ToolEffect[],
    toolMessageId: MessageId | null,
  ): Promise<void> {
    for (const effect of effects) {
      if (effect.type === 'contextPatch') {
        this.deps.runtimePatchManager.applyRuntimeContextPatch(effect.patch);
      }
    }
    this.deps.runtimePatchManager.refreshRuntimeContextSnapshot(this.deps.loopState);
    const patch = this.deps.runtimePatchManager.deriveRuntimePatch({
      status: result.status,
      effects,
    });
    if (!patch) return;
    this.deps.runtimePatchManager.applyRuntimePatch(patch, this.deps.loopState, {
      toolName: toolCall.function.name,
      toolCallId: ToolUseId(toolCall.id),
      toolMessageId: this.assistantMessageId ?? toolMessageId,
    });
    const modelId = patch.modelOverride?.modelId?.trim();
    if (modelId) await this.deps.modelManager.switchModelIfNeeded(modelId);
  }

  private async reportProgress(toolName: string): Promise<void> {
    const callback = this.deps.options?.onProgress;
    if (!callback) return;
    this.progressTools += 1;
    try {
      await callback({
        toolUseCount: this.progressTools,
        tokenCount: 0,
        lastActivity: toolName,
        updatedAt: Date.now(),
      });
    } catch (error) {
      if (isExecutionLeaseFailure(error)) throw error;
    }
  }

  private async saveAssistant(context: {
    content: string;
    reasoningContent?: string;
    toolCalls?: ModelToolCall[];
    modelIdentity: ModelIdentity;
  }): Promise<void> {
    this.pendingToolResults = context.toolCalls?.length ?? 0;
    this.pendingMessages = [];
    this.assistantMessageId = null;
    if (!context.content.trim() && !context.reasoningContent && !context.toolCalls?.length) return;
    const id = await persistTranscript(this.deps, (manager, sessionId) =>
      manager.saveMessage(
        sessionId,
        'assistant',
        context.content,
        this.deps.getLastUuid(),
        {
          modelIdentity: context.modelIdentity,
          reasoningContent: context.reasoningContent,
          toolCalls: context.toolCalls,
        },
        this.deps.context.subagentInfo,
      ),
    );
    if (id) {
      this.deps.setLastUuid(id);
      this.assistantMessageId = id;
    }
  }

  private reactiveCompact() {
    const handler = this.deps.compactionHandler;
    if (!handler) throw new Error('Compaction handler is not configured');
    return handler.reactiveCompact(this.deps.loopState.conversationState, this.compactionContext());
  }

  private compactionContext(): CompactionRuntimeContext {
    const { context, options, defaultProjectPath } = this.deps;
    return {
      sessionId: context.sessionId,
      projectDir: context.snapshot?.cwd ?? defaultProjectPath,
      filesystemRoots: context.snapshot?.filesystemRoots,
      signal: options?.signal ?? context.signal,
      assertExecutionLease: context.assertExecutionLease,
      runWithExecutionLease: context.runWithExecutionLease,
    };
  }
}

export function buildLoopConfig(deps: LoopHookBuilderDeps): AgentLoopConfig {
  return new LoopConfigBuilder(deps).build();
}
