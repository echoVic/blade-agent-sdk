import type { JSONSchema7 } from 'json-schema';
import type { PermissionMode } from '../../types/common.js';
import type { PermissionResult } from '../../types/permissions.js';
import type { RuntimeContextPatch, RuntimePatch } from '../../runtime/index.js';
import type { Message } from '../../services/ChatServiceInterface.js';
import type { ExecutionContext } from './ExecutionTypes.js';
import type { ToolEffect } from './ToolEffects.js';
import type { z } from 'zod';

/**
 * Node.js 错误类型（带有 code 属性）
 */
export interface NodeError extends Error {
  code?: string;
}

/**
 * 工具类型枚举（简化为 3 种）
 *
 * - ReadOnly: 只读操作，无副作用（Read, Glob, Grep, WebFetch, WebSearch, TaskOutput, TodoWrite, Plan 工具等）
 * - Write: 文件写入操作（Edit, Write, NotebookEdit）
 * - Execute: 命令执行，可能有副作用（Bash, KillShell, Task, Skill）
 */
export enum ToolKind {
  ReadOnly = 'readonly',
  Write = 'write',
  Execute = 'execute',
}

export interface ToolBehavior {
  kind: ToolKind;
  isReadOnly: boolean;
  isConcurrencySafe: boolean;
  isDestructive: boolean;
  interruptBehavior: 'cancel' | 'block';
}

/**
 * Metadata 基础字段 - 所有工具共享
 */
interface BaseMetadataFields {
  summary?: string;
  shouldExitLoop?: boolean;
  targetMode?: PermissionMode;
  modelId?: string;
  model?: string;
}

/**
 * 文件操作类工具的基础字段
 */
interface FileMetadataFields extends BaseMetadataFields {
  file_path: string;
  file_size?: number;
  last_modified?: string;
}

/**
 * Diff 相关字段（Write/Edit 工具）
 */
interface DiffMetadataFields extends FileMetadataFields {
  kind: 'edit';
  oldContent: string;
  newContent?: string;
  snapshot_created?: boolean;
  session_id?: string;
  message_id?: string;
}

/**
 * Read 工具的字段
 */
interface ReadMetadataFields extends FileMetadataFields {
  file_type: string;
  encoding: string;
  is_binary?: boolean;
  lines_read?: number;
  total_lines?: number;
  start_line?: number;
  end_line?: number;
}

/**
 * Write 工具的字段
 */
interface WriteMetadataFields extends DiffMetadataFields {
  content_size: number;
  encoding: string;
  created_directories?: boolean;
  has_diff?: boolean;
}

/**
 * Edit 工具的字段
 */
interface EditMetadataFields extends DiffMetadataFields {
  matches_found: number;
  replacements_made: number;
  replace_all: boolean;
  old_string_length: number;
  new_string_length: number;
  original_size: number;
  new_size: number;
  size_diff: number;
  diff_snippet?: string | null;
}

/**
 * Edit 工具错误诊断的字段
 */
interface EditErrorMetadataFields extends BaseMetadataFields {
  searchStringLength: number;
  fuzzyMatches: Array<{
    line: number;
    similarity: number;
    preview: string;
  }>;
  excerptRange: [number, number];
  totalLines: number;
}

/**
 * Glob 工具的字段
 */
interface GlobMetadataFields extends BaseMetadataFields {
  search_path: string;
  pattern: string;
  total_matches: number;
  returned_matches: number;
  max_results: number;
  include_directories?: boolean;
  case_sensitive?: boolean;
  truncated: boolean;
  matches?: Array<{
    path: string;
    relative_path: string;
    is_directory: boolean;
    mtime?: number;
  }>;
}

/**
 * Grep 工具的字段
 */
interface GrepMetadataFields extends BaseMetadataFields {
  search_pattern: string;
  search_path: string;
  output_mode: string;
  case_insensitive?: boolean;
  total_matches: number;
  original_total?: number;
  offset?: number;
  head_limit?: number;
  strategy?: string;
  exit_code?: number;
}

/**
 * Bash 工具的字段（后台执行）
 */
interface BashBackgroundMetadataFields extends BaseMetadataFields {
  command: string;
  background: true;
  pid: number;
  bash_id: string;
  shell_id: string;
  message?: string;
}

/**
 * Bash 工具的字段（前台执行）
 */
interface BashForegroundMetadataFields extends BaseMetadataFields {
  command: string;
  background?: false;
  execution_time: number;
  exit_code: number | null;
  signal?: NodeJS.Signals | null;
  stdout_length?: number;
  stderr_length?: number;
  has_stderr?: boolean;
}

/**
 * WebSearch 工具的字段
 */
interface WebSearchMetadataFields extends BaseMetadataFields {
  query: string;
  provider: string;
  fetched_at: string;
  total_results: number;
  returned_results: number;
  allowed_domains?: string[];
  blocked_domains?: string[];
}

/**
 * WebFetch 工具的字段
 */
interface WebFetchMetadataFields extends BaseMetadataFields {
  url: string;
  method: string;
  status: number;
  response_time: number;
  content_length: number;
  redirected: boolean;
  redirect_count: number;
  final_url?: string;
  content_type?: string;
  redirect_chain?: string[];
}

/**
 * 泛型 Metadata 类型
 *
 * @template T - 具体的 metadata 字段接口
 *
 * @example
 * // 在工具内部使用具体类型
 * const metadata: Metadata<EditMetadataFields> = { ... };
 *
 * // 返回时自动兼容 ToolResultMetadata
 * return { success: true, metadata };
 */
type Metadata<T extends BaseMetadataFields = BaseMetadataFields> = T & {
  [key: string]: unknown;
};

/**
 * 预定义的 Metadata 类型别名（方便使用）
 */
type FileMetadata = Metadata<FileMetadataFields>;
type DiffMetadata = Metadata<DiffMetadataFields>;
export type ReadMetadata = Metadata<ReadMetadataFields>;
export type WriteMetadata = Metadata<WriteMetadataFields>;
export type EditMetadata = Metadata<EditMetadataFields>;
export type EditErrorMetadata = Metadata<EditErrorMetadataFields>;
export type GlobMetadata = Metadata<GlobMetadataFields>;
export type GrepMetadata = Metadata<GrepMetadataFields>;
export type BashBackgroundMetadata = Metadata<BashBackgroundMetadataFields>;
export type BashForegroundMetadata = Metadata<BashForegroundMetadataFields>;
type BashMetadata = BashBackgroundMetadata | BashForegroundMetadata;
export type WebSearchMetadata = Metadata<WebSearchMetadataFields>;
export type WebFetchMetadata = Metadata<WebFetchMetadataFields>;

/**
 * ToolResult.metadata 的类型（向后兼容）
 *
 * 使用 Metadata<BaseMetadataFields> 作为基础，允许任意扩展字段
 */
export type ToolResultMetadata = Metadata<BaseMetadataFields>;

/**
 * 类型守卫：检查 metadata 是否为 diff 类型（Write/Edit）
 */
function _isDiffMetadata(
  metadata: ToolResultMetadata | undefined
): metadata is DiffMetadata {
  return (
    metadata !== undefined &&
    metadata.kind === 'edit' &&
    typeof metadata.file_path === 'string' &&
    typeof metadata.oldContent === 'string'
  );
}

/**
 * 类型守卫：检查 metadata 是否为文件类型
 */
function _isFileMetadata(
  metadata: ToolResultMetadata | undefined
): metadata is FileMetadata {
  return metadata !== undefined && typeof metadata.file_path === 'string';
}

/**
 * 类型守卫：检查 metadata 是否为命令执行类型
 */
function _isBashMetadata(
  metadata: ToolResultMetadata | undefined
): metadata is BashMetadata {
  return metadata !== undefined && typeof metadata.command === 'string';
}

/**
 * 类型守卫：检查 metadata 是否为 Glob 类型
 */
export function isGlobMetadata(
  metadata: ToolResultMetadata | undefined
): metadata is GlobMetadata {
  return (
    metadata !== undefined &&
    typeof metadata.pattern === 'string' &&
    typeof metadata.search_path === 'string'
  );
}

/**
 * 类型守卫：检查 metadata 是否为 Grep 类型
 */
function _isGrepMetadata(
  metadata: ToolResultMetadata | undefined
): metadata is GrepMetadata {
  return (
    metadata !== undefined &&
    typeof metadata.search_pattern === 'string' &&
    typeof metadata.search_path === 'string'
  );
}

/**
 * 类型守卫：检查 metadata 是否为 Read 类型
 */
function _isReadMetadata(
  metadata: ToolResultMetadata | undefined
): metadata is ReadMetadata {
  return (
    metadata !== undefined &&
    typeof metadata.file_path === 'string' &&
    typeof metadata.file_type === 'string'
  );
}

/**
 * 类型守卫：检查 metadata 是否为 Edit 类型
 */
export function isEditMetadata(
  metadata: ToolResultMetadata | undefined
): metadata is EditMetadata {
  return (
    metadata !== undefined &&
    metadata.kind === 'edit' &&
    typeof metadata.matches_found === 'number'
  );
}

interface ToolResultBase<TMetadata extends ToolResultMetadata = ToolResultMetadata> {
  llmContent: string | object;
  displayContent: string;
  metadata?: TMetadata;
  effects?: ToolEffect[];
  runtimePatch?: RuntimePatch;
  contextPatch?: RuntimeContextPatch;
  newMessages?: Message[];
}

/**
 * 泛型工具执行成功结果
 */
export interface ToolSuccessResult<
  TData = unknown,
  TMetadata extends ToolResultMetadata = ToolResultMetadata,
> extends ToolResultBase<TMetadata> {
  success: true;
  data?: TData;
  error?: undefined;
}

/**
 * 泛型工具执行失败结果
 */
export interface ToolFailureResult<
  TMetadata extends ToolResultMetadata = ToolResultMetadata,
> extends ToolResultBase<TMetadata> {
  success: false;
  data?: undefined;
  error: ToolError;
}

/**
 * 泛型工具执行结果
 *
 * @template TData - 成功结果携带的结构化数据
 * @template TMetadata - metadata 的具体类型
 */
export type ToolResult<
  TData = unknown,
  TMetadata extends ToolResultMetadata = ToolResultMetadata,
> = ToolSuccessResult<TData, TMetadata> | ToolFailureResult<TMetadata>;

/**
 * 工具错误类型
 */
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

/**
 * 函数声明 (用于LLM函数调用)
 */
export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: JSONSchema7;
}

export interface ToolValidationError {
  message: string;
  llmContent?: string | object;
  displayContent?: string;
  metadata?: ToolResultMetadata;
  /** Override the default VALIDATION_ERROR type (e.g. PERMISSION_DENIED for capability checks) */
  errorType?: ToolErrorType;
}

/**
 * 工具调用抽象
 */
export interface ToolInvocation<TParams = unknown, TResult = ToolResult> {
  readonly toolName: string;
  readonly params: TParams;

  getDescription(): string;
  getAffectedPaths(): string[];
  validate?(context?: Partial<ExecutionContext>): Promise<ToolValidationError | undefined>;
  execute(
    signal: AbortSignal,
    updateOutput?: (output: string) => void,
    context?: Partial<ExecutionContext>
  ): Promise<TResult>;
}

/**
 * 工具描述格式（结构化）
 */
export interface ToolDescription {
  short: string;
  long?: string;
  usageNotes?: string[];
  examples?: Array<{
    description: string;
    params: Record<string, unknown>;
  }>;
  important?: string[];
}

export type ToolSchema<TSchema extends z.ZodSchema = z.ZodSchema> =
  | TSchema
  | (() => TSchema);

export type ToolDescriptionResolver<TParams = unknown> = (
  params?: TParams
) => ToolDescription;

export type ToolExposureMode =
  | 'eager'
  | 'deferred'
  | 'discoverable-only';

export interface ToolExposureConfig {
  mode?: ToolExposureMode;
  alwaysLoad?: boolean;
  discoveryHint?: string;
}

export interface PreparedPermissionMatcher {
  signatureContent?: string;
  abstractRule?: string;
}

/**
 * 统一的工具定义接口
 * 
 * 支持两种使用方式：
 * 1. 简单模式：直接传入 name, description, parameters, execute
 * 2. 完整模式：使用 createTool + Zod Schema
 */
export interface ToolDefinition<TParams = Record<string, unknown>> {
  name: string;
  aliases?: string[];
  displayName?: string;
  description: string | ToolDescription;
  parameters: unknown;
  kind?: ToolKind;
  category?: string;
  tags?: string[];
  exposure?: ToolExposureConfig;
  execute: (params: TParams, context: ExecutionContext) => Promise<ToolResult>;
}

/**
 * 工具配置 (泛型接口，用于配合 Zod Schema)
 * TSchema: Schema 类型 (如 z.ZodObject)
 * TParams: 推断的参数类型
 */
export interface ToolConfig<
  TSchema extends z.ZodSchema = z.ZodSchema,
  TParams = unknown,
> {
  /** 工具唯一名称 */
  name: string;
  /** 向后兼容的别名 */
  aliases?: string[];
  /** 工具显示名称 */
  displayName: string;
  /** 工具类型 */
  kind: ToolKind;
  /** 🆕 是否为只读工具（可选，默认根据 kind 推断） */
  isReadOnly?: boolean;
  /** 🆕 是否支持并发安全（可选，默认 true） */
  isConcurrencySafe?: boolean;
  /** 🆕 是否为破坏性操作（可选，默认 false） */
  isDestructive?: boolean;
  /** 🆕 是否启用 OpenAI Structured Outputs（可选，默认 false） */
  strict?: boolean;
  /** 工具结果返回给模型前允许保留的最大字符数 */
  maxResultSizeChars?: number;
  /** 用户中断时的默认行为 */
  interruptBehavior?: 'cancel' | 'block';
  /** Schema 定义 (通常是 Zod Schema) */
  schema: ToolSchema<TSchema>;
  /** 工具描述 */
  description: ToolDescription;
  /** 基于输入动态生成工具描述 */
  describe?: ToolDescriptionResolver<TParams>;
  /** Tool 暴露策略 */
  exposure?: ToolExposureConfig;
  /** 执行函数 */
  execute: (params: TParams, context: ExecutionContext) => Promise<ToolResult>;
  /** 参数语义校验（在 Zod 结构校验之后执行） */
  validateInput?: (
    params: TParams,
    context: ExecutionContext,
  ) => Promise<void | ToolValidationError> | void | ToolValidationError;
  /** 工具自身的权限预检查（在全局权限处理前执行） */
  checkPermissions?: (
    params: TParams,
    context: ExecutionContext,
  ) => Promise<void | PermissionResult> | void | PermissionResult;
  /** 基于参数动态解析工具行为 */
  resolveBehavior?: (params: TParams) => Partial<ToolBehavior> | ToolBehavior;
  /** 无调用参数时为暴露规划提供的行为 hint */
  resolveBehaviorHint?: () => Partial<ToolBehavior> | ToolBehavior;
  /** 版本号 */
  version?: string;
  /** 分类 */
  category?: string;
  /** 标签 */
  tags?: string[];

  /**
   * 准备用于权限系统的匹配信息
   * signatureContent 用于构造精确签名
   * abstractRule 用于构造抽象权限规则
   */
  preparePermissionMatcher?: (params: TParams) => PreparedPermissionMatcher;
}

/**
 * Tool 接口
 */
export interface Tool<TParams = unknown> {
  /** 工具名称 */
  readonly name: string;
  /** 向后兼容的别名 */
  readonly aliases?: string[];
  /** 显示名称 */
  readonly displayName: string;
  /** 工具类型 */
  readonly kind: ToolKind;
  /** 🆕 是否为只读工具 hint（向后兼容） */
  readonly isReadOnly: boolean;
  /** 🆕 是否支持并发安全 hint（向后兼容） */
  readonly isConcurrencySafe: boolean;
  /** 🆕 是否为破坏性操作 hint（向后兼容） */
  readonly isDestructive?: boolean;
  /** 🆕 是否启用 OpenAI Structured Outputs */
  readonly strict: boolean;
  /** 工具结果返回给模型前允许保留的最大字符数 */
  readonly maxResultSizeChars: number;
  /** 用户中断时的默认行为 */
  readonly interruptBehavior: 'cancel' | 'block';
  /** 工具描述 */
  readonly description: ToolDescription;
  /** Tool 暴露策略 */
  readonly exposure: Required<ToolExposureConfig> & {
    mode: ToolExposureMode;
  };
  /** 版本号 */
  readonly version: string;
  /** 分类 */
  readonly category?: string;
  /** 标签 */
  readonly tags: string[];

  /**
   * 获取函数声明 (用于 LLM)
   */
  getFunctionDeclaration(): FunctionDeclaration;

  /**
   * 获取当前调用上下文下的工具描述
   */
  describe(params?: TParams): ToolDescription;

  /**
   * 获取工具元信息
   */
  getMetadata(): Record<string, unknown>;

  /**
   * 构建工具调用
   */
  build(params: TParams): ToolInvocation<TParams>;

  /**
   * 一键执行
   */
  execute(params: TParams, signal?: AbortSignal): Promise<ToolResult>;

  /**
   * 参数语义校验（在 Zod 结构校验之后执行）
   */
  validateInput?: (
    params: TParams,
    context: ExecutionContext,
  ) => Promise<void | ToolValidationError> | void | ToolValidationError;

  /**
   * 工具自身的权限预检查（在全局权限处理前执行）
   */
  checkPermissions?: (
    params: TParams,
    context: ExecutionContext,
  ) => Promise<void | PermissionResult> | void | PermissionResult;

  /**
   * 根据调用参数解析本次执行的行为
   */
  resolveBehavior?: (params: TParams) => ToolBehavior;

  /**
   * 在没有调用参数时提供暴露/规划阶段使用的行为 hint
   */
  getBehaviorHint?: () => ToolBehavior;

  /**
   * 准备用于权限系统的匹配信息
   */
  preparePermissionMatcher?: (params: TParams) => PreparedPermissionMatcher;
}

/**
 * 根据 ToolKind 推断是否为只读工具
 */
export function isReadOnlyKind(kind: ToolKind): boolean {
  return kind === ToolKind.ReadOnly;
}

export function createToolBehavior(
  kind: ToolKind,
  overrides: Partial<ToolBehavior> = {},
): ToolBehavior {
  return {
    kind,
    isReadOnly: overrides.isReadOnly ?? isReadOnlyKind(kind),
    isConcurrencySafe: overrides.isConcurrencySafe ?? true,
    isDestructive: overrides.isDestructive ?? false,
    interruptBehavior: overrides.interruptBehavior ?? 'cancel',
  };
}

export function getStaticToolBehavior(tool: {
  kind?: ToolKind;
  isReadOnly?: boolean;
  isConcurrencySafe?: boolean;
  isDestructive?: boolean;
  interruptBehavior?: 'cancel' | 'block';
}): ToolBehavior {
  return createToolBehavior(tool.kind ?? ToolKind.Execute, {
    isReadOnly: tool.isReadOnly,
    isConcurrencySafe: tool.isConcurrencySafe,
    isDestructive: tool.isDestructive,
    interruptBehavior: tool.interruptBehavior,
  });
}

export function resolveToolBehaviorHint(tool: {
  kind?: ToolKind;
  isReadOnly?: boolean;
  isConcurrencySafe?: boolean;
  isDestructive?: boolean;
  interruptBehavior?: 'cancel' | 'block';
  getBehaviorHint?: () => Partial<ToolBehavior> | ToolBehavior;
}): ToolBehavior {
  const staticBehavior = getStaticToolBehavior(tool);
  if (!tool.getBehaviorHint) {
    return staticBehavior;
  }

  return {
    ...staticBehavior,
    ...tool.getBehaviorHint(),
  };
}

export function resolveToolBehavior<TParams>(
  tool: {
    kind?: ToolKind;
    isReadOnly?: boolean;
    isConcurrencySafe?: boolean;
    isDestructive?: boolean;
    interruptBehavior?: 'cancel' | 'block';
    resolveBehavior?: (params: TParams) => Partial<ToolBehavior> | ToolBehavior;
  },
  params: TParams,
): ToolBehavior {
  const staticBehavior = getStaticToolBehavior(tool);
  if (!tool.resolveBehavior) {
    return staticBehavior;
  }

  return {
    ...staticBehavior,
    ...tool.resolveBehavior(params),
  };
}

export function resolveToolBehaviorSafely<TParams>(
  tool: {
    kind?: ToolKind;
    isReadOnly?: boolean;
    isConcurrencySafe?: boolean;
    isDestructive?: boolean;
    interruptBehavior?: 'cancel' | 'block';
    resolveBehavior?: (params: TParams) => Partial<ToolBehavior> | ToolBehavior;
  } | undefined,
  params: TParams,
): ToolBehavior | undefined {
  if (!tool) {
    return undefined;
  }

  try {
    return resolveToolBehavior(tool, params);
  } catch {
    return getStaticToolBehavior(tool);
  }
}

export function validationErrorToToolResult(
  error: ToolValidationError,
): ToolResult {
  return {
    success: false,
    llmContent: error.llmContent ?? error.message,
    displayContent: error.displayContent ?? error.message,
    error: {
      type: error.errorType ?? ToolErrorType.VALIDATION_ERROR,
      message: error.message,
    },
    metadata: error.metadata,
  };
}
