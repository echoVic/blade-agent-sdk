import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@blade-ai/ai/chat';
import { RuntimePatchManager } from '../local/RuntimePatchManager.js';
import type { LoopState } from '../local/loopState.js';
import { SessionId } from '../local/branded.js';
import { NOOP_LOGGER } from '../local/Logger.js';
import type { RuntimePatch, RuntimePatchProvenance } from '../local/RuntimePatch.js';

/**
 * Slice #338 — RuntimePatchManager ported into @blade-ai/agent-sdk/local.
 *
 * The runtime patch lifecycle manager (skill/tool-policy/context-overlay/
 * tool-discovery/hooks + patch history) was extracted from the root LoopRunner
 * and now lives in the package; root src/agent/RuntimePatchManager.ts is a
 * re-export shim.
 */

const hookRuntimeStub = {
  registerRuntimeHooks: vi.fn(() => []),
  unregisterRuntimeHooks: vi.fn(),
} as never;

function createFakeLoopState(): LoopState {
  const state = {
    executionContext: { sessionId: SessionId('rpm-session') },
    setActiveSkill: vi.fn(),
    setTransitionReason: vi.fn(),
    setContextSnapshot: vi.fn(),
    getBaseContextSnapshot: vi.fn(() => undefined),
  };
  return state as unknown as LoopState;
}

function makeSkillPatch(skillName: string): RuntimePatch {
  return {
    scope: 'session',
    source: 'skill',
    skill: {
      id: `skill-${skillName}`,
      name: skillName,
      basePath: '/workspace/skills',
    },
    toolPolicy: { allow: ['Read'] },
  };
}

function makeProvenance(toolName: string): Omit<RuntimePatchProvenance, 'appliedAt'> {
  return { toolName, toolCallId: 'call-1' };
}

describe('RuntimePatchManager (package local)', () => {
  it('applies skill patches and activates the skill on the loop state', () => {
    const manager = new RuntimePatchManager(hookRuntimeStub, NOOP_LOGGER);
    const loopState = createFakeLoopState();

    manager.applyRuntimePatch(makeSkillPatch('deploy'), loopState, makeProvenance('Skill'));

    expect(manager.skillContext?.skillName).toBe('deploy');
    expect(loopState.setActiveSkill).toHaveBeenCalledWith(
      expect.objectContaining({ skillName: 'deploy' }),
    );
    expect(loopState.setTransitionReason).toHaveBeenCalledWith('skill_activated');
    expect(manager.runtimeToolPolicySnapshot).toMatchObject({ allow: ['Read'] });
  });

  it('clears turn-scoped state while keeping session-scoped patches', () => {
    const manager = new RuntimePatchManager(hookRuntimeStub, NOOP_LOGGER);
    const loopState = createFakeLoopState();

    manager.applyRuntimePatch(makeSkillPatch('session-skill'), loopState);
    manager.applyRuntimePatch(
      {
        scope: 'turn',
        source: 'tool',
        toolPolicy: { allow: ['Write'] },
      },
      loopState,
      makeProvenance('Write'),
    );

    manager.clearTurnScopedRuntimeState();

    // The session-scoped skill survives; the turn-scoped policy overlay is gone.
    expect(manager.skillContext?.skillName).toBe('session-skill');
    expect(manager.runtimeToolPolicySnapshot).toBeUndefined();
    expect(
      manager.getRuntimePatchApplications().filter((a) => a.patch.scope === 'session'),
    ).toHaveLength(1);
    expect(
      manager.getRuntimePatchApplications().filter((a) => a.patch.scope === 'turn'),
    ).toHaveLength(0);
  });

  it('derives a runtime patch from tool effects or explicit patches', () => {
    const manager = new RuntimePatchManager(hookRuntimeStub, NOOP_LOGGER);

    const fromEffects = manager.deriveRuntimePatch({
      success: true,
      effects: [
        {
          type: 'runtimePatch',
          patch: { scope: 'turn', source: 'tool', environment: { FOO: '1' } },
        },
      ],
    });
    expect(fromEffects).toMatchObject({ scope: 'turn', environment: { FOO: '1' } });

    const explicit: RuntimePatch = {
      scope: 'session',
      source: 'tool',
      environment: { BAR: '2' },
    };
    const fromExplicit = manager.deriveRuntimePatch({
      success: true,
      runtimePatch: explicit,
    });
    expect(fromExplicit).toBe(explicit);

    expect(manager.deriveRuntimePatch({ success: false })).toBeUndefined();
  });

  it('builds skill activation context from non-system messages only', () => {
    const manager = new RuntimePatchManager(hookRuntimeStub, NOOP_LOGGER);
    const messages: Message[] = [
      { role: 'system', content: 'catalog' },
      { role: 'user', content: 'look at src/index.ts please' },
      { role: 'assistant', content: 'sure' },
    ];

    const activation = manager.createSkillActivationContext('/workspace', messages);
    expect(activation.cwd).toBe('/workspace');
    expect(activation.referencedPaths).toEqual(
      expect.arrayContaining([expect.stringContaining('src/index.ts')]),
    );
  });

  it('clears the skill context on deactivation', () => {
    const manager = new RuntimePatchManager(hookRuntimeStub, NOOP_LOGGER);
    const loopState = createFakeLoopState();
    manager.applyRuntimePatch(makeSkillPatch('temp'), loopState);

    manager.clearSkillContext();

    expect(manager.skillContext).toBeUndefined();
    expect(manager.runtimeToolPolicySnapshot).toBeUndefined();
  });
});
