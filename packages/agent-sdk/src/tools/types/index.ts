import type { z } from 'zod';
import type {
  AgentToolExecutionOutcome,
  AgentToolExecutionUpdate,
  AgentToolExecutionUpdatePayloads,
} from '@blade-ai/agent/loop';
import type { ContextSnapshot, RuntimeContextPatch, RuntimePatch } from '../../runtime/types.js';
import type { SessionMessage } from '../../session/types.js';
import type {
  JsonObject,
  JsonValue,
  McpServerConfig,
  ModelConfig,
  PermissionMode,
  PermissionsConfig,
} from '../../types/common.js';
import type { PermissionResult, PermissionUpdate } from '../../types/permissions.js';
import type { ToolBehavior, ToolKind } from './ToolKind.js';

export type { ToolBehavior } from './ToolKind.js';

type JsonSchemaPrimitiveType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'array'
  | 'object'
  | 'null';

export interface JsonSchemaProperty {
  type?: JsonSchemaPrimitiveType | JsonSchemaPrimitiveType[];
  description?: string;
  enum?: JsonValue[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaProperty;
  default?: JsonValue;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
}

export interface JsonSchemaObject extends JsonSchemaProperty {
  type: 'object';
  properties?: Record<string, JsonSchemaProperty>;
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
}

export interface QuestionOption {
  label: string;
  description: string;
}

export interface Question {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

export interface ConfirmationDetails {
  type?: 'permission' | 'enterPlanMode' | 'exitPlanMode' | 'maxTurnsExceeded' | 'askUserQuestion';
  kind?: ToolKind;
  toolName?: string;
  args?: JsonObject;
  title?: string;
  message: string;
  details?: string;
  risks?: string[];
  affectedFiles?: string[];
  planContent?: string;
  questions?: Question[];
}

export type PermissionApprovalScope = 'once' | 'session';

export interface ConfirmationResponse {
  approved: boolean;
  reason?: string;
  scope?: PermissionApprovalScope;
  targetMode?: PermissionMode;
  feedback?: string;
  answers?: Record<string, string | string[]>;
}

export interface ConfirmationHandler {
  requestConfirmation(details: ConfirmationDetails): Promise<ConfirmationResponse>;
}

export interface BladeConfig {
  models: ModelConfig[];
  currentModelId?: string;
  mcpServers?: Record<string, McpServerConfig>;
  inProcessMcpServerNames?: string[];
  permissions?: PermissionsConfig;
  theme?: string;
  language?: string;
  debug?: boolean | string;
  temperature?: number;
  maxTurns?: number;
  plansDirectory?: string;
  storageRoot?: string;
}

export interface ExecutionContext {
  userId?: string;
  sessionId?: string;
  messageId?: string;
  contextSnapshot?: ContextSnapshot;
  skillActivationPaths?: string[];
  signal?: AbortSignal;
  onProgress?: (message: string) => void | Promise<void>;
  updateOutput?: (output: string) => void | Promise<void>;
  confirmationHandler?: ConfirmationHandler;
  permissionMode?: PermissionMode;
  bladeConfig?: BladeConfig;
  backgroundAgentManager?: unknown;
  toolRegistry?: unknown;
  toolCatalog?: unknown;
  discoveredTools?: string[];
}

export interface ToolResultMetadata {
  summary?: string;
  shouldExitLoop?: boolean;
  targetMode?: PermissionMode;
  modelId?: string;
  model?: string;
  [key: string]: unknown;
}

export interface ToolError {
  message: string;
  type: ToolErrorType;
  code?: string;
  details?: unknown;
}

export enum ToolErrorType {
  VALIDATION_ERROR = 'validation_error',
  PERMISSION_DENIED = 'permission_denied',
  EXECUTION_ERROR = 'execution_error',
  TIMEOUT_ERROR = 'timeout_error',
  NETWORK_ERROR = 'network_error',
}

export interface ToolValidationError {
  message: string;
  llmContent?: string | object;
  metadata?: ToolResultMetadata;
  errorType?: ToolError['type'];
}

export type ToolEffect =
  | {
      type: 'runtimePatch';
      patch: RuntimePatch;
    }
  | {
      type: 'contextPatch';
      patch: RuntimeContextPatch;
    }
  | {
      type: 'newMessages';
      messages: SessionMessage[];
    }
  | {
      type: 'permissionUpdates';
      updates: PermissionUpdate[];
    };

interface ToolResultBase<TMetadata extends ToolResultMetadata = ToolResultMetadata> {
  llmContent: string | object;
  metadata?: TMetadata;
  effects?: ToolEffect[];
  runtimePatch?: RuntimePatch;
  contextPatch?: RuntimeContextPatch;
  newMessages?: SessionMessage[];
}

export interface ToolSuccessResult<
  TData = JsonValue,
  TMetadata extends ToolResultMetadata = ToolResultMetadata,
> extends ToolResultBase<TMetadata> {
  success: true;
  data?: TData;
  error?: undefined;
}

export interface ToolFailureResult<TMetadata extends ToolResultMetadata = ToolResultMetadata>
  extends ToolResultBase<TMetadata> {
  success: false;
  data?: undefined;
  error: ToolError;
}

export type ToolResult<
  TData = JsonValue,
  TMetadata extends ToolResultMetadata = ToolResultMetadata,
> = ToolSuccessResult<TData, TMetadata> | ToolFailureResult<TMetadata>;

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

export interface ToolDefinition<TParams = JsonObject, TData extends JsonValue = JsonValue> {
  name: string;
  aliases?: string[];
  displayName?: string;
  description: string | ToolDescription;
  parameters: JsonSchemaObject;
  kind?: ToolKind;
  category?: string;
  tags?: string[];
  exposure?: ToolExposureConfig;
  execute: (params: TParams, context: ExecutionContext) => Promise<ToolResult<TData>>;
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

export interface Tool<TParams = JsonObject> {
  name: string;
  aliases?: string[];
  displayName?: string;
  kind: ToolKind;
  isReadOnly: boolean;
  isConcurrencySafe: boolean;
  isDestructive?: boolean;
  strict?: boolean;
  maxResultSizeChars?: number;
  interruptBehavior?: 'cancel' | 'block';
  description: ToolDescription;
  exposure?: Required<ToolExposureConfig>;
  version?: string;
  category?: string;
  tags: string[];
  describe(params?: TParams): ToolDescription;
  getFunctionDeclaration(): FunctionDeclaration;
  getMetadata(): {
    name: string;
    displayName?: string;
    kind: ToolKind;
    version: string;
    category?: string;
    tags: string[];
    description: ToolDescription;
    schema: JsonSchemaObject | JsonObject;
  };
  build(params: TParams): ToolInvocation<TParams>;
  execute(params: TParams, signal?: AbortSignal): Promise<ToolResult>;
  validateInput?(
    params: TParams,
    context: ExecutionContext,
  ): Promise<undefined | ToolValidationError> | undefined | ToolValidationError;
  checkPermissions?(
    params: TParams,
    context: ExecutionContext,
  ): Promise<undefined | PermissionResult> | undefined | PermissionResult;
  getBehaviorHint?(): Partial<ToolBehavior> | ToolBehavior;
  resolveBehavior?(params: TParams): Partial<ToolBehavior> | ToolBehavior;
  preparePermissionMatcher?(params: TParams): PreparedPermissionMatcher;
}

export interface FunctionToolCall {
  id?: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface SdkToolExecutionUpdatePayloads extends AgentToolExecutionUpdatePayloads {
  params: JsonObject;
  runtimePatch: Extract<ToolEffect, { type: 'runtimePatch' }>['patch'];
  contextPatch: Extract<ToolEffect, { type: 'contextPatch' }>['patch'];
  newMessages: Extract<ToolEffect, { type: 'newMessages' }>['messages'];
  permissionUpdates: Extract<ToolEffect, { type: 'permissionUpdates' }>['updates'];
}

export interface ToolExecutionOutcome
  extends AgentToolExecutionOutcome<FunctionToolCall, ToolResult> {}

export type ToolExecutionOutcomeOf<TToolCall extends FunctionToolCall> =
  AgentToolExecutionOutcome<TToolCall, ToolResult>;

export type ToolExecutionUpdate = AgentToolExecutionUpdate<
  FunctionToolCall,
  ToolResult,
  SdkToolExecutionUpdatePayloads,
  ToolExecutionOutcome
>;

export type ToolExecutionUpdateOf<TToolCall extends FunctionToolCall> = AgentToolExecutionUpdate<
  TToolCall,
  ToolResult,
  SdkToolExecutionUpdatePayloads,
  ToolExecutionOutcomeOf<TToolCall>
>;
