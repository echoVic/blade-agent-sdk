import type { ToolUseId } from '../../../types/identifiers.js';
import type { JsonObject } from '../../../types/json.js';
import type { ToolInvocation } from '../../core/ToolInvocation.js';
import type { ToolServices } from '../../services.js';
import type { ExecutionContext } from '../../types/execution.js';
import type { ToolResult } from '../../types/result.js';
import type { Tool } from '../../types/tool.js';
import type { FileLockLease } from '../FileLockManager.js';

/**
 * Mutable per-execution state threaded through every pipeline stage.
 *
 * Stages only ever communicate through this object: a stage either produces a
 * terminal `result` (later stages are skipped) or advances the state. Leases
 * acquired by stages are parked on `fileLease` and released by the orchestrator.
 */
export interface PipelineExecutionState {
  toolName: string;
  tool: Tool;
  params: JsonObject;
  context: ExecutionContext;
  services: ToolServices;
  result?: ToolResult;
  invocation?: ToolInvocation;
  permissionCheckResult?: { reason?: string };
  needsConfirmation: boolean;
  confirmationReasons: ConfirmationReasonEntry[];
  hookToolUseId?: ToolUseId;
  interrupted: boolean;
  fileLease?: FileLockLease;
}

/**
 * Confirmation reason source.
 * Ranked for display: deny > tool > rule > path > handler.
 */
export type ConfirmationReasonSource = 'tool' | 'rule' | 'path' | 'handler' | 'hook';

export interface ConfirmationReasonEntry {
  source: ConfirmationReasonSource;
  message: string;
}

export function combineConfirmationReasons(entries: ConfirmationReasonEntry[]): string | undefined {
  if (entries.length === 0) return undefined;
  const rank: Record<ConfirmationReasonSource, number> = {
    tool: 0,
    rule: 1,
    path: 2,
    hook: 3,
    handler: 4,
  };
  const seen = new Set<string>();
  const sorted = [...entries]
    .sort((a, b) => rank[a.source] - rank[b.source])
    .filter((entry) => {
      const key = `${entry.source}::${entry.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return Boolean(entry.message);
    });
  return sorted.map((entry) => entry.message).join('\n') || undefined;
}

export function addConfirmationReason(
  state: PipelineExecutionState,
  source: ConfirmationReasonSource,
  message: string | undefined,
): void {
  const msg = message || defaultReasonMessage(source);
  state.confirmationReasons.push({ source, message: msg });
}

/** Tool itself requested confirmation (vs. rule/path/hook/handler). */
export function hasToolRequestedConfirmation(state: PipelineExecutionState): boolean {
  return state.confirmationReasons.some((r) => r.source === 'tool');
}

/** Combined, de-duplicated confirmation message derived from all reasons. */
export function getConfirmationReason(state: PipelineExecutionState): string | undefined {
  return combineConfirmationReasons(state.confirmationReasons);
}

function defaultReasonMessage(source: ConfirmationReasonSource): string {
  switch (source) {
    case 'tool':
      return 'Tool-specific confirmation required';
    case 'rule':
      return 'User confirmation required';
    case 'path':
      return 'Path safety confirmation required';
    case 'hook':
      return 'Hook requires confirmation';
    case 'handler':
      return 'User confirmation required';
  }
}

export function getFileLockPath(params: JsonObject): string | null {
  for (const key of ['file_path', 'notebook_path'] as const) {
    const value = params[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return value;
    }
  }
  return null;
}

export function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}
