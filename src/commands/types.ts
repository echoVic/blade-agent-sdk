/**
 * Custom Commands Type Definitions
 *
 * Compatible with Claude Code's custom command system.
 * Supports .blade/commands/ and .claude/commands/ directories.
 */

export interface CustomCommandConfig {
  description?: string;
  allowedTools?: string[];
  argumentHint?: string;
  model?: string;
  disableModelInvocation?: boolean;
}

export interface CustomCommand {
  name: string;
  namespace?: string;
  config: CustomCommandConfig;
  content: string;
  path: string;
  source: 'user' | 'project';
  sourceDir: 'claude' | 'blade';
}

export interface CustomCommandExecutionContext {
  args: string[];
  workspaceRoot: string;
  signal?: AbortSignal;
}

export interface CustomCommandDiscoveryResult {
  commands: CustomCommand[];
  scannedDirs: string[];
  errors: Array<{
    path: string;
    error: string;
  }>;
}

export interface CommandSearchDir {
  path: string;
  source: 'user' | 'project';
  sourceDir: 'claude' | 'blade';
}
