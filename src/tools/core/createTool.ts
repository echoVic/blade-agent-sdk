import type { JSONSchema7 } from 'json-schema';
import type { ZodError, ZodIssue, z } from 'zod';
import type { JsonObject, JsonValue } from '../../types/common.js';
import type {
  ExecutionContext,
  Tool,
  ToolConfig,
  ToolDefinition,
  ToolInvocation,
  ToolResult,
} from '../types/index.js';
import { ToolErrorType } from '../types/index.js';
import { createToolBehavior, isReadOnlyKind, ToolKind } from '../types/ToolKind.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { isPlainObject } from 'lodash-es';
import { SdkError } from '../../errors/SdkError.js';
import { UnifiedToolInvocation } from './ToolInvocation.js';

/**
 * 创建工具的工厂函数
 */
export function createTool<TSchema extends z.ZodSchema>(
  config: ToolConfig<TSchema, z.infer<TSchema>>
): Tool<z.infer<TSchema>> {
  type TParams = z.infer<TSchema>;
  let cachedSchema: TSchema | undefined;
  let cachedFunctionSchema: JSONSchema7 | undefined;
  let cachedStaticDescriptionText: string | undefined;

  const getSchema = (): TSchema => {
    if (!cachedSchema) {
      cachedSchema = (typeof config.schema === 'function' ? (config.schema as () => TSchema)() : config.schema);
    }
    return cachedSchema;
  };

  const resolveDescription = (params?: TParams) =>
    config.describe?.(params) ?? config.description;

  const staticBehavior = createToolBehavior(config.kind, {
    isReadOnly: config.isReadOnly,
    isConcurrencySafe: config.isConcurrencySafe,
    isDestructive: config.isDestructive,
    interruptBehavior: config.interruptBehavior,
  });
  const behaviorHint = config.resolveBehaviorHint
    ? {
        ...staticBehavior,
        ...config.resolveBehaviorHint(),
      }
    : staticBehavior;
  const exposure = {
    mode: config.exposure?.mode ?? 'eager',
    alwaysLoad: config.exposure?.alwaysLoad ?? false,
    discoveryHint: config.exposure?.discoveryHint ?? '',
  } as const;

  // Extract optional callbacks to local const so TS narrowing works inside closures
  const validateInputFn = config.validateInput;
  const checkPermissionsFn = config.checkPermissions;
  const preparePermissionMatcherFn = config.preparePermissionMatcher;

  return {
    name: config.name,
    aliases: config.aliases,
    displayName: config.displayName,
    kind: config.kind,

    // 🆕 isReadOnly 字段
    // 优先使用 config 中的显式设置，否则根据 kind 推断
    isReadOnly: behaviorHint.isReadOnly,

    // 🆕 isConcurrencySafe 字段
    // 优先使用 config 中的显式设置，否则默认 true
    isConcurrencySafe: behaviorHint.isConcurrencySafe,

    isDestructive: behaviorHint.isDestructive,

    // 🆕 strict 字段（OpenAI Structured Outputs）
    // 优先使用 config 中的显式设置，否则默认 false
    strict: config.strict ?? false,

    maxResultSizeChars: config.maxResultSizeChars ?? Number.POSITIVE_INFINITY,

    interruptBehavior: staticBehavior.interruptBehavior,

    description: config.description,
    exposure,
    version: config.version || '1.0.0',
    category: config.category,
    tags: config.tags || [],

    describe(params?: TParams) {
      return resolveDescription(params);
    },

    /**
     * 获取函数声明 (用于 LLM function calling)
     */
    getFunctionDeclaration() {
      if (!cachedFunctionSchema) {
        cachedFunctionSchema = zodToJsonSchema(getSchema(), { target: 'jsonSchema7', $refStrategy: 'none' }) as JSONSchema7;
      }
      if (!cachedStaticDescriptionText) {
        cachedStaticDescriptionText = formatToolDescription(resolveDescription());
      }

      return {
        name: config.name,
        description: cachedStaticDescriptionText,
        parameters: cachedFunctionSchema,
      };
    },

    /**
     * 获取工具元信息
     */
    getMetadata() {
      if (!cachedFunctionSchema) {
        cachedFunctionSchema = zodToJsonSchema(getSchema(), { target: 'jsonSchema7', $refStrategy: 'none' }) as JSONSchema7;
      }

      return {
        name: config.name,
        displayName: config.displayName,
        kind: config.kind,
        version: config.version || '1.0.0',
        category: config.category,
        tags: config.tags || [],
        description: config.description,
        schema: cachedFunctionSchema,
      };
    },

    /**
     * 构建工具调用
     */
    build(params: TParams): ToolInvocation<TParams> {
      // 使用 Zod 验证参数
      const validatedParams = parseWithZod(getSchema(), params);

      return new UnifiedToolInvocation<TParams, ToolResult>(
        config.name,
        validatedParams,
        config.execute,
        config.validateInput,
        (resolvedParams) => resolveDescription(resolvedParams).short,
        inferAffectedPaths,
      );
    },

    /**
     * 一键执行
     */
    async execute(params: TParams, signal?: AbortSignal): Promise<ToolResult> {
      const invocation = this.build(params);
      return invocation.execute(signal || new AbortController().signal);
    },

    validateInput: validateInputFn
      ? (params: TParams, context: ExecutionContext) =>
          validateInputFn(params, context)
      : undefined,

    getBehaviorHint() {
      return behaviorHint;
    },

    checkPermissions: checkPermissionsFn
      ? (params: TParams, context: ExecutionContext) =>
          checkPermissionsFn(params, context)
      : undefined,

    resolveBehavior(params: TParams) {
      const validatedParams = parseWithZod(getSchema(), params);
      if (!config.resolveBehavior) {
        return staticBehavior;
      }
      return {
        ...staticBehavior,
        ...config.resolveBehavior(validatedParams),
      };
    },

    preparePermissionMatcher: preparePermissionMatcherFn
      ? (params: TParams) => preparePermissionMatcherFn(params)
      : undefined,
  };
}

function formatToolDescription(description: {
  short: string;
  long?: string;
  usageNotes?: string[];
  important?: string[];
}): string {
  let fullDescription = description.short;

  if (description.long) {
    fullDescription += `\n\n${description.long}`;
  }

  if (description.usageNotes && description.usageNotes.length > 0) {
    fullDescription += `\n\nUsage Notes:\n${description.usageNotes.map((note) => `- ${note}`).join('\n')}`;
  }

  if (description.important && description.important.length > 0) {
    fullDescription += `\n\nImportant:\n${description.important.map((note) => `⚠️ ${note}`).join('\n')}`;
  }

  return fullDescription;
}

/**
 * 从 ToolDefinition 创建 Tool 实例
 * 
 * 用于将用户定义的简化工具转换为内部 Tool 对象
 */
export function toolFromDefinition<TParams = JsonObject>(
  definition: ToolDefinition<TParams>
): Tool<TParams> {
  const description = typeof definition.description === 'string'
    ? { short: definition.description }
    : definition.description;
  const staticBehavior = createToolBehavior(definition.kind || ToolKind.Execute, {
    isReadOnly: definition.kind ? isReadOnlyKind(definition.kind) : false,
  });

  return {
    name: definition.name,
    aliases: definition.aliases,
    displayName: definition.displayName || definition.name,
    kind: definition.kind || ToolKind.Execute,
    isReadOnly: staticBehavior.isReadOnly,
    isConcurrencySafe: staticBehavior.isConcurrencySafe,
    isDestructive: staticBehavior.isDestructive,
    strict: false,
    maxResultSizeChars: Number.POSITIVE_INFINITY,
    interruptBehavior: staticBehavior.interruptBehavior,
    description,
    exposure: {
      mode: definition.exposure?.mode ?? 'eager',
      alwaysLoad: definition.exposure?.alwaysLoad ?? false,
      discoveryHint: definition.exposure?.discoveryHint ?? '',
    },
    version: '1.0.0',
    category: definition.category,
    tags: definition.tags || [],

    describe() {
      return description;
    },

    getFunctionDeclaration() {
      return {
        name: definition.name,
        description: formatToolDescription(description),
        parameters: definition.parameters as import('json-schema').JSONSchema7,
      };
    },

    getMetadata() {
      return {
        name: definition.name,
        displayName: definition.displayName || definition.name,
        kind: definition.kind || ToolKind.Execute,
        version: '1.0.0',
        category: definition.category,
        tags: definition.tags || [],
        description,
        schema: definition.parameters,
      };
    },

    build(params: TParams): ToolInvocation<TParams> {
      return new UnifiedToolInvocation<TParams, ToolResult>(
        definition.name,
        params,
        (p, ctx) => definition.execute(p, ctx),
        undefined,
        undefined,
        inferAffectedPaths,
      );
    },

    async execute(params: TParams, signal?: AbortSignal): Promise<ToolResult> {
      const context: ExecutionContext = { signal };
      return definition.execute(params, context);
    },

    getBehaviorHint() {
      return staticBehavior;
    },

    resolveBehavior() {
      return staticBehavior;
    },
  };
}

function inferAffectedPaths(params: unknown): string[] {
  if (!params || typeof params !== 'object') {
    return [];
  }

  const candidates = new Set<string>();
  for (const [key, value] of Object.entries(params as JsonObject)) {
    if (typeof value === 'string' && isPathLikeKey(key)) {
      const normalized = value.trim();
      if (normalized) {
        candidates.add(normalized);
      }
      continue;
    }

    if (Array.isArray(value) && (key === 'paths' || key === 'files')) {
      for (const item of value) {
        if (typeof item === 'string' && item.trim() !== '') {
          candidates.add(item.trim());
        }
      }
    }
  }

  return [...candidates];
}

function isPathLikeKey(key: string): boolean {
  return key === 'path'
    || key.endsWith('_path')
    || key.endsWith('Path')
    || key === 'file'
    || key === 'directory';
}

/**
 * 定义工具的便捷函数
 * 
 * @example
 * ```typescript
 * const myTool = defineTool({
 *   name: 'MyTool',
 *   description: 'A simple tool',
 *   parameters: {
 *     type: 'object',
 *     properties: {
 *       message: { type: 'string', description: 'The message' }
 *     },
 *     required: ['message']
 *   },
 *   execute: async (params, context) => {
 *     return {
 *       success: true,
 *       llmContent: `Received: ${params.message}`,
 *     };
 *   }
 * });
 * ```
 */
export function defineTool<TParams = JsonObject, TData extends JsonValue = JsonValue>(
  definition: ToolDefinition<TParams, TData>
): ToolDefinition<TParams, TData> {
  return definition;
}

type ZodIssueExtra = ZodIssue & {
  received?: unknown;
  expected?: unknown;
  minimum?: number;
  maximum?: number;
  inclusive?: boolean;
  validation?: unknown;
  options?: unknown;
  keys?: unknown;
  type?: unknown;
};

function formatUnknown(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

class ToolValidationError extends SdkError {
  constructor(
    message: string,
    public readonly issues: readonly {
      field: string;
      message: string;
      value?: unknown;
    }[],
    public readonly type: ToolErrorType = ToolErrorType.VALIDATION_ERROR,
  ) {
    super('TOOL_VALIDATION_ERROR', message);
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      issues: this.issues,
      type: this.type,
    };
  }
}

/**
 * 将 Zod 错误代码翻译为中文消息
 */
function translateZodIssue(issue: ZodIssue): string {
  const { code } = issue;
  const extra = issue as ZodIssueExtra;
  const received = extra.received;

  switch (code) {
    case 'invalid_type': {
      const expected = extra.expected;
      return `类型错误：期望 ${formatUnknown(expected)}，实际收到 ${formatUnknown(received)}`;
    }

    case 'too_small': {
      const minimum = extra.minimum;
      const inclusive = extra.inclusive;
      const issueType = typeof extra.type === 'string' ? extra.type : undefined;
      if (issueType === 'string' && typeof minimum === 'number') {
        return `长度不能少于 ${minimum} 个字符`;
      }
      if (issueType === 'number' && typeof minimum === 'number') {
        return `不能小于${inclusive ? '等于' : ''} ${minimum}`;
      }
      if (issueType === 'array' && typeof minimum === 'number') {
        return `数组长度不能少于 ${minimum}`;
      }
      return `值太小`;
    }

    case 'too_big': {
      const maximum = extra.maximum;
      const inclusiveMax = extra.inclusive;
      const issueType = typeof extra.type === 'string' ? extra.type : undefined;
      if (issueType === 'string' && typeof maximum === 'number') {
        return `长度不能超过 ${maximum} 个字符`;
      }
      if (issueType === 'number' && typeof maximum === 'number') {
        return `不能大于${inclusiveMax ? '等于' : ''} ${maximum}`;
      }
      if (issueType === 'array' && typeof maximum === 'number') {
        return `数组长度不能超过 ${maximum}`;
      }
      return `值太大`;
    }

    case 'invalid_string': {
      const validation = extra.validation;
      if (validation === 'email') {
        return '必须是有效的电子邮件地址';
      }
      if (validation === 'url') {
        return '必须是有效的 URL';
      }
      if (validation === 'uuid') {
        return '必须是有效的 UUID';
      }
      if (isPlainObject(validation)) {
        const v = validation as Record<string, unknown>;
        if (typeof v.includes === 'string') {
          return `必须包含 "${v.includes}"`;
        }
        if (typeof v.startsWith === 'string') {
          return `必须以 "${v.startsWith}" 开头`;
        }
        if (typeof v.endsWith === 'string') {
          return `必须以 "${v.endsWith}" 结尾`;
        }
      }
      return '字符串格式不正确';
    }

    case 'invalid_enum_value': {
      const options = extra.options;
      if (Array.isArray(options)) {
        return `必须是以下值之一：${options.map((o) => formatUnknown(o)).join(', ')}`;
      }
      return '必须是枚举允许的值之一';
    }

    case 'invalid_literal': {
      const expected_literal = extra.expected;
      return `必须是字面量值：${formatUnknown(expected_literal)}`;
    }

    case 'unrecognized_keys': {
      const keys = extra.keys;
      if (Array.isArray(keys)) {
        return `包含未知的参数：${keys.map((k) => formatUnknown(k)).join(', ')}`;
      }
      return '包含未知的参数';
    }

    case 'invalid_union':
      return '不符合任何有效的类型定义';

    case 'invalid_date':
      return '必须是有效的日期';

    case 'custom':
      return issue.message || '自定义验证失败';

    default:
      return issue.message || '验证失败';
  }
}

/**
 * 格式化 Zod 错误为友好的中文提示
 */
function formatZodError(error: ZodError): ToolValidationError {
  const issues = error.issues.map((issue) => {
    const field = issue.path.join('.');
    const message = translateZodIssue(issue);
    const value = (issue as ZodIssueExtra).received;

    return {
      field: field || 'root',
      message,
      value,
    };
  });

  const errorMessage =
    issues.length === 1
      ? `参数验证失败 [${issues[0].field}]: ${issues[0].message}`
      : `参数验证失败 (${issues.length} 个错误):\n${issues.map((i) => `  - ${i.field}: ${i.message}`).join('\n')}`;

  return new ToolValidationError(errorMessage, issues);
}

/**
 * 安全地解析 Zod Schema
 * @param schema Zod Schema
 * @param data 待验证的数据
 * @returns 验证成功返回数据，失败抛出 ToolValidationError
 */
function parseWithZod<T extends z.ZodSchema>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);

  if (!result.success) {
    throw formatZodError(result.error);
  }

  return result.data;
}
