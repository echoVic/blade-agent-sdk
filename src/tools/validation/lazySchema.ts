import type Type from 'typebox';
import type { ToolSchema } from '../types/tool.js';

export function lazySchema<TSchema extends Type.TSchema>(
  factory: () => TSchema,
): ToolSchema<TSchema> {
  return factory;
}

export function resolveToolSchema<TSchema extends Type.TSchema>(
  schema: ToolSchema<TSchema>,
): TSchema {
  return typeof schema === 'function' ? (schema as () => TSchema)() : schema;
}
