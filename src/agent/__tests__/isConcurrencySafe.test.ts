import { describe, expect, it } from 'vitest';
import { createToolBehavior, isReadOnlyKind, ToolKind } from '../../tools/types/kind.js';

describe('isConcurrencySafe inference', () => {
  describe('isReadOnlyKind', () => {
    it('returns true for ReadOnly', () => {
      expect(isReadOnlyKind(ToolKind.ReadOnly)).toBe(true);
    });

    it.each([ToolKind.Write, ToolKind.Execute])('returns false for %s', (kind) => {
      expect(isReadOnlyKind(kind)).toBe(false);
    });
  });

  describe('createToolBehavior defaults', () => {
    it('ReadOnly kind defaults isConcurrencySafe to true', () => {
      const behavior = createToolBehavior(ToolKind.ReadOnly, 'pure');
      expect(behavior.isConcurrencySafe).toBe(true);
      expect(behavior.isReadOnly).toBe(true);
      expect(behavior.sideEffect).toBe('pure');
    });

    it('Write kind defaults isConcurrencySafe to false', () => {
      const behavior = createToolBehavior(ToolKind.Write, 'idempotent');
      expect(behavior.isConcurrencySafe).toBe(false);
      expect(behavior.isReadOnly).toBe(false);
      expect(behavior.sideEffect).toBe('idempotent');
    });

    it('Execute kind defaults isConcurrencySafe to false', () => {
      const behavior = createToolBehavior(ToolKind.Execute, 'non_idempotent');
      expect(behavior.isConcurrencySafe).toBe(false);
      expect(behavior.isReadOnly).toBe(false);
      expect(behavior.sideEffect).toBe('non_idempotent');
    });

    it('explicit override takes precedence over kind inference', () => {
      const behavior = createToolBehavior(ToolKind.ReadOnly, 'pure', {
        isConcurrencySafe: false,
      });
      expect(behavior.isConcurrencySafe).toBe(false);
      expect(behavior.isReadOnly).toBe(true);
    });

    it('Write tool can opt-in to concurrency safe', () => {
      const behavior = createToolBehavior(ToolKind.Write, 'idempotent', {
        isConcurrencySafe: true,
      });
      expect(behavior.isConcurrencySafe).toBe(true);
    });
  });
});
