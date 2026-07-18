import type {
  ConfirmationHandler,
  ExecutionContext as SdkExecutionContext,
} from '../public-index.js';
import type { BackgroundAgentManagerLike, ToolCatalogLike, ToolRegistryLike } from '../../local/index.js';
import type { ContextSnapshot } from '../../local/ContextSnapshot.js';
import type { MessageId, SessionId } from '../../local/branded.js';
import type { BladeConfig, JsonObject } from '../../types/common.js';
import type { ToolResult } from '../index.js';

export type {
  ConfirmationDetails,
  ConfirmationHandler,
  ConfirmationResponse,
} from '../public-index.js';

/**
 * 执行上下文
 */
export interface ExecutionContext extends Omit<
  SdkExecutionContext,
  | 'sessionId'
  | 'messageId'
  | 'contextSnapshot'
  | 'confirmationHandler'
  | 'bladeConfig'
  | 'backgroundAgentManager'
  | 'toolRegistry'
  | 'toolCatalog'
> {
  sessionId?: SessionId;
  messageId?: MessageId;
  contextSnapshot?: ContextSnapshot;
  confirmationHandler?: ConfirmationHandler;
  bladeConfig?: BladeConfig;
  backgroundAgentManager?: BackgroundAgentManagerLike;
  toolRegistry?: ToolRegistryLike;
  toolCatalog?: ToolCatalogLike;
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
