/**
 * Hook Protocol Types
 *
 * Runtime-independent hook event definitions, input/output interfaces, and handler contracts
 * for the @blade-ai/agent package. Implementations live in @blade-ai/agent-sdk.
 *
 * Corresponds to the subset of src/hooks/types/HookTypes.ts that is framework-agnostic.
 */

import type { JsonObject, JsonValue } from '@blade-ai/ai';

/**
 * Hook event categories — the full set of lifecycle events a hook can observe.
 */
export type HookEventCategory =
  | 'tool'
  | 'session'
  | 'compaction'
  | 'elicitation'
  | 'task'
  | 'notification'
  | 'config';

/**
 * Hook event names — each hook fires for exactly one of these events.
 */
export type HookEventName =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'UserPromptSubmit'
  | 'Stop'
  | 'StopFailure'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PostCompact'
  | 'PermissionRequest'
  | 'SessionStart'
  | 'SessionEnd'
  | 'TaskCompleted'
  | 'Notification'
  | 'Elicitation'
  | 'ElicitationResult'
  | 'ConfigChange';

/**
 * Hook input — the data passed to a hook when it fires.
 */
export interface HookInput {
  /** The event that triggered this hook */
  hookEventName: HookEventName;

  /** Unique execution ID for this hook invocation */
  hookExecutionId: string;

  /** ISO-8601 timestamp of the event */
  timestamp: string;

  /** Working directory of the agent session */
  sessionId: string;

  /** Current permission mode */
  permissionMode: string;

  /** Tool name (present for tool events) */
  toolName?: string;

  /** Tool use ID (present for tool events) */
  toolUseId?: string;

  /** Tool input parameters (present for tool events) */
  toolInput?: JsonObject;

  /** Tool response (present for PostToolUse) */
  toolResponse?: unknown;

  /** Tool error (present for PostToolUseFailure) */
  toolError?: string;

  /** User prompt text (present for UserPromptSubmit) */
  prompt?: string;

  /** Stop reason (present for Stop) */
  stopReason?: string;

  /** Subagent name (present for SubagentStart/Stop) */
  subagentName?: string;

  /** Compaction reason (present for PreCompact) */
  compactionReason?: string;

  /** Elicitation prompt (present for Elicitation) */
  elicitationPrompt?: string;

  /** Elicitation result (present for ElicitationResult) */
  elicitationResult?: string;

  /** Config key that changed (present for ConfigChange) */
  configKey?: string;

  /** Notification message (present for Notification) */
  notificationMessage?: string;

  /** Additional metadata */
  metadata?: {
    bladeVersion: string;
    hookTimeoutMs: number;
  };
}

/**
 * Hook output — the data returned by a hook handler.
 */
export interface HookOutput {
  /** Whether the hook allows the event to proceed */
  allowed: boolean;

  /** Optional reason for blocking/disabling */
  reason?: string;

  /** Modified tool input (PreToolUse hooks can mutate input) */
  modifiedInput?: JsonObject;

  /** Modified tool response (PostToolUse hooks can mutate response) */
  modifiedResponse?: unknown;

  /** Additional metadata to pass to downstream hooks */
  metadata?: Record<string, JsonValue>;
}

/**
 * Hook handler contract — every hook implementation must satisfy this.
 */
export type HookHandler = (input: HookInput) => Promise<HookOutput>;

/**
 * Hook configuration — how a hook is registered.
 */
export interface HookConfig {
  /** Hook event name this handler listens for */
  event: HookEventName;

  /** Path to the hook script or module */
  command: string;

  /** Maximum execution time in milliseconds */
  timeout?: number;
}

/**
 * Hook execution result — returned after a hook completes.
 */
export interface HookExecutionResult {
  /** Whether the hook ran successfully */
  success: boolean;

  /** The hook's output (if successful) */
  output?: HookOutput;

  /** Error message (if failed) */
  error?: string;

  /** Execution duration in milliseconds */
  durationMs: number;
}

/**
 * Hook registry — manages registered hooks.
 */
export interface HookRegistry {
  /** Register a hook */
  register(config: HookConfig): void;

  /** Unregister a hook */
  unregister(event: HookEventName, command: string): void;

  /** Get all hooks for a given event */
  getHooks(event: HookEventName): HookConfig[];

  /** Get all registered hooks */
  getAllHooks(): HookConfig[];

  /** Check if any hooks are registered for an event */
  hasHooks(event: HookEventName): boolean;
}
