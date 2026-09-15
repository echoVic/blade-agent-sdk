import { isAbsolute } from 'node:path';
import Type from 'typebox';

/**
 * Shared TypeBox schemas for built-in tools.
 *
 * These helpers only express types that are visible in the emitted JSON
 * Schema. Runtime-only refinements are limited to constraints, such as absolute
 * paths, that do not change the inferred value type.
 */
export const ToolSchemas = {
  filePath: (options?: { description?: string }) =>
    Type.Refine(
      Type.String({
        minLength: 1,
        description: options?.description || 'Absolute file path',
      }),
      (path) => isAbsolute(path),
      () => 'Path must be absolute',
    ),

  encoding: () =>
    Type.Enum(['utf8', 'base64', 'binary'], {
      default: 'utf8',
      description: 'File encoding',
    }),

  timeout: (min = 1000, max = 300000, defaultValue = 30000) =>
    Type.Integer({
      minimum: min,
      maximum: max,
      default: defaultValue,
      description: `Timeout in milliseconds (default ${defaultValue}ms)`,
    }),

  pattern: (options?: { description?: string }) =>
    Type.String({
      minLength: 1,
      description: options?.description || 'Regex or glob pattern',
    }),

  glob: (options?: { description?: string }) =>
    Type.String({
      minLength: 1,
      description: options?.description || 'Glob pattern (e.g., "*.js", "**/*.ts")',
    }),

  lineNumber: (options?: { min?: number; description?: string }) =>
    Type.Integer({
      minimum: options?.min ?? 0,
      description: options?.description || 'Line number',
    }),

  lineLimit: (options?: { min?: number; max?: number; description?: string }) =>
    Type.Integer({
      minimum: options?.min ?? 1,
      maximum: options?.max ?? 10000,
      description: options?.description || 'Limit on lines to read',
    }),

  workingDirectory: () =>
    Type.Refine(
      Type.String({
        minLength: 1,
        description: 'Absolute working directory',
      }),
      (path) => isAbsolute(path),
      () => 'Path must be absolute',
    ),

  environment: () =>
    Type.Optional(
      Type.Record(Type.String(), Type.String(), {
        description: 'Environment variables (key-value)',
      }),
    ),

  outputMode: <const T extends string>(modes: readonly T[], defaultMode?: T) =>
    Type.Enum(modes, {
      ...(defaultMode === undefined ? {} : { default: defaultMode }),
    }),

  flag: (options?: { defaultValue?: boolean; description?: string }) =>
    Type.Boolean({
      default: options?.defaultValue ?? false,
      description: options?.description || 'Boolean flag',
    }),

  url: (options?: { description?: string }) =>
    Type.String({
      format: 'url',
      description: options?.description || 'URL',
    }),

  port: () =>
    Type.Integer({
      minimum: 1,
      maximum: 65535,
      description: 'Port number',
    }),

  command: (options?: { description?: string }) =>
    Type.String({
      minLength: 1,
      description: options?.description || 'Command to execute',
    }),

  sessionId: () =>
    Type.Optional(
      Type.String({
        minLength: 1,
        format: 'uuid',
        description: 'Session identifier (UUID)',
      }),
    ),

  nonNegativeInt: (options?: { description?: string }) =>
    Type.Integer({
      minimum: 0,
      description: options?.description || 'Non-negative integer',
    }),

  positiveInt: (options?: { description?: string }) =>
    Type.Integer({
      minimum: 1,
      description: options?.description || 'Positive integer',
    }),
};
