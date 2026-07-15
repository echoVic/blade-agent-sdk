/**
 * Hook Event Bus
 *
 * 事件分发和回调注册
 */

// ============================================================
// Inlined type definitions (migrated from root)
// ============================================================

// --- From src/types/common.ts ---
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

// --- From src/types/constants.ts ---
export const HookEvent = {
  PreToolUse: 'PreToolUse',
  PostToolUse: 'PostToolUse',
  PostToolUseFailure: 'PostToolUseFailure',
  PermissionRequest: 'PermissionRequest',
  UserPromptSubmit: 'UserPromptSubmit',
  SessionStart: 'SessionStart',
  SessionEnd: 'SessionEnd',
  Stop: 'Stop',
  SubagentStart: 'SubagentStart',
  SubagentStop: 'SubagentStop',
  TaskCompleted: 'TaskCompleted',
  Notification: 'Notification',
  Compaction: 'Compaction',
  StopFailure: 'StopFailure',
  PreCompact: 'PreCompact',
  PostCompact: 'PostCompact',
  Elicitation: 'Elicitation',
  ElicitationResult: 'ElicitationResult',
  ConfigChange: 'ConfigChange',
  CwdChanged: 'CwdChanged',
  FileChanged: 'FileChanged',
  InstructionsLoaded: 'InstructionsLoaded',
} as const;

export type HookEvent = (typeof HookEvent)[keyof typeof HookEvent];

// --- From src/session/types.ts ---
import type { SessionId } from './branded.js';

export interface HookInput {
  event: HookEvent;
  toolName?: string;
  toolInput?: JsonObject;
  toolOutput?: string | object;
  error?: Error;
  sessionId: SessionId;
  [key: string]: unknown;
}

export interface HookOutput {
  action: 'continue' | 'skip' | 'abort';
  /**
   * For PreToolUse hooks: a JsonObject to merge into tool input params.
   * For UserPromptSubmit hooks: either a JsonObject with a `userPrompt`
   * key, or a bare string (legacy form) that replaces the prompt text.
   */
  modifiedInput?: JsonObject | string;
  modifiedOutput?: JsonValue;
  reason?: string;
}

export type HookCallback = (input: HookInput) => Promise<HookOutput>;

// ============================================================
// HookBus class (from src/hooks/HookBus.ts)
// ============================================================

export class HookBus {
  constructor(
    private readonly callbacks: Partial<Record<HookEvent, HookCallback[]>> = {},
  ) {}

  has(event: HookEvent): boolean {
    return (this.callbacks[event]?.length ?? 0) > 0;
  }

  async dispatch(event: HookEvent, input: HookInput): Promise<HookOutput[]> {
    const hooks = this.callbacks[event];
    if (!hooks || hooks.length === 0) {
      return [];
    }

    const results: HookOutput[] = [];
    for (const hook of hooks) {
      results.push(await hook(input));
    }
    return results;
  }
}
