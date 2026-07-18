import { describe, expect, it } from 'vitest';
import { HookManager } from '../local/HookManager.js';

describe('HookManager (agent-sdk)', () => {
  it('can be instantiated', () => {
    const manager = HookManager.getInstance();
    expect(manager).toBeInstanceOf(HookManager);
  });

  it('returns the same singleton instance', () => {
    const a = HookManager.getInstance();
    const b = HookManager.getInstance();
    expect(a).toBe(b);
  });

  it('is disabled by default (requires explicit config)', () => {
    const manager = HookManager.getInstance();
    expect(manager.isEnabled()).toBe(false);
  });
});
