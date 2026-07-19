import { describe, expect, it } from 'vitest';
import { combineConfirmationReasons, buildPermissionSignature } from '../local/ConfirmationUtils.js';
import type { ConfirmationReasonEntry } from '../local/ConfirmationUtils.js';

describe('ConfirmationUtils', () => {
  describe('combineConfirmationReasons', () => {
    it('returns undefined for empty entries', () => {
      expect(combineConfirmationReasons([])).toBeUndefined();
    });

    it('joins single entry message', () => {
      const entries: ConfirmationReasonEntry[] = [
        { source: 'tool', message: 'Tool needs approval' },
      ];
      expect(combineConfirmationReasons(entries)).toBe('Tool needs approval');
    });

    it('ranks entries by source priority', () => {
      const entries: ConfirmationReasonEntry[] = [
        { source: 'handler', message: 'handler msg' },
        { source: 'tool', message: 'tool msg' },
        { source: 'rule', message: 'rule msg' },
      ];
      const result = combineConfirmationReasons(entries);
      expect(result).toBe('tool msg\nrule msg\nhandler msg');
    });

    it('deduplicates entries with same source and message', () => {
      const entries: ConfirmationReasonEntry[] = [
        { source: 'tool', message: 'same' },
        { source: 'tool', message: 'same' },
      ];
      expect(combineConfirmationReasons(entries)).toBe('same');
    });

    it('filters empty messages', () => {
      const entries: ConfirmationReasonEntry[] = [
        { source: 'tool', message: '' },
        { source: 'rule', message: 'valid' },
      ];
      expect(combineConfirmationReasons(entries)).toBe('valid');
    });
  });

  describe('buildPermissionSignature', () => {
    it('returns tool name when no matcher provided', () => {
      expect(buildPermissionSignature('read', {})).toBe('read');
    });

    it('returns tool name when matcher has no signatureContent', () => {
      const tool = {
        preparePermissionMatcher: () => ({ allowed: true }),
      };
      expect(buildPermissionSignature('read', {}, tool as any)).toBe('read');
    });

    it('returns toolName:signatureContent when matcher provides it', () => {
      const tool = {
        preparePermissionMatcher: () => ({ signatureContent: 'path/to/file' }),
      };
      expect(buildPermissionSignature('read', { filePath: '/test' }, tool as any)).toBe('read:path/to/file');
    });
  });
});
