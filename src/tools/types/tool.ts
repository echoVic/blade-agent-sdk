import type { JSONSchema7 } from 'json-schema';
import type { z } from 'zod';
import type { JsonObject, JsonValue } from '../../types/json.js';
import type { PermissionResult } from '../../types/permissions.js';
import type { ExecutionContext } from './execution.js';
import type { ToolBehavior, ToolKind, ToolSideEffect } from './kind.js';
import type { ToolExecution, ToolResult, ToolValidationError } from './result.js';

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: JSONSchema7;
}

export interface ToolInvocation<TParams = unknown> {
  readonly toolName: string;
  readonly params: TParams;

  getDescription(): string;
  getAffectedPaths(): string[];
  validate?(context?: Partial<ExecutionContext>): Promise<ToolValidationError | undefined>;
  execute(signal: AbortSignal, context?: Partial<ExecutionContext>): ToolExecution;
}

export interface ToolDescription {
  short: string;
  long?: string;
  usageNotes?: string[];
  examples?: Array<{
    description: string;
    params: JsonObject;
  }>;
  important?: string[];
}

export type ToolSchema<TSchema extends z.ZodSchema = z.ZodSchema> = TSchema | (() => TSchema);

export type ToolDescriptionResolver<TParams = JsonObject> = (params?: TParams) => ToolDescription;

export type ToolExposureMode = 'eager' | 'deferred' | 'discoverable-only';

export interface ToolExposureConfig {
  mode?: ToolExposureMode;
  alwaysLoad?: boolean;
  discoveryHint?: string;
}

export interface PreparedPermissionMatcher {
  signatureContent?: string;
  abstractRule?: string;
}

export interface ToolDefinition<TParams = JsonObject, TData extends JsonValue = JsonValue> {
  name: string;
  aliases?: string[];
  displayName?: string;
  description: string | ToolDescription;
  /**
   * JSON Schema, or a Zod schema that is converted with the same rules as
   * `createTool`. Passing a Zod schema keeps the declaration close to the
   * parameters the `execute` callback receives.
   */
  parameters: JSONSchema7 | z.ZodSchema;
  /**
   * How a repeated execution behaves. Defaults to `non_idempotent`, so a tool
   * that omits it is never replayed during recovery; declare `pure` or
   * `idempotent` to opt into retryable recovery.
   */
  sideEffect?: ToolSideEffect;
  kind?: ToolKind;
  category?: string;
  tags?: string[];
  exposure?: ToolExposureConfig;
  execute: (params: TParams, context: ExecutionContext) => ToolExecution<TData>;
}

export type ToolDefinitionInput<TParams = JsonObject, TData extends JsonValue = JsonValue> = Omit<
  ToolDefinition<TParams, TData>,
  'execute'
> & {
  execute: (
    params: TParams,
    context: ExecutionContext,
  ) => ToolExecution<TData> | Promise<TData | ToolResult<TData>>;
};

/** Zod authoring path: callback params are inferred directly from the schema. */
export type ZodToolDefinitionInput<
  TSchema extends z.ZodSchema,
  TData extends JsonValue = JsonValue,
> = Omit<ToolDefinitionInput<z.infer<TSchema>, TData>, 'parameters'> & {
  parameters: TSchema;
};

/** JSON Schema authoring path: callers may provide an explicit params type. */
export type JsonSchemaToolDefinitionInput<
  TParams = JsonObject,
  TData extends JsonValue = JsonValue,
> = Omit<ToolDefinitionInput<TParams, TData>, 'parameters'> & {
  parameters: JSONSchema7;
};

/**
 * Type-erased definition for heterogeneous runtime collections.
 *
 * Authoring remains strongly typed; erasure happens only when definitions enter
 * a Session-owned collection and are compiled into runtime Tool instances.
 */
export type ErasedToolDefinition = ToolDefinition<never, JsonValue>;

export interface ToolConfig<TSchema extends z.ZodSchema = z.ZodSchema, TParams = JsonObject> {
  name: string;
  aliases?: string[];
  displayName: string;
  kind: ToolKind;
  sideEffect: ToolSideEffect;
  isReadOnly?: boolean;
  isConcurrencySafe?: boolean;
  isDestructive?: boolean;
  strict?: boolean;
  maxResultSizeChars?: number;
  interruptBehavior?: 'cancel' | 'block';
  schema: ToolSchema<TSchema>;
  description: ToolDescription;
  describe?: ToolDescriptionResolver<TParams>;
  exposure?: ToolExposureConfig;
  execute: (params: TParams, context: ExecutionContext) => ToolExecution;
  validateInput?: (
    params: TParams,
    context: ExecutionContext,
  ) => Promise<undefined | ToolValidationError> | undefined | ToolValidationError;
  checkPermissions?: (
    params: TParams,
    context: ExecutionContext,
  ) => Promise<undefined | PermissionResult> | undefined | PermissionResult;
  resolveBehavior?: (params: TParams) => Partial<ToolBehavior> | ToolBehavior;
  resolveBehaviorHint?: () => Partial<ToolBehavior> | ToolBehavior;
  version?: string;
  category?: string;
  tags?: string[];
  preparePermissionMatcher?: (params: TParams) => PreparedPermissionMatcher;
}

export interface Tool<TParams = unknown> {
  readonly name: string;
  readonly aliases?: string[];
  readonly displayName: string;
  readonly kind: ToolKind;
  readonly sideEffect: ToolSideEffect;
  readonly isReadOnly: boolean;
  readonly isConcurrencySafe: boolean;
  readonly isDestructive?: boolean;
  readonly strict: boolean;
  readonly maxResultSizeChars: number;
  readonly interruptBehavior: 'cancel' | 'block';
  readonly description: ToolDescription;
  readonly exposure: Required<ToolExposureConfig> & {
    mode: ToolExposureMode;
  };
  readonly version: string;
  readonly category?: string;
  readonly tags: string[];

  getFunctionDeclaration(): FunctionDeclaration;
  describe(params?: unknown): ToolDescription;
  getMetadata(): Record<string, unknown>;
  build(params: unknown): ToolInvocation<TParams>;
  execute(params: unknown, context?: ExecutionContext): ToolExecution;

  validateInput?: (
    params: unknown,
    context: ExecutionContext,
  ) => Promise<undefined | ToolValidationError> | undefined | ToolValidationError;
  checkPermissions?: (
    params: unknown,
    context: ExecutionContext,
  ) => Promise<undefined | PermissionResult> | undefined | PermissionResult;
  resolveBehavior?: (params: unknown) => ToolBehavior;
  getBehaviorHint?: () => ToolBehavior;
  preparePermissionMatcher?: (params: unknown) => PreparedPermissionMatcher;
}
