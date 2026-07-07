import { describe, expect, it } from 'vitest';
import {
  createInterruptAwareAbortSignal,
  resolveToolInterruptBehavior,
  ToolKind,
} from '../loop/index.js';

describe('tool interrupt behavior', () => {
  it('resolves dynamic tool interrupt behavior from parsed params', () => {
    const registry = {
      get(name: string) {
        if (name !== 'Bash') {
          return undefined;
        }

        return {
          kind: ToolKind.Execute,
          interruptBehavior: 'cancel' as const,
          resolveBehavior: (params: { command?: unknown }) => ({
            interruptBehavior: params.command === 'long-running' ? 'block' as const : 'cancel' as const,
          }),
        };
      },
    };

    expect(resolveToolInterruptBehavior(registry, 'Bash', { command: 'long-running' })).toBe('block');
    expect(resolveToolInterruptBehavior(registry, 'Bash', { command: 'ls' })).toBe('cancel');
    expect(resolveToolInterruptBehavior(registry, 'Unknown', {})).toBe('cancel');
  });

  it('lets cancel-mode tools follow the outer abort signal', () => {
    const outer = new AbortController();
    const batch = new AbortController();
    const interruptSignal = createInterruptAwareAbortSignal({
      outerSignal: outer.signal,
      batchSignal: batch.signal,
      interruptBehavior: 'cancel',
    });

    outer.abort();

    expect(interruptSignal.signal.aborted).toBe(true);
    interruptSignal.cleanup();
  });

  it('lets block-mode tools ignore the outer abort signal while tracking batch aborts', () => {
    const outer = new AbortController();
    const batch = new AbortController();
    const interruptSignal = createInterruptAwareAbortSignal({
      outerSignal: outer.signal,
      batchSignal: batch.signal,
      interruptBehavior: 'block',
    });

    outer.abort();
    expect(interruptSignal.signal.aborted).toBe(false);

    batch.abort();
    expect(interruptSignal.signal.aborted).toBe(true);
    interruptSignal.cleanup();
  });
});
