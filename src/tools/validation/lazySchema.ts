import type { z } from 'zod';
import type { ToolSchema } from '../types/ToolTypes.js';

export function lazySchema<TSchema extends z.ZodSchema>(
  factory: () => TSchema
): ToolSchema<TSchema> {
  return factory;
}

export function resolveToolSchema<TSchema extends z.ZodSchema>(
  schema: ToolSchema<TSchema>
): TSchema {
  return typeof schema === 'function' ? (schema as () => TSchema)() : schema;
}
