import { describe, expect, it } from 'vitest';
import { compileToolInput } from '../toolInput.js';
import { ToolSchemas } from '../toolSchemas.js';

describe('ToolSchemas', () => {
  describe('derived schemas', () => {
    it('declares timeout bounds and a default', () => {
      expect(ToolSchemas.timeout()).toMatchObject({
        type: 'integer',
        minimum: 1000,
        maximum: 300000,
        default: 30000,
      });
    });

    it('declares flag defaults', () => {
      expect(ToolSchemas.flag()).toMatchObject({
        type: 'boolean',
        default: false,
      });
    });

    it('declares positive integer bounds', () => {
      const input = compileToolInput(ToolSchemas.positiveInt());

      expect(input.parse(5)).toBe(5);
      expect(() => input.parse(0)).toThrow();
    });
  });
});
