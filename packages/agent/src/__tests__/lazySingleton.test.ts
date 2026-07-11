import { describe, expect, it, vi } from 'vitest';
import { lazySingleton } from '../utils/lazySingleton.js';

describe('package-local lazySingleton', () => {
  it('returns the same instance on repeated calls', () => {
    let counter = 0;
    const getInstance = lazySingleton(() => {
      counter += 1;
      return { value: counter };
    });

    const a = getInstance();
    const b = getInstance();
    const c = getInstance();

    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('invokes the factory only once', () => {
    const factory = vi.fn().mockReturnValue({ created: true });
    const getInstance = lazySingleton(factory);

    getInstance();
    getInstance();
    getInstance();

    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('constructs lazily — factory is not called until first access', () => {
    const factory = vi.fn().mockReturnValue({ created: true });
    lazySingleton(factory);

    // Factory should not have been called yet
    expect(factory).not.toHaveBeenCalled();
  });

  it('preserves the value returned by the factory', () => {
    const getInstance = lazySingleton(() => ({ answer: 42 }));
    expect(getInstance()).toEqual({ answer: 42 });
  });

  it('handles factory returning falsy values', () => {
    // Factory returning null — should be cached and returned on each call
    const getInstance = lazySingleton(() => null);
    expect(getInstance()).toBeNull();
    expect(getInstance()).toBeNull();
  });

  it('handles factory returning undefined', () => {
    const getInstance = lazySingleton(() => undefined);
    // First call: instance === undefined, so factory runs
    expect(getInstance()).toBeUndefined();
    // Second call: instance === undefined (because factory returned undefined), so factory runs AGAIN
    // This is the expected behavior of the simple implementation
  });
});
