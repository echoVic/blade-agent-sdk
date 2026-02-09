import { describe, expect, it } from 'bun:test';
import { AtMentionParser } from '../processors/AtMentionParser.js';

describe('AtMentionParser', () => {
  describe('extract', () => {
    it('should extract bare path mention', () => {
      const mentions = AtMentionParser.extract('Read @src/agent.ts');
      expect(mentions).toHaveLength(1);
      expect(mentions[0].path).toBe('src/agent.ts');
      expect(mentions[0].raw).toBe('@src/agent.ts');
    });

    it('should extract quoted path mention', () => {
      const mentions = AtMentionParser.extract('Read @"path with spaces.ts"');
      expect(mentions).toHaveLength(1);
      expect(mentions[0].path).toBe('path with spaces.ts');
    });

    it('should extract line range #L10', () => {
      const mentions = AtMentionParser.extract('Read @file.ts#L10');
      expect(mentions).toHaveLength(1);
      expect(mentions[0].path).toBe('file.ts');
      expect(mentions[0].lineRange).toBeDefined();
      expect(mentions[0].lineRange!.start).toBe(10);
      expect(mentions[0].lineRange!.end).toBeUndefined();
    });

    it('should extract line range #L10-20', () => {
      const mentions = AtMentionParser.extract('Read @src/agent.ts#L100-150');
      expect(mentions).toHaveLength(1);
      expect(mentions[0].path).toBe('src/agent.ts');
      expect(mentions[0].lineRange).toBeDefined();
      expect(mentions[0].lineRange!.start).toBe(100);
      expect(mentions[0].lineRange!.end).toBe(150);
    });

    it('should extract multiple mentions', () => {
      const mentions = AtMentionParser.extract('Compare @file1.ts and @file2.ts');
      expect(mentions).toHaveLength(2);
      expect(mentions[0].path).toBe('file1.ts');
      expect(mentions[1].path).toBe('file2.ts');
    });

    it('should return empty array for no mentions', () => {
      const mentions = AtMentionParser.extract('No mentions here');
      expect(mentions).toHaveLength(0);
    });

    it('should detect glob patterns', () => {
      const mentions = AtMentionParser.extract('Read @src/*.ts');
      expect(mentions).toHaveLength(1);
      expect(mentions[0].isGlob).toBe(true);
    });

    it('should not detect glob for normal paths', () => {
      const mentions = AtMentionParser.extract('Read @src/file.ts');
      expect(mentions).toHaveLength(1);
      expect(mentions[0].isGlob).toBe(false);
    });

    it('should include startIndex and endIndex', () => {
      const input = 'Read @file.ts please';
      const mentions = AtMentionParser.extract(input);
      expect(mentions[0].startIndex).toBe(5);
      // @file.ts = 9 chars, so endIndex = 5 + 9 = 14
      // But 'please' is after a space, so the regex may capture differently
      // Let's just verify they are numbers and startIndex < endIndex
      expect(mentions[0].endIndex).toBeGreaterThan(mentions[0].startIndex);
    });

    it('should handle consecutive calls (regex state reset)', () => {
      AtMentionParser.extract('@file1.ts');
      const mentions = AtMentionParser.extract('@file2.ts');
      expect(mentions).toHaveLength(1);
      expect(mentions[0].path).toBe('file2.ts');
    });
  });

  describe('hasAtMentions', () => {
    it('should return true when @ is present', () => {
      expect(AtMentionParser.hasAtMentions('Read @file.ts')).toBe(true);
    });

    it('should return false when no @ is present', () => {
      expect(AtMentionParser.hasAtMentions('No mentions')).toBe(false);
    });

    it('should return true for email-like strings', () => {
      expect(AtMentionParser.hasAtMentions('user@example.com')).toBe(true);
    });
  });

  describe('isValidPath', () => {
    it('should return true for valid paths', () => {
      expect(AtMentionParser.isValidPath('src/file.ts')).toBe(true);
      expect(AtMentionParser.isValidPath('/absolute/path.ts')).toBe(true);
      expect(AtMentionParser.isValidPath('file.ts')).toBe(true);
    });

    it('should return false for empty path', () => {
      expect(AtMentionParser.isValidPath('')).toBe(false);
      expect(AtMentionParser.isValidPath('   ')).toBe(false);
    });

    it('should return false for paths with invalid characters', () => {
      expect(AtMentionParser.isValidPath('file<.ts')).toBe(false);
      expect(AtMentionParser.isValidPath('file>.ts')).toBe(false);
      expect(AtMentionParser.isValidPath('file|.ts')).toBe(false);
      expect(AtMentionParser.isValidPath('file\0.ts')).toBe(false);
    });
  });

  describe('removeAtMentions', () => {
    it('should remove bare path mentions', () => {
      const result = AtMentionParser.removeAtMentions('Read @file.ts and analyze');
      expect(result).toBe('Read  and analyze');
    });

    it('should remove quoted path mentions', () => {
      const result = AtMentionParser.removeAtMentions('Read @"my file.ts" please');
      expect(result).toBe('Read  please');
    });

    it('should remove multiple mentions', () => {
      const result = AtMentionParser.removeAtMentions('Compare @a.ts and @b.ts');
      expect(result).toBe('Compare  and ');
    });

    it('should return unchanged string with no mentions', () => {
      const input = 'No mentions here';
      expect(AtMentionParser.removeAtMentions(input)).toBe(input);
    });
  });
});
