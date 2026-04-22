import { describe, expect, it } from 'vitest';
import {
  ToolKind,
  isReadOnlyKind,
  createToolBehavior,
} from '../../tools/types/ToolKind.js';

describe('isConcurrencySafe inference', () => {
  describe('isReadOnlyKind', () => {
    it('returns true for ReadOnly', () => {
      expect(isReadOnlyKind(ToolKind.ReadOnly)).toBe(true);
    });

    it.each([ToolKind.Write, ToolKind.Execute])(
      'returns false for %s',
      (kind) => {
        expect(isReadOnlyKind(kind)).toBe(false);
      },
    );
  });

  describe('createToolBehavior defaults', () => {
    it('ReadOnly kind defaults isConcurrencySafe to true', () => {
      const behavior = createToolBehavior(ToolKind.ReadOnly);
      expect(behavior.isConcurrencySafe).toBe(true);
      expect(behavior.isReadOnly).toBe(true);
    });

    it('Write kind defaults isConcurrencySafe to false', () => {
      const behavior = createToolBehavior(ToolKind.Write);
      expect(behavior.isConcurrencySafe).toBe(false);
      expect(behavior.isReadOnly).toBe(false);
    });

    it('Execute kind defaults isConcurrencySafe to false', () => {
      const behavior = createToolBehavior(ToolKind.Execute);
      expect(behavior.isConcurrencySafe).toBe(false);
      expect(behavior.isReadOnly).toBe(false);
    });

    it('explicit override takes precedence over kind inference', () => {
      const behavior = createToolBehavior(ToolKind.ReadOnly, {
        isConcurrencySafe: false,
      });
      expect(behavior.isConcurrencySafe).toBe(false);
      expect(behavior.isReadOnly).toBe(true);
    });

    it('Write tool can opt-in to concurrency safe', () => {
      const behavior = createToolBehavior(ToolKind.Write, {
        isConcurrencySafe: true,
      });
      expect(behavior.isConcurrencySafe).toBe(true);
    });
  });
});
