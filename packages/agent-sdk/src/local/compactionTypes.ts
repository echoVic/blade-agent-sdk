import type { SessionId } from './branded.js';
import type { ConversationState } from '@blade-ai/agent';
import type { CompactingEvent } from './agentEvent.js';

/**
 * CompactionRuntimeContext — 压缩运行时上下文
 *
 * 传递当前 session 上下文给 compaction handler。
 */
export interface CompactionRuntimeContext {
  sessionId: SessionId;
  projectDir?: string;
}

/**
 * CompactionHandlerLike — 压缩处理器契约接口
 *
 * 定义 Agent loop 中压缩检查与执行的最小契约。
 * CompactionHandler (root src/agent/CompactionHandler.ts, 277L) 负责
 * 在每次 turn 执行前检查是否需要压缩，并在必要时执行。
 * 此接口解耦 Agent 与具体的压缩逻辑实现。
 */
export interface CompactionHandlerLike {
  /** 循环中的压缩检查（每次 turn 调用） */
  checkAndCompactInLoop(
    convState: ConversationState,
    runtimeCtx: CompactionRuntimeContext,
    currentTurn: number,
    actualPromptTokens?: number,
  ): AsyncGenerator<CompactingEvent, boolean>;

  /** 反应式压缩（context length error 触发） */
  reactiveCompact(
    convState: ConversationState,
    runtimeCtx: CompactionRuntimeContext,
  ): AsyncGenerator<CompactingEvent, boolean>;
}
