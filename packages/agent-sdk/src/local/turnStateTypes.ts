/**
 * Minimal interfaces replacing root-only type dependencies for agent state.
 * Used by TurnState.ts to avoid importing root classes directly.
 */

// ToolCatalog — methods commonly accessed through LoopExecutionContext
export interface ToolCatalogLike {
  resolveDefinitions?: (toolNames: string[]) => unknown;
}

// BackgroundAgentManager — optional in LoopExecutionContext
export interface BackgroundAgentManagerLike {}

// ConfirmationHandler — optional in LoopExecutionContext
export interface ConfirmationHandlerLike {}
