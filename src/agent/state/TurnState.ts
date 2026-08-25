import type { ModelMessage } from '../../model/message.js';
import type { ModelService, ModelToolDefinition } from '../../model/service.js';
import type { ContextSnapshot } from '../../runtime/index.js';
import type { DurableExecutionFence } from '../../session/events/DurableExecutionLeaseStore.js';
import type { ToolCatalog } from '../../tools/catalog/index.js';
import type { ToolRegistry } from '../../tools/registry/ToolRegistry.js';
import type { ConfirmationHandler, ToolExecutionLifecycle } from '../../tools/types/execution.js';
import type { PermissionMode } from '../../types/constants.js';
import type { SessionId } from '../../types/identifiers.js';
import type { BladeConfig } from '../config.js';
import type { IBackgroundAgentManager } from '../types.js';

export interface LoopSkillState {
  skillId: string;
  skillName: string;
  allowedTools?: string[];
  deniedTools?: string[];
  basePath: string;
  scope?: 'turn' | 'session';
}

export interface LoopExecutionContext {
  sessionId: SessionId;
  userId: string;
  contextSnapshot?: ContextSnapshot;
  skillActivationPaths?: string[];
  confirmationHandler?: ConfirmationHandler;
  bladeConfig?: BladeConfig;
  backgroundAgentManager?: IBackgroundAgentManager;
  executionFence?: DurableExecutionFence;
  assertExecutionLease?: () => Promise<void>;
  runWithExecutionLease?: <T>(operation: () => Promise<T>) => Promise<T>;
  toolRegistry?: ToolRegistry;
  toolCatalog?: ToolCatalog;
  discoveredTools?: string[];
  lifecycle?: ToolExecutionLifecycle;
}

export interface TurnState {
  turn: number;
  messages: readonly ModelMessage[];
  tools: ModelToolDefinition[];
  modelService: ModelService;
  maxContextTokens: number;
  permissionMode?: PermissionMode;
  executionContext: LoopExecutionContext;
  activeSkill?: LoopSkillState;
}
