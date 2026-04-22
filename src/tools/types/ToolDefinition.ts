import type { JSONSchema7 } from 'json-schema';
import type { z } from 'zod';
import type { JsonObject } from '../../types/common.js';
import type { PermissionResult } from '../../types/permissions.js';
import type { ExecutionContext } from './ExecutionTypes.js';
import type { ToolBehavior, ToolKind } from './ToolKind.js';
import type { ToolResult, ToolValidationError } from './ToolResult.js';

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: JSONSchema7;
}

export interface ToolInvocation<TParams = JsonObject, TResult = ToolResult> {
  readonly toolName: string;
  readonly params: TParams;

  getDescription(): string;
  getAffectedPaths(): string[];
  validate?(context?: Partial<ExecutionContext>): Promise<ToolValidationError | undefined>;
  execute(
    signal: AbortSignal,
    updateOutput?: (output: string) => void,
    context?: Partial<ExecutionContext>,
  ): Promise<TResult>;
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

export interface ToolDefinition<TParams = JsonObject> {
  name: string;
  aliases?: string[];
  displayName?: string;
  description: string | ToolDescription;
  parameters: JSONSchema7;
  kind?: ToolKind;
  category?: string;
  tags?: string[];
  exposure?: ToolExposureConfig;
  execute: (params: TParams, context: ExecutionContext) => Promise<ToolResult>;
}

export interface ToolConfig<TSchema extends z.ZodSchema = z.ZodSchema, TParams = JsonObject> {
  name: string;
  aliases?: string[];
  displayName: string;
  kind: ToolKind;
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
  execute: (params: TParams, context: ExecutionContext) => Promise<ToolResult>;
  validateInput?: (
    params: TParams,
    context: ExecutionContext,
  ) => Promise<void | ToolValidationError> | void | ToolValidationError;
  checkPermissions?: (
    params: TParams,
    context: ExecutionContext,
  ) => Promise<void | PermissionResult> | void | PermissionResult;
  resolveBehavior?: (params: TParams) => Partial<ToolBehavior> | ToolBehavior;
  resolveBehaviorHint?: () => Partial<ToolBehavior> | ToolBehavior;
  version?: string;
  category?: string;
  tags?: string[];
  preparePermissionMatcher?: (params: TParams) => PreparedPermissionMatcher;
}

export interface Tool<TParams = JsonObject> {
  readonly name: string;
  readonly aliases?: string[];
  readonly displayName: string;
  readonly kind: ToolKind;
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
  describe(params?: TParams): ToolDescription;
  getMetadata(): Record<string, unknown>;
  build(params: TParams): ToolInvocation<TParams>;
  execute(params: TParams, signal?: AbortSignal): Promise<ToolResult>;

  validateInput?: (
    params: TParams,
    context: ExecutionContext,
  ) => Promise<void | ToolValidationError> | void | ToolValidationError;
  checkPermissions?: (
    params: TParams,
    context: ExecutionContext,
  ) => Promise<void | PermissionResult> | void | PermissionResult;
  resolveBehavior?: (params: TParams) => ToolBehavior;
  getBehaviorHint?: () => ToolBehavior;
  preparePermissionMatcher?: (params: TParams) => PreparedPermissionMatcher;
}
