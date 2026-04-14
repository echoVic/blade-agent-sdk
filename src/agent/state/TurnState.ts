import type { JSONSchema7 } from 'json-schema';
import type { ContextSnapshot } from '../../runtime/index.js';
import type { IChatService, Message } from '../../services/ChatServiceInterface.js';
import type { ToolCatalog } from '../../tools/catalog/index.js';
import type { ToolRegistry } from '../../tools/registry/ToolRegistry.js';
import type { ConfirmationHandler } from '../../tools/types/ExecutionTypes.js';
import type { BladeConfig, PermissionMode } from '../../types/common.js';
import type { IBackgroundAgentManager } from '../types.js';

export type LlmToolDefinition = {
  name: string;
  description: string;
  parameters: JSONSchema7;
};

export interface LoopSkillState {
  skillId: string;
  skillName: string;
  allowedTools?: string[];
  deniedTools?: string[];
  basePath: string;
  scope?: 'turn' | 'session';
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
  skillActivationPaths?: string[];
  confirmationHandler?: ConfirmationHandler;
  bladeConfig?: BladeConfig;
  backgroundAgentManager?: IBackgroundAgentManager;
  toolRegistry?: ToolRegistry;
  toolCatalog?: ToolCatalog;
  discoveredTools?: string[];
}

export interface TurnState {
  turn: number;
  messages: readonly Message[];
  tools: LlmToolDefinition[];
  chatService: IChatService;
  maxContextTokens: number;
  permissionMode?: PermissionMode;
  executionContext: LoopExecutionContext;
  activeSkill?: LoopSkillState;
  recovery?: LoopRecoveryState;
  transitionReason?: string;
}
