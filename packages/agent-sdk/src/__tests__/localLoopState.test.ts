import { describe, expect, it } from 'vitest';
import { LoopState } from '../local/loopState.js';
import type { LoopExecutionContext, TurnState } from '../local/turnState.js';

function makeContext(): LoopExecutionContext {
  return {
    sessionId: 'session_1' as any,
    userId: 'user_1',
  };
}

describe('LoopState (agent-sdk)', () => {
  function createLoopState(overrides?: Partial<LoopExecutionContext>) {
    return new LoopState({
      conversationState: {
        toArray: () => [],
      } as any,
      executionContext: { ...makeContext(), ...overrides },
      resolveTools: () => [
        { name: 'test_tool', description: 'A test tool', parameters: { type: 'object' as const, properties: {} } },
      ],
      resolveChatService: () => ({} as any),
      resolveMaxContextTokens: () => 100000,
    });
  }

  it('can be instantiated', () => {
    const state = createLoopState();
    expect(state).toBeInstanceOf(LoopState);
  });

  it('builds a TurnState for a given turn', () => {
    const state = createLoopState();
    const turnState = state.buildTurnState(3);
    expect(turnState.turn).toBe(3);
    expect(turnState.tools).toHaveLength(1);
    expect(turnState.tools[0].name).toBe('test_tool');
    expect(turnState.maxContextTokens).toBe(100000);
  });

  it('returns tools via getTools()', () => {
    const state = createLoopState();
    const tools = state.getTools();
    expect(tools).toHaveLength(1);
  });

  it('manages recovery state', () => {
    const state = createLoopState();
    state.startRecovery('context_overflow');
    const recovery = state.getRecoveryState();
    expect(recovery.attempt).toBe(1);
    expect(recovery.hasAttemptedReactiveCompact).toBe(true);
    expect(recovery.lastReason).toBe('context_overflow');
  });

  it('resets recovery state', () => {
    const state = createLoopState();
    state.startRecovery('context_overflow');
    state.resetRecovery();
    const recovery = state.getRecoveryState();
    expect(recovery.attempt).toBe(0);
    expect(recovery.hasAttemptedReactiveCompact).toBe(false);
  });

  it('sets and gets active skill', () => {
    const state = createLoopState();
    expect(state.getActiveSkill()).toBeUndefined();
    state.setActiveSkill({
      skillId: 'skill_1',
      skillName: 'Test Skill',
      basePath: '/tmp/skill',
      allowedTools: ['tool_a'],
    });
    const skill = state.getActiveSkill();
    expect(skill?.skillId).toBe('skill_1');
    expect(skill?.allowedTools).toEqual(['tool_a']);
  });

  it('sets context snapshot', () => {
    const state = createLoopState();
    expect(state.getBaseContextSnapshot()).toBeUndefined();
    state.setContextSnapshot({ cwd: '/tmp/project' } as any);
    expect(state.executionContext.contextSnapshot).toBeDefined();
  });
});
