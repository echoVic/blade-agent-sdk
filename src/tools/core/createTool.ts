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
  ToolValidationError as _ToolValidationError,
} from '../types/index.js';
import { ToolErrorType, validationErrorToToolResult } from '../types/index.js';
import { formatToolDescription, formatUnknown, inferAffectedPaths, isPathLikeKey, translateZodIssue } from '@blade-ai/agent-sdk/local';
import { createToolBehavior, isReadOnlyKind, ToolKind } from '../types/ToolKind.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { isPlainObject } from 'lodash-es';
import { SdkError } from '../../errors/SdkError.js';
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

class UnifiedToolInvocation<
  TParams = JsonObject,
  TResult extends ToolResult = ToolResult,
> implements ToolInvocation<TParams, TResult> {
  private validationPassed = false;

  constructor(
    public readonly toolName: string,
    public readonly params: TParams,
    private readonly executeFn: (
      params: TParams,
      context: ExecutionContext
    ) => Promise<TResult>,
    private readonly validateFn?: (
      params: TParams,
      context: ExecutionContext
    ) => Promise<undefined | _ToolValidationError> | undefined | _ToolValidationError,
    private readonly descriptionFn?: (params: TParams) => string,
    private readonly affectedPathsFn?: (params: TParams) => string[]
  ) {}

  /**
   * 获取操作描述
   */
  getDescription(): string {
    if (this.descriptionFn) {
      return this.descriptionFn(this.params);
    }
    return `执行工具: ${this.toolName}`;
  }

  /**
   * 获取受影响的文件路径
   */
  getAffectedPaths(): string[] {
    if (this.affectedPathsFn) {
      return this.affectedPathsFn(this.params);
    }
    return [];
  }

  async validate(
    context: Partial<ExecutionContext> = {}
  ): Promise<_ToolValidationError | undefined> {
    if (this.validationPassed || !this.validateFn) {
      return undefined;
    }

    const validationResult = await this.validateFn(this.params, {
      signal: context.signal,
      updateOutput: context.updateOutput,
      ...context,
    });

    if (!validationResult) {
      this.validationPassed = true;
      return undefined;
    }

    return validationResult;
  }

  /**
   * 执行工具
   * @param signal - 中止信号
   * @param updateOutput - 输出更新回调
   * @param context - 额外的执行上下文（包含 confirmationHandler、permissionMode 等）
   */
  async execute(
    signal: AbortSignal,
    updateOutput?: (output: string) => void,
    context?: Partial<ExecutionContext>
  ): Promise<TResult> {
    // 合并基础 context 和额外字段
    const fullContext: ExecutionContext = {
      signal,
      updateOutput,
      ...context, // 包含 confirmationHandler, permissionMode, userId, sessionId 等
    };

    const validationError = await this.validate(fullContext);
    if (validationError) {
      return validationErrorToToolResult(validationError) as TResult;
    }

    return this.executeFn(this.params, fullContext);
  }
}
