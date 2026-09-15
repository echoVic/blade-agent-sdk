import type { JSONSchema7 } from 'json-schema';
import type Type from 'typebox';
import type { JsonObject, JsonValue } from '../../types/json.js';
import type { PermissionResult } from '../../types/permissions.js';
import type { ToolBehavior, ToolKind, ToolSideEffect } from '../behavior.js';
import type { ExecutionContext } from './execution.js';
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

export type ToolSchema<TSchema extends Type.TSchema = Type.TSchema> = TSchema | (() => TSchema);

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

export interface ToolDefinition<
  TSchema extends Type.TSchema = Type.TSchema,
  TData extends JsonValue = JsonValue,
> {
  name: string;
  aliases?: string[];
  displayName?: string;
  description: string | ToolDescription;
  /** TypeBox schema used for both static inference and runtime validation. */
  parameters: TSchema;
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
  execute: (params: Type.Static<TSchema>, context: ExecutionContext) => ToolExecution<TData>;
}

export type ToolDefinitionInput<
  TSchema extends Type.TSchema = Type.TSchema,
  TData extends JsonValue = JsonValue,
> = Omit<ToolDefinition<TSchema, TData>, 'execute'> & {
  execute: (
    params: Type.Static<TSchema>,
    context: ExecutionContext,
  ) => ToolExecution<TData> | Promise<TData | ToolResult<TData>>;
};

/**
 * Type-erased definition for heterogeneous runtime collections.
 *
 * Authoring remains strongly typed; erasure happens only when definitions enter
 * a Session-owned collection and are compiled into runtime Tool instances.
 */
export type ErasedToolDefinition = Omit<ToolDefinition<Type.TSchema, JsonValue>, 'execute'> & {
  execute: (params: never, context: ExecutionContext) => ToolExecution<JsonValue>;
};

export interface ToolConfig<TSchema extends Type.TSchema = Type.TSchema> {
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
  describe?: ToolDescriptionResolver<Type.Static<TSchema>>;
  exposure?: ToolExposureConfig;
  execute: (params: Type.Static<TSchema>, context: ExecutionContext) => ToolExecution;
  validateInput?: (
    params: Type.Static<TSchema>,
    context: ExecutionContext,
  ) => Promise<undefined | ToolValidationError> | undefined | ToolValidationError;
  checkPermissions?: (
    params: Type.Static<TSchema>,
    context: ExecutionContext,
  ) => Promise<undefined | PermissionResult> | undefined | PermissionResult;
  resolveBehavior?: (
    params?: Type.Static<TSchema>,
  ) => Partial<ToolBehavior> | ToolBehavior;
  version?: string;
  category?: string;
  tags?: string[];
  preparePermissionMatcher?: (params: Type.Static<TSchema>) => PreparedPermissionMatcher;
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
  resolveBehavior?: (params?: unknown) => ToolBehavior;
  preparePermissionMatcher?: (params: unknown) => PreparedPermissionMatcher;
}
