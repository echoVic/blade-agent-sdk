import { isAbsolute } from 'path';
import { z } from 'zod';

const BOOLEAN_LITERALS: Record<string, boolean> = {
  'true': true,
  '1': true,
  'yes': true,
  'y': true,
  'on': true,
  'false': false,
  '0': false,
  'no': false,
  'n': false,
  'off': false,
};

function normalizeBooleanString(value: string): boolean | undefined {
  return BOOLEAN_LITERALS[value.trim().toLowerCase()];
}

function isNumericString(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value.trim());
}

/**
 * Common Zod schema utilities
 */
export const ToolSchemas = {
  /**
   * Semantic boolean schema tolerant of common string encodings emitted by LLMs.
   */
  semanticBoolean: () =>
    z.union([
      z.boolean(),
      z.string().transform((value, ctx) => {
        const normalized = normalizeBooleanString(value);
        if (normalized === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Must be a boolean-like value',
          });
          return z.NEVER;
        }
        return normalized;
      }),
    ]),

  /**
   * Semantic number schema tolerant of common numeric strings emitted by LLMs.
   */
  semanticNumber: () =>
    z.union([
      z.number(),
      z.string().transform((value, ctx) => {
        if (!isNumericString(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Must be a numeric value',
          });
          return z.NEVER;
        }
        return Number(value);
      }),
    ]),

  /**
   * File path schema (must be absolute)
   */
  filePath: (options?: { description?: string }) =>
    z
      .string()
      .min(1, 'File path is required')
      .refine((path) => isAbsolute(path), {
        message: 'Path must be absolute',
      })
      .describe(options?.description || 'Absolute file path'),

  /**
   * File encoding schema
   */
  encoding: () =>
    z.enum(['utf8', 'base64', 'binary']).default('utf8').describe('File encoding'),

  /**
   * Timeout schema
   */
  timeout: (min = 1000, max = 300000, defaultValue = 30000) =>
    ToolSchemas.semanticNumber()
      .pipe(
        z
          .number()
          .int('Must be an integer')
          .min(min, `Cannot be less than ${min}ms`)
          .max(max, `Cannot exceed ${max}ms`)
      )
      .default(defaultValue)
      .describe(`Timeout in milliseconds (default ${defaultValue}ms)`),

  /**
   * Regex pattern schema
   */
  pattern: (options?: { description?: string }) =>
    z
      .string()
      .min(1, 'Pattern is required')
      .describe(options?.description || 'Regex or glob pattern'),

  /**
   * Glob pattern schema
   */
  glob: (options?: { description?: string }) =>
    z
      .string()
      .min(1, 'Glob pattern is required')
      .describe(options?.description || 'Glob pattern (e.g., "*.js", "**/*.ts")'),

  /**
   * Line number schema
   */
  lineNumber: (options?: { min?: number; description?: string }) =>
    ToolSchemas.semanticNumber()
      .pipe(
        z
          .number()
          .int('Line number must be an integer')
          .min(options?.min ?? 0, `Line number cannot be less than ${options?.min ?? 0}`)
      )
      .describe(options?.description || 'Line number'),

  /**
   * Line limit schema
   */
  lineLimit: (options?: { min?: number; max?: number; description?: string }) =>
    ToolSchemas.semanticNumber()
      .pipe(
        z
          .number()
          .int('Line count must be an integer')
          .min(options?.min ?? 1, `Line count cannot be less than ${options?.min ?? 1}`)
          .max(options?.max ?? 10000, `Line count cannot exceed ${options?.max ?? 10000}`)
      )
      .describe(options?.description || 'Limit on lines to read'),

  /**
   * Working directory schema
   */
  workingDirectory: () =>
    z
      .string()
      .min(1, 'Working directory is required')
      .refine((path) => isAbsolute(path), {
        message: 'Path must be absolute',
      })
      .describe('Absolute working directory'),

  /**
   * Environment variables schema
   */
  environment: () =>
    z
      .record(z.string(), z.string())
      .describe('Environment variables (key-value)')
      .optional(),

  /**
   * 输出模式 Schema
   */
  outputMode: <T extends string>(modes: readonly T[], defaultMode?: T) => {
    const schema = z.enum(modes as [T, ...T[]]);
    return defaultMode ? schema.default(defaultMode) : schema;
  },

  /**
   * Boolean flag schema
   */
  flag: (options?: { defaultValue?: boolean; description?: string }) =>
    ToolSchemas.semanticBoolean()
      .default(options?.defaultValue ?? false)
      .describe(options?.description || 'Boolean flag'),

  /**
   * URL schema
   */
  url: (options?: { description?: string }) =>
    z
      .string()
      .url('Must be a valid URL')
      .describe(options?.description || 'URL'),

  /**
   * Port schema
   */
  port: () =>
    ToolSchemas.semanticNumber()
      .pipe(
        z
          .number()
          .int('Port must be an integer')
          .min(1, 'Port cannot be less than 1')
          .max(65535, 'Port cannot exceed 65535')
      )
      .describe('Port number'),

  /**
   * Command string schema
   */
  command: (options?: { description?: string }) =>
    z
      .string()
      .min(1, 'Command is required')
      .describe(options?.description || 'Command to execute'),

  /**
   * Session ID schema
   */
  sessionId: () =>
    z
      .string()
      .min(1, 'Session ID is required')
      .uuid('Must be a valid UUID')
      .optional()
      .describe('Session identifier (UUID)'),

  /**
   * Non-negative integer schema
   */
  nonNegativeInt: (options?: { description?: string }) =>
    ToolSchemas.semanticNumber()
      .pipe(
        z
          .number()
          .int('Must be an integer')
          .min(0, 'Cannot be negative')
      )
      .describe(options?.description || 'Non-negative integer'),

  /**
   * Positive integer schema
   */
  positiveInt: (options?: { description?: string }) =>
    ToolSchemas.semanticNumber()
      .pipe(
        z
          .number()
          .int('Must be an integer')
          .min(1, 'Must be greater than 0')
      )
      .describe(options?.description || 'Positive integer'),
};
