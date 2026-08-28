import type { McpServerConfig } from '../mcp/config.js';
import type { WebFetchSecurityPolicy } from '../tools/builtin/web/webFetch.js';
import type { ModelConfig } from '../model/config.js';
import type { PermissionsConfig } from '../types/permissions.js';

export interface BladeConfig {
  models: ModelConfig[];
  currentModelId?: string;
  mcpServers?: Record<string, McpServerConfig>;
  inProcessMcpServerNames?: string[];
  permissions?: PermissionsConfig;
  theme?: string;
  language?: string;
  debug?: boolean | string;
  temperature?: number;
  maxTurns?: number;
  /** Maximum wall-clock duration of one tool invocation. */
  toolTimeoutMs?: number;
  /** Network-boundary policy for the built-in WebFetch tool. */
  webFetch?: WebFetchSecurityPolicy;
  /** Directory used by ExitPlanMode to persist plan files. */
  plansDirectory?: string;
  /**
   * SDK data root for sessions, skills, agents, snapshots, and OAuth tokens.
   * Persistence is disabled when no storage root or repository is provided.
   */
  storageRoot?: string;
}
