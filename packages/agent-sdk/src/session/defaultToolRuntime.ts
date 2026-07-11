import type { AgentToolPort } from '@blade-ai/agent/ports';
import type { AgentToolResult } from '@blade-ai/agent/protocol';
import { createPackageLocalKernelTracePort } from './kernelTracePort.js';
import type {
  PackageLocalRuntimeExecutionPipelineCreateOptions,
  PackageLocalRuntimeExecutionPipelineFactoryPort,
} from './runtimeExecutionPipeline.js';
import type {
  PackageLocalRuntimeKernelPortFactoryPort,
  PackageLocalRuntimeKernelToolPortCreateOptions,
} from './runtimeKernelPorts.js';
import type {
  PackageLocalRuntimeCustomToolFactoryPort,
  PackageLocalRuntimeNamedTool,
  PackageLocalRuntimeToolCatalogPort,
  PackageLocalRuntimeToolSource,
} from './runtimePorts.js';
import {
  ToolCatalog,
  toolFromDefinition,
  resolveToolBehaviorSafely,
} from '../tools/index.js';
import type {
  ExecutionContext,
  Tool,
  ToolEffect,
  ToolResult,
} from '../tools/types/index.js';
import { ToolErrorType } from '../tools/types/index.js';
import { ToolKind } from '../tools/types/ToolKind.js';
import type { JsonObject, JsonValue } from '../types/common.js';
import { PermissionMode } from '../types/common.js';
import {
  createModePermissionHandler,
  createPathSafetyPermissionHandler,
  matchesPermissionRule,
  type PermissionHandlerRequest,
  type PermissionResult,
} from '../types/permissions.js';

interface DefaultToolCatalogPort extends PackageLocalRuntimeToolCatalogPort {
  get(name: string): Tool | undefined;
  getAll(): Tool[];
}

interface DefaultExecutionPipelinePort {
  execute(
    toolName: string,
    params: JsonObject,
    context: ExecutionContext,
  ): Promise<ToolResult>;
}

export interface DefaultToolRuntimePorts {
  toolCatalog: DefaultToolCatalogPort;
  customToolFactory: PackageLocalRuntimeCustomToolFactoryPort;
  executionPipelineFactory: PackageLocalRuntimeExecutionPipelineFactoryPort;
  kernelPortFactory: PackageLocalRuntimeKernelPortFactoryPort;
}

export function createDefaultToolRuntimePorts(): DefaultToolRuntimePorts {
  const toolCatalog = createDefaultToolCatalog();

  return {
    toolCatalog,
    customToolFactory: {
      fromDefinition: toolFromDefinition,
    },
    executionPipelineFactory: {
      create(options) {
        return createDefaultExecutionPipeline(options);
      },
    },
    kernelPortFactory: createDefaultKernelPortFactory(),
  };
}

function createDefaultToolCatalog(): DefaultToolCatalogPort {
  const catalog = new ToolCatalog();

  return {
    get(name) {
      return catalog.get(name);
    },
    getAll() {
      return catalog.getAll();
    },
    registerAll<TTool extends PackageLocalRuntimeNamedTool>(
      tools: TTool[],
      source: PackageLocalRuntimeToolSource,
    ) {
      for (const tool of tools) {
        if (isTool(tool)) {
          catalog.register(tool, source);
        }
      }
    },
    registerMcpTool<TTool extends PackageLocalRuntimeNamedTool>(
      tool: TTool,
      source: PackageLocalRuntimeToolSource,
    ) {
      if (isTool(tool)) {
        catalog.registerMcpTool(tool, source);
      }
    },
    removeMcpTools(serverName) {
      return catalog.removeMcpTools(serverName);
    },
  };
}

function isTool(value: PackageLocalRuntimeNamedTool): value is Tool {
  return (
    typeof (value as Partial<Tool>).getFunctionDeclaration === 'function'
    && typeof (value as Partial<Tool>).build === 'function'
    && typeof (value as Partial<Tool>).execute === 'function'
  );
}

function createDefaultExecutionPipeline(
  options: PackageLocalRuntimeExecutionPipelineCreateOptions,
): DefaultExecutionPipelinePort {
  const catalog = requireToolCatalog(options.toolCatalog);
  const modePermissionHandler = createModePermissionHandler(options.permissionMode);
  const pathSafetyHandler = createPathSafetyPermissionHandler({
    explicitAllowRules: options.permissionConfig.allow,
  });

  return {
    async execute(toolName, params, context) {
      const tool = catalog.get(toolName);
      if (!tool) {
        return finalizeToolResult(
          options,
          toolName,
          params,
          context,
          failureResult(`Tool "${toolName}" not found`),
        );
      }

      let state: DefaultExecutionState | undefined;
      try {
        state = createExecutionState(tool, params, context, options.permissionMode);
        const initialAbortResult = abortedResult(state.signal);
        if (initialAbortResult) {
          return finalizeExecutionState(options, toolName, state, initialAbortResult);
        }
        const preHookResult = await options.hookRuntime?.applyPreToolUse?.(
          toolName,
          state.input,
          {
            permissionMode: state.context.permissionMode,
            abortSignal: state.signal,
          },
        );
        if (preHookResult) {
          Object.assign(state.input, preHookResult.updatedInput);
          rebuildExecutionState(state);
          if (preHookResult.action === 'abort') {
            return finalizeExecutionState(
              options,
              toolName,
              state,
              permissionFailureResult(
                preHookResult.reason || `Tool "${toolName}" was aborted by hook`,
              ),
            );
          }
          if (preHookResult.action === 'skip') {
            return finalizeExecutionState(options, toolName, state, {
              success: true,
              llmContent: preHookResult.reason || `Tool "${toolName}" was skipped by hook`,
            });
          }
          if (preHookResult.needsConfirmation) {
            state.requiresConfirmation = true;
            if (preHookResult.reason) state.confirmationMessages.push(preHookResult.reason);
          }
        }
        const postPreHookAbortResult = abortedResult(state.signal);
        if (postPreHookAbortResult) {
          return finalizeExecutionState(options, toolName, state, postPreHookAbortResult);
        }
        const toolDecision = tool.checkPermissions
          ? await tool.checkPermissions(state.input, state.context)
          : undefined;
        const toolDecisionResult = applyPermissionDecision(state, toolDecision);
        if (toolDecisionResult) {
          return finalizeExecutionState(options, toolName, state, toolDecisionResult);
        }
        const postToolPermissionAbortResult = abortedResult(state.signal);
        if (postToolPermissionAbortResult) {
          return finalizeExecutionState(options, toolName, state, postToolPermissionAbortResult);
        }

        const ruleDecision = resolveRuleDecision(
          state.request.toolMeta.signature ?? toolName,
          options.permissionConfig,
        );
        const ruleDecisionResult = applyPermissionDecision(state, ruleDecision);
        if (ruleDecisionResult) {
          return finalizeExecutionState(options, toolName, state, ruleDecisionResult);
        }

        const pathDecision = await pathSafetyHandler(state.request);
        const pathDecisionResult = applyPermissionDecision(state, pathDecision);
        if (pathDecisionResult) {
          return finalizeExecutionState(options, toolName, state, pathDecisionResult);
        }

        if (options.permissionHandler) {
          const handlerDecision = await options.permissionHandler(state.request);
          const handlerDecisionResult = applyPermissionDecision(state, handlerDecision, true);
          if (handlerDecisionResult) {
            return finalizeExecutionState(options, toolName, state, handlerDecisionResult);
          }
          const postHandlerAbortResult = abortedResult(state.signal);
          if (postHandlerAbortResult) {
            return finalizeExecutionState(options, toolName, state, postHandlerAbortResult);
          }
        }

        const modeDecision = await modePermissionHandler(state.request);
        const modeDecisionResult = applyPermissionDecision(state, modeDecision);
        if (modeDecisionResult) {
          return finalizeExecutionState(options, toolName, state, modeDecisionResult);
        }

        const authorizationResult = await resolveAuthorization(state);
        if (authorizationResult) {
          return finalizeExecutionState(options, toolName, state, authorizationResult);
        }
        const preExecutionAbortResult = abortedResult(state.signal);
        if (preExecutionAbortResult) {
          return finalizeExecutionState(options, toolName, state, preExecutionAbortResult);
        }

        const invocation = tool.build(state.input);
        const result = await invocation.execute(
          state.signal,
          createOutputUpdater(state.context),
          state.context,
        );
        return finalizeExecutionState(options, toolName, state, result);
      } catch (error) {
        return finalizeToolResult(
          options,
          toolName,
          state?.input ?? params,
          state?.context ?? context,
          failureResult(
            `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
          state?.permissionEffects,
        );
      }
    },
  };
}

function finalizeExecutionState(
  options: PackageLocalRuntimeExecutionPipelineCreateOptions,
  toolName: string,
  state: DefaultExecutionState,
  result: ToolResult,
): Promise<ToolResult> {
  return finalizeToolResult(
    options,
    toolName,
    state.input,
    state.context,
    result,
    state.permissionEffects,
  );
}

async function finalizeToolResult(
  options: PackageLocalRuntimeExecutionPipelineCreateOptions,
  toolName: string,
  input: JsonObject,
  context: ExecutionContext,
  result: ToolResult,
  permissionEffects: ToolEffect[] = [],
): Promise<ToolResult> {
  const resultWithEffects = mergePermissionEffects(result, permissionEffects);
  const hookOptions = {
    permissionMode: context.permissionMode,
    abortSignal: context.signal,
  };

  if (!resultWithEffects.success) {
    return applyFailureHooksSafely(options, toolName, input, resultWithEffects, hookOptions);
  }

  try {
    const postHookResult = await options.hookRuntime?.applyPostToolUse?.(
      toolName,
      input,
      resultWithEffects,
      hookOptions,
    );
    if (postHookResult?.action === 'abort') {
      return failureResult(
        postHookResult.reason || `Tool "${toolName}" post-execution hook aborted`,
      );
    }
    return postHookResult?.result ?? resultWithEffects;
  } catch (error) {
    return applyFailureHooksSafely(
      options,
      toolName,
      input,
      failureResult(
        `PostToolUse hook failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
      hookOptions,
    );
  }
}

async function applyFailureHooksSafely(
  options: PackageLocalRuntimeExecutionPipelineCreateOptions,
  toolName: string,
  input: JsonObject,
  result: ToolResult,
  hookOptions: {
    permissionMode?: PermissionMode;
    abortSignal?: AbortSignal;
  },
): Promise<ToolResult> {
  try {
    const postHookResult = await options.hookRuntime?.applyPostToolUseFailure?.(
      toolName,
      input,
      result,
      hookOptions,
    );
    if (postHookResult?.action === 'abort') {
      return failureResult(
        postHookResult.reason || `Tool "${toolName}" post-execution hook aborted`,
      );
    }
    return postHookResult?.result ?? result;
  } catch {
    return result;
  }
}

function abortedResult(signal: AbortSignal): ToolResult | undefined {
  if (!signal.aborted) return undefined;
  const reason = signal.reason instanceof Error
    ? signal.reason.message
    : typeof signal.reason === 'string'
      ? signal.reason
      : 'Tool execution aborted';
  return failureResult(`Tool execution aborted: ${reason}`);
}

interface DefaultExecutionState {
  tool: Tool;
  input: JsonObject;
  context: ExecutionContext;
  signal: AbortSignal;
  request: PermissionHandlerRequest;
  requiresConfirmation: boolean;
  confirmationMessages: string[];
  explicitlyAllowed: boolean;
  permissionEffects: ToolEffect[];
}

function createExecutionState(
  tool: Tool,
  params: JsonObject,
  context: ExecutionContext,
  permissionMode: PermissionMode,
): DefaultExecutionState {
  const input = { ...params };
  const signal = context.signal ?? new AbortController().signal;
  const nextContext = {
    ...context,
    signal,
    permissionMode: context.permissionMode ?? permissionMode,
  };
  const invocation = tool.build(input);
  const behavior = resolveToolBehaviorSafely(tool, input);
  const toolKind = behavior?.kind ?? tool.kind ?? ToolKind.Execute;
  const signatureContent = tool.preparePermissionMatcher?.(input)?.signatureContent;

  return {
    tool,
    input,
    context: nextContext,
    signal,
    request: {
      toolName: tool.name,
      input,
      signal,
      permissionMode: nextContext.permissionMode,
      affectedPaths: invocation.getAffectedPaths(),
      toolKind,
      toolMeta: {
        isReadOnly: behavior?.isReadOnly ?? false,
        isConcurrencySafe: behavior?.isConcurrencySafe ?? false,
        isDestructive: behavior?.isDestructive ?? false,
        signature: signatureContent ? `${tool.name}:${signatureContent}` : tool.name,
        description: invocation.getDescription(),
      },
    },
    requiresConfirmation: false,
    confirmationMessages: [],
    explicitlyAllowed: false,
    permissionEffects: [],
  };
}

function applyPermissionDecision(
  state: DefaultExecutionState,
  decision: PermissionResult | undefined,
  explicit = false,
): ToolResult | undefined {
  if (!decision) return undefined;

  if (decision.behavior === 'deny') {
    return permissionFailureResult(decision.message, decision.interrupt);
  }

  if (decision.behavior === 'ask') {
    state.requiresConfirmation = true;
    if (decision.message) state.confirmationMessages.push(decision.message);
    return undefined;
  }

  if (decision.updatedInput) {
    Object.assign(state.input, decision.updatedInput);
    rebuildExecutionState(state);
  }
  if (decision.effects) state.permissionEffects.push(...decision.effects);
  if (decision.updatedPermissions && decision.updatedPermissions.length > 0) {
    state.permissionEffects.push({
      type: 'permissionUpdates',
      updates: decision.updatedPermissions,
    });
  }
  if (explicit) state.explicitlyAllowed = true;
  return undefined;
}

function rebuildExecutionState(state: DefaultExecutionState): void {
  const invocation = state.tool.build(state.input);
  const behavior = resolveToolBehaviorSafely(state.tool, state.input);
  const toolKind = behavior?.kind ?? state.tool.kind ?? ToolKind.Execute;
  const signatureContent = state.tool.preparePermissionMatcher?.(state.input)?.signatureContent;

  state.request.input = state.input;
  state.request.affectedPaths = invocation.getAffectedPaths();
  state.request.toolKind = toolKind;
  state.request.toolMeta = {
    isReadOnly: behavior?.isReadOnly ?? false,
    isConcurrencySafe: behavior?.isConcurrencySafe ?? false,
    isDestructive: behavior?.isDestructive ?? false,
    signature: signatureContent ? `${state.tool.name}:${signatureContent}` : state.tool.name,
    description: invocation.getDescription(),
  };
}

function resolveRuleDecision(
  signature: string,
  config: PackageLocalRuntimeExecutionPipelineCreateOptions['permissionConfig'],
): PermissionResult | undefined {
  if (config.deny.some((rule) => matchesPermissionRule(signature, rule))) {
    return { behavior: 'deny', message: 'Denied by permission rule' };
  }
  if (config.allow.some((rule) => matchesPermissionRule(signature, rule))) {
    return { behavior: 'allow' };
  }
  if (config.ask.some((rule) => matchesPermissionRule(signature, rule))) {
    return { behavior: 'ask', message: 'Requires user confirmation' };
  }
  return undefined;
}

async function resolveAuthorization(
  state: DefaultExecutionState,
): Promise<ToolResult | undefined> {
  if (!state.requiresConfirmation) return undefined;
  if (state.context.permissionMode === PermissionMode.YOLO || state.explicitlyAllowed) {
    return undefined;
  }

  const confirmationHandler = state.context.confirmationHandler;
  if (!confirmationHandler) {
    return permissionFailureResult(
      state.confirmationMessages.join('; ') || 'User confirmation required',
    );
  }

  const response = await confirmationHandler.requestConfirmation({
    type: 'permission',
    kind: state.request.toolKind,
    toolName: state.request.toolName,
    args: state.input,
    title: `Permission required: ${state.request.toolName}`,
    message: state.confirmationMessages.join('; ') || 'User confirmation required',
    affectedFiles: state.request.affectedPaths,
  });
  return response.approved
    ? undefined
    : permissionFailureResult(response.reason || 'User denied tool execution');
}

function createDefaultKernelPortFactory(): PackageLocalRuntimeKernelPortFactoryPort {
  return {
    createToolPort(options) {
      return createDefaultKernelToolPort(options);
    },
    createStorePort(options) {
      return {
        appendMessage(message, context) {
          return options.sessionStore.appendMessage(options.sessionId, message, context);
        },
      };
    },
    createTracePort(options) {
      return createPackageLocalKernelTracePort(options);
    },
    createHookPort(options) {
      return options.hookRuntime.createAgentHookPort?.() ?? {};
    },
  };
}

function createDefaultKernelToolPort(
  options: PackageLocalRuntimeKernelToolPortCreateOptions,
): AgentToolPort {
  const catalog = requireToolCatalog(options.toolCatalog);
  const pipeline = requireExecutionPipeline(options.executionPipeline);

  return {
    async list() {
      return catalog.getAll().map((tool) => {
        const declaration = tool.getFunctionDeclaration();
        return {
          name: declaration.name,
          description: declaration.description,
          parameters: declaration.parameters as unknown as JsonObject,
          ...(tool.strict ? { strict: true } : {}),
        };
      });
    },
    async execute(toolCall, signal) {
      const result = await pipeline.execute(
        toolCall.name,
        toolCall.input,
        options.createExecutionContext(toolCall, signal),
      );
      return toAgentToolResult(toolCall.id, toolCall.name, result);
    },
  };
}

function requireToolCatalog(value: unknown): DefaultToolCatalogPort {
  if (
    !value
    || typeof value !== 'object'
    || typeof (value as Partial<DefaultToolCatalogPort>).get !== 'function'
    || typeof (value as Partial<DefaultToolCatalogPort>).getAll !== 'function'
  ) {
    throw new Error('Package-local tool catalog must support get() and getAll()');
  }
  return value as DefaultToolCatalogPort;
}

function requireExecutionPipeline(value: unknown): DefaultExecutionPipelinePort {
  if (
    !value
    || typeof value !== 'object'
    || typeof (value as Partial<DefaultExecutionPipelinePort>).execute !== 'function'
  ) {
    throw new Error('Package-local execution pipeline must support execute()');
  }
  return value as DefaultExecutionPipelinePort;
}

function toAgentToolResult(
  id: string,
  name: string,
  result: ToolResult,
): AgentToolResult {
  const permissionEffects = (result.effects ?? [])
    .filter((effect) => effect.type === 'permissionUpdates')
    .map((effect) => ({
      type: 'permissionUpdates' as const,
      updates: effect.updates,
    }));

  return {
    id,
    name,
    output: normalizeToolOutput(result.llmContent),
    ...(permissionEffects.length > 0 ? { effects: permissionEffects } : {}),
    ...(!result.success ? { isError: true } : {}),
  };
}

function normalizeToolOutput(output: string | object): string | JsonObject {
  if (typeof output === 'string') return output;
  return isJsonObject(output) ? output : JSON.stringify(output);
}

function isJsonObject(value: unknown): value is JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}

function createOutputUpdater(
  context: ExecutionContext,
): ((output: string) => void) | undefined {
  if (!context.updateOutput && !context.onProgress) return undefined;
  return (output) => {
    void context.updateOutput?.(output);
    void context.onProgress?.(output);
  };
}

function mergePermissionEffects(
  result: ToolResult,
  permissionEffects: ToolEffect[],
): ToolResult {
  if (permissionEffects.length === 0) return result;
  return {
    ...result,
    effects: [...(result.effects ?? []), ...permissionEffects],
  };
}

function permissionFailureResult(message: string, shouldExitLoop = false): ToolResult {
  return {
    success: false,
    llmContent: message,
    error: {
      message,
      type: ToolErrorType.PERMISSION_DENIED,
    },
    ...(shouldExitLoop ? { metadata: { shouldExitLoop: true } } : {}),
  };
}

function failureResult(message: string): ToolResult {
  return {
    success: false,
    llmContent: message,
    error: {
      message,
      type: ToolErrorType.EXECUTION_ERROR,
    },
  };
}
