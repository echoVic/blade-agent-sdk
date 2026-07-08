import { describe, expect, it } from 'vitest';
import {
  buildAgentModelFallbackEvent,
  buildAgentRecoveryCompactStreamFromHookContainer,
  buildAgentReactiveCompactHookPayload,
  buildAgentReactiveCompactHookPayloadFromConversation,
  buildAgentRecoveryEffects,
  buildAgentRecoveryExhaustedEffects,
  buildAgentRecoveryProjectionInput,
  buildAgentRecoveryProjection,
  buildAgentRecoveryCompactFailedEffects,
  buildAgentRecoveryResetEffects,
  buildAgentRecoveryRetryingEffects,
  buildAgentRecoveryStartedEffects,
  consumeAgentRecoveryCompactStream,
  hasAgentReactiveCompactHook,
  runAgentRecoveryStateChangeHooks,
  shouldEmitAgentRecoveryEvent,
} from '../recovery/recoveryEvents.js';

describe('agent recovery event projection', () => {
  it('projects object-style recovery projection input for event and reset cases', () => {
    expect(
      buildAgentRecoveryProjectionInput({
        kind: 'started',
        turn: 3,
        attempt: 2,
      }),
    ).toEqual({
      kind: 'started',
      turn: 3,
      attempt: 2,
    });

    expect(
      buildAgentRecoveryProjectionInput({
        kind: 'reset',
        turn: 4,
      }),
    ).toEqual({
      kind: 'reset',
      turn: 4,
    });
  });

  it('projects recovery start state and stream event', () => {
    expect(
      buildAgentRecoveryProjection({
        kind: 'started',
        turn: 2,
        attempt: 1,
      }),
    ).toEqual({
      stateChange: {
        turn: 2,
        phase: 'started',
        reason: 'context_overflow',
        attempt: 1,
      },
      event: {
        type: 'recovery',
        phase: 'started',
        reason: 'context_overflow',
      },
    });
  });

  it('projects reactive compact failure state separately from its public stream reason', () => {
    expect(
      buildAgentRecoveryProjection({
        kind: 'compact_failed',
        turn: 2,
        attempt: 1,
      }),
    ).toEqual({
      stateChange: {
        turn: 2,
        phase: 'failed',
        reason: 'reactive_compact_failed',
        attempt: 1,
      },
      event: {
        type: 'recovery',
        phase: 'failed',
        reason: 'reactive_compact',
      },
    });
  });

  it('projects retrying state separately from its public stream reason', () => {
    expect(
      buildAgentRecoveryProjection({
        kind: 'retrying',
        turn: 2,
        attempt: 1,
      }),
    ).toEqual({
      stateChange: {
        turn: 2,
        phase: 'retrying',
        reason: 'reactive_compact_retry',
        attempt: 1,
      },
      event: {
        type: 'recovery',
        phase: 'retrying',
        reason: 'reactive_compact',
      },
    });
  });

  it('projects exhausted recovery state and stream event', () => {
    expect(
      buildAgentRecoveryProjection({
        kind: 'exhausted',
        turn: 2,
        attempt: 1,
      }),
    ).toEqual({
      stateChange: {
        turn: 2,
        phase: 'failed',
        reason: 'recovery_exhausted',
        attempt: 1,
      },
      event: {
        type: 'recovery',
        phase: 'failed',
        reason: 'recovery_exhausted',
      },
    });
  });

  it('projects recovery reset as state only', () => {
    expect(
      buildAgentRecoveryProjection({
        kind: 'reset',
        turn: 2,
      }),
    ).toEqual({
      stateChange: {
        turn: 2,
        phase: 'reset',
        attempt: 0,
      },
    });
  });

  it('emits public recovery events only for projections with events', () => {
    expect(
      shouldEmitAgentRecoveryEvent(
        buildAgentRecoveryProjection({
          kind: 'started',
          turn: 2,
          attempt: 1,
        }),
      ),
    ).toBe(true);

    expect(
      shouldEmitAgentRecoveryEvent(
        buildAgentRecoveryProjection({
          kind: 'reset',
          turn: 2,
        }),
      ),
    ).toBe(false);
  });

  it('builds recovery effects with state changes and optional stream events', () => {
    const retryingProjection = buildAgentRecoveryProjection({
      kind: 'retrying',
      turn: 4,
      attempt: 2,
    });

    expect(buildAgentRecoveryEffects(retryingProjection)).toEqual({
      stateChanges: [
        {
          turn: 4,
          phase: 'retrying',
          reason: 'reactive_compact_retry',
          attempt: 2,
        },
      ],
      events: [
        {
          type: 'recovery',
          phase: 'retrying',
          reason: 'reactive_compact',
        },
      ],
    });

    const resetProjection = buildAgentRecoveryProjection({
      kind: 'reset',
      turn: 4,
    });

    expect(buildAgentRecoveryEffects(resetProjection)).toEqual({
      stateChanges: [
        {
          turn: 4,
          phase: 'reset',
          attempt: 0,
        },
      ],
      events: [],
    });
  });

  it('builds reset recovery effects from the current turn', () => {
    expect(buildAgentRecoveryResetEffects({ turn: 5 })).toEqual({
      stateChanges: [
        {
          turn: 5,
          phase: 'reset',
          attempt: 0,
        },
      ],
      events: [],
    });
  });

  it('builds started recovery effects from the current turn and attempt', () => {
    expect(buildAgentRecoveryStartedEffects({ turn: 6, attempt: 3 })).toEqual({
      stateChanges: [
        {
          turn: 6,
          phase: 'started',
          reason: 'context_overflow',
          attempt: 3,
        },
      ],
      events: [
        {
          type: 'recovery',
          phase: 'started',
          reason: 'context_overflow',
        },
      ],
    });
  });

  it('builds compact-failed recovery effects from the current turn and attempt', () => {
    expect(buildAgentRecoveryCompactFailedEffects({ turn: 7, attempt: 4 })).toEqual({
      stateChanges: [
        {
          turn: 7,
          phase: 'failed',
          reason: 'reactive_compact_failed',
          attempt: 4,
        },
      ],
      events: [
        {
          type: 'recovery',
          phase: 'failed',
          reason: 'reactive_compact',
        },
      ],
    });
  });

  it('builds retrying recovery effects from the current turn and attempt', () => {
    expect(buildAgentRecoveryRetryingEffects({ turn: 8, attempt: 5 })).toEqual({
      stateChanges: [
        {
          turn: 8,
          phase: 'retrying',
          reason: 'reactive_compact_retry',
          attempt: 5,
        },
      ],
      events: [
        {
          type: 'recovery',
          phase: 'retrying',
          reason: 'reactive_compact',
        },
      ],
    });
  });

  it('builds exhausted recovery effects from an exhausted projection input', () => {
    expect(
      buildAgentRecoveryExhaustedEffects({
        kind: 'exhausted',
        turn: 9,
        attempt: 6,
      }),
    ).toEqual({
      stateChanges: [
        {
          turn: 9,
          phase: 'failed',
          reason: 'recovery_exhausted',
          attempt: 6,
        },
      ],
      events: [
        {
          type: 'recovery',
          phase: 'failed',
          reason: 'recovery_exhausted',
        },
      ],
    });
  });

  it('runs recovery state-change hooks from the session hook container', async () => {
    const effects = buildAgentRecoveryEffects(
      buildAgentRecoveryProjection({
        kind: 'retrying',
        turn: 4,
        attempt: 2,
      }),
    );
    const calls: unknown[] = [];

    const applied = await runAgentRecoveryStateChangeHooks({
      effects,
      hooks: {
        recovery: {
          onStateChange: async (stateChange) => {
            calls.push(stateChange);
          },
        },
      },
    });

    expect(applied).toBe(effects);
    expect(calls).toEqual(effects.stateChanges);
  });

  it('wraps model fallback metadata as a public agent event', () => {
    expect(
      buildAgentModelFallbackEvent({
        originalModel: 'deepseek-chat',
        fallbackModel: 'deepseek-reasoner',
      }),
    ).toEqual({
      type: 'model_fallback',
      originalModel: 'deepseek-chat',
      fallbackModel: 'deepseek-reasoner',
    });
  });

  it('projects reactive compact hook payloads with conversation messages', () => {
    const messages = [{ role: 'user' as const, content: 'large context' }];

    expect(buildAgentReactiveCompactHookPayload({ messages })).toEqual({
      messages,
    });
  });

  it('projects reactive compact hook payloads from conversation state', () => {
    const messages = [{ role: 'user' as const, content: 'large context' }];
    const conversation = {
      toArray: () => messages,
    };

    expect(buildAgentReactiveCompactHookPayloadFromConversation({ conversation })).toEqual({
      messages,
    });
  });

  it('builds reactive compact streams from the session recovery hook container', async () => {
    const messages = [{ role: 'user' as const, content: 'large context' }];
    const calls: unknown[] = [];

    async function* reactiveCompact(payload: {
      messages: readonly { role: 'user'; content: string }[];
    }): AsyncGenerator<{ type: string; phase: string }, boolean | undefined> {
      calls.push(payload);
      yield { type: 'compact_progress', phase: 'start' };
      return true;
    }

    const stream = buildAgentRecoveryCompactStreamFromHookContainer({
      conversation: {
        toArray: () => messages,
      },
      hooks: {
        recovery: {
          reactiveCompact,
        },
      },
    });

    expect(stream).toBeDefined();
    expect(await stream?.next()).toEqual({
      done: false,
      value: { type: 'compact_progress', phase: 'start' },
    });
    expect(await stream?.next()).toEqual({
      done: true,
      value: true,
    });
    expect(calls).toEqual([{ messages }]);
  });

  it('detects reactive compact hooks from the session recovery hook container', () => {
    async function* reactiveCompact(): AsyncGenerator<never, boolean | undefined> {
      yield* [] as never[];
      return true;
    }

    expect(
      hasAgentReactiveCompactHook({
        hooks: {
          recovery: {
            reactiveCompact,
          },
        },
      }),
    ).toBe(true);

    expect(hasAgentReactiveCompactHook({ hooks: { recovery: {} } })).toBe(false);
    expect(hasAgentReactiveCompactHook({ hooks: null })).toBe(false);
  });

  it('passes through reactive compact stream events and returns recovered state', async () => {
    async function* compactStream(): AsyncGenerator<
      { type: string; phase: string },
      boolean | undefined
    > {
      yield { type: 'compact_progress', phase: 'start' };
      yield { type: 'compact_progress', phase: 'finish' };
      return true;
    }

    const events: unknown[] = [];
    const stream = consumeAgentRecoveryCompactStream(compactStream());
    let result: Awaited<ReturnType<typeof stream.next>> | undefined;

    while (true) {
      result = await stream.next();
      if (result.done) break;
      events.push(result.value);
    }

    expect(events).toEqual([
      { type: 'compact_progress', phase: 'start' },
      { type: 'compact_progress', phase: 'finish' },
    ]);
    expect(result.value).toEqual({ recovered: true });
  });

  it('normalizes missing reactive compact recovery returns as unrecovered', async () => {
    async function* compactStream(): AsyncGenerator<
      { type: string; phase: string },
      boolean | undefined
    > {
      yield { type: 'compact_progress', phase: 'start' };
      return undefined;
    }

    const stream = consumeAgentRecoveryCompactStream(compactStream());
    await stream.next();

    expect(await stream.next()).toEqual({
      done: true,
      value: { recovered: false },
    });
  });
});
