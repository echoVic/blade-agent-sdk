import { describe, expect, it } from 'bun:test';
import {
  MatchStrategy,
  unescapeString,
  flexibleMatch,
} from '../editCorrector.js';

describe('editCorrector', () => {
  describe('unescapeString', () => {
    it('should unescape \\n to newline', () => {
      expect(unescapeString('line1\\nline2')).toBe('line1\nline2');
    });

    it('should unescape \\t to tab', () => {
      expect(unescapeString('col1\\tcol2')).toBe('col1\tcol2');
    });

    it('should unescape \\r to carriage return', () => {
      expect(unescapeString('line1\\rline2')).toBe('line1\rline2');
    });

    it('should unescape escaped double quotes', () => {
      expect(unescapeString('say \\"hello\\"')).toBe('say "hello"');
    });

    it('should unescape escaped single quotes', () => {
      expect(unescapeString("say \\'hello\\'")).toBe("say 'hello'");
    });

    it('should unescape escaped backticks', () => {
      expect(unescapeString('\\`template\\`')).toBe('`template`');
    });

    it('should unescape escaped backslash', () => {
      // 'path\\\\\\\\to' in source = path\\\\to as string = two backslashes followed by 'to'
      // unescapeString sees \\ and converts to single \
      expect(unescapeString('a\\\\b')).toBe('a\\b');
    });

    it('should leave normal strings unchanged', () => {
      expect(unescapeString('hello world')).toBe('hello world');
    });
  });

  describe('flexibleMatch', () => {
    it('should match with different indentation (2 vs 4 spaces)', () => {
      const content = '  function foo() {\n    return 1;\n  }';
      const search = '    function foo() {\n      return 1;\n    }';
      const result = flexibleMatch(content, search);
      expect(result).toBe('  function foo() {\n    return 1;\n  }');
    });

    it('should return null for single-line search', () => {
      const content = 'function foo() { return 1; }';
      const search = 'function foo() { return 1; }';
      expect(flexibleMatch(content, search)).toBeNull();
    });

    it('should return null when no match found', () => {
      const content = '  function foo() {\n    return 1;\n  }';
      const search = '    function bar() {\n      return 2;\n    }';
      expect(flexibleMatch(content, search)).toBeNull();
    });

    it('should return null when first line has no indentation', () => {
      const content = 'function foo() {\n  return 1;\n}';
      const search = 'function foo() {\n  return 1;\n}';
      expect(flexibleMatch(content, search)).toBeNull();
    });

    it('should match content at different positions', () => {
      const content = 'line1\n  function foo() {\n    return 1;\n  }\nline5';
      const search = '    function foo() {\n      return 1;\n    }';
      const result = flexibleMatch(content, search);
      expect(result).toBe('  function foo() {\n    return 1;\n  }');
    });
  });

  describe('MatchStrategy', () => {
    it('should have EXACT strategy', () => {
      expect(MatchStrategy.EXACT).toBe(MatchStrategy.EXACT);
    });

    it('should have NORMALIZE_QUOTES strategy', () => {
      expect(MatchStrategy.NORMALIZE_QUOTES).toBe(MatchStrategy.NORMALIZE_QUOTES);
    });

    it('should have UNESCAPE strategy', () => {
      expect(MatchStrategy.UNESCAPE).toBe(MatchStrategy.UNESCAPE);
    });

    it('should have FLEXIBLE strategy', () => {
      expect(MatchStrategy.FLEXIBLE).toBe(MatchStrategy.FLEXIBLE);
    });

    it('should have FAILED strategy', () => {
      expect(MatchStrategy.FAILED).toBe(MatchStrategy.FAILED);
    });
  });
});
