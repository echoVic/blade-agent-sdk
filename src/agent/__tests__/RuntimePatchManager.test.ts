import { describe, expect, it } from 'vitest';
import { NOOP_LOGGER } from '../../logging/Logger.js';
import type { RuntimePatch } from '../../runtime/index.js';
import { SessionId } from '../../types/identifiers.js';
import { RuntimePatchManager } from '../RuntimePatchManager.js';
import type { LoopState } from '../state/LoopState.js';

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
    manager.applyRuntimePatch(
      {
        scope: 'turn',
        source: 'tool',
        toolPolicy: { allow: ['Read'] },
      },
      loopState,
    );
    expect(manager.runtimeToolPolicySnapshot).toEqual({
      allow: ['Read'],
      deny: undefined,
      scope: 'turn',
    });

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
    expect(manager.runtimeToolPolicySnapshot).toEqual({ deny: ['Bash'], scope: 'session' });

    manager.clearTurnScopedRuntimeState();
    // The session patch's restriction must survive the temporary skill cleanup.
    expect(manager.runtimeToolPolicySnapshot).toEqual({ deny: ['Bash'], scope: 'session' });
    expect(manager.skillContext).toBeUndefined();
  });

  it('keeps the session baseline visible during a session-scoped skill patch', () => {
    const { manager, loopState } = createManager();
    manager.applyRuntimePatch(sessionPatch(), loopState);
    manager.applyRuntimePatch(
      {
        scope: 'session',
        source: 'tool',
        skill: { id: 'session-skill', name: 'session-skill', basePath: '/tmp' },
      },
      loopState,
    );

    expect(manager.runtimeToolPolicySnapshot).toEqual({ deny: ['Bash'], scope: 'session' });
  });

  it('keeps the session prompt and environment through a turn-scoped skill patch', () => {
    const { manager, loopState } = createManager();
    manager.applyRuntimePatch(
      {
        scope: 'session',
        source: 'tool',
        systemPromptAppend: 'SESSION_SETTING',
        environment: { SESSION_SETTING: 'on' },
      },
      loopState,
    );
    // A temporary skill carries neither field, which must not be read as "drop
    // the session's contribution": the baselines live only in this application
    // list, so pruning across scopes would make them unrecoverable.
    manager.applyRuntimePatch(turnSkillPatch(), loopState);
    expect(manager.getEffectiveSystemPromptAppend()).toContain('SESSION_SETTING');

    manager.clearTurnScopedRuntimeState();

    expect(manager.getEffectiveSystemPromptAppend()).toContain('SESSION_SETTING');
    expect(manager.buildRuntimeContextSnapshot(SessionId('session-policy'))?.context).toMatchObject(
      { environment: { SESSION_SETTING: 'on' } },
    );
    expect(
      manager.getRuntimePatchApplications().map((application) => application.patch.scope),
    ).toEqual(['session']);
  });

  it('still replaces a same-scope prompt contribution that a later skill resets', () => {
    const { manager, loopState } = createManager();
    manager.applyRuntimePatch(
      {
        scope: 'session',
        source: 'tool',
        skill: { id: 'first', name: 'first', basePath: '/tmp' },
        systemPromptAppend: 'FIRST_SKILL',
      },
      loopState,
    );
    manager.applyRuntimePatch(
      {
        scope: 'session',
        source: 'tool',
        skill: { id: 'second', name: 'second', basePath: '/tmp' },
      },
      loopState,
    );

    expect(manager.getEffectiveSystemPromptAppend()).toBeUndefined();
    // The resetting patch stays; only the contribution it replaces is gone.
    expect(
      manager.getRuntimePatchApplications().map((application) => application.patch.skill?.id),
    ).toEqual(['second']);
  });

  it('keeps session tool discoveries through a turn-scoped discovery patch', () => {
    const { manager, loopState } = createManager();
    manager.applyRuntimePatch(
      {
        scope: 'session',
        source: 'tool',
        toolDiscovery: { discover: ['Read'] },
      },
      loopState,
    );
    // A temporary skill discovers another tool. Stamping the merged set with the
    // turn scope would make cleanup drop the session's discovery with it.
    manager.applyRuntimePatch(
      {
        scope: 'turn',
        source: 'tool',
        skill: { id: 'temp-skill', name: 'temp-skill', basePath: '/tmp' },
        toolDiscovery: { discover: ['Write'] },
      },
      loopState,
    );

    expect([...(manager.discoveredTools ?? [])].sort()).toEqual(['Read', 'Write']);

    manager.clearTurnScopedRuntimeState();

    expect([...(manager.discoveredTools ?? [])].sort()).toEqual(['Read']);
  });

  it('drops the session discoveries only when the session resets them', () => {
    const { manager, loopState } = createManager();
    manager.applyRuntimePatch(
      {
        scope: 'session',
        source: 'tool',
        toolDiscovery: { discover: ['Read'] },
      },
      loopState,
    );
    manager.applyRuntimePatch(
      {
        scope: 'turn',
        source: 'tool',
        toolDiscovery: { discover: ['Write'] },
      },
      loopState,
    );

    manager.applyRuntimePatch(
      {
        scope: 'session',
        source: 'tool',
        toolDiscovery: { reset: true },
      },
      loopState,
    );

    // The session reset clears the session layer; the turn's own discovery stays.
    expect([...(manager.discoveredTools ?? [])].sort()).toEqual(['Write']);
  });

  it('keeps the session context overlay through a turn-scoped context patch', () => {
    const { manager } = createManager();
    manager.applyRuntimeContextPatch({
      scope: 'session',
      context: { environment: { BASE: 'on' } },
    });
    manager.applyRuntimeContextPatch({
      scope: 'turn',
      context: { environment: { TEMP: 'on' } },
    });
    expect(manager.buildRuntimeContextSnapshot(SessionId('session-policy'))?.context).toMatchObject(
      { environment: { BASE: 'on', TEMP: 'on' } },
    );

    manager.clearTurnScopedRuntimeState();

    // The turn overlay is dropped, the session overlay is not.
    const context = manager.buildRuntimeContextSnapshot(SessionId('session-policy'))?.context;
    expect(context).toMatchObject({ environment: { BASE: 'on' } });
    expect(context?.environment).not.toHaveProperty('TEMP');
  });

  it('drops only the layer that declares a context reset', () => {
    const { manager } = createManager();
    manager.applyRuntimeContextPatch({
      scope: 'session',
      context: { environment: { BASE: 'on' } },
    });
    manager.applyRuntimeContextPatch({
      scope: 'turn',
      context: { environment: { TEMP: 'on' } },
    });

    manager.applyRuntimeContextPatch({ scope: 'session', reset: true });

    const context = manager.buildRuntimeContextSnapshot(SessionId('session-policy'))?.context;
    expect(context?.environment).toMatchObject({ TEMP: 'on' });
    expect(context?.environment).not.toHaveProperty('BASE');
  });

  it('reveals the session Skill after a turn-scoped Skill is cleaned up', () => {
    const { manager, loopState } = createManager();
    manager.applyRuntimePatch(
      {
        scope: 'session',
        source: 'tool',
        skill: { id: 'base', name: 'base', basePath: '/tmp' },
        systemPromptAppend: 'BASE_PROMPT',
      },
      loopState,
    );
    expect(manager.skillContext).toMatchObject({ skillId: 'base' });

    manager.applyRuntimePatch(
      {
        scope: 'turn',
        source: 'tool',
        skill: { id: 'temp', name: 'temp', basePath: '/tmp' },
      },
      loopState,
    );
    expect(manager.skillContext).toMatchObject({ skillId: 'temp' });

    manager.clearTurnScopedRuntimeState();

    // The session Skill is still applied (its prompt and patch history remain), so
    // the identity has to match it instead of reporting "no active Skill".
    expect(manager.skillContext).toMatchObject({ skillId: 'base', scope: 'session' });
    expect(manager.getEffectiveSystemPromptAppend()).toContain('BASE_PROMPT');
  });

  it('keeps the session policy baseline when the skill context is cleared', () => {
    const { manager, loopState } = createManager();
    manager.applyRuntimePatch(sessionPatch(), loopState);
    manager.applyRuntimePatch(
      {
        scope: 'turn',
        source: 'tool',
        skill: { id: 'temp', name: 'temp', basePath: '/tmp' },
        toolPolicy: { allow: ['Read'] },
      },
      loopState,
    );
    expect(manager.runtimeToolPolicySnapshot).toEqual({
      allow: ['Read'],
      deny: undefined,
      scope: 'turn',
    });

    // Deactivating the temporary Skill restores the session baseline rather than
    // leaving the effective policy empty while the session patch still applies.
    manager.clearSkillContext();

    expect(manager.skillContext).toBeUndefined();
    expect(manager.runtimeToolPolicySnapshot).toEqual({ deny: ['Bash'], scope: 'session' });
  });

  it('reports no policy when neither a patch nor a baseline exists', () => {
    const { manager, loopState } = createManager();
    manager.applyRuntimePatch(turnSkillPatch(), loopState);
    expect(manager.runtimeToolPolicySnapshot).toBeUndefined();
  });
});
