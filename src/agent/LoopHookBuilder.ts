/**
 * LoopHookBuilder — AgentLoopConfig 的构建
 *
 * 从 LoopRunner 提取，职责：
 * - 构建 AgentLoopConfig 对象（含分组 hooks）
 * - 统一 JSONL 持久化模式
 */

import { CompactionService } from '../context/CompactionService.js';
import type { ContextManager } from '../context/ContextManager.js';
import { SdkError } from '../errors/SdkError.js';
import type { HookRuntime } from '../hooks/HookRuntime.js';
import type { InternalLogger } from '../logging/Logger.js';
import type { Message } from '../services/ChatServiceInterface.js';
import type { ExecutionPipeline } from '../tools/execution/ExecutionPipeline.js';
import type { ToolEffect } from '../tools/types/index.js';
import type { SessionId } from '../types/branded.js';
import type { AgentLoopConfig, AgentLoopHooks } from './AgentLoop.js';
import type { AgentRunControl } from './AgentRunControl.js';
import type { CompactionHandler, CompactionRuntimeContext } from './CompactionHandler.js';
import type { ModelManager } from './ModelManager.js';
import type { RuntimePatchManager } from './RuntimePatchManager.js';
import type { LoopState } from './state/LoopState.js';
import type { TokenBudget } from './TokenBudget.js';
import type {
    ChatContext,
    LoopOptions,
} from './types.js';

function isExecutionLeaseFailure(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
    && error.code.startsWith('DURABLE_EXECUTION_LEASE_')
  );
}

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
  runControl?: AgentRunControl;
}

// ===== JSONL 持久化辅助 =====
async function persistToJsonl<T>(
  modelManager: ModelManager,
  sessionId: SessionId | undefined,
  logger: InternalLogger,
  callback: (contextManager: ContextManager, sessionId: SessionId) => Promise<T>,
  assertExecutionLease?: () => Promise<void>,
  signal?: AbortSignal,
  runWithExecutionLease?: <T>(operation: () => Promise<T>) => Promise<T>,
): Promise<T | undefined> {
  try {
    signal?.throwIfAborted();
    const contextMgr = modelManager.getContextManager();
    if (contextMgr && sessionId) {
      const persist = async (): Promise<T> => {
        signal?.throwIfAborted();
        const result = await callback(contextMgr, sessionId);
        signal?.throwIfAborted();
        return result;
      };
      if (runWithExecutionLease) {
        const result = await runWithExecutionLease(persist);
        signal?.throwIfAborted();
        return result;
      }
      await assertExecutionLease?.();
      const result = await persist();
      await assertExecutionLease?.();
      return result;
    }
  } catch (error) {
    if (signal?.aborted || isExecutionLeaseFailure(error)) {
      throw error;
    }
    logger.warn('[LoopHookBuilder] JSONL persistence failed:', error);
  }
  return undefined;
}

// ===== Main builder =====

export function buildLoopConfig(deps: LoopHookBuilderDeps): AgentLoopConfig {
  const {
    context, options, loopState, maxTurns, isYoloMode,
    getLastUuid, setLastUuid,
    streaming, executionPipeline, logger, tokenBudget,
    compactionHandler, hookRuntime, modelManager,
    runtimePatchManager, defaultProjectPath,
    runControl,
  } = deps;

  let progressToolUseCount = 0;
  let pendingToolResultCount = 0;
  let pendingInjectedMessages: Message[] = [];
  let currentAssistantMessageId: string | null = null;
  const inputApplicationLifecycle = options?.inputApplicationLifecycle;

  const hooks: AgentLoopHooks = {
    input: {
      beforeApply: inputApplicationLifecycle
        ? ({ input }) => inputApplicationLifecycle.onInputApplying(input)
        : undefined,
      async apply({ input }) {
        if (!runControl) {
          throw new SdkError(
            'AGENT_RUN_CONTROL_MISSING',
            'Cannot apply steering input without an active run controller',
          );
        }
        const hookContent = hookRuntime
          ? await hookRuntime.applyUserPromptSubmit(input.content)
          : input.content;
        const content = options?.prepareInput
          ? await options.prepareInput(hookContent)
          : hookContent;
        context.signal?.throwIfAborted();
        await context.assertExecutionLease?.();
        const messageId = await persistToJsonl(
          modelManager,
          context.sessionId,
          logger,
          (contextMgr, sessionId) =>
            contextMgr.saveAppliedInputMessage(
              sessionId,
              input.inputId,
              runControl.requestId,
              content,
              getLastUuid(),
              context.subagentInfo,
            ),
          context.assertExecutionLease,
          context.signal,
          context.runWithExecutionLease,
        );
        if (messageId) {
          setLastUuid(messageId);
        }
        return {
          id: messageId,
          role: 'user',
          content,
          metadata: {
            inputId: input.inputId,
            requestId: runControl.requestId,
            inputPriority: input.priority,
          },
        };
      },
    },

    turn: {
      async *beforeTurn(ctx) {
        if (!compactionHandler) return false;
        const runtimeCtx: CompactionRuntimeContext = {
          sessionId: context.sessionId,
          projectDir: context.snapshot?.cwd ?? defaultProjectPath,
          signal: context.signal,
          assertExecutionLease: context.assertExecutionLease,
          runWithExecutionLease: context.runWithExecutionLease,
        };
        const compactionStream = compactionHandler.checkAndCompactInLoop(
          loopState.conversationState, runtimeCtx, ctx.turn, ctx.lastPromptTokens,
        );
        return yield* compactionStream;
      },

      onTurnLimitReached: options?.onTurnLimitReached,

      async onTurnLimitCompact(_ctx) {
        await context.assertExecutionLease?.();
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
              signal: context.signal,
              assertExecutionLease: context.assertExecutionLease,
            },
          );
          context.signal?.throwIfAborted();
          await context.assertExecutionLease?.();
          const continueMessage: Message = {
            role: 'user',
            content: 'This session is being continued from a previous conversation. '
              + 'The conversation is summarized above.\n\n'
              + 'Please continue the conversation from where we left it off without asking the user any further questions. '
              + 'Continue with the last task that you were asked to work on.',
          };

          await persistToJsonl(
            modelManager,
            context.sessionId,
            logger,
            async (contextMgr, sessionId) => {
              await contextMgr.saveCompaction(
                sessionId, compactResult.summary,
                { trigger: 'auto', preTokens: compactResult.preTokens,
                  postTokens: compactResult.postTokens, filesIncluded: compactResult.filesIncluded },
                null,
              );
            },
            context.assertExecutionLease,
            context.signal,
            context.runWithExecutionLease,
          );

          return {
            success: true,
            compactedMessages: compactResult.compactedMessages,
            continueMessage,
          };
        } catch (compactError) {
          if (
            context.signal?.aborted
            || isExecutionLeaseFailure(compactError)
          ) {
            throw compactError;
          }
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
        const { toolCall, result, effects, toolUseUuid } = ctx;
        const injectedMessages = effects
          .filter((effect): effect is Extract<ToolEffect, { type: 'newMessages' }> =>
            effect.type === 'newMessages')
          .flatMap((effect) => effect.messages);
        pendingInjectedMessages.push(...injectedMessages);

        await persistToJsonl(
          modelManager,
          context.sessionId,
          logger,
          async (contextMgr, sessionId) => {
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
              sessionId, toolCall.id, toolCall.function.name,
              result.status === 'success' ? result.model : null,
              getLastUuid(), result.status === 'success' ? undefined : result.error.message,
              context.subagentInfo, subagentRef,
            );
            setLastUuid(uuid);
          },
          context.assertExecutionLease,
          context.signal,
          context.runWithExecutionLease,
        );

        pendingToolResultCount = Math.max(0, pendingToolResultCount - 1);
        if (pendingToolResultCount === 0 && pendingInjectedMessages.length > 0) {
          const messagesToPersist = pendingInjectedMessages;
          pendingInjectedMessages = [];
          await persistToJsonl(
            modelManager,
            context.sessionId,
            logger,
            async (contextMgr, sessionId) => {
              for (const injectedMessage of messagesToPersist) {
                const customMeta = (() => {
                  const isRec = (v: unknown): v is Record<string, unknown> =>
                    typeof v === 'object' && v !== null && !Array.isArray(v);
                  const base = isRec(injectedMessage.metadata)
                    ? { ...injectedMessage.metadata }
                    : {};
                  if (injectedMessage.role === 'system') {
                    base._systemSource = 'tool_injection';
                  }
                  return Object.keys(base).length > 0 ? base : undefined;
                })();

                const injectedUuid = await contextMgr.saveMessage(
                  sessionId,
                  injectedMessage.role,
                  injectedMessage.content,
                  getLastUuid(),
                  customMeta ? { customMetadata: customMeta } : undefined,
                  context.subagentInfo,
                );
                setLastUuid(injectedUuid);
              }
            },
            context.assertExecutionLease,
            context.signal,
            context.runWithExecutionLease,
          );
        }

        for (const effect of effects) {
          if (effect.type === 'contextPatch') {
            runtimePatchManager.applyRuntimeContextPatch(effect.patch);
            runtimePatchManager.refreshRuntimeContextSnapshot(loopState);
          }
        }

        const runtimePatch = runtimePatchManager.deriveRuntimePatch({
          status: result.status,
          effects,
        });
        if (runtimePatch) {
          runtimePatchManager.applyRuntimePatch(runtimePatch, loopState, {
            toolName: toolCall.function.name,
            toolCallId: toolCall.id,
            toolUseUuid: currentAssistantMessageId ?? toolUseUuid,
          });
        }

        const modelId = runtimePatch?.modelOverride?.modelId?.trim() || undefined;
        if (modelId) {
          await modelManager.switchModelIfNeeded(modelId);
        }

        if (options?.onProgress) {
          progressToolUseCount++;
          try {
            await options.onProgress({
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
    },

    message: {
      async onAssistant(ctx) {
        pendingToolResultCount = ctx.toolCalls?.length ?? 0;
        pendingInjectedMessages = [];
        currentAssistantMessageId = null;
        await persistToJsonl(
          modelManager,
          context.sessionId,
          logger,
          async (contextMgr, sessionId) => {
            if (
              ctx.content.trim() !== ''
              || ctx.reasoningContent
              || (ctx.toolCalls?.length ?? 0) > 0
            ) {
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
              currentAssistantMessageId = uuid;
            }
          },
          context.assertExecutionLease,
          context.signal,
          context.runWithExecutionLease,
        );
      },

    },

    recovery: {
      reactiveCompact: compactionHandler
        ? async function* () {
            const runtimeCtx: CompactionRuntimeContext = {
              sessionId: context.sessionId,
              projectDir: context.snapshot?.cwd ?? defaultProjectPath,
              signal: context.signal,
              assertExecutionLease: context.assertExecutionLease,
              runWithExecutionLease: context.runWithExecutionLease,
            };
            const compactStream = compactionHandler?.reactiveCompact(loopState.conversationState, runtimeCtx);
            if (!compactStream) return false;
            return yield* compactStream;
          }
        : undefined,
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
    runControl,
    logger,
    conversationState: loopState.conversationState,
    maxTurns,
    isYoloMode,
    signal: options?.signal,
    tokenBudget,
    modelExecutionLifecycle: options?.modelExecutionLifecycle,
    initialInputPreparation: options?.initialInputPreparation,
    prepareTurnState: (turn) => loopState.buildTurnState(turn),
    hooks,
  };
}
