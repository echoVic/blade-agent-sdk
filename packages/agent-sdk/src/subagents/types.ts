import type { ContextSnapshot } from '../runtime/types.js';
import { PermissionMode } from '../types/common.js';

export type ClaudeCodePermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'dontAsk'
  | 'bypassPermissions'
  | 'plan'
  | 'ignore';

export function mapClaudeCodePermissionMode(
  mode: ClaudeCodePermissionMode | undefined,
): PermissionMode {
  switch (mode) {
    case 'default':
    case 'ignore':
    case undefined:
      return PermissionMode.DEFAULT;
    case 'acceptEdits':
      return PermissionMode.AUTO_EDIT;
    case 'dontAsk':
    case 'bypassPermissions':
      return PermissionMode.YOLO;
    case 'plan':
      return PermissionMode.PLAN;
    default:
      return PermissionMode.DEFAULT;
  }
}

export type SubagentColor =
  | 'red'
  | 'blue'
  | 'green'
  | 'yellow'
  | 'purple'
  | 'orange'
  | 'pink'
  | 'cyan'
  | 'gray';

export type SubagentSource =
  | 'builtin'
  | 'user'
  | 'project'
  | 'session'
  | `plugin:${string}`;

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
  omitEnvironment?: boolean;
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
