import { describe, expect, it } from 'vitest';
import { ToolSchemas } from '../zodSchemas.js';

describe('ToolSchemas', () => {
  describe('semanticBoolean', () => {
    it('accepts boolean-like strings', () => {
      const schema = ToolSchemas.semanticBoolean();

      expect(schema.parse(true)).toBe(true);
      expect(schema.parse('true')).toBe(true);
      expect(schema.parse('TRUE')).toBe(true);
      expect(schema.parse('1')).toBe(true);
      expect(schema.parse('yes')).toBe(true);
      expect(schema.parse(false)).toBe(false);
      expect(schema.parse('false')).toBe(false);
      expect(schema.parse('0')).toBe(false);
      expect(schema.parse('No')).toBe(false);
    });

    it('rejects unrelated strings', () => {
      const schema = ToolSchemas.semanticBoolean();

      expect(() => schema.parse('maybe')).toThrow();
    });
  });

  describe('semanticNumber', () => {
    it('accepts number-like strings', () => {
      const schema = ToolSchemas.semanticNumber();

      expect(schema.parse(42)).toBe(42);
      expect(schema.parse('42')).toBe(42);
      expect(schema.parse('3.14')).toBe(3.14);
      expect(schema.parse('-7')).toBe(-7);
    });

    it('rejects non-numeric strings', () => {
      const schema = ToolSchemas.semanticNumber();

      expect(() => schema.parse('abc')).toThrow();
    });
  });

  describe('derived schemas', () => {
    it('coerces timeout from string input', () => {
      expect(ToolSchemas.timeout().parse('1500')).toBe(1500);
    });

    it('coerces flags from string input', () => {
      expect(ToolSchemas.flag().parse('true')).toBe(true);
      expect(ToolSchemas.flag().parse('false')).toBe(false);
    });

    it('coerces positive integers from string input', () => {
      expect(ToolSchemas.positiveInt().parse('5')).toBe(5);
      expect(() => ToolSchemas.positiveInt().parse('0')).toThrow();
    });
  });
});
