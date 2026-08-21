import type { ContextSnapshot } from '../../runtime/index.js';
import type { IChatService } from '../../services/ChatServiceInterface.js';
import type { PermissionMode } from '../../types/common.js';
import type { ConversationState } from './ConversationState.js';
import type {
  LoopExecutionContext,
  LoopSkillState,
  LlmToolDefinition,
  TurnState,
} from './TurnState.js';

interface LoopStateOptions {
  conversationState: ConversationState;
  permissionMode?: PermissionMode;
  executionContext: LoopExecutionContext;
  baseContextSnapshot?: ContextSnapshot;
  resolveTools: () => LlmToolDefinition[];
  resolveChatService: () => IChatService;
  resolveMaxContextTokens: () => number;
  initialActiveSkill?: LoopSkillState;
}

export class LoopState {
  conversationState: ConversationState;
  readonly permissionMode?: PermissionMode;
  readonly executionContext: LoopExecutionContext;
  private readonly baseContextSnapshot?: ContextSnapshot;

  private readonly resolveToolsFn: () => LlmToolDefinition[];
  private readonly resolveChatServiceFn: () => IChatService;
  private readonly resolveMaxContextTokensFn: () => number;
  private activeSkill?: LoopSkillState;

  constructor(options: LoopStateOptions) {
    this.conversationState = options.conversationState;
    this.permissionMode = options.permissionMode;
    this.executionContext = options.executionContext;
    this.baseContextSnapshot = options.baseContextSnapshot;
    this.resolveToolsFn = options.resolveTools;
    this.resolveChatServiceFn = options.resolveChatService;
    this.resolveMaxContextTokensFn = options.resolveMaxContextTokens;
    this.activeSkill = options.initialActiveSkill;
  }

  buildTurnState(turn: number): TurnState {
    return {
      turn,
      messages: this.conversationState.toArray(),
      tools: this.resolveToolsFn(),
      chatService: this.resolveChatServiceFn(),
      maxContextTokens: this.resolveMaxContextTokensFn(),
      permissionMode: this.permissionMode,
      executionContext: this.executionContext,
      activeSkill: this.activeSkill,
    };
  }

  getTools(): LlmToolDefinition[] {
    return this.resolveToolsFn();
  }

  getChatService(): IChatService {
    return this.resolveChatServiceFn();
  }

  getMaxContextTokens(): number {
    return this.resolveMaxContextTokensFn();
  }

  getBaseContextSnapshot(): ContextSnapshot | undefined {
    return this.baseContextSnapshot;
  }

  setContextSnapshot(snapshot: ContextSnapshot | undefined): void {
    this.executionContext.contextSnapshot = snapshot;
  }

  getActiveSkill(): LoopSkillState | undefined {
    return this.activeSkill;
  }

  setActiveSkill(skill: LoopSkillState | undefined): void {
    this.activeSkill = skill;
  }
}
