/**
 * Minimal interfaces replacing root-only type dependencies for agent state.
 * Used by TurnState.ts to avoid importing root classes directly.
 */

// ToolCatalog — methods commonly accessed through LoopExecutionContext
// Mirrors the `getAll()` lookup present on both root and package ToolCatalog.
export interface ToolCatalogLike {
  getAll(): unknown[];
}

// BackgroundAgentManager — optional in LoopExecutionContext
export interface BackgroundAgentManagerLike {}

// ConfirmationHandler — optional in LoopExecutionContext
export interface ConfirmationHandlerLike {}
