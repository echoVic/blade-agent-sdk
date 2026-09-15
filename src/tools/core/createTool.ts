import type { JSONSchema7 } from 'json-schema';
import type Type from 'typebox';
import type { JsonObject, JsonValue } from '../../types/json.js';
import type { ExecutionContext } from '../types/execution.js';
import type { ToolBehavior } from '../types/kind.js';
import { createToolBehavior, isReadOnlyKind, isToolSideEffect, ToolKind } from '../types/kind.js';
import type { ToolExecution, ToolResult, ToolValidationError } from '../types/result.js';
import type {
  Tool,
  ToolConfig,
  ToolDefinition,
  ToolDefinitionInput,
  ToolDescription,
  ErasedToolDefinition,
  ToolExposureMode,
  ToolInvocation,
} from '../types/tool.js';
import { resolveToolSchema } from '../validation/lazySchema.js';
import { compileToolInput, type CompiledToolInput } from '../validation/toolInput.js';
import { UnifiedToolInvocation } from './ToolInvocation.js';

/**
 * A tool that does not declare how a repeated execution behaves is treated as
 * non-idempotent, so recovery never replays it without an explicit opt-in.
 */
const DEFAULT_TOOL_SIDE_EFFECT = 'non_idempotent' as const;

/**
 * Assembles the `Tool` object from already-normalised inputs.
 *
 * Both authoring entry points share the same TypeBox validation path. Keeping a
 * single assembler stops the resulting runtime tools from drifting.
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
  readonly functionSchema: () => JSONSchema7;
  /** TypeBox schema used to validate params. */
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
export function createTool<TSchema extends Type.TSchema>(
  config: ToolConfig<TSchema>,
): Tool<Type.Static<TSchema>> {
  type TParams = Type.Static<TSchema>;
  let cachedSchema: TSchema | undefined;
  let cachedInput: CompiledToolInput<TSchema> | undefined;
  let cachedStaticDescriptionText: string | undefined;

  const getSchema = (): TSchema => {
    if (!cachedSchema) {
      cachedSchema = resolveToolSchema(config.schema);
    }
    return cachedSchema;
  };
  const getInput = (): CompiledToolInput<TSchema> => {
    if (!cachedInput) {
      cachedInput = compileToolInput(getSchema());
    }
    return cachedInput;
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
    functionSchema: () => getSchema() as JSONSchema7,
    metadataSchema: () => getSchema(),
    resolveDescription: (params?: unknown) =>
      resolveDescription(params === undefined ? undefined : getInput().parse(params)),
    invocationParams: (params) => getInput().parse(params),
    ...(validateInputFn
      ? {
          invocationValidation: (params: TParams, context: ExecutionContext) =>
            validateInputFn(params, context),
        }
      : {}),
    invocationDescription: (params: TParams) => resolveDescription(params).short,
    execute: (params, context) => config.execute(params, context),
    ...(validateInputFn
      ? {
          validateInput: (params: unknown, context: ExecutionContext) =>
            validateInputFn(getInput().parse(params), context),
        }
      : {}),
    ...(checkPermissionsFn
      ? {
          checkPermissions: (params: unknown, context: ExecutionContext) =>
            checkPermissionsFn(getInput().parse(params), context),
        }
      : {}),
    resolveBehavior: (params: unknown) => {
      const validatedParams = getInput().parse(params);
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
            preparePermissionMatcherFn(getInput().parse(params)),
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
export function toolFromDefinition<TSchema extends Type.TSchema>(
  definition: ToolDefinition<TSchema>,
): Tool<Type.Static<TSchema>>;
export function toolFromDefinition(definition: ErasedToolDefinition): Tool;
export function toolFromDefinition(
  definition: ToolDefinition<Type.TSchema> | ErasedToolDefinition,
): Tool {
  const description =
    typeof definition.description === 'string'
      ? { short: definition.description }
      : definition.description;
  const sideEffect = definition.sideEffect ?? DEFAULT_TOOL_SIDE_EFFECT;
  if (!isToolSideEffect(sideEffect)) {
    throw new TypeError('Tool sideEffect must be pure, idempotent, or non_idempotent');
  }
  const input = compileToolInput(definition.parameters);
  const kind = definition.kind || ToolKind.Execute;
  const staticBehavior = createToolBehavior(kind, sideEffect, {
    isReadOnly: definition.kind ? isReadOnlyKind(definition.kind) : false,
  });

  return assembleTool<unknown>({
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
    functionSchema: () => definition.parameters as JSONSchema7,
    metadataSchema: () => definition.parameters,
    resolveDescription: () => description,
    invocationParams: (params) => input.parse(params),
    execute: (params, context) => definition.execute(params as never, context),
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
 *   parameters: Type.Object({ message: Type.String() }),
 *   async execute({ message }) {
 *     return { received: message };
 *   }
 * });
 * ```
 */
export function defineTool<TSchema extends Type.TSchema, TData extends JsonValue = JsonValue>(
  definition: ToolDefinitionInput<TSchema, TData>,
): ToolDefinition<TSchema, TData> {
  if (definition.sideEffect !== undefined && !isToolSideEffect(definition.sideEffect)) {
    throw new TypeError('Tool sideEffect must be pure, idempotent, or non_idempotent');
  }
  return {
    ...definition,
    execute: (params, context) => normalizeToolExecution(definition.execute(params, context)),
  };
}

function normalizeToolExecution<TData extends JsonValue>(
  execution: ToolExecution<TData> | Promise<TData | ToolResult<TData>>,
): ToolExecution<TData> {
  return (async function* () {
    if (isAsyncGenerator(execution)) {
      return yield* execution;
    }
    const result = await execution;
    if (isToolResult(result)) {
      return result;
    }
    return {
      status: 'success',
      model: result,
      data: result,
    };
  })();
}

function isToolResult<TData extends JsonValue>(
  value: TData | ToolResult<TData>,
): value is ToolResult<TData> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'status' in value &&
    'model' in value &&
    (value.status === 'success' || value.status === 'error')
  );
}

function isAsyncGenerator<TData extends JsonValue>(value: unknown): value is ToolExecution<TData> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { next?: unknown }).next === 'function' &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
  );
}
