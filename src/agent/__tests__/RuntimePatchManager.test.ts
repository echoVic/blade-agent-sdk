import { describe, expect, it } from 'vitest';
import { NOOP_LOGGER } from '../../logging/Logger.js';
import type { LoopState } from '../state/LoopState.js';
import { RuntimePatchManager } from '../RuntimePatchManager.js';
import type { RuntimePatch } from '../../runtime/index.js';
import { SessionId } from '../../types/identifiers.js';

function createManager() {
  const manager = new RuntimePatchManager(undefined, NOOP_LOGGER);
  const loopState = {
    executionContext: { sessionId: SessionId('session-policy') },
    setActiveSkill: () => undefined,
    setContextSnapshot: () => undefined,
    getBaseContextSnapshot: () => undefined,
  } as unknown as LoopState;
  return { manager, loopState };
}

function sessionPatch(): RuntimePatch {
  return {
    scope: 'session',
    source: 'tool',
    toolPolicy: { deny: ['Bash'] },
  };
}

function turnSkillPatch(): RuntimePatch {
  return {
    scope: 'turn',
    source: 'tool',
    skill: { id: 'temp-skill', name: 'temp-skill', basePath: '/tmp' },
  };
}

describe('RuntimePatchManager tool policy scoping', () => {
  it('restores the session policy after a turn-scoped policy patch', () => {
    const { manager, loopState } = createManager();
    manager.applyRuntimePatch(sessionPatch(), loopState);
    manager.applyRuntimePatch({
      scope: 'turn',
      source: 'tool',
      toolPolicy: { allow: ['Read'] },
    }, loopState);
    expect(manager.runtimeToolPolicySnapshot).toEqual({ allow: ['Read'], deny: undefined, scope: 'turn' });

    manager.clearTurnScopedRuntimeState();
    expect(manager.runtimeToolPolicySnapshot).toEqual({ deny: ['Bash'], scope: 'session' });
  });

  it('keeps the session policy through a turn-scoped skill patch without a toolPolicy', () => {
    const { manager, loopState } = createManager();
    manager.applyRuntimePatch(sessionPatch(), loopState);
    // The other branch: a skill patch that carries no toolPolicy must not erase
    // the effective policy, or turn cleanup has no turn scope left to restore
    // the session baseline from.
    manager.applyRuntimePatch(turnSkillPatch(), loopState);
    expect(manager.runtimeToolPolicySnapshot).toEqual({ deny: ['Bash'], scope: 'turn' });

    manager.clearTurnScopedRuntimeState();
    // The session patch's restriction must survive the temporary skill cleanup.
    expect(manager.runtimeToolPolicySnapshot).toEqual({ deny: ['Bash'], scope: 'session' });
    expect(manager.skillContext).toBeUndefined();
  });

  it('keeps the session baseline visible during a session-scoped skill patch', () => {
    const { manager, loopState } = createManager();
    manager.applyRuntimePatch(sessionPatch(), loopState);
    manager.applyRuntimePatch({
      scope: 'session',
      source: 'tool',
      skill: { id: 'session-skill', name: 'session-skill', basePath: '/tmp' },
    }, loopState);

    expect(manager.runtimeToolPolicySnapshot).toEqual({ deny: ['Bash'], scope: 'session' });
  });

  it('reports no policy when neither a patch nor a baseline exists', () => {
    const { manager, loopState } = createManager();
    manager.applyRuntimePatch(turnSkillPatch(), loopState);
    expect(manager.runtimeToolPolicySnapshot).toBeUndefined();
  });
});
