import type { ContextSnapshot } from '../../runtime/index.js';
import type { DurableExecutionFence } from '../../session/events/DurableExecutionLeaseStore.js';
import { PermissionMode } from '../../types/constants.js';

export type ClaudeCodePermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'dontAsk'
  | 'bypassPermissions'
  | 'plan'
  | 'ignore';

const PERMISSION_MODES: Record<ClaudeCodePermissionMode, PermissionMode> = {
  default: PermissionMode.DEFAULT,
  acceptEdits: PermissionMode.AUTO_EDIT,
  dontAsk: PermissionMode.YOLO,
  bypassPermissions: PermissionMode.YOLO,
  plan: PermissionMode.PLAN,
  ignore: PermissionMode.DEFAULT,
};

export function mapClaudeCodePermissionMode(
  mode: ClaudeCodePermissionMode | undefined,
): PermissionMode {
  return mode ? PERMISSION_MODES[mode] : PermissionMode.DEFAULT;
}

export type SubagentColor =
  | 'red'
  | 'blue'
  | 'green'
  | 'yellow'
  | 'purple'
  | 'orange'
  | 'pink'
  | 'cyan';

export type SubagentSource = 'builtin' | 'user' | 'project' | 'session' | `plugin:${string}`;

export interface SubagentConfig {
  name: string;
  description: string;
  systemPrompt?: string;
  tools?: string[];
  color?: SubagentColor;
  configPath?: string;
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit' | string;
  permissionMode?: PermissionMode;
  skills?: string[];
  source?: SubagentSource;
  omitEnvironment?: boolean;
}

export interface SubagentContext {
  prompt: string;
  parentSessionId?: string;
  parentMessageId?: string;
  permissionMode?: PermissionMode;
  subagentSessionId?: string;
  snapshot?: ContextSnapshot;
  signal?: AbortSignal;
  omitEnvironment?: boolean;
  executionFence?: DurableExecutionFence;
  assertExecutionLease?: () => Promise<void>;
  runWithExecutionLease?: <T>(operation: () => Promise<T>) => Promise<T>;
}

export interface SubagentResult {
  success: boolean;
  message: string;
  error?: string;
  agentId?: string;
  stats?: {
    tokens?: number;
    toolCalls?: number;
    duration?: number;
  };
}

export interface SubagentFrontmatter {
  name: string;
  description: string;
  tools?: string[] | string;
  color?: SubagentColor;
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit' | string;
  permissionMode?: ClaudeCodePermissionMode;
  skills?: string[] | string;
  license?: string;
}
