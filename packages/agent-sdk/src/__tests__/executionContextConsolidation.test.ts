import { describe, expect, it } from 'vitest';
import { SessionId } from '../local/branded.js';
import type { ContextSnapshot } from '../local/ContextSnapshot.js';
import type {
  BackgroundAgentManagerLike,
  ToolCatalogLike,
} from '../local/turnStateTypes.js';
import type { ToolRegistryLike } from '../local/kernelAdapterTypes.js';
import type { Assert, IsEqual } from '../local/typeAssertions.js';
import {
  getEffectiveProjectDir,
  type ExecutionContext,
  type ExecutionHistoryEntry,
} from '../tools/types/ExecutionTypes.js';
import type { ExecutionContext as PublicToolsExecutionContext } from '../tools/types/index.js';

/**
 * Slice #334 — ExecutionContext consolidation.
 *
 * The package previously had TWO ExecutionContext types:
 * - the loose public one in `tools/types/index.ts`
 *   (`sessionId?: string`, `toolRegistry?: unknown`, ...)
 * - the branded one in `tools/types/ExecutionTypes.ts`
 *   (`sessionId?: SessionId`, typed registry ports, ...)
 *
 * The public `@blade-ai/agent-sdk/tools` surface now exposes ONE canonical
 * ExecutionContext (the branded superset). These assertions pin that
 * contract so a future regression (re-introducing a second loose copy)
 * fails the build.
 */

// The public tools surface must expose the SAME canonical type.
type _PublicToolsExecutionContextIsCanonical = Assert<
  IsEqual<ExecutionContext, PublicToolsExecutionContext>
>;

// The canonical type carries the branded session id, not a plain string.
type _CanonicalSessionIdIsBranded = Assert<
  IsEqual<ExecutionContext['sessionId'], SessionId | undefined>
>;

// The typed registry/manager ports survive the merge (they were `unknown` in
// the loose copy and would defeat the tools-boundary typing if lost).
type _ToolRegistryPortIsTyped = Assert<
  IsEqual<ExecutionContext['toolRegistry'], ToolRegistryLike | undefined>
>;
type _ToolCatalogPortIsTyped = Assert<
  IsEqual<ExecutionContext['toolCatalog'], ToolCatalogLike | undefined>
>;
type _BackgroundAgentManagerPortIsTyped = Assert<
  IsEqual<ExecutionContext['backgroundAgentManager'], BackgroundAgentManagerLike | undefined>
>;

// The runtime layer's ContextSnapshot is the local branded one (the former
// runtime/types.ts duplicate declared a stale plain-string sessionId).
type _RuntimeContextSnapshotIsLocalBranded = Assert<
  IsEqual<ContextSnapshot['sessionId'], SessionId>
>;

describe('ExecutionContext consolidation (single canonical type)', () => {
  it('accepts branded session ids and typed registry ports', () => {
    const toolRegistry: ToolRegistryLike = { get: () => undefined, getAll: () => [] };
    const toolCatalog: ToolCatalogLike = { getAll: () => [] };
    const context: ExecutionContext = {
      sessionId: SessionId('ctx-session'),
      signal: new AbortController().signal,
      toolRegistry,
      toolCatalog,
    };
    expect(context.sessionId).toBe('ctx-session');
    expect(context.toolRegistry).toBe(toolRegistry);
    expect(context.toolCatalog).toBe(toolCatalog);
  });

  it('derives the effective project dir from the context snapshot', () => {
    const context: ExecutionContext = {
      contextSnapshot: {
        sessionId: SessionId('ctx-session'),
        turnId: 'turn-1',
        context: {
          capabilities: {
            filesystem: { roots: ['/workspace'], cwd: '/workspace' },
          },
        },
        filesystemRoots: ['/workspace'],
        cwd: '/workspace',
        environment: {},
      },
    };
    expect(getEffectiveProjectDir(context)).toBe('/workspace');
    expect(getEffectiveProjectDir({})).toBeUndefined();
  });

  it('records execution history entries against the canonical context', () => {
    const entry: ExecutionHistoryEntry = {
      executionId: 'exec-1',
      toolName: 'bash',
      params: { command: 'ls' },
      result: { success: true, llmContent: 'ok' },
      startTime: 0,
      endTime: 1,
      context: {
        sessionId: SessionId('history-session'),
      },
    };
    expect(entry.context.sessionId).toBe('history-session');
  });
});
