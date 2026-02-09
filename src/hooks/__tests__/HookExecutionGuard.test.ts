import { describe, expect, it, beforeEach } from 'bun:test';
import { HookExecutionGuard } from '../HookExecutionGuard.js';

describe('HookExecutionGuard', () => {
  let guard: HookExecutionGuard;

  beforeEach(() => {
    guard = new HookExecutionGuard();
  });

  describe('canExecute', () => {
    it('should return true for first execution', () => {
      expect(guard.canExecute('tool-1', 'PreToolUse')).toBe(true);
    });

    it('should return false after markExecuted', () => {
      guard.canExecute('tool-1', 'PreToolUse');
      guard.markExecuted('tool-1', 'PreToolUse');
      expect(guard.canExecute('tool-1', 'PreToolUse')).toBe(false);
    });

    it('should allow different events for same toolUseId', () => {
      guard.canExecute('tool-1', 'PreToolUse');
      guard.markExecuted('tool-1', 'PreToolUse');
      expect(guard.canExecute('tool-1', 'PostToolUse')).toBe(true);
    });

    it('should allow same event for different toolUseIds', () => {
      guard.canExecute('tool-1', 'PreToolUse');
      guard.markExecuted('tool-1', 'PreToolUse');
      expect(guard.canExecute('tool-2', 'PreToolUse')).toBe(true);
    });
  });

  describe('markExecuted', () => {
    it('should mark event as executed', () => {
      guard.canExecute('tool-1', 'PreToolUse');
      guard.markExecuted('tool-1', 'PreToolUse');
      expect(guard.canExecute('tool-1', 'PreToolUse')).toBe(false);
    });

    it('should not affect other events', () => {
      guard.canExecute('tool-1', 'PreToolUse');
      guard.markExecuted('tool-1', 'PreToolUse');
      expect(guard.canExecute('tool-1', 'PostToolUse')).toBe(true);
    });
  });

  describe('cleanup', () => {
    it('should allow re-execution after cleanup', () => {
      guard.canExecute('tool-1', 'PreToolUse');
      guard.markExecuted('tool-1', 'PreToolUse');
      guard.cleanup('tool-1');
      expect(guard.canExecute('tool-1', 'PreToolUse')).toBe(true);
    });

    it('should not affect other toolUseIds', () => {
      guard.canExecute('tool-1', 'PreToolUse');
      guard.markExecuted('tool-1', 'PreToolUse');
      guard.canExecute('tool-2', 'PreToolUse');
      guard.markExecuted('tool-2', 'PreToolUse');

      guard.cleanup('tool-1');
      expect(guard.canExecute('tool-1', 'PreToolUse')).toBe(true);
      expect(guard.canExecute('tool-2', 'PreToolUse')).toBe(false);
    });
  });

  describe('cleanupAll', () => {
    it('should allow re-execution of all after cleanupAll', () => {
      guard.canExecute('tool-1', 'PreToolUse');
      guard.markExecuted('tool-1', 'PreToolUse');
      guard.canExecute('tool-2', 'PostToolUse');
      guard.markExecuted('tool-2', 'PostToolUse');

      guard.cleanupAll();
      expect(guard.canExecute('tool-1', 'PreToolUse')).toBe(true);
      expect(guard.canExecute('tool-2', 'PostToolUse')).toBe(true);
    });
  });
});
