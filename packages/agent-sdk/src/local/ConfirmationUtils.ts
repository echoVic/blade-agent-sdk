import type { ConfirmationReasonSource } from './SessionRuntimeUtils.js';
import type { Tool } from '../tools/types/index.js';
import type { JsonObject } from '@blade-ai/ai';

/**
 * A single confirmation reason entry, tracking the source and message
 * that triggered a tool confirmation prompt.
 */
export interface ConfirmationReasonEntry {
  source: ConfirmationReasonSource;
  message: string;
}

/**
 * Combines multiple confirmation reasons into a single display string.
 * Entries are ranked by source (tool > rule > path > hook > handler),
 * deduplicated by (source + message), and joined with newlines.
 * Returns undefined if there are no valid entries.
 */
export function combineConfirmationReasons(
  entries: ConfirmationReasonEntry[],
): string | undefined {
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

/**
 * Builds a permission signature string for session-level approval tracking.
 * Uses the tool's preparePermissionMatcher if available, otherwise falls back to tool name.
 */
export function buildPermissionSignature(
  toolName: string,
  params: JsonObject,
  tool?: Pick<Tool, 'preparePermissionMatcher'>,
): string {
  const signatureContent = tool?.preparePermissionMatcher?.(params)?.signatureContent;
  return signatureContent ? `${toolName}:${signatureContent}` : toolName;
}
