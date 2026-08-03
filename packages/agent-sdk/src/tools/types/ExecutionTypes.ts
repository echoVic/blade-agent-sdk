import type { BackgroundAgentManagerLike, ToolCatalogLike, ToolRegistryLike } from '../../local/index.js';
import type { ContextSnapshot } from '../../local/ContextSnapshot.js';
import type { MessageId, SessionId } from '../../local/branded.js';
import type { BladeConfig, JsonObject, PermissionMode } from '../../types/common.js';
import type { ToolResult } from '../index.js';
import type { ConfirmationHandler } from '../types/index.js';

/**
 * The SINGLE canonical execution context for the tools surface (slice #334).
 *
 * This is the merge of the former two ExecutionContext definitions:
 * - the loose public one in `tools/types/index.ts` (userId, sessionId,
 *   messageId, contextSnapshot, skillActivationPaths, signal, onProgress,
 *   updateOutput, confirmationHandler, permissionMode, bladeConfig,
 *   backgroundAgentManager, toolRegistry, toolCatalog, discoveredTools)
 * - the branded one previously defined here via `Omit<...>` extension
 *
 * The merged type is the strict superset: every loose field is preserved and
 * the session-scoped fields carry the package's branded types
 * (`SessionId`/`MessageId`) plus properly-typed registry/manager ports.
 * `tools/types/index.ts` re-exports THIS interface, so `@blade-ai/agent-sdk/tools`
 * and the root barrel now expose exactly one ExecutionContext.
 */
export interface ExecutionContext {
  userId?: string;
  sessionId?: SessionId;
  messageId?: MessageId;
  contextSnapshot?: ContextSnapshot;
  skillActivationPaths?: string[];
  signal?: AbortSignal;
  onProgress?: (message: string) => void | Promise<void>;
  updateOutput?: (output: string) => void | Promise<void>;
  confirmationHandler?: ConfirmationHandler;
  permissionMode?: PermissionMode;
  bladeConfig?: BladeConfig;
  backgroundAgentManager?: BackgroundAgentManagerLike;
  toolRegistry?: ToolRegistryLike;
  toolCatalog?: ToolCatalogLike;
  discoveredTools?: string[];
}

export function getEffectiveProjectDir(context: ExecutionContext): string | undefined {
  return context.contextSnapshot?.cwd;
}

/**
 * 执行历史记录
 */
export interface ExecutionHistoryEntry {
  executionId: string;
  toolName: string;
  params: JsonObject;
  result: ToolResult;
  startTime: number;
  endTime: number;
  context: ExecutionContext;
}
