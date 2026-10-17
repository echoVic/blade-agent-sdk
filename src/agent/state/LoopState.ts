import type { ImageRuntime } from '../../images/ImageRuntime.js';
import type { ModelService, ModelToolDefinition } from '../../model/service.js';
import type { ContextSnapshot } from '../../runtime/index.js';
import type { PermissionMode } from '../../types/constants.js';
import type { ConversationState } from './ConversationState.js';
import type { LoopExecutionContext, LoopSkillState, TurnState } from './TurnState.js';

interface LoopStateOptions {
  conversationState: ConversationState;
  permissionMode?: PermissionMode;
  executionContext: LoopExecutionContext;
  baseContextSnapshot?: ContextSnapshot;
  resolveTools: () => ModelToolDefinition[];
  resolveModelService: () => ModelService;
  resolveMaxContextTokens: () => number;
  initialActiveSkill?: LoopSkillState;
  images?: ImageRuntime;
}

export class LoopState {
  conversationState: ConversationState;
  readonly permissionMode?: PermissionMode;
  readonly executionContext: LoopExecutionContext;
  private readonly baseContextSnapshot?: ContextSnapshot;

  private readonly resolveToolsFn: () => ModelToolDefinition[];
  private readonly resolveModelServiceFn: () => ModelService;
  private readonly resolveMaxContextTokensFn: () => number;
  private activeSkill?: LoopSkillState;
  private readonly images?: ImageRuntime;

  constructor(options: LoopStateOptions) {
    this.conversationState = options.conversationState;
    this.permissionMode = options.permissionMode;
    this.executionContext = options.executionContext;
    this.baseContextSnapshot = options.baseContextSnapshot;
    this.resolveToolsFn = options.resolveTools;
    this.resolveModelServiceFn = options.resolveModelService;
    this.resolveMaxContextTokensFn = options.resolveMaxContextTokens;
    this.activeSkill = options.initialActiveSkill;
    this.images = options.images;
  }

  buildTurnState(turn: number): TurnState {
    return {
      turn,
      messages: this.conversationState.toArray(),
      tools: this.resolveToolsFn(),
      modelService: this.resolveModelServiceFn(),
      maxContextTokens: this.resolveMaxContextTokensFn(),
      permissionMode: this.permissionMode,
      executionContext: this.executionContext,
      activeSkill: this.activeSkill,
      images: this.images,
    };
  }

  getModelService(): ModelService {
    return this.resolveModelServiceFn();
  }

  getBaseContextSnapshot(): ContextSnapshot | undefined {
    return this.baseContextSnapshot;
  }

  setContextSnapshot(snapshot: ContextSnapshot | undefined): void {
    this.executionContext.contextSnapshot = snapshot;
  }

  setActiveSkill(skill: LoopSkillState | undefined): void {
    this.activeSkill = skill;
  }
}
