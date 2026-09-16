import type { JSONSchema7 } from 'json-schema';
import type Type from 'typebox';
import type { JsonObject, JsonValue } from '../../types/json.js';
import type { PermissionResult } from '../../types/permissions.js';
import type { ToolBehavior, ToolKind, ToolSideEffect } from '../behavior.js';
import type { ToolInvocation } from '../core/ToolInvocation.js';
import type { ToolServiceMap, ToolServiceName } from '../services.js';
import type { ExecutionContext, RuntimeAccess } from './execution.js';
import type { ToolExecution, ToolResult, ToolValidationError } from './result.js';

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: JSONSchema7;
  strict?: boolean;
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

export type BuiltinToolGroup =
  | 'filesystem'
  | 'shell'
  | 'web'
  | 'task'
  | 'memory'
  | 'system'
  | 'mcp-resources';

export interface ToolExposureConfig {
  mode?: ToolExposureMode;
  alwaysLoad?: boolean;
  discoveryHint?: string;
}

export interface PreparedPermissionMatcher {
  signatureContent?: string;
  abstractRule?: string;
}

type ToolDefinitionBaseContext = Pick<
  ExecutionContext,
  | 'signal'
  | 'sessionId'
  | 'messageId'
  | 'contextSnapshot'
  | 'skillActivationPaths'
  | 'permissionMode'
  | 'confirmationHandler'
  | 'bladeConfig'
>;

export type ToolDefinitionContext<
  TServices extends ToolServiceName,
  TRequiresRuntime extends boolean,
> = ToolDefinitionBaseContext &
  Pick<ToolServiceMap, TServices> &
  (TRequiresRuntime extends true ? { runtime: RuntimeAccess } : Record<never, never>);

export interface ToolDefinition<
  TSchema extends Type.TSchema = Type.TSchema,
  TData extends JsonValue = JsonValue,
  TServices extends ToolServiceName = never,
  TRequiresRuntime extends boolean = false,
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
  group?: BuiltinToolGroup;
  exposure?: ToolExposureConfig;
  services?: readonly TServices[];
  requiresRuntime?: TRequiresRuntime;
  execute: (
    params: Type.Static<TSchema>,
    context: ToolDefinitionContext<TServices, TRequiresRuntime>,
  ) => ToolExecution<TData>;
}

export type ToolDefinitionInput<
  TSchema extends Type.TSchema = Type.TSchema,
  TData extends JsonValue = JsonValue,
  TServices extends ToolServiceName = never,
  TRequiresRuntime extends boolean = false,
> = Omit<ToolDefinition<TSchema, TData, TServices, TRequiresRuntime>, 'execute'> & {
  execute: (
    params: Type.Static<TSchema>,
    context: ToolDefinitionContext<TServices, TRequiresRuntime>,
  ) => ToolExecution<TData> | Promise<TData | ToolResult<TData>>;
};

/**
 * Type-erased definition for heterogeneous runtime collections.
 *
 * Authoring remains strongly typed; erasure happens only when definitions enter
 * a Session-owned collection and are compiled into runtime Tool instances.
 */
export type ErasedToolDefinition = Omit<
  ToolDefinition<Type.TSchema, JsonValue, ToolServiceName, boolean>,
  'execute'
> & {
  execute: (params: never, context: never) => ToolExecution<JsonValue>;
};

export interface ToolConfig<
  TSchema extends Type.TSchema = Type.TSchema,
  TServices extends ToolServiceName = never,
  TRequiresRuntime extends boolean = false,
> {
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
  services?: readonly TServices[];
  requiresRuntime?: TRequiresRuntime;
  schema: ToolSchema<TSchema>;
  description: ToolDescription;
  describe?: ToolDescriptionResolver<Type.Static<TSchema>>;
  exposure?: ToolExposureConfig;
  execute: (
    params: Type.Static<TSchema>,
    context: ToolDefinitionContext<TServices, TRequiresRuntime>,
  ) => ToolExecution;
  validateInput?: (
    params: Type.Static<TSchema>,
    context: ExecutionContext,
  ) => Promise<undefined | ToolValidationError> | undefined | ToolValidationError;
  checkPermissions?: (
    params: Type.Static<TSchema>,
    context: ExecutionContext,
  ) => Promise<undefined | PermissionResult> | undefined | PermissionResult;
  resolveBehavior?: (params?: Type.Static<TSchema>) => Partial<ToolBehavior> | ToolBehavior;
  group?: BuiltinToolGroup;
  preparePermissionMatcher?: (params: Type.Static<TSchema>) => PreparedPermissionMatcher;
}

export interface ToolValidationOutcome {
  readonly params: JsonObject;
  readonly error?: ToolValidationError;
}

export interface Tool {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly title: string;
  readonly description: ToolDescription;
  readonly staticBehavior: ToolBehavior;
  readonly declaration: FunctionDeclaration;
  readonly maxResultSizeChars: number;
  readonly services: readonly ToolServiceName[];
  readonly requiresRuntime: boolean;
  readonly group?: BuiltinToolGroup;
  readonly exposure: Required<ToolExposureConfig> & {
    mode: ToolExposureMode;
  };

  readonly prepare: (raw: unknown) => ToolInvocation;
  readonly execute: (params: JsonObject, context?: ExecutionContext) => ToolExecution;
  readonly validate?: (
    params: JsonObject,
    context: ExecutionContext,
  ) => Promise<ToolValidationOutcome>;
  readonly checkPermissions?: (
    params: JsonObject,
    context: ExecutionContext,
  ) => Promise<undefined | PermissionResult> | undefined | PermissionResult;
}
