import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { zodToFunctionSchema } from '../zodToJson.js';

describe('zodToJson', () => {
  describe('zodToFunctionSchema', () => {
    it('should convert simple object schema', () => {
      const schema = z.object({
        name: z.string(),
        age: z.number(),
      });
      const result = zodToFunctionSchema(schema);
      expect(result.type).toBe('object');
      expect(result.properties).toBeDefined();
      expect((result.properties as any).name.type).toBe('string');
      expect((result.properties as any).age.type).toBe('number');
    });

    it('should handle optional fields', () => {
      const schema = z.object({
        name: z.string(),
        nickname: z.string().optional(),
      });
      const result = zodToFunctionSchema(schema);
      expect(result.required).toContain('name');
      expect(result.required).not.toContain('nickname');
    });

    it('should handle enum types', () => {
      const schema = z.object({
        role: z.enum(['admin', 'user', 'guest']),
      });
      const result = zodToFunctionSchema(schema);
      const roleSchema = (result.properties as any).role;
      expect(roleSchema.enum).toEqual(['admin', 'user', 'guest']);
    });

    it('should handle array types', () => {
      const schema = z.object({
        tags: z.array(z.string()),
      });
      const result = zodToFunctionSchema(schema);
      const tagsSchema = (result.properties as any).tags;
      expect(tagsSchema.type).toBe('array');
      expect(tagsSchema.items.type).toBe('string');
    });

    it('should handle nested objects', () => {
      const schema = z.object({
        user: z.object({
          name: z.string(),
          address: z.object({
            city: z.string(),
          }),
        }),
      });
      const result = zodToFunctionSchema(schema);
      const userSchema = (result.properties as any).user;
      expect(userSchema.type).toBe('object');
      expect(userSchema.properties.name.type).toBe('string');
      expect(userSchema.properties.address.type).toBe('object');
    });

    it('should handle boolean types', () => {
      const schema = z.object({
        active: z.boolean(),
      });
      const result = zodToFunctionSchema(schema);
      expect((result.properties as any).active.type).toBe('boolean');
    });

    it('should handle descriptions', () => {
      const schema = z.object({
        name: z.string().describe('The user name'),
      });
      const result = zodToFunctionSchema(schema);
      expect((result.properties as any).name.description).toBe('The user name');
    });
  });
});
