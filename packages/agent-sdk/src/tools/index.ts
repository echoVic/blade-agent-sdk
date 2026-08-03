import { zodToJsonSchema } from 'zod-to-json-schema';
import type { z } from 'zod';
import type { JsonObject, JsonValue, PermissionMode } from '../types/common.js';
import type {
  BladeConfig,
  ConfirmationDetails,
  ConfirmationHandler,
  ConfirmationResponse,
  ExecutionContext,
  FunctionDeclaration,
  FunctionToolCall,
  Tool,
  ToolBehavior,
  ToolConfig,
  ToolDefinition,
  ToolDescription,
  ToolDescriptionResolver,
  ToolEffect,
  ToolError,
  ToolExecutionOutcome,
  ToolExecutionOutcomeOf,
  ToolExecutionUpdate,
  ToolExecutionUpdateOf,
  ToolExposureConfig,
  ToolExposureMode,
  ToolFailureResult,
  ToolInvocation,
  ToolResult,
  ToolResultMetadata,
  ToolSchema,
  ToolSuccessResult,
  ToolValidationError,
  PreparedPermissionMatcher,
} from './types/index.js';
import { ToolErrorType } from './types/index.js';
import {
  createToolBehavior,
  getStaticToolBehavior,
  isReadOnlyKind,
  resolveToolBehavior,
  resolveToolBehaviorHint,
  resolveToolBehaviorSafely,
  ToolKind,
} from './types/ToolKind.js';

export type ToolSourceKind = 'builtin' | 'custom' | 'mcp' | 'session';
export type ToolTrustLevel = 'trusted' | 'workspace' | 'remote';

export interface ToolSourceInfo {
  kind: ToolSourceKind;
  trustLevel: ToolTrustLevel;
  sourceId: string;
}

export interface ToolCatalogEntry {
  tool: Tool;
  source: ToolSourceInfo;
}

export interface ToolCatalogSourcePolicy {
  allowedSources?: ToolSourceKind[];
  allowedTrustLevels?: ToolTrustLevel[];
}

export interface ToolCatalogReadView {
  getAll(): Tool[];
  getEntries?(): ToolCatalogEntry[];
  getFunctionDeclarationsByMode?(mode?: PermissionMode): FunctionDeclaration[];
}

const defaultCustomSource: ToolSourceInfo = {
  kind: 'custom',
  trustLevel: 'workspace',
  sourceId: 'custom',
};

const defaultMcpSource: ToolSourceInfo = {
  kind: 'mcp',
  trustLevel: 'remote',
  sourceId: 'mcp',
};

export class ToolCatalog implements ToolCatalogReadView {
  private readonly tools = new Map<string, Tool>();
  private readonly entries = new Map<string, ToolCatalogEntry>();
  private readonly mcpToolNames = new Set<string>();

  constructor(private readonly registry?: unknown) {}

  getRegistry(): unknown {
    return this.registry;
  }

  register<TParams>(
    tool: Tool<TParams>,
    source: ToolSourceInfo = defaultCustomSource,
  ): void {
    const publicTool = tool as unknown as Tool;
    this.tools.set(publicTool.name, publicTool);
    this.entries.set(publicTool.name, { tool: publicTool, source });
    if (source.kind === 'mcp') {
      this.mcpToolNames.add(publicTool.name);
    }
  }

  registerAll<TParams>(
    tools: Tool<TParams>[],
    source: ToolSourceInfo = defaultCustomSource,
  ): void {
    for (const tool of tools) {
      this.register(tool, source);
    }
  }

  registerMcpTool<TParams>(
    tool: Tool<TParams>,
    source: ToolSourceInfo = defaultMcpSource,
  ): void {
    this.register(tool, source);
    this.mcpToolNames.add(tool.name);
  }

  unregister(name: string): boolean {
    const tool = this.get(name);
    if (!tool) {
      return false;
    }
    this.tools.delete(tool.name);
    this.entries.delete(tool.name);
    this.mcpToolNames.delete(tool.name);
    return true;
  }

  removeMcpTools(serverName: string): number {
    const removedNames = [...this.mcpToolNames].filter((name) => {
      const tool = this.tools.get(name);
      return tool ? matchesMcpServer(tool, serverName) : false;
    });

    for (const name of removedNames) {
      this.unregister(name);
    }

    return removedNames.length;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name) ?? this.getByAlias(name);
  }

  has(name: string): boolean {
    return Boolean(this.get(name));
  }

  getAll(): Tool[] {
    return [...this.tools.values()];
  }

  getEntries(): ToolCatalogEntry[] {
    return this.getAll()
      .map((tool) => this.entries.get(tool.name))
      .filter((entry): entry is ToolCatalogEntry => Boolean(entry));
  }

  getEntry(name: string): ToolCatalogEntry | undefined {
    const tool = this.get(name);
    return tool ? this.entries.get(tool.name) : undefined;
  }

  getFunctionDeclarations(): FunctionDeclaration[] {
    return this.getAll().map((tool) => tool.getFunctionDeclaration());
  }

  getFunctionDeclarationsByMode(_mode?: PermissionMode): FunctionDeclaration[] {
    return this.getFunctionDeclarations();
  }

  search(query: string): Tool[] {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return this.getAll();
    }

    return this.getAll().filter((tool) => {
      const description = tool.description;
      const text = [
        tool.name,
        tool.displayName,
        description.short,
        description.long,
        tool.category,
        ...tool.tags,
      ]
        .filter((value): value is string => Boolean(value))
        .join('\n')
        .toLowerCase();
      return text.includes(normalizedQuery);
    });
  }

  private getByAlias(name: string): Tool | undefined {
    return this.getAll().find((tool) => tool.aliases?.includes(name));
  }
}

export function createTool<TSchema extends z.ZodSchema>(
  config: ToolConfig<TSchema, z.infer<TSchema>>,
): Tool<z.infer<TSchema>> {
  type TParams = z.infer<TSchema>;
  let cachedSchema: TSchema | undefined;
  let cachedFunctionSchema: FunctionDeclaration['parameters'] | undefined;
  let cachedStaticDescriptionText: string | undefined;

  const getSchema = (): TSchema => {
    cachedSchema ??= resolveToolSchema(config.schema);
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
  const exposure = normalizeExposure(config.exposure);

  const validateInputFn = config.validateInput;
  const checkPermissionsFn = config.checkPermissions;
  const preparePermissionMatcherFn = config.preparePermissionMatcher;

  return {
    name: config.name,
    aliases: config.aliases,
    displayName: config.displayName,
    kind: config.kind,
    isReadOnly: behaviorHint.isReadOnly,
    isConcurrencySafe: behaviorHint.isConcurrencySafe,
    isDestructive: behaviorHint.isDestructive,
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

    getFunctionDeclaration() {
      cachedFunctionSchema ??= zodToFunctionSchema(getSchema());
      cachedStaticDescriptionText ??= formatToolDescription(resolveDescription());

      return {
        name: config.name,
        description: cachedStaticDescriptionText,
        parameters: cachedFunctionSchema,
      };
    },

    getMetadata() {
      cachedFunctionSchema ??= zodToFunctionSchema(getSchema());

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

    build(params: TParams): ToolInvocation<TParams> {
      const validatedParams = parseWithZod(getSchema(), params);

      return new PackageToolInvocation<TParams, ToolResult>(
        config.name,
        validatedParams,
        config.execute,
        validateInputFn,
        (resolvedParams) => resolveDescription(resolvedParams).short,
        inferAffectedPaths,
      );
    },

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

export function defineTool<TParams = JsonObject, TData extends JsonValue = JsonValue>(
  definition: ToolDefinition<TParams, TData>,
): ToolDefinition<TParams, TData> {
  return definition;
}

export function toolFromDefinition<TParams = JsonObject>(
  definition: ToolDefinition<TParams>,
): Tool<TParams> {
  const description = typeof definition.description === 'string'
    ? { short: definition.description }
    : definition.description;
  const staticBehavior = createToolBehavior(definition.kind || ToolKind.Execute, {
    isReadOnly: definition.kind ? isReadOnlyKind(definition.kind) : false,
  });
  const exposure = normalizeExposure(definition.exposure);

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
    exposure,
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
        parameters: definition.parameters,
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
      return new PackageToolInvocation<TParams, ToolResult>(
        definition.name,
        params,
        (resolvedParams, context) => definition.execute(resolvedParams, context),
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

class PackageToolInvocation<
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
    ) => Promise<undefined | ToolValidationError> | undefined | ToolValidationError,
    private readonly descriptionFn?: (params: TParams) => string,
    private readonly affectedPathsFn?: (params: TParams) => string[],
  ) {}

  getDescription(): string {
    return this.descriptionFn?.(this.params) ?? `Execute tool: ${this.toolName}`;
  }

  getAffectedPaths(): string[] {
    return this.affectedPathsFn?.(this.params) ?? [];
  }

  async validate(
    context: Partial<ExecutionContext> = {},
  ): Promise<ToolValidationError | undefined> {
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

  async execute(
    signal: AbortSignal,
    updateOutput?: (output: string) => void,
    context?: Partial<ExecutionContext>,
  ): Promise<TResult> {
    const fullContext: ExecutionContext = {
      signal,
      updateOutput,
      ...context,
    };

    const validationError = await this.validate(fullContext);
    if (validationError) {
      return validationErrorToToolResult(validationError) as TResult;
    }

    return this.executeFn(this.params, fullContext);
  }
}

function formatToolDescription(description: ToolDescription): string {
  let fullDescription = description.short;

  if (description.long) {
    fullDescription += `\n\n${description.long}`;
  }

  if (description.usageNotes && description.usageNotes.length > 0) {
    fullDescription += `\n\nUsage Notes:\n${description.usageNotes.map((note) => `- ${note}`).join('\n')}`;
  }

  if (description.important && description.important.length > 0) {
    fullDescription += `\n\nImportant:\n${description.important.map((note) => `Warning: ${note}`).join('\n')}`;
  }

  return fullDescription;
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

function matchesMcpServer(tool: Tool, serverName: string): boolean {
  const legacyPrefix = `mcp__${serverName}__`;
  return tool.tags.includes(serverName) || tool.name.startsWith(legacyPrefix);
}

function normalizeExposure(exposure: ToolExposureConfig | undefined): Required<ToolExposureConfig> {
  return {
    mode: exposure?.mode ?? 'eager',
    alwaysLoad: exposure?.alwaysLoad ?? false,
    discoveryHint: exposure?.discoveryHint ?? '',
  };
}

function resolveToolSchema<TSchema extends z.ZodSchema>(
  schema: ToolSchema<TSchema>,
): TSchema {
  return typeof schema === 'function' ? (schema as () => TSchema)() : schema;
}

function parseWithZod<TSchema extends z.ZodSchema>(
  schema: TSchema,
  data: unknown,
): z.infer<TSchema> {
  const result = schema.safeParse(data);
  if (result.success) {
    return result.data;
  }

  const issues = result.error.issues.map((issue) => {
    const field = issue.path.join('.') || 'root';
    return `${field}: ${issue.message}`;
  });
  throw new Error(`Tool parameter validation failed:\n${issues.join('\n')}`);
}

function zodToFunctionSchema<TSchema extends z.ZodSchema>(
  schema: TSchema,
): FunctionDeclaration['parameters'] {
  return zodToJsonSchema(schema, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as FunctionDeclaration['parameters'];
}

export function validationErrorToToolResult(error: ToolValidationError): ToolResult {
  return {
    success: false,
    llmContent: error.llmContent ?? error.message,
    error: {
      type: error.errorType ?? ToolErrorType.VALIDATION_ERROR,
      message: error.message,
    },
    metadata: error.metadata,
  };
}

// Tool Search Utilities
export { normalizeSearchText, scoreToolSearchMatch, searchTools } from './toolSearch.js';

// Tool Exposure Planner
export { ToolExposurePlanner } from './exposure/ToolExposurePlanner.js';
export type {
  ToolDiscoveryEntry,
  ToolExposure,
  ToolExposurePlan,
  ToolExposurePlannerOptions,
  RuntimeToolPolicySnapshot,
} from './exposure/ToolExposurePlanner.js';

export type {
  BladeConfig,
  ConfirmationDetails,
  ConfirmationHandler,
  ConfirmationResponse,
  ExecutionContext,
  FunctionDeclaration,
  FunctionToolCall,
  Tool,
  ToolBehavior,
  ToolConfig,
  ToolDefinition,
  ToolDescription,
  ToolDescriptionResolver,
  ToolEffect,
  ToolError,
  ToolExecutionOutcome,
  ToolExecutionOutcomeOf,
  ToolExecutionUpdate,
  ToolExecutionUpdateOf,
  ToolExposureConfig,
  ToolExposureMode,
  ToolFailureResult,
  ToolInvocation,
  ToolResult,
  ToolResultMetadata,
  ToolSchema,
  ToolSuccessResult,
  ToolValidationError,
  PreparedPermissionMatcher,
};
export {
  createToolBehavior,
  getStaticToolBehavior,
  isReadOnlyKind,
  resolveToolBehavior,
  resolveToolBehaviorHint,
  resolveToolBehaviorSafely,
  ToolErrorType,
  ToolKind,
};
