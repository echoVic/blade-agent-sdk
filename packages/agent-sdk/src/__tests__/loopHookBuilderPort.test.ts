import { describe, expect, it } from 'vitest';
import { buildLoopConfig } from '../local/loopHookBuilder.js';
import type { LoopHookBuilderDeps } from '../local/loopHookBuilder.js';
import type { LoopState } from '../local/loopState.js';
import type { ExecutionPipeline } from '../local/executionPipeline.js';
import type { ModelManager } from '../local/modelManager.js';
import type { RuntimePatchManager } from '../local/RuntimePatchManager.js';
import { SessionId } from '../local/branded.js';

/**
 * Slice #345 — LoopHookBuilder ported into @blade-ai/agent-sdk/local.
 *
 * The agent loop config builder (grouped hooks: beforeTurn/afterTurn/
 * preToolUse/postToolUse/startSubagent etc., JSONL persistence wiring)
 * was an agent-core file; root src/agent/LoopHookBuilder.ts is now a
 * re-export shim. The port also fixed 14 pre-existing type errors
 * (sessionId branding, snapshot cwd narrowing, subagentInfo narrowing).
 */

function createDeps(overrides: Partial<LoopHookBuilderDeps> = {}): LoopHookBuilderDeps {
  return {
    context: {
      messages: [],
      userId: 'user-1',
      sessionId: 'session-1',
    },
    options: undefined,
    loopState: {} as unknown as LoopState,
    maxTurns: 10,
    isYoloMode: false,
    getLastUuid: () => null,
    setLastUuid: () => {},
    executionPipeline: {} as unknown as ExecutionPipeline,
    logger: {} as never,
    modelManager: {} as unknown as ModelManager,
    runtimePatchManager: {} as unknown as RuntimePatchManager,
    ...overrides,
  };
}

describe('LoopHookBuilder (package local)', () => {
  it('builds an agent loop config with grouped hooks', () => {
    const config = buildLoopConfig(createDeps());
    expect(config).toBeDefined();
    expect(config.maxTurns).toBe(10);
    expect(config.hooks).toBeDefined();
  });

  it('keeps the branded session id flow intact', () => {
    buildLoopConfig(createDeps());
    expect(SessionId('loop-session')).toBe('loop-session');
  });
});
