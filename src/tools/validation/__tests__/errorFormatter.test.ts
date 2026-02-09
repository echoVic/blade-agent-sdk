import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { parseWithZod } from '../errorFormatter.js';

describe('errorFormatter', () => {
  describe('parseWithZod', () => {
    const schema = z.object({
      name: z.string().min(2),
      age: z.number().min(0).max(150),
      email: z.string().email().optional(),
    });

    it('should parse valid data successfully', () => {
      const data = { name: 'Alice', age: 30 };
      const result = parseWithZod(schema, data);
      expect(result.name).toBe('Alice');
      expect(result.age).toBe(30);
    });

    it('should throw on invalid_type error', () => {
      expect(() => {
        parseWithZod(schema, { name: 123, age: 30 });
      }).toThrow();
    });

    it('should throw on too_small error (string min length)', () => {
      expect(() => {
        parseWithZod(schema, { name: 'A', age: 30 });
      }).toThrow();
    });

    it('should throw on too_small error (number min)', () => {
      expect(() => {
        parseWithZod(schema, { name: 'Alice', age: -1 });
      }).toThrow();
    });

    it('should throw on too_big error (number max)', () => {
      expect(() => {
        parseWithZod(schema, { name: 'Alice', age: 200 });
      }).toThrow();
    });

    it('should throw on invalid_string error (email)', () => {
      expect(() => {
        parseWithZod(schema, { name: 'Alice', age: 30, email: 'not-an-email' });
      }).toThrow();
    });

    it('should throw on invalid_enum_value error', () => {
      const enumSchema = z.object({
        role: z.enum(['admin', 'user', 'guest']),
      });
      expect(() => {
        parseWithZod(enumSchema, { role: 'superadmin' });
      }).toThrow();
    });

    it('should throw ToolValidationError with issues array', () => {
      try {
        parseWithZod(schema, { name: 123, age: 'not-a-number' });
        expect(true).toBe(false); // should not reach here
      } catch (error: any) {
        expect(error.name).toBe('ToolValidationError');
        expect(error.issues).toBeDefined();
        expect(error.issues.length).toBeGreaterThanOrEqual(2);
      }
    });

    it('should format single error message correctly', () => {
      try {
        parseWithZod(schema, { name: 'Alice', age: 'not-a-number' });
      } catch (error: any) {
        expect(error.message).toContain('参数验证失败');
      }
    });

    it('should format multiple errors message correctly', () => {
      try {
        parseWithZod(schema, { name: 123, age: 'not-a-number' });
      } catch (error: any) {
        expect(error.message).toContain('参数验证失败');
        expect(error.message).toContain('2 个错误');
      }
    });

    it('should handle unrecognized_keys with strict schema', () => {
      const strictSchema = z.object({ name: z.string() }).strict();
      expect(() => {
        parseWithZod(strictSchema, { name: 'Alice', extra: 'field' });
      }).toThrow();
    });
  });
});
