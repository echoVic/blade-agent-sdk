import type { JSONSchema7 } from 'json-schema';
import type Type from 'typebox';
import { ToolExecutionError } from '../../errors/ToolExecutionError.js';
import type { JsonObject, JsonValue } from '../../types/json.js';
import { isToolSideEffect, resolveBehavior, type ToolBehavior, ToolKind } from '../behavior.js';
import { selectToolServices, type ToolServiceName, type ToolServices } from '../services.js';
import { type ExecutionContext, getRuntimeAccess } from '../types/execution.js';
import {
  type ToolExecution,
  type ToolResult,
  type ToolValidationError,
  validationErrorToToolResult,
} from '../types/result.js';
import type {
  ErasedToolDefinition,
  Tool,
  ToolConfig,
  ToolDefinition,
  ToolDefinitionContext,
  ToolDefinitionInput,
  ToolDescription,
  ToolExposureMode,
  ToolValidationOutcome,
} from '../types/tool.js';
import { resolveToolSchema } from '../validation/lazySchema.js';
import { type CompiledToolInput, compileToolInput } from '../validation/toolInput.js';
import { createToolInvocation, type ToolInvocation } from './ToolInvocation.js';

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
  readonly aliases?: readonly string[];
  readonly title: string;
  readonly staticBehavior: ToolBehavior;
  readonly declaration: {
    readonly name: string;
    readonly description: string;
    readonly parameters: JSONSchema7;
    readonly strict?: boolean;
  };
  readonly maxResultSizeChars: number;
  readonly services: readonly ToolServiceName[];
  readonly requiresRuntime: boolean;
  readonly description: ToolDescription;
  readonly exposure: { mode: ToolExposureMode; alwaysLoad: boolean; discoveryHint: string };
  readonly version: string;
  readonly category?: string;
  readonly tags: string[];
  readonly parse: (raw: unknown) => TParams;
  readonly resolveBehavior: (params: TParams) => ToolBehavior;
  readonly resolveDescription: (params: TParams) => string;
  readonly validateInput?: (
    params: TParams,
    context: ExecutionContext,
  ) => Promise<undefined | ToolValidationError> | undefined | ToolValidationError;
  readonly execute: (params: TParams, context: ExecutionContext) => ToolExecution;
  readonly checkPermissions?: (
    params: TParams,
    context: ExecutionContext,
  ) => ReturnType<NonNullable<Tool['checkPermissions']>>;
  readonly preparePermissionMatcher?: (params: TParams) => {
    signatureContent?: string;
  };
}

const preparedExecutors = new WeakMap<
  Tool,
  (params: JsonObject, context: ExecutionContext) => ToolExecution
>();

function assembleTool<TParams>(assembly: ToolAssembly<TParams>): Tool {
  const prepare = (raw: unknown): ToolInvocation => {
    const typedParams = assembly.parse(raw);
    const params = requireJsonObject(typedParams, assembly.name);
    const signatureContent = assembly.preparePermissionMatcher?.(typedParams).signatureContent;
    return createToolInvocation({
      params,
      behavior: assembly.resolveBehavior(typedParams),
      affectedPaths: inferAffectedPaths(params),
      permissionSignature: signatureContent
        ? `${assembly.name}:${signatureContent}`
        : assembly.name,
      description: assembly.resolveDescription(typedParams),
    });
  };

  const executePrepared = (params: JsonObject, context: ExecutionContext): ToolExecution => {
    const execution = assembly.execute(assembly.parse(params), context);
    if (!isToolExecution(execution)) {
      throw new ToolExecutionError(assembly.name, 'execute() must return an AsyncGenerator');
    }
    return execution;
  };
  const tool: Tool = {
    name: assembly.name,
    aliases: assembly.aliases ?? [],
    title: assembly.title,
    description: assembly.description,
    staticBehavior: assembly.staticBehavior,
    declaration: assembly.declaration,
    maxResultSizeChars: assembly.maxResultSizeChars,
    services: assembly.services,
    requiresRuntime: assembly.requiresRuntime,
    exposure: assembly.exposure,
    version: assembly.version,
    category: assembly.category,
    tags: assembly.tags,
    prepare,
    execute(params, context = {}) {
      return executeWithValidation(tool, params, context);
    },
    ...(assembly.validateInput
      ? {
          validate: async (
            params: JsonObject,
            context: ExecutionContext,
          ): Promise<ToolValidationOutcome> => {
            const typedParams = assembly.parse(params);
            const error = await assembly.validateInput?.(typedParams, context);
            return {
              params: requireJsonObject(typedParams, assembly.name),
              ...(error ? { error } : {}),
            };
          },
        }
      : {}),
    ...(assembly.checkPermissions
      ? {
          checkPermissions: (params: JsonObject, context: ExecutionContext) =>
            assembly.checkPermissions?.(assembly.parse(params), context),
        }
      : {}),
  };
  preparedExecutors.set(tool, executePrepared);
  return tool;
}

export function executePreparedTool(
  tool: Tool,
  params: JsonObject,
  context: ExecutionContext,
): ToolExecution {
  return preparedExecutors.get(tool)?.(params, context) ?? tool.execute(params, context);
}

function executeWithValidation(
  tool: Tool,
  raw: JsonObject,
  context: ExecutionContext,
): ToolExecution {
  return (async function* () {
    let invocation = tool.prepare(raw);
    if (tool.validate) {
      const outcome = await tool.validate(invocation.params, context);
      if (outcome.error) {
        return validationErrorToToolResult(outcome.error);
      }
      invocation = tool.prepare(outcome.params);
    }
    return yield* executePreparedTool(tool, invocation.params, context);
  })();
}

/**
 * 创建工具的工厂函数
 */
export function createTool<
  TSchema extends Type.TSchema,
  TServices extends ToolServiceName = never,
  TRequiresRuntime extends boolean = false,
>(config: ToolConfig<TSchema, TServices, TRequiresRuntime>): Tool {
  type TParams = Type.Static<TSchema>;
  const schema = resolveToolSchema(config.schema);
  const input: CompiledToolInput<TSchema> = compileToolInput(schema);
  const resolveDescription = (params?: TParams) => config.describe?.(params) ?? config.description;

  if (!isToolSideEffect(config.sideEffect)) {
    throw new TypeError('Tool sideEffect must be pure, idempotent, or non_idempotent');
  }
  const staticBehavior = resolveBehavior(config);
  if (!staticBehavior) {
    throw new TypeError('Tool behavior could not be resolved');
  }
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
    title: config.displayName,
    staticBehavior,
    declaration: Object.freeze({
      name: config.name,
      description: formatToolDescription(config.description),
      parameters: toFunctionSchema(schema),
      ...(config.strict ? { strict: true } : {}),
    }),
    maxResultSizeChars: config.maxResultSizeChars ?? Number.POSITIVE_INFINITY,
    services: config.services ?? [],
    requiresRuntime: config.requiresRuntime ?? false,
    description: config.description,
    exposure,
    version: config.version || '1.0.0',
    category: config.category,
    tags: config.tags || [],
    parse: (params) => input.parse(params),
    resolveBehavior: (params) => resolveBehavior(config, params) ?? staticBehavior,
    resolveDescription: (params) => resolveDescription(params).short,
    ...(validateInputFn
      ? {
          validateInput: (params: TParams, context: ExecutionContext) =>
            validateInputFn(params, context),
        }
      : {}),
    execute: (params, context) =>
      config.execute(
        params,
        createConfiguredToolContext<TServices, TRequiresRuntime>(
          context,
          config.requiresRuntime ?? false,
        ),
      ),
    ...(checkPermissionsFn
      ? {
          checkPermissions: (params: TParams, context: ExecutionContext) =>
            checkPermissionsFn(params, context),
        }
      : {}),
    ...(preparePermissionMatcherFn
      ? {
          preparePermissionMatcher: (params: TParams) => preparePermissionMatcherFn(params),
        }
      : {}),
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
export function toolFromDefinition<
  TSchema extends Type.TSchema,
  TData extends JsonValue = JsonValue,
  TServices extends ToolServiceName = never,
  TRequiresRuntime extends boolean = false,
>(
  definition: ToolDefinition<TSchema, TData, TServices, TRequiresRuntime>,
  services?: ToolServices,
): Tool;
export function toolFromDefinition(definition: ErasedToolDefinition, services?: ToolServices): Tool;
export function toolFromDefinition(
  definition: ErasedToolDefinition,
  services: ToolServices = {},
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
  const staticBehavior = resolveBehavior({
    kind,
    sideEffect,
    isReadOnly: definition.kind ? definition.kind === ToolKind.ReadOnly : false,
  });
  if (!staticBehavior) {
    throw new TypeError('Tool behavior could not be resolved');
  }
  const serviceSelection = selectToolServices(services, definition.services);
  if (serviceSelection.missing.length > 0) {
    throw new TypeError(
      `Tool '${definition.name}' requires unavailable services: ${serviceSelection.missing.join(', ')}`,
    );
  }
  const requiresRuntime = definition.requiresRuntime ?? false;

  return assembleTool<unknown>({
    name: definition.name,
    aliases: definition.aliases,
    title: definition.displayName || definition.name,
    staticBehavior,
    declaration: Object.freeze({
      name: definition.name,
      description: formatToolDescription(description),
      parameters: toFunctionSchema(definition.parameters),
    }),
    maxResultSizeChars: Number.POSITIVE_INFINITY,
    services: definition.services ?? [],
    requiresRuntime,
    description,
    exposure: {
      mode: definition.exposure?.mode ?? 'eager',
      alwaysLoad: definition.exposure?.alwaysLoad ?? false,
      discoveryHint: definition.exposure?.discoveryHint ?? '',
    },
    version: '1.0.0',
    category: definition.category,
    tags: definition.tags || [],
    parse: (params) => input.parse(params),
    resolveBehavior: () => staticBehavior,
    resolveDescription: () => description.short,
    execute: (params, context) =>
      executeErasedDefinition(
        definition,
        params,
        createDefinitionContext(context, serviceSelection.selected, requiresRuntime),
      ),
  });
}

function inferAffectedPaths(params: unknown): string[] {
  if (!params || typeof params !== 'object') {
    return [];
  }

  const candidates = new Set<string>();
  for (const [key, value] of Object.entries(params)) {
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

function executeErasedDefinition(
  definition: ErasedToolDefinition,
  params: unknown,
  context: ExecutionContext,
): ToolExecution {
  // Session erases heterogeneous parameter types only after schema validation.
  return definition.execute.apply(undefined, [params, context] as never);
}

function createConfiguredToolContext<
  TServices extends ToolServiceName,
  TRequiresRuntime extends boolean,
>(
  context: ExecutionContext,
  requiresRuntime: boolean,
): ToolDefinitionContext<TServices, TRequiresRuntime> {
  const { runtime: _runtime, ...base } = context;
  return Object.freeze({
    ...base,
    ...(requiresRuntime ? { runtime: Object.freeze(getRuntimeAccess(context)) } : {}),
  }) as ToolDefinitionContext<TServices, TRequiresRuntime>;
}

function createDefinitionContext(
  context: ExecutionContext,
  services: ToolServices,
  requiresRuntime: boolean,
): ExecutionContext & ToolServices {
  const executionServices =
    services.discoverableCatalog && context.discoverableCatalog
      ? { ...services, discoverableCatalog: context.discoverableCatalog }
      : services;
  return Object.freeze({
    signal: context.signal,
    sessionId: context.sessionId,
    messageId: context.messageId,
    contextSnapshot: context.contextSnapshot,
    permissionMode: context.permissionMode,
    confirmationHandler: context.confirmationHandler,
    bladeConfig: context.bladeConfig,
    ...executionServices,
    ...(requiresRuntime ? { runtime: Object.freeze(getRuntimeAccess(context)) } : {}),
  });
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
export function defineTool<
  TSchema extends Type.TSchema,
  TData extends JsonValue = JsonValue,
  TServices extends ToolServiceName = never,
  TRequiresRuntime extends boolean = false,
>(
  definition: ToolDefinitionInput<TSchema, TData, TServices, TRequiresRuntime>,
): ToolDefinition<TSchema, TData, TServices, TRequiresRuntime> {
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
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return (
    typeof Reflect.get(value, 'next') === 'function' &&
    typeof Reflect.get(value, Symbol.asyncIterator) === 'function'
  );
}

function isToolExecution(value: unknown): value is ToolExecution {
  return isAsyncGenerator(value);
}

function requireJsonObject(value: unknown, toolName: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new TypeError(`Tool '${toolName}' parameters must be a JSON object`);
  }
  return value;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** TypeBox schemas are JSON Schema values; this is their single model boundary. */
function toFunctionSchema(schema: Type.TSchema): JSONSchema7 {
  return schema as JSONSchema7;
}
