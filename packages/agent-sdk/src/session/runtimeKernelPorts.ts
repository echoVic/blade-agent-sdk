import type { AgentHookPort, AgentToolPort } from '@blade-ai/agent/ports';
import type { AgentToolCall } from '@blade-ai/agent/protocol';
import type { AgentStoreAppendContext, AgentStorePort } from '@blade-ai/agent/state';
import type { AgentTracePort } from '@blade-ai/agent/tracing';
import type { ModelMessage } from '@blade-ai/ai';
import type { TraceRecorder } from '../observability/TraceRecorder.js';
import type { ExecutionContext } from '../tools/types/index.js';
import type { SessionId } from './types.js';
import type { PackageLocalRuntimeHookRuntimePort } from './runtimeHooks.js';

export interface PackageLocalRuntimeKernelToolPortCreateOptions {
  toolCatalog: unknown;
  executionPipeline: unknown;
  createExecutionContext: (
    toolCall: AgentToolCall,
    signal?: AbortSignal,
  ) => ExecutionContext;
}

export interface PackageLocalRuntimeKernelStorePortCreateOptions {
  sessionId: SessionId;
  sessionStore: PackageLocalRuntimeKernelSessionStorePort;
}

export interface PackageLocalRuntimeKernelTracePortCreateOptions {
  recorder: TraceRecorder;
  maxContextTokens?: number;
}

export interface PackageLocalRuntimeKernelHookPortCreateOptions {
  hookRuntime: PackageLocalRuntimeHookRuntimePort;
}

export interface PackageLocalRuntimeKernelPortFactoryPort {
  createToolPort(options: PackageLocalRuntimeKernelToolPortCreateOptions): AgentToolPort;
  createStorePort(options: PackageLocalRuntimeKernelStorePortCreateOptions): AgentStorePort;
  createTracePort(options: PackageLocalRuntimeKernelTracePortCreateOptions): AgentTracePort;
  createHookPort(options: PackageLocalRuntimeKernelHookPortCreateOptions): AgentHookPort;
}

export interface PackageLocalRuntimeKernelSessionStorePort {
  appendMessage(
    sessionId: SessionId,
    message: ModelMessage,
    context: AgentStoreAppendContext,
  ): Promise<void> | void;
}

export interface CreatePackageLocalRuntimeKernelToolPortOptions
  extends PackageLocalRuntimeKernelToolPortCreateOptions {
  kernelPortFactory: PackageLocalRuntimeKernelPortFactoryPort;
}

export interface CreatePackageLocalRuntimeKernelStorePortOptions
  extends PackageLocalRuntimeKernelStorePortCreateOptions {
  kernelPortFactory: PackageLocalRuntimeKernelPortFactoryPort;
}

export interface CreatePackageLocalRuntimeKernelTracePortOptions
  extends PackageLocalRuntimeKernelTracePortCreateOptions {
  kernelPortFactory: PackageLocalRuntimeKernelPortFactoryPort;
}

export interface CreatePackageLocalRuntimeKernelHookPortOptions
  extends PackageLocalRuntimeKernelHookPortCreateOptions {
  kernelPortFactory: PackageLocalRuntimeKernelPortFactoryPort;
}

export interface PackageLocalRuntimeKernelPortOperations {
  createToolPort(
    createExecutionContext: (
      toolCall: AgentToolCall,
      signal?: AbortSignal,
    ) => ExecutionContext,
  ): AgentToolPort;
  createStorePort(): AgentStorePort;
  createTracePort(recorder: TraceRecorder, maxContextTokens?: number): AgentTracePort;
  createHookPort(): AgentHookPort;
}

export interface CreatePackageLocalRuntimeKernelPortOperationsOptions {
  kernelPortFactory: PackageLocalRuntimeKernelPortFactoryPort;
  toolCatalog: unknown;
  createExecutionPipeline(): unknown;
  sessionId: SessionId;
  sessionStore: PackageLocalRuntimeKernelSessionStorePort;
  hookRuntime: PackageLocalRuntimeHookRuntimePort;
}

export function createPackageLocalRuntimeKernelPortOperations(
  options: CreatePackageLocalRuntimeKernelPortOperationsOptions,
): PackageLocalRuntimeKernelPortOperations {
  return {
    createToolPort(createExecutionContext) {
      return createPackageLocalRuntimeKernelToolPort({
        kernelPortFactory: options.kernelPortFactory,
        toolCatalog: options.toolCatalog,
        executionPipeline: options.createExecutionPipeline(),
        createExecutionContext,
      });
    },
    createStorePort() {
      return createPackageLocalRuntimeKernelStorePort({
        kernelPortFactory: options.kernelPortFactory,
        sessionId: options.sessionId,
        sessionStore: options.sessionStore,
      });
    },
    createTracePort(recorder, maxContextTokens) {
      return createPackageLocalRuntimeKernelTracePort({
        kernelPortFactory: options.kernelPortFactory,
        recorder,
        maxContextTokens,
      });
    },
    createHookPort() {
      return createPackageLocalRuntimeKernelHookPort({
        kernelPortFactory: options.kernelPortFactory,
        hookRuntime: options.hookRuntime,
      });
    },
  };
}

export function createPackageLocalRuntimeKernelToolPort(
  options: CreatePackageLocalRuntimeKernelToolPortOptions,
): AgentToolPort {
  return options.kernelPortFactory.createToolPort({
    toolCatalog: options.toolCatalog,
    executionPipeline: options.executionPipeline,
    createExecutionContext: options.createExecutionContext,
  });
}

export function createPackageLocalRuntimeKernelStorePort(
  options: CreatePackageLocalRuntimeKernelStorePortOptions,
): AgentStorePort {
  return options.kernelPortFactory.createStorePort({
    sessionId: options.sessionId,
    sessionStore: options.sessionStore,
  });
}

export function createPackageLocalRuntimeKernelTracePort(
  options: CreatePackageLocalRuntimeKernelTracePortOptions,
): AgentTracePort {
  return options.kernelPortFactory.createTracePort({
    recorder: options.recorder,
    maxContextTokens: options.maxContextTokens,
  });
}

export function createPackageLocalRuntimeKernelHookPort(
  options: CreatePackageLocalRuntimeKernelHookPortOptions,
): AgentHookPort {
  return options.kernelPortFactory.createHookPort({
    hookRuntime: options.hookRuntime,
  });
}
