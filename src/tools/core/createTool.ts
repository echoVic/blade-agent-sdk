import type { z } from 'zod';
import type { JsonObject, JsonValue } from '../../types/json.js';
import type { ExecutionContext } from '../types/execution.js';
import { createToolBehavior, isReadOnlyKind, isToolSideEffect, ToolKind } from '../types/kind.js';
import type { ToolBehavior } from '../types/kind.js';
import type {
  Tool,
  ToolConfig,
  ToolDefinition,
  ToolDescription,
  ToolExposureMode,
  ToolInvocation,
} from '../types/tool.js';
import type { ToolExecution, ToolValidationError } from '../types/result.js';
import { parseWithZod } from '../validation/errorFormatter.js';
import { resolveToolSchema } from '../validation/lazySchema.js';
import { zodToFunctionSchema } from '../validation/zodToJson.js';
import { UnifiedToolInvocation } from './ToolInvocation.js';

/**
 * A tool that does not declare how a repeated execution behaves is treated as
 * non-idempotent, so recovery never replays it without an explicit opt-in.
 */
const DEFAULT_TOOL_SIDE_EFFECT = 'non_idempotent' as const;

function isZodSchema(value: unknown): value is z.ZodSchema {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { safeParse?: unknown }).safeParse === 'function';
}

function resolveDefinitionParameters(parameters: ToolDefinition['parameters']): {
  readonly jsonSchema: import('json-schema').JSONSchema7;
  readonly raw: ToolDefinition['parameters'];
} {
  if (isZodSchema(parameters)) {
    return { jsonSchema: zodToFunctionSchema(parameters), raw: parameters };
  }
  return { jsonSchema: parameters as import('json-schema').JSONSchema7, raw: parameters };
}


/**
 * Assembles the `Tool` object from already-normalised inputs.
 *
 * Both authoring entry points describe the same runtime contract and differ only
 * in how parameters are declared and validated, so the shape is built in one place:
 * `createTool` supplies schema-backed validation, `toolFromDefinition` supplies a
 * definition. Keeping a single assembler is what stops the two from drifting into
 * subtly different tools.
 */
interface ToolAssembly<TParams> {
  readonly name: string;
  readonly aliases?: string[];
  readonly displayName: string;
  readonly kind: ToolKind;
  readonly staticBehavior: ToolBehavior;
  readonly behaviorHint: ToolBehavior;
  readonly strict: boolean;
  readonly maxResultSizeChars: number;
  readonly description: ToolDescription;
  readonly exposure: { mode: ToolExposureMode; alwaysLoad: boolean; discoveryHint: string };
  readonly version: string;
  readonly category?: string;
  readonly tags: string[];
  /** Description for model-facing declarations, already formatted. */
  readonly declarationDescription: () => string;
  /** JSON Schema sent to the model. */
  readonly functionSchema: () => import('json-schema').JSONSchema7;
  /** Zod schema for callers that validate params, when the tool has one. */
  readonly metadataSchema: () => unknown;
  readonly resolveDescription: (params?: unknown) => ToolDescription;
  readonly invocationParams: (params: unknown) => TParams;
  /** Validation the invocation runs before the tool body, with the schema parsed. */
  readonly invocationValidation?: (
    params: TParams,
    context: ExecutionContext,
  ) => Promise<undefined | ToolValidationError> | undefined | ToolValidationError;
  /** Short description of a concrete invocation, used in confirmations. */
  readonly invocationDescription?: (params: TParams) => string;
  readonly execute: (params: TParams, context: ExecutionContext) => ToolExecution;
  readonly validateInput?: Tool['validateInput'];
  readonly checkPermissions?: Tool['checkPermissions'];
  readonly resolveBehavior?: (params: unknown) => ToolBehavior;
  readonly preparePermissionMatcher?: Tool['preparePermissionMatcher'];
  /** Optional hint used by callers that plan without validated parameters. */
  readonly getBehaviorHint?: () => ToolBehavior;
}

function assembleTool<TParams>(assembly: ToolAssembly<TParams>): Tool<TParams> {
  return {
    name: assembly.name,
    aliases: assembly.aliases,
    displayName: assembly.displayName,
    kind: assembly.kind,
    sideEffect: assembly.staticBehavior.sideEffect,
    isReadOnly: assembly.behaviorHint.isReadOnly,
    isConcurrencySafe: assembly.behaviorHint.isConcurrencySafe,
    isDestructive: assembly.behaviorHint.isDestructive,
    strict: assembly.strict,
    maxResultSizeChars: assembly.maxResultSizeChars,
    interruptBehavior: assembly.staticBehavior.interruptBehavior,
    description: assembly.description,
    exposure: assembly.exposure,
    version: assembly.version,
    category: assembly.category,
    tags: assembly.tags,

    describe(params?: unknown) {
      return assembly.resolveDescription(params);
    },

    getFunctionDeclaration() {
      return {
        name: assembly.name,
        description: assembly.declarationDescription(),
        parameters: assembly.functionSchema(),
      };
    },

    getMetadata() {
      return {
        name: assembly.name,
        displayName: assembly.displayName,
        kind: assembly.kind,
        sideEffect: assembly.staticBehavior.sideEffect,
        version: assembly.version,
        category: assembly.category,
        tags: assembly.tags,
        description: assembly.description,
        schema: assembly.metadataSchema(),
      };
    },

    build(params: unknown): ToolInvocation<TParams> {
      return new UnifiedToolInvocation<TParams>(
        assembly.name,
        assembly.invocationParams(params),
        (resolvedParams, context) => assembly.execute(resolvedParams, context),
        assembly.invocationValidation,
        assembly.invocationDescription,
        inferAffectedPaths,
      );
    },

    execute(params: unknown, context: ExecutionContext = {}) {
      const invocation = this.build(params);
      return invocation.execute(context.signal ?? new AbortController().signal, context);
    },

    ...(assembly.validateInput ? { validateInput: assembly.validateInput } : {}),
    ...(assembly.checkPermissions ? { checkPermissions: assembly.checkPermissions } : {}),
    ...(assembly.resolveBehavior ? { resolveBehavior: assembly.resolveBehavior } : {}),
    ...(assembly.preparePermissionMatcher
      ? { preparePermissionMatcher: assembly.preparePermissionMatcher }
      : {}),
    ...(assembly.getBehaviorHint ? { getBehaviorHint: assembly.getBehaviorHint } : {}),
  };
}

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

  return assembleTool<TParams>({
    name: config.name,
    aliases: config.aliases,
    displayName: config.displayName,
    kind: config.kind,
    staticBehavior,
    behaviorHint,
    strict: config.strict ?? false,
    maxResultSizeChars: config.maxResultSizeChars ?? Number.POSITIVE_INFINITY,
    description: config.description,
    exposure,
    version: config.version || '1.0.0',
    category: config.category,
    tags: config.tags || [],
    declarationDescription: () => {
      if (!cachedStaticDescriptionText) {
        cachedStaticDescriptionText = formatToolDescription(resolveDescription());
      }
      return cachedStaticDescriptionText;
    },
    functionSchema: () => {
      if (!cachedFunctionSchema) {
        cachedFunctionSchema = zodToFunctionSchema(getSchema());
      }
      return cachedFunctionSchema;
    },
    metadataSchema: () => {
      if (!cachedFunctionSchema) {
        cachedFunctionSchema = zodToFunctionSchema(getSchema());
      }
      return cachedFunctionSchema;
    },
    resolveDescription: (params?: unknown) =>
      resolveDescription(params === undefined ? undefined : parseWithZod(getSchema(), params)),
    // Zod validation is what makes a bad call fail before it reaches execute.
    invocationParams: (params) => parseWithZod(getSchema(), params) as TParams,
    ...(validateInputFn
      ? { invocationValidation: (params: TParams, context: ExecutionContext) =>
          validateInputFn(params, context) }
      : {}),
    invocationDescription: (params: TParams) => resolveDescription(params).short,
    execute: (params, context) => config.execute(params, context),
    ...(validateInputFn
      ? {
          validateInput: (params: unknown, context: ExecutionContext) =>
            validateInputFn(parseWithZod(getSchema(), params), context),
        }
      : {}),
    ...(checkPermissionsFn
      ? {
          checkPermissions: (params: unknown, context: ExecutionContext) =>
            checkPermissionsFn(parseWithZod(getSchema(), params), context),
        }
      : {}),
    resolveBehavior: (params: unknown) => {
      const validatedParams = parseWithZod(getSchema(), params);
      if (!config.resolveBehavior) {
        return staticBehavior;
      }
      return {
        ...staticBehavior,
        ...config.resolveBehavior(validatedParams),
      };
    },
    ...(preparePermissionMatcherFn
      ? {
          preparePermissionMatcher: (params: unknown) =>
            preparePermissionMatcherFn(parseWithZod(getSchema(), params)),
        }
      : {}),
    getBehaviorHint: () => behaviorHint,
  });
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
  const sideEffect = definition.sideEffect ?? DEFAULT_TOOL_SIDE_EFFECT;
  if (!isToolSideEffect(sideEffect)) {
    throw new TypeError('Tool sideEffect must be pure, idempotent, or non_idempotent');
  }
  const { jsonSchema, raw } = resolveDefinitionParameters(definition.parameters);
  const kind = definition.kind || ToolKind.Execute;
  const staticBehavior = createToolBehavior(kind, sideEffect, {
    isReadOnly: definition.kind ? isReadOnlyKind(definition.kind) : false,
  });

  return assembleTool<TParams>({
    name: definition.name,
    aliases: definition.aliases,
    displayName: definition.displayName || definition.name,
    kind,
    staticBehavior,
    behaviorHint: staticBehavior,
    strict: false,
    maxResultSizeChars: Number.POSITIVE_INFINITY,
    description,
    exposure: {
      mode: definition.exposure?.mode ?? 'eager',
      alwaysLoad: definition.exposure?.alwaysLoad ?? false,
      discoveryHint: definition.exposure?.discoveryHint ?? '',
    },
    version: '1.0.0',
    category: definition.category,
    tags: definition.tags || [],
    declarationDescription: () => formatToolDescription(description),
    functionSchema: () => jsonSchema,
    metadataSchema: () => raw,
    resolveDescription: () => description,
    // A Zod schema declares the contract, so validate against it the same way
    // createTool does. A plain JSON Schema stays advisory for the model.
    invocationParams: (params) =>
      isZodSchema(raw) ? (parseWithZod(raw, params) as TParams) : (params as TParams),
    execute: (params, context) => definition.execute(params, context),
    getBehaviorHint: () => staticBehavior,
    resolveBehavior: () => staticBehavior,
  });
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
  if (definition.sideEffect !== undefined && !isToolSideEffect(definition.sideEffect)) {
    throw new TypeError('Tool sideEffect must be pure, idempotent, or non_idempotent');
  }
  return definition;
}
