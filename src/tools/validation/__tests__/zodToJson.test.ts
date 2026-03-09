import { describe, expect, it } from 'bun:test';
import type { JSONSchema7, JSONSchema7Definition } from 'json-schema';
import { z } from 'zod';
import { zodToFunctionSchema } from '../zodToJson.js';

function getObjectProperties(result: JSONSchema7): Record<string, JSONSchema7> {
  return result.properties as Record<string, JSONSchema7>;
}

function asObjectSchema(schema: JSONSchema7Definition | undefined): JSONSchema7 {
  if (!schema || typeof schema === 'boolean') {
    throw new Error('Expected object schema definition');
  }
  return schema;
}

function getArrayItemSchema(schema: JSONSchema7): JSONSchema7 {
  if (!schema.items || Array.isArray(schema.items) || typeof schema.items === 'boolean') {
    throw new Error('Expected array item schema');
  }
  return schema.items;
}

describe('zodToJson', () => {
  describe('zodToFunctionSchema', () => {
    it('should convert simple object schema', () => {
      const schema = z.object({
        name: z.string(),
        age: z.number(),
      });
      const result = zodToFunctionSchema(schema);
      const properties = getObjectProperties(result);
      expect(result.type).toBe('object');
      expect(result.properties).toBeDefined();
      expect(properties.name.type).toBe('string');
      expect(properties.age.type).toBe('number');
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
      const roleSchema = getObjectProperties(result).role;
      expect(roleSchema.enum).toEqual(['admin', 'user', 'guest']);
    });

    it('should handle array types', () => {
      const schema = z.object({
        tags: z.array(z.string()),
      });
      const result = zodToFunctionSchema(schema);
      const tagsSchema = asObjectSchema(getObjectProperties(result).tags);
      expect(tagsSchema.type).toBe('array');
      expect(getArrayItemSchema(tagsSchema).type).toBe('string');
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
      const userSchema = asObjectSchema(getObjectProperties(result).user);
      const userProperties = getObjectProperties(userSchema);
      const addressSchema = asObjectSchema(userProperties.address);
      expect(userSchema.type).toBe('object');
      expect(asObjectSchema(userProperties.name).type).toBe('string');
      expect(addressSchema.type).toBe('object');
    });

    it('should handle boolean types', () => {
      const schema = z.object({
        active: z.boolean(),
      });
      const result = zodToFunctionSchema(schema);
      expect(getObjectProperties(result).active.type).toBe('boolean');
    });

    it('should handle descriptions', () => {
      const schema = z.object({
        name: z.string().describe('The user name'),
      });
      const result = zodToFunctionSchema(schema);
      expect(getObjectProperties(result).name.description).toBe('The user name');
    });
  });
});
