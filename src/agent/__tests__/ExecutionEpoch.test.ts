import { describe, expect, it } from 'vitest';
import { ExecutionEpoch } from '../ExecutionEpoch.js';

describe('ExecutionEpoch', () => {
  describe('lifecycle', () => {
    it('starts valid', () => {
      const epoch = new ExecutionEpoch();
      expect(epoch.isValid).toBe(true);
    });

    it('becomes invalid after invalidate()', () => {
      const epoch = new ExecutionEpoch();
      epoch.invalidate();
      expect(epoch.isValid).toBe(false);
    });

    it('invalidate is idempotent', () => {
      const epoch = new ExecutionEpoch();
      epoch.invalidate();
      epoch.invalidate();
      expect(epoch.isValid).toBe(false);
    });
  });

  describe('id monotonicity', () => {
    it('assigns unique monotonically increasing ids', () => {
      const a = new ExecutionEpoch();
      const b = new ExecutionEpoch();
      const c = new ExecutionEpoch();
      expect(b.id).toBeGreaterThan(a.id);
      expect(c.id).toBeGreaterThan(b.id);
    });
  });

  describe('isolation', () => {
    it('invalidating one epoch does not affect another', () => {
      const old = new ExecutionEpoch();
      const current = new ExecutionEpoch();
      old.invalidate();
      expect(old.isValid).toBe(false);
      expect(current.isValid).toBe(true);
    });

    it('epoch ids can distinguish cross-epoch events', () => {
      const epoch1 = new ExecutionEpoch();
      const eventEpochId = epoch1.id;
      epoch1.invalidate();

      const epoch2 = new ExecutionEpoch();
      // An event queued under epoch1 should not match epoch2
      expect(eventEpochId).not.toBe(epoch2.id);
      expect(epoch2.isValid).toBe(true);
    });
  });
});
