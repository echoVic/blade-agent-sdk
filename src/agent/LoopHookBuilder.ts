/**
 * LoopHookBuilder — AgentLoopConfig 的构建
 *
 * 从 LoopRunner 提取，职责：
 * - 构建 AgentLoopConfig 对象（含分组 hooks）
 * - 统一 JSONL 持久化模式
 */

import { CompactionService } from '../context/CompactionService.js';
import type { ContextManager } from '../context/ContextManager.js';
import type { HookRuntime } from '../hooks/HookRuntime.js';
import type { InternalLogger } from '../logging/Logger.js';
import type { Message } from '../services/ChatServiceInterface.js';
import type { ExecutionPipeline } from '../tools/execution/ExecutionPipeline.js';
import {
  normalizeToolEffects,
  type ToolEffect,
  type ToolResult,
} from '../tools/types/index.js';
import type { FunctionToolCall } from './loop/types.js';
import type { SessionId } from '../types/branded.js';
import type { JsonValue } from '../types/common.js';
import type { AgentLoopConfig, AgentLoopHooks } from './AgentLoop.js';
import type { CompactionHandler, CompactionRuntimeContext } from './CompactionHandler.js';
import type { ModelManager } from './ModelManager.js';
import type { RuntimePatchManager } from './RuntimePatchManager.js';
import type { LoopState } from './state/LoopState.js';
import type { TokenBudget } from './TokenBudget.js';
import type {
  ChatContext,
  LoopOptions,
} from './types.js';

export interface LoopHookBuilderDeps {
  context: ChatContext;
  options: LoopOptions | undefined;
  loopState: LoopState;
  maxTurns: number;
  isYoloMode: boolean;
  getLastUuid: () => string | null;
  setLastUuid: (uuid: string | null) => void;
  streaming?: boolean;
  executionPipeline: ExecutionPipeline;
  logger: InternalLogger;
  tokenBudget?: TokenBudget;
  compactionHandler?: CompactionHandler;
  hookRuntime?: HookRuntime;
  modelManager: ModelManager;
  runtimePatchManager: RuntimePatchManager;
  defaultProjectPath?: string;
}

// ===== JSONL 持久化辅助 =====

async function persistToJsonl(
  modelManager: ModelManager,
  sessionId: SessionId | undefined,
  logger: InternalLogger,
  callback: (contextManager: ContextManager, sessionId: SessionId) => Promise<void>,
): Promise<void> {
  try {
    const contextMgr = modelManager.getContextManager();
    if (contextMgr && sessionId) {
      await callback(contextMgr, sessionId);
    }
  } catch (error) {
    logger.warn('[LoopHookBuilder] JSONL persistence failed:', error);
  }
}

function toJsonValue(value: string | object): JsonValue {
  if (typeof value === 'string') return value;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}

// ===== Main builder =====

export function buildLoopConfig(deps: LoopHookBuilderDeps): AgentLoopConfig {
  const {
    context, options, loopState, maxTurns, isYoloMode,
    getLastUuid, setLastUuid,
    streaming, executionPipeline, logger, tokenBudget,
    compactionHandler, hookRuntime, modelManager,
    runtimePatchManager, defaultProjectPath,
  } = deps;

  let progressToolUseCount = 0;
  let assistantToolCallIds: string[] = [];
  const pendingToolResults = new Map<string, {
    toolCall: FunctionToolCall;
    result: ToolResult;
    injectedMessages: Message[];
    subagentRef?: {
      subagentSessionId: string;
      subagentType: string;
      subagentStatus: 'running' | 'completed' | 'failed' | 'cancelled';
      subagentSummary?: string;
    };
  }>();

  const persistToolResultsIfReady = async (): Promise<void> => {
    if (!assistantToolCallIds.length
      || assistantToolCallIds.some((toolCallId) => !pendingToolResults.has(toolCallId))) return;
    const ready = assistantToolCallIds
      .map((toolCallId) => pendingToolResults.get(toolCallId))
      .filter((pending): pending is NonNullable<typeof pending> => pending !== undefined);
    assistantToolCallIds = [];
    await persistToJsonl(modelManager, context.sessionId, logger, async (contextMgr, sessionId) => {
      for (const pending of ready) {
        const uuid = await contextMgr.saveToolResult(
          sessionId, pending.toolCall.id, pending.toolCall.function.name,
          pending.result.success ? toJsonValue(pending.result.llmContent) : null,
          getLastUuid(), pending.result.success ? undefined : pending.result.error?.message,
          context.subagentInfo, pending.subagentRef,
        );
        setLastUuid(uuid);
      }
      for (const pending of ready) {
        for (const injectedMessage of pending.injectedMessages) {
          const isRec = (v: unknown): v is Record<string, unknown> =>
            typeof v === 'object' && v !== null && !Array.isArray(v);
          const customMetadata = isRec(injectedMessage.metadata)
            ? { ...injectedMessage.metadata }
            : {};
          if (injectedMessage.role === 'system') customMetadata._systemSource = 'tool_injection';
          const uuid = await contextMgr.saveMessage(
            sessionId,
            injectedMessage.role,
            injectedMessage.content,
            getLastUuid(),
            Object.keys(customMetadata).length ? { customMetadata } : undefined,
            context.subagentInfo,
          );
          setLastUuid(uuid);
        }
      }
    });
    for (const pending of ready) pendingToolResults.delete(pending.toolCall.id);
    if (pendingToolResults.size) {
      logger.warn(
        '[LoopHookBuilder] Dropping tool results with no declared tool call:',
        Array.from(pendingToolResults.keys()),
      );
      pendingToolResults.clear();
    }
  };

  const hooks: AgentLoopHooks = {
    turn: {
      async *beforeTurn(ctx) {
        if (!compactionHandler) return false;
        const runtimeCtx: CompactionRuntimeContext = {
          sessionId: context.sessionId,
          projectDir: context.snapshot?.cwd ?? defaultProjectPath,
        };
        const compactionStream = compactionHandler.checkAndCompactInLoop(
          loopState.conversationState, runtimeCtx, ctx.turn, ctx.lastPromptTokens,
        );
        let didCompact = false;
        while (true) {
          const { value, done } = await compactionStream.next();
          if (done) { didCompact = value; break; }
          yield value;
        }
        return didCompact;
      },

      onTurnLimitReached: options?.onTurnLimitReached,

      async onTurnLimitCompact(_ctx) {
        try {
          const cs = loopState.getChatService().getConfig();
          const compactResult = await CompactionService.compact(
            loopState.conversationState.getContextMessages(),
            {
              trigger: 'auto',
              provider: cs.provider,
              modelName: cs.model,
              maxContextTokens: cs.maxContextTokens ?? 128000,
              apiKey: cs.apiKey,
              baseURL: cs.baseUrl,
              customHeaders: cs.customHeaders,
              projectDir: context.snapshot?.cwd ?? defaultProjectPath,
            },
          );
          const continueMessage: Message = {
            role: 'user',
            content: 'This session is being continued from a previous conversation. '
              + 'The conversation is summarized above.\n\n'
              + 'Please continue the conversation from where we left it off without asking the user any further questions. '
              + 'Continue with the last task that you were asked to work on.',
          };

          await persistToJsonl(modelManager, context.sessionId, logger, async (contextMgr, sessionId) => {
            await contextMgr.saveCompaction(
              sessionId, compactResult.summary,
              { trigger: 'auto', preTokens: compactResult.preTokens,
                postTokens: compactResult.postTokens, filesIncluded: compactResult.filesIncluded },
              null,
            );
          });

          return {
            success: true,
            compactedMessages: compactResult.compactedMessages,
            continueMessage,
          };
        } catch (compactError) {
          logger.error('[LoopHookBuilder] 压缩失败，使用降级策略:', compactError);
          const recentMessages = loopState.conversationState.getContextMessages().slice(-80);
          return { success: true, compactedMessages: recentMessages };
        }
      },
    },

    tool: {
      async beforeExec(_ctx) {
        return null;
      },

      async afterExec(ctx) {
        const { toolCall, result } = ctx;
        const normalizedEffects = normalizeToolEffects(result);
        const metadata = result.metadata;
        const injectedMessages = normalizedEffects
          .filter((effect): effect is Extract<ToolEffect, { type: 'newMessages' }> => effect.type === 'newMessages')
          .flatMap((effect) => effect.messages);
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
        pendingToolResults.set(toolCall.id, {
          toolCall,
          result,
          injectedMessages,
          subagentRef,
        });
        await persistToolResultsIfReady();

        for (const effect of normalizedEffects) {
          if (effect.type === 'contextPatch') {
            runtimePatchManager.applyRuntimeContextPatch(effect.patch);
            runtimePatchManager.refreshRuntimeContextSnapshot(loopState);
          }
        }

        const runtimePatch = runtimePatchManager.deriveRuntimePatch({
          success: result.success,
          effects: normalizedEffects,
          runtimePatch: result.runtimePatch,
        });
        if (runtimePatch) {
          runtimePatchManager.applyRuntimePatch(runtimePatch, loopState, {
            toolName: toolCall.function.name,
            toolCallId: toolCall.id,
            toolUseUuid: null,
          });
        }

        const modelId = runtimePatch?.modelOverride?.modelId?.trim() || undefined;
        if (modelId) {
          await modelManager.switchModelIfNeeded(modelId);
          loopState.setTransitionReason('model_switched');
        }

        if (options?.onProgress) {
          progressToolUseCount++;
          try {
            options.onProgress({
              toolUseCount: progressToolUseCount,
              tokenCount: 0,
              lastActivity: toolCall.function.name,
              updatedAt: Date.now(),
            });
          } catch {
            // 忽略回调异常
          }
        }
      },

      async afterExecEpochDiscard(ctx) {
        pendingToolResults.delete(ctx.toolCall.id);
      },
    },

    message: {
      async onAssistant(ctx) {
        await persistToJsonl(modelManager, context.sessionId, logger, async (contextMgr, sessionId) => {
          if (ctx.content.trim() !== '' || ctx.reasoningContent || (ctx.toolCalls?.length ?? 0) > 0) {
            const uuid = await contextMgr.saveMessage(
              sessionId,
              'assistant',
              ctx.content,
              getLastUuid(),
              {
                reasoningContent: ctx.reasoningContent,
                toolCalls: ctx.toolCalls,
              },
              context.subagentInfo,
            );
            setLastUuid(uuid);
          }
        });
        assistantToolCallIds = (ctx.toolCalls ?? []).map((toolCall) => toolCall.id);
        await persistToolResultsIfReady();
      },

      async onComplete(ctx) {
        await persistToJsonl(modelManager, context.sessionId, logger, async (contextMgr, sessionId) => {
          if (ctx.content.trim() !== '') {
            const uuid = await contextMgr.saveMessage(
              sessionId, 'assistant', ctx.content,
              getLastUuid(), undefined, context.subagentInfo,
            );
            setLastUuid(uuid);
          }
        });
      },
    },

    recovery: {
      reactiveCompact: compactionHandler
        ? async function* () {
            const runtimeCtx: CompactionRuntimeContext = {
              sessionId: context.sessionId,
              projectDir: context.snapshot?.cwd ?? defaultProjectPath,
            };
            const compactStream = compactionHandler?.reactiveCompact(loopState.conversationState, runtimeCtx);
            if (!compactStream) return false;
            let result = false;
            while (true) {
              const { value, done } = await compactStream.next();
              if (done) { result = value; break; }
              yield value;
            }
            return result;
          }
        : undefined,

      onStateChange(recovery) {
        if (recovery.phase === 'started') {
          assistantToolCallIds = [];
          pendingToolResults.clear();
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
    },

    stop: {
      async check(ctx) {
        try {
          if (!hookRuntime) {
            return { shouldStop: true };
          }
          const stopResult = await hookRuntime.executeStopCheck({
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
    },
  };

  return {
    streaming,
    executionPipeline,
    logger,
    conversationState: loopState.conversationState,
    maxTurns,
    isYoloMode,
    signal: options?.signal,
    tokenBudget,
    prepareTurnState: (turn) => loopState.buildTurnState(turn),
    hooks,
  };
}
