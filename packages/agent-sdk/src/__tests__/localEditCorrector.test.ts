import { describe, expect, it } from 'vitest';
import {
  MatchStrategy,
  unescapeString,
  flexibleMatch,
} from '../local/file/editCorrector.js';

describe('package-local editCorrector', () => {
  describe('unescapeString', () => {
    it('unescapes \\\\n to newline', () => {
      expect(unescapeString('line1\\nline2')).toBe('line1\nline2');
    });

    it('unescapes \\\\t to tab', () => {
      expect(unescapeString('col1\\tcol2')).toBe('col1\tcol2');
    });

    it('unescapes \\\\r to carriage return', () => {
      expect(unescapeString('line1\\rline2')).toBe('line1\rline2');
    });

    it('unescapes escaped double quotes', () => {
      expect(unescapeString('say \\"hello\\"')).toBe('say "hello"');
    });

    it('unescapes escaped single quotes', () => {
      expect(unescapeString("say \\'hello\\'")).toBe("say 'hello'");
    });

    it('unescapes escaped backticks', () => {
      expect(unescapeString('\\`template\\`')).toBe('`template`');
    });

    it('unescapes escaped backslash', () => {
      expect(unescapeString('a\\\\b')).toBe('a\\b');
    });

    it('leaves normal strings unchanged', () => {
      expect(unescapeString('hello world')).toBe('hello world');
    });

    it('handles mixed escape sequences', () => {
      expect(unescapeString('line1\\n\\"quoted\\"\\nline2'))
        .toBe('line1\n"quoted"\nline2');
    });
  });

  describe('flexibleMatch', () => {
    it('matches with different indentation (2 vs 4 spaces)', () => {
      const content = '  function foo() {\n    return 1;\n  }';
      const search = '    function foo() {\n      return 1;\n    }';
      const result = flexibleMatch(content, search);
      expect(result).toBe('  function foo() {\n    return 1;\n  }');
    });

    it('returns null for single-line search', () => {
      const result = flexibleMatch('function foo() { return 1; }', 'function foo() { return 1; }');
      expect(result).toBeNull();
    });

    it('returns null when no match found', () => {
      const content = '  function foo() {\n    return 1;\n  }';
      const search = '    function bar() {\n      return 2;\n    }';
      expect(flexibleMatch(content, search)).toBeNull();
    });

    it('returns null when first line has no indentation', () => {
      const content = 'function foo() {\n  return 1;\n}';
      const search = 'function foo() {\n  return 1;\n}';
      expect(flexibleMatch(content, search)).toBeNull();
    });

    it('matches content at different positions', () => {
      const content = 'line1\n  function foo() {\n    return 1;\n  }\nline5';
      const search = '    function foo() {\n      return 1;\n    }';
      const result = flexibleMatch(content, search);
      expect(result).toBe('  function foo() {\n    return 1;\n  }');
    });
  });

  describe('MatchStrategy', () => {
    it('has EXACT strategy', () => {
      expect(MatchStrategy.EXACT).toBeDefined();
    });

    it('has NORMALIZE_QUOTES strategy', () => {
      expect(MatchStrategy.NORMALIZE_QUOTES).toBeDefined();
    });

    it('has UNESCAPE strategy', () => {
      expect(MatchStrategy.UNESCAPE).toBeDefined();
    });

    it('has FLEXIBLE strategy', () => {
      expect(MatchStrategy.FLEXIBLE).toBeDefined();
    });

    it('has FAILED strategy', () => {
      expect(MatchStrategy.FAILED).toBeDefined();
    });
  });
});
