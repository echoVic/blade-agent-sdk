import { describe, expect, it } from 'vitest';
import {
  buildAgentModelFallbackEvent,
  buildAgentRecoveryProjection,
  consumeAgentRecoveryCompactStream,
  shouldEmitAgentRecoveryEvent,
} from '../recovery/recoveryEvents.js';

describe('agent recovery event projection', () => {
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
