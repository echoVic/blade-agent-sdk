import { describe, expect, it } from 'vitest';
import { resolveBehavior, ToolKind } from '../behavior.js';

describe('resolveBehavior', () => {
  it.each([
    [ToolKind.ReadOnly, true],
    [ToolKind.Write, false],
    [ToolKind.Execute, false],
  ] as const)('derives default flags for %s tools', (kind, expectedReadOnly) => {
    expect(resolveBehavior({ kind })).toEqual({
      kind,
      sideEffect: 'non_idempotent',
      isReadOnly: expectedReadOnly,
      isConcurrencySafe: expectedReadOnly,
      isDestructive: false,
      interruptBehavior: 'block',
    });
  });

  it('preserves explicit static overrides', () => {
    expect(
      resolveBehavior({
        kind: ToolKind.ReadOnly,
        sideEffect: 'pure',
        isReadOnly: false,
        isConcurrencySafe: false,
        isDestructive: true,
        interruptBehavior: 'cancel',
      }),
    ).toEqual({
      kind: ToolKind.ReadOnly,
      sideEffect: 'pure',
      isReadOnly: false,
      isConcurrencySafe: false,
      isDestructive: true,
      interruptBehavior: 'cancel',
    });
  });

  it('uses the resolver without params for planning-time behavior', () => {
    let received: unknown = 'not-called';
    const behavior = resolveBehavior({
      kind: ToolKind.Execute,
      resolveBehavior: (params) => {
        received = params;
        return { kind: ToolKind.ReadOnly, sideEffect: 'pure' };
      },
    });

    expect(received).toBeUndefined();
    expect(behavior.isReadOnly).toBe(true);
    expect(behavior.sideEffect).toBe('pure');
  });

  it('re-derives default flags when the resolved kind changes', () => {
    const behavior = resolveBehavior(
      {
        kind: ToolKind.Execute,
        sideEffect: 'non_idempotent',
        resolveBehavior: () => ({ kind: ToolKind.ReadOnly, sideEffect: 'pure' }),
      },
      {},
    );

    expect(behavior).toEqual({
      kind: ToolKind.ReadOnly,
      sideEffect: 'pure',
      isReadOnly: true,
      isConcurrencySafe: true,
      isDestructive: false,
      interruptBehavior: 'block',
    });
  });

  it('falls back to the static declaration when dynamic resolution fails', () => {
    const behavior = resolveBehavior(
      {
        kind: ToolKind.Write,
        sideEffect: 'idempotent',
        resolveBehavior: () => {
          throw new Error('invalid params');
        },
      },
      {},
    );

    expect(behavior).toMatchObject({
      kind: ToolKind.Write,
      sideEffect: 'idempotent',
      isReadOnly: false,
      isConcurrencySafe: false,
    });
  });
});
