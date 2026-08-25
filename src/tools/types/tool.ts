import type { JSONSchema7 } from 'json-schema';
import type { z } from 'zod';
import type { JsonObject, JsonValue } from '../../types/json.js';
import type { PermissionResult } from '../../types/permissions.js';
import type { ExecutionContext } from './execution.js';
import type { ToolBehavior, ToolKind, ToolSideEffect } from './kind.js';
import type { ToolExecution, ToolValidationError } from './result.js';

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
  parameters: JSONSchema7;
  sideEffect: ToolSideEffect;
  kind?: ToolKind;
  category?: string;
  tags?: string[];
  exposure?: ToolExposureConfig;
  execute: (params: TParams, context: ExecutionContext) => ToolExecution<TData>;
}

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
