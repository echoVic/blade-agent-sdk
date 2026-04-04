import type { ContextSnapshot } from '../../runtime/index.js';
import type { IChatService, Message } from '../../services/ChatServiceInterface.js';
import type { ConfirmationHandler } from '../../tools/types/ExecutionTypes.js';
import type { PermissionMode } from '../../types/common.js';
import type { BackgroundAgentManager } from '../subagents/BackgroundAgentManager.js';

export type LlmToolDefinition = {
  name: string;
  description: string;
  parameters: unknown;
};

export interface LoopSkillState {
  skillName: string;
  allowedTools?: string[];
  basePath: string;
}

export interface LoopRecoveryState {
  attempt: number;
  hasAttemptedReactiveCompact: boolean;
  lastReason?: string;
}

export interface LoopExecutionContext {
  sessionId: string;
  userId: string;
  contextSnapshot?: ContextSnapshot;
  confirmationHandler?: ConfirmationHandler;
  backgroundAgentManager?: BackgroundAgentManager;
}

export interface TurnState {
  turn: number;
  messages: Message[];
  tools: LlmToolDefinition[];
  chatService: IChatService;
  maxContextTokens: number;
  permissionMode?: PermissionMode;
  executionContext: LoopExecutionContext;
  activeSkill?: LoopSkillState;
  recovery?: LoopRecoveryState;
  transitionReason?: string;
}
