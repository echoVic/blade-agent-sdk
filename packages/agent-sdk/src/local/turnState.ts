import type { JSONSchema7 } from 'json-schema';
import type { ContextSnapshot } from './ContextSnapshot.js';
import type { IChatService, Message } from '@blade-ai/ai/chat';
import type { ToolRegistryLike } from './kernelAdapterTypes.js';
import type { BackgroundAgentManagerLike, ConfirmationHandlerLike, ToolCatalogLike } from './turnStateTypes.js';
import type { SessionId } from './branded.js';
import type { BladeConfig, PermissionMode } from '../types/common.js';

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
  sessionId: SessionId;
  userId: string;
  contextSnapshot?: ContextSnapshot;
  skillActivationPaths?: string[];
  confirmationHandler?: ConfirmationHandlerLike;
  bladeConfig?: BladeConfig;
  backgroundAgentManager?: BackgroundAgentManagerLike;
  toolRegistry?: ToolRegistryLike;
  toolCatalog?: ToolCatalogLike;
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
