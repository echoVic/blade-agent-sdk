import type {
  ConfirmationHandler,
  ExecutionContext as SdkExecutionContext,
} from '@blade-ai/agent-sdk/tools';
import type { IBackgroundAgentManager } from '../../agent/types.js';
import type { ContextSnapshot } from '../../runtime/index.js';
import type { MessageId, SessionId } from '../../types/branded.js';
import type { BladeConfig, JsonObject } from '../../types/common.js';
import type { ToolCatalog } from '../catalog/index.js';
import type { ToolRegistry } from '../registry/ToolRegistry.js';
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
  backgroundAgentManager?: IBackgroundAgentManager;
  toolRegistry?: ToolRegistry;
  toolCatalog?: ToolCatalog;
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
