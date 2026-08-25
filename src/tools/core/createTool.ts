import type { z } from 'zod';
import type { JsonObject, JsonValue } from '../../types/json.js';
import type { ExecutionContext } from '../types/execution.js';
import { createToolBehavior, isReadOnlyKind, isToolSideEffect, ToolKind } from '../types/kind.js';
import type { Tool, ToolConfig, ToolDefinition, ToolInvocation } from '../types/tool.js';
import { parseWithZod } from '../validation/errorFormatter.js';
import { resolveToolSchema } from '../validation/lazySchema.js';
import { zodToFunctionSchema } from '../validation/zodToJson.js';
import { UnifiedToolInvocation } from './ToolInvocation.js';

/**
 * 创建工具的工厂函数
 */
export function createTool<TSchema extends z.ZodSchema>(
  config: ToolConfig<TSchema, z.infer<TSchema>>,
): Tool<z.infer<TSchema>> {
  type TParams = z.infer<TSchema>;
  let cachedSchema: TSchema | undefined;
  let cachedFunctionSchema: ReturnType<typeof zodToFunctionSchema> | undefined;
  let cachedStaticDescriptionText: string | undefined;

  const getSchema = (): TSchema => {
    if (!cachedSchema) {
      cachedSchema = resolveToolSchema(config.schema);
    }
    return cachedSchema;
  };

  const resolveDescription = (params?: TParams) => config.describe?.(params) ?? config.description;

  const staticBehavior = createToolBehavior(config.kind, config.sideEffect, {
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
    sideEffect: staticBehavior.sideEffect,

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

    describe(params?: unknown) {
      return resolveDescription(
        params === undefined ? undefined : parseWithZod(getSchema(), params),
      );
    },

    /**
     * 获取函数声明 (用于 LLM function calling)
     */
    getFunctionDeclaration() {
      if (!cachedFunctionSchema) {
        cachedFunctionSchema = zodToFunctionSchema(getSchema());
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
        cachedFunctionSchema = zodToFunctionSchema(getSchema());
      }

      return {
        name: config.name,
        displayName: config.displayName,
        kind: config.kind,
        sideEffect: staticBehavior.sideEffect,
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
    build(params: unknown): ToolInvocation<TParams> {
      // 使用 Zod 验证参数
      const validatedParams = parseWithZod(getSchema(), params);

      return new UnifiedToolInvocation<TParams>(
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
    execute(params: unknown, context: ExecutionContext = {}) {
      const invocation = this.build(params);
      return invocation.execute(context.signal ?? new AbortController().signal, context);
    },

    validateInput: validateInputFn
      ? (params: unknown, context: ExecutionContext) =>
          validateInputFn(parseWithZod(getSchema(), params), context)
      : undefined,

    getBehaviorHint() {
      return behaviorHint;
    },

    checkPermissions: checkPermissionsFn
      ? (params: unknown, context: ExecutionContext) =>
          checkPermissionsFn(parseWithZod(getSchema(), params), context)
      : undefined,

    resolveBehavior(params: unknown) {
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
      ? (params: unknown) => preparePermissionMatcherFn(parseWithZod(getSchema(), params))
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
  definition: ToolDefinition<TParams>,
): Tool<TParams> {
  const description =
    typeof definition.description === 'string'
      ? { short: definition.description }
      : definition.description;
  const staticBehavior = createToolBehavior(
    definition.kind || ToolKind.Execute,
    definition.sideEffect,
    {
      isReadOnly: definition.kind ? isReadOnlyKind(definition.kind) : false,
    },
  );

  return {
    name: definition.name,
    aliases: definition.aliases,
    displayName: definition.displayName || definition.name,
    kind: definition.kind || ToolKind.Execute,
    sideEffect: staticBehavior.sideEffect,
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
        sideEffect: staticBehavior.sideEffect,
        version: '1.0.0',
        category: definition.category,
        tags: definition.tags || [],
        description,
        schema: definition.parameters,
      };
    },

    build(params: unknown): ToolInvocation<TParams> {
      const typedParams = params as TParams;
      return new UnifiedToolInvocation<TParams>(
        definition.name,
        typedParams,
        (p, ctx) => definition.execute(p, ctx),
        undefined,
        undefined,
        inferAffectedPaths,
      );
    },

    execute(params: unknown, context: ExecutionContext = {}) {
      const invocation = this.build(params);
      return invocation.execute(context.signal ?? new AbortController().signal, context);
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
  return (
    key === 'path' ||
    key.endsWith('_path') ||
    key.endsWith('Path') ||
    key === 'file' ||
    key === 'directory'
  );
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
 *   async *execute(params, context) {
 *     return {
 *       status: 'success',
 *       model: `Received: ${params.message}`,
 *     };
 *   }
 * });
 * ```
 */
export function defineTool<TParams = JsonObject, TData extends JsonValue = JsonValue>(
  definition: ToolDefinition<TParams, TData>,
): ToolDefinition<TParams, TData> {
  if (!isToolSideEffect(definition.sideEffect)) {
    throw new TypeError('Tool sideEffect must be pure, idempotent, or non_idempotent');
  }
  return definition;
}
