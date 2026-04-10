import type { ContextSnapshot } from '../../runtime/index.js';
import type { IChatService, Message } from '../../services/ChatServiceInterface.js';
import type { PermissionMode } from '../../types/common.js';
import type { ConversationState } from './ConversationState.js';
import type {
  LoopExecutionContext,
  LoopRecoveryState,
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
  private recovery: LoopRecoveryState = {
    attempt: 0,
    hasAttemptedReactiveCompact: false,
  };
  private transitionReason?: string;

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
      messages: this.conversationState.toArray() as Message[],
      tools: this.resolveToolsFn(),
      chatService: this.resolveChatServiceFn(),
      maxContextTokens: this.resolveMaxContextTokensFn(),
      permissionMode: this.permissionMode,
      executionContext: this.executionContext,
      activeSkill: this.activeSkill,
      recovery: { ...this.recovery },
      transitionReason: this.transitionReason,
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

  setTransitionReason(reason: string | undefined): void {
    this.transitionReason = reason;
  }

  getRecoveryState(): LoopRecoveryState {
    return { ...this.recovery };
  }

  startRecovery(reason: string): void {
    this.recovery = {
      attempt: this.recovery.attempt + 1,
      hasAttemptedReactiveCompact: true,
      lastReason: reason,
    };
    this.transitionReason = reason;
  }

  markRecoveryRetry(reason: string): void {
    this.recovery = {
      ...this.recovery,
      lastReason: reason,
    };
    this.transitionReason = reason;
  }

  failRecovery(reason: string): void {
    this.recovery = {
      ...this.recovery,
      lastReason: reason,
    };
    this.transitionReason = reason;
  }

  resetRecovery(): void {
    this.recovery = {
      attempt: 0,
      hasAttemptedReactiveCompact: false,
    };
  }
}
