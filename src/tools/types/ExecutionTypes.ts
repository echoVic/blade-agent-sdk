import type {
  ConfirmationHandler,
  ExecutionContext as SdkExecutionContext,
} from '@blade-ai/agent-sdk/tools';
import type { BackgroundAgentManagerLike, ToolCatalogLike, ToolRegistryLike } from '@blade-ai/agent-sdk/local';
import type { ContextSnapshot } from '../../runtime/index.js';
import type { MessageId, SessionId } from '../../types/branded.js';
import type { BladeConfig, JsonObject } from '../../types/common.js';
import type { ToolResult } from './ToolResult.js';

export type {
  ConfirmationDetails,
  ConfirmationHandler,
  ConfirmationResponse,
} from '@blade-ai/agent-sdk/tools';

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
